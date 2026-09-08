/**
 * E9 · T5 — Calendario de las reglas recurrentes (`lib/recurring/schedule.ts`).
 *
 * Implementa **R-REC-1…8** de `docs/design/E9-cierre-recurrentes.md` §4.1 y las
 * decisiones **D2.3 / D3.2** de ADR-0016 (cuota cero).
 *
 * Módulo **PURO** (guard de pureza, ESLint y CI): sin `Date.now()`, sin `new
 * Date()` sin argumento, sin Prisma, sin IO y sin LLM. **Toda fecha entra por
 * parámetro** (`refDate` del `LedgerContext`).
 *
 * ## Qué es un periodo aquí
 *
 * Un periodo es una **clave textual** (`PeriodKey`), no un intervalo de fechas
 * calculado sobre `Date`: `"2026-03"`, `"2026-Q2"`, `"2026-S1"`, `"2026"`. La
 * vigencia de la regla se declara en periodos (`startPeriod` / `endPeriod`,
 * `varchar(8)`) precisamente para que el generador **nunca** tenga que comparar
 * una fecha con «hoy»: compara claves ordenables, y la única fecha que entra es
 * la de referencia del contexto.
 *
 * ## Las tres reglas que más se malinterpretan
 *
 *  - **R-REC-3 · idempotencia por construcción.** Este módulo NO decide si una
 *    ocurrencia ya existe: se limita a decir qué periodos están vencidos y qué
 *    hash tiene el input efectivo. Quien postea intenta el `INSERT` de la
 *    ocurrencia **antes** del asiento y en la misma transacción; si choca contra
 *    `@@unique(organizationId, recurringEntryId, period)` la transacción muere y
 *    no hay asiento. Nunca «mirar y luego insertar».
 *  - **R-REC-5 · una regla `PAUSADA` no rellena hacia atrás.** `duePeriods`
 *    devuelve `[]` mientras está pausada; al reactivarla, los periodos que
 *    pasaron **no** reaparecen: quedan `OMITIDA` con motivo, porque un devengo
 *    que falta tiene que verse.
 *  - **R-REC-8 · cuota cero (O-22).** Una fila de cuadro con importe 0 **no
 *    genera asiento** —violaría C-1 y el refuerzo de I1 de E3 §6.5— y
 *    `buildOccurrenceDraft` devuelve `{ skip: "CUOTA_CERO" }`. El importe no se
 *    pierde: los cuadros (`lib/closing/depreciation.ts`,
 *    `lib/closing/accrual.ts`) truncan y llevan el residuo a la última fila, de
 *    modo que la suma del cuadro sigue siendo la base y la omisión es visible.
 */

import { createHash } from "node:crypto"

import { resolveEntryDate } from "@/lib/ledger/dates"
import { daysInMonth, formatLocalDate } from "@/lib/ledger/dates"
import type { Cents, EntryDraft, LedgerContext, LocalDate, ResolvedLine, Result } from "@/lib/ledger/types"
import { err, fail, ok } from "@/lib/ledger/types"

// ─────────────────────────────────────────────────────────────────────────────
// Tipos planos
//
// Se declaran aquí, no se importan de `@/prisma/client`: este módulo es puro y
// no debe arrastrar el cliente de Prisma. Los literales son **los mismos** que
// los enums `recurrence_freq`, `recurrence_anchor`, `recurring_kind` y
// `recurring_status` del esquema (T3), y los modelos de la capa de datos hacen
// la conversión en el borde.
// ─────────────────────────────────────────────────────────────────────────────

export type RecurrenceFreq = "MENSUAL" | "TRIMESTRAL" | "SEMESTRAL" | "ANUAL"
export type RecurrenceAnchor = "PRIMER_DIA" | "ULTIMO_DIA" | "DIA_DEL_MES"
export type RecurringKind = "AMORTIZACION" | "PERIODIFICACION" | "IMPORTE_FIJO"
export type RecurringStatus = "ACTIVA" | "PAUSADA" | "FINALIZADA"
export type OccurrenceStatus = "GENERADA" | "OMITIDA" | "FALLIDA"

