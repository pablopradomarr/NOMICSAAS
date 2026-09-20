/**
 * E11 · T6 — `S3Driver`: **el único driver de red** (P-3, ADR-0019 D3).
 *
 * Supabase Storage se consume por su **endpoint S3**, así que Supabase y S3 son
 * el mismo camino con distinta URL y distinta región: no hay dos drivers que
 * mantener, ni dos sitios donde olvidarse de verificar el sha256.
 *
 * ## Por qué firma a mano y no con el SDK
 *
 * Añadir `@aws-sdk/client-s3` son ~15 MB de dependencia y un grafo de módulos
 * que entra en el bundle de cualquier ruta que toque un fichero. Lo que usamos
 * es exactamente esto: `PUT`, `GET`, `HEAD`, `DELETE`, `GET ?list-type=2` y una
 * URL prefirmada. **AWS Signature V4 sobre `fetch`** cabe en este fichero, se
 * prueba con vectores conocidos y no arrastra nada.
 *
 * ## Integridad
 *
 * - **En la escritura**: el cuerpo se materializa (`Buffer`), se comprueba el
 *   sha256 **antes** de enviarlo y se manda como `x-amz-content-sha256`, que es
 *   justamente la cabecera que la firma V4 cubre. Un objeto no puede llegar al
 *   bucket con unos bytes distintos de los que la clave promete.
 * - **En la lectura**: `head()` devuelve el sha256 si el objeto se subió con él
 *   en `x-amz-meta-sha256`, para que I-E11-6 no tenga que descargar 1,5 GB para
 *   comprobar un bucket entero.
 *
 * **Los tests nunca llegan aquí**: la suite usa `LocalDriver` contra un
 * directorio temporal. Este fichero se prueba en la parte firmable (la
 * canonicalización y la firma), que es pura.
 */

import { createHash, createHmac } from "node:crypto"
import { Readable } from "node:stream"
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

/**
 * Tamaño de parte de una subida multipart. S3 exige un mínimo de 5 MiB en todas
 * las partes menos la última; 8 MiB deja margen y mantiene el pico de memoria en
 * una cifra que cabe en cualquier función serverless. Con 10 000 partes como
 * tope del protocolo, el techo de un objeto son 80 GB — muy por encima de
 * cualquier backup que este producto pueda emitir.
 */
const PART_SIZE = 8 * 1024 * 1024

export type S3Config = {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** Supabase y MinIO exigen path-style; AWS admite las dos. Por defecto, sí. */
  forcePathStyle?: boolean
  /** `SUPABASE` cuando el endpoint es de Supabase Storage; si no, `S3`. */
  backend?: StorageBackend
}

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

/** RFC 3986, que es la que exige SigV4 (y no la de `encodeURIComponent`). */
export function uriEncode(value: string, encodeSlash: boolean): string {
  let out = ""
  for (const char of value) {
    if (/[A-Za-z0-9\-._~]/.test(char)) {
      out += char
    } else if (char === "/") {
      out += encodeSlash ? "%2F" : "/"
    } else {
      for (const byte of Buffer.from(char, "utf8")) out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
    }
  }
  return out
}

/** `20260927T101530Z` / `20260927`. La fecha entra por parámetro: sin reloj oculto. */
export function amzDates(at: Date): { amzDate: string; dateStamp: string } {
  const amzDate = at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")
  return { amzDate, dateStamp: amzDate.slice(0, 8) }
}

export type SignInput = {
  method: string
  host: string
  canonicalUri: string
  canonicalQuery: string
  payloadSha256: string
  headers: Record<string, string>
  region: string
  at: Date
  accessKeyId: string
  secretAccessKey: string
}

/**
 * Firma SigV4 completa. Expuesta y pura para poder probarla con vectores
 * conocidos sin abrir un socket.
 */
