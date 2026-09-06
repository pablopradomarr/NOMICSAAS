import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// --- import-time mocks so importing ./ingest doesn't run config Zod validation or create a Prisma client ---
vi.mock("@/lib/uploads", async () => {
  const { createHash } = await import("node:crypto")
  return {
    ingestUnsortedFile: vi.fn(),
    syncOrganizationStorage: vi.fn(),
    // E8 · T19 (G-22): el dedupe de adjuntos necesita el sha REAL de los bytes.
    sha256OfBuffer: (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex"),
  }
})
/** G-22: ficheros ya ingeridos que el dedupe encuentra por sha. Vacío por defecto. */
const alreadyIngested = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }))
vi.mock("@/models/files", () => ({
  findFilesBySha256: vi.fn(async () => alreadyIngested.rows),
}))
// E3-T2: `runEmailSync` ya no hace un `findMany` cross-org sin GUC. Enumera los
// destinos por la puerta `app.list_email_sync_targets()` (`prisma.$queryRaw`) y
// carga cada iteración dentro de `withTenantGucs`. El fixture de la fila de
// `app_data` se inyecta con `setEmailRow`.
const fixture = vi.hoisted(() => ({ row: null as Record<string, unknown> | null }))

vi.mock("@/lib/db", () => {
  // applyResult now locks + re-reads inside a transaction; provide a tx with $queryRaw + update.
  const tx = {
    $queryRaw: vi.fn(async () => [{ data: { servers: [] } }]),
    appData: { update: vi.fn(), findUnique: vi.fn(async () => fixture.row) },
  }
  return {
    prisma: {
      $queryRaw: vi.fn(async () =>
        fixture.row
          ? [{ organization_id: fixture.row.organizationId, user_id: fixture.row.userId }]
          : []
      ),
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
    },
    tenantDb: vi.fn(() => ({})),
    // Ronda 2 (#4): applySyncResult fija los GUC de tenant con withTenantGucs.
    withTenantGucs: vi.fn(async (_org: unknown, _user: unknown, fn: (tx: unknown) => unknown) => fn(tx)),
  }
})
vi.mock("@/lib/db-maintenance", () => ({
  // Sin `DATABASE_URL_MAINTENANCE` el barrido usa la función SECURITY DEFINER.
  isMaintenanceConfigured: () => false,
  withMaintenanceClient: vi.fn(),
}))
vi.mock("@/lib/files", () => ({ getDirectorySize: vi.fn(), getOrganizationUploadsDirectory: vi.fn(() => "dir") }))
vi.mock("@/models/users", () => ({ updateUser: vi.fn() }))
vi.mock("@/lib/email-sync/imap-client", () => ({ realImapClient: { fetchMessages: vi.fn() } }))

const { syncServer, runEmailSync } = await import("./ingest")
import { realImapClient } from "@/lib/email-sync/imap-client"
import { ingestUnsortedFile, syncOrganizationStorage } from "@/lib/uploads"
import { File, User } from "@/prisma/client"
import { EmailServer, ImapClient, ImapMessage } from "./types"
import { createHash } from "node:crypto"

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret-key-for-encryption-unit-tests"
})

const user = { id: "user-1", email: "u@example.com" } as unknown as User
const organization = { id: "org-1", storageUsed: 0, storageLimit: -1 }
// E1 (T10/T11): syncServer recibe el contexto de tenant, no un User suelto.
const ctx = { db: {}, organization, user } as unknown as Parameters<typeof syncServer>[1]

/** Fija la (única) fila de `app_data` que ven la puerta y `loadSyncContext`. */
function setEmailRow(row: Record<string, unknown>) {
  fixture.row = row
}

function makeServer(overrides: Partial<EmailServer> = {}): EmailServer {
  return {
    id: "srv-1", name: "Inbox", provider: "custom", host: "imap.example.com", port: 993,
    username: "u@example.com", password: "plaintext-pw", useSSL: true, isActive: true,
    status: "pending", allowedExtensions: [".pdf"], syncInterval: 1,
    addedAt: "2026-06-01T00:00:00.000Z", ...overrides,
  }
}

function fakeClient(messages: ImapMessage[]): ImapClient {
  return { fetchMessages: vi.fn(async () => messages) }
}

