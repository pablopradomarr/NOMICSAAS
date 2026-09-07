/**
 * E7 · T7/T8 — Tipos del dominio de conciliación bancaria.
 *
 * Son **tipos planos**: los rellenan los parsers (`lib/bank/csv.ts`,
 * `lib/bank/n43.ts`) y, desde T9, `models/bank.ts` leyendo Prisma. El motor
 * (`lib/audit/**`) no conoce Prisma ni ninguna otra fuente; recibe estas
 * estructuras ya leídas. Los literales coinciden uno a uno con los enums del
 * esquema (`bank_line_status`, `ignore_reason`, `match_group_kind`) para que la
 * conversión en el borde sea la identidad.
 *
 * Módulo PURO: sin IO, sin `Date.now()`, sin Prisma.
 */

import type { Cents, EntryKind, LocalDate } from "@/lib/ledger/types"

export type { Cents, LocalDate }

/** `SUGGESTED` no existe: una sugerencia es un cálculo, no un hecho (§2.2). */
export type BankLineStatus = "UNMATCHED" | "MATCHED" | "IGNORED"

/**
 * Vocabulario CERRADO de ignorado (O-4/m2). `IMPORTE_CERO` lo pone la
 * importación sola y es el único que no exige evidencia: la evidencia es el
 * propio importe.
 */
export type IgnoreReason =
  | "ERROR_BANCO_REVERSADO"
  | "NO_ES_NUESTRA_CUENTA"
  | "YA_CONTABILIZADO_EN_OTRA_CUENTA"
  | "IMPORTE_CERO"

/** Los dos motivos que exigen evidencia (I-E7-13). */
export const IGNORE_REASONS_WITH_EVIDENCE: readonly IgnoreReason[] = [
  "ERROR_BANCO_REVERSADO",
  "YA_CONTABILIZADO_EN_OTRA_CUENTA",
]

export type MatchGroupKind = "SIMPLE" | "N_A_1" | "UNO_A_N" | "N_A_N"

export type StatementFormat = "CSV" | "N43" | "MANUAL"

/**
 * Tipos de pendiente (O-8). No los deduce el motor de un texto —eso sería
 * auto-punteo por patrón, E12—: los declara quien concilia, y el motor los
 * **envejece** y los usa para decidir si un pendiente está explicado (§3.6).
 */
export type PendingKind =
  | "CHEQUE_EMITIDO_NO_CARGADO"
  | "REMESA_NO_ABONADA"
  | "TRASPASO_ENTRE_CUENTAS_EN_CAMINO"
  | "MOVIMIENTO_BANCO_SIN_ASIENTO"
  | "APUNTE_SIN_MOVIMIENTO"
  | "EFECTO_EN_GESTION_DE_COBRO"

/**
 * `EFECTO_EN_GESTION_DE_COBRO` **no es conciliable**: vive en `4312`/`4311`, no
 * en 57x, y queda excluido del cuadre (§3.5).
 */
export const PENDING_KINDS_OUT_OF_RECONCILIATION: readonly PendingKind[] = ["EFECTO_EN_GESTION_DE_COBRO"]

/** Las únicas subcuentas conciliables (O-7). `570`/`571` (caja) quedan fuera. */
export const RECONCILABLE_ACCOUNT_PREFIXES: readonly string[] = ["572", "573", "574", "575"]

/** Caja: no tiene extracto y no puede tenerlo. Excluye el badge P6 (O-16). */
export const CASH_ACCOUNT_PREFIXES: readonly string[] = ["570", "571"]

export const isUnderAccount = (code: string, root: string): boolean => code === root || code.startsWith(root)

export const isReconcilableAccount = (code: string): boolean =>
  RECONCILABLE_ACCOUNT_PREFIXES.some((p) => isUnderAccount(code, p))

export const isCashAccount = (code: string): boolean => CASH_ACCOUNT_PREFIXES.some((p) => isUnderAccount(code, p))

// ─────────────────────────────────────────────────────────────────────────────
// Referencias de entrada
// ─────────────────────────────────────────────────────────────────────────────

export type BankAccountRef = {
  id: string
  organizationId: string
  code: string
  name?: string
  /** La subcuenta 57x contra la que se puntea (O-7). */
  accountCode: string
  currency: string
  /** **El anclaje (O-1).** Sin él, I-E7-1 sale INFO y el badge no se concede. */
  reconciledFromDate: LocalDate | null
  reconciledOpeningBalanceCents: Cents | null
  /** Configuración, nunca invariante (O-10). Sólo alimenta la sugerencia. */
  matchToleranceDays: number
  /** Antigüedad a partir de la cual una partida en tránsito deja de ser normal. */
  transitWarnDays: number
  /** Umbral de materialidad de ignorados (I-E7-13). Configuración. */
  ignoredMaterialityCents?: Cents
  /** I-E7-15: una 572 acreedora sólo es normal con póliza de crédito declarada. */
  hasCreditFacility?: boolean
}

export type BankStatementRef = {
  id: string
  bankAccountId: string
  format?: StatementFormat
  fileSha256: string
  currency: string
  /** El corte SIEMPRE es por fecha de operación (O-6). */
  periodStart: LocalDate
  periodEnd: LocalDate
  /** Declarados por el banco (registros 11 y 33), no calculados por nosotros. */
  openingBalanceCents: Cents | null
  closingBalanceCents: Cents | null
  /** Registro 33: número de apuntes declarado por el banco. */
  declaredLineCount: number | null
  lineCount: number
}

