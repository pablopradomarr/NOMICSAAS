/**
 * E8 · T9 — De la propuesta reconciliada al borrador de asiento
 * (`docs/design/E8-documentos-asientos.md` §3.4, ADR-0014 D3, D6, D9, D12, D13).
 *
 * Módulo **PURO**: sin IO, sin Prisma, sin LLM, sin `Date.now()`.
 *
 * **Este fichero no reimplementa nada del motor de E3.** Su trabajo es traducir
 * un documento —ya recalculado y clasificado por `reconcile()`— al input de la
 * plantilla que le corresponde de las 28 de E3, y dejar que `buildFromTemplate`
 * aplique C-1…C-13 y `checkDraft`. Lo que sí decide, y son las cinco decisiones
 * que el experto contable corrigió en la ronda 2:
 *
 *  1. **Qué plantilla** (`TEMPLATE_FOR_DOC`): el ticket va contra tesorería y no
 *     contra 410; la importación no es ISP; el anticipo de cliente sin cobro no
 *     lleva 477; una nómina o un extracto **no tienen plantilla de compra**; y un
 *     documento de ejercicio cerrado se desvía a T-22 **por fecha**.
 *  2. **Contra qué pasivo**, línea a línea y no documento a documento (O-3): 60x
 *     a 400, 62x/63x/66x/69x a 410, **grupo 2 a 523 siempre en el alta**, el
 *     empleado a 465 y el ticket a 570/572. El céntimo huérfano del reparto cae
 *     en el bloque de mayor importe (Hamilton, criterio de I5).
 *  3. **Qué cuota**: la del documento, vía `taxOverrides` (ADR-0014 D3). *No hay
 *     línea de 669/769 por residuo de IVA*: con la cuota del documento el
 *     asiento cuadra por construcción. Quien lea esto y sienta el impulso de
 *     «arreglar» un céntimo llevándolo a 669, que lea antes D3.ii: 669 es
 *     epígrafe 15, gasto financiero, y el IVA no lo es.
 *  4. **Qué retención**: la del **régimen de la contraparte**, sobre la base sin
 *     suplidos (O-11 y O-12), con la clave de cuenta del modelo 111 o del 115.
 *  5. **En qué moneda**: con divisa, cada línea monetaria sale con su
 *     `originalCurrency`, su importe original y la tasa persistida, y el residuo
 *     de conversión **se elimina por construcción** repartiéndolo entre las
 *     cuotas por mayor resto (ADR-0014 D2). Cero líneas de ajuste.
 */

import { applyBps } from "@/lib/taxes/bps"
import { deducible, type TaxOverride } from "@/lib/ledger/tax"
import { buildFromTemplate } from "@/lib/ledger/templates"
import { lineTaxes, splitPayableBlocks } from "@/lib/ledger/templates/documento"
import type { PayableKey } from "@/lib/ledger/templates/schemas"
import type { TemplateCode } from "@/lib/ledger/templates/types"
import {
  Cents,
  EntryDraft,
  err,
  fail,
  LedgerContext,
  LedgerError,
  LocalDate,
  ok,
  Result,
  SourceType,
} from "@/lib/ledger/types"
import type { AccountKey } from "@/lib/accounts/types"
import { convertWithRate, type ConversionRef, type ReconcileResult } from "@/lib/extraction/reconcile"
import { convertDocumentToBase, type ConvertedDocument } from "@/lib/fx/convert"
import type { Cents as ProposalCents, Deductibility, DocKind, ProposalLine } from "@/lib/extraction/types"

// ─────────────────────────────────────────────────────────────────────────────
// Tabla `docKind → plantilla` (§1.1 de la validación contable)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `null` **explícito** no es un olvido: es la afirmación de que ese documento
 * NO se contabiliza con una plantilla de compra. Una nómina, un RLC/RNT o un
 * extracto bancario traen cifras calculadas por un tercero (P1) y entran por
 * T-10 o por la conciliación de E7; un DUA lo liquida su propio asiento (T-20,
 * plantilla propia en E9); y un `DESCONOCIDO` lo decide una persona.
 */
export const TEMPLATE_FOR_DOC: Readonly<Record<DocKind, TemplateCode | null>> = {
  FACTURA_RECIBIDA: "FACTURA_RECIBIDA",
  FACTURA_RECIBIDA_ISP: "FACTURA_RECIBIDA_ISP",
  /** Bien de tercer país: base sin IVA contra 400/523. **El IVA lo liquida el DUA.** */
  FACTURA_RECIBIDA_EXTRACOM: "FACTURA_RECIBIDA",
  DUA_IMPORTACION: null,
  ABONO_RECIBIDO: "ABONO_RECIBIDO",
  /** Contrapartida de TESORERÍA y deducibilidad NONE por defecto (D9). */
  TICKET: "FACTURA_RECIBIDA",
  /** Contrapartida del gasto = 407. **No T-07**: T-07 mueve dinero. */
  FACTURA_ANTICIPO_PROVEEDOR: "FACTURA_RECIBIDA",
  /** `payableKey` = 465 o tesorería. **Nunca 400/410** (O-13). */
  NOTA_GASTO_EMPLEADO: "FACTURA_RECIBIDA",
  FACTURA_EMITIDA: "FACTURA_EMITIDA_SERVICIOS",
  ABONO_EMITIDO: "ABONO_EMITIDO",
  /** Contrapartida del ingreso = 438. **No T-06.** Sin cobro, sin 477 (D13). */
  FACTURA_ANTICIPO_CLIENTE: "FACTURA_EMITIDA_SERVICIOS",
  NOMINA: null,
  RECIBO_SS: null,
  EXTRACTO_BANCARIO: null,
  DESCONOCIDO: null,
}

/** Plantillas compatibles con un `docKind`, para el selector de la pantalla. */
export const compatibleTemplates = (kind: DocKind): readonly TemplateCode[] => {
  const main = TEMPLATE_FOR_DOC[kind]
  if (main === null) return []
  if (main === "FACTURA_RECIBIDA") return ["FACTURA_RECIBIDA", "FACTURA_RECIBIDA_ISP"]
  if (main === "FACTURA_EMITIDA_SERVICIOS") return ["FACTURA_EMITIDA_SERVICIOS"]
  return [main]
}

export type SelectTemplateInput = {
  docKind: DocKind
  /** El ejercicio del DOCUMENTO está cerrado ⇒ T-22, por fecha (D12.b). */
  fiscalYearClosed: boolean
  /** Elección explícita del usuario entre las compatibles. */
  templateCode?: TemplateCode
}

export function selectTemplate(input: SelectTemplateInput): TemplateCode | null {
  if (input.fiscalYearClosed) return "AJUSTE_EJERCICIO_CERRADO"
  if (input.templateCode) {
    return compatibleTemplates(input.docKind).includes(input.templateCode) ? input.templateCode : null
  }
  return TEMPLATE_FOR_DOC[input.docKind]
}

// ─────────────────────────────────────────────────────────────────────────────
// Clave de pasivo POR NATURALEZA DE LA LÍNEA (§1.2 de la validación contable)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * La cuenta de la línea decide contra qué pasivo va **su** parte del documento.
 * Etiquetar el documento entero con una sola clave manda a 523 la parte de
 * servicios y descoloca el cashflow entre explotación e inversión.
 */
