"use client"

/**
 * E11 · ola C · **T22** — `/settings/backups`, reescrita (§10).
 *
 * Lista con estado, progreso, tamaño, sha256 abreviado, los sellos, caducidad y
 * descarga. Botón «Crear copia» y, cuando la organización no está en `FULL`,
 * **«Descargar todos mis datos»** sin cuota y sin límite (O-4): la portabilidad
 * no la puede desactivar un precio.
 *
 * Restauración con el aviso en grande —**«la restauración crea una organización
 * nueva; la actual no se toca»**— y el resultado de la verificación con **las
 * seis comprobaciones enfrentadas**, no tres hashes: dos asientos con los
 * números intercambiados dan los mismos hashes y aun así la copia está mal.
 * Motivo obligatorio, que va al registro de auditoría.
 *
 * Aquí no se calcula nada: se pinta lo que el servidor manda.
 */

import {
  inspectRestoreArchiveAction,
  requestBackupAction,
  startRestoreAction,
  type InspectArchiveResult,
} from "@/app/(app)/settings/backups/actions"
import { FormError } from "@/components/forms/error"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

export type BackupJobView = {
  id: string
  status: string
  trigger: string
  progressBps: number
  sizeBytes: number | null
  archiveSha256: string | null
  ledgerHash: string | null
  analyticsKey: string | null
  budgetHash: string | null
  expiresAt: string | null
  createdAt: string
  error: string | null
  downloadable: boolean
}

/** Las SEIS comprobaciones de §5.4, tal y como el `RestoreJob` las escribe. */
/**
 * **Revisor DEBE 5.** La ronda anterior esperaba `{ key, label, ok, detail }` y
 * `verifyRestore` produce `CheckResult = { id, status, title, evidence, note }`:
 * el `if (typeof entry.key !== "string") return []` descartaba **todas** las
 * comprobaciones y las seis no se pintaban nunca, ni en `DONE` ni en
 * `DONE_UNVERIFIED` — justo lo contrario de lo que D2.7 promete («con las seis
 * comprobaciones enfrentadas a la vista»).
 *
 * `status` es propio y no un booleano: un `INFO` **no** es un ✓. Y `evidence`
 * lleva lo enfrentado origen↔destino, que es lo que mira quien tiene que decidir
 * si se queda con la copia.
 */
export type RestoreCheckView = {
  key: string
  label: string
  status: "PASS" | "FAIL" | "INFO"
  ok: boolean
  detail: string | null
  evidence: { label: string; expected: string; actual: string; ok: boolean }[]
}

export type RestoreJobView = {
  id: string
  status: string
  verified: boolean
  progressBps: number
  createdAt: string
  checks: RestoreCheckView[]
  error: string | null
}

const STATUS_LABELS: Record<string, string> = {
  QUEUED: "en cola",
  RUNNING: "en curso",
  VERIFYING: "verificando",
  DONE: "lista",
  DONE_UNVERIFIED: "terminada SIN verificar",
  FAILED: "fallida",
  EXPIRED: "caducada",
}

const TRIGGER_LABELS: Record<string, string> = {
  MANUAL: "a petición",
  SCHEDULED: "programada",
  EXIT: "portabilidad",
}

/** Las seis comprobaciones, con su nombre en español contable. */
/**
 * **E11 · integración** — las claves son los `CheckId` que escribe el motor
 * (`lib/platform/backup.ts`), no un juego paralelo. La ola C las bautizó a mano
 * (`rowCounts`, `numbering`, …) mientras la ola B no había aterrizado, y ninguna
 * coincidía: el resultado era que las seis comprobaciones se pintaban con su
 * identificador crudo en vez de con su nombre. Un diccionario de etiquetas que
 * no acierta ninguna clave es peor que no tenerlo.
 */
export const RESTORE_CHECK_LABELS: Record<string, string> = {
  RECUENTOS: "Recuentos por tabla, iguales al origen",
  NUMERACION: "Numeración de asientos y series, sin huecos ni duplicados",
  SELLOS_DERIVADOS: "Todos los sellos derivados, recomputados en el destino",
  AUDIT_LOG: "Huella del registro de auditoría, íntegra",
  SELLOS_Y_CIERRE: "Los tres sellos de contenido y el estado del cierre",
  BARRIDO_INVARIANTES: "Barrido de las nueve familias de invariantes",
}

function bytes(n: number | null): string {
  if (n === null) return "—"
  if (n < 1024) return `${n} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = n / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(value >= 100 ? 0 : 1).replace(".", ",")} ${units[i]}`
}

const shortSha = (sha: string | null): string => (sha ? `${sha.slice(0, 12)}…` : "—")

