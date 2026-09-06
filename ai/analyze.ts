"use server"

import { ActionState } from "@/lib/actions"
import { TenantClient } from "@/lib/db"
import { getLLMSettings, getSettings } from "@/models/settings"
import { AnalyzeAttachment } from "./attachments"
import { requestLLM } from "./providers/llmProvider"

export type AnalysisResult = {
  output: Record<string, string>
  tokensUsed: number
}

export async function analyzeTransaction(
  db: TenantClient,
  prompt: string,
  schema: Record<string, unknown>,
  attachments: AnalyzeAttachment[],
  // E8 · T11: hoy sin uso — desde que `cached_parse_result` desapareció (G-03),
  // quien persiste la evidencia es `runExtraction` con un `ExtractionRun`. Se
  // conserva en la firma porque es esa tarea la que lo consume.
  _fileId: string
): Promise<ActionState<AnalysisResult>> {
  const settings = await getSettings(db)
  const llmSettings = getLLMSettings(settings)

  try {
    const response = await requestLLM(llmSettings, {
      prompt,
      schema,
      attachments,
    })

    if (response.error) {
      throw new Error(response.error)
    }

    const result = response.output
    const tokensUsed = response.tokensUsed || 0

    console.log("LLM response:", result)
    console.log("LLM tokens used:", tokensUsed)

    // E8 · T3 (G-03): `files.cached_parse_result` ha DESAPARECIDO. La salida de
    // un modelo no se memoriza en una columna mutable sin proveedor, sin
    // prompt-sha y sin páginas vistas: se persiste como `ExtractionRun`
    // inmutable, que es evidencia y no atajo. Lo hace `runExtraction` en **T11**.
    return {
      success: true,
      data: {
        output: result,
        tokensUsed: tokensUsed,
      },
    }
  } catch (error) {
    console.error("AI Analysis error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to analyze invoice",
    }
  }
}
