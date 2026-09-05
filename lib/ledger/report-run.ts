/**
 * E6 · T10 — Clave de reutilización, forma canónica y política de umbrales de
 * `ReportRun` (ADR-0003 y ADR-0012 D3).
 *
 * Módulo PURO: sin IO, sin `Date.now()`, sin Prisma. El sha256 sale de
 * `node:crypto`, que es determinista y no toca el mundo exterior.
 */

import { createHash } from "node:crypto"

import type { Cents } from "@/lib/ledger/types"
import type { CheckResult } from "@/lib/ledger/invariants-types"

// ─────────────────────────────────────────────────────────────────────────────
// Forma canónica y hashes
// ─────────────────────────────────────────────────────────────────────────────

/** Centinela de «sin valor». El mismo que usa el trigger de `analytics_key`. */
export const SENTINEL = "∅"

/**
 * Forma canónica de un objeto: claves ordenadas en TODO nivel y sin
 * `undefined`. Es lo que permite que dos peticiones que escriben los mismos
 * parámetros en distinto orden compartan caché — y, más importante, que dos que
 * escriben parámetros distintos NO la compartan.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null"
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalJson: número no finito en los parámetros del informe")
    return JSON.stringify(value)
  }
  if (typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`
}

export const canonicalParams = (params: Record<string, unknown>): string => canonicalJson(params)

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")

export const paramsHash = (params: Record<string, unknown>): string => sha256(canonicalParams(params))

/**
 * I-E6-17: recalcular con la misma clave tiene que dar **el mismo string**. Por
 * eso el `result` se serializa canónicamente antes de compararlo: un `JSON.
 * stringify` normal depende del orden de inserción de las claves y haría que el
 * invariante fallara por un cambio de código sin efecto en las cifras.
 */
export const canonicalResultJson = (result: unknown): string => canonicalJson(result)

/**
 * `analyticsKey` en forma canónica. **Existe sólo para poder indexar la clave**:
 * en PostgreSQL `NULL <> NULL` y un índice único con columnas nullables no
 * impide duplicados (lección O-A6 de E4). La compone el trigger
 * `report_runs_analytics_key`; esta función es su espejo en TypeScript, y hay un
 * test de integración que comprueba que los dos coinciden.
 */
export function analyticsKeyOf(input: {
  analyticsHash?: string | null
  marginConfigHash?: string | null
  allocationRunId?: string | null
}): string {
  return [input.analyticsHash ?? SENTINEL, input.marginConfigHash ?? SENTINEL, input.allocationRunId ?? SENTINEL].join("|")
}

export type ReportRunKeyInput = {
  organizationId: string
  type: string
  periodStart: string
  periodEnd: string
  paramsHash: string
  ledgerHash: string
  analyticsKey: string
  gitSha: string
}

/** El MISMO string que el `@@unique` de la tabla, para logs y para la caché. */
export const reportRunKey = (input: ReportRunKeyInput): string =>
  [
    input.organizationId,
    input.type,
    input.periodStart,
    input.periodEnd,
    input.paramsHash,
    input.ledgerHash,
    input.analyticsKey,
    input.gitSha,
  ].join("|")

// ─────────────────────────────────────────────────────────────────────────────
// Umbrales de variación (ADR-0012 D3, §5 de la validación contable)
// ─────────────────────────────────────────────────────────────────────────────

export type KpiThreshold = {
  /** Variación relativa en puntos básicos. `null` = no se mira. */
  pctBps: number | null
  /** Suelo absoluto en céntimos. `null` = no se mira. */
  minAbsCents: number | null
  /** Umbral en PUNTOS de margen, para KPI que ya son un porcentaje. */
  minPointsBps?: number | null
}

/**
 * Un KPI dispara revisión sólo si supera **los dos** umbrales. La conjunción es
 * lo que impide que pasar de 100 € a 300 € de gastos financieros (+200 %) ahogue
 * el sello en ruido: sin suelo absoluto, el sello deja de significar nada y la
 * gente aprende a ignorarlo, que es peor que no tenerlo.
 */
