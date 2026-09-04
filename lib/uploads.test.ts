import { afterAll, describe, expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm } from "fs/promises"
import { tmpdir } from "os"
import path from "path"

const tmpRoot = await mkdtemp(path.join(tmpdir(), "th-uploads-"))
process.env.UPLOAD_PATH = tmpRoot
process.env.SELF_HOSTED_MODE = "true"

const created: Record<string, unknown>[] = []
vi.mock("./config", () => ({
  default: {
    upload: { images: { maxWidth: 1920, maxHeight: 1080, quality: 80 } },
    selfHosted: { isEnabled: true },
  },
}))
vi.mock("@/models/files", () => ({
  createFile: vi.fn(async (_db: unknown, data: Record<string, unknown>) => {
    created.push(data)
    return data
  }),
}))
vi.mock("@/models/memberships", () => ({ listOrganizationMemberEmails: vi.fn(async () => []) }))
vi.mock("@/models/organizations", () => ({ updateOrganization: vi.fn() }))

const { ingestUnsortedFile } = await import("./uploads")

const user = { id: "user-1", email: "u@example.com" } as Record<string, unknown>
// E1 (T11): la cuota es de la organización; el contexto de subida lleva db + org + user.
const organization = { id: "org-1", storageUsed: 0, storageLimit: -1 } as Record<string, unknown>
const ctx = { db: {}, organization, user } as unknown as Parameters<typeof ingestUnsortedFile>[0]

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

describe("ingestUnsortedFile", () => {
  it("writes the buffer under the user's unsorted dir and creates an unsorted File row", async () => {
    const buffer = Buffer.from("%PDF-1.4 fake invoice")
    const file = await ingestUnsortedFile(ctx, {
      buffer,
      filename: "invoice.pdf",
      mimetype: "application/pdf",
      metadata: { source: "email" },
    })

    expect(file.filename).toBe("invoice.pdf")
    expect(file.mimetype).toBe("application/pdf")
    expect(file.path).toMatch(/^unsorted\/.+\.pdf$/)
    expect((file.metadata as Record<string, unknown>).source).toBe("email")

    const onDisk = await readFile(path.join(tmpRoot, user.email, file.path))
    expect(onDisk.equals(buffer)).toBe(true)
    expect(created).toHaveLength(1)
  })
})
