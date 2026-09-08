/**
 * E9 · T10 — Bloque E9: T-29…T-37 (`docs/design/E9-cierre-recurrentes.md` §4 y
 * ADR-0016). Módulo **PURO**: ni `Date.now()`, ni `prisma`, ni `fetch`.
 *
 * Las nueve plantillas nuevas cierran las omisiones de ciclo que la validación
 * contable destapó:
 *
 * | Código | Plantilla | Qué reconoce |
 * |---|---|---|
 * | **T-29** | `DUA_IMPORTACION` | La base del **DUA** (art. 83.Uno LIVA) y el diferimiento del art. 167.Dos |
 * | **T-30** | `DIFERENCIAS_CAMBIO_CIERRE` | NRV 11ª.2.2 sobre partidas **monetarias**: E7 medía, E9 reconoce |
 * | **T-31** | `AJUSTE_VALOR_ACTUAL` | El descuento del aplazamiento como **valoración inicial** (NRV 2ª.1 y 9ª.3.1) |
 * | **T-32** | `RECLASIFICACION_VENCIMIENTOS` | Norma 6ª de elaboración: corriente / no corriente |
 * | **T-33** | `BAJA_INMOVILIZADO` | `28x (D)` · `671 (D)` VNC · `2xx (H)` coste |
 * | **T-34** | `VENTA_INMOVILIZADO` | `543`/`253` — **nunca `430`** —, `477` y `771`/`671` |
 * | **T-35** | `DISTRIBUCION_RESULTADO` | Arts. 164 y 274 LSC: `129 → 112/113/120/526`, con `557` cancelado |
 * | **T-36** | `DEVENGO_RECC` | Barrido del 31/12 del art. 163 *terdecies* |
 * | **T-37** | `ALTA_PRESTAMO` | Una línea de `170`/`520` **por vencimiento** (O-6) |
 *
 * Ninguna calcula lo que otro motor ya calcula: los cuadros vienen de
 * `lib/closing/*` y aquí sólo se convierten en asiento, se comprueba el cuadre
 * de la propuesta y se sella lo que hay que sellar (la tasa de cierre, el
 * activo de cada línea de `68x`/`28x`, el vencimiento de cada plazo).
 */

import { buildEntry } from "@/lib/ledger/post"
import { duaVatEffect, reccYearEndSweep } from "@/lib/closing/vat"
import {
  AccountKey,
  AnalyticType,
  Cents,
  DraftLine,
  EntryDraft,
  err,
  fail,
  LedgerContext,
  LedgerError,
  LocalDate,
  Result,
} from "@/lib/ledger/types"
import { credit, debit, sumCents } from "@/lib/ledger/templates/types"
import { templateDestination } from "@/lib/ledger/templates/dimensions"
import type {
  AjusteValorActualInput,
  AltaPrestamoInput,
  BajaInmovilizadoInput,
  DevengoReccInput,
  DiferenciasCambioInput,
  DistribucionResultadoInput,
  DuaImportacionInput,
  ReclasificacionVencimientosInput,
  VentaInmovilizadoInput,
} from "@/lib/ledger/templates/schemas"

/**
 * **O-19 / D11.** La línea de `68x`, `28x`, `671` y `771` lleva el activo:
 * `JournalLine.fixedAssetId`. Sin él, I-E9-5 se evalúa por agregado sobre una
 * `2811` compartida y deja pasar justo lo que busca —un activo sobreamortizado
 * compensado por otro infraamortizado—.
 */
export type AssetDraftLine = DraftLine & { fixedAssetId?: string | null }

function analyticFor(ctx: LedgerContext, accountCode: string, override?: AnalyticType | null): AnalyticType | null {
  return override ?? ctx.plan.byCode.get(accountCode)?.analyticType ?? null
}

function mapped(ctx: LedgerContext, key: AccountKey, errors: LedgerError[]): string | null {
  const code = ctx.map(key)
  if (!code) {
    errors.push(err("MAP_KEY_UNMAPPED", "accountKey", `La clave ${key} no está mapeada a ninguna cuenta del plan`))
    return null
  }
  return code
}

