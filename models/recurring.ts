/**
 * E9 · T12 — Reglas recurrentes y sus ocurrencias
 * (`docs/design/E9-cierre-recurrentes.md` §5.1, tabla de `models/`).
 *
 * Este módulo **no decide nada contable**: lee y escribe. Quien decide el
 * *cuándo* y el *cuánto* es `lib/recurring/schedule.ts` (T5), y quien construye
 * las líneas es la plantilla (T10). Aquí sólo están el tenant, la transacción y
 * el SQL.
 *
 * ## Las tres reglas que gobiernan el fichero
 *
 *  1. **R-REC-3 · idempotencia por construcción.** La ocurrencia se **INSERTA
 *     ANTES** que el asiento y en la misma transacción. Si otra generación
 *     simultánea llegó primero, el `INSERT` choca contra
 *     `@@unique(organization_id, recurring_entry_id, period)` (G-1), la
 *     transacción muere y **no hay asiento**. Nunca «mirar y luego insertar»:
 *     entre el `SELECT` y el `INSERT` cabe la otra transacción entera.
 *  2. **Agregados en SQL y sin N+1.** `readRecurringDue` resuelve reglas +
 *     ocurrencias ya generadas en **una** consulta con `LEFT JOIN LATERAL`, no
 *     en una por regla. El calendario de 60 reglas × 12 meses es un cargador de
 *     página con techo de 600 ms (§9).
 *  3. **Append-only.** `recurring_occurrences` no se actualiza ni se borra:
 *     revertir una ocurrencia es anular su asiento con contra-asiento (R-REC-7)
 *     y la fila **sigue ahí**, apuntando al asiento anulado.
 */

import type { TenantClient, TenantTransactionClient } from "@/lib/db"
import { fromUtcDate, toUtcDate } from "@/lib/ledger/dates"
import type { EntryDraft, LocalDate, PostedEntry } from "@/lib/ledger/types"
import type {
  OccurrenceStatus,
  PeriodKey,
  RecurrenceAnchor,
  RecurrenceFreq,
  RecurringKind,
  RecurringRuleRef,
  RecurringStatus,
} from "@/lib/recurring/schedule"
import { centsFromDbNullable, centsToDbNullable } from "@/lib/money"
import type { Actor } from "@/models/accounts"
import { writeAuditLog } from "@/models/audit-log"
import { e9Abort } from "@/models/e9-errors"
import { postEntryTx } from "@/models/ledger"

type AnyClient = TenantClient | TenantTransactionClient

/** Clave de idempotencia del asiento de una ocurrencia: `(regla, periodo)`. */
export const occurrenceIdempotencyKey = (ruleCode: string, period: PeriodKey): string =>
  `recurring:${ruleCode}:${period}`.slice(0, 64)

/** `sourceId` del asiento (R-REC-6). */
export const occurrenceSourceId = (ruleCode: string, period: PeriodKey): string => `${ruleCode}/${period}`

// ─────────────────────────────────────────────────────────────────────────────
// Lectura
// ─────────────────────────────────────────────────────────────────────────────

export type RecurringRuleRow = RecurringRuleRef & {
  id: string
  fixedAssetId: string | null
  accrualId: string | null
}

/** Una ocurrencia ya materializada, tal cual la ve el calendario. */
export type RecurringOccurrenceRow = {
  id: string
  recurringEntryId: string
  period: PeriodKey
  postingDate: LocalDate
  status: OccurrenceStatus
  reason: string | null
  entryId: string | null
  inputHash: string
}

/**
 * Una regla con **los periodos que ya tiene generados**, en una sola consulta.
 *
 * `generatedPeriods` es lo que `duePeriods` necesita para no repetir; viene
 * agregado en SQL (`array_agg` dentro del `LATERAL`) y no en una consulta por
 * regla, que es el N+1 que el techo de §9 no admite.
 */
export type RecurringDueRow = RecurringRuleRow & {
  generatedPeriods: PeriodKey[]
  lastPeriod: PeriodKey | null
  occurrenceCount: number
}

