/**
 * E7 · T7 — CSV con mapeo por banco, sobre los fixtures de **tres bancos** con
 * tres convenciones incompatibles entre sí: importe con signo, columna
 * debe/haber, año de dos dígitos y descripciones entrecomilladas con el propio
 * delimitador dentro.
 */

import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { parseBankCsv, parseMappedAmount, parseMappedDate, splitCsvRow, type CsvMapping } from "@/lib/bank/csv"

const fixture = (name: string): string =>
  readFileSync(path.resolve(process.cwd(), "tests/fixtures/bank", name), "utf8")

const BBVA: CsvMapping = {
  delimiter: ";",
  decimal: ",",
  dateFormat: "DD/MM/YYYY",
  signMode: "SIGNED",
  skipRows: 2,
  defaultCurrency: "EUR",
  columns: {
    operationDate: "Fecha",
    valueDate: "Fecha valor",
    amount: "Importe",
    description: "Concepto",
    currency: "Divisa",
    reference1: "Referencia",
  },
}

const SANTANDER: CsvMapping = {
  delimiter: ",",
  decimal: ".",
  dateFormat: "YYYY-MM-DD",
  signMode: "DEBIT_CREDIT",
  defaultCurrency: "EUR",
  columns: {
    operationDate: "Operation date",
    valueDate: "Value date",
    amount: "Amount",
    sign: "Type",
    description: "Description",
    reference1: "Reference 1",
    reference2: "Reference 2",
  },
}

const CAIXABANK: CsvMapping = {
  delimiter: ";",
  decimal: ",",
  dateFormat: "DD.MM.YY",
  centuryWindow: 80,
  signMode: "SIGNED",
  defaultCurrency: "EUR",
  columns: {
    operationDate: "Fecha operacion",
    valueDate: "Fecha valor",
    amount: "Importe",
    description: "Concepto",
    balance: "Saldo",
    reference1: "Referencia",
  },
}

describe("utilidades", () => {
  it("splitCsvRow respeta las comillas y el delimitador de dentro", () => {
    expect(splitCsvRow('a;"b;c";d', ";")).toEqual(["a", "b;c", "d"])
    expect(splitCsvRow('"con ""comillas""";x', ";")).toEqual(['con "comillas"', "x"])
  })

  it("parseMappedAmount usa el separador DECLARADO, no lo adivina", () => {
    expect(parseMappedAmount("1.234", ",")).toBe(123400)
    expect(parseMappedAmount("1.234,56", ",")).toBe(123456)
    expect(parseMappedAmount("1,234.56", ".")).toBe(123456)
    expect(parseMappedAmount("-160.000,00", ",")).toBe(-16000000)
    expect(parseMappedAmount("", ",")).toBeNull()
  })

  it("parseMappedDate no interpreta un ancho distinto del declarado", () => {
    expect(parseMappedDate("05/01/2026", "DD/MM/YYYY")).toBe("2026-01-05")
    expect(parseMappedDate("5/1/2026", "DD/MM/YYYY")).toBeNull()
    expect(parseMappedDate("05.03.98", "DD.MM.YY")).toBe("1998-03-05")
    expect(parseMappedDate("30/02/2026", "DD/MM/YYYY")).toBeNull()
  })
})

