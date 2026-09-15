import { OnboardingWizard } from "@/components/onboarding/wizard"
import { getCurrentUser } from "@/lib/auth"
import { getOrgContext } from "@/lib/authz"
import { fromUtcDate } from "@/lib/ledger/dates"
import { readOnboarding } from "@/models/onboarding"
import { InvoiceSeriesKind, OnboardingStep, Role } from "@/prisma/client"
import { Metadata } from "next"
import { redirect } from "next/navigation"

export const metadata: Metadata = { title: "Puesta en marcha" }
export const dynamic = "force-dynamic"

/**
 * E11 · ola C · **T14** — `/onboarding`, seis pasos, reanudable (§6.2, §10).
 *
 * Cuelga de `(onboarding)` y no de `(app)` por la misma razón que
 * `/organizations/new`: el layout de `(app)` empieza por `requireOrg("VIEWER")`,
 * que lanza `NO_ORGANIZATION` justo para el usuario que viene a crear la suya.
 *
 * Cada paso enseña **qué se ha sembrado** —cuentas, claves del mapa, tipos
 * impositivos, pares, series— en vez de un spinner: es la primera prueba que el
 * producto le da al cliente de que sabe lo que hace.
 *
 * `VIEWER` no entra: el asistente sólo existe para el ADMIN de la organización
 * recién creada. La comprobación es de servidor, no de menú.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await getCurrentUser()
  const params = await searchParams
  // `?nueva=1`: dar de alta OTRA organización desde el asistente. Sin este
  // parámetro, quien ya tiene una organización activa reanuda la suya; con él,
  // empieza una nueva — que es lo que hace el enlace «Nueva organización».
  const startNew = params.nueva === "1"
  const context = startNew ? null : await getOrgContext()

  // Sin organización todavía: paso 1, y nada más que el paso 1.
  if (!context) {
    return <OnboardingWizard step={OnboardingStep.COMPANY} organization={null} report={null} series={[]} fiscalYear={null} demo={null} />
  }

  if (context.role !== Role.ADMIN) redirect("/dashboard")

  const { db, org } = context
  const view = await readOnboarding(db, new Date())

  // Organización creada antes de E11 (sin `OnboardingRun`): el asistente no
  // reescribe su historia, la manda al panel. La siembra que le falte la delata
  // I-E11-10, no una pantalla de alta que ya no aplica.
  if (!view.run) redirect("/dashboard")
  if (view.run.completedAt) redirect("/dashboard")

  const seriesRows = await db.invoiceSeries.findMany({
    select: { id: true, code: true, kind: true, prefix: true, nextNumber: true },
    orderBy: { kind: "asc" },
  })
  const year = await db.fiscalYear.findFirst({ orderBy: { startDate: "asc" } })
  const entriesInYear = year ? await db.journalEntry.count({ where: { fiscalYearId: year.id } }) : 0

  return (
    <OnboardingWizard
      step={view.run.step}
      organization={{ id: org.id, name: org.name, pgcVariant: org.pgcVariant, baseCurrency: org.baseCurrency }}
      report={view.report}
      series={seriesRows.map((s) => ({
        id: s.id,
        code: s.code,
        kind: s.kind === InvoiceSeriesKind.RECTIFICATIVA ? "RECTIFICATIVA" : "ORDINARIA",
        prefix: s.prefix,
        issued: s.nextNumber - 1,
      }))}
      fiscalYear={
        year
          ? {
              code: year.code,
              startDate: fromUtcDate(year.startDate),
              endDate: fromUtcDate(year.endDate),
              entries: entriesInYear,
            }
          : null
      }
      demo={view.demo}
    />
  )
}
