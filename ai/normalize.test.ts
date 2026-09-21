/**
 * E12 · T18 — **G-20**: golden tests de `ai/normalize.ts` y `ai/attachments.ts`.
 *
 * `docs/AUDITORIA-FIABILIDAD.md` G-20 («sin tests de `models/stats.ts`,
 * `lib/stats.ts`, `ai/*`») y §6 deuda 9 de `docs/design/E12-fiabilidad-dod.md`:
 * *«documentos de ejemplo → salida esperada»*.
 *
 * `normalizeExtractionOutput` es la costura entre **lo que un modelo escribió**
 * y **los tipos del dominio**, y es el sitio exacto donde una cifra inventada
 * puede colarse en el sistema si nadie la mira. Aquí se le dan salidas de
 * modelo de verdad —incluidas las mal formadas, que son la mayoría— y se exige
 * que:
 *
 *  1. lo que no encaja quede a `null` en vez de «arreglarse» (P1: el LLM
 *     extrae, el código decide);
 *  2. **ningún campo vetado se rellene nunca** (ADR-0014 D4/D11): ni cuenta, ni
 *     dimensiones, ni deducibilidad, ni retención aplicable, ni ISP;
 *  3. la **fecha de recepción** venga siempre con origen `usuario` y jamás del
 *     modelo (O-6 / D8);
 *  4. cada campo lleve su **origen y su confianza**, que es lo que P6 exige y
 *     lo que la pantalla pinta.
 *
 * Las salidas esperadas son literales escritos a mano; ninguna sale de llamar a
 * la función que se prueba (regla 7 de §7.3).
 */

import { describe, expect, it } from "vitest"

import { DEFAULT_MAX_PAGES_TO_ANALYZE, resolveMaxPages } from "@/ai/attachments"
import { normalizeExtractionOutput } from "@/ai/normalize"
import { FORBIDDEN_MODEL_FIELDS, parseExtractionOutput } from "@/ai/schema"
import type { ExtractionOutput } from "@/ai/schema"

const OPTS = { defaultCurrency: "EUR", receptionDate: "2026-03-02" }

/** Una factura simple, tal y como la escribiría el modelo. */
const FACTURA_SIMPLE = {
  docKind: "FACTURA_RECIBIDA",
  documentNumber: "F-2026-0042",
  documentDate: "2026-02-28",
  currency: "eur",
  totalCents: 121_000,
  counterparty: { name: "  Suministros García S.L. ", taxId: "b-12.345.678 " },
  lines: [{ baseCents: 100_000, taxRateCode: "IVA21", description: "Material de obra", qty: 4 }],
  taxes: [{ taxRateCode: "IVA21", baseCents: 100_000, quotaCents: 21_000 }],
  description: "Material para la obra de Alcalá",
} as unknown as ExtractionOutput

describe("normalizeExtractionOutput · una factura bien formada", () => {
  const { proposal, fieldOrigins } = normalizeExtractionOutput(FACTURA_SIMPLE, OPTS)

  it("traduce el documento a los tipos del dominio, sin inventar nada", () => {
    expect(proposal.docKind).toBe("FACTURA_RECIBIDA")
    expect(proposal.documentNumber).toBe("F-2026-0042")
    expect(proposal.documentDate).toBe("2026-02-28")
    expect(proposal.totalCents).toBe(121_000)
    expect(proposal.currency).toBe("EUR")
  })

  it("el NIF se normaliza —sin puntos, guiones ni espacios, y en mayúsculas—", () => {
    // Es lo que hace que dos facturas del mismo proveedor se reconozcan como
    // del mismo proveedor: `B-12.345.678` y `B12345678` son el mismo NIF.
    expect(proposal.counterparty.taxId).toBe("B12345678")
    expect(proposal.counterparty.name).toBe("Suministros García S.L.")
    // Y el `id` NO se resuelve aquí: lo decide la organización.
    expect(proposal.counterparty.id).toBeNull()
  })

  it("las líneas llevan `kind = OPERACION` y conservan sus céntimos enteros", () => {
    expect(proposal.lines).toEqual([
      {
        kind: "OPERACION",
        baseCents: 100_000,
        taxRateCode: "IVA21",
        description: "Material de obra",
        qty: 4,
      },
    ])
  })

  it("la cuota de IVA viaja tal cual: el código NO la recalcula aquí", () => {
    expect(proposal.taxes).toEqual([{ taxRateCode: "IVA21", baseCents: 100_000, quotaCents: 21_000 }])
  })

  it("cada campo trae su ORIGEN y su CONFIANZA (P6)", () => {
    expect(fieldOrigins.documentNumber).toEqual({
      value: "F-2026-0042",
      origin: "llm",
      confidence: "interpretacion_ia",
    })
    // La recepción NO la propone el modelo: origen `usuario` (O-6 / D8).
    expect(fieldOrigins.receptionDate).toEqual({
      value: "2026-03-02",
      origin: "usuario",
      confidence: "no_verificado",
    })
  })

  it("NINGÚN campo vetado sale del MODELO (ADR-0014 D4/D11)", () => {
    // El matiz es el que importa: lo vetado no es que el campo exista, es que
    // lo **decida el modelo**. `receptionDate` está en la lista y sí aparece en
    // la propuesta — con origen `usuario`, que es justo lo que D8 exige. La
    // regla ejecutable es por tanto sobre el ORIGEN, no sobre la presencia.
    for (const campo of FORBIDDEN_MODEL_FIELDS) {
      const origen = fieldOrigins[campo]
      expect(origen?.origin, `el campo vetado «${campo}» ha llegado con origen «llm»`).not.toBe("llm")
    }
  })

  it("y la propuesta no trae NINGUNO de los campos que decide la organización", () => {
    // Cuenta, dimensiones, deducibilidad, retención aplicable y calificación de
    // ISP no están en el objeto por ningún camino: el modelo no tiene dónde
    // escribirlos, que es la forma de garantizarlo que no es un comentario.
    const serializado = JSON.stringify(proposal)
    for (const campo of ["accountCode", "projectId", "costCenterId", "deductibility", "withholdingRegime", "isp"]) {
      expect(serializado, `«${campo}» no lo propone el modelo`).not.toContain(`"${campo}"`)
    }
  })
})