type DueSqlRow = {
  id: string
  code: string
  name: string
  kind: RecurringKind
  frequency: RecurrenceFreq
  anchor: RecurrenceAnchor
  day_of_month: number | null
  start_period: string
  end_period: string | null
  status: RecurringStatus
  template_code: string
  template_input: unknown
  amount_cents: bigint | null
  fixed_asset_id: string | null
  accrual_id: string | null
  periods: string[] | null
  last_period: string | null
  occurrence_count: bigint
}

const toDueRow = (r: DueSqlRow): RecurringDueRow => ({
  id: r.id,
  code: r.code,
  name: r.name,
  kind: r.kind,
  frequency: r.frequency,
  anchor: r.anchor,
  dayOfMonth: r.day_of_month,
  startPeriod: r.start_period,
  endPeriod: r.end_period,
  status: r.status,
  templateCode: r.template_code,
  templateInput: r.template_input,
  amountCents: centsFromDbNullable(r.amount_cents, "importe fijo de la regla"),
  fixedAssetId: r.fixed_asset_id,
  accrualId: r.accrual_id,
  generatedPeriods: r.periods ?? [],
  lastPeriod: r.last_period,
  occurrenceCount: Number(r.occurrence_count),
})

/**
 * Reglas + claves de ocurrencia ya generadas, en **una** consulta con
 * `LEFT JOIN LATERAL`. Por defecto sólo las `ACTIVA` (las `PAUSADA` no generan y
 * **no rellenan hacia atrás**, R-REC-5); con `includeInactive` entran todas,
 * que es lo que el calendario enseña.
 */
export async function readRecurringDue(
  tx: TenantTransactionClient,
  opts: { includeInactive?: boolean; kind?: RecurringKind } = {}
): Promise<RecurringDueRow[]> {
  const rows = await tx.$queryRaw<DueSqlRow[]>`
    SELECT r.id, r.code, r.name, r.kind, r.frequency, r.anchor, r.day_of_month,
           r.start_period, r.end_period, r.status, r.template_code, r.template_input,
           r.amount_cents, r.fixed_asset_id, r.accrual_id,
           o.periods, o.last_period, COALESCE(o.occurrence_count, 0) AS occurrence_count
      FROM recurring_entries r
      LEFT JOIN LATERAL (
        SELECT array_agg(x.period ORDER BY x.period) AS periods,
               max(x.period)                          AS last_period,
               count(*)                               AS occurrence_count
          FROM recurring_occurrences x
         WHERE x.organization_id = r.organization_id
           AND x.recurring_entry_id = r.id
      ) o ON TRUE
     WHERE r.organization_id = ${tx.$organizationId}::uuid
       AND (${opts.includeInactive === true} OR r.status = 'ACTIVA')
       AND (${opts.kind ?? null}::text IS NULL OR r.kind::text = ${opts.kind ?? null})
     ORDER BY r.code`
  return rows.map(toDueRow)
}

