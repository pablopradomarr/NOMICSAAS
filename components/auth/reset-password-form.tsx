"use client"

import { AuthError, AuthSuccess, PrimaryButton } from "@/components/auth/brand"
import { PasswordFields } from "@/components/auth/password-fields"
import { isPasswordTooObvious, newPasswordFormSchema } from "@/forms/auth"
import { authClient } from "@/lib/auth-client"
import Link from "next/link"
import { useId, useState } from "react"

export const INVALID_TOKEN_ERROR = "Este enlace ha caducado o no es válido. Pide uno nuevo."
const GENERIC_RESET_ERROR = "No se ha podido actualizar la contraseña"

/**
 * Pura, exportada para test: los códigos que better-auth usa para "token inválido/caducado/ya
 * usado" (S3) llevan a la pantalla con enlace a pedir uno nuevo; cualquier otro error se muestra
 * junto al formulario para que se pueda reintentar sin perder los datos.
 */
export function classifyResetError(status: number): "invalid_token" | "form" {
  return status === 400 || status === 401 || status === 404 ? "invalid_token" : "form"
}

/**
 * E13 · T7 — `/reset-password/[token]`: contraseña nueva × 2 sobre `authClient.resetPassword`
 * (docs/design/E13-autenticacion.md §6, §8.1 criterio 9). El token va sólo en el path (nunca
 * se manda en query ni queda en el estado del cliente más que como prop).
 */
export function ResetPasswordForm({ token, email }: { token: string; email?: string }) {
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [invalidToken, setInvalidToken] = useState(false)
  const [done, setDone] = useState(false)
  const errorId = useId()

  if (done) {
    return (
      <div className="flex w-full flex-col gap-6">
        <AuthSuccess>Contraseña actualizada. Ya puedes entrar con ella.</AuthSuccess>
        <Link href="/enter" className="w-full">
          <PrimaryButton type="button" className="w-full">
            IR A ENTRAR
          </PrimaryButton>
        </Link>
      </div>
    )
  }

  if (invalidToken) {
    return (
      <div className="flex w-full flex-col gap-6">
        <AuthError>{INVALID_TOKEN_ERROR}</AuthError>
        <Link
          href="/forgot-password"
          className="font-[family-name:var(--font-open-sans)] text-sm text-[var(--nomic-gray)] underline-offset-4 hover:text-[var(--nomic-carbon)] hover:underline"
        >
          Pedir un enlace nuevo
        </Link>
      </div>
    )
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)

    const validated = newPasswordFormSchema.safeParse({ password, confirm })
    if (!validated.success) {
      setError(validated.error.issues[0]?.message ?? "Revisa la contraseña")
      return
    }
    if (email && isPasswordTooObvious(validated.data.password, email)) {
      setError("Elige una contraseña que no sea tu correo")
      return
    }

    setIsLoading(true)
    try {
      const result = await authClient.resetPassword({ newPassword: validated.data.password, token })

      if (result.error) {
        if (classifyResetError(result.error.status) === "invalid_token") {
          setInvalidToken(true)
        } else {
          setError(result.error.message || GENERIC_RESET_ERROR)
        }
        return
      }

      setDone(true)
    } catch {
      setError(GENERIC_RESET_ERROR)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex w-full flex-col gap-6" noValidate>
      <div className="flex flex-col gap-5">
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
        {isLoading ? "GUARDANDO…" : "GUARDAR CONTRASEÑA"}
      </PrimaryButton>
    </form>
  )
}
