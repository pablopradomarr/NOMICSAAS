import { ImportStatementDialog } from "@/components/bank/account-dialogs"
import { ReconcileBoard } from "@/components/bank/reconcile-board"
import { ReconciliationSummaryPanel } from "@/components/bank/summary-panel"
import type { JournalCashLineView, MatchGroupView, StatementLineView, SuggestionView } from "@/components/bank/types"
import { Button } from "@/components/ui/button"
import { tenantTransaction } from "@/lib/db"
import { tenantPage } from "@/lib/page-tenant"
import { latestInvariantRun } from "@/models/audit"
import {
  getBankAccount,
  listCashLines,
  listMatchGroups,
  listStatementLines,
  listStatements,
  pendingItems,
  suggestionsForAccount,
} from "@/models/bank"
import { todayLocalDate } from "@/models/ledger"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { toAccountView, toSummaryView } from "../shared"

export const metadata: Metadata = { title: "Conciliación de una cuenta" }

/** Las seis claves del mapa que puede usar una propuesta desde el extracto. */
const PROPOSAL_KEYS = [
  "COMISIONES_BANCARIAS",
  "INTERESES_DEUDAS",
  "OTROS_GASTOS_FINANCIEROS",
  "INTERESES_DESCUENTO_EFECTOS",
  "DIFERENCIA_CAMBIO_NEGATIVA",
  "DIFERENCIA_CAMBIO_POSITIVA",
] as const

/**
 * E7 · T16 — `/audit/bank/[id]`: el cuadre de una cuenta y su tablero.
 *
 * Arriba el panel de I-E7-1 con los pendientes **tipados y envejecidos**, la Σ
 * de ignorados como línea propia y —en cuenta en divisa— la diferencia de cambio
 * presentada como tal. Debajo, las dos columnas enfrentadas.
 *
 * Todas las lecturas van en SERIE dentro de la única transacción del render, y
 * las sugerencias se **recomputan** en cada carga: una sugerencia es un cálculo
 * sobre el estado de hoy, no un hecho, y por eso no se persiste.
 */
