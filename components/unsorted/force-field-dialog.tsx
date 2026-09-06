"use client"

import { forceOverrideAction } from "@/app/(app)/unsorted/actions"
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
import { MOTIVO_MIN } from "@/forms/extraction"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

/**
 * E8 · T15 — Forzar el valor de un campo (§4.3, `forceOverrideAction`).
 *
 * Forzar **no edita la extracción**: crea un run de revisión con el valor
 * puesto a mano, deja el campo en `no verificado` y escribe el motivo en
 * `AuditLog`. Y no sirve para saltarse un fallo aritmético: las cifras del pie
 * no son forzables y lo decide `applyFieldOverride` en el servidor, no esta
 * pantalla. Existe para lo que el diseño permite —el duplicado, el
 * `convertedTotal`— y para poner a mano lo que el modelo no supo leer.
 */
export function ForceFieldDialog({ runId, fields }: { runId: string; fields: readonly string[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [field, setField] = useState(fields[0] ?? "")
  const [value, setValue] = useState("")
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const submit = () =>
    startTransition(async () => {
      setError(null)
      const state = await forceOverrideAction({ runId, field: field.trim(), value, reason: reason.trim() })
      if (!state.success) {
        setError(state.error ?? "No se ha podido forzar el campo")
        return
      }
      setOpen(false)
      if (state.data?.runId) router.push(`?run=${state.data.runId}`)
      router.refresh()
    })

  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)} data-testid="force-field">
        Forzar un campo
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Forzar el valor de un campo</DialogTitle>
            <DialogDescription>
              El campo quedará marcado como <strong>no verificado</strong>, se creará una revisión colgada de esta
              extracción y el motivo quedará en el registro de auditoría. Las cifras que el motor calcula no son
              forzables.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium">Campo</span>
              {fields.length > 0 ? (
                <select
                  className="h-9 rounded-md border bg-transparent px-2 font-code text-xs"
                  value={field}
                  onChange={(event) => setField(event.target.value)}
                  data-testid="force-field-select"
                >
                  {fields.map((candidate) => (
                    <option key={candidate} value={candidate}>
                      {candidate}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  className="font-code text-xs"
                  value={field}
                  placeholder="counterparty.taxId"
                  onChange={(event) => setField(event.target.value)}
                />
              )}
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium">Valor</span>
              <Input value={value} onChange={(event) => setValue(event.target.value)} data-testid="force-field-value" />
            </label>
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={`Motivo (mínimo ${MOTIVO_MIN} caracteres)`}
              rows={3}
              data-testid="force-field-reason"
            />
            {error && (
              <p className="text-sm" role="alert">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={submit}
              disabled={pending || field.trim() === "" || reason.trim().length < MOTIVO_MIN}
            >
              {pending ? "Guardando…" : "Forzar campo"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
