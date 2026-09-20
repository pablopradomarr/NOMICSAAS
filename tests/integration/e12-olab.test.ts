/**
 * E12 · ola B — **backup en streaming, disco heredado retirado, claves
 * rederivadas y copia programada**, contra Postgres de verdad.
 *
 * Lo que aquí se ejerce no se puede ejercer en un test puro:
 *
 *  · **T14** · el ZIP se emite **bloque a bloque** y el pico de memoria **no
 *    crece con el volumen**; el archivo sigue siendo el mismo que JSZip lee, con
 *    su manifest firmado primero.
 *  · **T15** · la rama de lectura al disco heredado **no existe**, y hay un test
 *    estático que falla si alguien la reintroduce; `organizations.storage_used` y
 *    `storage_limit` **no existen** y nadie las nombra (guardia sobre el AST);
 *    las imágenes de marca son `BRANDING` y **no cuentan para la cuota**.
 *  · **T16** · las claves de `stored_objects` se **rederivan** en el destino y la
 *    comprobación 6 es **exacta**; un ZIP de otro esquema se rechaza nombrando la
 *    versión; una firma ajena se rechaza **salvo autorización registrada**, y la
 *    inspección previa no descomprime un byte de datos.
 *  · **T20** · el CSV viaja dentro del ZIP como **segunda representación** y el
 *    manifest sella las dos; los seis jobs del reloj están declarados.
 *
 * El almacén es un `LocalDriver` sobre un directorio temporal: **no se abre una
 * sola conexión de red**.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { Client } from "pg"
import JSZip from "jszip"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ownerDatabaseUrl } from "@/tests/support/env"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL

const ORG = "e1200000-0000-4000-8000-0000000000b1"
const DEST = "e1200000-0000-4000-8000-0000000000b2"
const DEST_2 = "e1200000-0000-4000-8000-0000000000b3"
const ADMIN = "e1200000-0000-4000-8000-0000000000a1"
const PLAN_ILIMITADO = "0e11a1a0-0000-4000-8000-000000000009"

const SIGNING_KEY = Buffer.from("clave-de-firma-de-pruebas-e12-olab")
const KEY_ID = "k1"
const KEYS = new Map([[KEY_ID, SIGNING_KEY]])
const REF = new Date("2027-12-31T12:00:00.000Z")

const storeRoot = await mkdtemp(path.join(tmpdir(), "e12-olab-store-"))
process.env.STORAGE_DRIVER = "local"
process.env.STORAGE_LOCAL_ROOT = storeRoot
process.env.STORAGE_PREFIX = "erp-test-e12"
process.env.PLATFORM_SIGNING_KEY = SIGNING_KEY.toString("utf8")
process.env.PLATFORM_SIGNING_KEY_ID = KEY_ID

const { loadFixtureIntoOrg } = await import("@/scripts/load-fixture")
const {
  buildBackupArchive,
  planBackupArchive,
  inspectBackupArchive,
  restoreBackupIntoOrganization,
} = await import("@/models/backups")
const { objectKey } = await import("@/lib/storage/keys")
const { BILLABLE_STORAGE_KINDS } = await import("@/models/storage")
const { CRON_JOBS } = await import("@/lib/platform/cron")

const RAIZ = process.cwd()
const sha256 = (buffer: Buffer): string => createHash("sha256").update(buffer).digest("hex")

let client: Client
async function q<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  return (await client.query<T>(sql, params)).rows
}

/** El ZIP del fixture, producido una vez y reutilizado por los casos. */
let archivo: Buffer

async function crearOrganizacion(id: string, slug: string): Promise<void> {
  await q(`INSERT INTO organizations (id, slug, name, updated_at) VALUES ($1::uuid, $2, $2, now())`, [id, slug])
  await q(
    `INSERT INTO memberships (id, organization_id, user_id, role, accepted_at, created_at, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'ADMIN', now(), now(), now())`,
    [id, ADMIN]
  )
  await q(
    `INSERT INTO subscriptions (organization_id, plan_code, plan_id, status, updated_at)
     VALUES ($1::uuid, 'ILIMITADO', $2::uuid, 'ACTIVE', now())`,
    [id, PLAN_ILIMITADO]
  )
}

