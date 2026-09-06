import CurrencyDefaultsForm from "@/components/settings/currency-defaults-form"
import { CrudTable } from "@/components/settings/crud"
import { SettingsPageHeader } from "@/components/settings/page-header"
import { Separator } from "@/components/ui/separator"
import { getCurrencies } from "@/models/currencies"
import { getSettings } from "@/models/settings"
import { listRatesForPeriod } from "@/models/fx"
import { addCurrencyAction, deleteCurrencyAction, editCurrencyAction } from "@/app/(app)/settings/actions"
import { tenantPage } from "@/lib/page-tenant"

/** Ventana de tasas que la pantalla enseña. */
const DAYS = 120

export default tenantPage(async ({ db, org }) => {
  // En SERIE: la transacción de la petición tiene UNA conexión (lib/page-tenant.ts).
  const currencies = await getCurrencies(db)
  const settings = await getSettings(db)
  const currenciesWithActions = currencies.map((currency) => ({
    ...currency,
    isEditable: true,
    isDeletable: true,
  }))

  const today = new Date()
  const from = new Date(today.getTime() - DAYS * 24 * 60 * 60 * 1000)
  const rates = await listRatesForPeriod(db, from.toISOString().slice(0, 10), today.toISOString().slice(0, 10))

  return (
    <div className="space-y-8">
      <SettingsPageHeader
        title="Monedas y tipos de cambio"
        description="Moneda base de la organización, monedas admitidas y las tasas que el servidor ha usado para convertir documentos."
      />
      <CurrencyDefaultsForm settings={settings} currencies={currencies} />
      <Separator />
      <CrudTable
        items={currenciesWithActions}
        columns={[
          { key: "code", label: "Código", editable: true },
          { key: "name", label: "Nombre", editable: true },
        ]}
        onDelete={async (code) => {
          "use server"
          return await deleteCurrencyAction(code)
        }}
        onAdd={async (data) => {
          "use server"
          return await addCurrencyAction(data as { code: string; name: string })
        }}
        onEdit={async (code, data) => {
          "use server"
          return await editCurrencyAction(code, data as { name: string })
        }}
      />

      <Separator />

      {/* E8 · T17 — Tasas persistidas (§6, ADR-0014 D7). Sólo lectura: una tasa
          es un hecho publicado, no una preferencia. */}
      <section className="space-y-2">
        <h3 className="text-lg font-semibold">Tipos de cambio usados</h3>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Moneda base de la organización: <span className="font-code">{org.baseCurrency}</span>. La conversión de un
          documento se hace <strong>en el servidor</strong>, con la tasa de la fecha del documento publicada por la
          fuente única, y la tasa queda guardada con su origen y su fecha efectiva. Por eso confirmar la misma factura
          un mes después da exactamente el mismo importe convertido, y por eso esta tabla es de sólo lectura: una tasa
          publicada no es una preferencia de la organización. Si la fuente no responde, no se inventa una tasa
          aproximada: la confirmación falla y lo dice.
        </p>
        {rates.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-6 text-sm text-muted-foreground" data-testid="rates-empty">
            No se ha convertido ningún documento en los últimos {DAYS} días: no hay tasas registradas.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm" data-testid="exchange-rates">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Fecha efectiva</th>
                  <th className="px-3 py-2 text-left font-medium">Par</th>
                  <th className="px-3 py-2 text-right font-medium">Tasa (millonésimas)</th>
                  <th className="px-3 py-2 text-left font-medium">Fuente</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rates.map((rate) => (
                  <tr key={rate.id} className="h-8">
                    <td className="px-3 py-1 font-code text-xs">{rate.rateDate}</td>
                    <td className="px-3 py-1 font-code text-xs">
                      {rate.from} → {rate.to}
                    </td>
                    <td className="px-3 py-1 text-right font-code text-xs tabular-nums">{rate.rateMicro.toString()}</td>
                    <td className="px-3 py-1 text-xs">{rate.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
})
