/**
 * E9 · T9 — Valor actual del aplazamiento **como valoración inicial**
 * (`docs/design/E9-cierre-recurrentes.md` §4.7, **R-VA-1…6**; ADR-0016 **D7**;
 * observaciones **O-1**, **O-2** y **O-3** de la validación contable).
 *
 * **El defecto más caro de la ronda 0.** El descuento del aplazamiento **no es
 * un ajuste de cierre**: la NRV 2ª.1 dice que el precio de adquisición del
 * inmovilizado, *si el aplazamiento supera el año*, **es el valor actual**, y la
 * NRV 9ª.3.1 lo replica para el débito. El valor actual **es** el precio de
 * adquisición desde el primer día; reconocerlo meses después contra resultados
 * convierte un criterio de valoración obligatorio en un ajuste de periodo — y,
 * si el activo lleva diez meses amortizándose sobre el coste bruto, deja `28x`
 * por encima de la base amortizable y **I-E9-5 en FAIL**.
 *
 * Módulo **PURO**: sin `Date.now()`, sin Prisma, sin IO.
 *
 * ## Las seis decisiones que gobiernan este fichero
 *
 * 1. **El descuento se reconoce en el alta** (T-03 de E8). E9 aporta el **plan de
 *    corrección** de lo que no se hizo, en **tres casos** (R-VA-1):
 *    **A** alta del ejercicio en curso con las cuentas no formuladas —corrección
 *    dentro del ejercicio, con **recálculo del cuadro desde `inServiceDate`** y
 *    reversión de la amortización dotada en exceso—; **B** alta de un ejercicio
 *    **cerrado** —error de ejercicios anteriores, NRV 22ª, contra `113` por
 *    **T-22**—; **C** origen no inmovilizado —al gasto o ingreso original si es
 *    del mismo ejercicio, a `113` si es de uno cerrado—.
 * 2. **`AssetRevision` NO sirve para esto** (D7.2): una revisión es un **cambio
 *    de estimación** y es prospectiva; reconocer tarde un criterio de valoración
 *    obligatorio es la **corrección de un error**, que es retroactiva. Este
 *    módulo **no** emite revisiones: recalcula el cuadro con el coste corregido.
 * 3. **(O-2) El tipo se declara MENSUAL** (`discountRateMonthlyMicroBps`),
 *    derivado una sola vez por una persona y mostrado con su equivalente anual.
 *    `i_m = i_a / 12` sólo vale si `i_a` es un **nominal** (TIN); con el
 *    efectivo/TAE —que es lo que el usuario tiene a mano— el motor descontaba de
 *    más: sobre 10 000 000 a 24 meses al 6 %, **28 051 céntimos**, que con
 *    tolerancia 0 no son un redondeo.
 * 4. **(R-VA-2) Sólo aplazamientos > 12 meses** y con
 *    `|nominal − valor actual| ≥ pvMaterialityCents`, umbral **derivado** de la
 *    materialidad de las cuentas (el menor entre el 0,5 % del total del activo
 *    del ejercicio anterior y un tope declarado), no un número libre.
 * 5. **(R-VA-5, O-3)** El interés implícito se devenga **periodo a periodo**, a
 *    **`662`** del lado pasivo y a **`762` Ingresos de créditos** del lado
 *    activo —un crédito por enajenación de inmovilizado a más de doce meses
 *    (`253`) también se descuenta y su interés es **ingreso**—, los dos
 *    `FINANCIERO`, nivel BAI, CECO `CC-FIN`.
 * 6. **(R-VA-6) I-E9-19**: `descuento inicial = Σ intereses implícitos de toda la
 *    vida del pasivo`, y a vencimiento el pasivo vale su **nominal**. Se cumple
 *    por construcción: la **última** cuota de interés es la que cuadra.
 *
 * ## Aritmética (R-VA-4)
 *
 * Entera, en **punto fijo**, con `BigInt`, truncando en cada multiplicación y en
 * un **orden fijo**. Nada de `Math.pow` ni de raíces duodécimas: el tipo ya viene
 * mensual, así que el factor es una cadena de multiplicaciones.
 *
 * La escala es **10¹⁰**, que es la unidad nativa del micro-punto-básico
 * (`1 micro-bps = 10⁻¹⁰`): el diseño la describe como «base 10⁹», pero en 10⁹ el
 * tipo pierde su último dígito y el cálculo dejaría de ser reproducible byte a
 * byte contra el fixture. Los **importes** siguen siendo céntimos enteros.
 * `docs/design/fixtures/build_valor_actual_esperado.py` implementa exactamente
 * esta cadena con `decimal`/enteros y el test la compara byte a byte.
 */

