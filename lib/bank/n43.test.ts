/**
 * E7 · T7 — La Norma 43, con los tres errores silenciosos del riesgo R9 puestos
 * a prueba: el signo, la ventana de siglo y el desbordamiento (criterio 21).
 */

import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { CENTURY_WINDOW, currencyOf, parseN43, parseN43Amount, parseN43Date } from "@/lib/bank/n43"

const fixture = (name: string): string =>
  readFileSync(path.resolve(process.cwd(), "tests/fixtures/bank", name), "utf8")

describe("parseN43Date · ventana de siglo (O-14)", () => {
  it("00–79 va a 20xx y 80–99 a 19xx", () => {
    expect(CENTURY_WINDOW).toBe(80)
    expect(parseN43Date("260105")).toBe("2026-01-05")
    expect(parseN43Date("790101")).toBe("2079-01-01")
    expect(parseN43Date("800101")).toBe("1980-01-01")
    expect(parseN43Date("981231")).toBe("1998-12-31")
  })

  it("rechaza fechas imposibles en vez de interpretarlas", () => {
    expect(parseN43Date("260230")).toBeNull()
    expect(parseN43Date("261301")).toBeNull()
    expect(parseN43Date("26010")).toBeNull()
    expect(parseN43Date("2601AA")).toBeNull()
  })

  it("29 de febrero: 2024 sí, 2026 no", () => {
    expect(parseN43Date("240229")).toBe("2024-02-29")
    expect(parseN43Date("260229")).toBeNull()
  })
})

describe("parseN43Amount · tabla de signos y desbordamiento (O-14)", () => {
  it("1 = cargo (negativo) y 2 = abono (positivo)", () => {
    expect(parseN43Amount("00000000012345", "1")).toEqual({ cents: -12345 })
    expect(parseN43Amount("00000000012345", "2")).toEqual({ cents: 12345 })
  })

  it("el importe 0 es válido: el banco lo declara y no se rechaza (m2)", () => {
    expect(parseN43Amount("00000000000000", "1")).toEqual({ cents: 0 })
  })

  it("un campo de 14 dígitos cabe siempre: la guarda es sobre el valor, no sobre el ancho", () => {
    expect(parseN43Amount("99999999999999", "2")).toEqual({ cents: 99999999999999 })
  })

  it("por encima de 2^53−1 céntimos se rechaza, nunca se trunca", () => {
    const result = parseN43Amount("999999999999999999", "2")
    expect("error" in result).toBe(true)
    expect("error" in result && result.error).toContain("desborda")
  })
})

describe("currencyOf", () => {
  it("traduce el ISO 4217 numérico y acepta el alfabético", () => {
    expect(currencyOf("978")).toBe("EUR")
    expect(currencyOf("840")).toBe("USD")
    expect(currencyOf("USD")).toBe("USD")
    expect(currencyOf("999")).toBeNull()
  })
})