/** `"2026-03"` | `"2026-Q2"` | `"2026-S1"` | `"2026"`. */
export type PeriodKey = string

export type RecurrencePeriod = {
  key: PeriodKey
  start: LocalDate
  end: LocalDate
  /** R-REC-2: dónde cae el asiento del periodo. */
  postingDate: LocalDate
}

/** Lo que el motor necesita de una `RecurringEntry`; nada más. */
export type RecurringRuleRef = {
  id: string
  code: string
  name: string
  kind: RecurringKind
  frequency: RecurrenceFreq
  anchor: RecurrenceAnchor
  /** Sólo con `anchor = DIA_DEL_MES`; se **satura** al último día del mes. */
  dayOfMonth?: number | null
  startPeriod: PeriodKey
  endPeriod?: PeriodKey | null
  status: RecurringStatus
  templateCode: string
  templateInput: unknown
  /** Sólo `IMPORTE_FIJO` (CHECK G-2). */
  amountCents?: Cents | null
}

/** Fila de cuadro que alimenta un periodo (amortización o periodificación). */
export type ScheduleRowRef = { period: PeriodKey; quotaCents: Cents }

/**
 * De dónde sale el importe y cómo se convierte en líneas.
 *
 * La construcción de las líneas la aporta **la plantilla** (T-14, T-15…, T10 de
 * la ola B) como una función pura: así este módulo decide el *cuándo* y el
 * *cuánto* sin conocer una sola cuenta contable, que es lo que le permite servir
 * a la amortización, a la periodificación y al importe fijo con el mismo código.
 */
export type OccurrenceSource = {
  /** Cuadro vigente; obligatorio en `AMORTIZACION` y `PERIODIFICACION`. */
  rows?: readonly ScheduleRowRef[]
  /** Alternativa a `rule.amountCents` para `IMPORTE_FIJO`. */
  amountCents?: Cents | null
  buildLines: (amountCents: Cents) => Result<ResolvedLine[]>
  description?: string
}

/** R-REC-4 / R-REC-8: por qué un periodo vencido no produjo asiento. */
export type OccurrenceSkip = { skip: "CUOTA_CERO" | "SIN_FILA_EN_CUADRO" }

export function isSkip<T>(value: Result<T> | OccurrenceSkip): value is OccurrenceSkip {
  return typeof value === "object" && value !== null && "skip" in value
}

// ─────────────────────────────────────────────────────────────────────────────
// Aritmética de periodos
//
// Todo se hace con enteros y con la cadena. Un `Date` intermedio es de donde
// salen los desfases de un día en el 29-feb y en el cambio de año (I8).
// ─────────────────────────────────────────────────────────────────────────────

const MONTHLY_RE = /^(\d{4})-(\d{2})$/
const QUARTER_RE = /^(\d{4})-Q([1-4])$/
const SEMESTER_RE = /^(\d{4})-S([12])$/
const YEAR_RE = /^(\d{4})$/

/** Meses que ocupa un periodo de cada frecuencia. */
const MONTHS_PER_PERIOD: Record<RecurrenceFreq, number> = {
  MENSUAL: 1,
  TRIMESTRAL: 3,
  SEMESTRAL: 6,
  ANUAL: 12,
}

/** Clave del periodo de `freq` que contiene la fecha. */
export function periodKeyOf(date: LocalDate, freq: RecurrenceFreq): PeriodKey {
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new TypeError(`periodKeyOf: fecha contable inválida: ${date}`)
  }
  switch (freq) {
    case "MENSUAL":
      return `${date.slice(0, 7)}`
    case "TRIMESTRAL":
      return `${year}-Q${Math.floor((month - 1) / 3) + 1}`
    case "SEMESTRAL":
      return `${year}-S${month <= 6 ? 1 : 2}`
    case "ANUAL":
      return String(year)
  }
}

