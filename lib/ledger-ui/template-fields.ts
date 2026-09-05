/**
 * E3 · T11 — Descriptores de formulario derivados de los schemas zod de las
 * plantillas (`lib/ledger/templates/schemas.ts`).
 *
 * Módulo PURO y de sólo lectura sobre `lib/ledger`: no lo modifica, lo
 * INTROSPECCIONA. La UI no puede tener su propia copia de la forma de cada
 * input —serían 24 formularios que se desincronizan del motor en cuanto una
 * plantilla cambie—, así que el formulario se genera del mismo schema que
 * valida el servidor. Si un campo cambia en el schema, cambia en la pantalla.
 *
 * Lo que este módulo NO hace: calcular. Convierte texto a céntimos
 * (`coerceRawInput`) y eso ocurre **en el servidor**, dentro de la acción; el
 * navegador sólo manda cadenas.
 */

import { z } from "zod"

import { parseCents } from "@/lib/money"

export type FieldKind =
  | "text"
  | "textarea"
  | "date"
  | "amount"
  | "signedAmount"
  | "integer"
  | "select"
  | "account"
  | "taxRate"
  | "boolean"

export type SelectOption = { value: string; label: string }

export type FieldDescriptor = {
  /** Ruta con `[]` por nivel de array: `lines[].baseCents`. */
  path: string
  name: string
  label: string
  kind: FieldKind
  optional: boolean
  options?: SelectOption[]
  defaultValue?: string
  help?: string
}

export type FieldNode =
  | { node: "field"; field: FieldDescriptor }
  | {
      node: "array"
      path: string
      label: string
      /** `true` = lista repetible (`lines[]`); `false` = objeto anidado (`period`). */
      isList: boolean
      minItems: number
      children: FieldNode[]
    }

