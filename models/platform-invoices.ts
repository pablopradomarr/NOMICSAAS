/**
 * E11 · ola A · T18 — la factura que **CFOnomic emite al cliente**
 * (§2.2, C-1…C-5, O-9, O-10, O-15; ADR-0019 **D8**).
 *
 * Cuatro reglas gobiernan este fichero, y ninguna es negociable:
 *
 * 1. **La numeración es NUESTRA.** La asigna el expedidor (arts. 6.1.a y 7 RD
 *    1619/2012), con `FOR UPDATE` sobre la fila de la serie —igual que
 *    `nextInvoiceNumberTx` con las del cliente— y **dentro de la misma
 *    transacción que inserta la factura**: si ésta revierte, el número vuelve
 *    atrás y no queda hueco. Stripe deja huecos (borradores anulados, `void`) y
 *    por eso no puede ser nuestra serie (criterio 9).
 * 2. **El régimen fiscal se decide en el DEVENGO y se sella.** El NIF-IVA se
 *    revalida en cada devengo, no una sola vez al alta: un NIF-IVA se da de baja
 *    (C-1). Con VIES caído se repercute el 21 % y **nunca se presume** (R-5).
 * 3. **La cuota va siempre además en euros** (C-4), a la tasa del devengo o a la
 *    última anterior, convertida **una sola vez y sellada**.
 * 4. **Esto NO genera asiento** (I-E11-8). Ni aquí, ni por el camino indirecto
 *    (O-8): no se crea `Transaction`, ni `ExtractionRun`, ni `File`.
 *
 * El PDF conservado (C-5) lo sube la ola B por su `StorageDriver`; aquí se
 * enlaza por `stored_object_id` cuando llega, con el único `UPDATE` que el
 * `GRANT` de columna permite.
 */

import type { TenantClient, TenantTransactionClient } from "@/lib/db"
import { tenantDb, tenantTransaction } from "@/lib/db"
import {
  accrualDateOf,
  formatPlatformInvoiceNumber,
  ivaPeriodOf,
  PlatformInvoiceError,
  resolveTaxTreatment,
  seriesCodeFor,
  taxCentsInEur,
  type FxQuote,
} from "@/lib/platform/invoice"
import type { InvoiceRecipient } from "@/lib/platform/types"
import type { Prisma, RectificationMode, TaxTreatment } from "@/prisma/client"

type AnyTenantClient = TenantClient | TenantTransactionClient

// ─────────────────────────────────────────────────────────────────────────────
// Numeración: la puerta `SECURITY DEFINER` de M5
// ─────────────────────────────────────────────────────────────────────────────

export type AssignedPlatformNumber = {
  seriesId: string
  seriesCode: string
  seriesKind: "ORDINARIA" | "RECTIFICATIVA"
  prefix: string
  number: number
  fullNumber: string
}

/**
 * Reserva el siguiente número de la serie, **con `FOR UPDATE`** dentro de la
 * función `app.next_platform_invoice_number`.
 *
 * `platform_invoice_series` es catálogo global con escritura cerrada a
 * `app_runtime`: la serie la mueve esa función y sólo ésa (§9.5). El bloqueo
 * serializa a los emisores concurrentes; sin él, dos webhooks simultáneos leen
 * el mismo contador y emiten la misma factura dos veces.
 */
