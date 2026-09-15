/**
 * E11 · ola A — el reloj, en su parte pura (§3.7, §7; ADR-0019 D4, **O-13**).
 *
 * **PURO**, y aquí importa más que en ningún otro sitio de esta ola: *el reloj
 * nunca entra en una cifra contable*. El job recibe `refDate` explícito, lo
 * persiste en `CronRun.refDate` y la ocurrencia **se fecha por su periodo de
 * devengo**, jamás por el instante de ejecución — que es exactamente lo que
 * `.claude/hooks/guard.sh` prohíbe dentro de `lib/ledger`.
 *
 * La consecuencia se puede probar (criterio 49): el job lanzado **con dos días
 * de retraso, o dos veces**, produce el mismo asiento y el mismo `inputHash`.
 */

export const CRON_JOBS = ["recurring-due", "invariant-sweep", "backup-worker", "retention"] as const

export type CronJobName = (typeof CRON_JOBS)[number]

export type Cadence = "EVERY_5_MIN" | "EVERY_15_MIN" | "DAILY" | "WEEKLY"

export type CronJobSpec = {
  job: CronJobName
  cadence: Cadence
  /** Descripción en español para `/api/health` y el runbook. */
  description: string
  /**
   * **§7.2 · qué hace este job cuando la organización está en mora.** Se escribe
   * aquí, en el propio contrato, y no en un comentario suelto: es la diferencia
   * entre un comportamiento decidido y uno heredado por descuido.
   */
  runsInArrears: boolean
}

/**
 * Los cuatro jobs (§7.1). `backup-schedule` y `email-sync` salen a E12 (§0.3):
 * el primero porque el backup manual y el de salida cubren lo que el ROADMAP
 * pide y lo que O-4 exige; el segundo porque es funcionalidad heredada de
 * TaxHacker, no plataforma.
 */
export const CRON_JOB_SPECS: Readonly<Record<CronJobName, CronJobSpec>> = {
  "recurring-due": {
    job: "recurring-due",
    cadence: "DAILY",
    description:
      "Genera las ocurrencias vencidas de los asientos recurrentes. En mora genera SÓLO las de " +
      "obligación devengada (§3.2) y deja el resto en OMITIDA con motivo SUSCRIPCION_EN_MORA, " +
      "que I-E9-1a admite porque exige motivo.",
    runsInArrears: true,
  },
  "invariant-sweep": {
    job: "invariant-sweep",
    cadence: "DAILY",
    description:
      "Barrido de invariantes por organización con ejercicio abierto → InvariantRun. " +
      "Corre siempre: es lectura, y un impago nuestro no puede dejar sin vigilancia los libros del cliente.",
    runsInArrears: true,
  },
  "backup-worker": {
    job: "backup-worker",
    cadence: "EVERY_5_MIN",
    description:
      "Avanza el cursor de los BackupJob vivos. Corre siempre: la portabilidad no la puede " +
      "desactivar un precio (O-4).",
    runsInArrears: true,
  },
  retention: {
    job: "retention",
    cadence: "WEEKLY",
    description:
      "prune-runs + caducidad de los ZIP + limpieza de rate_limit_buckets. Nunca toca un " +
      "StoredObject de kind PLATFORM_INVOICE (O-11): son NUESTRAS facturas emitidas, sujetas a conservación.",
    runsInArrears: true,
  },
}

export function isCronJobName(value: string): value is CronJobName {
  return (CRON_JOBS as readonly string[]).includes(value)
}

// ─────────────────────────────────────────────────────────────────────────────
// Clave de periodo — la idempotencia (I-E11-12)
// ─────────────────────────────────────────────────────────────────────────────

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0")
}

/** `AAAA-MM-DD` en UTC. Determinista y sin zona local. */
export function isoDay(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/**
 * Lunes de la semana ISO a la que pertenece `d`, en UTC. La cadencia semanal se
 * ancla al lunes y no al día de ejecución: si el domingo el workflow se retrasa
 * al lunes, la clave no debe cambiar y el job no debe correr dos veces.
 */
function isoWeekStart(d: Date): Date {
  const dia = d.getUTCDay() // 0 = domingo
  const desplazamiento = dia === 0 ? 6 : dia - 1
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - desplazamiento))
}