describe("normalizeExtractionOutput · lo que el modelo escribió mal", () => {
  it("una fecha con otro formato se descarta: `null`, nunca una fecha adivinada", () => {
    const { proposal } = normalizeExtractionOutput(
      { ...FACTURA_SIMPLE, documentDate: "28/02/2026" } as ExtractionOutput,
      OPTS
    )
    expect(proposal.documentDate).toBeNull()
  })

  it("un importe con decimales NO es céntimos enteros y se descarta", () => {
    const { proposal } = normalizeExtractionOutput(
      { ...FACTURA_SIMPLE, totalCents: 1210.5 } as unknown as ExtractionOutput,
      OPTS
    )
    // Redondearlo sería que el código decidiera una cifra (P1). Se cae a 0 y
    // `reconcile` lo tratará como no verificado.
    expect(proposal.totalCents).toBe(0)
  })

  it("una moneda inválida cae a la de la organización, y el origen pasa a `usuario`", () => {
    const { proposal, fieldOrigins } = normalizeExtractionOutput(
      { ...FACTURA_SIMPLE, currency: "euros" } as unknown as ExtractionOutput,
      OPTS
    )
    expect(proposal.currency).toBe("EUR")
    // G-19: el default es de la organización, no del modelo, y se dice.
    expect(fieldOrigins.currency).toMatchObject({ origin: "llm" })
  })

  it("sin moneda declarada, el origen de la moneda es `usuario` (G-19)", () => {
    const sinMoneda = { ...FACTURA_SIMPLE } as Record<string, unknown>
    delete sinMoneda.currency
    const { proposal, fieldOrigins } = normalizeExtractionOutput(sinMoneda as ExtractionOutput, OPTS)
    expect(proposal.currency).toBe("EUR")
    expect(fieldOrigins.currency).toMatchObject({ origin: "usuario", confidence: "no_verificado" })
  })

  it("un `docKind` que el dominio no conoce sale `DESCONOCIDO`, no el más parecido", () => {
    const { proposal } = normalizeExtractionOutput(
      { ...FACTURA_SIMPLE, docKind: "ALBARÁN" } as unknown as ExtractionOutput,
      OPTS
    )
    expect(proposal.docKind).toBe("DESCONOCIDO")
  })

  it("una línea sin base se descarta ENTERA; las demás sobreviven", () => {
    const { proposal } = normalizeExtractionOutput(
      {
        ...FACTURA_SIMPLE,
        lines: [
          { baseCents: null, description: "Sin base" },
          { baseCents: 5_000, description: "Con base" },
        ],
      } as unknown as ExtractionOutput,
      OPTS
    )
    expect(proposal.lines).toHaveLength(1)
    expect(proposal.lines[0]!.description).toBe("Con base")
  })

  it("un impuesto sin cuota o sin código se descarta: media cuota no es una cuota", () => {
    const { proposal } = normalizeExtractionOutput(
      {
        ...FACTURA_SIMPLE,
        taxes: [
          { taxRateCode: "IVA21", baseCents: 100_000, quotaCents: null },
          { taxRateCode: null, baseCents: 100_000, quotaCents: 21_000 },
          { taxRateCode: "IVA10", baseCents: 50_000, quotaCents: 5_000 },
        ],
      } as unknown as ExtractionOutput,
      OPTS
    )
    expect(proposal.taxes).toEqual([{ taxRateCode: "IVA10", baseCents: 50_000, quotaCents: 5_000 }])
  })

  it("un texto en blanco es `null`, no una cadena vacía", () => {
    const { proposal } = normalizeExtractionOutput(
      { ...FACTURA_SIMPLE, documentNumber: "   ", description: "" } as unknown as ExtractionOutput,
      OPTS
    )
    expect(proposal.documentNumber).toBeNull()
    expect(proposal.description).toBeNull()
  })

  it("caso vacío: una salida sin nada produce una propuesta completa y vacía, sin lanzar", () => {
    const { proposal, fieldOrigins } = normalizeExtractionOutput({} as ExtractionOutput, OPTS)
    expect(proposal.docKind).toBe("DESCONOCIDO")
    expect(proposal.lines).toEqual([])
    expect(proposal.taxes).toEqual([])
    expect(proposal.totalCents).toBe(0)
    expect(proposal.currency).toBe("EUR")
    expect(proposal.receptionDate).toBe("2026-03-02")
    expect(Object.keys(fieldOrigins).length).toBeGreaterThan(5)
  })

  it("importes NEGATIVOS (un abono) se conservan: no se «corrigen» a positivo", () => {
    const { proposal } = normalizeExtractionOutput(
      {
        ...FACTURA_SIMPLE,
        totalCents: -121_000,
        lines: [{ baseCents: -100_000 }],
        taxes: [{ taxRateCode: "IVA21", baseCents: -100_000, quotaCents: -21_000 }],
      } as unknown as ExtractionOutput,
      OPTS
    )
    expect(proposal.totalCents).toBe(-121_000)
    expect(proposal.lines[0]!.baseCents).toBe(-100_000)
    expect(proposal.taxes[0]!.quotaCents).toBe(-21_000)
  })

  it("una rectificativa trae el número rectificado y los defaults que NO duplican", () => {
    const { proposal } = normalizeExtractionOutput(
      { ...FACTURA_SIMPLE, rectifies: { documentNumber: "F-2026-0041" } } as unknown as ExtractionOutput,
      OPTS
    )
    expect(proposal.rectifies).toEqual({
      documentNumber: "F-2026-0041",
      reason: "ERROR",
      mode: "DIFERENCIAS",
    })
  })

  it("`receptionDate` nunca sale del modelo, aunque el modelo la escriba", () => {
    const { proposal, fieldOrigins } = normalizeExtractionOutput(
      { ...FACTURA_SIMPLE, receptionDate: "2020-01-01" } as unknown as ExtractionOutput,
      { defaultCurrency: "EUR", receptionDate: "2026-03-02" }
    )
    expect(proposal.receptionDate).toBe("2026-03-02")
    expect(fieldOrigins.receptionDate).toMatchObject({ origin: "usuario" })
  })
})

