/**
 * E8 · T14 — Invariantes **I-E8-1…20** del camino documento → asiento
 * (`docs/design/E8-documentos-asientos.md` §5.1, ADR-0014 D7 y D14).
 *
 * Módulo **PURO**: recibe los datos ya leídos y devuelve `CheckResult[]` con la
 * consulta que reproduce cada evidencia. Vive aparte de `invariants.ts` por lo
 * mismo que el bloque analítico y el de informes: para que la épica se pueda
 * leer y auditar entera de un tirón, y para que `runInvariants` la cablee sin
 * que ninguna organización que no use documentos vea un FAIL por no tenerlos.
 *
 * **La regla que gobierna el fichero: nunca un PASS que no se haya comprobado.**
 * Un invariante que no se puede evaluar con los datos aportados devuelve `INFO`
 * diciendo qué le falta. Devolver PASS sin haber mirado es exactamente el fallo
 * que la capa de fiabilidad existe para impedir (P2).
 *
 * Los tres puentes al 303 van **partidos en tres** (D14) porque el invariante
 * único fallaba sobre datos correctos en cuanto había un ticket no cualificado
 * —que tras D9 es el caso por defecto—, y un invariante que falla siempre acaba
 * desactivado. El de repercutido lleva además el término de **IVA devengado por
 * ISP/AIB del libro de RECIBIDAS** (OBS-F1 del fixture de T8): el 477 de una
 * autorrepercusión no procede de ninguna factura emitida.
 */

import type { CheckResult } from "@/lib/ledger/invariants-types"
import type { Cents, LocalDate, PostedEntry } from "@/lib/ledger/types"

// ─────────────────────────────────────────────────────────────────────────────
// Entradas
// ─────────────────────────────────────────────────────────────────────────────

export type ExtractionKind = "LLM" | "MANUAL" | "IMPORTED"
export type ReconcileStatus = "PASS" | "WARN" | "FAIL"

export type ExtractionRunRef = {
  id: string
  fileId: string
  fileSha256: string
  kind: ExtractionKind
  partial: boolean
  reconcileStatus: ReconcileStatus | null
  promptSha: string
  /** sha del contenido EFECTIVO del prompt, cuando el llamante puede calcularlo. */
  promptShaExpected?: string | null
  /** Confianzas selladas en `field_origins`, para I-E8-10. */
  fieldConfidences?: readonly string[]
  /** I-E8-7b: desviaciones de cuota por tipo, tal como las selló `reconcile`. */
  quotaDeviationsCents?: Readonly<Record<string, Cents>>
  provider?: string
  /**
   * Avisos de calidad que el run dejó sellados y que E7 pinta: deducibilidad
   * pendiente de decisión (RC-15), ticket marcado como cualificado, contraparte
   * sin régimen configurado. Los escribe la capa de aplicación (T13) al
   * confirmar, porque son estados del documento y no del asiento.
   */
  warnings?: readonly DataQualityWarning["code"][]
}

export type TransactionDocRef = {
  id: string
  status: "DRAFT" | "PROPOSED" | "POSTED" | "VOID"
  journalEntryId: string | null
  voidedEntryId: string | null
  fileId: string | null
  splitParentTransactionId: string | null
  currency: string
  totalCents: Cents
  convertedTotalCents: Cents | null
  exchangeRateMicro: bigint | null
  rateDate: LocalDate | null
  rateSource: string | null
  extractionRunId: string | null
}

export type FileDocRef = {
  id: string
  sha256: string | null
  /** sha256 de los BYTES en disco, cuando el script los ha leído (I-E8-2). */
  diskSha256?: string | null
}

/**
 * Una anotación del **libro registro** (arts. 63 y 64 RIVA), derivada del
 * DOCUMENTO —de la propuesta sellada en el `ExtractionRun`—, no del asiento.
 * Que las dos derivaciones sean independientes es lo que convierte I-E8-15 en
 * un puente y no en una tautología.
 */
export type VatBookRow = {
  entryId: string | null
  ivaPeriod: string
  tipo: "RECIBIDAS" | "EMITIDAS"
  baseCents: Cents
  cuotaTotalCents: Cents
  cuotaDeducibleCents: Cents
  cuotaNoDeducibleAlCosteCents: Cents
  cuotaRepercutidaCents: Cents
  cuotaDevengadaIspAibCents: Cents
  documentDate: LocalDate
  /** `max(receptionDate, documentDate)`: la fecha en la que se deduce (D8). */
  deductionDate: LocalDate
}

/** Saldos del DIARIO por periodo de IVA: la otra orilla del puente. */
export type VatBalanceRow = { ivaPeriod: string; saldo472Cents: Cents; saldo477Cents: Cents }

export type WithholdingRow = {
  period: string
  model: "111" | "115"
  /** Retenciones practicadas según los documentos del periodo. */
  practicadoCents: Cents
  /** Abonos a 4751 del diario, por `taxRateId` agrupado por modelo. */
  abonado4751Cents: Cents
}

export type ExchangeRateRef = { id: string; date: LocalDate; from: string; to: string; rateMicro: bigint; source: string }

export type InvoiceSeriesRef = {
  code: string
  kind: "ORDINARIA" | "RECTIFICATIVA" | "SIMPLIFICADA"
  numbers: readonly { number: number; date: LocalDate }[]
}

/** Grupo de documentos que la detección de duplicados marcó (RC-12). */
export type DuplicateGroupRef = {
  /** `sha256:<hash>` o `documento:<taxId>|<numero>|<ejercicio>`. */
  key: string
  transactionIds: readonly string[]
  /** ¿Hay `AuditLog` con `FORCE_DUPLICATE` y motivo? */
  forced: boolean
}

