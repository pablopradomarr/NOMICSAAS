/**
 * E9 · T4 — El SQL de M1…M6 contra Postgres de verdad.
 *
 * Todo lo que aquí se comprueba tiene la misma forma: **la regla está en la
 * base, no sólo en el código**. Un CHECK que sólo vive en TypeScript lo esquiva
 * cualquier `UPDATE` por SQL, un script de operador o un reintento de la cola, y
 * es contra eso —no contra el usuario— contra lo que están los invariantes.
 *
 *  · **CHECK G-2…G-17**: importe fijo, ancla y día del mes, ocurrencia con
 *    motivo (incluida la de `CUOTA_CERO`), cuadro de activo, revisión el día 1,
 *    periodificación con cuadro de deuda, prorrata en múltiplos de 100 bps,
 *    pares distintos, distribución que suma el resultado y atribución por activo
 *    sólo en `68x`/`28x`/`671`/`771`.
 *  · **Idempotencia G-1**: dos ocurrencias del mismo periodo chocan contra el
 *    índice único, no contra una comprobación previa con ventana de carrera.
 *  · **Índices únicos PARCIALES**: una liquidación viva por periodo (G-8), un
 *    cierre CERRADO por ejercicio (G-12) y —M6, O-20— un `OPENING`/`CLOSING`
 *    **vivo** por ejercicio, que es lo que permite reabrir y volver a cerrar.
 *  · **Append-only como `app_runtime`** (42501, no vacío silencioso):
 *    `recurring_occurrences`, `asset_revisions` y `profit_distributions`.
 *  · **`app.iva_period` IMMUTABLE** —escrita con `extract`+`lpad`, no con
 *    `to_char`, que es STABLE— y el **backfill** de `journal_entries.iva_period`.
 *  · **B-6 (G-13)**: una línea de IVA en un periodo ya liquidado se rechaza.
 *  · **RLS**: las trece tablas nuevas con `ENABLE` + `FORCE`, ninguna en
 *    `NO FORCE`, y `EXCLUDE` de vigencias del régimen (G-10).
 *
 * Conecta con el rol PROPIETARIO para ejercer constraints y triggers, y abre un
 * cliente `app_runtime` sólo donde lo que se prueba es un privilegio.
 */

import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { appRuntimeDatabaseUrl } from "@/tests/support/env"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL
}

const ORG = "e9000000-0000-4000-8000-00000000000a"
const USER = "e9000000-0000-4000-8000-0000000000a1"

let client: Client
let fiscalYearId = ""
let entryNumber = 0

async function q<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await client.query<T>(sql, params)
  return result.rows
}

/** Ejecuta y devuelve el mensaje de error, o `null` si no falló. */
async function failure(sql: string, params: unknown[] = []): Promise<string | null> {
  await q("SAVEPOINT sp")
  try {
    await q(sql, params)
    await q("RELEASE SAVEPOINT sp")
    return null
  } catch (error) {
    await q("ROLLBACK TO SAVEPOINT sp")
    return error instanceof Error ? error.message : String(error)
  }
}

/** Como `app_runtime`, que es el rol con el que la aplicación conecta de verdad. */
async function asRuntime<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const runtime = new Client({ connectionString: appRuntimeDatabaseUrl(TEST_DATABASE_URL as string) })
  await runtime.connect()
  try {
    await runtime.query("SELECT set_config('app.current_org', $1, false)", [ORG])
    await runtime.query("SELECT set_config('app.current_user', $1, false)", [USER])
    return await fn(runtime)
  } finally {
    await runtime.end()
  }
}

async function newEntry(kind = "NORMAL", entryDate = "2026-03-31"): Promise<string> {
  entryNumber += 1
  const rows = await q<{ id: string }>(
    `INSERT INTO journal_entries
       (id, organization_id, fiscal_year_id, entry_number, entry_date, document_date,
        description, kind, posted_by_id, entry_hash, hash_version)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4::date, $4::date,
             'asiento de prueba', $5::entry_kind, $6::uuid, repeat('0', 64), 3)
     RETURNING id`,
    [ORG, fiscalYearId, entryNumber, entryDate, kind, USER]
  )
  return rows[0].id
}

