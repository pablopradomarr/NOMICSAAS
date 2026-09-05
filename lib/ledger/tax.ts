/**
 * E3 · T4 — Aritmética fiscal común a las plantillas
 * (`docs/design/E3-asientos-tipo.md` §0.1). Módulo PURO.
 *
 * Todo pasa por `applyBps` de `lib/taxes/bps.ts`: entero puro, half-up sobre la
 * magnitud (R-IVA-2), que es la convención de la AEAT y no el half-even del
 * banquero de `lib/money.ts`.
 */

import { applyBps } from "@/lib/taxes/bps"
import type { Cents, LedgerContext, LedgerError, LocalDate, TaxRateRow, TaxRoundingMode } from "@/lib/ledger/types"
import { err } from "@/lib/ledger/types"
import { toUtcDate } from "@/lib/ledger/dates"
import { selectTaxRate, taxAppliesToSide } from "@/lib/taxes/rates"
import type { TaxSide } from "@/lib/taxes/types"

/** Una base imponible con el código de tipo que le aplica. */
export type TaxableBase = {
  baseCents: Cents
  taxRateCode: string
}

export const BPS_FULL = 10000

/** R-IVA-1 (`PER_TIPO`, default): UN solo redondeo sobre la base agregada. */
export function cuotaPorTipo(bases: readonly Cents[], rateBps: number): Cents {
  const total = bases.reduce((a, b) => a + b, 0)
  return applyBps(total, rateBps)
}

/** R-IVA-3 (`PER_LINEA`): cuota por línea, sumada. Nunca se mezcla con la anterior. */
export function cuotaPorLinea(bases: readonly Cents[], rateBps: number): Cents {
  return bases.reduce((acc, b) => acc + applyBps(b, rateBps), 0)
}

/** Aplica el modo de redondeo SELLADO en el asiento (O-2, R-IVA-4). */
export function cuota(bases: readonly Cents[], rateBps: number, mode: TaxRoundingMode): Cents {
  return mode === "PER_LINEA" ? cuotaPorLinea(bases, rateBps) : cuotaPorTipo(bases, rateBps)
}

/** R-IVA-6: la retención se calcula UNA vez sobre la base total del documento. */
export function retencion(baseTotalCents: Cents, rateBps: number): Cents {
  return applyBps(baseTotalCents, rateBps)
}

export type Deducibilidad = "FULL" | "NONE" | "PRORRATA"

/**
 * Reparto de una cuota soportada entre deducible y no deducible. El NO
 * deducible **engorda la línea de gasto o de inmovilizado** (art. 103 LIVA,
 * NRV 2ª y 10ª), nunca ajusta la 472.
 */
export function deducible(
  cuotaCents: Cents,
  deductibility: Deducibilidad,
  prorrataBps: number | null
): { deducibleCents: Cents; noDeducibleCents: Cents } | null {
  if (deductibility === "FULL") return { deducibleCents: cuotaCents, noDeducibleCents: 0 }
  if (deductibility === "NONE") return { deducibleCents: 0, noDeducibleCents: cuotaCents }
  if (prorrataBps === null) return null // PRORRATA_NOT_CONFIGURED, lo decide el llamante
  const deducibleCents = applyBps(cuotaCents, prorrataBps)
  return { deducibleCents, noDeducibleCents: cuotaCents - deducibleCents }
}

export type AjusteRedondeo =
  | { kind: "NONE" }
  | { kind: "GASTO" | "INGRESO"; amountCents: Cents }
  | { kind: "ERROR"; error: LedgerError }

/**
 * R-IVA-7: una diferencia residual `|dif| ≤ tolerancia` se lleva a
 * `REDONDEO_GASTO`/`REDONDEO_INGRESO`; por encima, error y no se persiste nada.
 *
 * Convención de signo: `diff > 0` = falta importe al debe (gasto de redondeo).
 */
export function ajusteRedondeo(diffCents: number, ctx: Pick<LedgerContext, "policy">): AjusteRedondeo {
  if (diffCents === 0) return { kind: "NONE" }
  const tolerance = ctx.policy.redondeoToleranciaCents
  if (Math.abs(diffCents) > tolerance) {
    return {
      kind: "ERROR",
      error: err(
        "TAX_ROUNDING_EXCEEDED",
        "totalCents",
        `Diferencia de redondeo de ${diffCents} céntimos, por encima de la tolerancia de ${tolerance}`,
        { check: "R-IVA-7" }
      ),
    }
  }
  return diffCents > 0 ? { kind: "GASTO", amountCents: diffCents } : { kind: "INGRESO", amountCents: -diffCents }
}

/**
 * C-10: el tipo se selecciona con `documentDate`, NO con `entryDate` (un
 * documento de 2025 contabilizado en 2026 lleva el tipo de 2025).
 */
export function selectRate(
  ctx: Pick<LedgerContext, "rates">,
  code: string,
  documentDate: LocalDate,
  side: TaxSide
): { rate: TaxRateRow } | { error: LedgerError } {
  const rate = selectTaxRate(ctx.rates, code, toUtcDate(documentDate))
  if (!rate) {
    return {
      error: err("TAX_RATE_NOT_IN_FORCE", "taxRateCode", `No hay ningún tipo ${code} vigente a ${documentDate}`, {
        check: "C-10",
      }),
    }
  }
  if (!taxAppliesToSide(rate, side)) {
    return {
      error: err(
        "TAX_SIDE_MISMATCH",
        "taxRateCode",
        `El tipo ${code} no es aplicable del lado ${side === "SALE" ? "de venta" : "de compra"}`,
        { check: "C-10" }
      ),
    }
  }
  return { rate }
}

/**
 * Agrupa bases por código de tipo conservando el orden de aparición: las líneas
 * de cuota se emiten en ese mismo orden y así el asiento es reproducible.
 */
export function groupBasesByRate(bases: readonly TaxableBase[]): { code: string; bases: Cents[] }[] {
  const out: { code: string; bases: Cents[] }[] = []
  const index = new Map<string, number>()
  for (const b of bases) {
    const at = index.get(b.taxRateCode)
    if (at === undefined) {
      index.set(b.taxRateCode, out.length)
      out.push({ code: b.taxRateCode, bases: [b.baseCents] })
    } else {
      out[at].bases.push(b.baseCents)
    }
  }
  return out
}
