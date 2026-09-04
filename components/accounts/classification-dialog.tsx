"use client"

import { updateAccountClassificationAction } from "@/app/(app)/settings/accounts/actions"
import {
  ANALYTIC_TYPE_LABELS,
  CASHFLOW_LABELS,
  STATEMENT_LABELS,
  type ClassificationCatalog,
  type PlanAccount,
} from "@/components/accounts/types"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

const NONE = "__none__"

/**
 * Clasificación de una cuenta: epígrafe, tipo analítico y categoría de cashflow.
 *
 * El `statement` NO aparece: en una cuenta oficial de nivel ≤ 3 está prohibido a
 * todos los roles (R-10a) y en el resto se hereda del padre; la vía correcta es
 * crear una subcuenta. El epígrafe se elige de un catálogo CERRADO (R-15) y, si
 * la cuenta viene del seed, exige motivo (R-10b).
 */
export function ClassificationDialog({
  onOpenChange,
  account,
  catalog,
}: {
  onOpenChange: (open: boolean) => void
  account: PlanAccount
  catalog: ClassificationCatalog
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const current = catalog.variant === "PYMES" ? (account.epigraphPymes ?? account.epigraph) : account.epigraph

  const [epigraph, setEpigraph] = useState(current ?? NONE)
  const [analyticType, setAnalyticType] = useState(account.analyticType ?? NONE)
  const [cashflow, setCashflow] = useState(account.cashflowCategory ?? NONE)
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])

  const epigraphChanged = (epigraph === NONE ? null : epigraph) !== current
  const reasonRequired = epigraphChanged && account.origin === "SEED"

  const submit = () => {
    setError(null)
    setWarnings([])
    startTransition(async () => {
      const formData = new FormData()
      formData.set("code", account.code)
      formData.set("epigraph", epigraph === NONE ? "" : epigraph)
      formData.set("analyticType", analyticType === NONE ? "" : analyticType)
      formData.set("cashflowCategory", cashflow === NONE ? "" : cashflow)
      formData.set("reason", reason)
      const state = await updateAccountClassificationAction(null, formData)
      if (!state.success) {
        setError(state.error ?? "No se ha podido guardar la clasificación")
        return
      }
      const nextWarnings = state.data?.warnings ?? []
      router.refresh()
      if (nextWarnings.length > 0) {
        setWarnings(nextWarnings)
        return
      }
      onOpenChange(false)
    })
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            Clasificación de <span className="font-code">{account.code}</span> · {account.name}
          </DialogTitle>
          <DialogDescription>
            Estado financiero: {account.statement ? (STATEMENT_LABELS[account.statement] ?? account.statement) : "—"}.
            No es editable: para presentar un saldo en otro epígrafe del balance, crea una subcuenta (R-10a).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">Epígrafe ({catalog.variant})</span>
            <Select value={epigraph} onValueChange={setEpigraph}>
              <SelectTrigger>
                <SelectValue placeholder="Sin epígrafe" />
              </SelectTrigger>
              <SelectContent className="max-h-80">
                <SelectItem value={NONE}>Sin epígrafe</SelectItem>
                {catalog.epigraphs.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground">
              Catálogo cerrado de la variante: un epígrafe libre no agregaría en ningún informe (R-15).
            </span>
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">Tipo analítico</span>
              <Select value={analyticType} onValueChange={setAnalyticType}>
                <SelectTrigger>
                  <SelectValue placeholder="Sin tipo" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Sin tipo</SelectItem>
                  {catalog.analyticTypes.map((value) => (
                    <SelectItem key={value} value={value}>
                      {ANALYTIC_TYPE_LABELS[value] ?? value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">Categoría de cashflow</span>
              <Select value={cashflow} onValueChange={setCashflow}>
                <SelectTrigger>
                  <SelectValue placeholder="Sin categoría" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Sin categoría</SelectItem>
                  {catalog.cashflowCategories.map((value) => (
                    <SelectItem key={value} value={value}>
                      {CASHFLOW_LABELS[value] ?? value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">Motivo {reasonRequired ? <span aria-hidden>*</span> : "(opcional)"}</span>
            <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} />
            {reasonRequired && (
              <span className="text-xs text-muted-foreground">
                Cambiar el epígrafe de una cuenta sembrada exige un motivo: reclasifica las cuentas anuales (R-10b).
              </span>
            )}
          </label>

          {warnings.length > 0 && (
            <ul className="space-y-1 rounded-md border border-[#F5A623] bg-[#F5A623]/10 p-3 text-sm">
              {warnings.map((warning) => (
                <li key={warning}>⚠ {warning}</li>
              ))}
            </ul>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            {warnings.length > 0 ? "Cerrar" : "Cancelar"}
          </Button>
          <Button type="button" onClick={submit} disabled={pending}>
            {pending ? "Guardando…" : "Guardar clasificación"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
