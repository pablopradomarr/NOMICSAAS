/**
 * E8 · T11 — Adjuntos que ve el modelo, **y los que no** (G-02).
 *
 * El límite de páginas existía ya en TaxHacker, pero era una constante muda: se
 * mandaban las cuatro primeras páginas y nadie registraba que había una quinta.
 * Una extracción sobre 4 de 9 páginas no es incompleta, es **potencialmente
 * falsa** —el total puede estar en la página 9—, y por eso `pagesSent` y
 * `pagesTotal` viajan al `ExtractionRun`, un trigger marca `partial` y ningún
 * asiento puede referenciar un run parcial de `kind = LLM` (ADR-0014 D5).
 *
 * El límite es configurable por organización (`Setting("llm_max_pages")`,
 * default 4) y queda **registrado en el run**: subirlo cambia el coste y la
 * calidad, y eso tiene que ser visible en la evidencia, no sólo en un ajuste.
 */

import { readDocumentBytes } from "@/lib/documents"
import { resolvePreviewFormat } from "@/lib/previews/format"
import { generateFilePreviews } from "@/lib/previews/generate"
import { TenantClient } from "@/lib/db"
import { getSettings } from "@/models/settings"
import { File, Organization } from "@/prisma/client"
import fs from "fs/promises"

export const DEFAULT_MAX_PAGES_TO_ANALYZE = 4
export const MAX_PAGES_SETTING = "llm_max_pages"

export type AnalyzeAttachment = {
  filename: string
  contentType: string
  base64: string
}

export type LoadedAttachments = {
  attachments: AnalyzeAttachment[]
  /** Páginas realmente enviadas al modelo. */
  pagesSent: number
  /** Páginas que TIENE el documento. `pagesSent < pagesTotal` ⇒ `partial`. */
  pagesTotal: number
  /** Límite vigente, tal y como se aplicó. Va al run para poder explicarlo. */
  maxPages: number
}

export function resolveMaxPages(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10)
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : DEFAULT_MAX_PAGES_TO_ANALYZE
}

export const loadAttachmentsForAI = async (
  db: TenantClient,
  organization: Organization,
  file: File
): Promise<LoadedAttachments> => {
  // **E11 · integración** — los bytes salen del ALMACÉN (ADR-0019 D3).
  const bytes = await readDocumentBytes(organization.id, file)
  if (!bytes) {
    throw new Error("El documento no está en el almacén: no se puede extraer de un documento que no existe")
  }

  const settings = await getSettings(db)
  const format = resolvePreviewFormat(settings.llm_attachment_format)
  const maxPages = resolveMaxPages(settings[MAX_PAGES_SETTING])
  const cacheKey = file.sha256 ?? file.id
  const { contentType, previews } = await generateFilePreviews(organization, cacheKey, bytes, file.mimetype, format)

  // Sin miniaturas (un formato que no las tiene) se manda el original: lo que
  // no puede pasar es mandar CERO adjuntos y pedirle al modelo que extraiga.
  if (previews.length === 0) {
    return {
      attachments: [{ filename: file.filename, contentType: file.mimetype, base64: bytes.toString("base64") }],
      pagesSent: 1,
      pagesTotal: 1,
      maxPages,
    }
  }

  const selected = previews.slice(0, maxPages)
  const attachments = await Promise.all(
    selected.map(async (preview) => ({
      filename: file.filename,
      contentType,
      base64: await loadFileAsBase64(preview),
    }))
  )

  return { attachments, pagesSent: selected.length, pagesTotal: previews.length, maxPages }
}

export const loadFileAsBase64 = async (filePath: string): Promise<string> => {
  const buffer = await fs.readFile(filePath)
  return Buffer.from(buffer).toString("base64")
}
