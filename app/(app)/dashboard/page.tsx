import DashboardDropZoneWidget from "@/components/dashboard/drop-zone-widget"
import DashboardUnsortedWidget from "@/components/dashboard/unsorted-widget"
import { WelcomeWidget } from "@/components/dashboard/welcome-widget"
import { Separator } from "@/components/ui/separator"
import { requireOrg } from "@/lib/authz"
import config from "@/lib/config"
import { getUnsortedFiles } from "@/models/files"
import { getSettings } from "@/models/settings"
import { countUnpostedTransactions, UNPOSTED_DOCUMENTS_NOTE } from "@/models/transactions"
import { Metadata } from "next"

export const metadata: Metadata = {
  title: "Panel",
  description: config.app.description,
}

/**
 * E6 · T18 — El panel de estadísticas heredado de TaxHacker **se ha retirado**
 * (G-05/G-06): sumaba `Transaction.total` por moneda, pintaba porcentajes `NaN`
 * cuando no había base y contaba como 0 los documentos sin contabilizar, de modo
 * que sus totales no cuadraban con el balance y nadie sabía por qué.
 *
 * El panel nuevo se sirve de `dashboardAction` (`app/(app)/dashboard/actions.ts`),
 * que deriva TODAS las cifras del libro diario a través de un `ReportRun`
 * sellado. La pantalla la monta el trabajo de interfaz de E6; hasta entonces,
 * aquí no se pinta ninguna cifra: mejor una sección vacía que un número que no
 * cuadra con las cuentas.
 */
export default async function Dashboard() {
  const { db } = await requireOrg("VIEWER")
  const [unsortedFiles, settings, unpostedCount] = await Promise.all([
    getUnsortedFiles(db),
    getSettings(db),
    countUnpostedTransactions(db),
  ])

  return (
    <div className="flex flex-col gap-5 p-5 w-full max-w-7xl self-center">
      <div className="flex flex-col sm:flex-row gap-5 items-stretch h-full">
        <DashboardDropZoneWidget />

        <DashboardUnsortedWidget files={unsortedFiles} />
      </div>

      {settings.is_welcome_message_hidden !== "true" && <WelcomeWidget />}

      <Separator />

      {unpostedCount > 0 && (
        <p className="text-sm text-muted-foreground">{UNPOSTED_DOCUMENTS_NOTE(unpostedCount)}</p>
      )}
    </div>
  )
}
