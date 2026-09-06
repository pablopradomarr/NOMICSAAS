/**
 * E8 · T6 — Resolución y renderizado del prompt.
 *
 * `resolvePrompt` responde a «¿qué plantilla toca?» y `renderPrompt` a «¿qué
 * texto vio exactamente el modelo?». La segunda pregunta es la que sella
 * `ExtractionRun.promptSha`: una plantilla con `{tax_rates}` produce un prompt
 * distinto en cada organización y en cada momento, así que sellar la plantilla
 * afirmaría que dos extracciones son comparables cuando no lo son (I-E8-11).
 *
 * Precedencia: **override de la organización** (`PromptVersion`, append-only) →
 * **catálogo de git**. Nunca se lee de `Setting("prompt_analyse_new_file")`: ese
 * ajuste era texto libre editable sin versión ni sello, exactamente lo que G-10
 * cierra.
 */

import { latestPromptEntry, promptEntry, readPromptFile, type PromptCode } from "@/ai/prompts"
import type { TenantClient } from "@/lib/db"
import { promptContentHash, promptHash } from "@/lib/extraction/hash"
import { getActivePromptVersion } from "@/models/prompts"

export type PromptSourceKind = "GIT" | "ORG"

export type ResolvedPrompt = {
  code: PromptCode
  /** Plantilla SIN sustituir. */
  content: string
  /** `promptContentHash` de la plantilla (no del prompt efectivo). */
  sha: string
  source: PromptSourceKind
  /** Id de `PromptVersion` cuando `source === "ORG"`. */
  versionId: string | null
  version: number
}

/**
 * @returns la plantilla vigente para `code` en esta organización.
 * @remarks IO: lee `PromptVersion` y `Setting`. La lectura del `.md` es de git.
 */
export async function resolvePrompt(db: TenantClient, code: PromptCode = "extraction"): Promise<ResolvedPrompt> {
  const active = await getActivePromptVersion(db, code)
  if (active) {
    return {
      code,
      content: active.content,
      sha: active.sha256,
      source: "ORG",
      versionId: active.id,
      version: active.version,
    }
  }

  const entry = latestPromptEntry(code)
  const content = readPromptFile(entry)
  return { code, content, sha: promptContentHash(content), source: "GIT", versionId: null, version: entry.version }
}

/** Igual que `resolvePrompt` pero forzando una versión concreta del catálogo. */
export function gitPrompt(code: PromptCode, version: number): ResolvedPrompt {
  const entry = promptEntry(code, version)
  const content = readPromptFile(entry)
  return { code, content, sha: promptContentHash(content), source: "GIT", versionId: null, version: entry.version }
}

export type PromptVariables = {
  /** Códigos de `TaxRate` vigentes, uno por línea. */
  taxRates: readonly { code: string; name: string }[]
  /** `Field` personalizados NO económicos, uno por línea. */
  fields: readonly { code: string; llm_prompt: string | null }[]
}

/**
 * Sustituye los marcadores y devuelve el texto EFECTIVO más su sello.
 *
 * Determinista por construcción: las listas se ordenan por código, de modo que
 * el mismo catálogo produce el mismo sello aunque la base devuelva las filas en
 * otro orden. Sin ese orden, `promptSha` cambiaría sin que cambiase nada y la
 * comparación entre runs de I-E8-11 sería ruido.
 */
export function renderPrompt(template: string, variables: PromptVariables): { text: string; sha: string } {
  const taxRates = [...variables.taxRates]
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map((rate) => `- ${rate.code}: ${rate.name}`)
    .join("\n")

  const fields = [...variables.fields]
    .filter((field) => field.llm_prompt)
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map((field) => `- ${field.code}: ${field.llm_prompt}`)
    .join("\n")

  const text = template
    .replaceAll("{tax_rates}", taxRates || "- (la organización no tiene tipos configurados)")
    .replaceAll("{fields}", fields || "- (ninguno)")

  return { text, sha: promptHash(text) }
}
