/**
 * E3 · T4 / E4 · T4 — Sellos de contenido del diario.
 *
 * ## Forma canónica v2 (E4-D2, `docs/design/E4-analitica.md` §2.5)
 *
 * E3 emitió la **v1**, que metía las cuatro columnas analíticas dentro de
 * `ledgerHash`. Con la reclasificación analítica admitida (ADR-0010), reimputar
 * un gasto de un proyecto a otro cambiaría el `ledgerHash` del periodo e
 * invalidaría el balance, la PyG contable, el cashflow y el libro diario ya
 * sellados —que no han cambiado en un solo céntimo—, que es justo lo que P3 y
 * P7 de SPEC-FIABILIDAD prohíben.
 *
 * Desde E4 hay **tres sellos con tres oficios distintos**:
 *
 * | Sello | Contenido | Cambia con |
 * |---|---|---|
 * | `ledgerHash` (financiero) | `(entryDate, entryNumber, lineNo, accountCode, debit, credit, entryKind)` — la v1 **menos** las cuatro columnas analíticas | cualquier cambio contable; **no** con una reclasificación |
 * | `entryHash` (de fila) | **todas** las columnas de la línea, dimensiones incluidas | cualquier cosa del asiento, reclasificación incluida (se recalcula) |
 * | `analyticsHash` | `lib/analytics/hash.ts` | reclasificación, `MarginLevelConfig`, `analyticType` de cuenta, liquidación |
 *
 * **Por qué `ledgerHash` no lleva ids.** El diseño enumera la tupla como
 * `(entryId, lineNo, …, fiscalYearId, …, taxRateId)`, pero esos tres son uuid
 * generados por fila: metiéndolos, dos cargas del MISMO fixture en dos
 * organizaciones producirían sellos distintos y se caería tanto el criterio 15
 * de E3 («dos cargas dan el mismo `ledgerHash`», test en verde desde E3) como
 * el criterio 18 de E4 y el efecto colateral que el propio E4-D2 persigue: que
 * dos organizaciones con el mismo diario produzcan el mismo sello financiero y
 * las verificaciones de I1–I3 sean comparables. La identidad del asiento dentro
 * de su organización ya la fijan `(entryDate, entryNumber, lineNo)`, que es el
 * orden canónico. `entryHash` sí lleva los ids: es un sello **de fila**, no de
 * informe, y su trabajo es detectar cualquier cambio, no ser comparable entre
 * organizaciones.
 *
 * **`hashVersion` = 2 y no se toca nunca más.** El cambio de forma canónica solo
 * era posible ahora, sin datos en producción: la migración
 * `20260908100000_e4_analytics` recalcula el histórico y escribe
 * `hash_version = 2` en todas las filas. Cualquier cambio futuro exige una
 * versión nueva y convivencia, jamás una reescritura.
 *
 * Módulo PURO: `node:crypto` es determinista y sin IO.
 */

import { createHash } from "node:crypto"

import type { AnalyticType, Cents, EntryKind, LocalDate } from "@/lib/ledger/types"

/** Versión de la forma canónica que emite este módulo. */
export const HASH_VERSION = 2

/** Lo mínimo que una línea debe aportar al hash. */
export type HashableLine = {
  entryDate: LocalDate
  /** 0 para un borrador aún sin numerar (`entryHash` de un asiento nuevo). */
  entryNumber?: number | null
  /** Id del asiento. Ausente en un borrador: entra como `∅`. */
  entryId?: string | null
  lineNo: number
  accountCode: string
  debitCents: Cents
  creditCents: Cents
  entryKind: EntryKind
  fiscalYearId?: string | null
  taxRateId?: string | null
  taxBaseCents?: Cents | null
  counterpartyId?: string | null
  dueDate?: LocalDate | null
  description?: string | null
  analyticType?: AnalyticType | null
  projectId?: string | null
  costCenterId?: string | null
  businessLineId?: string | null
}

const NULL_TOKEN = "∅"

const nullable = (v: string | number | null | undefined): string =>
  v === null || v === undefined || v === "" ? NULL_TOKEN : String(v)

/**
 * Orden canónico: `(entryDate, entryNumber, lineNo)`. Con `entryNumber` ausente
 * (borrador) se usa 0, de modo que el orden lo fija `lineNo`, que es lo único
 * conocido antes de postear.
 */
function canonicalSort(lines: readonly HashableLine[]): HashableLine[] {
  return [...lines].sort(
    (a, b) =>
      (a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : 0) ||
      (a.entryNumber ?? 0) - (b.entryNumber ?? 0) ||
      a.lineNo - b.lineNo
  )
}

/**
 * Forma canónica **financiera** (v2): una fila TSV por línea, `\n` entre filas,
 * `∅` para nulos. **Sin** `project_id`, `cost_center_id`, `business_line_id` ni
 * `analytic_type`: son datos de gestión y no sellan el hecho económico.
 */
export function canonicalForm(lines: readonly HashableLine[]): string {
  return canonicalSort(lines)
    .map((l) =>
      [
        l.entryDate,
        String(l.entryNumber ?? 0),
        String(l.lineNo),
        l.accountCode,
        String(l.debitCents),
        String(l.creditCents),
        l.entryKind,
      ].join("\t")
    )
    .join("\n")
}

/**
 * Forma canónica **de fila** (v2): TODAS las columnas de la línea, las cuatro
 * analíticas incluidas. Es la que sella `entryHash` y la que se recalcula al
 * reclasificar (salvaguarda 2 de ADR-0010).
 */
export function canonicalEntryForm(lines: readonly HashableLine[]): string {
  return canonicalSort(lines)
    .map((l) =>
      [
        nullable(l.entryId),
        String(l.entryNumber ?? 0),
        String(l.lineNo),
        l.accountCode,
        String(l.debitCents),
        String(l.creditCents),
        l.entryDate,
        nullable(l.fiscalYearId),
        l.entryKind,
        nullable(l.taxRateId),
        nullable(l.taxBaseCents),
        nullable(l.counterpartyId),
        nullable(l.dueDate),
        nullable(l.description),
        nullable(l.analyticType),
        nullable(l.projectId),
        nullable(l.costCenterId),
        nullable(l.businessLineId),
      ].join("\t")
    )
    .join("\n")
}

const sha256 = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex")

/** sha256 de la forma canónica FINANCIERA de un conjunto de líneas (v2). */
export function ledgerHash(lines: readonly HashableLine[]): string {
  return sha256(canonicalForm(lines))
}

/**
 * sha256 de las líneas de UN asiento (I-E3-7), con todas sus columnas. Ya NO es
 * la misma función que `ledgerHash`: desde E4 cubre más (E4-D2).
 */
export function entryHash(lines: readonly HashableLine[]): string {
  return sha256(canonicalEntryForm(lines))
}
