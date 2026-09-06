import { InvoiceSeriesPanel, type InvoiceSeriesView, type NumberingGapView } from "@/components/settings/invoice-series-panel"
import { SettingsPageHeader } from "@/components/settings/page-header"
import { tenantPage } from "@/lib/page-tenant"
import { checkInvoiceNumberingGaps, formatInvoiceNumber, listInvoiceSeries } from "@/models/invoices"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"

export const metadata: Metadata = { title: "Facturación" }

/**
 * E8 · T17 — `/settings/invoicing` (§6, O-18).
 *
 * Las series por tipo, el siguiente número que va a salir y el control de
 * huecos (I-E8-20), que se mide contra **el diario** y no contra el contador: un
 * contador adelantado sin asiento detrás es exactamente un hueco.
 *
 * La emisión vive en la aplicación de facturas (`/apps/invoices`), que recalcula
 * bases y cuotas en el servidor (G-21), toma el número de la serie del tipo que
 * corresponda y contabiliza T-01 o T-02. Aquí sólo se configura de dónde sale
 * ese número.
 */
export default tenantPage(async ({ db, role }) => {
  const isAdmin = role === Role.ADMIN

  const series = await listInvoiceSeries(db)
  const gaps = await checkInvoiceNumberingGaps(db)

  const rows: InvoiceSeriesView[] = series.map((serie) => ({
    id: serie.id,
    code: serie.code,
    kind: serie.kind,
    prefix: serie.prefix,
    year: serie.year,
    nextNumber: serie.nextNumber,
    nextDocumentNumber: formatInvoiceNumber(serie.prefix, serie.nextNumber),
    isActive: serie.isActive,
  }))

  const gapRows: NumberingGapView[] = gaps.map((gap) => ({
    seriesCode: gap.seriesCode,
    fiscalYear: gap.fiscalYear,
    missing: gap.missing,
    duplicated: gap.duplicated,
    outOfOrder: gap.outOfOrder.map((entry) => `${entry.number} (${entry.documentDate})`),
  }))

  return (
    <div className="space-y-8">
      <SettingsPageHeader
        title="Facturación"
        description="Series de numeración de las facturas que emite la organización. El art. 15.4 del RD 1619/2012 obliga a una serie específica para las rectificativas, y la numeración de cada serie es correlativa y sin huecos dentro del ejercicio."
      />
      <InvoiceSeriesPanel series={rows} gaps={gapRows} isAdmin={isAdmin} />
    </div>
  )
})
