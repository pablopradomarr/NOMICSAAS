/**
 * E6 · T15 — Export de un `ReportRun` a CSV, XLSX y PDF.
 *
 * Los TRES formatos llevan los mismos tres bloques: el informe, la hoja/anexo
 * **«Procedencia»** y la hoja/anexo **«Validación»**, más las notas al pie. Un
 * XLSX que sale del ERP se tiene que poder auditar **sin volver al ERP**: si la
 * procedencia se queda dentro de la aplicación, el fichero que circula por
 * correo es un número sin respaldo.
 *
 * Sin dependencias nuevas (D-E6-5): el XLSX es OOXML mínimo escrito con `jszip`,
 * que ya está en el proyecto. `exceljs` son ~1 MB y una superficie de parseo que
 * no usamos: aquí sólo se escriben celdas `inlineStr` y `n`.
 */

import { createHash } from "node:crypto"

import JSZip from "jszip"

import type { Cents } from "@/lib/ledger/types"

export type ExportFormat = "csv" | "xlsx" | "pdf"

export type ExportSheet = {
  name: string
  /** Cabecera de la tabla. */
  header: readonly string[]
  /** Filas. Un `number` se escribe como NÚMERO en XLSX; el resto, como texto. */
  rows: readonly (readonly (string | number | null)[])[]
}

export type ExportDocument = {
  title: string
  subtitle: string
  /** Notas al pie: no compensación, «informe de gestión», operaciones sin flujo. */
  notes: readonly string[]
  sheets: readonly ExportSheet[]
}

