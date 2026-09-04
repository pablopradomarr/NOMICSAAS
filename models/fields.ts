import { TenantClient } from "@/lib/db"
import { codeFromName } from "@/lib/utils"
import { Prisma } from "@/prisma/client"
import { cache } from "react"

export type FieldData = {
  [key: string]: unknown
}

export const getFields = cache(async (db: TenantClient) => {
  return await db.field.findMany({
    orderBy: {
      createdAt: "asc",
    },
  })
})

export const createField = async (db: TenantClient, field: FieldData) => {
  if (!field.code) {
    field.code = codeFromName(field.name as string)
  }
  return await db.field.create({
    data: { ...field } as Prisma.FieldUncheckedCreateInput,
  })
}

export const updateField = async (db: TenantClient, code: string, field: FieldData) => {
  return await db.field.update({
    where: { organizationId_code: { organizationId: db.$organizationId, code } },
    data: field as Prisma.FieldUncheckedUpdateInput,
  })
}

export const deleteField = async (db: TenantClient, code: string) => {
  return await db.field.delete({
    where: { organizationId_code: { organizationId: db.$organizationId, code } },
  })
}
