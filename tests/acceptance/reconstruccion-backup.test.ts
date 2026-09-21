/**
 * E12 · T11 — **«reconstrucción desde backup»** (§4.2 del diseño).
 *
 * **P7 en su forma fuerte**, y el paso que E11 no llegó a dar: no basta con que
 * una copia se restaure; hay que **destruir el original** y comprobar que lo que
 * queda dice exactamente lo mismo.
 *
 *   1. Fixture completo en la organización **A**.
 *   2. Copia por la **acción real** de `/settings/backups`, no por un helper.
 *   3. **Se destruye A**: borrado físico en la base de trabajo.
 *   4. Restauración a **B** desde el ZIP, por la acción real.
 *   5. Las **seis comprobaciones** de §5.4 de E11 en verde, `verified = true`.
 *   6. Y lo que E12 añade: las **12 cifras** y los **cinco sellos** de B son
 *      idénticos a los que A tenía, y `scripts/audit-reconstruct.ts` corre sobre
 *      B con **Δ = 0**.
 *   7. El cruce con §4.1: **purga de derivados en B → regenerar → idénticos otra
 *      vez**. Reconstruir desde cero, dos veces, por dos caminos, y que salga lo
 *      mismo: eso es P7.
 *
 * Y **cinco casos negativos**: manifest alterado, firma ajena, `entryNumber`
 * intercambiados, `AuditLog` mermado y —el que E12 añade— un ZIP de una versión
 * de esquema anterior, que se rechaza **nombrando `schemaVersion`** en vez de
 * restaurar «lo que se pueda».
 *
 * ## Por qué las cifras de A se leen ANTES de destruirla
 *
 * Porque después no hay dónde leerlas, y porque compararlas con las de B
 * *después* de restaurar sería comparar B consigo misma. Se leen, se congelan en
 * una cadena canónica y se destruye A. Lo que se enfrenta es una foto tomada
 * cuando el original existía.
 */

import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const cookieStore = { get: () => undefined, set: () => {}, delete: () => {} }
vi.mock("next/headers", () => ({ cookies: async () => cookieStore }))
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }))
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("redirect")
  },
  notFound: () => {
    throw new Error("notFound")
  },
}))
vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => usuarioActual,
  getSession: async () => ({ user: usuarioActual }),
  isSubscriptionExpired: () => false,
  isAiBalanceExhausted: () => false,
}))

let usuarioActual: { id: string; email: string; name: string } = { id: "", email: "", name: "" }

/** El almacén de la suite: un directorio temporal, nunca una red. */
const storeRoot = await mkdtemp(path.join(tmpdir(), "e12-t11-store-"))
process.env.STORAGE_DRIVER = "local"
process.env.STORAGE_BACKEND = "local"
process.env.STORAGE_LOCAL_ROOT = storeRoot
process.env.STORAGE_PREFIX = "erp-t11"
process.env.PLATFORM_SIGNING_KEY = "clave-de-firma-de-la-aceptacion-t11"
process.env.PLATFORM_SIGNING_KEY_ID = "k1"

const {
  ACCEPTANCE_GIT_SHA,
  CANONICAL_FIGURES,
  REF_DATE,
  SEAL_NAMES,
  ValidacionRecorder,
  acceptanceUserId,
  disconnect,
  dropAcceptanceOrg,
  readCanonical,
  withMaintenance,
} = await import("@/tests/acceptance/harness")
type AcceptanceOrg = { organizationId: string; userId: string; fiscalYearId: string; slug: string }
type CanonicalReading = Awaited<ReturnType<typeof readCanonical>>

const { prisma, tenantTransaction } = await import("@/lib/db")
const { restoreBackupIntoOrganization, signingKeyFromEnv } = await import("@/models/backups")
const { requestBackupAction } = await import("@/app/(app)/settings/backups/actions")
const { purgeDerived } = await import("@/models/purge-derived")
const { loadFixtureIntoOrg } = await import("@/scripts/load-fixture")
const { manifestSha256, signManifest } = await import("@/lib/platform/backup")
const { getObjectBuffer } = await import("@/models/storage")
const { createOrganizationWithOwner } = await import("@/models/organizations")
const JSZip = (await import("jszip")).default

