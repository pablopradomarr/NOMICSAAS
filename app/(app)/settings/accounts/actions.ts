"use server"

import {
  createAccountFormSchema,
  deleteAccountFormSchema,
  importPlanCsvFormSchema,
  renameAccountFormSchema,
  reseedPlanFormSchema,
  setAccountActiveFormSchema,
  updateAccountClassificationFormSchema,
} from "@/forms/accounts"
import { epigraphCatalog } from "@/lib/accounts/epigraphs"
import type { AccountError, PgcVariant, Result } from "@/lib/accounts/types"
import { validateAccountUpdate } from "@/lib/accounts/validate"
import { ActionState } from "@/lib/actions"
import { withOrg } from "@/lib/authz"
import {
  createAccount,
  deleteAccount,
  getAccountUsage,
  getPlan,
  importCustomPlan,
  importNpgc,
  ImportCustomPlanResult,
  setAccountActive,
  updateAccount,
} from "@/models/accounts"
import { loadNpgcSeed } from "@/models/npgc-seed"
import { Role } from "@/prisma/client"
import { revalidatePath } from "next/cache"
import { z } from "zod"

const ACCOUNTS_PATH = "/settings/accounts"

/** Un `Result` del motor puro → el `ActionState` que pinta el formulario. */
function toActionState<T>(result: Result<T>): ActionState<T> {
  if (result.ok) return { success: true, data: result.value }
  return { success: false, error: formatErrors(result.errors) }
}

function formatErrors(errors: readonly AccountError[]): string {
  return errors
    .map((error) => (error.row !== undefined ? `[fila ${error.row}] ${error.message}` : error.message))
    .join(" · ")
}

function invalid(error: z.ZodError): ActionState<never> {
  return { success: false, error: error.issues[0]?.message ?? "Datos inválidos" }
}

/** Catálogo cerrado de epígrafes de la variante activa (R-15). */
function catalogFor(variant: PgcVariant): ReadonlySet<string> {
  return epigraphCatalog(loadNpgcSeed().rows, variant)
}

/** Alta de subcuenta bajo un padre existente. Sólo ADMIN (T-1). */
export async function createAccountAction(
  _prevState: ActionState<{ code: string }> | null,
  formData: FormData
): Promise<ActionState<{ code: string }>> {
  return await withOrg(Role.ADMIN, async ({ org, user }) => {
    const validated = createAccountFormSchema(catalogFor(org.pgcVariant)).safeParse(Object.fromEntries(formData))
    if (!validated.success) return invalid(validated.error)

    const result = await createAccount(
      org.id,
      {
        code: validated.data.code,
        name: validated.data.name,
        statement: validated.data.statement ?? undefined,
        epigraph: validated.data.epigraph ?? undefined,
        analyticType: validated.data.analyticType ?? undefined,
        cashflowCategory: validated.data.cashflowCategory ?? undefined,
      },
      { userId: user.id },
      null,
      // R-15 en el alta: el epígrafe de la subcuenta nueva tiene que existir en
      // el catálogo cerrado de la variante, igual que al editar.
      { epigraphCatalog: catalogFor(org.pgcVariant) }
    )
    if (!result.ok) return { success: false, error: formatErrors(result.errors) }
    revalidatePath(ACCOUNTS_PATH)
    return { success: true, data: { code: result.account.code } }
  })()
}

/** R-19: renombrar se permite siempre, incluso en cuentas de sistema. */
export async function renameAccountAction(
  _prevState: ActionState<{ code: string }> | null,
  formData: FormData
): Promise<ActionState<{ code: string }>> {
  return await withOrg(Role.ADMIN, async ({ org, user, role, db }) => {
    const validated = renameAccountFormSchema.safeParse(Object.fromEntries(formData))
    if (!validated.success) return invalid(validated.error)

    const plan = await getPlan(db)
    const before = plan.byCode.get(validated.data.code)
    if (!before) return { success: false, error: `La cuenta ${validated.data.code} no existe en esta organización` }
    if (before.name === validated.data.name) return { success: true, data: { code: before.code } }

    const check = validateAccountUpdate(before, { name: validated.data.name }, {
      plan,
      role,
      variant: org.pgcVariant,
      epigraphCatalog: catalogFor(org.pgcVariant),
      usage: await getAccountUsage(db, before.code),
      hasClosedPeriodLines: false,
    })
    if (!check.ok) return { success: false, error: formatErrors(check.errors) }

    await updateAccount(org.id, before.code, check.value.patch, { userId: user.id })
    revalidatePath(ACCOUNTS_PATH)
    return { success: true, data: { code: before.code } }
  })()
}

/**
 * Epígrafe / tipo analítico / categoría de cashflow. `statement` NO se acepta:
 * en cuenta oficial de nivel ≤ 3 está prohibido a todos los roles (R-10a) y en
 * el resto se hereda del padre.
 */
