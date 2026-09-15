/**
 * E10 · **DEBE 7 de la revisión de la ronda 1** — las LECTURAS de `/time`,
 * separadas de las server actions.
 *
 * §9 exige **una transacción por petición (`tenantPage`)**, y la ronda 0 abría
 * en esta pantalla la de `tenantPage` más una por cada acción invocada
 * (`listTimeEntriesAction`, `timeCalendarAction`, `listEmployeesAction`) y un
 * `tenantTransaction` suelto para `getAnalyticsConfig`: **cinco por render**. No
 * había N+1 por fila —los agregados son correctos—, pero sí N transacciones.
 *
 * La salida es la misma que usa `/analytics/pyg`: la lectura vive en una función
 * que **acepta el cliente**, la página la llama con el `db` de `tenantPage` y las
 * server actions quedan para las mutaciones (y para el cliente, que sí necesita
 * su propia transacción porque no hay ninguna abierta).
 *
 * No calcula ninguna cifra contable: agrega minutos ya leídos y redacta lo que
 * la matriz de roles de §10 no deja ver.
 */

import type { AnyClient } from "@/models/ledger"
import { listEmployees } from "@/models/employees"
import { listTimeEntries, minutesByTargetMonthSql } from "@/models/time"
import { Role } from "@/prisma/client"

export type TimeCalendarCell = {
  employeeId: string
  employeeCode: string
  employeeName: string
  date: string
  minutes: number
  approvedMinutes: number
  targets: string[]
}

export const lastDayOf = (month: string): string => {
  const [y, m] = month.split("-").map(Number)
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`
}

/** El listado con su banda de aprobadas / pendientes y su agregado mensual. */
export async function readTimeList(
  db: AnyClient,
  opts: {
    filter: Record<string, unknown> & { from?: string; to?: string }
    page: { skip?: number; take?: number }
    userId: string
    role: Role
  }
) {
  // En SERIE: dentro de una transacción hay UNA conexión (regla de E6-perf).
  const page = await listTimeEntries(db, opts.filter, opts.page)
  const aggregate =
    opts.filter.from && opts.filter.to
      ? await minutesByTargetMonthSql(db, { from: opts.filter.from, to: opts.filter.to }, { approvedOnly: true })
      : []
  const mine = await listEmployees(db, { includeArchived: true })
  const myEmployeeIds = mine.filter((e) => e.userId === opts.userId).map((e) => e.id)

  const nominal = opts.role === Role.EDITOR || opts.role === Role.ADMIN
  const own = new Set(myEmployeeIds)
  const entries = page.entries.map((e) =>
    nominal || own.has(e.employeeId) ? e : { ...e, employeeCode: "—", employeeName: "—", note: null }
  )

  const approvedMinutes = page.entries.filter((e) => e.status === "APROBADO").reduce((a, e) => a + e.minutes, 0)
  const unapprovedMinutes = page.entries.filter((e) => e.status !== "APROBADO").reduce((a, e) => a + e.minutes, 0)
  const base = approvedMinutes + unapprovedMinutes

  return {
    entries,
    total: page.total,
    approvedMinutes,
    unapprovedMinutes,
    // El % de las pendientes SOBRE LA BASE: es el aviso (c) de §7 y el que
    // explica por qué una regla `HOURS` reparte menos de lo que parece.
    unapprovedShareBps: base === 0 ? null : Math.round((unapprovedMinutes * 10000) / base),
    aggregate,
    redacted: !nominal,
  }
}

/** El calendario mensual por (empleado, día), con el techo diario AGREGADO. */
export async function readTimeCalendar(
  db: AnyClient,
  opts: { month: string; employeeId?: string; role: Role }
) {
  const from = `${opts.month}-01`
  const to = lastDayOf(opts.month)
  const page = await listTimeEntries(
    db,
    { from, to, ...(opts.employeeId ? { employeeId: opts.employeeId } : {}) },
    // 40 empleados × 31 días × varios partes: el techo de §9 es un mes.
    { take: 5000 }
  )

  const nominal = opts.role === Role.EDITOR || opts.role === Role.ADMIN
  const byCell = new Map<string, TimeCalendarCell>()
  for (const e of page.entries) {
    const key = `${e.employeeId}|${e.date}`
    const cell = byCell.get(key) ?? {
      employeeId: e.employeeId,
      employeeCode: nominal ? e.employeeCode : "—",
      employeeName: nominal ? e.employeeName : "—",
      date: e.date,
      minutes: 0,
      approvedMinutes: 0,
      targets: [],
    }
    cell.minutes += e.minutes
    if (e.status === "APROBADO") cell.approvedMinutes += e.minutes
    const target = e.projectCode ?? e.costCenterCode
    if (target && !cell.targets.includes(target)) cell.targets = [...cell.targets, target]
    byCell.set(key, cell)
  }
  const cells = [...byCell.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.employeeCode.localeCompare(b.employeeCode)
  )
  return {
    month: opts.month,
    cells,
    totalMinutes: cells.reduce((a, c) => a + c.minutes, 0),
    overCeiling: cells
      .filter((c) => c.minutes > 1440)
      .map((c) => ({ employeeCode: c.employeeCode, date: c.date, minutes: c.minutes })),
  }
}
