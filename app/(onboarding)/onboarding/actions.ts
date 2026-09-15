"use server"

/**
 * E11 · ola C · **T14** — las server actions del asistente de alta (§6.2).
 *
 * Seis pasos, cada uno una acción, el progreso en `OnboardingRun.step` y
 * «volver atrás» sin perder lo escrito. `VIEWER` no ve `/onboarding`: sólo existe
 * para quien acaba de crear la organización, que por construcción es su `ADMIN`.
 *
 * Ninguna de estas acciones calcula una cifra: crean, renombran y cuentan.
 */

import { ActionState } from "@/lib/actions"
import { getCurrentUser } from "@/lib/auth"
import { requireOrg, setActiveOrg, withOrg } from "@/lib/authz"
import config from "@/lib/config"
import { buildInvitationUrl, createInvitation, normalizeInvitationEmail, revokeInvitation } from "@/models/invitations"
import { getMembership } from "@/models/memberships"
import { getUserByEmail } from "@/models/users"
import { recordAuditLog } from "@/models/audit-log"
import {
  completeOnboarding,
  createDemoOrganization,
  createOrganizationWithSeed,
  deleteDemoOrganization,
  linkDemoOrganization,
  OnboardingError,
  parseMemberInvites,
  renameSeriesPrefix,
  setOnboardingStep,
  updateProvisionalFiscalYear,
  type SeedReport,
} from "@/models/onboarding"
import {
  onboardingCompanySchema,
  onboardingFiscalYearSchema,
  onboardingInviteSchema,
  onboardingRenamePrefixSchema,
  onboardingStepSchema,
} from "@/forms/onboarding"
import { OnboardingStep, Role } from "@/prisma/client"
import { revalidatePath } from "next/cache"

const ONBOARDING_PATH = "/onboarding"

const failure = (error: string): ActionState<never> => ({ success: false, error })

/** Mensaje en español contable, nunca el stack. */
function explain(error: unknown, fallback: string): string {
  if (error instanceof OnboardingError) return error.message
  console.error("[onboarding]", error instanceof Error ? `${error.name}: ${error.message}` : error)
  return fallback
}

// ─────────────────────────────────────────────────────────────────────────────
// Paso 1 · Empresa — lo único irreversible
// ─────────────────────────────────────────────────────────────────────────────

export type CompanyResult = { organizationId: string; report: SeedReport }

/**
 * Crea la organización, la membresía ADMIN y **las nueve piezas** en UNA
 * transacción. Si algo falla al sembrar, no nace nada (criterio 44): no hay
 * organización huérfana que borrar a mano.
 */
