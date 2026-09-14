"use server"

/**
 * E10 · T14 — Server actions de **empleados, tarifas y plantilla** (§4.2, §10).
 *
 * Lo que decide esta capa, y no el modelo:
 *
 *  · **La tarifa es `ADMIN`.** El coste-hora mueve el margen de TODOS los
 *    proyectos: es política, no operación. La **propuesta** derivada de la
 *    nómina la puede pedir un `EDITOR` —es información—, pero **aplicarla** es
 *    un acto de un `ADMIN`, con `AuditLog` y con sus términos (O-E10-12).
 *  · **La tarifa individual sólo la ve un `ADMIN`** (§10): el coste-hora de una
 *    persona es su salario partido por sus horas. El resto ve el coste-hora
 *    **medio del receptor**, que es la cifra de gestión.
 *  · **La plantilla** se registra con `EDITOR` y se deriva de empleados; el
 *    snapshot es a fin de mes y en **FTE·mes** (Q-7). «0 declarado» y «sin
 *    rellenar» son cosas distintas, y por eso la derivación no inventa filas.
 */

import {
  applyHourlyCostSchema,
  archiveEmployeeSchema,
  createEmployeeRateSchema,
  createEmployeeSchema,
  deriveHeadcountSchema,
  listEmployeeRatesSchema,
  listEmployeesSchema,
  listHeadcountSchema,
  proposeHourlyCostSchema,
  updateEmployeeSchema,
  upsertHeadcountSchema,
} from "@/forms/employees"
import { formatE10Errors } from "@/forms/e10-errors"
import { ActionState } from "@/lib/actions"
import { withOrg } from "@/lib/authz"
import { tenantDb, tenantTransaction } from "@/lib/db"
import {
  archiveEmployeeTx,
  createEmployeeRateTx,
  createEmployeeTx,
  deriveHeadcountFromEmployeesTx,
  lastDayOfMonthOf,
  listEmployeeRates,
  listEmployees,
  listHeadcount,
  proposeHourlyCost,
  updateEmployeeTx,
  upsertHeadcountSnapshotTx,
  type EmployeeListItem,
  type EmployeeRateListItem,
  type HeadcountRowItem,
  type HourlyCostProposal,
} from "@/models/employees"
import { runLedgerTransaction, todayLocalDate, type LedgerResult } from "@/models/ledger"
import { Role } from "@/prisma/client"
import { revalidatePath } from "next/cache"
import { z } from "zod"

const EMPLOYEES_PATH = "/settings/employees"
const HEADCOUNT_PATH = "/settings/headcount"
const PYG_PATH = "/analytics/pyg"

const invalid = (error: z.ZodError): ActionState<never> => ({
  success: false,
  error: error.issues[0]?.message ?? "Datos inválidos",
})

const toActionState = <T,>(result: LedgerResult<T>): ActionState<T> =>
  result.ok ? { success: true, data: result.value } : { success: false, error: formatE10Errors(result.errors) }

// ─────────────────────────────────────────────────────────────────────────────
// Contratos de salida (C3 arranca de aquí)
// ─────────────────────────────────────────────────────────────────────────────

/** La ficha, con la tarifa **oculta** a quien no es `ADMIN` (§10). */
export type EmployeeRow = Omit<EmployeeListItem, "currentRateCents"> & {
  currentRateCents: number | null
  /** `true` = hay tarifa pero este rol no la ve. No es lo mismo que no haberla. */
  rateHidden: boolean
}

