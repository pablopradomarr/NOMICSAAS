import { DetectionTestDialog, RunSweepButton } from "@/components/audit/audit-actions"
import { AuditLogBlock, ClosingChecks, DataQualityBlock, RunSummary } from "@/components/audit/blocks"
import { FamilyCards } from "@/components/audit/family-cards"
import { RunHistoryTable } from "@/components/audit/history-table"
import { StoreSweepPanel } from "@/components/audit/store-sweep-panel"
import type { StaleAllocationRow, SweepView } from "@/components/audit/types"
import { Button } from "@/components/ui/button"
import { tenantPage } from "@/lib/page-tenant"
import { listAllocationRunsWithLinesHash } from "@/models/allocations"
import { latestInvariantRun, listInvariantRuns } from "@/models/audit"
import { listAuditLog, type AuditAction, type AuditEntity } from "@/models/audit-log"
import { listFiscalYears } from "@/models/fiscal-years"
import { listOrganizationMembersWithUsers } from "@/models/memberships"
import { latestSweep } from "@/models/store-sweep"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"
import Link from "next/link"

import {
  originRecordsOf,
  readDataQuality,
  sealReasonsOf,
  toAuditLogRows,
  toCheckViews,
  toClosingBlocks,
  toFamilyCards,
  toHistoryRows,
  toRunSummary,
} from "./shared"

export const metadata: Metadata = { title: "Auditoría" }

/**
 * E7 · T12 — Pestaña **Auditoría** (`docs/design/E7-auditoria.md` §6).
 *
 * Una pantalla que existe para contestar tres preguntas sin salir de ella:
 * *¿está la contabilidad cuadrada?*, *¿qué NO se ha comprobado?* y *¿de dónde
 * sale este hallazgo?*. Por eso:
 *
 * · el resumen enseña el sello con sus motivos y **los cinco hashes**, no una
 *   luz verde;
 * · las siete familias llevan el semáforo del motor puro, y una familia sin
 *   evaluar sale **`SIN_EVALUAR`**, jamás en verde (R3);
 * · el drill-down son **tres clics** —familia → check → registros de origen— y
 *   de ahí al asiento y a su documento;
 * · lo que el barrido no evaluó se declara, con el motivo, en el propio resumen.
 *
 * Server Component: `tenantPage` abre UNA transacción para todo el render y las
 * lecturas van **en serie**. Los componentes de cliente reciben datos ya
 * resueltos; ninguno consulta la base por su cuenta.
 */
