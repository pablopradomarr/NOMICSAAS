/**
 * E8 · T12 — Encolado de extracciones: límite, saldo, progreso.
 *
 * `runExtraction` sabe extraer; este módulo sabe **cuándo se le deja**. Cuatro
 * decisiones, todas del diseño §9 y §10:
 *
 *  1. **La UI nunca espera al LLM.** El llamante encola y recibe el `runId`; el
 *     estado va por `Progress` + SSE (`app/api/progress/[progressId]`).
 *  2. **Concurrencia por organización**, tomada de `Setting`, no del navegador:
 *     dos pestañas abiertas ya no duplican el ritmo contra el proveedor.
 *  3. **Rate limit por organización** con `lib/rate-limit.ts`. Es de proceso y
 *     así está declarado: frena la ráfaga, no sustituye a una cuota.
 *  5. **E9 · T22 — el techo es por organización, por minuto y por PLAN** (§5.4,
 *     deuda de E8). Hasta aquí el techo era una constante única para todas las
 *     organizaciones: la cola sólo acotaba la **concurrencia** por proveedor y un
 *     lote de 100 documentos consumía saldo tan rápido como el proveedor lo
 *     sirviera. Ahora `EXTRACTION_RATE_LIMIT_BY_PLAN` fija cuántas extracciones
 *     por minuto admite cada plan y el rechazo viaja con el límite y el plan
 *     dentro de `ExtractionRateLimitedError`, para que la bandeja pueda decir
 *     **qué** techo se ha tocado y **cuándo** se libera, en vez de un «inténtelo
 *     más tarde» que el usuario no puede accionar.
 *  4. **El saldo se decrementa POR RUN CREADO** (G-12), y sólo después de que
 *     el `INSERT` haya tenido éxito. El código anterior descontaba «si
 *     `tokensUsed > 0`», de modo que un proveedor que no reportaba tokens
 *     analizaba gratis y otro que fallaba tras consumirlos no cobraba nada.
 */

import "server-only"

import { runExtraction, type ExtractionActor, type RunExtractionOptions } from "@/ai/analyze"
import {
  DEFAULT_ANALYZE_CONCURRENCY,
  EXTRACTION_RATE_LIMIT,
  EXTRACTION_RATE_WINDOW_MS,
  analyzeProgressId,
  extractionRateLimitKey,
  serverAnalyzeQueue,
} from "@/lib/analyze-queue"
import { isAiBalanceExhausted, isSubscriptionExpired } from "@/lib/auth"
import type { TenantClient } from "@/lib/db"
import { consumeRateLimit } from "@/lib/rate-limit"
import { getFileById } from "@/models/files"
import { updateOrganization } from "@/models/organizations"
import { getOrCreateProgress, incrementProgress, updateProgress } from "@/models/progress"
import { getAnalyzeConcurrency, getSettings } from "@/models/settings"
import type { ExtractionRun, Organization } from "@/prisma/client"

/**
 * **E9 · T22.** Techo de extracciones **por organización y por minuto**, según
 * el plan de la organización (`Organization.membershipPlan`). No sustituye a la
 * cuota —el saldo se descuenta por run creado (G-12)—: acota la **ráfaga**, que
 * es lo que hoy podía vaciar el saldo de un mes en un minuto.
 *
 * Un plan desconocido cae al techo por defecto: el límite nunca desaparece por
 * no reconocer una cadena.
 */
export const EXTRACTION_RATE_LIMIT_BY_PLAN: Readonly<Record<string, number>> = {
  free: 10,
  starter: 30,
  pro: 60,
  business: 120,
  enterprise: 300,
}

/** Techo aplicable a una organización, en peticiones por ventana. */
export function extractionRateLimitFor(organization: Pick<Organization, "membershipPlan">): number {
  const plan = organization.membershipPlan?.trim().toLowerCase()
  if (!plan) return EXTRACTION_RATE_LIMIT
  return EXTRACTION_RATE_LIMIT_BY_PLAN[plan] ?? EXTRACTION_RATE_LIMIT
}

export class ExtractionRateLimitedError extends Error {
  readonly resetAt: number
  /** Techo que se ha tocado, para que la bandeja lo diga con una cifra. */
  readonly limit: number
  readonly windowMs: number
  readonly plan: string | null

