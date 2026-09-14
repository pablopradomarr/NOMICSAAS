import {
  listAccrualsAction,
  listOccurrencesAction,
  listRecurringAction,
} from "@/app/(app)/ledger/recurring/actions"
import { AccrualsPanel } from "@/components/recurring/accruals-panel"
import { RecurringRulesPanel } from "@/components/recurring/rules-panel"
import type { AccrualView } from "@/components/recurring/types"
import { accrualSchedule } from "@/lib/closing/accrual"
import { tenantPage, type SearchParamsProps } from "@/lib/page-tenant"
import { todayLocalDate } from "@/models/ledger"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = { title: "Reglas recurrentes" }

const TABS = [
  { id: "reglas", label: "Reglas y calendario" },
  { id: "periodificaciones", label: "Periodificaciones" },
] as const

/**
 * E9 · T17 — `/ledger/recurring` (`docs/design/E9-cierre-recurrentes.md` §7).
 *
 * Dos pestañas: las **reglas** con su calendario de doce columnas y las
 * **periodificaciones** vivas con su cuadro. Todo lo que se enseña llega ya
 * calculado de las server actions de T15 y del motor puro de `lib/`: la
 * pantalla no suma ni un céntimo.
 *
 * Los tres roles ven lo mismo; `VIEWER` no ve un solo botón de mutación, y la
 * protección de verdad la hacen `withOrg(EDITOR)` y `withOrg(ADMIN)` en las
 * acciones.
 */
export default tenantPage<SearchParamsProps>(async ({ role, searchParams }) => {
  const params = await searchParams
  const tab = typeof params.tab === "string" && params.tab === "periodificaciones" ? "periodificaciones" : "reglas"
  const canEdit = role === Role.EDITOR || role === Role.ADMIN
  const isAdmin = role === Role.ADMIN
  const refDate = todayLocalDate()

  // Lecturas EN SERIE: comparten la transacción de la petición (`tenantPage`).
  const rules = await listRecurringAction()
  const occurrences = await listOccurrencesAction({})
  const accruals = await listAccrualsAction()

  const error = rules.error ?? occurrences.error ?? accruals.error ?? null
  if (error) {
    return (
      <div className="space-y-4">
        <Header tab={tab} />
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 p-6 text-sm" data-testid="recurring-error">
          ⚠ No se han podido leer las reglas recurrentes: {error}
        </p>
      </div>
    )
  }

  const accrualViews: AccrualView[] = (accruals.data ?? []).map((accrual) => ({
    ...accrual,
    rows: accrualSchedule(accrual, "MENSUAL").rows,
  }))

  return (
    <div className="space-y-6">
      <Header tab={tab} />
      {tab === "reglas" ? (
        <RecurringRulesPanel
          rules={rules.data ?? []}
          occurrences={occurrences.data ?? []}
          refDate={refDate}
          canEdit={canEdit}
          isAdmin={isAdmin}
        />
      ) : (
        <AccrualsPanel accruals={accrualViews} canEdit={canEdit} />
      )}
    </div>
  )
})

function Header({ tab }: { tab: string }) {
  return (
    <div className="space-y-4 border-b pb-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Asientos recurrentes</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Reglas con su periodicidad y su vigencia, el calendario de lo generado y lo pendiente, y las
          periodificaciones vivas con su cuadro de devengo. Generar una ocurrencia contabiliza un asiento; anularla es
          siempre un contra-asiento con motivo.
        </p>
      </div>
      <nav className="flex gap-1" data-testid="recurring-tabs">
        {TABS.map((item) => (
          <Link
            key={item.id}
            href={`/ledger/recurring?tab=${item.id}`}
            data-testid={`tab-${item.id}`}
            aria-current={tab === item.id ? "page" : undefined}
            className={
              tab === item.id
                ? "rounded-md bg-[#0A0A0A] px-3 py-1.5 text-sm text-white"
                : "rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted"
            }
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  )
}
