/**
 * E8 · T15/T16/T17 — Modelos de vista del camino documental.
 *
 * Mismo contrato que `components/ledger/types.ts`: todo lo que cruza de un
 * Server Component a un Client Component es un objeto plano y serializable, con
 * los importes en **céntimos enteros** y las fechas como `"YYYY-MM-DD"`.
 *
 * El cliente **no calcula ninguna cifra contable**. Ni el cuadre, ni la base, ni
 * la cuota, ni el total: todo eso llega ya juzgado por `reconcile()` y
 * construido por `postFromProposal()` a través de `previewProposalAction`. Lo
 * único que el formulario hace con un importe es enseñarlo y, cuando se edita,
 * mandarlo **como texto** a `ui-actions.ts`, que es quien lo convierte a
 * céntimos con `parseCents()` en el servidor (patrón de
 * `app/(app)/analytics/allocations/ui-actions.ts`).
 */

import type { CheckView, EntryPreview, ProposalPreview } from "@/app/(app)/unsorted/actions"

export type { CheckView, EntryPreview, ProposalPreview }

/** Estado de un fichero en la bandeja, ya resuelto en el servidor. */
export type InboxStatus = "SIN_ANALIZAR" | "PASS" | "WARN" | "FAIL" | "PARCIAL" | "IMPORTADO"

export const INBOX_STATUS_LABEL: Readonly<Record<InboxStatus, string>> = {
  SIN_ANALIZAR: "Sin analizar",
  PASS: "Conforme",
  WARN: "Con avisos",
  FAIL: "No conforme",
  PARCIAL: "Extracción parcial",
  IMPORTADO: "Importado sin origen",
}

export type InboxRowView = {
  fileId: string
  filename: string
  mimetype: string
  uploadedAt: string
  sha256: string | null
  runId: string | null
  runCount: number
  runCreatedAt: string | null
  status: InboxStatus
  docKind: string | null
  documentNumber: string | null
  totalCents: number | null
  currency: string | null
  /** `true` sólo si el run sellado dice que el documento entra en el lote. */
  elegibleParaLote: boolean
  /** Por qué no entra, en español contable. `null` si entra. */
  motivoNoElegible: string | null
}

/** Un `ExtractionRun` en el selector de la cadena de revisión. */
export type RunOptionView = {
  id: string
  kind: string
  provider: string
  model: string
  createdAt: string
  promptShaShort: string
  schemaVersion: string
  pagesSent: number
  pagesTotal: number
  partial: boolean
  reconcileStatus: string | null
  parentRunId: string | null
  /** Posición en la cadena: 1 = extracción original. */
  ordinal: number
}

/** Provenance de un campo tal y como la sella `reconcile()` (§7). */
export type FieldOriginView = {
  origin: string
  confidence: string
  check?: string | null
  rawText?: string | null
  page?: number | null
}

/** La operación que ya existe para este documento, si la hay. */
export type DocumentTransactionView = {
  id: string
  status: string
  journalEntryId: string | null
  entryNumber: number | null
  voidedEntryId: string | null
}

/** Cabecera del fichero: lo que el visor y la cadena de trazabilidad enseñan. */
export type DocumentFileView = {
  id: string
  filename: string
  mimetype: string
  sha256: string | null
  sizeBytes: number | null
  uploadedAt: string
  isReviewed: boolean
}

/** Nombre de cada cuenta del plan, para decorar el asiento propuesto. */
export type AccountNameMap = Readonly<Record<string, string>>

/** Opciones del formulario que vienen del catálogo, nunca del modelo (O-10). */
export type ProposalFormOptions = {
  taxRateCodes: readonly { code: string; label: string }[]
  accountCodes: readonly { code: string; name: string }[]
  categories: readonly { code: string; name: string }[]
  baseCurrency: string
  currencies: readonly string[]
}

export const DOC_KIND_LABEL: Readonly<Record<string, string>> = {
  FACTURA_RECIBIDA: "Factura recibida",
  FACTURA_RECIBIDA_ISP: "Factura recibida con inversión del sujeto pasivo",
  FACTURA_RECIBIDA_EXTRACOM: "Factura de proveedor de tercer país",
  DUA_IMPORTACION: "DUA de importación",
  ABONO_RECIBIDO: "Abono recibido",
  TICKET: "Factura simplificada (ticket)",
  FACTURA_ANTICIPO_PROVEEDOR: "Factura de anticipo a proveedor",
  NOTA_GASTO_EMPLEADO: "Nota de gasto de empleado",
  FACTURA_EMITIDA: "Factura emitida",
  ABONO_EMITIDO: "Abono emitido",
  FACTURA_ANTICIPO_CLIENTE: "Factura de anticipo de cliente",
  NOMINA: "Nómina",
  RECIBO_SS: "Recibo de la Seguridad Social",
  EXTRACTO_BANCARIO: "Extracto bancario",
  DESCONOCIDO: "Sin clasificar",
}

export const LINE_KIND_LABEL: Readonly<Record<string, string>> = {
  OPERACION: "Operación",
  SUPLIDO: "Suplido",
  NO_SUJETO: "No sujeto",
}

export const DEDUCTIBILITY_LABEL: Readonly<Record<string, string>> = {
  FULL: "Deducible",
  NONE: "No deducible",
  PRORRATA: "Prorrata",
}

/**
 * Las **cuatro fechas** explicadas, una línea cada una (§6). Sin la explicación,
 * cuatro fechas son tres de más: cada una decide una cosa distinta y ninguna es
 * intercambiable con las otras.
 */
export const DATE_EXPLANATIONS: readonly { field: string; label: string; help: string }[] = [
  {
    field: "documentDate",
    label: "Fecha de expedición",
    help: "La del documento. Selecciona el tipo de IVA cuando no hay fecha de devengo distinta y fija el ejercicio del número de factura.",
  },
  {
    field: "operationDate",
    label: "Fecha de devengo",
    help: "Cuándo se realizó la operación (art. 75 LIVA). Es la que elige el tipo aplicable (art. 90.Dos), aunque la factura se expida después.",
  },
  {
    field: "receptionDate",
    label: "Fecha de recepción",
    help: "Cuándo llegó la factura. Decide el trimestre en el que se deduce el IVA soportado: periodo = máximo entre recepción y expedición.",
  },
  {
    field: "accrualDate",
    label: "Fecha contable",
    help: "La del asiento en el libro diario. Determina el ejercicio y el mes; tiene que caer en un periodo abierto.",
  },
]
