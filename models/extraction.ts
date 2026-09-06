/**
 * E8 · T12 — Acceso a `extraction_runs`. **IO puro: aquí no se calcula nada.**
 *
 * Tres cosas que este módulo sostiene:
 *
 *  1. **Un run no se modifica jamás.** No hay `updateExtractionRun` y no lo
 *     habrá: la tabla es append-only en la base (RESTRICTIVE + sin `GRANT
 *     UPDATE`; `app_runtime` recibe **42501**) y una función que lo intentara
 *     sólo serviría para descubrirlo en producción. Corregir una propuesta es
 *     **insertar un run de revisión** (`createRevisionRun`, ADR-0014 D5).
 *  2. **La bandeja no hace N+1.** `listInboxWithLatestRun` resuelve el último
 *     run de cada fichero con un `DISTINCT ON (file_id)` y devuelve el recuento
 *     agregado en la misma consulta: 2 000 ficheros y 6 000 runs por debajo de
 *     150 ms (§9). El patrón «un `findFirst` por fila» que TaxHacker usaba en
 *     la bandeja es exactamente lo que el estándar de calidad prohíbe.
 *  3. **Nada de SQL interpolado** (§10): todo por `Prisma.sql`, incluida la
 *     organización, aunque `tenantDb` ya la inyecte en los delegados —el SQL
 *     crudo no pasa por la extensión y el filtro es responsabilidad de quien lo
 *     escribe (límite #2 documentado en `lib/db.ts`).
 */

import type { TenantClient, TenantTransactionClient } from "@/lib/db"
import { proposalHash } from "@/lib/extraction/hash"
import type { ExtractionProposal, FieldOrigins } from "@/lib/extraction/types"
import { currentGitSha } from "@/models/reports"
import { Prisma, type ExtractionRun, type ReconcileStatus } from "@/prisma/client"

/**
 * Un run se puede crear **dentro** de la transacción que postea el asiento
 * (T13): el run de revisión y su asiento nacen o mueren juntos, que es lo que
 * hace que la cadena `journal_entries.extraction_run_id → extraction_runs` no
 * tenga eslabones sueltos.
 */
export type ExtractionClient = TenantClient | TenantTransactionClient

export type ReconcileOutcome = {
  status: ReconcileStatus
  detail: unknown
}

export type CreateExtractionRunInput = {
  fileId: string
  fileSha256: string
  kind: "LLM" | "MANUAL" | "IMPORTED"
  parentRunId?: string | null
  provider: string
  model: string
  temperatureBps?: number
  attempts?: unknown
  promptCode: string
  promptSource: "GIT" | "ORG"
  promptVersionId?: string | null
  promptSha: string
  schemaVersion: string
  schemaSha: string
  pagesSent: number
  pagesTotal: number
  rawOutput: unknown
  proposal?: ExtractionProposal | null
  fieldOrigins?: FieldOrigins
  reconcile?: ReconcileOutcome | null
  tokensIn?: number | null
  tokensOut?: number | null
  costMicros?: bigint | null
  durationMs: number
  createdById?: string | null
}

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue

/**
 * Alta de un run cualquiera (`LLM` lo hace `runExtraction`; `MANUAL` e
 * `IMPORTED` pasan por aquí). **Firma pública para T13.**
 */
export async function createExtractionRun(
  db: ExtractionClient,
  input: CreateExtractionRunInput
): Promise<ExtractionRun> {
  return await db.extractionRun.create({
    data: {
      organizationId: db.$organizationId,
      fileId: input.fileId,
      fileSha256: input.fileSha256,
      kind: input.kind,
      parentRunId: input.parentRunId ?? null,
      provider: input.provider,
      model: input.model,
      temperatureBps: input.temperatureBps ?? 0,
      attempts: json(input.attempts ?? []),
      promptCode: input.promptCode,
      promptSource: input.promptSource,
      promptVersionId: input.promptVersionId ?? null,
      promptSha: input.promptSha,
      schemaVersion: input.schemaVersion,
      schemaSha: input.schemaSha,
      pagesSent: input.pagesSent,
      pagesTotal: input.pagesTotal,
      rawOutput: json(input.rawOutput),
      proposal: input.proposal ? json(input.proposal) : Prisma.JsonNull,
      proposalSha: input.proposal ? proposalHash(input.proposal) : null,
      fieldOrigins: json(input.fieldOrigins ?? {}),
      reconcile: input.reconcile ? json(input.reconcile.detail) : Prisma.JsonNull,
      reconcileStatus: input.reconcile?.status ?? null,
      tokensIn: input.tokensIn ?? null,
      tokensOut: input.tokensOut ?? null,
      costMicros: input.costMicros ?? null,
      durationMs: input.durationMs,
      gitSha: currentGitSha(),
      createdById: input.createdById ?? null,
    },
  })
}

