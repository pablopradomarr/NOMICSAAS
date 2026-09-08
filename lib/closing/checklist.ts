/**
 * E9 · T13 — El checklist del cierre: los pasos, el orden de los asientos y el
 * sello (`docs/design/E9-cierre-recurrentes.md` §4.8, ADR-0016 D1 y D9).
 *
 * **Función pura.** Nada de `prisma`, `fetch`, `Date.now()` ni `new Date()`: la
 * fecha de referencia entra por parámetro y los datos llegan ya leídos en tipos
 * **planos**, igual que en `lib/closing/invariants-e9.ts`. Quien compone el
 * `ChecklistInput` desde la base es `models/fiscal-years.ts`.
 *
 * Tres cosas viven aquí y ninguna toca la base:
 *
 *  1. **El catálogo de pasos** en nueve bloques, con los **nueve bloqueantes**
 *     marcados y su motivo de sello. Un paso es un dato de auditoría con código
 *     cerrado, no una frase.
 *  2. **`closingChecklist`**, que evalúa cada paso contra el `ChecklistInput` y
 *     devuelve su `ClosingStepResult` con **evidencia y provenance**. Lo que no
 *     se puede evaluar sale `INFO` **diciendo qué falta**, jamás `PASS` por
 *     vacuidad (lección de I-E9-5).
 *  3. **`closingSeal`**, que compone el sello **después** de los motivos
 *     (lección **H-4** de E7): `seal` y `sealReasons` dicen lo mismo, siempre.
 *
 * Y dos constantes que son contrato con el resto de E9: `CLOSING_ENTRY_ORDER`
 * (los doce asientos de **O-17**) y `REOPENING_REVERSAL_ORDER` (los cuatro
 * contra-asientos de **O-21**, con los pasos 5-7 en `PENDIENTE_RECOMPUTO`).
 *
 * ---
 * **Hallazgo declarado (como el de los 22/23 pares de T9).** §4.8 y ADR-0016 D9.3
 * dicen «41 pasos en nueve bloques», y la tabla que los enumera contiene **43**
 * (8 · 3 · 7 · 5 · 3 · 7 · 2 · 6 · 2). Se implementan **los 43 enumerados**:
 * quitar dos al azar sería inventar la omisión, y ninguno de los enumerados es
 * prescindible —los quince que el experto echó en falta están todos ahí—. Los
 * **nueve bloqueantes** sí coinciden exactamente con el diseño. Queda anotado
 * para que T26 lo cierre con el experto-contable.
 */

import type { CheckStatus } from "@/lib/ledger/invariants-types"
import type { Cents, LocalDate } from "@/lib/ledger/types"
import type { ClosingStepResult } from "@/lib/closing/vat"
import { E9_SEAL_REASON_TEXT, closingSealReasons, isE9SealReason, type E9SealReason } from "@/lib/closing/invariants-e9"

export type { ClosingStepResult } from "@/lib/closing/vat"

// ─────────────────────────────────────────────────────────────────────────────
// El catálogo: nueve bloques, 43 pasos enumerados, nueve bloqueantes
// ─────────────────────────────────────────────────────────────────────────────

export const CLOSING_BLOCKS = [
  "INTEGRIDAD_DIARIO",
  "TESORERIA",
  "DEVENGO",
  "VALORACION",
  "PRESENTACION",
  "FISCAL",
  "IMPUESTO",
  "SOCIETARIO",
  "ANALITICA",
] as const
export type ClosingBlock = (typeof CLOSING_BLOCKS)[number]

/** El texto del bloque, para la cabecera de la pantalla (§7). */
export const CLOSING_BLOCK_TEXT: Readonly<Record<ClosingBlock, string>> = {
  INTEGRIDAD_DIARIO: "Integridad del diario",
  TESORERIA: "Tesorería",
  DEVENGO: "Devengo",
  VALORACION: "Valoración",
  PRESENTACION: "Presentación",
  FISCAL: "Fiscal",
  IMPUESTO: "Impuesto sobre beneficios",
  SOCIETARIO: "Cierre y societario",
  ANALITICA: "Analítica",
}

/**
 * Cómo se resuelve un paso:
 * · `DERIVADO` — lo calcula el motor desde el diario. No admite respuesta humana.
 * · `DECLARADO` — lo responde una persona (arqueo, confirmaciones, existencias):
 *   sin respuesta sale **WARN**, nunca PASS.
 * · `POSTERIOR` — es un acto societario **posterior** al cierre (legalización,
 *   formulación, junta, depósito): nace `NA` y se completa después (§4.8).
 */
export type ClosingStepNature = "DERIVADO" | "DECLARADO" | "POSTERIOR"

export type ClosingStepDef = {
  step: string
  block: ClosingBlock
  nature: ClosingStepNature
  /** Los **nueve** de §4.8: sin ellos en PASS el ejercicio no se cierra. */
  blocking: boolean
  /** Qué mira el paso, en español contable. Es lo que la pantalla enseña. */
  titulo: string
  /** Norma que lo exige, cuando la hay. */
  norma?: string
  /** Motivo de sello que aporta cuando no está en PASS. */
  sealReason?: E9SealReason
}

