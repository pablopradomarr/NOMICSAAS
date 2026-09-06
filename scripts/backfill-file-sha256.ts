/**
 * E8 · T4 (G-11) — Backfill de `files.sha256`.
 *
 * `files.sha256` es el eslabón que ata un asiento a los bytes exactos del
 * documento: I-E8-2 lo comprueba contra el disco y contra
 * `extraction_runs.file_sha256`, RC-10 lo exige antes de contabilizar, e I-E8-9
 * prohíbe que un fichero sin sha tenga run `LLM` o asiento. La migración
 * `20260913100000_e8_documentos` crea la columna **nullable** porque una
 * migración no lee el sistema de ficheros; el sha lo calcula este script, y
 * `20260914090000_e8_file_sha256_not_null` sólo endurece lo que aquí quede
 * completo.
 *
 * Decisiones de operación, todas por el mismo motivo —hay miles de ficheros y
 * el proceso tiene que poder cortarse y reanudarse—:
 *
 *  · **Por organización** (`--org`) o todas (`--all`). Nunca implícito.
 *  · **En lotes reanudables** (`--batch`, 200 por defecto): sólo mira los que
 *    tienen `sha256 IS NULL`, así que volver a lanzarlo continúa donde iba.
 *  · **Los bytes que ya no están NO se inventan.** Un fichero cuyo binario ha
 *    desaparecido se marca `metadata.integrity = "MISSING"` y se queda sin sha:
 *    poner el sha del vacío haría pasar por íntegro un documento que no existe,
 *    que es exactamente el fraude que I-E8-2 debe detectar.
 *  · **DRY-RUN por defecto.** Sin `--apply` no escribe nada.
 *
 * Conecta como `app_maintenance` (BYPASSRLS, ADR-0009 §6): recorre varias
 * organizaciones y con `app_runtime` vería 0 filas en silencio.
 *
 * Uso:
 *   DATABASE_URL_MAINTENANCE=… npx tsx scripts/backfill-file-sha256.ts --all
 *   DATABASE_URL_MAINTENANCE=… npx tsx scripts/backfill-file-sha256.ts --all --apply
 *   DATABASE_URL_MAINTENANCE=… npx tsx scripts/backfill-file-sha256.ts --org <uuid> --apply --batch 500
 */

import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"

import { maintenanceDatabaseUrl, withMaintenanceClient } from "@/lib/db-maintenance"
import { FILE_UPLOAD_PATH } from "@/lib/files"

type Row = {
  id: string
  organization_id: string
  path: string
  metadata: Record<string, unknown> | null
}

export type BackfillReport = {
  scanned: number
  hashed: number
  missing: number
  pending: number
  apply: boolean
  /** `true` cuando `files.sha256` ha quedado endurecida a NOT NULL. */
  hardened?: boolean
}

function parseArgs(argv: readonly string[]) {
  const org = argv.includes("--org") ? argv[argv.indexOf("--org") + 1] : null
  const batchRaw = argv.includes("--batch") ? Number(argv[argv.indexOf("--batch") + 1]) : 200
  return {
    org,
    all: argv.includes("--all"),
    apply: argv.includes("--apply"),
    batch: Number.isFinite(batchRaw) && batchRaw > 0 ? Math.floor(batchRaw) : 200,
  }
}

/**
 * Ruta absoluta del binario. `files.path` es RELATIVO al directorio de la
 * organización desde E1-fix (#3), y se resuelve aquí y no con
 * `getOrganizationUploadsDirectory` para no cargar el modelo entero por un
 * `join`. El `resolve` + comprobación de prefijo evita que un `path` con `..`
 * lea fuera del árbol de subidas.
 */
function fullPathFor(organizationId: string, relativePath: string): string | null {
  const base = path.resolve(FILE_UPLOAD_PATH, organizationId)
  const full = path.resolve(base, relativePath)
  return full === base || full.startsWith(base + path.sep) ? full : null
}

