/**
 * E10 · T7 — Forma canónica, `budgetHash`, composición de versiones y
 * coherencia de signo (`docs/design/E10-presupuesto-horas.md` §3.1 y §3.8).
 *
 * Módulo PURO. El sello reproduce **byte a byte** el de
 * `docs/design/fixtures/build_presupuesto_horas_esperado.py`
 * (`canonical_budget_form`), que es el contrato congelado por D6.
 */

import { createHash } from "node:crypto"

import type {
  AnalyticType,
  BudgetCell,
  BudgetHoursCell,
  BudgetVersion,
  LocalDate,
} from "@/lib/budget/types"
import { monthKey, monthStart } from "@/lib/budget/types"

const NULL_TOKEN = "∅"
const nullable = (v: string | null | undefined): string => (v === null || v === undefined || v === "" ? NULL_TOKEN : v)
const sha256 = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex")

// ─────────────────────────────────────────────────────────────────────────────
// Forma canónica y sello
// ─────────────────────────────────────────────────────────────────────────────

/** Una fila canónica de celda de importe. Tabulada; el orden es lexicográfico. */
const canonicalRow = (cell: BudgetCell): string =>
  [
    cell.month,
    cell.dimension.kind,
    cell.dimension.code,
    nullable(cell.accountCode),
    nullable(cell.analyticType),
    cell.marginLevel,
    String(cell.amountCents),
    cell.signException ? "1" : "0",
  ].join("\t")

/** Una fila canónica de celda de horas, en MINUTOS enteros (Q-2). */
export const canonicalHoursRow = (cell: BudgetHoursCell): string =>
  [cell.month, cell.dimension.kind, cell.dimension.code, nullable(cell.employeeCode), String(cell.minutes)].join("\t")

/** Separa el bloque de importes del bloque de horas dentro de la forma canónica. */
const HOURS_SEPARATOR = "∅HORAS"

/**
 * Forma canónica de una versión: cabecera con su identidad y el sello de la
 * configuración de márgenes, una fila por celda de importe **con su
 * `marginLevel` congelado** (O-E10-7) y una fila por celda de horas **en
 * minutos enteros**. Sin el `marginLevel`, mover un CECO de MC3 a EBITDA leería
 * el mismo presupuesto sellado en otra fila **sin cambiar el hash**.
 *
 * El orden NO depende de la base de datos: las filas se ordenan por su propio
 * texto, que empieza por el mes y sigue por la dimensión y la cuenta.
 *
 * ── Ronda 1 · auditor H-2 y H-3, revisor BLOQUEA 3 ───────────────────────────
 *
 * **`valid_to` NO entra en la cabecera.** La vigencia no es contenido del
 * presupuesto: es **mutable por diseño** —`sealBudgetTx` cierra la versión
 * anterior con `validTo = validFrom − 1 día` en la misma transacción (O-E10-8) y
 * `app.assert_budget_immutable_when_sealed` lo permite expresamente—, así que
 * meterla en el sello hacía **irreproducible** el hash de toda versión relevada:
 * sellada la BASE con `validTo = NULL` y sellada después la REV1, el hash
 * recomputado de la BASE ya no era el sellado e **I-E10-6 daba FAIL sobre datos
 * íntegros**, indistinguible de una manipulación real. El resto de la cabecera
 * (`scenario`, `revision`, `validFrom`, `partialFrom`) sí es inmutable en el
 * trigger, así que el sello y la base dicen ahora lo mismo.
 *
 * **Las líneas de horas SÍ entran** (ADR-0018 D2 y §3.8, al pie de la letra):
 * alimentan `settleBudgetMatrix`, es decir la columna de presupuesto de MC3 por
 * dimensión. Sin ellas el sello no atestiguaba la base con la que se repartió y
 * un cambio de horas en una versión sellada era invisible para I-E10-6.
 */
export function canonicalBudgetForm(version: BudgetVersion, marginConfigHash: string): string {
  const head = [
    version.scenario,
    String(version.revision),
    version.validFrom,
    nullable(version.partialFrom),
    marginConfigHash,
  ].join("\t")
  const rows = version.cells.map(canonicalRow).sort()
  const hours = version.hours.map(canonicalHoursRow).sort()
  return [head, ...rows, HOURS_SEPARATOR, ...hours].join("\n")
}

