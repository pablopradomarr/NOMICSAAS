import { cn } from "@/lib/utils"

/**
 * E3 · T12 — Estado de un invariante (`CheckStatus` de `lib/ledger/invariants.ts`).
 *
 * Lo usa el desplegable "Ver validación" de la cabecera de informe para listar
 * I1, I7–I10 e I-E3-1…7. Sin semáforo rojo/verde: PASS es negro, FAIL e INFO
 * usan el ámbar de aviso de la marca (#F5A623) y el gris secundario.
 */

export type CheckStatusValue = "PASS" | "FAIL" | "WARN" | "INFO"

const STYLES: Record<CheckStatusValue, { label: string; className: string }> = {
  PASS: { label: "✓ PASS", className: "border-transparent bg-[#0A0A0A] text-white" },
  FAIL: { label: "✗ FAIL", className: "border-[#F5A623] bg-[#F5A623]/15 text-[#1A202C]" },
  WARN: { label: "⚠ WARN", className: "border-[#F5A623] bg-[#F5A623]/10 text-[#1A202C]" },
  INFO: { label: "· INFO", className: "border-transparent bg-muted text-muted-foreground" },
}

export function CheckStatusChip({ status, className }: { status: CheckStatusValue; className?: string }) {
  const spec = STYLES[status]
  return (
    <span
      data-check-status={status}
      className={cn(
        "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] leading-none font-medium whitespace-nowrap font-code",
        spec.className,
        className
      )}
    >
      {spec.label}
    </span>
  )
}

export type CheckRow = {
  id: string
  status: CheckStatusValue
  evidencia: string
  query?: string
}

/** Lista de checks del `validacion.json`, tal cual la devuelve `runInvariants`. */
export function CheckStatusList({ checks }: { checks: readonly CheckRow[] }) {
  if (checks.length === 0) {
    return <p className="text-sm text-muted-foreground">No se ha ejecutado ninguna comprobación todavía.</p>
  }
  return (
    <ul className="divide-y text-sm" data-testid="check-list">
      {checks.map((check) => (
        <li key={check.id} className="flex items-start gap-3 py-2" data-check-id={check.id}>
          <span className="font-code w-24 shrink-0 text-xs">{check.id}</span>
          <CheckStatusChip status={check.status} />
          <span className="min-w-0 flex-1 text-muted-foreground">{check.evidencia}</span>
        </li>
      ))}
    </ul>
  )
}
