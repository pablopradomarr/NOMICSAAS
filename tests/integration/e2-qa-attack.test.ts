import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"

// lib/db construye el PrismaClient al importarse: la URL debe fijarse antes.
const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

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

let currentUser: { id: string; email: string; name: string }
vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => currentUser,
  getSession: async () => ({ user: currentUser }),
  isSubscriptionExpired: () => false,
  isAiBalanceExhausted: () => false,
}))

const { prisma, tenantDb, TenantError } = await import("@/lib/db")
const {
  createAccount,
  deleteAccount,
  getPlan,
  importCustomPlan,
  importNpgc,
  setAccountActive,
  updateAccount,
} = await import("@/models/accounts")
const { createTaxRate, closeTaxRate, listTaxRates } = await import("@/models/tax-rates")
const { listAuditLog } = await import("@/models/audit-log")
const { validateAccountUpdate } = await import("@/lib/accounts/validate")
const { epigraphCatalog } = await import("@/lib/accounts/epigraphs")
const { loadNpgcSeed } = await import("@/models/npgc-seed")
const { isInForce, overlaps } = await import("@/lib/taxes/rates")
const {
  createAccountAction,
  setAccountActiveAction,
  importPlanCsvAction,
} = await import("@/app/(app)/settings/accounts/actions")
const { createTaxRateAction } = await import("@/app/(app)/settings/taxes/actions")
const { setAccountMapEntryAction } = await import("@/app/(app)/settings/account-map/actions")

const ORG_A = "e2aa0000-0000-4000-8000-00000000000a"
const ORG_B = "e2aa0000-0000-4000-8000-00000000000b"
const ADMIN = "e2aa0000-0000-4000-8000-0000000000a1"
const EDITOR = "e2aa0000-0000-4000-8000-0000000000e1"
const VIEWER = "e2aa0000-0000-4000-8000-0000000000c1"

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const dbA = tenantDb(ORG_A)
const dbB = tenantDb(ORG_B)

const form = (fields: Record<string, string>) => {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  return fd
}
const asAdmin = () => (currentUser = { id: ADMIN, email: "a@test.local", name: "Admin" })
const asEditor = () => (currentUser = { id: EDITOR, email: "e@test.local", name: "Editor" })
const asViewer = () => (currentUser = { id: VIEWER, email: "v@test.local", name: "Viewer" })

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
  await prisma.taxRate.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
  await prisma.organizationAccountMap.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
  await prisma.$executeRawUnsafe(`DELETE FROM "accounts" WHERE organization_id = ANY($1::uuid[])`, [ORG_A, ORG_B])
  await prisma.membership.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
  await prisma.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } })
  await prisma.user.deleteMany({ where: { id: { in: [ADMIN, EDITOR, VIEWER] } } })
}

/** Hash estable de una fila de cuenta, para comparar idempotencia sin depender del orden de columnas. */
function rowHash(row: Record<string, unknown>): string {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = row as Record<string, unknown>
  return createHash("sha256").update(JSON.stringify(rest, Object.keys(rest).sort())).digest("hex")
}

