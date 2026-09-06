"use client"

import {
  createAllocationRuleSetFromFormAction,
  type RawRule,
  type RawRuleTarget,
} from "@/app/(app)/analytics/allocations/ui-actions"
import {
  ALLOCATION_DRIVERS,
  DRIVER_HELP,
  DRIVER_LABELS,
  FALLBACK_HELP,
  FALLBACK_LABELS,
  PERIOD_LABELS,
  TARGET_KIND_LABELS,
  formatShareBps,
  type AllocationDimensions,
} from "@/components/analytics/allocation-types"
import { Button } from "@/components/ui/button"
import { ConfidenceBadge } from "@/components/ui/confidence-badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { parseCents } from "@/lib/money"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

/**
 * E5 · T11 — Alta del CONJUNTO de reglas de un centro de coste fuente
 * (`docs/design/E5-liquidacion.md` §6).
 *
 * Un centro de coste puede repartir su saldo en varias reglas (30 % en cascada
 * a otro CECO, 70 % a proyectos): el conjunto se declara ENTERO y se guarda en
 * una sola transacción, porque `Σ sourceShareBps = 10000` se juzga sobre el
 * conjunto y no sobre una regla suelta.
 *
 * Lo que este formulario **no** hace: no persiste ninguna conversión. El usuario
 * teclea `"1.899,54"` y `"30"`; lo que se guarda lo convierte el servidor
 * (`ui-actions.ts`, `lib/money.parseCents`).
 *
 * La banda «Σ de cuotas» que se ve mientras se escribe SÍ convierte, para poder
 * avisar: usa **el mismo `parseCents`** que el servidor (revisión ronda 1, #14 —
 * antes hacía su propio `Math.round(Number(texto.replace(",", ".")) * 100)`, es
 * decir coma flotante en el navegador sobre la cifra que mueve dinero entre
 * columnas). Sigue siendo un aviso de formulario, marcado como `calculado` y sin
 * bloquear el envío: la validación de verdad está en `forms/allocations.ts`, en
 * la acción y en los triggers de la base.
 */

const SELECT_CLASS =
  "h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"

type DraftTarget = { key: string; destinationId: string; percentText: string; amountText: string }

type DraftRule = {
  key: string
  code: string
  name: string
  driver: string
  targetKind: string
  period: string
  priority: string
  sourceSharePercentText: string
  zeroBaseFallback: string
  onlyActiveProjects: boolean
  targets: DraftTarget[]
}

let counter = 0
const nextKey = (): string => `r${++counter}`

const emptyRule = (): DraftRule => ({
  key: nextKey(),
  code: "",
  name: "",
  driver: "DIRECT_COST_SHARE",
  targetKind: "PROJECTS",
  period: "MONTH",
  priority: "10",
  sourceSharePercentText: "100",
  zeroBaseFallback: "SKIP_WARN",
  onlyActiveProjects: true,
  targets: [],
})

const emptyTarget = (): DraftTarget => ({ key: nextKey(), destinationId: "", percentText: "", amountText: "" })

/** Ayuda contextual en español contable. No es decorativa: es el criterio. */
function Help({ text, label }: { text: string; label: string }) {
  return (
    <span
      className="ml-1 inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border text-[10px] text-muted-foreground"
      title={text}
      aria-label={`${label}: ${text}`}
      data-testid="driver-help"
    >
      ?
    </span>
  )
}

