/**
 * E9 · T17 — Tabla de amortización del **art. 12.1 LIS** (ADR-0016 D2, O-23).
 *
 * Es una **sugerencia de la interfaz** y nada más: el coeficiente máximo y el
 * periodo máximo que la ley da por elemento sirven para proponer una vida útil
 * al dar de alta un activo, pero la vida útil que se contabiliza es la
 * **económica** (NRV 2ª.2.1) y la decide quien da el alta.
 *
 * Y lo que nunca ocurre: la **amortización fiscal no se contabiliza**. Si la
 * fiscal difiere de la contable, la diferencia es un ajuste extracontable del
 * modelo 200 —fuera del diario— y no una segunda dotación (art. 10.3 LIS).
 *
 * Datos: tabla del art. 12.1.a) LIS (Ley 27/2014). `maxRatePct` es el
 * coeficiente lineal máximo anual y `maxYears` el periodo máximo de años.
 */

export type LisCoefficient = {
  element: string
  maxRatePct: number
  maxYears: number
}

export const LIS_COEFFICIENTS: readonly LisCoefficient[] = [
  { element: "Obra civil general", maxRatePct: 2, maxYears: 100 },
  { element: "Pavimentos", maxRatePct: 6, maxYears: 34 },
  { element: "Infraestructuras y obras mineras", maxRatePct: 7, maxYears: 30 },
  { element: "Centrales (hidráulicas, nucleares, térmicas)", maxRatePct: 3, maxYears: 75 },
  { element: "Edificios industriales", maxRatePct: 3, maxYears: 68 },
  { element: "Edificios comerciales, administrativos, de servicios y viviendas", maxRatePct: 2, maxYears: 100 },
  { element: "Instalaciones (subestaciones, redes, cables)", maxRatePct: 5, maxYears: 40 },
  { element: "Maquinaria", maxRatePct: 12, maxYears: 18 },
  { element: "Equipos médicos y asimilados", maxRatePct: 15, maxYears: 14 },
  { element: "Locomotoras y material ferroviario", maxRatePct: 8, maxYears: 25 },
  { element: "Buques y aeronaves", maxRatePct: 10, maxYears: 20 },
  { element: "Elementos de transporte interno", maxRatePct: 10, maxYears: 20 },
  { element: "Elementos de transporte externo", maxRatePct: 16, maxYears: 14 },
  { element: "Autocamiones", maxRatePct: 20, maxYears: 10 },
  { element: "Mobiliario", maxRatePct: 10, maxYears: 20 },
  { element: "Lencería", maxRatePct: 25, maxYears: 8 },
  { element: "Cristalería", maxRatePct: 50, maxYears: 4 },
  { element: "Útiles y herramientas", maxRatePct: 25, maxYears: 8 },
  { element: "Moldes, matrices y modelos", maxRatePct: 33, maxYears: 6 },
  { element: "Otros enseres", maxRatePct: 15, maxYears: 14 },
  { element: "Equipos electrónicos", maxRatePct: 20, maxYears: 10 },
  { element: "Equipos para procesos de información", maxRatePct: 25, maxYears: 8 },
  { element: "Sistemas y programas informáticos", maxRatePct: 33, maxYears: 6 },
  { element: "Producciones cinematográficas, fonográficas, vídeos y series", maxRatePct: 33, maxYears: 6 },
  { element: "Otros elementos", maxRatePct: 10, maxYears: 20 },
]

/**
 * Vida útil **sugerida** en meses a partir del coeficiente máximo: el número
 * entero de meses que agota el elemento al coeficiente lineal máximo. Es un
 * valor para prerrellenar un campo, no una cifra contable.
 */
export function suggestedLifeMonths(coefficient: LisCoefficient): number {
  return Math.round((100 / coefficient.maxRatePct) * 12)
}
