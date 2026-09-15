import config from "@/lib/config"
import { resizeImage } from "@/lib/previews/images"
import { pdfToImages } from "@/lib/previews/pdf"
import { OrganizationRef } from "@/lib/files"
import { DEFAULT_PREVIEW_FORMAT, PreviewFormat } from "./format"

/**
 * E11 · integración — las vistas previas se generan **a partir de los BYTES**,
 * no de una ruta de disco.
 *
 * Antes, `generateFilePreviews` recibía `fullPathForFile(org, file)`, de modo
 * que la vista previa era el último lector atado al volumen local. Ahora recibe
 * los bytes, que quien llama ya ha sacado del almacén con `readDocumentBytes`.
 *
 * **Las miniaturas siguen cacheándose en disco, y eso es correcto.** Una vista
 * previa es un derivado reproducible: se puede regenerar desde el original en
 * cualquier momento y no es evidencia de nada —el justificante es el original,
 * con su `sha256`, y ése sí vive en el almacén—. En un despliegue efímero la
 * caché se pierde y se rehace; perder una caché no pierde un documento.
 *
 * `cacheKey` es el **sha256 del original**, así que la caché es direccionable
 * por contenido: si los bytes cambian, la clave cambia y no hay forma de servir
 * la miniatura de un documento por otro.
 */
export async function generateFilePreviews(
  organization: OrganizationRef,
  cacheKey: string,
  bytes: Buffer,
  mimetype: string,
  format: PreviewFormat = DEFAULT_PREVIEW_FORMAT
): Promise<{ contentType: string; previews: string[] }> {
  if (mimetype === "application/pdf") {
    const { contentType, pages } = await pdfToImages(organization, cacheKey, bytes, format)
    return { contentType, previews: pages }
  } else if (mimetype.startsWith("image/")) {
    const { contentType, resizedPath } = await resizeImage(
      organization,
      cacheKey,
      bytes,
      config.upload.images.maxWidth,
      config.upload.images.maxHeight,
      config.upload.images.quality,
      format
    )
    return { contentType, previews: resizedPath ? [resizedPath] : [] }
  }
  // Ni PDF ni imagen: no hay miniatura que generar. Se devuelve `null` como
  // «página», y quien llama sirve los bytes originales, que ya tiene.
  return { contentType: mimetype, previews: [] }
}
