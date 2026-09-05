import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * E6 · T21 — Integración de los informes financieros contra Postgres de verdad
 * (`docs/design/E6-informes.md` §8.1, criterios 11–19).
 *
 * Lo que se ejerce aquí y no se puede ejercer con funciones puras:
 *  - **I-E6-16**: `report_runs` es append-only de verdad — `UPDATE`/`DELETE`
 *    como `app_runtime` devuelven 42501 y la fila queda intacta.
 *  - la **caché por la clave completa**: mismo periodo y mismo `ledgerHash` con
 *    distinta foto NO reutiliza el run (O-5), y repetir la misma petición sí.
 *  - **I-E6-17**: recalcular con la misma clave da el `result` byte a byte.
 *  - **I-E6-18**: ningún run se sirve con un `ledgerHash` distinto del vigente.
 *  - el **umbral de variación** dispara `REQUIERE REVISIÓN` con `VARIACION_KPI`.
 *  - el **error inyectado**: un céntimo alterado por SQL directo saca I2 en FAIL
 *    y el informe **no** se sirve como validado.
 *  - `ManualReviewFlag`: semi-append-only, único activo, y su efecto en el sello.
 *  - el **export** produce ficheros válidos, con procedencia y con hash estable.
 *  - el `analytics_key` que compone el TRIGGER coincide con el de TypeScript.
 *
 * La suite conecta con el rol PROPIETARIO salvo donde dice lo contrario: la RLS
 * efectiva se ejerce en `tests/integration-rls/e6-tenant.test.ts`.
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

const { prisma, tenantDb, tenantTransaction } = await import("@/lib/db")
const { loadFixtureIntoOrg } = await import("@/scripts/load-fixture")
const {
  clearManualReviewFlag,
  getOrCreateReportRun,
  getReportRun,
  getStatementAccounts,
  listReportRuns,
  setManualReviewFlag,
  setReviewThresholds,
} = await import("@/models/reports")
const { analyticsKeyOf, canonicalResultJson, DEFAULT_REVIEW_THRESHOLDS } = await import("@/lib/ledger/report-run")
const { exportRun } = await import("@/lib/export/report-export")
const { getAnalyticAggregates, getAnalyticLines } = await import("@/models/analytics")
const { appRuntimeDatabaseUrl } = await import("@/tests/support/env")

const ORG = "e6000000-0000-4000-8000-00000000000a"
const USER = "e6000000-0000-4000-8000-0000000000a1"
const PERIOD = { periodStart: "2026-01-01" as const, periodEnd: "2026-12-31" as const }
const actor = { userId: USER }

async function owner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/** Como `app_runtime`, que es el rol con el que la aplicación conecta de verdad. */
async function asRuntime<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: appRuntimeDatabaseUrl(TEST_DATABASE_URL!) })
  await client.connect()
  try {
    await client.query("SELECT set_config('app.current_org', $1, false)", [ORG])
    return await fn(client)
  } finally {
    await client.end()
  }
}

