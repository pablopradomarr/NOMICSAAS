import { Prisma } from "@/prisma/client"
import { prisma, tenantDb, withTenantGucs } from "@/lib/db"
import { isMaintenanceConfigured, withMaintenanceClient } from "@/lib/db-maintenance"
import { decryptSecret } from "@/lib/encryption"
import { ingestUnsortedFile, syncOrganizationStorage, UploadContext } from "@/lib/uploads"
import { File, Organization, User } from "@/prisma/client"
import { attachmentMatchesExtensions, buildSearchCriteria } from "./filters"
import { realImapClient } from "./imap-client"
import { EmailServer, ImapClient, SyncResult } from "./types"

type SyncDeps = {
  client?: ImapClient
  ingest?: (
    ctx: UploadContext,
    input: { buffer: Buffer; filename: string; mimetype: string; metadata?: Record<string, unknown> }
  ) => Promise<File>
}

export async function syncServer(
  server: EmailServer,
  ctx: UploadContext,
  deps: SyncDeps = {}
): Promise<SyncResult> {
  const client = deps.client ?? realImapClient
  const ingest = deps.ingest ?? ingestUnsortedFile

  let password: string
  try {
    password = decryptSecret(server.password)
  } catch {
    return {
      serverId: server.id,
      processed: 0,
      lastProcessedUid: server.lastProcessedUid,
      status: "error",
      errorMessage:
        "Stored password could not be decrypted — please re-enter it (this happens if BETTER_AUTH_SECRET changed).",
    }
  }

  try {
    const messages = await client.fetchMessages(
      {
        user: server.username,
        password,
        host: server.host,
        port: server.port,
        tls: server.useSSL,
      },
      buildSearchCriteria(server)
    )

    let processed = 0
    const watermark = server.lastProcessedUid ?? 0
    let maxUid = watermark

    for (const message of [...messages].sort((a, b) => a.uid - b.uid)) {
      // Defend against the IMAP `UID n:*` quirk: `*` matches the highest existing UID,
      // so `(last+1):*` can re-return the watermark message when there is no newer mail.
      if (message.uid <= watermark) continue
      for (const attachment of message.attachments) {
        if (!attachmentMatchesExtensions(attachment.filename, server.allowedExtensions)) continue
        await ingest(ctx, {
          buffer: attachment.content,
          filename: attachment.filename,
          mimetype: attachment.contentType,
          metadata: {
            source: "email",
            emailServer: server.id,
            messageId: message.messageId,
            emailSubject: message.subject,
            emailFrom: message.from,
            emailDate: message.date?.toISOString(),
          },
        })
        processed++
      }
      if (message.uid > maxUid) maxUid = message.uid
    }

    return { serverId: server.id, processed, lastProcessedUid: maxUid, status: "connected" }
  } catch (error) {
    return {
      serverId: server.id,
      processed: 0,
      lastProcessedUid: server.lastProcessedUid,
      status: "error",
      errorMessage: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Exportada para el test de RLS con `app_runtime` (ronda 2, #4/#6). */
export async function applySyncResult(organizationId: string, userId: string, result: SyncResult) {
  // Lock the row and re-read the CURRENT data inside the transaction so a concurrent sync
  // (the hourly cron container vs. a manual "Sync Now" in the web app) can't clobber the
  // other's watermark/status with a stale read-modify-write.
  // Ronda 2 (#4): la transacción no fijaba los GUC de tenant, así que el UPDATE
  // de `app_data` violaba el WITH CHECK de RLS en cuanto la app conecta como
  // `app_runtime`. `withTenantGucs` los fija y reutiliza la transacción si ya
  // hubiera una abierta para esta organización.
  await withTenantGucs(organizationId, userId, async (tx) => {
    const locked = await tx.$queryRaw<{ data: Record<string, unknown> }[]>`
      SELECT data FROM app_data
      WHERE organization_id = ${organizationId}::uuid AND user_id = ${userId}::uuid AND app = 'email'
      FOR UPDATE
    `
    if (!locked.length) return
    const data = locked[0].data as Record<string, unknown>
    const now = new Date().toISOString()
    data.servers = ((data.servers as EmailServer[]) || []).map((s) =>
      s.id === result.serverId
        ? {
            ...s,
            status: result.status,
            errorMessage: result.errorMessage ?? null,
            lastSyncedAt: now,
            lastProcessedUid: result.lastProcessedUid ?? s.lastProcessedUid,
          }
        : s
    )
    await tx.appData.update({
      where: { organizationId_userId_app: { organizationId, userId, app: "email" } },
      data: { data: data as Prisma.InputJsonValue },
    })
  })
}

// Per-server throttle: when the cron runs, skip a server whose last sync is more recent
// than its configured interval. Manual "Sync Now" passes respectInterval=false to bypass.
function isThrottled(server: EmailServer): boolean {
  if (!server.lastSyncedAt) return false
  const intervalMinutes = server.syncInterval ?? 60
  const elapsedMinutes = (Date.now() - new Date(server.lastSyncedAt).getTime()) / 60_000
  return elapsedMinutes < intervalMinutes
}

export type EmailSyncTarget = { organizationId: string; userId: string }

/**
 * Enumera los pares (organización, usuario) con app de email configurada.
 *
 * E3-T2 (ADR-0009 §5). Antes era un `prisma.appData.findMany` SIN GUC que se
 * apoyaba en la cláusula de escape `OR app.current_org() IS NULL`: al retirarla
 * devolvería 0 filas y **el cron dejaría de sincronizar en silencio, sin
 * error**. Ahora:
 *
 *   · con `scope.organizationId`, no hace falta ver más de una organización: se
 *     lee con `app.current_org` fijado, como cualquier otra lectura de negocio
 *     (es el camino del botón «Sincronizar ahora» de la aplicación web);
 *   · sin él —el barrido del cron— se usa la puerta estrecha
 *     `app.list_email_sync_targets()`, `SECURITY DEFINER`, que devuelve SÓLO el
 *     par de identificadores: ni credenciales ni `data`. El contenedor del cron
 *     puede además llevar `DATABASE_URL_MAINTENANCE` y hacer el barrido como
 *     `app_maintenance` (ADR-0009 §6); se prefiere si está configurada.
 */
export async function listEmailSyncTargets(
  scope: { organizationId?: string; userId?: string } = {}
): Promise<EmailSyncTarget[]> {
  if (scope.organizationId) {
    const organizationId = scope.organizationId
    const rows = await withTenantGucs(organizationId, scope.userId, async (tx) =>
      tx.appData.findMany({
        where: { app: "email", organizationId, ...(scope.userId ? { userId: scope.userId } : {}) },
        select: { organizationId: true, userId: true },
        orderBy: [{ organizationId: "asc" }, { userId: "asc" }],
      })
    )
    return rows.map((row) => ({ organizationId: row.organizationId, userId: row.userId }))
  }

  const filterByUser = (targets: EmailSyncTarget[]) =>
    scope.userId ? targets.filter((t) => t.userId === scope.userId) : targets

  if (isMaintenanceConfigured()) {
    const rows = await withMaintenanceClient(async (client) =>
      client.query<{ organization_id: string; user_id: string }>(
        `SELECT d.organization_id, d.user_id
           FROM app_data d JOIN organizations o ON o.id = d.organization_id
          WHERE d.app = 'email' AND o.is_active
          ORDER BY d.organization_id, d.user_id`
      )
    )
    return filterByUser(rows.rows.map((r) => ({ organizationId: r.organization_id, userId: r.user_id })))
  }

  const rows = await prisma.$queryRaw<{ organization_id: string; user_id: string }[]>`
    SELECT organization_id, user_id FROM app.list_email_sync_targets()
  `
  return filterByUser(rows.map((r) => ({ organizationId: r.organization_id, userId: r.user_id })))
}

/**
 * Carga, EN UNA sola transacción de tenant, todo lo que necesita una iteración
 * del sync: la configuración de la app de email, la organización y el usuario
 * (deuda 3 de `docs/ESTADO.md`, §2.6 del diseño). La transacción se cierra ANTES
 * de hablar con el servidor IMAP: una conexión del pool no se queda abierta
 * mientras dura una descarga de adjuntos.
 */
async function loadSyncContext(
  target: EmailSyncTarget
): Promise<{ servers: EmailServer[]; organization: Organization; user: User } | null> {
  return await withTenantGucs(target.organizationId, target.userId, async (tx) => {
    const row = await tx.appData.findUnique({
      where: {
        organizationId_userId_app: {
          organizationId: target.organizationId,
          userId: target.userId,
          app: "email",
        },
      },
      include: { user: true, organization: true },
    })
    if (!row) return null
    const data = row.data as Record<string, unknown>
    return {
      servers: (data?.servers as EmailServer[]) || [],
      organization: row.organization satisfies Organization,
      user: row.user satisfies User,
    }
  })
}

export async function runEmailSync(
  scope: { organizationId?: string; userId?: string; serverId?: string; respectInterval?: boolean } = {}
): Promise<SyncResult[]> {
  const targets = await listEmailSyncTargets(scope)

  const results: SyncResult[] = []
  for (const target of targets) {
    const loaded = await loadSyncContext(target)
    if (!loaded) continue
    const servers = loaded.servers.filter((s) => s.isActive && (!scope.serverId || s.id === scope.serverId))
    for (const server of servers) {
      if (scope.respectInterval && isThrottled(server)) continue
      const ctx: UploadContext = {
        db: tenantDb(target.organizationId),
        organization: loaded.organization,
        user: loaded.user,
      }
      const result = await syncServer(server, ctx)
      await applySyncResult(target.organizationId, target.userId, result)
      if (result.processed > 0) {
        await syncOrganizationStorage(target.organizationId)
      }
      results.push(result)
    }
  }
  return results
}
