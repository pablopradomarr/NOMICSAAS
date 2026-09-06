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
  // E8 · T19 (G-11): la ingesta consulta los ficheros con los MISMOS bytes.
  findFilesBySha256: vi.fn(async () => []),
}))
vi.mock("@/models/organizations", () => ({ updateOrganization: vi.fn() }))

const { ingestUnsortedFile, assertAcceptableUpload, sniffFileExtension, UploadValidationError, MAX_UPLOAD_FILE_SIZE } =
  await import("./uploads")

const user = { id: "user-1", email: "u@example.com" } as Record<string, unknown>
// E1 (T11): la cuota es de la organización; el contexto de subida lleva db + org + user.
// E1-fix (#3): el uuid es el nombre del directorio físico de la organización.
const organization = {
  id: "11111111-1111-4111-8111-111111111111",
  storageUsed: 0,
  storageLimit: -1,
} as Record<string, unknown>
const ctx = { db: {}, organization, user } as unknown as Parameters<typeof ingestUnsortedFile>[0]

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

describe("ingestUnsortedFile", () => {
  it("escribe el buffer bajo el directorio de la ORGANIZACIÓN y crea la fila File (#3)", async () => {
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

    const onDisk = await readFile(path.join(tmpRoot, organization.id as string, file.path))
    expect(onDisk.equals(buffer)).toBe(true)
    expect(created).toHaveLength(1)
  })

  it("rechaza un ejecutable disfrazado de pdf (#18)", async () => {
    await expect(
      ingestUnsortedFile(ctx, {
        buffer: Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]),
        filename: "factura.pdf",
        mimetype: "application/pdf",
      })
    ).rejects.toThrow(UploadValidationError)
  })
})

describe("sniffFileExtension()", () => {
  it("reconoce pdf, png y jpeg por magic bytes", () => {
    expect(sniffFileExtension(Buffer.from("%PDF-1.7"))).toBe("pdf")
    expect(sniffFileExtension(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("png")
    expect(sniffFileExtension(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpg")
  })

  it("devuelve null para texto plano (sin firma binaria)", () => {
    expect(sniffFileExtension(Buffer.from("fecha;importe\n2026-01-01;100"))).toBeNull()
  })

  it("no se confunde con el buffer vacío", () => {
    expect(sniffFileExtension(Buffer.alloc(0))).toBeNull()
  })
})

describe("assertAcceptableUpload()", () => {
  it("acepta un pdf real y devuelve el mimetype canónico", () => {
    expect(assertAcceptableUpload("f.pdf", Buffer.from("%PDF-1.4 x"))).toBe("application/pdf")
  })

  it("acepta csv por extensión aunque no tenga firma", () => {
    expect(assertAcceptableUpload("movimientos.csv", Buffer.from("a;b\n1;2"))).toBe("text/csv")
  })

  it("rechaza una extensión fuera de la lista blanca", () => {
    expect(() => assertAcceptableUpload("payload.exe", Buffer.from("%PDF-1.4"))).toThrow(UploadValidationError)
  })

  it("rechaza un png con extensión .pdf (contenido ≠ extensión)", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(() => assertAcceptableUpload("f.pdf", png)).toThrow(/no coincide/)
  })

  it("rechaza un binario con extensión .csv", () => {
    expect(() => assertAcceptableUpload("f.csv", Buffer.from([0x7f, 0x45, 0x4c, 0x46]))).toThrow(UploadValidationError)
  })

  it("rechaza el fichero vacío y el que supera el límite por fichero", () => {
    expect(() => assertAcceptableUpload("f.pdf", Buffer.alloc(0))).toThrow(/vacío/)
    const big = Buffer.alloc(MAX_UPLOAD_FILE_SIZE + 1)
    big.write("%PDF-1.4")
    expect(() => assertAcceptableUpload("f.pdf", big)).toThrow(/límite/)
  })
})