export default tenantPage<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>(
  async ({ db, org, role, searchParams }) => {
    const query = await searchParams
    const first = (key: string): string | undefined => {
      const value = query[key]
      return Array.isArray(value) ? value[0] : value
    }

    const isAdmin = role === Role.ADMIN
    const canEdit = role === Role.EDITOR || role === Role.ADMIN

    // ── Lecturas, en SERIE (una sola conexión por render) ───────────────────
    const fiscalYearRows = await listFiscalYears(db)
    const run = await latestInvariantRun(db)
    const history = await listInvariantRuns(db, { take: 25 })
    const sweep = await latestSweep(db)
    const dataQuality = await readDataQuality(db)
    const allocationRuns = await listAllocationRunsWithLinesHash(db)
    const records = run ? await originRecordsOf(db, run.checks) : new Map()

    const logFilters = {
      entity: first("entity"),
      action: first("action"),
      userId: first("userId"),
      take: Math.min(200, Math.max(25, Number(first("take") ?? "50") || 50)),
    }
    const members = isAdmin ? await listOrganizationMembersWithUsers(org.id) : []
    const logs = isAdmin
      ? await listAuditLog(db, {
          ...(logFilters.entity ? { entity: logFilters.entity as AuditEntity } : {}),
          ...(logFilters.action ? { action: logFilters.action as AuditAction } : {}),
          ...(logFilters.userId ? { userId: logFilters.userId } : {}),
          take: logFilters.take,
        })
      : []

    const fiscalYears = fiscalYearRows.map((year) => ({ id: year.id, code: year.code }))
    const openYear = fiscalYearRows.find((year) => year.status === "OPEN") ?? fiscalYearRows.at(-1) ?? null

    const checkViews = run ? toCheckViews(run.checks, records) : []
    const families = run ? toFamilyCards(checkViews, run.checks) : toFamilyCards([], [])
    const closing = toClosingBlocks(checkViews)

    const staleAllocations: StaleAllocationRow[] = allocationRuns
      .filter((allocation) => allocation.linesHash === null)
      .map((allocation) => ({
        id: allocation.id,
        periodLabel: `${allocation.periodStart} – ${allocation.periodEnd}`,
        runAt: allocation.sealedAt ?? new Date(0).toISOString(),
        reason: "sellada sin `linesHash`: no se puede verificar que sus líneas no han cambiado",
      }))

    const sweepView: SweepView | null = sweep
      ? {
          id: sweep.id,
          status: sweep.status,
          filesTotal: sweep.filesTotal,
          filesOk: sweep.filesOk,
          filesMissing: sweep.filesMissing,
          filesAltered: sweep.filesAltered,
          bytesRead: sweep.bytesRead,
          findings: sweep.findings.map((finding) => ({
            kind: finding.kind,
            fileId: finding.fileId,
            path: finding.path,
            expected: finding.expected,
            actual: finding.actual,
          })),
          findingsOverflow: sweep.findingsOverflow,
          startedAt: sweep.startedAt.toISOString(),
          finishedAt: sweep.finishedAt ? sweep.finishedAt.toISOString() : null,
        }
      : null

    const acciones = (
      <div className="flex flex-wrap items-end justify-end gap-2">
        <Button asChild variant="outline" size="sm">
          <Link href="/audit/bank">Conciliación bancaria</Link>
        </Button>
        {run && (
          <Button asChild variant="outline" size="sm">
            <Link href={`/audit/runs/${run.id}`}>Ver la foto completa</Link>
          </Button>
        )}
        {isAdmin && <DetectionTestDialog fiscalYearId={openYear?.id ?? null} />}
        {canEdit && <RunSweepButton fiscalYears={fiscalYears} defaultFiscalYearId={openYear?.id ?? null} />}
      </div>
    )

    return (
      <div className="space-y-8">
        {run ? (
          <RunSummary
            run={toRunSummary(
              run,
              fiscalYearRows.find((year) => year.id === run.fiscalYearId)?.code ?? null,
              sealReasonsOf(run)
            )}
            actions={acciones}
          />
        ) : (
          <section className="space-y-3 border-b pb-4" data-testid="audit-empty">
            <h1 className="text-2xl font-semibold tracking-tight">Auditoría</h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Todavía no hay ningún barrido sellado en esta organización. Hasta que se ejecute uno, esta pantalla no
              puede afirmar nada: no hay foto, no hay hashes y ninguna familia está comprobada. Ejecute el primer
              barrido para tener la primera foto.
            </p>
            {acciones}
          </section>
        )}

        <FamilyCards families={families} />

        <ClosingChecks blocks={closing} />

        <DataQualityBlock warnings={dataQuality} staleAllocations={staleAllocations} />

        <StoreSweepPanel initial={sweepView} canSweep={isAdmin} />

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Historial de barridos</h2>
          <RunHistoryTable runs={toHistoryRows(history)} />
        </section>

        {isAdmin && (
          <AuditLogBlock
            rows={toAuditLogRows(logs, new Map(members.map((m) => [m.userId, m.user.name || m.user.email])))}
            entities={[
              "JournalEntry",
              "BankAccount",
              "BankStatement",
              "BankMatchGroup",
              "InvariantRun",
              "StoreSweep",
              "ManualReviewFlag",
              "AllocationRun",
              "LedgerAccount",
              "OrganizationAccountMap",
            ]}
            actions={["create", "update", "post", "void", "import", "FORCE_REVIEW", "CLEAR_REVIEW", "DETECTION_TEST"]}
            members={members.map((m) => ({ userId: m.userId, name: m.user.name || m.user.email }))}
            filters={logFilters}
            nextCursor={logs.length >= logFilters.take && logFilters.take < 200 ? Math.min(200, logFilters.take + 50) : null}
          />
        )}
      </div>
    )
  }
)
