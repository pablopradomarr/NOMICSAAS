"use client"

import {
  closeAllocationRuleAction,
  supersedeAllocationRuleAction,
} from "@/app/(app)/analytics/allocations/actions"
import {
  DRIVER_HELP,
  DRIVER_LABELS,
  FALLBACK_LABELS,
  PERIOD_LABELS,
  TARGET_KIND_LABELS,
  formatShareBps,
  type AllocationRuleView,
  type SourceShareGroup,
} from "@/components/analytics/allocation-types"
import { AmountPlain, formatLocalDate } from "@/components/ledger/amount"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { MIN_ALLOCATION_REASON } from "@/forms/allocations"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

/**
 * E5 · T11 — Tabla de reglas de liquidación (`E5-liquidacion.md` §6).
 *
 * Reglas vigentes y, colapsadas, las versiones históricas. Cada fila enseña de
 * dónde sale el importe (centro de coste fuente), con qué criterio se reparte
 * (driver, con su explicación contable en el tooltip), a quién, en qué
 * periodicidad, en qué orden y desde cuándo. Las cuotas van en puntos básicos
 * y los importes en céntimos: aquí no se calcula nada.
 *
 * Una regla con liquidaciones emitidas **no se edita**: se versiona (se cierra
 * la vigente y nace la sucesora con el mismo código) o se cierra. Las dos cosas
 * exigen ADMIN y motivo, y quedan en `AuditLog`.
 */
