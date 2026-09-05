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
  return await renderToBuffer(element)
}
