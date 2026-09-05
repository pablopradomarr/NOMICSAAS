import { AmountPlain } from "@/components/ledger/amount"

/**
 * E6 · T18 — Series mensuales del panel, en **SVG en línea**.
 *
 * Paleta: la sobria de CFOnomic (`ui-erp` §Estilo) — negro `#0A0A0A`, gris
 * `#737373`, hielo `#EDF2F7`, lima `#EAFF69` sólo como acento. Es una paleta
 * deliberadamente **acromática**: el validador de la skill `dataviz` marca por
 * eso el «chroma floor», y la separación entre las dos series se resuelve como
 * la propia skill prescribe cuando el color no puede llevarla sola — con
 * **codificación secundaria**: relleno sólido frente a trama a 45°, leyenda
 * siempre presente, etiqueta directa del último punto y **tabla de datos** con
 * las mismas cifras debajo. La separación CVD entre `#0A0A0A` y `#737373` es de
 * ΔE 41 (validador de la skill), muy por encima del suelo de 8.
 *
 * Sin rojo/verde semáforo: la marca no los usa y un gasto no es «malo».
 *
 * El componente **no calcula ninguna cifra**: recibe los céntimos ya sellados
 * en el `ReportRun` y sólo los convierte en coordenadas. La única operación
 * sobre los importes es el valor absoluto de los gastos, que es geometría (la
 * altura de una barra), no contabilidad: el signo se conserva en la etiqueta,
 * en el `title` y en la tabla.
 */

export type SeriesPoint = {
  month: string
  ingresosCents: number
  gastosCents: number
  resultadoCents: number
  tesoreriaCents: number
}

const INK = "#0A0A0A"
const MUTED = "#737373"
const SURFACE = "#EDF2F7"
const GRID = "#E5E5E5"

const MONTH_LABEL = (month: string): string => month.slice(5)

/** Techo «redondo» del eje: 1, 2 o 5 × 10^n. Nunca un eje que corte la barra. */
function niceMax(value: number): number {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= step * magnitude) return step * magnitude
  }
  return 10 * magnitude
}

const euro = (cents: number): string =>
  new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
    useGrouping: "always",
  })
    .format(cents / 100)
    .replace("-", "−")

/** Barra con los dos vértices superiores redondeados (4 px), anclada a la base. */
function barPath(x: number, y: number, width: number, height: number): string {
  const r = Math.min(4, width / 2, Math.max(height, 0))
  const bottom = y + height
  if (height <= 0) return ""
  return `M${x} ${bottom} L${x} ${y + r} Q${x} ${y} ${x + r} ${y} L${x + width - r} ${y} Q${x + width} ${y} ${
    x + width
  } ${y + r} L${x + width} ${bottom} Z`
}

export function IncomeExpenseChart({ points }: { points: readonly SeriesPoint[] }) {
  const width = 720
  const height = 240
  const pad = { top: 16, right: 12, bottom: 28, left: 68 }
  const plotW = width - pad.left - pad.right
  const plotH = height - pad.top - pad.bottom

  const max = niceMax(Math.max(1, ...points.map((p) => Math.max(Math.abs(p.ingresosCents), Math.abs(p.gastosCents)))))
  const slot = points.length > 0 ? plotW / points.length : plotW
  const barW = Math.max(3, (slot - 8) / 2 - 1)
  const y = (cents: number) => pad.top + plotH - (Math.abs(cents) / max) * plotH

  return (
    <figure className="space-y-2" data-testid="chart-ingresos-gastos">
      <figcaption className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Ingresos y gastos por mes</span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: INK }} />
          Ingresos
        </span>
        <span className="flex items-center gap-1.5">
          <svg aria-hidden width="10" height="10" className="inline-block">
            <rect width="10" height="10" rx="2" fill="url(#hatch-legend)" stroke={MUTED} strokeWidth="1" />
            <defs>
              <pattern id="hatch-legend" width="4" height="4" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
                <rect width="4" height="4" fill="#FFFFFF" />
                <line x1="0" y1="0" x2="0" y2="4" stroke={MUTED} strokeWidth="2" />
              </pattern>
            </defs>
          </svg>
          Gastos (importe absoluto)
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Ingresos y gastos por mes"
        className="h-[240px] w-full"
      >
        <defs>
          <pattern id="hatch-gastos" width="5" height="5" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <rect width="5" height="5" fill={SURFACE} />
            <line x1="0" y1="0" x2="0" y2="5" stroke={MUTED} strokeWidth="2.2" />
          </pattern>
        </defs>

        {[0, 0.5, 1].map((fraction) => {
          const gy = pad.top + plotH - fraction * plotH
          return (
            <g key={fraction}>
              <line x1={pad.left} y1={gy} x2={width - pad.right} y2={gy} stroke={GRID} strokeWidth="1" />
              <text x={pad.left - 8} y={gy + 4} textAnchor="end" fontSize="10" fill={MUTED}>
                {euro(max * fraction)}
              </text>
            </g>
          )
        })}

        {points.map((point, index) => {
          const x0 = pad.left + index * slot + 4
          const yi = y(point.ingresosCents)
          const yg = y(point.gastosCents)
          return (
            <g key={point.month}>
              <path d={barPath(x0, yi, barW, pad.top + plotH - yi)} fill={INK}>
                <title>{`${point.month} · ingresos ${euro(point.ingresosCents)}`}</title>
              </path>
              {/* 2 px de separación entre barras adyacentes: el hueco lo da `+2`. */}
              <path
                d={barPath(x0 + barW + 2, yg, barW, pad.top + plotH - yg)}
                fill="url(#hatch-gastos)"
                stroke={MUTED}
                strokeWidth="1"
              >
                <title>{`${point.month} · gastos ${euro(point.gastosCents)}`}</title>
              </path>
              <text
                x={x0 + barW + 1}
                y={height - pad.bottom + 14}
                textAnchor="middle"
                fontSize="10"
                fill={MUTED}
              >
                {MONTH_LABEL(point.month)}
              </text>
            </g>
          )
        })}

        <line x1={pad.left} y1={pad.top + plotH} x2={width - pad.right} y2={pad.top + plotH} stroke={MUTED} strokeWidth="1" />
      </svg>
    </figure>
  )
}

