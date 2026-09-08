/**
 * E9 · T6 — Cuadro de amortización del inmovilizado (`lib/closing/depreciation.ts`).
 *
 * Implementa **R-AM-1…10** de `docs/design/E9-cierre-recurrentes.md` §4.2 y la
 * decisión **D2** de ADR-0016 (precisada por O-19, O-22, O-23, O-24, O-28 y
 * O-30 de la validación contable).
 *
 * Módulo **PURO**: sin `Date.now()`, sin Prisma, sin IO, sin LLM.
 *
 * ## Lo que este fichero NO hace, y por qué
 *
 *  - **No almacena el cuadro** (§3.6, ADR-0003). El cuadro es una *vista
 *    derivada* del activo y de sus revisiones; lo que se persiste es
 *    `FixedAsset.scheduleHash`, que I-E9-3 usa para demostrar que el cuadro de
 *    hoy explica los asientos de ayer. Un cuadro almacenado es una cifra de
 *    informe guardada, y esas divergen.
 *  - **No amortiza fiscalmente** (R-AM-9, O-23). El cuadro es el **contable**
 *    (NRV 2ª.2.1). Los coeficientes del art. 12.1 LIS son una sugerencia de la
 *    interfaz; la libertad de amortización y la acelerada (arts. 12.3 y 102 LIS)
 *    son extracontables y generan diferencias temporarias (`479` contra `6301`),
 *    que son E10. Si entraran aquí, el resultado contable dejaría de ser el
 *    punto de partida del art. 10.3 LIS.
 *  - **No usa `hamilton()`** (`splitLargestRemainder`). Con pesos iguales el
 *    mayor resto reparte por menor índice —a los primeros meses—, y el activo
 *    alcanzaría su valor residual **antes** de agotar su vida útil: eso es una
 *    amortización acelerada no justificada. R-AM-2 es explícita: `q = trunc(base
 *    / n)` y el residuo `∈ [0, n−1]` **a la última cuota**.
 *
 * ## Las dos convenciones que hay que tener escritas en la memoria
 *
 *  1. **Mes entero desde `inServiceDate`** (R-AM-3, NRV 2ª.1 y 3ª): la puesta en
 *     condiciones de funcionamiento, no la fecha de factura. Un activo instalado
 *     el 17 de marzo amortiza marzo completo.
 *  2. **Hasta el mes de la baja inclusive** (R-AM-6). Consecuencia aceptada
 *     (R-AM-8, O-30): un activo en servicio el 31/01 y de baja el 01/02 amortiza
 *     **dos** meses. Es inmaterial, es uniforme (art. 38.d CCom) y **no se
 *     cambia a mitad de vida de un activo**.
 */

import { createHash } from "node:crypto"

import { daysInMonth, formatLocalDate } from "@/lib/ledger/dates"
import type { Cents, DraftLine, LocalDate, Result } from "@/lib/ledger/types"
import { err, fail, ok } from "@/lib/ledger/types"
import { canonicalJson, periodKeyOf, type PeriodKey } from "@/lib/recurring/schedule"

// ─────────────────────────────────────────────────────────────────────────────
// Tipos planos (mismos literales que los enums del esquema; sin Prisma)
// ─────────────────────────────────────────────────────────────────────────────

export type DepreciationMethod = "LINEAL" | "SUMA_DIGITOS" | "PORCENTAJE_CONSTANTE" | "UNIDADES_PRODUCCION"
export type AssetStatus = "EN_USO" | "TOTALMENTE_AMORTIZADO" | "BAJA" | "VENDIDO"

export type FixedAssetRef = {
  id: string
  code: string
  name?: string
  method: DepreciationMethod
  /** Puesta en condiciones de funcionamiento (NRV 2ª.1 y 3ª), no la factura. */
  inServiceDate: LocalDate
  acquisitionCostCents: Cents
  residualValueCents: Cents
  usefulLifeMonths: number
  assetAccountCode: string
  accumulatedAccountCode: string
  expenseAccountCode: string
  status?: AssetStatus
  /** Corta el cuadro: se dota **hasta este mes inclusive** (R-AM-6). */
  disposalDate?: LocalDate | null
  /** O-12: bien de inversión del art. 108 LIVA. Gobierna el aviso del art. 110. */
  isCapitalGood?: boolean
  /** Edificación: aviso del art. 20.Uno.22º y renuncia del art. 84.Uno.2º.e. */
  isBuilding?: boolean
  projectId?: string | null
  costCenterId?: string | null
}

