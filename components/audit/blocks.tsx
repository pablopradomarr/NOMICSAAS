import { CheckStatusChip } from "@/components/ui/check-status"
import { SealBlock } from "@/components/ui/seal-badge"
import { Amount } from "@/components/ledger/amount"
import { fechaHoraUtc } from "@/lib/dates-ui"
import Link from "next/link"

import {
  HEADLINE_LABEL,
  SCOPE_LABEL,
  TRIGGER_LABEL,
  short,
  type ClosingBlockView,
  type DataQualityRow,
  type RunSummaryView,
  type StaleAllocationRow,
} from "./types"

/**
 * E7 · T12/T13 — Bloques de sólo lectura de la pestaña Auditoría.
 *
 * Server Components a propósito: no hay una sola interacción en ellos y las
 * cifras llegan ya resueltas del motor. Lo único que hace este fichero es
 * pintar (`ui-erp` §Tablas): importes con `Amount` en céntimos, hashes en
 * `.font-code` abreviados con el valor completo en el `title`, y fechas de
 * auditoría con `fechaUtc`/`fechaHoraUtc` —nunca `toLocaleDateString`, que
 * desajusta la hidratación—.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Resumen: sello, alcance, los CINCO hashes y las cuatro cifras
// ─────────────────────────────────────────────────────────────────────────────

export function RunSummary({ run, actions }: { run: RunSummaryView; actions?: React.ReactNode }) {
  return (
    <section className="space-y-3 border-b pb-4" data-testid="run-summary">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Auditoría</h1>
          <p className="text-sm text-muted-foreground">
            {SCOPE_LABEL[run.scopeKind] ?? run.scopeKind}
            {run.fiscalYearCode ? ` ${run.fiscalYearCode}` : ""}
            {run.periodStart && run.periodEnd ? ` · ${run.periodStart} – ${run.periodEnd}` : ""} · fecha de referencia{" "}
            {run.refDate} · {TRIGGER_LABEL[run.trigger] ?? run.trigger}
            {run.createdAt ? ` · ${fechaHoraUtc(run.createdAt)}` : ""} · {run.durationMs} ms
          </p>
          <p className="font-code text-xs text-muted-foreground" data-testid="audit-hashes">
            <span title={run.hashes.ledgerHash}>ledgerHash {short(run.hashes.ledgerHash, 16)}</span> ·{" "}
            <span title={run.hashes.analyticsKey}>analyticsKey {short(run.hashes.analyticsKey, 16)}</span> ·{" "}
            <span title={run.hashes.planHash}>planHash {short(run.hashes.planHash, 12)}</span> ·{" "}
            <span title={run.hashes.accountMapHash}>accountMapHash {short(run.hashes.accountMapHash, 12)}</span> ·{" "}
            <span title={run.hashes.configHash}>configHash {short(run.hashes.configHash, 12)}</span> ·{" "}
            <span title={run.hashes.gitSha}>motor {short(run.hashes.gitSha, 8)}</span>
          </p>
          {run.id && (
            <p className="font-code text-xs text-muted-foreground">
              run_id <span title={run.id}>{short(run.id, 18)}</span>
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          <SealBlock seal={run.seal} />
          {actions}
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" data-testid="headline">
        {run.headline.map((figure) => (
          <div key={figure.metric} className="rounded-md border px-3 py-2" data-testid={`headline-${figure.metric}`}>
            <p className="text-xs text-muted-foreground">{HEADLINE_LABEL[figure.metric] ?? figure.label}</p>
            <Amount cents={figure.cents} className="text-lg font-semibold" zeroAsDash={false} />
          </div>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        {run.counts.total} comprobaciones · {run.counts.PASS} PASS · {run.counts.FAIL} FAIL · {run.counts.WARN} WARN ·{" "}
        {run.counts.INFO} INFO
      </p>

      {run.skipped.length > 0 && (
        <div className="rounded-md border border-dashed px-3 py-2" data-testid="coverage-skipped">
          <p className="text-xs font-medium">Lo que este barrido NO ha evaluado</p>
          <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
            {run.skipped.map((item) => (
              <li key={item.block}>
                <span className="font-code">{item.block}</span>: {item.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {run.unknownCheckIds.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="unknown-checks">
          Comprobaciones sin familia declarada (van a Integridad y hay que clasificarlas):{" "}
          <span className="font-code">{run.unknownCheckIds.join(", ")}</span>
        </p>
      )}
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// §Cuadres de cierre (O-18): en lenguaje de cierre, no por id de check
// ─────────────────────────────────────────────────────────────────────────────

export function ClosingChecks({ blocks }: { blocks: readonly ClosingBlockView[] }) {
  return (
    <section className="space-y-3" data-testid="cuadres-de-cierre">
      <h2 className="text-lg font-semibold">Cuadres de cierre</h2>
      <div className="grid gap-2 lg:grid-cols-2">
        {blocks.map((block) => (
          <div key={block.key} className="rounded-md border p-3" data-testid={`cierre-${block.key}`}>
            <p className="text-sm font-medium">{block.title}</p>
            <p className="text-xs text-muted-foreground">{block.legal}</p>
            {block.checks.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Sin evaluar en el último barrido: no hay resultado que enseñar, y eso no es lo mismo que estar bien.
              </p>
            ) : (
              <ul className="mt-2 space-y-1">
                {block.checks.map((check) => (
                  <li key={check.id} className="flex items-start gap-2 text-xs" data-check-id={check.id}>
                    <CheckStatusChip status={check.status} />
                    <span className="min-w-0 flex-1 text-muted-foreground">{check.evidencia}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// §Calidad de datos
// ─────────────────────────────────────────────────────────────────────────────

export function DataQualityBlock({
  warnings,
  staleAllocations,
}: {
  warnings: readonly DataQualityRow[]
  staleAllocations: readonly StaleAllocationRow[]
}) {
  return (
    <section className="space-y-3" data-testid="calidad-de-datos">
      <h2 className="text-lg font-semibold">Calidad de datos</h2>
      <p className="text-xs text-muted-foreground">
        Ninguno de estos avisos significa que una cifra esté mal: significan que hay trabajo pendiente que, si nadie lo
        mira, acaba en una declaración incompleta.
      </p>

      {warnings.length === 0 ? (
        <p className="rounded-md border border-dashed px-4 py-4 text-sm text-muted-foreground" data-testid="dq-empty">
          Sin avisos de calidad de datos.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="p-2 text-left font-medium">Aviso</th>
                <th className="p-2 text-right font-medium">Recuento</th>
                <th className="p-2 text-left font-medium">Qué significa</th>
                <th className="p-2 text-left font-medium">Dónde se resuelve</th>
              </tr>
            </thead>
            <tbody>
              {warnings.map((row) => (
                <tr key={row.code} className="border-t" data-testid={`dq-${row.code}`}>
                  <td className="font-code p-2 text-xs">{row.code}</td>
                  <td className="p-2 text-right tabular-nums" data-testid={`dq-count-${row.code}`}>
                    {row.count}
                  </td>
                  <td className="p-2 text-muted-foreground">{row.message}</td>
                  <td className="p-2">
                    {row.href ? (
                      <Link href={row.href} className="underline underline-offset-2">
                        {row.hrefLabel}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">{row.hrefLabel}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div>
        <h3 className="text-sm font-medium">Liquidaciones selladas sin sello de líneas</h3>
        <p className="text-xs text-muted-foreground">
          I-E7-9: un `AllocationRun` sellado sin `linesHash` no se puede verificar. Los anteriores a la migración salen
          como aviso; uno sellado después es un fallo.
        </p>
        {staleAllocations.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground" data-testid="stale-empty">
            Ninguna: todas las liquidaciones selladas llevan su `linesHash`.
          </p>
        ) : (
          <ul className="mt-1 space-y-1 text-sm" data-testid="stale-allocations">
            {staleAllocations.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-2">
                <span>{row.periodLabel}</span>
                <span className="text-xs text-muted-foreground">{fechaHoraUtc(row.runAt)}</span>
                <span className="text-xs text-muted-foreground">{row.reason}</span>
                <Link
                  href={`/analytics/allocations/runs/${row.id}`}
                  className="underline underline-offset-2"
                  data-testid={`re-liquidar-${row.id}`}
                >
                  Re-liquidar
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// §Registro — `AuditLog`. **ADMIN**: contiene los before/after de gobierno
// ─────────────────────────────────────────────────────────────────────────────

export type AuditLogRow = {
  id: string
  ts: string
  entity: string
  entityId: string
  action: string
  reason: string | null
  userName: string
  resumen: string
}

export function AuditLogBlock({
  rows,
  entities,
  actions,
  members,
  filters,
  nextCursor,
}: {
  rows: readonly AuditLogRow[]
  entities: readonly string[]
  actions: readonly string[]
  members: readonly { userId: string; name: string }[]
  filters: { entity?: string; action?: string; userId?: string; take: number }
  nextCursor: number | null
}) {
  return (
    <section className="space-y-3" data-testid="registro">
      <h2 className="text-lg font-semibold">Registro de auditoría</h2>
      <form method="get" className="flex flex-wrap items-end gap-2 text-sm">
        <label className="space-y-1">
          <span className="block text-xs text-muted-foreground">Entidad</span>
          <select name="entity" defaultValue={filters.entity ?? ""} className="h-9 rounded-md border bg-background px-2">
            <option value="">Todas</option>
            {entities.map((entity) => (
              <option key={entity} value={entity}>
                {entity}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="block text-xs text-muted-foreground">Acción</span>
          <select name="action" defaultValue={filters.action ?? ""} className="h-9 rounded-md border bg-background px-2">
            <option value="">Todas</option>
            {actions.map((action) => (
              <option key={action} value={action}>
                {action}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="block text-xs text-muted-foreground">Autor</span>
          <select name="userId" defaultValue={filters.userId ?? ""} className="h-9 rounded-md border bg-background px-2">
            <option value="">Todos</option>
            {members.map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="h-9 rounded-md border px-3">
          Filtrar
        </button>
      </form>

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed px-4 py-4 text-sm text-muted-foreground" data-testid="log-empty">
          No hay movimientos con esos filtros.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="p-2 text-left font-medium">Cuándo</th>
                <th className="p-2 text-left font-medium">Entidad</th>
                <th className="p-2 text-left font-medium">Acción</th>
                <th className="p-2 text-left font-medium">Autor</th>
                <th className="p-2 text-left font-medium">Motivo</th>
                <th className="p-2 text-left font-medium">Cambio</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t align-top">
                  <td className="p-2 whitespace-nowrap">{fechaHoraUtc(row.ts)}</td>
                  <td className="p-2">{row.entity}</td>
                  <td className="p-2">{row.action}</td>
                  <td className="p-2">{row.userName}</td>
                  <td className="p-2 text-muted-foreground">{row.reason ?? "—"}</td>
                  <td className="p-2 text-xs text-muted-foreground">{row.resumen}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Mostrando {rows.length} movimiento(s).
        {nextCursor !== null && (
          <>
            {" "}
            <Link
              href={`/audit?take=${nextCursor}${filters.entity ? `&entity=${filters.entity}` : ""}${
                filters.action ? `&action=${filters.action}` : ""
              }${filters.userId ? `&userId=${filters.userId}` : ""}#registro`}
              className="underline underline-offset-2"
            >
              Ver más
            </Link>
          </>
        )}
      </p>
    </section>
  )
}
