/**
 * E12 · T12 — **Excepciones de operador**: `I-E12-5` y el motivo de sello
 * `EXCEPCION_DE_OPERADOR_VIGENTE` (ADR-0020 **D5** y **D6**).
 *
 * `docs/design/E12-fiabilidad-dod.md` §5 y §9 ·
 * `docs/adr/0020-escrituras-de-operador-y-excepciones-auditadas.md`.
 *
 * Módulo **PURO**: sin `Date.now()`, sin Prisma, sin IO, sin LLM. Todo entra por
 * parámetro en tipos planos; quien lee la base es `models/operator-exceptions.ts`.
 *
 * ## Las tres cosas que este fichero sostiene
 *
 * 1. **Una excepción de operador NO es una excepción a un invariante.** El
 *    invariante que cerró la puerta sigue en FAIL y sigue moviendo el sello. Lo
 *    que caduca es la **puerta**, no la comprobación. Por eso aquí no hay ni una
 *    línea que retire un check: sólo se **añade** un motivo.
 * 2. **Toda excepción viva mueve el sello** (D6). Es la regla que sostiene todas
 *    las demás: sin ella `/admin` sería la manera elegante de apagar la capa de
 *    fiabilidad. Si alguna vez se propone una excepción que *no* mueva el sello,
 *    la pregunta correcta no es cuál es el caso de uso: es por qué se quiere
 *    apagar el control.
 * 3. **Nunca un PASS que no se haya comprobado.** Sin bloque, `I-E12-5` sale
 *    `INFO` diciendo qué falta — jamás en verde (regla E-2 de la v1.1 propuesta).
 *
 * La naturaleza del motivo es **`ENTORNO`** y no `INVARIANTE`: una excepción
 * viva no cambia una cifra, cambia **lo que se puede afirmar** de ella. Su
 * familia en `/audit` es `PLATAFORMA` (ADR-0020 D6).
 */

import type { CheckResult, CheckStatus } from "@/lib/ledger/invariants-types"

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades de resultado (misma forma que E10 y E11, a propósito)
// ─────────────────────────────────────────────────────────────────────────────

const result = (id: string, status: CheckStatus, evidencia: string, query?: string): CheckResult =>
  query === undefined ? { id, status, evidencia } : { id, status, evidencia, query }

const pass = (id: string, evidencia: string, query?: string) => result(id, "PASS", evidencia, query)
const failed = (id: string, evidencia: string, query?: string) => result(id, "FAIL", evidencia, query)
const info = (id: string, evidencia: string, query?: string) => result(id, "INFO", evidencia, query)

/** Lo NO evaluable nunca es un PASS: dice qué falta y quién lo aporta. */
const missing = (id: string, quéFalta: string): CheckResult => info(id, `no evaluable: ${quéFalta}`)

const cut = (items: readonly string[], max = 12): string =>
  items.length === 0
    ? "—"
    : items.length <= max
      ? items.join(" · ")
      : `${items.slice(0, max).join(" · ")} · (+${items.length - max} más)`

// ─────────────────────────────────────────────────────────────────────────────
// El motivo de sello (ADR-0020 D6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **Código cerrado**, como los seis de E8, los diez de E9, los cinco de E10 y
 * los cuatro de E11. Hoy es **uno**: añadir otro exige enmendar ADR-0020.
 */
export const E12_SEAL_REASONS = ["EXCEPCION_DE_OPERADOR_VIGENTE"] as const

export type E12SealReason = (typeof E12_SEAL_REASONS)[number]

export const E12_SEAL_REASON_TEXT: Readonly<Record<E12SealReason, string>> = {
  EXCEPCION_DE_OPERADOR_VIGENTE:
    "hay una excepción de operador viva sobre una guardia de esta organización: el periodo no puede firmarse como validado automáticamente mientras dure (ADR-0020 D6)",
}

export const isE12SealReason = (code: string): code is E12SealReason =>
  (E12_SEAL_REASONS as readonly string[]).includes(code)

// ─────────────────────────────────────────────────────────────────────────────
// Tipos planos del bloque
// ─────────────────────────────────────────────────────────────────────────────

export const OPERATOR_EXCEPTION_KINDS = [
  "UNBLOCK_PERIOD_LOCK",
  "UNBLOCK_CLOSING_GUARD",
  "UNSTICK_RESTORE_JOB",
  "UNSTICK_CRON_JOB",
] as const
export type OperatorExceptionKindCode = (typeof OPERATOR_EXCEPTION_KINDS)[number]

