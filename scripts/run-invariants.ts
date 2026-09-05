/**
 * Comprobación de invariantes de la capa 1 (E3 · T6/T8, ADR-0009 §6).
 *
 * Dos mitades, cada una con el rol que le corresponde (revisión ronda 1, #5):
 *
 *  - **I1, I7–I9 e I-E3-1…7**: `models/ledger.runLedgerInvariants(--org)`, que
 *    corre acotado al tenant (`app_runtime` vía `DATABASE_URL`) y usa el motor
 *    puro de `lib/ledger/invariants.ts`. Ya no hay «PENDING»: si un invariante
 *    no se puede evaluar, lo dice él (INFO), no este script.
 *  - **I10**: barrido cross-org como `app_maintenance`, más abajo.
 *
 * **Por qué `app_maintenance` y no `tenantDb`.** I10 dice que ninguna fila
 * apunta a una entidad de OTRA organización. Con el filtro de tenant puesto, un
 * cruce es invisible por construcción: la consulta que debería delatarlo no ve
 * la fila intrusa. El único modo de comprobarlo es consultar SIN filtro, y desde
 * ADR-0009 eso exige un rol con `BYPASSRLS` y credencial propia
 * (`DATABASE_URL_MAINTENANCE`), no un agujero en la política.
 *
 * Uso:
 *   DATABASE_URL_MAINTENANCE=… npx tsx scripts/run-invariants.ts [--org <uuid>]
 *                                     [--out <fichero>] [--ref-date AAAA-MM-DD]
 *
 * `--ref-date` es «hoy» para I8 (`entryDate ≤ refDate`). Por defecto, la fecha
 * de hoy en Europe/Madrid. Se declara explícitamente cuando el resultado tiene
 * que ser REPRODUCIBLE —los fixtures llegan a 2027 y un run del año que viene
 * no puede dar otra cosa que el de hoy—: los tests y la carga de fixtures pasan
 * siempre la suya (ronda 2, #4).
 *
 * Salida: `validacion.json` en el formato de `docs/design/E3-libro-diario.md` §5
 *   { run_id, ledgerHash, gitSha, checks: [{ id, status, evidencia, query }] }
 * Hoy sólo I10 tiene comprobación real; el resto se declara PENDING para que
 * nadie confunda «no implementado» con «PASS».
 */
import { withMaintenanceClient } from "@/lib/db-maintenance"
import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import type { Client } from "pg"

type CheckStatus = "PASS" | "FAIL" | "WARN" | "INFO"

type Check = {
  id: string
  status: CheckStatus
  evidencia: string
  query: string | null
}

type Validacion = {
  run_id: string
  ledgerHash: string | null
  gitSha: string | null
  organizationId: string | null
  refDate?: string
  sello?: { sello: string; motivos: string[] }
  checks: Check[]
}

/** «Hoy» por parámetro: el motor puro nunca lo calcula (CLAUDE.md). */
function todayIso(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Madrid" }).format(new Date())
}

function parseArgs(argv: string[]): { organizationId: string | null; out: string; refDate: string | null } {
  const value = (flag: string): string | null => {
    const index = argv.indexOf(flag)
    return index >= 0 ? (argv[index + 1] ?? null) : null
  }
  const refDate = value("--ref-date")
  if (refDate && !/^\d{4}-\d{2}-\d{2}$/.test(refDate)) {
    throw new Error(`--ref-date debe ser AAAA-MM-DD, no ${refDate}`)
  }
  return {
    organizationId: value("--org"),
    out: value("--out") ?? "validacion.json",
    refDate,
  }
}

/**
 * I10 (parte de E1/E2, la del diario la añade T6 sobre `journal_lines`): ninguna
 * fila de negocio referencia una entidad de otra organización.
 *
 * Las FK son COMPUESTAS por `(organization_id, …)` desde 20260904120200, así que
 * la base ya lo impide; esto lo VERIFICA, que no es lo mismo, y deja evidencia.
 */
