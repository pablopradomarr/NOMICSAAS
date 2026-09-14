/**
 * E6 · T10 — Clave de reutilización, forma canónica y política de umbrales de
 * `ReportRun` (ADR-0003 y ADR-0012 D3).
 *
 * Módulo PURO: sin IO, sin `Date.now()`, sin Prisma. El sha256 sale de
 * `node:crypto`, que es determinista y no toca el mundo exterior.
 */

import { createHash } from "node:crypto"

import { z } from "zod"

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
  if (Array.isArray(value)) {
    // #13: en un objeto, `undefined` significa «esta clave no está» y se puede
    // descartar; en un ARRAY significa «hay un hueco aquí», y serializarlo como
    // `null` cambiaría el dato sin avisar. Dos informes distintos compartirían
    // hash. Se para antes de hashear.
    const hole = value.findIndex((v) => v === undefined)
    if (hole >= 0) throw new Error(`canonicalJson: hueco (undefined) en la posición ${hole} de un array`)
    return `[${value.map(canonicalJson).join(",")}]`
  }
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
  /**
   * E5 · O-E5-7 (auditoría, hallazgo 3) — el sello del CONJUNTO de runs, NO el
   * id de un run. Se llamaba `allocationRunId`, que es la columna que la
   * migración de E5 **eliminó**: mientras nadie lo informaba la clave coincidía
   * por casualidad (∅ contra columna NULL), y el día que un informe se sellara
   * con imputaciones la clave de la aplicación y la del trigger
   * `app.report_runs_analytics_key` habrían divergido en silencio.
   */
  allocationRunSetHash?: string | null
}): string {
  return [
    input.analyticsHash ?? SENTINEL,
    input.marginConfigHash ?? SENTINEL,
    input.allocationRunSetHash ?? SENTINEL,
  ].join("|")
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
  /**
   * **E10 · M5 — el NOVENO componente.** Dos `PRESUPUESTO_REAL` del mismo
   * periodo y el mismo diario con **versiones distintas de presupuesto** son
   * informes distintos: sin el hash en la clave, la caché serviría el de la
   * versión equivocada. `"∅"` en todo lo que no es presupuesto vs real, y el
   * CHECK `report_runs_budget_hash_required` impide lo contrario.
   *
   * Y sólo ahí: el balance, la PyG contable, el cashflow, el diario y la PyG
   * analítica **conservan su caché** al sellar un presupuesto, porque ni
   * `ledgerHash` ni `analyticsKey` se mueven (criterio 17).
   */
  budgetHash?: string
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
    input.budgetHash ?? SENTINEL,
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
  // ── E10 · §5.3 — los CUATRO KPI de desviación presupuestaria ───────────────
  // Misma forma que los siete de ADR-0012: `pctBps` **y** `minAbsCents`, y
  // dispara sólo si supera los dos.
  desviacionIngresos: { pctBps: 1000, minAbsCents: 500_000 },
  desviacionEbitda: { pctBps: 1500, minAbsCents: 300_000 },
  desviacionMc3: { pctBps: 1500, minAbsCents: 300_000 },
  /**
   * **O-E10-18 — el cuarto, y el que de verdad hacía falta.** Los tres
   * anteriores son «total compañía», y dos desviaciones grandes de signo
   * contrario **se anulan**: con MC3 de P-01 a −1 500 000 c y MC3 de P-02 a
   * +1 500 000 c la desviación total es 0 c y 0 bps, no dispara nada y el
   * informe se firma `VALIDADO AUTOMÁTICAMENTE` con dos proyectos fuera de
   * control. Éste mira el **máximo |desviación| POR DIMENSIÓN** en INGRESOS, MC2
   * y MC3. El coste marginal es nulo: la matriz ya está calculada.
   */
  desviacionMaxDimension: { pctBps: 2000, minAbsCents: 500_000 },
}

/** Los KPI de E10, para que la pantalla de umbrales los agrupe aparte. */
export const BUDGET_KPIS: readonly string[] = [
  "desviacionIngresos",
  "desviacionEbitda",
  "desviacionMc3",
  "desviacionMaxDimension",
]

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

const COMPARATIVE_BASES = [
  "SAME_PERIOD_PREVIOUS_YEAR",
  "PREVIOUS_FISCAL_YEAR_CLOSE",
  "PREVIOUS_PERIOD",
  "NONE",
] as const

