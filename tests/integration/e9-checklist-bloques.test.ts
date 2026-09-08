/**
 * E9 · T23 — Los cuatro bloques del checklist que C1 dejó llegando **vacíos**,
 * contra Postgres de verdad.
 *
 * Un paso que se alimenta de una lista vacía dice siempre lo mismo, y lo que
 * dice es mentira: «todas las cuentas conciliadas» sin haber mirado ninguna,
 * «amortización al día» sin cuadro, «retenciones liquidadas» sin `4751`.
 * Aquí se comprueba lo contrario, y sólo se puede comprobar contra la base:
 *
 *  · **Conciliación bancaria (E7).** Con anclaje, extracto que cubre el año y
 *    los cuatro movimientos conciliados 1:1, la cuenta lleva el badge
 *    `✓ validado contra fuente` y el paso sale **PASS**. Un apunte de `572`
 *    posterior sin línea de extracto retira el badge y el paso sale **WARN**
 *    nombrando el pendiente: es la MISMA derivación que I-E7-1 y el panel.
 *  · **Amortización.** El cuadro se recalcula (§3.6, no se almacena) y se cruza
 *    con `journal_lines.fixed_asset_id` (O-19): doce cuotas dotadas → PASS; un
 *    segundo activo con once meses sin dotar → WARN nombrándolo. Un activo
 *    **sin atribución** no cuenta como pendiente: sale por `INFO` (I-E9-5).
 *  · **Retenciones (D12 · O-27).** El 4T abonado y no ingresado a 31-12 **no**
 *    es un incumplimiento —se ingresa el 20 de enero—; el 2T sí. El saldo por
 *    trimestre a secas confundía el cargo de abril con el abono de marzo.
 *  · **CECOs (E5).** Una regla vigente sin `AllocationRun` sellado en el periodo
 *    deja el CECO sin liquidar, y el paso lo nombra regla a regla.
 *
 * En los cuatro, la evidencia dice **cuánto se ha mirado** y `query`, de dónde
 * sale el dato: un PASS sin eso es un PASS por vacuidad.
 */

import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { ownerDatabaseUrl } from "@/tests/support/env"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL
const OWNER_URL = TEST_DATABASE_URL || ownerDatabaseUrl()

const ORG = "e923c400-0000-4000-8000-00000000000a"
const USER = "e923c400-0000-4000-8000-0000000000a1"
const CUTOFF = "2026-12-31"

let client: Client
let fiscalYearId = ""
let bankAccountId = ""
let entryNumber = 0

async function q<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  return (await client.query<T>(sql, params)).rows
}

