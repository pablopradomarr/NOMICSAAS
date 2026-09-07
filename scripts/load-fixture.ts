/**
 * E3 · T13 — Cargador de los fixtures inmutables en una base de datos real.
 *
 *   npx tsx scripts/load-fixture.ts --org <uuid> --fixture tests/fixtures/ejercicio-completo.json
 *                                    [--user <uuid>] [--out <fichero|directorio>] [--ref-date AAAA-MM-DD]
 *
 * `--ref-date` es «hoy» al validar (I8: `entryDate ≤ refDate`). Por defecto se
 * deriva del PROPIO fichero (`fixtureRefDate`), nunca del reloj: si dependiera
 * del reloj, cargar `ejercicio-completo` —que llega a 2027— daría distinto
 * resultado según el día en que se ejecute.
 *
 * Qué hace, en este orden:
 *   1. Aplica al `Organization` la política del fixture (moneda, variante PGC,
 *      redondeo, prorrata) y siembra el plan NPGC si la organización no lo tiene.
 *   2. Crea los ejercicios (`fiscalYear` + `fiscalYearsExtra`) **abiertos**: los
 *      asientos de cierre del fixture se postean como asientos normales del
 *      ejercicio; cerrarlo es otra operación (`closeFiscalYear`).
 *   3. Postea los 5 / 84 asientos **por `postEntry`** — el mismo camino que la
 *      aplicación, con su validación C-1…C-13, su `FOR UPDATE` y sus triggers.
 *      E4 · T9: `projectCode`/`costCenterCode`/`businessLineCode` se CREAN y se
 *      persisten en la línea (antes se descartaban, D-E3-1).
 *   4. Comprueba el bloque `expected` del fichero contra lo que quedó en la BD
 *      y calcula el `ledgerHash`. Dos cargas del mismo fixture sobre bases
 *      limpias dan el MISMO hash: es lo que hace la carga byte-idéntica.
 *
 * Salida `--out validacion.json` opcional: invariantes + sello de la carga.
 *
 * Código de salida ≠ 0 si algún asiento no entra o si `expected` no cuadra.
 */

import { tenantTransaction } from "@/lib/db"
import type { Cents, EntryDraft, LocalDate } from "@/lib/ledger/types"
import { seedAnalyticsDefaults } from "@/models/analytics"
import { importNpgc } from "@/models/accounts"
import { openFiscalYear } from "@/models/fiscal-years"
import {
  computeLedgerHash,
  getAccountBalances,
  getEntries,
  postEntry,
  runLedgerInvariants,
  type LedgerModelError,
} from "@/models/ledger"
import { fixtureRefDate, loadFixture, readFixture, type FixtureName } from "@/tests/support/fixtures"
import { existsSync, statSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Client } from "pg"
import type { CostCenterKind, MarginLevel } from "@/prisma/client"

export type LoadFixtureOptions = {
  organizationId: string
  fixture: FixtureName
  userId?: string | null
  /** Si el fixture trae un ejercicio ya cerrado, se crea abierto igualmente. */
  seedPlan?: boolean
  /** «Hoy» al validar. Por defecto, `fixtureRefDate(file)`: determinista (#4). */
  refDate?: LocalDate
  /**
   * Auditor 4 — **idempotencia explícita**. Cargar un fixture dos veces sobre la
   * misma organización NO es idempotente por naturaleza: el diario es
   * append-only y la numeración por ejercicio es contigua (I7), así que la
   * segunda carga chocaría — y así debe ser: un script no sobrescribe un diario
   * en silencio. Con `resetOrg` el vaciado es **explícito**, va en UNA
   * transacción (o se borra todo o no se borra nada) y sólo alcanza a esta
   * organización.
   */
  resetOrg?: boolean
}

export type LoadFixtureReport = {
  fixture: FixtureName
  organizationId: string
  entryCount: number
  totalDebitCents: Cents
  totalCreditCents: Cents
  ledgerHash: string
  fiscalYearIds: Record<string, string>
  /** Discrepancias contra el bloque `expected` del fichero. Vacío = correcto. */
  mismatches: string[]
}

/** `tests/fixtures/ejercicio-completo.json` → `ejercicio-completo`. */
export function fixtureNameOf(fixturePath: string): FixtureName {
  const base = path.basename(fixturePath).replace(/\.json$/, "")
  if (base !== "ejercicio-minimo" && base !== "ejercicio-completo") {
    throw new Error(`Fixture desconocido: ${fixturePath} (sólo ejercicio-minimo y ejercicio-completo)`)
  }
  return base
}

