/**
 * E11 · ola A · T18 — facturación de la plataforma, en su parte PURA
 * (§2.2, C-1…C-5, O-9, O-10, O-15; ADR-0019 **D8**).
 *
 * Aquí se decide el **tratamiento fiscal**, el **periodo de devengo** y la
 * **cuota en euros**. Nada de esto entra en el diario del cliente: I-E11-8 lo
 * prohíbe, y este fichero no conoce ni una cuenta del PGC.
 *
 * Sin IO, sin BD, sin fetch: la consulta a VIES la hace el llamante y entra aquí
 * ya resuelta, con su fecha. Así el tratamiento es **reproducible**: con los
 * mismos datos del devengo sale el mismo resultado dentro de cuatro años.
 */

import { convertWithRateMicro } from "@/lib/money"

import type { InvoiceRecipient, TaxDecision } from "./types"

// ─────────────────────────────────────────────────────────────────────────────
// Tratamiento fiscal (C-1, O-15)
// ─────────────────────────────────────────────────────────────────────────────

/** Tipo general del art. 90.Uno LIVA, en puntos básicos. */
export const IVA_GENERAL_BPS = 2100

/**
 * Estados miembros de la UE **a efectos del IVA**. España está dentro, y se
 * trata aparte por `REPERCUTIDO_ES`.
 *
 * `GB` **no** está (Brexit: tercer país desde 2021). `XI` —Irlanda del Norte—
 * tampoco: su régimen especial cubre **bienes**, no servicios prestados por vía
 * electrónica, así que para nosotros es tercer país.
 */
export const EU_VAT_COUNTRIES: ReadonlySet<string> = new Set([
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR",
  "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
])

/**
 * Códigos postales de **Canarias, Ceuta y Melilla**: territorio español que está
 * **fuera del TAI** (art. 3.Dos LIVA; L 20/1991). No es un matiz: una suscripción
 * a una empresa de Las Palmas **no lleva IVA español**.
 */
const CP_CANARIAS = /^3[58]/
const CP_CEUTA = /^51/
const CP_MELILLA = /^52/

export function esTerritorioEspecialEs(postalCode: string | null | undefined): boolean {
  if (!postalCode) return false
  const cp = postalCode.trim()
  return CP_CANARIAS.test(cp) || CP_CEUTA.test(cp) || CP_MELILLA.test(cp)
}

export const MENCION_INVERSION_SUJETO_PASIVO =
  "Operación no sujeta en el TAI por aplicación de las reglas de localización " +
  "(art. 69.Uno.1º LIVA). Inversión del sujeto pasivo / reverse charge: " +
  "el impuesto lo liquida el destinatario en su Estado miembro (art. 6.1.m RD 1619/2012)."

export const MENCION_TERCER_PAIS =
  "Operación no sujeta al IVA español por reglas de localización (art. 69.Uno.1º LIVA): " +
  "destinatario empresario establecido fuera de la Comunidad."

export const MENCION_TERRITORIO_ESPECIAL =
  "Operación no sujeta al IVA (art. 3.Dos LIVA): destinatario establecido en Canarias, " +
  "Ceuta o Melilla, territorios excluidos del ámbito de aplicación del impuesto."

/**
 * El tratamiento fiscal de la suscripción, **en el devengo**.
 *
 * Servicio prestado por vía electrónica, regla de localización **B2B** del
 * art. 69.Uno.1º LIVA: se localiza donde está establecido el destinatario.
 *
 * Dos reglas que no se negocian:
 *
 * 1. **Nunca se presume un NIF-IVA válido** (R-5, C-1). Con VIES caído
 *    (`viesValid === null`) o NIF inválido (`false`) **se repercute el 21 %**.
 *    Es la opción que no deja una cuota sin ingresar; si después se acredita la
 *    condición de empresario, se emite rectificativa. Al revés no hay vuelta
 *    atrás barata.
 * 2. **No es «una ISP»** (O-15): para nosotros es una **no sujeción por regla de
 *    localización**; la inversión la aplica el destinatario en su Estado. En la
 *    factura sí se imprime la mención.
 *
 * No hay rama B2C ni OSS: la venta es **B2B-only con NIF-IVA obligatorio y
 * validado** (P-1). Un destinatario UE sin NIF-IVA válido cae, por la regla 1,
 * en `REPERCUTIDO_ES`… sólo si está en España; si no, la venta no debió
 * cerrarse, y `assertB2BSellable` lo dice antes del checkout.
 */