describe("syncServer", () => {
  it("ingests matching attachments and advances the UID watermark", async () => {
    const ingested: { filename: string }[] = []
    const messages: ImapMessage[] = [
      {
        uid: 10, messageId: "<a@x>", subject: "Invoice", from: "biz@x.com", date: new Date(),
        attachments: [
          { filename: "invoice.pdf", contentType: "application/pdf", content: Buffer.from("pdf"), size: 3 },
          { filename: "logo.gif", contentType: "image/gif", content: Buffer.from("gif"), size: 3 },
        ],
      },
      { uid: 12, attachments: [{ filename: "receipt.pdf", contentType: "application/pdf", content: Buffer.from("r"), size: 1 }] },
    ]

    const result = await syncServer(makeServer(), ctx, {
      client: fakeClient(messages),
      ingest: async (_ctx, input) => { ingested.push(input); return { id: "f", ...input } as unknown as File },
    })

    expect(ingested.map((i) => i.filename)).toEqual(["invoice.pdf", "receipt.pdf"])
    expect(result.processed).toBe(2)
    expect(result.lastProcessedUid).toBe(12)
    expect(result.status).toBe("connected")
  })

  /**
   * E8 · T19 (cierre de G-22). El watermark protege una vez; en cuanto alguien
   * lo reinicia —para recuperar un correo perdido— el buzón entero se reingiere
   * y la bandeja se llena de gastos duplicados. La clave dura es (bytes,
   * mensaje).
   */
  describe("dedupe de adjuntos por sha256 + messageId (G-22)", () => {
    const attachment = { filename: "invoice.pdf", contentType: "application/pdf", content: Buffer.from("pdf"), size: 3 }
    const message: ImapMessage = { uid: 10, messageId: "<a@x>", attachments: [attachment] }
    const sha = createHash("sha256").update(attachment.content).digest("hex")

    beforeEach(() => {
      alreadyIngested.rows = []
    })

    it("no vuelve a ingerir el MISMO adjunto del MISMO correo aunque se reinicie el watermark", async () => {
      alreadyIngested.rows = [
        { id: "f-1", sha256: sha, metadata: { source: "email", emailServer: "srv-1", messageId: "<a@x>" } },
      ]
      const ingested: { filename: string }[] = []
      const result = await syncServer(makeServer({ lastProcessedUid: 0 }), ctx, {
        client: fakeClient([message]),
        ingest: async (_ctx, input) => { ingested.push(input); return { id: "f", ...input } as unknown as File },
      })

      expect(ingested).toEqual([])
      expect(result.processed).toBe(0)
      expect(result.skippedDuplicates).toBe(1)
      // El watermark SÍ avanza: el mensaje se ha procesado, sencillamente no
      // había nada nuevo que guardar.
      expect(result.lastProcessedUid).toBe(10)
    })

    it("el mismo adjunto en OTRO correo sí entra: son dos hechos distintos", async () => {
      alreadyIngested.rows = [
        { id: "f-1", sha256: sha, metadata: { source: "email", emailServer: "srv-1", messageId: "<otro@x>" } },
      ]
      const ingested: { filename: string }[] = []
      const result = await syncServer(makeServer(), ctx, {
        client: fakeClient([message]),
        ingest: async (_ctx, input) => { ingested.push(input); return { id: "f", ...input } as unknown as File },
      })

      expect(ingested.map((i) => i.filename)).toEqual(["invoice.pdf"])
      expect(result.processed).toBe(1)
      expect(result.skippedDuplicates).toBe(0)
    })

    it("un fichero con los mismos bytes que NO vino del correo no bloquea la ingesta", async () => {
      alreadyIngested.rows = [{ id: "f-1", sha256: sha, metadata: { source: "upload" } }]
      const result = await syncServer(makeServer(), ctx, {
        client: fakeClient([message]),
        ingest: async (_ctx, input) => ({ id: "f", ...input }) as unknown as File,
      })
      expect(result.processed).toBe(1)
    })
  })

  it("does not advance the watermark when there are no new messages", async () => {
    const result = await syncServer(makeServer({ lastProcessedUid: 5 }), ctx, {
      client: fakeClient([]), ingest: async () => ({}) as unknown as File,
    })
    expect(result.processed).toBe(0)
    expect(result.lastProcessedUid).toBe(5)
    expect(result.status).toBe("connected")
  })

  it("skips messages at or below the watermark (defends against the IMAP `UID n:*` re-fetch quirk)", async () => {
    const ingested: { filename: string }[] = []
    // Some servers (Gmail/Dovecot) return the highest existing UID for `UID (last+1):*`
    // when there is no newer mail — re-delivering the watermark message.
    const result = await syncServer(makeServer({ lastProcessedUid: 603 }), ctx, {
      client: fakeClient([
        { uid: 603, attachments: [{ filename: "dup.pdf", contentType: "application/pdf", content: Buffer.from("x"), size: 1 }] },
      ]),
      ingest: async (_ctx, input) => { ingested.push(input); return { id: "f" } as unknown as File },
    })
    expect(ingested).toHaveLength(0)
    expect(result.processed).toBe(0)
    expect(result.lastProcessedUid).toBe(603)
  })

  it("returns a friendly error when the stored password cannot be decrypted", async () => {
    const result = await syncServer(makeServer({ password: "v1:bad:bad:bad", lastProcessedUid: 9 }), ctx, {
      client: fakeClient([]),
      ingest: async () => ({}) as unknown as File,
    })
    expect(result.status).toBe("error")
    expect(result.errorMessage).toMatch(/could not be decrypted/i)
    expect(result.lastProcessedUid).toBe(9)
  })

  it("reports error status and keeps the old watermark on client failure", async () => {
    const result = await syncServer(makeServer({ lastProcessedUid: 7 }), ctx, {
      client: { fetchMessages: vi.fn(async () => { throw new Error("auth failed") }) },
      ingest: async () => ({}) as unknown as File,
    })
    expect(result.status).toBe("error")
    expect(result.errorMessage).toContain("auth failed")
    expect(result.lastProcessedUid).toBe(7)
  })
})