/**
 * La clave `(job, periodKey)` con la que `cron_runs` impide la doble ejecución.
 *
 * Se deriva **exclusivamente de `refDate`**, nunca del reloj: ése es el motivo
 * de que R-6 (GitHub Actions no garantiza puntualidad) sea inocuo. Un `schedule`
 * que se retrasa veinte minutos sigue cayendo en el mismo cubo de 5 o 15 minutos
 * si el llamante pasa el `refDate` del disparo, y si cae en el siguiente, el job
 * vuelve a ejecutarse — que es lo correcto para un worker, no para un devengo.
 */
export function periodKeyOf(_job: CronJobName, cadence: Cadence, refDate: Date): string {
  switch (cadence) {
    case "EVERY_5_MIN": {
      const m = Math.floor(refDate.getUTCMinutes() / 5) * 5
      return `${isoDay(refDate)}T${pad(refDate.getUTCHours())}:${pad(m)}`
    }
    case "EVERY_15_MIN": {
      const m = Math.floor(refDate.getUTCMinutes() / 15) * 15
      return `${isoDay(refDate)}T${pad(refDate.getUTCHours())}:${pad(m)}`
    }
    case "DAILY":
      return isoDay(refDate)
    case "WEEKLY":
      return `W${isoDay(isoWeekStart(refDate))}`
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ¿Toca?
// ─────────────────────────────────────────────────────────────────────────────

export type CronRunRow = {
  job: string
  periodKey: string
  status: "RUNNING" | "DONE" | "PARTIAL" | "FAILED"
  startedAt: Date
  finishedAt: Date | null
}

const CADENCE_MS: Readonly<Record<Cadence, number>> = {
  EVERY_5_MIN: 5 * 60 * 1000,
  EVERY_15_MIN: 15 * 60 * 1000,
  DAILY: 24 * 60 * 60 * 1000,
  WEEKLY: 7 * 24 * 60 * 60 * 1000,
}

/**
 * ¿Debe ejecutarse el job con este `refDate`?
 *
 * Un `PARTIAL` **siempre toca**: es un job que agotó su presupuesto de 240 s y
 * dejó cursor; dejarlo esperar a la cadencia siguiente es lo que convierte un
 * troceado en un trabajo que nunca termina.
 */
export function isDue(spec: CronJobSpec, lastRun: CronRunRow | null, refDate: Date): boolean {
  if (!lastRun) return true
  if (lastRun.status === "PARTIAL") return true
  if (lastRun.periodKey !== periodKeyOf(spec.job, spec.cadence, refDate)) return true
  return false
}

/**
 * **I-E11-12** · ¿lleva el job más de DOS cadencias sin ejecutarse, sin un
 * `PARTIAL`/`FAILED` que lo explique? Dos y no una: una cadencia de margen
 * absorbe el retraso normal de un `schedule` de GitHub Actions (R-6); dos ya es
 * un reloj parado.
 */
export function isStale(spec: CronJobSpec, lastRun: CronRunRow | null, refDate: Date): boolean {
  if (!lastRun) return true
  if (lastRun.status === "PARTIAL" || lastRun.status === "FAILED") return false
  const edad = refDate.getTime() - (lastRun.finishedAt ?? lastRun.startedAt).getTime()
  return edad > 2 * CADENCE_MS[spec.cadence]
}

/**
 * Presupuesto de ejecución, en milisegundos (§7.2). Vercel corta a 300 s: se
 * reservan 60 s para cerrar la fila, escribir el cursor y responder. **Un job
 * que no cabe nunca se declara `DONE`**: guarda cursor, marca `PARTIAL` y
 * devuelve `202`.
 */
export const CRON_BUDGET_MS = 240_000

/** ¿Queda presupuesto? `elapsedMs` lo mide el llamante, que sí puede ver el reloj. */
export function hasBudgetLeft(elapsedMs: number, budgetMs: number = CRON_BUDGET_MS): boolean {
  return elapsedMs < budgetMs
}
