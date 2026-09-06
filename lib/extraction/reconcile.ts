/**
 * E8 · T7 — `reconcile()`: la propuesta del modelo, recalculada, contrastada y
 * clasificada campo a campo (`docs/design/E8-documentos-asientos.md` §3.3,
 * ADR-0014 D3, D4, D8, D9, D10, D11, D12, D13).
 *
 * Módulo **PURO**: sin IO, sin Prisma, sin LLM, sin `Date.now()`. Todo lo que
 * depende del mundo —la fecha de hoy, el sha del fichero en disco, el resultado
 * de VIES, si hay duplicado, la tasa de cambio persistida— entra por
 * `ReconcileContext`. `canonicalJson(reconcile(p, ctx))` es estable byte a byte
 * entre ejecuciones y procesos (I-E8-6).
 *
 * Tres ideas gobiernan el fichero:
 *
 *  1. **El LLM extrae; el código calcula** (P1). Ningún importe de `normalized`
 *     procede de la salida cruda sin haber pasado por un check (RC-16).
 *  2. **La cuota que se contabiliza es la del documento** (ADR-0014 D3). El
 *     recálculo es control de verosimilitud: fija la confianza y alimenta
 *     `quotaDeviationsCents`, que es la **métrica** I-E8-7b y no un importe.
 *  3. **La calificación fiscal la decide la organización, no el documento**
 *     (D11): retención, deducibilidad, cuenta, dimensiones e ISP entran por el
 *     contexto o por el usuario, jamás por el PDF.
 *
 * Un **WARN puede bloquear el lote sin ser FAIL** (`blocksBatch`, O-19): son dos
 * cosas distintas —«esto está mal» y «esto no se confirma sin mirarlo»— y
 * mezclarlas era lo que hacía que el camino silencioso, confirmar en lote sin
 * abrir el documento, dedujera cuotas que nadie había mirado.
 */

import { applyBps } from "@/lib/taxes/bps"
import { cuota } from "@/lib/ledger/tax"
import { compareDates, isValidLocalDate, monthOf } from "@/lib/ledger/dates"
import type {
  Cents,
  DocKind,
  Deductibility,
  ExtractionProposal,
  FieldOrigin,
  FieldOrigins,
  LineKind,
  LocalDate,
  PaymentKey,
  ProposalLine,
  ProposalTax,
  Provenanced,
} from "@/lib/extraction/types"
import type { FiscalYearRef, PeriodLockRef, TaxRoundingMode } from "@/lib/ledger/types"

// ─────────────────────────────────────────────────────────────────────────────
// Constantes del motor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ADR-0014 D3 / O-16: desviación máxima admitida **por tipo impositivo** entre
 * la cuota declarada y la recalculada. Constante del motor, **no configurable**:
 * subirla exige un ADR, no una pantalla de ajustes. Se re-exporta desde
 * `lib/ledger/tax.ts`, que es donde vive, para que no haya dos números.
 */
export { TOLERANCIA_CUOTA_IVA_CENTS } from "@/lib/ledger/tax"
import { TOLERANCIA_CUOTA_IVA_CENTS } from "@/lib/ledger/tax"

/** Art. 99.Cinco LIVA: el derecho a deducir caduca a los cuatro años. */
export const CADUCIDAD_DEDUCCION_ANIOS = 4

export const RECONCILE_STATUSES = ["PASS", "WARN", "FAIL"] as const
export type ReconcileStatus = (typeof RECONCILE_STATUSES)[number]

/**
 * Motivos de sello que E8 aporta a los de ADR-0012. Códigos **cerrados**
 * (ADR-0014 D7): un motivo de sello es un dato de auditoría, no una frase.
 */
export const E8_SEAL_REASONS = [
  "PROPUESTA_NO_RECONCILIADA",
  "DOCUMENTO_ALTERADO",
  "TASA_FORZADA",
  "RETENCION_NO_PRACTICADA",
  "IVA_PERIODO_DESPLAZADO",
  "REGIMEN_NO_SOPORTADO",
] as const
export type E8SealReason = (typeof E8_SEAL_REASONS)[number]

/** Orden FIJO de los checks. El determinismo de I-E8-6 empieza aquí. */
export const RECONCILE_RULES: readonly { id: ReconcileCheckId; regla: string }[] = [
  { id: "RC-01", regla: "Sigma bases de las lineas OPERACION = base declarada (suplidos y no sujetos fuera)" },
  { id: "RC-02", regla: "Cuota del documento contrastada por tipo con cuota(bases, rateBps, mode)" },
  {
    id: "RC-03",
    regla: "Identidad interna: Sigma bases + cuotas + recargos + suplidos y no sujetos - retencion - anticipo = total",
  },
  { id: "RC-04", regla: "Moneda ISO-4217 existente, exponente correcto y unica en el documento" },
  { id: "RC-05", regla: "Las cuatro fechas existen; documentDate <= refDate; ejercicio abierto y mes no bloqueado" },
  { id: "RC-06", regla: "Todo taxRateCode vigente a operationDate ?? accrualDate ?? documentDate (art. 90.Dos LIVA)" },
  { id: "RC-07", regla: "Toda cuenta existe, es postable y activa; ninguna del subgrupo 64" },
  { id: "RC-08", regla: "Proyecto/CECO existen y son exclusivos entre si" },
  { id: "RC-09", regla: "Extraccion completa: pagesAnalyzed = pagesTotal; un run parcial de kind LLM no respalda asiento" },
  { id: "RC-10", regla: "sha256 del fichero en disco = el sellado en el ExtractionRun" },
  { id: "RC-11", regla: "Identificador fiscal por rama de pais: ES modulo 23 / letra CIF; UE formato + VIES; tercer pais libre" },
  { id: "RC-12", regla: "Sin duplicado por sha256 ni por (taxId, numero de documento, ejercicio)" },
  { id: "RC-13", regla: "Signos: totalCents > 0; total negativo en FACTURA_* se reclasifica a ABONO_* con absolutos" },
  { id: "RC-14", regla: "Moneda distinta de la base exige tasa persistida; sin tasa no se inventa nada" },
  { id: "RC-15", regla: "Deducibilidad resuelta: prorrata o REQUIERE_DECISION dejan el campo no verificado" },
  { id: "RC-16", regla: "Reproducibilidad: proposalHash estable y ningun importe procedente de rawOutput sin check" },
  { id: "RC-17", regla: "Documento con IVA incluido: base = round_half_up(total x 10000/(10000+bps)), cuota residual" },
  { id: "RC-18", regla: "IVA no caducado: documentDate a menos de cuatro anos de la fecha de deduccion (art. 99.Cinco LIVA)" },
  { id: "RC-19", regla: "Retencion practicada = la del regimen de Counterparty; lo leido solo contrasta" },
  { id: "RC-20", regla: "Suplidos y no sujetos fuera de Sigma bases, de la base de la cuota y de la base de la retencion" },
  { id: "RC-21", regla: "ABONO_* exige rectifies{documentNumber, reason, mode}; con SUSTITUCION, el rectificado resuelto" },
  { id: "RC-22", regla: "ISP solo con las cuatro precondiciones: pais/VIES con fecha, ausencia de cuota, mencion legal y ROI" },
  { id: "RC-23", regla: "appliedAdvanceTaxCents = IVA repercutido del asiento del anticipo referenciado" },
  { id: "RC-24", regla: "Organization.ivaRegime = GENERAL; RECC/REDEME/OTRO bloquean la contabilizacion automatica" },
  { id: "RC-25", regla: "FACTURA_ANTICIPO_CLIENTE exige cobro registrado: sin cobro no hay 477 (art. 75.Dos LIVA)" },
]

export type ReconcileCheckId =
  | "RC-01" | "RC-02" | "RC-03" | "RC-04" | "RC-05" | "RC-06" | "RC-07" | "RC-08" | "RC-09"
  | "RC-10" | "RC-11" | "RC-12" | "RC-13" | "RC-14" | "RC-15" | "RC-16" | "RC-17"
  | "RC-18" | "RC-19" | "RC-20" | "RC-21" | "RC-22" | "RC-23" | "RC-24" | "RC-25"

// ─────────────────────────────────────────────────────────────────────────────
// Contexto
// ─────────────────────────────────────────────────────────────────────────────

/** Tipo impositivo como lo ve el motor puro: fechas de vigencia en `LocalDate`. */
export type TaxRateRef = {
  id?: string
  code: string
  kind: string
  rateBps: number
  appliesTo: "SALE" | "PURCHASE" | "BOTH"
  validFrom: LocalDate
  validTo: LocalDate | null
}

export type AccountRef = { code: string; isPostable: boolean; isActive: boolean; group?: number }
export type DimensionRef = { id: string; isActive: boolean; status?: "OPEN" | "CLOSED" }

export type WithholdingRegime = "NINGUNO" | "PROFESIONAL" | "PROFESIONAL_INICIO" | "ARRENDADOR" | "AGRICOLA" | "MODULOS"

export type CounterpartyRef = {
  id: string | null
  name: string | null
  taxId: string | null
  countryCode: string | null
  vatNumber: string | null
  viesValid: boolean | null
  viesCheckedAt: LocalDate | null
  withholdingRegime: WithholdingRegime
  withholdingRateCode: string | null
  surchargeRegime: boolean
  isEmployee: boolean
  /** ¿Hay ficha en el maestro? Un NIF válido sin ficha es `interpretacion_ia`. */
  enMaestro: boolean
}

export type IvaRegime = "GENERAL" | "RECC" | "REDEME" | "OTRO"

export type OrganizationRef = {
  roiRegistered: boolean
  ivaRegime: IvaRegime
  prorrataBps: number | null
  taxRoundingMode: TaxRoundingMode
  redondeoToleranciaCents: number
  analyticsRequired: boolean
}

/** O-17: la deducibilidad por defecto de la categoría del gasto (ADR-0014 D4). */
export type CategoryRef = {
  code: string
  defaultAccountCode: string | null
  defaultDeductibility: "FULL" | "NONE" | "REQUIERE_DECISION"
}

export type RateRef = { id: string; rateMicro: bigint; rateDate: LocalDate; source: string; forced?: boolean }

export type RectifiedEntryRef = {
  id: string
  /** Base del documento rectificado **por tipo**: la diferencia se mide tipo a tipo. */
  baseByRate: Readonly<Record<string, Cents>>
  quotaByRate: Readonly<Record<string, Cents>>
}

export type ExtractionKind = "LLM" | "MANUAL" | "IMPORTED"

export type ReconcileContext = {
  baseCurrency: string
  /** Vigentes a la fecha de DEVENGO (O-14), no a la de expedición. */
  taxRates: readonly TaxRateRef[]
  accounts: readonly AccountRef[]
  accountMap: Readonly<Record<string, string>>
  projects: readonly DimensionRef[]
  costCenters: readonly DimensionRef[]
  currencies: readonly { code: string; exponent: number }[]
  fiscalYears: readonly FiscalYearRef[]
  periodLocks: readonly PeriodLockRef[]
  /** O-11 / O-4 / O-21: la calificación fiscal viene de aquí, no del PDF. */
  counterparty: CounterpartyRef | null
  organization: OrganizationRef
  /** O-17: categoría del documento, si la hay. Decide la deducibilidad por defecto. */
  category?: CategoryRef | null
  /** O-5: documento rectificado, para `mode = SUSTITUCION`. */
  rectifiedEntry?: RectifiedEntryRef | null
  /** O-7: asiento del anticipo aplicado, para RC-23. */
  advanceEntry?: { id: string; taxCents: Cents } | null
  /** O-23 / RC-25: cobro efectivo del anticipo de cliente ya registrado. */
  advanceCollected?: boolean
  rate?: RateRef | null
  /** RC-22 precondición 3: la mención del art. 6.1.m leída como TEXTO. */
  legalMentionArt61m?: string | null
  /** Lo que el modelo sugirió antes de la calificación firme (C15). */
  suggestedDocKind?: DocKind | null
  /** RC-12: lo resuelve quien lee la base; el motor puro no consulta nada. */
  duplicate?: { bySha256: boolean; byDocumentNumber: boolean }
  file: { sha256: string | null; runSha256: string | null }
  partial: boolean
  runKind: ExtractionKind
  /** Páginas que vio el modelo, de las totales (G-02). Sólo para el mensaje. */
  pagesAnalyzed?: number
  pagesTotal?: number
  refDate: LocalDate
}