/**
 * Índice ordinal del periodo, para poder iterar y comparar sin fechas. Es el
 * número de periodos transcurridos desde el año 0 de la misma frecuencia, así
 * que `indexOf(a) − indexOf(b)` es la distancia en periodos.
 */
export function periodIndex(key: PeriodKey, freq: RecurrenceFreq): number {
  const { year, ordinal } = parsePeriodKey(key, freq)
  return year * (12 / MONTHS_PER_PERIOD[freq]) + (ordinal - 1)
}

function parsePeriodKey(key: PeriodKey, freq: RecurrenceFreq): { year: number; ordinal: number } {
  const m =
    freq === "MENSUAL"
      ? MONTHLY_RE.exec(key)
      : freq === "TRIMESTRAL"
        ? QUARTER_RE.exec(key)
        : freq === "SEMESTRAL"
          ? SEMESTER_RE.exec(key)
          : YEAR_RE.exec(key)
  if (!m) throw new TypeError(`clave de periodo «${key}» inválida para la frecuencia ${freq}`)
  const year = Number(m[1])
  const ordinal = freq === "ANUAL" ? 1 : Number(m[2])
  if (freq === "MENSUAL" && (ordinal < 1 || ordinal > 12)) {
    throw new TypeError(`clave de periodo «${key}» inválida: mes fuera de rango`)
  }
  return { year, ordinal }
}

/** ¿Es `key` una clave bien formada para `freq`? */
export function isPeriodKey(key: string, freq: RecurrenceFreq): boolean {
  try {
    parsePeriodKey(key, freq)
    return true
  } catch {
    return false
  }
}

export function periodKeyFromIndex(index: number, freq: RecurrenceFreq): PeriodKey {
  const perYear = 12 / MONTHS_PER_PERIOD[freq]
  const year = Math.floor(index / perYear)
  const ordinal = index - year * perYear + 1
  switch (freq) {
    case "MENSUAL":
      return `${String(year).padStart(4, "0")}-${String(ordinal).padStart(2, "0")}`
    case "TRIMESTRAL":
      return `${String(year).padStart(4, "0")}-Q${ordinal}`
    case "SEMESTRAL":
      return `${String(year).padStart(4, "0")}-S${ordinal}`
    case "ANUAL":
      return String(year).padStart(4, "0")
  }
}

/** Clave del periodo siguiente. Determinista y sin fechas. */
export function nextPeriodKey(key: PeriodKey, freq: RecurrenceFreq): PeriodKey {
  return periodKeyFromIndex(periodIndex(key, freq) + 1, freq)
}

/** Primer y último día naturales del periodo. */
export function periodBounds(key: PeriodKey, freq: RecurrenceFreq): { start: LocalDate; end: LocalDate } {
  const { year, ordinal } = parsePeriodKey(key, freq)
  const span = MONTHS_PER_PERIOD[freq]
  const firstMonth = freq === "MENSUAL" ? ordinal : (ordinal - 1) * span + 1
  const lastMonth = firstMonth + span - 1
  return {
    start: formatLocalDate({ year, month: firstMonth, day: 1 }),
    end: formatLocalDate({ year, month: lastMonth, day: daysInMonth(year, lastMonth) }),
  }
}

/**
 * **R-REC-2.** Fecha del asiento del periodo:
 *
 *  - `ULTIMO_DIA` (por defecto) → último día del periodo;
 *  - `PRIMER_DIA` → primer día del periodo;
 *  - `DIA_DEL_MES` → ese día del **último mes** del periodo, **saturado** al
 *    último día real: el 31 en un periodo que acaba en febrero es el 28 (o el 29
 *    en bisiesto), nunca un 31-feb ni un salto al 1 de marzo.
 */
