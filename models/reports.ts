/**
 * E6 · T13 — Acceso a datos de los informes financieros (§4 del diseño).
 *
 * **Este módulo NO calcula nada.** Lee las líneas, compone el contexto, llama al
 * motor puro de `lib/ledger/reports/`, corre los invariantes, sella y persiste
 * el `ReportRun`. Toda consulta va dentro de `tenantTransaction` (RLS estricta,
 * ADR-0009: una consulta fuera del GUC no falla, devuelve vacío).
 *
 * `report_runs` es **append-only**: no hay `update` ni `delete` en todo el
 * fichero, y la base lo impide igualmente (I-E6-16).
 */

import { randomUUID } from "node:crypto"

import { tenantTransaction, type TenantClient, type TenantTransactionClient } from "@/lib/db"
import type { AccountKey, PgcVariant } from "@/lib/accounts/types"
import { fromUtcDate, toUtcDate } from "@/lib/ledger/dates"
import { buildBalance, type BalanceReport } from "@/lib/ledger/reports/balance"
import {
  buildCashflowDirect,
  buildCashflowIndirect,
  buildEfeView,
  type CashflowDirectReport,
  type CashflowIndirectReport,
  type EfeReport,
} from "@/lib/ledger/reports/cashflow"
import { buildDashboard, type DashboardReport } from "@/lib/ledger/reports/dashboard"
import { buildPyg, type PygReport } from "@/lib/ledger/reports/pyg"
import { runReportInvariants } from "@/lib/ledger/reports/invariants-e6"
import type { ReportLine, StatementAccount } from "@/lib/ledger/reports/types"
import { buildAccountIndex, type BalanceSnapshot } from "@/lib/ledger/reports/types"
import {
  analyticsKeyOf,
  canonicalResultJson,
  checkThresholds,
  DEFAULT_REVIEW_THRESHOLDS,
  paramsHash as paramsHashOf,
  reportRunKey,
  reportSealReasons,
  sealOf,
  type KpiSnapshot,
  type ReportSealReason,
  type ReviewThresholds,
} from "@/lib/ledger/report-run"
import type { CheckResult } from "@/lib/ledger/invariants-types"
import type { Cents, LocalDate } from "@/lib/ledger/types"
import { getAccountMapByKey } from "@/models/account-map"
import type { Actor } from "@/models/accounts"
import { writeAuditLog } from "@/models/audit-log"
import { buildDiario } from "@/lib/ledger/reports/diario"
import { buildMayor } from "@/lib/ledger/reports/mayor"
import { buildSumasSaldos } from "@/lib/ledger/reports/sumas-saldos"
import { getAnalyticPnl } from "@/models/margins"
import { getAnalyticLines, getAnalyticsConfig } from "@/models/analytics"
import { analyticsHash as computeAnalyticsHash, marginConfigHash } from "@/lib/analytics/hash"
import { getEntries, getLinesForPeriod, computeLedgerHash } from "@/models/ledger"
import { ComparativeBasis, Prisma, ReportType, ResultKind, Seal } from "@/prisma/client"

export type AnyClient = TenantClient | TenantTransactionClient

/** git-sha del motor. Se lee UNA vez, en el borde, nunca dentro de `lib/ledger/`. */
export const currentGitSha = (): string => process.env.GIT_SHA ?? "desconocido"

// ─────────────────────────────────────────────────────────────────────────────
// Plan de cuentas en la forma que consumen los estados financieros
// ─────────────────────────────────────────────────────────────────────────────

