import { requireOrg } from "@/lib/authz"
import { fileExists, fullPathForFile, safeDownloadHeaders } from "@/lib/files"
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

    // Los bytes del documento: si no están, se dice y se dice por qué.
    const fullFilePath = fullPathForFile(org, file)
    const isFileExists = await fileExists(fullFilePath)
    if (!isFileExists) {
      return unavailable(
        file.id,
        file.path,
        "El documento no está en el almacén: la ficha existe pero sus bytes no. " +
          "Vuelva a subirlo; hasta entonces I-E8-2 marcará el asiento que lo respalda."
      )
    }

    // Generate previews
    const settings = await getSettings(db)
    const format = resolvePreviewFormat(settings.llm_attachment_format)
    const { contentType, previews } = await generateFilePreviews(org, fullFilePath, file.mimetype, format)
    if (page > previews.length) {
      return new NextResponse("Page not found", { status: 404 })
    }
    const previewPath = previews[page - 1] || fullFilePath

    // Read file
    const fileBuffer = await fs.readFile(previewPath)

    // Return file with proper content type
    return new NextResponse(fileBuffer, {
      headers: {
        ...safeDownloadHeaders(contentType),
        "Content-Disposition": `inline; filename*=${encodeFilename(path.basename(previewPath))}`,
      },
    })
  } catch (error) {
    console.error("Error serving file:", error)
    return new NextResponse("Internal Server Error", { status: 500 })
  }
}
