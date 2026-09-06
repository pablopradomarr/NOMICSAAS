/**
 * E8 · T6 — Catálogo de prompts versionados en git.
 *
 * Un prompt es **evidencia**, no configuración: `ExtractionRun.promptSha` sella
 * el texto EFECTIVO que vio el modelo (I-E8-11), y sin un catálogo con versión
 * y sello nadie puede decir, seis meses después, con qué instrucciones se
 * extrajo una factura.
 *
 * Tres reglas que el test de este fichero hace cumplir:
 *
 *  1. **El `.md` es la fuente.** El texto vive en `ai/prompts/<code>.v<N>.md`,
 *     se revisa en un diff como cualquier otro código y no se edita desde la UI.
 *  2. **Cambiar el texto exige subir la versión.** El catálogo declara el
 *     `sha256` de cada entrada; tocar el `.md` sin bump rompe la suite. Un
 *     prompt que cambia sin cambiar de nombre convierte en incomparables dos
 *     extracciones que se presentan como comparables.
 *  3. **Nada de campos vetados.** El prompt dice explícitamente qué NO produce
 *     el modelo (cuenta, dimensiones, deducibilidad, retención, calificación
 *     fiscal, fecha de recepción): ADR-0014 D4 y D11.
 *
 * El override por organización (`PromptVersion`, `models/prompts.ts`) es
 * append-only y se resuelve en `ai/prompt.ts`; este módulo sólo conoce git.
 */

import { readFileSync } from "node:fs"
import path from "node:path"

import { promptContentHash } from "@/lib/extraction/hash"

export type PromptCode = "extraction"

export type PromptCatalogEntry = {
  code: PromptCode
  /** Sube de uno en uno. **Cambiar el `.md` sin subirla rompe el test.** */
  version: number
  file: string
  /** `promptContentHash` del `.md` normalizado. Se congela aquí a propósito. */
  sha256: string
}

/**
 * Catálogo. **Append-only en la práctica**: para cambiar un prompt se añade
 * `extraction.v2.md`, se añade su entrada y se decide qué versión es la vigente
 * (`PROMPT_CATALOG` sirve la mayor, y una organización puede fijar otra).
 */
export const PROMPT_CATALOG: readonly PromptCatalogEntry[] = [
  {
    code: "extraction",
    version: 1,
    file: "extraction.v1.md",
    sha256: "943d81eb64b91537c60b28491a252485aa8f7e4b0be6b5d19e1502b3d6f7cc18",
  },
]

const PROMPTS_DIR = path.join(process.cwd(), "ai", "prompts")

const contentCache = new Map<string, string>()

/**
 * Lee el `.md` del catálogo. La caché es del **fichero de git**, que es
 * inmutable dentro de un despliegue; no es una caché de datos de negocio ni de
 * tasas: aquí memorizar no puede servir una cifra obsoleta.
 */
export function readPromptFile(entry: PromptCatalogEntry): string {
  const cached = contentCache.get(entry.file)
  if (cached !== undefined) return cached
  const content = readFileSync(path.join(PROMPTS_DIR, entry.file), "utf8")
  contentCache.set(entry.file, content)
  return content
}

export function latestPromptEntry(code: PromptCode): PromptCatalogEntry {
  const candidates = PROMPT_CATALOG.filter((entry) => entry.code === code)
  if (candidates.length === 0) throw new Error(`No hay prompt en el catálogo con código "${code}"`)
  return candidates.reduce((best, entry) => (entry.version > best.version ? entry : best))
}

export function promptEntry(code: PromptCode, version: number): PromptCatalogEntry {
  const entry = PROMPT_CATALOG.find((candidate) => candidate.code === code && candidate.version === version)
  if (!entry) throw new Error(`No hay prompt "${code}" versión ${version} en el catálogo`)
  return entry
}

/** Sello real del `.md` en disco. El test lo compara con el declarado. */
export function actualPromptSha(entry: PromptCatalogEntry): string {
  return promptContentHash(readPromptFile(entry))
}
