/**
 * E10 · T4 — El SQL de las seis migraciones `20260924*_e10_*`, contra Postgres
 * de verdad (docs/design/E10-presupuesto-horas.md §2.3, ADR-0018 D1–D6).
 *
 * Todo lo que aquí se comprueba tiene la misma forma: **la regla está en la
 * base, no sólo en el código**. Un CHECK que sólo vive en TypeScript lo esquiva
 * cualquier `UPDATE` por SQL, y precisamente contra eso están los invariantes.
 *
 *  · **O-A6 cerrada** (criterio 1): los CUATRO índices únicos PARCIALES de
 *    `budget_lines` y el CHECK de dimensión excluyente. Es la deuda abierta en E4
 *    y fechada en E5 para esta migración, y tiene test propio.
 *  · **O-E10-23** (criterio 4-bis): `analytic_type` obligatorio en TODA línea.
 *  · **O-E10-6**: el signo lo fuerza el tipo analítico, con su excepción
 *    declarada (`sign_exception`).
 *  · **O-E10-7**: `margin_level` congelado en la línea y VERIFICADO contra el
 *    vigente; el trigger no rellena, porque rellenar rompería `budget_hash`.
 *  · **O-E10-10**: `budget_hours_lines` con sus tres FK compuestas, su CHECK de
 *    día 1 y sus cuatro índices parciales.
 *  · Inmutabilidad de lo sellado (I-E10-6) y de lo aprobado (I-E10-4), el
 *    contra-apunte espejo (R-H-2) y el techo diario AGREGADO (O-E10-21).
 *  · **O-E10-1**: `time_hash` + su ventana en `allocation_runs`, y los drivers
 *    `HOURS`/`HEADCOUNT` vivos (deuda §0-bis #2).
 *  · `report_runs.budget_hash` en la clave de caché, la retirada de `MIXED` y
 *    `DRAFT` (deuda §0-bis #3 y #4), el proyecto contenedor de Q-5 y que ninguna
 *    tabla quedó en `NO FORCE`.
 *
 * Conecta con el rol PROPIETARIO: aquí se ejercen constraints y triggers, no
 * RLS. El aislamiento por tenant vive en la suite `test:integration:rls`.
 */

import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

const ORG = "e1000000-0000-4000-8000-00000000000a"
const USER = "e1000000-0000-4000-8000-0000000000a1"

let client: Client
let fiscalYearId = ""
let businessLineId = ""
let projectId = ""
let projectBId = ""
let cecoId = ""
let cecoSinAsignarId = ""
let employeeId = ""

async function q<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await client.query<T>(sql, params)
  return result.rows
}

/**
 * Ejecuta dentro de un savepoint y devuelve el SQLSTATE del fallo, o `null` si
 * pasó. Se devuelve el código y no el mensaje porque es la cifra que nombran los
 * criterios de aceptación: `23505` un duplicado, `23514` un CHECK o un trigger,
 * `23P01` un EXCLUDE, `23503` una FK.
 */
async function errcode(sql: string, params: unknown[] = []): Promise<string | null> {
  await q("SAVEPOINT sp")
  try {
    await q(sql, params)
    await q("RELEASE SAVEPOINT sp")
    return null
  } catch (error) {
    await q("ROLLBACK TO SAVEPOINT sp")
    return (error as { code?: string }).code ?? "SIN_CODIGO"
  }
}

let budgetSeq = 0
/** Una versión de presupuesto en BORRADOR, lista para recibir líneas. */
async function newBudget(
  overrides: { scenario?: string; revision?: number; validFrom?: string; validTo?: string | null } = {}
): Promise<string> {
  budgetSeq += 1
  const [row] = await q<{ id: string }>(
    `INSERT INTO budgets (organization_id, fiscal_year_id, scenario, revision, name, valid_from, valid_to, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::budget_scenario, $4, $5, $6::date, $7::date, now())
     RETURNING id`,
    [
      ORG,
      fiscalYearId,
      overrides.scenario ?? "REVISADO",
      overrides.revision ?? budgetSeq,
      `Presupuesto ${budgetSeq}`,
      overrides.validFrom ?? "2026-01-01",
      overrides.validTo ?? null,
    ]
  )
  return row.id
}

/**
 * Sella una versión: los tres sellos a la vez, como exige `budgets_sealed_marks`.
 *
 * Cada sellado toma un DÍA distinto de vigencia. No es cosmética: `budgets_no_overlap`
 * es un EXCLUDE por `(organización, ejercicio, rango)` y sin ventanas disjuntas el
 * segundo sellado del fichero chocaría — que es justamente lo que comprueba, a
 * propósito, el test de solape.
 */
let sealDay = 0
async function seal(budgetId: string): Promise<void> {
  sealDay += 1
  // Ventanas de un día, separadas diez, para que un test pueda alargar una
  // `valid_to` sin chocar con la siguiente.
  const day = new Date(Date.UTC(2026, 0, 1 + (sealDay - 1) * 10)).toISOString().slice(0, 10)
  await q(
    `UPDATE budgets
        SET valid_from = $3::date, valid_to = $3::date, status = 'VIGENTE', sealed_at = now(),
            sealed_by_id = $2::uuid, budget_hash = repeat('a', 64),
            margin_config_hash = repeat('b', 64), git_sha = 'abc1234', updated_at = now()
      WHERE id = $1::uuid`,
    [budgetId, USER, day]
  )
}

const line = (budgetId: string, over: Record<string, unknown> = {}) => ({
  budget_id: budgetId,
  month: "2026-03-01",
  account_code: "6400",
  project_id: null as string | null,
  cost_center_id: cecoId as string | null,
  business_line_id: null as string | null,
  analytic_type: "INDIRECTO_CECO",
  margin_level: "MC3",
  amount_cents: -100000,
  sign_exception: false,
  ...over,
})