export function postingDateOf(
  key: PeriodKey,
  freq: RecurrenceFreq,
  anchor: RecurrenceAnchor,
  dayOfMonth?: number | null
): LocalDate {
  const { start, end } = periodBounds(key, freq)
  if (anchor === "PRIMER_DIA") return start
  if (anchor === "ULTIMO_DIA") return end
  const year = Number(end.slice(0, 4))
  const month = Number(end.slice(5, 7))
  const last = daysInMonth(year, month)
  const requested = dayOfMonth ?? last
  if (!Number.isInteger(requested) || requested < 1) {
    throw new TypeError(`dayOfMonth inválido para la regla con anchor DIA_DEL_MES: ${String(dayOfMonth)}`)
  }
  return formatLocalDate({ year, month, day: Math.min(requested, last) })
}

function periodOf(rule: RecurringRuleRef, key: PeriodKey): RecurrencePeriod {
  const { start, end } = periodBounds(key, rule.frequency)
  return { key, start, end, postingDate: postingDateOf(key, rule.frequency, rule.anchor, rule.dayOfMonth) }
}

// ─────────────────────────────────────────────────────────────────────────────
// Vigencia y vencimiento
// ─────────────────────────────────────────────────────────────────────────────

/** Techo defensivo: un bucle acotado siempre es preferible a un `while (true)`. */
const MAX_PERIODS = 2400

/**
 * Periodos de la regla dentro de `[from, to]`, **acotados por su vigencia**
 * (`startPeriod` / `endPeriod`). Devuelve `[]` si el intervalo es vacío; no
 * mira el estado de la regla ni la fecha de referencia (eso es `duePeriods`).
 */
export function periodsBetween(rule: RecurringRuleRef, from: PeriodKey, to: PeriodKey): RecurrencePeriod[] {
  const freq = rule.frequency
  const start = Math.max(periodIndex(from, freq), periodIndex(rule.startPeriod, freq))
  const endCandidates = [periodIndex(to, freq)]
  if (rule.endPeriod) endCandidates.push(periodIndex(rule.endPeriod, freq))
  const end = Math.min(...endCandidates)
  if (end < start) return []
  if (end - start + 1 > MAX_PERIODS) {
    throw new RangeError(`periodsBetween: ${end - start + 1} periodos supera el techo de ${MAX_PERIODS}`)
  }
  const out: RecurrencePeriod[] = []
  for (let i = start; i <= end; i++) out.push(periodOf(rule, periodKeyFromIndex(i, freq)))
  return out
}

/**
 * **R-REC-1 / R-REC-5.** Periodos **vencidos** (`period.end ≤ refDate`) de una
 * regla `ACTIVA` que aún no se han generado, en orden cronológico.
 *
 * `generated` son las claves de las ocurrencias que ya existen —cualquiera que
 * sea su estado: una `OMITIDA` con motivo tampoco se reintenta, porque la
 * omisión es una decisión registrada, no un hueco—. Una regla `PAUSADA` o
 * `FINALIZADA` devuelve `[]` y **no rellena hacia atrás** al reactivarse: los
 * periodos que pasaron ya no están vencidos «pendientes», están perdidos y a la
 * vista.
 */
export function duePeriods(
  rule: RecurringRuleRef,
  generated: readonly PeriodKey[],
  refDate: LocalDate
): RecurrencePeriod[] {
  if (rule.status !== "ACTIVA") return []
  const done = new Set(generated)
  const upTo = periodKeyOf(refDate, rule.frequency)
  return periodsBetween(rule, rule.startPeriod, upTo).filter((p) => p.end <= refDate && !done.has(p.key))
}

/**
 * Próxima ejecución **determinista**: el primer periodo vencido pendiente o,
 * si no hay ninguno, `null`. Es lo que la interfaz enseña como «siguiente» y lo
 * que la cola toma para generar de uno en uno.
 */
export function nextDuePeriod(
  rule: RecurringRuleRef,
  generated: readonly PeriodKey[],
  refDate: LocalDate
): RecurrencePeriod | null {
  return duePeriods(rule, generated, refDate)[0] ?? null
}

