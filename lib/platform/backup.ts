/**
 * E11 · T10 — **el formato de backup 2.0**, en funciones puras
 * (§3.6, §5.2, §5.4; ADR-0019 **D2**; observaciones **O-1**, **O-2**).
 *
 * ## Por qué se reescribió entero (G-15)
 *
 * El backup heredado cubría **9 tablas de las 66**, ninguna contable;
 * `modelFromJSON` capturaba el error por fila, lo mandaba a `console.error` **y
 * sumaba igual a `insertedCount`**; `preprocessRowData` **adivinaba tipos**
 * (`!isNaN(Number(value))` convertía la cuenta `0400` en `400`);
 * `REMOVE_EXISTING_DATA = true` **borraba la organización de destino antes** de
 * leer si el archivo servía; y no había manifest, ni hashes, ni firma, ni
 * verificación. No quedaba nada que conservar.
 *
 * ## Las tres decisiones que sostienen el formato
 *
 * 1. **El inventario se DERIVA de `TENANT_MODELS`** (`backupInventory`). Es la
 *    decisión que impide repetir por cuarta vez el mismo fallo (BUG-E7-1,
 *    BUG-E9-5, BUG-E10-1: el `--reset-org` que no conocía las tablas nuevas de la
 *    épica). **I-E11-7** falla si `TENANT_MODELS ⊄ inventario`.
 * 2. **La lista de columnas-sello también se deriva del código**
 *    (`derivedSealColumns`), del mismo modelo de datos del cliente Prisma. Es la
 *    parte que más fácil se olvida (O-1.3).
 * 3. **JSONL con tipos EXPLÍCITOS.** 500 000 líneas no caben en memoria en una
 *    función serverless, y nada de adivinar: `{"v":"0400","t":"s"}` es la cuenta
 *    `0400`, no el número 400.
 *
 * Módulo **PURO**: sin IO, sin `prisma`, sin `Date.now()`. El modelo de datos
 * entra **por parámetro** (`prismaSchemaMeta()` de `lib/db.ts`), precisamente
 * para que este fichero no importe el cliente.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto"

export const BACKUP_FORMAT_VERSION = "2.0" as const

const sha256hex = (input: string | Buffer): string => createHash("sha256").update(input).digest("hex")

// ─────────────────────────────────────────────────────────────────────────────
// 1. Inventario y columnas-sello, derivados del código
// ─────────────────────────────────────────────────────────────────────────────

export type SchemaColumn = { field: string; column: string; type: string; kind: string }
export type SchemaModel = { model: string; table: string; columns: SchemaColumn[] }

/**
 * Las tablas que el ZIP tiene que llevar, **derivadas de `TENANT_MODELS`**.
 * Nunca escritas a mano. El resultado va ordenado alfabéticamente: el orden de
 * inserción lo decide la restauración leyendo las FK reales de la base, no una
 * lista que alguien tenga que mantener.
 */
export function backupInventory(tenantModels: ReadonlySet<string>, meta: readonly SchemaModel[]): string[] {
  const byModel = new Map(meta.map((entry) => [entry.model, entry] as const))
  const missing = [...tenantModels].filter((model) => !byModel.has(model))
  if (missing.length > 0) {
    throw new Error(`backupInventory: modelos de TENANT_MODELS ausentes del esquema: ${missing.join(", ")}`)
  }
  return [...tenantModels].map((model) => byModel.get(model)!.table).sort()
}

/**
 * **O-1.3** — toda columna-sello del esquema, derivada del modelo de datos.
 *
 * El criterio es el que sigue el propio proyecto al nombrar: una columna de
 * texto cuyo nombre termina en `_hash`, `_sha`, `_sha256` o que se llama
 * `sha256` **es un sello**. `hash_version` no lo es (es un número de versión) y
 * se excluye explícitamente; `git_sha` **sí** entra: es la procedencia del
 * cálculo, y un destino que reproduce las cifras con otro `gitSha` es
 * exactamente la discrepancia que hay que enseñar.
 *
 * Que el criterio sea sintáctico no es una debilidad: es lo que hace que una
 * columna-sello nueva de la épica 68 aparezca aquí sin que nadie se acuerde.
 */