const say = (message: string) => console.log(message)

/**
 * Carga el fixture. Reutiliza `tests/support/fixtures.ts` para la parte pura
 * (plan, mapa, tipos, borradores) y sólo añade el IO.
 */
export async function loadFixtureIntoOrg(opts: LoadFixtureOptions): Promise<LoadFixtureReport> {
  const file = readFixture(opts.fixture)
  const loaded = loadFixture(opts.fixture)
  const organizationId = opts.organizationId
  const actor = { userId: opts.userId ?? null }

  if (opts.resetOrg) await resetOrganizationLedger(organizationId, actor.userId ?? undefined)

  // ── 1. Política de la organización + plan de cuentas ───────────────────────
  await tenantTransaction(organizationId, actor.userId ?? undefined, async (tx) => {
    await tx.$executeRaw`
      UPDATE organizations
         SET base_currency = ${file.organization.baseCurrency},
             pgc_variant = ${file.organization.pgcVariant}::pgc_variant,
             tax_rounding_mode = ${file.organization.taxRoundingMode}::tax_rounding_mode,
             prorrata_bps = ${file.organization.prorrataBps},
             redondeo_tolerancia_cents = ${file.organization.redondeoToleranciaCents},
             analytics_required = ${file.organization.analyticsRequired}
       WHERE id = ${organizationId}::uuid`
  })

  const alreadySeeded = await tenantTransaction(organizationId, actor.userId ?? undefined, async (tx) =>
    tx.ledgerAccount.count()
  )
  if (alreadySeeded === 0 && opts.seedPlan !== false) {
    const seeded = await importNpgc(organizationId, file.organization.pgcVariant, {
      actor,
      now: new Date(`${file.fiscalYear.startDate}T00:00:00.000Z`),
      useSubaccounts: file.organization.useSubaccounts,
    })
    say(`· plan ${file.organization.pgcVariant}: ${seeded.created} cuentas`)
  }

  // ── 1b. E4 · T9: dimensiones analíticas del fichero ───────────────────────
  // Antes se descartaban (D-E3-1). Ahora se crean —líneas de negocio, proyectos
  // y CECOs— y cada línea 6/7 se postea con su destino, de modo que C-9 muerde
  // sobre datos reales y la matriz de I4 se puede calcular contra la BD.
  const dimensionIds = await tenantTransaction(organizationId, actor.userId ?? undefined, async (tx) => {
    // La semilla de fábrica (8 CECOs + 8 niveles + LN GENERAL) primero: el
    // fixture puede reutilizar sus códigos y `upsert` no los duplica.
    await seedAnalyticsDefaults(tx, { validFrom: file.fiscalYear.startDate, userId: actor.userId })

    const businessLines = new Map<string, string>()
    for (const bl of file.businessLines ?? []) {
      const row = await tx.businessLine.upsert({
        where: { organizationId_code: { organizationId, code: bl.code } },
        update: { name: bl.name, sortOrder: bl.sortOrder },
        create: { organizationId, code: bl.code, name: bl.name, sortOrder: bl.sortOrder },
      })
      businessLines.set(bl.code, row.id)
    }
    const projects = new Map<string, string>()
    for (const [index, p] of (file.projects ?? []).entries()) {
      const businessLineId = businessLines.get(p.businessLineCode)
      if (!businessLineId) throw new Error(`El proyecto ${p.code} apunta a la línea ${p.businessLineCode}, que el fixture no declara`)
      const row = await tx.project.upsert({
        where: { organizationId_code: { organizationId, code: p.code } },
        update: { name: p.name, businessLineId, sortOrder: index + 1 },
        create: { organizationId, code: p.code, name: p.name, businessLineId, sortOrder: index + 1 },
      })
      projects.set(p.code, row.id)
    }
    const costCenters = new Map<string, string>()
    for (const [index, c] of (file.costCenters ?? []).entries()) {
      const row = await tx.costCenter.upsert({
        where: { organizationId_code: { organizationId, code: c.code } },
        update: { name: c.name },
        create: {
          organizationId,
          code: c.code,
          name: c.name,
          kind: c.kind as CostCenterKind,
          marginLevel: c.marginLevel as MarginLevel,
          allocatable: c.allocatable,
          sortOrder: index + 1,
          isSystem: c.kind === "SIN_ASIGNAR",
          origin: "SEED",
        },
      })
      costCenters.set(c.code, row.id)
    }
    return { businessLines, projects, costCenters }
  })
  say(
    `· analítica: ${dimensionIds.businessLines.size} línea(s) de negocio, ` +
      `${dimensionIds.projects.size} proyecto(s), ${dimensionIds.costCenters.size} CECO(s)`
  )

  /** Ids sintéticos del cargador puro → ids reales de esta organización. */
  const realProjectId = (syntheticId: string | null | undefined): string | null => {
    if (!syntheticId) return null
    const code = loaded.dimensions.projects.find((p) => p.id === syntheticId)?.code
    return code ? (dimensionIds.projects.get(code) ?? null) : null
  }
  const realCostCenterId = (syntheticId: string | null | undefined): string | null => {
    if (!syntheticId) return null
    const code = loaded.dimensions.costCenters.find((c) => c.id === syntheticId)?.code
    return code ? (dimensionIds.costCenters.get(code) ?? null) : null
  }
  const realBusinessLineId = (syntheticId: string | null | undefined): string | null => {
    if (!syntheticId) return null
    const code = loaded.dimensions.businessLines.find((b) => b.id === syntheticId)?.code
    return code ? (dimensionIds.businessLines.get(code) ?? null) : null
  }

  // ── 2. Ejercicios ─────────────────────────────────────────────────────────
  const fiscalYearIds: Record<string, string> = {}
  for (const fy of [file.fiscalYear, ...file.fiscalYearsExtra]) {
    const created = await openFiscalYear(
      organizationId,
      { code: fy.code, startDate: fy.startDate, endDate: fy.endDate },
      actor
    )
    if (!created.ok) throw new Error(`No se puede crear el ejercicio ${fy.code}: ${describe(created.errors)}`)
    fiscalYearIds[fy.code] = created.value.id
  }

  // ── 3. Asientos, por `postEntry` ──────────────────────────────────────────
  // #4: la fecha de referencia es función del FICHERO, no del reloj. Con `new
  // Date()` la carga del fixture completo (que llega a 2027) fallaría por I8
  // según el día en que se ejecute.
  const refDate = opts.refDate ?? fixtureRefDate(file)
  const idByRef = new Map<string, string>()

  // Los ids de tipo impositivo del fixture son sintéticos y deterministas: hay
  // que traducirlos a los de la organización, o la FK de `journal_lines` los
  // rechazaría. La traducción va por CÓDIGO, que es lo estable.
  const codeBySyntheticId = new Map(loaded.rates.map((r) => [r.id, r.code]))
  const realRates = await tenantTransaction(organizationId, actor.userId ?? undefined, async (tx) =>
    tx.taxRate.findMany({ select: { id: true, code: true } })
  )
  const idByCode = new Map(realRates.map((r) => [r.code, r.id]))
  const realTaxRateId = (syntheticId: string | null | undefined): string | null => {
    if (!syntheticId) return null
    const code = codeBySyntheticId.get(syntheticId)
    return code ? (idByCode.get(code) ?? null) : null
  }

  for (const draft of loaded.drafts) {
    const fiscalYearCode = file.entries.find((e) => e.ref === draft.ref)!.fiscalYearCode
    const fiscalYearId = fiscalYearIds[fiscalYearCode]
    const reversesRef = file.entries.find((e) => e.ref === draft.ref)!.reversesRef

    const real: EntryDraft = {
      ...draft,
      organizationId,
      fiscalYearId,
      reversesEntryId: reversesRef ? (idByRef.get(reversesRef) ?? null) : null,
      lines: draft.lines.map((l) => ({
        ...l,
        taxRateId: realTaxRateId(l.taxRateId),
        projectId: realProjectId(l.projectId),
        costCenterId: realCostCenterId(l.costCenterId),
        businessLineId: realBusinessLineId(l.businessLineId),
      })),
    }

    const posted = await postEntry(organizationId, real, actor, { refDate })
    if (!posted.ok) {
      throw new Error(`El asiento ${draft.ref} (nº ${draft.entryNumber}) no entra: ${describe(posted.errors)}`)
    }
    if (posted.value.entryNumber !== draft.entryNumber) {
      throw new Error(
        `El asiento ${draft.ref} recibió el nº ${posted.value.entryNumber} y el fixture dice ${draft.entryNumber}`
      )
    }
    idByRef.set(draft.ref, posted.value.id)
  }

  // ── 4. Comprobación de `expected` ─────────────────────────────────────────
  const mismatches: string[] = []
  const report = await tenantTransaction(organizationId, actor.userId ?? undefined, async (tx) => {
    const { entries, total } = await getEntries(tx, {}, { take: 100_000 })
    const totalDebitCents = entries.reduce((a, e) => a + e.lines.reduce((s, l) => s + l.debitCents, 0), 0)
    const totalCreditCents = entries.reduce((a, e) => a + e.lines.reduce((s, l) => s + l.creditCents, 0), 0)
    const ledgerHash = await computeLedgerHash(tx)

    check(mismatches, "entryCount", total, file.expected.entryCount)
    check(mismatches, "totalDebitCents", totalDebitCents, file.expected.totalDebitCents)
    check(mismatches, "totalCreditCents", totalCreditCents, file.expected.totalCreditCents)

    // Saldos ANTES del cierre: se excluyen las líneas del asiento de cierre.
    const fyMain = fiscalYearIds[file.fiscalYear.code]
    const balances = await getAccountBalances(tx, {
      upTo: file.fiscalYear.endDate,
      fiscalYearId: fyMain,
      excludeKinds: ["CLOSING"],
    })
    for (const [code, expected] of Object.entries(file.expected.balancesBeforeClosingCents)) {
      check(mismatches, `saldo ${code}`, balances.get(code) ?? 0, expected)
    }

    return { total, totalDebitCents, totalCreditCents, ledgerHash }
  })

  return {
    fixture: opts.fixture,
    organizationId,
    entryCount: report.total,
    totalDebitCents: report.totalDebitCents,
    totalCreditCents: report.totalCreditCents,
    ledgerHash: report.ledgerHash,
    fiscalYearIds,
    mismatches,
  }
}

