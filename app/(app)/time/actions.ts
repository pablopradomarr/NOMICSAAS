"use server"

/**
 * E10 · T14 — Server actions de los **partes de horas** (§4.2, §4.3 y §10).
 *
 * Cuatro reglas que se aplican aquí y en ningún otro sitio:
 *
 *  · **B-9 (§4.3)** — un mes bloqueado no admite partes nuevos, correcciones ni
 *    aprobaciones: sus horas ya alimentaron una liquidación y un informe
 *    rendidos. Barrera 1 es esta llamada a `assertMonthOpenForTime`; barrera 2,
 *    el trigger. La barrera 1 existe para que el mensaje diga **qué mes** y qué
 *    hacer, en vez de un `23514` en crudo.
 *  · **R-H-4** — nadie aprueba sus propios partes, salvo un `ADMIN`. El rol
 *    viaja desde `withOrg` como `actorIsAdmin`: el modelo no sabe de sesiones.
 *  · **Datos de personas (§10)** — un `VIEWER` ve el **agregado**; el detalle
 *    nominal por empleado exige `EDITOR`. Un `VIEWER` sigue viendo sus propios
 *    partes con su nombre, que son suyos.
 *  · **El reloj es del borde** — `approvedAt` se decide aquí, nunca dentro del
 *    modelo ni del motor.
 */

import { createHash } from "node:crypto"

import {
  approveTimeEntriesSchema,
  correctTimeEntrySchema,
  createTimeEntriesSchema,
  importTimeCsvSchema,
  listTimeEntriesSchema,
  timeCalendarSchema,
  TIME_CSV_COLUMNS,
} from "@/forms/time"
import { formatE10Errors } from "@/forms/e10-errors"
import { parseCsvRows } from "@/lib/accounts/csv"
import { ActionState } from "@/lib/actions"
import { readTimeCalendar, readTimeList } from "@/app/(app)/time/shared"
import { withOrg } from "@/lib/authz"
import { tenantTransaction } from "@/lib/db"
import { listEmployees } from "@/models/employees"
import { getAnalyticsConfig } from "@/models/analytics"
import {
  approveTimeEntriesTx,
  assertMonthOpenForTime,
  correctTimeEntryTx,
  createTimeEntriesTx,
  importTimeCsvTx,
  type CreateTimeEntriesResult,
  type ImportReport,
  type TargetMonthMinutes,
  type TimeEntryInput,
  type TimeEntryListItem,
} from "@/models/time"
import { runLedgerTransaction, type LedgerResult } from "@/models/ledger"
import { Role } from "@/prisma/client"
import { revalidatePath } from "next/cache"
import { z } from "zod"

const TIME_PATH = "/time"
const PYG_PATH = "/analytics/pyg"

const invalid = (error: z.ZodError): ActionState<never> => ({
  success: false,
  error: error.issues[0]?.message ?? "Datos inválidos",
})

const toActionState = <T,>(result: LedgerResult<T>): ActionState<T> =>
  result.ok ? { success: true, data: result.value } : { success: false, error: formatE10Errors(result.errors) }

function revalidateTime(): void {
  revalidatePath(TIME_PATH)
  revalidatePath(PYG_PATH)
}

// ─────────────────────────────────────────────────────────────────────────────
// Contratos de salida (C3 arranca de aquí)
// ─────────────────────────────────────────────────────────────────────────────

export type TimeListPayload = {
  entries: readonly TimeEntryListItem[]
  total: number
  /** Banda del mes: Σ aprobadas, Σ pendientes y el peso de las pendientes. */
  approvedMinutes: number
  unapprovedMinutes: number
  unapprovedShareBps: number | null
  /** El agregado por receptor y mes, que es lo único que ve un `VIEWER` ciego. */
  aggregate: readonly TargetMonthMinutes[]
  /** `true` = se han ocultado nombres por la regla de datos de personas (§10). */
  redacted: boolean
}

export type TimeCalendarCell = {
  employeeId: string
  employeeCode: string
  employeeName: string
  date: string
  minutes: number
  approvedMinutes: number
  /** Los proyectos del día, para colorear la celda. */
  targets: readonly string[]
}

