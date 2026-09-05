/**
 * E6 · T5 — Árbol de epígrafes: orden oficial, agregación de padres y celdas
 * vacías. El orden es lo que más fácil se rompe y lo que un asesor detecta en el
 * primer vistazo.
 */

import { describe, expect, it } from "vitest"

import {
  buildEpigraphTree,
  comparePaths,
  deltaBps,
  nest,
  segmentKey,
  segmentOrder,
  splitEpigraph,
  UNORDERED_SEGMENT,
} from "@/lib/ledger/reports/epigraphs-tree"

describe("splitEpigraph", () => {
  it("parte por ` / ` y descarta segmentos vacíos", () => {
    expect(splitEpigraph("A) Activo no corriente / II. Inmovilizado material")).toEqual([
      "A) Activo no corriente",
      "II. Inmovilizado material",
    ])
    expect(splitEpigraph("")).toEqual([])
    expect(splitEpigraph("  A)  /  / B) ")).toEqual(["A)", "B)"])
  })
})

describe("segmentOrder", () => {
  it("reconoce las cuatro familias del modelo oficial", () => {
    expect(segmentOrder("A) Activo no corriente")).toBe(100)
    expect(segmentOrder("A-1) Fondos propios")).toBe(101)
    expect(segmentOrder("B) Activo corriente")).toBe(200)
    expect(segmentOrder("IV. Inversiones")).toBe(4)
    expect(segmentOrder("10. Excesos de provisiones")).toBe(10)
    expect(segmentOrder("b) Prestaciones de servicios")).toBe(2)
  })

  it("un segmento sin prefijo va al final, de forma determinista", () => {
    expect(segmentOrder("Total")).toBe(UNORDERED_SEGMENT)
  })

  it("`A)` precede a `A-1)` y ambos a `B)`", () => {
    expect(segmentKey("A)").index).toBeLessThan(segmentKey("A-1)").index)
    expect(segmentKey("A-1)").index).toBeLessThan(segmentKey("B)").index)
  })
})

describe("comparePaths — el orden NO es lexicográfico", () => {
  it("`X.` va después de `IX.`, no antes", () => {
    // Ordenando cadenas, "IX." < "X." es cierto por casualidad; el caso que lo
    // delata es "IV." vs "IX.", donde el romano manda y la cadena no.
    expect(comparePaths("IX. Uno", "X. Dos")).toBeLessThan(0)
    expect(comparePaths("IV. Uno", "IX. Dos")).toBeLessThan(0)
    expect(comparePaths("VII. Uno", "IX. Dos")).toBeLessThan(0)
  })

  it("`10.` va después de `9.`, no antes", () => {
    expect(comparePaths("9. Nueve", "10. Diez")).toBeLessThan(0)
    // Lexicográficamente "10." < "9.", que es exactamente el bug.
    expect("10. Diez" < "9. Nueve").toBe(true)
  })

  it("ordena por segmento, de izquierda a derecha", () => {
    const paths = [
      "B) Activo corriente / III. Deudores",
      "A) Activo no corriente / II. Inmovilizado material",
      "B) Activo corriente / II. Existencias",
    ]
    expect([...paths].sort(comparePaths)).toEqual([
      "A) Activo no corriente / II. Inmovilizado material",
      "B) Activo corriente / II. Existencias",
      "B) Activo corriente / III. Deudores",
    ])
  })

  it("el padre precede a su hijo", () => {
    expect(comparePaths("A) Activo", "A) Activo / I. Algo")).toBeLessThan(0)
  })
})