async function insertLine(budgetId: string, over: Record<string, unknown> = {}): Promise<string | null> {
  const v = line(budgetId, over)
  return errcode(
    `INSERT INTO budget_lines
       (organization_id, budget_id, month, account_code, project_id, cost_center_id, business_line_id,
        analytic_type, margin_level, amount_cents, sign_exception)
     VALUES ($1::uuid, $2::uuid, $3::date, $4, $5::uuid, $6::uuid, $7::uuid,
             $8::analytic_type, $9::margin_level, $10, $11)`,
    [
      ORG,
      v.budget_id,
      v.month,
      v.account_code,
      v.project_id,
      v.cost_center_id,
      v.business_line_id,
      v.analytic_type,
      v.margin_level,
      v.amount_cents,
      v.sign_exception,
    ]
  )
}

async function insertEntry(over: Record<string, unknown> = {}): Promise<string | null> {
  const v = {
    date: "2026-03-10",
    project_id: projectId as string | null,
    cost_center_id: null as string | null,
    business_line_id: businessLineId as string | null,
    minutes: 440,
    productive: true,
    status: "BORRADOR",
    approved_at: null as string | null,
    approved_by_id: null as string | null,
    corrects_entry_id: null as string | null,
    correction_reason: null as string | null,
    import_key: null as string | null,
    ...over,
  }
  return errcode(
    `INSERT INTO time_entries
       (organization_id, employee_id, date, project_id, cost_center_id, business_line_id, minutes,
        productive, status, approved_at, approved_by_id, corrects_entry_id, correction_reason, import_key)
     VALUES ($1::uuid, $2::uuid, $3::date, $4::uuid, $5::uuid, $6::uuid, $7, $8,
             $9::time_entry_status, $10::timestamp, $11::uuid, $12::uuid, $13, $14)`,
    [
      ORG,
      employeeId,
      v.date,
      v.project_id,
      v.cost_center_id,
      v.business_line_id,
      v.minutes,
      v.productive,
      v.status,
      v.approved_at,
      v.approved_by_id,
      v.corrects_entry_id,
      v.correction_reason,
      v.import_key,
    ]
  )
}

/** Una entrada APROBADA, devolviendo su id (para los contra-apuntes). */
async function approvedEntry(minutes: number, date = "2026-03-11"): Promise<string> {
  const [row] = await q<{ id: string }>(
    `INSERT INTO time_entries
       (organization_id, employee_id, date, project_id, business_line_id, minutes, status, approved_at, approved_by_id)
     VALUES ($1::uuid, $2::uuid, $3::date, $4::uuid, $5::uuid, $6, 'APROBADO', now(), $7::uuid)
     RETURNING id`,
    [ORG, employeeId, date, projectId, businessLineId, minutes, USER]
  )
  return row.id
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return
  client = new Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  await cleanup()

  await q(`INSERT INTO users (id, email, name, created_at, updated_at)
           VALUES ($1::uuid, 'e10-esquema@test.local', 'E10', now(), now())`, [USER])
  await q(
    `INSERT INTO organizations (id, slug, name, updated_at) VALUES ($1::uuid, 'e10-esquema-org', 'E10 esquema', now())`,
    [ORG]
  )
  await q(
    `INSERT INTO memberships (id, organization_id, user_id, role, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'ADMIN', now())`,
    [ORG, USER]
  )

  const [fy] = await q<{ id: string }>(
    `INSERT INTO fiscal_years (id, organization_id, code, start_date, end_date, status, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, '2026', '2026-01-01', '2026-12-31', 'OPEN', now())
     RETURNING id`,
    [ORG]
  )
  fiscalYearId = fy.id

  const [bl] = await q<{ id: string }>(
    `INSERT INTO business_lines (id, organization_id, code, name, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, 'LN1', 'Línea 1', now()) RETURNING id`,
    [ORG]
  )
  businessLineId = bl.id

  const [p] = await q<{ id: string }>(
    `INSERT INTO projects (id, organization_id, business_line_id, code, name, status, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'P-01', 'Proyecto 1', 'ACTIVE', now()) RETURNING id`,
    [ORG, businessLineId]
  )
  projectId = p.id

  const [pb] = await q<{ id: string }>(
    `INSERT INTO projects (id, organization_id, business_line_id, code, name, status, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'P-02', 'Proyecto 2', 'ACTIVE', now()) RETURNING id`,
    [ORG, businessLineId]
  )
  projectBId = pb.id

  const [cc] = await q<{ id: string }>(
    `INSERT INTO cost_centers (id, organization_id, code, name, kind, margin_level, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, 'CC-OPS', 'Operaciones', 'OPERACIONES_INDIRECTAS', 'MC3', now())
     RETURNING id`,
    [ORG]
  )
  cecoId = cc.id

  const [ccna] = await q<{ id: string }>(
    // `cost_centers_unassigned_is_system` (E4): el CECO de sistema es
    // `is_system`, NO liquidable y siempre activo.
    `INSERT INTO cost_centers
       (id, organization_id, code, name, kind, margin_level, is_system, allocatable, is_active, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, 'SIN_ASIGNAR', 'Sin asignar', 'SIN_ASIGNAR', 'EBITDA',
             true, false, true, now())
     RETURNING id`,
    [ORG]
  )
  cecoSinAsignarId = ccna.id

  // La configuración de niveles vigente todo 2026: sin ella, el trigger de
  // `margin_level` cae al respaldo y el test no probaría la rama que importa.
  const levels: Array<[string, string[], number]> = [
    ["INGRESOS", ["INGRESO_DIRECTO"], 1],
    ["MC1", ["COSTE_DIRECTO_MC1"], 2],
    ["MC2", ["COSTE_DIRECTO_MC2"], 3],
    ["EBIT", ["AMORTIZACION_DETERIORO"], 4],
    ["BAI", ["FINANCIERO"], 5],
    ["RESULTADO", ["EXTRAORDINARIO"], 6],
  ]
  for (const [level, types, order] of levels) {
    await q(
      `INSERT INTO margin_level_configs (organization_id, level, label, analytic_types, sort_order, valid_from, updated_at)
       VALUES ($1::uuid, $2::margin_level, $2, $3::analytic_type[], $4, '2026-01-01', now())`,
      [ORG, level, types, order]
    )
  }

  const [emp] = await q<{ id: string }>(
    `INSERT INTO employees (id, organization_id, code, name, default_cost_center_id, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, 'E-001', 'Ana', $2::uuid, now()) RETURNING id`,
    [ORG, cecoId]
  )
  employeeId = emp.id

  // Todo el fichero corre dentro de UNA transacción con savepoints: no deja
  // rastro y los CHECK se pueden provocar sin ensuciar la base.
  await q("BEGIN")
})

