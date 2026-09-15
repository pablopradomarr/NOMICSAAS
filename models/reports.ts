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
import type { AccountKey } from "@/lib/accounts/types"
import { fromUtcDate, toUtcDate } from "@/lib/ledger/dates"
import { buildBalance, computeI3, type BalanceReport } from "@/lib/ledger/reports/balance"
import {
  buildCashflowDirect,
  buildCashflowIndirect,
  buildEfeView,
  type CashflowDirectReport,
  type CashflowIndirectReport,
  type CashflowLineDetail,
  type EfeReport,
} from "@/lib/ledger/reports/cashflow"
import { buildDashboard, type DashboardReport } from "@/lib/ledger/reports/dashboard"
import { buildPyg, type PygReport } from "@/lib/ledger/reports/pyg"
import { runReportInvariants } from "@/lib/ledger/reports/invariants-e6"
import { buildThresholdContext } from "@/lib/ledger/reports/threshold-context"
import type { ReportEntry, ReportLine, StatementAccount } from "@/lib/ledger/reports/types"
import { buildAccountIndex, type BalanceSnapshot } from "@/lib/ledger/reports/types"
import {
  analyticsKeyOf,
  canonicalResultJson,
  checkThresholds,
  parseReviewThresholds,
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
import type { ProvenanceContext } from "@/lib/ledger/provenance"
import { getAccountMapByKey } from "@/models/account-map"
import type { Actor } from "@/models/accounts"
import { writeAuditLog } from "@/models/audit-log"
import { buildDiario } from "@/lib/ledger/reports/diario"
import { buildMayor } from "@/lib/ledger/reports/mayor"
import { buildSumasSaldos } from "@/lib/ledger/reports/sumas-saldos"
import { getAnalyticPnl } from "@/models/margins"
import type { AnalyticPnl } from "@/lib/analytics/margins"
import {
  getAllocationRuleSpecs,
  getAppliedAllocations,
  getSealedRunRefs,
  type AppliedAllocations,
} from "@/models/allocations"
import { activeBudgetAt, getBudgetVersion } from "@/models/budget"
import { getEmployeeRateRows, listHeadcount } from "@/models/employees"
import { getTimeRowsForWindow } from "@/models/time"
import { budgetHash as computeBudgetHash, type ComposedBudget } from "@/lib/budget/hash"
import { fiscalYearMonths, monthKey } from "@/lib/budget/types"
import { buildBudgetMatrix, settleBudgetMatrix } from "@/lib/budget/matrix"
import {
  budgetProvenanceByCell,
  buildVariance,
  maxDimensionVariance,
  type BudgetProvenanceContext,
  type VarianceCell,
} from "@/lib/budget/variance"
import { buildForecast } from "@/lib/budget/forecast"
import { minutesByTarget, unapprovedMinutesByTarget, type HeadcountRow, type TimeEntryRow } from "@/lib/time/aggregate"
import {
  DEFAULT_PAYROLL_ACCOUNT_PREFIXES,
  absorptionVariance,
  costOfTime,
  type EmployeeRateRow,
} from "@/lib/time/cost"
import { budgetReviewReasons } from "@/lib/ledger/report-run"
import { buildAnalyticPnl } from "@/lib/analytics/margins"
import type { AllocationRuleSpec } from "@/lib/analytics/allocate"
import type { AnalyticLine, AnalyticsConfig } from "@/lib/analytics/types"
import { getAnalyticLines, getAnalyticsConfig } from "@/models/analytics"
import { EMPTY_RUN_SET_HASH, allocationRunSetHash, analyticsHash as computeAnalyticsHash, marginConfigHash } from "@/lib/analytics/hash"
import { getEntries, getLinesForPeriod, computeLedgerHash } from "@/models/ledger"
import { CheckFamily, ComparativeBasis, PgcVariant, Prisma, ReportType, ResultKind, Seal } from "@/prisma/client"

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
  /**
   * N1 — punto de inyección **sólo para tests**: se ejecuta entre la fase 1 (que
   * fija la clave) y la fase 2 (que lee las líneas), para simular que alguien
   * postea justo en medio. En producción nadie lo pasa.
   */
  onPhaseBoundary?: () => Promise<void>
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
  // #6: el `lineDetail` del cashflow y los pares del drill-down crecen con el
  // diario; con un ejercicio grande revientan la cota de 1 MB del `result`. El
  // run guarda las cifras y el detalle se recalcula bajo demanda.
  // E7 · ADR-0015 D4: `CASHFLOW` unificado. Los dos viejos siguen aquí para que
  // un run histórico sin migrar se lea igual que siempre.
  ReportType.CASHFLOW,
  ReportType.CASHFLOW_DIRECTO,
  ReportType.CASHFLOW_INDIRECTO,
])

/**
 * **E10 · T13 — ya no queda ninguno.** `PRESUPUESTO_REAL` sale de aquí (deuda
 * §0-bis #9) y tiene su propio camino, `budgetVsActual()`: necesita un noveno
 * componente de clave, un rechazo previo y una previsualización sin fila, tres
 * cosas que el pipeline genérico no tiene. El conjunto se conserva vacío a
 * propósito: el día que se declare un tipo nuevo en el enum, rechazarlo en
 * runtime vuelve a ser una línea.
 */
const NOT_IMPLEMENTED: ReadonlySet<ReportType> = new Set<ReportType>()

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
    throw new Error(`El informe ${request.type} no se emite todavía`)
  }
  if (request.type === ReportType.PRESUPUESTO_REAL) {
    throw new Error(
      "E10 · PRESUPUESTO_REAL se pide con `budgetVsActual()`: necesita la versión de presupuesto, el corte " +
        "del forecast y la regla de comparabilidad, que no caben en `ReportRequest`"
    )
  }
  const startedAt = Date.now()
  const gitSha = currentGitSha()
  const userId = request.actor?.userId ?? undefined

  // N1 — el diario puede moverse ENTRE la fase 1 (que fija la clave) y la fase 2
  // (que lee las líneas). Si eso pasa, el run se guardaría con el `ledgerHash`
  // de antes y las cifras de después: un informe sellado que miente sobre de
  // dónde salen sus números, y encima envenena la caché. La fase 2 vuelve a
  // calcular el hash EN SU MISMA transacción y, si no coincide, se reintenta
  // desde el principio — el mismo patrón que `getCashflowBucketDetail`, que
  // niega el drill-down cuando el diario ya no es el del run.
  for (let attempt = 1; attempt <= MAX_REPORT_ATTEMPTS; attempt++) {
    const result = await attemptReportRun(organizationId, request, { startedAt, gitSha, userId })
    if (result !== RETRY) return result
  }
  throw new Error(
    "El diario cambió tres veces mientras se emitía el informe: vuelve a pedirlo. " +
      "Si se repite, hay un proceso posteando en bucle sobre este periodo."
  )
}

/** N1: tres intentos. Con más, un diario muy activo dejaría el informe colgado. */
const MAX_REPORT_ATTEMPTS = 3

/** Señal de «el diario se movió entre fases»: hay que rehacer la clave. */
const RETRY = Symbol("report-run-retry")

