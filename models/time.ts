/**
 * E10 · T12 — Acceso a datos de los partes de horas
 * (`docs/design/E10-presupuesto-horas.md` §4.1).
 *
 * **Ninguna función calcula**: leen, escriben y delegan en `lib/time/aggregate.ts`
 * y `lib/time/cost.ts`, que son puros. Todo acceso pasa por `tenantDb` /
 * `tenantTransaction`; toda escritura lleva su `AuditLog` **en la misma
 * transacción**, y todo aborto es un `throw`.
 *
 * Las cuatro reglas que gobiernan esta tabla, y que están puestas **dos veces**
 * —aquí, con un mensaje en español contable, y en la base, con su trigger—,
 * porque la barrera de la aplicación explica y la de la base garantiza:
 *
 *  · **R-H-1 / I-E10-4** — un parte APROBADO es inmutable. No se edita y no se
 *    borra: se corrige con un **contra-apunte** con motivo, igual que un asiento
 *    se anula con un contra-asiento (ADR-0003).
 *  · **R-H-3** — sólo los partes APROBADOS alimentan el driver y el coste-hora.
 *    Los pendientes no son cero: son un aviso (`W-E10-UNAPPROVED-HOURS`) y un
 *    motivo de sello (`HORAS_SIN_APROBAR`, EV-15).
 *  · **R-H-4 / P5** — nadie aprueba sus propios partes, salvo un `ADMIN`. La
 *    segregación no se declara en un documento: se comprueba al aprobar.
 *  · **B-9** — un mes bloqueado no admite partes nuevos ni aprobaciones: sus
 *    horas ya alimentaron una liquidación y un informe rendidos.
 *
 * **Agregados en SQL.** El techo de §9 es «el ejercicio completo (120 000
 * partes) en < 600 ms, agregado por (receptor, mes), jamás materializando los
 * partes». Por eso `minutesByTargetSql` existe además de `getTimeRowsForWindow`:
 * el segundo materializa —y es lo correcto para sellar el `timeHash` de una
 * ventana de un periodo—, el primero no.
 */

import { createHash } from "node:crypto"

import {
  DAILY_MINUTES_CEILING,
  type DateWindow,
  type TimeEntryRow,
} from "@/lib/time/aggregate"
import {
  proposePayrollReclass,
  type PayrollLineRef,
  type ProposePayrollReclassResult,
} from "@/lib/time/payroll-reclass"
import type { LocalDate } from "@/lib/analytics/types"
import type { TenantClient, TenantTransactionClient } from "@/lib/db"
import { fromUtcDate, toUtcDate } from "@/lib/ledger/dates"
import type { Actor } from "@/models/analytics"
import { writeAuditLog, writeAuditLogs } from "@/models/audit-log"
import { assertReason, e10Abort } from "@/models/e10-errors"
import type { TimeEntrySource, TimeEntryStatus } from "@/prisma/client"

type AnyClient = TenantClient | TenantTransactionClient

// ─────────────────────────────────────────────────────────────────────────────
// Lecturas
// ─────────────────────────────────────────────────────────────────────────────

export type TimeEntryListItem = {
  id: string
  employeeId: string
  employeeCode: string
  employeeName: string
  date: LocalDate
  projectId: string | null
  projectCode: string | null
  costCenterId: string | null
  costCenterCode: string | null
  businessLineId: string | null
  minutes: number
  productive: boolean
  status: TimeEntryStatus
  source: TimeEntrySource
  note: string | null
  approvedAt: string | null
  approvedById: string | null
  correctsEntryId: string | null
  correctionReason: string | null
  createdAt: string
}

export type TimeEntryFilter = {
  from?: LocalDate
  to?: LocalDate
  employeeId?: string
  projectId?: string
  costCenterId?: string
  status?: TimeEntryStatus
  productiveOnly?: boolean
}

export type Page = { skip?: number; take?: number }

const TIME_INCLUDE = {
  employee: { select: { code: true, name: true } },
  project: { select: { code: true } },
  costCenter: { select: { code: true } },
} as const