import { depreciationSchedule, totalQuotaCents, type AssetRevisionRef, type FixedAssetRef } from "@/lib/closing/depreciation"
import { periodKeyOf, type PeriodKey } from "@/lib/recurring/schedule"
import type { AccountKey, Cents, DraftLine, LocalDate } from "@/lib/ledger/types"

// ─────────────────────────────────────────────────────────────────────────────
// Códigos de plantilla (T10 · agente B1). Constantes documentadas, no imports.
// ─────────────────────────────────────────────────────────────────────────────

/** **T-31** `AJUSTE_VALOR_ACTUAL`: el reconocimiento del descuento. */
export const TEMPLATE_VALOR_ACTUAL = "AJUSTE_VALOR_ACTUAL"
/** **T-22** `AJUSTE_EJERCICIO_CERRADO`: el caso **B** va por aquí, contra `113`. */
export const TEMPLATE_AJUSTE_EJERCICIOS_ANTERIORES = "AJUSTE_EJERCICIO_CERRADO"

/** 662 — intereses de deudas: el interés implícito del lado **pasivo**. */
const INTERESES_DEUDAS: AccountKey = "INTERESES_DEUDAS"
/** 762 — ingresos de créditos: el interés implícito del lado **activo** (O-3). */
const INGRESOS_CREDITOS: AccountKey = "INGRESOS_CREDITOS"
/** 113 — reservas voluntarias: destino del error de ejercicios anteriores. */
const RESERVAS_VOLUNTARIAS: AccountKey = "RESERVAS_VOLUNTARIAS"

// ─────────────────────────────────────────────────────────────────────────────
// Punto fijo
// ─────────────────────────────────────────────────────────────────────────────

/** Escala del punto fijo: 10¹⁰, la unidad nativa del micro-punto-básico. */
export const PV_SCALE = BigInt(10) ** BigInt(10)

/** Doce meses: la frontera del aplazamiento «superior al año» (NRV 2ª.1). */
export const PV_MIN_MONTHS = 12

const isPositiveInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0
const isNonNegativeInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0

/**
 * `(1 + i)^months` en punto fijo 10¹⁰, **truncando en cada multiplicación**.
 * El orden es fijo: se parte de la unidad y se multiplica `months` veces por el
 * factor mensual. Con `months = 0` vale exactamente la unidad.
 */
export function compoundFactorScaled(monthlyRateMicroBps: number, months: number): bigint {
  if (!isNonNegativeInt(monthlyRateMicroBps)) {
    throw new TypeError("compoundFactorScaled: el tipo mensual es un entero no negativo en micro-bps")
  }
  if (!isNonNegativeInt(months)) throw new TypeError("compoundFactorScaled: los meses son un entero no negativo")
  const factor = PV_SCALE + BigInt(monthlyRateMicroBps)
  let acc = PV_SCALE
  for (let i = 0; i < months; i++) acc = (acc * factor) / PV_SCALE
  return acc
}

/**
 * **R-VA-3/4.** Valor actual de un nominal aplazado `months` meses al tipo
 * **mensual** `monthlyRateMicroBps` (10⁻¹⁰), truncando hacia cero.
 *
 * *(Ejemplo del experto: nominal 10 000 000 a 24 meses con el tipo mensual
 * equivalente al 6 % efectivo anual ⇒ **8 899 964**, descuento 1 100 036.)*
 */
export function presentValueCents(nominalCents: Cents, monthlyRateMicroBps: number, months: number): Cents {
  if (!isNonNegativeInt(nominalCents)) throw new TypeError("presentValueCents: el nominal es un entero no negativo")
  const factor = compoundFactorScaled(monthlyRateMicroBps, months)
  if (factor === BigInt(0)) throw new RangeError("presentValueCents: factor de descuento nulo")
  return Number((BigInt(nominalCents) * PV_SCALE) / factor)
}