export const OPERATOR_TARGET_KINDS = ["PERIOD_LOCK", "FISCAL_YEAR", "RESTORE_JOB", "CRON_JOB"] as const
export type OperatorTargetKindCode = (typeof OPERATOR_TARGET_KINDS)[number]

/** Una excepción tal y como está en la base, en ISO-8601 UTC. */
export type OperatorExceptionRef = {
  id: string
  kind: OperatorExceptionKindCode
  targetKind: OperatorTargetKindCode
  targetId: string | null
  targetRef: string | null
  reason: string
  requestedBy: string
  /** ISO-8601. */
  createdAt: string
  /** ISO-8601. */
  expiresAt: string
  /** ISO-8601 o `null`. */
  revokedAt: string | null
}

/**
 * Una línea de `platform_audit_logs` cuya acción empieza por `admin.`, con lo
 * que `I-E12-5` necesita comprobar de ella. `detail` llega ya **plano**: aquí no
 * se hace `JSON.parse` de nada (módulo puro y sin sorpresas de tipo).
 */
export type OperatorAuditRef = {
  id: string
  action: string
  actor: string
  organizationId: string | null
  /** ISO-8601. */
  at: string
  reason: string | null
  confirmedName: string | null
  /**
   * `detail.exceptionId` de una línea `admin.unblock`. Es lo que ata la
   * excepción con su registro **por identidad y no por reloj**: una ventana de
   * tiempo entre dos relojes distintos —el de la aplicación y el del servidor de
   * base de datos— es una comparación que falla sola en cuanto se desfasan unos
   * minutos, y un invariante que depende del desfase de dos relojes no vigila
   * nada.
   */
  exceptionId: string | null
}

/** Las seis tablas que **ninguna** escritura de operador puede tocar (D2). */
export const FORBIDDEN_OPERATOR_TABLES: readonly string[] = [
  "journal_entries",
  "journal_lines",
  "audit_logs",
  "extraction_runs",
  "invariant_runs",
  "closing_runs",
]

/** Las cuatro acciones de operador. Lista cerrada: D1 no admite una quinta. */
export const OPERATOR_ACTIONS = [
  "admin.reset_org",
  "admin.unblock",
  "admin.plan_changed",
  "admin.purge_retention",
] as const
export type OperatorAction = (typeof OPERATOR_ACTIONS)[number]

export const isOperatorAction = (action: string): action is OperatorAction =>
  (OPERATOR_ACTIONS as readonly string[]).includes(action)

export type OperatorBlock = {
  /** Todas las excepciones de la organización, vivas y muertas. */
  exceptions: readonly OperatorExceptionRef[]
  /** Las líneas `admin.*` del registro de plataforma de esta organización. */
  auditLines: readonly OperatorAuditRef[]
  /**
   * Recuento de filas escritas por caminos de operador sobre las seis tablas
   * prohibidas, **medido por otro camino** (SQL agregado sobre los `AuditLog` de
   * actor de plataforma). Debe ser 0. Ausente ⇒ no se afirma nada.
   */
  forbiddenWrites?: readonly { table: string; rows: number }[]
  /** Fecha de referencia del barrido, ISO-8601. Nunca `Date.now()`. */
  refDate: string
}

export type OperatorInvariantInput = {
  operator?: OperatorBlock
}

// ─────────────────────────────────────────────────────────────────────────────
// Vigencia — la única definición, y es de aquí
// ─────────────────────────────────────────────────────────────────────────────

/** D5: el techo, en horas. No hay excepciones permanentes y no hay renovación. */
export const MAX_EXCEPTION_HOURS = 24

const MS_24H = MAX_EXCEPTION_HOURS * 60 * 60 * 1000

/**
 * ¿Está viva esta excepción a `refDate`?
 *
 * Viva = **no revocada** y **no caducada**. El borde es cerrado por abajo y
 * abierto por arriba: en el instante exacto de `expiresAt` la puerta **ya está
 * cerrada**. Es la lectura estricta de D5 («cuando caduca, la puerta vuelve a
 * estar cerrada sin que nadie haga nada»), y la que hace que el criterio 45 sea
 * comprobable sin ambigüedad de un milisegundo.
 */
export function isLive(exception: OperatorExceptionRef, refDate: string): boolean {
  if (exception.revokedAt !== null && Date.parse(exception.revokedAt) <= Date.parse(refDate)) return false
  return Date.parse(refDate) < Date.parse(exception.expiresAt)
}