function timeWhere(filter: TimeEntryFilter): Record<string, unknown> {
  return {
    ...(filter.employeeId ? { employeeId: filter.employeeId } : {}),
    ...(filter.projectId ? { projectId: filter.projectId } : {}),
    ...(filter.costCenterId ? { costCenterId: filter.costCenterId } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.productiveOnly === true ? { productive: true } : {}),
    ...(filter.from || filter.to
      ? {
          date: {
            ...(filter.from ? { gte: toUtcDate(filter.from) } : {}),
            ...(filter.to ? { lte: toUtcDate(filter.to) } : {}),
          },
        }
      : {}),
  }
}

/** Paginado, patrón de E3: las páginas cuentan EN LA BASE, nunca en memoria. */
export async function listTimeEntries(
  db: AnyClient,
  filter: TimeEntryFilter = {},
  page: Page = {}
): Promise<{ entries: TimeEntryListItem[]; total: number }> {
  const where = timeWhere(filter)
  // En SERIE: dentro de una transacción hay UNA conexión (E6-perf, hallazgo #6).
  const rows = await db.timeEntry.findMany({
    where,
    include: TIME_INCLUDE,
    orderBy: [{ date: "asc" }, { employeeId: "asc" }, { createdAt: "asc" }],
    skip: page.skip ?? 0,
    take: page.take ?? 100,
  })
  const total = await db.timeEntry.count({ where })
  return {
    entries: rows.map((r) => ({
      id: r.id,
      employeeId: r.employeeId,
      employeeCode: r.employee.code,
      employeeName: r.employee.name,
      date: fromUtcDate(r.date),
      projectId: r.projectId,
      projectCode: r.project?.code ?? null,
      costCenterId: r.costCenterId,
      costCenterCode: r.costCenter?.code ?? null,
      businessLineId: r.businessLineId,
      minutes: r.minutes,
      productive: r.productive,
      status: r.status,
      source: r.source,
      note: r.note,
      approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
      approvedById: r.approvedById,
      correctsEntryId: r.correctsEntryId,
      correctionReason: r.correctionReason,
      createdAt: r.createdAt.toISOString(),
    })),
    total,
  }
}

/**
 * **O-E10-2** — devuelve **aprobados y sin aprobar** de la ventana, con su
 * bandera. El driver usa los primeros; `W-E10-UNAPPROVED-HOURS` y EV-15
 * necesitan los segundos, y filtrarlos aquí dejaría el aviso sin datos y el
 * reparto luciendo completo cuando le falta una parte de la base.
 */
export async function getTimeRowsForWindow(
  tx: TenantTransactionClient,
  window: DateWindow,
  filter: { productiveOnly?: boolean } = {}
): Promise<TimeEntryRow[]> {
  const rows = await tx.$queryRaw<
    {
      id: string
      employee_id: string
      employee_code: string
      date: Date
      target_kind: string
      target_id: string
      target_code: string
      business_line_code: string | null
      minutes: number
      productive: boolean
      approved: boolean
    }[]
  >`
    SELECT t.id,
           t.employee_id,
           e.code                                             AS employee_code,
           t.date,
           CASE WHEN t.project_id IS NOT NULL THEN 'PROJECT' ELSE 'COST_CENTER' END AS target_kind,
           COALESCE(t.project_id, t.cost_center_id)           AS target_id,
           COALESCE(p.code, c.code)                           AS target_code,
           b.code                                             AS business_line_code,
           t.minutes,
           t.productive,
           (t.status = 'APROBADO')                            AS approved
      FROM time_entries t
      JOIN employees e       ON e.id = t.employee_id      AND e.organization_id = t.organization_id
      LEFT JOIN projects p   ON p.id = t.project_id       AND p.organization_id = t.organization_id
      LEFT JOIN cost_centers c ON c.id = t.cost_center_id AND c.organization_id = t.organization_id
      LEFT JOIN business_lines b ON b.id = t.business_line_id AND b.organization_id = t.organization_id
     WHERE t.organization_id = ${tx.$organizationId}::uuid
       AND t.date BETWEEN ${toUtcDate(window.from)}::date AND ${toUtcDate(window.to)}::date
       AND (${filter.productiveOnly === true} = false OR t.productive)
     ORDER BY t.date, e.code, COALESCE(p.code, c.code), t.minutes, t.id`

  return rows.map((r) => ({
    id: r.id,
    employeeId: r.employee_id,
    employeeCode: r.employee_code,
    date: fromUtcDate(r.date),
    target:
      r.target_kind === "PROJECT"
        ? { kind: "PROJECT" as const, id: r.target_id, code: r.target_code }
        : { kind: "COST_CENTER" as const, id: r.target_id, code: r.target_code },
    businessLineCode: r.business_line_code,
    minutes: r.minutes,
    productive: r.productive,
    approved: r.approved,
  }))
}

