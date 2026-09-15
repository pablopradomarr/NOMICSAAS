"use client"

import {
  applyHourlyCostAction,
  createEmployeeAction,
  createEmployeeRateAction,
  listEmployeeRatesAction,
  proposeHourlyCostAction,
  type EmployeeRow,
} from "@/app/(app)/settings/employees/actions"
import { AmountPlain, formatLocalDate } from "@/components/ledger/amount"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { EmployeeRateListItem, HourlyCostProposal } from "@/models/employees"
import { parseCents } from "@/lib/money"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

/**
 * E10 · T17 — Empleados y **tarifas** (`docs/design/E10-presupuesto-horas.md` §7 y §10).
 *
 * Cuatro cosas que esta pantalla hace explícitas:
 *
 *  · **La `basis` viaja con la tarifa** (Q-1). `BRUTO_SIN_SS` y
 *    `COSTE_EMPRESA_CON_SS` difieren ≈ 31,9 %: una tarifa sin su base no es una
 *    tarifa, es un número.
 *  · **La tarifa individual sólo la ve un ADMIN** (§10): el coste-hora de una
 *    persona es su salario partido por sus horas. Para el resto la columna dice
 *    «oculta», que **no** es lo mismo que «no hay».
 *  · **Derivar de la nómina propone; no aplica** (O-E10-12). La propuesta llega
 *    con **sus términos** —ámbito, periodo, cuentas (`641` fuera y dicho),
 *    importe, minutos productivos, cobertura y fórmula— y la aplica un ADMIN.
 *  · **`COSTE_TOTAL_CON_ESTRUCTURA` con reglas de actividad vigentes** carga la
 *    estructura dos veces: el servidor lo rechaza con `RATE_BASIS_CONFLICT` y
 *    aquí se avisa antes de pedirlo.
 */

const BASES = [
  { code: "BRUTO_SIN_SS", label: "Bruto sin Seguridad Social (640)" },
  { code: "COSTE_EMPRESA_CON_SS", label: "Coste empresa con Seguridad Social (640 + 642 + 649)" },
  { code: "COSTE_TOTAL_CON_ESTRUCTURA", label: "Coste total con estructura" },
] as const

const BASIS_SHORT: Record<string, string> = {
  BRUTO_SIN_SS: "bruto sin SS",
  COSTE_EMPRESA_CON_SS: "coste empresa con SS",
  COSTE_TOTAL_CON_ESTRUCTURA: "coste total con estructura",
}

export type CostCenterOption = { id: string; code: string; name: string }

