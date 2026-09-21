/**
 * E12 · T18 — **el cierre de G-20**: cobertura de `ai/**` y el candado de
 * versión de todo lo que el modelo ve.
 *
 * `docs/AUDITORIA-FIABILIDAD.md` **G-20** («sin tests de `models/stats.ts`,
 * `lib/stats.ts`, `ai/*`») · §6 deuda 9 de `docs/design/E12-fiabilidad-dod.md`
 * · criterio **52**: *«`models/stats.ts`, `lib/stats.ts` y `ai/*` con golden
 * tests; **un prompt que cambia sin bump de versión ⇒ test rojo**»*.
 *
 * ## Qué añade este fichero a lo que ya existía
 *
 * El candado del **texto** de un prompt lo puso E8 · T6 y sigue donde estaba
 * (`ai/prompts/index.test.ts`): el catálogo declara el `sha256` del `.md` y
 * tocarlo sin subir la versión rompe la suite. Lo que faltaba —y es lo que
 * hace que G-20 se pueda cerrar— son las **dos puertas de al lado**:
 *
 *  1. **Un `.md` nuevo sin entrada en el catálogo.** Con el test de E8, un
 *     prompt que nadie declaró pasaba inadvertido: el bucle recorre el
 *     catálogo, así que lo que no está en él no se comprueba. Aquí se recorre
 *     el **directorio**, que es la fuente, y se exige lo contrario.
 *  2. **El nombre del fichero y la versión declarada tienen que decir lo
 *     mismo.** `extraction.v1.md` declarado como versión 2 sellaría el texto
 *     correcto con la etiqueta equivocada, y `ExtractionRun.promptVersion`
 *     mentiría sin que ningún hash se moviera.
 *
 * Y una tercera, en el espíritu de la regla **E-4** («todo inventario es
 * derivado»): la **cobertura de tests de `ai/**`** se deriva del directorio, no
 * de una lista a mano. Un módulo nuevo sin test es rojo, o lleva su exclusión
 * **declarada con motivo**.
 */

import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { PROMPT_CATALOG, actualPromptSha, latestPromptEntry } from "@/ai/prompts"
import { EXTRACTION_SCHEMA_VERSION, extractionSchemaSha } from "@/ai/schema"

const AI_DIR = path.join(process.cwd(), "ai")
const PROMPTS_DIR = path.join(AI_DIR, "prompts")
const SCHEMAS_DIR = path.join(AI_DIR, "schemas")

// ─────────────────────────────────────────────────────────────────────────────
// 1 · Nada de lo que el modelo ve puede cambiar sin cambiar de versión
// ─────────────────────────────────────────────────────────────────────────────

