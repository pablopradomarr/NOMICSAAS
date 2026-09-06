/**
 * E8 · T5 — La propuesta de extracción y su confianza
 * (`docs/design/E8-documentos-asientos.md` §3.1, ADR-0005, ADR-0014).
 *
 * Módulo **PURO** y de sólo tipos: sin IO, sin Prisma, sin LLM, sin
 * `Date.now()`. Nada de aquí calcula: describe **qué** puede decir una
 * propuesta y **con qué crédito** se dice cada campo, que es el contrato que
 * `reconcile()` (T7) evalúa y `postFromProposal()` (T9) consume.
 *
 * Dos ideas gobiernan todo el fichero, y ninguna es negociable:
 *
 *  1. **El LLM extrae y redacta; el código calcula** (P1, ADR-0005). Ninguna
 *     cifra contable sale de un modelo sin pasar por un check determinista.
 *  2. **La calificación fiscal la decide la organización, no el documento**
 *     (ADR-0014 D4 y D11). Por eso hay campos que este tipo declara pero que el
 *     **schema que se le pide al modelo NO contiene**: `accountCode`,
 *     `projectId`, `costCenterId`, `deductibility`, `withholding`,
 *     `receptionDate`, `paymentKey`, `simplifiedQualified`, `rectifies.reason`,
 *     `rectifies.mode` y la calificación firme de ISP. Un modelo que elige
 *     entre 607 y 623 está decidiendo MC1 y MC2 de un proyecto; y la retención
 *     no es una característica del documento, es una obligación del pagador
 *     (arts. 99, 101 y 107 LIRPF).
 */

import type { Cents, LocalDate } from "@/lib/ledger/types"

export type { Cents, LocalDate }

// ─────────────────────────────────────────────────────────────────────────────
// Procedencia y confianza (P6)
// ─────────────────────────────────────────────────────────────────────────────

/** De dónde salió el valor de un campo. `calculado` = lo produjo NUESTRO código. */
export type FieldOrigin = "llm" | "usuario" | "calculado" | "catalogo" | "importado"

export const FIELD_ORIGINS: readonly FieldOrigin[] = ["llm", "usuario", "calculado", "catalogo", "importado"]

/**
 * **O-20.1: CUATRO niveles, no tres.**
 *
 * `verificado` es la distinción que un auditor busca primero —«esto lo pone el
 * documento *y además* nos cuadra»— y sin ella se confundía con `calculado`,
 * que es otra cosa: lo que el código derivó sin que el documento lo dijera.
 *
 * | Nivel | Cuándo |
 * |---|---|
 * | `calculado` | Lo produjo el código: la base y la cuota de RC-17, `convertedTotal`, el reparto Hamilton de cuotas en divisa, la diferencia de una rectificativa por sustitución |
 * | `verificado` | **Leído del documento y coincidente con el recálculo determinista**: la cuota que pasa RC-02 al céntimo, el NIF con dígito de control válido y coincidencia en el maestro |
 * | `interpretacion_ia` | Valor del modelo que pasó su comprobación de forma pero no es derivable: número de documento, contraparte, descripción, fecha, moneda, cuota que difiere dentro de tolerancia, `docKind` sugerido, y toda cuenta o dimensión que venga del catálogo por coincidencia |
 * | `no_verificado` | Su check falló; el usuario lo sobrescribió forzando; el run es `partial` o `IMPORTED`; `convertedTotal` forzado; deducibilidad pendiente de decisión (RC-15) |
 */
export type Confidence = "calculado" | "verificado" | "interpretacion_ia" | "no_verificado"

export const CONFIDENCE_LEVELS: readonly Confidence[] = [
  "calculado",
  "verificado",
  "interpretacion_ia",
  "no_verificado",
]

/**
 * Un valor con su procedencia. El `rawText`, la `page` y el `bbox` son lo que
 * permite que la pantalla recuadre en el PDF **de dónde** salió la cifra: sin
 * ellos la trazabilidad se queda en una promesa.
 */
export type Provenanced<T> = {
  value: T | null
  origin: FieldOrigin
  confidence: Confidence
  rawText?: string
  page?: number
  bbox?: readonly [number, number, number, number]
  /** Id del check que fijó esta confianza: "RC-02", "RC-11"… */
  check?: string
}

export type FieldOrigins = Record<string, Provenanced<unknown>>

// ─────────────────────────────────────────────────────────────────────────────
// Líneas e impuestos del documento
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **O-12 / O-15 (ADR-0014 D10).** No todo lo que viene en una factura es base
 * imponible. Los **suplidos** (art. 78.Tres.3º LIVA: sumas pagadas en nombre y
 * por cuenta del cliente, con mandato expreso y justificante a su nombre) quedan
 * **fuera** de `Σ bases`, de la base de la cuota y de la base de la retención, y
 * **dentro** del total. Sin esta distinción, una factura de abogado con tasa
 * judicial calcula la retención sobre una base inflada y falla la identidad
 * interna siendo perfectamente correcta.
 */
