/**
 * E9 · T8 — Mapa del **modelo 303**, versionado con vigencia (O-13, ADR-0016 D4.8).
 *
 * Módulo **PURO**: sin `Date.now()`, sin Prisma, sin IO, sin LLM.
 *
 * ## Por qué una tabla y no un `switch`
 *
 * El 303 cambia por **orden ministerial**, no por decisión del producto. Una
 * cifra declarable atada a un `if` es exactamente lo que ADR-0012 prohíbe: el
 * día que la AEAT renumera una casilla habría que tocar el motor, y el modelo
 * del año anterior dejaría de ser reproducible. Aquí el mapa es **dato con
 * vigencia** (`validFrom`/`validTo`), `model303MapAt(fecha)` elige el vigente y
 * `casillas303` de `lib/closing/vat.ts` sólo **calcula valores**: la etiqueta,
 * la fórmula, el origen y la referencia legal viven en esta tabla.
 *
 * ## Lo que la ronda 1 arregló (O-13)
 *
 * El mapa de la ronda 0 saltaba de la casilla **46** a la **71** y, con ese
 * hueco, el usuario **no podía rellenar el modelo**: entre medias está toda la
 * cadena que convierte el resultado del régimen general en el resultado de la
 * liquidación (`64 · 65 · 66 · 77 · 67 · 69 · 70 · 71`). Sin ella, el invariante
 * que exige `casilla 71 = importe del asiento T-23` **no se podía escribir**.
 *
 * ## Lo que NO se ofrece en v1, y se dice en pantalla
 *
 * `16`–`26` (recargo de equivalencia), `42` (compensaciones REAGP), `47`–`58`
 * (régimen simplificado) y `68` (regularización del art. 80.Cinco.5ª). Cada una
 * está en la tabla con `offered: false` y su motivo: una casilla ausente del
 * mapa es un olvido; una casilla presente y declarada como no ofrecida es una
 * decisión. El **modelo 390** queda fuera del producto (§2).
 */

import type { LocalDate } from "@/lib/ledger/types"

/** Identificador de casilla tal como lo imprime la AEAT: `"01"`, `"46"`, `"77"`. */
export type Model303BoxId = string

export type Model303Origin =
  /** Libro registro de facturas **emitidas**. */
  | "EMITIDAS"
  /** Libro registro de facturas **recibidas** (incluidos DUA e ISP/AIB). */
  | "RECIBIDAS"
  /** Se calcula a partir de otras casillas: la fórmula está en `formula`. */
  | "DERIVADA"
  /** Dato declarado por el contribuyente (compensaciones, % foral, declaración anterior). */
  | "DECLARADA"
  /** No se ofrece en v1. */
  | "NO_OFERTADA"

export type Model303BoxKind = "BASE" | "CUOTA" | "IMPORTE" | "PORCENTAJE"

/** Condición para que la casilla se muestre y se calcule. */
export type Model303Requirement = "RECC" | "IMPORT_DEFERRAL"

export type Model303Box = {
  box: Model303BoxId
  label: string
  kind: Model303BoxKind
  origin: Model303Origin
  /** Fórmula (casillas derivadas) o regla de derivación (casillas de origen). */
  formula: string
  /** Referencia normativa de la casilla. */
  legal: string
  offered: boolean
  /** Por qué no se ofrece. Obligatorio cuando `offered = false`. */
  notOfferedReason?: string
  /** La casilla sólo aplica con este régimen u opción activos. */
  requires?: Model303Requirement
}

export type Model303Map = {
  version: string
  validFrom: LocalDate
  /** `null` = vigente. */
  validTo: LocalDate | null
  boxes: readonly Model303Box[]
}

const box = (
  id: Model303BoxId,
  label: string,
  kind: Model303BoxKind,
  origin: Model303Origin,
  formula: string,
  legal: string,
  extra: Partial<Pick<Model303Box, "offered" | "notOfferedReason" | "requires">> = {}
): Model303Box => ({
  box: id,
  label,
  kind,
  origin,
  formula,
  legal,
  offered: extra.offered ?? true,
  ...(extra.notOfferedReason ? { notOfferedReason: extra.notOfferedReason } : {}),
  ...(extra.requires ? { requires: extra.requires } : {}),
})

/** Rango de casillas no ofrecidas, con un motivo común. */
const notOffered = (from: number, to: number, label: string, reason: string, legal: string): Model303Box[] => {
  const out: Model303Box[] = []
  for (let n = from; n <= to; n++) {
    out.push(
      box(String(n).padStart(2, "0"), label, "IMPORTE", "NO_OFERTADA", "—", legal, {
        offered: false,
        notOfferedReason: reason,
      })
    )
  }
  return out
}

