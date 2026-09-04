import { TenantClient } from "@/lib/db"
import { Prisma } from "@/prisma/client"

/**
 * AppData es estado por usuario DENTRO de la organización: se filtra por las dos
 * columnas (organizationId inyectado por tenantDb + userId explícito).
 */
export const getAppData = async (db: TenantClient, userId: string, app: string) => {
  const appData = await db.appData.findUnique({
    where: { organizationId_userId_app: { organizationId: db.$organizationId, userId, app } },
  })

  return appData?.data
}

export const setAppData = async (db: TenantClient, userId: string, app: string, data: Prisma.InputJsonValue) => {
  await db.appData.upsert({
    where: { organizationId_userId_app: { organizationId: db.$organizationId, userId, app } },
    update: { data },
    create: { organizationId: db.$organizationId, userId, app, data },
  })
}
