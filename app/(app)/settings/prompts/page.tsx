import { PromptVersionsPanel, type PromptVersionView } from "@/components/settings/prompt-versions-panel"
import { SettingsPageHeader } from "@/components/settings/page-header"
import { latestPromptEntry, readPromptFile } from "@/ai/prompts"
import { tenantPage } from "@/lib/page-tenant"
import { getActivePromptVersion, listPromptVersions } from "@/models/prompts"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"

export const metadata: Metadata = { title: "Prompts de extracción" }

/** El único código de prompt del producto hoy (`ai/prompts/index.ts`). */
const CODE = "extraction"

/**
 * E8 · T17 — `/settings/prompts` (§6).
 *
 * Enseña las dos fuentes posibles del prompt efectivo y deja claro cuál manda:
 * el **de git**, versionado y sellado en el repositorio, y las **versiones de la
 * organización**, append-only. La vigente vive en un `Setting` y se cambia con
 * un acto auditado.
 *
 * Lo que esta pantalla no hace, a propósito: editar una versión. `PromptVersion`
 * es append-only en la base, y una pantalla que ofreciera «guardar» sobre una
 * versión ya usada estaría prometiendo algo que la base rechaza con 42501 —y
 * borrando la evidencia de con qué instrucciones se extrajo una factura.
 */
export default tenantPage(
  async ({ db, role }) => {
    const isAdmin = role === Role.ADMIN
    const gitEntry = latestPromptEntry(CODE)
    const gitContent = readPromptFile(gitEntry)

    const versions = await listPromptVersions(db, CODE)
    const active = await getActivePromptVersion(db, CODE)

    const rows: PromptVersionView[] = versions.map((version) => ({
      id: version.id,
      code: version.code,
      version: version.version,
      content: version.content,
      sha256: version.sha256,
      notes: version.notes,
      createdAt: version.createdAt.toISOString(),
      isActive: active?.id === version.id,
    }))

    return (
      <div className="space-y-8">
        <SettingsPageHeader
          title="Prompts de extracción"
          description="Con qué instrucciones lee el modelo los documentos. El prompt de git es el que el equipo revisa en un diff; una organización puede fijar el suyo, y cada extracción sella el sha del texto efectivo que vio el modelo."
        />
        <PromptVersionsPanel
          code={CODE}
          gitVersion={gitEntry.version}
          gitSha={gitEntry.sha256}
          gitContent={gitContent}
          versions={rows}
          activeVersionId={active?.id ?? null}
          isAdmin={isAdmin}
        />
      </div>
    )
  },
  { readOnly: false }
)