export function payableKeyForAccount(accountCode: string | undefined, context: PayableContext): PayableKey {
  if (context.docKind === "TICKET") return context.paymentKey ?? "BANCO_DEFAULT"
  if (context.docKind === "NOTA_GASTO_EMPLEADO" || context.isEmployee) {
    return context.paymentKey ?? "REMUNERACIONES_PENDIENTES"
  }
  if (!accountCode) return "ACREEDORES"
  // Grupo 2: inmovilizado. **523 siempre en el alta**; la reclasificación
  // 523→173 se mide desde el CIERRE y es un asiento de E9 (D6).
  if (accountCode.startsWith("2")) return "PROVEEDORES_INMOVILIZADO"
  if (accountCode.startsWith("60") || accountCode.startsWith("61")) return "PROVEEDORES"
  return "ACREEDORES"
}

export type PayableContext = {
  docKind: DocKind
  paymentKey?: PayableKey
  isEmployee: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Resultado
// ─────────────────────────────────────────────────────────────────────────────

export type ResolvedPayableBlock = {
  payableKey: PayableKey
  accountCode: string
  baseCents: Cents
  quotaCents: Cents
  /** Parte de la retención y del anticipo que absorbe el bloque (Hamilton). */
  retencionCents?: Cents
  /** Bruto del bloque menos su parte de retención y anticipo: la línea de pasivo. */
  amountCents: Cents
  /**
   * **E8 ronda 1, revisor #4.** El mismo importe **en la moneda del documento**,
   * calculado con el MISMO reparto (Hamilton sobre los bloques) pero sobre las
   * cifras originales, no deshaciendo la conversión del importe en euros.
   *
   * Sólo se rellena cuando hay divisa. Es lo que va a `journal_lines.
   * original_amount_cents`, o sea lo que la NRV 11ª.2.1 revalorizará al cierre
   * en E9, y entra en el `entryHash` v3: tiene que ser el céntimo del papel.
   */
  originalAmountCents?: Cents
}

/**
 * Lo que la línea del asiento no dice y la pantalla y el libro registro sí
 * necesitan: de qué tipo es, con qué deducibilidad se contabilizó y cuánta
 * cuota no deducible viaja dentro de ella (art. 103 LIVA). Es lo que cuadra
 * I-E8-15b.
 */
export type DocumentaryLine = {
  lineNo: number
  accountCode: string
  taxRateCode: string | null
  deductibility: Deductibility | null
  nonDeductibleIncludedCents: Cents
}

export type VatBookKind = "RECIBIDAS" | "EMITIDAS" | "NINGUNO"

/** Anotación en el libro registro del art. 64/63 RIVA. Con signo: un abono resta. */
export type VatBookEntry = {
  tipo: VatBookKind
  ivaPeriod: string | null
  baseCents: Cents
  cuotaTotalCents: Cents
  cuotaDeducibleCents: Cents
  cuotaNoDeducibleAlCosteCents: Cents
  cuotaRepercutidaCents: Cents
  cuotaDevengadaIspAibCents: Cents
}

export type PostedProposal = {
  draft: EntryDraft
  templateCode: TemplateCode
  /** Trimestre de `max(receptionDate, documentDate)` (D8): NO es el del asiento. */
  ivaPeriod: string | null
  payableBlocks: readonly ResolvedPayableBlock[]
  taxOverrides: readonly TaxOverride[]
  withholding: ReconcileResult["withholding"]
  documentaryLines: readonly DocumentaryLine[]
  ledgerBook: VatBookEntry
  conversion: ConversionRef | null
}

export type PostFromProposalOptions = {
  templateCode?: TemplateCode
  extractionRunId?: string
  fileId?: string
  transactionId?: string
  /** Motivo del forzado (duplicado o `convertedTotal`), ≥ 10 caracteres. */
  forceReason?: string
  /** T-22: si el ajuste es material va a 113; si no, a 678/778. */
  closedYearAdjustmentKind?: "MATERIAL" | "NO_SIGNIFICATIVO"
}

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0)

const netBase = (l: ProposalLine): ProposalCents => l.baseCents - (l.discountCents ?? 0)

const isSelfCharged = (operationKey: string | undefined): boolean => operationKey === "ISP" || operationKey === "AIB"

// ─────────────────────────────────────────────────────────────────────────────
// Conversión a moneda base (ADR-0014 D2) — residuo CERO por construcción
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **Una sola aritmética de divisa** (T13). El reparto vive en `lib/fx/convert`
 * —que es donde vive la divisa— y aquí se re-exporta para quien ya lo importaba
 * de este módulo: dos implementaciones del mismo céntimo acaban divergiendo, y
 * ése es justo el céntimo que decide si el asiento cuadra.
 *
 * `payable_EUR = convert(total)`, `base_i_EUR = convert(base_i)` y las **cuotas
 * absorben la diferencia** por mayor resto. Si alguna vez procediera reconocer
 * un residuo de conversión, su cuenta sería 668/768, jamás 669/769.
 */
export { convertDocumentToBase, type ConvertedDocument } from "@/lib/fx/convert"

// ─────────────────────────────────────────────────────────────────────────────
// postFromProposal
// ─────────────────────────────────────────────────────────────────────────────

const errorOf = (code: "PROPOSAL_NOT_RECONCILED" | "PARTIAL_RUN_CANNOT_POST" | "TEMPLATE_UNRESOLVED", message: string): LedgerError =>
  err(code, "reconcile", message, { check: "E8-T9" })