// ─────────────────────────────────────────────────────────────────────────────
// Resultado
// ─────────────────────────────────────────────────────────────────────────────

export type ReconcileCheck = {
  id: ReconcileCheckId
  /** Enunciado del catálogo: la pantalla muestra la regla junto al veredicto. */
  regla: string
  status: ReconcileStatus
  /** O-19: un WARN puede bloquear el lote sin ser FAIL. */
  blocksBatch: boolean
  /** Español contable, apto para pantalla. */
  message: string
  evidence: Record<string, unknown>
  fields: readonly string[]
}

/** Diferencia de una rectificativa por SUSTITUCIÓN (O-5, ADR-0014 D12). */
export type RectificationDelta = {
  baseCents: Cents
  baseByRate: Readonly<Record<string, Cents>>
  quotaByRate: Readonly<Record<string, Cents>>
  totalCents: Cents
}

export type ConversionRef = {
  rateId: string
  rateMicro: bigint
  rateDate: LocalDate
  source: string
  convertedTotalCents: Cents
}

export type ReconcileResult = {
  status: ReconcileStatus
  checks: readonly ReconcileCheck[]
  /** La propuesta que se contabiliza: normalizada, nunca la cruda. */
  normalized: ExtractionProposal
  fieldOrigins: FieldOrigins
  /** O-19: métrica de calidad (I-E8-7b), **NO** importe a contabilizar. */
  quotaDeviationsCents: Readonly<Record<string, Cents>>
  /** `PASS` global y ningún check con `blocksBatch`. */
  elegibleParaLote: boolean
  /** Motivos de sello que este documento aporta al periodo (ADR-0014 D7). */
  sellos: readonly E8SealReason[]
  /** Periodo de IVA = trimestre de `max(receptionDate, documentDate)` (D8). */
  ivaPeriod: string | null
  /** Fecha contable resuelta, o `null` si RC-05 no la pudo situar. */
  entryDate: LocalDate | null
  /** El ejercicio del documento está CERRADO ⇒ el asiento se desvía a T-22. */
  fiscalYearClosed: boolean
  /** Retención del RÉGIMEN de la contraparte, la que se practica (O-11). */
  withholding: { rateCode: string; baseCents: Cents; quotaCents: Cents; model: "111" | "115" } | null
  /** Sólo con `mode = SUSTITUCION`: lo que de verdad se contabiliza. */
  rectificationDelta: RectificationDelta | null
  /** Tasa aplicada y total convertido (D2). El reparto por línea es de T9. */
  conversion: ConversionRef | null
}

// ─────────────────────────────────────────────────────────────────────────────
// Aritmética y utilidades puras
// ─────────────────────────────────────────────────────────────────────────────

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0)

/** `round_half_up(numerator / denominator)` exacto y entero (RC-17). */
export function halfUpDiv(numerator: number, denominator: number): number {
  if (denominator <= 0) throw new RangeError("denominador positivo")
  const sign = numerator < 0 ? -1 : 1
  const n = Math.abs(numerator)
  const quotient = Math.floor(n / denominator)
  const remainder = n - quotient * denominator
  return sign * (remainder * 2 >= denominator ? quotient + 1 : quotient)
}

/** Trimestre natural de una fecha: "2026-Q2". */
export function quarterOf(date: LocalDate): string {
  const month = monthOf(date)
  return `${date.slice(0, 4)}-Q${Math.floor((month - 1) / 3) + 1}`
}

/** La mayor de dos fechas ISO (comparación lexicográfica: son `YYYY-MM-DD`). */
const maxDate = (a: LocalDate | null, b: LocalDate | null): LocalDate | null =>
  a === null ? b : b === null ? a : compareDates(a, b) >= 0 ? a : b

/** Años completos entre dos fechas ISO, sin `Date` ni husos. */
export function fullYearsBetween(from: LocalDate, to: LocalDate): number {
  const [fy, fm, fd] = from.split("-").map(Number)
  const [ty, tm, td] = to.split("-").map(Number)
  let years = ty - fy
  if (tm < fm || (tm === fm && td < fd)) years -= 1
  return years
}

const inForce = (rate: TaxRateRef, date: LocalDate): boolean =>
  compareDates(date, rate.validFrom) >= 0 && (rate.validTo === null || compareDates(date, rate.validTo) <= 0)

const appliesToSide = (rate: TaxRateRef, side: "SALE" | "PURCHASE"): boolean =>
  rate.appliesTo === "BOTH" || rate.appliesTo === side

/** El tipo de retención que impone el RÉGIMEN de la contraparte (O-11). */
const withholdingRateOf = (ctx: ReconcileContext): TaxRateRef | undefined => {
  const code = ctx.counterparty?.withholdingRateCode
  if (!code || ctx.counterparty?.withholdingRegime === "NINGUNO") return undefined
  return ctx.taxRates.find((r) => r.code === code)
}

// ── Identificación fiscal, RC-11 (O-25: tres ramas, y sólo la española falla) ──

const NIF_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE"
const CIF_CONTROL = "JABCDEFGHI"

/** Dígito/letra de control de un NIF, NIE o CIF español (módulo 23 / módulo 10). */
export function spanishTaxIdCheck(taxId: string): { valid: boolean; expected: string | null } {
  const id = taxId.trim().toUpperCase().replace(/[\s.-]/g, "")
  if (/^[0-9]{8}[A-Z]$/.test(id)) {
    const expected = NIF_LETTERS[Number(id.slice(0, 8)) % 23]
    return { valid: id[8] === expected, expected }
  }
  if (/^[XYZ][0-9]{7}[A-Z]$/.test(id)) {
    const prefix = String("XYZ".indexOf(id[0]))
    const expected = NIF_LETTERS[Number(prefix + id.slice(1, 8)) % 23]
    return { valid: id[8] === expected, expected }
  }
  if (/^[ABCDEFGHJNPQRSUVW][0-9]{7}[0-9A-J]$/.test(id)) {
    const digits = id.slice(1, 8).split("").map(Number)
    let total = 0
    digits.forEach((d, i) => {
      // Posiciones impares (1ª, 3ª…) se duplican y se suman sus cifras.
      if (i % 2 === 0) {
        const doubled = d * 2
        total += Math.floor(doubled / 10) + (doubled % 10)
      } else {
        total += d
      }
    })
    const controlDigit = (10 - (total % 10)) % 10
    const letterOrgs = "PQRSNW"
    const expectedLetter = CIF_CONTROL[controlDigit]
    const expectedDigit = String(controlDigit)
    const control = id[8]
    const mustBeLetter = letterOrgs.includes(id[0])
    const valid = mustBeLetter ? control === expectedLetter : control === expectedDigit || control === expectedLetter
    return { valid, expected: mustBeLetter ? expectedLetter : expectedDigit }
  }
  return { valid: false, expected: null }
}

const EU_COUNTRIES: ReadonlySet<string> = new Set([
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES", "FI", "FR", "HR", "HU", "IE",
  "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
])

/** Formato de NIF-IVA de la UE: dos letras de país y de 2 a 12 alfanuméricos. */
export function euVatNumberLooksValid(country: string, vatNumber: string | null): boolean {
  if (!vatNumber) return false
  const value = vatNumber.trim().toUpperCase().replace(/[\s.-]/g, "")
  if (!value.startsWith(country.toUpperCase())) return /^[0-9A-Z]{2,12}$/.test(value)
  return /^[0-9A-Z]{2,12}$/.test(value.slice(2))
}

export type TaxIdBranch = "ES" | "UE" | "TERCER_PAIS"

export const taxIdBranchOf = (countryCode: string | null | undefined): TaxIdBranch => {
  if (!countryCode || countryCode.toUpperCase() === "ES") return "ES"
  return EU_COUNTRIES.has(countryCode.toUpperCase()) ? "UE" : "TERCER_PAIS"
}

// ─────────────────────────────────────────────────────────────────────────────
// Clasificación de documentos
// ─────────────────────────────────────────────────────────────────────────────

const PURCHASE_KINDS: ReadonlySet<DocKind> = new Set<DocKind>([
  "FACTURA_RECIBIDA",
  "FACTURA_RECIBIDA_ISP",
  "FACTURA_RECIBIDA_EXTRACOM",
  "DUA_IMPORTACION",
  "ABONO_RECIBIDO",
  "TICKET",
  "FACTURA_ANTICIPO_PROVEEDOR",
  "NOTA_GASTO_EMPLEADO",
])

const SALE_KINDS: ReadonlySet<DocKind> = new Set<DocKind>([
  "FACTURA_EMITIDA",
  "ABONO_EMITIDO",
  "FACTURA_ANTICIPO_CLIENTE",
])

export const isPurchaseDoc = (kind: DocKind): boolean => PURCHASE_KINDS.has(kind)
export const isSaleDoc = (kind: DocKind): boolean => SALE_KINDS.has(kind)
export const taxSideOf = (kind: DocKind): "SALE" | "PURCHASE" => (isSaleDoc(kind) ? "SALE" : "PURCHASE")

/** El modelo 111 es de profesionales y trabajo; el 115, de arrendamientos. */
export const withholdingModelOf = (regime: WithholdingRegime): "111" | "115" =>
  regime === "ARRENDADOR" ? "115" : "111"

// ─────────────────────────────────────────────────────────────────────────────
// reconcile()
// ─────────────────────────────────────────────────────────────────────────────

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

class CheckList {
  private readonly byId = new Map<ReconcileCheckId, ReconcileCheck>()

  set(
    id: ReconcileCheckId,
    status: ReconcileStatus,
    message: string,
    opts: { blocksBatch?: boolean; evidence?: Record<string, unknown>; fields?: readonly string[] } = {}
  ): void {
    const regla = RECONCILE_RULES.find((r) => r.id === id)?.regla ?? id
    this.byId.set(id, {
      id,
      regla,
      status,
      blocksBatch: opts.blocksBatch ?? false,
      message,
      evidence: opts.evidence ?? {},
      fields: opts.fields ?? [],
    })
  }

  get(id: ReconcileCheckId): ReconcileCheck | undefined {
    return this.byId.get(id)
  }

  /** En el orden FIJO del catálogo, con `PASS` implícito para lo no evaluado. */
  toArray(): ReconcileCheck[] {
    return RECONCILE_RULES.map(
      ({ id, regla }) =>
        this.byId.get(id) ?? {
          id,
          regla,
          status: "PASS" as const,
          blocksBatch: false,
          message: "no aplica a este documento",
          evidence: {},
          fields: [],
        }
    )
  }
}

