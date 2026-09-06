/**
 * E8 · T11 — Proveedores de LLM: cadena de intentos, tokens reales y validación
 * estricta de TODA salida.
 *
 * Tres huecos de TaxHacker que este fichero cierra:
 *
 *  · **G-09 — la cadena de fallback era invisible.** `requestLLM` probaba
 *    proveedor tras proveedor y sólo devolvía el último error; el run no sabía
 *    si la factura la había leído OpenAI a la primera o Mistral al tercer
 *    intento tras dos 429. Ahora cada intento deja `{provider, model, ok,
 *    errorCode, ms}` en `attempts[]`, que se persiste en el `ExtractionRun`.
 *  · **G-12 — los tokens eran una estimación.** Se usa `usage_metadata` del
 *    mensaje (entrada y salida por separado), que es lo que factura el
 *    proveedor, y el saldo se decrementa **por run creado**, no «si tokens > 0».
 *  · **G-17 — la salida de `openai_compatible` no se validaba.** La respuesta de
 *    un modelo es dato hostil. Ahora `parse` valida **todas** las salidas con
 *    zod estricto, y una salida no conforme es un **intento fallido** que pasa
 *    al siguiente proveedor, no una excepción que rompa el run.
 *
 * Los cuatro proveedores heredados —OpenAI, Google, Mistral y cualquiera
 * compatible con la API de OpenAI, incluido un modelo local— se conservan tal
 * cual: la paridad con TaxHacker en este punto es funcionalidad del producto.
 * Las credenciales siguen viniendo cifradas de `Setting` por organización
 * (`lib/encryption.ts`); aquí no se guarda ninguna clave ni ningún cuerpo de
 * respuesta, sólo códigos de error.
 */
import { ChatOpenAI } from "@langchain/openai"
import { ChatGoogleGenerativeAI } from "@langchain/google-genai"
import { ChatMistralAI } from "@langchain/mistralai"
import { BaseMessage, HumanMessage } from "@langchain/core/messages"
import type { AnalyzeAttachment } from "@/ai/attachments"

export type LLMProvider = "openai" | "google" | "mistral" | "openai_compatible"

export interface LLMConfig {
  provider: LLMProvider
  apiKey: string
  model: string
  baseUrl?: string
  maxConcurrency?: number
}

export interface LLMSettings {
  providers: LLMConfig[]
}

export type LLMParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

export interface LLMRequest<T = unknown> {
  prompt: string
  schema?: Record<string, unknown>
  attachments?: AnalyzeAttachment[]
  /**
   * Validación estricta de la salida (G-17). Si falla, el intento se da por
   * fallido y la cadena continúa: un proveedor que devuelve basura no debe
   * dejar el documento sin extraer si el siguiente sabe leerlo.
   */
  parse?: (raw: unknown) => LLMParseResult<T>
}

/** Un eslabón de la cadena de fallback. **Sin cuerpos de respuesta** (§10). */
export type LLMAttempt = {
  provider: LLMProvider
  model: string
  ok: boolean
  /** `HTTP_429`, `SCHEMA`, `NO_VISION`, `UNKNOWN`… Nunca el cuerpo del error. */
  errorCode?: string
  ms: number
}

export interface LLMResponse<T = unknown> {
  /** Salida CRUDA del proveedor, tal y como llegó. Es lo que se persiste. */
  output: Record<string, unknown>
  /** Salida ya validada por `parse`, si se pasó. */
  parsed?: T
  tokensIn?: number
  tokensOut?: number
  tokensUsed?: number
  provider: LLMProvider
  model: string
  attempts: LLMAttempt[]
  error?: string
}

type UsageMetadata = { input_tokens?: number; output_tokens?: number; total_tokens?: number }

/** Tokens REALES del proveedor (G-12). Sin `usage_metadata`, no se estima. */
function readUsage(raw: unknown): { tokensIn?: number; tokensOut?: number; tokensUsed?: number } {
  const usage = (raw as { usage_metadata?: UsageMetadata } | null)?.usage_metadata
  if (!usage) return {}
  const tokensIn = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined
  const tokensOut = typeof usage.output_tokens === "number" ? usage.output_tokens : undefined
  const tokensUsed =
    typeof usage.total_tokens === "number" ? usage.total_tokens : (tokensIn ?? 0) + (tokensOut ?? 0) || undefined
  return { tokensIn, tokensOut, tokensUsed }
}

/** Código corto y estable para `attempts[]`. Nunca el mensaje completo. */
export function errorCodeOf(status: number | undefined, detail: string): string {
  if (status) return `HTTP_${status}`
  if (/no está soportad|not supported|content\.type|image_url/i.test(detail)) return "NO_VISION"
  if (/timeout|ETIMEDOUT|ECONNRESET|fetch failed/i.test(detail)) return "NETWORK"
  return "UNKNOWN"
}

