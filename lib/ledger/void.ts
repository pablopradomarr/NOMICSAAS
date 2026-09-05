/**
 * E3 · T4 — Anulación por contra-asiento (T-21). Módulo PURO.
 *
 * El contra-asiento es el **espejo exacto**: copia cada línea e invierte sus
 * columnas, conservando `lineNo`, cuenta, destinos, `taxRateId` y `taxBaseCents`.
 * NO recalcula nada — recalcular con los tipos de hoy produciría un asiento que
 * no compensa al original (ADR-0003, I-E3-1).
 */

import { resolveReversalDate } from "@/lib/ledger/dates"
import { checkDraft } from "@/lib/ledger/post"
import {
  EntryDraft,
  err,
  fail,
  LedgerContext,
  LedgerError,
  LocalDate,
  PostedEntry,
  ResolvedLine,
  Result,
} from "@/lib/ledger/types"

export type VoidOptions = {
  reason: string
  /** Solo puede RETRASAR la fecha calculada, nunca adelantarla (§2.5). */
  requestedDate?: LocalDate | null
  /** Contra-asientos que ya existen sobre este asiento (CA-3). */
  existingReversals?: readonly { id: string }[]
}

const MIN_REASON = 10

/** Los kind de sistema no se anulan: se deshacen reabriendo el ejercicio (CA-1). */
const NON_REVERSIBLE_KINDS = new Set(["OPENING", "CLOSING", "REGULARIZATION"])

/**
 * T-21 · `buildReversal`. Bloquea CA-1…CA-6 y devuelve el borrador espejo.
 */
export function buildReversal(entry: PostedEntry, opts: VoidOptions, ctx: LedgerContext): Result<EntryDraft> {
  const errors: LedgerError[] = []

  // CA-6: motivo obligatorio, ≥ 10 caracteres, va al AuditLog.
  const reason = (opts.reason ?? "").trim()
  if (reason.length < MIN_REASON) {
    errors.push(
      err("TEMPLATE_INPUT", "reason", `El motivo de la anulación es obligatorio y debe tener al menos ${MIN_REASON} caracteres`, {
        check: "CA-6",
      })
    )
  }

  // C-13 / I10.
  if (entry.organizationId !== ctx.organizationId) {
    errors.push(err("TENANT_MISMATCH", "organizationId", "El asiento anulado es de otra organización", { check: "C-13" }))
  }

  // CA-2: un contra-asiento no se anula con otro contra-asiento (I-E3-4).
  if (entry.kind === "REVERSAL") {
    errors.push(
      err(
        "REVERSAL_OF_REVERSAL",
        "entryId",
        "Un contra-asiento no puede anularse con otro contra-asiento: para deshacer una anulación se vuelve a " +
          "registrar el hecho económico con un asiento nuevo",
        { check: "CA-2" }
      )
    )
  }

  // CA-1: apertura, cierre y regularización no se anulan.
  if (NON_REVERSIBLE_KINDS.has(entry.kind)) {
    errors.push(
      err("REVERSAL_TARGET_KIND", "entryId", `Los asientos de tipo ${entry.kind} no se anulan con contra-asiento`, {
        check: "CA-1",
      })
    )
  }

  // CA-3: como máximo un contra-asiento vivo por asiento anulado (I-E3-2).
  if ((opts.existingReversals?.length ?? 0) > 0 || entry.voidedAt) {
    errors.push(
      err("ALREADY_REVERSED", "entryId", `El asiento nº ${entry.entryNumber} ya está anulado`, { check: "CA-3" })
    )
  }

  if (entry.lines.length < 2) {
    errors.push(err("TOO_FEW_LINES", "lines", "El asiento anulado no tiene líneas que reflejar", { check: "C-4" }))
  }

  // CA-4: fecha. La del original si su mes sigue abierto; si no, el primer día
  // del primer mes abierto ≥ esa fecha.
  const dateResult = resolveReversalDate(entry.entryDate, ctx, opts.requestedDate ?? null)
  if (!dateResult.ok) errors.push(...dateResult.errors)

  if (errors.length > 0 || !dateResult.ok) return fail<EntryDraft>(...errors)

  const { entryDate, fiscalYearId } = dateResult.value

  // Espejo exacto: se copia e invierte, en el MISMO orden de líneas.
  const lines: ResolvedLine[] = entry.lines
    .slice()
    .sort((a, b) => a.lineNo - b.lineNo)
    .map((l, index) => ({
      lineNo: index + 1,
      accountKey: null,
      accountCode: l.accountCode,
      debitCents: l.creditCents,
      creditCents: l.debitCents,
      description: l.description ?? null,
      taxRateId: l.taxRateId ?? null,
      taxBaseCents: l.taxBaseCents ?? null,
      counterpartyId: l.counterpartyId ?? null,
      dueDate: l.dueDate ?? null,
      analyticType: l.analyticType ?? null,
      projectId: l.projectId ?? null,
      costCenterId: l.costCenterId ?? null,
      businessLineId: l.businessLineId ?? null,
    }))

  const draft: EntryDraft = {
    organizationId: ctx.organizationId,
    fiscalYearId,
    documentDate: entry.documentDate ?? null,
    accrualDate: null,
    entryDate,
    description: `Anulación del asiento nº ${entry.entryNumber} de ${entry.entryDate} — ${reason}`.slice(0, 512),
    kind: "REVERSAL",
    sourceType: "SYSTEM",
    sourceId: entry.sourceId ?? null,
    transactionId: null,
    fileId: null,
    templateCode: "CONTRA_ASIENTO",
    // El modo de redondeo se hereda del asiento anulado: el espejo debe poder
    // recalcularse con la misma política que el original (O-2).
    taxRoundingMode: entry.taxRoundingMode,
    reversesEntryId: entry.id,
    lines,
  }

  return checkDraft(draft, ctx)
}

/**
 * I-E3-1 — el par original + contra-asiento cuadra a 0 por cuenta (y por
 * destino analítico desde E4). Se usa en invariantes y en Auditoría (CA-5).
 */
export function reversalNetsToZero(
  original: readonly { accountCode: string; debitCents: number; creditCents: number }[],
  reversal: readonly { accountCode: string; debitCents: number; creditCents: number }[]
): { ok: true } | { ok: false; residuals: { accountCode: string; diffCents: number }[] } {
  const net = new Map<string, number>()
  for (const l of [...original, ...reversal]) {
    net.set(l.accountCode, (net.get(l.accountCode) ?? 0) + l.debitCents - l.creditCents)
  }
  const residuals = [...net.entries()]
    .filter(([, diff]) => diff !== 0)
    .map(([accountCode, diffCents]) => ({ accountCode, diffCents }))
  return residuals.length === 0 ? { ok: true } : { ok: false, residuals }
}
