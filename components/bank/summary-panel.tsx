import { Amount } from "@/components/ledger/amount"
import { ConfidenceBadge } from "@/components/ui/confidence-badge"

import { PENDING_KIND_LABEL, type PendingView, type SummaryView } from "./types"

/**
 * E7 · T16 — El panel de cuadre de una cuenta bancaria (I-E7-1).
 *
 * La identidad que se enseña es **`E − B = Ue − Ub`**, con `Ue` y `Ub`
 * **enumerados uno a uno y tipados**, no una diferencia sin nombre:
 *
 * | | |
 * |---|---|
 * | `E` | saldo del extracto a la fecha de corte, **declarado por el banco** |
 * | `B` | saldo contable de la 57x (la apertura entra, el cierre no) |
 * | `Ue` | Σ de las líneas de extracto **no** conciliadas |
 * | `Ub` | Σ de los apuntes de la 57x **no** conciliados |
 *
 * Tres cosas que este panel enseña siempre porque esconderlas es lo que hace
 * que una diferencia reaparezca en el cierre:
 *
 * · **La Σ de ignorados como línea propia** del cuadre (O-12), con su recuento y
 *   los de importe cero aparte —que suman 0 por definición—.
 * · **La antigüedad** de cada pendiente y si está **explicado**, con el criterio
 *   verificable de §3.6: listar un pendiente no lo explica.
 * · **Sin anclaje o con hueco en la cadena, el cuadre no da PASS**: sale como no
 *   evaluable y dice por qué.
 *
 * Ninguna de estas cifras se calcula aquí: llegan de `reconciliationSummary()`,
 * la misma derivación que usa el invariante.
 */

