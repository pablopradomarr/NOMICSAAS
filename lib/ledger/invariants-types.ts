/**
 * Tipos compartidos por los invariantes de `lib/ledger` y de `lib/analytics`.
 *
 * Viven aparte para que `lib/analytics/invariants.ts` (que `runInvariants`
 * cablea) no tenga que importar `lib/ledger/invariants.ts` y crear un ciclo.
 *
 * Módulo PURO.
 */

export type CheckStatus = "PASS" | "FAIL" | "WARN" | "INFO"

export type CheckResult = {
  id: string
  status: CheckStatus
  /** Qué se ha comprobado y con qué resultado, con cifras concretas. */
  evidencia: string
  /** Consulta que reproduce la evidencia, cuando la hay. */
  query?: string
}
