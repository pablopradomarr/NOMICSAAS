import React from "react"
import { EmailLayout } from "./email-layout"

interface OrganizationInviteEmailProps {
  organizationName: string
  inviterName: string
  roleLabel: string
  inviteUrl: string
  expiresInDays: number
}

export const OrganizationInviteEmail: React.FC<OrganizationInviteEmailProps> = ({
  organizationName,
  inviterName,
  roleLabel,
  inviteUrl,
  expiresInDays,
}) => (
  <EmailLayout preview={`${inviterName} te invita a ${organizationName}`}>
    <h2 style={{ color: "#1A202C", fontSize: "20px" }}>Te han invitado a {organizationName}</h2>
    <p style={{ fontSize: "15px", color: "#1A202C" }}>
      {inviterName} te invita a unirte a <strong>{organizationName}</strong> con el perfil de{" "}
      <strong>{roleLabel}</strong>.
    </p>
    <div style={{ margin: "28px 0", textAlign: "center" }}>
      <a
        href={inviteUrl}
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
        Aceptar invitación
      </a>
    </div>
    <p style={{ fontSize: "13px", color: "#737373" }}>
      Si el botón no funciona, copia este enlace en tu navegador:
      <br />
      <span style={{ wordBreak: "break-all" }}>{inviteUrl}</span>
    </p>
    <p style={{ fontSize: "13px", color: "#737373" }}>
      La invitación caduca en {expiresInDays} días. Si no esperabas este mensaje, puedes ignorarlo.
    </p>
  </EmailLayout>
)
