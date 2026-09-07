/**
 * E7 · T15 — **Retención de runs** (ADR-0015 **D3**, APROBADO).
 *
 * C1 de SPEC-FIABILIDAD exige una política de retención y hasta E7 nadie la
 * había traducido al producto: los runs se acumulaban sin criterio. La política
 * está escrita en el ADR y aquí se ejecuta, tal cual:
 *
 * | Tabla | Se conserva |
 * |---|---|
 * | `ReportRun`    | **todos** los de los últimos **24 meses**, **+** el último de cada tipo y mes histórico, **+ todos** los de un ejercicio `CLOSED` |
 * | `InvariantRun` | igual, **+** siempre el último de cada alcance y el último con sello `REQUIERE_REVISION` de cada ejercicio |
 * | `StoreSweep`   | 12 meses, **+** el último `DONE` siempre |
 * | `AuditLog`, `ExtractionRun`, `AllocationRun` | **no se purgan**: son el rastro, no la foto |
 * | `BankStatement`, `BankStatementLine`, `BankReconciliation`, `BankMatchGroup` y el `File` del extracto | **no se purgan nunca** |
 *
 * **Conservación mercantil (O-22).** El art. 30 CCom obliga a conservar libros,
 * correspondencia, documentación y justificantes **seis años**, y los soportes
 * de la conciliación bancaria son justificantes; las bases imponibles negativas
 * alargan la comprobación a **diez** (art. 26.5 LIS). De ahí la comprobación
 * dura de este script: **jamás se borra un `File` referenciado por un
 * `BankStatement`** (`comprobarFicherosDeExtracto`), y de hecho este script no
 * borra ficheros en absoluto — la comprobación existe porque el archivado en
 * frío de E9 va a heredar esta política y el error se cometería allí.
 *
 * · **Por organización** (`--org`) o todas (`--all`). Nunca implícito.
 * · **SIMULACIÓN por defecto.** Sin `--apply` cuenta y no borra nada.
 * · **Conecta como `app_maintenance`** (BYPASSRLS, ADR-0009 §6): recorre varias
 *   organizaciones y con `app_runtime` vería 0 filas en silencio.
 * · Purgar es `DELETE` sobre tablas **append-only**. El ADR contemplaba levantar
 *   `FORCE ROW LEVEL SECURITY` en la ventana del borrado, como hacen las
 *   migraciones; **no hace falta y además no se puede**: `app_maintenance` tiene
 *   `BYPASSRLS`, así que ni las políticas `RESTRICTIVE` de DELETE ni `FORCE` le
 *   afectan, y `ALTER TABLE … NO FORCE` exige ser PROPIETARIO de la tabla, que
 *   este rol no es. Tocar `FORCE` desde aquí sería, además, abrir una ventana en
 *   la que cualquier otra sesión podría cruzar organizaciones. Se deja como está
 *   y el test de «ninguna tabla en NO FORCE» sigue siendo la red.
 *
 * La AUTOMATIZACIÓN —cron y archivado en frío— es **E9**, fechada en `ESTADO.md`.
 * Aquí sólo está la herramienta del operador.
 *
 * Uso:
 *   DATABASE_URL_MAINTENANCE=… npx tsx scripts/prune-runs.ts --all
 *   DATABASE_URL_MAINTENANCE=… npx tsx scripts/prune-runs.ts --org <uuid> --apply
 *   DATABASE_URL_MAINTENANCE=… npx tsx scripts/prune-runs.ts --all --apply --ref-date 2027-01-01
 */

import path from "node:path"

import type { Client } from "pg"

import { maintenanceDatabaseUrl, withMaintenanceClient } from "@/lib/db-maintenance"

/** Meses de retención completa por tabla (ADR-0015 D3). */
export const RETENTION_MONTHS = { reportRuns: 24, invariantRuns: 24, storeSweeps: 12 } as const

/** Tablas que este script NO purga jamás, y por qué. */
export const NUNCA_SE_PURGAN: Readonly<Record<string, string>> = {
  audit_logs: "es el rastro, no la foto (ADR-0015 D3)",
  extraction_runs: "es el rastro, no la foto",
  allocation_runs: "es el rastro, no la foto",
  bank_statements: "justificante mercantil: art. 30 CCom (seis años; diez con BIN, art. 26.5 LIS)",
  bank_statement_lines: "justificante mercantil (O-22)",
  bank_reconciliations: "justificante mercantil (O-22)",
  bank_match_groups: "justificante mercantil (O-22)",
  files: "un `File` referenciado por un `BankStatement` no se borra nunca (O-22)",
}

export type PruneReport = {
  apply: boolean
  refDate: string
  organizations: number
  reportRuns: number
  invariantRuns: number
  storeSweeps: number
  /** Ficheros de extracto protegidos (siempre > 0 si hay extractos importados). */
  ficherosDeExtractoProtegidos: number
}

export type PruneOptions = {
  org?: string | null
  all?: boolean
  apply?: boolean
  /** «Hoy» para el cálculo de la ventana. Por parámetro: no se lee el reloj. */
  refDate?: string
}

