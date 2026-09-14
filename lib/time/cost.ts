/**
 * E10 · T6 — Coste-hora, coste del periodo por receptor y absorción
 * (`docs/design/E10-presupuesto-horas.md` §3.5, ADR-0018 D3,
 * `docs/design/E10-validacion-controlling.md` Q-1, Q-3, O-E10-11…15, O-E10-19,
 * O-E10-20).
 *
 * Módulo **PURO**: sin IO, sin Prisma, sin LLM, sin `Date.now()`. Aritmética
 * **entera** de principio a fin: el truncamiento se compensa con Hamilton, nunca
 * con un `float`.
 *
 * **Las tres cosas que este fichero decide, y por qué están escritas.**
 *
 * 1. **La tarifa vigente es la del DÍA DEL PARTE**, no la del fin de periodo: un
 *    cambio de tarifa a mitad de mes se refleja parte a parte, que es lo que un
 *    controller espera. Sin tarifa vigente para un parte, el receptor sale **no
 *    evaluable** con el empleado y la fecha nombrados; **jamás se aplica 0 ni la
 *    tarifa anterior** (I-E10-5, motivo de sello `TARIFA_AUSENTE`).
 * 2. **Absorción plena, modelo A** (Q-3 / O-E10-14). El denominador son las horas
 *    **productivas**, luego la tarifa **ya absorbe** el coste de las no
 *    productivas y ese coste **no se vuelve a repartir**. Quien reparte es la
 *    regla `HOURS` sobre el saldo real del CECO, que ya contiene la nómina
 *    íntegra. Por eso este módulo **no valora** partes no productivos: hacerlo
 *    sería el doble cómputo que pone I-E10-12 en FAIL todos los meses (+20 %).
 * 3. **`641` (indemnizaciones) fuera de toda `basis`** (O-E10-11): coste no
 *    recurrente ligado a personas que dejan de generar horas; incluirlo dispara
 *    la tarifa del último periodo del empleado y contamina el margen de los
 *    proyectos que casualmente tocó ese mes.
 */

import {
  DateWindow,
  DriverCode,
  isActivityDriver,
  LocalDate,
  MINUTES_PER_HOUR,
  TimeEntryRow,
  TimeTargetKind,
  assertTimeEntryRow,
} from "@/lib/time/aggregate"

// ─────────────────────────────────────────────────────────────────────────────
// Tipos planos
// ─────────────────────────────────────────────────────────────────────────────

/** Entero en céntimos (misma definición que `lib/ledger/types`). */
export type Cents = number

/** Espejo de `EmployeeRateBasis` (`prisma/schema.prisma`), sin importarlo. */
export type EmployeeRateBasisCode = "BRUTO_SIN_SS" | "COSTE_EMPRESA_CON_SS" | "COSTE_TOTAL_CON_ESTRUCTURA"

/** Espejo de `EmployeeRateSource`. */
export type EmployeeRateSourceCode = "DECLARADO" | "DERIVADO_NOMINA"

export type EmployeeRateRow = {
  id: string
  employeeId: string
  employeeCode: string
  /** Céntimos por hora, entero y > 0. */
  hourlyCostCents: Cents
  basis: EmployeeRateBasisCode
  validFrom: LocalDate
  /** `null` = abierta por el extremo derecho. */
  validTo: LocalDate | null
}

/** **Q-1 / O-E10-11.** Qué cuentas compone cada base. `641` no está en ninguna. */
export const PAYROLL_PREFIXES_BY_BASIS: Readonly<Record<EmployeeRateBasisCode, readonly string[]>> = {
  BRUTO_SIN_SS: ["640"],
  COSTE_EMPRESA_CON_SS: ["640", "642", "645", "649"],
  // La estructura imputada no sale de una cuenta 64x: la añade la liquidación.
  COSTE_TOTAL_CON_ESTRUCTURA: ["640", "642", "645", "649"],
}

/** El default del producto (Q-1): coste empresa con Seguridad Social. */
export const DEFAULT_RATE_BASIS: EmployeeRateBasisCode = "COSTE_EMPRESA_CON_SS"
export const DEFAULT_PAYROLL_ACCOUNT_PREFIXES: readonly string[] = PAYROLL_PREFIXES_BY_BASIS.COSTE_EMPRESA_CON_SS

