"use server"

import { fileExists, getOrganizationPreviewsDirectory, OrganizationRef, safePathJoin } from "@/lib/files"
import fs from "fs/promises"
import { fromBuffer } from "pdf2pic"
import config from "../config"
import { DEFAULT_PREVIEW_FORMAT, PreviewFormat, previewContentType, previewExtension } from "./format"

/**
 * E11 · integración — convierte el PDF **desde los bytes** (`fromBuffer`), no
 * desde una ruta del volumen local.
 *
 * La caché sigue en `uploads/<org>/previews/`, nombrada por el **sha256 del
 * original** (`cacheKey`): direccionable por contenido, de modo que dos
 * documentos distintos no pueden compartir miniatura y un documento modificado
 * no puede servir la vieja.
 */
export async function pdfToImages(
  organization: OrganizationRef,
  cacheKey: string,
  bytes: Buffer,
  format: PreviewFormat = DEFAULT_PREVIEW_FORMAT
): Promise<{ contentType: string; pages: string[] }> {
  const previewsDirectory = getOrganizationPreviewsDirectory(organization)
  await fs.mkdir(previewsDirectory, { recursive: true })

  const extension = previewExtension(format)
  const contentType = previewContentType(format)

  // ¿Ya están convertidas? La caché se recorre hasta el primer hueco.
  const existingPages: string[] = []
  for (let i = 1; i <= config.upload.pdfs.maxPages; i++) {
    const convertedFilePath = safePathJoin(previewsDirectory, `${cacheKey}.${i}.${extension}`)
    if (await fileExists(convertedFilePath)) {
      existingPages.push(convertedFilePath)
    } else {
      break
    }
  }

  if (existingPages.length > 0) {
    return { contentType, pages: existingPages }
  }

  const pdf2picOptions = {
    density: config.upload.pdfs.dpi,
    saveFilename: cacheKey,
    savePath: previewsDirectory,
    format: extension,
    quality: config.upload.pdfs.quality,
    width: config.upload.pdfs.maxWidth,
    height: config.upload.pdfs.maxHeight,
    preserveAspectRatio: true,
  }

  try {
    const convert = fromBuffer(bytes, pdf2picOptions)
    const results = await convert.bulk(-1, { responseType: "image" })
    const paths = results.filter((result) => result && result.path).map((result) => result.path) as string[]
    return { contentType, pages: paths.slice(0, config.upload.pdfs.maxPages) }
  } catch (error) {
    console.error("Error converting PDF to image:", error)
    throw error
  }
}
