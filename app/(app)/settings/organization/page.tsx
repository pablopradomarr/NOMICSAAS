import { CategoryDeductibilityTable, type CategoryFiscalView } from "@/components/settings/category-deductibility-table"
import { OrganizationSettingsForm } from "@/components/settings/organization-settings-form"
import { SettingsPageHeader } from "@/components/settings/page-header"
import { OrganizationFiscalForm } from "@/components/counterparties/organization-fiscal-form"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { tenantPage } from "@/lib/page-tenant"
import { Role } from "@/prisma/client"
import { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = {
  title: "Organización",
}

/**
 * E8 · T17 — `/settings/organization` (§6).
 *
 * A los datos de la organización se les suma lo que ADR-0014 D11 movió aquí: el
 * **régimen de IVA** y el **ROI**, que no son etiquetas administrativas sino
 * interruptores del motor —RECC bloquea la contabilización automática, el ROI es
 * precondición del ISP—, y la **deducibilidad por defecto** de cada categoría de
 * gasto (O-17).
 *
 * La calificación fiscal de cada tercero vive en su propia pantalla, porque es
 * un maestro con muchas filas y aquí sólo habría cabido mal.
 */
export default tenantPage(async ({ db, org, role }) => {
  const canEdit = role === Role.ADMIN

  const categories = await db.category.findMany({
    select: { code: true, name: true, defaultAccountCode: true, defaultDeductibility: true },
    orderBy: { code: "asc" },
  })

  const rows: CategoryFiscalView[] = categories.map((category) => ({
    code: category.code,
    name: category.name,
    defaultAccountCode: category.defaultAccountCode,
    defaultDeductibility: category.defaultDeductibility,
  }))

  return (
    <div className="space-y-8">
      <SettingsPageHeader
        title="Organización"
        description="Datos fiscales y contables de la organización activa. La moneda base y la variante del PGC condicionan el plan de cuentas y los informes; el régimen de IVA y el ROI condicionan qué documentos se pueden contabilizar automáticamente."
      />
      <OrganizationSettingsForm organization={org} canEdit={canEdit} />

      <Separator />

      <OrganizationFiscalForm roiRegistered={org.roiRegistered} ivaRegime={org.ivaRegime} canEdit={canEdit} />

      <Separator />

      <CategoryDeductibilityTable categories={rows} canEdit={canEdit} />

      <Separator />

      <section className="space-y-2">
        <h3 className="text-lg font-semibold">Terceros</h3>
        <p className="max-w-3xl text-sm text-muted-foreground">
          La retención de IRPF, el recargo de equivalencia, el país y el NIF-IVA con su comprobación en VIES son de
          cada proveedor y cada cliente, y el motor los lee de su ficha, nunca del documento: la retención es
          obligación del pagador (arts. 99, 101 y 107 LIRPF) y no depende de que la factura la mencione.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href="/settings/counterparties">Ir a terceros y calificación fiscal</Link>
        </Button>
      </section>
    </div>
  )
})
