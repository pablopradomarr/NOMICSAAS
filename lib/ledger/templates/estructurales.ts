/**
 * E3 · T5c — Bloque C: estructurales y de cierre (T-19…T-28).
 *
 * No construyen desde un documento sino desde **saldos del diario** o desde
 * otro asiento. El motor sigue siendo puro: los saldos los aporta el llamante
 * (`ctx.balances`, que `models/ledger.getAccountBalances` rellena).
 *
 * T-25…T-28 no tienen acción de usuario en E3 (§1): se implementan y se testean
 * porque I-E3-5 exige 28/28, pero lo que les falta no es la plantilla, es el
 * cálculo de la base imponible con ajustes extracontables y la orquestación del
 * cierre, que son E9.
 */

import { applyBps } from "@/lib/taxes/bps"
import { buildEntry } from "@/lib/ledger/post"
import { accountGroup } from "@/lib/ledger/post"
import { buildReversal, VoidOptions } from "@/lib/ledger/void"
import { selectRate } from "@/lib/ledger/tax"
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
  PostedEntry,
  Result,
} from "@/lib/ledger/types"
import { credit, debit, sided } from "@/lib/ledger/templates/types"
import type {
  AjusteEjercicioCerradoInput,
  AperturaEjercicioInput,
  AsientoManualInput,
  BalanceDrivenInput,
  ContraAsientoInput,
  ImpuestoBeneficiosInput,
  RegularizacionIvaInput,
  TraspasoTesoreriaInput,
} from "@/lib/ledger/templates/schemas"

import { templateDestination } from "@/lib/ledger/templates/dimensions"

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

/** Saldos: los del input si vienen, si no los del contexto. */
function balancesOf(input: { balances?: Record<string, number> }, ctx: LedgerContext): Map<string, Cents> {
  if (input.balances) return new Map(Object.entries(input.balances))
  return new Map(ctx.balances ?? [])
}

/** Orden canónico de los asientos por saldos: código de cuenta ascendente. */
const byCode = (a: { code: string }, b: { code: string }) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)

// ─────────────────────────────────────────────────────────────────────────────
// T-19 · TRASPASO_TESORERIA
// ─────────────────────────────────────────────────────────────────────────────

