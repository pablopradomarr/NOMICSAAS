"use client"

import {
  archiveDimensionAction,
  closeProjectAction,
  createBusinessLineAction,
  createCostCenterAction,
  createProjectAction,
  reopenProjectAction,
  updateBusinessLineAction,
  updateCostCenterAction,
  updateProjectAction,
} from "@/app/(app)/analytics/actions"
import {
  COST_CENTER_KIND_LABELS,
  type BusinessLineOption,
  type BusinessLineRow,
  type CostCenterRow,
  type ProjectRow,
} from "@/components/analytics/types"
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
import { parseCents } from "@/lib/money"
import { cn } from "@/lib/utils"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

/**
 * E4 · T13 — Altas y ediciones de las tres dimensiones analíticas (§6).
 *
 * El rol decide qué se ve, pero **la protección real está en la acción**:
 * `createProjectAction` exige EDITOR, `archiveDimensionAction` y los campos
 * estructurales del CECO (`kind`, `marginLevel`, `allocatable`) exigen ADMIN, y
 * todo lo que reescribe historia exige motivo de 10 caracteres o más.
 *
 * Ninguna de estas pantallas calcula: el presupuesto es un dato del usuario y
 * la desviación la enseña la pantalla marcada como `calculado`.
 */

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"

function ErrorBox({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert">
      {message}
    </p>
  )
}