export function AllocationRulesTable({
  rules,
  shareGroups,
  isAdmin,
  currency,
}: {
  rules: readonly AllocationRuleView[]
  shareGroups: readonly SourceShareGroup[]
  isAdmin: boolean
  currency: string
}) {
  const [showClosed, setShowClosed] = useState(false)
  const active = rules.filter((r) => r.isActive)
  const closed = rules.filter((r) => !r.isActive)
  const visible = showClosed ? [...active, ...closed] : active
  const incomplete = shareGroups.filter((g) => g.totalBps !== 10000)

  return (
    <div className="space-y-4">
      {incomplete.length > 0 && (
        <div
          className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-3 text-sm"
          role="status"
          data-testid="share-warning"
        >
          <p className="font-medium">Hay centros de coste que no declaran el 100 % de su saldo</p>
          <ul className="mt-1 space-y-1 text-xs">
            {incomplete.map((group) => (
              <li key={`${group.sourceCostCenterCode}|${group.period}`}>
                <span className="font-code">{group.sourceCostCenterCode}</span> · {PERIOD_LABELS[group.period]}: las
                reglas {group.ruleCodes.join(", ")} declaran {formatShareBps(group.totalBps)}. El resto se queda sin
                liquidar y aparecerá como <strong>pendiente de liquidar</strong> en la PyG analítica.
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {active.length} regla{active.length === 1 ? "" : "s"} vigente{active.length === 1 ? "" : "s"}
          {closed.length > 0 && ` · ${closed.length} versión${closed.length === 1 ? "" : "es"} histórica${closed.length === 1 ? "" : "s"}`}
        </p>
        {closed.length > 0 && (
          <Button type="button" variant="outline" size="sm" onClick={() => setShowClosed((v) => !v)} data-testid="toggle-closed-rules">
            {showClosed ? "Ocultar versiones históricas" : "Ver versiones históricas"}
          </Button>
        )}
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid="allocation-rules-table">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Código</th>
              <th className="px-3 py-2 text-left font-medium">Centro de coste fuente</th>
              <th className="px-3 py-2 text-left font-medium">Driver</th>
              <th className="px-3 py-2 text-left font-medium">Destinatarios</th>
              <th className="px-3 py-2 text-left font-medium">Periodicidad</th>
              <th className="px-3 py-2 text-right font-medium">Prioridad</th>
              <th className="px-3 py-2 text-right font-medium">Cuota</th>
              <th className="px-3 py-2 text-left font-medium">Vigencia</th>
              <th className="px-3 py-2 text-left font-medium">Destinos</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {visible.length === 0 && (
              <tr>
                <td className="px-3 py-6 text-sm text-muted-foreground" colSpan={10} data-testid="allocation-rules-empty">
                  Todavía no hay ninguna regla de liquidación. Mientras no la haya, el saldo de los centros de coste
                  imputables se queda en su columna y el MC3 de los proyectos no incluye estructura.
                </td>
              </tr>
            )}
            {visible.map((rule) => (
              <tr key={rule.id} className="h-8 align-top" data-rule-code={rule.code} data-rule-active={rule.isActive}>
                <td className="px-3 py-1 font-code text-xs">
                  {rule.code}
                  {!rule.isActive && <span className="ml-2 text-[11px] text-muted-foreground">(histórica)</span>}
                  <span className="block text-[11px] font-normal text-muted-foreground">{rule.name}</span>
                </td>
                <td className="px-3 py-1">
                  <span className="font-code text-xs">{rule.sourceCostCenterCode}</span>
                  <span className="block text-[11px] text-muted-foreground">{rule.sourceCostCenterName}</span>
                </td>
                <td className="px-3 py-1 text-xs" title={DRIVER_HELP[rule.driver] ?? ""}>
                  {DRIVER_LABELS[rule.driver] ?? rule.driver}
                </td>
                <td className="px-3 py-1 text-xs">{TARGET_KIND_LABELS[rule.targetKind] ?? rule.targetKind}</td>
                <td className="px-3 py-1 text-xs">{PERIOD_LABELS[rule.period] ?? rule.period}</td>
                <td className="px-3 py-1 text-right tabular-nums">{rule.priority}</td>
                <td className="px-3 py-1 text-right font-code text-xs" data-rule-share={rule.sourceShareBps}>
                  {formatShareBps(rule.sourceShareBps)}
                </td>
                <td className="px-3 py-1 text-xs whitespace-nowrap">
                  {formatLocalDate(rule.validFrom)} – {rule.validTo ? formatLocalDate(rule.validTo) : "sin fin"}
                  <span className="block text-[11px] text-muted-foreground">
                    Base cero: {FALLBACK_LABELS[rule.zeroBaseFallback] ?? rule.zeroBaseFallback}
                  </span>
                </td>
                <td className="px-3 py-1 text-xs">
                  {rule.targets.length === 0 ? (
                    <span className="text-muted-foreground">del diario</span>
                  ) : (
                    <ul className="space-y-0.5">
                      {rule.targets.map((t, i) => (
                        <li key={`${rule.id}-${i}`} className="whitespace-nowrap">
                          <span className="font-code">{t.label}</span>{" "}
                          {t.percentBps !== null ? (
                            <span className="tabular-nums">{formatShareBps(t.percentBps)}</span>
                          ) : (
                            <AmountPlain cents={t.amountCents ?? 0} />
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="px-3 py-1 text-right whitespace-nowrap">
                  {isAdmin && rule.isActive && (
                    <span className="inline-flex gap-1">
                      <SupersedeRuleDialog rule={rule} />
                      <CloseRuleDialog rule={rule} />
                    </span>
                  )}
                  {rule.lineCount > 0 && (
                    <span className="ml-2 text-[11px] text-muted-foreground">{rule.lineCount} líneas emitidas</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        Aviso de método: un reparto <strong>a partes iguales</strong> cobra lo mismo a un proyecto de 2 M€ que a uno de
        20 k€. Es una elección de política, no un hecho observado. Moneda base {currency}.
      </p>
    </div>
  )
}

function SupersedeRuleDialog({ rule }: { rule: AllocationRuleView }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [validFrom, setValidFrom] = useState(rule.validFrom)
  const [priority, setPriority] = useState(String(rule.priority))
  const [sharePercent, setSharePercent] = useState((rule.sourceShareBps / 100).toString())
  const [name, setName] = useState(rule.name)
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const submit = () =>
    startTransition(async () => {
      setError(null)
      const bps = Math.round(Number(sharePercent.replace(",", ".")) * 100)
      const state = await supersedeAllocationRuleAction({
        ruleId: rule.id,
        validFrom,
        reason: reason.trim(),
        changes: {
          name: name.trim(),
          priority: Number.parseInt(priority, 10),
          sourceShareBps: Number.isFinite(bps) ? bps : rule.sourceShareBps,
        },
      })
      if (!state.success) {
        setError(state.error ?? "No se ha podido versionar la regla")
        return
      }
      setOpen(false)
      router.refresh()
    })

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} data-testid={`supersede-${rule.code}`}>
        Versionar
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Versionar la regla {rule.code}</DialogTitle>
            <DialogDescription>
              La regla vigente se cierra el día anterior y nace una sucesora con el mismo código. Las liquidaciones ya
              emitidas <strong>no se tocan</strong>: siguen apuntando a la versión con la que se calcularon, que es lo
              que hace reproducible cualquier informe histórico.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">La sucesora entra en vigor el</span>
              <Input type="date" className="h-8" aria-label="Vigente desde" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">Nombre</span>
              <Input className="h-8" aria-label="Nombre de la regla" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs font-medium text-muted-foreground">Prioridad</span>
                <Input className="h-8" aria-label="Prioridad" value={priority} onChange={(e) => setPriority(e.target.value)} />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs font-medium text-muted-foreground">Cuota del saldo (%)</span>
                <Input className="h-8" aria-label="Cuota del saldo" value={sharePercent} onChange={(e) => setSharePercent(e.target.value)} />
              </label>
            </div>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">
                Motivo del cambio de política (mínimo {MIN_ALLOCATION_REASON} caracteres)
              </span>
              <Textarea rows={3} aria-label="Motivo del cambio de política" value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
          </div>

          {error && (
            <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="button" onClick={submit} disabled={pending || reason.trim().length < MIN_ALLOCATION_REASON}>
              {pending ? "Versionando…" : "Versionar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function CloseRuleDialog({ rule }: { rule: AllocationRuleView }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [validTo, setValidTo] = useState(rule.validTo ?? "")
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const submit = () =>
    startTransition(async () => {
      setError(null)
      const state = await closeAllocationRuleAction({ ruleId: rule.id, validTo, reason: reason.trim() })
      if (!state.success) {
        setError(state.error ?? "No se ha podido cerrar la regla")
        return
      }
      setOpen(false)
      router.refresh()
    })

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} data-testid={`close-${rule.code}`}>
        Cerrar
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Cerrar la regla {rule.code}</DialogTitle>
            <DialogDescription>
              A partir del día siguiente esta regla deja de repartir. El saldo del centro de coste que dejaba de
              absorber pasará a figurar como <strong>pendiente de liquidar</strong> en la PyG analítica.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">Último día de vigencia</span>
              <Input type="date" className="h-8" aria-label="Último día de vigencia" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">
                Motivo del cierre (mínimo {MIN_ALLOCATION_REASON} caracteres)
              </span>
              <Textarea rows={3} aria-label="Motivo del cierre" value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
          </div>

          {error && (
            <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={submit}
              disabled={pending || validTo === "" || reason.trim().length < MIN_ALLOCATION_REASON}
            >
              {pending ? "Cerrando…" : "Cerrar regla"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