export async function backfillFileSha256(
  opts: { org?: string | null; apply: boolean; batch: number },
  log: (message: string) => void = console.log
): Promise<BackfillReport> {
  const report: BackfillReport = { scanned: 0, hashed: 0, missing: 0, pending: 0, apply: opts.apply }

  await withMaintenanceClient(async (client) => {
    for (;;) {
      const { rows } = await client.query<Row>(
        `SELECT id, organization_id, path, metadata
           FROM files
          WHERE sha256 IS NULL
            AND ($1::uuid IS NULL OR organization_id = $1::uuid)
            AND coalesce(metadata->>'integrity', '') <> 'MISSING'
          ORDER BY organization_id, created_at
          LIMIT $2`,
        [opts.org ?? null, opts.batch]
      )
      if (rows.length === 0) break

      for (const row of rows) {
        report.scanned++
        const full = fullPathFor(row.organization_id, row.path)
        if (!full) {
          log(`  ! ${row.id}: ruta fuera del árbol de subidas (${row.path}); se marca MISSING`)
          report.missing++
          if (opts.apply) await markMissing(client, row)
          continue
        }
        let buffer: Buffer
        try {
          await stat(full)
          buffer = await readFile(full)
        } catch {
          // Los bytes ya no están. No se inventa un sha: se declara.
          report.missing++
          log(`  ! ${row.id}: sin bytes en disco (${row.path}); se marca MISSING`)
          if (opts.apply) await markMissing(client, row)
          continue
        }
        const sha = createHash("sha256").update(buffer).digest("hex")
        report.hashed++
        if (opts.apply) {
          await client.query(`UPDATE files SET sha256 = $2, size_bytes = $3 WHERE id = $1::uuid`, [
            row.id,
            sha,
            buffer.length,
          ])
        }
      }

      // En simulación no se escribe nada, así que la consulta devolvería el
      // mismo lote para siempre: un solo lote basta para informar.
      if (!opts.apply) break
    }

    const { rows } = await client.query<{ pending: string }>(
      `SELECT count(*)::text AS pending
         FROM files
        WHERE sha256 IS NULL AND ($1::uuid IS NULL OR organization_id = $1::uuid)`,
      [opts.org ?? null]
    )
    report.pending = Number(rows[0]?.pending ?? 0)

    // El endurecimiento a NOT NULL lo aplica la propia base en cuanto no quedan
    // pendientes (`20260914090000_e8_file_sha256_not_null`), y se pide aquí para
    // que no haga falta un segundo despliegue: el operador corre el backfill y
    // la columna queda cerrada sola. Cuenta TODAS las organizaciones, no sólo la
    // del `--org`, así que con un ámbito parcial simplemente no hará nada.
    if (opts.apply) {
      const { rows: hardened } = await client.query<{ harden_files_sha256: string }>(
        `SELECT app.harden_files_sha256()`
      )
      report.hardened = Number(hardened[0]?.harden_files_sha256 ?? 0) === 0
    }
  })

  return report
}

async function markMissing(client: { query: (sql: string, params: unknown[]) => Promise<unknown> }, row: Row) {
  await client.query(`UPDATE files SET metadata = coalesce(metadata, '{}'::jsonb) || $2::jsonb WHERE id = $1::uuid`, [
    row.id,
    JSON.stringify({ integrity: "MISSING" }),
  ])
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.org && !args.all) {
    console.error("Uso: backfill-file-sha256.ts (--all | --org <uuid>) [--apply] [--batch N]")
    process.exitCode = 1
    return
  }
  maintenanceDatabaseUrl() // aborta con mensaje explícito si falta la credencial

  console.log(
    `Backfill de files.sha256 — ámbito: ${args.org ?? "TODAS las organizaciones"}, ` +
      `lote ${args.batch}, ${args.apply ? "APLICANDO" : "SIMULACIÓN (sin --apply no escribe nada)"}`
  )
  const report = await backfillFileSha256(args)
  console.log(
    `\nRevisados ${report.scanned} · con sha ${report.hashed} · sin bytes ${report.missing} · ` +
      `PENDIENTES ${report.pending}`
  )
  if (report.hardened) {
    console.log("`files.sha256` queda endurecida a NOT NULL: ya no entra un fichero sin su sha (I-E8-9).")
  } else if (report.pending > 0) {
    console.log(
      "Quedan ficheros sin sha256, así que la columna sigue admitiendo NULL. Los marcados MISSING hay que " +
        "resolverlos a mano: recuperar el binario y volver a lanzar, o dar de baja el fichero."
    )
  }
}

// Sólo se ejecuta como CLI; importado desde un test, no arranca nada.
if (process.argv[1] && path.resolve(process.argv[1]).endsWith("backfill-file-sha256.ts")) {
  await main()
}
