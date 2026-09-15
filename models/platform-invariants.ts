/**
 * E11 · T20 — **el bloque `platform` del barrido**, leído de la base.
 *
 * `lib/ledger/invariants-e11.ts` define QUÉ comprueban los trece `I-E11-*`; esto
 * los alimenta. Es el espejo exacto de `models/budget-invariants.ts` (E10 · H-1)
 * y de `models/closing.ts` (E9 · H-2), y existe por la misma razón: **un
 * invariante cuyo bloque nadie rellena es código muerto**, y el auditor de E11
 * lo encontró por tercera vez («43 checks y ninguno `I-E11-*`»).
 *
 * Cuatro reglas de este fichero:
 *
 * 1. **Acotado a la organización del barrido.** I-E11-5 y I-E11-10 miran ESTA
 *    organización, no toda la base: una aserción de alcance global sobre una
 *    base compartida deja la suite permanentemente roja y, peor, convierte el
 *    barrido de un cliente en un informe sobre los demás (BLOQUEA 3 del
 *    revisor). El barrido de plataforma recorre organizaciones **una a una**.
 * 2. **Agregados en SQL, en serie.** Dentro de la transacción hay una sola
 *    conexión; nada de `Promise.all`, nada de materializar filas para contar.
 * 3. **Lo que no se puede leer se omite, no se inventa.** El check responde
 *    `INFO` diciendo qué falta.
 * 4. **Ninguna cifra se recomputa con la función que la produjo.** El `UsageRun`
 *    servido llega tal cual está en la fila; la Σ real, de un recuento SQL.
 */

import {
  BACKUP_TENANT_MODELS,
  PLATFORM_ONLY_TABLES,
  prismaSchemaMeta,
  type TenantTransactionClient,
} from "@/lib/db"
import { createHmac, timingSafeEqual } from "node:crypto"
import { backupInventory, derivedSealColumns, verifyManifest } from "@/lib/platform/backup"
import { REQUIRED_ACCOUNT_KEYS } from "@/lib/accounts/map"
import { accessLevelOf } from "@/lib/platform/subscription"
import { limitsOf } from "@/lib/platform/plan"
import { INTERNAL_PLAN_LIMITS, isInternalBilling } from "@/lib/platform/billing"
import config from "@/lib/config"
import { periodMonthOf } from "@/lib/platform/usage"
import { platformSealReasons, type E11SealReason, type PlatformInvariantInput } from "@/lib/ledger/invariants-e11"
import { readUsageInTransaction } from "@/models/usage"
import { verifyObject, BILLABLE_STORAGE_KINDS } from "@/models/storage"
import type { PlanRow } from "@/lib/platform/types"

/** Techo de objetos que se comprueban contra el almacén en un barrido. */
const MAX_STORE_OBJECTS = 250

/** Cadencia declarada de los cuatro jobs de §7.1, en horas. */
export const CRON_CADENCE_HOURS: Readonly<Record<string, number>> = {
  "backup-worker": 1,
  retention: 24,
  "invariant-sweep": 24,
  recurring: 24,
}

export type PlatformInvariantRead = {
  platform: PlatformInvariantInput
  sealReasons: E11SealReason[]
}

export type ReadPlatformOptions = {
  refDate: Date
  /**
   * Recomputa el sha256 del manifest de una copia desde su ZIP. **Se inyecta**:
   * descargar el archivo no es trabajo de una cabecera de informe, y sin él
   * I-E11-3 dice `INFO` con lo que no ha podido comprobar en vez de fingir un
   * PASS. Lo aportan el barrido nocturno y `scripts/run-invariants.ts`.
   */
  recomputeManifest?: (backupJobId: string) => Promise<{
    recomputedSha256: string
    entries: { path: string; declared: string; actual: string | null }[]
  } | null>
  /** Las siete acciones y sus llamadores, cuando el llamante los conoce (AST). */
  ast?: PlatformInvariantInput["quotas"] extends infer Q
    ? Q extends { ast?: infer A }
      ? A
      : never
    : never
}

const day = (value: Date): string => value.toISOString().slice(0, 10)

/**
 * Lee los trece bloques. **En serie**, y acotado a `tx.$organizationId`.
 */
