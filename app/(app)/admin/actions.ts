"use server"

/**
 * E12 · T13 — **las server actions de `/admin`** (ADR-0020 D1–D6).
 *
 * Cada operación tiene **dos** acciones, y ésa es la doble confirmación de D4
 * puesta donde se puede comprobar:
 *
 *  1. `planXAction` — enumera lo que va a pasar y **firma** la enumeración con
 *     un token de cinco minutos. No escribe nada.
 *  2. `runXAction` — recibe el token, el **nombre tecleado** y el **motivo**,
 *     vuelve a enumerar, exige que el resumen no haya cambiado y ejecuta.
 *
 * Las tres comprobaciones de la segunda —token, nombre y motivo— se hacen
 * **en el servidor**. Una confirmación que sólo vive en el diálogo no es una
 * confirmación: es una animación.
 *
 * Y todas empiezan por `requirePlatformAdmin()`, que responde **404** a quien no
 * lo sea: un `403` confirmaría que el panel existe.
 */

import { ActionState } from "@/lib/actions"
import { OperatorExceptionError } from "@/models/operator-exceptions"
import { requirePlatformAdmin } from "./admin"
import { issueConfirmation, planHashOf, verifyConfirmation } from "./confirmation"
import {
  OperatorDenied,
  planPurgeRetention,
  planResetOrg,
  planReassignPlan,
  planUnblock,
  runPurgeRetention,
  runResetOrg,
  runReassignPlan,
  runUnblock,
  type OperationPlan,
  type OperatorContext,
  type UnblockTarget,
} from "./operations"
import { OperatorExceptionKind, OperatorTargetKind } from "@/prisma/client"
import { revalidatePath } from "next/cache"
import { z } from "zod"

const uuid = z.string().uuid("Identificador de organización inválido.")

/** Lo que el diálogo recibe: la enumeración más el token que la sella. */
export type PreparedOperation = { plan: OperationPlan; token: string }

/**
 * Sólo lo que la enumeración PROMETE entra en el hash: los pasos son prosa para
 * el humano; lo que tiene que seguir siendo verdad al ejecutar son los
 * recuentos, el antes, el después y si estaba bloqueada.
 */
const sealable = (plan: OperationPlan) => ({
  action: plan.action,
  organizationId: plan.organizationId,
  organizationName: plan.organizationName,
  affectedCounts: plan.affectedCounts,
  before: plan.before,
  after: plan.after,
  blocked: plan.blocked,
})

async function prepare(plan: OperationPlan, actor: string, now: Date): Promise<PreparedOperation> {
  return {
    plan,
    token: issueConfirmation(
      { action: plan.action, organizationId: plan.organizationId, actor, planHash: planHashOf(sealable(plan)) },
      now
    ),
  }
}

/** Traduce las negativas de dominio a un `ActionState` con el texto en español. */
function fail(e: unknown): ActionState<never> {
  if (e instanceof OperatorDenied || e instanceof OperatorExceptionError) {
    return { success: false, error: e.message }
  }
  throw e
}

/**
 * Comprobación común de la segunda mitad. Devuelve el contexto listo, o el
 * error. **Vuelve a enumerar** dentro: es lo que hace que el token signifique
 * algo.
 */
async function authorize(
  input: { organizationId: string; token: string; reason: string; confirmedName: string },
  replan: () => Promise<OperationPlan>
): Promise<{ ok: true; ctx: OperatorContext; plan: OperationPlan } | { ok: false; error: string }> {
  const { user, actor } = await requirePlatformAdmin()
  const now = new Date()
  const plan = await replan()

  const verdict = verifyConfirmation(
    input.token,
    {
      action: plan.action,
      organizationId: input.organizationId,
      actor,
      planHash: planHashOf(sealable(plan)),
    },
    now
  )
  if (!verdict.ok) return { ok: false, error: verdict.error }

  return {
    ok: true,
    plan,
    ctx: { actor, userId: user.id, reason: input.reason, confirmedName: input.confirmedName, now },
  }
}

const confirmSchema = z.object({
  organizationId: uuid,
  token: z.string().min(1, "Falta la confirmación. Vuelve a abrir la operación."),
  reason: z.string().min(1, "El motivo es obligatorio."),
  confirmedName: z.string().min(1, "Hay que teclear el nombre exacto de la organización."),
})

// ─────────────────────────────────────────────────────────────────────────────
// 1 · reset-org
// ─────────────────────────────────────────────────────────────────────────────

export async function planResetOrgAction(organizationId: string): Promise<ActionState<PreparedOperation>> {
  const { actor } = await requirePlatformAdmin()
  const parsed = uuid.safeParse(organizationId)
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]!.message }
  try {
    const plan = await planResetOrg(parsed.data)
    return { success: true, data: await prepare(plan, actor, new Date()) }
  } catch (e) {
    return fail(e)
  }
}

