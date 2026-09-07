/**
 * E13 · T3 — Política de contraseña y formularios de auth (docs/design/E13-autenticacion.md §3).
 *
 * Puro: sin efectos, sin reloj, sin IO. Un solo schema por formulario, criterio 4 del diseño
 * (§8.1): cliente y servidor comparten exactamente esta validación, así que nunca pueden
 * discrepar en el mensaje de "mínimo 12 caracteres".
 */

import { z } from "zod"

export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_LENGTH = 128

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`)
  .max(PASSWORD_MAX_LENGTH, `La contraseña no puede tener más de ${PASSWORD_MAX_LENGTH} caracteres`)

export const authEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Introduce una dirección de correo válida")
  .max(254, "La dirección de correo es demasiado larga")

export const newPasswordFormSchema = z
  .object({
    password: passwordSchema,
    confirm: z.string(),
  })
  .refine((data) => data.password === data.confirm, {
    message: "Las contraseñas no coinciden",
    path: ["confirm"],
  })

export const signInFormSchema = z.object({
  email: authEmailSchema,
  password: z.string().min(1, "Introduce tu contraseña"),
})

export const forgotPasswordFormSchema = z.object({
  email: authEmailSchema,
})

export const setInvitedPasswordFormSchema = z
  .object({
    name: z.string().trim().min(1, "Introduce tu nombre").max(120, "El nombre es demasiado largo"),
    password: passwordSchema,
    confirm: z.string(),
  })
  .refine((data) => data.password === data.confirm, {
    message: "Las contraseñas no coinciden",
    path: ["confirm"],
  })

export type NewPasswordForm = z.infer<typeof newPasswordFormSchema>
export type SignInForm = z.infer<typeof signInFormSchema>
export type ForgotPasswordForm = z.infer<typeof forgotPasswordFormSchema>
export type SetInvitedPasswordForm = z.infer<typeof setInvitedPasswordFormSchema>

/**
 * Rechaza como contraseña la parte local del correo (antes de la `@`), en minúsculas y sin
 * espacios, y sus variantes triviales (con dígitos/símbolos de relleno alrededor). Pura: no
 * sustituye a `minPasswordLength`, es una comprobación adicional de obviedad.
 */
export function isPasswordTooObvious(password: string, email: string): boolean {
  const localPart = email.trim().toLowerCase().split("@")[0]
  if (!localPart) return false

  const normalize = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]/g, "")
  const normalizedPassword = normalize(password)
  const normalizedLocalPart = normalize(localPart)

  if (!normalizedLocalPart) return false

  if (normalizedPassword === normalizedLocalPart) return true

  // Sólo se compara "contiene" cuando la parte local es suficientemente larga para no dar
  // falsos positivos con nombres de una o dos letras.
  return normalizedLocalPart.length >= 4 && normalizedPassword.includes(normalizedLocalPart)
}
