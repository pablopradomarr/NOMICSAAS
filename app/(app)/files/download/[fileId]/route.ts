import { requireOrg } from "@/lib/authz"
import { fileExists, fullPathForFile } from "@/lib/files"
import { encodeFilename } from "@/lib/utils"
import { getFileById } from "@/models/files"
import fs from "fs/promises"
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

    // Check if file exists
    const fullFilePath = fullPathForFile(org, file)
    const isFileExists = await fileExists(fullFilePath)
    if (!isFileExists) {
      return new NextResponse(`File not found on disk: ${file.path}`, { status: 404 })
    }

    // Read file
    const fileBuffer = await fs.readFile(fullFilePath)

    // Return file with proper content type and encoded filename
    return new NextResponse(fileBuffer, {
      headers: {
        "Content-Type": file.mimetype,
          "Content-Disposition": `attachment; filename*=${encodeFilename(file.filename)}`,
        },
    })
  } catch (error) {
    console.error("Error serving file:", error)
    return new NextResponse("Internal Server Error", { status: 500 })
  }
}
