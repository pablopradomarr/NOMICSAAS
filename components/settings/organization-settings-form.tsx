"use client"

import { updateOrganizationAction } from "@/app/(app)/settings/organization/actions"
import { FormError } from "@/components/forms/error"
import { FormInput, FormSelect } from "@/components/forms/simple"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { BASE_CURRENCY_OPTIONS, PGC_VARIANT_OPTIONS, TIMEZONE_OPTIONS } from "@/lib/organization-options"
import { Organization } from "@/prisma/client"
import { CircleCheckBig } from "lucide-react"
import { useActionState } from "react"

/** Opciones del select garantizando que el valor actual siempre está presente. */
function withCurrent(options: readonly { code: string; name: string }[], current: string) {
  return options.some((option) => option.code === current) ? [...options] : [{ code: current, name: current }, ...options]
}

export function OrganizationSettingsForm({
  organization,
  canEdit,
}: {
  organization: Organization
  canEdit: boolean
}) {
  const [state, action, pending] = useActionState(updateOrganizationAction, null)

  return (
    <form action={action} className="max-w-2xl space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <FormInput
          title="Nombre"
          name="name"
          defaultValue={organization.name}
          required
          maxLength={128}
          disabled={!canEdit}
        />
        <FormInput
          title="NIF / CIF"
          name="taxId"
          placeholder="B12345678"
          defaultValue={organization.taxId ?? ""}
          maxLength={32}
          disabled={!canEdit}
        />
      </div>

      <label className="flex max-w-xs flex-col gap-1">
        <span className="text-sm font-medium">Identificador (slug)</span>
        <Input value={organization.slug} readOnly disabled className="font-mono text-xs" />
        <span className="text-xs text-muted-foreground">
          Se genera al crear la organización y no puede modificarse.
        </span>
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormSelect
          title="Moneda base"
          name="baseCurrency"
          items={withCurrent(BASE_CURRENCY_OPTIONS, organization.baseCurrency)}
          defaultValue={organization.baseCurrency}
          disabled={!canEdit}
        />
        <FormSelect
          title="Zona horaria"
          name="timezone"
          items={withCurrent(TIMEZONE_OPTIONS, organization.timezone)}
          defaultValue={organization.timezone}
          disabled={!canEdit}
        />
      </div>

      <div className="max-w-sm space-y-1">
        <FormSelect
          title="Variante del Plan General Contable"
          name="pgcVariant"
          items={[...PGC_VARIANT_OPTIONS]}
          defaultValue={organization.pgcVariant}
          disabled={!canEdit}
        />
        <p className="text-xs text-muted-foreground">
          PYMES es el plan abreviado; GENERAL incluye además los grupos 8 y 9.
        </p>
      </div>

      {canEdit ? (
        <div className="flex flex-row items-center gap-4">
          <Button type="submit" disabled={pending}>
            {pending ? "Guardando…" : "Guardar cambios"}
          </Button>
          {state?.success && (
            <p className="flex flex-row items-center gap-2 text-sm text-muted-foreground">
              <CircleCheckBig className="h-4 w-4" />
              Cambios guardados
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Sólo un administrador puede modificar la configuración de la organización.
        </p>
      )}

      {state?.error && <FormError>{state.error}</FormError>}
    </form>
  )
}
