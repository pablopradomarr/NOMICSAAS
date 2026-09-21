/**
 * E12 · T12 — **Excepciones de operador**: lectura y escritura (ADR-0020 D5/D6).
 *
 * `docs/design/E12-fiabilidad-dod.md` §5.4 ·
 * `docs/adr/0020-escrituras-de-operador-y-excepciones-auditadas.md`.
 *
 * Este fichero es el **único** camino a `operator_exceptions`. Tres reglas que
 * no son de estilo:
 *
 *  1. **Todo pasa por `tenantDb`/`tenantTransaction`** (ADR-0009). La tabla nace
 *     con `app.enforce_tenant_rls` y está en `TENANT_MODELS`: una consulta fuera
 *     del cliente acotado no da error, **devuelve vacío**.
 *  2. **Crear es `INSERT`; revocar es la función acotada.** `app_runtime` no
 *     tiene `UPDATE` sobre la tabla —la migración se lo revoca y hay dos
 *     políticas `RESTRICTIVE`—, así que `revokeOperatorException` llama a
 *     `app.revoke_operator_exception(id, at)`, que sólo escribe `revoked_at` y
 *     **no puede alargar** la caducidad. Es la única cosa que esa función no
 *     debe poder hacer nunca.
 *  3. **La caducidad la fija el llamante**, nunca `Date.now()` aquí dentro. La
 *     fecha de referencia entra por parámetro como en todo el motor, y el techo
 *     de 24 h lo vuelve a comprobar la base (CHECK).
 */

import type { TenantClient, TenantTransactionClient } from "@/lib/db"
import { tenantTransaction } from "@/lib/db"
import {
  MAX_EXCEPTION_HOURS,
  confirmsName,
  liveExceptions,
  validateReason,
  type OperatorBlock,
  type OperatorExceptionRef,
} from "@/lib/ledger/invariants-e12"
import type { OperatorException, OperatorExceptionKind, OperatorTargetKind } from "@/prisma/client"

export { MAX_EXCEPTION_HOURS, confirmsName, liveExceptions, validateReason }
export type { OperatorBlock, OperatorExceptionRef }

/** Cliente mínimo: el de `tenantTransaction` lo cumple, y `tenantDb` también. */
type ExceptionReader = Pick<TenantTransactionClient, "operatorException" | "$organizationId">

const iso = (d: Date): string => d.toISOString()

