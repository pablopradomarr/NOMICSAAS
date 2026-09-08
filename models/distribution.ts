/**
 * E9 · T14 — Distribución del resultado y estado societario del ejercicio
 * (`docs/design/E9-cierre-recurrentes.md` §4.9, **O-18** y **R2-2**;
 * ADR-0016 **D10** y **D1**).
 *
 * Dos actos que van juntos y por eso viven en el mismo módulo:
 *
 *  · **`setAccountsApprovalStatus`** — `BORRADOR → FORMULADAS → APROBADAS →
 *    DEPOSITADAS`. Es lo que separa una reapertura legítima (antes de formular,
 *    art. 253 LSC) de una **reformulación** de cuentas aprobadas o depositadas
 *    (arts. 272 y 279 LSC), que no es una operación de usuario. Al marcar
 *    **APROBADAS** se abre el diálogo de distribución.
 *  · **`createProfitDistribution`** — **T-35**, con la fecha de la junta
 *    (art. 164 LSC) y en el ejercicio **ABIERTO**, no en el cerrado.
 *
 * **R2-2 · el capital sale del DIARIO.** `capitalStockFor` deriva el saldo
 * acreedor de `100` a la fecha de la junta y sólo cae en
 * `Organization.capitalStockOverrideCents` si no hay saldo derivable; entonces el
 * paso sale **WARN** con `CAPITAL_SOCIAL_DECLARADO`. Aquí no se teclea ninguna
 * cifra de balance (ADR-0003).
 */

import {
  CAPITAL_ACCOUNT_PREFIX,
  capitalStockCheck,
  capitalStockOf,
  type CapitalStock,
  type ProfitDistributionPlan,
} from "@/lib/closing/distribution"
import type { TenantClient, TenantTransactionClient } from "@/lib/db"
import type { CheckResult } from "@/lib/ledger/invariants-types"
import { fromUtcDate, toUtcDate } from "@/lib/ledger/dates"
import type { Cents, LocalDate } from "@/lib/ledger/types"
import { centsFromDb, centsFromDbNullable, centsToDb } from "@/lib/money"
import type { Actor } from "@/models/accounts"
import { writeAuditLog } from "@/models/audit-log"
import { readAccountBalances } from "@/models/closing"
import { e9Abort } from "@/models/e9-errors"
import type { AccountsApprovalStatus, TaxFilingStatus } from "@/prisma/client"

type AnyClient = TenantClient | TenantTransactionClient

// ─────────────────────────────────────────────────────────────────────────────
// R2-2 · el capital social, derivado del diario
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Capital social **a la fecha de la junta**: saldo acreedor de `100` (todas sus
 * subcuentas), agregado en SQL. El `capitalStockOverrideCents` de la
 * organización sólo entra como contingencia y **nunca pisa al diario**.
 */
export async function capitalStockFor(
  tx: TenantTransactionClient,
  opts: { meetingDate: LocalDate }
): Promise<{ capital: CapitalStock; override: Cents | null; check: CheckResult }> {
  const balances = await readAccountBalances(tx, {
    cutoff: opts.meetingDate,
    prefixes: [CAPITAL_ACCOUNT_PREFIX],
    sign: "ACREEDOR",
    // Los saldos de patrimonio viven en la apertura del ejercicio, que es un
    // asiento `OPENING`; excluir `CLOSING` basta para no contar dos veces.
  })
  const org = await tx.organization.findFirst({ select: { capitalStockOverrideCents: true } })
  const override = centsFromDbNullable(org?.capitalStockOverrideCents ?? null, "capital social declarado")
  const capital = capitalStockOf(balances, override)
  return { capital, override, check: capitalStockCheck(capital, override) }
}

/** Saldo acreedor actual de la reserva legal (`112`), para el tope del art. 274. */
export async function legalReserveBalance(tx: TenantTransactionClient, opts: { cutoff: LocalDate; accountPrefix?: string }): Promise<Cents> {
  const balances = await readAccountBalances(tx, {
    cutoff: opts.cutoff,
    prefixes: [opts.accountPrefix ?? "112"],
    sign: "ACREEDOR",
  })
  return [...balances.values()].reduce((a, b) => a + b, 0)
}

// ─────────────────────────────────────────────────────────────────────────────
// ProfitDistribution
// ─────────────────────────────────────────────────────────────────────────────

export type ProfitDistributionRow = ProfitDistributionPlan & {
  id: string
  fiscalYearId: string
  meetingDate: LocalDate
  entryId: string
  approvedAt: Date
}

