/**
 * E11 · ola A · T19 — `GET /api/health` (§7.3).
 *
 * **Sin autenticación y sin PII.** Es la única pantalla de plataforma que queda
 * en E11 (`/admin` sale a E12, P-6), así que tiene que poder mirarla un
 * comprobador externo sin credenciales — y por eso **no dice nada de nadie**: ni
 * un nombre, ni un email, ni un NIF, ni un importe del diario. El operador ve
 * *cuánto*, no *qué*.
 *
 * `migrations.pending > 0` ⇒ `degraded` (criterio 54), y un job con la última
 * ejecución más vieja que dos cadencias también: los recurrentes no se generan
 * solos si el reloj no llama, y descubrirlo por un asiento que falta es tarde.
 */

import { NextResponse } from "next/server"

import config from "@/lib/config"
import { healthReport } from "@/models/platform"

/** No se cachea: un informe de salud cacheado es un informe de salud mentiroso. */
export const dynamic = "force-dynamic"
export const revalidate = 0

export async function GET() {
  const report = await healthReport({
    version: config.app.version,
    gitSha: config.platform.gitSha,
    refDate: new Date(),
  })

  // `503` cuando la base no responde: un monitor externo tiene que poder
  // enterarse por el código HTTP, no leyendo el cuerpo. `degraded` sigue siendo
  // `200`: el producto funciona, pero hay algo que mirar.
  return NextResponse.json(report, { status: report.status === "down" ? 503 : 200 })
}