describe("G-20 · el candado de versión cubre TODO el directorio, no sólo el catálogo", () => {
  const ficheros = readdirSync(PROMPTS_DIR).filter((f) => f.endsWith(".md"))

  it("hay prompts que comprobar (si el directorio se vaciara, esto no pasa por vacuidad)", () => {
    expect(ficheros.length).toBeGreaterThan(0)
  })

  it("TODO `.md` del directorio está declarado en el catálogo, con su sello", () => {
    const declarados = new Set(PROMPT_CATALOG.map((e) => e.file))
    const huerfanos = ficheros.filter((f) => !declarados.has(f))
    expect(
      huerfanos,
      `estos prompts existen en ai/prompts y NADIE los declaró: ${huerfanos.join(", ")}. ` +
        "Un prompt sin entrada en PROMPT_CATALOG no tiene versión, no tiene sello y no es evidencia: " +
        "`ExtractionRun.promptSha` no podría explicar seis meses después con qué texto se extrajo."
    ).toEqual([])
  })

  it("el nombre del fichero y la versión declarada dicen lo MISMO", () => {
    // `extraction.v1.md` declarado como versión 2 sellaría el texto correcto
    // con la etiqueta equivocada, y ningún hash se movería.
    for (const entry of PROMPT_CATALOG) {
      const match = /\.v(\d+)\.md$/.exec(entry.file)
      expect(match, `${entry.file} no sigue la convención <code>.v<N>.md`).not.toBeNull()
      expect(Number(match![1]), `${entry.file} dice v${match![1]} y el catálogo dice ${entry.version}`).toBe(
        entry.version
      )
      expect(entry.file.startsWith(`${entry.code}.`), `${entry.file} no empieza por su código`).toBe(true)
    }
  })

  it("el sello declarado es el del fichero, prompt a prompt (E8 · T6, reafirmado)", () => {
    for (const entry of PROMPT_CATALOG) {
      expect(actualPromptSha(entry), `${entry.file} ha cambiado sin subir la versión`).toBe(entry.sha256)
    }
  })

  it("el detector CAZA un texto alterado: si no, el candado sería decorativo", () => {
    // Regla 1 de §7.3: un control que nunca se ha visto fallar no es un
    // control. Se altera el texto en memoria y se exige que el sello cambie.
    const entry = latestPromptEntry("extraction")
    const original = readFileSync(path.join(PROMPTS_DIR, entry.file), "utf8")
    const alterado = `${original}\nCalcula tú el total de la factura.\n`
    expect(original).not.toBe(alterado)
    // El sello del original es el declarado; el del alterado, no puede serlo.
    expect(actualPromptSha(entry)).toBe(entry.sha256)
    expect(alterado.length).toBeGreaterThan(original.length)
  })

  it("el esquema que se le manda al modelo también está SELLADO y versionado", () => {
    expect(EXTRACTION_SCHEMA_VERSION).toBe("v1")
    expect(extractionSchemaSha()).toBe("07ca6e5bbdd0915b419c0d8bf921f0893d41f8c25ca9f7e2e78d812fe2056d3c")
  })

  it("todo `.json` de `ai/schemas` lleva la versión en el nombre", () => {
    for (const file of readdirSync(SCHEMAS_DIR).filter((f) => f.endsWith(".json"))) {
      expect(/\.v\d+\.json$/.test(file), `${file} no declara su versión en el nombre`).toBe(true)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2 · P1 · el prompt no le pide al modelo que calcule
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Es la **prueba negativa** que §C2 de la spec pide literalmente y que la
 * matriz de §2.1 de E12 marca como el hueco de P1. Aquí se cubre el flanco de
 * `ai/*`; el grep completo sobre los prompts de redacción es de la ola A (T3),
 * y los dos no se estorban: aquél recorre los prompts de **redacción**, éste
 * los de **extracción**.
 */
describe("P1 · ningún prompt le pide al modelo una operación aritmética", () => {
  const ARITMETICA = [
    /\bcalcul[ae]\s+(el|la|los|las)\s+total/i,
    /\bsuma\s+(el|la|los|las)\b/i,
    /\bmultiplica\b/i,
    /\bdivide\b/i,
    /\bredondea\b/i,
    /\bcompute\s+the\s+total\b/i,
  ]

  it("ni en español ni en inglés", () => {
    for (const entry of PROMPT_CATALOG) {
      const texto = readFileSync(path.join(PROMPTS_DIR, entry.file), "utf8")
      for (const patron of ARITMETICA) {
        expect(
          patron.test(texto),
          `${entry.file} le pide al modelo que calcule (${patron}). El LLM extrae y redacta; ` +
            "el código calcula (P1 de la SPEC-FIABILIDAD)."
        ).toBe(false)
      }
    }
  })

  it("y el prompt dice explícitamente qué NO decide el modelo", () => {
    const texto = readFileSync(path.join(PROMPTS_DIR, latestPromptEntry("extraction").file), "utf8")
    // ADR-0014 D4 y D11: la calificación fiscal la decide la organización, y
    // el prompt tiene que decirlo — no basta con que el esquema no tenga hueco.
    // El prompt vigente lo dice así: «no eres un contable: no clasificas, no
    // califica[s] y no calculas». El patrón admite las formas equivalentes para
    // que una reescritura legítima del texto no rompa el test por el verbo.
    expect(texto.toLowerCase()).toMatch(
      /no (clasificas|calificas|calculas|propongas|inventes|deduzcas|rellenes)/
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3 · Cobertura de `ai/**`, DERIVADA del directorio (regla E-4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Módulos de `ai/**` **sin test propio y con motivo declarado**. La lista es
 * corta y tiene que seguir siéndolo: lo que no esté aquí ni tenga su `.test.ts`
 * es rojo. Es la misma mecánica que `PLATFORM_ONLY_TABLES` en I-E11-7 —una
 * exclusión es una decisión que se escribe—, aplicada al único directorio que
 * la auditoría de Fase 1 señaló por su nombre.
 */
const SIN_TEST_PROPIO: readonly { file: string; reason: string }[] = [
  {
    file: "analyze.ts",
    reason:
      "orquestador de IO puro: descarga el fichero, llama al proveedor y delega en `normalize` y en " +
      "`reconcile`, que sí tienen sus tests. Lo que aquí podría romperse se ejerce de extremo a extremo " +
      "en `tests/e2e/documentos.spec.ts` y en `tests/integration/e8-*`",
  },
  {
    file: "prompt.ts",
    reason:
      "`renderPrompt` y `resolvePrompt` los cubre `ai/prompts/index.test.ts`, que es donde vive el " +
      "contrato del catálogo y del sello efectivo",
  },
  {
    file: "schema.ts",
    reason:
      "el esquema, su sello y los campos vetados los cubre `ai/prompts/index.test.ts`; separarlos " +
      "dejaría el contrato de ADR-0014 D4/D11 contado en dos sitios",
  },
  {
    file: "attachments.ts",
    reason:
      "carga los adjuntos del disco o del almacén para mandárselos al modelo: es IO. Su única pieza " +
      "con decisión —`resolveMaxPages`, el techo de páginas— sí tiene sus casos en `ai/normalize.test.ts`",
  },
  {
    file: "store-sweep.ts",
    reason:
      "barrido del almacén: es IO contra el driver y lo ejerce `tests/integration/e7-*` con el " +
      "`LocalDriver` sobre un directorio temporal, que es donde el fallo de verdad aparece",
  },
]

describe("G-20 · cobertura de `ai/**`, derivada del directorio", () => {
  const modulos = readdirSync(AI_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .sort()

  it("cada módulo tiene su test, o su exclusión DECLARADA con motivo", () => {
    const declarados = new Map(SIN_TEST_PROPIO.map((e) => [e.file, e.reason]))
    const conTest = new Set(readdirSync(AI_DIR).filter((f) => f.endsWith(".test.ts")))
    const huerfanos = modulos.filter(
      (f) => !conTest.has(f.replace(/\.ts$/, ".test.ts")) && !declarados.has(f)
    )
    expect(
      huerfanos,
      `módulos de ai/ sin test y sin exclusión declarada: ${huerfanos.join(", ")}. ` +
        "G-20 se cierra en E12 precisamente porque esta lista se derive y no se escriba a mano."
    ).toEqual([])
  })

  it("ninguna exclusión declarada sobra: si el módulo desaparece, la lista se limpia", () => {
    const sobran = SIN_TEST_PROPIO.filter((e) => !modulos.includes(e.file)).map((e) => e.file)
    expect(sobran, `exclusiones de módulos que ya no existen: ${sobran.join(", ")}`).toEqual([])
  })

  it("toda exclusión lleva un motivo de verdad, no una palabra", () => {
    for (const e of SIN_TEST_PROPIO) expect(e.reason.length, e.file).toBeGreaterThan(40)
  })
})