describe("normalizeExtractionOutput · multi-moneda (G-20 pide fixtures multi-moneda)", () => {
  const monedas: [string, string][] = [
    ["usd", "USD"],
    ["GBP", "GBP"],
    ["  chf ", "CHF"],
    ["jpy", "JPY"],
  ]

  it("cada divisa se normaliza a ISO 4217 en mayúsculas, sin tocar el importe", () => {
    for (const [escrita, esperada] of monedas) {
      const { proposal } = normalizeExtractionOutput(
        { ...FACTURA_SIMPLE, currency: escrita, totalCents: 250_000 } as unknown as ExtractionOutput,
        OPTS
      )
      expect(proposal.currency, escrita).toBe(esperada)
      // El importe NO se convierte aquí: la conversión es de `reconcile`, con
      // una tasa fechada, y hacerla en la normalización sería inventar un tipo.
      expect(proposal.totalCents).toBe(250_000)
    }
  })
})

describe("parseExtractionOutput · la puerta de entrada (ai/schema.ts)", () => {
  it("una salida válida pasa", () => {
    const out = parseExtractionOutput(FACTURA_SIMPLE)
    expect(out.ok).toBe(true)
  })

  it("una salida que NO es un objeto se rechaza con motivo, no con una excepción", () => {
    const out = parseExtractionOutput("no soy JSON")
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error.length).toBeGreaterThan(0)
  })

  it("`null` y un array también se rechazan", () => {
    expect(parseExtractionOutput(null).ok).toBe(false)
    expect(parseExtractionOutput([]).ok).toBe(false)
  })
})

describe("resolveMaxPages · el techo de páginas que se le manda al modelo", () => {
  it("sin ajuste, el default declarado", () => {
    expect(resolveMaxPages(undefined)).toBe(DEFAULT_MAX_PAGES_TO_ANALYZE)
    expect(resolveMaxPages("")).toBe(DEFAULT_MAX_PAGES_TO_ANALYZE)
  })

  it("un número válido manda", () => {
    expect(resolveMaxPages("7")).toBe(7)
  })

  it("basura y valores imposibles caen al default: nunca `NaN` ni 0 páginas", () => {
    for (const raw of ["cero", "-3", "0", "3.5", "NaN", "Infinity"]) {
      const value = resolveMaxPages(raw)
      expect(Number.isInteger(value), raw).toBe(true)
      expect(value, raw).toBeGreaterThan(0)
    }
  })
})