export function postFromProposal(
  reconciled: ReconcileResult,
  ctx: LedgerContext,
  opts: PostFromProposalOptions = {}
): Result<PostedProposal> {
  // ── 1 · Puerta ────────────────────────────────────────────────────────────
  const rc09 = reconciled.checks.find((c) => c.id === "RC-09")
  if (rc09?.evidence.postError === "PARTIAL_RUN_CANNOT_POST") {
    return fail<PostedProposal>(
      errorOf(
        "PARTIAL_RUN_CANNOT_POST",
        "La extracción es parcial y viene de un modelo: no respalda un asiento. Revise y teclee las cifras y se " +
          "registrará como revisión humana (ADR-0014 D5)"
      )
    )
  }
  if (reconciled.status === "FAIL") {
    const failed = reconciled.checks.filter((c) => c.status === "FAIL").map((c) => c.id)
    return fail<PostedProposal>(
      errorOf("PROPOSAL_NOT_RECONCILED", `La propuesta no está reconciliada: ${failed.join(", ")} en FAIL. Sin reconciliar no hay asiento`)
    )
  }

  const p = reconciled.normalized
  const docKind = p.docKind
  const side: "SALE" | "PURCHASE" = isSale(docKind) ? "SALE" : "PURCHASE"

  // ── 2 · Plantilla ─────────────────────────────────────────────────────────
  const templateCode = selectTemplate({
    docKind,
    fiscalYearClosed: reconciled.fiscalYearClosed,
    ...(opts.templateCode ? { templateCode: opts.templateCode } : {}),
  })
  if (templateCode === null) {
    return fail<PostedProposal>(
      errorOf(
        "TEMPLATE_UNRESOLVED",
        `No hay plantilla automática para un documento de clase ${docKind}: lo decide una persona (§3.4). ` +
          "Una nómina, un recibo de la Seguridad Social o un extracto bancario NUNCA entran por una plantilla de compra"
      )
    )
  }

  const documentDate = p.documentDate
  if (documentDate === null) {
    return fail<PostedProposal>(errorOf("PROPOSAL_NOT_RECONCILED", "El documento no tiene fecha de expedición"))
  }

  // ── 3 · Moneda base ───────────────────────────────────────────────────────
  const conversion = reconciled.conversion
  const rateMicro = conversion?.rateMicro ?? null
  const operationLines = p.lines.filter((l) => l.kind === "OPERACION")
  const otherLines = p.lines.filter((l) => l.kind !== "OPERACION")
  const taxesInTotal = p.taxes.filter((t) => !isSelfCharged(t.operationKey) && t.quotaCents !== 0)

  const converted =
    rateMicro === null
      ? null
      : convertDocumentToBase(
          [...operationLines, ...otherLines].map((l) => ({ baseCents: netBase(l) })),
          taxesInTotal.map((t) => ({ taxRateCode: t.taxRateCode, quotaCents: t.quotaCents })),
          rateMicro
        )

  const orderedLines = [...operationLines, ...otherLines]
  const baseOf = (index: number): Cents => converted?.lineBases[index] ?? netBase(orderedLines[index])
  const quotaOf = (code: string): Cents => {
    const declared = p.taxes.find((t) => t.taxRateCode === code)?.quotaCents ?? 0
    if (converted === null) return declared
    return converted.quotaByRate[code] ?? convertWithRate(declared, rateMicro as bigint)
  }

  // ── 4 · Cuotas del documento como `taxOverrides` (D3) ─────────────────────
  // Un tipo al 0 % no genera línea de cuota (C-3) ni tiene nada que sobrescribir.
  const zeroRateCodes = new Set(
    p.taxes.filter((t) => (ctx.rates.find((r) => r.code === t.taxRateCode)?.rateBps ?? 0) === 0).map((t) => t.taxRateCode)
  )
  const anticipoSinCobro = reconciled.checks.some((c) => c.id === "RC-25" && c.status === "WARN")
  const delta = reconciled.rectificationDelta
  const taxOverrides: TaxOverride[] = p.taxes
    .filter((t) => !zeroRateCodes.has(t.taxRateCode))
    .filter(() => !(docKind === "FACTURA_ANTICIPO_CLIENTE" && anticipoSinCobro))
    // Rectificativa por SUSTITUCIÓN: la cuota que se contabiliza es la de la
    // DIFERENCIA (D12), no la que el documento imprime; contabilizar lo leído
    // duplicaría la operación.
    .map((t) => ({
      taxRateCode: t.taxRateCode,
      quotaCents: delta ? (delta.quotaByRate[t.taxRateCode] ?? 0) : quotaOf(t.taxRateCode),
    }))
    .filter((o) => !delta || o.quotaCents !== 0)

  /**
   * **Revisor #4.** Las mismas cuotas **en la moneda del documento**. Sirven
   * para recalcular los bloques de pasivo sobre el original y quedarse con el
   * importe en divisa de cada línea monetaria: el round-trip
   * `reverseConvert(convert(x))` es lossy salvo para tasas próximas a 1 (con
   * `rateMicro = 920000` falla en 1 600 de 20 000 importes), y ese céntimo
   * acaba en `original_amount_cents` y en el `entryHash`.
   */
  const taxOverridesOriginal: TaxOverride[] = p.taxes
    .filter((t) => !zeroRateCodes.has(t.taxRateCode))
    .filter(() => !(docKind === "FACTURA_ANTICIPO_CLIENTE" && anticipoSinCobro))
    .map((t) => ({
      taxRateCode: t.taxRateCode,
      quotaCents: delta ? (delta.quotaByRate[t.taxRateCode] ?? 0) : t.quotaCents,
    }))
    .filter((o) => !delta || o.quotaCents !== 0)

  // ── 5 · Construcción del input y de los bloques de pasivo ─────────────────
  const built =
    templateCode === "AJUSTE_EJERCICIO_CERRADO"
      ? buildClosedYearAdjustment(reconciled, ctx, opts, { baseOf, orderedLines, taxOverrides })
      : side === "SALE"
        ? buildSaleInput(reconciled, ctx, {
            templateCode, baseOf, orderedLines, taxOverrides, taxOverridesOriginal, anticipoSinCobro, converted,
          })
        : buildPurchaseInput(reconciled, ctx, {
            templateCode, baseOf, orderedLines, taxOverrides, taxOverridesOriginal, converted,
          })
  if (!built.ok) return fail<PostedProposal>(...built.errors)

  const draftResult = buildFromTemplate(built.value.templateCode, built.value.input, ctx)
  if (!draftResult.ok) return fail<PostedProposal>(...draftResult.errors)
  const draft = draftResult.value

  // ── 6 · Sellado (§3.4, paso 9) ────────────────────────────────────────────
  draft.sourceType = sourceTypeFor(docKind, templateCode)
  draft.templateVersion = 1
  draft.receptionDate = p.receptionDate ?? null
  draft.operationDate = p.operationDate ?? null
  if (opts.fileId !== undefined) draft.fileId = opts.fileId
  if (opts.extractionRunId !== undefined) draft.extractionRunId = opts.extractionRunId
  if (opts.transactionId !== undefined) draft.transactionId = opts.transactionId

  // ── 7 · Divisa en la LÍNEA (D2, hashVersion 3) ────────────────────────────
  // Sólo las partidas MONETARIAS: 43x, 40x, 41x, 523, 57x, 465. Las de gasto y
  // las de IVA ya son no monetarias en euros, y marcarlas obligaría a
  // revalorizarlas al cierre, que es lo contrario de lo que dice la NRV 11ª.
  if (conversion && rateMicro !== null) {
    const monetary = new Set(built.value.payableBlocks.map((b) => b.accountCode))
    for (const key of ["CLIENTES", "PROVEEDORES", "ACREEDORES"] as const) {
      const code = ctx.map(key)
      if (code) monetary.add(code)
    }
    /**
     * **Revisor #4 — el importe original sale del DOCUMENTO, no de deshacer la
     * conversión.** `reverseConvert(convert(x))` no devuelve `x` salvo para
     * tasas próximas a 1: con `rateMicro = 920000` erraba en 1 600 de 20 000
     * importes. La línea de deuda en divisa es justo la que la NRV 11ª.2.1
     * revalorizará al cierre y entra en el `entryHash` v3, así que tiene que
     * llevar el céntimo del papel.
     *
     * `reverseConvert` se queda como **red de seguridad** para la línea
     * monetaria que no corresponde a ningún bloque de pasivo —la de clientes de
     * una venta, cuyo importe original es el total del documento— y para el
     * caso en que el recálculo sobre el original no cuadre.
     */
    const candidates: OriginalCandidate[] = built.value.payableBlocks
      .filter((b) => b.originalAmountCents !== undefined)
      .map((b) => ({
        payableKey: b.payableKey,
        accountCode: b.accountCode,
        amountCents: b.amountCents,
        originalAmountCents: b.originalAmountCents as Cents,
      }))
    // La cuenta de clientes de una venta no es un bloque de pasivo: su importe
    // original es, por definición, el total del documento.
    const receivable = ctx.map("CLIENTES")
    if (side === "SALE" && receivable && !candidates.some((c) => c.accountCode === receivable)) {
      const amount = sum(
        draft.lines.filter((l) => l.accountCode === receivable).map((l) => l.debitCents + l.creditCents)
      )
      candidates.push({ payableKey: "CLIENTES", accountCode: receivable, amountCents: amount, originalAmountCents: p.totalCents })
    }

    const paired = pairOriginalAmounts(draft.lines, candidates)
    for (const line of draft.lines) {
      if (!monetary.has(line.accountCode)) continue
      const fromDocument = paired.get(line.lineNo)
      line.originalCurrency = p.currency
      line.originalAmountCents = fromDocument ?? reverseConvert(line.debitCents + line.creditCents, conversion)
      line.exchangeRateId = conversion.rateId
    }
  }

  // ── 8 · Proyección documental y libro registro ────────────────────────────
  const documentaryLines = projectDocumentaryLines(draft, built.value, ctx)
  const ledgerBook = buildVatBookEntry(reconciled, draft, built.value, documentaryLines, ctx)

  return ok({
    draft,
    templateCode,
    ivaPeriod: reconciled.ivaPeriod,
    payableBlocks: built.value.payableBlocks,
    taxOverrides,
    withholding: reconciled.withholding,
    documentaryLines,
    ledgerBook,
    conversion,
  })
}

