import { AuthHeadline, AuthShell } from "@/components/auth/brand"
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form"
import { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = {
  title: "Recuperar contraseña",
}

/**
 * E13 · T7 — `/forgot-password` (docs/design/E13-autenticacion.md §6.1).
 */
export default function ForgotPasswordPage() {
  return (
    <AuthShell>
      <AuthHeadline accent="contraseña">Recupera tu</AuthHeadline>
      <ForgotPasswordForm />
      <Link
        href="/enter"
        className="font-[family-name:var(--font-open-sans)] text-sm text-[var(--nomic-gray)] underline-offset-4 hover:text-[var(--nomic-carbon)] hover:underline"
      >
        Volver a entrar
      </Link>
    </AuthShell>
  )
}