async function attemptReportRun(
  organizationId: string,
  request: ReportRequest,
  env: { startedAt: number; gitSha: string; userId: string | undefined }
): Promise<ReportRunView | typeof RETRY> {
  const { startedAt, gitSha, userId } = env

  // ── FASE 1 — clave y caché, SIN leer el diario (#7) ──────────────────────
  //
  // Todo lo que compone la clave sale de agregados baratos. Una petición que
  // acierta en caché —la mayoría— no materializa ni una línea, y la transacción
  // dura lo que dura un `SELECT`. Antes se leía el diario entero, el plan y el
  // comparativo ANTES de mirar la caché: con varios informes en pantalla eso
  // agotaba el pool y mataba transacciones ajenas por «expired transaction»
  // (BLOQUEA #1 de la revisión).
  const key = await tenantTransaction(organizationId, userId, async (tx) => {
    const organization = await tx.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { baseCurrency: true, pgcVariant: true, reviewThresholds: true },
    })
    const ledgerHash = await computeLedgerHash(tx, {
      ...(request.fiscalYearId ? { fiscalYearId: request.fiscalYearId } : {}),
      from: request.periodStart,
      to: request.periodEnd,
    })
    const planHash = await computePlanHash(tx)
    const accountMapHash = await computeAccountMapHash(tx)

    // El sello analítico también forma parte de la clave: sin él, una
    // reimputación (E5) devolvería el informe viejo.
    let analyticsHash: string | null = null
    let marginHash: string | null = null
    // BLOQUEA #2 — el CUARTO sello llega al `ReportRun`. Antes se creaba
    // siempre sin imputaciones y la columna `allocation_run_set_hash` no la
    // escribía ningún camino de producción: liquidar NO caducaba el
    // `PYG_ANALITICA` sellado y el informe persistido del periodo seguía siendo
    // el NO imputado mientras la pantalla mostraba el imputado. Dos verdades
    // para el mismo periodo, que es lo que la capa de fiabilidad existe para
    // impedir (ADR-0013 D3, criterio 17).
    const withAllocations = ANALYTICS_TYPES.has(request.type) && request.params.withAllocations === true
    let allocationSetHash: string | null = null
    if (ANALYTICS_TYPES.has(request.type)) {
      const config = await getAnalyticsConfig(tx, { periodEnd: request.periodEnd })
      const analyticLines = await getAnalyticLines(tx, {
        from: request.periodStart,
        to: request.periodEnd,
        ...(request.fiscalYearId ? { fiscalYearId: request.fiscalYearId } : {}),
      })
      marginHash = marginConfigHash(config)
      // Sin imputaciones el tercer componente es `sha256("")` y la columna queda
      // NULL (el trigger compone «∅»); con imputaciones es el hash del CONJUNTO
      // de runs vigentes, el mismo que calcula `models/margins.ts`. Basta con
      // sellar una liquidación nueva para que la clave cambie y el informe
      // anterior deje de servirse de caché.
      const runSetHash = withAllocations
        ? allocationRunSetHash((await getSealedRunRefs(tx, { from: request.periodStart, to: request.periodEnd })).map((r) => r.id))
        : EMPTY_RUN_SET_HASH
      allocationSetHash = withAllocations ? runSetHash : null
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
        runSetHash
      )
    }
    const activeFlag = await activeManualReviewFlag(tx, request)
    const { hashed, context } = splitParams(request, organization.baseCurrency, {
      planHash,
      accountMapHash,
      reviewFlagId: activeFlag?.id ?? null,
    })
    const paramsHash = paramsHashOf(hashed)
    // E5 · O-E5-7: sin imputaciones, el tercer componente es el centinela; con
    // ellas, el `allocationRunSetHash` real. Es EXACTAMENTE lo que compone el
    // trigger `app.report_runs_analytics_key`, y hay un test de integración que
    // comprueba que los dos coinciden.
    const analyticsKey = analyticsKeyOf({
      analyticsHash,
      marginConfigHash: marginHash,
      allocationRunSetHash: allocationSetHash,
    })

    const cached =
      request.noCache === true
        ? null
        : await tx.reportRun.findFirst({
            where: {
              type: request.type,
              periodStart: toUtcDate(request.periodStart),
              periodEnd: toUtcDate(request.periodEnd),
              paramsHash,
              ledgerHash,
              analyticsKey,
              gitSha,
            },
            orderBy: { createdAt: "desc" },
          })

    return {
      organization,
      ledgerHash,
      planHash,
      accountMapHash,
      analyticsHash,
      marginHash,
      allocationSetHash,
      withAllocations,
      analyticsKey,
      hashed,
      context,
      paramsHash,
      activeFlagReason: activeFlag?.reason ?? null,
      cached,
    }
  })

  if (key.cached) return toView(key.cached, "cache")

  // Punto de inyección de los tests: simula que alguien postea justo entre la
  // fase 1 y la fase 2. En producción no existe.
  if (request.onPhaseBoundary) await request.onPhaseBoundary()

  // ── FASE 2 — lectura y cálculo ───────────────────────────────────────────
  //
  // La lectura va en su propia transacción, con presupuesto explícito; el
  // CÁLCULO ocurre FUERA de ella, porque el motor es puro y no necesita
  // conexión. Mantener el pool ocupado mientras se construye un árbol de
  // epígrafes es exactamente lo que agotaba el pool.
  const inputs = await tenantTransaction(
    organizationId,
    userId,
    async (tx) => {
      // N1: el hash se recalcula AQUÍ, en la misma transacción y antes de leer,
      // de modo que las líneas que vienen a continuación son exactamente las que
      // ese hash sella.
      const ledgerHashNow = await computeLedgerHash(tx, {
        ...(request.fiscalYearId ? { fiscalYearId: request.fiscalYearId } : {}),
        from: request.periodStart,
        to: request.periodEnd,
      })
      if (ledgerHashNow !== key.ledgerHash) return RETRY

      const lines = await getLinesForPeriod(tx, {
        from: request.periodStart,
        to: request.periodEnd,
        ...(request.fiscalYearId ? { fiscalYearId: request.fiscalYearId } : {}),
      })
      const accounts = await getStatementAccounts(tx)
      const resultAccountCode = await accountCodeFor(tx, "RESULTADO_EJERCICIO")
      const incomeTaxAccountCodes = [
        await accountCodeFor(tx, "HP_ACREEDORA_IS"),
        await accountCodeFor(tx, "HP_DEUDORA_IS"),
      ].filter((c): c is string => c !== null)

      const basis = (request.comparativeBasis ??
        parseReviewThresholds(key.organization.reviewThresholds).comparativeBasis) as ComparativeBasis
      const comparative = await comparativeWindow(tx, {
        basis,
        periodStart: request.periodStart,
        periodEnd: request.periodEnd,
        currentFiscalYearId: request.fiscalYearId,
      })

      const previous = await previousRunFor(tx, {
        type: request.type,
        periodStart: request.periodStart,
        periodEnd: request.periodEnd,
        paramsHash: key.paramsHash,
        basis,
        definingParams: key.hashed,
      })
      // El «informe anterior» con el que se miden EV-7, EV-8, EV-10 y el drift NO
      // se puede buscar por `paramsHash`: el hash incluye el `planHash`, así que
      // justo cuando alguien reclasifica una cuenta —el caso que EV-10 existe
      // para cazar— el hash cambia y no habría anterior con el que comparar. Se
      // busca por tipo y periodo, y se filtra por lo que hace comparables dos
      // informes (la foto y el modelo).
      const lastCandidates = await tx.reportRun.findMany({
        where: {
          type: request.type,
          periodStart: toUtcDate(request.periodStart),
          periodEnd: toUtcDate(request.periodEnd),
        },
        orderBy: { createdAt: "desc" },
        take: 25,
        select: { gitSha: true, analyticsHash: true, ledgerHash: true, createdAt: true, params: true },
      })
      const lastSameKey = lastCandidates.find((run) => comparableParams(run.params, key.hashed)) ?? null

      // A1 / I-E6-20 y EV-10: sólo tiene sentido preguntarlo si hay un run
      // anterior del mismo informe con el que comparar.
      let unexplainedDrift: { previousHash: string; currentHash: string } | null = null
      let driftCheck: { previousHash: string; currentHash: string; explainingChanges: number } | null = null
      let reclassified: string[] = []
      if (lastSameKey) {
        if (lastSameKey.ledgerHash !== key.ledgerHash) {
          const changes = await ledgerChangesSince(tx, lastSameKey.createdAt, {
            from: request.periodStart,
            to: request.periodEnd,
            ...(request.fiscalYearId ? { fiscalYearId: request.fiscalYearId } : {}),
          })
          driftCheck = {
            previousHash: lastSameKey.ledgerHash,
            currentHash: key.ledgerHash,
            explainingChanges: changes,
          }
          if (changes === 0) {
            unexplainedDrift = { previousHash: lastSameKey.ledgerHash, currentHash: key.ledgerHash }
          }
        }
        reclassified = await reclassifiedAccountsSince(tx, lastSameKey.createdAt, {
          from: comparative?.from ?? request.periodStart,
          to: comparative?.to ?? request.periodEnd,
        })
      }

      // EV-6: dimensiones vivas en los dos periodos.
      const dimensionsCurrent = await dimensionsInPeriod(tx, {
        from: request.periodStart,
        to: request.periodEnd,
        ...(request.fiscalYearId ? { fiscalYearId: request.fiscalYearId } : {}),
      })
      const dimensionsPrevious = comparative
        ? await dimensionsInPeriod(tx, { from: comparative.from, to: comparative.to })
        : []

      // #8: el libro diario cuenta EN LA BASE y pagina; si no cabe entero, se
      // declara truncado — nunca se sirve un diario a medias como si fuera todo.
      const journal =
        request.type === ReportType.DIARIO
          ? await readJournalHeaders(tx, request)
          : null

      const analyticReport =
        request.type === ReportType.PYG_ANALITICA
          ? await getAnalyticPnl(tx, {
              from: request.periodStart,
              to: request.periodEnd,
              ...(request.fiscalYearId ? { fiscalYearId: request.fiscalYearId } : {}),
              // BLOQUEA #2: el informe SELLADO es el mismo que la pantalla.
              withAllocations: key.withAllocations,
              provenance: { runId: randomUUID(), gitSha, baseCurrency: key.organization.baseCurrency },
            })
          : null

      return {
        lines,
        accounts,
        resultAccountCode,
        incomeTaxAccountCodes,
        basis,
        comparative,
        previous,
        lastSameKey,
        unexplainedDrift,
        driftCheck,
        reclassified,
        dimensionsCurrent,
        dimensionsPrevious,
        journal,
        analyticReport,
      }
    },
    REPORT_READ_BUDGET
  )
  if (inputs === RETRY) return RETRY

  // ── Cálculo puro, sin conexión ───────────────────────────────────────────
  const runId = randomUUID()
  const index = buildAccountIndex(inputs.accounts)
  const provenanceCtx = {
    runId,
    ledgerHash: key.ledgerHash,
    gitSha,
    baseCurrency: key.organization.baseCurrency,
    module: "lib/ledger/reports",
  }
  // A3 (auditor): la variante se VALIDA antes de construir. Un `params.variant`
  // con cualquier otra cosa elegiría la columna de epígrafe equivocada en
  // silencio y el balance saldría con partidas en el sitio de nadie.
  const variant = parseVariant(key.hashed.variant, key.organization.pgcVariant)

  const period = {
    organizationId,
    from: request.periodStart,
    to: request.periodEnd,
    baseCurrency: key.organization.baseCurrency,
    ...(request.fiscalYearId ? { fiscalYearId: request.fiscalYearId } : {}),
  }

  const built = inputs.analyticReport
    ? ({
        kind: "SUMMARY" as const,
        module: "lib/analytics/margins.ts",
        // El `result` que se PERSISTE es una proyección serializable de la
        // matriz: fuera `levelTotalsBig` (los mismos totales en `BigInt`, que
        // `canonicalResultJson` no sabe serializar y que duplican
        // `levelTotalsCents`), fuera `coveredLineIds` (un `Set`, que se
        // serializaría como `{}` sin decir nada) y fuera `lineDetail`, que
        // crece con el diario y revienta la cota de 1 MB del `result` — el
        // drill-down lo recalcula bajo demanda, como en el cashflow (#6 de E6).
        result: analyticResultOf(inputs.analyticReport.pnl),
      })
    : buildReport(
        request.type,
        inputs.lines,
        index,
        {
          ...period,
          variant,
          params: { ...key.hashed, ...key.context },
          resultAccountCode: inputs.resultAccountCode ?? "129",
          incomeTaxAccountCodes: inputs.incomeTaxAccountCodes,
          ...(inputs.journal ? { entries: inputs.journal.entries, journalTruncated: inputs.journal.truncated } : {}),
          ...(inputs.comparative ? { comparative: inputs.comparative } : {}),
        },
        provenanceCtx
      )

  const checks = runReportInvariants({
    lines: inputs.lines,
    accounts: index,
    resultAccountCode: inputs.resultAccountCode ?? "129",
    ...period,
    incomeTaxAccountCodes: inputs.incomeTaxAccountCodes,
    // A1 / I-E6-20: el check sale en `validacion.json` junto a los demás.
    ledgerDrift: inputs.driftCheck,
    ...(built.kind === "DASHBOARD"
      ? { dashboard: built.dashboard, aging: [built.dashboard.aging.clientes, built.dashboard.aging.proveedores] }
      : {}),
  })
  // BLOQUEA #3 — I4, los doce `I-E4-*` y, con imputaciones, I5 y los doce
  // `I-E5-*` entran en la VALIDACIÓN del run: son los que acreditan la cifra que
  // el informe sella, y un FAIL lo pasa a `REQUIERE REVISIÓN` por `EV-9`.
  if (inputs.analyticReport) checks.push(...inputs.analyticReport.checks)
  if (inputs.journal?.truncated) {
    checks.push({
      id: "I-E6-DIARIO-TRUNCADO",
      status: "WARN",
      evidencia:
        `El libro diario del periodo tiene ${inputs.journal.total} asientos y el run guarda ` +
        `${inputs.journal.entries.length}: el resumen es parcial y así se declara en \`result.truncado\``,
    })
  }

  // #2 — los atenuantes EV-1/3/5/6, CALCULADOS sobre el diario.
  const thresholds = parseReviewThresholds(key.organization.reviewThresholds)
  const thresholdCtx = {
    ...buildThresholdContext({
      lines: inputs.lines,
      entries: inputs.journal?.entries,
      index,
      variant,
      ...(request.fiscalYearId ? { fiscalYearId: request.fiscalYearId } : {}),
      dimensionsCurrent: inputs.dimensionsCurrent,
      dimensionsPrevious: inputs.dimensionsPrevious,
    }),
    comparativeBasis: inputs.basis as never,
  }
  const breaches = checkThresholds(
    kpisOf(built),
    inputs.previous ? kpisOfStored(inputs.previous.result) : null,
    thresholds,
    thresholdCtx
  )

  const i3Check = checks.find((c) => c.id === "I-E6-13")
  const reasons = reportSealReasons({
    checks,
    breaches,
    always: {
      gitSha,
      lastGitSha: inputs.lastSameKey?.gitSha ?? null,
      analyticsHash: key.analyticsHash,
      lastAnalyticsHash: inputs.lastSameKey?.analyticsHash ?? null,
      manualReviewReason: key.activeFlagReason,
      ...(inputs.reclassified.length > 0 ? { reclassifiedAccounts: inputs.reclassified } : {}),
      ...(inputs.unexplainedDrift ? { ledgerDrift: inputs.unexplainedDrift } : {}),
      ...(planDriftOf(inputs.lastSameKey?.params, key) ?? {}),
      ...(i3Check?.status === "FAIL"
        ? { regularizacionDesfasada: regularizacionCifras(inputs.lines, inputs.resultAccountCode ?? "129") }
        : {}),
    },
  })
  const seal = sealOf(reasons) === "VALIDADO_AUTOMATICAMENTE" ? Seal.VALIDADO_AUTOMATICAMENTE : Seal.REQUIERE_REVISION

  const provenance = {
    runId,
    ledgerHash: `sha256:${key.ledgerHash}`,
    planHash: `sha256:${key.planHash}`,
    accountMapHash: `sha256:${key.accountMapHash}`,
    gitSha,
    module: built.module,
    generatedFrom: "journal_lines",
  }

  // ── FASE 3 — persistencia, en una transacción corta ──────────────────────
  const durationMs = Math.max(0, Date.now() - startedAt)
  const storedParams = { ...key.hashed, ...key.context }
  return await tenantTransaction(organizationId, userId, async (tx) => {
    await tx.$executeRaw`
      INSERT INTO report_runs (
        id, organization_id, type, period_start, period_end, fiscal_year_id,
        params, params_hash, ledger_hash, analytics_hash, margin_config_hash, allocation_run_set_hash, git_sha,
        result, result_kind, provenance, validation, seal, seal_reasons, duration_ms,
        comparative_run_id, comparative_basis, created_by_id
      ) VALUES (
        ${runId}::uuid, ${organizationId}::uuid, ${request.type}::report_type,
        ${toUtcDate(request.periodStart)}::date, ${toUtcDate(request.periodEnd)}::date,
        ${request.fiscalYearId ?? null}::uuid,
        ${JSON.stringify(storedParams)}::jsonb, ${key.paramsHash}, ${key.ledgerHash},
        ${key.analyticsHash}, ${key.marginHash}, ${key.allocationSetHash}, ${gitSha},
        ${canonicalResultJson(built.result)}::jsonb,
        ${resultKindOf(request.type)}::result_kind,
        ${JSON.stringify(provenance)}::jsonb,
        ${JSON.stringify({ checks })}::jsonb,
        ${seal}::seal,
        ${JSON.stringify(reasons)}::jsonb,
        ${durationMs},
        ${inputs.previous?.id ?? null}::uuid,
        ${inputs.previous ? inputs.basis : null}::comparative_basis,
        ${request.actor?.userId ?? null}::uuid
      )
      -- La clave es un índice único, no una constraint con nombre: se declara
      -- por columnas. Dos peticiones simultáneas del mismo informe no producen
      -- dos runs ni un error al usuario; gana el primero y el segundo relee.
      -- E10 · M5: budget_hash entra en la clave. Mientras PRESUPUESTO_REAL no
      -- esté implementado (T13) todo run nace con el centinela por DEFAULT, así
      -- que la lista de columnas tiene que nombrarlo o el ON CONFLICT no
      -- encuentra el índice (42P10).
      ON CONFLICT (organization_id, type, period_start, period_end, params_hash, ledger_hash, analytics_key, git_sha, budget_hash)
      DO NOTHING`

    const stored = await tx.reportRun.findFirstOrThrow({
      where: {
        type: request.type,
        periodStart: toUtcDate(request.periodStart),
        periodEnd: toUtcDate(request.periodEnd),
        paramsHash: key.paramsHash,
        ledgerHash: key.ledgerHash,
        analyticsKey: key.analyticsKey,
        gitSha,
      },
      orderBy: { createdAt: "desc" },
    })
    return toView(stored, stored.id === runId ? "fresh" : "cache")
  })
}

