/**
 * E11 · T6 — **la clave del objeto, determinista y pura**
 * (docs/design/E11-plataforma-saas.md §4, ADR-0019 D3).
 *
 * `<prefijo>/<organizationId>/<kind>/<sha256[0:2]>/<sha256>`
 *
 * Por qué así, y no de otra manera:
 *
 * - **Por `sha256`, no por uuid**: el mismo PDF subido dos veces ocupa un solo
 *   objeto, y la correspondencia `File.sha256 ↔ bytes` que exige I-E8-2 es
 *   verificable con sólo mirar la clave. Un nombre de fichero del cliente jamás
 *   entra en la clave: llevaría acentos, espacios, `..` y datos personales.
 * - **Prefijo por organización, un bucket por entorno** (P-3): el aislamiento lo
 *   da la política, no un recurso de infraestructura creado dentro de la
 *   transacción de alta.
 * - **Dos niveles de abanico** (`sha[0:2]`): 256 «carpetas» por tipo, que es lo
 *   que mantiene manejable el `ls` de un bucket local y el listado paginado de
 *   S3 sin inventar un índice aparte.
 * - **`kind` en la clave y, aun así, la cuota filtra por `kind` de la fila, no
 *   por prefijo** (O-12c). La clave es para operar; la cifra sale de la columna.
 *
 * Puro: sin IO, sin reloj, sin `prisma`.
 */

import type { StoredObjectKind } from "@/prisma/client"

/** Prefijo por defecto cuando `STORAGE_PREFIX` no está definido. */
export const DEFAULT_STORAGE_PREFIX = "erp"

const SHA256_RE = /^[0-9a-f]{64}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class StorageKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StorageKeyError"
  }
}

/** Normaliza el prefijo configurado: sin barras al principio ni al final. */
export function normalizePrefix(raw: string | undefined | null): string {
  const value = (raw ?? DEFAULT_STORAGE_PREFIX).trim().replace(/^\/+|\/+$/g, "")
  if (value === "") return DEFAULT_STORAGE_PREFIX
  if (!/^[A-Za-z0-9._\-/]+$/.test(value) || value.includes("..")) {
    throw new StorageKeyError(`STORAGE_PREFIX no admisible: ${raw}`)
  }
  return value
}

export type ObjectKeyInput = {
  prefix?: string
  organizationId: string
  kind: StoredObjectKind
  sha256: string
}

/**
 * Clave canónica del objeto. Valida los tres componentes variables: una clave
 * mal formada es la puerta por la que un objeto acaba fuera del prefijo de su
 * organización, que es la única frontera que tiene el almacén.
 */
export function objectKey({ prefix, organizationId, kind, sha256 }: ObjectKeyInput): string {
  if (!UUID_RE.test(organizationId)) {
    throw new StorageKeyError(`objectKey: organizationId no es un uuid válido (${organizationId})`)
  }
  if (!SHA256_RE.test(sha256)) {
    throw new StorageKeyError(`objectKey: sha256 debe ser 64 hex en minúscula (${sha256})`)
  }
  return `${normalizePrefix(prefix)}/${organizationId.toLowerCase()}/${kind}/${sha256.slice(0, 2)}/${sha256}`
}

/** Prefijo de TODOS los objetos de una organización. Lo usa el barrido. */
export function organizationPrefix(organizationId: string, prefix?: string): string {
  if (!UUID_RE.test(organizationId)) {
    throw new StorageKeyError(`organizationPrefix: organizationId no es un uuid válido (${organizationId})`)
  }
  return `${normalizePrefix(prefix)}/${organizationId.toLowerCase()}/`
}

/** Prefijo de una familia dentro de una organización. */
export function kindPrefix(organizationId: string, kind: StoredObjectKind, prefix?: string): string {
  return `${organizationPrefix(organizationId, prefix)}${kind}/`
}

/**
 * Lectura inversa de una clave. Devuelve `null` si no responde a la forma
 * canónica: el barrido tiene que poder distinguir un objeto ajeno de uno propio
 * sin lanzar.
 */
export function parseObjectKey(
  key: string
): { prefix: string; organizationId: string; kind: string; sha256: string } | null {
  const parts = key.split("/")
  if (parts.length < 5) return null
  const sha256 = parts[parts.length - 1]
  const fanout = parts[parts.length - 2]
  const kind = parts[parts.length - 3]
  const organizationId = parts[parts.length - 4]
  const prefix = parts.slice(0, parts.length - 4).join("/")
  if (!SHA256_RE.test(sha256)) return null
  if (fanout !== sha256.slice(0, 2)) return null
  if (!UUID_RE.test(organizationId)) return null
  if (prefix === "") return null
  return { prefix, organizationId, kind, sha256 }
}

/**
 * **La comprobación que impide la fuga entre organizaciones.** Toda lectura y
 * toda escritura del driver pasa por aquí antes de tocar el almacén: una clave
 * que no cuelgue del prefijo de SU organización no es un fallo de permisos que
 * alguien mirará mañana, es una excepción hoy.
 */
export function assertKeyBelongsTo(key: string, organizationId: string, prefix?: string): void {
  const expected = organizationPrefix(organizationId, prefix)
  if (!key.startsWith(expected)) {
    throw new StorageKeyError(`la clave ${key} no pertenece al prefijo de la organización ${organizationId}`)
  }
}
