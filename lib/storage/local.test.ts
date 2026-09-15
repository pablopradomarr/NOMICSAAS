import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { afterAll, describe, expect, it } from "vitest"
import { StorageIntegrityError, StorageObjectNotFound } from "./driver"
import { objectKey } from "./keys"
import { LocalDriver } from "./local"

const root = await mkdtemp(path.join(tmpdir(), "e11-store-"))
const driver = new LocalDriver(root)
const ORG = "11111111-1111-4111-8111-111111111111"

const sha = (buffer: Buffer): string => createHash("sha256").update(buffer).digest("hex")
const keyFor = (buffer: Buffer, kind: "DOCUMENT" | "BACKUP" = "DOCUMENT") =>
  objectKey({ prefix: "erp", organizationId: ORG, kind, sha256: sha(buffer) })

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("LocalDriver", () => {
  it("escribe, devuelve el tamaño y lee los mismos bytes", async () => {
    const body = Buffer.from("%PDF-1.4 una factura")
    const key = keyFor(body)
    const result = await driver.put(key, body, { mimeType: "application/pdf", sha256: sha(body) })
    expect(result.sizeBytes).toBe(BigInt(body.length))
    expect(await driver.getBuffer(key)).toEqual(body)
  })

  it("acepta un stream y lo mide sin cargarlo entero", async () => {
    const body = Buffer.from("x".repeat(70_000))
    const key = keyFor(body)
    const result = await driver.put(key, Readable.from([body.subarray(0, 30_000), body.subarray(30_000)]), {
      mimeType: "text/plain",
      sha256: sha(body),
    })
    expect(result.sizeBytes).toBe(BigInt(70_000))
    expect(sha(await driver.getBuffer(key))).toBe(sha(body))
  })

  it("RECHAZA los bytes que no cumplen el sha256 declarado y no deja nada escrito", async () => {
    const body = Buffer.from("contenido real")
    const key = keyFor(Buffer.from("otro contenido"))
    await expect(driver.put(key, body, { mimeType: "text/plain", sha256: sha(Buffer.from("otro contenido")) })).rejects.toBeInstanceOf(
      StorageIntegrityError
    )
    expect(await driver.head(key)).toBeNull()
  })

  it("el caso vacío: un fichero de cero bytes se guarda y se lee", async () => {
    const body = Buffer.alloc(0)
    const key = keyFor(body)
    const result = await driver.put(key, body, { mimeType: "text/plain", sha256: sha(body) })
    expect(result.sizeBytes).toBe(BigInt(0))
    expect(await driver.getBuffer(key)).toEqual(body)
  })

  it("`head` de un objeto ausente devuelve null; `get` LANZA", async () => {
    const key = keyFor(Buffer.from("nunca escrito"))
    expect(await driver.head(key)).toBeNull()
    await expect(driver.get(key)).rejects.toBeInstanceOf(StorageObjectNotFound)
  })

  it("es idempotente: reescribir el mismo contenido deja un solo objeto", async () => {
    const body = Buffer.from("idempotente")
    const key = keyFor(body)
    await driver.put(key, body, { mimeType: "text/plain", sha256: sha(body) })
    await driver.put(key, body, { mimeType: "text/plain", sha256: sha(body) })
    const listed = await driver.list(`erp/${ORG}/DOCUMENT/`)
    expect(listed.filter((candidate) => candidate === key)).toHaveLength(1)
  })

  it("`list` filtra por prefijo y no enseña los temporales a medio escribir", async () => {
    const body = Buffer.from("listable")
    const key = keyFor(body, "BACKUP")
    await driver.put(key, body, { mimeType: "application/zip", sha256: sha(body) })
    await writeFile(path.join(root, "erp", ORG, "BACKUP", "zz.part"), "a medias")
    const listed = await driver.list(`erp/${ORG}/BACKUP/`)
    expect(listed).toContain(key)
    expect(listed.some((candidate) => candidate.endsWith(".part"))).toBe(false)
  })

  it("`delete` es idempotente: borrar lo que no está no es un error", async () => {
    const body = Buffer.from("efímero")
    const key = keyFor(body)
    await driver.put(key, body, { mimeType: "text/plain", sha256: sha(body) })
    await driver.delete(key)
    await driver.delete(key)
    expect(await driver.head(key)).toBeNull()
  })

  it("no deja escribir fuera del raíz del almacén", async () => {
    await expect(
      driver.put("../fuera", Buffer.from("x"), { mimeType: "text/plain", sha256: sha(Buffer.from("x")) })
    ).rejects.toThrow(/se sale del raíz|clave no admisible/)
  })

  it("escribe de forma atómica: el objeto final no conserva sufijo temporal", async () => {
    const body = Buffer.from("atómico")
    const key = keyFor(body)
    await driver.put(key, body, { mimeType: "text/plain", sha256: sha(body) })
    expect(await readFile(path.join(root, key))).toEqual(body)
  })
})