/** Descuento implícito: `nominal − valor actual`. Nunca negativo. */
export const discountCents = (nominalCents: Cents, presentValue: Cents): Cents => nominalCents - presentValue

/**
 * Tipo **anual equivalente** al mensual declarado, en micro-bps, para
 * enseñarlo en pantalla junto al que la persona ha declarado (O-2). Es
 * informativo: **el cálculo usa siempre el mensual**.
 */
export function annualEquivalentMicroBps(monthlyRateMicroBps: number): number {
  const factor = compoundFactorScaled(monthlyRateMicroBps, 12)
  return Number(factor - PV_SCALE)
}

// ─────────────────────────────────────────────────────────────────────────────
// R-VA-2 · materialidad
// ─────────────────────────────────────────────────────────────────────────────

/** Cinco por mil del total del activo: la referencia de materialidad por defecto. */
export const PV_MATERIALITY_BPS_OF_ASSETS = 50 // 0,50 % en puntos básicos

/**
 * **R-VA-2 (O-1).** Umbral **derivado**, no libre: el menor entre el 0,5 % del
 * total del activo del ejercicio anterior y un tope declarado. Un umbral
 * arbitrario es una puerta para no descontar nada.
 */
export function defaultPvMaterialityCents(previousTotalAssetsCents: Cents, capCents: Cents): Cents {
  if (!isNonNegativeInt(previousTotalAssetsCents) || !isNonNegativeInt(capCents)) {
    throw new TypeError("defaultPvMaterialityCents: importes enteros no negativos")
  }
  const derived = Number((BigInt(previousTotalAssetsCents) * BigInt(PV_MATERIALITY_BPS_OF_ASSETS)) / BigInt(10_000))
  return Math.min(derived, capCents)
}

