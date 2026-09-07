/**
 * E7 · T10 — El trabajador del barrido del almacén, **en cola y por lotes**.
 *
 * Vive junto a `ai/queue.ts` porque es la misma clase de trabajo: algo que la
 * petición **no** puede esperar. Cuatro decisiones del diseño (§8, R7):
 *
 *  1. **Lotes de 50** y, entre lote y lote, dos cosas: se publica el progreso
 *     (`Progress` + SSE, el mismo canal de E8) y se mira si alguien canceló.
 *  2. **`sha256` en streaming** (`lib/files-integrity`): un adjunto de 25 MB no
 *     se carga en memoria para hashearlo, y 20 000 adjuntos menos.
 *  3. **Hallazgos acotados** a 1 000 + contador: la fila del barrido no crece
 *     sin límite.
 *  4. **Una transacción corta por lote**, nunca una transacción que dure el
 *     barrido entero: bloquearía el pool durante minutos.
 *
 * El barrido **no escribe en `files`**: sólo compara los bytes del almacén con
 * el `sha256` registrado y anota el veredicto.
 */

import "server-only"

import { ConcurrencyLimiter } from "@/lib/analyze-queue"
import { sha256OfStoredFile, storedFilePath } from "@/lib/files-integrity"
import { tenantDb } from "@/lib/db"
import {
  SWEEP_BATCH_SIZE,
  appendFindings,
  finishSweep,
  startSweep,
  type StoreSweepRow,
  type SweepFinding,
} from "@/models/store-sweep"
import { getOrCreateProgress, updateProgress } from "@/models/progress"
import { stat } from "node:fs/promises"

/** Un barrido a la vez por organización: es trabajo de disco, no de CPU. */
const sweepLimiters = new Map<string, ConcurrencyLimiter>()

const limiterFor = (organizationId: string): ConcurrencyLimiter => {
  const existing = sweepLimiters.get(organizationId)
  if (existing) return existing
  const limiter = new ConcurrencyLimiter()
  limiter.setMax(1)
  sweepLimiters.set(organizationId, limiter)
  return limiter
}

/**
 * El canal de progreso **es el id del barrido**. `progress.id` es un `uuid` en
 * la base, así que un prefijo textual (`store-sweep:<uuid>`) no cabe; y como el
 * `StoreSweep` ya es único, no hace falta inventar otra clave. El `type` de la
 * fila (`store-sweep`) es lo que distingue el canal del de las extracciones.
 */
export const sweepProgressId = (sweepId: string): string => sweepId

export type SweepOutcome = { sweepId: string; progressId: string; promise: Promise<StoreSweepRow> }

/**
 * Encola el barrido y devuelve **enseguida** el id y el canal de progreso: la
 * pantalla no espera al disco. `promise` existe para los tests y para el
 * script; la UI no la usa.
 */
export async function enqueueStoreSweep(
  organizationId: string,
  actor: { userId: string }
): Promise<SweepOutcome> {
  const db = tenantDb(organizationId)
  const files = await db.file.findMany({
    select: { id: true, path: true, sha256: true },
    orderBy: { createdAt: "asc" },
  })
  const sweep = await startSweep(organizationId, actor, files.length)
  const progressId = sweepProgressId(sweep.id)
  await getOrCreateProgress(db, actor.userId, progressId, "store-sweep", null, files.length)

  const promise = limiterFor(organizationId).run(() => sweepFiles(organizationId, sweep.id, progressId, actor, files))
  // Un fallo del trabajador no puede tumbar la petición que lo encoló.
  promise.catch(() => undefined)
  return { sweepId: sweep.id, progressId, promise }
}

async function sweepFiles(
  organizationId: string,
  sweepId: string,
  progressId: string,
  actor: { userId: string },
  files: readonly { id: string; path: string; sha256: string }[]
): Promise<StoreSweepRow> {
  const db = tenantDb(organizationId)
  let done = 0
  try {
    for (let offset = 0; offset < files.length; offset += SWEEP_BATCH_SIZE) {
      const batch = files.slice(offset, offset + SWEEP_BATCH_SIZE)
      const findings: SweepFinding[] = []
      let filesOk = 0
      let filesMissing = 0
      let filesAltered = 0
      let bytesRead = 0

      for (const file of batch) {
        const read = await sha256OfStoredFile(organizationId, file.path)
        if ("error" in read) {
          const missing = read.error.includes("no está en el almacén")
          if (missing) filesMissing += 1
          findings.push({
            kind: missing ? "MISSING" : "UNREADABLE",
            fileId: file.id,
            path: file.path,
            expected: file.sha256,
            actual: null,
            detail: read.error,
          })
          continue
        }
        bytesRead += await sizeOf(organizationId, file.path)
        if (!file.sha256) {
          findings.push({ kind: "NO_SHA", fileId: file.id, path: file.path, expected: null, actual: read.sha256 })
          continue
        }
        if (read.sha256 !== file.sha256) {
          filesAltered += 1
          findings.push({ kind: "ALTERED", fileId: file.id, path: file.path, expected: file.sha256, actual: read.sha256 })
          continue
        }
        filesOk += 1
      }

      const { cancelled } = await appendFindings(organizationId, sweepId, {
        findings,
        filesOk,
        filesMissing,
        filesAltered,
        bytesRead,
      })
      done += batch.length
      await updateProgress(db, actor.userId, progressId, { current: done, total: files.length })
      // Cancelación ENTRE LOTES: `requestCancel` ya dejó el barrido en
      // `CANCELLED`; el trabajador se retira sin tocar nada más.
      if (cancelled) {
        const current = await db.storeSweep.findFirst({ where: { id: sweepId } })
        return {
          ...(current as unknown as StoreSweepRow),
          status: "CANCELLED",
        }
      }
    }
    return await finishSweep(organizationId, sweepId, "DONE")
  } catch {
    return await finishSweep(organizationId, sweepId, "FAILED")
  }
}

/** Tamaño del fichero, sólo para la métrica de MB leídos. Nunca lanza. */
async function sizeOf(organizationId: string, relativePath: string): Promise<number> {
  try {
    const info = await stat(storedFilePath(organizationId, relativePath))
    return info.size
  } catch {
    return 0
  }
}