export const DEFAULT_KPI_THRESHOLDS: Readonly<Record<string, KpiThreshold>> = {
  // 15 % mes a mes es ruido comercial normal en una PYME de proyectos (un hito
  // facturado antes o después). Por encima suele ser un hito grande o un duplicado.
  ingresos: { pctBps: 1500, minAbsCents: 500_000 },
  // Más volátil que ingresos por apalancamiento operativo: los costes fijos no
  // siguen a la facturación.
  ebitda: { pctBps: 2500, minAbsCents: 300_000 },
  // Apalancado sobre el EBITDA y, además, el IS sólo aparece en el cierre.
  resultado: { pctBps: 3000, minAbsCents: 300_000 },
  // Un cobro grande a fin de mes desplaza el saldo sin significar nada: suelo alto.
  tesoreria: { pctBps: 2000, minAbsCents: 1_000_000 },
  // La deuda se mueve por contrato, no por ruido: umbral estrecho.
  deuda: { pctBps: 1000, minAbsCents: 500_000 },
  // Muy sensible al mix de facturación. El suelo son 10 días, en céntimos de día.
  dso: { pctBps: 2000, minAbsCents: 10 },
  // Se compara en PUNTOS de margen: pasar del 2 % al 3 % es +50 % y es irrelevante.
  margenBruto: { pctBps: null, minAbsCents: null, minPointsBps: 300 },
}

export type ComparativeBasis = "SAME_PERIOD_PREVIOUS_YEAR" | "PREVIOUS_FISCAL_YEAR_CLOSE" | "PREVIOUS_PERIOD" | "NONE"

/**
 * Base por defecto. Comparar contra el **mes anterior** en una empresa de
 * proyectos genera falsos positivos sistemáticos (agosto, cierres de hito,
 * liquidaciones trimestrales).
 */
export const DEFAULT_COMPARATIVE_BASIS: ComparativeBasis = "SAME_PERIOD_PREVIOUS_YEAR"

export type ReviewThresholds = {
  version: 1
  comparativeBasis: ComparativeBasis
  kpis: Record<string, KpiThreshold>
}

export const DEFAULT_REVIEW_THRESHOLDS: ReviewThresholds = {
  version: 1,
  comparativeBasis: DEFAULT_COMPARATIVE_BASIS,
  kpis: DEFAULT_KPI_THRESHOLDS,
}

// ─────────────────────────────────────────────────────────────────────────────
// Motivos del sello: CÓDIGO CERRADO (O-7)
//
// La Auditoría filtra por `code`; nunca hace `LIKE` sobre un texto libre. Un
// motivo con texto libre no es filtrable, no es agregable y se desincroniza en
// cuanto alguien mejora la redacción.
// ─────────────────────────────────────────────────────────────────────────────

export type SealReasonCode =
  | "VARIACION_KPI"
  | "REGULARIZACION_DESFASADA"
  | "MOTOR_CAMBIADO"
  | "ANALITICA_REDEFINIDA"
  | "EPIGRAFE_CAMBIADO"
  | "REVISION_FORZADA"
  | "INVARIANTE_FAIL"
  | "GIT_SHA_DESCONOCIDO"

export type ReportSealReasonKind = "ENTORNO" | "INVARIANTE" | "AVISO" | "CONFIGURACION" | "VARIACION"

export type ReportSealReason = {
  code: SealReasonCode
  kind: ReportSealReasonKind
  message: string
  invariantId?: string
  kpi?: string
  deltaBps?: number | null
  limitBps?: number | null
  currentCents?: Cents
  previousCents?: Cents
}

export type ThresholdBreach = ReportSealReason & { code: "VARIACION_KPI"; kpi: string }

export type KpiSnapshot = Record<string, Cents>

export type ThresholdContext = {
  /** EV-1: el periodo comparado contiene asientos de sistema. */
  periodHasSystemEntries?: boolean
  /** EV-2: nunca se compara contra el mes anterior de otro ejercicio. */
  comparativeBasis?: ComparativeBasis
  /** EV-3: parte de la variación atribuible al epígrafe 20/19 y a REGULARIZATION. */
  structuralDeltaByKpi?: Readonly<Record<string, Cents>>
  /** EV-5: neto de los `REVERSAL` y sus originales caídos en el mismo periodo. */
  reversalNetByKpi?: Readonly<Record<string, Cents>>
  /** EV-6: dimensiones vivas en los dos periodos (los KPI por dimensión). */
  dimensionsAliveInBoth?: readonly string[]
}

const abs = (n: number): number => (n < 0 ? -n : n)

/**
 * EV-1…EV-6 — variaciones **explicables** que NO deben disparar revisión.
 *
 * Sin ellas los umbrales producirían un `REQUIERE REVISIÓN` en enero (el
 * resultado cae a cero: es estructural), en cada liquidación trimestral y en
 * cada cierre. Un sello que salta siempre es un sello que nadie lee.
 */
