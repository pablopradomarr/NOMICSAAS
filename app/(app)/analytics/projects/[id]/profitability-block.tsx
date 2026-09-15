import { AmountPlain } from "@/components/ledger/amount"
import { ConfidenceBadge } from "@/components/ui/confidence-badge"
import type { AbsorptionReport } from "@/lib/time/cost"
import type { BudgetProfitabilityRow } from "@/models/reports"
import Link from "next/link"

/**
 * E10 · T16 — Bloque de **rentabilidad con horas** de la ficha de proyecto
 * (`docs/design/E10-presupuesto-horas.md` §5.2 y §7).
 *
 * Todas las cifras salen del **mismo** `ReportRun` que el informe de presupuesto
 * vs real, para que la ficha del proyecto y el informe no puedan divergir. Aquí
 * no se divide ni se multiplica nada.
 *
 * Dos cosas que la pantalla dice y que no son adorno:
 *
 *  · **La `basis` viaja con la cifra** (Q-1): `BRUTO_SIN_SS` y
 *    `COSTE_EMPRESA_CON_SS` difieren ~31,9 %, y comparar un coste-hora de una
 *    base con otro de otra es comparar dos magnitudes distintas.
 *  · **No evaluable no es cero** (R-R-1): con 0 minutos, sin tarifa vigente o
 *    con bases en conflicto, la celda dice *no evaluable* y su motivo. Un ratio
 *    con denominador cero no vale cero: no existe.
 */

const BASIS_LABELS: Record<string, string> = {
  BRUTO_SIN_SS: "bruto sin SS",
  COSTE_EMPRESA_CON_SS: "coste empresa con SS",
  COSTE_TOTAL_CON_ESTRUCTURA: "coste total con estructura",
}

const NOT_EVALUABLE_LABELS: Record<string, string> = {
  SIN_MINUTOS: "sin minutos imputados en el periodo",
  TARIFA_AUSENTE: "hay partes sin tarifa vigente",
  RATE_BASIS_CONFLICT: "los empleados que intervinieron tienen bases distintas",
  BASIS_CONFLICT: "los empleados que intervinieron tienen bases distintas",
}