export type LineKind = "OPERACION" | "SUPLIDO" | "NO_SUJETO"

export const LINE_KINDS: readonly LineKind[] = ["OPERACION", "SUPLIDO", "NO_SUJETO"]

/** ADR-0014 D4. `PRORRATA` sólo si la organización la tiene configurada. */
export type Deductibility = "FULL" | "NONE" | "PRORRATA"

export type ProposalLine = {
  /** Default `OPERACION`. */
  kind: LineKind
  /** ≥ 1 tras aplicar el descuento: C-2 no admite una línea de asiento a cero. */
  baseCents: Cents
  /**
   * O-15: el descuento en factura **minora la base**; no genera abono a
   * 706/709 (R-IVA-8 de E3). Se resta ANTES de agrupar por tipo, y vive en la
   * propuesta —no en la línea del asiento— para conservar el drill-down al
   * concepto del documento.
   */
  discountCents?: Cents
  /** `null` en `SUPLIDO` y `NO_SUJETO`: no llevan cuota. */
  taxRateCode: string | null
  /** Se aplica por el régimen del cliente registrado, NO por lo que diga el PDF. */
  surchargeRateCode?: string
  description?: string
  /**
   * Informativo. **NUNCA se multiplica para obtener la base**: la base es la
   * que el documento declara, y recalcularla desde cantidad × precio introduce
   * un redondeo que la factura no tiene.
   */
  qty?: number
  unitPriceCents?: Cents

  // ── O-10 / D11: NO están en el esquema que se le pide al modelo ────────────
  /** Origen `catalogo` (`Category.defaultAccountCode`) o `usuario`. Jamás `llm`. */
  accountCode?: string
  /**
   * **Quién eligió la cuenta.** No es adorno: O-10 dice que una cuenta que sale
   * del catálogo por coincidencia es, como mucho, `interpretacion_ia` —decide el
   * epígrafe de la PyG y con él MC1 y MC2—, mientras que la que teclea una
   * persona es `verificado`. `reconcile()` no puede adivinarlo, así que viaja
   * con la línea. `llm` no es un valor admisible aquí.
   */
  accountCodeOrigin?: Extract<FieldOrigin, "usuario" | "catalogo" | "importado">

  /** Origen `usuario`. */
  projectId?: string
  /** Origen `usuario`. */
  costCenterId?: string
  /** ADR-0014 D4: la fija la organización o el usuario. */
  deductibility?: Deductibility
}

/**
 * Clave de operación para el libro registro y el 303/349 (O-4). La calificación
 * firme NO la propone el modelo: sale de precondiciones verificables (RC-22) o
 * del usuario.
 */
export type OperationKey = "GENERAL" | "ISP" | "AIB" | "EXENTA_25" | "EXPORTACION" | "NO_SUJETA"

export type ProposalTax = {
  taxRateCode: string
  baseCents: Cents
  /**
   * **ADR-0014 D3: ÉSTA es la cuota que se contabiliza.** El IVA deducible es la
   * cuota repercutida por el proveedor y consignada en la factura (arts. 92.Uno
   * y 97.Uno LIVA); el libro registro (art. 64 RIVA) y las casillas del 303 se
   * nutren del documento, no de nuestro recálculo. `cuota()` de
   * `lib/ledger/tax.ts` es **control de verosimilitud**, no fuente del importe:
   * anotar 210,00 € donde la factura dice 210,01 € produce un libro registro
   * que no coincide con la factura.
   */
  quotaCents: Cents
  operationKey?: OperationKey
}

// ─────────────────────────────────────────────────────────────────────────────
// Clase de documento
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **Importación ≠ ISP** (D11): `FACTURA_RECIBIDA_EXTRACOM` y `DUA_IMPORTACION`
 * son clases propias porque autorrepercutir sobre una importación inventa una
 * cuota devengada y una deducible sin soporte, y descuadra los libros y el 349.
 *
 * Los `docKind` de anticipo de proveedor y de cliente **no** son plantillas
 * distintas (O-7): una factura de anticipo es una factura normal contra 438/407,
 * y el dinero llega por T-08/T-09.
 *
 * `NOMINA`, `RECIBO_SS` y `EXTRACTO_BANCARIO` existen para poder **reconocerlos
 * y rechazarlos**: son cifras de terceros (P1) y entran por T-10 o por E7, jamás
 * por una plantilla de compra.
 */
