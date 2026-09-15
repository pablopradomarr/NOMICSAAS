/**
 * E11 · ola A · T15 — `CronRun`: la idempotencia del reloj (I-E11-12).
 *
 * `cron_runs` **no tiene `organization_id`** (§9.5): el reloj no es de nadie.
 * Por eso este fichero está en la lista blanca de `eslint.config.mjs` y usa el
 * cliente sin acotar — `tenantDb` le inyectaría un filtro por una columna que no
 * existe y toda lectura fallaría (ADR-0014 D7).
 *
 * La regla que sostiene todo lo demás: **la ruta INSERTA primero**. Si el
 * `@@unique([job, periodKey])` choca, el job no se ejecuta y se responde
 * `200 {skipped:true}`. Dos invocaciones simultáneas del mismo periodo producen
 * las mismas ocurrencias que una sola (criterio 48), y eso no depende de que el
 * código compruebe antes: depende del índice.
 */

import { prisma } from "@/lib/db"
import { CRON_JOB_SPECS, periodKeyOf, type CronJobName } from "@/lib/platform/cron"
import type { CronRunRow } from "@/lib/platform/cron"
import type { CronStatus, Prisma } from "@/prisma/client"

export type CronRunRecord = {
  id: string
  job: string
  periodKey: string
  status: CronStatus
  refDate: Date
  cursor: Prisma.JsonValue | null
  processed: number
  failed: number
  error: string | null
  startedAt: Date
  finishedAt: Date | null
}

/** Devuelto cuando el `(job, periodKey)` ya existe: no se ejecuta nada. */
export type CronClaim = { claimed: true; run: CronRunRecord } | { claimed: false; existing: CronRunRecord }

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002"
}

/**
 * Reclama la ejecución de un job para un `refDate`.
 *
 * `refDate` se **persiste** (O-13): un asiento generado por el reloj tiene que
 * poder explicar con qué fecha de referencia se fechó, y sin la columna eso es
 * inauditable.
 *
 * Un `PARTIAL` previo del mismo periodo **se reanuda** en vez de rechazarse: es
 * un job que agotó su presupuesto y dejó cursor, y dejarlo esperar a la cadencia
 * siguiente convierte el troceado en un trabajo que nunca termina.
 */
export async function claimCronRun(job: CronJobName, refDate: Date): Promise<CronClaim> {
  const spec = CRON_JOB_SPECS[job]
  const periodKey = periodKeyOf(job, spec.cadence, refDate)

  try {
    const run = await prisma.cronRun.create({
      data: { job, periodKey, refDate, status: "RUNNING" },
    })
    return { claimed: true, run }
  } catch (e) {
    if (!isUniqueViolation(e)) throw e
  }

  const existing = await prisma.cronRun.findUnique({ where: { job_periodKey: { job, periodKey } } })
  if (!existing) {
    // Carrera imposible en la práctica (el UNIQUE acaba de rechazarnos), pero no
    // se devuelve un `claimed: true` inventado: se relanza el fallo real.
    throw new Error(`cron_runs: el UNIQUE rechazó (${job}, ${periodKey}) pero la fila no aparece`)
  }

  if (existing.status === "PARTIAL") {
    const reanudado = await prisma.cronRun.update({
      where: { id: existing.id },
      data: { status: "RUNNING", finishedAt: null, error: null },
    })
    return { claimed: true, run: reanudado }
  }

  return { claimed: false, existing }
}

export type CronOutcome = {
  status: Exclude<CronStatus, "RUNNING">
  processed: number
  failed: number
  /** Cursor para reanudar; obligatorio en `PARTIAL`, prohibido en `DONE`. */
  cursor?: Prisma.InputJsonValue | null
  error?: string | null
}

/**
 * Cierra la fila del run.
 *
 * **Un job que no cabe nunca se declara `DONE`** (§7.2): si agotó el
 * presupuesto, cierra en `PARTIAL` con su cursor y la ruta devuelve `202`.
 * Cerrar en `DONE` un trabajo a medias es exactamente el fallo de G-15 —contar
 * como hecho lo que falló— trasladado al reloj.
 */
export async function finishCronRun(id: string, outcome: CronOutcome): Promise<CronRunRecord> {
  if (outcome.status === "PARTIAL" && (outcome.cursor === undefined || outcome.cursor === null)) {
    throw new Error("Un CronRun PARTIAL exige cursor: sin él la siguiente ejecución no sabría por dónde seguir")
  }
  if (outcome.status === "DONE" && outcome.cursor) {
    throw new Error("Un CronRun DONE no puede dejar cursor: o terminó, o es PARTIAL")
  }
  return await prisma.cronRun.update({
    where: { id },
    data: {
      status: outcome.status,
      processed: outcome.processed,
      failed: outcome.failed,
      cursor: outcome.cursor ?? undefined,
      error: outcome.error ?? null,
      finishedAt: new Date(),
    },
  })
}

/** La última ejecución de cada job, para `isDue`, `isStale` y `/api/health`. */
export async function lastRunsByJob(): Promise<Record<string, CronRunRow | null>> {
  const rows = await prisma.$queryRaw<
    { job: string; period_key: string; status: CronStatus; started_at: Date; finished_at: Date | null }[]
  >`
    SELECT DISTINCT ON ("job") "job", "period_key", "status", "started_at", "finished_at"
      FROM "cron_runs"
     ORDER BY "job", "started_at" DESC
  `
  const salida: Record<string, CronRunRow | null> = {}
  for (const job of Object.keys(CRON_JOB_SPECS)) salida[job] = null
  for (const r of rows) {
    salida[r.job] = {
      job: r.job,
      periodKey: r.period_key,
      status: r.status,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    }
  }
  return salida
}

export async function getCronRun(id: string): Promise<CronRunRecord | null> {
  return await prisma.cronRun.findUnique({ where: { id } })
}