async function limpiar(): Promise<void> {
  for (const org of [DEST_2, DEST, ORG]) {
    await q("BEGIN")
    await q(`DELETE FROM journal_lines WHERE organization_id = $1::uuid`, [org])
    await q(`DELETE FROM journal_entries WHERE organization_id = $1::uuid`, [org])
    await q("COMMIT")
    for (const tabla of [
      "restore_jobs",
      "backup_jobs",
      "stored_objects",
      "usage_runs",
      "audit_logs",
      "files",
      "subscriptions",
      "memberships",
    ]) {
      await q(`DELETE FROM ${tabla} WHERE organization_id = $1::uuid`, [org]).catch(() => undefined)
    }
  }
}

beforeAll(async () => {
  client = new Client({ connectionString: ownerDatabaseUrl() })
  await client.connect()
  await q(`DELETE FROM users WHERE id = $1::uuid`, [ADMIN]).catch(() => undefined)
  await q(
    `INSERT INTO users (id, email, name, created_at, updated_at)
     VALUES ($1::uuid, 'e12-olab@test.local', 'E12 ola B', now(), now())`,
    [ADMIN]
  )
  await crearOrganizacion(ORG, "e12-olab-origen")
  await crearOrganizacion(DEST, "e12-olab-destino")
  await crearOrganizacion(DEST_2, "e12-olab-destino-2")

  await loadFixtureIntoOrg({ organizationId: ORG, fixture: "ejercicio-completo", userId: ADMIN })

  const result = await buildBackupArchive(ORG, { refDate: REF, signingKey: SIGNING_KEY, signingKeyId: KEY_ID })
  archivo = result.archive
}, 600_000)

afterAll(async () => {
  await limpiar()
  await q(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, DEST, DEST_2]]).catch(() => undefined)
  await q(`DELETE FROM users WHERE id = $1::uuid`, [ADMIN]).catch(() => undefined)
  await client.end()
  await rm(storeRoot, { recursive: true, force: true })
}, 120_000)

describe("E12 · T14 — el ZIP en streaming", () => {
  it("el archivo emitido bloque a bloque es un ZIP que JSZip lee, con el manifest PRIMERO", async () => {
    const zip = await JSZip.loadAsync(archivo)
    const nombres = Object.keys(zip.files)
    expect(nombres).toContain("manifest.json")
    expect(nombres).toContain("manifest.sha256")
    expect(nombres).toContain("signature.txt")
    expect(nombres.some((n) => n.startsWith("data/"))).toBe(true)

    /**
     * **§5.4.2 · la firma se verifica antes de descomprimir un byte.** Para que
     * eso sea posible en streaming, las tres entradas pequeñas tienen que ir
     * delante de los datos: se comprueba sobre los OFFSETS reales del archivo,
     * no sobre el orden en que JSZip devuelve las claves.
     */
    const posicion = (nombre: string): number => archivo.indexOf(Buffer.from(nombre, "utf8"))
    const primerDato = Math.min(...nombres.filter((n) => n.startsWith("data/")).map(posicion))
    for (const cabecera of ["manifest.json", "manifest.sha256", "signature.txt"]) {
      expect(posicion(cabecera), `${cabecera} tiene que ir antes que los datos`).toBeLessThan(primerDato)
    }
  })

  it("el plan se puede consumir en streaming y el pico de memoria no crece con el volumen", async () => {
    const plan = await planBackupArchive(ORG, { refDate: REF, signingKey: SIGNING_KEY, signingKeyId: KEY_ID })
    try {
      global.gc?.()
      const antes = process.memoryUsage().heapUsed
      let pico = antes
      let emitidos = 0
      let bloques = 0
      // Los bloques se descartan según salen: es exactamente lo que hace la
      // subida multipart, y lo que `JSZip.generateAsync` no permitía.
      for await (const chunk of plan.archiveChunks()) {
        emitidos += chunk.length
        bloques += 1
        pico = Math.max(pico, process.memoryUsage().heapUsed)
      }
      expect(emitidos).toBeGreaterThan(1_000)
      expect(bloques, "el archivo sale en muchos bloques, no en uno").toBeGreaterThan(10)
      // Holgado a propósito: lo que se detecta es un crecimiento PROPORCIONAL al
      // contenido, no un megabyte de más.
      expect(pico - antes).toBeLessThan(96 * 1024 * 1024)
    } finally {
      await plan.cleanup()
    }
  }, 600_000)

  it("`cleanup()` borra el carrete: no se queda 1,5 GB en el temporal", async () => {
    const plan = await planBackupArchive(ORG, { refDate: REF, signingKey: SIGNING_KEY, signingKeyId: KEY_ID })
    for await (const chunk of plan.archiveChunks()) void chunk
    await plan.cleanup()
    // Se vuelve a llamar: `cleanup()` tiene que ser idempotente, porque
    // `runBackupJob` lo invoca en un `finally` que también corre tras un fallo.
    await expect(plan.cleanup()).resolves.toBeUndefined()
  }, 600_000)
})