export const CLOSING_STEPS: readonly ClosingStepDef[] = [
  // ── Integridad del diario ────────────────────────────────────────────────
  { step: "INVARIANTES_PASS", block: "INTEGRIDAD_DIARIO", nature: "DERIVADO", blocking: true, titulo: "Invariantes I1–I10 y los de E7/E8/E9 en PASS" },
  { step: "SIN_RUNS_FAIL", block: "INTEGRIDAD_DIARIO", nature: "DERIVADO", blocking: true, titulo: "Ninguna validación del ejercicio en FAIL" },
  { step: "SIN_DOCUMENTOS_PROPOSED", block: "INTEGRIDAD_DIARIO", nature: "DERIVADO", blocking: true, titulo: "Ningún documento del ejercicio en propuesta sin contabilizar" },
  { step: "ALMACEN_BARRIDO", block: "INTEGRIDAD_DIARIO", nature: "DERIVADO", blocking: false, titulo: "Bandeja de documentos sin clasificar barrida" },
  { step: "EJERCICIO_COMPLETO", block: "INTEGRIDAD_DIARIO", nature: "DERIVADO", blocking: false, titulo: "Los doce meses del ejercicio tienen movimiento o quedan explicados" },
  { step: "SUMAS_SALDOS_MENSUALES", block: "INTEGRIDAD_DIARIO", nature: "DERIVADO", blocking: false, titulo: "Σdebe = Σhaber mes a mes", norma: "art. 28.1 CCom · I-E7-17" },
  { step: "CUENTAS_PUENTE_A_CERO", block: "INTEGRIDAD_DIARIO", nature: "DERIVADO", blocking: false, titulo: "Cuentas puente (555, 551, 4749) a cero", norma: "I-E7-16" },
  { step: "SALDOS_CONTRA_NATURALEZA", block: "INTEGRIDAD_DIARIO", nature: "DERIVADO", blocking: false, titulo: "Saldos contrarios a la naturaleza de su cuenta revisados", norma: "I-E7-15" },

  // ── Tesorería ────────────────────────────────────────────────────────────
  { step: "CONCILIACION_BANCARIA", block: "TESORERIA", nature: "DERIVADO", blocking: false, titulo: "Todas las cuentas bancarias conciliadas al corte" },
  { step: "ARQUEO_DE_CAJA", block: "TESORERIA", nature: "DECLARADO", blocking: false, titulo: "Arqueo de caja firmado" },
  { step: "CONFIRMACIONES_BANCARIAS", block: "TESORERIA", nature: "DECLARADO", blocking: false, titulo: "Confirmaciones bancarias de saldos y de deudas" },

  // ── Devengo ──────────────────────────────────────────────────────────────
  { step: "RECURRENTES_AL_DIA", block: "DEVENGO", nature: "DERIVADO", blocking: false, titulo: "Reglas recurrentes sin periodos vencidos pendientes", sealReason: "RECURRENTES_PENDIENTES" },
  { step: "AMORTIZACION_AL_DIA", block: "DEVENGO", nature: "DERIVADO", blocking: false, titulo: "Amortización del ejercicio dotada activo a activo", norma: "I-E9-5" },
  { step: "PERIODIFICACIONES_AL_DIA", block: "DEVENGO", nature: "DERIVADO", blocking: false, titulo: "Periodificaciones imputadas y agotadas al vencer", sealReason: "PERIODIFICACION_SIN_AGOTAR" },
  { step: "FACTURAS_PENDIENTES_DE_RECIBIR", block: "DEVENGO", nature: "DECLARADO", blocking: false, titulo: "Facturas pendientes de recibir registradas (4009/410)" },
  { step: "INGRESOS_NO_FACTURADOS", block: "DEVENGO", nature: "DECLARADO", blocking: false, titulo: "Ingresos devengados no facturados registrados (4309)" },
  { step: "EXISTENCIAS_OBRA_EN_CURSO", block: "DEVENGO", nature: "DECLARADO", blocking: false, titulo: "Existencias y obra en curso valoradas (33x, 61x/71x)" },
  { step: "SUBVENCIONES_IMPUTADAS", block: "DEVENGO", nature: "DECLARADO", blocking: false, titulo: "Subvenciones imputadas al resultado del ejercicio (746/130)" },

  // ── Valoración ───────────────────────────────────────────────────────────
  { step: "DIFERENCIAS_DE_CAMBIO", block: "VALORACION", nature: "DERIVADO", blocking: true, titulo: "Diferencias de cambio de las partidas monetarias reconocidas", norma: "NRV 11ª.2.2" },
  { step: "VALOR_ACTUAL_APLAZAMIENTO", block: "VALORACION", nature: "DERIVADO", blocking: false, titulo: "Aplazamientos significativos valorados por su valor actual", norma: "NRV 9ª" },
  { step: "DETERIORO_CREDITOS", block: "VALORACION", nature: "DECLARADO", blocking: false, titulo: "Deterioro de créditos comerciales (694/490)", norma: "art. 13.1 LIS como referencia fiscal" },
  { step: "DETERIORO_INMOVILIZADO", block: "VALORACION", nature: "DECLARADO", blocking: false, titulo: "Deterioro de inmovilizado (691/291)" },
  { step: "PROVISIONES", block: "VALORACION", nature: "DECLARADO", blocking: false, titulo: "Provisiones y contingencias (14x) con su nota de memoria" },

  // ── Presentación ─────────────────────────────────────────────────────────
  { step: "RECLASIFICACION_VENCIMIENTOS", block: "PRESENTACION", nature: "DERIVADO", blocking: true, titulo: "Deuda y crédito reclasificados por vencimiento", norma: "norma 6ª de elaboración" },
  { step: "NO_COMPENSACION", block: "PRESENTACION", nature: "DECLARADO", blocking: false, titulo: "Ninguna partida de activo compensada con una de pasivo", norma: "art. 35.6 CCom" },
  { step: "PERIODO_MEDIO_DE_PAGO", block: "PRESENTACION", nature: "DECLARADO", blocking: false, titulo: "Periodo medio de pago a proveedores calculado", norma: "art. 262 LSC, Ley 15/2010" },

  // ── Fiscal ───────────────────────────────────────────────────────────────
  { step: "IVA_LIQUIDADO", block: "FISCAL", nature: "DERIVADO", blocking: true, titulo: "Todos los periodos de IVA del ejercicio liquidados", sealReason: "IVA_NO_LIQUIDADO" },
  { step: "RETENCIONES_LIQUIDADAS", block: "FISCAL", nature: "DERIVADO", blocking: false, titulo: "Retenciones liquidadas por modelo (111, 115, 123)", norma: "D12" },
  { step: "PRORRATA_DEFINITIVA", block: "FISCAL", nature: "DERIVADO", blocking: true, titulo: "Prorrata definitiva del año cerrada y regularizada", norma: "art. 105 LIVA" },
  { step: "BIENES_DE_INVERSION", block: "FISCAL", nature: "DERIVADO", blocking: true, titulo: "Bienes de inversión sin regularización pendiente", norma: "arts. 107 y 108 LIVA", sealReason: "REGULARIZACION_BIENES_INVERSION_PENDIENTE" },
  { step: "RECC_DEVENGADO_31_12", block: "FISCAL", nature: "DERIVADO", blocking: true, titulo: "Barrido del RECC a 31/12 practicado", norma: "art. 163 terdecies LIVA" },
  { step: "PAGOS_FRACCIONADOS_CONCILIADOS", block: "FISCAL", nature: "DERIVADO", blocking: false, titulo: "Pagos fraccionados y retenciones soportadas conciliados en 473", norma: "O-26" },
  { step: "DECLARACIONES_INFORMATIVAS", block: "FISCAL", nature: "DECLARADO", blocking: false, titulo: "Declaraciones informativas pendientes (347, 349, 190, 390)" },

  // ── Impuesto sobre beneficios ────────────────────────────────────────────
  { step: "IMPUESTO_BENEFICIOS", block: "IMPUESTO", nature: "DERIVADO", blocking: false, titulo: "Impuesto corriente contabilizado en 6300 con 473 cancelada", norma: "art. 10.3 LIS · O-26" },
  { step: "IMPUESTO_DIFERIDO_RESPONDIDO", block: "IMPUESTO", nature: "DECLARADO", blocking: false, titulo: "Diferencias temporarias, BIN y deducciones respondidas", norma: "NRV 13ª", sealReason: "IMPUESTO_DIFERIDO_NO_RECONOCIDO" },

  // ── Cierre y societario ──────────────────────────────────────────────────
  { step: "CIERRE_APERTURA", block: "SOCIETARIO", nature: "DERIVADO", blocking: false, titulo: "Regularización, cierre y apertura posteados en una transacción" },
  { step: "LEGALIZACION_LIBROS", block: "SOCIETARIO", nature: "POSTERIOR", blocking: false, titulo: "Legalización de los libros", norma: "art. 27 CCom, cuatro meses" },
  { step: "FORMULACION", block: "SOCIETARIO", nature: "POSTERIOR", blocking: false, titulo: "Formulación de las cuentas anuales", norma: "art. 253 LSC, tres meses" },
  { step: "JUNTA_GENERAL", block: "SOCIETARIO", nature: "POSTERIOR", blocking: false, titulo: "Junta general de aprobación", norma: "art. 164 LSC, seis meses" },
  { step: "DISTRIBUCION_RESULTADO", block: "SOCIETARIO", nature: "POSTERIOR", blocking: false, titulo: "Distribución del resultado acordada y contabilizada", norma: "arts. 273 y 274 LSC", sealReason: "RESULTADO_SIN_DISTRIBUIR" },
  { step: "DEPOSITO_CUENTAS", block: "SOCIETARIO", nature: "POSTERIOR", blocking: false, titulo: "Depósito de las cuentas en el Registro Mercantil", norma: "art. 279 LSC" },

  // ── Analítica ────────────────────────────────────────────────────────────
  { step: "LIQUIDACION_CECOS", block: "ANALITICA", nature: "DERIVADO", blocking: false, titulo: "Centros de coste liquidados", norma: "ADR-0013" },
  { step: "I4_I5_PASS", block: "ANALITICA", nature: "DERIVADO", blocking: false, titulo: "Σ matriz analítica = PyG contable y Σ imputado = saldo del CECO", norma: "I4 · I5" },
]