/**
 * **E11 · integración — la hora se pinta en una zona FIJA, y se dice cuál.**
 *
 * Sin `timeZone`, `Intl` usa la del entorno: el servidor renderiza en UTC y el
 * navegador en `Europe/Madrid`, así que las dos horas no coincidían y React
 * abortaba la hidratación de esta pantalla. En producción eso es un parpadeo
 * feo; en desarrollo **deja la página sin JavaScript**, y con ella los botones
 * de crear copia y restaurar, que son toda la pantalla.
 *
 * `Europe/Madrid` es la zona de la organización por defecto del producto
 * (`timezone` de `Organization`), y la etiqueta la acompaña para que nadie lea
 * una hora sin saber de dónde es.
 */
const ZONA = "Europe/Madrid"

const DATE_ES = new Intl.DateTimeFormat("es-ES", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: ZONA,
})

const fecha = (iso: string | null): string => (iso ? DATE_ES.format(new Date(iso)) : "—")

export function BackupsPanel({
  jobs,
  restores,
  accessLevel,
  retentionDays,
  canEdit,
}: {
  jobs: BackupJobView[]
  restores: RestoreJobView[]
  accessLevel: "FULL" | "READ_ONLY" | "BLOCKED"
  retentionDays: number
  canEdit: boolean
}) {
  return (
    <div className="space-y-8" data-testid="backups-panel">
      <CreateBackup accessLevel={accessLevel} retentionDays={retentionDays} canEdit={canEdit} />
      <Separator />
      <BackupList jobs={jobs} />
      <Separator />
      <RestorePanel restores={restores} canEdit={canEdit} />
    </div>
  )
}

function CreateBackup({
  accessLevel,
  retentionDays,
  canEdit,
}: {
  accessLevel: "FULL" | "READ_ONLY" | "BLOCKED"
  retentionDays: number
  canEdit: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const create = (kind: "MANUAL" | "EXIT") =>
    start(async () => {
      setError(null)
      const result = await requestBackupAction(kind)
      if (!result.success) setError(result.error ?? "No se ha podido encolar la copia")
      else router.refresh()
    })

  return (
    <section className="space-y-3" data-testid="create-backup">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold">Crear una copia</h3>
        <p className="max-w-3xl text-sm text-muted-foreground">
          La copia lleva todos tus datos —diario, documentos, maestros y auditoría— con su manifiesto firmado y sus
          sellos, y se conserva {retentionDays} días. Puedes seguir trabajando mientras se genera.
        </p>
      </div>

      {canEdit && (
        <div className="flex flex-wrap gap-3">
          <Button size="sm" disabled={pending} onClick={() => create("MANUAL")} data-testid="backup-create">
            {pending ? "Encolando…" : "Crear copia"}
          </Button>
          {accessLevel !== "FULL" && (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => create("EXIT")}
              data-testid="backup-exit"
            >
              Descargar todos mis datos
            </Button>
          )}
        </div>
      )}

      {accessLevel !== "FULL" && (
        <p className="max-w-3xl text-xs text-muted-foreground">
          Llevarte tus datos no consume cuota y no depende de que la suscripción esté al día: son tuyos.
        </p>
      )}

      {error && <FormError>{error}</FormError>}
    </section>
  )
}

