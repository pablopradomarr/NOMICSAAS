import { listAnalyticsAction } from "@/app/(app)/analytics/actions"
import { dimensionOptions } from "@/app/(app)/analytics/shared"
import { postableAccounts } from "@/app/(app)/ledger/shared"
import { ManualEntryForm } from "@/components/ledger/manual-entry-form"
import { Button } from "@/components/ui/button"
import { OPERATIONAL_TEMPLATE_CODES, TEMPLATES } from "@/lib/ledger/templates"
import { todayLocalDate } from "@/models/ledger"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"
import Link from "next/link"
import { tenantPage } from "@/lib/page-tenant"

export const metadata: Metadata = { title: "Nuevo asiento" }

const BLOCK_LABELS: Record<string, string> = {
  A: "Documentos con impuestos",
  B: "Tesorería, personal y periodificación",
  C: "Estructurales",
}

/**
 * E3 · T11 — Nuevo asiento: elegir plantilla o ir a modo libre (diseño §6).
 *
 * El catálogo sale de `TEMPLATES`, que es la fuente única del motor: si mañana
 * hay una plantilla más, aparece aquí sin tocar esta pantalla. Sólo se ofrecen
 * las **24 de operativa** (T-01…T-24): las cuatro de cierre no tienen acción de
 * usuario hasta E9. El contra-asiento tampoco está: se anula desde el asiento.
 */
export default tenantPage(async ({ db, org, role }) => {
  const canPost = role === Role.EDITOR || role === Role.ADMIN
  const accounts = await postableAccounts(db)
  const listing = await listAnalyticsAction({})
  const dimensions = dimensionOptions(listing.data?.projects ?? [], listing.data?.costCenters ?? [])

  const templates = OPERATIONAL_TEMPLATE_CODES.map((code) => TEMPLATES[code]).filter(
    (template) => template.code !== "CONTRA_ASIENTO" && template.code !== "ASIENTO_MANUAL"
  )

  return (
    <div className="space-y-6">
      <div className="space-y-1 border-b pb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Nuevo asiento</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Una plantilla construye el asiento por ti a partir del documento —incluidas las líneas de impuesto, la
          retención y el reparto de prorrata—; el modo libre te deja escribir el Debe y el Haber a mano. En los dos
          casos el asiento lo valida el servidor y el cuadre lo garantiza la base de datos.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold tracking-tight">Desde una plantilla</h2>
        {(["A", "B", "C"] as const).map((block) => {
          const inBlock = templates.filter((t) => t.block === block)
          if (inBlock.length === 0) return null
          return (
            <div key={block} className="space-y-2">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {BLOCK_LABELS[block]}
              </h3>
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {inBlock.map((template) => (
                  <li key={template.code}>
                    <Link
                      href={`/ledger/new/${template.code}`}
                      data-template-code={template.code}
                      className="flex h-full flex-col gap-0.5 rounded-md border p-3 text-sm hover:bg-muted/40"
                    >
                      <span className="font-medium">{template.label}</span>
                      <span className="font-code text-[11px] text-muted-foreground">{template.code}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold tracking-tight">Modo libre (asiento manual)</h2>
          <Button asChild variant="ghost" size="sm">
            <Link href="/ledger">Volver al diario</Link>
          </Button>
        </div>
        <ManualEntryForm
          accounts={accounts}
          canPost={canPost}
          defaultDate={todayLocalDate()}
          dimensions={dimensions}
          analyticsRequired={org.analyticsRequired}
        />
      </section>
    </div>
  )
})