/**
 * Vacía diario, ejercicios y dimensiones de UNA organización, en una sola
 * transacción y en orden de dependencias. No toca el plan de cuentas ni los
 * tipos impositivos: `importNpgc` ya es idempotente y volver a sembrarlos sería
 * trabajo para nada.
 *
 * `journal_lines`/`journal_entries` tienen política `RESTRICTIVE FOR DELETE`,
 * así que el borrado va con el rol de MANTENIMIENTO (`BYPASSRLS`, ADR-0009 §6):
 * es exactamente el caso para el que ese rol existe —un script de operador—, y
 * la aplicación web sigue sin poder borrar un asiento por ningún camino.
 */
export async function resetOrganizationLedger(organizationId: string, _userId?: string): Promise<void> {
  const url = process.env.DATABASE_URL_MAINTENANCE
  if (!url) {
    throw new Error(
      "--reset-org necesita DATABASE_URL_MAINTENANCE: borrar asientos es una operación de operador " +
        "(ADR-0009 §6), no algo que la aplicación pueda hacer"
    )
  }
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    await client.query("BEGIN")
    // E5 — la liquidación PRIMERO y en orden de FK: `allocation_lines` apunta a
    // runs, reglas y dimensiones; los targets, a las reglas. Borrar los CECOs
    // antes dejaría un `RESTRICT` colgando y el reset fallaría a medias. Va en
    // la misma transacción que todo lo demás.
    await client.query(`DELETE FROM allocation_lines WHERE organization_id = $1::uuid`, [organizationId])
    await client.query(`DELETE FROM allocation_runs WHERE organization_id = $1::uuid`, [organizationId])
    await client.query(`DELETE FROM allocation_rule_targets WHERE organization_id = $1::uuid`, [organizationId])
    await client.query(`DELETE FROM allocation_rules WHERE organization_id = $1::uuid`, [organizationId])
    // E7 (BUG-E7-1) — la conciliación bancaria y el barrido, ANTES del diario y
    // de los ejercicios, en orden estricto de FK:
    //
    //  · `bank_reconciliations.(statement_line_id, journal_line_id)` son
    //    `RESTRICT`: mientras exista una conciliación viva no se puede borrar
    //    ni la línea de extracto ni el apunte, y el reset entero revienta con
    //    `bank_reconciliations_journal_line_fkey`.
    //  · `bank_match_groups` cae después de sus pertenencias; `bank_statements`
    //    después de sus líneas; `bank_accounts` después de sus extractos.
    //  · `invariant_runs.fiscal_year_id` es `RESTRICT`: un barrido sellado
    //    impide borrar el ejercicio (`invariant_runs_fiscal_year_fkey`).
    //  · `store_sweeps` no ata a nada del diario, pero es estado de la
    //    organización y un reset que lo deja vivo hace que I-E7-8 mienta sobre
    //    un almacén que ya no existe.
    //
    // Sin esto, un `npm run test:e2e` completo se rompía: `auditoria.spec.ts`
    // deja conciliaciones y barridos en la organización compartida de fixtures
    // y `liquidacion.spec.ts`, que corre después por orden alfabético, llama a
    // `--reset-org`.
    for (const table of [
      "bank_reconciliations",
      "bank_match_groups",
      "bank_pending_kinds",
      "bank_statement_lines",
      "bank_statements",
      "bank_accounts",
      "invariant_runs",
      "store_sweeps",
    ]) {
      await client.query(`DELETE FROM ${table} WHERE organization_id = $1::uuid`, [organizationId])
    }
    // E8 — el camino documental, en el ÚNICO orden que las restricciones
    // admiten, y por eso se explica:
    //
    //  · `journal_entries.transaction_id → transactions` es `RESTRICT`: la
    //    operación no se puede borrar mientras su asiento la referencie.
    //  · `transactions.journal_entry_id → journal_entries` es `ON DELETE SET
    //    NULL`: borrar el asiento primero deja una `POSTED` sin asiento, y el
    //    CHECK de ADR-0014 D1 aborta el reset entero.
    //  · Y la operación tampoco se puede «apagar» antes: el trigger de
    //    transiciones prohíbe `POSTED → DRAFT`, que es exactamente lo que D1
    //    quiere que sea imposible desde la aplicación.
    //
    // La salida es soltar el enlace por el lado del asiento —`transaction_id`
    // es anulable— y borrar entonces las operaciones, que ya no las referencia
    // nadie. Ni una fila de `transactions` se actualiza en un estado inválido.
    // Todo como `app_maintenance` (ADR-0009 §6): vaciar una organización es una
    // operación de operador, no algo que la aplicación pueda hacer.
    await client.query(`UPDATE journal_entries SET transaction_id = NULL WHERE organization_id = $1::uuid`, [
      organizationId,
    ])
    await client.query(`DELETE FROM transactions WHERE organization_id = $1::uuid`, [organizationId])
    // Las líneas y los asientos, en la MISMA transacción: el constraint trigger
    // diferido de cuadre sólo se calla si el asiento tampoco existe al COMMIT.
    await client.query(`DELETE FROM journal_lines WHERE organization_id = $1::uuid`, [organizationId])
    await client.query(`DELETE FROM journal_entries WHERE organization_id = $1::uuid`, [organizationId])
    // `journal_entries.(file_id, extraction_run_id)` son `RESTRICT`: la
    // evidencia documental cae DESPUÉS del diario que la referenciaba.
    await client.query(`DELETE FROM extraction_runs WHERE organization_id = $1::uuid`, [organizationId])
    await client.query(`DELETE FROM files WHERE organization_id = $1::uuid`, [organizationId])
    await client.query(`DELETE FROM period_locks WHERE organization_id = $1::uuid`, [organizationId])
    await client.query(`DELETE FROM fiscal_years WHERE organization_id = $1::uuid`, [organizationId])
    await client.query(`DELETE FROM margin_level_configs WHERE organization_id = $1::uuid`, [organizationId])
    await client.query(`DELETE FROM cost_centers WHERE organization_id = $1::uuid`, [organizationId])
    await client.query(`DELETE FROM projects WHERE organization_id = $1::uuid`, [organizationId])
    await client.query(`DELETE FROM business_lines WHERE organization_id = $1::uuid`, [organizationId])
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  } finally {
    await client.end()
  }
  say(`· organización ${organizationId} vaciada (--reset-org)`)
}

