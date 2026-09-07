/**
 * E7 · T15 — **`ReportType.CASHFLOW` unificado** (ADR-0015 **D4**, APROBADO).
 *
 * `CASHFLOW_DIRECTO` y `CASHFLOW_INDIRECTO` eran dos TIPOS de informe cuando el
 * método es un **parámetro** del mismo informe, sobre el mismo periodo y el
 * mismo `ledgerHash` — lo contrario de lo que ADR-0012 decidió para la foto del
 * balance y la variante del PGC. Desde E7 hay un solo `CASHFLOW` con
 * `params.method ∈ {DIRECTO, INDIRECTO}`, que entra en `paramsHash` como
 * cualquier otro parámetro.
 *
 * **Por qué esto NO va en SQL.** `params_hash` es el sha256 de la forma canónica
 * de `params`, y reimplementar `canonicalJson` en PL/pgSQL sería crear la deriva
 * de dos caminos que ADR-0011 corrigió. Este script usa **la misma función que
 * la aplicación** (`lib/ledger/report-run.ts::paramsHash`), que es la única
 * manera de que el hash migrado sea el que la caché va a buscar mañana.
 *
 * Orden (runbook de E3, lección de `20260907120000`): la **marca se escribe
 * ANTES** del backfill. Si el proceso se corta a la mitad, la marca dice que la
 * conversión empezó y el operador sabe que tiene que reanudar; al revés, una
 * marca escrita al final sobre un backfill incompleto miente.
 *
 * Consecuencia conocida y aceptada (ADR-0015, §Consecuencias): un `ReportRun`
 * histórico de cashflow **cambia de clave**. El `result` no se toca —el informe
 * sigue siendo legible y auditable, que es lo que el sello acredita—, pero su
 * clave de reutilización no coincide con la de antes de la migración: el primer
 * cashflow que se pida después se recalculará. Queda anotado aquí y en
 * `ESTADO.md`.
 *
 * Al terminar, valida el CHECK `NOT VALID` que
 * `20260916100000_e7_auditoria` dejó puesto: si `VALIDATE CONSTRAINT` pasa, es
 * que no queda ni una fila con los tipos viejos y la prohibición pasa a ser
 * completa. PostgreSQL no permite retirar un valor de un enum sin recrear el
 * tipo, así que la prohibición vive en ese CHECK y no en el enum.
 *
 * Conecta como `app_maintenance` (BYPASSRLS, ADR-0009 §6): recorre varias
 * organizaciones y con `app_runtime` vería 0 filas en silencio.
 *
 * Uso:
 *   DATABASE_URL_MAINTENANCE=… npx tsx scripts/migrate-cashflow-report-type.ts --all
 *   DATABASE_URL_MAINTENANCE=… npx tsx scripts/migrate-cashflow-report-type.ts --all --apply
 *   DATABASE_URL_MAINTENANCE=… npx tsx scripts/migrate-cashflow-report-type.ts --org <uuid> --apply
 */

import path from "node:path"

import type { Client } from "pg"

import { maintenanceDatabaseUrl, withMaintenanceClient } from "@/lib/db-maintenance"
import { paramsHash } from "@/lib/ledger/report-run"

/** Marca de conversión. Se escribe ANTES del backfill (orden del runbook). */
export const MARKER_CODE = "e7.cashflow_report_type_migrated"

export type CashflowMigrationReport = {
  apply: boolean
  organizations: number
  /** Runs convertidos a `CASHFLOW` con su `params.method` y su hash recalculado. */
  runs: number
  /** `ManualReviewFlag.scope` reapuntados al tipo unificado. */
  flags: number
  /** Runs que NO se pudieron convertir porque otro igual ya ocupa la clave. */
  colisiones: number
  /** `true` si el CHECK `NOT VALID` quedó validado (no queda ni una fila vieja). */
  checkValidado: boolean
}

export type CashflowMigrationOptions = { org?: string | null; all?: boolean; apply?: boolean }

