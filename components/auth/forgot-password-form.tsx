"use client"

import { AuthError, AuthSuccess, LineInput, PrimaryButton } from "@/components/auth/brand"
import { forgotPasswordFormSchema } from "@/forms/auth"
import { authClient } from "@/lib/auth-client"
import { useId, useState } from "react"

/** S1: la respuesta es siempre la misma exista o no la cuenta. */
export const CONFIRMATION_MESSAGE = "Te hemos enviado un enlace si esa dirección tiene cuenta"
const RATE_LIMIT_STATUS = 429
const DEFAULT_RATE_LIMIT_MESSAGE = "Demasiados intentos. Vuelve a probar en unos minutos"

/**
 * Pura, exportada para test: única excepción a "siempre el mismo texto" (criterio 3, S1) es el
 * límite de intentos, que sí se muestra. Cualquier otro resultado (incluida ninguna respuesta de
 * error) confirma el envío sin distinguir si la cuenta existe.
 */
export function resolveForgotPasswordOutcome(
  error: { status: number; message?: string } | null | undefined
): { rateLimited: boolean; message: string } {
  if (error && error.status === RATE_LIMIT_STATUS) {
    return { rateLimited: true, message: error.message || DEFAULT_RATE_LIMIT_MESSAGE }
  }
  return { rateLimited: false, message: CONFIRMATION_MESSAGE }
}

/**
 * E13 · T7 — `/forgot-password`: pide el email y responde siempre lo mismo
 * (docs/design/E13-autenticacion.md §6, §8.1 criterio 8), salvo el límite de intentos.
 */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const errorId = useId()

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)

    const validated = forgotPasswordFormSchema.safeParse({ email })
    if (!validated.success) {
      setError(validated.error.issues[0]?.message ?? "Introduce una dirección de correo válida")
      return
    }

    setIsLoading(true)
    try {
      const result = await authClient.requestPasswordReset({ email: validated.data.email })
      const outcome = resolveForgotPasswordOutcome(result.error)

      if (outcome.rateLimited) {
        setError(outcome.message)
        return
      }

      // S1: se confirma incluso si better-auth devolviera otro error — nunca se distingue.
      setSent(true)
    } catch {
      setSent(true)
    } finally {
      setIsLoading(false)
    }
  }

  if (sent) {
    return <AuthSuccess>{CONFIRMATION_MESSAGE}</AuthSuccess>
  }

  return (
    <form onSubmit={handleSubmit} className="flex w-full flex-col gap-6" noValidate>
      <LineInput
        label="Correo"
        name="email"
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        disabled={isLoading}
        errorId={error ? errorId : undefined}
      />

      {error && <AuthError id={errorId}>{error}</AuthError>}

      <PrimaryButton type="submit" disabled={isLoading} hideArrow={isLoading} className="w-full">
        {isLoading ? "ENVIANDO…" : "ENVIAR ENLACE"}
      </PrimaryButton>
    </form>
  )
}
