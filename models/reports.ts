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
import { getSealedRunRefs } from "@/models/allocations"
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
      ON CONFLICT (organization_id, type, period_start, period_end, params_hash, ledger_hash, analytics_key, git_sha)
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
