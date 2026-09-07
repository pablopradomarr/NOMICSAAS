import { AuthHeadline, AuthShell } from "@/components/auth/brand"
import { LoginForm } from "@/components/auth/login-form"
import config from "@/lib/config"
import { Metadata } from "next"
import { redirect } from "next/navigation"

export const metadata: Metadata = {
  title: "Entrar",
}

/**
 * E13 · T6 — `/enter` rediseñada con la identidad CFOnomic (docs/design/E13-autenticacion.md
 * §6.1). En self-hosted sigue redirigiendo como hoy: no hay credenciales que pedir (S5).
 */
export default async function LoginPage() {
  if (config.selfHosted.isEnabled) {
    redirect(config.selfHosted.redirectUrl)
  }

  return (
    <AuthShell>
      <AuthHeadline accent="contabilidad">Entra en tu</AuthHeadline>
      <LoginForm />
    </AuthShell>
  )
}
