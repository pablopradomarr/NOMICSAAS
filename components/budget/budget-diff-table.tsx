"use client"

/**
 * E10 · T15 — **Diff entre dos versiones** de presupuesto (§7).
 *
 * Lo que un CFO pide para ver *qué cambió la reproyección*, y lo que la
 * doctrina de «sustituir, no corregir» hace posible: las dos versiones siguen
 * ahí, enteras. El Δ de cada celda lo calcula `budgetDiffAction` en el
 * servidor; aquí sólo se pinta, con el mismo patrón de
 * `allocation-run-diff`. Nada de rojo/verde semáforo: la marca es sobria y el
 * signo va en la cifra (`ui-erp` §Tablas).
 */

import { ANALYTIC_TYPE_LABELS } from "@/components/analytics/types"
import type { BudgetDiffRowView, BudgetVersionView } from "@/components/budget/types"
import { monthLabel } from "@/components/budget/types"
import { AmountPlain } from "@/components/ledger/amount"
import { useRouter } from "next/navigation"

const SELECT_CLASS =
  "h-8 rounded-md border border-input bg-transparent px-2 text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"

export function BudgetDiffPicker({
  versions,
  fromId,
  toId,
}: {
  versions: readonly BudgetVersionView[]
  fromId: string | null
  toId: string | null
}) {
  const router = useRouter()
  const go = (next: { from?: string; to?: string }): void => {
    const from = next.from ?? fromId ?? ""
    const to = next.to ?? toId ?? ""
    router.push(`/analytics/budget/diff?from=${from}&to=${to}`)
  }

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-md border p-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs font-medium text-muted-foreground">Versión de partida</span>
        <select
          aria-label="Versión de partida"
          className={SELECT_CLASS}
          value={fromId ?? ""}
          onChange={(event) => go({ from: event.target.value })}
          data-testid="diff-from"
        >
          <option value="">Elige una versión…</option>
          {versions.map((version) => (
            <option key={version.id} value={version.id}>
              {version.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs font-medium text-muted-foreground">Versión comparada</span>
        <select
          aria-label="Versión comparada"
          className={SELECT_CLASS}
          value={toId ?? ""}
          onChange={(event) => go({ to: event.target.value })}
          data-testid="diff-to"
        >
          <option value="">Elige una versión…</option>
          {versions.map((version) => (
            <option key={version.id} value={version.id}>
              {version.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

export function BudgetDiffTable({
  rows,
  totalDeltaCents,
  fromLabel,
  toLabel,
}: {
  rows: readonly BudgetDiffRowView[]
  totalDeltaCents: number
  fromLabel: string
  toLabel: string
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-md border p-6 text-sm text-muted-foreground" data-testid="budget-diff-empty">
        Las dos versiones presupuestan exactamente lo mismo, celda a celda: no hay ninguna diferencia que enseñar.
      </p>
    )
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full border-collapse text-xs" data-testid="budget-diff">
        <thead className="bg-muted/40">
          <tr className="[&>th]:px-2 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
            <th>Mes</th>
            <th>Dimensión</th>
            <th>Cuenta</th>
            <th>Tipo analítico</th>
            <th className="text-right">{fromLabel}</th>
            <th className="text-right">{toLabel}</th>
            <th className="text-right">Δ</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t [&>td]:px-2 [&>td]:py-1" data-diff-key={row.key}>
              <td className="font-code whitespace-nowrap">{monthLabel(row.month.slice(0, 7))}</td>
              <td className="font-code whitespace-nowrap">{row.dimensionCode}</td>
              <td className="font-code">{row.accountCode ?? "—"}</td>
              <td className="text-muted-foreground">{ANALYTIC_TYPE_LABELS[row.analyticType] ?? row.analyticType}</td>
              <td className="text-right font-code">
                {row.fromCents === null ? <span className="text-muted-foreground">sin dato</span> : <AmountPlain cents={row.fromCents} />}
              </td>
              <td className="text-right font-code">
                {row.toCents === null ? <span className="text-muted-foreground">sin dato</span> : <AmountPlain cents={row.toCents} />}
              </td>
              <td className="text-right font-code" data-delta={row.deltaCents}>
                <AmountPlain cents={row.deltaCents} zeroAsDash={false} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t-2 bg-muted/30">
          <tr className="[&>td]:px-2 [&>td]:py-2 [&>td]:font-medium">
            <td colSpan={6}>Δ total ({rows.length} celdas cambiadas)</td>
            <td className="text-right font-code" data-testid="diff-total">
              <AmountPlain cents={totalDeltaCents} zeroAsDash={false} />
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
