/**
 * E3 · T6 — Invariantes de Capa 1 del libro diario.
 *
 * E3 implementa **I1, I7, I8, I9, I10** (I2/I3/I6 llegan en E6; I4/I5 en E4/E5)
 * y los siete propios de la épica **I-E3-1…7**. Formulación operativa:
 * `docs/design/E3-asientos-tipo.md` §3. Salida: `validacion.json`.
 *
 * Módulo PURO: recibe los datos ya leídos y una `refDate` por parámetro.
 */

import {
  checkAllocationInvariants,
  runAnalyticInvariants,
  type AllocationInvariantInput,
  type AnalyticsInvariantInput,
} from "@/lib/analytics/invariants"
import { type ReportsInvariantInput, runReportInvariants } from "@/lib/ledger/reports/invariants-e6"
import { compareDates, isValidLocalDate, monthOf } from "@/lib/ledger/dates"
import { entryHash, HASH_VERSION, HashableLine, isHashVersion } from "@/lib/ledger/hash"
import { reversalNetsToZero } from "@/lib/ledger/void"
import type { Cents, FiscalYearRef, LocalDate, PeriodLockRef, PostedEntry } from "@/lib/ledger/types"

export type { CheckResult, CheckStatus } from "@/lib/ledger/invariants-types"
import type { CheckResult } from "@/lib/ledger/invariants-types"

export type Validacion = {
  run_id: string
  ledgerHash: string
  gitSha: string
  refDate: LocalDate
  organizationId: string
  checks: CheckResult[]
}

export type PlanAccountRef = {
  code: string
  isPostable: boolean
  isActive: boolean
  organizationId?: string
}

export type InvariantInput = {
  runId: string
  gitSha: string
  organizationId: string
  ledgerHash: string
  entries: readonly PostedEntry[]
  fiscalYears: readonly (FiscalYearRef & { lastEntryNumber?: number })[]
  periodLocks: readonly PeriodLockRef[]
  accounts: readonly PlanAccountRef[]
  /** Códigos de plantilla conocidos, para I-E3-5. */
  knownTemplateCodes?: readonly string[]
  /** Cobertura exigida (el fixture completo declara 28/28). */
  requiredTemplateCoverage?: number
  /**
   * E4: bloque analítico. Cuando viene, `runInvariants` añade **I4** y los doce
   * `I-E4-*`; cuando no, la salida es la de E3 sin cambios (`analytics` es
   * opcional a propósito: E5/E6 tampoco lo aportan siempre).
   */
  analytics?: Omit<AnalyticsInvariantInput, "entries">
  /**
   * E5: bloque de liquidación. Cuando viene, `runInvariants` añade **I5** y los
   * doce `I-E5-*`. Sin él se OMITEN sin fallar: una organización que no liquida
   * no tiene por qué ver un FAIL por no tener imputaciones.
   */
  allocations?: Omit<AllocationInvariantInput, "entries" | "lines" | "config" | "period"> & {
    allocationDeltaCents?: Record<string, Record<string, number>>
  }
  /**
   * E6: bloque de informes (I2, I3, I6 y los `I-E6-*`). Opcional por el mismo
   * motivo que el analítico: quien pide el diario no necesita construir el
   * balance, y devolver un PASS sin haberlo comprobado sería mentir.
   */
  reports?: ReportsInvariantInput
}

const pass = (id: string, evidencia: string, query?: string): CheckResult =>
  query === undefined ? { id, status: "PASS", evidencia } : { id, status: "PASS", evidencia, query }

const fail = (id: string, evidencia: string, query?: string): CheckResult =>
  query === undefined ? { id, status: "FAIL", evidencia } : { id, status: "FAIL", evidencia, query }

const sum = (values: readonly number[]): Cents => values.reduce((a, b) => a + b, 0)

// ─────────────────────────────────────────────────────────────────────────────
// I1 — Partida doble por asiento (tolerancia 0)
// ─────────────────────────────────────────────────────────────────────────────