export type CreateRevisionRunInput = {
  parentRunId: string
  proposal: ExtractionProposal
  fieldOrigins: FieldOrigins
  reconcile?: ReconcileOutcome | null
  actorId: string | null
  durationMs?: number
}

/**
 * **ADR-0014 D5.** La propuesta que un humano revisa y confirma es un run
 * NUEVO, `kind = MANUAL`, `provider = "humano"`, colgado del run del modelo por
 * `parentRunId`. El asiento apuntará a este run, no al del LLM.
 *
 * Por qué no se actualiza el run original: porque entonces la evidencia de qué
 * dijo el modelo desaparecería en el momento exacto en que empieza a importar
 * —cuando alguien lo corrige— y `extraction_runs` volvería a ser
 * `cachedParseResult` con otro nombre. Encadenar cuesta una fila y conserva las
 * dos versiones y quién pasó de una a otra.
 *
 * Hereda del padre el fichero, su sha, el prompt y el esquema: la revisión se
 * hizo **sobre esa** extracción, y decir otra cosa rompería la cadena.
 *
 * **Firma pública para T13** (`confirmProposalAction`).
 */
export async function createRevisionRun(
  db: ExtractionClient,
  input: CreateRevisionRunInput
): Promise<ExtractionRun> {
  const parent = await getExtractionRun(db, input.parentRunId)
  if (!parent) throw new Error(`El run ${input.parentRunId} no existe en esta organización`)

  return await createExtractionRun(db, {
    fileId: parent.fileId,
    fileSha256: parent.fileSha256,
    kind: "MANUAL",
    parentRunId: parent.id,
    provider: "humano",
    model: "revision",
    attempts: [],
    promptCode: parent.promptCode,
    promptSource: parent.promptSource,
    promptVersionId: parent.promptVersionId,
    promptSha: parent.promptSha,
    schemaVersion: parent.schemaVersion,
    schemaSha: parent.schemaSha,
    // La persona vio el documento entero, no las páginas que se le mandaron al
    // modelo: un run de revisión nunca es `partial` (D5).
    pagesSent: parent.pagesTotal,
    pagesTotal: parent.pagesTotal,
    rawOutput: { revisionOf: parent.id },
    proposal: input.proposal,
    fieldOrigins: input.fieldOrigins,
    reconcile: input.reconcile ?? null,
    durationMs: input.durationMs ?? 0,
    createdById: input.actorId,
  })
}

export async function getExtractionRun(db: ExtractionClient, id: string): Promise<ExtractionRun | null> {
  return await db.extractionRun.findFirst({ where: { id } })
}

