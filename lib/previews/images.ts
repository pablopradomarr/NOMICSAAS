"use server"

import { fileExists, getOrganizationPreviewsDirectory, OrganizationRef, safePathJoin } from "@/lib/files"
import fs from "fs/promises"
import config from "../config"
import { DEFAULT_PREVIEW_FORMAT, PreviewFormat, previewContentType, previewExtension } from "./format"

/**
 * E11 · integración — redimensiona **desde los bytes**, no desde una ruta.
 *
 * `sharp` acepta un `Buffer` igual que acepta un path, así que el cambio no
 * cuesta nada y corta la última dependencia de la vista previa con el volumen
 * local. La salida sigue yendo a `uploads/<org>/previews/` porque es una CACHÉ
 * de un derivado reproducible (ver `generate.ts`), no evidencia.
 */
export async function resizeImage(
  organization: OrganizationRef,
  cacheKey: string,
  bytes: Buffer,
  maxWidth: number = config.upload.images.maxWidth,
  maxHeight: number = config.upload.images.maxHeight,
  quality: number = config.upload.images.quality,
  format: PreviewFormat = DEFAULT_PREVIEW_FORMAT
): Promise<{ contentType: string; resizedPath: string | null }> {
  // Ronda 1 de E8, revisor #5: `sharp` es un binario nativo de ~2,3 s de carga.
  // Perezoso, para que no entre en el grafo de quien sólo importa esta función.
  const { default: sharp } = await import("sharp")
  try {
    const previewsDirectory = getOrganizationPreviewsDirectory(organization)
    await fs.mkdir(previewsDirectory, { recursive: true })

    const extension = previewExtension(format)
    const contentType = previewContentType(format)
    const outputPath = safePathJoin(previewsDirectory, `${cacheKey}.${extension}`)

    if (await fileExists(outputPath)) {
      const metadata = await sharp(outputPath).metadata()
      return { contentType: `image/${metadata.format}`, resizedPath: outputPath }
    }

    const sharpInstance = sharp(bytes).rotate().resize(maxWidth, maxHeight, {
      fit: "inside",
      withoutEnlargement: true,
    })

    switch (format) {
      case "png":
        await sharpInstance.png().toFile(outputPath)
        break
      case "jpeg":
        await sharpInstance.jpeg({ quality }).toFile(outputPath)
        break
      case "webp":
      default:
        await sharpInstance.webp({ quality }).toFile(outputPath)
        break
    }

    return { contentType, resizedPath: outputPath }
  } catch (error) {
    // Sin miniatura se sirven los bytes originales: `resizedPath: null` lo dice.
    // Antes se devolvía la ruta de entrada, que con bytes ya no existe — y
    // devolver una ruta inventada es cómo se sirve un 500 en vez de la imagen.
    console.error("Error resizing image:", error)
    return { contentType: "image/unknown", resizedPath: null }
  }
}
