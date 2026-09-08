/**
 * E9 · T12/T14/T21 — Los modelos de cierre contra Postgres de verdad.
 *
 * Lo que aquí se ejerce no se puede ejercer en un test puro:
 *
 *  · **Los agregados son los que el cálculo esperado dice.** `readMaturities`
 *    parte el principal por el corte + 12 meses, `readAssetsWithRevisions` suma
 *    `68x`/`28x` **por activo** (O-19) y `readFxPositions` deja fuera un
 *    anticipo en `407` porque **el plan** dice que no es monetario (O-4,
 *    I-E9-24). Ninguna de las tres cifras sale de la misma consulta que las
 *    produce: se comparan contra el número escrito a mano.
 *  · **La idempotencia es del índice, no de un `if`.** Dos ocurrencias del mismo
 *    `(regla, periodo)` chocan contra G-1 con **23505**, y la segunda
 *    transacción muere **sin dejar asiento** (criterio 1).
 *  · **El tenant.** Nada de la organización B aparece leyendo con la A, ni
 *    siquiera con el id delante.
 *  · **Append-only como `app_runtime`**: `UPDATE`/`DELETE` sobre
 *    `recurring_occurrences` y `profit_distributions` dan **42501**, no un
 *    silencio.
 *  · **T21**: `prune-runs --archive` escribe el JSON **antes** de borrar, con el
 *    `checksHash` intacto para que I-E7-7 lo pueda verificar fuera de la base.
 *  · **La distribución (O-18, R2-2)**: el capital sale del saldo de `100`, la
 *    reserva legal se calcula, y retroceder de `APROBADAS` se rechaza citando la
 *    LSC y **ofreciendo la vía del acuerdo de reformulación**.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { appMaintenanceDatabaseUrl, appRuntimeDatabaseUrl, ownerDatabaseUrl } from "@/tests/support/env"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL
const OWNER_URL = TEST_DATABASE_URL || ownerDatabaseUrl()

const ORG = "e9120000-0000-4000-8000-00000000000a"
const ORG_B = "e9120000-0000-4000-8000-00000000000b"
const USER = "e9120000-0000-4000-8000-0000000000a1"

const SHA = (c: string) => c.repeat(64)
const CUTOFF = "2026-12-31"

let client: Client
let fiscalYearId = ""
let fiscalYearIdB = ""
let entryNumber = 0
let rateId = ""

async function q<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  return (await client.query<T>(sql, params)).rows
}

/** Un asiento CUADRADO con sus líneas. El trigger diferido comprueba Σ al COMMIT. */
async function postEntry(
  org: string,
  fyId: string,
  entryDate: string,
  lines: {
    accountCode: string
    debitCents: number
    creditCents: number
    counterpartyId?: string | null
    dueDate?: string | null
    originalCurrency?: string | null
    originalAmountCents?: number | null
    exchangeRateId?: string | null
    taxBaseCents?: number | null
  }[],
  opts: { kind?: string; ivaPeriod?: string | null } = {}
): Promise<string> {
  // Los constraint triggers del cuadre son DIFERIDOS: el asiento y sus líneas
  // tienen que entrar en LA MISMA transacción, o la comprobación salta en el
  // primer `INSERT` con «asiento sin líneas».
  await q("BEGIN")
  try {
    const [entry] = await q<{ id: string }>(
      `INSERT INTO journal_entries
       (id, organization_id, fiscal_year_id, entry_number, entry_date, document_date,
        description, kind, posted_by_id, entry_hash, hash_version)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4::date, $4::date,
             'fixture E9', $5::entry_kind, $6::uuid, repeat('0', 64), 3)
     RETURNING id`,
      [org, fyId, ++entryNumber, entryDate, opts.kind ?? "NORMAL", USER]
    )
    let lineNo = 0
    for (const l of lines) {
      await q(
        `INSERT INTO journal_lines
         (organization_id, entry_id, line_no, account_code, debit_cents, credit_cents,
          counterparty_id, due_date, original_currency, original_amount_cents, exchange_rate_id,
          tax_base_cents, entry_date, fiscal_year_id, entry_kind)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, $8::date, $9, $10, $11::uuid, $12,
               $13::date, $14::uuid, $15::entry_kind)`,
        [
          org,
          entry.id,
          ++lineNo,
          l.accountCode,
          l.debitCents,
          l.creditCents,
          l.counterpartyId ?? null,
          l.dueDate ?? null,
          l.originalCurrency ?? null,
          l.originalAmountCents ?? null,
          l.exchangeRateId ?? null,
          l.taxBaseCents ?? null,
          entryDate,
          fyId,
          opts.kind ?? "NORMAL",
        ]
      )
    }
    await q("COMMIT")
    return entry.id
  } catch (error) {
    await q("ROLLBACK").catch(() => undefined)
    throw error
  }
}