/** Fecha de un mes desplazado, conservando el día o el último del mes destino. */
function addMonths(date: LocalDate, months: number): LocalDate {
  const [y, m, d] = date.split("-").map(Number)
  const total = (y * 12 + (m - 1)) + months
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  const leap = (ny % 4 === 0 && ny % 100 !== 0) || ny % 400 === 0
  const dim = nm === 2 ? (leap ? 29 : 28) : nm === 4 || nm === 6 || nm === 9 || nm === 11 ? 30 : 31
  const nd = Math.min(d, dim)
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`
}

// ─────────────────────────────────────────────────────────────────────────────
// T-29 · DUA_IMPORTACION (R-IVA-18, O-16)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dos modalidades, y la diferencia entre ellas es una autoliquidación correcta o
 * una con **menos cuota devengada de la debida**:
 *
 * | Modalidad | Asiento |
 * |---|---|
 * | **Ordinaria** | `600/2xx (D)` aranceles · `472 (D)` cuota · `410`/`572 (H)` la suma. **Sin `477`** |
 * | **Con diferimiento** (art. 167.Dos LIVA) | `600/2xx (D)` · `472 (D)` · **`477 (H)`** · `410`/`572 (H)` aranceles |
 *
 * La base declarada es la del **DUA**, no la de la factura del proveedor: ésa ya
 * se contabilizó sin IVA como `FACTURA_RECIBIDA_EXTRACOM`.
 */
export function buildDuaImportacion(input: DuaImportacionInput, ctx: LedgerContext): Result<EntryDraft> {
  const errors: LedgerError[] = []

  const effect = duaVatEffect({
    customsValueCents: input.customsValueCents,
    dutiesCents: input.dutiesCents,
    vatQuotaCents: input.vatQuotaCents,
    importDeferral: input.importDeferral,
    periodKind: input.periodKind,
    investmentGood: input.investmentGood,
  })
  if (!effect.ok) return fail<EntryDraft>(...effect.errors)

  const dutiesCode = input.dutiesAccountCode ?? (input.dutiesCents > 0 ? mapped(ctx, "ARANCELES", errors) : null)
  const inputVatCode = mapped(ctx, "IVA_SOPORTADO", errors)
  const outputVatCode = effect.value.generatesOutputVat ? mapped(ctx, "IVA_REPERCUTIDO", errors) : null
  const payableCode = input.payableAccountCode ?? mapped(ctx, input.payableKey, errors)

  if (input.vatQuotaCents === 0) {
    errors.push(err("TEMPLATE_INPUT", "vatQuotaCents", "Un DUA sin cuota de IVA no se contabiliza con T-29"))
  }
  if (errors.length > 0) return fail<EntryDraft>(...errors)

  // Con diferimiento el importe a pagar es SÓLO el arancel: la cuota se
  // autoliquida (`472` contra `477`) y no se ingresa en la Aduana.
  const payableCents = input.importDeferral ? input.dutiesCents : input.dutiesCents + input.vatQuotaCents

  const lines: DraftLine[] = [
    ...(dutiesCode && input.dutiesCents > 0
      ? [
          debit(input.dutiesCents, {
            accountCode: dutiesCode,
            description: `Derechos arancelarios del DUA ${input.documentNumber}`,
            analyticType: analyticFor(ctx, dutiesCode, input.analyticType),
            ...templateDestination(ctx, "G_A", {
              projectId: input.projectId ?? null,
              costCenterId: input.costCenterId ?? null,
            }),
          }),
        ]
      : []),
    debit(input.vatQuotaCents, {
      accountCode: inputVatCode!,
      taxBaseCents: effect.value.taxableBaseCents,
      description: `IVA a la importación · DUA ${input.documentNumber}`,
    }),
    ...(outputVatCode
      ? [
          credit(input.vatQuotaCents, {
            accountCode: outputVatCode,
            taxBaseCents: effect.value.taxableBaseCents,
            description: `IVA a la importación con diferimiento (casilla 77) · DUA ${input.documentNumber}`,
          }),
        ]
      : []),
    ...(payableCents > 0
      ? [
          credit(payableCents, {
            accountCode: payableCode!,
            counterpartyId: input.counterpartyId ?? null,
            dueDate: input.dueDate ?? null,
          }),
        ]
      : []),
  ]

  return buildEntry(
    {
      organizationId: ctx.organizationId,
      documentDate: input.documentDate,
      accrualDate: input.accrualDate ?? null,
      entryDate: input.entryDate ?? null,
      description: input.description ?? `DUA de importación ${input.documentNumber}`,
      kind: "NORMAL",
      sourceType: "DOCUMENT",
      sourceId: input.documentNumber,
      templateCode: "DUA_IMPORTACION",
      lines,
    },
    ctx
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// T-30 · DIFERENCIAS_CAMBIO_CIERRE (R-FX-1…6, O-4/O-5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `Δ > 0` ⇒ `cuenta (D) / 768 (H)`; `Δ < 0` ⇒ `668 (D) / cuenta (H)`. El signo se
 * resuelve solo, **sin distinguir activo de pasivo** (R-FX-3): una deuda en
 * dólares cuyo contravalor en euros baja produce un beneficio, y la aritmética
 * ya lo dice.
 *
 * Cada línea de la partida lleva `originalCurrency` y **`originalAmountCents = 0`**
 * (R-FX-4: en la moneda de la cuenta no se mueve nada) y el `exchangeRateId` de
 * la tasa efectiva del cierre, que queda **sellada en el asiento** (R-FX-5).
 * Las contrapartidas de `668` y `768` se agregan en una línea cada una.
 */
export function buildDiferenciasCambio(input: DiferenciasCambioInput, ctx: LedgerContext): Result<EntryDraft> {
  const errors: LedgerError[] = []
  const moving = input.adjustments.filter((a) => a.deltaCents !== 0)
  if (moving.length === 0) {
    errors.push(
      err("TEMPLATE_INPUT", "adjustments", "Ninguna posición tiene diferencia de cambio: no hay asiento que postear")
    )
  }
  const gains = sumCents(moving.filter((a) => a.deltaCents > 0).map((a) => a.deltaCents))
  const losses = sumCents(moving.filter((a) => a.deltaCents < 0).map((a) => -a.deltaCents))
  const gainCode = gains > 0 ? mapped(ctx, "DIFERENCIA_CAMBIO_POSITIVA", errors) : null
  const lossCode = losses > 0 ? mapped(ctx, "DIFERENCIA_CAMBIO_NEGATIVA", errors) : null
  if (errors.length > 0) return fail<EntryDraft>(...errors)

  // Orden canónico: cuenta, contraparte, divisa. El asiento no puede depender
  // de cómo el llamante haya leído las posiciones (P7).
  const sorted = [...moving].sort(
    (a, b) =>
      (a.accountCode < b.accountCode ? -1 : a.accountCode > b.accountCode ? 1 : 0) ||
      ((a.counterpartyId ?? "") < (b.counterpartyId ?? "") ? -1 : (a.counterpartyId ?? "") > (b.counterpartyId ?? "") ? 1 : 0) ||
      (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0)
  )

  // E4 · T6: 668/768 son FINANCIERO — columna propia y nivel BAI (R-A5/R-A6).
  const dest = templateDestination(ctx, "FINANCIERO", { costCenterId: input.financialCostCenterId ?? null })

  const positionLines: DraftLine[] = sorted.map((a) => {
    const rest = {
      accountCode: a.accountCode,
      counterpartyId: a.counterpartyId ?? null,
      description: `Diferencia de cambio al cierre ${input.cutoff} · ${a.currency} (tasa de ${a.rateDate})`,
      originalCurrency: a.currency,
      originalAmountCents: 0,
      exchangeRateId: a.exchangeRateId,
    }
    return a.deltaCents > 0 ? debit(a.deltaCents, rest) : credit(-a.deltaCents, rest)
  })

  const lines: DraftLine[] = [
    ...positionLines,
    ...(lossCode
      ? [debit(losses, { accountCode: lossCode, analyticType: analyticFor(ctx, lossCode), ...dest })]
      : []),
    ...(gainCode
      ? [credit(gains, { accountCode: gainCode, analyticType: analyticFor(ctx, gainCode), ...dest })]
      : []),
  ]

  return buildEntry(
    {
      organizationId: ctx.organizationId,
      entryDate: input.entryDate ?? input.cutoff,
      description: input.description ?? `Diferencias de cambio al cierre de ${input.cutoff} (NRV 11ª.2.2)`,
      kind: "NORMAL",
      sourceType: "SYSTEM",
      sourceId: input.cutoff,
      templateCode: "DIFERENCIAS_CAMBIO_CIERRE",
      lines,
    },
    ctx
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// T-31 · AJUSTE_VALOR_ACTUAL (R-VA-1…6, O-1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **Caso A** (alta del ejercicio en curso): se reduce el coste del activo contra
 * la deuda, se revierte la amortización dotada en exceso sobre el coste bruto y
 * se reconoce el interés implícito devengado hasta el corte.
 *
 * **Caso C** (origen no inmovilizado): contra el gasto o el ingreso original.
 *
 * **Caso B** (alta de un ejercicio ya cerrado) **no se postea aquí**: es un error
 * de ejercicios anteriores (NRV 22ª) y va por **T-22** contra `113`, con
 * reexpresión del comparativo. Pedirlo a T-31 devuelve error con la salida.
 */
export function buildAjusteValorActual(input: AjusteValorActualInput, ctx: LedgerContext): Result<EntryDraft> {
  const errors: LedgerError[] = []
  const isLiability = input.side === "PASIVO"

  const positionCode =
    input.positionAccountCode ?? (input.positionKey ? mapped(ctx, input.positionKey, errors) : null)
  if (!positionCode) {
    errors.push(
      err("ACCOUNT_UNKNOWN", "positionAccountCode", "El ajuste necesita la cuenta de la deuda o del crédito aplazado")
    )
  }

  const isCaseA = input.case === "A_EJERCICIO_CORRIENTE"
  if (isCaseA && !input.assetAccountCode) {
    errors.push(
      err("TEMPLATE_INPUT", "assetAccountCode", "El caso A reduce el coste del inmovilizado: falta la cuenta 2xx")
    )
  }
  if (!isCaseA && !input.originAccountCode) {
    errors.push(
      err("TEMPLATE_INPUT", "originAccountCode", "El caso C ajusta el gasto o el ingreso original: falta su cuenta")
    )
  }
  if (input.excessDepreciationCents > 0 && (!input.accumulatedAccountCode || !input.depreciationExpenseAccountCode)) {
    errors.push(
      err(
        "TEMPLATE_INPUT",
        "accumulatedAccountCode",
        "Revertir la amortización en exceso necesita la cuenta 28x y la de dotación 68x"
      )
    )
  }
  if (input.excessDepreciationCents > 0 && !isCaseA) {
    errors.push(
      err("TEMPLATE_INPUT", "excessDepreciationCents", "Sólo el caso A revierte amortización: el caso C no amortiza")
    )
  }

  const interestCode =
    input.implicitInterestCents > 0
      ? isLiability
        ? mapped(ctx, "INTERESES_DEUDAS", errors)
        : mapped(ctx, "INGRESOS_CREDITOS", errors)
      : null
  if (errors.length > 0) return fail<EntryDraft>(...errors)

  const counterpartCode = (isCaseA ? input.assetAccountCode : input.originAccountCode) as string
  const discountRest = {
    counterpartyId: input.counterpartyId ?? null,
    description: `Valor actual del aplazamiento (NRV ${isLiability ? "9ª.3.1" : "9ª.2.2"})`,
  }

  // El descuento reduce el pasivo (cargo) o el activo (abono); la contrapartida
  // es el coste del inmovilizado (caso A) o el gasto/ingreso original (caso C).
  const discountLines: DraftLine[] = isLiability
    ? [
        debit(input.discountCents, { accountCode: positionCode!, ...discountRest }),
        credit(input.discountCents, {
          accountCode: counterpartCode,
          analyticType: isCaseA ? null : analyticFor(ctx, counterpartCode, input.analyticType),
          ...(isCaseA
            ? { projectId: null, costCenterId: null }
            : templateDestination(ctx, "G_A", {
                projectId: input.projectId ?? null,
                costCenterId: input.costCenterId ?? null,
              })),
        }),
      ]
    : [
        debit(input.discountCents, {
          accountCode: counterpartCode,
          analyticType: isCaseA ? null : analyticFor(ctx, counterpartCode, input.analyticType),
          ...(isCaseA
            ? { projectId: null, costCenterId: null }
            : templateDestination(ctx, "G_A", {
                projectId: input.projectId ?? null,
                costCenterId: input.costCenterId ?? null,
              })),
        }),
        credit(input.discountCents, { accountCode: positionCode!, ...discountRest }),
      ]

  const excess = input.excessDepreciationCents
  const excessLines: AssetDraftLine[] =
    excess > 0
      ? [
          {
            ...debit(excess, {
              accountCode: input.accumulatedAccountCode!,
              description: "Reversión de la amortización dotada sobre el coste bruto",
            }),
            fixedAssetId: input.fixedAssetId ?? null,
          },
          {
            ...credit(excess, {
              accountCode: input.depreciationExpenseAccountCode!,
              description: "Reversión de la amortización dotada sobre el coste bruto",
              analyticType: analyticFor(ctx, input.depreciationExpenseAccountCode!),
              projectId: input.projectId ?? null,
              costCenterId: input.costCenterId ?? null,
            }),
            fixedAssetId: input.fixedAssetId ?? null,
          },
        ]
      : []

  const interest = input.implicitInterestCents
  const interestLines: DraftLine[] =
    interest > 0 && interestCode
      ? isLiability
        ? [
            debit(interest, {
              accountCode: interestCode,
              description: "Interés implícito devengado del aplazamiento",
              analyticType: analyticFor(ctx, interestCode),
              ...templateDestination(ctx, "FINANCIERO"),
            }),
            credit(interest, { accountCode: positionCode!, counterpartyId: input.counterpartyId ?? null }),
          ]
        : [
            debit(interest, { accountCode: positionCode!, counterpartyId: input.counterpartyId ?? null }),
            credit(interest, {
              accountCode: interestCode,
              description: "Interés implícito devengado del aplazamiento",
              analyticType: analyticFor(ctx, interestCode),
              ...templateDestination(ctx, "FINANCIERO"),
            }),
          ]
      : []

  return buildEntry(
    {
      organizationId: ctx.organizationId,
      documentDate: input.documentDate ?? null,
      entryDate: input.entryDate,
      description: input.description ?? "Ajuste al valor actual del aplazamiento (NRV 2ª.1 y 9ª.3.1)",
      kind: "NORMAL",
      sourceType: "SYSTEM",
      templateCode: "AJUSTE_VALOR_ACTUAL",
      lines: [...discountLines, ...excessLines, ...interestLines],
    },
    ctx
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// T-32 · RECLASIFICACION_VENCIMIENTOS (R-RC-1…7, O-7/O-8)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Suma cero **por par y por contraparte** (I-E9-16): el asiento no crea ni
 * destruye saldo, sólo lo presenta donde la norma 6ª de elaboración de las
 * cuentas anuales exige. Su contra-asiento es el nº 2 del ejercicio siguiente
 * (R-RC-6), y eso lo orquesta el cierre, no la plantilla.
 */
export function buildReclasificacionVencimientos(
  input: ReclasificacionVencimientosInput,
  ctx: LedgerContext
): Result<EntryDraft> {
  const errors: LedgerError[] = []
  for (const [index, m] of input.moves.entries()) {
    if (m.fromAccountCode === m.toAccountCode) {
      errors.push(
        err("TEMPLATE_INPUT", "toAccountCode", `El movimiento ${index + 1} reclasifica una cuenta sobre sí misma`)
      )
    }
  }
  if (errors.length > 0) return fail<EntryDraft>(...errors)

  const sorted = [...input.moves].sort(
    (a, b) =>
      (a.fromAccountCode < b.fromAccountCode ? -1 : a.fromAccountCode > b.fromAccountCode ? 1 : 0) ||
      (a.toAccountCode < b.toAccountCode ? -1 : a.toAccountCode > b.toAccountCode ? 1 : 0) ||
      ((a.counterpartyId ?? "") < (b.counterpartyId ?? "") ? -1 : (a.counterpartyId ?? "") > (b.counterpartyId ?? "") ? 1 : 0)
  )

  const lines: DraftLine[] = []
  for (const m of sorted) {
    const rest = {
      counterpartyId: m.counterpartyId ?? null,
      dueDate: m.dueDate ?? null,
      description: `Reclasificación por vencimiento a ${input.cutoff} · ${m.fromAccountCode} → ${m.toAccountCode}`,
    }
    // Una deuda se reclasifica cargando el origen y abonando el destino; un
    // crédito, al revés. El saldo neto de cada par no se mueve un céntimo.
    if (m.side === "PASIVO") {
      lines.push(debit(m.amountCents, { accountCode: m.fromAccountCode, ...rest }))
      lines.push(credit(m.amountCents, { accountCode: m.toAccountCode, ...rest }))
    } else {
      lines.push(debit(m.amountCents, { accountCode: m.toAccountCode, ...rest }))
      lines.push(credit(m.amountCents, { accountCode: m.fromAccountCode, ...rest }))
    }
  }

  return buildEntry(
    {
      organizationId: ctx.organizationId,
      entryDate: input.entryDate ?? input.cutoff,
      description:
        input.description ?? `Reclasificación de deudas y créditos por vencimiento a ${input.cutoff} (norma 6ª)`,
      kind: "NORMAL",
      sourceType: "SYSTEM",
      sourceId: input.cutoff,
      templateCode: "RECLASIFICACION_VENCIMIENTOS",
      lines,
    },
    ctx
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// T-33 · BAJA_INMOVILIZADO · T-34 · VENTA_INMOVILIZADO (R-AM-6/R-AM-7, O-24)
// ─────────────────────────────────────────────────────────────────────────────

type DisposalCommon = BajaInmovilizadoInput

/** VNC = coste − amortización acumulada − deterioro, con las tres validaciones. */
function netBookValueOf(input: DisposalCommon, errors: LedgerError[]): Cents {
  const net = input.acquisitionCostCents - input.accumulatedCents - input.impairmentCents
  if (input.accumulatedCents > input.acquisitionCostCents) {
    errors.push(
      err(
        "TEMPLATE_INPUT",
        "accumulatedCents",
        `La amortización acumulada de ${input.assetCode} (${input.accumulatedCents}) supera su coste ` +
          `(${input.acquisitionCostCents})`
      )
    )
  }
  if (net < 0) {
    errors.push(
      err("TEMPLATE_INPUT", "impairmentCents", `El valor neto contable de ${input.assetCode} es negativo (${net})`)
    )
  }
  if (input.impairmentCents > 0 && !input.impairmentAccountCode) {
    errors.push(err("TEMPLATE_INPUT", "impairmentAccountCode", "Cancelar el deterioro necesita su cuenta 29x"))
  }
  return net
}

/**
 * **R-AM-6.** Baja sin contraprestación (desguace, siniestro sin indemnización).
 * *(ejemplo del experto: coste 1 000 000, acumulada 640 000 ⇒ `2811 (D) 640 000`
 * · `671 (D) 360 000` · `2131 (H) 1 000 000`.)*
 *
 * La dotación **hasta el mes de la baja inclusive** se postea antes con T-14: no
 * se mezcla con la baja, para que el cuadro y el diario digan lo mismo.
 */
export function buildBajaInmovilizado(input: BajaInmovilizadoInput, ctx: LedgerContext): Result<EntryDraft> {
  const errors: LedgerError[] = []
  const netBookValue = netBookValueOf(input, errors)
  const lossCode = netBookValue > 0 ? mapped(ctx, "PERDIDA_BAJA_INMOVILIZADO", errors) : null
  if (errors.length > 0) return fail<EntryDraft>(...errors)

  const asset = input.fixedAssetId ?? null
  const lines: AssetDraftLine[] = [
    {
      ...debit(input.accumulatedCents, {
        accountCode: input.accumulatedAccountCode,
        description: `Cancelación de la amortización acumulada de ${input.assetCode}`,
      }),
      fixedAssetId: asset,
    },
    ...(input.impairmentCents > 0
      ? [
          debit(input.impairmentCents, {
            accountCode: input.impairmentAccountCode!,
            description: `Cancelación del deterioro de ${input.assetCode}`,
          }),
        ]
      : []),
    ...(lossCode
      ? [
          {
            ...debit(netBookValue, {
              accountCode: lossCode,
              description: `Pérdida por la baja de ${input.assetCode}`,
              analyticType: analyticFor(ctx, lossCode, input.analyticType),
              projectId: input.projectId ?? null,
              costCenterId: input.costCenterId ?? null,
            }),
            fixedAssetId: asset,
          },
        ]
      : []),
    {
      ...credit(input.acquisitionCostCents, {
        accountCode: input.assetAccountCode,
        description: `Baja del inmovilizado ${input.assetCode}`,
      }),
      fixedAssetId: asset,
    },
  ]

  return buildEntry(
    {
      organizationId: ctx.organizationId,
      documentDate: input.documentDate,
      entryDate: input.entryDate ?? input.documentDate,
      description: input.description ?? `Baja del inmovilizado ${input.assetCode}`,
      kind: "NORMAL",
      sourceType: "SYSTEM",
      sourceId: input.fixedAssetId ?? input.assetCode,
      templateCode: "BAJA_INMOVILIZADO",
      lines,
    },
    ctx
  )
}

/**
 * **R-AM-7.** Venta. *(ejemplo del experto: precio 500 000 + IVA 105 000, coste
 * 1 000 000, acumulada 640 000 ⇒ `543 (D) 605 000` · `2811 (D) 640 000` ·
 * `2131 (H) 1 000 000` · `477 (H) 105 000` · `771 (H) 140 000`.)*
 *
 * La contrapartida es `543` —o `253` si el aplazamiento supera el año—, **nunca
 * `430`**: `430` recoge créditos de la actividad ordinaria y meter ahí la venta
 * de una furgoneta contamina el *aging*, el DSO y el PMC.
 */
export function buildVentaInmovilizado(input: VentaInmovilizadoInput, ctx: LedgerContext): Result<EntryDraft> {
  const errors: LedgerError[] = []
  const netBookValue = netBookValueOf(input, errors)
  const receivableCode = input.receivableAccountCode ?? mapped(ctx, input.receivableKey, errors)
  const vatCode = input.vatQuotaCents > 0 ? mapped(ctx, "IVA_REPERCUTIDO", errors) : null

  const result = input.priceCents - netBookValue
  const gainCode = result > 0 ? mapped(ctx, "BENEFICIO_BAJA_INMOVILIZADO", errors) : null
  const lossCode = result < 0 ? mapped(ctx, "PERDIDA_BAJA_INMOVILIZADO", errors) : null

  let taxRateId: string | null = null
  if (input.taxRateCode) {
    const rate = ctx.rates.find((r) => r.code === input.taxRateCode)
    if (!rate) {
      errors.push(err("TAX_RATE_NOT_IN_FORCE", "taxRateCode", `El tipo ${input.taxRateCode} no existe en la organización`))
    } else {
      taxRateId = rate.id
    }
  }
  if (errors.length > 0) return fail<EntryDraft>(...errors)

  const asset = input.fixedAssetId ?? null
  const dest = {
    analyticType: null as AnalyticType | null,
    projectId: input.projectId ?? null,
    costCenterId: input.costCenterId ?? null,
  }

  const lines: AssetDraftLine[] = [
    debit(input.priceCents + input.vatQuotaCents, {
      accountCode: receivableCode!,
      counterpartyId: input.counterpartyId ?? null,
      dueDate: input.dueDate ?? null,
      description: `Enajenación de ${input.assetCode}`,
    }),
    {
      ...debit(input.accumulatedCents, {
        accountCode: input.accumulatedAccountCode,
        description: `Cancelación de la amortización acumulada de ${input.assetCode}`,
      }),
      fixedAssetId: asset,
    },
    ...(input.impairmentCents > 0
      ? [
          debit(input.impairmentCents, {
            accountCode: input.impairmentAccountCode!,
            description: `Cancelación del deterioro de ${input.assetCode}`,
          }),
        ]
      : []),
    ...(lossCode
      ? [
          {
            ...debit(-result, {
              accountCode: lossCode,
              description: `Pérdida en la enajenación de ${input.assetCode}`,
              ...dest,
              analyticType: analyticFor(ctx, lossCode, input.analyticType),
            }),
            fixedAssetId: asset,
          },
        ]
      : []),
    {
      ...credit(input.acquisitionCostCents, {
        accountCode: input.assetAccountCode,
        description: `Baja del inmovilizado ${input.assetCode}`,
      }),
      fixedAssetId: asset,
    },
    ...(vatCode
      ? [
          credit(input.vatQuotaCents, {
            accountCode: vatCode,
            taxRateId,
            taxBaseCents: input.priceCents,
            description: `IVA repercutido en la enajenación de ${input.assetCode}`,
          }),
        ]
      : []),
    ...(gainCode
      ? [
          {
            ...credit(result, {
              accountCode: gainCode,
              description: `Beneficio en la enajenación de ${input.assetCode}`,
              ...dest,
              analyticType: analyticFor(ctx, gainCode, input.analyticType),
            }),
            fixedAssetId: asset,
          },
        ]
      : []),
  ]

  return buildEntry(
    {
      organizationId: ctx.organizationId,
      documentDate: input.documentDate,
      entryDate: input.entryDate ?? input.documentDate,
      description: input.description ?? `Venta del inmovilizado ${input.assetCode}`,
      kind: "NORMAL",
      sourceType: "DOCUMENT",
      sourceId: input.fixedAssetId ?? input.assetCode,
      templateCode: "VENTA_INMOVILIZADO",
      lines,
    },
    ctx
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// T-35 · DISTRIBUCION_RESULTADO (§4.9, O-18)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * *(ejemplo del experto: beneficio 1 497 322, capital 3 000 000, `112` previa
 * 400 000 ⇒ reserva legal `min(149 732; 200 000) = 149 732`; dividendo 500 000 ⇒
 * `129 (D) 1 497 322 / 112 (H) 149 732 / 113 (H) 847 590 / 526 (H) 500 000`.)*
 *
 * La **reserva legal** llega calculada por `lib/closing/distribution.ts` (art.
 * 274 LSC) y la plantilla comprueba, con tolerancia 0, que el reparto agota el
 * resultado: un `129` que sobrevive a su distribución es la omisión que hace que
 * el patrimonio neto sea incorrecto desde el segundo ejercicio.
 */
export function buildDistribucionResultado(
  input: DistribucionResultadoInput,
  ctx: LedgerContext
): Result<EntryDraft> {
  const errors: LedgerError[] = []
  const resultCode = mapped(ctx, "RESULTADO_EJERCICIO", errors)

  if (input.profitCents > 0 && input.lossCents > 0) {
    errors.push(err("TEMPLATE_INPUT", "lossCents", "Un ejercicio no cierra con beneficio y pérdida a la vez"))
  }
  if (input.profitCents === 0 && input.lossCents === 0) {
    errors.push(err("TEMPLATE_INPUT", "profitCents", "No hay resultado que distribuir"))
  }

  const dividendPayable = input.dividendCents - input.interimDividendPaidCents
  if (dividendPayable < 0) {
    errors.push(
      err(
        "TEMPLATE_INPUT",
        "interimDividendPaidCents",
        `El dividendo a cuenta ya satisfecho (${input.interimDividendPaidCents}) supera el dividendo acordado ` +
          `(${input.dividendCents})`
      )
    )
  }

  const applied =
    input.legalReserveCents +
    input.voluntaryReserveCents +
    input.remainderCents +
    input.dividendCents +
    input.priorLossesOffsetCents
  if (input.profitCents > 0 && applied !== input.profitCents) {
    errors.push(
      err(
        "TEMPLATE_INPUT",
        "profitCents",
        `El reparto (${applied}) no agota el resultado del ejercicio (${input.profitCents}): la diferencia es ` +
          `${input.profitCents - applied} céntimos`,
        { check: "I-E9-23" }
      )
    )
  }
  if (input.lossCents > 0 && applied !== 0) {
    errors.push(
      err("TEMPLATE_INPUT", "lossCents", "Una pérdida no se reparte: sólo se traslada a resultados negativos (121)")
    )
  }

  const legalCode = input.legalReserveCents > 0 ? mapped(ctx, "RESERVA_LEGAL", errors) : null
  const voluntaryCode = input.voluntaryReserveCents > 0 ? mapped(ctx, "RESERVAS_VOLUNTARIAS", errors) : null
  const remainderCode = input.remainderCents > 0 ? mapped(ctx, "REMANENTE", errors) : null
  const dividendCode = dividendPayable > 0 ? mapped(ctx, "DIVIDENDO_ACTIVO_A_PAGAR", errors) : null
  const interimCode =
    input.interimDividendPaidCents > 0 ? mapped(ctx, "DIVIDENDO_ACTIVO_A_CUENTA", errors) : null
  const priorLossesCode =
    input.priorLossesOffsetCents > 0 || input.lossCents > 0
      ? mapped(ctx, "RESULTADOS_NEGATIVOS_ANTERIORES", errors)
      : null
  if (errors.length > 0) return fail<EntryDraft>(...errors)

  const lines: DraftLine[] =
    input.lossCents > 0
      ? [
          // Pérdida: `121 (D) / 129 (H)`. No hay reparto que hacer.
          debit(input.lossCents, {
            accountCode: priorLossesCode!,
            description: "Traslado de la pérdida a resultados negativos de ejercicios anteriores",
          }),
          credit(input.lossCents, { accountCode: resultCode! }),
        ]
      : [
          debit(input.profitCents, {
            accountCode: resultCode!,
            description: `Distribución del resultado acordada por la junta de ${input.entryDate}`,
          }),
          ...(legalCode
            ? [
                credit(input.legalReserveCents, {
                  accountCode: legalCode,
                  description: "Dotación de la reserva legal (art. 274 LSC)",
                }),
              ]
            : []),
          ...(voluntaryCode ? [credit(input.voluntaryReserveCents, { accountCode: voluntaryCode })] : []),
          ...(priorLossesCode && input.priorLossesOffsetCents > 0
            ? [
                credit(input.priorLossesOffsetCents, {
                  accountCode: priorLossesCode,
                  description: "Compensación de pérdidas de ejercicios anteriores",
                }),
              ]
            : []),
          ...(remainderCode ? [credit(input.remainderCents, { accountCode: remainderCode })] : []),
          // El dividendo a cuenta ya satisfecho es una cuenta DEUDORA que minoró
          // el patrimonio durante el ejercicio: aquí se cancela.
          ...(interimCode
            ? [
                credit(input.interimDividendPaidCents, {
                  accountCode: interimCode,
                  description: "Cancelación del dividendo a cuenta ya satisfecho",
                }),
              ]
            : []),
          ...(dividendCode
            ? [
                credit(dividendPayable, {
                  accountCode: dividendCode,
                  description: "Dividendo acordado pendiente de pago (art. 273 LSC)",
                }),
              ]
            : []),
        ]

  return buildEntry(
    {
      organizationId: ctx.organizationId,
      documentDate: input.documentDate ?? null,
      entryDate: input.entryDate,
      description: input.description ?? `Distribución del resultado (junta de ${input.entryDate}, art. 164 LSC)`,
      kind: "NORMAL",
      sourceType: "SYSTEM",
      sourceId: input.entryDate,
      templateCode: "DISTRIBUCION_RESULTADO",
      lines,
    },
    ctx
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// T-36 · DEVENGO_RECC (R-IVA-19, O-14)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * El barrido del 31 de diciembre del art. 163 *terdecies* LIVA **es un asiento**,
 * no un aviso: toda factura del año inmediato anterior con cuota pendiente
 * devenga (`4778 → 477`) o deduce (`4728 → 472`) lo que le queda, y se postea
 * **antes** de la última liquidación de ese periodo. Las líneas las produce
 * `reccYearEndSweep`, que es la misma función que usa el checklist: no hay dos
 * aritméticas que puedan divergir.
 */
export function buildDevengoRecc(input: DevengoReccInput, ctx: LedgerContext): Result<EntryDraft> {
  const lines = reccYearEndSweep(
    input.pending.map((p) => ({
      id: p.id,
      side: p.side,
      documentNumber: p.documentNumber,
      operationDate: p.operationDate,
      totalQuotaCents: p.totalQuotaCents,
      accruedCents: p.accruedCents,
    })),
    input.cutoff
  )
  if (lines.length === 0) {
    return fail<EntryDraft>(
      err(
        "TEMPLATE_INPUT",
        "pending",
        `Ninguna factura en RECC del año anterior a ${input.cutoff} conserva cuota pendiente: no hay barrido`,
        { check: "R-IVA-19" }
      )
    )
  }

  return buildEntry(
    {
      organizationId: ctx.organizationId,
      entryDate: input.entryDate ?? input.cutoff,
      description:
        input.description ?? `Devengo del RECC pendiente a ${input.cutoff} (art. 163 terdecies LIVA)`,
      kind: "NORMAL",
      sourceType: "SYSTEM",
      sourceId: input.cutoff,
      templateCode: "DEVENGO_RECC",
      lines,
    },
    ctx
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// T-37 · ALTA_PRESTAMO (R-RC-4, O-6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **El desglose de vencimientos es obligatorio.** Una línea de `170`/`520` por
 * vencimiento de principal, cada una con su `dueDate`: es el mismo patrón que la
 * decisión 6 de E3 §6.6 para las facturas a plazos, y con él la reclasificación
 * de T-32 funciona sin cambios. Sin desglose, el balance presenta **cero** en
 * «Deudas con entidades de crédito a corto plazo» teniendo préstamos vivos, que
 * es lo primero que un auditor comprueba (I-E9-25).
 *
 * El **interés** no se registra en el alta: se devenga por el cuadro (R-PE-6).
 */
export function buildAltaPrestamo(input: AltaPrestamoInput, ctx: LedgerContext): Result<EntryDraft> {
  const errors: LedgerError[] = []
  const bankCode = input.bankAccountCode ?? mapped(ctx, input.bankKey, errors)
  const feeCode =
    input.arrangementFeeCents > 0
      ? (input.arrangementFeeAccountCode ?? mapped(ctx, "COMISIONES_BANCARIAS", errors))
      : null

  const scheduled = sumCents(input.installments.map((i) => i.principalCents))
  if (scheduled !== input.principalCents) {
    errors.push(
      err(
        "TEMPLATE_INPUT",
        "installments",
        `El cuadro suma ${scheduled} céntimos de principal y el préstamo es de ${input.principalCents}: ` +
          "el desglose de vencimientos tiene que agotar el principal (tolerancia 0)",
        { check: "I-E9-25" }
      )
    )
  }
  const seqs = input.installments.map((i) => i.seq)
  if (new Set(seqs).size !== seqs.length) {
    errors.push(err("TEMPLATE_INPUT", "installments", "Hay vencimientos con el mismo número de orden"))
  }
  if (input.arrangementFeeCents >= input.principalCents) {
    errors.push(
      err("TEMPLATE_INPUT", "arrangementFeeCents", "La comisión de apertura no puede agotar el principal recibido")
    )
  }
  if (input.longAccountCode === input.shortAccountCode) {
    errors.push(
      err("TEMPLATE_INPUT", "shortAccountCode", "El par de la deuda necesita una cuenta a largo y otra a corto")
    )
  }
  if (errors.length > 0) return fail<EntryDraft>(...errors)

  // Frontera corriente / no corriente MEDIDA DESDE EL ALTA (norma 6ª): el
  // vencimiento posterior al umbral nace en `170`, el resto en `520`. Al cierre,
  // T-32 vuelve a medirla desde la fecha de corte, que es lo que la norma pide.
  const boundary = addMonths(input.documentDate, input.currentThresholdMonths)
  const ordered = [...input.installments].sort((a, b) =>
    a.dueDate !== b.dueDate ? (a.dueDate < b.dueDate ? -1 : 1) : a.seq - b.seq
  )

  const lines: DraftLine[] = [
    debit(input.principalCents - input.arrangementFeeCents, {
      accountCode: bankCode!,
      description: `Disposición del préstamo ${input.scheduleCode}`,
    }),
    ...(feeCode
      ? [
          debit(input.arrangementFeeCents, {
            accountCode: feeCode,
            description: `Comisión de apertura del préstamo ${input.scheduleCode}`,
            analyticType: analyticFor(ctx, feeCode),
            ...templateDestination(ctx, "G_A", { costCenterId: input.arrangementFeeCostCenterId ?? null }),
          }),
        ]
      : []),
    ...ordered.map((i) =>
      credit(i.principalCents, {
        accountCode: i.dueDate > boundary ? input.longAccountCode : input.shortAccountCode,
        counterpartyId: input.counterpartyId ?? null,
        dueDate: i.dueDate,
        description: `${input.scheduleCode} · vencimiento ${String(i.seq).padStart(3, "0")} (${i.dueDate})`,
      })
    ),
  ]

  return buildEntry(
    {
      organizationId: ctx.organizationId,
      documentDate: input.documentDate,
      entryDate: input.entryDate ?? input.documentDate,
      description: input.description ?? `Alta del préstamo ${input.scheduleCode} con su cuadro de vencimientos`,
      kind: "NORMAL",
      sourceType: "MANUAL",
      sourceId: input.scheduleCode,
      templateCode: "ALTA_PRESTAMO",
      lines,
    },
    ctx
  )
}
