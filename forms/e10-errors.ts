/**
 * E10 · T14 — Traducción de `E10ErrorCode` a **español contable con salida**.
 *
 * Los modelos ya abortan con un mensaje anclado al objeto («la versión 2026-BASE
 * está sellada desde el 15-01-2026»). Lo que falta, y es lo que §4.2 pide, es la
 * **salida**: qué tiene que hacer quien lo lee. Eso es del borde, no del modelo,
 * porque depende de la pantalla en la que está el usuario.
 *
 * Vive en `forms/` —y no en un `lib/` nuevo— porque es del mismo lote que los
 * schemas (T14) y porque un fichero `"use server"` sólo puede exportar funciones
 * asíncronas: la tabla no cabe dentro de un `actions.ts`.
 */

import type { E10ErrorCode } from "@/models/e10-errors"
import type { LedgerModelError } from "@/models/ledger"

/** La salida de cada error. Vacía = el mensaje del modelo ya la lleva. */
const E10_NEXT_STEP: Record<E10ErrorCode, string> = {
  // ── Presupuesto ───────────────────────────────────────────────────────────
  BUDGET_NOT_FOUND: "Elige una versión del selector de presupuesto",
  BUDGET_SEALED: "Crea una revisión desde el selector de versiones: lo sellado no se edita",
  BUDGET_NOT_SEALED:
    "Puedes verla en previsualización, pero un informe firmado necesita una versión sellada (O-E10-5)",
  BUDGET_SIGN: "En este producto el gasto presupuestado va en NEGATIVO: es el aporte al margen (ADR-0018 D2)",
  BUDGET_TYPE_REQUIRED: "Asigna el tipo analítico a la cuenta en Configuración → Analítica",
  BUDGET_DIMENSION: "Cada celda lleva UN proyecto o UN centro de coste, nunca los dos ni ninguno",
  BUDGET_MONTH_OUT_OF_YEAR: "El mes de la celda tiene que caer dentro del ejercicio de la versión",
  BUDGET_VERSION_EXISTS: "Ya existe esa versión: usa la que hay o crea la revisión siguiente",
  BUDGET_VALIDITY: "Las vigencias de las versiones no dejan solape ni hueco (O-E10-8)",
  BUDGET_CSV_SIGN_CONVENTION: "Corrige el signo en origen y vuelve a importar: no se ha insertado ninguna fila",
  BUDGET_ACCOUNT_NOT_PNL: "Sólo se presupuestan cuentas de los grupos 6 y 7: el CAPEX del grupo 2 llega en E11",
  BUDGET_SUPERSEDE_TARGET: "La versión que sustituye tiene que estar sellada: un borrador no releva a nadie",
  // ── Horas ─────────────────────────────────────────────────────────────────
  TIME_ENTRY_NOT_FOUND: "Actualiza la lista de partes: alguno ya no está",
  TIME_ENTRY_APPROVED: "Corrígelo con un contra-apunte, indicando el motivo",
  TIME_ENTRY_NOT_APPROVED: "Sólo se corrige por contra-apunte un parte ya aprobado; un borrador se edita",
  TIME_SELF_APPROVAL: "Que lo apruebe otra persona, o un ADMIN (segregación P5, R-H-4)",
  TIME_PERIOD_LOCKED: "Un ADMIN puede desbloquear el mes, con motivo, en Configuración → Periodos",
  TIME_DAILY_CEILING: "Revisa los partes de ese día: entre todos pasan de 24 horas",
  TIME_MINUTES_RANGE: "Los partes se registran en minutos enteros distintos de 0",
  TIME_DIMENSION: "Un parte va a UN proyecto o a UN centro de coste",
  // ── Empleados y tarifas ───────────────────────────────────────────────────
  EMPLOYEE_NOT_FOUND: "Actualiza la ficha: el empleado no está en esta organización",
  EMPLOYEE_CODE_EXISTS: "Usa otro código: el del empleado es único en la organización",
  RATE_BASIS_CONFLICT:
    "Cierra las reglas de imputación por horas o elige una base sin estructura: si no, la estructura se cargaría dos veces",
  RATE_OVERLAP: "Las vigencias de una tarifa no se solapan: cierra la anterior antes de abrir la nueva",
  RATE_NOT_EVALUABLE: "Sin tarifa vigente la cifra es NO EVALUABLE, nunca 0: declara una tarifa con su base",
  HEADCOUNT_NOT_LAST_DAY: "El snapshot de plantilla es a fin de mes (FTE·mes, Q-7)",
  // ── Inmovilizado ──────────────────────────────────────────────────────────
  ASSET_DIMENSION_XOR: "Elige el proyecto o el centro de coste que soporta el activo, no los dos",
  // ── Transversales ─────────────────────────────────────────────────────────
  FISCAL_YEAR_NOT_FOUND: "Abre el ejercicio en Configuración → Ejercicios",
  REASON_TOO_SHORT: "Escribe un motivo de al menos 10 caracteres: queda en la auditoría",
}

const isE10Code = (value: string | undefined): value is E10ErrorCode =>
  value !== undefined && Object.prototype.hasOwnProperty.call(E10_NEXT_STEP, value)

/** Un error, con su salida detrás. Nunca repite lo que el mensaje ya dice. */
export function e10Message(error: Pick<LedgerModelError, "message" | "check" | "lineNo">): string {
  const base = error.lineNo !== undefined ? `[línea ${error.lineNo}] ${error.message}` : error.message
  if (!isE10Code(error.check)) return base
  const step = E10_NEXT_STEP[error.check]
  if (step.length === 0) return base
  // El modelo ya suele traer la salida («crea una revisión en vez de editarla»):
  // repetirla convierte un mensaje útil en ruido.
  const already = step
    .toLowerCase()
    .split(" ")
    .slice(0, 3)
    .join(" ")
  if (base.toLowerCase().includes(already)) return base
  return `${base}. ${step}`
}

export function formatE10Errors(errors: readonly LedgerModelError[]): string {
  return errors.map(e10Message).join(" · ")
}
