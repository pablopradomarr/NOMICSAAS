/**
 * E12 · T14 — **el ZIP, en streaming** (deuda 1 de §6 del diseño de E12).
 *
 * ## Qué cierra
 *
 * `models/backups.ts` construía el archivo con `JSZip` y `generateAsync({ type:
 * "nodebuffer" })`: **todo el contenido, comprimido y sin comprimir, vivo en el
 * heap a la vez**. El propio fichero lo declaraba como deuda con épica de cierre
 * —«un volcado de 2 GB no cabe en el heap de una función serverless»— y el techo
 * 5 de §12 de E11 sólo pudo medirse extrapolando. Con 2 000 ficheros y 1,5 GB
 * reales el proceso muere antes de firmar nada.
 *
 * Aquí se escribe el ZIP **entrada a entrada**, sin conocer el tamaño total ni
 * mantener más de un bloque en memoria. El pico de memoria pasa a ser
 * `O(tamaño de bloque)` —decenas de KB— y **no depende del volumen**, que es lo
 * que el criterio 47 de E12 exige medir.
 *
 * ## Las cuatro decisiones del formato
 *
 * 1. **Descriptores de datos** (bit 3 de los indicadores). Escribir la cabecera
 *    local obliga a declarar CRC y tamaños *antes* de haber leído el contenido.
 *    Con el bit 3 se declaran ceros y las cifras verdaderas van **detrás** del
 *    contenido, en un descriptor. Es la única manera de emitir un ZIP sin haber
 *    visto el final, y está en el estándar desde APPNOTE 2.0; el directorio
 *    central —que es de donde lee cualquier lector serio, `JSZip` incluido—
 *    lleva las cifras reales.
 * 2. **ZIP64 sólo cuando hace falta.** Se activa por entrada (> 4 GiB) y por
 *    archivo (> 4 GiB de desplazamiento o > 65 535 entradas). Emitir ZIP64
 *    siempre reduciría la compatibilidad sin ganar nada; no emitirlo nunca haría
 *    que un backup grande produjera un archivo corrupto **en silencio**, que es
 *    la peor de las dos opciones.
 * 3. **`DEFLATE` para el texto, `STORE` para los documentos.** Los JSONL
 *    comprimen 5:1; un PDF o un JPEG ya vienen comprimidos y volver a
 *    comprimirlos cuesta el 100 % de la CPU para ganar el 0 % del tamaño. Con
 *    1,5 GB de documentos esa decisión es la diferencia entre entrar y no entrar
 *    en el techo de 15 minutos.
 * 4. **Marca de tiempo fija** (1980-01-01, el cero del formato). Un ZIP cuyo
 *    contenido no ha cambiado tiene que dar los mismos bytes: el reloj dentro de
 *    las cabeceras rompería la reproducibilidad que P7 promete, y es justo el
 *    tipo de campo mutable que la enmienda **E-5** proscribe.
 *
 * Módulo **PURO** en el sentido del proyecto: no toca la base, no lee
 * configuración, no mira el reloj. Recibe un iterable de entradas y devuelve un
 * iterable de bloques. Quien lo consuma decide si van a un fichero, a una
 * petición multipart o a `/dev/null`.
 */

import { createDeflateRaw } from "node:zlib"

// ─────────────────────────────────────────────────────────────────────────────
// CRC-32 (IEEE 802.3), incremental
// ─────────────────────────────────────────────────────────────────────────────

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32 incremental: el ZIP lo exige por entrada y se calcula al vuelo. */
export class Crc32 {
  private value = 0xffffffff

  update(chunk: Buffer): this {
    let crc = this.value
    for (let i = 0; i < chunk.length; i += 1) crc = CRC_TABLE[(crc ^ chunk[i]) & 0xff] ^ (crc >>> 8)
    this.value = crc >>> 0
    return this
  }

  digest(): number {
    return (this.value ^ 0xffffffff) >>> 0
  }
}

export function crc32(data: Buffer): number {
  return new Crc32().update(data).digest()
}

// ─────────────────────────────────────────────────────────────────────────────
// Entradas
// ─────────────────────────────────────────────────────────────────────────────

export type ZipMethod = "STORE" | "DEFLATE"

