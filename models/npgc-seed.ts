/**
 * E2 · T7 — Carga del seed `seeds/npgc.csv` desde disco.
 *
 * El IO vive AQUÍ, fuera de `lib/accounts/` (que es puro y sólo recibe el texto).
 * El fichero se lee una vez por proceso y se cachea en módulo: son 906 filas que
 * no cambian en caliente.
 */

import { parseNpgcCsv } from "@/lib/accounts/csv"
import type { SeedAccount } from "@/lib/accounts/types"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"

export const NPGC_SEED_PATH = path.join(process.cwd(), "seeds", "npgc.csv")

/** Clave del `Setting` donde se guarda el sha256 del seed con el que se sembró (R7). */
export const NPGC_SEED_SHA_SETTING = "npgc.seed.sha256"

let cached: { rows: SeedAccount[]; sha256: string } | null = null

export function loadNpgcSeed(filePath: string = NPGC_SEED_PATH): { rows: SeedAccount[]; sha256: string } {
  if (cached && filePath === NPGC_SEED_PATH) return cached
  const text = readFileSync(filePath, "utf8")
  const parsed = parseNpgcCsv(text)
  if (!parsed.ok) {
    throw new Error(
      `seeds/npgc.csv no es válido:\n  ${parsed.errors.map((e) => `[fila ${e.row ?? "?"}] ${e.message}`).join("\n  ")}`
    )
  }
  const result = { rows: parsed.value, sha256: createHash("sha256").update(text).digest("hex") }
  if (filePath === NPGC_SEED_PATH) cached = result
  return result
}