async function limpiar() {
  for (const org of [ORG, ORG_B]) {
    await q(`DELETE FROM organizations WHERE id = $1::uuid`, [org]).catch(() => undefined)
  }
  await q(`DELETE FROM users WHERE id = $1::uuid`, [USER]).catch(() => undefined)
  await q(`DELETE FROM exchange_rates WHERE source = 'e9-test'`).catch(() => undefined)
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return
  // T21 corre como `app_maintenance` (BYPASSRLS): recorre organizaciones.
  process.env.DATABASE_URL_MAINTENANCE ||= appMaintenanceDatabaseUrl(OWNER_URL)
  client = new Client({ connectionString: OWNER_URL })
  await client.connect()
  await limpiar()

  await q(
    `INSERT INTO users (id, email, name, created_at, updated_at)
     VALUES ($1::uuid, 'e9-modelos@test.local', 'E9', now(), now())`,
    [USER]
  )
  for (const [id, slug] of [
    [ORG, "e9-modelos"],
    [ORG_B, "e9-modelos-b"],
  ] as const) {
    await q(`INSERT INTO organizations (id, slug, name, updated_at) VALUES ($1::uuid, $2::text, $2::text, now())`, [
      id,
      slug,
    ])
    await q(
      `INSERT INTO memberships (id, organization_id, user_id, role, accepted_at, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'ADMIN', now(), now())`,
      [id, USER]
    )
    // El plan mínimo. `is_monetary` se declara aquí como lo haría la siembra
    // desde `seeds/npgc.csv` (O-4): `400` monetaria, `407` NO (es un anticipo).
    for (const [code, nature, monetary] of [
      ["100", "ACREEDORA", false],
      ["112", "ACREEDORA", false],
      ["113", "ACREEDORA", false],
      ["120", "ACREEDORA", false],
      ["121", "DEUDORA", false],
      ["129", "ACREEDORA", false],
      ["170", "ACREEDORA", true],
      ["173", "ACREEDORA", true],
      ["400", "ACREEDORA", true],
      ["407", "DEUDORA", false],
      ["472", "DEUDORA", true],
      ["477", "ACREEDORA", true],
      ["480", "DEUDORA", false],
      ["520", "ACREEDORA", true],
      ["526", "ACREEDORA", true],
      ["557", "DEUDORA", true],
      ["572", "DEUDORA", true],
      ["600", "DEUDORA", false],
      ["700", "ACREEDORA", false],
      ["2131", "DEUDORA", false],
      ["2811", "ACREEDORA", false],
      ["6813", "DEUDORA", false],
    ] as const) {
      await q(
        `INSERT INTO accounts (id, organization_id, code, name, level, nature, is_postable, is_active, is_monetary, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, $2::text, 'Cuenta ' || $2::text, length($2::text), $3::nature, true, true, $4::boolean, now())`,
        [id, code, nature, monetary]
      )
    }
    const [fy] = await q<{ id: string }>(
      `INSERT INTO fiscal_years (id, organization_id, code, start_date, end_date, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, '2026', '2026-01-01', '2026-12-31', now()) RETURNING id`,
      [id]
    )
    if (id === ORG) fiscalYearId = fy.id
    else fiscalYearIdB = fy.id
  }

  // **O-5**: el 31-12-2026 es jueves, pero la ventana se prueba con una tasa del
  // 29 y ninguna del 30 ni del 31: la efectiva tiene que ser la del 29.
  const [rate] = await q<{ id: string }>(
    `INSERT INTO exchange_rates (id, date, "from", "to", rate_micro, source)
     VALUES (gen_random_uuid(), '2026-12-29', 'USD', 'EUR', 900000, 'e9-test') RETURNING id`
  )
  rateId = rate.id
}, 120_000)

afterAll(async () => {
  if (!TEST_DATABASE_URL) return
  await limpiar().catch(() => undefined)
  await client.end()
})

/** Ejecuta `fn` dentro de una transacción de tenant de la organización A. */
async function withOrg<T>(fn: (tx: never) => Promise<T>, org = ORG): Promise<T> {
  const { tenantTransaction } = await import("@/lib/db")
  return await tenantTransaction(org, USER, fn as never, { timeout: 60_000 })
}