const COMPONENTE = "t11-reconstruccion"
const registro = new ValidacionRecorder(COMPONENTE)
const ejecutar = promisify(execFile)

let origen: AcceptanceOrg
let destino: AcceptanceOrg
/** El ZIP que produjo la acción real sobre A. */
let archivo: Buffer
/** La foto de A, tomada mientras A existía. */
let fotoDeA: string
let lecturaDeA: CanonicalReading

const KEYS = (): Map<string, Buffer> => {
  const { key, keyId } = signingKeyFromEnv()
  return new Map([[keyId, key]])
}

/** Las líneas en las que dos formas canónicas difieren. Un diff de 19 líneas
 *  enteras no lo lee nadie; lo que hay que ver es QUÉ cifra o QUÉ sello se ha
 *  movido. */
function diferencias(a: string, b: string): string[] {
  const izquierda = new Map(a.split("\n").map((linea) => [linea.split("=")[0], linea.split("=").slice(1).join("=")]))
  const derecha = new Map(b.split("\n").map((linea) => [linea.split("=")[0], linea.split("=").slice(1).join("=")]))
  const claves = [...new Set([...izquierda.keys(), ...derecha.keys()])].sort()
  return claves
    .filter((clave) => izquierda.get(clave) !== derecha.get(clave))
    .map((clave) => `${clave}: A=${izquierda.get(clave) ?? "∅"} · B=${derecha.get(clave) ?? "∅"}`)
}

/**
 * **`analyticsKey` no es comparable entre organizaciones, y esto es un hallazgo
 * de T11, no una excusa.**
 *
 * El sello analítico que guardan `InvariantRun` y `ReportRun` lo compone
 * `lib/analytics/hash.ts` sobre `entryId`, `projectId`, `costCenterId` y
 * `businessLineId` — **uuid**. La restauración reasigna todos los uuid (tiene
 * que hacerlo: las claves primarias son globales y el original puede seguir
 * vivo), así que ese sello **no puede** coincidir en la copia. No es una
 * infidelidad: es un sello de detección de mutaciones DENTRO de una
 * organización, de la misma naturaleza que `journal_entries.entry_hash`, que
 * E11 ya declaró no comparable y recomputa fila a fila (`ROW_SEALS_WITH_UUID`).
 *
 * Lo que SÍ es comparable —y lo que la comprobación 5 enfrenta byte a byte— es
 * el `analyticsKey` de `computeContentSeals`, definido sobre **claves
 * naturales**: fecha, número de asiento y los CÓDIGOS de proyecto, CECO y línea
 * de negocio. Ése coincide, y es el que acredita que la analítica de B dice lo
 * mismo que la de A.
 *
 * **La consecuencia queda ESCRITA, no tapada**: mientras la forma canónica del
 * sello analítico lleve uuid, una copia restaurada tendrá un `analyticsKey`
 * distinto al del original aunque su analítica sea idéntica. Alinearlos exige
 * reescribir `canonicalAnalyticsForm` sobre claves naturales, que es **Nivel 2**
 * (ADR-0011) e invalida todos los sellos ya emitidos. Se levanta como hallazgo
 * de T11.
 */
const SELLOS_COMPARABLES = SEAL_NAMES.filter((nombre) => nombre !== "analyticsKey")

/** La forma canónica que se compara **byte a byte**: 12 cifras y 4 sellos. */
function formaCanonica(lectura: CanonicalReading): string {
  const cifras = Object.keys(lectura.figures)
    .sort()
    .map((clave) => `${clave}=${lectura.figures[clave]}`)
  const sellos = [...SELLOS_COMPARABLES].sort().map((nombre) => `${nombre}=${lectura.seals[nombre]}`)
  return [...cifras, ...sellos].join("\n")
}

