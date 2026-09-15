/**
 * E10 · T5 — Agregados de horas (`docs/design/E10-presupuesto-horas.md` §3.5,
 * ADR-0018 D1, `docs/design/E10-validacion-controlling.md` Q-2, Q-3, Q-7,
 * O-E10-1, O-E10-2, O-E10-3, O-E10-16, O-E10-21).
 *
 * Módulo **PURO**: sin IO, sin Prisma, sin LLM, sin `Date.now()` (lo verifica
 * `.claude/hooks/guard.sh` desde T3). Toda la aritmética es **entera**:
 * prohibidos `float`, `Decimal` y `round()` en el camino de las horas.
 *
 * **Tipos planos, a propósito.** Ni un `import` de `@/prisma/client`: las
 * uniones de cadena de este fichero reproducen, valor a valor, los enums del
 * esquema (`Driver`, `ZeroBaseFallback`, `AllocPeriod`), de modo que un
 * `AllocationRuleSpec` o un `AllocationPeriodRef` de `lib/analytics/allocate.ts`
 * es **estructuralmente asignable** a lo que estas funciones piden, sin que
 * `lib/time/**` dependa del esquema ni pueda crear un ciclo con `allocate.ts`
 * (que en T9 va a llamar aquí).
 *
 * **La unidad es el MINUTO ENTERO** (Q-2). La fuente primaria del dato es el
 * registro de jornada del art. 34.9 ET, que se lleva en `hh:mm`, y todo `hh:mm`
 * es un entero exacto de minutos; en centésimas de hora no lo es (un minuto son
 * 5/3 centésimas) y se perdería una fracción por parte, con un descuadre
 * permanente entre el registro legal y el denominador del coste-hora.
 */

import { createHash } from "node:crypto"

// ─────────────────────────────────────────────────────────────────────────────
// Tipos planos
// ─────────────────────────────────────────────────────────────────────────────

/** "YYYY-MM-DD", sin zona: es la columna `@db.Date`, un día natural. */
export type LocalDate = string

export type DateWindow = { from: LocalDate; to: LocalDate }

/** Receptor de un parte. Un parte tiene **exactamente uno** (CHECK en M3). */
export type TimeTargetKind = "PROJECT" | "COST_CENTER"

export type TimeTargetRef = { kind: TimeTargetKind; id: string; code: string }

/**
 * Un parte de horas tal y como lo ve el motor. `approved` es la proyección de
 * `TimeEntryStatus = APROBADO`; el estado completo vive en el modelo.
 */
export type TimeEntryRow = {
  id: string
  employeeId: string
  employeeCode: string
  date: LocalDate
  target: TimeTargetRef
  businessLineCode: string | null
  /** Minutos enteros. Negativo **sólo** en un contra-apunte. */
  minutes: number
  productive: boolean
  approved: boolean
}

/** Espejo de `Driver` (`prisma/schema.prisma`), sin importarlo. */
export type DriverCode =
  | "FIXED_PERCENT"
  | "REVENUE_SHARE"
  | "DIRECT_COST_SHARE"
  | "HOURS"
  | "HEADCOUNT"
  | "EQUAL"
  | "MANUAL"

/** Espejo de `ZeroBaseFallback`. */
export type ZeroBaseFallbackCode = "SKIP_WARN" | "EQUAL" | "YTD" | "PRIOR_PERIOD"

/** Espejo de `AllocPeriod`. */
export type AllocPeriodKind = "MONTH" | "QUARTER" | "YEAR"

/** Espejo de `TargetKind` (sin `MIXED`, que E10 retira: deuda §0-bis #3). */
export type TargetKindCode = "PROJECTS" | "BUSINESS_LINES" | "COST_CENTERS"

/** Lo único que `timeWindowOf` necesita de una `AllocationRuleSpec`. */
export type TimeRuleSpec = {
  driver: DriverCode
  zeroBaseFallback: ZeroBaseFallbackCode
}

/** Lo único que `timeWindowOf` necesita de un `AllocationPeriodRef`. */
export type TimePeriodRef = {
  kind: AllocPeriodKind
  /** Etiqueta canónica del periodo: `2026-11`, `2026-Q2`, `2026`. */
  label: string
  start: LocalDate
  end: LocalDate
  fiscalYearStart: LocalDate
}

