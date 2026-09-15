"use client"

/**
 * E10 · T15 — Versiones de presupuesto: alta, **sellado** y sustitución (§7).
 *
 * La doctrina de E10 es «sustituir, no corregir»: un presupuesto sellado no se
 * edita nunca, se revisa. Esta pantalla la hace visible:
 *
 * 1. **Alta** (`ADMIN`): `BASE` o `REVISADO n`, con su vigencia y —sólo las
 *    revisiones— su `partialFrom`, que es lo que declara que la versión cubre
 *    de ese mes en adelante (O-E10-9). Sin `partialFrom`, una revisión de julio
 *    dejaba el año compuesto a la mitad **y nada lo decía**.
 * 2. **Sellado** (`ADMIN`): antes de firmar se enseña el `budgetHash` que se va
 *    a firmar, el `validTo` que le quedará a la versión anterior (O-E10-8) y
 *    qué informes caducan. La confirmación es **doble**: escribir el código de
 *    la versión y aceptar que el sello es irreversible.
 * 3. **Sustitución** (`ADMIN`): con motivo de 10 caracteres o más. La versión
 *    sustituida sigue consultable y sigue explicando los informes que firmó.
 */

import {
  createBudgetVersionAction,
  sealBudgetAction,
  supersedeBudgetAction,
} from "@/app/(app)/analytics/budget/actions"
import { previewSealBudgetAction, type SealPreview } from "@/app/(app)/analytics/budget/ui-actions"
import {
  BUDGET_SCENARIO_LABEL,
  BUDGET_STATUS_LABEL,
  type BudgetVersionView,
  type FiscalYearOption,
} from "@/components/budget/types"
import { AmountPlain } from "@/components/ledger/amount"
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
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

const SELECT_CLASS =
  "h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"

const short = (value: string | null, length = 12): string => (!value ? "—" : value.slice(0, length))

