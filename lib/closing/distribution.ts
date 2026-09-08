/**
 * E9 · T14 — Distribución del resultado (`lib/closing/distribution.ts`).
 *
 * Implementa **O-18** y **R2-2** de `docs/design/E9-cierre-recurrentes.md` §4.9
 * y la decisión **D10** de ADR-0016. Es **T-35**: el asiento que la junta
 * general acuerda (art. 164 LSC) y que se postea en el ejercicio **abierto**,
 * con la fecha de la junta.
 *
 * Módulo **PURO**: sin `Date.now()`, sin Prisma, sin IO, sin LLM. Toda fecha y
 * todo saldo entran por parámetro.
 *
 * ## Por qué existe
 *
 * Sin distribución, `129` se arrastra indefinidamente, el balance muestra
 * «Resultado del ejercicio» de un año que ya pasó, **la reserva legal nunca se
 * dota** (art. 274 LSC) y el dividendo nunca se registra: el patrimonio neto es
 * incorrecto **desde el segundo ejercicio**. Es una omisión de ciclo, no un
 * detalle.
 *
 * ## El asiento (beneficio)
 *
 * ```
 * 129 (D) resultado
 *        112 (H) reserva legal      ← CALCULADA, art. 274 LSC
 *        113 (H) reservas voluntarias
 *        120 (H) remanente
 *        526 (H) dividendo activo a pagar
 *        557 (H) dividendo a cuenta ya satisfecho   ← se CANCELA (era deudora)
 * ```
 *
 * En pérdidas: `121 (D) / 129 (H)`.
 *
 * ## R2-2 · el capital sale del DIARIO
 *
 * El capital social es el **saldo acreedor de `100`** a la fecha de la junta.
 * Un capital almacenado en `Organization` diverge del diario en la primera
 * ampliación y sería una **cifra de balance almacenada**, contra ADR-0003.
 * `capitalStockOverrideCents` queda **sólo como contingencia** (plan sin `100`
 * postable, capital en subcuentas no derivables): al usarlo, la reserva legal se
 * calcula igual pero el paso `DISTRIBUCION_RESULTADO` sale **WARN** con motivo
 * `CAPITAL_SOCIAL_DECLARADO` y la evidencia enseña **las dos cifras**.
 */

import type { CheckResult } from "@/lib/ledger/invariants-types"
import type { Cents, DraftLine, LocalDate, Result } from "@/lib/ledger/types"
import { err, fail, ok } from "@/lib/ledger/types"

// ─────────────────────────────────────────────────────────────────────────────
// Constantes de la LSC. Enteras, en puntos básicos: sin coma flotante.
// ─────────────────────────────────────────────────────────────────────────────

/** Art. 274.1 LSC: el 10 % del beneficio del ejercicio. */
export const LEGAL_RESERVE_RATE_BPS = 1000
/** Art. 274.1 LSC: hasta que la reserva legal alcance el 20 % del capital. */
export const LEGAL_RESERVE_CAP_BPS = 2000

/** Motivo de sello cuando el capital no se deriva del diario (R2-2). */
export const CAPITAL_SOCIAL_DECLARADO = "CAPITAL_SOCIAL_DECLARADO"

/** Prefijo de la cuenta de capital social del PGC. */
export const CAPITAL_ACCOUNT_PREFIX = "100"

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **R2-2.** El capital sale del DIARIO: saldo acreedor de `100` a la fecha de la
 * junta. `source` viaja con él y `DECLARADO` deja el paso en WARN — nunca se
 * teclea una cifra de balance (ADR-0003).
 */
export type CapitalStock = {
  cents: Cents
  source: "DIARIO" | "DECLARADO"
  /** La cuenta de la que se derivó, o `null` si vino declarada. */
  accountCode: string | null
}

/** Las cuentas del reparto, del plan de la organización. Nunca hardcodeadas. */
export type DistributionAccounts = {
  /** `129` — resultado del ejercicio. */
  resultAccountCode: string
  /** `112` — reserva legal. */
  legalReserveAccountCode: string
  /** `113` — reservas voluntarias. */
  voluntaryReserveAccountCode: string
  /** `120` — remanente. */
  carryForwardAccountCode: string
  /** `526` — dividendo activo a pagar. */
  dividendAccountCode: string
  /** `557` — dividendo activo a cuenta (deudora, ya satisfecha). */
  interimDividendAccountCode: string
  /** `121` — resultados negativos de ejercicios anteriores. */
  lossCarryForwardAccountCode: string
}