/**
 * Cambio de **estimación** (NRV 22ª): prospectivo. `effectiveFrom` es siempre el
 * día 1 de un mes (CHECK del esquema).
 *
 * `newUsefulLifeMonths` es la **vida útil TOTAL revisada contada desde
 * `inServiceDate`**, igual que `FixedAsset.usefulLifeMonths` —no los meses que
 * quedan—. Es la lectura que hace que el campo signifique lo mismo en los dos
 * sitios; si la vida revisada ya está agotada en `effectiveFrom`, el valor neto
 * pendiente se dota íntegro en ese mes.
 */
export type AssetRevisionRef = {
  effectiveFrom: LocalDate
  newUsefulLifeMonths?: number | null
  newResidualValueCents?: Cents | null
  /** Mejora capitalizada: aumenta el coste desde `effectiveFrom` (R-AM-1). */
  addedCostCents?: Cents | null
  reason?: string
}

export type DepreciationRow = {
  period: PeriodKey
  from: LocalDate
  to: LocalDate
  quotaCents: Cents
  accumulatedCents: Cents
  /** Valor neto contable = coste vigente (con mejoras) − amortización acumulada. */
  netBookValueCents: Cents
}

// ─────────────────────────────────────────────────────────────────────────────
// El cuadro
// ─────────────────────────────────────────────────────────────────────────────

const monthKeyOf = (date: LocalDate): PeriodKey => periodKeyOf(date, "MENSUAL")

function monthBounds(key: PeriodKey): { from: LocalDate; to: LocalDate } {
  const year = Number(key.slice(0, 4))
  const month = Number(key.slice(5, 7))
  return {
    from: formatLocalDate({ year, month, day: 1 }),
    to: formatLocalDate({ year, month, day: daysInMonth(year, month) }),
  }
}

function addMonths(key: PeriodKey, n: number): PeriodKey {
  const year = Number(key.slice(0, 4))
  const month = Number(key.slice(5, 7))
  const total = year * 12 + (month - 1) + n
  return `${String(Math.floor(total / 12)).padStart(4, "0")}-${String((total % 12) + 1).padStart(2, "0")}`
}

const monthsBetween = (a: PeriodKey, b: PeriodKey): number =>
  (Number(b.slice(0, 4)) * 12 + Number(b.slice(5, 7))) - (Number(a.slice(0, 4)) * 12 + Number(a.slice(5, 7)))

/**
 * **R-AM-1…5.** Cuadro mensual vigente del activo, desde el mes de
 * `inServiceDate` hasta el fin de su vida útil (o el mes de la baja, inclusive).
 *
 * Algoritmo, en tramos separados por las revisiones:
 *
 *   base del tramo = coste vigente + mejoras − acumulada − residual vigente
 *   n              = meses que quedan de vida útil desde el mes del tramo
 *   q              = trunc(base / n)      · residuo a la ÚLTIMA cuota del cuadro
 *
 * El pasado **no se toca**: cada revisión arranca del valor neto contable real y
 * lo reparte entre la vida residual (NRV 22ª), sin asiento de ajuste.
 *
 * `SUMA_DIGITOS`, `PORCENTAJE_CONSTANTE` y `UNIDADES_PRODUCCION` se **rechazan**
 * (D2.1): están declarados en el enum y el motor lanza, en vez de aproximar en
 * silencio un método que nadie ha validado.
 */
