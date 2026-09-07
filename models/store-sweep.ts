/**
 * E7 · T10 — Barrido del almacén de ficheros (`docs/design/E7-auditoria.md` §4.1
 * y §8), que cierra la deuda que E8 dejó abierta en I-E8-2.
 *
 * I-E8-2 sólo mira **los ficheros que respaldan un asiento**. El barrido mira
 * **todos**: un documento subido, nunca contabilizado y desaparecido del disco
 * no lo veía nadie (criterio 6). Por eso no puede correr dentro de una petición
 * —20 000 ficheros son 20 000 lecturas— y vive en cola, por lotes, con
 * `sha256` en streaming, cancelable y con los hallazgos acotados (R7).
 *
 * `store_sweeps` es **semi-append-only**: se inserta el arranque y sólo se
 * escriben las nueve columnas del progreso (M2, `GRANT` de columna + trigger).
 */

import type { TenantClient, TenantTransactionClient } from "@/lib/db"
import { tenantTransaction } from "@/lib/db"
import { writeAuditLog } from "@/models/audit-log"
import type { Prisma } from "@/prisma/client"

type AnyClient = TenantClient | TenantTransactionClient

/** Cota dura del diseño: 1 000 hallazgos + contador de desbordamiento. */
export const MAX_SWEEP_FINDINGS = 1000

/** Tamaño del lote. Entre lote y lote se mira la cancelación. */
export const SWEEP_BATCH_SIZE = 50

export type SweepFindingKind = "MISSING" | "ALTERED" | "UNREADABLE" | "NO_SHA"

export type SweepFinding = {
  kind: SweepFindingKind
  fileId: string
  path: string
  /** El sha256 registrado en la base. */
  expected: string | null
  /** El sha256 de los bytes que hoy hay en el almacén. */
  actual: string | null
  detail?: string
}

export type StoreSweepRow = {
  id: string
  status: "RUNNING" | "DONE" | "FAILED" | "CANCELLED"
  filesTotal: number
  filesOk: number
  filesMissing: number
  filesAltered: number
  bytesRead: number
  findings: readonly SweepFinding[]
  findingsOverflow: number
  startedAt: Date
  finishedAt: Date | null
  runById: string | null
}

const toRow = (row: {
  id: string
  status: string
  filesTotal: number
  filesOk: number
  filesMissing: number
  filesAltered: number
  bytesRead: bigint
  findings: Prisma.JsonValue
  findingsOverflow: number
  startedAt: Date
  finishedAt: Date | null
  runById: string | null
}): StoreSweepRow => ({
  id: row.id,
  status: row.status as StoreSweepRow["status"],
  filesTotal: row.filesTotal,
  filesOk: row.filesOk,
  filesMissing: row.filesMissing,
  filesAltered: row.filesAltered,
  bytesRead: Number(row.bytesRead),
  findings: (row.findings ?? []) as unknown as readonly SweepFinding[],
  findingsOverflow: row.findingsOverflow,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
  runById: row.runById,
})

export async function startSweep(
  organizationId: string,
  actor: { userId: string },
  filesTotal: number
): Promise<StoreSweepRow> {
  return await tenantTransaction(organizationId, actor.userId, async (tx) => {
    const running = await tx.storeSweep.findFirst({ where: { status: "RUNNING" } })
    if (running) {
      throw new Error("Ya hay un barrido del almacén en marcha en esta organización: espera a que termine o cancélalo")
    }
    const row = await tx.storeSweep.create({
      data: { organizationId, filesTotal, runById: actor.userId },
    })
    await writeAuditLog(tx, {
      entity: "StoreSweep",
      entityId: row.id,
      action: "SWEEP_STORE",
      after: { filesTotal },
      userId: actor.userId,
    })
    return toRow(row)
  })
}

/**
 * Progreso de un lote. Los hallazgos se **acumulan con cota**: pasados los
 * 1 000, se cuentan en `findingsOverflow` y no se guardan. Un barrido no puede
 * hacer crecer una fila sin límite (R12).
 */
