"use client"

import { createAccountAction } from "@/app/(app)/settings/accounts/actions"
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
import { Input } from "@/components/ui/input"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

/**
 * Alta de subcuenta bajo un padre. Se MONTA al abrirse (el padre la renderiza
 * sólo entonces), así que el formulario nace limpio sin efectos. El código llega pre-rellenado (padre + un
 * dígito libre) y la clasificación se HEREDA del padre: se muestra, no se pide.
 * Quien decide de verdad es `validateNewAccount` en el servidor.
 */
export function NewAccountDialog({
  onOpenChange,
  parent,
  suggestedCode,
  catalog,
}: {
  onOpenChange: (open: boolean) => void
  parent: PlanAccount
  suggestedCode: string
  catalog: ClassificationCatalog
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [code, setCode] = useState(suggestedCode)
  const [name, setName] = useState("")
  const [error, setError] = useState<string | null>(null)

  const inheritedEpigraph =
    catalog.variant === "PYMES" ? (parent.epigraphPymes ?? parent.epigraph) : parent.epigraph

  const submit = () => {
    setError(null)
    startTransition(async () => {
      const formData = new FormData()
      formData.set("code", code)
      formData.set("name", name)
      const state = await createAccountAction(null, formData)
      if (!state.success) {
        setError(state.error ?? "No se ha podido crear la cuenta")
        return
      }
      onOpenChange(false)
      router.refresh()
    })
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Crear subcuenta de {parent.code}</DialogTitle>
          <DialogDescription>
            La subcuenta hereda naturaleza, estado financiero, epígrafe y tipo analítico de{" "}
            <span className="font-code">{parent.code}</span>, que dejará de admitir apuntes en cuanto tenga hijas
            (R-04).
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">Código</span>
            <Input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              className="font-code"
              inputMode="numeric"
              maxLength={12}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">Nombre</span>
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={255} autoFocus />
          </label>
        </div>

        <dl className="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-1 rounded-md bg-muted/40 p-3 text-sm">
          <dt className="text-muted-foreground">Naturaleza</dt>
          <dd>{parent.nature === "DEUDORA" ? "Deudora" : "Acreedora"}</dd>
          <dt className="text-muted-foreground">Estado financiero</dt>
          <dd>{parent.statement ? (STATEMENT_LABELS[parent.statement] ?? parent.statement) : "—"}</dd>
          <dt className="text-muted-foreground">Epígrafe</dt>
          <dd>{inheritedEpigraph ?? "—"}</dd>
          <dt className="text-muted-foreground">Tipo analítico</dt>
          <dd>{parent.analyticType ? (ANALYTIC_TYPE_LABELS[parent.analyticType] ?? parent.analyticType) : "—"}</dd>
          <dt className="text-muted-foreground">Cashflow</dt>
          <dd>
            {parent.cashflowBucket ? (CASHFLOW_LABELS[parent.cashflowBucket] ?? parent.cashflowBucket) : "—"}
          </dd>
        </dl>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancelar
          </Button>
          <Button type="button" onClick={submit} disabled={pending || name.trim().length < 2}>
            {pending ? "Creando…" : "Crear subcuenta"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