const RE_EQUIVALENCIA = "Recargo de equivalencia: fuera del alcance de v1 (§2). Un comercio minorista en recargo no puede declarar con este producto y la pantalla lo dice."
const SIMPLIFICADO = "Régimen simplificado (módulos): fuera del alcance de v1 (§2)."

/**
 * Mapa vigente desde el 303 de 2023 (orden HFP/1124/2022 y siguientes). Las
 * casillas que E9 ofrece no han cambiado de numeración desde entonces; el día
 * que lo hagan se añade **otra** versión con su `validFrom` y ésta se cierra con
 * `validTo`, sin tocar una línea del motor.
 */
const MAP_2023: Model303Map = {
  version: "303-2023",
  validFrom: "2023-01-01",
  validTo: null,
  boxes: [
    // ── IVA devengado · régimen general ──────────────────────────────────────
    box("01", "Base imponible al 4 %", "BASE", "EMITIDAS", "Σ base de emitidas con tipo 4 %", "art. 91.Dos LIVA"),
    box("02", "Tipo 4 %", "PORCENTAJE", "DERIVADA", "tipo del `TaxRate` (400 bps)", "art. 91.Dos LIVA"),
    box("03", "Cuota al 4 %", "CUOTA", "EMITIDAS", "Σ cuota devengada de emitidas al 4 %", "art. 91.Dos LIVA"),
    box("04", "Base imponible al 10 %", "BASE", "EMITIDAS", "Σ base de emitidas con tipo 10 %", "art. 91.Uno LIVA"),
    box("05", "Tipo 10 %", "PORCENTAJE", "DERIVADA", "tipo del `TaxRate` (1000 bps)", "art. 91.Uno LIVA"),
    box("06", "Cuota al 10 %", "CUOTA", "EMITIDAS", "Σ cuota devengada de emitidas al 10 %", "art. 91.Uno LIVA"),
    box("07", "Base imponible al 21 %", "BASE", "EMITIDAS", "Σ base de emitidas con tipo 21 %", "art. 90.Uno LIVA"),
    box("08", "Tipo 21 %", "PORCENTAJE", "DERIVADA", "tipo del `TaxRate` (2100 bps)", "art. 90.Uno LIVA"),
    box("09", "Cuota al 21 %", "CUOTA", "EMITIDAS", "Σ cuota devengada de emitidas al 21 %", "art. 90.Uno LIVA"),

    // ── No ofrecidas: recargo de equivalencia ────────────────────────────────
    ...notOffered(16, 26, "Recargo de equivalencia", RE_EQUIVALENCIA, "arts. 154 y ss. LIVA"),

    // ── Autorrepercusión ─────────────────────────────────────────────────────
    box("10", "Adquisiciones intracomunitarias · base", "BASE", "RECIBIDAS", "Σ base de recibidas con clave AIB", "arts. 13 y 15 LIVA"),
    box("11", "Adquisiciones intracomunitarias · cuota", "CUOTA", "RECIBIDAS", "Σ cuota devengada de recibidas con clave AIB", "arts. 13 y 15 LIVA"),
    box("12", "Inversión del sujeto pasivo · base", "BASE", "RECIBIDAS", "Σ base de recibidas con clave ISP", "art. 84.Uno.2º LIVA"),
    box("13", "Inversión del sujeto pasivo · cuota", "CUOTA", "RECIBIDAS", "Σ cuota devengada de recibidas con clave ISP", "art. 84.Uno.2º LIVA"),
    box("14", "Modificación de bases y cuotas · base", "BASE", "EMITIDAS", "Σ base de las rectificativas de venta del periodo (con signo)", "art. 80 LIVA"),
    box("15", "Modificación de bases y cuotas · cuota", "CUOTA", "EMITIDAS", "Σ cuota de las rectificativas de venta del periodo (con signo)", "art. 80 LIVA"),

    box("27", "Total cuota devengada", "IMPORTE", "DERIVADA", "03 + 06 + 09 + 11 + 13 + 15", "modelo 303, apartado «IVA devengado»"),

    // ── IVA deducible ────────────────────────────────────────────────────────
    box("28", "Operaciones interiores corrientes · base", "BASE", "RECIBIDAS", "Σ base de recibidas interiores corrientes con cuota deducible", "art. 92 LIVA"),
    box("29", "Operaciones interiores corrientes · cuota", "CUOTA", "RECIBIDAS", "Σ cuota deducible del periodo de recibidas interiores corrientes (incluye la soportada por ISP)", "arts. 92 y 99 LIVA"),
    box("30", "Operaciones interiores · bienes de inversión · base", "BASE", "RECIBIDAS", "Σ base de recibidas interiores de grupo 2", "art. 108 LIVA"),
    box("31", "Operaciones interiores · bienes de inversión · cuota", "CUOTA", "RECIBIDAS", "Σ cuota deducible del periodo de recibidas interiores de grupo 2", "art. 108 LIVA"),
    box("32", "Importaciones de bienes corrientes · base", "BASE", "RECIBIDAS", "Σ base del DUA (valor en aduana + aranceles + gastos hasta el primer destino) de bienes corrientes", "art. 83.Uno LIVA"),
    box("33", "Importaciones de bienes corrientes · cuota", "CUOTA", "RECIBIDAS", "Σ cuota deducible del DUA de bienes corrientes", "arts. 83 y 92 LIVA"),
    box("34", "Importaciones de bienes de inversión · base", "BASE", "RECIBIDAS", "Σ base del DUA sobre bienes de grupo 2", "arts. 83 y 108 LIVA"),
    box("35", "Importaciones de bienes de inversión · cuota", "CUOTA", "RECIBIDAS", "Σ cuota deducible del DUA sobre bienes de grupo 2", "arts. 83 y 108 LIVA"),
    box("36", "Adquisiciones intracomunitarias de bienes y servicios corrientes · base", "BASE", "RECIBIDAS", "Σ base de AIB corrientes deducibles", "arts. 13 y 92 LIVA"),
    box("37", "Adquisiciones intracomunitarias de bienes y servicios corrientes · cuota", "CUOTA", "RECIBIDAS", "Σ cuota deducible de AIB corrientes", "arts. 13 y 92 LIVA"),
    box("38", "Adquisiciones intracomunitarias de bienes de inversión · base", "BASE", "RECIBIDAS", "Σ base de AIB de grupo 2", "arts. 13 y 108 LIVA"),
    box("39", "Adquisiciones intracomunitarias de bienes de inversión · cuota", "CUOTA", "RECIBIDAS", "Σ cuota deducible de AIB de grupo 2", "arts. 13 y 108 LIVA"),
    box("40", "Rectificación de deducciones · base", "BASE", "RECIBIDAS", "Σ base de las rectificativas de compra del periodo (con signo)", "art. 114 LIVA"),
    box("41", "Rectificación de deducciones · cuota", "CUOTA", "RECIBIDAS", "Σ cuota de las rectificativas de compra del periodo (con signo)", "art. 114 LIVA"),
    box("42", "Compensaciones en régimen especial de la agricultura, ganadería y pesca", "IMPORTE", "NO_OFERTADA", "—", "art. 130 LIVA", {
      offered: false,
      notOfferedReason: "REAGP: fuera del alcance de v1 (§2).",
    }),
    box("43", "Regularización de bienes de inversión", "IMPORTE", "DERIVADA", "0 con motivo escrito, bajo la guardia de R-IVA-16 (O-12)", "art. 107 LIVA"),
    box("44", "Regularización por aplicación del porcentaje definitivo de prorrata", "IMPORTE", "DERIVADA", "`prorrataRegularization`, **con signo** (O-9)", "art. 105.Dos LIVA"),
    box("45", "Total a deducir", "IMPORTE", "DERIVADA", "29 + 31 + 33 + 35 + 37 + 39 + 41 + 43 + 44", "modelo 303, apartado «IVA deducible»"),
    box("46", "Resultado del régimen general", "IMPORTE", "DERIVADA", "27 − 45", "modelo 303, apartado «IVA deducible»"),

    // ── No ofrecidas: régimen simplificado ───────────────────────────────────
    ...notOffered(47, 58, "Régimen simplificado", SIMPLIFICADO, "arts. 122 y ss. LIVA"),

    // ── Informativas obligatorias ────────────────────────────────────────────
    box("59", "Entregas intracomunitarias de bienes y servicios", "IMPORTE", "EMITIDAS", "Σ base de emitidas con clave EIB", "art. 25 LIVA"),
    box("60", "Exportaciones y operaciones asimiladas", "IMPORTE", "EMITIDAS", "Σ base de emitidas con clave EXPORTACION", "arts. 21 a 23 LIVA"),
    box("61", "Operaciones no sujetas o con inversión del sujeto pasivo que originan el derecho a deducción", "IMPORTE", "EMITIDAS", "Σ base de emitidas con clave NO_SUJETA_ISP", "art. 94.Uno LIVA"),

    // ── RECC (sólo con el régimen activo) ────────────────────────────────────
    box("62", "RECC · importe de las entregas conforme al art. 75 (base)", "BASE", "EMITIDAS", "Σ base de emitidas RECC del periodo por su devengo general", "art. 75 LIVA", { requires: "RECC" }),
    box("63", "RECC · importe de las entregas conforme al art. 75 (cuota)", "CUOTA", "EMITIDAS", "Σ cuota íntegra de emitidas RECC del periodo por su devengo general", "art. 75 LIVA", { requires: "RECC" }),
    box("74", "RECC · importe de las adquisiciones conforme al art. 163 terdecies (base)", "BASE", "RECIBIDAS", "Σ base de recibidas RECC del periodo", "art. 163 terdecies LIVA", { requires: "RECC" }),
    box("75", "RECC · importe de las adquisiciones conforme al art. 163 terdecies (cuota)", "CUOTA", "RECIBIDAS", "Σ cuota íntegra de recibidas RECC del periodo", "art. 163 terdecies LIVA", { requires: "RECC" }),

    // ── Cadena hasta el resultado de la liquidación ──────────────────────────
    box("64", "Suma de resultados", "IMPORTE", "DERIVADA", "46 + 58 (58 no se ofrece ⇒ 46)", "modelo 303, apartado «Resultado»"),
    box("65", "% atribuible a la Administración del Estado", "PORCENTAJE", "DECLARADA", "100 salvo régimen foral (Concierto y Convenio)", "Ley 12/2002 y Ley 28/1990"),
    box("66", "Atribuible a la Administración del Estado", "IMPORTE", "DERIVADA", "trunc(64 × 65 / 100)", "modelo 303, apartado «Resultado»"),
    box("77", "IVA a la importación liquidado por la Aduana pendiente de ingreso", "IMPORTE", "RECIBIDAS", "Σ cuota del DUA con diferimiento (O-16)", "art. 167.Dos LIVA y art. 74.1 RIVA", {
      requires: "IMPORT_DEFERRAL",
    }),
    box("67", "Cuotas a compensar de periodos anteriores", "IMPORTE", "DECLARADA", "saldo a compensar arrastrado (`carryForwardCents`)", "art. 99.Cinco LIVA"),
    box("68", "Regularización cuotas art. 80.Cinco.5ª LIVA", "IMPORTE", "NO_OFERTADA", "—", "art. 80.Cinco.5ª LIVA", {
      offered: false,
      notOfferedReason: "Regularización del art. 80.Cinco.5ª: fuera del alcance de v1 (§2).",
    }),
    box("69", "Resultado", "IMPORTE", "DERIVADA", "66 + 77 − 67 + 68", "modelo 303, apartado «Resultado»"),
    box("70", "A deducir (declaración anterior del mismo periodo)", "IMPORTE", "DECLARADA", "resultado de la autoliquidación anterior del mismo periodo", "art. 71 RIVA"),
    box("71", "Resultado de la liquidación", "IMPORTE", "DERIVADA", "69 − 70 · **= importe del asiento T-23**", "modelo 303, apartado «Resultado»"),
  ],
}

export const MODEL_303_MAPS: readonly Model303Map[] = [MAP_2023]

/** Mapa vigente a `date`. Lanza si no hay ninguno: una casilla sin mapa no se inventa. */
export function model303MapAt(date: LocalDate): Model303Map {
  const hit = MODEL_303_MAPS.find((m) => m.validFrom <= date && (m.validTo === null || date <= m.validTo))
  if (!hit) throw new RangeError(`No hay mapa del modelo 303 vigente a ${date}`)
  return hit
}

/** Definición de una casilla en el mapa vigente a `date`, o `null` si no existe. */
export function model303Box(date: LocalDate, id: Model303BoxId): Model303Box | null {
  return model303MapAt(date).boxes.find((b) => b.box === id) ?? null
}

/** Casillas que el producto ofrece (en orden de presentación). */
export const offeredBoxes = (map: Model303Map): readonly Model303Box[] => map.boxes.filter((b) => b.offered)

/** Casillas declaradas **no ofrecidas**, con su motivo, para enseñarlas en pantalla. */
export const notOfferedBoxes = (map: Model303Map): readonly Model303Box[] => map.boxes.filter((b) => !b.offered)