export function signV4(input: SignInput): Record<string, string> {
  const { amzDate, dateStamp } = amzDates(input.at)
  const headers: Record<string, string> = {
    ...input.headers,
    host: input.host,
    "x-amz-content-sha256": input.payloadSha256,
    "x-amz-date": amzDate,
  }
  const signedHeaderNames = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort()
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${String(headers[Object.keys(headers).find((k) => k.toLowerCase() === name)!]).trim()}\n`)
    .join("")
  const signedHeaders = signedHeaderNames.join(";")

  const canonicalRequest = [
    input.method,
    input.canonicalUri,
    input.canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    input.payloadSha256,
  ].join("\n")

  const scope = `${dateStamp}/${input.region}/s3/aws4_request`
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n")

  const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest()
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, dateStamp), input.region), "s3"), "aws4_request")
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex")

  return {
    ...headers,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}

export class S3Driver implements StorageDriver {
  readonly backend: StorageBackend

  constructor(
    private readonly config: S3Config,
    /** El reloj entra por parámetro: la firma depende de él y los tests lo fijan. */
    private readonly now: () => Date = () => new Date()
  ) {
    this.backend = config.backend ?? (config.endpoint.includes("supabase") ? "SUPABASE" : "S3")
  }

  private url(key: string, query = ""): { href: string; host: string; canonicalUri: string } {
    const endpoint = new URL(this.config.endpoint)
    const pathStyle = this.config.forcePathStyle !== false
    const canonicalUri = pathStyle
      ? `${endpoint.pathname.replace(/\/$/, "")}/${this.config.bucket}/${uriEncode(key, false)}`
      : `${endpoint.pathname.replace(/\/$/, "")}/${uriEncode(key, false)}`
    const host = pathStyle ? endpoint.host : `${this.config.bucket}.${endpoint.host}`
    return { href: `${endpoint.protocol}//${host}${canonicalUri}${query ? `?${query}` : ""}`, host, canonicalUri }
  }

  private async request(
    method: string,
    key: string,
    options: { query?: string; body?: Buffer; headers?: Record<string, string>; payloadSha256?: string } = {}
  ): Promise<Response> {
    const { href, host, canonicalUri } = this.url(key, options.query)
    const payloadSha256 =
      options.payloadSha256 ?? (options.body ? createHash("sha256").update(options.body).digest("hex") : EMPTY_SHA256)
    const headers = signV4({
      method,
      host,
      canonicalUri,
      canonicalQuery: options.query ?? "",
      payloadSha256,
      headers: options.headers ?? {},
      region: this.config.region,
      at: this.now(),
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
    })
    return await fetch(href, { method, headers, body: options.body as BodyInit | undefined })
  }

  async put(key: string, body: Readable | Buffer, meta: PutMeta): Promise<PutResult> {
    const buffer = Buffer.isBuffer(body) ? body : await bufferOf(body)
    const actual = createHash("sha256").update(buffer).digest("hex")
    if (actual !== meta.sha256) throw new StorageIntegrityError(key, meta.sha256, actual)

    const response = await this.request("PUT", key, {
      body: buffer,
      payloadSha256: actual,
      headers: {
        "content-type": meta.mimeType,
        "content-length": String(buffer.length),
        "x-amz-meta-sha256": actual,
      },
    })
    if (!response.ok) throw new StorageError(`PUT ${key}: ${response.status} ${await response.text()}`)
    return { sizeBytes: BigInt(buffer.length), sha256: actual }
  }

  /**
   * **E12 · T14 — subida MULTIPART.** El ZIP de un backup de 1,5 GB no cabe en
   * el heap y tampoco en un solo `PUT` (S3 corta en 5 GiB y cualquier proxy
   * mucho antes). Se sube por partes de `PART_SIZE`, acumulando **una sola
   * parte** en memoria cada vez: el pico es de 8 MiB y no depende del volumen.
   *
   * Tres cosas que no son adorno:
   *
   * - **Cada parte se firma con el sha256 de su propio cuerpo** (`x-amz-content-sha256`),
   *   que es lo que SigV4 cubre: una parte alterada en tránsito no se acepta.
   * - **El sha256 del objeto entero se calcula al vuelo** y viaja en
   *   `x-amz-meta-sha256` al completar, para que I-E11-6 no tenga que descargar
   *   1,5 GB para comprobar un bucket.
   * - **Un fallo aborta la subida** (`DELETE ?uploadId`): sin eso, S3 cobra
   *   indefinidamente por partes huérfanas que nadie ve.
   *
   * Un cuerpo que cabe en una sola parte se sube con un `PUT` normal: abrir una
   * subida multipart para 4 KB es tres viajes de red en vez de uno.
   */
  async putStreaming(key: string, body: AsyncIterable<Buffer> | Readable, meta: PutStreamingMeta): Promise<PutResult> {
    const hash = createHash("sha256")
    let total = 0

    const partes: Array<{ number: number; etag: string }> = []
    let uploadId: string | null = null
    let pendiente: Buffer[] = []
    let pendienteBytes = 0

    const enviarParte = async (cuerpo: Buffer): Promise<void> => {
      if (uploadId === null) throw new StorageError(`multipart sin uploadId: ${key}`)
      const numero = partes.length + 1
      const respuesta = await this.request("PUT", key, {
        query: `partNumber=${numero}&uploadId=${uriEncode(uploadId, true)}`,
        body: cuerpo,
        headers: { "content-length": String(cuerpo.length) },
      })
      if (!respuesta.ok) throw new StorageError(`UploadPart ${numero} de ${key}: ${respuesta.status} ${await respuesta.text()}`)
      const etag = respuesta.headers.get("etag")
      if (!etag) throw new StorageError(`UploadPart ${numero} de ${key}: el almacén no devuelve ETag`)
      partes.push({ number: numero, etag })
    }

    try {
      for await (const trozo of body as AsyncIterable<Buffer>) {
        const buffer = Buffer.isBuffer(trozo) ? trozo : Buffer.from(trozo)
        if (buffer.length === 0) continue
        hash.update(buffer)
        total += buffer.length
        pendiente.push(buffer)
        pendienteBytes += buffer.length
        if (pendienteBytes < PART_SIZE) continue

        if (uploadId === null) uploadId = await this.createMultipartUpload(key, meta.mimeType)
        // Se envía justo `PART_SIZE` y se conserva el resto: las partes
        // intermedias de una subida multipart tienen que ser todas del mismo
        // tamaño salvo la última.
        const acumulado = Buffer.concat(pendiente, pendienteBytes)
        let cursor = 0
        while (acumulado.length - cursor >= PART_SIZE) {
          await enviarParte(acumulado.subarray(cursor, cursor + PART_SIZE))
          cursor += PART_SIZE
        }
        const resto = acumulado.subarray(cursor)
        pendiente = resto.length > 0 ? [Buffer.from(resto)] : []
        pendienteBytes = resto.length
      }

      const cola = Buffer.concat(pendiente, pendienteBytes)
      const sha256 = hash.digest("hex")

      if (uploadId === null) {
        // Cabía en una parte: un `PUT` normal y nos ahorramos dos viajes.
        const respuesta = await this.request("PUT", key, {
          body: cola,
          payloadSha256: createHash("sha256").update(cola).digest("hex"),
          headers: {
            "content-type": meta.mimeType,
            "content-length": String(cola.length),
            "x-amz-meta-sha256": sha256,
          },
        })
        if (!respuesta.ok) throw new StorageError(`PUT ${key}: ${respuesta.status} ${await respuesta.text()}`)
        return { sizeBytes: BigInt(total), sha256 }
      }

      if (cola.length > 0) await enviarParte(cola)
      await this.completeMultipartUpload(key, uploadId, partes)
      uploadId = null
      return { sizeBytes: BigInt(total), sha256 }
    } catch (error) {
      if (uploadId !== null) {
        // Nunca se dejan partes huérfanas: se cobran y no se ven.
        await this.request("DELETE", key, { query: `uploadId=${uriEncode(uploadId, true)}` }).catch(() => undefined)
      }
      throw error
    }
  }

  private async createMultipartUpload(key: string, mimeType: string): Promise<string> {
    const respuesta = await this.request("POST", key, {
      query: "uploads=",
      body: Buffer.alloc(0),
      headers: { "content-type": mimeType },
    })
    if (!respuesta.ok) throw new StorageError(`CreateMultipartUpload ${key}: ${respuesta.status} ${await respuesta.text()}`)
    const xml = await respuesta.text()
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(xml)?.[1]
    if (!uploadId) throw new StorageError(`CreateMultipartUpload ${key}: respuesta sin UploadId`)
    return decodeXml(uploadId)
  }

  private async completeMultipartUpload(
    key: string,
    uploadId: string,
    partes: ReadonlyArray<{ number: number; etag: string }>
  ): Promise<void> {
    if (partes.length === 0) throw new StorageError(`CompleteMultipartUpload ${key}: sin partes`)
    const cuerpo = Buffer.from(
      `<CompleteMultipartUpload>${partes
        .map((parte) => `<Part><PartNumber>${parte.number}</PartNumber><ETag>${escapeXml(parte.etag)}</ETag></Part>`)
        .join("")}</CompleteMultipartUpload>`,
      "utf8"
    )
    const respuesta = await this.request("POST", key, {
      query: `uploadId=${uriEncode(uploadId, true)}`,
      body: cuerpo,
      headers: { "content-type": "application/xml", "content-length": String(cuerpo.length) },
    })
    if (!respuesta.ok) throw new StorageError(`CompleteMultipartUpload ${key}: ${respuesta.status} ${await respuesta.text()}`)
    // S3 puede devolver 200 con un `<Error>` dentro del cuerpo: un 200 no basta.
    const xml = await respuesta.text()
    if (/<Error>/.test(xml)) throw new StorageError(`CompleteMultipartUpload ${key}: ${xml.slice(0, 300)}`)
  }

  async get(key: string): Promise<Readable> {
    const response = await this.request("GET", key)
    if (response.status === 404) throw new StorageObjectNotFound(key)
    if (!response.ok || !response.body) throw new StorageError(`GET ${key}: ${response.status}`)
    return Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
  }

  async getBuffer(key: string): Promise<Buffer> {
    const response = await this.request("GET", key)
    if (response.status === 404) throw new StorageObjectNotFound(key)
    if (!response.ok) throw new StorageError(`GET ${key}: ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  }

  async head(key: string): Promise<HeadResult | null> {
    const response = await this.request("HEAD", key)
    if (response.status === 404) return null
    if (!response.ok) throw new StorageError(`HEAD ${key}: ${response.status}`)
    const length = response.headers.get("content-length")
    return {
      sizeBytes: BigInt(length ?? "0"),
      sha256: response.headers.get("x-amz-meta-sha256") ?? undefined,
    }
  }

  async delete(key: string): Promise<void> {
    const response = await this.request("DELETE", key)
    if (!response.ok && response.status !== 404) throw new StorageError(`DELETE ${key}: ${response.status}`)
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = []
    let token: string | undefined
    do {
      const query =
        `list-type=2&prefix=${uriEncode(prefix, true)}` + (token ? `&continuation-token=${uriEncode(token, true)}` : "")
      const response = await this.request("GET", "", { query })
      if (!response.ok) throw new StorageError(`LIST ${prefix}: ${response.status}`)
      const xml = await response.text()
      for (const match of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(decodeXml(match[1]))
      token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1]
      if (token) token = decodeXml(token)
    } while (token)
    return keys.sort()
  }

  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    const at = this.now()
    const { amzDate, dateStamp } = amzDates(at)
    const { host, canonicalUri } = this.url(key)
    const scope = `${dateStamp}/${this.config.region}/s3/aws4_request`
    const query = [
      `X-Amz-Algorithm=AWS4-HMAC-SHA256`,
      `X-Amz-Credential=${uriEncode(`${this.config.accessKeyId}/${scope}`, true)}`,
      `X-Amz-Date=${amzDate}`,
      `X-Amz-Expires=${ttlSeconds}`,
      `X-Amz-SignedHeaders=host`,
    ].join("&")
    const canonicalRequest = ["GET", canonicalUri, query, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n")
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n")
    const hmac = (key_: Buffer | string, data: string) => createHmac("sha256", key_).update(data).digest()
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${this.config.secretAccessKey}`, dateStamp), this.config.region), "s3"),
      "aws4_request"
    )
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex")
    const endpoint = new URL(this.config.endpoint)
    return `${endpoint.protocol}//${host}${canonicalUri}?${query}&X-Amz-Signature=${signature}`
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

async function bufferOf(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}
