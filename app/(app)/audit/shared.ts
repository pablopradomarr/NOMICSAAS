import "server-only"

import type { AuditLogRow } from "@/components/audit/blocks"
import type {
  CheckView,
  ClosingBlockView,
  DataQualityRow,
  FamilyCardView,
  OriginRecordView,
  RunHistoryRow,
  RunSummaryView,
} from "@/components/audit/types"
import { short } from "@/components/audit/types"
import type { CheckStatusValue } from "@/components/ui/check-status"
import { CHECK_FAMILIES, FAMILY_LABEL, countsOf, familyOf, familyStatus } from "@/lib/audit/families"
import { HEADLINE_METRICS, type CheckFamily, type HeadlineFigures } from "@/lib/audit/types"
import type { CheckResult } from "@/lib/ledger/invariants-types"
import { dataQualityWarnings, type DataQualityWarning, type DocumentsInvariantInput } from "@/lib/ledger/invariants-e8"
import { fromUtcDate } from "@/lib/ledger/dates"
import type { TenantClient, TenantTransactionClient } from "@/lib/db"
import type { InvariantRunRow } from "@/models/audit"

type AnyClient = TenantClient | TenantTransactionClient

/**
 * E7 · T12/T13 — Composición de la pestaña Auditoría, en SERVIDOR.
 *
 * Todo lo que las pantallas de `/audit` necesitan y que no es «pintar» vive
 * aquí: agrupar por familia con el semáforo del motor puro, resolver los
 * **registros de origen** de un check a partir de su evidencia literal, y leer
 * los avisos de calidad de datos. Las páginas se quedan con el JSX.
 *
 * Regla que no se rompe: **ninguna cifra se calcula aquí**. Los recuentos y el
 * estado de familia salen de `lib/audit/families.ts`, las cuatro cifras del
 * `headline` sellado del run, y los avisos de calidad de la función pura de E8.
 */

const STATUS: readonly CheckStatusValue[] = ["PASS", "FAIL", "WARN", "INFO"]

const asStatus = (value: string): CheckStatusValue =>
  (STATUS as readonly string[]).includes(value) ? (value as CheckStatusValue) : "INFO"

/**
 * Números de asiento nombrados en la evidencia de un check.
 *
 * La evidencia la escribe el motor en español contable («asiento 412: …»), así
 * que el patrón es estable y está en un solo sitio. Se acota a veinte por check:
 * un FAIL que nombra doscientos asientos no se resuelve en una tabla, se
 * resuelve en el libro diario, y para eso está el enlace del alcance.
 */
export function entryNumbersIn(evidencia: string): number[] {
  const found = new Set<number>()
  for (const match of evidencia.matchAll(/asiento\s+n?º?\s*(\d{1,9})/gi)) {
    const value = Number(match[1])
    if (Number.isSafeInteger(value) && value > 0) found.add(value)
  }
  return [...found].slice(0, 20)
}

/**
 * Resuelve los registros de origen de TODOS los checks de una vez: una sola
 * consulta por barrido, no una por check (nada de N+1).
 */
export async function originRecordsOf(
  db: AnyClient,
  checks: readonly CheckResult[]
): Promise<Map<string, OriginRecordView[]>> {
  const byCheck = new Map<string, number[]>()
  const all = new Set<number>()
  for (const check of checks) {
    if (check.status === "PASS") continue
    const numbers = entryNumbersIn(check.evidencia)
    if (numbers.length === 0) continue
    byCheck.set(check.id, numbers)
    for (const number of numbers) all.add(number)
  }
  if (all.size === 0) return new Map()

  const rows = await db.journalEntry.findMany({
    where: { entryNumber: { in: [...all].slice(0, 200) } },
    select: { id: true, entryNumber: true, entryDate: true, description: true, fileId: true },
    orderBy: { entryNumber: "asc" },
  })
  const byNumber = new Map(
    rows.map((row) => [
      row.entryNumber,
      {
        entryId: row.id,
        entryNumber: row.entryNumber,
        entryDate: fromUtcDate(row.entryDate),
        description: row.description,
        fileId: row.fileId,
      } satisfies OriginRecordView,
    ])
  )

  const out = new Map<string, OriginRecordView[]>()
  for (const [checkId, numbers] of byCheck) {
    const records = numbers.map((number) => byNumber.get(number)).filter((r): r is OriginRecordView => r !== undefined)
    if (records.length > 0) out.set(checkId, records)
  }
  return out
}