export const kpiThresholdSchema = z.object({
  pctBps: z.number().int().min(0).max(1_000_000).nullable(),
  minAbsCents: z.number().int().min(0).nullable(),
  minPointsBps: z.number().int().min(0).nullable().default(null),
})

/**
 * Schema CANÓNICO de `Organization.reviewThresholds` (#10). Vive en el módulo
 * puro y `forms/reports.ts` lo reexporta: un segundo schema en el formulario
 * acabaría admitiendo lo que el motor rechaza, o al revés.
 */
export const reviewThresholdsSchema = z.object({
  version: z.literal(1),
  comparativeBasis: z.enum(COMPARATIVE_BASES).default(DEFAULT_COMPARATIVE_BASIS),
  kpis: z.record(z.string(), kpiThresholdSchema).default(DEFAULT_KPI_THRESHOLDS),
})

/**
 * Umbrales de la organización, PARSEADOS. Una columna `Json?` puede contener
 * cualquier cosa —una versión vieja, un `kpis` a medias editado a mano—; sin
 * parsear, `checkThresholds` leería `pctBps: undefined` y dejaría de disparar en
 * silencio, que es la peor forma de romper un sello. Ante cualquier cosa que no
 * valide se cae a los valores por defecto, que son conservadores.
 */
export function parseReviewThresholds(raw: unknown): ReviewThresholds {
  const parsed = reviewThresholdsSchema.safeParse(raw)
  if (!parsed.success) return DEFAULT_REVIEW_THRESHOLDS
  return {
    version: 1,
    comparativeBasis: parsed.data.comparativeBasis as ComparativeBasis,
    kpis: parsed.data.kpis,
  }
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
  /** A1: el diario del periodo cambió sin que ningún asiento lo justifique. */
  | "LEDGER_DRIFT"
  /** #5: el plan de cuentas o el mapa cambiaron desde el informe anterior. */
  | "PLAN_CAMBIADO"
  // ── E10 · §5.3 — los CINCO motivos del presupuesto y de las horas ──────────
  // Códigos CERRADOS: la Auditoría filtra por código, nunca hace `LIKE`. Y
  // **ningún motivo sin regla que lo emita, ninguna regla sin motivo**: es lo
  // que O-E10-17 exige y lo que el criterio 33 recorre con un test.
  /** EV-11 y los umbrales `desviacion*`: la desviación supera lo tolerado. */
  | "DESVIACION_PRESUPUESTO"
  /** EV-12: no hay versión vigente para el periodo. La columna sale vacía. */
  | "PRESUPUESTO_AUSENTE"
  /** EV-15 / O-E10-2: minutos SIN APROBAR que una regla de actividad habría usado. */
  | "HORAS_SIN_APROBAR"
  /** EV-16 / O-E10-16: una regla `HEADCOUNT` reparte a un CECO sin snapshot. */
  | "PLANTILLA_AUSENTE"
  /** EV-17: partes sin tarifa vigente y el informe publica coste-hora. */
  | "TARIFA_AUSENTE"

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
  /**
   * A1 / I-E6-20: el `ledgerHash` del periodo NO coincide con el del último
   * `ReportRun` del mismo periodo y **no hay nada en el diario que lo explique**
   * (ni asientos nuevos, ni anulaciones, ni reclasificaciones en el `AuditLog`).
   */
  ledgerDrift?: { previousHash: string; currentHash: string } | null
  /** #5: hash del plan o del mapa de cuentas distinto del informe anterior. */
  planDrift?: { what: "plan" | "mapa"; previous: string; current: string } | null
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
  // A1 — la manipulación «coherente»: alguien cambia un `account_code` por SQL y
  // recalcula el `entry_hash` para que I-E3-7 no chille. Los importes siguen
  // cuadrando, I1 pasa, el sello saldría VALIDADO… y el balance es otro. Lo
  // único que lo delata es que el `ledgerHash` del periodo se mueva sin que haya
  // un asiento, una anulación o una reclasificación que lo justifique.
  if (ctx.ledgerDrift) {
    out.push({
      code: "LEDGER_DRIFT",
      kind: "INVARIANTE",
      invariantId: "I-E6-20",
      message:
        `El diario del periodo ha cambiado (sha256:${ctx.ledgerDrift.previousHash.slice(0, 12)}… → ` +
        `sha256:${ctx.ledgerDrift.currentHash.slice(0, 12)}…) sin ningún asiento posteado, anulado ` +
        "ni reclasificado que lo explique. Alguien ha escrito en `journal_lines` fuera de la aplicación",
    })
  }
  if (ctx.planDrift) {
    out.push({
      code: "PLAN_CAMBIADO",
      kind: "CONFIGURACION",
      message:
        `Ha cambiado el ${ctx.planDrift.what} de cuentas desde el informe anterior ` +
        `(${ctx.planDrift.previous.slice(0, 12)}… → ${ctx.planDrift.current.slice(0, 12)}…): ` +
        "las partidas pueden haberse movido de epígrafe y la variación sería un artefacto",
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

// ─────────────────────────────────────────────────────────────────────────────
// E10 · §5.3 — la familia `EV-11 … EV-17` del presupuesto y de las horas
//
// Hermanas de las diez de ADR-0012 y con su mismo contrato: funciones PURAS,
// código cerrado y **ningún motivo decorativo**. `EV-14` está RETIRADA
// (O-E10-5): presuponía que un `BORRADOR` puede emitir un `ReportRun`, y el
// esquema lo impide —`budgets_sealed_marks` obliga a `budget_hash IS NULL`
// mientras el estado es `BORRADOR` y `report_runs_budget_hash_required` exige
// `budget_hash <> '∅'` para este tipo—, así que **no hay hash que escribir**.
// Compararse contra un borrador es una previsualización no sellada, y pedir un
// informe firmado contra él es el rechazo `BUDGET_NOT_SEALED`.
// ─────────────────────────────────────────────────────────────────────────────

export type BudgetReviewContext = {
  /**
   * **EV-11 · dispara siempre** — `budgetHash` distinto del del run anterior del
   * mismo periodo. Cambiar de versión de presupuesto **redefine la medida**, no
   * es una variación; presentarlo como tal escondería una reproyección detrás de
   * un «dentro de umbral».
   */
  budgetHash?: string | null
  lastBudgetHash?: string | null
  /** **EV-12** — meses del periodo sin ninguna versión vigente que los cubra. */
  monthsWithoutBudget?: readonly string[]
  /**
   * **EV-13 · NO dispara** — meses del periodo todavía no cerrados. La
   * desviación es parcial por construcción y se marca como tal; lo que informa
   * ahí es el forecast, que para eso existe.
   */
  openMonths?: readonly string[]
  /**
   * **EV-15 · dispara siempre** (O-E10-2 / O-E10-17) — minutos SIN APROBAR del
   * periodo que alguna regla de actividad habría usado, y su % sobre la base.
   * En la ronda 0 el aviso sólo aparecía con base 0, y lo que un receptor dejaba
   * de absorber se publicaba en silencio.
   */
  unapprovedMinutes?: { minutes: number; baseMinutes: number; targets: readonly string[] } | null
  /**
   * **EV-16 · dispara siempre** (O-E10-16) — CECOs a los que una regla
   * `HEADCOUNT` reparte **sin snapshot** en el periodo. Un snapshot con
   * `fteMilli = 0` **no** entra aquí: es un dato, no un hueco.
   */
  costCentersWithoutHeadcount?: readonly string[]
  /**
   * **EV-17 · dispara siempre** — partes sin tarifa vigente **y** el informe
   * publica coste-hora o margen por hora. I-E10-5 puede quedarse en `INFO` —no
   * es un error de cuadre—, pero un margen por hora calculado con partes sin
   * tarifa **no es un margen**, así que el sello sí se mueve.
   */
  unpricedTime?: { entries: number; employees: readonly string[] } | null
  publishesHourlyCost?: boolean
}

/** `⌊parte · 10000 / total⌋` en ENTERO, o `null` sin base. Ni `NaN` ni `∞`. */
export const shareBps = (part: number, total: number): number | null =>
  total === 0 ? null : Math.floor((abs(part) * 10_000) / abs(total))

/**
 * EV-11…EV-13 y EV-15…EV-17. Devuelve los motivos en el mismo formato que
 * `alwaysReviewReasons`, para que `reportSealReasons` los componga sin saber de
 * dónde salen.
 */
export function budgetReviewReasons(ctx: BudgetReviewContext): ReportSealReason[] {
  const out: ReportSealReason[] = []

  // EV-11 — cambiar de versión redefine la medida.
  if (
    ctx.lastBudgetHash != null &&
    ctx.lastBudgetHash !== SENTINEL &&
    ctx.budgetHash != null &&
    ctx.budgetHash !== ctx.lastBudgetHash
  ) {
    out.push({
      code: "DESVIACION_PRESUPUESTO",
      kind: "CONFIGURACION",
      message:
        `La versión de presupuesto ha cambiado desde el informe anterior ` +
        `(sha256:${ctx.lastBudgetHash.slice(0, 12)}… → sha256:${ctx.budgetHash.slice(0, 12)}…): ` +
        "la desviación se mide contra otra medida, no es una variación del negocio",
    })
  }

  // EV-12 — sin versión vigente: la columna sale vacía y el sello lo dice. Un
  // aviso que no mueve el sello es decorativo (lección H-4 de E7).
  if (ctx.monthsWithoutBudget && ctx.monthsWithoutBudget.length > 0) {
    out.push({
      code: "PRESUPUESTO_AUSENTE",
      kind: "AVISO",
      message:
        `No hay versión de presupuesto vigente para ${ctx.monthsWithoutBudget.length} mes(es) del periodo ` +
        `(${ctx.monthsWithoutBudget.join(", ")}): esas celdas salen VACÍAS, nunca a cero`,
    })
  }

  // EV-13 — periodo con meses no cerrados: se declara parcial y NO dispara.
  // Está aquí para que quede escrito que se comprobó, no para sellar.

  // EV-15 — horas sin aprobar que el driver habría usado.
  if (ctx.unapprovedMinutes && ctx.unapprovedMinutes.minutes > 0) {
    const { minutes, baseMinutes, targets } = ctx.unapprovedMinutes
    const bps = shareBps(minutes, baseMinutes)
    out.push({
      code: "HORAS_SIN_APROBAR",
      kind: "AVISO",
      message:
        `Hay ${minutes} minutos SIN APROBAR en el periodo que una regla de actividad habría usado` +
        `${bps === null ? "" : ` (${bps} puntos básicos sobre la base de ${baseMinutes} minutos)`}` +
        `${targets.length > 0 ? `, en ${targets.join(", ")}` : ""}: el reparto publicado no los absorbe`,
      deltaBps: bps,
    })
  }

  // EV-16 — receptor de una regla HEADCOUNT sin snapshot: hueco de datos.
  if (ctx.costCentersWithoutHeadcount && ctx.costCentersWithoutHeadcount.length > 0) {
    out.push({
      code: "PLANTILLA_AUSENTE",
      kind: "AVISO",
      message:
        `Una regla PLANTILLA reparte a ${ctx.costCentersWithoutHeadcount.join(", ")} y no hay snapshot de ` +
        "plantilla en el periodo: su peso es 0 porque falta el dato, no porque no haya nadie. " +
        "Un snapshot con 0 FTE declarado sí es un dato y no aparecería aquí",
    })
  }

  // EV-17 — coste-hora publicado con partes sin tarifa vigente.
  if (ctx.publishesHourlyCost === true && ctx.unpricedTime && ctx.unpricedTime.entries > 0) {
    out.push({
      code: "TARIFA_AUSENTE",
      kind: "AVISO",
      message:
        `${ctx.unpricedTime.entries} parte(s) de horas sin tarifa vigente ` +
        `(${ctx.unpricedTime.employees.join(", ")}) y el informe publica coste-hora o margen por hora: ` +
        "un margen por hora calculado con partes sin tarifa no es un margen",
    })
  }

  return out
}

/**
 * **EV-13** — ¿el periodo comparado contiene meses NO cerrados? No dispara
 * revisión; marca la desviación como parcial, que es lo honesto.
 */
export const varianceIsPartial = (ctx: Pick<BudgetReviewContext, "openMonths">): boolean =>
  (ctx.openMonths?.length ?? 0) > 0

/**
 * **O-E10-17 / criterio 33 — un motivo, una regla.** Los motivos de E10 y la
 * regla que los emite. El test recorre esta tabla contra `SealReasonCode` y
 * comprueba que **cada** motivo tiene al menos una regla y que **cada** regla
 * emite un motivo del código cerrado. Ningún motivo decorativo.
 */
export const E10_SEAL_REASON_RULES: Readonly<Record<string, readonly string[]>> = {
  DESVIACION_PRESUPUESTO: ["EV-11", "umbral desviacionIngresos", "umbral desviacionEbitda", "umbral desviacionMc3", "umbral desviacionMaxDimension"],
  PRESUPUESTO_AUSENTE: ["EV-12"],
  HORAS_SIN_APROBAR: ["EV-15"],
  PLANTILLA_AUSENTE: ["EV-16"],
  TARIFA_AUSENTE: ["EV-17"],
}