export async function nextPlatformInvoiceNumberTx(
  tx: TenantTransactionClient,
  kind: "ORDINARIA" | "RECTIFICATIVA"
): Promise<AssignedPlatformNumber> {
  const code = seriesCodeFor(kind)
  const rows = await tx.$queryRaw<
    { series_id: string; series_code: string; series_kind: string; prefix: string; number: number }[]
  >`SELECT * FROM app.next_platform_invoice_number(${code})`

  const r = rows[0]
  if (!r) throw new PlatformInvoiceError(`No existe la serie de plataforma ${code}`)

  return {
    seriesId: r.series_id,
    seriesCode: r.series_code,
    seriesKind: r.series_kind as "ORDINARIA" | "RECTIFICATIVA",
    prefix: r.prefix,
    number: r.number,
    fullNumber: formatPlatformInvoiceNumber(r.prefix, r.number),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tasa del devengo (C-4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tasa `from → EUR` **de la fecha de devengo, o la última publicada anterior**.
 *
 * `RC-14` («sin tasa no se convierte») **no aplica aquí**: la factura hay que
 * emitirla igual. Lo que sí se conserva es la honradez del dato — se devuelve la
 * fecha REAL de la tasa usada, que es la que se imprime en la factura, y no la
 * del devengo como si se hubiera publicado ese día.
 */
export async function fxQuoteAtAccrual(
  db: AnyTenantClient,
  from: string,
  operationDate: Date
): Promise<FxQuote | null> {
  if (from === "EUR") return null
  const rows = await db.$queryRaw<{ rate_micro: bigint; date: Date; source: string }[]>`
    SELECT "rate_micro", "date", "source"
      FROM "exchange_rates"
     WHERE "from" = ${from} AND "to" = 'EUR' AND "date" <= ${operationDate}::date
     ORDER BY "date" DESC
     LIMIT 1
  `
  const r = rows[0]
  return r ? { rateMicro: r.rate_micro, date: r.date, source: r.source } : null
}

// ─────────────────────────────────────────────────────────────────────────────
// Emisión
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lo que el webhook sabe de la factura de Stripe, ya recortado. Los importes
 * llegan **en céntimos de la moneda de Stripe**; `subtotal + tax = total` lo
 * comprueba además un CHECK.
 */
export type StripeInvoiceFacts = {
  stripeInvoiceId: string
  subscriptionId: string | null
  /** Inicio del periodo facturado: la exigibilidad contractual (C-2). */
  periodStart: Date
  periodEnd: Date | null
  /** Instante del cobro, si ya se cobró. Sólo adelanta el devengo si es ANTERIOR. */
  paidAt: Date | null
  /** Fecha de expedición. Por defecto, el propio devengo. */
  issuedAt?: Date
  subtotalCents: number
  taxCents: number
  totalCents: number
  currency: string
  status: string
  hostedInvoiceUrl: string | null
}

export type IssuePlatformInvoiceInput = {
  organizationId: string
  facts: StripeInvoiceFacts
  /** Destinatario **tal y como se conoce en el devengo** (C-1). */
  recipient: InvoiceRecipient
  /** Código postal, sólo para distinguir Canarias / Ceuta / Melilla (art. 3.Dos LIVA). */
  postalCode?: string | null
  /** Fecha-hora de la consulta VIES que respalda `recipient.viesValid`. */
  vatValidatedAt?: Date | null
  vatValidationSource?: string | null
  vatValidationRef?: string | null
  /** Rectificativa (C-3, art. 15 RD 1619/2012). */
  rectifies?: { invoiceId: string; cause: string; mode: RectificationMode }
  /**
   * Régimen HEREDADO de la factura rectificada. Sólo para rectificativas:
   * rectificar no es recalificar la operación (art. 89 LIVA se refiere a lo
   * repercutido), y volver a consultar VIES hoy podría convertir en
   * «repercutido» la rectificación de algo que en su devengo no estaba sujeto.
   */
  forceTreatment?: { treatment: TaxTreatment; mention: string | null }
}

export type PlatformInvoiceRecord = {
  id: string
  fullNumber: string
  number: number
  seriesId: string
  operationDate: Date
  issuedAt: Date
  ivaPeriod: string
  taxTreatment: TaxTreatment
  subtotalCents: number
  taxCents: number
  totalCents: number
  currency: string
  taxCentsEur: number
}

/**
 * Emite la factura de la plataforma: número de NUESTRA serie, devengo, régimen
 * fiscal probado y cuota en euros, todo en **una sola transacción**.
 *
 * Es idempotente por `stripe_invoice_id` (UNIQUE): si Stripe reenvía el evento,
 * se devuelve la factura ya emitida en vez de consumir otro número. La
 * idempotencia del *evento* la lleva `subscription_events`; ésta es la de la
 * *factura*, y hacen falta las dos — un mismo `invoice.finalized` puede llegar
 * bajo dos ids de evento distintos tras un reintento de Stripe.
 */
export async function issuePlatformInvoice(input: IssuePlatformInvoiceInput): Promise<PlatformInvoiceRecord> {
  const { organizationId, facts } = input

  return await tenantTransaction(organizationId, async (tx) => {
    const yaEmitida = await tx.platformInvoice.findFirst({
      where: { stripeInvoiceId: facts.stripeInvoiceId },
    })
    if (yaEmitida) return toRecord(yaEmitida)

    // 1 · Devengo (C-2). El cobro posterior no lo mueve.
    const operationDate = accrualDateOf(facts.periodStart, facts.paidAt)
    const issuedAt = facts.issuedAt ?? operationDate
    const ivaPeriod = ivaPeriodOf(operationDate)

    // 2 · Régimen fiscal, decidido EN EL DEVENGO (C-1, O-15) — salvo en una
    // rectificativa, que hereda el de la factura que rectifica.
    const decision = input.forceTreatment
      ? {
          treatment: input.forceTreatment.treatment,
          rateBps: input.forceTreatment.treatment === "REPERCUTIDO_ES" ? 2100 : 0,
          mention: input.forceTreatment.mention,
          reason: "Régimen heredado de la factura rectificada (art. 89 LIVA).",
        }
      : resolveTaxTreatment(input.recipient, { postalCode: input.postalCode })

    // Coherencia con lo que Stripe cobró: si el tratamiento dice «no sujeto» y
    // Stripe repercutió cuota, algo no cuadra y **no se emite a ciegas**. Una
    // factura con cuota que el régimen no admite es la que hay que rectificar
    // después, y es más barato pararla aquí.
    if (decision.rateBps === 0 && facts.taxCents !== 0) {
      throw new PlatformInvoiceError(
        `La operación es ${decision.treatment} (cuota 0) pero Stripe repercutió ${facts.taxCents} céntimos. ` +
          "Revise la configuración de Stripe Tax antes de emitir: no se sella una factura con una cuota " +
          "que su régimen no admite."
      )
    }

    // 3 · Cuota en euros, a la tasa del devengo (C-4). Se sella.
    const quote = await fxQuoteAtAccrual(tx, facts.currency, operationDate)
    const { taxCentsEur, fx } = taxCentsInEur(facts.taxCents, facts.currency, quote)

    // 4 · Número de NUESTRA serie, con FOR UPDATE, en esta misma transacción.
    const kind = input.rectifies ? "RECTIFICATIVA" : "ORDINARIA"
    const asignado = await nextPlatformInvoiceNumberTx(tx, kind)

    const creada = await tx.platformInvoice.create({
      data: {
        organizationId,
        subscriptionId: facts.subscriptionId,
        seriesId: asignado.seriesId,
        number: asignado.number,
        fullNumber: asignado.fullNumber,
        rectifiesInvoiceId: input.rectifies?.invoiceId ?? null,
        rectificationCause: input.rectifies?.cause ?? null,
        rectificationMode: input.rectifies?.mode ?? null,
        operationDate,
        issuedAt,
        ivaPeriod,
        periodStart: facts.periodStart,
        periodEnd: facts.periodEnd,
        taxTreatment: decision.treatment,
        customerCountry: input.recipient.country.toUpperCase(),
        vatNumber: input.recipient.vatNumber,
        vatValidatedAt: input.vatValidatedAt ?? null,
        vatValidationSource: input.vatValidationSource ?? null,
        vatValidationRef: input.vatValidationRef ?? null,
        reverseChargeMention: decision.mention,
        subtotalCents: facts.subtotalCents,
        taxCents: facts.taxCents,
        totalCents: facts.totalCents,
        currency: facts.currency,
        taxCentsEur,
        fxRateMicro: fx?.rateMicro ?? null,
        fxRateDate: fx?.date ?? null,
        fxSource: fx?.source ?? null,
        status: facts.status,
        stripeInvoiceId: facts.stripeInvoiceId,
        hostedInvoiceUrl: facts.hostedInvoiceUrl,
      },
    })

    return toRecord(creada)
  })
}

type PlatformInvoiceModel = Awaited<ReturnType<TenantClient["platformInvoice"]["create"]>>

function toRecord(i: PlatformInvoiceModel): PlatformInvoiceRecord {
  return {
    id: i.id,
    fullNumber: i.fullNumber,
    number: i.number,
    seriesId: i.seriesId,
    operationDate: i.operationDate,
    issuedAt: i.issuedAt,
    ivaPeriod: i.ivaPeriod,
    taxTreatment: i.taxTreatment,
    subtotalCents: i.subtotalCents,
    taxCents: i.taxCents,
    totalCents: i.totalCents,
    currency: i.currency,
    taxCentsEur: i.taxCentsEur,
  }
}

/**
 * Enlaza el **PDF conservado** (C-5). Es uno de los tres campos que el `GRANT`
 * de columna deja actualizar: un enlace a la copia de un tercero no es una copia
 * conservada (art. 165.Uno LIVA, arts. 19–23 RD 1619/2012), así que la fila no
 * está completa hasta que este objeto existe.
 */
export async function attachStoredPdf(
  organizationId: string,
  invoiceId: string,
  storedObjectId: string
): Promise<void> {
  await tenantDb(organizationId).platformInvoice.update({
    where: { id: invoiceId },
    data: { storedObjectId },
  })
}

/** Actualiza el estado de cobro. No toca número, fechas, cifras ni régimen. */
export async function updatePlatformInvoiceStatus(
  organizationId: string,
  stripeInvoiceId: string,
  status: string
): Promise<void> {
  await tenantDb(organizationId).platformInvoice.updateMany({
    where: { stripeInvoiceId },
    data: { status },
  })
}

export async function getPlatformInvoiceByStripeId(db: AnyTenantClient, stripeInvoiceId: string) {
  return await db.platformInvoice.findFirst({ where: { stripeInvoiceId } })
}

/** Las facturas de una organización, de la más reciente a la más antigua. */
export async function listPlatformInvoices(db: AnyTenantClient, limit = 50) {
  return await db.platformInvoice.findMany({ orderBy: { operationDate: "desc" }, take: limit })
}

// ─────────────────────────────────────────────────────────────────────────────
// **I-E11-13** · la serie propia, vigilada como la del cliente (espejo de I-E8-20)
// ─────────────────────────────────────────────────────────────────────────────

export type SeriesIntegrity = {
  seriesCode: string
  lastNumber: number
  count: number
  /** Números que faltan entre 1 y `lastNumber`. */
  gaps: number[]
  duplicates: number[]
  /** Facturas cuya `operationDate` decrece respecto del número anterior. */
  outOfOrder: Array<{ number: number; operationDate: string }>
}

/**
 * Comprueba la integridad de las series de plataforma.
 *
 * Es el **espejo exacto de I-E8-20**: numeración correlativa sin huecos, sin
 * duplicados y con `operationDate` no decreciente respecto del número. *Es
 * indefendible exigirle al cliente un rigor que no nos aplicamos* (O-10).
 *
 * Se consulta con el rol que llame: la serie es global y el `SELECT` está
 * abierto, pero las facturas están acotadas por RLS — para el barrido completo,
 * el invariante lo ejecuta el operador con `app_maintenance`, igual que I10.
 */
export async function checkPlatformSeriesIntegrity(db: AnyTenantClient): Promise<SeriesIntegrity[]> {
  const series = await db.$queryRaw<{ id: string; code: string; last_number: number }[]>`
    SELECT "id", "code", "last_number" FROM "platform_invoice_series" ORDER BY "code"
  `

  const salida: SeriesIntegrity[] = []
  for (const s of series) {
    const filas = await db.$queryRaw<{ number: number; operation_date: Date }[]>`
      SELECT "number", "operation_date" FROM "platform_invoices"
       WHERE "series_id" = ${s.id}::uuid ORDER BY "number" ASC
    `
    const numeros = filas.map((f) => f.number)
    const vistos = new Set<number>()
    const duplicates: number[] = []
    for (const n of numeros) {
      if (vistos.has(n)) duplicates.push(n)
      vistos.add(n)
    }

    const gaps: number[] = []
    for (let n = 1; n <= s.last_number; n++) if (!vistos.has(n)) gaps.push(n)

    const outOfOrder: SeriesIntegrity["outOfOrder"] = []
    let anterior: Date | null = null
    for (const f of filas) {
      if (anterior && f.operation_date.getTime() < anterior.getTime()) {
        outOfOrder.push({ number: f.number, operationDate: f.operation_date.toISOString().slice(0, 10) })
      }
      anterior = f.operation_date
    }

    salida.push({ seriesCode: s.code, lastNumber: s.last_number, count: filas.length, gaps, duplicates, outOfOrder })
  }
  return salida
}

// ─────────────────────────────────────────────────────────────────────────────
// **O-17** · el 349 sin pantalla, pero no sin salida
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Modelo 349, clave **S** (prestaciones de servicios intracomunitarias),
 * agrupado por **devengo** y no por fecha de expedición ni de cobro.
 *
 * La pantalla sale del alcance de E11 y va a E14 (§0.3), pero la obligación no
 * espera a una épica (arts. 79–81 RIVA). Ésta es la misma consulta que el
 * runbook documenta, aquí como función para que un test la ejecute y **no se
 * pudra al cambiar una columna**.
 */
export async function report349(
  db: AnyTenantClient,
  desde: Date,
  hasta: Date
): Promise<Array<{ vatNumber: string | null; country: string; baseCents: number; invoices: number }>> {
  const rows = await db.$queryRaw<
    { vat_number: string | null; customer_country: string; base_cents: bigint; facturas: bigint }[]
  >`
    SELECT i."vat_number", i."customer_country",
           SUM(i."subtotal_cents")::bigint AS base_cents, COUNT(*)::bigint AS facturas
      FROM "platform_invoices" i
     WHERE i."tax_treatment" = 'NO_SUJETO_LOCALIZACION_UE'
       AND i."operation_date" >= ${desde}::date AND i."operation_date" < ${hasta}::date
     GROUP BY 1, 2
     ORDER BY 1
  `
  return rows.map((r) => ({
    vatNumber: r.vat_number,
    country: r.customer_country,
    baseCents: Number(r.base_cents),
    invoices: Number(r.facturas),
  }))
}

/**
 * Umbral de periodicidad **mensual** del 349: 50 000 € en el trimestre en curso
 * o en alguno de los cuatro anteriores. Si alguna fila supera 5 000 000 c, el
 * 349 pasa a mensual.
 */
export async function threshold349(db: AnyTenantClient): Promise<Array<{ ivaPeriod: string; baseCents: number }>> {
  const rows = await db.$queryRaw<{ iva_period: string; base_cents: bigint }[]>`
    SELECT i."iva_period", SUM(i."subtotal_cents")::bigint AS base_cents
      FROM "platform_invoices" i
     WHERE i."tax_treatment" = 'NO_SUJETO_LOCALIZACION_UE'
     GROUP BY 1 ORDER BY 1 DESC LIMIT 5
  `
  return rows.map((r) => ({ ivaPeriod: r.iva_period, baseCents: Number(r.base_cents) }))
}

export const UMBRAL_349_MENSUAL_CENTS = 5_000_000

export type { Prisma }
