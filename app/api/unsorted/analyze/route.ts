/**
 * E8 · T12 — `POST /api/unsorted/analyze`.
 *
 * Ya no devuelve «los campos del formulario»: devuelve el **`runId`** de un
 * `ExtractionRun` inmutable. La diferencia no es de forma. Antes la respuesta
 * era la cifra, y la cifra viajaba al formulario sin que nadie supiera qué
 * modelo la produjo ni sobre cuántas páginas; ahora la respuesta es el
 * identificador de la evidencia, y las cifras se leen de ella con su
 * `reconcile`, su confianza campo a campo y su cadena de intentos.
 *
 * El endpoint se conserva —la cola del cliente sigue llamándolo— pero el
 * trabajo real está en `enqueueExtraction` (límite, saldo, concurrencia por
 * organización) y en `runExtraction` (evidencia). Las server actions completas
 * llegan en T13.
 */

import { DocumentAlteredError, ExtractionFailedError } from "@/ai/analyze"
import {
  AiBalanceExhaustedError,
  ExtractionRateLimitedError,
  SubscriptionExpiredError,
  enqueueExtraction,
} from "@/ai/queue"
import { ActionState } from "@/lib/actions"
import { requireOrg } from "@/lib/authz"
import { NextRequest, NextResponse } from "next/server"

export type AnalyzeResponse = {
  runId: string
  reconcileStatus: string | null
  partial: boolean
  pagesSent: number
  pagesTotal: number
  provider: string
  model: string
}

const fail = (error: string, status: number) =>
  NextResponse.json<ActionState<AnalyzeResponse>>({ success: false, error }, { status })

export async function POST(request: NextRequest) {
  // Analizar consume saldo y escribe evidencia → EDITOR.
  const { db, org, user } = await requireOrg("EDITOR")

  let fileId: unknown
  try {
    fileId = (await request.json())?.fileId
  } catch {
    return fail("Cuerpo de la petición no válido", 400)
  }
  if (typeof fileId !== "string" || fileId.length === 0) {
    return fail("Falta el fileId", 400)
  }

  try {
    const run = await enqueueExtraction(db, org, fileId, { id: user.id })
    return NextResponse.json<ActionState<AnalyzeResponse>>({
      success: true,
      data: {
        runId: run.id,
        reconcileStatus: run.reconcileStatus,
        partial: run.partial,
        pagesSent: run.pagesSent,
        pagesTotal: run.pagesTotal,
        provider: run.provider,
        model: run.model,
      },
    })
  } catch (error) {
    if (error instanceof ExtractionRateLimitedError) return fail(error.message, 429)
    if (error instanceof AiBalanceExhaustedError || error instanceof SubscriptionExpiredError) {
      return fail(error.message, 402)
    }
    if (error instanceof DocumentAlteredError) return fail(error.message, 409)
    if (error instanceof ExtractionFailedError) {
      const rateLimited = error.attempts.some((attempt) => attempt.errorCode === "HTTP_429")
      return fail(error.message, rateLimited ? 429 : 502)
    }
    console.error("Extracción fallida:", error)
    return fail(error instanceof Error ? error.message : "La extracción ha fallado", 500)
  }
}
