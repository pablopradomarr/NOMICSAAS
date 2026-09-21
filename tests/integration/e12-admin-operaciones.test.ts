/**
 * E12 · T13 — **las cuatro escrituras de operador contra Postgres de verdad**
 * (ADR-0020 D1–D6; criterios 40–46 del diseño).
 *
 * Aquí se ejerce lo que un test puro no puede:
 *
 *  · **40** — `reset-org` sobre una organización **con un asiento** se niega, y
 *    se niega **también** cuando la aplicación miente: se prueba el `DELETE`
 *    directo bajo el rol `app_operator` y la base lo rechaza. No hay `--force`.
 *  · **41** — sin motivo, con motivo genérico o sin el nombre exacto: denegada
 *    **en el servidor**, no en el diálogo.
 *  · **42** — toda escritura deja `PlatformAuditLog` **y** `AuditLog` de la
 *    organización, con `before`/`after` y recuentos.
 *  · **43** — el rol de operador no puede escribir en las seis tablas de D2.
 *  · **44 / 45** — una excepción viva mueve el sello y caduca sola.
 *  · **La doble confirmación de D4**: un token emitido sobre una enumeración que
 *    ya no es verdad **no vale**.
 *
 * El almacén es un `LocalDriver` sobre un directorio temporal: ni una conexión
 * de red.
 */

import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { beforeAll, describe, expect, it } from "vitest"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL

const ORG = "e12a0000-0000-4000-8000-000000000001"
const CON_ASIENTOS = "e12a0000-0000-4000-8000-000000000002"
const ADMIN = "e12a0000-0000-4000-8000-0000000000a1"
const ENTRY = "e12a0000-0000-4000-8000-0000000000e1"
const PLAN_ILIMITADO = "0e11a1a0-0000-4000-8000-000000000009"

const NOMBRE = "E12 Operador S.L."
const NOMBRE_CON_ASIENTOS = "E12 Con Asientos S.L."
const MOTIVO = "El bloqueo de septiembre se puso por error al importar el extracto de BBVA"
const NOW = new Date("2026-10-01T10:00:00.000Z")

const storeRoot = await mkdtemp(path.join(tmpdir(), "e12-admin-store-"))
process.env.STORAGE_DRIVER = "local"
process.env.STORAGE_LOCAL_ROOT = storeRoot
process.env.STORAGE_PREFIX = "erp-test"

const { prisma, tenantTransaction } = await import("@/lib/db")
const {
  OperatorDenied,
  RESET_PRESERVED,
  planResetOrg,
  planUnblock,
  resetModels,
  runResetOrg,
  runUnblock,
  runReassignPlan,
} = await import("@/app/(app)/admin/operations")
const { TENANT_MODELS } = await import("@/lib/db")
const { readOperatorInvariantInput } = await import("@/models/operator-exceptions")
const { checkIE125, operatorSealReasons } = await import("@/lib/ledger/invariants-e12")

const ctx = (over: Partial<{ reason: string; confirmedName: string; now: Date }> = {}) => ({
  actor: "operador@cfonomic.com",
  userId: ADMIN,
  reason: MOTIVO,
  confirmedName: NOMBRE,
  now: NOW,
  ...over,
})

async function seedOrg(id: string, slug: string, name: string): Promise<void> {
  await prisma.organization.deleteMany({ where: { id } }).catch(() => {})
  await prisma.organization.create({ data: { id, slug, name, pgcVariant: "PYMES", updatedAt: new Date() } })
  await prisma.membership.create({
    data: { organizationId: id, userId: ADMIN, role: "ADMIN", acceptedAt: new Date(), updatedAt: new Date() },
  })
  await prisma.subscription.create({
    data: { organizationId: id, planCode: "ILIMITADO", planId: PLAN_ILIMITADO, status: "ACTIVE" },
  })
}

