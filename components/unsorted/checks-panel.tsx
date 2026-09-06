import { CheckStatusChip } from "@/components/ui/check-status"
import type { CheckView } from "@/components/unsorted/types"
import { cn } from "@/lib/utils"

/**
 * E8 · T15 — Panel «Comprobaciones»: RC-01…RC-25 con su veredicto (§6).
 *
 * Tres cosas que este panel tiene que dejar claras y que una lista de PASS/FAIL
 * no dice por sí sola:
 *
 *  1. **Qué bloquea el asiento** — un `FAIL` y no hay borrador; no existe forma
 *     de forzarlo (R6), así que el botón se apaga y el motivo se escribe.
 *  2. **Qué bloquea el LOTE sin ser un fallo** — la categoría que O-19 inventó
 *     precisamente para esto: una retención no practicada o una deducibilidad
 *     pendiente no son errores aritméticos, pero contabilizar cincuenta
 *     documentos así de golpe es lo que nadie quiere descubrir en una
 *     inspección. Se marcan con la chapa «bloquea el lote».
 *  3. **Con qué evidencia** — la que el motor selló, sin reinterpretarla.
 */

export function ChecksPanel({ checks, className }: { checks: readonly CheckView[]; className?: string }) {
  const fails = checks.filter((c) => c.status === "FAIL")
  const warns = checks.filter((c) => c.status === "WARN")
  const blocking = checks.filter((c) => c.blocksBatch)

  return (
    <section className={cn("space-y-3", className)} data-testid="checks-panel">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-tight">Comprobaciones</h2>
        <p className="text-xs text-muted-foreground">
          {checks.length} reglas · {fails.length} sin conformidad · {warns.length} con aviso ·{" "}
          {blocking.length} bloquean el lote
        </p>
      </header>

      {checks.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
          Este documento todavía no se ha reconciliado: no hay comprobaciones que enseñar.
        </p>
      ) : (
        <ul className="divide-y rounded-md border text-sm">
          {checks.map((check) => (
            <li
              key={check.id}
              className={cn("flex flex-col gap-1 px-3 py-2", check.status !== "PASS" && "bg-muted/30")}
              data-check-id={check.id}
              data-check-status={check.status}
              data-blocks-batch={check.blocksBatch ? "true" : "false"}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-code w-16 shrink-0 text-xs">{check.id}</span>
                <CheckStatusChip status={check.status} />
                {check.blocksBatch && (
                  <span className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-1.5 py-0.5 text-[11px] leading-none">
                    bloquea el lote
                  </span>
                )}
                <span className="min-w-0 flex-1">{check.message}</span>
              </div>
              {check.fields.length > 0 && (
                <p className="pl-16 text-[11px] text-muted-foreground">
                  Campos: <span className="font-code">{check.fields.join(", ")}</span>
                </p>
              )}
              {check.status !== "PASS" && Object.keys(check.evidence).length > 0 && (
                <p className="pl-16 font-code text-[11px] break-all text-muted-foreground">
                  {JSON.stringify(check.evidence)}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