describe("parseN43 · fixture con cargo, abono, apunte de 0,00 € y descubierto", () => {
  const result = parseN43(fixture("extracto-descubierto.n43"))

  it("no produce errores y lee los cinco movimientos", () => {
    expect(result.errors).toEqual([])
    expect(result.statement).not.toBeNull()
    expect(result.lines).toHaveLength(5)
    expect(result.statement?.lineCount).toBe(5)
  })

  it("**el signo**: el cargo es negativo y el abono positivo (aserción explícita)", () => {
    const cargo = result.lines[0]
    const abono = result.lines[1]
    expect(cargo?.amountCents).toBe(-16000000)
    expect(cargo?.amountCents).toBeLessThan(0)
    expect(abono?.amountCents).toBe(2000000)
    expect(abono?.amountCents).toBeGreaterThan(0)
  })

  it("la fecha de operación es la 11–16 y la fecha valor la 17–22, no al revés", () => {
    expect(result.lines[0]?.operationDate).toBe("2026-01-05")
    expect(result.lines[0]?.valueDate).toBe("2026-01-07")
  })

  it("saldo final negativo (descubierto) declarado por el banco", () => {
    expect(result.statement?.openingBalanceCents).toBe(10000000)
    expect(result.statement?.closingBalanceCents).toBe(-1000000)
  })

  it("el extracto cuadra consigo mismo: opening + Σ = closing (I-E7-6a)", () => {
    const total = result.lines.reduce((acc, l) => acc + l.amountCents, 0)
    expect((result.statement?.openingBalanceCents ?? 0) + total).toBe(result.statement?.closingBalanceCents)
  })

  it("coteja el número de apuntes con el registro 33", () => {
    expect(result.statement?.declaredLineCount).toBe(5)
    expect(result.statement?.declaredLineCount).toBe(result.lines.length)
  })

  it("el apunte de 0,00 € se importa y nace IGNORED con IMPORTE_CERO (m2)", () => {
    const cero = result.lines.find((l) => l.amountCents === 0)
    expect(cero?.status).toBe("IGNORED")
    expect(cero?.ignoreReason).toBe("IMPORTE_CERO")
    expect(result.lines.map((l) => l.lineNo)).toEqual([1, 2, 3, 4, 5])
  })

  it("guarda las DOS referencias por separado; la 1 es la de la remesa (O-15)", () => {
    expect(result.lines[1]?.reference1).toBe("REM000000001")
    expect(result.lines[1]?.reference2).toBe("ABONO REMESA")
    expect(result.lines[0]?.reference1).toBeNull()
    expect(result.lines[0]?.reference2).toBe("FRA 2026-000123")
  })

  it("concatena el registro 23 en la descripción y guarda los dos conceptos", () => {
    expect(result.lines[0]?.description).toContain("PAGO PROVEEDOR SUMINISTROS DEL NORTE")
    expect(result.lines[0]?.conceptCommon).toBe("03")
    expect(result.lines[0]?.conceptOwn).toBe("001")
  })

  it("el registro 24 aporta divisa e importe original, que la ronda 1 perdía (O-5)", () => {
    const exportacion = result.lines[4]
    expect(exportacion?.originalCurrency).toBe("USD")
    expect(exportacion?.originalAmountCents).toBe(1150000)
  })

  it("dos movimientos idénticos el mismo día se importan LOS DOS (criterio 8)", () => {
    const remesas = result.lines.filter((l) => l.reference1 === "REM000000001")
    expect(remesas).toHaveLength(2)
    expect(remesas[0]?.sha256).not.toBe(remesas[1]?.sha256)
    expect(remesas.map((l) => l.dayOrdinal)).toEqual([1, 2])
  })

  it("es reproducible byte a byte: dos parseos dan los mismos sha256", () => {
    const again = parseN43(fixture("extracto-descubierto.n43"))
    expect(again.lines.map((l) => l.sha256)).toEqual(result.lines.map((l) => l.sha256))
  })
})

describe("parseN43 · casos adversariales", () => {
  it("el extracto de 1998 se parsea como 1998, no como 2098", () => {
    const result = parseN43(fixture("extracto-1998.n43"))
    expect(result.errors).toEqual([])
    expect(result.statement?.periodStart).toBe("1998-12-01")
    expect(result.lines[0]?.operationDate).toBe("1998-12-31")
  })

  it("un acumulado que desborda rechaza el FICHERO ENTERO, nunca lo trunca", () => {
    const result = parseN43(fixture("extracto-desbordamiento.n43"))
    expect(result.statement).toBeNull()
    expect(result.lines).toEqual([])
    expect(result.errors[0]?.message).toContain("desborda")
    expect(result.errors[0]?.lineNo).toBe(0)
  })

  it("un indicador debe/haber que no es 1 ni 2 rechaza el fichero", () => {
    const bad = fixture("extracto-descubierto.n43").split("\n")
    const line = bad[1] as string
    bad[1] = `${line.slice(0, 27)}9${line.slice(28)}`
    const result = parseN43(bad.join("\n"))
    expect(result.statement).toBeNull()
    expect(result.errors.some((e) => e.message.includes("1 = cargo, 2 = abono"))).toBe(true)
  })

  it("sin registro 33 ni 88 el fichero no se importa a medias", () => {
    const rows = fixture("extracto-descubierto.n43").split("\n").filter((r) => !r.startsWith("33") && !r.startsWith("88"))
    const result = parseN43(rows.join("\n"))
    expect(result.statement).toBeNull()
    expect(result.errors.map((e) => e.message).join(" ")).toContain("registro 33")
  })

  it("un fichero vacío no produce un extracto vacío: produce errores", () => {
    const result = parseN43("")
    expect(result.statement).toBeNull()
    expect(result.errors).toHaveLength(3)
  })

  it("un registro desconocido se nombra con su línea", () => {
    const rows = fixture("extracto-descubierto.n43").split("\n")
    rows.splice(1, 0, "44".padEnd(80, " "))
    const result = parseN43(rows.join("\n"))
    expect(result.errors.some((e) => e.lineNo === 2 && e.message.includes("registro desconocido"))).toBe(true)
  })
})
