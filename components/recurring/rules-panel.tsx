"use client"

import type { RecurringRuleSummary } from "@/app/(app)/ledger/recurring/actions"
import { RecurringRuleForm } from "@/components/recurring/rule-form"
import { GeneratePanel } from "@/components/recurring/generate-panel"
import { PauseRuleDialog } from "@/components/recurring/pause-rule-dialog"
import { RevertOccurrenceDialog } from "@/components/recurring/revert-occurrence-dialog"
import { CELL_CLASS, CELL_GLYPH, CELL_LABEL, type CalendarCell, type CellStatus, type OccurrenceRow } from "@/components/recurring/types"
import { Amount } from "@/components/ledger/amount"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import Link from "next/link"
import { useMemo, useState } from "react"

const MESES = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"] as const

/**
 * E9 · T17 — Reglas recurrentes y su **calendario** (`docs/design/E9-cierre-recurrentes.md` §7).
 *
 * Doce columnas × N reglas. Cada celda dice en qué estado está el periodo:
 * generada (con enlace al asiento, que es el drill-down en un clic), **omitida
 * con su motivo — `CUOTA_CERO` incluido**, fallida con el error, pendiente de
 * generar o todavía no vencida. Ninguna cifra se calcula aquí: el importe, el
 * estado y el motivo llegan del servidor.
 *
 * Un `VIEWER` ve la rejilla entera y **ningún botón**; la protección de verdad
 * la hace `withOrg` en la server action.
 */
