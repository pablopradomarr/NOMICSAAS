"use server"

import { createOrganizationFormSchema, switchOrganizationSchema } from "@/forms/organizations"
import { ActionState } from "@/lib/actions"
import { getCurrentUser } from "@/lib/auth"
import { setActiveOrg } from "@/lib/authz"
import { tenantTransaction } from "@/lib/db"
import { createOrganizationWithSeed } from "@/models/onboarding"
import { LimitExceededError, assertWithinLimit } from "@/models/platform-limits"
import { getUserMemberships } from "@/models/memberships"
import { Organization } from "@/prisma/client"
import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

/**
 * Cambia la organización activa. La membresía se comprueba SIEMPRE en servidor
 * (`setActiveOrg` lanza si no existe); la cookie es un hint, nunca una credencial.
 */
export async function switchOrganizationAction(organizationId: string): Promise<ActionState<null>> {
  const user = await getCurrentUser()

  const validated = switchOrganizationSchema.safeParse({ organizationId })
  if (!validated.success) {
    return { success: false, error: "Identificador de organización inválido" }
  }

  try {
    await setActiveOrg(validated.data.organizationId, user.id)
  } catch {
    return { success: false, error: "No perteneces a esa organización" }
  }

  revalidatePath("/", "layout")
  redirect("/dashboard")
}

/**
 * Alta de organización: crea la organización, la membresía ADMIN de quien la crea
 * y la semilla de datos por defecto; después la deja activa.
 * No exige rol: cualquier usuario autenticado puede crear la suya.
 */
export async function createOrganizationAction(
  _prevState: ActionState<Organization> | null,
  formData: FormData
): Promise<ActionState<Organization>> {
  const user = await getCurrentUser()

  const validated = createOrganizationFormSchema.safeParse(Object.fromEntries(formData))
  if (!validated.success) {
    return { success: false, error: validated.error.issues[0]?.message ?? "Datos inválidos" }
  }

  const now = new Date()

  // E3-T10 (§4.4.2): organización + membresía ADMIN + siembra (proyectos,
  // categorías, monedas, campos, settings, plan NPGC, mapa de cuentas de sistema
  // y tipos impositivos) en UNA sola transacción con `SEED_TRANSACTION_OPTIONS`.
  //
  // Antes eran dos unidades: si la siembra fallaba, la organización quedaba
  // creada y VACÍA —sin plan de cuentas— y el usuario entraba a un ERP que no
  // podía contabilizar nada. No hace falta borrado compensatorio: si algo
  // revienta dentro, Postgres revierte también el INSERT de la organización.
  // **E11 · T12**: la siembra pasa por la ÚNICA puerta (`seedOrganization`), que
  // añade a la semilla heredada las piezas que I-E11-10 exige y que antes nacían
  // más tarde o no nacían: el ejercicio provisional, las dos series de
  // facturación con el contador a cero y el `OnboardingRun`. Quien abandonaba el
  // alta a medias dejaba el invariante fallando con datos limpios (O-7a/b).
  /**
   * **Revisor BLOQUEA 2 — `maxOrganizations` no se aplicaba en ningún sitio.**
   *
   * La cuota se cuenta **contra el USUARIO** (§3.5) y una organización `isDemo`
   * **no cuenta** (O-6). Dos consecuencias de diseño que se escriben aquí:
   *
   *  · el plan que manda es el de la organización **más antigua** del usuario,
   *    que es la que sostiene su relación con la plataforma; sin ninguna, no hay
   *    plan que consultar y **no puede haber techo**: nadie puede quedarse sin
   *    poder crear su primera organización por una fila de facturación;
   *  · el guardián corre **antes** de la transacción de alta, en la suya: si
   *    rechaza, no queda ni una fila a medias.
   */
  try {
    // Las que cuentan: las suyas, **sin las de demostración** (O-6). El orden
    // por antigüedad decide de qué organización sale el plan.
    const existentes = (await getUserMemberships(user.id))
      .map((membership) => membership.organization)
      .filter((organization) => !organization.isDemo)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    if (existentes.length > 0) {
      await tenantTransaction(existentes[0].id, async (tx) => {
        await assertWithinLimit(tx, "maxOrganizations", BigInt(1), {
          refDate: now,
          organizationsOfUser: BigInt(existentes.length),
        })
      })
    }
  } catch (error) {
    if (error instanceof LimitExceededError) return { success: false, error: error.message }
    throw error
  }

  let organization: Organization
  try {
    ;({ organization } = await createOrganizationWithSeed(
      {
        name: validated.data.name,
        taxId: validated.data.taxId,
        baseCurrency: validated.data.baseCurrency,
        timezone: validated.data.timezone,
        pgcVariant: validated.data.pgcVariant,
      },
      user.id,
      now
    ))
  } catch (error) {
    // Nada de `catch` mudo: sin este log, un fallo de siembra (seed corrupto,
    // presupuesto de transacción agotado, I-plan-1) sólo se ve como «no se ha
    // podido crear la organización» y no hay por dónde empezar a mirar.
    console.error(
      `[organizations] alta fallida para el usuario ${user.id}:`,
      error instanceof Error ? `${error.name}: ${error.message}` : error
    )
    return { success: false, error: "No se ha podido crear la organización" }
  }

  try {
    await setActiveOrg(organization.id, user.id)
  } catch (error) {
    // La organización SÍ existe y está bien sembrada: sólo ha fallado dejarla
    // activa. Se informa sin destruir nada; el switcher la resolverá.
    console.error(`[organizations] ${organization.id} creada pero no se pudo activar:`, error)
    return { success: false, error: "La organización se ha creado, pero no se ha podido activar. Selecciónala en el conmutador." }
  }

  revalidatePath("/", "layout")
  redirect("/dashboard")
}