/** **O-E10-11**: fuera de toda base, y la ficha de la tarifa lo dice. */
export const EXCLUDED_PAYROLL_PREFIXES: readonly string[] = ["641"]

/**
 * **O-E10-19** — denominador de **respaldo** cuando no hay partes reales, nunca
 * por delante de ellos. 1 500 h = 90 000 minutos: el default de la ronda 0
 * (1 700 h) no eran horas productivas sino jornada anual, e infravaloraba la
 * tarifa en torno a un 12 %.
 */
export const REFERENCE_PRODUCTIVE_MINUTES_PER_YEAR = 90000

/** Cobertura mínima por defecto de la derivación individual (O-E10-12). */
export const DEFAULT_DERIVATION_MIN_COVERAGE_BPS = 7500

export type CostErrorCode = "RATE_NOT_POSITIVE" | "RATE_WINDOW"

export class TimeCostError extends Error {
  constructor(
    readonly code: CostErrorCode,
    message: string
  ) {
    super(message)
    this.name = "TimeCostError"
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades internas
// ─────────────────────────────────────────────────────────────────────────────

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const within = (date: LocalDate, w: DateWindow): boolean => date >= w.from && date <= w.to

/** División entera hacia −∞ (los contra-apuntes hacen negativo el producto). */
const floorDiv = (a: number, b: number): number => Math.floor(a / b)

/** Resto **no negativo** de `a mod b`, con `b > 0`. Es la fracción de Hamilton. */
const modPositive = (a: number, b: number): number => a - b * floorDiv(a, b)

function bpsOf(part: number, base: number): number | null {
  if (base === 0) return null
  return Math.trunc((part * 10000) / base)
}

// ─────────────────────────────────────────────────────────────────────────────
// Vigencias
// ─────────────────────────────────────────────────────────────────────────────

export type RateLookup =
  | { kind: "FOUND"; rate: EmployeeRateRow }
  | { kind: "MISSING" }
  | { kind: "OVERLAP"; rates: readonly EmployeeRateRow[] }

/**
 * Tarifa vigente de un empleado **el día de un parte**. Devuelve `OVERLAP` en vez
 * de elegir una cuando hay dos: el `EXCLUDE USING gist` de la migración lo
 * impide en la base (`23P01`), pero un motor puro que eligiese en silencio
 * produciría una cifra distinta según el orden de lectura (I-E10-5).
 */
export function rateAt(rates: readonly EmployeeRateRow[], employeeId: string, date: LocalDate): RateLookup {
  const hits = rates.filter(
    (r) => r.employeeId === employeeId && r.validFrom <= date && (r.validTo === null || r.validTo >= date)
  )
  if (hits.length === 0) return { kind: "MISSING" }
  if (hits.length > 1) return { kind: "OVERLAP", rates: [...hits].sort((a, b) => cmp(a.id, b.id)) }
  return { kind: "FOUND", rate: hits[0] }
}

/** Vigencias solapadas del mismo empleado, para I-E10-5 y para la acción. */
export function overlappingRates(
  rates: readonly EmployeeRateRow[]
): readonly { employeeCode: string; a: string; b: string }[] {
  const out: { employeeCode: string; a: string; b: string }[] = []
  const sorted = [...rates].sort((x, y) => cmp(x.employeeId, y.employeeId) || cmp(x.validFrom, y.validFrom) || cmp(x.id, y.id))
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]
      const b = sorted[j]
      if (a.employeeId !== b.employeeId) break
      const aTo = a.validTo ?? "9999-12-31"
      if (b.validFrom <= aTo) out.push({ employeeCode: a.employeeCode, a: a.id, b: b.id })
    }
  }
  return out
}

/**
 * **O-E10-14 / criterio 19-bis.** `COSTE_TOTAL_CON_ESTRUCTURA` es **excluyente**
 * con las reglas de actividad vigentes: si la tarifa ya lleva estructura
 * imputada y además una regla `HOURS`/`HEADCOUNT` reparte los CECOs a los
 * proyectos, la estructura se carga **dos veces**.
 */
