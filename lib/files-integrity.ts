/**
 * E8 · ronda 1 (auditor H-3 / QA BUG-E8-1) — **integridad de los bytes del
 * almacén**.
 *
 * ## Por qué es un módulo aparte y no una función más de `lib/files.ts`
 *
 * `lib/files.ts` resuelve el raíz del almacén **en el momento de cargarse**
 * (`FILE_UPLOAD_PATH = path.resolve(process.env.UPLOAD_PATH ?? "./uploads")`).
 * Turbopack, al trazar los ficheros que cada ruta necesita en producción (NFT),
 * ve esa operación de sistema de ficheros y traza **el proyecto entero** para
 * toda ruta que llegue hasta ahí; hoy eso le pasa a una sola ruta y el build lo
 * avisa una vez. `models/ledger.ts` lo importa medio producto, así que meter
 * `lib/files` en su grafo convertía ese aviso en nueve.
 *
 * De ahí que aquí el raíz se resuelva **dentro de la función**, no al cargar el
 * módulo. La duplicación respecto de `getOrganizationUploadsDirectory` es
 * deliberada y está atada con un test (`lib/files-integrity.test.ts`) que
 * compara las dos rutas para que no puedan divergir.
 */

import { createHash } from "crypto"
import { createReadStream } from "fs"
import { isAbsolute, normalize, resolve, sep } from "path"

/**
 * `<UPLOAD_PATH>/<organizationId>` resuelto EN LA LLAMADA (ver cabecera).
 *
 * `resolve()` se aplica UNA sola vez y sólo si el raíz configurado es relativo:
 * el rastreador de ficheros de Turbopack marca los módulos que hacen
 * operaciones de ruta al cargarse, y este módulo entra en el grafo de
 * `models/ledger.ts`, o sea de casi toda la aplicación.
 */
function organizationRoot(organizationId: string): string {
  const configured = process.env.UPLOAD_PATH || "./uploads"
  const root = isAbsolute(configured) ? normalize(configured) : resolve(configured)
  return normalize(`${root}${sep}${organizationId}`)
}

/**
 * Ruta absoluta del documento dentro del almacén de su organización, con la
 * misma regla de contención que `safePathJoin`: una ruta registrada que se
 * saliera del directorio de la organización es una alarma, no un fichero.
 */
export function storedFilePath(organizationId: string, relativePath: string): string {
  const root = organizationRoot(organizationId)
  const full = normalize(`${root}${sep}${relativePath}`)
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`la ruta registrada se sale del directorio de la organización: ${relativePath}`)
  }
  return full
}

/**
 * **sha256 de los BYTES que hoy hay en el almacén**, leídos en STREAMING.
 *
 * I-E8-2 promete detectar «un documento alterado bajo los pies del ERP» y hasta
 * esta ronda nadie llenaba `diskSha256`: el invariante se quedaba para siempre
 * en un WARN «sin comprobar en disco» que empujaba el sello a REQUIERE REVISIÓN
 * en toda ejecución. Ésta es la mitad que faltaba, y es de producción: la usa
 * `readDocumentsInvariantInput`, o sea la pestaña Auditoría y
 * `scripts/run-invariants.ts`, no sólo un test.
 *
 * **Streaming y no `readFile`**: un adjunto de 25 MB por cada documento
 * contabilizado del ejercicio no cabe en memoria de golpe, y el hash no
 * necesita el fichero entero.
 *
 * Nunca lanza: devuelve el motivo, porque «no se puede leer» es justamente la
 * evidencia que el invariante tiene que enseñar.
 */
export async function sha256OfStoredFile(
  organizationId: string,
  relativePath: string
): Promise<{ sha256: string } | { error: string }> {
  let fullFilePath: string
  try {
    fullFilePath = storedFilePath(organizationId, relativePath)
  } catch (error) {
    return { error: error instanceof Error ? error.message : "ruta no admisible" }
  }
  try {
    const hash = createHash("sha256")
    const stream = createReadStream(fullFilePath)
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk) => hash.update(chunk))
      stream.on("error", reject)
      stream.on("end", resolve)
    })
    return { sha256: hash.digest("hex") }
  } catch (error) {
    const code = (error as { code?: string } | null)?.code
    if (code === "ENOENT") return { error: "el fichero no está en el almacén" }
    if (code === "EISDIR") return { error: "la ruta registrada es un directorio" }
    return { error: `no se puede leer (${code ?? (error instanceof Error ? error.message : String(error))})` }
  }
}
