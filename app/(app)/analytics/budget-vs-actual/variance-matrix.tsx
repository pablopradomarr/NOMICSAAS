"use client"

import { analyticCellDetailAction, allocationCellDetailAction } from "@/app/(app)/analytics/actions"
import { budgetCellDetailAction, type BudgetCellDetail } from "@/app/(app)/analytics/budget-vs-actual/actions"
import { formatVarianceBps, type ColumnLabel } from "@/app/(app)/analytics/budget-vs-actual/shared"
import { MARGIN_LEVEL_LABELS } from "@/components/analytics/types"
import type { AllocationCellDetail, CellDetail } from "@/models/margins"
import { AmountPlain } from "@/components/ledger/amount"
import { Button } from "@/components/ui/button"
import { ConfidenceBadge } from "@/components/ui/confidence-badge"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { MARGIN_LEVELS } from "@/lib/analytics/types"
import Link from "next/link"
import { useState, useTransition } from "react"

/**
 * E10 · T16 — la matriz de E4 **con las cinco columnas por celda** (§5.1).
 *
 * Tres reglas que esta pantalla no negocia:
 *
 *  · **Cero aritmética contable en el cliente.** Presupuesto, real, desviación
 *    absoluta, desviación en puntos básicos y forecast vienen los cinco del
 *    servidor, celda a celda. Aquí sólo se eligen el orden y la etiqueta.
 *  · **Una celda `notComparable` no se pinta: se explica** (O-E10-4, I-E10-18).
 *    Presupuesto y real tienen que estar en el mismo estado de imputación; si el
 *    presupuesto no ha podido seguir al real, las tres columnas derivadas salen
 *    en blanco con su leyenda, nunca calculadas.
 *  · **Sin presupuesto, vacío con leyenda, nunca 0** (regla del comparativo de
 *    ADR-0012): un 0 es una cifra y afirmaría algo falso.
 *
 * **Drill-down en ≤ 3 clics**: celda (1) → el desglose con las tres consultas de
 * la procedencia —diario, reparto y presupuesto— y sus líneas → el enlace del
 * asiento (2) → el libro diario con el asiento (3).
 */

export type VarianceRow = {
  level: string
  column: string
  actualCents: number
  budgetCents: number | null
  varianceCents: number | null
  varianceBps: number | null
  forecastCents: number | null
  notComparable: boolean
}

type DrillState = {
  level: string
  column: string
  columnLabel: string
  loading: boolean
  actual: CellDetail | null
  allocation: AllocationCellDetail | null
  budget: BudgetCellDetail | null
  errors: string[]
}

