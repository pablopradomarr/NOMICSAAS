import { BackupsPanel, type BackupJobView, type RestoreCheckView, type RestoreJobView } from "@/components/backups/backups-panel"
import { SettingsPageHeader } from "@/components/settings/page-header"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { tenantPage } from "@/lib/page-tenant"
import { getSubscriptionContext } from "@/models/subscriptions"
import { Role } from "@/prisma/client"
import { Metadata } from "next"
import { resetFieldsAndCategoriesAction, resetLLMSettingsAction } from "./actions"

export const metadata: Metadata = { title: "Copias de seguridad" }

/**
 * E11 · ola C · **T22** — `/settings/backups`, **reescrita** (§10).
 *
 * La pantalla heredada de TaxHacker ofrecía «restaurar» sobre la propia
 * organización, borrando todo lo que hubiera. Eso ya no existe: la restauración
 * crea una organización nueva y la actual no se toca (criterio 35).
 *
 * Lo que sí hay: la lista de copias con su estado, su progreso, su tamaño, su
 * sha256, sus tres sellos y su caducidad; el botón de crear; la descarga de
 * portabilidad sin cuota cuando la organización no está en `FULL` (O-4); y, por
 * cada restauración, **las seis comprobaciones** de §5.4 enfrentadas una a una.
 */
export default tenantPage(
  async ({ db, org, role }) => {
    const canEdit = role === Role.ADMIN
    const now = new Date()

    /**
     * **E11 · integración** — el puente `platformDeployment()` se ha retirado.
     * Era un `to_regclass` en cada carga para sobrevivir a una instalación con
     * las migraciones a medio aplicar, y tenía fecha de caducidad escrita: «en
     * cuanto las tres migraciones estén aplicadas». Lo están. Una instalación
     * sin migrar no es un estado que la pantalla tenga que dibujar: es un
     * despliegue incompleto, y `prisma migrate deploy` es su arreglo.
     */
    // En SERIE: una transacción por petición (E6-perf).
    const context = await getSubscriptionContext(org.id, now, { organizationIsActive: org.isActive })
    const jobRows = await db.backupJob.findMany({ orderBy: { createdAt: "desc" }, take: 20 })
    const restoreRows = await db.restoreJob.findMany({ orderBy: { createdAt: "desc" }, take: 10 })

    const jobs: BackupJobView[] = jobRows.map((job) => ({
      id: job.id,
      status: String(job.status),
      trigger: String(job.trigger),
      progressBps: job.progressBps,
      sizeBytes: job.sizeBytes === null ? null : Number(job.sizeBytes),
      archiveSha256: job.archiveSha256,
      ledgerHash: job.ledgerHash,
      analyticsKey: job.analyticsKey,
      budgetHash: job.budgetHash,
      expiresAt: job.expiresAt ? job.expiresAt.toISOString() : null,
      createdAt: job.createdAt.toISOString(),
      error: job.error,
      // Un ZIP caducado no se descarga: la fila se queda para poder explicarlo.
      downloadable: String(job.status) === "DONE" && job.objectKey !== null,
    }))

    const restores: RestoreJobView[] = restoreRows.map((restore) => ({
      id: restore.id,
      status: String(restore.status),
      verified: restore.verified,
      progressBps: restore.progressBps,
      createdAt: restore.createdAt.toISOString(),
      checks: readChecks(restore.verification),
      error: restore.error,
    }))

    return (
      <div className="space-y-8">
        <SettingsPageHeader
          title="Copias de seguridad"
          description="Descarga todos tus datos cuando quieras y restaura una copia en una organización nueva. La organización en la que estás nunca se sobrescribe."
        />

        <BackupsPanel
          jobs={jobs}
          restores={restores}
          accessLevel={context.access.level}
          retentionDays={org.backupRetentionDays}
          canEdit={canEdit}
        />

        {canEdit && (
          <>
            <Separator />
            <section className="space-y-3">
              <div className="space-y-1">
                <h3 className="text-lg font-semibold">Restablecer catálogos</h3>
                <p className="max-w-3xl text-sm text-muted-foreground">
                  Devuelve a sus valores por defecto el prompt de extracción, o los campos, categorías y monedas. No
                  toca ningún asiento ni ningún documento: son catálogos de trabajo. Úsalo sólo si algo se ha
                  desconfigurado.
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                <form action={resetLLMSettingsAction}>
                  <Button variant="outline" size="sm" type="submit">
                    Restablecer el prompt de extracción
                  </Button>
                </form>
                <form action={resetFieldsAndCategoriesAction}>
                  <Button variant="outline" size="sm" type="submit">
                    Restablecer campos, categorías y monedas
                  </Button>
                </form>
              </div>
            </section>
          </>
        )}
      </div>
    )
  },
  { minRole: Role.ADMIN }
)

/**
 * `restoreVerification.json` lo escribe `verifyRestore`, y su forma es
 * `CheckResult = { id, status, title, evidence, note }` (`lib/platform/backup.ts`).
 *
 * **Revisor DEBE 5.** Esta función leía `{ key, label, ok, detail }` y
 * descartaba todo lo que no lo tuviera: **las seis comprobaciones no se pintaban
 * jamás**. Ahora lee la forma real y trae la evidencia enfrentada
 * origen↔destino, que es lo que D2.7 pide que esté a la vista.
 *
 * Se sigue leyendo **a la defensiva** y con la misma regla: lo que no venga no
 * se pinta en verde. Un `INFO` no es un ✓.
 */
function readChecks(verification: unknown): RestoreCheckView[] {
  if (!verification || typeof verification !== "object") return []
  const checks = (verification as { checks?: unknown }).checks
  if (!Array.isArray(checks)) return []
  return checks.flatMap((raw): RestoreCheckView[] => {
    if (!raw || typeof raw !== "object") return []
    const entry = raw as { id?: unknown; status?: unknown; title?: unknown; evidence?: unknown; note?: unknown }
    if (typeof entry.id !== "string") return []
    const status = entry.status === "PASS" || entry.status === "FAIL" || entry.status === "INFO" ? entry.status : "INFO"
    const evidence = Array.isArray(entry.evidence)
      ? entry.evidence.flatMap((row): RestoreCheckView["evidence"] => {
          if (!row || typeof row !== "object") return []
          const line = row as { label?: unknown; expected?: unknown; actual?: unknown; ok?: unknown }
          if (typeof line.label !== "string") return []
          return [
            {
              label: line.label,
              expected: typeof line.expected === "string" ? line.expected : "—",
              actual: typeof line.actual === "string" ? line.actual : "—",
              ok: line.ok === true,
            },
          ]
        })
      : []
    return [
      {
        key: entry.id,
        label: typeof entry.title === "string" ? entry.title : entry.id,
        status,
        ok: status === "PASS",
        detail: typeof entry.note === "string" ? entry.note : null,
        evidence,
      },
    ]
  })
}