export type DocumentsInvariantInput = {
  runs: readonly ExtractionRunRef[]
  transactions: readonly TransactionDocRef[]
  files: readonly FileDocRef[]
  vatBook: readonly VatBookRow[]
  vatBalances: readonly VatBalanceRow[]
  withholdings: readonly WithholdingRow[]
  exchangeRates: readonly ExchangeRateRef[]
  invoiceSeries: readonly InvoiceSeriesRef[]
  duplicates: readonly DuplicateGroupRef[]
  /** Códigos de las cuentas que el puente necesita nombrar. */
  accounts: { inputVat: string; outputVat: string; withholding: string }
}

// ─────────────────────────────────────────────────────────────────────────────
// El libro registro, derivado del DOCUMENTO
// ─────────────────────────────────────────────────────────────────────────────

/** La forma mínima de la propuesta sellada que el libro registro necesita. */
export type BookableProposal = {
  docKind: string
  lines: readonly { kind: string; baseCents: Cents; discountCents?: number; taxRateCode: string | null; deductibility?: string | null }[]
  taxes: readonly { taxRateCode: string; baseCents: Cents; quotaCents: Cents; operationKey?: string }[]
  withholding?: { rateCode: string; quotaCents: Cents } | null
}

export type BookRowOptions = {
  entryId: string | null
  ivaPeriod: string
  documentDate: LocalDate
  deductionDate: LocalDate
  prorrataBps: number | null
  /** RC-25: el devengo se difirió al cobro, así que el periodo no anota cuota. */
  deferredByRc25?: boolean
}

const PURCHASE_DOC_KINDS: ReadonlySet<string> = new Set([
  "FACTURA_RECIBIDA",
  "FACTURA_RECIBIDA_ISP",
  "FACTURA_RECIBIDA_EXTRACOM",
  "DUA_IMPORTACION",
  "ABONO_RECIBIDO",
  "TICKET",
  "FACTURA_ANTICIPO_PROVEEDOR",
  "NOTA_GASTO_EMPLEADO",
])

/**
 * Anotación del libro registro **derivada de la propuesta sellada**, que es el
 * documento. Es a propósito un camino DISTINTO del que produjo el asiento: si
 * las dos derivaciones fueran la misma función, I-E8-15 no comprobaría nada.
 */
export function vatBookRowFromProposal(proposal: BookableProposal, opts: BookRowOptions): VatBookRow {
  const purchase = PURCHASE_DOC_KINDS.has(proposal.docKind)
  const credit = proposal.docKind === "ABONO_RECIBIDO" || proposal.docKind === "ABONO_EMITIDO"
  const signo = credit ? -1 : 1
  const deferred = opts.deferredByRc25 === true

  const operationLines = proposal.lines.filter((l) => l.kind === "OPERACION")
  const baseCents = signo * sum(operationLines.map((l) => l.baseCents - (l.discountCents ?? 0)))

  let deducible = 0
  let noDeducible = 0
  let repercutida = 0
  let ispAib = 0

  for (const tax of proposal.taxes) {
    const quota = signo * tax.quotaCents
    if (quota === 0) continue
    if (deferred) continue
    const selfCharged = tax.operationKey === "ISP" || tax.operationKey === "AIB"
    if (!purchase) {
      repercutida += quota
      continue
    }
    // Reparto deducible / no deducible por la deducibilidad de las líneas de
    // ese tipo: la cuota no deducible NO pasa por 472, engorda el coste
    // (art. 103 LIVA, NRV 2ª y 10ª).
    const rateLines = operationLines.filter((l) => l.taxRateCode === tax.taxRateCode)
    const rateBase = sum(rateLines.map((l) => l.baseCents - (l.discountCents ?? 0)))
    let assigned = 0
    rateLines.forEach((l, index) => {
      const share = index === rateLines.length - 1 ? quota - assigned : rateBase === 0 ? 0 : Math.trunc((quota * (l.baseCents - (l.discountCents ?? 0))) / rateBase)
      assigned += share
      const deductibility = l.deductibility ?? "FULL"
      if (deductibility === "NONE") noDeducible += share
      else if (deductibility === "PRORRATA" && opts.prorrataBps !== null) {
        const d = Math.trunc((share * opts.prorrataBps) / 10000)
        deducible += d
        noDeducible += share - d
      } else deducible += share
    })
    if (rateLines.length === 0) deducible += quota
    if (selfCharged) ispAib += quota
  }

  return {
    entryId: opts.entryId,
    ivaPeriod: opts.ivaPeriod,
    tipo: purchase ? "RECIBIDAS" : "EMITIDAS",
    baseCents: deferred ? 0 : baseCents,
    cuotaTotalCents: purchase ? deducible + noDeducible : repercutida,
    cuotaDeducibleCents: purchase ? deducible : 0,
    cuotaNoDeducibleAlCosteCents: purchase ? noDeducible : 0,
    cuotaRepercutidaCents: purchase ? 0 : repercutida,
    cuotaDevengadaIspAibCents: ispAib,
    documentDate: opts.documentDate,
    deductionDate: opts.deductionDate,
  }
}

/** Trimestre natural de una fecha ISO: "2026-Q2" (ADR-0014 D8). */
export const quarterOf = (date: LocalDate): string =>
  `${date.slice(0, 4)}-Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`

/** El periodo de IVA de un asiento: `max(receptionDate, documentDate)`. */
export const ivaPeriodOf = (receptionDate: LocalDate | null, documentDate: LocalDate): string =>
  quarterOf(receptionDate !== null && receptionDate > documentDate ? receptionDate : documentDate)

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades
// ─────────────────────────────────────────────────────────────────────────────

const pass = (id: string, evidencia: string, query?: string): CheckResult =>
  query === undefined ? { id, status: "PASS", evidencia } : { id, status: "PASS", evidencia, query }

const failed = (id: string, evidencia: string, query?: string): CheckResult =>
  query === undefined ? { id, status: "FAIL", evidencia } : { id, status: "FAIL", evidencia, query }