export type ClosingStepCode = (typeof CLOSING_STEPS)[number]["step"]

export const CLOSING_STEP_CODES: readonly string[] = CLOSING_STEPS.map((s) => s.step)

/** **Los nueve de §4.8.** Sin ellos en PASS, `closeFiscalYear` rechaza en servidor. */
export const BLOCKING_STEP_CODES: readonly string[] = CLOSING_STEPS.filter((s) => s.blocking).map((s) => s.step)

/**
 * **O-21.** Los tres pasos que la reapertura **no revierte** —son idempotentes—
 * y que quedan marcados `PENDIENTE_RECOMPUTO` para que el asistente los reevalúe
 * y sólo postee delta si lo hay.
 */
export const PENDING_RECOMPUTE_STEP_CODES: readonly string[] = [
  "VALOR_ACTUAL_APLAZAMIENTO",
  "DIFERENCIAS_DE_CAMBIO",
  "RECLASIFICACION_VENCIMIENTOS",
]

export const stepDef = (code: string): ClosingStepDef | undefined => CLOSING_STEPS.find((s) => s.step === code)

// ─────────────────────────────────────────────────────────────────────────────
// O-17 · el orden de los doce asientos del cierre
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **O-17.** El orden de la ronda 0 reclasificaba **antes** de reconocer el valor
 * actual y las diferencias de cambio: `Σ largo + Σ corto` seguía cuadrando pero
 * el importe clasificado como corriente era erróneo **por el importe del
 * ajuste**, que es justo lo que la reclasificación existe para evitar.
 */