function check(out: string[], label: string, actual: number, expected: number): void {
  if (actual !== expected) out.push(`${label}: ${actual} ≠ ${expected} (esperado)`)
}

const describe = (errors: readonly LedgerModelError[]): string =>
  errors.map((e) => `${e.code}${e.lineNo ? `@${e.lineNo}` : ""}: ${e.message}`).join(" · ")

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

export const USAGE = `Carga un fixture inmutable en una organización.

  npx tsx scripts/load-fixture.ts --org <uuid> --user <uuid> [opciones]

Obligatorios (auditor 4: el script escribe en el diario; no se adivina en cuál
ni de parte de quién):
  --org <uuid>        Organización destino.
  --user <uuid>       Usuario que contabiliza. Todo asiento lleva autor (P6);
                      sin él, postEntry aborta con POSTED_BY_REQUIRED.

Opcionales:
  --fixture <ruta>    tests/fixtures/ejercicio-minimo.json (por defecto) o
                      tests/fixtures/ejercicio-completo.json
  --reset-org         Vacía la liquidación, el diario, los ejercicios y las
                      dimensiones de esa
                      organización ANTES de cargar. Sin esto, cargar dos veces
                      sobre la misma organización falla al chocar la numeración,
                      que es lo correcto: el script NO sobrescribe un diario.
  --ref-date <fecha>  «Hoy» para I8. Por defecto sale del propio fichero.
  --out <ruta|dir>    Escribe validacion.json. Con un directorio, un fichero por
                      fixture.
  --help              Esto.
`