type LLMModel = ChatOpenAI | ChatGoogleGenerativeAI | ChatMistralAI

type MessageContent = Array<{ type: string; text?: string; image_url?: { url: string } }>

function extractErrorInfo(error: unknown): {
  message: string | undefined
  cause: unknown
  status: number | undefined
  errorBody: unknown
} {
  const obj = error as Record<string, unknown>
  const causeObj = obj?.cause as Record<string, unknown> | undefined
  return {
    message: typeof obj?.message === "string" ? obj.message : undefined,
    cause: obj?.cause,
    status: (obj?.status as number | undefined) ?? (causeObj?.status as number | undefined),
    errorBody: obj?.error,
  }
}

async function requestLLMUnified<T>(config: LLMConfig, req: LLMRequest<T>): Promise<LLMResponse<T>> {
  const base: Pick<LLMResponse<T>, "provider" | "model" | "attempts" | "output"> = {
    provider: config.provider,
    model: config.model,
    attempts: [],
    output: {},
  }

  try {
    const temperature = 0
    let model: LLMModel
    if (config.provider === "openai") {
      model = new ChatOpenAI({ apiKey: config.apiKey, model: config.model, temperature })
    } else if (config.provider === "google") {
      model = new ChatGoogleGenerativeAI({ apiKey: config.apiKey, model: config.model, temperature })
    } else if (config.provider === "mistral") {
      model = new ChatMistralAI({ apiKey: config.apiKey, model: config.model, temperature })
    } else if (config.provider === "openai_compatible") {
      model = new ChatOpenAI({
        apiKey: config.apiKey || "not-needed",
        model: config.model,
        temperature,
        configuration: { baseURL: config.baseUrl?.trim() },
      })
    } else {
      return { ...base, error: "Proveedor desconocido" }
    }

    const messageContent: MessageContent = [{ type: "text", text: req.prompt }]
    if (req.attachments && req.attachments.length > 0) {
      messageContent.push(
        ...req.attachments.map((att) => ({
          type: "image_url",
          image_url: { url: `data:${att.contentType};base64,${att.base64}` },
        }))
      )
    }
    const messages: BaseMessage[] = [new HumanMessage({ content: messageContent })]

    let response: Record<string, unknown>
    let usage: ReturnType<typeof readUsage> = {}

    if (config.provider === "openai_compatible") {
      const raw = await model.invoke(messages)
      usage = readUsage(raw)
      const rawContent = raw as { content: string | Array<{ text?: string }> }
      const text =
        typeof rawContent.content === "string"
          ? rawContent.content
          : Array.isArray(rawContent.content)
            ? rawContent.content.map((c: { text?: string }) => c.text || "").join("")
            : ""
      const cleaned = text.replace(/```(?:json)?\s*/g, "").trim()
      // Algunos modelos compatibles emiten caracteres de control crudos dentro
      // de los valores de cadena, que `JSON.parse` rechaza. Se sustituyen por
      // espacios (los espacios estructurales no se ven afectados).
      response = JSON.parse(cleaned.replace(/[\u0000-\u001F]/g, " ")) as Record<string, unknown>
    } else {
      const structuredModel = model.withStructuredOutput(req.schema!, { name: "extraction", includeRaw: true })
      const result = (await structuredModel.invoke(messages)) as { raw?: unknown; parsed?: unknown }
      usage = readUsage(result?.raw)
      response = (result?.parsed ?? {}) as Record<string, unknown>
    }

    // G-17: TODA salida pasa por zod estricto, `openai_compatible` incluido.
    if (req.parse) {
      const parsed = req.parse(response)
      if (!parsed.ok) {
        return { ...base, output: response, ...usage, error: `SCHEMA: ${parsed.error}` }
      }
      return { ...base, output: response, parsed: parsed.value, ...usage }
    }

    return { ...base, output: response, ...usage }
  } catch (error: unknown) {
    const info = extractErrorInfo(error)
    const causeMsg = info.cause instanceof Error ? info.cause.message : info.cause ? String(info.cause) : null
    const status = info.status ? ` (HTTP ${info.status})` : ""
    const detail = [
      info.message ?? `la petición a ${config.provider} falló`,
      causeMsg && causeMsg !== info.message ? `causa: ${causeMsg}` : null,
    ]
      .filter(Boolean)
      .join(" | ")

    console.error(`[${config.provider}] petición al LLM fallida${status}:`, {
      message: info.message,
      status: info.status,
    })

    const isVisionError =
      detail.includes("content.type") || (detail.includes("image_url") && detail.includes("not supported"))
    const visionHint = isVisionError
      ? " — este modelo no admite imágenes; use uno con visión o pruébelo en Ajustes."
      : ""
    const concurrencyHint =
      info.status === 429 && (config.maxConcurrency ?? 1) > 1
        ? " — límite de peticiones alcanzado; baje «Max concurrency» de este proveedor y reintente"
        : ""

    return { ...base, error: `${detail}${status}${concurrencyHint}${visionHint}` }
  }
}

export interface LLMTestResult {
  success: boolean
  supportsVision: boolean
  message: string
}

const TINY_TEST_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="

export async function testLLMProvider(config: LLMConfig): Promise<LLMTestResult> {
  try {
    const temperature = 0
    let model: LLMModel
    if (config.provider === "openai") {
      model = new ChatOpenAI({ apiKey: config.apiKey, model: config.model, temperature })
    } else if (config.provider === "google") {
      model = new ChatGoogleGenerativeAI({ apiKey: config.apiKey, model: config.model, temperature })
    } else if (config.provider === "mistral") {
      model = new ChatMistralAI({ apiKey: config.apiKey, model: config.model, temperature })
    } else if (config.provider === "openai_compatible") {
      model = new ChatOpenAI({
        apiKey: config.apiKey || "not-needed",
        model: config.model,
        temperature,
        configuration: { baseURL: config.baseUrl?.trim() },
      })
    } else {
      return { success: false, supportsVision: false, message: `Unknown provider: ${config.provider}` }
    }

    const messages: BaseMessage[] = [
      new HumanMessage({
        content: [
          { type: "text", text: "Reply with the single word: ok" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${TINY_TEST_IMAGE_BASE64}` } },
        ],
      }),
    ]

    const raw = await model.invoke(messages)
    const rawContent = raw as { content: string | Array<{ text?: string }> }
    const text =
      typeof rawContent.content === "string"
        ? rawContent.content
        : Array.isArray(rawContent.content)
          ? rawContent.content.map((c: { text?: string }) => c.text || "").join("")
          : ""

    return {
      success: true,
      supportsVision: true,
      message: `Model responded: "${text.trim().slice(0, 100)}"`,
    }
  } catch (error: unknown) {
    const causeMsg =
      error instanceof Error && error.cause instanceof Error
        ? error.cause.message
        : (error as Record<string, unknown>)?.cause
          ? String((error as Record<string, unknown>).cause)
          : null
    const errorMsg = error instanceof Error ? error.message : String(error)
    const combined = [errorMsg, causeMsg].filter(Boolean).join(" | ")

    const isVisionRejection =
      combined.includes("content.type") ||
      combined.includes("image_url") ||
      (combined.includes("image") && combined.includes("not supported"))

    if (isVisionRejection) {
      return {
        success: false,
        supportsVision: false,
        message: "This model does not support image input. Invoice analysis requires a vision-capable model.",
      }
    }

    return {
      success: false,
      supportsVision: false,
      message: `Connection failed: ${combined}`,
    }
  }
}