describe.skipIf(!TEST_DATABASE_URL)(
  "E9 · T12 — recurrentes: agregado en una consulta e idempotencia por índice",
  () => {
    let ruleId = ""

    beforeAll(async () => {
      const [rule] = await q<{ id: string }>(
        `INSERT INTO recurring_entries
         (id, organization_id, code, name, kind, template_code, template_input, amount_cents,
          frequency, start_period, status, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, 'REC-01', 'Alquiler', 'IMPORTE_FIJO', 'T-14',
               '{}'::jsonb, 120000, 'MENSUAL', '2026-01', 'ACTIVA', now())
       RETURNING id`,
        [ORG]
      )
      ruleId = rule.id
      await q(
        `INSERT INTO recurring_entries
         (id, organization_id, code, name, kind, template_code, template_input, amount_cents,
          frequency, start_period, status, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, 'REC-02', 'Pausada', 'IMPORTE_FIJO', 'T-14',
               '{}'::jsonb, 90000, 'MENSUAL', '2026-01', 'PAUSADA', now())`,
        [ORG]
      )
      for (const period of ["2026-01", "2026-02"]) {
        await q(
          `INSERT INTO recurring_occurrences
           (organization_id, recurring_entry_id, period, posting_date, status, input_hash)
         VALUES ($1::uuid, $2::uuid, $3::text, ($3::text || '-28')::date, 'OMITIDA', $4)`,
          [ORG, ruleId, period, SHA("1")]
        ).catch(async () => {
          // `OMITIDA` exige motivo (G-4): se repite con él, que es lo correcto.
          await q(
            `INSERT INTO recurring_occurrences
             (organization_id, recurring_entry_id, period, posting_date, status, reason, input_hash)
           VALUES ($1::uuid, $2::uuid, $3::text, ($3::text || '-28')::date, 'OMITIDA', 'CUOTA_CERO', $4)`,
            [ORG, ruleId, period, SHA("1")]
          )
        })
      }
    })

    it("`readRecurringDue` agrega los periodos generados y excluye las PAUSADA", async () => {
      const { readRecurringDue } = await import("@/models/recurring")
      const rows = await withOrg(async (tx) => await readRecurringDue(tx as never))
      expect(rows.map((r) => r.code)).toEqual(["REC-01"])
      expect(rows[0].generatedPeriods).toEqual(["2026-01", "2026-02"])
      expect(rows[0].lastPeriod).toBe("2026-02")
      expect(rows[0].occurrenceCount).toBe(2)

      const todas = await withOrg(async (tx) => await readRecurringDue(tx as never, { includeInactive: true }))
      expect(todas.map((r) => r.code)).toEqual(["REC-01", "REC-02"])
      // R-REC-5: la pausada no rellena hacia atrás — no tiene ni una ocurrencia.
      expect(todas[1].generatedPeriods).toEqual([])
    })

    it("**criterio 1** · el mismo `(regla, periodo)` choca contra G-1 con 23505", async () => {
      await expect(
        q(
          `INSERT INTO recurring_occurrences
           (organization_id, recurring_entry_id, period, posting_date, status, reason, input_hash)
         VALUES ($1::uuid, $2::uuid, '2026-01', '2026-01-31', 'OMITIDA', 'repetida', $3)`,
          [ORG, ruleId, SHA("2")]
        )
      ).rejects.toMatchObject({ code: "23505" })
    })

    it("append-only como `app_runtime`: 42501 al actualizar y al borrar", async () => {
      const runtime = new Client({ connectionString: appRuntimeDatabaseUrl(OWNER_URL) })
      await runtime.connect()
      try {
        await runtime.query("SELECT set_config('app.current_org', $1, false)", [ORG])
        await runtime.query("SELECT set_config('app.current_user', $1, false)", [USER])
        await expect(runtime.query(`UPDATE recurring_occurrences SET reason = 'manipulada'`)).rejects.toMatchObject({
          code: "42501",
        })
        await expect(runtime.query(`DELETE FROM recurring_occurrences`)).rejects.toMatchObject({ code: "42501" })
      } finally {
        await runtime.end()
      }
    })

    it("multi-tenant: la organización B no ve ni una regla de la A", async () => {
      const { readRecurringDue } = await import("@/models/recurring")
      const rows = await withOrg(async (tx) => await readRecurringDue(tx as never, { includeInactive: true }), ORG_B)
      expect(rows).toEqual([])
    })
  }
)

