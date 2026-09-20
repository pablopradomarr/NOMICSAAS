/**
 * E12 · T15 (deuda 4) — el logotipo y el avatar se sirven **del almacén**.
 *
 * Sustituye a `/files/static/[filename]`, que leía de `uploads/<org>/static/` y
 * en Vercel era `/tmp`: el logotipo de las facturas desaparecía en el despliegue
 * siguiente. Aquí la imagen se pide por su `sha256`, que es como se guarda.
 *
 * Tres cosas que la ruta hace y la anterior no:
 *
 *  - **Comprueba la membresía** (`requireOrg`) igual que antes, pero además
 *    exige que el objeto sea de ESTA organización y de familia `BRANDING`: la
 *    ruta no puede convertirse en un lector genérico del bucket.
 *  - **Valida la forma del identificador** antes de tocar nada. Un `sha256` es
 *    64 hexadecimales; cualquier otra cosa es 400 y no llega al almacén.
 *  - **Cachea con `immutable`**: el contenido está direccionado por su hash, así
 *    que no puede cambiar bajo la misma URL.
 */

import { requireOrg } from "@/lib/authz"
import { safeDownloadHeaders } from "@/lib/files"
import { getObjectBuffer } from "@/models/storage"
import { NextResponse } from "next/server"

const SHA256_RE = /^[0-9a-f]{64}$/

export async function GET(_request: Request, { params }: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await params
  const { db } = await requireOrg("VIEWER")

  if (!SHA256_RE.test(sha256 ?? "")) {
    return new NextResponse("Identificador de imagen no válido", { status: 400 })
  }

  // La RLS ya acota la fila a la organización activa; el filtro por `kind` es lo
  // que impide que esta ruta sirva un documento contable por su sha.
  const object = await db.storedObject.findFirst({ where: { sha256, kind: "BRANDING" } })
  if (!object) {
    return new NextResponse("Imagen no encontrada", { status: 404 })
  }

  try {
    const bytes = await getObjectBuffer(db, object.objectKey)
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        ...safeDownloadHeaders(object.mimeType),
        "cache-control": "private, max-age=31536000, immutable",
      },
    })
  } catch {
    // Los bytes no están donde la fila promete: es lo que I-E11-6 detecta, y la
    // pantalla lo dice en vez de responder un 500.
    return new NextResponse("La imagen no está en el almacén", { status: 410 })
  }
}
