/**
 * E8 · T10 — Acceso a `exchange_rates`.
 *
 * `exchange_rates` es la única tabla de **referencia global** del producto
 * (ADR-0014 D7, `GLOBAL_REFERENCE_MODELS` en `lib/db.ts`): una tasa del BCE es
 * un dato público y el mismo para todos. Tenerla por organización sería
 * multiplicar la misma fila y abrir la puerta a que dos empresas convirtieran
 * el mismo día a tipos distintos. No es un agujero: la tabla lleva `ENABLE` +
 * `FORCE ROW LEVEL SECURITY` con lectura e inserción abiertas y `UPDATE`/
 * `DELETE` cerrados por política RESTRICTIVE — es append-only (I-E8-14).
 *
 * Este módulo **no calcula**: la conversión vive en `lib/fx/convert.ts` (puro) y
 * la obtención de la tasa en `lib/fx/rates.ts` (IO contra la fuente única).
 * Aquí sólo está la fachada que consumen las server actions de T13.
 */

export {
  ExchangeRateUnavailableError,
  RATE_SOURCE_ECB,
  RATE_SOURCE_IDENTITY,
  getOrFetchRate,
  listRatesForPeriod,
  newRateMemo,
  type RateMemo,
} from "@/lib/fx/rates"

export { convertCents, convertProposal, convertProposalWithReport, FxConversionError, type RateRef } from "@/lib/fx/convert"

import type { TenantClient } from "@/lib/db"
import { getOrFetchRate, newRateMemo, type RateMemo } from "@/lib/fx/rates"
import { convertProposalWithReport, type ConversionReport, type RateRef } from "@/lib/fx/convert"
import type { ExtractionProposal } from "@/lib/extraction/types"

/**
 * Convierte una propuesta a la moneda base resolviendo la tasa de su
 * `documentDate`.
 *
 * Firma pública para **T13** (`confirmProposalAction`) y para T18.
 *
 * @throws ExchangeRateUnavailableError si no hay tasa. Nunca devuelve una
 *         propuesta «aproximada»: sin tasa no hay asiento.
 */
export async function convertProposalToBase(
  db: TenantClient,
  proposal: ExtractionProposal,
  baseCurrency: string,
  memo: RateMemo = newRateMemo()
): Promise<{ proposal: ExtractionProposal; rate: RateRef; report: ConversionReport }> {
  const documentDate = proposal.documentDate
  if (!documentDate) {
    throw new Error("Sin fecha de documento no hay tasa que aplicar: la tasa es la del día de la transacción (D2)")
  }
  const rate = await getOrFetchRate(db, documentDate, proposal.currency, baseCurrency, memo)
  const { proposal: converted, report } = convertProposalWithReport(proposal, rate, baseCurrency)
  return { proposal: converted, rate, report }
}