export type ExportedFile = {
  filename: string
  contentType: string
  body: Buffer
  /** sha256 del binario: el mismo fichero exportado dos veces da el mismo hash. */
  sha256: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Importes: céntimos → cadena decimal SIN pasar por Float
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cadena decimal exacta desde céntimos, por aritmética entera. `(cents/100)
 * .toFixed(2)` parece equivalente y no lo es: pasa por un binario de doble
 * precisión, y en importes grandes el último céntimo baila.
 */
export function centsToDecimalString(cents: Cents): string {
  const negative = cents < 0
  const abs = negative ? -cents : cents
  const units = Math.trunc(abs / 100)
  const rest = abs - units * 100
  return `${negative ? "-" : ""}${units}.${String(rest).padStart(2, "0")}`
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV — un `.zip` con los tres ficheros (D-E6-5)
// ─────────────────────────────────────────────────────────────────────────────

const csvCell = (value: string | number | null): string => {
  if (value === null) return ""
  const text = typeof value === "number" ? centsToDecimalString(value) : value
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function sheetToCsv(sheet: ExportSheet): string {
  const lines = [sheet.header.map(csvCell).join(",")]
  for (const row of sheet.rows) lines.push(row.map(csvCell).join(","))
  // BOM: sin él, Excel en Windows abre los acentos como mojibake y el usuario
  // concluye —con razón— que el ERP exporta basura.
  return `﻿${lines.join("\r\n")}\r\n`
}

export async function reportToCsv(doc: ExportDocument, slug: string): Promise<ExportedFile> {
  const zip = new JSZip()
  for (const sheet of doc.sheets) zip.file(`${slugify(sheet.name)}.csv`, sheetToCsv(sheet))
  zip.file("notas.txt", `${doc.title}\n${doc.subtitle}\n\n${doc.notes.join("\n\n")}\n`)
  const body = await generate(zip)
  return file(`${slug}.zip`, "application/zip", body)
}

// ─────────────────────────────────────────────────────────────────────────────
// XLSX — OOXML mínimo con `jszip`
// ─────────────────────────────────────────────────────────────────────────────

const xmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const columnName = (index: number): string => {
  let n = index + 1
  let out = ""
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.trunc((n - 1) / 26)
  }
  return out
}

function sheetXml(sheet: ExportSheet): string {
  const rows: string[] = []
  const renderRow = (cells: readonly (string | number | null)[], rowIndex: number, style?: number): string => {
    const parts = cells.map((value, i) => {
      const ref = `${columnName(i)}${rowIndex}`
      if (value === null) return ""
      if (typeof value === "number") {
        // Número DE VERDAD, con formato de moneda: un importe como texto no se
        // puede sumar en Excel y convierte el export en una captura de pantalla.
        return `<c r="${ref}" s="1"><v>${centsToDecimalString(value)}</v></c>`
      }
      return `<c r="${ref}"${style ? ` s="${style}"` : ""} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`
    })
    return `<row r="${rowIndex}">${parts.join("")}</row>`
  }
  rows.push(renderRow(sheet.header, 1, 2))
  sheet.rows.forEach((row, i) => rows.push(renderRow(row, i + 2)))
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${rows.join("")}</sheetData></worksheet>`
  )
}

export async function reportToXlsx(doc: ExportDocument, slug: string): Promise<ExportedFile> {
  const sheets = [
    ...doc.sheets,
    { name: "Notas", header: ["Nota"], rows: doc.notes.map((n) => [n] as const) },
  ]
  const zip = new JSZip()

  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets
        .map(
          (_s, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
        )
        .join("") +
      "</Types>"
  )
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      "</Relationships>"
  )
  zip.file(
    "xl/workbook.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      sheets
        .map((s, i) => `<sheet name="${xmlEscape(sheetName(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join("") +
      "</sheets></workbook>"
  )
  zip.file(
    "xl/_rels/workbook.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets
        .map(
          (_s, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
        )
        .join("") +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      "</Relationships>"
  )
  // Formato `#.##0,00 €` (id 164) y una fila de cabecera en negrita. Nada más:
  // el resto de la hoja de estilos de OOXML no la usamos.
  zip.file(
    "xl/styles.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00\\ &quot;€&quot;"/></numFmts>' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
      '<borders count="1"><border/></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="3">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      "</cellXfs></styleSheet>"
  )
  sheets.forEach((s, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)))

  const body = await generate(zip)
  return file(
    `${slug}.xlsx`,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    body
  )
}

/** Excel: 31 caracteres, sin `[]:*?/\`. Se recorta, no se falla. */
function sheetName(name: string): string {
  return name.replace(/[[\]:*?/\\]/g, "-").slice(0, 31)
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF — `@react-pdf/renderer`, ya en el proyecto
// ─────────────────────────────────────────────────────────────────────────────

/**
 * El PDF se genera con `@react-pdf/renderer` desde el route handler, que es
 * donde vive React. Aquí se prepara el documento en la forma que ese
 * componente consume, para que el motor de export siga sin depender de React
 * y se pueda testear en Node sin renderizador.
 */
export function reportToPdfModel(doc: ExportDocument): ExportDocument {
  return doc
}

// ─────────────────────────────────────────────────────────────────────────────
// Composición del documento desde un `ReportRun`
// ─────────────────────────────────────────────────────────────────────────────

export type ExportableRun = {
  id: string
  type: string
  periodStart: string
  periodEnd: string
  ledgerHash: string
  gitSha: string
  seal: string
  sealReasons: readonly { code: string; message: string }[]
  validation: { checks: readonly { id: string; status: string; evidencia: string }[] }
  provenance: unknown
  result: unknown
  params: Record<string, unknown>
}

type StatementRowish = { path: string; depth: number; cents: number; isLeaf: boolean; accountCodes?: readonly string[] }

/**
 * Convierte el `result` de un run en hojas. Se apoya en la forma común de los
 * informes (`{path, cents}`) y, para lo que no la tiene, vuelca los pares
 * clave/valor: es preferible un volcado honesto a una hoja vacía.
 */
export function runToDocument(run: ExportableRun, notes: readonly string[] = []): ExportDocument {
  const sheets: ExportSheet[] = []
  const result = run.result as Record<string, unknown>

  const pushStatement = (name: string, rows: unknown): void => {
    if (!Array.isArray(rows) || rows.length === 0) return
    sheets.push({
      name,
      header: ["Epígrafe", "Nivel", "Importe", "Cuentas"],
      rows: (rows as StatementRowish[]).map((r) => [r.path, r.depth, r.cents, (r.accountCodes ?? []).join(" ")]),
    })
  }
  pushStatement("Activo", result?.activo)
  pushStatement("Patrimonio neto", result?.patrimonioNeto)
  pushStatement("Pasivo", result?.pasivo)
  pushStatement("PyG", result?.lines)

  const directo = result?.directo as Record<string, unknown> | undefined
  if (directo?.annualCents) {
    const annual = directo.annualCents as Record<string, number>
    sheets.push({
      name: "Cashflow directo",
      header: ["Bloque", "Importe"],
      rows: [
        ["Saldo inicial", directo.openingCashCents as number],
        ...Object.entries(annual).map(([k, v]) => [k, v] as const),
        ["Saldo final", directo.closingCashCents as number],
      ],
    })
  }
  const indirecto = result?.indirecto as Record<string, unknown> | undefined
  if (indirecto?.blockCents) {
    sheets.push({
      name: "Cashflow indirecto",
      header: ["Bloque", "Importe"],
      rows: Object.entries(indirecto.blockCents as Record<string, number>).map(([k, v]) => [k, v] as const),
    })
  }
  if (Array.isArray(result?.kpis)) {
    sheets.push({
      name: "Panel",
      header: ["KPI", "Importe", "Comparativo", "Variación (bps)"],
      rows: (result.kpis as { label: string; cents: number; previousCents: number | null; deltaBps: number | null }[]).map(
        (k) => [k.label, k.cents, k.previousCents, k.deltaBps === null ? "sin comparativo" : k.deltaBps]
      ),
    })
  }
  if (sheets.length === 0) {
    sheets.push({
      name: "Informe",
      header: ["Clave", "Valor"],
      rows: Object.entries(result ?? {}).map(([k, v]) => [k, JSON.stringify(v)] as const),
    })
  }

  // Hoja de PROCEDENCIA: sin ella, el fichero exportado es un número suelto.
  sheets.push({
    name: "Procedencia",
    header: ["Campo", "Valor"],
    rows: [
      ["Informe", run.type],
      ["Identificador del run", run.id],
      ["Periodo", `${run.periodStart} … ${run.periodEnd}`],
      ["Sello del diario (ledgerHash)", `sha256:${run.ledgerHash}`],
      ["Versión del motor (gitSha)", run.gitSha],
      ["Parámetros", JSON.stringify(run.params)],
      ["Procedencia por celda", JSON.stringify(run.provenance)],
    ],
  })

  sheets.push({
    name: "Validación",
    header: ["Comprobación", "Estado", "Evidencia"],
    rows: [
      ["SELLO", run.seal, run.sealReasons.map((r) => `${r.code}: ${r.message}`).join(" · ") || "sin motivos"],
      ...run.validation.checks.map((c) => [c.id, c.status, c.evidencia] as const),
    ],
  })

  return {
    title: `${run.type} · ${run.periodStart} a ${run.periodEnd}`,
    subtitle: `Sello: ${run.seal} · run ${run.id} · motor ${run.gitSha}`,
    notes,
    sheets,
  }
}

export async function exportRun(
  run: ExportableRun,
  format: ExportFormat,
  notes: readonly string[] = []
): Promise<ExportedFile> {
  const doc = runToDocument(run, notes)
  const slug = slugify(`${run.type}-${run.periodStart}-${run.periodEnd}`)
  if (format === "csv") return await reportToCsv(doc, slug)
  if (format === "xlsx") return await reportToXlsx(doc, slug)
  // El PDF lo compone el route handler con `@react-pdf/renderer`; aquí se
  // devuelve el modelo serializado para que el motor no dependa de React.
  return file(`${slug}.pdf.json`, "application/json", Buffer.from(JSON.stringify(reportToPdfModel(doc)), "utf8"))
}

function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

/**
 * Fecha FIJA en todas las entradas del zip. Un export reproducible no puede
 * llevar la hora dentro: dos exports del mismo informe darían hashes distintos
 * y el hash dejaría de servir para acreditar que el fichero no se ha tocado.
 */
async function generate(zip: JSZip): Promise<Buffer> {
  for (const entry of Object.values(zip.files)) entry.date = EPOCH
  return await zip.generateAsync({ type: "nodebuffer" })
}

const EPOCH = new Date(Date.UTC(1980, 0, 1))

function file(filename: string, contentType: string, body: Buffer): ExportedFile {
  return { filename, contentType, body, sha256: createHash("sha256").update(body).digest("hex") }
}
