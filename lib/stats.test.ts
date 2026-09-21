/**
 * E12 · T18 — **G-20**: golden tests de `lib/stats.ts`.
 *
 * `docs/AUDITORIA-FIABILIDAD.md` G-20 («sin tests de `models/stats.ts`,
 * `lib/stats.ts`, `ai/*`») y §6 deuda 9 de `docs/design/E12-fiabilidad-dod.md`.
 *
 * ## Por qué este fichero importa más de lo que parece
 *
 * Estas dos sumas por moneda son **la única cifra del producto que no sale del
 * libro diario**: agregan `Transaction.total`, que es lo que el OCR extrajo de
 * un documento todavía sin contabilizar. **G-05** fue exactamente esto a escala
 * de panel: totales que no cuadraban con el balance y nadie sabía por qué. E6
 * retiró `models/stats.ts` y acotó éstas al pie de la pantalla de documentos,
 * con su badge de «no verificado».
 *
 * Lo que no se hizo entonces —y es lo que G-20 reclama— fue **probarlas**. Una
 * función sin tests que produce cifras es una cifra sin dueño, y ésta se pinta
 * al lado de cifras contables.
 *
 * ## Qué se exige aquí
 *
 *  1. **Multi-moneda**: cada moneda en su cubo, la convertida manda sobre la
 *     original, y el código se normaliza a mayúsculas.
 *  2. **`NaN` imposible** (el corazón de G-05): con `null`, `undefined`, texto,
 *     `NaN` o `Infinity` en cualquier campo, **ninguna salida es `NaN`** y
 *     ninguna es `Infinity`. Un total `NaN` en pantalla es peor que no tener
 *     total: se lee como una cifra rota, no como una cifra ausente.
 *  3. **Los cinco casos límite** que `dev-backend` exige: vacío, un registro,
 *     importes negativos, ceros y la mezcla de los tres.
 *
 * Las cifras esperadas son literales escritos a mano. Ninguna sale de llamar a
 * la función que se prueba (regla 7 de §7.3).
 */

import { describe, expect, it } from "vitest"

import {
  UNPOSTED_TOTALS_NOTE,
  calcNetTotalPerCurrency,
  calcTotalPerCurrency,
  incompleteTransactionFields,
  isTransactionIncomplete,
} from "@/lib/stats"
import type { Field, Transaction } from "@/prisma/client"

/**
 * Una `Transaction` mínima. El tipo de Prisma tiene decenas de columnas que
 * estas funciones no miran; construirlas todas sería ruido, así que se
 * completan con un cast acotado y cada test declara lo que de verdad importa.
 */
const tx = (over: Partial<Transaction>): Transaction =>
  ({
    id: "t",
    type: "income",
    total: 0,
    currencyCode: "EUR",
    convertedTotal: null,
    convertedCurrencyCode: null,
    extra: null,
    ...over,
  }) as Transaction

const field = (over: Partial<Field>): Field =>
  ({ code: "total", name: "Total", isRequired: true, isExtra: false, ...over }) as Field

describe("calcTotalPerCurrency — multi-moneda", () => {
  it("caso vacío: un objeto vacío, no un cero con moneda inventada", () => {
    expect(calcTotalPerCurrency([])).toEqual({})
  })

  it("un solo registro", () => {
    expect(calcTotalPerCurrency([tx({ total: 12_345, currencyCode: "EUR" })])).toEqual({ EUR: 12_345 })
  })

  it("cada moneda va a su cubo y NO se mezclan", () => {
    const out = calcTotalPerCurrency([
      tx({ total: 10_000, currencyCode: "EUR" }),
      tx({ total: 25_000, currencyCode: "USD" }),
      tx({ total: 5_000, currencyCode: "EUR" }),
      tx({ total: 300, currencyCode: "GBP" }),
    ])
    expect(out).toEqual({ EUR: 15_000, USD: 25_000, GBP: 300 })
  })

  it("el código de moneda se normaliza a mayúsculas: `eur` y `EUR` son la misma", () => {
    expect(
      calcTotalPerCurrency([tx({ total: 100, currencyCode: "eur" }), tx({ total: 200, currencyCode: "EUR" })])
    ).toEqual({ EUR: 300 })
  })

  it("la moneda CONVERTIDA manda sobre la original", () => {
    const out = calcTotalPerCurrency([
      tx({ total: 10_000, currencyCode: "USD", convertedTotal: 9_100, convertedCurrencyCode: "EUR" }),
    ])
    expect(out).toEqual({ EUR: 9_100 })
    expect(out.USD).toBeUndefined()
  })

  it("importes negativos suman con su signo", () => {
    expect(
      calcTotalPerCurrency([tx({ total: 10_000, currencyCode: "EUR" }), tx({ total: -3_000, currencyCode: "EUR" })])
    ).toEqual({ EUR: 7_000 })
  })

  it("sin moneda declarada, la fila NO entra: no se le asigna una por defecto", () => {
    expect(calcTotalPerCurrency([tx({ total: 999, currencyCode: null })])).toEqual({})
  })
})