/**
 * Proyección serializable de la PyG analítica para el `result` del `ReportRun`.
 * Todo lo que la pantalla pinta y la exportación necesita; nada que no sepa
 * pasar por `canonicalResultJson`.
 */
function analyticResultOf(pnl: AnalyticPnl): Record<string, unknown> {
  const { levelTotalsBig, coveredLineIds, lineDetail, ...rest } = pnl
  void levelTotalsBig
  void coveredLineIds
  void lineDetail
  return { ...rest, lineCountDetail: lineDetail.length } as unknown as Record<string, unknown>
}

/**
 * Presupuesto de la LECTURA de un informe. El de Prisma por defecto son 5 s, que
 * se quedan cortos con un ejercicio grande y abortan a mitad («Transaction
 * already closed») dejando al usuario sin informe.
 */
const REPORT_READ_BUDGET = {
  timeout: 30_000,
  maxWait: 10_000,
  /**
   * N1 — `RepeatableRead`: el `ledgerHash` que se recalcula al entrar y las
   * líneas que se leen después salen del MISMO snapshot, aunque alguien
   * contabilice mientras dura la lectura. El recálculo del hash y el reintento
   * siguen ahí como red (y son los que actúan si esta transacción resulta ser
   * reentrante dentro de la de la petición, donde el nivel ya lo fijó el
   * llamante).
   */
  isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
}

/** Cota del diario que cabe en el `result` (#8). Por encima, se declara truncado. */
export const MAX_JOURNAL_ENTRIES_IN_RUN = 5_000

/**
 * #8 — cabeceras del libro diario, CONTADAS en la base y paginadas. Si el
 * periodo tiene más de las que caben en el `result`, se devuelve lo que cabe y
 * se marca `truncated`: el run lo declara y el sello lo advierte, en vez de
 * presentar medio diario como si fuera el diario.
 */