export async function onboardingCompanyAction(
  _prev: ActionState<CompanyResult> | null,
  formData: FormData
): Promise<ActionState<CompanyResult>> {
  // Sin `requireOrg`: quien llega aquí puede no tener todavía ninguna.
  const user = await getCurrentUser()

  const validated = onboardingCompanySchema.safeParse(Object.fromEntries(formData))
  if (!validated.success) return failure(validated.error.issues[0]?.message ?? "Datos inválidos")

  try {
    const { organization, report } = await createOrganizationWithSeed(
      {
        name: validated.data.name,
        taxId: validated.data.taxId,
        baseCurrency: validated.data.baseCurrency,
        timezone: validated.data.timezone,
        pgcVariant: validated.data.pgcVariant,
        seriesPrefix: validated.data.seriesPrefix,
      },
      user.id,
      new Date()
    )
    await setActiveOrg(organization.id, user.id)
    revalidatePath("/", "layout")
    return { success: true, data: { organizationId: organization.id, report } }
  } catch (error) {
    return failure(explain(error, "No se ha podido crear la organización. No se ha guardado nada."))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Navegación entre pasos
// ─────────────────────────────────────────────────────────────────────────────

/** Avanzar y «volver atrás» son la misma acción: el paso es un dato, no un salto. */
export async function onboardingGotoStepAction(input: unknown): Promise<ActionState<{ step: OnboardingStep }>> {
  return await withOrg(Role.ADMIN, async ({ db }): Promise<ActionState<{ step: OnboardingStep }>> => {
    const validated = onboardingStepSchema.safeParse(input)
    if (!validated.success) return failure("Paso desconocido")
    try {
      const run = await setOnboardingStep(db, validated.data.step)
      revalidatePath(ONBOARDING_PATH)
      return { success: true, data: { step: run.step } }
    } catch (error) {
      return failure(explain(error, "No se ha podido cambiar de paso"))
    }
  })()
}

// ─────────────────────────────────────────────────────────────────────────────
// Paso 2 · Plan de cuentas — el prefijo de la serie, mientras se pueda
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **Criterio 43.** Con `lastNumber = 0` renombrar es legal y es lo único que el
 * asistente hace con la serie; con un número emitido, se rechaza citando el
 * art. 6.1.a RD 1619/2012. El servidor lo exige aunque el botón esté escondido.
 */
export async function onboardingRenamePrefixAction(input: unknown): Promise<ActionState<{ prefix: string }>> {
  return await withOrg(Role.ADMIN, async ({ db, user }): Promise<ActionState<{ prefix: string }>> => {
    const validated = onboardingRenamePrefixSchema.safeParse(input)
    if (!validated.success) return failure(validated.error.issues[0]?.message ?? "Datos inválidos")
    try {
      const series = await renameSeriesPrefix(db, validated.data, user.id)
      revalidatePath(ONBOARDING_PATH)
      revalidatePath("/settings/invoicing")
      return { success: true, data: { prefix: series.prefix } }
    } catch (error) {
      return failure(explain(error, "No se ha podido cambiar el prefijo de la serie"))
    }
  })()
}

// ─────────────────────────────────────────────────────────────────────────────
// Paso 3 · Ejercicio — se EDITA el provisional (O-7b)
// ─────────────────────────────────────────────────────────────────────────────

export async function onboardingFiscalYearAction(input: unknown): Promise<ActionState<{ code: string }>> {
  return await withOrg(Role.ADMIN, async ({ db, user }): Promise<ActionState<{ code: string }>> => {
    const validated = onboardingFiscalYearSchema.safeParse(input)
    if (!validated.success) return failure(validated.error.issues[0]?.message ?? "Datos inválidos")
    try {
      const year = await updateProvisionalFiscalYear(db, validated.data, user.id)
      await setOnboardingStep(db, OnboardingStep.MEMBERS)
      revalidatePath(ONBOARDING_PATH)
      revalidatePath("/settings/fiscal-years")
      return { success: true, data: { code: year.code } }
    } catch (error) {
      return failure(explain(error, "No se ha podido ajustar el ejercicio"))
    }
  })()
}

// ─────────────────────────────────────────────────────────────────────────────
// Paso 4 · Equipo — saltable
// ─────────────────────────────────────────────────────────────────────────────

export type InvitesResult = {
  invited: { email: string; inviteUrl?: string }[]
  skipped: { email: string; reason: string }[]
}

export async function onboardingInviteAction(
  _prev: ActionState<InvitesResult> | null,
  formData: FormData
): Promise<ActionState<InvitesResult>> {
  return await withOrg(Role.ADMIN, async ({ db, org, user }): Promise<ActionState<InvitesResult>> => {
    const validated = onboardingInviteSchema.safeParse(Object.fromEntries(formData))
    if (!validated.success) return failure(validated.error.issues[0]?.message ?? "Datos inválidos")

    const invites = parseMemberInvites(validated.data.emails, validated.data.role)
    if (invites.length === 0) return failure("Escribe al menos un correo válido, o salta este paso")

    const invited: InvitesResult["invited"] = []
    const skipped: InvitesResult["skipped"] = []
    const now = new Date()

    for (const invite of invites) {
      const email = normalizeInvitationEmail(invite.email)
      const existingUser = await getUserByEmail(email)
      if (existingUser && (await getMembership(org.id, existingUser.id))) {
        skipped.push({ email, reason: "ya es miembro" })
        continue
      }
      const pending = await db.invitation.findFirst({ where: { email, status: "PENDING" } })
      if (pending) await revokeInvitation(db, pending.id, now)

      const { invitation, token } = await createInvitation(db, {
        email,
        role: invite.role,
        invitedById: user.id,
        now,
      })
      invited.push({ email, inviteUrl: buildInvitationUrl(config.app.baseURL, token) })
      await recordAuditLog(org.id, {
        entity: "Invitation",
        entityId: invitation.id,
        action: "invite",
        after: { email, role: invitation.role, from: "onboarding" },
        userId: user.id,
      })
    }

    await setOnboardingStep(db, OnboardingStep.DEMO)
    revalidatePath(ONBOARDING_PATH)
    revalidatePath("/settings/members")
    return { success: true, data: { invited, skipped } }
  })()
}

// ─────────────────────────────────────────────────────────────────────────────
// Paso 5 · Demo — en su PROPIA organización (O-6)
// ─────────────────────────────────────────────────────────────────────────────

export type DemoActionResult = { organizationId: string; name: string; entries: number }

/**
 * La demo se carga **por el motor** (`postEntry`) en una organización `isDemo`
 * aparte. No cuenta contra `maxOrganizations`, no entra en el uso, y vaciarla es
 * borrarla entera: **no existe ningún botón que borre un asiento posteado**.
 */
export async function onboardingLoadDemoAction(): Promise<ActionState<DemoActionResult>> {
  const { org, user, db } = await requireOrg(Role.ADMIN)
  try {
    const demo = await createDemoOrganization(user.id, org.name, new Date())
    await linkDemoOrganization(db, demo.organizationId)
    await setOnboardingStep(db, OnboardingStep.DONE)
    revalidatePath(ONBOARDING_PATH)
    revalidatePath("/", "layout")
    return {
      success: true,
      data: { organizationId: demo.organizationId, name: demo.name, entries: demo.entries },
    }
  } catch (error) {
    return failure(explain(error, "No se han podido cargar los datos de demostración"))
  }
}

export async function onboardingDeleteDemoAction(demoOrganizationId: string): Promise<ActionState<null>> {
  const { db, user } = await requireOrg(Role.ADMIN)
  try {
    await deleteDemoOrganization(db, demoOrganizationId, user.id)
    revalidatePath(ONBOARDING_PATH)
    revalidatePath("/", "layout")
    return { success: true, data: null }
  } catch (error) {
    return failure(explain(error, "No se ha podido borrar la organización de demostración"))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Paso 6 · Listo
// ─────────────────────────────────────────────────────────────────────────────

export async function onboardingFinishAction(): Promise<ActionState<null>> {
  const { db } = await requireOrg(Role.ADMIN)
  try {
    await completeOnboarding(db, new Date())
    revalidatePath(ONBOARDING_PATH)
    revalidatePath("/", "layout")
    return { success: true, data: null }
  } catch (error) {
    return failure(explain(error, "No se ha podido cerrar el asistente"))
  }
}