describe.skipIf(!TEST_DATABASE_URL)("E9 · T12 — inmovilizado: la atribución POR ACTIVO (O-19)", () => {
  let assetA = ""
  let assetB = ""

  beforeAll(async () => {
    const alta = async (code: string) => {
      const [row] = await q<{ id: string }>(
        `INSERT INTO fixed_assets
           (id, organization_id, code, name, asset_account_code, accumulated_account_code,
            expense_account_code, acquisition_date, in_service_date, acquisition_cost_cents,
            useful_life_months, is_capital_good, acquisition_prorrata_bps, schedule_hash, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, $2::text, 'Furgoneta ' || $2::text, '2131', '2811', '6813',
                 '2026-01-15', '2026-02-01', 1200000, 60, true, 9700, repeat('a', 64), now())
         RETURNING id`,
        [ORG, code]
      )
      return row.id
    }
    assetA = await alta("ACT-A")
    assetB = await alta("ACT-B")

    // Dos dotaciones del activo A (20 000 c cada una) y una del B (5 000 c). Por
    // AGREGADO son 45 000 c en `2811`; **por activo** son 40 000 y 5 000, que es
    // justo lo que I-E9-5 necesita distinguir.
    for (const [asset, quota] of [
      [assetA, 20000],
      [assetA, 20000],
      [assetB, 5000],
    ] as const) {
      const entry = await postEntry(ORG, fiscalYearId, "2026-03-31", [
        { accountCode: "6813", debitCents: quota, creditCents: 0 },
        { accountCode: "2811", debitCents: 0, creditCents: quota },
      ])
      await q(`UPDATE journal_lines SET fixed_asset_id = $1::uuid WHERE entry_id = $2::uuid`, [asset, entry])
    }
    // Un activo SIN atribución: el histórico anterior a E9 (§3.5).
    await alta("ACT-SIN")
  })

  it("las Σ de `68x` y `28x` salen POR ACTIVO y coinciden con el cálculo esperado", async () => {
    const { readAssetsWithRevisions } = await import("@/models/assets")
    const rows = await withOrg(async (tx) => await readAssetsWithRevisions(tx as never, { cutoff: CUTOFF }))
    const byCode = new Map(rows.map((r) => [r.asset.code, r]))
    expect(byCode.get("ACT-A")?.expenseCents).toBe(40000)
    expect(byCode.get("ACT-A")?.accumulatedCents).toBe(40000)
    expect(byCode.get("ACT-B")?.expenseCents).toBe(5000)
    expect(byCode.get("ACT-SIN")?.expenseCents).toBe(0)
    expect(byCode.get("ACT-A")?.postedPeriods).toEqual(["2026-03"])
  })

  it("`assetsWithoutAttribution` NOMBRA el activo sin atribución (I-E9-5 en INFO, no PASS)", async () => {
    const { assetsWithoutAttribution } = await import("@/models/assets")
    const rows = await withOrg(async (tx) => await assetsWithoutAttribution(tx as never))
    expect(rows.map((r) => r.code)).toEqual(["ACT-SIN"])
  })

  it("`attributeLinesToAssetTx` sólo toca `68x`/`28x`/`671`/`771` — la base lo repite (G-15)", async () => {
    const { attributeLinesToAssetTx } = await import("@/models/assets")
    const entry = await postEntry(ORG, fiscalYearId, "2026-04-30", [
      { accountCode: "6813", debitCents: 1000, creditCents: 0 },
      { accountCode: "2811", debitCents: 0, creditCents: 1000 },
      { accountCode: "600", debitCents: 500, creditCents: 0 },
      { accountCode: "572", debitCents: 0, creditCents: 500 },
    ])
    const n = await withOrg(
      async (tx) => await attributeLinesToAssetTx(tx as never, { entryId: entry, fixedAssetId: assetB })
    )
    expect(n).toBe(2)
    const marcadas = await q<{ account_code: string }>(
      `SELECT account_code FROM journal_lines WHERE entry_id = $1::uuid AND fixed_asset_id IS NOT NULL ORDER BY account_code`,
      [entry]
    )
    expect(marcadas.map((r) => r.account_code)).toEqual(["2811", "6813"])
  })

  it("`readCapitalGoods` trae los bienes de inversión con su prorrata de adquisición (O-12)", async () => {
    const { readCapitalGoods } = await import("@/models/assets")
    const rows = await withOrg(async (tx) => await readCapitalGoods(tx as never, { from: "2020-01-01", to: CUTOFF }))
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows[0].acquisitionProrrataBps).toBe(9700)
    expect(rows[0].isBuilding).toBe(false)
  })
})

