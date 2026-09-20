/**
 * E11 · integración de las tres olas — **backup y restauración, formato 2.0**
 * (docs/design/E11-plataforma-saas.md §5, ADR-0019 **D2**, O-1 y O-2).
 *
 * **El bloque heredado de TaxHacker se ha ido.** Hasta esta ronda, la mitad
 * superior de este fichero era el backup de G-15: nueve tablas de las sesenta y
 * seis, ninguna contable, sin manifest, sin firma, con `preprocessRowData`
 * adivinando tipos —`!isNaN(Number(value))` convertía la cuenta `0400` en `400`—
 * y con un `catch` por fila que **sumaba igual a `insertedCount`**. Sobrevivía
 * «sólo mientras `app/(app)/settings/backups/**` lo consuma»; T22 ya no lo
 * consume, así que se retira, junto con `cleanupOrganizationTables`, que era el
 * único camino del código capaz de **borrar asientos contabilizados**.
 *
 * Las cuatro decisiones del sustituto:
 *
 *   1. **El inventario se DERIVA de `BACKUP_TENANT_MODELS`** (`backupInventory`), nunca
 *      se escribe a mano. Es lo que impide repetir BUG-E7-1, BUG-E9-5 y
 *      BUG-E10-1 por cuarta vez, y lo que comprueba I-E11-7.
 *   2. **Una sola fila rechazada ABORTA el trabajo entero**, con tabla, número de
 *      línea y motivo.
 *   3. **Restaurar es SIEMPRE a organización nueva.** La de origen no se toca,
 *      nunca; el usuario compara y decide.
 *   4. **`DONE` exige las SEIS comprobaciones de §5.4.** Si falta una,
 *      `DONE_UNVERIFIED` (O-2) con la organización conservada y marcada: borrarla
 *      sería destruir la evidencia.
 *
 * ## E12 · T14 — la deuda del ZIP en memoria, cerrada
 *
 * Hasta E12 el archivo se construía **entero en el heap** con
 * `JSZip.generateAsync({ type: "nodebuffer" })`. El propio fichero lo declaraba
 * como deuda con épica de cierre: *«un volcado de 2 GB no cabe en el heap de una
 * función serverless»*, y el techo 5 de §12 de E11 sólo pudo medirse
 * extrapolando.
 *
 * Ahora la emisión tiene **dos fases**, y ninguna materializa el archivo:
 *
 * 1. **Fase de volcado** (`planBackupArchive`), dentro de la transacción de
 *    tenant. Cada tabla se recorre **por cursor de clave** en lotes de
 *    `DUMP_BATCH_ROWS` filas y se escribe a un **carrete temporal** en disco,
 *    sellando el `sha256` al vuelo. Con eso se conoce todo lo que el manifest
 *    necesita —recuentos, sellos, numeración, ficheros y sus tamaños— sin haber
 *    tenido nunca más de un lote vivo. El manifest se firma aquí.
 * 2. **Fase de emisión** (`archiveChunks`), ya fuera de la transacción. El ZIP
 *    sale bloque a bloque por `lib/platform/zip-stream.ts` leyendo del carrete y
 *    **del almacén en streaming** para los documentos, y se sube por
 *    **multipart** (`putObjectStreaming`). El pico de memoria es el de una parte
 *    —8 MiB— y **no depende del volumen**, que es lo que el criterio 47 exige.
 *
 * `buildBackupArchive` sigue existiendo y devolviendo un `Buffer`: es el camino
 * de los tests y de las copias pequeñas, y está escrito **sobre el mismo plan**,
 * de modo que no puede divergir del que corre en producción.
 */

import JSZip from "jszip"
import { createHash, randomUUID } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { zipStream, type ZipEntry } from "@/lib/platform/zip-stream"
import { objectKey, storage } from "@/lib/storage"
import { BACKUP_TENANT_MODELS, prismaSchemaMeta, tenantTransaction, type TenantTransactionClient } from "@/lib/db"
import {
  BACKUP_FORMAT_VERSION,
  auditLogCanonicalSha256,
  csvChunkOf,
  csvColumnsOf,
  backupInventory,
  compareCounts,
  decodeRow,
  derivedSealColumns,
  encodeRow,
  isVerified,
  manifestSha256,
  numberingOf,
  restoreStatusOf,
  sealColumnSha256,
  signManifest,
  verifyManifest,
  type BackupManifest,
  type CheckResult,
  type RestoreVerification,
} from "@/lib/platform/backup"
import { computeLedgerHash } from "@/models/ledger"
import { currentGitSha } from "@/models/reports"
import { putObject, putObjectStreaming } from "@/models/storage"
import { backupConsumesQuota } from "@/lib/platform/limits"
import type { BackupTrigger, StoredObjectKind } from "@/prisma/client"

const sha256hex = (input: string | Buffer): string => createHash("sha256").update(input).digest("hex")

/** Versión del esquema que viaja en el manifest: la última migración aplicada. */
async function schemaVersionOf(tx: TenantTransactionClient): Promise<string> {
  const rows = await tx.$queryRaw<{ migration_name: string }[]>`
    SELECT migration_name FROM _prisma_migrations
     WHERE finished_at IS NOT NULL ORDER BY migration_name DESC LIMIT 1`
  return (rows[0]?.migration_name ?? "desconocida").slice(0, 16)
}

// ─────────────────────────────────────────────────────────────────────────────
// Sellos del contenido
// ─────────────────────────────────────────────────────────────────────────────

export type ContentSeals = { ledgerHash: string; analyticsKey: string; budgetHash: string | null }

/**
 * Los tres sellos, calculados **en la base** con la misma forma canónica en
 * origen y en destino. Es lo que hace comparables las dos organizaciones: si se
 * calcularan por caminos distintos, la comprobación 5 no probaría nada.
 *
 * `analyticsKey` reproduce `canonicalAnalyticsForm` de `lib/analytics/hash.ts`
 * —`(entryId, lineNo, proyecto, CECO, línea de negocio, tipo analítico)`, TSV,
 * `∅` para nulos, ordenado por `(entryId, lineNo)`— pero sobre las **claves
 * naturales** (códigos) y no los uuid: una restauración crea filas nuevas con
 * uuid nuevos, y un sello que dependiera de ellos no podría coincidir jamás.
 */
export async function computeContentSeals(tx: TenantTransactionClient): Promise<ContentSeals> {
  const organizationId = tx.$organizationId
  const ledgerHash = await computeLedgerHash(tx, {})

  const analytics = await tx.$queryRaw<{ hash: string }[]>`
    SELECT encode(sha256(convert_to(COALESCE(string_agg(fila, E'\n' ORDER BY entry_date, entry_number, line_no), ''), 'UTF8')), 'hex') AS hash
      FROM (
        SELECT l.entry_date, e.entry_number, l.line_no,
               concat_ws(E'\t',
                 to_char(l.entry_date, 'YYYY-MM-DD'),
                 e.entry_number::text,
                 l.line_no::text,
                 COALESCE(p.code, '_'),
                 COALESCE(cc.code, '_'),
                 COALESCE(bl.code, '_'),
                 COALESCE(l.analytic_type::text, '_')
               ) AS fila
          FROM journal_lines l
          JOIN journal_entries e ON e.id = l.entry_id AND e.organization_id = l.organization_id
          LEFT JOIN projects p       ON p.id  = l.project_id
          LEFT JOIN cost_centers cc  ON cc.id = l.cost_center_id
          LEFT JOIN business_lines bl ON bl.id = l.business_line_id
         WHERE l.organization_id = ${organizationId}::uuid
      ) AS canonico`

  const budget = await tx.$queryRaw<{ hash: string | null }[]>`
    SELECT encode(sha256(convert_to(COALESCE(string_agg(b.budget_hash, E'\n' ORDER BY b.budget_hash), ''), 'UTF8')), 'hex') AS hash
      FROM budgets b
     WHERE b.organization_id = ${organizationId}::uuid AND b.budget_hash IS NOT NULL`

  const budgetRows = await tx.budget.count({ where: { budgetHash: { not: null } } })

  return {
    ledgerHash,
    analyticsKey: analytics[0]?.hash ?? sha256hex(""),
    budgetHash: budgetRows === 0 ? null : (budget[0]?.hash ?? null),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Volcado
// ─────────────────────────────────────────────────────────────────────────────

type TableDump = {
  name: string
  rows: number
  jsonl: string
  sha256: string
  spoolPath: string
  /** **E12 · T20** — la segunda representación. `null` cuando la tabla va vacía. */
  csv: { path: string; sha256: string; spoolPath: string } | null
}

/** Nombre de la columna de tenant. Se quita del volcado: lo inyecta el destino. */
const TENANT_COLUMN = "organization_id"

/**
 * Filas por lote del volcado. Con 150 000 líneas de diario, 2 000 lotes de 2 000
 * filas: ni una consulta por fila (que sería N+1 sobre la tabla más grande del
 * sistema) ni la tabla entera en memoria (que es la deuda que se cierra).
 */
const DUMP_BATCH_ROWS = 2_000

/**
 * Vuelca una tabla al carrete, **por cursor de clave**, sellando al vuelo.
 *
 * `ORDER BY id` + `id > $cursor` y no `OFFSET`: el desplazamiento hace que la
 * base recorra otra vez todo lo ya leído en cada lote, y con 150 000 filas eso
 * es cuadrático. El orden es el mismo que el del volcado anterior, así que el
 * `sha256` de una tabla que no ha cambiado **es el mismo** que antes de T14: el
 * formato no se mueve, sólo la manera de producirlo.
 *
 * El cuerpo es exactamente el de siempre —una línea por fila, separadas por
 * `\n`, **sin salto final**—, porque la restauración cuenta líneas y las
 * enfrenta al manifest.
 */
async function dumpTable(tx: TenantTransactionClient, table: string, spoolDir: string): Promise<TableDump> {
  const spoolPath = path.join(spoolDir, `${table}.jsonl`)
  const csvSpoolPath = path.join(spoolDir, `${table}.csv`)
  const salida = createWriteStream(spoolPath)
  const salidaCsv = createWriteStream(csvSpoolPath)
  const hash = createHash("sha256")
  const hashCsv = createHash("sha256")
  let columnas: string[] | null = null
  let rows = 0
  let cursor: string | number | bigint | null = null
  let fallo: Error | null = null
  salida.on("error", (error: Error) => {
    fallo = error
  })

  const escribir = async (texto: string): Promise<void> => {
    if (fallo) throw fallo
    hash.update(texto)
    // Contrapresión de verdad: sin esperar al `drain`, el carrete se llenaría en
    // el búfer del stream y volveríamos a tener la tabla entera en memoria.
    if (!salida.write(texto)) {
      await new Promise<void>((resolve, reject) => {
        // Los dos oyentes se retiran al resolver: registrar un par por lote
        // sobre 2 000 lotes agota el límite de `EventEmitter` y Node lo avisa
        // por consola como si fuera una fuga — porque lo sería.
        const alDrenar = () => {
          salida.off("error", alFallar)
          resolve()
        }
        const alFallar = (error: Error) => {
          salida.off("drain", alDrenar)
          reject(error)
        }
        salida.once("drain", alDrenar)
        salida.once("error", alFallar)
      })
    }
  }

  /**
   * **E12 · T20** — la representación CSV se escribe **en el mismo recorrido**.
   * Volcar la tabla dos veces para producir dos formatos sería pagar el doble
   * por el mismo dato, y con 150 000 líneas eso se nota.
   */
  const escribirCsv = (texto: string): void => {
    hashCsv.update(texto)
    salidaCsv.write(texto)
  }

  try {
    for (;;) {
      const lote: Record<string, unknown>[] = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
        cursor === null
          ? `SELECT * FROM "${table}" WHERE ${TENANT_COLUMN} = $1::uuid ORDER BY id LIMIT ${DUMP_BATCH_ROWS}`
          : `SELECT * FROM "${table}" WHERE ${TENANT_COLUMN} = $1::uuid AND id > $2 ORDER BY id LIMIT ${DUMP_BATCH_ROWS}`,
        ...(cursor === null ? [tx.$organizationId] : [tx.$organizationId, cursor])
      )
      if (lote.length === 0) break
      for (const row of lote) {
        const copy = { ...row }
        // **`organization_id` no se vuelca**: así un backup no puede aterrizar
        // en otra organización por accidente. Lo inyecta `tenantDb` al restaurar.
        delete copy[TENANT_COLUMN]
        const linea = encodeRow(copy)
        await escribir(rows === 0 ? linea : `\n${linea}`)
        if (columnas === null) {
          columnas = csvColumnsOf(linea)
          escribirCsv(columnas.join(","))
        }
        escribirCsv(`\n${csvChunkOf([linea], columnas)}`)
        rows += 1
      }
      const ultimo = lote[lote.length - 1].id
      if (typeof ultimo !== "string" && typeof ultimo !== "number" && typeof ultimo !== "bigint") {
        throw new Error(`dumpTable: la tabla ${table} no tiene un id con el que pasar página (${typeof ultimo})`)
      }
      cursor = ultimo
      if (lote.length < DUMP_BATCH_ROWS) break
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      salida.end((error?: Error | null) => (error ? reject(error) : resolve()))
    )
    await new Promise<void>((resolve, reject) =>
      salidaCsv.end((error?: Error | null) => (error ? reject(error) : resolve()))
    )
  }

  return {
    name: table,
    rows,
    jsonl: `data/${table}.jsonl`,
    sha256: hash.digest("hex"),
    spoolPath,
    // Una tabla vacía no produce CSV: un fichero con cero bytes y sin cabecera
    // no aporta nada y ensucia el listado del archivo.
    csv: rows === 0 ? null : { path: `csv/${table}.csv`, sha256: hashCsv.digest("hex"), spoolPath: csvSpoolPath },
  }
}

/**
 * **O-1.5** — `exchange_rates` es tabla GLOBAL: no está en el inventario y por
 * tanto **no saldría en el backup**. Sin ella el destino no reproduce
 * `convertedTotal` (I-E8-5). Se vuelcan **sólo las referenciadas** por lo que se
 * ha volcado, y las referencias se descubren del propio esquema: cualquier
 * columna que se llame `exchange_rate_id`.
 */
async function dumpReferencedExchangeRates(
  tx: TenantTransactionClient
): Promise<{ rows: number; sha256: string; body: string }> {
  const meta = prismaSchemaMeta()
  const referencing = meta
    .filter((model) => BACKUP_TENANT_MODELS.has(model.model))
    .flatMap((model) => model.columns.filter((c) => c.column === "exchange_rate_id").map(() => model.table))

  const ids = new Set<string>()
  for (const table of referencing) {
    const found = await tx.$queryRawUnsafe<{ exchange_rate_id: string | null }[]>(
      `SELECT DISTINCT exchange_rate_id FROM "${table}" WHERE ${TENANT_COLUMN} = $1::uuid AND exchange_rate_id IS NOT NULL`,
      tx.$organizationId
    )
    for (const row of found) if (row.exchange_rate_id) ids.add(row.exchange_rate_id)
  }

  if (ids.size === 0) return { rows: 0, sha256: sha256hex(""), body: "" }
  const rates = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT * FROM "exchange_rates" WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [...ids]
  )
  const body = rates.map((row) => encodeRow(row)).join("\n")
  return { rows: rates.length, sha256: sha256hex(body), body }
}