export function depreciationSchedule(
  asset: FixedAssetRef,
  revisions: readonly AssetRevisionRef[] = []
): DepreciationRow[] {
  if (asset.method !== "LINEAL") {
    throw new TypeError(
      `método de amortización ${asset.method} no resuelto (D2.1 de ADR-0016): sólo LINEAL se contabiliza`
    )
  }
  if (!Number.isSafeInteger(asset.acquisitionCostCents) || asset.acquisitionCostCents < 0) {
    throw new TypeError(`coste de adquisición inválido en el activo ${asset.code}`)
  }
  if (!Number.isSafeInteger(asset.residualValueCents) || asset.residualValueCents < 0) {
    throw new TypeError(`valor residual inválido en el activo ${asset.code}`)
  }
  if (!Number.isInteger(asset.usefulLifeMonths) || asset.usefulLifeMonths <= 0) {
    throw new TypeError(`vida útil inválida en el activo ${asset.code}: ${asset.usefulLifeMonths}`)
  }

  const firstMonth = monthKeyOf(asset.inServiceDate)
  const sorted = [...revisions].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0))
  const revisionByMonth = new Map<PeriodKey, AssetRevisionRef[]>()
  for (const r of sorted) {
    const k = monthKeyOf(r.effectiveFrom)
    // Una revisión anterior a la puesta en servicio se aplica desde el primer mes.
    const key = k < firstMonth ? firstMonth : k
    const bucket = revisionByMonth.get(key)
    if (bucket) bucket.push(r)
    else revisionByMonth.set(key, [r])
  }

  let cost = asset.acquisitionCostCents
  let residual = asset.residualValueCents
  let lifeMonths = asset.usefulLifeMonths
  let accumulated = 0

  const disposalMonth = asset.disposalDate ? monthKeyOf(asset.disposalDate) : null
  const rows: DepreciationRow[] = []

  // Techo defensivo: la vida útil puede alargarse por revisión, pero no sin fin.
  const MAX_MONTHS = 1200
  if (disposalMonth !== null && disposalMonth < firstMonth) return []
  let month = firstMonth
  let quota = 0

  for (let step = 0; step < MAX_MONTHS; step++) {
    const elapsed = monthsBetween(firstMonth, month) // meses ya recorridos
    const revs = revisionByMonth.get(month)
    const isFirst = step === 0
    if (revs || isFirst) {
      for (const r of revs ?? []) {
        if (r.addedCostCents) {
          if (!Number.isSafeInteger(r.addedCostCents)) throw new TypeError("mejora capitalizada no entera")
          cost += r.addedCostCents
        }
        if (r.newResidualValueCents !== null && r.newResidualValueCents !== undefined) residual = r.newResidualValueCents
        if (r.newUsefulLifeMonths !== null && r.newUsefulLifeMonths !== undefined) {
          if (!Number.isInteger(r.newUsefulLifeMonths) || r.newUsefulLifeMonths <= 0) {
            throw new TypeError(`vida útil revisada inválida: ${String(r.newUsefulLifeMonths)}`)
          }
          lifeMonths = r.newUsefulLifeMonths
        }
      }
      // R-AM-5: el VNC pendiente se reparte entre lo que quede de vida útil.
      const remainingMonths = Math.max(lifeMonths - elapsed, 1)
      const pending = Math.max(cost - accumulated - residual, 0)
      quota = Math.trunc(pending / remainingMonths)
    }

    const lastMonthOfLife = addMonths(firstMonth, lifeMonths - 1)
    const isLastOfLife = month >= lastMonthOfLife
    const isDisposalMonth = disposalMonth !== null && month === disposalMonth
    const pendingNow = Math.max(cost - accumulated - residual, 0)

    // R-AM-2: el residuo de la división va a la ÚLTIMA cuota, que es la que
    // cuadra el cuadro con la base. R-AM-4: nunca por encima de la base ni
    // negativa.
    let q = isLastOfLife ? pendingNow : Math.min(quota, pendingNow)
    if (q < 0) q = 0

    accumulated += q
    const { from, to } = monthBounds(month)
    rows.push({
      period: month,
      from,
      to,
      quotaCents: q,
      accumulatedCents: accumulated,
      netBookValueCents: cost - accumulated,
    })

    if (isDisposalMonth) break
    if (isLastOfLife) break
    month = addMonths(month, 1)
  }

  return rows
}

