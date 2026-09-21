import { describe, expect, it } from "vitest"
import {
  BACKUP_FORMAT_VERSION,
  BackupFormatError,
  auditLogCanonicalSha256,
  backupInventory,
  canonicalManifestForm,
  compareCounts,
  compareInventoryCoverage,
  decodeRow,
  derivedSealColumns,
  encodeRow,
  isVerified,
  manifestSha256,
  numberingOf,
  restoreStatusOf,
  sealColumnSha256,
  signManifest,
  verifyManifest,
  type BackupManifest,
  type CheckResult,
  type SchemaModel,
} from "./backup"

const META: SchemaModel[] = [
  {
    model: "JournalEntry",
    table: "journal_entries",
    columns: [
      { field: "id", column: "id", type: "String", kind: "scalar" },
      { field: "entryHash", column: "entry_hash", type: "String", kind: "scalar" },
      { field: "hashVersion", column: "hash_version", type: "Int", kind: "scalar" },
    ],
  },
  {
    model: "File",
    table: "files",
    columns: [
      { field: "id", column: "id", type: "String", kind: "scalar" },
      { field: "sha256", column: "sha256", type: "String", kind: "scalar" },
    ],
  },
  {
    model: "ExtractionRun",
    table: "extraction_runs",
    columns: [
      { field: "promptSha", column: "prompt_sha", type: "String", kind: "scalar" },
      { field: "gitSha", column: "git_sha", type: "String", kind: "scalar" },
      { field: "durationMs", column: "duration_ms", type: "Int", kind: "scalar" },
    ],
  },
]

describe("backupInventory — DERIVADO de TENANT_MODELS (I-E11-7)", () => {
  it("traduce cada modelo a su tabla y devuelve el orden estable", () => {
    expect(backupInventory(new Set(["File", "JournalEntry"]), META)).toEqual(["files", "journal_entries"])
  })

  it("LANZA si un modelo de TENANT_MODELS no está en el esquema: es el fallo de BUG-E7-1", () => {
    expect(() => backupInventory(new Set(["Inexistente"]), META)).toThrow(/ausentes del esquema/)
  })

  it("el caso vacío devuelve lista vacía, no un error", () => {
    expect(backupInventory(new Set(), META)).toEqual([])
  })
})

describe("derivedSealColumns — O-1.3, derivadas del código y no escritas a mano", () => {
  it("recoge `*_hash`, `*_sha` y `sha256`", () => {
    const columns = derivedSealColumns(META)
    expect(columns).toContainEqual({ table: "journal_entries", column: "entry_hash" })
    expect(columns).toContainEqual({ table: "files", column: "sha256" })
    expect(columns).toContainEqual({ table: "extraction_runs", column: "prompt_sha" })
  })

  it("excluye `hash_version`, que es un número de versión y no un sello", () => {
    expect(derivedSealColumns(META)).not.toContainEqual({ table: "journal_entries", column: "hash_version" })
  })

  it("no recoge columnas que no sean de texto", () => {
    expect(derivedSealColumns(META).some((entry) => entry.column === "duration_ms")).toBe(false)
  })
})

describe("JSONL con tipos explícitos", () => {
  it("**la cuenta `0400` vuelve como `0400`**, no como el número 400 (bug de `preprocessRowData`)", () => {
    const row = { account_code: "0400" }
    expect(decodeRow(encodeRow(row))).toEqual(row)
  })

  it("preserva el tipo de cada valor: nulo, booleano, entero grande, fecha y JSON", () => {
    const row = {
      nada: null,
      si: true,
      grande: BigInt("9007199254740993"),
      cuando: new Date("2026-09-15T10:00:00.000Z"),
      json: { a: [1, "dos"] },
      cero: 0,
    }
    const back = decodeRow(encodeRow(row))
    expect(back.nada).toBeNull()
    expect(back.si).toBe(true)
    expect(back.grande).toBe(BigInt("9007199254740993"))
    expect((back.cuando as Date).toISOString()).toBe("2026-09-15T10:00:00.000Z")
    expect(back.json).toEqual({ a: [1, "dos"] })
    expect(back.cero).toBe(0)
  })

  it("ordena las claves: sin eso el sha256 del fichero cambiaría entre dos volcados iguales", () => {
    expect(encodeRow({ b: 1, a: 2 })).toBe(encodeRow({ a: 2, b: 1 }))
  })

  it("una línea ilegible se rechaza con motivo, no se salta", () => {
    expect(() => decodeRow("{no es json")).toThrow(BackupFormatError)
  })
})