async function readJournalHeaders(
  tx: TenantTransactionClient,
  request: ReportRequest
): Promise<{ entries: ReportEntry[]; total: number; truncated: boolean }> {
  const filter = request.fiscalYearId ? { fiscalYearId: request.fiscalYearId } : {}
  const total = await tx.journalEntry.count({
    where: {
      ...(request.fiscalYearId ? { fiscalYearId: request.fiscalYearId } : {}),
      entryDate: { gte: toUtcDate(request.periodStart), lte: toUtcDate(request.periodEnd) },
    },
  })
  const entries: ReportEntry[] = []
  const PAGE = 1_000
  for (let skip = 0; skip < Math.min(total, MAX_JOURNAL_ENTRIES_IN_RUN); skip += PAGE) {
    const page = await getEntries(tx, filter, { skip, take: PAGE })
    if (page.entries.length === 0) break
    for (const e of page.entries) {
      entries.push({
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
    }
  }
  return { entries, total, truncated: total > MAX_JOURNAL_ENTRIES_IN_RUN }
}

/**
 * #4 — parámetros que DEFINEN el informe (entran en el hash) separados del
 * contexto de la petición (no entra).
 *
 * `refDate` se queda DENTRO del hash a propósito, en contra de la lectura
 * literal de la revisión: no es contexto, es la fecha de referencia del aging y
 * por tanto una cifra del informe. Sacarla serviría de caché un aging calculado
 * a otra fecha, que es justo el bug que `paramsHash` existe para evitar.
 * `unpostedDocumentCount` sí sale: cuenta documentos que NO están en el informe,
 * cambia con cada subida y sólo serviría para invalidar la caché sin motivo (la
 * cifra viva la pone la acción, no el run).
 */
function splitParams(
  request: ReportRequest,
  baseCurrency: string,
  derived: { planHash: string; accountMapHash: string; reviewFlagId: string | null }
): { hashed: Record<string, unknown>; context: Record<string, unknown> } {
  const { unpostedDocumentCount, ...rest } = request.params as Record<string, unknown>
  // #14 (parcial): `method`, `granularity` y `view` NO definen las cifras — el
  // run del cashflow trae SIEMPRE las tres vistas—, así que salen del hash y no
  // fragmentan la caché en tres runs idénticos.
  const { method, granularity, view, ...defining } = rest
  return {
    // #12: primero lo que pide el cliente, y DESPUÉS lo que deriva el servidor.
    // Al revés, un `planHash` en la petición pisaría el real y la caché serviría
    // el informe del plan equivocado.
    hashed: { ...defining, currency: baseCurrency, planHash: derived.planHash, accountMapHash: derived.accountMapHash, ...(derived.reviewFlagId ? { reviewFlagId: derived.reviewFlagId } : {}) },
    context: {
      ...(method !== undefined ? { method } : {}),
      ...(granularity !== undefined ? { granularity } : {}),
      ...(view !== undefined ? { view } : {}),
      ...(unpostedDocumentCount !== undefined ? { unpostedDocumentCount } : {}),
    },
  }
}

/** A3 — `params.variant` validado contra el enum, con la de la organización de respaldo. */
function parseVariant(raw: unknown, fallback: PgcVariant): PgcVariant {
  if (raw === undefined || raw === null) return fallback
  if (raw === PgcVariant.GENERAL || raw === PgcVariant.PYMES) return raw
  throw new Error(`params.variant inválido: «${String(raw)}». Admitidos: GENERAL | PYMES`)
}

/** #5 — ¿cambió el plan o el mapa desde el informe anterior del mismo tipo? */
function planDriftOf(
  previousParams: Prisma.JsonValue | undefined,
  key: { planHash: string; accountMapHash: string }
): { planDrift: { what: "plan" | "mapa"; previous: string; current: string } } | null {
  if (!previousParams || typeof previousParams !== "object" || Array.isArray(previousParams)) return null
  const before = previousParams as Record<string, unknown>
  if (typeof before.planHash === "string" && before.planHash !== key.planHash) {
    return { planDrift: { what: "plan", previous: before.planHash, current: key.planHash } }
  }
  if (typeof before.accountMapHash === "string" && before.accountMapHash !== key.accountMapHash) {
    return { planDrift: { what: "mapa", previous: before.accountMapHash, current: key.accountMapHash } }
  }
  return null
}

/** Las DOS cifras de I-E6-13, para que el motivo del sello las enseñe. */
function regularizacionCifras(
  lines: readonly ReportLine[],
  resultAccountCode: string
): { i3Cents: Cents; saldo129Cents: Cents } {
  return {
    i3Cents: computeI3(lines),
    saldo129Cents: lines
      .filter((l) => l.accountCode === resultAccountCode && l.entryKind !== "CLOSING")
      .reduce((a, l) => a + l.debitCents - l.creditCents, 0),
  }
}

/**
 * #6 — el cashflow guarda RESUMEN: su `lineDetail` y los pares del drill-down
 * crecen con el diario y reventarían la cota de 1 MB del `result`. El detalle se
 * recalcula bajo demanda con `getCashflowBucketDetail`, igual que E4 hace con la
 * celda de la matriz analítica.
 */
function resultKindOf(type: ReportType): "SUMMARY" | "FULL" {
  return SUMMARY_TYPES.has(type) ? "SUMMARY" : "FULL"
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
  /** Ventana comparativa YA leída (§8.7). */
  comparative?: ComparativeWindow
  /** #8: el periodo tiene más asientos de los que caben en el `result`. */
  journalTruncated?: boolean
}

/**
 * Periodo con el que se compara y sus líneas, ya leídas. `fiscalYearId` es el
 * del ejercicio ANTERIOR: sin él, el balance comparativo filtraría por el
 * ejercicio en curso y saldría vacío.
 */
export type ComparativeWindow = {
  lines: readonly ReportLine[]
  from: LocalDate
  to: LocalDate
  fiscalYearId?: string
  label: string
  basis: ComparativeBasis
}

/**
 * Resuelve la ventana comparativa y LEE sus líneas.
 *
 * Base por defecto `SAME_PERIOD_PREVIOUS_YEAR` (§8.7): en una empresa de
 * proyectos la estacionalidad es fortísima y comparar un trimestre contra el
 * ejercicio anterior completo compara cuatro meses con doce.
 *
 * Si el ejercicio anterior **no existe**, se devuelve `null` y las celdas salen
 * sin `previousCents`: la UI pinta «sin comparativo». Nunca un cero, que sería
 * una cifra y afirmaría algo falso.
 */
async function comparativeWindow(
  tx: TenantTransactionClient,
  input: {
    basis: ComparativeBasis
    periodStart: LocalDate
    periodEnd: LocalDate
    currentFiscalYearId?: string
  }
): Promise<ComparativeWindow | null> {
  if (input.basis === ComparativeBasis.NONE) return null

  const from = shiftYears(input.periodStart, 1)
  const to = shiftYears(input.periodEnd, 1)

  // El ejercicio anterior es el que CONTIENE la fecha de corte desplazada, no
  // «el de código − 1»: los ejercicios pueden no ser naturales ni consecutivos.
  const previousFy = await tx.fiscalYear.findFirst({
    where: { startDate: { lte: toUtcDate(to) }, endDate: { gte: toUtcDate(to) } },
  })
  if (!previousFy || previousFy.id === input.currentFiscalYearId) return null

  const lines = await getLinesForPeriod(tx, { from, to, fiscalYearId: previousFy.id })
  if (lines.length === 0) return null

  return {
    lines,
    from,
    to,
    fiscalYearId: previousFy.id,
    label: `${from} … ${to}`,
    basis: input.basis,
  }
}

type BuiltReport =
  | { kind: "BALANCE"; module: string; result: BalanceReport; balance: BalanceReport }
  | { kind: "PYG"; module: string; result: PygReport; pyg: PygReport }
  | {
      kind: "CASHFLOW"
      module: string
      /** `directo` va SIN `lineDetail` ni `provenanceByBucket` (#6): resumen. */
      result: {
        directo: Omit<CashflowDirectReport, "lineDetail" | "provenanceByBucket"> & { drillDown: string }
        indirecto: CashflowIndirectReport
        efe: EfeReport
      }
      /** El informe COMPLETO, para los KPI y los invariantes de este run. */
      direct: CashflowDirectReport
    }
  | { kind: "DASHBOARD"; module: string; result: DashboardReport; dashboard: DashboardReport }
  // T19: el diario, el mayor y sumas y saldos pasan también por `ReportRun`,
  // pero con `resultKind = SUMMARY` (D-E6-4): las líneas de un ejercicio no
  // caben en el `result` y guardarlas duplicaría el diario dentro del informe.
  | { kind: "SUMMARY"; module: string; result: Record<string, unknown> }

function buildReport(
  type: ReportType,
  lines: readonly ReportLine[],
  index: ReturnType<typeof buildAccountIndex>,
  ctx: BuildContext,
  provenanceCtx: ProvenanceContext
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
      const balance = buildBalance(
        lines,
        index,
        {
          ...period,
          variant: ctx.variant,
          snapshot: (ctx.params.snapshot as BalanceSnapshot | undefined) ?? "PRE_REGULARIZACION",
          resultAccountCode: ctx.resultAccountCode,
          ...(ctx.comparative ? { comparative: ctx.comparative } : {}),
        },
        { ...provenanceCtx, module: "lib/ledger/reports/balance.ts" }
      )
      return { kind: "BALANCE", module: "lib/ledger/reports/balance.ts", result: balance, balance }
    }
    case ReportType.PYG: {
      const pyg = buildPyg(
        lines,
        index,
        {
          ...period,
          variant: ctx.variant,
          ...(ctx.comparative
            ? { comparative: { lines: ctx.comparative.lines, label: ctx.comparative.label, basis: ctx.comparative.basis } }
            : {}),
        },
        { ...provenanceCtx, module: "lib/ledger/reports/pyg.ts" }
      )
      return { kind: "PYG", module: "lib/ledger/reports/pyg.ts", result: pyg, pyg }
    }
    // E7 · ADR-0015 D4: el informe es UNO; `params.method` decide qué vista
    // presenta la pantalla, y las tres se calculan igual que antes.
    case ReportType.CASHFLOW:
    case ReportType.CASHFLOW_DIRECTO:
    case ReportType.CASHFLOW_INDIRECTO: {
      const cfParams = { ...period, incomeTaxAccountCodes: ctx.incomeTaxAccountCodes }
      const directo = buildCashflowDirect(lines, index, cfParams, {
        ...provenanceCtx,
        module: "lib/ledger/reports/cashflow.ts",
      })
      const indirecto = buildCashflowIndirect(lines, cfParams)
      // #6: fuera del `result` el detalle línea a línea y los pares del
      // drill-down. Con 6 000 líneas eran cientos de KB por bucket y el CHECK
      // de 1 MB tumbaba el INSERT — es decir, el informe no se emitía. Las
      // CIFRAS se guardan enteras; el detalle se recalcula bajo demanda con
      // `getCashflowBucketDetail`, igual que la celda de la matriz en E4.
      const { lineDetail: _detail, provenanceByBucket: _prov, ...directoResumen } = directo
      return {
        kind: "CASHFLOW",
        module: "lib/ledger/reports/cashflow.ts",
        result: {
          directo: {
            ...directoResumen,
            drillDown: "Detalle por bucket bajo demanda: getCashflowBucketDetail(runId, bucket) (#6)",
          },
          indirecto,
          efe: buildEfeView(directo, indirecto),
        },
        direct: directo,
      }
    }
    case ReportType.DASHBOARD: {
      const dashboard = buildDashboard(
        lines,
        index,
        {
          ...period,
          variant: ctx.variant,
          refDate: (ctx.params.refDate as LocalDate | undefined) ?? ctx.to,
          incomeTaxAccountCodes: ctx.incomeTaxAccountCodes,
          ...(typeof ctx.params.unpostedDocumentCount === "number"
            ? { unpostedDocumentCount: ctx.params.unpostedDocumentCount }
            : {}),
        },
        { ...provenanceCtx, module: "lib/ledger/reports/dashboard.ts" },
        ctx.comparative ? { lines: ctx.comparative.lines, label: ctx.comparative.label } : undefined
      )
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
          // #8: si no cabe entero, el run lo DICE. Un diario a medias servido
          // como si fuera el diario es peor que no servirlo.
          truncado: ctx.journalTruncated === true,
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
      // #9: la tesorería REAL de la foto, no un cero que haría que el umbral
      // comparase 0 contra 0 y no disparase nunca.
      return {
        tesoreria: built.balance.accountDetail
          .filter((a) => a.code.startsWith("57"))
          .reduce((acc, a) => acc + a.presentedCents, 0),
      }
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
// #6 — Drill-down del cashflow BAJO DEMANDA
// ─────────────────────────────────────────────────────────────────────────────

export type CashflowBucketDetail = {
  bucket: string
  cents: Cents
  /** La consulta parametrizada que devuelve EXACTAMENTE esas líneas. */
  provenance: unknown
  lines: readonly CashflowLineDetail[]
}

/**
 * Detalle de un bucket del cashflow, recalculado a partir del run.
 *
 * El run guarda las cifras, no las líneas (#6). Aquí se releen las del periodo
 * que el run selló —mismo `ledgerHash`, comprobado— y se reconstruye el detalle
 * con el MISMO motor puro: no hay una segunda aritmética que pueda divergir.
 *
 * Si el diario ha cambiado desde que se emitió el run, se dice: mejor negar el
 * drill-down que enseñar líneas que ya no componen la cifra sellada.
 */
export async function getCashflowBucketDetail(
  organizationId: string,
  runId: string,
  bucket: string,
  actor?: Actor
): Promise<CashflowBucketDetail> {
  return await tenantTransaction(organizationId, actor?.userId ?? undefined, async (tx) => {
    const run = await tx.reportRun.findFirstOrThrow({ where: { id: runId } })
    const period = { from: fromUtcDate(run.periodStart), to: fromUtcDate(run.periodEnd) }
    const current = await computeLedgerHash(tx, {
      ...(run.fiscalYearId ? { fiscalYearId: run.fiscalYearId } : {}),
      ...period,
    })
    if (current !== run.ledgerHash) {
      throw new Error(
        "El diario ha cambiado desde que se emitió este informe: el detalle ya no compone la cifra sellada. " +
          "Vuelve a emitirlo."
      )
    }

    const lines = await getLinesForPeriod(tx, {
      ...period,
      ...(run.fiscalYearId ? { fiscalYearId: run.fiscalYearId } : {}),
    })
    const index = buildAccountIndex(await getStatementAccounts(tx))
    const incomeTaxAccountCodes = [
      await accountCodeFor(tx, "HP_ACREEDORA_IS"),
      await accountCodeFor(tx, "HP_DEUDORA_IS"),
    ].filter((c): c is string => c !== null)

    const directo = buildCashflowDirect(
      lines,
      index,
      {
        organizationId,
        ...period,
        baseCurrency: (run.params as Record<string, unknown>).currency as string,
        ...(run.fiscalYearId ? { fiscalYearId: run.fiscalYearId } : {}),
        incomeTaxAccountCodes,
      },
      {
        runId: run.id,
        ledgerHash: run.ledgerHash,
        gitSha: run.gitSha,
        baseCurrency: (run.params as Record<string, unknown>).currency as string,
        module: "lib/ledger/reports/cashflow.ts",
      }
    )
    const key = bucket as keyof typeof directo.annualCents
    return {
      bucket,
      cents: directo.annualCents[key] ?? 0,
      provenance: directo.provenanceByBucket?.[key] ?? null,
      lines: directo.lineDetail.filter((d) => d.bucket === bucket),
    }
  })
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

/**
 * E7 · T9 (I-E7-10) — los informes **vigentes apoyados en liquidaciones**, con
 * el conjunto de `AllocationRun` sobre el que se sellaron.
 *
 * El `ReportRun` guarda el `allocationRunSetHash` pero no la lista de ids: la
 * lista se reconstruye **igual que se compuso** (`getSealedRunRefs` del periodo
 * del informe), y el invariante comprueba que el hash del conjunto coincide.
 * Si alguien sella una liquidación nueva del periodo, el hash deja de coincidir
 * y el informe **caduca**, que es exactamente la deuda que E5 dejó abierta.
 *
 * Una consulta por informe **no** significa N+1 de líneas: `getSealedRunRefs` es
 * un agregado sobre `allocation_runs`, sin tocar `allocation_lines`.
 */
export async function listStaleAllocationBackedRuns(
  db: AnyClient,
  filter: { take?: number } = {}
): Promise<{ id: string; reportType: string; allocationRunSetHash: string; allocationRunIds: string[] }[]> {
  const rows = await db.reportRun.findMany({
    where: { allocationRunSetHash: { not: null } },
    select: { id: true, type: true, periodStart: true, periodEnd: true, allocationRunSetHash: true },
    orderBy: { createdAt: "desc" },
    take: Math.min(filter.take ?? 50, 200),
  })
  const out: { id: string; reportType: string; allocationRunSetHash: string; allocationRunIds: string[] }[] = []
  for (const row of rows) {
    // En SERIE: dentro de una transacción se comparte una sola conexión (E6-perf).
    const refs = await getSealedRunRefs(db, { from: fromUtcDate(row.periodStart), to: fromUtcDate(row.periodEnd) })
    out.push({
      id: row.id,
      reportType: row.type,
      allocationRunSetHash: row.allocationRunSetHash ?? "",
      allocationRunIds: refs.map((r) => r.id),
    })
  }
  return out
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
  input: {
    type: ReportType
    periodStart: LocalDate
    periodEnd: LocalDate
    paramsHash: string
    basis: ComparativeBasis
    definingParams: Record<string, unknown>
  }
) {
  if (input.basis === ComparativeBasis.NONE) return null
  const shift = input.basis === ComparativeBasis.PREVIOUS_PERIOD ? 0 : 1
  const previousStart = shiftYears(input.periodStart, shift)
  const previousEnd = shiftYears(input.periodEnd, shift)
  // #4: el comparativo se busca por TIPO y PERIODO, no por `paramsHash`. En el
  // panel el `refDate` forma parte del hash —define el aging—, así que el run
  // del ejercicio anterior tiene por fuerza otro hash y exigirlo dejaba el
  // panel SIEMPRE sin comparativo. Lo que sí tiene que coincidir es la foto y
  // el modelo, que son los que hacen comparables dos balances: se filtran sobre
  // los `params` guardados.
  const candidates = await tx.reportRun.findMany({
    where: {
      type: input.type,
      ...(shift > 0
        ? { periodStart: toUtcDate(previousStart), periodEnd: toUtcDate(previousEnd) }
        : { periodEnd: { lt: toUtcDate(input.periodStart) } }),
    },
    orderBy: { createdAt: "desc" },
    take: 25,
  })
  return candidates.find((run) => comparableParams(run.params, input.definingParams)) ?? null
}

/**
 * Dos informes son comparables si coinciden en lo que decide QUÉ se presenta: la
 * foto y el modelo. El `refDate`, el plan y el mapa no: cambiarlos no convierte
 * el informe en otro distinto a efectos de comparación —el plan sí dispara
 * `PLAN_CAMBIADO`, que es la señal correcta, no la ausencia de comparativo—.
 */
function comparableParams(stored: Prisma.JsonValue, current: Record<string, unknown>): boolean {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return false
  const before = stored as Record<string, unknown>
  for (const field of ["snapshot", "variant"]) {
    if ((before[field] ?? null) !== (current[field] ?? null)) return false
  }
  return true
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
  /**
   * E7 · T11 — de qué barrido salió el hallazgo y **qué familia** hay que
   * revisar (O-21). `checkFamily` es un ENUM: con texto libre, una errata
   * acotaba la revisión a nada y el periodo quedaba sellado como si se hubiera
   * revisado.
   */
  invariantRunId?: string | null
  checkFamily?: CheckFamily | null
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
        invariantRunId: input.invariantRunId ?? null,
        checkFamily: input.checkFamily ?? null,
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
/**
 * Umbrales de la organización. #10: se PARSEAN con zod y se cae a los valores
 * por defecto ante cualquier cosa que no valide —una versión vieja, un `kpis`
 * editado a mano—. Antes se casteaba, y un `pctBps: undefined` dejaba de
 * disparar en silencio: el peor modo de fallo de un sello.
 */
export function thresholdsOf(raw: Prisma.JsonValue | null | undefined): ReviewThresholds {
  return parseReviewThresholds(raw)
}

export async function setReviewThresholds(
  organizationId: string,
  thresholds: ReviewThresholds,
  actor: Actor & { userId: string }
) {
  return await tenantTransaction(organizationId, actor.userId, async (tx) => {
    // Mismo motivo que en `getOrCreateReportRun`: `Organization` no es un modelo
    // de tenant y el facade de la transacción lo despacharía fuera de ella, sin
    // los GUC — la lectura vendría vacía y la escritura la cortaría la RLS.
    const [before] = await tx.$queryRaw<{ reviewThresholds: Prisma.JsonValue }[]>`
      SELECT review_thresholds AS "reviewThresholds" FROM organizations WHERE id = ${organizationId}::uuid
    `
    if (!before) throw new Error("La organización no existe o no es visible")
    await tx.$executeRaw`
      UPDATE organizations SET review_thresholds = ${JSON.stringify(thresholds)}::jsonb, updated_at = now()
       WHERE id = ${organizationId}::uuid
    `
    await writeAuditLog(tx, {
      entity: "Organization",
      entityId: organizationId,
      action: "SET_THRESHOLDS",
      before: before.reviewThresholds,
      after: thresholds,
      userId: actor.userId,
    })
    return thresholds
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

// ─────────────────────────────────────────────────────────────────────────────
// #5 / #7 — Sellos de configuración por AGREGADO SQL
//
// Se calculan sin materializar nada: son la parte barata de la clave de caché y
// permiten decidir si hay que leer el diario y el plan (#7). Un informe cachedo
// con el plan de ayer presenta las partidas en el epígrafe de ayer: es la misma
// clase de bug que `paramsHash` cierra para la foto (O-5).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * sha256 de las columnas del plan que DECIDEN la presentación: código,
 * epígrafes, estado financiero, bucket de cashflow, bidireccional y contra. El
 * nombre y el resto NO entran: renombrar una cuenta no mueve un céntimo.
 */
export async function computePlanHash(tx: TenantTransactionClient): Promise<string> {
  const rows = await tx.$queryRaw<{ hash: string }[]>`
    SELECT encode(sha256(convert_to(COALESCE(string_agg(fila, E'\n' ORDER BY code), ''), 'UTF8')), 'hex') AS hash
      FROM (
        SELECT concat_ws(E'\t',
                 a.code,
                 COALESCE(a.epigraph, '∅'),
                 COALESCE(a.epigraph_pymes, '∅'),
                 COALESCE(a.statement::text, '∅'),
                 COALESCE(a.cashflow_bucket::text, '∅'),
                 a.bidirectional::text,
                 a.is_contra::text
               ) AS fila, a.code
          FROM accounts a
         WHERE a.organization_id = ${tx.$organizationId}::uuid
      ) AS canonico`
  return rows[0]?.hash ?? ""
}

/** sha256 del mapa `AccountKey → cuenta`: mueve el 129, el IS y la tesorería. */
export async function computeAccountMapHash(tx: TenantTransactionClient): Promise<string> {
  const rows = await tx.$queryRaw<{ hash: string }[]>`
    SELECT encode(sha256(convert_to(COALESCE(string_agg(fila, E'\n' ORDER BY key), ''), 'UTF8')), 'hex') AS hash
      FROM (
        SELECT concat_ws(E'\t', m.key::text, m.account_code) AS fila, m.key::text AS key
          FROM organization_account_maps m
         WHERE m.organization_id = ${tx.$organizationId}::uuid
      ) AS canonico`
  return rows[0]?.hash ?? ""
}

/**
 * A1 / I-E6-20 — ¿hay algo en el diario que explique un `ledgerHash` distinto?
 *
 * Cuenta los asientos posteados desde la emisión del run anterior y los
 * `AuditLog` de posteo, anulación y reclasificación. Si no hay ninguno y el hash
 * ha cambiado, el diario se ha tocado **por fuera de la aplicación**.
 */
export async function ledgerChangesSince(
  tx: TenantTransactionClient,
  since: Date,
  period: { from: LocalDate; to: LocalDate; fiscalYearId?: string }
): Promise<number> {
  const rows = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT (
      (SELECT COUNT(*) FROM journal_entries e
        WHERE e.organization_id = ${tx.$organizationId}::uuid
          -- posted_at es el sello de contabilización: journal_entries no tiene created_at.
          AND e.posted_at >= ${since}
          AND e.entry_date BETWEEN ${toUtcDate(period.from)}::date AND ${toUtcDate(period.to)}::date)
      +
      (SELECT COUNT(*) FROM audit_logs a
        WHERE a.organization_id = ${tx.$organizationId}::uuid
          AND a.ts >= ${since}
          AND a.action IN ('post', 'void', 'RECLASSIFY_ANALYTICS'))
    )::bigint AS n`
  return Number(rows[0]?.n ?? 0)
}

/**
 * EV-10 — cuentas cuyo **epígrafe** cambió desde la emisión del run comparado y
 * que TIENEN líneas en el periodo comparado. La partida cambió de sitio: la
 * variación de ese epígrafe es un artefacto, no un hecho económico.
 */
export async function reclassifiedAccountsSince(
  tx: TenantTransactionClient,
  since: Date,
  period: { from: LocalDate; to: LocalDate }
): Promise<string[]> {
  // `AuditLog.entity_id` guarda el **id** de la cuenta, no su código: hay que
  // resolverlo contra el plan para poder cruzarlo con las líneas del diario.
  const rows = await tx.$queryRaw<{ code: string }[]>`
    SELECT DISTINCT acc.code AS code
      FROM audit_logs a
      JOIN accounts acc
        ON acc.organization_id = a.organization_id AND acc.id::text = a.entity_id
     WHERE a.organization_id = ${tx.$organizationId}::uuid
       AND a.entity = 'LedgerAccount'
       AND a.ts >= ${since}
       -- Sólo lo que MUEVE la partida de sitio: un renombrado no cuenta.
       AND (a.before -> 'epigraph'       IS DISTINCT FROM a.after -> 'epigraph'
         OR a.before -> 'epigraphPymes'  IS DISTINCT FROM a.after -> 'epigraphPymes'
         OR a.before -> 'statement'      IS DISTINCT FROM a.after -> 'statement'
         OR a.before -> 'cashflowBucket' IS DISTINCT FROM a.after -> 'cashflowBucket')
       AND EXISTS (
         SELECT 1 FROM journal_lines l
          WHERE l.organization_id = a.organization_id
            AND l.account_code = acc.code
            AND l.entry_date BETWEEN ${toUtcDate(period.from)}::date AND ${toUtcDate(period.to)}::date)
     ORDER BY code`
  return rows.map((r) => r.code)
}

/** EV-6 — proyectos y CECOs con líneas en el periodo. */
export async function dimensionsInPeriod(
  tx: TenantTransactionClient,
  period: { from: LocalDate; to: LocalDate; fiscalYearId?: string }
): Promise<string[]> {
  const rows = await tx.$queryRaw<{ d: string }[]>`
    SELECT DISTINCT d FROM (
      SELECT l.project_id::text AS d FROM journal_lines l
       WHERE l.organization_id = ${tx.$organizationId}::uuid
         AND l.entry_date BETWEEN ${toUtcDate(period.from)}::date AND ${toUtcDate(period.to)}::date
         AND l.project_id IS NOT NULL
      UNION ALL
      SELECT l.cost_center_id::text AS d FROM journal_lines l
       WHERE l.organization_id = ${tx.$organizationId}::uuid
         AND l.entry_date BETWEEN ${toUtcDate(period.from)}::date AND ${toUtcDate(period.to)}::date
         AND l.cost_center_id IS NOT NULL
    ) AS dims WHERE d IS NOT NULL ORDER BY d`
  return rows.map((r) => r.d)
}

// ─────────────────────────────────────────────────────────────────────────────
// E10 · T13 — `PRESUPUESTO_REAL` (§5.1 y §5.2)
//
// Sale de `NOT_IMPLEMENTED` por la puerta grande: **no es un informe nuevo ni
// una tabla nueva**, es la matriz de E4 con cinco columnas por celda —la misma
// retícula `nivel × columna`, la misma provenance y el mismo drill-down— más un
// bloque de rentabilidad con horas.
//
// Tiene camino propio y no se teje dentro de `attemptReportRun` a propósito:
// necesita un noveno componente de clave (`budgetHash`), un rechazo previo
// (`BUDGET_NOT_SEALED`) y una **previsualización sin fila en `report_runs`**,
// tres cosas que el pipeline genérico de E6 no tiene y que, metidas a la fuerza,
// habrían puesto en riesgo los seis informes que ya funcionan.
//
// **La regla de comparabilidad va primero, porque condiciona todo lo demás**
// (O-E10-4, I-E10-18): presupuesto y real se publican **en el mismo estado de
// imputación**, o las celdas por dimensión de nivel ≥ MC3 no se publican.
// ─────────────────────────────────────────────────────────────────────────────

export type BudgetGranularity = "MONTH" | "QUARTER" | "YEAR" | "YTD"

export type BudgetVsActualRequest = {
  fiscalYearId: string
  periodStart: LocalDate
  periodEnd: LocalDate
  granularity?: BudgetGranularity
  /** Con `true` las DOS matrices pasan por la liquidación (O-E10-4). */
  withAllocations?: boolean
  /**
   * Versión concreta. Sin ella se usa la **efectiva compuesta** a `periodEnd`
   * (O-E10-9). Con una versión en `BORRADOR` **se rechaza**: un borrador no
   * firma un informe (O-E10-5); para eso está la previsualización.
   */
  budgetId?: string
  currency?: string
  comparative?: boolean
  actor?: Actor
  noCache?: boolean
}

export type BudgetProfitabilityRow = {
  projectCode: string
  actualMinutes: number
  budgetMinutes: number | null
  minutesVariance: number | null
  /** `null` = **no evaluable**: 0 minutos, sin tarifa vigente o bases en conflicto. */
  hourlyCostCents: Cents | null
  /** La `basis` VIAJA con la cifra (Q-1): dos bases difieren ~31,9 %. */
  basis: string | null
  notEvaluableReason: string | null
  marginPerHourMc2Cents: Cents | null
  marginPerHourMc3Cents: Cents | null
  billedRatePerHourCents: Cents | null
}

export type BudgetVsActualResult = {
  granularity: BudgetGranularity
  withAllocations: boolean
  /** O-E10-9: de qué versión sale cada mes. Un año compuesto a medias sin decirlo es un año mal sumado. */
  budgetComposition: Record<string, string>
  budgetAllocationState: "NONE" | "SETTLED"
  /** Motivo de que el presupuesto no haya podido seguir al real (I-E10-18). */
  notSettleableReason: string | null
  variance: readonly VarianceCell[]
  forecast: unknown
  profitability: readonly BudgetProfitabilityRow[]
  absorption: unknown
  monthsWithoutBudget: readonly string[]
  openMonths: readonly string[]
  unresolvedBudgetCells: number
}

/**
 * **Los CINCO sellos de la cabecera del informe** (§5.1, §7).
 *
 * Un informe de gestión que no dice sobre qué se tomó no es reproducible (P7),
 * y hasta esta ronda la pantalla sólo podía imprimir dos de los cinco. Van
 * juntos y con el mismo nombre que la provenance de la celda:
 *
 *  · `ledgerHash` — el diario del periodo (el REAL).
 *  · `analyticsKey` — dimensiones + `marginConfigHash` + `allocationRunSetHash`
 *    en una sola clave: la capa analítica con la que se compuso la matriz.
 *  · `budgetHash` — la versión EFECTIVA compuesta (O-E10-9), no una suelta.
 *  · `budgetRulesHash` — las reglas de la liquidación PRESUPUESTARIA (O-E10-4);
 *    `null` sin imputaciones o cuando el presupuesto no pudo seguir al real.
 *  · `gitSha` — el código que calculó. Dos de estas cifras salidas de dos
 *    versiones del motor no son la misma cifra.
 */
export type BudgetVsActualSeals = {
  ledgerHash: string
  analyticsKey: string
  budgetHash: string
  budgetRulesHash: string | null
  gitSha: string
}

export type BudgetVsActualView = {
  /** `null` en la PREVISUALIZACIÓN: no hay fila en `report_runs` que devolver. */
  runId: string | null
  sealed: boolean
  /** Los cinco sellos que la cabecera imprime. */
  seals: BudgetVsActualSeals
  budgetHash: string
  budgetRulesHash: string | null
  forecastCutoff: string | null
  result: BudgetVsActualResult
  sealReasons: readonly ReportSealReason[]
  seal: Seal
  origen: "fresh" | "cache" | "preview"
}

/** El error tipado que la acción traduce (§4.2). Nunca un `throw` genérico. */
export class BudgetReportError extends Error {
  constructor(
    readonly code: "BUDGET_NOT_SEALED" | "BUDGET_NOT_FOUND" | "FISCAL_YEAR_NOT_FOUND",
    message: string
  ) {
    super(message)
    this.name = "BudgetReportError"
  }
}

/**
 * **§3.4 — el corte del forecast lo decide el BORDE.** Es el mayor mes con
 * `PeriodLock` del ejercicio, o el fin del ejercicio si está `CLOSED`. Viaja
 * como parámetro y **entra en `paramsHash`**, de modo que dos ejecuciones del
 * mismo informe con el mismo corte dan el mismo resultado (P7). Nunca se lee un
 * reloj dentro del motor.
 */
export async function forecastCutoffOf(
  tx: TenantTransactionClient,
  fiscalYearId: string
): Promise<string | null> {
  const fy = await tx.fiscalYear.findFirst({
    where: { id: fiscalYearId },
    select: { startDate: true, endDate: true, status: true },
  })
  if (!fy) return null
  if (fy.status === "CLOSED") return fromUtcDate(fy.endDate).slice(0, 7)
  const lock = await tx.periodLock.findFirst({
    where: { fiscalYearId },
    orderBy: { month: "desc" },
    select: { month: true },
  })
  if (!lock) return null
  const year = fromUtcDate(fy.startDate).slice(0, 4)
  return `${year}-${String(lock.month).padStart(2, "0")}`
}

/** Los meses del periodo que NO están cerrados (EV-13). */
export function openMonthsOf(months: readonly string[], cutoffMonth: string | null): string[] {
  if (cutoffMonth === null) return [...months]
  return months.filter((m) => m > cutoffMonth)
}

/**
 * **El informe de presupuesto vs real** (§5.1), sellado o en previsualización.
 *
 *  · `preview = false` (default) — exige una versión **SELLADA** y emite un
 *    `ReportRun` con `budgetHash` en la clave. Contra un `BORRADOR` responde
 *    `BUDGET_NOT_SEALED` y **no escribe ninguna fila** (O-E10-5, criterio
 *    18-ter): no existe camino que intente escribir `budget_hash = '∅'`.
 *  · `preview = true` — dry-run puro contra un borrador, **sin fila en
 *    `report_runs`**, con la banda «borrador, no firmable». Es el patrón de
 *    `previewAllocation` de E5.
 */
export async function budgetVsActual(
  organizationId: string,
  request: BudgetVsActualRequest & { preview?: boolean }
): Promise<BudgetVsActualView> {
  const gitSha = currentGitSha()
  const userId = request.actor?.userId ?? undefined
  const granularity: BudgetGranularity = request.granularity ?? "YTD"
  const withAllocations = request.withAllocations === true
  const preview = request.preview === true
  const startedAt = Date.now()

  // ── FASE 1 — clave, sellos y caché ────────────────────────────────────────
  const key = await tenantTransaction(organizationId, userId, async (tx) => {
    const organization = await tx.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { baseCurrency: true, reviewThresholds: true },
    })
    const fiscalYear = await tx.fiscalYear.findFirst({
      where: { id: request.fiscalYearId },
      select: { id: true, code: true, startDate: true, endDate: true },
    })
    if (!fiscalYear) {
      throw new BudgetReportError("FISCAL_YEAR_NOT_FOUND", "el ejercicio no existe en esta organización")
    }

    // La versión: la pedida, o la EFECTIVA COMPUESTA a fin de periodo (O-E10-9).
    const explicit = request.budgetId ? await getBudgetVersion(tx, request.budgetId) : null
    if (request.budgetId && !explicit) {
      throw new BudgetReportError("BUDGET_NOT_FOUND", "la versión de presupuesto no existe en esta organización")
    }
    if (explicit && explicit.status === "BORRADOR" && !preview) {
      throw new BudgetReportError(
        "BUDGET_NOT_SEALED",
        `${explicit.code} está en borrador: puedes verla en previsualización, pero un informe firmado necesita ` +
          "una versión sellada"
      )
    }

    const composed = explicit
      ? { effective: explicit, provenanceByMonth: {} as Record<string, { budgetId: string; label: string }> }
      : await activeBudgetAt(tx, { fiscalYearId: fiscalYear.id, at: request.periodEnd })
    if (!composed) {
      // Sin NINGUNA versión sellada no hay hash que escribir y el CHECK
      // `report_runs_budget_hash_required` lo impediría: se rechaza por el lado
      // correcto en vez de inventarse un centinela.
      throw new BudgetReportError(
        "BUDGET_NOT_SEALED",
        `el ejercicio ${fiscalYear.code} no tiene ninguna versión de presupuesto sellada vigente en ` +
          `${request.periodEnd}: sella una versión antes de pedir el informe`
      )
    }

    const config = await getAnalyticsConfig(tx, { periodEnd: request.periodEnd })
    const marginHash = marginConfigHash(config)
    const ledgerHash = await computeLedgerHash(tx, {
      fiscalYearId: fiscalYear.id,
      from: request.periodStart,
      to: request.periodEnd,
    })
    const analyticLines = await getAnalyticLines(tx, {
      from: fromUtcDate(fiscalYear.startDate),
      to: fromUtcDate(fiscalYear.endDate),
      fiscalYearId: fiscalYear.id,
    })
    const applied = withAllocations
      ? await getAppliedAllocations(tx, { from: request.periodStart, to: request.periodEnd })
      : null
    const runSetHash = applied ? applied.runSetHash : EMPTY_RUN_SET_HASH

    const periodLines = analyticLines.filter(
      (l) => l.entryDate >= request.periodStart && l.entryDate <= request.periodEnd
    )
    const analyticsHash = computeAnalyticsHash(
      periodLines.map((l) => ({
        entryId: l.entryId,
        lineNo: l.lineNo,
        projectId: l.projectId,
        costCenterId: l.costCenterId,
        businessLineId: l.businessLineId,
        analyticType: l.analyticType,
      })),
      marginHash,
      runSetHash
    )
    const analyticsKey = analyticsKeyOf({
      analyticsHash,
      marginConfigHash: marginHash,
      allocationRunSetHash: withAllocations ? runSetHash : null,
    })

    // El sello del presupuesto se toma sobre la versión EFECTIVA ya compuesta:
    // dos años compuestos de versiones distintas son dos presupuestos distintos
    // aunque cada pieza esté sellada por separado (O-E10-9 + M5).
    const budgetHash = computeBudgetHash(composed.effective, marginHash)
    const cutoffMonth = await forecastCutoffOf(tx, fiscalYear.id)
    const rules = await getAllocationRuleSpecs(tx, { periodEnd: request.periodEnd })
    const headcount = (await listHeadcount(tx, { from: request.periodStart, to: request.periodEnd })).map((h) => ({
      costCenterId: h.costCenterId,
      costCenterCode: h.costCenterCode,
      periodEnd: h.periodEnd,
      fteMilli: h.fteMilli,
    }))
    const timeRows = await getTimeRowsForWindow(tx, { from: request.periodStart, to: request.periodEnd })
    const rates = await getEmployeeRateRows(tx, { from: request.periodStart, to: request.periodEnd })
    // **Auditoría H-5** — el desglose de absorción por CECO necesita saber de
    // qué CECO es cada empleado: el coste valorado se agrupa por el CECO que
    // paga la nómina (`Employee.defaultCostCenter`), no por el receptor del
    // parte. Agrupando por receptor salían filas `PROJ:P-01` en un campo
    // llamado `costCenterCode` y las tres filas de CECO con `valuedCents: 0`,
    // es decir **infraabsorción del 100 % en todas las unidades** con el total
    // correcto: el desglose que O-E10-20 pide para el comité no informaba.
    const employeeCostCenters = (
      await tx.employee.findMany({
        select: { code: true, defaultCostCenter: { select: { code: true } } },
      })
    ).map((e) => ({ employeeCode: e.code, costCenterCode: e.defaultCostCenter?.code ?? null }))

    const composition: Record<string, string> = {}
    for (const [month, prov] of Object.entries(composed.provenanceByMonth)) composition[month] = prov.label

    // `forecastCutoff` ENTRA en `paramsHash` (§3.4): sin él, dos informes con
    // cortes distintos compartirían caché y uno serviría las cifras del otro.
    const hashed = {
      budgetId: composed.effective.id,
      scenario: composed.effective.scenario,
      granularity,
      withAllocations,
      forecastCutoff: cutoffMonth,
      budgetComposition: composition,
      currency: request.currency ?? organization.baseCurrency,
      comparative: request.comparative ?? false,
    }
    const paramsHash = paramsHashOf(hashed)

    const cached =
      preview || request.noCache === true
        ? null
        : await tx.reportRun.findFirst({
            where: {
              type: ReportType.PRESUPUESTO_REAL,
              periodStart: toUtcDate(request.periodStart),
              periodEnd: toUtcDate(request.periodEnd),
              paramsHash,
              ledgerHash,
              analyticsKey,
              gitSha,
              budgetHash,
            },
            orderBy: { createdAt: "desc" },
          })

    const lastRun = await tx.reportRun.findFirst({
      where: {
        type: ReportType.PRESUPUESTO_REAL,
        periodStart: toUtcDate(request.periodStart),
        periodEnd: toUtcDate(request.periodEnd),
      },
      orderBy: { createdAt: "desc" },
      select: { budgetHash: true, gitSha: true, analyticsHash: true, result: true },
    })

    return {
      organization,
      fiscalYear,
      config,
      marginHash,
      ledgerHash,
      analyticsHash,
      analyticsKey,
      analyticLines,
      periodLines,
      applied,
      composed,
      composition,
      budgetHash,
      cutoffMonth,
      rules,
      headcount,
      timeRows,
      rates,
      employeeCostCenters,
      hashed,
      paramsHash,
      cached,
      lastRun,
    }
  })

  if (key.cached) {
    const cachedRulesHash = (key.cached.params as Record<string, unknown>).budgetRulesHash as string | null
    return {
      runId: key.cached.id,
      sealed: true,
      seals: {
        // La fila en caché se buscó POR estos sellos: son los suyos por
        // construcción, no una copia optimista de los del cálculo de ahora.
        ledgerHash: key.ledgerHash,
        analyticsKey: key.analyticsKey,
        budgetHash: key.budgetHash,
        budgetRulesHash: cachedRulesHash,
        gitSha,
      },
      budgetHash: key.budgetHash,
      budgetRulesHash: cachedRulesHash,
      forecastCutoff: key.cutoffMonth,
      result: key.cached.result as unknown as BudgetVsActualResult,
      sealReasons: key.cached.sealReasons as unknown as ReportSealReason[],
      seal: key.cached.seal,
      origen: "cache",
    }
  }

  // ── FASE 2 — cálculo PURO, sin conexión ───────────────────────────────────
  const runId = randomUUID()
  const built = buildBudgetVsActual({
    runId,
    gitSha,
    granularity,
    withAllocations,
    baseCurrency: key.organization.baseCurrency,
    periodStart: request.periodStart,
    periodEnd: request.periodEnd,
    fiscalYearId: key.fiscalYear.id,
    fiscalYearStart: fromUtcDate(key.fiscalYear.startDate),
    fiscalYearEnd: fromUtcDate(key.fiscalYear.endDate),
    config: key.config,
    marginHash: key.marginHash,
    analyticsHash: key.analyticsHash,
    analyticLines: key.analyticLines,
    applied: key.applied,
    composed: key.composed,
    composition: key.composition,
    cutoffMonth: key.cutoffMonth,
    rules: key.rules,
    headcount: key.headcount,
    timeRows: key.timeRows,
    rates: key.rates,
    employeeCostCenters: key.employeeCostCenters,
  })

  const thresholds = parseReviewThresholds(key.organization.reviewThresholds)
  const reasons: ReportSealReason[] = [
    ...checkThresholds(built.kpis, built.budgetKpis, thresholds, { comparativeBasis: "NONE" as ComparativeBasis }),
    ...budgetReviewReasons({
      budgetHash: key.budgetHash,
      lastBudgetHash: key.lastRun?.budgetHash ?? null,
      monthsWithoutBudget: built.result.monthsWithoutBudget,
      openMonths: built.result.openMonths,
      unapprovedMinutes: built.unapproved,
      costCentersWithoutHeadcount: built.costCentersWithoutHeadcount,
      unpricedTime: built.unpriced,
      publishesHourlyCost: built.result.profitability.length > 0,
    }),
  ]
  // El cuarto KPI (O-E10-18): dos desviaciones por dimensión de signo contrario
  // se anulan en el total y el informe se firmaría en verde con dos proyectos
  // fuera de control. Se compara contra su propio umbral, no contra un periodo.
  for (const breach of built.dimensionBreaches(thresholds)) reasons.push(breach)

  const seal = sealOf(reasons) === "VALIDADO_AUTOMATICAMENTE" ? Seal.VALIDADO_AUTOMATICAMENTE : Seal.REQUIERE_REVISION

  if (preview) {
    // **Previsualización NO sellada**: ni una fila en `report_runs`. Es lo que
    // permite mirar un borrador sin que el borrador firme nada (O-E10-5).
    const previewRulesHash = built.result.budgetAllocationState === "SETTLED" ? built.budgetRulesHash : null
    return {
      runId: null,
      sealed: false,
      seals: {
        ledgerHash: key.ledgerHash,
        analyticsKey: key.analyticsKey,
        budgetHash: key.budgetHash,
        budgetRulesHash: previewRulesHash,
        gitSha,
      },
      budgetHash: key.budgetHash,
      budgetRulesHash: previewRulesHash,
      forecastCutoff: key.cutoffMonth,
      result: built.result,
      sealReasons: reasons,
      seal,
      origen: "preview",
    }
  }

  // ── FASE 3 — persistencia, en una transacción corta ───────────────────────
  const durationMs = Math.max(0, Date.now() - startedAt)
  const storedParams = { ...key.hashed, budgetRulesHash: built.budgetRulesHash }
  // **Auditoría H-7** — la provenance deja de ser un bloque de run y pasa a ser
  // **por celda**, con sus consultas parametrizadas (§5.1): el real, el
  // imputado, el presupuesto de la versión que gobierna ESE mes (O-E10-9) y las
  // horas presupuestadas que alimentaron el dry-run. Con el bloque de run, el
  // drill-down prometido exigía escribir las consultas a mano — es literalmente
  // lo que el auditor tuvo que hacer para trazar la celda de MC3 de P-01.
  const provenanceCtx: BudgetProvenanceContext = {
    runId,
    organizationId,
    fiscalYearId: key.fiscalYear.id,
    budgetIdsByMonth: Object.fromEntries(
      Object.entries(key.composed.provenanceByMonth).map(([month, p]) => [month, p.budgetId])
    ),
    periodStart: request.periodStart,
    periodEnd: request.periodEnd,
    ledgerHash: key.ledgerHash,
    budgetHash: key.budgetHash,
    analyticsKey: key.analyticsKey,
    gitSha,
    baseCurrency: key.organization.baseCurrency,
    withAllocations,
    levelTypes: Object.fromEntries(key.config.levels.map((l) => [l.level, l.analyticTypes])),
  }
  const provenance = {
    runId,
    ledgerHash: `sha256:${key.ledgerHash}`,
    budgetHash: `sha256:${key.budgetHash}`,
    analyticsKey: key.analyticsKey,
    gitSha,
    module: "lib/budget/variance.ts",
    // P6 — una celda de desviación NO se reproduce con una sola consulta (§5.1).
    generatedFrom: ["journal_lines", "allocation_lines", "budget_lines", "budget_hours_lines"],
    byCell: budgetProvenanceByCell(built.result.variance, provenanceCtx),
  }

  return await tenantTransaction(organizationId, userId, async (tx) => {
    await tx.$executeRaw`
      INSERT INTO report_runs (
        id, organization_id, type, period_start, period_end, fiscal_year_id,
        params, params_hash, ledger_hash, analytics_hash, margin_config_hash, allocation_run_set_hash,
        budget_hash, git_sha, result, result_kind, provenance, validation, seal, seal_reasons, duration_ms,
        created_by_id
      ) VALUES (
        ${runId}::uuid, ${organizationId}::uuid, 'PRESUPUESTO_REAL'::report_type,
        ${toUtcDate(request.periodStart)}::date, ${toUtcDate(request.periodEnd)}::date,
        ${key.fiscalYear.id}::uuid,
        ${JSON.stringify(storedParams)}::jsonb, ${key.paramsHash}, ${key.ledgerHash},
        ${key.analyticsHash}, ${key.marginHash},
        ${key.applied ? key.applied.runSetHash : null}, ${key.budgetHash}, ${gitSha},
        ${canonicalResultJson(built.result)}::jsonb, 'FULL'::result_kind,
        ${JSON.stringify(provenance)}::jsonb,
        ${JSON.stringify({ checks: built.checks })}::jsonb,
        ${seal}::seal, ${JSON.stringify(reasons)}::jsonb, ${durationMs},
        ${request.actor?.userId ?? null}::uuid
      )
      ON CONFLICT (organization_id, type, period_start, period_end, params_hash, ledger_hash, analytics_key, git_sha, budget_hash)
      DO NOTHING`

    const stored = await tx.reportRun.findFirstOrThrow({
      where: {
        type: ReportType.PRESUPUESTO_REAL,
        periodStart: toUtcDate(request.periodStart),
        periodEnd: toUtcDate(request.periodEnd),
        paramsHash: key.paramsHash,
        ledgerHash: key.ledgerHash,
        analyticsKey: key.analyticsKey,
        gitSha,
        budgetHash: key.budgetHash,
      },
      orderBy: { createdAt: "desc" },
    })
    return {
      runId: stored.id,
      sealed: true,
      seals: {
        ledgerHash: key.ledgerHash,
        analyticsKey: key.analyticsKey,
        budgetHash: key.budgetHash,
        budgetRulesHash: built.budgetRulesHash,
        gitSha,
      },
      budgetHash: key.budgetHash,
      budgetRulesHash: built.budgetRulesHash,
      forecastCutoff: key.cutoffMonth,
      result: stored.result as unknown as BudgetVsActualResult,
      sealReasons: stored.sealReasons as unknown as ReportSealReason[],
      seal: stored.seal,
      origen: stored.id === runId ? "fresh" : "cache",
    }
  })
}

type BuildBudgetInput = {
  runId: string
  gitSha: string
  granularity: BudgetGranularity
  withAllocations: boolean
  baseCurrency: string
  periodStart: LocalDate
  periodEnd: LocalDate
  fiscalYearId: string
  fiscalYearStart: LocalDate
  fiscalYearEnd: LocalDate
  config: AnalyticsConfig
  marginHash: string
  analyticsHash: string
  analyticLines: readonly AnalyticLine[]
  applied: AppliedAllocations | null
  composed: ComposedBudget
  composition: Record<string, string>
  cutoffMonth: string | null
  rules: readonly AllocationRuleSpec[]
  headcount: readonly HeadcountRow[]
  timeRows: readonly TimeEntryRow[]
  rates: readonly EmployeeRateRow[]
  /** **H-5**: CECO que paga la nómina de cada empleado (`defaultCostCenter`). */
  employeeCostCenters: readonly { employeeCode: string; costCenterCode: string | null }[]
}

/**
 * Composición PURA del informe. Fuera de la transacción a propósito: el motor no
 * necesita conexión y mantener el pool ocupado mientras se construye una matriz
 * de ocho niveles es exactamente lo que agotaba el pool en E6.
 */
function buildBudgetVsActual(input: BuildBudgetInput) {
  const provCtx: ProvenanceContext = {
    runId: input.runId,
    ledgerHash: "",
    gitSha: input.gitSha,
    baseCurrency: input.baseCurrency,
    module: "lib/analytics/margins.ts",
  }
  const periodLines = input.analyticLines.filter(
    (l) => l.entryDate >= input.periodStart && l.entryDate <= input.periodEnd
  )

  // ── El REAL, con o sin imputaciones según el toggle ───────────────────────
  const actual = buildAnalyticPnl(
    periodLines,
    input.config,
    { from: input.periodStart, to: input.periodEnd, fiscalYearId: input.fiscalYearId },
    provCtx,
    {
      analyticsHash: input.analyticsHash,
      marginConfigHash: input.marginHash,
      ...(input.applied ? { allocations: input.applied.lines } : {}),
    }
  )

  // ── El PRESUPUESTO, con las MISMAS funciones de `lib/analytics/margins.ts` ─
  // Reimplementarlas aquí sería garantizar que las dos matrices divergen el día
  // que alguien toque una regla de destino.
  const window = { from: input.periodStart, to: input.periodEnd }
  let budget = buildBudgetMatrix(input.composed.effective, input.config, window)

  // ── O-E10-4 — la liquidación PRESUPUESTARIA, en dry-run puro ──────────────
  // Sin ella, con `CC-OPS` presupuestado y ejecutado en 900 000 c exactos y las
  // horas exactamente previstas, la desviación de MC3 de P-01 salía −400 000 c
  // con ejecución perfecta, y el total compañía cuadraba.
  let notSettleableReason: string | null = null
  let budgetRulesHash: string | null = null
  if (input.withAllocations) {
    const settled = settleBudgetMatrix(budget, {
      rules: input.rules,
      budgetHours: input.composed.effective.hours,
      headcount: input.headcount,
      config: input.config,
      period: {
        kind: "YEAR",
        label: input.periodStart.slice(0, 4),
        start: input.periodStart,
        end: input.periodEnd,
        fiscalYearId: input.fiscalYearId,
        fiscalYearStart: input.fiscalYearStart,
        fiscalYearEnd: input.fiscalYearEnd,
      },
    })
    if (settled.ok) {
      budget = settled.value.matrix
      budgetRulesHash = budget.budgetRulesHash
    } else {
      // NUNCA una matriz mixta: el presupuesto se queda en bruto, las celdas por
      // dimensión de nivel ≥ MC3 salen `notComparable` y el toggle se bloquea
      // con el motivo (I-E10-18).
      notSettleableReason = settled.error.reason
    }
  }

  // ── El FORECAST, mes a mes y con su procedencia (I-E10-7) ─────────────────
  // **Antes que la desviación, y no después**: la quinta columna de la celda
  // sale de aquí. Construir la desviación primero dejaba `forecastCents = null`
  // en TODAS las celdas —la columna existía y siempre estaba vacía— aunque el
  // bloque de totales del ejercicio sí se pintara.
  const months = fiscalYearMonths(input.fiscalYearStart, input.fiscalYearEnd)
  const actualByMonth: Record<string, Record<string, Record<string, Cents>>> = {}
  for (const month of months) {
    const from = `${month}-01`
    const to = lastDayOfMonth(month)
    const monthLines = input.analyticLines.filter((l) => l.entryDate >= from && l.entryDate <= to)
    const monthly = buildAnalyticPnl(
      monthLines,
      input.config,
      { from, to, fiscalYearId: input.fiscalYearId },
      provCtx,
      { ...(input.applied ? { allocations: input.applied.lines } : {}) }
    )
    actualByMonth[month] = monthly.matrixCents
  }
  const forecast = buildForecast({
    actualByMonth,
    budget,
    fiscalYearMonths: months,
    // §3.4 — el corte es el ÚLTIMO MES CERRADO, y lo decide el borde
    // (`forecastCutoffOf`): mayor `PeriodLock` del ejercicio, o fin del
    // ejercicio si está `CLOSED`. Viaja en `paramsHash`, nunca de un reloj.
    cutoffMonth: input.cutoffMonth,
    budgetProvenanceByMonth: input.composition,
  })

  // **Granularidad mes** (§5.1): con `MONTH`, la celda es de UN mes y lo dice.
  // `month: null` significa «acumulado del periodo», así que etiquetar de
  // acumulado una matriz mensual hacía imposible distinguir las dos cosas en la
  // provenance (`desviacion.mc3.PROJ:P-01.2026-03`).
  const varianceMonth =
    input.granularity === "MONTH" && monthKey(input.periodStart) === monthKey(input.periodEnd)
      ? monthKey(input.periodStart)
      : null
  const variance = buildVariance({
    actual: { matrixCents: actual.matrixCents, columns: actual.columns },
    budget,
    forecast,
    actualAllocationState: input.withAllocations ? "SETTLED" : "NONE",
    month: varianceMonth,
  })

  // ── §5.2 — rentabilidad por proyecto CON HORAS y absorción ────────────────
  const approved = input.timeRows.filter((r) => r.approved)
  const minutes = minutesByTarget(approved, window, { productiveOnly: true, approvedOnly: true })
  const costs = costOfTime(input.timeRows, input.rates, window)
  const budgetMinutesByCode = new Map<string, number>()
  for (const cell of input.composed.effective.hours) {
    budgetMinutesByCode.set(
      cell.dimension.code,
      (budgetMinutesByCode.get(cell.dimension.code) ?? 0) + cell.minutes
    )
  }

  const profitability: BudgetProfitabilityRow[] = minutes
    .filter((m) => m.kind === "PROJECT")
    .map((m) => {
      const column = `PROJ:${m.code}`
      const cost = costs.byTarget.find((t) => t.code === m.code && t.kind === "PROJECT") ?? null
      const budgetMinutes = budgetMinutesByCode.get(m.code) ?? null
      const mc2 = actual.matrixCents.MC2?.[column] ?? 0
      const mc3 = actual.matrixCents.MC3?.[column] ?? 0
      const ingresos = actual.matrixCents.INGRESOS?.[column] ?? 0
      // `null` con 0 minutos: **no evaluable**, nunca 0 (R-R-1). Un ratio con
      // denominador cero no es «cero», es una cifra que no existe.
      const perHour = (cents: Cents): Cents | null =>
        m.minutes === 0 ? null : Math.floor((cents * 60) / m.minutes)
      return {
        projectCode: m.code,
        actualMinutes: m.minutes,
        budgetMinutes,
        minutesVariance: budgetMinutes === null ? null : m.minutes - budgetMinutes,
        hourlyCostCents:
          cost === null || cost.costCents === null || m.minutes === 0
            ? null
            : Math.floor((cost.costCents * 60) / m.minutes),
        basis: cost?.basis ?? null,
        notEvaluableReason: cost?.notEvaluableReason ?? (m.minutes === 0 ? "SIN_MINUTOS" : null),
        marginPerHourMc2Cents: perHour(mc2),
        marginPerHourMc3Cents: perHour(mc3),
        billedRatePerHourCents: perHour(ingresos),
      }
    })

  // **O-E10-20** — la desviación de absorción. I-E10-12 sólo comprueba que no se
  // pase (`≤`), así que una INFRAABSORCIÓN del 20 % pasaba el invariante en
  // silencio. Es información de gestión, no un FAIL.
  const payrollLines = periodLines.filter((l) =>
    DEFAULT_PAYROLL_ACCOUNT_PREFIXES.some((p) => l.accountCode.startsWith(p))
  )
  const payrollCents = payrollLines.reduce((acc, l) => acc + (l.debitCents - l.creditCents), 0)

  // **Auditoría H-5** — el desglose por CECO, con las dos magnitudes REALES y
  // comparables:
  //
  //  · `payrollCents`: Σ (debe − haber) de las 64x **cuyo CECO es ése**. Una 64x
  //    imputada directamente a un proyecto (camino (b) de §3.7) no pertenece a
  //    ningún CECO y sale en la fila `SIN_CECO`, no disfrazada de centro de
  //    coste con un código `PROJ:…`.
  //  · `valuedCents`: Σ del coste de los partes de los empleados **de ese
  //    CECO**, sea cual sea el receptor. Es lo que la unidad ha conseguido
  //    absorber con las horas de su gente, que es justo lo que la absorción
  //    mide. Agrupar por RECEPTOR —lo que hacía la ronda 0— dejaba los CECOs a
  //    cero, porque casi todas las horas van a proyectos.
  const cecoCodeById = new Map(input.config.costCenters.map((c) => [c.id, c.code]))
  const cecoOfEmployee = new Map(input.employeeCostCenters.map((e) => [e.employeeCode, e.costCenterCode]))
  const SIN_CECO = "SIN_CECO"
  const payrollByCeco = new Map<string, Cents>()
  for (const line of payrollLines) {
    const code = (line.costCenterId ? cecoCodeById.get(line.costCenterId) : null) ?? SIN_CECO
    payrollByCeco.set(code, (payrollByCeco.get(code) ?? 0) + (line.debitCents - line.creditCents))
  }
  const valuedByCeco = new Map<string, Cents>()
  for (const target of costs.byTarget) {
    // Un receptor NO EVALUABLE (`costCents === null`) no aporta: valorarlo a 0
    // sería exactamente el error que I-E10-5 prohíbe.
    if (target.costCents === null) continue
    for (const entry of target.entries) {
      const code = cecoOfEmployee.get(entry.employeeCode) ?? SIN_CECO
      valuedByCeco.set(code, (valuedByCeco.get(code) ?? 0) + entry.costCents)
    }
  }
  const absorption = absorptionVariance({
    valuedCents: costs.totals.valuedCents,
    payrollCents,
    byCostCenter: [...new Set([...payrollByCeco.keys(), ...valuedByCeco.keys()])].map((code) => ({
      code,
      valuedCents: valuedByCeco.get(code) ?? 0,
      payrollCents: payrollByCeco.get(code) ?? 0,
    })),
  })

  // ── EV-15 / EV-16 / EV-17 — lo que mueve el sello ─────────────────────────
  const unapprovedRows = unapprovedMinutesByTarget(input.timeRows, window, { productiveOnly: true })
  const unapprovedTotal = unapprovedRows.reduce((acc, r) => acc + r.unapprovedMinutes, 0)
  const baseTotal = minutes.reduce((acc, m) => acc + m.minutes, 0)
  const unapproved =
    unapprovedTotal > 0
      ? { minutes: unapprovedTotal, baseMinutes: baseTotal, targets: unapprovedRows.map((r) => r.code) }
      : null

  const headcountTargets = new Set(input.headcount.map((h) => h.costCenterId))
  const costCentersWithoutHeadcount = input.rules
    .filter((r) => r.driver === "HEADCOUNT")
    .flatMap((r) => r.targets.map((t) => t.costCenterId))
    .filter((id): id is string => id !== null && id !== undefined && !headcountTargets.has(id))
    .map((id) => input.config.costCenters.find((c) => c.id === id)?.code ?? id)

  const unpriced =
    costs.unpriced.length > 0
      ? { entries: costs.unpriced.length, employees: [...new Set(costs.unpriced.map((u) => u.employeeCode))].sort() }
      : null

  const monthsInPeriod = months.filter((m) => `${m}-01` >= input.periodStart.slice(0, 8).concat("01") && `${m}-01` <= input.periodEnd)
  const monthsWithoutBudget = monthsInPeriod.filter((m) => input.composition[m] === undefined)

  const result: BudgetVsActualResult = {
    granularity: input.granularity,
    withAllocations: input.withAllocations,
    budgetComposition: input.composition,
    budgetAllocationState: budget.allocationState,
    notSettleableReason,
    variance,
    forecast: { byMonth: forecast.byMonth, provenanceByMonth: forecast.provenanceByMonth, levelTotalsCents: forecast.levelTotalsCents },
    profitability,
    absorption,
    monthsWithoutBudget,
    openMonths: openMonthsOf(monthsInPeriod, input.cutoffMonth),
    unresolvedBudgetCells: budget.unresolved.length,
  }

  // KPI de desviación a total compañía. La «base» de la comparación NO es un
  // periodo anterior: es el presupuesto, y por eso `previous` es el presupuesto.
  const totalOf = (level: string, matrix: Record<string, Record<string, Cents>>): Cents =>
    Object.values(matrix[level] ?? {}).reduce((a, b) => a + b, 0)
  const kpis: KpiSnapshot = {
    desviacionIngresos: totalOf("INGRESOS", actual.matrixCents),
    desviacionEbitda: totalOf("EBITDA", actual.matrixCents),
    desviacionMc3: totalOf("MC3", actual.matrixCents),
  }
  const budgetKpis: KpiSnapshot = {
    desviacionIngresos: budget.cumulativeCents.INGRESOS ? totalOf("INGRESOS", budget.cumulativeCents) : 0,
    desviacionEbitda: totalOf("EBITDA", budget.cumulativeCents),
    desviacionMc3: totalOf("MC3", budget.cumulativeCents),
  }

  const checks: CheckResult[] = [
    ...actual.checks.map((c) => ({ id: c.id, status: c.status, evidencia: c.evidencia }) as CheckResult),
  ]
  if (budget.unresolved.length > 0) {
    checks.push({
      id: "I-E10-1",
      status: "WARN",
      evidencia:
        `${budget.unresolved.length} celda(s) de presupuesto sin situar en la matriz: ` +
        budget.unresolved.map((u) => `${u.month} ${u.dimensionCode} (${u.code})`).join(", "),
    })
  }

  /**
   * **O-E10-18 / criterio 18-bis** — el cuarto KPI. Mira el máximo |desviación|
   * POR DIMENSIÓN en INGRESOS, MC2 y MC3: dos desviaciones grandes de signo
   * contrario se anulan en el total compañía y el informe se firmaba en verde
   * con dos proyectos fuera de control.
   */
  const dimensionBreaches = (thresholds: ReviewThresholds): ReportSealReason[] => {
    const limit = thresholds.kpis.desviacionMaxDimension
    if (!limit) return []
    const out: ReportSealReason[] = []
    for (const level of ["INGRESOS", "MC2", "MC3"] as const) {
      const worst = maxDimensionVariance(variance, level)
      if (worst === null) continue
      const overAbs = limit.minAbsCents === null || Math.abs(worst.varianceCents) > limit.minAbsCents
      const overPct = limit.pctBps === null || worst.varianceBps === null || Math.abs(worst.varianceBps) > limit.pctBps
      if (!overAbs || !overPct) continue
      out.push({
        code: "DESVIACION_PRESUPUESTO",
        kind: "VARIACION",
        kpi: `desviacionMaxDimension:${level}`,
        message:
          `La dimensión ${worst.column} desvía ${worst.varianceCents} céntimos en ${level} ` +
          `${worst.varianceBps === null ? "" : `(${worst.varianceBps} puntos básicos) `}` +
          "por encima del umbral por dimensión: el total compañía puede estar a cero y aun así haber " +
          "dimensiones fuera de control",
        deltaBps: worst.varianceBps,
        limitBps: limit.pctBps,
      })
    }
    return out
  }

  return {
    result,
    checks,
    kpis,
    budgetKpis,
    budgetRulesHash,
    unapproved,
    costCentersWithoutHeadcount,
    unpriced,
    dimensionBreaches,
  }
}

/** Último día del mes `YYYY-MM`, sin `Date`: es calendario, no reloj. */
function lastDayOfMonth(month: string): LocalDate {
  const year = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  const days =
    m === 2 ? ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28) : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
  return `${month}-${String(days).padStart(2, "0")}`
}
