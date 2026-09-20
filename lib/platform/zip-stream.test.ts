/**
 * E12 · T14 — el escritor de ZIP en streaming, contra el lector que lo va a leer.
 *
 * Un escritor de ZIP escrito a mano sólo vale si **otro** programa lo lee. Aquí
 * el juez es `JSZip`, que es exactamente quien descomprime en
 * `restoreBackupIntoOrganization`: si un archivo emitido por `zipStream` no se
 * puede restaurar, la deuda 1 de E12 se habría «cerrado» rompiendo el backup.
 */

import JSZip from "jszip"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { Crc32, crc32, zipStream, type ZipEntry, type ZipStreamResult } from "./zip-stream"

async function recoger(entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>): Promise<{
  buffer: Buffer
  result: ZipStreamResult
}> {
  let result: ZipStreamResult | null = null
  const chunks: Buffer[] = []
  for await (const chunk of zipStream(entries, (r) => (result = r))) chunks.push(chunk)
  return { buffer: Buffer.concat(chunks), result: result! }
}

async function* porTrozos(data: Buffer, size: number): AsyncIterable<Buffer> {
  for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size)
}

describe("E12 · T14 — `zipStream`", () => {
  it("CRC-32 coincide con los vectores conocidos y es incremental", () => {
    // Vectores clásicos de IEEE 802.3.
    expect(crc32(Buffer.from(""))).toBe(0)
    expect(crc32(Buffer.from("123456789")).toString(16)).toBe("cbf43926")
    expect(crc32(Buffer.from("The quick brown fox jumps over the lazy dog")).toString(16)).toBe("414fa339")
    // Incremental = de una vez: es lo que permite no materializar el contenido.
    const entero = crc32(Buffer.from("123456789"))
    const troceado = new Crc32().update(Buffer.from("1234")).update(Buffer.from("56789")).digest()
    expect(troceado).toBe(entero)
  })

  it("produce un archivo que JSZip lee, con el contenido intacto", async () => {
    const jsonl = Buffer.from(Array.from({ length: 500 }, (_, i) => `{"id":{"v":"${i}","t":"s"}}`).join("\n"))
    const binario = Buffer.from(Array.from({ length: 40_000 }, (_, i) => i % 251))
    const { buffer } = await recoger([
      { name: "manifest.json", source: Buffer.from('{"formatVersion":"2.0"}') },
      { name: "data/journal_entries.jsonl", source: () => porTrozos(jsonl, 997) },
      { name: "files/ab/abcdef", source: () => porTrozos(binario, 4096), method: "STORE" },
      { name: "vacio.txt", source: Buffer.alloc(0) },
    ])

    const zip = await JSZip.loadAsync(buffer)
    expect(Object.keys(zip.files).sort()).toEqual([
      "data/journal_entries.jsonl",
      "files/ab/abcdef",
      "manifest.json",
      "vacio.txt",
    ])
    expect(await zip.file("manifest.json")!.async("string")).toBe('{"formatVersion":"2.0"}')
    expect(await zip.file("data/journal_entries.jsonl")!.async("nodebuffer")).toEqual(jsonl)
    expect(await zip.file("files/ab/abcdef")!.async("nodebuffer")).toEqual(binario)
    expect(await zip.file("vacio.txt")!.async("string")).toBe("")
  })

  it("el parte final declara CRC y tamaños reales de cada entrada", async () => {
    const cuerpo = Buffer.from("x".repeat(10_000))
    const { result } = await recoger([
      { name: "a.txt", source: cuerpo },
      { name: "b.bin", source: cuerpo, method: "STORE" },
    ])
    const [a, b] = result.entries
    expect(a.uncompressedSize).toBe(10_000)
    expect(b.uncompressedSize).toBe(10_000)
    expect(a.crc32).toBe(crc32(cuerpo))
    expect(b.crc32).toBe(crc32(cuerpo))
    // `DEFLATE` en texto repetido comprime mucho; `STORE` no comprime nada.
    expect(a.compressedSize).toBeLessThan(1_000)
    expect(b.compressedSize).toBe(10_000)
    // Los desplazamientos son crecientes y el total cuadra con lo emitido.
    expect(b.offset).toBeGreaterThan(a.offset)
    expect(result.totalBytes).toBeGreaterThan(b.offset + b.compressedSize)
  })

  it("es reproducible byte a byte: el mismo contenido da el mismo archivo", async () => {
    const entradas = (): ZipEntry[] => [
      { name: "manifest.json", source: Buffer.from('{"a":1}') },
      { name: "data/x.jsonl", source: Buffer.from("una\ndos\ntres") },
    ]
    const uno = await recoger(entradas())
    const dos = await recoger(entradas())
    expect(createHash("sha256").update(uno.buffer).digest("hex")).toBe(
      createHash("sha256").update(dos.buffer).digest("hex")
    )
  })

  it("el troceado de la fuente no cambia ni un byte del archivo", async () => {
    const cuerpo = Buffer.from(Array.from({ length: 30_000 }, (_, i) => (i * 7) % 256))
    const enUno = await recoger([{ name: "d.bin", source: cuerpo, method: "STORE" }])
    const enMuchos = await recoger([{ name: "d.bin", source: () => porTrozos(cuerpo, 13), method: "STORE" }])
    expect(enUno.buffer.equals(enMuchos.buffer)).toBe(true)
  })

  it("rechaza nombres peligrosos y entradas duplicadas", async () => {
    await expect(recoger([{ name: "/etc/passwd", source: Buffer.alloc(0) }])).rejects.toThrow(/no admisible/)
    await expect(recoger([{ name: "../fuera", source: Buffer.alloc(0) }])).rejects.toThrow(/no admisible/)
    await expect(recoger([{ name: "", source: Buffer.alloc(0) }])).rejects.toThrow(/no admisible/)
    await expect(
      recoger([
        { name: "a.txt", source: Buffer.alloc(0) },
        { name: "a.txt", source: Buffer.alloc(0) },
      ])
    ).rejects.toThrow(/duplicada/)
  })

  it("un archivo sin entradas sigue siendo un ZIP válido", async () => {
    const { buffer, result } = await recoger([])
    expect(result.entries).toEqual([])
    const zip = await JSZip.loadAsync(buffer)
    expect(Object.keys(zip.files)).toEqual([])
  })

  it("no acumula el contenido: el pico de memoria no crece con el volumen", async () => {
    /**
     * **El criterio 47 de E12, en pequeño.** Se emiten 64 MB por una fuente que
     * los produce en bloques de 64 KB y se descartan los bloques según salen. Si
     * el escritor materializara la entrada —que es lo que hacía `JSZip`— el heap
     * crecería con el volumen; con streaming, no.
     *
     * Se mide el DELTA de heap, no el absoluto (el proceso de pruebas trae lo
     * suyo), y el umbral es holgado a propósito: lo que se quiere detectar es un
     * crecimiento **proporcional al contenido**, no un megabyte de más.
     */
    const bloque = Buffer.alloc(64 * 1024, 0x5a)
    const bloques = 1024 // 64 MB
    const fuente = async function* () {
      for (let i = 0; i < bloques; i += 1) yield bloque
    }
    global.gc?.()
    const antes = process.memoryUsage().heapUsed
    let pico = antes
    let emitidos = 0
    for await (const chunk of zipStream([{ name: "grande.bin", source: fuente, method: "STORE" }])) {
      emitidos += chunk.length
      pico = Math.max(pico, process.memoryUsage().heapUsed)
    }
    const crecimiento = pico - antes
    expect(emitidos).toBeGreaterThan(64 * 1024 * 1024)
    expect(
      crecimiento,
      `64 MB emitidos con un crecimiento de heap de ${Math.round(crecimiento / 1024 / 1024)} MB`
    ).toBeLessThan(24 * 1024 * 1024)
  }, 120_000)
})
