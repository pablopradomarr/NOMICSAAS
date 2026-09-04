"use client"

import { deleteAccountAction, setAccountActiveAction } from "@/app/(app)/settings/accounts/actions"
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

export type AccountAction = "new-child" | "classification" | "deactivate" | "activate" | "delete"

/** Cuenta sobre la que está abierta una acción. Sólo hay UNA a la vez. */
export type AccountActionTarget = { account: PlanAccount; action: AccountAction }

/**
 * Menú de fila del plan.
 *
 * REVISIÓN (hallazgo 7): antes este componente montaba, POR FILA, tres diálogos
 * (`NewAccountDialog`, `ClassificationDialog` y el de confirmación con motivo)
 * más su estado y su `useTransition`. Con el plan GENERAL expandido eso son
 * ~900 filas × varios componentes de Radix, cada uno con sus portales y sus
 * listeners: la pestaña se arrastraba al expandir. Ahora la fila sólo renderiza
 * el botón y su menú —que es lo único visible— y AVISA hacia arriba; los
 * diálogos viven una sola vez en `AccountActionsHost`, a nivel de árbol.
 *
 * Es la opción más simple que baja el coste: no añade dependencia de
 * virtualización y deja el DOM de la tabla intacto (la búsqueda por texto del
 * navegador y los tests e2e siguen viendo todas las filas).
 */
export function AccountRowMenu({
  account,
  canDelete,
  deleteBlockedReason,
  onAction,
}: {
  account: PlanAccount
  canDelete: boolean
  deleteBlockedReason: string | null
  onAction: (action: AccountAction) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Acciones de la cuenta ${account.code}`}>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem onSelect={() => onAction("new-child")}>Crear subcuenta…</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAction("classification")}>Editar clasificación…</DropdownMenuItem>
        <DropdownMenuSeparator />
        {account.isActive ? (
          <DropdownMenuItem
            disabled={account.isSystem}
            onSelect={() => onAction("deactivate")}
            title={account.isSystem ? "Es una cuenta de sistema: no se puede desactivar (R-06)" : undefined}
          >
            Desactivar…
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={() => onAction("activate")}>Reactivar…</DropdownMenuItem>
        )}
        <DropdownMenuItem disabled={!canDelete} onSelect={() => onAction("delete")} title={deleteBlockedReason ?? undefined}>
          Eliminar…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const CONFIRM_COPY: Record<"deactivate" | "activate" | "delete", { title: (code: string) => string; description: string; cta: string }> = {
  deactivate: {
    title: (code) => `Desactivar la cuenta ${code}`,
    description:
      "Una cuenta desactivada no admite apuntes nuevos, pero sigue apareciendo en los informes históricos (R-09).",
    cta: "Desactivar",
  },
  activate: {
    title: (code) => `Reactivar la cuenta ${code}`,
    description: "La cuenta volverá a admitir apuntes.",
    cta: "Reactivar",
  },
  delete: {
    title: (code) => `Eliminar la cuenta ${code}`,
    description:
      "Sólo se puede eliminar una cuenta sin apuntes, sin subcuentas, que no sea de sistema y que no use ningún tipo impositivo. Queda registrada con su contenido completo.",
    cta: "Eliminar",
  },
}

/**
 * Diálogos de las acciones de cuenta. Se monta UNA vez por árbol y sólo cuando
 * hay una acción abierta: es lo que evita multiplicar el coste por número de filas.
 */
export function AccountActionsHost({
  target,
  catalog,
  suggestedChildCode,
  onClose,
}: {
  target: AccountActionTarget | null
  catalog: ClassificationCatalog
  suggestedChildCode: string
  onClose: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)

  if (!target) return null
  const { account, action } = target

  const close = () => {
    setReason("")
    setError(null)
    onClose()
  }

  if (action === "new-child") {
    return (
      <NewAccountDialog
        onOpenChange={(open) => (open ? undefined : close())}
        parent={account}
        suggestedCode={suggestedChildCode}
        catalog={catalog}
      />
    )
  }

  if (action === "classification") {
    return (
      <ClassificationDialog
        onOpenChange={(open) => (open ? undefined : close())}
        account={account}
        catalog={catalog}
      />
    )
  }

  const copy = CONFIRM_COPY[action]

  const submit = () => {
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

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{copy.title(account.code)}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">
            Motivo {action === "activate" ? "(opcional)" : <span aria-hidden>*</span>}
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
            {pending ? "Guardando…" : copy.cta}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
