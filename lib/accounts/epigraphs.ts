/**
 * E2 · T3 — Epígrafes de las cuentas anuales (§3, reglas R-15 y R-16).
 * Módulo puro.
 */

import { accountGroup } from "@/lib/accounts/codes"
import type { AccountWarning, AnalyticType, PgcVariant, PlanAccount, SeedAccount, Statement } from "@/lib/accounts/types"

/**
 * Único punto del código que elige entre las dos columnas de epígrafe (C-1).
 * PYMES cae al epígrafe del modelo normal si la variante abreviada no lo trae.
 */
export function epigraphFor(
  account: Pick<PlanAccount, "epigraph" | "epigraphPymes">,
  variant: PgcVariant
): string | null {
  return variant === "PYMES" ? (account.epigraphPymes ?? account.epigraph) : account.epigraph
}

/**
 * R-15: catálogo CERRADO de epígrafes de la variante, derivado del seed. Nada de
 * texto libre que después no agregue en ningún informe.
 */
export function epigraphCatalog(rows: readonly SeedAccount[], variant: PgcVariant): ReadonlySet<string> {
  const out = new Set<string>()
  for (const row of rows) {
    if (variant === "PYMES" && !row.pymes) continue
    const value = variant === "PYMES" ? (row.epigraphPymes ?? row.epigraph) : row.epigraph
    if (value) out.add(value)
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// R-16 — coherencia `epigraph` ↔ `analyticType`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bloques de la PyG por número de epígrafe (puerto de `validate_analytic_coherence`
 * de `seeds/build_npgc.py`): 1–13 explotación · 14–19 financiero · 20 impuesto.
 * El modelo PYMES desplaza la numeración (13→12 … 20→19), así que el corte se
 * calcula por variante.
 */
const EXPLOTACION: ReadonlySet<AnalyticType> = new Set<AnalyticType>([
  "INGRESO_DIRECTO",
  "COSTE_DIRECTO_MC1",
  "COSTE_DIRECTO_MC2",
  "INDIRECTO_CECO",
  "AMORTIZACION_DETERIORO",
  "NO_ANALITICO",
])
const FINANCIERO: ReadonlySet<AnalyticType> = new Set<AnalyticType>(["FINANCIERO", "NO_ANALITICO"])
const IMPUESTO: ReadonlySet<AnalyticType> = new Set<AnalyticType>(["NO_ANALITICO"])

/** Límite superior del bloque de explotación y del financiero por variante. */
function blockBounds(variant: PgcVariant): { operating: number; financial: number } {
  return variant === "PYMES" ? { operating: 12, financial: 18 } : { operating: 13, financial: 19 }
}

export type PygBlock = "EXPLOTACION" | "FINANCIERO" | "IMPUESTO" | "DESCONOCIDO"

/** Bloque de PyG al que pertenece un epígrafe («15. Gastos financieros» → FINANCIERO). */
export function pygBlockOf(epigraph: string | null, variant: PgcVariant): PygBlock {
  if (!epigraph) return "DESCONOCIDO"
  const head = epigraph.split(".")[0].trim()
  if (!/^\d+$/.test(head)) return "DESCONOCIDO"
  const n = Number(head)
  const { operating, financial } = blockBounds(variant)
  if (n <= operating) return "EXPLOTACION"
  if (n <= financial) return "FINANCIERO"
  return "IMPUESTO"
}

export function allowedAnalyticTypes(block: PygBlock): ReadonlySet<AnalyticType> | null {
  if (block === "EXPLOTACION") return EXPLOTACION
  if (block === "FINANCIERO") return FINANCIERO
  if (block === "IMPUESTO") return IMPUESTO
  return null
}

/**
 * R-16 sobre UNA cuenta: `true` si el tipo analítico cabe en el bloque de PyG de
 * su epígrafe. Sólo aplica a cuentas de PyG (grupos 6/7) con ambos datos.
 */
export function isAnalyticCoherent(
  account: Pick<PlanAccount, "code" | "statement" | "epigraph" | "epigraphPymes" | "analyticType">,
  variant: PgcVariant
): boolean {
  if (account.statement !== ("PYG" as Statement)) return true
  if (!account.analyticType) return true
  const group = accountGroup(account.code)
  if (group !== "6" && group !== "7") return true
  const allowed = allowedAnalyticTypes(pygBlockOf(epigraphFor(account, variant), variant))
  if (!allowed) return true
  return allowed.has(account.analyticType)
}

/**
 * I-E2-6 (aviso, nunca bloqueo): divergencias entre `analyticType` y el bloque
 * de PyG del epígrafe. Sobre el seed entregado debe devolver la lista vacía.
 */
export function checkAnalyticCoherence(
  accounts: readonly Pick<PlanAccount, "code" | "statement" | "epigraph" | "epigraphPymes" | "analyticType">[],
  variant: PgcVariant
): AccountWarning[] {
  const out: AccountWarning[] = []
  for (const account of accounts) {
    if (isAnalyticCoherent(account, variant)) continue
    out.push({
      code: "ANALYTIC_INCOHERENT",
      accountCode: account.code,
      message:
        `La cuenta ${account.code} tiene tipo analítico ${account.analyticType} y epígrafe ` +
        `«${epigraphFor(account, variant)}», que pertenece al bloque ` +
        `${pygBlockOf(epigraphFor(account, variant), variant)} de la PyG`,
    })
  }
  return out
}
