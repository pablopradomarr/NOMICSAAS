import { readTimeCalendar, readTimeList } from "@/app/(app)/time/shared"
import { TimeCalendar, hhmm } from "@/components/time/time-calendar"
import { TimePanel } from "@/components/time/time-panel"
import { Button } from "@/components/ui/button"
import { tenantPage, type SearchParamsProps } from "@/lib/page-tenant"
import { getAnalyticsConfig } from "@/models/analytics"
import { listEmployees } from "@/models/employees"
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
export default tenantPage<SearchParamsProps>(async ({ db, user, role, searchParams }) => {
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

  // **DEBE 7 de la revisión de la ronda 1.** §9 exige «una transacción por
  // petición (`tenantPage`)» y aquí se abrían CINCO: la de `tenantPage` más una
  // por acción (`listTimeEntriesAction`, `timeCalendarAction`,
  // `listEmployeesAction`) y un `tenantTransaction` suelto para
  // `getAnalyticsConfig`. Ahora todo se lee dentro del `db` de `tenantPage`, en
  // SERIE (dentro de una transacción hay UNA conexión), y las acciones quedan
  // para las mutaciones y para el cliente.
  const list = await readTimeList(db, { filter: { from, to }, page: { take: 500 }, userId: user.id, role })
  const calendar = view === "calendario" ? await readTimeCalendar(db, { month, role }) : null
  const employees = await listEmployees(db, {})
  const config = await getAnalyticsConfig(db, { periodEnd: to })

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

  const activeEmployees = employees.filter((e) => e.isActive)

  return (
    <div className="space-y-6">
      {header}
      {nav}

      {activeEmployees.length === 0 && (
        <p className="rounded-md border p-6 text-sm text-muted-foreground" data-testid="time-no-employees">
          Todavía no hay empleados. Dalos de alta en{" "}
          <Link href="/settings/employees" className="underline underline-offset-2">
            Configuración → Empleados
          </Link>
          : un parte de horas es de alguien, y su coste sale de su tarifa vigente.
        </p>
      )}

      {view === "calendario" && calendar !== null && <TimeCalendar payload={calendar} />}

      <TimePanel
        payload={list}
        employees={activeEmployees.map((e) => ({ id: e.id, code: e.code, name: e.name }))}
        projects={config.projects.map((p) => ({ id: p.id, code: p.code, name: p.name }))}
        costCenters={config.costCenters.map((c) => ({ id: c.id, code: c.code, name: c.name }))}
        canEdit={canEdit}
        defaultDate={month === today.slice(0, 7) ? today : from}
      />

      {list.aggregate.length > 0 && (
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
                {list.aggregate.map((row) => (
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