export async function updateAccountClassificationAction(
  _prevState: ActionState<{ code: string; warnings: string[] }> | null,
  formData: FormData
): Promise<ActionState<{ code: string; warnings: string[] }>> {
  return await withOrg(Role.ADMIN, async ({ org, user, role, db }) => {
    const validated = updateAccountClassificationFormSchema.safeParse(Object.fromEntries(formData))
    if (!validated.success) return invalid(validated.error)

    const plan = await getPlan(db)
    const before = plan.byCode.get(validated.data.code)
    if (!before) return { success: false, error: `La cuenta ${validated.data.code} no existe en esta organización` }

    const check = validateAccountUpdate(
      before,
      {
        epigraph: validated.data.epigraph,
        analyticType: validated.data.analyticType,
        cashflowCategory: validated.data.cashflowCategory,
        reason: validated.data.reason,
      },
      {
        plan,
        role,
        variant: org.pgcVariant,
        epigraphCatalog: catalogFor(org.pgcVariant),
        usage: await getAccountUsage(db, before.code),
        hasClosedPeriodLines: false,
      }
    )
    if (!check.ok) return { success: false, error: formatErrors(check.errors) }

    if (Object.keys(check.value.patch).length > 0) {
      await updateAccount(org.id, before.code, check.value.patch, { userId: user.id }, validated.data.reason)
    }
    revalidatePath(ACCOUNTS_PATH)
    return {
      success: true,
      data: { code: before.code, warnings: check.value.warnings.map((warning) => warning.message) },
    }
  })()
}

/** Desactivar (motivo obligatorio) o reactivar. R-06: nunca una cuenta de sistema. */
export async function setAccountActiveAction(
  _prevState: ActionState<{ code: string }> | null,
  formData: FormData
): Promise<ActionState<{ code: string }>> {
  return await withOrg(Role.ADMIN, async ({ org, user }) => {
    const validated = setAccountActiveFormSchema.safeParse(Object.fromEntries(formData))
    if (!validated.success) return invalid(validated.error)

    const result = await setAccountActive(
      org.id,
      validated.data.code,
      validated.data.isActive,
      { userId: user.id },
      validated.data.reason?.trim() || null
    )
    if (!result.ok) return { success: false, error: formatErrors(result.errors) }
    revalidatePath(ACCOUNTS_PATH)
    return { success: true, data: { code: validated.data.code } }
  })()
}

/** R-08: borrado sólo sin apuntes, sin hijos, no de sistema, no mapeada. */
export async function deleteAccountAction(
  _prevState: ActionState<{ code: string }> | null,
  formData: FormData
): Promise<ActionState<{ code: string }>> {
  return await withOrg(Role.ADMIN, async ({ org, user }) => {
    const validated = deleteAccountFormSchema.safeParse(Object.fromEntries(formData))
    if (!validated.success) return invalid(validated.error)

    const result = await deleteAccount(org.id, validated.data.code, { userId: user.id }, validated.data.reason)
    if (!result.ok) return { success: false, error: result.errors.map((e) => e.message).join(" · ") }
    revalidatePath(ACCOUNTS_PATH)
    return { success: true, data: { code: validated.data.code } }
  })()
}

/**
 * Import de un plan propio. El diff se calcula EN EL SERVIDOR: con `dryRun` se
 * devuelve para previsualizar y no se escribe nada (criterio 7).
 */
export async function importPlanCsvAction(
  _prevState: ActionState<ImportCustomPlanResult> | null,
  formData: FormData
): Promise<ActionState<ImportCustomPlanResult>> {
  return await withOrg(Role.ADMIN, async ({ org, user }) => {
    const validated = importPlanCsvFormSchema.safeParse(Object.fromEntries(formData))
    if (!validated.success) return invalid(validated.error)

    const result = await importCustomPlan(
      org.id,
      validated.data.csv,
      {
        code: validated.data.mappingCode,
        name: validated.data.mappingName,
        statement: validated.data.mappingStatement,
        epigraph: validated.data.mappingEpigraph,
        analyticType: validated.data.mappingAnalyticType,
        nature: validated.data.mappingNature,
      },
      {
        variant: org.pgcVariant,
        defaults: { nature: "DEUDORA", statement: null, delimiter: validated.data.delimiter },
        epigraphCatalog: catalogFor(org.pgcVariant),
        actor: { userId: user.id },
        dryRun: validated.data.dryRun,
        fileName: validated.data.fileName,
        reason: validated.data.reason,
      }
    )
    if (result.ok && !validated.data.dryRun) revalidatePath(ACCOUNTS_PATH)
    return toActionState(result)
  })()
}

/** Re-siembra idempotente: sólo crea lo que falta, nunca pisa ediciones (§2.4). */
export async function reseedPlanAction(
  _prevState: ActionState<{ created: number; skipped: number }> | null,
  formData: FormData
): Promise<ActionState<{ created: number; skipped: number }>> {
  return await withOrg(Role.ADMIN, async ({ org, user }) => {
    const validated = reseedPlanFormSchema.safeParse(Object.fromEntries(formData))
    if (!validated.success) return invalid(validated.error)

    const result = await importNpgc(org.id, validated.data.variant, {
      actor: { userId: user.id },
      reason: validated.data.reason,
      now: new Date(),
    })
    revalidatePath(ACCOUNTS_PATH)
    return { success: true, data: { created: result.created, skipped: result.skipped } }
  })()
}