describe.skipIf(!TEST_DATABASE_URL)("E6 · informes financieros en base de datos", () => {
  let fiscalYearId = ""

  beforeAll(async () => {
    await cleanup()
    await prisma.user.create({ data: { id: USER, email: "e6@test.local", name: "E6" } })
    await prisma.organization.create({
      data: { id: ORG, slug: "e6-org", name: "E6 Org", pgcVariant: "PYMES", updatedAt: new Date() },
    })
    await prisma.membership.create({
      data: { organizationId: ORG, userId: USER, role: "ADMIN", updatedAt: new Date() },
    })
    await loadFixtureIntoOrg({ fixture: "ejercicio-completo", organizationId: ORG, userId: USER })
    fiscalYearId = await tenantTransaction(ORG, USER, async (tx) =>
      (await tx.fiscalYear.findFirstOrThrow({ where: { code: "2026" } })).id
    )
  }, 600_000)

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  async function cleanup() {
    await owner(async (client) => {
      await client.query("BEGIN")
      for (const table of [
        "report_runs",
        "manual_review_flags",
        "journal_lines",
        "journal_entries",
        "period_locks",
        "fiscal_years",
        "audit_logs",
        "organization_account_maps",
        "tax_rates",
        "accounts",
        "journal_lines",
        "margin_level_configs",
        "cost_centers",
        "projects",
        "business_lines",
        "transactions",
        "memberships",
      ]) {
        await client.query(`DELETE FROM "${table}" WHERE organization_id = $1::uuid`, [ORG]).catch(() => undefined)
      }
      await client.query(`DELETE FROM organizations WHERE id = $1::uuid`, [ORG])
      await client.query(`DELETE FROM users WHERE id = $1::uuid`, [USER])
      await client.query("COMMIT")
    })
  }

  const balance = (snapshot: string, extra: Record<string, unknown> = {}) =>
    getOrCreateReportRun(ORG, {
      type: "BALANCE",
      ...PERIOD,
      fiscalYearId,
      params: { snapshot, variant: "PYMES", ...extra },
      actor,
    })

  // ───────────────────────────────────────────────────────────────────────────

  it("el balance emitido reproduce las cifras selladas del fixture", async () => {
    const run = await balance("PRE_REGULARIZACION")
    const result = run.result as { totalActivoCents: number; totalPatrimonioNetoCents: number; i2DiffCents: number }
    expect(result.totalActivoCents).toBe(13_673_820)
    expect(result.totalPatrimonioNetoCents).toBe(8_307_322)
    expect(result.i2DiffCents).toBe(0)
    expect(run.origen).toBe("fresh")
  })

  it("criterio 11: la caché es por la clave COMPLETA, `paramsHash` incluido (O-5)", async () => {
    const pre = await balance("PRE_REGULARIZACION")
    // Misma petición, mismo diario → MISMO run, servido de caché.
    const again = await balance("PRE_REGULARIZACION")
    expect(again.id).toBe(pre.id)
    expect(again.origen).toBe("cache")

    // Mismo periodo y mismo `ledgerHash`, distinta foto → run NUEVO. Sin
    // `paramsHash` en la clave, aquí se devolvería el balance equivocado con
    // cifras perfectamente correctas, que es el peor bug posible.
    const post = await balance("POST_REGULARIZACION")
    expect(post.id).not.toBe(pre.id)
    expect(post.ledgerHash).toBe(pre.ledgerHash)
    expect(post.paramsHash).not.toBe(pre.paramsHash)
  })

  it("criterio 12: primer run tras cambiar el motor → MOTOR_CAMBIADO", async () => {
    const before = process.env.GIT_SHA
    try {
      process.env.GIT_SHA = "aaaaaaa"
      const a = await getOrCreateReportRun(ORG, {
        type: "PYG",
        ...PERIOD,
        fiscalYearId,
        params: { variant: "PYMES" },
        actor,
      })
      expect(a.gitSha).toBe("aaaaaaa")

      process.env.GIT_SHA = "bbbbbbb"
      const b = await getOrCreateReportRun(ORG, {
        type: "PYG",
        ...PERIOD,
        fiscalYearId,
        params: { variant: "PYMES" },
        actor,
      })
      expect(b.id).not.toBe(a.id) // el `gitSha` forma parte de la clave
      expect(b.seal).toBe("REQUIERE_REVISION")
      expect(b.sealReasons.map((r) => r.code)).toContain("MOTOR_CAMBIADO")
    } finally {
      if (before === undefined) delete process.env.GIT_SHA
      else process.env.GIT_SHA = before
    }
  })

  it("I-E6-17: recalcular con la misma clave da el `result` byte a byte", async () => {
    const a = await balance("PRE_REGULARIZACION")
    const b = await getOrCreateReportRun(ORG, {
      type: "BALANCE",
      ...PERIOD,
      fiscalYearId,
      params: { snapshot: "PRE_REGULARIZACION", variant: "PYMES" },
      actor,
      noCache: true,
    })
    expect(canonicalResultJson(b.result)).toBe(canonicalResultJson(a.result))
  })

  it("I-E6-18: ningún run se sirve con un `ledgerHash` distinto del vigente", async () => {
    const run = await balance("PRE_REGULARIZACION")
    const vigente = await tenantTransaction(ORG, USER, async (tx) => {
      const { computeLedgerHash } = await import("@/models/ledger")
      return await computeLedgerHash(tx, { fiscalYearId, from: PERIOD.periodStart, to: PERIOD.periodEnd })
    })
    expect(run.ledgerHash).toBe(vigente)
  })

  it("el `analytics_key` del TRIGGER coincide con el de TypeScript", async () => {
    const run = await balance("PRE_REGULARIZACION")
    expect(run.analyticsKey).toBe(analyticsKeyOf({ analyticsHash: null, marginConfigHash: null }))
    // El del panel sí lleva sello analítico: el CHECK de la tabla lo exige.
    const panel = await getOrCreateReportRun(ORG, {
      type: "DASHBOARD",
      ...PERIOD,
      fiscalYearId,
      params: { refDate: "2026-12-31", variant: "PYMES" },
      actor,
    })
    expect(panel.analyticsHash).not.toBeNull()
    expect(panel.analyticsKey).not.toBe(run.analyticsKey)
  })

  // ── I-E6-16: inmutabilidad ────────────────────────────────────────────────

  it("I-E6-16: `UPDATE` sobre `report_runs` como app_runtime → 42501 y fila intacta", async () => {
    const run = await balance("PRE_REGULARIZACION")
    const error = await asRuntime(async (client) => {
      try {
        await client.query(`UPDATE report_runs SET seal = 'VALIDADO_AUTOMATICAMENTE' WHERE id = $1::uuid`, [run.id])
        return null
      } catch (e) {
        return e as { code?: string }
      }
    })
    expect(error?.code).toBe("42501")
    const after = await getReportRun(tenantDb(ORG), run.id)
    expect(after?.seal).toBe(run.seal)
  })

  it("I-E6-16: `DELETE` sobre `report_runs` como app_runtime → 42501 y fila intacta", async () => {
    const run = await balance("PRE_REGULARIZACION")
    const error = await asRuntime(async (client) => {
      try {
        await client.query(`DELETE FROM report_runs WHERE id = $1::uuid`, [run.id])
        return null
      } catch (e) {
        return e as { code?: string }
      }
    })
    expect(error?.code).toBe("42501")
    expect(await getReportRun(tenantDb(ORG), run.id)).not.toBeNull()
  })

  // ── ManualReviewFlag ──────────────────────────────────────────────────────

  it("criterio 13: un flag activo sella REQUIERE REVISIÓN con REVISION_FORZADA", async () => {
    const flag = await setManualReviewFlag(
      ORG,
      { ...PERIOD, scope: null, reason: "cierre pendiente de revisar por el asesor" },
      { userId: USER, role: "ADMIN" }
    )
    const run = await getOrCreateReportRun(ORG, {
      type: "CASHFLOW_DIRECTO",
      ...PERIOD,
      fiscalYearId,
      params: { method: "DIRECTO", granularity: "MENSUAL", view: "GESTION" },
      actor,
    })
    expect(run.seal).toBe("REQUIERE_REVISION")
    expect(run.sealReasons.map((r) => r.code)).toContain("REVISION_FORZADA")

    // Levantado con motivo, el SIGUIENTE run vuelve a validado.
    await clearManualReviewFlag(ORG, { id: flag.id, reason: "revisado por el asesor el 15 de enero" }, { userId: USER, role: "ADMIN" })
    const after = await getOrCreateReportRun(ORG, {
      type: "CASHFLOW_DIRECTO",
      ...PERIOD,
      fiscalYearId,
      params: { method: "DIRECTO", granularity: "MENSUAL", view: "GESTION" },
      actor,
      noCache: true,
    })
    expect(after.sealReasons.map((r) => r.code)).not.toContain("REVISION_FORZADA")
  })

  it("el flag NO se borra: se marca `cleared` con autor y motivo", async () => {
    const flag = await setManualReviewFlag(
      ORG,
      { periodStart: "2026-01-01", periodEnd: "2026-03-31", scope: "PYG", reason: "trimestre con ajuste manual" },
      { userId: USER, role: "ADMIN" }
    )
    await clearManualReviewFlag(ORG, { id: flag.id, reason: "ajuste contabilizado correctamente" }, { userId: USER, role: "ADMIN" })
    const row = await tenantDb(ORG).manualReviewFlag.findFirst({ where: { id: flag.id } })
    expect(row).not.toBeNull()
    expect(row?.clearedAt).not.toBeNull()
    expect(row?.clearedById).toBe(USER)
    expect(row?.clearReason).toContain("contabilizado")
  })

  it("sólo puede haber UN flag activo por periodo y ámbito", async () => {
    const input = { periodStart: "2026-04-01", periodEnd: "2026-06-30", scope: null, reason: "revisión del Q2 pendiente" }
    const first = await setManualReviewFlag(ORG, input, { userId: USER, role: "ADMIN" })
    await expect(setManualReviewFlag(ORG, input, { userId: USER, role: "ADMIN" })).rejects.toThrow()
    await clearManualReviewFlag(ORG, { id: first.id, reason: "cerrado para dejar limpio el test" }, { userId: USER, role: "ADMIN" })
  })

  it("un motivo corto se rechaza antes de tocar la base", async () => {
    await expect(
      setManualReviewFlag(ORG, { periodStart: "2026-01-01", periodEnd: "2026-12-31", reason: "no" }, { userId: USER, role: "ADMIN" })
    ).rejects.toThrow(/al menos 10 caracteres/)
  })

  it("el trigger impide modificar cualquier columna que no sea la de limpieza", async () => {
    const flag = await setManualReviewFlag(
      ORG,
      { periodStart: "2026-07-01", periodEnd: "2026-09-30", scope: null, reason: "revisión del Q3 pendiente" },
      { userId: USER, role: "ADMIN" }
    )
    const error = await owner(async (client) => {
      try {
        await client.query(`UPDATE manual_review_flags SET reason = 'otra cosa' WHERE id = $1::uuid`, [flag.id])
        return null
      } catch (e) {
        return e as { message?: string }
      }
    })
    expect(error?.message).toMatch(/sólo se pueden modificar cleared_at/)
    await clearManualReviewFlag(ORG, { id: flag.id, reason: "cerrado para dejar limpio el test" }, { userId: USER, role: "ADMIN" })
  })

  // ── Umbral de variación ───────────────────────────────────────────────────

  it("criterio 14: superar los DOS umbrales dispara VARIACION_KPI", async () => {
    // Un umbral ridículo hace que cualquier variación dispare; lo que se
    // comprueba es el cableado, no la calibración (eso vive en el test unitario).
    await setReviewThresholds(
      ORG,
      {
        ...DEFAULT_REVIEW_THRESHOLDS,
        comparativeBasis: "PREVIOUS_PERIOD",
        kpis: { ...DEFAULT_REVIEW_THRESHOLDS.kpis, ingresos: { pctBps: 1, minAbsCents: 1, minPointsBps: null } },
      },
      { userId: USER, role: "ADMIN" }
    )
    // Primer semestre y segundo semestre: dos periodos distintos con el mismo
    // `paramsHash`, que es lo que `previousRunFor` busca con PREVIOUS_PERIOD.
    await getOrCreateReportRun(ORG, {
      type: "PYG",
      periodStart: "2026-01-01",
      periodEnd: "2026-06-30",
      fiscalYearId,
      params: { variant: "PYMES" },
      actor,
    })
    const second = await getOrCreateReportRun(ORG, {
      type: "PYG",
      periodStart: "2026-07-01",
      periodEnd: "2026-12-31",
      fiscalYearId,
      params: { variant: "PYMES" },
      actor,
    })
    expect(second.comparativeRunId).not.toBeNull()
    expect(second.comparativeBasis).toBe("PREVIOUS_PERIOD")
    expect(second.seal).toBe("REQUIERE_REVISION")
    expect(second.sealReasons.map((r) => r.code)).toContain("VARIACION_KPI")

    await setReviewThresholds(ORG, DEFAULT_REVIEW_THRESHOLDS, { userId: USER, role: "ADMIN" })
  })

  // ── Error inyectado ───────────────────────────────────────────────────────

  it("criterio 15: un céntimo alterado por SQL saca I2 en FAIL y el informe NO se valida", async () => {
    // La corrupción se inyecta con los triggers desactivados (`replica`), que es
    // lo único que la puede producir: la aplicación NO puede llegar a este
    // estado —el trigger de ADR-0010 y el cuadre diferido lo impiden—. Lo que se
    // comprueba es que, SI llega, el informe no se sirve como validado.
    const corrupt = async (delta: number): Promise<void> => {
      await owner(async (client) => {
        await client.query("BEGIN")
        await client.query("SET LOCAL session_replication_role = replica")
        await client.query(
          `UPDATE journal_lines SET debit_cents = debit_cents + $2
            WHERE id = (SELECT id FROM journal_lines
                         WHERE organization_id = $1::uuid AND account_code = '4300' AND debit_cents > 0
                         ORDER BY id LIMIT 1)`,
          [ORG, delta]
        )
        await client.query("COMMIT")
      })
    }

    await corrupt(1)
    try {
      const run = await getOrCreateReportRun(ORG, {
        type: "BALANCE",
        ...PERIOD,
        fiscalYearId,
        params: { snapshot: "PRE_REGULARIZACION", variant: "PYMES" },
        actor,
      })
      const i2 = run.validation.checks.filter((c) => c.id.startsWith("I2["))
      expect(i2.length).toBeGreaterThan(0)
      expect(i2.some((c) => c.status === "FAIL")).toBe(true)
      // Lo que este test protege de verdad: que NO se sirva como validado.
      expect(run.seal).toBe("REQUIERE_REVISION")
      expect(run.sealReasons.map((r) => r.code)).toContain("INVARIANTE_FAIL")
      // Y que la evidencia lleve la cifra, no un «algo falla».
      expect(i2.find((c) => c.status === "FAIL")?.evidencia).toMatch(/\d/)
    } finally {
      await corrupt(-1)
    }
  })

  // ── Export ────────────────────────────────────────────────────────────────

  it("criterio 18: el export produce ficheros válidos con procedencia y hash estable", async () => {
    const run = await balance("PRE_REGULARIZACION")
    const payload = {
      id: run.id,
      type: run.type,
      periodStart: run.periodStart,
      periodEnd: run.periodEnd,
      ledgerHash: run.ledgerHash,
      gitSha: run.gitSha,
      seal: run.seal,
      sealReasons: run.sealReasons,
      validation: run.validation,
      provenance: run.provenance,
      result: run.result,
      params: run.params,
    }

    const xlsx = await exportRun(payload, "xlsx", ["Sin compensación de saldos (art. 37 CdC)."])
    expect(xlsx.body.subarray(0, 2).toString("latin1")).toBe("PK") // firma de un zip
    expect(xlsx.body.length).toBeGreaterThan(1_000)
    expect(xlsx.sha256).toMatch(/^[0-9a-f]{64}$/)

    const again = await exportRun(payload, "xlsx", ["Sin compensación de saldos (art. 37 CdC)."])
    expect(again.sha256).toBe(xlsx.sha256)

    const csv = await exportRun(payload, "csv", [])
    expect(csv.filename.endsWith(".zip")).toBe(true)
    const JSZip = (await import("jszip")).default
    const zip = await JSZip.loadAsync(csv.body)
    const procedencia = await zip.file("procedencia.csv")!.async("string")
    // El fichero que circula por correo se audita SIN volver al ERP.
    expect(procedencia).toContain(run.ledgerHash)
    expect(procedencia).toContain(run.id)
  })

  // ── Histórico ─────────────────────────────────────────────────────────────

  it("el histórico devuelve los runs del periodo, del más reciente al más antiguo", async () => {
    const runs = await listReportRuns(tenantDb(ORG), { type: "BALANCE" })
    expect(runs.length).toBeGreaterThan(0)
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i - 1].createdAt.getTime()).toBeGreaterThanOrEqual(runs[i].createdAt.getTime())
    }
  })

  it("`PRESUPUESTO_REAL` se declara en el enum y se RECHAZA en runtime (E10)", async () => {
    await expect(
      getOrCreateReportRun(ORG, { type: "PRESUPUESTO_REAL", ...PERIOD, fiscalYearId, params: {}, actor })
    ).rejects.toThrow(/E10/)
  })

  // ── E6-UI-1: los modelos NO tenant dentro de `tenantTransaction` ──────────

  it("E6-UI-1: `tx.organization.*` funciona dentro de tenantTransaction con RLS estricta", async () => {
    // `Organization` no está en `TENANT_MODELS`, y la extensión los despachaba
    // FUERA de la transacción y sin GUC: con RLS estricta la fila no era visible
    // y todo informe moría con «No record was found for a query».
    const seen = await tenantTransaction(ORG, USER, async (tx) => {
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: ORG },
        select: { id: true, baseCurrency: true },
      })
      // Y ve lo que la MISMA transacción acaba de escribir: está dentro de ella.
      await tx.$executeRaw`UPDATE organizations SET timezone = 'Atlantic/Canary' WHERE id = ${ORG}::uuid`
      const after = await tx.organization.findUniqueOrThrow({ where: { id: ORG }, select: { timezone: true } })
      return { id: org.id, currency: org.baseCurrency, timezone: after.timezone }
    })
    expect(seen.id).toBe(ORG)
    expect(seen.currency).toBe("EUR")
    expect(seen.timezone).toBe("Atlantic/Canary")
  })

  it("E6-UI-1: un `User` (pre-tenant) también se lee dentro de la transacción", async () => {
    const email = await tenantTransaction(ORG, USER, async (tx) =>
      (await tx.user.findUniqueOrThrow({ where: { id: USER }, select: { email: true } })).email
    )
    expect(email).toBe("e6@test.local")
  })

  // ── E6-UI-2: comparativo y provenance en el MISMO run ─────────────────────

  it("E6-UI-2: el balance trae `previousCents` por celda y `comparativeRunId`", async () => {
    // El fixture tiene 2026 y 2027; el balance de 2027 compara contra 2026.
    const fy2027 = await tenantTransaction(ORG, USER, async (tx) =>
      (await tx.fiscalYear.findFirstOrThrow({ where: { code: "2027" } })).id
    )
    const run = await getOrCreateReportRun(ORG, {
      type: "BALANCE",
      periodStart: "2027-01-01",
      periodEnd: "2027-12-31",
      fiscalYearId: fy2027,
      params: { snapshot: "PRE_REGULARIZACION", variant: "PYMES" },
      actor,
    })
    const result = run.result as { activo: { path: string; cents: number; previousCents?: number }[] }
    const conComparativo = result.activo.filter((r) => r.previousCents !== undefined)
    expect(conComparativo.length).toBeGreaterThan(0)
    // La apertura de 2027 reproduce el balance formulado de 2026: mismo total.
    const total = result.activo.find((r) => r.path === "A) Activo no corriente")
    expect(total?.previousCents).toBe(2_665_000)
  })

  it("E6-UI-2: sin ejercicio anterior, la celda NO trae `previousCents` (nunca 0)", async () => {
    const run = await balance("PRE_REGULARIZACION")
    const result = run.result as { activo: { previousCents?: number }[] }
    // 2026 es el primer ejercicio del fixture: «sin comparativo», no «cero».
    expect(result.activo.every((r) => r.previousCents === undefined)).toBe(true)
  })

  it("E6-UI-2: la provenance de 3 celdas se EJECUTA y reproduce su valor", async () => {
    type Prov = { valor: number; registros_origen: string; parametros: unknown[]; calculado_por: string }
    type Row = { path?: string; cents: number; provenance?: Prov }

    const balanceRun = await balance("PRE_REGULARIZACION")
    const pygRun = await getOrCreateReportRun(ORG, {
      type: "PYG",
      ...PERIOD,
      fiscalYearId,
      params: { variant: "PYMES" },
      actor,
    })
    const cashRun = await getOrCreateReportRun(ORG, {
      type: "CASHFLOW_DIRECTO",
      ...PERIOD,
      fiscalYearId,
      params: { method: "DIRECTO", granularity: "MENSUAL", view: "GESTION" },
      actor,
    })

    /** Ejecuta `registros_origen` tal cual, con sus parámetros, y suma las líneas. */
    const reproduce = async (prov: Prov): Promise<{ debit: number; credit: number }> =>
      await tenantTransaction(ORG, USER, async (tx) => {
        const ids = await tx.$queryRawUnsafe<{ id: string }[]>(prov.registros_origen, ...prov.parametros)
        expect(ids.length).toBeGreaterThan(0)
        const rows = await tx.$queryRaw<{ d: bigint; c: bigint }[]>`
          SELECT COALESCE(SUM(debit_cents)::bigint, 0) AS d, COALESCE(SUM(credit_cents)::bigint, 0) AS c
            FROM journal_lines WHERE id = ANY(${ids.map((r) => r.id)}::uuid[])`
        return { debit: Number(rows[0].d), credit: Number(rows[0].c) }
      })

    // 1. Balance: una hoja del ACTIVO. Presentación `+saldo` (R-B2).
    const activo = (balanceRun.result as { activo: Row[] }).activo
    const celdaBalance = activo.find((r) => r.path?.endsWith("1. Tesorería"))!
    expect(celdaBalance.provenance?.calculado_por).toContain("lib/ledger/reports/balance.ts@")
    const b = await reproduce(celdaBalance.provenance!)
    expect(b.debit - b.credit).toBe(celdaBalance.cents)
    expect(celdaBalance.cents).toBe(2_943_920)

    // 2. PyG: el epígrafe 6. Aporte `haber − debe` (R-P1).
    const lineas = (pygRun.result as { lines: Row[] }).lines
    const celdaPyg = lineas.find((r) => r.path === "6. Gastos de personal")!
    expect(celdaPyg.provenance?.calculado_por).toContain("lib/ledger/reports/pyg.ts@")
    const p = await reproduce(celdaPyg.provenance!)
    expect(p.credit - p.debit).toBe(celdaPyg.cents)
    expect(celdaPyg.cents).toBe(-2_640_000)

    // 3. Cashflow: el bucket de personal. Aporte `−(debe − haber)` (R-CF-3).
    const directo = (cashRun.result as { directo: { annualCents: Record<string, number>; provenanceByBucket: Record<string, Prov> } }).directo
    const provBucket = directo.provenanceByBucket.PAGOS_PERSONAL
    expect(provBucket.calculado_por).toContain("lib/ledger/reports/cashflow.ts@")
    const c = await reproduce(provBucket)
    expect(-(c.debit - c.credit)).toBe(directo.annualCents.PAGOS_PERSONAL)
    expect(directo.annualCents.PAGOS_PERSONAL).toBe(-2_340_000)
  })

  // ── T20: el agregado SQL de la matriz no puede divergir del motor puro ────

  it("T20: `getAnalyticAggregates` suma exactamente lo mismo que las líneas (R6)", async () => {
    await tenantTransaction(ORG, USER, async (tx) => {
      const period = { from: PERIOD.periodStart, to: PERIOD.periodEnd, fiscalYearId }
      const [aggregates, lines] = [await getAnalyticAggregates(tx, period), await getAnalyticLines(tx, period)]

      const sumOf = (d: number, c: number) => d - c
      const fromAggregates = aggregates.reduce((a, r) => a + sumOf(r.debitCents, r.creditCents), 0)
      const fromLines = lines.reduce((a, l) => a + sumOf(l.debitCents, l.creditCents), 0)
      expect(fromAggregates).toBe(fromLines)
      expect(aggregates.reduce((a, r) => a + r.lineCount, 0)).toBe(lines.length)
      // Y el agregado es estrictamente más pequeño: para eso existe.
      expect(aggregates.length).toBeLessThan(lines.length)
    })
  })

  it("el plan que consumen los estados financieros trae el bucket de cashflow", async () => {
    const accounts = await getStatementAccounts(tenantDb(ORG))
    expect(accounts.length).toBeGreaterThan(400)
    // R-18′: la tesorería NO lleva bucket; una cuenta de cliente, sí.
    expect(accounts.find((a) => a.code === "572")?.cashflowBucket).toBeNull()
    expect(accounts.find((a) => a.code === "430")?.cashflowBucket).toBe("COBROS_CLIENTES")
  })
})
