"use client"

/**
 * E11 · ola C · **T14** — preferencias del MOTOR que viven en la organización
 * (docs/design/E11-plataforma-saas.md §6.4, D-3).
 *
 * El mes de arranque de la amortización no es una etiqueta administrativa:
 * decide la primera cuota del cuadro de todo activo que se dé de alta a partir
 * de ahora. Por eso se declara aquí, se avisa de lo que cambia y **no** se toca
 * el valor por defecto (`MES_SIGUIENTE`, que es lo que el motor de E9 ya hace):
 * cambiarlo alteraría cuadros ya contabilizados, y eso no se hace en una épica
 * de plataforma.
 *
 * Nada se calcula en el cliente: el formulario envía la preferencia y el
 * servidor la valida y la escribe.
 */

import { updateOrganizationPreferencesAction } from "@/app/(app)/settings/organization/actions"
import { FormError } from "@/components/forms/error"
import { FormInput, FormSelect } from "@/components/forms/simple"
import { Button } from "@/components/ui/button"
import { useActionState } from "react"

export const DEPRECIATION_START_OPTIONS = [
  { code: "MES_SIGUIENTE", name: "El mes siguiente al alta (predeterminado)" },
  { code: "MES_DE_ALTA", name: "El mismo mes del alta" },
] as const

export function OrganizationPreferencesForm({
  depreciationStartsOn,
  backupRetentionDays,
  platformNoticeEmail,
  brand,
  canEdit,
}: {
  depreciationStartsOn: string
  backupRetentionDays: number
  platformNoticeEmail: string
  brand: { product: string; company: string }
  canEdit: boolean
}) {
  const [state, action, pending] = useActionState(updateOrganizationPreferencesAction, null)

  return (
    <section className="space-y-4" data-testid="organization-preferences">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold">Preferencias del motor</h3>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Estas tres decisiones no son de presentación. La primera cambia el cuadro de amortización de los activos que
          se den de alta a partir de ahora —los ya contabilizados no se tocan—; la segunda, cuánto se conservan las
          copias de seguridad; la tercera, a quién escribimos cuando pasa algo con el servicio.
        </p>
      </div>

      <form action={action} className="max-w-2xl space-y-5">
        <div className="space-y-1">
          <FormSelect
            title="La amortización arranca"
            name="depreciationStartsOn"
            items={[...DEPRECIATION_START_OPTIONS]}
            defaultValue={depreciationStartsOn}
            disabled={!canEdit}
          />
          <p className="text-xs text-muted-foreground">
            Afecta sólo a los activos dados de alta después del cambio. Los cuadros ya contabilizados conservan el
            criterio con el que nacieron.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormInput
            title="Retención de las copias de seguridad (días)"
            name="backupRetentionDays"
            type="number"
            min={1}
            max={3650}
            defaultValue={String(backupRetentionDays)}
            disabled={!canEdit}
          />
          <FormInput
            title="Destinatario de los avisos de plataforma"
            name="platformNoticeEmail"
            type="email"
            placeholder="administracion@empresa.es"
            defaultValue={platformNoticeEmail}
            maxLength={160}
            disabled={!canEdit}
          />
        </div>

        <p className="text-xs text-muted-foreground">
          Servicio prestado por <strong>{brand.company}</strong> ({brand.product}).
        </p>

        {canEdit && (
          <Button type="submit" size="sm" disabled={pending} data-testid="preferences-submit">
            {pending ? "Guardando…" : "Guardar preferencias"}
          </Button>
        )}

        {state?.error && <FormError>{state.error}</FormError>}
        {state?.success && <p className="text-xs text-muted-foreground">Preferencias guardadas.</p>}
      </form>
    </section>
  )
}