export type BankLineRef = {
  id: string
  statementId: string
  bankAccountId: string
  lineNo: number
  /** Fecha CONTABLE del banco: la única que corta periodos (O-6). */
  operationDate: LocalDate
  /** Dato financiero: se enseña, y está prohibida en toda agregación de cuadre. */
  valueDate: LocalDate
  /** CON SIGNO: negativo = cargo, positivo = abono, en la divisa de la cuenta. */
  amountCents: Cents
  currency: string
  originalCurrency?: string | null
  originalAmountCents?: Cents | null
  balanceCents?: Cents | null
  description: string
  /** La referencia de la REMESA: clave de agrupación N-a-1 (O-15). */
  reference1?: string | null
  reference2?: string | null
  conceptCommon?: string | null
  conceptOwn?: string | null
  counterpartyName?: string | null
  sha256: string
  status: BankLineStatus
  ignoreReason?: IgnoreReason | null
  ignoreEvidenceId?: string | null
  /** Tipado del pendiente cuando alguien lo declaró (O-8). */
  pendingKind?: PendingKind | null
}

/** Un apunte de 57x del diario: **una `JournalLine`**, nunca un asiento (§2.4). */
export type LedgerCashLineRef = {
  id: string
  organizationId: string
  entryId: string
  entryNumber: number
  entryDate: LocalDate
  entryKind: EntryKind
  /** Presente para que la línea sea, tal cual, una `ReportLine` del motor de E6. */
  fiscalYearId: string
  lineNo: number
  accountCode: string
  debitCents: Cents
  creditCents: Cents
  description?: string | null
  counterpartyName?: string | null
  /** Referencia de remesa del apunte, cuando el documento la trae (O-15). */
  reference?: string | null
  pendingKind?: PendingKind | null
  /**
   * Divisa e importe ORIGINALES de la partida (ADR-0014 D2, `hashVersion = 3`).
   * Son lo que hace posible cuadrar una cuenta bancaria en divisa **en su
   * divisa** (H-1): `debitCents`/`creditCents` están siempre en moneda base.
   */
  originalCurrency?: string | null
  originalAmountCents?: Cents | null
}

/** Fila de pertenencia a un grupo de conciliación. */
export type BankMatchMemberRef = {
  statementLineId: string
  journalLineId: string
  /** Desfase sellado en el momento del punteo (O-10). Nunca un FAIL. */
  dateGapDays: number
}

export type BankMatchGroupRef = {
  id: string
  organizationId: string
  bankAccountId: string
  kind: MatchGroupKind
  /** `null` = grupo VIVO. Desconciliar marca el grupo, no borra nada. */
  unmatchedAt: string | null
  members: readonly BankMatchMemberRef[]
}

/** Importe con signo de un apunte de 57x **en moneda base**: `debe − haber`. */
export const signedAmountOf = (line: Pick<LedgerCashLineRef, "debitCents" | "creditCents">): Cents =>
  line.debitCents - line.creditCents

/**
 * Importe con signo de un apunte **en su divisa original** (ADR-0015 D6.2,
 * hallazgo H-1 de la auditoría de E7).
 *
 * `original_amount_cents` se guarda en **valor absoluto** —igual que `debe` y
 * `haber`, que nunca son negativos: el signo lo da el lado— y la columna forma
 * parte de `canonicalEntryFormV3` (`hashVersion = 3`), de modo que es inmutable
 * y auditable. El signo se toma del lado del apunte, exactamente como en
 * `signedAmountOf`: un cargo del banco es un HABER de la 57x, esté en euros o en
 * dólares.
 *
 * Devuelve `null` cuando el apunte no lleva el importe en divisa: sin él **no se
 * puede** cuadrar la cuenta en su moneda, y el cuadre sale «no evaluable» en vez
 * de mezclar monedas (que es lo que la ronda 1 hacía).
 */
export const signedOriginalAmountOf = (
  line: Pick<LedgerCashLineRef, "debitCents" | "creditCents" | "originalAmountCents">
): Cents | null => {
  const magnitude = line.originalAmountCents
  if (magnitude === null || magnitude === undefined) return null
  const base = signedAmountOf(line)
  if (base === 0) return 0
  return base < 0 ? -Math.abs(magnitude) : Math.abs(magnitude)
}

// ─────────────────────────────────────────────────────────────────────────────
// Fechas y el borde de `bigint`
// ─────────────────────────────────────────────────────────────────────────────

/** Días desde la era civil (Hinnant). Sin `Date`, para poder ser puro y exacto. */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y
  const era = Math.floor(yy / 400)
  const yoe = yy - era * 400
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

export function dayNumberOf(date: LocalDate): number {
  return daysFromCivil(Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10)))
}

/** Días entre dos fechas contables (`b − a`), con signo. */
export const daysBetween = (a: LocalDate, b: LocalDate): number => dayNumberOf(b) - dayNumberOf(a)

/** Antigüedad en días de una fecha respecto al corte. Negativa si es futura. */
export const ageInDays = (date: LocalDate, cutoff: LocalDate): number => daysBetween(date, cutoff)

/**
 * **El borde de `bigint` (ADR-0015 D1/O-23).** Los importes de las tablas nuevas
 * son `bigint` en la base; la aritmética del motor es `number` en céntimos. La
 * conversión comprueba `Number.isSafeInteger` y **lanza** por encima de 2⁵³−1 en
 * vez de perder precisión en silencio.
 */
export function centsFromBigInt(value: bigint, label = "importe"): Cents {
  const MAX = BigInt(Number.MAX_SAFE_INTEGER)
  if (value > MAX || value < -MAX) {
    throw new RangeError(`${label}: ${value.toString()} céntimos excede 2^53−1 y no cabe en un number sin perder precisión`)
  }
  return Number(value)
}
