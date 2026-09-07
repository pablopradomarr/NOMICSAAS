/**
 * E7 · T9 — Conciliación bancaria: acceso a datos (`docs/design/E7-auditoria.md`
 * §4.1 y §4.3).
 *
 * Este módulo **no decide nada contable**: lee y escribe. Quien decide es el
 * motor puro (`lib/audit/**`, `lib/bank/**`), que aquí se invoca con tipos
 * planos. Cuatro reglas del diseño que gobiernan el fichero:
 *
 *  1. **El corte es por `operationDate`** (O-6). La fecha valor se guarda, se
 *     enseña y no entra en ninguna agregación de cuadre.
 *  2. **La importación comprueba antes de escribir** (§4.3): divisa, I-E7-5 e
 *     I-E7-6a corren sobre el fichero PARSEADO y, si fallan, no se inserta ni
 *     una línea. Un fichero que no cuadra se rechaza entero.
 *  3. **La igualdad de importes se revalida en el servidor** al conciliar
 *     (I-E7-2 y I-E7-11, tolerancia 0), además de en la base: el camino de
 *     escritura manual es el que usa una persona con prisa en un cierre (O-9).
 *  4. **Agregados en SQL y lecturas en serie**: dentro de una transacción se
 *     comparte una sola conexión, y `Promise.all` de `$queryRaw` hace que el
 *     adaptador avise de «client is already executing a query» (lección de E6).
 */

import { randomUUID } from "node:crypto"

import { suggestMatches, suggestionRows, type MatchSuggestionRow } from "@/lib/audit/bank-match"
import {
  reconciliationSummary,
  type BankInvariantInput,
  type BankReconciliationSummary,
  type FxCloseRef,
} from "@/lib/audit/invariants-e7"
import { assignDayOrdinals, bankLineSha256, sha256OfBytes } from "@/lib/bank/hash"
import { parseBankCsv, type CsvMapping } from "@/lib/bank/csv"
import { parseN43 } from "@/lib/bank/n43"
import type { ParsedStatement, ParsedStatementLine } from "@/lib/bank/parse-types"
import {
  centsFromBigInt,
  daysBetween,
  isReconcilableAccount,
  signedAmountOf,
  type BankAccountRef,
  type BankLineRef,
  type BankMatchGroupRef,
  type BankStatementRef,
  type IgnoreReason,
  type LedgerCashLineRef,
  type MatchGroupKind,
  type PendingKind,
  type StatementFormat,
} from "@/lib/bank/types"
import type { TenantClient, TenantTransactionClient } from "@/lib/db"
import { tenantTransaction } from "@/lib/db"
import { fromUtcDate, toUtcDate } from "@/lib/ledger/dates"
import type { Cents, LocalDate } from "@/lib/ledger/types"
import { centsFromDb } from "@/lib/money"
import { writeAuditLog } from "@/models/audit-log"
import type { Prisma } from "@/prisma/client"

type AnyClient = TenantClient | TenantTransactionClient

export class BankModelError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "BankModelError"
    this.code = code
  }
}

const bankErr = (code: string, message: string): BankModelError => new BankModelError(code, message)

// ─────────────────────────────────────────────────────────────────────────────
// Cuentas bancarias
// ─────────────────────────────────────────────────────────────────────────────

export type BankAccountRow = BankAccountRef & {
  name: string
  iban: string | null
  bic: string | null
  isActive: boolean
  csvMapping: unknown
}

const toAccountRef = (row: {
  id: string
  organizationId: string
  code: string
  name: string
  accountCode: string
  currency: string
  iban: string | null
  bic: string | null
  reconciledFromDate: Date | null
  reconciledOpeningBalanceCents: bigint | null
  matchToleranceDays: number
  transitWarnDays: number
  isActive: boolean
  csvMapping: Prisma.JsonValue
}): BankAccountRow => ({
  id: row.id,
  organizationId: row.organizationId,
  code: row.code,
  name: row.name,
  accountCode: row.accountCode,
  currency: row.currency,
  iban: row.iban,
  bic: row.bic,
  reconciledFromDate: row.reconciledFromDate ? fromUtcDate(row.reconciledFromDate) : null,
  reconciledOpeningBalanceCents:
    row.reconciledOpeningBalanceCents === null ? null : centsFromBigInt(row.reconciledOpeningBalanceCents, "anclaje"),
  matchToleranceDays: row.matchToleranceDays,
  transitWarnDays: row.transitWarnDays,
  isActive: row.isActive,
  csvMapping: row.csvMapping,
})

export async function listBankAccounts(db: AnyClient, opts: { activeOnly?: boolean } = {}): Promise<BankAccountRow[]> {
  const rows = await db.bankAccount.findMany({
    where: opts.activeOnly ? { isActive: true } : {},
    orderBy: { code: "asc" },
  })
  return rows.map(toAccountRef)
}

export async function getBankAccount(db: AnyClient, id: string): Promise<BankAccountRow | null> {
  const row = await db.bankAccount.findFirst({ where: { id } })
  return row ? toAccountRef(row) : null
}

export type BankAccountInput = {
  code: string
  name: string
  accountCode: string
  currency?: string
  iban?: string | null
  bic?: string | null
  /** **El anclaje (O-1)**: fecha y saldo del extracto en esa fecha. */
  reconciledFromDate?: LocalDate | null
  reconciledOpeningBalanceCents?: Cents | null
  matchToleranceDays?: number
  transitWarnDays?: number
  csvMapping?: unknown
}

/** Saldo contable de una subcuenta (y sus hijas) hasta una fecha, en SQL. */
export async function ledgerBalanceOfAccount(
  tx: TenantTransactionClient,
  accountCode: string,
  cutoff: LocalDate
): Promise<Cents> {
  const rows = await tx.$queryRaw<{ saldo: bigint }[]>`
    SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0)::bigint AS saldo
      FROM journal_lines l
     WHERE l.organization_id = ${tx.$organizationId}::uuid
       AND (l.account_code = ${accountCode} OR l.account_code LIKE ${`${accountCode}%`})
       AND l.entry_date <= ${toUtcDate(cutoff)}::date
       AND l.entry_kind <> 'CLOSING'`
  return centsFromDb(rows[0]?.saldo ?? BigInt(0), "saldo contable")
}

/**
 * Alta de cuenta. **ADMIN.** El anclaje se coteja contra el saldo contable a esa
 * fecha y la diferencia se registra en el `AuditLog`: no se rechaza —puede haber
 * partidas en tránsito legítimas— pero queda escrita, que es lo que permite
 * discutirla después.
 */