export async function appendFindings(
  organizationId: string,
  sweepId: string,
  batch: {
    findings: readonly SweepFinding[]
    filesOk: number
    filesMissing: number
    filesAltered: number
    bytesRead: number
  }
): Promise<{ cancelled: boolean }> {
  return await tenantTransaction(organizationId, undefined, async (tx) => {
    const current = await tx.storeSweep.findFirst({ where: { id: sweepId } })
    if (!current) throw new Error("El barrido no existe en esta organización")
    if (current.status !== "RUNNING") return { cancelled: true }

    const existing = (current.findings ?? []) as unknown as SweepFinding[]
    const room = Math.max(0, MAX_SWEEP_FINDINGS - existing.length)
    const kept = batch.findings.slice(0, room)
    const overflow = batch.findings.length - kept.length

    await tx.storeSweep.update({
      where: { id: sweepId },
      data: {
        findings: [...existing, ...kept] as unknown as Prisma.InputJsonValue,
        findingsOverflow: { increment: overflow },
        filesOk: { increment: batch.filesOk },
        filesMissing: { increment: batch.filesMissing },
        filesAltered: { increment: batch.filesAltered },
        bytesRead: { increment: BigInt(Math.max(0, Math.trunc(batch.bytesRead))) },
      },
    })
    return { cancelled: false }
  })
}

export async function finishSweep(
  organizationId: string,
  sweepId: string,
  status: "DONE" | "FAILED" | "CANCELLED"
): Promise<StoreSweepRow> {
  return await tenantTransaction(organizationId, undefined, async (tx) => {
    const row = await tx.storeSweep.update({
      where: { id: sweepId },
      data: { status, finishedAt: new Date() },
    })
    return toRow(row)
  })
}

/** Cancelación **entre lotes**: se marca y el trabajador la ve al empezar el siguiente. */
export async function requestCancel(
  organizationId: string,
  sweepId: string,
  actor: { userId: string }
): Promise<StoreSweepRow> {
  return await tenantTransaction(organizationId, actor.userId, async (tx) => {
    const before = await tx.storeSweep.findFirst({ where: { id: sweepId } })
    if (!before) throw new Error("El barrido no existe en esta organización")
    if (before.status !== "RUNNING") throw new Error("Ese barrido ya había terminado")
    const after = await tx.storeSweep.update({
      where: { id: sweepId },
      data: { status: "CANCELLED", finishedAt: new Date() },
    })
    await writeAuditLog(tx, {
      entity: "StoreSweep",
      entityId: sweepId,
      action: "cancel",
      before,
      after,
      userId: actor.userId,
    })
    return toRow(after)
  })
}

export async function latestSweep(db: AnyClient, opts: { status?: StoreSweepRow["status"] } = {}): Promise<StoreSweepRow | null> {
  const row = await db.storeSweep.findFirst({
    where: opts.status ? { status: opts.status } : {},
    orderBy: { startedAt: "desc" },
  })
  return row ? toRow(row) : null
}

export async function getSweep(db: AnyClient, id: string): Promise<StoreSweepRow | null> {
  const row = await db.storeSweep.findFirst({ where: { id } })
  return row ? toRow(row) : null
}

/**
 * Lo que I-E7-8 necesita: **qué ficheros existen** y **qué ficheros tuvieron
 * veredicto** en el último barrido terminado. Un fichero ingerido después del
 * barrido deja el invariante en FAIL hasta que se vuelve a barrer, que es lo
 * que el criterio 6 pide.
 */
export async function readStoreCoverage(
  db: AnyClient
): Promise<{
  files: { id: string; ingestedAt: string }[]
  lastSweep: { id: string; status: string; finishedAt: string | null; sweptFileIds: string[] } | null
}> {
  const files = await db.file.findMany({ select: { id: true, createdAt: true }, orderBy: { createdAt: "asc" } })
  const sweep = await db.storeSweep.findFirst({ where: { status: "DONE" }, orderBy: { startedAt: "desc" } })
  if (!sweep) {
    return { files: files.map((f) => ({ id: f.id, ingestedAt: f.createdAt.toISOString() })), lastSweep: null }
  }
  // El barrido guarda SÓLO los hallazgos (cota de 1 000): el conjunto barrido es
  // el de los ficheros que existían cuando terminó. Un fichero ingerido después
  // no tiene veredicto y el invariante lo dice.
  const swept = files.filter((f) => sweep.finishedAt !== null && f.createdAt <= sweep.finishedAt).map((f) => f.id)
  return {
    files: files.map((f) => ({ id: f.id, ingestedAt: f.createdAt.toISOString() })),
    lastSweep: {
      id: sweep.id,
      status: sweep.status,
      finishedAt: sweep.finishedAt ? sweep.finishedAt.toISOString() : null,
      sweptFileIds: swept,
    },
  }
}
