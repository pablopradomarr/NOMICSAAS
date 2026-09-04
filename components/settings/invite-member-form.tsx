"use client"

import { inviteMemberAction } from "@/app/(app)/settings/members/actions"
import { FormError } from "@/components/forms/error"
import { FormInput, FormSelect } from "@/components/forms/simple"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ROLE_DESCRIPTIONS, ROLE_OPTIONS } from "@/lib/organization-options"
import { CircleCheckBig } from "lucide-react"
import { useActionState } from "react"

export function InviteMemberForm() {
  const [state, action, pending] = useActionState(inviteMemberAction, null)

  return (
    <div className="space-y-3">
      <form action={action} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <FormInput
          title="Correo electrónico"
          name="email"
          type="email"
          placeholder="persona@empresa.es"
          required
          className="sm:w-72"
        />
        <FormSelect title="Perfil" name="role" items={[...ROLE_OPTIONS]} defaultValue="EDITOR" />
        <Button type="submit" disabled={pending}>
          {pending ? "Enviando…" : "Invitar"}
        </Button>
      </form>

      <p className="text-xs text-muted-foreground">
        {ROLE_OPTIONS.map((option) => `${option.name}: ${ROLE_DESCRIPTIONS[option.code]}`).join(" ")}
      </p>

      {state?.success && state.data?.emailSent && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CircleCheckBig className="h-4 w-4" />
          Invitación enviada por correo.
        </p>
      )}

      {state?.success && state.data && !state.data.emailSent && state.data.inviteUrl && (
        <div className="space-y-2 rounded-md border bg-muted/40 p-3">
          <p className="text-sm">
            No hay proveedor de correo configurado. Copia este enlace y hazlo llegar a la persona invitada:
          </p>
          <Input readOnly value={state.data.inviteUrl} onFocus={(event) => event.currentTarget.select()} className="font-mono text-xs" />
        </div>
      )}

      {state?.error && <FormError>{state.error}</FormError>}
    </div>
  )
}
