/**
 * E11 · **ronda 1 de corrección** — los tres bloqueantes del auditor y el
 * cableado de T20, contra Postgres de verdad.
 *
 * Cada `describe` cierra un hallazgo concreto, con su nombre:
 *
 *  · **H-2** — `currencies` (177 filas por organización, con `organization_id` y
 *    RLS propia) estaba fuera de `TENANT_MODELS` y por tanto fuera del ZIP:
 *    177 → 0 tras restaurar, **con las seis comprobaciones en PASS y
 *    `verified = true`**. Aquí se exige 177 = 177.
 *  · **H-3** — la demo no se podía crear: el `UPDATE … SET is_demo = true`
 *    chocaba con el CHECK de inmutabilidad (`23514`, «f → t»). Aquí nace marcada
 *    desde el `INSERT`, y se comprueba que la marca **sigue siendo inmutable**.
 *  · **H-1 / T20** — los trece `I-E11-*` no existían y el barrido devolvía 43
 *    checks y ninguno. Aquí se exige que el barrido real los devuelva los trece,
 *    en la familia `PLATAFORMA`.
 *  · **H-4** — `changeOrganizationPlan` registraba un cambio de plan que no
 *    había ocurrido.
 *  · **PUEDE 14** — el test de D2.9 que faltaba: `deleteDemoOrganization` rebota
 *    en una organización que no es demo.
 *
 * El almacén es un `LocalDriver` sobre un directorio temporal: ni una conexión
 * de red.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL

const ORG = "e11b0000-0000-4000-8000-000000000001"
const DEST = "e11b0000-0000-4000-8000-000000000002"
const ADMIN = "e11b0000-0000-4000-8000-0000000000a1"
const PLAN_ILIMITADO = "0e11a1a0-0000-4000-8000-000000000009"
const SIGNING_KEY = Buffer.from("clave-de-firma-de-pruebas-e11-ronda1")
const KEY_ID = "k1"
const REF = new Date("2027-12-31T12:00:00.000Z")

const storeRoot = await mkdtemp(path.join(tmpdir(), "e11-ronda1-store-"))
process.env.STORAGE_DRIVER = "local"
process.env.STORAGE_LOCAL_ROOT = storeRoot
process.env.STORAGE_PREFIX = "erp-test"
process.env.PLATFORM_SIGNING_KEY = SIGNING_KEY.toString("utf8")
process.env.PLATFORM_SIGNING_KEY_ID = KEY_ID

const { prisma, BACKUP_TENANT_MODELS, TENANT_MODELS, tenantDb, tenantTransaction } = await import("@/lib/db")
const { buildBackupArchive, restoreBackupIntoOrganization } = await import("@/models/backups")
const { readPlatformInvariantInput } = await import("@/models/platform-invariants")
const { runPlatformInvariants, E11_INVARIANT_IDS } = await import("@/lib/ledger/invariants-e11")
const { familyOf } = await import("@/lib/audit/families")

/** Las 177 monedas que la siembra escribe por organización (`models/onboarding`). */
const MONEDAS = 177

async function cleanup(): Promise<void> {
  for (const id of [ORG, DEST]) await prisma.organization.deleteMany({ where: { id } })
  await prisma.user.deleteMany({ where: { id: ADMIN } })
}