export function checkI1(entries: readonly PostedEntry[]): CheckResult {
  const failures: string[] = []
  for (const e of entries) {
    const debit = sum(e.lines.map((l) => l.debitCents))
    const credit = sum(e.lines.map((l) => l.creditCents))
    if (e.lines.length < 2) {
      failures.push(`asiento ${e.entryNumber}: ${e.lines.length} línea(s), el mínimo es 2`)
      continue
    }
    if (!e.lines.some((l) => l.debitCents > 0) || !e.lines.some((l) => l.creditCents > 0)) {
      failures.push(`asiento ${e.entryNumber}: sin contrapartida (falta un lado)`)
    }
    if (e.lines.some((l) => l.debitCents < 0 || l.creditCents < 0)) {
      failures.push(`asiento ${e.entryNumber}: importes negativos`)
    }
    if (e.lines.some((l) => (l.debitCents === 0) === (l.creditCents === 0))) {
      failures.push(`asiento ${e.entryNumber}: línea a cero o con las dos columnas`)
    }
    if (debit !== credit) {
      failures.push(`asiento ${e.entryNumber}: debe ${debit} ≠ haber ${credit} (diferencia ${debit - credit})`)
    }
  }
  const query =
    "SELECT entry_id, SUM(debit_cents) - SUM(credit_cents) AS diff FROM journal_lines " +
    "WHERE organization_id = $1 GROUP BY entry_id HAVING SUM(debit_cents) <> SUM(credit_cents)"
  return failures.length === 0
    ? pass("I1", `${entries.length} asiento(s) con Σdebe = Σhaber, tolerancia 0`, query)
    : fail("I1", failures.join(" · "), query)
}

// ─────────────────────────────────────────────────────────────────────────────
// I7 — Unicidad y numeración contigua
// ─────────────────────────────────────────────────────────────────────────────

export function checkI7(input: Pick<InvariantInput, "entries" | "fiscalYears">): CheckResult {
  const failures: string[] = []
  for (const fy of input.fiscalYears) {
    const numbers = input.entries.filter((e) => e.fiscalYearId === fy.id).map((e) => e.entryNumber)
    if (numbers.length === 0) continue
    const unique = new Set(numbers)
    if (unique.size !== numbers.length) {
      failures.push(`ejercicio ${fy.code}: números repetidos`)
    }
    const max = Math.max(...numbers)
    if (unique.size !== max || Math.min(...numbers) !== 1) {
      const missing = []
      for (let n = 1; n <= max; n++) if (!unique.has(n)) missing.push(n)
      failures.push(`ejercicio ${fy.code}: huecos en la numeración (${missing.slice(0, 10).join(", ")})`)
    }
    if (fy.lastEntryNumber !== undefined && fy.lastEntryNumber !== max) {
      failures.push(`ejercicio ${fy.code}: lastEntryNumber ${fy.lastEntryNumber} ≠ max(entryNumber) ${max}`)
    }
  }
  const query =
    "SELECT fiscal_year_id, COUNT(*), MAX(entry_number) FROM journal_entries WHERE organization_id = $1 " +
    "GROUP BY fiscal_year_id HAVING COUNT(*) <> MAX(entry_number)"
  return failures.length === 0
    ? pass("I7", `numeración contigua 1..n en ${input.fiscalYears.length} ejercicio(s)`, query)
    : fail("I7", failures.join(" · "), query)
}

