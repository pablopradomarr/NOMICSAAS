/**
 * E3 · T5 · E9 · T10 — Registro de las **37** plantillas y `buildFromTemplate`.
 *
 * `TEMPLATES` es la fuente única del catálogo: la UI construye sus formularios
 * a partir de `schema`, las server actions su unión discriminada a partir de
 * `OPERATIONAL_TEMPLATE_CODES` y el invariante I-E3-5 recorre `TEMPLATES` para
 * comprobar que el fixture las cubre **37/37** (E9 · ADR-0016).
 */

import { z } from "zod"

import { EntryDraft, err, fail, LedgerContext, Result } from "@/lib/ledger/types"
import {
  buildAbonoEmitido,
  buildAbonoRecibido,
  buildAnticipoCliente,
  buildAnticipoProveedor,
  buildFacturaEmitida,
  buildFacturaRecibida,
  buildFacturaRecibidaIsp,
} from "@/lib/ledger/templates/documento"
import {
  buildAmortizacion,
  buildCobroCliente,
  buildNomina,
  buildPagoImpuesto,
  buildPagoNomina,
  buildPagoProveedor,
  buildPagoRetenciones,
  buildPagoSeguridadSocial,
  buildPeriodificacion,
} from "@/lib/ledger/templates/tesoreria"
import {
  buildAjusteEjercicioCerrado,
  buildAperturaEjercicio,
  buildAsientoManual,
  buildCierreEjercicio,
  buildContraAsiento,
  buildImpuestoBeneficios,
  buildRegularizacionIva,
  buildRegularizacionResultado,
  buildTraspasoTesoreria,
  ContraAsientoBuildInput,
} from "@/lib/ledger/templates/estructurales"
import {
  buildAjusteValorActual,
  buildAltaPrestamo,
  buildBajaInmovilizado,
  buildDevengoRecc,
  buildDiferenciasCambio,
  buildDistribucionResultado,
  buildDuaImportacion,
  buildReclasificacionVencimientos,
  buildVentaInmovilizado,
} from "@/lib/ledger/templates/cierre-e9"
import * as S from "@/lib/ledger/templates/schemas"
import { TEMPLATE_CODES, TemplateCode, TemplateDefinition } from "@/lib/ledger/templates/types"

export * from "@/lib/ledger/templates/types"
export * as schemas from "@/lib/ledger/templates/schemas"