const warn = (id: string, evidencia: string, query?: string): CheckResult =>
  query === undefined ? { id, status: "WARN", evidencia } : { id, status: "WARN", evidencia, query }

const info = (id: string, evidencia: string, query?: string): CheckResult =>
  query === undefined ? { id, status: "INFO", evidencia } : { id, status: "INFO", evidencia, query }

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0)

const verdict = (id: string, failures: readonly string[], okEvidence: string, query?: string): CheckResult =>
  failures.length === 0 ? pass(id, okEvidence, query) : failed(id, failures.slice(0, 20).join(" · "), query)

/** Años completos entre dos fechas ISO, sin `Date` ni husos horarios. */
export function fullYearsBetween(from: LocalDate, to: LocalDate): number {
  const [fy, fm, fd] = from.split("-").map(Number)
  const [ty, tm, td] = to.split("-").map(Number)
  return ty - fy - (tm < fm || (tm === fm && td < fd) ? 1 : 0)
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E8-1 … I-E8-14
// ─────────────────────────────────────────────────────────────────────────────

const I_E8_1_QUERY = `
  SELECT e.id FROM journal_entries e
    LEFT JOIN extraction_runs r ON r.organization_id = e.organization_id AND r.id = e.extraction_run_id
   WHERE e.extraction_run_id IS NOT NULL
     AND (r.id IS NULL OR r.reconcile_status IS NULL OR r.reconcile_status = 'FAIL'
          OR r.kind = 'IMPORTED' OR (r.partial AND r.kind = 'LLM'))`

/** I-E8-1 — ningún asiento se apoya en un run que no lo sostiene. */
export function checkIE81(entries: readonly PostedEntry[], runs: readonly ExtractionRunRef[]): CheckResult {
  const byId = new Map(runs.map((r) => [r.id, r]))
  const failures: string[] = []
  let checked = 0
  for (const e of entries) {
    const runId = runIdOf(e)
    if (!runId) continue
    checked++
    const run = byId.get(runId)
    if (!run) {
      failures.push(`asiento ${e.entryNumber}: referencia un run que no existe`)
      continue
    }
    if (run.reconcileStatus === null || run.reconcileStatus === "FAIL") {
      failures.push(`asiento ${e.entryNumber}: su run está en ${run.reconcileStatus ?? "sin reconciliar"}`)
    }
    if (run.kind === "IMPORTED") {
      failures.push(`asiento ${e.entryNumber}: su run es importado sin origen (una memoria no es fuente de cifras)`)
    }
    if (run.partial && run.kind === "LLM") {
      failures.push(`asiento ${e.entryNumber}: su run es una extracción parcial de un modelo (O-20.3)`)
    }
  }
  return verdict("I-E8-1", failures, `${checked} asiento(s) con extracción, todos sobre un run PASS o WARN`, I_E8_1_QUERY)
}

const runIdOf = (e: PostedEntry): string | null => e.extractionRunId ?? null

/** I-E8-2 — los bytes del fichero son los que vio la extracción, y los de hoy. */
export function checkIE82(input: DocumentsInvariantInput, entries: readonly PostedEntry[]): CheckResult {
  const fileById = new Map(input.files.map((f) => [f.id, f]))
  const runsWithEntry = new Set(entries.map(runIdOf).filter((id): id is string => id !== null))
  const failures: string[] = []
  let checked = 0
  let withoutDisk = 0
  for (const run of input.runs) {
    if (!runsWithEntry.has(run.id)) continue
    checked++
    const file = fileById.get(run.fileId)
    if (!file) {
      failures.push(`run ${run.id}: su fichero no existe`)
      continue
    }
    if (file.sha256 === null) {
      failures.push(`run ${run.id}: el fichero no tiene sha256 y respalda un asiento (I-E8-9)`)
      continue
    }
    if (file.sha256 !== run.fileSha256) {
      failures.push(`run ${run.id}: el sha del run no es el del fichero (documento alterado)`)
    }
    if (file.diskSha256 === undefined || file.diskSha256 === null) withoutDisk++
    else if (file.diskSha256 !== file.sha256) failures.push(`fichero ${file.id}: los bytes en disco no son los registrados`)
  }
  if (failures.length > 0) return failed("I-E8-2", failures.slice(0, 20).join(" · "))
  const evidencia =
    withoutDisk === 0
      ? `${checked} run(s) con asiento: sha en disco = sha del fichero = sha del run`
      : `${checked} run(s) con asiento cuadran con el fichero; ${withoutDisk} sin comprobar en disco ` +
        "(ejecuta scripts/run-invariants.ts, que sí lee los bytes)"
  return withoutDisk === 0 ? pass("I-E8-2", evidencia) : warn("I-E8-2", evidencia)
}

/** I-E8-3 — `extraction_runs` y `prompt_versions` son inmutables. */
export function checkIE83(): CheckResult {
  return info(
    "I-E8-3",
    "Inmutabilidad de extraction_runs y prompt_versions: la impone RLS (RESTRICTIVE USING (false) en UPDATE/DELETE) y la " +
      "verifica `test:integration:rls` con un 42501; desde el motor puro no es observable",
    "UPDATE extraction_runs SET raw_output = '{}'::jsonb WHERE id = $1  -- debe dar 42501"
  )
}

const I_E8_4_QUERY = `
  SELECT id, status, journal_entry_id, voided_entry_id FROM transactions
   WHERE NOT ((status = 'DRAFT'    AND journal_entry_id IS NULL AND voided_entry_id IS NULL)
           OR (status = 'PROPOSED' AND journal_entry_id IS NULL)
           OR (status = 'POSTED'   AND journal_entry_id IS NOT NULL)
           OR (status = 'VOID'     AND journal_entry_id IS NULL AND voided_entry_id IS NOT NULL))`

/** I-E8-4 — la semántica de `Transaction.status`, y un solo asiento vivo. */
export function checkIE84(input: DocumentsInvariantInput): CheckResult {
  const failures: string[] = []
  const liveEntries = new Map<string, string>()
  for (const t of input.transactions) {
    const has = t.journalEntryId !== null
    if (t.status === "DRAFT" && (has || t.voidedEntryId !== null)) failures.push(`transacción ${t.id}: DRAFT con asiento`)
    if (t.status === "PROPOSED" && has) failures.push(`transacción ${t.id}: PROPOSED con asiento (no es un estado contable)`)
    if (t.status === "POSTED" && !has) failures.push(`transacción ${t.id}: POSTED sin asiento`)
    if (t.status === "VOID" && (has || t.voidedEntryId === null)) {
      failures.push(`transacción ${t.id}: VOID sin el asiento anulado en voided_entry_id`)
    }
    if (t.journalEntryId !== null) {
      const previous = liveEntries.get(t.journalEntryId)
      if (previous) failures.push(`asiento ${t.journalEntryId}: vivo en dos transacciones (${previous} y ${t.id})`)
      liveEntries.set(t.journalEntryId, t.id)
    }
  }
  // Un split: N transacciones sobre el MISMO fichero y asientos DISTINTOS.
  const splits = new Map<string, TransactionDocRef[]>()
  for (const t of input.transactions) {
    if (!t.splitParentTransactionId) continue
    const list = splits.get(t.splitParentTransactionId) ?? []
    list.push(t)
    splits.set(t.splitParentTransactionId, list)
  }
  for (const [parentId, children] of splits) {
    const parent = input.transactions.find((t) => t.id === parentId)
    const fileIds = new Set([...children.map((c) => c.fileId), ...(parent ? [parent.fileId] : [])])
    if (fileIds.size > 1) failures.push(`split ${parentId}: sus transacciones no apuntan al mismo fichero`)
    const entryIds = children.map((c) => c.journalEntryId).filter((id): id is string => id !== null)
    if (new Set(entryIds).size !== entryIds.length) failures.push(`split ${parentId}: dos transacciones con el mismo asiento`)
  }
  return verdict(
    "I-E8-4",
    failures,
    `${input.transactions.length} transacción(es) con estado coherente y un solo asiento vivo`,
    I_E8_4_QUERY
  )
}

/** Conversión HALF-EVEN en enteros: la misma de `lib/money.convertWithRateMicro`. */
export function convertWithRateMicro(cents: Cents, rateMicro: bigint): Cents {
  const scale = BigInt(1_000_000)
  const two = BigInt(2)
  const product = BigInt(Math.abs(cents)) * rateMicro
  const quotient = product / scale
  const remainder = product - quotient * scale
  const twice = remainder * two
  const rounded = twice > scale || (twice === scale && quotient % two === BigInt(1)) ? quotient + BigInt(1) : quotient
  return (cents < 0 ? -1 : 1) * Number(rounded)
}

/** I-E8-5 — `convertedTotal` sale de la tasa persistida, no de otro sitio. */
export function checkIE85(input: DocumentsInvariantInput): CheckResult {
  const rateIds = new Set(input.exchangeRates.map((r) => `${r.date}|${r.from}|${r.to}|${r.source}`))
  const failures: string[] = []
  let checked = 0
  for (const t of input.transactions) {
    if (t.exchangeRateMicro === null) continue
    checked++
    const expected = convertWithRateMicro(t.totalCents, t.exchangeRateMicro)
    if (t.convertedTotalCents !== null && t.convertedTotalCents !== expected) {
      failures.push(`transacción ${t.id}: convertedTotal ${t.convertedTotalCents} ≠ ${expected} con la tasa sellada`)
    }
    if (t.rateDate && t.rateSource && !rateIds.has(`${t.rateDate}|${t.currency}|EUR|${t.rateSource}`)) {
      // No es FAIL por sí solo: la moneda base puede no ser el euro y la tasa
      // pudo purgarse. Se dice, que es distinto de callarlo.
      failures.push(`transacción ${t.id}: la tasa ${t.rateDate}/${t.rateSource} no está en exchange_rates`)
    }
  }
  return verdict("I-E8-5", failures, `${checked} transacción(es) en divisa con su conversión reproducida al céntimo`)
}

/** I-E8-6 — determinismo de `reconcile`. Se prueba en el motor puro. */
export function checkIE86(): CheckResult {
  return info(
    "I-E8-6",
    "Determinismo de reconcile(): `canonicalJson(reconcile(p, ctx))` idéntico entre ejecuciones y procesos. Se comprueba en " +
      "lib/extraction/reconcile.test.ts sobre los quince casos del fixture; no es observable desde la base"
  )
}

/**
 * I-E8-7a — identidad de lo **contabilizado**, con tolerancia 0. Se cumple por
 * construcción con la cuota del documento (D3), y por eso mismo verificarlo es
 * barato: si alguna vez deja de cumplirse, alguien ha reintroducido un ajuste.
 */
export function checkIE87a(input: DocumentsInvariantInput, entries: readonly PostedEntry[]): CheckResult {
  const byId = new Map(entries.map((e) => [e.id, e]))
  const failures: string[] = []
  let checked = 0
  for (const row of input.vatBook) {
    if (row.entryId === null) continue
    const entry = byId.get(row.entryId)
    if (!entry) continue
    checked++
    const debit = sum(entry.lines.map((l) => l.debitCents))
    const credit = sum(entry.lines.map((l) => l.creditCents))
    if (debit !== credit) failures.push(`asiento ${entry.entryNumber}: debe ${debit} ≠ haber ${credit}`)
    const cuota = row.cuotaDeducibleCents + row.cuotaNoDeducibleAlCosteCents + row.cuotaRepercutidaCents
    if (row.cuotaTotalCents !== 0 && cuota !== row.cuotaTotalCents && row.cuotaDevengadaIspAibCents === 0) {
      failures.push(
        `asiento ${entry.entryNumber}: la cuota anotada (${row.cuotaTotalCents}) no es la contabilizada (${cuota})`
      )
    }
  }
  return verdict("I-E8-7a", failures, `${checked} documento(s) contabilizados con identidad exacta y Σdebe = Σhaber`)
}

/**
 * I-E8-7b — **métrica de calidad, no invariante** (O-19). Cuenta y mide las
 * discrepancias entre la cuota del documento y el recálculo, por tipo y por
 * proveedor. Nunca es FAIL: la cuota que se contabiliza es la del documento, y
 * una desviación de un céntimo es información sobre el emisor, no un descuadre.
 */
export function checkIE87b(input: DocumentsInvariantInput): CheckResult {
  const byProvider = new Map<string, { docs: number; maxAbs: number; total: number }>()
  let docs = 0
  for (const run of input.runs) {
    const deviations = Object.values(run.quotaDeviationsCents ?? {})
    if (deviations.length === 0) continue
    docs++
    const provider = run.provider ?? "desconocido"
    const acc = byProvider.get(provider) ?? { docs: 0, maxAbs: 0, total: 0 }
    acc.docs++
    acc.maxAbs = Math.max(acc.maxAbs, ...deviations.map((d) => Math.abs(d)))
    acc.total += sum(deviations.map((d) => Math.abs(d)))
    byProvider.set(provider, acc)
  }
  if (docs === 0) return pass("I-E8-7b", "ningún documento con desviación entre la cuota declarada y la recalculada")
  const detail = [...byProvider.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([provider, a]) => `${provider}: ${a.docs} documento(s), ${a.total} c en total, máximo ${a.maxAbs} c`)
  return warn("I-E8-7b", `métrica de calidad · ${docs} documento(s) con desviación de cuota — ${detail.join(" · ")}`)
}

/** I-E8-8 — la previsualización reproduce el asiento. Puro + integración. */
export function checkIE88(): CheckResult {
  return info(
    "I-E8-8",
    "postFromProposal(run.reconcile, ctx) reproduce el EntryDraft del asiento línea a línea y céntimo a céntimo. Se comprueba " +
      "en lib/ledger/postFromProposal.test.ts contra los quince casos y en tests/integration/e8-extraction.test.ts"
  )
}

const I_E8_9_QUERY = `
  SELECT f.id FROM files f
    LEFT JOIN extraction_runs r ON r.file_id = f.id AND r.kind = 'LLM'
    LEFT JOIN journal_entries e ON e.file_id = f.id
   WHERE f.sha256 IS NULL AND (r.id IS NOT NULL OR e.id IS NOT NULL)`

/** I-E8-9 — sin `sha256` no se analiza ni se contabiliza. */
export function checkIE89(input: DocumentsInvariantInput, entries: readonly PostedEntry[]): CheckResult {
  const withoutSha = new Set(input.files.filter((f) => f.sha256 === null).map((f) => f.id))
  const failures: string[] = []
  for (const run of input.runs) {
    if (run.kind === "LLM" && withoutSha.has(run.fileId)) failures.push(`fichero ${run.fileId}: sin sha256 y con run LLM`)
  }
  for (const e of entries) {
    const fileId = e.fileId ?? null
    if (fileId && withoutSha.has(fileId)) failures.push(`asiento ${e.entryNumber}: su fichero no tiene sha256`)
  }
  return verdict("I-E8-9", failures, `${input.files.length} fichero(s): ninguno sin sha256 con run LLM ni con asiento`, I_E8_9_QUERY)
}

/** I-E8-10 — un run parcial no tiene ni un campo `calculado` ni `verificado`. */
export function checkIE810(input: DocumentsInvariantInput, entries: readonly PostedEntry[]): CheckResult {
  const runsWithEntry = new Set(entries.map(runIdOf).filter((id): id is string => id !== null))
  const failures: string[] = []
  let checked = 0
  for (const run of input.runs) {
    if (!run.partial) continue
    checked++
    const confidences = run.fieldConfidences ?? []
    const strong = confidences.filter((c) => c === "calculado" || c === "verificado")
    if (strong.length > 0) {
      failures.push(`run ${run.id}: parcial con ${strong.length} campo(s) calculado/verificado`)
    }
    if (run.kind === "LLM" && runsWithEntry.has(run.id)) failures.push(`run ${run.id}: parcial de un modelo y con asiento`)
  }
  return verdict("I-E8-10", failures, `${checked} extracción(es) parcial(es), ninguna con campos fuertes ni con asiento`)
}

/** I-E8-11 — el `promptSha` del run es el del contenido efectivo. */
export function checkIE811(input: DocumentsInvariantInput): CheckResult {
  const comparable = input.runs.filter((r) => r.promptShaExpected !== undefined && r.promptShaExpected !== null)
  if (comparable.length === 0) {
    return info("I-E8-11", "No se aporta el contenido efectivo de los prompts: la comparación la hace tests/integration/e8-extraction")
  }
  const failures = comparable
    .filter((r) => r.promptSha !== r.promptShaExpected)
    .map((r) => `run ${r.id}: prompt_sha ${r.promptSha.slice(0, 8)} ≠ ${String(r.promptShaExpected).slice(0, 8)}`)
  return verdict("I-E8-11", failures, `${comparable.length} run(s) con el sha del prompt efectivo`)
}

/** I-E8-12 — aislamiento por tenant de runs, prompts, series y contrapartes. */
export function checkIE812(): CheckResult {
  return info(
    "I-E8-12",
    "Aislamiento multi-tenant de extraction_runs, prompt_versions, invoice_series y counterparties: lo garantiza RLS con " +
      "FORCE y lo verifica `test:integration:rls`. Con el filtro de tenant puesto, un cruce es invisible por construcción"
  )
}

const I_E8_13_QUERY = `
  SELECT sha256, count(*) FROM files GROUP BY sha256 HAVING count(*) > 1`

/** I-E8-13 — un duplicado contabilizado exige `FORCE_DUPLICATE` con motivo. */
export function checkIE813(input: DocumentsInvariantInput): CheckResult {
  const failures = input.duplicates
    .filter((d) => d.transactionIds.length > 1 && !d.forced)
    .map((d) => `${d.key}: ${d.transactionIds.length} documentos sin AuditLog FORCE_DUPLICATE`)
  return verdict(
    "I-E8-13",
    failures,
    `${input.duplicates.length} grupo(s) de duplicados, todos con motivo registrado`,
    I_E8_13_QUERY
  )
}

/** I-E8-14 — `exchange_rates` append-only, única por clave y con tasa positiva. */
export function checkIE814(input: DocumentsInvariantInput): CheckResult {
  const failures: string[] = []
  const seen = new Set<string>()
  for (const r of input.exchangeRates) {
    const key = `${r.date}|${r.from}|${r.to}|${r.source}`
    if (seen.has(key)) failures.push(`tasa duplicada para ${key}`)
    seen.add(key)
    if (r.rateMicro <= BigInt(0)) failures.push(`tasa ${key}: rate_micro no positivo`)
    if (r.from === r.to) failures.push(`tasa ${key}: origen y destino iguales`)
  }
  for (const t of input.transactions) {
    if (t.exchangeRateMicro === null && t.rateDate === null && t.rateSource === null) continue
    if (t.exchangeRateMicro === null || t.rateDate === null || t.rateSource === null) {
      failures.push(`transacción ${t.id}: las tres columnas de tasa van juntas o no van`)
    }
  }
  return verdict("I-E8-14", failures, `${input.exchangeRates.length} tasa(s) únicas y positivas`)
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E8-15a / 15b / 15c — los tres puentes al 303 (ADR-0014 D14, OBS-F1)
// ─────────────────────────────────────────────────────────────────────────────

const I_E8_15_QUERY = `
  -- Periodo de IVA = trimestre de max(reception_date, document_date), NO del entry_date
  SELECT to_char(greatest(e.reception_date, e.document_date), 'YYYY-"Q"Q') AS periodo,
         sum(l.debit_cents - l.credit_cents) FILTER (WHERE l.account_code = $2) AS saldo_472,
         sum(l.credit_cents - l.debit_cents) FILTER (WHERE l.account_code = $3) AS saldo_477
    FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
   WHERE l.organization_id = $1 GROUP BY 1 ORDER BY 1`

type Bridge = { period: string; libro: number; diario: number; diff: number }

const bridgeVerdict = (id: string, bridges: readonly Bridge[], what: string): CheckResult => {
  const broken = bridges.filter((b) => b.diff !== 0)
  if (broken.length > 0) {
    return failed(
      id,
      broken.map((b) => `${b.period}: libro ${b.libro} vs diario ${b.diario} (diferencia ${b.diff})`).join(" · "),
      I_E8_15_QUERY
    )
  }
  return pass(id, `${bridges.length} periodo(s) con ${what} cuadrado a 0`, I_E8_15_QUERY)
}

const periodsOf = (input: DocumentsInvariantInput): string[] =>
  [...new Set([...input.vatBook.map((r) => r.ivaPeriod), ...input.vatBalances.map((r) => r.ivaPeriod)])].sort()

const bookOf = (input: DocumentsInvariantInput, period: string): VatBookRow[] =>
  input.vatBook.filter((r) => r.ivaPeriod === period)

const balanceOf = (input: DocumentsInvariantInput, period: string): VatBalanceRow =>
  input.vatBalances.find((r) => r.ivaPeriod === period) ?? { ivaPeriod: period, saldo472Cents: 0, saldo477Cents: 0 }

/** I-E8-15a — `Σ 472` del periodo = Σ cuota **deducible** del libro de recibidas. */
export function checkIE815a(input: DocumentsInvariantInput): CheckResult {
  const bridges = periodsOf(input).map((period) => {
    const libro = sum(bookOf(input, period).filter((r) => r.tipo === "RECIBIDAS").map((r) => r.cuotaDeducibleCents))
    const diario = balanceOf(input, period).saldo472Cents
    return { period, libro, diario, diff: diario - libro }
  })
  return bridgeVerdict("I-E8-15a", bridges, "el IVA soportado deducible")
}

/**
 * I-E8-15b — Σ cuota **total** del libro = `Σ 472` + Σ IVA no deducible
 * incorporado al coste. Es el único control que detecta que una cuota no
 * deducible se «perdió» en lugar de engordar el gasto o el inmovilizado
 * (art. 103 LIVA, NRV 2ª y 10ª).
 */
export function checkIE815b(input: DocumentsInvariantInput): CheckResult {
  const bridges = periodsOf(input).map((period) => {
    const rows = bookOf(input, period).filter((r) => r.tipo === "RECIBIDAS")
    const libro = sum(rows.map((r) => r.cuotaTotalCents))
    const diario = balanceOf(input, period).saldo472Cents + sum(rows.map((r) => r.cuotaNoDeducibleAlCosteCents))
    return { period, libro, diario, diff: diario - libro }
  })
  return bridgeVerdict("I-E8-15b", bridges, "el IVA soportado total (deducible + incorporado al coste)")
}

/**
 * I-E8-15c — `Σ 477` = Σ cuota repercutida del libro de emitidas **+ Σ cuota
 * devengada por ISP/AIB del libro de recibidas** (OBS-F1 de T8). El 477 de una
 * autorrepercusión no procede de ninguna factura emitida, sino de las casillas
 * 10-13 del 303: sin ese término, el invariante daría FAIL sobre el asiento
 * correcto de una adquisición intracomunitaria.
 */
export function checkIE815c(input: DocumentsInvariantInput): CheckResult {
  const bridges = periodsOf(input).map((period) => {
    const rows = bookOf(input, period)
    const libro =
      sum(rows.filter((r) => r.tipo === "EMITIDAS").map((r) => r.cuotaRepercutidaCents)) +
      sum(rows.filter((r) => r.tipo === "RECIBIDAS").map((r) => r.cuotaDevengadaIspAibCents))
    const diario = balanceOf(input, period).saldo477Cents
    return { period, libro, diario, diff: diario - libro }
  })
  return bridgeVerdict("I-E8-15c", bridges, "el IVA repercutido y el devengado por inversión del sujeto pasivo")
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E8-16 … I-E8-20
// ─────────────────────────────────────────────────────────────────────────────

/** I-E8-16 — nada se deduce pasados cuatro años (art. 99.Cinco LIVA). */
export function checkIE816(input: DocumentsInvariantInput): CheckResult {
  const failures = input.vatBook
    .filter((r) => r.cuotaDeducibleCents !== 0 && fullYearsBetween(r.documentDate, r.deductionDate) >= 4)
    .map((r) => `documento de ${r.documentDate} deducido el ${r.deductionDate}: fuera de los cuatro años`)
  return verdict("I-E8-16", failures, `${input.vatBook.length} anotación(es), ninguna deducida fuera de plazo`)
}

/** I-E8-17 — puente al 111 y al 115: lo practicado = lo abonado a 4751. */
export function checkIE817(input: DocumentsInvariantInput): CheckResult {
  const failures = input.withholdings
    .filter((w) => w.practicadoCents !== w.abonado4751Cents)
    .map((w) => `${w.period} modelo ${w.model}: practicado ${w.practicadoCents} vs abonado a 4751 ${w.abonado4751Cents}`)
  return verdict(
    "I-E8-17",
    failures,
    `${input.withholdings.length} periodo(s)/modelo(s) con la retención practicada = la abonada a 4751`,
    "SELECT tax_rate_id, sum(credit_cents) FROM journal_lines WHERE account_code = $2 GROUP BY 1"
  )
}

/**
 * I-E8-18 — una factura con inversión del sujeto pasivo lleva **exactamente
 * dos** líneas de IVA del mismo tipo, y el devengado es **íntegro**: la prorrata
 * sólo minora el deducible.
 */
export function checkIE818(input: DocumentsInvariantInput, entries: readonly PostedEntry[]): CheckResult {
  const ispEntries = new Set(input.vatBook.filter((r) => r.cuotaDevengadaIspAibCents !== 0 && r.entryId).map((r) => r.entryId))
  const failures: string[] = []
  let checked = 0
  for (const e of entries) {
    if (!ispEntries.has(e.id)) continue
    checked++
    const vatLines = e.lines.filter(
      (l) => l.accountCode === input.accounts.inputVat || l.accountCode === input.accounts.outputVat
    )
    if (vatLines.length !== 2) {
      failures.push(`asiento ${e.entryNumber}: ${vatLines.length} línea(s) de IVA, y una autorrepercusión tiene exactamente dos`)
      continue
    }
    const rateIds = new Set(vatLines.map((l) => l.taxRateId ?? "sin tipo"))
    if (rateIds.size !== 1) failures.push(`asiento ${e.entryNumber}: las dos líneas de IVA no comparten taxRateId`)
    const row = input.vatBook.find((r) => r.entryId === e.id)
    const outputLine = vatLines.find((l) => l.accountCode === input.accounts.outputVat)
    if (row && outputLine && outputLine.creditCents !== row.cuotaDevengadaIspAibCents) {
      failures.push(
        `asiento ${e.entryNumber}: el devengado (${outputLine.creditCents}) no es íntegro (${row.cuotaDevengadaIspAibCents})`
      )
    }
  }
  return verdict("I-E8-18", failures, `${checked} asiento(s) con inversión del sujeto pasivo, todos con dos líneas del mismo tipo`)
}

/** I-E8-19 — divisa: las tres columnas en la transacción y en sus líneas. */
export function checkIE819(input: DocumentsInvariantInput, entries: readonly PostedEntry[], baseCurrency: string): CheckResult {
  const failures: string[] = []
  const byEntryId = new Map(entries.map((e) => [e.id, e]))
  let checked = 0
  for (const t of input.transactions) {
    if (t.currency === baseCurrency) continue
    checked++
    if (t.exchangeRateMicro === null || t.rateDate === null || t.rateSource === null) {
      failures.push(`transacción ${t.id}: en ${t.currency} sin las tres columnas de tasa`)
    }
    if (t.journalEntryId === null) continue
    const entry = byEntryId.get(t.journalEntryId)
    if (!entry) continue
    const monetary = entry.lines.filter((l) => l.originalCurrency !== null && l.originalCurrency !== undefined)
    if (monetary.length === 0) {
      failures.push(`asiento de la transacción ${t.id}: ninguna línea monetaria lleva la divisa original (NRV 11ª.2.1)`)
    }
    for (const l of monetary) {
      if (l.originalAmountCents === null || l.originalAmountCents === undefined || !l.exchangeRateId) {
        failures.push(`asiento de la transacción ${t.id}, línea ${l.lineNo}: divisa incompleta`)
      }
    }
  }
  return verdict("I-E8-19", failures, `${checked} transacción(es) en moneda distinta de la base, todas con su tasa y su divisa`)
}

/** I-E8-20 — series de facturación sin huecos y con fecha no decreciente. */
export function checkIE820(input: DocumentsInvariantInput): CheckResult {
  const failures: string[] = []
  const empty = input.invoiceSeries.filter((s) => s.numbers.length === 0)
  if (empty.length > 0 && empty.length === input.invoiceSeries.length) {
    return info(
      "I-E8-20",
      `${empty.length} serie(s) declarada(s) sin números emitidos: no hay numeración que comprobar todavía (T18)`
    )
  }
  for (const serie of input.invoiceSeries) {
    const sorted = [...serie.numbers].sort((a, b) => a.number - b.number)
    if (sorted.length === 0) continue
    for (let i = 0; i < sorted.length; i++) {
      const expected = sorted[0].number + i
      if (sorted[i].number !== expected) {
        failures.push(`serie ${serie.code}: hueco en la numeración (falta el ${expected})`)
        break
      }
      if (i > 0 && sorted[i].date < sorted[i - 1].date) {
        failures.push(`serie ${serie.code}: el número ${sorted[i].number} tiene fecha anterior al ${sorted[i - 1].number}`)
      }
    }
  }
  return verdict("I-E8-20", failures, `${input.invoiceSeries.length} serie(s) sin huecos y con fecha no decreciente`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Ejecución del bloque y WARN de calidad de datos (para la Auditoría de E7)
// ─────────────────────────────────────────────────────────────────────────────

export type DataQualityWarning = {
  code:
    | "DOCUMENTO_SIN_ASIENTO"
    | "RUN_FAIL_SIN_RESOLVER"
    | "EXTRACCION_PARCIAL"
    | "FICHERO_SIN_SHA256"
    | "DUPLICADO_FORZADO"
    | "DEDUCIBILIDAD_PENDIENTE"
    | "DESVIACION_DE_CUOTA"
    | "TICKET_CUALIFICADO"
    | "RETENCION_NO_PRACTICADA"
    | "CONTRAPARTE_SIN_REGIMEN"
  count: number
  message: string
}

/**
 * Los WARN de calidad que E8 aporta y **E7 pinta** en la pestaña Auditoría. No
 * son invariantes: ninguno significa que una cifra esté mal. Significan que hay
 * trabajo pendiente que, si nadie lo mira, acaba en una declaración incompleta.
 */
export function dataQualityWarnings(input: DocumentsInvariantInput): DataQualityWarning[] {
  const out: DataQualityWarning[] = []
  const add = (code: DataQualityWarning["code"], count: number, message: string): void => {
    if (count > 0) out.push({ code, count, message })
  }

  const sinAsiento = input.transactions.filter((t) => t.status !== "POSTED" && t.fileId !== null).length
  add("DOCUMENTO_SIN_ASIENTO", sinAsiento, "documentos con fichero y sin asiento")
  add(
    "RUN_FAIL_SIN_RESOLVER",
    input.runs.filter((r) => r.reconcileStatus === "FAIL").length,
    "extracciones en FAIL sin resolver: su documento no se puede contabilizar"
  )
  add("EXTRACCION_PARCIAL", input.runs.filter((r) => r.partial).length, "extracciones parciales: hay que teclear las cifras")
  add("FICHERO_SIN_SHA256", input.files.filter((f) => f.sha256 === null).length, "ficheros sin sha256: no se analizan ni se contabilizan")
  add("DUPLICADO_FORZADO", input.duplicates.filter((d) => d.forced).length, "duplicados confirmados con motivo")
  add(
    "DESVIACION_DE_CUOTA",
    input.runs.filter((r) => Object.keys(r.quotaDeviationsCents ?? {}).length > 0).length,
    "documentos cuya cuota difiere del recálculo (I-E8-7b): revise al emisor"
  )
  add(
    "RETENCION_NO_PRACTICADA",
    input.withholdings.filter((w) => w.practicadoCents !== w.abonado4751Cents).length,
    "periodos con retención practicada distinta de la abonada a 4751"
  )

  // Los que el documento sabe y el asiento no: deducibilidad pendiente, ticket
  // cualificado por un acto humano, contraparte sin régimen configurado.
  const sealed = new Map<DataQualityWarning["code"], number>()
  for (const run of input.runs) {
    for (const code of run.warnings ?? []) sealed.set(code, (sealed.get(code) ?? 0) + 1)
  }
  const MESSAGES: Readonly<Record<string, string>> = {
    DEDUCIBILIDAD_PENDIENTE: "documentos con la deducibilidad pendiente de decisión (art. 96 LIVA)",
    TICKET_CUALIFICADO: "tickets marcados como factura simplificada cualificada por un EDITOR",
    CONTRAPARTE_SIN_REGIMEN: "contrapartes sin régimen de retención configurado",
  }
  for (const [code, count] of [...sealed.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (out.some((w) => w.code === code)) continue
    add(code, count, MESSAGES[code] ?? "aviso de calidad del documento")
  }
  return out
}

/** El bloque completo, en el orden en el que viaja a `validacion.json`. */
export function runDocumentInvariants(
  input: DocumentsInvariantInput,
  entries: readonly PostedEntry[],
  baseCurrency: string
): CheckResult[] {
  return [
    checkIE81(entries, input.runs),
    checkIE82(input, entries),
    checkIE83(),
    checkIE84(input),
    checkIE85(input),
    checkIE86(),
    checkIE87a(input, entries),
    checkIE87b(input),
    checkIE88(),
    checkIE89(input, entries),
    checkIE810(input, entries),
    checkIE811(input),
    checkIE812(),
    checkIE813(input),
    checkIE814(input),
    checkIE815a(input),
    checkIE815b(input),
    checkIE815c(input),
    checkIE816(input),
    checkIE817(input),
    checkIE818(input, entries),
    checkIE819(input, entries, baseCurrency),
    checkIE820(input),
  ]
}

/** Identificadores del bloque, para el modo «demasiados asientos» de E6. */
export const E8_INVARIANT_IDS: readonly string[] = [
  "I-E8-1", "I-E8-2", "I-E8-3", "I-E8-4", "I-E8-5", "I-E8-6", "I-E8-7a", "I-E8-7b", "I-E8-8",
  "I-E8-9", "I-E8-10", "I-E8-11", "I-E8-12", "I-E8-13", "I-E8-14", "I-E8-15a", "I-E8-15b",
  "I-E8-15c", "I-E8-16", "I-E8-17", "I-E8-18", "I-E8-19", "I-E8-20",
]
