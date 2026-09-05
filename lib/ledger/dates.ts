/**
 * E3 · T4 — Aritmética de fechas contables. Módulo PURO.
 *
 * Una fecha contable es un DÍA NATURAL (`@db.Date`): "YYYY-MM-DD", sin hora y
 * sin zona. Todo se hace sobre la cadena y sobre enteros; no se construye
 * ningún `Date` de JS con hora, que es de donde salen los desfases de un día
 * (I8, caso 29-feb / cambio de año).
 *
 * `resolveEntryDate` implementa la regla determinista de
 * `docs/design/E3-asientos-tipo.md` §2.2.
 */

import { err, fail, LedgerContext, LocalDate, ok, Result } from "@/lib/ledger/types"

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export type YMD = { year: number; month: number; day: number }

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
}

/** Descompone "YYYY-MM-DD" validando que el día EXISTE (2026-02-29 no existe). */
export function parseLocalDate(date: string): YMD | null {
  const m = DATE_RE.exec(date)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12) return null
  if (day < 1 || day > daysInMonth(year, month)) return null
  return { year, month, day }
}

export function isValidLocalDate(date: string): boolean {
  return parseLocalDate(date) !== null
}

export function formatLocalDate(ymd: YMD): LocalDate {
  const mm = String(ymd.month).padStart(2, "0")
  const dd = String(ymd.day).padStart(2, "0")
  return `${String(ymd.year).padStart(4, "0")}-${mm}-${dd}`
}

/**
 * Orden de fechas. Las cadenas "YYYY-MM-DD" son lexicográficamente ordenables,
 * así que la comparación textual ES la comparación cronológica.
 */
export function compareDates(a: LocalDate, b: LocalDate): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export const monthOf = (date: LocalDate): number => Number(date.slice(5, 7))
export const yearOf = (date: LocalDate): number => Number(date.slice(0, 4))
export const firstDayOfMonth = (date: LocalDate): LocalDate => `${date.slice(0, 7)}-01`
export const lastDayOfMonth = (date: LocalDate): LocalDate => {
  const y = yearOf(date)
  const m = monthOf(date)
  return formatLocalDate({ year: y, month: m, day: daysInMonth(y, m) })
}

/** Primer día del mes siguiente; en diciembre pasa de año (sin `Date`). */
export function firstDayOfNextMonth(date: LocalDate): LocalDate {
  const y = yearOf(date)
  const m = monthOf(date)
  return m === 12 ? `${y + 1}-01-01` : formatLocalDate({ year: y, month: m + 1, day: 1 })
}

/** Fecha → `Date` en UTC a medianoche. Solo para interoperar con Prisma/`TaxRate`. */
export function toUtcDate(date: LocalDate): Date {
  const ymd = parseLocalDate(date)
  if (!ymd) throw new TypeError(`fecha contable inválida: ${date}`)
  return new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day))
}

/** `Date` (de Prisma, `@db.Date`) → "YYYY-MM-DD" leyendo SIEMPRE en UTC. */
export function fromUtcDate(date: Date): LocalDate {
  return formatLocalDate({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  })
}

export const isWithin = (date: LocalDate, from: LocalDate, to: LocalDate): boolean => date >= from && date <= to

// ─────────────────────────────────────────────────────────────────────────────
// Ejercicios y bloqueos
// ─────────────────────────────────────────────────────────────────────────────

export function findFiscalYear(ctx: LedgerContext, date: LocalDate) {
  return ctx.fiscalYears.find((fy) => isWithin(date, fy.startDate, fy.endDate)) ?? null
}

export function isMonthLocked(ctx: LedgerContext, fiscalYearId: string, month: number): boolean {
  return ctx.periodLocks.some((l) => l.fiscalYearId === fiscalYearId && l.month === month)
}

/**
 * Primer día del primer mes ABIERTO ≥ `from`, recorriendo mes a mes y saltando
 * de ejercicio cuando hace falta. Devuelve null si no queda ningún mes abierto
 * (todo bloqueado o cerrado) dentro de los ejercicios conocidos.
 */
export function firstOpenMonthFrom(ctx: LedgerContext, from: LocalDate): LocalDate | null {
  // Límite duro: 12 meses × el número de ejercicios conocidos + 12. Un bucle
  // acotado es preferible a un `while (true)` en un módulo del motor.
  const maxSteps = ctx.fiscalYears.length * 12 + 12
  let cursor = from
  for (let step = 0; step < maxSteps; step++) {
    const fy = findFiscalYear(ctx, cursor)
    if (!fy) return null
    if (fy.status === "CLOSED") {
      // Salta al inicio del ejercicio siguiente.
      cursor = firstDayOfNextMonth(fy.endDate)
      continue
    }
    if (!isMonthLocked(ctx, fy.id, monthOf(cursor))) {
      return cursor === from ? from : firstDayOfMonth(cursor)
    }
    cursor = firstDayOfNextMonth(cursor)
  }
  return null
}

export type ResolveEntryDateInput = {
  documentDate?: LocalDate | null
  accrualDate?: LocalDate | null
}

export type ResolvedEntryDate = {
  entryDate: LocalDate
  fiscalYearId: string
  shifted: "NONE" | "MONTH_LOCKED" | "FY_CLOSED"
  /** Coletilla obligatoria para la descripción cuando hay desplazamiento. */
  note?: string
}