/**
 * **No toda columna que acaba en `_hash` es un sello.**
 *
 * `invitations.token_hash` es el hash de un **secreto de acceso**, no una huella
 * derivada del contenido: no se puede recomputar desde los datos y **no debe
 * viajar igual a la copia** —el mismo enlace de invitación abriría dos
 * organizaciones distintas—. La restauración lo reemite (ver
 * `reissueGlobalSecrets` en `models/backups.ts`), así que compararlo byte a byte
 * contra el origen daría `FAIL` sobre un comportamiento **correcto y deliberado**,
 * que es la peor clase de invariante: el que castiga hacer lo que hay que hacer.
 *
 * Lista cerrada y explícita, como `hash_version`: cualquier columna-sello nueva
 * entra sola en la comprobación, que es lo que O-1.3 pide.
 */
const NO_SON_SELLOS: ReadonlySet<string> = new Set(["invitations.token_hash"])

export function derivedSealColumns(meta: readonly SchemaModel[]): Array<{ table: string; column: string }> {
  const out: Array<{ table: string; column: string }> = []
  for (const model of meta) {
    for (const column of model.columns) {
      if (column.type !== "String") continue
      if (column.column === "hash_version") continue
      if (NO_SON_SELLOS.has(`${model.table}.${column.column}`)) continue
      if (!/(^|_)(sha256|sha|hash)$/.test(column.column)) continue
      out.push({ table: model.table, column: column.column })
    }
  }
  return out.sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0) || (a.column < b.column ? -1 : 1))
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. JSONL con tipos explícitos
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Valor tipado. `t` es la etiqueta: `s` texto · `n` número · `i` entero grande ·
 * `b` booleano · `d` fecha ISO · `j` JSON · `z` nulo · `y` bytes (base64).
 *
 * **Nada se adivina.** El bug que esto cierra es concreto: `preprocessRowData`
 * hacía `!isNaN(Number(value))` y la cuenta `0400` volvía como `400`.
 */
export type TypedValue = { v: string | number | boolean | unknown | null; t: "s" | "n" | "i" | "b" | "d" | "j" | "z" | "y" }

export function encodeValue(value: unknown): TypedValue {
  if (value === null || value === undefined) return { v: null, t: "z" }
  if (typeof value === "string") return { v: value, t: "s" }
  if (typeof value === "boolean") return { v: value, t: "b" }
  if (typeof value === "bigint") return { v: value.toString(), t: "i" }
  if (typeof value === "number") return { v: value, t: "n" }
  if (value instanceof Date) return { v: value.toISOString(), t: "d" }
  if (Buffer.isBuffer(value)) return { v: value.toString("base64"), t: "y" }
  return { v: value, t: "j" }
}

export function decodeValue(typed: TypedValue): unknown {
  switch (typed.t) {
    case "z":
      return null
    case "s":
      return typed.v as string
    case "b":
      return typed.v as boolean
    case "n":
      return typed.v as number
    case "i":
      return BigInt(typed.v as string)
    case "d":
      return new Date(typed.v as string)
    case "y":
      return Buffer.from(typed.v as string, "base64")
    case "j":
      return typed.v
    default:
      throw new BackupFormatError(`etiqueta de tipo desconocida: ${JSON.stringify(typed)}`)
  }
}

export class BackupFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BackupFormatError"
  }
}

/**
 * Una fila → una línea. Las claves van **ordenadas**: sin orden estable el
 * `sha256` del fichero cambiaría entre dos volcados del mismo contenido y la
 * comprobación 1 de §5.4 sería inútil.
 */
export function encodeRow(row: Record<string, unknown>): string {
  const encoded: Record<string, TypedValue> = {}
  for (const key of Object.keys(row).sort()) encoded[key] = encodeValue(row[key])
  return JSON.stringify(encoded)
}

