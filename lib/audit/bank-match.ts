/**
 * E7 · T8 — Sugerencias de conciliación **deterministas, jamás LLM**
 * (`docs/design/E7-auditoria.md` §3.4).
 *
 * Las siete reglas, en este orden y sin excepciones:
 *
 * 1. **El importe coincide al céntimo**, con signo y en la divisa de la cuenta.
 *    Sin importe exacto no hay candidato: no existe «casi». En un candidato
 *    N-a-1 la igualdad es la del **grupo** (Σ = Σ), que es I-E7-11.
 * 2. La distancia se mide sobre **`operationDate`** (O-6), nunca sobre la fecha
 *    valor: cortar por fecha valor mueve movimientos a través del cierre.
 * 3. Puntuación **entera y reproducible**: `10000` importe exacto · `+2000` misma
 *    `operationDate` (`1000 − 200·días` si no) · `+500` si lo que casa es la
 *    fecha valor —información útil que no debe decidir— · `+2500` `reference1`
 *    por contención exacta tras normalizar · `+1000` `reference2` · `+1500` misma
 *    contraparte. Nada de distancias difusas ni de similitud textual (P1, P7).
 * 4. **Agrupación N-a-1 por `reference1`** (O-15). Sin `reference1`, no se ofrece.
 * 5. **Empate ⇒ ninguna sugerencia**: la línea sale con los candidatos empatados
 *    y elige una persona. Un desempate automático es donde se cuela el error.
 * 6. Asignación por **pasadas deterministas**: primero únicos y mutuos, luego
 *    `(scoreBps desc, operationDate asc, id asc)`. Dos ejecuciones sobre el mismo
 *    estado producen la misma lista byte a byte.
 * 7. Un candidato ya conciliado no vuelve a proponerse.
 *
 * Rendimiento (§8): índices por importe con signo y por `reference1`; **nunca**
 * un producto cartesiano. 5 000 × 5 000 por debajo de 700 ms.
 *
 * Módulo PURO.
 */

import { normalizeText } from "@/lib/bank/hash"
import {
  daysBetween,
  signedAmountOf,
  type BankLineRef,
  type Cents,
  type LedgerCashLineRef,
  type MatchGroupKind,
} from "@/lib/bank/types"

export type MatchReason =
  | "IMPORTE_EXACTO"
  | "MISMA_FECHA_OPERACION"
  | "FECHA_EN_TOLERANCIA"
  | "FECHA_VALOR"
  | "REFERENCIA_1"
  | "REFERENCIA_2"
  | "CONTRAPARTE"

export type MatchCandidate = {
  journalLineIds: readonly string[]
  scoreBps: number
  kind: MatchGroupKind
  reasons: readonly MatchReason[]
  /** Desfase en días entre `operationDate` y `entryDate`; se sella al puntear. */
  dateGapDays: number
}

export type SuggestConfig = {
  /** De la cuenta bancaria. Configuración, nunca invariante (O-10). */
  toleranceDays: number
}

/** Puntuaciones. Constantes con nombre: una puntuación mágica no se audita. */
export const SCORE = {
  EXACT_AMOUNT: 10000,
  SAME_OPERATION_DATE: 2000,
  DATE_BASE: 1000,
  DATE_PENALTY_PER_DAY: 200,
  VALUE_DATE: 500,
  REFERENCE_1: 2500,
  REFERENCE_2: 1000,
  COUNTERPARTY: 1500,
} as const

const isSuggestable = (line: BankLineRef): boolean => line.status === "UNMATCHED"

const dateScore = (gap: number): number =>
  gap === 0 ? SCORE.SAME_OPERATION_DATE : Math.max(0, SCORE.DATE_BASE - SCORE.DATE_PENALTY_PER_DAY * Math.abs(gap))

const referenceMatches = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const left = normalizeText(a)
  const right = normalizeText(b)
  if (left === "" || right === "") return false
  return right.includes(left) || left.includes(right)
}

