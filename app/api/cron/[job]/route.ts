/**
 * E11 · ola A · T15/T16 — **una sola ruta** para los cuatro jobs
 * (§7.2, ADR-0019 D4, **O-13**).
 *
 * `POST /api/cron/[job]`, protegida por `Authorization: Bearer ${CRON_SECRET}`
 * con **comparación en tiempo constante**. La llaman dos relojes sobre **un solo
 * camino**: un *scheduled workflow* de GitHub Actions (P-5: gratis, cadencias de
 * 5 y 15 min) y **Vercel Cron diario como respaldo**.
 *
 * Cuatro propiedades, y ninguna es opcional:
 *
 *  · **Idempotencia** — `CronRun` con `@@unique([job, periodKey])`. La ruta
 *    INSERTA primero; si choca, `200 {skipped:true}` y no ejecuta nada. Dos
 *    invocaciones simultáneas del mismo periodo producen las mismas ocurrencias
 *    que una sola (criterio 48).
 *  · **`refDate` explícito (O-13)** — la fecha de referencia entra por el cuerpo
 *    o por la cabecera y **se persiste**. La ocurrencia se fecha por su periodo
 *    de devengo, jamás por el instante de ejecución: el job lanzado con dos días
 *    de retraso produce el mismo asiento y el mismo `inputHash` (criterio 49).
 *  · **Troceado** — presupuesto de 240 s; al agotarlo guarda `cursor`, marca
 *    `PARTIAL` y devuelve `202`. **Un job que no cabe nunca se declara `DONE`**.
 *  · **Aislamiento** — que la organización 7 falle no impide que corra la 8.
 *
 * Sin `Bearer` correcto: **`401`, sin pista y con el cubo consumido**
 * (criterio 51). No se dice si el job existe, ni si el secreto está configurado:
 * un 404 distinguible ya es información para quien sondea.
 */

import { timingSafeEqual } from "node:crypto"

import { NextRequest, NextResponse } from "next/server"

import config from "@/lib/config"
import { CRON_BUDGET_MS, isCronJobName, type CronJobName } from "@/lib/platform/cron"
import { claimCronRun, finishCronRun } from "@/models/cron"
import { PLATFORM_ACTIONS, recordPlatformAudit } from "@/models/platform"
import { consumeRateLimit, RATE_LIMIT_SCOPES } from "@/models/rate-limit"
import { runCronJob } from "@/models/cron-jobs"

/** §9.3 · cubo por IP. Generoso para el reloj legítimo, estrecho para el sondeo. */
const CRON_LIMIT = 120
const CRON_WINDOW_MS = 5 * 60 * 1000

function clientIp(request: NextRequest): string {
  const fwd = request.headers.get("x-forwarded-for")
  if (fwd) return fwd.split(",")[0].trim()
  return request.headers.get("x-real-ip") ?? "desconocida"
}

/**
 * Comparación en **tiempo constante**. Un `===` filtra la longitud del prefijo
 * coincidente por el tiempo de respuesta, y con suficientes intentos eso es un
 * secreto adivinable carácter a carácter.
 */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8")
  const b = Buffer.from(expected, "utf8")
  // `timingSafeEqual` exige la misma longitud; comparar contra un buffer del
  // mismo tamaño evita que la propia excepción revele la longitud correcta.
  if (a.length !== b.length) {
    timingSafeEqual(b, b)
    return false
  }
  return timingSafeEqual(a, b)
}

/**
 * `refDate` explícito (**O-13**). Puede venir por cabecera `X-Cron-Ref-Date` o
 * en el cuerpo JSON; si no viene, se toma el instante de la llamada. Que el
 * llamante pueda fijarlo es lo que hace **reproducible** una reejecución.
 */
function resolveRefDate(request: NextRequest, body: unknown): Date {
  const cabecera = request.headers.get("x-cron-ref-date")
  const delCuerpo = typeof body === "object" && body !== null ? (body as { refDate?: string }).refDate : undefined
  const bruto = cabecera ?? delCuerpo
  if (bruto) {
    const d = new Date(bruto)
    if (!Number.isNaN(d.getTime())) return d
  }
  return new Date()
}

