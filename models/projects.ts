import { TenantClient } from "@/lib/db"
import { codeFromName } from "@/lib/utils"
import { Prisma } from "@/prisma/client"
import { cache } from "react"

export type ProjectData = {
  [key: string]: unknown
}

export const getProjects = cache(async (db: TenantClient) => {
  return await db.project.findMany({
    orderBy: {
      name: "asc",
    },
  })
})

export const getProjectByCode = cache(async (db: TenantClient, code: string) => {
  return await db.project.findUnique({
    where: { organizationId_code: { organizationId: db.$organizationId, code } },
  })
})

export const createProject = async (db: TenantClient, project: ProjectData) => {
  if (!project.code) {
    project.code = codeFromName(project.name as string)
  }
  return await db.project.create({
    data: { ...project } as Prisma.ProjectUncheckedCreateInput,
  })
}

export const updateProject = async (db: TenantClient, code: string, project: ProjectData) => {
  return await db.project.update({
    where: { organizationId_code: { organizationId: db.$organizationId, code } },
    data: project as Prisma.ProjectUncheckedUpdateInput,
  })
}

export const deleteProject = async (db: TenantClient, code: string) => {
  await db.transaction.updateMany({
    where: { projectCode: code },
    data: { projectCode: null },
  })

  return await db.project.delete({
    where: { organizationId_code: { organizationId: db.$organizationId, code } },
  })
}