const toRow = (r: {
  id: string
  fiscalYearId: string
  meetingDate: Date
  resultCents: bigint
  legalReserveCents: bigint
  voluntaryReserveCents: bigint
  carryForwardCents: bigint
  dividendCents: bigint
  interimDividendCents: bigint
  lossCarryForwardCents: bigint
  entryId: string
  approvedAt: Date
}): ProfitDistributionRow => ({
  id: r.id,
  fiscalYearId: r.fiscalYearId,
  meetingDate: fromUtcDate(r.meetingDate),
  resultCents: centsFromDb(r.resultCents, "resultado distribuido"),
  legalReserveCents: centsFromDb(r.legalReserveCents, "reserva legal"),
  voluntaryReserveCents: centsFromDb(r.voluntaryReserveCents, "reservas voluntarias"),
  carryForwardCents: centsFromDb(r.carryForwardCents, "remanente"),
  dividendCents: centsFromDb(r.dividendCents, "dividendo"),
  interimDividendCents: centsFromDb(r.interimDividendCents, "dividendo a cuenta"),
  lossCarryForwardCents: centsFromDb(r.lossCarryForwardCents, "resultados negativos"),
  entryId: r.entryId,
  approvedAt: r.approvedAt,
})

export async function getProfitDistribution(db: AnyClient, fiscalYearId: string): Promise<ProfitDistributionRow | null> {
  const row = await db.profitDistribution.findFirst({ where: { fiscalYearId } })
  return row ? toRow(row) : null
}

/**
 * **T-35.** Persiste la distribución acordada por la junta. El plan viene
 * **calculado** por `distributionPlan` (motor puro) y el asiento, ya posteado
 * por la acción en el ejercicio ABIERTO: aquí se sella el acto.
 *
 * **G-16**: una `profit_distributions` por ejercicio (`@@unique`) y
 * `Σ destinos = result_cents` (CHECK + I-E9-23). Las dos las repite la base;
 * ésta lo dice antes y con el número.
 */
export async function createProfitDistributionTx(
  tx: TenantTransactionClient,
  input: {
    fiscalYearId: string
    meetingDate: LocalDate
    plan: ProfitDistributionPlan
    entryId: string
    capital: CapitalStock
  },
  actor: Actor
): Promise<ProfitDistributionRow> {
  const existing = await tx.profitDistribution.findFirst({ where: { fiscalYearId: input.fiscalYearId } })
  if (existing) {
    e9Abort(
      "DISTRIBUTION_ALREADY_EXISTS",
      "fiscalYearId",
      "El ejercicio ya tiene una distribución acordada: rectificarla es un contra-asiento y un nuevo acuerdo de la junta"
    )
  }
  const plan = input.plan
  const destinos =
    plan.resultCents < 0
      ? plan.lossCarryForwardCents
      : plan.legalReserveCents + plan.voluntaryReserveCents + plan.carryForwardCents + plan.dividendCents + plan.interimDividendCents
  if (destinos !== Math.abs(plan.resultCents)) {
    e9Abort(
      "DISTRIBUTION_ALREADY_EXISTS",
      "plan",
      `Σ destinos ${destinos} c ≠ resultado ${Math.abs(plan.resultCents)} c (G-16, I-E9-23): la distribución no se persiste`
    )
  }

  const row = await tx.profitDistribution.create({
    data: {
      organizationId: tx.$organizationId,
      fiscalYearId: input.fiscalYearId,
      meetingDate: toUtcDate(input.meetingDate),
      resultCents: centsToDb(plan.resultCents, "resultado distribuido"),
      legalReserveCents: centsToDb(plan.legalReserveCents, "reserva legal"),
      voluntaryReserveCents: centsToDb(plan.voluntaryReserveCents, "reservas voluntarias"),
      carryForwardCents: centsToDb(plan.carryForwardCents, "remanente"),
      dividendCents: centsToDb(plan.dividendCents, "dividendo"),
      interimDividendCents: centsToDb(plan.interimDividendCents, "dividendo a cuenta"),
      lossCarryForwardCents: centsToDb(plan.lossCarryForwardCents, "resultados negativos"),
      entryId: input.entryId,
      approvedById: actor.userId ?? null,
    },
  })

  await writeAuditLog(tx, {
    entity: "ProfitDistribution",
    entityId: row.id,
    action: "DISTRIBUTE_PROFIT",
    after: {
      fiscalYearId: input.fiscalYearId,
      meetingDate: input.meetingDate,
      ...plan,
      entryId: input.entryId,
      // **R2-2**: queda escrito de dónde salió el capital con el que se calculó
      // la reserva legal. Es la diferencia entre una cifra del libro y una
      // tecleada, y es lo que la evidencia del paso enseña.
      capitalStockCents: input.capital.cents,
      capitalStockSource: input.capital.source,
      capitalStockAccountCode: input.capital.accountCode,
    },
    userId: actor.userId ?? null,
  })
  return toRow(row)
}

