import type { TimeCalendarPayload } from "@/app/(app)/time/actions"
import { cn } from "@/lib/utils"

/**
 * E10 · T17 — Calendario mensual de partes (`docs/design/E10-presupuesto-horas.md` §7).
 *
 * Una celda por (empleado, día) con sus horas en `hh:mm` y los proyectos que las
 * soportan. Los minutos, los agregados del día y la marca de **techo diario
 * agregado** (O-E10-21) los compone el servidor: aquí no se suma nada.
 *
 * El día que pasa de 24 h sumando **todos** los partes se marca en rojo ámbar de
 * la marca y se nombra: cuatro partes de 1 440 minutos son legales uno a uno y
 * absurdos juntos, y el techo por fila no los veía.
 */

/** Minutos → `hh:mm`, con el signo del contra-apunte a la vista. */
export function hhmm(minutes: number): string {
  const sign = minutes < 0 ? "−" : ""
  const abs = Math.abs(minutes)
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`
}

const WEEKDAYS = ["L", "M", "X", "J", "V", "S", "D"]

const daysInMonth = (month: string): number => {
  const [y, m] = month.split("-").map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** Lunes = 0. `new Date(...).getUTCDay()` da domingo = 0. */
const weekdayIndex = (iso: string): number => (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7

export function TimeCalendar({ payload }: { payload: TimeCalendarPayload }) {
  const total = daysInMonth(payload.month)
  const days = Array.from({ length: total }, (_, i) => `${payload.month}-${String(i + 1).padStart(2, "0")}`)

  const employees = [...new Map(payload.cells.map((c) => [c.employeeId, c])).values()].sort((a, b) =>
    a.employeeCode.localeCompare(b.employeeCode, "es")
  )
  const byKey = new Map(payload.cells.map((c) => [`${c.employeeId}|${c.date}`, c]))
  const overCeiling = new Set(payload.overCeiling.map((o) => `${o.employeeCode}|${o.date}`))

  if (employees.length === 0) {
    return (
      <p className="rounded-md border p-6 text-sm text-muted-foreground" data-testid="calendar-empty">
        No hay ningún parte en {payload.month}. Registra el primero con «Nuevo parte» o importa un CSV.
      </p>
    )
  }

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-xs" data-testid="time-calendar" data-month={payload.month}>
          <thead className="bg-muted/40 uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="sticky left-0 bg-muted/40 px-2 py-1 text-left font-medium">Empleado</th>
              {days.map((day) => (
                <th key={day} className="px-1 py-1 text-center font-medium">
                  <div>{Number(day.slice(8))}</div>
                  <div className="font-normal opacity-70">{WEEKDAYS[weekdayIndex(day)]}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {employees.map((employee) => (
              <tr key={employee.employeeId} className="h-8" data-employee={employee.employeeCode}>
                <td className="sticky left-0 bg-background px-2 py-1 whitespace-nowrap">
                  <span className="font-code">{employee.employeeCode}</span>{" "}
                  <span className="text-muted-foreground">{employee.employeeName}</span>
                </td>
                {days.map((day) => {
                  const cell = byKey.get(`${employee.employeeId}|${day}`)
                  const over = overCeiling.has(`${employee.employeeCode}|${day}`)
                  return (
                    <td
                      key={day}
                      title={cell ? cell.targets.join(" · ") : undefined}
                      data-date={day}
                      data-minutes={cell?.minutes ?? 0}
                      data-over-ceiling={over ? "si" : "no"}
                      className={cn(
                        "px-1 py-1 text-center tabular-nums",
                        !cell && "text-muted-foreground",
                        cell && cell.approvedMinutes !== cell.minutes && "bg-[#EDF2F7]",
                        over && "border border-[#F5A623] bg-[#F5A623]/20 font-semibold"
                      )}
                    >
                      {cell ? hhmm(cell.minutes) : "—"}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Fondo hielo = el día tiene partes <strong>sin aprobar</strong>. Las horas sin aprobar no reparten dinero y no
        aparecen en ningún margen. Total del mes: <strong>{hhmm(payload.totalMinutes)}</strong>.
      </p>
      {payload.overCeiling.length > 0 && (
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-xs" role="alert" data-testid="over-ceiling">
          <strong>Techo diario superado</strong> (O-E10-21): sumando todos los partes del día,{" "}
          {payload.overCeiling.map((o) => `${o.employeeCode} el ${o.date} (${hhmm(o.minutes)})`).join(" · ")} pasa de
          24 h. El techo por parte no lo ve; el agregado, sí.
        </p>
      )}
    </div>
  )
}