export function resolveTaxTreatment(
  recipient: InvoiceRecipient,
  opts: { postalCode?: string | null } = {}
): TaxDecision {
  const pais = (recipient.country || "").toUpperCase()

  if (pais === "ES") {
    if (esTerritorioEspecialEs(opts.postalCode)) {
      return {
        treatment: "NO_SUJETO_CANARIAS_CEUTA_MELILLA",
        rateBps: 0,
        mention: MENCION_TERRITORIO_ESPECIAL,
        reason:
          "Destinatario establecido en Canarias, Ceuta o Melilla: fuera del territorio de " +
          "aplicación del impuesto (art. 3.Dos LIVA).",
      }
    }
    return {
      treatment: "REPERCUTIDO_ES",
      rateBps: IVA_GENERAL_BPS,
      mention: null,
      reason: "Destinatario empresario establecido en el TAI: sujeto y no exento al 21 % (arts. 69.Uno.1º, 90.Uno LIVA).",
    }
  }

  if (EU_VAT_COUNTRIES.has(pais)) {
    if (recipient.vatNumber && recipient.viesValid === true) {
      return {
        treatment: "NO_SUJETO_LOCALIZACION_UE",
        rateBps: 0,
        mention: MENCION_INVERSION_SUJETO_PASIVO,
        reason:
          "Destinatario empresario con NIF-IVA validado en VIES en la fecha de devengo: " +
          "no sujeto en el TAI (art. 69.Uno.1º LIVA).",
      }
    }
    return {
      treatment: "REPERCUTIDO_ES",
      rateBps: IVA_GENERAL_BPS,
      mention: null,
      reason:
        recipient.viesValid === null
          ? "VIES no disponible en la fecha de devengo: no se presume la condición de empresario y se repercute el 21 %."
          : "NIF-IVA no válido en VIES en la fecha de devengo: no cabe la no sujeción y se repercute el 21 %.",
    }
  }

  if (pais.length === 2) {
    return {
      treatment: "NO_SUJETO_TERCER_PAIS",
      rateBps: 0,
      mention: MENCION_TERCER_PAIS,
      reason: "Destinatario establecido fuera de la Comunidad: no sujeto (art. 69.Uno.1º LIVA).",
    }
  }

  // Sin país no se puede localizar la operación, y localizarla es el primer
  // paso: se rechaza en vez de inventar una sujeción.
  throw new PlatformInvoiceError(
    "No consta el país del destinatario: sin él no se puede determinar la localización de la operación " +
      "(art. 69.Uno.1º LIVA). Complete los datos fiscales antes de emitir."
  )
}

export class PlatformInvoiceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PlatformInvoiceError"
  }
}

/**
 * **P-1 · B2B-only.** Fuera de España, sin NIF-IVA no se vende: admitir B2C UE
 * obligaría a alta en OSS (modelos 035 y 369) por un segmento residual, y
 * construir sobre el umbral de 10 000 € del art. 73 LIVA es deuda fiscal con
 * fecha. Se comprueba **antes** del checkout, no al facturar.
 */