/**
 * El mismo camino, sin nada que persistir: es literalmente `postFromProposal`
 * sin identificadores. Se expone aparte porque I-E8-8 compara el borrador de la
 * previsualización con el asiento REAL línea a línea y céntimo a céntimo, y para
 * que eso signifique algo tienen que ser el mismo código, no dos.
 */
export function previewFromProposal(
  reconciled: ReconcileResult,
  ctx: LedgerContext,
  opts: Omit<PostFromProposalOptions, "transactionId"> = {}
): Result<PostedProposal> {
  return postFromProposal(reconciled, ctx, opts)
}

// ─────────────────────────────────────────────────────────────────────────────
// Construcción del input por familia
// ─────────────────────────────────────────────────────────────────────────────

type BuildContext = {
  templateCode: TemplateCode
  baseOf: (index: number) => Cents
  orderedLines: readonly ProposalLine[]
  taxOverrides: readonly TaxOverride[]
  /** Revisor #4: las mismas cuotas en la moneda del DOCUMENTO. */
  taxOverridesOriginal: readonly TaxOverride[]
  converted: ConvertedDocument | null
  anticipoSinCobro?: boolean
}

type BuiltInput = {
  templateCode: TemplateCode
  input: Record<string, unknown>
  payableBlocks: readonly ResolvedPayableBlock[]
  /** Índice de línea del asiento → línea del documento, para la proyección. */
  documentLineAccounts: readonly {
    /** Cuenta con la que la línea aparecerá EN EL ASIENTO (608 y no 607 en un abono). */
    accountCode: string
    taxRateCode: string | null
    deductibility: Deductibility | null
    /** Sólo las líneas OPERACION entran en la base del libro registro (O-12). */
    operacion: boolean
    baseCents: Cents
  }[]
  nonDeductibleByLine: readonly Cents[]
  quotaByRate: Readonly<Record<string, Cents>>
}

/**
 * La cuenta con la que una línea de un documento RECTIFICATIVO aparece en el
 * asiento: el PGC tiene cuenta propia para la devolución, el descuento y el
 * rappel, y una línea negativa en 607 o en 705 falsearía el epígrafe de la PyG.
 * Con `ERROR` se rectifica la propia cuenta de ingreso o de gasto.
 */
function rectificationAccountFor(
  reason: string | undefined,
  side: "SALE" | "PURCHASE",
  ctx: LedgerContext,
  lineAccount: string | undefined
): string | undefined {
  const key: AccountKey | null =
    reason === "DEVOLUCION"
      ? side === "SALE" ? "DEVOLUCION_VENTAS" : "DEVOLUCION_COMPRAS"
      : reason === "DESCUENTO_POSTERIOR"
        ? side === "SALE" ? "DESCUENTO_PP_VENTAS" : "DESCUENTO_PP_COMPRAS"
        : reason === "RAPPEL"
          ? side === "SALE" ? "RAPPEL_VENTAS" : "RAPPEL_COMPRAS"
          : null
  if (key === null) return lineAccount
  return ctx.map(key) ?? lineAccount
}

const isSale = (kind: DocKind): boolean =>
  kind === "FACTURA_EMITIDA" || kind === "ABONO_EMITIDO" || kind === "FACTURA_ANTICIPO_CLIENTE"

const sourceTypeFor = (kind: DocKind, template: TemplateCode): SourceType => {
  if (template === "AJUSTE_EJERCICIO_CERRADO") return "DOCUMENT"
  return isSale(kind) ? "INVOICE_OUT" : "INVOICE_IN"
}

/**
 * Deshace la conversión para dejar en la línea monetaria el importe ORIGINAL en
 * divisa (D2): es el que la NRV 11ª.2.1 obliga a revalorizar al cierre, y sin él
 * la valoración no sería computable desde el diario (ADR-0003).
 */
const reverseConvert = (cents: Cents, conversion: ConversionRef): Cents => {
  const micro = conversion.rateMicro
  if (micro === BigInt(0)) return cents
  const scale = BigInt(1_000_000)
  const sign = cents < 0 ? -1 : 1
  const product = BigInt(Math.abs(cents)) * scale
  const quotient = product / micro
  const remainder = product - quotient * micro
  const rounded = remainder * BigInt(2) >= micro ? quotient + BigInt(1) : quotient
  return sign * Number(rounded)
}

