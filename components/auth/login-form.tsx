"use client"

import { AuthError, LineInput, PrimaryButton } from "@/components/auth/brand"
import { signInFormSchema } from "@/forms/auth"
import { authClient } from "@/lib/auth-client"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useId, useState } from "react"

/** Único mensaje para credenciales incorrectas: nunca revela si el email existe (criterio 2, S1). */
export const GENERIC_LOGIN_ERROR = "Correo o contraseña incorrectos"
const RATE_LIMIT_STATUS = 429

/**
 * Pura, exportada para test: decide qué mensaje mostrar ante un error de `signIn.email`. Sólo el
 * límite de intentos (429) usa el mensaje del servidor; cualquier otra causa (contraseña
 * incorrecta, email inexistente, usuario sin contraseña) cae en el mismo genérico (criterio 2, S1).
 */
export function resolveLoginError(error: { status: number; message?: string } | null | undefined): string {
  if (!error) return GENERIC_LOGIN_ERROR
  return error.status === RATE_LIMIT_STATUS ? error.message || GENERIC_LOGIN_ERROR : GENERIC_LOGIN_ERROR
}

/**
 * E13 · T6 — `/enter` reescrita: email + contraseña sobre `authClient.signIn.email`
 * (docs/design/E13-autenticacion.md §6, §8.1 criterios 1-3).
 */
export function LoginForm({ defaultEmail }: { defaultEmail?: string }) {
  const [email, setEmail] = useState(defaultEmail || "")
  const [password, setPassword] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()
  const errorId = useId()

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)

    const validated = signInFormSchema.safeParse({ email, password })
    if (!validated.success) {
      // Feedback de cliente: la validación real ocurre en el servidor (better-auth).
      setError(validated.error.issues[0]?.message ?? GENERIC_LOGIN_ERROR)
      return
    }

    setIsLoading(true)
    try {
      const result = await authClient.signIn.email({
        email: validated.data.email,
        password: validated.data.password,
      })

      if (result.error) {
        setError(resolveLoginError(result.error))
        return
      }

      router.push("/dashboard")
    } catch {
      setError(GENERIC_LOGIN_ERROR)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex w-full flex-col gap-6" noValidate>
      <div className="flex flex-col gap-5">
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
        <LineInput
          label="Contraseña"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={isLoading}
          errorId={error ? errorId : undefined}
        />
      </div>

      <div className="flex items-center justify-between gap-4">
        <Link
          href="/forgot-password"
          className="font-[family-name:var(--font-open-sans)] text-sm text-[var(--nomic-gray)] underline-offset-4 hover:text-[var(--nomic-carbon)] hover:underline"
        >
          ¿Has olvidado tu contraseña?
        </Link>
      </div>

      {error && <AuthError id={errorId}>{error}</AuthError>}

      <PrimaryButton type="submit" disabled={isLoading} hideArrow={isLoading} className="w-full">
        {isLoading ? "ENTRANDO…" : "ENTRAR"}
      </PrimaryButton>
    </form>
  )
}
