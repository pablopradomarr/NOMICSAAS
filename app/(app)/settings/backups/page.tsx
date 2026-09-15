import { BackupsPanel, type BackupJobView, type RestoreCheckView, type RestoreJobView } from "@/components/backups/backups-panel"
import { SettingsPageHeader } from "@/components/settings/page-header"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { tenantPage } from "@/lib/page-tenant"
import { platformDeployment } from "@/models/platform-deployment"
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

    // En SERIE: una transacción por petición (E6-perf).
    const deployed = await platformDeployment(db)
    if (!deployed.backups) {
      return (
        <div className="space-y-8">
          <SettingsPageHeader
            title="Copias de seguridad"
            description="Descarga todos tus datos cuando quieras y restaura una copia en una organización nueva."
          />
          <p className="max-w-3xl rounded-md border border-dashed p-4 text-sm" data-testid="platform-not-deployed">
            <strong>Todavía no disponible en esta instalación.</strong> Las copias de seguridad necesitan las tablas de
            plataforma, que se despliegan con el resto de la épica. Aun así, la regla no cambia: cuando estén, la
            restauración creará una <strong>organización nueva</strong> y la actual no se tocará.
          </p>
        </div>
      )
    }

    const context = deployed.billing
      ? await getSubscriptionContext(org.id, now, { organizationIsActive: org.isActive })
      : { access: { level: "FULL" as const, reason: null, graceUntil: null } }
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
 * `restoreVerification.json` lo escribe la ola B (T9). Se lee **a la defensiva**:
 * lo que no venga no se pinta en verde, se omite. Nunca un ✓ que no se haya
 * comprobado.
 */
function readChecks(verification: unknown): RestoreCheckView[] {
  if (!verification || typeof verification !== "object") return []
  const checks = (verification as { checks?: unknown }).checks
  if (!Array.isArray(checks)) return []
  return checks.flatMap((raw): RestoreCheckView[] => {
    if (!raw || typeof raw !== "object") return []
    const entry = raw as { key?: unknown; label?: unknown; ok?: unknown; detail?: unknown }
    if (typeof entry.key !== "string") return []
    return [
      {
        key: entry.key,
        label: typeof entry.label === "string" ? entry.label : entry.key,
        ok: entry.ok === true,
        detail: typeof entry.detail === "string" ? entry.detail : null,
      },
    ]
  })
}
