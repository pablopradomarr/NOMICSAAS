/**
 * E7 · T6 — Invariantes **I-E7-1…17** (`docs/design/E7-auditoria.md` §3.5).
 *
 * Mismo contrato que el resto de bloques: **nunca un PASS que no se haya
 * comprobado**; lo que no se puede evaluar con los datos aportados sale `INFO`
 * diciendo qué falta. **Tolerancia 0 en todo lo que compara importes**: en
 * conciliación no hay reparto por mayor resto, hay igualdad o no la hay.
 *
 * ## La identidad del cuadre (O-1, O-2)
 *
 * A la fecha de corte `D`, **siempre por fecha de operación** (O-6), y para UNA
 * cuenta bancaria:
 *
 * | | |
 * |---|---|
 * | `B` | saldo contable de la 57x: `Σ (debe − haber)` con `kind ∉ {CLOSING}` —**`OPENING` sí entra**— calculado con `balanceOfAccount`, la MISMA función de la foto `PRE_REGULARIZACION` de E6, no una segunda |
 * | `E` | saldo del extracto a `D`, **declarado por el banco** |
 * | `Ue` | Σ con signo de las líneas de extracto **no conciliadas** hasta `D` |
 * | `Ub` | Σ con signo de los apuntes de la 57x **no conciliados** hasta `D` |
 *
 * > **I-E7-1 · `E − B = Ue − Ub`**, tolerancia 0.
 *
 * La fórmula de la ronda 1 daba FAIL en cualquier empresa con un cheque de
 * diciembre cargado en enero, y contaba los pendientes dos veces.
 *
 * **Los ignorados entran en `Ue`** y además se presentan como línea propia
 * (`ignoradosCents`, O-12): una línea `IGNORED` no está conciliada, y sacarla de
 * `Ue` haría que la identidad fallara por su importe exacto en cuanto alguien
 * marcase una. Los `IMPORTE_CERO` suman 0 por definición y no mueven nada (m2).
 *
 * `REGULARIZATION` no toca 57x; si la tocara sería un error, y **I-E7-1 debe
 * delatarlo, no absorberlo**: por eso `B` sólo excluye `CLOSING`.
 *
 * Módulo PURO: recibe los datos ya leídos; la fecha de corte entra por parámetro.
 */

import {
  IGNORE_REASONS_WITH_EVIDENCE,
  PENDING_KINDS_OUT_OF_RECONCILIATION,
  ageInDays,
  isReconcilableAccount,
  isUnderAccount,
  signedAmountOf,
  signedOriginalAmountOf,
  type BankAccountRef,
  type BankLineRef,
  type BankMatchGroupRef,
  type BankStatementRef,
  type IgnoreReason,
  type LedgerCashLineRef,
  type PendingKind,
} from "@/lib/bank/types"
import { checksHashOf } from "@/lib/audit/run"
import type { Cents, CheckResult, LocalDate } from "@/lib/audit/types"
import { allocationRunSetHash } from "@/lib/analytics/hash"
import { monthOf } from "@/lib/ledger/dates"
import { balanceOfAccount } from "@/lib/ledger/reports/balance"
import type { ReportLine } from "@/lib/ledger/reports/types"
import { convertWithRateMicro } from "@/lib/money"
import type { EntryKind } from "@/lib/ledger/types"

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de resultado
// ─────────────────────────────────────────────────────────────────────────────

const pass = (id: string, evidencia: string, query?: string): CheckResult =>
  query === undefined ? { id, status: "PASS", evidencia } : { id, status: "PASS", evidencia, query }
const failed = (id: string, evidencia: string, query?: string): CheckResult =>
  query === undefined ? { id, status: "FAIL", evidencia } : { id, status: "FAIL", evidencia, query }
const warn = (id: string, evidencia: string, query?: string): CheckResult =>
  query === undefined ? { id, status: "WARN", evidencia } : { id, status: "WARN", evidencia, query }
const info = (id: string, evidencia: string, query?: string): CheckResult =>
  query === undefined ? { id, status: "INFO", evidencia } : { id, status: "INFO", evidencia, query }

const sum = (values: readonly number[]): Cents => values.reduce((a, b) => a + b, 0)

/** Los importes se escriben en euros en la evidencia; el cálculo es en céntimos. */
export const eur = (cents: Cents): string =>
  `${(cents / 100).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`

/** `B` excluye SÓLO el cierre: la apertura entra y la regularización se delata. */
export const B_EXCLUDED_KINDS: readonly EntryKind[] = ["CLOSING"]

// ─────────────────────────────────────────────────────────────────────────────
// Entradas
// ─────────────────────────────────────────────────────────────────────────────

export type BankInvariantInput = {
  organizationId: string
  /** Fecha de corte `D`, **por fecha de operación** (O-6). */
  cutoff: LocalDate
  baseCurrency: string
  accounts: readonly BankAccountRef[]
  statements: readonly BankStatementRef[]
  lines: readonly BankLineRef[]
  groups: readonly BankMatchGroupRef[]
  cashLines: readonly LedgerCashLineRef[]
  /** Cierre en divisa por cuenta, para I-E7-12. */
  fx?: readonly FxCloseRef[]
  /** ¿`cutoff` es fecha de cierre de ejercicio? Decide FAIL/WARN en I-E7-16. */
  isFiscalYearEnd?: boolean
}

export type FxCloseRef = {
  bankAccountId: string
  closingDate: LocalDate
  /** Tasa de cierre en micros: 1 unidad de divisa = `rateMicro / 1e6` de la base. */
  rateMicro: bigint
  /** Σ contravalores históricos en moneda base de los apuntes de la cuenta. */
  baseBalanceCents: Cents
  /**
   * Diferencia de cambio **ya reconocida** en 768/668 a la fecha de cierre.
   * **Es evidencia, no un sumando** (N-1): el asiento que la reconoce mueve la
   * 57x, así que `baseBalanceCents` ya la contiene y restarla otra vez
   * duplicaría la diferencia.
   */
  recognizedDifferenceCents: Cents
}

/** Un `InvariantRun` ya sellado, para que I-E7-7 recompute su `checksHash`. */
export type InvariantRunIntegrityRef = {
  id: string
  createdAt?: string
  checksHash: string
  checks: readonly CheckResult[]
}

export type StoreCoverageInput = {
  files: readonly { id: string; ingestedAt: string }[]
  lastSweep: { id: string; status: string; finishedAt: string | null; sweptFileIds: readonly string[] } | null
}

export type AllocationRunIntegrityRef = {
  id: string
  status: string
  periodStart: LocalDate
  periodEnd: LocalDate
  sealedAt: string | null
  linesHash: string | null
  /** Recomputado por el borde sobre las líneas de hoy (mecanismo de I-E8-11). */
  linesHashExpected?: string | null
}

export type ReportRunAllocationRef = {
  id: string
  reportType: string
  allocationRunSetHash: string
  allocationRunIds: readonly string[]
}

export type ClosingInvariantInput = {
  /** Líneas del diario ya leídas (las mismas que alimentan los informes). */
  lines: readonly ReportLine[]
  fiscalYears: readonly { id: string; startDate: LocalDate; endDate: LocalDate }[]
  from: LocalDate
  to: LocalDate
  /** `true` cuando `to` es el cierre del ejercicio: I-E7-16 pasa de WARN a FAIL. */
  isFiscalYearEnd?: boolean
  /** Cuentas con póliza de crédito declarada: una 572 acreedora ahí es normal. */
  accountsWithCreditFacility?: readonly string[]
}

export type AuditInvariantInput = {
  bank?: BankInvariantInput
  runs?: readonly InvariantRunIntegrityRef[]
  store?: StoreCoverageInput
  allocationRuns?: readonly AllocationRunIntegrityRef[]
  reportRuns?: readonly ReportRunAllocationRef[]
  closing?: ClosingInvariantInput
}

// ─────────────────────────────────────────────────────────────────────────────
// El cuadre de una cuenta (§3.5) — lo comparten I-E7-1, el panel y el badge
// ─────────────────────────────────────────────────────────────────────────────

export type PendingSide = "BANCO" | "LIBROS"

export type PendingItem = {
  side: PendingSide
  id: string
  date: LocalDate
  amountCents: Cents
  kind: PendingKind | null
  ageDays: number
  description: string
}

