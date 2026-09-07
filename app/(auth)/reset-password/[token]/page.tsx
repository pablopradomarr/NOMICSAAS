import { AuthHeadline, AuthShell } from "@/components/auth/brand"
import { ResetPasswordForm } from "@/components/auth/reset-password-form"
import { Metadata } from "next"

export const metadata: Metadata = {
  title: "Nueva contraseña",
}

/**
 * E13 · T7 — `/reset-password/[token]` (docs/design/E13-autenticacion.md §6.1). El token viaja
 * en el path, nunca en query (no debe acabar en `Referer` ni en logs de proxy, mismo criterio
 * que E1); la validación de vigencia/uso único la hace `authClient.resetPassword` en el servidor.
 */
export default async function ResetPasswordPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  return (
    <AuthShell>
      <AuthHeadline accent="contraseña">Elige tu nueva</AuthHeadline>
      <ResetPasswordForm token={token} />
    </AuthShell>
  )
}
