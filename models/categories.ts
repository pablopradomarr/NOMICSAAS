import { TenantClient } from "@/lib/db"
import { codeFromName } from "@/lib/utils"
import { Prisma } from "@/prisma/client"
import { cache } from "react"

export type CategoryData = {
  [key: string]: unknown
}

export const getCategories = cache(async (db: TenantClient) => {
  return await db.category.findMany({
    orderBy: {
      name: "asc",
    },
  })
})

export const getCategoryByCode = cache(async (db: TenantClient, code: string) => {
  return await db.category.findUnique({
    where: { organizationId_code: { organizationId: db.$organizationId, code } },
  })
})

export const createCategory = async (db: TenantClient, category: CategoryData) => {
  if (!category.code) {
    category.code = codeFromName(category.name as string)
  }
  return await db.category.create({
    data: { ...category } as Prisma.CategoryUncheckedCreateInput,
  })
}

export const updateCategory = async (db: TenantClient, code: string, category: CategoryData) => {
  return await db.category.update({
    where: { organizationId_code: { organizationId: db.$organizationId, code } },
    data: category as Prisma.CategoryUncheckedUpdateInput,
  })
}

export const deleteCategory = async (db: TenantClient, code: string) => {
  await db.transaction.updateMany({
    where: { categoryCode: code },
    data: { categoryCode: null },
  })

  return await db.category.delete({
    where: { organizationId_code: { organizationId: db.$organizationId, code } },
  })
}
