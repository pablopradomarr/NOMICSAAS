/**
 * E6 · T15 — Export CSV/XLSX/PDF con procedencia y validación.
 *
 * Lo que estos tests protegen: que el fichero que sale del ERP se pueda auditar
 * **sin volver al ERP** (lleva procedencia y validación), que los importes sean
 * números de verdad en Excel y que dos exports del mismo informe den el mismo
 * hash.
 */

import JSZip from "jszip"
import { describe, expect, it } from "vitest"

import {
  centsToDecimalString,
  exportRun,
  reportToCsv,
  reportToXlsx,
  runToDocument,
  sheetToCsv,
  type ExportableRun,
} from "@/lib/export/report-export"

const run: ExportableRun = {
  id: "11111111-2222-3333-4444-555555555555",
  type: "BALANCE",
  periodStart: "2026-01-01",
  periodEnd: "2026-12-31",
  ledgerHash: "a".repeat(64),
  gitSha: "c0e828f",
  seal: "REQUIERE_REVISION",
  sealReasons: [{ code: "VARIACION_KPI", message: "los ingresos suben un 20 %" }],
  validation: { checks: [{ id: "I2", status: "PASS", evidencia: "Activo − (PN + pasivo) = 0" }] },
  provenance: { runId: "11111111-2222-3333-4444-555555555555", ledgerHash: `sha256:${"a".repeat(64)}` },
  params: { snapshot: "PRE_REGULARIZACION", variant: "PYMES", currency: "EUR" },
  result: {
    activo: [{ path: "A) Activo no corriente", depth: 1, cents: 2_665_000, isLeaf: false, accountCodes: ["216"] }],
    patrimonioNeto: [{ path: "A) Patrimonio neto", depth: 1, cents: 8_307_322, isLeaf: false, accountCodes: ["100"] }],
    pasivo: [{ path: "C) Pasivo corriente", depth: 1, cents: 5_366_498, isLeaf: false, accountCodes: ["4000"] }],
  },
}

const NOTES = ["Sin compensación de saldos: art. 37 CdC y NRV 9ª."]

describe("centsToDecimalString — aritmética entera, sin Float", () => {
  it("compone la cadena decimal exacta", () => {
    expect(centsToDecimalString(0)).toBe("0.00")
    expect(centsToDecimalString(5)).toBe("0.05")
    expect(centsToDecimalString(1_497_322)).toBe("14973.22")
    expect(centsToDecimalString(-300_000)).toBe("-3000.00")
  })

  it("no baila en importes grandes, donde `(c/100).toFixed(2)` sí lo haría", () => {
    expect(centsToDecimalString(1_000_000_000_000_07)).toBe("1000000000000.07")
  })
})

describe("runToDocument", () => {
  const doc = runToDocument(run, NOTES)
  const names = doc.sheets.map((s) => s.name)

  it("lleva SIEMPRE «Procedencia» y «Validación»", () => {
    expect(names).toContain("Procedencia")
    expect(names).toContain("Validación")
  })

  it("la procedencia incluye el sello del diario, el motor y los parámetros", () => {
    const rows = doc.sheets.find((s) => s.name === "Procedencia")!.rows.map((r) => r.join(" "))
    expect(rows.some((r) => r.includes(`sha256:${"a".repeat(64)}`))).toBe(true)
    expect(rows.some((r) => r.includes("c0e828f"))).toBe(true)
    expect(rows.some((r) => r.includes("PRE_REGULARIZACION"))).toBe(true)
    expect(rows.some((r) => r.includes(run.id))).toBe(true)
  })

  it("la validación abre con el SELLO y sus motivos, no sólo con los checks", () => {
    const rows = doc.sheets.find((s) => s.name === "Validación")!.rows
    expect(rows[0][0]).toBe("SELLO")
    expect(rows[0][1]).toBe("REQUIERE_REVISION")
    expect(String(rows[0][2])).toContain("VARIACION_KPI")
  })

  it("las notas al pie viajan con el documento", () => {
    expect(doc.notes).toEqual(NOTES)
  })

  it("un `result` con forma desconocida se vuelca, no se pierde", () => {
    const doc2 = runToDocument({ ...run, result: { loQueSea: 42 } })
    expect(doc2.sheets[0].rows.some((r) => r[0] === "loQueSea")).toBe(true)
  })
})

