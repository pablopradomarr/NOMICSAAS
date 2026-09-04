"use client"

import { acceptInvitationAction, prepareInvitedAccountAction } from "@/app/(auth)/invite/[token]/actions"
import { FormError } from "@/components/forms/error"
import { FormInput } from "@/components/forms/simple"
import { Button } from "@/components/ui/button"
import { authClient } from "@/lib/auth-client"
import { useState, useTransition } from "react"

/** Con sesión iniciada y el email correcto: un botón. */
export function AcceptInvitationButton({ token }: { token: string }) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="w-full space-y-3">
      <Button
        className="w-full"
        disabled={pending}
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
        {pending ? "Aceptando…" : "Aceptar invitación"}
      </Button>
      {error && <FormError className="w-full">{error}</FormError>}
    </div>
  )
}

/**
 * Sin sesión: código de un solo uso al correo invitado y aceptación automática.
 * El alta de la cuenta la autoriza la propia invitación (D-3), por eso funciona
 * incluso con `DISABLE_SIGNUP=true`.
 */
export function InviteLoginForm({ token, email }: { token: string; email: string }) {
  const [otp, setOtp] = useState("")
  const [isOtpSent, setIsOtpSent] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSendOtp = async (event: React.FormEvent) => {
    event.preventDefault()
    setIsLoading(true)
    setError(null)
    try {
      const prepared = await prepareInvitedAccountAction(token)
      if (!prepared.success) {
        setError(prepared.error ?? "Esta invitación ya no está disponible")
        return
      }
      const result = await authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" })
      if (result.error) {
        setError(result.error.message || "No se ha podido enviar el código")
        return
      }
      setIsOtpSent(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se ha podido enviar el código")
    } finally {
      setIsLoading(false)
    }
  }

  const handleVerifyOtp = async (event: React.FormEvent) => {
    event.preventDefault()
    setIsLoading(true)
    setError(null)
    try {
      const result = await authClient.signIn.emailOtp({ email, otp })
      if (result.error) {
        setError("El código no es válido o ha caducado")
        return
      }
      const accepted = await acceptInvitationAction(token)
      if (accepted && !accepted.success) {
        setError(accepted.error ?? "No se ha podido aceptar la invitación")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se ha podido aceptar la invitación")
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <form onSubmit={isOtpSent ? handleVerifyOtp : handleSendOtp} className="flex w-full flex-col gap-4">
      <FormInput title="Correo" type="email" value={email} readOnly disabled />

      {isOtpSent && (
        <FormInput
          title="Introduce el código que hemos enviado a tu correo"
          type="text"
          value={otp}
          onChange={(event) => setOtp(event.target.value)}
          required
          maxLength={6}
          pattern="[0-9]{6}"
        />
      )}

      <Button type="submit" disabled={isLoading}>
        {isLoading ? "Cargando…" : isOtpSent ? "Entrar y aceptar" : "Recibir código"}
      </Button>

      {error && <FormError className="text-center">{error}</FormError>}
    </form>
  )
}
