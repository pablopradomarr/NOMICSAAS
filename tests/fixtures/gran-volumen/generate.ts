/**
 * E12 · T17 — el gemelo en TypeScript de `docs/design/fixtures/build_gran_volumen.py`.
 *
 * El fixture de gran volumen **no es un fichero de datos**: son 50 000 asientos,
 * 150 000 líneas, 2 000 documentos y 1,5 GB, y eso no se versiona. Lo que se
 * versiona es `spec.json` —los parámetros, la semilla y **los digests de todo lo
 * que produce**— y dos generadores que tienen que dar exactamente lo mismo: el
 * de Python, que sella, y éste, que siembra.
 *
 * **Que sean dos no es duplicación: es la comprobación.** Si el generador que
 * siembra la base fuera el mismo que produce el sello, el sello no probaría nada
 * —es la regla 7 de §7.3 del diseño—. Aquí el de Python sella y el de TypeScript
 * siembra, y `spec.json` los enfrenta: `verificarContra(spec)` recomputa los
 * cuatro digests desde este código y falla si difieren de los sellados.
 *
 * El PRNG es `xorshift64*` con aritmética de `BigInt`, porque `Math.random` no es
 * reproducible y los enteros de 64 bits no caben en un `number`. Cuatro líneas, y
 * la misma secuencia que en Python.
 */

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"

const MASK64 = (BigInt(1) << BigInt(64)) - BigInt(1)

/** xorshift64*, idéntico al de `build_gran_volumen.py`. */
export class Xorshift64 {
  private state: bigint

  constructor(seed: bigint | number) {
    const s = BigInt(seed) & MASK64
    // El estado no puede ser 0: xorshift se quedaría clavado en 0 para siempre.
    this.state = s === BigInt(0) ? BigInt("0x9E3779B97F4A7C15") : s
  }

  nextU64(): bigint {
    let x = this.state
    x ^= (x >> BigInt(12)) & MASK64
    x = (x ^ ((x << BigInt(25)) & MASK64)) & MASK64
    x ^= (x >> BigInt(27)) & MASK64
    this.state = x & MASK64
    return (this.state * BigInt("0x2545F4914F6CDD1D")) & MASK64
  }

  /** Entero en `[0, limit)`, **sin sesgo**: rechazo por módulo, como en Python. */
  below(limit: number): number {
    if (limit <= 0) throw new Error("limit tiene que ser positivo")
    const l = BigInt(limit)
    const corte = (MASK64 / l) * l
    for (;;) {
      const value = this.nextU64()
      if (value < corte) return Number(value % l)
    }
  }

  between(low: number, high: number): number {
    return low + this.below(high - low + 1)
  }
}

export type GranVolumenSpec = {
  params: {
    version: string
    entries: number
    linesPerEntry: number
    files: number
    fileBytesTotal: number
    organizations: number
    seed: number
    fiscalYear: number
    accountDebit: string
    accountDebit2: string
    accountCredit: string
    amountMinCents: number
    amountMaxCents: number
  }
  digests: { entries: string; journalLines: string; files: string; organizations: string }
  totals: {
    entries: number
    journalLines: number
    debitCents: number
    creditCents: number
    files: number
    fileBytes: number
    organizations: number
  }
}

export function leerSpec(raiz: string = process.cwd()): GranVolumenSpec {
  return JSON.parse(
    readFileSync(path.join(raiz, "tests", "fixtures", "gran-volumen", "spec.json"), "utf8")
  ) as GranVolumenSpec
}

export type AsientoGenerado = {
  entryNumber: number
  date: string
  debit1: number
  debit2: number
  credit: number
}

/** El día del ejercicio, en orden creciente: el diario es correlativo (I8). */
function diaDelEjercicio(indice: number, anio: number): string {
  const inicio = Date.UTC(anio, 0, 1)
  return new Date(inicio + (indice % 365) * 86_400_000).toISOString().slice(0, 10)
}

export function* asientos(spec: GranVolumenSpec): Generator<AsientoGenerado> {
  const { params } = spec
  const rng = new Xorshift64(params.seed)
  for (let i = 0; i < params.entries; i += 1) {
    const a = rng.between(params.amountMinCents, params.amountMaxCents)
    const b = rng.between(params.amountMinCents, params.amountMaxCents)
    yield {
      entryNumber: i + 1,
      date: diaDelEjercicio(Math.floor((i * 365) / params.entries), params.fiscalYear),
      debit1: a,
      debit2: b,
      credit: a + b,
    }
  }
}

export type DocumentoGenerado = { index: number; sizeBytes: number; seed: bigint }

export function documentos(spec: GranVolumenSpec): DocumentoGenerado[] {
  const { params } = spec
  const rng = new Xorshift64(BigInt(params.seed) ^ BigInt(0xf11e5))
  const medio = Math.floor(params.fileBytesTotal / params.files)

  const tamanios: number[] = []
  let acumulado = 0
  for (let i = 0; i < params.files - 1; i += 1) {
    const delta = rng.between(-Math.floor((medio * 4) / 10), Math.floor((medio * 4) / 10))
    const tamanio = Math.max(1_024, medio + delta)
    tamanios.push(tamanio)
    acumulado += tamanio
  }
  tamanios.push(Math.max(1_024, params.fileBytesTotal - acumulado))

  return tamanios.map((sizeBytes, index) => ({
    index,
    sizeBytes,
    seed: (BigInt(params.seed) ^ (BigInt(index) * BigInt(0x9e3779b1))) & MASK64,
  }))
}

