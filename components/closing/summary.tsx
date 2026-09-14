import { SealBlock } from "@/components/ui/seal-badge"
import { StepStatusChip } from "@/components/closing/step-status"
import { fechaHoraUtc } from "@/lib/dates-ui"
import { cn } from "@/lib/utils"
import Link from "next/link"

import {
  APPROVAL_LABEL,
  RUN_STATUS_LABEL,
  TAX_FILING_LABEL,
  short,
  type ClosingEntryView,
  type ClosingRunView,
  type ClosingStepView,
  type FiscalYearView,
} from "./types"

/**
 * E9 · T16 — Cabecera del asistente, bloqueantes y **los doce asientos** (§7).
 *
 * La cabecera dice, sin abrir nada: qué ejercicio, a qué fecha se ha comprobado,
 * en qué estado contable, societario y fiscal está, y **con qué sello y sobre
 * qué `ledgerHash`**. Un sello sin sus motivos no dice nada al que tiene que
 * revisar, así que los motivos van siempre debajo.
 */

export function ClosingHeader({
  fiscalYear,
  fiscalYears,
  run,
  totals,
  actions,
}: {
  fiscalYear: FiscalYearView
  fiscalYears: readonly FiscalYearView[]
  run: ClosingRunView | null
  totals: { steps: number; blocking: number; pass: number }
  actions?: React.ReactNode
}) {
  return (
    <section className="space-y-3 border-b pb-4" data-testid="closing-header">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Cierre del ejercicio</h1>
          <p className="text-sm text-muted-foreground">
            Ejercicio <span className="font-medium text-foreground">{fiscalYear.code}</span> · {fiscalYear.startDate} –{" "}
            {fiscalYear.endDate} · {fiscalYear.status === "CLOSED" ? "cerrado contablemente" : "abierto"} ·{" "}
            {APPROVAL_LABEL[fiscalYear.accountsApprovalStatus]} · {TAX_FILING_LABEL[fiscalYear.taxFilingStatus]}
          </p>
          <p className="text-sm text-muted-foreground" data-testid="closing-progress">
            {run
              ? `${RUN_STATUS_LABEL[run.status]} · ${totals.pass} de ${totals.steps} pasos en PASS · ${totals.blocking} bloqueantes · comprobado a ${run.refDate} · ${run.durationMs} ms`
              : `${totals.steps} pasos en nueve bloques, ${totals.blocking} de ellos bloqueantes. Todavía no se ha ejecutado el checklist.`}
          </p>
          {run && (
            <p className="font-code text-xs text-muted-foreground" data-testid="closing-hashes">
              <span title={run.hashes.ledgerHash}>ledgerHash {short(run.hashes.ledgerHash, 16)}</span> ·{" "}
              <span title={run.hashes.planHash}>planHash {short(run.hashes.planHash, 12)}</span> ·{" "}
              <span title={run.hashes.accountMapHash}>accountMapHash {short(run.hashes.accountMapHash, 12)}</span> ·{" "}
              <span title={run.hashes.configHash}>configHash {short(run.hashes.configHash, 12)}</span> ·{" "}
              <span title={run.hashes.gitSha}>motor {short(run.hashes.gitSha, 8)}</span>
            </p>
          )}
          {run && (
            <p className="font-code text-xs text-muted-foreground">
              run_id{" "}
              <Link href={`/ledger/closing/${run.id}`} className="underline underline-offset-2" data-testid="run-link">
                {short(run.id, 18)}
              </Link>
              {run.closedAt ? ` · cerrado ${fechaHoraUtc(run.closedAt)}` : ""}
              {run.reopenedAt ? ` · reabierto ${fechaHoraUtc(run.reopenedAt)}` : ""}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          {run && <SealBlock seal={run.seal} />}
          {actions}
        </div>
      </div>

      {fiscalYears.length > 1 && (
        <nav className="flex flex-wrap gap-2 text-xs" data-testid="fiscal-year-switch">
          {fiscalYears.map((year) => (
            <Link
              key={year.id}
              href={`/ledger/closing?fy=${year.id}`}
              className={cn(
                "font-code rounded border px-2 py-1",
                year.id === fiscalYear.id ? "border-transparent bg-[#0A0A0A] text-white" : "text-muted-foreground"
              )}
            >
              {year.code}
            </Link>
          ))}
        </nav>
      )}
    </section>
  )
}

/** Los nueve bloqueantes que faltan, arriba y por su nombre: es lo que impide cerrar. */
export function Blockers({ blockers }: { blockers: readonly ClosingStepView[] }) {
  if (blockers.length === 0) {
    return (
      <p className="text-sm" data-testid="blockers-none">
        ✓ Los nueve pasos bloqueantes están en PASS: el ejercicio se puede cerrar.
      </p>
    )
  }
  return (
    <section className="space-y-2 rounded-md border border-[#F5A623] bg-[#F5A623]/10 p-3" data-testid="blockers">
      <h2 className="text-sm font-semibold">
        {blockers.length} paso(s) bloqueante(s) impiden cerrar el ejercicio
      </h2>
      <ul className="space-y-1 text-sm">
        {blockers.map((step) => (
          <li key={step.step} className="flex items-start gap-2" data-blocker={step.step}>
            <StepStatusChip status={step.status} />
            <span className="min-w-0 flex-1">
              {step.titulo}
              <span className="block text-xs text-muted-foreground">{step.evidencia}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Los doce asientos de O-17: el orden, el porqué y el asiento cuando existe. */
export function ClosingEntries({ entries }: { entries: readonly ClosingEntryView[] }) {
  const posteados = entries.filter((e) => e.entries.length > 0).length
  return (
    <section className="space-y-3" data-testid="closing-entries">
      <h2 className="text-lg font-semibold">
        Los doce asientos del cierre{" "}
        <span className="text-sm font-normal text-muted-foreground">({posteados} de 12 con asiento)</span>
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-1 pr-2 font-medium">Orden</th>
              <th className="py-1 pr-2 font-medium">Asiento del cierre</th>
              <th className="py-1 pr-2 font-medium">Por qué va aquí</th>
              <th className="py-1 font-medium">Asiento</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.orden} className="h-8 border-b last:border-0" data-testid={`closing-entry-${entry.orden}`}>
                <td className="font-code pr-2">{entry.orden}</td>
                <td className="pr-2">
                  {entry.paso}
                  {entry.templateCode && (
                    <span className="font-code ml-2 text-[11px] text-muted-foreground">{entry.templateCode}</span>
                  )}
                </td>
                <td className="pr-2 text-xs text-muted-foreground">{entry.porQue}</td>
                <td>
                  {entry.entries.length === 0 ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    entry.entries.map((ref) => (
                      <Link
                        key={ref.id}
                        href={`/ledger/${ref.id}`}
                        className="mr-2 underline underline-offset-2"
                      >
                        nº {ref.entryNumber ?? "—"}
                      </Link>
                    ))
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