describe.skipIf(!TEST_DATABASE_URL)("QA E2 · intento de romperlo (bc16710 / a0ce6e9)", () => {
  beforeAll(async () => {
    await cleanup()
    await prisma.user.createMany({
      data: [
        { id: ADMIN, email: "a@test.local", name: "Admin" },
        { id: EDITOR, email: "e@test.local", name: "Editor" },
        { id: VIEWER, email: "v@test.local", name: "Viewer" },
      ],
    })
    await prisma.organization.createMany({
      data: [
        { id: ORG_A, slug: "qa-org-a", name: "QA Org A", pgcVariant: "PYMES", updatedAt: new Date() },
        { id: ORG_B, slug: "qa-org-b", name: "QA Org B", pgcVariant: "PYMES", updatedAt: new Date() },
      ],
    })
    await prisma.membership.createMany({
      data: [
        { organizationId: ORG_A, userId: ADMIN, role: "ADMIN", updatedAt: new Date() },
        { organizationId: ORG_A, userId: EDITOR, role: "EDITOR", updatedAt: new Date() },
        { organizationId: ORG_A, userId: VIEWER, role: "VIEWER", updatedAt: new Date() },
      ],
    })
    await importNpgc(ORG_A, "PYMES", { actor: { userId: ADMIN }, now: d("2026-09-04"), useSubaccounts: true })
    await importNpgc(ORG_B, "PYMES", { actor: { userId: null }, now: d("2026-09-04") })
    asAdmin()
  }, 180_000)

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  // (a) importNpgc dos veces → idéntico, comparando hashes de fila.
  it("(a) idempotencia por hash: dos importaciones sucesivas no cambian ninguna fila", async () => {
    const before = await dbA.ledgerAccount.findMany({ orderBy: { code: "asc" } })
    const hashesBefore = before.map(rowHash)

    const result = await importNpgc(ORG_A, "PYMES", { actor: { userId: ADMIN }, now: d("2026-09-06") })
    expect(result.created).toBe(0)
    expect(result.updated).toBe(0)

    const after = await dbA.ledgerAccount.findMany({ orderBy: { code: "asc" } })
    expect(after).toHaveLength(before.length)
    expect(after.map(rowHash)).toEqual(hashesBefore)
  }, 120_000)

  // (b) renombrar y reseed no pisa el nombre.
  it("(b) renombrar 430 y reseed conserva el nombre del usuario tras VARIAS pasadas", async () => {
    await updateAccount(ORG_A, "430", { name: "Clientes (renombrada QA)" }, { userId: ADMIN }, "prueba QA")
    for (let i = 0; i < 3; i++) {
      await importNpgc(ORG_A, "PYMES", { actor: { userId: ADMIN }, now: d(`2026-09-0${7 + i}`) })
    }
    const plan = await getPlan(dbA)
    expect(plan.byCode.get("430")?.name).toBe("Clientes (renombrada QA)")
  }, 120_000)

  // (c) subcuentas inválidas.
  describe("(c) alta de subcuenta", () => {
    it("código de otra rama (sin padre por prefijo) se rechaza", async () => {
      const r = await createAccount(ORG_A, { code: "7059999123", name: "Rama ajena" }, { userId: ADMIN })
      // 705 existe: en realidad esto SÍ tendría padre 705 (prefijo). Probamos una rama sin ningún prefijo real.
      const r2 = await createAccount(ORG_A, { code: "999888777", name: "Sin padre real" }, { userId: ADMIN })
      expect(r2.ok).toBe(false)
      if (!r2.ok) expect(r2.errors.map((e) => e.code)).toContain("PARENT_NOT_FOUND")
      void r
    })

    it("longitud inválida (>12 dígitos) se rechaza", async () => {
      const r = await createAccount(ORG_A, { code: "7050001234567", name: "Demasiado larga" }, { userId: ADMIN })
      expect(r.ok).toBe(false)
    })

    it("bajo cuenta padre inactiva se rechaza (R-03)", async () => {
      const off = await setAccountActive(ORG_A, "621", false, { userId: ADMIN }, "no se usa (QA)")
      expect(off.ok).toBe(true)
      const r = await createAccount(ORG_A, { code: "6210001", name: "Hija de inactiva" }, { userId: ADMIN })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors.map((e) => e.code)).toContain("PARENT_INACTIVE")
      await setAccountActive(ORG_A, "621", true, { userId: ADMIN }, "reactivar (QA)")
    })

    it("código duplicado se rechaza", async () => {
      const first = await createAccount(ORG_A, { code: "7050002", name: "Cliente Y" }, { userId: ADMIN })
      expect(first.ok).toBe(true)
      const dup = await createAccount(ORG_A, { code: "7050002", name: "Cliente Y otra vez" }, { userId: ADMIN })
      expect(dup.ok).toBe(false)
      if (!dup.ok) expect(dup.errors.map((e) => e.code)).toContain("CODE_DUPLICATE")
      await deleteAccount(ORG_A, "7050002", { userId: ADMIN }, "limpieza QA")
    })
  })

  // (d) desactivar cuenta de sistema o con hijos activos.
  describe("(d) desactivación bloqueada", () => {
    it("cuenta de sistema (mapeada) no se puede desactivar", async () => {
      const r = await setAccountActive(ORG_A, "5720", false, { userId: ADMIN }, "motivo QA")
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors.map((e) => e.code)).toContain("SYSTEM_ACCOUNT")
    })

    it("cuenta con hijos activos no se puede desactivar", async () => {
      // 705 tiene hijas activas (7050001 del criterio 3 de e2-accounts, y ahora 7050002 fue borrada) —
      // creamos una hija propia para no depender de otro fichero.
      const created = await createAccount(ORG_A, { code: "7050003", name: "Hija QA" }, { userId: ADMIN })
      expect(created.ok).toBe(true)
      const r = await setAccountActive(ORG_A, "705", false, { userId: ADMIN }, "motivo QA")
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors.map((e) => e.code)).toContain("HAS_CHILDREN")
      await deleteAccount(ORG_A, "7050003", { userId: ADMIN }, "limpieza QA")
    })
  })

  // (e) cambiar epígrafe sin motivo o con epígrafe fuera de catálogo; statement de oficial prohibido.
  describe("(e) clasificación de cuenta oficial", () => {
    const ctxFor = async (code: string) => {
      const plan = await getPlan(dbA)
      const before = plan.byCode.get(code)!
      return {
        before,
        ctx: {
          plan,
          role: "ADMIN" as const,
          variant: "PYMES" as const,
          epigraphCatalog: epigraphCatalog(loadNpgcSeed().rows, "PYMES"),
          usage: { movementCount: 0, childCount: 0, mappedKeys: [], taxRateCodes: [] },
          hasClosedPeriodLines: false,
        },
      }
    }

    it("epígrafe sin motivo en cuenta SEED se rechaza (R-10b)", async () => {
      const { before, ctx } = await ctxFor("430")
      const currentEpigraph = before.epigraphPymes ?? before.epigraph
      const otherEpigraph = [...ctx.epigraphCatalog].find((e) => e !== currentEpigraph)!
      const result = validateAccountUpdate(before, { epigraph: otherEpigraph }, ctx)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("REASON_REQUIRED")
    })

    it("epígrafe fuera del catálogo cerrado se rechaza (R-15)", async () => {
      const { before, ctx } = await ctxFor("430")
      const result = validateAccountUpdate(before, { epigraph: "Un epígrafe inventado que no existe", reason: "motivo" }, ctx)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("EPIGRAPH_UNKNOWN")
    })

    it("statement de cuenta oficial de nivel ≤ 3 prohibido a TODOS los roles (R-10a)", async () => {
      const { before, ctx } = await ctxFor("430")
      for (const role of ["ADMIN", "EDITOR", "VIEWER"] as const) {
        const result = validateAccountUpdate(before, { statement: "PYG" as never }, { ...ctx, role })
        expect(result.ok, role).toBe(false)
        if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("STATEMENT_LOCKED")
      }
    })
  })

  // (f) CSV malformado.
  describe("(f) import CSV — todo o nada", () => {
    it("filas malformadas, huérfanas y duplicadas: se rechaza el fichero entero, sin escribir nada", async () => {
      const before = await dbA.ledgerAccount.count()
      const csv = [
        "Cuenta;Descripcion",
        "6010;Compra QA válida",
        "0602;Código con cero a la izquierda", // malformada
        "999888;Sin padre en el plan", // huérfana
        "6010;Compra QA duplicada", // duplicada
      ].join("\n")
      const result = await importCustomPlan(
        ORG_A,
        csv,
        { code: "Cuenta", name: "Descripcion" },
        {
          variant: "PYMES",
          defaults: { nature: "DEUDORA", statement: null, delimiter: ";" },
          epigraphCatalog: epigraphCatalog(loadNpgcSeed().rows, "PYMES"),
          actor: { userId: ADMIN },
          dryRun: false,
          fileName: "malo.csv",
        }
      )
      expect(result.ok).toBe(false)
      expect(await dbA.ledgerAccount.count()).toBe(before)
    })

    it("import contra una cuenta de sistema borrada previamente no revive R-06 por la puerta de atrás", async () => {
      // 5720 es de sistema (BANCO_DEFAULT); no se puede borrar (IS_MAPPED) y por
      // tanto tampoco se puede "recrear" con otra clasificación vía CSV mientras exista.
      const csv = ["Cuenta;Descripcion", "5720;Banco reclasificado por CSV"].join("\n")
      const before = await dbA.ledgerAccount.findFirst({ where: { code: "5720" } })
      expect(before?.isSystem).toBe(true)

      const del = await deleteAccount(ORG_A, "5720", { userId: ADMIN }, "intento QA")
      expect(del.ok).toBe(false)

      // Como sigue existiendo, un import que la referencia sólo la actualiza (mismo código == misma fila),
      // nunca la sustituye ni pierde su marca de sistema.
      const result = await importCustomPlan(
        ORG_A,
        csv,
        { code: "Cuenta", name: "Descripcion" },
        {
          variant: "PYMES",
          defaults: { nature: "DEUDORA", statement: null, delimiter: ";" },
          epigraphCatalog: epigraphCatalog(loadNpgcSeed().rows, "PYMES"),
          actor: { userId: ADMIN },
          dryRun: false,
          fileName: "sistema.csv",
        }
      )
      if (result.ok) {
        const after = await dbA.ledgerAccount.findFirst({ where: { code: "5720" } })
        expect(after?.isSystem).toBe(true)
      }
    })
  })

  // (g) TaxRate.
  describe("(g) tipos impositivos", () => {
    it("vigencias solapadas se rechazan (EXCLUDE + validación pura coinciden)", async () => {
      const iva21 = (await listTaxRates(dbA)).find((t) => t.code === "IVA_21")!
      const overlapping = await createTaxRate(
        ORG_A,
        {
          code: "IVA_21",
          name: "IVA 21 % solapado QA",
          kind: "IVA",
          rateBps: 2100,
          appliesTo: "BOTH",
          accountCode: iva21.accountCode,
          counterAccountCode: iva21.counterAccountCode,
          linkedTaxRateId: null,
          validFrom: d("2025-06-01"),
          validTo: null,
        },
        { userId: ADMIN }
      )
      expect(overlapping.ok).toBe(false)
      if (!overlapping.ok) expect(overlapping.errors.map((e) => e.code)).toContain("RATE_OVERLAP")
    })

    it("recargo enlazado a un id inexistente se rechaza (RATE_LINK)", async () => {
      const r = await createTaxRate(
        ORG_A,
        {
          code: "REQ_QA",
          name: "Recargo QA huérfano",
          kind: "RECARGO",
          rateBps: 520,
          appliesTo: "SALE",
          accountCode: (await listTaxRates(dbA)).find((t) => t.code === "IVA_21")!.accountCode,
          counterAccountCode: null,
          linkedTaxRateId: "00000000-0000-4000-8000-000000000000",
          validFrom: d("2026-01-01"),
          validTo: null,
        },
        { userId: ADMIN }
      )
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors.map((e) => e.code)).toContain("RATE_LINK")
    })

    it("rateBps negativo se rechaza (RATE_RANGE)", async () => {
      const r = await createTaxRate(
        ORG_A,
        {
          code: "IVA_QA_NEG",
          name: "Tipo negativo QA",
          kind: "IVA",
          rateBps: -100,
          appliesTo: "BOTH",
          accountCode: (await listTaxRates(dbA)).find((t) => t.code === "IVA_21")!.accountCode,
          counterAccountCode: null,
          linkedTaxRateId: null,
          validFrom: d("2026-01-01"),
          validTo: null,
        },
        { userId: ADMIN }
      )
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors.map((e) => e.code)).toContain("RATE_RANGE")
    })

    it("coherencia de frontera: validTo es inclusivo en lib/taxes y en el EXCLUDE de la BD", async () => {
      const iva21 = (await listTaxRates(dbA)).find((t) => t.code === "IVA_21")!
      // isInForce (motor puro): el propio día de validFrom cuenta como vigente.
      expect(isInForce({ validFrom: iva21.validFrom, validTo: null }, iva21.validFrom)).toBe(true)

      const closed = await closeTaxRate(ORG_A, iva21.id, d("2026-05-31"), { userId: ADMIN }, "cierre QA")
      expect(closed.ok).toBe(true)
      if (!closed.ok) return
      // El día de cierre (validTo) SIGUE vigente: [from, to] inclusive en ambos extremos.
      expect(isInForce(closed.value, d("2026-05-31"))).toBe(true)
      expect(isInForce(closed.value, d("2026-06-01"))).toBe(false)

      // Un tipo que empezara justo ese mismo día 2026-05-31 solaparía (mismo criterio que la BD).
      expect(
        overlaps(closed.value, { validFrom: d("2026-05-31"), validTo: null })
      ).toBe(true)
      // Uno que empiece al día siguiente, no.
      expect(overlaps(closed.value, { validFrom: d("2026-06-01"), validTo: null })).toBe(false)

      // Reabrir para no afectar a otros tests de este fichero.
      await createTaxRate(
        ORG_A,
        {
          code: "IVA_21",
          name: "IVA 21 % (reabierto QA)",
          kind: "IVA",
          rateBps: 2100,
          appliesTo: "BOTH",
          accountCode: iva21.accountCode,
          counterAccountCode: iva21.counterAccountCode,
          linkedTaxRateId: null,
          validFrom: d("2026-06-01"),
          validTo: null,
        },
        { userId: ADMIN }
      )
    })
  })

  // (h) tenant leak en las 4 tablas nuevas, vía tenantDb.
  describe("(h) fuga entre organizaciones vía tenantDb", () => {
    it("no se ve NADA de la otra organización en accounts/maps/tax_rates/audit_logs", async () => {
      for (const [db, other] of [
        [dbA, ORG_B],
        [dbB, ORG_A],
      ] as const) {
        expect(await db.ledgerAccount.count({ where: { organizationId: other } })).toBe(0)
        expect(await db.organizationAccountMap.count({ where: { organizationId: other } })).toBe(0)
        expect(await db.taxRate.count({ where: { organizationId: other } })).toBe(0)
        expect(await db.auditLog.count({ where: { organizationId: other } })).toBe(0)
      }
    })

    it("escritura cruzada explícita (organizationId ajeno) se rechaza en la capa tenantDb", async () => {
      await expect(
        dbA.ledgerAccount.create({
          data: {
            organizationId: ORG_B,
            code: "999",
            name: "Intrusa vía tenantDb",
            level: 3,
            nature: "DEUDORA",
          } as never,
        })
      ).rejects.toThrow(TenantError)
    })

    it("un selector único de otra organización no se puede actualizar desde dbA", async () => {
      await expect(
        dbA.ledgerAccount.update({
          where: { organizationId_code: { organizationId: ORG_B, code: "705" } } as never,
          data: { name: "Secuestrada vía tenantDb" },
        })
      ).rejects.toThrow()
      const untouched = await dbB.ledgerAccount.findFirst({ where: { code: "705" } })
      expect(untouched?.name).not.toBe("Secuestrada vía tenantDb")
    })
  })

  // (i) VIEWER/EDITOR en TODAS las actions de mutación (cuentas, mapa, impuestos).
  describe("(i) matriz de roles en las server actions de mutación", () => {
    it("EDITOR y VIEWER no pueden crear cuentas", async () => {
      for (const login of [asEditor, asViewer]) {
        login()
        const r = await createAccountAction(null, form({ code: "7050099", name: "No debería" }))
        expect(r).toEqual({ success: false, error: "Sin permiso" })
      }
      asAdmin()
      expect(await dbA.ledgerAccount.count({ where: { code: "7050099" } })).toBe(0)
    })

    it("EDITOR y VIEWER no pueden (des)activar cuentas", async () => {
      for (const login of [asEditor, asViewer]) {
        login()
        const r = await setAccountActiveAction(null, form({ code: "705", isActive: "false", reason: "no debería" }))
        expect(r.success).toBe(false)
      }
      asAdmin()
    })

    it("EDITOR y VIEWER no pueden importar CSV", async () => {
      for (const login of [asEditor, asViewer]) {
        login()
        const r = await importPlanCsvAction(
          null,
          form({ csv: "Cuenta;Descripcion\n6011;X", delimiter: ";", mappingCode: "Cuenta", mappingName: "Descripcion", dryRun: "false" })
        )
        expect(r).toEqual({ success: false, error: "Sin permiso" })
      }
      asAdmin()
      expect(await dbA.ledgerAccount.count({ where: { code: "6011" } })).toBe(0)
    })

    it("EDITOR y VIEWER no pueden crear/cerrar tipos impositivos ni cambiar el mapa", async () => {
      for (const login of [asEditor, asViewer]) {
        login()
        const createR = await createTaxRateAction(
          null,
          form({
            code: "IVA_QA_ROL",
            name: "No debería",
            kind: "IVA",
            rateBps: "2100",
            appliesTo: "BOTH",
            accountCode: "477",
            validFrom: "2026-01-01",
          })
        )
        expect(createR).toEqual({ success: false, error: "Sin permiso" })

        const mapR = await setAccountMapEntryAction(null, form({ key: "BANCO_DEFAULT", accountCode: "705", reason: "no debería" }))
        expect(mapR).toEqual({ success: false, error: "Sin permiso" })
      }
      asAdmin()
      expect(await dbA.taxRate.count({ where: { code: "IVA_QA_ROL" } })).toBe(0)
    })
  })

  // (j) AuditLog: before/after en cada mutación; audit_logs no editable por la app.
  describe("(j) AuditLog completo y append-only por diseño de la aplicación", () => {
    it("createAccount / setAccountActive / deleteAccount dejan before/after coherentes", async () => {
      const created = await createAccount(ORG_A, { code: "7050004", name: "Auditoría QA" }, { userId: ADMIN }, "alta QA")
      expect(created.ok).toBe(true)
      if (!created.ok) return

      const off = await setAccountActive(ORG_A, "7050004", false, { userId: ADMIN }, "baja QA")
      expect(off.ok).toBe(true)
      // Una cuenta inactiva SIN apuntes/hijos/mapeo SÍ se puede borrar (R-08 no mira isActive).
      await setAccountActive(ORG_A, "7050004", true, { userId: ADMIN }, "reactivar QA")
      const del2 = await deleteAccount(ORG_A, "7050004", { userId: ADMIN }, "borrado QA final")
      expect(del2.ok).toBe(true)

      const logs = await listAuditLog(dbA, { entity: "LedgerAccount", entityId: created.account.id })
      const actions = logs.map((l) => l.action)
      expect(actions).toEqual(expect.arrayContaining(["create", "deactivate", "activate", "delete"]))
      const createLog = logs.find((l) => l.action === "create")!
      expect(createLog.before).toBeNull()
      expect(createLog.after).toBeTruthy()
      const deleteLog = logs.find((l) => l.action === "delete")!
      expect(deleteLog.before).toMatchObject({ code: "7050004" })
    })

    it("closeTaxRate y updateTaxPolicy dejan AuditLog con antes/después", async () => {
      const before = await listTaxRates(dbA)
      const iva10 = before.find((t) => t.code === "IVA_10")!
      const closed = await closeTaxRate(ORG_A, iva10.id, d("2099-12-31"), { userId: ADMIN }, "cierre lejano QA")
      expect(closed.ok).toBe(true)
      const logs = await listAuditLog(dbA, { entity: "TaxRate", entityId: iva10.id, action: "close" })
      expect(logs[0]?.before).toMatchObject({ validTo: null })
      expect(logs[0]?.after).toMatchObject({ validTo: expect.anything() })
    })

    it("HALLAZGO: `tenantDb` NO bloquea por sí solo un UPDATE de `audit_logs` (sólo RLS/app_runtime lo hace)", async () => {
      // `models/audit-log.ts` sólo expone lectura + escritura; PERO nada en la
      // barrera 1 (`tenantDb`) impide invocar `.update`/`.delete` genérico sobre
      // `auditLog` con el organizationId correcto — `scopeUniqueWhere` sólo
      // acota el tenant, no prohíbe el verbo. La suite `test:integration` corre
      // como propietario de la BD (bypassa RLS), así que aquí la mutación
      // SE APLICA. El append-only real (ADR-0008, `USING (false)`) sólo se
      // demuestra bajo `app_runtime`, en `tests/integration-rls/e2-app-runtime.test.ts`.
      // Este test documenta el límite: la garantía "ni la app puede" depende
      // ÍNTEGRAMENTE de que el proceso de producción conecte como app_runtime.
      const target = (await dbA.auditLog.findFirst())!
      const mutated = await dbA.auditLog.update({
        where: { id: target.id },
        data: { reason: "manipulado por QA (tenantDb, rol propietario)" },
      })
      expect(mutated.reason).toBe("manipulado por QA (tenantDb, rol propietario)")
      // Restaurar para no contaminar otras aserciones de este fichero.
      await dbA.auditLog.update({ where: { id: target.id }, data: { reason: target.reason } })
    })
  })
})
