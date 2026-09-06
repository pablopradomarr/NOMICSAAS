"use server"

/**
 * E8 · T17 — Prompts de extracción por organización (§6, G-10).
 *
 * Dos actos, los dos de **ADMIN** y los dos auditados:
 *
 *  · **Crear una versión** — `prompt_versions` es append-only en la base
 *    (RESTRICTIVE en UPDATE/DELETE: `app_runtime` recibe 42501). «Editar» un
 *    prompt es insertar la versión siguiente, y por eso la pantalla no tiene
 *    botón de guardar sobre una versión existente.
 *  · **Fijar la vigente** — vive en `Setting("prompt_active_version.<code>")`,
 *    que sí es mutable, con su `AuditLog`. Volver a git es fijar `null`: el
 *    prompt del repositorio es el único que el equipo revisa en un diff.
 *
 * Cambiar el prompt cambia lo que el modelo lee y, con ello, las propuestas
 * futuras; no toca ni una extracción pasada, porque cada `ExtractionRun` sella
 * el `promptSha` efectivo que vio (I-E8-11).
 */

import type { ActionState } from "@/lib/actions"
import { withOrg } from "@/lib/authz"
import { writeAuditLog } from "@/models/audit-log"
import { createPromptVersion, getActivePromptVersion, setActivePromptVersion } from "@/models/prompts"
import { Role } from "@/prisma/client"
import { revalidatePath } from "next/cache"
import { z } from "zod"

const PATH = "/settings/prompts"

const createSchema = z
  .object({
    code: z.string().min(1).max(64),
    content: z.string().trim().min(40, "Un prompt de extracción no cabe en 40 caracteres"),
    notes: z.string().max(512).optional(),
  })
  .strict()

const activateSchema = z
  .object({
    code: z.string().min(1).max(64),
    /** Cadena vacía = volver al prompt de git. */
    versionId: z.string().max(64),
  })
  .strict()

export async function createPromptVersionAction(input: unknown): Promise<ActionState<{ id: string; version: number }>> {
  return await withOrg(Role.ADMIN, async ({ db, user }): Promise<ActionState<{ id: string; version: number }>> => {
    const parsed = createSchema.safeParse(input)
    if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? "Datos inválidos" }

    const created = await createPromptVersion(db, {
      code: parsed.data.code,
      content: parsed.data.content,
      notes: parsed.data.notes ?? null,
      createdById: user.id,
    })

    await writeAuditLog(db, {
      entity: "PromptVersion",
      entityId: created.id,
      action: "SET_PROMPT_VERSION",
      after: { code: created.code, version: created.version, sha256: created.sha256 },
      userId: user.id,
      reason: parsed.data.notes ?? null,
    })

    revalidatePath(PATH)
    return { success: true, data: { id: created.id, version: created.version } }
  })()
}

export async function setActivePromptAction(input: unknown): Promise<ActionState<{ versionId: string | null }>> {
  return await withOrg(Role.ADMIN, async ({ db, user }): Promise<ActionState<{ versionId: string | null }>> => {
    const parsed = activateSchema.safeParse(input)
    if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? "Datos inválidos" }

    const versionId = parsed.data.versionId.trim() === "" ? null : parsed.data.versionId.trim()
    const before = await getActivePromptVersion(db, parsed.data.code)

    try {
      await setActivePromptVersion(db, parsed.data.code, versionId)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "No se ha podido fijar la versión" }
    }

    await writeAuditLog(db, {
      entity: "PromptVersion",
      entityId: versionId ?? parsed.data.code,
      action: "SET_PROMPT_VERSION",
      before: { versionId: before?.id ?? null, version: before?.version ?? null },
      after: { versionId, code: parsed.data.code },
      userId: user.id,
    })

    revalidatePath(PATH)
    return { success: true, data: { versionId } }
  })()
}
