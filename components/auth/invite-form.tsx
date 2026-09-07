"use client"

import {
  acceptInvitationAction,
  // E13 · T8 (dev-backend, en paralelo) — `setInvitedPasswordAction(token, formData)`, con
  // `formData` validado en el servidor contra `setInvitedPasswordFormSchema` (name/password/confirm).
  setInvitedPasswordAction,
} from "@/app/(auth)/invite/[token]/actions"
import { AuthError, ChipLabel, LineInput, PrimaryButton } from "@/components/auth/brand"
import { PasswordFields } from "@/components/auth/password-fields"
import { setInvitedPasswordFormSchema } from "@/forms/auth"
import { authClient } from "@/lib/auth-client"
import { useId, useState, useTransition } from "react"

/** Con sesión iniciada y el email correcto: un botón (E1, sin cambios de comportamiento). */
export function AcceptInvitationButton({ token }: { token: string }) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="flex w-full flex-col gap-3">
      <PrimaryButton
        type="button"
        className="w-full"
        disabled={pending}
        hideArrow={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null)
            const result = await acceptInvitationAction(token)
            if (result && !result.success) {
              setError(result.error ?? "No se ha podido aceptar la invitación")
            }
          })
        }
      >
        {pending ? "ACEPTANDO…" : "ACEPTAR INVITACIÓN"}
      </PrimaryButton>
      {error && <AuthError>{error}</AuthError>}
    </div>
  )
}

/**
 * E13 · T9 — Sin sesión: nombre + contraseña × 2, fija la credencial con
 * `setInvitedPasswordAction` y encadena `signIn.email` + `acceptInvitationAction`
 * (docs/design/E13-autenticacion.md §4.2, §8.1 criterios 5-7). Conserva el guardado de E1: la
 * propia acción del servidor repite la validación de token/rate-limit/intentos; aquí sólo se
 * muestra lo que ella devuelva.
 */
export function InviteForm({ token, email, roleLabel }: { token: string; email: string; roleLabel: string }) {
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const errorId = useId()

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)

    const validated = setInvitedPasswordFormSchema.safeParse({ name, password, confirm })
    if (!validated.success) {
      setError(validated.error.issues[0]?.message ?? "Revisa los datos")
      return
    }

    setIsLoading(true)
    try {
      const formData = new FormData()
      formData.set("name", validated.data.name)
      formData.set("password", validated.data.password)
      formData.set("confirm", validated.data.confirm)

      const prepared = await setInvitedPasswordAction(token, formData)
      if (!prepared.success) {
        setError(prepared.error ?? "Esta invitación ya no está disponible")
        return
      }

      const signedIn = await authClient.signIn.email({
        email: prepared.data?.email ?? email,
        password: validated.data.password,
      })
      if (signedIn.error) {
        setError("Contraseña guardada, pero no se ha podido entrar. Prueba a entrar desde /enter.")
        return
      }

      const accepted = await acceptInvitationAction(token)
      if (accepted && !accepted.success) {
        setError(accepted.error ?? "No se ha podido aceptar la invitación")
      }
      // Si `acceptInvitationAction` tiene éxito, redirige por sí misma a /dashboard.
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se ha podido completar el alta")
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex w-full flex-col gap-6" noValidate>
      <ChipLabel>INVITACIÓN · {roleLabel.toUpperCase()}</ChipLabel>

      <div className="flex flex-col gap-5">
        <LineInput label="Correo" name="email" type="email" value={email} readOnly disabled autoComplete="email" />
        <LineInput
          label="Tu nombre"
          name="name"
          type="text"
          autoComplete="name"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={isLoading}
          errorId={error ? errorId : undefined}
        />
        <PasswordFields
          password={password}
          confirm={confirm}
          onPasswordChange={setPassword}
          onConfirmChange={setConfirm}
          disabled={isLoading}
          errorId={error ? errorId : undefined}
        />
      </div>

      {error && <AuthError id={errorId}>{error}</AuthError>}

      <PrimaryButton type="submit" disabled={isLoading} hideArrow={isLoading} className="w-full">
        {isLoading ? "CREANDO CUENTA…" : "CREAR CUENTA Y ENTRAR"}
      </PrimaryButton>
    </form>
  )
}