function parseArgs(argv: string[]): {
  org: string
  fixture: string
  user: string
  out: string | null
  refDate: string | null
  resetOrg: boolean
} {
  const value = (flag: string): string | null => {
    const index = argv.indexOf(flag)
    return index >= 0 ? (argv[index + 1] ?? null) : null
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE)
    process.exit(0)
  }
  const org = value("--org")
  const user = value("--user")
  const fixture = value("--fixture") ?? "tests/fixtures/ejercicio-minimo.json"
  const missing = [!org && "--org", !user && "--user"].filter(Boolean)
  if (missing.length > 0) {
    throw new Error(`Faltan argumentos obligatorios: ${missing.join(", ")}\n\n${USAGE}`)
  }
  return {
    org: org as string,
    fixture,
    user: user as string,
    out: value("--out"),
    refDate: value("--ref-date"),
    resetOrg: argv.includes("--reset-org"),
  }
}

/**
 * `--out` admite fichero o DIRECTORIO (auditoría, ronda 1): con un directorio
 * —existente o terminado en separador— se escribe `<dir>/validacion-<fixture>.json`,
 * de modo que cargar los dos fixtures seguidos no pisa el informe del primero.
 */
export async function resolveOutPath(out: string, fixture: FixtureName): Promise<string> {
  const looksLikeDir = out.endsWith(path.sep) || out.endsWith("/") || (existsSync(out) && statSync(out).isDirectory())
  if (!looksLikeDir) return out
  await mkdir(out, { recursive: true })
  return path.join(out, `validacion-${fixture}.json`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const fixture = fixtureNameOf(args.fixture)

  const report = await loadFixtureIntoOrg({
    organizationId: args.org,
    fixture,
    userId: args.user,
    resetOrg: args.resetOrg,
    ...(args.refDate ? { refDate: args.refDate } : {}),
  })

  say(`· ${report.entryCount} asientos · Σdebe ${report.totalDebitCents} · Σhaber ${report.totalCreditCents}`)
  say(`· ledgerHash ${report.ledgerHash}`)

  if (args.out) {
    const refDate: LocalDate = args.refDate ?? fixtureRefDate(readFixture(fixture))
    const { sha256OfStoredFile } = await import("@/lib/files-integrity")
    const run = await runLedgerInvariants(args.org, { refDate, noCache: true, readStoredFile: sha256OfStoredFile })
    const target = await resolveOutPath(args.out, fixture)
    await writeFile(target, JSON.stringify({ ...run.validacion, sello: run.sello }, null, 2) + "\n", "utf8")
    say(`· ${run.sello.sello}${run.sello.motivos.length ? ` — ${run.sello.motivos.join("; ")}` : ""}`)
    say(`· escrito ${target}`)
  }

  if (report.mismatches.length > 0) {
    console.error(`\n· ${report.mismatches.length} discrepancia(s) con el bloque expected:`)
    for (const mismatch of report.mismatches) console.error(`  - ${mismatch}`)
    process.exitCode = 1
    return
  }
  say("· expected: todo cuadra")
}

if (process.argv[1] && process.argv[1].endsWith("load-fixture.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