describe("runEmailSync storage recompute guard", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setEmailRow({ userId: "u1", organizationId: "org-1", user, organization, data: { servers: [makeServer()] } })
  })

  it("skips the storage recompute when nothing was ingested (regression: ENOENT on missing uploads dir)", async () => {
    vi.mocked(realImapClient.fetchMessages).mockResolvedValue([]) // 0 attachments
    await runEmailSync()
    expect(syncOrganizationStorage).not.toHaveBeenCalled()
  })

  it("recomputes storage when at least one attachment was ingested", async () => {
    vi.mocked(realImapClient.fetchMessages).mockResolvedValue([
      { uid: 20, attachments: [{ filename: "a.pdf", contentType: "application/pdf", content: Buffer.from("x"), size: 1 }] },
    ])
    vi.mocked(ingestUnsortedFile).mockResolvedValue({ id: "f" } as unknown as File)
    await runEmailSync()
    expect(syncOrganizationStorage).toHaveBeenCalledWith("org-1")
  })

  it("cron run (respectInterval) skips a server still within its syncInterval", async () => {
    setEmailRow({ userId: "u1", organizationId: "org-1", user, organization, data: { servers: [makeServer({ lastSyncedAt: new Date().toISOString(), syncInterval: 6 })] } })
    const results = await runEmailSync({ respectInterval: true })
    expect(realImapClient.fetchMessages).not.toHaveBeenCalled()
    expect(results).toHaveLength(0)
  })

  it("treats syncInterval as MINUTES: a server synced 90 min ago with interval 60 is not throttled", async () => {
    setEmailRow({
        userId: "u1",
        organizationId: "org-1",
        user,
        organization,
        data: { servers: [makeServer({ lastSyncedAt: new Date(Date.now() - 90 * 60_000).toISOString(), syncInterval: 60 })] },
      })
    vi.mocked(realImapClient.fetchMessages).mockResolvedValue([])
    await runEmailSync({ respectInterval: true })
    expect(realImapClient.fetchMessages).toHaveBeenCalledTimes(1)
  })

  it("manual sync (no respectInterval) bypasses the interval throttle", async () => {
    setEmailRow({ userId: "u1", organizationId: "org-1", user, organization, data: { servers: [makeServer({ lastSyncedAt: new Date().toISOString(), syncInterval: 6 })] } })
    vi.mocked(realImapClient.fetchMessages).mockResolvedValue([])
    await runEmailSync({ userId: "u1" })
    expect(realImapClient.fetchMessages).toHaveBeenCalledTimes(1)
  })
})