function scoreOf(
  line: BankLineRef,
  cash: LedgerCashLineRef,
  config: SuggestConfig
): { score: number; reasons: MatchReason[]; gap: number } | null {
  const gap = daysBetween(cash.entryDate, line.operationDate)
  const valueGap = daysBetween(cash.entryDate, line.valueDate)
  const withinOperation = Math.abs(gap) <= config.toleranceDays
  const withinValue = valueGap === 0
  if (!withinOperation && !withinValue) return null

  const reasons: MatchReason[] = ["IMPORTE_EXACTO"]
  let score = SCORE.EXACT_AMOUNT
  if (withinOperation) {
    score += dateScore(gap)
    reasons.push(gap === 0 ? "MISMA_FECHA_OPERACION" : "FECHA_EN_TOLERANCIA")
  }
  // La fecha valor informa y **no decide** (criterio 22): sólo suma cuando ES lo
  // que casa —la fecha de operación no coincide— y siempre menos que ella.
  if (withinValue && gap !== 0) {
    score += SCORE.VALUE_DATE
    reasons.push("FECHA_VALOR")
  }
  if (referenceMatches(line.reference1, cash.reference)) {
    score += SCORE.REFERENCE_1
    reasons.push("REFERENCIA_1")
  }
  if (referenceMatches(line.reference2, cash.reference)) {
    score += SCORE.REFERENCE_2
    reasons.push("REFERENCIA_2")
  }
  if (
    line.counterpartyName !== null &&
    line.counterpartyName !== undefined &&
    normalizeText(line.counterpartyName) !== "" &&
    normalizeText(line.counterpartyName) === normalizeText(cash.counterpartyName)
  ) {
    score += SCORE.COUNTERPARTY
    reasons.push("CONTRAPARTE")
  }
  return { score, reasons, gap }
}

type Scored = { candidate: MatchCandidate; line: BankLineRef }

/**
 * Candidatos de UNA línea, ya ordenados por `(scoreBps desc, id asc)`. Incluye
 * los simples (1:1) y, cuando hay `reference1`, el grupo N-a-1 que cuadra.
 */
export function candidatesFor(
  line: BankLineRef,
  index: MatchIndex,
  config: SuggestConfig
): readonly MatchCandidate[] {
  if (!isSuggestable(line)) return []
  const out: MatchCandidate[] = []

  for (const cash of index.byAmount.get(line.amountCents) ?? []) {
    if (index.matchedCash.has(cash.id)) continue
    const scored = scoreOf(line, cash, config)
    if (scored === null) continue
    out.push({
      journalLineIds: [cash.id],
      scoreBps: scored.score,
      kind: "SIMPLE",
      reasons: scored.reasons,
      dateGapDays: Math.abs(scored.gap),
    })
  }

  // **Agrupación N-a-1 por `reference1`** (regla 4). Sin referencia de remesa no
  // se ofrece: no hay ninguna clave determinista con la que agrupar.
  const reference = normalizeText(line.reference1)
  if (reference !== "") {
    const group = (index.byReference.get(reference) ?? []).filter((c) => !index.matchedCash.has(c.id))
    if (group.length > 1) {
      const total = group.reduce((acc, c) => acc + signedAmountOf(c), 0)
      if (total === line.amountCents) {
        const gaps = group.map((c) => Math.abs(daysBetween(c.entryDate, line.operationDate)))
        const maxGap = Math.max(...gaps)
        const reasons: MatchReason[] = ["IMPORTE_EXACTO", "REFERENCIA_1"]
        let score = SCORE.EXACT_AMOUNT + SCORE.REFERENCE_1 + dateScore(maxGap === 0 ? 0 : maxGap)
        if (maxGap === 0) reasons.push("MISMA_FECHA_OPERACION")
        else if (maxGap <= config.toleranceDays) reasons.push("FECHA_EN_TOLERANCIA")
        else score = SCORE.EXACT_AMOUNT + SCORE.REFERENCE_1
        out.push({
          journalLineIds: [...group.map((c) => c.id)].sort(),
          scoreBps: score,
          kind: "N_A_1",
          reasons,
          dateGapDays: maxGap,
        })
      }
    }
  }

  return out.sort(
    (a, b) =>
      b.scoreBps - a.scoreBps ||
      (a.journalLineIds.join(",") < b.journalLineIds.join(",") ? -1 : a.journalLineIds.join(",") > b.journalLineIds.join(",") ? 1 : 0)
  )
}

export type MatchIndex = {
  byAmount: ReadonlyMap<Cents, readonly LedgerCashLineRef[]>
  byReference: ReadonlyMap<string, readonly LedgerCashLineRef[]>
  matchedCash: ReadonlySet<string>
}

/**
 * Índices en memoria: por importe con signo y por referencia normalizada. Es lo
 * que evita el producto cartesiano de 25 millones de pares del techo de §8.
 */
