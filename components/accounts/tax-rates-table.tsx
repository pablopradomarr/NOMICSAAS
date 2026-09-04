"use client"

import { closeTaxRateAction, createTaxRateAction, updateTaxRateAction } from "@/app/(app)/settings/taxes/actions"
import type { PostableOption } from "@/components/accounts/account-map-table"
import { Badge } from "@/components/ui/badge"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

export type TaxRateView = {
  id: string
  code: string
  name: string
  kind: string
  /** Ya formateado en el servidor: «21», «5,2», «1,75». */
  rate: string
  rateInput: string
  appliesTo: string
  accountCode: string
  counterAccountCode: string | null
  linkedTaxRateId: string | null
  linkedCode: string | null
  validFrom: string
  validTo: string | null
  inForce: boolean
  isSystem: boolean
}

const KIND_LABELS: Record<string, string> = {
  IVA: "IVA",
  IRPF: "IRPF",
  RECARGO: "Recargo de equivalencia",
  EXENTO: "Exento / no sujeto",
}

const APPLIES_LABELS: Record<string, string> = {
  SALE: "Venta",
  PURCHASE: "Compra",
  BOTH: "Venta y compra",
}

const DATALIST_ID = "cuentas-postables-impuestos"
const NONE = "__none__"

type DialogState =
  | { mode: "create" }
  | { mode: "edit"; rate: TaxRateView }
  | { mode: "close"; rate: TaxRateView }
  | null

/**
 * Tipos impositivos con vigencia. Un tipo NO se borra: se cierra su vigencia,
 * para que un asiento de 2024 nunca coja el tipo de 2026 (C-7). El recargo de
 * equivalencia es un tributo distinto con fila propia, enlazado al IVA al que
 * acompaña.
 */