/** `budgetHash` (§3.8): sha256 de la forma canónica, en hexadecimal. */
export const budgetHash = (version: BudgetVersion, marginConfigHash: string): string =>
  sha256(canonicalBudgetForm(version, marginConfigHash))

// ─────────────────────────────────────────────────────────────────────────────
// O-E10-9 — composición de versiones
// ─────────────────────────────────────────────────────────────────────────────

export type BudgetProvenance = { budgetId: string; label: string }

export type ComposedBudget = {
  effective: BudgetVersion
  provenanceByMonth: Record<string, BudgetProvenance>
}

/** Orden de aplicación: por `validFrom` y, a igualdad, por revisión. */
const byValidity = (a: BudgetVersion, b: BudgetVersion): number =>
  a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : a.revision - b.revision

/**
 * **O-E10-9.** Versión efectiva del ejercicio: la última NO parcial, sustituida
 * mes a mes por las `partialFrom` posteriores, con la procedencia de cada mes.
 *
 * Es lo que impide que una `REVISADO` que sólo trae julio-diciembre desinfle el
 * año a la mitad: sin componer, el total anual se quedaba en seis meses y nadie
 * lo veía, porque la cifra seguía siendo una cifra.
 */
export function composeBudget(
  versions: readonly BudgetVersion[],
  months: readonly string[]
): ComposedBudget {
  const ordered = [...versions].sort(byValidity)
  const full = ordered.filter((v) => v.partialFrom === null)
  const base = full.length > 0 ? full[full.length - 1] : ordered[ordered.length - 1]
  if (!base) throw new Error("composeBudget: no hay ninguna versión de presupuesto que componer")

  const sourceByMonth = new Map<string, BudgetVersion>(months.map((m) => [m, base]))
  for (const version of ordered) {
    if (version.partialFrom === null) continue
    const from = monthKey(version.partialFrom)
    for (const month of months) if (month >= from) sourceByMonth.set(month, version)
  }

  const cells: BudgetCell[] = []
  const hours: BudgetHoursCell[] = []
  const provenanceByMonth: Record<string, BudgetProvenance> = {}
  for (const month of months) {
    const source = sourceByMonth.get(month)
    if (!source) continue
    provenanceByMonth[month] = { budgetId: source.id, label: source.code }
    for (const cell of source.cells) if (monthKey(cell.month) === month) cells.push(cell)
    for (const cell of source.hours) if (monthKey(cell.month) === month) hours.push(cell)
  }
  cells.sort((a, b) => (canonicalRow(a) < canonicalRow(b) ? -1 : 1))
  hours.sort((a, b) => (canonicalHoursRow(a) < canonicalHoursRow(b) ? -1 : 1))

  return { effective: { ...base, cells, hours }, provenanceByMonth }
}

/**
 * **I-E10-15 / I-E10-16** en su forma pura: ¿cada mes del ejercicio tiene
 * exactamente una versión que lo cubra? Devuelve los meses huérfanos.
 */
export function monthsWithoutBudget(composed: ComposedBudget, months: readonly string[]): string[] {
  return months.filter((m) => composed.provenanceByMonth[m] === undefined)
}

// ─────────────────────────────────────────────────────────────────────────────
// O-E10-6 — coherencia de signo
// ─────────────────────────────────────────────────────────────────────────────

/** Tipos que exigen aporte ≥ 0. */
export const POSITIVE_TYPES: ReadonlySet<AnalyticType> = new Set<AnalyticType>(["INGRESO_DIRECTO"])

/** Tipos que exigen aporte ≤ 0. */
export const NEGATIVE_TYPES: ReadonlySet<AnalyticType> = new Set<AnalyticType>([
  "COSTE_DIRECTO_MC1",
  "COSTE_DIRECTO_MC2",
  "INDIRECTO_CECO",
  "AMORTIZACION_DETERIORO",
])

