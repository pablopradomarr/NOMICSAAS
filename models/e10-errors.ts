/**
 * E10 · T12 — Errores de los modelos de presupuesto, horas y empleados.
 *
 * Viven aparte, y no en `models/ledger.ts`, por la misma razón que los de E9
 * (`models/e9-errors.ts`): `LedgerModelErrorCode` es el vocabulario del **motor
 * del diario**, y «esta versión de presupuesto está sellada» o «el parte de
 * horas ya está aprobado» no son errores de partida doble. El código propio
 * viaja en `check`, que es justo el campo que la UI ya enseña como
 * «comprobación que lo produce».
 *
 * Los mensajes van en **español contable y anclados al objeto** (§4.2 del
 * diseño): dicen qué versión, qué empleado y qué fecha, y qué hacer a
 * continuación. Un «operación no permitida» obliga al usuario a adivinar.
 */

import { abort, modelErr, type LedgerModelError } from "@/models/ledger"

/** Vocabulario propio de E10. Cada código dice qué se comprobó. */
export type E10ErrorCode =
  // ── Presupuesto ───────────────────────────────────────────────────────────
  | "BUDGET_NOT_FOUND"
  | "BUDGET_SEALED"
  | "BUDGET_NOT_SEALED"
  | "BUDGET_SIGN"
  | "BUDGET_TYPE_REQUIRED"
  | "BUDGET_DIMENSION"
  | "BUDGET_MONTH_OUT_OF_YEAR"
  | "BUDGET_VERSION_EXISTS"
  | "BUDGET_VALIDITY"
  | "BUDGET_CSV_SIGN_CONVENTION"
  | "BUDGET_ACCOUNT_NOT_PNL"
  | "BUDGET_SUPERSEDE_TARGET"
  // ── Horas ─────────────────────────────────────────────────────────────────
  | "TIME_ENTRY_NOT_FOUND"
  | "TIME_ENTRY_APPROVED"
  | "TIME_ENTRY_NOT_APPROVED"
  | "TIME_SELF_APPROVAL"
  | "TIME_PERIOD_LOCKED"
  | "TIME_DAILY_CEILING"
  | "TIME_MINUTES_RANGE"
  | "TIME_DIMENSION"
  // ── Empleados y tarifas ───────────────────────────────────────────────────
  | "EMPLOYEE_NOT_FOUND"
  | "EMPLOYEE_CODE_EXISTS"
  | "RATE_BASIS_CONFLICT"
  | "RATE_OVERLAP"
  | "RATE_NOT_EVALUABLE"
  | "HEADCOUNT_NOT_LAST_DAY"
  // ── Inmovilizado (deuda §0-bis #7, la mitad de servidor) ──────────────────
  | "ASSET_DIMENSION_XOR"
  // ── Transversales ─────────────────────────────────────────────────────────
  | "FISCAL_YEAR_NOT_FOUND"
  | "REASON_TOO_SHORT"

/**
 * `LedgerModelError` con un código de E10. El tipo del campo `code` es el del
 * diario, así que el código propio viaja en `check` (patrón `e9Err`).
 */
export function e10Err(code: E10ErrorCode, field: string, message: string): LedgerModelError {
  return modelErr("DB_REJECTED", field, message, { check: code })
}

/** Aborta la transacción en curso con un error de E10. Nunca retorna. */
export function e10Abort(code: E10ErrorCode, field: string, message: string): never {
  abort(e10Err(code, field, message))
}

/** Motivo obligatorio de ≥ 10 caracteres (contra-apunte, sustitución). */
export function assertReason(reason: string | null | undefined, field: string, what: string): string {
  const trimmed = (reason ?? "").trim()
  if (trimmed.length < 10) {
    e10Abort("REASON_TOO_SHORT", field, `${what} exige un motivo de al menos 10 caracteres`)
  }
  return trimmed
}
