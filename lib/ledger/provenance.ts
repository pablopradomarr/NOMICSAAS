/**
 * E3 · T7 — Provenance por celda (skill `fiabilidad`, P6/P7).
 *
 * Cada cifra que sale de un informe lleva de dónde viene: la métrica, el
 * `ledgerHash` del periodo, el módulo + git-sha que la calculó y la consulta
 * PARAMETRIZADA que la origina. El drill-down de la UI ejecuta esa consulta
 * dentro de `tenantTransaction` — nunca se interpola en ella.
 *
 * Módulo PURO.
 */

import type { Cents, LocalDate } from "@/lib/ledger/types"

export type Confidence = "calculado" | "comprobado" | "validado" | "interpretacion_ia" | "no_verificado"

export type Provenance = {
  valor: Cents
  moneda: string
  metrica: string
  run_id: string
  ledgerHash: string
  calculado_por: string
  registros_origen: string
  /** Parámetros de la consulta, en orden ($1, $2, …). Nunca se interpolan. */
  parametros: readonly (string | number)[]
  confianza: Confidence
}

export type ProvenanceParams = {
  organizationId: string
  from: LocalDate
  to: LocalDate
  accountCode?: string
  /** Consulta que devuelve las líneas que componen la cifra. */
  query?: string
  extraParams?: readonly (string | number)[]
}

const DEFAULT_QUERY =
  "SELECT id FROM journal_lines WHERE organization_id = $1 AND entry_date BETWEEN $2 AND $3"

const ACCOUNT_QUERY =
  "SELECT id FROM journal_lines WHERE organization_id = $1 AND entry_date BETWEEN $2 AND $3 AND account_code = $4"

export type ProvenanceContext = {
  runId: string
  ledgerHash: string
  gitSha: string
  baseCurrency: string
  /** Módulo que produce la cifra, sin el sha: "lib/ledger/reports/mayor.ts". */
  module: string
}

/** Bloque de provenance de una celda. */
export function cellProvenance(
  metric: string,
  value: Cents,
  params: ProvenanceParams,
  ctx: ProvenanceContext,
  confidence: Confidence = "calculado"
): Provenance {
  const query = params.query ?? (params.accountCode ? ACCOUNT_QUERY : DEFAULT_QUERY)
  const parametros: (string | number)[] = [params.organizationId, params.from, params.to]
  if (params.accountCode) parametros.push(params.accountCode)
  if (params.extraParams) parametros.push(...params.extraParams)

  return {
    valor: value,
    moneda: ctx.baseCurrency,
    metrica: metric,
    run_id: ctx.runId,
    ledgerHash: `sha256:${ctx.ledgerHash}`,
    calculado_por: `${ctx.module}@${ctx.gitSha}`,
    registros_origen: query,
    parametros,
    confianza: confidence,
  }
}
