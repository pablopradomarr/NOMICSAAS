/**
 * E11 · T8 — **el uso mensual, leído de las fuentes** (§3.4, ADR-0019 D1).
 *
 * `lib/platform/usage.ts` define QUÉ se cuenta y con qué exclusiones; esto lo
 * lee. Dos reglas que no se negocian:
 *
 * 1. **Agregados en SQL, nunca materializar.** Contar 50 000 asientos trayéndolos
 *    a memoria es exactamente lo que el estándar de calidad prohíbe. Todo el
 *    recuento cabe en **dos** consultas: una para las cifras y otra para las
 *    fuentes del `sourceHash`.
 * 2. **Caché por `sourceHash`, no por tiempo.** Un `UsageRun` cuyo `sourceHash`
 *    no coincida con el actual no es «una caché caducada»: es una cifra que ya
 *    no describe la realidad, y servirla es FAIL de I-E11-1.
 *
 * El reloj **no** entra: `refDate` viene por parámetro desde la acción o el
 * cron, como en todo el resto del producto.
 */

import { computeLedgerHash } from "@/models/ledger"
import { currentGitSha } from "@/models/reports"
import { tenantTransaction, type TenantTransactionClient } from "@/lib/db"
import {
  BILLABLE_BACKUP_TRIGGERS,
  BILLABLE_STORAGE_KINDS,
  SYSTEM_ENTRY_KINDS,
  computeUsage,
  monthBounds,
  periodMonthOf,
  usageSourceHash,
  type UsageFigures,
  type UsageInput,
} from "@/lib/platform/usage"
import type { UsageRun } from "@/prisma/client"

/**
 * Acciones de `AuditLog` que acreditan una **exportación materializada**. Un
 * informe visto en pantalla no es una exportación: lo que cuenta es que alguien
 * se llevó un fichero, y de eso queda traza en el libro de auditoría, no un
 * contador que alguien pueda incrementar por su cuenta.
 */
export const EXPORT_AUDIT_ACTIONS: readonly string[] = ["EXPORT_REPORT", "EXPORT_BUDGET", "EXPORT_LIBRO_REGISTRO"]

export type UsageSnapshot = {
  organizationId: string
  periodMonth: string
  figures: UsageFigures
  sourceHash: string
  gitSha: string
  computedAt: Date
  durationMs: number
  /** `true` si se sirvió de `UsageRun` sin recalcular. */
  fromCache: boolean
}

type FiguresRow = {
  entries: bigint
  ocr_docs: bigint
  exports: bigint
  backups: bigint
  members: bigint
  storage_bytes: bigint
}

type SourceRow = { table_name: string; rows: bigint; max_updated_at: Date | null }
type StorageKindRow = { kind: string; bytes: bigint }

/**
 * Las **seis cifras** en una sola consulta. Cada sub-select lleva su exclusión
 * escrita al lado: es el sitio donde O-5 y O-6 dejan de ser una promesa del
 * documento de diseño y pasan a ser un `WHERE`.
 */
