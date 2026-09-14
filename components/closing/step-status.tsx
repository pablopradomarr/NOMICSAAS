import { cn } from "@/lib/utils"
import { STEP_STATUS_LABEL, type ClosingStepStatus } from "./types"

/**
 * E9 · T16 — Semáforo de un paso del cierre.
 *
 * Sin rojo/verde (`ui-erp` §Estilo): PASS es negro, FAIL y WARN llevan el ámbar
 * de aviso de la marca, INFO el gris secundario. `NA` y `PENDIENTE_RECOMPUTO`
 * son estados **propios**, no un verde tímido: un acto societario que todavía no
 * toca y un ajuste que la reapertura dejó a reevaluar (O-21) no son «cumplido».
 */
const STYLES: Record<ClosingStepStatus, string> = {
  PASS: "border-transparent bg-[#0A0A0A] text-white",
  FAIL: "border-[#F5A623] bg-[#F5A623]/15 text-[#1A202C]",
  WARN: "border-[#F5A623] bg-[#F5A623]/10 text-[#1A202C]",
  INFO: "border-transparent bg-muted text-muted-foreground",
  NA: "border-dashed border-muted-foreground/40 bg-transparent text-muted-foreground",
  PENDIENTE_RECOMPUTO: "border-[#F5A623] bg-[#F5A623]/10 text-[#1A202C]",
}

export function StepStatusChip({ status, className }: { status: ClosingStepStatus; className?: string }) {
  return (
    <span
      data-step-status={status}
      className={cn(
        "font-code inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] leading-none font-medium whitespace-nowrap",
        STYLES[status],
        className
      )}
    >
      {STEP_STATUS_LABEL[status]}
    </span>
  )
}
