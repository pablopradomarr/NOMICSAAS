/**
 * E8 · T11 — `runExtraction`: una extracción es **un `ExtractionRun` inmutable**.
 *
 * Lo que había: `analyzeTransaction` llamaba al modelo, devolvía un mapa de
 * strings y lo guardaba en `File.cachedParseResult`, una columna mutable sin
 * proveedor, sin modelo, sin sha del prompt, sin páginas vistas y sin usuario.
 * Con eso no se puede responder a la única pregunta que importa en una
 * auditoría —«¿de dónde salió esta cifra?»—, y la columna era además una
 * memoria de cifras que sobrevivía a cambios de prompt (G-03).
 *
 * Lo que hay: un `INSERT` en `extraction_runs`, tabla **append-only** (el
 * `UPDATE` da 42501 incluso para el propietario), con todo lo que hace
 * reproducible la extracción:
 *
 *  · proveedor, modelo y `attempts[]` con la cadena de fallback (G-09)
 *  · `promptSha` del prompt **EFECTIVO** y `schemaSha` del esquema pedido (I-E8-11, G-17)
 *  · `pagesSent` / `pagesTotal` → `partial` lo escribe un trigger (G-02)
 *  · salida cruda **tal cual llegó**, y aparte la propuesta normalizada
 *  · tokens de `usage_metadata`, duración y git-sha (G-12)
 *  · `fileSha256` **releído del disco**: si el fichero cambió, no hay extracción
 *
 * Y una cosa que NO hace: calcular. El run guarda lo que el modelo dijo y lo que
 * `reconcile` (T7) opinó; ninguna cifra contable sale de aquí. La deducción de
 * saldo ocurre **por run creado** y sólo tras un `INSERT` con éxito.
 */

import "server-only"

import { loadAttachmentsForAI } from "@/ai/attachments"
import { renderPrompt, resolvePrompt } from "@/ai/prompt"
import type { PromptCode } from "@/ai/prompts"
import { normalizeExtractionOutput } from "@/ai/normalize"
import {
  EXTRACTION_SCHEMA_V1,
  EXTRACTION_SCHEMA_VERSION,
  extractionSchemaSha,
  parseExtractionOutput,
  type ExtractionOutput,
} from "@/ai/schema"
import { requestLLM, type LLMAttempt } from "@/ai/providers/llmProvider"
import type { TenantClient } from "@/lib/db"
import { fullPathForFile } from "@/lib/files"
import { proposalHash } from "@/lib/extraction/hash"
import type { ExtractionProposal, FieldOrigins } from "@/lib/extraction/types"
import { sha256OfBuffer } from "@/lib/uploads"
import { getFields } from "@/models/fields"
import { currentGitSha } from "@/models/reports"
import { getLLMSettings, getSettings } from "@/models/settings"
import { listTaxRates } from "@/models/tax-rates"
import type { ExtractionRun, File, Organization, Prisma } from "@/prisma/client"
import fs from "fs/promises"

/** Fallo de extracción. Lleva la cadena de intentos: sin ella nadie sabe por qué. */
export class ExtractionFailedError extends Error {
  readonly attempts: readonly LLMAttempt[]

  constructor(message: string, attempts: readonly LLMAttempt[]) {
    super(message)
    this.name = "ExtractionFailedError"
    this.attempts = attempts
  }
}

/** El documento en disco ya no es el que se ingirió (RC-10, `DOCUMENTO_ALTERADO`). */
export class DocumentAlteredError extends Error {
  constructor(expected: string, actual: string) {
    super(
      `El fichero en disco no coincide con el sha256 registrado (esperado ${expected.slice(0, 12)}…, ` +
        `encontrado ${actual.slice(0, 12)}…). No se extrae de un documento alterado.`
    )
    this.name = "DocumentAlteredError"
  }
}

/**
 * Recálculo determinista de la propuesta. Lo inyecta el llamante —hoy T7, que
 * escribe `lib/extraction/reconcile.ts`— para que `ai/` no dependa del motor de
 * validación: aquí se sabe **pedir** una extracción, no juzgarla.
 */
export type ReconcileOutcome = {
  status: "PASS" | "WARN" | "FAIL"
  detail: unknown
  proposal?: ExtractionProposal
  fieldOrigins?: FieldOrigins
}

/**
 * T13 la cablea con `reconcile()` y su contexto, y ese contexto se LEE de la
 * base (plan, tipos vigentes, ficha de la contraparte, tasa del día): por eso
 * admite una promesa. Mantenerla síncrona habría obligado a adivinar el
 * contexto antes de conocer la moneda y la contraparte del documento.
 */
export type ReconcileFn = (
  proposal: ExtractionProposal,
  fieldOrigins: FieldOrigins,
  /** El documento y su extracción, para que el lote pueda cablear un contexto
   *  distinto por fichero con una sola función (T13). */
  context: { file: File; fileSha256: string; pagesSent: number; pagesTotal: number }
) => ReconcileOutcome | Promise<ReconcileOutcome>