export type ApplyHourlyCostPayload = {
  applied: number
  hourlyCostCents: number
  basis: string
  skipped: readonly { employeeId: string; reason: string }[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Empleados (VIEWER lee · ADMIN edita las tarifas)
// ─────────────────────────────────────────────────────────────────────────────

export const listEmployeesAction = withOrg(
  Role.VIEWER,
  async ({ org, role }, input: unknown = {}): Promise<ActionState<EmployeeRow[]>> => {
    const parsed = listEmployeesSchema.safeParse(input ?? {})
    if (!parsed.success) return invalid(parsed.error)
    const rows = await listEmployees(tenantDb(org.id), { ...parsed.data, rateAt: parsed.data.rateAt ?? todayLocalDate() })
    const admin = role === Role.ADMIN
    return {
      success: true,
      data: rows.map((r) => ({
        ...r,
        currentRateCents: admin ? r.currentRateCents : null,
        rateHidden: !admin && r.currentRateCents !== null,
      })),
    }
  }
)

/** Las vigencias de una tarifa. **Sólo `ADMIN`**: es el salario de una persona. */
export const listEmployeeRatesAction = withOrg(
  Role.ADMIN,
  async ({ org }, input: unknown = {}): Promise<ActionState<EmployeeRateListItem[]>> => {
    const parsed = listEmployeeRatesSchema.safeParse(input ?? {})
    if (!parsed.success) return invalid(parsed.error)
    const rows = await listEmployeeRates(tenantDb(org.id), parsed.data)
    return { success: true, data: rows }
  }
)

export const createEmployeeAction = withOrg(
  Role.EDITOR,
  async ({ org, user }, input: unknown): Promise<ActionState<{ id: string; code: string }>> => {
    const parsed = createEmployeeSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const v = parsed.data
    const result = await runLedgerTransaction(org.id, user.id, async (tx) =>
      createEmployeeTx(
        tx,
        {
          code: v.code,
          name: v.name,
          counterpartyId: v.counterpartyId ?? null,
          userId: v.userId ?? null,
          defaultCostCenterId: v.defaultCostCenterId ?? null,
          fteMilli: v.fteMilli,
          hireDate: v.hireDate ?? null,
          endDate: v.endDate ?? null,
        },
        { userId: user.id }
      )
    )
    if (result.ok) revalidatePath(EMPLOYEES_PATH)
    return toActionState(result)
  }
)

export const updateEmployeeAction = withOrg(
  Role.EDITOR,
  async ({ org, user }, input: unknown): Promise<ActionState<null>> => {
    const parsed = updateEmployeeSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const result = await runLedgerTransaction(org.id, user.id, async (tx) => {
      await updateEmployeeTx(tx, parsed.data, { userId: user.id })
      return null
    })
    if (result.ok) revalidatePath(EMPLOYEES_PATH)
    return toActionState(result)
  }
)

/** Archivar, nunca borrar: los partes de un ejercicio rendido llevan su nombre. */
export const archiveEmployeeAction = withOrg(
  Role.ADMIN,
  async ({ org, user }, input: unknown): Promise<ActionState<null>> => {
    const parsed = archiveEmployeeSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const archivedAt = new Date()
    const result = await runLedgerTransaction(org.id, user.id, async (tx) => {
      await archiveEmployeeTx(tx, { employeeId: parsed.data.employeeId, archivedAt }, { userId: user.id })
      return null
    })
    if (result.ok) revalidatePath(EMPLOYEES_PATH)
    return toActionState(result)
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Tarifas y derivación de la nómina 64x
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **Propuesta**, jamás aplicación (O-E10-12): devuelve el coste-hora y **sus
 * términos** —ámbito, periodo, prefijos de cuenta, importe de nómina, minutos
 * productivos, **cobertura** y fórmula—. Por debajo del mínimo de cobertura sale
 * `no evaluable` en vez de extrapolar. La pide un `EDITOR` porque es
 * información de gestión; aplicarla es otra cosa.
 */
export const proposeHourlyCostAction = withOrg(
  Role.EDITOR,
  async ({ org, user }, input: unknown): Promise<ActionState<HourlyCostProposal>> => {
    const parsed = proposeHourlyCostSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const result = await runLedgerTransaction(org.id, user.id, async (tx) => proposeHourlyCost(tx, parsed.data), {
      readOnly: true,
    })
    return toActionState(result)
  }
)

/**
 * **Aplicar** la propuesta: es un acto de un `ADMIN` y deja `AuditLog` con la
 * derivación entera detrás de la tarifa (`EmployeeRate.source =
 * DERIVADO_NOMINA` + `derivation`). Rechaza
 * `COSTE_TOTAL_CON_ESTRUCTURA` con reglas de actividad vigentes
 * (`RATE_BASIS_CONFLICT`, O-E10-14), porque cargaría la estructura dos veces.
 */
export const applyHourlyCostAction = withOrg(
  Role.ADMIN,
  async ({ org, user }, input: unknown): Promise<ActionState<ApplyHourlyCostPayload>> => {
    const parsed = applyHourlyCostSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const v = parsed.data
    const result = await runLedgerTransaction(org.id, user.id, async (tx) => {
      const proposal = await proposeHourlyCost(tx, {
        scope: v.scope,
        costCenterId: v.costCenterId,
        employeeId: v.employeeId,
        periodStart: v.periodStart,
        periodEnd: v.periodEnd,
        basis: v.basis,
        minCoverageBps: v.minCoverageBps,
      })
      if (!proposal.ok) {
        return { applied: 0, hourlyCostCents: 0, basis: v.basis ?? "", skipped: [{ employeeId: "*", reason: proposal.message }] }
      }
      const skipped: { employeeId: string; reason: string }[] = []
      let applied = 0
      // En SERIE: dentro de una transacción hay UNA conexión (regla de E6-perf).
      for (const employeeId of v.employeeIds) {
        await createEmployeeRateTx(
          tx,
          {
            employeeId,
            hourlyCostCents: proposal.hourlyCostCents,
            basis: proposal.derivation.basis,
            validFrom: v.validFrom,
            validTo: v.validTo ?? null,
            source: "DERIVADO_NOMINA",
            derivation: proposal.derivation,
          },
          { userId: user.id }
        )
        applied += 1
      }
      return { applied, hourlyCostCents: proposal.hourlyCostCents, basis: proposal.derivation.basis, skipped }
    })
    if (result.ok) {
      revalidatePath(EMPLOYEES_PATH)
      revalidatePath(PYG_PATH)
    }
    return toActionState(result)
  }
)

/** Tarifa declarada a mano, con su `basis` explícita (Q-1). */
export const createEmployeeRateAction = withOrg(
  Role.ADMIN,
  async ({ org, user }, input: unknown): Promise<ActionState<{ id: string; closedPreviousId: string | null }>> => {
    const parsed = createEmployeeRateSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const v = parsed.data
    const result = await runLedgerTransaction(org.id, user.id, async (tx) => {
      // Con la propuesta detrás, sus términos viajan a `derivation`: una tarifa
      // derivada sin sus términos no se puede rehacer a mano, y entonces no es
      // auditable.
      const proposal = v.fromProposal
        ? await proposeHourlyCost(tx, {
            scope: v.fromProposal.scope,
            costCenterId: v.fromProposal.costCenterId ?? undefined,
            employeeId: v.fromProposal.employeeId ?? undefined,
            periodStart: v.fromProposal.periodStart,
            periodEnd: v.fromProposal.periodEnd,
            basis: v.basis,
          })
        : null
      return createEmployeeRateTx(
        tx,
        {
          employeeId: v.employeeId,
          hourlyCostCents: v.hourlyCostCents,
          basis: v.basis,
          validFrom: v.validFrom,
          validTo: v.validTo ?? null,
          source: proposal?.ok ? "DERIVADO_NOMINA" : "DECLARADO",
          derivation: proposal?.ok ? proposal.derivation : null,
          note: v.note ?? null,
        },
        { userId: user.id }
      )
    })
    if (result.ok) {
      revalidatePath(EMPLOYEES_PATH)
      revalidatePath(PYG_PATH)
    }
    return toActionState(result)
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Plantilla (FTE·mes, Q-7)
// ─────────────────────────────────────────────────────────────────────────────

export const listHeadcountAction = withOrg(
  Role.VIEWER,
  async ({ org }, input: unknown = {}): Promise<ActionState<HeadcountRowItem[]>> => {
    const parsed = listHeadcountSchema.safeParse(input ?? {})
    if (!parsed.success) return invalid(parsed.error)
    const rows = await listHeadcount(tenantDb(org.id), parsed.data)
    return { success: true, data: rows }
  }
)

/**
 * El snapshot es a **fin de mes**: si llega otra fecha se corrige el mensaje con
 * la que toca, en vez de dejar que el CHECK `headcount_last_day` conteste con un
 * `23514`.
 */
export const upsertHeadcountSnapshotAction = withOrg(
  Role.EDITOR,
  async ({ org, user }, input: unknown): Promise<ActionState<{ id: string; created: boolean }>> => {
    const parsed = upsertHeadcountSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const v = parsed.data
    if (v.periodEnd !== lastDayOfMonthOf(v.periodEnd)) {
      return {
        success: false,
        error: `El snapshot de plantilla es a FIN de mes: ${v.periodEnd} no lo es (usa ${lastDayOfMonthOf(v.periodEnd)})`,
      }
    }
    const result = await runLedgerTransaction(org.id, user.id, async (tx) =>
      upsertHeadcountSnapshotTx(
        tx,
        { costCenterId: v.costCenterId, periodEnd: v.periodEnd, fteMilli: v.fteMilli, headcount: v.headcount, source: "MANUAL", note: v.note ?? null },
        { userId: user.id }
      )
    )
    if (result.ok) {
      revalidatePath(HEADCOUNT_PATH)
      revalidatePath(PYG_PATH)
    }
    return toActionState(result)
  }
)

/**
 * Derivar de empleados: Σ `fteMilli` de los vivos ese día por CECO por defecto.
 * Es una **propuesta escrita** (`DERIVADO_EMPLEADOS`), no un cálculo del driver:
 * el driver lee sólo `headcount_snapshots`, de modo que un reparto ya cerrado no
 * cambia porque alguien edite una ficha de personal años después.
 */
export const deriveHeadcountAction = withOrg(
  Role.EDITOR,
  async ({ org, user }, input: unknown): Promise<ActionState<{ written: number }>> => {
    const parsed = deriveHeadcountSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const result = await runLedgerTransaction(org.id, user.id, async (tx) =>
      deriveHeadcountFromEmployeesTx(tx, parsed.data, { userId: user.id })
    )
    if (result.ok) revalidatePath(HEADCOUNT_PATH)
    return toActionState(result)
  }
)

/** La lectura nominal de un empleado concreto exige `EDITOR` (§10). */
export const getEmployeeDetailAction = withOrg(
  Role.EDITOR,
  async ({ org, user, role }, input: unknown): Promise<ActionState<{ employee: EmployeeListItem; rates: EmployeeRateListItem[] }>> => {
    const parsed = archiveEmployeeSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const detail = await tenantTransaction(org.id, user.id, async (tx) => {
      const employees = await listEmployees(tx, { includeArchived: true })
      const employee = employees.find((e) => e.id === parsed.data.employeeId) ?? null
      // La tarifa individual sólo la ve un ADMIN (§10).
      const rates = role === Role.ADMIN ? await listEmployeeRates(tx, { employeeId: parsed.data.employeeId }) : []
      return { employee, rates }
    })
    if (!detail.employee) return { success: false, error: "El empleado no existe en esta organización" }
    return { success: true, data: { employee: detail.employee, rates: detail.rates } }
  }
)
