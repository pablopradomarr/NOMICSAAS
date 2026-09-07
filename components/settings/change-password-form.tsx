"use client"

/**
 * E13 · T12 — Sección "Cambiar contraseña" en el perfil (docs/design/E13-autenticacion.md §6.1,
 * §8.2 T12, criterio 12). Estilo shadcn de la app (no el kit de marca de `app/(auth)`, reservado
 * a §6.2): reutiliza `FormInput`/`FormError` igual que el resto de `/settings/profile`.
 *
 * Sólo se monta cuando el llamador decide mostrarla (self-hosted no tiene contraseña que
 * cambiar; ver `app/(app)/settings/profile/page.tsx`).
 */

import { changeMyPasswordAction } from "@/app/(app)/settings/profile/actions"
import { FormError } from "@/components/forms/error"
import { FormInput } from "@/components/forms/simple"
import { Button } from "@/components/ui/button"
import { PASSWORD_MIN_LENGTH } from "@/forms/auth"
import { CircleCheckBig } from "lucide-react"
import { useActionState } from "react"

export function ChangePasswordForm() {
  const [state, action, pending] = useActionState(changeMyPasswordAction, null)

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold">Cambiar contraseña</h3>
        <p className="text-sm text-muted-foreground">
          Al cambiarla se cerrarán tus demás sesiones; ésta sigue abierta.
        </p>
      </div>

      <form action={action} className="space-y-4" key={state?.success ? "success" : "idle"}>
        <FormInput
          title="Contraseña actual"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
        />
        <FormInput
          title="Contraseña nueva"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN_LENGTH}
          placeholder={`Mínimo ${PASSWORD_MIN_LENGTH} caracteres`}
          required
        />
        <FormInput
          title="Repite la contraseña nueva"
          name="confirm"
          type="password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN_LENGTH}
          required
        />

        <div className="flex flex-row items-center gap-4">
          <Button type="submit" disabled={pending}>
            {pending ? "Cambiando…" : "Cambiar contraseña"}
          </Button>
          {state?.success && (
            <p className="text-green-500 flex flex-row items-center gap-2">
              <CircleCheckBig />
              Contraseña cambiada. Se han cerrado tus otras sesiones.
            </p>
          )}
        </div>

        {state && !state.success && state.error && <FormError>{state.error}</FormError>}
      </form>
    </div>
  )
}