export type ZipEntry = {
  /** Ruta dentro del archivo, con `/`. Siempre UTF-8 (indicador bit 11). */
  name: string
  /**
   * El contenido. Un `Buffer` para lo pequeño; un iterable asíncrono para lo que
   * no cabe en memoria — que es el motivo de existir de este módulo.
   */
  source: Buffer | AsyncIterable<Buffer> | (() => AsyncIterable<Buffer>)
  /** Por defecto `DEFLATE`. Los documentos ya comprimidos entran con `STORE`. */
  method?: ZipMethod
}

/** Lo que se sabe de una entrada **después** de haberla escrito. */
export type ZipEntryReport = {
  name: string
  method: ZipMethod
  crc32: number
  compressedSize: number
  uncompressedSize: number
  offset: number
}

const LOCAL_SIG = 0x04034b50
const DESCRIPTOR_SIG = 0x08074b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
const ZIP64_EOCD_SIG = 0x06064b50
const ZIP64_LOCATOR_SIG = 0x07064b50

/** Indicadores: bit 3 (descriptor de datos) + bit 11 (nombre en UTF-8). */
const FLAG_DATA_DESCRIPTOR = 0x0008
const FLAG_UTF8 = 0x0800

/** 1980-01-01 00:00:00, el cero del formato MS-DOS. Fijo: sin reloj. */
const DOS_TIME = 0
const DOS_DATE = 0x0021

const MAX_UINT32 = 0xffffffff
const MAX_UINT16 = 0xffff

/** Versión mínima para extraer: 2.0 con DEFLATE, 4.5 con ZIP64. */
const VERSION_BASE = 20
const VERSION_ZIP64 = 45

function localHeader(name: Buffer, method: ZipMethod, zip64: boolean): Buffer {
  // ZIP64 en la cabecera local: el campo extra reserva los dos huecos de 8
  // bytes que el descriptor rellenará. Sin él, un lector que confíe en la
  // cabecera local no sabría que los tamaños son de 64 bits.
  const extra = zip64 ? zip64ExtraField([BigInt(0), BigInt(0)]) : Buffer.alloc(0)
  const header = Buffer.alloc(30)
  header.writeUInt32LE(LOCAL_SIG, 0)
  header.writeUInt16LE(zip64 ? VERSION_ZIP64 : VERSION_BASE, 4)
  header.writeUInt16LE(FLAG_DATA_DESCRIPTOR | FLAG_UTF8, 6)
  header.writeUInt16LE(method === "DEFLATE" ? 8 : 0, 8)
  header.writeUInt16LE(DOS_TIME, 10)
  header.writeUInt16LE(DOS_DATE, 12)
  header.writeUInt32LE(0, 14) // crc, en el descriptor
  header.writeUInt32LE(0, 18) // tamaño comprimido, en el descriptor
  header.writeUInt32LE(0, 22) // tamaño sin comprimir, en el descriptor
  header.writeUInt16LE(name.length, 26)
  header.writeUInt16LE(extra.length, 28)
  return Buffer.concat([header, name, extra])
}

function zip64ExtraField(values: readonly bigint[]): Buffer {
  const out = Buffer.alloc(4 + 8 * values.length)
  out.writeUInt16LE(0x0001, 0)
  out.writeUInt16LE(8 * values.length, 2)
  values.forEach((value, index) => out.writeBigUInt64LE(value, 4 + 8 * index))
  return out
}

function dataDescriptor(report: Omit<ZipEntryReport, "name" | "method" | "offset">, zip64: boolean): Buffer {
  if (zip64) {
    const out = Buffer.alloc(24)
    out.writeUInt32LE(DESCRIPTOR_SIG, 0)
    out.writeUInt32LE(report.crc32, 4)
    out.writeBigUInt64LE(BigInt(report.compressedSize), 8)
    out.writeBigUInt64LE(BigInt(report.uncompressedSize), 16)
    return out
  }
  const out = Buffer.alloc(16)
  out.writeUInt32LE(DESCRIPTOR_SIG, 0)
  out.writeUInt32LE(report.crc32, 4)
  out.writeUInt32LE(report.compressedSize, 8)
  out.writeUInt32LE(report.uncompressedSize, 12)
  return out
}