describe("calcNetTotalPerCurrency — el neto, con el signo del tipo", () => {
  it("caso vacío", () => {
    expect(calcNetTotalPerCurrency([])).toEqual({})
  })

  it("un gasto resta y un ingreso suma", () => {
    expect(
      calcNetTotalPerCurrency([
        tx({ type: "income", total: 10_000, currencyCode: "EUR" }),
        tx({ type: "expense", total: 4_000, currencyCode: "EUR" }),
      ])
    ).toEqual({ EUR: 6_000 })
  })

  it("un importe 0 no crea la moneda: un cubo a cero afirmaría que hubo movimiento", () => {
    expect(calcNetTotalPerCurrency([tx({ total: 0, currencyCode: "CHF" })])).toEqual({})
  })

  it("multi-moneda con gastos e ingresos mezclados", () => {
    expect(
      calcNetTotalPerCurrency([
        tx({ type: "income", total: 50_000, currencyCode: "EUR" }),
        tx({ type: "expense", total: 12_500, currencyCode: "EUR" }),
        tx({ type: "expense", total: 8_000, currencyCode: "USD" }),
        tx({ type: "income", total: 1_000, currencyCode: "usd" }),
      ])
    ).toEqual({ EUR: 37_500, USD: -7_000 })
  })

  it("la conversión manda, y el signo se aplica DESPUÉS de convertir", () => {
    expect(
      calcNetTotalPerCurrency([
        tx({ type: "expense", total: 10_000, currencyCode: "USD", convertedTotal: 9_100, convertedCurrencyCode: "EUR" }),
      ])
    ).toEqual({ EUR: -9_100 })
  })
})

/**
 * **El corazón de G-05.** La cifra que rompió el panel no fue una suma mal
 * hecha: fue un `NaN` que se pintó como si fuera un número. Aquí se le dan a
 * las dos funciones todas las formas de basura que una fila de OCR puede
 * traer, y se exige que **ninguna salida sea `NaN` ni `Infinity`**.
 */
describe("G-05 · ninguna salida puede ser NaN ni Infinity", () => {
  const basura: Partial<Transaction>[] = [
    { total: null as unknown as number, currencyCode: "EUR" },
    { total: undefined as unknown as number, currencyCode: "EUR" },
    { total: NaN, currencyCode: "EUR" },
    { total: Infinity, currencyCode: "EUR" },
    { total: -Infinity, currencyCode: "EUR" },
    { total: "1234" as unknown as number, currencyCode: "EUR" },
    { total: 1_000, currencyCode: "" },
    { total: 1_000, currencyCode: null },
    { total: 1_000, currencyCode: "EUR", convertedTotal: NaN, convertedCurrencyCode: "USD" },
    { total: 1_000, currencyCode: "EUR", convertedTotal: null, convertedCurrencyCode: "USD" },
  ]

  const sano = tx({ total: 5_000, currencyCode: "EUR" })

  it("`calcTotalPerCurrency` nunca devuelve NaN ni Infinity, fila a fila", () => {
    for (const parcial of basura) {
      const out = calcTotalPerCurrency([tx(parcial), sano])
      for (const [moneda, valor] of Object.entries(out)) {
        expect(Number.isNaN(valor), `${moneda} salió NaN con ${JSON.stringify(parcial)}`).toBe(false)
        expect(Number.isFinite(valor), `${moneda} salió infinito con ${JSON.stringify(parcial)}`).toBe(true)
      }
    }
  })

  it("`calcNetTotalPerCurrency` tampoco", () => {
    for (const parcial of basura) {
      const out = calcNetTotalPerCurrency([tx(parcial), sano])
      for (const [moneda, valor] of Object.entries(out)) {
        expect(Number.isNaN(valor), `${moneda} salió NaN con ${JSON.stringify(parcial)}`).toBe(false)
        expect(Number.isFinite(valor), `${moneda} salió infinito con ${JSON.stringify(parcial)}`).toBe(true)
      }
    }
  })

  it("y con TODA la basura junta, la fila sana sigue diciendo su cifra exacta", () => {
    // Es la prueba de que las filas rotas no contaminan a las buenas: una
    // basura que arrastrara el cubo entero a `NaN` sería G-05 otra vez.
    const out = calcTotalPerCurrency([...basura.map(tx), sano])
    expect(out.EUR).toBe(5_000 + 1_000 + 1_000)
    expect(Number.isNaN(out.EUR)).toBe(false)
  })
})