/** N-5 es **Info**, no FAIL: el diario se presenta por `(entryDate, entryNumber)`. */
export function checkN5(entries: readonly PostedEntry[]): CheckResult {
  const outOfOrder: string[] = []
  const byFy = new Map<string, PostedEntry[]>()
  for (const e of entries) {
    const list = byFy.get(e.fiscalYearId)
    if (list) list.push(e)
    else byFy.set(e.fiscalYearId, [e])
  }
  for (const list of byFy.values()) {
    const sorted = [...list].sort((a, b) => a.entryNumber - b.entryNumber)
    for (let i = 1; i < sorted.length; i++) {
      if (compareDates(sorted[i].entryDate, sorted[i - 1].entryDate) < 0) {
        outOfOrder.push(`nº ${sorted[i].entryNumber} (${sorted[i].entryDate}) tras nº ${sorted[i - 1].entryNumber}`)
      }
    }
  }
  return outOfOrder.length === 0
    ? pass("N-5", "la numeración es no decreciente en fecha")
    : { id: "N-5", status: "INFO", evidencia: `asientos fuera de secuencia por fecha: ${outOfOrder.join(", ")}` }
}

// ─────────────────────────────────────────────────────────────────────────────
// I8 — Fechas
// ─────────────────────────────────────────────────────────────────────────────

export function checkI8(input: Pick<InvariantInput, "entries" | "fiscalYears" | "periodLocks">, refDate: LocalDate): CheckResult {
  const failures: string[] = []
  const fyById = new Map(input.fiscalYears.map((f) => [f.id, f]))

  for (const e of input.entries) {
    const fy = fyById.get(e.fiscalYearId)
    if (!fy) {
      failures.push(`asiento ${e.entryNumber}: ejercicio desconocido`)
      continue
    }
    if (!isValidLocalDate(e.entryDate)) {
      failures.push(`asiento ${e.entryNumber}: fecha ${e.entryDate} no existe en el calendario`)
      continue
    }
    if (compareDates(e.entryDate, fy.startDate) < 0 || compareDates(e.entryDate, fy.endDate) > 0) {
      failures.push(`asiento ${e.entryNumber}: fecha ${e.entryDate} fuera del ejercicio ${fy.code}`)
    }
    if (compareDates(e.entryDate, refDate) > 0) {
      failures.push(`asiento ${e.entryNumber}: fecha futura ${e.entryDate} (hoy ${refDate})`)
    }
    // O-5 (E9) no es exigible todavía en la BD, pero cuando el asiento existe
    // la comprobación es barata y protege la apertura y el cierre.
    if (e.kind === "OPENING" && e.entryDate !== fy.startDate) {
      failures.push(`asiento ${e.entryNumber}: la apertura debe ir en ${fy.startDate}`)
    }
    if ((e.kind === "CLOSING" || e.kind === "REGULARIZATION") && e.entryDate !== fy.endDate) {
      failures.push(`asiento ${e.entryNumber}: ${e.kind} debe ir en ${fy.endDate}`)
    }
    // Denormalización coherente en la línea (la FK compuesta la impone en BD).
    for (const l of e.lines) {
      if (l.entryDate !== e.entryDate || l.fiscalYearId !== e.fiscalYearId || l.entryKind !== e.kind) {
        failures.push(`asiento ${e.entryNumber}, línea ${l.lineNo}: denormalización incoherente`)
      }
    }
  }
  // El bloqueo de mes se comprueba en el ALTA (§3, I8): un mes que se bloquea
  // después no invalida los asientos que ya tenía.
  const lockedMonths = new Set(input.periodLocks.map((l) => `${l.fiscalYearId}:${l.month}`))
  const evidencia =
    failures.length === 0
      ? `${input.entries.length} asiento(s) dentro de su ejercicio, sin fechas futuras (${lockedMonths.size} mes(es) bloqueado(s))`
      : failures.join(" · ")
  return failures.length === 0 ? pass("I8", evidencia) : fail("I8", evidencia)
}

// ─────────────────────────────────────────────────────────────────────────────
// I9 — Cuenta válida del plan
// ─────────────────────────────────────────────────────────────────────────────

/**
 * La condición `is_postable && is_active` se exige **en el momento del alta**:
 * una cuenta desactivada después de tener líneas NO invalida el histórico
 * (R-09), solo deja de admitir líneas nuevas.
 */