/** El asiento a anular llega ya leído: el motor no toca la BD. */
const contraAsientoBuildSchema = S.contraAsientoSchema.extend({
  entry: z.custom<ContraAsientoBuildInput["entry"]>((v) => typeof v === "object" && v !== null),
  existingReversals: z.array(z.object({ id: z.string() })).optional(),
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- el registro es heterogéneo por definición
type AnyTemplate = TemplateDefinition<any>

const define = <I>(t: TemplateDefinition<I>): AnyTemplate => t as AnyTemplate

export const TEMPLATES: Readonly<Record<TemplateCode, AnyTemplate>> = {
  // ── Bloque A ──
  FACTURA_EMITIDA_SERVICIOS: define({
    code: "FACTURA_EMITIDA_SERVICIOS",
    label: "Factura emitida de servicios",
    block: "A",
    kind: "NORMAL",
    sourceType: "INVOICE_OUT",
    systemOnly: false,
    schema: S.facturaEmitidaSchema,
    build: buildFacturaEmitida,
  }),
  ABONO_EMITIDO: define({
    code: "ABONO_EMITIDO",
    label: "Abono emitido (rectificativa de venta)",
    block: "A",
    kind: "NORMAL",
    sourceType: "INVOICE_OUT",
    systemOnly: false,
    schema: S.abonoEmitidoSchema,
    build: buildAbonoEmitido,
  }),
  FACTURA_RECIBIDA: define({
    code: "FACTURA_RECIBIDA",
    label: "Factura recibida",
    block: "A",
    kind: "NORMAL",
    sourceType: "DOCUMENT",
    systemOnly: false,
    schema: S.facturaRecibidaSchema,
    build: buildFacturaRecibida,
  }),
  FACTURA_RECIBIDA_ISP: define({
    code: "FACTURA_RECIBIDA_ISP",
    label: "Factura recibida con inversión del sujeto pasivo",
    block: "A",
    kind: "NORMAL",
    sourceType: "DOCUMENT",
    systemOnly: false,
    schema: S.facturaRecibidaIspSchema,
    build: buildFacturaRecibidaIsp,
  }),
  ABONO_RECIBIDO: define({
    code: "ABONO_RECIBIDO",
    label: "Abono recibido (rectificativa de compra)",
    block: "A",
    kind: "NORMAL",
    sourceType: "DOCUMENT",
    systemOnly: false,
    schema: S.abonoRecibidoSchema,
    build: buildAbonoRecibido,
  }),
  ANTICIPO_CLIENTE: define({
    code: "ANTICIPO_CLIENTE",
    label: "Anticipo de cliente (438)",
    block: "A",
    kind: "NORMAL",
    sourceType: "MANUAL",
    systemOnly: false,
    schema: S.anticipoSchema,
    build: buildAnticipoCliente,
  }),
  ANTICIPO_PROVEEDOR: define({
    code: "ANTICIPO_PROVEEDOR",
    label: "Anticipo a proveedor (407)",
    block: "A",
    kind: "NORMAL",
    sourceType: "MANUAL",
    systemOnly: false,
    schema: S.anticipoSchema,
    build: buildAnticipoProveedor,
  }),

  // ── Bloque B ──
  COBRO_CLIENTE: define({
    code: "COBRO_CLIENTE",
    label: "Cobro de cliente",
    block: "B",
    kind: "NORMAL",
    sourceType: "BANK_IMPORT",
    systemOnly: false,
    schema: S.cobroClienteSchema,
    build: buildCobroCliente,
  }),
  PAGO_PROVEEDOR: define({
    code: "PAGO_PROVEEDOR",
    label: "Pago a proveedor",
    block: "B",
    kind: "NORMAL",
    sourceType: "BANK_IMPORT",
    systemOnly: false,
    schema: S.pagoProveedorSchema,
    build: buildPagoProveedor,
  }),
  NOMINA: define({
    code: "NOMINA",
    label: "Nómina",
    block: "B",
    kind: "NORMAL",
    sourceType: "MANUAL",
    systemOnly: false,
    schema: S.nominaSchema,
    build: buildNomina,
  }),
  PAGO_NOMINA: define({
    code: "PAGO_NOMINA",
    label: "Pago de nómina",
    block: "B",
    kind: "NORMAL",
    sourceType: "BANK_IMPORT",
    systemOnly: false,
    schema: S.pagoDeudaSchema,
    build: buildPagoNomina,
  }),
  PAGO_SEGURIDAD_SOCIAL: define({
    code: "PAGO_SEGURIDAD_SOCIAL",
    label: "Pago de Seguridad Social",
    block: "B",
    kind: "NORMAL",
    sourceType: "BANK_IMPORT",
    systemOnly: false,
    schema: S.pagoDeudaSchema,
    build: buildPagoSeguridadSocial,
  }),
  PAGO_RETENCIONES: define({
    code: "PAGO_RETENCIONES",
    label: "Pago de retenciones (111 / 115)",
    block: "B",
    kind: "NORMAL",
    sourceType: "BANK_IMPORT",
    systemOnly: false,
    schema: S.pagoDeudaSchema,
    build: buildPagoRetenciones,
  }),
  AMORTIZACION_MENSUAL: define({
    code: "AMORTIZACION_MENSUAL",
    label: "Amortización mensual",
    block: "B",
    kind: "NORMAL",
    sourceType: "SYSTEM",
    systemOnly: false,
    schema: S.amortizacionSchema,
    build: buildAmortizacion,
  }),
  PERIODIFICACION_GASTO: define({
    code: "PERIODIFICACION_GASTO",
    label: "Periodificación de gasto (480)",
    block: "B",
    kind: "NORMAL",
    sourceType: "MANUAL",
    systemOnly: false,
    schema: S.periodificacionSchema,
    build: (i, ctx) => buildPeriodificacion(i, ctx, "PERIODIFICACION_GASTO"),
  }),
  DEVENGO_PERIODIFICACION_GASTO: define({
    code: "DEVENGO_PERIODIFICACION_GASTO",
    label: "Devengo de gasto periodificado",
    block: "B",
    kind: "NORMAL",
    sourceType: "MANUAL",
    systemOnly: false,
    schema: S.periodificacionSchema,
    build: (i, ctx) => buildPeriodificacion(i, ctx, "DEVENGO_PERIODIFICACION_GASTO"),
  }),
  PERIODIFICACION_INGRESO: define({
    code: "PERIODIFICACION_INGRESO",
    label: "Periodificación de ingreso (485)",
    block: "B",
    kind: "NORMAL",
    sourceType: "MANUAL",
    systemOnly: false,
    schema: S.periodificacionSchema,
    build: (i, ctx) => buildPeriodificacion(i, ctx, "PERIODIFICACION_INGRESO"),
  }),
  DEVENGO_PERIODIFICACION_INGRESO: define({
    code: "DEVENGO_PERIODIFICACION_INGRESO",
    label: "Devengo de ingreso periodificado",
    block: "B",
    kind: "NORMAL",
    sourceType: "MANUAL",
    systemOnly: false,
    schema: S.periodificacionSchema,
    build: (i, ctx) => buildPeriodificacion(i, ctx, "DEVENGO_PERIODIFICACION_INGRESO"),
  }),

  // ── Bloque C ──
  TRASPASO_TESORERIA: define({
    code: "TRASPASO_TESORERIA",
    label: "Traspaso entre cuentas de tesorería",
    block: "C",
    kind: "NORMAL",
    sourceType: "BANK_IMPORT",
    systemOnly: false,
    schema: S.traspasoTesoreriaSchema,
    build: buildTraspasoTesoreria,
  }),
  ASIENTO_MANUAL: define({
    code: "ASIENTO_MANUAL",
    label: "Asiento manual",
    block: "C",
    kind: "NORMAL",
    sourceType: "MANUAL",
    systemOnly: false,
    schema: S.asientoManualSchema,
    build: buildAsientoManual,
  }),
  CONTRA_ASIENTO: define({
    code: "CONTRA_ASIENTO",
    label: "Contra-asiento (anulación)",
    block: "C",
    kind: "REVERSAL",
    sourceType: "SYSTEM",
    systemOnly: false,
    schema: contraAsientoBuildSchema,
    build: buildContraAsiento,
  }),
  AJUSTE_EJERCICIO_CERRADO: define({
    code: "AJUSTE_EJERCICIO_CERRADO",
    label: "Ajuste de ejercicio cerrado (NRV 22ª)",
    block: "C",
    kind: "NORMAL",
    sourceType: "MANUAL",
    systemOnly: false,
    schema: S.ajusteEjercicioCerradoSchema,
    build: buildAjusteEjercicioCerrado,
  }),
  REGULARIZACION_IVA: define({
    code: "REGULARIZACION_IVA",
    label: "Liquidación de IVA (modelo 303)",
    block: "C",
    kind: "NORMAL",
    sourceType: "SYSTEM",
    systemOnly: false,
    schema: S.regularizacionIvaSchema,
    build: buildRegularizacionIva,
  }),
  PAGO_IMPUESTO: define({
    code: "PAGO_IMPUESTO",
    label: "Pago de impuesto",
    block: "C",
    kind: "NORMAL",
    sourceType: "BANK_IMPORT",
    systemOnly: false,
    schema: S.pagoImpuestoSchema,
    build: buildPagoImpuesto,
  }),

  // ── Bloque C, sin acción de usuario hasta E9 (§1) ──
  IMPUESTO_BENEFICIOS: define({
    code: "IMPUESTO_BENEFICIOS",
    label: "Impuesto sobre beneficios",
    block: "C",
    kind: "NORMAL",
    sourceType: "SYSTEM",
    systemOnly: true,
    schema: S.impuestoBeneficiosSchema,
    build: buildImpuestoBeneficios,
  }),
  REGULARIZACION_RESULTADO: define({
    code: "REGULARIZACION_RESULTADO",
    label: "Regularización de resultado",
    block: "C",
    kind: "REGULARIZATION",
    sourceType: "SYSTEM",
    systemOnly: true,
    schema: S.balanceDrivenSchema,
    build: buildRegularizacionResultado,
  }),
  CIERRE_EJERCICIO: define({
    code: "CIERRE_EJERCICIO",
    label: "Cierre del ejercicio",
    block: "C",
    kind: "CLOSING",
    sourceType: "SYSTEM",
    systemOnly: true,
    schema: S.balanceDrivenSchema,
    build: buildCierreEjercicio,
  }),
  APERTURA_EJERCICIO: define({
    code: "APERTURA_EJERCICIO",
    label: "Apertura del ejercicio",
    block: "C",
    kind: "OPENING",
    sourceType: "SYSTEM",
    systemOnly: true,
    schema: S.aperturaEjercicioSchema,
    build: buildAperturaEjercicio,
  }),

  // ── Bloque E9 (ADR-0016): T-29 … T-37 ──
  DUA_IMPORTACION: define({
    code: "DUA_IMPORTACION",
    label: "DUA de importación (con y sin diferimiento)",
    block: "A",
    kind: "NORMAL",
    sourceType: "DOCUMENT",
    systemOnly: false,
    schema: S.duaImportacionSchema,
    build: buildDuaImportacion,
  }),
  DIFERENCIAS_CAMBIO_CIERRE: define({
    code: "DIFERENCIAS_CAMBIO_CIERRE",
    label: "Diferencias de cambio al cierre (NRV 11ª.2.2)",
    block: "C",
    kind: "NORMAL",
    sourceType: "SYSTEM",
    systemOnly: true,
    schema: S.diferenciasCambioSchema,
    build: buildDiferenciasCambio,
  }),
  AJUSTE_VALOR_ACTUAL: define({
    code: "AJUSTE_VALOR_ACTUAL",
    label: "Ajuste al valor actual del aplazamiento",
    block: "C",
    kind: "NORMAL",
    sourceType: "SYSTEM",
    systemOnly: true,
    schema: S.ajusteValorActualSchema,
    build: buildAjusteValorActual,
  }),
  RECLASIFICACION_VENCIMIENTOS: define({
    code: "RECLASIFICACION_VENCIMIENTOS",
    label: "Reclasificación corriente / no corriente",
    block: "C",
    kind: "NORMAL",
    sourceType: "SYSTEM",
    systemOnly: true,
    schema: S.reclasificacionVencimientosSchema,
    build: buildReclasificacionVencimientos,
  }),
  BAJA_INMOVILIZADO: define({
    code: "BAJA_INMOVILIZADO",
    label: "Baja de inmovilizado sin contraprestación",
    block: "B",
    kind: "NORMAL",
    sourceType: "SYSTEM",
    systemOnly: false,
    schema: S.bajaInmovilizadoSchema,
    build: buildBajaInmovilizado,
  }),
  VENTA_INMOVILIZADO: define({
    code: "VENTA_INMOVILIZADO",
    label: "Venta de inmovilizado (543 / 253, nunca 430)",
    block: "A",
    kind: "NORMAL",
    sourceType: "DOCUMENT",
    systemOnly: false,
    schema: S.ventaInmovilizadoSchema,
    build: buildVentaInmovilizado,
  }),
  DISTRIBUCION_RESULTADO: define({
    code: "DISTRIBUCION_RESULTADO",
    label: "Distribución del resultado (arts. 164 y 274 LSC)",
    block: "C",
    kind: "NORMAL",
    sourceType: "SYSTEM",
    systemOnly: true,
    schema: S.distribucionResultadoSchema,
    build: buildDistribucionResultado,
  }),
  DEVENGO_RECC: define({
    code: "DEVENGO_RECC",
    label: "Devengo del RECC pendiente al 31/12 (art. 163 terdecies)",
    block: "C",
    kind: "NORMAL",
    sourceType: "SYSTEM",
    systemOnly: true,
    schema: S.devengoReccSchema,
    build: buildDevengoRecc,
  }),
  ALTA_PRESTAMO: define({
    code: "ALTA_PRESTAMO",
    label: "Alta de préstamo con cuadro de vencimientos",
    block: "B",
    kind: "NORMAL",
    sourceType: "MANUAL",
    systemOnly: false,
    schema: S.altaPrestamoSchema,
    build: buildAltaPrestamo,
  }),
}

/** Todas las plantillas del catálogo, en el orden T-01…T-37. */
export const ALL_TEMPLATES: readonly AnyTemplate[] = TEMPLATE_CODES.map((c) => TEMPLATES[c])

export const isTemplateCode = (v: string): v is TemplateCode => v in TEMPLATES

/**
 * Punto de entrada del motor de plantillas: valida la forma del input con el
 * schema de la plantilla y construye el borrador.
 */
export function buildFromTemplate(code: TemplateCode, input: unknown, ctx: LedgerContext): Result<EntryDraft> {
  const template = TEMPLATES[code]
  if (!template) {
    return fail<EntryDraft>(err("TEMPLATE_INPUT", "templateCode", `Plantilla desconocida: ${code}`))
  }
  const parsed = template.schema.safeParse(input)
  if (!parsed.success) {
    return fail<EntryDraft>(
      ...parsed.error.issues.map((issue) =>
        err("TEMPLATE_INPUT", issue.path.join(".") || "input", issue.message, {
          check: `${code}`,
        })
      )
    )
  }
  return template.build(parsed.data, ctx)
}