export function checkThresholds(
  current: KpiSnapshot,
  previous: KpiSnapshot | null,
  thresholds: ReviewThresholds,
  ctx: ThresholdContext = {}
): ThresholdBreach[] {
  // Sin comparativo no hay variación que medir. Es «sin comparativo», no «0 %».
  if (previous === null) return []
  // EV-2: comparar el primer mes del ejercicio contra el último del anterior es
  // comparar dos cosas distintas; la base por defecto ya es YoY.
  if ((ctx.comparativeBasis ?? thresholds.comparativeBasis) === "NONE") return []

  const out: ThresholdBreach[] = []
  for (const [kpi, limit] of Object.entries(thresholds.kpis)) {
    if (!(kpi in current) || !(kpi in previous)) continue
    // EV-6: un KPI por dimensión sólo se compara si la dimensión vive en los dos
    // periodos. Las nuevas son «altas», no variaciones.
    if (ctx.dimensionsAliveInBoth && kpi.includes(":") && !ctx.dimensionsAliveInBoth.includes(kpi.split(":")[1])) {
      continue
    }

    const base = previous[kpi]
    // EV-3 y EV-5: se descuenta ANTES de aplicar el umbral la parte estructural
    // (epígrafe del impuesto, `REGULARIZATION`) y el neto de los contra-asientos.
    const adjusted =
      current[kpi] - (ctx.structuralDeltaByKpi?.[kpi] ?? 0) - (ctx.reversalNetByKpi?.[kpi] ?? 0)
    const deltaAbs = adjusted - base

    // KPI que YA es un porcentaje: se compara en PUNTOS, no en variación relativa.
    if (limit.minPointsBps !== null && limit.minPointsBps !== undefined) {
      if (abs(deltaAbs) > limit.minPointsBps) {
        out.push(breach(kpi, adjusted, base, deltaAbs, limit.minPointsBps))
      }
      continue
    }

    const bps = base === 0 ? null : Math.round((deltaAbs * 10_000) / abs(base))
    // Base 0: no hay porcentaje que medir, pero aparecer de la nada por encima
    // del suelo absoluto SÍ es revisable, así que el umbral relativo se da por
    // superado y decide `minAbsCents` en solitario.
    const overPct = limit.pctBps === null || bps === null || abs(bps) > limit.pctBps
    const overAbs = limit.minAbsCents === null || abs(deltaAbs) > limit.minAbsCents
    if (overPct && overAbs && deltaAbs !== 0) out.push(breach(kpi, adjusted, base, deltaAbs, limit.pctBps, bps))
  }
  return out.sort((a, b) => (a.kpi < b.kpi ? -1 : 1))
}

function breach(
  kpi: string,
  current: Cents,
  previous: Cents,
  deltaAbs: Cents,
  limitBps: number | null,
  deltaBps?: number | null
): ThresholdBreach {
  return {
    code: "VARIACION_KPI",
    kind: "VARIACION",
    kpi,
    message:
      `El KPI «${kpi}» varía ${deltaAbs} céntimos respecto al comparativo ` +
      `(${previous} → ${current})${deltaBps === null || deltaBps === undefined ? "" : `, ${deltaBps} puntos básicos`}` +
      `${limitBps === null ? "" : `, por encima del umbral de ${limitBps}`}`,
    deltaBps: deltaBps ?? null,
    limitBps,
    currentCents: current,
    previousCents: previous,
  }
}

export type AlwaysReviewContext = {
  /** EV-8: git-sha del run comparado. */
  gitSha: string
  lastGitSha?: string | null
  /** EV-7: `analyticsHash` del run comparado. */
  analyticsHash?: string | null
  lastAnalyticsHash?: string | null
  /** EV-10: cuentas cuyo `epigraph` cambió y tienen líneas en el periodo. */
  reclassifiedAccounts?: readonly string[]
  /** Flag de revisión manual activo (ADMIN). */
  manualReviewReason?: string | null
  /** I-E6-13 en FAIL: las DOS cifras y su diferencia. */
  regularizacionDesfasada?: { i3Cents: Cents; saldo129Cents: Cents } | null
}

const UNKNOWN_SHAS: ReadonlySet<string> = new Set(["", "desconocido", "unknown", "dev", "HEAD"])

/**
 * EV-7…EV-10 — variaciones que **SÍ disparan siempre**, con independencia del
 * umbral, porque no son variaciones: son cambios de la propia métrica.
 */