export type TargetMonthMinutes = {
  targetKind: "PROJECT" | "COST_CENTER"
  targetId: string
  targetCode: string
  /** `"2026-03"`. */
  month: string
  minutes: number
}

/**
 * §9 — el agregado del ejercicio completo **en SQL**, por `(receptor, mes)`.
 * 120 000 partes no se traen a memoria para pintar una tabla de doce columnas;
 * el techo del diseño es < 600 ms y se mide en `perf-budget.test.ts`.
 */
export async function minutesByTargetMonthSql(
  tx: TenantTransactionClient,
  window: DateWindow,
  opts: { productiveOnly?: boolean; approvedOnly?: boolean } = {}
): Promise<TargetMonthMinutes[]> {
  const rows = await tx.$queryRaw<
    { target_kind: string; target_id: string; target_code: string; month: string; minutes: bigint }[]
  >`
    SELECT CASE WHEN t.project_id IS NOT NULL THEN 'PROJECT' ELSE 'COST_CENTER' END AS target_kind,
           COALESCE(t.project_id, t.cost_center_id)   AS target_id,
           COALESCE(p.code, c.code)                   AS target_code,
           to_char(date_trunc('month', t.date), 'YYYY-MM') AS month,
           SUM(t.minutes)::bigint                     AS minutes
      FROM time_entries t
      LEFT JOIN projects p     ON p.id = t.project_id     AND p.organization_id = t.organization_id
      LEFT JOIN cost_centers c ON c.id = t.cost_center_id AND c.organization_id = t.organization_id
     WHERE t.organization_id = ${tx.$organizationId}::uuid
       AND t.date BETWEEN ${toUtcDate(window.from)}::date AND ${toUtcDate(window.to)}::date
       AND (${opts.approvedOnly !== false} = false OR t.status = 'APROBADO')
       AND (${opts.productiveOnly === true} = false OR t.productive)
     GROUP BY 1, 2, 3, 4
     ORDER BY 3, 4`
  return rows.map((r) => ({
    targetKind: r.target_kind === "PROJECT" ? "PROJECT" : "COST_CENTER",
    targetId: r.target_id,
    targetCode: r.target_code,
    month: r.month,
    minutes: Number(r.minutes),
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Escrituras
// ─────────────────────────────────────────────────────────────────────────────

export type TimeEntryInput = {
  employeeId: string
  date: LocalDate
  projectId?: string | null
  costCenterId?: string | null
  businessLineId?: string | null
  minutes: number
  productive?: boolean
  note?: string | null
  source?: TimeEntrySource
  importKey?: string | null
}

export type TimeWarning = { code: "DAILY_CEILING"; employeeCode: string; date: LocalDate; minutes: number; message: string }

export type CreateTimeEntriesResult = { created: number; ids: string[]; warnings: TimeWarning[] }

/**
 * Alta de partes en BORRADOR. El techo diario **agregado** (O-E10-21) se avisa
 * aquí y lo impide el trigger 4.f: cuatro partes de 1 440 minutos del mismo día
 * son legales uno a uno y absurdos juntos, y el CHECK por fila no los ve.
 */
export async function createTimeEntriesTx(
  tx: TenantTransactionClient,
  rows: readonly TimeEntryInput[],
  actor: Actor
): Promise<CreateTimeEntriesResult> {
  if (rows.length === 0) return { created: 0, ids: [], warnings: [] }

  for (const row of rows) {
    if (!Number.isInteger(row.minutes) || row.minutes === 0) {
      e10Abort("TIME_MINUTES_RANGE", "minutes", `los minutos deben ser un entero distinto de 0; recibido ${row.minutes}`)
    }
    if (row.minutes < 0) {
      e10Abort(
        "TIME_MINUTES_RANGE",
        "minutes",
        "los minutos negativos son EXCLUSIVOS del contra-apunte: usa `correctTimeEntryTx` con su motivo"
      )
    }
    if (Math.abs(row.minutes) > DAILY_MINUTES_CEILING) {
      e10Abort(
        "TIME_MINUTES_RANGE",
        "minutes",
        `${row.minutes} minutos en un parte: el techo por fila son ${DAILY_MINUTES_CEILING} (24 h)`
      )
    }
    if ((row.projectId == null) === (row.costCenterId == null)) {
      e10Abort(
        "TIME_DIMENSION",
        "projectId",
        "un parte imputa a UN proyecto o a UN centro de coste, nunca a los dos ni a ninguno"
      )
    }
  }

  // **R-A9** — `business_line_id` es una columna DENORMALIZADA del proyecto: la
  // escribe el código y la verifica un trigger (el mismo que `budget_lines`).
  // Se leen los proyectos implicados de UNA vez, no uno por parte.
  const projectIds = [...new Set(rows.map((r) => r.projectId).filter((id): id is string => id != null))]
  const projects =
    projectIds.length === 0
      ? []
      : await tx.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, businessLineId: true } })
  const businessLineByProject = new Map(projects.map((p) => [p.id, p.businessLineId]))

  const ids: string[] = []
  const warnings: TimeWarning[] = []

  // En SERIE, y una fila por INSERT: el trigger del techo diario agregado y el
  // de la fecha abierta son `FOR EACH ROW`, y con `createMany` el mensaje que
  // llega al usuario no diría qué fila lo produjo.
  for (const row of rows) {
    const created = await tx.timeEntry.create({
      data: {
        organizationId: tx.$organizationId,
        employeeId: row.employeeId,
        date: toUtcDate(row.date),
        projectId: row.projectId ?? null,
        costCenterId: row.costCenterId ?? null,
        businessLineId:
          row.businessLineId ?? (row.projectId == null ? null : (businessLineByProject.get(row.projectId) ?? null)),
        minutes: row.minutes,
        productive: row.productive ?? true,
        note: row.note ?? null,
        source: row.source ?? "MANUAL",
        status: "BORRADOR",
        importKey: row.importKey ?? null,
        createdById: actor.userId,
      },
      select: { id: true, employee: { select: { code: true } } },
    })
    ids.push(created.id)

    // Aviso al INSERTAR el segundo parte del día (O-E10-21). No bloquea: el
    // trigger es el que bloquea; esto es lo que el usuario lee mientras teclea.
    const [agg] = await tx.$queryRaw<{ minutes: bigint }[]>`
      SELECT COALESCE(SUM(minutes), 0)::bigint AS minutes
        FROM time_entries
       WHERE organization_id = ${tx.$organizationId}::uuid
         AND employee_id = ${row.employeeId}::uuid
         AND date = ${toUtcDate(row.date)}::date`
    const total = Number(agg?.minutes ?? BigInt(0))
    if (total > DAILY_MINUTES_CEILING * 0.75) {
      warnings.push({
        code: "DAILY_CEILING",
        employeeCode: created.employee.code,
        date: row.date,
        minutes: total,
        message:
          `${created.employee.code} acumula ${total} minutos el ${row.date} ` +
          `(techo diario ${DAILY_MINUTES_CEILING}): revisa si hay un parte duplicado`,
      })
    }
  }

  await writeAuditLogs(
    tx,
    ids.map((id, i) => ({
      entity: "TimeEntry" as const,
      entityId: id,
      action: "create" as const,
      after: { date: rows[i].date, minutes: rows[i].minutes, productive: rows[i].productive ?? true },
      userId: actor.userId,
    }))
  )
  return { created: ids.length, ids, warnings }
}

/**
 * **R-H-4 / P5** — la segregación en la aprobación. Un `EDITOR` cuyo usuario
 * está enlazado a un `Employee` **no aprueba sus propios partes**; un `ADMIN`
 * sí, y queda registrado quién y cuándo.
 *
 * La transición `BORRADOR → APROBADO` escribe **exactamente tres columnas**
 * (`status`, `approved_at`, `approved_by_id`): cualquier otra cosa la rechaza el
 * trigger `time_entries_immutable_when_approved` con `23514`.
 */
export async function approveTimeEntriesTx(
  tx: TenantTransactionClient,
  input: { ids: readonly string[]; approvedAt: Date; actorIsAdmin?: boolean },
  actor: Actor
): Promise<{ approved: number; skipped: number }> {
  if (input.ids.length === 0) return { approved: 0, skipped: 0 }

  const rows = await tx.timeEntry.findMany({
    where: { id: { in: [...input.ids] } },
    include: { employee: { select: { code: true, userId: true } } },
  })
  if (rows.length !== input.ids.length) {
    e10Abort("TIME_ENTRY_NOT_FOUND", "ids", "alguno de los partes no existe en esta organización")
  }

  if (input.actorIsAdmin !== true && actor.userId !== null) {
    const own = rows.filter((r) => r.employee.userId === actor.userId)
    if (own.length > 0) {
      e10Abort(
        "TIME_SELF_APPROVAL",
        "ids",
        `no puedes aprobar tus propios partes de horas (${own.length} de ${rows.length}): ` +
          "la segregación entre quien imputa y quien aprueba es la regla R-H-4. Pide a un administrador que los apruebe"
      )
    }
  }

  let approved = 0
  let skipped = 0
  for (const row of rows) {
    if (row.status === "APROBADO") {
      skipped += 1
      continue
    }
    await tx.timeEntry.update({
      where: { id: row.id },
      data: { status: "APROBADO", approvedAt: input.approvedAt, approvedById: actor.userId },
    })
    approved += 1
  }

  await writeAuditLogs(
    tx,
    rows
      .filter((r) => r.status !== "APROBADO")
      .map((r) => ({
        entity: "TimeEntry" as const,
        entityId: r.id,
        action: "APPROVE_TIME" as const,
        before: { status: r.status },
        after: { status: "APROBADO", employeeCode: r.employee.code, date: fromUtcDate(r.date), minutes: r.minutes },
        userId: actor.userId,
      }))
  )
  return { approved, skipped }
}

/**
 * **I-E10-4** — corrección por CONTRA-APUNTE. El original **sigue ahí**: se crea
 * una entrada de minutos negativos que lo referencia, con motivo de ≥ 10
 * caracteres, y el neto del día baja exactamente esos minutos. Nunca un `UPDATE`
 * sobre un parte aprobado, nunca un `DELETE`, nunca un flag de exclusión.
 */
export async function correctTimeEntryTx(
  tx: TenantTransactionClient,
  input: { entryId: string; minutes: number; reason: string; approvedAt: Date },
  actor: Actor
): Promise<{ id: string }> {
  const reason = assertReason(input.reason, "reason", "la corrección de un parte de horas")
  const original = await tx.timeEntry.findFirst({
    where: { id: input.entryId },
    include: { employee: { select: { code: true } } },
  })
  if (!original) e10Abort("TIME_ENTRY_NOT_FOUND", "entryId", "el parte de horas no existe en esta organización")
  if (original.status !== "APROBADO") {
    e10Abort(
      "TIME_ENTRY_NOT_APPROVED",
      "entryId",
      `el parte de ${original.employee.code} del ${fromUtcDate(original.date)} está en BORRADOR: ` +
        "edítalo o bórralo, el contra-apunte es para los aprobados"
    )
  }
  if (!Number.isInteger(input.minutes) || input.minutes >= 0) {
    e10Abort(
      "TIME_MINUTES_RANGE",
      "minutes",
      `el contra-apunte lleva minutos NEGATIVOS (lo que se retira); recibido ${input.minutes}`
    )
  }

  const row = await tx.timeEntry.create({
    data: {
      organizationId: tx.$organizationId,
      employeeId: original.employeeId,
      date: original.date,
      projectId: original.projectId,
      costCenterId: original.costCenterId,
      businessLineId: original.businessLineId,
      minutes: input.minutes,
      productive: original.productive,
      source: original.source,
      // El contra-apunte nace APROBADO: corrige un hecho ya aprobado y dejarlo
      // en borrador dejaría el neto sin corregir hasta que alguien lo aprobara.
      status: "APROBADO",
      // La fecha de aprobación entra por el BORDE, nunca de un reloj de aquí.
      approvedAt: input.approvedAt,
      approvedById: actor.userId,
      correctsEntryId: original.id,
      correctionReason: reason,
      createdById: actor.userId,
    },
    select: { id: true },
  })

  await writeAuditLog(tx, {
    entity: "TimeEntry",
    entityId: row.id,
    action: "CORRECT_TIME",
    before: { originalId: original.id, minutes: original.minutes },
    after: {
      minutes: input.minutes,
      employeeCode: original.employee.code,
      date: fromUtcDate(original.date),
      netMinutes: original.minutes + input.minutes,
    },
    reason,
    userId: actor.userId,
  })
  return { id: row.id }
}

// ─────────────────────────────────────────────────────────────────────────────
// Import CSV — idempotente por `importKey`
// ─────────────────────────────────────────────────────────────────────────────

export type ImportReport = {
  inserted: number
  skipped: number
  /** Por qué se omitió cada fila. Un contador sin motivos no se puede auditar. */
  reasons: { line: number; reason: string }[]
}

/** `sha256(fichero ‖ nº de línea)`: la clave de idempotencia de §2.2. */
export const importKeyOf = (fileSha256: string, lineNo: number): string =>
  createHash("sha256").update(`${fileSha256}|${lineNo}`, "utf8").digest("hex").slice(0, 64)

/**
 * Importa partes con **idempotencia por fichero y línea**: reimportar el mismo
 * CSV inserta **0 filas** (índice único parcial `time_entries_import_key`) y el
 * informe dice cuántas se omitieron y por qué (criterio 10).
 */
export async function importTimeCsvTx(
  tx: TenantTransactionClient,
  input: { rows: readonly (TimeEntryInput & { lineNo: number })[]; fileSha256: string },
  actor: Actor
): Promise<ImportReport> {
  const report: ImportReport = { inserted: 0, skipped: 0, reasons: [] }
  if (input.rows.length === 0) return report

  const keys = input.rows.map((r) => importKeyOf(input.fileSha256, r.lineNo))
  const existing = await tx.timeEntry.findMany({
    where: { importKey: { in: keys } },
    select: { importKey: true },
  })
  const already = new Set(existing.map((e) => e.importKey))

  const pending: (TimeEntryInput & { lineNo: number })[] = []
  input.rows.forEach((row, i) => {
    if (already.has(keys[i])) {
      report.skipped += 1
      report.reasons.push({ line: row.lineNo, reason: "ya importada en una ejecución anterior del mismo fichero" })
      return
    }
    pending.push({ ...row, importKey: keys[i], source: "CSV_IMPORT" })
  })

  if (pending.length > 0) {
    const created = await createTimeEntriesTx(tx, pending, actor)
    report.inserted = created.created
  }

  await writeAuditLog(tx, {
    entity: "TimeEntry",
    entityId: input.fileSha256.slice(0, 64),
    action: "IMPORT_TIME",
    after: { inserted: report.inserted, skipped: report.skipped, rows: input.rows.length },
    userId: actor.userId,
  })
  return report
}

// ─────────────────────────────────────────────────────────────────────────────
// B-9 — barrera 1 del bloqueo de periodos
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Un mes bloqueado no admite partes nuevos ni aprobaciones: sus horas ya
 * alimentaron una liquidación y un informe rendidos. Barrera 2, el trigger
 * `time_entries_date_in_fiscal_year`; ésta existe para que el mensaje diga qué
 * mes y qué hacer, en vez de un `23514` en crudo.
 */
export async function assertMonthOpenForTime(tx: TenantTransactionClient, date: LocalDate): Promise<void> {
  const [row] = await tx.$queryRaw<{ code: string; status: string; locked: boolean }[]>`
    SELECT fy.code,
           fy.status::text AS status,
           EXISTS (SELECT 1 FROM period_locks pl
                    WHERE pl.organization_id = fy.organization_id
                      AND pl.fiscal_year_id = fy.id
                      AND pl.month = date_part('month', ${toUtcDate(date)}::date)::integer) AS locked
      FROM fiscal_years fy
     WHERE fy.organization_id = ${tx.$organizationId}::uuid
       AND ${toUtcDate(date)}::date BETWEEN fy.start_date AND fy.end_date`
  if (!row) {
    e10Abort("FISCAL_YEAR_NOT_FOUND", "date", `la fecha ${date} no cae en ningún ejercicio de la organización`)
  }
  if (row.status === "CLOSED") {
    e10Abort(
      "TIME_PERIOD_LOCKED",
      "date",
      `el ejercicio ${row.code} está cerrado: no admite partes de horas (arts. 253, 272 y 279 LSC)`
    )
  }
  if (row.locked) {
    e10Abort(
      "TIME_PERIOD_LOCKED",
      "date",
      `el mes de ${date} está bloqueado: sus horas ya alimentaron una liquidación y un informe rendidos (B-9). ` +
        "Un administrador puede desbloquearlo con motivo"
    )
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.7 camino (b) — la PROPUESTA de reclasificación de nómina por horas
//
// **DEBE 6 de la revisión de la ronda 1.** `lib/time/payroll-reclass.ts` —250
// líneas de motor y 248 de test— no tenía **ni un consumidor**: el camino (b)
// era inalcanzable desde el producto, es decir código muerto en una épica que
// presume de no dejarlo. Este lector es su borde: lee las 64x del periodo con su
// CECO y las horas aprobadas, y **delega en la función pura**. No calcula nada, y
// sobre todo **no escribe nada**: aplicar la propuesta es `reclassifyLines`
// (ADR-0010), con su motivo, su `AuditLog` y su ventana temporal intactos.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Las líneas de nómina del periodo, en la forma que `proposePayrollReclass`
 * consume. El **APORTE** (`haber − debe`) es negativo en un gasto, como en todo
 * el resto del sistema.
 */
export async function getPayrollLinesForWindow(
  tx: TenantTransactionClient,
  window: DateWindow
): Promise<PayrollLineRef[]> {
  const rows = await tx.$queryRaw<
    {
      line_id: string
      entry_id: string
      entry_number: number
      line_no: number
      entry_date: Date
      account_code: string
      amount_cents: bigint
      cost_center_id: string | null
      cost_center_code: string | null
      project_id: string | null
      employee_id: string | null
      employee_code: string | null
    }[]
  >`
    SELECT jl.id                                   AS line_id,
           jl.entry_id                             AS entry_id,
           je.entry_number                         AS entry_number,
           jl.line_no                              AS line_no,
           jl.entry_date                           AS entry_date,
           jl.account_code                         AS account_code,
           (jl.credit_cents - jl.debit_cents)      AS amount_cents,
           jl.cost_center_id                       AS cost_center_id,
           cc.code                                 AS cost_center_code,
           jl.project_id                           AS project_id,
           e.id                                    AS employee_id,
           e.code                                  AS employee_code
      FROM journal_lines jl
      JOIN journal_entries je
        ON je.id = jl.entry_id AND je.organization_id = jl.organization_id
      LEFT JOIN cost_centers cc
        ON cc.id = jl.cost_center_id AND cc.organization_id = jl.organization_id
      -- La nomina se puede contabilizar por persona (counterparty_id); el
      -- empleado se enlaza por ahi, que es el unico puente que E10 declaro.
      LEFT JOIN employees e
        ON e.counterparty_id = jl.counterparty_id AND e.organization_id = jl.organization_id
     WHERE jl.organization_id = ${tx.$organizationId}::uuid
       AND jl.entry_date BETWEEN ${toUtcDate(window.from)}::date AND ${toUtcDate(window.to)}::date
       AND je.voided_at IS NULL
       AND (jl.account_code LIKE '640%' OR jl.account_code LIKE '642%'
            OR jl.account_code LIKE '645%' OR jl.account_code LIKE '649%')
     ORDER BY jl.entry_date, je.entry_number, jl.line_no`

  return rows.map((r) => ({
    lineId: r.line_id,
    entryId: r.entry_id,
    entryNumber: r.entry_number,
    lineNo: r.line_no,
    entryDate: fromUtcDate(r.entry_date),
    accountCode: r.account_code,
    amountCents: Number(r.amount_cents),
    costCenterId: r.cost_center_id,
    costCenterCode: r.cost_center_code,
    projectId: r.project_id,
    employeeId: r.employee_id,
    employeeCode: r.employee_code,
  }))
}

/**
 * La propuesta completa del camino (b): lee y delega. **Nunca escribe.**
 * `concentrationBps` es 10 000 fijo (O-E10-22): una línea repartida entre varios
 * proyectos NO se reclasifica —partir una `JournalLine` está prohibido—, y ese
 * caso es el camino (a), el driver `HOURS`.
 */
export async function payrollReclassProposal(
  tx: TenantTransactionClient,
  window: DateWindow
): Promise<ProposePayrollReclassResult> {
  const payrollLines = await getPayrollLinesForWindow(tx, window)
  const hours = await getTimeRowsForWindow(tx, window, { productiveOnly: true })
  return proposePayrollReclass({ payrollLines, hours, window })
}