/** Un ZIP derivado del bueno, con una entrada cambiada y re-firmado o no. */
async function zipCon(
  cambios: (zip: JSZip) => Promise<void>,
  opciones: { refirmarCon?: Buffer } = {}
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(archivo)
  await cambios(zip)
  if (opciones.refirmarCon) {
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"))
    const sha = manifestSha256(manifest)
    zip.file("manifest.sha256", sha)
    zip.file("signature.txt", signManifest(sha, opciones.refirmarCon, "k1"))
  }
  return await zip.generateAsync({ type: "nodebuffer" })
}

beforeAll(async () => {
  /**
   * **A y B nacen IGUAL, y eso es parte del test.**
   *
   * La comprobación 6 es de *fidelidad*: enfrenta los invariantes en FAIL del
   * origen con los del destino. Si A la creara el arnés con `INSERT` directos y
   * B la creara el producto, dos invariantes de plataforma —I-E11-5 (estado ⇔
   * acceso, que exige la suscripción que ADR-0019 D9 siembra en el alta)— darían
   * FAIL en A y PASS en B, y la comprobación cantaría una infidelidad que no
   * existe: lo que habría cambiado es cómo se creó la organización, no lo que la
   * copia conserva.
   *
   * Así que las dos se crean por el camino del producto,
   * `createOrganizationWithOwner`, que es además lo que hace `startRestoreAction`.
   * Es la lección H-6 de E8 otra vez: un test que se siembra a sí mismo prueba el
   * arnés.
   */
  const userId = acceptanceUserId(`${COMPONENTE}-a`)
  await prisma.user.deleteMany({ where: { id: userId } })
  await prisma.user.create({ data: { id: userId, email: `acc-${COMPONENTE}-a@test.local`, name: "Aceptación T11" } })
  usuarioActual = { id: userId, email: `acc-${COMPONENTE}-a@test.local`, name: "Aceptación T11" }

  const orgA = await createOrganizationWithOwner(
    { name: `${COMPONENTE} origen`, baseCurrency: "EUR", timezone: "Europe/Madrid", pgcVariant: "PYMES" },
    userId,
    new Date(`${REF_DATE}T12:00:00.000Z`)
  )
  const informe = await loadFixtureIntoOrg({ fixture: "ejercicio-completo", organizationId: orgA.id, userId })
  if (informe.mismatches.length > 0) {
    throw new Error(`el fixture no reproduce sus cifras selladas: ${informe.mismatches.join(" · ")}`)
  }
  const fiscalYearId = await tenantTransaction(orgA.id, userId, async (tx) =>
    (await tx.fiscalYear.findFirstOrThrow({ where: { code: "2026" } })).id
  )
  origen = { organizationId: orgA.id, userId, fiscalYearId, slug: orgA.slug }
  registro.org(origen.organizationId)

  // 1 · la foto de A, **mientras A existe**.
  lecturaDeA = await readCanonical(origen)
  fotoDeA = formaCanonica(lecturaDeA)
  registro.hash(lecturaDeA.seals.ledgerHash)
  registro.seal(lecturaDeA.sello.sello, lecturaDeA.sello.motivos)

  /**
   * **Los FAIL del ORIGEN, escritos antes de destruirlo.** La comprobación 6 es
   * relativa (`destino ≡ origen`, H-6 de E11): si algo falla luego, lo primero
   * que hay que poder mirar es qué fallaba ya en A, y después de destruirla no
   * hay dónde.
   */
  for (const check of lecturaDeA.checks.filter((c) => c.status === "FAIL")) {
    registro.add(`T11-origen-${check.id}`, "INFO", `en A ya fallaba: ${check.evidencia.slice(0, 500)}`)
  }

  // 2 · la copia, **por la acción real**. No por `buildBackupArchive`: lo que
  // T11 acredita es que el camino que un cliente usa produce una copia que se
  // puede restaurar, no que una función del modelo sabe hacerlo.
  const resultado = await requestBackupAction("MANUAL")
  if (!resultado.success || !resultado.data) {
    throw new Error(`la acción de copia falló: ${resultado.error ?? "sin motivo"}`)
  }
  if (resultado.data.status !== "DONE") {
    throw new Error(`la copia terminó en ${resultado.data.status}: ${resultado.data.error ?? "sin motivo"}`)
  }

  const job = await tenantTransaction(origen.organizationId, origen.userId, async (tx) =>
    await tx.backupJob.findFirstOrThrow({ where: { id: resultado.data!.backupJobId } })
  )
  archivo = await tenantTransaction(origen.organizationId, origen.userId, async (tx) =>
    await getObjectBuffer(tx, job.objectKey!)
  )
}, 900_000)

