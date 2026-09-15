/**
 * E11 · T6 (D-11, ADR-0019 **D3**) — **la interfaz única del almacén**.
 *
 * Hasta E11, `lib/files.ts:7` resolvía todo contra `FILE_UPLOAD_PATH`, que en
 * Vercel es `/tmp`: efímero entre despliegues y no compartido entre funciones.
 * El `sha256 NOT NULL` de E8 y el invariante I-E8-2 vigilaban unos bytes que el
 * despliegue siguiente no tenía. Aquí se corta esa dependencia: **la aplicación
 * no conoce Supabase, ni S3, ni el disco**.
 *
 * ## Las tres reglas de esta interfaz
 *
 * 1. **El `sha256` entra y se verifica.** `put()` recibe el sha de los bytes que
 *    el llamante dice estar guardando y **falla si los bytes no lo cumplen**: un
 *    almacén que acepta cualquier cosa bajo una clave derivada del hash
 *    convierte I-E8-2 e I-E11-6 en adorno. La comprobación se hace mientras se
 *    escribe, no releyendo después.
 * 2. **La clave es determinista y la fija `objectKey()`** (`lib/storage/keys.ts`):
 *    `<prefijo>/<organizationId>/<kind>/<sha[0:2]>/<sha>`. **Un bucket por
 *    entorno con prefijo por organización** (P-3), no un bucket por
 *    organización: crear un recurso de infraestructura dentro de la transacción
 *    de alta es exactamente lo que la siembra atómica no puede permitirse.
 * 3. **Ningún método adivina.** `head()` de un objeto ausente devuelve `null`,
 *    no lanza; `get()` de un objeto ausente **sí** lanza `StorageObjectNotFound`,
 *    porque leer lo que no está es un fallo de integridad, no un caso normal.
 *
 * Implementaciones: `LocalDriver` (desarrollo, self-hosted y **tests**, con el
 * comportamiento de hoy) y `S3Driver`. **Supabase Storage se consume por su
 * endpoint S3** (P-3), así que hay **un solo driver de red**, no dos.
 */

import type { Readable } from "node:stream"
import type { StorageBackend } from "@/prisma/client"

/** Metadatos obligatorios de una escritura. El `sha256` NO es opcional. */
export type PutMeta = {
  mimeType: string
  /** sha256 hexadecimal en minúscula de los bytes que se escriben. Se verifica. */
  sha256: string
}

export type PutResult = { sizeBytes: bigint; sha256: string }

export type HeadResult = { sizeBytes: bigint; sha256?: string }

export interface StorageDriver {
  readonly backend: StorageBackend
  put(key: string, body: Readable | Buffer, meta: PutMeta): Promise<PutResult>
  get(key: string): Promise<Readable>
  /** Buffer completo. Sólo para objetos pequeños: un ZIP de 2 GB va por `get()`. */
  getBuffer(key: string): Promise<Buffer>
  head(key: string): Promise<HeadResult | null>
  delete(key: string): Promise<void>
  /** Claves existentes bajo un prefijo, en orden lexicográfico. */
  list(prefix: string): Promise<string[]>
  /** URL firmada de corta vida: un ZIP de 2 GB no cabe en una respuesta. */
  signedUrl(key: string, ttlSeconds: number): Promise<string>
}

export class StorageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StorageError"
  }
}

export class StorageObjectNotFound extends StorageError {
  constructor(key: string) {
    super(`el objeto ${key} no está en el almacén`)
    this.name = "StorageObjectNotFound"
  }
}

/**
 * Los bytes escritos no cumplen el `sha256` declarado. Es un error de
 * integridad, no de red: se distingue para que el barrido y la migración
 * puedan informarlo por separado (§4, «sha discordante ⇒ no se sube»).
 */
export class StorageIntegrityError extends StorageError {
  constructor(
    readonly key: string,
    readonly expected: string,
    readonly actual: string
  ) {
    super(`integridad: ${key} declaraba sha256 ${expected} y los bytes dan ${actual}`)
    this.name = "StorageIntegrityError"
  }
}