export function AllocationRuleForm({
  dimensions,
  isAdmin,
  defaultValidFrom,
}: {
  dimensions: AllocationDimensions
  isAdmin: boolean
  /** Primer día del ejercicio abierto: la vigencia natural de una regla nueva. */
  defaultValidFrom: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [sourceCostCenterId, setSourceCostCenterId] = useState("")
  const [validFrom, setValidFrom] = useState(defaultValidFrom)
  const [rules, setRules] = useState<DraftRule[]>([emptyRule()])
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  if (!isAdmin) return null

  const patch = (key: string, change: Partial<DraftRule>): void =>
    setRules((current) => current.map((r) => (r.key === key ? { ...r, ...change } : r)))

  const patchTarget = (ruleKey: string, targetKey: string, change: Partial<DraftTarget>): void =>
    setRules((current) =>
      current.map((r) =>
        r.key === ruleKey
          ? { ...r, targets: r.targets.map((t) => (t.key === targetKey ? { ...t, ...change } : t)) }
          : r
      )
    )

  /**
   * Aviso de cliente, NO cifra contable: suma de las cuotas declaradas. Se
   * pinta con badge `calculado` y no bloquea el envío — el servidor manda.
   */
  const shareByPeriod = new Map<string, number>()
  for (const rule of rules) {
    // El MISMO parser que el servidor (#14): `"30"` / `"30,5"` → bps enteros.
    const bps = parseCents(rule.sourceSharePercentText) ?? 0
    shareByPeriod.set(rule.period, (shareByPeriod.get(rule.period) ?? 0) + bps)
  }
  const incompletePeriods = [...shareByPeriod.entries()].filter(([, bps]) => bps !== 10000)

  const destinationsOf = (rule: DraftRule) => {
    if (rule.targetKind === "BUSINESS_LINES") return dimensions.businessLines
    if (rule.targetKind === "COST_CENTERS") return dimensions.allocatableCostCenters
    return dimensions.projects
  }

  const destinationField = (rule: DraftRule, target: DraftTarget): RawRuleTarget => {
    if (rule.targetKind === "BUSINESS_LINES") return { businessLineId: target.destinationId }
    if (rule.targetKind === "COST_CENTERS") return { costCenterId: target.destinationId }
    return { projectId: target.destinationId }
  }

  const submit = () =>
    startTransition(async () => {
      setError(null)
      const payload: RawRule[] = rules.map((rule) => ({
        code: rule.code.trim(),
        name: rule.name.trim(),
        sourceCostCenterId,
        targetKind: rule.targetKind,
        driver: rule.driver,
        period: rule.period,
        priority: rule.priority,
        sourceSharePercentText: rule.sourceSharePercentText,
        zeroBaseFallback: rule.zeroBaseFallback,
        validFrom,
        validTo: null,
        onlyActiveProjects: rule.onlyActiveProjects && rule.targetKind === "PROJECTS",
        targets: rule.targets.map((t) => ({
          ...destinationField(rule, t),
          percentText: t.percentText,
          amountText: t.amountText,
        })),
      }))
      const state = await createAllocationRuleSetFromFormAction(payload)
      if (!state.success) {
        setError(state.error ?? "No se ha podido guardar el conjunto de reglas")
        return
      }
      setOpen(false)
      setRules([emptyRule()])
      setSourceCostCenterId("")
      router.refresh()
    })

  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)} data-testid="new-allocation-rule">
        Nuevo conjunto de reglas
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Reglas de liquidación de un centro de coste</DialogTitle>
            <DialogDescription>
              Declara de una vez todo lo que reparte este centro de coste. Las cuotas de las reglas del mismo periodo
              tienen que sumar el 100 %: lo que no se declara se queda sin liquidar y aparece como pendiente en la PyG
              analítica. La regla <strong>no se edita nunca</strong> una vez tiene liquidaciones emitidas: se versiona.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">Centro de coste fuente</span>
              <select
                aria-label="Centro de coste fuente"
                className={SELECT_CLASS}
                value={sourceCostCenterId}
                onChange={(event) => setSourceCostCenterId(event.target.value)}
                data-testid="rule-source"
              >
                <option value="">Elige un centro de coste imputable…</option>
                {dimensions.allocatableCostCenters.map((cc) => (
                  <option key={cc.id} value={cc.id}>
                    {cc.code} · {cc.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">Vigente desde</span>
              <Input
                type="date"
                aria-label="Vigente desde"
                className="h-8"
                value={validFrom}
                onChange={(event) => setValidFrom(event.target.value)}
                data-testid="rule-valid-from"
              />
            </label>
          </div>

          <div className="space-y-4">
            {rules.map((rule, index) => {
              const showTargets = rule.driver === "FIXED_PERCENT" || rule.driver === "MANUAL"
              return (
                <div key={rule.key} className="space-y-3 rounded-md border p-3" data-testid="rule-draft">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">Regla {index + 1}</span>
                    {rules.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setRules((current) => current.filter((r) => r.key !== rule.key))}
                      >
                        Quitar
                      </Button>
                    )}
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-xs font-medium text-muted-foreground">Código</span>
                      <Input
                        className="h-8 font-code text-xs"
                        aria-label={`Código de la regla ${index + 1}`}
                        value={rule.code}
                        onChange={(event) => patch(rule.key, { code: event.target.value })}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-xs font-medium text-muted-foreground">Nombre</span>
                      <Input
                        className="h-8"
                        aria-label={`Nombre de la regla ${index + 1}`}
                        value={rule.name}
                        onChange={(event) => patch(rule.key, { name: event.target.value })}
                      />
                    </label>
                  </div>

                  <div className="grid gap-3 md:grid-cols-3">
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-xs font-medium text-muted-foreground">
                        Driver
                        <Help label={DRIVER_LABELS[rule.driver] ?? rule.driver} text={DRIVER_HELP[rule.driver] ?? ""} />
                      </span>
                      <select
                        aria-label={`Driver de la regla ${index + 1}`}
                        className={SELECT_CLASS}
                        value={rule.driver}
                        onChange={(event) => {
                          // BLOQUEA #1 / ADR-0013 D4 — un driver CALCULADO
                          // pondera por proyecto leyendo el diario: si el
                          // destino elegido eran centros de coste o líneas de
                          // negocio, la regla quedaría inerte. Se vuelve a
                          // «Proyectos» en el acto en vez de dejar que el
                          // usuario guarde algo que la acción va a rechazar.
                          const driver = event.target.value
                          const explicit = driver === "FIXED_PERCENT" || driver === "MANUAL"
                          patch(rule.key, {
                            driver,
                            targets: [],
                            ...(explicit ? {} : { targetKind: "PROJECTS" }),
                          })
                        }}
                      >
                        {ALLOCATION_DRIVERS.map((driver) => (
                          <option key={driver} value={driver}>
                            {DRIVER_LABELS[driver]}
                          </option>
                        ))}
                      </select>
                      <span className="text-[11px] leading-snug text-muted-foreground">{DRIVER_HELP[rule.driver]}</span>
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-xs font-medium text-muted-foreground">Destinatarios</span>
                      <select
                        aria-label={`Destinatarios de la regla ${index + 1}`}
                        className={SELECT_CLASS}
                        value={rule.targetKind}
                        onChange={(event) => patch(rule.key, { targetKind: event.target.value, targets: [] })}
                      >
                        {(showTargets ? ["PROJECTS", "BUSINESS_LINES", "COST_CENTERS"] : ["PROJECTS"]).map((kind) => (
                          <option key={kind} value={kind}>
                            {TARGET_KIND_LABELS[kind]}
                          </option>
                        ))}
                      </select>
                      {!showTargets && (
                        <span className="text-[11px] leading-snug text-muted-foreground">
                          Este driver calcula los pesos por proyecto leyendo el diario. Para repartir a líneas de
                          negocio o a otros centros de coste, elige porcentaje fijo o importes manuales.
                        </span>
                      )}
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-xs font-medium text-muted-foreground">Periodicidad</span>
                      <select
                        aria-label={`Periodicidad de la regla ${index + 1}`}
                        className={SELECT_CLASS}
                        value={rule.period}
                        onChange={(event) => patch(rule.key, { period: event.target.value })}
                      >
                        {["MONTH", "QUARTER", "YEAR"].map((period) => (
                          <option key={period} value={period}>
                            {PERIOD_LABELS[period]}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="grid gap-3 md:grid-cols-3">
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-xs font-medium text-muted-foreground">Prioridad (orden topológico)</span>
                      <Input
                        className="h-8"
                        aria-label={`Prioridad de la regla ${index + 1}`}
                        value={rule.priority}
                        onChange={(event) => patch(rule.key, { priority: event.target.value })}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-xs font-medium text-muted-foreground">Cuota del saldo (%)</span>
                      <Input
                        className="h-8"
                        aria-label={`Cuota del saldo de la regla ${index + 1}`}
                        value={rule.sourceSharePercentText}
                        onChange={(event) => patch(rule.key, { sourceSharePercentText: event.target.value })}
                        data-testid="rule-source-share"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-xs font-medium text-muted-foreground">
                        Si la base es cero
                        <Help label="Base cero" text={FALLBACK_HELP[rule.zeroBaseFallback] ?? ""} />
                      </span>
                      <select
                        aria-label={`Base cero de la regla ${index + 1}`}
                        className={SELECT_CLASS}
                        value={rule.zeroBaseFallback}
                        onChange={(event) => patch(rule.key, { zeroBaseFallback: event.target.value })}
                      >
                        {["SKIP_WARN", "EQUAL", "YTD", "PRIOR_PERIOD"].map((fb) => (
                          <option key={fb} value={fb}>
                            {FALLBACK_LABELS[fb]}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  {rule.targetKind === "PROJECTS" && (
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={rule.onlyActiveProjects}
                        onChange={(event) => patch(rule.key, { onlyActiveProjects: event.target.checked })}
                      />
                      Sólo proyectos activos
                    </label>
                  )}

                  {showTargets && (
                    <div className="space-y-2 rounded-md bg-muted/30 p-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-muted-foreground">
                          {rule.driver === "MANUAL" ? "Importes declarados (€)" : "Destinos y porcentajes"}
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => patch(rule.key, { targets: [...rule.targets, emptyTarget()] })}
                          data-testid="add-target"
                        >
                          Añadir destino
                        </Button>
                      </div>
                      {rule.targets.length === 0 && (
                        <p className="text-[11px] text-muted-foreground">
                          {rule.driver === "MANUAL"
                            ? "Una regla manual necesita al menos un importe declarado, y los importes tienen que sumar la base liquidable del periodo."
                            : "Los destinos de una regla de porcentaje fijo tienen que sumar exactamente el 100 %."}
                        </p>
                      )}
                      {rule.targets.map((target) => (
                        <div key={target.key} className="grid gap-2 md:grid-cols-[2fr_1fr_auto]">
                          <select
                            aria-label="Destino"
                            className={SELECT_CLASS}
                            value={target.destinationId}
                            onChange={(event) => patchTarget(rule.key, target.key, { destinationId: event.target.value })}
                          >
                            <option value="">Elige destino…</option>
                            {destinationsOf(rule).map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.code} · {option.name}
                              </option>
                            ))}
                          </select>
                          <Input
                            className="h-8"
                            aria-label={rule.driver === "MANUAL" ? "Importe en euros" : "Porcentaje"}
                            placeholder={rule.driver === "MANUAL" ? "1.899,54" : "60"}
                            value={rule.driver === "MANUAL" ? target.amountText : target.percentText}
                            onChange={(event) =>
                              patchTarget(
                                rule.key,
                                target.key,
                                rule.driver === "MANUAL"
                                  ? { amountText: event.target.value }
                                  : { percentText: event.target.value }
                              )
                            }
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              patch(rule.key, { targets: rule.targets.filter((t) => t.key !== target.key) })
                            }
                          >
                            Quitar
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm">
            <span>
              Cuotas declaradas por periodicidad:{" "}
              <strong className="font-code" data-testid="share-sum">
                {[...shareByPeriod.entries()]
                  .map(([period, bps]) => `${PERIOD_LABELS[period]} ${formatShareBps(bps)}`)
                  .join(" · ")}
              </strong>
              <ConfidenceBadge
                level="calculado"
                className="ml-2 align-middle"
                title="Aviso del formulario, sumado en el navegador. La comprobación de verdad (Σ = 100 % por centro de coste y periodicidad) la hace el servidor."
              />
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setRules((current) => [...current, emptyRule()])}
              data-testid="add-rule"
            >
              Añadir otra regla al conjunto
            </Button>
          </div>

          {incompletePeriods.length > 0 && (
            <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-xs" role="status">
              Las reglas de un mismo centro de coste y periodicidad deben repartir el 100 % de su saldo. Ahora mismo
              declaras{" "}
              {incompletePeriods
                .map(([period, bps]) => `${PERIOD_LABELS[period]} ${formatShareBps(bps)}`)
                .join(", ")}
              : el resto quedaría sin liquidar.
            </p>
          )}

          {error && (
            <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert" data-testid="rule-error">
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
              disabled={pending || sourceCostCenterId === ""}
              data-testid="save-allocation-rules"
            >
              {pending ? "Guardando…" : "Guardar conjunto"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