/** Las excepciones vivas a `refDate`, ordenadas por caducidad más próxima. */
export function liveExceptions(
  exceptions: readonly OperatorExceptionRef[],
  refDate: string
): readonly OperatorExceptionRef[] {
  return exceptions
    .filter((e) => isLive(e, refDate))
    .slice()
    .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt) || a.id.localeCompare(b.id))
}

// ─────────────────────────────────────────────────────────────────────────────
// Motivo mínimo (D3) — la misma regla que valida la server action
// ─────────────────────────────────────────────────────────────────────────────

export const MIN_REASON_LENGTH = 20

/**
 * Lista negra de genéricos (D3). No es exhaustiva ni pretende serlo: su trabajo
 * es que «arreglo» y «test» no cuelen, no adivinar la mala fe. La longitud
 * mínima hace el resto, y está además como CHECK en la base.
 */
export const GENERIC_REASONS: readonly string[] = [
  "test",
  "tests",
  "prueba",
  "pruebas",
  "arreglo",
  "arreglar",
  "fix",
  "limpieza",
  "nada",
  "varios",
  ".",
  "-",
  "n/a",
  "na",
  "asdf",
  "xxx",
]

export type ReasonVerdict = { ok: true } | { ok: false; error: string }

/**
 * Valida el motivo de una escritura de operador. **Pura**: la misma función la
 * usa la server action (D3) y el invariante, para que no puedan discrepar.
 */
