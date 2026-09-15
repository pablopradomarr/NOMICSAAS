import { describe, expect, it } from "vitest"
import {
  DEFAULT_STORAGE_PREFIX,
  StorageKeyError,
  assertKeyBelongsTo,
  kindPrefix,
  normalizePrefix,
  objectKey,
  organizationPrefix,
  parseObjectKey,
} from "./keys"

const ORG = "11111111-1111-4111-8111-111111111111"
const OTHER = "22222222-2222-4222-8222-222222222222"
const SHA = "a".repeat(64)

describe("normalizePrefix", () => {
  it("cae al prefijo por defecto cuando no hay nada configurado", () => {
    expect(normalizePrefix(undefined)).toBe(DEFAULT_STORAGE_PREFIX)
    expect(normalizePrefix("")).toBe(DEFAULT_STORAGE_PREFIX)
    expect(normalizePrefix("   ")).toBe(DEFAULT_STORAGE_PREFIX)
  })

  it("quita las barras de los extremos y conserva las de dentro", () => {
    expect(normalizePrefix("/erp/preview/")).toBe("erp/preview")
  })

  it("rechaza un prefijo con `..`: sería la puerta para salirse del bucket", () => {
    expect(() => normalizePrefix("erp/../otro")).toThrow(StorageKeyError)
  })
})

describe("objectKey", () => {
  it("compone `<prefijo>/<org>/<kind>/<sha[0:2]>/<sha>`", () => {
    expect(objectKey({ prefix: "erp", organizationId: ORG, kind: "DOCUMENT", sha256: SHA })).toBe(
      `erp/${ORG}/DOCUMENT/aa/${SHA}`
    )
  })

  it("es determinista: los mismos bytes dan la misma clave", () => {
    const a = objectKey({ organizationId: ORG, kind: "DOCUMENT", sha256: SHA })
    const b = objectKey({ organizationId: ORG, kind: "DOCUMENT", sha256: SHA })
    expect(a).toBe(b)
  })

  it("separa por `kind`: el mismo contenido como documento y como copia de backup no colisiona", () => {
    expect(objectKey({ organizationId: ORG, kind: "DOCUMENT", sha256: SHA })).not.toBe(
      objectKey({ organizationId: ORG, kind: "BACKUP", sha256: SHA })
    )
  })

  it("rechaza un organizationId que no sea uuid", () => {
    expect(() => objectKey({ organizationId: "../otra", kind: "DOCUMENT", sha256: SHA })).toThrow(StorageKeyError)
  })

  it("rechaza un sha256 que no sean 64 hex en minúscula", () => {
    expect(() => objectKey({ organizationId: ORG, kind: "DOCUMENT", sha256: "A".repeat(64) })).toThrow(StorageKeyError)
    expect(() => objectKey({ organizationId: ORG, kind: "DOCUMENT", sha256: "abc" })).toThrow(StorageKeyError)
  })
})

describe("parseObjectKey", () => {
  it("lee al revés una clave canónica", () => {
    const key = objectKey({ prefix: "erp/pre", organizationId: ORG, kind: "PREVIEW", sha256: SHA })
    expect(parseObjectKey(key)).toEqual({ prefix: "erp/pre", organizationId: ORG, kind: "PREVIEW", sha256: SHA })
  })

  it("devuelve null —no lanza— ante una clave ajena: el barrido tiene que poder seguir", () => {
    expect(parseObjectKey("otra/cosa")).toBeNull()
    expect(parseObjectKey(`erp/${ORG}/DOCUMENT/zz/${SHA}`)).toBeNull()
  })
})

describe("assertKeyBelongsTo", () => {
  it("acepta la clave de su propia organización", () => {
    const key = objectKey({ organizationId: ORG, kind: "DOCUMENT", sha256: SHA })
    expect(() => assertKeyBelongsTo(key, ORG)).not.toThrow()
  })

  it("LANZA con la clave de otra organización: una fuga es una excepción hoy, no un aviso mañana", () => {
    const key = objectKey({ organizationId: OTHER, kind: "DOCUMENT", sha256: SHA })
    expect(() => assertKeyBelongsTo(key, ORG)).toThrow(StorageKeyError)
  })
})

describe("prefijos", () => {
  it("el de organización termina en barra, para que `startsWith` no cace un uuid que empiece igual", () => {
    expect(organizationPrefix(ORG, "erp")).toBe(`erp/${ORG}/`)
    expect(kindPrefix(ORG, "BACKUP", "erp")).toBe(`erp/${ORG}/BACKUP/`)
  })
})