/** Lo que la junta acuerda, más lo que el motor calcula. */
export type ProfitDistributionInput = {
  /** Saldo de `129` regularizado: **positivo** beneficio, **negativo** pérdida. */
  resultCents: Cents
  meetingDate: LocalDate
  capital: CapitalStock
  /** Saldo acreedor actual de `112` antes de esta distribución. */
  currentLegalReserveCents: Cents
  /** Dividendo a cuenta ya satisfecho (saldo **deudor** de `557`), ≥ 0. */
  interimDividendCents: Cents
  /** Acordado por la junta. */
  voluntaryReserveCents: Cents
  carryForwardCents: Cents
  dividendCents: Cents
  accounts: DistributionAccounts
  fiscalYearCode?: string
}

/** El reparto ya resuelto: lo que se persiste en `ProfitDistribution`. */
export type ProfitDistributionPlan = {
  resultCents: Cents
  legalReserveCents: Cents
  voluntaryReserveCents: Cents
  carryForwardCents: Cents
  dividendCents: Cents
  interimDividendCents: Cents
  lossCarryForwardCents: Cents
}

// ─────────────────────────────────────────────────────────────────────────────
// Aritmética entera
// ─────────────────────────────────────────────────────────────────────────────

/** `a × bps / 10000` truncado **hacia cero**, en `BigInt`: sin coma flotante. */
export function mulBpsTrunc(a: Cents, bps: number): Cents {
  return Number((BigInt(a) * BigInt(bps)) / BigInt(10000))
}

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n)

// ─────────────────────────────────────────────────────────────────────────────
// R-DI-1 · el capital, derivado del diario
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **R-DI-1 (R2-2).** Capital social = **saldo acreedor de `100`** a la fecha de
 * la junta, sumando todas sus subcuentas. `balances` viene del diario con el
 * signo natural de una cuenta de patrimonio: **haber − debe**.
 *
 * El `override` es contingencia y **sólo se usa si no hay saldo derivable**: un
 * plan sin `100` postable o una sociedad con el capital en subcuentas que el
 * agregado no alcanza. Cuando se usa, `source = "DECLARADO"` y el paso sale
 * WARN. Si hay saldo en el diario, el diario **gana**: una cifra almacenada no
 * puede pisar al libro (ADR-0003).
 */
export function capitalStockOf(balances: ReadonlyMap<string, Cents>, override: Cents | null): CapitalStock {
  let cents = 0
  let accountCode: string | null = null
  for (const [code, balance] of [...balances.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!code.startsWith(CAPITAL_ACCOUNT_PREFIX)) continue
    cents += balance
    if (accountCode === null) accountCode = code
  }
  if (cents > 0) return { cents, source: "DIARIO", accountCode }
  if (override !== null && override > 0) return { cents: override, source: "DECLARADO", accountCode: null }
  return { cents: 0, source: "DIARIO", accountCode }
}

/**
 * **R-DI-2 · art. 274 LSC.** `min(10 % del beneficio, 20 % del capital − saldo
 * actual de 112)`, nunca negativa. Obligatoria y **calculada**: no es una
 * propuesta y no es editable a la baja.
 *
 * Con pérdida no se dota nada. Con la reserva ya al 20 % del capital, tampoco:
 * el tope es del capital, no del beneficio.
 */
export function legalReserveCents(input: {
  profitCents: Cents
  capital: CapitalStock
  currentReserveCents: Cents
}): Cents {
  if (input.profitCents <= 0) return 0
  const tenPercent = mulBpsTrunc(input.profitCents, LEGAL_RESERVE_RATE_BPS)
  const cap = mulBpsTrunc(input.capital.cents, LEGAL_RESERVE_CAP_BPS) - input.currentReserveCents
  if (cap <= 0) return 0
  return Math.min(tenPercent, cap)
}

/**
 * El paso del checklist. **R2-2**: con capital `DECLARADO` sale **WARN** con
 * `CAPITAL_SOCIAL_DECLARADO` y las dos cifras a la vista; sin capital derivable
 * ni declarado, `INFO` — nunca un PASS que no se haya comprobado.
 */