export function buildTraspasoTesoreria(input: TraspasoTesoreriaInput, ctx: LedgerContext): Result<EntryDraft> {
  const errors: LedgerError[] = []
  const fromCode = input.fromAccountCode ?? (input.fromKey ? mapped(ctx, input.fromKey, errors) : null)
  const toCode = input.toAccountCode ?? (input.toKey ? mapped(ctx, input.toKey, errors) : null)
  if (!fromCode || !toCode) {
    errors.push(err("ACCOUNT_UNKNOWN", "fromAccountCode", "El traspaso necesita cuenta de origen y de destino"))
    return fail<EntryDraft>(...errors)
  }
  // Origen ≠ destino: si no, el cashflow directo (I6) registraría un flujo
  // ficticio entre dos cuentas que son la misma.
  if (fromCode === toCode) {
    errors.push(
      err("TEMPLATE_INPUT", "toAccountCode", "El origen y el destino del traspaso no pueden ser la misma cuenta")
    )
  }
  // Ambas deben ser cuentas de tesorería (57x): un traspaso interno se excluye
  // de las categorías de cashflow, no es flujo.
  for (const [field, code] of [
    ["fromAccountCode", fromCode],
    ["toAccountCode", toCode],
  ] as const) {
    const account = ctx.plan.byCode.get(code)
    // E6: la tesorería es el prefijo `57` (R-CF-1), no «la que no tiene bucket»
    // —`cashflowBucket` está a null también en los contenedores mixtos `4`/`5`—.
    if (account && !code.startsWith("57")) {
      errors.push(err("TEMPLATE_INPUT", field, `La cuenta ${code} no es una cuenta de tesorería (57x)`))
    }
  }

  const feeCents = input.bankFeeCents ?? 0
  const feeCode = feeCents > 0 ? mapped(ctx, "COMISIONES_BANCARIAS", errors) : null
  if (errors.length > 0) return fail<EntryDraft>(...errors)

  const lines: DraftLine[] = [
    debit(input.amountCents, { accountCode: toCode }),
    ...(feeCode
      ? [
          // E4 · T6: la comisión bancaria de un traspaso es `G_A` por defecto.
          debit(feeCents, {
            accountCode: feeCode,
            analyticType: analyticFor(ctx, feeCode),
            ...templateDestination(ctx, "G_A", { costCenterId: input.bankFeeCostCenterId ?? null }),
          }),
        ]
      : []),
    credit(input.amountCents + feeCents, { accountCode: fromCode }),
  ]

  return buildEntry(
    {
      organizationId: ctx.organizationId,
      documentDate: input.documentDate,
      entryDate: input.entryDate ?? null,
      description: input.description ?? "Traspaso entre cuentas de tesorería",
      kind: "NORMAL",
      sourceType: "BANK_IMPORT",
      templateCode: "TRASPASO_TESORERIA",
      lines,
    },
    ctx
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// T-20 · ASIENTO_MANUAL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * El asiento manual no es una puerta trasera: pasa las trece comprobaciones sin
 * excepción, es siempre `NORMAL` (los `kind` de sistema solo los produce el
 * motor) y no puede tocar la 129 fuera de T-26.
 */
export function buildAsientoManual(input: AsientoManualInput, ctx: LedgerContext): Result<EntryDraft> {
  const errors: LedgerError[] = []
  const resultCode = ctx.map("RESULTADO_EJERCICIO")

  const lines: DraftLine[] = input.lines.map((l, index) => {
    const code = l.accountCode ?? (l.accountKey ? ctx.map(l.accountKey as AccountKey) : null)
    if (!code) {
      errors.push(
        err("ACCOUNT_UNKNOWN", "accountCode", "La línea no indica ni clave ni código de cuenta", { lineNo: index + 1 })
      )
    }
    if (code && resultCode && code === resultCode) {
      errors.push(
        err(
          "TEMPLATE_INPUT",
          "accountCode",
          `La cuenta ${code} (resultado del ejercicio) solo la mueve la regularización (T-26)`,
          { lineNo: index + 1 }
        )
      )
    }
    return {
      lineNo: index + 1,
      accountCode: code ?? "",
      debitCents: l.debitCents,
      creditCents: l.creditCents,
      description: l.description ?? null,
      dueDate: l.dueDate ?? null,
      counterpartyId: l.counterpartyId ?? null,
      taxRateId: l.taxRateId ?? null,
      analyticType: code ? analyticFor(ctx, code, l.analyticType) : null,
      projectId: l.projectId ?? null,
      costCenterId: l.costCenterId ?? null,
    }
  })
  if (errors.length > 0) return fail<EntryDraft>(...errors)

  return buildEntry(
    {
      organizationId: ctx.organizationId,
      documentDate: input.documentDate ?? null,
      accrualDate: input.accrualDate ?? null,
      entryDate: input.entryDate ?? null,
      description: input.description,
      kind: "NORMAL",
      sourceType: "MANUAL",
      sourceId: input.sourceId ?? null,
      templateCode: "ASIENTO_MANUAL",
      lines,
    },
    ctx
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// T-21 · CONTRA_ASIENTO
// ─────────────────────────────────────────────────────────────────────────────

export type ContraAsientoBuildInput = ContraAsientoInput & {
  /** El asiento a anular, ya leído: el motor no toca la BD. */
  entry: PostedEntry
  existingReversals?: readonly { id: string }[]
}

export function buildContraAsiento(input: ContraAsientoBuildInput, ctx: LedgerContext): Result<EntryDraft> {
  const opts: VoidOptions = {
    reason: input.reason,
    requestedDate: input.requestedDate ?? null,
    existingReversals: input.existingReversals ?? [],
  }
  return buildReversal(input.entry, opts, ctx)
}

// ─────────────────────────────────────────────────────────────────────────────
// T-22 · AJUSTE_EJERCICIO_CERRADO (NRV 22ª)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Documento cuyo devengo pertenece a un ejercicio `CLOSED`. Nunca se abre el
 * ejercicio cerrado: el asiento se registra en el primer ejercicio abierto, con
 * `documentDate` en el antiguo y `entryDate` en el abierto.
 *
 * Error material o cambio de criterio → **113/121** (sin efecto en la PyG);
 * importe no significativo → **678/778** (epígrafe 13). Las cuentas 679/779 NO
 * existen en el PGC 2007 y no están en `seeds/npgc.csv`.
 */
export const AJUSTE_NO_SIGNIFICATIVO_GASTO = "678"
export const AJUSTE_NO_SIGNIFICATIVO_INGRESO = "778"
export const AJUSTE_MATERIAL_RESERVAS = "113"

export function buildAjusteEjercicioCerrado(
  input: AjusteEjercicioCerradoInput,
  ctx: LedgerContext
): Result<EntryDraft> {
  const errors: LedgerError[] = []

  // El documento debe pertenecer a un ejercicio CERRADO; si no, es un asiento
  // normal y esta plantilla no aplica.
  const documentFy = ctx.fiscalYears.find(
    (fy) => input.documentDate >= fy.startDate && input.documentDate <= fy.endDate
  )
  if (documentFy && documentFy.status === "OPEN") {
    errors.push(
      err(
        "TEMPLATE_INPUT",
        "documentDate",
        `El ejercicio ${documentFy.code} del documento sigue abierto: el asiento va con su plantilla normal, no con T-22`
      )
    )
  }

  const isMaterial = input.adjustmentKind === "MATERIAL"
  const adjustmentCode = isMaterial
    ? (input.equityAccountCode ?? AJUSTE_MATERIAL_RESERVAS)
    : input.direction === "GASTO"
      ? AJUSTE_NO_SIGNIFICATIVO_GASTO
      : AJUSTE_NO_SIGNIFICATIVO_INGRESO

  // El ajuste a reservas es patrimonio, no PyG: no admite destino analítico
  // (rompería I4).
  if (isMaterial && (input.projectId || input.costCenterId)) {
    errors.push(
      err(
        "ANALYTIC_DIM_UNAVAILABLE",
        "projectId",
        "Un ajuste material contra reservas es patrimonio y no lleva destino analítico"
      )
    )
  }

  const counterpartCode =
    input.counterpartAccountCode ?? (input.counterpartKey ? mapped(ctx, input.counterpartKey, errors) : null)
  if (!counterpartCode) {
    errors.push(err("ACCOUNT_UNKNOWN", "counterpartAccountCode", "El ajuste necesita una contrapartida real"))
  }

  // IVA soportado del documento antiguo: deducible en el periodo corriente si
  // está dentro del plazo de 4 años (art. 99 LIVA).
  const vatCents = input.deductibleVatCents ?? 0
  let vatRateId: string | null = null
  let vatCode: string | null = null
  if (vatCents > 0) {
    vatCode = mapped(ctx, "IVA_SOPORTADO", errors)
    if (input.deductibleVatRateCode) {
      const selected = selectRate(ctx, input.deductibleVatRateCode, input.documentDate, "PURCHASE")
      if ("error" in selected) errors.push(selected.error)
      else vatRateId = selected.rate.id
    }
  }
  if (errors.length > 0) return fail<EntryDraft>(...errors)

  const isCharge = input.direction === "GASTO"
  const lines: DraftLine[] = isCharge
    ? [
        debit(input.amountCents, {
          accountCode: adjustmentCode,
          analyticType: isMaterial ? null : analyticFor(ctx, adjustmentCode, input.analyticType),
          // E4 · T6: `678`/`778` son epígrafe 13, DENTRO del resultado de
          // explotación (§8.3): CECO `G_A` por defecto, nivel EBITDA.
          ...(isMaterial
            ? { projectId: null, costCenterId: null }
            : templateDestination(ctx, "G_A", { projectId: input.projectId ?? null, costCenterId: input.costCenterId ?? null })),
        }),
        ...(vatCode ? [debit(vatCents, { accountCode: vatCode, taxRateId: vatRateId, taxBaseCents: input.amountCents })] : []),
        credit(input.amountCents + vatCents, { accountCode: counterpartCode! }),
      ]
    : [
        debit(input.amountCents + vatCents, { accountCode: counterpartCode! }),
        credit(input.amountCents, {
          accountCode: adjustmentCode,
          analyticType: isMaterial ? null : analyticFor(ctx, adjustmentCode, input.analyticType),
          // E4 · T6: `678`/`778` son epígrafe 13, DENTRO del resultado de
          // explotación (§8.3): CECO `G_A` por defecto, nivel EBITDA.
          ...(isMaterial
            ? { projectId: null, costCenterId: null }
            : templateDestination(ctx, "G_A", { projectId: input.projectId ?? null, costCenterId: input.costCenterId ?? null })),
        }),
        ...(vatCode ? [credit(vatCents, { accountCode: vatCode, taxRateId: vatRateId, taxBaseCents: input.amountCents })] : []),
      ]

  return buildEntry(
    {
      organizationId: ctx.organizationId,
      documentDate: input.documentDate,
      // El devengo NO se propaga: llevaría el asiento al ejercicio cerrado.
      entryDate: input.entryDate,
      description: input.reason,
      kind: "NORMAL",
      sourceType: "MANUAL",
      templateCode: "AJUSTE_EJERCICIO_CERRADO",
      lines,
    },
    ctx
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// T-23 · REGULARIZACION_IVA (modelo 303)
// ─────────────────────────────────────────────────────────────────────────────

export function buildRegularizacionIva(input: RegularizacionIvaInput, ctx: LedgerContext): Result<EntryDraft> {
  const errors: LedgerError[] = []
  const outputCode = mapped(ctx, "IVA_REPERCUTIDO", errors)
  const inputCode = mapped(ctx, "IVA_SOPORTADO", errors)
  const carryForward = input.carryForwardCents ?? 0
  const resultado = input.outputCents - input.inputCents - carryForward

  const payableCode = resultado > 0 ? mapped(ctx, "HP_ACREEDORA_IVA", errors) : null
  const receivableCode = resultado < 0 || carryForward > 0 ? mapped(ctx, "HP_DEUDORA_IVA", errors) : null
  if (errors.length > 0) return fail<EntryDraft>(...errors)

  const lines: DraftLine[] = [
    // Saldan 477 y 472 del periodo a CERO exacto; se omiten si son 0 (C-3).
    debit(input.outputCents, { accountCode: outputCode! }),
    credit(input.inputCents, { accountCode: inputCode! }),
    // Consume la cuota a compensar de trimestres anteriores.
    ...(carryForward > 0 ? [credit(carryForward, { accountCode: receivableCode! })] : []),
    ...(resultado < 0 ? [debit(-resultado, { accountCode: receivableCode! })] : []),
    ...(resultado > 0 ? [credit(resultado, { accountCode: payableCode! })] : []),
  ]

  return buildEntry(
    {
      organizationId: ctx.organizationId,
      documentDate: input.periodEnd,
      entryDate: input.entryDate ?? input.periodEnd,
      description: input.description ?? `Liquidación de IVA ${input.periodStart} .. ${input.periodEnd} (modelo 303)`,
      kind: "NORMAL",
      sourceType: "SYSTEM",
      sourceId: `${input.periodStart}/${input.periodEnd}`,
      templateCode: "REGULARIZACION_IVA",
      lines,
    },
    ctx
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// T-25 · IMPUESTO_BENEFICIOS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **E9 · O-26 (T-25 modificada).** Dos correcciones que un auditor mira:
 *
 * 1. La cuenta es **`6300` Impuesto corriente**, no el padre `630`
 *    (`IMPUESTO_CORRIENTE`; `IMPUESTO_BENEFICIOS_GASTO` sigue como respaldo para
 *    el plan que no tenga la subcuenta, y no se rompe nada de lo ya mapeado).
 * 2. La cancelación de **`473`** es **obligatoria**, no condicional: retenciones
 *    soportadas y pagos fraccionados son un activo que la liquidación consume.
 *    Sin ella —el defecto que O-26 destapa— el activo (`473`) y el pasivo
 *    (`4752`) quedan **simultáneamente sobrevalorados por el mismo importe**,
 *    con compensación aparente en el resultado.
 *
 * *(ejemplo del experto: base 2 000 000 al 25 %, retenciones 120 000 y pagos
 * fraccionados 180 000 ⇒ `6300 (D) 500 000 / 473 (H) 300 000 / 4752 (H) 200 000`.)*
 */
export function buildImpuestoBeneficios(input: ImpuestoBeneficiosInput, ctx: LedgerContext): Result<EntryDraft> {
  const errors: LedgerError[] = []
  const expenseCode = ctx.map("IMPUESTO_CORRIENTE") ?? mapped(ctx, "IMPUESTO_BENEFICIOS_GASTO", errors)
  // Base negativa: no hay cuota (la BIN se compensa en ejercicios futuros, E10).
  const cuotaCents = input.taxableBaseCents > 0 ? applyBps(input.taxableBaseCents, input.rateBps) : 0
  const prepayments = input.prepaymentsCents ?? 0
  const netCents = cuotaCents - prepayments
  const payableCode = netCents >= 0 ? mapped(ctx, "HP_ACREEDORA_IS", errors) : mapped(ctx, "HP_DEUDORA_IS", errors)
  const prepaymentsCode = prepayments > 0 ? mapped(ctx, "IRPF_RETENIDO_CLIENTES", errors) : null
  if (cuotaCents === 0) {
    errors.push(
      err("TEMPLATE_INPUT", "taxableBaseCents", "Sin base imponible positiva no hay cuota que contabilizar en T-25")
    )
  }
  if (errors.length > 0) return fail<EntryDraft>(...errors)

  const lines: DraftLine[] = [
    debit(cuotaCents, { accountCode: expenseCode!, analyticType: "NO_ANALITICO" }),
    // O-26: los pagos a cuenta se cancelan SIEMPRE, tanto si la cuota
    // diferencial sale a pagar como a devolver.
    ...(prepaymentsCode
      ? [
          credit(prepayments, {
            accountCode: prepaymentsCode,
            description: "Cancelación de retenciones soportadas y pagos fraccionados",
          }),
        ]
      : []),
    ...(netCents >= 0
      ? [credit(netCents, { accountCode: payableCode! })]
      : [debit(-netCents, { accountCode: payableCode! })]),
  ]

  return buildEntry(
    {
      organizationId: ctx.organizationId,
      documentDate: input.documentDate,
      entryDate: input.entryDate ?? input.documentDate,
      description: input.description ?? "Impuesto sobre beneficios del ejercicio",
      kind: "NORMAL",
      sourceType: "SYSTEM",
      templateCode: "IMPUESTO_BENEFICIOS",
      lines,
    },
    ctx
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// T-26 · REGULARIZACION_RESULTADO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lleva a cero **toda** cuenta de grupo 6 y 7 y abona (o carga) la diferencia
 * en la 129. El asiento es `REGULARIZATION` y por tanto queda EXCLUIDO del
 * cálculo de la PyG: si no, la PyG se duplicaría a cero.
 */
export function buildRegularizacionResultado(input: BalanceDrivenInput, ctx: LedgerContext): Result<EntryDraft> {
  const errors: LedgerError[] = []
  const resultCode = mapped(ctx, "RESULTADO_EJERCICIO", errors)
  if (errors.length > 0) return fail<EntryDraft>(...errors)

  const balances = balancesOf(input, ctx)
  const pnl = [...balances.entries()]
    .filter(([code, saldo]) => (accountGroup(code) === 6 || accountGroup(code) === 7) && saldo !== 0)
    .map(([code, saldo]) => ({ code, saldo }))
    .sort(byCode)

  if (pnl.length === 0) {
    return fail<EntryDraft>(
      err("TEMPLATE_INPUT", "balances", "No hay ninguna cuenta de grupo 6 o 7 con saldo que regularizar")
    )
  }

  // resultado = Σ(haber − debe) de las líneas 6/7 = I3.
  const resultado = pnl.reduce((acc, a) => acc - a.saldo, 0)

  const lines: DraftLine[] = [
    // Cada cuenta se lleva a 0 por la columna contraria a su saldo. Sin destino
    // analítico: es un movimiento de patrimonio, e I4 lo excluye por `kind`.
    ...pnl.map((a) => sided(-a.saldo, { accountCode: a.code })),
    sided(-resultado, { accountCode: resultCode! }),
  ]

  return buildEntry(
    {
      organizationId: ctx.organizationId,
      entryDate: input.entryDate,
      description: input.description ?? "Regularización de gastos e ingresos",
      kind: "REGULARIZATION",
      sourceType: "SYSTEM",
      templateCode: "REGULARIZACION_RESULTADO",
      lines,
    },
    ctx
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// T-27 · CIERRE_EJERCICIO · T-28 · APERTURA_EJERCICIO
// ─────────────────────────────────────────────────────────────────────────────

/** Cuentas de balance: grupos 1 a 5. */
const isBalanceAccount = (code: string): boolean => accountGroup(code) >= 1 && accountGroup(code) <= 5

export function buildCierreEjercicio(input: BalanceDrivenInput, ctx: LedgerContext): Result<EntryDraft> {
  const balances = balancesOf(input, ctx)

  // Ninguna cuenta de grupo 6/7 puede aparecer: T-26 ya las dejó a cero.
  const pending = [...balances.entries()].filter(
    ([code, saldo]) => (accountGroup(code) === 6 || accountGroup(code) === 7) && saldo !== 0
  )
  if (pending.length > 0) {
    return fail<EntryDraft>(
      err(
        "TEMPLATE_INPUT",
        "balances",
        `Quedan cuentas de gasto o ingreso con saldo antes del cierre (${pending.map(([c]) => c).join(", ")}): ` +
          "hay que regularizar (T-26) primero"
      )
    )
  }

  const accounts = [...balances.entries()]
    .filter(([code, saldo]) => isBalanceAccount(code) && saldo !== 0)
    .map(([code, saldo]) => ({ code, saldo }))
    .sort(byCode)

  if (accounts.length === 0) {
    return fail<EntryDraft>(err("TEMPLATE_INPUT", "balances", "No hay ninguna cuenta de balance con saldo que cerrar"))
  }

  // Saldo deudor → línea al haber; saldo acreedor → línea al debe.
  const lines: DraftLine[] = accounts.map((a) => sided(-a.saldo, { accountCode: a.code }))

  return buildEntry(
    {
      organizationId: ctx.organizationId,
      entryDate: input.entryDate,
      description: input.description ?? "Cierre del ejercicio",
      kind: "CLOSING",
      sourceType: "SYSTEM",
      templateCode: "CIERRE_EJERCICIO",
      lines,
    },
    ctx
  )
}

/**
 * Espejo exacto del cierre, con la fecha del primer día del ejercicio siguiente
 * (I-E3-6). Un `diff` de un céntimo entre cierre y apertura bloquea.
 */
export function buildAperturaEjercicio(input: AperturaEjercicioInput, ctx: LedgerContext): Result<EntryDraft> {
  const balances = balancesOf(input, ctx)
  const accounts = [...balances.entries()]
    .filter(([code, saldo]) => isBalanceAccount(code) && saldo !== 0)
    .map(([code, saldo]) => ({ code, saldo }))
    .sort(byCode)

  if (accounts.length === 0) {
    return fail<EntryDraft>(err("TEMPLATE_INPUT", "balances", "No hay ningún saldo que abrir"))
  }

  // Saldo deudor al debe, acreedor al haber: exactamente lo contrario del cierre.
  const lines: DraftLine[] = accounts.map((a) => sided(a.saldo, { accountCode: a.code }))

  return buildEntry(
    {
      organizationId: ctx.organizationId,
      entryDate: input.entryDate,
      description: input.description ?? "Apertura del ejercicio",
      kind: "OPENING",
      sourceType: "SYSTEM",
      templateCode: "APERTURA_EJERCICIO",
      lines,
    },
    ctx
  )
}