export type ChainCoverage = {
  covered: boolean
  gaps: readonly { from: LocalDate; to: LocalDate }[]
  contradictoryOverlaps: readonly { a: string; b: string; detail: string }[]
  /** Sin anclaje no hay nada que cubrir: la cobertura es indeterminada. */
  anchored: boolean
}

export type BankReconciliationSummary = {
  bankAccountId: string
  accountCode: string
  currency: string
  cutoff: LocalDate
  anchored: boolean
  chain: ChainCoverage
  /** `E`. `null` si el banco no declara saldo hasta el corte. */
  saldoExtracto: Cents | null
  /** `B`. */
  saldoContable: Cents
  ue: Cents
  ub: Cents
  /** `(E − B) − (Ue − Ub)`. `null` cuando `E` no se puede establecer. */
  diferencia: Cents | null
  pendientesBanco: readonly PendingItem[]
  pendientesLibros: readonly PendingItem[]
  /** Σ de las líneas `IGNORED`, línea propia y visible del cuadre (O-12). */
  ignoradosCents: Cents
  ignoradosCount: number
  importeCeroCount: number
  /** Pendientes con antigüedad > `transitWarnDays` (O-8). */
  pendientesAntiguos: readonly PendingItem[]
  /** Apuntes de `REGULARIZATION` sobre la 57x: siempre un error a delatar. */
  regularizationLineIds: readonly string[]
  evaluable: boolean
  /** Por qué no se puede evaluar, cuando no se puede. */
  motivoNoEvaluable: string | null
  /**
   * **En qué moneda están las cuatro cifras** (H-1). Es siempre la de la cuenta:
   * `E`/`Ue` salen del extracto y `B`/`Ub`, cuando la cuenta no es en moneda
   * base, de `original_amount_cents` del diario. Nunca se mezclan.
   */
  moneda: string
  /** ¿`B`/`Ub` han salido de la divisa original en vez de la moneda base? */
  enDivisa: boolean
  /**
   * **La diferencia de cambio de la NRV 11ª.2.2** (H-3), cuando la cuenta está
   * en divisa y hay tasa de cierre. `null` = no hay tasa o no es en divisa. La
   * calcula la MISMA derivación que I-E7-12; el panel no recalcula nada, y por
   * eso la pantalla no puede discrepar del invariante.
   */
  fxDifferenceCents: Cents | null
  /**
   * En una cuenta en divisa, ¿TODOS los apuntes de la 57x llevan su importe en
   * esa divisa? Si no, `B` y `Ub` no son computables y el cuadre no se evalúa.
   */
  divisaCompleta: boolean
  /**
   * Pendientes que una conciliación **posterior al corte** ya recoge (§3.6,
   * criterios 1 y 2 de «explicado»): el cheque de diciembre que el banco carga
   * en enero y que ya está punteado contra su línea de enero. A `D` el apunte
   * sigue pendiente —y tiene que estarlo, o la identidad `E − B = Ue − Ub` se
   * rompe por su importe—, pero **está explicado**.
   */
  resolvedLaterIds: readonly string[]
}

const liveGroups = (groups: readonly BankMatchGroupRef[]): readonly BankMatchGroupRef[] =>
  groups.filter((g) => g.unmatchedAt === null || g.unmatchedAt === undefined)

/**
 * Qué está conciliado **a la fecha de corte**, y qué está conciliado por un
 * grupo que asoma más allá del corte.
 *
 * Un grupo sólo **cancela** en la identidad `E − B = Ue − Ub` si TODOS sus
 * miembros caen dentro del corte: es I-E7-11 (`Σ líneas = Σ apuntes`) lo que
 * hace que se cancelen, y esa igualdad sólo vale entera. Un grupo a caballo del
 * corte —el cheque contabilizado el 20-12 y cargado por el banco el 15-01—
 * aporta al corte su apunte y no su línea; darlo por conciliado dejaba fuera de
 * `Ub` un apunte que `B` sí contaba, y la identidad fallaba por su importe
 * exacto.
 *
 * Los miembros de un grupo a caballo que **sí** están dentro del corte siguen
 * siendo pendientes, y son exactamente los `resolvedLaterIds` de §3.6: la
 * contrapartida ya existe y ya está punteada, sólo que del otro lado del corte.
 */
const matchedAtCutoff = (
  groups: readonly BankMatchGroupRef[],
  bankLineDate: ReadonlyMap<string, LocalDate>,
  cashLineDate: ReadonlyMap<string, LocalDate>,
  cutoff: LocalDate
): { lines: Set<string>; cash: Set<string>; resolvedLater: Set<string> } => {
  const lines = new Set<string>()
  const cash = new Set<string>()
  const resolvedLater = new Set<string>()
  for (const group of liveGroups(groups)) {
    const dates = group.members.flatMap((m) => [bankLineDate.get(m.statementLineId), cashLineDate.get(m.journalLineId)])
    // Un miembro cuya fecha no conocemos (fuera del alcance leído) se trata como
    // fuera del corte: nunca se da por conciliado lo que no se ha visto.
    const dentro = dates.every((d) => d !== undefined && d <= cutoff)
    for (const member of group.members) {
      if (dentro) {
        lines.add(member.statementLineId)
        cash.add(member.journalLineId)
        continue
      }
      const lineDate = bankLineDate.get(member.statementLineId)
      const cashDate = cashLineDate.get(member.journalLineId)
      if (lineDate !== undefined && lineDate <= cutoff) resolvedLater.add(member.statementLineId)
      if (cashDate !== undefined && cashDate <= cutoff) resolvedLater.add(member.journalLineId)
    }
  }
  return { lines, cash, resolvedLater }
}

/**
 * `E`: saldo del extracto a `D` **declarado por el banco**. Si el corte cae
 * dentro de un extracto, se toma su saldo inicial declarado más los movimientos
 * hasta `D`; si cae después del último, su saldo final declarado. Nunca se
 * «reconstruye» un saldo que el banco no ha declarado.
 */
export function statementBalanceAt(
  statements: readonly BankStatementRef[],
  lines: readonly BankLineRef[],
  cutoff: LocalDate
): { cents: Cents; statementId: string } | null {
  const sorted = [...statements].sort((a, b) => (a.periodStart < b.periodStart ? -1 : a.periodStart > b.periodStart ? 1 : 0))
  const covering = sorted.filter((s) => s.periodStart <= cutoff && cutoff <= s.periodEnd)
  const last = covering[covering.length - 1]
  if (last !== undefined && last.openingBalanceCents !== null) {
    const moves = lines.filter((l) => l.statementId === last.id && l.operationDate <= cutoff)
    return { cents: last.openingBalanceCents + sum(moves.map((l) => l.amountCents)), statementId: last.id }
  }
  const before = sorted.filter((s) => s.periodEnd <= cutoff && s.closingBalanceCents !== null)
  const previous = before[before.length - 1]
  if (previous !== undefined && previous.closingBalanceCents !== null) {
    return { cents: previous.closingBalanceCents, statementId: previous.id }
  }
  return null
}

/** I-E7-6b: la unión de los periodos cubre `[anclaje, corte]` sin huecos. */
export function chainCoverage(
  account: BankAccountRef,
  statements: readonly BankStatementRef[],
  cutoff: LocalDate
): ChainCoverage {
  const anchor = account.reconciledFromDate
  if (anchor === null) return { covered: false, gaps: [], contradictoryOverlaps: [], anchored: false }
  const own = [...statements]
    .filter((s) => s.bankAccountId === account.id)
    .sort((a, b) => (a.periodStart < b.periodStart ? -1 : a.periodStart > b.periodStart ? 1 : 0))

  const gaps: { from: LocalDate; to: LocalDate }[] = []
  const contradictoryOverlaps: { a: string; b: string; detail: string }[] = []
  let reached: LocalDate | null = null

  for (const statement of own) {
    if (statement.periodEnd < anchor) continue
    const start = statement.periodStart < anchor ? anchor : statement.periodStart
    if (reached === null) {
      if (start > anchor) gaps.push({ from: anchor, to: start })
    } else if (start > nextDay(reached)) {
      gaps.push({ from: nextDay(reached), to: start })
    }
    if (reached === null || statement.periodEnd > reached) reached = statement.periodEnd
  }

  for (let i = 0; i < own.length; i++) {
    for (let j = i + 1; j < own.length; j++) {
      const a = own[i] as BankStatementRef
      const b = own[j] as BankStatementRef
      if (b.periodStart > a.periodEnd) continue
      if (
        a.periodEnd === b.periodEnd &&
        a.closingBalanceCents !== null &&
        b.closingBalanceCents !== null &&
        a.closingBalanceCents !== b.closingBalanceCents
      ) {
        contradictoryOverlaps.push({
          a: a.id,
          b: b.id,
          detail: `mismo cierre ${a.periodEnd} con saldos distintos: ${eur(a.closingBalanceCents)} ≠ ${eur(b.closingBalanceCents)}`,
        })
      }
    }
  }

  if (reached === null) gaps.push({ from: anchor, to: cutoff })
  else if (reached < cutoff) gaps.push({ from: nextDay(reached), to: cutoff })

  return { covered: gaps.length === 0 && contradictoryOverlaps.length === 0, gaps, contradictoryOverlaps, anchored: true }
}