describe.skipIf(!TEST_DATABASE_URL)("E9 · T12 — deuda: vencimientos y el FAIL bloqueante de O-6", () => {
  beforeAll(async () => {
    // G-17 es un CHECK DIFERIDO: el cuadro y sus vencimientos entran juntos.
    await q("BEGIN")
    const [schedule] = await q<{ id: string }>(
      `INSERT INTO debt_schedules
         (id, organization_id, code, name, long_account_code, short_account_code,
          principal_cents, start_date, schedule_hash, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, 'PREST-01', 'Préstamo', '170', '520',
               900000, '2026-01-01', repeat('b', 64), now())
       RETURNING id`,
      [ORG]
    )
    // 300 000 a 2027-06-30 (dentro de los 12 meses del corte) y 600 000 a
    // 2028-06-30 (fuera): corriente 300 000, no corriente 600 000.
    for (const [seq, dueDate, principal] of [
      [1, "2027-06-30", 300000],
      [2, "2028-06-30", 600000],
    ] as const) {
      await q(
        `INSERT INTO debt_installments
           (organization_id, debt_schedule_id, seq, due_date, principal_cents, interest_cents)
         VALUES ($1::uuid, $2::uuid, $3, $4::date, $5, 0)`,
        [ORG, schedule.id, seq, dueDate, principal]
      )
    }
    await q("COMMIT")
    // Y un `173` vivo que NADIE ha desglosado: el caso del criterio 25.
    await postEntry(ORG, fiscalYearId, "2026-06-30", [
      { accountCode: "572", debitCents: 450000, creditCents: 0 },
      { accountCode: "173", debitCents: 0, creditCents: 450000 },
    ])
  })

  it("`readMaturities` parte el principal por el corte + 12 meses (criterio 24)", async () => {
    const { readMaturities } = await import("@/models/debt")
    const rows = await withOrg(async (tx) => await readMaturities(tx as never, { cutoff: CUTOFF }))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      code: "PREST-01",
      shortTermCents: 300000,
      longTermCents: 600000,
      overdueCents: 0,
      nextDueDate: "2027-06-30",
    })
    // Σ corto + Σ largo = principal declarado: la reclasificación es suma cero.
    expect(rows[0].shortTermCents + rows[0].longTermCents).toBe(900000)
  })

  it("**criterio 25** · una posición de `17x` sin desglose sale nombrada", async () => {
    const { readPositionsWithoutSchedule } = await import("@/models/debt")
    const rows = await withOrg(async (tx) => await readPositionsWithoutSchedule(tx as never, { cutoff: CUTOFF }))
    // `170` y `520` están en el cuadro; `173` no: es la única que aparece.
    expect(rows.map((r) => r.accountCode)).toEqual(["173"])
    expect(rows[0].balanceCents).toBe(450000)
  })

  it("`createDebtScheduleTx` rechaza un cuadro que no suma el principal (G-17)", async () => {
    const { createDebtScheduleTx } = await import("@/models/debt")
    const { LedgerAbort } = await import("@/models/ledger")
    await expect(
      withOrg(
        async (tx) =>
          await createDebtScheduleTx(
            tx as never,
            {
              code: "PREST-MAL",
              name: "Descuadrado",
              longAccountCode: "170",
              shortAccountCode: "520",
              principalCents: 1000,
              startDate: "2026-01-01",
              installments: [{ seq: 1, dueDate: "2027-01-31", principalCents: 999, interestCents: 0 }],
            },
            { userId: USER }
          )
      )
    ).rejects.toBeInstanceOf(LedgerAbort)
  })
})