function parseArgs(argv: readonly string[]): PruneOptions {
  const at = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined)
  return {
    org: at("--org") ?? null,
    all: argv.includes("--all"),
    apply: argv.includes("--apply"),
    refDate: at("--ref-date"),
  }
}

/**
 * Los ids de `ReportRun` que SOBREVIVEN. Se calcula la lista de supervivientes y
 * se borra el complemento: al revés —una lista de condenados— cualquier hueco en
 * el `WHERE` borra evidencia, y aquí el error no tiene vuelta atrás.
 */
const REPORT_RUNS_A_BORRAR = `
  WITH vivos AS (
    SELECT r.id
      FROM report_runs r
      LEFT JOIN fiscal_years fy ON fy.id = r.fiscal_year_id
     WHERE r.organization_id = $1::uuid
       AND (
         -- (1) todo lo de los últimos 24 meses
         r.created_at >= ($2::date - make_interval(months => $3))
         -- (2) evidencia de unas cuentas rendidas: un ejercicio CERRADO no se purga NUNCA
         OR fy.status = 'CLOSED'
         -- (3) el ÚLTIMO de cada tipo y mes histórico
         OR r.id IN (
           SELECT DISTINCT ON (x.type, date_trunc('month', x.created_at)) x.id
             FROM report_runs x
            WHERE x.organization_id = $1::uuid
            ORDER BY x.type, date_trunc('month', x.created_at), x.created_at DESC
         )
       )
  )
  SELECT id FROM report_runs
   WHERE organization_id = $1::uuid AND id NOT IN (SELECT id FROM vivos)`

const INVARIANT_RUNS_A_BORRAR = `
  WITH vivos AS (
    SELECT r.id
      FROM invariant_runs r
      LEFT JOIN fiscal_years fy ON fy.id = r.fiscal_year_id
     WHERE r.organization_id = $1::uuid
       AND (
         r.created_at >= ($2::date - make_interval(months => $3))
         OR fy.status = 'CLOSED'
         OR r.id IN (
           SELECT DISTINCT ON (x.scope_kind, date_trunc('month', x.created_at)) x.id
             FROM invariant_runs x
            WHERE x.organization_id = $1::uuid
            ORDER BY x.scope_kind, date_trunc('month', x.created_at), x.created_at DESC
         )
         -- SIEMPRE el último de cada alcance…
         OR r.id IN (
           SELECT DISTINCT ON (x.scope_kind, x.fiscal_year_id) x.id
             FROM invariant_runs x
            WHERE x.organization_id = $1::uuid
            ORDER BY x.scope_kind, x.fiscal_year_id, x.created_at DESC
         )
         -- …y el último REQUIERE REVISIÓN de cada ejercicio: es justo el que
         -- alguien va a querer ver cuando pregunte por qué se selló así.
         OR r.id IN (
           SELECT DISTINCT ON (x.fiscal_year_id) x.id
             FROM invariant_runs x
            WHERE x.organization_id = $1::uuid AND x.seal = 'REQUIERE_REVISION'
            ORDER BY x.fiscal_year_id, x.created_at DESC
         )
       )
  )
  SELECT id FROM invariant_runs
   WHERE organization_id = $1::uuid AND id NOT IN (SELECT id FROM vivos)`

const STORE_SWEEPS_A_BORRAR = `
  WITH vivos AS (
    SELECT s.id
      FROM store_sweeps s
     WHERE s.organization_id = $1::uuid
       AND (
         s.started_at >= ($2::date - make_interval(months => $3))
         OR s.id = (
           SELECT x.id FROM store_sweeps x
            WHERE x.organization_id = $1::uuid AND x.status = 'DONE'
            ORDER BY x.started_at DESC LIMIT 1
         )
       )
  )
  SELECT id FROM store_sweeps
   WHERE organization_id = $1::uuid AND id NOT IN (SELECT id FROM vivos)`

/**
 * **O-22 · la comprobación que este script no puede saltarse.** Devuelve los
 * `File` que un `BankStatement` referencia. Ninguno se borra jamás: son el
 * justificante de la conciliación y el art. 30 CCom obliga a conservarlos seis
 * años (diez con bases imponibles negativas). La FK es `ON DELETE RESTRICT`, de
 * modo que la base también lo impide; esto lo dice ANTES y por escrito.
 */
export async function comprobarFicherosDeExtracto(client: Client, organizationId: string): Promise<string[]> {
  const { rows } = await client.query<{ file_id: string }>(
    `SELECT DISTINCT file_id FROM bank_statements
      WHERE organization_id = $1::uuid AND file_id IS NOT NULL`,
    [organizationId]
  )
  return rows.map((r) => r.file_id)
}

async function idsABorrar(client: Client, sql: string, organizationId: string, refDate: string, months: number) {
  const { rows } = await client.query<{ id: string }>(sql, [organizationId, refDate, months])
  return rows.map((r) => r.id)
}

/**
 * Purga según la política. `refDate` entra por parámetro —nunca se lee el
 * reloj— para que dos ejecuciones sobre el mismo estado den el mismo resultado.
 */