export type DocKind =
  | "FACTURA_RECIBIDA"
  | "FACTURA_RECIBIDA_ISP"
  | "FACTURA_RECIBIDA_EXTRACOM"
  | "DUA_IMPORTACION"
  | "ABONO_RECIBIDO"
  | "TICKET"
  | "FACTURA_ANTICIPO_PROVEEDOR"
  | "NOTA_GASTO_EMPLEADO"
  | "FACTURA_EMITIDA"
  | "ABONO_EMITIDO"
  | "FACTURA_ANTICIPO_CLIENTE"
  | "NOMINA"
  | "RECIBO_SS"
  | "EXTRACTO_BANCARIO"
  | "DESCONOCIDO"

export const DOC_KINDS: readonly DocKind[] = [
  "FACTURA_RECIBIDA",
  "FACTURA_RECIBIDA_ISP",
  "FACTURA_RECIBIDA_EXTRACOM",
  "DUA_IMPORTACION",
  "ABONO_RECIBIDO",
  "TICKET",
  "FACTURA_ANTICIPO_PROVEEDOR",
  "NOTA_GASTO_EMPLEADO",
  "FACTURA_EMITIDA",
  "ABONO_EMITIDO",
  "FACTURA_ANTICIPO_CLIENTE",
  "NOMINA",
  "RECIBO_SS",
  "EXTRACTO_BANCARIO",
  "DESCONOCIDO",
]

/** O-5 / ADR-0014 D12. */
export type RectificationReason = "DEVOLUCION" | "DESCUENTO_POSTERIOR" | "RAPPEL" | "ERROR"

/**
 * **`mode` decide el importe.** El art. 15.3 RD 1619/2012 admite las dos
 * modalidades y en *sustitución* el documento muestra los importes **nuevos
 * completos**: lo que se contabiliza es la **diferencia** contra el documento
 * rectificado. Contabilizar lo leído en una rectificativa por sustitución
 * duplica la operación —sobre una factura de 100 000 rectificada a 80 000
 * dejaría el ingreso en 20 000 en lugar de en 80 000—.
 */
export type RectificationMode = "DIFERENCIAS" | "SUSTITUCION"

export type Rectifies = {
  /** Obligatorio, art. 15.2 RD 1619/2012. Origen `llm`, confirmable. */
  documentNumber: string
  /** Lo resuelve el código contra el diario. Origen `calculado`. */
  entryId?: string
  /** Decide la CUENTA (708 / 706 / 709 / la propia de ingreso). Origen `usuario`. */
  reason: RectificationReason
  /** Decide el IMPORTE. Origen `usuario`. */
  mode: RectificationMode
}

/** O-1: medio de pago del ticket → clave de tesorería. Origen `usuario`. */
export type PaymentKey = "BANCO_DEFAULT" | "CAJA"

export type ProposalCounterparty = {
  name: string | null
  taxId: string | null
  /** Id en el maestro, si `reconcile` lo resolvió. */
  id?: string | null
}

export type DueScheduleItem = { dueDate: LocalDate; amountCents: Cents }

export type ExtractionProposal = {
  version: 1
  docKind: DocKind
  documentNumber: string | null
  counterparty: ProposalCounterparty

  // ── LAS CUATRO FECHAS (+ una opcional). ADR-0014 D8 ────────────────────────
  /** Expedición. Fija la tasa de cambio (D2) y, a falta de devengo, el tipo. */
  documentDate: LocalDate | null
  accrualDate?: LocalDate | null
  /**
   * **O-6: gobierna el periodo de IVA soportado.** El art. 99.Tres LIVA permite
   * deducir en el periodo en que se **soportan** las cuotas —esto es, en que se
   * está en posesión de la factura—. Una factura de marzo recibida en mayo y
   * deducida en el 1T es una deducción prematura con sus recargos.
   * Origen `usuario` con default la fecha de subida. **NUNCA `llm`.**
   */
  receptionDate: LocalDate | null
  /** O-6/O-14: devengo del IVA (art. 75 LIVA); es la que selecciona el `TaxRate`. */
  operationDate?: LocalDate | null

  dueSchedule?: readonly DueScheduleItem[]
  currency: string
  lines: readonly ProposalLine[]
  taxes: readonly ProposalTax[]

  /** O-11: se RELLENA desde `Counterparty`. Lo leído del PDF va en `readWithholding`. */
  withholding?: { rateCode: string; quotaCents: Cents } | null
  /** Lo que el modelo leyó. Sirve SÓLO para contrastar (RC-19). */
  readWithholding?: { rateBps: number; quotaCents: Cents } | null

  // ── O-7: anticipo aplicado ─────────────────────────────────────────────────
  appliedAdvanceCents?: Cents
  appliedAdvanceTaxCents?: Cents
  advanceEntryId?: string

  rectifies?: Rectifies

  paymentKey?: PaymentKey
  /** Art. 7.2 RD 1619/2012. Acto EXPLÍCITO del usuario, auditado (D9). */
  simplifiedQualified?: boolean

  totalCents: Cents
  description?: string | null
}