/**
 * Recorre la cadena de proveedores y devuelve la PRIMERA salida válida, dejando
 * constancia de cada intento (G-09).
 *
 * Un proveedor sin modelo o sin credenciales no cuenta como intento: no se
 * llamó a nadie. Lo que sí cuenta —y por eso está en `attempts[]`— es el 429
 * que obligó a bajar al segundo proveedor y la salida que no pasó el esquema.
 */
export async function requestLLM<T>(settings: LLMSettings, req: LLMRequest<T>): Promise<LLMResponse<T>> {
  const attempts: LLMAttempt[] = []
  let lastError = "Ningún proveedor de LLM está configurado o todos han fallado"
  let lastProvider: LLMProvider = settings.providers[0]?.provider ?? "openai"
  let lastModel = settings.providers[0]?.model ?? ""

  for (const config of settings.providers) {
    if (!config.model) continue
    if (config.provider === "openai_compatible" ? !config.baseUrl : !config.apiKey) continue

    lastProvider = config.provider
    lastModel = config.model

    const startedAt = Date.now()
    const response = await requestLLMUnified(config, req)
    const ms = Date.now() - startedAt

    if (!response.error) {
      attempts.push({ provider: config.provider, model: config.model, ok: true, ms })
      return { ...response, attempts }
    }

    const errorCode = response.error.startsWith("SCHEMA:")
      ? "SCHEMA"
      : errorCodeOf(/\(HTTP (\d{3})\)/.exec(response.error)?.[1] ? Number(/\(HTTP (\d{3})\)/.exec(response.error)![1]) : undefined, response.error)
    attempts.push({ provider: config.provider, model: config.model, ok: false, errorCode, ms })
    lastError = response.error
  }

  return { output: {}, provider: lastProvider, model: lastModel, attempts, error: lastError }
}