export async function resetOrgAction(formData: FormData): Promise<ActionState<OperationPlan>> {
  const parsed = confirmSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]!.message }
  try {
    const auth = await authorize(parsed.data, () => planResetOrg(parsed.data.organizationId))
    if (!auth.ok) return { success: false, error: auth.error }
    const result = await runResetOrg(parsed.data.organizationId, auth.ctx)
    revalidatePath("/admin")
    revalidatePath(`/admin/${parsed.data.organizationId}`)
    return { success: true, data: result }
  } catch (e) {
    return fail(e)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2 · unblock
// ─────────────────────────────────────────────────────────────────────────────

const targetSchema = z.object({
  kind: z.nativeEnum(OperatorExceptionKind),
  targetKind: z.nativeEnum(OperatorTargetKind),
  targetId: z.string().uuid().nullish(),
  targetRef: z.string().max(120).nullish(),
})

function parseTarget(raw: unknown): UnblockTarget | null {
  const parsed = targetSchema.safeParse(raw)
  if (!parsed.success) return null
  return {
    kind: parsed.data.kind,
    targetKind: parsed.data.targetKind,
    targetId: parsed.data.targetId ?? null,
    targetRef: parsed.data.targetRef ?? null,
  }
}

export async function planUnblockAction(
  organizationId: string,
  target: unknown
): Promise<ActionState<PreparedOperation>> {
  const { actor } = await requirePlatformAdmin()
  const org = uuid.safeParse(organizationId)
  if (!org.success) return { success: false, error: org.error.issues[0]!.message }
  const t = parseTarget(target)
  if (!t) return { success: false, error: "La guardia que se quiere levantar no está entre las cuatro de ADR-0020." }
  try {
    const now = new Date()
    return { success: true, data: await prepare(await planUnblock(org.data, t, now), actor, now) }
  } catch (e) {
    return fail(e)
  }
}

export async function unblockAction(formData: FormData): Promise<ActionState<OperationPlan>> {
  const parsed = confirmSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]!.message }
  const t = parseTarget({
    kind: formData.get("kind"),
    targetKind: formData.get("targetKind"),
    targetId: formData.get("targetId") || null,
    targetRef: formData.get("targetRef") || null,
  })
  if (!t) return { success: false, error: "La guardia que se quiere levantar no está entre las cuatro de ADR-0020." }
  try {
    const auth = await authorize(parsed.data, () => planUnblock(parsed.data.organizationId, t, new Date()))
    if (!auth.ok) return { success: false, error: auth.error }
    const result = await runUnblock(parsed.data.organizationId, t, auth.ctx)
    revalidatePath("/admin")
    revalidatePath(`/admin/${parsed.data.organizationId}`)
    return { success: true, data: result }
  } catch (e) {
    return fail(e)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3 · reassign-plan
// ─────────────────────────────────────────────────────────────────────────────

export async function planReassignPlanAction(
  organizationId: string,
  planCode: string
): Promise<ActionState<PreparedOperation>> {
  const { actor } = await requirePlatformAdmin()
  const org = uuid.safeParse(organizationId)
  if (!org.success) return { success: false, error: org.error.issues[0]!.message }
  const code = z.string().min(1).max(32).safeParse(planCode)
  if (!code.success) return { success: false, error: "Elige el plan que quieres asignar." }
  try {
    const now = new Date()
    return { success: true, data: await prepare(await planReassignPlan(org.data, code.data, now), actor, now) }
  } catch (e) {
    return fail(e)
  }
}

export async function reassignPlanAction(formData: FormData): Promise<ActionState<OperationPlan>> {
  const parsed = confirmSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]!.message }
  const planCode = String(formData.get("planCode") ?? "").trim()
  if (!planCode) return { success: false, error: "Elige el plan que quieres asignar." }
  try {
    const auth = await authorize(parsed.data, () =>
      planReassignPlan(parsed.data.organizationId, planCode, new Date())
    )
    if (!auth.ok) return { success: false, error: auth.error }
    const result = await runReassignPlan(parsed.data.organizationId, planCode, auth.ctx)
    revalidatePath("/admin")
    revalidatePath(`/admin/${parsed.data.organizationId}`)
    return { success: true, data: result }
  } catch (e) {
    return fail(e)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4 · purge-retention
// ─────────────────────────────────────────────────────────────────────────────

export async function planPurgeRetentionAction(organizationId: string): Promise<ActionState<PreparedOperation>> {
  const { actor } = await requirePlatformAdmin()
  const org = uuid.safeParse(organizationId)
  if (!org.success) return { success: false, error: org.error.issues[0]!.message }
  try {
    const now = new Date()
    return { success: true, data: await prepare(await planPurgeRetention(org.data, now), actor, now) }
  } catch (e) {
    return fail(e)
  }
}

export async function purgeRetentionAction(formData: FormData): Promise<ActionState<OperationPlan>> {
  const parsed = confirmSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]!.message }
  try {
    const auth = await authorize(parsed.data, () => planPurgeRetention(parsed.data.organizationId, new Date()))
    if (!auth.ok) return { success: false, error: auth.error }
    const result = await runPurgeRetention(parsed.data.organizationId, auth.ctx)
    revalidatePath("/admin")
    revalidatePath(`/admin/${parsed.data.organizationId}`)
    return { success: true, data: result }
  } catch (e) {
    return fail(e)
  }
}