export function capitalStockCheck(capital: CapitalStock, override: Cents | null): CheckResult {
  if (capital.source === "DECLARADO") {
    return {
      id: "DISTRIBUCION_RESULTADO",
      status: "WARN",
      evidencia:
        `Capital social DECLARADO ${capital.cents} c (${CAPITAL_SOCIAL_DECLARADO}): el plan no tiene saldo ` +
        `acreedor derivable en ${CAPITAL_ACCOUNT_PREFIX}. Saldo derivado del diario: 0 c. ` +
        "La reserva legal se calcula igual, pero la cifra no procede del libro (ADR-0003).",
      query: `SELECT sum(credit_cents - debit_cents) FROM journal_lines WHERE account_code LIKE '${CAPITAL_ACCOUNT_PREFIX}%'`,
    }
  }
  if (capital.cents <= 0) {
    return {
      id: "DISTRIBUCION_RESULTADO",
      status: "INFO",
      evidencia:
        `Sin saldo acreedor en ${CAPITAL_ACCOUNT_PREFIX} a la fecha de la junta y sin capital declarado: ` +
        "el tope del art. 274 LSC no es computable y la reserva legal no puede calcularse.",
    }
  }
  return {
    id: "DISTRIBUCION_RESULTADO",
    status: "PASS",
    evidencia:
      `Capital social ${capital.cents} c derivado del saldo acreedor de ${capital.accountCode ?? CAPITAL_ACCOUNT_PREFIX} ` +
      `a la fecha de la junta${override !== null ? ` (hay un capital declarado de ${override} c que NO se usa: manda el diario)` : ""}.`,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// R-DI-3 · el plan de reparto
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **R-DI-3.** Resuelve el reparto completo: calcula la reserva legal, cancela el
 * dividendo a cuenta y lleva **lo no aplicado al remanente**, de modo que
 * `Σ destinos = resultado` con **tolerancia 0** (G-16, I-E9-23).
 *
 * Con pérdida, el único destino es `121` por el importe íntegro: la junta no
 * reparte lo que no hay (art. 273.2 LSC).
 */
export function distributionPlan(input: ProfitDistributionInput): Result<ProfitDistributionPlan> {
  for (const [field, value] of [
    ["resultCents", input.resultCents],
    ["currentLegalReserveCents", input.currentLegalReserveCents],
    ["interimDividendCents", input.interimDividendCents],
    ["voluntaryReserveCents", input.voluntaryReserveCents],
    ["carryForwardCents", input.carryForwardCents],
    ["dividendCents", input.dividendCents],
  ] as const) {
    if (!isInt(value)) {
      return fail(err("TEMPLATE_INPUT", field, `${field} debe ser un entero en céntimos`, { check: "R-DI-3" }))
    }
  }
  if (input.interimDividendCents < 0 || input.voluntaryReserveCents < 0 || input.carryForwardCents < 0 || input.dividendCents < 0) {
    return fail(err("LINE_NEGATIVE", "destinos", "Ningún destino de la distribución puede ser negativo", { check: "R-DI-3" }))
  }

  if (input.resultCents < 0) {
    if (input.voluntaryReserveCents + input.carryForwardCents + input.dividendCents > 0) {
      return fail(
        err("TEMPLATE_INPUT", "dividendCents", "Con pérdida no hay beneficio distribuible (art. 273 LSC): el destino es 121", {
          check: "R-DI-3",
        })
      )
    }
    return ok({
      resultCents: input.resultCents,
      legalReserveCents: 0,
      voluntaryReserveCents: 0,
      carryForwardCents: 0,
      dividendCents: 0,
      interimDividendCents: input.interimDividendCents,
      lossCarryForwardCents: -input.resultCents,
    })
  }

  if (input.resultCents === 0) {
    return fail(err("ZERO_LINE", "resultCents", "Un resultado de 0 no genera asiento de distribución", { check: "R-DI-3" }))
  }

  const legal = legalReserveCents({
    profitCents: input.resultCents,
    capital: input.capital,
    currentReserveCents: input.currentLegalReserveCents,
  })

  // El dividendo a cuenta ya satisfecho (`557`, deudora) se cancela contra el
  // resultado: consume beneficio distribuible aunque la junta no lo «acuerde»
  // hoy, porque ya se pagó durante el ejercicio.
  const applied = legal + input.interimDividendCents + input.voluntaryReserveCents + input.dividendCents + input.carryForwardCents
  if (applied > input.resultCents) {
    return fail(
      err(
        "TEMPLATE_INPUT",
        "destinos",
        `Los destinos suman ${applied} c y el resultado es ${input.resultCents} c: ` +
          `la reserva legal obligatoria son ${legal} c (art. 274 LSC) y el dividendo a cuenta ya satisfecho, ` +
          `${input.interimDividendCents} c`,
        { check: "R-DI-3" }
      )
    )
  }

  // Lo no aplicado va a remanente (`120`): el asiento cuadra con tolerancia 0 y
  // no queda saldo en `129` (I-E9-23).
  const remainder = input.resultCents - applied
  return ok({
    resultCents: input.resultCents,
    legalReserveCents: legal,
    voluntaryReserveCents: input.voluntaryReserveCents,
    carryForwardCents: input.carryForwardCents + remainder,
    dividendCents: input.dividendCents,
    interimDividendCents: input.interimDividendCents,
    lossCarryForwardCents: 0,
  })
}

/**
 * **T-35.** Las líneas del asiento de distribución. `129` al debe por el
 * beneficio y cada destino al haber; en pérdidas, `121 (D) / 129 (H)`.
 *
 * El `557` va al **haber**: era una cuenta deudora que minoró el patrimonio neto
 * durante el ejercicio y aquí se **cancela** contra el resultado. Es el error
 * clásico —dejarlo vivo— que duplica la minoración del PN.
 */
export function distributionLines(input: ProfitDistributionInput): Result<DraftLine[]> {
  const planned = distributionPlan(input)
  if (!planned.ok) return planned
  const plan = planned.value
  const a = input.accounts
  const label = input.fiscalYearCode ? ` del ejercicio ${input.fiscalYearCode}` : ""
  const lines: DraftLine[] = []
  let lineNo = 0
  const push = (accountCode: string, debitCents: Cents, creditCents: Cents, description: string) => {
    if (debitCents === 0 && creditCents === 0) return
    lines.push({ lineNo: ++lineNo, accountCode, debitCents, creditCents, description })
  }

  if (plan.resultCents < 0) {
    push(a.lossCarryForwardAccountCode, -plan.resultCents, 0, `Resultados negativos${label}`)
    push(a.resultAccountCode, 0, -plan.resultCents, `Aplicación de la pérdida${label} (art. 273 LSC)`)
    if (plan.interimDividendCents > 0) {
      return fail(
        err("TEMPLATE_INPUT", "interimDividendCents", "Un dividendo a cuenta con pérdida exige acuerdo expreso: no se automatiza", {
          check: "R-DI-3",
        })
      )
    }
    return ok(lines)
  }

  push(a.resultAccountCode, plan.resultCents, 0, `Distribución del resultado${label} (junta de ${input.meetingDate})`)
  push(a.legalReserveAccountCode, 0, plan.legalReserveCents, "Dotación a la reserva legal (art. 274 LSC)")
  push(a.voluntaryReserveAccountCode, 0, plan.voluntaryReserveCents, "Dotación a reservas voluntarias")
  push(a.carryForwardAccountCode, 0, plan.carryForwardCents, "Remanente")
  push(a.dividendAccountCode, 0, plan.dividendCents, "Dividendo activo a pagar")
  push(a.interimDividendAccountCode, 0, plan.interimDividendCents, "Cancelación del dividendo activo a cuenta ya satisfecho")
  return ok(lines)
}

/**
 * **I-E9-23 (parte pura).** `Σ destinos = resultado` con **tolerancia 0**. El
 * invariante completo —que ningún ejercicio `APROBADAS` conserve saldo en `129`—
 * lo evalúa `lib/closing/invariants-e9.ts` (T11) con el diario delante.
 */
export function checkDistributionBalances(plan: ProfitDistributionPlan): CheckResult {
  const destinos =
    plan.resultCents < 0
      ? plan.lossCarryForwardCents
      : plan.legalReserveCents +
        plan.voluntaryReserveCents +
        plan.carryForwardCents +
        plan.dividendCents +
        plan.interimDividendCents
  const esperado = Math.abs(plan.resultCents)
  return {
    id: "I-E9-23",
    status: destinos === esperado ? "PASS" : "FAIL",
    evidencia:
      destinos === esperado
        ? `Σ destinos ${destinos} c = resultado regularizado ${esperado} c (tolerancia 0)`
        : `Σ destinos ${destinos} c ≠ resultado regularizado ${esperado} c: diferencia ${destinos - esperado} c`,
  }
}