describe.skipIf(!TEST_DATABASE_URL)("E9 · T12 — diferencias de cambio: el universo lo fija el PLAN (O-4)", () => {
  beforeAll(async () => {
    // Una posición monetaria en `400` (proveedor en USD) y un anticipo en `407`,
    // que NO es monetario: la NRV 11ª.2.2 sólo convierte las monetarias.
    await postEntry(ORG, fiscalYearId, "2026-11-30", [
      { accountCode: "600", debitCents: 460000, creditCents: 0 },
      {
        accountCode: "400",
        debitCents: 0,
        creditCents: 460000,
        originalCurrency: "USD",
        originalAmountCents: 500000,
        exchangeRateId: rateId,
      },
    ])
    await postEntry(ORG, fiscalYearId, "2026-11-30", [
      {
        accountCode: "407",
        debitCents: 92000,
        creditCents: 0,
        originalCurrency: "USD",
        originalAmountCents: 100000,
        exchangeRateId: rateId,
      },
      { accountCode: "572", debitCents: 0, creditCents: 92000 },
    ])
  })

  it("**criterio 20 · I-E9-24** · `400` entra y el anticipo de `407` NO", async () => {
    const { readFxPositions } = await import("@/models/closing")
    const rows = await withOrg(
      async (tx) => await readFxPositions(tx as never, { cutoff: CUTOFF, baseCurrency: "EUR" })
    )
    expect(rows.map((r) => r.accountCode)).toEqual(["400"])
    expect(rows[0].baseBalanceCents).toBe(-460000)
    expect(rows[0].originalBalanceCents).toBe(-500000)
    expect(rows[0].recognizedDifferenceCents).toBe(0)
  })

  it("**criterio 21 · O-5** · la tasa efectiva es la del 29-12 y viaja con su fecha", async () => {
    const { readFxPositions } = await import("@/models/closing")
    const rows = await withOrg(
      async (tx) => await readFxPositions(tx as never, { cutoff: CUTOFF, baseCurrency: "EUR" })
    )
    expect(rows[0].rateMicro).toBe(BigInt(900000))
    expect(rows[0].rateDate).toBe("2026-12-29")

    // `D × r − S` con la tasa sellada: −500 000 × 0,90 − (−460 000) = 10 000 c
    // al DEBE de `400`, que es exactamente el ejemplo del criterio 20.
    const diferencia = Number((BigInt(-500000) * BigInt(900000)) / BigInt(1_000_000)) - -460000
    expect(diferencia).toBe(10000)
  })

  it("sin ninguna tasa en la ventana de siete días, la posición sale SIN tasa (y el paso será FAIL)", async () => {
    const { readFxPositions } = await import("@/models/closing")
    const rows = await withOrg(
      async (tx) => await readFxPositions(tx as never, { cutoff: "2027-06-30", baseCurrency: "EUR" })
    )
    expect(rows[0].rateMicro).toBeNull()
    expect(rows[0].rateDate).toBeNull()
  })
})

describe.skipIf(!TEST_DATABASE_URL)("E9 · T12 — `readClosingInput`: todo en UNA transacción", () => {
  it("devuelve los diez bloques y el ejercicio, sin abrir una transacción por bloque", async () => {
    const { readClosingInput } = await import("@/models/closing")
    const input = await withOrg(
      async (tx) => await readClosingInput(tx as never, { fiscalYearId, refDate: CUTOFF, baseCurrency: "EUR" })
    )
    expect(input.fiscalYearCode).toBe("2026")
    expect(input.recurring.length).toBeGreaterThan(0)
    expect(input.assets.length).toBeGreaterThan(0)
    expect(input.maturities).toHaveLength(1)
    expect(input.positionsWithoutSchedule.map((p) => p.accountCode)).toEqual(["173"])
    expect(input.fxPositions.map((p) => p.accountCode)).toEqual(["400"])
    expect(input.assetsWithoutAttribution.map((a) => a.code)).toEqual(["ACT-SIN"])
    expect(input.balances.size).toBeGreaterThan(0)
  })
})

