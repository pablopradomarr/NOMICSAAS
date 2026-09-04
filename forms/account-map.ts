/**
 * E2 · T9 — Validación de entrada del mapa de cuentas de sistema (§4.2).
 * Remapear una clave cambia a qué cuenta contabiliza el motor: motivo SIEMPRE.
 */

import { accountCodeSchema, reasonSchema } from "@/forms/accounts"
import { SOFTWARE_ACCOUNTS } from "@/lib/accounts/map"
import { AccountKey } from "@/prisma/client"
import { z } from "zod"

export const accountKeySchema = z.nativeEnum(AccountKey, {
  errorMap: () => ({ message: "Clave de cuenta de sistema desconocida" }),
})

export const setAccountMapEntryFormSchema = z.object({
  key: accountKeySchema,
  accountCode: accountCodeSchema,
  reason: reasonSchema,
})

const softwareCodes = SOFTWARE_ACCOUNTS.map((account) => account.code) as [string, ...string[]]

/** §2.5 — 4720/4730/4760/4770 bajo demanda explícita del ADMIN. */
export const createSoftwareAccountsFormSchema = z.object({
  codes: z
    .array(z.enum(softwareCodes))
    .min(1, "Selecciona al menos una cuenta de desglose")
    .max(softwareCodes.length),
  reason: reasonSchema,
})

export type SetAccountMapEntryForm = z.infer<typeof setAccountMapEntryFormSchema>
