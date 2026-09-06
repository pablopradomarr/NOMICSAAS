"use server"

import { fileExists, getOrganizationPreviewsDirectory, OrganizationRef, safePathJoin } from "@/lib/files"
import fs from "fs/promises"
import path from "path"
import config from "../config"
import { DEFAULT_PREVIEW_FORMAT, PreviewFormat, previewContentType, previewExtension } from "./format"

export async function resizeImage(
  organization: OrganizationRef,
  origFilePath: string,
  maxWidth: number = config.upload.images.maxWidth,
  maxHeight: number = config.upload.images.maxHeight,
  quality: number = config.upload.images.quality,
  format: PreviewFormat = DEFAULT_PREVIEW_FORMAT
): Promise<{ contentType: string; resizedPath: string }> {
  // Ronda 1 de E8, revisor #5: `sharp` es un binario nativo de ~2,3 s de carga.
  // Perezoso, para que no entre en el grafo de quien sólo importa esta función.
  const { default: sharp } = await import("sharp")
  try {
    const previewsDirectory = getOrganizationPreviewsDirectory(organization)
    await fs.mkdir(previewsDirectory, { recursive: true })

    const basename = path.basename(origFilePath, path.extname(origFilePath))
    const extension = previewExtension(format)
    const contentType = previewContentType(format)
    const outputPath = safePathJoin(previewsDirectory, `${basename}.${extension}`)

    if (await fileExists(outputPath)) {
      const metadata = await sharp(outputPath).metadata()
      return {
        contentType: `image/${metadata.format}`,
        resizedPath: outputPath,
      }
    }

    const sharpInstance = sharp(origFilePath)
      .rotate()
      .resize(maxWidth, maxHeight, {
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

    return {
      contentType,
      resizedPath: outputPath,
    }
  } catch (error) {
    console.error("Error resizing image:", error)
    return {
      contentType: "image/unknown",
      resizedPath: origFilePath,
    }
  }
}
