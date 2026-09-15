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

import { tenantTransaction } from "@/lib/db"
import type { AnyClient } from "@/models/ledger"
import { listEmployees } from "@/models/employees"
import { calendarByEmployeeDaySql, listTimeEntries, minutesByTargetMonthSql } from "@/models/time"
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
  // **SQL crudo dentro de la transacción de la petición.** `tenantDb(org)` NO
  // enruta `$queryRaw` a la transacción abierta (límite 2 documentado en
  // `lib/db.ts`): saldría por otra conexión, sin `app.current_org`, y con la RLS
  // estricta de ADR-0009 eso **no da error, devuelve vacío**. `tenantTransaction`
  // es reentrante: encuentra la transacción de `tenantPage` por el
  // AsyncLocalStorage y da el cliente cuyo `$queryRaw` sí va por ella.
  const aggregate =
    opts.filter.from && opts.filter.to
      ? await tenantTransaction(db.$organizationId, async (tx) =>
          minutesByTargetMonthSql(tx, { from: opts.filter.from as string, to: opts.filter.to as string }, { approvedOnly: true })
        )
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

/**
 * El calendario mensual por (empleado, día), con el techo diario AGREGADO.
 *
 * **E11 · ola C · T21 — deuda heredada de E10 (registro C1), cerrada.** La
 * versión de E10 traía hasta 5 000 partes del mes (`take: 5000`) y los agrupaba
 * **en memoria**: con 250 empleados × 22 días el `take` empezaba a truncar en
 * silencio, que es peor que ser lento. Ahora agrupa Postgres, en **una sola
 * consulta** apoyada en `time_entries_org_date_employee_cover` (techo 10 de §12
 * de E11: < 400 ms), y no hay límite que truncar.
 */
export async function readTimeCalendar(
  db: AnyClient,
  opts: { month: string; employeeId?: string; role: Role }
) {
  const from = `${opts.month}-01`
  const to = lastDayOf(opts.month)
  // Mismo motivo que arriba: el agregado va por SQL crudo y necesita el cliente
  // de la transacción, o la RLS lo deja en cero sin decir nada.
  const aggregated = await tenantTransaction(db.$organizationId, async (tx) =>
    calendarByEmployeeDaySql(tx, { from, to }, opts.employeeId ? { employeeId: opts.employeeId } : {})
  )

  // La redacción (§10 de E10) es de presentación, no de agregación: `VIEWER` ve
  // las horas del mes sin saber de quién son.
  const nominal = opts.role === Role.EDITOR || opts.role === Role.ADMIN
  const cells: TimeCalendarCell[] = aggregated.map((cell) => ({
    employeeId: cell.employeeId,
    employeeCode: nominal ? cell.employeeCode : "—",
    employeeName: nominal ? cell.employeeName : "—",
    date: cell.date,
    minutes: cell.minutes,
    approvedMinutes: cell.approvedMinutes,
    targets: cell.targets,
  }))

  return {
    month: opts.month,
    cells,
    totalMinutes: cells.reduce((a, c) => a + c.minutes, 0),
    overCeiling: cells
      .filter((c) => c.minutes > 1440)
      .map((c) => ({ employeeCode: c.employeeCode, date: c.date, minutes: c.minutes })),
  }
}
