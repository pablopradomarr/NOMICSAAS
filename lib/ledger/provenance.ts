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
  /**
   * Revisión ronda 1 (#10). Sin estos dos, el drill-down de una celda no
   * reproduce la cifra cuando el informe está acotado a un ejercicio o excluye
   * asientos de sistema: `registros_origen` traía TODAS las líneas del rango de
   * fechas, que no son las que suman esa celda. Ambos son opcionales y, cuando
   * vienen, entran en la consulta y en `parametros` en este orden:
   * `$1 org, $2 from, $3 to, [$n accountCode], [$n fiscalYearId], [$n entryKind]`.
   */
  fiscalYearId?: string
  /** `kind` del asiento: filtra p. ej. la PyG, que excluye CLOSING/OPENING. */
  entryKind?: string
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
  let query = params.query ?? (params.accountCode ? ACCOUNT_QUERY : DEFAULT_QUERY)
  const parametros: (string | number)[] = [params.organizationId, params.from, params.to]
  if (params.accountCode) parametros.push(params.accountCode)

  // #10: el filtro que acota REALMENTE la celda se añade a la consulta, no se
  // deja implícito. `query` explícita manda: quien la trae ya sabe lo que hace.
  if (params.query === undefined && params.fiscalYearId) {
    parametros.push(params.fiscalYearId)
    query += ` AND fiscal_year_id = $${parametros.length}`
  }
  if (params.query === undefined && params.entryKind) {
    parametros.push(params.entryKind)
    query += ` AND entry_kind = $${parametros.length}`
  }
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