export function checkI9(input: Pick<InvariantInput, "entries" | "accounts">): CheckResult {
  const byCode = new Map(input.accounts.map((a) => [a.code, a]))
  const missing: string[] = []
  const notPostable: string[] = []
  for (const e of input.entries) {
    for (const l of e.lines) {
      const account = byCode.get(l.accountCode)
      if (!account) {
        missing.push(`asiento ${e.entryNumber} línea ${l.lineNo}: cuenta ${l.accountCode} no está en el plan`)
        continue
      }
      if (!account.isPostable) {
        notPostable.push(`asiento ${e.entryNumber} línea ${l.lineNo}: la cuenta ${l.accountCode} no es postable`)
      }
    }
  }
  const failures = [...missing, ...notPostable]
  const query =
    "SELECT l.id FROM journal_lines l LEFT JOIN accounts a " +
    "ON a.organization_id = l.organization_id AND a.code = l.account_code WHERE a.code IS NULL"
  return failures.length === 0
    ? pass("I9", "todas las líneas referencian una cuenta postable del plan de la organización", query)
    : fail("I9", failures.join(" · "), query)
}

// ─────────────────────────────────────────────────────────────────────────────
// I10 — Aislamiento multi-tenant
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Este check se ejecuta **sin** filtro de tenant (rol `app_maintenance`): es la
 * única forma de poder detectar un cruce entre organizaciones.
 */