export function buildMatchIndex(
  ledger: readonly LedgerCashLineRef[],
  matchedCashIds: ReadonlySet<string> = new Set()
): MatchIndex {
  const byAmount = new Map<Cents, LedgerCashLineRef[]>()
  const byReference = new Map<string, LedgerCashLineRef[]>()
  for (const cash of ledger) {
    if (matchedCashIds.has(cash.id)) continue
    const amount = signedAmountOf(cash)
    const bucket = byAmount.get(amount)
    if (bucket === undefined) byAmount.set(amount, [cash])
    else bucket.push(cash)
    const reference = normalizeText(cash.reference)
    if (reference !== "") {
      const refBucket = byReference.get(reference)
      if (refBucket === undefined) byReference.set(reference, [cash])
      else refBucket.push(cash)
    }
  }
  // Orden estable dentro de cada cubo: la salida no puede depender del orden de
  // lectura de la base (P7).
  for (const bucket of byAmount.values()) bucket.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const bucket of byReference.values()) bucket.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { byAmount, byReference, matchedCash: matchedCashIds }
}

/**
 * Sugerencias por línea de extracto.
 *
 * - **una** entrada con **un** candidato = sugerencia;
 * - una entrada con **dos o más** = línea **ambigua**, sin sugerencia: los
 *   candidatos se enseñan y elige una persona (regla 5);
 * - línea ausente del mapa = no hay candidato.
 */
export function suggestMatches(
  lines: readonly BankLineRef[],
  ledger: readonly LedgerCashLineRef[],
  config: SuggestConfig,
  matchedCashIds: ReadonlySet<string> = new Set()
): ReadonlyMap<string, readonly MatchCandidate[]> {
  const index = buildMatchIndex(ledger, matchedCashIds)
  const suggestable = [...lines]
    .filter(isSuggestable)
    .sort((a, b) =>
      a.operationDate < b.operationDate ? -1 : a.operationDate > b.operationDate ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    )

  const scored = new Map<string, readonly MatchCandidate[]>()
  for (const line of suggestable) {
    const candidates = candidatesFor(line, index, config)
    if (candidates.length > 0) scored.set(line.id, candidates)
  }

  // ── Pasada 1: únicos y mutuos ──────────────────────────────────────────────
  // Un candidato único de la línea que además sólo es candidato de esa línea.
  const claims = new Map<string, string[]>() // journalLineIds.join → lineIds
  for (const [lineId, candidates] of scored) {
    for (const candidate of candidates) {
      const key = candidate.journalLineIds.join(",")
      claims.set(key, [...(claims.get(key) ?? []), lineId])
    }
  }

  const takenCash = new Set<string>()
  const result = new Map<string, readonly MatchCandidate[]>()
  const pending: Scored[] = []

  for (const line of suggestable) {
    const candidates = scored.get(line.id)
    if (candidates === undefined) continue
    const top = candidates[0] as MatchCandidate
    const tied = candidates.filter((c) => c.scoreBps === top.scoreBps)
    if (tied.length > 1) {
      // Empate ⇒ ninguna sugerencia: se listan los empatados y decide una persona.
      result.set(line.id, tied)
      continue
    }
    const claimants = claims.get(top.journalLineIds.join(",")) ?? []
    if (candidates.length === 1 && claimants.length === 1) {
      result.set(line.id, [top])
      for (const id of top.journalLineIds) takenCash.add(id)
      continue
    }
    pending.push({ candidate: top, line })
  }

  // ── Pasada 2: (scoreBps desc, operationDate asc, id asc) ───────────────────
  pending.sort(
    (a, b) =>
      b.candidate.scoreBps - a.candidate.scoreBps ||
      (a.line.operationDate < b.line.operationDate ? -1 : a.line.operationDate > b.line.operationDate ? 1 : 0) ||
      (a.line.id < b.line.id ? -1 : a.line.id > b.line.id ? 1 : 0)
  )
  for (const { line } of pending) {
    const candidates = (scored.get(line.id) ?? []).filter((c) => c.journalLineIds.every((id) => !takenCash.has(id)))
    if (candidates.length === 0) continue
    const top = candidates[0] as MatchCandidate
    const tied = candidates.filter((c) => c.scoreBps === top.scoreBps)
    if (tied.length > 1) {
      result.set(line.id, tied)
      continue
    }
    result.set(line.id, [top])
    for (const id of top.journalLineIds) takenCash.add(id)
  }

  // Orden de iteración estable: el mapa se recorre por id de línea.
  return new Map([...result.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

export type MatchSuggestionRow = {
  statementLineId: string
  ambiguous: boolean
  candidates: readonly MatchCandidate[]
}

/** La misma información en forma de lista, que es como la pinta la pantalla. */
export function suggestionRows(
  suggestions: ReadonlyMap<string, readonly MatchCandidate[]>
): readonly MatchSuggestionRow[] {
  return [...suggestions.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([statementLineId, candidates]) => ({
      statementLineId,
      ambiguous: candidates.length > 1,
      candidates,
    }))
}
