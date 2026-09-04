import { z } from "zod"

/** Perfil personal del usuario (auth): nombre y avatar. */
export const userFormSchema = z.object({
  name: z.string().max(128).optional(),
  avatar: z.instanceof(File).optional(),
})

/** Datos de emisor de facturas: viven en Organization desde E1 (T11). */
export const organizationBusinessFormSchema = z.object({
  businessName: z.string().max(128).optional(),
  businessAddress: z.string().max(1024).optional(),
  businessBankDetails: z.string().max(1024).optional(),
  businessLogo: z.instanceof(File).optional(),
})
