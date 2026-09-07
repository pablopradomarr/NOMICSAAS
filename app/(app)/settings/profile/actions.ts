"use server"

/**
 * E13 · T12 — Cambiar la propia contraseña desde el perfil (docs/design/E13-autenticacion.md
 * §4.2, §4.3, criterio 12). Cualquier rol puede cambiar SU contraseña; exige la actual y
 * revoca el resto de sesiones vía `revokeOtherSessions` de better-auth (la sesión que hace el
 * cambio sigue viva). No existe en el producto que un tercero fije la contraseña de otra
 * persona a mano (§4.3) — para eso está `sendMemberPasswordResetAction` (T10), que sólo envía
 * un enlace.
 */

import { changePasswordFormSchema, isPasswordTooObvious } from "@/forms/auth"
import { ActionState } from "@/lib/actions"
import { auth, getSession } from "@/lib/auth"
import { withOrg } from "@/lib/authz"
import { recordAuditLog } from "@/models/audit-log"
import { countOtherSessions } from "@/models/users"
import { Role } from "@/prisma/client"
import { headers } from "next/headers"

export async function changeMyPasswordAction(
  _prevState: ActionState<null> | null,
  formData: FormData
): Promise<ActionState<null>> {
  return await withOrg(Role.VIEWER, async ({ org, user }): Promise<ActionState<null>> => {
    // Self-hosted no tiene sesión de better-auth (usuario fijo, sin credencial):
    // no hay contraseña que cambiar.
    const session = await getSession()
    if (!session || !("session" in session) || !session.session) {
      return { success: false, error: "No se puede cambiar la contraseña en modo self-hosted" }
    }

    const validated = changePasswordFormSchema.safeParse(Object.fromEntries(formData))
    if (!validated.success) {
      return { success: false, error: validated.error.issues[0]?.message ?? "Datos inválidos" }
    }

    if (isPasswordTooObvious(validated.data.password, user.email)) {
      return { success: false, error: "Elige una contraseña que no se parezca a tu correo" }
    }

    // Se cuenta ANTES del cambio: es lo que `revokeOtherSessions` va a borrar.
    const otherSessions = await countOtherSessions(user.id, session.session.token)

    try {
      await auth.api.changePassword({
        body: {
          currentPassword: validated.data.currentPassword,
          newPassword: validated.data.password,
          revokeOtherSessions: true,
        },
        headers: await headers(),
      })
    } catch {
      // better-auth no distingue "no tienes contraseña" de "la actual es incorrecta"
      // en el mensaje: mismo criterio de error genérico que el resto de auth (§8.1).
      return { success: false, error: "La contraseña actual no es correcta" }
    }

    await recordAuditLog(org.id, {
      entity: "User",
      entityId: user.id,
      action: "password_changed",
      after: { sessionsRevoked: otherSessions },
      userId: user.id,
    })

    return { success: true }
  })()
}