export async function getStatementAccounts(db: AnyClient): Promise<StatementAccount[]> {
  const rows = await db.ledgerAccount.findMany({
    select: {
      code: true,
      name: true,
      level: true,
      statement: true,
      epigraph: true,
      epigraphPymes: true,
      bidirectional: true,
      isContra: true,
      nature: true,
      cashflowBucket: true,
    },
    orderBy: { code: "asc" },
  })
  return rows as StatementAccount[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Petición y resultado
// ─────────────────────────────────────────────────────────────────────────────

export type ReportRequest = {
  type: ReportType
  periodStart: LocalDate
  periodEnd: LocalDate
  fiscalYearId?: string
  /** Parámetros del informe. Entran ENTEROS en `paramsHash` (O-5, O-8). */
  params: Record<string, unknown>
  /** Base comparativa; por defecto, la de la organización. */
  comparativeBasis?: ComparativeBasis
  actor?: Actor
  /** Los tests de corrupción y de reproducibilidad necesitan saltarse la caché. */
  noCache?: boolean
}

export type ReportRunView = {
  id: string
  type: ReportType
  periodStart: LocalDate
  periodEnd: LocalDate
  params: Record<string, unknown>
  paramsHash: string
  ledgerHash: string
  analyticsHash: string | null
  analyticsKey: string
  gitSha: string
  result: unknown
  resultKind: ResultKind
  provenance: unknown
  validation: { checks: CheckResult[] }
  seal: Seal
  sealReasons: ReportSealReason[]
  durationMs: number
  comparativeRunId: string | null
  comparativeBasis: ComparativeBasis | null
  createdAt: Date
  /** De dónde salió: `cache` no vuelve a calcular ni a sellar. */
  origen: "fresh" | "cache"
}

/** Informes cuyo `result` se guarda RESUMIDO (D-E6-4): el diario no cabe en 1 MB. */
const SUMMARY_TYPES: ReadonlySet<ReportType> = new Set([
  ReportType.DIARIO,
  ReportType.MAYOR,
  ReportType.SUMAS_SALDOS,
])

/** E10. Se declara en el enum y se rechaza en runtime, que es lo honesto. */
const NOT_IMPLEMENTED: ReadonlySet<ReportType> = new Set([ReportType.PRESUPUESTO_REAL])

/**
 * Informes que DEPENDEN de la analítica y por tanto no se pueden sellar sin
 * `analyticsHash`. La base lo repite con un CHECK: un informe analítico sin su
 * sello podría servirse de caché tras una reimputación y nadie lo notaría.
 */
const ANALYTICS_TYPES: ReadonlySet<ReportType> = new Set([
  ReportType.PYG_ANALITICA,
  ReportType.DASHBOARD,
  ReportType.PRESUPUESTO_REAL,
])

// ─────────────────────────────────────────────────────────────────────────────
// getOrCreateReportRun
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Devuelve el informe del periodo, reutilizando el `ReportRun` que ya exista
 * para la MISMA clave y emitiendo uno nuevo si no.
 *
 * La clave es `(organización, tipo, periodo, paramsHash, ledgerHash,
 * analyticsKey, gitSha)`. **`paramsHash` no es opcional** (O-5): dos `BALANCE`
 * del mismo periodo con distinta foto comparten `ledgerHash` y son informes
 * distintos; sin `paramsHash` la caché devolvería cifras correctas del informe
 * equivocado, que es el peor bug posible porque no se nota.
 */
export async function getOrCreateReportRun(
  organizationId: string,
  request: ReportRequest
): Promise<ReportRunView> {
  if (NOT_IMPLEMENTED.has(request.type)) {
    throw new Error(`El informe ${request.type} llega en E10: todavía no se emite`)
  }
  const startedAt = Date.now()

  return await tenantTransaction(organizationId, request.actor?.userId ?? undefined, async (tx) => {
    const gitSha = currentGitSha()

    // 1. Líneas del periodo, plan y organización.
    //
    // EN SERIE, no en paralelo: `getLinesForPeriod` es `$queryRaw` y dentro de
    // una transacción todas comparten la ÚNICA conexión. Lanzarlas a la vez hace
    // que el adaptador `pg` mezcle respuestas —la misma lección que E3 y E4
    // aprendieron en `runLedgerInvariants` y en `getAnalyticPnl`—.
    const lines = await getLinesForPeriod(tx, {
      from: request.periodStart,
      to: request.periodEnd,
      ...(request.fiscalYearId ? { fiscalYearId: request.fiscalYearId } : {}),
    })
    const accounts = await getStatementAccounts(tx)
    // `Organization` NO está en `TENANT_MODELS` (es el tenant, no una tabla de
    // negocio), así que la extensión no le inyecta el filtro: el `where` va
    // EXPLÍCITO. Sin él, `findFirst` devuelve cualquier organización visible por
    // la política —la del usuario, no necesariamente la del informe— y el
    // informe se emitiría con la moneda y los umbrales de otra empresa.
    const organization = await tx.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { baseCurrency: true, pgcVariant: true, reviewThresholds: true },
    })

    // 2. Sellos. `ledgerHash` se calcula EN LA BASE (ADR-0011) sobre las mismas
    //    líneas ordenadas, no materializando el diario en memoria.
    const ledgerHash = await computeLedgerHash(tx, {
      ...(request.fiscalYearId ? { fiscalYearId: request.fiscalYearId } : {}),
      from: request.periodStart,
      to: request.periodEnd,
    })
    // El sello analítico se calcula ANTES de mirar la caché: forma parte de la
    // clave. Sin él, una reimputación (E5) devolvería el informe viejo.
    let analyticsHash: string | null = null
    let marginHash: string | null = null
    if (ANALYTICS_TYPES.has(request.type)) {
      const config = await getAnalyticsConfig(tx, { periodEnd: request.periodEnd })
      const analyticLines = await getAnalyticLines(tx, {
        from: request.periodStart,
        to: request.periodEnd,
        ...(request.fiscalYearId ? { fiscalYearId: request.fiscalYearId } : {}),
      })
      marginHash = marginConfigHash(config)
      analyticsHash = computeAnalyticsHash(
        analyticLines.map((l) => ({
          entryId: l.entryId,
          lineNo: l.lineNo,
          projectId: l.projectId,
          costCenterId: l.costCenterId,
          businessLineId: l.businessLineId,
          analyticType: l.analyticType,
        })),
        marginHash,
        null
      )
    }
    const analyticsKey = analyticsKeyOf({ analyticsHash, marginConfigHash: marginHash })
    // El aviso de revisión manual entra en `params` y, por tanto, en la clave de
    // reutilización. Es lo que hace que el criterio 13 funcione con una tabla
    // append-only: al levantar el flag, la petición siguiente tiene otra clave,
    // se emite un run nuevo y vuelve a salir `VALIDADO AUTOMÁTICAMENTE`. Si el
    // flag no formara parte de la clave, la caché seguiría devolviendo para
    // siempre el run sellado bajo revisión.
    const activeFlag = await activeManualReviewFlag(tx, request)
    const params: Record<string, unknown> = {
      currency: organization.baseCurrency,
      ...request.params,
      ...(activeFlag ? { reviewFlagId: activeFlag.id } : {}),
    }
    const hash = paramsHashOf(params)

    // 3. ¿Existe ya? Caché por la clave COMPLETA.
    if (request.noCache !== true) {
      const cached = await tx.reportRun.findFirst({
        where: {
          type: request.type,
          periodStart: toUtcDate(request.periodStart),
          periodEnd: toUtcDate(request.periodEnd),
          paramsHash: hash,
          ledgerHash,
          analyticsKey,
          gitSha,
        },
        orderBy: { createdAt: "desc" },
      })
      if (cached) return toView(cached, "cache")
    }

    // 4. Cálculo, invariantes, comparativo y sello.
    const index = buildAccountIndex(accounts)
    const resultAccountCode = await accountCodeFor(tx, "RESULTADO_EJERCICIO")
    const incomeTaxAccountCodes = [
      await accountCodeFor(tx, "HP_ACREEDORA_IS"),
      await accountCodeFor(tx, "HP_DEUDORA_IS"),
    ].filter((c): c is string => c !== null)

    const period = {
      organizationId,
      from: request.periodStart,
      to: request.periodEnd,
      baseCurrency: organization.baseCurrency,
      ...(request.fiscalYearId ? { fiscalYearId: request.fiscalYearId } : {}),
    }
    const variant = (params.variant as PgcVariant | undefined) ?? organization.pgcVariant

    // El libro diario necesita las cabeceras; los demás informes, no. Leerlas
    // siempre traería el diario entero a memoria sin motivo.
    const entries =
      request.type === ReportType.DIARIO
        ? (await getEntries(tx, request.fiscalYearId ? { fiscalYearId: request.fiscalYearId } : {}, { take: 5_000 })).entries.map(
            (e) => ({
              id: e.id,
              entryNumber: e.entryNumber,
              entryDate: e.entryDate,
              documentDate: e.documentDate ?? null,
              accrualDate: e.accrualDate ?? null,
              description: e.description,
              kind: e.kind,
              sourceType: e.sourceType,
              sourceId: e.sourceId ?? null,
              templateCode: e.templateCode ?? null,
              taxRoundingMode: e.taxRoundingMode,
              reversesEntryId: e.reversesEntryId ?? null,
              voidedAt: e.voidedAt ?? null,
            })
          )
        : undefined

    const analyticReport =
      request.type === ReportType.PYG_ANALITICA
        ? await getAnalyticPnl(tx, {
            from: request.periodStart,
            to: request.periodEnd,
            ...(request.fiscalYearId ? { fiscalYearId: request.fiscalYearId } : {}),
            provenance: { runId: randomUUID(), gitSha, baseCurrency: organization.baseCurrency },
          })
        : null

    const built = analyticReport
      ? ({
          kind: "SUMMARY" as const,
          module: "lib/analytics/margins.ts",
          result: analyticReport.pnl as unknown as Record<string, unknown>,
        })
      : buildReport(request.type, lines, index, {
      ...period,
      variant,
      params,
      resultAccountCode: resultAccountCode ?? "129",
      incomeTaxAccountCodes,
      ...(entries ? { entries } : {}),
    })

    const checks = runReportInvariants({
      lines,
      accounts: index,
      resultAccountCode: resultAccountCode ?? "129",
      ...period,
      incomeTaxAccountCodes,
      ...(built.kind === "DASHBOARD" ? { dashboard: built.dashboard, aging: [built.dashboard.aging.clientes, built.dashboard.aging.proveedores] } : {}),
    })

    // 5. Comparativo y umbrales (EV-1…EV-10).
    const basis = request.comparativeBasis ?? thresholdsOf(organization.reviewThresholds).comparativeBasis
    const previous = await previousRunFor(tx, {
      type: request.type,
      periodStart: request.periodStart,
      periodEnd: request.periodEnd,
      paramsHash: hash,
      basis: basis as ComparativeBasis,
    })
    const thresholds = thresholdsOf(organization.reviewThresholds)
    const breaches = checkThresholds(
      kpisOf(built),
      previous ? kpisOfStored(previous.result) : null,
      thresholds,
      { comparativeBasis: basis as never }
    )

    // EV-7 y EV-8 se miden contra el ÚLTIMO run del MISMO informe —mismo tipo,
    // mismo periodo, mismos parámetros—, no contra el comparativo, que es de
    // otro periodo: «primer run tras cambiar el motor» no habla de la variación
    // interanual, habla de ESTE informe.
    const lastSameKey = await tx.reportRun.findFirst({
      where: {
        type: request.type,
        periodStart: toUtcDate(request.periodStart),
        periodEnd: toUtcDate(request.periodEnd),
        paramsHash: hash,
      },
      orderBy: { createdAt: "desc" },
      select: { gitSha: true, analyticsHash: true },
    })

    const reasons = reportSealReasons({
      checks,
      breaches,
      always: {
        gitSha,
        lastGitSha: lastSameKey?.gitSha ?? null,
        analyticsHash,
        lastAnalyticsHash: lastSameKey?.analyticsHash ?? null,
        manualReviewReason: activeFlag?.reason ?? null,
      },
    })
    const seal = sealOf(reasons) === "VALIDADO_AUTOMATICAMENTE" ? Seal.VALIDADO_AUTOMATICAMENTE : Seal.REQUIERE_REVISION

    const runId = randomUUID()
    const provenance = {
      runId,
      ledgerHash: `sha256:${ledgerHash}`,
      gitSha,
      module: built.module,
      generatedFrom: "journal_lines",
    }

    // 6. `INSERT … ON CONFLICT DO NOTHING` y relectura de la fila ganadora: dos
    //    peticiones simultáneas del mismo informe no pueden dar dos runs ni un
    //    error al usuario.
    const durationMs = Math.max(0, Date.now() - startedAt)
    await tx.$executeRaw`
      INSERT INTO report_runs (
        id, organization_id, type, period_start, period_end, fiscal_year_id,
        params, params_hash, ledger_hash, analytics_hash, margin_config_hash, git_sha,
        result, result_kind, provenance, validation, seal, seal_reasons, duration_ms,
        comparative_run_id, comparative_basis, created_by_id
      ) VALUES (
        ${runId}::uuid, ${organizationId}::uuid, ${request.type}::report_type,
        ${toUtcDate(request.periodStart)}::date, ${toUtcDate(request.periodEnd)}::date,
        ${request.fiscalYearId ?? null}::uuid,
        ${JSON.stringify(params)}::jsonb, ${hash}, ${ledgerHash}, ${analyticsHash}, ${marginHash}, ${gitSha},
        ${canonicalResultJson(built.result)}::jsonb,
        ${SUMMARY_TYPES.has(request.type) ? "SUMMARY" : "FULL"}::result_kind,
        ${JSON.stringify(provenance)}::jsonb,
        ${JSON.stringify({ checks })}::jsonb,
        ${seal}::seal,
        ${JSON.stringify(reasons)}::jsonb,
        ${durationMs},
        ${previous?.id ?? null}::uuid,
        ${previous ? basis : null}::comparative_basis,
        ${request.actor?.userId ?? null}::uuid
      )
      -- La clave es un índice único, no una constraint con nombre: se declara
      -- por columnas. Dos peticiones simultáneas del mismo informe no producen
      -- dos runs ni un error al usuario; gana el primero y el segundo relee.
      ON CONFLICT (organization_id, type, period_start, period_end, params_hash, ledger_hash, analytics_key, git_sha)
      DO NOTHING`

    const stored = await tx.reportRun.findFirstOrThrow({
      where: {
        type: request.type,
        periodStart: toUtcDate(request.periodStart),
        periodEnd: toUtcDate(request.periodEnd),
        paramsHash: hash,
        ledgerHash,
        analyticsKey,
        gitSha,
      },
      orderBy: { createdAt: "desc" },
    })
    return toView(stored, stored.id === runId ? "fresh" : "cache")
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Construcción del informe (delegación al motor puro)
// ─────────────────────────────────────────────────────────────────────────────

type BuildContext = {
  organizationId: string
  from: LocalDate
  to: LocalDate
  baseCurrency: string
  fiscalYearId?: string
  variant: PgcVariant
  params: Record<string, unknown>
  resultAccountCode: string
  incomeTaxAccountCodes: readonly string[]
  /** Cabeceras de asiento: sólo las necesita el libro diario. */
  entries?: readonly import("@/lib/ledger/reports/types").ReportEntry[]
}

type BuiltReport =
  | { kind: "BALANCE"; module: string; result: BalanceReport; balance: BalanceReport }
  | { kind: "PYG"; module: string; result: PygReport; pyg: PygReport }
  | { kind: "CASHFLOW"; module: string; result: { directo: CashflowDirectReport; indirecto: CashflowIndirectReport; efe: EfeReport }; direct: CashflowDirectReport }
  | { kind: "DASHBOARD"; module: string; result: DashboardReport; dashboard: DashboardReport }
  // T19: el diario, el mayor y sumas y saldos pasan también por `ReportRun`,
  // pero con `resultKind = SUMMARY` (D-E6-4): las líneas de un ejercicio no
  // caben en el `result` y guardarlas duplicaría el diario dentro del informe.
  | { kind: "SUMMARY"; module: string; result: Record<string, unknown> }

function buildReport(
  type: ReportType,
  lines: readonly ReportLine[],
  index: ReturnType<typeof buildAccountIndex>,
  ctx: BuildContext
): BuiltReport {
  const period = {
    organizationId: ctx.organizationId,
    from: ctx.from,
    to: ctx.to,
    baseCurrency: ctx.baseCurrency,
    ...(ctx.fiscalYearId ? { fiscalYearId: ctx.fiscalYearId } : {}),
  }
  switch (type) {
    case ReportType.BALANCE: {
      const balance = buildBalance(lines, index, {
        ...period,
        variant: ctx.variant,
        snapshot: (ctx.params.snapshot as BalanceSnapshot | undefined) ?? "PRE_REGULARIZACION",
        resultAccountCode: ctx.resultAccountCode,
      })
      return { kind: "BALANCE", module: "lib/ledger/reports/balance.ts", result: balance, balance }
    }
    case ReportType.PYG: {
      const pyg = buildPyg(lines, index, { ...period, variant: ctx.variant })
      return { kind: "PYG", module: "lib/ledger/reports/pyg.ts", result: pyg, pyg }
    }
    case ReportType.CASHFLOW_DIRECTO:
    case ReportType.CASHFLOW_INDIRECTO: {
      const cfParams = { ...period, incomeTaxAccountCodes: ctx.incomeTaxAccountCodes }
      const directo = buildCashflowDirect(lines, index, cfParams)
      const indirecto = buildCashflowIndirect(lines, cfParams)
      return {
        kind: "CASHFLOW",
        module: "lib/ledger/reports/cashflow.ts",
        result: { directo, indirecto, efe: buildEfeView(directo, indirecto) },
        direct: directo,
      }
    }
    case ReportType.DASHBOARD: {
      const dashboard = buildDashboard(lines, index, {
        ...period,
        variant: ctx.variant,
        refDate: (ctx.params.refDate as LocalDate | undefined) ?? ctx.to,
        incomeTaxAccountCodes: ctx.incomeTaxAccountCodes,
        ...(typeof ctx.params.unpostedDocumentCount === "number"
          ? { unpostedDocumentCount: ctx.params.unpostedDocumentCount }
          : {}),
      })
      return { kind: "DASHBOARD", module: "lib/ledger/reports/dashboard.ts", result: dashboard, dashboard }
    }
    case ReportType.DIARIO: {
      const diario = buildDiario(ctx.entries ?? [], lines, [...index.byCode.values()], period)
      return {
        kind: "SUMMARY",
        module: "lib/ledger/reports/diario.ts",
        result: {
          entryCount: diario.entryCount,
          lineCount: diario.lineCount,
          totals: diario.totals,
          // El detalle NO se congela: se relee del diario, que es la fuente
          // única. Lo que el run sella es el RESUMEN y su `ledgerHash`.
          detalle: "Las líneas se releen del diario por `ledgerHash`; el run sella el resumen (D-E6-4)",
        },
      }
    }
    case ReportType.MAYOR: {
      const mayor = buildMayor(lines, [...index.byCode.values()], period)
      return {
        kind: "SUMMARY",
        module: "lib/ledger/reports/mayor.ts",
        result: {
          accountCount: mayor.accounts.length,
          totals: mayor.totals,
          closingBalanceSumCents: mayor.closingBalanceSumCents,
          saldosPorCuentaCents: Object.fromEntries(mayor.accounts.map((a) => [a.accountCode, a.closingBalanceCents])),
        },
      }
    }
    case ReportType.SUMAS_SALDOS: {
      const sumas = buildSumasSaldos(lines, [...index.byCode.values()], period)
      return {
        kind: "SUMMARY",
        module: "lib/ledger/reports/sumas-saldos.ts",
        result: {
          rowCount: sumas.rows.length,
          totals: sumas.totals,
          balanceTotals: sumas.balanceTotals,
        },
      }
    }
    default:
      throw new Error(`El tipo de informe ${type} no pasa todavía por getOrCreateReportRun`)
  }
}

/** KPI que miden los umbrales. Salen del informe, no se recalculan. */
function kpisOf(built: BuiltReport): KpiSnapshot {
  switch (built.kind) {
    case "SUMMARY":
      // El diario, el mayor y sumas y saldos no tienen KPI de gestión: son la
      // fuente, no una lectura de ella. Ningún umbral les aplica.
      return {}
    case "PYG":
      return {
        ingresos: built.pyg.byEpigraphNumberCents["1"] ?? 0,
        ebitda: built.pyg.ebitdaCents,
        resultado: built.pyg.resultadoDelEjercicioCents,
      }
    case "CASHFLOW":
      return { tesoreria: built.direct.closingCashCents }
    case "BALANCE":
      return { tesoreria: 0 }
    case "DASHBOARD":
      return Object.fromEntries(built.dashboard.kpis.map((k) => [k.key, k.cents]))
  }
}

/** Los mismos KPI leídos de un `result` ya persistido. */
function kpisOfStored(result: unknown): KpiSnapshot {
  const r = result as Record<string, unknown>
  if (Array.isArray(r?.kpis)) {
    return Object.fromEntries((r.kpis as { key: string; cents: number }[]).map((k) => [k.key, k.cents]))
  }
  if (r?.byEpigraphNumberCents) {
    const byNumber = r.byEpigraphNumberCents as Record<string, number>
    return {
      ingresos: byNumber["1"] ?? 0,
      ebitda: (r.ebitdaCents as number) ?? 0,
      resultado: (r.resultadoDelEjercicioCents as number) ?? 0,
    }
  }
  if (r?.directo) return { tesoreria: ((r.directo as Record<string, number>).closingCashCents ?? 0) }
  return {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Histórico y diff
// ─────────────────────────────────────────────────────────────────────────────

export type ReportRunFilter = {
  type?: ReportType
  from?: LocalDate
  to?: LocalDate
  seal?: Seal
  take?: number
  skip?: number
}

export async function listReportRuns(db: AnyClient, filter: ReportRunFilter = {}): Promise<ReportRunView[]> {
  const rows = await db.reportRun.findMany({
    where: {
      ...(filter.type ? { type: filter.type } : {}),
      ...(filter.seal ? { seal: filter.seal } : {}),
      ...(filter.from ? { periodStart: { gte: toUtcDate(filter.from) } } : {}),
      ...(filter.to ? { periodEnd: { lte: toUtcDate(filter.to) } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(filter.take ?? 50, 200),
    skip: filter.skip ?? 0,
  })
  return rows.map((r) => toView(r, "cache"))
}

export async function getReportRun(db: AnyClient, id: string): Promise<ReportRunView | null> {
  const row = await db.reportRun.findFirst({ where: { id } })
  return row ? toView(row, "cache") : null
}

/**
 * Run anterior con el que comparar. Nunca se compara con uno de OTRO informe ni
 * con otros parámetros: `paramsHash` acota la búsqueda, y por eso el balance
 * `PRE_REGULARIZACION` no se compara con el `POST_CIERRE`.
 */
async function previousRunFor(
  tx: TenantTransactionClient,
  input: { type: ReportType; periodStart: LocalDate; periodEnd: LocalDate; paramsHash: string; basis: ComparativeBasis }
) {
  if (input.basis === ComparativeBasis.NONE) return null
  const shift = input.basis === ComparativeBasis.PREVIOUS_PERIOD ? 0 : 1
  const previousStart = shiftYears(input.periodStart, shift)
  const previousEnd = shiftYears(input.periodEnd, shift)
  return await tx.reportRun.findFirst({
    where: {
      type: input.type,
      paramsHash: input.paramsHash,
      ...(shift > 0
        ? { periodStart: toUtcDate(previousStart), periodEnd: toUtcDate(previousEnd) }
        : { periodEnd: { lt: toUtcDate(input.periodStart) } }),
    },
    orderBy: { createdAt: "desc" },
  })
}

/** Un año atrás, sin construir `Date` con hora (29-feb incluido). */
export function shiftYears(date: LocalDate, years: number): LocalDate {
  if (years === 0) return date
  const [y, m, d] = date.split("-").map(Number)
  const ny = y - years
  const leap = (ny % 4 === 0 && ny % 100 !== 0) || ny % 400 === 0
  const day = m === 2 && d === 29 && !leap ? 28 : d
  return `${ny}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

export type ReportDiffRow = { path: string; currentCents: Cents; previousCents: Cents; deltaCents: Cents }

/**
 * Diff contra el run comparado. Es lo que hace auditables EV-1…EV-10: sin poder
 * reconstruir contra qué se midió la variación, el motivo del sello es una
 * afirmación sin respaldo (O-6).
 */
export async function diffAgainstPrevious(
  db: AnyClient,
  run: ReportRunView
): Promise<{ comparativeRunId: string | null; rows: ReportDiffRow[] }> {
  if (!run.comparativeRunId) return { comparativeRunId: null, rows: [] }
  const previous = await getReportRun(db, run.comparativeRunId)
  if (!previous) return { comparativeRunId: run.comparativeRunId, rows: [] }

  const flatten = (result: unknown): Map<string, Cents> => {
    const out = new Map<string, Cents>()
    const r = result as Record<string, unknown>
    for (const key of ["activo", "patrimonioNeto", "pasivo", "lines"]) {
      const rows = r?.[key]
      if (!Array.isArray(rows)) continue
      for (const row of rows as { path: string; cents: number }[]) out.set(`${key}:${row.path}`, row.cents)
    }
    return out
  }
  const current = flatten(run.result)
  const before = flatten(previous.result)
  const paths = [...new Set([...current.keys(), ...before.keys()])].sort()
  return {
    comparativeRunId: run.comparativeRunId,
    rows: paths.map((path) => {
      const c = current.get(path) ?? 0
      const p = before.get(path) ?? 0
      return { path, currentCents: c, previousCents: p, deltaCents: c - p }
    }),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ManualReviewFlag (ADMIN)
// ─────────────────────────────────────────────────────────────────────────────

export type ManualReviewInput = {
  periodStart: LocalDate
  periodEnd: LocalDate
  /** `null` = afecta a TODOS los informes del periodo. */
  scope?: ReportType | null
  reason: string
}

async function activeManualReviewFlag(tx: TenantTransactionClient, request: ReportRequest) {
  return await tx.manualReviewFlag.findFirst({
    where: {
      clearedAt: null,
      // Solapamiento de periodos, no igualdad: un flag sobre el ejercicio marca
      // también el informe de un trimestre suyo.
      periodStart: { lte: toUtcDate(request.periodEnd) },
      periodEnd: { gte: toUtcDate(request.periodStart) },
      OR: [{ scope: null }, { scope: request.type }],
    },
    orderBy: { createdAt: "desc" },
  })
}

export async function listManualReviewFlags(db: AnyClient, opts: { activeOnly?: boolean } = {}) {
  return await db.manualReviewFlag.findMany({
    where: opts.activeOnly ? { clearedAt: null } : {},
    orderBy: { createdAt: "desc" },
  })
}

/** Fuerza la revisión de un periodo. **ADMIN**, motivo obligatorio, `AuditLog`. */
export async function setManualReviewFlag(
  organizationId: string,
  input: ManualReviewInput,
  actor: Actor & { userId: string }
) {
  if (input.reason.trim().length < 10) {
    throw new Error("Forzar la revisión de un periodo exige un motivo de al menos 10 caracteres")
  }
  return await tenantTransaction(organizationId, actor.userId, async (tx) => {
    const flag = await tx.manualReviewFlag.create({
      data: {
        organizationId,
        periodStart: toUtcDate(input.periodStart),
        periodEnd: toUtcDate(input.periodEnd),
        scope: input.scope ?? null,
        reason: input.reason.trim(),
        createdById: actor.userId,
      },
    })
    await writeAuditLog(tx, {
      entity: "ManualReviewFlag",
      entityId: flag.id,
      action: "FORCE_REVIEW",
      after: flag,
      userId: actor.userId,
      reason: input.reason.trim(),
    })
    return flag
  })
}

/**
 * Limpia un flag. **No lo borra**: escribe `clearedAt`/`clearedById`/
 * `clearReason`, que es lo único que la base deja tocar (GRANT de columna +
 * trigger). El histórico de por qué un periodo estuvo bajo revisión no se pierde.
 */
export async function clearManualReviewFlag(
  organizationId: string,
  input: { id: string; reason: string },
  actor: Actor & { userId: string }
) {
  if (input.reason.trim().length < 10) {
    throw new Error("Levantar la revisión de un periodo exige un motivo de al menos 10 caracteres")
  }
  return await tenantTransaction(organizationId, actor.userId, async (tx) => {
    const before = await tx.manualReviewFlag.findFirst({ where: { id: input.id } })
    if (!before) throw new Error("El aviso de revisión no existe en esta organización")
    if (before.clearedAt) throw new Error("Ese aviso de revisión ya estaba levantado")
    const after = await tx.manualReviewFlag.update({
      where: { id: input.id },
      data: { clearedAt: new Date(), clearedById: actor.userId, clearReason: input.reason.trim() },
    })
    await writeAuditLog(tx, {
      entity: "ManualReviewFlag",
      entityId: input.id,
      action: "CLEAR_REVIEW",
      before,
      after,
      userId: actor.userId,
      reason: input.reason.trim(),
    })
    return after
  })
}

/** Umbrales de la organización, con los siete KPI por defecto si no hay nada. */
export function thresholdsOf(raw: Prisma.JsonValue | null | undefined): ReviewThresholds {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_REVIEW_THRESHOLDS
  const value = raw as Record<string, unknown>
  if (value.version !== 1) return DEFAULT_REVIEW_THRESHOLDS
  return {
    version: 1,
    comparativeBasis: (value.comparativeBasis as ReviewThresholds["comparativeBasis"]) ?? DEFAULT_REVIEW_THRESHOLDS.comparativeBasis,
    kpis: (value.kpis as ReviewThresholds["kpis"]) ?? DEFAULT_REVIEW_THRESHOLDS.kpis,
  }
}

export async function setReviewThresholds(
  organizationId: string,
  thresholds: ReviewThresholds,
  actor: Actor & { userId: string }
) {
  return await tenantTransaction(organizationId, actor.userId, async (tx) => {
    const before = await tx.organization.findFirstOrThrow({ select: { reviewThresholds: true } })
    const after = await tx.organization.update({
      where: { id: organizationId },
      data: { reviewThresholds: thresholds as unknown as Prisma.InputJsonValue },
    })
    await writeAuditLog(tx, {
      entity: "Organization",
      entityId: organizationId,
      action: "SET_THRESHOLDS",
      before: before.reviewThresholds,
      after: thresholds,
      userId: actor.userId,
    })
    return after.reviewThresholds
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel
// ─────────────────────────────────────────────────────────────────────────────

export async function getDashboard(
  organizationId: string,
  request: Omit<ReportRequest, "type">
): Promise<ReportRunView> {
  return await getOrCreateReportRun(organizationId, { ...request, type: ReportType.DASHBOARD })
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades
// ─────────────────────────────────────────────────────────────────────────────

async function accountCodeFor(tx: TenantTransactionClient, key: string): Promise<string | null> {
  const map = await getAccountMapByKey(tx)
  return map.get(key as AccountKey) ?? null
}

type StoredRun = {
  id: string
  type: ReportType
  periodStart: Date
  periodEnd: Date
  params: Prisma.JsonValue
  paramsHash: string
  ledgerHash: string
  analyticsHash: string | null
  analyticsKey: string
  gitSha: string
  result: Prisma.JsonValue
  resultKind: ResultKind
  provenance: Prisma.JsonValue
  validation: Prisma.JsonValue
  seal: Seal
  sealReasons: Prisma.JsonValue
  durationMs: number
  comparativeRunId: string | null
  comparativeBasis: ComparativeBasis | null
  createdAt: Date
}

function toView(row: StoredRun, origen: "fresh" | "cache"): ReportRunView {
  return {
    id: row.id,
    type: row.type,
    periodStart: fromUtcDate(row.periodStart),
    periodEnd: fromUtcDate(row.periodEnd),
    params: (row.params ?? {}) as Record<string, unknown>,
    paramsHash: row.paramsHash,
    ledgerHash: row.ledgerHash,
    analyticsHash: row.analyticsHash,
    analyticsKey: row.analyticsKey,
    gitSha: row.gitSha,
    result: row.result,
    resultKind: row.resultKind,
    provenance: row.provenance,
    validation: (row.validation ?? { checks: [] }) as { checks: CheckResult[] },
    seal: row.seal,
    sealReasons: (row.sealReasons ?? []) as unknown as ReportSealReason[],
    durationMs: row.durationMs,
    comparativeRunId: row.comparativeRunId,
    comparativeBasis: row.comparativeBasis,
    createdAt: row.createdAt,
    origen,
  }
}

export { reportRunKey, canonicalResultJson }
