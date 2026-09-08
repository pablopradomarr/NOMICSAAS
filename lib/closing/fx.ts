/**
 * E9 · T9 — Diferencias de cambio al cierre
 * (`docs/design/E9-cierre-recurrentes.md` §4.6, **R-FX-1…6**; ADR-0016 **D6**;
 * observaciones **O-4** y **O-5** de la validación contable).
 *
 * **E7 mide (I-E7-12) y E9 reconoce (NRV 11ª.2.2).** `readFxCloses` de E7 pasa a
 * ser el caso particular «cuentas 57x» de `readFxPositions` (T12, agente B3).
 *
 * Módulo **PURO**: sin `Date.now()`, sin Prisma, sin IO. Las posiciones, las
 * tasas publicadas y la fecha de corte entran por parámetro.
 *
 * ## Las cinco decisiones que gobiernan este fichero
 *
 * 1. **`Δ = convertWithRateMicro(D, r) − S`, y nada más** (R-FX-1). Lo ya
 *    reconocido en 668/768 **está dentro de `S`**, porque el asiento que lo
 *    reconoció mueve la propia cuenta; restarlo otra vez fue el hallazgo **N-1**
 *    de E7 y duplicaba la diferencia.
 * 2. **(O-4) Sólo partidas monetarias**: el universo es
 *    `LedgerAccount.isMonetary = true`, un atributo del **plan**, no una lista en
 *    el motor. `original_currency IS NOT NULL` a secas arrastraba `407` y `438`
 *    —anticipos: no dan derecho a recibir ni obligan a entregar un importe fijo
 *    de efectivo, sino un bien o un servicio— e **inventaba resultado**.
 *    **I-E9-24.**
 * 3. **El signo se resuelve solo**, sin distinguir activo de pasivo (R-FX-3):
 *    `Δ > 0` ⇒ `cuenta (D) / 768 (H)`; `Δ < 0` ⇒ `668 (D) / cuenta (H)`.
 *    *(400 en USD con `D = −500 000`, `S = −460 000`, `r = 0,90` ⇒ `Δ = +10 000`
 *    ⇒ `400 (D) 10 000 / 768 (H) 10 000`: la deuda en euros baja, y eso es un
 *    beneficio.)*
 * 4. **La línea que mueve la partida lleva `originalAmountCents = 0`** (R-FX-4):
 *    en la moneda de la cuenta no se mueve nada, y E7 (ronda 2) ya decidió que un
 *    apunte así **no es una partida en tránsito**. **I-E9-18.**
 * 5. **(O-5) Tasa de cierre = la de mayor `rateDate ≤ corte`** dentro de una
 *    **ventana declarada** (7 días naturales por defecto), con la `rateDate`
 *    efectiva **sellada y visible**; FAIL sólo si no existe ninguna. El BCE
 *    publica los días hábiles TARGET: exigir `rateDate = corte` dejaba el
 *    producto sin poder cerrar los ejercicios cuyo 31 de diciembre cae en fin de
 *    semana (2028, 2033…), que es el único día en que se usa.
 *
 * **668/768 son `FINANCIERO`, nivel BAI, CECO `CC-FIN`. Nunca 669/769**, que es
 * residuo de tesorería (`lib/fx/convert.ts` ya lo dice).
 *
 * Tras **T-30**, I-E7-12 sale PASS para todas las cuentas y el motivo
 * `DIFERENCIA_DE_CAMBIO_SIN_RECONOCER` desaparece.
 */

import { convertWithRateMicro } from "@/lib/money"
import { toEpochDay } from "@/lib/recurring/schedule"
import type { AccountKey, Cents, DraftLine, LocalDate } from "@/lib/ledger/types"
import type { ClosingStepResult } from "@/lib/closing/vat"

// ─────────────────────────────────────────────────────────────────────────────
// Códigos de plantilla (T10 · agente B1). Constantes documentadas, no imports.
// ─────────────────────────────────────────────────────────────────────────────