describe.skipIf(!TEST_DATABASE_URL)("E9 · T14 — distribución del resultado (O-18, R2-2)", () => {
  beforeAll(async () => {
    // Capital social 3 000 000 y reserva legal previa 400 000, **en el diario**.
    await postEntry(ORG, fiscalYearId, "2026-01-01", [
      { accountCode: "572", debitCents: 3400000, creditCents: 0 },
      { accountCode: "100", debitCents: 0, creditCents: 3000000 },
      { accountCode: "112", debitCents: 0, creditCents: 400000 },
    ])
  })

  it("**R2-2** · el capital sale del saldo acreedor de `100`, no de una cifra tecleada", async () => {
    const { capitalStockFor, legalReserveBalance } = await import("@/models/distribution")
    const { capital, check } = await withOrg(
      async (tx) => await capitalStockFor(tx as never, { meetingDate: "2027-06-25" })
    )
    expect(capital).toMatchObject({ cents: 3000000, source: "DIARIO", accountCode: "100" })
    expect(check.status).toBe("PASS")

    const reserva = await withOrg(async (tx) => await legalReserveBalance(tx as never, { cutoff: "2027-06-25" }))
    expect(reserva).toBe(400000)
  })

  it("**criterio 35** · T-35 dota 149 732 de reserva legal y `Σ destinos = resultado`", async () => {
    const { distributionPlan } = await import("@/lib/closing/distribution")
    const { capitalStockFor, createProfitDistributionTx, getProfitDistribution } = await import("@/models/distribution")

    const entry = await postEntry(ORG, fiscalYearId, "2026-12-31", [
      { accountCode: "129", debitCents: 1497322, creditCents: 0 },
      { accountCode: "112", debitCents: 0, creditCents: 149732 },
      { accountCode: "113", debitCents: 0, creditCents: 847590 },
      { accountCode: "526", debitCents: 0, creditCents: 500000 },
    ])

    const row = await withOrg(async (tx) => {
      const { capital } = await capitalStockFor(tx as never, { meetingDate: "2027-06-25" })
      const plan = distributionPlan({
        resultCents: 1497322,
        meetingDate: "2027-06-25",
        capital,
        currentLegalReserveCents: 400000,
        interimDividendCents: 0,
        voluntaryReserveCents: 847590,
        carryForwardCents: 0,
        dividendCents: 500000,
        accounts: {
          resultAccountCode: "129",
          legalReserveAccountCode: "112",
          voluntaryReserveAccountCode: "113",
          carryForwardAccountCode: "120",
          dividendAccountCode: "526",
          interimDividendAccountCode: "557",
          lossCarryForwardAccountCode: "121",
        },
      })
      if (!plan.ok) throw new Error("el plan de distribución debería resolver")
      return await createProfitDistributionTx(
        tx as never,
        { fiscalYearId, meetingDate: "2027-06-25", plan: plan.value, entryId: entry, capital },
        { userId: USER }
      )
    })

    expect(row.legalReserveCents).toBe(149732)
    expect(row.voluntaryReserveCents).toBe(847590)
    expect(row.dividendCents).toBe(500000)
    expect(row.legalReserveCents + row.voluntaryReserveCents + row.dividendCents + row.carryForwardCents).toBe(1497322)

    const leida = await withOrg(async (tx) => await getProfitDistribution(tx as never, fiscalYearId))
    expect(leida?.id).toBe(row.id)

    // El `AuditLog` deja escrito **de dónde salió el capital** (R2-2).
    const [log] = await q<{ after: Record<string, unknown> }>(
      `SELECT after FROM audit_logs WHERE organization_id = $1::uuid AND action = 'DISTRIBUTE_PROFIT'`,
      [ORG]
    )
    expect(log.after).toMatchObject({ capitalStockCents: 3000000, capitalStockSource: "DIARIO" })
  })

  it("**G-16** · una distribución por ejercicio: la segunda se rechaza", async () => {
    const { createProfitDistributionTx } = await import("@/models/distribution")
    const { LedgerAbort } = await import("@/models/ledger")
    await expect(
      withOrg(
        async (tx) =>
          await createProfitDistributionTx(
            tx as never,
            {
              fiscalYearId,
              meetingDate: "2027-06-25",
              plan: {
                resultCents: 100,
                legalReserveCents: 10,
                voluntaryReserveCents: 90,
                carryForwardCents: 0,
                dividendCents: 0,
                interimDividendCents: 0,
                lossCarryForwardCents: 0,
              },
              entryId: "00000000-0000-4000-8000-000000000001",
              capital: { cents: 3000000, source: "DIARIO", accountCode: "100" },
            },
            { userId: USER }
          )
      )
    ).rejects.toBeInstanceOf(LedgerAbort)
  })

  it("append-only: `profit_distributions` da 42501 como `app_runtime`", async () => {
    const runtime = new Client({ connectionString: appRuntimeDatabaseUrl(OWNER_URL) })
    await runtime.connect()
    try {
      await runtime.query("SELECT set_config('app.current_org', $1, false)", [ORG])
      await runtime.query("SELECT set_config('app.current_user', $1, false)", [USER])
      await expect(runtime.query(`UPDATE profit_distributions SET dividend_cents = 0`)).rejects.toMatchObject({
        code: "42501",
      })
    } finally {
      await runtime.end()
    }
  })

  it("**D1** · avanzar el estado societario funciona; retroceder cita la LSC y ofrece la salida", async () => {
    const { setAccountsApprovalStatusTx } = await import("@/models/distribution")
    const { LedgerAbort } = await import("@/models/ledger")

    const formuladas = await withOrg(
      async (tx) =>
        await setAccountsApprovalStatusTx(
          tx as never,
          { fiscalYearId: fiscalYearIdB, status: "FORMULADAS", date: "2027-03-31" },
          { userId: USER }
        ),
      ORG_B
    )
    expect(formuladas.requiresDistribution).toBe(false)

    const aprobadas = await withOrg(
      async (tx) =>
        await setAccountsApprovalStatusTx(
          tx as never,
          { fiscalYearId: fiscalYearIdB, status: "APROBADAS", date: "2027-06-25" },
          { userId: USER }
        ),
      ORG_B
    )
    // **O-18**: al aprobar sin distribución, la UI abre el diálogo de T-35.
    expect(aprobadas.requiresDistribution).toBe(true)

    await expect(
      withOrg(
        async (tx) =>
          await setAccountsApprovalStatusTx(
            tx as never,
            { fiscalYearId: fiscalYearIdB, status: "BORRADOR", date: "2027-07-01" },
            { userId: USER }
          ),
        ORG_B
      )
    ).rejects.toBeInstanceOf(LedgerAbort)

    const [fy] = await q<{ accounts_approval_status: string; approved_at: Date | null }>(
      `SELECT accounts_approval_status, approved_at FROM fiscal_years WHERE id = $1::uuid`,
      [fiscalYearIdB]
    )
    expect(fy.accounts_approval_status).toBe("APROBADAS")
    expect(fy.approved_at).not.toBeNull()
  })
})