/**
 * **I-E9-3.** sha256 del cuadro **vigente**, en forma canónica (ADR-0011). Es lo
 * único del cuadro que se persiste (`FixedAsset.scheduleHash`): cambia con toda
 * revisión y con toda mejora, y no cambia si el cuadro no cambia.
 */
export function scheduleHashOf(rows: readonly DepreciationRow[]): string {
  return createHash("sha256").update(canonicalJson(rows), "utf8").digest("hex")
}

/** Fila del periodo, o `null` si el cuadro no llega (R-REC-4: no se interpola). */
export function depreciationForPeriod(rows: readonly DepreciationRow[], period: PeriodKey): DepreciationRow | null {
  return rows.find((r) => r.period === period) ?? null
}

/** Σ cuotas del cuadro. **I-E9-4 (O-28)**: `= coste + Σ mejoras − residual vigente`. */
export function totalQuotaCents(rows: readonly DepreciationRow[]): Cents {
  return rows.reduce((acc, r) => acc + r.quotaCents, 0)
}

/** Amortización acumulada **hasta el periodo inclusive** (R-AM-6). */
export function accumulatedThrough(rows: readonly DepreciationRow[], period: PeriodKey): Cents {
  let acc = 0
  for (const r of rows) {
    if (r.period > period) break
    acc = r.accumulatedCents
  }
  return acc
}

// ─────────────────────────────────────────────────────────────────────────────
// Líneas del asiento
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **O-19.** La línea de `68x`/`28x` lleva el activo: `JournalLine.fixedAssetId`.
 * Sin él, I-E9-5 no es computable —`28x` es compartida— y un activo
 * sobreamortizado compensado por otro infraamortizado pasaría el invariante.
 */
export type AssetDraftLine = DraftLine & { fixedAssetId?: string | null }

/** T-14: dotación del periodo. `68x (D) / 28x (H)`, con el destino analítico del activo. */
export function depreciationLines(asset: FixedAssetRef, row: DepreciationRow): Result<AssetDraftLine[]> {
  if (row.quotaCents <= 0) {
    return fail(
      err("ZERO_LINE", "quotaCents", `La cuota de ${asset.code} en ${row.period} es 0: no genera asiento (R-REC-8)`, {
        check: "R-REC-8",
      })
    )
  }
  return ok([
    {
      lineNo: 1,
      accountCode: asset.expenseAccountCode,
      debitCents: row.quotaCents,
      creditCents: 0,
      description: `Dotación amortización ${asset.code} · ${row.period}`,
      projectId: asset.projectId ?? null,
      costCenterId: asset.costCenterId ?? null,
      fixedAssetId: asset.id,
    },
    {
      lineNo: 2,
      accountCode: asset.accumulatedAccountCode,
      debitCents: 0,
      creditCents: row.quotaCents,
      description: `Amortización acumulada ${asset.code} · ${row.period}`,
      fixedAssetId: asset.id,
    },
  ])
}

export type DisposalInput = {
  kind: "BAJA" | "VENTA"
  /** Fecha de la baja o de la venta. El cuadro se dota hasta su mes inclusive. */
  date: LocalDate
  /** Sólo `VENTA`: precio sin IVA. */
  priceCents?: Cents
  /** Sólo `VENTA`: cuota repercutida; 0 si la operación está exenta. */
  vatCents?: Cents
  /**
   * **R-AM-7.** Contrapartida de la venta: `543` (o `253` si el aplazamiento
   * supera el año). **Nunca `430`**: recoge créditos de la actividad ordinaria y
   * meter ahí la venta de una furgoneta contamina el *aging*, el DSO y el PMC.
   */
  receivableAccountCode?: string
  /** `477`. */
  vatAccountCode?: string
  /** `771` — beneficio de la enajenación. */
  gainAccountCode?: string
  /** `671` — pérdida de la enajenación (y VNC de la baja). */
  lossAccountCode: string
  counterpartyId?: string | null
  dueDate?: LocalDate | null
}