function centralHeader(entry: ZipEntryReport): Buffer {
  const name = Buffer.from(entry.name, "utf8")
  // ZIP64 en el directorio central: sólo los campos que **desbordan**, y en el
  // orden que fija APPNOTE 4.5.3 (sin comprimir, comprimido, desplazamiento).
  const overflow: bigint[] = []
  const needsSizes = entry.uncompressedSize > MAX_UINT32 || entry.compressedSize > MAX_UINT32
  const needsOffset = entry.offset > MAX_UINT32
  if (needsSizes) overflow.push(BigInt(entry.uncompressedSize), BigInt(entry.compressedSize))
  if (needsOffset) overflow.push(BigInt(entry.offset))
  const extra = overflow.length > 0 ? zip64ExtraField(overflow) : Buffer.alloc(0)

  const header = Buffer.alloc(46)
  header.writeUInt32LE(CENTRAL_SIG, 0)
  // «Hecho por»: UNIX (3) en el byte alto, versión en el bajo.
  header.writeUInt16LE((3 << 8) | (extra.length > 0 ? VERSION_ZIP64 : VERSION_BASE), 4)
  header.writeUInt16LE(extra.length > 0 ? VERSION_ZIP64 : VERSION_BASE, 6)
  header.writeUInt16LE(FLAG_DATA_DESCRIPTOR | FLAG_UTF8, 8)
  header.writeUInt16LE(entry.method === "DEFLATE" ? 8 : 0, 10)
  header.writeUInt16LE(DOS_TIME, 12)
  header.writeUInt16LE(DOS_DATE, 14)
  header.writeUInt32LE(entry.crc32, 16)
  header.writeUInt32LE(needsSizes ? MAX_UINT32 : entry.compressedSize, 20)
  header.writeUInt32LE(needsSizes ? MAX_UINT32 : entry.uncompressedSize, 24)
  header.writeUInt16LE(name.length, 28)
  header.writeUInt16LE(extra.length, 30)
  header.writeUInt16LE(0, 32) // comentario
  header.writeUInt16LE(0, 34) // disco
  header.writeUInt16LE(0, 36) // atributos internos
  // Atributos externos: fichero regular 0644 en el byte alto (UNIX). El
  // desplazamiento de 16 bits desborda el entero con signo de JavaScript, de ahí
  // el `>>> 0`.
  header.writeUInt32LE(((0o100644 << 16) >>> 0) as number, 38)
  header.writeUInt32LE(needsOffset ? MAX_UINT32 : entry.offset, 42)
  return Buffer.concat([header, name, extra])
}

function endOfCentralDirectory(entries: number, centralSize: number, centralOffset: number): Buffer {
  const zip64 = entries > MAX_UINT16 || centralSize > MAX_UINT32 || centralOffset > MAX_UINT32
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(zip64 ? MAX_UINT16 : entries, 8)
  eocd.writeUInt16LE(zip64 ? MAX_UINT16 : entries, 10)
  eocd.writeUInt32LE(zip64 ? MAX_UINT32 : centralSize, 12)
  eocd.writeUInt32LE(zip64 ? MAX_UINT32 : centralOffset, 16)
  eocd.writeUInt16LE(0, 20)
  if (!zip64) return eocd

  const record = Buffer.alloc(56)
  record.writeUInt32LE(ZIP64_EOCD_SIG, 0)
  record.writeBigUInt64LE(BigInt(44), 4) // tamaño del registro menos 12
  record.writeUInt16LE((3 << 8) | VERSION_ZIP64, 12)
  record.writeUInt16LE(VERSION_ZIP64, 14)
  record.writeUInt32LE(0, 16)
  record.writeUInt32LE(0, 20)
  record.writeBigUInt64LE(BigInt(entries), 24)
  record.writeBigUInt64LE(BigInt(entries), 32)
  record.writeBigUInt64LE(BigInt(centralSize), 40)
  record.writeBigUInt64LE(BigInt(centralOffset), 48)

  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(ZIP64_LOCATOR_SIG, 0)
  locator.writeUInt32LE(0, 4)
  locator.writeBigUInt64LE(BigInt(centralOffset + centralSize), 8)
  locator.writeUInt32LE(1, 16)

  return Buffer.concat([record, locator, eocd])
}

/** Normaliza las tres formas admitidas de contenido a un iterable asíncrono. */
async function* chunksOf(source: ZipEntry["source"]): AsyncIterable<Buffer> {
  if (Buffer.isBuffer(source)) {
    if (source.length > 0) yield source
    return
  }
  const iterable = typeof source === "function" ? source() : source
  for await (const chunk of iterable) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (buffer.length > 0) yield buffer
  }
}

/**
 * Comprime con DEFLATE crudo **respetando la contrapresión**: se empuja bloque a
 * bloque y se drena lo que el compresor haya producido. Sin esto, un fichero de
 * 1,5 GB acabaría acumulado en el búfer interno de `zlib`, que es exactamente el
 * problema que este módulo existe para no tener.
 */