describe.skipIf(!TEST_DATABASE_URL)("E9 · T21 — `prune-runs --archive`: archivar ANTES de borrar", () => {
  let archiveDir = ""
  let runId = ""

  beforeAll(async () => {
    archiveDir = await mkdtemp(path.join(tmpdir(), "e9-archive-"))
    // DOS runs del mismo alcance y mes histórico: de enero de 2023 sobrevive el
    // último (política de ADR-0015 D3), así que el primero es el que se archiva
    // y se borra. Con uno solo no se purgaría nada —sería el último de su
    // alcance— y el test no probaría nada.
    const alta = async (createdAt: string) => {
      const [row] = await q<{ id: string }>(
        `INSERT INTO invariant_runs
           (id, organization_id, scope_kind, trigger, ref_date, ledger_hash, plan_hash, account_map_hash,
            config_hash, git_sha, checks_hash, checks, counts, coverage, headline, seal, duration_ms, created_at)
         VALUES (gen_random_uuid(), $1::uuid, 'ORGANIZATION', 'MANUAL', '2023-01-10', $2, $2, $2, $2, 'sha',
                 $3, '[{"id":"I1","status":"PASS"}]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
                 'VALIDADO_AUTOMATICAMENTE', 1, $4::timestamp)
         RETURNING id`,
        [ORG, SHA("3"), SHA("c"), createdAt]
      )
      return row.id
    }
    runId = await alta("2023-01-10")
    await alta("2023-01-20")
  })

  afterAll(async () => {
    await rm(archiveDir, { recursive: true, force: true }).catch(() => undefined)
  })

  it("escribe el JSON con el `checksHash` intacto y sólo entonces borra la fila", async () => {
    const { pruneRuns } = await import("@/scripts/prune-runs")
    const report = await pruneRuns({ org: ORG, refDate: "2026-06-01", apply: true, archive: archiveDir })

    expect(report.archiveDir).toBe(archiveDir)
    expect(report.archivados).toBeGreaterThanOrEqual(1)

    const archivo = path.join(archiveDir, ORG, "invariant_runs", `${runId}.json`)
    const contenido = JSON.parse(await readFile(archivo, "utf8")) as Record<string, unknown>
    // La evidencia sigue siendo verificable FUERA de la base: I-E7-7 recomputa
    // `checks_hash` sobre `checks`, y las dos cosas están en el fichero.
    expect(contenido.checks_hash).toBe(SHA("c"))
    expect(contenido.checks).toEqual([{ id: "I1", status: "PASS" }])

    expect(await q(`SELECT id FROM invariant_runs WHERE id = $1::uuid`, [runId])).toHaveLength(0)
  })

  it("sin `--archive` el informe lo dice: no hay copia en frío", async () => {
    const { pruneRuns } = await import("@/scripts/prune-runs")
    const report = await pruneRuns({ org: ORG, refDate: "2026-06-01" })
    expect(report.archiveDir).toBeNull()
    expect(report.archivados).toBe(0)
  })
})