/** ¿Hay que descontar? Sólo con aplazamiento > 12 meses y descuento material. */
export function requiresPresentValue(input: {
  months: number
  nominalCents: Cents
  presentValueCents: Cents
  materialityCents: Cents
}): boolean {
  return (
    input.months > PV_MIN_MONTHS &&
    Math.abs(discountCents(input.nominalCents, input.presentValueCents)) >= input.materialityCents
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// R-VA-5/6 · el cuadro del interés implícito
// ─────────────────────────────────────────────────────────────────────────────

export type ImplicitInterestRow = {
  period: PeriodKey
  interestCents: Cents
  /** Valor contable del pasivo (o del crédito) **al final** del periodo. */
  carryingCents: Cents
}

export type ImplicitInterestInput = {
  nominalCents: Cents
  presentValueCents: Cents
  months: number
  monthlyRateMicroBps: number
  /** Primer periodo mensual del devengo (`YYYY-MM`). */
  firstPeriod: PeriodKey
}

const nextMonth = (period: PeriodKey): PeriodKey => {
  const total = Number(period.slice(0, 4)) * 12 + Number(period.slice(5, 7))
  return `${String(Math.floor(total / 12)).padStart(4, "0")}-${String((total % 12) + 1).padStart(2, "0")}`
}

/**
 * **R-VA-5/6.** Devengo del interés implícito, **periodo a periodo**, por el
 * método del tipo efectivo: `interés = trunc(valor contable × i)` y el valor
 * contable crece con él. **La última cuota es la que cuadra**: se fija en
 * `nominal − valor contable anterior`, de modo que
 * `Σ intereses = nominal − valor actual` con **tolerancia 0** y a vencimiento el
 * pasivo vale su **nominal** (I-E9-19).
 */
export function implicitInterestSchedule(input: ImplicitInterestInput): ImplicitInterestRow[] {
  const { nominalCents, presentValueCents: pv, months, monthlyRateMicroBps } = input
  if (!isPositiveInt(months)) throw new TypeError("implicitInterestSchedule: los meses son un entero positivo")
  if (!isNonNegativeInt(nominalCents) || !isNonNegativeInt(pv)) {
    throw new TypeError("implicitInterestSchedule: nominal y valor actual son enteros no negativos")
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.firstPeriod)) {
    throw new TypeError(`implicitInterestSchedule: periodo mensual inválido «${input.firstPeriod}»`)
  }
  const rows: ImplicitInterestRow[] = []
  let carrying = pv
  let period = input.firstPeriod
  for (let m = 1; m <= months; m++) {
    const interest =
      m === months
        ? nominalCents - carrying
        : Number((BigInt(carrying) * BigInt(monthlyRateMicroBps)) / PV_SCALE)
    carrying += interest
    rows.push({ period, interestCents: interest, carryingCents: carrying })
    period = nextMonth(period)
  }
  return rows
}

/** Σ intereses del cuadro. **I-E9-19**: es exactamente el descuento inicial. */
export const totalImplicitInterestCents = (rows: readonly ImplicitInterestRow[]): Cents =>
  rows.reduce((acc, r) => acc + r.interestCents, 0)

export type ImplicitInterestSide = "PASIVO" | "ACTIVO"

/**
 * Líneas del devengo de un periodo. **Lado pasivo**: `662 (D) / 523-173 (H)`.
 * **Lado activo (O-3)**: `253-543 (D) / 762 (H)` —un crédito por enajenación de
 * inmovilizado a más de doce meses también se descuenta y su interés es
 * **ingreso**—. Las dos cuentas de resultado son `FINANCIERO`.
 */
export function implicitInterestLines(
  row: ImplicitInterestRow,
  side: ImplicitInterestSide,
  counterpartAccountCode: string,
  counterpartyId: string | null = null
): DraftLine[] {
  const amount = row.interestCents
  if (amount === 0) return []
  const description = `Interés implícito ${row.period} (NRV 9ª.3.1)`
  return side === "PASIVO"
    ? [
        { lineNo: 1, accountKey: INTERESES_DEUDAS, debitCents: amount, creditCents: 0, analyticType: "FINANCIERO", description },
        {
          lineNo: 2,
          accountCode: counterpartAccountCode,
          debitCents: 0,
          creditCents: amount,
          counterpartyId,
          analyticType: "NO_ANALITICO",
          description,
        },
      ]
    : [
        {
          lineNo: 1,
          accountCode: counterpartAccountCode,
          debitCents: amount,
          creditCents: 0,
          counterpartyId,
          analyticType: "NO_ANALITICO",
          description,
        },
        { lineNo: 2, accountKey: INGRESOS_CREDITOS, debitCents: 0, creditCents: amount, analyticType: "FINANCIERO", description },
      ]
}

// ─────────────────────────────────────────────────────────────────────────────
// R-VA-1 · el plan de corrección (casos A, B y C)
// ─────────────────────────────────────────────────────────────────────────────

export type LateRecognitionCase = "A" | "B" | "C"

export type LateRecognitionInput = {
  /** ¿El alta es del **ejercicio en curso** y las cuentas siguen sin formular? */
  currentFiscalYear: boolean
  /** ¿El origen es inmovilizado? Con `false`, el caso es **C**. */
  fixedAsset: boolean
  /** Cuenta del pasivo (o del crédito) aplazado: `523`, `173`, `253`… */
  debtAccountCode: string
  counterpartyId?: string | null
  nominalCents: Cents
  monthlyRateMicroBps: number
  months: number
  /** Fecha a la que se hace la corrección (cierre o fecha del asiento). */
  refDate: LocalDate
  /** Primer periodo del devengo del interés implícito. */
  firstPeriod: PeriodKey
  /**
   * Activo cuyo coste hay que reducir (caso **A**). Su cuadro se **recalcula
   * desde `inServiceDate`** con el coste corregido: no se crea `AssetRevision`.
   */
  asset?: FixedAssetRef
  revisions?: readonly AssetRevisionRef[]
  /** Periodos ya contabilizados del cuadro (para medir el exceso dotado). */
  postedThroughPeriod?: PeriodKey | null
  /** Caso **C**: cuenta de gasto o ingreso original del mismo ejercicio. */
  originalPnlAccountCode?: string | null
}

export type LateRecognitionPlan = {
  case: LateRecognitionCase
  templateCode: string
  presentValueCents: Cents
  discountCents: Cents
  /** Exceso de amortización dotado sobre el coste bruto (caso A). */
  excessDepreciationCents: Cents
  /** Interés implícito ya devengado hasta `refDate` (caso A). */
  accruedInterestCents: Cents
  /** Cuadro del interés implícito de toda la vida del pasivo. */
  interestSchedule: ImplicitInterestRow[]
  /** Cuadro recalculado con el coste corregido (caso A). */
  recalculatedSchedule: { period: PeriodKey; quotaCents: Cents; accumulatedCents: Cents }[]
  lines: DraftLine[]
  /** Qué hay que contar en la memoria y por qué (casos B y C). */
  notas: string[]
}

const accumulatedThroughPeriod = (
  rows: readonly { period: PeriodKey; accumulatedCents: Cents }[],
  period: PeriodKey | null | undefined
): Cents => {
  if (!period) return 0
  let acc = 0
  for (const row of rows) {
    if (row.period > period) break
    acc = row.accumulatedCents
  }
  return acc
}

/**
 * **R-VA-1.** Plan de corrección del descuento **no reconocido en el alta**, en
 * sus tres casos. Devuelve las líneas del asiento, el cuadro recalculado y el
 * cuadro del interés implícito; **no** crea `AssetRevision` (D7.2).
 *
 * *(Ejemplo del experto, caso A: nominal 10 000 000 a 24 meses ⇒ valor actual
 * 8 899 964 y descuento 1 100 036; con 10 meses amortizados sobre el bruto y
 * vida 60, el exceso es 183 340.)*
 */
export function lateRecognitionPlan(input: LateRecognitionInput): LateRecognitionPlan {
  const pv = presentValueCents(input.nominalCents, input.monthlyRateMicroBps, input.months)
  const discount = discountCents(input.nominalCents, pv)
  const interestSchedule = implicitInterestSchedule({
    nominalCents: input.nominalCents,
    presentValueCents: pv,
    months: input.months,
    monthlyRateMicroBps: input.monthlyRateMicroBps,
    firstPeriod: input.firstPeriod,
  })
  const refPeriod = periodKeyOf(input.refDate, "MENSUAL")
  const accruedInterestCents = interestSchedule
    .filter((r) => r.period <= refPeriod)
    .reduce((acc, r) => acc + r.interestCents, 0)

  const notas: string[] = []
  const lines: DraftLine[] = []
  let lineNo = 1
  let excessDepreciationCents = 0
  let recalculatedSchedule: { period: PeriodKey; quotaCents: Cents; accumulatedCents: Cents }[] = []

  const kase: LateRecognitionCase = !input.fixedAsset ? "C" : input.currentFiscalYear ? "A" : "B"

  if (kase === "A") {
    if (!input.asset) {
      throw new TypeError("lateRecognitionPlan: el caso A necesita el activo cuyo coste se corrige")
    }
    // El cuadro se RECALCULA desde `inServiceDate` con el coste corregido: no es
    // un cambio de estimación (prospectivo), es la corrección de un error.
    const gross = depreciationSchedule(input.asset, input.revisions ?? [])
    const corrected = depreciationSchedule(
      { ...input.asset, acquisitionCostCents: input.asset.acquisitionCostCents - discount },
      input.revisions ?? []
    )
    recalculatedSchedule = corrected.map((r) => ({
      period: r.period,
      quotaCents: r.quotaCents,
      accumulatedCents: r.accumulatedCents,
    }))
    const posted = input.postedThroughPeriod ?? null
    excessDepreciationCents = accumulatedThroughPeriod(gross, posted) - accumulatedThroughPeriod(corrected, posted)

    // 1) Reducción del coste: `523/173 (D) descuento / 21x (H) descuento`.
    lines.push({
      lineNo: lineNo++,
      accountCode: input.debtAccountCode,
      debitCents: discount,
      creditCents: 0,
      counterpartyId: input.counterpartyId ?? null,
      analyticType: "NO_ANALITICO",
      description: "Valor actual del aplazamiento: reducción del precio de adquisición (NRV 2ª.1)",
    })
    lines.push({
      lineNo: lineNo++,
      accountCode: input.asset.assetAccountCode,
      debitCents: 0,
      creditCents: discount,
      analyticType: "NO_ANALITICO",
      description: "Valor actual del aplazamiento: reducción del precio de adquisición (NRV 2ª.1)",
    })
    // 2) Reversión del exceso dotado: `281x (D) / 681x (H)`.
    if (excessDepreciationCents > 0) {
      lines.push({
        lineNo: lineNo++,
        accountCode: input.asset.accumulatedAccountCode,
        debitCents: excessDepreciationCents,
        creditCents: 0,
        analyticType: "NO_ANALITICO",
        description: "Reversión de la amortización dotada en exceso sobre el coste bruto",
      })
      lines.push({
        lineNo: lineNo++,
        accountCode: input.asset.expenseAccountCode,
        debitCents: 0,
        creditCents: excessDepreciationCents,
        analyticType: "AMORTIZACION_DETERIORO",
        description: "Reversión de la amortización dotada en exceso sobre el coste bruto",
      })
    }
    // 3) Interés implícito devengado hasta la fecha: `662 (D) / 523-173 (H)`.
    if (accruedInterestCents > 0) {
      lines.push({
        lineNo: lineNo++,
        accountKey: INTERESES_DEUDAS,
        debitCents: accruedInterestCents,
        creditCents: 0,
        analyticType: "FINANCIERO",
        description: `Interés implícito devengado hasta ${input.refDate}`,
      })
      lines.push({
        lineNo: lineNo++,
        accountCode: input.debtAccountCode,
        debitCents: 0,
        creditCents: accruedInterestCents,
        counterpartyId: input.counterpartyId ?? null,
        analyticType: "NO_ANALITICO",
        description: `Interés implícito devengado hasta ${input.refDate}`,
      })
    }
    notas.push(
      "Corrección dentro del ejercicio: el cuadro se recalcula desde la puesta en servicio con el coste corregido. " +
        "No se crea AssetRevision: una revisión es un cambio de estimación (prospectivo) y esto es la corrección de un error"
    )
    if (totalQuotaCents(corrected) !== corrected[corrected.length - 1]?.accumulatedCents) {
      notas.push("el cuadro recalculado no acumula lo que suma: revísese antes de postear")
    }
  } else {
    // Casos B y C: el efecto neto acumulado va contra reservas (B) o contra la
    // cuenta de gasto/ingreso original si es del mismo ejercicio (C).
    const netEffect = discount - accruedInterestCents
    const counterAccountKey = kase === "B" || !input.originalPnlAccountCode ? RESERVAS_VOLUNTARIAS : null
    lines.push({
      lineNo: lineNo++,
      accountCode: input.debtAccountCode,
      debitCents: Math.max(netEffect, 0),
      creditCents: Math.max(-netEffect, 0),
      counterpartyId: input.counterpartyId ?? null,
      analyticType: "NO_ANALITICO",
      description:
        kase === "B"
          ? "Valor actual no reconocido en el alta: error de ejercicios anteriores (NRV 22ª)"
          : "Valor actual no reconocido en el alta: corrección del origen no inmovilizado",
    })
    lines.push(
      counterAccountKey
        ? {
            lineNo: lineNo++,
            accountKey: counterAccountKey,
            debitCents: Math.max(-netEffect, 0),
            creditCents: Math.max(netEffect, 0),
            analyticType: "NO_ANALITICO",
            description: "Efecto neto acumulado contra reservas (NRV 22ª)",
          }
        : {
            lineNo: lineNo++,
            accountCode: input.originalPnlAccountCode as string,
            debitCents: Math.max(-netEffect, 0),
            creditCents: Math.max(netEffect, 0),
            analyticType: "NO_ANALITICO",
            description: "Efecto neto acumulado contra el gasto o ingreso original del ejercicio",
          }
    )
    notas.push(
      kase === "B"
        ? `Va por T-22 (${TEMPLATE_AJUSTE_EJERCICIOS_ANTERIORES}) contra 113 en el ejercicio ABIERTO, se reexpresa el comparativo y se desglosa en la memoria (NRV 22ª)`
        : "Origen no inmovilizado: al gasto o ingreso original si es del mismo ejercicio; a 113 si es de un ejercicio cerrado"
    )
  }

  return {
    case: kase,
    templateCode: kase === "B" ? TEMPLATE_AJUSTE_EJERCICIOS_ANTERIORES : TEMPLATE_VALOR_ACTUAL,
    presentValueCents: pv,
    discountCents: discount,
    excessDepreciationCents,
    accruedInterestCents,
    interestSchedule,
    recalculatedSchedule,
    lines,
    notas,
  }
}
