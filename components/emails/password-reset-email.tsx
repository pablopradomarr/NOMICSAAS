/**
 * E13 · T4 — Correo de restablecimiento de contraseña (docs/design/E13-autenticacion.md §4.1,
 * §6.2). Marca NOMIC/CFOnomic: mismos tokens que `organization-invite-email.tsx`. El enlace
 * lleva el token en el PATH, nunca en query (mismo criterio que la invitación de E1).
 */

import React from "react"
import { EmailLayout } from "./email-layout"

interface PasswordResetEmailProps {
  resetUrl: string
}

export const PasswordResetEmail: React.FC<PasswordResetEmailProps> = ({ resetUrl }) => (
  <EmailLayout preview="Restablece tu contraseña de NOMIC">
    <h2 style={{ color: "#1A202C", fontSize: "20px" }}>Restablece tu contraseña</h2>
    <p style={{ fontSize: "15px", color: "#1A202C" }}>
      Hemos recibido una solicitud para restablecer la contraseña de tu cuenta de <strong>NOMIC</strong>, de
      CFOnomic. Si no has sido tú, puedes ignorar este mensaje: tu contraseña actual sigue siendo válida.
    </p>
    <div style={{ margin: "28px 0", textAlign: "center" }}>
      <a
        href={resetUrl}
        style={{
          display: "inline-block",
          padding: "12px 24px",
          backgroundColor: "#0A0A0A",
          color: "#FFFFFF",
          borderRadius: "6px",
          textDecoration: "none",
          fontWeight: 600,
          fontSize: "15px",
        }}
      >
        Elegir nueva contraseña
      </a>
    </div>
    <p style={{ fontSize: "13px", color: "#737373" }}>
      Si el botón no funciona, copia este enlace en tu navegador:
      <br />
      <span style={{ wordBreak: "break-all" }}>{resetUrl}</span>
    </p>
    <p style={{ fontSize: "13px", color: "#737373" }}>
      Este enlace caduca en 1 hora y sólo se puede usar una vez.
    </p>
  </EmailLayout>
)
