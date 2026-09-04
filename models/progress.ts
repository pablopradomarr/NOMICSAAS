import { TenantClient } from "@/lib/db"
import { Prisma } from "@/prisma/client"

/**
 * Progress es estado por usuario DENTRO de la organización (el SSE es del usuario
 * que lanzó el proceso): tenantDb inyecta organizationId y el userId va explícito.
 */
export const getOrCreateProgress = async (
  db: TenantClient,
  userId: string,
  id: string,
  type: string | null = null,
  data: Prisma.InputJsonValue | null = null,
  total: number = 0
) => {
  return await db.progress.upsert({
    where: { id },
    create: {
      id,
      userId,
      organizationId: db.$organizationId,
      type: type || "unknown",
      data: data ?? Prisma.JsonNull,
      total,
    },
    update: {
      // Don't update existing progress
    },
  })
}

export const getProgressById = async (db: TenantClient, userId: string, id: string) => {
  return await db.progress.findFirst({
    where: { id, userId },
  })
}

export const updateProgress = async (
  db: TenantClient,
  userId: string,
  id: string,
  fields: { current?: number; total?: number; data?: Prisma.InputJsonValue }
) => {
  return await db.progress.updateMany({
    where: { id, userId },
    data: fields,
  })
}

export const incrementProgress = async (db: TenantClient, userId: string, id: string, amount: number = 1) => {
  return await db.progress.updateMany({
    where: { id, userId },
    data: {
      current: { increment: amount },
    },
  })
}

export const getAllProgress = async (db: TenantClient, userId: string) => {
  return await db.progress.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  })
}

export const deleteProgress = async (db: TenantClient, userId: string, id: string) => {
  return await db.progress.deleteMany({
    where: { id, userId },
  })
}