export function toCheckViews(
  checks: readonly CheckResult[],
  records: Map<string, OriginRecordView[]>
): CheckView[] {
  return checks.map((check) => ({
    id: check.id,
    family: familyOf(check.id),
    status: asStatus(check.status),
    evidencia: check.evidencia,
    query: check.query ?? null,
    registros: records.get(check.id) ?? [],
  }))
}

/** Las siete tarjetas, SIEMPRE las siete: una familia ausente sale SIN_EVALUAR. */
export function toFamilyCards(views: readonly CheckView[], checks: readonly CheckResult[]): FamilyCardView[] {
  return CHECK_FAMILIES.map((family) => {
    const own = checks.filter((check) => familyOf(check.id) === family)
    return {
      family,
      label: FAMILY_LABEL[family],
      status: familyStatus(own),
      counts: countsOf(own),
      checks: views.filter((view) => view.family === family),
    }
  })
}

/**
 * §Cuadres de cierre (O-18): la misma información, dicha en lenguaje de cierre.
 *
 * No es una segunda fuente: son los mismos checks del run, agrupados por lo que
 * un contable busca al cerrar y nombrados con su artículo. Los puentes fiscales
 * se nombran con **modelo y periodo**, que es como los pide el diseño; el id del
 * check queda a la vista para quien lo necesite.
 */
const CLOSING_BLOCKS: readonly { key: string; title: string; legal: string; ids: readonly string[]; prefixes?: readonly string[] }[] = [
  {
    key: "sumas-y-saldos",
    title: "Sumas y saldos, mes a mes",
    legal: "Balance de comprobación trimestral (art. 28.1 CCom) · I-E7-17",
    ids: ["I-E7-17"],
  },
  {
    key: "continuidad",
    title: "Continuidad con el ejercicio anterior",
    legal: "La apertura de N reproduce el cierre de N−1, cuenta a cuenta (art. 25 CCom) · I-E7-14",
    ids: ["I-E7-14"],
  },
  {
    key: "saldos-contrarios",
    title: "Saldos contrarios a su naturaleza",
    legal: "430 acreedor, 400/410 deudor, 572 acreedor sin póliza, 473 acreedor · I-E7-15",
    ids: ["I-E7-15"],
  },
  {
    key: "cuentas-puente",
    title: "Cuentas puente con saldo",
    legal: "555 partidas pendientes de aplicación, 551 y 4749 a fecha de cierre · I-E7-16",
    ids: ["I-E7-16"],
  },
  {
    key: "antiguedad",
    title: "Antigüedad de saldos",
    legal: "Aging de clientes (430) y acreedores (400/410) · I-E6-14 e I-E6-15",
    ids: ["I-E6-14", "I-E6-15"],
  },
  {
    key: "puentes-fiscales",
    title: "Puentes fiscales",
    legal: "Modelos 303, 111 y 115 contra el diario · I-E8-15a/b/c e I-E8-17",
    ids: ["I-E8-15a", "I-E8-15b", "I-E8-15c", "I-E8-17"],
  },
]