export async function pruneRuns(opts: PruneOptions): Promise<PruneReport> {
  const refDate = opts.refDate ?? new Date().toISOString().slice(0, 10)
  const report: PruneReport = {
    apply: Boolean(opts.apply),
    refDate,
    organizations: 0,
    reportRuns: 0,
    invariantRuns: 0,
    storeSweeps: 0,
    ficherosDeExtractoProtegidos: 0,
  }

  await withMaintenanceClient(async (client) => {
    const { rows: orgs } = await client.query<{ id: string }>(
      `SELECT id FROM organizations WHERE ($1::uuid IS NULL OR id = $1::uuid) ORDER BY id`,
      [opts.org ?? null]
    )
    report.organizations = orgs.length

    for (const { id: organizationId } of orgs) {
      const protegidos = await comprobarFicherosDeExtracto(client, organizationId)
      report.ficherosDeExtractoProtegidos += protegidos.length

      const reportIds = await idsABorrar(client, REPORT_RUNS_A_BORRAR, organizationId, refDate, RETENTION_MONTHS.reportRuns)
      const invariantIds = await idsABorrar(
        client,
        INVARIANT_RUNS_A_BORRAR,
        organizationId,
        refDate,
        RETENTION_MONTHS.invariantRuns
      )
      const sweepIds = await idsABorrar(client, STORE_SWEEPS_A_BORRAR, organizationId, refDate, RETENTION_MONTHS.storeSweeps)

      report.reportRuns += reportIds.length
      report.invariantRuns += invariantIds.length
      report.storeSweeps += sweepIds.length

      if (!opts.apply) continue

      // Las tres son APPEND-ONLY para la aplicación (`RESTRICTIVE … USING(false)`
      // + `REVOKE`), pero `app_maintenance` tiene `BYPASSRLS` y sí conserva el
      // privilegio de DELETE: es el único rol que puede ejecutar la política de
      // retención, y por eso este script no es una server action.
      await client.query("BEGIN")
      try {
        // Un `ManualReviewFlag` puede apuntar al run que se purga: la FK es
        // RESTRICT, así que primero se suelta la referencia (el flag es un hecho
        // de gobierno y NO se borra; sólo deja de señalar una foto que ya no está).
        if (invariantIds.length > 0) {
          await client.query(
            `UPDATE manual_review_flags SET invariant_run_id = NULL
              WHERE organization_id = $1::uuid AND invariant_run_id = ANY($2::uuid[])`,
            [organizationId, invariantIds]
          )
          await client.query(`UPDATE invariant_runs SET store_sweep_id = NULL WHERE id = ANY($1::uuid[])`, [
            invariantIds,
          ])
          await client.query(`DELETE FROM invariant_runs WHERE id = ANY($1::uuid[])`, [invariantIds])
        }
        if (reportIds.length > 0) {
          await client.query(`DELETE FROM report_runs WHERE id = ANY($1::uuid[])`, [reportIds])
        }
        if (sweepIds.length > 0) {
          // Un barrido al que todavía apunta un `InvariantRun` vivo no se borra:
          // dejaría el run sin la evidencia del almacén que dice tener.
          await client.query(
            `DELETE FROM store_sweeps s WHERE s.id = ANY($1::uuid[])
               AND NOT EXISTS (SELECT 1 FROM invariant_runs r WHERE r.store_sweep_id = s.id)`,
            [sweepIds]
          )
        }
        await client.query("COMMIT")
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined)
        throw error
      }
    }
  })

  return report
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.org && !args.all) {
    console.error("Uso: prune-runs.ts (--all | --org <uuid>) [--apply] [--ref-date AAAA-MM-DD]")
    process.exitCode = 1
    return
  }
  maintenanceDatabaseUrl() // aborta con mensaje explícito si falta la credencial

  console.log(
    `Retención de runs (ADR-0015 D3) — ámbito: ${args.org ?? "TODAS las organizaciones"}, ` +
      `${args.apply ? "APLICANDO" : "SIMULACIÓN (sin --apply no borra nada)"}`
  )
  const report = await pruneRuns(args)
  console.log(
    `\nFecha de referencia ${report.refDate} · organizaciones ${report.organizations}\n` +
      `  ReportRun    a purgar: ${report.reportRuns}   (se conservan 24 meses + 1 por tipo y mes + todo ejercicio CLOSED)\n` +
      `  InvariantRun a purgar: ${report.invariantRuns}   (+ el último de cada alcance y el último REQUIERE REVISIÓN)\n` +
      `  StoreSweep   a purgar: ${report.storeSweeps}   (12 meses + el último DONE)\n` +
      `  Ficheros de extracto PROTEGIDOS: ${report.ficherosDeExtractoProtegidos} (art. 30 CCom; nunca se borran)`
  )
  for (const [tabla, motivo] of Object.entries(NUNCA_SE_PURGAN)) {
    console.log(`  · ${tabla}: no se purga — ${motivo}`)
  }
}

// Sólo se ejecuta como CLI; importado desde un test, no arranca nada.
if (process.argv[1] && path.resolve(process.argv[1]).endsWith("prune-runs.ts")) {
  await main()
}
