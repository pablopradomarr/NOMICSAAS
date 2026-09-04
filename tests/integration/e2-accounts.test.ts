import { afterAll, beforeAll, describe, expect, it } from "vitest"

// lib/db construye el PrismaClient al importarse: la URL debe fijarse antes.
const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

const { prisma, tenantDb } = await import("@/lib/db")
const {
  createAccount,
  deleteAccount,
  getAccountUsage,
  getPlan,
  importNpgc,
  setAccountActive,
  updateAccount,
  checkAnalyticCoherence,
} = await import("@/models/accounts")
const { getAccountMapByKey, setAccountMapEntry, validateOrganizationAccountMap } = await import(
  "@/models/account-map"
)
const { closeTaxRate, createTaxRate, getTaxRateInForce, listTaxRates } = await import("@/models/tax-rates")
const { listAuditLog } = await import("@/models/audit-log")
const { REQUIRED_ACCOUNT_KEYS } = await import("@/lib/accounts/map")

const ORG_A = "e2000000-0000-4000-8000-00000000000a"
const ORG_B = "e2000000-0000-4000-8000-00000000000b"
const USER_A = "e2000000-0000-4000-8000-0000000000a1"

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

describe.skipIf(!TEST_DATABASE_URL)("E2 · plan de cuentas por organización (I10, I-plan-1)", () => {
  const dbA = tenantDb(ORG_A)
  const dbB = tenantDb(ORG_B)

  beforeAll(async () => {
    await cleanup()
    await prisma.user.create({ data: { id: USER_A, email: "e2-accounts@test.local", name: "E2" } })
    await prisma.organization.createMany({
      data: [
        { id: ORG_A, slug: "e2-org-a", name: "E2 Org A", pgcVariant: "PYMES", updatedAt: new Date() },
        { id: ORG_B, slug: "e2-org-b", name: "E2 Org B", pgcVariant: "GENERAL", updatedAt: new Date() },
      ],
    })
    await prisma.membership.create({
      data: { organizationId: ORG_A, userId: USER_A, role: "ADMIN", updatedAt: new Date() },
    })
  }, 120_000)

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  async function cleanup() {
    await prisma.auditLog.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await prisma.taxRate.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await prisma.organizationAccountMap.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } })
    await prisma.$executeRawUnsafe(
      `DELETE FROM "accounts" WHERE organization_id = ANY($1::uuid[])`,
      [ORG_A, ORG_B]
    )
    await prisma.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } })
    await prisma.user.deleteMany({ where: { id: USER_A } })
  }

  it("criterio 1 · siembra PYMES: 798 cuentas, 43 claves y los tipos de sistema", async () => {
    const result = await importNpgc(ORG_A, "PYMES", {
      actor: { userId: USER_A },
      now: d("2026-09-04"),
      useSubaccounts: true,
    })
    // 794 del seed + 5720 + 47510/11/12 (§3.4).
    expect(result.created).toBe(798)
    expect(await dbA.ledgerAccount.count()).toBe(798)
    expect(result.unresolvedKeys).toEqual([])

    const map = await getAccountMapByKey(dbA)
    for (const key of REQUIRED_ACCOUNT_KEYS) expect(map.get(key), key).toBeTruthy()
    const check = await validateOrganizationAccountMap(dbA)
    expect(check.ok, check.ok ? "" : JSON.stringify(check.errors)).toBe(true)

    // El mapa apunta SIEMPRE a la hoja (§3.4).
    expect(map.get("BANCO_DEFAULT")).toBe("5720")
    expect(map.get("CLIENTES")).toBe("4300")
    expect(map.get("IRPF_ALQUILERES_A_PAGAR")).toBe("47511")

    const tipos = await listTaxRates(dbA)
    expect(tipos.length).toBeGreaterThan(20)
    const recargo = tipos.find((t) => t.code === "REQ_1_75")
    expect(recargo?.rateBps).toBe(175)
    expect(recargo?.linkedTaxRateId).toBe(tipos.find((t) => t.code === "IVA_21")?.id)

    const logs = await listAuditLog(dbA, { entity: "Organization", action: "seed" })
    expect(logs).toHaveLength(1)
    expect((logs[0].after as { variant: string }).variant).toBe("PYMES")
  }, 180_000)

  it("criterio 2 · idempotencia: la segunda pasada no crea nada ni pisa el renombrado", async () => {
    await updateAccount(ORG_A, "705", { name: "Honorarios de consultoría" }, { userId: USER_A }, "renombrado")
    const desactivada = await setAccountActive(ORG_A, "621", false, { userId: USER_A }, "no se usa")
    expect(desactivada.ok).toBe(true)
    // R-06: una cuenta de sistema NO se desactiva (rompería I-plan-1 al resembrar).
    const sistema = await setAccountActive(ORG_A, "640", false, { userId: USER_A }, "prueba")
    expect(sistema.ok).toBe(false)

    const result = await importNpgc(ORG_A, "PYMES", { actor: { userId: USER_A }, now: d("2026-09-05") })
    expect(result.created).toBe(0)
    expect(result.updated).toBe(0)
    expect(result.skipped).toBe(794)

    const plan = await getPlan(dbA)
    expect(plan.byCode.get("705")?.name).toBe("Honorarios de consultoría")
    expect(plan.byCode.get("621")?.isActive).toBe(false)
    expect(plan.byCode.get("640")?.isActive).toBe(true)
    // Y queda constancia del segundo intento.
    expect(await listAuditLog(dbA, { entity: "Organization", action: "seed" })).toHaveLength(2)
  }, 180_000)

  it("GENERAL siembra 910 cuentas en la otra organización — y no hay fuga (I10)", async () => {
    const result = await importNpgc(ORG_B, "GENERAL", { now: d("2026-09-04") })
    expect(result.created).toBe(910) // 906 + 4 subcuentas operativas
    expect(await dbB.ledgerAccount.count()).toBe(910)
    expect(await dbA.ledgerAccount.count()).toBe(798)

    // Fuga = 0 en las cuatro tablas nuevas: cada organización sólo ve lo suyo.
    for (const [db, orgId] of [
      [dbA, ORG_A],
      [dbB, ORG_B],
    ] as const) {
      const ajenas = await db.ledgerAccount.findMany({ where: { organizationId: { not: orgId } } })
      expect(ajenas).toEqual([])
      expect(await db.organizationAccountMap.count({ where: { organizationId: { not: orgId } } })).toBe(0)
      expect(await db.taxRate.count({ where: { organizationId: { not: orgId } } })).toBe(0)
      expect(await db.auditLog.count({ where: { organizationId: { not: orgId } } })).toBe(0)
    }

    // La misma cuenta 705 existe en las dos, con nombre distinto (I7).
    const a = await dbA.ledgerAccount.findFirst({ where: { code: "705" } })
    const b = await dbB.ledgerAccount.findFirst({ where: { code: "705" } })
    expect(a?.name).toBe("Honorarios de consultoría")
    expect(b?.name).not.toBe(a?.name)
    expect(a?.id).not.toBe(b?.id)
  }, 240_000)

  it("criterio 3 · subcuenta: hereda del padre y lo degrada en la MISMA transacción (I-E2-2)", async () => {
    const created = await createAccount(
      ORG_A,
      { code: "7050001", name: "Consultoría – Cliente X" },
      { userId: USER_A }
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.account).toMatchObject({
      parentCode: "705",
      level: 7,
      statement: "PYG",
      analyticType: "INGRESO_DIRECTO",
      isPostable: true,
    })
    expect(created.account.epigraph).toBeTruthy()
    expect(created.account.epigraphPymes).toBeTruthy()

    const padre = await dbA.ledgerAccount.findFirst({ where: { code: "705" } })
    expect(padre?.isPostable).toBe(false)

    const logs = await listAuditLog(dbA, { entity: "LedgerAccount", entityId: created.account.id })
    expect(logs.map((l) => l.action)).toEqual(["create"])
  })

  it("criterio 4 · borrado: la mapeada falla con IS_MAPPED; la libre se borra y deja el `before`", async () => {
    const mapeada = await deleteAccount(ORG_A, "5720", { userId: USER_A }, "prueba")
    expect(mapeada.ok).toBe(false)
    if (!mapeada.ok) {
      expect(mapeada.errors.map((e) => e.code)).toContain("SYSTEM_ACCOUNT")
      expect(mapeada.errors.map((e) => e.code)).toContain("IS_MAPPED")
    }
    expect(await dbA.ledgerAccount.findFirst({ where: { code: "5720" } })).not.toBeNull()

    const borrada = await deleteAccount(ORG_A, "7050001", { userId: USER_A }, "creada por error")
    expect(borrada.ok).toBe(true)
    expect(await dbA.ledgerAccount.findFirst({ where: { code: "7050001" } })).toBeNull()
    // El padre vuelve a ser hoja postable.
    expect((await dbA.ledgerAccount.findFirst({ where: { code: "705" } }))?.isPostable).toBe(true)

    const logs = await listAuditLog(dbA, { entity: "LedgerAccount", action: "delete" })
    expect(logs).toHaveLength(1)
    expect((logs[0].before as { code: string }).code).toBe("7050001")
    expect(logs[0].reason).toBe("creada por error")
  })

  it("getAccountUsage: `movementCount` es 0 hasta E3 (contrato fijado, riesgo R6)", async () => {
    const usage = await getAccountUsage(dbA, "477")
    expect(usage.movementCount).toBe(0)
    expect(usage.mappedKeys).toContain("IVA_REPERCUTIDO")
    expect(usage.taxRateCodes).toContain("IVA_21")
  })

  it("remapeo: marca la nueva cuenta isSystem, desmarca la anterior y exige motivo", async () => {
    const before = await getAccountMapByKey(dbA)
    expect(before.get("COMPRAS_DEFAULT")).toBe("600")

    const result = await setAccountMapEntry(ORG_A, "COMPRAS_DEFAULT", "607", { userId: USER_A }, "empresa de servicios")
    expect(result.ok).toBe(true)
    const after = await getAccountMapByKey(dbA)
    expect(after.get("COMPRAS_DEFAULT")).toBe("607")
    expect((await dbA.ledgerAccount.findFirst({ where: { code: "607" } }))?.isSystem).toBe(true)
    expect((await dbA.ledgerAccount.findFirst({ where: { code: "600" } }))?.isSystem).toBe(false)

    const logs = await listAuditLog(dbA, { entity: "OrganizationAccountMap", action: "remap" })
    expect(logs).toHaveLength(1)
    expect(logs[0].reason).toBe("empresa de servicios")

    // Una cuenta no postable no se admite como destino (I-plan-1).
    const invalida = await setAccountMapEntry(ORG_A, "COMPRAS_DEFAULT", "60", { userId: USER_A }, "prueba")
    expect(invalida.ok).toBe(false)
  })

  it("criterio 8 · vigencia de impuestos: solape rechazado, cierre y selección por fecha", async () => {
    const iva21 = (await listTaxRates(dbA)).find((t) => t.code === "IVA_21")
    if (!iva21) throw new Error("IVA_21 no sembrado")

    const solapa = await createTaxRate(
      ORG_A,
      {
        code: "IVA_21",
        name: "IVA 21 % (nuevo)",
        kind: "IVA",
        rateBps: 2100,
        appliesTo: "BOTH",
        accountCode: iva21.accountCode,
        counterAccountCode: iva21.counterAccountCode,
        linkedTaxRateId: null,
        validFrom: d("2026-06-01"),
        validTo: null,
      },
      { userId: USER_A }
    )
    expect(solapa.ok).toBe(false)
    if (!solapa.ok) expect(solapa.errors[0].code).toBe("RATE_OVERLAP")

    const cerrado = await closeTaxRate(ORG_A, iva21.id, d("2026-05-31"), { userId: USER_A }, "cambio normativo")
    expect(cerrado.ok).toBe(true)

    const nuevo = await createTaxRate(
      ORG_A,
      {
        code: "IVA_21",
        name: "IVA 21 % (desde jun-2026)",
        kind: "IVA",
        rateBps: 2100,
        appliesTo: "BOTH",
        accountCode: iva21.accountCode,
        counterAccountCode: iva21.counterAccountCode,
        linkedTaxRateId: null,
        validFrom: d("2026-06-01"),
        validTo: null,
      },
      { userId: USER_A }
    )
    expect(nuevo.ok, nuevo.ok ? "" : JSON.stringify(nuevo.errors)).toBe(true)

    expect(await getTaxRateInForce(dbA, "IVA_21", d("2024-03-01"))).toBeNull()
    expect((await getTaxRateInForce(dbA, "IVA_21", d("2026-03-01")))?.id).toBe(iva21.id)
    expect((await getTaxRateInForce(dbA, "IVA_21", d("2026-07-01")))?.name).toBe("IVA 21 % (desde jun-2026)")

    // El EXCLUDE de la base es la segunda barrera del mismo invariante (I-E2-3).
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "tax_rates" (id, organization_id, code, name, kind, rate_bps, applies_to, account_code, valid_from, updated_at)
         VALUES (gen_random_uuid(), $1, 'IVA_21', 'Duplicado', 'IVA', 2100, 'BOTH', $2, DATE '2026-08-01', now())`,
        ORG_A,
        iva21.accountCode
      )
    ).rejects.toThrow(/exclusion constraint|tax_rates_validity_overlap_excl/i)
  })

  it("I-E2-6 · el plan sembrado no tiene divergencias analíticas", async () => {
    expect(await checkAnalyticCoherence(dbA, "PYMES")).toEqual([])
    expect(await checkAnalyticCoherence(dbB, "GENERAL")).toEqual([])
  })

  it("I10 · la BASE DE DATOS corta el mapeo a una cuenta de otra organización", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "organization_account_maps" (id, organization_id, key, account_code, updated_at)
         VALUES (gen_random_uuid(), $1, 'CAJA', '99999999', now())`,
        ORG_A
      )
    ).rejects.toThrow(/foreign key|violates/i)
    expect(await dbA.organizationAccountMap.count({ where: { accountCode: "99999999" } })).toBe(0)
  })

  it("audit_logs: la barrera 1 NO lo protege — `tenantDb` sí deja borrar (QA)", async () => {
    const [log] = await listAuditLog(dbA, { take: 1 })
    expect(log).toBeTruthy()

    // Corrección del comentario anterior, que afirmaba que «tenantDb tampoco
    // puede saltárselo»: es FALSO. `tenantDb` expone `auditLog.delete/update`
    // como cualquier otro modelo y esta suite corre como PROPIETARIO de las
    // tablas, que sin `FORCE ROW LEVEL SECURITY` esquiva las políticas. El
    // append-only de ADR-0008 lo garantiza la barrera 2 y SÓLO cuando se conecta
    // como `app_runtime`: se ejerce en tests/integration-rls/e2-app-runtime.test.ts.
    // Aquí se deja escrito el límite para que nadie lo confunda con una garantía.
    const total = await dbA.auditLog.count()
    expect(total).toBeGreaterThan(0)

    const copia = await dbA.auditLog.create({
      data: { organizationId: ORG_A, entity: "Organization", entityId: ORG_A, action: "update" },
    })
    const borradas = await dbA.auditLog.deleteMany({ where: { id: copia.id } })
    expect(borradas.count, "como propietario, la barrera 1 no impide el borrado").toBe(1)
  })
})