async function readFigures(
  tx: TenantTransactionClient,
  organizationId: string,
  start: Date,
  endExclusive: Date
): Promise<UsageFigures> {
  const rows = await tx.$queryRaw<FiguresRow[]>`
    SELECT
      -- O-5: ni contra-asientos (reverses_entry_id) ni asientos de sistema.
      -- Corregir un error no puede costar el doble que dejarlo.
      (SELECT count(*) FROM journal_entries e
        WHERE e.organization_id = ${organizationId}::uuid
          AND e.entry_date >= ${start}::date AND e.entry_date < ${endExclusive}::date
          AND e.reverses_entry_id IS NULL
          AND e.kind::text <> ALL (${[...SYSTEM_ENTRY_KINDS]}::text[])
      ) AS entries,
      -- ADR-0014 D5: un run de revisión no consume, ya lo pagó el original.
      (SELECT count(*) FROM extraction_runs r
        WHERE r.organization_id = ${organizationId}::uuid
          AND r.created_at >= ${start} AND r.created_at < ${endExclusive}
          AND r.parent_run_id IS NULL
      ) AS ocr_docs,
      -- Exportación = fichero materializado (traza en audit_logs) + backup manual.
      (SELECT count(*) FROM audit_logs a
        WHERE a.organization_id = ${organizationId}::uuid
          AND a.ts >= ${start} AND a.ts < ${endExclusive}
          AND a.action = ANY (${[...EXPORT_AUDIT_ACTIONS]}::text[])
      ) + (SELECT count(*) FROM backup_jobs b
        WHERE b.organization_id = ${organizationId}::uuid
          AND b.created_at >= ${start} AND b.created_at < ${endExclusive}
          AND b.trigger::text = ANY (${[...BILLABLE_BACKUP_TRIGGERS]}::text[])
      ) AS exports,
      -- O-4: EXIT y SCHEDULED nunca cuentan. La portabilidad no se factura.
      (SELECT count(*) FROM backup_jobs b
        WHERE b.organization_id = ${organizationId}::uuid
          AND b.created_at >= ${start} AND b.created_at < ${endExclusive}
          AND b.trigger::text = ANY (${[...BILLABLE_BACKUP_TRIGGERS]}::text[])
          AND b.status IN ('DONE', 'RUNNING')
      ) AS backups,
      -- Miembros con invitación ACEPTADA. Las pendientes cuentan al invitar, no aquí.
      (SELECT count(*) FROM memberships m
        WHERE m.organization_id = ${organizationId}::uuid AND m.accepted_at IS NOT NULL
      ) AS members,
      -- O-12c: por kind, jamas por prefijo de clave. Los ZIP de backup y las
      -- copias de NUESTRAS facturas viven en el mismo bucket y no son su cuota.
      (SELECT COALESCE(sum(s.size_bytes), 0) FROM stored_objects s
        WHERE s.organization_id = ${organizationId}::uuid
          AND s.kind::text = ANY (${[...BILLABLE_STORAGE_KINDS]}::text[])
      ) AS storage_bytes`
  const row = rows[0]
  return {
    entries: Number(row?.entries ?? BigInt(0)),
    ocrDocs: Number(row?.ocr_docs ?? BigInt(0)),
    exports: Number(row?.exports ?? BigInt(0)),
    backups: Number(row?.backups ?? BigInt(0)),
    members: Number(row?.members ?? BigInt(0)),
    storageBytes: BigInt(row?.storage_bytes ?? BigInt(0)),
  }
}

/**
 * Las FUENTES del `sourceHash`: recuento y `max(updated_at)` por tabla. Ninguna
 * cifra derivada entra aquí — se validaría a sí misma.
 */
async function readSources(
  tx: TenantTransactionClient,
  organizationId: string
): Promise<{ sources: { table: string; rows: number; maxUpdatedAt: string | null }[]; storageByKind: { kind: string; bytes: bigint }[] }> {
  const sources = await tx.$queryRaw<SourceRow[]>`
    SELECT 'journal_entries' AS table_name, count(*) AS rows, max(posted_at) AS max_updated_at
      FROM journal_entries WHERE organization_id = ${organizationId}::uuid
    UNION ALL
    SELECT 'extraction_runs', count(*), max(created_at)
      FROM extraction_runs WHERE organization_id = ${organizationId}::uuid
    UNION ALL
    SELECT 'audit_logs', count(*), max(ts)
      FROM audit_logs WHERE organization_id = ${organizationId}::uuid
    UNION ALL
    SELECT 'backup_jobs', count(*), max(created_at)
      FROM backup_jobs WHERE organization_id = ${organizationId}::uuid
    UNION ALL
    SELECT 'stored_objects', count(*), max(created_at)
      FROM stored_objects WHERE organization_id = ${organizationId}::uuid
    UNION ALL
    SELECT 'memberships', count(*), max(created_at)
      FROM memberships WHERE organization_id = ${organizationId}::uuid
    ORDER BY 1`

  const storageByKind = await tx.$queryRaw<StorageKindRow[]>`
    SELECT kind::text AS kind, COALESCE(sum(size_bytes), 0) AS bytes
      FROM stored_objects WHERE organization_id = ${organizationId}::uuid
     GROUP BY kind ORDER BY 1`

  return {
    sources: sources.map((row) => ({
      table: row.table_name,
      rows: Number(row.rows),
      maxUpdatedAt: row.max_updated_at ? row.max_updated_at.toISOString() : null,
    })),
    storageByKind: storageByKind.map((row) => ({ kind: row.kind, bytes: BigInt(row.bytes) })),
  }
}

/** Reúne el input puro con el que se calculan las seis cifras y el hash. */
export async function readUsageInput(
  tx: TenantTransactionClient,
  organizationId: string,
  periodMonth: string
): Promise<UsageInput> {
  const { start, endExclusive } = monthBounds(periodMonth)
  const lastDay = new Date(endExclusive.getTime() - 86_400_000)

  const organization = await tx.organization.findFirst({
    where: { id: organizationId },
    select: { id: true, isDemo: true },
  })
  if (!organization) throw new Error(`organización desconocida: ${organizationId}`)

  const figures = await readFigures(tx, organizationId, start, endExclusive)
  const { sources, storageByKind } = await readSources(tx, organizationId)
  // **O-12b**: el `ledgerHash` DEL MES, no el del ejercicio. Sin acotarlo, dos
  // meses distintos compartirían clave de caché.
  const ledgerHashOfMonth = await computeLedgerHash(tx, {
    from: start.toISOString().slice(0, 10),
    to: lastDay.toISOString().slice(0, 10),
  })

  // **O-6**: la demo vive en su propia organización y no entra en el uso. La
  // marca es inmutable (trigger `organizations_is_demo_immutable`), así que
  // nadie puede convertir una organización real en demo para dejar de pagar.
  const isDemo = organization.isDemo

  return {
    organizationId,
    periodMonth,
    isDemo,
    figures,
    sources,
    ledgerHashOfMonth,
    storageByKind,
    acceptedMembers: figures.members,
  }
}