/** Aviso que la pantalla **debe** enseñar; no se automatiza, se dice (R-AM-7). */
export type DisposalWarning = {
  code: "ART_110_LIVA_BIEN_INVERSION" | "ART_20_UNO_22_EDIFICACION" | "APLAZAMIENTO_MAS_DE_UN_ANO"
  message: string
}

/**
 * **R-AM-6 / R-AM-7 (T-33 y T-34).** Líneas de la baja o de la venta, con la
 * amortización acumulada **hasta el mes de la baja inclusive** ya dotada.
 *
 * Baja *(ejemplo del experto)*: coste 1 000 000, acumulada 640 000 ⇒
 * `2811 (D) 640 000 · 671 (D) 360 000 · 2131 (H) 1 000 000`.
 *
 * Venta por 500 000 + 21 % ⇒ `543 (D) 605 000 · 2811 (D) 640 000 ·
 * 2131 (H) 1 000 000 · 477 (H) 105 000 · 771 (H) 140 000`.
 */
export function disposalLines(
  asset: FixedAssetRef,
  rows: readonly DepreciationRow[],
  disposal: DisposalInput
): Result<AssetDraftLine[]> {
  const month = monthKeyOf(disposal.date)
  const accumulated = accumulatedThrough(rows, month)
  const lastRow = rows[rows.length - 1]
  // El coste vigente incluye las mejoras capitalizadas: se lee del propio cuadro.
  const cost = lastRow ? lastRow.netBookValueCents + lastRow.accumulatedCents : asset.acquisitionCostCents
  const netBookValue = cost - accumulated

  const lines: AssetDraftLine[] = []
  let lineNo = 1
  const push = (line: Omit<AssetDraftLine, "lineNo">) => lines.push({ lineNo: lineNo++, ...line })

  if (disposal.kind === "VENTA") {
    const price = disposal.priceCents ?? 0
    const vat = disposal.vatCents ?? 0
    if (!Number.isSafeInteger(price) || price < 0) {
      return fail(err("TEMPLATE_INPUT", "priceCents", `Precio de venta inválido para ${asset.code}`))
    }
    if (!Number.isSafeInteger(vat) || vat < 0) {
      return fail(err("TEMPLATE_INPUT", "vatCents", `Cuota de IVA inválida para ${asset.code}`))
    }
    const receivable = disposal.receivableAccountCode
    if (!receivable) {
      return fail(err("TEMPLATE_INPUT", "receivableAccountCode", "La venta de inmovilizado exige contrapartida 543/253"))
    }
    if (receivable.startsWith("430") || receivable.startsWith("431")) {
      return fail(
        err(
          "TEMPLATE_INPUT",
          "receivableAccountCode",
          `La contrapartida de la venta de inmovilizado es 543 (o 253 a más de un año), nunca ${receivable}: ` +
            "430 recoge créditos de la actividad ordinaria y contamina el aging, el DSO y el PMC (R-AM-7)",
          { check: "R-AM-7" }
        )
      )
    }
    if (vat > 0 && !disposal.vatAccountCode) {
      return fail(err("TEMPLATE_INPUT", "vatAccountCode", "Hay cuota repercutida y no se ha resuelto la cuenta 477"))
    }
    push({
      accountCode: receivable,
      debitCents: price + vat,
      creditCents: 0,
      description: `Enajenación ${asset.code}`,
      counterpartyId: disposal.counterpartyId ?? null,
      dueDate: disposal.dueDate ?? null,
    })
    if (accumulated > 0) {
      push({
        accountCode: asset.accumulatedAccountCode,
        debitCents: accumulated,
        creditCents: 0,
        description: `Cancelación amortización acumulada ${asset.code}`,
        fixedAssetId: asset.id,
      })
    }
    push({
      accountCode: asset.assetAccountCode,
      debitCents: 0,
      creditCents: cost,
      description: `Baja del inmovilizado ${asset.code}`,
      fixedAssetId: asset.id,
    })
    if (vat > 0) {
      push({
        accountCode: disposal.vatAccountCode as string,
        debitCents: 0,
        creditCents: vat,
        description: `IVA repercutido en la enajenación de ${asset.code}`,
      })
    }
    const result = price - netBookValue
    if (result > 0) {
      if (!disposal.gainAccountCode) {
        return fail(err("TEMPLATE_INPUT", "gainAccountCode", "Hay beneficio en la venta y falta la cuenta 771"))
      }
      push({
        accountCode: disposal.gainAccountCode,
        debitCents: 0,
        creditCents: result,
        description: `Beneficio en la enajenación de ${asset.code}`,
        projectId: asset.projectId ?? null,
        costCenterId: asset.costCenterId ?? null,
      })
    } else if (result < 0) {
      push({
        accountCode: disposal.lossAccountCode,
        debitCents: -result,
        creditCents: 0,
        description: `Pérdida en la enajenación de ${asset.code}`,
        projectId: asset.projectId ?? null,
        costCenterId: asset.costCenterId ?? null,
      })
    }
    return ok(lines)
  }

  // BAJA sin contraprestación (desguace, siniestro sin indemnización).
  if (accumulated > 0) {
    push({
      accountCode: asset.accumulatedAccountCode,
      debitCents: accumulated,
      creditCents: 0,
      description: `Cancelación amortización acumulada ${asset.code}`,
      fixedAssetId: asset.id,
    })
  }
  if (netBookValue > 0) {
    push({
      accountCode: disposal.lossAccountCode,
      debitCents: netBookValue,
      creditCents: 0,
      description: `Pérdida por baja de ${asset.code}`,
      projectId: asset.projectId ?? null,
      costCenterId: asset.costCenterId ?? null,
    })
  }
  if (netBookValue < 0) {
    return fail(
      err("LINE_NEGATIVE", "netBookValueCents", `El VNC de ${asset.code} es negativo (${netBookValue}): revise el cuadro`)
    )
  }
  push({
    accountCode: asset.assetAccountCode,
    debitCents: 0,
    creditCents: cost,
    description: `Baja del inmovilizado ${asset.code}`,
    fixedAssetId: asset.id,
  })
  return ok(lines)
}

