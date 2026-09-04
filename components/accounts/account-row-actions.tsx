"use client"

import {
  deleteAccountAction,
  setAccountActiveAction,
} from "@/app/(app)/settings/accounts/actions"
import { ClassificationDialog } from "@/components/accounts/classification-dialog"
import { NewAccountDialog } from "@/components/accounts/new-account-dialog"
import type { ClassificationCatalog, PlanAccount } from "@/components/accounts/types"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Textarea } from "@/components/ui/textarea"
import { MoreHorizontal } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

type PendingAction = "deactivate" | "activate" | "delete" | null

/**
 * Menú de fila del plan. Toda acción destructiva abre un diálogo con MOTIVO
 * obligatorio, que viaja a `AuditLog` (`.claude/skills/ui-erp`). La protección
 * real está en la server action: aquí sólo se oculta lo que no procede.
 */
export function AccountRowActions({
  account,
  catalog,
  suggestedChildCode,
  canDelete,
  deleteBlockedReason,
}: {
  account: PlanAccount
  catalog: ClassificationCatalog
  suggestedChildCode: string
  canDelete: boolean
  deleteBlockedReason: string | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [dialog, setDialog] = useState<PendingAction>(null)
  const [newChildOpen, setNewChildOpen] = useState(false)
  const [classificationOpen, setClassificationOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)

  const close = () => {
    setDialog(null)
    setReason("")
    setError(null)
  }

  const submit = () => {
    const action = dialog
    if (!action) return
    setError(null)
    startTransition(async () => {
      const formData = new FormData()
      formData.set("code", account.code)
      formData.set("reason", reason)
      const state =
        action === "delete"
          ? await deleteAccountAction(null, formData)
          : await (() => {
              formData.set("isActive", action === "activate" ? "true" : "false")
              return setAccountActiveAction(null, formData)
            })()
      if (!state.success) {
        setError(state.error ?? "No se ha podido completar la operación")
        return
      }
      close()
      router.refresh()
    })
  }

  const dialogCopy: Record<Exclude<PendingAction, null>, { title: string; description: string; cta: string }> = {
    deactivate: {
      title: `Desactivar la cuenta ${account.code}`,
      description:
        "Una cuenta desactivada no admite apuntes nuevos, pero sigue apareciendo en los informes históricos (R-09).",
      cta: "Desactivar",
    },
    activate: {
      title: `Reactivar la cuenta ${account.code}`,
      description: "La cuenta volverá a admitir apuntes.",
      cta: "Reactivar",
    },
    delete: {
      title: `Eliminar la cuenta ${account.code}`,
      description:
        "Sólo se puede eliminar una cuenta sin apuntes, sin subcuentas, que no sea de sistema y que no use ningún tipo impositivo. Queda registrada con su contenido completo.",
      cta: "Eliminar",
    },
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Acciones de la cuenta ${account.code}`}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuItem onSelect={() => setNewChildOpen(true)}>Crear subcuenta…</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setClassificationOpen(true)}>Editar clasificación…</DropdownMenuItem>
          <DropdownMenuSeparator />
          {account.isActive ? (
            <DropdownMenuItem
              disabled={account.isSystem}
              onSelect={() => setDialog("deactivate")}
              title={account.isSystem ? "Es una cuenta de sistema: no se puede desactivar (R-06)" : undefined}
            >
              Desactivar…
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={() => setDialog("activate")}>Reactivar…</DropdownMenuItem>
          )}
          <DropdownMenuItem
            disabled={!canDelete}
            onSelect={() => setDialog("delete")}
            title={deleteBlockedReason ?? undefined}
          >
            Eliminar…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {newChildOpen && (
        <NewAccountDialog
          onOpenChange={setNewChildOpen}
          parent={account}
          suggestedCode={suggestedChildCode}
          catalog={catalog}
        />
      )}

      {classificationOpen && (
        <ClassificationDialog onOpenChange={setClassificationOpen} account={account} catalog={catalog} />
      )}

      <Dialog open={dialog !== null} onOpenChange={(open) => (open ? undefined : close())}>
        <DialogContent>
          {dialog && (
            <>
              <DialogHeader>
                <DialogTitle>{dialogCopy[dialog].title}</DialogTitle>
                <DialogDescription>{dialogCopy[dialog].description}</DialogDescription>
              </DialogHeader>
              <label className="flex flex-col gap-1">
                <span className="text-sm font-medium">
                  Motivo {dialog === "activate" ? "(opcional)" : <span aria-hidden>*</span>}
                </span>
                <Textarea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  rows={3}
                  placeholder="Por qué se hace este cambio (queda en el registro de auditoría)"
                />
              </label>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={close} disabled={pending}>
                  Cancelar
                </Button>
                <Button type="button" onClick={submit} disabled={pending}>
                  {pending ? "Guardando…" : dialogCopy[dialog].cta}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