/** Numeración por ejercicio: huecos y duplicados, que los hashes no cubren (O-1.2). */
async function dumpNumbering(tx: TenantTransactionClient): Promise<BackupManifest["numbering"]> {
  const years = await tx.fiscalYear.findMany({ orderBy: { startDate: "asc" } })
  const out: BackupManifest["numbering"] = []
  for (const year of years) {
    const rows = await tx.journalEntry.findMany({
      where: { fiscalYearId: year.id },
      select: { entryNumber: true },
    })
    const numbering = numberingOf(rows.map((row) => row.entryNumber))
    out.push({
      fiscalYearId: year.id,
      fiscalYearCode: year.code,
      maxEntryNumber: numbering.max,
      count: numbering.count,
      gaps: numbering.gaps,
      duplicates: numbering.duplicates,
    })
  }
  return out
}

/** **O-1.3** — el sha256 de cada columna-sello, sobre la lista derivada del código. */
async function dumpDerivedSeals(
  tx: TenantTransactionClient,
  tables: readonly string[]
): Promise<BackupManifest["derivedSeals"]> {
  const wanted = new Set(tables)
  const out: BackupManifest["derivedSeals"] = []
  for (const { table, column } of derivedSealColumns(prismaSchemaMeta())) {
    if (!wanted.has(table)) continue
    const rows = await tx.$queryRawUnsafe<{ v: string | null }[]>(
      `SELECT "${column}" AS v FROM "${table}" WHERE ${TENANT_COLUMN} = $1::uuid`,
      tx.$organizationId
    )
    out.push({ table, column, rows: rows.length, sha256: sealColumnSha256(rows.map((row) => row.v)) })
  }
  return out
}

/** **O-1.4** — quién forzó qué y con qué motivo. Sin esto se pierde. */
async function dumpAuditLog(tx: TenantTransactionClient): Promise<{ rows: number; canonicalSha256: string }> {
  const rows = await tx.auditLog.findMany({
    select: { entity: true, entityId: true, action: true, reason: true, ts: true },
  })
  return { rows: rows.length, canonicalSha256: auditLogCanonicalSha256(rows) }
}

async function dumpClosing(tx: TenantTransactionClient): Promise<BackupManifest["closing"]> {
  const years = await tx.fiscalYear.findMany({ orderBy: { startDate: "asc" } })
  const closingRuns = await tx.closingRun.count()
  return {
    fiscalYears: years.map((year) => ({
      code: year.code,
      status: year.status,
      closedAt: year.closedAt ? year.closedAt.toISOString() : null,
    })),
    closingRuns,
  }
}

export type BackupResult = {
  manifest: BackupManifest
  manifestSha: string
  signature: string
  archive: Buffer
}

/**
 * **El plan de emisión (E12 · T14).** Lo que la fase de volcado deja listo: el
 * manifest ya firmado y una manera de producir los bloques del ZIP **sin
 * materializarlo**. Quien lo reciba decide si los concatena (tests, copias
 * pequeñas) o si los empuja a una subida multipart (producción).
 *
 * `cleanup()` borra el carrete. Se llama SIEMPRE, también cuando la emisión
 * falla: un carrete huérfano de 1,5 GB en `/tmp` deja sin disco al siguiente.
 */
export type BackupPlan = {
  manifest: BackupManifest
  manifestSha: string
  signature: string
  /** Los bloques del archivo, en orden. Se puede consumir **una sola vez**. */
  archiveChunks: () => AsyncGenerator<Buffer>
  cleanup: () => Promise<void>
}

export type BuildBackupOptions = {
  refDate: Date
  signingKey: Buffer
  signingKeyId: string
  /** Bytes de cada `File`. Se inyecta para poder probar sin almacén de red. */
  readFileBytes?: (file: { id: string; sha256: string; path: string }) => Promise<Buffer | null>
  /**
   * **Auditor H-6** — el barrido en el ORIGEN, que viaja en el manifest para que
   * la comprobación 6 pueda ser *relativa*. Se inyecta igual que el de
   * `verifyRestore`; por defecto es el mismo `runLedgerInvariants` con
   * `audit: true`.
   */
  sweep?: (
    tx: TenantTransactionClient,
    refDate: Date
  ) => Promise<{ families: number; failed: string[]; checksHash: string }>
}

/**
 * **Fase 1 · el volcado** (E12 · T14). Produce el manifest firmado y deja el
 * contenido en un carrete temporal, listo para emitirse en streaming.
 *
 * **Los sellos se calculan al principio y se recalculan al final.** Si difieren,
 * el diario cambió durante el volcado: se falla con `LEDGER_MOVED_DURING_BACKUP`
 * y se reencola. *Un backup de un estado que nunca existió es peor que no tener
 * backup.*
 */
