import { describe, expect, it } from "vitest"
import {
  BILLABLE_BACKUP_TRIGGERS,
  BILLABLE_STORAGE_KINDS,
  SYSTEM_ENTRY_KINDS,
  UsageInputError,
  computeUsage,
  monthBounds,
  periodMonthOf,
  usageSourceHash,
  type UsageInput,
} from "./usage"

const REF = new Date("2026-09-15T10:00:00.000Z")

const base: UsageInput = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  periodMonth: "2026-09-01",
  isDemo: false,
  figures: { members: 3, entries: 120, ocrDocs: 40, exports: 2, backups: 1, storageBytes: BigInt(1_500_000) },
  sources: [
    { table: "journal_entries", rows: 120, maxUpdatedAt: "2026-09-14T08:00:00.000Z" },
    { table: "stored_objects", rows: 40, maxUpdatedAt: "2026-09-14T09:00:00.000Z" },
  ],
  ledgerHashOfMonth: "f".repeat(64),
  storageByKind: [
    { kind: "DOCUMENT", bytes: BigInt(1_400_000) },
    { kind: "BACKUP", bytes: BigInt(9_000_000) },
  ],
  acceptedMembers: 3,
}

describe("computeUsage", () => {
  it("el caso vacío: una organización sin nada da seis ceros", () => {
    const empty: UsageInput = {
      ...base,
      figures: { members: 0, entries: 0, ocrDocs: 0, exports: 0, backups: 0, storageBytes: BigInt(0) },
      sources: [],
      ledgerHashOfMonth: null,
      storageByKind: [],
      acceptedMembers: 0,
    }
    expect(computeUsage(empty, REF)).toEqual({
      members: 0,
      entries: 0,
      ocrDocs: 0,
      exports: 0,
      backups: 0,
      storageBytes: BigInt(0),
    })
  })

  it("un registro: devuelve las cifras tal cual llegan del agregado", () => {
    expect(computeUsage(base, REF)).toEqual(base.figures)
  })

  it("**O-6** — una organización de demo consume CERO en las seis métricas", () => {
    const demo = computeUsage({ ...base, isDemo: true }, REF)
    expect(demo).toEqual({ members: 0, entries: 0, ocrDocs: 0, exports: 0, backups: 0, storageBytes: BigInt(0) })
  })

  it("rechaza una métrica negativa: un uso negativo es un bug de la consulta, no un cero", () => {
    expect(() => computeUsage({ ...base, figures: { ...base.figures, entries: -1 } }, REF)).toThrow(UsageInputError)
    expect(() =>
      computeUsage({ ...base, figures: { ...base.figures, storageBytes: BigInt(-1) } }, REF)
    ).toThrow(UsageInputError)
  })

  it("rechaza un mes posterior a la fecha de referencia", () => {
    expect(() => computeUsage({ ...base, periodMonth: "2026-10-01" }, REF)).toThrow(UsageInputError)
  })

  it("acepta el mes en curso y los anteriores", () => {
    expect(() => computeUsage({ ...base, periodMonth: "2026-09-01" }, REF)).not.toThrow()
    expect(() => computeUsage({ ...base, periodMonth: "2025-12-01" }, REF)).not.toThrow()
  })

  it("rechaza un `periodMonth` que no sea el día 1", () => {
    expect(() => computeUsage({ ...base, periodMonth: "2026-09-15" }, REF)).toThrow(UsageInputError)
  })
})

describe("usageSourceHash", () => {
  it("es estable frente al ORDEN de las fuentes: sin eso, dos lecturas darían caché distinta", () => {
    const reordered: UsageInput = {
      ...base,
      sources: [...base.sources].reverse(),
      storageByKind: [...base.storageByKind].reverse(),
    }
    expect(usageSourceHash(reordered)).toBe(usageSourceHash(base))
  })

  it("**baja** cuando baja un recuento: es lo que un `updatedAt` no detecta", () => {
    const anulado: UsageInput = {
      ...base,
      sources: [{ ...base.sources[0], rows: 119 }, base.sources[1]],
    }
    expect(usageSourceHash(anulado)).not.toBe(usageSourceHash(base))
  })

  it("cambia con el `ledgerHash` DEL MES (O-12b): dos meses no pueden colisionar", () => {
    expect(usageSourceHash({ ...base, ledgerHashOfMonth: "a".repeat(64) })).not.toBe(usageSourceHash(base))
    expect(usageSourceHash({ ...base, periodMonth: "2026-08-01" })).not.toBe(usageSourceHash(base))
  })

  it("cambia con el desglose por `kind` (O-12c) aunque el total sea el mismo", () => {
    const movido: UsageInput = {
      ...base,
      storageByKind: [
        { kind: "DOCUMENT", bytes: BigInt(9_000_000) },
        { kind: "BACKUP", bytes: BigInt(1_400_000) },
      ],
    }
    expect(usageSourceHash(movido)).not.toBe(usageSourceHash(base))
  })

  it("NO entra ninguna cifra derivada: cambiar las seis métricas no mueve el hash", () => {
    const otras: UsageInput = {
      ...base,
      figures: { members: 99, entries: 999, ocrDocs: 99, exports: 99, backups: 99, storageBytes: BigInt(99) },
    }
    expect(usageSourceHash(otras)).toBe(usageSourceHash(base))
  })

  it("la marca de demo entra en el hash: si no, la caché de antes de marcarla seguiría sirviendo", () => {
    expect(usageSourceHash({ ...base, isDemo: true })).not.toBe(usageSourceHash(base))
  })
})

describe("meses", () => {
  it("`periodMonthOf` devuelve el día 1", () => {
    expect(periodMonthOf(new Date("2026-02-28T23:59:59.000Z"))).toBe("2026-02-01")
  })

  it("los límites de febrero bisiesto cierran el 1 de marzo", () => {
    const { start, endExclusive } = monthBounds("2028-02-01")
    expect(start.toISOString()).toBe("2028-02-01T00:00:00.000Z")
    expect(endExclusive.toISOString()).toBe("2028-03-01T00:00:00.000Z")
  })

  it("los de diciembre cruzan de año", () => {
    expect(monthBounds("2026-12-01").endExclusive.toISOString()).toBe("2027-01-01T00:00:00.000Z")
  })
})

describe("las listas de exclusión están declaradas en UN solo sitio", () => {
  it("los asientos de sistema y los contra-asientos no cuentan (O-5)", () => {
    expect(SYSTEM_ENTRY_KINDS).toEqual(["REGULARIZATION", "CLOSING", "OPENING", "REVERSAL"])
  })

  it("los ZIP de backup y nuestras facturas no son cuota del cliente (O-12c)", () => {
    expect(BILLABLE_STORAGE_KINDS).toEqual(["DOCUMENT", "PREVIEW", "LOGO", "AVATAR"])
    expect(BILLABLE_STORAGE_KINDS).not.toContain("BACKUP")
    expect(BILLABLE_STORAGE_KINDS).not.toContain("PLATFORM_INVOICE")
  })

  it("sólo el backup MANUAL consume cuota (O-4)", () => {
    expect(BILLABLE_BACKUP_TRIGGERS).toEqual(["MANUAL"])
  })
})