function buildPurchaseInput(
  reconciled: ReconcileResult,
  ctx: LedgerContext,
  b: BuildContext
): Result<BuiltInput> {
  const p = reconciled.normalized
  const errors: LedgerError[] = []
  const docKind = p.docKind
  const isEmployee = docKind === "NOTA_GASTO_EMPLEADO"
  const payableContext: PayableContext = {
    docKind,
    ...(p.paymentKey ? { paymentKey: p.paymentKey as PayableKey } : {}),
    isEmployee,
  }

  const advanceAccount = docKind === "FACTURA_ANTICIPO_PROVEEDOR" ? ctx.map("ANTICIPOS_PROVEEDORES") : null
  const zeroRate = zeroRateCodeFor(ctx, "PURCHASE")

  // Rectificativa por SUSTITUCIÓN: se contabiliza la DIFERENCIA (D12).
  const delta = reconciled.rectificationDelta
  const lines = delta
    ? deltaLines(delta, b.orderedLines, zeroRate)
    : b.orderedLines.map((l, index) => ({
        baseCents: b.baseOf(index),
        taxRateCode: l.taxRateCode ?? zeroRate,
        line: l,
      }))

  if (lines.some((l) => l.taxRateCode === null)) {
    errors.push(
      err(
        "TAX_RATE_NOT_IN_FORCE",
        "taxRateCode",
        "El plan no tiene ningún tipo al 0 % vigente con el que registrar una línea no sujeta o un suplido",
        { check: "RC-06" }
      )
    )
  }
  if (errors.length > 0) return fail<BuiltInput>(...errors)

  const templateLines = lines.map(({ baseCents, taxRateCode, line }) => ({
    baseCents,
    taxRateCode: taxRateCode as string,
    ...(advanceAccount
      ? { expenseAccountCode: advanceAccount }
      : line.accountCode
        ? { expenseAccountCode: line.accountCode }
        : {}),
    deductibility: (line.deductibility ?? "FULL") as Deductibility,
    ...(line.description ? { description: line.description } : {}),
    ...(line.projectId ? { projectId: line.projectId } : {}),
    ...(line.costCenterId ? { costCenterId: line.costCenterId } : {}),
  }))

  // Cuota por línea con la MISMA aritmética que la plantilla (T9b): dos
  // cálculos distintos divergirían en el céntimo que decide el cuadre.
  const taxes = lineTaxes(
    templateLines.map((l) => ({ baseCents: l.baseCents, taxRateCode: l.taxRateCode })),
    ctx,
    { documentDate: p.documentDate as LocalDate, accrualDate: p.accrualDate ?? null, operationDate: p.operationDate ?? null },
    "PURCHASE",
    b.taxOverrides
  )
  if (taxes.errors.length > 0) return fail<BuiltInput>(...taxes.errors)

  const isp = b.templateCode === "FACTURA_RECIBIDA_ISP"
  const blocks = resolvePayableBlocks(
    templateLines.map((l, i) => ({
      accountCode: lines[i].line.accountCode,
      baseCents: l.baseCents,
      // Con ISP el proveedor NO repercute: la deuda es sólo la base.
      quotaCents: isp ? 0 : taxes.perLine[i],
    })),
    payableContext,
    ctx,
    errors
  )
  if (errors.length > 0) return fail<BuiltInput>(...errors)

  const withholding = reconciled.withholding
  const withholdingCents = withholding?.quotaCents ?? 0
  const advanceCents = p.appliedAdvanceCents ?? 0
  const grossPayable = sum(blocks.map((x) => x.baseCents + x.quotaCents))
  const split = splitPayableBlocks(
    blocks.map((x) => ({ payableKey: x.payableKey, accountCode: x.accountCode, amountCents: x.baseCents + x.quotaCents })),
    grossPayable,
    withholdingCents + advanceCents,
    errors
  )
  if (errors.length > 0) return fail<BuiltInput>(...errors)

  /**
   * **Revisor #4 — el importe de cada bloque EN LA MONEDA DEL DOCUMENTO.**
   * Mismo camino (`lineTaxes` → `resolvePayableBlocks` → `splitPayableBlocks`,
   * o sea el mismo Hamilton) sobre las cifras originales. No se deshace la
   * conversión: se calcula sobre lo que pone el papel.
   */
  const originalAmounts =
    b.converted === null
      ? null
      : originalPayableAmounts({
          bases: lines.map(({ line }, i) => (delta ? lines[i].baseCents : netBase(line))),
          taxRateCodes: templateLines.map((l) => l.taxRateCode),
          accountCodes: lines.map(({ line }) => line.accountCode),
          overrides: b.taxOverridesOriginal,
          isp,
          payableContext,
          ctx,
          dates: { documentDate: p.documentDate as LocalDate, accrualDate: p.accrualDate ?? null, operationDate: p.operationDate ?? null },
          reductionCents: withholdingCents + advanceCents,
        })

  const payableBlocks: ResolvedPayableBlock[] = blocks.map((x, i) => ({
    payableKey: x.payableKey,
    accountCode: x.accountCode,
    baseCents: x.baseCents,
    quotaCents: x.quotaCents,
    ...(withholdingCents + advanceCents > 0
      ? { retencionCents: x.baseCents + x.quotaCents - (split[i]?.amountCents ?? 0) }
      : {}),
    amountCents: split[i]?.amountCents ?? x.baseCents + x.quotaCents,
    ...(originalAmounts?.[i] !== undefined ? { originalAmountCents: originalAmounts[i] } : {}),
  }))

  const baseTotal = sum(templateLines.map((l) => l.baseCents))
  const taxTotal = isp ? 0 : taxes.totalCents
  const operationBase = sum(
    templateLines.filter((_, i) => lines[i].line.kind === "OPERACION").map((l) => l.baseCents)
  )

  const input: Record<string, unknown> = {
    ...(isUuid(p.counterparty.id) ? { counterpartyId: p.counterparty.id } : {}),
    supplierDocumentNumber: p.documentNumber ?? "sin número",
    documentDate: p.documentDate,
    ...(p.accrualDate ? { accrualDate: p.accrualDate } : {}),
    ...(p.operationDate ? { operationDate: p.operationDate } : {}),
    payableKey: payableBlocks[0]?.payableKey ?? "ACREEDORES",
    ...(payableBlocks.length > 1 ? { payableBlocks: payableBlocks.map((x) => ({ payableKey: x.payableKey, amountCents: x.amountCents })) } : {}),
    ...(dueFor(p, payableBlocks.length > 1) ?? {}),
    lines: templateLines,
    ...(withholding
      ? {
          withholdingRateCode: withholding.rateCode,
          withholdingKey: withholding.model === "115" ? "IRPF_ALQUILERES_A_PAGAR" : "IRPF_PROFESIONALES_A_PAGAR",
          ...(operationBase !== baseTotal ? { withholdingBaseCents: operationBase } : {}),
        }
      : {}),
    ...(advanceCents > 0 ? { appliedAdvanceCents: advanceCents } : {}),
    ...(b.taxOverrides.length > 0 ? { taxOverrides: b.taxOverrides } : {}),
    totalCents: baseTotal + taxTotal - withholdingCents - advanceCents,
    ...(p.description ? { description: p.description } : {}),
    ...(b.templateCode === "ABONO_RECIBIDO"
      ? {
          reason: p.rectifies?.reason ?? "ERROR",
          ...(isUuid(p.rectifies?.entryId) ? { rectifiesEntryId: p.rectifies?.entryId } : {}),
        }
      : {}),
  }

  return ok({
    templateCode: b.templateCode,
    input,
    payableBlocks,
    documentLineAccounts: templateLines.map((l, i) => ({
      accountCode:
        b.templateCode === "ABONO_RECIBIDO"
          ? (rectificationAccountFor(p.rectifies?.reason, "PURCHASE", ctx, l.expenseAccountCode) ?? "")
          : (l.expenseAccountCode ?? ""),
      taxRateCode: lines[i].line.taxRateCode,
      deductibility: lines[i].line.deductibility ?? null,
      operacion: lines[i].line.kind === "OPERACION",
      baseCents: l.baseCents,
    })),
    nonDeductibleByLine: templateLines.map((l, i) => {
      const split2 = deducible(isp ? 0 : taxes.perLine[i], l.deductibility, ctx.policy.prorrataBps)
      return split2?.noDeducibleCents ?? 0
    }),
    quotaByRate: quotaMap(b.taxOverrides),
  })
}

