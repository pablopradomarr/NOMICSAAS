/**
 * E6 · T5 — Árbol de epígrafes de las cuentas anuales.
 *
 * El seed guarda el epígrafe como **ruta separada por ` / `**
 * («A) Activo no corriente / II. Inmovilizado material / 2. Instalaciones…»).
 * Este módulo la parte, la ordena por el ordinal oficial de cada segmento y
 * agrega los padres como SUMA de sus hijos.
 *
 * El orden **no es lexicográfico**: `X.` va después de `IX.` y `10.` después de
 * `9.`. Ordenar cadenas daría un modelo oficial mal numerado, que es de las
 * cosas que un asesor detecta en el primer vistazo.
 *
 * Módulo PURO.
 */

import type { Cents } from "@/lib/ledger/types"
import type { StatementRow } from "@/lib/ledger/reports/types"

export const EPIGRAPH_SEPARATOR = " / "

/** Parte la ruta en segmentos, sin espacios de sobra ni segmentos vacíos. */
export function splitEpigraph(path: string): string[] {
  return path
    .split(EPIGRAPH_SEPARATOR)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

const ROMAN: Readonly<Record<string, number>> = {
  I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6,
  VII: 7, VIII: 8, IX: 9, X: 10, XI: 11, XII: 12,
}

/** Familias de segmento, en el orden en que el modelo oficial las imprime. */
const FAMILY_LETTER = 0 // "A)", "A-1)", "B)", "C)"
const FAMILY_ROMAN = 1 // "I.", "IV.", "X."
const FAMILY_ARABIC = 2 // "1.", "10."
const FAMILY_ALPHA = 3 // "a)", "b)"
const FAMILY_NONE = 4 // sin prefijo reconocible

/** Sin prefijo → al final, pero de forma determinista. */
export const UNORDERED_SEGMENT = 9_999

/**
 * Ordinal del segmento: `"A)"`→1 · `"A-1)"`→1 (dentro de la familia A) ·
 * `"IV."`→4 · `"10."`→10 · `"b)"`→2 · sin prefijo → `UNORDERED_SEGMENT`.
 *
 * `segmentOrder` devuelve SÓLO el número; el desempate por familia y por texto
 * lo hace `segmentKey`, que es lo que se compara de verdad.
 */
export function segmentOrder(segment: string): number {
  const key = segmentKey(segment)
  return key.family === FAMILY_NONE ? UNORDERED_SEGMENT : key.index
}

export type SegmentKey = { family: number; index: number; text: string }

export function segmentKey(segment: string): SegmentKey {
  const s = segment.trim()

  // "A)" y "A-1)": la letra manda y el sufijo desempata dentro de ella, de modo
  // que "A) Patrimonio neto" precede a "A-1) Fondos propios" y ambos a "B)".
  const letter = /^([A-Z])(?:-(\d+))?\)/.exec(s)
  if (letter) {
    return { family: FAMILY_LETTER, index: (letter[1].charCodeAt(0) - 64) * 100 + Number(letter[2] ?? 0), text: s }
  }

  const roman = /^([IVX]+)\./.exec(s)
  if (roman && roman[1] in ROMAN) {
    return { family: FAMILY_ROMAN, index: ROMAN[roman[1]], text: s }
  }

  const arabic = /^(\d+)\./.exec(s)
  if (arabic) return { family: FAMILY_ARABIC, index: Number(arabic[1]), text: s }

  const alpha = /^([a-z])\)/.exec(s)
  if (alpha) return { family: FAMILY_ALPHA, index: alpha[1].charCodeAt(0) - 96, text: s }

  return { family: FAMILY_NONE, index: 0, text: s }
}

/** Compara dos rutas completas por el ordinal oficial de cada segmento. */
export function comparePaths(a: string, b: string): number {
  const ka = splitEpigraph(a).map(segmentKey)
  const kb = splitEpigraph(b).map(segmentKey)
  for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
    if (ka[i].family !== kb[i].family) return ka[i].family - kb[i].family
    if (ka[i].index !== kb[i].index) return ka[i].index - kb[i].index
    if (ka[i].text !== kb[i].text) return ka[i].text < kb[i].text ? -1 : 1
  }
  return ka.length - kb.length
}

export type EpigraphLeaf = {
  /** Ruta del epígrafe HOJA al que la cuenta aporta. */
  path: string
  cents: Cents
  accountCodes: readonly string[]
  isContraCell?: boolean
  isComputed?: boolean
}