/**
 * Próximo periodo del calendario **aunque no esté vencido** (la fecha en la que
 * la regla volverá a generar). Devuelve `null` cuando la vigencia se agotó o la
 * regla no está activa.
 */
export function nextScheduledPeriod(
  rule: RecurringRuleRef,
  generated: readonly PeriodKey[],
  refDate: LocalDate
): RecurrencePeriod | null {
  if (rule.status !== "ACTIVA") return null
  const freq = rule.frequency
  const done = new Set(generated)
  const first = periodIndex(rule.startPeriod, freq)
  const last = rule.endPeriod ? periodIndex(rule.endPeriod, freq) : first + MAX_PERIODS
  const current = periodIndex(periodKeyOf(refDate, freq), freq)
  for (let i = first; i <= last; i++) {
    if (i > current + 1) break
    const key = periodKeyFromIndex(i, freq)
    if (!done.has(key)) return periodOf(rule, key)
  }
  const afterCurrent = Math.max(first, current + 1)
  if (afterCurrent > last) return null
  return periodOf(rule, periodKeyFromIndex(afterCurrent, freq))
}

// ─────────────────────────────────────────────────────────────────────────────
// Sello del input efectivo (I-E9-1b)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Forma canónica de un valor JSON: **claves ordenadas**, `undefined` fuera,
 * strings en **NFC**. Misma disciplina que `lib/extraction/hash.ts` y ADR-0011;
 * se reimplementa aquí en lugar de importarla porque `lib/recurring/**` es un
 * módulo del motor y no debe depender de la capa de extracción.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"))
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: número no finito ${value}`)
    return JSON.stringify(value)
  }
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "bigint") return JSON.stringify(value.toString())
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k.normalize("NFC"))}:${canonicalJson(v)}`)
    return `{${entries.join(",")}}`
  }
  throw new TypeError(`canonicalJson: tipo no serializable ${typeof value}`)
}

/**
 * **I-E9-1b.** sha256 del input **EFECTIVO** de la ocurrencia: la regla tal y
 * como estaba **en ese periodo**, el periodo, la fecha de asiento y el input de
 * la plantilla ya resuelto. El asiento de marzo no se explica con la regla de
 * septiembre, y este sello es lo que lo demuestra.
 */
export function occurrenceInputHash(rule: RecurringRuleRef, period: RecurrencePeriod, input: unknown): string {
  const canonical = canonicalJson({
    ruleCode: rule.code,
    kind: rule.kind,
    frequency: rule.frequency,
    anchor: rule.anchor,
    dayOfMonth: rule.dayOfMonth ?? null,
    templateCode: rule.templateCode,
    period: period.key,
    periodStart: period.start,
    periodEnd: period.end,
    postingDate: period.postingDate,
    input: input ?? null,
  })
  return createHash("sha256").update(canonical, "utf8").digest("hex")
}

// ─────────────────────────────────────────────────────────────────────────────
// Borrador del asiento de la ocurrencia
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **R-REC-4 / R-REC-6 / R-REC-8.** Importe → líneas → borrador de asiento del
 * periodo, o la señal de omisión.
 *
 * El motor **no interpola**: si el cuadro no tiene fila para el periodo, sale
 * `SIN_FILA_EN_CUADRO`; si la tiene y vale 0, sale `CUOTA_CERO`. En ambos casos
 * el llamante registra la ocurrencia como `OMITIDA` **con motivo** (G-4) y no
 * postea nada.
 */