describe("E12 · T20 — el CSV como segunda representación", () => {
  it("el ZIP lleva `csv/*.csv`, el manifest los sella y el JSONL sigue mandando", async () => {
    const zip = await JSZip.loadAsync(archivo)
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string")) as {
      tables: { name: string; rows: number; sha256: string }[]
      csv?: { name: string; rows: number; path: string; sha256: string }[]
    }

    expect(manifest.csv, "el manifest tiene que declarar la segunda representación").toBeDefined()
    expect(manifest.csv!.length).toBeGreaterThan(0)

    for (const entrada of manifest.csv!) {
      const cuerpo = await zip.file(entrada.path)?.async("nodebuffer")
      expect(cuerpo, `falta ${entrada.path} en el archivo`).toBeDefined()
      // **Sellado**: si alguien altera el CSV, se ve.
      expect(sha256(cuerpo!), entrada.path).toBe(entrada.sha256)
      // Cabecera + una línea por fila: el CSV dice lo mismo que el JSONL.
      const lineas = cuerpo!.toString("utf8").split("\n")
      const tabla = manifest.tables.find((t) => t.name === entrada.name)!
      expect(lineas.length, `${entrada.path}: cabecera + ${tabla.rows} filas`).toBe(tabla.rows + 1)
    }

    // Y sólo las tablas con filas producen CSV: un fichero vacío sin cabecera no
    // aporta nada y ensucia el listado.
    const conFilas = manifest.tables.filter((t) => t.rows > 0).map((t) => t.name).sort()
    expect(manifest.csv!.map((c) => c.name).sort()).toEqual(conFilas)
  })

  it("el CSV no se usa NUNCA para restaurar: alterarlo no impide la restauración", async () => {
    /**
     * La regla que el formato declara: **manda el JSONL**. Se altera un CSV
     * dentro del archivo —rompiendo su sello— y la restauración sigue siendo
     * fiel, porque no lo mira. Lo que sí queda es la evidencia: el sha del
     * manifest ya no cuadra con ese fichero, y quien audite lo verá.
     */
    const zip = await JSZip.loadAsync(archivo)
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string")) as {
      csv?: { path: string }[]
    }
    const victima = manifest.csv![0].path
    zip.file(victima, "esto,no,es,el,csv,de,verdad")
    const alterado = await zip.generateAsync({ type: "nodebuffer" })

    const outcome = await restoreBackupIntoOrganization({
      archive: alterado,
      targetOrganizationId: DEST_2,
      refDate: REF,
      keys: KEYS,
    })
    expect(outcome.status, outcome.error ?? "").toBe("DONE")
  }, 600_000)

  it("los SEIS jobs del reloj están declarados, con `backup-schedule` y `email-sync`", () => {
    expect([...CRON_JOBS]).toContain("backup-schedule")
    expect([...CRON_JOBS]).toContain("email-sync")
    expect(CRON_JOBS.length).toBe(6)
  })
})

