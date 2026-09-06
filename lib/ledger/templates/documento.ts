/**
 * E3 · T5a — Bloque A: documento con impuestos (T-01…T-07).
 *
 * Fuente: `docs/design/E3-asientos-tipo.md` §1, T-01…T-07. Estas siete
 * concentran C-5, C-6, C-7, C-10 y C-12 y toda la aritmética de
 * `lib/ledger/tax.ts`: cuota por tipo, retención sobre la base total, prorrata,
 * recargo de equivalencia, ISP y anticipos con IVA devengado.
 *
 * Módulo PURO.
 */

import { applyBps } from "@/lib/taxes/bps"
import { hamilton } from "@/lib/analytics/allocate"
import {
  cuota,
  deducible,
  groupBasesByRate,
  overrideQuota,
  retencion,
  selectRate,
  taxAccrualDate,
  type TaxOverride,
} from "@/lib/ledger/tax"
import { buildEntry, DocumentCheck } from "@/lib/ledger/post"
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
import type {
  AbonoEmitidoInput,
  AbonoRecibidoInput,
  AnticipoInput,
  FacturaEmitidaInput,
  FacturaRecibidaInput,
  PayableBlockInput,
  PayableKey,
} from "@/lib/ledger/templates/schemas"

/** `analyticType` de la línea: override del input, si no el de la cuenta. */
function analyticFor(ctx: LedgerContext, accountCode: string, override?: AnalyticType | null): AnalyticType | null {
  return override ?? ctx.plan.byCode.get(accountCode)?.analyticType ?? null
}

/** Código de una clave del mapa, o error `MAP_KEY_UNMAPPED`. */
function mapped(ctx: LedgerContext, key: AccountKey, errors: LedgerError[]): string | null {
  const code = ctx.map(key)
  if (!code) {
    errors.push(err("MAP_KEY_UNMAPPED", "accountKey", `La clave ${key} no está mapeada a ninguna cuenta del plan`))
    return null
  }
  return code
}

type RateGroup = {
  code: string
  rateId: string
  rateBps: number
  bases: Cents[]
  /**
   * Cuota total del tipo que se CONTABILIZA: la del documento si viene por
   * `taxOverrides` (ADR-0014 D3), y si no la recalculada con el modo de
   * redondeo sellado (R-IVA-1/R-IVA-3).
   */
  cuotaCents: Cents
  /** Cuota recalculada por el motor. Control de verosimilitud, no importe. */
  expectedCents: Cents
  /** La cuota del grupo viene del documento. */
  fromDocument: boolean
  /** Cuota imputada a cada línea; su suma es exactamente `cuotaCents`. */
  perLine: Cents[]
}

/**
 * Cuota por tipo con reparto por línea. La cuota del GRUPO se calcula con el
 * modo sellado (un solo redondeo en `PER_TIPO`) —o se toma del documento, si el
 * llamante la aporta— y el residuo del reparto se asigna a la última línea del
 * grupo, de modo que `Σ perLine === cuotaCents` siempre y la prorrata pueda
 * calcularse línea a línea sin redondear dos veces.
 *
 * `taxDate` es la fecha de **devengo** (art. 90.Dos LIVA, O-14), no la de
 * expedición: la resuelve `taxAccrualDate()`.
 */
function rateGroups(
  lines: readonly { baseCents: Cents; taxRateCode: string }[],
  ctx: LedgerContext,
  taxDate: LocalDate,
  side: "SALE" | "PURCHASE",
  errors: LedgerError[],
  overrides?: readonly TaxOverride[]
): RateGroup[] {
  const groups: RateGroup[] = []
  for (const g of groupBasesByRate(lines.map((l) => ({ baseCents: l.baseCents, taxRateCode: l.taxRateCode })))) {
    const selected = selectRate(ctx, g.code, taxDate, side)
    if ("error" in selected) {
      errors.push(selected.error)
      continue
    }
    const rate = selected.rate
    const expectedCents = cuota(g.bases, rate.rateBps, ctx.policy.taxRoundingMode)
    const declared = overrideQuota(overrides, g.code)
    const cuotaCents = declared ?? expectedCents
    const perLine = g.bases.map((b) => applyBps(b, rate.rateBps))
    const residual = cuotaCents - sumCents(perLine)
    if (perLine.length > 0) perLine[perLine.length - 1] += residual
    groups.push({
      code: g.code,
      rateId: rate.id,
      rateBps: rate.rateBps,
      bases: g.bases,
      cuotaCents,
      expectedCents,
      fromDocument: declared !== null,
      perLine,
    })
  }
  return groups
}

