import { requirePlatformAdmin } from "../admin"
import { OrganizationOperations, type UnblockOption } from "@/components/admin/organization-operations"
import { tenantTransaction } from "@/lib/db"
import { listOperatorExceptions } from "@/models/operator-exceptions"
import { liveExceptions } from "@/lib/ledger/invariants-e12"
import { listPlans } from "@/models/plans"
import { listPlatformAuditForOrganization, operatorGuardTargets } from "@/models/platform"
import { getSubscription } from "@/models/subscriptions"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

export const metadata: Metadata = { title: "Organización · operación de plataforma" }
export const dynamic = "force-dynamic"

/**
 * E12 · T13 — **`/admin/<id>`**: las cuatro escrituras sobre una organización.
 *
 * Arriba del todo, en rojo, las excepciones vivas (§5.5). Después las cuatro
 * operaciones, cada una con su diálogo de dos pasos. Y al final el registro: lo
 * que ya se hizo aquí, con su motivo y su actor, porque un panel de operador que
 * no enseña su propio historial invita a repetir lo que otro acaba de hacer.
 */
export default async function AdminOrganizationPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePlatformAdmin()
  const { id } = await params
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound()

  const now = new Date()

  // En SERIE: todas comparten la transacción de tenant (E6-perf).
  const datos = await tenantTransaction(id, async (tx) => {
    const org = await tx.organization.findFirst({ select: { id: true, name: true, slug: true, isActive: true } })
    if (!org) return null
    const excepciones = await listOperatorExceptions(tx, { take: 50 })
    const planes = await listPlans(tx)
    const suscripcion = await getSubscription(tx)
    const asientos = await tx.journalEntry.count()
    const guardias = await operatorGuardTargets(tx, now)
    const registro = await listPlatformAuditForOrganization(tx, 30)
    return { org, excepciones, planes, suscripcion, asientos, guardias, registro }
  })
  if (!datos) notFound()

  const { org, excepciones, planes, suscripcion, asientos, guardias, registro } = datos
  const vivas = liveExceptions(excepciones, now.toISOString())

  const unblockOptions: UnblockOption[] = [
    {
      kind: "UNBLOCK_PERIOD_LOCK",
      targetKind: "PERIOD_LOCK",
      label: "Un bloqueo de periodo puesto por error",
      targets: guardias.periodLocks,
    },
    {
      kind: "UNBLOCK_CLOSING_GUARD",
      targetKind: "FISCAL_YEAR",
      label: "Una guardia de cierre de ejercicio",
      targets: guardias.closingGuards,
    },
    {
      kind: "UNSTICK_RESTORE_JOB",
      targetKind: "RESTORE_JOB",
      label: "Una restauración colgada",
      targets: guardias.stuckRestores,
    },
    {
      kind: "UNSTICK_CRON_JOB",
      targetKind: "CRON_JOB",
      label: "Un job de cron atascado en PARTIAL",
      targets: guardias.stuckCronJobs,
    },
  ].filter((o) => o.targets.length > 0)

  return (
    <main className="p-6 space-y-6" data-testid="admin-org-page">
      <header className="space-y-1">
        <Link href="/admin" className="text-sm underline">
          ← Todas las organizaciones
        </Link>
        <h1 className="text-2xl font-semibold" data-testid="admin-org-name">
          {org.name}
        </h1>
        <p className="text-sm text-muted-foreground">
          {org.slug} · plan {suscripcion?.planCode ?? "sin suscripción"} ·{" "}
          <span data-testid="admin-org-asientos">{asientos} asiento(s)</span>
          {!org.isActive && " · desactivada"}
        </p>
      </header>

      {vivas.length > 0 && (
        <section
          className="rounded-lg border border-destructive/50 bg-destructive/5 p-4"
          data-testid="admin-org-excepciones-vivas"
        >
          <h2 className="font-semibold text-destructive">
            {vivas.length} excepción(es) de operador viva(s) — el sello de esta organización lo dice
          </h2>
          <ul className="mt-2 space-y-2 text-sm">
            {vivas.map((e) => (
              <li key={e.id}>
                <span className="font-medium">{e.kind}</span> sobre {e.targetKind}
                {e.targetRef ? ` (${e.targetRef})` : ""} · caduca el{" "}
                <time dateTime={e.expiresAt}>{e.expiresAt.slice(0, 19).replace("T", " ")}</time>
                <p className="text-xs text-muted-foreground">
                  {e.requestedBy} · {e.reason}
                </p>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            No se renuevan: cuando caducan, la puerta vuelve a cerrarse sin que nadie haga nada. El invariante que
            la cerró sigue en FAIL todo este tiempo.
          </p>
        </section>
      )}

      <OrganizationOperations
        organizationId={org.id}
        organizationName={org.name}
        planCodes={planes.map((p) => p.code)}
        currentPlanCode={suscripcion?.planCode ?? null}
        unblockOptions={unblockOptions}
      />

      <section className="space-y-2">
        <h2 className="font-semibold">Lo que ya se hizo aquí</h2>
        {registro.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="admin-registro-vacio">
            Nadie de la plataforma ha tocado nada de esta organización.
          </p>
        ) : (
          <ul className="space-y-1 text-sm" data-testid="admin-registro">
            {registro.map((linea) => (
              <li key={linea.id} className="border-t pt-1">
                <span className="font-medium">{linea.action}</span> · {linea.actor} ·{" "}
                {linea.at.toISOString().slice(0, 19).replace("T", " ")}
                {linea.reason && <p className="text-xs text-muted-foreground">{linea.reason}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