/** Día siguiente sin `Date`: las fechas contables son cadenas ordenables. */
export function nextDay(date: LocalDate): LocalDate {
  const [y, m, d] = [Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10))]
  const days = new Map([
    [1, 31],
    [3, 31],
    [4, 30],
    [5, 31],
    [6, 30],
    [7, 31],
    [8, 31],
    [9, 30],
    [10, 31],
    [11, 30],
    [12, 31],
  ])
  const inMonth = m === 2 ? ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28) : (days.get(m) ?? 30)
  if (d < inMonth) return `${date.slice(0, 8)}${String(d + 1).padStart(2, "0")}`
  if (m < 12) return `${date.slice(0, 4)}-${String(m + 1).padStart(2, "0")}-01`
  return `${y + 1}-01-01`
}

/**
 * El cuadre de UNA cuenta a la fecha de corte. Lo consumen I-E7-1, el panel de
 * `/audit/bank/[id]` y el badge P6 (§3.6): una sola derivación, no tres.
 */
export function reconciliationSummary(
  account: BankAccountRef,
  input: Pick<BankInvariantInput, "statements" | "lines" | "groups" | "cashLines" | "cutoff" | "baseCurrency" | "fx">
): BankReconciliationSummary {
  const cutoff = input.cutoff
  const statements = input.statements.filter((s) => s.bankAccountId === account.id)
  const bankLines = input.lines.filter((l) => l.bankAccountId === account.id && l.operationDate <= cutoff)
  const cashLines = input.cashLines.filter(
    (l) => isUnderAccount(l.accountCode, account.accountCode) && l.entryDate <= cutoff
  )
  const matched = matchedAtCutoff(
    input.groups.filter((g) => g.bankAccountId === account.id),
    new Map(input.lines.map((l) => [l.id, l.operationDate])),
    new Map(input.cashLines.map((l) => [l.id, l.entryDate])),
    cutoff
  )

  /**
   * **H-1 · las cuatro cifras, en la MISMA moneda** (ADR-0015 D6.2, §3.5).
   *
   * `E` y `Ue` salen del extracto, que está en la divisa de la cuenta. `B` y
   * `Ub` salían de `debe − haber`, que está en moneda **base**: en una cuenta en
   * dólares la identidad comparaba dólares con euros y salía PASS por vacuidad
   * mientras nada estuviera conciliado. Cuando la cuenta no es en moneda base,
   * `B` y `Ub` se toman de `original_amount_cents` (`hashVersion = 3`).
   *
   * La diferencia entre el contravalor histórico en euros y `saldo en divisa ×
   * tasa de cierre` **no es un pendiente**: es la diferencia de cambio de la
   * NRV 11ª.2.2, y la mide I-E7-12 (768/668), no este cuadre.
   */
  const enDivisa = account.currency.toUpperCase() !== input.baseCurrency.toUpperCase()
  const moneda = account.currency.toUpperCase()
  const sinDivisa = enDivisa
    ? cashLines.filter(
        (l) =>
          l.entryKind !== "CLOSING" &&
          (signedOriginalAmountOf(l) === null || (l.originalCurrency ?? "").toUpperCase() !== moneda)
      )
    : []
  const amountOf = (l: LedgerCashLineRef): Cents => (enDivisa ? (signedOriginalAmountOf(l) ?? 0) : signedAmountOf(l))

  // `B` con la MISMA función de la foto de E6, cuenta a cuenta (§3.7). En divisa
  // no hay foto de E6 que reutilizar —E6 es en moneda base— y se suma aquí con
  // exactamente el mismo criterio de exclusión (`kind ∉ {CLOSING}`).
  const codes = [...new Set(cashLines.map((l) => l.accountCode))].sort()
  const saldoContable = enDivisa
    ? sum(cashLines.filter((l) => !B_EXCLUDED_KINDS.includes(l.entryKind)).map(amountOf))
    : sum(codes.map((code) => balanceOfAccount(cashLines, code, B_EXCLUDED_KINDS)))

  const extract = statementBalanceAt(statements, input.lines, cutoff)
  const chain = chainCoverage(account, statements, cutoff)

  const ignored = bankLines.filter((l) => l.status === "IGNORED")
  const ignoradosCents = sum(ignored.map((l) => l.amountCents))
  const unmatchedBank = bankLines.filter((l) => l.status !== "MATCHED" && !matched.lines.has(l.id) && l.status !== "IGNORED")
  const ue = sum(unmatchedBank.map((l) => l.amountCents)) + ignoradosCents

  /**
   * **La regla negativa de §3.5, en el sitio en el que muerde.** *Una diferencia
   * de cambio jamás aparece en `Ue` ni en `Ub`.* El asiento que la reconoce
   * (`5740001 (D) / 768 (H)`, NRV 11ª.2.2) mueve la 57x **en moneda base y no en
   * divisa**: en la moneda de la cuenta vale 0,00, y el banco no va a enseñar
   * nunca un movimiento por ese importe. Un apunte que no mueve NADA en la
   * moneda del cuadre no es una partida en tránsito: no entra en la lista de
   * pendientes (a `Ub` suma 0 de todas formas, así que la identidad no se toca).
   *
   * En moneda base el caso no existe —el CHECK del diario exige que exactamente
   * uno de debe/haber sea > 0—, así que la regla sólo actúa donde tiene sentido.
   */
  const unmatchedCash = cashLines.filter(
    (l) =>
      !matched.cash.has(l.id) &&
      l.entryKind !== "CLOSING" &&
      amountOf(l) !== 0 &&
      (l.pendingKind === null ||
        l.pendingKind === undefined ||
        !PENDING_KINDS_OUT_OF_RECONCILIATION.includes(l.pendingKind))
  )
  const ub = sum(unmatchedCash.map(amountOf))

  const pendientesBanco: PendingItem[] = unmatchedBank.map((l) => ({
    side: "BANCO" as const,
    id: l.id,
    date: l.operationDate,
    amountCents: l.amountCents,
    // Sin tipar es `null`, **no** un tipo por defecto: un pendiente que nadie ha
    // declarado no puede quedar «explicado» por un valor que puso el código
    // (O-17). El panel lo enseña como «sin tipar» y el badge se retira.
    kind: l.pendingKind ?? null,
    ageDays: ageInDays(l.operationDate, cutoff),
    description: l.description,
  }))
  const pendientesLibros: PendingItem[] = unmatchedCash.map((l) => ({
    side: "LIBROS" as const,
    id: l.id,
    date: l.entryDate,
    amountCents: amountOf(l),
    kind: l.pendingKind ?? null,
    ageDays: ageInDays(l.entryDate, cutoff),
    description: l.description ?? "",
  }))

  const pendientesAntiguos = [...pendientesBanco, ...pendientesLibros].filter((p) => p.ageDays > account.transitWarnDays)
  const regularizationLineIds = cashLines.filter((l) => l.entryKind === "REGULARIZATION").map((l) => l.id)

  // H-3: la diferencia de cambio, con la tasa de cierre que aporte el borde.
  const fx = (input.fx ?? []).find((f) => f.bankAccountId === account.id)
  // **N-1**: sólo `baseBalanceCents`, que ya contiene el asiento de
  // reconocimiento (mueve la 57x). Restar además lo reconocido lo duplicaba.
  const fxDifference =
    fx === undefined || !enDivisa || sinDivisa.length > 0
      ? null
      : convertWithRateMicro(
          sum(cashLines.filter((l) => !B_EXCLUDED_KINDS.includes(l.entryKind)).map(amountOf)),
          fx.rateMicro
        ) - fx.baseBalanceCents

  const motivoNoEvaluable = !chain.anchored
    ? "la cuenta no tiene anclaje (`reconciledFromDate`): no se puede afirmar desde dónde está conciliada"
    : sinDivisa.length > 0
      ? `la cuenta está en ${moneda} y ${sinDivisa.length} apunte(s) de ${account.accountCode} no llevan su importe en ${moneda} ` +
        `(original_amount_cents): el cuadre en divisa no se puede hacer sin mezclar monedas — ${sinDivisa
          .slice(0, 5)
          .map((l) => `${l.entryDate} #${l.entryNumber}/${l.lineNo}`)
          .join(", ")}`
      : !chain.covered
      ? `la cadena de extractos no cubre [${account.reconciledFromDate}, ${cutoff}]: ${chain.gaps
          .map((g) => `hueco ${g.from}…${g.to}`)
          .join(", ")}${chain.contradictoryOverlaps.length > 0 ? ` · solape contradictorio` : ""}`
      : extract === null
        ? "el banco no declara saldo hasta la fecha de corte"
        : null

  return {
    bankAccountId: account.id,
    accountCode: account.accountCode,
    currency: account.currency,
    cutoff,
    anchored: chain.anchored,
    chain,
    saldoExtracto: extract?.cents ?? null,
    saldoContable,
    ue,
    ub,
    diferencia: extract === null ? null : extract.cents - saldoContable - (ue - ub),
    pendientesBanco,
    pendientesLibros,
    ignoradosCents,
    ignoradosCount: ignored.length,
    importeCeroCount: ignored.filter((l) => l.ignoreReason === "IMPORTE_CERO").length,
    pendientesAntiguos,
    regularizationLineIds,
    evaluable: motivoNoEvaluable === null,
    motivoNoEvaluable,
    moneda,
    enDivisa,
    divisaCompleta: sinDivisa.length === 0,
    fxDifferenceCents: fxDifference,
    resolvedLaterIds: [...matched.resolvedLater].sort(),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E7-1 — el cuadre
// ─────────────────────────────────────────────────────────────────────────────

const QUERY_IE71 =
  "SELECT l.account_code, SUM(l.debit_cents - l.credit_cents) FROM journal_lines l " +
  "JOIN journal_entries e ON e.id = l.entry_id WHERE l.organization_id = $1 AND l.account_code LIKE $2 " +
  "AND e.entry_date <= $3 AND e.kind <> 'CLOSING' GROUP BY 1"

export function checkIE71(input: BankInvariantInput): CheckResult {
  if (input.accounts.length === 0) {
    return info("I-E7-1", "la organización no tiene cuentas bancarias declaradas: no hay cuadre que comprobar")
  }
  const summaries = input.accounts.map((a) => reconciliationSummary(a, input))
  const fails = summaries.filter((s) => s.evaluable && s.diferencia !== 0)
  const noEvaluables = summaries.filter((s) => !s.evaluable)
  const regularizadas = summaries.filter((s) => s.regularizationLineIds.length > 0)

  const describe = (s: BankReconciliationSummary): string =>
    `${s.accountCode}: E ${eur(s.saldoExtracto ?? 0)} − B ${eur(s.saldoContable)} = ${eur(
      (s.saldoExtracto ?? 0) - s.saldoContable
    )} frente a Ue ${eur(s.ue)} − Ub ${eur(s.ub)} = ${eur(s.ue - s.ub)} · diferencia ${eur(s.diferencia ?? 0)} · ` +
    `${s.pendientesBanco.length} pendiente(s) de banco y ${s.pendientesLibros.length} de libros · ` +
    `Σ ignorado ${eur(s.ignoradosCents)}`

  if (fails.length > 0 || regularizadas.length > 0) {
    const partes = [
      ...fails.map(describe),
      ...regularizadas.map(
        (s) =>
          `${s.accountCode}: ${s.regularizationLineIds.length} apunte(s) de REGULARIZACIÓN sobre una cuenta 57x, que nunca debe tocarla`
      ),
    ]
    return failed("I-E7-1", `E − B ≠ Ue − Ub · ${partes.join(" · ")}`, QUERY_IE71)
  }
  if (noEvaluables.length > 0) {
    return info(
      "I-E7-1",
      `${summaries.length - noEvaluables.length}/${summaries.length} cuenta(s) cuadran; no evaluables: ` +
        noEvaluables.map((s) => `${s.accountCode} — ${s.motivoNoEvaluable}`).join(" · "),
      QUERY_IE71
    )
  }
  return pass("I-E7-1", `${summaries.length} cuenta(s) con E − B = Ue − Ub · ${summaries.map(describe).join(" · ")}`, QUERY_IE71)
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E7-2 — tenant, cuenta y **igualdad de importe con signo** (O-9)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * I-E7-4, subsumido en I-E7-2 (O-9), se conserva como **evidencia legible** del
 * signo: un cargo del banco es un HABER de la 57x y al revés.
 */
export function describeSignEvidence(bankAmount: Cents, signedLedger: Cents): string {
  const side = bankAmount < 0 ? "cargo" : bankAmount > 0 ? "abono" : "apunte de 0,00 €"
  const ledgerSide = signedLedger < 0 ? "haber" : signedLedger > 0 ? "debe" : "sin importe"
  return `${side} de ${eur(bankAmount)} contra ${ledgerSide} de ${eur(Math.abs(signedLedger))}`
}

/**
 * El importe con signo de un apunte **en la moneda de la cuenta bancaria**
 * (H-1). Es lo único contra lo que se puede comparar `bankLine.amountCents`, que
 * está siempre en la divisa del extracto. `null` = el apunte no lleva su importe
 * en esa divisa y la comparación **no se puede hacer**: se delata, no se
 * aproxima.
 */
export const comparableAmountOf = (
  line: LedgerCashLineRef,
  account: BankAccountRef,
  baseCurrency: string
): Cents | null => {
  if (account.currency.toUpperCase() === baseCurrency.toUpperCase()) return signedAmountOf(line)
  if ((line.originalCurrency ?? "").toUpperCase() !== account.currency.toUpperCase()) return null
  return signedOriginalAmountOf(line)
}

export function checkIE72(input: BankInvariantInput): CheckResult {
  const groups = liveGroups(input.groups)
  if (groups.length === 0) return info("I-E7-2", "no hay grupos de conciliación vivos que comprobar")
  const accountsById = new Map(input.accounts.map((a) => [a.id, a]))
  const linesById = new Map(input.lines.map((l) => [l.id, l]))
  const cashById = new Map(input.cashLines.map((l) => [l.id, l]))
  const failures: string[] = []
  let checked = 0

  for (const group of groups) {
    const account = accountsById.get(group.bankAccountId)
    if (account === undefined) {
      failures.push(`grupo ${group.id}: la cuenta bancaria ${group.bankAccountId} no existe en el alcance`)
      continue
    }
    const simple = group.members.length === 1
    for (const member of group.members) {
      const line = linesById.get(member.statementLineId)
      const cash = cashById.get(member.journalLineId)
      if (line === undefined || cash === undefined) {
        failures.push(`grupo ${group.id}: miembro con línea o apunte fuera del alcance`)
        continue
      }
      checked += 1
      if (cash.organizationId !== input.organizationId || line.bankAccountId !== account.id) {
        failures.push(`grupo ${group.id}: la conciliación cruza organización o cuenta bancaria`)
      }
      if (!isReconcilableAccount(cash.accountCode)) {
        failures.push(`grupo ${group.id}: el apunte ${cash.id} está en ${cash.accountCode}, que no es 572/573/574/575`)
      }
      if (!isUnderAccount(cash.accountCode, account.accountCode)) {
        failures.push(
          `grupo ${group.id}: el apunte ${cash.id} está en ${cash.accountCode} y la cuenta bancaria puntea contra ${account.accountCode}`
        )
      }
      if (line.currency.toUpperCase() !== account.currency.toUpperCase()) {
        failures.push(`grupo ${group.id}: la línea ${line.id} está en ${line.currency} y la cuenta en ${account.currency}`)
      }
      if (simple) {
        const signed = comparableAmountOf(cash, account, input.baseCurrency)
        if (signed === null) {
          failures.push(
            `grupo ${group.id}: la cuenta está en ${account.currency} y el apunte ${cash.id} no lleva su importe en ${account.currency} ` +
              "(original_amount_cents): no hay nada que comparar sin mezclar monedas"
          )
        } else if (line.amountCents !== signed) {
          failures.push(
            `grupo ${group.id}: ${describeSignEvidence(line.amountCents, signed)} — diferencia ${eur(
              line.amountCents - signed
            )} (tolerancia 0)`
          )
        }
      }
    }
  }
  return failures.length === 0
    ? pass("I-E7-2", `${checked} conciliación(es) viva(s) con misma cuenta, misma divisa e igual importe con signo`)
    : failed("I-E7-2", failures.join(" · "))
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E7-3 — nada pertenece a dos grupos vivos
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE73(input: BankInvariantInput): CheckResult {
  const groups = liveGroups(input.groups)
  if (groups.length === 0) return info("I-E7-3", "no hay grupos de conciliación vivos que comprobar")
  const lineOwners = new Map<string, string[]>()
  const cashOwners = new Map<string, string[]>()
  for (const group of groups) {
    for (const member of group.members) {
      lineOwners.set(member.statementLineId, [...(lineOwners.get(member.statementLineId) ?? []), group.id])
      cashOwners.set(member.journalLineId, [...(cashOwners.get(member.journalLineId) ?? []), group.id])
    }
  }
  const failures = [
    ...[...lineOwners.entries()]
      .filter(([, owners]) => new Set(owners).size > 1)
      .map(([id, owners]) => `la línea ${id} pertenece a ${new Set(owners).size} grupos vivos (${[...new Set(owners)].join(", ")})`),
    ...[...cashOwners.entries()]
      .filter(([, owners]) => new Set(owners).size > 1)
      .map(([id, owners]) => `el apunte ${id} pertenece a ${new Set(owners).size} grupos vivos (${[...new Set(owners)].join(", ")})`),
  ].sort()
  return failures.length === 0
    ? pass("I-E7-3", `${lineOwners.size} línea(s) y ${cashOwners.size} apunte(s) en un solo grupo vivo`)
    : failed("I-E7-3", failures.join(" · "))
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E7-5 — integridad de lo importado
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE75(input: BankInvariantInput): CheckResult {
  if (input.statements.length === 0) return info("I-E7-5", "no hay extractos importados que comprobar")
  const failures: string[] = []

  const byAccountFile = new Map<string, string[]>()
  for (const s of input.statements) {
    const key = `${s.bankAccountId}|${s.fileSha256}`
    byAccountFile.set(key, [...(byAccountFile.get(key) ?? []), s.id])
  }
  for (const [key, ids] of byAccountFile) {
    if (ids.length > 1) failures.push(`el fichero ${key.split("|")[1]} está importado ${ids.length} veces (${ids.join(", ")})`)
  }

  const byAccountSha = new Map<string, string[]>()
  for (const l of input.lines) {
    const key = `${l.bankAccountId}|${l.sha256}`
    byAccountSha.set(key, [...(byAccountSha.get(key) ?? []), l.id])
  }
  for (const [key, ids] of byAccountSha) {
    if (ids.length > 1) failures.push(`${ids.length} líneas con el mismo sha256 en la cuenta ${key.split("|")[0]}: ${ids.join(", ")}`)
  }

  for (const statement of input.statements) {
    const own = input.lines.filter((l) => l.statementId === statement.id).map((l) => l.lineNo).sort((a, b) => a - b)
    if (own.length === 0) continue
    const expected = own.map((_, index) => index + 1)
    if (own.join(",") !== expected.join(",")) {
      failures.push(`el extracto ${statement.id} tiene lineNo con huecos o repetidos: ${own.join(", ")}`)
    }
  }

  return failures.length === 0
    ? pass(
        "I-E7-5",
        `${input.statements.length} extracto(s) y ${input.lines.length} línea(s) con fichero único, sha256 único y lineNo correlativo`
      )
    : failed("I-E7-5", failures.join(" · "))
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E7-6a / I-E7-6b — el extracto consigo mismo y la cobertura de la cadena
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE76a(input: BankInvariantInput): CheckResult {
  if (input.statements.length === 0) return info("I-E7-6a", "no hay extractos importados que comprobar")
  const failures: string[] = []
  const skipped: string[] = []
  let checked = 0

  for (const statement of input.statements) {
    const own = input.lines.filter((l) => l.statementId === statement.id)
    if (statement.openingBalanceCents === null || statement.closingBalanceCents === null) {
      skipped.push(`${statement.id} (el banco no declara saldos)`)
      continue
    }
    checked += 1
    const computed = statement.openingBalanceCents + sum(own.map((l) => l.amountCents))
    if (computed !== statement.closingBalanceCents) {
      failures.push(
        `${statement.id}: ${eur(statement.openingBalanceCents)} + Σ ${eur(
          sum(own.map((l) => l.amountCents))
        )} = ${eur(computed)} ≠ saldo final declarado ${eur(statement.closingBalanceCents)}`
      )
    }
    if (statement.declaredLineCount !== null && statement.declaredLineCount !== own.length) {
      failures.push(
        `${statement.id}: el registro 33 declara ${statement.declaredLineCount} apuntes y se importaron ${own.length}`
      )
    }
  }

  if (failures.length > 0) return failed("I-E7-6a", failures.join(" · "))
  if (checked === 0) return info("I-E7-6a", `ningún extracto declara saldos: ${skipped.join(", ")}`)
  const tail = skipped.length > 0 ? ` · sin saldos declarados: ${skipped.join(", ")}` : ""
  return pass("I-E7-6a", `${checked} extracto(s) cuadran consigo mismos y con el registro 33${tail}`)
}

export function checkIE76b(input: BankInvariantInput): CheckResult {
  if (input.accounts.length === 0) return info("I-E7-6b", "la organización no tiene cuentas bancarias declaradas")
  const failures: string[] = []
  const sinAnclaje: string[] = []
  let covered = 0

  for (const account of input.accounts) {
    const chain = chainCoverage(account, input.statements, input.cutoff)
    if (!chain.anchored) {
      sinAnclaje.push(account.accountCode)
      continue
    }
    if (chain.gaps.length > 0) {
      failures.push(
        `${account.accountCode}: hueco(s) en la cadena ${chain.gaps.map((g) => `${g.from}…${g.to}`).join(", ")}`
      )
    }
    for (const overlap of chain.contradictoryOverlaps) {
      failures.push(`${account.accountCode}: solape contradictorio entre ${overlap.a} y ${overlap.b} — ${overlap.detail}`)
    }
    if (chain.covered) covered += 1
  }

  if (failures.length > 0) return failed("I-E7-6b", failures.join(" · "))
  if (covered === 0) {
    return info("I-E7-6b", `sin anclaje, no hay cadena que cubrir: ${sinAnclaje.join(", ")}`)
  }
  const tail = sinAnclaje.length > 0 ? ` · sin anclaje: ${sinAnclaje.join(", ")}` : ""
  return pass("I-E7-6b", `${covered} cuenta(s) con la cadena completa hasta ${input.cutoff}${tail}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E7-7 — reproducibilidad del propio barrido
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE77(runs: readonly InvariantRunIntegrityRef[]): CheckResult {
  if (runs.length === 0) return info("I-E7-7", "no hay barridos anteriores que verificar")
  const failures = runs
    .filter((run) => checksHashOf(run.checks) !== run.checksHash)
    .map((run) => `el run ${run.id} declara checksHash ${run.checksHash} y sus checks dan ${checksHashOf(run.checks)}`)
  return failures.length === 0
    ? pass("I-E7-7", `${runs.length} run(s) con checksHash recomputado idéntico al sellado`)
    : failed("I-E7-7", failures.join(" · "))
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E7-8 — cobertura del almacén
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE78(store: StoreCoverageInput): CheckResult {
  if (store.files.length === 0) return info("I-E7-8", "la organización no tiene ficheros en el almacén")
  if (store.lastSweep === null || store.lastSweep.status !== "DONE" || store.lastSweep.finishedAt === null) {
    return info("I-E7-8", "no hay ningún barrido del almacén terminado: la cobertura no se puede afirmar")
  }
  const lastIngested = [...store.files].map((f) => f.ingestedAt).sort().at(-1) ?? ""
  if (store.lastSweep.finishedAt < lastIngested) {
    return warn(
      "I-E7-8",
      `el último barrido terminó el ${store.lastSweep.finishedAt} y hay ficheros ingeridos después (${lastIngested}): hay que rebarrer`
    )
  }
  const swept = new Set(store.lastSweep.sweptFileIds)
  const missing = store.files.filter((f) => !swept.has(f.id)).map((f) => f.id)
  return missing.length === 0
    ? pass("I-E7-8", `${store.files.length} fichero(s) con veredicto en el barrido ${store.lastSweep.id}`)
    : failed("I-E7-8", `${missing.length} fichero(s) sin veredicto en el último barrido: ${missing.slice(0, 20).join(", ")}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E7-9 / I-E7-10 — la deuda de E5
// ─────────────────────────────────────────────────────────────────────────────

/** Fecha de la migración que introdujo `lines_hash` (`20260910110000`). */
export const LINES_HASH_SINCE = "2026-09-10T11:00:00.000Z"

export function checkIE79(runs: readonly AllocationRunIntegrityRef[]): CheckResult {
  const sealed = runs.filter((r) => r.status === "SEALED")
  if (sealed.length === 0) return info("I-E7-9", "no hay liquidaciones selladas que comprobar")
  const missing = sealed.filter((r) => r.linesHash === null || r.linesHash === "")
  const legacy = missing.filter((r) => (r.sealedAt ?? "") < LINES_HASH_SINCE)
  const recent = missing.filter((r) => (r.sealedAt ?? "") >= LINES_HASH_SINCE)
  const describe = (r: AllocationRunIntegrityRef): string => `${r.id} (${r.periodStart}…${r.periodEnd}, sellado ${r.sealedAt ?? "sin fecha"})`

  if (recent.length > 0) {
    return failed(
      "I-E7-9",
      `${recent.length} liquidación(es) selladas DESPUÉS de ${LINES_HASH_SINCE} sin linesHash: ${recent.map(describe).join(" · ")}`
    )
  }
  if (legacy.length > 0) {
    return warn(
      "I-E7-9",
      `${legacy.length} liquidación(es) anteriores a ${LINES_HASH_SINCE} sin linesHash; el único camino legítimo es re-liquidarlas: ` +
        legacy.map(describe).join(" · ")
    )
  }
  return pass("I-E7-9", `${sealed.length} liquidación(es) selladas con linesHash`)
}

export function checkIE710(
  reportRuns: readonly ReportRunAllocationRef[],
  allocationRuns: readonly AllocationRunIntegrityRef[]
): CheckResult {
  if (reportRuns.length === 0) return info("I-E7-10", "no hay informes vigentes apoyados en liquidaciones")
  const byId = new Map(allocationRuns.map((r) => [r.id, r]))
  const failures: string[] = []
  let checked = 0
  const sinRecalculo: string[] = []

  for (const report of reportRuns) {
    const expectedSetHash = allocationRunSetHash([...report.allocationRunIds])
    if (expectedSetHash !== report.allocationRunSetHash) {
      failures.push(
        `el informe ${report.id} declara allocationRunSetHash ${report.allocationRunSetHash} y su conjunto da ${expectedSetHash}`
      )
    }
    for (const id of report.allocationRunIds) {
      const run = byId.get(id)
      if (run === undefined) {
        failures.push(`el informe ${report.id} se apoya en la liquidación ${id}, que no está en el alcance`)
        continue
      }
      if (run.linesHashExpected === undefined || run.linesHashExpected === null) {
        sinRecalculo.push(id)
        continue
      }
      checked += 1
      if (run.linesHash !== run.linesHashExpected) {
        failures.push(
          `las líneas de la liquidación ${id} han cambiado bajo el informe ${report.id}: sellado ${run.linesHash ?? "∅"} ≠ recomputado ${run.linesHashExpected}`
        )
      }
    }
  }
  if (failures.length > 0) return failed("I-E7-10", failures.join(" · "))
  if (checked === 0) {
    return info("I-E7-10", `sin linesHash recomputado no se puede afirmar nada: ${[...new Set(sinRecalculo)].join(", ")}`)
  }
  const tail = sinRecalculo.length > 0 ? ` · sin recomputar: ${[...new Set(sinRecalculo)].join(", ")}` : ""
  return pass("I-E7-10", `${checked} liquidación(es) intactas bajo ${reportRuns.length} informe(s) vigente(s)${tail}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E7-11 — el grupo cuadra
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE711(input: BankInvariantInput): CheckResult {
  const groups = liveGroups(input.groups)
  if (groups.length === 0) return info("I-E7-11", "no hay grupos de conciliación vivos que comprobar")
  const linesById = new Map(input.lines.map((l) => [l.id, l]))
  const cashById = new Map(input.cashLines.map((l) => [l.id, l]))
  const accountsById = new Map(input.accounts.map((a) => [a.id, a]))
  const failures: string[] = []

  for (const group of groups) {
    const lineIds = [...new Set(group.members.map((m) => m.statementLineId))]
    const cashIds = [...new Set(group.members.map((m) => m.journalLineId))]
    const missing = [...lineIds.filter((id) => !linesById.has(id)), ...cashIds.filter((id) => !cashById.has(id))]
    if (missing.length > 0) {
      failures.push(`grupo ${group.id}: miembros fuera del alcance (${missing.join(", ")})`)
      continue
    }
    const account = accountsById.get(group.bankAccountId)
    if (account === undefined) {
      failures.push(`grupo ${group.id}: la cuenta bancaria ${group.bankAccountId} no existe en el alcance`)
      continue
    }
    const sumLines = sum(lineIds.map((id) => (linesById.get(id) as BankLineRef).amountCents))
    // **H-1**: el grupo cuadra en la moneda de la CUENTA, no en la base.
    const cashAmounts = cashIds.map((id) =>
      comparableAmountOf(cashById.get(id) as LedgerCashLineRef, account, input.baseCurrency)
    )
    if (cashAmounts.some((a) => a === null)) {
      failures.push(
        `grupo ${group.id}: la cuenta está en ${account.currency} y algún apunte no lleva su importe en ${account.currency} ` +
          "(original_amount_cents): el grupo no se puede cuadrar sin mezclar monedas"
      )
      continue
    }
    const sumCash = sum(cashAmounts as number[])
    if (sumLines !== sumCash) {
      failures.push(
        `grupo ${group.id} (${group.kind}, ${lineIds.length} línea(s) contra ${cashIds.length} apunte(s)): Σ extracto ${eur(
          sumLines
        )} ≠ Σ apuntes ${eur(sumCash)} · diferencia ${eur(sumLines - sumCash)} (tolerancia 0)`
      )
    }
  }
  return failures.length === 0
    ? pass("I-E7-11", `${groups.length} grupo(s) vivo(s) con Σ líneas = Σ apuntes`)
    : failed("I-E7-11", failures.join(" · "))
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E7-12 — divisa (NRV 11ª.2.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * La **diferencia de cambio** de una cuenta en divisa a la fecha de cierre
 * (NRV 11ª.2.2):
 *
 * > `saldo en divisa × tasa de cierre − Σ contravalores contabilizados`
 *
 * Una sola definición, que consumen I-E7-12 y el panel de `/audit/bank/[id]`: la
 * pantalla no recalcula nada.
 *
 * **N-1 de la re-auditoría (ALTA).** La versión de la ronda 1 restaba además
 * `recognizedDifferenceCents`, y eso **duplicaba la diferencia**: el asiento que
 * reconoce la diferencia de cambio mueve la 57x (`5740001 (D) 10,50 € / 768 (H)
 * 10,50 €`, NRV 11ª.2.2), de modo que `baseBalanceCents` —el saldo contable
 * COMPLETO de la cuenta— **ya lo contiene**. Restarlo otra vez daba, sobre una
 * cuenta correctamente regularizada, un `WARN` de −10,50 € cuya propia evidencia
 * se contradecía («332,50 € valorados frente a 332,50 € contabilizados» y a la
 * vez «diferencia −10,50 €»). Y como H-4 hizo que el motivo
 * `DIFERENCIA_DE_CAMBIO_SIN_RECONOCER` **sí** mueva el sello, la cuenta quedaba
 * en `REQUIERE REVISIÓN` para siempre justo por haber hecho lo correcto.
 *
 * `recognizedDifferenceCents` se conserva como **evidencia**, no como sumando:
 * dice cuánto se ha reconocido ya, que es lo que quien firma quiere leer.
 */
export function fxDifferenceOf(summary: BankReconciliationSummary, fx: FxCloseRef): Cents | null {
  if (!summary.enDivisa || !summary.divisaCompleta) return null
  return convertWithRateMicro(summary.saldoContable, fx.rateMicro) - fx.baseBalanceCents
}


export function checkIE712(input: BankInvariantInput): CheckResult {
  const foreign = input.accounts.filter((a) => a.currency.toUpperCase() !== input.baseCurrency.toUpperCase())
  if (foreign.length === 0) {
    return info("I-E7-12", `ninguna cuenta bancaria en divisa distinta de ${input.baseCurrency.toUpperCase()}`)
  }
  const failures: string[] = []
  const warnings: string[] = []
  const fxByAccount = new Map((input.fx ?? []).map((f) => [f.bankAccountId, f]))
  const evaluated: string[] = []

  for (const account of foreign) {
    // Regla negativa explícita: una línea en otra divisa significa que el cuadre
    // se está haciendo en la divisa equivocada.
    const wrong = input.lines.filter(
      (l) => l.bankAccountId === account.id && l.currency.toUpperCase() !== account.currency.toUpperCase()
    )
    if (wrong.length > 0) {
      failures.push(
        `${account.accountCode}: ${wrong.length} línea(s) en divisa distinta de ${account.currency} — el cuadre se está haciendo en la divisa equivocada`
      )
      continue
    }
    const fx = fxByAccount.get(account.id)
    if (fx === undefined) continue
    const summary = reconciliationSummary(account, { ...input, cutoff: fx.closingDate })
    if (!summary.divisaCompleta) {
      failures.push(
        `${account.accountCode}: hay apuntes de la 57x sin importe en ${account.currency} — ${summary.motivoNoEvaluable}`
      )
      continue
    }
    // `saldoContable` está YA en la divisa de la cuenta (H-1): éste es el único
    // sitio donde se cruza a moneda base, y se cruza con la tasa de CIERRE.
    const expectedBase = convertWithRateMicro(summary.saldoContable, fx.rateMicro)
    const difference = fxDifferenceOf(summary, fx) ?? 0
    evaluated.push(`${account.accountCode} (${account.currency})`)
    if (difference !== 0) {
      warnings.push(
        `${account.accountCode}: saldo ${eur(summary.saldoContable)} ${account.currency} × tasa de cierre = ${eur(
          expectedBase
        )} ${input.baseCurrency} frente a ${eur(fx.baseBalanceCents)} contabilizados: diferencia de cambio ${eur(
          difference
        )} sin reconocer a ${fx.closingDate} (ya reconocidos ${eur(fx.recognizedDifferenceCents)} en 768/668). ` +
          "E7 la mide y avisa; el asiento que la recoge mueve la 57x y, en cuanto existe, este invariante pasa a PASS. " +
          "No es —ni puede ser— una partida en tránsito"
      )
    }
  }
  if (failures.length > 0) return failed("I-E7-12", failures.join(" · "))
  if (warnings.length > 0) return warn("I-E7-12", warnings.join(" · "))
  if (evaluated.length === 0) {
    return info("I-E7-12", `sin tasa de cierre no se puede medir la diferencia de cambio de ${foreign.map((a) => a.accountCode).join(", ")}`)
  }
  return pass("I-E7-12", `${evaluated.join(", ")} cuadran en su divisa y sin diferencia de cambio pendiente`)
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E7-13 — ignorados acotados
// ─────────────────────────────────────────────────────────────────────────────

const VALID_IGNORE_REASONS: readonly IgnoreReason[] = [
  "ERROR_BANCO_REVERSADO",
  "NO_ES_NUESTRA_CUENTA",
  "YA_CONTABILIZADO_EN_OTRA_CUENTA",
  "IMPORTE_CERO",
]

export function checkIE713(input: BankInvariantInput): CheckResult {
  const ignored = input.lines.filter((l) => l.status === "IGNORED")
  if (ignored.length === 0) return info("I-E7-13", "no hay líneas de extracto ignoradas")
  const failures: string[] = []
  for (const line of ignored) {
    const reason = line.ignoreReason ?? null
    if (reason === null || !VALID_IGNORE_REASONS.includes(reason)) {
      failures.push(`la línea ${line.id} está IGNORED con motivo «${String(reason)}», fuera del vocabulario cerrado`)
      continue
    }
    if (IGNORE_REASONS_WITH_EVIDENCE.includes(reason) && (line.ignoreEvidenceId ?? "") === "") {
      failures.push(`la línea ${line.id} está IGNORED con ${reason} y sin la evidencia que lo respalda`)
    }
  }
  if (failures.length > 0) return failed("I-E7-13", failures.join(" · "))

  const warnings: string[] = []
  const cero = ignored.filter((l) => l.ignoreReason === "IMPORTE_CERO")
  for (const account of input.accounts) {
    const own = ignored.filter((l) => l.bankAccountId === account.id && l.ignoreReason !== "IMPORTE_CERO")
    const total = sum(own.map((l) => l.amountCents))
    const threshold = account.ignoredMaterialityCents
    if (threshold !== undefined && Math.abs(total) > threshold) {
      warnings.push(
        `${account.accountCode}: Σ ignorado ${eur(total)} supera el umbral de materialidad ${eur(threshold)} — ` +
          own.map((l) => `${l.operationDate} ${eur(l.amountCents)} (${l.ignoreReason})`).join(", ")
      )
    }
  }
  const total = sum(ignored.filter((l) => l.ignoreReason !== "IMPORTE_CERO").map((l) => l.amountCents))
  const detalle = `${ignored.length} línea(s) ignorada(s), Σ ${eur(total)} · ${cero.length} de importe cero (suman 0 por definición)`
  return warnings.length > 0 ? warn("I-E7-13", `${detalle} · ${warnings.join(" · ")}`) : pass("I-E7-13", detalle)
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E7-14…17 — los cuadres de cierre (O-18)
// ─────────────────────────────────────────────────────────────────────────────

const balancesByAccount = (lines: readonly ReportLine[], filter: (l: ReportLine) => boolean): Map<string, Cents> => {
  const map = new Map<string, Cents>()
  for (const line of lines) {
    if (!filter(line)) continue
    map.set(line.accountCode, (map.get(line.accountCode) ?? 0) + line.debitCents - line.creditCents)
  }
  return map
}

/** I-E7-14 · continuidad entre ejercicios (art. 25 CCom). */
export function checkIE714(input: ClosingInvariantInput): CheckResult {
  const years = [...input.fiscalYears].sort((a, b) => (a.startDate < b.startDate ? -1 : 1))
  if (years.length < 2) return info("I-E7-14", "hace falta más de un ejercicio para comprobar la continuidad")
  const failures: string[] = []
  let checked = 0
  const sinApertura: string[] = []

  for (let i = 1; i < years.length; i++) {
    const previous = years[i - 1] as (typeof years)[number]
    const current = years[i] as (typeof years)[number]
    const opening = balancesByAccount(input.lines, (l) => l.fiscalYearId === current.id && l.entryKind === "OPENING")
    if (opening.size === 0) {
      sinApertura.push(current.id)
      continue
    }
    checked += 1
    const closing = balancesByAccount(input.lines, (l) => l.fiscalYearId === previous.id && l.entryKind !== "CLOSING")
    for (const code of [...new Set([...opening.keys(), ...closing.keys()])].sort()) {
      const from = closing.get(code) ?? 0
      const to = opening.get(code) ?? 0
      if (from !== to) {
        failures.push(
          `${code}: cierre de ${previous.id} ${eur(from)} ≠ apertura de ${current.id} ${eur(to)} · diferencia ${eur(to - from)}`
        )
      }
    }
  }
  if (failures.length > 0) return failed("I-E7-14", failures.join(" · "))
  if (checked === 0) return info("I-E7-14", `ningún ejercicio con asiento de apertura: ${sinApertura.join(", ")}`)
  return pass("I-E7-14", `${checked} apertura(s) cuadran cuenta a cuenta con el cierre del ejercicio anterior`)
}

/** Saldos contrarios a su naturaleza (I-E7-15), generalizando R-B6 de E6. */
const CONTRARY: readonly { prefix: string; expect: "DEUDOR" | "ACREEDOR"; label: string }[] = [
  { prefix: "430", expect: "DEUDOR", label: "clientes con saldo acreedor" },
  { prefix: "400", expect: "ACREEDOR", label: "proveedores con saldo deudor" },
  { prefix: "410", expect: "ACREEDOR", label: "acreedores con saldo deudor" },
  { prefix: "473", expect: "DEUDOR", label: "retenciones y pagos a cuenta con saldo acreedor" },
  { prefix: "572", expect: "DEUDOR", label: "banco con saldo acreedor (descubierto sin póliza declarada)" },
]

export function checkIE715(input: ClosingInvariantInput): CheckResult {
  const balances = balancesByAccount(input.lines, (l) => l.entryDate <= input.to && l.entryKind !== "CLOSING")
  if (balances.size === 0) return info("I-E7-15", "no hay saldos en el periodo")
  const facilities = new Set(input.accountsWithCreditFacility ?? [])
  const findings: string[] = []
  for (const [code, cents] of [...balances.entries()].sort()) {
    if (cents === 0) continue
    for (const rule of CONTRARY) {
      if (!isUnderAccount(code, rule.prefix)) continue
      if (rule.prefix === "572" && [...facilities].some((f) => isUnderAccount(code, f))) continue
      const contrary = rule.expect === "DEUDOR" ? cents < 0 : cents > 0
      if (contrary) findings.push(`${code} ${eur(cents)} — ${rule.label}`)
    }
  }
  return findings.length === 0
    ? pass("I-E7-15", `${balances.size} cuenta(s) sin saldo contrario a su naturaleza a ${input.to}`)
    : warn("I-E7-15", `${findings.length} saldo(s) contrarios a su naturaleza: ${findings.join(" · ")}`)
}

/** Cuentas puente con saldo (I-E7-16). `555` al cierre es un hallazgo. */
export const BRIDGE_ACCOUNTS: readonly string[] = ["555", "551", "4749"]

export function checkIE716(input: ClosingInvariantInput): CheckResult {
  const balances = balancesByAccount(input.lines, (l) => l.entryDate <= input.to && l.entryKind !== "CLOSING")
  const findings: string[] = []
  for (const [code, cents] of [...balances.entries()].sort()) {
    if (cents === 0) continue
    if (BRIDGE_ACCOUNTS.some((prefix) => isUnderAccount(code, prefix))) findings.push(`${code} ${eur(cents)}`)
  }
  if (findings.length === 0) {
    return pass("I-E7-16", `las cuentas puente (${BRIDGE_ACCOUNTS.join(", ")}) están a cero a ${input.to}`)
  }
  const message = `cuentas puente con saldo a ${input.to}: ${findings.join(" · ")}`
  return input.isFiscalYearEnd === true
    ? failed("I-E7-16", `${message} — a fecha de cierre es un hallazgo, no un aviso`)
    : warn("I-E7-16", message)
}

/** Sumas y saldos: Σdebe = Σhaber del periodo **y mes a mes** (art. 28.1 CCom). */
export function checkIE717(input: ClosingInvariantInput): CheckResult {
  const scoped = input.lines.filter((l) => l.entryDate >= input.from && l.entryDate <= input.to)
  if (scoped.length === 0) return info("I-E7-17", `no hay líneas en el periodo ${input.from}…${input.to}`)
  const byMonth = new Map<string, { debit: Cents; credit: Cents }>()
  let debit = 0
  let credit = 0
  for (const line of scoped) {
    debit += line.debitCents
    credit += line.creditCents
    const key = `${line.entryDate.slice(0, 4)}-${String(monthOf(line.entryDate)).padStart(2, "0")}`
    const acc = byMonth.get(key) ?? { debit: 0, credit: 0 }
    byMonth.set(key, { debit: acc.debit + line.debitCents, credit: acc.credit + line.creditCents })
  }
  const failures: string[] = []
  if (debit !== credit) failures.push(`periodo: Σdebe ${eur(debit)} ≠ Σhaber ${eur(credit)} · diferencia ${eur(debit - credit)}`)
  for (const [month, totals] of [...byMonth.entries()].sort()) {
    if (totals.debit !== totals.credit) {
      failures.push(`${month}: Σdebe ${eur(totals.debit)} ≠ Σhaber ${eur(totals.credit)} · diferencia ${eur(totals.debit - totals.credit)}`)
    }
  }
  return failures.length === 0
    ? pass(
        "I-E7-17",
        `Σdebe = Σhaber = ${eur(debit)} en el periodo y en los ${byMonth.size} mes(es) que lo componen`
      )
    : failed("I-E7-17", failures.join(" · "))
}

// ─────────────────────────────────────────────────────────────────────────────
// Ejecución del bloque
// ─────────────────────────────────────────────────────────────────────────────

/** Los ids del bloque, en orden. Los usa el borde para declarar INFO en masa. */
export const E7_INVARIANT_IDS: readonly string[] = [
  "I-E7-1",
  "I-E7-2",
  "I-E7-3",
  "I-E7-5",
  "I-E7-6a",
  "I-E7-6b",
  "I-E7-7",
  "I-E7-8",
  "I-E7-9",
  "I-E7-10",
  "I-E7-11",
  "I-E7-12",
  "I-E7-13",
  "I-E7-14",
  "I-E7-15",
  "I-E7-16",
  "I-E7-17",
]

const skipped = (id: string, reason: string): CheckResult => info(id, `no evaluado: ${reason}`)

/**
 * Corre el bloque completo. Cada sub-bloque ausente sale **INFO diciendo qué
 * falta**, nunca PASS y nunca FAIL: una organización que aún no ha dado de alta
 * una cuenta bancaria no tiene por qué ver un fallo por no tenerla.
 */
export function runAuditInvariants(input: AuditInvariantInput): CheckResult[] {
  const bank = input.bank
  const closing = input.closing
  return [
    ...(bank
      ? [checkIE71(bank), checkIE72(bank), checkIE73(bank), checkIE75(bank), checkIE76a(bank), checkIE76b(bank)]
      : ["I-E7-1", "I-E7-2", "I-E7-3", "I-E7-5", "I-E7-6a", "I-E7-6b"].map((id) =>
          skipped(id, "el llamante no aporta el bloque de conciliación bancaria")
        )),
    input.runs ? checkIE77(input.runs) : skipped("I-E7-7", "el llamante no aporta los barridos anteriores"),
    input.store ? checkIE78(input.store) : skipped("I-E7-8", "el llamante no aporta el estado del almacén"),
    input.allocationRuns ? checkIE79(input.allocationRuns) : skipped("I-E7-9", "el llamante no aporta las liquidaciones"),
    input.reportRuns && input.allocationRuns
      ? checkIE710(input.reportRuns, input.allocationRuns)
      : skipped("I-E7-10", "el llamante no aporta los informes vigentes y sus liquidaciones"),
    ...(bank
      ? [checkIE711(bank), checkIE712(bank), checkIE713(bank)]
      : ["I-E7-11", "I-E7-12", "I-E7-13"].map((id) => skipped(id, "el llamante no aporta el bloque de conciliación bancaria"))),
    ...(closing
      ? [checkIE714(closing), checkIE715(closing), checkIE716(closing), checkIE717(closing)]
      : ["I-E7-14", "I-E7-15", "I-E7-16", "I-E7-17"].map((id) =>
          skipped(id, "el llamante no aporta las líneas del diario del periodo")
        )),
  ]
}