export type RunExtractionOptions = {
  promptCode?: PromptCode
  /** Fecha de recepción (origen `usuario`). Default: la fecha de subida. */
  receptionDate?: string | null
  reconcile?: ReconcileFn
  /** Reloj inyectable: mide duración sin atarse a `Date.now()` en los tests. */
  clock?: () => number
}

export type ExtractionActor = { id: string | null }

/**
 * Ejecuta una extracción y **persiste su evidencia**.
 *
 * @returns el `ExtractionRun` recién insertado. Inmutable desde ese instante.
 * @throws DocumentAlteredError si el fichero en disco no es el registrado.
 * @throws ExtractionFailedError si ningún proveedor devolvió una salida válida.
 */
export async function runExtraction(
  db: TenantClient,
  organization: Organization,
  file: File,
  actor: ExtractionActor,
  options: RunExtractionOptions = {}
): Promise<ExtractionRun> {
  const clock = options.clock ?? Date.now
  const startedAt = clock()
  const promptCode: PromptCode = options.promptCode ?? "extraction"

  // 1 — El documento tiene que ser EL documento (RC-10, I-E8-9).
  const fileSha256 = await verifyFileSha(organization, file)

  // 2 — Adjuntos y páginas vistas de las totales (G-02).
  const { attachments, pagesSent, pagesTotal } = await loadAttachmentsForAI(db, organization, file)

  // 3 — Prompt efectivo y esquema, con sus sellos.
  const [settings, fields, taxRates, resolved] = await Promise.all([
    getSettings(db),
    getFields(db),
    listTaxRates(db),
    resolvePrompt(db, promptCode),
  ])
  const rendered = renderPrompt(resolved.content, {
    taxRates: taxRates.filter((rate) => rate.isActive).map((rate) => ({ code: rate.code, name: rate.name })),
    fields: fields.map((field) => ({ code: field.code, llm_prompt: field.llm_prompt })),
  })
  const schemaSha = extractionSchemaSha()

  // 4 — Llamada, con validación estricta de TODA salida (G-17).
  const response = await requestLLM<ExtractionOutput>(getLLMSettings(settings), {
    prompt: rendered.text,
    schema: EXTRACTION_SCHEMA_V1 as Record<string, unknown>,
    attachments,
    parse: parseExtractionOutput,
  })

  if (response.error || !response.parsed) {
    throw new ExtractionFailedError(response.error ?? "El proveedor no devolvió una salida utilizable", response.attempts)
  }

  // 5 — Normalización a los tipos del dominio. Sin calificar nada.
  const { proposal, fieldOrigins } = normalizeExtractionOutput(response.parsed, {
    defaultCurrency: settings.default_currency || "EUR",
    receptionDate: options.receptionDate ?? toLocalDate(file.createdAt),
  })

  // 6 — Recálculo determinista, si el llamante lo aporta (T7).
  const reconciled = await options.reconcile?.(proposal, fieldOrigins, { file, fileSha256, pagesSent, pagesTotal })
  const finalProposal = reconciled?.proposal ?? proposal
  const finalOrigins = reconciled?.fieldOrigins ?? fieldOrigins

  const durationMs = Math.max(0, clock() - startedAt)

  // 7 — INSERT. A partir de aquí la evidencia es inmutable.
  const run = await db.extractionRun.create({
    data: {
      organizationId: db.$organizationId,
      fileId: file.id,
      fileSha256,
      kind: "LLM",
      provider: response.provider,
      model: response.model,
      temperatureBps: 0,
      attempts: response.attempts as unknown as Prisma.InputJsonValue,
      promptCode,
      promptSource: resolved.source,
      promptVersionId: resolved.versionId,
      promptSha: rendered.sha,
      schemaVersion: EXTRACTION_SCHEMA_VERSION,
      schemaSha,
      pagesSent,
      pagesTotal,
      rawOutput: response.output as Prisma.InputJsonValue,
      proposal: finalProposal as unknown as Prisma.InputJsonValue,
      proposalSha: proposalHash(finalProposal),
      fieldOrigins: finalOrigins as unknown as Prisma.InputJsonValue,
      reconcile: (reconciled?.detail ?? null) as Prisma.InputJsonValue,
      reconcileStatus: reconciled?.status ?? null,
      tokensIn: response.tokensIn ?? null,
      tokensOut: response.tokensOut ?? null,
      durationMs,
      gitSha: currentGitSha(),
      createdById: actor.id,
    },
  })

  return run
}

/** Relee los bytes y los sella. Una vez por run, como manda §9. */
async function verifyFileSha(organization: Organization, file: File): Promise<string> {
  const buffer = await fs.readFile(fullPathForFile(organization, file))
  const actual = sha256OfBuffer(buffer)
  if (file.sha256 && file.sha256 !== actual) {
    throw new DocumentAlteredError(file.sha256, actual)
  }
  return actual
}

const toLocalDate = (value: Date): string => value.toISOString().slice(0, 10)
