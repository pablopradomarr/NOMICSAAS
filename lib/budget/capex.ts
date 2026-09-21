/**
 * E12 · T19 — **Presupuesto de inversiones** y la dotación que de él se deriva
 * (Q-4 de `docs/design/E10-validacion-controlling.md`; ADR-0018 **D2
 * ENMENDADA** el 2026-09-15).
 *
 * Módulo **PURO** y **ENTERO**: sin IO, sin Prisma, sin LLM, sin `Date.now()`.
 * El hook `.claude/hooks/guard.sh` cubre `lib/budget/**` desde E10 · T3.
 *
 * ## Qué resuelve, y por qué no es una línea más de `budget_lines`
 *
 * «Presupuestar la `68x` a mano» no es aceptable como estado final, porque **la
 * mayor parte de esa cifra ya es determinista**: los activos en alta tienen su
 * cuadro calculado por el motor de E3/E9, y `proposeDepreciationBudget()` ya los
 * precarga desde E10. Lo que faltaba es el otro sumando: **lo que todavía no se
 * ha comprado**. Una inversión prevista en abril cambia el EBIT presupuestado de
 * mayo a diciembre, y hasta hoy había que teclear ese efecto a mano en la línea
 * que separa EBITDA de EBIT — que es exactamente donde un error de seis cifras
 * no se ve.
 *
 * El grupo 2 no cabe en `budget_lines` (CHECK `budget_lines_pnl_only`), y
 * levantarlo habría mezclado un presupuesto de **balance** con uno de
 * **explotación** en la misma tabla. De ahí `BudgetCapexLine`.
 *
 * ## La aritmética, entera y sin residuo
 *
 * La base amortizable es `amountCents − residualCents`. Se reparte entre los
 * `usefulLifeMonths` con **reparto por mayor resto** (`splitLargestRemainder`,
 * el mismo de toda la casa), de modo que **Σ dotaciones = base**, exactamente,
 * sin el céntimo que se pierde cuando se divide y se redondea mes a mes. De ese
 * calendario completo, el presupuesto del ejercicio se queda **sólo con los
 * meses que caen dentro**.
 *
 * *Ejemplo de Q-4:* 3.000.000 c, lineal a 5 años, alta en abril ⇒ 50.000 c/mes
 * de abril a diciembre = **450.000 c** en el ejercicio. Es un número que el
 * sistema conoce y que el diseño de E10 pedía teclear.
 *
 * ## Qué NO hace
 *
 * No postea nada, no crea un `FixedAsset` y no toca `budget_lines`: **propone**,
 * igual que `deriveHourlyCost` y que `proposeDepreciationBudget`. Que la cifra
 * sea determinista no la convierte en un hecho: el hecho es la compra, y la
 * compra todavía no ha ocurrido.
 */

import { splitLargestRemainder } from "@/lib/money"
import type { BudgetDimension, Cents, LocalDate } from "@/lib/budget/types"
import { fiscalYearMonths, monthKey, monthStart } from "@/lib/budget/types"

/** Métodos que este motor sabe repartir. Los demás se declaran, no se inventan. */
export const CAPEX_METHODS = ["LINEAL", "SUMA_DIGITOS"] as const
export type CapexMethod = (typeof CAPEX_METHODS)[number]

/** Cuándo arranca la dotación respecto del mes de alta (D-3 de E9). */
export type CapexStart = "MES_DE_ALTA" | "MES_SIGUIENTE"

/**
 * Una inversión prevista. `month` es el **mes de alta**, no el de pago: es aquel
 * desde el que el activo empieza a amortizar.
 */
export type BudgetCapexCell = {
  month: LocalDate
  /** Cuenta del grupo 2. El CHECK de la base exige que empiece por `2`. */
  accountCode: string
  dimension: BudgetDimension
  /** Positivo: un activo que entra no es un gasto. */
  amountCents: Cents
  /** Valor residual previsto, que no se amortiza. */
  residualCents: Cents
  method: CapexMethod
  usefulLifeMonths: number
  startsAt: CapexStart
}

export type CapexDotation = {
  /** `YYYY-MM`. */
  month: string
  dimension: BudgetDimension
  /**
   * Dotación del mes, **positiva**. Quien la convierte en aporte de la `68x`
   * —es decir, en negativo (D2)— es `capexToBudgetCells`, y lo hace en un solo
   * sitio a propósito.
   */
  amountCents: Cents
}

/** Desplazamiento del primer mes con dotación respecto del mes de alta. */
const startOffset = (startsAt: CapexStart): number => (startsAt === "MES_SIGUIENTE" ? 1 : 0)

