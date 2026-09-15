/**
 * E11 · integración — **descarga de una copia 2.0**.
 *
 * Lo que había aquí era el volcado heredado de TaxHacker: construía un ZIP de
 * formato 1.0 con nueve tablas —ninguna contable—, sin manifest, sin firma y
 * empaquetando el directorio de disco. ADR-0019 D2.1 es explícito: *«el formato
 * 1.0 de TaxHacker no se lee ni se escribe»*. Se ha retirado.
 *
 * Lo que hay ahora: un `BackupJob` ya construido y firmado se entrega desde el
 * **almacén**. La ruta no genera nada, no vuelca nada y no toca el disco; sólo
 * comprueba que el trabajo es de esta organización, que está `DONE` y que su
 * objeto sigue vivo.
 *
 * **Permitida en `READ_ONLY`** (D5/D6, O-4): descargar una copia completa de sus
 * libros es la portabilidad que ningún precio puede desactivar, y `requireOrg`
 * no la deniega porque la clase de escritura aquí no es ninguna: es una lectura.
 */

import { requireOrg } from "@/lib/authz"
import { encodeFilename } from "@/lib/utils"
import { getObjectBuffer } from "@/models/storage"
import { NextResponse } from "next/server"

export async function GET(request: Request) {
  const { db } = await requireOrg("ADMIN")

  const jobId = new URL(request.url).searchParams.get("jobId")
  if (!jobId) {
    return NextResponse.json({ error: "Falta el identificador de la copia" }, { status: 400 })
  }

  const job = await db.backupJob.findFirst({ where: { id: jobId } })
  if (!job) {
    return NextResponse.json({ error: "Esa copia no existe o no es de esta organización" }, { status: 404 })
  }
  if (job.status !== "DONE" || !job.objectKey) {
    return NextResponse.json(
      {
        error:
          job.status === "EXPIRED"
            ? "Esa copia ha caducado: el ZIP se ha borrado según la retención del plan. Los libros y los " +
              "justificantes NO se borran (art. 30 CCom): pide una copia nueva."
            : `La copia está en estado ${job.status} y todavía no se puede descargar.`,
      },
      { status: 409 }
    )
  }

  let bytes: Buffer
  try {
    bytes = await getObjectBuffer(db, job.objectKey)
  } catch {
    // Fila viva y objeto ausente es exactamente lo que I-E11-6 detecta. Se dice,
    // no se devuelve un ZIP vacío que parecería una copia buena.
    return NextResponse.json(
      { error: "El archivo de esa copia no está en el almacén. I-E11-6 lo marcará en la Auditoría." },
      { status: 410 }
    )
  }

  const nombre = `copia-${job.createdAt.toISOString().slice(0, 10)}-${job.id.slice(0, 8)}.zip`
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/zip",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename*=${encodeFilename(nombre)}`,
    },
  })
}