/**
 * Prefijos con excepción DECLARADA: variación de existencias (`61x`/`71x`),
 * rappels y devoluciones (`706`/`708`/`709`) y reversiones (`79x`/`759`).
 * **Avisan, no bloquean** — el signo contrario es legítimo en ellos.
 */
export const SIGN_EXCEPTION_PREFIXES: readonly string[] = ["61", "71", "706", "708", "709", "79", "759"]

const hasExceptionPrefix = (accountCode: string | null): boolean =>
  accountCode !== null && SIGN_EXCEPTION_PREFIXES.some((p) => accountCode.startsWith(p))

export type SignCheck =
  | { ok: true }
  | { ok: false; kind: "WRONG_SIGN" | "EXCEPTION_ALLOWED"; message: string }

const label = (cell: BudgetCell): string =>
  `La celda de ${monthKey(cell.month)} de ${cell.dimension.code}` +
  (cell.accountCode ? ` (cuenta ${cell.accountCode})` : "")

/**
 * **O-E10-6.** La MISMA función que usan la acción al guardar y el importador
 * CSV al validar, para que el mensaje y el `CHECK budget_lines_sign_by_type`
 * digan lo mismo.
 *
 * No hay rama para «tipo nulo»: O-E10-23 lo hace imposible, y con ella el CHECK
 * de signo tenía un camino por el que **no comprobaba nada**.
 */
export function checkBudgetSign(cell: BudgetCell): SignCheck {
  const expectsPositive = POSITIVE_TYPES.has(cell.analyticType)
  const expectsNegative = NEGATIVE_TYPES.has(cell.analyticType)
  const wrong = (expectsPositive && cell.amountCents < 0) || (expectsNegative && cell.amountCents > 0)
  if (!wrong) return { ok: true }
  if (hasExceptionPrefix(cell.accountCode)) {
    return {
      ok: false,
      kind: "EXCEPTION_ALLOWED",
      message:
        `${label(cell)} lleva signo contrario al de ${cell.analyticType}, admisible en ` +
        `${cell.accountCode} (rappel, devolución, reversión o variación de existencias): márcala con signException`,
    }
  }
  return {
    ok: false,
    kind: "WRONG_SIGN",
    message:
      `${label(cell)} es de tipo ${cell.analyticType} y debe ir en ` +
      `${expectsPositive ? "positivo" : "negativo"}: el importe es un APORTE (ingreso +, gasto −)`,
  }
}

/** Celda admitida: signo correcto, o excepción declarada con `signException`. */
export const budgetSignAccepted = (cell: BudgetCell): boolean => {
  const check = checkBudgetSign(cell)
  return check.ok || (check.kind === "EXCEPTION_ALLOWED" && cell.signException)
}

/**
 * **R-B-6.** Más del 90 % de las líneas de grupo 6 en positivo ⇒ el fichero
 * entero viene con el convenio de signo invertido y se rechaza ENTERO: corregir
 * celda a celda un CSV así produce un presupuesto medio invertido, que es peor.
 */
export function detectInvertedSignConvention(cells: readonly BudgetCell[]): boolean {
  const group6 = cells.filter((c) => c.accountCode !== null && c.accountCode.startsWith("6") && c.amountCents !== 0)
  if (group6.length === 0) return false
  const positive = group6.filter((c) => c.amountCents > 0).length
  return positive * 100 > group6.length * 90
}

/** Todas las celdas con signo incoherente y sin excepción declarada. */
export function budgetSignOffenders(cells: readonly BudgetCell[]): { cell: BudgetCell; check: SignCheck }[] {
  const out: { cell: BudgetCell; check: SignCheck }[] = []
  for (const cell of cells) {
    const check = checkBudgetSign(cell)
    if (check.ok) continue
    if (check.kind === "EXCEPTION_ALLOWED" && cell.signException) continue
    out.push({ cell, check })
  }
  return out
}

/** Primer día del mes de una fecha cualquiera, para normalizar entradas. */
export const normalizeMonth = (date: LocalDate): LocalDate => monthStart(monthKey(date))