function buildSaleInput(reconciled: ReconcileResult, ctx: LedgerContext, b: BuildContext): Result<BuiltInput> {
  const p = reconciled.normalized
  const errors: LedgerError[] = []
  const zeroRate = zeroRateCodeFor(ctx, "SALE")
  const delta = reconciled.rectificationDelta

  // D13 — anticipo de cliente. La contrapartida del ingreso es **438**, nunca
  // 705: un anticipo es un pasivo, no un ingreso devengado (O-7). Y **sin cobro
  // registrado no hay 477**: el art. 75.Dos LIVA devenga el impuesto «en el
  // momento del cobro… por los importes efectivamente percibidos», de modo que
  // repercutir al expedir anticipa el ingreso a Hacienda y descuadra las
  // casillas 01-03 del 303 del trimestre. El devengo llega con T-08.
  if (p.docKind === "FACTURA_ANTICIPO_CLIENTE") {
    const advanceCode = ctx.map("ANTICIPOS_CLIENTES")
    if (!advanceCode) {
      return fail<BuiltInput>(err("MAP_KEY_UNMAPPED", "accountKey", "La clave ANTICIPOS_CLIENTES no está mapeada"))
    }
    if (b.anticipoSinCobro) {
      if (zeroRate === null) {
        return fail<BuiltInput>(
          err("TAX_RATE_NOT_IN_FORCE", "taxRateCode", "El plan no tiene un tipo al 0 % con el que registrar el anticipo sin devengo")
        )
      }
      const gross = sumBases(b) + sum(p.taxes.map((t) => quotaFromContext(t.taxRateCode, b, p)))
      return ok({
        templateCode: "FACTURA_EMITIDA_SERVICIOS",
        input: {
          ...(isUuid(p.counterparty.id) ? { counterpartyId: p.counterparty.id } : {}),
          documentNumber: p.documentNumber ?? "sin número",
          documentDate: p.documentDate,
          lines: [
            { baseCents: gross, taxRateCode: zeroRate, revenueAccountCode: advanceCode, description: p.description ?? "Anticipo facturado" },
          ],
          totalCents: gross,
          ...(p.description ? { description: p.description } : {}),
        },
        payableBlocks: [],
        // El libro registro de emitidas NO anota cuota devengada: la anotación
        // corresponde al periodo del cobro (OBS-F2 del fixture).
        documentLineAccounts: [{ accountCode: advanceCode, taxRateCode: null, deductibility: null, operacion: false, baseCents: 0 }],
        nonDeductibleByLine: [0],
        quotaByRate: {},
      })
    }
    const advanceLines = b.orderedLines.map((l, index) => ({
      baseCents: b.baseOf(index),
      taxRateCode: (l.taxRateCode ?? zeroRate) as string,
      revenueAccountCode: advanceCode,
      ...(l.description ? { description: l.description } : {}),
    }))
    const advanceBase = sum(advanceLines.map((l) => l.baseCents))
    const advanceTax = sum(b.taxOverrides.map((o) => o.quotaCents))
    return ok({
      templateCode: "FACTURA_EMITIDA_SERVICIOS",
      input: {
        ...(isUuid(p.counterparty.id) ? { counterpartyId: p.counterparty.id } : {}),
        documentNumber: p.documentNumber ?? "sin número",
        documentDate: p.documentDate,
        lines: advanceLines,
        ...(b.taxOverrides.length > 0 ? { taxOverrides: b.taxOverrides } : {}),
        totalCents: advanceBase + advanceTax,
        ...(p.description ? { description: p.description } : {}),
      },
      payableBlocks: [],
      documentLineAccounts: advanceLines.map((l, i) => ({
        accountCode: advanceCode,
        taxRateCode: b.orderedLines[i].taxRateCode,
        deductibility: null,
        operacion: true,
        baseCents: l.baseCents,
      })),
      nonDeductibleByLine: advanceLines.map(() => 0),
      quotaByRate: quotaMap(b.taxOverrides),
    })
  }

  const lines = delta
    ? deltaLines(delta, b.orderedLines, zeroRate)
    : b.orderedLines.map((l, index) => ({ baseCents: b.baseOf(index), taxRateCode: l.taxRateCode ?? zeroRate, line: l }))

  if (lines.some((l) => l.taxRateCode === null)) {
    errors.push(err("TAX_RATE_NOT_IN_FORCE", "taxRateCode", "El plan no tiene ningún tipo al 0 % vigente para una línea no sujeta"))
  }
  if (errors.length > 0) return fail<BuiltInput>(...errors)

  const templateLines = lines.map(({ baseCents, taxRateCode, line }) => ({
    baseCents,
    taxRateCode: taxRateCode as string,
    ...(line.accountCode ? { revenueAccountCode: line.accountCode } : {}),
    ...(line.description ? { description: line.description } : {}),
    ...(line.projectId ? { projectId: line.projectId } : {}),
    ...(line.costCenterId ? { costCenterId: line.costCenterId } : {}),
  }))

  const taxes = lineTaxes(
    templateLines.map((l) => ({ baseCents: l.baseCents, taxRateCode: l.taxRateCode })),
    ctx,
    { documentDate: p.documentDate as LocalDate, accrualDate: p.accrualDate ?? null, operationDate: p.operationDate ?? null },
    "SALE",
    b.taxOverrides
  )
  if (taxes.errors.length > 0) return fail<BuiltInput>(...taxes.errors)

  const withholding = reconciled.withholding
  const baseTotal = sum(templateLines.map((l) => l.baseCents))
  const withholdingCents = withholding ? applyBps(baseTotal, rateBpsOf(ctx, withholding.rateCode)) : 0
  const advanceCents = p.appliedAdvanceCents ?? 0
  const advanceTaxCents = p.appliedAdvanceTaxCents ?? 0

  const input: Record<string, unknown> = {
    ...(isUuid(p.counterparty.id) ? { counterpartyId: p.counterparty.id } : {}),
    documentNumber: p.documentNumber ?? "sin número",
    documentDate: p.documentDate,
    ...(p.accrualDate ? { accrualDate: p.accrualDate } : {}),
    ...(p.operationDate ? { operationDate: p.operationDate } : {}),
    ...(dueFor(p, false) ?? {}),
    lines: templateLines,
    ...(withholding ? { withholdingRateCode: withholding.rateCode } : {}),
    ...(advanceCents > 0 ? { appliedAdvanceCents: advanceCents } : {}),
    ...(advanceTaxCents > 0 ? { appliedAdvanceTaxCents: advanceTaxCents } : {}),
    ...(b.taxOverrides.length > 0 ? { taxOverrides: b.taxOverrides } : {}),
    totalCents: baseTotal + taxes.totalCents - withholdingCents,
    ...(p.description ? { description: p.description } : {}),
    ...(b.templateCode === "ABONO_EMITIDO"
      ? {
          reason: p.rectifies?.reason ?? "ERROR",
          ...(isUuid(p.rectifies?.entryId) ? { rectifiesEntryId: p.rectifies?.entryId } : {}),
        }
      : {}),
  }

  return ok({
    templateCode: b.templateCode,
    input,
    payableBlocks: [],
    documentLineAccounts: templateLines.map((l, i) => ({
      accountCode:
        b.templateCode === "ABONO_EMITIDO"
          ? (rectificationAccountFor(p.rectifies?.reason, "SALE", ctx, l.revenueAccountCode) ?? "")
          : (l.revenueAccountCode ?? ""),
      taxRateCode: lines[i].line.taxRateCode,
      deductibility: null,
      operacion: true,
      baseCents: l.baseCents,
    })),
    nonDeductibleByLine: templateLines.map(() => 0),
    quotaByRate: quotaMap(b.taxOverrides),
  })
}

/**
 * T-22 — el documento pertenece a un ejercicio **cerrado**. No se reabre un
 * ejercicio para meter una factura: se registra en el abierto contra reservas
 * (113) si es material, o contra 678/778 si no lo es (NRV 22ª). El desvío es
 * **por fecha** y está en la tabla, no escondido como excepción.
 */