export type TimeCalendarPayload = {
  month: string
  cells: readonly TimeCalendarCell[]
  totalMinutes: number
  /** Días que pasan de 24 h sumando TODOS los partes (O-E10-21). */
  overCeiling: readonly { employeeCode: string; date: string; minutes: number }[]
}

export type TimeImportPayload = ImportReport & { dryRun: boolean; parsed: number; fileSha256: string }

// ─────────────────────────────────────────────────────────────────────────────
// Lecturas (VIEWER)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lista de partes con la banda del mes. **§10**: sin `EDITOR`, los nombres de
 * otras personas no viajan —el coste y las horas de una persona son datos
 * suyos—, pero el agregado sí, que es la cifra de gestión.
 */
export const listTimeEntriesAction = withOrg(
  Role.VIEWER,
  async ({ org, user, role }, input: unknown = {}): Promise<ActionState<TimeListPayload>> => {
    const parsed = listTimeEntriesSchema.safeParse(input ?? {})
    if (!parsed.success) return invalid(parsed.error)
    const { skip, take, ...filter } = parsed.data
    // **DEBE 7**: la lectura vive en `shared.ts` y acepta el cliente, para que la
    // página la haga dentro del `db` de `tenantPage` (una transacción por
    // petición). Aquí la acción abre la suya porque la llama el cliente, que no
    // tiene ninguna abierta.
    const data = await tenantTransaction(org.id, user.id, async (tx) =>
      readTimeList(tx, { filter, page: { skip, take }, userId: user.id, role })
    )
    return { success: true, data }
  }
)

/**
 * Calendario mensual por empleado: una celda por (empleado, día) con sus
 * minutos y los proyectos que los soportan. El **techo diario agregado**
 * (O-E10-21) se marca aquí, que es donde el usuario lo ve.
 */
