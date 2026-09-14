import type { AssetDetail } from "@/app/(app)/settings/assets/actions"

/**
 * E9 · T17 — Vista del activo tal como la recibe la pantalla.
 *
 * `explainedCents` y `mismatch` los calcula el **servidor** (I-E9-3/I-E9-5 en
 * versión de pantalla): la comparación entre lo que el cuadro sellado explica y
 * lo que el diario tiene atribuido al activo es una cifra contable y no se hace
 * en el navegador.
 */
export type AssetView = AssetDetail & {
  /** Σ de las cuotas del cuadro cuyos periodos ya están contabilizados. */
  explainedCents: number
  /** El cuadro sellado no explica los asientos atribuidos al activo. */
  mismatch: boolean
  /** Valor neto contable a la fecha de corte, derivado en el servidor. */
  netBookValueCents: number
}