export function TreasuryChart({ points }: { points: readonly SeriesPoint[] }) {
  const width = 720
  const height = 200
  const pad = { top: 16, right: 64, bottom: 28, left: 68 }
  const plotW = width - pad.left - pad.right
  const plotH = height - pad.top - pad.bottom

  const values = points.map((p) => p.tesoreriaCents)
  const rawMax = Math.max(1, ...values)
  const rawMin = Math.min(0, ...values)
  const max = niceMax(rawMax)
  const min = rawMin < 0 ? -niceMax(-rawMin) : 0
  const span = max - min || 1
  const x = (index: number) => pad.left + (points.length <= 1 ? 0 : (index * plotW) / (points.length - 1))
  const y = (cents: number) => pad.top + plotH - ((cents - min) / span) * plotH

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)} ${y(p.tesoreriaCents)}`).join(" ")
  const area = points.length
    ? `${line} L${x(points.length - 1)} ${y(min)} L${x(0)} ${y(min)} Z`
    : ""
  const last = points[points.length - 1]

  return (
    <figure className="space-y-2" data-testid="chart-tesoreria">
      <figcaption className="text-xs font-medium">Tesorería a fin de mes (saldo de las cuentas 57x)</figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Tesorería a fin de mes" className="h-[200px] w-full">
        {[0, 0.5, 1].map((fraction) => {
          const gy = pad.top + plotH - fraction * plotH
          return (
            <g key={fraction}>
              <line x1={pad.left} y1={gy} x2={width - pad.right} y2={gy} stroke={GRID} strokeWidth="1" />
              <text x={pad.left - 8} y={gy + 4} textAnchor="end" fontSize="10" fill={MUTED}>
                {euro(min + span * fraction)}
              </text>
            </g>
          )
        })}
        {area && <path d={area} fill={SURFACE} />}
        <path d={line} fill="none" stroke={INK} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((point, index) => (
          <circle key={point.month} cx={x(index)} cy={y(point.tesoreriaCents)} r="4" fill={INK} stroke="#FFFFFF" strokeWidth="2">
            <title>{`${point.month} · tesorería ${euro(point.tesoreriaCents)}`}</title>
          </circle>
        ))}
        {points.map((point, index) => (
          <text key={`x-${point.month}`} x={x(index)} y={height - pad.bottom + 14} textAnchor="middle" fontSize="10" fill={MUTED}>
            {MONTH_LABEL(point.month)}
          </text>
        ))}
        {last && (
          <>
            <circle cx={x(points.length - 1)} cy={y(last.tesoreriaCents)} r="5" fill={INK} stroke="#EAFF69" strokeWidth="2" />
            <text
              x={x(points.length - 1) + 10}
              y={y(last.tesoreriaCents) + 4}
              fontSize="11"
              fill={INK}
              fontWeight="600"
            >
              {euro(last.tesoreriaCents)}
            </text>
          </>
        )}
      </svg>
    </figure>
  )
}

/** Vista de tabla de las dos series: accesibilidad y lectura exacta. */
export function SeriesTable({ points }: { points: readonly SeriesPoint[] }) {
  return (
    <details className="rounded-md border p-3 text-sm">
      <summary className="cursor-pointer text-sm font-medium">Ver las series como tabla</summary>
      <div className="overflow-x-auto pt-2">
        <table className="w-full text-sm" data-testid="series-table">
          <thead className="text-xs tracking-wide text-muted-foreground uppercase">
            <tr>
              <th className="px-2 py-1 text-left font-medium">Mes</th>
              <th className="px-2 py-1 text-right font-medium">Ingresos</th>
              <th className="px-2 py-1 text-right font-medium">Gastos</th>
              <th className="px-2 py-1 text-right font-medium">Resultado</th>
              <th className="px-2 py-1 text-right font-medium">Tesorería</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {points.map((point) => (
              <tr key={point.month} className="h-8">
                <td className="px-2 py-1 font-code text-xs">{point.month}</td>
                <td className="px-2 py-1 text-right">
                  <AmountPlain cents={point.ingresosCents} />
                </td>
                <td className="px-2 py-1 text-right">
                  <AmountPlain cents={point.gastosCents} />
                </td>
                <td className="px-2 py-1 text-right">
                  <AmountPlain cents={point.resultadoCents} />
                </td>
                <td className="px-2 py-1 text-right">
                  <AmountPlain cents={point.tesoreriaCents} zeroAsDash={false} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}
