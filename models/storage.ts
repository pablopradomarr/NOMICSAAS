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
import type { Prisma, StoredObject, StoredObjectKind } from "@/prisma/client"

type AnyTenantClient = TenantClient | TenantTransactionClient

/**
 * **Familias que consumen cuota del cliente** (O-12c). Los ZIP de backup y las
 * copias de NUESTRAS facturas viven en el mismo bucket y **no** son cuota suya:
 * el filtro es por `kind`, nunca por prefijo de clave.
 */
export const BILLABLE_STORAGE_KINDS: readonly StoredObjectKind[] = ["DOCUMENT", "PREVIEW", "LOGO", "AVATAR"]

export type PutObjectInput = {
  organizationId: string
  kind: StoredObjectKind
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
    } satisfies Prisma.StoredObjectUncheckedCreateInput,
  })
}

export async function getObjectBuffer(db: AnyTenantClient, objectKeyValue: string): Promise<Buffer> {
  const row = await db.storedObject.findFirst({ where: { objectKey: objectKeyValue } })
  if (!row) throw new StorageError(`objeto no registrado en esta organización: ${objectKeyValue}`)
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
  await storage().driver.delete(row.objectKey)
  await db.storedObject.delete({ where: { id } })
}