function Field({
  label,
  help,
  children,
}: {
  label: string
  help?: string
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {help && <span className="text-[11px] text-muted-foreground">{help}</span>}
    </label>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Proyecto
// ─────────────────────────────────────────────────────────────────────────────

type ProjectDraft = {
  code: string
  name: string
  businessLineId: string
  status: "PLANNED" | "ACTIVE"
  startDate: string
  endDate: string
  budgetRevenue: string
  budgetCost: string
}

const emptyProject = (businessLineId: string): ProjectDraft => ({
  code: "",
  name: "",
  businessLineId,
  status: "ACTIVE",
  startDate: "",
  endDate: "",
  budgetRevenue: "",
  budgetCost: "",
})

export function ProjectDialog({
  businessLines,
  project,
  canEdit,
  trigger,
}: {
  businessLines: readonly BusinessLineOption[]
  /** Sin proyecto = alta. */
  project?: ProjectRow
  canEdit: boolean
  trigger?: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [draft, setDraft] = useState<ProjectDraft>(() =>
    project
      ? {
          code: project.code,
          name: project.name,
          businessLineId: project.businessLineId,
          status: project.status === "CLOSED" ? "ACTIVE" : project.status,
          startDate: project.startDate ?? "",
          endDate: project.endDate ?? "",
          budgetRevenue: project.budgetRevenueCents != null ? String(project.budgetRevenueCents / 100) : "",
          budgetCost: project.budgetCostCents != null ? String(project.budgetCostCents / 100) : "",
        }
      : emptyProject(businessLines[0]?.id ?? "")
  )

  if (!canEdit) return null
  const isEdit = Boolean(project)
  const set = (patch: Partial<ProjectDraft>) => setDraft((current) => ({ ...current, ...patch }))

  const submit = () =>
    startTransition(async () => {
      setError(null)
      const common = {
        name: draft.name.trim(),
        businessLineId: draft.businessLineId,
        startDate: draft.startDate || null,
        endDate: draft.endDate || null,
        budgetRevenueCents: draft.budgetRevenue.trim() === "" ? null : parseCents(draft.budgetRevenue),
        budgetCostCents: draft.budgetCost.trim() === "" ? null : parseCents(draft.budgetCost),
      }
      const state = isEdit
        ? await updateProjectAction({ id: project!.id, ...common })
        : await createProjectAction({ code: draft.code.trim(), status: draft.status, ...common })
      if (!state.success) {
        setError(state.error ?? "No se ha podido guardar el proyecto")
        return
      }
      setOpen(false)
      router.refresh()
    })

  return (
    <>
      <Button
        type="button"
        variant={isEdit ? "outline" : "default"}
        size="sm"
        onClick={() => setOpen(true)}
        data-testid={isEdit ? `edit-project-${project!.code}` : "new-project"}
      >
        {trigger ?? (isEdit ? "Editar" : "Nuevo proyecto")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{isEdit ? `Editar el proyecto ${project!.code}` : "Nuevo proyecto"}</DialogTitle>
            <DialogDescription>
              Un proyecto pertenece a UNA línea de negocio y es la dimensión analítica de las líneas de gasto e ingreso
              directo. La línea de negocio de las líneas ya contabilizadas no se recalcula al cambiarla aquí (R-A9).
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-2">
            {!isEdit && (
              <Field label="Código *" help="Letras, dígitos, punto, guion y guion bajo.">
                <Input
                  aria-label="Código del proyecto"
                  className="font-code"
                  value={draft.code}
                  onChange={(event) => set({ code: event.target.value })}
                  maxLength={24}
                  placeholder="P-04"
                />
              </Field>
            )}
            <Field label="Nombre *">
              <Input
                aria-label="Nombre del proyecto"
                value={draft.name}
                onChange={(event) => set({ name: event.target.value })}
                maxLength={120}
                placeholder="Implantación ERP Cliente Delta"
              />
            </Field>
            <Field label="Línea de negocio *">
              <select
                aria-label="Línea de negocio del proyecto"
                className={SELECT_CLASS}
                value={draft.businessLineId}
                onChange={(event) => set({ businessLineId: event.target.value })}
              >
                {businessLines.map((bl) => (
                  <option key={bl.id} value={bl.id}>
                    {bl.code} · {bl.name}
                  </option>
                ))}
              </select>
            </Field>
            {!isEdit && (
              <Field label="Estado">
                <select
                  aria-label="Estado del proyecto"
                  className={SELECT_CLASS}
                  value={draft.status}
                  onChange={(event) => set({ status: event.target.value as ProjectDraft["status"] })}
                >
                  <option value="ACTIVE">Activo</option>
                  <option value="PLANNED">Previsto</option>
                </select>
              </Field>
            )}
            <Field label="Inicio">
              <Input
                aria-label="Fecha de inicio del proyecto"
                type="date"
                value={draft.startDate}
                onChange={(event) => set({ startDate: event.target.value })}
              />
            </Field>
            <Field label="Fin previsto">
              <Input
                aria-label="Fecha de fin del proyecto"
                type="date"
                value={draft.endDate}
                onChange={(event) => set({ endDate: event.target.value })}
              />
            </Field>
            <Field label="Presupuesto de ingresos (€)" help="Sirve sólo para la desviación; no es una cifra contable.">
              <Input
                aria-label="Presupuesto de ingresos"
                inputMode="decimal"
                className="text-right tabular-nums"
                value={draft.budgetRevenue}
                onChange={(event) => set({ budgetRevenue: event.target.value })}
                placeholder="0,00"
              />
            </Field>
            <Field label="Presupuesto de costes (€)">
              <Input
                aria-label="Presupuesto de costes"
                inputMode="decimal"
                className="text-right tabular-nums"
                value={draft.budgetCost}
                onChange={(event) => set({ budgetCost: event.target.value })}
                placeholder="0,00"
              />
            </Field>
          </div>

          <ErrorBox message={error} />

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={submit}
              disabled={pending || draft.name.trim() === "" || (!isEdit && draft.code.trim() === "")}
              data-testid="save-project"
            >
              {pending ? "Guardando…" : isEdit ? "Guardar cambios" : "Crear proyecto"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Cerrar es EDITOR; reabrir es ADMIN y exige motivo (§4). */
export function ProjectStateButtons({
  project,
  canEdit,
  isAdmin,
  today,
}: {
  project: ProjectRow
  canEdit: boolean
  isAdmin: boolean
  today: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [closedAt, setClosedAt] = useState(today)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  if (!canEdit) return null
  const closed = project.status === "CLOSED"
  if (closed && !isAdmin) return null

  const submit = () =>
    startTransition(async () => {
      setError(null)
      const state = closed
        ? await reopenProjectAction({ id: project.id, reason: reason.trim() })
        : await closeProjectAction({ id: project.id, closedAt })
      if (!state.success) {
        setError(state.error ?? "No se ha podido cambiar el estado del proyecto")
        return
      }
      setOpen(false)
      router.refresh()
    })

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        data-testid={closed ? `reopen-project-${project.code}` : `close-project-${project.code}`}
      >
        {closed ? "Reabrir" : "Cerrar"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {closed ? "Reabrir" : "Cerrar"} el proyecto {project.code}
            </DialogTitle>
            <DialogDescription>
              {closed
                ? "Reabrir deshace un cierre que ya ha servido para decidir: queda en la auditoría con el motivo."
                : "Un proyecto cerrado no admite líneas nuevas salvo excepción de un ADMIN con motivo; el contra-asiento de una anulación sí entra siempre."}
            </DialogDescription>
          </DialogHeader>

          {closed ? (
            <Field label="Motivo *" help="Mínimo 10 caracteres. Queda en la auditoría.">
              <Textarea
                aria-label="Motivo de la reapertura"
                rows={3}
                maxLength={512}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
          ) : (
            <Field label="Fecha de cierre *">
              <Input
                aria-label="Fecha de cierre del proyecto"
                type="date"
                value={closedAt}
                onChange={(event) => setClosedAt(event.target.value)}
              />
            </Field>
          )}

          <ErrorBox message={error} />

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={submit}
              disabled={pending || (closed && reason.trim().length < 10)}
              data-testid="confirm-project-state"
            >
              {pending ? "Guardando…" : closed ? "Reabrir" : "Cerrar proyecto"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Archivar (ADMIN, con motivo). Nada se borra.
// ─────────────────────────────────────────────────────────────────────────────

export function ArchiveDimensionDialog({
  kind,
  id,
  code,
  isAdmin,
  disabled,
  disabledReason,
}: {
  kind: "BusinessLine" | "Project" | "CostCenter"
  id: string
  code: string
  isAdmin: boolean
  disabled?: boolean
  disabledReason?: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  if (!isAdmin) return null

  const submit = () =>
    startTransition(async () => {
      setError(null)
      const state = await archiveDimensionAction({ kind, id, reason: reason.trim() })
      if (!state.success) {
        setError(state.error ?? "No se ha podido archivar")
        return
      }
      setOpen(false)
      router.refresh()
    })

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        onClick={() => setOpen(true)}
        data-testid={`archive-${code}`}
      >
        Archivar
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archivar {code}</DialogTitle>
            <DialogDescription>
              No se borra nada. La dimensión desaparece de los desplegables pero <strong>sigue en la matriz</strong> de
              los periodos en los que tuvo movimiento, y su histórico no cambia.
            </DialogDescription>
          </DialogHeader>
          <Field label="Motivo *" help="Mínimo 10 caracteres. Queda en la auditoría.">
            <Textarea
              aria-label="Motivo del archivado"
              rows={3}
              maxLength={512}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          <ErrorBox message={error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancelar
            </Button>
            <Button type="button" onClick={submit} disabled={pending || reason.trim().length < 10}>
              {pending ? "Archivando…" : "Archivar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Línea de negocio
// ─────────────────────────────────────────────────────────────────────────────

export function BusinessLineDialog({
  line,
  canEdit,
}: {
  line?: BusinessLineRow
  canEdit: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState(line?.code ?? "")
  const [name, setName] = useState(line?.name ?? "")
  const [color, setColor] = useState(line?.color ?? "#0A0A0A")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  if (!canEdit) return null
  const isEdit = Boolean(line)

  const submit = () =>
    startTransition(async () => {
      setError(null)
      const state = isEdit
        ? await updateBusinessLineAction({ id: line!.id, name: name.trim(), color })
        : await createBusinessLineAction({ code: code.trim(), name: name.trim(), color })
      if (!state.success) {
        setError(state.error ?? "No se ha podido guardar la línea de negocio")
        return
      }
      setOpen(false)
      router.refresh()
    })

  return (
    <>
      <Button
        type="button"
        variant={isEdit ? "outline" : "default"}
        size="sm"
        onClick={() => setOpen(true)}
        data-testid={isEdit ? `edit-business-line-${line!.code}` : "new-business-line"}
      >
        {isEdit ? "Editar" : "Nueva línea de negocio"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isEdit ? `Editar ${line!.code}` : "Nueva línea de negocio"}</DialogTitle>
            <DialogDescription>
              Una línea de negocio agrupa proyectos. En la PyG analítica es una columna de <strong>agregado</strong>:
              no suma al total, porque sus proyectos ya están contados.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            {!isEdit && (
              <Field label="Código *">
                <Input
                  aria-label="Código de la línea de negocio"
                  className="font-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  maxLength={24}
                  placeholder="BL-CONS"
                />
              </Field>
            )}
            <Field label="Nombre *">
              <Input
                aria-label="Nombre de la línea de negocio"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={120}
                placeholder="Consultoría"
              />
            </Field>
            <Field label="Color">
              <Input
                aria-label="Color de la línea de negocio"
                className="font-code"
                value={color}
                onChange={(event) => setColor(event.target.value)}
                placeholder="#0A0A0A"
              />
            </Field>
          </div>
          <ErrorBox message={error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={submit}
              disabled={pending || name.trim() === "" || (!isEdit && code.trim() === "")}
              data-testid="save-business-line"
            >
              {pending ? "Guardando…" : isEdit ? "Guardar" : "Crear"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Centro de coste
// ─────────────────────────────────────────────────────────────────────────────

const CREATABLE_KINDS = [
  "MARKETING_VENTAS",
  "OPERACIONES_INDIRECTAS",
  "G_A",
  "DESARROLLO_PRODUCTO",
  "FINANCIERO",
  "EXTRAORDINARIO",
  "OTROS",
] as const

export function CostCenterDialog({
  costCenter,
  canEdit,
  isAdmin,
}: {
  costCenter?: CostCenterRow
  canEdit: boolean
  isAdmin: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState(costCenter?.code ?? "")
  const [name, setName] = useState(costCenter?.name ?? "")
  const [kind, setKind] = useState<string>(costCenter?.kind ?? "G_A")
  const [marginLevel, setMarginLevel] = useState<"MC3" | "EBITDA">(costCenter?.marginLevel ?? "EBITDA")
  const [allocatable, setAllocatable] = useState(costCenter?.allocatable ?? true)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  if (!canEdit) return null
  const isEdit = Boolean(costCenter)
  const isSystem = costCenter?.isSystem === true
  const structuralLocked = isEdit && (!isAdmin || isSystem)

  const submit = () =>
    startTransition(async () => {
      setError(null)
      const structural = isAdmin && !isSystem
      const state = isEdit
        ? await updateCostCenterAction({
            id: costCenter!.id,
            name: name.trim(),
            ...(structural ? { kind, marginLevel, allocatable } : {}),
          })
        : await createCostCenterAction({ code: code.trim(), name: name.trim(), kind, marginLevel, allocatable })
      if (!state.success) {
        setError(state.error ?? "No se ha podido guardar el centro de coste")
        return
      }
      setOpen(false)
      router.refresh()
    })

  return (
    <>
      <Button
        type="button"
        variant={isEdit ? "outline" : "default"}
        size="sm"
        onClick={() => setOpen(true)}
        data-testid={isEdit ? `edit-cost-center-${costCenter!.code}` : "new-cost-center"}
      >
        {isEdit ? "Editar" : "Nuevo centro de coste"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{isEdit ? `Editar ${costCenter!.code}` : "Nuevo centro de coste"}</DialogTitle>
            <DialogDescription>
              El <strong>tipo</strong> decide en qué columna de la matriz cae el CECO y el <strong>nivel de margen</strong>{" "}
              en cuál de los dos niveles se descuenta (MC3 o EBITDA): los dos mueven importe entre niveles, así que sólo
              los cambia un ADMIN y queda en la auditoría.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-2">
            {!isEdit && (
              <Field label="Código *">
                <Input
                  aria-label="Código del centro de coste"
                  className="font-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  maxLength={24}
                  placeholder="CC-QA"
                />
              </Field>
            )}
            <Field label="Nombre *">
              <Input
                aria-label="Nombre del centro de coste"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={120}
              />
            </Field>
            <Field label="Tipo *" help={structuralLocked ? "Sólo un ADMIN puede cambiarlo." : undefined}>
              <select
                aria-label="Tipo del centro de coste"
                className={cn(SELECT_CLASS, structuralLocked && "opacity-60")}
                disabled={structuralLocked}
                value={kind}
                onChange={(event) => setKind(event.target.value)}
              >
                {CREATABLE_KINDS.map((value) => (
                  <option key={value} value={value}>
                    {COST_CENTER_KIND_LABELS[value]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Nivel de margen *" help="MC3 absorbe estructura de operación; EBITDA, estructura de compañía.">
              <select
                aria-label="Nivel de margen del centro de coste"
                className={cn(SELECT_CLASS, structuralLocked && "opacity-60")}
                disabled={structuralLocked}
                value={marginLevel}
                onChange={(event) => setMarginLevel(event.target.value as "MC3" | "EBITDA")}
              >
                <option value="MC3">MC3</option>
                <option value="EBITDA">EBITDA</option>
              </select>
            </Field>
            <Field label="Imputable" help="Si la liquidación de E5 podrá repartirlo a proyectos.">
              <select
                aria-label="Imputabilidad del centro de coste"
                className={cn(SELECT_CLASS, structuralLocked && "opacity-60")}
                disabled={structuralLocked}
                value={allocatable ? "1" : "0"}
                onChange={(event) => setAllocatable(event.target.value === "1")}
              >
                <option value="1">Sí</option>
                <option value="0">No</option>
              </select>
            </Field>
          </div>

          <ErrorBox message={error} />

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={submit}
              disabled={pending || name.trim() === "" || (!isEdit && code.trim() === "")}
              data-testid="save-cost-center"
            >
              {pending ? "Guardando…" : isEdit ? "Guardar" : "Crear"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
