/**
 * E7 · T23 — Propuesta de asiento desde un movimiento del extracto (§4.4, O-4).
 *
 * Una comisión de 3,50 € que nadie contabilizó **existe en el banco y no existe
 * en los libros**. Ignorarla no la concilia: la esconde y deja la 572
 * permanentemente corta sin que ningún check lo diga (R5). El camino es el
 * humano de siempre:
 *
 * ```
 * línea UNMATCHED → propuesta precargada → previewFromProposal (SIN TOCAR)
 *   → confirmación de una persona → postFromProposal (SIN TOCAR)
 *     → asiento con sourceType BANK_RECONCILIATION + conciliación,
 *        en la MISMA transacción
 * ```
 *
 * Tres decisiones que conviene tener escritas:
 *
 *  1. **`postFromProposal` no se modifica** (§3.7). Lo que decide el origen del
 *     asiento es quien lo postea: el borrador que devuelve el motor se sella
 *     aquí con `sourceType = BANK_RECONCILIATION` y `sourceId =
 *     statementLineId`. Un segundo camino de posteo sería una segunda verdad.
 *  2. **La contrapartida es la subcuenta de ESTA cuenta bancaria**, no la
 *     `BANCO_DEFAULT` genérica del mapa: la propuesta nace de un movimiento de
 *     una cuenta concreta y conciliarla contra otra 572 sería un descuadre
 *     garantizado. El mapa se sobreescribe **sólo para esa clave y sólo para
 *     esta propuesta**.
 *  3. **Bloqueo por IVA (art. 20.Uno.18º LIVA).** Los servicios financieros
 *     están exentos y la propuesta sale sin cuota. Si la cuenta elegida tiene
 *     un tipo de IVA soportado asociado en la configuración de la organización
 *     —el caso de la gestión de cobro de efectos, letra h—, la propuesta se
 *     **bloquea** y se remite al camino documental.
 */

import { EXPENSE_PROPOSAL_KEYS, proposalFromStatementLine, type ProposalAccountKey } from "@/lib/bank/proposal"
import { reconcile } from "@/lib/extraction/reconcile"
import { postFromProposal, previewFromProposal, type PostedProposal } from "@/lib/ledger/postFromProposal"
import type { TenantTransactionClient } from "@/lib/db"
import { fromUtcDate } from "@/lib/ledger/dates"
import type { LocalDate } from "@/lib/ledger/types"
import { centsFromDb } from "@/lib/money"
import { getAccountMapByKey } from "@/models/account-map"
import { writeAuditLog } from "@/models/audit-log"
import { createMatchGroup } from "@/models/bank"
import { getLedgerContext, postEntryTx } from "@/models/ledger"
import { buildReconcileContext } from "@/models/reconcile-context"
import type { Organization } from "@/prisma/client"

export class ProposalFromLineError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "ProposalFromLineError"
    this.code = code
  }
}

const fail = (code: string, message: string): never => {
  throw new ProposalFromLineError(code, message)
}

export type ProposeFromLineInput = {
  statementLineId: string
  accountKey: ProposalAccountKey
  description?: string
  refDate: LocalDate
}

export type ProposalPreviewFromLine = {
  statementLineId: string
  accountKey: ProposalAccountKey
  accountCode: string
  bankAccountCode: string
  amountCents: number
  operationDate: LocalDate
  /** El borrador tal cual lo devuelve el motor, sin retocar una línea. */
  draft: PostedProposal | null
  error: { code: string; message: string } | null
}

/**
 * Prepara la propuesta y la previsualiza. **No escribe nada.**
 */
export async function previewEntryFromLine(
  tx: TenantTransactionClient,
  organization: Organization,
  input: ProposeFromLineInput
): Promise<ProposalPreviewFromLine> {
  const prepared = await prepare(tx, organization, input)
  const draft = previewFromProposal(prepared.reconciled, prepared.ledgerContext)
  return {
    statementLineId: input.statementLineId,
    accountKey: input.accountKey,
    accountCode: prepared.accountCode,
    bankAccountCode: prepared.bankAccountCode,
    amountCents: prepared.amountCents,
    operationDate: prepared.operationDate,
    draft: draft.ok ? draft.value : null,
    error: draft.ok ? null : { code: draft.errors[0].code, message: draft.errors[0].message },
  }
}

/**
 * Confirma: postea el asiento **y** lo concilia con la línea **en la misma
 * transacción**. O las dos cosas o ninguna: un asiento sin conciliar dejaría el
 * movimiento pendiente para siempre y la 572 descuadrada en la pantalla que
 * acaba de resolverla.
 */