export async function createBankAccount(
  organizationId: string,
  input: BankAccountInput,
  actor: { userId: string }
): Promise<{ account: BankAccountRow; anchorContrast: { ledgerCents: Cents; statementCents: Cents; diffCents: Cents } | null }> {
  if (!isReconcilableAccount(input.accountCode)) {
    throw bankErr(
      "BANK_ACCOUNT_NOT_RECONCILABLE",
      `La cuenta ${input.accountCode} no es conciliable: sólo 572, 573, 574 y 575 (o subcuentas suyas). ` +
        "La caja (570/571) no tiene extracto y no puede tenerlo"
    )
  }
  if ((input.reconciledFromDate ?? null) === null !== ((input.reconciledOpeningBalanceCents ?? null) === null)) {
    throw bankErr("BANK_ANCHOR_INCOMPLETE", "El anclaje son las dos cosas: fecha y saldo del extracto en esa fecha")
  }

  return await tenantTransaction(organizationId, actor.userId, async (tx) => {
    const account = await tx.ledgerAccount.findFirst({ where: { code: input.accountCode } })
    if (!account) throw bankErr("ACCOUNT_NOT_FOUND", `La cuenta ${input.accountCode} no existe en el plan de esta organización`)
    if (!account.isPostable) {
      throw bankErr(
        "ACCOUNT_NOT_POSTABLE",
        `La cuenta ${input.accountCode} no es postable: cada cuenta corriente es su propia subcuenta (5720001, 5720002…)`
      )
    }

    let anchorContrast: { ledgerCents: Cents; statementCents: Cents; diffCents: Cents } | null = null
    if (input.reconciledFromDate && input.reconciledOpeningBalanceCents !== null && input.reconciledOpeningBalanceCents !== undefined) {
      const ledgerCents = await ledgerBalanceOfAccount(tx, input.accountCode, input.reconciledFromDate)
      anchorContrast = {
        ledgerCents,
        statementCents: input.reconciledOpeningBalanceCents,
        diffCents: input.reconciledOpeningBalanceCents - ledgerCents,
      }
    }

    const row = await tx.bankAccount.create({
      data: {
        organizationId,
        code: input.code,
        name: input.name,
        accountCode: input.accountCode,
        currency: (input.currency ?? "EUR").toUpperCase(),
        iban: input.iban ?? null,
        bic: input.bic ?? null,
        reconciledFromDate: input.reconciledFromDate ? toUtcDate(input.reconciledFromDate) : null,
        reconciledOpeningBalanceCents:
          input.reconciledOpeningBalanceCents === null || input.reconciledOpeningBalanceCents === undefined
            ? null
            : BigInt(input.reconciledOpeningBalanceCents),
        ...(input.matchToleranceDays === undefined ? {} : { matchToleranceDays: input.matchToleranceDays }),
        ...(input.transitWarnDays === undefined ? {} : { transitWarnDays: input.transitWarnDays }),
        csvMapping: (input.csvMapping ?? null) as Prisma.InputJsonValue,
      },
    })

    await writeAuditLog(tx, {
      entity: "BankAccount",
      entityId: row.id,
      action: "create",
      after: { ...row, anchorContrast },
      userId: actor.userId,
    })
    return { account: toAccountRef(row), anchorContrast }
  })
}

/**
 * Modificación. **ADMIN.** El anclaje no se mueve sin motivo: cambiar
 * `reconciledFromDate` mueve el punto desde el que se afirma que la cuenta está
 * conciliada, y eso es una decisión de gobierno, no una preferencia.
 */