export function VarianceMatrix({
  rows,
  columns,
  period,
  budgetId,
  withAllocations,
  notSettleableReason,
  currency,
}: {
  rows: readonly VarianceRow[]
  columns: readonly ColumnLabel[]
  period: { from: string; to: string; fiscalYearId?: string }
  /** Versión efectiva, para la TERCERA consulta de la procedencia. */
  budgetId: string | null
  withAllocations: boolean
  notSettleableReason: string | null
  currency: string
}) {
  const [drill, setDrill] = useState<DrillState | null>(null)
  const [, start] = useTransition()

  const byColumn = new Map<string, ColumnLabel>(columns.map((c) => [c.key, c]))
  const levelsWithRows = MARGIN_LEVELS.filter((level) => rows.some((r) => r.level === level))

  const open = (row: VarianceRow): void => {
    const label = byColumn.get(row.column)?.label ?? row.column
    setDrill({
      level: row.level,
      column: row.column,
      columnLabel: label,
      loading: true,
      actual: null,
      allocation: null,
      budget: null,
      errors: [],
    })
    start(async () => {
      const errors: string[] = []
      // En SERIE: tres acciones, cada una con su transacción de tenant.
      const actual = await analyticCellDetailAction({
        level: row.level,
        column: row.column,
        from: period.from,
        to: period.to,
        ...(period.fiscalYearId ? { fiscalYearId: period.fiscalYearId } : {}),
      })
      if (!actual.success) errors.push(`Diario: ${actual.error ?? "error desconocido"}`)
      const allocation = withAllocations
        ? await allocationCellDetailAction({ level: row.level, column: row.column, from: period.from, to: period.to })
        : null
      if (allocation && !allocation.success) errors.push(`Reparto: ${allocation.error ?? "error desconocido"}`)
      const budget = budgetId
        ? await budgetCellDetailAction({ budgetId, level: row.level, column: row.column })
        : null
      if (budget && !budget.success) errors.push(`Presupuesto: ${budget.error ?? "error desconocido"}`)
      setDrill({
        level: row.level,
        column: row.column,
        columnLabel: label,
        loading: false,
        actual: actual.success ? (actual.data ?? null) : null,
        allocation: allocation?.success ? (allocation.data ?? null) : null,
        budget: budget?.success ? (budget.data ?? null) : null,
        errors,
      })
    })
  }

  if (rows.length === 0) {
    return (
      <p className="rounded-md border p-6 text-sm text-muted-foreground" data-testid="variance-empty">
        No hay ninguna celda que comparar en este periodo: ni el diario ni la versión de presupuesto aportan importe.
        Carga el presupuesto del ejercicio en{" "}
        <Link href="/analytics/budget" className="underline underline-offset-2">
          Analítica → Presupuesto
        </Link>{" "}
        y vuelve aquí.
      </p>
    )
  }

  return (
    <>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid="variance-matrix">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Columna</th>
              <th className="px-3 py-2 text-right font-medium">Presupuesto</th>
              <th className="px-3 py-2 text-right font-medium">Real</th>
              <th className="px-3 py-2 text-right font-medium">Desviación</th>
              <th className="px-3 py-2 text-right font-medium">Desv. %</th>
              <th className="px-3 py-2 text-right font-medium">Forecast</th>
            </tr>
          </thead>
          {levelsWithRows.map((level) => {
            const levelRows = rows
              .filter((r) => r.level === level)
              .sort((a, b) => {
                const ca = byColumn.get(a.column)
                const cb = byColumn.get(b.column)
                return (ca?.label ?? a.column).localeCompare(cb?.label ?? b.column, "es")
              })
            return (
              <tbody key={level} className="divide-y" data-level={level}>
                <tr className="bg-[#F7F7F7]">
                  <th colSpan={6} className="px-3 py-1.5 text-left text-xs font-semibold uppercase tracking-wide">
                    {MARGIN_LEVEL_LABELS[level] ?? level}
                  </th>
                </tr>
                {levelRows.map((row) => {
                  const col = byColumn.get(row.column)
                  return (
                    <tr
                      key={`${level}|${row.column}`}
                      className="h-8"
                      data-testid="variance-row"
                      data-level={level}
                      data-column={row.column}
                      data-not-comparable={row.notComparable ? "si" : "no"}
                    >
                      <td className="px-3 py-1">
                        <button
                          type="button"
                          className="text-left underline-offset-2 hover:underline"
                          onClick={() => open(row)}
                          data-testid="variance-cell"
                        >
                          {col?.label ?? row.column}
                        </button>
                        {col?.aggregate && (
                          <span className="ml-2 text-[11px] text-muted-foreground">
                            agregado de presentación, no suma al total
                          </span>
                        )}
                      </td>
                      {row.notComparable ? (
                        <td colSpan={5} className="px-3 py-1 text-xs text-muted-foreground" data-testid="cell-not-comparable">
                          No publicada · {notSettleableReason ?? "presupuesto y real en estados de imputación distintos"}.
                          Una desviación entre dos magnitudes que no miden lo mismo no es una desviación.
                        </td>
                      ) : (
                        <>
                          <td className="px-3 py-1 text-right" data-testid="cell-budget">
                            {row.budgetCents === null ? (
                              <span className="text-xs text-muted-foreground">sin presupuesto</span>
                            ) : (
                              <AmountPlain cents={row.budgetCents} zeroAsDash={false} />
                            )}
                          </td>
                          <td className="px-3 py-1 text-right" data-testid="cell-actual">
                            <AmountPlain cents={row.actualCents} zeroAsDash={false} />
                          </td>
                          <td className="px-3 py-1 text-right" data-testid="cell-variance">
                            {row.varianceCents === null ? (
                              <span className="text-xs text-muted-foreground">—</span>
                            ) : (
                              <AmountPlain cents={row.varianceCents} zeroAsDash={false} />
                            )}
                          </td>
                          <td className="px-3 py-1 text-right tabular-nums text-muted-foreground" data-testid="cell-variance-bps">
                            {formatVarianceBps(row.varianceBps)}
                          </td>
                          <td className="px-3 py-1 text-right" data-testid="cell-forecast">
                            {row.forecastCents === null ? (
                              <span className="text-xs text-muted-foreground">—</span>
                            ) : (
                              <AmountPlain cents={row.forecastCents} zeroAsDash={false} />
                            )}
                          </td>
                        </>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            )
          })}
        </table>
      </div>

      <Dialog open={drill !== null} onOpenChange={(value) => !value && setDrill(null)}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>
              {MARGIN_LEVEL_LABELS[drill?.level ?? ""] ?? drill?.level} · {drill?.columnLabel}
            </DialogTitle>
            <DialogDescription>
              Las <strong>tres</strong> consultas de la procedencia (§5.1): el diario, el reparto y el presupuesto. Una
              celda de desviación no se reproduce con una sola, y por eso se enseñan las tres con su importe.
            </DialogDescription>
          </DialogHeader>

          {drill?.loading && (
            <p className="text-sm text-muted-foreground" data-testid="drill-loading">
              Ejecutando las consultas de la procedencia…
            </p>
          )}

          {drill && !drill.loading && (
            <div className="max-h-[60vh] space-y-5 overflow-y-auto" data-testid="drill-detail">
              {drill.errors.length > 0 && (
                <ul className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 p-3 text-xs" role="alert">
                  {drill.errors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              )}

              <section className="space-y-1">
                <h3 className="text-sm font-semibold">
                  Real (diario) ·{" "}
                  <AmountPlain cents={drill.actual?.amountCents ?? 0} zeroAsDash={false} /> {currency}
                </h3>
                <LineTable
                  rows={(drill.actual?.lines ?? []).map((l) => ({
                    ref: `${l.entryRef}/${l.lineNo}`,
                    entryRef: l.entryRef,
                    accountCode: l.accountCode,
                    accountName: l.accountName,
                    amountCents: l.amountCents,
                  }))}
                  empty="Ninguna línea del diario aporta a esta celda en el periodo."
                  testId="drill-actual"
                />
                {drill.actual ? (
                  <p className="font-code text-[11px] text-muted-foreground">{drill.actual.query}</p>
                ) : null}
              </section>

              {withAllocations && (
                <section className="space-y-1">
                  <h3 className="text-sm font-semibold">
                    Imputado (reparto) ·{" "}
                    <AmountPlain cents={drill.allocation?.amountCents ?? 0} zeroAsDash={false} /> {currency}
                  </h3>
                  <p className="font-code text-[11px] text-muted-foreground">{drill.allocation?.query ?? "—"}</p>
                </section>
              )}

              <section className="space-y-1">
                <h3 className="text-sm font-semibold">
                  Presupuesto · <AmountPlain cents={drill.budget?.totalCents ?? 0} zeroAsDash={false} /> {currency}
                </h3>
                {!drill.budget ? (
                  <p className="text-sm text-muted-foreground">
                    No hay versión de presupuesto efectiva con la que reproducir esta celda.
                  </p>
                ) : (
                  <>
                    <div className="overflow-x-auto rounded-md border">
                      <table className="w-full text-xs" data-testid="drill-budget">
                        <thead className="bg-muted/40 uppercase tracking-wide text-muted-foreground">
                          <tr>
                            <th className="px-2 py-1 text-left font-medium">Mes</th>
                            <th className="px-2 py-1 text-left font-medium">Cuenta</th>
                            <th className="px-2 py-1 text-left font-medium">Dimensión</th>
                            <th className="px-2 py-1 text-left font-medium">Tipo analítico</th>
                            <th className="px-2 py-1 text-right font-medium">Importe</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {drill.budget.rows.length === 0 && (
                            <tr>
                              <td colSpan={5} className="px-2 py-3 text-muted-foreground">
                                La versión {drill.budget.budgetCode} no presupuesta nada en esta celda.
                              </td>
                            </tr>
                          )}
                          {drill.budget.rows.map((r, index) => (
                            <tr key={`${r.month}|${r.accountCode}|${r.dimensionCode}|${index}`} className="h-7">
                              <td className="px-2 py-1 font-code">{r.month.slice(0, 7)}</td>
                              <td className="px-2 py-1 font-code">{r.accountCode ?? "—"}</td>
                              <td className="px-2 py-1 font-code">{r.dimensionCode}</td>
                              <td className="px-2 py-1 text-muted-foreground">
                                {r.analyticType}
                                {r.signException && " · excepción de signo declarada"}
                              </td>
                              <td className="px-2 py-1 text-right">
                                <AmountPlain cents={r.amountCents} zeroAsDash={false} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="font-code text-[11px] text-muted-foreground">{drill.budget.query}</p>
                  </>
                )}
              </section>

              <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <ConfidenceBadge level="calculado" />
                La desviación es <strong>real − presupuesto</strong> en céntimos enteros, con tolerancia 0 (I-E10-2). El
                porcentaje se redondea; el importe nunca.
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function LineTable({
  rows,
  empty,
  testId,
}: {
  rows: readonly { ref: string; entryRef: string; accountCode: string; accountName: string; amountCents: number }[]
  empty: string
  testId: string
}) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-xs" data-testid={testId}>
        <thead className="bg-muted/40 uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-2 py-1 text-left font-medium">Asiento</th>
            <th className="px-2 py-1 text-left font-medium">Cuenta</th>
            <th className="px-2 py-1 text-right font-medium">Importe</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => (
            <tr key={row.ref} className="h-7">
              <td className="px-2 py-1 font-code">
                <Button asChild variant="link" size="sm" className="h-auto p-0 font-code text-xs">
                  <Link href={`/ledger?q=${encodeURIComponent(row.entryRef)}`} data-testid="drill-entry-link">
                    {row.ref}
                  </Link>
                </Button>
              </td>
              <td className="px-2 py-1">
                <span className="font-code">{row.accountCode}</span>{" "}
                <span className="text-muted-foreground">{row.accountName}</span>
              </td>
              <td className="px-2 py-1 text-right">
                <AmountPlain cents={row.amountCents} zeroAsDash={false} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