function BackupList({ jobs }: { jobs: BackupJobView[] }) {
  return (
    <section className="space-y-3" data-testid="backup-list">
      <h3 className="text-lg font-semibold">Tus copias</h3>

      {jobs.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="backup-list-empty">
          Todavía no has creado ninguna copia de seguridad.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Creada</TableHead>
                <TableHead>Origen</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead className="text-right">Tamaño</TableHead>
                <TableHead>sha256</TableHead>
                <TableHead>Sellos</TableHead>
                <TableHead>Caduca</TableHead>
                <TableHead>Descarga</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((job) => (
                <TableRow key={job.id} data-testid={`backup-${job.id}`} data-status={job.status}>
                  <TableCell className="tabular-nums">{fecha(job.createdAt)}</TableCell>
                  <TableCell className="text-sm">{TRIGGER_LABELS[job.trigger] ?? job.trigger}</TableCell>
                  <TableCell className="text-sm">
                    {STATUS_LABELS[job.status] ?? job.status}
                    {(job.status === "RUNNING" || job.status === "QUEUED") && (
                      <span className="ml-2 tabular-nums text-xs text-muted-foreground">
                        {Math.floor(job.progressBps / 100)} %
                      </span>
                    )}
                    {job.error && <span className="block text-xs text-muted-foreground">{job.error}</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{bytes(job.sizeBytes)}</TableCell>
                  <TableCell className="font-mono text-xs">{shortSha(job.archiveSha256)}</TableCell>
                  <TableCell className="font-mono text-[11px] leading-tight">
                    <span className="block">diario {shortSha(job.ledgerHash)}</span>
                    <span className="block">analítica {shortSha(job.analyticsKey)}</span>
                    <span className="block">presupuesto {shortSha(job.budgetHash)}</span>
                  </TableCell>
                  <TableCell className="tabular-nums text-sm">{fecha(job.expiresAt)}</TableCell>
                  <TableCell className="text-sm">
                    {job.downloadable ? (
                      <a
                        className="underline underline-offset-2"
                        href={`/settings/backups/data?jobId=${job.id}`}
                        data-testid={`backup-download-${job.id}`}
                      >
                        Descargar
                      </a>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  )
}

function RestorePanel({ restores, canEdit }: { restores: RestoreJobView[]; canEdit: boolean }) {
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  /**
   * **E11 · integración** — el resultado de la restauración que se acaba de
   * lanzar se enseña AQUÍ y no en la lista de abajo, y hay un motivo: el
   * `RestoreJob` vive en la organización **destino** (es la que acota su RLS),
   * así que desde la de origen no se puede leer. La lista sigue enseñando las
   * restauraciones *hacia* esta organización; este bloque, la que acabas de
   * pedir, con sus seis comprobaciones enfrentadas.
   */
  const [recien, setRecien] = useState<RestoreJobView | null>(null)
  const [destino, setDestino] = useState<{ id: string; name: string } | null>(null)
  /**
   * **E12 · T16 · G-15b — inspeccionar antes de restaurar.**
   *
   * La pantalla mira el archivo primero: enseña de qué organización es, de qué
   * día, con qué esquema y con cuántas filas, y el veredicto de la firma. **Ni
   * un byte de datos se descomprime** para eso. Sólo cuando el archivo está
   * firmado por OTRA instalación aparece el campo de autorización, y sólo un
   * administrador de plataforma puede usarlo.
   */
  const [inspeccion, setInspeccion] = useState<InspectArchiveResult | null>(null)

  const inspeccionar = (formData: FormData) =>
    start(async () => {
      setError(null)
      setRecien(null)
      setDestino(null)
      setInspeccion(null)
      const result = await inspectRestoreArchiveAction(formData)
      if (!result.success || !result.data) {
        setError(result.error ?? "No se ha podido leer el archivo")
        return
      }
      setInspeccion(result.data)
      if (!result.data.admitido && !result.data.autorizable) {
        setError(`${result.data.motivo}: ${result.data.detalle ?? ""}`)
      }
    })

  const submit = (formData: FormData) =>
    start(async () => {
      setError(null)
      setRecien(null)
      setDestino(null)
      const result = await startRestoreAction(formData)
      if (!result.success || !result.data) {
        setError(result.error ?? "No se ha podido iniciar la restauración")
        return
      }
      setDestino({ id: result.data.organizationId, name: result.data.organizationName })
      setRecien({
        id: result.data.restoreJobId,
        status: result.data.status,
        verified: result.data.verified,
        progressBps: 10000,
        createdAt: new Date().toISOString(),
        checks: result.data.checks,
        error: null,
      })
    })

  return (
    <section className="space-y-4" data-testid="restore-panel">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold">Restaurar una copia</h3>
        <p
          className="max-w-3xl rounded-md border border-[#F5A623] bg-[#FFF8EC] px-3 py-2 text-sm font-medium"
          data-testid="restore-warning"
        >
          La restauración crea una <strong>organización nueva</strong>; la actual no se toca. Ningún camino de este
          producto sobrescribe ni borra un asiento ya contabilizado.
        </p>
      </div>

      {canEdit && (
        <form className="max-w-2xl space-y-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Archivo de copia (.zip)</span>
            <input type="file" name="file" accept=".zip" required data-testid="restore-file" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Motivo</span>
            <input
              type="text"
              name="reason"
              minLength={8}
              maxLength={200}
              required
              placeholder="Por qué se restaura y quién lo pide"
              className="w-full rounded-md border bg-background p-2 text-sm"
              data-testid="restore-reason"
            />
          </label>
          <p className="text-xs text-muted-foreground">El motivo queda en el registro de auditoría.</p>

          {inspeccion?.resumen && (
            <div
              className="rounded-md border bg-muted/40 p-3 text-xs space-y-1"
              data-testid="restore-inspection"
            >
              <p className="font-medium">
                Lo que dice el archivo (firma {inspeccion.admitido ? "reconocida" : `NO reconocida: ${inspeccion.motivo}`})
              </p>
              <p>
                Organización <strong>{inspeccion.resumen.organizationSlug}</strong> · copia del{" "}
                {fecha(inspeccion.resumen.createdAt)} · esquema <code>{inspeccion.resumen.schemaVersion}</code> ·{" "}
                {inspeccion.resumen.tablas} tablas, {inspeccion.resumen.filas} filas, {inspeccion.resumen.ficheros} ficheros
              </p>
              <p className="font-mono break-all">ledgerHash {inspeccion.resumen.ledgerHash}</p>
            </div>
          )}

          {inspeccion?.autorizable && (
            <label className="flex flex-col gap-1 text-sm" data-testid="restore-foreign">
              <span className="font-medium text-[#B45309]">
                Este archivo lo firmó otra instalación. Autorización del operador
              </span>
              <input
                type="text"
                name="foreignSignatureReason"
                minLength={20}
                maxLength={500}
                placeholder="Quién trae esta copia, de dónde viene y por qué se admite (mínimo 20 caracteres)"
                className="w-full rounded-md border bg-background p-2 text-sm"
                data-testid="restore-foreign-reason"
              />
              <span className="text-xs text-muted-foreground">
                Sólo un administrador de la plataforma puede autorizarlo, y queda registrado a su nombre.
              </span>
            </label>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              formAction={inspeccionar}
              size="sm"
              variant="outline"
              disabled={pending}
              data-testid="restore-inspect"
            >
              {pending ? "Leyendo el archivo…" : "Comprobar la firma del archivo"}
            </Button>
            <Button
              type="submit"
              formAction={submit}
              size="sm"
              variant="outline"
              disabled={pending || inspeccion === null || (!inspeccion.admitido && !inspeccion.autorizable)}
              data-testid="restore-submit"
            >
              {pending ? "Restaurando…" : "Restaurar en una organización nueva"}
            </Button>
          </div>
          {error && <FormError>{error}</FormError>}
        </form>
      )}

      {recien && destino && (
        <div className="space-y-2" data-testid="restore-result">
          <p className="text-sm">
            Restaurada en la organización nueva <strong>{destino.name}</strong>. La organización en la que estás no se
            ha tocado.
          </p>
          <RestoreVerification restore={recien} />
        </div>
      )}

      <div className="space-y-4">
        {restores.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="restore-list-empty">
            No hay ninguna restauración registrada.
          </p>
        ) : (
          restores.map((restore) => <RestoreVerification key={restore.id} restore={restore} />)
        )}
      </div>
    </section>
  )
}

/**
 * **Las seis comprobaciones enfrentadas, no tres hashes** (O-1/O-2). Y
 * `DONE_UNVERIFIED` se lee como lo que es: un fallo, no un «casi».
 */
function RestoreVerification({ restore }: { restore: RestoreJobView }) {
  return (
    <div className="space-y-2 rounded-md border p-3" data-testid={`restore-${restore.id}`} data-status={restore.status}>
      <p className="text-sm">
        <strong>{fecha(restore.createdAt)}</strong> · {STATUS_LABELS[restore.status] ?? restore.status}
        {restore.status === "DONE_UNVERIFIED" && (
          <span className="ml-2 text-xs text-[#B26E00]">
            la copia se cargó pero <strong>no se pudo verificar</strong>: no la des por buena
          </span>
        )}
      </p>
      {restore.error && <p className="text-xs text-muted-foreground">{restore.error}</p>}

      {restore.checks.length === 0 ? (
        <p className="text-xs text-muted-foreground">Todavía no hay resultado de verificación.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {restore.checks.map((check) => (
            <li
              key={check.key}
              className="flex gap-2"
              data-testid={`restore-check-${check.key}`}
              data-ok={check.ok}
              data-check-status={check.status}
            >
              <span aria-hidden>{check.status === "PASS" ? "✓" : check.status === "INFO" ? "·" : "⚠"}</span>
              <span className="min-w-0">
                {RESTORE_CHECK_LABELS[check.key] ?? check.label}
                {check.status === "INFO" && (
                  <span className="ml-1 text-xs text-muted-foreground">(sin evaluar: no acredita nada)</span>
                )}
                {check.detail && <span className="block text-xs text-muted-foreground">{check.detail}</span>}
                {check.evidence.length > 0 && (
                  <span className="mt-1 block space-y-0.5 text-xs text-muted-foreground">
                    {check.evidence.slice(0, 12).map((row) => (
                      <span key={row.label} className="block" data-ok={row.ok}>
                        {row.ok ? "·" : "≠"} {row.label}: origen <code>{row.expected}</code> · destino{" "}
                        <code>{row.actual}</code>
                      </span>
                    ))}
                    {check.evidence.length > 12 && (
                      <span className="block">(+{check.evidence.length - 12} línea(s) más)</span>
                    )}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