export function EmployeesPanel({
  employees,
  costCenters,
  canEdit,
  isAdmin,
  today,
  defaultPeriod,
  currency,
}: {
  employees: readonly EmployeeRow[]
  costCenters: readonly CostCenterOption[]
  canEdit: boolean
  isAdmin: boolean
  today: string
  defaultPeriod: { from: string; to: string }
  currency: string
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [showForm, setShowForm] = useState(false)
  const [rateFor, setRateFor] = useState<EmployeeRow | null>(null)
  const [history, setHistory] = useState<{ employee: EmployeeRow; rates: EmployeeRateListItem[] } | null>(null)
  const [showDerive, setShowDerive] = useState(false)
  const [proposal, setProposal] = useState<HourlyCostProposal | null>(null)
  const [deriveScope, setDeriveScope] = useState<"COST_CENTER" | "EMPLOYEE">("COST_CENTER")
  const [deriveBasis, setDeriveBasis] = useState<string>("COSTE_EMPRESA_CON_SS")
  const [deriveTarget, setDeriveTarget] = useState<{ costCenterId?: string; employeeId?: string }>({})
  const [derivePeriod, setDerivePeriod] = useState(defaultPeriod)

  const create = (form: FormData): void => {
    start(async () => {
      const costCenterId = String(form.get("defaultCostCenterId") ?? "")
      const state = await createEmployeeAction({
        code: String(form.get("code") ?? "").trim(),
        name: String(form.get("name") ?? "").trim(),
        fteMilli: Number(form.get("fteMilli") ?? 1000),
        ...(costCenterId ? { defaultCostCenterId: costCenterId } : {}),
      })
      if (!state.success) {
        toast.error(state.error ?? "No se ha podido dar de alta el empleado")
        return
      }
      toast.success("Empleado dado de alta")
      setShowForm(false)
      router.refresh()
    })
  }

  const saveRate = (form: FormData): void => {
    if (!rateFor) return
    const cents = parseCents(String(form.get("rate") ?? ""))
    if (cents === null || cents <= 0) {
      toast.error("El coste-hora es > 0: sin tarifa vigente la cifra es NO EVALUABLE, nunca 0")
      return
    }
    const validTo = String(form.get("validTo") ?? "").trim()
    start(async () => {
      const state = await createEmployeeRateAction({
        employeeId: rateFor.id,
        hourlyCostCents: cents,
        basis: String(form.get("basis") ?? "COSTE_EMPRESA_CON_SS"),
        validFrom: String(form.get("validFrom") ?? today),
        ...(validTo ? { validTo } : {}),
        note: String(form.get("note") ?? "").trim() || null,
      })
      if (!state.success) {
        toast.error(state.error ?? "No se ha podido fijar la tarifa")
        return
      }
      toast.success("Tarifa fijada: la vigencia anterior queda cerrada")
      setRateFor(null)
      router.refresh()
    })
  }

  const openHistory = (employee: EmployeeRow): void => {
    setHistory({ employee, rates: [] })
    start(async () => {
      const state = await listEmployeeRatesAction({ employeeId: employee.id })
      if (!state.success) {
        toast.error(state.error ?? "No se ha podido leer el historial de tarifas")
        setHistory(null)
        return
      }
      setHistory({ employee, rates: state.data ?? [] })
    })
  }

  const propose = (): void => {
    if (deriveScope === "COST_CENTER" && !deriveTarget.costCenterId) {
      toast.error("La derivación por centro de coste necesita el centro de coste")
      return
    }
    if (deriveScope === "EMPLOYEE" && !deriveTarget.employeeId) {
      toast.error("La derivación individual necesita el empleado")
      return
    }
    start(async () => {
      const state = await proposeHourlyCostAction({
        scope: deriveScope,
        ...(deriveScope === "COST_CENTER" ? { costCenterId: deriveTarget.costCenterId } : { employeeId: deriveTarget.employeeId }),
        periodStart: derivePeriod.from,
        periodEnd: derivePeriod.to,
        basis: deriveBasis,
      })
      if (!state.success) {
        toast.error(state.error ?? "No se ha podido derivar el coste-hora")
        return
      }
      setProposal(state.data ?? null)
    })
  }

  const apply = (): void => {
    if (!proposal?.ok) return
    const ids =
      deriveScope === "EMPLOYEE" && deriveTarget.employeeId
        ? [deriveTarget.employeeId]
        : employees.filter((e) => e.isActive && e.defaultCostCenterId === deriveTarget.costCenterId).map((e) => e.id)
    if (ids.length === 0) {
      toast.error("No hay ningún empleado vivo en ese centro de coste al que aplicar la tarifa")
      return
    }
    start(async () => {
      const state = await applyHourlyCostAction({
        scope: deriveScope,
        ...(deriveScope === "COST_CENTER" ? { costCenterId: deriveTarget.costCenterId } : { employeeId: deriveTarget.employeeId }),
        periodStart: derivePeriod.from,
        periodEnd: derivePeriod.to,
        basis: deriveBasis,
        employeeIds: ids,
        validFrom: derivePeriod.from,
      })
      if (!state.success) {
        toast.error(state.error ?? "No se ha podido aplicar la tarifa")
        return
      }
      const data = state.data
      if (data && data.applied === 0) {
        toast.error(data.skipped[0]?.reason ?? "No se ha aplicado ninguna tarifa")
        return
      }
      toast.success(`Tarifa aplicada a ${data?.applied ?? 0} empleado(s), con su derivación en el registro de auditoría`)
      setShowDerive(false)
      setProposal(null)
      router.refresh()
    })
  }

  return (
    <div className="space-y-4">
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => setShowForm((v) => !v)} data-testid="open-employee-form">
            Nuevo empleado
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setShowDerive(true)} data-testid="open-derive">
            Derivar de la nómina
          </Button>
        </div>
      )}

      {canEdit && showForm && (
        <form action={create} className="grid gap-3 rounded-md border p-4 md:grid-cols-4" data-testid="employee-form">
          <div className="space-y-1">
            <Label htmlFor="employee-code">Código</Label>
            <Input id="employee-code" name="code" required maxLength={32} data-testid="employee-code" />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="employee-name">Nombre</Label>
            <Input id="employee-name" name="name" required maxLength={160} data-testid="employee-name" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="employee-fte">FTE (milésimas)</Label>
            <Input
              id="employee-fte"
              name="fteMilli"
              type="number"
              step={1}
              min={0}
              max={1000}
              defaultValue={1000}
              required
              data-testid="employee-fte"
            />
            <p className="text-xs text-muted-foreground">1 000 = jornada completa.</p>
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="employee-ceco">Centro de coste por defecto</Label>
            <select
              id="employee-ceco"
              name="defaultCostCenterId"
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              data-testid="employee-ceco"
            >
              <option value="">Sin centro de coste</option>
              {costCenters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} · {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2 md:col-span-4">
            <Button type="submit" size="sm" disabled={pending} data-testid="employee-submit">
              {pending ? "Dando de alta…" : "Dar de alta"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowForm(false)}>
              Cancelar
            </Button>
          </div>
        </form>
      )}

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid="employees-table">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Código</th>
              <th className="px-3 py-2 text-left font-medium">Nombre</th>
              <th className="px-3 py-2 text-left font-medium">Centro de coste</th>
              <th className="px-3 py-2 text-right font-medium">FTE</th>
              <th className="px-3 py-2 text-right font-medium">Coste-hora vigente</th>
              <th className="px-3 py-2 text-left font-medium">Base</th>
              {isAdmin && <th className="px-3 py-2 text-left font-medium">Tarifa</th>}
            </tr>
          </thead>
          <tbody className="divide-y">
            {employees.length === 0 && (
              <tr>
                <td className="px-3 py-6 text-muted-foreground" colSpan={isAdmin ? 7 : 6}>
                  Todavía no hay empleados. Un parte de horas es de alguien y su coste sale de su tarifa vigente.
                </td>
              </tr>
            )}
            {employees.map((employee) => (
              <tr key={employee.id} className="h-8" data-testid="employee-row" data-code={employee.code}>
                <td className="px-3 py-1 font-code text-xs">{employee.code}</td>
                <td className="px-3 py-1">
                  {employee.name}
                  {!employee.isActive && <span className="ml-2 text-[11px] text-muted-foreground">archivado</span>}
                </td>
                <td className="px-3 py-1 font-code text-xs">{employee.defaultCostCenterCode ?? "—"}</td>
                <td className="px-3 py-1 text-right tabular-nums">
                  {(employee.fteMilli / 1000).toLocaleString("es-ES", { minimumFractionDigits: 3 })}
                </td>
                <td className="px-3 py-1 text-right" data-testid="employee-rate">
                  {employee.currentRateCents !== null ? (
                    <>
                      <AmountPlain cents={employee.currentRateCents} zeroAsDash={false} /> {currency}
                    </>
                  ) : employee.rateHidden ? (
                    <span className="text-xs text-muted-foreground" data-testid="rate-hidden">
                      oculta
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground" data-testid="rate-missing">
                      sin tarifa vigente
                    </span>
                  )}
                </td>
                <td className="px-3 py-1 text-xs text-muted-foreground">
                  {employee.currentRateBasis ? (BASIS_SHORT[employee.currentRateBasis] ?? employee.currentRateBasis) : "—"}
                </td>
                {isAdmin && (
                  <td className="px-3 py-1">
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-xs"
                      onClick={() => setRateFor(employee)}
                      data-testid="open-rate"
                    >
                      Fijar
                    </Button>
                    <span className="mx-1 text-muted-foreground">·</span>
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-xs"
                      onClick={() => openHistory(employee)}
                      data-testid="open-rate-history"
                    >
                      Vigencias
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!isAdmin && (
        <p className="text-xs text-muted-foreground" data-testid="rate-privacy-note">
          El coste-hora individual <strong>sólo lo ve un administrador</strong> (§10): es el salario de una persona
          partido por sus horas. La cifra de gestión —el coste-hora medio del receptor— está en la ficha del proyecto.
        </p>
      )}

      {/* ── Fijar tarifa (ADMIN) ─────────────────────────────────────────── */}
      <Dialog open={rateFor !== null} onOpenChange={(v) => !v && setRateFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Tarifa de {rateFor?.code} · {rateFor?.name}
            </DialogTitle>
            <DialogDescription>
              La <strong>base es obligatoria y explícita</strong>: un coste-hora «con SS» y otro «sin SS» difieren ≈
              31,9 % y no son la misma magnitud. La vigencia anterior se cierra sola; no hay dos tarifas vigentes el
              mismo día (I-E10-5).
            </DialogDescription>
          </DialogHeader>
          <form action={saveRate} className="space-y-3" data-testid="rate-form">
            <div className="space-y-1">
              <Label htmlFor="rate-amount">Coste-hora</Label>
              <Input id="rate-amount" name="rate" inputMode="decimal" placeholder="32,50" required data-testid="rate-amount" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rate-basis">Base</Label>
              <select
                id="rate-basis"
                name="basis"
                defaultValue="COSTE_EMPRESA_CON_SS"
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                data-testid="rate-basis"
              >
                {BASES.map((b) => (
                  <option key={b.code} value={b.code}>
                    {b.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                <strong>Aviso:</strong> elegir «coste total con estructura» con reglas de actividad vigentes carga la
                estructura dos veces; el servidor lo rechaza con <span className="font-code">RATE_BASIS_CONFLICT</span>.
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="rate-from">Vigente desde</Label>
                <Input id="rate-from" name="validFrom" type="date" defaultValue={today} required data-testid="rate-from" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="rate-to">Hasta (opcional)</Label>
                <Input id="rate-to" name="validTo" type="date" data-testid="rate-to" />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="rate-note">Nota</Label>
              <Input id="rate-note" name="note" maxLength={500} data-testid="rate-note" />
            </div>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={pending} data-testid="rate-submit">
                {pending ? "Fijando…" : "Fijar tarifa"}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setRateFor(null)}>
                Cancelar
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Historial de vigencias (ADMIN) ───────────────────────────────── */}
      <Dialog open={history !== null} onOpenChange={(v) => !v && setHistory(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Vigencias de {history?.employee.code}</DialogTitle>
            <DialogDescription>
              Para todo empleado y toda fecha hay 0 ó 1 tarifa vigente (I-E10-5). Con 0 y partes ese día, la cifra sale{" "}
              <strong>no evaluable</strong>: nunca se aplica 0 ni la tarifa anterior.
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-xs" data-testid="rate-history">
              <thead className="bg-muted/40 uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-2 py-1 text-left font-medium">Desde</th>
                  <th className="px-2 py-1 text-left font-medium">Hasta</th>
                  <th className="px-2 py-1 text-right font-medium">Coste-hora</th>
                  <th className="px-2 py-1 text-left font-medium">Base</th>
                  <th className="px-2 py-1 text-left font-medium">Origen</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {(history?.rates ?? []).length === 0 && (
                  <tr>
                    <td className="px-2 py-3 text-muted-foreground" colSpan={5}>
                      Sin tarifas registradas.
                    </td>
                  </tr>
                )}
                {(history?.rates ?? []).map((rate) => (
                  <tr key={rate.id} className="h-7">
                    <td className="px-2 py-1 tabular-nums">{formatLocalDate(rate.validFrom)}</td>
                    <td className="px-2 py-1 tabular-nums">{rate.validTo ? formatLocalDate(rate.validTo) : "abierta"}</td>
                    <td className="px-2 py-1 text-right">
                      <AmountPlain cents={rate.hourlyCostCents} zeroAsDash={false} />
                    </td>
                    <td className="px-2 py-1 text-muted-foreground">{BASIS_SHORT[rate.basis] ?? rate.basis}</td>
                    <td className="px-2 py-1 text-muted-foreground">
                      {rate.source === "DERIVADO_NOMINA" ? "derivada de nómina" : "declarada"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Derivar de la nómina: PROPONE, no aplica ─────────────────────── */}
      <Dialog open={showDerive} onOpenChange={(v) => { if (!v) { setShowDerive(false); setProposal(null) } }}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Derivar el coste-hora de la nómina</DialogTitle>
            <DialogDescription>
              Esto <strong>propone</strong> una cifra con sus términos; no la aplica. Aplicarla es un acto de un
              administrador y queda en el registro de auditoría con la derivación entera detrás.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="derive-scope">Ámbito</Label>
              <select
                id="derive-scope"
                value={deriveScope}
                onChange={(e) => { setDeriveScope(e.target.value as "COST_CENTER" | "EMPLOYEE"); setProposal(null) }}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                data-testid="derive-scope"
              >
                <option value="COST_CENTER">Centro de coste (tarifa media)</option>
                <option value="EMPLOYEE">Empleado (líneas 64x con su tercero)</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="derive-target">{deriveScope === "COST_CENTER" ? "Centro de coste" : "Empleado"}</Label>
              <select
                id="derive-target"
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                onChange={(e) =>
                  setDeriveTarget(deriveScope === "COST_CENTER" ? { costCenterId: e.target.value } : { employeeId: e.target.value })
                }
                data-testid="derive-target"
              >
                <option value="">Elige uno</option>
                {(deriveScope === "COST_CENTER" ? costCenters : employees).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.code} · {o.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="derive-from">Periodo desde</Label>
              <Input
                id="derive-from"
                type="date"
                value={derivePeriod.from}
                onChange={(e) => setDerivePeriod((p) => ({ ...p, from: e.target.value }))}
                data-testid="derive-from"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="derive-to">Hasta</Label>
              <Input
                id="derive-to"
                type="date"
                value={derivePeriod.to}
                onChange={(e) => setDerivePeriod((p) => ({ ...p, to: e.target.value }))}
                data-testid="derive-to"
              />
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label htmlFor="derive-basis">Base</Label>
              <select
                id="derive-basis"
                value={deriveBasis}
                onChange={(e) => { setDeriveBasis(e.target.value); setProposal(null) }}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                data-testid="derive-basis"
              >
                {BASES.map((b) => (
                  <option key={b.code} value={b.code}>
                    {b.label}
                  </option>
                ))}
              </select>
              {deriveBasis === "COSTE_TOTAL_CON_ESTRUCTURA" && (
                <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-2 py-1 text-xs" role="alert" data-testid="basis-conflict-warning">
                  Con reglas de actividad vigentes, esta base <strong>carga la estructura dos veces</strong>. El
                  servidor lo rechaza con <span className="font-code">RATE_BASIS_CONFLICT</span>.
                </p>
              )}
            </div>
          </div>

          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" onClick={propose} disabled={pending} data-testid="derive-propose">
              {pending ? "Derivando…" : "Ver la propuesta"}
            </Button>
            {isAdmin && (
              <Button type="button" size="sm" onClick={apply} disabled={pending || !proposal?.ok} data-testid="derive-apply">
                Aplicar la propuesta
              </Button>
            )}
          </div>

          {proposal && !proposal.ok && (
            <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert" data-testid="derive-not-evaluable">
              <strong>No evaluable:</strong> {proposal.message}
              {proposal.coverageBps !== null && <> · cobertura {(proposal.coverageBps / 100).toFixed(2)} %</>}. Por
              debajo del mínimo de cobertura no se extrapola: se dice que no se puede.
            </p>
          )}

          {proposal?.ok && (
            <div className="space-y-2 rounded-md border p-3 text-sm" data-testid="derive-proposal">
              <p className="text-base font-semibold">
                <AmountPlain cents={proposal.hourlyCostCents} zeroAsDash={false} /> {currency} / hora ·{" "}
                <span className="text-xs font-normal text-muted-foreground">
                  base {BASIS_SHORT[proposal.derivation.basis] ?? proposal.derivation.basis}
                </span>
              </p>
              <ul className="space-y-0.5 text-xs text-muted-foreground">
                <li>
                  Ámbito: {proposal.derivation.scope === "COST_CENTER" ? "centro de coste" : "empleado"}{" "}
                  {proposal.derivation.costCenterCode ?? proposal.derivation.employeeCode ?? ""}
                </li>
                <li>
                  Periodo: {proposal.derivation.periodStart} – {proposal.derivation.periodEnd}
                </li>
                <li>
                  Cuentas: {proposal.derivation.accountPrefixes.join(", ")} · excluidas{" "}
                  {proposal.derivation.excludedPrefixes.join(", ")} (indemnizaciones: no son coste de actividad)
                </li>
                <li>
                  Nómina: <AmountPlain cents={proposal.derivation.payrollCents} zeroAsDash={false} /> · numerador{" "}
                  <AmountPlain cents={proposal.derivation.numeratorCents} zeroAsDash={false} />
                </li>
                <li>Minutos productivos: {proposal.derivation.productiveMinutes}</li>
                <li>
                  Cobertura:{" "}
                  {proposal.derivation.coverageBps === null
                    ? "no evaluable"
                    : `${(proposal.derivation.coverageBps / 100).toFixed(2)} %`}{" "}
                  ({proposal.derivation.linesMatched} de {proposal.derivation.linesTotal} líneas)
                </li>
                <li className="font-code">{proposal.derivation.formula}</li>
              </ul>
              {!isAdmin && (
                <p className="text-xs text-muted-foreground">
                  Aplicarla es un acto de un <strong>administrador</strong>: aquí sólo se puede consultar.
                </p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
