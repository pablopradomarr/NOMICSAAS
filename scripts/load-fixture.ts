/**
 * E3 · T13 — Cargador de los fixtures inmutables en una base de datos real.
 *
 *   npx tsx scripts/load-fixture.ts --org <uuid> --fixture tests/fixtures/ejercicio-completo.json
 *
 * Qué hace, en este orden:
 *   1. Aplica al `Organization` la política del fixture (moneda, variante PGC,
 *      redondeo, prorrata) y siembra el plan NPGC si la organización no lo tiene.
 *   2. Crea los ejercicios (`fiscalYear` + `fiscalYearsExtra`) **abiertos**: los
 *      asientos de cierre del fixture se postean como asientos normales del
 *      ejercicio; cerrarlo es otra operación (`closeFiscalYear`).
 *   3. Postea los 5 / 84 asientos **por `postEntry`** — el mismo camino que la
 *      aplicación, con su validación C-1…C-13, su `FOR UPDATE` y sus triggers.
 *      D-E3-1: `projectCode`/`costCenterCode`/`businessLineCode` se descartan.
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
import { loadFixture, readFixture, type FixtureName } from "@/tests/support/fixtures"
import { existsSync, statSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

export type LoadFixtureOptions = {
  organizationId: string
  fixture: FixtureName
  userId?: string | null
  /** Si el fixture trae un ejercicio ya cerrado, se crea abierto igualmente. */
  seedPlan?: boolean
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
  const refDate = loaded.ctx.refDate
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
        projectId: null,
        costCenterId: null,
        businessLineId: null,
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

function check(out: string[], label: string, actual: number, expected: number): void {
  if (actual !== expected) out.push(`${label}: ${actual} ≠ ${expected} (esperado)`)
}

const describe = (errors: readonly LedgerModelError[]): string =>
  errors.map((e) => `${e.code}${e.lineNo ? `@${e.lineNo}` : ""}: ${e.message}`).join(" · ")

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { org: string; fixture: string; user: string | null; out: string | null } {
  const value = (flag: string): string | null => {
    const index = argv.indexOf(flag)
    return index >= 0 ? (argv[index + 1] ?? null) : null
  }
  const org = value("--org")
  const fixture = value("--fixture") ?? "tests/fixtures/ejercicio-minimo.json"
  if (!org) throw new Error("Uso: npx tsx scripts/load-fixture.ts --org <uuid> --fixture <ruta> [--out validacion.json]")
  return { org, fixture, user: value("--user"), out: value("--out") }
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
  })

  say(`· ${report.entryCount} asientos · Σdebe ${report.totalDebitCents} · Σhaber ${report.totalCreditCents}`)
  say(`· ledgerHash ${report.ledgerHash}`)

  if (args.out) {
    const refDate: LocalDate = loadFixture(fixture).ctx.refDate
    const run = await runLedgerInvariants(args.org, { refDate, noCache: true })
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