  constructor(resetAt: number, limit: number = EXTRACTION_RATE_LIMIT, plan: string | null = null) {
    super(
      `Demasiadas extracciones seguidas en esta organización: el máximo es de ${limit} por minuto` +
        (plan ? ` en el plan ${plan}` : "") +
        ". Inténtelo de nuevo en unos segundos."
    )
    this.name = "ExtractionRateLimitedError"
    this.resetAt = resetAt
    this.limit = limit
    this.windowMs = EXTRACTION_RATE_WINDOW_MS
    this.plan = plan
  }
}

export class AiBalanceExhaustedError extends Error {
  constructor() {
    super("La organización ha agotado su saldo de análisis con IA.")
    this.name = "AiBalanceExhaustedError"
  }
}

export class SubscriptionExpiredError extends Error {
  constructor() {
    super("La suscripción de la organización ha caducado.")
    this.name = "SubscriptionExpiredError"
  }
}

export type EnqueueOptions = RunExtractionOptions & {
  /** Reloj del rate limit. Inyectable para que el test no dependa de la hora. */
  now?: number
}

/**
 * Extrae un documento: comprueba puertas, encola y descuenta saldo.
 *
 * **Firma pública para T13** (`analyzeFileAction`).
 *
 * @throws ExtractionRateLimitedError · AiBalanceExhaustedError ·
 *         SubscriptionExpiredError · DocumentAlteredError · ExtractionFailedError
 */
export async function enqueueExtraction(
  db: TenantClient,
  organization: Organization,
  fileId: string,
  actor: ExtractionActor,
  options: EnqueueOptions = {}
): Promise<ExtractionRun> {
  const now = options.now ?? Date.now()
  const perMinute = extractionRateLimitFor(organization)
  const limit = consumeRateLimit(extractionRateLimitKey(organization.id), perMinute, EXTRACTION_RATE_WINDOW_MS, now)
  if (!limit.allowed) {
    throw new ExtractionRateLimitedError(limit.resetAt, perMinute, organization.membershipPlan ?? null)
  }

  if (isAiBalanceExhausted(organization)) throw new AiBalanceExhaustedError()
  if (isSubscriptionExpired(organization)) throw new SubscriptionExpiredError()

  const file = await getFileById(db, fileId)
  if (!file) throw new Error("El fichero no existe o no pertenece a esta organización")

  const settings = await getSettings(db)
  const concurrency = getAnalyzeConcurrency(settings) || DEFAULT_ANALYZE_CONCURRENCY

  const run = await serverAnalyzeQueue.run(organization.id, concurrency, () =>
    runExtraction(db, organization, file, actor, options)
  )

  // Saldo: por RUN CREADO, y sólo tras el INSERT (G-12).
  await updateOrganization(organization.id, { aiBalance: { decrement: 1 } })

  return run
}

export type BatchOutcome = {
  progressId: string
  runs: ExtractionRun[]
  failures: { fileId: string; error: string }[]
}

/**
 * Lote de extracciones con progreso observable.
 *
 * Un fichero que falla **no aborta el lote**: se anota y se sigue. Lo contrario
 * dejaría media bandeja sin analizar por un PDF corrupto, y el usuario no
 * sabría cuál. Cada documento consume su saldo por separado, como su run.
 *
 * **Firma pública para T13** (`analyzeBatchAction`).
 */
export async function enqueueExtractionBatch(
  db: TenantClient,
  organization: Organization,
  fileIds: readonly string[],
  actor: ExtractionActor,
  options: EnqueueOptions = {}
): Promise<BatchOutcome> {
  const progressId = analyzeProgressId(`${organization.id}:${actor.id ?? "anon"}:${fileIds.length}`)
  if (actor.id) {
    await getOrCreateProgress(db, actor.id, progressId, "extraction", null, fileIds.length)
    await updateProgress(db, actor.id, progressId, { current: 0, total: fileIds.length })
  }

  const runs: ExtractionRun[] = []
  const failures: { fileId: string; error: string }[] = []

  const settled = await Promise.allSettled(
    fileIds.map(async (fileId) => {
      const run = await enqueueExtraction(db, organization, fileId, actor, options)
      if (actor.id) await incrementProgress(db, actor.id, progressId, 1)
      return run
    })
  )

  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      runs.push(result.value)
    } else {
      failures.push({
        fileId: fileIds[index],
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      })
    }
  })

  // El progreso se cierra aunque haya fallos: si no, el SSE quedaría abierto
  // esperando un avance que nunca llega y la pantalla diría «analizando» para
  // siempre.
  if (actor.id) {
    await updateProgress(db, actor.id, progressId, { current: fileIds.length, total: fileIds.length })
  }

  return { progressId, runs, failures }
}
