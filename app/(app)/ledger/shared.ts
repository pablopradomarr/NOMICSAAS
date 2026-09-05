import type { AccountOption, EntryView, LineView, ReportHeaderView } from "@/components/ledger/types"
import type { TaxRateOption } from "@/components/ledger/template-form"
import type { TenantClient } from "@/lib/db"
import { runLedgerInvariants } from "@/models/ledger"
import { getPlan } from "@/models/accounts"
import type { PostedEntry } from "@/lib/ledger/types"

/**
 * E3 · T11/T12 — Ayudas de servidor compartidas por las pantallas del diario.
 *
 * No es un módulo de acciones: son lecturas que los Server Components hacen con
 * el `db` de `requireOrg` (barrera 1) y adaptaciones de la salida de `models/`
 * a los modelos de vista de `components/ledger/types.ts`. Aquí no se calcula
 * ninguna cifra contable: las cifras llegan de `models/` y de `lib/ledger`.
 */

/** Cuentas que admiten apuntes: la misma condición que el trigger de la base (I9). */
export async function postableAccounts(db: TenantClient): Promise<AccountOption[]> {
  const plan = await getPlan(db)
  const out: AccountOption[] = []
  for (const code of plan.codes) {
    const account = plan.byCode.get(code)
    if (account && account.isPostable && account.isActive) out.push({ code: account.code, name: account.name })
  }
  return out
}

/** Nombre de cada cuenta del plan, para decorar líneas de asiento e informes. */
export async function accountNames(db: TenantClient): Promise<Map<string, string>> {
  const plan = await getPlan(db)
  return new Map([...plan.byCode.values()].map((a) => [a.code, a.name]))
}

export async function taxRateOptions(db: TenantClient): Promise<TaxRateOption[]> {
  const rates = await db.taxRate.findMany({ orderBy: [{ code: "asc" }] })
  const seen = new Set<string>()
  const out: TaxRateOption[] = []
  for (const rate of rates) {
    if (seen.has(rate.code)) continue
    seen.add(rate.code)
    out.push({ code: rate.code, label: `${rate.code} · ${rate.name}` })
  }
  return out
}

/** Datos del asiento que `PostedEntry` no lleva (son de auditoría, no de motor). */
export type EntryExtras = {
  voidReason: string | null
  postedAt: string | null
  postedByName: string | null
  transactionId: string | null
  fileId: string | null
  fiscalYearCode: string | null
  reversedByEntryId: string | null
  reversedByEntryNumber: number | null
  reversesEntryNumber: number | null
}

export async function entryExtras(db: TenantClient, entryIds: readonly string[]): Promise<Map<string, EntryExtras>> {
  if (entryIds.length === 0) return new Map()

  const rows = await db.journalEntry.findMany({
    where: { id: { in: [...entryIds] } },
    select: {
      id: true,
      voidReason: true,
      postedAt: true,
      postedById: true,
      transactionId: true,
      fileId: true,
      reversesEntryId: true,
      fiscalYear: { select: { code: true } },
      reverses: { select: { entryNumber: true } },
      reversedBy: { select: { id: true, entryNumber: true } },
    },
  })

  const userIds = [...new Set(rows.map((r) => r.postedById).filter((id): id is string => Boolean(id)))]
  const users = userIds.length
    ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } })
    : []
  const userName = new Map(users.map((u) => [u.id, u.name || u.email]))

  return new Map(
    rows.map((row) => {
      const reversal = row.reversedBy[0]
      return [
        row.id,
        {
          voidReason: row.voidReason,
          postedAt: row.postedAt ? row.postedAt.toISOString() : null,
          postedByName: row.postedById ? (userName.get(row.postedById) ?? null) : null,
          transactionId: row.transactionId,
          fileId: row.fileId,
          fiscalYearCode: row.fiscalYear?.code ?? null,
          reversedByEntryId: reversal?.id ?? null,
          reversedByEntryNumber: reversal?.entryNumber ?? null,
          reversesEntryNumber: row.reverses?.entryNumber ?? null,
        },
      ]
    })
  )
}

/**
 * Nombres de las dimensiones analíticas, para pintar el destino de cada línea
 * 6/7 en el detalle del asiento (E4 §6). Es una lectura de pantalla: la
 * dimensión que manda es la que viaja en la propia `journal_line`.
 */
export type DimensionNames = Map<string, { code: string; name: string }>

export async function dimensionNames(db: TenantClient): Promise<{
  projects: DimensionNames
  costCenters: DimensionNames
}> {
  const [projects, costCenters] = await Promise.all([
    db.project.findMany({ select: { id: true, code: true, name: true } }),
    db.costCenter.findMany({ select: { id: true, code: true, name: true } }),
  ])
  return {
    projects: new Map(projects.map((p) => [p.id, { code: p.code, name: p.name }])),
    costCenters: new Map(costCenters.map((c) => [c.id, { code: c.code, name: c.name }])),
  }
}