export function TaxRatesTable({
  rates,
  options,
  canEdit,
  today,
}: {
  rates: TaxRateView[]
  options: PostableOption[]
  canEdit: boolean
  today: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [dialog, setDialog] = useState<DialogState>(null)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<Record<string, string>>({})

  const ivaRates = rates.filter((rate) => rate.kind === "IVA" && rate.inForce)
  const vigentes = rates.filter((rate) => rate.inForce)
  const historicos = rates.filter((rate) => !rate.inForce)

  const openCreate = () => {
    setError(null)
    setForm({
      code: "",
      name: "",
      kind: "IVA",
      rateBps: "",
      appliesTo: "BOTH",
      accountCode: "",
      counterAccountCode: "",
      linkedTaxRateId: NONE,
      validFrom: today,
      validTo: "",
      reason: "",
    })
    setDialog({ mode: "create" })
  }

  const openEdit = (rate: TaxRateView) => {
    setError(null)
    setForm({
      name: rate.name,
      rateBps: rate.rateInput,
      appliesTo: rate.appliesTo,
      accountCode: rate.accountCode,
      counterAccountCode: rate.counterAccountCode ?? "",
      linkedTaxRateId: rate.linkedTaxRateId ?? NONE,
      validFrom: rate.validFrom,
      validTo: rate.validTo ?? "",
      reason: "",
    })
    setDialog({ mode: "edit", rate })
  }

  const openClose = (rate: TaxRateView) => {
    setError(null)
    setForm({ validTo: today, reason: "" })
    setDialog({ mode: "close", rate })
  }

  const set = (field: string, value: string) => setForm((previous) => ({ ...previous, [field]: value }))

  const submit = () => {
    if (!dialog) return
    setError(null)
    startTransition(async () => {
      const formData = new FormData()
      for (const [field, value] of Object.entries(form)) {
        if (field === "linkedTaxRateId" && value === NONE) continue
        formData.set(field, value)
      }
      let state
      if (dialog.mode === "create") {
        state = await createTaxRateAction(null, formData)
      } else if (dialog.mode === "edit") {
        formData.set("id", dialog.rate.id)
        state = await updateTaxRateAction(null, formData)
      } else {
        formData.set("id", dialog.rate.id)
        state = await closeTaxRateAction(null, formData)
      }
      if (!state.success) {
        setError(state.error ?? "No se ha podido guardar el tipo impositivo")
        return
      }
      setDialog(null)
      router.refresh()
    })
  }

  const renderTable = (rows: TaxRateView[], showActions: boolean) => (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Código</TableHead>
            <TableHead>Nombre</TableHead>
            <TableHead>Tributo</TableHead>
            <TableHead className="text-right">Tipo</TableHead>
            <TableHead>Aplica a</TableHead>
            <TableHead>Cuenta venta</TableHead>
            <TableHead>Cuenta compra</TableHead>
            <TableHead>Vigencia</TableHead>
            {showActions && canEdit && <TableHead className="w-40" />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={9} className="text-center text-muted-foreground">
                No hay tipos en esta sección.
              </TableCell>
            </TableRow>
          )}
          {rows.map((rate) => (
            <TableRow key={rate.id} data-tax-code={rate.code}>
              <TableCell className="font-code text-xs">
                {rate.code}
                {rate.isSystem && (
                  <Badge variant="secondary" className="ml-2">
                    sistema
                  </Badge>
                )}
              </TableCell>
              <TableCell>
                {rate.name}
                {rate.linkedCode && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    · acompaña a <span className="font-code">{rate.linkedCode}</span>
                  </span>
                )}
              </TableCell>
              <TableCell>{KIND_LABELS[rate.kind] ?? rate.kind}</TableCell>
              <TableCell className="text-right font-code tabular-nums">{rate.rate} %</TableCell>
              <TableCell>{APPLIES_LABELS[rate.appliesTo] ?? rate.appliesTo}</TableCell>
              <TableCell className="font-code text-xs">{rate.accountCode}</TableCell>
              <TableCell className="font-code text-xs">{rate.counterAccountCode ?? "—"}</TableCell>
              <TableCell className="font-code text-xs">
                {rate.validFrom} → {rate.validTo ?? "sin cierre"}
              </TableCell>
              {showActions && canEdit && (
                <TableCell>
                  <span className="flex gap-2">
                    <Button type="button" size="sm" variant="outline" onClick={() => openEdit(rate)}>
                      Editar
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => openClose(rate)}>
                      Cerrar
                    </Button>
                  </span>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )

  return (
    <div className="space-y-6">
      <datalist id={DATALIST_ID}>
        {options.map((option) => (
          <option key={option.code} value={option.code}>
            {option.name}
          </option>
        ))}
      </datalist>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">Tipos vigentes ({vigentes.length})</h3>
          {canEdit && (
            <Button type="button" size="sm" onClick={openCreate}>
              Nuevo tipo
            </Button>
          )}
        </div>
        {renderTable(vigentes, true)}
      </section>

      <section className="space-y-3">
        <h3 className="text-lg font-semibold">Histórico ({historicos.length})</h3>
        <p className="text-sm text-muted-foreground">
          Tipos con la vigencia ya cerrada. Se conservan porque los documentos de su periodo siguen necesitándolos.
        </p>
        {renderTable(historicos, false)}
      </section>

      <Dialog open={dialog !== null} onOpenChange={(open) => (open ? undefined : setDialog(null))}>
        <DialogContent className="max-w-2xl">
          {dialog && dialog.mode === "close" && (
            <>
              <DialogHeader>
                <DialogTitle>Cerrar la vigencia de {dialog.rate.code}</DialogTitle>
                <DialogDescription>
                  El tipo deja de aplicarse a partir del día siguiente a la fecha de cierre. No se borra: los
                  documentos anteriores siguen resolviéndolo.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className="text-sm font-medium">Vigente hasta</span>
                  <Input type="date" value={form.validTo ?? ""} onChange={(e) => set("validTo", e.target.value)} />
                </label>
              </div>
              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium">
                  Motivo <span aria-hidden>*</span>
                </span>
                <Textarea value={form.reason ?? ""} onChange={(e) => set("reason", e.target.value)} rows={2} />
              </label>
            </>
          )}

          {dialog && dialog.mode !== "close" && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {dialog.mode === "create" ? "Nuevo tipo impositivo" : `Editar ${dialog.rate.code}`}
                </DialogTitle>
                <DialogDescription>
                  El tipo se expresa en porcentaje con hasta dos decimales (21, 5,2, 1,75). Una fila por tributo: la
                  dirección del asiento la fija la plantilla, no el impuesto.
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-4 sm:grid-cols-2">
                {dialog.mode === "create" && (
                  <>
                    <label className="flex flex-col gap-1">
                      <span className="text-sm font-medium">Código</span>
                      <Input
                        value={form.code ?? ""}
                        onChange={(e) => set("code", e.target.value.toUpperCase())}
                        className="font-code"
                        placeholder="IVA_21"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-sm font-medium">Tributo</span>
                      <Select value={form.kind ?? "IVA"} onValueChange={(value) => set("kind", value)}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.entries(KIND_LABELS).map(([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </label>
                  </>
                )}

                <label className="flex flex-col gap-1 sm:col-span-2">
                  <span className="text-sm font-medium">Nombre</span>
                  <Input value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-sm font-medium">Tipo (%)</span>
                  <Input
                    value={form.rateBps ?? ""}
                    onChange={(e) => set("rateBps", e.target.value)}
                    className="font-code"
                    placeholder="21"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-sm font-medium">Aplica a</span>
                  <Select value={form.appliesTo ?? "BOTH"} onValueChange={(value) => set("appliesTo", value)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(APPLIES_LABELS).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-sm font-medium">Cuenta del lado venta</span>
                  <Input
                    list={DATALIST_ID}
                    value={form.accountCode ?? ""}
                    onChange={(e) => set("accountCode", e.target.value)}
                    className="font-code"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-sm font-medium">Cuenta del lado compra</span>
                  <Input
                    list={DATALIST_ID}
                    value={form.counterAccountCode ?? ""}
                    onChange={(e) => set("counterAccountCode", e.target.value)}
                    className="font-code"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-sm font-medium">Vigente desde</span>
                  <Input type="date" value={form.validFrom ?? ""} onChange={(e) => set("validFrom", e.target.value)} />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-sm font-medium">Vigente hasta (opcional)</span>
                  <Input type="date" value={form.validTo ?? ""} onChange={(e) => set("validTo", e.target.value)} />
                </label>

                <label className="flex flex-col gap-1 sm:col-span-2">
                  <span className="text-sm font-medium">IVA al que acompaña (sólo recargo de equivalencia)</span>
                  <Select
                    value={form.linkedTaxRateId ?? NONE}
                    onValueChange={(value) => set("linkedTaxRateId", value)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Sin enlace" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Sin enlace</SelectItem>
                      {ivaRates.map((rate) => (
                        <SelectItem key={rate.id} value={rate.id}>
                          {rate.code} · {rate.rate} %
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>

                <label className="flex flex-col gap-1 sm:col-span-2">
                  <span className="text-sm font-medium">Motivo (opcional)</span>
                  <Textarea value={form.reason ?? ""} onChange={(e) => set("reason", e.target.value)} rows={2} />
                </label>
              </div>
            </>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setDialog(null)} disabled={pending}>
              Cancelar
            </Button>
            <Button type="button" onClick={submit} disabled={pending}>
              {pending ? "Guardando…" : "Guardar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