/** Minutos → `hh:mm`, con el signo del contra-apunte a la vista. */
export function formatHhMm(minutes: number): string {
  const sign = minutes < 0 ? "−" : ""
  const abs = Math.abs(minutes)
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`
}

const formatBps = (bps: number | null): string => {
  if (bps === null) return "—"
  const sign = bps < 0 ? "−" : ""
  const magnitude = Math.abs(bps)
  return `${sign}${Math.floor(magnitude / 100)},${String(magnitude % 100).padStart(2, "0")} %`
}

const ABSORPTION_LABELS: Record<string, string> = {
  SOBREABSORCION: "sobreabsorción",
  INFRAABSORCION: "infraabsorción",
  // El desglose agrupa lo valorado por el CECO del EMPLEADO y la nómina por el
  // CECO de la línea 64x: una unidad cuya gente imputa pero cuya nómina se
  // contabiliza en otro sitio NO está sobreabsorbiendo, es que ahí no hay nada
  // que absorber.
  SIN_NOMINA_QUE_ABSORBER: "sin nómina que absorber en este CECO",
  EXACTA: "absorción exacta",
}

export function ProfitabilityBlock({
  row,
  absorption,
  currency,
  sealed,
  unavailableReason,
}: {
  row: BudgetProfitabilityRow | null
  absorption: AbsorptionReport | null
  currency: string
  sealed: boolean
  /** Por qué no hay bloque: sin informe, sin presupuesto sellado, sin horas. */
  unavailableReason: string | null
}) {
  if (unavailableReason !== null || row === null) {
    return (
      <section className="space-y-2" data-testid="project-profitability">
        <h2 className="text-sm font-semibold tracking-tight">Rentabilidad con horas</h2>
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground" data-testid="profitability-empty">
          <strong>No evaluable:</strong>{" "}
          {unavailableReason ?? "este proyecto no tiene partes de horas aprobados y productivos en el periodo"}. Captura
          los partes en <Link href="/time" className="underline underline-offset-2">Horas</Link> y fija las tarifas en{" "}
          <Link href="/settings/employees" className="underline underline-offset-2">Empleados</Link>: sin horas no hay
          margen por hora, y una cifra sin denominador no es cero, es una cifra que no existe.
        </p>
      </section>
    )
  }

  const basis = row.basis ? (BASIS_LABELS[row.basis] ?? row.basis) : null
  const reason = row.notEvaluableReason
    ? (NOT_EVALUABLE_LABELS[row.notEvaluableReason] ?? row.notEvaluableReason)
    : null

  return (
    <section className="space-y-3" data-testid="project-profitability">
      <h2 className="text-sm font-semibold tracking-tight">
        Rentabilidad con horas {!sealed && <span className="text-xs font-normal text-muted-foreground">· previsualización no sellada</span>}
      </h2>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid="profitability-table">
          <tbody className="divide-y">
            <Metric label="Horas reales (aprobadas y productivas)" testId="actual-minutes">
              <span className="tabular-nums" data-minutes={row.actualMinutes}>
                {formatHhMm(row.actualMinutes)}
              </span>
            </Metric>
            <Metric label="Horas presupuestadas" testId="budget-minutes">
              {row.budgetMinutes === null ? (
                <span className="text-xs text-muted-foreground">no se presupuestaron</span>
              ) : (
                <span className="tabular-nums" data-minutes={row.budgetMinutes}>
                  {formatHhMm(row.budgetMinutes)}
                </span>
              )}
            </Metric>
            <Metric label="Desviación de horas" testId="minutes-variance">
              {row.minutesVariance === null ? (
                <span className="text-xs text-muted-foreground">—</span>
              ) : (
                <span className="tabular-nums" data-minutes={row.minutesVariance}>
                  {formatHhMm(row.minutesVariance)}
                </span>
              )}
            </Metric>
            <Metric label="Coste-hora medio" testId="hourly-cost">
              {row.hourlyCostCents === null ? (
                <span className="text-xs text-muted-foreground">No evaluable{reason ? `: ${reason}` : ""}</span>
              ) : (
                <>
                  <AmountPlain cents={row.hourlyCostCents} zeroAsDash={false} /> {currency}
                  {basis && <span className="ml-2 text-[11px] text-muted-foreground">base: {basis}</span>}
                </>
              )}
            </Metric>
            <Metric label="Margen por hora (MC2)" testId="margin-mc2">
              {row.marginPerHourMc2Cents === null ? (
                <span className="text-xs text-muted-foreground">No evaluable: sin minutos</span>
              ) : (
                <>
                  <AmountPlain cents={row.marginPerHourMc2Cents} zeroAsDash={false} /> {currency}
                </>
              )}
            </Metric>
            <Metric
              label="Margen por hora (MC3)"
              testId="margin-mc3"
              note="MC3 depende de una política de reparto; MC2 no. Por eso se publican los dos."
            >
              {row.marginPerHourMc3Cents === null ? (
                <span className="text-xs text-muted-foreground">No evaluable: sin minutos</span>
              ) : (
                <>
                  <AmountPlain cents={row.marginPerHourMc3Cents} zeroAsDash={false} /> {currency}
                </>
              )}
            </Metric>
            <Metric label="Tarifa media facturada" testId="billed-rate">
              {row.billedRatePerHourCents === null ? (
                <span className="text-xs text-muted-foreground">No evaluable: sin minutos</span>
              ) : (
                <>
                  <AmountPlain cents={row.billedRatePerHourCents} zeroAsDash={false} /> {currency}
                </>
              )}
            </Metric>
          </tbody>
        </table>
      </div>

      {absorption && (
        <div className="space-y-2" data-testid="absorption-block">
          <h3 className="text-sm font-semibold tracking-tight">
            Desviación de absorción ·{" "}
            <span data-absorption-direction={absorption.direction}>
              {ABSORPTION_LABELS[absorption.direction] ?? absorption.direction}
            </span>
          </h3>
          <p className="text-sm">
            Valorado por tarifa <AmountPlain cents={absorption.valuedCents} zeroAsDash={false} /> {currency} − nómina
            contabilizada (64x) <AmountPlain cents={absorption.payrollCents} zeroAsDash={false} /> {currency} ={" "}
            <strong>
              <AmountPlain cents={absorption.absorptionCents} zeroAsDash={false} /> {currency}
            </strong>{" "}
            ({formatBps(absorption.absorptionBps)})
          </p>
          {absorption.byCostCenter.length > 0 && (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-xs" data-testid="absorption-by-ceco">
                <thead className="bg-muted/40 uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1 text-left font-medium">Centro de coste</th>
                    <th className="px-2 py-1 text-right font-medium">Valorado</th>
                    <th className="px-2 py-1 text-right font-medium">Nómina</th>
                    <th className="px-2 py-1 text-right font-medium">Absorción</th>
                    <th className="px-2 py-1 text-right font-medium">%</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {absorption.byCostCenter.map((r) => (
                    <tr key={r.code} className="h-7" data-ceco={r.code}>
                      <td className="px-2 py-1 font-code">{r.code}</td>
                      <td className="px-2 py-1 text-right">
                        <AmountPlain cents={r.valuedCents} zeroAsDash={false} />
                      </td>
                      <td className="px-2 py-1 text-right">
                        <AmountPlain cents={r.payrollCents} zeroAsDash={false} />
                      </td>
                      <td className="px-2 py-1 text-right">
                        <AmountPlain cents={r.absorptionCents} zeroAsDash={false} />
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{formatBps(r.absorptionBps)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Es <strong>información de gestión, no un error de cuadre</strong>: I-E10-12 sólo garantiza que lo imputado
            no exceda lo contabilizado, así que una infraabsorción pasa el invariante en silencio y es esta cifra la que
            la enseña.
          </p>
        </div>
      )}

      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <ConfidenceBadge level="calculado" />
        Los ratios <strong>no se persisten</strong> (ADR-0003): viajan en el resultado del informe, que sí es una foto
        sellada. Un coste-hora «con SS» y otro «sin SS» difieren ≈ 31,9 % y no son comparables: por eso la base se
        imprime siempre junto a la cifra.
      </p>

      <ProfitabilityContract />
    </section>
  )
}

/**
 * **E11 · ola C · T21 — el contrato del bloque, declarado** (deuda C3 de E10).
 *
 * E10 dejó el bloque «abierto, sin fecha propia»: publicaba unas cifras y no
 * decía cuáles eran ni de dónde salían, de modo que nadie podía saber si le
 * faltaba algo. Lo que se cierra aquí es el **contrato**, no el desglose: qué
 * publica el bloque, con qué procedencia, y qué **no** publica todavía y en qué
 * épica llega. Un bloque cuyo alcance no está escrito es un bloque que crece por
 * acumulación y acaba divergiendo del informe del que sale.
 *
 * El desglose **mensual** y la descomposición **volumen/precio** dependen de la
 * celda mensual, que va a E12 con el CAPEX del presupuesto (§0.3 de E11): hasta
 * entonces el bloque publica lo de §5.2 de E10 y lo dice.
 */
export const PROFITABILITY_BLOCK_CONTRACT = {
  /** Toda cifra sale del MISMO `ReportRun` que el informe de presupuesto vs real. */
  source: "ReportRun de presupuesto vs real (familia PRESUPUESTO)",
  publishes: [
    "horas reales aprobadas y productivas",
    "horas presupuestadas y su desviación",
    "coste-hora medio con su base (`basis`)",
    "coste de las horas y margen por hora",
    "absorción de la nómina del CECO con su motivo",
  ],
  /** Lo que el bloque NO publica, con la épica en que llega. */
  deferred: [
    { what: "desglose mensual de las cinco cifras", epic: "E12" },
    { what: "descomposición volumen/precio de la desviación", epic: "E12" },
  ],
  /** Ninguna cifra se persiste ni se calcula en el cliente. */
  persisted: false,
} as const

function ProfitabilityContract() {
  return (
    <details className="text-xs text-muted-foreground" data-testid="profitability-contract">
      <summary className="cursor-pointer">Qué publica este bloque, y qué no</summary>
      <div className="mt-2 space-y-1">
        <p>
          Procedencia: <strong>{PROFITABILITY_BLOCK_CONTRACT.source}</strong>. Las cifras de la ficha del proyecto y las
          del informe son las mismas, del mismo run, para que no puedan divergir.
        </p>
        <p>Publica: {PROFITABILITY_BLOCK_CONTRACT.publishes.join(" · ")}.</p>
        <p>
          Todavía no publica:{" "}
          {PROFITABILITY_BLOCK_CONTRACT.deferred.map((d) => `${d.what} (${d.epic})`).join(" · ")}. Se declara aquí para
          que la ausencia se lea como una ausencia y no como un cero.
        </p>
      </div>
    </details>
  )
}

function Metric({
  label,
  children,
  testId,
  note,
}: {
  label: string
  children: React.ReactNode
  testId: string
  note?: string
}) {
  return (
    <tr className="h-8" data-testid={testId}>
      <td className="px-3 py-1 font-medium">
        {label}
        {note && <span className="ml-2 text-[11px] font-normal text-muted-foreground">{note}</span>}
      </td>
      <td className="px-3 py-1 text-right">{children}</td>
    </tr>
  )
}