/** Lo que `checkDocument` necesita para medir la desviación de D3, tipo a tipo. */
function quotaChecks(
  groups: readonly RateGroup[]
): { taxRateCode: string; quotaCents: Cents; expectedCents: Cents }[] {
  return groups
    .filter((g) => g.fromDocument)
    .map((g) => ({ taxRateCode: g.code, quotaCents: g.cuotaCents, expectedCents: g.expectedCents }))
}

/** Índice `línea del documento → cuota que le toca`, para la prorrata (T-03). */
function perLineTax(
  lines: readonly { baseCents: Cents; taxRateCode: string }[],
  groups: readonly RateGroup[]
): Map<number, { group: RateGroup; cuotaCents: Cents }> {
  const cursor = new Map<string, number>()
  const out = new Map<number, { group: RateGroup; cuotaCents: Cents }>()
  lines.forEach((l, index) => {
    const group = groups.find((g) => g.code === l.taxRateCode)
    if (!group) return
    const at = cursor.get(l.taxRateCode) ?? 0
    cursor.set(l.taxRateCode, at + 1)
    out.set(index, { group, cuotaCents: group.perLine[at] ?? 0 })
  })
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// E8 · T9b — cuota por línea expuesta, y bloques de pasivo (ADR-0014 D3 y D6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cuota que le toca a **cada línea** del documento, con la misma aritmética que
 * usa la plantilla: cuota del documento si viene por `taxOverrides`, reparto por
 * línea y residuo a la última del grupo.
 *
 * Se exporta para que `postFromProposal` (E8 · T9) construya los
 * `payableBlocks` con los mismos céntimos que después contabilizará la
 * plantilla: dos cálculos separados acabarían divergiendo en el céntimo, y ése
 * es justo el céntimo que decide si un documento mixto cuadra.
 */
export function lineTaxes(
  lines: readonly { baseCents: Cents; taxRateCode: string }[],
  ctx: LedgerContext,
  dates: { operationDate?: string | null; accrualDate?: string | null; documentDate: LocalDate },
  side: "SALE" | "PURCHASE",
  overrides?: readonly TaxOverride[]
): { perLine: Cents[]; totalCents: Cents; errors: LedgerError[] } {
  const errors: LedgerError[] = []
  const groups = rateGroups(lines, ctx, taxAccrualDate(dates), side, errors, overrides)
  const index = perLineTax(lines, groups)
  const perLine = lines.map((_, i) => index.get(i)?.cuotaCents ?? 0)
  return { perLine, totalCents: sumCents(groups.map((g) => g.cuotaCents)), errors }
}

/**
 * ADR-0014 D6 (O-3) — reparto del pasivo de un documento mixto.
 *
 * Cada bloque llega con su **bruto** (`base + su cuota`); la retención y el
 * anticipo aplicado, que son del documento y no de un bloque, se reparten por
 * **mayor resto (Hamilton)** en proporción a ese bruto, con desempate por
 * código de cuenta. Así `Σ líneas de pasivo = pasivo del documento` con
 * tolerancia 0 y el céntimo huérfano cae siempre en el mismo sitio.
 */
export function splitPayableBlocks(
  blocks: readonly { payableKey: PayableKey; accountCode: string; amountCents: Cents }[],
  grossPayable: Cents,
  reductionCents: Cents,
  errors: LedgerError[]
): { payableKey: PayableKey; accountCode: string; amountCents: Cents }[] {
  const declared = sumCents(blocks.map((b) => b.amountCents))
  if (declared !== grossPayable) {
    errors.push(
      err(
        "DOCUMENT_TOTAL_MISMATCH",
        "payableBlocks",
        `Los bloques de pasivo suman ${declared} y el documento debe ${grossPayable} (base + cuotas)`,
        { check: "D6" }
      )
    )
    return []
  }
  if (reductionCents === 0) return blocks.map((b) => ({ ...b }))

  // El peso es el bruto del bloque y el desempate, el código de cuenta: dos
  // bloques de igual importe reparten siempre igual, lea el motor lo que lea.
  const shares = hamilton(
    reductionCents,
    blocks.map((b) => ({ code: b.accountCode, weight: b.amountCents }))
  )
  return blocks.map((b, i) => {
    const amountCents = b.amountCents - (shares[i]?.amountCents ?? 0)
    if (amountCents < 0) {
      errors.push(
        err(
          "DOCUMENT_TOTAL_MISMATCH",
          "payableBlocks",
          `La retención y el anticipo dejan el bloque ${b.payableKey} en ${amountCents}: reparta el documento en dos`,
          { check: "D6" }
        )
      )
    }
    return { ...b, amountCents }
  })
}

/**
 * Toda `PayableKey` es una clave del mapa: el motor pide la cuenta y jamás la
 * inventa. Si la organización no tiene 523 mapeada, sale `MAP_KEY_UNMAPPED`.
 */
const asAccountKey = (key: PayableKey): AccountKey => key

/**
 * Reparte el crédito o la deuda entre vencimientos (decisión 6 de §9.2). Sin
 * calendario, una sola línea con `dueDate` simple.
 */
function receivableLines(
  amountCents: Cents,
  accountCode: string,
  side: "DEBIT" | "CREDIT",
  input: { dueDate?: string; dueSchedule?: readonly { dueDate: string; amountCents: Cents }[] },
  counterpartyId: string | undefined,
  errors: LedgerError[]
): DraftLine[] {
  const schedule = input.dueSchedule
  if (!schedule || schedule.length === 0) {
    const base = { accountCode, counterpartyId: counterpartyId ?? null, dueDate: input.dueDate ?? null }
    return [side === "DEBIT" ? debit(amountCents, base) : credit(amountCents, base)]
  }
  const total = sumCents(schedule.map((s) => s.amountCents))
  if (total !== amountCents) {
    errors.push(
      err(
        "DOCUMENT_TOTAL_MISMATCH",
        "dueSchedule",
        `Los vencimientos suman ${total} y el importe a cobrar/pagar es ${amountCents}`,
        { check: "C-5" }
      )
    )
    return []
  }
  return schedule.map((s) => {
    const base = { accountCode, counterpartyId: counterpartyId ?? null, dueDate: s.dueDate }
    return side === "DEBIT" ? debit(s.amountCents, base) : credit(s.amountCents, base)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// T-01 · FACTURA_EMITIDA_SERVICIOS
// ─────────────────────────────────────────────────────────────────────────────

export function buildFacturaEmitida(input: FacturaEmitidaInput, ctx: LedgerContext): Result<EntryDraft> {
  const errors: LedgerError[] = []
  const docDate = input.documentDate
  // Art. 90.Dos LIVA (O-14): el tipo es el vigente al DEVENGO.
  const taxDate = taxAccrualDate(input)

  const clientesCode = mapped(ctx, "CLIENTES", errors)
  const ivaRepercutidoCode = mapped(ctx, "IVA_REPERCUTIDO", errors)
  const ventasDefaultCode = mapped(ctx, "VENTAS_DEFAULT", errors)

  const groups = rateGroups(input.lines, ctx, taxDate, "SALE", errors, input.taxOverrides)

  // Recargo de equivalencia: tributo distinto, línea separada, casilla propia.
  const surchargeLines = input.lines.filter((l) => l.surchargeRateCode)
  const surchargeGroups = rateGroups(
    surchargeLines.map((l) => ({ baseCents: l.baseCents, taxRateCode: l.surchargeRateCode! })),
    ctx,
    taxDate,
    "SALE",
    errors,
    input.taxOverrides
  )

  const baseTotal = sumCents(input.lines.map((l) => l.baseCents))
  const taxTotal = sumCents(groups.map((g) => g.cuotaCents)) + sumCents(surchargeGroups.map((g) => g.cuotaCents))

  let withholdingCents = 0
  let withholdingRateId: string | null = null
  if (input.withholdingRateCode) {
    const selected = selectRate(ctx, input.withholdingRateCode, docDate, "PURCHASE")
    if ("error" in selected) errors.push(selected.error)
    else {
      withholdingRateId = selected.rate.id
      withholdingCents = retencion(baseTotal, selected.rate.rateBps)
    }
  }

  const advanceCents = input.appliedAdvanceCents ?? 0
  const advanceTaxCents = input.appliedAdvanceTaxCents ?? 0
  if (advanceCents > baseTotal) {
    errors.push(
      err("TEMPLATE_INPUT", "appliedAdvanceCents", `El anticipo aplicado (${advanceCents}) excede la base (${baseTotal})`)
    )
  }

  const documentTotal = baseTotal + taxTotal - withholdingCents
  const receivable = documentTotal - advanceCents - advanceTaxCents

  const irpfCode = input.withholdingRateCode ? mapped(ctx, "IRPF_RETENIDO_CLIENTES", errors) : null
  const anticiposCode = advanceCents > 0 ? mapped(ctx, "ANTICIPOS_CLIENTES", errors) : null

  if (errors.length > 0) return fail<EntryDraft>(...errors)

  const lines: DraftLine[] = [
    ...receivableLines(receivable, clientesCode!, "DEBIT", input, input.counterpartyId, errors),
    ...(irpfCode
      ? [debit(withholdingCents, { accountCode: irpfCode, taxRateId: withholdingRateId, taxBaseCents: baseTotal })]
      : []),
    ...(anticiposCode ? [debit(advanceCents, { accountCode: anticiposCode })] : []),
    ...(advanceTaxCents > 0 ? [debit(advanceTaxCents, { accountCode: ivaRepercutidoCode! })] : []),
    ...input.lines.map((l) => {
      const code = l.revenueAccountCode ?? ventasDefaultCode!
      return credit(l.baseCents, {
        accountCode: code,
        description: l.description ?? null,
        analyticType: analyticFor(ctx, code, l.analyticType),
        projectId: l.projectId ?? null,
        costCenterId: l.costCenterId ?? null,
      })
    }),
    // Tipos exentos (rateBps = 0) NO generan línea de cuota (C-3).
    ...groups
      .filter((g) => g.cuotaCents !== 0)
      .map((g) =>
        credit(g.cuotaCents, {
          accountCode: ivaRepercutidoCode!,
          taxRateId: g.rateId,
          taxBaseCents: sumCents(g.bases),
        })
      ),
    ...surchargeGroups
      .filter((g) => g.cuotaCents !== 0)
      .map((g) =>
        credit(g.cuotaCents, {
          accountCode: ivaRepercutidoCode!,
          taxRateId: g.rateId,
          taxBaseCents: sumCents(g.bases),
        })
      ),
  ]

  if (errors.length > 0) return fail<EntryDraft>(...errors)

  const document: DocumentCheck = {
    totalCents: input.totalCents,
    baseCents: baseTotal,
    lineBases: input.lines.map((l) => l.baseCents),
    taxCents: taxTotal,
    withholdingCents,
    expectedTaxByRate: [...groups.map((g) => g.expectedCents), ...surchargeGroups.map((g) => g.expectedCents)],
    taxQuotaChecks: [...quotaChecks(groups), ...quotaChecks(surchargeGroups)],
    appliedAdvanceCents: advanceCents,
  }

  return buildEntry(
    {
      organizationId: ctx.organizationId,
      documentDate: docDate,
      accrualDate: input.accrualDate ?? null,
      entryDate: input.entryDate ?? null,
      description: input.description ?? `Factura emitida ${input.documentNumber}`,
      kind: "NORMAL",
      sourceType: "INVOICE_OUT",
      sourceId: input.documentNumber,
      templateCode: "FACTURA_EMITIDA_SERVICIOS",
      lines,
    },
    ctx,
    { document, taxAccrualDate: taxDate }
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// T-02 · ABONO_EMITIDO (rectificativa de venta)
// ─────────────────────────────────────────────────────────────────────────────

/** La cuenta de rectificación depende del motivo (§1, T-02). */
const SALE_RECTIFICATION_KEY: Record<AbonoEmitidoInput["reason"], AccountKey> = {
  DEVOLUCION: "DEVOLUCION_VENTAS",
  DESCUENTO_POSTERIOR: "DESCUENTO_PP_VENTAS",
  RAPPEL: "RAPPEL_VENTAS",
  ERROR: "VENTAS_DEFAULT",
}

export function buildAbonoEmitido(input: AbonoEmitidoInput, ctx: LedgerContext): Result<EntryDraft> {
  const errors: LedgerError[] = []
  // El tipo es el vigente en el DOCUMENTO ORIGINAL, no el de hoy; y dentro de
  // ese documento, el del devengo de la operación rectificada (O-14).
  const rateDate = input.originalDocumentDate ?? taxAccrualDate(input)

  const clientesCode = mapped(ctx, "CLIENTES", errors)
  const ivaRepercutidoCode = mapped(ctx, "IVA_REPERCUTIDO", errors)
  const rectificationCode = mapped(ctx, SALE_RECTIFICATION_KEY[input.reason], errors)

  const groups = rateGroups(input.lines, ctx, rateDate, "SALE", errors, input.taxOverrides)
  const baseTotal = sumCents(input.lines.map((l) => l.baseCents))
  const taxTotal = sumCents(groups.map((g) => g.cuotaCents))

  let withholdingCents = 0
  let withholdingRateId: string | null = null
  if (input.withholdingRateCode) {
    const selected = selectRate(ctx, input.withholdingRateCode, rateDate, "PURCHASE")
    if ("error" in selected) errors.push(selected.error)
    else {
      withholdingRateId = selected.rate.id
      withholdingCents = retencion(baseTotal, selected.rate.rateBps)
    }
  }
  const irpfCode = input.withholdingRateCode ? mapped(ctx, "IRPF_RETENIDO_CLIENTES", errors) : null
  if (errors.length > 0) return fail<EntryDraft>(...errors)

  const receivable = baseTotal + taxTotal - withholdingCents

  const lines: DraftLine[] = [
    ...input.lines.map((l) => {
      // Con `ERROR` se rectifica la propia cuenta de ingreso.
      const code = input.reason === "ERROR" ? (l.revenueAccountCode ?? rectificationCode!) : rectificationCode!
      return debit(l.baseCents, {
        accountCode: code,
        description: l.description ?? null,
        analyticType: analyticFor(ctx, code, l.analyticType),
        projectId: l.projectId ?? null,
        costCenterId: l.costCenterId ?? null,
      })
    }),
    ...groups
      .filter((g) => g.cuotaCents !== 0)
      .map((g) =>
        debit(g.cuotaCents, { accountCode: ivaRepercutidoCode!, taxRateId: g.rateId, taxBaseCents: sumCents(g.bases) })
      ),
    ...(irpfCode
      ? [credit(withholdingCents, { accountCode: irpfCode, taxRateId: withholdingRateId, taxBaseCents: baseTotal })]
      : []),
    credit(receivable, { accountCode: clientesCode!, counterpartyId: input.counterpartyId ?? null }),
  ]

  const document: DocumentCheck = {
    totalCents: input.totalCents,
    baseCents: baseTotal,
    lineBases: input.lines.map((l) => l.baseCents),
    taxCents: taxTotal,
    withholdingCents,
    expectedTaxByRate: groups.map((g) => g.expectedCents),
    taxQuotaChecks: quotaChecks(groups),
  }

  return buildEntry(
    {
      organizationId: ctx.organizationId,
      documentDate: input.documentDate,
      accrualDate: input.accrualDate ?? null,
      entryDate: input.entryDate ?? null,
      description: input.description ?? `Abono emitido ${input.documentNumber}`,
      kind: "NORMAL",
      sourceType: "INVOICE_OUT",
      sourceId: input.documentNumber,
      templateCode: "ABONO_EMITIDO",
      lines,
    },
    ctx,
    { document, taxAccrualDate: rateDate }
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// T-03 · FACTURA_RECIBIDA
// ─────────────────────────────────────────────────────────────────────────────

type PurchaseTax = {
  /** Cuota total del documento (la que debe el proveedor, sin prorrata). */
  taxTotal: Cents
  /** Deducible agregado por tipo → línea de 472. */
  deductibleByGroup: { rateId: string; baseCents: Cents; deductibleCents: Cents }[]
  /** No deducible por línea del documento → engorda la línea de gasto. */
  nonDeductibleByLine: Cents[]
}

/**
 * Reparto de la cuota soportada entre deducible (472) y no deducible (mayor
 * precio de adquisición, art. 103 LIVA). El deducible se calcula **por línea** y
 * se agrega por tipo, para no aplicar el redondeo de la prorrata dos veces.
 */
function purchaseTax(
  docLines: readonly { baseCents: Cents; taxRateCode: string; deductibility: "FULL" | "NONE" | "PRORRATA" }[],
  groups: readonly RateGroup[],
  ctx: LedgerContext,
  errors: LedgerError[]
): PurchaseTax {
  const perLine = perLineTax(docLines, groups)
  const nonDeductibleByLine: Cents[] = []
  const accum = new Map<string, { rateId: string; baseCents: Cents; deductibleCents: Cents }>()

  docLines.forEach((l, index) => {
    const hit = perLine.get(index)
    if (!hit) {
      nonDeductibleByLine.push(0)
      return
    }
    const split = deducible(hit.cuotaCents, l.deductibility, ctx.policy.prorrataBps)
    if (split === null) {
      errors.push(
        err(
          "PRORRATA_NOT_CONFIGURED",
          "deductibility",
          "La línea aplica prorrata pero la organización no tiene `prorrataBps` configurada",
          { lineNo: index + 1 }
        )
      )
      nonDeductibleByLine.push(0)
      return
    }
    nonDeductibleByLine.push(split.noDeducibleCents)
    const prev = accum.get(hit.group.rateId)
    accum.set(hit.group.rateId, {
      rateId: hit.group.rateId,
      baseCents: (prev?.baseCents ?? 0) + l.baseCents,
      deductibleCents: (prev?.deductibleCents ?? 0) + split.deducibleCents,
    })
  })

  return {
    taxTotal: sumCents(groups.map((g) => g.cuotaCents)),
    deductibleByGroup: [...accum.values()],
    nonDeductibleByLine,
  }
}

export function buildFacturaRecibida(input: FacturaRecibidaInput, ctx: LedgerContext): Result<EntryDraft> {
  return buildPurchaseInvoice(input, ctx, false)
}

/** T-04 · FACTURA_RECIBIDA_ISP — autorrepercusión, efecto neto en tesorería 0. */
export function buildFacturaRecibidaIsp(input: FacturaRecibidaInput, ctx: LedgerContext): Result<EntryDraft> {
  return buildPurchaseInvoice(input, ctx, true)
}

function buildPurchaseInvoice(input: FacturaRecibidaInput, ctx: LedgerContext, isp: boolean): Result<EntryDraft> {
  const errors: LedgerError[] = []
  const docDate = input.documentDate
  // Art. 90.Dos LIVA (O-14): el tipo es el vigente al DEVENGO.
  const taxDate = taxAccrualDate(input)

  const inputVatKey: AccountKey = isp ? "IVA_SOPORTADO_ISP" : "IVA_SOPORTADO"
  const inputVatCode = mapped(ctx, inputVatKey, errors)
  const outputVatCode = isp ? mapped(ctx, "IVA_REPERCUTIDO_ISP", errors) : null
  const payableCode = mapped(ctx, asAccountKey(input.payableKey), errors)
  const expenseDefaultCode = mapped(
    ctx,
    input.payableKey === "PROVEEDORES" ? "COMPRAS_DEFAULT" : "SUBCONTRATACION_DEFAULT",
    errors
  )

  const groups = rateGroups(input.lines, ctx, taxDate, "PURCHASE", errors, input.taxOverrides)
  const tax = purchaseTax(input.lines, groups, ctx, errors)
  const baseTotal = sumCents(input.lines.map((l) => l.baseCents))

  // O-12: la base de la retención puede NO ser la del documento (suplidos).
  const withholdingBase = input.withholdingBaseCents ?? baseTotal
  let withholdingCents = 0
  let withholdingRateId: string | null = null
  if (input.withholdingRateCode) {
    const selected = selectRate(ctx, input.withholdingRateCode, docDate, "SALE")
    if ("error" in selected) errors.push(selected.error)
    else {
      withholdingRateId = selected.rate.id
      withholdingCents = retencion(withholdingBase, selected.rate.rateBps)
    }
  }
  const withholdingCode = input.withholdingRateCode
    ? mapped(ctx, input.withholdingKey ?? "IRPF_PROFESIONALES_A_PAGAR", errors)
    : null
  const advanceCents = input.appliedAdvanceCents ?? 0
  const advanceCode = advanceCents > 0 ? mapped(ctx, "ANTICIPOS_PROVEEDORES", errors) : null

  // ADR-0014 D6 (O-3): documento mixto → una línea de pasivo POR BLOQUE.
  const blocks: { payableKey: PayableKey; accountCode: string; amountCents: Cents }[] = []
  if (input.payableBlocks) {
    for (const b of input.payableBlocks as readonly PayableBlockInput[]) {
      const code = mapped(ctx, asAccountKey(b.payableKey), errors)
      if (code) blocks.push({ payableKey: b.payableKey, accountCode: code, amountCents: b.amountCents })
    }
    if (input.dueSchedule && input.payableBlocks.length > 1) {
      errors.push(
        err(
          "TEMPLATE_INPUT",
          "dueSchedule",
          "Un documento con varios bloques de pasivo no admite calendario de vencimientos: fraccione el documento"
        )
      )
    }
  }

  if (errors.length > 0) return fail<EntryDraft>(...errors)

  // Con ISP el proveedor NO repercute: la deuda es solo la base.
  const grossPayable = isp ? baseTotal : baseTotal + tax.taxTotal
  const payable = grossPayable - withholdingCents - advanceCents
  const splitBlocks =
    blocks.length > 0 ? splitPayableBlocks(blocks, grossPayable, withholdingCents + advanceCents, errors) : []

  const payableLines: DraftLine[] =
    blocks.length > 0
      ? splitBlocks.map((b) =>
          credit(b.amountCents, {
            accountCode: b.accountCode,
            counterpartyId: input.counterpartyId ?? null,
            dueDate: input.dueDate ?? null,
          })
        )
      : receivableLines(payable, payableCode!, "CREDIT", input, input.counterpartyId, errors)

  const lines: DraftLine[] = [
    ...input.lines.map((l, index) => {
      const code = l.expenseAccountCode ?? expenseDefaultCode!
      return debit(l.baseCents + (tax.nonDeductibleByLine[index] ?? 0), {
        accountCode: code,
        description: l.description ?? null,
        analyticType: analyticFor(ctx, code, l.analyticType),
        projectId: l.projectId ?? null,
        costCenterId: l.costCenterId ?? null,
      })
    }),
    ...tax.deductibleByGroup
      .filter((g) => g.deductibleCents !== 0)
      .map((g) => debit(g.deductibleCents, { accountCode: inputVatCode!, taxRateId: g.rateId, taxBaseCents: g.baseCents })),
    ...(advanceCode ? [credit(advanceCents, { accountCode: advanceCode })] : []),
    ...payableLines,
    ...(withholdingCode
      ? [credit(withholdingCents, { accountCode: withholdingCode, taxRateId: withholdingRateId, taxBaseCents: withholdingBase })]
      : []),
    // ISP: la autorrepercusión, con el MISMO taxRateId y el importe íntegro.
    ...(isp
      ? groups
          .filter((g) => g.cuotaCents !== 0)
          .map((g) =>
            credit(g.cuotaCents, { accountCode: outputVatCode!, taxRateId: g.rateId, taxBaseCents: sumCents(g.bases) })
          )
      : []),
  ]

  if (errors.length > 0) return fail<EntryDraft>(...errors)

  const document: DocumentCheck = {
    totalCents: input.totalCents,
    baseCents: baseTotal,
    lineBases: input.lines.map((l) => l.baseCents),
    // Con ISP el documento del proveedor es solo la base: no repercute nada.
    taxCents: isp ? 0 : tax.taxTotal,
    withholdingCents,
    expectedTaxByRate: isp ? [] : groups.map((g) => g.expectedCents),
    taxQuotaChecks: quotaChecks(groups),
    appliedAdvanceCents: advanceCents,
  }

  return buildEntry(
    {
      organizationId: ctx.organizationId,
      documentDate: docDate,
      accrualDate: input.accrualDate ?? null,
      entryDate: input.entryDate ?? null,
      description: input.description ?? `Factura recibida ${input.supplierDocumentNumber}`,
      kind: "NORMAL",
      sourceType: "DOCUMENT",
      sourceId: input.supplierDocumentNumber,
      templateCode: isp ? "FACTURA_RECIBIDA_ISP" : "FACTURA_RECIBIDA",
      lines,
    },
    ctx,
    { document, taxAccrualDate: taxDate }
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// T-05 · ABONO_RECIBIDO
// ─────────────────────────────────────────────────────────────────────────────

export function buildAbonoRecibido(input: AbonoRecibidoInput, ctx: LedgerContext): Result<EntryDraft> {
  const errors: LedgerError[] = []
  const rateDate = input.originalDocumentDate ?? taxAccrualDate(input)

  const payableCode = mapped(ctx, asAccountKey(input.payableKey), errors)
  const inputVatCode = mapped(ctx, "IVA_SOPORTADO", errors)
  const rectificationKey: AccountKey =
    input.reason === "DEVOLUCION"
      ? "DEVOLUCION_COMPRAS"
      : input.reason === "DESCUENTO_POSTERIOR"
        ? "DESCUENTO_PP_COMPRAS"
        : input.reason === "RAPPEL"
          ? "RAPPEL_COMPRAS"
          : input.payableKey === "PROVEEDORES"
            ? "COMPRAS_DEFAULT"
            : "SUBCONTRATACION_DEFAULT"
  const rectificationCode = mapped(ctx, rectificationKey, errors)

  const groups = rateGroups(input.lines, ctx, rateDate, "PURCHASE", errors, input.taxOverrides)
  const tax = purchaseTax(input.lines, groups, ctx, errors)
  const baseTotal = sumCents(input.lines.map((l) => l.baseCents))

  let withholdingCents = 0
  let withholdingRateId: string | null = null
  if (input.withholdingRateCode) {
    const selected = selectRate(ctx, input.withholdingRateCode, rateDate, "SALE")
    if ("error" in selected) errors.push(selected.error)
    else {
      withholdingRateId = selected.rate.id
      withholdingCents = retencion(baseTotal, selected.rate.rateBps)
    }
  }
  const withholdingCode = input.withholdingRateCode
    ? mapped(ctx, input.withholdingKey ?? "IRPF_PROFESIONALES_A_PAGAR", errors)
    : null
  if (errors.length > 0) return fail<EntryDraft>(...errors)

  const payable = baseTotal + tax.taxTotal - withholdingCents

  const lines: DraftLine[] = [
    debit(payable, { accountCode: payableCode!, counterpartyId: input.counterpartyId ?? null }),
    ...(withholdingCode
      ? [debit(withholdingCents, { accountCode: withholdingCode, taxRateId: withholdingRateId, taxBaseCents: baseTotal })]
      : []),
    ...input.lines.map((l, index) => {
      // Si el IVA era no deducible, el abono minora el gasto por Bᵢ + NDᵢ.
      const code = input.reason === "ERROR" ? (l.expenseAccountCode ?? rectificationCode!) : rectificationCode!
      return credit(l.baseCents + (tax.nonDeductibleByLine[index] ?? 0), {
        accountCode: code,
        description: l.description ?? null,
        analyticType: analyticFor(ctx, code, l.analyticType),
        projectId: l.projectId ?? null,
        costCenterId: l.costCenterId ?? null,
      })
    }),
    ...tax.deductibleByGroup
      .filter((g) => g.deductibleCents !== 0)
      .map((g) =>
        credit(g.deductibleCents, { accountCode: inputVatCode!, taxRateId: g.rateId, taxBaseCents: g.baseCents })
      ),
  ]

  const document: DocumentCheck = {
    totalCents: input.totalCents,
    baseCents: baseTotal,
    lineBases: input.lines.map((l) => l.baseCents),
    taxCents: tax.taxTotal,
    withholdingCents,
    expectedTaxByRate: groups.map((g) => g.expectedCents),
    taxQuotaChecks: quotaChecks(groups),
  }

  return buildEntry(
    {
      organizationId: ctx.organizationId,
      documentDate: input.documentDate,
      accrualDate: input.accrualDate ?? null,
      entryDate: input.entryDate ?? null,
      description: input.description ?? `Abono recibido ${input.supplierDocumentNumber}`,
      kind: "NORMAL",
      sourceType: "DOCUMENT",
      sourceId: input.supplierDocumentNumber,
      templateCode: "ABONO_RECIBIDO",
      lines,
    },
    ctx,
    { document, taxAccrualDate: rateDate }
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// T-06 · ANTICIPO_CLIENTE · T-07 · ANTICIPO_PROVEEDOR
// ─────────────────────────────────────────────────────────────────────────────

function advanceTax(
  input: AnticipoInput,
  ctx: LedgerContext,
  side: "SALE" | "PURCHASE",
  errors: LedgerError[]
): { taxCents: Cents; rateId: string | null } {
  if (!input.taxRateCode) return { taxCents: 0, rateId: null }
  const selected = selectRate(ctx, input.taxRateCode, input.documentDate, side)
  if ("error" in selected) {
    errors.push(selected.error)
    return { taxCents: 0, rateId: null }
  }
  // Art. 75.Dos LIVA: el anticipo devenga IVA.
  return { taxCents: applyBps(input.amountCents, selected.rate.rateBps), rateId: selected.rate.id }
}

export function buildAnticipoCliente(input: AnticipoInput, ctx: LedgerContext): Result<EntryDraft> {
  const errors: LedgerError[] = []
  const bankCode = input.bankAccountCode ?? mapped(ctx, input.bankKey, errors)
  const advanceCode = mapped(ctx, "ANTICIPOS_CLIENTES", errors)
  const vatCode = mapped(ctx, "IVA_REPERCUTIDO", errors)
  const { taxCents, rateId } = advanceTax(input, ctx, "SALE", errors)
  if (errors.length > 0) return fail<EntryDraft>(...errors)

  return buildEntry(
    {
      organizationId: ctx.organizationId,
      documentDate: input.documentDate,
      accrualDate: input.accrualDate ?? null,
      entryDate: input.entryDate ?? null,
      description: input.description ?? "Anticipo de cliente",
      kind: "NORMAL",
      sourceType: "MANUAL",
      templateCode: "ANTICIPO_CLIENTE",
      lines: [
        debit(input.amountCents + taxCents, { accountCode: bankCode! }),
        // Pasivo, nunca ingreso: no toca 705 ni la PyG.
        credit(input.amountCents, { accountCode: advanceCode!, counterpartyId: input.counterpartyId ?? null }),
        credit(taxCents, { accountCode: vatCode!, taxRateId: rateId, taxBaseCents: input.amountCents }),
      ],
    },
    ctx
  )
}

export function buildAnticipoProveedor(input: AnticipoInput, ctx: LedgerContext): Result<EntryDraft> {
  const errors: LedgerError[] = []
  const bankCode = input.bankAccountCode ?? mapped(ctx, input.bankKey, errors)
  const advanceCode = mapped(ctx, "ANTICIPOS_PROVEEDORES", errors)
  const vatCode = mapped(ctx, "IVA_SOPORTADO", errors)
  const { taxCents, rateId } = advanceTax(input, ctx, "PURCHASE", errors)
  if (errors.length > 0) return fail<EntryDraft>(...errors)

  return buildEntry(
    {
      organizationId: ctx.organizationId,
      documentDate: input.documentDate,
      accrualDate: input.accrualDate ?? null,
      entryDate: input.entryDate ?? null,
      description: input.description ?? "Anticipo a proveedor",
      kind: "NORMAL",
      sourceType: "MANUAL",
      templateCode: "ANTICIPO_PROVEEDOR",
      lines: [
        // Activo, no gasto: no toca la PyG ni la analítica.
        debit(input.amountCents, { accountCode: advanceCode!, counterpartyId: input.counterpartyId ?? null }),
        debit(taxCents, { accountCode: vatCode!, taxRateId: rateId, taxBaseCents: input.amountCents }),
        credit(input.amountCents + taxCents, { accountCode: bankCode! }),
      ],
    },
    ctx
  )
}