function buildClosedYearAdjustment(
  reconciled: ReconcileResult,
  ctx: LedgerContext,
  opts: PostFromProposalOptions,
  b: Pick<BuildContext, "baseOf" | "orderedLines" | "taxOverrides">
): Result<BuiltInput> {
  const p = reconciled.normalized
  const baseTotal = sum(b.orderedLines.map((_, i) => b.baseOf(i)))
  const sale = isSale(p.docKind)
  const deductibleVat = sum(b.taxOverrides.map((o) => o.quotaCents))
  const firstAccount = b.orderedLines[0]?.accountCode
  const counterpartKey =
    sale ? "CLIENTES" : payableKeyForAccount(firstAccount, { docKind: p.docKind, isEmployee: false }) === "PROVEEDORES" ? "PROVEEDORES" : "ACREEDORES"

  return ok({
    templateCode: "AJUSTE_EJERCICIO_CERRADO",
    input: {
      documentDate: p.documentDate,
      entryDate: ctx.refDate,
      adjustmentKind: opts.closedYearAdjustmentKind ?? "NO_SIGNIFICATIVO",
      direction: sale ? "INGRESO" : "GASTO",
      amountCents: baseTotal,
      counterpartKey,
      ...(deductibleVat > 0 && !reconciled.checks.some((c) => c.id === "RC-18" && c.status === "WARN")
        ? { deductibleVatCents: deductibleVat, deductibleVatRateCode: b.taxOverrides[0]?.taxRateCode }
        : {}),
      reason: `Documento ${p.documentNumber ?? "sin número"} de un ejercicio cerrado: se registra en el abierto (NRV 22ª)`,
    },
    payableBlocks: [],
    documentLineAccounts: [],
    nonDeductibleByLine: [],
    quotaByRate: quotaMap(b.taxOverrides),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloques de pasivo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Un bloque por naturaleza de línea, en **orden de aparición** en el documento:
 * así el asiento es reproducible y el drill-down enseña las líneas en el orden
 * en que el documento las trae.
 */
/**
 * Un bloque de pasivo candidato a prestar su importe original a una línea.
 * `payableKey` es la clave ESTABLE: dos bloques distintos pueden compartir
 * cuenta, pero nunca clave.
 */
export type OriginalCandidate = {
  payableKey: string
  accountCode: string
  /** Importe en moneda base con el que la línea aparece en el asiento. */
  amountCents: Cents
  /** El mismo importe, en la moneda del documento. */
  originalAmountCents: Cents
}

/**
 * **Ronda 2, R2-1 — a qué bloque de pasivo pertenece cada línea monetaria.**
 *
 * El emparejamiento anterior era un FIFO por `accountCode`: se iba consumiendo
 * la lista de originales de esa cuenta en el orden en que aparecían las líneas.
 * Funciona mientras la plantilla emita las líneas en el mismo orden que los
 * bloques, que es lo que hace hoy — y ésa es exactamente la clase de garantía
 * que no debe sostener un importe que entra en el `entryHash`. **Dos bloques
 * con la misma cuenta existen de verdad**: basta con que una organización mapee
 * `PROVEEDORES_INMOVILIZADO` y `ACREEDORES` a la misma 4100, y entonces las dos
 * líneas de pasivo son indistinguibles entre sí y un cambio de orden en la
 * plantilla intercambiaría sus importes en divisa sin que nada lo detectase (el
 * asiento seguiría cuadrando, porque la suma no cambia).
 *
 * Ahora se empareja por **clave estable**, en tres pasadas de menos a más laxa:
 *
 *  1. `(accountCode, amountCents)` — el importe convertido de la línea es el
 *     del bloque. Es único salvo empate exacto, y en el empate da igual cuál se
 *     elija: los dos bloques tienen el mismo contravalor.
 *  2. `accountCode` en orden de bloque, para el caso en que la plantilla haya
 *     agrupado o repartido de otra manera.
 *  3. sin pareja: la decide `reverseConvert` como red de seguridad.
 *
 * Devuelve `lineNo → importe original`. Es PURA y se exporta para que el test
 * pueda darle los bloques en orden invertido y comprobar que no se intercambian.
 */
export function pairOriginalAmounts(
  lines: readonly { lineNo: number; accountCode?: string | null; debitCents: Cents; creditCents: Cents }[],
  candidates: readonly OriginalCandidate[]
): Map<number, Cents> {
  const out = new Map<number, Cents>()
  const used = new Set<number>()

  const claim = (index: number, lineNo: number): void => {
    used.add(index)
    out.set(lineNo, candidates[index].originalAmountCents)
  }

  // 1 · cuenta + importe convertido.
  for (const line of lines) {
    if (out.has(line.lineNo)) continue
    const amount = line.debitCents + line.creditCents
    const index = candidates.findIndex(
      (c, i) => !used.has(i) && c.accountCode === line.accountCode && c.amountCents === amount
    )
    if (index >= 0) claim(index, line.lineNo)
  }

  // 2 · sólo cuenta, en orden de bloque.
  for (const line of lines) {
    if (out.has(line.lineNo)) continue
    const index = candidates.findIndex((c, i) => !used.has(i) && c.accountCode === line.accountCode)
    if (index >= 0) claim(index, line.lineNo)
  }

  return out
}

/**
 * Importe en divisa de cada bloque de pasivo (revisor #4). Repite el cálculo
 * de arriba —`lineTaxes`, `resolvePayableBlocks`, `splitPayableBlocks`— con las
 * bases y las cuotas del documento en su moneda, de modo que la línea monetaria
 * lleve el céntimo del papel y no un contravalor deshecho.
 *
 * Devuelve `null` si el recálculo no cuadra (un tipo que no está vigente a la
 * fecha, por ejemplo): entonces §7 usa `reverseConvert` como aproximación, que
 * es lo que había antes, en vez de dejar la línea sin importe original.
 */
function originalPayableAmounts(args: {
  bases: readonly Cents[]
  taxRateCodes: readonly string[]
  accountCodes: readonly (string | undefined)[]
  overrides: readonly TaxOverride[]
  isp: boolean
  payableContext: PayableContext
  ctx: LedgerContext
  dates: { documentDate: LocalDate; accrualDate: LocalDate | null; operationDate: LocalDate | null }
  reductionCents: Cents
}): Cents[] | null {
  const taxes = lineTaxes(
    args.bases.map((baseCents, i) => ({ baseCents, taxRateCode: args.taxRateCodes[i] })),
    args.ctx,
    args.dates,
    "PURCHASE",
    args.overrides
  )
  if (taxes.errors.length > 0) return null
  const errors: LedgerError[] = []
  const blocks = resolvePayableBlocks(
    args.bases.map((baseCents, i) => ({
      ...(args.accountCodes[i] ? { accountCode: args.accountCodes[i] as string } : {}),
      baseCents,
      quotaCents: args.isp ? 0 : taxes.perLine[i],
    })),
    args.payableContext,
    args.ctx,
    errors
  )
  if (errors.length > 0) return null
  const gross = sum(blocks.map((x) => x.baseCents + x.quotaCents))
  const split = splitPayableBlocks(
    blocks.map((x) => ({ payableKey: x.payableKey, accountCode: x.accountCode, amountCents: x.baseCents + x.quotaCents })),
    gross,
    args.reductionCents,
    errors
  )
  if (errors.length > 0) return null
  return blocks.map((x, i) => split[i]?.amountCents ?? x.baseCents + x.quotaCents)
}

export function resolvePayableBlocks(
  lines: readonly { accountCode?: string; baseCents: Cents; quotaCents: Cents }[],
  context: PayableContext,
  ctx: LedgerContext,
  errors: LedgerError[]
): ResolvedPayableBlock[] {
  const blocks: ResolvedPayableBlock[] = []
  for (const line of lines) {
    const key = payableKeyForAccount(line.accountCode, context)
    const code = ctx.map(key as AccountKey)
    if (!code) {
      errors.push(
        err("MAP_KEY_UNMAPPED", "payableKey", `La clave ${key} no está mapeada a ninguna cuenta del plan (ADR-0014 D6)`)
      )
      continue
    }
    const existing = blocks.find((x) => x.payableKey === key)
    if (existing) {
      existing.baseCents += line.baseCents
      existing.quotaCents += line.quotaCents
      existing.amountCents = existing.baseCents + existing.quotaCents
      continue
    }
    blocks.push({
      payableKey: key,
      accountCode: code,
      baseCents: line.baseCents,
      quotaCents: line.quotaCents,
      amountCents: line.baseCents + line.quotaCents,
    })
  }
  return blocks
}

// ─────────────────────────────────────────────────────────────────────────────
// Proyección documental y libro registro
// ─────────────────────────────────────────────────────────────────────────────

function projectDocumentaryLines(draft: EntryDraft, built: BuiltInput, ctx: LedgerContext): DocumentaryLine[] {
  const codeByRateId = new Map(ctx.rates.map((r) => [r.id, r.code]))
  const out: DocumentaryLine[] = []
  const pending = built.documentLineAccounts.map((d, i) => ({ ...d, nonDeductible: built.nonDeductibleByLine[i] ?? 0, used: false }))
  for (const line of draft.lines) {
    // La línea de gasto o de ingreso conserva el tipo de la LÍNEA DEL DOCUMENTO
    // (el motor no lo sella en ella); la de cuota, el de su `taxRateId`.
    const hit = pending.find((d) => !d.used && d.accountCode === line.accountCode)
    if (hit) hit.used = true
    out.push({
      lineNo: line.lineNo,
      accountCode: line.accountCode,
      taxRateCode: hit ? hit.taxRateCode : (codeByRateId.get(line.taxRateId ?? "") ?? null),
      deductibility: hit ? hit.deductibility : null,
      nonDeductibleIncludedCents: hit ? hit.nonDeductible : 0,
    })
  }
  return out
}

/**
 * La anotación del libro registro que este documento produce **en su periodo de
 * IVA**, que no es el del asiento (D8). Es la mitad izquierda de I-E8-15a/b/c:
 * la derecha son los saldos de 472 y 477 que salen del diario.
 */
function buildVatBookEntry(
  reconciled: ReconcileResult,
  draft: EntryDraft,
  built: BuiltInput,
  documentary: readonly DocumentaryLine[],
  ctx: LedgerContext
): VatBookEntry {
  const p = reconciled.normalized
  const purchase = !isSale(p.docKind)
  const credit = p.docKind === "ABONO_RECIBIDO" || p.docKind === "ABONO_EMITIDO"
  const signo = credit ? -1 : 1

  const inputVat = ctx.map("IVA_SOPORTADO")
  const outputVat = ctx.map("IVA_REPERCUTIDO")
  const selfChargedCodes = new Set(p.taxes.filter((t) => isSelfCharged(t.operationKey)).map((t) => t.taxRateCode))
  const isp = built.templateCode === "FACTURA_RECIBIDA_ISP" || selfChargedCodes.size > 0

  const deducible472 = sum(
    draft.lines.filter((l) => l.accountCode === inputVat).map((l) => l.debitCents - l.creditCents)
  )
  const repercutido477 = sum(
    draft.lines.filter((l) => l.accountCode === outputVat).map((l) => l.creditCents - l.debitCents)
  )
  const noDeducible = sum(documentary.map((d) => d.nonDeductibleIncludedCents))
  const base = signo * sum(built.documentLineAccounts.filter((d) => d.operacion).map((d) => d.baseCents))

  // El 477 de una autorrepercusión NO viene de una factura emitida: viene del
  // libro de RECIBIDAS (OBS-F1 del fixture, casillas 10-13 del 303).
  const devengadaIspAib = isp ? repercutido477 : 0
  const repercutida = isp ? 0 : repercutido477

  return {
    tipo: purchase ? "RECIBIDAS" : "EMITIDAS",
    ivaPeriod: reconciled.ivaPeriod,
    baseCents: base,
    cuotaTotalCents: purchase ? deducible472 + noDeducible : repercutida,
    cuotaDeducibleCents: purchase ? deducible472 : 0,
    cuotaNoDeducibleAlCosteCents: noDeducible,
    cuotaRepercutidaCents: purchase ? 0 : repercutida,
    cuotaDevengadaIspAibCents: devengadaIspAib,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades
// ─────────────────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const isUuid = (value: string | null | undefined): value is string => typeof value === "string" && UUID_RE.test(value)

const quotaMap = (overrides: readonly TaxOverride[]): Record<string, Cents> =>
  Object.fromEntries(overrides.map((o) => [o.taxRateCode, o.quotaCents]))

const rateBpsOf = (ctx: LedgerContext, code: string): number => ctx.rates.find((r) => r.code === code)?.rateBps ?? 0

const sumBases = (b: Pick<BuildContext, "orderedLines" | "baseOf">): Cents => sum(b.orderedLines.map((_, i) => b.baseOf(i)))

const quotaFromContext = (code: string, b: BuildContext, p: ReconcileResult["normalized"]): Cents => {
  const override = b.taxOverrides.find((o) => o.taxRateCode === code)
  if (override) return override.quotaCents
  return p.taxes.find((t) => t.taxRateCode === code)?.quotaCents ?? 0
}

/**
 * Un tipo al 0 % vigente con el que registrar una línea **no sujeta** o un
 * **suplido**: son líneas del asiento sin cuota, y el motor de E3 exige un tipo
 * por línea. No se inventa: se busca en el catálogo de la organización.
 */
function zeroRateCodeFor(ctx: LedgerContext, side: "SALE" | "PURCHASE"): string | null {
  const candidates = ctx.rates
    .filter((r) => r.rateBps === 0 && r.isActive && (r.appliesTo === "BOTH" || r.appliesTo === side))
    .sort((a, b) => (a.code < b.code ? -1 : 1))
  return candidates.find((r) => r.code.includes("NO_SUJETO"))?.code ?? candidates[0]?.code ?? null
}

/** Vencimientos: con varios bloques de pasivo la plantilla exige fecha simple. */
function dueFor(p: ReconcileResult["normalized"], multiBlock: boolean): Record<string, unknown> | null {
  const schedule = p.dueSchedule
  if (!schedule || schedule.length === 0) return null
  if (multiBlock || schedule.length > 1) return { dueDate: schedule[schedule.length - 1].dueDate }
  return { dueSchedule: schedule.map((s) => ({ dueDate: s.dueDate, amountCents: s.amountCents })) }
}

/**
 * Rectificativa por SUSTITUCIÓN: las líneas del asiento son **la diferencia**
 * contra el documento rectificado, tipo a tipo. Contabilizar lo que la
 * rectificativa muestra duplicaría la operación —sobre una factura de 100 000
 * rectificada a 80 000 dejaría el ingreso en 20 000 en lugar de en 80 000—.
 */
function deltaLines(
  delta: NonNullable<ReconcileResult["rectificationDelta"]>,
  lines: readonly ProposalLine[],
  zeroRate: string | null
): { baseCents: Cents; taxRateCode: string | null; line: ProposalLine }[] {
  const out: { baseCents: Cents; taxRateCode: string | null; line: ProposalLine }[] = []
  for (const [code, baseCents] of Object.entries(delta.baseByRate)) {
    if (baseCents === 0) continue
    const sample = lines.find((l) => l.taxRateCode === code) ?? lines[0]
    out.push({ baseCents, taxRateCode: code ?? zeroRate, line: sample })
  }
  return out
}