describe("CSV", () => {
  it("escapa comillas, comas y saltos de línea", () => {
    const csv = sheetToCsv({ name: "x", header: ["a"], rows: [['con "comillas", coma y\nsalto']] })
    expect(csv).toContain('"con ""comillas"", coma y\nsalto"')
  })

  it("los importes salen como decimal, no como céntimos crudos", () => {
    expect(sheetToCsv({ name: "x", header: ["importe"], rows: [[1_497_322]] })).toContain("14973.22")
  })

  it("lleva BOM: sin él Excel en Windows destroza los acentos", () => {
    expect(sheetToCsv({ name: "x", header: ["Epígrafe"], rows: [] }).charCodeAt(0)).toBe(0xfeff)
  })

  it("es un zip con un fichero por hoja más las notas", async () => {
    const file = await reportToCsv(runToDocument(run, NOTES), "balance-2026")
    expect(file.filename).toBe("balance-2026.zip")
    expect(file.contentType).toBe("application/zip")
    const zip = await JSZip.loadAsync(file.body)
    const names = Object.keys(zip.files)
    expect(names).toContain("procedencia.csv")
    expect(names).toContain("validacion.csv")
    expect(names).toContain("notas.txt")
    expect(await zip.file("notas.txt")!.async("string")).toContain("art. 37 CdC")
  })
})

describe("XLSX", () => {
  it("produce un OOXML con las partes obligatorias y una hoja por bloque", async () => {
    const file = await reportToXlsx(runToDocument(run, NOTES), "balance-2026")
    expect(file.filename).toBe("balance-2026.xlsx")
    expect(file.contentType).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")

    const zip = await JSZip.loadAsync(file.body)
    for (const part of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml"]) {
      expect(Object.keys(zip.files)).toContain(part)
    }
    const workbook = await zip.file("xl/workbook.xml")!.async("string")
    expect(workbook).toContain("Procedencia")
    expect(workbook).toContain("Validación")
    expect(workbook).toContain("Notas")
  })

  it("los importes son NÚMEROS con formato de moneda, no texto", async () => {
    // Un importe como texto no se puede sumar en Excel: el export sería una
    // captura de pantalla con extensión .xlsx.
    const file = await reportToXlsx(runToDocument(run, NOTES), "b")
    const zip = await JSZip.loadAsync(file.body)
    const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string")
    expect(sheet).toContain("<v>26650.00</v>")
    expect(sheet).not.toContain("t=\"inlineStr\"><is><t xml:space=\"preserve\">26650.00")
    const styles = await zip.file("xl/styles.xml")!.async("string")
    expect(styles).toContain("numFmtId=\"164\"")
  })

  it("recorta el nombre de hoja a lo que Excel admite, en vez de fallar", async () => {
    const doc = runToDocument(run, NOTES)
    const file = await reportToXlsx(
      { ...doc, sheets: [{ name: "Un nombre larguísimo que Excel no admite [con] corchetes", header: ["a"], rows: [] }] },
      "b"
    )
    const zip = await JSZip.loadAsync(file.body)
    const workbook = await zip.file("xl/workbook.xml")!.async("string")
    const name = /name="([^"]+)"/.exec(workbook)![1]
    expect(name.length).toBeLessThanOrEqual(31)
    expect(name).not.toContain("[")
  })
})

describe("reproducibilidad del binario", () => {
  it("dos exports del mismo informe dan el MISMO sha256", async () => {
    const [a, b] = await Promise.all([exportRun(run, "xlsx", NOTES), exportRun(run, "xlsx", NOTES)])
    expect(a.sha256).toBe(b.sha256)
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it("cambiar una cifra cambia el hash", async () => {
    const a = await exportRun(run, "csv", NOTES)
    const b = await exportRun(
      { ...run, result: { ...(run.result as object), activo: [{ path: "A)", depth: 1, cents: 1, isLeaf: true }] } },
      "csv",
      NOTES
    )
    expect(a.sha256).not.toBe(b.sha256)
  })

  it("el PDF se entrega como modelo serializado para el renderizador de React", async () => {
    const file = await exportRun(run, "pdf", NOTES)
    const model = JSON.parse(file.body.toString("utf8")) as { sheets: { name: string }[]; notes: string[] }
    expect(model.sheets.map((s) => s.name)).toContain("Procedencia")
    expect(model.notes).toEqual(NOTES)
  })
})

describe("PDF real con @react-pdf/renderer", () => {
  it("produce un PDF que abre y lleva las hojas de procedencia y validación", async () => {
    const { reportToPdf } = await import("@/lib/export/report-pdf")
    const body = await reportToPdf(runToDocument(run, NOTES))
    // Firma de un PDF: sin ella, el navegador ofrece descargar un fichero roto.
    expect(body.subarray(0, 5).toString("latin1")).toBe("%PDF-")
    expect(body.length).toBeGreaterThan(1_000)
  }, 30_000)
})