function parseArgs(argv: readonly string[]): CashflowMigrationOptions {
  return {
    org: argv.includes("--org") ? argv[argv.indexOf("--org") + 1] : null,
    all: argv.includes("--all"),
    apply: argv.includes("--apply"),
  }
}

/** El método que el tipo viejo declaraba, cuando `params` no lo trae. */
function methodOf(type: string, params: Record<string, unknown>): "DIRECTO" | "INDIRECTO" {
  const declared = params.method
  if (declared === "DIRECTO" || declared === "INDIRECTO") return declared
  return type === "CASHFLOW_INDIRECTO" ? "INDIRECTO" : "DIRECTO"
}

async function escribirMarca(client: Client, organizationId: string): Promise<void> {
  await client.query(
    `INSERT INTO settings (id, organization_id, code, name, description, value, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, $2, 'Conversión de ReportType a CASHFLOW',
             'ADR-0015 D4: el método del cashflow pasa a ser un parámetro. La marca se escribe ANTES del backfill.',
             'RUNNING', now())
     ON CONFLICT (organization_id, code) DO UPDATE SET value = 'RUNNING', updated_at = now()`,
    [organizationId, MARKER_CODE]
  )
}

async function cerrarMarca(client: Client, organizationId: string, runs: number): Promise<void> {
  await client.query(`UPDATE settings SET value = $3, updated_at = now() WHERE organization_id = $1::uuid AND code = $2`, [
    organizationId,
    MARKER_CODE,
    `DONE:${runs}`,
  ])
}