export function assertB2BSellable(recipient: InvoiceRecipient): void {
  const pais = (recipient.country || "").toUpperCase()
  if (!pais) throw new PlatformInvoiceError("Falta el país del destinatario.")
  if (pais === "ES") return
  if (!recipient.vatNumber) {
    throw new PlatformInvoiceError(
      "Fuera de España la contratación exige NIF-IVA: el producto se vende únicamente a empresarios " +
        "y profesionales (B2B). Indique su NIF-IVA para continuar."
    )
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Devengo y periodo (C-2, ADR-0014 D8)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clave canónica de periodo de IVA del ERP, `AAAA-Qn` (ADR-0014 D8), derivada
 * **del devengo** y nunca de la fecha de expedición ni de la de cobro.
 *
 * Es la diferencia entre declarar una operación en el trimestre que toca y
 * declararla en el siguiente porque Stripe cobró tres días tarde.
 */
export function ivaPeriodOf(operationDate: Date): string {
  const y = operationDate.getUTCFullYear()
  const q = Math.floor(operationDate.getUTCMonth() / 3) + 1
  return `${y}-Q${q}`
}

/**
 * Fecha de **devengo** de una factura de suscripción (art. 75.Uno.7º y 75.Dos
 * LIVA).
 *
 * Tracto sucesivo: devenga el día en que **resulta exigible** el precio del
 * periodo. El cobro anticipado lo adelanta (75.Dos), pero un cobro POSTERIOR a
 * la exigibilidad **no la mueve**: si la renovación es exigible el día 1 y
 * Stripe cobra el 3, el devengo es el día 1 y el cobro del día 3 es un hecho de
 * tesorería.
 *
 * @param periodStart inicio del periodo facturado (exigibilidad contractual)
 * @param paidAt      instante del cobro, si ya se cobró
 */
export function accrualDateOf(periodStart: Date, paidAt: Date | null): Date {
  if (paidAt && paidAt.getTime() < periodStart.getTime()) return truncateToDay(paidAt)
  return truncateToDay(periodStart)
}

function truncateToDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/**
 * Último día admisible de expedición: el **16 del mes siguiente** al devengo,
 * para destinatario empresario (art. 11 RD 1619/2012). Se expone para que la
 * pantalla y el runbook puedan avisar, no para retrasar la emisión.
 */
export function issueDeadlineOf(operationDate: Date): Date {
  return new Date(Date.UTC(operationDate.getUTCFullYear(), operationDate.getUTCMonth() + 1, 16))
}

// ─────────────────────────────────────────────────────────────────────────────
// Cuota en euros (C-4)
// ─────────────────────────────────────────────────────────────────────────────

export type FxQuote = {
  /** Tasa en micro-unidades: 1 000 000 = 1,000000 unidades de destino por origen. */
  rateMicro: bigint
  /** Fecha REAL de la tasa: la del devengo, o la última publicada anterior. */
  date: Date
  source: string
}

/**
 * La **cuota tributaria repercutida se expresa en euros, siempre** (C-4,
 * art. 79.Once LIVA). El resto de importes pueden ir en la moneda de la
 * operación (art. 6.1.j RD 1619/2012).
 *
 * Tasa del **devengo**. **`RC-14` no aplica aquí**: la factura hay que emitirla
 * igual, así que en día sin publicación se usa la última tasa anterior y **la
 * fecha de esa tasa se imprime**. Se convierte **una sola vez y se sella**: no
 * se recalcula al mirarla.
 *
 * Redondeo: al céntimo y **half-even**, el del resto del producto
 * (`convertWithRateMicro`, la única conversión de divisa que existe aquí). Es un
 * importe único —una cuota, no un reparto—, así que no hay residuo que repartir.
 */
export function taxCentsInEur(
  taxCents: number,
  currency: string,
  quote: FxQuote | null
): { taxCentsEur: number; fx: FxQuote | null } {
  if (currency === "EUR") return { taxCentsEur: taxCents, fx: null }
  if (!quote) {
    throw new PlatformInvoiceError(
      `No hay tasa de cambio ${currency}→EUR para la fecha de devengo ni anterior: ` +
        "la cuota repercutida debe expresarse en euros (art. 79.Once LIVA) y no se puede sellar la factura sin ella."
    )
  }
  // Se delega en `convertWithRateMicro`, que es la ÚNICA conversión de divisa
  // del producto (E8 · T13): en enteros y half-even. Rehacerla aquí crearía la
  // cuarta copia de la misma aritmética, que es justo lo que E8 deshizo.
  return { taxCentsEur: convertWithRateMicro(taxCents, quote.rateMicro), fx: quote }
}

// ─────────────────────────────────────────────────────────────────────────────
// Numeración (O-9, O-10, I-E11-13)
// ─────────────────────────────────────────────────────────────────────────────

/** Serie ordinaria y serie rectificativa de la plataforma (§2.2, sembradas en M5). */
export const PLATFORM_SERIES_ORDINARIA = "PLT"
export const PLATFORM_SERIES_RECTIFICATIVA = "PLT-R"

/**
 * `PLT-2026-0001`. **Cuatro dígitos**, que es lo que cabe en un ejercicio de
 * facturación de plataforma; el prefijo ya lleva el año, así que el contador no
 * lo repite.
 */
export function formatPlatformInvoiceNumber(prefix: string, number: number): string {
  return `${prefix}${String(number).padStart(4, "0")}`
}

/**
 * **C-3 · qué hecho de Stripe produce qué documento.**
 *
 * Un prorrateo **positivo** (upgrade con cargo adicional) es operación NUEVA y
 * no rectifica nada: factura ordinaria. Un prorrateo **negativo** (downgrade,
 * baja a mitad de periodo) y un *refund* sí modifican una base ya repercutida:
 * **rectificativa** (art. 89 LIVA), con serie específica, referencia inequívoca,
 * causa y modo (art. 15 RD 1619/2012).
 */
export function seriesCodeFor(kind: "ORDINARIA" | "RECTIFICATIVA"): string {
  return kind === "RECTIFICATIVA" ? PLATFORM_SERIES_RECTIFICATIVA : PLATFORM_SERIES_ORDINARIA
}