/** `PostedEntry` (motor) → `EntryView` (pantalla). Los totales se toman de las líneas ya persistidas. */
export function toEntryView(
  entry: PostedEntry,
  names: Map<string, string>,
  extras?: EntryExtras,
  dimensions?: { projects: DimensionNames; costCenters: DimensionNames }
): EntryView {
  const lines: LineView[] = entry.lines.map((line) => {
    const dimension = line.projectId
      ? dimensions?.projects.get(line.projectId)
      : line.costCenterId
        ? dimensions?.costCenters.get(line.costCenterId)
        : undefined
    return {
      id: line.id ?? undefined,
      lineNo: line.lineNo,
      accountCode: line.accountCode,
      accountName: names.get(line.accountCode) ?? line.accountCode,
      debitCents: line.debitCents,
      creditCents: line.creditCents,
      description: line.description ?? null,
      dueDate: line.dueDate ?? null,
      analyticType: line.analyticType ?? null,
      projectId: line.projectId ?? null,
      costCenterId: line.costCenterId ?? null,
      destinationCode: dimension?.code ?? null,
      destinationName: dimension?.name ?? null,
      isPnlLine: line.accountCode.startsWith("6") || line.accountCode.startsWith("7"),
    }
  })
  const totalDebitCents = lines.reduce((acc, l) => acc + l.debitCents, 0)
  const totalCreditCents = lines.reduce((acc, l) => acc + l.creditCents, 0)

  return {
    id: entry.id,
    entryNumber: entry.entryNumber,
    entryDate: entry.entryDate,
    documentDate: entry.documentDate ?? null,
    accrualDate: entry.accrualDate ?? null,
    description: entry.description,
    kind: entry.kind,
    sourceType: entry.sourceType,
    sourceId: entry.sourceId ?? null,
    templateCode: entry.templateCode ?? null,
    taxRoundingMode: entry.taxRoundingMode ?? null,
    reversesEntryId: entry.reversesEntryId ?? null,
    reversesEntryNumber: extras?.reversesEntryNumber ?? null,
    voidedAt: entry.voidedAt ?? null,
    voidReason: extras?.voidReason ?? null,
    reversedByEntryId: extras?.reversedByEntryId ?? null,
    reversedByEntryNumber: extras?.reversedByEntryNumber ?? null,
    entryHash: entry.entryHash ?? null,
    postedByName: extras?.postedByName ?? null,
    postedAt: extras?.postedAt ?? null,
    transactionId: extras?.transactionId ?? null,
    fileId: extras?.fileId ?? null,
    fiscalYearCode: extras?.fiscalYearCode ?? null,
    lines,
    totalDebitCents,
    totalCreditCents,
    balanced: totalDebitCents === totalCreditCents,
  }
}

/**
 * Cabecera de informe con **sello**: ejecuta los invariantes sobre el diario
 * real (`runLedgerInvariants` → `validacion.json` + `sealFor`) y devuelve
 * `run_id`, `ledgerHash` y la lista de checks para el botón "Ver validación".
 *
 * Se recalcula en cada render: E3 no persiste `ReportRun` (llega en E6), así
 * que lo que se ve corresponde al diario de este instante y no a una foto vieja.
 */
export async function reportHeader(
  organizationId: string,
  userId: string,
  params: { from: string; to: string; baseCurrency: string; fiscalYearId?: string; refDate: string }
): Promise<ReportHeaderView> {
  let run: Awaited<ReturnType<typeof runLedgerInvariants>>
  try {
    run = await runLedgerInvariants(organizationId, {
      refDate: params.refDate,
      ...(params.fiscalYearId ? { fiscalYearId: params.fiscalYearId } : {}),
      actor: { userId },
    })
  } catch (error) {
    // E4-UI-1.b: ninguna excepción del bloque de invariantes (en particular del
    // motor analítico) puede tumbar un informe. El informe se sirve con las
    // cifras del diario y la cabecera dice, con motivo, que REQUIERE REVISIÓN.
    const motivo = error instanceof Error ? error.message : String(error)
    return {
      from: params.from,
      to: params.to,
      baseCurrency: params.baseCurrency,
      runId: "",
      ledgerHash: "",
      gitSha: process.env.GIT_SHA ?? "desconocido",
      seal: { sello: "REQUIERE REVISIÓN", motivos: [`los invariantes no se han podido evaluar: ${motivo}`] },
      checks: [
        {
          id: "VALIDACION",
          status: "FAIL",
          evidencia: `el bloque de invariantes ha fallado: ${motivo}`,
        },
      ],
    }
  }

  return {
    from: params.from,
    to: params.to,
    baseCurrency: params.baseCurrency,
    runId: run.validacion.run_id,
    ledgerHash: run.validacion.ledgerHash,
    gitSha: run.validacion.gitSha,
    seal: run.sello,
    checks: run.validacion.checks.map((check) => ({
      id: check.id,
      status: check.status,
      evidencia: check.evidencia,
      ...(check.query ? { query: check.query } : {}),
    })),
  }
}

/** Periodo por defecto de los informes: el ejercicio elegido, o el año natural de `refDate`. */
export function defaultPeriod(
  fiscalYear: { startDate: string; endDate: string } | null,
  refDate: string
): { from: string; to: string } {
  if (fiscalYear) return { from: fiscalYear.startDate, to: fiscalYear.endDate }
  const year = refDate.slice(0, 4)
  return { from: `${year}-01-01`, to: `${year}-12-31` }
}
