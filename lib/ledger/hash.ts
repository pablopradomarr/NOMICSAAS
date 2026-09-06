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
 * **La tupla exacta la fija `docs/adr/0011-forma-canonica-hashes.md`**
 * (APROBADO), que SUSTITUYE la tabla de tuplas de ADR-0010 §E4-D2. Resumen del
 * criterio de comparabilidad que ese ADR razona:
 *
 *   · `ledgerHash` es un sello **de informe** y debe ser comparable entre
 *     organizaciones y entre cargas (criterio 15 de E3 y 18 de E4, con test en
 *     verde). Por eso NO lleva uuid: `entryId`, `fiscalYearId` y `taxRateId`
 *     son claves técnicas, no cifras del hecho económico, y cambiar un uuid no
 *     cambia un céntimo. La identidad de la línea dentro de su organización ya
 *     la fijan `(entryDate, entryNumber, lineNo)`, único por I7.
 *   · `entryHash` es un sello **de fila** (I-E3-7): su trabajo es detectar
 *     CUALQUIER mutación, incluidas las que no mueven un céntimo, así que lleva
 *     todas las columnas, uuids incluidos. No necesita ser comparable.
 *
 * Regla para el futuro: una columna que represente una cifra o una fecha
 * contable entra en `ledgerHash`; una clave técnica o un dato de gestión, no
 * —pero sí en `entryHash`.
 *
 * **`hashVersion` = 2 y no se toca nunca más.** El cambio de forma canónica solo
 * era posible ahora, sin datos en producción: la migración
 * `20260908100000_e4_analytics` recalcula el histórico y escribe
 * `hash_version = 2` en todas las filas. Cualquier cambio futuro exige una
 * versión nueva y convivencia, jamás una reescritura.
 *
 * ## Forma canónica v3 (E8 · T2b, ADR-0014 D2)
 *
 * Y llegó ese cambio futuro. `JournalLine` gana las tres columnas de divisa
 * original (`originalCurrency`, `originalAmountCents`, `exchangeRateId`) porque
 * sin ellas la valoración de las partidas monetarias al tipo de cierre (NRV
 * 11ª.2.1) no es computable **desde el diario**, que es la fuente única
 * (ADR-0003). `entryHash` es un sello de fila: su trabajo es detectar CUALQUIER
 * mutación, así que tiene que cubrirlas.
 *
 * Se hace **exactamente como el ADR-0011 prescribe: versión nueva y
 * convivencia**, nunca una reescritura del histórico.
 *
 * | | v2 | v3 |
 * |---|---|---|
 * | Filas | las que ya existen (`hash_version = 2`) | las que nazcan con divisa (`hash_version = 3`) |
 * | Forma | `canonicalEntryForm` | `canonicalEntryFormV3` = v2 + las tres columnas |
 * | Verificación (I-E3-7) | `entryHash(lines, 2)` | `entryHash(lines, 3)` |
 *
 * Tres consecuencias que hay que tener presentes:
 *
 *   1. **Los fixtures de E3–E6 no cambian ni un byte**: sus asientos son v2 y se
 *      siguen verificando con v2. `lib/ledger/fixtures.test.ts` y
 *      `hash.test.ts` lo comprueban explícitamente.
 *   2. **`ledgerHash` NO cambia**: la forma canónica financiera es la misma. El
 *      hecho económico en moneda base es idéntico y las cachés de `ReportRun`
 *      de E6 no se invalidan (I-E6-18).
 *   3. **Despacho por versión, siempre.** Verificar una fila v2 con v3 —o al
 *      revés— da un falso FAIL de I-E3-7. Por eso `entryHash` recibe la versión
 *      y `checkIE37` lee la que la fila declara. Es el riesgo R5 de la épica.
 *
 * Módulo PURO: `node:crypto` es determinista y sin IO.
 */

import { createHash } from "node:crypto"

import type { AnalyticType, Cents, EntryKind, LocalDate } from "@/lib/ledger/types"

/**
 * Versión de la forma canónica **histórica** de `entryHash`, la que llevan todas
 * las filas anteriores a E8. Se conserva porque la convivencia la necesita: es
 * la versión con la que se verifican esas filas, y no se recalculan jamás.
 */
export const HASH_VERSION = 2

/**
 * Versión que emite este módulo **hoy** para un asiento nuevo (E8 · T2b,
 * ADR-0014 D2). Es la que `postEntryTx` escribe en `journal_entries.hash_version`.
 */
export const HASH_VERSION_CURRENT = 3

/** Las formas canónicas de fila que este módulo sabe verificar. */
export type HashVersion = 2 | 3

const HASH_VERSIONS: readonly HashVersion[] = [2, 3]

export function isHashVersion(value: number): value is HashVersion {
  return (HASH_VERSIONS as readonly number[]).includes(value)
}

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
  /**
   * **E8 · T2b (ADR-0014 D2).** Divisa original de la partida monetaria. Sólo
   * entran en `canonicalEntryFormV3`; en v2 se ignoran por completo, que es lo
   * que hace que las filas históricas sigan sellando igual.
   */
  originalCurrency?: string | null
  originalAmountCents?: Cents | null
  exchangeRateId?: string | null
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

/**
 * Forma canónica de fila **v3** (E8 · T2b, ADR-0014 D2): la v2 **más** las tres
 * columnas de divisa original, en ese orden y al final, de modo que el prefijo
 * de cada fila sea literalmente el de v2.
 *
 * Esa colocación no es estética: hace evidente en el diff qué añade la versión
 * nueva, y garantiza que un asiento sin divisa dé una v3 que difiere de su v2
 * **sólo** en tres `∅` finales, que es exactamente lo que una convivencia debe
 * poder explicar.
 */
export function canonicalEntryFormV3(lines: readonly HashableLine[]): string {
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
        // ── v3 ──
        nullable(l.originalCurrency),
        nullable(l.originalAmountCents),
        nullable(l.exchangeRateId),
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
 *
 * **Convivencia (E8 · T2b).** El parámetro `version` decide la forma canónica.
 * Por omisión emite **v3**, que es lo que hoy se sella; para VERIFICAR una fila
 * hay que pasarle la versión que la fila declara (`journal_entries.hash_version`)
 * o el resultado es un falso FAIL de I-E3-7. `checkIE37` ya lo hace.
 */
export function entryHash(lines: readonly HashableLine[], version: HashVersion = HASH_VERSION_CURRENT): string {
  return sha256(version === 2 ? canonicalEntryForm(lines) : canonicalEntryFormV3(lines))
}