export async function confirmEntryFromLine(
  tx: TenantTransactionClient,
  organization: Organization,
  input: ProposeFromLineInput & { idempotencyKey?: string },
  actor: { userId: string }
): Promise<{ entryId: string; entryNumber: number; groupId: string }> {
  const prepared = await prepare(tx, organization, input)
  const posted = postFromProposal(prepared.reconciled, prepared.ledgerContext)
  if (!posted.ok) {
    return fail(posted.errors[0].code, posted.errors[0].message)
  }

  const entry = await postEntryTx(
    tx,
    {
      ...posted.value.draft,
      // El origen lo pone quien postea, no el motor documental (§3.7).
      sourceType: "BANK_RECONCILIATION",
      sourceId: input.statementLineId,
    },
    { userId: actor.userId },
    { idempotencyKey: input.idempotencyKey ?? `bank-line:${input.statementLineId}` }
  )

  // La línea del asiento contra la que se concilia es la de la 57x de ESTA
  // cuenta: la busca por cuenta, no por posición en la plantilla.
  const cashLine = entry.lines.find((l) => l.accountCode === prepared.bankAccountCode && l.id !== undefined)
  if (!cashLine || cashLine.id === undefined) {
    return fail(
      "BANK_LINE_NOT_IN_ENTRY",
      `El asiento propuesto no tiene ninguna línea contra ${prepared.bankAccountCode}: no se puede conciliar`
    )
  }

  const group = await createMatchGroup(
    tx,
    {
      bankAccountId: prepared.bankAccountId,
      statementLineIds: [input.statementLineId],
      journalLineIds: [cashLine.id],
      method: "MANUAL",
    },
    actor
  )

  await writeAuditLog(tx, {
    entity: "BankStatementLine",
    entityId: input.statementLineId,
    action: "PROPOSE_ENTRY_FROM_LINE",
    after: {
      entryId: entry.id,
      entryNumber: entry.entryNumber,
      accountKey: input.accountKey,
      accountCode: prepared.accountCode,
      groupId: group.groupId,
      amountCents: prepared.amountCents,
      ivaExento: "art. 20.Uno.18º LIVA",
    },
    userId: actor.userId,
  })

  return { entryId: entry.id, entryNumber: entry.entryNumber, groupId: group.groupId }
}

// ─────────────────────────────────────────────────────────────────────────────
// Preparación común: cuenta del mapa, bloqueo por IVA y contexto
// ─────────────────────────────────────────────────────────────────────────────

