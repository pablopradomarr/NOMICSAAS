/**
 * E8 · ronda 1 — la resolución de la ruta del almacén no puede divergir.
 *
 * `lib/files-integrity.ts` resuelve el raíz por su cuenta (y explica por qué en
 * su cabecera: la traza de ficheros de Turbopack). Esta duplicación sólo es
 * admisible si está atada: aquí se compara con `fullPathForFile`, que es la que
 * usa el resto del producto, y se comprueba la regla de contención.
 */

import { describe, expect, it } from "vitest"

import { fullPathForFile } from "@/lib/files"
import { sha256OfStoredFile, storedFilePath } from "@/lib/files-integrity"

const ORG = "00000000-0000-4000-8000-0000000000aa"

describe("la ruta del almacén es la misma que la del resto del producto", () => {
  it("coincide con `fullPathForFile` para una ruta normal", () => {
    const relativePath = "unsorted/8f2b.pdf"
    const esperada = fullPathForFile({ id: ORG }, { path: relativePath } as never)
    expect(storedFilePath(ORG, relativePath)).toBe(esperada)
  })

  it("una ruta que se sale del directorio de la organización es una alarma, no un fichero", () => {
    expect(() => storedFilePath(ORG, "../otra-org/factura.pdf")).toThrow(/se sale del directorio/)
    expect(() => storedFilePath(ORG, "unsorted/../../fuera.pdf")).toThrow(/se sale del directorio/)
  })

  it("un fichero que no existe devuelve el motivo, no una excepción", async () => {
    const r = await sha256OfStoredFile(ORG, "unsorted/no-existe-en-ningun-sitio.pdf")
    expect(r).toEqual({ error: "el fichero no está en el almacén" })
  })

  it("una ruta inadmisible tampoco lanza: se cuenta como evidencia", async () => {
    const r = await sha256OfStoredFile(ORG, "../fuera.pdf")
    expect("error" in r && r.error).toMatch(/se sale del directorio/)
  })
})