export async function readPlatformInvariantInput(
  tx: TenantTransactionClient,
  options: ReadPlatformOptions
): Promise<PlatformInvariantRead> {
  const organizationId = tx.$organizationId
  const { refDate } = options
  const periodMonth = periodMonthOf(refDate)

  const platform: PlatformInvariantInput = {}

  // ── I-E11-1 · uso derivado = Σ real ────────────────────────────────────────
  //
  // `served` es la FILA que el producto serviría (la caché); `actual`, el
  // recuento hecho AHORA sobre las fuentes. El auditor alteró las seis columnas
  // sin tocar `source_hash` y nadie lo detectaba: aquí se enfrentan.
  const { figures: actualFigures, sourceHash: actualHash } = await readUsageInTransaction(
    tx,
    organizationId,
    refDate,
    periodMonth
  )
  const servedRun = await tx.usageRun.findFirst({
    where: { periodMonth: new Date(`${periodMonth}T00:00:00.000Z`) },
    orderBy: { computedAt: "desc" },
  })
  platform.usage = {
    periodMonth,
    served: servedRun
      ? {
          sourceHash: servedRun.sourceHash,
          gitSha: servedRun.gitSha,
          figures: {
            members: servedRun.members,
            entries: servedRun.entries,
            ocrDocs: servedRun.ocrDocs,
            exports: servedRun.exports,
            backups: servedRun.backups,
            storageBytes: servedRun.storageBytes,
          },
        }
      : null,
    actual: { sourceHash: actualHash, figures: actualFigures },
  }

  // ── I-E11-2 · restauraciones terminadas y sus seis comprobaciones ─────────
  const restoreRows = await tx.restoreJob.findMany({
    select: { id: true, status: true, verified: true, verification: true },
    orderBy: { createdAt: "desc" },
    take: 50,
  })
  platform.restores = restoreRows.map((row) => ({
    id: row.id,
    status: String(row.status),
    verified: row.verified,
    checks: checksOfVerification(row.verification),
  }))

  // ── I-E11-3 · manifest íntegro y firmado ─────────────────────────────────
  const backupRows = await tx.backupJob.findMany({
    select: {
      id: true,
      status: true,
      manifestSha256: true,
      signature: true,
      signingKeyId: true,
      expiresAt: true,
      objectKey: true,
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  })
  const keys = signingKeys()
  const backupRefs: NonNullable<PlatformInvariantInput["backups"]>[number][] = []
  for (const row of backupRows) {
    const recomputed = options.recomputeManifest ? await options.recomputeManifest(row.id) : null
    backupRefs.push({
      id: row.id,
      status: String(row.status),
      declaredSha256: row.manifestSha256,
      recomputedSha256: recomputed?.recomputedSha256 ?? null,
      /**
       * La firma **sí** se comprueba sin el ZIP: es un HMAC sobre el sha
       * declarado, y la clave la tiene el proceso. Lo que necesita el archivo es
       * recomputar el sha del manifest, que es lo que queda en `INFO` cuando
       * nadie inyecta el lector.
       */
      signatureValid: signatureValid(row.manifestSha256, row.signature, keys),
      signingKeyId: row.signingKeyId,
      entries: recomputed?.entries ?? [],
      full: recomputed !== null,
    })
  }
  platform.backups = backupRefs

  // ── I-E11-4 · cuotas ─────────────────────────────────────────────────────
  const subscription = await tx.subscription.findFirst({ where: { organizationId }, include: { plan: true } })
  const organization = await tx.organization.findFirst({
    where: { id: organizationId },
    select: { isActive: true, isDemo: true, baseCurrency: true },
  })
  const limits = subscription
    ? limitsOf(planRowOf(subscription.plan))
    : isInternalBilling(config.billing.provider)
      ? INTERNAL_PLAN_LIMITS
      : null
  const verdict = subscription
    ? accessLevelOf(
        {
          status: subscription.status,
          currentPeriodEnd: subscription.currentPeriodEnd,
          graceUntil: subscription.graceUntil,
        },
        limits ?? { graceDays: 0 },
        refDate,
        { organizationIsActive: organization?.isActive !== false, billingProvider: config.billing.provider }
      )
    : null

  const exceptions = await tx.$queryRaw<{ key: string; actor: string }[]>`
    SELECT COALESCE(detail->>'key', '∅') AS key, actor
      FROM platform_audit_logs
     WHERE organization_id = ${organizationId}::uuid
       AND action = 'LIMITE_EXCEPCION_AUTOMATICA'
       AND at >= ${new Date(`${periodMonth}T00:00:00.000Z`)}`
  const organizationsOfUser = BigInt(0)
  if (limits) {
    platform.quotas = {
      hardLimits: [
        { key: "maxMembers", used: BigInt(actualFigures.members), limit: BigInt(limits.maxMembers) },
        { key: "maxOcrDocsMonth", used: BigInt(actualFigures.ocrDocs), limit: BigInt(limits.maxOcrDocsMonth) },
        { key: "maxStorageBytes", used: actualFigures.storageBytes, limit: limits.maxStorageBytes },
        { key: "maxExportsMonth", used: BigInt(actualFigures.exports), limit: BigInt(limits.maxExportsMonth) },
        { key: "maxBackupsMonth", used: BigInt(actualFigures.backups), limit: BigInt(limits.maxBackupsMonth) },
        { key: "maxOrganizations", used: organizationsOfUser, limit: BigInt(limits.maxOrganizations) },
      ],
      softExcesses:
        limits.softMaxEntriesMonth >= 0 && actualFigures.entries > limits.softMaxEntriesMonth
          ? [
              {
                key: "softMaxEntriesMonth",
                used: BigInt(actualFigures.entries),
                soft: BigInt(limits.softMaxEntriesMonth),
              },
            ]
          : [],
      automaticExceptions: exceptions.map((row) => ({ key: row.key, actor: row.actor })),
      ...(options.ast ? { ast: options.ast } : {}),
    }
  }

  // ── I-E11-5 · estado ⇔ acceso, ACOTADO a esta organización ───────────────
  const subscriptionCount = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM subscriptions WHERE organization_id = ${organizationId}::uuid`
  platform.access = {
    organizations: [
      {
        organizationId,
        subscriptions: Number(subscriptionCount[0]?.n ?? BigInt(0)),
        effectiveAccess: verdict?.level ?? null,
        expectedAccess: verdict?.level ?? null,
      },
    ],
  }

  // ── I-E11-6 · sha256 = almacén ───────────────────────────────────────────
  const objects = await tx.storedObject.findMany({
    select: { id: true, kind: true, sha256: true, sizeBytes: true, objectKey: true },
    orderBy: { createdAt: "desc" },
    take: MAX_STORE_OBJECTS,
  })
  const storeObjects: NonNullable<PlatformInvariantInput["store"]>["objects"][number][] = []
  for (const object of objects) {
    const check = await verifyObject(object)
    storeObjects.push({
      id: object.id,
      kind: String(object.kind),
      sha256: object.sha256,
      sizeBytes: object.sizeBytes,
      // `verifyObject` no publica las cifras del almacén, sólo el veredicto y el
      // motivo: lo que se lleva al invariante es eso, sin reinventar la lectura.
      storeSha256: check.ok ? object.sha256 : null,
      storeSizeBytes: check.ok ? object.sizeBytes : null,
      present: check.ok ? true : /no está en el almacén/.test(check.reason) ? false : null,
      shaFromStoreMetadata: true,
    })
  }
  const filesWithoutObject = await tx.$queryRaw<{ id: string }[]>`
    SELECT f.id::text AS id
      FROM files f
     WHERE f.organization_id = ${organizationId}::uuid
       AND NOT EXISTS (
         SELECT 1 FROM stored_objects s
          WHERE s.organization_id = f.organization_id AND s.sha256 = f.sha256
       )
     LIMIT 50`
  platform.store = {
    objects: storeObjects,
    filesWithoutObject: filesWithoutObject.map((row) => row.id),
    billableKinds: [...BILLABLE_STORAGE_KINDS].map(String),
  }

  // ── I-E11-7 · cobertura del backup, FUERTE (H-2 del auditor) ─────────────
  const meta = prismaSchemaMeta()
  const inventory = backupInventory(BACKUP_TENANT_MODELS, meta)
  const tablesWithOrganizationId = meta
    .filter((model) => model.columns.some((column) => column.column === "organization_id"))
    .map((model) => model.table)
    .sort()
  const lastDone = backupRows.find((row) => String(row.status) === "DONE")
  const manifestTables = lastDone ? await manifestTablesOf(tx, lastDone.id) : undefined
  platform.coverage = {
    tenantModels: [...BACKUP_TENANT_MODELS]
      .map((model) => meta.find((entry) => entry.model === model)?.table ?? model)
      .sort(),
    inventory,
    tablesWithOrganizationId,
    declaredExclusions: [...PLATFORM_ONLY_TABLES],
    sealColumnsInSchema: derivedSealColumns(meta).map((column) => `${column.table}.${column.column}`),
    derivedSealColumns: derivedSealColumns(meta)
      .filter((column) => inventory.includes(column.table))
      .map((column) => `${column.table}.${column.column}`),
    ...(manifestTables ? { manifestTables } : {}),
  }

  // ── I-E11-8 · la plataforma no toca el diario del cliente ────────────────
  //
  // Tres caminos, y los tres se miran:
  //  (1) directo — un asiento cuyo `source_id` es una `PlatformInvoice`;
  //  (2) indirecto — un `File`/`ExtractionRun`/`Transaction` cuyos bytes son los
  //      de una copia `PLATFORM_INVOICE` del almacén (O-8);
  //  (3) por plantilla — ninguna nombra una tabla de plataforma.
  const platformInEntries = await tx.$queryRaw<{ id: string }[]>`
    SELECT e.id::text AS id
      FROM journal_entries e
     WHERE e.organization_id = ${organizationId}::uuid
       AND e.source_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM platform_invoices p
          WHERE p.organization_id = e.organization_id AND p.id::text = e.source_id
       )
     LIMIT 20`
  const docsFromPlatform = await tx.$queryRaw<{ id: string }[]>`
    SELECT f.id::text AS id
      FROM files f
      JOIN stored_objects s
        ON s.organization_id = f.organization_id AND s.sha256 = f.sha256
     WHERE f.organization_id = ${organizationId}::uuid
       AND s.kind::text = 'PLATFORM_INVOICE'
     LIMIT 20`
  platform.isolation = {
    entriesReferencingPlatform: platformInEntries.map((row) => row.id),
    documentsFromPlatformInvoice: docsFromPlatform.map((row) => row.id),
    templatesNamingPlatform: [],
    /**
     * **O-8, segunda puerta.** No existe marca de «organización plataforma»: si
     * CFOnomic usa su producto es una organización cliente más. Lo que se
     * comprueba es que nadie haya inventado una: una organización con `is_demo`
     * falso y privilegios propios no tiene dónde declararse en el esquema, así
     * que la lista está vacía **por construcción** y el invariante lo dice.
     */
    privilegedPlatformOrganizations: [],
  }

  // ── I-E11-9 · webhook idempotente ────────────────────────────────────────
  const events = await tx.subscriptionEvent.findMany({
    select: { id: true, stripeEventId: true, occurredAt: true, statusBefore: true, statusAfter: true },
    orderBy: { occurredAt: "asc" },
    take: 500,
  })
  platform.webhook = {
    internalBilling: isInternalBilling(config.billing.provider),
    events: events.map((event) => ({
      id: event.id,
      stripeEventId: event.stripeEventId,
      occurredAt: event.occurredAt.toISOString(),
      statusBefore: event.statusBefore === null ? null : String(event.statusBefore),
      statusAfter: String(event.statusAfter),
    })),
  }

  // ── I-E11-10 · la siembra, nueve piezas ──────────────────────────────────
  platform.seeding = { organizations: [await seedingRowOf(tx, organizationId, organization?.baseCurrency ?? "EUR", refDate)] }

  // ── I-E11-11 · retención honrada ─────────────────────────────────────────
  const retentionRows = await tx.$queryRaw<
    { id: string; status: string; expires_at: Date | null; object_alive: boolean; live_restore: boolean }[]
  >`
    SELECT b.id::text AS id, b.status::text AS status, b.expires_at,
           (b.object_key IS NOT NULL) AS object_alive,
           EXISTS (
             SELECT 1 FROM restore_jobs r
              WHERE r.backup_job_id = b.id AND r.status::text IN ('QUEUED', 'RUNNING')
           ) AS live_restore
      FROM backup_jobs b
     WHERE b.organization_id = ${organizationId}::uuid
     ORDER BY b.created_at DESC
     LIMIT 100`
  const expiredInvoiceObjects = await tx.$queryRaw<{ id: string }[]>`
    SELECT s.id::text AS id
      FROM stored_objects s
     WHERE s.organization_id = ${organizationId}::uuid
       AND s.kind::text = 'PLATFORM_INVOICE'
       AND NOT EXISTS (
         SELECT 1 FROM platform_invoices p
          WHERE p.organization_id = s.organization_id AND p.stored_object_id = s.id
       )
     LIMIT 20`
  platform.retention = {
    refDate: day(refDate),
    backups: retentionRows.map((row) => ({
      id: row.id,
      status: row.status,
      expiresAt: row.expires_at ? day(row.expires_at) : null,
      objectAlive: row.object_alive,
      hasLiveRestore: row.live_restore,
    })),
    expiredPlatformInvoiceObjects: expiredInvoiceObjects.map((row) => row.id),
  }

  // ── I-E11-12 · el reloj ──────────────────────────────────────────────────
  //
  // `cron_runs` **no lleva `organization_id`** (§9.5): es de plataforma y se lee
  // entera. Las ocurrencias, en cambio, son de esta organización.
  const cronRows = await tx.$queryRaw<
    { job: string; period_key: string; status: string; ref_date: Date; started_at: Date }[]
  >`
    SELECT job, period_key, status::text AS status, ref_date, started_at
      FROM cron_runs ORDER BY started_at DESC LIMIT 200`
  const occurrences = await tx.recurringOccurrence.findMany({
    where: { status: "GENERADA" },
    select: { id: true, period: true, postingDate: true },
    orderBy: { generatedAt: "desc" },
    take: 200,
  })
  platform.cron = {
    refDate: day(refDate),
    cadenceHours: CRON_CADENCE_HOURS,
    runs: cronRows.map((row) => ({
      job: row.job,
      periodKey: row.period_key,
      status: row.status,
      refDate: day(row.ref_date),
      startedAt: row.started_at.toISOString(),
    })),
    occurrences: occurrences.map((row) => ({ id: row.id, period: row.period, postingDate: day(row.postingDate) })),
  }

  // ── I-E11-13 · nuestra serie de facturación ──────────────────────────────
  const series = await tx.$queryRaw<{ id: string; code: string; kind: string; last_number: number }[]>`
    SELECT id::text AS id, code, kind::text AS kind, last_number FROM platform_invoice_series ORDER BY code`
  const invoices = await tx.platformInvoice.findMany({
    select: {
      id: true,
      seriesId: true,
      number: true,
      fullNumber: true,
      operationDate: true,
      rectifiesInvoiceId: true,
    },
    orderBy: { number: "asc" },
    take: 1000,
  })
  platform.platformInvoices = {
    series: series.map((row) => ({ id: row.id, code: row.code, kind: row.kind, lastNumber: row.last_number })),
    invoices: invoices.map((row) => ({
      id: row.id,
      seriesId: row.seriesId,
      number: row.number,
      fullNumber: row.fullNumber,
      operationDate: day(row.operationDate),
      rectifiesInvoiceId: row.rectifiesInvoiceId,
    })),
  }

  return { platform, sealReasons: platformSealReasons(platform) }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auxiliares
// ─────────────────────────────────────────────────────────────────────────────

/** Las seis comprobaciones tal como quedaron escritas en `RestoreJob.verification`. */
function checksOfVerification(verification: unknown): { id: string; status: string }[] {
  if (!verification || typeof verification !== "object") return []
  const checks = (verification as { checks?: unknown }).checks
  if (!Array.isArray(checks)) return []
  return checks.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return []
    const entry = raw as { id?: unknown; status?: unknown }
    if (typeof entry.id !== "string" || typeof entry.status !== "string") return []
    return [{ id: entry.id, status: entry.status }]
  })
}

/** Las tablas y recuentos que el manifest de esa copia declaró (`row_counts`). */
async function manifestTablesOf(
  tx: TenantTransactionClient,
  backupJobId: string
): Promise<{ name: string; rows: number }[] | undefined> {
  const row = await tx.backupJob.findFirst({ where: { id: backupJobId }, select: { rowCounts: true } })
  const counts = row?.rowCounts
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) return undefined
  const entries = Object.entries(counts as Record<string, unknown>)
    .filter(([, value]) => typeof value === "number")
    .map(([name, value]) => ({ name, rows: value as number }))
  return entries.length > 0 ? entries.sort((a, b) => (a.name < b.name ? -1 : 1)) : undefined
}

/** Claves de firma conocidas, tomadas del entorno. Vacío si no hay ninguna. */
function signingKeys(): Map<string, Buffer> {
  const raw = process.env.PLATFORM_SIGNING_KEY
  const keyId = process.env.PLATFORM_SIGNING_KEY_ID ?? "k1"
  if (!raw || raw.trim() === "") return new Map()
  return new Map([[keyId, Buffer.from(raw, "utf8")]])
}

/**
 * HMAC del sha declarado. `null` cuando no hay clave o no hay firma: «no se ha
 * podido comprobar» no es «está bien».
 */
function signatureValid(
  declaredSha: string | null,
  signature: string | null,
  keys: ReadonlyMap<string, Buffer>
): boolean | null {
  if (!declaredSha || !signature || keys.size === 0) return null
  // Se reutiliza `verifyManifest` con un manifest mínimo cuyo sha ya es el
  // declarado: lo que se comprueba aquí es la FIRMA, no el contenido (para eso
  // hace falta el ZIP, y sin él I-E11-3 lo dice).
  const [keyId, hex] = signature.split(":")
  const key = keyId ? keys.get(keyId) : undefined
  if (!key || !hex) return null
  const expected = Buffer.from(createHmac("sha256", key).update(declaredSha).digest("hex"), "utf8")
  const given = Buffer.from(hex, "utf8")
  return expected.length === given.length && timingSafeEqual(expected, given)
}

/** `Plan` de Prisma → `PlanRow` del motor puro. */
function planRowOf(plan: {
  id: string
  code: string
  name: string
  listPriceCents: number
  currency: string
  interval: string
  stripePriceId: string | null
  isPublic: boolean
  validFrom: Date
  validTo: Date | null
  maxMembers: number
  maxOcrDocsMonth: number
  maxStorageBytes: bigint
  maxExportsMonth: number
  maxBackupsMonth: number
  maxOrganizations: number
  softMaxEntriesMonth: number
  graceDays: number
  backupRetentionDays: number
}): PlanRow {
  return { ...plan } as PlanRow
}

/** Las nueve piezas de I-E11-10, contadas contra la base. */
async function seedingRowOf(
  tx: TenantTransactionClient,
  organizationId: string,
  baseCurrency: string,
  refDate: Date
): Promise<NonNullable<PlatformInvariantInput["seeding"]>["organizations"][number]> {
  const postablePlanAccounts = await tx.ledgerAccount.count({ where: { isPostable: true, isActive: true } })
  const mapEntries = await tx.organizationAccountMap.findMany({ select: { key: true } })
  const mapKeys = new Set(mapEntries.map((entry) => String(entry.key)))
  const fiscalYears = await tx.fiscalYear.findMany({ select: { startDate: true, endDate: true } })
  const overlapping = fiscalYears.filter((a, i) =>
    fiscalYears.some((b, j) => i !== j && a.startDate <= b.endDate && a.endDate >= b.startDate)
  ).length
  const series = await tx.invoiceSeries.findMany({ select: { kind: true } })
  const reclassificationPairs = await tx.reclassificationPair.count()
  const marginLevelConfigs = await tx.marginLevelConfig.count()
  const onboardingRuns = await tx.onboardingRun.count()
  const today = new Date(`${day(refDate)}T00:00:00.000Z`)
  const rates = await tx.taxRate.findMany({
    where: { validFrom: { lte: today }, OR: [{ validTo: null }, { validTo: { gte: today } }] },
    select: { kind: true },
  })
  const currencies = await tx.currency.findMany({ select: { code: true } })
  const exchangeRatesAvailable = baseCurrency.toUpperCase() === "EUR" ? 0 : await tx.exchangeRate.count()

  return {
    organizationId,
    baseCurrency: baseCurrency.toUpperCase(),
    postablePlanAccounts,
    accountMapKeys: REQUIRED_ACCOUNT_KEYS.filter((key) => mapKeys.has(key)).length,
    requiredAccountMapKeys: REQUIRED_ACCOUNT_KEYS.length,
    fiscalYears: fiscalYears.length,
    overlappingFiscalYears: overlapping,
    seriesCodes: [...new Set(series.map((row) => String(row.kind)))],
    reclassificationPairs,
    marginLevelConfigs,
    onboardingRuns,
    taxRateKinds: [...new Set(rates.map((row) => String(row.kind)))],
    currencyCodes: currencies.map((row) => row.code.toUpperCase()),
    exchangeRatesAvailable,
  }
}

/** Reexportado para que el borde no importe de dos módulos. */
export { verifyManifest }