const manifest = (): BackupManifest => ({
  formatVersion: BACKUP_FORMAT_VERSION,
  schemaVersion: "20260927090000",
  gitSha: "abc123",
  organization: { id: "org", slug: "acme", baseCurrency: "EUR", timezone: "Europe/Madrid", pgcVariant: "PYMES" },
  createdAt: "2026-09-15T10:00:00.000Z",
  seals: { ledgerHash: "a".repeat(64), analyticsKey: "b".repeat(64), budgetHash: null },
  numbering: [],
  invoiceSeries: [],
  derivedSeals: [],
  auditLog: { rows: 0, canonicalSha256: "c".repeat(64) },
  tables: [],
  globalRefs: { exchangeRates: { rows: 0, sha256: "d".repeat(64) } },
  files: [],
  closing: { fiscalYears: [], closingRuns: 0 },
  totals: { tables: 0, rows: 0, files: 0, bytes: 0 },
})

describe("manifest, sha y firma", () => {
  const key = Buffer.from("clave-de-prueba")
  const keys = new Map([["k1", key]])

  it("la forma canónica ordena las claves en profundidad: no depende del orden del objeto", () => {
    const a = canonicalManifestForm(manifest())
    const reordenado = { ...manifest() }
    const b = canonicalManifestForm({ ...reordenado, totals: { ...reordenado.totals } })
    expect(a).toBe(b)
  })

  it("una firma correcta se verifica", () => {
    const m = manifest()
    const sha = manifestSha256(m)
    expect(verifyManifest(m, sha, signManifest(sha, key, "k1"), keys)).toEqual({ ok: true, keyId: "k1" })
  })

  it("**ZIP manipulado**: cambiar una cifra del manifest lo delata por el sha", () => {
    const m = manifest()
    const sha = manifestSha256(m)
    const firma = signManifest(sha, key, "k1")
    const alterado = { ...m, totals: { ...m.totals, rows: 99 } }
    const verdict = verifyManifest(alterado, sha, firma, keys)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe("SHA_DISCORDANTE")
  })

  it("**firma inválida**: recalcular el sha del manifest alterado tampoco cuela sin la clave", () => {
    const alterado = { ...manifest(), totals: { tables: 1, rows: 1, files: 1, bytes: 1 } }
    const shaFalso = manifestSha256(alterado)
    const verdict = verifyManifest(alterado, shaFalso, signManifest(shaFalso, Buffer.from("otra clave"), "k1"), keys)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe("FIRMA_INVALIDA")
  })

  it("una clave desconocida no se da por buena", () => {
    const m = manifest()
    const sha = manifestSha256(m)
    const verdict = verifyManifest(m, sha, signManifest(sha, key, "k9"), keys)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe("CLAVE_DESCONOCIDA")
  })

  it("un formato que no es 2.0 se rechaza ANTES de mirar nada más", () => {
    const viejo = { ...manifest(), formatVersion: "1.0" } as unknown as BackupManifest
    const verdict = verifyManifest(viejo, "x", "k1:y", keys)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe("FORMATO_NO_SOPORTADO")
  })

  it("el `keyId` viaja delante: sin él, rotar la clave dejaría ilegibles los backups anteriores", () => {
    expect(signManifest("a".repeat(64), key, "k1").startsWith("k1:")).toBe(true)
  })
})

describe("numberingOf — O-1.2, lo que los tres hashes NO cubren", () => {
  it("el caso vacío no inventa un máximo", () => {
    expect(numberingOf([])).toEqual({ max: 0, count: 0, gaps: [], duplicates: [] })
  })

  it("una numeración contigua no tiene huecos", () => {
    expect(numberingOf([1, 2, 3])).toEqual({ max: 3, count: 3, gaps: [], duplicates: [] })
  })

  it("detecta el hueco del art. 28.2 CCom", () => {
    expect(numberingOf([1, 2, 4]).gaps).toEqual([3])
  })

  it("detecta el duplicado", () => {
    expect(numberingOf([1, 2, 2, 3]).duplicates).toEqual([2])
  })

  it("**los números intercambiados** no cambian el conjunto: por eso hace falta el recuento por ejercicio", () => {
    expect(numberingOf([2, 1, 3])).toEqual(numberingOf([1, 2, 3]))
  })
})