/** `YYYY-MM` + n meses. Aritmética de calendario, sin `Date`. */
export function addMonths(month: string, n: number): string {
  const year = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  const total = year * 12 + (m - 1) + n
  return `${String(Math.floor(total / 12)).padStart(4, "0")}-${String((total % 12) + 1).padStart(2, "0")}`
}

/**
 * Pesos del reparto por método.
 *
 * `LINEAL` reparte a partes iguales; `SUMA_DIGITOS` da al mes *i* el peso
 * `n − i` (dígitos decrecientes), que es el método degresivo del PGC. Con el
 * reparto por mayor resto, **los dos suman la base exactamente**.
 */
function weightsFor(method: CapexMethod, months: number): number[] {
  if (method === "SUMA_DIGITOS") return Array.from({ length: months }, (_, i) => months - i)
  return Array.from({ length: months }, () => 1)
}

/**
 * Calendario COMPLETO de dotaciones de una inversión, mes a mes y a lo largo de
 * toda su vida útil — no sólo del ejercicio.
 *
 * Se calcula entero y después se recorta, y no al revés: repartir sólo sobre
 * los meses del ejercicio daría una dotación mensual distinta según dónde
 * cortara el año, que es el error clásico.
 */
export function capexSchedule(cell: BudgetCapexCell): readonly CapexDotation[] {
  const base = cell.amountCents - cell.residualCents
  if (base <= 0 || cell.usefulLifeMonths <= 0) return []
  const first = addMonths(monthKey(cell.month), startOffset(cell.startsAt))
  const amounts = splitLargestRemainder(base, weightsFor(cell.method, cell.usefulLifeMonths))
  return amounts.map((amountCents, i) => ({
    month: addMonths(first, i),
    dimension: cell.dimension,
    amountCents,
  }))
}

/**
 * Dotación presupuestada de un conjunto de inversiones **dentro de un
 * ejercicio**, agregada por `(mes, dimensión)`.
 *
 * Determinista y ordenada: por mes y, dentro del mes, por clase y código de
 * dimensión. Sin eso, dos ejecuciones podrían producir el mismo total en otro
 * orden y el sello no sería reproducible.
 */
export function capexDepreciationForFiscalYear(
  cells: readonly BudgetCapexCell[],
  fiscalYearStart: LocalDate,
  fiscalYearEnd: LocalDate
): readonly CapexDotation[] {
  const months = new Set(fiscalYearMonths(fiscalYearStart, fiscalYearEnd))
  const byKey = new Map<string, CapexDotation>()
  for (const cell of cells) {
    for (const dot of capexSchedule(cell)) {
      if (!months.has(dot.month)) continue
      const key = `${dot.month}\t${dot.dimension.kind}\t${dot.dimension.code}`
      const prev = byKey.get(key)
      if (prev) prev.amountCents += dot.amountCents
      else byKey.set(key, { ...dot })
    }
  }
  return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v)
}

/** Total de la dotación derivada del CAPEX en el ejercicio. */
export const capexDepreciationTotal = (dotations: readonly CapexDotation[]): Cents =>
  dotations.reduce((acc, d) => acc + d.amountCents, 0)

/**
 * La **propuesta** de líneas `68x` que el CAPEX aporta al presupuesto de
 * explotación, ya con el signo de aporte de D2: una dotación es un gasto, y un
 * gasto es **negativo**.
 *
 * Se llama propuesta y no aplicación a propósito (patrón `deriveHourlyCost`):
 * devuelve celdas, no las escribe. El usuario las acepta, las edita o las
 * ignora — y si las ignora, la dotación del CAPEX **no está** en el EBIT
 * presupuestado, que es una decisión suya y queda a la vista en el bloque de
 * conciliación de la pantalla.
 */
export function capexToBudgetCells(
  dotations: readonly CapexDotation[],
  opts: { accountCode?: string } = {}
): readonly {
  month: LocalDate
  accountCode: string
  dimension: BudgetDimension
  amountCents: Cents
}[] {
  const accountCode = opts.accountCode ?? DEFAULT_DEPRECIATION_ACCOUNT
  return dotations.map((d) => ({
    month: monthStart(d.month),
    accountCode,
    dimension: d.dimension,
    // D2 · APORTE: ingreso +, gasto −. La dotación es gasto.
    amountCents: -d.amountCents,
  }))
}

/**
 * `681` — «Amortización del inmovilizado material» del PGC 2007. Es el destino
 * por omisión de la propuesta; la pantalla deja elegir otra `68x` cuando la
 * inversión es intangible (`680`) o inversión inmobiliaria (`682`).
 */
export const DEFAULT_DEPRECIATION_ACCOUNT = "681"