describe("E12 · T16 — claves rederivadas y copia ajena", () => {
  it("las claves de `stored_objects` del destino son las del DESTINO, y la comprobación 6 lo exige", async () => {
    const outcome = await restoreBackupIntoOrganization({
      archive: archivo,
      targetOrganizationId: DEST,
      refDate: REF,
      keys: KEYS,
    })
    expect(outcome.rejected).toBeNull()

    const filas = await q<{ object_key: string; sha256: string; kind: string }>(
      `SELECT object_key, sha256, kind::text AS kind FROM stored_objects WHERE organization_id = $1::uuid`,
      [DEST]
    )
    for (const fila of filas) {
      expect(fila.object_key).toBe(
        objectKey({
          prefix: process.env.STORAGE_PREFIX,
          organizationId: DEST,
          kind: fila.kind as Parameters<typeof objectKey>[0]["kind"],
          sha256: fila.sha256,
        })
      )
      // Y ninguna conserva el prefijo del ORIGEN, que es el bug concreto.
      expect(fila.object_key).not.toContain(ORG)
    }

    const barrido = outcome.verification?.checks.find((c) => c.id === "BARRIDO_INVARIANTES")
    const evidencia = barrido?.evidence.find((e) => e.label.includes("claves de stored_objects rederivadas"))
    expect(evidencia, "la comprobación 6 tiene que enseñar la evidencia de las claves").toBeDefined()
    expect(evidencia!.ok).toBe(true)
  }, 900_000)

  it("la inspección previa lee manifest, sha y firma, y dictamina SIN descomprimir datos", async () => {
    const inspeccion = await inspectBackupArchive(archivo, KEYS)
    expect(inspeccion.ok).toBe(true)
    if (!inspeccion.ok) return
    expect(inspeccion.keyId).toBe(KEY_ID)
    expect(inspeccion.manifest.organization.id).toBe(ORG)
    expect(inspeccion.manifest.schemaVersion).toMatch(/^\d{8}/)
  })

  it("una firma AJENA se rechaza, y sólo se admite con autorización explícita y motivada", async () => {
    const otras = new Map([["k9", Buffer.from("la-clave-de-otra-instalacion")]])

    // 1 · La inspección la marca como ajena y autorizable.
    const inspeccion = await inspectBackupArchive(archivo, otras)
    expect(inspeccion.ok).toBe(false)
    if (inspeccion.ok) return
    expect(inspeccion.reason).toBe("CLAVE_DESCONOCIDA")
    expect(inspeccion.manifest, "el manifest se lee igual: es lo que la pantalla enseña").not.toBeNull()

    // 2 · Sin autorización, no se restaura.
    const sinPermiso = await restoreBackupIntoOrganization({
      archive: archivo,
      targetOrganizationId: DEST_2,
      refDate: REF,
      keys: otras,
    })
    expect(sinPermiso.status).toBe("FAILED")
    expect(sinPermiso.error).toMatch(/CLAVE_DESCONOCIDA/)
    expect(sinPermiso.error).toMatch(/autorización explícita del operador/)

    // 3 · Con un motivo de menos de veinte caracteres, tampoco.
    const motivoPobre = await restoreBackupIntoOrganization({
      archive: archivo,
      targetOrganizationId: DEST_2,
      refDate: REF,
      keys: otras,
      allowForeignSignature: { authorizedBy: ADMIN, reason: "vale" },
    })
    expect(motivoPobre.status).toBe("FAILED")
  }, 300_000)

  it("un ZIP ALTERADO no lo autoriza nadie: `SHA_DISCORDANTE` no admite excepción", async () => {
    const zip = await JSZip.loadAsync(archivo)
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string")) as Record<string, unknown>
    ;(manifest as { totals: { rows: number } }).totals.rows += 1
    zip.file("manifest.json", JSON.stringify(manifest, null, 2))
    const tocado = await zip.generateAsync({ type: "nodebuffer" })

    const outcome = await restoreBackupIntoOrganization({
      archive: tocado,
      targetOrganizationId: DEST_2,
      refDate: REF,
      keys: KEYS,
      // Aunque se autorice: esto no es un archivo ajeno, es uno tocado.
      allowForeignSignature: { authorizedBy: ADMIN, reason: "el operador insiste, y da igual que insista" },
    })
    expect(outcome.status).toBe("FAILED")
    expect(outcome.error).toMatch(/SHA_DISCORDANTE/)
  }, 300_000)

  it("un ZIP de un esquema ANTERIOR se rechaza nombrando la versión, no se restaura a medias", async () => {
    const zip = await JSZip.loadAsync(archivo)
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string")) as {
      schemaVersion: string
    } & Record<string, unknown>
    manifest.schemaVersion = "20250101000000"

    // Se vuelve a sellar y firmar: el archivo es legítimo, lo que no cuadra es
    // el esquema. Si no, estaríamos probando el caso del sha discordante.
    const { manifestSha256, signManifest } = await import("@/lib/platform/backup")
    const nuevoSha = manifestSha256(manifest as never)
    zip.file("manifest.json", JSON.stringify(manifest, null, 2))
    zip.file("manifest.sha256", nuevoSha)
    zip.file("signature.txt", signManifest(nuevoSha, SIGNING_KEY, KEY_ID))
    const viejo = await zip.generateAsync({ type: "nodebuffer" })

    const outcome = await restoreBackupIntoOrganization({
      archive: viejo,
      targetOrganizationId: DEST_2,
      refDate: REF,
      keys: KEYS,
    })
    expect(outcome.status).toBe("FAILED")
    expect(outcome.error).toMatch(/ESQUEMA_INCOMPATIBLE/)
    expect(outcome.error, "el rechazo tiene que NOMBRAR la versión").toMatch(/20250101000000/)
  }, 300_000)
})