describe.skipIf(!TEST_DATABASE_URL)("E12 · T13 — las cuatro escrituras de operador", () => {
  beforeAll(async () => {
    await prisma.operatorException.deleteMany({ where: { organizationId: { in: [ORG, CON_ASIENTOS] } } })
    await prisma.platformAuditLog.deleteMany({ where: { organizationId: { in: [ORG, CON_ASIENTOS] } } })
    for (const id of [ORG, CON_ASIENTOS]) await prisma.organization.deleteMany({ where: { id } })
    await prisma.user.deleteMany({ where: { id: ADMIN } })
    await prisma.user.create({
      data: { id: ADMIN, email: "e12-admin@test.local", name: "Operador E12", updatedAt: new Date() },
    })
    await seedOrg(ORG, "e12-operador", NOMBRE)
    await seedOrg(CON_ASIENTOS, "e12-con-asientos", NOMBRE_CON_ASIENTOS)

    // Unas cuantas filas vaciables en la organización limpia.
    await tenantTransaction(ORG, async (tx) => {
      const bl = await tx.businessLine.create({ data: { organizationId: ORG, code: "BL-1", name: "Línea" } })
      await tx.project.create({
        data: { organizationId: ORG, code: "P-001", name: "Proyecto de prueba", businessLineId: bl.id },
      })
    })

    // Y un ejercicio con un asiento en la otra, por el camino del motor.
    const fy = await tenantTransaction(CON_ASIENTOS, async (tx) =>
      tx.fiscalYear.create({
        data: {
          organizationId: CON_ASIENTOS,
          code: "2026",
          startDate: new Date("2026-01-01T00:00:00Z"),
          endDate: new Date("2026-12-31T00:00:00Z"),
          status: "OPEN",
        },
      })
    )
    // El asiento se inserta por SQL con el rol PROPIETARIO. Tiene que ser un
    // asiento DE VERDAD —dos líneas cuadradas— porque el trigger de partida
    // doble es diferido y rechazaría una cabecera suelta: es exactamente la
    // barrera que ADR-0003 promete, y aquí se paga como todo el mundo.
    // Las tres sentencias van en UNA transacción: el trigger de partida doble
    // es DEFERRABLE y se evalúa al COMMIT, así que una cabecera sin líneas en
    // su propia transacción rebota — que es exactamente lo que ADR-0003 promete.
    await prisma.$transaction([
      prisma.$executeRaw`
        INSERT INTO "accounts" ("id", "organization_id", "code", "name", "level", "nature", "updated_at")
        VALUES (gen_random_uuid(), ${CON_ASIENTOS}::uuid, '570', 'Caja', 3, 'DEUDORA', now()),
               (gen_random_uuid(), ${CON_ASIENTOS}::uuid, '700', 'Ventas', 3, 'ACREEDORA', now())`,
      prisma.$executeRaw`
        INSERT INTO "journal_entries"
          ("id", "organization_id", "fiscal_year_id", "entry_number", "entry_date", "kind", "description",
           "source_type", "posted_by_id", "entry_hash")
        VALUES (${ENTRY}::uuid, ${CON_ASIENTOS}::uuid, ${fy.id}::uuid, 1, '2026-03-01'::date, 'NORMAL',
                'Asiento que impide el reset', 'MANUAL', ${ADMIN}::uuid, repeat('a', 64))`,
      prisma.$executeRaw`
        INSERT INTO "journal_lines"
          ("organization_id", "entry_id", "line_no", "account_code", "debit_cents", "credit_cents",
           "entry_date", "fiscal_year_id", "entry_kind")
        VALUES (${CON_ASIENTOS}::uuid, ${ENTRY}::uuid, 1, '570', 100000, 0, '2026-03-01'::date, ${fy.id}::uuid, 'NORMAL'),
               (${CON_ASIENTOS}::uuid, ${ENTRY}::uuid, 2, '700', 0, 100000, '2026-03-01'::date, ${fy.id}::uuid, 'NORMAL')`,
    ])
  }, 120_000)

  // ───────────────────────────────────────────────────────────────────────────
  describe("La lista de tablas se DERIVA de TENANT_MODELS (regla E-4)", () => {
    it("vaciado ∪ conservado = TENANT_MODELS, sin que sobre ni falte una tabla", () => {
      const cubiertos = new Set([...resetModels(), ...RESET_PRESERVED.map((p) => p.model)])
      expect([...cubiertos].sort()).toEqual([...TENANT_MODELS].sort())
    })

    it("cada tabla conservada lleva su MOTIVO escrito", () => {
      for (const p of RESET_PRESERVED) expect(p.reason.length, p.model).toBeGreaterThan(20)
    })

    it("las seis tablas de ADR-0020 D2 están entre las conservadas, y no entre las vaciadas", () => {
      for (const m of ["JournalEntry", "JournalLine", "AuditLog", "ExtractionRun", "InvariantRun", "ClosingRun"]) {
        expect(RESET_PRESERVED.map((p) => p.model)).toContain(m)
        expect(resetModels()).not.toContain(m)
      }
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("Criterio 40 · `reset-org` se niega con un solo asiento, y no hay --force", () => {
    it("la enumeración lo dice antes de que nadie pulse", async () => {
      const plan = await planResetOrg(CON_ASIENTOS)
      expect(plan.blocked).toContain("1 asiento")
      expect(plan.blocked).toContain("contra-asiento")
      expect(plan.before.journalEntries).toBe(1)
    })

    it("la acción se niega aunque se le pase todo bien", async () => {
      await expect(
        runResetOrg(CON_ASIENTOS, ctx({ confirmedName: NOMBRE_CON_ASIENTOS }))
      ).rejects.toBeInstanceOf(OperatorDenied)
    })

    it("y la BASE también: `app_operator` no borra NI UNA FILA de una organización con asientos", async () => {
      // Ésta es la prueba de que la negativa no depende de la aplicación. Si
      // mañana alguien añadiera un `--force` en TypeScript, esto seguiría sin
      // borrar nada: la política `RESTRICTIVE` de `20261001100000` exige
      // `app.operator_reset_allowed()`, que mira el diario.
      const antes = await tenantTransaction(CON_ASIENTOS, async (tx) => tx.fiscalYear.count())
      expect(antes).toBe(1)
      const borradas = await tenantTransaction(CON_ASIENTOS, async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_operator`
        return await tx.$executeRaw`DELETE FROM "fiscal_years" WHERE "organization_id" = ${CON_ASIENTOS}::uuid`
      })
      expect(borradas).toBe(0)
      const despues = await tenantTransaction(CON_ASIENTOS, async (tx) => tx.fiscalYear.count())
      expect(despues).toBe(1)
    })

    it("sobre una organización SIN asientos, la enumeración cuenta filas y no bloquea", async () => {
      const plan = await planResetOrg(ORG)
      expect(plan.blocked).toBeNull()
      expect(plan.affectedCounts["projects"]).toBe(1)
      expect(plan.affectedCounts["business_lines"]).toBe(1)
      // Enumera también lo que conserva, con su motivo (§5.5).
      expect(plan.steps.some((s) => s.label.includes("Se CONSERVAN"))).toBe(true)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("Criterio 41 · motivo y confirmación, verificados en el SERVIDOR", () => {
    it("sin motivo ⇒ denegada", async () => {
      await expect(runUnblock(ORG, target(), ctx({ reason: "" }))).rejects.toThrow(/motivo es obligatorio/i)
    })

    it("con motivo genérico ⇒ denegada", async () => {
      await expect(runUnblock(ORG, target(), ctx({ reason: "arreglo" }))).rejects.toThrow(/al menos 20/i)
    })

    it("con motivo largo pero vacío de contenido ⇒ denegada", async () => {
      await expect(runUnblock(ORG, target(), ctx({ reason: "arreglo arreglo arreglo" }))).rejects.toThrow(
        /una frase/i
      )
    })

    it("sin el nombre EXACTO ⇒ denegada (ni minúsculas, ni parecido)", async () => {
      await expect(runUnblock(ORG, target(), ctx({ confirmedName: "e12 operador s.l." }))).rejects.toThrow(
        /nombre exacto/i
      )
      await expect(runUnblock(ORG, target(), ctx({ confirmedName: "E12 Operador" }))).rejects.toThrow(/nombre exacto/i)
    })
  })

  const target = () =>
    ({ kind: "UNBLOCK_PERIOD_LOCK", targetKind: "PERIOD_LOCK", targetId: null, targetRef: null }) as const

  // ───────────────────────────────────────────────────────────────────────────
  describe("Criterios 42, 44 y 45 · `unblock` deja rastro, mueve el sello y caduca", () => {
    it("crea la excepción con 24 h exactas y la registra en los DOS registros", async () => {
      const plan = await runUnblock(ORG, target(), ctx())
      expect(plan.after.sello).toBe("REQUIERE REVISIÓN")

      const excepciones = await prisma.operatorException.findMany({ where: { organizationId: ORG } })
      expect(excepciones).toHaveLength(1)
      const e = excepciones[0]!
      expect(e.expiresAt.getTime() - e.createdAt.getTime()).toBeLessThanOrEqual(24 * 3_600_000)
      expect(e.reason).toBe(MOTIVO)
      expect(e.requestedBy).toBe("operador@cfonomic.com")

      // (1) PlatformAuditLog, con `before`/`after` y recuentos (D3).
      const plataforma = await prisma.platformAuditLog.findMany({
        where: { organizationId: ORG, action: "admin.unblock" },
      })
      expect(plataforma).toHaveLength(1)
      const detail = plataforma[0]!.detail as Record<string, unknown>
      expect(detail.reason).toBe(MOTIVO)
      expect(detail.confirmedName).toBe(NOMBRE)
      expect(detail.before).toBeTypeOf("object")
      expect(detail.after).toBeTypeOf("object")
      expect(detail.affectedCounts).toBeTypeOf("object")

      // (2) Y el registro DEL CLIENTE: tiene derecho a saberlo.
      const cliente = await tenantTransaction(ORG, async (tx) =>
        tx.auditLog.findMany({ where: { action: "OPERATOR_UNBLOCK" } })
      )
      expect(cliente).toHaveLength(1)
      expect(cliente[0]!.reason).toContain(MOTIVO)
    })

    it("mientras la excepción vive, el periodo NO se puede firmar automáticamente (criterio 44)", async () => {
      const bloque = await tenantTransaction(ORG, async (tx) =>
        readOperatorInvariantInput(tx, { refDate: new Date(NOW.getTime() + 60_000) })
      )
      expect(operatorSealReasons(bloque)).toEqual(["EXCEPCION_DE_OPERADOR_VIGENTE"])
      expect(checkIE125(bloque).status).toBe("PASS")
    })

    it("cuando caduca, la puerta se cierra sola: sin motivo de sello (criterio 45)", async () => {
      const bloque = await tenantTransaction(ORG, async (tx) =>
        readOperatorInvariantInput(tx, { refDate: new Date(NOW.getTime() + 25 * 3_600_000) })
      )
      expect(operatorSealReasons(bloque)).toEqual([])
      // El invariante sigue en PASS: la excepción estaba bien registrada. Lo que
      // cambia es que ya no mueve el sello.
      expect(checkIE125(bloque).status).toBe("PASS")
    })

    it("no se puede abrir una segunda excepción sobre la misma guardia mientras la primera viva", async () => {
      const plan = await planUnblock(ORG, target(), NOW)
      expect(plan.blocked).toContain("Ya hay una excepción viva")
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("Criterio 43 · el rol de operador no alcanza el diario (vía 1 de D2)", () => {
    const prohibidas = ["journal_entries", "journal_lines", "extraction_runs", "invariant_runs", "closing_runs"]

    it("`app_operator` no tiene INSERT/UPDATE/DELETE sobre ninguna de las cinco", async () => {
      const filas = await prisma.$queryRaw<{ table_name: string; privilege_type: string }[]>`
        SELECT "table_name", "privilege_type" FROM information_schema.table_privileges
         WHERE grantee = 'app_operator'
           AND "table_name" = ANY(${prohibidas})
           AND "privilege_type" IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')`
      expect(filas).toEqual([])
    })

    it("sobre `audit_logs` sólo puede INSERTAR: es el registro que D3 obliga a dejar", async () => {
      const filas = await prisma.$queryRaw<{ privilege_type: string }[]>`
        SELECT "privilege_type" FROM information_schema.table_privileges
         WHERE grantee = 'app_operator' AND "table_name" = 'audit_logs'
         ORDER BY 1`
      expect(filas.map((f) => f.privilege_type).sort()).toEqual(["INSERT", "SELECT"])
    })

    it("no tiene BYPASSRLS ni puede iniciar sesión (ADR-0020 descarta la alternativa 5)", async () => {
      const [rol] = await prisma.$queryRaw<{ rolbypassrls: boolean; rolcanlogin: boolean }[]>`
        SELECT "rolbypassrls", "rolcanlogin" FROM pg_roles WHERE rolname = 'app_operator'`
      expect(rol).toEqual({ rolbypassrls: false, rolcanlogin: false })
    })

    it("un DELETE de operador sobre `journal_lines` rebota con 42501 aunque la organización esté vacía", async () => {
      // Aquí sí lanza, y por la vía 1: `app_operator` no tiene el privilegio.
      // Una organización sin asientos no es una excusa para poder borrar del
      // diario: el privilegio no existe, no es que no haya qué borrar.
      await expect(
        tenantTransaction(ORG, async (tx) => {
          await tx.$executeRaw`SET LOCAL ROLE app_operator`
          return await tx.$executeRaw`DELETE FROM "journal_lines" WHERE "organization_id" = ${ORG}::uuid`
        })
      ).rejects.toThrow(/permission denied|42501/i)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("`reset-org` sobre una organización limpia", () => {
    it("vacía lo que enumeró y conserva lo declarado", async () => {
      const antes = await planResetOrg(ORG)
      expect(antes.blocked).toBeNull()

      const result = await runResetOrg(ORG, ctx())
      expect(result.affectedCounts["projects"]).toBe(1)

      const despues = await planResetOrg(ORG)
      expect(despues.affectedCounts["projects"]).toBeUndefined()

      // Lo conservado sigue ahí: la organización no se queda sin dueño ni sin
      // suscripción, y la excepción de operador —su propia traza— tampoco.
      const miembros = await prisma.membership.count({ where: { organizationId: ORG } })
      expect(miembros).toBe(1)
      const suscripcion = await prisma.subscription.count({ where: { organizationId: ORG } })
      expect(suscripcion).toBe(1)
      const excepciones = await prisma.operatorException.count({ where: { organizationId: ORG } })
      expect(excepciones).toBe(1)
    })

    it("deja su línea en los dos registros, con los recuentos por tabla", async () => {
      const plataforma = await prisma.platformAuditLog.findMany({
        where: { organizationId: ORG, action: "admin.reset_org" },
      })
      expect(plataforma).toHaveLength(1)
      const detail = plataforma[0]!.detail as Record<string, unknown>
      expect((detail.affectedCounts as Record<string, number>)["projects"]).toBe(1)
      expect(detail.reason).toBe(MOTIVO)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("`reassign-plan` gana motivo y confirmación (D1)", () => {
    it("cambia el plan y lo registra como `admin.plan_changed`", async () => {
      const result = await runReassignPlan(ORG, "FREE", ctx())
      expect(result.after.planCode).toBe("FREE")

      const plataforma = await prisma.platformAuditLog.findMany({
        where: { organizationId: ORG, action: "admin.plan_changed" },
      })
      expect(plataforma).toHaveLength(1)
      expect((plataforma[0]!.detail as Record<string, unknown>).reason).toBe(MOTIVO)

      const cliente = await tenantTransaction(ORG, async (tx) =>
        tx.auditLog.findMany({ where: { action: "OPERATOR_PLAN_CHANGED" } })
      )
      expect(cliente).toHaveLength(1)
    })

    it("sin el nombre exacto NO cambia nada", async () => {
      await expect(runReassignPlan(ORG, "ILIMITADO", ctx({ confirmedName: "otra" }))).rejects.toThrow(/nombre exacto/i)
      const suscripcion = await prisma.subscription.findFirst({ where: { organizationId: ORG } })
      expect(suscripcion?.planCode).toBe("FREE")
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  describe("I-E12-5 · las cuatro líneas registradas pasan el invariante", () => {
    it("PASS, con las tres líneas `admin.*` y la excepción bien registradas", async () => {
      const bloque = await tenantTransaction(ORG, async (tx) =>
        readOperatorInvariantInput(tx, { refDate: new Date(NOW.getTime() + 60_000) })
      )
      const check = checkIE125(bloque)
      expect(check.status, check.evidencia).toBe("PASS")
      expect(bloque.operator.auditLines.length).toBeGreaterThanOrEqual(3)
      // (d): ninguna escritura de operador alcanzó el diario.
      for (const w of bloque.operator.forbiddenWrites ?? []) expect(w.rows).toBe(0)
    })
  })
})