export async function migrateCashflowReportType(
  opts: CashflowMigrationOptions
): Promise<CashflowMigrationReport> {
  const report: CashflowMigrationReport = {
    apply: Boolean(opts.apply),
    organizations: 0,
    runs: 0,
    flags: 0,
    colisiones: 0,
    checkValidado: false,
  }

  await withMaintenanceClient(async (client) => {
    const { rows: orgs } = await client.query<{ id: string }>(
      `SELECT id FROM organizations WHERE ($1::uuid IS NULL OR id = $1::uuid) ORDER BY id`,
      [opts.org ?? null]
    )
    report.organizations = orgs.length

    for (const { id: organizationId } of orgs) {
      const { rows } = await client.query<{ id: string; type: string; params: Record<string, unknown> }>(
        `SELECT id, type::text AS type, params FROM report_runs
          WHERE organization_id = $1::uuid AND type IN ('CASHFLOW_DIRECTO', 'CASHFLOW_INDIRECTO')
          ORDER BY created_at`,
        [organizationId]
      )
      const { rows: flagRows } = await client.query<{ id: string }>(
        `SELECT id FROM manual_review_flags
          WHERE organization_id = $1::uuid AND scope IN ('CASHFLOW_DIRECTO', 'CASHFLOW_INDIRECTO')`,
        [organizationId]
      )

      if (rows.length === 0 && flagRows.length === 0) continue
      if (!opts.apply) {
        report.runs += rows.length
        report.flags += flagRows.length
        continue
      }

      // 1) La marca, ANTES del backfill. Fuera de la transacción del backfill a
      //    propósito: si el backfill falla, la marca tiene que quedar en RUNNING
      //    para que el operador sepa que hay que reanudar.
      await escribirMarca(client, organizationId)

      // 2) El backfill. `report_runs` y `manual_review_flags` son append-only /
      //    semi-append-only PARA LA APLICACIÓN (política `RESTRICTIVE` +
      //    `REVOKE` sobre `app_runtime`). El ADR hablaba de envolverlo en
      //    `NO FORCE` → DML → `FORCE`, que es el patrón de las MIGRACIONES;
      //    aquí no aplica: `app_maintenance` tiene `BYPASSRLS` —ni `FORCE` ni
      //    las políticas le afectan— y `ALTER TABLE … NO FORCE` exige ser
      //    propietario, que este rol no es. Abrir esa ventana desde un script
      //    sería, además, dejar a cualquier otra sesión cruzar organizaciones.
      await client.query("BEGIN")
      try {
        for (const row of rows) {
          const params = { ...(row.params ?? {}), method: methodOf(row.type, row.params ?? {}) }
          // **La misma función que la aplicación.** Un sha256 reimplementado en
          // PL/pgSQL sería la deriva de dos caminos que ADR-0011 corrigió.
          const hash = paramsHash(params)
          const updated = await client.query(
            `UPDATE report_runs SET type = 'CASHFLOW', params = $2::jsonb, params_hash = $3
              WHERE id = $1::uuid`,
            [row.id, JSON.stringify(params), hash]
          )
          if (updated.rowCount === 1) report.runs++
        }
        const flags = await client.query(
          `UPDATE manual_review_flags SET scope = 'CASHFLOW'
            WHERE organization_id = $1::uuid AND scope IN ('CASHFLOW_DIRECTO', 'CASHFLOW_INDIRECTO')`,
          [organizationId]
        )
        report.flags += flags.rowCount ?? 0
        await client.query("COMMIT")
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined)
        // Una colisión de la clave de caché (`report_runs_cache_key`) no es un
        // fallo del script: son dos runs que eran distintos por el TIPO y que,
        // unificados, son el mismo informe. Se cuenta y se sigue; el operador
        // decide con qué se queda.
        const message = error instanceof Error ? error.message : String(error)
        if (!/report_runs_cache_key/.test(message)) throw error
        report.colisiones += rows.length
      }

      // 3) La marca se cierra sólo si el backfill terminó.
      if (report.colisiones === 0) await cerrarMarca(client, organizationId, rows.length)
    }

    // 4) El CHECK `NOT VALID` de la migración pasa a validado si —y sólo si— no
    //    queda ni una fila con los tipos viejos EN TODA la base.
    if (opts.apply) {
      try {
        await client.query(`ALTER TABLE report_runs VALIDATE CONSTRAINT report_runs_no_cashflow_legacy`)
        await client.query(`ALTER TABLE manual_review_flags VALIDATE CONSTRAINT manual_review_flags_no_cashflow_legacy`)
        report.checkValidado = true
      } catch {
        // Quedan filas viejas en otra organización: se deja `NOT VALID` y se
        // dice. Validar a medias sería declarar cerrada una conversión abierta.
        report.checkValidado = false
      }
    }
  })

  return report
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.org && !args.all) {
    console.error("Uso: migrate-cashflow-report-type.ts (--all | --org <uuid>) [--apply]")
    process.exitCode = 1
    return
  }
  maintenanceDatabaseUrl()

  console.log(
    `Unificación de ReportType.CASHFLOW (ADR-0015 D4) — ámbito: ${args.org ?? "TODAS las organizaciones"}, ` +
      `${args.apply ? "APLICANDO" : "SIMULACIÓN (sin --apply no escribe nada)"}`
  )
  const report = await migrateCashflowReportType(args)
  console.log(
    `\nOrganizaciones ${report.organizations} · ReportRun convertidos ${report.runs} · ` +
      `ManualReviewFlag reapuntados ${report.flags} · colisiones de clave ${report.colisiones}`
  )
  if (report.apply) {
    console.log(
      report.checkValidado
        ? "CHECK validado: no queda ni una fila con CASHFLOW_DIRECTO/CASHFLOW_INDIRECTO."
        : "El CHECK sigue NOT VALID: quedan filas con los tipos viejos (o el ámbito fue parcial)."
    )
    console.log(
      "Aviso (ADR-0015 §Consecuencias): el `paramsHash` recalculado NO es el que estos runs tenían. " +
        "El histórico sigue siendo legible y auditable; su clave de reutilización, no: el primer cashflow " +
        "que se pida después se recalculará."
    )
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith("migrate-cashflow-report-type.ts")) {
  await main()
}
