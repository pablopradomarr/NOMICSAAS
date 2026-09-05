/**
 * E4 · T6 — Destino analítico por defecto de las líneas que la PLANTILLA
 * decide, no el usuario (`docs/design/E4-analitica.md` §3.3, tabla de
 * `templates/*`).
 *
 * Cuatro huecos que E3 dejó sin destino y que C-9, ya activo, bloquearía:
 *
 * | Línea | CECO por defecto | Plantillas |
 * |---|---|---|
 * | comisión bancaria `626` | `G_A` | T-08, T-09, T-19 |
 * | recargo `631` e intereses de demora `669` | `G_A` | T-11…T-13, T-24 |
 * | diferencia de cambio `668`/`768` y redondeo `669`/`769` | `FINANCIERO` | T-08, T-09 |
 * | gastos e ingresos excepcionales `678`/`778` | `G_A` | T-22 |
 *
 * Son **defaults**, no imposiciones: el input de la plantilla puede traer su
 * propio `costCenterId` (o un `projectId`, que por R-A3 deja el importe en MC2
 * del proyecto — el caso del aval de licitación de §8.6).
 *
 * Módulo PURO.
 */

import type { CostCenterKind } from "@/lib/analytics/types"
import type { LedgerContext } from "@/lib/ledger/types"

/**
 * Id del CECO activo de ese `kind`. `null` cuando las dimensiones todavía no
 * están disponibles (E3) o la organización lo ha archivado: en ese caso la
 * línea sale sin destino y C-9 decide — bloquear o rutear a `CC-NA` según
 * `analyticsRequired` (R-A8). Nunca se inventa un destino.
 */
export function defaultCostCenterId(ctx: LedgerContext, kind: CostCenterKind): string | null {
  if (!ctx.dimensions.available) return null
  const candidates = (ctx.dimensions.costCenters ?? []).filter((c) => c.kind === kind && c.isActive)
  if (candidates.length === 0) return null
  // Orden estable: `sortOrder` y, a igualdad, el código. Dos CECOs del mismo
  // kind no pueden producir un destino que dependa del orden de lectura.
  return [...candidates].sort((a, b) => a.sortOrder - b.sortOrder || (a.code < b.code ? -1 : 1))[0].id
}

/** Destino de una línea de plantilla: lo que traiga el input, o el default. */
export function templateDestination(
  ctx: LedgerContext,
  fallbackKind: CostCenterKind,
  given: { projectId?: string | null; costCenterId?: string | null } = {}
): { projectId: string | null; costCenterId: string | null } {
  if (given.projectId) return { projectId: given.projectId, costCenterId: null }
  if (given.costCenterId) return { projectId: null, costCenterId: given.costCenterId }
  return { projectId: null, costCenterId: defaultCostCenterId(ctx, fallbackKind) }
}
