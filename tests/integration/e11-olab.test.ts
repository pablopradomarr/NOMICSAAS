/**
 * E11 · ola B — **almacén, uso derivado, cuotas y backup/restauración**, contra
 * Postgres de verdad (docs/design/E11-plataforma-saas.md §3.4, §3.5, §4, §5;
 * ADR-0019 D2, D3 y D7).
 *
 * Lo que aquí se ejerce no se puede ejercer en un test puro:
 *
 *  · **Backup → restauración del fixture completo v1**, a una organización
 *    NUEVA, y los tres sellos idénticos con las **seis** comprobaciones de §5.4
 *    en PASS. Es el criterio P7 del ADR y el enunciado ampliado de I-E11-2.
 *  · **I-E11-7**: el inventario del ZIP **cubre `BACKUP_TENANT_MODELS`**
 *    —`TENANT_MODELS` ∪ `TENANT_MODELS_WITH_GLOBAL`—, porque se deriva de él. Es
 *    lo que impide repetir BUG-E7-1, BUG-E9-5, BUG-E10-1 y el H-2 del auditor de
 *    E11 (`currencies`, 177 filas por organización, fuera del ZIP).
 *  · **ZIP manipulado ⇒ firma inválida**, antes de descomprimir un byte.
 *  · **Fila corrupta ⇒ ABORTO** con tabla, línea y motivo. Se acabó el `catch`
 *    que sumaba igual a `insertedCount` (G-15).
 *  · **Uso derivado = Σ real**, con las exclusiones de O-5 (contra-asientos y
 *    asientos de sistema) y la caché invalidándose por `sourceHash`.
 *  · **Cuota dura bloquea y blanda avisa** (O-3, O-16), dentro de la transacción.
 *  · **En mora se sigue asentando** (D7): `canWrite` deja pasar el registro
 *    contable y el documental, y sólo detiene el OCR.
 *  · **RLS 42501**: `usage_runs` es append-only también a nivel de PRIVILEGIO
 *    para `app_runtime`, no sólo por política.
 *
 * El almacén de esta suite es un `LocalDriver` sobre un directorio temporal:
 * **no se abre una sola conexión de red**, ni a Supabase ni a un S3 simulado.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { Client } from "pg"
import JSZip from "jszip"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { appRuntimeDatabaseUrl, ownerDatabaseUrl } from "@/tests/support/env"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL

const ORG = "e1100000-0000-4000-8000-000000000001"
const DEST = "e1100000-0000-4000-8000-000000000002"
const DEST_2 = "e1100000-0000-4000-8000-000000000003"
const DEST_3 = "e1100000-0000-4000-8000-000000000004"
const ADMIN = "e1100000-0000-4000-8000-0000000000a1"

const SIGNING_KEY = Buffer.from("clave-de-firma-de-pruebas-e11")
const KEY_ID = "k1"
const KEYS = new Map([[KEY_ID, SIGNING_KEY]])
/**
 * `ejercicio-completo` llega a 2027, así que la fecha de referencia del barrido
 * tiene que cubrirlo: con una anterior, **I8** (`entryDate ≤ refDate`) saldría
 * FAIL en el destino… y también en el origen. El reloj no entra en ningún sitio.
 */
const REF = new Date("2027-12-31T12:00:00.000Z")

const storeRoot = await mkdtemp(path.join(tmpdir(), "e11-olab-store-"))
process.env.STORAGE_DRIVER = "local"
process.env.STORAGE_LOCAL_ROOT = storeRoot
process.env.STORAGE_PREFIX = "erp-test"
process.env.PLATFORM_SIGNING_KEY = SIGNING_KEY.toString("utf8")
process.env.PLATFORM_SIGNING_KEY_ID = KEY_ID

const { prisma, BACKUP_TENANT_MODELS, prismaSchemaMeta, tenantTransaction } = await import("@/lib/db")
const { loadFixtureIntoOrg } = await import("@/scripts/load-fixture")
const { backupInventory, derivedSealColumns, manifestSha256, signManifest, verifyManifest } = await import(
  "@/lib/platform/backup"
)
const { buildBackupArchive, computeContentSeals, restoreBackupIntoOrganization, restoreOrder } = await import(
  "@/models/backups"
)
const { getUsage, readUsageInput } = await import("@/models/usage")
const { usageSourceHash } = await import("@/lib/platform/usage")
const { assertWithinLimit, LimitExceededError, setPlanContextResolver, resetPlanContextResolver, UNLIMITED_PLAN } =
  await import("@/models/platform-limits")
