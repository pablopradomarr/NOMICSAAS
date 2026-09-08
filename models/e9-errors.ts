/**
 * E9 · T12 — Errores de los modelos de cierre, recurrentes y fiscalidad
 * periódica.
 *
 * Viven aparte, y no en `models/ledger.ts`, por dos razones. La primera es de
 * frontera: `LedgerModelErrorCode` es el vocabulario del **motor del diario**, y
 * «esta deuda no tiene desglose de vencimientos» o «el ejercicio ya tiene una
 * distribución» no son errores de partida doble. La segunda es de ciclo:
 * `models/closing.ts` compone las lecturas de los otros seis modelos, así que el
 * vocabulario compartido no puede vivir en ninguno de ellos.
 *
 * Se traducen igual que los del diario: quien llama está dentro de
 * `runLedgerTransaction`, esto **aborta lanzando** y el rollback está hecho
 * antes de que el error llegue a la UI (lección BLOQUEA #1 de E3).
 */

import { abort, modelErr, type LedgerModelError } from "@/models/ledger"

/** Vocabulario propio de E9. Cada código dice qué se comprobó, no «falló algo». */
export type E9ErrorCode =
  | "RECURRING_NOT_FOUND"
  | "OCCURRENCE_NOT_FOUND"
  | "ASSET_NOT_FOUND"
  | "ASSET_NOT_LINEAL"
  | "ASSET_ALREADY_DISPOSED"
  | "ACCRUAL_NOT_FOUND"
  | "DEBT_SCHEDULE_NOT_FOUND"
  | "DEBT_SCHEDULE_UNBALANCED"
  | "VAT_SETTLEMENT_NOT_FOUND"
  | "VAT_PERIOD_ALREADY_SETTLED"
  | "VAT_REGIME_NOT_DECLARED"
  | "PRORRATA_YEAR_NOT_FOUND"
  | "CLOSING_RUN_NOT_FOUND"
  | "CLOSING_RUN_SEALED"
  | "DISTRIBUTION_ALREADY_EXISTS"
  | "FISCAL_YEAR_NOT_FOUND"
  | "APPROVAL_STATUS_REGRESSION"

/**
 * `LedgerModelError` con un código de E9. El tipo del campo `code` es el del
 * diario, así que el código propio viaja en `check`, que es justo el campo que
 * la UI ya enseña como «comprobación que lo produce».
 */
export function e9Err(code: E9ErrorCode, field: string, message: string): LedgerModelError {
  return modelErr("DB_REJECTED", field, message, { check: code })
}

/** Aborta la transacción en curso con un error de E9. Nunca retorna. */
export function e9Abort(code: E9ErrorCode, field: string, message: string): never {
  abort(e9Err(code, field, message))
}
