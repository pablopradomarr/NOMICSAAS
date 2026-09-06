/**
 * E8 · T5 — Sellos de la capa de extracción
 * (`docs/design/E8-documentos-asientos.md` §3.2, disciplina de ADR-0011).
 *
 * Cuatro hashes, cuatro preguntas distintas:
 *
 * | Función | Sella | Para qué |
 * |---|---|---|
 * | `promptHash` | el prompt **EFECTIVO**, ya sustituido | I-E8-11: reproducir la extracción exige saber qué texto vio el modelo, no qué plantilla |
 * | `schemaHash` | el JSON-Schema que se le pidió | G-17: una salida sólo es válida contra el schema con el que se pidió |
 * | `proposalHash` | la propuesta normalizada | I-E8-6 / RC-16: dos ejecuciones deterministas dan el mismo sello, byte a byte |
 * | `promptContentHash` | el contenido de una `PromptVersion` | append-only: «editar» es insertar version+1, y el sello lo prueba |
 *
 * **Por qué el prompt efectivo y no la plantilla.** Una plantilla con
 * `{categories}` produce un prompt distinto en cada organización y en cada
 * momento. Sellar la plantilla diría que dos extracciones son comparables
 * cuando no lo son. El sha del texto ya sustituido es lo único que permite
 * afirmar, meses después, que dos runs vieron exactamente las mismas
 * instrucciones.
 *
 * **El sha256 del FICHERO no está aquí.** Opera sobre bytes en disco, o sea IO,
 * y vive en `lib/uploads.ts` (`sha256OfBuffer`). Este módulo es **PURO**:
 * `node:crypto` es determinista y sin IO, y aquí no hay `Date.now()`, ni
 * `Math.random()`, ni Prisma, ni red.
 *
 * Normalización previa, la misma disciplina que `lib/ledger/hash.ts` y
 * ADR-0011: **`LF`**, **sin espacios al final de línea**, **NFC**, y `sha256`
 * en hexadecimal minúscula sobre UTF-8.
 */

import { createHash } from "node:crypto"

import type { ExtractionProposal } from "@/lib/extraction/types"

const sha256Hex = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex")

/**
 * Normalización de TEXTO antes de sellarlo.
 *
 * Las tres reglas responden a las tres formas en que un mismo texto llega
 * distinto sin haber cambiado:
 *
 *  1. **`CRLF`/`CR` → `LF`.** Un prompt editado en Windows y otro en Linux son
 *     el mismo prompt; sellarlos distinto haría creer que el modelo vio otra
 *     cosa.
 *  2. **Sin espacios al final de línea.** Los editores los añaden y los quitan
 *     solos; no son instrucciones.
 *  3. **NFC.** «á» compuesta y «á» descompuesta son el mismo carácter para
 *     quien lee y dos secuencias de bytes distintas para `sha256`. En un
 *     producto en español eso no es un caso de laboratorio.
 *
 * El salto final se recorta para que «acabar en `\n`» no cambie el sello.
 */
export function normalizeText(input: string): string {
  return input
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "")
}

/**
 * Forma canónica de un valor JSON (ADR-0011 aplicado a la extracción):
 * **claves ordenadas**, **sin `undefined`**, strings en **NFC**, sin espacios
 * superfluos.
 *
 * Es lo que hace que `canonicalJson(reconcile(p, ctx))` sea idéntico byte a byte
 * entre ejecuciones y entre procesos (I-E8-6). Sin orden de claves, el mismo
 * objeto construido en distinto orden daría sellos distintos, y la
 * reproducibilidad —que es lo que se está prometiendo— sería falsa.
 *
 * Decisiones explícitas, para que nadie tenga que deducirlas leyendo el código:
 *
 *  - `undefined` **se omite** en objetos (como `JSON.stringify`) y se serializa
 *    como `null` dentro de arrays, donde omitirlo cambiaría las posiciones.
 *  - Un `number` no finito (`NaN`, `±Infinity`) **lanza**: un sello que
 *    convierte `NaN` en `null` en silencio esconde exactamente el fallo de
 *    cálculo que se quería detectar.
 *  - `bigint` se serializa como su decimal en texto (`JSON.stringify` lanza).
 *  - `Date` **lanza**: en esta capa las fechas son `LocalDate` ("YYYY-MM-DD").
 *    Un `Date` traería una zona horaria a un sello que debe ser un día natural.
 *  - Una referencia **cíclica** lanza en vez de colgarse.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set())
}

function serialize(value: unknown, seen: Set<object>): string {
  if (value === null) return "null"

  switch (typeof value) {
    case "string":
      return JSON.stringify(value.normalize("NFC"))
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: número no finito (${String(value)}); un sello no puede esconder un NaN`)
      }
      // -0 y 0 son el mismo importe: sellarlos distinto sería un falso positivo.
      return JSON.stringify(Object.is(value, -0) ? 0 : value)
    case "boolean":
      return value ? "true" : "false"
    case "bigint":
      return JSON.stringify(value.toString())
    case "undefined":
      return "null"
    case "function":
    case "symbol":
      throw new TypeError(`canonicalJson: ${typeof value} no es serializable`)
  }

  if (value instanceof Date) {
    throw new TypeError("canonicalJson: las fechas viajan como LocalDate (\"YYYY-MM-DD\"), no como Date")
  }

  const obj = value as object
  if (seen.has(obj)) throw new TypeError("canonicalJson: referencia cíclica")
  seen.add(obj)
  try {
    if (Array.isArray(value)) {
      // En un array la POSICIÓN es información: `undefined` no se omite.
      return `[${value.map((item) => serialize(item, seen)).join(",")}]`
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k.normalize("NFC"))}:${serialize(v, seen)}`).join(",")}}`
  } finally {
    seen.delete(obj)
  }
}

/** sha256 del prompt **efectivo** (ya sustituido), normalizado. I-E8-11. */
export function promptHash(renderedPrompt: string): string {
  return sha256Hex(normalizeText(renderedPrompt))
}

/** sha256 del JSON-Schema con el que se pidió la salida (G-17). */
export function schemaHash(schema: unknown): string {
  return sha256Hex(canonicalJson(schema))
}

/** sha256 de la propuesta NORMALIZADA — la que se contabiliza (RC-16, I-E8-6). */
export function proposalHash(proposal: ExtractionProposal): string {
  return sha256Hex(canonicalJson(proposal))
}

/** sha256 del contenido de una `PromptVersion` (append-only, G-10). */
export function promptContentHash(content: string): string {
  return sha256Hex(normalizeText(content))
}
