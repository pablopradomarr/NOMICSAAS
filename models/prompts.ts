/**
 * E8 · T6 — `PromptVersion`: overrides de prompt por organización.
 *
 * **Append-only** (G-10, I-E8-3): «editar un prompt» es insertar `version + 1`.
 * La tabla no admite `UPDATE` ni `DELETE` —política RESTRICTIVE y falta de
 * privilegio para `app_runtime`, comprobado en `tests/integration-rls`—, así que
 * este módulo no expone ninguna función que lo intente: si un `ExtractionRun`
 * apunta a una versión de prompt, ese texto tiene que seguir siendo legible
 * palabra por palabra dentro de cinco años.
 *
 * La **versión vigente** no es un flag en la fila (que sería mutable): es un
 * `Setting` por código, `prompt_active_version.<code>`, con el id de la
 * `PromptVersion`. Cambiarlo es un acto de ADMIN y lo audita la server action
 * de T13 (`setActivePromptAction`); aquí sólo está el IO.
 *
 * Este módulo **no calcula nada**: el sello lo produce `promptContentHash`
 * (`lib/extraction/hash.ts`, puro) y se persiste junto al contenido para que
 * verificarlo sea comparar, no recalcular.
 */

import type { TenantClient } from "@/lib/db"
import { promptContentHash } from "@/lib/extraction/hash"
import type { PromptVersion } from "@/prisma/client"

/** Código de `Setting` que guarda la versión vigente de un prompt. */
export const activePromptSettingCode = (code: string): string => `prompt_active_version.${code}`

export async function listPromptVersions(db: TenantClient, code?: string): Promise<PromptVersion[]> {
  return await db.promptVersion.findMany({
    where: code ? { code } : undefined,
    orderBy: [{ code: "asc" }, { version: "desc" }],
  })
}

export async function getPromptVersionById(db: TenantClient, id: string): Promise<PromptVersion | null> {
  return await db.promptVersion.findFirst({ where: { id } })
}

/**
 * Última versión insertada para `code`, con independencia de cuál esté vigente.
 * Sirve para calcular el siguiente número, no para resolver el prompt.
 */
export async function getLatestPromptVersion(db: TenantClient, code: string): Promise<PromptVersion | null> {
  return await db.promptVersion.findFirst({ where: { code }, orderBy: { version: "desc" } })
}

export type CreatePromptVersionInput = {
  code: string
  content: string
  notes?: string | null
  createdById?: string | null
}

/**
 * Inserta la siguiente versión. **Nunca actualiza**: si el contenido coincide
 * con la última versión devuelve esa misma fila en lugar de duplicarla, porque
 * un historial con dos versiones idénticas no informa de nada y ensucia la
 * trazabilidad de `ExtractionRun.promptVersionId`.
 *
 * No fija la versión vigente: eso es `setActivePromptVersion`, que es otra
 * decisión y otro registro de auditoría.
 */
export async function createPromptVersion(
  db: TenantClient,
  input: CreatePromptVersionInput
): Promise<PromptVersion> {
  const sha256 = promptContentHash(input.content)
  const latest = await getLatestPromptVersion(db, input.code)
  if (latest && latest.sha256 === sha256) return latest

  return await db.promptVersion.create({
    data: {
      organizationId: db.$organizationId,
      code: input.code,
      version: (latest?.version ?? 0) + 1,
      content: input.content,
      sha256,
      notes: input.notes ?? null,
      createdById: input.createdById ?? null,
    },
  })
}

/**
 * Fija qué versión usa la organización. `null` **vuelve al prompt de git**, que
 * es el estado por defecto y el único que el equipo revisa en un diff.
 */
export async function setActivePromptVersion(
  db: TenantClient,
  code: string,
  versionId: string | null
): Promise<void> {
  if (versionId !== null) {
    const version = await getPromptVersionById(db, versionId)
    if (!version || version.code !== code) {
      throw new Error(`La versión de prompt ${versionId} no existe o no es del código "${code}"`)
    }
  }

  const settingCode = activePromptSettingCode(code)
  await db.setting.upsert({
    where: { organizationId_code: { organizationId: db.$organizationId, code: settingCode } },
    update: { value: versionId ?? "" },
    create: {
      organizationId: db.$organizationId,
      code: settingCode,
      name: `Versión vigente del prompt "${code}"`,
      value: versionId ?? "",
    },
  })
}

/**
 * Versión vigente, o `null` si la organización usa la de git.
 *
 * Si el `Setting` apunta a una versión que ya no existe, devuelve `null` en
 * lugar de lanzar: es preferible extraer con el prompt de git —conocido,
 * sellado y en el repositorio— que dejar la bandeja inservible.
 */
export async function getActivePromptVersion(db: TenantClient, code: string): Promise<PromptVersion | null> {
  const setting = await db.setting.findFirst({ where: { code: activePromptSettingCode(code) } })
  const versionId = setting?.value?.trim()
  if (!versionId) return null
  const version = await getPromptVersionById(db, versionId)
  return version && version.code === code ? version : null
}