describe("buildEpigraphTree", () => {
  it("el padre es la SUMA de sus hijos y se materializa aunque no sea hoja", () => {
    const rows = buildEpigraphTree([
      { path: "A) Activo / I. Uno", cents: 100, accountCodes: ["200"] },
      { path: "A) Activo / II. Dos", cents: 250, accountCodes: ["210"] },
    ])
    expect(rows.map((r) => [r.path, r.cents, r.isLeaf])).toEqual([
      ["A) Activo", 350, false],
      ["A) Activo / I. Uno", 100, true],
      ["A) Activo / II. Dos", 250, true],
    ])
    expect(rows[0].accountCodes).toEqual(["200", "210"])
    expect(rows[0].depth).toBe(1)
    expect(rows[1].depth).toBe(2)
  })

  it("los epígrafes vacíos NO se imprimen", () => {
    // Nada alimenta "B)", así que "B)" no existe en el árbol. Un modelo oficial
    // con las veinte líneas a cero es ruido en pantalla y en el PDF.
    const rows = buildEpigraphTree([{ path: "A) Activo / I. Uno", cents: 100, accountCodes: ["200"] }])
    expect(rows.some((r) => r.path.startsWith("B)"))).toBe(false)
  })

  it("una celda sólo se marca `(−)` si TODAS sus cuentas son contra-cuentas", () => {
    const rows = buildEpigraphTree([
      { path: "A) / I.", cents: -300, accountCodes: ["2816"], isContraCell: true },
      { path: "A) / II.", cents: 100, accountCodes: ["216"], isContraCell: false },
    ])
    expect(rows.find((r) => r.path === "A) / I.")?.isContraCell).toBe(true)
    expect(rows.find((r) => r.path === "A) / II.")?.isContraCell).toBe(false)
    // El padre mezcla las dos: no es una contra-partida.
    expect(rows.find((r) => r.path === "A)")?.isContraCell).toBe(false)
  })

  it("acumula varias cuentas sobre el mismo epígrafe hoja", () => {
    const rows = buildEpigraphTree([
      { path: "A) / I.", cents: 100, accountCodes: ["216"] },
      { path: "A) / I.", cents: -300, accountCodes: ["2816"] },
    ])
    expect(rows.find((r) => r.path === "A) / I.")?.cents).toBe(-200)
  })

  it("entrada vacía → árbol vacío, no error", () => {
    expect(buildEpigraphTree([])).toEqual([])
  })

  it("comparativo: `previousCents`, `deltaCents` y `deltaBps` enteros", () => {
    const rows = buildEpigraphTree([{ path: "A) / I.", cents: 1_200_000, accountCodes: ["705"] }], {
      previousByPath: new Map([["A) / I.", 1_000_000]]),
    })
    const row = rows.find((r) => r.path === "A) / I.")!
    expect(row.previousCents).toBe(1_000_000)
    expect(row.deltaCents).toBe(200_000)
    expect(row.deltaBps).toBe(2000) // +20 %
    expect(Number.isInteger(row.deltaBps)).toBe(true)
  })

  it("sin comparativo, los tres campos quedan `undefined` — NO a cero", () => {
    // Un 0 es una cifra y afirmaría algo falso: «el año pasado fue cero».
    const row = buildEpigraphTree([{ path: "A) / I.", cents: 100, accountCodes: ["705"] }])[1]
    expect(row.previousCents).toBeUndefined()
    expect(row.deltaCents).toBeUndefined()
    expect(row.deltaBps).toBeUndefined()
  })
})

describe("deltaBps", () => {
  it("base 0 → `null`, nunca Infinity ni NaN (G-05)", () => {
    expect(deltaBps(100, 0)).toBeNull()
    expect(deltaBps(0, 0)).toBeNull()
  })

  it("usa el VALOR ABSOLUTO de la base: caer de −100 a −50 es una mejora del 50 %", () => {
    expect(deltaBps(-50, -100)).toBe(5000)
    expect(deltaBps(-150, -100)).toBe(-5000)
  })

  it("redondea a entero, sin decimales flotantes", () => {
    expect(deltaBps(3, 7)).toBe(Math.round(((3 - 7) * 10_000) / 7))
    expect(Number.isInteger(deltaBps(3, 7))).toBe(true)
  })
})

describe("nest", () => {
  it("cuelga cada fila de su prefijo y deja los raíces arriba", () => {
    const flat = buildEpigraphTree([
      { path: "A) Activo / I. Uno / 1. Detalle", cents: 100, accountCodes: ["200"] },
      { path: "B) Pasivo", cents: 50, accountCodes: ["400"] },
    ])
    const tree = nest(flat)
    expect(tree.map((r) => r.path)).toEqual(["A) Activo", "B) Pasivo"])
    expect(tree[0].children?.[0].path).toBe("A) Activo / I. Uno")
    expect(tree[0].children?.[0].children?.[0].path).toBe("A) Activo / I. Uno / 1. Detalle")
  })
})