export function validateReason(reason: string): ReasonVerdict {
  const trimmed = reason.trim()
  if (trimmed.length === 0) return { ok: false, error: "El motivo es obligatorio." }
  if (trimmed.length < MIN_REASON_LENGTH) {
    return {
      ok: false,
      error: `El motivo debe tener al menos ${MIN_REASON_LENGTH} caracteres (tiene ${trimmed.length}). Escribe qué ha pasado y por qué esto lo resuelve.`,
    }
  }
  const normalized = trimmed
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
  if (normalized.length === 0) {
    return { ok: false, error: "El motivo no puede ser sólo signos de puntuación." }
  }
  if (GENERIC_REASONS.includes(normalized)) {
    return { ok: false, error: `«${trimmed}» no es un motivo: describe el incidente concreto.` }
  }
  // Un motivo que repite una sola palabra hasta llegar a los 20 caracteres
  // cumple la longitud y no dice nada. Se exige variedad mínima.
  const words = new Set(normalized.split(" ").filter(Boolean))
  if (words.size < 3) {
    return { ok: false, error: "El motivo tiene que ser una frase, no una palabra repetida." }
  }
  return { ok: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// Confirmación por nombre (D4) — verificada EN EL SERVIDOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ¿Coincide el nombre tecleado con el de la organización?
 *
 * **Exacto salvo espacios de borde.** Ni `toLowerCase`, ni acentos plegados, ni
 * `includes`: la segunda confirmación existe para obligar a mirar el nombre, y
 * una comparación laxa la convierte en una animación (D4).
 */
export function confirmsName(typed: string, organizationName: string): boolean {
  return typed.trim() === organizationName.trim() && organizationName.trim().length > 0
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E12-5 — Escrituras de operador acotadas (familia PLATAFORMA)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **I-E12-5.** Cuatro comprobaciones en una, porque las cuatro dicen lo mismo
 * desde ángulos distintos:
 *
 *  (a) toda línea `admin.*` del registro de plataforma tiene **motivo válido**,
 *      **actor** y **confirmación** (D3 + D4);
 *  (b) ninguna acción `admin.*` está fuera de la lista cerrada de cuatro (D1);
 *  (c) ninguna `OperatorException` dura más de 24 h ni nace sin su registro (D5);
 *  (d) **ninguna** escritura de operador ha alcanzado el diario ni las tablas
 *      append-only (D2, tercera vía tras los privilegios y el test de AST).
 */
export function checkIE125(input: OperatorInvariantInput): CheckResult {
  const block = input.operator
  if (!block) return missing("I-E12-5", "el bloque de operador (models/operator-exceptions)")

  const problemas: string[] = []

  // (a) y (b) — el registro
  for (const line of block.auditLines) {
    if (!isOperatorAction(line.action)) {
      problemas.push(`${line.id}: acción «${line.action}» fuera de las cuatro de ADR-0020 D1`)
      continue
    }
    const verdict = validateReason(line.reason ?? "")
    if (!verdict.ok) problemas.push(`${line.id} (${line.action}): motivo inválido — ${verdict.error}`)
    if (line.actor.trim().length === 0) problemas.push(`${line.id} (${line.action}): sin actor`)
    // `admin.purge_retention` puede no ir contra una organización nombrada; el
    // resto exige la confirmación por nombre que D4 obliga a comparar.
    if (line.organizationId !== null && (line.confirmedName ?? "").trim().length === 0) {
      problemas.push(`${line.id} (${line.action}): sin confirmación por nombre`)
    }
  }

  // (c) — las excepciones
  for (const e of block.exceptions) {
    const created = Date.parse(e.createdAt)
    const expires = Date.parse(e.expiresAt)
    if (!(expires > created)) {
      problemas.push(`excepción ${e.id}: caduca antes de nacer (${e.createdAt} → ${e.expiresAt})`)
    } else if (expires - created > MS_24H) {
      const horas = ((expires - created) / 3_600_000).toFixed(1)
      problemas.push(`excepción ${e.id}: dura ${horas} h, por encima del techo de 24 h de ADR-0020 D5`)
    }
    const verdict = validateReason(e.reason)
    if (!verdict.ok) problemas.push(`excepción ${e.id}: motivo inválido — ${verdict.error}`)
    const registrada = block.auditLines.some((l) => l.action === "admin.unblock" && l.exceptionId === e.id)
    if (!registrada) problemas.push(`excepción ${e.id}: no tiene su línea «admin.unblock» en el registro de plataforma`)
  }

  // (d) — el diario, intacto
  const alcanzadas = (block.forbiddenWrites ?? []).filter((w) => w.rows > 0)
  for (const w of alcanzadas) {
    problemas.push(`una escritura de operador alcanzó «${w.table}» (${w.rows} fila(s)) — ADR-0020 D2`)
  }

  const vivas = liveExceptions(block.exceptions, block.refDate)
  const resumen =
    `${block.auditLines.length} línea(s) admin.* · ${block.exceptions.length} excepción(es), ` +
    `${vivas.length} viva(s) a ${block.refDate} · ` +
    `${FORBIDDEN_OPERATOR_TABLES.length} tablas prohibidas ` +
    (block.forbiddenWrites === undefined ? "(recuento no aportado)" : "con 0 escrituras de operador")

  if (problemas.length > 0) return failed("I-E12-5", `${resumen}. Incumplimientos: ${cut(problemas)}`)

  // Sin recuento de escrituras prohibidas no se puede afirmar (d): INFO, jamás
  // un PASS que no se haya comprobado (regla E-2 de la v1.1 propuesta).
  if (block.forbiddenWrites === undefined) {
    return info(
      "I-E12-5",
      `${resumen}. (a)(b)(c) conformes; (d) NO evaluada: falta el recuento de escrituras sobre las tablas prohibidas`
    )
  }

  return pass(
    "I-E12-5",
    resumen +
      (vivas.length > 0
        ? `. Hay excepciones vivas: el sello lleva EXCEPCION_DE_OPERADOR_VIGENTE (${cut(vivas.map((e) => `${e.kind}→${e.expiresAt}`))})`
        : ""),
    `SELECT id, kind, target_kind, expires_at, revoked_at FROM operator_exceptions WHERE organization_id = app.current_org() ORDER BY created_at DESC`
  )
}

export const E12_OPERATOR_INVARIANT_IDS: readonly string[] = ["I-E12-5"]

/** Siempre un resultado, aunque falte el bloque. */
export function runOperatorInvariants(input: OperatorInvariantInput): CheckResult[] {
  return [checkIE125(input)]
}

// ─────────────────────────────────────────────────────────────────────────────
// Los motivos de sello (D6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compuestos **a partir de los datos**, no de los checks: lección H-4 de E7. Un
 * `I-E12-5` en PASS con una excepción viva sigue sellando el periodo, porque lo
 * que mueve el sello no es que la excepción esté mal registrada —eso sería el
 * FAIL— sino que **exista** (D6).
 */
export function operatorSealReasons(input: OperatorInvariantInput): E12SealReason[] {
  const block = input.operator
  if (!block) return []
  return liveExceptions(block.exceptions, block.refDate).length > 0 ? ["EXCEPCION_DE_OPERADOR_VIGENTE"] : []
}