export async function listRunsForFile(db: TenantClient, fileId: string): Promise<ExtractionRun[]> {
  return await db.extractionRun.findMany({
    where: { fileId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  })
}

export async function getLatestRunForFile(db: TenantClient, fileId: string): Promise<ExtractionRun | null> {
  return await db.extractionRun.findFirst({
    where: { fileId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  })
}

/** Cadena de revisión de un run, del más antiguo al más reciente. */
export async function getRunChain(db: ExtractionClient, runId: string): Promise<ExtractionRun[]> {
  const chain: ExtractionRun[] = []
  let current = await getExtractionRun(db, runId)
  while (current) {
    chain.unshift(current)
    current = current.parentRunId ? await getExtractionRun(db, current.parentRunId) : null
    if (chain.length > 50) break // defensa contra un ciclo imposible por FK
  }
  return chain
}

export type InboxRow = {
  fileId: string
  filename: string
  mimetype: string
  fileCreatedAt: Date
  sha256: string
  runId: string | null
  runKind: string | null
  runCreatedAt: Date | null
  reconcileStatus: ReconcileStatus | null
  partial: boolean | null
  docKind: string | null
  totalCents: number | null
  currency: string | null
  documentNumber: string | null
}

export type InboxPage = {
  rows: InboxRow[]
  total: number
}

export type InboxFilter = {
  limit?: number
  offset?: number
  /** `false` (default) = bandeja de pendientes. */
  includeReviewed?: boolean
  status?: ReconcileStatus | "SIN_RUN"
}

/**
 * Bandeja con el último run de cada fichero, **sin N+1** y con el total en la
 * misma ida y vuelta.
 *
 * `DISTINCT ON (file_id) … ORDER BY file_id, created_at DESC` usa el índice
 * `extraction_runs (organization_id, file_id, created_at DESC)` que T2 creó
 * para esto. El `COUNT(*) OVER ()` evita la segunda consulta de paginación.
 */
export async function listInboxWithLatestRun(db: TenantClient, filter: InboxFilter = {}): Promise<InboxPage> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200)
  const offset = Math.max(filter.offset ?? 0, 0)
  const organizationId = db.$organizationId

  const reviewedClause = filter.includeReviewed ? Prisma.sql`` : Prisma.sql`AND f.is_reviewed = false`
  const statusClause =
    filter.status === undefined
      ? Prisma.sql``
      : filter.status === "SIN_RUN"
        ? Prisma.sql`AND r.id IS NULL`
        : Prisma.sql`AND r.reconcile_status = ${filter.status}::reconcile_status`

  const rows = await db.$queryRaw<
    (Omit<InboxRow, "totalCents"> & { totalCents: bigint | null; total: bigint })[]
  >(Prisma.sql`
    WITH latest AS (
      SELECT DISTINCT ON (file_id)
             file_id, id, kind, created_at, reconcile_status, partial, proposal
        FROM extraction_runs
       WHERE organization_id = ${organizationId}::uuid
       ORDER BY file_id, created_at DESC, id DESC
    )
    SELECT f.id                              AS "fileId",
           f.filename                        AS "filename",
           f.mimetype                        AS "mimetype",
           f.created_at                      AS "fileCreatedAt",
           f.sha256                          AS "sha256",
           r.id                              AS "runId",
           r.kind::text                      AS "runKind",
           r.created_at                      AS "runCreatedAt",
           r.reconcile_status                AS "reconcileStatus",
           r.partial                         AS "partial",
           r.proposal->>'docKind'            AS "docKind",
           (r.proposal->>'totalCents')::bigint AS "totalCents",
           r.proposal->>'currency'           AS "currency",
           r.proposal->>'documentNumber'     AS "documentNumber",
           COUNT(*) OVER ()                  AS "total"
      FROM files f
      LEFT JOIN latest r ON r.file_id = f.id
     WHERE f.organization_id = ${organizationId}::uuid
       ${reviewedClause}
       ${statusClause}
     ORDER BY f.created_at DESC, f.id DESC
     LIMIT ${limit} OFFSET ${offset}
  `)

  return {
    rows: rows.map((row) => ({
      ...row,
      totalCents: row.totalCents === null ? null : Number(row.totalCents),
    })),
    total: rows.length > 0 ? Number(rows[0].total) : 0,
  }
}

export type PendingCounts = {
  sinRun: number
  pass: number
  warn: number
  fail: number
  partial: number
  total: number
}

/**
 * Recuentos de la bandeja en **una** consulta agregada. La alternativa —traer
 * las filas y contarlas en TypeScript— materializa la bandeja entera para
 * pintar cinco números, que es justo lo que el estándar de calidad descarta.
 */
export async function countPendingByStatus(db: TenantClient): Promise<PendingCounts> {
  const organizationId = db.$organizationId
  const rows = await db.$queryRaw<
    { sinRun: bigint; pass: bigint; warn: bigint; fail: bigint; partial: bigint; total: bigint }[]
  >(Prisma.sql`
    WITH latest AS (
      SELECT DISTINCT ON (file_id) file_id, reconcile_status, partial
        FROM extraction_runs
       WHERE organization_id = ${organizationId}::uuid
       ORDER BY file_id, created_at DESC, id DESC
    )
    SELECT COUNT(*) FILTER (WHERE r.file_id IS NULL)                    AS "sinRun",
           COUNT(*) FILTER (WHERE r.reconcile_status = 'PASS')          AS "pass",
           COUNT(*) FILTER (WHERE r.reconcile_status = 'WARN')          AS "warn",
           COUNT(*) FILTER (WHERE r.reconcile_status = 'FAIL')          AS "fail",
           COUNT(*) FILTER (WHERE r.partial)                            AS "partial",
           COUNT(*)                                                     AS "total"
      FROM files f
      LEFT JOIN latest r ON r.file_id = f.id
     WHERE f.organization_id = ${organizationId}::uuid
       AND f.is_reviewed = false
  `)

  const row = rows[0]
  return {
    sinRun: Number(row?.sinRun ?? 0),
    pass: Number(row?.pass ?? 0),
    warn: Number(row?.warn ?? 0),
    fail: Number(row?.fail ?? 0),
    partial: Number(row?.partial ?? 0),
    total: Number(row?.total ?? 0),
  }
}

/**
 * Propuesta tipada de un run. Devuelve `null` si el run no la tiene (un run
 * fallido o `IMPORTED` sin cifras). **No valida**: quien la consume es
 * `reconcile` o `postFromProposal`, que son los que saben juzgarla.
 */
export function proposalOf(run: ExtractionRun): ExtractionProposal | null {
  return (run.proposal as ExtractionProposal | null) ?? null
}
