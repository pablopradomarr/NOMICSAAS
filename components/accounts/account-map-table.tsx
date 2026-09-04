"use client"

import { setAccountMapEntryAction } from "@/app/(app)/settings/account-map/actions"
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

export type PostableOption = { code: string; name: string }

export type AccountMapRow = {
  key: string
  /** Código canónico del PGC para esa clave (referencia, no obligación). */
  defaultCode: string
  accountCode: string | null
  accountName: string | null
  /** La cuenta a la que apunta no existe, está inactiva o no admite apuntes. */
  problem: string | null
  /** El código canónico no existía y la clave cayó a otra cuenta. */
  fallback: string | null
  required: boolean
}

const DATALIST_ID = "cuentas-postables"

/**
 * Mapa `AccountKey` → cuenta. El motor contable nunca escribe un código: pide
 * una clave y este mapa la resuelve, así que cambiar una fila cambia dónde se
 * contabilizarán todas las facturas posteriores. De ahí el motivo obligatorio.
 */
export function AccountMapTable({
  rows,
  options,
  canEdit,
  title,
  description,
}: {
  rows: AccountMapRow[]
  options: PostableOption[]
  canEdit: boolean
  title: string
  description: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [editing, setEditing] = useState<AccountMapRow | null>(null)
  const [code, setCode] = useState("")
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)

  const open = (row: AccountMapRow) => {
    setEditing(row)
    setCode(row.accountCode ?? row.defaultCode)
    setReason("")
    setError(null)
  }

  const submit = () => {
    if (!editing) return
    setError(null)
    startTransition(async () => {
      const formData = new FormData()
      formData.set("key", editing.key)
      formData.set("accountCode", code.trim())
      formData.set("reason", reason)
      const state = await setAccountMapEntryAction(null, formData)
      if (!state.success) {
        setError(state.error ?? "No se ha podido remapear la clave")
        return
      }
      setEditing(null)
      router.refresh()
    })
  }

  const selected = options.find((option) => option.code === code.trim())

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-lg font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>

      <datalist id={DATALIST_ID}>
        {options.map((option) => (
          <option key={option.code} value={option.code}>
            {option.name}
          </option>
        ))}
      </datalist>

      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Clave del motor</TableHead>
              <TableHead>Cuenta del PGC</TableHead>
              <TableHead>Cuenta asignada</TableHead>
              <TableHead>Aviso</TableHead>
              {canEdit && <TableHead className="w-32" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.key} data-account-key={row.key}>
                <TableCell className="font-code text-xs">{row.key}</TableCell>
                <TableCell className="font-code text-xs text-muted-foreground">{row.defaultCode}</TableCell>
                <TableCell>
                  {row.accountCode ? (
                    <span>
                      <span className="font-code">{row.accountCode}</span> · {row.accountName ?? "—"}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Sin asignar</span>
                  )}
                </TableCell>
                <TableCell className="text-sm">
                  {row.problem && <span className="text-destructive">{row.problem}</span>}
                  {!row.problem && row.fallback && <span className="text-[#B37400]">⚠ {row.fallback}</span>}
                  {!row.problem && !row.fallback && <span className="text-muted-foreground">—</span>}
                </TableCell>
                {canEdit && (
                  <TableCell>
                    <Button type="button" variant="outline" size="sm" onClick={() => open(row)}>
                      Cambiar…
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={editing !== null} onOpenChange={(next) => (next ? undefined : setEditing(null))}>
        <DialogContent>
          {editing && (
            <>
              <DialogHeader>
                <DialogTitle>Asignar cuenta a {editing.key}</DialogTitle>
                <DialogDescription>
                  Sólo se admiten cuentas de esta organización que existan, estén activas y admitan apuntes
                  (I-plan-1). La cuenta pasa a ser de sistema y no podrá desactivarse mientras la clave apunte a
                  ella.
                </DialogDescription>
              </DialogHeader>

              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium">Cuenta</span>
                <Input
                  list={DATALIST_ID}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  className="font-code"
                  placeholder="Código de cuenta"
                />
                <span className="text-xs text-muted-foreground">
                  {selected ? selected.name : "Escribe o elige un código de la lista de cuentas que admiten apuntes."}
                </span>
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium">
                  Motivo <span aria-hidden>*</span>
                </span>
                <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} />
              </label>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setEditing(null)} disabled={pending}>
                  Cancelar
                </Button>
                <Button type="button" onClick={submit} disabled={pending}>
                  {pending ? "Guardando…" : "Guardar"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}