export function BudgetVersionsTable({
  versions,
  selectedId,
  isAdmin,
  fiscalYears,
}: {
  versions: readonly BudgetVersionView[]
  selectedId: string | null
  isAdmin: boolean
  fiscalYears: readonly FiscalYearOption[]
}) {
  if (versions.length === 0) {
    return (
      <div className="space-y-3">
        <p className="rounded-md border p-6 text-sm text-muted-foreground" data-testid="budget-versions-empty">
          Todavía no hay ninguna versión de presupuesto en esta organización. Un presupuesto es una{" "}
          <strong>decisión</strong>, no un cálculo: nada lo deriva del real. Crea la versión <span className="font-code">BASE</span>{" "}
          del ejercicio para empezar a teclearlo.
        </p>
        {isAdmin && <NewBudgetVersionDialog fiscalYears={fiscalYears} versions={versions} />}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full border-collapse text-xs" data-testid="budget-versions">
          <thead className="bg-muted/40">
            <tr className="[&>th]:px-2 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
              <th>Versión</th>
              <th>Escenario</th>
              <th>Estado</th>
              <th>Vigencia</th>
              <th>Parcial desde</th>
              <th>budgetHash</th>
              <th className="text-right">Celdas</th>
              <th className="text-right">Total</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {versions.map((version) => (
              <tr
                key={version.id}
                className={`border-t [&>td]:px-2 [&>td]:py-1 ${version.id === selectedId ? "bg-[#EDF2F7]" : ""}`}
                data-budget-version={version.label}
                data-budget-status={version.status}
              >
                <td className="font-code whitespace-nowrap">{version.label}</td>
                <td>{BUDGET_SCENARIO_LABEL[version.scenario] ?? version.scenario}</td>
                <td>{BUDGET_STATUS_LABEL[version.status] ?? version.status}</td>
                <td className="whitespace-nowrap">
                  {version.validFrom} … {version.validTo ?? "abierta"}
                </td>
                <td className="whitespace-nowrap" data-partial-from={version.partialFrom ?? ""}>
                  {version.partialFrom ?? "—"}
                </td>
                <td className="font-code" title={version.budgetHash ?? "sin sellar"}>
                  {short(version.budgetHash)}
                </td>
                <td className="text-right font-code">{version.lineCount}</td>
                <td className="text-right font-code">
                  <AmountPlain cents={version.totalCents} />
                </td>
                <td className="whitespace-nowrap text-right">
                  <Button asChild variant="ghost" size="sm">
                    <Link href={`/analytics/budget?budgetId=${version.id}`} data-testid={`open-${version.label}`}>
                      Abrir
                    </Link>
                  </Button>
                  {isAdmin && version.status === "BORRADOR" && <SealBudgetDialog version={version} />}
                  {isAdmin && version.status === "VIGENTE" && (
                    <SupersedeBudgetDialog version={version} versions={versions} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {isAdmin && <NewBudgetVersionDialog fiscalYears={fiscalYears} versions={versions} />}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Alta
// ─────────────────────────────────────────────────────────────────────────────

export function NewBudgetVersionDialog({
  fiscalYears,
  versions,
}: {
  fiscalYears: readonly FiscalYearOption[]
  versions: readonly BudgetVersionView[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [fiscalYearId, setFiscalYearId] = useState(fiscalYears[0]?.id ?? "")
  const [scenario, setScenario] = useState("BASE")
  const [name, setName] = useState("")
  const [note, setNote] = useState("")
  const [validFrom, setValidFrom] = useState(fiscalYears[0]?.startDate ?? "")
  const [partialFrom, setPartialFrom] = useState("")
  const [copyFrom, setCopyFrom] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const submit = () =>
    start(async () => {
      setError(null)
      const state = await createBudgetVersionAction({
        fiscalYearId,
        scenario,
        name: name.trim(),
        note: note.trim() === "" ? null : note.trim(),
        validFrom,
        partialFrom: scenario === "REVISADO" && partialFrom !== "" ? partialFrom : null,
        copyFromBudgetId: copyFrom === "" ? null : copyFrom,
      })
      if (!state.success) {
        setError(state.error ?? "No se ha podido crear la versión")
        return
      }
      setOpen(false)
      setName("")
      setNote("")
      router.push(`/analytics/budget?budgetId=${state.data?.id ?? ""}`)
      router.refresh()
    })

  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)} data-testid="new-budget-version">
        Nueva versión
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Nueva versión de presupuesto</DialogTitle>
            <DialogDescription>
              La <strong>BASE</strong> cubre el ejercicio entero. Una <strong>revisión</strong> puede cubrirlo entero o
              sustituir sólo de un mes en adelante: en ese caso hay que declarar su{" "}
              <span className="font-code">partialFrom</span>, que es lo que permite componer el año (BASE de enero a
              junio + revisión de julio a diciembre) en vez de desinflarlo a la mitad.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">Ejercicio</span>
              <select
                aria-label="Ejercicio"
                className={SELECT_CLASS}
                value={fiscalYearId}
                onChange={(event) => {
                  setFiscalYearId(event.target.value)
                  const year = fiscalYears.find((f) => f.id === event.target.value)
                  if (year) setValidFrom(year.startDate)
                }}
                data-testid="version-fiscal-year"
              >
                {fiscalYears.map((year) => (
                  <option key={year.id} value={year.id}>
                    {year.code}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">Escenario</span>
              <select
                aria-label="Escenario"
                className={SELECT_CLASS}
                value={scenario}
                onChange={(event) => setScenario(event.target.value)}
                data-testid="version-scenario"
              >
                <option value="BASE">Base</option>
                <option value="REVISADO">Revisado</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">Nombre</span>
              <Input
                className="h-8"
                aria-label="Nombre de la versión"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Presupuesto 2026"
                data-testid="version-name"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">Vigente desde</span>
              <Input
                type="date"
                className="h-8"
                aria-label="Vigente desde"
                value={validFrom}
                onChange={(event) => setValidFrom(event.target.value)}
                data-testid="version-valid-from"
              />
            </label>
            {scenario === "REVISADO" && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs font-medium text-muted-foreground">
                  Parcial desde (primer día de mes, opcional)
                </span>
                <Input
                  type="date"
                  className="h-8"
                  aria-label="Parcial desde"
                  value={partialFrom}
                  onChange={(event) => setPartialFrom(event.target.value)}
                  data-testid="version-partial-from"
                />
              </label>
            )}
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">Copiar celdas de (opcional)</span>
              <select
                aria-label="Copiar celdas de"
                className={SELECT_CLASS}
                value={copyFrom}
                onChange={(event) => setCopyFrom(event.target.value)}
                data-testid="version-copy-from"
              >
                <option value="">No copiar: empezar en blanco</option>
                {versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    {version.label} ({version.lineCount} celdas)
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="space-y-1">
            <Label htmlFor="version-note">Nota (opcional)</Label>
            <Textarea
              id="version-note"
              value={note}
              maxLength={1000}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Reproyección tras el cierre de junio: se traslada el pipeline de la LN de servicios a cartera."
            />
          </div>
          {error && (
            <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert" data-testid="version-error">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancelar
            </Button>
            <Button onClick={submit} disabled={pending || name.trim() === "" || validFrom === ""} data-testid="version-submit">
              {pending ? "Creando…" : "Crear versión"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sellado, con doble confirmación
// ─────────────────────────────────────────────────────────────────────────────

export function SealBudgetDialog({ version }: { version: BudgetVersionView }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<SealPreview | null>(null)
  const [confirmCode, setConfirmCode] = useState("")
  const [ack, setAck] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const puede = preview !== null && confirmCode.trim() === version.label && ack

  const load = () =>
    start(async () => {
      setError(null)
      const state = await previewSealBudgetAction({ budgetId: version.id })
      if (!state.success) {
        setError(state.error ?? "No se ha podido componer la previsualización del sello")
        return
      }
      setPreview(state.data ?? null)
    })

  const seal = () =>
    start(async () => {
      setError(null)
      const state = await sealBudgetAction({ budgetId: version.id })
      if (!state.success) {
        setError(state.error ?? "No se ha podido sellar la versión")
        return
      }
      setOpen(false)
      setConfirmCode("")
      setAck(false)
      router.refresh()
    })

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          setOpen(true)
          load()
        }}
        data-testid={`seal-${version.label}`}
      >
        Sellar
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Sellar la versión {version.label}</DialogTitle>
            <DialogDescription>
              Sellar fija el patrón de medida de toda la compañía: a partir de aquí la versión{" "}
              <strong>no se edita</strong> y los informes que la usen la citarán por su hash. Es política, no operación.
            </DialogDescription>
          </DialogHeader>

          {!preview && !error && (
            <p className="text-sm text-muted-foreground" data-testid="seal-loading">
              Componiendo lo que se va a firmar…
            </p>
          )}

          {preview && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border p-3 text-xs" data-testid="seal-preview">
              <dt className="text-muted-foreground">budgetHash que se firma</dt>
              <dd className="font-code break-all" data-testid="seal-hash">
                {preview.budgetHash}
              </dd>
              <dt className="text-muted-foreground">marginConfigHash</dt>
              <dd className="font-code break-all">{preview.marginConfigHash}</dd>
              <dt className="text-muted-foreground">Vigente desde</dt>
              <dd className="font-code">{preview.validFrom}</dd>
              <dt className="text-muted-foreground">Celdas / líneas de horas</dt>
              <dd className="font-code">
                {preview.cellCount} / {preview.hoursLineCount}
              </dd>
              <dt className="text-muted-foreground">Parcial desde</dt>
              <dd className="font-code">{preview.partialFrom ?? "cubre el ejercicio entero"}</dd>
              <dt className="text-muted-foreground">Versión que se cierra</dt>
              <dd data-testid="seal-closes-previous">
                {preview.closesPrevious
                  ? `${preview.closesPrevious.label}, con validTo = ${preview.closesPrevious.validTo}`
                  : "ninguna: es la primera vigencia del ejercicio"}
              </dd>
              <dt className="text-muted-foreground">Informes que caducan</dt>
              <dd className="font-code">{preview.expiringReports.join(", ")}</dd>
            </dl>
          )}

          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor={`seal-code-${version.id}`}>
                Escriba <span className="font-code">{version.label}</span> para confirmar
              </Label>
              <Input
                id={`seal-code-${version.id}`}
                className="font-code"
                value={confirmCode}
                onChange={(event) => setConfirmCode(event.target.value)}
                data-testid="seal-code"
              />
            </div>
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={ack}
                onChange={(event) => setAck(event.target.checked)}
                data-testid="seal-ack"
              />
              <span>
                Entiendo que el sello es irreversible: la versión deja de editarse y cualquier cambio posterior exige
                una revisión fechada.
              </span>
            </label>
          </div>

          {error && (
            <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert" data-testid="seal-error">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancelar
            </Button>
            <Button onClick={seal} disabled={pending || !puede} data-testid="seal-submit">
              {pending ? "Sellando…" : "Sellar la versión"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sustitución
// ─────────────────────────────────────────────────────────────────────────────

export function SupersedeBudgetDialog({
  version,
  versions,
}: {
  version: BudgetVersionView
  versions: readonly BudgetVersionView[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [supersededById, setSupersededById] = useState("")
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const candidates = versions.filter((v) => v.id !== version.id && v.fiscalYearId === version.fiscalYearId)
  const puede = supersededById !== "" && reason.trim().length >= 10

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => setOpen(true)}
        data-testid={`supersede-${version.label}`}
      >
        Sustituir
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Sustituir la versión {version.label}</DialogTitle>
            <DialogDescription>
              No existe «anular»: la versión sustituida sigue consultable y sigue explicando los informes que firmó. Lo
              que cambia es cuál rige de ahora en adelante.
            </DialogDescription>
          </DialogHeader>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">Versión que la sustituye</span>
            <select
              aria-label="Versión que la sustituye"
              className={SELECT_CLASS}
              value={supersededById}
              onChange={(event) => setSupersededById(event.target.value)}
              data-testid="supersede-target"
            >
              <option value="">Elige una versión…</option>
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label}
                </option>
              ))}
            </select>
          </label>
          <div className="space-y-1">
            <Label htmlFor={`supersede-reason-${version.id}`}>Motivo (mínimo 10 caracteres)</Label>
            <Textarea
              id={`supersede-reason-${version.id}`}
              value={reason}
              maxLength={512}
              onChange={(event) => setReason(event.target.value)}
              data-testid="supersede-reason"
            />
          </div>
          {error && (
            <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancelar
            </Button>
            <Button
              disabled={pending || !puede}
              data-testid="supersede-submit"
              onClick={() =>
                start(async () => {
                  setError(null)
                  const state = await supersedeBudgetAction({
                    budgetId: version.id,
                    supersededById,
                    reason: reason.trim(),
                  })
                  if (!state.success) {
                    setError(state.error ?? "No se ha podido sustituir la versión")
                    return
                  }
                  setOpen(false)
                  router.refresh()
                })
              }
            >
              {pending ? "Sustituyendo…" : "Sustituir"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