/**
 * §2.2 de `E3-asientos-tipo.md`:
 *
 *   candidato = accrualDate ?? documentDate
 *   ejercicio OPEN y mes abierto        → entryDate = candidato
 *   ejercicio OPEN, mes bloqueado       → primer día del primer mes abierto ≥ candidato
 *   ejercicio CLOSED                    → señal FY_CLOSED (el llamante usa T-22)
 *   candidato > refDate                 → FUTURE_DATE (en E3 sin excepción, O-8)
 */
export function resolveEntryDate(input: ResolveEntryDateInput, ctx: LedgerContext): Result<ResolvedEntryDate> {
  const candidate = input.accrualDate ?? input.documentDate ?? null
  if (candidate === null) {
    return fail(err("DATE_FORMAT", "documentDate", "Falta la fecha del documento o del devengo"))
  }
  if (!isValidLocalDate(candidate)) {
    return fail(err("DATE_FORMAT", "accrualDate", `Fecha inválida: ${candidate} (se espera YYYY-MM-DD)`))
  }
  if (!isValidLocalDate(ctx.refDate)) {
    return fail(err("DATE_FORMAT", "refDate", `Fecha de referencia inválida: ${ctx.refDate}`))
  }
  if (compareDates(candidate, ctx.refDate) > 0) {
    return fail(
      err("FUTURE_DATE", "entryDate", `La fecha ${candidate} es posterior a hoy (${ctx.refDate})`, { check: "C-11" })
    )
  }

  const fy = findFiscalYear(ctx, candidate)
  if (!fy) {
    return fail(
      err("FY_NOT_FOUND", "entryDate", `No hay ningún ejercicio que contenga la fecha ${candidate}`, { check: "C-11" })
    )
  }
  if (fy.status === "CLOSED") {
    return fail(
      err(
        "FY_CLOSED",
        "entryDate",
        `El ejercicio ${fy.code} está cerrado: el documento se registra en el ejercicio abierto con ` +
          "AJUSTE_EJERCICIO_CERRADO (T-22)",
        { check: "C-11" }
      )
    )
  }

  if (!isMonthLocked(ctx, fy.id, monthOf(candidate))) {
    return ok({ entryDate: candidate, fiscalYearId: fy.id, shifted: "NONE" })
  }

  const shiftedDate = firstOpenMonthFrom(ctx, firstDayOfNextMonth(candidate))
  if (shiftedDate === null) {
    return fail(
      err("MONTH_LOCKED", "entryDate", `El mes ${monthOf(candidate)} está bloqueado y no queda ningún mes abierto`, {
        check: "C-11",
      })
    )
  }
  const shiftedFy = findFiscalYear(ctx, shiftedDate)
  if (!shiftedFy) {
    return fail(err("FY_NOT_FOUND", "entryDate", `No hay ejercicio para la fecha desplazada ${shiftedDate}`))
  }
  if (compareDates(shiftedDate, ctx.refDate) > 0) {
    return fail(
      err("FUTURE_DATE", "entryDate", `El primer mes abierto (${shiftedDate}) es posterior a hoy (${ctx.refDate})`)
    )
  }
  return ok({
    entryDate: shiftedDate,
    fiscalYearId: shiftedFy.id,
    shifted: "MONTH_LOCKED",
    note: `[devengo ${candidate}]`,
  })
}

/**
 * §2.5 — fecha del contra-asiento: la del original si su mes sigue abierto; si
 * no, primer día del primer mes abierto ≥ la del original. `requestedDate` solo
 * puede RETRASARLA, nunca adelantarla.
 */
export function resolveReversalDate(
  originalDate: LocalDate,
  ctx: LedgerContext,
  requestedDate?: LocalDate | null
): Result<{ entryDate: LocalDate; fiscalYearId: string; shifted: boolean }> {
  if (!isValidLocalDate(originalDate)) {
    return fail(err("DATE_FORMAT", "entryDate", `Fecha del asiento original inválida: ${originalDate}`))
  }
  const base = firstOpenMonthFrom(ctx, originalDate)
  if (base === null) {
    return fail(
      err("MONTH_LOCKED", "entryDate", `No queda ningún mes abierto a partir de ${originalDate} para el contra-asiento`)
    )
  }
  let chosen = base
  if (requestedDate) {
    if (!isValidLocalDate(requestedDate)) {
      return fail(err("DATE_FORMAT", "requestedDate", `Fecha solicitada inválida: ${requestedDate}`))
    }
    if (compareDates(requestedDate, base) < 0) {
      return fail(
        err(
          "MONTH_LOCKED",
          "requestedDate",
          `La fecha solicitada ${requestedDate} es anterior a la primera admisible (${base}): ` +
            "solo se puede retrasar el contra-asiento, nunca adelantarlo"
        )
      )
    }
    const fyRequested = findFiscalYear(ctx, requestedDate)
    if (!fyRequested || fyRequested.status === "CLOSED" || isMonthLocked(ctx, fyRequested.id, monthOf(requestedDate))) {
      return fail(
        err("MONTH_LOCKED", "requestedDate", `La fecha solicitada ${requestedDate} no cae en un mes abierto`)
      )
    }
    chosen = requestedDate
  }
  if (compareDates(chosen, ctx.refDate) > 0) {
    return fail(err("FUTURE_DATE", "entryDate", `La fecha del contra-asiento (${chosen}) es posterior a hoy`))
  }
  const fy = findFiscalYear(ctx, chosen)
  if (!fy) return fail(err("FY_NOT_FOUND", "entryDate", `No hay ejercicio para ${chosen}`))
  return ok({ entryDate: chosen, fiscalYearId: fy.id, shifted: chosen !== originalDate })
}