/** Un asiento CUADRADO con sus líneas: los triggers del cuadre son DIFERIDOS. */
async function postEntry(
  entryDate: string,
  lines: { accountCode: string; debitCents: number; creditCents: number; fixedAssetId?: string | null }[]
): Promise<string> {
  await q("BEGIN")
  try {
    const [entry] = await q<{ id: string }>(
      `INSERT INTO journal_entries
       (id, organization_id, fiscal_year_id, entry_number, entry_date, document_date,
        description, kind, posted_by_id, entry_hash, hash_version)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4::date, $4::date,
             'fixture T23', 'NORMAL', $5::uuid, repeat('0', 64), 3)
     RETURNING id`,
      [ORG, fiscalYearId, ++entryNumber, entryDate, USER]
    )
    let lineNo = 0
    for (const l of lines) {
      await q(
        `INSERT INTO journal_lines
         (organization_id, entry_id, line_no, account_code, debit_cents, credit_cents,
          fixed_asset_id, entry_date, fiscal_year_id, entry_kind)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, $8::date, $9::uuid, 'NORMAL')`,
        [ORG, entry.id, ++lineNo, l.accountCode, l.debitCents, l.creditCents, l.fixedAssetId ?? null, entryDate, fiscalYearId]
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
  await q(`DELETE FROM organizations WHERE id = $1::uuid`, [ORG]).catch(() => undefined)
  await q(`DELETE FROM users WHERE id = $1::uuid`, [USER]).catch(() => undefined)
}

async function withOrg<T>(fn: (tx: never) => Promise<T>): Promise<T> {
  const { tenantTransaction } = await import("@/lib/db")
  return await tenantTransaction(ORG, USER, fn as never, { timeout: 60_000 })
}

/** El checklist completo, tal y como lo compone la acción del cierre. */
async function checklist() {
  const { readChecklistInput } = await import("@/models/closing")
  const { closingChecklist } = await import("@/lib/closing/checklist")
  const input = await withOrg(
    async (tx) => await readChecklistInput(tx as never, { fiscalYearId, refDate: CUTOFF, baseCurrency: "EUR" })
  )
  return closingChecklist(input, CUTOFF)
}

const paso = (steps: Awaited<ReturnType<typeof checklist>>, code: string) => {
  const found = steps.find((s) => s.step === code)
  if (!found) throw new Error(`el paso ${code} no está en el catálogo`)
  return found
}

const PLAN: readonly [string, "DEUDORA" | "ACREEDORA", boolean][] = [
  ["213", "DEUDORA", false],
  ["281", "ACREEDORA", false],
  ["47510", "ACREEDORA", true],
  ["47511", "ACREEDORA", true],
  ["4751", "ACREEDORA", true],
  ["570", "DEUDORA", true],
  ["572", "DEUDORA", true],
  ["623", "DEUDORA", false],
  ["681", "DEUDORA", false],
  ["705", "ACREEDORA", false],
]

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return
  client = new Client({ connectionString: OWNER_URL })
  await client.connect()
  await limpiar()

  await q(
    `INSERT INTO users (id, email, name, created_at, updated_at)
     VALUES ($1::uuid, 'e9-t23@test.local', 'T23', now(), now())`,
    [USER]
  )
  await q(`INSERT INTO organizations (id, slug, name, updated_at) VALUES ($1::uuid, 'e9-t23', 'E9 T23 SL', now())`, [ORG])
  await q(
    `INSERT INTO memberships (id, organization_id, user_id, role, accepted_at, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'ADMIN', now(), now())`,
    [ORG, USER]
  )
  for (const [code, nature, monetary] of PLAN) {
    await q(
      `INSERT INTO accounts (id, organization_id, code, name, level, nature, is_postable, is_active, is_monetary, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, $2::text, 'Cuenta ' || $2::text, length($2::text), $3::nature, true, true, $4::boolean, now())`,
      [ORG, code, nature, monetary]
    )
  }
  // **O-27**: `4751` partida por modelo y resuelta por `AccountKey`.
  for (const [key, code] of [
    ["BANCO_DEFAULT", "572"],
    ["IRPF_A_PAGAR_111", "47510"],
    ["IRPF_A_PAGAR_115", "47511"],
  ] as const) {
    await q(
      `INSERT INTO organization_account_maps (id, organization_id, key, account_code, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, $2::account_key, $3::text, now())`,
      [ORG, key, code]
    )
  }
  const [fy] = await q<{ id: string }>(
    `INSERT INTO fiscal_years (id, organization_id, code, start_date, end_date, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, '2026', '2026-01-01', '2026-12-31', now()) RETURNING id`,
    [ORG]
  )
  fiscalYearId = fy.id

  // ── El activo AC-0001 y sus DOCE dotaciones, atribuidas (O-19) ────────────
  const [asset] = await q<{ id: string }>(
    `INSERT INTO fixed_assets
       (id, organization_id, code, name, asset_account_code, accumulated_account_code, expense_account_code,
        acquisition_date, in_service_date, acquisition_cost_cents, residual_value_cents, method,
        useful_life_months, status, schedule_hash, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, 'AC-0001', 'Maquinaria', '213', '281', '681',
             '2026-01-01', '2026-01-01', 120000, 0, 'LINEAL', 12, 'EN_USO', repeat('a', 64), now())
     RETURNING id`,
    [ORG]
  )
  for (let mes = 1; mes <= 12; mes++) {
    const fin = new Date(Date.UTC(2026, mes, 0)).toISOString().slice(0, 10)
    await postEntry(fin, [
      { accountCode: "681", debitCents: 10_000, creditCents: 0, fixedAssetId: asset.id },
      { accountCode: "281", debitCents: 0, creditCents: 10_000, fixedAssetId: asset.id },
    ])
  }

  // ── Los cuatro movimientos de banco, con su retención por modelo ──────────
  await postEntry("2026-01-15", [
    { accountCode: "572", debitCents: 120_000, creditCents: 0 },
    { accountCode: "705", debitCents: 0, creditCents: 120_000 },
  ])
  // 1T: retención practicada (abono a 47510) …
  await postEntry("2026-03-10", [
    { accountCode: "623", debitCents: 100_000, creditCents: 0 },
    { accountCode: "47510", debitCents: 0, creditCents: 15_000 },
    { accountCode: "572", debitCents: 0, creditCents: 85_000 },
  ])
  // … e ingresada en abril: el cargo cae en el trimestre SIGUIENTE al abono.
  await postEntry("2026-04-18", [
    { accountCode: "47510", debitCents: 15_000, creditCents: 0 },
    { accountCode: "572", debitCents: 0, creditCents: 15_000 },
  ])
  // 4T: abonado y NO ingresado a 31-12. Su plazo vence el 20 de enero.
  await postEntry("2026-11-20", [
    { accountCode: "623", debitCents: 50_000, creditCents: 0 },
    { accountCode: "47510", debitCents: 0, creditCents: 7_500 },
    { accountCode: "572", debitCents: 0, creditCents: 42_500 },
  ])

  // ── La cuenta bancaria, su extracto del año y las cuatro conciliaciones ───
  const { createBankAccount, createMatchGroup, importStatement, listStatementLines } = await import("@/models/bank")
  const { account } = await createBankAccount(
    ORG,
    {
      code: "CB-01",
      name: "Cuenta corriente",
      accountCode: "572",
      currency: "EUR",
      reconciledFromDate: "2026-01-01",
      reconciledOpeningBalanceCents: 0,
    },
    { userId: USER }
  )
  bankAccountId = account.id

  const csv = [
    "Fecha;Importe;Concepto",
    "15/01/2026;1200,00;Cobro de cliente",
    "10/03/2026;-850,00;Pago factura profesional",
    "18/04/2026;-150,00;Ingreso modelo 111 1T",
    "20/11/2026;-425,00;Pago factura profesional",
    "",
  ].join("\n")
  await importStatement(
    ORG,
    {
      bankAccountId,
      fileName: "2026.csv",
      bytes: new TextEncoder().encode(csv),
      format: "CSV",
      mapping: {
        delimiter: ";",
        decimal: ",",
        dateFormat: "DD/MM/YYYY",
        signMode: "SIGNED",
        defaultCurrency: "EUR",
        columns: { operationDate: "Fecha", amount: "Importe", description: "Concepto" },
        // H-7: el periodo lo declara el banco, no el primer y el último apunte;
        // sin él, la cadena de I-E7-6b abriría un hueco falso hasta el corte.
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
        openingBalanceCents: 0,
        closingBalanceCents: -22_500,
        declaredLineCount: 4,
      },
    },
    { userId: USER }
  )

  await withOrg(async (tx) => {
    const lineas = await listStatementLines(tx as never, { bankAccountId })
    const apuntes = await q<{ id: string; debit_cents: string; credit_cents: string }>(
      `SELECT id, debit_cents, credit_cents FROM journal_lines
        WHERE organization_id = $1::uuid AND account_code = '572' ORDER BY entry_date`,
      [ORG]
    )
    for (const linea of lineas) {
      const apunte = apuntes.find((a) => Number(a.debit_cents) - Number(a.credit_cents) === linea.amountCents)
      if (!apunte) throw new Error(`sin apunte para la línea de ${linea.amountCents}`)
      await createMatchGroup(
        tx as never,
        { bankAccountId, statementLineIds: [linea.id], journalLineIds: [apunte.id] },
        { userId: USER }
      )
      apuntes.splice(apuntes.indexOf(apunte), 1)
    }
  })
}, 180_000)

afterAll(async () => {
  if (!TEST_DATABASE_URL) return
  const { prisma } = await import("@/lib/db")
  await prisma.$disconnect().catch(() => undefined)
  await limpiar().catch(() => undefined)
  await client.end()
})

describe.skipIf(!TEST_DATABASE_URL)("E9 · T23 — los cuatro bloques con dato real: PASS con evidencia", () => {
  it("los cuatro pasos salen PASS y **dicen cuánto han mirado y de dónde sale**", async () => {
    const steps = await checklist()

    const banco = paso(steps, "CONCILIACION_BANCARIA")
    expect(banco.status).toBe("PASS")
    expect(banco.evidencia).toContain("1 cuenta(s) bancaria(s) miradas al corte 2026-12-31")
    expect(banco.query).toContain("badgeForFigure")

    const amortizacion = paso(steps, "AMORTIZACION_AL_DIA")
    expect(amortizacion.status).toBe("PASS")
    expect(amortizacion.evidencia).toContain("1 activo(s) con atribución y 12 cuota(s)")
    expect(amortizacion.query).toContain("fixed_asset_id")

    const retenciones = paso(steps, "RETENCIONES_LIQUIDADAS")
    expect(retenciones.status).toBe("PASS")
    // El 4T está abonado y sin ingresar, y eso es CORRECTO a 31-12.
    expect(retenciones.evidencia).toContain("2026-Q4 con plazo aún no vencido")
    expect(retenciones.query).toContain("4751")

    const cecos = paso(steps, "LIQUIDACION_CECOS")
    expect(cecos.status).toBe("PASS")
    expect(cecos.evidencia).toContain("0 regla(s) vigente(s)")
  })

  it("ninguno de los cuatro es bloqueante: no cierran el ejercicio por sí solos (§4.8)", async () => {
    const steps = await checklist()
    for (const code of ["CONCILIACION_BANCARIA", "AMORTIZACION_AL_DIA", "RETENCIONES_LIQUIDADAS", "LIQUIDACION_CECOS"]) {
      expect(paso(steps, code).blocking).toBe(false)
    }
  })
})

describe.skipIf(!TEST_DATABASE_URL)("E9 · T23 — el defecto inyectado: cada bloque delata el suyo", () => {
  it("**cuenta 57x sin conciliar**: un apunte de 572 sin línea de extracto retira el badge", async () => {
    await postEntry("2026-12-20", [
      { accountCode: "572", debitCents: 30_000, creditCents: 0 },
      { accountCode: "705", debitCents: 0, creditCents: 30_000 },
    ])
    const banco = paso(await checklist(), "CONCILIACION_BANCARIA")
    expect(banco.status).toBe("WARN")
    expect(banco.evidencia).toContain("CB-01 (572)")
    expect(banco.evidencia).toMatch(/pendiente sin explicar|no cuadra/)
  })

  it("**activo sin dotación**: once meses sin cuota salen nombrados, no en un total", async () => {
    const [otro] = await q<{ id: string }>(
      `INSERT INTO fixed_assets
         (id, organization_id, code, name, asset_account_code, accumulated_account_code, expense_account_code,
          acquisition_date, in_service_date, acquisition_cost_cents, residual_value_cents, method,
          useful_life_months, status, schedule_hash, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, 'AC-0002', 'Furgoneta', '213', '281', '681',
               '2026-01-01', '2026-01-01', 60000, 0, 'LINEAL', 12, 'EN_USO', repeat('b', 64), now())
       RETURNING id`,
      [ORG]
    )
    // Sólo enero dotado: con CERO líneas atribuidas el activo saldría por
    // `assetsWithoutAttribution` y el paso sería INFO, que es otro camino.
    await postEntry("2026-01-31", [
      { accountCode: "681", debitCents: 5_000, creditCents: 0, fixedAssetId: otro.id },
      { accountCode: "281", debitCents: 0, creditCents: 5_000, fixedAssetId: otro.id },
    ])

    const amortizacion = paso(await checklist(), "AMORTIZACION_AL_DIA")
    expect(amortizacion.status).toBe("WARN")
    expect(amortizacion.evidencia).toContain("AC-0002 (11)")
    expect(amortizacion.evidencia).not.toContain("AC-0001 (")
  })

  it("**111 sin liquidar**: el 2T vencido y sin ingresar sale WARN; el 4T sigue sin contar", async () => {
    await postEntry("2026-05-12", [
      { accountCode: "623", debitCents: 60_000, creditCents: 0 },
      { accountCode: "47510", debitCents: 0, creditCents: 9_000 },
      { accountCode: "572", debitCents: 0, creditCents: 51_000 },
    ])
    const retenciones = paso(await checklist(), "RETENCIONES_LIQUIDADAS")
    expect(retenciones.status).toBe("WARN")
    // 7 500 del 4T no vencido fuera: lo pendiente son los 9 000 del 2T.
    expect(retenciones.evidencia).toContain("111: 9000 c abonados en 47510 sin ingresar")
    expect(retenciones.evidencia).toContain("2026-Q2")
  })

  it("**CECO con regla sin run**: una regla vigente sin `AllocationRun` sellado deja el CECO sin liquidar", async () => {
    const [origen] = await q<{ id: string }>(
      `INSERT INTO cost_centers (id, organization_id, code, name, kind, margin_level, is_active, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, 'CC-ADM', 'Administración', 'G_A', 'MC3', true, now())
       RETURNING id`,
      [ORG]
    )
    const [destino] = await q<{ id: string }>(
      `INSERT INTO cost_centers (id, organization_id, code, name, kind, margin_level, is_active, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, 'CC-OPS', 'Operaciones', 'OPERACIONES_INDIRECTAS', 'EBITDA', true, now())
       RETURNING id`,
      [ORG]
    )
    // El cuadre de la regla lo comprueba un trigger DIFERIDO: la regla y sus
    // destinos tienen que entrar en LA MISMA transacción.
    await q("BEGIN")
    const [rule] = await q<{ id: string }>(
      `INSERT INTO allocation_rules
         (id, organization_id, code, name, source_cost_center_id, target_kind, driver, period,
          priority, source_share_bps, zero_base_fallback, valid_from, is_active, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, 'RA-01', 'Reparto de estructura', $2::uuid, 'COST_CENTERS',
               'FIXED_PERCENT', 'MONTH', 10, 10000, 'SKIP_WARN', '2026-01-01', true, now())
       RETURNING id`,
      [ORG, origen.id]
    )
    await q(
      `INSERT INTO allocation_rule_targets
         (id, organization_id, rule_id, cost_center_id, percent_bps, sort_order)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 10000, 1)`,
      [ORG, rule.id, destino.id]
    )
    await q("COMMIT")

    const cecos = paso(await checklist(), "LIQUIDACION_CECOS")
    expect(cecos.status).toBe("WARN")
    expect(cecos.evidencia).toContain("regla RA-01 (CECO CC-ADM): sin run sellado en 2026-01")
    // Los doce meses del ejercicio se exigen, no sólo el primero.
    expect(cecos.evidencia).toContain("12 periodo(s) exigido(s)")
  })
})