/**
 * Los bytes de un documento, **en bloques**: 1,5 GB no caben en un `Buffer` y no
 * tienen por qué. Es la misma secuencia que produce `bytes_de_fichero` en Python.
 */
export async function* bytesDeDocumento(doc: DocumentoGenerado, chunkBytes = 64 * 1024): AsyncGenerator<Buffer> {
  const rng = new Xorshift64(doc.seed)
  let restantes = doc.sizeBytes
  while (restantes > 0) {
    const objetivo = Math.min(chunkBytes, restantes)
    const bloque = Buffer.alloc(Math.ceil(objetivo / 8) * 8)
    for (let offset = 0; offset < bloque.length; offset += 8) {
      bloque.writeBigUInt64LE(rng.nextU64(), offset)
    }
    const trozo = bloque.subarray(0, objetivo)
    restantes -= objetivo
    yield trozo
  }
}

export async function sha256DeDocumento(doc: DocumentoGenerado): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of bytesDeDocumento(doc)) hash.update(chunk)
  return hash.digest("hex")
}

export function organizaciones(spec: GranVolumenSpec): Array<{ index: number; id: string; slug: string }> {
  return Array.from({ length: spec.params.organizations }, (_, index) => ({
    index,
    id: `e12f0000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    slug: `gran-volumen-${String(index).padStart(2, "0")}`,
  }))
}

const digestDe = (lineas: readonly string[]): string =>
  createHash("sha256").update(lineas.join("\n"), "utf8").digest("hex")

/**
 * **La comprobación cruzada.** Recomputa los cuatro digests desde ESTE generador
 * y los enfrenta a los que selló el de Python. Si los dos caminos divergen, el
 * fixture deja de significar nada y esto tiene que ponerse rojo.
 *
 * `incluirFicheros` permite saltarse el de los 2 000 documentos: recomputarlo
 * exige generar y hashear 1,5 GB, que en el arranque de un test son minutos. Los
 * otros tres son instantáneos y ya detectan cualquier deriva del PRNG.
 */
export async function verificarContra(
  spec: GranVolumenSpec,
  options: { incluirFicheros?: boolean } = {}
): Promise<{ ok: boolean; discrepancias: string[] }> {
  const discrepancias: string[] = []

  const lineasAsiento: string[] = []
  const lineasDiario: string[] = []
  let debe = 0
  let haber = 0
  for (const e of asientos(spec)) {
    lineasAsiento.push(`${e.entryNumber}\t${e.date}\t${e.debit1}\t${e.debit2}\t${e.credit}`)
    lineasDiario.push(`${e.entryNumber}\t1\t${spec.params.accountDebit}\t${e.debit1}\t0`)
    lineasDiario.push(`${e.entryNumber}\t2\t${spec.params.accountDebit2}\t${e.debit2}\t0`)
    lineasDiario.push(`${e.entryNumber}\t3\t${spec.params.accountCredit}\t0\t${e.credit}`)
    debe += e.debit1 + e.debit2
    haber += e.credit
  }

  const comparar = (nombre: string, actual: string, esperado: string): void => {
    if (actual !== esperado) discrepancias.push(`${nombre}: ${actual} ≠ ${esperado} (sellado)`)
  }

  comparar("entries", digestDe(lineasAsiento), spec.digests.entries)
  comparar("journalLines", digestDe(lineasDiario), spec.digests.journalLines)
  comparar(
    "organizations",
    digestDe(organizaciones(spec).map((o) => `${o.index}\t${o.id}\t${o.slug}`)),
    spec.digests.organizations
  )

  // Σdebe = Σhaber, con tolerancia 0: si el fixture no cuadra, no sirve ni para
  // medir el reloj.
  if (debe !== spec.totals.debitCents || haber !== spec.totals.creditCents || debe !== haber) {
    discrepancias.push(`totales: debe ${debe} / haber ${haber}, sellados ${spec.totals.debitCents}/${spec.totals.creditCents}`)
  }

  const docs = documentos(spec)
  const bytes = docs.reduce((sum, d) => sum + d.sizeBytes, 0)
  if (bytes !== spec.totals.fileBytes) {
    discrepancias.push(`fileBytes: ${bytes} ≠ ${spec.totals.fileBytes} (sellado)`)
  }
  if (options.incluirFicheros) {
    const lineas: string[] = []
    for (const doc of docs) lineas.push(`${doc.index}\t${doc.sizeBytes}\t${await sha256DeDocumento(doc)}`)
    comparar("files", digestDe(lineas), spec.digests.files)
  }

  return { ok: discrepancias.length === 0, discrepancias }
}