export function decodeRow(line: string): Record<string, unknown> {
  let parsed: Record<string, TypedValue>
  try {
    parsed = JSON.parse(line) as Record<string, TypedValue>
  } catch {
    throw new BackupFormatError(`línea JSONL ilegible: ${line.slice(0, 120)}`)
  }
  const out: Record<string, unknown> = {}
  for (const [key, typed] of Object.entries(parsed)) out[key] = decodeValue(typed)
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Manifest, sha y firma
// ─────────────────────────────────────────────────────────────────────────────

export type NumberingEntry = {
  fiscalYearId: string
  fiscalYearCode: string
  maxEntryNumber: number
  count: number
  gaps: number[]
  duplicates: number[]
}

export type BackupManifest = {
  formatVersion: typeof BACKUP_FORMAT_VERSION
  schemaVersion: string
  gitSha: string
  organization: { id: string; slug: string; baseCurrency: string; timezone: string; pgcVariant: string }
  createdAt: string
  seals: { ledgerHash: string; analyticsKey: string; budgetHash: string | null }
  /** **O-1.2** — numeración, que los tres hashes NO cubren. */
  numbering: NumberingEntry[]
  invoiceSeries: Array<{ code: string; kind: string; lastNumber: number }>
  /** **O-1.3** — TODOS los sellos derivados, sobre una lista DERIVADA DEL CÓDIGO. */
  derivedSeals: Array<{ table: string; column: string; rows: number; sha256: string }>
  /** **O-1.4** */
  auditLog: { rows: number; canonicalSha256: string }
  tables: Array<{ name: string; rows: number; jsonl: string; sha256: string }>
  /**
   * **O-1.5** — tabla GLOBAL, no está en `TENANT_MODELS`: sin esto el destino no
   * reproduce `convertedTotal` (I-E8-5). Sólo las tasas REFERENCIADAS.
   */
  globalRefs: { exchangeRates: { rows: number; sha256: string } }
  files: Array<{ path: string; sha256: string; sizeBytes: number }>
  /** Estado del cierre: la comprobación 5 no se sostiene sin él. */
  closing: { fiscalYears: Array<{ code: string; status: string; closedAt: string | null }>; closingRuns: number }
  totals: { tables: number; rows: number; files: number; bytes: number }
}

/**
 * Forma canónica del manifest. **No es `JSON.stringify(m)`**: el orden de las
 * claves de un objeto no está garantizado entre versiones de Node y un sello que
 * depende de eso no es un sello. Se serializa con las claves ordenadas, en
 * profundidad.
 */
export function canonicalManifestForm(manifest: BackupManifest): string {
  return stableStringify(manifest)
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
  return `{${entries.join(",")}}`
}

export function manifestSha256(manifest: BackupManifest): string {
  return sha256hex(canonicalManifestForm(manifest))
}

/**
 * Firma del sha del manifest: `HMAC-SHA256` con la clave de plataforma, y el
 * `keyId` **delante**. Sin `keyId` una rotación de clave dejaría ilegibles todos
 * los backups anteriores, que es tanto como perderlos.
 */
export function signManifest(sha: string, key: Buffer, keyId: string): string {
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(keyId)) throw new BackupFormatError(`keyId no admisible: ${keyId}`)
  return `${keyId}:${createHmac("sha256", key).update(sha).digest("hex")}`
}

export type VerifyResult =
  | { ok: true; keyId: string }
  | { ok: false; reason: "FORMATO_NO_SOPORTADO" | "SHA_DISCORDANTE" | "FIRMA_INVALIDA" | "CLAVE_DESCONOCIDA"; detail: string }

/**
 * **Se verifica ANTES de descomprimir un byte** (§5.4.2). Orden deliberado:
 * versión de formato → sha del manifest → clave → firma. Comparación en tiempo
 * constante: una firma no se compara con `===`.
 */
