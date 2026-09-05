/**
 * E6 · T15 — El anexo PDF de un informe, con `@react-pdf/renderer` (ya en el
 * proyecto; no se añade ninguna dependencia).
 *
 * Lleva los MISMOS tres bloques que el CSV y el XLSX: el informe, la
 * **Procedencia** y la **Validación**, más las notas al pie. Un PDF que sale del
 * ERP se audita sin volver al ERP.
 *
 * Vive aparte de `report-export.ts` para que el motor de export se pueda testear
 * en Node sin arrastrar React ni el renderizador.
 */

import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer"
import type { ReactElement } from "react"

import { centsToDecimalString, type ExportDocument, type ExportSheet } from "@/lib/export/report-export"

const styles = StyleSheet.create({
  page: { padding: 28, fontSize: 8, fontFamily: "Helvetica" },
  title: { fontSize: 13, marginBottom: 2 },
  subtitle: { fontSize: 8, color: "#555555", marginBottom: 12 },
  sheet: { fontSize: 10, marginTop: 12, marginBottom: 4 },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#DDDDDD", paddingVertical: 2 },
  header: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#333333", paddingVertical: 3 },
  cell: { flex: 1, paddingRight: 6 },
  amount: { flex: 1, paddingRight: 6, textAlign: "right" },
  note: { marginTop: 10, fontSize: 7, color: "#555555" },
})

const cell = (value: string | number | null, key: string): ReactElement =>
  typeof value === "number" ? (
    <Text key={key} style={styles.amount}>
      {centsToDecimalString(value)}
    </Text>
  ) : (
    <Text key={key} style={styles.cell}>
      {value ?? ""}
    </Text>
  )

const sheetBlock = (sheet: ExportSheet, index: number): ReactElement => (
  <View key={`s${index}`} wrap>
    <Text style={styles.sheet}>{sheet.name}</Text>
    <View style={styles.header}>{sheet.header.map((h, i) => cell(h, `h${index}-${i}`))}</View>
    {sheet.rows.map((row, r) => (
      <View key={`r${index}-${r}`} style={styles.row}>
        {row.map((v, c) => cell(v, `c${index}-${r}-${c}`))}
      </View>
    ))}
  </View>
)

/**
 * #11 — fecha de creación FIJA. `@react-pdf/renderer` estampa `CreationDate` y
 * `ModDate` con el reloj, así que dos exports del mismo informe daban binarios
 * distintos y el sha256 no servía para acreditar que el fichero no se había
 * tocado. Es el mismo motivo por el que el zip lleva fecha fija.
 */
const PDF_EPOCH = new Date(Date.UTC(1980, 0, 1))

export async function reportToPdf(doc: ExportDocument): Promise<Buffer> {
  const element = (
    <Document title={doc.title}>
      <Page size="A4" style={styles.page} wrap>
        <Text style={styles.title}>{doc.title}</Text>
        <Text style={styles.subtitle}>{doc.subtitle}</Text>
        {doc.sheets.map(sheetBlock)}
        {doc.notes.map((n, i) => (
          <Text key={`n${i}`} style={styles.note}>
            {n}
          </Text>
        ))}
      </Page>
    </Document>
  )
  const buffer = await renderToBuffer(element)
  // El renderizador no admite fijar las fechas por API: se normalizan sobre el
  // binario, que es texto plano en esa zona del PDF.
  return normalizePdfDates(buffer)
}

/**
 * Sustituye SÓLO `CreationDate` y `ModDate` por la época fija.
 *
 * N3: `@react-pdf/renderer` las escribe como **objetos indirectos**
 * (`/CreationDate 14 0 R`, y en el objeto 14 la cadena `(D:…)`), así que hay que
 * resolver la referencia. Un `replace` sobre todo `D:\d{14}` del binario también
 * pisaría una fecha escrita por el usuario en una celda del informe, que es un
 * DATO del documento y no un metadato.
 *
 * El relleno va con espacios ANTES de `endobj` —whitespace legal en PDF— para
 * que el fichero no cambie de longitud: los offsets de la tabla `xref` son
 * absolutos y desplazarlos rompería el documento.
 */
function normalizePdfDates(pdf: Buffer): Buffer {
  const stamp =
    `D:${PDF_EPOCH.getUTCFullYear()}` +
    `${String(PDF_EPOCH.getUTCMonth() + 1).padStart(2, "0")}` +
    `${String(PDF_EPOCH.getUTCDate()).padStart(2, "0")}000000Z`

  let text = pdf.toString("latin1")

  // 1. Qué objetos referencian las dos claves de fecha.
  const targets = new Set<string>()
  for (const match of text.matchAll(/\/(?:CreationDate|ModDate)\s+(\d+)\s+\d+\s+R/g)) {
    targets.add(match[1])
  }
  // 2. Y la forma directa, por si una versión futura deja de indirectar.
  text = text.replace(
    /\/(CreationDate|ModDate)\s*\((D:[^)]*)\)/g,
    (match, key: string, value: string) => sameLength(match, `/${key} (${stamp})`, value.length)
  )

  // 3. Cada objeto referenciado, reescrito en su sitio.
  for (const objectNumber of targets) {
    const re = new RegExp(`(${objectNumber}\\s+\\d+\\s+obj\\s*)\\((D:[^)]*)\\)`, "g")
    text = text.replace(re, (match, head: string) => sameLength(match, `${head}(${stamp})`, 0))
  }
  return Buffer.from(text, "latin1")
}

/** Rellena con espacios hasta la longitud original, o deja el original si no cabe. */
function sameLength(original: string, replacement: string, _valueLength: number): string {
  if (replacement.length > original.length) return original
  return replacement + " ".repeat(original.length - replacement.length)
}
