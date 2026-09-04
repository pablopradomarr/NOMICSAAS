import { analyzeTransaction, AnalysisResult } from "@/ai/analyze"
import { loadAttachmentsForAI } from "@/ai/attachments"
import { buildLLMPrompt } from "@/ai/prompt"
import { fieldsToJsonSchema } from "@/ai/schema"
import { ActionState } from "@/lib/actions"
import { isAiBalanceExhausted, isSubscriptionExpired } from "@/lib/auth"
import { requireOrg } from "@/lib/authz"
import { DEFAULT_PROMPT_ANALYSE_NEW_FILE } from "@/models/defaults"
import { getFileById } from "@/models/files"
import { getCategories } from "@/models/categories"
import { getFields } from "@/models/fields"
import { updateOrganization } from "@/models/organizations"
import { getProjects } from "@/models/projects"
import { getSettings } from "@/models/settings"
import { NextRequest, NextResponse } from "next/server"

export async function POST(request: NextRequest) {
  // Analizar con IA consume saldo de la organización y escribe en el fichero → EDITOR
  const { db, org } = await requireOrg("EDITOR")

  let fileId: unknown
  try {
    const body = await request.json()
    fileId = body?.fileId
  } catch {
    return NextResponse.json<ActionState<AnalysisResult>>(
      { success: false, error: "Invalid request body" },
      { status: 400 }
    )
  }

  if (typeof fileId !== "string" || fileId.length === 0) {
    return NextResponse.json<ActionState<AnalysisResult>>(
      { success: false, error: "fileId is required" },
      { status: 400 }
    )
  }

  const file = await getFileById(db, fileId)
  if (!file) {
    return NextResponse.json<ActionState<AnalysisResult>>(
      { success: false, error: "File not found or does not belong to the organization" },
      { status: 404 }
    )
  }

  if (isAiBalanceExhausted(org)) {
    return NextResponse.json<ActionState<AnalysisResult>>(
      {
        success: false,
        error: "You used all of your pre-paid AI scans, please upgrade your account or buy new subscription plan",
      },
      { status: 402 }
    )
  }

  if (isSubscriptionExpired(org)) {
    return NextResponse.json<ActionState<AnalysisResult>>(
      {
        success: false,
        error: "Your subscription has expired, please upgrade your account or buy new subscription plan",
      },
      { status: 402 }
    )
  }

  let attachments
  try {
    attachments = await loadAttachmentsForAI(db, org, file)
  } catch (error) {
    console.error("Failed to retrieve files:", error)
    return NextResponse.json<ActionState<AnalysisResult>>(
      { success: false, error: "Failed to retrieve files: " + error },
      { status: 500 }
    )
  }

  const settings = await getSettings(db)
  const fields = await getFields(db)
  const categories = await getCategories(db)
  const projects = await getProjects(db)

  const prompt = buildLLMPrompt(
    settings.prompt_analyse_new_file || DEFAULT_PROMPT_ANALYSE_NEW_FILE,
    fields,
    categories,
    projects
  )

  const schema = fieldsToJsonSchema(fields)

  const results = await analyzeTransaction(db, prompt, schema, attachments, file.id)

  if (results.data?.tokensUsed && results.data.tokensUsed > 0) {
    await updateOrganization(org.id, { aiBalance: { decrement: 1 } })
  }

  const isRateLimited = !results.success && /\(HTTP 429\)/.test(results.error || "")
  return NextResponse.json(results, { status: isRateLimited ? 429 : 200 })
}