/** **T-30** `DIFERENCIAS_CAMBIO_CIERRE`. El valor es el `TemplateCode`, no el ordinal. */
export const TEMPLATE_DIFERENCIAS_CAMBIO = "DIFERENCIAS_CAMBIO_CIERRE"

/** Ventana por defecto para la tasa de cierre, en días naturales (O-5). */
export const FX_RATE_WINDOW_DAYS = 7

/**
 * Cuentas que llevan divisa y **no** son monetarias: el ejemplo canónico de O-4.
 * **No es la lista del motor** —el universo es `isMonetary` del plan— sino la
 * evidencia que la pantalla enseña cuando alguien pregunta por qué un anticipo
 * en dólares no genera diferencia de cambio.
 */
export const NON_MONETARY_EXAMPLES: readonly string[] = ["407", "438", "480", "485"]

// ─────────────────────────────────────────────────────────────────────────────
// Tipos planos
// ─────────────────────────────────────────────────────────────────────────────

export type FxPosition = {
  accountCode: string
  counterpartyId: string | null
  currency: string
  /** `S` = Σ(debe − haber) en **moneda base**, con signo. */
  baseBalanceCents: Cents
  /** `D` = Σ(debe − haber) en **divisa**, con signo. */
  currencyBalanceCents: Cents
  /**
   * **(O-4)** `LedgerAccount.isMonetary`. Lo aporta quien lee el plan (T12);
   * el motor **no** deduce la monetariedad de un prefijo de cuenta.
   */
  isMonetary: boolean
  reference?: string | null
}

/** Tasa publicada: 1 unidad de divisa = `rateMicro / 1e6` de la moneda base. */
export type ClosingRate = {
  currency: string
  rateMicro: bigint
  rateDate: LocalDate
}

export type FxAdjustment = {
  accountCode: string
  counterpartyId: string | null
  currency: string
  baseBalanceCents: Cents
  currencyBalanceCents: Cents
  /** Tasa efectivamente aplicada, **sellada en el asiento** (O-5). */
  rateMicro: bigint
  rateDate: LocalDate
  /** `Δ = D × r − S`. Positivo = beneficio (768); negativo = pérdida (668). */
  deltaCents: Cents
}

export type FxResult = {
  lines: DraftLine[]
  byPosition: FxAdjustment[]
  /** Divisas con posición viva y **sin tasa** en la ventana: el paso no avanza. */
  missingRates: string[]
  /** Tasa efectiva por divisa, para enseñarla en pantalla. */
  usedRates: { currency: string; rateMicro: bigint; rateDate: LocalDate }[]
  /** Posiciones **no monetarias** excluidas del barrido (evidencia de I-E9-24). */
  excludedNonMonetary: FxPosition[]
  /** Ventana aplicada, en días naturales. */
  windowDays: number
}

// ─────────────────────────────────────────────────────────────────────────────
// R-FX-5 (O-5) · la tasa de cierre efectiva
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **R-FX-5.** Tasa de cierre de una divisa: la de **mayor `rateDate ≤ cutoff`**,
 * siempre que caiga dentro de la ventana (`cutoff − windowDays`). Nunca se
 * interpola, nunca se toma una posterior al corte y nunca se inventa: si no hay
 * ninguna publicada en la ventana, se devuelve `null` y el paso **falla con
 * evidencia**.
 */
export function closingRateFor(
  rates: readonly ClosingRate[],
  currency: string,
  cutoff: LocalDate,
  windowDays = FX_RATE_WINDOW_DAYS
): ClosingRate | null {
  const target = currency.toUpperCase()
  const floor = toEpochDay(cutoff) - windowDays
  const candidates = rates.filter(
    (r) => r.currency.toUpperCase() === target && r.rateDate <= cutoff && toEpochDay(r.rateDate) >= floor
  )
  if (candidates.length === 0) return null
  return candidates.reduce((best, r) => (r.rateDate > best.rateDate ? r : best))
}

// ─────────────────────────────────────────────────────────────────────────────
// R-FX-1…4 · el asiento (T-30)
// ─────────────────────────────────────────────────────────────────────────────

