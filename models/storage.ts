/**
 * E11 · T6 — `StoredObject`: la localización de los bytes.
 *
 * Regla de oro: **primero el almacén, después la fila**. Se sube, se vuelve a
 * preguntar por el objeto (`head()`) y sólo entonces se escribe el
 * `StoredObject`. Al revés quedaría una fila que promete unos bytes que no
 * existen — que es exactamente el estado que I-E11-6 detecta y que nadie
 * debería poder crear.
 *
 * `files.sha256` **sigue siendo la verdad** (I-E8-2 no cambia de enunciado):
 * esto sólo dice de dónde se leen los bytes y cuánto ocupan.
 */

import type { Readable } from "node:stream"
import type { TenantClient, TenantTransactionClient } from "@/lib/db"
import { StorageError, objectKey, storage } from "@/lib/storage"
import { assertKeyBelongsTo } from "@/lib/storage/keys"
import type { Prisma, StoredObject, StoredObjectKind, StoredObjectPurpose } from "@/prisma/client"

type AnyTenantClient = TenantClient | TenantTransactionClient

/**
 * **Familias que consumen cuota del cliente** (O-12c). Los ZIP de backup y las
 * copias de NUESTRAS facturas viven en el mismo bucket y **no** son cuota suya:
 * el filtro es por `kind`, nunca por prefijo de clave.
 *
 * **E12 · T15.** `LOGO` y `AVATAR` salen de la lista: lo que era una imagen de
 * marca pasa a `BRANDING`, que **no** consume cuota (O-12c). Las dos familias
 * viejas se quedan en el enumerado como cicatriz —no se puede retirar un valor
 * sin reescribir el tipo— pero nadie las vuelve a escribir, y si quedara una
 * fila suya en alguna instalación sin migrar, tampoco debe cobrarse.
 */
export const BILLABLE_STORAGE_KINDS: readonly StoredObjectKind[] = ["DOCUMENT", "PREVIEW"]

export type PutObjectInput = {
  organizationId: string
  kind: StoredObjectKind
  /** Obligatorio en `BRANDING` y prohibido fuera: lo impone también un CHECK. */
  purpose?: StoredObjectPurpose | null
  sha256: string
  mimeType: string
  body: Buffer | Readable
}

/**
 * Sube y registra. **Idempotente por `(organizationId, objectKey)`**: la clave
 * se deriva del sha256, así que resubir el mismo contenido no duplica ni el
 * objeto ni la fila —y tampoco falla, que es lo que necesita un reintento de la
 * cola o una migración que se ejecuta dos veces.
 */
export async function putObject(db: AnyTenantClient, input: PutObjectInput): Promise<StoredObject> {
  const { driver, prefix } = storage()
  const key = objectKey({ prefix, organizationId: input.organizationId, kind: input.kind, sha256: input.sha256 })

  /**
   * **Revisor DEBE 6 — la segunda barrera del almacén, invocada de verdad.**
   *
   * `assertKeyBelongsTo` documentaba que «toda lectura y toda escritura del
   * driver pasa por aquí» y **no tenía un solo llamante de producción**: el
   * aislamiento lo daba únicamente la RLS sobre `stored_objects`, y CLAUDE.md
   * declara la RLS *segunda* barrera, no la única. Aquí se cumple la promesa.
   */
  assertKeyBelongsTo(key, input.organizationId, prefix)

  const existing = await db.storedObject.findFirst({ where: { objectKey: key } })
  if (existing) {
    // La fila está; falta comprobar que los bytes siguen ahí. Un `head()` es
    // barato y evita devolver como buena una localización vacía.
    const head = await driver.head(key)
    if (head) return existing
  }

  const { sizeBytes } = await driver.put(key, input.body, { mimeType: input.mimeType, sha256: input.sha256 })
  const head = await driver.head(key)
  if (!head) {
    throw new StorageError(`el almacén no devuelve el objeto recién escrito: ${key}`)
  }
  if (head.sizeBytes !== sizeBytes) {
    throw new StorageError(`el almacén devuelve ${head.sizeBytes} bytes y se escribieron ${sizeBytes}: ${key}`)
  }

  if (existing) return existing
  return await db.storedObject.create({
    data: {
      organizationId: input.organizationId,
      objectKey: key,
      backend: driver.backend,
      sha256: input.sha256,
      sizeBytes,
      mimeType: input.mimeType,
      kind: input.kind,
      purpose: input.purpose ?? null,
    } satisfies Prisma.StoredObjectUncheckedCreateInput,
  })
}

export type PutObjectStreamingInput = {
  organizationId: string
  kind: StoredObjectKind
  /**
   * **La dirección de contenido de la clave**, que aquí no puede ser el `sha256`
   * de los bytes: no se conoce hasta haber escrito el último, y conocerlo antes
   * exigiría materializar el archivo — la deuda que T14 cierra.
   *
   * Para el ZIP de un backup es el **`sha256` del manifest**, que sella tabla por
   * tabla, fichero por fichero y sello por sello todo lo que hay dentro: dos
   * archivos con el mismo manifest tienen el mismo contenido, que es exactamente
   * lo que una clave direccionable por contenido promete. El `sha256` de los
   * bytes se calcula al vuelo y es el que se guarda en la fila — el que I-E11-6
   * compara contra el almacén.
   */
  keySha256: string
  mimeType: string
  body: AsyncIterable<Buffer> | Readable
}