export async function planBackupArchive(organizationId: string, options: BuildBackupOptions): Promise<BackupPlan> {
  const spoolDir = await mkdtemp(path.join(tmpdir(), `erp-backup-${organizationId.slice(0, 8)}-`))
  const cleanup = async (): Promise<void> => {
    await rm(spoolDir, { recursive: true, force: true })
  }

  try {
    return await tenantTransaction(
      organizationId,
      async (tx) => {
        const meta = prismaSchemaMeta()
        /**
         * **Auditor H-2.** El inventario se deriva de `BACKUP_TENANT_MODELS`
         * —`TENANT_MODELS` ∪ `TENANT_MODELS_WITH_GLOBAL`—, no de `TENANT_MODELS` a
         * secas. Con lo segundo `currencies` (177 filas por organización, con
         * `organization_id` y RLS propia) no viajaba en el ZIP y se perdía en cada
         * restauración **con las seis comprobaciones en PASS**.
         */
        const inventory = backupInventory(BACKUP_TENANT_MODELS, meta)
        const sealsBefore = await computeContentSeals(tx)

        const organization = await tx.organization.findFirst({ where: { id: organizationId } })
        if (!organization) throw new Error(`organización desconocida: ${organizationId}`)

        const dumps: TableDump[] = []
        for (const table of inventory) dumps.push(await dumpTable(tx, table, spoolDir))

        const exchangeRates = await dumpReferencedExchangeRates(tx)
        const numbering = await dumpNumbering(tx)
        const series = await tx.invoiceSeries.findMany({ orderBy: { code: "asc" } })
        const derivedSeals = await dumpDerivedSeals(tx, inventory)
        const auditLog = await dumpAuditLog(tx)
        const closing = await dumpClosing(tx)

        /**
         * Ficheros: se guardan bajo `files/<sha[0:2]>/<sha>` y **sus bytes no se
         * leen aquí**. Lo que hace falta para el manifest es el tamaño, y eso lo
         * da un `head()` del almacén sin descargar nada — la diferencia entre
         * mantener 1,5 GB vivos y no mantenerlos.
         *
         * Un `File` sin bytes NO se calla: entra en el manifest con tamaño -1 y la
         * comprobación 6 lo enseña. La **verificación** del sha256 de cada
         * documento sigue haciéndose, pero al copiarlo al ZIP (fase 2), que es el
         * único momento en que sus bytes pasan por aquí; si no cuadra, la emisión
         * aborta y la subida multipart se cancela.
         */
        const files = await tx.file.findMany({ select: { id: true, sha256: true, path: true } })
        const readBytes = options.readFileBytes
        const fileEntries: BackupManifest["files"] = []
        const fileSources = new Map<string, { id: string; path: string; sizeBytes: number }>()
        for (const file of files) {
          if (fileSources.has(file.sha256)) continue
          const sizeBytes = readBytes
            ? ((await readBytes(file))?.length ?? -1)
            : await documentSizeBytes(organizationId, file.sha256)
          fileEntries.push({
            path: `files/${file.sha256.slice(0, 2)}/${file.sha256}`,
            sha256: file.sha256,
            sizeBytes,
          })
          if (sizeBytes >= 0) fileSources.set(file.sha256, { id: file.id, path: file.path, sizeBytes })
        }

        const sealsAfter = await computeContentSeals(tx)
        if (
          sealsAfter.ledgerHash !== sealsBefore.ledgerHash ||
          sealsAfter.analyticsKey !== sealsBefore.analyticsKey ||
          sealsAfter.budgetHash !== sealsBefore.budgetHash
        ) {
          throw new Error("LEDGER_MOVED_DURING_BACKUP")
        }

        /**
         * El barrido del ORIGEN, con la MISMA `refDate` que usará la
         * verificación. Sin esta foto, una restauración fiel de una organización
         * que ya tenía un FAIL se marcaba `DONE_UNVERIFIED` (H-6).
         */
        const sourceSweep = await (options.sweep ?? defaultInvariantSweep)(tx, options.refDate)

        const manifest: BackupManifest = {
          formatVersion: BACKUP_FORMAT_VERSION,
          schemaVersion: await schemaVersionOf(tx),
          gitSha: currentGitSha().slice(0, 40),
          organization: {
            id: organization.id,
            slug: organization.slug,
            baseCurrency: organization.baseCurrency,
            timezone: organization.timezone,
            pgcVariant: organization.pgcVariant,
          },
          createdAt: options.refDate.toISOString(),
          seals: sealsAfter,
          numbering,
          invoiceSeries: series.map((row) => ({ code: row.code, kind: row.kind, lastNumber: row.nextNumber - 1 })),
          derivedSeals,
          auditLog,
          tables: dumps.map(({ name, rows, jsonl, sha256 }) => ({ name, rows, jsonl, sha256 })),
          /**
           * **T20** — el manifest sella las DOS representaciones. El JSONL manda:
           * la restauración no mira el CSV jamás (§ `BackupManifest.csv`).
           */
          csv: dumps
            .filter((dump): dump is TableDump & { csv: NonNullable<TableDump["csv"]> } => dump.csv !== null)
            .map((dump) => ({ name: dump.name, rows: dump.rows, path: dump.csv.path, sha256: dump.csv.sha256 })),
          globalRefs: { exchangeRates: { rows: exchangeRates.rows, sha256: exchangeRates.sha256 } },
          files: fileEntries,
          closing,
          sourceSweep,
          totals: {
            tables: dumps.length,
            rows: dumps.reduce((sum, dump) => sum + dump.rows, 0),
            files: fileEntries.length,
            bytes: fileEntries.reduce((sum, entry) => sum + Math.max(entry.sizeBytes, 0), 0),
          },
        }

        const manifestSha = manifestSha256(manifest)
        const signature = signManifest(manifestSha, options.signingKey, options.signingKeyId)

        /**
         * **El orden de las entradas del ZIP no es cosmético.** `manifest.json`,
         * su `sha256` y la firma van **primero** para que un lector en streaming
         * pueda verificarlos *antes de descomprimir un byte* (§5.4.2), que es la
         * regla que sostiene «una firma ajena no se descomprime». Después los
         * datos, y al final los documentos, que son la parte pesada.
         */
        const seals = JSON.stringify(
          { seals: sealsAfter, numbering, invoiceSeries: manifest.invoiceSeries, derivedSeals, auditLog, closing },
          null,
          2
        )
        const leerDocumento = readBytes
          ? async function* (sha: string, id: string, ruta: string) {
              const bytes = await readBytes({ id, sha256: sha, path: ruta })
              if (bytes) yield bytes
            }
          : documentChunks(organizationId)

        const archiveChunks = async function* (): AsyncGenerator<Buffer> {
          const entradas = async function* (): AsyncIterable<ZipEntry> {
            yield { name: "manifest.json", source: Buffer.from(JSON.stringify(manifest, null, 2), "utf8") }
            yield { name: "manifest.sha256", source: Buffer.from(manifestSha, "utf8") }
            yield { name: "signature.txt", source: Buffer.from(signature, "utf8") }
            yield { name: "README.txt", source: Buffer.from(README_ES, "utf8") }
            for (const dump of dumps) {
              yield { name: dump.jsonl, source: () => spoolChunks(dump.spoolPath) }
            }
            for (const dump of dumps) {
              if (dump.csv) yield { name: dump.csv.path, source: () => spoolChunks(dump.csv!.spoolPath) }
            }
            yield { name: "global/exchange_rates.jsonl", source: Buffer.from(exchangeRates.body, "utf8") }
            yield { name: "seals.json", source: Buffer.from(seals, "utf8") }
            for (const [sha, origen] of fileSources) {
              yield {
                name: `files/${sha.slice(0, 2)}/${sha}`,
                // **`STORE`**: un PDF o un JPEG ya vienen comprimidos, y volver a
                // pasarlos por DEFLATE cuesta el 100 % de la CPU para ganar el
                // 0 % del tamaño. Con 1,5 GB de documentos, esa decisión es la
                // diferencia entre entrar y no entrar en el techo de 15 minutos.
                method: "STORE",
                source: () => verificando(sha, leerDocumento(sha, origen.id, origen.path)),
              }
            }
          }
          yield* zipStream(entradas())
        }

        return { manifest, manifestSha, signature, archiveChunks, cleanup }
      },
      { timeout: 600_000, maxWait: 15_000 }
    )
  } catch (error) {
    await cleanup()
    throw error
  }
}

/**
 * Produce el ZIP 2.0 completo **en un `Buffer`**.
 *
 * Es el camino de los tests y de las copias pequeñas, y está escrito **sobre el
 * mismo plan** que usa producción: no hay dos generadores que puedan divergir.
 * Para una organización con volumen real, el llamante es `runBackupJob`, que
 * consume el plan en streaming y nunca llega aquí.
 */
export async function buildBackupArchive(organizationId: string, options: BuildBackupOptions): Promise<BackupResult> {
  const plan = await planBackupArchive(organizationId, options)
  try {
    const chunks: Buffer[] = []
    for await (const chunk of plan.archiveChunks()) chunks.push(chunk)
    return {
      manifest: plan.manifest,
      manifestSha: plan.manifestSha,
      signature: plan.signature,
      archive: Buffer.concat(chunks),
    }
  } finally {
    await plan.cleanup()
  }
}

/** Bloques de un fichero del carrete. 64 KB: contrapresión sin sobrecarga. */
async function* spoolChunks(spoolPath: string): AsyncIterable<Buffer> {
  for await (const chunk of createReadStream(spoolPath, { highWaterMark: 64 * 1024 })) {
    yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
  }
}

/**
 * **El sha256 del documento se comprueba mientras se copia** al ZIP. Es el único
 * momento en que sus bytes pasan por el proceso, así que verificar aquí no
 * cuesta ni una lectura más — y no verificar dejaría entrar al archivo unos
 * bytes que el registro no reconoce, que es I-E8-2 al revés.
 */
async function* verificando(sha256: string, source: AsyncIterable<Buffer>): AsyncIterable<Buffer> {
  const hash = createHash("sha256")
  for await (const chunk of source) {
    hash.update(chunk)
    yield chunk
  }
  const actual = hash.digest("hex")
  if (actual !== sha256) {
    throw new Error(`el documento ${sha256} tiene sha256 ${actual} en el almacén: el archivo NO se emite`)
  }
}

/** Tamaño de un documento sin descargarlo: `head()` del almacén. -1 si no está. */
async function documentSizeBytes(organizationId: string, sha256: string): Promise<number> {
  try {
    const { driver, prefix } = storage()
    const head = await driver.head(objectKey({ prefix, organizationId, kind: "DOCUMENT", sha256 }))
    return head ? Number(head.sizeBytes) : -1
  } catch {
    return -1
  }
}

/** Los bytes de un documento, **en streaming** desde el almacén. */
function documentChunks(organizationId: string) {
  return async function* (sha256: string, _id: string, _path: string): AsyncIterable<Buffer> {
    const { driver, prefix } = storage()
    const stream = await driver.get(objectKey({ prefix, organizationId, kind: "DOCUMENT", sha256 }))
    for await (const chunk of stream) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
  }
}

const README_ES = `COPIA COMPLETA DE TUS LIBROS — formato 2.0

Este archivo contiene TODOS los datos de tu organización en el ERP: el libro
diario completo, la analítica, los presupuestos, los documentos originales con su
sha256 y el registro de auditoría.

  manifest.json    Inventario firmado: tablas, recuentos, sellos y sha256 de cada
                   parte. Se verifica ANTES de descomprimir nada.
  signature.txt    Firma HMAC-SHA256 del manifest, con el identificador de clave.
  data/*.jsonl     Una fila por línea, con los tipos declarados explícitamente.
                   ES LA FUENTE: la restauración lee de aquí y de ningún otro sitio.
  csv/*.csv        Los mismos datos en CSV, para abrirlos en una hoja de cálculo
                   o llevártelos a otro programa. Es una SEGUNDA representación:
                   el CSV no distingue la cuenta "0400" del número 400, no tiene
                   nulos ni binarios, y por eso NO se restaura desde él. El
                   manifest sella los dos; si discrepan, manda el JSONL.
  global/          Tasas de cambio referenciadas (son datos públicos del BCE).
  files/           Los documentos, nombrados por su sha256.
  seals.json       Sellos, numeración por ejercicio, series y estado del cierre.

CÓMO SE RESTAURA. Desde Configuración → Copias de seguridad, subiendo este ZIP.
La restauración crea SIEMPRE una organización NUEVA y verifica seis cosas antes
de darla por buena: recuentos, numeración sin huecos, sellos derivados, registro
de auditoría, sellos de contenido con el estado del cierre y el barrido completo
de invariantes. Si alguna falla, la organización se conserva y se marca como NO
VERIFICADA: no se borra nada.

CONSERVACIÓN. El art. 30 del Código de Comercio (seis años; diez con bases
imponibles negativas, art. 26.5 LIS) obliga sobre los LIBROS y los
JUSTIFICANTES, que viven en la base de datos y en el almacén de documentos. NO
obliga sobre estos ZIP: que una copia caduque no significa que se haya destruido
documentación.
`

// ─────────────────────────────────────────────────────────────────────────────
// Restauración — SIEMPRE a organización nueva (§5.4)
// ─────────────────────────────────────────────────────────────────────────────

/** Número de línea del archivo, oculto en la fila para el mensaje de rechazo. */
const LINE_NUMBER = Symbol("lineNumber")

export class RestoreAbort extends Error {
  constructor(
    readonly table: string,
    readonly line: number,
    readonly motivo: string
  ) {
    super(`fila rechazada en ${table}, línea ${line}: ${motivo}`)
    this.name = "RestoreAbort"
  }
}

/**
 * Orden de inserción **derivado de las FK reales de la base**, no de una lista
 * que alguien tenga que mantener. Un ciclo (autorreferencia, como
 * `journal_entries.reverses_entry_id`) no rompe el orden: las autorreferencias
 * se ignoran para el grafo y la FK se satisface porque el padre va en el mismo
 * lote, insertado antes por el `ORDER BY id` del volcado… y si no, la fila se
 * rechaza y el trabajo aborta, que es lo correcto.
 */
