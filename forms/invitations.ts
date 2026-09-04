import { roleSchema } from "@/forms/memberships"
import { z } from "zod"

export const invitationEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Introduce una dirección de correo válida")
  .max(254, "La dirección de correo es demasiado larga")

export const inviteMemberFormSchema = z.object({
  email: invitationEmailSchema,
  role: roleSchema,
})

export const invitationIdSchema = z.object({
  invitationId: z.string().uuid("Identificador de invitación inválido"),
})

/** `base64url(randomBytes(32))` → 43 caracteres del alfabeto base64url. */
export const invitationTokenSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{43}$/, "El enlace de invitación no es válido")

export type InviteMemberForm = z.infer<typeof inviteMemberFormSchema>