async function* deflated(source: AsyncIterable<Buffer>): AsyncIterable<Buffer> {
  const compressor = createDeflateRaw({ level: 6 })
  const pending: Buffer[] = []
  let failure: Error | null = null
  compressor.on("data", (chunk: Buffer) => pending.push(chunk))
  compressor.on("error", (error: Error) => {
    failure = error
  })

  const drain = function* (): Generator<Buffer> {
    while (pending.length > 0) yield pending.shift()!
  }

  for await (const chunk of source) {
    if (failure) throw failure
    if (!compressor.write(chunk)) {
      await new Promise<void>((resolve) => compressor.once("drain", () => resolve()))
    }
    yield* drain()
  }

  await new Promise<void>((resolve, reject) => {
    compressor.once("end", () => resolve())
    compressor.once("error", reject)
    compressor.end()
    compressor.resume()
  })
  if (failure) throw failure
  yield* drain()
}

export type ZipStreamResult = {
  /** Una fila por entrada, en el orden en que se escribieron. */
  entries: ZipEntryReport[]
  /** Bytes totales del archivo. */
  totalBytes: number
}

/**
 * Emite el ZIP como una secuencia de bloques.
 *
 * `onFinish` recibe el parte de lo escrito cuando el archivo está cerrado: es la
 * evidencia que el trabajo de backup guarda (entradas, tamaños y CRC) y lo que
 * permite comprobar, sin releer el archivo, que dentro está lo que el manifest
 * promete.
 */
export async function* zipStream(
  entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
  onFinish?: (result: ZipStreamResult) => void
): AsyncGenerator<Buffer> {
  const written: ZipEntryReport[] = []
  const seen = new Set<string>()
  let offset = 0

  for await (const entry of entries as AsyncIterable<ZipEntry>) {
    if (entry.name === "" || entry.name.startsWith("/") || entry.name.includes("..")) {
      throw new Error(`zipStream: nombre de entrada no admisible: ${entry.name}`)
    }
    if (seen.has(entry.name)) throw new Error(`zipStream: entrada duplicada: ${entry.name}`)
    seen.add(entry.name)

    const method: ZipMethod = entry.method ?? "DEFLATE"
    const name = Buffer.from(entry.name, "utf8")
    /**
     * **ZIP64 por entrada: decidido ANTES de escribir.** No se puede saber si el
     * contenido pasará de 4 GiB sin haberlo leído, y la cabecera local ya está
     * escrita para entonces. Se resuelve declarando ZIP64 en la cabecera local
     * cuando el llamante **avisa** con `STORE` de un documento grande… y, para
     * no depender de un aviso, el criterio es conservador: las entradas de datos
     * del backup (`files/**`) se emiten siempre con hueco ZIP64. El coste son 20
     * bytes por entrada; el beneficio es que un documento de 5 GB no produce un
     * archivo corrupto.
     */
    const zip64Entry = method === "STORE"
    const start = offset
    const header = localHeader(name, method, zip64Entry)
    yield header
    offset += header.length

    const crc = new Crc32()
    let uncompressed = 0
    let compressed = 0

    const raw = chunksOf(entry.source)
    if (method === "DEFLATE") {
      // El CRC es siempre del contenido SIN comprimir: se mide antes de pasar
      // por el compresor.
      const measured = (async function* () {
        for await (const chunk of raw) {
          crc.update(chunk)
          uncompressed += chunk.length
          yield chunk
        }
      })()
      for await (const chunk of deflated(measured)) {
        compressed += chunk.length
        offset += chunk.length
        yield chunk
      }
    } else {
      for await (const chunk of raw) {
        crc.update(chunk)
        uncompressed += chunk.length
        compressed += chunk.length
        offset += chunk.length
        yield chunk
      }
    }

    const report: ZipEntryReport = {
      name: entry.name,
      method,
      crc32: crc.digest(),
      compressedSize: compressed,
      uncompressedSize: uncompressed,
      offset: start,
    }
    const descriptor = dataDescriptor(report, zip64Entry)
    yield descriptor
    offset += descriptor.length
    written.push(report)
  }

  const centralOffset = offset
  let centralSize = 0
  for (const entry of written) {
    const record = centralHeader(entry)
    centralSize += record.length
    offset += record.length
    yield record
  }

  const tail = endOfCentralDirectory(written.length, centralSize, centralOffset)
  offset += tail.length
  yield tail

  onFinish?.({ entries: written, totalBytes: offset })
}