export async function updateBankAccount(
  organizationId: string,
  id: string,
  patch: Partial<Omit<BankAccountInput, "accountCode" | "code">> & { isActive?: boolean },
  actor: { userId: string },
  reason?: string
): Promise<BankAccountRow> {
  return await tenantTransaction(organizationId, actor.userId, async (tx) => {
    const before = await tx.bankAccount.findFirst({ where: { id } })
    if (!before) throw bankErr("BANK_ACCOUNT_NOT_FOUND", "La cuenta bancaria no existe en esta organización")
    const movesAnchor =
      patch.reconciledFromDate !== undefined &&
      (patch.reconciledFromDate === null ? before.reconciledFromDate !== null : true)
    if (movesAnchor && (reason ?? "").trim().length < 10) {
      throw bankErr("BANK_ANCHOR_REASON_REQUIRED", "Mover el anclaje de una cuenta exige un motivo de al menos 10 caracteres")
    }

    const after = await tx.bankAccount.update({
      where: { id },
      data: {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.iban === undefined ? {} : { iban: patch.iban }),
        ...(patch.bic === undefined ? {} : { bic: patch.bic }),
        ...(patch.matchToleranceDays === undefined ? {} : { matchToleranceDays: patch.matchToleranceDays }),
        ...(patch.transitWarnDays === undefined ? {} : { transitWarnDays: patch.transitWarnDays }),
        ...(patch.isActive === undefined ? {} : { isActive: patch.isActive }),
        ...(patch.csvMapping === undefined ? {} : { csvMapping: patch.csvMapping as Prisma.InputJsonValue }),
        ...(patch.reconciledFromDate === undefined
          ? {}
          : {
              reconciledFromDate: patch.reconciledFromDate ? toUtcDate(patch.reconciledFromDate) : null,
              reconciledOpeningBalanceCents:
                patch.reconciledOpeningBalanceCents === null || patch.reconciledOpeningBalanceCents === undefined
                  ? null
                  : BigInt(patch.reconciledOpeningBalanceCents),
            }),
      },
    })
    await writeAuditLog(tx, {
      entity: "BankAccount",
      entityId: id,
      action: "update",
      before,
      after,
      reason: reason ?? null,
      userId: actor.userId,
    })
    return toAccountRef(after)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Extractos
// ─────────────────────────────────────────────────────────────────────────────

const toStatementRef = (row: {
  id: string
  bankAccountId: string
  format: string
  fileSha256: string
  currency: string
  periodStart: Date
  periodEnd: Date
  openingBalanceCents: bigint
  closingBalanceCents: bigint
  declaredLineCount: number | null
  lineCount: number
}): BankStatementRef => ({
  id: row.id,
  bankAccountId: row.bankAccountId,
  format: row.format as StatementFormat,
  fileSha256: row.fileSha256,
  currency: row.currency,
  periodStart: fromUtcDate(row.periodStart),
  periodEnd: fromUtcDate(row.periodEnd),
  openingBalanceCents: centsFromBigInt(row.openingBalanceCents, "saldo inicial"),
  closingBalanceCents: centsFromBigInt(row.closingBalanceCents, "saldo final"),
  declaredLineCount: row.declaredLineCount,
  lineCount: row.lineCount,
})

export async function listStatements(db: AnyClient, filter: { bankAccountId?: string } = {}): Promise<BankStatementRef[]> {
  const rows = await db.bankStatement.findMany({
    where: filter.bankAccountId ? { bankAccountId: filter.bankAccountId } : {},
    orderBy: { periodStart: "asc" },
  })
  return rows.map(toStatementRef)
}

const toLineRef = (row: {
  id: string
  statementId: string
  bankAccountId: string
  lineNo: number
  operationDate: Date
  valueDate: Date
  amountCents: bigint
  currency: string
  originalCurrency: string | null
  originalAmountCents: bigint | null
  balanceCents: bigint | null
  description: string
  reference1: string | null
  reference2: string | null
  conceptCommon: string | null
  conceptOwn: string | null
  counterpartyName: string | null
  sha256: string
  status: string
  ignoreReason: string | null
  ignoreEvidenceId: string | null
  pendingKinds?: readonly { kind: string }[]
}): BankLineRef => ({
  id: row.id,
  statementId: row.statementId,
  bankAccountId: row.bankAccountId,
  lineNo: row.lineNo,
  operationDate: fromUtcDate(row.operationDate),
  valueDate: fromUtcDate(row.valueDate),
  amountCents: centsFromBigInt(row.amountCents, "importe del extracto"),
  currency: row.currency,
  originalCurrency: row.originalCurrency,
  originalAmountCents: row.originalAmountCents === null ? null : centsFromBigInt(row.originalAmountCents, "importe en divisa"),
  balanceCents: row.balanceCents === null ? null : centsFromBigInt(row.balanceCents, "saldo de la línea"),
  description: row.description,
  reference1: row.reference1,
  reference2: row.reference2,
  conceptCommon: row.conceptCommon,
  conceptOwn: row.conceptOwn,
  counterpartyName: row.counterpartyName,
  sha256: row.sha256,
  status: row.status as BankLineRef["status"],
  ignoreReason: row.ignoreReason as IgnoreReason | null,
  ignoreEvidenceId: row.ignoreEvidenceId,
  // **H-5**: el tipado del pendiente, declarado por una persona (O-8). Sin él,
  // `explainPending` sólo podía decir «sin tipar: nadie ha dicho qué es».
  pendingKind: (row.pendingKinds?.[0]?.kind as BankLineRef["pendingKind"]) ?? null,
})

export async function listStatementLines(
  db: AnyClient,
  filter: { bankAccountId?: string; statementId?: string; status?: BankLineRef["status"]; to?: LocalDate; take?: number }
): Promise<BankLineRef[]> {
  const rows = await db.bankStatementLine.findMany({
    where: {
      ...(filter.bankAccountId ? { bankAccountId: filter.bankAccountId } : {}),
      ...(filter.statementId ? { statementId: filter.statementId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.to ? { operationDate: { lte: toUtcDate(filter.to) } } : {}),
    },
    include: { pendingKinds: { select: { kind: true } } },
    orderBy: [{ operationDate: "asc" }, { lineNo: "asc" }],
    ...(filter.take ? { take: filter.take } : {}),
  })
  return rows.map(toLineRef)
}

export const listUnmatched = (db: AnyClient, bankAccountId: string, to?: LocalDate): Promise<BankLineRef[]> =>
  listStatementLines(db, { bankAccountId, status: "UNMATCHED", ...(to ? { to } : {}) })

export type ImportStatementInput = {
  bankAccountId: string
  fileName: string
  bytes: Uint8Array
  format: Extract<StatementFormat, "CSV" | "N43">
  /** Sólo CSV: el mapeo de columnas de ESTE banco. Norma 43 no lo usa. */
  mapping?: CsvMapping
  fileId?: string | null
}

export type ImportStatementResult = {
  statementId: string | null
  fileSha256: string
  /** Ya estaba importado: la segunda vez no crea ni una línea y lo dice (c7). */
  alreadyImported: boolean
  imported: number
  /** Líneas que ya existían en la cuenta (solape), declaradas una a una. */
  skipped: readonly { sha256: string; operationDate: LocalDate; amountCents: Cents; description: string }[]
  zeroAmount: number
  periodStart: LocalDate
  periodEnd: LocalDate
}

/** Comprobaciones que corren **ANTES de escribir** (§4.3): I-E7-5 e I-E7-6a. */
export function verifyParsedStatement(parsed: ParsedStatement, lines: readonly ParsedStatementLine[]): string[] {
  const problems: string[] = []
  const lineNos = lines.map((_, index) => index + 1)
  if (lineNos.length !== lines.length) problems.push("el fichero no tiene apuntes numerables")
  if (parsed.declaredLineCount !== null && parsed.declaredLineCount !== lines.length) {
    problems.push(
      `el registro 33 declara ${parsed.declaredLineCount} apuntes y el fichero trae ${lines.length}: se rechaza entero (I-E7-6a)`
    )
  }
  if (parsed.openingBalanceCents !== null && parsed.closingBalanceCents !== null) {
    const computed = parsed.openingBalanceCents + lines.reduce((a, l) => a + l.amountCents, 0)
    if (computed !== parsed.closingBalanceCents) {
      problems.push(
        `el extracto no cuadra consigo mismo: ${parsed.openingBalanceCents} + Σ = ${computed} ≠ ${parsed.closingBalanceCents} declarado (I-E7-6a)`
      )
    }
  }
  const currencies = new Set(lines.map((l) => l.currency))
  if (currencies.size > 1) problems.push(`el fichero mezcla divisas (${[...currencies].join(", ")}): se rechaza entero`)
  return problems
}

/**
 * Importa un extracto. **Idempotente por `fileSha256`** y por línea.
 *
 * **El solape (criterio 7).** Un fichero que repite 30 movimientos ya
 * importados no puede insertarlos otra vez —el `sha256` de línea es único por
 * cuenta—, así que se importan sólo los nuevos y el saldo inicial del extracto
 * se **ajusta con los importes de los repetidos del propio fichero**:
 * `apertura' = apertura + Σ(repetidos)`. No se inventa ninguna cifra: el
 * fichero cuadra consigo mismo (se comprueba ANTES de escribir sobre el fichero
 * COMPLETO), y de ahí sale que `apertura' + Σ(importados) = cierre declarado`,
 * que es justo lo que I-E7-6a compara. `declaredLineCount` se ajusta igual, y
 * los repetidos se declaran uno a uno en el resultado y en el `AuditLog`.
 */
export async function importStatement(
  organizationId: string,
  input: ImportStatementInput,
  actor: { userId: string }
): Promise<ImportStatementResult> {
  const fileSha256 = sha256OfBytes(input.bytes)
  const content = Buffer.from(input.bytes).toString("utf8")
  const parsedResult = input.format === "N43" ? parseN43(content) : parseBankCsv(content, requireMapping(input.mapping))

  if (parsedResult.statement === null || parsedResult.errors.length > 0) {
    const detail = parsedResult.errors.map((e) => `línea ${e.lineNo}: ${e.message}`).join(" · ")
    throw bankErr("STATEMENT_PARSE_FAILED", `El fichero no se puede importar y se rechaza entero. ${detail}`)
  }
  const parsed = parsedResult.statement
  const parsedLines = parsedResult.lines

  const problems = verifyParsedStatement(parsed, parsedLines)
  if (problems.length > 0) throw bankErr("STATEMENT_NOT_BALANCED", problems.join(" · "))

  // La forma canónica de la línea lleva el ORDINAL DEL DÍA: dos movimientos
  // idénticos el mismo día son dos líneas distintas y ninguna se pierde (c8).
  const withOrdinals = assignDayOrdinals(parsedLines)
  const hashed = withOrdinals.map((line, index) => ({
    ...line,
    lineNo: index + 1,
    sha256: bankLineSha256(line),
  }))

  return await tenantTransaction(organizationId, actor.userId, async (tx) => {
    const account = await tx.bankAccount.findFirst({ where: { id: input.bankAccountId } })
    if (!account) throw bankErr("BANK_ACCOUNT_NOT_FOUND", "La cuenta bancaria no existe en esta organización")
    if (!account.isActive) throw bankErr("BANK_ACCOUNT_INACTIVE", "La cuenta bancaria está desactivada")
    if (parsed.currency.toUpperCase() !== account.currency.toUpperCase()) {
      throw bankErr(
        "STATEMENT_CURRENCY_MISMATCH",
        `El extracto viene en ${parsed.currency} y la cuenta está declarada en ${account.currency}: se rechaza el fichero entero (O-5)`
      )
    }

    const existing = await tx.bankStatement.findFirst({
      where: { bankAccountId: input.bankAccountId, fileSha256 },
      select: { id: true, periodStart: true, periodEnd: true },
    })
    if (existing) {
      return {
        statementId: existing.id,
        fileSha256,
        alreadyImported: true,
        imported: 0,
        skipped: [],
        zeroAmount: 0,
        periodStart: fromUtcDate(existing.periodStart),
        periodEnd: fromUtcDate(existing.periodEnd),
      }
    }

    const known = await tx.bankStatementLine.findMany({
      where: { bankAccountId: input.bankAccountId, sha256: { in: hashed.map((l) => l.sha256) } },
      select: { sha256: true },
    })
    const knownSha = new Set(known.map((k) => k.sha256))
    const fresh = hashed.filter((l) => !knownSha.has(l.sha256))
    const repeated = hashed.filter((l) => knownSha.has(l.sha256))
    if (fresh.length === 0) {
      throw bankErr(
        "STATEMENT_FULLY_DUPLICATED",
        `Los ${hashed.length} apuntes del fichero ya estaban importados en esta cuenta: no se crea ninguna línea`
      )
    }

    /**
     * **H-7 de la auditoría.** El periodo del extracto es el que **declara el
     * banco** —registro 11 de la Norma 43, cabecera declarada del CSV—, no el
     * de su primer y su último movimiento. Un extracto mensual sin movimiento
     * el día 1 ni el día 31 se guardaba antes como 07-06…07-22 y la cadena de
     * I-E7-6b denunciaba un hueco 07-01…07-06 que el banco sí cubre; en una
     * cartera real I-E7-6b salía FAIL casi siempre, I-E7-1 quedaba en INFO y el
     * badge P6 no se concedía jamás.
     *
     * El periodo declarado se **ensancha** —nunca se recorta— hasta cubrir los
     * apuntes nuevos: si el banco declara un periodo que no contiene sus
     * propios movimientos, el hecho manda sobre la cabecera.
     */
    const min = (a: LocalDate, b: LocalDate): LocalDate => (a < b ? a : b)
    const max = (a: LocalDate, b: LocalDate): LocalDate => (a > b ? a : b)
    const firstMovement = fresh[0].operationDate
    const lastMovement = fresh[fresh.length - 1].operationDate
    const periodo = parsed.periodDeclared
      ? { start: min(parsed.periodStart, firstMovement), end: max(parsed.periodEnd, lastMovement) }
      : { start: firstMovement, end: lastMovement }

    const repeatedSum = repeated.reduce((a, l) => a + l.amountCents, 0)
    const openingCents = (parsed.openingBalanceCents ?? 0) + repeatedSum
    const closingCents = parsed.closingBalanceCents ?? openingCents + fresh.reduce((a, l) => a + l.amountCents, 0)

    const statement = await tx.bankStatement.create({
      data: {
        organizationId,
        bankAccountId: input.bankAccountId,
        format: input.format,
        fileSha256,
        fileName: input.fileName.slice(0, 255),
        fileId: input.fileId ?? null,
        currency: parsed.currency.toUpperCase(),
        periodStart: toUtcDate(periodo.start),
        periodEnd: toUtcDate(periodo.end),
        openingBalanceCents: BigInt(openingCents),
        closingBalanceCents: BigInt(closingCents),
        declaredLineCount: parsed.declaredLineCount === null ? null : parsed.declaredLineCount - repeated.length,
        lineCount: fresh.length,
        importedById: actor.userId,
      },
    })

    // `createMany` en un solo viaje: nada de un INSERT por apunte.
    await tx.bankStatementLine.createMany({
      data: fresh.map((line, index) => ({
        organizationId,
        statementId: statement.id,
        bankAccountId: input.bankAccountId,
        lineNo: index + 1,
        operationDate: toUtcDate(line.operationDate),
        valueDate: toUtcDate(line.valueDate),
        amountCents: BigInt(line.amountCents),
        currency: line.currency.toUpperCase(),
        originalCurrency: line.originalCurrency ?? null,
        originalAmountCents: line.originalAmountCents === null || line.originalAmountCents === undefined ? null : BigInt(line.originalAmountCents),
        balanceCents: line.balanceCents === null || line.balanceCents === undefined ? null : BigInt(line.balanceCents),
        description: line.description.slice(0, 512),
        reference1: line.reference1 ?? null,
        reference2: line.reference2 ?? null,
        conceptCommon: line.conceptCommon ?? null,
        conceptOwn: line.conceptOwn ?? null,
        counterpartyName: line.counterpartyName ?? null,
        sha256: line.sha256,
        // **m2**: el apunte de 0,00 € se importa y nace IGNORED con IMPORTE_CERO,
        // que es la única causa cuya evidencia es el propio importe.
        ...(line.amountCents === 0
          ? { status: "IGNORED" as const, ignoreReason: "IMPORTE_CERO" as const, ignoredAt: new Date() }
          : {}),
      })),
    })

    const zeroAmount = fresh.filter((l) => l.amountCents === 0).length
    await writeAuditLog(tx, {
      entity: "BankStatement",
      entityId: statement.id,
      action: "import",
      after: {
        fileSha256,
        fileName: input.fileName,
        format: input.format,
        imported: fresh.length,
        repetidos: repeated.map((l) => ({ sha256: l.sha256, operationDate: l.operationDate, amountCents: l.amountCents })),
        aperturaAjustada: openingCents,
        importeCero: zeroAmount,
      },
      userId: actor.userId,
    })

    return {
      statementId: statement.id,
      fileSha256,
      alreadyImported: false,
      imported: fresh.length,
      skipped: repeated.map((l) => ({
        sha256: l.sha256,
        operationDate: l.operationDate,
        amountCents: l.amountCents,
        description: l.description,
      })),
      zeroAmount,
      periodStart: periodo.start,
      periodEnd: periodo.end,
    }
  })
}

function requireMapping(mapping: CsvMapping | undefined): CsvMapping {
  if (!mapping) {
    throw bankErr(
      "CSV_MAPPING_REQUIRED",
      "Un CSV necesita el mapeo de columnas de su banco: sin él no se sabe qué columna es la fecha de operación ni cuál el importe"
    )
  }
  return mapping
}

// ─────────────────────────────────────────────────────────────────────────────
// Apuntes de 57x del diario (`listCashLines`) — agregado SQL, sin N+1
// ─────────────────────────────────────────────────────────────────────────────

type CashLineRow = {
  id: string
  entry_id: string
  entry_number: number
  entry_date: Date
  entry_kind: string
  fiscal_year_id: string
  line_no: number
  account_code: string
  debit_cents: bigint
  credit_cents: bigint
  original_currency: string | null
  original_amount_cents: bigint | null
  description: string | null
  source_id: string | null
  pending_kind: string | null
}

/**
 * Los apuntes de las 57x conciliables del periodo, en la forma que consume el
 * motor. Una sola consulta para TODAS las cuentas bancarias: el emparejamiento
 * por cuenta lo hace el motor en memoria (§3.5), no una consulta por cuenta.
 */
export async function listCashLines(
  db: TenantTransactionClient,
  filter: { accountCodes: readonly string[]; from?: LocalDate; to: LocalDate }
): Promise<LedgerCashLineRef[]> {
  if (filter.accountCodes.length === 0) return []
  const patterns = filter.accountCodes.map((code) => `${code}%`)
  const rows = await db.$queryRaw<CashLineRow[]>`
    SELECT l.id, l.entry_id, e.entry_number, l.entry_date, l.entry_kind, l.fiscal_year_id, l.line_no,
           l.account_code, l.debit_cents, l.credit_cents, l.original_currency, l.original_amount_cents,
           l.description, e.source_id, k.kind AS pending_kind
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.entry_id AND e.organization_id = l.organization_id
      LEFT JOIN bank_pending_kinds k
        ON k.organization_id = l.organization_id AND k.journal_line_id = l.id
     WHERE l.organization_id = ${db.$organizationId}::uuid
       AND l.account_code LIKE ANY(${patterns}::text[])
       AND l.entry_date <= ${toUtcDate(filter.to)}::date
       AND (${filter.from ? toUtcDate(filter.from) : null}::date IS NULL OR l.entry_date >= ${filter.from ? toUtcDate(filter.from) : null}::date)
     ORDER BY l.entry_date, e.entry_number, l.line_no`

  return rows.map((r) => ({
    id: r.id,
    organizationId: db.$organizationId,
    entryId: r.entry_id,
    entryNumber: r.entry_number,
    entryDate: fromUtcDate(r.entry_date),
    entryKind: r.entry_kind as LedgerCashLineRef["entryKind"],
    fiscalYearId: r.fiscal_year_id,
    lineNo: r.line_no,
    accountCode: r.account_code,
    debitCents: centsFromDb(r.debit_cents, "debe"),
    creditCents: centsFromDb(r.credit_cents, "haber"),
    // **H-1**: sin estas dos columnas una cuenta en divisa no se puede cuadrar
    // en su divisa (`original_amount_cents` es el importe SIN signo, ADR-0014 D2).
    originalCurrency: r.original_currency,
    originalAmountCents: r.original_amount_cents === null ? null : centsFromBigInt(r.original_amount_cents, "importe en divisa"),
    description: r.description,
    reference: r.source_id,
    pendingKind: (r.pending_kind as LedgerCashLineRef["pendingKind"]) ?? null,
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Grupos de conciliación (N-a-M)
// ─────────────────────────────────────────────────────────────────────────────

export async function listMatchGroups(
  db: AnyClient,
  filter: { bankAccountId?: string; liveOnly?: boolean } = {}
): Promise<BankMatchGroupRef[]> {
  const rows = await db.bankMatchGroup.findMany({
    where: {
      ...(filter.bankAccountId ? { bankAccountId: filter.bankAccountId } : {}),
      ...(filter.liveOnly ? { unmatchedAt: null } : {}),
    },
    include: { members: { select: { statementLineId: true, journalLineId: true, dateGapDays: true } } },
    orderBy: { createdAt: "asc" },
  })
  return rows.map((g) => ({
    id: g.id,
    organizationId: g.organizationId,
    bankAccountId: g.bankAccountId,
    kind: g.kind as MatchGroupKind,
    unmatchedAt: g.unmatchedAt ? g.unmatchedAt.toISOString() : null,
    members: g.members.map((m) => ({
      statementLineId: m.statementLineId,
      journalLineId: m.journalLineId,
      dateGapDays: m.dateGapDays,
    })),
  }))
}

export type CreateMatchGroupInput = {
  bankAccountId: string
  statementLineIds: readonly string[]
  journalLineIds: readonly string[]
  kind?: MatchGroupKind
  note?: string | null
  method?: "MANUAL" | "SUGGESTION_ACCEPTED"
  scoreBps?: number
}

/** El `kind` sale de la forma del grupo, no de lo que diga el cliente. */
export const kindOf = (lines: number, cash: number): MatchGroupKind =>
  lines === 1 && cash === 1 ? "SIMPLE" : lines > 1 && cash === 1 ? "N_A_1" : lines === 1 && cash > 1 ? "UNO_A_N" : "N_A_N"

/**
 * Concilia N líneas de extracto contra M apuntes de la 57x.
 *
 * **Revalida en servidor** (O-9), en este orden y con tolerancia 0: tenant ·
 * cuenta de cada apunte = la de la `BankAccount` · divisa · líneas y apuntes
 * libres · y **Σ líneas = Σ (debe − haber)** (I-E7-11, que con un grupo 1:1 es
 * exactamente I-E7-2). El `dateGapDays` lo sella la base al insertar (O-10).
 */
export async function createMatchGroup(
  tx: TenantTransactionClient,
  input: CreateMatchGroupInput,
  actor: { userId: string }
): Promise<{ groupId: string; kind: MatchGroupKind; sumCents: Cents }> {
  if (input.statementLineIds.length === 0 || input.journalLineIds.length === 0) {
    throw bankErr("MATCH_EMPTY", "Un grupo de conciliación necesita al menos una línea de extracto y un apunte")
  }
  if (new Set(input.statementLineIds).size !== input.statementLineIds.length) {
    throw bankErr("MATCH_DUPLICATE_LINE", "Una misma línea de extracto no puede entrar dos veces en el grupo")
  }
  if (new Set(input.journalLineIds).size !== input.journalLineIds.length) {
    throw bankErr("MATCH_DUPLICATE_JOURNAL_LINE", "Un mismo apunte no puede entrar dos veces en el grupo")
  }

  const account = await tx.bankAccount.findFirst({ where: { id: input.bankAccountId } })
  if (!account) throw bankErr("BANK_ACCOUNT_NOT_FOUND", "La cuenta bancaria no existe en esta organización")

  const lines = await tx.bankStatementLine.findMany({
    where: { id: { in: [...input.statementLineIds] } },
    select: { id: true, bankAccountId: true, amountCents: true, currency: true, status: true, operationDate: true },
  })
  if (lines.length !== input.statementLineIds.length) {
    throw bankErr("STATEMENT_LINE_NOT_FOUND", "Alguna línea de extracto no existe en esta organización")
  }
  for (const line of lines) {
    if (line.bankAccountId !== input.bankAccountId) {
      throw bankErr("STATEMENT_LINE_OTHER_ACCOUNT", `La línea ${line.id} es de otra cuenta bancaria`)
    }
    if (line.status === "IGNORED") {
      throw bankErr("STATEMENT_LINE_IGNORED", `La línea ${line.id} está ignorada: levanta antes el ignorado`)
    }
    if (line.currency.toUpperCase() !== account.currency.toUpperCase()) {
      throw bankErr("STATEMENT_LINE_CURRENCY", `La línea ${line.id} está en ${line.currency} y la cuenta en ${account.currency}`)
    }
  }

  const journalLines = await tx.journalLine.findMany({
    where: { id: { in: [...input.journalLineIds] } },
    select: {
      id: true,
      accountCode: true,
      debitCents: true,
      creditCents: true,
      entryDate: true,
      entryKind: true,
      originalCurrency: true,
      originalAmountCents: true,
    },
  })
  if (journalLines.length !== input.journalLineIds.length) {
    throw bankErr("JOURNAL_LINE_NOT_FOUND", "Algún apunte no existe en esta organización")
  }
  for (const jl of journalLines) {
    if (jl.accountCode !== account.accountCode) {
      throw bankErr(
        "JOURNAL_LINE_OTHER_ACCOUNT",
        `El apunte ${jl.id} es de la cuenta ${jl.accountCode} y esta cuenta bancaria puntea contra la ${account.accountCode}`
      )
    }
  }

  // Ninguno puede estar ya en un grupo VIVO (I-E7-3). La base lo impide con dos
  // índices únicos parciales; aquí se dice con un mensaje legible.
  const busy = await tx.bankReconciliation.findMany({
    where: {
      groupUnmatchedAt: null,
      OR: [{ statementLineId: { in: [...input.statementLineIds] } }, { journalLineId: { in: [...input.journalLineIds] } }],
    },
    select: { statementLineId: true, journalLineId: true },
  })
  if (busy.length > 0) {
    throw bankErr(
      "ALREADY_MATCHED",
      "Alguna línea o algún apunte ya está conciliado en un grupo vivo: otra persona lo concilió antes. Recarga la pantalla"
    )
  }

  /**
   * **H-1 · el grupo cuadra en la moneda de la CUENTA**, no en la base
   * (ADR-0015 D6.2). `debitCents`/`creditCents` están siempre en moneda base:
   * comparar el extracto en dólares contra el contravalor en euros hacía que una
   * cuenta en divisa sólo se pudiera conciliar a paridad 1:1, es decir, nunca.
   * En una cuenta en divisa la comparación se hace contra
   * `original_amount_cents` (`hashVersion = 3`), que es el importe SIN signo: el
   * signo lo da el lado del apunte, exactamente como en moneda base.
   */
  const organization = await tx.organization.findFirstOrThrow({ select: { baseCurrency: true } })
  const enDivisa = account.currency.toUpperCase() !== organization.baseCurrency.toUpperCase()
  const sumLines = lines.reduce((a, l) => a + centsFromDb(l.amountCents, "importe del extracto"), 0)
  const cashAmounts = journalLines.map((l) => {
    const base = signedAmountOf({
      debitCents: centsFromDb(l.debitCents, "debe"),
      creditCents: centsFromDb(l.creditCents, "haber"),
    })
    if (!enDivisa) return base
    if ((l.originalCurrency ?? "").toUpperCase() !== account.currency.toUpperCase() || l.originalAmountCents === null) {
      throw bankErr(
        "MATCH_CURRENCY_MISSING",
        `El apunte ${l.id} no lleva su importe en ${account.currency} (original_amount_cents) y la cuenta está en ${account.currency}: ` +
          "conciliar comparando el contravalor en moneda base sería cuadrar mezclando monedas (ADR-0015 D6.2)"
      )
    }
    const magnitude = centsFromDb(l.originalAmountCents, "importe en divisa")
    return base === 0 ? 0 : base < 0 ? -Math.abs(magnitude) : Math.abs(magnitude)
  })
  const sumCash = cashAmounts.reduce((a, b) => a + b, 0)
  if (sumLines !== sumCash) {
    throw bankErr(
      "MATCH_NOT_BALANCED",
      `El grupo no cuadra: Σ extracto ${sumLines} céntimos ≠ Σ (debe − haber) ${sumCash} céntimos ` +
        `en ${account.currency}. La conciliación es una igualdad con tolerancia 0 (I-E7-11/I-E7-2)`
    )
  }

  const kind = kindOf(lines.length, journalLines.length)
  const group = await tx.bankMatchGroup.create({
    data: {
      organizationId: tx.$organizationId,
      bankAccountId: input.bankAccountId,
      kind,
      note: input.note ?? null,
      createdById: actor.userId,
    },
  })

  /**
   * **La estrella** (M6). La pertenencia se escribe emparejando la línea pivote
   * con cada apunte y el apunte pivote con cada línea: cada línea y cada apunte
   * quedan **anclados exactamente una vez** en el grupo, que es sobre lo que
   * viven los dos índices únicos parciales de I-E7-3. El producto completo
   * N × M no aporta nada —el motor deduplica ids (`checkIE711`)— y crecería al
   * cuadrado.
   */
  const lineById = new Map(lines.map((l) => [l.id, l]))
  const cashById = new Map(journalLines.map((l) => [l.id, l]))
  const pivotLine = input.statementLineIds[0]
  const pivotCash = input.journalLineIds[0]
  const members: { statementLineId: string; journalLineId: string; lineAnchor: boolean; cashAnchor: boolean }[] = [
    { statementLineId: pivotLine, journalLineId: pivotCash, lineAnchor: true, cashAnchor: true },
    ...input.statementLineIds.slice(1).map((statementLineId) => ({
      statementLineId,
      journalLineId: pivotCash,
      lineAnchor: true,
      cashAnchor: false,
    })),
    ...input.journalLineIds.slice(1).map((journalLineId) => ({
      statementLineId: pivotLine,
      journalLineId,
      lineAnchor: false,
      cashAnchor: true,
    })),
  ]

  for (const member of members) {
    const line = lineById.get(member.statementLineId)
    const cash = cashById.get(member.journalLineId)
    if (!line || !cash) continue
    await tx.bankReconciliation.create({
      data: {
        organizationId: tx.$organizationId,
        groupId: group.id,
        statementLineId: member.statementLineId,
        journalLineId: member.journalLineId,
        lineAnchor: member.lineAnchor,
        cashAnchor: member.cashAnchor,
        method: input.method ?? "MANUAL",
        scoreBps: input.scoreBps ?? 0,
        dateGapDays: Math.abs(daysBetween(fromUtcDate(line.operationDate), fromUtcDate(cash.entryDate))),
        matchedById: actor.userId,
      },
    })
  }

  await tx.bankStatementLine.updateMany({
    where: { id: { in: [...input.statementLineIds] } },
    data: { status: "MATCHED" },
  })
  // H-5: lo conciliado ya no es una partida en tránsito.
  await clearPendingKinds(tx, { statementLineIds: input.statementLineIds, journalLineIds: input.journalLineIds })

  await writeAuditLog(tx, {
    entity: "BankMatchGroup",
    entityId: group.id,
    action: "MATCH",
    after: {
      kind,
      statementLineIds: input.statementLineIds,
      journalLineIds: input.journalLineIds,
      sumCents: sumLines,
      method: input.method ?? "MANUAL",
      scoreBps: input.scoreBps ?? 0,
    },
    userId: actor.userId,
  })

  return { groupId: group.id, kind, sumCents: sumLines }
}

/** Desconciliar es **del grupo**, con motivo ≥ 10 caracteres, y no borra nada. */
export async function unmatchGroup(
  tx: TenantTransactionClient,
  input: { groupId: string; reason: string },
  actor: { userId: string }
): Promise<{ groupId: string; statementLineIds: string[] }> {
  const reason = input.reason.trim()
  if (reason.length < 10) throw bankErr("UNMATCH_REASON_REQUIRED", "Desconciliar exige un motivo de al menos 10 caracteres")

  const group = await tx.bankMatchGroup.findFirst({
    where: { id: input.groupId },
    include: { members: { select: { statementLineId: true } } },
  })
  if (!group) throw bankErr("MATCH_GROUP_NOT_FOUND", "El grupo de conciliación no existe en esta organización")
  if (group.unmatchedAt !== null) throw bankErr("MATCH_GROUP_ALREADY_UNMATCHED", "Ese grupo ya estaba desconciliado")

  const after = await tx.bankMatchGroup.update({
    where: { id: input.groupId },
    data: { unmatchedAt: new Date(), unmatchedById: actor.userId, unmatchReason: reason },
  })
  const statementLineIds = [...new Set(group.members.map((m) => m.statementLineId))]
  await tx.bankStatementLine.updateMany({ where: { id: { in: statementLineIds } }, data: { status: "UNMATCHED" } })

  await writeAuditLog(tx, {
    entity: "BankMatchGroup",
    entityId: input.groupId,
    action: "UNMATCH",
    before: group,
    after,
    reason,
    userId: actor.userId,
  })
  return { groupId: input.groupId, statementLineIds }
}

/**
 * `IGNORED` con **vocabulario cerrado y evidencia** (O-4). Una comisión que
 * nadie contabilizó **no es ignorable**: se contabiliza (§4.4). La evidencia se
 * comprueba aquí y otra vez en la base.
 */
export async function ignoreLine(
  tx: TenantTransactionClient,
  input: { id: string; reason: IgnoreReason; evidenceId?: string | null },
  actor: { userId: string }
): Promise<void> {
  const line = await tx.bankStatementLine.findFirst({ where: { id: input.id } })
  if (!line) throw bankErr("STATEMENT_LINE_NOT_FOUND", "La línea de extracto no existe en esta organización")
  if (line.status === "MATCHED") {
    throw bankErr("STATEMENT_LINE_MATCHED", "Una línea conciliada no se ignora: desconcilia el grupo primero")
  }
  if (input.reason === "IMPORTE_CERO" && centsFromDb(line.amountCents, "importe") !== 0) {
    throw bankErr("IGNORE_ZERO_ONLY", "`IMPORTE_CERO` sólo vale para un apunte de 0,00 €")
  }
  if (
    (input.reason === "ERROR_BANCO_REVERSADO" || input.reason === "YA_CONTABILIZADO_EN_OTRA_CUENTA") &&
    !input.evidenceId
  ) {
    throw bankErr(
      "IGNORE_EVIDENCE_REQUIRED",
      input.reason === "ERROR_BANCO_REVERSADO"
        ? "`ERROR_BANCO_REVERSADO` exige la línea de extracto que lo revierte"
        : "`YA_CONTABILIZADO_EN_OTRA_CUENTA` exige el apunte concreto que lo recoge"
    )
  }

  const after = await tx.bankStatementLine.update({
    where: { id: input.id },
    data: {
      status: "IGNORED",
      ignoreReason: input.reason,
      ignoreEvidenceId: input.evidenceId ?? null,
      ignoredById: actor.userId,
      ignoredAt: new Date(),
    },
  })
  // H-5: lo ignorado tampoco es una partida en tránsito.
  await clearPendingKinds(tx, { statementLineIds: [input.id] })
  await writeAuditLog(tx, {
    entity: "BankStatementLine",
    entityId: input.id,
    action: "IGNORE_LINE",
    before: line,
    after,
    reason: input.reason,
    userId: actor.userId,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// El TIPADO de un pendiente (O-8, H-5)
// ─────────────────────────────────────────────────────────────────────────────

export type TypePendingInput = {
  bankAccountId: string
  side: "BANCO" | "LIBROS"
  /** Id de la línea de extracto (`BANCO`) o del apunte de 57x (`LIBROS`). */
  id: string
  /** `null` **destipa**: alguien se equivocó y lo retira. */
  kind: PendingKind | null
  note?: string | null
}

/**
 * Declara —o retira— el tipo de una partida en tránsito. **Lo declara una
 * persona**: el motor no lo deduce de un texto (eso sería auto-punteo por
 * patrón, E12); lo que hace el motor es **envejecerlo** y decidir con él si el
 * pendiente está explicado (§3.6, criterio 3).
 *
 * Sólo se puede tipar lo que está pendiente: una línea conciliada o ignorada ya
 * no es una partida en tránsito y tiparla sería describir algo que no existe.
 */
export async function typePending(
  tx: TenantTransactionClient,
  input: TypePendingInput,
  actor: { userId: string }
): Promise<{ id: string; kind: PendingKind | null }> {
  const account = await tx.bankAccount.findFirst({ where: { id: input.bankAccountId } })
  if (!account) throw bankErr("BANK_ACCOUNT_NOT_FOUND", "La cuenta bancaria no existe en esta organización")

  const where =
    input.side === "BANCO"
      ? { statementLineId: input.id }
      : { journalLineId: input.id }

  if (input.side === "BANCO") {
    const line = await tx.bankStatementLine.findFirst({ where: { id: input.id }, select: { id: true, status: true, bankAccountId: true } })
    if (!line) throw bankErr("STATEMENT_LINE_NOT_FOUND", "La línea de extracto no existe en esta organización")
    if (line.bankAccountId !== input.bankAccountId) {
      throw bankErr("STATEMENT_LINE_OTHER_ACCOUNT", `La línea ${input.id} es de otra cuenta bancaria`)
    }
    if (line.status !== "UNMATCHED" && input.kind !== null) {
      throw bankErr("PENDING_NOT_PENDING", "Sólo se tipa lo que está pendiente: esa línea ya está conciliada o ignorada")
    }
  } else {
    const cash = await tx.journalLine.findFirst({ where: { id: input.id }, select: { id: true, accountCode: true } })
    if (!cash) throw bankErr("JOURNAL_LINE_NOT_FOUND", "El apunte no existe en esta organización")
    if (cash.accountCode !== account.accountCode) {
      throw bankErr(
        "JOURNAL_LINE_OTHER_ACCOUNT",
        `El apunte ${input.id} es de la cuenta ${cash.accountCode} y esta cuenta bancaria puntea contra la ${account.accountCode}`
      )
    }
    const live = await tx.bankReconciliation.findFirst({ where: { journalLineId: input.id, groupUnmatchedAt: null } })
    if (live && input.kind !== null) {
      throw bankErr("PENDING_NOT_PENDING", "Sólo se tipa lo que está pendiente: ese apunte ya está conciliado")
    }
  }

  const existing = await tx.bankPendingKind.findFirst({ where })
  if (input.kind === null) {
    if (existing) await tx.bankPendingKind.delete({ where: { id: existing.id } })
  } else if (existing) {
    await tx.bankPendingKind.update({
      where: { id: existing.id },
      data: { kind: input.kind, note: input.note ?? null, declaredById: actor.userId, declaredAt: new Date() },
    })
  } else {
    await tx.bankPendingKind.create({
      data: {
        organizationId: tx.$organizationId,
        bankAccountId: input.bankAccountId,
        ...(input.side === "BANCO" ? { statementLineId: input.id } : { journalLineId: input.id }),
        kind: input.kind,
        note: input.note ?? null,
        declaredById: actor.userId,
      },
    })
  }

  await writeAuditLog(tx, {
    entity: input.side === "BANCO" ? "BankStatementLine" : "JournalLine",
    entityId: input.id,
    action: "TYPE_PENDING",
    before: existing ? { kind: existing.kind } : null,
    after: { kind: input.kind, note: input.note ?? null },
    userId: actor.userId,
  })
  return { id: input.id, kind: input.kind }
}

/**
 * **Un pendiente que deja de serlo deja de estar tipado.** Se llama al conciliar
 * y al ignorar: un tipado huérfano haría que `explainPending` explicara algo que
 * ya no existe, y el badge P6 se concedería sobre una descripción caducada.
 */
async function clearPendingKinds(
  tx: TenantTransactionClient,
  ids: { statementLineIds?: readonly string[]; journalLineIds?: readonly string[] }
): Promise<void> {
  const or: { statementLineId?: { in: string[] }; journalLineId?: { in: string[] } }[] = []
  if (ids.statementLineIds && ids.statementLineIds.length > 0) or.push({ statementLineId: { in: [...ids.statementLineIds] } })
  if (ids.journalLineIds && ids.journalLineIds.length > 0) or.push({ journalLineId: { in: [...ids.journalLineIds] } })
  if (or.length === 0) return
  await tx.bankPendingKind.deleteMany({ where: { OR: or } })
}

// ─────────────────────────────────────────────────────────────────────────────
// Lectura compuesta: el bloque de conciliación del barrido y el panel
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Todo lo que I-E7-1/2/3/5/6a/6b/11/12/13 necesitan, leído **en serie** y sin
 * N+1: cuatro consultas para toda la organización, no cuatro por cuenta.
 */
type FxRow = {
  bank_account_id: string
  rate_micro: bigint | null
  base_balance_cents: bigint
  recognized_cents: bigint
}

/**
 * **H-3 · el cierre en divisa de cada cuenta**, para que I-E7-12 pueda medir de
 * verdad la diferencia de cambio (NRV 11ª.2.2). Sin esto, `BankInvariantInput.fx`
 * no lo rellenaba nadie, I-E7-12 salía siempre `INFO · sin tasa de cierre`, el
 * panel enseñaba `null` y el motivo de sello `DIFERENCIA_DE_CAMBIO_SIN_RECONOCER`
 * era inalcanzable.
 *
 * Tres cifras por cuenta, en **una sola consulta** para todas:
 *
 *  · `rateMicro`: la **última tasa publicada hasta el corte** para
 *    `divisa → base` (`exchange_rates`). Sin tasa no hay medición: la cuenta
 *    sale del bloque y I-E7-12 lo dice.
 *  · `baseBalanceCents`: Σ contravalores históricos en moneda base de los
 *    apuntes de la 57x hasta el corte, `kind ∉ {CLOSING}` — la misma exclusión
 *    que `B`.
 *  · `recognizedDifferenceCents`: lo ya reconocido en **768/668** por asientos
 *    que tocan ESA 57x. Es la única atribución posible desde el diario: una
 *    diferencia de cambio de una cuenta bancaria se contabiliza contra ella.
 */
async function readFxCloses(
  tx: TenantTransactionClient,
  accounts: readonly BankAccountRef[],
  opts: { cutoff: LocalDate; baseCurrency: string }
): Promise<FxCloseRef[]> {
  const foreign = accounts.filter((a) => a.currency.toUpperCase() !== opts.baseCurrency.toUpperCase())
  if (foreign.length === 0) return []
  const ids = foreign.map((a) => a.id)
  const codes = foreign.map((a) => `${a.accountCode}%`)
  const currencies = foreign.map((a) => a.currency.toUpperCase())

  const rows = await tx.$queryRaw<FxRow[]>`
    WITH cuentas AS (
      SELECT * FROM unnest(${ids}::uuid[], ${codes}::text[], ${currencies}::text[])
        AS t(bank_account_id, code_pattern, currency)
    )
    SELECT c.bank_account_id,
           (SELECT r.rate_micro FROM exchange_rates r
             WHERE r."from" = c.currency AND r."to" = ${opts.baseCurrency.toUpperCase()}
               AND r.date <= ${toUtcDate(opts.cutoff)}::date
             ORDER BY r.date DESC LIMIT 1) AS rate_micro,
           COALESCE((SELECT SUM(l.debit_cents - l.credit_cents) FROM journal_lines l
                      WHERE l.organization_id = ${tx.$organizationId}::uuid
                        AND l.account_code LIKE c.code_pattern
                        AND l.entry_date <= ${toUtcDate(opts.cutoff)}::date
                        AND l.entry_kind <> 'CLOSING'), 0)::bigint AS base_balance_cents,
           COALESCE((SELECT SUM(d.credit_cents - d.debit_cents) FROM journal_lines d
                      WHERE d.organization_id = ${tx.$organizationId}::uuid
                        AND (left(d.account_code, 3) = '768' OR left(d.account_code, 3) = '668')
                        AND d.entry_date <= ${toUtcDate(opts.cutoff)}::date
                        AND d.entry_kind <> 'CLOSING'
                        AND EXISTS (SELECT 1 FROM journal_lines b
                                     WHERE b.organization_id = d.organization_id
                                       AND b.entry_id = d.entry_id
                                       AND b.account_code LIKE c.code_pattern)), 0)::bigint AS recognized_cents
      FROM cuentas c`

  return rows
    .filter((r) => r.rate_micro !== null)
    .map((r) => ({
      bankAccountId: r.bank_account_id,
      closingDate: opts.cutoff,
      rateMicro: r.rate_micro as bigint,
      baseBalanceCents: centsFromDb(r.base_balance_cents, "contravalor histórico"),
      recognizedDifferenceCents: centsFromDb(r.recognized_cents, "diferencia de cambio reconocida"),
    }))
}

export async function readBankInvariantInput(
  tx: TenantTransactionClient,
  opts: { cutoff: LocalDate; baseCurrency: string; isFiscalYearEnd?: boolean }
): Promise<BankInvariantInput | null> {
  const accounts = await listBankAccounts(tx, { activeOnly: true })
  if (accounts.length === 0) return null
  const statements = await listStatements(tx)
  const lines = await listStatementLines(tx, {})
  const groups = await listMatchGroups(tx)
  const cashLines = await listCashLines(tx, {
    accountCodes: [...new Set(accounts.map((a) => a.accountCode))],
    to: opts.cutoff,
  })
  const fx = await readFxCloses(tx, accounts, opts)
  return {
    organizationId: tx.$organizationId,
    cutoff: opts.cutoff,
    baseCurrency: opts.baseCurrency,
    accounts,
    statements,
    lines,
    groups,
    cashLines,
    ...(fx.length > 0 ? { fx } : {}),
    ...(opts.isFiscalYearEnd ? { isFiscalYearEnd: true } : {}),
  }
}

/**
 * El cuadre de cada cuenta con sus **pendientes tipados y envejecidos** (O-8) y
 * su línea propia de ignorados (O-12). Es la misma derivación que usa I-E7-1: no
 * hay una segunda (§3.5).
 */
export async function pendingItems(
  tx: TenantTransactionClient,
  opts: { cutoff: LocalDate; baseCurrency: string; bankAccountId?: string }
): Promise<BankReconciliationSummary[]> {
  const input = await readBankInvariantInput(tx, opts)
  if (input === null) return []
  const accounts = opts.bankAccountId ? input.accounts.filter((a) => a.id === opts.bankAccountId) : input.accounts
  return accounts.map((account) => reconciliationSummary(account, input))
}

/**
 * Sugerencias deterministas para una cuenta. **Se recomputan en servidor** cada
 * vez: una sugerencia es un cálculo sobre el estado de hoy, no un hecho, y por
 * eso `SUGGESTED` no se persiste (§2.2).
 */
export async function suggestionsForAccount(
  tx: TenantTransactionClient,
  opts: { bankAccountId: string; cutoff: LocalDate }
): Promise<readonly MatchSuggestionRow[]> {
  const account = await getBankAccount(tx, opts.bankAccountId)
  if (!account) throw bankErr("BANK_ACCOUNT_NOT_FOUND", "La cuenta bancaria no existe en esta organización")
  const lines = (await listStatementLines(tx, { bankAccountId: account.id, to: opts.cutoff })).filter(
    (l) => l.status === "UNMATCHED"
  )
  const cashLines = await listCashLines(tx, { accountCodes: [account.accountCode], to: opts.cutoff })
  const groups = await listMatchGroups(tx, { bankAccountId: account.id, liveOnly: true })
  const matchedCash = new Set(groups.flatMap((g) => g.members.map((m) => m.journalLineId)))
  const free = cashLines.filter((l) => !matchedCash.has(l.id) && l.entryKind !== "CLOSING")
  const suggestions = suggestMatches(lines, free, { toleranceDays: account.matchToleranceDays })
  return suggestionRows(suggestions)
}

/** Identificador de lote para el `AuditLog` de una aceptación múltiple. */
export const suggestionBatchId = (): string => randomUUID()