describe("BBVA · importe con signo y dos filas de cortesía", () => {
  const result = parseBankCsv(fixture("bbva.csv"), BBVA)

  it("salta las filas de cabecera y lee los cuatro movimientos", () => {
    expect(result.errors).toEqual([])
    expect(result.lines).toHaveLength(4)
    expect(result.statement?.periodStart).toBe("2026-01-05")
    expect(result.statement?.periodEnd).toBe("2026-01-20")
  })

  it("el signo viene del importe y la fecha valor se guarda aparte", () => {
    expect(result.lines[0]?.amountCents).toBe(-16000000)
    expect(result.lines[0]?.operationDate).toBe("2026-01-05")
    expect(result.lines[0]?.valueDate).toBe("2026-01-07")
  })

  it("el apunte de 0,00 € nace IGNORED con IMPORTE_CERO y no parte el lineNo", () => {
    expect(result.lines[2]?.amountCents).toBe(0)
    expect(result.lines[2]?.status).toBe("IGNORED")
    expect(result.lines[2]?.ignoreReason).toBe("IMPORTE_CERO")
    expect(result.lines.map((l) => l.lineNo)).toEqual([1, 2, 3, 4])
  })

  it("sin columna de reference2 la referencia es null y la agrupación no se ofrece", () => {
    expect(result.lines[1]?.reference1).toBe("REM000000001")
    expect(result.lines[1]?.reference2).toBeNull()
  })
})

describe("Santander · columna debe/haber", () => {
  const result = parseBankCsv(fixture("santander.csv"), SANTANDER)

  it("`D` es cargo (negativo) y `H` abono (positivo)", () => {
    expect(result.errors).toEqual([])
    expect(result.lines.map((l) => l.amountCents)).toEqual([-1234567, 450000, -350])
  })

  it("guarda las dos referencias", () => {
    expect(result.lines[0]?.reference1).toBe("NOM202602")
    expect(result.lines[0]?.reference2).toBe("PAGO NOMINAS")
  })

  it("un indicador desconocido rechaza el fichero entero, no la fila", () => {
    const rows = fixture("santander.csv").split("\n")
    rows[1] = (rows[1] as string).replace(",D,", ",X,")
    const result2 = parseBankCsv(rows.join("\n"), SANTANDER)
    expect(result2.statement).toBeNull()
    expect(result2.lines).toEqual([])
    expect(result2.errors[0]?.message).toContain("indicador debe/haber desconocido")
  })
})

describe("CaixaBank · año de dos dígitos y comillas con delimitador dentro", () => {
  const result = parseBankCsv(fixture("caixabank.csv"), CAIXABANK)

  it("lee la descripción entrecomillada sin partirla por el `;`", () => {
    expect(result.errors).toEqual([])
    expect(result.lines[0]?.description).toBe("PAGO TARJETA; COMERCIO 44")
  })

  it("aplica la ventana de siglo: `98` es 1998", () => {
    expect(result.lines[2]?.operationDate).toBe("1998-03-05")
  })

  it("guarda el saldo declarado por el banco en cada línea", () => {
    expect(result.lines[0]?.balanceCents).toBe(874925)
  })
})

describe("el fichero no se importa a medias", () => {
  it("una columna declarada que la cabecera no trae rechaza el fichero", () => {
    const result = parseBankCsv(fixture("bbva.csv"), {
      ...BBVA,
      columns: { ...BBVA.columns, amount: "Cantidad" },
    })
    expect(result.statement).toBeNull()
    expect(result.errors[0]?.message).toContain("Cantidad")
  })

  it("una fecha ilegible rechaza el fichero entero con su línea", () => {
    const rows = fixture("bbva.csv").split("\n")
    rows[3] = (rows[3] as string).replace("05/01/2026", "5-1-26")
    const result = parseBankCsv(rows.join("\n"), BBVA)
    expect(result.statement).toBeNull()
    expect(result.errors[0]?.lineNo).toBe(4)
  })

  it("un extracto que mezcla divisas se rechaza entero (O-5)", () => {
    const rows = fixture("bbva.csv").split("\n")
    rows[4] = (rows[4] as string).replace(";EUR;", ";USD;")
    const result = parseBankCsv(rows.join("\n"), BBVA)
    expect(result.statement).toBeNull()
    expect(result.errors[0]?.message).toContain("mezcla divisas")
  })

  it("un fichero sin movimientos no produce un extracto vacío", () => {
    const result = parseBankCsv(fixture("bbva.csv").split("\n").slice(0, 3).join("\n"), BBVA)
    expect(result.statement).toBeNull()
    expect(result.errors[0]?.message).toContain("ningún movimiento")
  })
})