const I10_QUERY = `
  SELECT 'accounts.parent_code' AS relacion, count(*)::int AS cruces
    FROM accounts a
    LEFT JOIN accounts p
      ON p.organization_id = a.organization_id AND p.code = a.parent_code
   WHERE a.parent_code IS NOT NULL AND p.code IS NULL
  UNION ALL
  SELECT 'organization_account_maps.account_code', count(*)::int
    FROM organization_account_maps m
    LEFT JOIN accounts a
      ON a.organization_id = m.organization_id AND a.code = m.account_code
   WHERE a.code IS NULL
  UNION ALL
  SELECT 'tax_rates.account_code', count(*)::int
    FROM tax_rates t
    LEFT JOIN accounts a
      ON a.organization_id = t.organization_id AND a.code = t.account_code
   WHERE t.account_code IS NOT NULL AND a.code IS NULL
  UNION ALL
  SELECT 'memberships.organization_id', count(*)::int
    FROM memberships m
    LEFT JOIN organizations o ON o.id = m.organization_id
   WHERE o.id IS NULL
`

async function checkI10(client: Client, organizationId: string | null): Promise<Check> {
  const result = await client.query<{ relacion: string; cruces: number }>(I10_QUERY)
  const rotas = result.rows.filter((row) => row.cruces > 0)
  return {
    id: "I10",
    status: rotas.length === 0 ? "PASS" : "FAIL",
    evidencia:
      rotas.length === 0
        ? `Sin cruces entre organizaciones en ${result.rows.length} relaciones comprobadas` +
          (organizationId ? ` (barrido global; --org ${organizationId} es informativo)` : "")
        : rotas.map((row) => `${row.relacion}: ${row.cruces} fila(s) cruzada(s)`).join(" · "),
    query: I10_QUERY.trim(),
  }
}

async function main() {
  const { organizationId, out, refDate: refDateArg } = parseArgs(process.argv.slice(2))
  const refDate = refDateArg ?? todayIso()

  // I10: barrido SIN filtro de tenant. Es la única forma de ver un cruce.
  const crossOrg = await withMaintenanceClient(async (client) => checkI10(client, organizationId))

  // El resto, con el motor puro sobre los datos de la organización.
  let ledgerHash: string | null = null
  let gitSha = process.env.GIT_SHA ?? "desconocido"
  let sello: { sello: string; motivos: string[] } | undefined
  const checks: Check[] = []

  if (organizationId) {
    const { runLedgerInvariants } = await import("@/models/ledger")
    const run = await runLedgerInvariants(organizationId, { refDate, noCache: true })
    ledgerHash = run.validacion.ledgerHash
    gitSha = run.validacion.gitSha
    sello = { sello: run.sello.sello, motivos: run.sello.motivos }
    for (const check of run.validacion.checks) {
      if (check.id === "I10") continue // manda el barrido cross-org
      checks.push({
        id: check.id,
        status: check.status as CheckStatus,
        evidencia: check.evidencia,
        query: check.query ?? null,
      })
    }
  } else {
    checks.push({
      id: "I1",
      status: "INFO",
      evidencia: "Sin --org sólo se ejecuta I10 (barrido cross-org): los demás invariantes son por organización",
      query: null,
    })
  }

  checks.push(crossOrg)

  const validacion: Validacion = {
    run_id: randomUUID(),
    ledgerHash,
    gitSha,
    organizationId,
    refDate,
    ...(sello ? { sello } : {}),
    checks,
  }

  await writeFile(out, JSON.stringify(validacion, null, 2) + "\n", "utf8")

  for (const check of checks) {
    console.log(`${check.status.padEnd(7)} ${check.id.padEnd(8)} ${check.evidencia}`)
  }
  if (sello) console.log(`\n· ${sello.sello}${sello.motivos.length ? ` — ${sello.motivos.join("; ")}` : ""}`)
  console.log(`· Escrito ${out}`)

  if (checks.some((check) => check.status === "FAIL")) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