async function prepare(
  tx: TenantTransactionClient,
  organization: Organization,
  input: ProposeFromLineInput
) {
  const line = await tx.bankStatementLine.findFirst({ where: { id: input.statementLineId } })
  if (!line) return fail("STATEMENT_LINE_NOT_FOUND", "La línea de extracto no existe en esta organización")
  if (line.status !== "UNMATCHED") {
    return fail(
      "STATEMENT_LINE_NOT_UNMATCHED",
      "Sólo se propone asiento para un movimiento sin conciliar: éste ya está conciliado o ignorado"
    )
  }
  const bankAccount = await tx.bankAccount.findFirst({ where: { id: line.bankAccountId } })
  if (!bankAccount) return fail("BANK_ACCOUNT_NOT_FOUND", "La cuenta bancaria del movimiento no existe")

  if (!EXPENSE_PROPOSAL_KEYS.includes(input.accountKey)) {
    return fail(
      "PROPOSAL_KEY_NOT_EXPENSE",
      "Desde el extracto sólo se propone un GASTO financiero exento (626, 662, 669, 665 o 668). " +
        "El reconocimiento de la diferencia de cambio positiva (768) al cierre es E9"
    )
  }

  const map = await getAccountMapByKey(tx)
  const accountCode = map.get(input.accountKey)
  if (!accountCode) {
    return fail(
      "ACCOUNT_KEY_NOT_MAPPED",
      `La organización no tiene mapeada la clave ${input.accountKey}: mapéala en Configuración → Cuentas. ` +
        "La cuenta de una propuesta sale SIEMPRE del mapa, nunca del código ni del texto del movimiento"
    )
  }

  // **Bloqueo del art. 20.Uno.18º**: si la cuenta elegida tiene un tipo de IVA
  // soportado asociado, no es un servicio financiero exento (gestión de cobro de
  // efectos, cajas de seguridad, custodia) y su documento es una factura.
  const withVat = await tx.taxRate.findFirst({
    where: {
      isActive: true,
      kind: "IVA",
      appliesTo: { in: ["PURCHASE", "BOTH"] },
      OR: [{ counterAccountCode: accountCode }, { accountCode }],
    },
    select: { code: true },
  })
  if (withVat) {
    return fail(
      "PROPOSAL_ACCOUNT_HAS_INPUT_VAT",
      `La cuenta ${accountCode} lleva IVA soportado asociado (${withVat.code}). Los servicios financieros están exentos ` +
        "(art. 20.Uno.18º LIVA), pero la gestión de cobro de efectos, las cajas de seguridad y la custodia están sujetas y no exentas: " +
        "llegan con factura y se contabilizan por el camino documental"
    )
  }

  // El tipo EXENTO del art. 20 vigente en la organización. Si no lo tiene
  // configurado, la propuesta NO se emite: la fiscalidad sale de la
  // configuración, nunca de una constante del código.
  const exempt = await tx.taxRate.findFirst({
    where: { isActive: true, kind: "EXENTO", appliesTo: { in: ["PURCHASE", "BOTH"] }, code: { contains: "20" } },
    orderBy: { validFrom: "desc" },
    select: { code: true },
  })
  if (!exempt) {
    return fail(
      "EXEMPT_RATE_NOT_CONFIGURED",
      "La organización no tiene configurado un tipo EXENTO del art. 20: sin él no se puede anotar una comisión bancaria " +
        "como operación exenta (art. 20.Uno.18º LIVA)"
    )
  }

  // La contraparte es el BANCO, y sale del maestro: la identificación fiscal de
  // un gasto no se inventa (RC-11). Se resuelve por el `iban`/`code` de la
  // cuenta bancaria si está enlazada, y si no, se exige que exista en el maestro.
  const counterparty = await tx.counterparty.findFirst({
    where: { name: { equals: bankAccount.name, mode: "insensitive" } },
    select: { id: true, name: true, taxId: true },
  })
  if (!counterparty) {
    return fail(
      "BANK_COUNTERPARTY_NOT_IN_MASTER",
      `El banco «${bankAccount.name}» no está en el maestro de contrapartes: da de alta la entidad con su NIF y vuelve a proponer. ` +
        "Un gasto sin identificación del expedidor no se contabiliza a ciegas (RC-11)"
    )
  }

  const amountCents = centsFromDb(line.amountCents, "importe del extracto")
  const built = proposalFromStatementLine({
    exemptTaxRateCode: exempt.code,
    counterparty: { id: counterparty.id, name: counterparty.name, taxId: counterparty.taxId },
    lineSha256: line.sha256,
    line: {
      id: line.id,
      amountCents,
      operationDate: fromUtcDate(line.operationDate),
      description: line.description,
      currency: line.currency,
      counterpartyName: line.counterpartyName,
    },
    accountCode,
    accountKey: input.accountKey,
    ...(input.description ? { description: input.description } : {}),
  })
  if (!built.ok) return fail(built.error.code, built.error.message)

  const reconcileContext = await buildReconcileContext(
    tx,
    organization,
    {
      proposal: built.proposal,
      // No hay extracción ni modelo: es una propuesta MANUAL, completa, hecha
      // por una persona sobre un movimiento que el banco declaró.
      run: { kind: "MANUAL", partial: false, pagesSent: 0, pagesTotal: 0, fileSha256: line.sha256, rawOutput: null, fieldOrigins: null },
      // El «documento» de esta propuesta es la propia línea del extracto: su
      // sha256 canónico ya está sellado en `bank_statement_lines` y es lo que
      // RC-10 compara consigo mismo (no hay PDF que se pueda alterar aparte).
      file: { id: line.id, sha256: line.sha256 },
      // Un movimiento bancario no tiene número de documento: la detección de
      // duplicados documentales no aplica y daría un falso positivo por vacío.
    },
    { refDate: input.refDate, skipDuplicateCheck: true }
  )
  const reconciled = reconcile(built.proposal, {
    ...reconcileContext,
    // La contrapartida de tesorería es la subcuenta de ESTA cuenta bancaria.
    accountMap: { ...reconcileContext.accountMap, BANCO_DEFAULT: bankAccount.accountCode },
  })
  const ledgerContextRaw = await getLedgerContext(tx, input.refDate)
  const ledgerContext = {
    ...ledgerContextRaw,
    map: (key: Parameters<typeof ledgerContextRaw.map>[0]) =>
      key === "BANCO_DEFAULT" ? bankAccount.accountCode : ledgerContextRaw.map(key),
  }

  return {
    reconciled,
    ledgerContext,
    accountCode,
    bankAccountId: bankAccount.id,
    bankAccountCode: bankAccount.accountCode,
    amountCents,
    operationDate: fromUtcDate(line.operationDate),
  }
}