export type BuildTreeOptions = {
  /** Comparativo por ruta hoja, ya agregado por el llamante. */
  previousByPath?: ReadonlyMap<string, Cents>
  /** Si `false`, el árbol se devuelve plano (el JSON del fixture es plano). */
  nested?: boolean
}

/**
 * Árbol de epígrafes: cada prefijo de la ruta se materializa como fila con la
 * **suma de sus hojas**, en orden oficial.
 *
 * **Los epígrafes vacíos no se imprimen**: sólo entra en el árbol lo que alguna
 * cuenta ha alimentado. Un modelo oficial con las veinte líneas a cero es ruido
 * en pantalla y en el PDF; el esqueleto completo lo aporta la PyG aparte
 * (`skeleton`), donde sí tiene sentido.
 */
export function buildEpigraphTree(leaves: readonly EpigraphLeaf[], opts: BuildTreeOptions = {}): StatementRow[] {
  const agg = new Map<string, Cents>()
  const codes = new Map<string, Set<string>>()
  const leafPaths = new Set<string>()
  const contra = new Map<string, boolean>()
  const computed = new Map<string, boolean>()

  for (const leaf of leaves) {
    const segments = splitEpigraph(leaf.path)
    if (segments.length === 0) continue
    const full = segments.join(EPIGRAPH_SEPARATOR)
    leafPaths.add(full)
    // Una celda sólo se marca `(−)` si TODAS las cuentas que la alimentan son
    // contra-cuentas: un epígrafe mixto no es una contra-partida.
    contra.set(full, (contra.get(full) ?? true) && leaf.isContraCell === true)
    computed.set(full, (computed.get(full) ?? false) || leaf.isComputed === true)
    for (let i = 1; i <= segments.length; i++) {
      const prefix = segments.slice(0, i).join(EPIGRAPH_SEPARATOR)
      agg.set(prefix, (agg.get(prefix) ?? 0) + leaf.cents)
      const set = codes.get(prefix) ?? new Set<string>()
      for (const code of leaf.accountCodes) set.add(code)
      codes.set(prefix, set)
    }
  }

  const previousAgg = new Map<string, Cents>()
  if (opts.previousByPath) {
    for (const [path, cents] of opts.previousByPath) {
      const segments = splitEpigraph(path)
      for (let i = 1; i <= segments.length; i++) {
        const prefix = segments.slice(0, i).join(EPIGRAPH_SEPARATOR)
        previousAgg.set(prefix, (previousAgg.get(prefix) ?? 0) + cents)
      }
    }
  }

  const rows: StatementRow[] = [...agg.keys()].sort(comparePaths).map((path) => {
    const segments = splitEpigraph(path)
    const cents = agg.get(path) ?? 0
    const row: StatementRow = {
      path,
      label: segments[segments.length - 1],
      depth: segments.length,
      order: segments.map((s) => segmentKey(s).index),
      cents,
      isLeaf: leafPaths.has(path),
      accountCodes: [...(codes.get(path) ?? new Set<string>())].sort(),
      isComputed: computed.get(path) === true,
      isContraCell: contra.get(path) === true,
    }
    if (opts.previousByPath) {
      const previous = previousAgg.get(path) ?? 0
      row.previousCents = previous
      row.deltaCents = cents - previous
      row.deltaBps = deltaBps(cents, previous)
    }
    return row
  })

  return opts.nested === true ? nest(rows) : rows
}

/**
 * Variación en puntos básicos, ENTERA. Con base 0 devuelve `null` — no
 * `Infinity`, no `NaN`, no un 100 % inventado (G-05: el panel heredado pintaba
 * `NaN%` y nadie lo veía porque el CSS lo tapaba).
 */
export function deltaBps(current: Cents, previous: Cents): number | null {
  if (previous === 0) return null
  // Aritmética entera: `Math.round` sobre una división de enteros es exacto
  // hasta 2^53, y los céntimos de una PYME no se acercan.
  return Math.round(((current - previous) * 10_000) / Math.abs(previous))
}

/** Convierte la lista plana en árbol colgando cada fila de su prefijo. */
export function nest(rows: readonly StatementRow[]): StatementRow[] {
  const byPath = new Map<string, StatementRow>()
  const roots: StatementRow[] = []
  for (const row of rows) {
    const copy: StatementRow = { ...row, children: [] }
    byPath.set(row.path, copy)
    const segments = splitEpigraph(row.path)
    const parentPath = segments.slice(0, -1).join(EPIGRAPH_SEPARATOR)
    const parent = parentPath ? byPath.get(parentPath) : undefined
    if (parent) parent.children!.push(copy)
    else roots.push(copy)
  }
  return roots
}
