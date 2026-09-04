"use client"

import { createSoftwareAccountsAction } from "@/app/(app)/settings/account-map/actions"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Textarea } from "@/components/ui/textarea"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

/**
 * §2.5 — cuentas de convención de software (4720/4730/4760/4770). No son
 * cuentas oficiales del PGC: se crean bajo demanda y SIEMPRE como subcuentas de
 * 472/473/476/477 (R-20). Al colgarles un hijo, el padre deja de admitir
 * apuntes, así que el servidor baja las claves afectadas a la hoja.
 */
export function SoftwareAccountsForm({
  options,
  existing,
}: {
  options: readonly { code: string; name: string }[]
  existing: readonly string[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [selected, setSelected] = useState<string[]>([])
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string[] | null>(null)

  const pendientes = options.filter((option) => !existing.includes(option.code))

  const submit = () => {
    setError(null)
    setDone(null)
    startTransition(async () => {
      const formData = new FormData()
      for (const code of selected) formData.append("codes", code)
      formData.set("reason", reason)
      const state = await createSoftwareAccountsAction(null, formData)
      if (!state.success) {
        setError(state.error ?? "No se han podido crear las cuentas de desglose")
        return
      }
      setDone(state.data?.created ?? [])
      setSelected([])
      setReason("")
      router.refresh()
    })
  }

  if (pendientes.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Esta organización ya tiene todas las cuentas de desglose creadas.
      </p>
    )
  }

  return (
    <div className="max-w-2xl space-y-3">
      <ul className="space-y-2">
        {pendientes.map((option) => (
          <li key={option.code} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={selected.includes(option.code)}
              onCheckedChange={(checked) =>
                setSelected((previous) =>
                  checked === true ? [...previous, option.code] : previous.filter((code) => code !== option.code)
                )
              }
              id={`software-${option.code}`}
            />
            <label htmlFor={`software-${option.code}`}>
              <span className="font-code">{option.code}</span> · {option.name}
            </label>
          </li>
        ))}
      </ul>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">
          Motivo <span aria-hidden>*</span>
        </span>
        <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} />
      </label>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {done && done.length > 0 && (
        <p className="text-sm text-muted-foreground">Creadas: {done.join(", ")}.</p>
      )}

      <Button type="button" onClick={submit} disabled={pending || selected.length === 0}>
        {pending ? "Creando…" : "Crear cuentas de desglose"}
      </Button>
    </div>
  )
}