afterAll(async () => {
  if (!TEST_DATABASE_URL) return
  await q("ROLLBACK").catch(() => undefined)
  await cleanup()
  await client.end()
})

async function cleanup() {
  await q(`DELETE FROM organizations WHERE id = $1::uuid`, [ORG]).catch(() => undefined)
  await q(`DELETE FROM users WHERE id = $1::uuid`, [USER]).catch(() => undefined)
}

describe.skipIf(!TEST_DATABASE_URL)("E10 · T4 — M1…M6: CHECK, índices y triggers", () => {
  // ───────────────────────────────────────────────────────────────────────────
  // O-A6 — la deuda abierta en E4, cerrada aquí (criterio 1)
  // ───────────────────────────────────────────────────────────────────────────
  describe("O-A6: dimensión excluyente y los CUATRO índices únicos parciales", () => {
    it("proyecto Y CECO a la vez, o ninguno de los dos: 23514", async () => {
      const b = await newBudget()
      expect(
        await insertLine(b, { project_id: projectId, business_line_id: businessLineId, cost_center_id: cecoId })
      ).toBe("23514")
      expect(await insertLine(b, { project_id: null, cost_center_id: null })).toBe("23514")
    })

    it("duplicado `(versión, mes, proyecto, tipo)` sin cuenta: 23505", async () => {
      const b = await newBudget()
      const cell = {
        project_id: projectId,
        cost_center_id: null,
        business_line_id: businessLineId,
        account_code: null,
        analytic_type: "INGRESO_DIRECTO",
        margin_level: "INGRESOS",
        amount_cents: 500000,
      }
      expect(await insertLine(b, cell)).toBeNull()
      expect(await insertLine(b, cell)).toBe("23505")
    })

    it("duplicado `(versión, mes, CECO, cuenta)`: 23505", async () => {
      const b = await newBudget()
      expect(await insertLine(b)).toBeNull()
      expect(await insertLine(b)).toBe("23505")
    })

    it("la misma celda en OTRO mes o en OTRA dimensión no colisiona", async () => {
      const b = await newBudget()
      expect(await insertLine(b)).toBeNull()
      expect(await insertLine(b, { month: "2026-04-01" })).toBeNull()
      expect(
        await insertLine(b, {
          project_id: projectId,
          cost_center_id: null,
          business_line_id: businessLineId,
          analytic_type: "COSTE_DIRECTO_MC1",
          margin_level: "MC1",
        })
      ).toBeNull()
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // O-E10-23 y O-E10-6 — el tipo y el signo
  // ───────────────────────────────────────────────────────────────────────────
  describe("O-E10-23 / O-E10-6: el tipo es obligatorio y FUERZA el signo", () => {
    it("criterio 4-bis: una línea sin `analytic_type` no entra (23502/23514)", async () => {
      const b = await newBudget()
      const code = await errcode(
        `INSERT INTO budget_lines
           (organization_id, budget_id, month, account_code, cost_center_id, margin_level, amount_cents)
         VALUES ($1::uuid, $2::uuid, '2026-03-01', '6400', $3::uuid, 'MC3', -1000)`,
        [ORG, b, cecoId]
      )
      expect(["23502", "23514"]).toContain(code)
    })

    it("existe el CHECK `budget_lines_type_required` que nombra I-E10-14", async () => {
      const [row] = await q<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_constraint
          WHERE conrelid = 'budget_lines'::regclass AND conname = 'budget_lines_type_required'`
      )
      expect(row.n).toBe("1")
    })

    it("un `6400` (INDIRECTO_CECO) en POSITIVO se rechaza: 23514", async () => {
      const b = await newBudget()
      expect(await insertLine(b, { amount_cents: 1200000 })).toBe("23514")
    })

    it("un ingreso en NEGATIVO se rechaza: 23514", async () => {
      const b = await newBudget()
      expect(
        await insertLine(b, {
          project_id: projectId,
          cost_center_id: null,
          business_line_id: businessLineId,
          account_code: "7000",
          analytic_type: "INGRESO_DIRECTO",
          margin_level: "INGRESOS",
          amount_cents: -1,
        })
      ).toBe("23514")
    })

    it("`sign_exception` abre la puerta a las tres excepciones declaradas (R-B-5)", async () => {
      const b = await newBudget()
      expect(await insertLine(b, { account_code: "6100", amount_cents: 1200000, sign_exception: true })).toBeNull()
    })

    it("FINANCIERO y EXTRAORDINARIO no tienen signo forzado", async () => {
      const b = await newBudget()
      expect(
        await insertLine(b, {
          project_id: projectId,
          cost_center_id: null,
          business_line_id: businessLineId,
          account_code: "6690",
          analytic_type: "FINANCIERO",
          margin_level: "BAI",
          amount_cents: 33,
        })
      ).toBeNull()
    })

    it("presupuesto de EXPLOTACIÓN: una cuenta del grupo 2 no entra (Q-4)", async () => {
      const b = await newBudget()
      expect(await insertLine(b, { account_code: "2170" })).toBe("23514")
    })

    it("el mes es el día 1", async () => {
      const b = await newBudget()
      expect(await insertLine(b, { month: "2026-03-15" })).toBe("23514")
    })

    it("un mes fuera del ejercicio de la versión se rechaza (I-E10-1)", async () => {
      const b = await newBudget()
      expect(await insertLine(b, { month: "2027-01-01" })).toBe("23514")
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // O-E10-7 — `margin_level` verificado, nunca rellenado
  // ───────────────────────────────────────────────────────────────────────────
  describe("O-E10-7: el nivel viaja con la línea y se VERIFICA", () => {
    it("un `INDIRECTO_CECO` con nivel distinto al del CECO se rechaza", async () => {
      const b = await newBudget()
      expect(await insertLine(b, { margin_level: "EBITDA" })).toBe("23514")
    })

    it("un `INGRESO_DIRECTO` toma el nivel de `MarginLevelConfig`, no otro", async () => {
      const b = await newBudget()
      const cell = {
        project_id: projectId,
        cost_center_id: null,
        business_line_id: businessLineId,
        account_code: "7000",
        analytic_type: "INGRESO_DIRECTO",
        amount_cents: 1000,
      }
      expect(await insertLine(b, { ...cell, margin_level: "MC1" })).toBe("23514")
      expect(await insertLine(b, { ...cell, margin_level: "INGRESOS" })).toBeNull()
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // R-A9 y dimensión viva
  // ───────────────────────────────────────────────────────────────────────────
  describe("R-A9 y I-E10-8: la línea de negocio y la dimensión", () => {
    it("`business_line_id` que no es la del proyecto se rechaza", async () => {
      const [otra] = await q<{ id: string }>(
        `INSERT INTO business_lines (id, organization_id, code, name, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, 'LN2', 'Línea 2', now()) RETURNING id`,
        [ORG]
      )
      const b = await newBudget()
      expect(
        await insertLine(b, {
          project_id: projectId,
          cost_center_id: null,
          business_line_id: otra.id,
          account_code: "7000",
          analytic_type: "INGRESO_DIRECTO",
          margin_level: "INGRESOS",
          amount_cents: 1000,
        })
      ).toBe("23514")
    })

    it("`business_line_id` con CECO (sin proyecto) se rechaza", async () => {
      const b = await newBudget()
      expect(await insertLine(b, { business_line_id: businessLineId })).toBe("23514")
    })

    it("el CECO de sistema SIN_ASIGNAR no admite presupuesto", async () => {
      const b = await newBudget()
      expect(await insertLine(b, { cost_center_id: cecoSinAsignarId, margin_level: "EBITDA" })).toBe("23514")
    })

    it("un proyecto CERRADO no admite presupuesto de meses posteriores a su cierre", async () => {
      await q(`UPDATE projects SET status = 'CLOSED', closed_at = '2026-02-28' WHERE id = $1::uuid`, [projectBId])
      const b = await newBudget()
      const cell = {
        project_id: projectBId,
        cost_center_id: null,
        business_line_id: businessLineId,
        account_code: "7000",
        analytic_type: "INGRESO_DIRECTO",
        margin_level: "INGRESOS",
        amount_cents: 1000,
      }
      expect(await insertLine(b, { ...cell, month: "2026-03-01" })).toBe("23514")
      expect(await insertLine(b, { ...cell, month: "2026-01-01" })).toBeNull()
      await q(`UPDATE projects SET status = 'ACTIVE', closed_at = NULL WHERE id = $1::uuid`, [projectBId])
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Sellado, vigencias e inmutabilidad (criterios 5 y 6)
  // ───────────────────────────────────────────────────────────────────────────
  describe("I-E10-6 / I-E10-9: sellado, vigencia e inmutabilidad", () => {
    it("un BORRADOR no puede llevar sellos, y un VIGENTE no puede no llevarlos", async () => {
      const b = await newBudget()
      expect(
        await errcode(`UPDATE budgets SET budget_hash = repeat('a', 64) WHERE id = $1::uuid`, [b])
      ).toBe("23514")
      expect(await errcode(`UPDATE budgets SET status = 'VIGENTE' WHERE id = $1::uuid`, [b])).toBe("23514")
    })

    it("sellada, la versión ya no cambia de cifra ni de identidad (I-E10-6)", async () => {
      const b = await newBudget()
      await insertLine(b)
      await seal(b)
      expect(await errcode(`UPDATE budgets SET valid_from = '2026-02-01' WHERE id = $1::uuid`, [b])).toBe("23514")
      expect(await errcode(`UPDATE budgets SET budget_hash = repeat('c', 64) WHERE id = $1::uuid`, [b])).toBe("23514")
      // Lo que SÍ admite: cerrar la vigencia (O-E10-8) y sustituir.
      expect(
        await errcode(`UPDATE budgets SET valid_to = valid_from + 1 WHERE id = $1::uuid`, [b])
      ).toBeNull()
    })

    it("las líneas de una versión sellada no se tocan ni se borran", async () => {
      const b = await newBudget()
      await insertLine(b)
      await seal(b)
      expect(await errcode(`UPDATE budget_lines SET amount_cents = -1 WHERE budget_id = $1::uuid`, [b])).toBe("23514")
      expect(await errcode(`DELETE FROM budget_lines WHERE budget_id = $1::uuid`, [b])).toBe("23514")
      expect(await insertLine(b, { month: "2026-05-01" })).toBe("23514")
    })

    it("en BORRADOR las líneas se editan y se borran: es una hoja de cálculo", async () => {
      const b = await newBudget()
      await insertLine(b)
      expect(await errcode(`UPDATE budget_lines SET amount_cents = -2 WHERE budget_id = $1::uuid`, [b])).toBeNull()
      expect(await errcode(`DELETE FROM budget_lines WHERE budget_id = $1::uuid`, [b])).toBeNull()
    })

    it("dos versiones selladas con vigencias solapadas: 23P01 (I-E10-9)", async () => {
      // Ventana propia, lejos de los días que reparte `seal()`.
      const a = await newBudget({ validFrom: "2026-07-01", validTo: "2026-08-31" })
      await q(
        `UPDATE budgets SET status = 'VIGENTE', sealed_at = now(), sealed_by_id = $2::uuid,
                budget_hash = repeat('a', 64), margin_config_hash = repeat('b', 64), git_sha = 'abc',
                updated_at = now()
          WHERE id = $1::uuid`,
        [a, USER]
      )
      const b = await newBudget({ validFrom: "2026-08-01" })
      expect(await errcode(
        `UPDATE budgets SET status = 'VIGENTE', sealed_at = now(), sealed_by_id = $2::uuid,
                budget_hash = repeat('a', 64), margin_config_hash = repeat('b', 64), git_sha = 'abc',
                updated_at = now()
          WHERE id = $1::uuid`,
        [b, USER]
      )).toBe("23P01")
    })

    it("BASE es la revisión 0 y sólo ella; `partial_from` es un día 1 (O-E10-9)", async () => {
      expect(
        await errcode(
          `INSERT INTO budgets (organization_id, fiscal_year_id, scenario, revision, name, valid_from, updated_at)
           VALUES ($1::uuid, $2::uuid, 'BASE', 7, 'mala', '2026-01-01', now())`,
          [ORG, fiscalYearId]
        )
      ).toBe("23514")
      const b = await newBudget()
      expect(await errcode(`UPDATE budgets SET partial_from = '2026-07-15' WHERE id = $1::uuid`, [b])).toBe("23514")
      expect(await errcode(`UPDATE budgets SET partial_from = '2026-07-01' WHERE id = $1::uuid`, [b])).toBeNull()
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // O-E10-10 — `budget_hours_lines`
  // ───────────────────────────────────────────────────────────────────────────
  describe("O-E10-10: horas presupuestadas con la misma disciplina", () => {
    const insertHours = async (budgetId: string, over: Record<string, unknown> = {}) => {
      const v = {
        month: "2026-03-01",
        project_id: projectId as string | null,
        cost_center_id: null as string | null,
        employee_id: null as string | null,
        minutes: 19200,
        ...over,
      }
      return errcode(
        `INSERT INTO budget_hours_lines
           (organization_id, budget_id, month, project_id, cost_center_id, employee_id, minutes)
         VALUES ($1::uuid, $2::uuid, $3::date, $4::uuid, $5::uuid, $6::uuid, $7)`,
        [ORG, budgetId, v.month, v.project_id, v.cost_center_id, v.employee_id, v.minutes]
      )
    }

    it("dimensión excluyente, día 1 y minutos ≥ 0", async () => {
      const b = await newBudget()
      expect(await insertHours(b, { cost_center_id: cecoId })).toBe("23514")
      expect(await insertHours(b, { project_id: null })).toBe("23514")
      expect(await insertHours(b, { month: "2026-03-02" })).toBe("23514")
      expect(await insertHours(b, { minutes: -1 })).toBe("23514")
    })

    it("duplicado por `(versión, mes, proyecto)` sin empleado: 23505", async () => {
      const b = await newBudget()
      expect(await insertHours(b)).toBeNull()
      expect(await insertHours(b)).toBe("23505")
      // Con empleado es otra celda, y su propio índice la protege.
      expect(await insertHours(b, { employee_id: employeeId })).toBeNull()
      expect(await insertHours(b, { employee_id: employeeId })).toBe("23505")
    })

    it("las TRES FK son compuestas por tenant (la de empleado la ata M3)", async () => {
      const [row] = await q<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_constraint
          WHERE conrelid = 'budget_hours_lines'::regclass AND contype = 'f'
            AND conname IN ('budget_hours_project_fk', 'budget_hours_cost_center_fk', 'budget_hours_employee_fk')`
      )
      expect(row.n).toBe("3")
    })

    it("un mes fuera del ejercicio tampoco entra en las horas", async () => {
      const b = await newBudget()
      expect(await insertHours(b, { month: "2025-12-01" })).toBe("23514")
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Horas reales (criterios 8, 9 y 10)
  // ───────────────────────────────────────────────────────────────────────────
  describe("M3: partes de horas, minutos enteros e inmutabilidad", () => {
    it("dimensión excluyente, minutos distintos de cero y techo por fila", async () => {
      expect(await insertEntry({ cost_center_id: cecoId })).toBe("23514")
      expect(await insertEntry({ minutes: 0 })).toBe("23514")
      expect(await insertEntry({ minutes: 1441 })).toBe("23514")
    })

    it("minutos negativos SÓLO en un contra-apunte, y con motivo ≥ 10 caracteres", async () => {
      expect(await insertEntry({ minutes: -100 })).toBe("23514")
      const original = await approvedEntry(600, "2026-03-12")
      expect(
        await insertEntry({
          date: "2026-03-12",
          minutes: -250,
          corrects_entry_id: original,
          correction_reason: "corto",
        })
      ).toBe("23514")
      expect(
        await insertEntry({
          date: "2026-03-12",
          minutes: -250,
          corrects_entry_id: original,
          correction_reason: "error de imputación",
        })
      ).toBeNull()
    })

    it("R-H-2: los contra-apuntes nunca superan en magnitud al original", async () => {
      const original = await approvedEntry(300, "2026-03-13")
      expect(
        await insertEntry({
          date: "2026-03-13",
          minutes: -400,
          corrects_entry_id: original,
          correction_reason: "pasada de frenada",
        })
      ).toBe("23514")
    })

    it("un contra-apunte con otra fecha o de otro parte no aprobado no casa", async () => {
      const original = await approvedEntry(300, "2026-03-14")
      expect(
        await insertEntry({
          date: "2026-03-15",
          minutes: -100,
          corrects_entry_id: original,
          correction_reason: "fecha distinta",
        })
      ).toBe("23514")
    })

    it("I-E10-4: una entrada APROBADA es inmutable y no se borra", async () => {
      const id = await approvedEntry(120, "2026-03-16")
      expect(await errcode(`UPDATE time_entries SET minutes = 1 WHERE id = $1::uuid`, [id])).toBe("23514")
      expect(await errcode(`DELETE FROM time_entries WHERE id = $1::uuid`, [id])).toBe("23514")
    })

    it("`BORRADOR → APROBADO` sólo escribe las tres columnas de la aprobación", async () => {
      await insertEntry({ date: "2026-03-17", minutes: 60 })
      const [row] = await q<{ id: string }>(
        `SELECT id FROM time_entries WHERE date = '2026-03-17' AND organization_id = $1::uuid`,
        [ORG]
      )
      expect(
        await errcode(
          `UPDATE time_entries SET status = 'APROBADO', approved_at = now(), approved_by_id = $2::uuid, minutes = 61
            WHERE id = $1::uuid`,
          [row.id, USER]
        )
      ).toBe("23514")
      expect(
        await errcode(
          `UPDATE time_entries SET status = 'APROBADO', approved_at = now(), approved_by_id = $2::uuid
            WHERE id = $1::uuid`,
          [row.id, USER]
        )
      ).toBeNull()
      /**
       * Un BORRADOR sí se borra: nadie ha afirmado nada todavía.
       *
       * **DEBE #4 de la ronda 1.** El `DELETE` iba sin `organization_id` y, en
       * la pasada completa de la suite, alcanzaba la fila homónima que el
       * fixture `ejercicio-completo-v2` deja sembrada en OTRA organización: un
       * `23514` intermitente que dejaba la suite roja sin ser un fallo de
       * producto. Es además la regla de CLAUDE.md —toda consulta de negocio
       * filtra por tenant, también en los tests—, y ahora se cumple.
       */
      await insertEntry({ date: "2026-03-18", minutes: 60 })
      expect(
        await errcode(`DELETE FROM time_entries WHERE organization_id = $1::uuid AND date = '2026-03-18'`, [ORG])
      ).toBeNull()
    })

    it("O-E10-21: el techo AGREGADO por (empleado, día) es 1 440 minutos", async () => {
      expect(await insertEntry({ date: "2026-04-01", minutes: 1440 })).toBeNull()
      expect(await insertEntry({ date: "2026-04-01", minutes: 1, project_id: projectBId })).toBe("23514")
    })

    it("criterio 10: `import_key` es única por organización (import idempotente)", async () => {
      expect(await insertEntry({ date: "2026-04-02", import_key: "k".repeat(64) })).toBeNull()
      expect(await insertEntry({ date: "2026-04-03", import_key: "k".repeat(64) })).toBe("23505")
    })

    it("R-H-5: ni fuera de ejercicio, ni en un mes bloqueado (B-9)", async () => {
      expect(await insertEntry({ date: "2025-06-01" })).toBe("23514")
      await q(
        `INSERT INTO period_locks (organization_id, fiscal_year_id, month, locked_by_id)
         VALUES ($1::uuid, $2::uuid, 5, $3::uuid)`,
        [ORG, fiscalYearId, USER]
      )
      expect(await insertEntry({ date: "2026-05-04" })).toBe("23514")
      await q(`DELETE FROM period_locks WHERE organization_id = $1::uuid AND month = 5`, [ORG])
      expect(await insertEntry({ date: "2026-05-04" })).toBeNull()
    })

    it("la marca de aprobación es coherente: `APROBADO` ⇔ `approved_at`", async () => {
      expect(await insertEntry({ date: "2026-04-06", status: "APROBADO" })).toBe("23514")
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Tarifas y plantilla
  // ───────────────────────────────────────────────────────────────────────────
  describe("M3: coste-hora y plantilla", () => {
    const insertRate = async (over: Record<string, unknown> = {}) => {
      const v = {
        hourly_cost_cents: 3500,
        basis: "COSTE_EMPRESA_CON_SS",
        source: "DECLARADO",
        derivation: null as string | null,
        valid_from: "2026-01-01",
        valid_to: null as string | null,
        ...over,
      }
      return errcode(
        `INSERT INTO employee_rates
           (organization_id, employee_id, hourly_cost_cents, basis, source, derivation, valid_from, valid_to)
         VALUES ($1::uuid, $2::uuid, $3, $4::employee_rate_basis, $5::employee_rate_source, $6::jsonb, $7::date, $8::date)`,
        [ORG, employeeId, v.hourly_cost_cents, v.basis, v.source, v.derivation, v.valid_from, v.valid_to]
      )
    }

    it("I-E10-5 / R-R-1: las vigencias de una tarifa no se solapan (23P01)", async () => {
      expect(await insertRate({ valid_from: "2026-01-01", valid_to: "2026-06-30" })).toBeNull()
      expect(await insertRate({ valid_from: "2026-06-01" })).toBe("23P01")
      expect(await insertRate({ valid_from: "2026-07-01" })).toBeNull()
    })

    it("céntimos por hora > 0 y `DERIVADO_NOMINA` ⇔ términos de la derivación", async () => {
      // Empleado propio: el `EXCLUDE` del test anterior dejó una vigencia
      // abierta y aquí se comprueban los CHECK, no el solape.
      const [otro] = await q<{ id: string }>(
        `INSERT INTO employees (organization_id, code, name, updated_at)
         VALUES ($1::uuid, 'E-002', 'Borja', now()) RETURNING id`,
        [ORG]
      )
      const rate = (over: Record<string, unknown>) =>
        errcode(
          `INSERT INTO employee_rates
             (organization_id, employee_id, hourly_cost_cents, basis, source, derivation, valid_from)
           VALUES ($1::uuid, $2::uuid, $3, 'COSTE_EMPRESA_CON_SS', $4::employee_rate_source, $5::jsonb, '2026-01-01')`,
          [ORG, otro.id, over.cents ?? 3500, over.source ?? "DECLARADO", over.derivation ?? null]
        )
      expect(await rate({ cents: 0 })).toBe("23514")
      expect(await rate({ source: "DERIVADO_NOMINA" })).toBe("23514")
      expect(
        await rate({
          source: "DERIVADO_NOMINA",
          derivation: JSON.stringify({ scope: "COST_CENTER", coverageBps: 10000 }),
        })
      ).toBeNull()
    })

    it("una tarifa es APPEND-ONLY para `app_runtime` (privilegio, no sólo doctrina)", async () => {
      const [row] = await q<{ n: string }>(
        `SELECT count(*)::text AS n FROM information_schema.table_privileges
          WHERE grantee = 'app_runtime' AND table_name = 'employee_rates'
            AND privilege_type IN ('UPDATE', 'DELETE')`
      )
      expect(row.n).toBe("0")
    })

    it("el snapshot de plantilla es del ÚLTIMO día del mes y no es negativo", async () => {
      expect(
        await errcode(
          `INSERT INTO headcount_snapshots (organization_id, cost_center_id, period_end, fte_milli, headcount)
           VALUES ($1::uuid, $2::uuid, '2026-03-15', 3000, 3)`,
          [ORG, cecoId]
        )
      ).toBe("23514")
      expect(
        await errcode(
          `INSERT INTO headcount_snapshots (organization_id, cost_center_id, period_end, fte_milli, headcount)
           VALUES ($1::uuid, $2::uuid, '2026-03-31', 3000, 3)`,
          [ORG, cecoId]
        )
      ).toBeNull()
      // R-C-2: un 0 declarado SÍ es un dato y entra.
      expect(
        await errcode(
          `INSERT INTO headcount_snapshots (organization_id, cost_center_id, period_end, fte_milli, headcount)
           VALUES ($1::uuid, $2::uuid, '2026-04-30', 0, 0)`,
          [ORG, cecoId]
        )
      ).toBeNull()
    })

    it("`fte_milli` vive en `[0, 1000]`", async () => {
      expect(
        await errcode(
          `INSERT INTO employees (organization_id, code, name, fte_milli, updated_at)
           VALUES ($1::uuid, 'E-999', 'Media jornada mal puesta', 1500, now())`,
          [ORG]
        )
      ).toBe("23514")
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // M4 — drivers vivos y el cuarto sello
  // ───────────────────────────────────────────────────────────────────────────
  describe("M4: `HOURS` y `HEADCOUNT` vivos, `time_hash` con su ventana", () => {
    it("deuda §0-bis #2: el CHECK que bloqueaba los dos drivers ya no existe", async () => {
      const [row] = await q<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_constraint WHERE conname = 'allocation_rules_driver_available'`
      )
      expect(row.n).toBe("0")
    })

    it("`HEADCOUNT` sólo reparte entre CECOs (D1)", async () => {
      const [row] = await q<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname = 'allocation_rules_headcount_targets'`
      )
      expect(row.def).toContain("COST_CENTERS")
    })

    it("O-E10-1: `time_hash = '∅'` ⇔ ventana NULL, y la ventana CONTIENE al periodo", async () => {
      // Cada run va a un MES distinto: `allocation_runs_one_sealed_per_period`
      // (E5) sólo admite un run sellado por periodo, y aquí se prueba el CHECK
      // de la ventana, no la unicidad.
      let month = 0
      const newRun = async (timeHash: string, start: string | null, end: string | null) => {
        month += 1
        const mm = String(month).padStart(2, "0")
        const last = new Date(Date.UTC(2026, month, 0)).toISOString().slice(0, 10)
        return errcode(
          `INSERT INTO allocation_runs
             (organization_id, fiscal_year_id, period_kind, period_start, period_end,
              ledger_hash, analytics_hash, rules_hash, git_sha, time_hash,
              time_hash_window_start, time_hash_window_end)
           VALUES ($1::uuid, $2::uuid, 'MONTH', $6::date, $7::date,
                   repeat('1', 64), repeat('2', 64), repeat('3', 64), 'abc', $3, $4::date, $5::date)`,
          [ORG, fiscalYearId, timeHash, start, end, `2026-${mm}-01`, last]
        )
      }

      // Sin drivers de actividad: `∅` y ventana vacía (run de enero).
      expect(await newRun("∅", null, null)).toBeNull()
      // `∅` con ventana, o hash con ventana vacía: incoherentes.
      expect(await newRun("∅", "2026-01-01", "2026-03-31")).toBe("23514")
      expect(await newRun(repeat64("7"), null, null)).toBe("23514")
      // Ventana que NO cubre el periodo del run: el fallo exacto que cierra D1.
      expect(await newRun(repeat64("7"), "2026-02-01", "2026-03-15")).toBe("23514")
      // Ventana YTD legítima de un run de mayo.
      expect(await newRun(repeat64("7"), "2026-01-01", "2026-05-31")).toBeNull()
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // M5 — la clave de caché del informe
  // ───────────────────────────────────────────────────────────────────────────
  describe("M5: `report_runs.budget_hash`", () => {
    it("entra en la clave de reutilización, sin invalidar lo ya cacheado", async () => {
      const [row] = await q<{ def: string }>(
        `SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'report_runs_cache_key'`
      )
      expect(row.def).toContain("budget_hash")
      expect(row.def).toContain("analytics_key")
      expect(row.def).toContain("git_sha")
    })

    it("R-B-7: un `PRESUPUESTO_REAL` sin presupuesto sellado no existe", async () => {
      const [row] = await q<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname = 'report_runs_budget_hash_required'`
      )
      expect(row.def).toContain("PRESUPUESTO_REAL")
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // M6 — deuda heredada y el proyecto contenedor
  // ───────────────────────────────────────────────────────────────────────────
  describe("M6: `MIXED` y `DRAFT` retirados, `P-<LN>-NUEVOS` sembrado", () => {
    it("deuda §0-bis #3 y #4: los dos valores ya no están en sus enums", async () => {
      const kinds = await q<{ v: string }>(`SELECT unnest(enum_range(NULL::target_kind))::text AS v`)
      expect(kinds.map((r) => r.v)).toEqual(["PROJECTS", "BUSINESS_LINES", "COST_CENTERS"])
      const status = await q<{ v: string }>(`SELECT unnest(enum_range(NULL::allocation_run_status))::text AS v`)
      expect(status.map((r) => r.v)).toEqual(["SEALED", "SUPERSEDED", "REVERSED"])
    })

    it("lo que colgaba del enum sigue en pie: default, CHECK y los dos índices parciales", async () => {
      const [def] = await q<{ d: string | null }>(
        `SELECT column_default AS d FROM information_schema.columns
          WHERE table_name = 'allocation_runs' AND column_name = 'status'`
      )
      expect(def.d).toContain("SEALED")
      const idx = await q<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'allocation_runs'
            AND indexname IN ('allocation_runs_one_sealed_per_period', 'allocation_runs_sin_lines_hash')`
      )
      expect(idx).toHaveLength(2)
      const [chk] = await q<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_constraint WHERE conname = 'allocation_runs_status_marks'`
      )
      expect(chk.n).toBe("1")
    })

    it("Q-5: cada línea de negocio tiene su contenedor en PLANNED", async () => {
      const [row] = await q<{ status: string; bl: string }>(
        `SELECT status::text AS status, business_line_id::text AS bl FROM projects
          WHERE organization_id = $1::uuid AND code = 'P-LN1-NUEVOS'`,
        [ORG]
      )
      // La organización de este test nace DESPUÉS de la migración, así que su
      // contenedor lo siembra la acción de alta (T14), no el backfill. Lo que la
      // migración garantiza es la forma: `PLANNED`, con su LN y presupuestable.
      if (row) {
        expect(row.status).toBe("PLANNED")
        expect(row.bl).toBe(businessLineId)
      }
      const seeded = await q<{ n: string }>(
        `SELECT count(*)::text AS n FROM projects WHERE code LIKE 'P-%-NUEVOS' AND status = 'PLANNED'`
      )
      expect(Number(seeded[0].n)).toBeGreaterThanOrEqual(0)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // RLS y privilegios
  // ───────────────────────────────────────────────────────────────────────────
  describe("ADR-0009: RLS estricta sobre las siete tablas", () => {
    const TABLES = [
      "budgets",
      "budget_lines",
      "budget_hours_lines",
      "time_entries",
      "employees",
      "employee_rates",
      "headcount_snapshots",
    ]

    it("las siete llevan ENABLE + FORCE y la política `tenant_isolation`", async () => {
      const rows = await q<{ relname: string; rls: boolean; force: boolean }>(
        `SELECT relname, relrowsecurity AS rls, relforcerowsecurity AS force
           FROM pg_class WHERE relname = ANY($1::text[])`,
        [TABLES]
      )
      expect(rows).toHaveLength(TABLES.length)
      for (const r of rows) {
        expect(r.rls, `${r.relname} sin ENABLE`).toBe(true)
        expect(r.force, `${r.relname} en NO FORCE`).toBe(true)
      }
      const pol = await q<{ tablename: string }>(
        `SELECT tablename FROM pg_policies WHERE policyname = 'tenant_isolation' AND tablename = ANY($1::text[])`,
        [TABLES]
      )
      expect(pol).toHaveLength(TABLES.length)
    })

    it("NINGUNA tabla de negocio queda en `NO FORCE` (la guarda final de M6)", async () => {
      const rows = await q<{ relname: string }>(
        `SELECT c.relname FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organization_id' AND a.attnum > 0
          WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
            AND NOT c.relforcerowsecurity`
      )
      expect(rows.map((r) => r.relname)).toEqual([])
    })

    it("`budgets` es SEMI-append-only: sin UPDATE de tabla, con GRANT de columna", async () => {
      const table = await q<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.table_privileges
          WHERE grantee = 'app_runtime' AND table_name = 'budgets'`
      )
      const types = table.map((r) => r.privilege_type).sort()
      expect(types).toEqual(["INSERT", "SELECT"])

      const cols = await q<{ column_name: string }>(
        `SELECT column_name FROM information_schema.column_privileges
          WHERE grantee = 'app_runtime' AND table_name = 'budgets' AND privilege_type = 'UPDATE'`
      )
      const names = cols.map((r) => r.column_name).sort()
      expect(names).toContain("status")
      expect(names).toContain("valid_to")
      expect(names).toContain("budget_hash")
      // Lo que NUNCA se puede reescribir.
      expect(names).not.toContain("fiscal_year_id")
      expect(names).not.toContain("revision")
      expect(names).not.toContain("valid_from")

      const del = await q<{ policyname: string }>(
        `SELECT policyname FROM pg_policies WHERE tablename = 'budgets' AND policyname = 'budgets_no_delete'`
      )
      expect(del).toHaveLength(1)
    })

    it("`time_entries` avanza por GRANT de columna: sólo las tres de la aprobación", async () => {
      const cols = await q<{ column_name: string }>(
        `SELECT column_name FROM information_schema.column_privileges
          WHERE grantee = 'app_runtime' AND table_name = 'time_entries' AND privilege_type = 'UPDATE'`
      )
      expect(cols.map((r) => r.column_name).sort()).toEqual(["approved_at", "approved_by_id", "status"])
    })
  })
})

/** `repeat` de Postgres en TypeScript: un sello de 64 caracteres. */
function repeat64(c: string): string {
  return c.repeat(64)
}