export function checkI10(input: Pick<InvariantInput, "entries" | "accounts" | "fiscalYears" | "organizationId">): CheckResult {
  const failures: string[] = []
  const fyIds = new Set(input.fiscalYears.map((f) => f.id))
  const foreignAccounts = new Set(
    input.accounts.filter((a) => a.organizationId !== undefined && a.organizationId !== input.organizationId).map((a) => a.code)
  )
  for (const e of input.entries) {
    if (e.organizationId !== input.organizationId) {
      failures.push(`asiento ${e.entryNumber}: organización ${e.organizationId}`)
    }
    if (!fyIds.has(e.fiscalYearId)) {
      failures.push(`asiento ${e.entryNumber}: ejercicio de otra organización`)
    }
    for (const l of e.lines) {
      if (foreignAccounts.has(l.accountCode)) {
        failures.push(`asiento ${e.entryNumber} línea ${l.lineNo}: cuenta de otra organización`)
      }
    }
  }
  const query =
    "SELECT l.id FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id " +
    "WHERE l.organization_id <> e.organization_id"
  return failures.length === 0
    ? pass("I10", "ningún asiento ni línea apunta a otra organización", query)
    : fail("I10", failures.join(" · "), query)
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E3-1 … I-E3-7
// ─────────────────────────────────────────────────────────────────────────────

/** I-E3-1 — un REVERSAL tiene `reversesEntryId` y su espejo cuadra a 0 por cuenta. */
export function checkIE31(entries: readonly PostedEntry[]): CheckResult {
  const byId = new Map(entries.map((e) => [e.id, e]))
  const failures: string[] = []
  const reversals = entries.filter((e) => e.kind === "REVERSAL")
  for (const rev of reversals) {
    if (!rev.reversesEntryId) {
      failures.push(`asiento ${rev.entryNumber}: REVERSAL sin reversesEntryId`)
      continue
    }
    const original = byId.get(rev.reversesEntryId)
    if (!original) {
      failures.push(`asiento ${rev.entryNumber}: el asiento anulado no está en el conjunto analizado`)
      continue
    }
    const net = reversalNetsToZero(original.lines, rev.lines)
    if (!net.ok) {
      failures.push(
        `asiento ${rev.entryNumber}: el par no cuadra a 0 (${net.residuals
          .map((r) => `${r.accountCode}: ${r.diffCents}`)
          .join(", ")})`
      )
    }
  }
  return failures.length === 0
    ? pass("I-E3-1", `${reversals.length} contra-asiento(s), todos espejo exacto de su original`)
    : fail("I-E3-1", failures.join(" · "))
}

/** I-E3-2 — como máximo un REVERSAL por asiento anulado. */
export function checkIE32(entries: readonly PostedEntry[]): CheckResult {
  const count = new Map<string, number>()
  for (const e of entries) {
    if (e.reversesEntryId) count.set(e.reversesEntryId, (count.get(e.reversesEntryId) ?? 0) + 1)
  }
  const dupes = [...count.entries()].filter(([, n]) => n > 1)
  const query =
    "SELECT reverses_entry_id, COUNT(*) FROM journal_entries WHERE reverses_entry_id IS NOT NULL " +
    "GROUP BY reverses_entry_id HAVING COUNT(*) > 1"
  return dupes.length === 0
    ? pass("I-E3-2", `${count.size} asiento(s) anulado(s), ninguno con más de un contra-asiento`, query)
    : fail("I-E3-2", `asientos con varias anulaciones: ${dupes.map(([id, n]) => `${id} (${n})`).join(", ")}`, query)
}

/**
 * I-E3-3 — `voidedAt/voidedBy/voidReason` son informativos. Se garantiza por
 * revisión de código y un grep en CI: ninguna query de informe los filtra. Aquí
 * queda registrado como comprobación de gobierno, no de datos.
 */
export function checkIE33(): CheckResult {
  return {
    id: "I-E3-3",
    status: "INFO",
    evidencia:
      "`voided*` es informativo: se verifica por revisión y por el grep de CI sobre lib/ledger/reports/** y models/ledger.ts",
  }
}

/** I-E3-4 — un REVERSAL no se anula con otro; tampoco OPENING/CLOSING/REGULARIZATION. */
export function checkIE34(entries: readonly PostedEntry[]): CheckResult {
  const byId = new Map(entries.map((e) => [e.id, e]))
  const failures: string[] = []
  for (const e of entries) {
    if (!e.reversesEntryId) continue
    if (e.kind !== "REVERSAL") {
      failures.push(`asiento ${e.entryNumber}: referencia reversesEntryId sin ser REVERSAL`)
    }
    const target = byId.get(e.reversesEntryId)
    if (!target) continue
    if (target.kind === "REVERSAL") {
      failures.push(`asiento ${e.entryNumber}: anula un contra-asiento`)
    }
    if (target.kind === "OPENING" || target.kind === "CLOSING" || target.kind === "REGULARIZATION") {
      failures.push(`asiento ${e.entryNumber}: anula un asiento de tipo ${target.kind}`)
    }
  }
  return failures.length === 0
    ? pass("I-E3-4", "ningún contra-asiento anula otro contra-asiento ni un asiento de sistema")
    : fail("I-E3-4", failures.join(" · "))
}

/** I-E3-5 — cobertura de plantillas y `templateCode` conocido. */
export function checkIE35(input: Pick<InvariantInput, "entries" | "knownTemplateCodes" | "requiredTemplateCoverage">): CheckResult {
  const known = new Set(input.knownTemplateCodes ?? [])
  const used = new Set<string>()
  const unknown: string[] = []
  for (const e of input.entries) {
    if (!e.templateCode) continue
    used.add(e.templateCode)
    if (known.size > 0 && !known.has(e.templateCode)) unknown.push(`${e.entryNumber}: ${e.templateCode}`)
  }
  if (unknown.length > 0) {
    return fail("I-E3-5", `asientos con plantilla desconocida: ${unknown.join(", ")}`)
  }
  const required = input.requiredTemplateCoverage
  if (required !== undefined && used.size < required) {
    return fail("I-E3-5", `cobertura de plantillas ${used.size}/${required}: faltan casos por reproducir`)
  }
  return pass("I-E3-5", `${used.size} plantilla(s) distintas usadas, todas del catálogo`)
}

/** I-E3-6 — la apertura del ejercicio n es el espejo del cierre del n−1. */
export function checkIE36(input: Pick<InvariantInput, "entries" | "fiscalYears">): CheckResult {
  const sortedFy = [...input.fiscalYears].sort((a, b) => (a.startDate < b.startDate ? -1 : 1))
  const failures: string[] = []
  let compared = 0
  for (let i = 1; i < sortedFy.length; i++) {
    const closing = input.entries.find((e) => e.fiscalYearId === sortedFy[i - 1].id && e.kind === "CLOSING")
    const opening = input.entries.find((e) => e.fiscalYearId === sortedFy[i].id && e.kind === "OPENING")
    if (!closing || !opening) continue
    compared++
    const net = reversalNetsToZero(closing.lines, opening.lines)
    if (!net.ok) {
      failures.push(
        `cierre ${sortedFy[i - 1].code} / apertura ${sortedFy[i].code}: ` +
          net.residuals.map((r) => `${r.accountCode}: ${r.diffCents}`).join(", ")
      )
    }
  }
  return failures.length === 0
    ? pass("I-E3-6", `${compared} par(es) cierre/apertura comprobados línea a línea`)
    : fail("I-E3-6", failures.join(" · "))
}

/**
 * I-E3-7 — `entryHash` almacenado = `entryHash(líneas leídas)`.
 *
 * **E8 · T2b — despacho POR VERSIÓN.** Desde ADR-0014 D2 conviven dos formas
 * canónicas de fila: las filas anteriores llevan `hash_version = 2` y las que
 * nacen con divisa, 3. Recomponer una fila v2 con la forma v3 —o al revés— da
 * un FAIL que no existe: no hay mutación ninguna, sólo se ha usado la regla
 * equivocada. Por eso se lee la versión que la propia fila declara y, si es una
 * que este módulo no sabe verificar, se dice en vez de callar.
 */
export function checkIE37(entries: readonly PostedEntry[]): CheckResult {
  const failures: string[] = []
  let checked = 0
  for (const e of entries) {
    if (!e.entryHash) continue
    checked++
    const version = e.hashVersion ?? HASH_VERSION
    if (!isHashVersion(version)) {
      failures.push(`asiento ${e.entryNumber}: forma canónica desconocida (hash_version = ${version})`)
      continue
    }
    // E4-D2: `entryHash` cubre TODAS las columnas de la línea. Recomponerlo con
    // menos daría un falso FAIL en cuanto una línea llevara impuesto o destino.
    const hashable: HashableLine[] = e.lines.map((l) => ({
      entryId: e.id,
      entryDate: e.entryDate,
      entryNumber: e.entryNumber,
      lineNo: l.lineNo,
      accountCode: l.accountCode,
      debitCents: l.debitCents,
      creditCents: l.creditCents,
      entryKind: e.kind,
      fiscalYearId: l.fiscalYearId,
      taxRateId: l.taxRateId ?? null,
      taxBaseCents: l.taxBaseCents ?? null,
      counterpartyId: l.counterpartyId ?? null,
      dueDate: l.dueDate ?? null,
      description: l.description ?? null,
      analyticType: l.analyticType ?? null,
      projectId: l.projectId ?? null,
      costCenterId: l.costCenterId ?? null,
      businessLineId: l.businessLineId ?? null,
      originalCurrency: l.originalCurrency ?? null,
      originalAmountCents: l.originalAmountCents ?? null,
      exchangeRateId: l.exchangeRateId ?? null,
    }))
    const recomputed = entryHash(hashable, version)
    if (recomputed !== e.entryHash) {
      failures.push(`asiento ${e.entryNumber}: el hash almacenado no coincide con el de sus líneas`)
    }
  }
  return failures.length === 0
    ? pass("I-E3-7", `${checked} asiento(s) con sello de contenido íntegro`)
    : fail("I-E3-7", failures.join(" · "))
}

// ─────────────────────────────────────────────────────────────────────────────
// Ejecución completa y sello
// ─────────────────────────────────────────────────────────────────────────────

export function runInvariants(input: InvariantInput, refDate: LocalDate): Validacion {
  return {
    run_id: input.runId,
    ledgerHash: input.ledgerHash,
    gitSha: input.gitSha,
    refDate,
    organizationId: input.organizationId,
    checks: [
      checkI1(input.entries),
      checkI7(input),
      checkN5(input.entries),
      checkI8(input, refDate),
      checkI9(input),
      checkI10(input),
      checkIE31(input.entries),
      checkIE32(input.entries),
      checkIE33(),
      checkIE34(input.entries),
      checkIE35(input),
      checkIE36(input),
      checkIE37(input.entries),
      // E4: I4 + I-E4-1…12, solo si el llamante aporta el bloque analítico.
      ...(input.analytics ? runAnalyticInvariants({ ...input.analytics, entries: input.entries }) : []),
      // E5: I5 + I-E5-1…12, sólo con el bloque de liquidación Y el analítico
      // (los invariantes de imputación se juzgan sobre la MISMA matriz).
      ...(input.allocations && input.analytics
        ? checkAllocationInvariants({ ...input.analytics, ...input.allocations })
        : []),
      // E6: I2, I3, I6 y los I-E6-*, sólo si el llamante aporta el bloque.
      ...(input.reports ? runReportInvariants(input.reports) : []),
    ],
  }
}

/**
 * E6 (ADR-0012 D3, Nivel 2): se añade `VARIACION`. Una cifra que se dispara
 * respecto al comparativo no es un descuadre —el diario puede estar perfecto— ni
 * una carencia de entorno: es un cambio que un humano debería mirar. Meterlo en
 * `AVISO` lo habría enterrado entre los WARN de calidad de datos.
 */
export type SealReasonKind = "ENTORNO" | "INVARIANTE" | "AVISO" | "CONFIGURACION" | "VARIACION"

/** Motivo del sello, ETIQUETADO por su naturaleza (hallazgo 5 del auditor). */
export type SealReason = { kind: SealReasonKind; message: string }

export type Seal = {
  sello: "VALIDADO AUTOMÁTICAMENTE" | "REQUIERE REVISIÓN"
  /** Compatibilidad: los mensajes en texto plano, en el mismo orden. */
  motivos: string[]
  /**
   * Los mismos motivos con su etiqueta. `ENTORNO` es el que separa el auditor:
   * «no sé con qué versión del motor se calculó esto» NO es un descuadre de
   * cifras — el diario puede estar perfecto —, es una carencia de trazabilidad
   * del despliegue. Confundirlos hacía que un entorno sin `GIT_SHA` pareciera
   * un problema contable, y que un problema contable pasara desapercibido entre
   * el ruido de un entorno mal configurado.
   */
  razones: SealReason[]
}

export type SealOptions = {
  gitSha: string
  /** git-sha del último run: si el motor ha cambiado, el primer run se revisa. */
  lastGitSha?: string | null
  /** Umbral de WARNs por encima del cual se exige revisión. */
  warnThreshold?: number
  /** Revisión forzada por configuración de la organización. */
  forceReview?: boolean
}

/**
 * `VALIDADO AUTOMÁTICAMENTE` si todos PASS y no hay revisión forzada;
 * `REQUIERE REVISIÓN` + motivo si hay cualquier FAIL, si es el primer run tras
 * un cambio de `gitSha` del motor, o si los WARN superan el umbral.
 */
/** Valores que significan «no sé con qué versión del motor se calculó esto». */
const UNKNOWN_SHAS: ReadonlySet<string> = new Set(["", "desconocido", "unknown", "dev", "HEAD"])

export const isKnownGitSha = (sha: string | null | undefined): boolean =>
  typeof sha === "string" && !UNKNOWN_SHAS.has(sha.trim())

export function seal(validacion: Validacion, opts: SealOptions): Seal {
  const razones: SealReason[] = []
  const failed = validacion.checks.filter((c) => c.status === "FAIL")
  const warned = validacion.checks.filter((c) => c.status === "WARN")

  // Revisión ronda 1 (#4): sin git-sha no se puede afirmar CON QUÉ motor se
  // calculó la cifra, así que el sello no puede decir «validado
  // automáticamente». La trazabilidad (P6/P7) es parte del sello, no un extra.
  // Es un motivo de ENTORNO: no dice nada de las cifras.
  if (!isKnownGitSha(opts.gitSha)) {
    razones.push({
      kind: "ENTORNO",
      message:
        "ENTORNO · git-sha del motor desconocido: no se puede acreditar con qué versión se calculó (no es un descuadre de cifras)",
    })
  }
  if (opts.lastGitSha !== undefined && opts.lastGitSha !== null && opts.lastGitSha !== opts.gitSha) {
    razones.push({ kind: "ENTORNO", message: `ENTORNO · primer run tras cambiar el motor (${opts.lastGitSha} → ${opts.gitSha})` })
  }
  if (failed.length > 0) {
    razones.push({ kind: "INVARIANTE", message: `invariantes en FAIL: ${failed.map((c) => c.id).join(", ")}` })
  }
  const threshold = opts.warnThreshold ?? 0
  if (warned.length > threshold) {
    razones.push({
      kind: "AVISO",
      message: `${warned.length} aviso(s) por encima del umbral (${threshold}): ${warned.map((c) => c.id).join(", ")}`,
    })
  }
  if (opts.forceReview) {
    razones.push({ kind: "CONFIGURACION", message: "revisión forzada por configuración de la organización" })
  }

  const motivos = razones.map((r) => r.message)
  return razones.length === 0
    ? { sello: "VALIDADO AUTOMÁTICAMENTE", motivos: [], razones: [] }
    : { sello: "REQUIERE REVISIÓN", motivos, razones }
}

/** Alias del diseño (§5). */
export const sealFor = seal

/** ¿Hay algún FAIL? Es el código de salida de `scripts/run-invariants.ts`. */
export const hasFailures = (v: Validacion): boolean => v.checks.some((c) => c.status === "FAIL")

/** Meses bloqueados de un ejercicio, para la pestaña Auditoría. */
export const lockedMonthsOf = (locks: readonly PeriodLockRef[], fiscalYearId: string): number[] =>
  locks.filter((l) => l.fiscalYearId === fiscalYearId).map((l) => l.month).sort((a, b) => a - b)

/** Mes de una fecha contable: lo usa la Auditoría al listar bloqueos. */
export { monthOf }

/** E4 — re-exportados para que la Auditoría los consuma desde un solo módulo. */
export {
  checkI4,
  checkIE41,
  checkIE42,
  checkIE43,
  checkIE44,
  checkIE45,
  checkIE46,
  checkIE47,
  checkIE48,
  checkIE49,
  checkIE410,
  checkIE411,
  checkIE412,
  runAnalyticInvariants,
  // E5 — liquidación de CECOs.
  checkAllocationInvariants,
  checkI5,
  checkIE51,
  checkIE52,
  checkIE53,
  checkIE54,
  checkIE55,
  checkIE56,
  checkIE57,
  checkIE58,
  checkIE59,
  checkIE510,
  checkIE511,
  checkIE512,
} from "@/lib/analytics/invariants"
export type { AnalyticsInvariantInput } from "@/lib/analytics/invariants"
export type { AllocationInvariantInput } from "@/lib/analytics/invariants"

/** E6 — invariantes de los estados financieros, desde el mismo módulo. */
export { checkI2, checkI3, checkIE613, runReportInvariants } from "@/lib/ledger/reports/invariants-e6"
export type { ReportsInvariantInput } from "@/lib/ledger/reports/invariants-e6"