export default tenantPage<{ params: Promise<{ id: string }> }>(async ({ org, user, role, params }) => {
  const { id } = await params
  const canEdit = role === Role.EDITOR || role === Role.ADMIN
  const cutoff = todayLocalDate()

  /**
   * Todo dentro de `tenantTransaction`, que **reutiliza** la que `tenantPage` ya
   * abrió: `listCashLines` y `pendingItems` leen los apuntes de la 57x con
   * `$queryRaw`, y el SQL crudo sólo ve `app.current_org` si sale por la
   * conexión de la transacción (ADR-0009). Fuera de ella, RLS no devolvería ni
   * una fila. Las lecturas van en SERIE: comparten una sola conexión.
   */
  const data = await tenantTransaction(org.id, user.id, async (tx) => {
    const account = await getBankAccount(tx, id)
    if (!account) return null
    const run = await latestInvariantRun(tx)
    const [rawSummary] = await pendingItems(tx, { cutoff, baseCurrency: org.baseCurrency, bankAccountId: account.id })
    const statements = await listStatements(tx, { bankAccountId: account.id })
    const lines = await listStatementLines(tx, { bankAccountId: account.id, take: 1000 })
    const cashLines = await listCashLines(tx, { accountCodes: [account.accountCode], to: cutoff })
    const groups = await listMatchGroups(tx, { bankAccountId: account.id, liveOnly: true })
    const suggestions = await suggestionsForAccount(tx, { bankAccountId: account.id, cutoff })
    // Destinos analíticos activos: la propuesta de asiento desde el extracto es
    // una cuenta 6/7 y lleva destino obligatorio (R-A1 de E4).
    const projects = await tx.project.findMany({ where: { isActive: true }, select: { id: true, code: true, name: true }, orderBy: { code: "asc" } })
    const costCenters = await tx.costCenter.findMany({ where: { isActive: true }, select: { id: true, code: true, name: true }, orderBy: { code: "asc" } })
    return { account, run, rawSummary, statements, lines, cashLines, groups, suggestions, projects, costCenters }
  })
  if (data === null) notFound()
  const { account, run, rawSummary, statements, lines, cashLines, groups, suggestions, projects, costCenters } = data
  const destinations = [
    ...projects.map((p) => ({ id: p.id, kind: "PROJECT" as const, label: `Proyecto ${p.code} · ${p.name}` })),
    ...costCenters.map((c) => ({ id: c.id, kind: "COST_CENTER" as const, label: `Centro de coste ${c.code} · ${c.name}` })),
  ]
  const invariantsPass = run !== null && run.checks.every((check) => check.status !== "FAIL")

  const groupByStatementLine = new Map<string, string>()
  const groupByJournalLine = new Map<string, string>()
  for (const group of groups) {
    for (const member of group.members) {
      groupByStatementLine.set(member.statementLineId, group.id)
      groupByJournalLine.set(member.journalLineId, group.id)
    }
  }

  const lineViews: StatementLineView[] = lines.map((line) => ({
    id: line.id,
    lineNo: line.lineNo,
    operationDate: line.operationDate,
    valueDate: line.valueDate,
    amountCents: line.amountCents,
    currency: line.currency,
    description: line.description,
    reference1: line.reference1 ?? null,
    reference2: line.reference2 ?? null,
    counterpartyName: line.counterpartyName ?? null,
    status: line.status,
    ignoreReason: line.ignoreReason ?? null,
    sha256: line.sha256,
    groupId: groupByStatementLine.get(line.id) ?? null,
  }))

  const cashViews: JournalCashLineView[] = cashLines
    // El asiento de cierre no se concilia: no es un movimiento de tesorería.
    .filter((line) => line.entryKind !== "CLOSING")
    .map((line) => ({
      id: line.id,
      entryId: line.entryId,
      entryNumber: line.entryNumber,
      entryDate: line.entryDate,
      entryKind: line.entryKind,
      lineNo: line.lineNo,
      accountCode: line.accountCode,
      signedCents: line.debitCents - line.creditCents,
      description: line.description ?? "",
      groupId: groupByJournalLine.get(line.id) ?? null,
    }))

  const suggestionViews: SuggestionView[] = suggestions.map((suggestion) => ({
    statementLineId: suggestion.statementLineId,
    ambiguous: suggestion.ambiguous,
    candidates: suggestion.candidates.map((candidate) => ({
      journalLineIds: candidate.journalLineIds,
      scoreBps: candidate.scoreBps,
      kind: candidate.kind,
      reasons: candidate.reasons,
    })),
  }))

  const amountById = new Map(lines.map((line) => [line.id, line.amountCents]))
  const groupViews: MatchGroupView[] = groups.map((group) => {
    const statementLineIds = [...new Set(group.members.map((member) => member.statementLineId))]
    return {
      id: group.id,
      kind: group.kind,
      statementLineIds,
      journalLineIds: [...new Set(group.members.map((member) => member.journalLineId))],
      // Σ del grupo por el lado del extracto: la igualdad con el diario la
      // garantiza I-E7-11 en la BASE (constraint trigger diferido), no esta
      // suma, que es sólo para enseñar de qué grupo se habla al desconciliar.
      sumCents: statementLineIds.reduce((total, lineId) => total + (amountById.get(lineId) ?? 0), 0),
    }
  })

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
        <div className="space-y-1">
          <Button asChild variant="ghost" size="sm" className="-ml-3">
            <Link href="/audit/bank">← Conciliación bancaria</Link>
          </Button>
          <h1 className="text-2xl font-semibold tracking-tight">{account.name}</h1>
          <p className="font-code text-xs text-muted-foreground">
            {account.code} · subcuenta {account.accountCode} · {account.currency}
            {account.iban ? ` · ${account.iban}` : ""} · tolerancia {account.matchToleranceDays} día(s) · tránsito{" "}
            {account.transitWarnDays} día(s)
          </p>
        </div>
        {canEdit && <ImportStatementDialog account={toAccountView(account)} />}
      </header>

      {rawSummary ? (
        <ReconciliationSummaryPanel summary={toSummaryView(rawSummary, account, { invariantsPass })} />
      ) : (
        <p className="rounded-md border border-dashed px-4 py-6 text-sm text-muted-foreground" data-testid="cuadre-vacio">
          Todavía no hay nada que cuadrar en esta cuenta: importe un extracto.
        </p>
      )}

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Extractos importados</h2>
        {statements.length === 0 ? (
          <p className="text-sm text-muted-foreground">Ninguno.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="p-2 text-left font-medium">Periodo</th>
                  <th className="p-2 text-right font-medium">Movimientos</th>
                  <th className="p-2 text-right font-medium">Declarados (registro 33)</th>
                </tr>
              </thead>
              <tbody>
                {statements.map((statement) => (
                  <tr key={statement.id} className="border-t">
                    <td className="p-2 tabular-nums">
                      {statement.periodStart} – {statement.periodEnd}
                    </td>
                    <td className="p-2 text-right tabular-nums">{statement.lineCount}</td>
                    <td className="p-2 text-right tabular-nums">{statement.declaredLineCount ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ReconcileBoard
        bankAccountId={account.id}
        currency={account.currency}
        canEdit={canEdit}
        lines={lineViews}
        cashLines={cashViews}
        suggestions={suggestionViews}
        groups={groupViews}
        accountKeys={PROPOSAL_KEYS}
        destinations={destinations}
      />
    </div>
  )
})
