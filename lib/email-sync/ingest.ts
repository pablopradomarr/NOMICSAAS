import { Prisma } from "@/prisma/client"
import { prisma, tenantDb, withTenantGucs } from "@/lib/db"
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

export async function runEmailSync(
  scope: { organizationId?: string; userId?: string; serverId?: string; respectInterval?: boolean } = {}
): Promise<SyncResult[]> {
  // Cliente sin tenant a propósito: el cron recorre TODAS las organizaciones y
  // acota cada iteración con `tenantDb(row.organizationId)`.
  const rows = await prisma.appData.findMany({
    where: {
      app: "email",
      ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
      ...(scope.userId ? { userId: scope.userId } : {}),
    },
    include: { user: true, organization: true },
  })

  const results: SyncResult[] = []
  for (const row of rows) {
    const data = row.data as Record<string, unknown>
    const servers: EmailServer[] = ((data?.servers as EmailServer[]) || []).filter(
      (s) => s.isActive && (!scope.serverId || s.id === scope.serverId)
    )
    for (const server of servers) {
      if (scope.respectInterval && isThrottled(server)) continue
      const ctx: UploadContext = {
        db: tenantDb(row.organizationId),
        organization: row.organization satisfies Organization,
        user: row.user satisfies User,
      }
      const result = await syncServer(server, ctx)
      await applySyncResult(row.organizationId, row.userId, result)
      if (result.processed > 0) {
        await syncOrganizationStorage(row.organizationId)
      }
      results.push(result)
    }
  }
  return results
}
