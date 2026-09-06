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
  /** E8 · T16 — el eslabón que lleva del asiento al documento (§7). */
  extractionRunId: string | null
  receptionDate: string | null
  operationDate: string | null
  fiscalYearCode: string | null
  reversedByEntryId: string | null
  reversedByEntryNumber: number | null
  reversesEntryNumber: number | null
}

export async function entryExtras(db: TenantClient, entryIds: readonly string[]): Promise<Map<string, EntryExtras>> {
  if (entryIds.length === 0) return new Map()

  // E6-perf: SIN `select` multi-relación. Pedir a la vez `fiscalYear`,
  // `reverses` y `reversedBy` hace que Prisma lance las tres consultas hermanas
  // EN PARALELO sobre la única conexión de la transacción de la petición, y el
  // adaptador `pg` avisa con «client is already executing a query»
  // (DeprecationWarning que este repositorio tenía anotado como deuda y por el
  // que `libro-diario.spec.ts` se excluía). Se resuelve en cuatro consultas
  // planas, en serie: mismo número de viajes a la base, ningún solapamiento.
  const rows = await db.journalEntry.findMany({
    where: { id: { in: [...entryIds] } },
    select: {
      id: true,
      voidReason: true,
      postedAt: true,
      postedById: true,
      transactionId: true,
      fileId: true,
      extractionRunId: true,
      receptionDate: true,
      operationDate: true,
      fiscalYearId: true,
      reversesEntryId: true,
    },
  })

  const fiscalYearIds = [...new Set(rows.map((row) => row.fiscalYearId))]
  const fiscalYears = fiscalYearIds.length
    ? await db.fiscalYear.findMany({ where: { id: { in: fiscalYearIds } }, select: { id: true, code: true } })
    : []
  const fiscalYearCode = new Map(fiscalYears.map((fy) => [fy.id, fy.code]))

  // El asiento que ESTE anula (`reverses`).
  const reversedIds = [...new Set(rows.map((row) => row.reversesEntryId).filter((id): id is string => Boolean(id)))]
  const reversed = reversedIds.length
    ? await db.journalEntry.findMany({ where: { id: { in: reversedIds } }, select: { id: true, entryNumber: true } })
    : []
  const reversedNumber = new Map(reversed.map((entry) => [entry.id, entry.entryNumber]))

  // El contra-asiento que anula a ESTE (`reversedBy`), por la FK inversa.
  const reversals = await db.journalEntry.findMany({
    where: { reversesEntryId: { in: [...entryIds] } },
    select: { id: true, entryNumber: true, reversesEntryId: true },
  })
  const reversalOf = new Map<string, { id: string; entryNumber: number }>()
  for (const reversal of reversals) {
    if (reversal.reversesEntryId && !reversalOf.has(reversal.reversesEntryId)) {
      reversalOf.set(reversal.reversesEntryId, { id: reversal.id, entryNumber: reversal.entryNumber })
    }
  }

  const userIds = [...new Set(rows.map((r) => r.postedById).filter((id): id is string => Boolean(id)))]
  const users = userIds.length
    ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } })
    : []
  const userName = new Map(users.map((u) => [u.id, u.name || u.email]))

  return new Map(
    rows.map((row) => {
      const reversal = reversalOf.get(row.id)
      return [
        row.id,
        {
          voidReason: row.voidReason,
          postedAt: row.postedAt ? row.postedAt.toISOString() : null,
          postedByName: row.postedById ? (userName.get(row.postedById) ?? null) : null,
          transactionId: row.transactionId,
          fileId: row.fileId,
          extractionRunId: row.extractionRunId,
          receptionDate: row.receptionDate ? row.receptionDate.toISOString().slice(0, 10) : null,
          operationDate: row.operationDate ? row.operationDate.toISOString().slice(0, 10) : null,
          fiscalYearCode: fiscalYearCode.get(row.fiscalYearId) ?? null,
          reversedByEntryId: reversal?.id ?? null,
          reversedByEntryNumber: reversal?.entryNumber ?? null,
          reversesEntryNumber: row.reversesEntryId
            ? (reversedNumber.get(row.reversesEntryId) ?? null)
            : null,
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
  // En SERIE: con `tenantDb` cada operación abre su propia transacción, pero si
  // hay una transacción de tenant abierta arriba las dos se despachan sobre la
  // MISMA conexión y el adaptador `pg` avisa de «client is already executing a
  // query» — aviso que Next reenvía a la consola del navegador.
  const projects = await db.project.findMany({ select: { id: true, code: true, name: true } })
  const costCenters = await db.costCenter.findMany({ select: { id: true, code: true, name: true } })
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
    extractionRunId: extras?.extractionRunId ?? null,
    receptionDate: extras?.receptionDate ?? null,
    operationDate: extras?.operationDate ?? null,
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
    /**
     * `readStoredFile` (E8 ronda 1, auditor H-3): el lector de los BYTES del
     * almacén con el que I-E8-2 detecta un documento alterado o desaparecido.
     * Se inyecta AQUÍ y no dentro de `models/ledger` a propósito; el porqué
     * está en `StoredFileReader`.
     */
    const { sha256OfStoredFile } = await import("@/lib/files-integrity")
    run = await runLedgerInvariants(organizationId, {
      refDate: params.refDate,
      ...(params.fiscalYearId ? { fiscalYearId: params.fiscalYearId } : {}),
      actor: { userId },
      readStoredFile: sha256OfStoredFile,
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
      seal: {
        sello: "REQUIERE REVISIÓN",
        motivos: [`los invariantes no se han podido evaluar: ${motivo}`],
      },
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
