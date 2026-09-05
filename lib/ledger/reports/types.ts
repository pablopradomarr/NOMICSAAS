/**
 * E3 · T7 — Tipos comunes de los tres informes derivados del diario.
 *
 * Los informes reciben las líneas **ya leídas** (`models/ledger.ts` hace el
 * SQL) y son funciones puras `f(lines, accounts, params) → Report`. No hay
 * cifras "de informe" almacenadas: ADR-0003, P2.
 */

import type { Cents, EntryKind, LocalDate, SourceType, TaxRoundingMode } from "@/lib/ledger/types"
import type { Provenance, ProvenanceContext } from "@/lib/ledger/provenance"

export type { Provenance, ProvenanceContext }

/** Línea del diario tal y como la ven los informes. */
export type ReportLine = {
  id?: string
  entryId: string
  entryNumber: number
  entryDate: LocalDate
  entryKind: EntryKind
  fiscalYearId: string
  lineNo: number
  accountCode: string
  debitCents: Cents
  creditCents: Cents
  description?: string | null
  dueDate?: LocalDate | null
  /** E4-D2: entra en la forma canónica v2 de `ledgerHash`. */
  taxRateId?: string | null
}

/** Cabecera del asiento, para el libro diario. */
export type ReportEntry = {
  id: string
  entryNumber: number
  entryDate: LocalDate
  documentDate?: LocalDate | null
  accrualDate?: LocalDate | null
  description: string
  kind: EntryKind
  sourceType: SourceType
  sourceId?: string | null
  templateCode?: string | null
  taxRoundingMode?: TaxRoundingMode
  reversesEntryId?: string | null
  voidedAt?: string | null
}

/** Cuenta del plan, con lo que los informes necesitan de ella. */
export type ReportAccount = {
  code: string
  name: string
  level?: number
  isContra?: boolean
}

export type ReportPeriod = {
  organizationId: string
  from: LocalDate
  to: LocalDate
  baseCurrency: string
  /**
   * Ejercicio al que se acota el informe, si se acota (#10). Viaja hasta la
   * provenance de cada celda para que el drill-down devuelva EXACTAMENTE las
   * líneas que suman la cifra.
   */
  fiscalYearId?: string
}

/** Fila de cuadre común a los tres informes. */
export type BalanceCheck = {
  totalDebitCents: Cents
  totalCreditCents: Cents
  differenceCents: Cents
  balanced: boolean
}

export const balanceCheck = (debit: Cents, credit: Cents): BalanceCheck => ({
  totalDebitCents: debit,
  totalCreditCents: credit,
  differenceCents: debit - credit,
  balanced: debit === credit,
})

/** Filtra al periodo. `entryDate` es la ÚNICA fecha que manda en un informe. */
export const inPeriod = (line: { entryDate: LocalDate }, period: { from: LocalDate; to: LocalDate }): boolean =>
  line.entryDate >= period.from && line.entryDate <= period.to