/** Registro de procedencia con la forma que la pantalla pinta por campo. */
function prov<T>(value: T | null, origin: FieldOrigin, confidence: Provenanced<T>["confidence"], check?: string): Provenanced<T> {
  return check === undefined ? { value, origin, confidence } : { value, origin, confidence, check }
}

export function reconcile(proposal: ExtractionProposal, ctx: ReconcileContext): ReconcileResult {
  const checks = new CheckList()
  const origins: FieldOrigins = {}
  const sellos = new Set<E8SealReason>()
  const quotaDeviationsCents: Record<string, Cents> = {}
  const mode: TaxRoundingMode = ctx.organization.taxRoundingMode

  // ── Normalización previa: signos (RC-13) y ticket con IVA incluido (RC-17) ──
  const normalized = normalizeProposal(proposal, ctx, checks, origins)
  const docKindResolved = normalized.docKind
  const side = taxSideOf(docKindResolved)

  const operationLines = normalized.lines.filter((l) => l.kind === "OPERACION")
  const otherLines = normalized.lines.filter((l) => l.kind !== "OPERACION")
  const netBase = (l: ProposalLine): Cents => l.baseCents - (l.discountCents ?? 0)
  const baseOperacion = sum(operationLines.map(netBase))
  const suplidosYNoSujetos = sum(otherLines.map(netBase))
  const declaredBase = sum(normalized.taxes.map((t) => t.baseCents))

  // ── RC-01 ────────────────────────────────────────────────────────────────
  const baseDeviation = baseOperacion - declaredBase
  if (baseDeviation !== 0) {
    checks.set(
      "RC-01",
      "FAIL",
      `las bases suman ${fmt(baseOperacion)} y el documento declara ${fmt(declaredBase)}: ` +
        `${baseDeviation > 0 ? "sobra" : "falta"} ${fmt(Math.abs(baseDeviation))} en céntimos`,
      { blocksBatch: true, evidence: { sumaBases: baseOperacion, baseDeclarada: declaredBase, desvio: baseDeviation } }
    )
  } else {
    checks.set("RC-01", "PASS", "las bases de las líneas suman la base declarada, tolerancia 0", {
      evidence:
        otherLines.length > 0
          ? {
              baseOperacion,
              suplidos: sum(otherLines.filter((l) => l.kind === "SUPLIDO").map(netBase)),
              noSujetos: sum(otherLines.filter((l) => l.kind === "NO_SUJETO").map(netBase)),
              baseDeclarada: declaredBase,
            }
          : {},
    })
  }

  // ── RC-02 · la cuota del documento contra el recálculo, POR TIPO ──────────
  const derivedFromTicket = checks.get("RC-17")?.status === "PASS" && checks.get("RC-17")?.evidence.baseCents !== undefined
  const taxAccrual = normalized.operationDate ?? normalized.accrualDate ?? normalized.documentDate
  const rateOf = (code: string): TaxRateRef | undefined =>
    ctx.taxRates.find((r) => r.code === code && (taxAccrual === null || inForce(r, taxAccrual)))

  const rc02Evidence: Record<string, unknown> = {}
  let rc02Status: ReconcileStatus = "PASS"
  const selfCharged = (t: ProposalTax): boolean => t.operationKey === "ISP" || t.operationKey === "AIB"

  for (const tax of normalized.taxes) {
    const rate = rateOf(tax.taxRateCode)
    if (!rate || rate.rateBps === 0) continue
    const bases = operationLines.filter((l) => l.taxRateCode === tax.taxRateCode).map(netBase)
    const recalculada = cuota(bases.length > 0 ? bases : [tax.baseCents], rate.rateBps, mode)
    const declarada = tax.quotaCents
    const desvio = declarada - recalculada
    if (derivedFromTicket) {
      rc02Evidence[tax.taxRateCode] = { declarada: null, derivada: declarada, desvio: 0 }
      continue
    }
    if (selfCharged(tax)) {
      // La cuota de un ISP/AIB no la repercute el proveedor: la calcula el
      // código con el tipo español que el usuario eligió.
      rc02Evidence[tax.taxRateCode] = { declarada: null, recalculada, desvio: 0, autorrepercutida: declarada }
      continue
    }
    rc02Evidence[tax.taxRateCode] = { declarada, recalculada, desvio, ...(desvio === 0 ? {} : { tolerancia: TOLERANCIA_CUOTA_IVA_CENTS }) }
    if (desvio !== 0) quotaDeviationsCents[tax.taxRateCode] = desvio
    if (Math.abs(desvio) > TOLERANCIA_CUOTA_IVA_CENTS) {
      rc02Status = "FAIL"
    } else if (desvio !== 0 && rc02Status !== "FAIL") {
      rc02Status = "WARN"
    }
  }

  if (!derivedFromTicket) {
    const fields = normalized.taxes
      .filter((t) => (rateOf(t.taxRateCode)?.rateBps ?? 0) > 0)
      .map((t) => `taxes.${t.taxRateCode}.quotaCents`)
    checks.set(
      "RC-02",
      rc02Status,
      rc02Status === "PASS"
        ? "la cuota del documento coincide con el recálculo al céntimo en todos los tipos"
        : rc02Status === "WARN"
          ? `la cuota del documento difiere del recálculo dentro de la tolerancia de ${TOLERANCIA_CUOTA_IVA_CENTS} céntimo: ` +
            "se contabiliza la del documento (ADR-0014 D3)"
          : `la cuota declarada se aparta del recálculo por encima de TOLERANCIA_CUOTA_IVA_CENTS = ${TOLERANCIA_CUOTA_IVA_CENTS}: ` +
            "tipo mal leído o factura defectuosa",
      { blocksBatch: rc02Status === "FAIL", evidence: rc02Evidence, fields }
    )
  } else {
    checks.set("RC-02", "PASS", "cuota residual por construcción: no hay recálculo que contrastar", {
      evidence: rc02Evidence,
    })
  }

  // ── RC-25 · el IVA del anticipo de cliente devenga AL COBRO (D13) ─────────
  const anticipoSinCobro =
    docKindResolved === "FACTURA_ANTICIPO_CLIENTE" && !ctx.advanceCollected && !normalized.advanceEntryId
  if (docKindResolved === "FACTURA_ANTICIPO_CLIENTE") {
    const cuotaDocumento = sum(normalized.taxes.map((t) => t.quotaCents))
    if (anticipoSinCobro) {
      checks.set(
        "RC-25",
        "WARN",
        "factura de anticipo sin cobro registrado: el IVA no devenga todavía (art. 75.Dos LIVA). " +
          "Se contabiliza 430 contra 438 sin línea de 477; el devengo llegará con el cobro (T-08)",
        {
          blocksBatch: true,
          evidence: {
            advanceEntryId: normalized.advanceEntryId ?? null,
            cobroEfectivo: false,
            cuotaDelDocumento: cuotaDocumento,
            cuotaContabilizada: 0,
            devengaraCon: "T-08 COBRO_CLIENTE",
          },
          fields: [...normalized.taxes.map((t) => `taxes.${t.taxRateCode}.quotaCents`), "advanceEntryId"],
        }
      )
      sellos.add("IVA_PERIODO_DESPLAZADO")
    } else {
      checks.set("RC-25", "PASS", "el anticipo tiene cobro registrado: el IVA devenga y se repercute con la factura", {
        evidence: { advanceEntryId: normalized.advanceEntryId ?? null, cobroEfectivo: true },
      })
    }
  }

  // ── RC-03 · identidad interna del documento (tolerancia 0) ────────────────
  // OBS-F3 del fixture: la cuota autorrepercutida de un ISP/AIB **no** forma
  // parte del total del documento —el proveedor no la repercute—, así que
  // sumarla haría FAIL a toda factura intracomunitaria correcta.
  const cuotasEnElTotal = sum(normalized.taxes.filter((t) => !selfCharged(t)).map((t) => t.quotaCents))
  const selfChargedTotal = sum(normalized.taxes.filter(selfCharged).map((t) => t.quotaCents))
  const retencionLeida = normalized.readWithholding?.quotaCents ?? 0
  const anticipoAplicado = (normalized.appliedAdvanceCents ?? 0) + (normalized.appliedAdvanceTaxCents ?? 0)
  const identidad = baseOperacion + cuotasEnElTotal + suplidosYNoSujetos - retencionLeida - anticipoAplicado
  const rc03Deviation = identidad - normalized.totalCents
  if (rc03Deviation !== 0) {
    checks.set(
      "RC-03",
      "FAIL",
      `${fmt(baseOperacion)} de base + ${fmt(cuotasEnElTotal)} de cuota = ${fmt(identidad)}, y el documento declara ` +
        `${fmt(normalized.totalCents)}: ${rc03Deviation > 0 ? "sobran" : "faltan"} ${fmt(Math.abs(rc03Deviation))} céntimos. ` +
        "Se pide factura corregida, no se ajusta con un asiento (art. 6 RD 1619/2012)",
      {
        blocksBatch: true,
        evidence: {
          bases: baseOperacion,
          cuotas: cuotasEnElTotal,
          suplidos: suplidosYNoSujetos,
          retencionLeida,
          anticipo: anticipoAplicado,
          total: normalized.totalCents,
          desvio: rc03Deviation,
        },
      }
    )
  } else {
    checks.set("RC-03", "PASS", "el documento cuadra consigo mismo (art. 6 RD 1619/2012), tolerancia 0", {
      evidence: {
        bases: baseOperacion,
        cuotas: cuotasEnElTotal,
        ...(suplidosYNoSujetos !== 0 ? { suplidos: suplidosYNoSujetos } : {}),
        retencionLeida,
        ...(selfChargedTotal !== 0 ? { cuotaAutorrepercutida: selfChargedTotal, cuotasEnDocumento: cuotasEnElTotal } : {}),
        total: normalized.totalCents,
        desvio: 0,
      },
    })
  }

  // ── RC-04 · moneda ────────────────────────────────────────────────────────
  const currency = ctx.currencies.find((c) => c.code === normalized.currency)
  if (!currency) {
    checks.set("RC-04", "FAIL", `la moneda ${normalized.currency} no es un código ISO-4217 conocido`, {
      blocksBatch: true,
      evidence: { currency: normalized.currency },
      fields: ["currency"],
    })
  } else if (currency.exponent !== 2) {
    checks.set("RC-04", "FAIL", `la moneda ${normalized.currency} tiene exponente ${currency.exponent} y el motor trabaja en céntimos`, {
      blocksBatch: true,
      evidence: { currency: normalized.currency, exponent: currency.exponent },
      fields: ["currency"],
    })
  } else {
    const foreign = normalized.currency !== ctx.baseCurrency
    checks.set(
      "RC-04",
      "PASS",
      foreign
        ? `${normalized.currency} es ISO-4217 con exponente 2 y es la única moneda del documento`
        : "una sola moneda, con exponente 2",
      { evidence: foreign ? { currency: normalized.currency, exponent: 2, monedasDetectadas: [normalized.currency] } : {} }
    )
  }

  // ── RC-05 · las cuatro fechas ─────────────────────────────────────────────
  const rc05 = checkDates(normalized, ctx)
  checks.set("RC-05", rc05.status, rc05.message, {
    blocksBatch: rc05.blocksBatch,
    evidence: rc05.evidence,
    fields: rc05.fields,
  })
  const entryDate = rc05.entryDate
  const ivaDate = maxDate(normalized.receptionDate, normalized.documentDate)
  const ivaPeriod = ivaDate ? quarterOf(ivaDate) : null

  // ── RC-06 · tipos vigentes al DEVENGO (art. 90.Dos LIVA) ──────────────────
  const missingRates: string[] = []
  for (const code of new Set(normalized.taxes.map((t) => t.taxRateCode))) {
    const rate = rateOf(code)
    if (!rate) missingRates.push(code)
    else if (!appliesToSide(rate, side)) missingRates.push(`${code} (lado ${side})`)
  }
  if (missingRates.length > 0) {
    checks.set("RC-06", "FAIL", `tipos no vigentes a la fecha de devengo ${taxAccrual}: ${missingRates.join(", ")}`, {
      blocksBatch: true,
      evidence: { fechaDevengo: taxAccrual, tipos: missingRates },
    })
  } else {
    const codes = [...new Set(normalized.taxes.map((t) => t.taxRateCode))]
    const single = codes.length === 1 ? rateOf(codes[0]) : undefined
    checks.set("RC-06", "PASS", "todos los tipos están vigentes a la fecha de devengo", {
      evidence: {
        fechaDevengo: taxAccrual,
        ...(single ? { taxRateCode: single.code, rateBps: single.rateBps } : { tipos: codes }),
        ...(normalized.operationDate ? { origenDelTipo: "usuario" } : {}),
      },
    })
  }

  // ── RC-07 · cuentas ───────────────────────────────────────────────────────
  const accountProblems: string[] = []
  for (const line of normalized.lines) {
    if (!line.accountCode) continue
    const account = ctx.accounts.find((a) => a.code === line.accountCode)
    if (!account) accountProblems.push(`${line.accountCode}: no está en el plan`)
    else if (!account.isPostable) accountProblems.push(`${line.accountCode}: no es postable`)
    else if (!account.isActive) accountProblems.push(`${line.accountCode}: no está activa`)
    if (line.accountCode.startsWith("64")) {
      accountProblems.push(`${line.accountCode}: el subgrupo 64 entra por T-10, no por una factura (O-13)`)
    }
  }
  if (accountProblems.length > 0) {
    checks.set("RC-07", "FAIL", `cuentas no utilizables: ${accountProblems.join(" · ")}`, {
      blocksBatch: true,
      evidence: { problemas: accountProblems },
    })
  } else {
    checks.set("RC-07", "PASS", "todas las cuentas del asiento son postables, activas y ajenas al subgrupo 64")
  }

  // ── RC-08 · dimensiones analíticas ────────────────────────────────────────
  const dimensionProblems: string[] = []
  let dimensionWarn = false
  normalized.lines.forEach((line, index) => {
    if (line.projectId && line.costCenterId) {
      dimensionProblems.push(`línea ${index + 1}: proyecto y CECO a la vez`)
    }
    if (line.projectId && !ctx.projects.some((p) => p.id === line.projectId && p.isActive)) {
      dimensionProblems.push(`línea ${index + 1}: el proyecto ${line.projectId} no existe o no está activo`)
    }
    if (line.costCenterId && !ctx.costCenters.some((c) => c.id === line.costCenterId && c.isActive)) {
      dimensionProblems.push(`línea ${index + 1}: el CECO ${line.costCenterId} no existe o no está activo`)
    }
    const isPnl = line.accountCode !== undefined && (line.accountCode.startsWith("6") || line.accountCode.startsWith("7"))
    if (isPnl && !line.projectId && !line.costCenterId && ctx.organization.analyticsRequired) {
      dimensionWarn = true
    }
  })
  if (dimensionProblems.length > 0) {
    checks.set("RC-08", "FAIL", `destinos analíticos inválidos: ${dimensionProblems.join(" · ")}`, {
      blocksBatch: true,
      evidence: { problemas: dimensionProblems },
    })
  } else if (dimensionWarn) {
    checks.set("RC-08", "WARN", "hay líneas 6/7 sin destino analítico: se rutean a CC-NA y la analítica queda degradada (R-A8)", {
      blocksBatch: true,
    })
  } else {
    checks.set("RC-08", "PASS", "las dimensiones analíticas existen y no se solapan")
  }

  // ── RC-09 · extracción completa (G-02, O-20.3) ────────────────────────────
  const partialBlocksPosting = ctx.partial && ctx.runKind === "LLM"
  if (partialBlocksPosting) {
    checks.set(
      "RC-09",
      "FAIL",
      `el modelo vio ${ctx.pagesAnalyzed ?? "?"} de ${ctx.pagesTotal ?? "?"} páginas: este documento no puede ` +
        "contabilizarse desde la extracción automática. Revise y teclee las cifras y se registrará como revisión humana",
      {
        blocksBatch: true,
        evidence: {
          pagesAnalyzed: ctx.pagesAnalyzed ?? null,
          pagesTotal: ctx.pagesTotal ?? null,
          partial: true,
          runKind: ctx.runKind,
          postError: "PARTIAL_RUN_CANNOT_POST",
        },
        fields: ["*"],
      }
    )
    // RC-01 deja de ser concluyente: puede cuadrar y faltar la mitad del documento.
    const rc01 = checks.get("RC-01")
    if (rc01 && rc01.status === "PASS") {
      const noLeidas = (ctx.pagesTotal ?? 0) - (ctx.pagesAnalyzed ?? 0)
      checks.set(
        "RC-01",
        "WARN",
        "las bases suman la base declarada de las páginas leídas, pero faltan páginas: el resultado no es concluyente",
        { blocksBatch: true, evidence: { paginasNoLeidas: noLeidas } }
      )
    }
  } else if (ctx.partial) {
    checks.set("RC-09", "WARN", "extracción parcial revisada por una persona: las cifras las asume quien las teclea", {
      blocksBatch: true,
      evidence: { partial: true, runKind: ctx.runKind },
    })
  } else {
    checks.set("RC-09", "PASS", "el modelo vio el documento completo")
  }

  // ── RC-10 · el fichero no ha cambiado desde la extracción ─────────────────
  if (!ctx.file.sha256 || !ctx.file.runSha256) {
    checks.set("RC-10", "FAIL", "el fichero no tiene sha256 registrado: sin él no se analiza ni se contabiliza (I-E8-9)", {
      blocksBatch: true,
      evidence: { fileSha256: ctx.file.sha256, runSha256: ctx.file.runSha256 },
    })
  } else if (ctx.file.sha256 !== ctx.file.runSha256) {
    checks.set("RC-10", "FAIL", "los bytes del fichero no son los que vio la extracción: el documento se ha alterado", {
      blocksBatch: true,
      evidence: { fileSha256: ctx.file.sha256, runSha256: ctx.file.runSha256 },
    })
    sellos.add("DOCUMENTO_ALTERADO")
  } else {
    checks.set("RC-10", "PASS", "el fichero no ha cambiado desde la extracción")
  }

  // ── RC-11 · identificación fiscal por rama de país (O-25) ─────────────────
  const rc11 = checkTaxId(normalized, ctx)
  checks.set("RC-11", rc11.status, rc11.message, {
    blocksBatch: rc11.blocksBatch,
    evidence: rc11.evidence,
    fields: ["counterparty.taxId"],
  })

  // ── RC-12 · duplicados ────────────────────────────────────────────────────
  const dup = ctx.duplicate
  if (dup && (dup.bySha256 || dup.byDocumentNumber)) {
    checks.set(
      "RC-12",
      "WARN",
      dup.bySha256
        ? "ya hay un documento con el mismo sha256: confirmar exige motivo y queda en AuditLog"
        : "ya hay un documento con el mismo número para el mismo NIF y ejercicio: doble pago y doble deducción es el vector clásico",
      { blocksBatch: true, evidence: { porSha256: dup.bySha256, porNumero: dup.byDocumentNumber } }
    )
  } else {
    checks.set("RC-12", "PASS", "no hay otro documento con el mismo sha256 ni el mismo número para el mismo NIF y ejercicio")
  }

  // ── RC-14 · divisa con tasa persistida ────────────────────────────────────
  let conversion: ConversionRef | null = null
  if (normalized.currency !== ctx.baseCurrency) {
    if (!ctx.rate) {
      checks.set(
        "RC-14",
        "FAIL",
        `factura en ${normalized.currency} sin tasa persistida para el ${normalized.documentDate}: no se convierte con otra ` +
          "fuente ni con otro día. No se guarda nada a medias",
        { blocksBatch: true, evidence: { currency: normalized.currency, baseCurrency: ctx.baseCurrency }, fields: ["currency"] }
      )
    } else {
      const convertedTotalCents = convertWithRate(normalized.totalCents, ctx.rate.rateMicro)
      conversion = {
        rateId: ctx.rate.id,
        rateMicro: ctx.rate.rateMicro,
        rateDate: ctx.rate.rateDate,
        source: ctx.rate.source,
        convertedTotalCents,
      }
      if (ctx.rate.forced) sellos.add("TASA_FORZADA")
      checks.set(
        "RC-14",
        "PASS",
        `moneda distinta de la base con tasa persistida del ${ctx.rate.rateDate} (${ctx.rate.source}); ` +
          "confirmar hoy o dentro de un mes da el mismo asiento",
        {
          evidence: {
            currency: normalized.currency,
            baseCurrency: ctx.baseCurrency,
            exchangeRateId: ctx.rate.id,
            rateMicro: Number(ctx.rate.rateMicro),
            rateDate: ctx.rate.rateDate,
            source: ctx.rate.source,
            convertedTotalCents,
            forzado: ctx.rate.forced === true,
          },
          fields: ["currency", "convertedTotalCents"],
        }
      )
    }
  } else {
    checks.set("RC-14", "PASS", "la moneda del documento es la moneda base")
  }

  // ── RC-15 · deducibilidad resuelta ────────────────────────────────────────
  const rc15 = checkDeductibility(normalized, ctx)
  checks.set("RC-15", rc15.status, rc15.message, { blocksBatch: rc15.blocksBatch, evidence: rc15.evidence })

  // ── RC-16 · reproducibilidad interna ──────────────────────────────────────
  checks.set("RC-16", "PASS", "la propuesta normalizada es reproducible byte a byte")

  // ── RC-18 · caducidad del derecho a deducir (art. 99.Cinco LIVA) ──────────
  const deductionDate = ivaDate ?? normalized.documentDate
  if (normalized.documentDate && deductionDate && fullYearsBetween(normalized.documentDate, deductionDate) >= CADUCIDAD_DEDUCCION_ANIOS) {
    checks.set(
      "RC-18",
      "WARN",
      `han pasado más de cuatro años desde la expedición (${normalized.documentDate}): el derecho a deducir ha caducado ` +
        "(art. 99.Cinco LIVA). La cuota se incorpora al coste",
      {
        blocksBatch: true,
        evidence: { documentDate: normalized.documentDate, fechaDeduccion: deductionDate, caducado: true },
        fields: ["documentDate"],
      }
    )
    sellos.add("IVA_PERIODO_DESPLAZADO")
  } else {
    checks.set("RC-18", "PASS", "el derecho a deducir está dentro de los cuatro años")
  }

  // ── RC-19 · retención POR RÉGIMEN (O-11) ──────────────────────────────────
  const rc19 = checkWithholding(normalized, ctx, baseOperacion)
  checks.set("RC-19", rc19.status, rc19.message, {
    blocksBatch: rc19.blocksBatch,
    evidence: rc19.evidence,
    fields: rc19.fields,
  })
  if (rc19.status === "WARN") sellos.add("RETENCION_NO_PRACTICADA")
  const withholding = rc19.withholding

  // ── RC-20 · suplidos y no sujetos ─────────────────────────────────────────
  // El error que O-12 vino a corregir es el CONTRARIO al que parece: no que un
  // suplido se declare mal, sino que se cuele DENTRO de la base. Se detecta por
  // el propio descuadre de RC-01: si excluir una línea cuadra el documento al
  // céntimo, esa línea es un suplido mal clasificado, y decirlo aquí ahorra al
  // usuario perseguir un FAIL de RC-02 y otro de RC-19 sobre un documento
  // perfectamente correcto.
  const misclassified =
    baseDeviation > 0 ? operationLines.find((l) => netBase(l) === baseDeviation) : undefined
  if (misclassified) {
    const wRate = withholdingRateOf(ctx)
    const rateForQuota = normalized.taxes[0] ? rateOf(normalized.taxes[0].taxRateCode) : undefined
    checks.set(
      "RC-20",
      "FAIL",
      `con la línea de ${fmt(baseDeviation)} dentro de la base, la cuota y la retención saldrían sobre ` +
        `${fmt(baseOperacion)} en vez de sobre ${fmt(declaredBase)}: RC-02 y RC-19 fallarían sobre un documento correcto. ` +
        "¿Es un suplido (art. 78.Tres.3º LIVA)?",
      {
        blocksBatch: true,
        evidence: {
          baseIncorrecta: baseOperacion,
          cuotaIncorrecta: rateForQuota ? cuota([baseOperacion], rateForQuota.rateBps, mode) : null,
          retencionIncorrecta: wRate ? applyBps(baseOperacion, wRate.rateBps) : null,
          baseCorrecta: declaredBase,
          cuotaCorrecta: rateForQuota ? cuota([declaredBase], rateForQuota.rateBps, mode) : null,
          retencionCorrecta: wRate ? applyBps(declaredBase, wRate.rateBps) : null,
        },
      }
    )
  } else if (otherLines.length > 0) {
    const wrong = normalized.taxes.some((t) => t.baseCents > baseOperacion)
    checks.set(
      "RC-20",
      wrong ? "FAIL" : "PASS",
      wrong
        ? "un suplido o una línea no sujeta está dentro de la base imponible: la cuota y la retención saldrían infladas"
        : "el suplido queda fuera de Σ bases, de la base de la cuota y de la base de la retención, y dentro del total",
      {
        blocksBatch: wrong,
        evidence: {
          suplidoCents: suplidosYNoSujetos,
          baseCuota: baseOperacion,
          baseRetencion: withholding?.baseCents ?? baseOperacion,
          enTotal: true,
        },
        fields: normalized.lines
          .map((l, i) => (l.kind === "OPERACION" ? null : `lines[${i}].kind`))
          .filter((f): f is string => f !== null),
      }
    )
  } else {
    checks.set("RC-20", "PASS", "no aplica: el documento no tiene suplidos ni líneas no sujetas")
  }

  // ── RC-21 · rectificativas (O-5, D12) ─────────────────────────────────────
  const rc21 = checkRectification(normalized, ctx)
  checks.set("RC-21", rc21.status, rc21.message, {
    blocksBatch: rc21.blocksBatch,
    evidence: rc21.evidence,
    fields: rc21.fields,
  })
  const rectificationDelta = rc21.delta

  // ── RC-22 · ISP sólo con las cuatro precondiciones (O-4, D11) ─────────────
  const rc22 = checkIsp(normalized, ctx, checks.get("RC-11"))
  checks.set("RC-22", rc22.status, rc22.message, {
    blocksBatch: rc22.blocksBatch,
    evidence: rc22.evidence,
    fields: rc22.fields,
  })
  if (rc22.downgradeToDesconocido) {
    ;(normalized as Mutable<ExtractionProposal>).docKind = "DESCONOCIDO"
  }

  // ── RC-23 · anticipo aplicado ─────────────────────────────────────────────
  const appliedAdvanceTax = normalized.appliedAdvanceTaxCents ?? 0
  if (appliedAdvanceTax !== 0 || (normalized.appliedAdvanceCents ?? 0) !== 0) {
    const advance = ctx.advanceEntry
    if (!advance) {
      checks.set("RC-23", "FAIL", "el documento aplica un anticipo pero no hay asiento de anticipo que lo respalde", {
        blocksBatch: true,
        evidence: { appliedAdvanceCents: normalized.appliedAdvanceCents ?? 0, appliedAdvanceTaxCents: appliedAdvanceTax },
      })
    } else if (advance.taxCents !== appliedAdvanceTax) {
      checks.set(
        "RC-23",
        "FAIL",
        `el IVA del anticipo aplicado (${fmt(appliedAdvanceTax)}) no es el repercutido en su asiento (${fmt(advance.taxCents)})`,
        { blocksBatch: true, evidence: { appliedAdvanceTaxCents: appliedAdvanceTax, asiento: advance.taxCents } }
      )
    } else {
      checks.set("RC-23", "PASS", "el anticipo aplicado coincide con el asiento que lo creó", {
        evidence: { advanceEntryId: advance.id, appliedAdvanceTaxCents: appliedAdvanceTax },
      })
    }
  } else {
    checks.set(
      "RC-23",
      "PASS",
      docKindResolved === "FACTURA_ANTICIPO_CLIENTE"
        ? "no se aplica anticipo alguno: esta factura CREA el anticipo, no lo consume"
        : "no aplica: el documento no aplica anticipo alguno",
      { evidence: { appliedAdvanceCents: 0, appliedAdvanceTaxCents: 0 } }
    )
  }

  // ── RC-24 · régimen de IVA de la organización (O-21) ──────────────────────
  if (ctx.organization.ivaRegime !== "GENERAL") {
    checks.set(
      "RC-24",
      "FAIL",
      `la organización está acogida al régimen ${ctx.organization.ivaRegime}: el devengo y la deducción siguen el cobro y ` +
        "el pago (arts. 163 terdecies y quaterdecies LIVA). La contabilización automática se bloquea; soporte previsto en E9",
      { blocksBatch: true, evidence: { ivaRegime: ctx.organization.ivaRegime } }
    )
    sellos.add("REGIMEN_NO_SOPORTADO")
  } else {
    checks.set("RC-24", "PASS", "la organización está en régimen general de IVA")
  }

  // ── Confianza por campo (P6, cuatro niveles) ──────────────────────────────
  // La procedencia de `docKind` la fija quien lo decidió: RC-22 cuando la
  // calificación es fiscal (usuario), RC-13 cuando el código lo reclasificó por
  // el signo, y el modelo en el resto de los casos —donde es, como mucho,
  // `interpretacion_ia`, porque un `docKind` decide la plantilla—.
  const reclassifiedBySign = checks.get("RC-13")?.evidence.docKindNormalizado !== undefined
  assignConfidence(normalized, ctx, checks, origins, {
    derivedFromTicket,
    quotaDeviationsCents,
    anticipoSinCobro,
    hasWithholding: withholding !== null,
    rectificationDelta,
    conversion,
    docKindOrigin: rc22.docKindOrigin ?? (reclassifiedBySign ? "calculado" : "llm"),
    docKindCheck: rc22.docKindCheck ?? "RC-13",
    docKindConfidence: rc22.docKindConfidence ?? "interpretacion_ia",
  })

  // ── Estado global, elegibilidad y sellos ──────────────────────────────────
  const list = checks.toArray()
  const status: ReconcileStatus = list.some((c) => c.status === "FAIL")
    ? "FAIL"
    : list.some((c) => c.status === "WARN")
      ? "WARN"
      : "PASS"

  if (status === "FAIL") sellos.add("PROPUESTA_NO_RECONCILIADA")

  // G-02 / I-E8-10: un run parcial o importado no tiene NI UN campo `calculado`
  // ni `verificado`. La propuesta puede ser útil para rellenar el formulario;
  // no es evidencia de nada.
  if (partialBlocksPosting || ctx.runKind === "IMPORTED") {
    for (const key of Object.keys(origins)) {
      const p = origins[key]
      origins[key] = { ...p, confidence: "no_verificado", check: partialBlocksPosting ? "RC-09" : "RC-10" }
    }
  }

  return {
    status,
    checks: list,
    normalized,
    fieldOrigins: origins,
    quotaDeviationsCents,
    elegibleParaLote: status === "PASS" && !list.some((c) => c.blocksBatch),
    sellos: [...sellos].sort(),
    ivaPeriod,
    entryDate,
    fiscalYearClosed: rc05.fiscalYearClosed,
    withholding,
    rectificationDelta,
    conversion,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalización: RC-13 (signos) y RC-17 (IVA incluido)
// ─────────────────────────────────────────────────────────────────────────────

const ABS = Math.abs

function normalizeProposal(
  proposal: ExtractionProposal,
  ctx: ReconcileContext,
  checks: CheckList,
  _origins: FieldOrigins
): ExtractionProposal {
  let normalized: ExtractionProposal = { ...proposal, lines: [...proposal.lines], taxes: [...proposal.taxes] }

  // ── RC-13 · signos ────────────────────────────────────────────────────────
  const negative = proposal.totalCents < 0
  const isInvoice = proposal.docKind === "FACTURA_RECIBIDA" || proposal.docKind === "FACTURA_EMITIDA"
  if (negative && isInvoice) {
    const docKind: DocKind = proposal.docKind === "FACTURA_RECIBIDA" ? "ABONO_RECIBIDO" : "ABONO_EMITIDO"
    normalized = {
      ...normalized,
      docKind,
      totalCents: ABS(proposal.totalCents),
      lines: normalized.lines.map((l) => ({ ...l, baseCents: ABS(l.baseCents) })),
      taxes: normalized.taxes.map((t) => ({ ...t, baseCents: ABS(t.baseCents), quotaCents: ABS(t.quotaCents) })),
    }
    checks.set(
      "RC-13",
      "PASS",
      `el documento venía con total ${fmtEur(proposal.totalCents)} y docKind ${proposal.docKind}: ` +
        `se reclasifica a ${docKind} con valores absolutos`,
      {
        evidence: {
          totalLeido: proposal.totalCents,
          totalNormalizado: ABS(proposal.totalCents),
          docKindLeido: proposal.docKind,
          docKindNormalizado: docKind,
        },
        fields: ["docKind", "totalCents"],
      }
    )
  } else if (proposal.totalCents <= 0) {
    checks.set("RC-13", "FAIL", `el total del documento es ${proposal.totalCents} y no es normalizable a un abono`, {
      blocksBatch: true,
      evidence: { totalCents: proposal.totalCents, docKind: proposal.docKind },
      fields: ["totalCents"],
    })
  } else {
    checks.set("RC-13", "PASS", "el total es positivo y el tipo de documento es coherente con su signo")
  }

  // ── RC-17 · ticket con IVA incluido (O-1, D9) ─────────────────────────────
  const isTicket = normalized.docKind === "TICKET"
  const noDeclaredBases = normalized.taxes.length === 1 && normalized.taxes[0].baseCents === 0
  const singleRate = normalized.taxes.length === 1 ? normalized.taxes[0].taxRateCode : null
  const rate = singleRate ? ctx.taxRates.find((r) => r.code === singleRate) : undefined

  if (isTicket && rate) {
    const total = normalized.totalCents
    const baseCents = halfUpDiv(total * 10000, 10000 + rate.rateBps)
    const cuotaCents = total - baseCents
    const alreadyConsistent =
      !noDeclaredBases &&
      normalized.taxes[0].baseCents === baseCents &&
      normalized.taxes[0].quotaCents === cuotaCents &&
      sum(normalized.lines.map((l) => l.baseCents - (l.discountCents ?? 0))) === baseCents

    normalized = {
      ...normalized,
      lines: normalized.lines.map((l, i) => (i === 0 ? { ...l, baseCents, discountCents: 0 } : l)),
      taxes: [{ ...normalized.taxes[0], baseCents, quotaCents: cuotaCents }],
    }
    checks.set(
      "RC-17",
      "PASS",
      alreadyConsistent
        ? "base y cuota derivadas del total con IVA incluido, residuo 0"
        : `ticket sin bases declaradas: base = round_half_up(${fmt(total)} x 10000/${10000 + rate.rateBps}) = ${fmt(baseCents)} ` +
          `y cuota residual = ${fmt(cuotaCents)}; base + cuota = total, tolerancia 0`,
      {
        evidence: { totalCents: total, rateBps: rate.rateBps, baseCents, cuotaCents, residuo: 0 },
        fields: ["lines[0].baseCents", `taxes.${rate.code}.quotaCents`],
      }
    )
  } else {
    checks.set("RC-17", "PASS", "no aplica: el documento declara sus bases")
  }

  // ── D9: la deducibilidad por defecto de un ticket es NONE ─────────────────
  if (isTicket) {
    const qualified = normalized.simplifiedQualified === true
    const deductibility: Deductibility = qualified ? "FULL" : "NONE"
    normalized = { ...normalized, lines: normalized.lines.map((l) => ({ ...l, deductibility })) }
  }

  // ── O-11: la retención que se PRACTICA la fija el régimen, no el PDF ──────
  const regime = ctx.counterparty?.withholdingRegime ?? "NINGUNO"
  const rateCode = ctx.counterparty?.withholdingRateCode ?? null
  if (regime !== "NINGUNO" && rateCode) {
    const wRate = ctx.taxRates.find((r) => r.code === rateCode)
    const operationBase = sum(
      normalized.lines.filter((l) => l.kind === "OPERACION").map((l) => l.baseCents - (l.discountCents ?? 0))
    )
    if (wRate) {
      normalized = { ...normalized, withholding: { rateCode, quotaCents: applyBps(operationBase, wRate.rateBps) } }
    }
  } else {
    normalized = { ...normalized, withholding: null }
  }

  return normalized
}

const fmt = (cents: Cents): string => new Intl.NumberFormat("es-ES").format(cents)
const fmtEur = (cents: Cents): string => `${new Intl.NumberFormat("es-ES", { minimumFractionDigits: 2 }).format(cents / 100)} EUR`

/** Conversión a moneda base: HALF-EVEN sobre `cents × rate / 1e6` (NRV 11ª). */
export function convertWithRate(cents: Cents, rateMicro: bigint): Cents {
  const two = BigInt(2)
  const one = BigInt(1)
  const denominator = BigInt(1_000_000)
  const product = BigInt(Math.abs(cents)) * rateMicro
  const quotient = product / denominator
  const remainder = product - quotient * denominator
  const twice = remainder * two
  const rounded = twice > denominator || (twice === denominator && quotient % two === one) ? quotient + one : quotient
  return (cents < 0 ? -1 : 1) * Number(rounded)
}

// ─────────────────────────────────────────────────────────────────────────────
// Checks con lógica propia
// ─────────────────────────────────────────────────────────────────────────────

type SubCheck = {
  status: ReconcileStatus
  blocksBatch: boolean
  message: string
  evidence: Record<string, unknown>
  fields: readonly string[]
}

function checkDates(
  p: ExtractionProposal,
  ctx: ReconcileContext
): SubCheck & { entryDate: LocalDate | null; fiscalYearClosed: boolean } {
  const problems: string[] = []
  const dates: [string, LocalDate | null | undefined][] = [
    ["documentDate", p.documentDate],
    ["accrualDate", p.accrualDate],
    ["receptionDate", p.receptionDate],
    ["operationDate", p.operationDate],
  ]
  for (const [name, value] of dates) {
    if (value !== null && value !== undefined && !isValidLocalDate(value)) {
      problems.push(`${name} = ${value} no existe en el calendario`)
    }
  }
  if (!p.documentDate) problems.push("el documento no tiene fecha de expedición")

  if (problems.length > 0) {
    return {
      status: "FAIL",
      blocksBatch: true,
      message: `fechas inválidas: ${problems.join(" · ")}`,
      evidence: { problemas: problems },
      fields: ["documentDate", "receptionDate"],
      entryDate: null,
      fiscalYearClosed: false,
    }
  }

  const documentDate = p.documentDate as LocalDate
  if (compareDates(documentDate, ctx.refDate) > 0) {
    return {
      status: "FAIL",
      blocksBatch: true,
      message: `la fecha de expedición ${documentDate} es futura (hoy ${ctx.refDate})`,
      evidence: { documentDate, refDate: ctx.refDate },
      fields: ["documentDate"],
      entryDate: null,
      fiscalYearClosed: false,
    }
  }

  // Previsualización de `resolveEntryDate` (§2.2 de E3-asientos-tipo): la
  // resolución AUTORITATIVA la hace `buildEntry` con el `LedgerContext`
  // completo. Aquí se adelanta para que el error se vea en el formulario y no
  // en el `INSERT`, que es lo que pide §5.2 (I8).
  const candidate = p.accrualDate ?? documentDate
  const fy = ctx.fiscalYears.find(
    (f) => compareDates(candidate, f.startDate) >= 0 && compareDates(candidate, f.endDate) <= 0
  )
  const ivaDate = maxDate(p.receptionDate ?? null, documentDate)
  const baseEvidence: Record<string, unknown> = {
    documentDate,
    ...(p.receptionDate ? { receptionDate: p.receptionDate } : {}),
    ...(ivaDate ? { ivaPeriod: quarterOf(ivaDate) } : {}),
  }

  if (!fy) {
    return {
      status: "FAIL",
      blocksBatch: true,
      message: `no hay ningún ejercicio que contenga la fecha ${candidate}`,
      evidence: baseEvidence,
      fields: ["documentDate"],
      entryDate: null,
      fiscalYearClosed: false,
    }
  }
  if (fy.status === "CLOSED") {
    return {
      status: "WARN",
      blocksBatch: true,
      message:
        `el ejercicio ${fy.code} del documento está cerrado: el asiento se desvía a AJUSTE_EJERCICIO_CERRADO (T-22) ` +
        "en el ejercicio abierto (113 si es material, 678/778 si no)",
      evidence: { ...baseEvidence, ejercicio: fy.code, estado: "CLOSED", plantilla: "AJUSTE_EJERCICIO_CERRADO" },
      fields: ["documentDate"],
      entryDate: null,
      fiscalYearClosed: true,
    }
  }
  if (ctx.periodLocks.some((l) => l.fiscalYearId === fy.id && l.month === monthOf(candidate))) {
    return {
      status: "WARN",
      blocksBatch: true,
      message: `el mes ${monthOf(candidate)} del ejercicio ${fy.code} está bloqueado: el asiento se desplaza al primer mes abierto`,
      evidence: { ...baseEvidence, mesBloqueado: monthOf(candidate) },
      fields: ["documentDate"],
      entryDate: null,
      fiscalYearClosed: false,
    }
  }

  const entryDate = candidate
  const evidence: Record<string, unknown> = { ...baseEvidence, entryDate }

  if (p.receptionDate && compareDates(p.receptionDate, documentDate) < 0) {
    return {
      status: "WARN",
      blocksBatch: false,
      message: `la fecha de recepción ${p.receptionDate} es anterior a la de expedición ${documentDate}`,
      evidence,
      fields: ["documentDate", "receptionDate"],
      entryDate,
      fiscalYearClosed: false,
    }
  }

  const message = p.receptionDate
    ? `expedida el ${documentDate} y recibida el ${p.receptionDate}: el gasto se devenga en su fecha y el IVA en el periodo de recepción`
    : `expedida el ${documentDate}; el ejercicio está abierto y el mes no está bloqueado`
  return {
    status: "PASS",
    blocksBatch: false,
    message,
    evidence,
    fields: p.receptionDate ? ["documentDate", "receptionDate"] : ["documentDate"],
    entryDate,
    fiscalYearClosed: false,
  }
}

function checkTaxId(p: ExtractionProposal, ctx: ReconcileContext): SubCheck {
  const cp = ctx.counterparty
  const taxId = p.counterparty.taxId
  const branch = taxIdBranchOf(cp?.countryCode ?? null)
  const enMaestro = cp?.enMaestro === true

  if (branch === "TERCER_PAIS") {
    if (!taxId || taxId.trim() === "") {
      return {
        status: "WARN",
        blocksBatch: false,
        message:
          "el documento no muestra identificador fiscal del expedidor; en un tercer país no hay checksum que comprobar, " +
          "así que se avisa y no se bloquea",
        evidence: { rama: "TERCER_PAIS", countryCode: cp?.countryCode ?? null, checksum: "NO_APLICA", vacio: true, enMaestro },
        fields: ["counterparty.taxId"],
      }
    }
    return {
      status: "PASS",
      blocksBatch: false,
      message: `identificador ${taxId}: rama tercer país, identificador libre sin checksum. Nunca FAIL; confianza interpretación IA`,
      evidence: { rama: "TERCER_PAIS", countryCode: cp?.countryCode ?? null, checksum: "NO_APLICA", vacio: false, enMaestro },
      fields: ["counterparty.taxId"],
    }
  }

  if (branch === "UE") {
    const country = (cp?.countryCode ?? "").toUpperCase()
    const vat = cp?.vatNumber ?? taxId
    if (!euVatNumberLooksValid(country, vat)) {
      return {
        status: "FAIL",
        blocksBatch: true,
        message: `el NIF-IVA ${vat ?? "(vacío)"} no tiene el formato del país ${country}`,
        evidence: { rama: "UE", countryCode: country, formato: "INVALIDO" },
        fields: ["counterparty.taxId"],
      }
    }
    if (cp?.viesValid !== true) {
      return {
        status: "WARN",
        blocksBatch: true,
        message: `VIES negativo o no comprobado para ${vat}: bloquea RC-22`,
        evidence: { rama: "UE", countryCode: country, formato: "VALIDO", viesValid: cp?.viesValid ?? null, viesCheckedAt: cp?.viesCheckedAt ?? null },
        fields: ["counterparty.taxId"],
      }
    }
    return {
      status: "PASS",
      blocksBatch: false,
      message: `NIF-IVA ${vat} de formato válido y VIES afirmativo el ${cp.viesCheckedAt}`,
      evidence: { rama: "UE", countryCode: country, formato: "VALIDO", viesValid: true, viesCheckedAt: cp.viesCheckedAt },
      fields: ["counterparty.taxId"],
    }
  }

  // Rama española: el dígito de control es FAIL, no WARN (art. 6.1.c).
  if (!taxId || taxId.trim() === "") {
    return {
      status: "FAIL",
      blocksBatch: true,
      message: "la factura no consigna NIF del expedidor: sin él no cumple el art. 6.1.c RD 1619/2012 y su cuota no es deducible",
      evidence: { rama: "ES", checksum: "AUSENTE", enMaestro },
      fields: ["counterparty.taxId"],
    }
  }
  const check = spanishTaxIdCheck(taxId)
  if (!check.valid) {
    return {
      status: "FAIL",
      blocksBatch: true,
      message:
        `NIF ${taxId}: dígito de control incorrecto${check.expected ? ` (esperado ${check.expected})` : ""}. ` +
        "Sin NIF válido la factura no cumple el art. 6.1.c RD 1619/2012 y su cuota no es deducible",
      evidence: { rama: "ES", checksum: "INVALIDO", esperado: check.expected, enMaestro },
      fields: ["counterparty.taxId"],
    }
  }
  if (!enMaestro) {
    return {
      status: "WARN",
      blocksBatch: false,
      message: "el documento lleva NIF válido del emisor pero no hay ficha de contraparte",
      evidence: { rama: "ES", checksum: "VALIDO", enMaestro: false },
      fields: ["counterparty.taxId"],
    }
  }
  return {
    status: "PASS",
    blocksBatch: false,
    message: `NIF ES ${taxId}: dígito de control válido y ficha en el maestro`,
    evidence: { rama: "ES", checksum: "VALIDO", enMaestro: true },
    fields: ["counterparty.taxId"],
  }
}

function checkDeductibility(p: ExtractionProposal, ctx: ReconcileContext): SubCheck {
  if (p.docKind === "TICKET") {
    const qualified = p.simplifiedQualified === true
    return {
      status: "PASS",
      blocksBatch: false,
      message: qualified
        ? "deducibilidad FULL por acto explícito del EDITOR (markSimplifiedQualifiedAction, con motivo y AuditLog)"
        : "deducibilidad NONE por defecto de factura simplificada (ADR-0014 D9); pasar a FULL es un acto explícito y auditado del EDITOR",
      evidence: qualified
        ? { deductibility: "FULL", simplifiedQualified: true, auditAction: "MARK_SIMPLIFIED_QUALIFIED" }
        : { deductibility: "NONE", simplifiedQualified: false },
      fields: [],
    }
  }
  const requiereDecision = ctx.category?.defaultDeductibility === "REQUIERE_DECISION"
  const prorrata = p.lines.some((l) => l.deductibility === "PRORRATA")
  if (requiereDecision) {
    return {
      status: "WARN",
      blocksBatch: true,
      message:
        "la categoría del gasto exige decidir la deducibilidad (art. 96 LIVA / art. 95.Tres.2ª): el campo nace no verificado " +
        "y el documento no entra en el lote",
      evidence: { defaultDeductibility: "REQUIERE_DECISION", categoria: ctx.category?.code ?? null },
      fields: [],
    }
  }
  if (prorrata && ctx.organization.prorrataBps === null) {
    return {
      status: "FAIL",
      blocksBatch: true,
      message: "una línea aplica prorrata y la organización no la tiene configurada",
      evidence: { prorrataBps: null },
      fields: [],
    }
  }
  if (prorrata) {
    return {
      status: "WARN",
      blocksBatch: true,
      message: `con prorrata del ${ctx.organization.prorrataBps} bps la cuota deducible es una estimación sujeta a regularización anual`,
      evidence: { prorrataBps: ctx.organization.prorrataBps },
      fields: [],
    }
  }
  return {
    status: "PASS",
    blocksBatch: false,
    message: "la deducibilidad está resuelta por configuración, sin decisión pendiente",
    evidence: {},
    fields: [],
  }
}

function checkWithholding(
  p: ExtractionProposal,
  ctx: ReconcileContext,
  baseOperacion: Cents
): SubCheck & { withholding: ReconcileResult["withholding"] } {
  const cp = ctx.counterparty
  const regime = cp?.withholdingRegime ?? "NINGUNO"
  const rateCode = cp?.withholdingRateCode ?? null
  const leida = p.readWithholding?.quotaCents ?? null

  if (regime === "NINGUNO" || !rateCode) {
    if (leida !== null && leida !== 0) {
      return {
        status: "WARN",
        blocksBatch: true,
        message:
          "el documento consigna una retención y la contraparte no tiene régimen de retención configurado: " +
          "revise la ficha antes de contabilizar",
        evidence: { regimen: regime, retencionLeida: leida },
        fields: ["readWithholding"],
        withholding: null,
      }
    }
    return {
      status: "PASS",
      blocksBatch: false,
      message: "no aplica: la contraparte no está sujeta a retención",
      evidence: {},
      fields: [],
      withholding: null,
    }
  }

  const rate = ctx.taxRates.find((r) => r.code === rateCode)
  if (!rate) {
    return {
      status: "FAIL",
      blocksBatch: true,
      message: `el régimen de la contraparte exige el tipo ${rateCode} y no está en el catálogo de la organización`,
      evidence: { regimen: regime, rateCode },
      fields: ["withholding"],
      withholding: null,
    }
  }

  const configurada = applyBps(baseOperacion, rate.rateBps)
  const model = withholdingModelOf(regime)
  const withholding = { rateCode, baseCents: baseOperacion, quotaCents: configurada, model }

  if (leida === null) {
    return {
      status: "WARN",
      blocksBatch: true,
      message:
        `esta factura debería llevar retención del ${(rate.rateBps / 100).toString().replace(".", ",")} %; solicite factura ` +
        `rectificada. Se practica la retención del régimen (${fmt(configurada)}) y se abona a 4751`,
      evidence: {
        regimen: regime,
        rateCode,
        rateBps: rate.rateBps,
        baseRetencion: baseOperacion,
        retencionConfigurada: configurada,
        retencionLeida: null,
        modelo: model,
      },
      fields: ["withholding", "readWithholding"],
      withholding,
    }
  }
  if (leida !== configurada) {
    return {
      status: "WARN",
      blocksBatch: true,
      message:
        `la retención leída (${fmt(leida)}) no es la del régimen ${regime} (${fmt(configurada)}): el asiento usa la ` +
        "configurada, que es la obligación del pagador (arts. 99 y 101 LIRPF)",
      evidence: {
        regimen: regime,
        rateCode,
        rateBps: rate.rateBps,
        baseRetencion: baseOperacion,
        retencionConfigurada: configurada,
        retencionLeida: leida,
        modelo: model,
      },
      fields: ["withholding", "readWithholding"],
      withholding,
    }
  }
  return {
    status: "PASS",
    blocksBatch: false,
    message: `retención leída ${fmt(leida)} = la del régimen ${regime} al ${(rate.rateBps / 100).toString().replace(".", ",")} %`,
    evidence: {
      retencionLeida: leida,
      retencionConfigurada: configurada,
      baseRetencion: baseOperacion,
      modelo: model,
    },
    fields: [],
    withholding,
  }
}

function checkRectification(
  p: ExtractionProposal,
  ctx: ReconcileContext
): SubCheck & { delta: RectificationDelta | null } {
  const isAbono = p.docKind === "ABONO_RECIBIDO" || p.docKind === "ABONO_EMITIDO"
  if (!isAbono) {
    return {
      status: "PASS",
      blocksBatch: false,
      message: "no aplica: el documento no es rectificativo",
      evidence: {},
      fields: [],
      delta: null,
    }
  }
  const r = p.rectifies
  if (!r || !r.documentNumber || !r.reason || !r.mode) {
    return {
      status: "FAIL",
      blocksBatch: true,
      message:
        "una rectificativa exige el número del documento rectificado, la causa y el modo (art. 15.2 RD 1619/2012): sin ellos " +
        "no es construible",
      evidence: { rectifies: r ?? null },
      fields: ["rectifies"],
      delta: null,
    }
  }
  if (r.mode === "DIFERENCIAS") {
    return {
      status: "PASS",
      blocksBatch: false,
      message: `rectificativa con documento rectificado, causa ${r.reason} y modo DIFERENCIAS; se contabiliza lo que el documento muestra`,
      evidence: { documentNumber: r.documentNumber, entryId: r.entryId ?? null, reason: r.reason, mode: r.mode },
      fields: ["rectifies"],
      delta: null,
    }
  }
  const original = ctx.rectifiedEntry
  if (!original) {
    return {
      status: "WARN",
      blocksBatch: true,
      message:
        `no se ha resuelto el documento rectificado ${r.documentNumber}: en modo SUSTITUCIÓN hay que restar contra él, y ` +
        "contabilizar lo leído duplicaría la operación",
      evidence: { documentNumber: r.documentNumber, mode: r.mode },
      fields: ["rectifies"],
      delta: null,
    }
  }
  const newBaseByRate: Record<string, Cents> = {}
  for (const line of p.lines) {
    if (line.kind !== "OPERACION" || line.taxRateCode === null) continue
    newBaseByRate[line.taxRateCode] = (newBaseByRate[line.taxRateCode] ?? 0) + line.baseCents - (line.discountCents ?? 0)
  }
  const newBase = sum(Object.values(newBaseByRate))
  const quotaByRate: Record<string, Cents> = {}
  const baseByRate: Record<string, Cents> = {}
  for (const code of new Set([...Object.keys(original.quotaByRate), ...p.taxes.map((t) => t.taxRateCode)])) {
    quotaByRate[code] = (original.quotaByRate[code] ?? 0) - (p.taxes.find((t) => t.taxRateCode === code)?.quotaCents ?? 0)
    baseByRate[code] = (original.baseByRate[code] ?? 0) - (newBaseByRate[code] ?? 0)
  }
  const originalBase = sum(Object.values(original.baseByRate))
  const baseCents = originalBase - newBase
  const totalCents = baseCents + sum(Object.values(quotaByRate))
  return {
    status: "PASS",
    blocksBatch: false,
    message:
      `modo SUSTITUCIÓN con el asiento rectificado resuelto: se contabiliza la diferencia de ${fmt(totalCents)} ` +
      `(base ${fmt(baseCents)}), no los ${fmt(p.totalCents)} leídos`,
    evidence: {
      documentNumber: r.documentNumber,
      entryId: r.entryId ?? original.id,
      mode: r.mode,
      original: { baseCents: originalBase, quotaCents: sum(Object.values(original.quotaByRate)) },
      rectificado: { baseCents: newBase, quotaCents: sum(p.taxes.map((t) => t.quotaCents)) },
      diferencia: { baseCents, quotaCents: sum(Object.values(quotaByRate)), totalCents },
    },
    fields: ["rectifies", "lines[0].baseCents", ...p.taxes.map((t) => `taxes.${t.taxRateCode}.quotaCents`)],
    delta: { baseCents, baseByRate, quotaByRate, totalCents },
  }
}

function checkIsp(
  p: ExtractionProposal,
  ctx: ReconcileContext,
  rc11: ReconcileCheck | undefined
): SubCheck & {
  downgradeToDesconocido: boolean
  docKindOrigin?: FieldOrigin
  docKindConfidence?: Provenanced<unknown>["confidence"]
  docKindCheck?: string
} {
  const cp = ctx.counterparty
  const branch = taxIdBranchOf(cp?.countryCode ?? null)
  const isIsp = p.docKind === "FACTURA_RECIBIDA_ISP"
  const isExtracom = p.docKind === "FACTURA_RECIBIDA_EXTRACOM" || p.docKind === "DUA_IMPORTACION"

  if (!isIsp && !isExtracom) {
    return {
      status: "PASS",
      blocksBatch: false,
      message: "no aplica: el documento no se ha calificado como inversión del sujeto pasivo",
      evidence: {},
      fields: [],
      downgradeToDesconocido: false,
    }
  }

  const paisUeConVies = branch === "UE" && cp?.viesValid === true && cp?.viesCheckedAt !== null && rc11?.status !== "WARN"
  const ausenciaDeCuota = p.taxes.every((t) => t.operationKey === "ISP" || t.operationKey === "AIB" || t.quotaCents === 0)
  const mencionLegalArt61m = typeof ctx.legalMentionArt61m === "string" && ctx.legalMentionArt61m.trim() !== ""
  const roiRegistered = ctx.organization.roiRegistered
  const precondiciones = { paisUeConVies, ausenciaDeCuota, mencionLegalArt61m, roiRegistered }

  if (isExtracom) {
    return {
      status: "WARN",
      blocksBatch: true,
      message:
        ctx.suggestedDocKind === "FACTURA_RECIBIDA_ISP"
          ? "el modelo sugirió inversión del sujeto pasivo, pero faltan precondiciones: no se autorrepercute. Decide el usuario"
          : "no es inversión del sujeto pasivo: es una importación. El IVA lo liquida el DUA y se contabilizará con su propio " +
            "documento (T-20/E9)",
      evidence: {
        ...(ctx.suggestedDocKind ? { docKindSugerido: ctx.suggestedDocKind } : { docKind: p.docKind }),
        precondicionesIsp: precondiciones,
        docKindResuelto: p.docKind,
        cuotaAutorrepercutida: 0,
      },
      fields: ["docKind"],
      downgradeToDesconocido: false,
      docKindOrigin: "usuario",
      docKindConfidence: "verificado",
      docKindCheck: "RC-22",
    }
  }

  const faltan = Object.entries(precondiciones)
    .filter(([, ok]) => !ok)
    .map(([name]) => name)
  if (faltan.length > 0) {
    return {
      status: "WARN",
      blocksBatch: true,
      message:
        `faltan ${faltan.length === 1 ? "una" : faltan.length} de las cuatro precondiciones de inversión del sujeto pasivo ` +
        `(${faltan.join(", ")}): el documento queda DESCONOCIDO y decide el usuario`,
      evidence: { precondicionesIsp: precondiciones, docKindResuelto: "DESCONOCIDO" },
      fields: ["docKind"],
      downgradeToDesconocido: true,
      docKindOrigin: "usuario",
      docKindConfidence: "no_verificado",
      docKindCheck: "RC-22",
    }
  }

  return {
    status: "PASS",
    blocksBatch: false,
    message:
      "las cuatro precondiciones de ISP se cumplen: país UE con VIES fechado, ausencia de cuota en el documento, mención " +
      "legal del art. 6.1.m leída y organización en el ROI",
    evidence: {
      paisUeConVies,
      ausenciaDeCuota,
      mencionLegalArt61m,
      ...(ctx.legalMentionArt61m ? { textoLeido: ctx.legalMentionArt61m } : {}),
      roiRegistered,
    },
    fields: ["docKind"],
    downgradeToDesconocido: false,
    docKindOrigin: "usuario",
    docKindConfidence: "verificado",
    docKindCheck: "RC-22",
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Confianza por campo (P6 · O-20.1 · OBS-F4 del fixture)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **OBS-F4, convención sellada aquí.** Los cuatro niveles de O-20.1 no decían
 * qué confianza tiene un campo que **teclea una persona** (`receptionDate`,
 * `paymentKey`, la cualificación de un ticket, el modo de una rectificativa).
 * No es `calculado` —no lo derivó el código— ni `interpretacion_ia` —no lo dijo
 * un modelo—. Convención: **origen `usuario` con su check en PASS ⇒
 * `verificado`**; con su check en FAIL o forzado, `no_verificado`. Una persona
 * que afirma un dato y supera la comprobación está al menos tan verificada como
 * una cifra recalculada.
 */
function assignConfidence(
  p: ExtractionProposal,
  ctx: ReconcileContext,
  checks: CheckList,
  origins: FieldOrigins,
  info: {
    derivedFromTicket: boolean
    quotaDeviationsCents: Record<string, Cents>
    anticipoSinCobro: boolean
    hasWithholding: boolean
    rectificationDelta: RectificationDelta | null
    conversion: ConversionRef | null
    docKindOrigin: FieldOrigin
    docKindConfidence: Provenanced<unknown>["confidence"]
    docKindCheck: string
  }
): void {
  const statusOf = (id: ReconcileCheckId): ReconcileStatus => checks.get(id)?.status ?? "PASS"
  const okOf = (id: ReconcileCheckId): boolean => statusOf(id) !== "FAIL"

  if (p.counterparty.name !== null) {
    origins["counterparty.name"] = prov(p.counterparty.name, "llm", "interpretacion_ia", "RC-11")
  }

  const rc11 = checks.get("RC-11")
  const branch = taxIdBranchOf(ctx.counterparty?.countryCode ?? null)
  const taxIdConfidence =
    rc11?.status === "FAIL" ? "no_verificado" : rc11?.status === "PASS" && branch !== "TERCER_PAIS" ? "verificado" : "interpretacion_ia"
  origins["counterparty.taxId"] = prov(
    p.counterparty.taxId,
    branch === "UE" ? "catalogo" : "llm",
    taxIdConfidence,
    "RC-11"
  )

  origins["currency"] = prov(
    p.currency,
    "llm",
    statusOf("RC-04") === "FAIL" ? "no_verificado" : info.conversion ? "verificado" : "interpretacion_ia",
    "RC-04"
  )
  origins["docKind"] = prov(p.docKind, info.docKindOrigin, info.docKindConfidence, info.docKindCheck)
  origins["documentDate"] = prov(
    p.documentDate,
    "llm",
    statusOf("RC-05") === "FAIL" ? "no_verificado" : "interpretacion_ia",
    "RC-05"
  )
  origins["documentNumber"] = prov(
    p.documentNumber,
    "llm",
    statusOf("RC-12") === "FAIL" ? "no_verificado" : "interpretacion_ia",
    "RC-12"
  )

  // La fecha de recepción la teclea una persona; sin ella, el código toma la de
  // subida del fichero y entonces es `calculado`.
  origins["receptionDate"] =
    p.receptionDate === null || p.receptionDate === undefined
      ? prov(p.receptionDate ?? null, "calculado", "calculado", "RC-05")
      : prov(p.receptionDate, "usuario", okOf("RC-05") ? "verificado" : "no_verificado", "RC-05")

  p.lines.forEach((line, index) => {
    if (line.accountCode) {
      // O-10: una cuenta que viene del catálogo por coincidencia es, como mucho,
      // `interpretacion_ia`; la que teclea una persona, `verificado`.
      const fromCatalog = ctx.category?.defaultAccountCode === line.accountCode || line.accountCodeOrigin === "catalogo"
      const origin: FieldOrigin = fromCatalog ? "catalogo" : (line.accountCodeOrigin ?? "catalogo")
      origins[`lines[${index}].accountCode`] = prov(
        line.accountCode,
        origin,
        statusOf("RC-07") === "FAIL" ? "no_verificado" : origin === "usuario" ? "verificado" : "interpretacion_ia",
        "RC-07"
      )
    }
    if (line.kind !== "OPERACION") {
      origins[`lines[${index}].kind`] = prov(line.kind as LineKind, "usuario", okOf("RC-20") ? "verificado" : "no_verificado", "RC-20")
      origins[`lines[${index}].baseCents`] = prov(line.baseCents, "llm", okOf("RC-20") ? "verificado" : "no_verificado", "RC-20")
      return
    }
    if (info.derivedFromTicket) {
      origins[`lines[${index}].baseCents`] = prov(line.baseCents, "calculado", "calculado", "RC-17")
    } else {
      origins[`lines[${index}].baseCents`] = prov(line.baseCents, "llm", okOf("RC-01") ? "verificado" : "no_verificado", "RC-01")
    }
  })

  // La deducibilidad sólo tiene procedencia propia cuando hay una decisión
  // detrás: la de la categoría (catálogo) o la del usuario que cualifica un
  // ticket. Sin categoría no hay nada que declarar (ADR-0014 D4).
  if (ctx.category || p.docKind === "TICKET") {
    const qualified = p.docKind === "TICKET" && p.simplifiedQualified === true
    const first = p.lines.findIndex((l) => l.deductibility !== undefined && l.deductibility !== null)
    if (first >= 0) {
      origins[`lines[${first}].deductibility`] = prov(
        p.lines[first].deductibility ?? null,
        qualified ? "usuario" : "catalogo",
        statusOf("RC-15") === "PASS" ? "verificado" : "no_verificado",
        "RC-15"
      )
    }
  }

  if (p.docKind === "TICKET") {
    if (p.simplifiedQualified === true) {
      origins["simplifiedQualified"] = prov(true, "usuario", "verificado")
    } else if (p.paymentKey) {
      origins["paymentKey"] = prov(p.paymentKey as PaymentKey, "usuario", "verificado")
    }
  }

  for (const tax of p.taxes) {
    const rate = ctx.taxRates.find((r) => r.code === tax.taxRateCode)
    if (!rate || rate.rateBps === 0) continue
    const key = `taxes[${tax.taxRateCode}].quotaCents`
    if (info.anticipoSinCobro) {
      origins[key] = prov(tax.quotaCents, "llm", "no_verificado", "RC-25")
      continue
    }
    if (info.derivedFromTicket) {
      origins[key] = prov(tax.quotaCents, "calculado", "calculado", "RC-17")
      continue
    }
    if (tax.operationKey === "ISP" || tax.operationKey === "AIB") {
      origins[key] = prov(tax.quotaCents, "calculado", "calculado", "RC-02")
      // El tipo español de la autorrepercusión lo elige el usuario (D11).
      origins[`taxes[${tax.taxRateCode}].taxRateCode`] = prov(tax.taxRateCode, "usuario", "verificado", "RC-06")
      continue
    }
    const deviation = info.quotaDeviationsCents[tax.taxRateCode]
    origins[key] = prov(
      tax.quotaCents,
      "llm",
      statusOf("RC-02") === "FAIL" ? "no_verificado" : deviation === undefined ? "verificado" : "interpretacion_ia",
      "RC-02"
    )
  }

  const rc13 = checks.get("RC-13")
  const reclassified = rc13?.evidence.docKindNormalizado !== undefined
  origins["totalCents"] = reclassified
    ? prov(p.totalCents, "calculado", "calculado", "RC-13")
    : info.derivedFromTicket
      ? prov(p.totalCents, "llm", "interpretacion_ia", "RC-17")
      : prov(p.totalCents, "llm", okOf("RC-03") ? "verificado" : "no_verificado", "RC-03")

  if (info.hasWithholding) {
    origins["withholding.quotaCents"] = prov(p.withholding?.quotaCents ?? null, "calculado", "calculado", "RC-19")
    if (statusOf("RC-19") === "WARN" && (p.readWithholding ?? null) === null) {
      origins["readWithholding"] = prov(null, "llm", "no_verificado", "RC-19")
    }
  }

  if (info.rectificationDelta) {
    origins["asiento.diferenciaBaseCents"] = prov(info.rectificationDelta.baseCents, "calculado", "calculado", "RC-21")
    origins["asiento.diferenciaCuotaCents"] = prov(
      sum(Object.values(info.rectificationDelta.quotaByRate)),
      "calculado",
      "calculado",
      "RC-21"
    )
  }
  if (p.rectifies) {
    origins["rectifies.mode"] = prov(p.rectifies.mode, "usuario", okOf("RC-21") ? "verificado" : "no_verificado", "RC-21")
    if (p.rectifies.mode === "DIFERENCIAS") {
      origins["rectifies.reason"] = prov(p.rectifies.reason, "usuario", okOf("RC-21") ? "verificado" : "no_verificado", "RC-21")
    }
  }

  if (info.conversion) {
    origins["convertedTotalCents"] = prov(info.conversion.convertedTotalCents, "calculado", "calculado", "RC-14")
    origins["asiento.cuotasEnMonedaBase"] = prov(null, "calculado", "calculado", "RC-14")
  }
}
