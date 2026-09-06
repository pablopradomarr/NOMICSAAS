import { CheckStatusChip, type CheckStatusValue } from "@/components/ui/check-status"
import type { RunOptionView } from "@/components/unsorted/types"
import { cn } from "@/lib/utils"
import Link from "next/link"
import { fechaHoraUtc } from "@/lib/dates-ui"

/**
 * E8 · T15 — Selector de `ExtractionRun` (§6, ADR-0014 D5).
 *
 * La cadena `parentRunId` es la historia del documento: la extracción del
 * modelo primero y, colgadas de ella, las revisiones humanas. **Un run no se
 * edita jamás** —corregir es insertar—, así que aquí no hay nada que guardar:
 * sólo se elige cuál se está mirando, y el que respalda el asiento es el
 * último de la cadena.
 *
 * Cada entrada dice lo que hace falta para juzgarla sin abrir la base: cuándo,
 * quién (proveedor y modelo), con qué prompt (`promptSha` corto), cuántas
 * páginas vio de las que tiene el documento y qué veredicto sacó.
 */

const STATUS_CHIP: Readonly<Record<string, CheckStatusValue>> = {
  PASS: "PASS",
  WARN: "WARN",
  FAIL: "FAIL",
}

const KIND_LABEL: Readonly<Record<string, string>> = {
  LLM: "Extracción automática",
  MANUAL: "Revisión humana",
  IMPORTED: "Importado sin origen",
}

export function RunSelector({
  runs,
  selectedRunId,
  fileId,
}: {
  runs: readonly RunOptionView[]
  selectedRunId: string
  fileId: string
}) {
  return (
    <section className="space-y-2" data-testid="run-selector">
      <h2 className="text-sm font-semibold tracking-tight">Extracciones de este documento</h2>
      <ul className="divide-y rounded-md border text-sm">
        {runs.map((run) => {
          const selected = run.id === selectedRunId
          return (
            <li key={run.id} data-run-id={run.id} data-selected={selected ? "true" : "false"}>
              <Link
                href={`/unsorted/${fileId}?run=${run.id}`}
                className={cn(
                  "flex flex-wrap items-center gap-2 px-3 py-2 hover:bg-muted/50",
                  selected && "bg-muted/60"
                )}
              >
                <span className="font-code w-6 shrink-0 text-xs text-muted-foreground">#{run.ordinal}</span>
                <span className="font-medium">{KIND_LABEL[run.kind] ?? run.kind}</span>
                <span className="text-xs text-muted-foreground">
                  {fechaHoraUtc(run.createdAt)} · {run.provider}/{run.model}
                </span>
                <span className="font-code text-[11px] text-muted-foreground" title="sha del prompt efectivo">
                  prompt {run.promptShaShort} · esquema {run.schemaVersion}
                </span>
                <span
                  className={cn("text-xs", run.partial && "font-medium")}
                  data-testid={selected ? "selected-run-pages" : undefined}
                >
                  {run.pagesSent} de {run.pagesTotal} páginas
                </span>
                {run.reconcileStatus && STATUS_CHIP[run.reconcileStatus] && (
                  <CheckStatusChip status={STATUS_CHIP[run.reconcileStatus]} />
                )}
                {run.partial && (
                  <span className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-1.5 py-0.5 text-[11px] leading-none">
                    parcial
                  </span>
                )}
              </Link>
            </li>
          )
        })}
      </ul>
      <p className="text-[11px] text-muted-foreground">
        Las extracciones son inmutables: corregir una propuesta no la modifica, crea una revisión colgada de ella. El
        asiento apunta al run que la persona confirmó, y el del modelo queda intacto.
      </p>
    </section>
  )
}