/** Orden de presentación del diario: `(entryDate, entryNumber, lineNo)` (N-5). */
export function compareLines(a: ReportLine, b: ReportLine): number {
  return (
    (a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : 0) ||
    a.entryNumber - b.entryNumber ||
    a.lineNo - b.lineNo
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// E6 · T5 — Tipos de los estados financieros (docs/design/E6-informes.md §3.1)
// ─────────────────────────────────────────────────────────────────────────────

import type { CashflowBucket, Nature, PgcVariant, Statement } from "@/lib/accounts/types"

export type { CashflowBucket, Nature, PgcVariant, Statement }

/**
 * Cuenta del plan con TODO lo que los estados financieros necesitan de ella.
 * Se construye una vez por informe y no se vuelve a tocar la base.
 */
export type StatementAccount = ReportAccount & {
  statement: Statement | null
  epigraph: string | null
  epigraphPymes: string | null
  bidirectional: boolean
  isContra: boolean
  nature: Nature
  cashflowBucket: CashflowBucket | null
}

/**
 * Las tres fotos del balance (§1.1 de la validación contable). La cuarta,
 * `APERTURA_2027`, no es una foto: es el ejercicio siguiente con `POST_CIERRE`.
 */
export type BalanceSnapshot = "PRE_REGULARIZACION" | "POST_REGULARIZACION" | "POST_CIERRE"

/**
 * `kind` excluidos por foto. Tabla, no `if` repartidos por el código: el día que
 * aparezca una cuarta foto se añade una fila, no se busca un condicional.
 */
export const SNAPSHOT_EXCLUDED: Record<BalanceSnapshot, readonly EntryKind[]> = {
  PRE_REGULARIZACION: ["REGULARIZATION", "CLOSING"],
  POST_REGULARIZACION: ["CLOSING"],
  POST_CIERRE: [],
}

/** Fila de un estado financiero. Mismo esquema que `estados-esperados.json`. */
export type StatementRow = {
  /** Ruta completa: "A) Activo no corriente / II. Inmovilizado material". */
  path: string
  /** Último segmento de la ruta. */
  label: string
  depth: number
  /** Ordinal por segmento — NUNCA orden lexicográfico (`X.` va tras `IX.`). */
  order: readonly number[]
  /** Con el signo de PRESENTACIÓN (R-B2), no el saldo contable. */
  cents: Cents
  isLeaf: boolean
  /** Comparativo. `undefined` ≠ 0: «sin comparativo» no es «cero» (§8.7). */
  previousCents?: Cents
  deltaCents?: Cents
  /** `null` si el comparativo es 0 — nunca `NaN` ni `Infinity` (G-05). */
  deltaBps?: number | null
  accountCodes: readonly string[]
  /** «VII. Resultado del ejercicio» inyectado por R-B5. */
  isComputed: boolean
  /** Marca `(−)` en la UI (R-B3). NO interviene en el cálculo. */
  isContraCell: boolean
  provenance?: Provenance
  children?: StatementRow[]
}

/** Universo de líneas de un informe, ya acotado. */
export const excludingKinds = (
  lines: readonly ReportLine[],
  kinds: readonly EntryKind[]
): ReportLine[] => (kinds.length === 0 ? [...lines] : lines.filter((l) => !kinds.includes(l.entryKind)))

/** Saldos `Σdebe − Σhaber` por cuenta (R-B1). Positivo = deudor. */
export function balancesByAccount(lines: readonly ReportLine[]): Map<string, Cents> {
  const out = new Map<string, Cents>()
  for (const l of lines) out.set(l.accountCode, (out.get(l.accountCode) ?? 0) + l.debitCents - l.creditCents)
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Índice del plan con herencia por prefijo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * El seed declara `estado_financiero`, `epigrafe`, `epigrafe_pymes` y
 * `cashflow_bucket` en el nivel donde el dato es cierto (a menudo el subgrupo) y
 * los deja vacíos en las subcuentas. Resolverlos exige **subir por el código**
 * hasta el primer ancestro que traiga valor — exactamente lo que hace `inherit()`
 * en el generador del fixture. Se recorta un carácter cada vez porque un ancestro
 * intermedio puede no existir en el plan de la variante.
 */
export type AccountIndex = {
  byCode: ReadonlyMap<string, StatementAccount>
  statementOf: (code: string) => Statement | null
  epigraphOf: (code: string, variant: PgcVariant) => string | null
  bucketOf: (code: string) => CashflowBucket | null
  isContra: (code: string) => boolean
  isBidirectional: (code: string) => boolean
  nameOf: (code: string) => string
}

function inherit<T>(byCode: ReadonlyMap<string, StatementAccount>, code: string, pick: (a: StatementAccount) => T | null): T | null {
  for (let cur = code; cur.length > 0; cur = cur.slice(0, -1)) {
    const account = byCode.get(cur)
    if (!account) continue
    const value = pick(account)
    if (value !== null && value !== undefined && value !== "") return value
  }
  return null
}

/** Memoiza la herencia: un informe pregunta lo mismo cientos de veces. */
export function buildAccountIndex(accounts: readonly StatementAccount[]): AccountIndex {
  const byCode = new Map(accounts.map((a) => [a.code, a]))
  const memo = new Map<string, unknown>()
  const cached = <T>(key: string, compute: () => T): T => {
    if (memo.has(key)) return memo.get(key) as T
    const value = compute()
    memo.set(key, value)
    return value
  }
  return {
    byCode,
    statementOf: (code) => cached(`s:${code}`, () => inherit(byCode, code, (a) => a.statement)),
    epigraphOf: (code, variant) =>
      cached(`e:${variant}:${code}`, () =>
        variant === "PYMES"
          ? (inherit(byCode, code, (a) => a.epigraphPymes) ?? inherit(byCode, code, (a) => a.epigraph))
          : inherit(byCode, code, (a) => a.epigraph)
      ),
    bucketOf: (code) => cached(`b:${code}`, () => inherit(byCode, code, (a) => a.cashflowBucket)),
    // `isContra` y `bidirectional` son booleanos declarados en la propia cuenta;
    // `bidirectional` además se hereda, porque el seed lo marca en `551`/`552` y
    // las subcuentas (`5510`) lo son también.
    isContra: (code) => byCode.get(code)?.isContra ?? false,
    isBidirectional: (code) =>
      cached(`d:${code}`, () => {
        for (let cur = code; cur.length > 0; cur = cur.slice(0, -1)) {
          if (byCode.get(cur)?.bidirectional) return true
        }
        return false
      }),
    nameOf: (code) => byCode.get(code)?.name ?? "",
  }
}

/** Prefijo de tesorería (R-CF-1). No es configurable: es la definición de efectivo. */
export const CASH_PREFIX = "57"
export const isCashAccount = (code: string): boolean => code.startsWith(CASH_PREFIX)
