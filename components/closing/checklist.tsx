import { AnswerStepDialog, PostStepDialog } from "@/components/closing/step-dialogs"
import { StepStatusChip } from "@/components/closing/step-status"
import Link from "next/link"

import { NATURE_LABEL, type ClosingBlockView, type ClosingStepView } from "./types"

/**
 * E9 · T16 — Los 43 pasos del cierre en sus **nueve bloques** (§7, O-29).
 *
 * Server Component: el veredicto de cada paso lo selló el `ClosingRun` y aquí
 * sólo se pinta. Tres reglas de la pantalla:
 *
 * · **Semáforo por paso con su evidencia literal**, incluida la de los pasos que
 *   no se pudieron evaluar —que salen `INFO` diciendo qué falta, jamás en verde—.
 * · **Drill-down en ≤ 3 clics** (CLAUDE.md §Estándar de calidad): bloque → paso →
 *   asiento, y del asiento al documento por la ficha del diario. Cuando el paso
 *   trae `query`, se enseña **literal** como `registros_origen`: se lee, no se
 *   ejecuta.
 * · **Los nueve bloqueantes van marcados** en la propia fila: sin ellos en PASS
 *   el ejercicio no se cierra, y la barrera está en el servidor.
 */

function StepRow({
  step,
  fiscalYearId,
  isAdmin,
  canPost,
}: {
  step: ClosingStepView
  fiscalYearId: string
  isAdmin: boolean
  canPost: boolean
}) {
  const declarable = step.nature === "DECLARADO" || step.nature === "POSTERIOR"
  return (
    <details className="border-b last:border-0" data-testid={`step-${step.step}`} data-status={step.status}>
      <summary className="flex cursor-pointer list-none items-center gap-3 py-2 pr-2 hover:bg-muted/40">
        <StepStatusChip status={step.status} />
        <span className="min-w-0 flex-1 text-sm">
          {step.titulo}
          {step.blocking && (
            <span
              className="ml-2 rounded border border-[#0A0A0A] px-1 py-px text-[10px] font-semibold tracking-wide uppercase"
              data-testid="blocking-mark"
            >
              bloqueante
            </span>
          )}
        </span>
        <span className="font-code hidden shrink-0 text-[11px] text-muted-foreground sm:inline">{step.step}</span>
      </summary>

      <div className="space-y-2 py-2 pl-2 text-sm">
        <p className="text-muted-foreground">{step.evidencia}</p>
        <p className="text-xs text-muted-foreground">
          {NATURE_LABEL[step.nature]}
          {step.norma ? ` · ${step.norma}` : ""}
          {step.answer ? ` · respuesta declarada: ${step.answer.status}${step.answer.note ? ` — ${step.answer.note}` : ""}` : ""}
        </p>

        {step.entry && (
          <p className="text-sm">
            <Link href={`/ledger/${step.entry.id}`} className="underline underline-offset-2" data-testid="step-entry-link">
              Asiento nº {step.entry.entryNumber ?? "—"}
              {step.entry.entryDate ? ` de ${step.entry.entryDate}` : ""}
            </Link>
            {step.entry.description ? <span className="text-muted-foreground"> · {step.entry.description}</span> : null}
          </p>
        )}

        {step.query && (
          <details data-testid="registros-origen">
            <summary className="cursor-pointer text-xs text-muted-foreground">registros_origen</summary>
            <pre className="font-code mt-1 overflow-x-auto rounded bg-muted p-2 text-[11px] whitespace-pre-wrap">
              {step.query}
            </pre>
          </details>
        )}

        {isAdmin && (declarable || (canPost && step.templateCode)) && (
          <div className="flex flex-wrap gap-2 pt-1">
            {declarable && <AnswerStepDialog fiscalYearId={fiscalYearId} step={step} />}
            {canPost && step.templateCode && <PostStepDialog fiscalYearId={fiscalYearId} step={step} />}
          </div>
        )}
      </div>
    </details>
  )
}

export function ClosingChecklist({
  blocks,
  fiscalYearId,
  isAdmin,
  canPost,
}: {
  blocks: readonly ClosingBlockView[]
  fiscalYearId: string
  /** ADMIN: responder pasos y postear asientos. Oculta **y** protege. */
  isAdmin: boolean
  /** El ejercicio sigue abierto: con el ejercicio cerrado no se postea nada. */
  canPost: boolean
}) {
  return (
    <section className="space-y-3" data-testid="closing-checklist">
      <h2 className="text-lg font-semibold">Comprobaciones del cierre</h2>
      <div className="space-y-2">
        {blocks.map((block) => {
          const problemas = block.counts.FAIL + block.counts.WARN + block.counts.PENDIENTE_RECOMPUTO
          return (
            <details
              key={block.block}
              open={problemas > 0}
              className="rounded-md border"
              data-testid={`block-${block.block}`}
            >
              <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2 text-sm font-medium hover:bg-muted/40">
                <span className="flex-1">{block.label}</span>
                <span className="font-code text-[11px] text-muted-foreground">
                  {block.counts.PASS}/{block.steps.length} PASS
                  {problemas > 0 ? ` · ${problemas} por revisar` : ""}
                </span>
              </summary>
              <div className="px-3 pb-1">
                {block.steps.map((step) => (
                  <StepRow key={step.step} step={step} fiscalYearId={fiscalYearId} isAdmin={isAdmin} canPost={canPost} />
                ))}
              </div>
            </details>
          )
        })}
      </div>
    </section>
  )
}