export const CLOSING_ENTRY_ORDER: readonly {
  orden: number
  paso: string
  templateCode: string | null
  /** Columna del `ClosingRun` donde se sella el asiento. */
  runColumn: string
  porQue: string
}[] = [
  { orden: 1, paso: "Recurrentes al día", templateCode: null, runColumn: "recurringEntryIds", porQue: "son devengo del ejercicio, no ajuste" },
  { orden: 2, paso: "Devengo RECC del 31-12 de N−1", templateCode: "DEVENGO_RECC", runColumn: "reccAccrualEntryId", porQue: "antes de liquidar el periodo (O-14)" },
  { orden: 3, paso: "Regularización de prorrata definitiva", templateCode: "REGULARIZACION_PRORRATA", runColumn: "prorrataEntryId", porQue: "antes de T-23 del último periodo (O-11)" },
  { orden: 4, paso: "Liquidación del último periodo de IVA", templateCode: "LIQUIDACION_IVA", runColumn: "vatSettlementEntryId", porQue: "deja 472/477 a cero" },
  { orden: 5, paso: "Valor actual del aplazamiento", templateCode: "AJUSTE_VALOR_ACTUAL", runColumn: "presentValueEntryId", porQue: "en la divisa del pasivo, antes de convertir" },
  { orden: 6, paso: "Diferencias de cambio", templateCode: "DIFERENCIAS_CAMBIO_CIERRE", runColumn: "fxEntryId", porQue: "sobre posiciones ya ajustadas por valor actual" },
  { orden: 7, paso: "Reclasificación por vencimiento", templateCode: "RECLASIFICACION_VENCIMIENTOS", runColumn: "reclassEntryId", porQue: "última de las de balance: importes definitivos" },
  { orden: 8, paso: "Impuesto sobre beneficios", templateCode: "IMPUESTO_BENEFICIOS", runColumn: "incomeTaxEntryId", porQue: "después de todo movimiento de 6/7 (art. 10.3 LIS)" },
  { orden: 9, paso: "Regularización del resultado", templateCode: "REGULARIZACION_RESULTADO", runColumn: "regularizacionEntryId", porQue: "barre 6/7, incluida la 6300, contra 129" },
  { orden: 10, paso: "Cierre", templateCode: "CIERRE_EJERCICIO", runColumn: "cierreEntryId", porQue: "saldos ya reclasificados" },
  { orden: 11, paso: "Apertura", templateCode: "APERTURA_EJERCICIO", runColumn: "aperturaEntryId", porQue: "espejo exacto del cierre (I-E9-14)" },
  { orden: 12, paso: "Contra-asiento de la reclasificación", templateCode: "ANULACION", runColumn: "reclassReversalEntryId", porQue: "nº 2 de N+1 (O-8)" },
]

/**
 * **O-21.** La reapertura revierte por contra-asiento y en **orden inverso**:
 * T-28 → T-27 → T-26 → **T-25**. Sin T-25, al recerrar el impuesto se posteaba
 * otra vez y `6300` quedaba al doble con `4752` duplicado.
 */
export const REOPENING_REVERSAL_ORDER: readonly string[] = [
  "APERTURA_EJERCICIO",
  "CIERRE_EJERCICIO",
  "REGULARIZACION_RESULTADO",
  "IMPUESTO_BENEFICIOS",
]

// ─────────────────────────────────────────────────────────────────────────────
// La entrada: tipos PLANOS (nada de Prisma dentro de lib/)
// ─────────────────────────────────────────────────────────────────────────────

export type ManualStatus = "PASS" | "WARN" | "FAIL" | "NA"

/** Respuesta humana a un paso `DECLARADO` o `POSTERIOR`, con su rastro. */
export type ManualAnswer = {
  status: ManualStatus
  note?: string | null
  answeredById?: string | null
  answeredAt?: string | null
}

export type InvariantSnapshot = { id: string; status: CheckStatus; evidencia?: string }

