import { TenantClient } from "@/lib/db"
import { Prisma } from "@/prisma/client"
import { cache } from "react"

/**
 * Currency es el único modelo con lectura híbrida: `tenantDb` devuelve las
 * monedas de la organización MÁS el catálogo global (organizationId = NULL).
 * Las escrituras siempre quedan acotadas a la organización activa.
 */
export const getCurrencies = cache(async (db: TenantClient) => {
  return await db.currency.findMany({
    orderBy: {
      code: "asc",
    },
  })
})

export const createCurrency = async (db: TenantClient, currency: Prisma.CurrencyUncheckedCreateInput) => {
  return await db.currency.create({ data: currency })
}

export const updateCurrency = async (db: TenantClient, code: string, currency: Prisma.CurrencyUpdateInput) => {
  return await db.currency.update({
    where: { organizationId_code: { organizationId: db.$organizationId, code } },
    data: currency,
  })
}

export const deleteCurrency = async (db: TenantClient, code: string) => {
  return await db.currency.delete({
    where: { organizationId_code: { organizationId: db.$organizationId, code } },
  })
}