// ─────────────────────────────────────────────────────────────────────────────
// D1 · estado societario y estado fiscal del ejercicio
// ─────────────────────────────────────────────────────────────────────────────

/** El orden del art. 253 → 272 → 279 LSC. No se retrocede sin acuerdo expreso. */
const APPROVAL_ORDER: readonly AccountsApprovalStatus[] = ["BORRADOR", "FORMULADAS", "APROBADAS", "DEPOSITADAS"]

export type ApprovalResult = {
  fiscalYearId: string
  status: AccountsApprovalStatus
  /** **O-18**: al marcar APROBADAS, la UI abre el diálogo de distribución. */
  requiresDistribution: boolean
}

/**
 * **D1.** Marca el estado societario con su fecha. Avanzar es un acto; retroceder
 * (`APROBADAS → BORRADOR`) exige el acuerdo de reformulación de los arts. 272 y
 * 279 LSC y por eso se **rechaza aquí** con el mensaje que ofrece la salida, en
 * vez de decir «imposible».
 *
 * Al llegar a `APROBADAS`, `requiresDistribution` es cierto si el ejercicio
 * todavía no tiene `ProfitDistribution`: es lo que dispara T-35 (O-18).
 */
export async function setAccountsApprovalStatusTx(
  tx: TenantTransactionClient,
  input: { fiscalYearId: string; status: AccountsApprovalStatus; date: LocalDate; reason?: string | null },
  actor: Actor
): Promise<ApprovalResult> {
  const fy = await tx.fiscalYear.findFirst({
    where: { id: input.fiscalYearId },
    select: { id: true, code: true, accountsApprovalStatus: true },
  })
  if (!fy) e9Abort("FISCAL_YEAR_NOT_FOUND", "fiscalYearId", "El ejercicio no existe en esta organización")

  const from = APPROVAL_ORDER.indexOf(fy.accountsApprovalStatus)
  const to = APPROVAL_ORDER.indexOf(input.status)
  if (to < from) {
    e9Abort(
      "APPROVAL_STATUS_REGRESSION",
      "status",
      `Las cuentas de ${fy.code} están ${fy.accountsApprovalStatus}: volver a ${input.status} exige un acuerdo de ` +
        "REFORMULACIÓN de la junta (arts. 272 y 279 LSC), que se registra como tal y no es una operación de usuario"
    )
  }
  if (to === from) {
    return { fiscalYearId: fy.id, status: input.status, requiresDistribution: false }
  }

  const at = toUtcDate(input.date)
  await tx.fiscalYear.update({
    where: { id: input.fiscalYearId },
    data: {
      accountsApprovalStatus: input.status,
      ...(input.status === "FORMULADAS" ? { formulatedAt: at } : {}),
      ...(input.status === "APROBADAS" ? { approvedAt: at } : {}),
      ...(input.status === "DEPOSITADAS" ? { depositedAt: at } : {}),
    },
  })

  const distribution = await tx.profitDistribution.findFirst({ where: { fiscalYearId: input.fiscalYearId }, select: { id: true } })

  await writeAuditLog(tx, {
    entity: "FiscalYear",
    entityId: input.fiscalYearId,
    action: "SET_APPROVAL_STATUS",
    before: { accountsApprovalStatus: fy.accountsApprovalStatus },
    after: { accountsApprovalStatus: input.status, date: input.date },
    reason: input.reason ?? null,
    userId: actor.userId ?? null,
  })

  return {
    fiscalYearId: fy.id,
    status: input.status,
    requiresDistribution: input.status === "APROBADAS" && distribution === null,
  }
}

/**
 * **Q-1.2.** Estado fiscal del ejercicio. Si el modelo 200 ya se presentó,
 * reabrir obliga a autoliquidación complementaria o rectificativa (art. 122
 * LGT): el asistente lo advierte y esto es lo que lo hace comprobable.
 */
export async function setTaxFilingStatusTx(
  tx: TenantTransactionClient,
  input: { fiscalYearId: string; status: TaxFilingStatus; reason?: string | null },
  actor: Actor
): Promise<void> {
  const fy = await tx.fiscalYear.findFirst({ where: { id: input.fiscalYearId }, select: { id: true, taxFilingStatus: true } })
  if (!fy) e9Abort("FISCAL_YEAR_NOT_FOUND", "fiscalYearId", "El ejercicio no existe en esta organización")
  await tx.fiscalYear.update({ where: { id: input.fiscalYearId }, data: { taxFilingStatus: input.status } })
  await writeAuditLog(tx, {
    entity: "FiscalYear",
    entityId: input.fiscalYearId,
    action: "SET_TAX_FILING_STATUS",
    before: { taxFilingStatus: fy.taxFilingStatus },
    after: { taxFilingStatus: input.status },
    reason: input.reason ?? null,
    userId: actor.userId ?? null,
  })
}