export async function POST(request: NextRequest, context: { params: Promise<{ job: string }> }) {
  const { job: jobParam } = await context.params

  // El cubo se consume SIEMPRE, incluso antes de saber si el secreto vale: si el
  // intento rechazado no contara, quien sondea tendría reintentos gratis.
  const cubo = await consumeRateLimit(RATE_LIMIT_SCOPES.CRON, clientIp(request), {
    limit: CRON_LIMIT,
    windowMs: CRON_WINDOW_MS,
    at: new Date(),
  })

  const cabecera = request.headers.get("authorization") ?? ""
  const token = cabecera.startsWith("Bearer ") ? cabecera.slice(7) : ""
  const esperado = config.cron.secret

  // Sin secreto configurado, la ruta está CERRADA. Nunca abierta «porque no hay
  // secreto»: sería exactamente al revés de lo que debe pasar.
  const autorizado = esperado.length > 0 && secretMatches(token, esperado)

  if (!autorizado || !cubo.allowed) {
    await recordPlatformAudit({
      actor: "cron",
      action: PLATFORM_ACTIONS.CRON_UNAUTHORIZED,
      detail: { job: jobParam, reason: cubo.allowed ? "TOKEN_INVALIDO" : "RATE_LIMIT" },
    })
    // **Sin pista**: mismo cuerpo y mismo código para token inválido, job
    // inexistente y ruta cerrada.
    return NextResponse.json({ error: "No autorizado" }, { status: 401 })
  }

  if (!isCronJobName(jobParam)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 })
  }
  const job: CronJobName = jobParam

  let body: unknown = null
  try {
    body = await request.json()
  } catch {
    body = null
  }
  const refDate = resolveRefDate(request, body)

  // 1 · Reclamar. La INSERCIÓN es la que decide, no una comprobación previa.
  const claim = await claimCronRun(job, refDate)
  if (!claim.claimed) {
    await recordPlatformAudit({
      actor: "cron",
      action: PLATFORM_ACTIONS.CRON_SKIPPED,
      detail: { job, periodKey: claim.existing.periodKey, reason: claim.existing.status },
    })
    return NextResponse.json({ skipped: true, job, periodKey: claim.existing.periodKey }, { status: 200 })
  }

  await recordPlatformAudit({
    actor: "cron",
    action: PLATFORM_ACTIONS.CRON_STARTED,
    detail: { job, periodKey: claim.run.periodKey, refDate },
  })

  // 2 · Ejecutar, con presupuesto. El job devuelve su resultado; los fallos por
  // organización los cuenta él, no tumban la ejecución (§7.2, criterio 53).
  const t0 = Date.now()
  try {
    const resultado = await runCronJob(job, {
      refDate,
      cursor: claim.run.cursor,
      budgetMs: CRON_BUDGET_MS,
      startedAtMs: t0,
    })

    await finishCronRun(claim.run.id, {
      status: resultado.status,
      processed: resultado.processed,
      failed: resultado.failed,
      cursor: resultado.status === "PARTIAL" ? (resultado.cursor ?? {}) : null,
      error: resultado.error ?? null,
    })

    await recordPlatformAudit({
      actor: "cron",
      action: PLATFORM_ACTIONS.CRON_FINISHED,
      detail: {
        job,
        periodKey: claim.run.periodKey,
        processed: resultado.processed,
        failed: resultado.failed,
        reason: resultado.status,
        durationMs: Date.now() - t0,
      },
    })

    // `202` en PARTIAL: el trabajo continúa en la siguiente llamada, que empieza
    // por el cursor. Un `200` diría «terminado» y no lo está.
    return NextResponse.json(
      {
        job,
        periodKey: claim.run.periodKey,
        status: resultado.status,
        processed: resultado.processed,
        failed: resultado.failed,
      },
      { status: resultado.status === "PARTIAL" ? 202 : 200 }
    )
  } catch (e) {
    await finishCronRun(claim.run.id, {
      status: "FAILED",
      processed: 0,
      failed: 0,
      error: (e as Error).message.slice(0, 1024),
    })
    await recordPlatformAudit({
      actor: "cron",
      action: PLATFORM_ACTIONS.CRON_FINISHED,
      detail: { job, periodKey: claim.run.periodKey, reason: "FAILED", durationMs: Date.now() - t0 },
    })
    return NextResponse.json({ job, status: "FAILED" }, { status: 500 })
  }
}

/**
 * **Vercel Cron invoca por `GET`**, no por `POST`, y añade él mismo la cabecera
 * `Authorization: Bearer $CRON_SECRET`. Es el reloj de RESPALDO (§7.2, P-5), y
 * comparte camino con el principal: delega en el mismo `POST` en vez de duplicar
 * la lógica, porque un respaldo que hace algo distinto del principal es un
 * respaldo que nadie ha probado.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ job: string }> }) {
  return await POST(request, context)
}