export function RecurringRulesPanel({
  rules,
  occurrences,
  refDate,
  canEdit,
  isAdmin,
}: {
  rules: RecurringRuleSummary[]
  occurrences: OccurrenceRow[]
  refDate: string
  canEdit: boolean
  isAdmin: boolean
}) {
  const [year, setYear] = useState<number>(Number(refDate.slice(0, 4)))
  const [selected, setSelected] = useState<{ rule: RecurringRuleSummary; cell: CalendarCell } | null>(null)

  const years = useMemo(() => {
    const set = new Set<number>([Number(refDate.slice(0, 4))])
    for (const rule of rules) {
      set.add(Number(rule.startPeriod.slice(0, 4)))
      if (rule.endPeriod) set.add(Number(rule.endPeriod.slice(0, 4)))
    }
    for (const occurrence of occurrences) set.add(Number(occurrence.period.slice(0, 4)))
    return [...set].sort((a, b) => a - b)
  }, [rules, occurrences, refDate])

  const byRule = useMemo(() => {
    const map = new Map<string, OccurrenceRow[]>()
    for (const occurrence of occurrences) {
      const list = map.get(occurrence.recurringEntryId) ?? []
      list.push(occurrence)
      map.set(occurrence.recurringEntryId, list)
    }
    return map
  }, [occurrences])

  if (rules.length === 0) {
    return (
      <div className="space-y-4">
        {canEdit && <RecurringRuleForm />}
        <p className="rounded-md border p-6 text-sm text-muted-foreground" data-testid="recurring-empty">
          Todavía no hay ninguna regla recurrente.{" "}
          {canEdit ? "Da de alta la primera arriba." : "Pídeselo a quien pueda editar."}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-center gap-2">
          <label htmlFor="recurring-year" className="text-sm text-muted-foreground">
            Ejercicio del calendario
          </label>
          <select
            id="recurring-year"
            data-testid="recurring-year"
            className="h-8 rounded-md border bg-background px-2 text-sm"
            value={year}
            onChange={(event) => setYear(Number(event.target.value))}
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground">fecha de referencia {refDate}</span>
        </div>
        {canEdit && <GeneratePanel rules={rules} refDate={refDate} />}
      </div>

      {canEdit && <RecurringRuleForm />}

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid="recurring-calendar">
          <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Regla</th>
              <th className="px-3 py-2 text-left font-medium">Tipo</th>
              <th className="px-3 py-2 text-left font-medium">Vigencia</th>
              <th className="px-3 py-2 text-right font-medium">Importe</th>
              {MESES.map((m) => (
                <th key={m} className="px-1 py-2 text-center font-medium font-code">
                  {m}
                </th>
              ))}
              <th className="px-3 py-2 text-left font-medium">Estado</th>
              {canEdit && <th className="px-3 py-2 text-right font-medium">Acciones</th>}
            </tr>
          </thead>
          <tbody className="divide-y">
            {rules.map((rule) => {
              const cells = calendarOf(rule, byRule.get(rule.id) ?? [], year)
              return (
                <tr key={rule.id} className="h-8 align-middle" data-rule-code={rule.code}>
                  <td className="px-3 py-1">
                    <span className="font-code text-xs">{rule.code}</span> <span>{rule.name}</span>
                    <span className="ml-2 font-code text-[11px] text-muted-foreground">{rule.templateCode}</span>
                  </td>
                  <td className="px-3 py-1 text-xs text-muted-foreground">
                    {rule.kind} · {rule.frequency}
                  </td>
                  <td className="px-3 py-1 font-code text-xs text-muted-foreground">
                    {rule.startPeriod} – {rule.endPeriod ?? "sin fin"}
                  </td>
                  <td className="px-3 py-1 text-right">
                    {rule.amountCents === null ? (
                      <span className="text-xs text-muted-foreground" title="La cuota la aporta el cuadro (G-2)">
                        del cuadro
                      </span>
                    ) : (
                      <Amount cents={rule.amountCents} />
                    )}
                  </td>
                  {MESES.map((month) => {
                    const cell = cells.get(month)
                    if (!cell) {
                      return (
                        <td key={month} className="px-1 py-1 text-center text-muted-foreground/30">
                          —
                        </td>
                      )
                    }
                    return (
                      <td key={month} className="px-1 py-1 text-center">
                        <button
                          type="button"
                          data-testid={`cell-${rule.code}-${cell.period}`}
                          data-cell-status={cell.status}
                          title={`${cell.period} · ${CELL_LABEL[cell.status]}${cell.reason ? ` · ${cell.reason}` : ""}`}
                          onClick={() => setSelected({ rule, cell })}
                          className={cn(
                            "inline-flex h-5 w-5 items-center justify-center rounded text-[11px] leading-none",
                            CELL_CLASS[cell.status]
                          )}
                        >
                          {CELL_GLYPH[cell.status] || "·"}
                        </button>
                      </td>
                    )
                  })}
                  <td className="px-3 py-1 text-xs">{rule.status}</td>
                  {canEdit && (
                    <td className="px-3 py-1 text-right">
                      <PauseRuleDialog rule={rule} />
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <ul className="flex flex-wrap gap-4 text-xs text-muted-foreground" data-testid="recurring-legend">
        {(["GENERADA", "OMITIDA", "FALLIDA", "PENDIENTE", "NO_VENCIDO"] as CellStatus[]).map((status) => (
          <li key={status} className="flex items-center gap-1.5">
            <span className={cn("inline-flex h-4 w-4 items-center justify-center rounded text-[10px]", CELL_CLASS[status])}>
              {CELL_GLYPH[status] || "·"}
            </span>
            {CELL_LABEL[status]}
          </li>
        ))}
      </ul>

      {selected && (
        <div className="rounded-md border p-4 text-sm" data-testid="cell-detail">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p>
                <span className="font-code text-xs">{selected.rule.code}</span> · periodo{" "}
                <span className="font-code text-xs">{selected.cell.period}</span> ·{" "}
                <strong>{CELL_LABEL[selected.cell.status]}</strong>
              </p>
              {selected.cell.reason && <p className="text-muted-foreground">Motivo: {selected.cell.reason}</p>}
              {selected.cell.entryId ? (
                <Link
                  href={`/ledger/${selected.cell.entryId}`}
                  className="underline underline-offset-4"
                  data-testid="cell-entry-link"
                >
                  Ver el asiento generado
                </Link>
              ) : (
                <p className="text-muted-foreground">Este periodo no tiene asiento contabilizado.</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {isAdmin && selected.cell.occurrenceId && selected.cell.entryId && (
                <RevertOccurrenceDialog occurrenceId={selected.cell.occurrenceId} period={selected.cell.period} />
              )}
              <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(null)}>
                Cerrar
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Los periodos de la regla que caen en el año, colocados en la columna del mes
 * en que **terminan** (un trimestre se pinta en marzo, junio, septiembre y
 * diciembre). Es una colocación de pantalla, no un cálculo contable.
 */
function calendarOf(rule: RecurringRuleSummary, occurrences: OccurrenceRow[], year: number): Map<string, CalendarCell> {
  const anchors: readonly { month: string; period: string }[] =
    rule.frequency === "MENSUAL"
      ? MESES.map((m) => ({ month: m, period: `${year}-${m}` }))
      : rule.frequency === "TRIMESTRAL"
        ? [
            { month: "03", period: `${year}-Q1` },
            { month: "06", period: `${year}-Q2` },
            { month: "09", period: `${year}-Q3` },
            { month: "12", period: `${year}-Q4` },
          ]
        : rule.frequency === "SEMESTRAL"
          ? [
              { month: "06", period: `${year}-S1` },
              { month: "12", period: `${year}-S2` },
            ]
          : [{ month: "12", period: `${year}-A` }]

  const byPeriod = new Map(occurrences.map((o) => [o.period, o]))
  const pending = new Set(rule.pendingPeriods)
  const out = new Map<string, CalendarCell>()

  for (const { month, period } of anchors) {
    const occurrence = byPeriod.get(period)
    let status: CellStatus
    if (occurrence) {
      status = occurrence.status as CellStatus
    } else if (period < rule.startPeriod || (rule.endPeriod !== null && period > rule.endPeriod)) {
      status = "FUERA_DE_VIGENCIA"
    } else if (pending.has(period)) {
      status = "PENDIENTE"
    } else {
      status = "NO_VENCIDO"
    }
    out.set(month, {
      period,
      status,
      reason: occurrence?.reason ?? null,
      entryId: occurrence?.entryId ?? null,
      occurrenceId: occurrence?.id ?? null,
    })
  }
  return out
}