export const timeCalendarAction = withOrg(
  Role.VIEWER,
  async ({ org, user, role }, input: unknown): Promise<ActionState<TimeCalendarPayload>> => {
    const parsed = timeCalendarSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const data = await tenantTransaction(org.id, user.id, async (tx) =>
      readTimeCalendar(tx, {
        month: parsed.data.month,
        ...(parsed.data.employeeId ? { employeeId: parsed.data.employeeId } : {}),
        role,
      })
    )
    return { success: true, data }
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Captura y aprobación (EDITOR)
// ─────────────────────────────────────────────────────────────────────────────

export const createTimeEntriesAction = withOrg(
  Role.EDITOR,
  async ({ org, user }, input: unknown): Promise<ActionState<CreateTimeEntriesResult>> => {
    const parsed = createTimeEntriesSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const rows = parsed.data.rows
    const result = await runLedgerTransaction(org.id, user.id, async (tx) => {
      // B-9, barrera 1: una fecha por mes distinto, en serie.
      for (const date of distinctMonths(rows.map((r) => r.date))) await assertMonthOpenForTime(tx, date)
      return createTimeEntriesTx(tx, rows.map(toEntryInput), { userId: user.id })
    })
    if (result.ok) revalidateTime()
    return toActionState(result)
  }
)

/**
 * **R-H-4** — un `EDITOR` no aprueba sus propios partes; un `ADMIN`, sí. La
 * segregación P5 no se puede comprobar en el modelo, que no sabe qué rol tiene
 * quien llama: el rol viaja desde aquí.
 */
export const approveTimeEntriesAction = withOrg(
  Role.EDITOR,
  async ({ org, user, role }, input: unknown): Promise<ActionState<{ approved: number; skipped: number }>> => {
    const parsed = approveTimeEntriesSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const approvedAt = new Date()
    const result = await runLedgerTransaction(org.id, user.id, async (tx) => {
      // B-9: aprobar un parte de un mes bloqueado es cambiar la base de una
      // liquidación ya rendida. Las fechas salen de los propios partes.
      const rows = await tx.timeEntry.findMany({ where: { id: { in: parsed.data.ids } }, select: { date: true } })
      for (const date of distinctMonths(rows.map((r) => r.date.toISOString().slice(0, 10)))) {
        await assertMonthOpenForTime(tx, date)
      }
      return approveTimeEntriesTx(
        tx,
        { ids: parsed.data.ids, approvedAt, actorIsAdmin: role === Role.ADMIN },
        { userId: user.id }
      )
    })
    if (result.ok) revalidateTime()
    return toActionState(result)
  }
)

/**
 * **I-E10-4** — la corrección es un **contra-apunte** con motivo ≥ 10
 * caracteres: el parte original sigue ahí y el neto del día baja exactamente
 * esos minutos. Nunca un `UPDATE` sobre lo aprobado, nunca un `DELETE`.
 */
export const correctTimeEntryAction = withOrg(
  Role.EDITOR,
  async ({ org, user }, input: unknown): Promise<ActionState<{ id: string }>> => {
    const parsed = correctTimeEntrySchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const approvedAt = new Date()
    const result = await runLedgerTransaction(org.id, user.id, async (tx) => {
      const original = await tx.timeEntry.findFirst({ where: { id: parsed.data.entryId }, select: { date: true } })
      if (original) await assertMonthOpenForTime(tx, original.date.toISOString().slice(0, 10))
      return correctTimeEntryTx(tx, { ...parsed.data, approvedAt }, { userId: user.id })
    })
    if (result.ok) revalidateTime()
    return toActionState(result)
  }
)

/**
 * Import CSV **idempotente por `importKey = sha256(fichero ‖ nº de línea)`**:
 * reimportar el mismo fichero inserta 0 filas y el informe dice por qué. El
 * parseo es **en servidor**, con lista blanca de columnas, y con `dryRun` no se
 * escribe nada.
 */
export const importTimeCsvAction = withOrg(
  Role.EDITOR,
  async ({ org, user }, input: unknown): Promise<ActionState<TimeImportPayload>> => {
    const parsed = importTimeCsvSchema.safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const data = parsed.data
    const fileSha256 = createHash("sha256").update(data.csv, "utf8").digest("hex")

    const result = await runLedgerTransaction(org.id, user.id, async (tx) => {
      const employees = await listEmployees(tx, { includeArchived: true })
      const config = await getAnalyticsConfig(tx, { periodEnd: todayish(data.csv) })
      const file = parseTimeCsv(data.csv, data.delimiter, employees, config)

      if (data.dryRun) {
        return {
          inserted: 0,
          skipped: file.rejected.length,
          reasons: file.rejected,
          dryRun: true,
          parsed: file.rows.length,
          fileSha256,
        }
      }
      for (const date of distinctMonths(file.rows.map((r) => r.date))) await assertMonthOpenForTime(tx, date)
      const report = await importTimeCsvTx(tx, { rows: file.rows, fileSha256 }, { userId: user.id })
      return {
        ...report,
        skipped: report.skipped + file.rejected.length,
        reasons: [...report.reasons, ...file.rejected],
        dryRun: false,
        parsed: file.rows.length,
        fileSha256,
      }
    })
    if (result.ok && !result.value.dryRun) revalidateTime()
    return toActionState(result)
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Interno
// ─────────────────────────────────────────────────────────────────────────────

const toEntryInput = (r: {
  employeeId: string
  date: string
  projectId?: string | null
  costCenterId?: string | null
  businessLineId?: string | null
  minutes: number
  productive?: boolean
  note?: string | null
}): TimeEntryInput => ({
  employeeId: r.employeeId,
  date: r.date,
  projectId: r.projectId ?? null,
  costCenterId: r.costCenterId ?? null,
  businessLineId: r.businessLineId ?? null,
  minutes: r.minutes,
  productive: r.productive ?? true,
  note: r.note ?? null,
  source: "MANUAL",
})

/** Una fecha por mes distinto: B-9 se comprueba por MES, no por parte. */
function distinctMonths(dates: readonly string[]): string[] {
  const seen = new Map<string, string>()
  for (const date of dates) if (!seen.has(date.slice(0, 7))) seen.set(date.slice(0, 7), date)
  return [...seen.values()]
}


/**
 * La configuración analítica se resuelve a la fecha MÁS TARDÍA del fichero: el
 * destino de un parte se valida contra el catálogo vigente ese día, no contra el
 * de hoy. Si el fichero no trae ninguna fecha legible, cae en la primera.
 */
function todayish(csv: string): string {
  const dates = csv.match(/\d{4}-\d{2}-\d{2}/g)
  return dates && dates.length > 0 ? dates.sort()[dates.length - 1] : "1970-01-01"
}

type ParsedTimeCsv = { rows: (TimeEntryInput & { lineNo: number })[]; rejected: { line: number; reason: string }[] }

function parseTimeCsv(
  text: string,
  delimiter: string,
  employees: readonly { id: string; code: string }[],
  config: { projects: readonly { id: string; code: string }[]; costCenters: readonly { id: string; code: string }[] }
): ParsedTimeCsv {
  const out: ParsedTimeCsv = { rows: [], rejected: [] }
  const grid = parseCsvRows(text, delimiter)
  if (grid.length === 0) return out

  const header = grid[0].map((h) => h.trim().toLowerCase())
  const index = (name: (typeof TIME_CSV_COLUMNS)[number]): number => header.indexOf(name)
  const missing = (["empleado", "fecha", "minutos"] as const).filter((c) => index(c) < 0)
  if (missing.length > 0) {
    out.rejected.push({ line: 1, reason: `faltan columnas obligatorias en la cabecera: ${missing.join(", ")}` })
    return out
  }

  const employeeByCode = new Map(employees.map((e) => [e.code.toUpperCase(), e]))
  const projectByCode = new Map(config.projects.map((p) => [p.code.toUpperCase(), p]))
  const cecoByCode = new Map(config.costCenters.map((c) => [c.code.toUpperCase(), c]))

  for (let i = 1; i < grid.length; i += 1) {
    const lineNo = i + 1
    const row = grid[i]
    if (row.every((v) => v.trim() === "")) continue
    const get = (name: (typeof TIME_CSV_COLUMNS)[number]): string => {
      const at = index(name)
      return at < 0 ? "" : (row[at] ?? "").trim()
    }

    const employee = employeeByCode.get(get("empleado").toUpperCase())
    if (!employee) {
      out.rejected.push({ line: lineNo, reason: `el empleado «${get("empleado")}» no existe en esta organización` })
      continue
    }
    const date = get("fecha")
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      out.rejected.push({ line: lineNo, reason: `la fecha «${date}» no tiene el formato AAAA-MM-DD` })
      continue
    }
    const minutes = Number(get("minutos"))
    if (!Number.isInteger(minutes) || minutes === 0 || Math.abs(minutes) > 1440) {
      out.rejected.push({
        line: lineNo,
        reason: `los minutos «${get("minutos")}» no son un entero distinto de 0 y de hasta 1 440 por fila`,
      })
      continue
    }
    const projectCode = get("proyecto").toUpperCase()
    const cecoCode = get("centro_coste").toUpperCase()
    if ((projectCode === "") === (cecoCode === "")) {
      out.rejected.push({ line: lineNo, reason: "la fila lleva UN proyecto o UN centro de coste, nunca los dos ni ninguno" })
      continue
    }
    const project = projectCode ? projectByCode.get(projectCode) : undefined
    const ceco = cecoCode ? cecoByCode.get(cecoCode) : undefined
    if (projectCode && !project) {
      out.rejected.push({ line: lineNo, reason: `el proyecto «${projectCode}» no existe en esta organización` })
      continue
    }
    if (cecoCode && !ceco) {
      out.rejected.push({ line: lineNo, reason: `el centro de coste «${cecoCode}» no existe en esta organización` })
      continue
    }
    const productiveRaw = get("productivo").toLowerCase()
    out.rows.push({
      lineNo,
      employeeId: employee.id,
      date,
      projectId: project?.id ?? null,
      costCenterId: ceco?.id ?? null,
      businessLineId: null,
      minutes,
      productive: productiveRaw === "" ? true : ["1", "si", "sí", "true", "x"].includes(productiveRaw),
      note: get("nota") === "" ? null : get("nota"),
      source: "CSV_IMPORT",
    })
  }
  return out
}