const DIFERENCIA_NEGATIVA: AccountKey = "DIFERENCIA_CAMBIO_NEGATIVA" // 668
const DIFERENCIA_POSITIVA: AccountKey = "DIFERENCIA_CAMBIO_POSITIVA" // 768

const positionKey = (p: FxPosition): string => `${p.accountCode} ${p.counterpartyId ?? ""} ${p.currency.toUpperCase()}`

/**
 * **R-FX-1…6.** Ajuste de las posiciones **monetarias** en divisa a la tasa de
 * cierre. Devuelve las líneas de **T-30**, el detalle por posición, las divisas
 * sin tasa y las posiciones excluidas por no ser monetarias.
 *
 * Las líneas que mueven la partida llevan `originalCurrency` y
 * **`originalAmountCents = 0`** (R-FX-4, I-E9-18); las de 668/768 se **agregan
 * en una sola** por lado, sin divisa: el resultado del ejercicio está en moneda
 * base.
 */
export function fxClosingAdjustments(
  positions: readonly FxPosition[],
  rates: readonly ClosingRate[],
  cutoff: LocalDate,
  windowDays = FX_RATE_WINDOW_DAYS
): FxResult {
  const excludedNonMonetary = positions.filter((p) => !p.isMonetary)
  const universe = [...positions.filter((p) => p.isMonetary)].sort((a, b) =>
    positionKey(a) < positionKey(b) ? -1 : positionKey(a) > positionKey(b) ? 1 : 0
  )

  const byPosition: FxAdjustment[] = []
  const missing = new Set<string>()
  const used = new Map<string, ClosingRate>()

  for (const position of universe) {
    const currency = position.currency.toUpperCase()
    const rate = closingRateFor(rates, currency, cutoff, windowDays)
    if (!rate) {
      missing.add(currency)
      continue
    }
    used.set(currency, rate)
    // N-1 de E7: lo ya reconocido en 668/768 YA está en `S`. No se resta.
    const deltaCents = convertWithRateMicro(position.currencyBalanceCents, rate.rateMicro) - position.baseBalanceCents
    byPosition.push({
      accountCode: position.accountCode,
      counterpartyId: position.counterpartyId,
      currency,
      baseBalanceCents: position.baseBalanceCents,
      currencyBalanceCents: position.currencyBalanceCents,
      rateMicro: rate.rateMicro,
      rateDate: rate.rateDate,
      deltaCents,
    })
  }

  return {
    lines: fxLines(byPosition),
    byPosition,
    missingRates: [...missing].sort(),
    usedRates: [...used.values()]
      .map((r) => ({ currency: r.currency.toUpperCase(), rateMicro: r.rateMicro, rateDate: r.rateDate }))
      .sort((a, b) => (a.currency < b.currency ? -1 : 1)),
    excludedNonMonetary,
    windowDays,
  }
}

/**
 * Líneas de **T-30**. Una línea por posición con diferencia distinta de cero
 * —`originalAmountCents = 0`, R-FX-4— y **una sola** contrapartida agregada a
 * `768` (beneficio) y otra a `668` (pérdida), ambas `FINANCIERO`.
 */