/** Las ocurrencias de un periodo (o de una regla), para el calendario y I-E9-1a. */
export async function listOccurrences(
  db: AnyClient,
  opts: { recurringEntryId?: string; period?: PeriodKey; from?: PeriodKey; to?: PeriodKey } = {}
): Promise<RecurringOccurrenceRow[]> {
  const rows = await db.recurringOccurrence.findMany({
    where: {
      ...(opts.recurringEntryId ? { recurringEntryId: opts.recurringEntryId } : {}),
      ...(opts.period ? { period: opts.period } : {}),
      ...(opts.from || opts.to ? { period: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) } } : {}),
    },
    orderBy: [{ period: "asc" }, { recurringEntryId: "asc" }],
  })
  return rows.map((r) => ({
    id: r.id,
    recurringEntryId: r.recurringEntryId,
    period: r.period,
    postingDate: fromUtcDate(r.postingDate),
    status: r.status,
    reason: r.reason,
    entryId: r.entryId,
    inputHash: r.inputHash,
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Escritura — la regla
// ─────────────────────────────────────────────────────────────────────────────

export type RecurringInput = {
  code: string
  name: string
  kind: RecurringKind
  templateCode: string
  templateInput: unknown
  amountCents?: number | null
  frequency: RecurrenceFreq
  anchor?: RecurrenceAnchor
  dayOfMonth?: number | null
  startPeriod: PeriodKey
  endPeriod?: PeriodKey | null
  fixedAssetId?: string | null
  accrualId?: string | null
}

export async function createRecurringTx(
  tx: TenantTransactionClient,
  input: RecurringInput,
  actor: Actor
): Promise<RecurringRuleRow> {
  const row = await tx.recurringEntry.create({
    data: {
      organizationId: tx.$organizationId,
      code: input.code,
      name: input.name,
      kind: input.kind,
      templateCode: input.templateCode,
      templateInput: input.templateInput as never,
      amountCents: centsToDbNullable(input.amountCents ?? null, "importe fijo de la regla"),
      frequency: input.frequency,
      anchor: input.anchor ?? "ULTIMO_DIA",
      dayOfMonth: input.dayOfMonth ?? null,
      startPeriod: input.startPeriod,
      endPeriod: input.endPeriod ?? null,
      fixedAssetId: input.fixedAssetId ?? null,
      accrualId: input.accrualId ?? null,
      createdById: actor.userId ?? null,
    },
  })
  await writeAuditLog(tx, {
    entity: "RecurringEntry",
    entityId: row.id,
    action: "create",
    after: { code: row.code, kind: row.kind, templateCode: row.templateCode, startPeriod: row.startPeriod },
    userId: actor.userId ?? null,
  })
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    frequency: row.frequency,
    anchor: row.anchor,
    dayOfMonth: row.dayOfMonth,
    startPeriod: row.startPeriod,
    endPeriod: row.endPeriod,
    status: row.status,
    templateCode: row.templateCode,
    templateInput: row.templateInput,
    amountCents: centsFromDbNullable(row.amountCents, "importe fijo de la regla"),
    fixedAssetId: row.fixedAssetId,
    accrualId: row.accrualId,
  }
}

/** Pausar / reactivar / finalizar. El estado de una regla **no** es un borrado. */
export async function setRecurringStatusTx(
  tx: TenantTransactionClient,
  input: { id: string; status: RecurringStatus; reason?: string | null },
  actor: Actor
): Promise<void> {
  const before = await tx.recurringEntry.findFirst({ where: { id: input.id }, select: { status: true, code: true } })
  if (!before) e9Abort("RECURRING_NOT_FOUND", "id", "La regla recurrente no existe en esta organización")
  await tx.recurringEntry.update({ where: { id: input.id }, data: { status: input.status } })
  await writeAuditLog(tx, {
    entity: "RecurringEntry",
    entityId: input.id,
    action: "SET_STATUS",
    before: { status: before.status },
    after: { status: input.status },
    reason: input.reason ?? null,
    userId: actor.userId ?? null,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Escritura — la ocurrencia (R-REC-3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lo que la capa de aplicación aporta para materializar UN periodo: o un
 * borrador de asiento, o el motivo por el que no lo hay.
 *
 * `OMITIDA` con motivo `CUOTA_CERO` es el caso de O-22 —una fila de cuadro de
 * importe 0 **no genera asiento**—, y `FALLIDA` el de una plantilla que ya no
 * resuelve (la cuenta desapareció del plan). Ninguno de los dos deja hueco: la
 * fila existe con su motivo a la vista, que es lo que hace visible el devengo
 * que falta (R-REC-5).
 */
export type OccurrenceOutcome =
  | { status: "GENERADA"; draft: EntryDraft }
  | { status: "OMITIDA" | "FALLIDA"; reason: string }

export type OccurrenceResult = {
  occurrenceId: string
  period: PeriodKey
  status: OccurrenceStatus
  entry: PostedEntry | null
  reason: string | null
}

/**
 * **R-REC-3 · la idempotencia, escrita como es.**
 *
 * 1. El **asiento primero**, con `idempotencyKey = recurring:<code>:<period>`.
 * 2. Y la ocurrencia **después, ya enlazada**: un solo `INSERT` con su
 *    `entry_id` dentro. Si choca contra G-1 (23505) la transacción entera
 *    muere y el asiento se va con ella: no hay asiento huérfano porque
 *    **nada se ha confirmado todavía**. Nunca «mirar y luego insertar».
 *
 * **Por qué este orden y no el contrario (ronda de integración de E9).** La
 * versión de T12 insertaba la ocurrencia primero, con `status = 'GENERADA'` y
 * `entry_id` nulo, y la enlazaba con un `UPDATE` posterior. Chocaba con dos
 * cosas que T4 dejó escritas en la base y que son correctas:
 *
 *  · el CHECK `recurring_occurrences_entry_iff_generada` —`(entry_id IS NOT
 *    NULL) = (status = 'GENERADA')`, inmediato, porque un CHECK no se puede
 *    diferir en PostgreSQL—, que aborta ese `INSERT` intermedio; y
 *  · la política **append-only** `recurring_occurrences_no_update`
 *    (RESTRICTIVE, `USING (false)`, sin `GRANT UPDATE` a `app_runtime`), que
 *    hace que el `UPDATE` del paso 3 no pudiera existir de ninguna manera.
 *
 * Ninguna generación real llegaba a contabilizarse. Con el orden invertido, la
 * ocurrencia nace con su asiento y la restricción de la base sigue garantizando
 * `entry ⇔ GENERADA` **en todo momento**, no sólo al COMMIT — que es una
 * garantía más fuerte que la del trigger diferido.
 *
 * La idempotencia no se debilita: sigue siendo el índice único
 * `(organization_id, recurring_entry_id, period)`, reforzado ahora por la clave
 * de idempotencia del propio asiento, que muerde antes.
 *
 * Quien llama está DENTRO de `runLedgerTransaction`: aquí se aborta lanzando,
 * nunca devolviendo.
 */
export async function recordOccurrenceTx(
  tx: TenantTransactionClient,
  input: {
    rule: Pick<RecurringRuleRow, "id" | "code">
    period: PeriodKey
    postingDate: LocalDate
    inputHash: string
    outcome: OccurrenceOutcome
  },
  actor: Actor
): Promise<OccurrenceResult> {
  const { rule, period, outcome } = input

  // (1) el asiento, con su clave de idempotencia como primera red. Sólo cuando
  //     hay algo que contabilizar: una ocurrencia OMITIDA o FALLIDA no postea.
  const entry =
    outcome.status === "GENERADA"
      ? await postEntryTx(tx, outcome.draft, actor, {
          idempotencyKey: occurrenceIdempotencyKey(rule.code, period),
        })
      : null

  // (2) la ocurrencia, YA enlazada: `entry_id` entra en el mismo INSERT, de modo
  //     que el CHECK `entry_iff_generada` se cumple desde el primer instante y
  //     la tabla sigue siendo estrictamente append-only. El índice único es la
  //     idempotencia: si muerde, la transacción entera —asiento incluido— muere.
  const occurrence = await tx.recurringOccurrence.create({
    data: {
      organizationId: tx.$organizationId,
      recurringEntryId: rule.id,
      period,
      postingDate: toUtcDate(input.postingDate),
      status: outcome.status,
      reason: outcome.status === "GENERADA" ? null : outcome.reason,
      entryId: entry?.id ?? null,
      inputHash: input.inputHash,
      generatedById: actor.userId ?? null,
    },
  })

  if (outcome.status !== "GENERADA") {
    return { occurrenceId: occurrence.id, period, status: outcome.status, entry: null, reason: outcome.reason }
  }

  return { occurrenceId: occurrence.id, period, status: "GENERADA", entry, reason: null }
}

/**
 * **R-REC-7.** Revertir una ocurrencia **no la borra**: se anula su asiento con
 * contra-asiento (T-21, quien lo postea es la acción) y aquí se deja constancia.
 * La fila sigue `GENERADA` apuntando al asiento anulado, y el par se neutraliza
 * solo en los informes.
 */
export async function noteOccurrenceReversalTx(
  tx: TenantTransactionClient,
  input: { occurrenceId: string; reversalEntryId: string; reason: string },
  actor: Actor
): Promise<void> {
  const row = await tx.recurringOccurrence.findFirst({
    where: { id: input.occurrenceId },
    select: { id: true, period: true, entryId: true, recurringEntryId: true },
  })
  if (!row) e9Abort("OCCURRENCE_NOT_FOUND", "occurrenceId", "La ocurrencia no existe en esta organización")
  await writeAuditLog(tx, {
    entity: "RecurringOccurrence",
    entityId: row.id,
    action: "REVERT_OCCURRENCE",
    before: { period: row.period, entryId: row.entryId },
    after: { reversalEntryId: input.reversalEntryId },
    reason: input.reason,
    userId: actor.userId ?? null,
  })
}