/**
 * **E12 · T14** — sube en streaming (multipart en S3) y registra.
 *
 * Misma regla de oro que `putObject`: **primero el almacén, después la fila**, y
 * un `head()` en medio para no registrar una localización vacía. La diferencia
 * es que aquí el cuerpo nunca existe entero en memoria.
 */
export async function putObjectStreaming(
  db: AnyTenantClient,
  input: PutObjectStreamingInput
): Promise<StoredObject> {
  const { driver, prefix } = storage()
  const key = objectKey({ prefix, organizationId: input.organizationId, kind: input.kind, sha256: input.keySha256 })
  assertKeyBelongsTo(key, input.organizationId, prefix)

  const { sizeBytes, sha256 } = await driver.putStreaming(key, input.body, { mimeType: input.mimeType })
  const head = await driver.head(key)
  if (!head) throw new StorageError(`el almacén no devuelve el objeto recién escrito: ${key}`)
  if (head.sizeBytes !== sizeBytes) {
    throw new StorageError(`el almacén devuelve ${head.sizeBytes} bytes y se escribieron ${sizeBytes}: ${key}`)
  }

  const existing = await db.storedObject.findFirst({ where: { objectKey: key } })
  if (existing) {
    // Reintento de la cola sobre el mismo manifest: el contenido es el mismo por
    // construcción, pero el `sha256` de los BYTES puede diferir si la versión de
    // `zlib` cambió entre intentos. Se actualiza la fila en vez de dejarla
    // mintiendo: es una localización, no un hecho contable.
    if (existing.sha256 === sha256 && existing.sizeBytes === sizeBytes) return existing
    return await db.storedObject.update({ where: { id: existing.id }, data: { sha256, sizeBytes, verifiedAt: null } })
  }

  return await db.storedObject.create({
    data: {
      organizationId: input.organizationId,
      objectKey: key,
      backend: driver.backend,
      sha256,
      sizeBytes,
      mimeType: input.mimeType,
      kind: input.kind,
    } satisfies Prisma.StoredObjectUncheckedCreateInput,
  })
}

export async function getObjectBuffer(db: AnyTenantClient, objectKeyValue: string): Promise<Buffer> {
  const row = await db.storedObject.findFirst({ where: { objectKey: objectKeyValue } })
  if (!row) throw new StorageError(`objeto no registrado en esta organización: ${objectKeyValue}`)
  // Segunda barrera (DEBE 6): la fila la ha filtrado la RLS, pero la CLAVE que
  // se le pasa al driver tiene que colgar del prefijo de esta organización.
  assertKeyBelongsTo(row.objectKey, row.organizationId, storage().prefix)
  return await storage().driver.getBuffer(row.objectKey)
}

export async function findObjectBySha256(
  db: AnyTenantClient,
  sha256: string,
  kind: StoredObjectKind
): Promise<StoredObject | null> {
  return await db.storedObject.findFirst({ where: { sha256, kind } })
}

/**
 * **La cifra de la cuota** (O-12c). Agregado en SQL y filtrado por `kind`:
 * jamás materializar filas para sumar un `bigint`.
 */
export async function storageBytesUsed(
  db: AnyTenantClient,
  kinds: readonly StoredObjectKind[] = BILLABLE_STORAGE_KINDS
): Promise<bigint> {
  const aggregate = await db.storedObject.aggregate({
    where: { kind: { in: [...kinds] } },
    _sum: { sizeBytes: true },
  })
  return aggregate._sum.sizeBytes ?? BigInt(0)
}

/** Sella `verifiedAt` tras un barrido con el sha256 correcto (I-E11-6). */
export async function markObjectVerified(db: AnyTenantClient, id: string, at: Date): Promise<void> {
  await db.storedObject.update({ where: { id }, data: { verifiedAt: at } })
}

/**
 * Comprueba un objeto contra el almacén: mismo tamaño y —si el backend lo
 * publica— mismo sha256. Nunca lanza: «no se puede leer» es justamente la
 * evidencia que el invariante tiene que enseñar (mismo criterio que
 * `sha256OfStoredFile`).
 */
export async function verifyObject(
  row: Pick<StoredObject, "objectKey" | "sha256" | "sizeBytes">
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const head = await storage().driver.head(row.objectKey)
    if (!head) return { ok: false, reason: "el objeto no está en el almacén" }
    if (head.sizeBytes !== row.sizeBytes) {
      return { ok: false, reason: `tamaño ${head.sizeBytes} frente a ${row.sizeBytes} registrado` }
    }
    if (head.sha256 && head.sha256 !== row.sha256) {
      return { ok: false, reason: `sha256 ${head.sha256} frente a ${row.sha256} registrado` }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "no se puede leer" }
  }
}

/** Retira el objeto del almacén y su localización. No borra `File` ni `AuditLog`. */
export async function deleteObject(db: AnyTenantClient, id: string): Promise<void> {
  const row = await db.storedObject.findFirst({ where: { id } })
  if (!row) return
  // Segunda barrera (DEBE 6): un borrado es la peor operación para fiarlo todo
  // a una sola comprobación.
  assertKeyBelongsTo(row.objectKey, row.organizationId, storage().prefix)
  await storage().driver.delete(row.objectKey)
  await db.storedObject.delete({ where: { id } })
}