export function buildOccurrenceDraft(
  rule: RecurringRuleRef,
  period: RecurrencePeriod,
  source: OccurrenceSource,
  ctx: LedgerContext
): Result<EntryDraft> | OccurrenceSkip {
  // R-REC-1: nunca un asiento con fecha futura (I8).
  if (period.end > ctx.refDate) {
    return fail(
      err("FUTURE_DATE", "period", `El periodo ${period.key} aún no ha vencido (termina el ${period.end})`, {
        check: "R-REC-1",
      })
    )
  }
  if (rule.status !== "ACTIVA") {
    return fail(err("TEMPLATE_INPUT", "status", `La regla ${rule.code} está ${rule.status}: no genera`, { check: "R-REC-5" }))
  }

  let amountCents: Cents
  if (rule.kind === "IMPORTE_FIJO") {
    const declared = rule.amountCents ?? source.amountCents ?? null
    if (declared === null) {
      return fail(err("TEMPLATE_INPUT", "amountCents", `La regla ${rule.code} es IMPORTE_FIJO y no declara importe`))
    }
    if (!Number.isSafeInteger(declared)) {
      return fail(err("TEMPLATE_INPUT", "amountCents", `Importe no entero en la regla ${rule.code}: ${String(declared)}`))
    }
    if (declared === 0) return { skip: "CUOTA_CERO" }
    amountCents = declared
  } else {
    const row = source.rows?.find((r) => r.period === period.key)
    if (!row) return { skip: "SIN_FILA_EN_CUADRO" }
    if (!Number.isSafeInteger(row.quotaCents)) {
      return fail(err("TEMPLATE_INPUT", "quotaCents", `Cuota no entera en ${rule.code}/${period.key}`))
    }
    if (row.quotaCents === 0) return { skip: "CUOTA_CERO" }
    amountCents = row.quotaCents
  }

  // La fecha del asiento pasa por la regla común de E3 §2.2: mes bloqueado ⇒ se
  // desplaza al primer mes abierto con su coletilla; ejercicio cerrado ⇒ T-22.
  const resolved = resolveEntryDate({ accrualDate: period.postingDate }, ctx)
  if (!resolved.ok) return resolved

  const lines = source.buildLines(amountCents)
  if (!lines.ok) return lines

  const base = source.description ?? `${rule.name} · ${period.key}`
  const draft: EntryDraft = {
    organizationId: ctx.organizationId,
    fiscalYearId: resolved.value.fiscalYearId,
    accrualDate: period.postingDate,
    entryDate: resolved.value.entryDate,
    description: resolved.value.note ? `${base} ${resolved.value.note}` : base,
    kind: "RECURRING",
    sourceType: "RECURRING",
    // R-REC-6: `<code>/<period>` identifica el hecho, no la fila de la base.
    sourceId: `${rule.code}/${period.key}`,
    templateCode: rule.templateCode,
    taxRoundingMode: ctx.policy.taxRoundingMode,
    lines: lines.value,
  }
  return ok(draft)
}

// ─────────────────────────────────────────────────────────────────────────────
// Aritmética de días (ACT/ACT), compartida con `lib/closing/accrual.ts`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Días desde el 1-1-0000 en el calendario proléptico gregoriano, con aritmética
 * entera (algoritmo *days-from-civil* de Howard Hinnant). Se usa **sólo** para
 * contar días entre dos fechas contables; nunca sale de este módulo como fecha.
 */
export function toEpochDay(date: LocalDate): number {
  const y = Number(date.slice(0, 4))
  const m = Number(date.slice(5, 7))
  const d = Number(date.slice(8, 10))
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    throw new TypeError(`toEpochDay: fecha contable inválida: ${date}`)
  }
  const yy = y - (m <= 2 ? 1 : 0)
  const era = Math.floor(yy / 400)
  const yoe = yy - era * 400
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe
}

/**
 * **ACT/ACT con los dos extremos incluidos** (R-PE-1, Q-6 de la validación): un
 * seguro del 15-11-2026 al 14-11-2027 cubre **365** días, no 364. Devuelve 0 si
 * el intervalo está invertido.
 */
export function daysInclusive(from: LocalDate, to: LocalDate): number {
  const n = toEpochDay(to) - toEpochDay(from) + 1
  return n > 0 ? n : 0
}
