import { AmountPlain } from "@/components/ledger/amount"

/**
 * E12 · T19 (deuda 12) — **el desglose mes a mes** de la desviación.
 *
 * Es lo primero que un CFO abre cuando el año cuadra, y hasta E12 no existía:
 * `granularity: MONTH` servía **un solo mes** y pedir enero-a-junio devolvía el
 * acumulado. Un total anual en su sitio puede esconder un mayo catastrófico
 * compensado por un septiembre irrepetible.
 *
 * Tres decisiones de esta tabla:
 *
 *  1. **Un mes sin movimiento se pinta a cero, no se omite.** Un hueco en la
 *     serie se lee como «no hubo datos», y lo que hubo fue cero.
 *  2. **El peor mes se nombra**, con su cifra. Es el gemelo temporal de
 *     O-E10-18: sin él, dos meses que se compensan firman el año en verde.
 *  3. **La Σ de la fila se imprime al lado del acumulado**, para que se vea que
 *     cuadran. Si alguna vez no cuadraran, se vería aquí y no en una auditoría.
 */

export type MonthlyPointView = {
  month: string
  actualCents: number
  budgetCents: number | null
  varianceCents: number | null
  notComparable: boolean
}

export type MonthlySeriesView = {
  level: string
  column: string
  points: MonthlyPointView[]
  totalActualCents: number
  totalBudgetCents: number | null
  totalVarianceCents: number | null
  anyNotComparable: boolean
}

const monthShort = (month: string): string =>
  ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"][
    Number(month.slice(5, 7)) - 1
  ] ?? month

/** El mes que más pesa en la desviación, en valor absoluto. */
function worst(series: MonthlySeriesView): MonthlyPointView | null {
  let best: MonthlyPointView | null = null
  for (const p of series.points) {
    if (p.varianceCents === null) continue
    if (best === null || Math.abs(p.varianceCents) > Math.abs(best.varianceCents ?? 0)) best = p
  }
  return best
}

export function MonthlyBreakdown({
  series,
  levelLabels,
  columnLabels,
}: {
  series: readonly MonthlySeriesView[]
  levelLabels: Readonly<Record<string, string>>
  columnLabels?: Readonly<Record<string, string>>
}) {
  if (series.length === 0) {
    return (
      <section className="space-y-2" data-testid="monthly-breakdown-empty">
        <h2 className="text-sm font-semibold tracking-tight">Desglose mes a mes</h2>
        <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          Elige la granularidad <strong>Mes</strong> para ver la desviación mes a mes. En las demás, el informe sólo
          compone el acumulado — y componer doce matrices que nadie va a enseñar no sale gratis.
        </p>
      </section>
    )
  }

  const months = series[0]!.points.map((p) => p.month)

  return (
    <section className="space-y-2" data-testid="monthly-breakdown">
      <h2 className="text-sm font-semibold tracking-tight">Desglose mes a mes · desviación</h2>
      <p className="max-w-3xl text-xs text-muted-foreground">
        Un total anual en su sitio puede esconder dos meses que se compensan. La columna <strong>peor mes</strong> lo
        nombra, y la de <strong>Σ meses</strong> tiene que coincidir con el acumulado del informe.
      </p>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Nivel · columna</th>
              {months.map((m) => (
                <th key={m} className="px-2 py-2 text-right font-medium">
                  {monthShort(m)}
                </th>
              ))}
              <th className="px-3 py-2 text-right font-medium">Σ meses</th>
              <th className="px-3 py-2 text-right font-medium">Peor mes</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {series.map((s) => {
              const peor = worst(s)
              return (
                <tr key={`${s.level}/${s.column}`} className="h-8" data-testid={`serie-${s.level}-${s.column}`}>
                  <td className="whitespace-nowrap px-3 py-1">
                    <span className="font-medium">{levelLabels[s.level] ?? s.level}</span>{" "}
                    <span className="text-muted-foreground">{columnLabels?.[s.column] ?? s.column}</span>
                  </td>
                  {s.points.map((p) => (
                    <td key={p.month} className="px-2 py-1 text-right tabular-nums">
                      {p.varianceCents === null ? (
                        <span className="text-muted-foreground" title="No comparable (I-E10-18)">
                          —
                        </span>
                      ) : (
                        <AmountPlain cents={p.varianceCents} zeroAsDash={false} />
                      )}
                    </td>
                  ))}
                  <td className="px-3 py-1 text-right font-medium tabular-nums">
                    {s.totalVarianceCents === null ? "—" : <AmountPlain cents={s.totalVarianceCents} zeroAsDash={false} />}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1 text-right tabular-nums">
                    {peor === null ? (
                      "—"
                    ) : (
                      <>
                        <span className="text-muted-foreground">{monthShort(peor.month)} </span>
                        <AmountPlain cents={peor.varianceCents ?? 0} zeroAsDash={false} />
                      </>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {series.some((s) => s.anyNotComparable) && (
        <p className="text-xs text-muted-foreground" data-testid="monthly-not-comparable">
          Las celdas con «—» no se publican: el presupuesto y el real están en estados de imputación distintos
          (I-E10-18). La liquidación de estructura es <strong>anual por construcción</strong> y trocearla por meses
          exigiría una regla de reparto temporal que nadie ha decidido — preferimos no publicarla a publicarla mal.
        </p>
      )}
    </section>
  )
}
