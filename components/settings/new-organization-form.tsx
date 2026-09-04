"use client"

import { createOrganizationAction } from "@/app/(app)/organizations/actions"
import { FormError } from "@/components/forms/error"
import { FormInput, FormSelect } from "@/components/forms/simple"
import { Button } from "@/components/ui/button"
import { BASE_CURRENCY_OPTIONS, PGC_VARIANT_OPTIONS, TIMEZONE_OPTIONS } from "@/lib/organization-options"
import Link from "next/link"
import { useActionState } from "react"

export function NewOrganizationForm() {
  const [state, action, pending] = useActionState(createOrganizationAction, null)

  return (
    <form action={action} className="max-w-2xl space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <FormInput title="Nombre" name="name" placeholder="Estudio Norte SL" required maxLength={128} autoFocus />
        <FormInput title="NIF / CIF" name="taxId" placeholder="B12345678" maxLength={32} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormSelect title="Moneda base" name="baseCurrency" items={[...BASE_CURRENCY_OPTIONS]} defaultValue="EUR" />
        <FormSelect title="Zona horaria" name="timezone" items={[...TIMEZONE_OPTIONS]} defaultValue="Europe/Madrid" />
      </div>

      <div className="max-w-sm space-y-1">
        <FormSelect
          title="Variante del Plan General Contable"
          name="pgcVariant"
          items={[...PGC_VARIANT_OPTIONS]}
          defaultValue="PYMES"
        />
        <p className="text-xs text-muted-foreground">
          PYMES es el plan abreviado; GENERAL incluye además los grupos 8 y 9. Podrás cambiarlo mientras no haya
          asientos.
        </p>
      </div>

      <div className="flex items-center gap-4">
        <Button type="submit" disabled={pending}>
          {pending ? "Creando…" : "Crear organización"}
        </Button>
        <Link href="/dashboard" className="text-sm text-muted-foreground hover:underline">
          Cancelar
        </Link>
      </div>

      {state?.error && <FormError>{state.error}</FormError>}
    </form>
  )
}
