import { listEmployeesAction } from "@/app/(app)/settings/employees/actions"
import { listTimeEntriesAction, timeCalendarAction } from "@/app/(app)/time/actions"
import { TimeCalendar, hhmm } from "@/components/time/time-calendar"
import { TimePanel } from "@/components/time/time-panel"
import { Button } from "@/components/ui/button"
import { tenantPage, type SearchParamsProps } from "@/lib/page-tenant"
import { tenantTransaction } from "@/lib/db"
import { getAnalyticsConfig } from "@/models/analytics"
import { todayLocalDate } from "@/models/ledger"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = { title: "Partes de horas" }

/**
 * E10 · T17 — `/time` (`docs/design/E10-presupuesto-horas.md` §7).
 *
 * Calendario mensual por empleado, lista con filtros, aprobación por lote,
 * corrección por contra-apunte e import CSV con vista previa. La banda del mes
 * enseña **aprobadas vs pendientes y el peso de las pendientes sobre la base**,
 * porque es lo que explica que una regla `HOURS` reparta menos de lo que parece.
 *
 * Ni una cifra se suma en el navegador: los minutos, los agregados y el techo
 * diario agregado llegan ya compuestos desde `app/(app)/time/actions.ts`.
 */
export default tenantPage<SearchParamsProps>(async ({ org, role, searchParams }) => {
  const params = await searchParams
  const first = (key: string): string | undefined => {
    const value = params[key]
    return Array.isArray(value) ? value[0] : value
  }

  const canEdit = role === Role.EDITOR || role === Role.ADMIN
  const today = todayLocalDate()
  const month = /^\d{4}-\d{2}$/.test(first("mes") ?? "") ? (first("mes") as string) : today.slice(0, 7)
  const view = first("vista") === "lista" ? "lista" : "calendario"
  const from = `${month}-01`
  const to = lastDayOf(month)

  // En SERIE: la página comparte una sola conexión (regla de `tenantPage`).
  const listState = await listTimeEntriesAction({ from, to, take: 500 })
  const calendarState = view === "calendario" ? await timeCalendarAction({ month }) : null
  const employeesState = await listEmployeesAction({})
  const config = await tenantTransaction(org.id, async (tx) => getAnalyticsConfig(tx, { periodEnd: to }))

  const header = (
    <div className="space-y-1 border-b pb-4">
      <h1 className="text-2xl font-semibold tracking-tight">Partes de horas</h1>
      <p className="max-w-3xl text-sm text-muted-foreground">
        Las horas son el <strong>driver de actividad</strong> de la analítica: alimentan el reparto de estructura, el
        coste-hora y el margen por hora. Se registran en minutos enteros, se aprueban por lote y se corrigen por
        contra-apunte — nunca se editan ni se borran.
      </p>
      <p className="text-sm text-muted-foreground">
        Mes {month} · {formatMonthRange(from, to)}
      </p>
    </div>
  )

  const nav = (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Button asChild variant="outline" size="sm">
        <Link href={`/time?mes=${prevMonth(month)}&vista=${view}`} data-testid="prev-month">
          ← {prevMonth(month)}
        </Link>
      </Button>
      <Button asChild variant="outline" size="sm">
        <Link href={`/time?mes=${nextMonth(month)}&vista=${view}`} data-testid="next-month">
          {nextMonth(month)} →
        </Link>
      </Button>
      <span className="mx-2 text-muted-foreground">Vista:</span>
      <Button asChild variant={view === "calendario" ? "default" : "outline"} size="sm">
        <Link href={`/time?mes=${month}&vista=calendario`} data-testid="view-calendar">
          Calendario
        </Link>
      </Button>
      <Button asChild variant={view === "lista" ? "default" : "outline"} size="sm">
        <Link href={`/time?mes=${month}&vista=lista`} data-testid="view-list">
          Lista
        </Link>
      </Button>
    </div>
  )

  if (!listState.success || !listState.data) {
    return (
      <div className="space-y-6">
        {header}
        {nav}
        <p
          className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-3 text-sm"
          role="alert"
          data-testid="time-error"
        >
          No se han podido leer los partes: {listState.error ?? "error desconocido"}.
        </p>
      </div>
    )
  }

  const employees = (employeesState.data ?? []).filter((e) => e.isActive)

  return (
    <div className="space-y-6">
      {header}
      {nav}

      {employees.length === 0 && (
        <p className="rounded-md border p-6 text-sm text-muted-foreground" data-testid="time-no-employees">
          Todavía no hay empleados. Dalos de alta en{" "}
          <Link href="/settings/employees" className="underline underline-offset-2">
            Configuración → Empleados
          </Link>
          : un parte de horas es de alguien, y su coste sale de su tarifa vigente.
        </p>
      )}

      {view === "calendario" &&
        (calendarState?.success && calendarState.data ? (
          <TimeCalendar payload={calendarState.data} />
        ) : (
          <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert">
            No se ha podido componer el calendario: {calendarState?.error ?? "error desconocido"}.
          </p>
        ))}

      <TimePanel
        payload={listState.data}
        employees={employees.map((e) => ({ id: e.id, code: e.code, name: e.name }))}
        projects={config.projects.map((p) => ({ id: p.id, code: p.code, name: p.name }))}
        costCenters={config.costCenters.map((c) => ({ id: c.id, code: c.code, name: c.name }))}
        canEdit={canEdit}
        defaultDate={month === today.slice(0, 7) ? today : from}
      />

      {listState.data.aggregate.length > 0 && (
        <section className="space-y-2" data-testid="time-aggregate">
          <h2 className="text-sm font-semibold tracking-tight">Minutos aprobados por receptor y mes</h2>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Receptor</th>
                  <th className="px-3 py-2 text-left font-medium">Mes</th>
                  <th className="px-3 py-2 text-right font-medium">Horas aprobadas</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {listState.data.aggregate.map((row) => (
                  <tr key={`${row.targetKind}|${row.targetId}|${row.month}`} className="h-8">
                    <td className="px-3 py-1 font-code text-xs">{row.targetCode}</td>
                    <td className="px-3 py-1 tabular-nums text-muted-foreground">{row.month}</td>
                    <td className="px-3 py-1 text-right tabular-nums" data-minutes={row.minutes}>
                      {hhmm(row.minutes)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            Es la base que leen las reglas de driver <span className="font-code">HORAS</span>, agregada por SQL. Sólo
            entran los partes <strong>aprobados y productivos</strong>.
          </p>
        </section>
      )}
    </div>
  )
})

const lastDayOf = (month: string): string => {
  const [y, m] = month.split("-").map(Number)
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`
}

const shiftMonth = (month: string, delta: number): string => {
  const [y, m] = month.split("-").map(Number)
  const index = y * 12 + (m - 1) + delta
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`
}

const prevMonth = (month: string): string => shiftMonth(month, -1)
const nextMonth = (month: string): string => shiftMonth(month, 1)

const formatMonthRange = (from: string, to: string): string => `${from} – ${to}`