async function newAsset(code: string, extra: Record<string, string> = {}): Promise<string> {
  const rows = await q<{ id: string }>(
    `INSERT INTO fixed_assets
       (id, organization_id, code, name, asset_account_code, accumulated_account_code,
        expense_account_code, acquisition_date, in_service_date, acquisition_cost_cents,
        useful_life_months, schedule_hash, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, $2, 'Activo', '2131', '2811', '6813',
             '2026-01-15', '2026-02-01', 1000000, ${extra.usefulLife ?? "60"}, repeat('a', 64), now())
     RETURNING id`,
    [ORG, code]
  )
  return rows[0].id
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return
  client = new Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  await cleanup()

  await q(`INSERT INTO users (id, email, name, created_at, updated_at)
           VALUES ($1::uuid, 'e9-esquema@test.local', 'E9', now(), now())`, [USER])
  await q(
    `INSERT INTO organizations (id, slug, name, updated_at)
     VALUES ($1::uuid, 'e9-esquema-org', 'E9 esquema', now())`,
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
  // Las cuentas que usan los CHECK de línea y de activo.
  for (const [code, nature] of [
    ["2131", "DEUDORA"],
    ["2811", "ACREEDORA"],
    ["6813", "DEUDORA"],
    ["472", "DEUDORA"],
    ["477", "ACREEDORA"],
    ["628", "DEUDORA"],
    ["572", "DEUDORA"],
  ] as const) {
    await q(
      `INSERT INTO accounts (id, organization_id, code, name, level, nature, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, $2::text, 'Cuenta ' || $2::text, length($2::text), $3::nature, now())`,
      [ORG, code, nature]
    )
  }

  // Todo el fichero corre dentro de UNA transacción con savepoints: así no deja
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

describe.skipIf(!TEST_DATABASE_URL)("E9 · T4 — CHECK, triggers e índices de M1…M6", () => {
  // ───────────────────────────────────────────────────────────────────────────
  // M2 · recurrentes
  // ───────────────────────────────────────────────────────────────────────────
  describe("M2 · recurrentes (G-1…G-4)", () => {
    async function newRule(code: string, kind: string, extra = ""): Promise<string> {
      const rows = await q<{ id: string }>(
        `INSERT INTO recurring_entries
           (id, organization_id, code, name, kind, template_code, template_input,
            frequency, start_period, updated_at ${extra ? ", " + extra.split("=")[0] : ""})
         VALUES (gen_random_uuid(), $1::uuid, $2, 'Regla', $3::recurring_kind,
                 'ASIENTO_MANUAL', '{}'::jsonb, 'MENSUAL', '2026-01', now()
                 ${extra ? ", " + extra.split("=")[1] : ""})
         RETURNING id`,
        [ORG, code, kind]
      )
      return rows[0].id
    }

    it("G-2: `amount_cents` sólo con `IMPORTE_FIJO`, y obligatorio con él", async () => {
      // Una regla de amortización con importe escrito a mano sería una cifra de
      // informe almacenada (ADR-0003): la aporta el cuadro, no una persona.
      const conImporte = await failure(
        `INSERT INTO recurring_entries
           (organization_id, code, name, kind, template_code, template_input, amount_cents,
            frequency, start_period, fixed_asset_id, updated_at)
         VALUES ($1::uuid, 'R-BAD-1', 'x', 'AMORTIZACION', 'AMORTIZACION_MENSUAL', '{}'::jsonb, 100,
                 'MENSUAL', '2026-01', NULL, now())`,
        [ORG]
      )
      expect(conImporte).toMatch(/recurring_entries_amount_iff_fixed|recurring_entries_asset_iff/)

      const sinImporte = await failure(
        `INSERT INTO recurring_entries
           (organization_id, code, name, kind, template_code, template_input,
            frequency, start_period, updated_at)
         VALUES ($1::uuid, 'R-BAD-2', 'x', 'IMPORTE_FIJO', 'ASIENTO_MANUAL', '{}'::jsonb,
                 'MENSUAL', '2026-01', now())`,
        [ORG]
      )
      expect(sinImporte).toContain("recurring_entries_amount_iff_fixed")
    })

    it("G-2: `fixed_asset_id` ⟺ AMORTIZACION y `accrual_id` ⟺ PERIODIFICACION", async () => {
      const asset = await newAsset("A-G2")
      const cruzado = await failure(
        `INSERT INTO recurring_entries
           (organization_id, code, name, kind, template_code, template_input, amount_cents,
            frequency, start_period, fixed_asset_id, updated_at)
         VALUES ($1::uuid, 'R-BAD-3', 'x', 'IMPORTE_FIJO', 'ASIENTO_MANUAL', '{}'::jsonb, 100,
                 'MENSUAL', '2026-01', $2::uuid, now())`,
        [ORG, asset]
      )
      expect(cruzado).toContain("recurring_entries_asset_iff_amortizacion")
    })

    it("G-3: `day_of_month` sólo con `DIA_DEL_MES` y entre 1 y 31", async () => {
      const sinAncla = await failure(
        `INSERT INTO recurring_entries
           (organization_id, code, name, kind, template_code, template_input, amount_cents,
            frequency, anchor, day_of_month, start_period, updated_at)
         VALUES ($1::uuid, 'R-BAD-4', 'x', 'IMPORTE_FIJO', 'ASIENTO_MANUAL', '{}'::jsonb, 100,
                 'MENSUAL', 'ULTIMO_DIA', 15, '2026-01', now())`,
        [ORG]
      )
      expect(sinAncla).toContain("recurring_entries_day_iff_anchor")

      const fueraDeRango = await failure(
        `INSERT INTO recurring_entries
           (organization_id, code, name, kind, template_code, template_input, amount_cents,
            frequency, anchor, day_of_month, start_period, updated_at)
         VALUES ($1::uuid, 'R-BAD-5', 'x', 'IMPORTE_FIJO', 'ASIENTO_MANUAL', '{}'::jsonb, 100,
                 'MENSUAL', 'DIA_DEL_MES', 32, '2026-01', now())`,
        [ORG]
      )
      expect(fueraDeRango).toContain("recurring_entries_day_range")
    })

    it("el periodo de vigencia tiene formato `AAAA-MM` o `AAAA-Tn`", async () => {
      const malFormato = await failure(
        `INSERT INTO recurring_entries
           (organization_id, code, name, kind, template_code, template_input, amount_cents,
            frequency, start_period, updated_at)
         VALUES ($1::uuid, 'R-BAD-6', 'x', 'IMPORTE_FIJO', 'ASIENTO_MANUAL', '{}'::jsonb, 100,
                 'MENSUAL', '2026-13', now())`,
        [ORG]
      )
      expect(malFormato).toContain("recurring_entries_start_period_format")
    })

    it("G-1: la idempotencia ES el índice único `(org, regla, periodo)`", async () => {
      const rule = await newRule("R-IDEM", "IMPORTE_FIJO", "amount_cents=100")
      const entry = await newEntry()
      await q(
        `INSERT INTO recurring_occurrences
           (organization_id, recurring_entry_id, period, posting_date, status, entry_id, input_hash)
         VALUES ($1::uuid, $2::uuid, '2026-03', '2026-03-31', 'GENERADA', $3::uuid, repeat('b', 64))`,
        [ORG, rule, entry]
      )
      // La segunda generación del MISMO periodo muere contra el índice. Sin él,
      // dos transacciones simultáneas dejarían dos asientos y nadie lo vería.
      const entry2 = await newEntry()
      const duplicada = await failure(
        `INSERT INTO recurring_occurrences
           (organization_id, recurring_entry_id, period, posting_date, status, entry_id, input_hash)
         VALUES ($1::uuid, $2::uuid, '2026-03', '2026-03-31', 'GENERADA', $3::uuid, repeat('c', 64))`,
        [ORG, rule, entry2]
      )
      expect(duplicada).toContain("recurring_occurrences_org_entry_period_key")
    })

    it("G-4: `entry_id` ⟺ GENERADA, y toda ocurrencia no generada lleva motivo", async () => {
      const rule = await newRule("R-G4", "IMPORTE_FIJO", "amount_cents=100")

      const omitidaConAsiento = await failure(
        `INSERT INTO recurring_occurrences
           (organization_id, recurring_entry_id, period, posting_date, status, reason, entry_id, input_hash)
         VALUES ($1::uuid, $2::uuid, '2026-04', '2026-04-30', 'OMITIDA', 'pausada',
                 $3::uuid, repeat('d', 64))`,
        [ORG, rule, await newEntry()]
      )
      expect(omitidaConAsiento).toContain("recurring_occurrences_entry_iff_generada")

      const omitidaSinMotivo = await failure(
        `INSERT INTO recurring_occurrences
           (organization_id, recurring_entry_id, period, posting_date, status, input_hash)
         VALUES ($1::uuid, $2::uuid, '2026-05', '2026-05-31', 'OMITIDA', repeat('e', 64))`,
        [ORG, rule]
      )
      expect(omitidaSinMotivo).toContain("recurring_occurrences_reason_when_not_generada")

      // O-22: la cuota cero SÍ deja fila, con su vocabulario reservado. No
      // generar asiento y no dejar rastro son cosas distintas: la segunda hace
      // imposible demostrar que el cuadro se recorrió entero.
      const cuotaCero = await failure(
        `INSERT INTO recurring_occurrences
           (organization_id, recurring_entry_id, period, posting_date, status, reason, input_hash)
         VALUES ($1::uuid, $2::uuid, '2026-06', '2026-06-30', 'OMITIDA', 'CUOTA_CERO', repeat('f', 64))`,
        [ORG, rule]
      )
      expect(cuotaCero).toBeNull()
    })

    it("append-only: `app_runtime` no puede actualizar ni borrar una ocurrencia (42501)", async () => {
      const privileges = await q<{ upd: boolean; del: boolean }>(
        `SELECT has_table_privilege('app_runtime', 'recurring_occurrences', 'UPDATE') AS upd,
                has_table_privilege('app_runtime', 'recurring_occurrences', 'DELETE') AS del`
      )
      expect(privileges[0].upd).toBe(false)
      expect(privileges[0].del).toBe(false)

      const error = await asRuntime(async (c) => {
        try {
          await c.query(`UPDATE recurring_occurrences SET reason = 'otra cosa'`)
          return null
        } catch (e) {
          return e as { code?: string }
        }
      })
      expect(error?.code).toBe("42501")
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // M2 · inmovilizado y deuda
  // ───────────────────────────────────────────────────────────────────────────
  describe("M2 · inmovilizado y deuda (G-5…G-7, G-15, G-17)", () => {
    it("G-5: coste positivo, residual por debajo del coste y vida útil 1–1200", async () => {
      const residualAlto = await failure(
        `INSERT INTO fixed_assets
           (organization_id, code, name, asset_account_code, accumulated_account_code,
            expense_account_code, acquisition_date, in_service_date, acquisition_cost_cents,
            residual_value_cents, useful_life_months, schedule_hash, updated_at)
         VALUES ($1::uuid, 'A-BAD-1', 'x', '2131', '2811', '6813', '2026-01-01', '2026-01-01',
                 1000, 1000, 60, repeat('a', 64), now())`,
        [ORG]
      )
      expect(residualAlto).toContain("fixed_assets_residual_range")

      const vidaCero = await failure(
        `INSERT INTO fixed_assets
           (organization_id, code, name, asset_account_code, accumulated_account_code,
            expense_account_code, acquisition_date, in_service_date, acquisition_cost_cents,
            useful_life_months, schedule_hash, updated_at)
         VALUES ($1::uuid, 'A-BAD-2', 'x', '2131', '2811', '6813', '2026-01-01', '2026-01-01',
                 1000, 0, repeat('a', 64), now())`,
        [ORG]
      )
      expect(vidaCero).toContain("fixed_assets_useful_life_range")
    })

    it("G-5: la puesta en funcionamiento no es anterior a la adquisición (NRV 2ª.1)", async () => {
      const antes = await failure(
        `INSERT INTO fixed_assets
           (organization_id, code, name, asset_account_code, accumulated_account_code,
            expense_account_code, acquisition_date, in_service_date, acquisition_cost_cents,
            useful_life_months, schedule_hash, updated_at)
         VALUES ($1::uuid, 'A-BAD-3', 'x', '2131', '2811', '6813', '2026-06-01', '2026-01-01',
                 1000, 60, repeat('a', 64), now())`,
        [ORG]
      )
      expect(antes).toContain("fixed_assets_in_service_after_acquisition")
    })

    it("G-9: la prorrata de adquisición va en bps y es múltiplo de 100 (art. 104.Dos.2ª)", async () => {
      const noMultiplo = await failure(
        `INSERT INTO fixed_assets
           (organization_id, code, name, asset_account_code, accumulated_account_code,
            expense_account_code, acquisition_date, in_service_date, acquisition_cost_cents,
            useful_life_months, acquisition_prorrata_bps, schedule_hash, updated_at)
         VALUES ($1::uuid, 'A-BAD-4', 'x', '2131', '2811', '6813', '2026-01-01', '2026-01-01',
                 1000, 60, 8750, repeat('a', 64), now())`,
        [ORG]
      )
      expect(noMultiplo).toContain("fixed_assets_prorrata_bps_range")
    })

    it("G-6: la revisión entra el DÍA 1 de un mes y con motivo", async () => {
      const asset = await newAsset("A-REV")
      const mitadDeMes = await failure(
        `INSERT INTO asset_revisions
           (organization_id, fixed_asset_id, effective_from, new_useful_life_months, reason)
         VALUES ($1::uuid, $2::uuid, '2026-07-15', 48, 'cambio de estimacion de vida util')`,
        [ORG, asset]
      )
      expect(mitadDeMes).toContain("asset_revisions_effective_first_day")

      const sinCambio = await failure(
        `INSERT INTO asset_revisions (organization_id, fixed_asset_id, effective_from, reason)
         VALUES ($1::uuid, $2::uuid, '2026-07-01', 'no cambia nada de nada')`,
        [ORG, asset]
      )
      expect(sinCambio).toContain("asset_revisions_has_change")

      const buena = await failure(
        `INSERT INTO asset_revisions
           (organization_id, fixed_asset_id, effective_from, new_useful_life_months, reason)
         VALUES ($1::uuid, $2::uuid, '2026-07-01', 48, 'revision de vida util por uso intensivo')`,
        [ORG, asset]
      )
      expect(buena).toBeNull()
    })

    it("G-7: `TIPO_EFECTIVO` exige cuadro de deuda (O-25)", async () => {
      const sinCuadro = await failure(
        `INSERT INTO accruals
           (organization_id, code, name, kind, accrual_account_code, pnl_account_code,
            total_cents, period_start, period_end, basis, schedule_hash, updated_at)
         VALUES ($1::uuid, 'P-BAD-1', 'x', 'INTERESES_PAGADOS_ANTICIPADO', '567', '662',
                 100000, '2026-01-01', '2026-12-31', 'TIPO_EFECTIVO', repeat('a', 64), now())`,
        [ORG]
      )
      expect(sinCuadro).toContain("accruals_effective_rate_needs_schedule")
    })

    it("G-17: `Σ principal` de las cuotas = principal de la deuda, en el COMMIT", async () => {
      await q("SAVEPOINT g17")
      await q(
        `INSERT INTO debt_schedules
           (id, organization_id, code, name, long_account_code, short_account_code,
            principal_cents, start_date, schedule_hash, updated_at)
         VALUES ('e9000000-0000-4000-8000-0000000000d1'::uuid, $1::uuid, 'D-1', 'Préstamo',
                 '170', '520', 1000, '2026-01-01', repeat('a', 64), now())`,
        [ORG]
      )
      // Dos cuotas que suman 900 sobre un principal de 1000: el cuadro miente.
      await q(
        `INSERT INTO debt_installments (organization_id, debt_schedule_id, seq, due_date, principal_cents, interest_cents)
         VALUES ($1::uuid, 'e9000000-0000-4000-8000-0000000000d1'::uuid, 1, '2026-06-30', 500, 10),
                ($1::uuid, 'e9000000-0000-4000-8000-0000000000d1'::uuid, 2, '2026-12-31', 400, 5)`,
        [ORG]
      )
      // El constraint es DIFERIDO: el cuadro se inserta fila a fila y sólo cuadra
      // al terminar. Se fuerza la comprobación con `SET CONSTRAINTS … IMMEDIATE`.
      const roto = await failure(`SET CONSTRAINTS "debt_installments_schedule_complete" IMMEDIATE`)
      expect(roto).toContain("G-17")
      await q("ROLLBACK TO SAVEPOINT g17")
    })

    it("G-15: `fixed_asset_id` sólo en líneas de 68x / 28x / 671 / 771 (O-19)", async () => {
      const asset = await newAsset("A-LIN")
      const entry = await newEntry()

      const cuentaAjena = await failure(
        `INSERT INTO journal_lines
           (organization_id, entry_id, line_no, account_code, debit_cents, credit_cents,
            fixed_asset_id, entry_date, fiscal_year_id, entry_kind)
         VALUES ($1::uuid, $2::uuid, 1, '628', 1000, 0, $3::uuid, '2026-03-31', $4::uuid, 'NORMAL')`,
        [ORG, entry, asset, fiscalYearId]
      )
      expect(cuentaAjena).toContain("journal_lines_fixed_asset_accounts")

      const dotacion = await failure(
        `INSERT INTO journal_lines
           (organization_id, entry_id, line_no, account_code, debit_cents, credit_cents,
            fixed_asset_id, entry_date, fiscal_year_id, entry_kind)
         VALUES ($1::uuid, $2::uuid, 2, '6813', 1000, 0, $3::uuid, '2026-03-31', $4::uuid, 'NORMAL')`,
        [ORG, entry, asset, fiscalYearId]
      )
      expect(dotacion).toBeNull()
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // M3 · IVA
  // ───────────────────────────────────────────────────────────────────────────
  describe("M3 · IVA (app.iva_period, G-8, G-9, G-10)", () => {
    it("`app.iva_period` es IMMUTABLE y devuelve el periodo de `max(documento, recepción)`", async () => {
      const [meta] = await q<{ provolatile: string }>(
        `SELECT provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'app' AND p.proname = 'iva_period'`
      )
      // 'i' = IMMUTABLE. Con `to_char` —que es STABLE— la función no podría
      // entrar en un índice ni en un CHECK, que es justo para lo que se usa.
      expect(meta.provolatile).toBe("i")

      const [row] = await q<{ trimestral: string; mensual: string; posterior: string; nulo: string | null }>(
        `SELECT app.iva_period('2026-05-20'::date, NULL, 'TRIMESTRAL') AS trimestral,
                app.iva_period('2026-05-20'::date, NULL, 'MENSUAL')    AS mensual,
                app.iva_period('2026-01-31'::date, '2026-04-02'::date, 'TRIMESTRAL') AS posterior,
                app.iva_period(NULL, NULL, 'TRIMESTRAL') AS nulo`
      )
      expect(row.trimestral).toBe("2026-T2")
      expect(row.mensual).toBe("2026-05")
      // R-IVA-8: manda la RECEPCIÓN cuando es posterior — una factura de enero
      // recibida en abril se deduce en el segundo trimestre, no en el primero.
      expect(row.posterior).toBe("2026-T2")
      expect(row.nulo).toBeNull()
    })

    it("el trigger escribe `iva_period` y el CHECK rechaza un formato inventado", async () => {
      const entry = await newEntry("NORMAL", "2026-08-15")
      const [row] = await q<{ iva_period: string }>(
        `SELECT iva_period FROM journal_entries WHERE id = $1::uuid`,
        [entry]
      )
      // La vigencia por defecto que siembra M3 es TRIMESTRAL.
      expect(row.iva_period).toBe("2026-T3")

      const malFormato = await failure(
        `UPDATE journal_entries SET iva_period = '2026-Q3' WHERE id = $1::uuid`,
        [entry]
      )
      expect(malFormato).toContain("journal_entries_iva_period_format")
    })

    it("el backfill dejó TODO el histórico con periodo (§3.5)", async () => {
      const [row] = await q<{ pendientes: string }>(
        `SELECT count(*)::text AS pendientes FROM journal_entries WHERE iva_period IS NULL`
      )
      expect(row.pendientes).toBe("0")

      // Y la marca está escrita, que es lo que impide repetir el backfill.
      const [marca] = await q<{ comentario: string | null }>(
        `SELECT obj_description('journal_entries'::regclass, 'pg_class') AS comentario`
      )
      expect(marca.comentario).toContain("iva_period:backfilled")
    })

    it("G-10: dos vigencias de régimen que se solapan chocan contra el EXCLUDE", async () => {
      await q(
        `INSERT INTO vat_regime_periods (organization_id, regime, period_kind, valid_from, valid_to)
         VALUES ($1::uuid, 'GENERAL', 'TRIMESTRAL', '2030-01-01', '2030-12-31')`,
        [ORG]
      )
      const solapada = await failure(
        `INSERT INTO vat_regime_periods (organization_id, regime, period_kind, valid_from)
         VALUES ($1::uuid, 'REDEME', 'MENSUAL', '2030-06-01')`,
        [ORG]
      )
      expect(solapada).toContain("vat_regime_periods_no_overlap")
    })

    it("O-16: el diferimiento de importación exige periodo MENSUAL", async () => {
      const conTrimestre = await failure(
        `INSERT INTO vat_regime_periods (organization_id, regime, period_kind, import_deferral, valid_from)
         VALUES ($1::uuid, 'GENERAL', 'TRIMESTRAL', true, '2031-01-01')`,
        [ORG]
      )
      expect(conTrimestre).toContain("vat_regime_periods_deferral_needs_monthly")
    })

    it("G-8: una liquidación VIVA por periodo, y revertir permite re-liquidar", async () => {
      const entry1 = await newEntry()
      await q(
        `INSERT INTO vat_settlements
           (id, organization_id, period_kind, period, period_start, period_end, regime, entry_id,
            output_cents, input_cents, result_cents, ledger_hash, book_hash, git_sha)
         VALUES ('e9000000-0000-4000-8000-00000000ee11'::uuid, $1::uuid, 'TRIMESTRAL', '2026-T1',
                 '2026-01-01', '2026-03-31', 'GENERAL', $2::uuid,
                 1000, 400, 600, repeat('a', 64), repeat('b', 64), 'abc123')`,
        [ORG, entry1]
      )
      const segunda = await failure(
        `INSERT INTO vat_settlements
           (organization_id, period_kind, period, period_start, period_end, regime, entry_id,
            output_cents, input_cents, result_cents, ledger_hash, book_hash, git_sha)
         VALUES ($1::uuid, 'TRIMESTRAL', '2026-T1', '2026-01-01', '2026-03-31', 'GENERAL', $2::uuid,
                 1000, 400, 600, repeat('a', 64), repeat('b', 64), 'abc123')`,
        [ORG, await newEntry()]
      )
      expect(segunda).toContain("vat_settlements_one_live_per_period")

      // Al revertir, el índice PARCIAL deja sitio para la rectificativa. Con un
      // `UNIQUE` a secas, la única salida sería BORRAR la primera.
      await q(
        `UPDATE vat_settlements SET status = 'REVERTIDA', reversed_by_entry_id = $1::uuid,
                reverse_reason = 'rectificativa del primer trimestre'
          WHERE id = 'e9000000-0000-4000-8000-00000000ee11'::uuid`,
        [await newEntry()]
      )
      const reliquidada = await failure(
        `INSERT INTO vat_settlements
           (organization_id, period_kind, period, period_start, period_end, regime, entry_id,
            output_cents, input_cents, result_cents, ledger_hash, book_hash, git_sha)
         VALUES ($1::uuid, 'TRIMESTRAL', '2026-T1', '2026-01-01', '2026-03-31', 'GENERAL', $2::uuid,
                 1100, 400, 700, repeat('a', 64), repeat('b', 64), 'abc123')`,
        [ORG, await newEntry()]
      )
      expect(reliquidada).toBeNull()
    })

    it("las cifras de una liquidación son inmutables: sólo se puede escribir su reversión", async () => {
      const [{ id }] = await q<{ id: string }>(
        `SELECT id FROM vat_settlements WHERE organization_id = $1::uuid AND status = 'LIQUIDADA' LIMIT 1`,
        [ORG]
      )
      const reescritura = await failure(
        `UPDATE vat_settlements SET result_cents = 1 WHERE id = $1::uuid`,
        [id]
      )
      // I-E9-9 recalcula estas cuatro cifras: si se pudieran reescribir, no
      // tendría contra qué comparar.
      expect(reescritura).toContain("REVERSIÓN")
    })

    it("O-9/G-9: la prorrata va en bps múltiplos de 100 y el numerador no excede al denominador", async () => {
      const noMultiplo = await failure(
        `INSERT INTO prorrata_years (organization_id, year, provisional_bps)
         VALUES ($1::uuid, 2026, 8750)`,
        [ORG]
      )
      expect(noMultiplo).toContain("prorrata_years_provisional_bps")

      const numeradorMayor = await failure(
        `INSERT INTO prorrata_years (organization_id, year, provisional_bps, numerator_cents, denominator_cents)
         VALUES ($1::uuid, 2026, 8000, 200, 100)`,
        [ORG]
      )
      // Una prorrata por encima del 100 % sería una deducción inventada.
      expect(numeradorMayor).toContain("prorrata_years_numerator_le_denominator")
    })

    it("I-E9-10b: si hay ajuste de prorrata, consta EN QUÉ PERIODO se practicó", async () => {
      const sinPeriodo = await failure(
        `INSERT INTO prorrata_years
           (organization_id, year, provisional_bps, regularization_entry_id)
         VALUES ($1::uuid, 2027, 8000, $2::uuid)`,
        [ORG, await newEntry()]
      )
      expect(sinPeriodo).toContain("prorrata_years_regularization_coherent")
    })

    it("G-11: un par de reclasificación no puede tener la misma cuenta a los dos lados", async () => {
      const mismo = await failure(
        `INSERT INTO reclassification_pairs (organization_id, long_account_code, short_account_code)
         VALUES ($1::uuid, '170', '170')`,
        [ORG]
      )
      expect(mismo).toContain("reclassification_pairs_accounts_distinct")
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // M4 · cierre y distribución
  // ───────────────────────────────────────────────────────────────────────────
  describe("M4 · cierre, distribución y columnas nuevas", () => {
    async function newClosingRun(status = "BORRADOR", closed = false): Promise<string | null> {
      return failure(
        `INSERT INTO closing_runs
           (organization_id, fiscal_year_id, status, ref_date, steps, ledger_hash, plan_hash,
            account_map_hash, config_hash, git_sha, seal, duration_ms ${closed ? ", closed_at" : ""})
         VALUES ($1::uuid, $2::uuid, $3::closing_run_status, '2026-12-31', '[]'::jsonb,
                 repeat('a', 64), repeat('b', 64), repeat('c', 64), repeat('d', 64), 'abc',
                 'VALIDADO_AUTOMATICAMENTE', 10 ${closed ? ", now()" : ""})`,
        [ORG, fiscalYearId, status]
      )
    }

    it("G-12: un cierre CERRADO vivo por ejercicio, pero se puede reabrir y volver a cerrar", async () => {
      await q("SAVEPOINT g12")
      expect(await newClosingRun("CERRADO", true)).toBeNull()
      expect(await newClosingRun("CERRADO", true)).toContain("closing_runs_one_closed_per_fiscal_year")
      // Reabrir libera el índice parcial: es lo que hace posible el recierre.
      await q(
        `UPDATE closing_runs SET status = 'REABIERTO', reopened_at = now(),
                reopen_reason = 'error detectado antes de formular (art. 253 LSC)'
          WHERE organization_id = $1::uuid AND status = 'CERRADO'`,
        [ORG]
      )
      expect(await newClosingRun("CERRADO", true)).toBeNull()
      await q("ROLLBACK TO SAVEPOINT g12")
    })

    it("la reapertura deja SIEMPRE motivo", async () => {
      await q("SAVEPOINT motivo")
      await newClosingRun("CERRADO", true)
      const sinMotivo = await failure(
        `UPDATE closing_runs SET status = 'REABIERTO', reopened_at = now()
          WHERE organization_id = $1::uuid AND status = 'CERRADO'`,
        [ORG]
      )
      expect(sinMotivo).toContain("closing_runs_reopen_reason")
      await q("ROLLBACK TO SAVEPOINT motivo")
    })

    it("los cinco sellos del cierre son inmutables", async () => {
      await q("SAVEPOINT sellos")
      await newClosingRun("BORRADOR")
      const reescritura = await failure(
        `UPDATE closing_runs SET ledger_hash = repeat('9', 64) WHERE organization_id = $1::uuid`,
        [ORG]
      )
      expect(reescritura).toContain("INMUTABLES")
      await q("ROLLBACK TO SAVEPOINT sellos")
    })

    it("G-16: `Σ destinos = result_cents`, con el dividendo a cuenta restando", async () => {
      await q("SAVEPOINT g16")
      const entry = await newEntry()
      const descuadrada = await failure(
        `INSERT INTO profit_distributions
           (organization_id, fiscal_year_id, meeting_date, result_cents,
            legal_reserve_cents, voluntary_reserve_cents, entry_id)
         VALUES ($1::uuid, $2::uuid, '2027-06-30', 100000, 10000, 50000, $3::uuid)`,
        [ORG, fiscalYearId, entry]
      )
      expect(descuadrada).toContain("profit_distributions_sum_matches_result")

      const cuadrada = await failure(
        `INSERT INTO profit_distributions
           (organization_id, fiscal_year_id, meeting_date, result_cents,
            legal_reserve_cents, voluntary_reserve_cents, dividend_cents, entry_id)
         VALUES ($1::uuid, $2::uuid, '2027-06-30', 100000, 10000, 50000, 40000, $3::uuid)`,
        [ORG, fiscalYearId, entry]
      )
      expect(cuadrada).toBeNull()
      await q("ROLLBACK TO SAVEPOINT g16")
    })

    it("una pérdida no dota reservas ni reparte dividendo (art. 273 LSC)", async () => {
      const perdidaConReserva = await failure(
        `INSERT INTO profit_distributions
           (organization_id, fiscal_year_id, meeting_date, result_cents,
            legal_reserve_cents, loss_carry_forward_cents, entry_id)
         VALUES ($1::uuid, $2::uuid, '2027-06-30', -100000, 10000, 110000, $3::uuid)`,
        [ORG, fiscalYearId, await newEntry()]
      )
      expect(perdidaConReserva).toContain("profit_distributions_loss_only_to_121")
    })

    it("D1: el estado societario del ejercicio va con sus fechas", async () => {
      const sinFecha = await failure(
        `UPDATE fiscal_years SET accounts_approval_status = 'FORMULADAS' WHERE id = $1::uuid`,
        [fiscalYearId]
      )
      expect(sinFecha).toContain("fiscal_years_approval_dates_coherent")

      const conFecha = await failure(
        `UPDATE fiscal_years SET accounts_approval_status = 'FORMULADAS', formulated_at = now()
          WHERE id = $1::uuid`,
        [fiscalYearId]
      )
      expect(conFecha).toBeNull()
      await q(`UPDATE fiscal_years SET accounts_approval_status = 'BORRADOR', formulated_at = NULL
                WHERE id = $1::uuid`, [fiscalYearId])
    })

    it("O-10: la clave de operación del libro registro es vocabulario CERRADO", async () => {
      const inventada = await failure(
        `INSERT INTO transactions (id, organization_id, name, vat_operation_key, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, 'op', 'EXENTO_TOTAL', now())`,
        [ORG]
      )
      // Con texto libre, una errata deja el documento fuera del numerador de la
      // prorrata sin que nadie lo vea.
      expect(inventada).toContain("transactions_vat_operation_key_vocab")
    })

    it("O-4: `accounts.is_monetary` existe y NO marca los anticipos 407 / 438", async () => {
      const [row] = await q<{ existe: string }>(
        `SELECT count(*)::text AS existe FROM information_schema.columns
          WHERE table_name = 'accounts' AND column_name = 'is_monetary'`
      )
      expect(row.existe).toBe("1")

      // La siembra de M4 marca 40x salvo 407: un anticipo da derecho a recibir
      // un BIEN, no una cantidad fija de dinero (NRV 11ª.2.2), y convertirlo al
      // tipo de cierre inventa resultado.
      await q(
        `INSERT INTO accounts (id, organization_id, code, name, level, nature, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, '4001', 'Proveedor X', 4, 'ACREEDORA', now()),
                (gen_random_uuid(), $1::uuid, '4071', 'Anticipo a proveedor', 4, 'DEUDORA', now())`,
        [ORG]
      )
      const [defecto] = await q<{ code: string; is_monetary: boolean }>(
        `SELECT code, is_monetary FROM accounts WHERE organization_id = $1::uuid AND code = '4071'`,
        [ORG]
      )
      // Las cuentas creadas DESPUÉS de la siembra nacen en false: la marca es un
      // dato del plan que se fija al IMPORTARLO desde `seeds/npgc.csv`, no un
      // cálculo por prefijo que el motor rehaga cada vez (O-4).
      expect(defecto.is_monetary).toBe(false)
    })

    it("append-only: `app_runtime` no puede reescribir una distribución acordada", async () => {
      const privileges = await q<{ upd: boolean; del: boolean }>(
        `SELECT has_table_privilege('app_runtime', 'profit_distributions', 'UPDATE') AS upd,
                has_table_privilege('app_runtime', 'profit_distributions', 'DELETE') AS del`
      )
      expect(privileges[0].upd).toBe(false)
      expect(privileges[0].del).toBe(false)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // M5 · B-6
  // ───────────────────────────────────────────────────────────────────────────
  describe("M5 · B-6 (G-13): no se contabiliza IVA en un periodo liquidado", () => {
    it("una línea de 472/477 en un periodo LIQUIDADO se rechaza; una de 628, no", async () => {
      await q("SAVEPOINT b6")
      const liquidado = await newEntry("NORMAL", "2026-11-15") // 2026-T4
      await q(
        `INSERT INTO vat_settlements
           (organization_id, period_kind, period, period_start, period_end, regime, entry_id,
            output_cents, input_cents, result_cents, ledger_hash, book_hash, git_sha)
         VALUES ($1::uuid, 'TRIMESTRAL', '2026-T4', '2026-10-01', '2026-12-31', 'GENERAL', $2::uuid,
                 1000, 400, 600, repeat('a', 64), repeat('b', 64), 'abc')`,
        [ORG, liquidado]
      )

      const nuevo = await newEntry("NORMAL", "2026-12-01")
      const conIva = await failure(
        `INSERT INTO journal_lines
           (organization_id, entry_id, line_no, account_code, debit_cents, credit_cents,
            entry_date, fiscal_year_id, entry_kind)
         VALUES ($1::uuid, $2::uuid, 1, '472', 210, 0, '2026-12-01', $3::uuid, 'NORMAL')`,
        [ORG, nuevo, fiscalYearId]
      )
      expect(conIva).toContain("B-6")
      // El mensaje lleva la SALIDA, no sólo la negativa.
      expect(conIva).toMatch(/Revierta la liquidación|periodo corriente/)

      const sinIva = await failure(
        `INSERT INTO journal_lines
           (organization_id, entry_id, line_no, account_code, debit_cents, credit_cents,
            entry_date, fiscal_year_id, entry_kind)
         VALUES ($1::uuid, $2::uuid, 2, '628', 1000, 0, '2026-12-01', $3::uuid, 'NORMAL')`,
        [ORG, nuevo, fiscalYearId]
      )
      expect(sinIva).toBeNull()
      await q("ROLLBACK TO SAVEPOINT b6")
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // M6 · numeración viva
  // ───────────────────────────────────────────────────────────────────────────
  describe("M6 · numeración VIVA (O-20)", () => {
    it("un solo `CLOSING` VIVO por ejercicio; anular el anterior permite recerrar", async () => {
      await q("SAVEPOINT m6")
      const cierre1 = await newEntry("CLOSING", "2026-12-31")
      const segundo = await failure(
        `INSERT INTO journal_entries
           (organization_id, fiscal_year_id, entry_number, entry_date, description, kind,
            posted_by_id, entry_hash, hash_version)
         VALUES ($1::uuid, $2::uuid, 9001, '2026-12-31', 'segundo cierre', 'CLOSING',
                 $3::uuid, repeat('0', 64), 3)`,
        [ORG, fiscalYearId, USER]
      )
      expect(segundo).toContain("journal_entries_one_live_closing_per_fiscal_year")

      // La reapertura ANULA el cierre; el anulado es historia y no cuenta.
      await q(
        `UPDATE journal_entries SET voided_at = now(), voided_by_id = $2::uuid,
                void_reason = 'reapertura del ejercicio antes de formular'
          WHERE id = $1::uuid`,
        [cierre1, USER]
      )
      const recierre = await failure(
        `INSERT INTO journal_entries
           (organization_id, fiscal_year_id, entry_number, entry_date, description, kind,
            posted_by_id, entry_hash, hash_version)
         VALUES ($1::uuid, $2::uuid, 9002, '2026-12-31', 'recierre', 'CLOSING',
                 $3::uuid, repeat('0', 64), 3)`,
        [ORG, fiscalYearId, USER]
      )
      // Sin M6, aquí el ejercicio quedaba incapaz de volver a cerrarse.
      expect(recierre).toBeNull()
      await q("ROLLBACK TO SAVEPOINT m6")
    })

    it("`app.numeracion_viva` calcula N-1′ y N-5′ sobre los asientos NO anulados", async () => {
      const [row] = await q<{ live_count: string; ok_n1: boolean; ok_n5: boolean }>(
        `SELECT live_count::text, ok_n1, ok_n5 FROM app.numeracion_viva($1::uuid, $2::uuid)`,
        [ORG, fiscalYearId]
      )
      expect(Number(row.live_count)).toBeGreaterThan(0)
      // Sin apertura ni cierre vivos, N-1′ se cumple por definición.
      expect(row.ok_n1).toBe(true)
      expect(typeof row.ok_n5).toBe("boolean")
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // RLS
  // ───────────────────────────────────────────────────────────────────────────
  describe("RLS estricta (ADR-0009) sobre las trece tablas nuevas", () => {
    const TABLAS = [
      "recurring_entries",
      "recurring_occurrences",
      "fixed_assets",
      "asset_revisions",
      "accruals",
      "debt_schedules",
      "debt_installments",
      "vat_regime_periods",
      "vat_settlements",
      "prorrata_years",
      "reclassification_pairs",
      "profit_distributions",
      "closing_runs",
    ] as const

    it("las trece llevan ENABLE + FORCE y política `tenant_isolation`", async () => {
      const rows = await q<{ relname: string; rls: boolean; force: boolean; policies: string }>(
        `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
                (SELECT count(*)::text FROM pg_policies p
                  WHERE p.tablename = c.relname AND p.policyname = 'tenant_isolation') AS policies
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
        [[...TABLAS]]
      )
      expect(rows).toHaveLength(TABLAS.length)
      for (const row of rows) {
        expect(row.rls, `${row.relname} sin ENABLE`).toBe(true)
        // Con `NO FORCE`, el propietario esquiva la política y un backfill que
        // se olvide del baile deja la puerta abierta para siempre.
        expect(row.force, `${row.relname} en NO FORCE`).toBe(true)
        expect(row.policies, `${row.relname} sin política`).toBe("1")
      }
    })

    it("ninguna tabla de negocio de la base queda en NO FORCE tras M1…M6", async () => {
      const rows = await q<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r'
            AND c.relrowsecurity AND NOT c.relforcerowsecurity`
      )
      expect(rows.map((r) => r.relname)).toEqual([])
    })
  })
})
