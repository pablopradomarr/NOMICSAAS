import { requireOrg } from "@/lib/authz"
import { readDocumentBytes } from "@/lib/documents"
import { safeDownloadHeaders } from "@/lib/files"
import { resolvePreviewFormat } from "@/lib/previews/format"
import { generateFilePreviews } from "@/lib/previews/generate"
import { getFileById } from "@/models/files"
import { getSettings } from "@/models/settings"
import fs from "fs/promises"
import { NextResponse } from "next/server"
import path from "path"
import { encodeFilename } from "@/lib/utils"
import {
  DOCUMENT_STATUS_HEADER,
  DOCUMENT_UNAVAILABLE,
  DOCUMENT_UNAVAILABLE_STATUS,
  type PreviewUnavailable,
} from "@/lib/previews/unavailable"

/**
 * **E8 ronda 1 (QA · BUG-E8-2) — «fichero no disponible» es un estado, no un 404.**
 *
 * Antes, un documento cuya fila existe pero cuyos bytes no están en el almacén
 * devolvía un `404` con texto plano. El visor lo trataba como «no hay nada que
 * enseñar» y la pantalla de revisión seguía pintando el asiento propuesto como
 * si el papel estuviera ahí: el drill-down llegaba a un callejón sin explicar.
 * Ahora la respuesta lleva:
 *
 *  · el código **410 Gone** —el recurso existió y ya no está— frente al 404 de
 *    «este documento no es tuyo o no existe», que son dos cosas distintas y hay
 *    que poder distinguirlas desde el cliente;
 *  · la cabecera `X-Document-Status: NO_DISPONIBLE` y un cuerpo JSON con el
 *    motivo y la ruta registrada, para que la UI avise en vez de callar;
 *  · y coherencia con **I-E8-2**, que sobre ese mismo fichero da FAIL: la
 *    pantalla y la Auditoría dicen lo mismo.
 */

function unavailable(fileId: string, filePath: string | null, message: string): NextResponse {
  const body: PreviewUnavailable = { status: DOCUMENT_UNAVAILABLE, fileId, path: filePath, message }
  return NextResponse.json(body, {
    status: DOCUMENT_UNAVAILABLE_STATUS,
    headers: { [DOCUMENT_STATUS_HEADER]: DOCUMENT_UNAVAILABLE, "Cache-Control": "no-store" },
  })
}

export async function GET(request: Request, { params }: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await params
  const { db, org } = await requireOrg("VIEWER")

  if (!fileId) {
    return new NextResponse("No fileId provided", { status: 400 })
  }

  const url = new URL(request.url)
  const page = parseInt(url.searchParams.get("page") || "1", 10)

  try {
    // Find file in database
    const file = await getFileById(db, fileId)

    if (!file) {
      return new NextResponse("File not found or does not belong to the organization", { status: 404 })
    }

    /**
     * **E11 · integración** — los bytes salen del ALMACÉN (ADR-0019 D3). Si no
     * están ni allí ni en el disco heredado, se dice y se dice por qué.
     */
    const bytes = await readDocumentBytes(org.id, file)
    if (!bytes) {
      return unavailable(
        file.id,
        file.path,
        "El documento no está en el almacén: la ficha existe pero sus bytes no. " +
          "Vuelva a subirlo; hasta entonces I-E8-2 marcará el asiento que lo respalda."
      )
    }

    // La miniatura se cachea por el sha256 del original: direccionable por
    // contenido, así que nunca puede servirse la de otro documento.
    const settings = await getSettings(db)
    const format = resolvePreviewFormat(settings.llm_attachment_format)
    const cacheKey = file.sha256 ?? file.id
    const { contentType, previews } = await generateFilePreviews(org, cacheKey, bytes, file.mimetype, format)
    if (previews.length > 0 && page > previews.length) {
      return new NextResponse("Page not found", { status: 404 })
    }
    const previewPath = previews[page - 1] ?? null

    // Sin miniatura (formato sin vista previa, o `sharp` que no pudo) se sirven
    // los bytes originales, que ya están en memoria: nunca un 500.
    const fileBuffer = previewPath ? await fs.readFile(previewPath) : bytes
    const filenameForHeader = previewPath ? path.basename(previewPath) : file.filename

    return new NextResponse(new Uint8Array(fileBuffer), {
      headers: {
        ...safeDownloadHeaders(previewPath ? contentType : file.mimetype),
        "Content-Disposition": `inline; filename*=${encodeFilename(filenameForHeader)}`,
      },
    })
  } catch (error) {
    console.error("Error serving file:", error)
    return new NextResponse("Internal Server Error", { status: 500 })
  }
}