/**
 * El uso del mes, con caché por `sourceHash`.
 *
 * El `UsageRun` se inserta **después** de calcular, con `skipDuplicates`: dos
 * peticiones simultáneas producen la misma fila y la segunda no es un error.
 */
export async function getUsage(
  organizationId: string,
  refDate: Date,
  options: { periodMonth?: string; recompute?: boolean } = {}
): Promise<UsageSnapshot> {
  const periodMonth = options.periodMonth ?? periodMonthOf(refDate)
  const gitSha = currentGitSha().slice(0, 40)
  const startedAt = Date.now()

  return await tenantTransaction(organizationId, async (tx) => {
    const input = await readUsageInput(tx, organizationId, periodMonth)
    const sourceHash = usageSourceHash(input)

    if (!options.recompute) {
      const cached = await tx.usageRun.findFirst({
        where: { periodMonth: new Date(`${periodMonth}T00:00:00.000Z`), sourceHash, gitSha },
        orderBy: { computedAt: "desc" },
      })
      if (cached) {
        return {
          organizationId,
          periodMonth,
          figures: figuresOf(cached),
          sourceHash,
          gitSha,
          computedAt: cached.computedAt,
          durationMs: cached.durationMs,
          fromCache: true,
        }
      }
    }

    const figures = computeUsage(input, refDate)
    const durationMs = Date.now() - startedAt

    /**
     * **E11 · integración — la caché no se calienta dentro de una transacción de
     * SÓLO LECTURA.**
     *
     * `tenantTransaction` entra en la transacción ya abierta cuando la hay, y la
     * de `tenantPage` es `READ ONLY` (E6-perf). Intentar el `INSERT` ahí no
     * devolvía una caché fría: devolvía `25006` y **la página entera reventaba**
     * con un `DriverAdapterError`, porque en Postgres una sentencia fallida
     * envenena la transacción. `/settings/subscription` no cargaba.
     *
     * Se pregunta antes de escribir en vez de capturar después, precisamente por
     * eso: capturar llega tarde, la transacción ya está abortada. Y la cifra se
     * devuelve igual —**calculada**, no inventada—: la caché es una optimización
     * y su ausencia no puede quitarle al usuario el dato.
     */
    const [{ transaction_read_only: soloLectura }] = await tx.$queryRaw<{ transaction_read_only: string }[]>`
      SELECT current_setting('transaction_read_only') AS transaction_read_only`
    if (soloLectura === "on") {
      return { organizationId, periodMonth, figures, sourceHash, gitSha, computedAt: new Date(), durationMs, fromCache: false }
    }

    await tx.usageRun.createMany({
      data: [
        {
          organizationId,
          periodMonth: new Date(`${periodMonth}T00:00:00.000Z`),
          sourceHash,
          gitSha,
          members: figures.members,
          entries: figures.entries,
          ocrDocs: figures.ocrDocs,
          exports: figures.exports,
          backups: figures.backups,
          storageBytes: figures.storageBytes,
          durationMs,
        },
      ],
      skipDuplicates: true,
    })
    return { organizationId, periodMonth, figures, sourceHash, gitSha, computedAt: new Date(), durationMs, fromCache: false }
  })
}

/**
 * Variante **dentro de una transacción ya abierta**. La usa
 * `assertWithinLimit`: la comprobación de cuota y la escritura que la consume
 * tienen que compartir transacción, o dos peticiones simultáneas cuelan la
 * última plaza.
 */
export async function readUsageInTransaction(
  tx: TenantTransactionClient,
  organizationId: string,
  refDate: Date,
  periodMonth = periodMonthOf(refDate)
): Promise<{ figures: UsageFigures; sourceHash: string }> {
  const input = await readUsageInput(tx, organizationId, periodMonth)
  return { figures: computeUsage(input, refDate), sourceHash: usageSourceHash(input) }
}

const figuresOf = (run: UsageRun): UsageFigures => ({
  members: run.members,
  entries: run.entries,
  ocrDocs: run.ocrDocs,
  exports: run.exports,
  backups: run.backups,
  storageBytes: run.storageBytes,
})
