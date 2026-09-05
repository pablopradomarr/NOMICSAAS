import { accountNames, entryExtras, postableAccounts, toEntryView } from "@/app/(app)/ledger/shared"
import { JournalTable } from "@/components/ledger/journal-table"
import { LedgerFilters, type LedgerFilterValues } from "@/components/ledger/ledger-filters"
import type { FiscalYearView } from "@/components/ledger/types"
import { Button } from "@/components/ui/button"
import { requireOrg } from "@/lib/authz"
import { OPERATIONAL_TEMPLATE_CODES, TEMPLATES } from "@/lib/ledger/templates"
import { isTemplateCode } from "@/lib/ledger/templates/index"
import type { EntryKind } from "@/prisma/client"
import { Role } from "@/prisma/client"
import { getEntries, todayLocalDate } from "@/models/ledger"
import { listFiscalYears } from "@/models/fiscal-years"
import { listPeriodLocks } from "@/models/period-locks"
import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = { title: "Libro diario" }

const PAGE_SIZE = 50

const ENTRY_KINDS = new Set<string>(["NORMAL", "OPENING", "CLOSING", "REGULARIZATION", "REVERSAL", "RECURRING"])

/**
 * E3 · T11 — Libro diario (diseño §6).
 *
 * Server Component: la consulta la resuelve `models/ledger.getEntries` dentro
 * del tenant y el navegador recibe los asientos ya ordenados por
 * `(entryDate, entryNumber)` (N-5) con sus totales. Los filtros viven en la URL.
 *
 * NINGÚN filtro excluye los anulados por defecto (I-E3-3): el asiento anulado y
 * su contra-asiento aparecen los dos y se compensan por importe.
 */
export default async function LedgerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { db, org, role } = await requireOrg(Role.VIEWER)
  const params = await searchParams
  const first = (key: string): string | undefined => {
    const value = params[key]
    return Array.isArray(value) ? value[0] : value
  }

  const canEdit = role === Role.EDITOR || role === Role.ADMIN
  const page = Math.max(1, Number(first("page") ?? "1") || 1)

  const values: LedgerFilterValues = {
    fiscalYearId: first("fiscalYearId"),
    from: first("from"),
    to: first("to"),
    account: first("account"),
    q: first("q"),
    kind: first("kind"),
    templateCode: first("templateCode"),
    voided: first("voided"),
  }

  const voidedFilter =
    values.voided === "only" ? { voided: true } : values.voided === "none" ? { voided: false } : {}

  const { entries, total } = await getEntries(
    db,
    {
      ...(values.fiscalYearId ? { fiscalYearId: values.fiscalYearId } : {}),
      ...(values.from ? { from: values.from } : {}),
      ...(values.to ? { to: values.to } : {}),
      ...(values.account ? { accountCode: values.account } : {}),
      ...(values.q ? { search: values.q } : {}),
      ...(values.kind && ENTRY_KINDS.has(values.kind) ? { kind: values.kind as EntryKind } : {}),
      ...(values.templateCode && isTemplateCode(values.templateCode) ? { templateCode: values.templateCode } : {}),
      ...(values.voided === "reversals" ? { onlyReversals: true } : {}),
      ...voidedFilter,
    },
    { skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }
  )

  const names = await accountNames(db)
  const extras = await entryExtras(db, entries.map((e) => e.id))
  const views = entries.map((entry) => toEntryView(entry, names, extras.get(entry.id)))

  // Totales de lo que se está viendo. Los suma el servidor a partir de las
  // líneas persistidas: el navegador no calcula cifras contables.
  const totalDebitCents = views.reduce((acc, e) => acc + e.totalDebitCents, 0)
  const totalCreditCents = views.reduce((acc, e) => acc + e.totalCreditCents, 0)

  const fiscalYearRows = await listFiscalYears(db)
  const locks = await listPeriodLocks(db)
  const accounts = await postableAccounts(db)

  const fiscalYears: FiscalYearView[] = fiscalYearRows.map((fy) => ({
    id: fy.id,
    code: fy.code,
    startDate: fy.startDate.toISOString().slice(0, 10),
    endDate: fy.endDate.toISOString().slice(0, 10),
    status: fy.status,
    lastEntryNumber: fy.lastEntryNumber,
    lockedMonths: locks.filter((l) => l.fiscalYearId === fy.id).map((l) => l.month).sort((a, b) => a - b),
  }))

  const templateCodes = OPERATIONAL_TEMPLATE_CODES.map((code) => ({ code, label: TEMPLATES[code].label }))
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Libro diario</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Única fuente de las cifras del ERP: todos los asientos de la organización, ordenados por fecha contable y
            número. Anular no borra nada — el asiento anulado y su contra-asiento siguen aquí y se compensan.
          </p>
          <p className="text-sm text-muted-foreground">
            {total} asiento(s) · {todayLocalDate()} · moneda base <span className="font-code">{org.baseCurrency}</span>
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/ledger/sumas-saldos">Sumas y saldos</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/ledger/mayor">Mayor</Link>
          </Button>
          {canEdit && (
            <Button asChild size="sm">
              <Link href="/ledger/new">Nuevo asiento</Link>
            </Button>
          )}
        </div>
      </div>

      {fiscalYears.length === 0 && (
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm">
          Esta organización todavía no tiene ningún ejercicio contable, así que no se puede contabilizar nada.{" "}
          {role === Role.ADMIN ? (
            <Link href="/settings/fiscal-years" className="underline underline-offset-2">
              Crear el primer ejercicio
            </Link>
          ) : (
            "Pídeselo a un administrador."
          )}
        </p>
      )}

      <LedgerFilters fiscalYears={fiscalYears} accounts={accounts} templateCodes={templateCodes} values={values} />

      <JournalTable
        entries={views}
        baseCurrency={org.baseCurrency}
        totals={{
          totalDebitCents,
          totalCreditCents,
          differenceCents: totalDebitCents - totalCreditCents,
          balanced: totalDebitCents === totalCreditCents,
        }}
      />

      {pages > 1 && (
        <nav className="flex items-center justify-between text-sm" aria-label="Paginación del diario">
          <span className="text-muted-foreground">
            Página {page} de {pages}
          </span>
          <div className="flex gap-2">
            {page > 1 && (
              <Button asChild variant="outline" size="sm">
                <Link href={hrefWithPage(params, page - 1)}>Anterior</Link>
              </Button>
            )}
            {page < pages && (
              <Button asChild variant="outline" size="sm">
                <Link href={hrefWithPage(params, page + 1)}>Siguiente</Link>
              </Button>
            )}
          </div>
        </nav>
      )}
    </div>
  )
}

function hrefWithPage(params: Record<string, string | string[] | undefined>, page: number): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (key === "page") continue
    const single = Array.isArray(value) ? value[0] : value
    if (single) search.set(key, single)
  }
  search.set("page", String(page))
  return `/ledger?${search.toString()}`
}