/** Snapshot de plantilla a fin de mes por CECO (`HeadcountSnapshot`). */
export type HeadcountRow = {
  costCenterId: string
  costCenterCode: string
  /** **Último día** del mes: el stock es a fin de periodo (D1). */
  periodEnd: LocalDate
  /** Milésimas de FTE; 1000 = una jornada completa. */
  fteMilli: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Constantes y errores
// ─────────────────────────────────────────────────────────────────────────────

export const MINUTES_PER_HOUR = 60

/**
 * Techo por parte y, agregado, por (empleado, fecha) — **O-E10-21**. El CHECK de
 * la base es `BETWEEN -1440 AND 1440` **por fila**, que no ve cuatro partes de
 * 1 440 minutos el mismo día: el agregado lo comprueba `dailyMinutesExcesses`
 * (I-E10-10) y aquí se rechaza la fila que ya viene fuera de rango.
 */
export const DAILY_MINUTES_CEILING = 1440

/** `timeHash` de un run sin ninguna regla de driver de actividad (D1). */
export const EMPTY_TIME_HASH = "∅"

export type TimeErrorCode =
  | "MINUTES_NOT_INTEGER"
  | "MINUTES_OUT_OF_RANGE"
  | "INVALID_DATE"
  | "HEADCOUNT_TARGET_KIND"
  | "FTE_NEGATIVE"

export class TimeAggregateError extends Error {
  constructor(
    readonly code: TimeErrorCode,
    message: string
  ) {
    super(message)
    this.name = "TimeAggregateError"
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades internas
// ─────────────────────────────────────────────────────────────────────────────

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n))

const sha256 = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex")

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const within = (date: LocalDate, w: DateWindow): boolean => date >= w.from && date <= w.to

/**
 * Rechaza lo que no puede entrar en un agregado de horas. Es **rechazo**, no
 * saneamiento: un parte de 1 500 minutos es un dato imposible (25 h en un día) y
 * dejarlo pasar produciría una base de reparto y un coste con una hora que nadie
 * trabajó. La misma doctrina que `assertCents` en `lib/money.ts`.
 */
export function assertTimeEntryRow(row: TimeEntryRow): void {
  if (!DATE_RE.test(row.date)) {
    throw new TimeAggregateError("INVALID_DATE", `parte ${row.id}: fecha «${row.date}» no es YYYY-MM-DD`)
  }
  if (!Number.isInteger(row.minutes)) {
    throw new TimeAggregateError(
      "MINUTES_NOT_INTEGER",
      `parte ${row.id} (${row.employeeCode}, ${row.date}): los minutos deben ser enteros (Q-2), recibido ${row.minutes}`
    )
  }
  if (Math.abs(row.minutes) > DAILY_MINUTES_CEILING) {
    throw new TimeAggregateError(
      "MINUTES_OUT_OF_RANGE",
      `parte ${row.id} (${row.employeeCode}, ${row.date}): ${row.minutes} minutos supera el techo diario de ` +
        `±${DAILY_MINUTES_CEILING} (O-E10-21)`
    )
  }
}

const assertRows = (rows: readonly TimeEntryRow[]): void => {
  for (const row of rows) assertTimeEntryRow(row)
}

/** Puntos básicos enteros de `part / base`, truncando hacia cero. `null` sin base. */
function shareBps(part: number, base: number): number | null {
  if (base === 0) return null
  return Math.trunc((part * 10000) / base)
}

// ─────────────────────────────────────────────────────────────────────────────
// O-E10-1 — la ventana que el run consume de verdad
// ─────────────────────────────────────────────────────────────────────────────

/** ¿El driver consume la base de horas / plantilla? */
export function isActivityDriver(driver: DriverCode): boolean {
  return driver === "HOURS" || driver === "HEADCOUNT"
}

/** Primer día del periodo **anterior** al de `period`. Espejo de `priorPeriodWindow`. */
export function priorPeriodStart(kind: AllocPeriodKind, label: string): LocalDate {
  const y = Number(label.slice(0, 4))
  if (kind === "YEAR") return `${y - 1}-01-01`
  if (kind === "QUARTER") {
    const q = Number(label.slice(-1))
    return q === 1 ? `${y - 1}-10-01` : `${y}-${pad2(3 * (q - 1) - 2)}-01`
  }
  const m = Number(label.slice(5, 7))
  return m === 1 ? `${y - 1}-12-01` : `${y}-${pad2(m - 1)}-01`
}

/**
 * **O-E10-1 — la ventana efectivamente consumida por el run.** Pura, y la usan
 * **el sellado del `timeHash` y la derivación de `STALE`**, para que no puedan
 * discrepar:
 *
 *   alguna regla con `YTD`          ⇒ [inicio del ejercicio, periodEnd]
 *   alguna regla con `PRIOR_PERIOD` ⇒ [inicio del periodo anterior, periodEnd]
 *   en el resto                     ⇒ [periodStart, periodEnd]
 *
 * y con las dos primeras a la vez, la **unión**: la más ancha.
 *
 * Devuelve `null` cuando **ninguna** regla del run usa un driver de actividad;
 * entonces el `timeHash` es `"∅"` y `timeHashWindowStart/End` quedan a `NULL`.
 *
 * *Por qué la ventana y no sólo el hash:* con el sello acotado al periodo, un run
 * de marzo con `zeroBaseFallback = YTD` reparte usando partes de **enero**, y
 * aprobar en mayo un parte de enero de 800 minutos **no cambiaba el `timeHash` de
 * marzo**: el run no aparecía `STALE` y lucía vigente con un reparto que ya no se
 * reproduce — literalmente el fallo que D1 dice cerrar. Lo comprueba I-E10-17.
 *
 * *Y el ensanche lo dispara sólo una regla de DRIVER DE ACTIVIDAD* (revisión de
 * la ronda 1, PUEDE 12). Antes lo disparaba cualquier regla del run —también una
 * `REVENUE_SHARE` con `zeroBaseFallback = YTD`—, y aunque eso nunca rompía
 * I-E10-17 —la ventana sellada **contiene** la usada, y sellar de más es seguro—
 * sí declaraba `STALE` un run por un parte de enero que **ninguna regla del run
 * habría consumido**. Un run que caduca sin motivo se vuelve ruido, y el ruido
 * es lo que hace que nadie mire el cuarto sello.
 */
export function timeWindowOf(rules: readonly TimeRuleSpec[], period: TimePeriodRef): DateWindow | null {
  if (!rules.some((r) => isActivityDriver(r.driver))) return null
  let from = period.start
  for (const rule of rules) {
    if (!isActivityDriver(rule.driver)) continue
    if (rule.zeroBaseFallback === "YTD" && period.fiscalYearStart < from) from = period.fiscalYearStart
    if (rule.zeroBaseFallback === "PRIOR_PERIOD") {
      const prior = priorPeriodStart(period.kind, period.label)
      if (prior < from) from = prior
    }
  }
  return { from, to: period.end }
}

// ─────────────────────────────────────────────────────────────────────────────
// Agregados por receptor y por empleado
// ─────────────────────────────────────────────────────────────────────────────

export type TargetMinutes = {
  code: string
  id: string
  kind: TimeTargetKind
  minutes: number
}

export type MinutesOptions = {
  productiveOnly: boolean
  /** **R-H-3**: sólo aprobados. Es `true` y no hay otra opción, a propósito. */
  approvedOnly: true
}

const eligible = (row: TimeEntryRow, window: DateWindow, opts: { productiveOnly: boolean }): boolean =>
  row.approved && within(row.date, window) && (!opts.productiveOnly || row.productive)

/**
 * Minutos por receptor en una ventana. **Sólo aprobados** (R-H-3) y, con
 * `productiveOnly`, sólo productivos (Q-3: las no productivas no consumen
 * estructura de proyecto).
 *
 * Los **contra-apuntes suman con su signo**, así que una entrada corregida aporta
 * exactamente su neto sin que nadie tenga que filtrarla. El `max(0, ·)` que el
 * driver aplica es del driver: aquí sale el neto real, aunque sea negativo, para
 * que quien lo consuma pueda verlo.
 *
 * Determinista: el resultado va ordenado por código de receptor (y, para dos
 * códigos iguales de tipos distintos, por tipo y por id).
 */
export function minutesByTarget(
  rows: readonly TimeEntryRow[],
  window: DateWindow,
  opts: MinutesOptions
): readonly TargetMinutes[] {
  assertRows(rows)
  const acc = new Map<string, TargetMinutes>()
  for (const row of rows) {
    if (!eligible(row, window, opts)) continue
    const key = `${row.target.kind}|${row.target.id}`
    const cur = acc.get(key)
    if (cur) cur.minutes += row.minutes
    else acc.set(key, { code: row.target.code, id: row.target.id, kind: row.target.kind, minutes: row.minutes })
  }
  return [...acc.values()].sort((a, b) => cmp(a.code, b.code) || cmp(a.kind, b.kind) || cmp(a.id, b.id))
}

export type EmployeeMinutes = { employeeCode: string; employeeId: string; minutes: number }

/** Ídem por empleado; el denominador del coste-hora sale de aquí (Q-3). */
export function minutesByEmployee(
  rows: readonly TimeEntryRow[],
  window: DateWindow,
  opts: MinutesOptions
): readonly EmployeeMinutes[] {
  assertRows(rows)
  const acc = new Map<string, EmployeeMinutes>()
  for (const row of rows) {
    if (!eligible(row, window, opts)) continue
    const cur = acc.get(row.employeeId)
    if (cur) cur.minutes += row.minutes
    else acc.set(row.employeeId, { employeeCode: row.employeeCode, employeeId: row.employeeId, minutes: row.minutes })
  }
  return [...acc.values()].sort((a, b) => cmp(a.employeeCode, b.employeeCode) || cmp(a.employeeId, b.employeeId))
}

export type UnapprovedTargetMinutes = {
  code: string
  id: string
  kind: TimeTargetKind
  unapprovedMinutes: number
  /** Sobre la base **aprobada total** de la ventana. `null` con base 0. */
  shareOfBaseBps: number | null
}

/**
 * **O-E10-2 — lo que falta por aprobar.** No es un detalle: sin esto, un reparto
 * hecho sobre el 75 % de la actividad se publica **en silencio**.
 *
 * Devuelve, por receptor y para la ventana del driver, los minutos **sin
 * aprobar** y el porcentaje que representan sobre la base aprobada (la de todos
 * los receptores, que es la que el reparto usa como denominador).
 *
 * *El caso peligroso es el parcial, no el cero*: con `CC-OPS` repartiendo
 * 900 000 c, base aprobada 36 000 min y 12 000 min de P-03 sin firmar, el reparto
 * sale 480 000 / 270 000 / 150 000 y con la base completa habría sido
 * 360 000 / 202 500 / 337 500 — **187 500 c de diferencia en P-03**. De ahí que
 * `W-E10-UNAPPROVED-HOURS` se emita **siempre** que esto devuelva algo, y que
 * mueva el sello del propio `AllocationRun` con `HORAS_SIN_APROBAR`.
 */
export function unapprovedMinutesByTarget(
  rows: readonly TimeEntryRow[],
  window: DateWindow,
  opts: { productiveOnly: boolean }
): readonly UnapprovedTargetMinutes[] {
  assertRows(rows)
  let base = 0
  const acc = new Map<string, { code: string; id: string; kind: TimeTargetKind; minutes: number }>()
  for (const row of rows) {
    if (!within(row.date, window)) continue
    if (opts.productiveOnly && !row.productive) continue
    if (row.approved) {
      base += row.minutes
      continue
    }
    const key = `${row.target.kind}|${row.target.id}`
    const cur = acc.get(key)
    if (cur) cur.minutes += row.minutes
    else acc.set(key, { code: row.target.code, id: row.target.id, kind: row.target.kind, minutes: row.minutes })
  }
  return [...acc.values()]
    .filter((t) => t.minutes !== 0)
    .sort((a, b) => cmp(a.code, b.code) || cmp(a.kind, b.kind) || cmp(a.id, b.id))
    .map((t) => ({
      code: t.code,
      id: t.id,
      kind: t.kind,
      unapprovedMinutes: t.minutes,
      shareOfBaseBps: shareBps(t.minutes, base),
    }))
}

/** Σ de los minutos sin aprobar de la ventana, y su % sobre la base aprobada. */
export function unapprovedSummary(
  rows: readonly TimeEntryRow[],
  window: DateWindow,
  opts: { productiveOnly: boolean }
): { unapprovedMinutes: number; approvedBaseMinutes: number; shareOfBaseBps: number | null; targets: readonly string[] } {
  const byTarget = unapprovedMinutesByTarget(rows, window, opts)
  const approvedBaseMinutes = minutesByTarget(rows, window, { ...opts, approvedOnly: true }).reduce(
    (a, t) => a + t.minutes,
    0
  )
  const unapprovedMinutes = byTarget.reduce((a, t) => a + t.unapprovedMinutes, 0)
  return {
    unapprovedMinutes,
    approvedBaseMinutes,
    shareOfBaseBps: shareBps(unapprovedMinutes, approvedBaseMinutes),
    targets: byTarget.map((t) => t.code),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// O-E10-21 — el techo diario, agregado
// ─────────────────────────────────────────────────────────────────────────────

export type DailyExcess = { employeeCode: string; employeeId: string; date: LocalDate; minutes: number }

/**
 * **O-E10-21 / I-E10-10** — `Σ minutos por (empleado, fecha) ≤ 1 440`, con los
 * contra-apuntes a su signo. El CHECK de la base es por fila y no ve cuatro
 * partes de 1 440 minutos el mismo día: 96 h en una jornada, cada una legal por
 * separado. Se evalúa sobre **todos** los partes (aprobados o no) del rango.
 */
export function dailyMinutesExcesses(rows: readonly TimeEntryRow[], window?: DateWindow): readonly DailyExcess[] {
  assertRows(rows)
  const acc = new Map<string, DailyExcess>()
  for (const row of rows) {
    if (window && !within(row.date, window)) continue
    const key = `${row.employeeId}|${row.date}`
    const cur = acc.get(key)
    if (cur) cur.minutes += row.minutes
    else
      acc.set(key, {
        employeeCode: row.employeeCode,
        employeeId: row.employeeId,
        date: row.date,
        minutes: row.minutes,
      })
  }
  return [...acc.values()]
    .filter((d) => d.minutes > DAILY_MINUTES_CEILING)
    .sort((a, b) => cmp(a.employeeCode, b.employeeCode) || cmp(a.date, b.date))
}

// ─────────────────────────────────────────────────────────────────────────────
// O-E10-3 — UNA sola forma canónica, y el cuarto sello
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **O-E10-3 — UNA sola forma canónica**, la misma en el motor, en el ADR y en el
 * fixture:
 *
 *   `fecha|códigoEmpleado|códigoReceptor|minutos|productiva`
 *
 * ordenada por esa misma tupla, un renglón por parte, **sólo entradas APROBADAS**
 * de la ventana (productivas y no productivas: el sello detecta cualquier cambio
 * de la base, y `productive` es parte del dato).
 *
 * **Sin `id`**: la ronda 0 lo incluía —un uuid aleatorio— y con él el hash de un
 * fixture recargado **nunca** habría coincidido, tumbando la reproducibilidad
 * byte a byte de T10 y el criterio 12. El `id` sólo desempata dos renglones
 * **idénticos**, en cuyo caso el hash no cambia.
 */
export function canonicalTimeForm(rows: readonly TimeEntryRow[], window: DateWindow): string {
  assertRows(rows)
  return rows
    .filter((r) => r.approved && within(r.date, window))
    .map((r) => ({
      row: [r.date, r.employeeCode, r.target.code, String(r.minutes), r.productive ? "1" : "0"].join("|"),
      id: r.id,
    }))
    .sort((a, b) => cmp(a.row, b.row) || cmp(a.id, b.id))
    .map((r) => r.row)
    .join("\n")
}

/**
 * El **cuarto sello** del `AllocationRun` (D1). `"∅"` cuando el run no tiene
 * ninguna regla de driver de actividad —y entonces `timeHashWindowStart/End`
 * quedan a `NULL`—, que es lo que devuelve `timeWindowOf` como `null`.
 */
export function timeHash(rows: readonly TimeEntryRow[], window: DateWindow | null): string {
  if (window === null) return EMPTY_TIME_HASH
  return sha256(canonicalTimeForm(rows, window))
}

// ─────────────────────────────────────────────────────────────────────────────
// Q-7 / O-E10-16 — la base de `HEADCOUNT`, en FTE·mes
// ─────────────────────────────────────────────────────────────────────────────

export type HeadcountWeight = {
  code: string
  id: string
  /** Σ `fteMilli` de los snapshots del periodo. Sin media y sin división. */
  fteMilli: number
  snapshotCount: number
  /**
   * `false` = **no hay ningún snapshot** en el periodo: hueco de datos, peso 0,
   * `W-E10-NO-HEADCOUNT` y motivo de sello `PLANTILLA_AUSENTE`. Un snapshot con
   * `fteMilli = 0` sí es un dato: `declared: true` y **ningún motivo**.
   */
  declared: boolean
}

/**
 * **`HEADCOUNT` sólo reparte a CECOs** (D1). Con proyectos no hay plantilla
 * declarada y derivarla de las horas sería `HOURS` con otro nombre: el mismo
 * dato, dos veces, con dos resultados posibles. Lo comprueban además el CHECK de
 * M4 y la validación de la acción.
 */
export function assertHeadcountTargetKind(targetKind: TargetKindCode, ruleCode?: string): void {
  if (targetKind !== "COST_CENTERS") {
    throw new TimeAggregateError(
      "HEADCOUNT_TARGET_KIND",
      `${ruleCode ? `regla ${ruleCode}: ` : ""}el driver HEADCOUNT sólo admite targetKind = COST_CENTERS, ` +
        `recibido ${targetKind} (ADR-0018 D1)`
    )
  }
}

/**
 * **Q-7 / O-E10-16 — FTE·mes.** Peso de cada CECO = `Σ fteMilli` de los
 * `HeadcountSnapshot` cuyo **fin de mes cae dentro del periodo del run**. Sin
 * media, sin división y sin redondeo.
 *
 * Para un run `MONTH` hay **un solo snapshot** por receptor, así que es
 * exactamente el «stock a fin de periodo» que fijó E5 y el fixture no se mueve.
 * Para `QUARTER` y `YEAR` deja de ser falso: un CECO que vive de febrero a
 * noviembre tenía **peso 0** en el run anual —stock a 31-12— y no absorbía nada
 * de sus diez meses vivos, trasladando esa estructura a los demás.
 *
 * `opts.eligible` declara los receptores de la regla: los que no tengan ningún
 * snapshot salen con peso 0 y `declared: false`, que es lo que distingue «no hay
 * nadie» de «no lo hemos rellenado» (ADR-0013 D4).
 */
export function fteMonthsByCostCenter(
  rows: readonly HeadcountRow[],
  window: DateWindow,
  opts: { eligible?: readonly { id: string; code: string }[] } = {}
): readonly HeadcountWeight[] {
  const acc = new Map<string, HeadcountWeight>()
  for (const target of opts.eligible ?? []) {
    acc.set(target.id, { code: target.code, id: target.id, fteMilli: 0, snapshotCount: 0, declared: false })
  }
  for (const row of rows) {
    if (!DATE_RE.test(row.periodEnd)) {
      throw new TimeAggregateError("INVALID_DATE", `snapshot de ${row.costCenterCode}: fecha «${row.periodEnd}» inválida`)
    }
    if (!Number.isInteger(row.fteMilli) || row.fteMilli < 0) {
      throw new TimeAggregateError(
        "FTE_NEGATIVE",
        `snapshot de ${row.costCenterCode} a ${row.periodEnd}: fteMilli debe ser un entero ≥ 0, recibido ${row.fteMilli}`
      )
    }
    if (!within(row.periodEnd, window)) continue
    if (opts.eligible && !acc.has(row.costCenterId)) continue
    const cur = acc.get(row.costCenterId)
    if (cur) {
      cur.fteMilli += row.fteMilli
      cur.snapshotCount += 1
      cur.declared = true
    } else {
      acc.set(row.costCenterId, {
        code: row.costCenterCode,
        id: row.costCenterId,
        fteMilli: row.fteMilli,
        snapshotCount: 1,
        declared: true,
      })
    }
  }
  return [...acc.values()].sort((a, b) => cmp(a.code, b.code) || cmp(a.id, b.id))
}