afterAll(async () => {
  await registro.write()
  // Ahora sí, también el usuario: la suite no deja nada detrás.
  if (destino) await dropAcceptanceOrg({ organizationId: destino.organizationId }).catch(() => undefined)
  await dropAcceptanceOrg(origen).catch(() => undefined)
  await disconnect()
  await rm(storeRoot, { recursive: true, force: true })
}, 600_000)

describe("E12 · T11 — A → ZIP → destruir A → restaurar B", () => {
  it("criterio 35 · destruida A y restaurada B: las siete comprobaciones en verde y `verified = true`", async () => {
    expect(archivo.length, "la acción real tiene que haber dejado un ZIP en el almacén").toBeGreaterThan(1_000)

    /**
     * **3 · se destruye A.** Borrado físico, no marcado como inactiva: lo que P7
     * afirma es que los libros se pueden reconstruir **sin el original**, y
     * dejarlo vivo convertiría el test en «restaurar una copia al lado», que es
     * lo que E11 ya probaba.
     */
    /**
     * **Se destruye la ORGANIZACIÓN, no el usuario.** Un `User` es global: no
     * pertenece a ninguna organización, no viaja en el ZIP y las columnas que lo
     * apuntan (`user_id`, `posted_by_id`) se restauran **intactas** a propósito
     * (ver `applyRemap`). Borrarlo aquí no probaría «reconstruir sin el
     * original», probaría «restaurar en una instalación donde el operador ya no
     * existe», que es otro caso y ni siquiera es el de P7.
     */
    await dropAcceptanceOrg({ organizationId: origen.organizationId })
    const quedan = await withMaintenance(async (client) => {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM journal_lines WHERE organization_id = $1::uuid`,
        [origen.organizationId]
      )
      return Number(rows[0]?.n ?? 0)
    })
    expect(quedan, "A no se ha destruido: el test compararía B con un original vivo").toBe(0)
    registro.add("T11-a-destruida", "PASS", "la organización de origen ya no tiene ni una línea de diario")

    /**
     * **4 · B nace como la crea el producto**, no como la crearía un arnés:
     * `createOrganizationWithOwner` con el MISMO usuario, que es lo que hace
     * `startRestoreAction`. Importa para el recuento: la copia trae la membresía
     * de ese usuario, y la organización de destino nace ya con la suya. Si B
     * naciera con un usuario distinto, el destino acabaría con DOS membresías y
     * la comprobación 1 —que compara con `=` y no con `⊇`— lo diría, con razón.
     */
    const nueva = await createOrganizationWithOwner(
      { name: `${COMPONENTE} restaurada`, baseCurrency: "EUR", timezone: "Europe/Madrid", pgcVariant: "PYMES" },
      origen.userId,
      new Date(`${REF_DATE}T12:00:00.000Z`)
    )
    destino = { organizationId: nueva.id, userId: origen.userId, fiscalYearId: "", slug: nueva.slug }
    const outcome = await restoreBackupIntoOrganization({
      archive: archivo,
      targetOrganizationId: destino.organizationId,
      requestedById: destino.userId,
      refDate: new Date(`${REF_DATE}T12:00:00.000Z`),
      keys: KEYS(),
    })

    expect(outcome.rejected, `fila rechazada: ${JSON.stringify(outcome.rejected)}`).toBeNull()
    expect(outcome.error, outcome.error ?? "").toBeNull()

    // 5 · **las SIETE**, nombradas. Que estén todas es parte del criterio: una
    // verificación de cinco no acredita nada (O-2). La séptima —`COBERTURA_
    // INVENTARIO`— la añade la ronda 1 de E12 (auditor H-6): sin ella, quitar
    // una tabla del ZIP **y** del manifest a la vez pasaba las seis.
    // Diagnóstico permanente: el barrido del DESTINO, entero, en el
    // `validacion.json`. La comprobación 6 sólo publica los identificadores que
    // fallan; cuando algo no cuadra, lo que hace falta es la evidencia.
    {
      const { runLedgerInvariants } = await import("@/models/ledger")
      const barrido = await runLedgerInvariants(destino.organizationId, {
        refDate: REF_DATE,
        audit: true,
        noCache: true,
      })
      for (const check of barrido.validacion.checks.filter((c) => c.status !== "PASS")) {
        registro.add(`T11-destino-${check.id}`, "INFO", `en B: ${check.status} · ${check.evidencia.slice(0, 500)}`)
      }
    }

    const ids = (outcome.verification?.checks ?? []).map((check) => check.id).sort()
    expect(ids).toEqual([
      "AUDIT_LOG",
      "BARRIDO_INVARIANTES",
      "COBERTURA_INVENTARIO",
      "NUMERACION",
      "RECUENTOS",
      "SELLOS_DERIVADOS",
      "SELLOS_Y_CIERRE",
    ])
    for (const check of outcome.verification?.checks ?? []) {
      const enRojo = check.evidence.filter((fila) => !fila.ok)
      const detalle = enRojo.map((fila) => `${fila.label}: esperado ${fila.expected}, hay ${fila.actual}`).join(" · ")
      registro.assert(
        `T11-check-${check.id}`,
        check.status === "PASS",
        `${check.title}: ${check.status}${check.status === "PASS" ? "" : ` · ${detalle || check.note || "sin detalle"}`}`
      )
      expect(check.status, `${check.id}: ${detalle || check.note || ""}`).toBe("PASS")
    }
    expect(outcome.verification?.verified).toBe(true)
    expect(outcome.status).toBe("DONE")
  }, 1_800_000)

  it("criterio 35 bis · las 12 cifras y los 5 sellos de B son los de A, byte a byte", async () => {
    // El ejercicio de B es el restaurado: se localiza por su código, igual que
    // hace el harness con el de A.
    const fiscalYearId = await tenantTransaction(destino.organizationId, destino.userId, async (tx) =>
      (await tx.fiscalYear.findFirstOrThrow({ where: { code: "2026" } })).id
    )
    const lecturaDeB = await readCanonical({ ...destino, fiscalYearId })
    const fotoDeB = formaCanonica(lecturaDeB)

    registro.assert(
      "I-E12-1-reconstruccion",
      fotoDeB === fotoDeA,
      fotoDeB === fotoDeA
        ? "las 12 cifras y los 5 sellos de la copia son idénticos a los del original destruido"
        : `DIFIEREN en: ${diferencias(fotoDeA, fotoDeB).join(" · ")}`
    )
    expect(fotoDeB).toBe(fotoDeA)

    // Y las cifras son además las CONGELADAS del diseño: que coincidan entre A y
    // B no vale si coinciden en el valor equivocado.
    expect(lecturaDeB.figures.RESULTADO).toBe(CANONICAL_FIGURES.RESULTADO)
    expect(lecturaDeB.figures.MC3).toBe(CANONICAL_FIGURES.MC3)
    expect(lecturaDeB.figures.BAI).toBe(CANONICAL_FIGURES.BAI)
    expect(lecturaDeB.figures.ACTIVO).toBe(lecturaDeB.figures.PN_MAS_PASIVO)

    /**
     * **El quinto sello, enfrentado por donde SÍ se puede.** `analyticsKey` de
     * `InvariantRun` lleva uuid; el de `computeContentSeals` va sobre claves
     * naturales y es el que el manifest sella y la comprobación 5 verifica. Si
     * la analítica de B no dijera lo mismo que la de A, es este el que se
     * movería — y aquí se enfrenta explícitamente, para que el hallazgo no se
     * convierta en «hay un sello que no comparamos».
     */
    const { computeContentSeals } = await import("@/models/backups")
    const sellosDeB = await tenantTransaction(destino.organizationId, destino.userId, async (tx) =>
      await computeContentSeals(tx)
    )
    const manifestDeA = JSON.parse(
      await (await JSZip.loadAsync(archivo)).file("manifest.json")!.async("string")
    ) as { seals: { ledgerHash: string; analyticsKey: string } }

    registro.assert(
      "T11-analytics-clave-natural",
      sellosDeB.analyticsKey === manifestDeA.seals.analyticsKey,
      `analyticsKey sobre claves naturales · A=${manifestDeA.seals.analyticsKey} B=${sellosDeB.analyticsKey}`
    )
    expect(sellosDeB.analyticsKey).toBe(manifestDeA.seals.analyticsKey)
    expect(sellosDeB.ledgerHash).toBe(manifestDeA.seals.ledgerHash)

    registro.add(
      "T11-hallazgo-analyticskey",
      "INFO",
      "HALLAZGO de T11: `InvariantRun.analyticsKey` se compone sobre uuid (entryId, projectId, " +
        "costCenterId, businessLineId), así que una copia restaurada NUNCA podrá reproducirlo aunque su " +
        "analítica sea idéntica. El sello comparable es el de `computeContentSeals`, sobre claves naturales, " +
        "y ése sí coincide. Alinearlos exige reescribir `canonicalAnalyticsForm` (Nivel 2, ADR-0011) e " +
        "invalidaría todos los sellos emitidos."
    )
  }, 900_000)

  it("criterio 36 · `audit-reconstruct` sobre B: veredicto CONFORME y Δ = 0 en las doce", async () => {
    /**
     * **El segundo camino.** El auditor automatizado reconstruye las doce cifras
     * por SQL crudo, sin importar una línea de `lib/**`, `models/**` ni `ai/**`.
     * Si diera `CONFORME` sobre A y `DISCREPANCIA` sobre B, la copia no sería
     * fiel; si diera `CONFORME` sobre las dos pero compartiera código con el
     * motor, no probaría nada — y de eso se ocupa su propio test estático de
     * importaciones.
     *
     * Se invoca **como CLI**, que es como lo invoca CI y como lo invocaría un
     * auditor externo: `npx tsx scripts/audit-reconstruct.ts --org … --ref-date …`.
     */
    const salida = path.join(storeRoot, "audit-reconstruct-b.json")
    const { stdout, stderr } = await ejecutar(
      "npx",
      [
        "tsx",
        "scripts/audit-reconstruct.ts",
        "--org",
        destino.organizationId,
        "--fiscal-year",
        "2026",
        "--ref-date",
        REF_DATE,
        "--out",
        salida,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, GIT_SHA: ACCEPTANCE_GIT_SHA },
        maxBuffer: 32 * 1024 * 1024,
      }
    ).catch((error: Error & { stdout?: string; stderr?: string }) => ({
      stdout: error.stdout ?? "",
      stderr: `${error.stderr ?? ""}\\n${error.message}`,
    }))

    const veredicto = JSON.parse(await readFile(salida, "utf8")) as {
      veredicto: string
      filas?: Array<{ cifra: string; delta: number | string }>
    }

    registro.assert(
      "I-E12-2",
      veredicto.veredicto === "CONFORME",
      `audit-reconstruct sobre B: ${veredicto.veredicto}. ` +
        `Δ ≠ 0 en: ${(veredicto.filas ?? []).filter((f) => Number(f.delta) !== 0).map((f) => f.cifra).join(", ") || "ninguna"}`
    )
    expect(veredicto.veredicto, `${stdout}\\n${stderr}`).toBe("CONFORME")
    for (const fila of veredicto.filas ?? []) {
      expect(Number(fila.delta), `Δ de ${fila.cifra}`).toBe(0)
    }
  }, 1_800_000)

  it("criterio 37 · purga de derivados en B → regenerar ⇒ idénticos otra vez", async () => {
    /**
     * El cruce con §4.1, y el cierre de P7: **reconstruir desde cero, dos veces,
     * por dos caminos** —desde el ZIP y desde el diario restaurado— y que salga
     * lo mismo.
     */
    const fiscalYearId = await tenantTransaction(destino.organizationId, destino.userId, async (tx) =>
      (await tx.fiscalYear.findFirstOrThrow({ where: { code: "2026" } })).id
    )
    const orgB = { ...destino, fiscalYearId }

    const informe = await withMaintenance(async (client) =>
      await purgeDerived(orgB.organizationId, async (sql, params) => (await client.query(sql, params ? [...params] : [])).rows)
    )
    expect(informe.totalDeleted, "la purga en B no borró nada: pasaría por vacuidad").toBeGreaterThan(0)

    const fotoTrasPurgar = formaCanonica(await readCanonical(orgB))
    registro.assert(
      "T11-purga-en-b",
      fotoTrasPurgar === fotoDeA,
      fotoTrasPurgar === fotoDeA
        ? `purgadas ${informe.totalDeleted} filas derivadas de la copia y las cifras vuelven a las del original`
        : `DIFIEREN tras purgar B en: ${diferencias(fotoDeA, fotoTrasPurgar).join(" · ")}`
    )
    expect(fotoTrasPurgar).toBe(fotoDeA)
  }, 1_800_000)
})

describe("E12 · T11 — los cinco casos negativos", () => {
  /** Una organización de usar y tirar por cada rechazo: nunca se reutiliza B. */
  let siguiente = 0
  async function destinoLimpio(): Promise<AcceptanceOrg> {
    siguiente += 1
    const nueva = await createOrganizationWithOwner(
      { name: `${COMPONENTE} neg${siguiente}`, baseCurrency: "EUR", timezone: "Europe/Madrid", pgcVariant: "PYMES" },
      origen.userId,
      new Date(`${REF_DATE}T12:00:00.000Z`)
    )
    return { organizationId: nueva.id, userId: origen.userId, fiscalYearId: "", slug: nueva.slug }
  }

  async function esperarRechazo(archivoMalo: Buffer, patron: RegExp, etiqueta: string): Promise<void> {
    const org = await destinoLimpio()
    try {
      const outcome = await restoreBackupIntoOrganization({
        archive: archivoMalo,
        targetOrganizationId: org.organizationId,
        requestedById: org.userId,
        refDate: new Date(`${REF_DATE}T12:00:00.000Z`),
        keys: KEYS(),
      })
      const rechazado = outcome.status === "FAILED" || outcome.verification?.verified === false
      registro.assert(
        `T11-negativo-${etiqueta}`,
        rechazado && patron.test(`${outcome.error ?? ""}${JSON.stringify(outcome.verification?.checks ?? [])}`),
        `${etiqueta}: ${outcome.status} · ${outcome.error ?? "sin error, verificación en rojo"}`
      )
      expect(rechazado, `${etiqueta} NO se rechazó: ${outcome.status}`).toBe(true)
      expect(
        `${outcome.error ?? ""}${JSON.stringify(outcome.verification?.checks ?? [])}`,
        `${etiqueta}: el rechazo no dice por qué`
      ).toMatch(patron)
    } finally {
      await dropAcceptanceOrg(org).catch(() => undefined)
    }
  }

  it("1 · manifest ALTERADO ⇒ `SHA_DISCORDANTE`, antes de descomprimir un byte", async () => {
    const malo = await zipCon(async (zip) => {
      const manifest = JSON.parse(await zip.file("manifest.json")!.async("string")) as {
        totals: { rows: number }
      }
      manifest.totals.rows += 1
      zip.file("manifest.json", JSON.stringify(manifest, null, 2))
    })
    await esperarRechazo(malo, /SHA_DISCORDANTE/, "manifest-alterado")
  }, 900_000)

  it("2 · firma AJENA ⇒ `CLAVE_DESCONOCIDA`, y sin autorización del operador no pasa", async () => {
    const malo = await zipCon(async (zip) => {
      const sha = (await zip.file("manifest.sha256")!.async("string")).trim()
      zip.file("signature.txt", signManifest(sha, Buffer.from("la-clave-de-otra-instalacion"), "k9"))
    })
    await esperarRechazo(malo, /CLAVE_DESCONOCIDA/, "firma-ajena")
  }, 900_000)

  it("3 · dos `entryNumber` INTERCAMBIADOS ⇒ el sha del volcado no cuadra (O-1 de E11)", async () => {
    /**
     * **El caso que O-1 destapó**: si la forma canónica del `ledgerHash` ordena
     * por fecha y cuenta, dos asientos con los números intercambiados dan el
     * MISMO hash. Lo que los caza es la numeración —y, antes incluso, el sha de
     * su fichero de datos, que el manifest sella—. Los dos caminos valen; lo que
     * no vale es que pase.
     */
    const malo = await zipCon(async (zip) => {
      const cuerpo = await zip.file("data/journal_entries.jsonl")!.async("string")
      const lineas = cuerpo.split("\n")
      const a = JSON.parse(lineas[0]) as Record<string, { v: unknown; t: string }>
      const b = JSON.parse(lineas[1]) as Record<string, { v: unknown; t: string }>
      const swap = a.entry_number.v
      a.entry_number.v = b.entry_number.v
      b.entry_number.v = swap
      lineas[0] = JSON.stringify(a)
      lineas[1] = JSON.stringify(b)
      zip.file("data/journal_entries.jsonl", lineas.join("\n"))
    })
    await esperarRechazo(malo, /sha256|NUMERACION|numeraci/i, "entry-number-intercambiados")
  }, 900_000)

  it("4 · `AuditLog` MERMADO ⇒ la comprobación 4 lo caza (recuento y sha canónico)", async () => {
    const malo = await zipCon(
      async (zip) => {
        const cuerpo = await zip.file("data/audit_logs.jsonl")!.async("string")
        const lineas = cuerpo.split("\n")
        expect(lineas.length, "el fixture tiene que traer registro de auditoría que mermar").toBeGreaterThan(1)
        const mermado = lineas.slice(0, -1).join("\n")
        zip.file("data/audit_logs.jsonl", mermado)

        // Se ajusta el manifest para que el sha del fichero CUADRE: así el
        // rechazo no puede venir del sha del volcado, y lo que tiene que cazarlo
        // es la comprobación 4 —el recuento y el sha canónico del AuditLog—,
        // que es lo que este caso prueba.
        const { createHash } = await import("node:crypto")
        const manifest = JSON.parse(await zip.file("manifest.json")!.async("string")) as {
          tables: Array<{ name: string; rows: number; sha256: string }>
        }
        const entrada = manifest.tables.find((t) => t.name === "audit_logs")!
        entrada.rows -= 1
        entrada.sha256 = createHash("sha256").update(mermado).digest("hex")
        zip.file("manifest.json", JSON.stringify(manifest, null, 2))
      },
      { refirmarCon: signingKeyFromEnv().key }
    )
    await esperarRechazo(malo, /AUDIT_LOG|RECUENTOS|auditor/i, "audit-log-mermado")
  }, 900_000)

  it("5 · ZIP de un esquema ANTERIOR ⇒ rechazo NOMBRANDO la versión, no «lo que se pueda»", async () => {
    const malo = await zipCon(
      async (zip) => {
        const manifest = JSON.parse(await zip.file("manifest.json")!.async("string")) as {
          schemaVersion: string
        }
        manifest.schemaVersion = "20250101000000"
        zip.file("manifest.json", JSON.stringify(manifest, null, 2))
      },
      { refirmarCon: signingKeyFromEnv().key }
    )
    await esperarRechazo(malo, /ESQUEMA_INCOMPATIBLE.*20250101000000/s, "esquema-anterior")
  }, 900_000)

  it("el original sigue siendo el que era: ninguna restauración fallida ha tocado nada de A", async () => {
    // A ya está destruida a propósito; lo que se comprueba es que los rechazos
    // no han dejado organizaciones a medias sembrando la base.
    const huerfanas = await withMaintenance(async (client) => {
      const { rows } = await client.query<{ slug: string }>(
        `SELECT slug FROM organizations WHERE name LIKE $1 ORDER BY slug`,
        [`${COMPONENTE} neg%`]
      )
      return rows.map((row) => row.slug)
    })
    expect(huerfanas, `quedan organizaciones de casos negativos sin retirar: ${huerfanas.join(", ")}`).toEqual([])
    registro.add("T11-sin-huerfanas", "PASS", "ningún rechazo ha dejado una organización a medias")
  }, 300_000)
})

void prisma