export async function restoreOrder(tx: TenantTransactionClient, tables: readonly string[]): Promise<string[]> {
  const edges = await tx.$queryRaw<{ child: string; parent: string }[]>`
    SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
      FROM pg_constraint c
     WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`
  const wanted = new Set(tables)
  const parents = new Map<string, Set<string>>(tables.map((t) => [t, new Set<string>()]))
  for (const edge of edges) {
    const child = edge.child.replace(/^public\./, "").replace(/"/g, "")
    const parent = edge.parent.replace(/^public\./, "").replace(/"/g, "")
    if (child === parent) continue
    if (!wanted.has(child) || !wanted.has(parent)) continue
    parents.get(child)!.add(parent)
  }
  const out: string[] = []
  const done = new Set<string>()
  // Kahn con desempate alfabético: el orden es DETERMINISTA, que es lo que hace
  // reproducible una restauración y comparable un fallo entre dos ejecuciones.
  while (out.length < tables.length) {
    const ready = [...wanted].filter((t) => !done.has(t) && [...parents.get(t)!].every((p) => done.has(p))).sort()
    if (ready.length === 0) {
      // Ciclo entre tablas distintas: se rompe por orden alfabético y se avisa.
      const rest = [...wanted].filter((t) => !done.has(t)).sort()
      for (const t of rest) {
        out.push(t)
        done.add(t)
      }
      break
    }
    for (const t of ready) {
      out.push(t)
      done.add(t)
    }
  }
  return out
}

/**
 * FK **de una tabla consigo misma** (`accounts.parent_code`,
 * `journal_entries.reverses_entry_id`, `budgets.superseded_by_id`…). El volcado
 * sale ordenado por `id`, que no tiene por qué respetar la jerarquía, así que
 * las filas de esas tablas se reordenan antes de insertar: el padre primero.
 *
 * Se leen de `pg_constraint`, no de una lista: una autorreferencia nueva en la
 * épica 68 se respeta sola.
 */
export type SelfReference = { from: string[]; to: string[] }

/**
 * Columnas que son **FK de verdad**, leídas de `pg_constraint`. La reasignación
 * de identificadores se limita a ellas y a `id`: remapear por el nombre de la
 * columna («acaba en `_id`, luego es una referencia») sería adivinar, que es
 * justo lo que este formato no hace. `audit_logs.entity_id`, por ejemplo, es un
 * varchar libre y **no** se toca: el libro de auditoría cuenta lo que pasó en la
 * organización de ORIGEN, y la restaurada es una copia, no su continuación.
 */
export async function foreignKeyColumns(tx: TenantTransactionClient): Promise<Map<string, Set<string>>> {
  const rows = await tx.$queryRaw<{ table_name: string; column_name: string }[]>`
    SELECT c.conrelid::regclass::text AS table_name, a.attname::text AS column_name
      FROM pg_constraint c
      JOIN unnest(c.conkey) AS k(attnum) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
     WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`
  const out = new Map<string, Set<string>>()
  for (const row of rows) {
    const table = row.table_name.replace(/^public\./, "").replace(/"/g, "")
    const set = out.get(table) ?? new Set<string>()
    set.add(row.column_name)
    out.set(table, set)
  }
  return out
}

export async function selfReferences(tx: TenantTransactionClient): Promise<Map<string, SelfReference[]>> {
  const rows = await tx.$queryRaw<{ table_name: string; from_cols: string[]; to_cols: string[] }[]>`
    SELECT c.conrelid::regclass::text AS table_name,
           (SELECT array_agg(a.attname::text ORDER BY x.ord)
              FROM unnest(c.conkey) WITH ORDINALITY AS x(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = x.attnum) AS from_cols,
           (SELECT array_agg(a.attname::text ORDER BY x.ord)
              FROM unnest(c.confkey) WITH ORDINALITY AS x(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = x.attnum) AS to_cols
      FROM pg_constraint c
     WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace AND c.conrelid = c.confrelid`
  const out = new Map<string, SelfReference[]>()
  for (const row of rows) {
    const table = row.table_name.replace(/^public\./, "").replace(/"/g, "")
    const list = out.get(table) ?? []
    list.push({ from: row.from_cols, to: row.to_cols })
    out.set(table, list)
  }
  return out
}

/**
 * Orden topológico de las filas de UNA tabla con autorreferencias. Una fila
 * cuyo padre no esté en el archivo (o sea nulo) va primero; un ciclo —que el
 * esquema no admite pero la aritmética sí— se rompe por orden estable y la FK
 * decidirá, que es lo correcto: si de verdad no cuadra, la fila se rechaza y el
 * trabajo aborta.
 */
export function sortRowsBySelfReference(
  rows: readonly Record<string, unknown>[],
  refs: readonly SelfReference[]
): Record<string, unknown>[] {
  if (refs.length === 0) return [...rows]
  const keyOf = (row: Record<string, unknown>, columns: string[]): string | null => {
    const parts = columns.map((column) => row[column])
    if (parts.some((part) => part === null || part === undefined)) return null
    return parts.map((part) => String(part)).join("\u0000")
  }
  const present = new Map<string, number>()
  rows.forEach((row, index) => {
    for (const ref of refs) {
      const key = keyOf(row, ref.to)
      if (key !== null) present.set(`${ref.to.join(",")}|${key}`, index)
    }
  })
  const out: Record<string, unknown>[] = []
  const state = new Array<0 | 1 | 2>(rows.length).fill(0)
  const visit = (index: number): void => {
    if (state[index] !== 0) return
    state[index] = 1
    for (const ref of refs) {
      const parentKey = keyOf(rows[index], ref.from)
      if (parentKey === null) continue
      const parent = present.get(`${ref.to.join(",")}|${parentKey}`)
      if (parent !== undefined && parent !== index && state[parent] === 0) visit(parent)
    }
    state[index] = 2
    out.push(rows[index])
  }
  for (let index = 0; index < rows.length; index += 1) visit(index)
  return out
}

/**
 * **Credenciales con unicidad GLOBAL: se reemiten, no se copian** (integración
 * de las tres olas).
 *
 * `invitations.token_hash` lleva un `UNIQUE` sin `organization_id` —es un
 * secreto, y un secreto es único en toda la instalación, no por tenant—. Al
 * restaurar, la fila del archivo choca con la del origen, que **sigue viva**
 * porque D2.4 exige no tocarla: la restauración entera abortaba con `23505` por
 * una invitación pendiente.
 *
 * Copiar el hash tampoco valdría, y ése es el fondo del asunto: significaría que
 * **un mismo enlace de invitación da acceso a dos organizaciones distintas**. Se
 * reemite, así que la invitación llega al destino con su estado y su destinatario
 * —el dato contable-organizativo se conserva— pero **el enlace viejo no abre la
 * copia**. Quien la administre reenvía la invitación, que es lo correcto.
 *
 * Es una lista cerrada y corta a propósito: cualquier otra colisión sigue
 * abortando el trabajo con tabla, línea y motivo (D2.5).
 */
function reissueGlobalSecrets(table: string, row: Record<string, unknown>): void {
  if (table !== "invitations") return
  if (!("token_hash" in row)) return
  row.token_hash = createHash("sha256").update(`restore:${randomUUID()}`).digest("hex")
}

/**
 * **E12 · T16 (deuda 7) — la clave del objeto se REDERIVA en el destino.**
 *
 * `stored_objects.object_key` es `<prefijo>/<organizationId>/<kind>/<sha[0:2]>/<sha>`
 * y viaja en el ZIP con el `organizationId` **del ORIGEN**. Hasta esta épica la
 * restauración la copiaba tal cual, de modo que la copia quedaba con filas que
 * apuntaban al prefijo de otra organización: `assertKeyBelongsTo` —la segunda
 * barrera del almacén— habría lanzado en la primera lectura, y la comprobación 6
 * no lo veía porque era «relativa tolerante». Los BYTES sí se reescribían bien
 * (los sube `putObject` con la clave del destino), así que la fila y los bytes
 * se contradecían y nadie lo decía.
 *
 * Aquí se rederiva con la organización de destino y el prefijo del entorno, que
 * además puede ser **otro** —restaurar de un entorno a otro es el caso normal de
 * una copia—. Lo que no se toca es el `sha256`: es el contenido, y el contenido
 * es el mismo.
 */
function rederiveStoredObjectKey(table: string, row: Record<string, unknown>, targetOrganizationId: string): void {
  if (table !== "stored_objects") return
  const sha256 = row.sha256
  const kind = row.kind
  if (typeof sha256 !== "string" || typeof kind !== "string") return
  row.object_key = objectKey({
    prefix: storage().prefix,
    organizationId: targetOrganizationId,
    kind: kind as StoredObjectKind,
    sha256,
  })
}

export type RestoreOptions = {
  archive: Buffer
  targetOrganizationId: string
  backupJobId?: string | null
  requestedById?: string | null
  refDate: Date
  /** Claves de firma conocidas, por `keyId`. Una firma sin clave es un rechazo. */
  keys: ReadonlyMap<string, Buffer>
  /**
   * **E12 · T16 · G-15b** — autorización EXPLÍCITA y REGISTRADA del operador
   * para restaurar un ZIP **ajeno**: uno firmado con una clave que esta
   * instalación no conoce (criterio 33 de E11).
   *
   * Sólo levanta `CLAVE_DESCONOCIDA`. **No levanta `SHA_DISCORDANTE` ni
   * `FORMATO_NO_SOPORTADO`**, y ésa es la línea: una clave desconocida significa
   * «esto lo firmó otro», que es un hecho legítimo cuando un cliente trae su
   * copia de otra instalación; un sha que no cuadra significa «esto se ha
   * tocado», y eso no lo autoriza nadie.
   */
  allowForeignSignature?: { authorizedBy: string; reason: string }
  /** Escribe los bytes restaurados. Por defecto, el almacén configurado. */
  writeFileBytes?: (sha256: string, bytes: Buffer) => Promise<void>
}

/**
 * **E12 · T16 · G-15b — la inspección PREVIA, antes de descomprimir un byte.**
 *
 * Lee del archivo **sólo** las tres entradas pequeñas —`manifest.json`, su sha y
 * la firma— y dictamina. Ninguna entrada de datos ni un solo documento se
 * descomprime aquí: si el ZIP es ajeno o está alterado, sus bytes no llegan a
 * tocarse, que es lo que §5.4.2 exige y lo que convierte la pantalla de subida
 * en algo que se puede ofrecer a un cliente.
 *
 * Devuelve también el `schemaVersion`, que es lo que la pantalla enseña antes de
 * preguntar si se sigue adelante.
 */
export type InspectRejection =
  "ARCHIVO_INCOMPLETO" | "FORMATO_NO_SOPORTADO" | "SHA_DISCORDANTE" | "FIRMA_INVALIDA" | "CLAVE_DESCONOCIDA"

export type InspectResult =
  | { ok: true; manifest: BackupManifest; manifestSha: string; signature: string; keyId: string }
  | { ok: false; reason: InspectRejection; detail: string; manifest: BackupManifest | null }

export async function inspectBackupArchive(archive: Buffer, keys: ReadonlyMap<string, Buffer>): Promise<InspectResult> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(archive)
  } catch (error) {
    return {
      ok: false,
      reason: "ARCHIVO_INCOMPLETO",
      detail: error instanceof Error ? error.message : "ilegible",
      manifest: null,
    }
  }

  const manifestRaw = await zip.file("manifest.json")?.async("string")
  const declaredSha = (await zip.file("manifest.sha256")?.async("string"))?.trim()
  const signature = (await zip.file("signature.txt")?.async("string"))?.trim()
  if (!manifestRaw || !declaredSha || !signature) {
    return {
      ok: false,
      reason: "ARCHIVO_INCOMPLETO",
      detail: "el archivo no lleva manifest, sha o firma",
      manifest: null,
    }
  }

  let manifest: BackupManifest
  try {
    manifest = JSON.parse(manifestRaw) as BackupManifest
  } catch {
    return { ok: false, reason: "ARCHIVO_INCOMPLETO", detail: "el manifest no es JSON válido", manifest: null }
  }

  const verdict = verifyManifest(manifest, declaredSha, signature, keys)
  if (!verdict.ok) return { ok: false, reason: verdict.reason, detail: verdict.detail, manifest }
  return { ok: true, manifest, manifestSha: declaredSha, signature, keyId: verdict.keyId }
}

export type RestoreOutcome = {
  status: "DONE" | "DONE_UNVERIFIED" | "FAILED"
  verification: RestoreVerification | null
  rejected: { table: string; line: number; motivo: string } | null
  error: string | null
}

/**
 * Restaura el ZIP dentro de una organización **ya creada y vacía**.
 *
 * El orden es el de §5.4 y no es negociable:
 *   2. firma y manifest **antes de descomprimir un byte**;
 *   4. tabla por tabla en orden de FK, **abortando a la primera fila rechazada**;
 *   5. las `exchange_rates` referenciadas;
 *   6. los ficheros, **verificando el sha256 de cada uno**;
 *   7. las **seis** comprobaciones;
 *   8. `DONE` sólo con las seis en verde; si no, `DONE_UNVERIFIED` (O-2).
 */
export async function restoreBackupIntoOrganization(options: RestoreOptions): Promise<RestoreOutcome> {
  /**
   * **Paso 2 de §5.4 — la firma, ANTES de descomprimir un byte** (E12 · T16).
   * La inspección sólo toca `manifest.json`, su sha y la firma.
   */
  const inspection = await inspectBackupArchive(options.archive, options.keys)
  let manifest: BackupManifest
  if (inspection.ok) {
    manifest = inspection.manifest
  } else {
    /**
     * **G-15b — la única excepción, y está acotada.** Una `CLAVE_DESCONOCIDA`
     * significa «esto lo firmó otra instalación»: es un hecho legítimo cuando un
     * cliente trae su copia, y el operador puede autorizarlo **por escrito y con
     * su nombre**. Cualquier otro motivo —sha discordante, firma que no
     * corresponde, formato ajeno— es alteración o incompatibilidad, y no lo
     * autoriza nadie.
     */
    const autorizable = inspection.reason === "CLAVE_DESCONOCIDA" && inspection.manifest !== null
    const permiso = options.allowForeignSignature
    if (!autorizable || !permiso || permiso.reason.trim().length < 20) {
      return {
        status: "FAILED",
        verification: null,
        rejected: null,
        error:
          `${inspection.reason}: ${inspection.detail}` +
          (autorizable && !permiso
            ? ". El archivo está firmado por otra instalación: hace falta autorización explícita del operador, con motivo, y queda registrada."
            : ""),
      }
    }
    manifest = inspection.manifest!
  }

  const zip = await JSZip.loadAsync(options.archive)

  /**
   * **Criterio 38 — un ZIP de un esquema anterior se RECHAZA nombrando la
   * versión**, no se restaura «lo que se pueda».
   *
   * Restaurar parcialmente un volcado de un esquema viejo produce una
   * organización a la que le faltan tablas y columnas, con las seis
   * comprobaciones dando FAIL por motivos que nadie sabría leer. El rechazo
   * dice qué versión trae el archivo y cuál corre aquí, que es lo único
   * accionable.
   */
  const schemaHere = await tenantTransaction(options.targetOrganizationId, async (tx) => await schemaVersionOf(tx))
  if (manifest.schemaVersion !== schemaHere) {
    return {
      status: "FAILED",
      verification: null,
      rejected: null,
      error:
        `ESQUEMA_INCOMPATIBLE: el archivo se emitió con schemaVersion «${manifest.schemaVersion}» y esta ` +
        `instalación corre «${schemaHere}». No se restaura parcialmente: migra la instalación a esa versión ` +
        "o pide una copia emitida con la actual.",
    }
  }

  let rejected: RestoreOutcome["rejected"] = null
  const target = options.targetOrganizationId

  try {
    await tenantTransaction(
      target,
      async (tx) => {
        const tables = manifest.tables.map((table) => table.name)
        const order = await restoreOrder(tx, tables)
        const selfRefs = await selfReferences(tx)
        const fkByTable = await foreignKeyColumns(tx)
        const byName = new Map(manifest.tables.map((table) => [table.name, table] as const))

        /**
         * **La reasignación de identificadores, y por qué es obligatoria.**
         *
         * La restauración va SIEMPRE a una organización nueva, pero **en la
         * misma base**, y todas las claves primarias del esquema son `id` uuid
         * global —no `(organization_id, id)`—. Conservar los ids del origen
         * chocaría contra su propia fila en cuanto la organización de origen
         * siga viva, que es el caso normal: el usuario compara las dos.
         *
         * Se reasigna en dos pasadas: primero se recogen TODOS los ids del
         * archivo y se les asigna uno nuevo; después se insertan las filas
         * traduciendo `id` y toda columna `*_id` que apunte a algo del propio
         * archivo. Las que apuntan fuera —`user_id`, `posted_by_id`,
         * `exchange_rate_id`— no están en el mapa y pasan intactas, que es
         * justamente lo que se quiere.
         *
         * Esto NO afecta a los sellos comparables: `ledgerHash` y el analítico
         * están definidos **sin uuid** precisamente por esto (ADR-0011), y los
         * sellos de FILA que sí los llevan se vuelven a sellar más abajo.
         */
        const remap = new Map<string, string>()
        for (const entry of manifest.tables) {
          const body = await zip.file(entry.jsonl)?.async("string")
          if (body === undefined) throw new RestoreAbort(entry.name, 0, "falta el fichero de datos en el archivo")
          if (body === "") continue
          for (const line of body.split("\n")) {
            const id = (JSON.parse(line) as Record<string, { v: unknown }>).id?.v
            if (typeof id === "string") remap.set(id, randomUUID())
          }
        }

        for (const table of order) {
          const entry = byName.get(table)
          if (!entry) continue
          const body = await zip.file(entry.jsonl)?.async("string")
          if (body === undefined) throw new RestoreAbort(table, 0, "falta el fichero de datos en el archivo")
          if (sha256hex(body) !== entry.sha256) {
            throw new RestoreAbort(table, 0, "el sha256 del fichero de datos no coincide con el manifest")
          }
          const lines = body === "" ? [] : body.split("\n")
          if (lines.length !== entry.rows) {
            throw new RestoreAbort(table, lines.length, `el manifest declara ${entry.rows} filas y hay ${lines.length}`)
          }
          const decoded = lines.map((line, position) => {
            const row = applyRemap(decodeRow(line), remap, fkByTable.get(table) ?? new Set())
            row[TENANT_COLUMN] = target
            reissueGlobalSecrets(table, row)
            rederiveStoredObjectKey(table, row, target)
            // El número de LÍNEA del archivo viaja con la fila: si se reordena
            // por la jerarquía, el motivo del rechazo tiene que seguir señalando
            // la línea de verdad y no la posición de inserción.
            Object.defineProperty(row, LINE_NUMBER, { value: position + 1, enumerable: false })
            return row
          })
          const ordered = sortRowsBySelfReference(decoded, selfRefs.get(table) ?? [])

          /**
           * **Las dos excepciones declaradas, y son las filas que el ALTA ya
           * creó en el destino.** Cualquier otra colisión sigue abortando el
           * trabajo con tabla, línea y motivo (D2.5).
           *
           * 1. **La membresía de quien restaura.** Una organización no existe
           *    sin dueño, así que la de destino nace ya con la suya. Si esa
           *    persona también era miembro del origen —el caso normal: es su
           *    backup—, la fila del archivo chocaría contra ella.
           *
           * 2. **La suscripción.** `subscriptions` tiene `UNIQUE
           *    (organization_id)` —una organización, una suscripción (I-E11-5)—
           *    y el alta la siembra (ADR-0019 D9). La del archivo es la del
           *    ORIGEN, y copiarla sería peor que omitirla: duplicaría en la
           *    copia el `stripe_subscription_id` de una suscripción de pago que
           *    sólo puede estar cobrándose una vez. La copia conserva sus libros;
           *    lo que no hereda es el contrato.
           */
          const alreadyMember =
            table === "memberships"
              ? new Set(
                  (await tx.membership.findMany({ select: { userId: true } })).map((membership) => membership.userId)
                )
              : new Set<string>()
          const subscriptionAlreadySeeded =
            table === "subscriptions"
              ? ((
                  await tx.$queryRaw<{ n: bigint }[]>`
                    SELECT count(*)::bigint AS n FROM "subscriptions" WHERE "organization_id" = ${target}::uuid`
                )[0]?.n ?? BigInt(0)) > BigInt(0)
              : false

          /**
           * **E12 · T17 — la inserción va POR LOTES, y el motivo es un techo.**
           *
           * Fila a fila, restaurar las 150 000 líneas del fixture de gran
           * volumen tardaba **628 s dentro de una sola transacción** y reventaba
           * el límite de 300 s de Prisma: el techo 6 de §12 (< 30 min y
           * **ninguna transacción > 30 s**) no se incumplía por poco, se
           * incumplía por diseño. No se vio en E11 porque el techo se
           * extrapolaba desde 10 000 asientos. Es exactamente lo que la deuda 6
           * existía para encontrar.
           *
           * Un `INSERT` de 500 filas cuesta un viaje en vez de 500. Lo que NO se
           * pierde es la regla de G-15: **una sola fila rechazada aborta el
           * trabajo entero, con tabla, línea y motivo**. Cuando un lote falla se
           * reintenta fila a fila para poder nombrar la línea culpable — se paga
           * el coste sólo en el caso malo, que es el que tiene que ser preciso.
           */
          const insertables = ordered.filter((row) => {
            if (table === "memberships" && alreadyMember.has(String(row.user_id))) return false
            if (table === "subscriptions" && subscriptionAlreadySeeded) return false
            return true
          })

          for (let desde = 0; desde < insertables.length; desde += RESTORE_BATCH_ROWS) {
            const lote = insertables.slice(desde, desde + RESTORE_BATCH_ROWS)
            try {
              await insertRows(tx, table, lote)
            } catch {
              // El lote no dice QUÉ fila lo rompió. Se repite una a una: el
              // trabajo ya va a abortar, así que el coste da igual y lo que
              // importa es el mensaje.
              for (let i = 0; i < lote.length; i += 1) {
                try {
                  await insertRow(tx, table, lote[i])
                } catch (error) {
                  throw new RestoreAbort(
                    table,
                    (lote[i] as { [LINE_NUMBER]?: number })[LINE_NUMBER] ?? desde + i + 1,
                    error instanceof Error ? error.message : String(error)
                  )
                }
              }
              // Si al repetirlas una a una ninguna falla, el problema era del
              // lote y no de una fila: se dice, en vez de seguir como si nada.
              throw new RestoreAbort(table, desde + 1, "el lote falló pero ninguna fila suelta lo reproduce")
            }
          }
        }

        /**
         * **Re-sellado de los sellos DE FILA** (I-E3-7, ADR-0011). `entry_hash`
         * lleva todas las columnas del asiento, uuid incluidos: su oficio es
         * detectar cualquier mutación, no ser comparable entre organizaciones.
         * Con los ids reasignados hay que volver a sellarlo, y el trigger
         * `journal_entries_entry_hash_guard` sólo deja escribir el sello
         * recalculado — de modo que si esto estuviera mal, la base lo impediría.
         */
        const resealed = tx as unknown as { $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown> }
        await resealed.$queryRawUnsafe(
          `UPDATE journal_entries SET entry_hash = app.journal_entry_hash(id) WHERE organization_id = $1::uuid`,
          target
        )

        /**
         * **E12 · T17 — `ANALYZE` tras la inserción masiva. No es una
         * optimización: es la diferencia entre 30 s y once minutos.**
         *
         * Con volumen real, la primera comprobación que recorre el diario
         * restaurado —`computeContentSeals`, que une `journal_lines` con
         * `journal_entries`, `projects`, `cost_centers` y `business_lines`—
         * tardaba **más de 670 s** y reventaba la transacción, mientras la MISMA
         * consulta sobre el ORIGEN tardaba segundos. La diferencia no estaba en
         * los datos: estaba en que el destino acababa de recibir 150 000 filas y
         * el planificador **no tenía ni una estadística**, así que elegía bucles
         * anidados sobre tablas que creía vacías.
         *
         * `autovacuum` lo arreglaría… un rato después, y la verificación corre
         * inmediatamente. Se hace aquí, dentro de la misma transacción (ANALYZE
         * sí se admite en un bloque transaccional, a diferencia de VACUUM), y
         * sólo sobre las tablas que se han tocado.
         */
        for (const tabla of order) {
          await resealed.$queryRawUnsafe(`ANALYZE "${tabla}"`).catch(() => undefined)
        }

        // 5 · las tasas referenciadas (O-1.5). Append-only y única por
        // `(fecha, par, fuente)`: si existe con OTRO valor, se falla.
        const ratesBody = (await zip.file("global/exchange_rates.jsonl")?.async("string")) ?? ""
        if (sha256hex(ratesBody) !== manifest.globalRefs.exchangeRates.sha256) {
          throw new RestoreAbort("exchange_rates", 0, "el sha256 de las tasas no coincide con el manifest")
        }
        const rateLines = ratesBody === "" ? [] : ratesBody.split("\n")
        for (let index = 0; index < rateLines.length; index += 1) {
          const rate = decodeRow(rateLines[index])
          try {
            await insertExchangeRate(tx, rate)
          } catch (error) {
            throw new RestoreAbort("exchange_rates", index + 1, error instanceof Error ? error.message : String(error))
          }
        }
      },
      { timeout: 300_000, maxWait: 15_000 }
    )
  } catch (error) {
    if (error instanceof RestoreAbort) {
      rejected = { table: error.table, line: error.line, motivo: error.motivo }
      return { status: "FAILED", verification: null, rejected, error: error.message }
    }
    return {
      status: "FAILED",
      verification: null,
      rejected: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  // 6 · los ficheros, verificando el sha256 de CADA uno contra el manifest.
  const write = options.writeFileBytes ?? defaultWriteFileBytes(target)
  const filesRestored: string[] = []
  const filesMissing: string[] = []
  for (const entry of manifest.files) {
    const body = await zip.file(entry.path)?.async("nodebuffer")
    if (!body) {
      filesMissing.push(entry.sha256)
      continue
    }
    const actual = sha256hex(body)
    if (actual !== entry.sha256) {
      return {
        status: "FAILED",
        verification: null,
        rejected: {
          table: "files",
          line: 0,
          motivo: `${entry.path} tiene sha256 ${actual} y el manifest dice ${entry.sha256}`,
        },
        error: "fichero alterado dentro del archivo",
      }
    }
    await write(entry.sha256, body)
    filesRestored.push(entry.sha256)
  }

  // 7 · las SEIS comprobaciones.
  const verification = await verifyRestore({
    manifest,
    targetOrganizationId: target,
    backupJobId: options.backupJobId ?? null,
    refDate: options.refDate,
    filesRestored,
    filesMissing,
  })

  return { status: restoreStatusOf(verification.checks), verification, rejected: null, error: null }
}

/**
 * Traduce `id` y toda columna `*_id` cuyo valor esté en el mapa. Lo que no está
 * en el mapa apunta fuera del archivo (usuarios, tasas globales) y no se toca.
 */
function applyRemap(
  row: Record<string, unknown>,
  remap: ReadonlyMap<string, string>,
  fkColumns: ReadonlySet<string>
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [column, value] of Object.entries(row)) {
    if ((column === "id" || fkColumns.has(column)) && typeof value === "string") {
      out[column] = remap.get(value) ?? value
      continue
    }
    out[column] = value
  }
  return out
}

/** Inserta una fila cruda con sus columnas tal cual venían. */
/**
 * ¿Es un valor JSON (objeto o **array**) que hay que enviar como `jsonb`?
 *
 * **E11 · ronda 2 — el fallo que destapó el volumen real.** `pg` serializa un
 * array de JavaScript como literal de array de Postgres (`{}`), no como JSON
 * (`[]`): restaurar una columna `jsonb` que contuviera un array —`attempts` y
 * `recc_payments` de `extraction_runs`, `items` y `files` de `transactions`—
 * escribía un objeto vacío, y el CHECK `…_recc_payments_array` (que exige
 * `jsonb_typeof = 'array'`) abortaba la restauración entera. Sin volumen no se
 * veía: el fixture no traía ninguna extracción.
 *
 * La fila se envía como TEXTO JSON con un `::jsonb` explícito, que es la única
 * forma de que `[]` siga siendo `[]`. `Buffer` y `Date` se excluyen a mano: son
 * objetos y NO son JSON.
 */
const esJson = (value: unknown): boolean =>
  typeof value === "object" && value !== null && !Buffer.isBuffer(value) && !(value instanceof Date)

/**
 * Filas por sentencia al restaurar. 500 es el punto en el que el viaje deja de
 * dominar y el número de parámetros (500 × ~30 columnas = 15 000) sigue muy por
 * debajo del tope de 65 535 de Postgres.
 */
const RESTORE_BATCH_ROWS = 500

/**
 * Inserta un LOTE en una sentencia. Todas las filas de una tabla vienen del
 * mismo JSONL y por tanto comparten columnas; si alguna no lo hiciera —un
 * archivo manipulado—, se parte por juego de columnas en vez de mezclar, que
 * sería insertar `NULL` donde el origen tenía un valor.
 */
async function insertRows(
  tx: TenantTransactionClient,
  table: string,
  rows: readonly Record<string, unknown>[]
): Promise<void> {
  if (rows.length === 0) return

  const porColumnas = new Map<string, Record<string, unknown>[]>()
  for (const row of rows) {
    const clave = Object.keys(row).sort().join("\u0000")
    const grupo = porColumnas.get(clave)
    if (grupo) grupo.push(row)
    else porColumnas.set(clave, [row])
  }

  const raw = tx as unknown as { $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown> }
  for (const grupo of porColumnas.values()) {
    const columns = Object.keys(grupo[0])
    const quoted = columns.map((column) => `"${column}"`).join(", ")
    const valores: unknown[] = []
    const tuplas = grupo.map((row) => {
      const marcas = columns.map((column) => {
        const value = row[column]
        valores.push(esJson(value) ? JSON.stringify(value) : value)
        return esJson(value) ? `$${valores.length}::jsonb` : `$${valores.length}`
      })
      return `(${marcas.join(", ")})`
    })
    await raw.$queryRawUnsafe(`INSERT INTO "${table}" (${quoted}) VALUES ${tuplas.join(", ")}`, ...valores)
  }
}

async function insertRow(tx: TenantTransactionClient, table: string, row: Record<string, unknown>): Promise<void> {
  const columns = Object.keys(row)
  const placeholders = columns
    .map((column, index) => (esJson(row[column]) ? `$${index + 1}::jsonb` : `$${index + 1}`))
    .join(", ")
  const quoted = columns.map((column) => `"${column}"`).join(", ")
  // `$executeRawUnsafe` no está en `TenantTransactionClient` a propósito (es la
  // puerta trasera que ESLint prohíbe en `models/`); aquí la restauración sí lo
  // necesita —columnas dinámicas— y va acotada por el `organization_id` que se
  // inyecta en cada fila y por la política RLS de la transacción.
  const raw = tx as unknown as { $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown> }
  await raw.$queryRawUnsafe(
    `INSERT INTO "${table}" (${quoted}) VALUES (${placeholders})`,
    ...columns.map((column) => (esJson(row[column]) ? JSON.stringify(row[column]) : row[column]))
  )
}

/**
 * Tasa global: se inserta si falta y **falla si existe con otro valor** (O-1.5).
 * Dos empresas no pueden convertir el mismo día a tipos distintos.
 */
async function insertExchangeRate(tx: TenantTransactionClient, rate: Record<string, unknown>): Promise<void> {
  const existing = await tx.$queryRawUnsafe<{ rate_micro: bigint | number }[]>(
    `SELECT rate_micro FROM exchange_rates WHERE id = $1::uuid`,
    rate.id
  )
  if (existing.length > 0) {
    if (String(existing[0].rate_micro) !== String(rate.rate_micro)) {
      throw new Error(`la tasa ${String(rate.id)} ya existe con otro valor`)
    }
    return
  }
  await insertRow(tx, "exchange_rates", rate)
}

function defaultWriteFileBytes(organizationId: string) {
  return async (sha256: string, bytes: Buffer): Promise<void> => {
    await tenantTransaction(organizationId, async (tx) => {
      await putObject(tx, {
        organizationId,
        kind: "DOCUMENT",
        sha256,
        mimeType: "application/octet-stream",
        body: bytes,
      })
    })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Las SEIS comprobaciones (§5.4, O-1) — `restoreVerification.json`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sellos **de fila** que incluyen uuid por diseño (ADR-0011): no se comparan
 * byte a byte contra el origen —los ids son otros— sino que se **recalculan**
 * fila a fila en el destino, que es lo que su invariante promete.
 */
const ROW_SEALS_WITH_UUID: ReadonlySet<string> = new Set(["journal_entries.entry_hash"])

export type VerifyRestoreInput = {
  manifest: BackupManifest
  targetOrganizationId: string
  backupJobId: string | null
  refDate: Date
  filesRestored: readonly string[]
  filesMissing: readonly string[]
  /** El barrido de invariantes. Se inyecta para poder probarlo aislado. */
  sweep?: (
    tx: TenantTransactionClient,
    refDate: Date
  ) => Promise<{ families: number; failed: string[]; checksHash: string }>
}

export async function verifyRestore(input: VerifyRestoreInput): Promise<RestoreVerification> {
  const { manifest, targetOrganizationId: target } = input

  /**
   * **E12 · T17 — una transacción POR COMPROBACIÓN, no una para las seis.**
   *
   * Con el diario del fixture de gran volumen (50 000 asientos, 150 000 líneas)
   * las seis comprobaciones juntas tardaban **623 s** y reventaban el límite de
   * 300 s de la transacción interactiva. No era un problema de tiempo total
   * —§12 da 30 min al techo 6— sino de **una sola transacción demasiado larga**,
   * que es justo lo que §12 prohíbe en su segunda mitad: «ninguna transacción
   * por encima de 30 s».
   *
   * Las seis son de SOLO LECTURA sobre un destino que ya no cambia, así que
   * partirlas no pierde nada: no hay ninguna invariante que exija verlas en el
   * mismo instante, y sí una que exige no bloquear la base media hora.
   */
  const enTransaccion = async <T>(fn: (tx: TenantTransactionClient) => Promise<T>): Promise<T> =>
    await tenantTransaction(target, fn, { timeout: 120_000, maxWait: 15_000 })

  const checks: CheckResult[] = await (async (): Promise<CheckResult[]> => {
    const out: CheckResult[] = []

    await enTransaccion(async (tx) => {
      // 1 · RECUENTOS, con `=` y no `⊇`.
      const actualCounts = new Map<string, number>()
      for (const table of manifest.tables) {
        const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM "${table.name}" WHERE ${TENANT_COLUMN} = $1::uuid`,
          target
        )
        actualCounts.set(table.name, Number(rows[0]?.n ?? 0))
      }
      out.push(compareCounts(new Map(manifest.tables.map((t) => [t.name, t.rows])), actualCounts))
    })

    await enTransaccion(async (tx) => {
      // 2 · NUMERACIÓN: máximo, huecos, duplicados y series.
      const years = await tx.fiscalYear.findMany({ orderBy: { startDate: "asc" } })
      const evidence: CheckResult["evidence"] = []
      for (const expected of manifest.numbering) {
        const year = years.find((row) => row.code === expected.fiscalYearCode)
        if (!year) {
          evidence.push({
            label: `ejercicio ${expected.fiscalYearCode}`,
            expected: "presente",
            actual: "ausente",
            ok: false,
          })
          continue
        }
        const rows = await tx.journalEntry.findMany({ where: { fiscalYearId: year.id }, select: { entryNumber: true } })
        const actual = numberingOf(rows.map((row) => row.entryNumber))
        evidence.push({
          label: `ejercicio ${expected.fiscalYearCode} · nº máximo y recuento`,
          expected: `${expected.maxEntryNumber}/${expected.count}`,
          actual: `${actual.max}/${actual.count}`,
          ok: actual.max === expected.maxEntryNumber && actual.count === expected.count,
        })
        /**
         * **Revisor DEBE 8.** La ronda anterior comparaba `gaps.length` contra
         * `gaps.length`: un origen con dos huecos y un destino con **otros dos**
         * daba PASS. Ahora se comparan los ARRAYS enteros —qué huecos y qué
         * duplicados—, y además se exige **ausencia absoluta** cuando el origen
         * no los tenía, que es lo que D2.6.2 pide («sin huecos ni duplicados»).
         */
        const sameGaps = JSON.stringify(actual.gaps) === JSON.stringify(expected.gaps)
        const sameDuplicates = JSON.stringify(actual.duplicates) === JSON.stringify(expected.duplicates)
        const cleanWhenExpected =
          (expected.gaps.length > 0 || actual.gaps.length === 0) &&
          (expected.duplicates.length > 0 || actual.duplicates.length === 0)
        evidence.push({
          label: `ejercicio ${expected.fiscalYearCode} · huecos y duplicados (los números, no su recuento)`,
          expected: `huecos [${expected.gaps.join(", ")}] · duplicados [${expected.duplicates.join(", ")}]`,
          actual: `huecos [${actual.gaps.join(", ")}] · duplicados [${actual.duplicates.join(", ")}]`,
          ok: sameGaps && sameDuplicates && cleanWhenExpected,
        })
      }
      const series = await tx.invoiceSeries.findMany({ orderBy: { code: "asc" } })
      for (const expected of manifest.invoiceSeries) {
        const row = series.find((candidate) => candidate.code === expected.code)
        evidence.push({
          label: `serie ${expected.code} · último número`,
          expected: String(expected.lastNumber),
          actual: row ? String(row.nextNumber - 1) : "serie ausente",
          ok: row !== undefined && row.nextNumber - 1 === expected.lastNumber,
        })
      }
      out.push({
        id: "NUMERACION",
        status: evidence.every((row) => row.ok) ? "PASS" : "FAIL",
        title: "Numeración correlativa por ejercicio, sin huecos ni duplicados, y series de facturación",
        evidence,
        note: "Los tres sellos NO cubren esto: dos asientos con los números intercambiados dan el mismo ledgerHash.",
      })
    })

    await enTransaccion(async (tx) => {
      // 3 · SELLOS DERIVADOS, recomputados sobre `derivedSealColumns()`.
      const sealEvidence: CheckResult["evidence"] = []
      for (const expected of manifest.derivedSeals) {
        const rows = await tx.$queryRawUnsafe<{ v: string | null }[]>(
          `SELECT "${expected.column}" AS v FROM "${expected.table}" WHERE ${TENANT_COLUMN} = $1::uuid`,
          target
        )
        if (ROW_SEALS_WITH_UUID.has(`${expected.table}.${expected.column}`)) {
          /**
           * **Sello DE FILA, que lleva uuid** (ADR-0011): su oficio es detectar
           * cualquier mutación, no ser comparable entre organizaciones. Con los
           * ids reasignados, comparar el valor byte a byte probaría lo
           * contrario de lo que se quiere. Lo que se comprueba —y es más
           * fuerte— es que **cada fila del destino cuadra con su propio
           * recálculo**: exactamente el enunciado de I-E3-7.
           */
          const mismatched = await tx.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM journal_entries
                WHERE ${TENANT_COLUMN} = $1::uuid AND entry_hash IS DISTINCT FROM app.journal_entry_hash(id)`,
            target
          )
          const bad = Number(mismatched[0]?.n ?? 0)
          sealEvidence.push({
            label: `${expected.table}.${expected.column} · recalculado fila a fila (${rows.length} filas)`,
            expected: "0 discrepancias",
            actual: `${bad} discrepancias`,
            ok: bad === 0 && rows.length === expected.rows,
          })
          continue
        }
        const actual = sealColumnSha256(rows.map((row) => row.v))
        sealEvidence.push({
          label: `${expected.table}.${expected.column} (${expected.rows} filas)`,
          expected: expected.sha256,
          actual,
          ok: actual === expected.sha256 && rows.length === expected.rows,
        })
      }
      out.push({
        id: "SELLOS_DERIVADOS",
        status: sealEvidence.every((row) => row.ok) ? "PASS" : "FAIL",
        title: "Recomputo de TODOS los sellos derivados sobre la lista derivada del código",
        evidence: sealEvidence,
      })
    })

    await enTransaccion(async (tx) => {
      // 4 · AUDIT LOG: recuento y sha256 de su forma canónica.
      const auditRows = await tx.auditLog.findMany({
        select: { entity: true, entityId: true, action: true, reason: true, ts: true },
      })
      const auditSha = auditLogCanonicalSha256(auditRows)
      out.push({
        id: "AUDIT_LOG",
        status:
          auditRows.length === manifest.auditLog.rows && auditSha === manifest.auditLog.canonicalSha256
            ? "PASS"
            : "FAIL",
        title: "Registro de auditoría: quién forzó qué y con qué motivo",
        evidence: [
          {
            label: "filas",
            expected: String(manifest.auditLog.rows),
            actual: String(auditRows.length),
            ok: auditRows.length === manifest.auditLog.rows,
          },
          {
            label: "sha256 canónico",
            expected: manifest.auditLog.canonicalSha256,
            actual: auditSha,
            ok: auditSha === manifest.auditLog.canonicalSha256,
          },
        ],
      })
    })

    await enTransaccion(async (tx) => {
      // 5 · LOS TRES SELLOS + el estado del cierre.
      const seals = await computeContentSeals(tx)
      const closing = await dumpClosing(tx)
      const sealsEvidence: CheckResult["evidence"] = [
        {
          label: "ledgerHash",
          expected: manifest.seals.ledgerHash,
          actual: seals.ledgerHash,
          ok: seals.ledgerHash === manifest.seals.ledgerHash,
        },
        {
          label: "analyticsKey",
          expected: manifest.seals.analyticsKey,
          actual: seals.analyticsKey,
          ok: seals.analyticsKey === manifest.seals.analyticsKey,
        },
        {
          label: "budgetHash",
          expected: manifest.seals.budgetHash ?? "∅",
          actual: seals.budgetHash ?? "∅",
          ok: (seals.budgetHash ?? null) === (manifest.seals.budgetHash ?? null),
        },
        {
          label: "estado del cierre",
          expected: JSON.stringify(manifest.closing.fiscalYears),
          actual: JSON.stringify(closing.fiscalYears),
          ok: JSON.stringify(manifest.closing.fiscalYears) === JSON.stringify(closing.fiscalYears),
        },
        {
          label: "ejecuciones de cierre",
          expected: String(manifest.closing.closingRuns),
          actual: String(closing.closingRuns),
          ok: manifest.closing.closingRuns === closing.closingRuns,
        },
      ]
      out.push({
        id: "SELLOS_Y_CIERRE",
        status: sealsEvidence.every((row) => row.ok) ? "PASS" : "FAIL",
        title: "Los tres sellos de contenido y el estado del cierre",
        evidence: sealsEvidence,
      })
    })

    await enTransaccion(async (tx) => {
      // 6 · BARRIDO de las nueve familias + correspondencia `File` ↔ objeto.
      const sweep = input.sweep ?? defaultInvariantSweep
      const swept = await sweep(tx, input.refDate)
      const fileRows = await tx.file.findMany({ select: { sha256: true } })
      const restored = new Set(input.filesRestored)
      const orphans = fileRows.filter((row) => !restored.has(row.sha256))

      /**
       * **Auditor H-6 — la comprobación 6 es RELATIVA, no absoluta.**
       *
       * Lo que una restauración tiene que acreditar es **fidelidad**: que el
       * destino dice exactamente lo mismo que el origen. Exigir cero FAIL en
       * términos absolutos condenaba a `DONE_UNVERIFIED` a toda organización que
       * ya tuviera un invariante en rojo —el auditor reprodujo `I8` e `I-E7-14`
       * en FAIL **en los dos lados**, con los tres sellos, los recuentos, la
       * numeración y los sellos derivados coincidiendo—, y mandaba una copia
       * buena a la etiqueta que I-E11-2 declara FAIL.
       *
       * Con la foto del origen en el manifest (`sourceSweep`) el criterio es
       * `destino ≡ origen`. Sin ella —copias emitidas antes de esta ronda— se
       * mantiene el criterio absoluto, y la evidencia lo dice en vez de callarlo.
       */
      const baseline = manifest.sourceSweep ?? null
      const destinoFailed = [...swept.failed].sort()
      const origenFailed = baseline ? [...baseline.failed].sort() : []
      const nuevos = destinoFailed.filter((id) => !origenFailed.includes(id))
      const desaparecidos = origenFailed.filter((id) => !destinoFailed.includes(id))
      const sweepOk = baseline ? nuevos.length === 0 && desaparecidos.length === 0 : swept.failed.length === 0

      /**
       * **E12 · T16 (deuda 7) — de «relativa tolerante» a EXACTA.**
       *
       * Hasta esta épica la comprobación se conformaba con que cada `File`
       * tuviera bytes en alguna parte. Con eso, una copia cuyas filas de
       * `stored_objects` conservaran la clave del ORIGEN pasaba en verde: los
       * bytes estaban (los había escrito `putObject` con la clave del destino) y
       * la fila apuntaba a otro sitio. Dos verdades distintas del mismo objeto,
       * y la que mandaba —la fila— era la equivocada.
       *
       * Ahora se recomputa la clave canónica de CADA objeto restaurado, con la
       * organización de destino y el prefijo de ESTE entorno, y se exige
       * igualdad literal. No admite «parecida».
       */
      const objetos = await tx.storedObject.findMany({
        select: { id: true, objectKey: true, sha256: true, kind: true },
      })
      const clavesMal: string[] = []
      for (const objeto of objetos) {
        const esperada = objectKey({
          prefix: storage().prefix,
          organizationId: target,
          kind: objeto.kind,
          sha256: objeto.sha256,
        })
        if (objeto.objectKey !== esperada) clavesMal.push(`${objeto.id}: ${objeto.objectKey} ≠ ${esperada}`)
      }
      const clavesOk = clavesMal.length === 0

      out.push({
        id: "BARRIDO_INVARIANTES",
        status: sweepOk && clavesOk && orphans.length === 0 && input.filesMissing.length === 0 ? "PASS" : "FAIL",
        title: baseline
          ? "Barrido completo de las nueve familias, ENFRENTADO al del origen, y correspondencia fichero ↔ objeto"
          : "Barrido completo de las nueve familias de invariantes y correspondencia fichero ↔ objeto",
        evidence: [
          // El número de familias que produce el barrido depende de qué módulos
          // tienen datos en la organización: se ENSEÑA, no se exige un número
          // mágico.
          {
            label: "familias barridas",
            expected: baseline ? String(baseline.families) : "≥ 1",
            actual: String(swept.families),
            ok: swept.families >= 1,
          },
          {
            label: baseline ? "invariantes en FAIL (origen ↔ destino)" : "invariantes en FAIL",
            expected: baseline ? origenFailed.join(", ") || "0" : "0",
            actual: destinoFailed.join(", ") || "0",
            ok: sweepOk,
          },
          {
            label: "checksHash del barrido",
            expected: baseline?.checksHash ?? "—",
            actual: swept.checksHash,
            ok: true,
          },
          {
            label: "ficheros sin bytes",
            expected: "0",
            actual: String(orphans.length + input.filesMissing.length),
            ok: orphans.length === 0 && input.filesMissing.length === 0,
          },
          {
            // **T16** · comparación EXACTA, no «relativa tolerante».
            label: `claves de stored_objects rederivadas al destino (${objetos.length} objeto(s))`,
            expected: "todas iguales a la clave canónica del destino",
            actual: clavesOk ? "todas iguales" : clavesMal.slice(0, 5).join(" · "),
            ok: clavesOk,
          },
        ],
        note: baseline
          ? nuevos.length > 0 || desaparecidos.length > 0
            ? `la copia NO es fiel: aparecen [${nuevos.join(", ") || "—"}] y desaparecen [${desaparecidos.join(", ") || "—"}]`
            : "fidelidad: el destino reproduce exactamente los mismos veredictos que el origen, FAIL incluidos"
          : "copia sin foto del barrido en origen (formato anterior a la corrección de H-6): criterio absoluto",
      })
    })

    return out
  })()

  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    backupJobId: input.backupJobId,
    sourceOrganizationId: manifest.organization.id,
    targetOrganizationId: target,
    verifiedAt: input.refDate.toISOString(),
    checks,
    verified: isVerified(checks),
  }
}

/**
 * El barrido real: `runLedgerInvariants` sobre el destino. Se carga de forma
 * diferida porque `models/ledger.ts` arrastra medio producto y esto sólo corre
 * al final de una restauración.
 */
async function defaultInvariantSweep(
  tx: TenantTransactionClient,
  refDate: Date
): Promise<{ families: number; failed: string[]; checksHash: string }> {
  const { runLedgerInvariants } = await import("@/models/ledger")
  const { checksHashOf } = await import("@/lib/audit/run")
  const run = await runLedgerInvariants(tx.$organizationId, {
    refDate: refDate.toISOString().slice(0, 10),
    // `audit: true` es lo que trae el bloque E7 y, con él, las NUEVE familias.
    // Sin esto el barrido sería el de una cabecera de informe y la
    // comprobación 6 se estaría dando por buena a medias — que es H-1 de E9 y
    // H-1 de E10, otra vez.
    audit: true,
    noCache: true,
  })
  const checks = run.validacion.checks
  // La familia es el prefijo del identificador: `I7` → base, `I-E8-2` → E8.
  const families = new Set(checks.map((check) => /^I-(E\d+)-/.exec(check.id)?.[1] ?? "BASE"))
  return {
    families: families.size,
    failed: checks.filter((check) => check.status === "FAIL").map((check) => check.id),
    checksHash: checksHashOf(checks),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// El trabajo: cola, cuota y retención (§5.3, §5.5)
// ─────────────────────────────────────────────────────────────────────────────

/** Clave de firma de plataforma y su identificador. La lee el proceso, no el motor. */
export function signingKeyFromEnv(env: NodeJS.ProcessEnv = process.env): { key: Buffer; keyId: string } {
  const raw = env.PLATFORM_SIGNING_KEY
  if (!raw || raw.trim() === "") {
    throw new Error("PLATFORM_SIGNING_KEY no está definida: un backup sin firma no se emite")
  }
  return { key: Buffer.from(raw, "utf8"), keyId: (env.PLATFORM_SIGNING_KEY_ID ?? "k1").slice(0, 16) }
}

export type RequestBackupInput = {
  organizationId: string
  trigger: BackupTrigger
  requestedById?: string | null
  refDate: Date
  /** Días de retención de la organización. Por defecto, los 30 de §5.5. */
  retentionDays?: number
}

/**
 * Encola un backup. **Aquí vive la cuota**, y no en la server action: la acción
 * de `/settings/backups` es de la ola C y una cuota que se cablea en la interfaz
 * es una cuota que la siguiente pantalla se olvida.
 *
 * **O-4 · portabilidad sin cuota**: `EXIT` y `SCHEDULED` no consumen nunca, y
 * `MANUAL` tampoco cuando `accessLevelOf ≠ FULL`. Un FREE que ya gastó su único
 * backup del mes **puede llevarse sus libros**.
 */
export async function requestBackup(input: RequestBackupInput) {
  const { assertWithinLimit, defaultPlanContextResolver } = await import("@/models/platform-limits")
  return await tenantTransaction(input.organizationId, async (tx) => {
    const { access } = await defaultPlanContextResolver(tx, input.organizationId, input.refDate)
    if (backupConsumesQuota(input.trigger, access)) {
      await assertWithinLimit(tx, "maxBackupsMonth", BigInt(1), { refDate: input.refDate })
    }
    const retentionDays = input.retentionDays ?? 30
    return await tx.backupJob.create({
      data: {
        organizationId: input.organizationId,
        status: "QUEUED",
        trigger: input.trigger,
        formatVersion: BACKUP_FORMAT_VERSION,
        schemaVersion: await schemaVersionOf(tx),
        gitSha: currentGitSha().slice(0, 40),
        requestedById: input.requestedById ?? null,
        expiresAt: new Date(input.refDate.getTime() + retentionDays * 86_400_000),
      },
    })
  })
}

/**
 * Ejecuta un `BackupJob` encolado: construye el ZIP, lo sube al almacén con
 * `kind = BACKUP` —que **no** consume cuota del cliente (O-12c)— y sella el
 * trabajo. Un fallo deja el motivo escrito, nunca un `DONE` a medias: el CHECK
 * `backup_jobs_done_is_complete` lo impide también en la base.
 */
export async function runBackupJob(organizationId: string, backupJobId: string, refDate: Date) {
  const { key, keyId } = signingKeyFromEnv()
  try {
    /**
     * **E12 · T14 — ni un byte del archivo pasa por el heap.** El plan deja el
     * manifest firmado y el contenido en el carrete; la emisión va directa a la
     * subida multipart, y el `sha256` del archivo lo devuelve el almacén tras
     * haberlo calculado bloque a bloque.
     *
     * **La clave del objeto la fija el `sha256` del MANIFEST**, no el del
     * archivo: el del archivo no se conoce hasta el último byte, y esperar a
     * conocerlo obligaría a materializarlo. El manifest sella tabla por tabla y
     * fichero por fichero todo lo que hay dentro, así que sigue siendo una clave
     * direccionable por contenido; `stored_objects.sha256` guarda el del archivo,
     * que es el que I-E11-6 compara contra el almacén.
     */
    const plan = await planBackupArchive(organizationId, { refDate, signingKey: key, signingKeyId: keyId })
    try {
      const object = await tenantTransaction(
        organizationId,
        async (tx) =>
          await putObjectStreaming(tx, {
            organizationId,
            kind: "BACKUP",
            keySha256: plan.manifestSha,
            mimeType: "application/zip",
            body: plan.archiveChunks(),
          })
      )
      return await tenantTransaction(
        organizationId,
        async (tx) =>
          await tx.backupJob.update({
            where: { id: backupJobId },
            data: {
              status: "DONE",
              progressBps: 10000,
              objectKey: object.objectKey,
              sizeBytes: object.sizeBytes,
              archiveSha256: object.sha256,
              manifestSha256: plan.manifestSha,
              signature: plan.signature,
              signingKeyId: keyId,
              ledgerHash: plan.manifest.seals.ledgerHash,
              analyticsKey: plan.manifest.seals.analyticsKey,
              budgetHash: plan.manifest.seals.budgetHash,
              rowCounts: Object.fromEntries(plan.manifest.tables.map((table) => [table.name, table.rows])),
              startedAt: refDate,
              finishedAt: refDate,
            },
          })
      )
    } finally {
      await plan.cleanup()
    }
  } catch (error) {
    await tenantTransaction(organizationId, async (tx) => {
      await tx.backupJob.update({
        where: { id: backupJobId },
        data: {
          status: "FAILED",
          error: (error instanceof Error ? error.message : String(error)).slice(0, 1024),
          finishedAt: refDate,
        },
      })
    })
    throw error
  }
}

/**
 * **E12 · T20 — el worker que `backup-worker` invocaba y no existía.**
 *
 * `models/cron-jobs.ts` comprobaba si este símbolo estaba y, al no estarlo,
 * devolvía `PARTIAL` con «el worker de la ola B todavía no existe» en cada
 * ejecución desde E11. Es decir: **el job llevaba una épica entera sin hacer
 * nada y diciéndolo en un sitio que nadie leía**. Aquí está.
 *
 * Recorre los `BackupJob` en `QUEUED` de todas las organizaciones, en orden de
 * antigüedad, y los ejecuta **mientras quede presupuesto**. Lo que no cabe se
 * queda encolado para la ejecución siguiente, que es lo que un worker con
 * cadencia de cinco minutos tiene que hacer; declarar `DONE` habiendo dejado
 * trabajo sin hacer sería el mismo reloj mintiendo, de la otra manera.
 *
 * Un fallo en una organización no detiene a las demás: se cuenta en `failed`, el
 * motivo queda escrito en la fila (`runBackupJob` lo hace) y el job sigue.
 */
/**
 * **E12 · T20 — el worker que `backup-worker` invocaba y no existía.**
 *
 * `models/cron-jobs.ts` comprobaba si el símbolo estaba y, al no estarlo,
 * devolvía `PARTIAL` con «el worker de la ola B todavía no existe» en cada
 * ejecución desde E11: **el job llevaba una épica entera sin hacer nada y
 * diciéndolo en un sitio que nadie leía**.
 *
 * Trabaja sobre UNA organización —la enumeración es del reloj, que es quien
 * tiene el cursor y el presupuesto— y ejecuta sus `BackupJob` en `QUEUED`
 * mientras `hasBudget()` lo permita. Lo que no cabe se queda encolado para la
 * pasada siguiente, que es lo que un worker con cadencia de cinco minutos tiene
 * que hacer; declararlo `DONE` habiendo dejado trabajo sería el mismo reloj
 * mintiendo, de la otra manera.
 */
export async function advanceBackupJobsOf(
  organizationId: string,
  refDate: Date,
  options: { hasBudget: () => boolean; max?: number }
): Promise<{ processed: number; failed: number }> {
  let processed = 0
  let failed = 0

  const pendientes = await tenantTransaction(
    organizationId,
    async (tx) =>
      await tx.backupJob.findMany({
        where: { status: "QUEUED" },
        select: { id: true },
        orderBy: { createdAt: "asc" },
        take: options.max ?? 20,
      })
  )

  for (const job of pendientes) {
    if (!options.hasBudget()) break
    try {
      await runBackupJob(organizationId, job.id, refDate)
      processed += 1
    } catch {
      // `runBackupJob` ya ha dejado la fila en FAILED con el motivo escrito: el
      // CHECK `backup_jobs_done_is_complete` impide que se disfrace de DONE.
      failed += 1
    }
  }

  return { processed, failed }
}

/**
 * Caducidad (§5.5, I-E11-11). Borra el **objeto** y pasa la fila a `EXPIRED`.
 *
 * Dos prohibiciones, y las dos tienen test: **nunca** se borra un backup con un
 * `RestoreJob` vivo que lo referencie, y **nunca** se toca un `StoredObject` de
 * `kind = PLATFORM_INVOICE` (O-11): son NUESTRAS facturas emitidas, sujetas a
 * conservación (art. 165.Uno LIVA, arts. 19–23 RD 1619/2012), no ZIP de
 * exportación.
 */
export async function expireBackups(organizationId: string, refDate: Date): Promise<number> {
  const { deleteObject } = await import("@/models/storage")
  return await tenantTransaction(organizationId, async (tx) => {
    const candidates = await tx.backupJob.findMany({
      where: { status: "DONE", expiresAt: { lt: refDate }, objectKey: { not: null } },
      include: { restores: { where: { status: { in: ["QUEUED", "RUNNING", "VERIFYING"] } }, select: { id: true } } },
    })
    let expired = 0
    for (const job of candidates) {
      if (job.restores.length > 0) continue
      const object = await tx.storedObject.findFirst({ where: { objectKey: job.objectKey! } })
      if (object && object.kind !== "PLATFORM_INVOICE") await deleteObject(tx, object.id)
      await tx.backupJob.update({ where: { id: job.id }, data: { status: "EXPIRED" } })
      expired += 1
    }
    return expired
  })
}