describe("La leyenda obligatoria acompaña a la cifra (G-05, E6 §4)", () => {
  it("existe, dice que NO es contable y remite a Informes", () => {
    expect(UNPOSTED_TOTALS_NOTE).toContain("no contables")
    expect(UNPOSTED_TOTALS_NOTE).toContain("Informes")
  })
})

describe("`models/stats.ts` NO existe, y no puede volver", () => {
  it("el módulo retirado en E6 sigue retirado", async () => {
    // Los agregados de panel de `models/stats.ts` producían totales que no
    // cuadraban con el balance (G-05) y E6 los retiró. Este test es lo que
    // convierte esa decisión en algo que un refactor no puede deshacer en
    // silencio: si el fichero vuelve, la suite lo dice.
    const { existsSync } = await import("node:fs")
    const path = await import("node:path")
    expect(
      existsSync(path.join(process.cwd(), "models", "stats.ts")),
      "`models/stats.ts` ha vuelto. Los agregados de panel salen del DIARIO " +
        "(`models/reports.ts`), no de `Transaction`: es G-05 y costó una épica."
    ).toBe(false)
  })
})

describe("isTransactionIncomplete / incompleteTransactionFields", () => {
  it("caso vacío: sin campos requeridos, nada está incompleto", () => {
    expect(isTransactionIncomplete([], tx({}))).toBe(false)
    expect(incompleteTransactionFields([], tx({}))).toEqual([])
  })

  it("un campo requerido vacío lo declara incompleto, y lo NOMBRA", () => {
    const campos = [field({ code: "total" }), field({ code: "currencyCode" })]
    const incompletos = incompleteTransactionFields(campos, tx({ total: null as unknown as number }))
    expect(incompletos.map((f) => f.code)).toEqual(["total"])
    expect(isTransactionIncomplete(campos, tx({ total: null as unknown as number }))).toBe(true)
  })

  it("los campos NO requeridos no cuentan", () => {
    const campos = [field({ code: "total", isRequired: false })]
    expect(isTransactionIncomplete(campos, tx({ total: null as unknown as number }))).toBe(false)
  })

  it("un campo extra se busca dentro de `extra`", () => {
    const campos = [field({ code: "obra", isExtra: true })]
    expect(isTransactionIncomplete(campos, tx({ extra: {} }))).toBe(true)
    expect(isTransactionIncomplete(campos, tx({ extra: { obra: "OB-1" } }))).toBe(false)
  })

  it("la cadena vacía cuenta como ausente; el CERO, no", () => {
    // Un total de 0 € es una cifra declarada, no un hueco. Tratarlo como
    // ausente obligaría a teclear un importe falso para poder guardar.
    const campos = [field({ code: "total" })]
    expect(isTransactionIncomplete(campos, tx({ total: 0 }))).toBe(false)
    expect(isTransactionIncomplete([field({ code: "currencyCode" })], tx({ currencyCode: "" }))).toBe(true)
  })
})