export function toClosingBlocks(views: readonly CheckView[]): ClosingBlockView[] {
  return CLOSING_BLOCKS.map((block) => ({
    key: block.key,
    title: block.title,
    legal: block.legal,
    // `startsWith` porque los checks de E6 se emiten etiquetados por variante o
    // por foto (`I2[PYMES/PRE_REGULARIZACION]`) y el id base es el prefijo.
    checks: views.filter((view) => block.ids.some((id) => view.id === id || view.id.startsWith(`${id}[`))),
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Resumen del run
// ─────────────────────────────────────────────────────────────────────────────

type Coverage = { evaluated?: string[]; skipped?: { block: string; reason: string }[]; unknownCheckIds?: string[] }

export function toRunSummary(
  run: InvariantRunRow,
  fiscalYearCode: string | null,
  sealReasons: readonly string[]
): RunSummaryView {
  const coverage = (run.coverage ?? {}) as Coverage
  const headline = (run.headline ?? {}) as HeadlineFigures
  return {
    id: run.id,
    seal: {
      sello: run.seal === "VALIDADO_AUTOMATICAMENTE" ? "VALIDADO AUTOMÁTICAMENTE" : "REQUIERE REVISIÓN",
      motivos: [...sealReasons],
    },
    scopeKind: run.scopeKind,
    fiscalYearCode,
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
    refDate: run.refDate,
    trigger: run.trigger,
    durationMs: run.durationMs,
    createdAt: run.createdAt.toISOString(),
    hashes: {
      ledgerHash: run.ledgerHash,
      analyticsKey: run.analyticsKey,
      planHash: run.planHash,
      accountMapHash: run.accountMapHash,
      configHash: run.configHash,
      gitSha: run.gitSha,
    },
    headline: HEADLINE_METRICS.map((metric) => ({
      metric,
      label: metric,
      cents: headline[metric]?.cents ?? 0,
    })),
    counts: countsOf(run.checks),
    skipped: coverage.skipped ?? [],
    unknownCheckIds: coverage.unknownCheckIds ?? [],
  }
}

/** Motivos del sello, ya en texto: la fila los guarda como lista de objetos. */
export function sealReasonsOf(run: InvariantRunRow): string[] {
  const raw = run.sealReasons
  if (!Array.isArray(raw)) return []
  return raw
    .map((reason) =>
      typeof reason === "string"
        ? reason
        : typeof reason === "object" && reason !== null && "codigo" in reason
          ? String((reason as { codigo: unknown; detalle?: unknown }).codigo) +
            ((reason as { detalle?: unknown }).detalle ? `: ${String((reason as { detalle?: unknown }).detalle)}` : "")
          : JSON.stringify(reason)
    )
    .filter((text) => text.length > 0)
}

export function toHistoryRows(runs: readonly InvariantRunRow[]): RunHistoryRow[] {
  return runs.map((run) => ({
    id: run.id,
    createdAt: run.createdAt.toISOString(),
    scopeKind: run.scopeKind,
    trigger: run.trigger,
    seal: run.seal as RunHistoryRow["seal"],
    refDate: run.refDate,
    counts: countsOf(run.checks),
    ledgerHashShort: short(run.ledgerHash, 12),
    gitShaShort: short(run.gitSha, 8),
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// §Calidad de datos
// ─────────────────────────────────────────────────────────────────────────────

/** El primer fichero de una operación: `Transaction.files` es un `Json`. */
function firstFileIdOf(files: unknown): string | null {
  if (!Array.isArray(files) || files.length === 0) return null
  const first = files[0]
  if (typeof first === "string") return first
  if (first !== null && typeof first === "object" && "id" in first) {
    const id = (first as { id?: unknown }).id
    return typeof id === "string" ? id : null
  }
  return null
}

/** Dónde se resuelve cada aviso. Un aviso sin salida es un aviso inútil. */
const DQ_LINK: Readonly<Record<string, { href: string | null; label: string }>> = {
  DOCUMENTO_SIN_ASIENTO: { href: "/unsorted", label: "Bandeja de documentos" },
  RUN_FAIL_SIN_RESOLVER: { href: "/unsorted?status=FAIL", label: "Documentos en FAIL" },
  EXTRACCION_PARCIAL: { href: "/unsorted?status=PARCIAL", label: "Extracciones parciales" },
  FICHERO_SIN_SHA256: { href: "/unsorted", label: "Bandeja de documentos" },
  DUPLICADO_FORZADO: { href: "/transactions", label: "Operaciones" },
  DEDUCIBILIDAD_PENDIENTE: { href: "/unsorted", label: "Bandeja de documentos" },
  DESVIACION_DE_CUOTA: { href: "/unsorted", label: "Bandeja de documentos" },
  TICKET_CUALIFICADO: { href: "/unsorted", label: "Bandeja de documentos" },
  RETENCION_NO_PRACTICADA: { href: "/reports/aging", label: "Antigüedad de saldos" },
  CONTRAPARTE_SIN_REGIMEN: { href: "/settings/counterparties", label: "Terceros y fiscalidad" },
}

/**
 * Los avisos de calidad de E8, leídos con las CINCO colecciones que la función
 * pura mira (`runs`, `transactions`, `files`, `duplicates`, `withholdings`).
 *
 * `withholdings` se pasa vacío a propósito: reconstruirlo exige materializar el
 * diario del periodo, y el contraste de la retención practicada contra lo
 * abonado a 4751 ya lo hace **I-E8-17**, que sale en §Cuadres de cierre con su
 * modelo y su periodo. Enseñarlo dos veces con dos lecturas distintas sería
 * exactamente la segunda verdad que la spec prohíbe.
 */
export async function readDataQuality(db: AnyClient): Promise<DataQualityRow[]> {
  const runs = await db.extractionRun.findMany({
    select: { reconcileStatus: true, partial: true, reconcile: true },
    take: 5000,
  })
  const transactions = await db.transaction.findMany({ select: { status: true, files: true }, take: 5000 })
  const files = await db.file.findMany({ select: { sha256: true }, take: 5000 })
  // Un duplicado FORZADO es una decisión de gobierno y vive en el registro, no
  // en una tabla propia: la misma fuente que usa `readDocumentsInvariantInput`.
  const forced = await db.auditLog.findMany({ where: { action: "FORCE_DUPLICATE" }, select: { entityId: true }, take: 2000 })

  const input = {
    runs: runs.map((run) => {
      const reconcile = (run.reconcile ?? {}) as {
        quotaDeviationsCents?: Record<string, number>
        warnings?: DataQualityWarning["code"][]
      }
      return {
        reconcileStatus: run.reconcileStatus,
        partial: run.partial,
        quotaDeviationsCents: reconcile.quotaDeviationsCents ?? {},
        warnings: reconcile.warnings ?? [],
      }
    }),
    transactions: transactions.map((transaction) => ({
      status: transaction.status,
      fileId: firstFileIdOf(transaction.files),
    })),
    files,
    duplicates: forced.map((row) => ({ id: row.entityId, forced: true })),
    withholdings: [],
    vatBook: [],
    vatBalances: [],
    exchangeRates: [],
    invoiceSeries: [],
    accounts: { inputVat: "472", outputVat: "477", withholding: "4751" },
  } as unknown as DocumentsInvariantInput

  return dataQualityWarnings(input).map((warning) => {
    const link = DQ_LINK[warning.code] ?? { href: null, label: "—" }
    return { code: warning.code, count: warning.count, message: warning.message, href: link.href, hrefLabel: link.label }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// §Registro
// ─────────────────────────────────────────────────────────────────────────────

/** Resumen legible de un `before`/`after` sin volcar el JSON entero. */
export function summarizeChange(before: unknown, after: unknown): string {
  const value = after ?? before
  if (value === null || value === undefined) return "—"
  if (typeof value !== "object") return String(value)
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== null && item !== undefined && typeof item !== "object")
    .slice(0, 4)
  return entries.length === 0 ? "—" : entries.map(([field, item]) => `${field}: ${String(item)}`).join(" · ")
}

export function toAuditLogRows(
  logs: readonly { id: string; ts: Date; entity: string; entityId: string; action: string; reason: string | null; userId: string | null; before: unknown; after: unknown }[],
  nameByUserId: Map<string, string>
): AuditLogRow[] {
  return logs.map((log) => ({
    id: log.id,
    ts: log.ts.toISOString(),
    entity: log.entity,
    entityId: log.entityId,
    action: log.action,
    reason: log.reason,
    userName: log.userId ? (nameByUserId.get(log.userId) ?? "—") : "sistema",
    resumen: summarizeChange(log.before, log.after),
  }))
}

export type { CheckFamily }