export function alwaysReviewReasons(ctx: AlwaysReviewContext): ReportSealReason[] {
  const out: ReportSealReason[] = []

  if (UNKNOWN_SHAS.has(ctx.gitSha.trim())) {
    out.push({
      code: "GIT_SHA_DESCONOCIDO",
      kind: "ENTORNO",
      message:
        "git-sha del motor desconocido: no se puede acreditar con qué versión se calculó la cifra " +
        "(es una carencia de trazabilidad del despliegue, no un descuadre)",
    })
  }
  // EV-8: primer run tras un cambio de motor.
  if (ctx.lastGitSha != null && ctx.lastGitSha !== ctx.gitSha) {
    out.push({
      code: "MOTOR_CAMBIADO",
      kind: "ENTORNO",
      message: `primer informe tras cambiar el motor (${ctx.lastGitSha} → ${ctx.gitSha})`,
    })
  }
  // EV-7: no es una variación, es una REDEFINICIÓN de la métrica. Comparar dos
  // periodos con configuraciones analíticas distintas es comparar dos cosas.
  if (ctx.lastAnalyticsHash != null && (ctx.analyticsHash ?? null) !== ctx.lastAnalyticsHash) {
    out.push({
      code: "ANALITICA_REDEFINIDA",
      kind: "CONFIGURACION",
      message: "la configuración analítica ha cambiado desde el informe comparado: la métrica no es la misma",
    })
  }
  // EV-10: la partida cambió de sitio; la variación del epígrafe es un artefacto.
  if (ctx.reclassifiedAccounts && ctx.reclassifiedAccounts.length > 0) {
    out.push({
      code: "EPIGRAFE_CAMBIADO",
      kind: "CONFIGURACION",
      message: `cambió el epígrafe de ${ctx.reclassifiedAccounts.join(", ")}, con líneas en el periodo comparado`,
    })
  }
  if (ctx.manualReviewReason) {
    out.push({
      code: "REVISION_FORZADA",
      kind: "CONFIGURACION",
      message: `revisión forzada por un administrador: ${ctx.manualReviewReason}`,
    })
  }
  if (ctx.regularizacionDesfasada) {
    const { i3Cents, saldo129Cents } = ctx.regularizacionDesfasada
    out.push({
      code: "REGULARIZACION_DESFASADA",
      kind: "INVARIANTE",
      invariantId: "I-E6-13",
      // Las DOS cifras y su diferencia. Nunca se elige una en silencio.
      message:
        `La regularización está desfasada: la PyG del periodo (I3) suma ${i3Cents} céntimos y la 129 ` +
        `recoge ${-saldo129Cents}; difieren en ${i3Cents - -saldo129Cents}. Hay líneas de los grupos 6/7 ` +
        "posteriores a la regularización: anúlala con contra-asiento, postea y vuelve a regularizar",
    })
  }
  return out
}

/** EV-9: cualquier invariante en FAIL sella `REQUIERE REVISIÓN` con su ID. */
export function invariantReasons(checks: readonly CheckResult[]): ReportSealReason[] {
  return checks
    .filter((c) => c.status === "FAIL")
    .map((c) => ({
      code: "INVARIANTE_FAIL" as const,
      kind: "INVARIANTE" as const,
      invariantId: c.id,
      message: `${c.id} en FAIL: ${c.evidencia}`,
    }))
}

export type ReportSeal = "VALIDADO_AUTOMATICAMENTE" | "REQUIERE_REVISION"

export type ReportSealInput = {
  checks: readonly CheckResult[]
  breaches?: readonly ThresholdBreach[]
  always: AlwaysReviewContext
  /** Nº de WARN por encima del cual se exige revisión. Por defecto, cualquiera. */
  warnThreshold?: number
}

export function reportSealReasons(input: ReportSealInput): ReportSealReason[] {
  const warned = input.checks.filter((c) => c.status === "WARN")
  const threshold = input.warnThreshold ?? 0
  return [
    ...invariantReasons(input.checks),
    ...(input.breaches ?? []),
    ...alwaysReviewReasons(input.always),
    ...(warned.length > threshold
      ? [
          {
            code: "INVARIANTE_FAIL" as const,
            kind: "AVISO" as const,
            message: `${warned.length} aviso(s) de calidad de datos: ${warned.map((c) => c.id).join(", ")}`,
          },
        ]
      : []),
  ]
}

export const sealOf = (reasons: readonly ReportSealReason[]): ReportSeal =>
  reasons.length === 0 ? "VALIDADO_AUTOMATICAMENTE" : "REQUIERE_REVISION"
