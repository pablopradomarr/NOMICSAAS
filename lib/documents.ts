/**
 * **Los bytes de un documento se leen del ALMACÉN** (ADR-0019 **D3**; E11 · T7,
 * y **E12 · T15**, que retira el último camino al disco).
 *
 * ## Qué cierra este módulo
 *
 * La ola B dejó la ingesta escribiendo **dos veces**: al almacén (la verdad) y
 * al disco heredado (`uploads/<org>/…`), «mientras los lectores no estén
 * cableados». Los lectores son seis —descarga, vista previa, OCR, ZIP de
 * exportación, volcado del backup y las dos pantallas que comprueban si el papel
 * sigue ahí— y cada uno resolvía la ruta con `fullPathForFile`, es decir, contra
 * `FILE_UPLOAD_PATH`, que en Vercel es `/tmp`. Eso es el hecho 4 del contexto de
 * ADR-0019: *«los ficheros no persisten donde se despliega»*.
 *
 * Aquí se cablean todos a la misma función, y **la doble escritura desaparece**.
 *
 * ## Por qué queda un camino al disco
 *
 * Porque lo subido **antes** de E11 sólo está en disco, y la contrapartida es
 * `scripts/migrate-uploads-to-storage.ts`. El orden no es negociable y es el
 * mismo que fijó `sha256OfStoredDocument`: **primero el almacén**, después el
 * disco. Al revés, una organización ya migrada seguiría leyéndose de una copia
 * vieja del volumen local y un fichero alterado EN EL ALMACÉN pasaría
 * desapercibido — I-E8-2 daría PASS sobre los bytes equivocados.
 *
 * El camino al disco se retira cuando `scripts/migrate-uploads-to-storage.ts`
 * haya corrido en todos los entornos; queda fechado en E12 en `docs/ESTADO.md`.
 *
 * ## Lo que este módulo NO hace
 *
 * No verifica el `sha256`. Leer y verificar son dos cosas distintas y la segunda
 * ya tiene dueño: `sha256OfStoredDocument` (I-E8-2) y `verifyObject` (I-E11-6).
 * Una descarga que verificara por su cuenta duplicaría el criterio y acabaría
 * divergiendo del invariante, que es el patrón que E9 y E10 pagaron dos veces.
 */

import type { OrganizationRef } from "@/lib/files"
import { objectKey, storage } from "@/lib/storage"

/** Lo mínimo que hace falta para localizar los bytes de un documento. */
export type DocumentRef = { sha256: string | null; path: string }

/**
 * Los bytes del documento, **del almacén y de ningún otro sitio**. `null`
 * cuando no están, que es un estado legítimo y con nombre: «el documento no
 * está en el almacén» (410 Gone en las rutas, `INFO` en el barrido), nunca una
 * excepción que tumbe la pantalla.
 *
 * Un fichero sin `sha256` no tiene localización posible: la columna es `NOT
 * NULL` desde E8 y el tipo la admite nula sólo por los `select` parciales.
 */
export async function readDocumentBytes(organizationId: string, file: DocumentRef): Promise<Buffer | null> {
  if (!file.sha256) return null
  try {
    const { driver, prefix } = storage()
    return await driver.getBuffer(objectKey({ prefix, organizationId, kind: "DOCUMENT", sha256: file.sha256 }))
  } catch {
    return null
  }
}

/** ¿Están los bytes? Sin traerlos: `head()` es barato. */
export async function documentBytesExist(organizationId: string, file: DocumentRef): Promise<boolean> {
  if (!file.sha256) return false
  try {
    const { driver, prefix } = storage()
    const head = await driver.head(objectKey({ prefix, organizationId, kind: "DOCUMENT", sha256: file.sha256 }))
    return head !== null
  } catch {
    // Un almacén caído no convierte la pantalla en un 500, pero tampoco
    // promete unos bytes que no ha visto.
    return false
  }
}

/**
 * Mismo contrato, con la organización en vez del id: azúcar para las rutas, que
 * ya tienen `org` en la mano.
 */
export async function readDocumentBytesFor(organization: OrganizationRef, file: DocumentRef): Promise<Buffer | null> {
  return await readDocumentBytes(organization.id, file)
}
