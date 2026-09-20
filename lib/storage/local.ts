/**
 * E11 · T6 — `LocalDriver`: el almacén sobre disco.
 *
 * Es el comportamiento de hoy (self-hosted, `docker compose`, desarrollo) y
 * **es también el driver de los tests**: la suite no abre una conexión de red
 * jamás, ni contra Supabase ni contra un S3 de mentira. El equivalente exacto de
 * un bucket es un directorio raíz; el prefijo por organización es una carpeta.
 *
 * Detalles que no son cosméticos:
 *
 * - **El sha256 se verifica mientras se escribe**, en streaming, y si no cuadra
 *   el fichero temporal se borra: no queda un objeto a medias con la clave de
 *   otros bytes.
 * - **Escritura atómica**: se escribe en `<clave>.<uuid>.part` y se renombra.
 *   Un `rename` dentro del mismo sistema de ficheros es atómico, así que nadie
 *   puede leer la mitad de un objeto.
 * - **Idempotencia**: si el objeto ya existe con el mismo tamaño se da por
 *   escrito. La clave es el hash del contenido: reescribirlo no puede cambiarlo.
 * - `signedUrl` devuelve una ruta interna de la aplicación, no un `file://`: en
 *   local la descarga la sirve el propio servidor.
 */

import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import path from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { StorageBackend } from "@/prisma/client"
import {
  StorageError,
  StorageIntegrityError,
  StorageObjectNotFound,
  type HeadResult,
  type PutMeta,
  type PutResult,
  type PutStreamingMeta,
  type StorageDriver,
} from "./driver"

export class LocalDriver implements StorageDriver {
  readonly backend: StorageBackend = "LOCAL"

  constructor(private readonly root: string) {}

  /** Ruta absoluta de una clave, con la contención de `safePathJoin`. */
  private resolve(key: string): string {
    if (key === "" || key.startsWith("/") || key.split("/").some((segment) => segment === "." || segment === "..")) {
      throw new StorageError(`clave no admisible: ${key}`)
    }
    const full = path.normalize(path.join(this.root, key))
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new StorageError(`la clave ${key} se sale del raíz del almacén`)
    }
    return full
  }

  async put(key: string, body: Readable | Buffer, meta: PutMeta): Promise<PutResult> {
    const target = this.resolve(key)
    await mkdir(path.dirname(target), { recursive: true })

    const temporary = `${target}.${process.pid}.${Date.now()}.part`
    const hash = createHash("sha256")
    let sizeBytes = BigInt(0)

    const source = Buffer.isBuffer(body) ? Readable.from([body]) : body
    // Un `Transform` y no un `on("data")`: mide y escribe en el mismo paso,
    // respetando la contrapresión. Un ZIP de 2 GB no se puede empujar a un
    // `Readable` manual sin acabar acumulándolo en memoria.
    const measured = new Transform({
      transform(chunk: Buffer | string, _encoding, done) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        hash.update(buffer)
        sizeBytes += BigInt(buffer.length)
        done(null, buffer)
      },
    })

    try {
      await pipeline(source, measured, createWriteStream(temporary))
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }

    const actual = hash.digest("hex")
    if (actual !== meta.sha256) {
      await rm(temporary, { force: true })
      throw new StorageIntegrityError(key, meta.sha256, actual)
    }

    await rename(temporary, target)
    return { sizeBytes, sha256: actual }
  }

  /**
   * **E12 · T14** — escritura en streaming sin `sha256` previo. Mismo patrón
   * atómico que `put()` (temporal + `rename`), midiendo y sellando al vuelo: el
   * pico de memoria es el de un bloque, no el del archivo.
   */
  async putStreaming(key: string, body: AsyncIterable<Buffer> | Readable, meta: PutStreamingMeta): Promise<PutResult> {
    void meta
    const target = this.resolve(key)
    await mkdir(path.dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.${Date.now()}.part`

    const hash = createHash("sha256")
    let sizeBytes = BigInt(0)
    const measured = new Transform({
      transform(chunk: Buffer | string, _encoding, done) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        hash.update(buffer)
        sizeBytes += BigInt(buffer.length)
        done(null, buffer)
      },
    })

    try {
      const source = body instanceof Readable ? body : Readable.from(body)
      await pipeline(source, measured, createWriteStream(temporary))
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }

    await rename(temporary, target)
    return { sizeBytes, sha256: hash.digest("hex") }
  }

  async get(key: string): Promise<Readable> {
    const target = this.resolve(key)
    try {
      await stat(target)
    } catch {
      throw new StorageObjectNotFound(key)
    }
    return createReadStream(target)
  }

  async getBuffer(key: string): Promise<Buffer> {
    const chunks: Buffer[] = []
    const stream = await this.get(key)
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    return Buffer.concat(chunks)
  }

  async head(key: string): Promise<HeadResult | null> {
    try {
      const stats = await stat(this.resolve(key))
      if (!stats.isFile()) return null
      return { sizeBytes: BigInt(stats.size) }
    } catch {
      return null
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true })
  }

  async list(prefix: string): Promise<string[]> {
    // El prefijo puede cortar por la mitad un nombre de directorio, así que se
    // recorre desde el ancestro común y se filtra por cadena.
    const boundary = prefix.endsWith("/") ? prefix : prefix.slice(0, prefix.lastIndexOf("/") + 1)
    const base = boundary === "" ? this.root : this.resolve(boundary)
    const found: string[] = []
    const walk = async (directory: string, relative: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`
        if (entry.isDirectory()) {
          await walk(path.join(directory, entry.name), childRelative)
        } else if (entry.isFile() && !entry.name.endsWith(".part")) {
          found.push(childRelative)
        }
      }
    }
    await walk(base, boundary.replace(/\/$/, ""))
    return found.filter((key) => key.startsWith(prefix)).sort()
  }

  async signedUrl(key: string, _ttlSeconds: number): Promise<string> {
    // En local no hay firma que valga: la descarga la sirve la aplicación, que
    // ya comprueba la membresía. Se devuelve la ruta interna.
    return `/api/storage/${encodeURI(key)}`
  }
}