function PendingList({ items, title, testId }: { items: readonly PendingView[]; title: string; testId: string }) {
  return (
    <div data-testid={testId}>
      <p className="text-xs font-medium">
        {title} ({items.length})
      </p>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">Ninguno.</p>
      ) : (
        <ul className="mt-1 max-h-56 space-y-1 overflow-y-auto text-xs">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-baseline gap-x-2 border-b pb-1">
              <span className="tabular-nums">{item.date}</span>
              <Amount cents={item.amountCents} zeroAsDash={false} />
              <span className="text-muted-foreground">{item.description}</span>
              <span className={item.kind ? "" : "text-[#8a6100]"}>
                {item.kind ? PENDING_KIND_LABEL[item.kind] : "sin tipar"}
              </span>
              <span className="text-muted-foreground">{item.ageDays} día(s)</span>
              <span className={item.explicado ? "text-muted-foreground" : "text-[#8a6100]"}>
                {item.explicado ? "explicado" : "sin explicar"}: {item.motivo}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function ReconciliationSummaryPanel({ summary }: { summary: SummaryView }) {
  return (
    <section className="space-y-3 rounded-md border p-3" data-testid="cuadre">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">
          Cuadre a {summary.cutoff} · cuenta <span className="font-code">{summary.accountCode}</span> ({summary.currency})
        </h2>
        <ConfidenceBadge level={summary.badge === "validado" ? "validado" : summary.badge === "comprobado" ? "comprobado" : "calculado"} />
      </div>

      {!summary.anchored && (
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert" data-testid="sin-anclaje">
          Esta cuenta <strong>no tiene anclaje</strong>: nadie ha declarado desde qué fecha está conciliada ni con qué
          saldo. Hasta que lo tenga, el cuadre es informativo (INFO), nunca PASS, y la tesorería no puede llevar el sello
          «validado contra fuente».
        </p>
      )}

      {!summary.chainCovered && summary.anchored && (
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert" data-testid="hueco-cadena">
          <strong>Hueco en la cadena de extractos</strong>:{" "}
          {summary.chainGaps.map((gap) => `${gap.from} → ${gap.to}`).join(" · ")}. Falta extracto por importar: mientras
          exista el hueco, el cuadre no puede afirmar nada.
        </p>
      )}

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <div className="rounded border px-3 py-2">
          <p className="text-xs text-muted-foreground">E · saldo del extracto</p>
          {summary.saldoExtractoCents === null ? (
            <p className="text-sm text-muted-foreground">no declarado</p>
          ) : (
            <Amount cents={summary.saldoExtractoCents} currency={summary.currency} zeroAsDash={false} className="text-base font-semibold" />
          )}
        </div>
        <div className="rounded border px-3 py-2">
          <p className="text-xs text-muted-foreground">B · saldo contable</p>
          <Amount cents={summary.saldoContableCents} currency={summary.currency} zeroAsDash={false} className="text-base font-semibold" />
        </div>
        <div className="rounded border px-3 py-2">
          <p className="text-xs text-muted-foreground">Ue · pendientes del banco</p>
          <Amount cents={summary.ueCents} currency={summary.currency} zeroAsDash={false} className="text-base font-semibold" />
        </div>
        <div className="rounded border px-3 py-2">
          <p className="text-xs text-muted-foreground">Ub · pendientes de los libros</p>
          <Amount cents={summary.ubCents} currency={summary.currency} zeroAsDash={false} className="text-base font-semibold" />
        </div>
        <div
          className="rounded border px-3 py-2"
          data-testid="cuadre-diferencia"
          data-cents={summary.diferenciaCents ?? ""}
        >
          <p className="text-xs text-muted-foreground">(E − B) − (Ue − Ub)</p>
          {summary.diferenciaCents === null ? (
            <p className="text-sm text-muted-foreground">no evaluable</p>
          ) : (
            <Amount cents={summary.diferenciaCents} currency={summary.currency} zeroAsDash={false} className="text-base font-semibold" />
          )}
        </div>
      </div>

      <p className="text-sm" data-testid="cuadre-veredicto">
        {summary.diferenciaCents === null ? (
          <>
            ⚠ Cuadre no evaluable: {summary.motivoNoEvaluable ?? "faltan anclaje o cadena de extractos"}.
          </>
        ) : summary.diferenciaCents === 0 ? (
          <>✓ El cuadre es exacto: E − B = Ue − Ub, con tolerancia cero.</>
        ) : (
          <>
            ⚠ El cuadre no cierra por <Amount cents={summary.diferenciaCents} currency={summary.currency} zeroAsDash={false} />. La
            diferencia no está en ningún pendiente enumerado: hay un movimiento o un apunte que nadie ha explicado.
          </>
        )}
      </p>

      <div className="grid gap-3 lg:grid-cols-2">
        <PendingList items={summary.pendientesBanco} title="Pendientes del banco (Ue)" testId="pendientes-banco" />
        <PendingList items={summary.pendientesLibros} title="Pendientes de los libros (Ub)" testId="pendientes-libros" />
      </div>

      <div className="rounded border px-3 py-2 text-sm" data-testid="ignorados">
        <span className="font-medium">Σ ignorado</span>:{" "}
        <Amount cents={summary.ignoradosCents} currency={summary.currency} zeroAsDash={false} /> en{" "}
        {summary.ignoradosCount} línea(s), de las cuales {summary.importeCeroCount} son de importe cero y suman cero por
        definición. Los ignorados entran en Ue y además se declaran aquí: sacarlos del cuadre lo descuadraría por su
        importe exacto.
      </div>

      {summary.diferenciaDeCambioCents !== null && (
        <div className="rounded border px-3 py-2 text-sm" data-testid="diferencia-de-cambio">
          <span className="font-medium">Diferencia de cambio pendiente de reconocer</span>:{" "}
          <Amount cents={summary.diferenciaDeCambioCents} zeroAsDash={false} /> (NRV 11ª.2.2, a 768/668). No es un
          pendiente de conciliación y jamás aparece en Ue ni en Ub: si apareciera, el cuadre se estaría haciendo en la
          divisa equivocada.
        </div>
      )}

      {summary.pendientesAntiguosCount > 0 && (
        <p className="text-xs text-[#8a6100]" data-testid="pendientes-antiguos">
          {summary.pendientesAntiguosCount} pendiente(s) por encima del plazo declarado para partidas en tránsito. El
          sello del periodo lo recoge con el motivo <span className="font-code">PARTIDA_EN_TRANSITO_ANTIGUA</span>.
        </p>
      )}

      {summary.regularizationLineIds.length > 0 && (
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert">
          Hay {summary.regularizationLineIds.length} apunte(s) de regularización sobre la 57x. La regularización no toca
          tesorería: esto es un error contable que el cuadre delata en vez de absorber.
        </p>
      )}
    </section>
  )
}