export type ChecklistInput = {
  fiscalYearCode: string
  fiscalYearStart: LocalDate
  fiscalYearEnd: LocalDate
  fiscalYearStatus: "OPEN" | "CLOSED"
  accountsApprovalStatus: "BORRADOR" | "FORMULADAS" | "APROBADAS" | "DEPOSITADAS"
  taxFilingStatus: "NO_PRESENTADO" | "PRESENTADO" | "RECTIFICADO"
  /** El ejercicio se ha reabierto y todavía no se ha vuelto a cerrar. */
  reopened: boolean

  // Integridad del diario
  invariants: readonly InvariantSnapshot[]
  failedRunIds: readonly string[]
  proposedDocuments: number
  unsortedFiles: number
  /** Meses del ejercicio (1–12) con al menos un asiento. */
  monthsWithEntries: readonly number[]
  /** Meses con `Σdebe ≠ Σhaber`, con su desviación. */
  monthlyImbalances: readonly { month: number; deltaCents: Cents }[]
  /** Saldo de las cuentas puente `555`, `551`, `4749`. */
  bridgeBalances: readonly { accountCode: string; balanceCents: Cents }[]
  againstNature: readonly { accountCode: string; balanceCents: Cents }[]

  // Tesorería
  unreconciledBankAccounts: readonly string[]

  // Devengo
  pendingRecurring: readonly { code: string; period: string }[]
  assetsPendingDepreciation: readonly { code: string; periods: readonly string[] }[]
  assetsWithoutAttribution: readonly { code: string }[]
  accrualsNotExhausted: readonly { code: string; pendingCents: Cents }[]

  // Valoración y presentación: los pasos ya resueltos por sus motores puros
  fxStep: ClosingStepResult | null
  presentValuePending: readonly { code: string; deltaCents: Cents }[]
  reclassStep: ClosingStepResult | null
  positionsWithoutDueDate: number
  debtWithoutSchedule: readonly { accountCode: string; balanceCents: Cents }[]

  // Fiscal
  unsettledVatPeriods: readonly string[]
  prorrataStep: ClosingStepResult | null
  capitalGoodsStep: ClosingStepResult | null
  reccPendingCents: Cents | null
  withholdingPendingModels: readonly string[]
  balance473Cents: Cents

  // Impuesto y cierre
  incomeTaxEntryId: string | null
  balance6300Cents: Cents
  regularizacionEntryId: string | null
  cierreEntryId: string | null
  aperturaEntryId: string | null

  // Societario
  distributionEntryId: string | null
  /** Saldo de `129` del ejercicio ANTERIOR pendiente de distribuir (I-E9-23). */
  previousResultPendingCents: Cents

  // Analítica
  cecosPendientes: readonly string[]
  i4i5: readonly InvariantSnapshot[]

  /** Respuestas humanas a los pasos `DECLARADO` y `POSTERIOR`. */
  answers?: Readonly<Partial<Record<string, ManualAnswer>>>
  /** Pasos que la reapertura dejó `PENDIENTE_RECOMPUTO` (O-21). */
  pendingRecompute?: readonly string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// La evaluación
// ─────────────────────────────────────────────────────────────────────────────

const fmt = (cents: Cents): string => `${cents} c`
const list = (items: readonly string[], max = 5): string =>
  items.length <= max ? items.join(", ") : `${items.slice(0, max).join(", ")} y ${items.length - max} más`

type Out = { status: ClosingStepResult["status"]; evidencia: string; query?: string }

const pass = (evidencia: string, query?: string): Out => ({ status: "PASS", evidencia, query })
const fail = (evidencia: string, query?: string): Out => ({ status: "FAIL", evidencia, query })
const warn = (evidencia: string, query?: string): Out => ({ status: "WARN", evidencia, query })
const info = (evidencia: string): Out => ({ status: "INFO", evidencia })

/** Un paso declarado sin responder es **WARN**, jamás PASS: no responder no es cumplir. */
function fromAnswer(def: ClosingStepDef, answer: ManualAnswer | undefined): Out {
  if (!answer) {
    return def.nature === "POSTERIOR"
      ? { status: "NA", evidencia: `Acto posterior al cierre${def.norma ? ` (${def.norma})` : ""}: se completa después` }
      : warn(`Sin responder: ${def.titulo.toLowerCase()}`)
  }
  const nota = answer.note ? ` · ${answer.note}` : ""
  const quien = answer.answeredById ? ` · respondido por ${answer.answeredById}` : ""
  return { status: answer.status, evidencia: `Respuesta declarada: ${answer.status}${nota}${quien}` }
}

/** Reutiliza el `ClosingStepResult` que ya devolvió el motor puro del paso. */
function fromMotor(result: ClosingStepResult | null, queFalta: string): Out {
  if (!result) return info(`No evaluable: ${queFalta}`)
  return { status: result.status, evidencia: result.evidencia, query: result.query }
}

function evaluate(def: ClosingStepDef, input: ChecklistInput, refDate: LocalDate): Out {
  const answer = input.answers?.[def.step]

  // O-21: la reapertura deja los pasos 5-7 pendientes de recomputar. Manda sobre
  // cualquier otra evaluación: el dato de ayer ya no vale.
  if (input.pendingRecompute?.includes(def.step)) {
    return {
      status: "PENDIENTE_RECOMPUTO",
      evidencia: "El ejercicio se ha reabierto: este ajuste es idempotente y hay que reevaluarlo antes de recerrar (O-21)",
    }
  }

  switch (def.step) {
    // ── Integridad ─────────────────────────────────────────────────────────
    case "INVARIANTES_PASS": {
      if (input.invariants.length === 0) return info("No evaluable: no se ha ejecutado ninguna validación sobre el ejercicio")
      const failed = input.invariants.filter((c) => c.status === "FAIL")
      const warned = input.invariants.filter((c) => c.status === "WARN")
      if (failed.length > 0) return fail(`${failed.length} invariantes en FAIL: ${list(failed.map((c) => c.id))}`)
      if (warned.length > 0) return warn(`${input.invariants.length} invariantes evaluados, ${warned.length} en WARN: ${list(warned.map((c) => c.id))}`)
      return pass(`${input.invariants.length} invariantes en PASS`)
    }
    case "SIN_RUNS_FAIL":
      return input.failedRunIds.length === 0
        ? pass("Ninguna validación del ejercicio en FAIL")
        : fail(`${input.failedRunIds.length} validaciones en FAIL: ${list([...input.failedRunIds])}`)
    case "SIN_DOCUMENTOS_PROPOSED":
      return input.proposedDocuments === 0
        ? pass("Ningún documento en propuesta sin contabilizar")
        : fail(`${input.proposedDocuments} documentos en PROPOSED: o se contabilizan o se descartan con motivo`)
    case "ALMACEN_BARRIDO":
      return input.unsortedFiles === 0
        ? pass("Bandeja de documentos sin clasificar vacía")
        : warn(`${input.unsortedFiles} documentos sin clasificar en la bandeja`)
    case "EJERCICIO_COMPLETO": {
      if (refDate < input.fiscalYearEnd) {
        return info(
          `Ejercicio en curso: la comprobación se hace a ${refDate}, antes del cierre del ejercicio (${input.fiscalYearEnd})`
        )
      }
      const faltan = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].filter((m) => !input.monthsWithEntries.includes(m))
      return faltan.length === 0
        ? pass("Los doce meses del ejercicio tienen movimiento")
        : warn(`Sin movimiento en los meses ${faltan.join(", ")}: confirme que es correcto`)
    }
    case "SUMAS_SALDOS_MENSUALES":
      return input.monthlyImbalances.length === 0
        ? pass("Σdebe = Σhaber en los doce meses (art. 28.1 CCom)")
        : fail(`Descuadre mensual en ${input.monthlyImbalances.map((m) => `${m.month} (${fmt(m.deltaCents)})`).join(", ")}`)
    case "CUENTAS_PUENTE_A_CERO": {
      const vivas = input.bridgeBalances.filter((b) => b.balanceCents !== 0)
      return vivas.length === 0
        ? pass("Cuentas puente 555, 551 y 4749 a cero")
        : warn(`Cuentas puente con saldo: ${vivas.map((b) => `${b.accountCode} ${fmt(b.balanceCents)}`).join(", ")}`)
    }
    case "SALDOS_CONTRA_NATURALEZA":
      return input.againstNature.length === 0
        ? pass("Ninguna cuenta con saldo contrario a su naturaleza")
        : warn(`${input.againstNature.length} cuentas con saldo contrario a su naturaleza: ${list(input.againstNature.map((a) => a.accountCode))}`)

    // ── Tesorería ──────────────────────────────────────────────────────────
    case "CONCILIACION_BANCARIA":
      return input.unreconciledBankAccounts.length === 0
        ? pass("Todas las cuentas bancarias conciliadas al corte")
        : warn(`Sin conciliar: ${list([...input.unreconciledBankAccounts])}`)

    // ── Devengo ────────────────────────────────────────────────────────────
    case "RECURRENTES_AL_DIA":
      return input.pendingRecurring.length === 0
        ? pass("Ninguna regla recurrente con periodos vencidos sin generar")
        : warn(
            `${input.pendingRecurring.length} ocurrencias pendientes: ${list(input.pendingRecurring.map((r) => `${r.code}/${r.period}`))}`
          )
    case "AMORTIZACION_AL_DIA": {
      const pendientes = input.assetsPendingDepreciation.filter((a) => a.periods.length > 0)
      if (pendientes.length > 0) {
        return warn(
          `${pendientes.length} activos con periodos sin dotar: ${list(pendientes.map((a) => `${a.code} (${a.periods.length})`))}`
        )
      }
      if (input.assetsWithoutAttribution.length > 0) {
        return info(
          `Dotación al día, pero ${input.assetsWithoutAttribution.length} activos no tienen ninguna línea atribuida ` +
            `(${list(input.assetsWithoutAttribution.map((a) => a.code))}): I-E9-5 no puede evaluarlos`
        )
      }
      return pass("Amortización del ejercicio dotada y atribuida activo a activo")
    }
    case "PERIODIFICACIONES_AL_DIA":
      return input.accrualsNotExhausted.length === 0
        ? pass("Ninguna periodificación vencida conserva saldo")
        : warn(
            `${input.accrualsNotExhausted.length} periodificaciones vencidas con saldo: ` +
              `${list(input.accrualsNotExhausted.map((a) => `${a.code} ${fmt(a.pendingCents)}`))}`
          )

    // ── Valoración ─────────────────────────────────────────────────────────
    case "DIFERENCIAS_DE_CAMBIO":
      return fromMotor(input.fxStep, "faltan las posiciones monetarias o la tasa de cierre")
    case "VALOR_ACTUAL_APLAZAMIENTO":
      return input.presentValuePending.length === 0
        ? pass("Ningún aplazamiento supera la materialidad sin reconocer su valor actual")
        : warn(
            `${input.presentValuePending.length} aplazamientos por reconocer: ` +
              `${list(input.presentValuePending.map((p) => `${p.code} ${fmt(p.deltaCents)}`))}`
          )

    // ── Presentación ───────────────────────────────────────────────────────
    case "RECLASIFICACION_VENCIMIENTOS": {
      if (input.debtWithoutSchedule.length > 0) {
        return fail(
          `Deuda viva de 17x/52x SIN cuadro de vencimientos: ` +
            `${input.debtWithoutSchedule.map((d) => `${d.accountCode} ${fmt(d.balanceCents)}`).join(", ")}. ` +
            "Declare su DebtSchedule y postee por T-37 (O-6, I-E9-25)"
        )
      }
      return fromMotor(input.reclassStep, "faltan los pares de reclasificación o las posiciones vivas")
    }

    // ── Fiscal ─────────────────────────────────────────────────────────────
    case "IVA_LIQUIDADO":
      return input.unsettledVatPeriods.length === 0
        ? pass("Todos los periodos de IVA del ejercicio están liquidados")
        : fail(`Periodos sin liquidar: ${list([...input.unsettledVatPeriods])}`)
    case "RETENCIONES_LIQUIDADAS":
      return input.withholdingPendingModels.length === 0
        ? pass("Retenciones liquidadas por modelo (111, 115, 123)")
        : warn(`Modelos con retención pendiente: ${input.withholdingPendingModels.join(", ")}`)
    case "PRORRATA_DEFINITIVA":
      return fromMotor(input.prorrataStep, "la organización no tiene prorrata declarada o falta el libro del año")
    case "BIENES_DE_INVERSION":
      return fromMotor(input.capitalGoodsStep, "no hay bienes de inversión declarados en la ventana del art. 107")
    case "RECC_DEVENGADO_31_12":
      if (input.reccPendingCents === null) return { status: "NA", evidencia: "La organización no está en el régimen especial del criterio de caja" }
      return input.reccPendingCents === 0
        ? pass("Barrido del 31/12 practicado: nada pendiente de devengar del art. 163 terdecies")
        : fail(`Quedan ${fmt(input.reccPendingCents)} de RECC del año anterior sin devengar a 31/12: postee T-36`)
    case "PAGOS_FRACCIONADOS_CONCILIADOS":
      return input.balance473Cents === 0
        ? pass("473 a cero: retenciones soportadas y pagos fraccionados cancelados contra el impuesto (O-26)")
        : warn(
            `473 conserva ${fmt(input.balance473Cents)}: T-25 debe cancelarlo, o activo y pasivo quedan ` +
              "simultáneamente sobrevalorados por el mismo importe"
          )

    // ── Impuesto ───────────────────────────────────────────────────────────
    case "IMPUESTO_BENEFICIOS":
      if (input.incomeTaxEntryId === null) return warn("El impuesto corriente del ejercicio no está contabilizado (T-25, cuenta 6300)")
      return input.balance473Cents === 0
        ? pass(`Impuesto corriente contabilizado en el asiento ${input.incomeTaxEntryId} con 473 cancelada`)
        : warn(`Impuesto contabilizado (${input.incomeTaxEntryId}) pero 473 conserva ${fmt(input.balance473Cents)}`)

    // ── Societario ─────────────────────────────────────────────────────────
    case "CIERRE_APERTURA": {
      const hechos = [
        input.regularizacionEntryId ? "regularización" : null,
        input.cierreEntryId ? "cierre" : null,
        input.aperturaEntryId ? "apertura" : null,
      ].filter(Boolean) as string[]
      if (hechos.length === 3) return pass(`Regularización, cierre y apertura posteados: ${input.regularizacionEntryId} · ${input.cierreEntryId} · ${input.aperturaEntryId}`)
      if (hechos.length === 0) return { status: "NA", evidencia: "El ejercicio todavía no se ha cerrado: los tres asientos se postean en la misma transacción" }
      return warn(`Cierre incompleto: sólo hay ${hechos.join(", ")}`)
    }
    case "DISTRIBUCION_RESULTADO":
      if (input.distributionEntryId) return pass(`Distribución acordada y contabilizada en el asiento ${input.distributionEntryId}`)
      if (input.previousResultPendingCents !== 0) {
        return warn(
          `Quedan ${fmt(input.previousResultPendingCents)} en 129 de un ejercicio ya aprobado sin distribuir ` +
            "(I-E9-23): el patrimonio neto es incorrecto mientras tanto"
        )
      }
      return fromAnswer(def, answer)

    // ── Analítica ──────────────────────────────────────────────────────────
    case "LIQUIDACION_CECOS":
      return input.cecosPendientes.length === 0
        ? pass("Todos los centros de coste liquidados")
        : warn(`Centros de coste sin liquidar: ${list([...input.cecosPendientes])}`)
    case "I4_I5_PASS": {
      if (input.i4i5.length === 0) return info("No evaluable: I4 e I5 no se han ejecutado sobre el ejercicio")
      const mal = input.i4i5.filter((c) => c.status !== "PASS")
      return mal.length === 0
        ? pass("I4 e I5 en PASS: la analítica cuadra con la contable")
        : fail(`${mal.map((c) => `${c.id} ${c.status}`).join(", ")}`)
    }

    default:
      return fromAnswer(def, answer)
  }
}