/** Fila de Prisma → tipo plano del invariante puro. */
export function toRef(row: OperatorException): OperatorExceptionRef {
  return {
    id: row.id,
    kind: row.kind,
    targetKind: row.targetKind,
    targetId: row.targetId,
    targetRef: row.targetRef,
    reason: row.reason,
    requestedBy: row.requestedBy,
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
    revokedAt: row.revokedAt ? iso(row.revokedAt) : null,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Lectura
// ─────────────────────────────────────────────────────────────────────────────

export async function listOperatorExceptions(
  db: ExceptionReader,
  opts: { take?: number } = {}
): Promise<OperatorExceptionRef[]> {
  const rows = await db.operatorException.findMany({
    orderBy: { createdAt: "desc" },
    take: opts.take ?? 200,
  })
  return rows.map(toRef)
}

/**
 * Las excepciones **vivas** a `refDate`. Es la consulta que la cabecera de
 * `/admin` pinta en rojo arriba del todo (§5.5) y la que decide el motivo de
 * sello (D6).
 */
export async function listLiveOperatorExceptions(
  db: ExceptionReader,
  refDate: Date
): Promise<OperatorExceptionRef[]> {
  // Se filtra en SQL por caducidad para no traerse el histórico, y se vuelve a
  // filtrar con `liveExceptions` —la función pura— para que el borde y el
  // invariante no puedan discrepar sobre qué significa «viva».
  const rows = await db.operatorException.findMany({
    where: { expiresAt: { gt: refDate }, revokedAt: null },
    orderBy: { expiresAt: "asc" },
  })
  return liveExceptions(rows.map(toRef), iso(refDate)).slice()
}

/**
 * ¿Hay alguna excepción viva de esta clase sobre este objetivo? Es la pregunta
 * que hace la guardia antes de dejar pasar: **la puerta**, no el invariante.
 */
export async function hasLiveExceptionFor(
  db: ExceptionReader,
  opts: { kind: OperatorExceptionKind; targetId?: string | null; targetRef?: string | null; refDate: Date }
): Promise<boolean> {
  const vivas = await listLiveOperatorExceptions(db, opts.refDate)
  return vivas.some(
    (e) =>
      e.kind === opts.kind &&
      (opts.targetId === undefined || e.targetId === (opts.targetId ?? null)) &&
      (opts.targetRef === undefined || e.targetRef === (opts.targetRef ?? null))
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Escritura
// ─────────────────────────────────────────────────────────────────────────────

export type CreateOperatorExceptionInput = {
  kind: OperatorExceptionKind
  targetKind: OperatorTargetKind
  targetId?: string | null
  targetRef?: string | null
  reason: string
  requestedBy: string
  /** Fecha de referencia. Nunca se lee el reloj aquí dentro. */
  now: Date
  /** Horas de vigencia. Máximo 24 (D5), y la base lo vuelve a comprobar. */
  hours?: number
}

export class OperatorExceptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OperatorExceptionError"
  }
}

/**
 * Crea la excepción. **No decide nada de permisos**: eso es de la server action,
 * que además escribe los dos registros. Aquí se validan las dos invariantes de
 * forma —motivo y caducidad— antes de que la base las rechace, para poder dar
 * un mensaje en español en vez de un error de constraint.
 */
export async function createOperatorException(
  tx: Pick<TenantTransactionClient, "operatorException" | "$organizationId">,
  input: CreateOperatorExceptionInput
): Promise<OperatorExceptionRef> {
  const verdict = validateReason(input.reason)
  if (!verdict.ok) throw new OperatorExceptionError(verdict.error)

  const hours = input.hours ?? MAX_EXCEPTION_HOURS
  if (!(hours > 0) || hours > MAX_EXCEPTION_HOURS) {
    throw new OperatorExceptionError(
      `Una excepción de operador dura como mucho ${MAX_EXCEPTION_HOURS} h (se han pedido ${hours}). ` +
        "Si hay que levantar la guardia más tiempo, el problema no es la guardia (ADR-0020 D5)."
    )
  }

  const expiresAt = new Date(input.now.getTime() + hours * 3_600_000)
  const row = await tx.operatorException.create({
    data: {
      organizationId: tx.$organizationId,
      kind: input.kind,
      targetKind: input.targetKind,
      targetId: input.targetId ?? null,
      targetRef: input.targetRef ?? null,
      reason: input.reason.trim(),
      requestedBy: input.requestedBy.slice(0, 120),
      // **Los dos instantes salen del MISMO reloj**, el que entra por parámetro
      // (`CLAUDE.md`: la fecha de referencia nunca se lee dentro). Dejar que
      // `created_at` lo pusiera la base y `expires_at` lo calculara el llamante
      // hacía que el CHECK de 24 h midiera la diferencia entre DOS relojes: con
      // el del servidor de base de datos desfasado unos minutos, una excepción
      // legítima se rechazaba —y con él adelantado, una de 24 h y pico colaba—.
      // El CHECK sigue en la base y sigue siendo la barrera; lo que se arregla
      // aquí es que compare dos marcas comparables.
      createdAt: input.now,
      expiresAt,
    },
  })
  return toRef(row)
}

/**
 * Revoca una excepción antes de que caduque, por la función `SECURITY DEFINER`.
 * Devuelve `false` si no existía, ya estaba revocada o no era de esta
 * organización — nunca lanza por eso: revocar dos veces no es un error.
 */
export async function revokeOperatorException(
  tx: Pick<TenantTransactionClient, "$queryRaw" | "$organizationId">,
  id: string,
  at: Date
): Promise<boolean> {
  const rows = await tx.$queryRaw<
    { revoked: boolean }[]
  >`SELECT app.revoke_operator_exception(${id}::uuid, ${at}::timestamp(3)) AS revoked`
  return rows[0]?.revoked === true
}

// ─────────────────────────────────────────────────────────────────────────────
// El bloque del barrido (I-E12-5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compone el bloque `operator` del barrido: las excepciones, las líneas
 * `admin.*` del registro de plataforma y el recuento —por otro camino— de
 * escrituras de operador que hayan alcanzado las seis tablas prohibidas.
 *
 * **Lo que NO hace**: leer `journal_*` para «verificar» nada. El recuento de (d)
 * sale de `audit_logs` —quién tocó qué— y no del diario, que es justamente la
 * tabla que la regla protege.
 */
export async function readOperatorInvariantInput(
  tx: TenantTransactionClient,
  opts: { refDate: Date }
): Promise<{ operator: OperatorBlock }> {
  const organizationId = tx.$organizationId
  const exceptions = (await listOperatorExceptions(tx, { take: 500 })).slice()

  // `platform_audit_logs` no está en `TENANT_MODELS` (lleva filas sin
  // organización), así que se consulta por SQL con el filtro explícito. La
  // política de lectura de la tabla ya acota a `organization_id = current_org()`
  // o NULL; aquí se pide además la organización, que es lo que I-E12-5 juzga.
  const auditRows = await tx.$queryRaw<
    {
      id: string
      action: string
      actor: string
      at: Date
      reason: string | null
      confirmed_name: string | null
      exception_id: string | null
    }[]
  >`
    SELECT "id", "action", "actor", "at",
           "detail" ->> 'reason'        AS reason,
           "detail" ->> 'confirmedName' AS confirmed_name,
           "detail" ->> 'exceptionId'   AS exception_id
      FROM "platform_audit_logs"
     WHERE "organization_id" = ${organizationId}::uuid
       AND "action" LIKE 'admin.%'
     ORDER BY "at" DESC
     LIMIT 500
  `

  // (d) — ¿alguna escritura de operador alcanzó el diario o las append-only?
  // Se mide sobre `audit_logs`: las cuatro acciones de operador dejan su fila
  // con la entidad tocada, así que una fila `OPERATOR_*` sobre `JournalEntry`,
  // `JournalLine`, `ExtractionRun`, `InvariantRun` o `ClosingRun` sería la
  // prueba del incumplimiento. Es un camino distinto del de los privilegios y
  // del test de AST, que es justo lo que D2 pide: tres vías independientes.
  const forbiddenRows = await tx.$queryRaw<{ entity: string; rows: bigint }[]>`
    SELECT "entity", count(*)::bigint AS rows
      FROM "audit_logs"
     WHERE "organization_id" = ${organizationId}::uuid
       AND "action" LIKE 'OPERATOR\\_%'
       AND "entity" IN ('JournalEntry', 'JournalLine', 'ExtractionRun', 'InvariantRun', 'ClosingRun', 'AuditLog')
     GROUP BY "entity"
  `
  const byEntity = new Map(forbiddenRows.map((r) => [r.entity, Number(r.rows)]))
  const forbiddenWrites = [
    { table: "journal_entries", rows: byEntity.get("JournalEntry") ?? 0 },
    { table: "journal_lines", rows: byEntity.get("JournalLine") ?? 0 },
    { table: "audit_logs", rows: byEntity.get("AuditLog") ?? 0 },
    { table: "extraction_runs", rows: byEntity.get("ExtractionRun") ?? 0 },
    { table: "invariant_runs", rows: byEntity.get("InvariantRun") ?? 0 },
    { table: "closing_runs", rows: byEntity.get("ClosingRun") ?? 0 },
  ]

  return {
    operator: {
      exceptions,
      auditLines: auditRows.map((r) => ({
        id: r.id,
        action: r.action,
        actor: r.actor,
        organizationId,
        at: iso(r.at),
        reason: r.reason,
        confirmedName: r.confirmed_name,
        exceptionId: r.exception_id,
      })),
      forbiddenWrites,
      refDate: iso(opts.refDate),
    },
  }
}

/** Atajo fuera de transacción, para pantallas. */
export async function operatorExceptionsOf(
  organizationId: string,
  refDate: Date
): Promise<{ all: OperatorExceptionRef[]; live: OperatorExceptionRef[] }> {
  return await tenantTransaction(organizationId, async (tx) => {
    const all = await listOperatorExceptions(tx)
    return { all, live: liveExceptions(all, iso(refDate)).slice() }
  })
}

/** Tipo del cliente completo, por si alguna pantalla lo usa sin transacción. */
export type OperatorExceptionClient = Pick<TenantClient, "operatorException" | "$organizationId">