describe("compareCounts — igualdad exacta, no `⊇`", () => {
  it("iguales, PASS", () => {
    const result = compareCounts(new Map([["files", 3]]), new Map([["files", 3]]))
    expect(result.status).toBe("PASS")
  })

  it("una fila DE MÁS en el destino es tan sospechosa como una de menos", () => {
    expect(compareCounts(new Map([["files", 3]]), new Map([["files", 4]])).status).toBe("FAIL")
  })

  it("una tabla que falta en el destino sale con su motivo", () => {
    const result = compareCounts(new Map([["files", 3]]), new Map())
    expect(result.status).toBe("FAIL")
    expect(result.evidence[0].actual).toContain("ausente en el destino")
  })
})

describe("sellos derivados y AuditLog", () => {
  it("el sello de columna no depende del orden de las filas", () => {
    expect(sealColumnSha256(["b", "a"])).toBe(sealColumnSha256(["a", "b"]))
  })

  it("un nulo no es lo mismo que la cadena vacía", () => {
    expect(sealColumnSha256([null])).not.toBe(sealColumnSha256([""]))
  })

  it("el sha del AuditLog cambia si desaparece el MOTIVO de un forzado", () => {
    const rows = [
      { entity: "JournalEntry", entityId: "1", action: "FORCE_DUPLICATE", reason: "el proveedor lo reenvió", ts: new Date("2026-01-01") },
    ]
    const mermado = [{ ...rows[0], reason: null }]
    expect(auditLogCanonicalSha256(rows)).not.toBe(auditLogCanonicalSha256(mermado))
  })
})

describe("O-2 — `DONE` queda reservado a las SEIS en verde", () => {
  const check = (id: CheckResult["id"], status: CheckResult["status"]): CheckResult => ({
    id,
    status,
    title: id,
    evidence: [],
  })
  const seis = (status: CheckResult["status"]): CheckResult[] => [
    check("RECUENTOS", status),
    check("NUMERACION", status),
    check("SELLOS_DERIVADOS", status),
    check("AUDIT_LOG", status),
    check("SELLOS_Y_CIERRE", status),
    check("BARRIDO_INVARIANTES", status),
  ]

  it("las seis en PASS ⇒ DONE", () => {
    expect(isVerified(seis("PASS"))).toBe(true)
    expect(restoreStatusOf(seis("PASS"))).toBe("DONE")
  })

  it("cinco en verde y una en FAIL ⇒ DONE_UNVERIFIED, nunca DONE", () => {
    const checks = seis("PASS")
    checks[3] = check("AUDIT_LOG", "FAIL")
    expect(restoreStatusOf(checks)).toBe("DONE_UNVERIFIED")
  })

  it("un `INFO` NO es verde: «no se pudo comprobar» no acredita nada", () => {
    const checks = seis("PASS")
    checks[5] = check("BARRIDO_INVARIANTES", "INFO")
    expect(isVerified(checks)).toBe(false)
  })

  it("entregar CINCO comprobaciones no basta: falta una y no se verifica", () => {
    expect(isVerified(seis("PASS").slice(0, 5))).toBe(false)
  })
})

describe("compareInventoryCoverage — el manifest declara lo que el inventario exige (H-6)", () => {
  const inventario = ["accounts", "currencies", "files", "journal_entries"]

  it("PASS cuando el manifest trae exactamente las tablas del inventario", () => {
    const r = compareInventoryCoverage(inventario, [...inventario].reverse())
    expect(r.status).toBe("PASS")
    expect(r.id).toBe("COBERTURA_INVENTARIO")
  })

  it("FAIL NOMBRANDO la tabla que falta: es el caso de H-2 de E11 al restaurar", () => {
    const r = compareInventoryCoverage(inventario, ["accounts", "files", "journal_entries"])
    expect(r.status).toBe("FAIL")
    expect(r.evidence.some((fila) => fila.label.includes("«currencies» falta en el manifest"))).toBe(true)
  })

  it("FAIL también si el manifest declara una tabla que el inventario no conoce", () => {
    const r = compareInventoryCoverage(inventario, [...inventario, "tabla_inventada"])
    expect(r.status).toBe("FAIL")
    expect(r.evidence.some((fila) => fila.label.includes("«tabla_inventada»"))).toBe(true)
  })
})
