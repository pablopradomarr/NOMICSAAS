import {
  listVatSettlementsAction,
  model303Action,
  prorrataAction,
  vatBookAction,
} from "@/app/(app)/reports/vat/actions"
import { Model303Table } from "@/components/vat/model303-table"
import { VatPeriodPicker } from "@/components/vat/period-picker"
import { ProrrataPanel } from "@/components/vat/prorrata-panel"
import { SettleVatDialog } from "@/components/vat/settle-dialog"
import { SettlementsPanel } from "@/components/vat/settlements-panel"
import { VatBookTable } from "@/components/vat/book-table"
import { VatRegimeForm } from "@/components/vat/regime-form"
import { vatPeriodOf, vatRegimeAt, type VatPeriodKind } from "@/lib/closing/vat"
import { tenantPage, type SearchParamsProps } from "@/lib/page-tenant"
import { todayLocalDate } from "@/models/ledger"
import { readVatRegimePeriods } from "@/models/vat"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = { title: "IVA" }

const TABS = [
  { id: "libro", label: "Libro registro" },
  { id: "casillas", label: "Casillas del 303" },
  { id: "prorrata", label: "Prorrata" },
  { id: "liquidaciones", label: "Liquidaciones" },
] as const

type TabId = (typeof TABS)[number]["id"]

/**
 * E9 · T18 — `/reports/vat` (`docs/design/E9-cierre-recurrentes.md` §7, D4 y D8).
 *
 * Cuatro pestañas sobre un mismo periodo: el **libro registro** (con las
 * columnas de cobro y pago del art. 61 «decies» y «undecies» si hay RECC), las
 * **casillas del 303** con su fórmula y su origen, la **prorrata** con los
 * documentos sin clasificar y su regularización, y las **liquidaciones** con su
 * sello y su reversión.
 *
 * El periodo se ofrece según el **régimen vigente en esa fecha** (D8.1): el
 * régimen es un dato fechado, y entrar en REDEME en 2027 no puede reagrupar los
 * periodos de 2026 ya presentados.
 *
 * Sólo se lee lo que la pestaña activa necesita: el libro de un trimestre con
 * dos mil documentos no se recorre para enseñar el historial de liquidaciones.
 */
export default tenantPage<SearchParamsProps>(async ({ db, role, searchParams }) => {
  const params = await searchParams
  const first = (key: string): string | undefined => {
    const value = params[key]
    return Array.isArray(value) ? value[0] : value
  }

  const isAdmin = role === Role.ADMIN
  const today = todayLocalDate()

  const regimes = await readVatRegimePeriods(db)
  const regimeToday = vatRegimeAt(regimes, today)
  const kind: VatPeriodKind = regimeToday?.periodKind ?? "TRIMESTRAL"

  const period = first("period") ?? vatPeriodOf(today, kind)
  const year = Number(first("year") ?? period.slice(0, 4))
  const tab = (TABS.find((t) => t.id === first("tab"))?.id ?? "libro") as TabId

  const regimeAtPeriod = vatRegimeAt(regimes, `${period.slice(0, 4)}-12-31`)

  return (
    <div className="space-y-6">
      <div className="space-y-4 border-b pb-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">IVA</h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Libro registro, casillas del modelo 303 con su origen, prorrata y liquidaciones. Todo se deriva de los
              asientos contabilizados: aquí no se teclea ni una cifra que se declare.
            </p>
            <p className="text-sm text-muted-foreground" data-testid="vat-regime">
              Periodo <span className="font-code">{period}</span> · régimen{" "}
              <strong>{regimeAtPeriod?.regime ?? "GENERAL"}</strong> · liquidación{" "}
              {(regimeAtPeriod?.periodKind ?? kind).toLowerCase()}
              {regimeAtPeriod?.importDeferral ? " · con diferimiento del IVA a la importación" : ""}
              {regimeAtPeriod ? ` · vigente desde ${regimeAtPeriod.validFrom}` : " · sin vigencia declarada"}
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <VatPeriodPicker period={period} year={year} tab={tab} />
            {isAdmin && <SettleVatDialog period={period} />}
          </div>
        </div>
        <nav className="flex flex-wrap gap-1" data-testid="vat-tabs">
          {TABS.map((item) => (
            <Link
              key={item.id}
              href={`/reports/vat?tab=${item.id}&period=${encodeURIComponent(period)}&year=${year}`}
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
        {isAdmin && <VatRegimeForm />}
      </div>

      {tab === "libro" && (await BookTab({ period }))}
      {tab === "casillas" && (await BoxesTab({ period }))}
      {tab === "prorrata" && (await ProrrataTab({ year, isAdmin }))}
      {tab === "liquidaciones" && (await SettlementsTab({ isAdmin }))}
    </div>
  )
})

async function BookTab({ period }: { period: string }) {
  const book = await vatBookAction({ period })
  if (!book.success || !book.data) return <Failure message={book.error ?? "El libro registro no se ha podido leer"} />
  return <VatBookTable view={book.data} />
}

async function BoxesTab({ period }: { period: string }) {
  const model = await model303Action({ period })
  if (!model.success || !model.data) return <Failure message={model.error ?? "Las casillas no se han podido derivar"} />
  return <Model303Table view={model.data} period={period} />
}

async function ProrrataTab({ year, isAdmin }: { year: number; isAdmin: boolean }) {
  const prorrata = await prorrataAction({ year })
  if (!prorrata.success || !prorrata.data) {
    return <Failure message={prorrata.error ?? "La prorrata no se ha podido derivar"} />
  }
  return <ProrrataPanel view={prorrata.data} isAdmin={isAdmin} />
}

async function SettlementsTab({ isAdmin }: { isAdmin: boolean }) {
  const settlements = await listVatSettlementsAction({})
  if (!settlements.success) return <Failure message={settlements.error ?? "El historial no se ha podido leer"} />
  return <SettlementsPanel settlements={settlements.data ?? []} isAdmin={isAdmin} />
}

function Failure({ message }: { message: string }) {
  return (
    <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 p-6 text-sm" data-testid="vat-error">
      ⚠ {message}
    </p>
  )
}
