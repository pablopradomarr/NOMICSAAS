import { TenantClient } from "@/lib/db"
import { defaultBusinessLineId } from "@/models/analytics"
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
  // E4 (D-E4-1): `businessLineId` es NOT NULL. Quien no la indique cae en la
  // línea de negocio de sistema `GENERAL`, que es la que sembró la migración.
  const businessLineId = (project.businessLineId as string | undefined) ?? (await defaultBusinessLineId(db))
  return await db.project.create({
    data: { ...project, businessLineId } as Prisma.ProjectUncheckedCreateInput,
  })
}

export const updateProject = async (db: TenantClient, code: string, project: ProjectData) => {
  return await db.project.update({
    where: { organizationId_code: { organizationId: db.$organizationId, code } },
    data: project as Prisma.ProjectUncheckedUpdateInput,
  })
}

/**
 * E4 (§4): un proyecto con líneas de diario **no se borra** — es una dimensión
 * analítica viva y borrarlo dejaría la matriz sin columna y las líneas sin
 * destino. Se archiva (`archiveDimensionAction`). Con sólo `transactions`, el
 * comportamiento heredado se conserva.
 */
export class DimensionInUseError extends Error {
  readonly code = "DIMENSION_IN_USE"
  constructor(message: string) {
    super(message)
    this.name = "DimensionInUseError"
  }
}

export const deleteProject = async (db: TenantClient, code: string) => {
  const project = await db.project.findUnique({
    where: { organizationId_code: { organizationId: db.$organizationId, code } },
    include: { _count: { select: { lines: true } } },
  })
  if (project && project._count.lines > 0) {
    throw new DimensionInUseError(
      `El proyecto ${code} tiene ${project._count.lines} línea(s) de diario: archívalo en /analytics/projects en vez de borrarlo`
    )
  }

  await db.transaction.updateMany({
    where: { projectCode: code },
    data: { projectCode: null },
  })

  return await db.project.delete({
    where: { organizationId_code: { organizationId: db.$organizationId, code } },
  })
}