/**
 * Los pasos del cierre, **todos y siempre**, en el orden del catálogo. Lo que no
 * se puede evaluar sale `INFO` diciendo qué falta; un paso declarado sin
 * responder sale `WARN`; los societarios posteriores al cierre nacen `NA`.
 *
 * `refDate` entra por parámetro: aquí no hay reloj.
 */
export function closingChecklist(input: ChecklistInput, refDate: LocalDate): ClosingStepResult[] {
  const results = CLOSING_STEPS.map((def) => {
    const out = evaluate(def, input, refDate)
    const result: ClosingStepResult = {
      step: def.step,
      block: def.block,
      status: out.status,
      blocking: def.blocking,
      evidencia: out.evidencia,
    }
    if (out.query) result.query = out.query
    if (def.sealReason && out.status !== "PASS" && out.status !== "NA") result.sealReason = def.sealReason
    return result
  })

  // Motivos que no nacen de un paso concreto sino del estado del ejercicio.
  if (input.reopened) {
    const paso = results.find((r) => r.step === "CIERRE_APERTURA")
    if (paso) {
      paso.status = paso.status === "PASS" ? "WARN" : paso.status
      paso.sealReason = "CIERRE_REABIERTO"
      paso.evidencia = `${paso.evidencia} · el ejercicio se ha reabierto y el sello exige revisión hasta el cierre nuevo`
    }
  }
  if (input.taxFilingStatus !== "NO_PRESENTADO" && input.reopened) {
    const paso = results.find((r) => r.step === "IMPUESTO_BENEFICIOS")
    if (paso) {
      paso.sealReason = "MODELO_200_PRESENTADO"
      paso.status = paso.status === "PASS" ? "WARN" : paso.status
      paso.evidencia = `${paso.evidencia} · ${E9_SEAL_REASON_TEXT.MODELO_200_PRESENTADO}`
    }
  }
  if (input.positionsWithoutDueDate > 0) {
    const paso = results.find((r) => r.step === "RECLASIFICACION_VENCIMIENTOS")
    if (paso && paso.status !== "FAIL") {
      paso.sealReason = "VENCIMIENTOS_SIN_FECHA"
      paso.status = paso.status === "PASS" ? "WARN" : paso.status
      paso.evidencia = `${paso.evidencia} · ${input.positionsWithoutDueDate} posiciones vivas sin fecha de vencimiento: las decide una persona`
    }
  }
  if (input.debtWithoutSchedule.length > 0) {
    const paso = results.find((r) => r.step === "RECLASIFICACION_VENCIMIENTOS")
    if (paso) paso.sealReason = "DEUDA_SIN_DESGLOSE"
  }
  return results
}

