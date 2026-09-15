import { requireOrg } from "@/lib/authz"
import { readDocumentBytes } from "@/lib/documents"
import { safeDownloadHeaders } from "@/lib/files"
import { encodeFilename } from "@/lib/utils"
import { getFileById } from "@/models/files"
import { NextResponse } from "next/server"

export async function GET(request: Request, { params }: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await params
  const { db, org } = await requireOrg("VIEWER")

  if (!fileId) {
    return new NextResponse("No fileId provided", { status: 400 })
  }

  try {
    // Find file in database
    const file = await getFileById(db, fileId)

    if (!file) {
      return new NextResponse("File not found or does not belong to the organization", { status: 404 })
    }

    // **E11 · integración** — los bytes salen del ALMACÉN (ADR-0019 D3), con el
    // disco heredado como respaldo mientras la migración de T7 no haya corrido.
    const fileBuffer = await readDocumentBytes(org.id, file)
    if (!fileBuffer) {
      return new NextResponse(`El documento no está en el almacén: ${file.path}`, { status: 404 })
    }

    return new NextResponse(new Uint8Array(fileBuffer), {
      headers: {
        ...safeDownloadHeaders(file.mimetype),
        "Content-Disposition": `attachment; filename*=${encodeFilename(file.filename)}`,
      },
    })
  } catch (error) {
    console.error("Error serving file:", error)
    return new NextResponse("Internal Server Error", { status: 500 })
  }
}