export function checkRateBasisConflict(
  basis: EmployeeRateBasisCode,
  activeRules: readonly { driver: DriverCode; code?: string }[]
): { ok: true } | { ok: false; code: "RATE_BASIS_CONFLICT"; rules: readonly string[]; message: string } {
  if (basis !== "COSTE_TOTAL_CON_ESTRUCTURA") return { ok: true }
  const rules = activeRules.filter((r) => isActivityDriver(r.driver)).map((r) => r.code ?? r.driver)
  if (rules.length === 0) return { ok: true }
  return {
    ok: false,
    code: "RATE_BASIS_CONFLICT",
    rules,
    message:
      `la base COSTE_TOTAL_CON_ESTRUCTURA ya incluye estructura imputada y hay ${rules.length} regla(s) de ` +
      `actividad vigente(s) (${rules.join(", ")}) que la vuelven a repartir: la estructura se cargaría dos veces ` +
      "(O-E10-14)",
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// O-E10-13 — el coste del periodo por receptor, con su Hamilton
// ─────────────────────────────────────────────────────────────────────────────

export type EntryCost = {
  entryId: string
  date: LocalDate
  employeeCode: string
  targetCode: string
  minutes: number
  hourlyCostCents: Cents
  basis: EmployeeRateBasisCode
  /** Parte del total del receptor que le toca por Hamilton. */
  costCents: Cents
}

export type TargetCost = {
  code: string
  id: string
  kind: TimeTargetKind
  minutes: number
  /** `null` = **no evaluable**. Nunca 0 por defecto (I-E10-5). */
  costCents: Cents | null
  /** La `basis` **viaja con la cifra** (Q-1). `null` con bases en conflicto. */
  basis: EmployeeRateBasisCode | null
  bases: readonly EmployeeRateBasisCode[]
  entries: readonly EntryCost[]
  notEvaluableReason: "TARIFA_AUSENTE" | "TARIFA_SOLAPADA" | "BASIS_CONFLICT" | null
}

export type UnpricedRow = {
  entryId: string
  employeeCode: string
  employeeId: string
  date: LocalDate
  targetCode: string
  minutes: number
  reason: "TARIFA_AUSENTE" | "TARIFA_SOLAPADA"
}

export type CostOfTimeResult = {
  byTarget: readonly TargetCost[]
  unpriced: readonly UnpricedRow[]
  /** O-E10-15: las bases distintas que conviven; con más de una, KPI no evaluable. */
  basisConflict: readonly EmployeeRateBasisCode[]
  totals: {
    minutes: number
    /** Σ del coste de los receptores **evaluables**. */
    valuedCents: Cents
    evaluableTargets: number
    notEvaluableTargets: number
  }
}

/**
 * Coste de los partes de un receptor con la tarifa **vigente el día de cada
 * parte**.
 *
 * **O-E10-13 — el Hamilton, definido.** «Σ coste por parte = coste del receptor»
 * no decía qué es el coste del receptor, y sin definirlo dos implementaciones dan
 * cifras distintas. Con partes `i` de `mᵢ` minutos y tarifa `rᵢ` c/h del día:
 *
 *   T = ⌊ Σ (mᵢ · rᵢ) / 60 ⌋                       ← el total del receptor
 *   se reparte T entre los partes por MAYOR RESTO sobre los pesos mᵢ·rᵢ,
 *   con empate a favor del parte de menor (fecha, código de empleado, id)
 *
 * —el mismo desempate determinista de ADR-0013 D5—. Sin esta regla escrita, el
 * motor pierde un céntimo en cada receptor y cada mes.
 *
 * *Implementación con contra-apuntes:* el reparto se hace con **suelo** y no con
 * truncamiento hacia cero (`⌊pᵢ/60⌋` y resto en `[0, 60)`), de modo que
 * `Σ ⌊pᵢ/60⌋ ≤ T` sigue valiendo cuando algún `mᵢ` es negativo y el reparto de
 * los `T − Σ⌊pᵢ/60⌋` céntimos restantes es exacto también entonces.
 *
 * **Sólo se valoran partes APROBADOS y PRODUCTIVOS** (Q-3, modelo A): la tarifa
 * ya absorbe el coste de las horas no productivas y valorarlas aquí sería
 * repartirlo dos veces.
 */
export function costOfTime(
  rows: readonly TimeEntryRow[],
  rates: readonly EmployeeRateRow[],
  window: DateWindow
): CostOfTimeResult {
  for (const rate of rates) {
    if (!Number.isInteger(rate.hourlyCostCents) || rate.hourlyCostCents <= 0) {
      throw new TimeCostError(
        "RATE_NOT_POSITIVE",
        `tarifa ${rate.id} de ${rate.employeeCode}: hourlyCostCents debe ser un entero > 0, recibido ${rate.hourlyCostCents}`
      )
    }
  }

  const unpriced: UnpricedRow[] = []
  const buckets = new Map<
    string,
    {
      code: string
      id: string
      kind: TimeTargetKind
      priced: { row: TimeEntryRow; rate: EmployeeRateRow }[]
      failure: "TARIFA_AUSENTE" | "TARIFA_SOLAPADA" | null
      minutes: number
    }
  >()

  for (const row of rows) {
    assertTimeEntryRow(row)
    if (!row.approved || !row.productive || !within(row.date, window)) continue
    const key = `${row.target.kind}|${row.target.id}`
    const bucket =
      buckets.get(key) ??
      (() => {
        const fresh = {
          code: row.target.code,
          id: row.target.id,
          kind: row.target.kind,
          priced: [] as { row: TimeEntryRow; rate: EmployeeRateRow }[],
          failure: null as "TARIFA_AUSENTE" | "TARIFA_SOLAPADA" | null,
          minutes: 0,
        }
        buckets.set(key, fresh)
        return fresh
      })()
    bucket.minutes += row.minutes

    const lookup = rateAt(rates, row.employeeId, row.date)
    if (lookup.kind === "FOUND") {
      bucket.priced.push({ row, rate: lookup.rate })
      continue
    }
    const reason = lookup.kind === "MISSING" ? "TARIFA_AUSENTE" : "TARIFA_SOLAPADA"
    // Sin tarifa (o con dos), el receptor entero es **no evaluable**: aplicar 0 o
    // la tarifa anterior sería inventarse un margen (I-E10-5).
    if (bucket.failure === null || reason === "TARIFA_AUSENTE") bucket.failure = reason
    unpriced.push({
      entryId: row.id,
      employeeCode: row.employeeCode,
      employeeId: row.employeeId,
      date: row.date,
      targetCode: row.target.code,
      minutes: row.minutes,
      reason,
    })
  }

  const allBases = new Set<EmployeeRateBasisCode>()
  const byTarget: TargetCost[] = []

  for (const bucket of buckets.values()) {
    const bases = [...new Set(bucket.priced.map((p) => p.rate.basis))].sort()
    for (const b of bases) allBases.add(b)
    const basisConflicted = bases.length > 1
    const reason = bucket.failure ?? (basisConflicted ? "BASIS_CONFLICT" : null)

    const entries = hamiltonEntryCosts(bucket.priced)
    const total = entries.reduce((a, e) => a + e.costCents, 0)

    byTarget.push({
      code: bucket.code,
      id: bucket.id,
      kind: bucket.kind,
      minutes: bucket.minutes,
      // O-E10-15: agregar receptores con `basis` distinta produce una cifra sin
      // significado (~31,9 % de diferencia entre bruto y coste empresa).
      costCents: reason === null ? total : null,
      basis: bases.length === 1 ? bases[0] : null,
      bases,
      entries,
      notEvaluableReason: reason,
    })
  }

  byTarget.sort((a, b) => cmp(a.code, b.code) || cmp(a.kind, b.kind) || cmp(a.id, b.id))
  unpriced.sort((a, b) => cmp(a.date, b.date) || cmp(a.employeeCode, b.employeeCode) || cmp(a.entryId, b.entryId))

  const basisConflict = allBases.size > 1 ? [...allBases].sort() : []

  return {
    byTarget,
    unpriced,
    basisConflict,
    totals: {
      minutes: byTarget.reduce((a, t) => a + t.minutes, 0),
      valuedCents: byTarget.reduce((a, t) => a + (t.costCents ?? 0), 0),
      evaluableTargets: byTarget.filter((t) => t.costCents !== null).length,
      notEvaluableTargets: byTarget.filter((t) => t.costCents === null).length,
    },
  }
}

/** El Hamilton de O-E10-13 sobre los partes valorados de UN receptor. */
function hamiltonEntryCosts(priced: readonly { row: TimeEntryRow; rate: EmployeeRateRow }[]): EntryCost[] {
  if (priced.length === 0) return []
  // Peso de cada parte: pᵢ = mᵢ · rᵢ, en céntimos·minuto/hora (entero exacto).
  const items = priced.map(({ row, rate }) => {
    const product = row.minutes * rate.hourlyCostCents
    return {
      row,
      rate,
      product,
      base: floorDiv(product, MINUTES_PER_HOUR),
      remainder: modPositive(product, MINUTES_PER_HOUR),
    }
  })
  const productSum = items.reduce((a, it) => a + it.product, 0)
  const total = floorDiv(productSum, MINUTES_PER_HOUR)
  const baseSum = items.reduce((a, it) => a + it.base, 0)
  let rest = total - baseSum // entero en [0, n − 1] por construcción

  // Mayor resto; empate a favor del parte de menor (fecha, código de empleado, id).
  const order = [...items].sort(
    (a, b) =>
      b.remainder - a.remainder ||
      cmp(a.row.date, b.row.date) ||
      cmp(a.row.employeeCode, b.row.employeeCode) ||
      cmp(a.row.id, b.row.id)
  )
  const bonus = new Set<string>()
  for (const it of order) {
    if (rest <= 0) break
    bonus.add(it.row.id)
    rest -= 1
  }

  return items
    .map((it) => ({
      entryId: it.row.id,
      date: it.row.date,
      employeeCode: it.row.employeeCode,
      targetCode: it.row.target.code,
      minutes: it.row.minutes,
      hourlyCostCents: it.rate.hourlyCostCents,
      basis: it.rate.basis,
      costCents: it.base + (bonus.has(it.row.id) ? 1 : 0),
    }))
    .sort((a, b) => cmp(a.date, b.date) || cmp(a.employeeCode, b.employeeCode) || cmp(a.entryId, b.entryId))
}

// ─────────────────────────────────────────────────────────────────────────────
// D3 / O-E10-12 — la derivación desde la nómina, que es una PROPUESTA
// ─────────────────────────────────────────────────────────────────────────────

export type DerivationScope = "COST_CENTER" | "EMPLOYEE"

export type DeriveHourlyCostInput = {
  scope: DerivationScope
  /**
   * Σ −aporte de las líneas del periodo cuyas cuentas caen en `accountPrefixes`.
   * Con `scope = "EMPLOYEE"` es el total de 64x del periodo (el **denominador de
   * la cobertura**); el numerario de la tarifa es entonces `matchedAmountCents`.
   */
  payrollCents: Cents
  /** Minutos **productivos aprobados** del ámbito (Q-3). */
  productiveMinutes: number
  linesTotal: number
  linesMatched: number
  /** Importe de las líneas con `counterpartyId` del empleado. */
  matchedAmountCents: Cents
  accountPrefixes: readonly string[]
  basis: EmployeeRateBasisCode
  minCoverageBps: number
  periodStart: LocalDate
  periodEnd: LocalDate
  costCenterCode?: string
  employeeCode?: string
}

export type DerivationTerms = {
  scope: DerivationScope
  costCenterCode?: string
  employeeCode?: string
  periodStart: LocalDate
  periodEnd: LocalDate
  payrollCents: Cents
  numeratorCents: Cents
  accountPrefixes: readonly string[]
  excludedPrefixes: readonly string[]
  productiveMinutes: number
  coverageBps: number | null
  linesTotal: number
  linesMatched: number
  matchedAmountCents: Cents
  basis: EmployeeRateBasisCode
  formula: string
  hourlyCostCents: Cents
}

export type DeriveHourlyCostError = "NO_PRODUCTIVE_TIME" | "NO_PAYROLL" | "COVERAGE_TOO_LOW"

export type DeriveHourlyCostResult =
  | { ok: true; value: { hourlyCostCents: Cents; derivation: DerivationTerms } }
  | { ok: false; error: DeriveHourlyCostError; message: string; coverageBps?: number | null }

/**
 * Coste-hora **derivado** de la nómina (D3). **Propuesta, no aplicación**:
 * aplicarla es un acto de un ADMIN con `AuditLog`.
 *
 *   hourlyCostCents = ⌊ payrollCents × 60 / productiveMinutes ⌋
 *
 * `payrollCents` = Σ −aporte de las líneas del periodo cuyas cuentas caen en
 * `accountPrefixes` — default **`["640","642","645","649"]`**, configurable y
 * versionado. **`641` (indemnizaciones) queda fuera** (O-E10-11). `["640"]` es
 * `BRUTO_SIN_SS`, y la diferencia entre las dos bases es del orden del 31,9 %
 * (4 000 000 c → 2 666 c/h; 5 276 000 c → 3 517 c/h sobre 90 000 minutos).
 *
 * **O-E10-12 — de dónde sale la nómina de una persona.** `JournalLine` no tiene
 * `employeeId` y la nómina se contabiliza normalmente por CECO, no por persona:
 *
 *   `COST_CENTER` (DEFAULT) — tarifa media del CECO; se aplica a los empleados
 *                             del CECO sin tarifa propia. Honesto y suficiente.
 *   `EMPLOYEE`              — sólo si las líneas 64x llevan el `counterpartyId`
 *                             del empleado. La propuesta informa su **cobertura**
 *                             («8 de 34 líneas, 78 % del importe») y queda **no
 *                             evaluable** por debajo de `minCoverageBps`. Nunca
 *                             extrapola en silencio.
 *
 * Con 0 minutos productivos o sin nómina, **no evaluable**, nunca ∞ ni 0.
 */
export function deriveHourlyCost(input: DeriveHourlyCostInput): DeriveHourlyCostResult {
  const label =
    input.scope === "EMPLOYEE" ? `empleado ${input.employeeCode ?? "?"}` : `CECO ${input.costCenterCode ?? "?"}`
  const period = `${input.periodStart} … ${input.periodEnd}`

  if (!Number.isInteger(input.productiveMinutes) || input.productiveMinutes <= 0) {
    return {
      ok: false,
      error: "NO_PRODUCTIVE_TIME",
      message: `${label}: sin minutos productivos aprobados en ${period}; el coste-hora no es evaluable (nunca 0 ni ∞)`,
    }
  }

  const coverageBps = input.scope === "EMPLOYEE" ? bpsOf(input.matchedAmountCents, input.payrollCents) : null
  const numeratorCents = input.scope === "EMPLOYEE" ? input.matchedAmountCents : input.payrollCents

  if (!Number.isInteger(numeratorCents) || numeratorCents <= 0) {
    return {
      ok: false,
      error: "NO_PAYROLL",
      message: `${label}: sin nómina ${input.accountPrefixes.join("/")} en ${period}; el coste-hora no es evaluable`,
    }
  }

  if (input.scope === "EMPLOYEE" && (coverageBps === null || coverageBps < input.minCoverageBps)) {
    return {
      ok: false,
      error: "COVERAGE_TOO_LOW",
      coverageBps,
      message:
        `${label}: la derivación individual cubre ${input.linesMatched} de ${input.linesTotal} líneas 64x ` +
        `(${coverageBps === null ? "sin importe" : `${coverageBps} bps`} del importe), por debajo del mínimo ` +
        `${input.minCoverageBps} bps; no se extrapola en silencio (O-E10-12)`,
    }
  }

  const hourlyCostCents = Math.floor((numeratorCents * MINUTES_PER_HOUR) / input.productiveMinutes)
  if (hourlyCostCents <= 0) {
    return {
      ok: false,
      error: "NO_PAYROLL",
      message:
        `${label}: ${numeratorCents} c entre ${input.productiveMinutes} minutos da menos de un céntimo por hora; ` +
        "la propuesta no es evaluable",
    }
  }

  const derivation: DerivationTerms = {
    scope: input.scope,
    ...(input.costCenterCode === undefined ? {} : { costCenterCode: input.costCenterCode }),
    ...(input.employeeCode === undefined ? {} : { employeeCode: input.employeeCode }),
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    payrollCents: input.payrollCents,
    numeratorCents,
    accountPrefixes: [...input.accountPrefixes],
    excludedPrefixes: [...EXCLUDED_PAYROLL_PREFIXES],
    productiveMinutes: input.productiveMinutes,
    coverageBps,
    linesTotal: input.linesTotal,
    linesMatched: input.linesMatched,
    matchedAmountCents: input.matchedAmountCents,
    basis: input.basis,
    formula: "⌊ numeratorCents × 60 / productiveMinutes ⌋",
    hourlyCostCents,
  }

  return { ok: true, value: { hourlyCostCents, derivation } }
}

/** ¿La cuenta entra en la nómina de esta base? `641` nunca (O-E10-11). */
export function matchesPayrollPrefix(accountCode: string, prefixes: readonly string[]): boolean {
  if (EXCLUDED_PAYROLL_PREFIXES.some((p) => accountCode.startsWith(p))) return false
  return prefixes.some((p) => accountCode.startsWith(p))
}

// ─────────────────────────────────────────────────────────────────────────────
// O-E10-20 — la desviación de absorción
// ─────────────────────────────────────────────────────────────────────────────

export type AbsorptionDirection = "SOBREABSORCION" | "INFRAABSORCION" | "EXACTA"

export type AbsorptionRow = {
  code: string
  valuedCents: Cents
  payrollCents: Cents
  absorptionCents: Cents
  absorptionBps: number | null
  direction: AbsorptionDirection
}

export type AbsorptionReport = {
  valuedCents: Cents
  payrollCents: Cents
  /** `valorado − nómina`. Negativo = **infraabsorción**. */
  absorptionCents: Cents
  /** Sobre la nómina contabilizada. `null` con nómina 0. */
  absorptionBps: number | null
  direction: AbsorptionDirection
  byCostCenter: readonly AbsorptionRow[]
}

const directionOf = (absorption: Cents): AbsorptionDirection =>
  absorption === 0 ? "EXACTA" : absorption > 0 ? "SOBREABSORCION" : "INFRAABSORCION"

/**
 * **O-E10-20 — desviación de absorción.** La primera cifra que un CFO pide
 * cuando hay tarifas, y que la ronda 0 no tenía en ninguna pantalla:
 *
 *   absorción = Σ (minutos × tarifa / 60) − Σ (−aporte) de 64x del periodo
 *
 * con su signo, su % y su desglose por CECO.
 *
 * **No es un invariante**: I-E10-12 sólo garantiza que no se pase (`≤`), de modo
 * que una **infraabsorción del 20 % lo pasa en silencio**; y endurecerlo a
 * igualdad sería exigir horas y tarifas perfectas. Su sitio es el informe.
 */
export function absorptionVariance(input: {
  valuedCents: Cents
  payrollCents: Cents
  byCostCenter: readonly { code: string; valuedCents: Cents; payrollCents: Cents }[]
}): AbsorptionReport {
  const absorptionCents = input.valuedCents - input.payrollCents
  return {
    valuedCents: input.valuedCents,
    payrollCents: input.payrollCents,
    absorptionCents,
    absorptionBps: bpsOf(absorptionCents, input.payrollCents),
    direction: directionOf(absorptionCents),
    byCostCenter: [...input.byCostCenter]
      .sort((a, b) => cmp(a.code, b.code))
      .map((r) => {
        const abs = r.valuedCents - r.payrollCents
        return {
          code: r.code,
          valuedCents: r.valuedCents,
          payrollCents: r.payrollCents,
          absorptionCents: abs,
          absorptionBps: bpsOf(abs, r.payrollCents),
          direction: directionOf(abs),
        }
      }),
  }
}