/**
 * **R-AM-7.** Avisos fiscales obligatorios de la baja o la venta. No se
 * automatiza ninguno: se enseña, que es justo lo que la validación pedía.
 *
 * `regularizationYears` es la ventana del art. 107 LIVA: **cinco** años para
 * bienes de inversión y **diez** para terrenos y edificaciones.
 */
export function disposalWarnings(asset: FixedAssetRef, disposal: DisposalInput): DisposalWarning[] {
  const out: DisposalWarning[] = []
  const years = asset.isBuilding ? 10 : 5
  const elapsedYears = Number(disposal.date.slice(0, 4)) - Number(asset.inServiceDate.slice(0, 4))
  if (asset.isCapitalGood && disposal.kind === "VENTA" && elapsedYears < years) {
    out.push({
      code: "ART_110_LIVA_BIEN_INVERSION",
      message:
        `${asset.code} es bien de inversión (art. 108 LIVA) y se vende dentro del periodo de regularización ` +
        `(${years} años desde ${asset.inServiceDate}): procede la regularización ÚNICA del art. 110 LIVA. ` +
        "El producto no la calcula: consulte con su asesor.",
    })
  }
  if (asset.isBuilding && disposal.kind === "VENTA") {
    out.push({
      code: "ART_20_UNO_22_EDIFICACION",
      message:
        "La entrega de una edificación puede estar exenta (art. 20.Uno.22º LIVA). Decida sobre la renuncia a la " +
        "exención y la inversión del sujeto pasivo (art. 84.Uno.2º.e LIVA) antes de repercutir.",
    })
  }
  if (disposal.kind === "VENTA" && disposal.receivableAccountCode?.startsWith("253")) {
    out.push({
      code: "APLAZAMIENTO_MAS_DE_UN_ANO",
      message:
        "El crédito por enajenación se ha registrado en 253 (largo plazo): recuerde reclasificar a 543 el importe " +
        "que venza dentro de los doce meses siguientes al cierre (norma 6ª de elaboración).",
    })
  }
  return out
}