export function fxLines(adjustments: readonly FxAdjustment[]): DraftLine[] {
  const moving = adjustments.filter((a) => a.deltaCents !== 0)
  if (moving.length === 0) return []

  const lines: DraftLine[] = []
  let lineNo = 1
  let gainCents = 0
  let lossCents = 0

  for (const adjustment of moving) {
    const amount = Math.abs(adjustment.deltaCents)
    const common = {
      counterpartyId: adjustment.counterpartyId,
      originalCurrency: adjustment.currency,
      // R-FX-4: en la moneda de la cuenta no se mueve NADA.
      originalAmountCents: 0,
      analyticType: "NO_ANALITICO" as const,
      description: `Diferencia de cambio al cierre ${adjustment.currency} @ ${adjustment.rateDate}`,
    }
    if (adjustment.deltaCents > 0) {
      gainCents += amount
      lines.push({ lineNo: lineNo++, accountCode: adjustment.accountCode, debitCents: amount, creditCents: 0, ...common })
    } else {
      lossCents += amount
      lines.push({ lineNo: lineNo++, accountCode: adjustment.accountCode, debitCents: 0, creditCents: amount, ...common })
    }
  }

  if (lossCents > 0) {
    lines.push({
      lineNo: lineNo++,
      accountKey: DIFERENCIA_NEGATIVA,
      debitCents: lossCents,
      creditCents: 0,
      analyticType: "FINANCIERO",
      description: "Diferencias negativas de cambio (NRV 11ª.2.2)",
    })
  }
  if (gainCents > 0) {
    lines.push({
      lineNo: lineNo++,
      accountKey: DIFERENCIA_POSITIVA,
      debitCents: 0,
      creditCents: gainCents,
      analyticType: "FINANCIERO",
      description: "Diferencias positivas de cambio (NRV 11ª.2.2)",
    })
  }
  return lines
}

// ─────────────────────────────────────────────────────────────────────────────
// El paso del checklist (uno de los nueve bloqueantes)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **`DIFERENCIAS_DE_CAMBIO`.** Bloqueante: sin tasa de cierre dentro de la
 * ventana el paso **no avanza**, y la evidencia dice qué divisa falta y desde
 * qué fecha se ha buscado (O-5). Con tasa, el PASS enseña **cuál** se ha usado:
 * «tipo de cambio de cierre» es el **vigente**, y el vigente un domingo es el
 * último publicado.
 */
export function fxStep(result: FxResult, cutoff: LocalDate): ClosingStepResult {
  const step = "DIFERENCIAS_DE_CAMBIO"
  const block = "Valoración"
  const query =
    "SELECT l.account_code, l.original_currency, sum(l.debit_cents - l.credit_cents) AS base, " +
    "sum(CASE WHEN l.debit_cents > 0 THEN l.original_amount_cents ELSE -l.original_amount_cents END) AS divisa " +
    "FROM journal_lines l JOIN accounts a ON a.organization_id = l.organization_id AND a.code = l.account_code " +
    "WHERE l.organization_id = $1 AND l.original_currency IS NOT NULL AND a.is_monetary GROUP BY 1, 2"

  if (result.missingRates.length > 0) {
    return {
      step,
      block,
      status: "FAIL",
      blocking: true,
      evidencia:
        `Sin tipo de cambio publicado para ${result.missingRates.join(", ")} en los ${result.windowDays} día(s) ` +
        `naturales anteriores a ${cutoff}: la valoración al cierre (NRV 11ª.2.2) no se puede reconocer sin inventar una tasa`,
      sealReason: "DIFERENCIA_DE_CAMBIO_SIN_RECONOCER",
      query,
    }
  }
  if (result.byPosition.length === 0) {
    return {
      step,
      block,
      status: "PASS",
      blocking: true,
      evidencia:
        "Ninguna posición monetaria en divisa a la fecha de cierre" +
        (result.excludedNonMonetary.length > 0
          ? ` (${result.excludedNonMonetary.length} posición(es) en divisa excluida(s) por no ser monetarias, O-4)`
          : ""),
      query,
    }
  }
  const conDiferencia = result.byPosition.filter((a) => a.deltaCents !== 0)
  return {
    step,
    block,
    status: "PASS",
    blocking: true,
    evidencia:
      `${result.byPosition.length} posición(es) monetaria(s) valorada(s) a ` +
      result.usedRates.map((r) => `${r.currency} @ ${r.rateDate}`).join(", ") +
      `; ${conDiferencia.length} con diferencia (Σ ${conDiferencia.reduce((a, b) => a + b.deltaCents, 0)} c)` +
      (result.excludedNonMonetary.length > 0
        ? `; ${result.excludedNonMonetary.length} excluida(s) por no monetaria(s) (O-4)`
        : ""),
    query,
  }
}
