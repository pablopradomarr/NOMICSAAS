/**
 * Comprobación de invariantes — **placeholder de E3-T2** (ADR-0009 §6).
 *
 * El motor completo (I1, I7–I10 y los siete propios de E3) lo entrega T6 en
 * `lib/ledger/invariants.ts`; este script existe ya porque es el OTRO consumidor
 * previsto del rol `app_maintenance` y conviene que su conexión quede fijada
 * antes de que T3 retire la cláusula de escape.
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

type CheckStatus = "PASS" | "FAIL" | "WARN" | "PENDING"

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
  checks: Check[]
}

/** Invariantes cuyo motor llega en T6: se declaran, no se dan por buenos. */
const PENDIENTES: readonly string[] = ["I1", "I7", "I8", "I9"]

function parseArgs(argv: string[]): { organizationId: string | null; out: string } {
  const orgIndex = argv.indexOf("--org")
  const outIndex = argv.indexOf("--out")
  return {
    organizationId: orgIndex >= 0 ? (argv[orgIndex + 1] ?? null) : null,
    out: outIndex >= 0 ? (argv[outIndex + 1] ?? "validacion.json") : "validacion.json",
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
  const { organizationId, out } = parseArgs(process.argv.slice(2))

  const checks = await withMaintenanceClient(async (client) => {
    const done: Check[] = [await checkI10(client, organizationId)]
    for (const id of PENDIENTES) {
      done.push({
        id,
        status: "PENDING",
        evidencia: "Sin implementar todavía: llega con lib/ledger/invariants.ts (E3-T6)",
        query: null,
      })
    }
    return done
  })

  const validacion: Validacion = {
    run_id: randomUUID(),
    ledgerHash: null,
    gitSha: process.env.GIT_SHA ?? null,
    organizationId,
    checks,
  }

  await writeFile(out, JSON.stringify(validacion, null, 2) + "\n", "utf8")

  for (const check of checks) {
    console.log(`${check.status.padEnd(7)} ${check.id.padEnd(4)} ${check.evidencia}`)
  }
  console.log(`\n· Escrito ${out}`)

  if (checks.some((check) => check.status === "FAIL")) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
