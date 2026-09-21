import { AmountPlain } from "@/components/ledger/amount"

/**
 * E12 · T19 (Q-6 / ADR-0018 D6) — **volumen y precio**, con el cruce al precio.
 *
 * Dos cifras con dueño: el **volumen** lo controla producción y se mide a
 * condiciones del plan; el **precio** es la decisión comercial, y se mide sobre
 * la actividad realmente ejecutada. Un tercer término «cruce» es
 * matemáticamente honesto e inservible en un comité, porque nadie tiene
 * responsabilidad sobre él — por eso el cruce va al precio y no aparte.
 *
 * Y la tabla imprime la comprobación: **volumen + precio = total**, exacto. El
 * precio se calcula como residuo precisamente para que esa fila cuadre siempre,
 * porque el precio unitario no se almacena y `importe / horas` no es exacto.
 */

export type VolumePriceView = {
  column: string
  level: string
  budgetQuantity: number
  actualQuantity: number
  split: {
    totalCents: number
    volumeCents: number
    priceCents: number
    allVolume: boolean
    notMeasurable: boolean
  }
}

/** Minutos a `h:mm`. 440 minutos son `7:20`, exacto: nunca 7,33 h. */
const hhmm = (minutes: number): string => {
  const sign = minutes < 0 ? "-" : ""
  const abs = Math.abs(minutes)
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`
}

export function VolumePriceTable({ rows }: { rows: readonly VolumePriceView[] }) {
  if (rows.length === 0) {
    return (
      <section className="space-y-2" data-testid="volume-price-empty">
        <h2 className="text-sm font-semibold tracking-tight">Volumen y precio</h2>
        <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          Sin horas presupuestadas ni imputadas no hay base de actividad con la que separar el efecto volumen del
          efecto precio. La descomposición <strong>no se publica</strong>: dos ceros parecerían una medición.
        </p>
      </section>
    )
  }

  return (
    <section className="space-y-2" data-testid="volume-price">
      <h2 className="text-sm font-semibold tracking-tight">Volumen y precio · ingresos por proyecto</h2>
      <p className="max-w-3xl text-xs text-muted-foreground">
        El efecto <strong>volumen</strong> se mide al precio del plan —es lo que controla producción—; el efecto{" "}
        <strong>precio</strong>, sobre la actividad realmente ejecutada, y absorbe el término cruzado (Q-6 / D6). No se
        descompone el efecto mezcla: exigiría una jerarquía de producto que el modelo no tiene.
      </p>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Proyecto</th>
              <th className="px-3 py-2 text-right font-medium">Horas ppto</th>
              <th className="px-3 py-2 text-right font-medium">Horas real</th>
              <th className="px-3 py-2 text-right font-medium">Δ volumen</th>
              <th className="px-3 py-2 text-right font-medium">Δ precio</th>
              <th className="px-3 py-2 text-right font-medium">Δ total</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => (
              <tr key={row.column} className="h-8" data-testid={`vp-${row.column}`}>
                <td className="whitespace-nowrap px-3 py-1">{row.column.replace(/^PROJ:/, "")}</td>
                <td className="px-3 py-1 text-right tabular-nums">{hhmm(row.budgetQuantity)}</td>
                <td className="px-3 py-1 text-right tabular-nums">{hhmm(row.actualQuantity)}</td>
                {row.split.notMeasurable ? (
                  <td className="px-3 py-1 text-right text-xs text-muted-foreground" colSpan={2}>
                    sin base de actividad
                  </td>
                ) : (
                  <>
                    <td className="px-3 py-1 text-right tabular-nums" data-testid={`vp-${row.column}-volumen`}>
                      <AmountPlain cents={row.split.volumeCents} zeroAsDash={false} />
                      {row.split.allVolume && (
                        <span className="ml-1 text-xs text-muted-foreground" title="Sin cantidad presupuestada no hay precio de plan con el que comparar">
                          (todo)
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1 text-right tabular-nums" data-testid={`vp-${row.column}-precio`}>
                      <AmountPlain cents={row.split.priceCents} zeroAsDash={false} />
                    </td>
                  </>
                )}
                <td className="px-3 py-1 text-right font-medium tabular-nums">
                  <AmountPlain cents={row.split.totalCents} zeroAsDash={false} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Comprobación: volumen + precio = total, con <strong>tolerancia 0</strong>. El precio se obtiene como residuo
        porque el precio unitario no se almacena; calcularlo aparte dejaría un céntimo huérfano que nadie sabría
        explicar.
      </p>
    </section>
  )
}