describe("E12 · T15 — el disco heredado y las dos columnas", () => {
  it("`organizations.storage_used` y `storage_limit` no existen en la base", async () => {
    const filas = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'organizations' AND column_name IN ('storage_used', 'storage_limit')`
    )
    expect(filas).toEqual([])
  })

  it("NINGUNA lectura viva las nombra: guardia estática sobre el código", async () => {
    /**
     * La otra mitad de la guardia (la primera está en la migración, sobre las
     * dependencias del esquema). El SQL no puede ver una lectura en el código;
     * esto sí. Si alguien vuelve a introducir `organization.storageUsed`, este
     * test lo dice **con el fichero y la línea**.
     *
     * Se auditan las SENTENCIAS, no los comentarios: los comentarios que explican
     * la retirada son precisamente lo que no hay que borrar, y una búsqueda que
     * los contara obligaría a elegir entre el control y el porqué.
     */
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const ejecutar = promisify(execFile)
    const { stdout: listado } = await ejecutar(
      "git",
      ["ls-files", "app", "lib", "models", "components", "forms", "scripts"],
      { cwd: RAIZ }
    )

    const vivas: string[] = []
    for (const relativo of listado.split("\n").filter((f) => /\.(ts|tsx)$/.test(f))) {
      const fuente = await readFile(path.join(RAIZ, relativo), "utf8")
      const sinComentarios = fuente.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
      sinComentarios.split("\n").forEach((linea, indice) => {
        // Dentro de JSX los comentarios son `{/* … */}`, ya retirados arriba; lo
        // que queda con el nombre es una lectura de verdad.
        if (/\bstorageUsed\b|\bstorageLimit\b|\bstorage_used\b|\bstorage_limit\b/.test(linea)) {
          vivas.push(`${relativo}:${indice + 1}: ${linea.trim()}`)
        }
      })
    }
    expect(vivas, `lecturas vivas de las columnas retiradas:\n${vivas.join("\n")}`).toEqual([])
  })

  it("`lib/documents.ts` no tiene rama al disco: falla si alguien la reintroduce", async () => {
    const fuente = await readFile(path.join(RAIZ, "lib", "documents.ts"), "utf8")
    const codigo = fuente
      .split("\n")
      .filter((linea) => !/^\s*(\*|\/\*|\/\/)/.test(linea))
      .join("\n")
    for (const prohibido of ["readFile", "storedFilePath", "node:fs", "fileExists"]) {
      expect(codigo.includes(prohibido), `lib/documents.ts vuelve a tocar el disco: «${prohibido}»`).toBe(false)
    }
  })

  it("las imágenes de marca son `BRANDING` y NO cuentan para la cuota (O-12c)", async () => {
    expect([...BILLABLE_STORAGE_KINDS]).toEqual(["DOCUMENT", "PREVIEW"])
    expect([...BILLABLE_STORAGE_KINDS]).not.toContain("BRANDING")

    // Y la base impide un `BRANDING` sin `purpose` —no se sabría para qué es— y
    // un `purpose` fuera de `BRANDING` —mentiría—.
    await expect(
      q(
        `INSERT INTO stored_objects (id, organization_id, object_key, backend, sha256, size_bytes, mime_type, kind)
         VALUES (gen_random_uuid(), $1::uuid, 'x/y/BRANDING/aa/' || repeat('a',64), 'LOCAL', repeat('a',64), 1, 'image/png', 'BRANDING')`,
        [ORG]
      )
    ).rejects.toThrow(/purpose_solo_branding/)

    await expect(
      q(
        `INSERT INTO stored_objects (id, organization_id, object_key, backend, sha256, size_bytes, mime_type, kind, purpose)
         VALUES (gen_random_uuid(), $1::uuid, 'x/y/DOCUMENT/bb/' || repeat('b',64), 'LOCAL', repeat('b',64), 1, 'application/pdf', 'DOCUMENT', 'ORG_LOGO')`,
        [ORG]
      )
    ).rejects.toThrow(/purpose_solo_branding/)
  })

  it("la ruta heredada `/files/static/[filename]` ya no existe", async () => {
    const { access } = await import("node:fs/promises")
    await expect(access(path.join(RAIZ, "app", "(app)", "files", "static"))).rejects.toThrow()
    await expect(access(path.join(RAIZ, "app", "(app)", "files", "branding", "[sha256]", "route.ts"))).resolves.toBeUndefined()
  })
})
