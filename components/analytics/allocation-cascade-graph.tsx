/**
 * E5 · T11 — Diagrama de cascada (`docs/design/E5-liquidacion.md` §6).
 *
 * Entregado en la ronda 1 de corrección (revisión #16): la pantalla lo sustituía
 * por un párrafo, y el orden de ejecución —lo único que hace comprensible una
 * cascada— no se veía en ninguna parte.
 *
 * Es deliberadamente un **componente simple**, no un grafo con layout: cada fila
 * es una arista `fuente → destino` numerada por su lugar en el orden de
 * ejecución `(prioridad, código)`, agrupada por periodicidad. Un layout de grafo
 * de verdad exigiría una librería de dibujo para representar, en la práctica,
 * entre dos y seis aristas; y lo que el controller necesita saber no es la
 * geometría, es **qué se reparte antes que qué**, porque de eso depende que un
 * CECO que recibe en cascada haya recibido todo antes de repartir (I-E5-8).
 *
 * Sin dinero: sólo códigos, cuotas en puntos básicos y el orden. Todas las
 * cifras del reparto están en la simulación y en la ficha del run.
 */

import { formatBps } from "@/components/analytics/types"
import { PERIOD_LABELS, type AllocationRuleView } from "@/components/analytics/allocation-types"

type Edge = {
  step: number
  ruleCode: string
  from: string
  to: string
  /** `true` cuando el destino es OTRO centro de coste: eso es una cascada. */
  cascade: boolean
  shareBps: number
}

/**
 * Las aristas de las reglas VIGENTES, por periodicidad y en orden de ejecución.
 * Un destino que no es un centro de coste se agrega como un único nodo («3
 * proyectos», «2 líneas de negocio»): la cascada sólo la forman los CECO → CECO.
 */
export function cascadeEdges(rules: readonly AllocationRuleView[]): Map<string, Edge[]> {
  const byPeriod = new Map<string, Edge[]>()
  const ordered = rules
    .filter((r) => r.isActive)
    .sort((a, b) => a.priority - b.priority || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))

  for (const rule of ordered) {
    const list = byPeriod.get(rule.period) ?? []
    const targets =
      rule.targetKind === "COST_CENTERS"
        ? rule.targets.map((t) => ({ label: t.label, cascade: true }))
        : [
            {
              label:
                rule.targets.length > 0
                  ? rule.targets.map((t) => t.label).join(" · ")
                  : rule.targetKind === "BUSINESS_LINES"
                    ? "líneas de negocio"
                    : "proyectos elegibles",
              cascade: false,
            },
          ]
    for (const target of targets) {
      list.push({
        step: list.length + 1,
        ruleCode: rule.code,
        from: rule.sourceCostCenterCode,
        to: target.label,
        cascade: target.cascade,
        shareBps: rule.sourceShareBps,
      })
    }
    byPeriod.set(rule.period, list)
  }
  return byPeriod
}

export function AllocationCascadeGraph({ rules }: { rules: readonly AllocationRuleView[] }) {
  const byPeriod = cascadeEdges(rules)
  if (byPeriod.size === 0) return null

  return (
    <section className="space-y-3 rounded-md border p-4" data-testid="allocation-cascade-graph">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">Cascada y orden de ejecución</h2>
        <p className="text-xs text-muted-foreground">
          Dentro de cada periodicidad, las reglas se ejecutan en el orden numerado —<code>(prioridad, código)</code>—
          y ese orden tiene que ser topológico: un centro de coste que <strong>recibe</strong> en cascada reparte
          siempre después de haber recibido todo (I-E5-8). Las aristas marcadas como cascada son las que van a otro
          centro de coste.
        </p>
      </div>

      {[...byPeriod.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([period, edges]) => (
          <div key={period} className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">{PERIOD_LABELS[period] ?? period}</p>
            <ol className="space-y-1">
              {edges.map((edge) => (
                <li
                  key={`${period}-${edge.ruleCode}-${edge.to}`}
                  className="flex flex-wrap items-center gap-2 text-xs"
                  data-testid="cascade-edge"
                >
                  <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-medium">
                    {edge.step}
                  </span>
                  <code className="font-code">{edge.from}</code>
                  <span aria-hidden className="text-muted-foreground">
                    →
                  </span>
                  <code className="font-code">{edge.to}</code>
                  {edge.shareBps !== 10000 && (
                    <span className="text-muted-foreground">({formatBps(edge.shareBps)} del saldo)</span>
                  )}
                  {edge.cascade && (
                    <span className="rounded border px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                      cascada
                    </span>
                  )}
                  <span className="text-muted-foreground">· {edge.ruleCode}</span>
                </li>
              ))}
            </ol>
          </div>
        ))}
    </section>
  )
}