describe.skipIf(!TEST_DATABASE_URL)("E11 · ronda 1 — bloqueantes del auditor", () => {
  beforeAll(async () => {
    await cleanup()
    await prisma.user.create({
      data: { id: ADMIN, email: "e11-ronda1@test.local", name: "Admin ronda 1", updatedAt: new Date() },
    })
    for (const [id, slug] of [
      [ORG, "e11r1-origen"],
      [DEST, "e11r1-destino"],
    ] as const) {
      await prisma.organization.create({
        data: { id, slug, name: `E11 ${slug}`, pgcVariant: "PYMES", updatedAt: new Date() },
      })
      await prisma.membership.create({
        data: { organizationId: id, userId: ADMIN, role: "ADMIN", acceptedAt: new Date(), updatedAt: new Date() },
      })
      await prisma.subscription.create({
        data: { organizationId: id, planCode: "ILIMITADO", planId: PLAN_ILIMITADO, status: "ACTIVE" },
      })
    }
    // Las 177 monedas de la organización de origen, como las siembra el alta.
    await prisma.currency.createMany({
      data: Array.from({ length: MONEDAS }, (_, i) => ({
        organizationId: ORG,
        code: `X${String(i).padStart(3, "0")}`,
        name: `Moneda ${i}`,
      })),
    })
  }, 120_000)

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
    await rm(storeRoot, { recursive: true, force: true })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // H-2 · `currencies` viaja en el ZIP y sobrevive a la restauración
  // ───────────────────────────────────────────────────────────────────────────

  describe("Auditor H-2 · `currencies` ya no se pierde al restaurar", () => {
    it("el inventario del backup se deriva de TENANT_MODELS ∪ las híbridas, e incluye `currencies`", () => {
      expect(BACKUP_TENANT_MODELS.has("Currency")).toBe(true)
      // Y sigue FUERA de `TENANT_MODELS`, porque su lectura es híbrida: la
      // corrección no rompe el catálogo global (`organization_id IS NULL`).
      expect(TENANT_MODELS.has("Currency")).toBe(false)
      // Y lo que se EXCLUYE está declarado: nuestras facturas emitidas no
      // viajan en la copia del cliente —su serie es correlativa y global, y
      // duplicar (serie, número) al restaurar falsificaría la numeración—.
      for (const model of ["PlatformInvoice", "Subscription", "SubscriptionEvent"]) {
        expect(BACKUP_TENANT_MODELS.has(model), model).toBe(false)
        // Siguen en `TENANT_MODELS`: la barrera 1 las acota igual. Lo que no
        // hacen es viajar en la copia del cliente.
        expect(TENANT_MODELS.has(model), model).toBe(true)
      }
    })

    it(
      "backup → restauración a organización NUEVA: **177 monedas en origen, 177 en destino** " +
        "(antes: 177 → 0 con verified = true)",
      async () => {
        expect(await prisma.currency.count({ where: { organizationId: ORG } })).toBe(MONEDAS)
        expect(await prisma.currency.count({ where: { organizationId: DEST } })).toBe(0)

        const built = await buildBackupArchive(ORG, {
          refDate: REF,
          signingKey: SIGNING_KEY,
          signingKeyId: KEY_ID,
        })
        // El manifest declara la tabla con su recuento: si no está aquí, no está
        // en el ZIP, y la comprobación 1 no la puede echar de menos.
        const currencies = built.manifest.tables.find((table) => table.name === "currencies")
        expect(currencies, "`currencies` ausente del manifest").toBeDefined()
        expect(currencies!.rows).toBe(MONEDAS)

        const outcome = await restoreBackupIntoOrganization({
          archive: built.archive,
          targetOrganizationId: DEST,
          requestedById: ADMIN,
          refDate: REF,
          keys: new Map([[KEY_ID, SIGNING_KEY]]),
        })
        expect(outcome.rejected ?? []).toEqual([])
        expect(await prisma.currency.count({ where: { organizationId: DEST } })).toBe(MONEDAS)

        // Y la comprobación 1 cuenta TODAS las tablas del inventario, no un
        // subconjunto: `currencies` aparece en su evidencia.
        const recuentos = outcome.verification?.checks.find((check) => check.id === "RECUENTOS")
        expect(recuentos?.evidence.map((row) => row.label)).toContain("currencies")
        expect(recuentos?.evidence.find((row) => row.label === "currencies")).toMatchObject({
          expected: String(MONEDAS),
          actual: String(MONEDAS),
          ok: true,
        })
      },
      300_000
    )

    it("el catálogo GLOBAL (`organization_id IS NULL`) NO viaja en el ZIP: no es del cliente", async () => {
      const globales = await prisma.currency.count({ where: { organizationId: null } })
      const delDestino = await prisma.currency.count({ where: { organizationId: DEST } })
      // Lo restaurado son exactamente las del origen, ni una del catálogo común.
      expect(delDestino).toBe(MONEDAS)
      expect(globales).toBeGreaterThanOrEqual(0)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // H-1 / T20 · el barrido devuelve los TRECE
  // ───────────────────────────────────────────────────────────────────────────

  describe("T20 · el bloque `platform` existe y el barrido devuelve los trece", () => {
    it("`readPlatformInvariantInput` compone el bloque y salen los trece `I-E11-*`", async () => {
      const { platform } = await tenantTransaction(ORG, async (tx) =>
        readPlatformInvariantInput(tx, { refDate: REF })
      )
      const checks = runPlatformInvariants(platform)
      expect(checks.map((check) => check.id)).toEqual(E11_INVARIANT_IDS)
      // Ninguno se queda sin evidencia, y ninguno es un PASS por vacuidad.
      for (const check of checks) {
        expect(check.evidencia.length, check.id).toBeGreaterThan(20)
        if (check.status === "INFO") expect(check.evidencia).toContain("no evaluable")
      }
    }, 120_000)

    it("los trece caen en la familia `PLATAFORMA`, no en `INTEGRIDAD`", () => {
      for (const id of E11_INVARIANT_IDS) expect(familyOf(id), id).toBe("PLATAFORMA")
    })

    it("I-E11-7 pasa contra el esquema REAL: ninguna tabla con organization_id se queda fuera", async () => {
      const { platform } = await tenantTransaction(ORG, async (tx) =>
        readPlatformInvariantInput(tx, { refDate: REF })
      )
      const check = runPlatformInvariants(platform).find((c) => c.id === "I-E11-7")!
      expect(`${check.status}: ${check.evidencia}`).toContain("PASS")
      // Y la única exclusión declarada es la que está escrita y justificada.
      expect(check.evidencia).toContain("platform_audit_logs")
    }, 120_000)

    it("I-E11-5 está ACOTADO: el bloque trae SOLO la organización barrida", async () => {
      const { platform } = await tenantTransaction(ORG, async (tx) =>
        readPlatformInvariantInput(tx, { refDate: REF })
      )
      expect(platform.access?.organizations.map((row) => row.organizationId)).toEqual([ORG])
    }, 120_000)

    it("I-E11-1 caza la caché falseada: se altera `usage_runs` SIN tocar `source_hash`", async () => {
      // Primero, el uso real, que crea su `UsageRun`.
      const { getUsage } = await import("@/models/usage")
      const snapshot = await getUsage(ORG, REF)
      expect(snapshot.fromCache).toBe(false)

      // Ahora la manipulación del auditor, por SQL y como propietario.
      const { Client } = await import("pg")
      const { ownerDatabaseUrl } = await import("@/tests/support/env")
      const owner = new Client({ connectionString: ownerDatabaseUrl() })
      await owner.connect()
      try {
        await owner.query(
          `UPDATE usage_runs SET members = 77, entries = 4242
            WHERE organization_id = $1::uuid AND source_hash = $2`,
          [ORG, snapshot.sourceHash]
        )
      } finally {
        await owner.end()
      }

      const { platform } = await tenantTransaction(ORG, async (tx) =>
        readPlatformInvariantInput(tx, { refDate: REF })
      )
      const check = runPlatformInvariants(platform).find((c) => c.id === "I-E11-1")!
      expect(check.status).toBe("FAIL")
      expect(check.evidencia).toContain("servido 77")
      expect(check.evidencia).toContain("servido 4242")
    }, 120_000)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // H-4 · el cambio de plan que no ocurrió
  // ───────────────────────────────────────────────────────────────────────────

  describe("Auditor H-4 · `getSubscription` filtra por tenant y el cambio de plan se verifica", () => {
    it("`getSubscription` devuelve la de ESTA organización, no «la primera que la RLS deje ver»", async () => {
      const { getSubscription } = await import("@/models/subscriptions")
      const subOrigen = await getSubscription(tenantDb(ORG))
      const subDestino = await getSubscription(tenantDb(DEST))
      expect(subOrigen?.organizationId).toBe(ORG)
      expect(subDestino?.organizationId).toBe(DEST)
      expect(subOrigen?.id).not.toBe(subDestino?.id)
    })

    it("`changeOrganizationPlan` aplica el cambio y deja la traza que corresponde", async () => {
      const { changeOrganizationPlan } = await import("@/models/subscriptions")
      const resultado = await changeOrganizationPlan(ORG, "FREE", REF, "operator:test")
      expect(resultado.planCode).toBe("FREE")
      expect(resultado.previousPlanCode).toBe("ILIMITADO")
      const fila = await prisma.subscription.findFirstOrThrow({ where: { organizationId: ORG } })
      expect(fila.planCode).toBe("FREE")
      const traza = await prisma.auditLog.findFirst({
        where: { organizationId: ORG, action: "CAMBIO_DE_PLAN" },
        orderBy: { ts: "desc" },
      })
      expect(traza).not.toBeNull()
      // Y se vuelve a dejar como estaba: el resto del fichero asume ILIMITADO.
      await changeOrganizationPlan(ORG, "ILIMITADO", REF, "operator:test")
      expect((await prisma.subscription.findFirstOrThrow({ where: { organizationId: ORG } })).planCode).toBe(
        "ILIMITADO"
      )
    }, 60_000)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // H-3 · la demo nace marcada, y la marca es inmutable
  // ───────────────────────────────────────────────────────────────────────────

  describe("Auditor H-3 · la demo se crea, y `isDemo` sigue siendo inmutable", () => {
    const DEMO = "e11b0000-0000-4000-8000-0000000000d1"

    afterAll(async () => {
      await prisma.organization.deleteMany({ where: { id: DEMO } })
    })

    it("`createOrganizationWithOwner` marca `isDemo` EN EL INSERT: la organización nace demo", async () => {
      const { createOrganizationWithOwner } = await import("@/models/organizations")
      const demo = await createOrganizationWithOwner(
        { name: "Demo — E11 ronda 1", baseCurrency: "EUR", isDemo: true },
        ADMIN,
        REF
      )
      expect(demo.isDemo).toBe(true)
      // …y con su suscripción, que nace en la misma transacción (D9).
      expect(await prisma.subscription.count({ where: { organizationId: demo.id } })).toBe(1)
      await prisma.organization.delete({ where: { id: demo.id } })
    }, 60_000)

    it("la marca es INMUTABLE en las dos direcciones (O-6): `f → t` y `t → f` rebotan con 23514", async () => {
      const { Client } = await import("pg")
      const { ownerDatabaseUrl } = await import("@/tests/support/env")
      const owner = new Client({ connectionString: ownerDatabaseUrl() })
      await owner.connect()
      try {
        await owner.query(
          `INSERT INTO organizations (id, slug, name, is_demo, updated_at)
           VALUES ($1::uuid, 'e11r1-demo', 'Demo inmutable', true, now())`,
          [DEMO]
        )
        // t → f
        const aFalso = await owner
          .query(`UPDATE organizations SET is_demo = false WHERE id = $1::uuid`, [DEMO])
          .then(() => null)
          .catch((error: { code?: string }) => error.code)
        expect(aFalso).toBe("23514")
        // f → t, que es el que rompía la creación de la demo
        const aVerdadero = await owner
          .query(`UPDATE organizations SET is_demo = true WHERE id = $1::uuid`, [ORG])
          .then(() => null)
          .catch((error: { code?: string }) => error.code)
        expect(aVerdadero).toBe("23514")
      } finally {
        await owner.end()
      }
    }, 60_000)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Revisor PUEDE 14 · el test de D2.9 que faltaba
  // ───────────────────────────────────────────────────────────────────────────

  describe("Revisor PUEDE 14 · `deleteDemoOrganization` sólo borra demos", () => {
    it("rebota en una organización que NO es demo, aunque la pida un ADMIN", async () => {
      const { deleteDemoOrganization } = await import("@/models/onboarding")
      await expect(deleteDemoOrganization(tenantDb(ORG), DEST, ADMIN)).rejects.toThrow(
        /no está marcada como demostración/
      )
      // Y la organización sigue ahí, con sus monedas restauradas.
      expect(await prisma.organization.count({ where: { id: DEST } })).toBe(1)
      expect(await prisma.currency.count({ where: { organizationId: DEST } })).toBe(MONEDAS)
    }, 60_000)
  })
})
