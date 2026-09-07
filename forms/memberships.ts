import { Role } from "@/prisma/client"
import { z } from "zod"

export const roleSchema = z.nativeEnum(Role, {
  errorMap: () => ({ message: "El rol debe ser ADMIN, EDITOR o VIEWER" }),
})

export const changeMemberRoleFormSchema = z.object({
  userId: z.string().uuid("Identificador de usuario inválido"),
  role: roleSchema,
})

/** Todo botón destructivo exige motivo (skill ui-erp); queda en AuditLog en E2. */
export const removeMemberFormSchema = z.object({
  userId: z.string().uuid("Identificador de usuario inválido"),
  reason: z
    .string()
    .trim()
    .min(3, "Indica el motivo de la baja (mínimo 3 caracteres)")
    .max(280, "El motivo no puede superar los 280 caracteres"),
})

/** E13 · T10 — enviar enlace de restablecimiento a un miembro (sólo ADMIN). */
export const sendMemberPasswordResetFormSchema = z.object({
  userId: z.string().uuid("Identificador de usuario inválido"),
})

export type ChangeMemberRoleForm = z.infer<typeof changeMemberRoleFormSchema>
export type RemoveMemberForm = z.infer<typeof removeMemberFormSchema>
export type SendMemberPasswordResetForm = z.infer<typeof sendMemberPasswordResetFormSchema>