export type TemplateFormSpec = {
  code: string
  label: string
  block: string
  children: FieldNode[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Etiquetas en español (PGC). Lo que no esté aquí se humaniza a partir del
// nombre del campo, para que añadir un campo al schema no rompa la pantalla.
// ─────────────────────────────────────────────────────────────────────────────

const LABELS: Record<string, string> = {
  accountCode: "Cuenta",
  accrualDate: "Fecha de devengo",
  accumulatedAccountCode: "Cuenta de amortización acumulada",
  accumulatedCents: "Amortización acumulada",
  acquisitionCostCents: "Valor de adquisición",
  adjustmentKind: "Naturaleza del ajuste",
  advanceAppliedCents: "Anticipo aplicado",
  amountCents: "Importe",
  amountPaidCents: "Importe pagado",
  amountReceivedCents: "Importe cobrado",
  analyticType: "Tipo analítico",
  appliedAdvanceCents: "Anticipo aplicado",
  appliedAdvanceTaxCents: "IVA del anticipo aplicado",
  assetAccountCode: "Cuenta del inmovilizado",
  bankAccountCode: "Cuenta de tesorería",
  bankFeeCents: "Comisión bancaria",
  bankKey: "Tesorería",
  baseCents: "Base imponible",
  carryForwardCents: "Cuota a compensar de periodos anteriores",
  counterpartAccountCode: "Cuenta de contrapartida",
  counterpartKey: "Contrapartida",
  counterpartyId: "Tercero",
  deductibility: "Deducibilidad del IVA",
  deductibleVatCents: "IVA deducible del documento antiguo",
  deductibleVatRateCode: "Tipo de IVA del documento antiguo",
  description: "Concepto",
  direction: "Sentido",
  documentDate: "Fecha del documento",
  documentNumber: "Número de documento",
  dueDate: "Vencimiento",
  dueSchedule: "Vencimientos",
  employeeSSCents: "Seguridad Social a cargo del trabajador",
  employerSS: "Seguridad Social a cargo de la empresa",
  entryDate: "Fecha contable",
  equityAccountCode: "Cuenta de patrimonio (113 / 121)",
  expenseAccountCode: "Cuenta de gasto",
  fromAccountCode: "Cuenta de origen",
  fromKey: "Origen",
  fxDifferenceCents: "Diferencia de cambio (+ ganancia / − pérdida)",
  gross: "Salario bruto",
  inputCents: "IVA soportado del periodo",
  items: "Detalle",
  liabilityKey: "Deuda que se paga",
  lines: "Líneas",
  month: "Mes",
  netCents: "Líquido a percibir",
  openLiabilityCents: "Saldo vivo de la deuda",
  originalDocumentDate: "Fecha del documento original",
  outputCents: "IVA repercutido del periodo",
  payableKey: "Cuenta de acreedores",
  period: "Periodo",
  periodEnd: "Fin del periodo",
  periodStart: "Inicio del periodo",
  prepaymentsCents: "Pagos fraccionados soportados",
  projectId: "Proyecto",
  costCenterId: "Centro de coste",
  rateBps: "Tipo (puntos básicos)",
  reason: "Motivo",
  receivableKey: "Cuenta de clientes",
  rectifiesEntryId: "Asiento rectificado",
  revenueAccountCode: "Cuenta de ingreso",
  roundingCents: "Ajuste de redondeo",
  settlements: "Aplicaciones",
  sourceEntryId: "Asiento de origen",
  sourceId: "Referencia de origen",
  supplierDocumentNumber: "Número de factura del proveedor",
  surchargeAccountCode: "Cuenta del recargo",
  surchargeCents: "Recargo o intereses de demora",
  surchargeRateCode: "Recargo de equivalencia",
  taxRateCode: "Tipo impositivo",
  taxRateId: "Tipo impositivo",
  taxableBaseCents: "Base imponible del impuesto",
  toAccountCode: "Cuenta de destino",
  toKey: "Destino",
  totalCents: "Total del documento",
  withholdingCents: "Retención de IRPF",
  withholdingKey: "Cuenta de retención",
  withholdingRateCode: "Tipo de retención",
  withholdingTaxRateCode: "Tipo de retención",
  year: "Año",
}

const ENUM_LABELS: Record<string, string> = {
  ACREEDORES: "Acreedores (410)",
  BANCO_DEFAULT: "Banco",
  CAJA: "Caja",
  CLIENTES: "Clientes (430)",
  CLIENTES_DUDOSO_COBRO: "Clientes de dudoso cobro (436)",
  COMPRAS_DEFAULT: "Compras",
  DESCUENTO_POSTERIOR: "Descuento posterior",
  DEVOLUCION: "Devolución",
  ERROR: "Error",
  FULL: "Íntegramente deducible",
  GASTO: "Gasto",
  HP_ACREEDORA_IS: "Hacienda Pública acreedora por Impuesto de Sociedades",
  HP_ACREEDORA_IVA: "Hacienda Pública acreedora por IVA",
  INGRESO: "Ingreso",
  IRPF_A_PAGAR: "IRPF a pagar",
  IRPF_ALQUILERES_A_PAGAR: "IRPF de alquileres a pagar (4751)",
  IRPF_PROFESIONALES_A_PAGAR: "IRPF de profesionales a pagar (4751)",
  IRPF_TRABAJO_A_PAGAR: "IRPF del trabajo a pagar (4751)",
  MATERIAL: "Error material o cambio de criterio (NRV 22ª)",
  NO_SIGNIFICATIVO: "Importe no significativo",
  NONE: "No deducible",
  PRORRATA: "Prorrata",
  PROVEEDORES: "Proveedores (400)",
  RAPPEL: "Rappel",
  REMUNERACIONES_PENDIENTES: "Remuneraciones pendientes de pago (465)",
  SS_ACREEDORA: "Organismos de la Seguridad Social acreedores (476)",
  SUBCONTRATACION_DEFAULT: "Subcontratación",
  VENTAS_DEFAULT: "Ventas",
}

const humanize = (name: string): string =>
  LABELS[name] ??
  name
    .replace(/Cents$/, "")
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase())
    .trim()

const enumLabel = (value: string) => ENUM_LABELS[value] ?? value

// ─────────────────────────────────────────────────────────────────────────────
// Introspección
// ─────────────────────────────────────────────────────────────────────────────

type UnwrapResult = { schema: z.ZodTypeAny; optional: boolean; defaultValue?: unknown }

function unwrap(schema: z.ZodTypeAny): UnwrapResult {
  let current: z.ZodTypeAny = schema
  let optional = false
  let defaultValue: unknown

  // Los schemas envuelven con `.optional()`, `.default()`, `.refine()` (que en
  // zod 3 es un ZodEffects) y `.nullable()`. Hay que llegar al tipo base sin
  // perder por el camino si era opcional ni cuál era su valor por defecto.
  for (let guard = 0; guard < 12; guard += 1) {
    if (current instanceof z.ZodOptional) {
      optional = true
      current = current.unwrap()
    } else if (current instanceof z.ZodNullable) {
      optional = true
      current = current.unwrap()
    } else if (current instanceof z.ZodDefault) {
      optional = true
      defaultValue = current._def.defaultValue()
      current = current._def.innerType
    } else if (current instanceof z.ZodEffects) {
      current = current._def.schema
    } else if (current instanceof z.ZodBranded) {
      current = current.unwrap()
    } else {
      break
    }
  }

  return defaultValue === undefined ? { schema: current, optional } : { schema: current, optional, defaultValue }
}

function kindOf(name: string, schema: z.ZodTypeAny): FieldKind | null {
  if (schema instanceof z.ZodEnum) return "select"
  if (schema instanceof z.ZodBoolean) return "boolean"
  if (schema instanceof z.ZodNumber) {
    if (/Cents$/.test(name)) {
      // Los que admiten signo son diferencias, no importes de línea.
      return /^(fxDifference|rounding|taxableBase)/.test(name) ? "signedAmount" : "amount"
    }
    return "integer"
  }
  if (schema instanceof z.ZodString) {
    if (/Date$/.test(name)) return "date"
    if (/AccountCode$/.test(name) || name === "accountCode") return "account"
    if (/RateCode$/.test(name)) return "taxRate"
    if (name === "description" || name === "reason") return "textarea"
    return "text"
  }
  return null
}

function describe(name: string, schema: z.ZodTypeAny, path: string): FieldNode | null {
  const { schema: base, optional, defaultValue } = unwrap(schema)

  if (base instanceof z.ZodArray) {
    const item = unwrap(base.element).schema
    const min = typeof base._def.minLength?.value === "number" ? base._def.minLength.value : 0
    if (item instanceof z.ZodObject) {
      const children = describeObject(item, `${path}[]`)
      if (children.length === 0) return null
      return { node: "array", path, label: humanize(name), isList: true, minItems: Math.max(min, 1), children }
    }
    return null
  }

  if (base instanceof z.ZodObject) {
    // Objeto anidado sin repetición (p. ej. `period: {year, month}`): se pinta
    // como un grupo de campos, no como una lista con botón "añadir".
    const children = describeObject(base, path)
    if (children.length === 0) return null
    return { node: "array", path, label: humanize(name), isList: false, minItems: 1, children }
  }

  if (base instanceof z.ZodRecord) return null // `balances`: sólo T-26…T-28, que no tienen pantalla.

  const kind = kindOf(name, base)
  if (kind === null) return null

  const field: FieldDescriptor = {
    path,
    name,
    label: humanize(name),
    kind,
    optional,
  }
  if (kind === "select" && base instanceof z.ZodEnum) {
    field.options = (base.options as readonly string[]).map((value) => ({ value, label: enumLabel(value) }))
  }
  if (defaultValue !== undefined && (typeof defaultValue === "string" || typeof defaultValue === "number")) {
    field.defaultValue = String(defaultValue)
  }
  if (kind === "amount" || kind === "signedAmount") {
    field.help = "En euros: 1.234,56. El servidor lo convierte a céntimos."
  }
  return { node: "field", field }
}

function describeObject(schema: z.ZodObject<z.ZodRawShape>, prefix: string): FieldNode[] {
  const out: FieldNode[] = []
  for (const [name, child] of Object.entries(schema.shape)) {
    const node = describe(name, child as z.ZodTypeAny, prefix === "" ? name : `${prefix}.${name}`)
    if (node) out.push(node)
  }
  return out
}

/** Descriptor de formulario de una plantilla, a partir de su schema zod. */
export function templateFormSpec(
  code: string,
  label: string,
  block: string,
  schema: z.ZodTypeAny
): TemplateFormSpec {
  const { schema: base } = unwrap(schema)
  const children = base instanceof z.ZodObject ? describeObject(base as z.ZodObject<z.ZodRawShape>, "") : []
  return { code, label, block, children }
}

// ─────────────────────────────────────────────────────────────────────────────
// Coerción — se ejecuta EN EL SERVIDOR (`app/(app)/ledger/ui-actions.ts`)
// ─────────────────────────────────────────────────────────────────────────────

export type RawInput = Record<string, string>

type Json = string | number | boolean | Json[] | { [key: string]: Json } | null

function coerceValue(field: FieldDescriptor, raw: string): Json | undefined {
  const value = raw.trim()
  if (value === "") return undefined
  switch (field.kind) {
    case "amount":
    case "signedAmount": {
      const cents = parseCents(value)
      return cents === null ? undefined : cents
    }
    case "integer": {
      const n = Number(value)
      return Number.isFinite(n) ? Math.trunc(n) : undefined
    }
    case "boolean":
      return value === "true" || value === "on" || value === "1"
    default:
      return value
  }
}

/**
 * Reconstruye el input tipado de la plantilla a partir del mapa plano de
 * cadenas que manda el formulario. Las claves llevan el índice del array:
 * `lines.0.baseCents`, `lines.1.taxRateCode`…
 *
 * Nada de esto es aritmética contable: es parseo de entrada. Lo contable lo
 * calculan la plantilla y `checkDraft`, con el `LedgerContext` delante.
 */
export function coerceRawInput(spec: TemplateFormSpec, raw: RawInput): Record<string, Json> {
  const build = (children: readonly FieldNode[], prefix: string): Record<string, Json> => {
    const out: Record<string, Json> = {}
    for (const child of children) {
      if (child.node === "field") {
        const key = prefix === "" ? child.field.path : `${prefix}.${child.field.name}`
        const value = coerceValue(child.field, raw[key] ?? "")
        if (value !== undefined) out[child.field.name] = value
        continue
      }

      const name = child.path.split(".").pop() ?? child.path
      const arrayPrefix = prefix === "" ? name : `${prefix}.${name}`
      const items: Record<string, Json>[] = []
      for (let index = 0; index < 40; index += 1) {
        const itemPrefix = `${arrayPrefix}.${index}`
        const hasAny = Object.keys(raw).some((key) => key.startsWith(`${itemPrefix}.`) && raw[key].trim() !== "")
        if (!hasAny) continue
        const item = build(child.children, itemPrefix)
        if (Object.keys(item).length > 0) items.push(item)
      }
      if (items.length === 0) continue
      out[name] = child.isList ? (items as Json[]) : items[0]
    }
    return out
  }

  return build(spec.children, "")
}