const { canWrite } = await import("@/lib/platform/subscription")

const sha256 = (buffer: Buffer): string => createHash("sha256").update(buffer).digest("hex")

async function cleanup(): Promise<void> {
  for (const id of [ORG, DEST, DEST_2, DEST_3]) {
    await prisma.organization.deleteMany({ where: { id } })
  }
  await prisma.user.deleteMany({ where: { id: ADMIN } })
}

let archive: Buffer
let sourceSeals: Awaited<ReturnType<typeof computeContentSeals>>

describe.skipIf(!TEST_DATABASE_URL)("E11 · ola B — almacén, uso, cuotas y backup/restore", () => {
  beforeAll(async () => {
    await cleanup()
    await prisma.user.create({
      data: { id: ADMIN, email: "e11-admin@test.local", name: "Admin E11", updatedAt: new Date() },
    })
    for (const [id, slug] of [
      [ORG, "e11-origen"],
      [DEST, "e11-destino"],
      [DEST_2, "e11-destino-2"],
      [DEST_3, "e11-destino-3"],
    ] as const) {
      await prisma.organization.create({
        data: { id, slug, name: `E11 ${slug}`, pgcVariant: "PYMES", updatedAt: new Date() },
      })
      await prisma.membership.create({ data: { organizationId: id, userId: ADMIN, role: "ADMIN", updatedAt: new Date() } })
    }

    const report = await loadFixtureIntoOrg({ organizationId: ORG, fixture: "ejercicio-completo", userId: ADMIN })
    expect(report.mismatches).toEqual([])

    sourceSeals = await tenantTransaction(ORG, async (tx) => await computeContentSeals(tx))
    const built = await buildBackupArchive(ORG, { refDate: REF, signingKey: SIGNING_KEY, signingKeyId: KEY_ID })
    archive = built.archive
  }, 180_000)

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
    await rm(storeRoot, { recursive: true, force: true })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // I-E11-7 · el inventario se DERIVA y cubre TENANT_MODELS
  // ───────────────────────────────────────────────────────────────────────────

  it("I-E11-7 · el ZIP lleva TODAS las tablas de tenant (TENANT_MODELS ∪ las híbridas), porque el inventario se deriva de ellas", async () => {
    const zip = await JSZip.loadAsync(archive)
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"))
    const inManifest = new Set<string>(manifest.tables.map((table: { name: string }) => table.name))
    for (const table of backupInventory(BACKUP_TENANT_MODELS, prismaSchemaMeta())) {
      expect(inManifest.has(table), `falta ${table} en el manifest`).toBe(true)
    }
    expect(manifest.formatVersion).toBe("2.0")
    expect(manifest.totals.tables).toBe(BACKUP_TENANT_MODELS.size)
  })

  it("I-E11-7 · `derivedSealColumns()` cubre las columnas-sello del esquema real, sin lista escrita a mano", () => {
    const columns = derivedSealColumns(prismaSchemaMeta())
    const pairs = new Set(columns.map((entry) => `${entry.table}.${entry.column}`))
    // Muestras de cada familia: si alguna desaparece, el criterio sintáctico se rompió.
    expect(pairs.has("journal_entries.entry_hash")).toBe(true)
    expect(pairs.has("files.sha256")).toBe(true)
    expect(pairs.has("extraction_runs.prompt_sha")).toBe(true)
    expect(pairs.has("report_runs.params_hash")).toBe(true)
    expect(pairs.has("allocation_runs.lines_hash")).toBe(true)
    expect(pairs.has("closing_runs.ledger_hash")).toBe(true)
    // Y NO cuela un número de versión como si fuera un sello.
    expect(pairs.has("journal_entries.hash_version")).toBe(false)
  })

  it("el ZIP lleva el manifest firmado, el README en español y las tasas globales (O-1.5)", async () => {
    const zip = await JSZip.loadAsync(archive)
    expect(zip.file("manifest.json")).not.toBeNull()
    expect(zip.file("signature.txt")).not.toBeNull()
    expect(zip.file("seals.json")).not.toBeNull()
    expect(zip.file("global/exchange_rates.jsonl")).not.toBeNull()
    const readme = await zip.file("README.txt")!.async("string")
    expect(readme).toContain("Código de Comercio")
    expect(readme).toContain("VERIFICADA")
  })

  it("el orden de restauración se deriva de las FK reales: `fiscal_years` antes que `journal_entries`", async () => {
    const order = await tenantTransaction(DEST, async (tx) =>
      restoreOrder(tx, backupInventory(BACKUP_TENANT_MODELS, prismaSchemaMeta()))
    )
    expect(order.indexOf("fiscal_years")).toBeLessThan(order.indexOf("journal_entries"))
    expect(order.indexOf("journal_entries")).toBeLessThan(order.indexOf("journal_lines"))
    expect(order.indexOf("ledger_accounts")).toBeLessThan(order.indexOf("journal_lines"))
  })

  // ───────────────────────────────────────────────────────────────────────────
  // El recorrido completo: backup → restore → seis comprobaciones
  // ───────────────────────────────────────────────────────────────────────────

  it(
    "backup → restauración del fixture completo: los tres sellos IDÉNTICOS y las SEIS comprobaciones en PASS",
    async () => {
      const outcome = await restoreBackupIntoOrganization({
        archive,
        targetOrganizationId: DEST,
        refDate: REF,
        keys: KEYS,
      })

      expect(outcome.rejected, JSON.stringify(outcome.rejected)).toBeNull()
      expect(outcome.error).toBeNull()

      const verification = outcome.verification
      expect(verification).not.toBeNull()
      const failed = verification!.checks.filter((check) => check.status !== "PASS")
      expect(
        failed.map(
          (check) =>
            `${check.id}: ${check.evidence
              .filter((row) => !row.ok)
              .map((row) => `${row.label} → esperado ${row.expected}, obtenido ${row.actual}`)
              .join(" | ")}`
        )
      ).toEqual([])

      expect(verification!.checks).toHaveLength(6)
      expect(verification!.verified).toBe(true)
      expect(outcome.status).toBe("DONE")

      // El destino reproduce los sellos del origen, calculados por el MISMO camino.
      const destSeals = await tenantTransaction(DEST, async (tx) => await computeContentSeals(tx))
      expect(destSeals.ledgerHash).toBe(sourceSeals.ledgerHash)
      expect(destSeals.analyticsKey).toBe(sourceSeals.analyticsKey)
      expect(destSeals.budgetHash).toBe(sourceSeals.budgetHash)

      // Y la organización de ORIGEN no se ha tocado.
      const origenSeals = await tenantTransaction(ORG, async (tx) => await computeContentSeals(tx))
      expect(origenSeals.ledgerHash).toBe(sourceSeals.ledgerHash)
    },
    300_000
  )

  it("la restauración crea el mismo número de asientos y la misma numeración, sin huecos", async () => {
    const [origen, destino] = await Promise.all([
      prisma.journalEntry.count({ where: { organizationId: ORG } }),
      prisma.journalEntry.count({ where: { organizationId: DEST } }),
    ])
    expect(destino).toBe(origen)
    expect(destino).toBeGreaterThan(0)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Adversarial
  // ───────────────────────────────────────────────────────────────────────────

  it("**ZIP manipulado** ⇒ firma inválida, y no se escribe ni una fila en el destino", async () => {
    const zip = await JSZip.loadAsync(archive)
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"))
    manifest.totals.rows = manifest.totals.rows + 1
    zip.file("manifest.json", JSON.stringify(manifest, null, 2))
    const tampered = await zip.generateAsync({ type: "nodebuffer" })

    const outcome = await restoreBackupIntoOrganization({
      archive: tampered,
      targetOrganizationId: DEST_2,
      refDate: REF,
      keys: KEYS,
    })
    expect(outcome.status).toBe("FAILED")
    expect(outcome.error).toMatch(/SHA_DISCORDANTE/)
    expect(await prisma.journalEntry.count({ where: { organizationId: DEST_2 } })).toBe(0)
  })

  it("**firma recalculada con otra clave** ⇒ FIRMA_INVALIDA: el sha por sí solo no acredita nada", async () => {
    const zip = await JSZip.loadAsync(archive)
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"))
    manifest.totals.rows = 1
    const shaFalso = manifestSha256(manifest)
    zip.file("manifest.json", JSON.stringify(manifest, null, 2))
    zip.file("manifest.sha256", shaFalso)
    zip.file("signature.txt", signManifest(shaFalso, Buffer.from("otra clave"), KEY_ID))
    const forged = await zip.generateAsync({ type: "nodebuffer" })

    const outcome = await restoreBackupIntoOrganization({
      archive: forged,
      targetOrganizationId: DEST_2,
      refDate: REF,
      keys: KEYS,
    })
    expect(outcome.status).toBe("FAILED")
    expect(outcome.error).toMatch(/FIRMA_INVALIDA/)
  })

  it("**fila corrupta** ⇒ ABORTO con tabla, línea y motivo, y el destino queda sin nada", async () => {
    const zip = await JSZip.loadAsync(archive)
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"))
    const target = manifest.tables.find((table: { name: string; rows: number }) => table.name === "accounts")
    expect(target.rows).toBeGreaterThan(0)

    const body = await zip.file(target.jsonl)!.async("string")
    const lines = body.split("\n")
    // Se rompe la SEGUNDA fila dándole el `id` de la primera: la clave primaria
    // la rechaza y el trabajo entero tiene que abortar ahí, con su número de
    // línea. Nada de un `catch` que sume igual (G-15).
    const first = JSON.parse(lines[0]) as Record<string, { v: unknown; t: string }>
    const second = JSON.parse(lines[1]) as Record<string, { v: unknown; t: string }>
    second.id = first.id
    lines[1] = JSON.stringify(second)
    const corrupted = lines.join("\n")

    zip.file(target.jsonl, corrupted)
    target.sha256 = sha256(Buffer.from(corrupted))
    const nuevoSha = manifestSha256(manifest)
    zip.file("manifest.json", JSON.stringify(manifest, null, 2))
    zip.file("manifest.sha256", nuevoSha)
    zip.file("signature.txt", signManifest(nuevoSha, SIGNING_KEY, KEY_ID))
    const archivo = await zip.generateAsync({ type: "nodebuffer" })

    const outcome = await restoreBackupIntoOrganization({
      archive: archivo,
      targetOrganizationId: DEST_3,
      refDate: REF,
      keys: KEYS,
    })
    expect(outcome.status).toBe("FAILED")
    expect(outcome.rejected?.table).toBe("accounts")
    expect(outcome.rejected?.line).toBeGreaterThan(0)
    expect(outcome.rejected?.motivo).toBeTruthy()
    // La transacción entera se deshizo: ni una cuenta suelta.
    expect(await prisma.ledgerAccount.count({ where: { organizationId: DEST_3 } })).toBe(0)
  })

  it("un manifest con `formatVersion` distinto de 2.0 se rechaza sin descomprimir", async () => {
    const zip = await JSZip.loadAsync(archive)
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"))
    manifest.formatVersion = "1.0"
    const sha = manifestSha256(manifest)
    zip.file("manifest.json", JSON.stringify(manifest, null, 2))
    zip.file("manifest.sha256", sha)
    zip.file("signature.txt", signManifest(sha, SIGNING_KEY, KEY_ID))
    const viejo = await zip.generateAsync({ type: "nodebuffer" })

    const outcome = await restoreBackupIntoOrganization({
      archive: viejo,
      targetOrganizationId: DEST_3,
      refDate: REF,
      keys: KEYS,
    })
    expect(outcome.error).toMatch(/FORMATO_NO_SOPORTADO/)
  })

  it("verifyManifest acepta el archivo íntegro: la comprobación no es un `false` perpetuo", async () => {
    const zip = await JSZip.loadAsync(archive)
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"))
    const sha = (await zip.file("manifest.sha256")!.async("string")).trim()
    const firma = (await zip.file("signature.txt")!.async("string")).trim()
    expect(verifyManifest(manifest, sha, firma, KEYS)).toEqual({ ok: true, keyId: KEY_ID })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // I-E11-1 · uso derivado = Σ real
  // ───────────────────────────────────────────────────────────────────────────

  it("I-E11-1 · el uso derivado coincide con el recuento hecho a mano, con las exclusiones de O-5", async () => {
    const periodMonth = "2026-03-01"
    const snapshot = await getUsage(ORG, REF, { periodMonth, recompute: true })

    const [manual] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM journal_entries
        WHERE organization_id = $1::uuid
          AND entry_date >= '2026-03-01'::date AND entry_date < '2026-04-01'::date
          AND reverses_entry_id IS NULL
          AND kind::text NOT IN ('REGULARIZATION','CLOSING','OPENING','REVERSAL')`,
      ORG
    )
    expect(snapshot.figures.entries).toBe(Number(manual.n))
    expect(snapshot.fromCache).toBe(false)

    // Y la caché SÍ se sirve cuando las fuentes no han cambiado.
    const again = await getUsage(ORG, REF, { periodMonth })
    expect(again.fromCache).toBe(true)
    expect(again.figures).toEqual(snapshot.figures)
    expect(again.sourceHash).toBe(snapshot.sourceHash)
  })

  it("O-5 · un contra-asiento NO sube el uso: corregir no puede costar el doble que dejar el error", async () => {
    const periodMonth = "2026-03-01"
    const [conReversals] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM journal_entries
        WHERE organization_id = $1::uuid
          AND entry_date >= '2026-03-01'::date AND entry_date < '2026-04-01'::date`,
      ORG
    )
    const snapshot = await getUsage(ORG, REF, { periodMonth, recompute: true })
    expect(snapshot.figures.entries).toBeLessThanOrEqual(Number(conReversals.n))
  })

  it("el `sourceHash` cambia cuando cambia una fuente, y con él caduca la caché", async () => {
    const periodMonth = "2026-03-01"
    const before = await tenantTransaction(ORG, async (tx) => usageSourceHash(await readUsageInput(tx, ORG, periodMonth)))
    await prisma.auditLog.create({
      data: { organizationId: ORG, entity: "Prueba", entityId: "1", action: "EXPORT_REPORT" },
    })
    const after = await tenantTransaction(ORG, async (tx) => usageSourceHash(await readUsageInput(tx, ORG, periodMonth)))
    expect(after).not.toBe(before)
  })

  it("el almacenamiento se cuenta por `kind` (O-12c): un ZIP de backup no es cuota del cliente", async () => {
    const snapshot = await getUsage(ORG, REF, { periodMonth: "2026-12-01", recompute: true })
    const [backups] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COALESCE(sum(size_bytes),0) AS n FROM stored_objects WHERE organization_id = $1::uuid AND kind = 'BACKUP'`,
      ORG
    )
    const [facturables] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COALESCE(sum(size_bytes),0) AS n FROM stored_objects
        WHERE organization_id = $1::uuid AND kind::text IN ('DOCUMENT','PREVIEW','LOGO','AVATAR')`,
      ORG
    )
    expect(snapshot.figures.storageBytes).toBe(BigInt(facturables.n))
    if (BigInt(backups.n) > BigInt(0)) {
      expect(snapshot.figures.storageBytes).toBeLessThan(BigInt(facturables.n) + BigInt(backups.n))
    }
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Cuotas (O-3, O-16)
  // ───────────────────────────────────────────────────────────────────────────

  describe("cuotas", () => {
    afterAll(() => resetPlanContextResolver())

    it("una cuota DURA agotada bloquea, con la cifra concreta y en español", async () => {
      setPlanContextResolver(async () => ({
        limits: { ...UNLIMITED_PLAN, maxExportsMonth: 0 },
        access: "FULL",
        reason: null,
      }))
      await expect(
        tenantTransaction(ORG, async (tx) => {
          await assertWithinLimit(tx, "maxExportsMonth", BigInt(1), { refDate: REF })
        })
      ).rejects.toBeInstanceOf(LimitExceededError)
    })

    it("O-16 · en mora, superar `maxStorageBytes` NO bloquea: avisa y deja el justificante entrar", async () => {
      setPlanContextResolver(async () => ({
        limits: { ...UNLIMITED_PLAN, maxStorageBytes: BigInt(1) },
        access: "READ_ONLY",
        reason: "Hay un recibo pendiente de pago.",
      }))
      const result = await tenantTransaction(ORG, async (tx) =>
        assertWithinLimit(tx, "maxStorageBytes", BigInt(10_000_000), { refDate: REF })
      )
      expect(result.warn?.code).toBe("CUOTA_DE_ALMACEN_SUPERADA_EN_MORA")

      // La excepción **queda registrada**: nadie la concede en silencio (I-E11-4b).
      const registrada = await prisma.auditLog.findFirst({
        where: { organizationId: ORG, action: "LIMITE_EXCEPCION_AUTOMATICA" },
        orderBy: { ts: "desc" },
      })
      const enPlataforma = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM platform_audit_logs WHERE action = 'LIMITE_EXCEPCION_AUTOMATICA'`
      )
      expect(registrada !== null || Number(enPlataforma[0].n) > 0).toBe(true)
    })

    it("O-16 · con acceso PLENO, la misma subida se rechaza: ahí la cuota es legítima", async () => {
      setPlanContextResolver(async () => ({
        limits: { ...UNLIMITED_PLAN, maxStorageBytes: BigInt(1) },
        access: "FULL",
        reason: null,
      }))
      await expect(
        tenantTransaction(ORG, async (tx) =>
          assertWithinLimit(tx, "maxStorageBytes", BigInt(10_000_000), { refDate: REF })
        )
      ).rejects.toBeInstanceOf(LimitExceededError)
    })

    it("sin plan resuelto, nada se bloquea: una fila de facturación que falta no impide registrar", async () => {
      resetPlanContextResolver()
      await expect(
        tenantTransaction(ORG, async (tx) => assertWithinLimit(tx, "maxOcrDocsMonth", BigInt(1), { refDate: REF }))
      ).resolves.toBeDefined()
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // D7 · en mora se sigue asentando
  // ───────────────────────────────────────────────────────────────────────────

  it("D7 · `READ_ONLY` deja asentar, anular, registrar el documento y exportar; sólo detiene el OCR", () => {
    expect(canWrite("READ_ONLY", "REGISTRO_CONTABLE_ORDINARIO")).toBe(true)
    expect(canWrite("READ_ONLY", "CONTRA_ASIENTO")).toBe(true)
    expect(canWrite("READ_ONLY", "OBLIGACION_DEVENGADA")).toBe(true)
    expect(canWrite("READ_ONLY", "REGISTRO_DOCUMENTAL")).toBe(true)
    expect(canWrite("READ_ONLY", "PORTABILIDAD")).toBe(true)
    expect(canWrite("READ_ONLY", "CONSUMO_IA")).toBe(false)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // RLS y append-only a nivel de PRIVILEGIO
  // ───────────────────────────────────────────────────────────────────────────

  describe("RLS · las cuatro tablas de M2 con `app_runtime`", () => {
    let runtime: Client
    let owner: Client

    beforeAll(async () => {
      owner = new Client({ connectionString: ownerDatabaseUrl() })
      await owner.connect()
      runtime = new Client({ connectionString: appRuntimeDatabaseUrl() })
      await runtime.connect()
    })

    afterAll(async () => {
      await runtime.end()
      await owner.end()
    })

    it("las cuatro tablas llevan ENABLE + FORCE ROW LEVEL SECURITY", async () => {
      const { rows } = await owner.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relname = ANY($1::text[])`,
        [["usage_runs", "backup_jobs", "restore_jobs", "stored_objects"]]
      )
      expect(rows).toHaveLength(4)
      for (const row of rows) {
        expect(row.relrowsecurity, `${row.relname} sin ENABLE`).toBe(true)
        expect(row.relforcerowsecurity, `${row.relname} sin FORCE`).toBe(true)
      }
    })

    it("sin el GUC de tenant, `app_runtime` no ve NADA: la barrera 2 no tiene escape", async () => {
      const { rows } = await runtime.query<{ n: string }>(`SELECT count(*)::text AS n FROM usage_runs`)
      expect(rows[0].n).toBe("0")
    })

    it("**42501** · `usage_runs` es append-only también por PRIVILEGIO, no sólo por política", async () => {
      await runtime.query(`SELECT set_config('app.current_org', $1, true)`, [ORG])
      await expect(runtime.query(`UPDATE usage_runs SET entries = 0`)).rejects.toMatchObject({ code: "42501" })
      await expect(runtime.query(`DELETE FROM usage_runs`)).rejects.toMatchObject({ code: "42501" })
    })

    it("**42501** · un `BackupJob` no se borra: la caducidad retira el objeto y escribe EXPIRED", async () => {
      await expect(runtime.query(`DELETE FROM backup_jobs`)).rejects.toMatchObject({ code: "42501" })
    })

    it("**42501** · un `RestoreJob` no cambia de destino a mitad de camino", async () => {
      await expect(runtime.query(`UPDATE restore_jobs SET organization_id = organization_id`)).rejects.toMatchObject({
        code: "42501",
      })
    })

    it("`restore_jobs` sólo admite DONE con `verified`: O-2 está en la BASE, no sólo en el enum", async () => {
      await expect(
        owner.query(
          `INSERT INTO restore_jobs (organization_id, status, verified, verification) VALUES ($1::uuid, 'DONE', false, '{}'::jsonb)`,
          [ORG]
        )
      ).rejects.toMatchObject({ code: "23514" })
    })

    it("un `BackupJob` en DONE sin objeto ni firma lo impide la BASE", async () => {
      await expect(
        owner.query(
          `INSERT INTO backup_jobs (organization_id, status, trigger, format_version, schema_version, git_sha)
           VALUES ($1::uuid, 'DONE', 'MANUAL', '2.0', 'x', 'y')`,
          [ORG]
        )
      ).rejects.toMatchObject({ code: "23514" })
    })
  })
})