export function verifyManifest(
  manifest: BackupManifest,
  declaredSha: string,
  signature: string,
  keys: ReadonlyMap<string, Buffer>
): VerifyResult {
  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
    return { ok: false, reason: "FORMATO_NO_SOPORTADO", detail: `formatVersion = ${manifest.formatVersion}` }
  }
  const recomputed = manifestSha256(manifest)
  if (recomputed !== declaredSha) {
    return { ok: false, reason: "SHA_DISCORDANTE", detail: `recomputado ${recomputed}, declarado ${declaredSha}` }
  }
  const [keyId, hex] = signature.split(":")
  const key = keyId ? keys.get(keyId) : undefined
  if (!key) return { ok: false, reason: "CLAVE_DESCONOCIDA", detail: `keyId = ${keyId ?? "∅"}` }
  const expected = Buffer.from(createHmac("sha256", key).update(declaredSha).digest("hex"), "utf8")
  const given = Buffer.from(hex ?? "", "utf8")
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: "FIRMA_INVALIDA", detail: "el HMAC no corresponde al sha declarado" }
  }
  return { ok: true, keyId }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Numeración (comprobación 2 de §5.4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Huecos y duplicados de una numeración correlativa. Es la comprobación que los
 * tres hashes **no** hacen: si la forma canónica del `ledgerHash` ordena por
 * fecha/cuenta/importe, **dos asientos con los números intercambiados dan el
 * mismo hash** — y un auditor mira la numeración antes que nada (art. 28.2 CCom).
 */
export function numberingOf(numbers: readonly number[]): { max: number; count: number; gaps: number[]; duplicates: number[] } {
  const sorted = [...numbers].sort((a, b) => a - b)
  const duplicates: number[] = []
  const gaps: number[] = []
  const seen = new Set<number>()
  for (const n of sorted) {
    if (seen.has(n)) duplicates.push(n)
    seen.add(n)
  }
  const max = sorted.length === 0 ? 0 : sorted[sorted.length - 1]
  for (let n = 1; n <= max; n += 1) if (!seen.has(n)) gaps.push(n)
  return { max, count: sorted.length, gaps, duplicates: [...new Set(duplicates)] }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. El documento de verificación: las SEIS comprobaciones (O-1, O-2)
// ─────────────────────────────────────────────────────────────────────────────

export type CheckId =
  | "RECUENTOS"
  | "NUMERACION"
  | "SELLOS_DERIVADOS"
  | "AUDIT_LOG"
  | "SELLOS_Y_CIERRE"
  | "BARRIDO_INVARIANTES"

export type CheckResult = {
  id: CheckId
  /** `PASS` | `FAIL` | `INFO`. **Nunca un PASS que no se haya comprobado**: lo
   *  no evaluable sale `INFO` diciendo qué falta (§11). */
  status: "PASS" | "FAIL" | "INFO"
  title: string
  /** Lo enfrentado, origen contra destino. Es lo que ve el operador. */
  evidence: Array<{ label: string; expected: string; actual: string; ok: boolean }>
  note?: string
}

export type RestoreVerification = {
  formatVersion: typeof BACKUP_FORMAT_VERSION
  backupJobId: string | null
  sourceOrganizationId: string
  targetOrganizationId: string
  verifiedAt: string
  checks: CheckResult[]
  /** `true` sólo con las SEIS en verde. Si no ⇒ `DONE_UNVERIFIED` (O-2). */
  verified: boolean
}

/** Las seis, en orden. Declarada para que nadie entregue cinco. */
export const REQUIRED_CHECKS: readonly CheckId[] = [
  "RECUENTOS",
  "NUMERACION",
  "SELLOS_DERIVADOS",
  "AUDIT_LOG",
  "SELLOS_Y_CIERRE",
  "BARRIDO_INVARIANTES",
]

/**
 * **`verified` sólo con las seis en verde** (§5.4.8). Un `INFO` **no** es verde:
 * «no se pudo comprobar» no acredita nada, y la lección de H-1 de E9 y H-1 de
 * E10 —dos veces— es que lo que no se comprueba se acaba dando por bueno.
 */
export function isVerified(checks: readonly CheckResult[]): boolean {
  const byId = new Map(checks.map((check) => [check.id, check] as const))
  return REQUIRED_CHECKS.every((id) => byId.get(id)?.status === "PASS")
}

/** `DONE` ⇔ verificado (O-2). No hay tercera lectura posible. */
export function restoreStatusOf(checks: readonly CheckResult[]): "DONE" | "DONE_UNVERIFIED" {
  return isVerified(checks) ? "DONE" : "DONE_UNVERIFIED"
}

/**
 * Compara dos mapas de recuentos con `=`, **no con `⊇`** (§5.4, comprobación 1).
 * Una tabla de más en el destino es tan sospechosa como una de menos.
 */
export function compareCounts(
  expected: ReadonlyMap<string, number>,
  actual: ReadonlyMap<string, number>
): CheckResult {
  const tables = [...new Set([...expected.keys(), ...actual.keys()])].sort()
  const evidence = tables.map((table) => {
    const a = expected.get(table)
    const b = actual.get(table)
    return {
      label: table,
      expected: a === undefined ? "ausente en el manifest" : String(a),
      actual: b === undefined ? "ausente en el destino" : String(b),
      ok: a !== undefined && a === b,
    }
  })
  return {
    id: "RECUENTOS",
    status: evidence.every((row) => row.ok) ? "PASS" : "FAIL",
    title: "Recuentos tabla a tabla contra el manifest, con igualdad exacta",
    evidence,
  }
}

/** sha256 de una columna-sello: sus valores, ordenados, uno por línea. */
export function sealColumnSha256(values: readonly (string | null)[]): string {
  return sha256hex([...values].map((value) => value ?? "∅").sort().join("\n"))
}

/** Forma canónica del `AuditLog` (comprobación 4). Sin esto se pierde quién forzó qué. */
export function auditLogCanonicalSha256(
  rows: readonly { entity: string; entityId: string; action: string; reason: string | null; ts: Date }[]
): string {
  const lines = rows
    .map((row) => [row.ts.toISOString(), row.entity, row.entityId, row.action, row.reason ?? "∅"].join("\t"))
    .sort()
  return sha256hex(lines.join("\n"))
}