export type Seal = "VALIDADO_AUTOMATICAMENTE" | "REQUIERE_REVISION"

/**
 * **H-4 de E7, literal.** El sello se calcula **después** de componer los
 * motivos, de modo que `seal` y `sealReasons` no puedan contradecirse: hay
 * motivo ⇒ `REQUIERE_REVISION`; no lo hay y ningún paso está en FAIL o WARN ⇒
 * `VALIDADO_AUTOMATICAMENTE`.
 *
 * `INFO` y `NA` **no mueven el sello**: son «no evaluable» y «todavía no toca»,
 * y confundirlos con un incumplimiento haría que ningún cierre pasara nunca.
 */
export function closingSeal(steps: readonly ClosingStepResult[]): { seal: Seal; reasons: E9SealReason[] } {
  const reasons = closingSealReasons(steps)
  const mueve = steps.some((s) => s.status === "FAIL" || s.status === "WARN" || s.status === "PENDIENTE_RECOMPUTO")
  return { seal: reasons.length > 0 || mueve ? "REQUIERE_REVISION" : "VALIDADO_AUTOMATICAMENTE", reasons }
}

/** Los bloqueantes que **no** están en PASS. Vacío es la condición de cierre. */
export function blockingFailures(steps: readonly ClosingStepResult[]): ClosingStepResult[] {
  return steps.filter((s) => s.blocking && s.status !== "PASS")
}

/** ¿Se puede cerrar? Se comprueba **en servidor**, no sólo al pintar el botón (D1.1). */
export function canCloseFiscalYear(steps: readonly ClosingStepResult[]): { ok: boolean; blockers: ClosingStepResult[] } {
  const blockers = blockingFailures(steps)
  return { ok: blockers.length === 0, blockers }
}

/** Texto del motivo de sello, para la pantalla. Reexportado desde T11: uno solo. */
export const sealReasonText = (code: string): string => (isE9SealReason(code) ? E9_SEAL_REASON_TEXT[code] : code)
