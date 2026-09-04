/**
 * E2 · T5 — Validación, selección por vigencia y catálogo inicial de `TaxRate`.
 * Módulo PURO: `refDate` entra por parámetro, nunca `new Date()`.
 */

import { AccountError, AccountKey, err, fail, ok, Plan, Result } from "@/lib/accounts/types"
import { MAX_RATE_BPS, TaxRateInput, TaxRateRow, TaxRateSeed, TaxSide } from "@/lib/taxes/types"

/** Día (UTC) de una fecha, como entero comparable. Las vigencias son `@db.Date`. */
function dayNumber(date: Date): number {
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 86_400_000)
}

/** `true` si `refDate` cae dentro de `[validFrom, validTo]` (ambos inclusive). */
export function isInForce(rate: Pick<TaxRateRow, "validFrom" | "validTo">, refDate: Date): boolean {
  const day = dayNumber(refDate)
  if (day < dayNumber(rate.validFrom)) return false
  if (rate.validTo !== null && day > dayNumber(rate.validTo)) return false
  return true
}

/** `true` si dos intervalos de vigencia se solapan (mismo criterio que el EXCLUDE). */
export function overlaps(
  a: Pick<TaxRateRow, "validFrom" | "validTo">,
  b: Pick<TaxRateRow, "validFrom" | "validTo">
): boolean {
  const aFrom = dayNumber(a.validFrom)
  const aTo = a.validTo === null ? Number.POSITIVE_INFINITY : dayNumber(a.validTo)
  const bFrom = dayNumber(b.validFrom)
  const bTo = b.validTo === null ? Number.POSITIVE_INFINITY : dayNumber(b.validTo)
  return aFrom <= bTo && bFrom <= aTo
}

/**
 * El tipo vigente a `refDate` para un `code`. Devuelve `null` si ninguno lo
 * está: un asiento de 2024 NO coge el tipo de 2026 (C-7, criterio 8).
 */
export function selectTaxRate(rates: readonly TaxRateRow[], code: string, refDate: Date): TaxRateRow | null {
  const candidates = rates.filter((r) => r.code === code && r.isActive && isInForce(r, refDate))
  if (candidates.length === 0) return null
  // Con el EXCLUDE de vigencias no puede haber dos; si los hubiera (datos
  // migrados a mano), gana el de `validFrom` más reciente, que es el vigente.
  return candidates.reduce((best, r) => (dayNumber(r.validFrom) > dayNumber(best.validFrom) ? r : best))
}

/** Todos los tipos vigentes a una fecha, opcionalmente de un `kind`. */
export function selectTaxRatesInForce(
  rates: readonly TaxRateRow[],
  refDate: Date,
  kind?: TaxRateRow["kind"]
): TaxRateRow[] {
  return rates
    .filter((r) => r.isActive && isInForce(r, refDate) && (kind === undefined || r.kind === kind))
    .sort((a, b) => (a.code < b.code ? -1 : 1))
}

/**
 * Resuelve la cuenta por dirección (C-2): esto es lo que sustituye a duplicar la
 * fila por `IVA21_REP` / `IVA21_SOP`. Con inversión del sujeto pasivo el asiento
 * pide LAS DOS a la vez (efecto neto 0).
 */
export function taxAccountFor(rate: TaxRateRow, side: TaxSide): string {
  return side === "SALE" ? rate.accountCode : (rate.counterAccountCode ?? rate.accountCode)
}

/** `true` si el tipo puede usarse en esa dirección (`appliesTo`). */
export function taxAppliesToSide(rate: TaxRateRow, side: TaxSide): boolean {
  return rate.appliesTo === "BOTH" || rate.appliesTo === side
}

// ─────────────────────────────────────────────────────────────────────────────
// Validación (§3, `validateTaxRate`)
// ─────────────────────────────────────────────────────────────────────────────

function checkAccount(plan: Plan, code: string | null, field: string, errors: AccountError[]): void {
  if (code === null) return
  const account = plan.byCode.get(code)
  if (!account) {
    errors.push(err("ACCOUNT_NOT_FOUND", field, `La cuenta ${code} no existe en el plan de la organización`))
    return
  }
  if (!account.isActive) errors.push(err("ACCOUNT_INACTIVE", field, `La cuenta ${code} está desactivada`))
  if (!account.isPostable) {
    errors.push(err("ACCOUNT_NOT_POSTABLE", field, `La cuenta ${code} tiene subcuentas y no admite apuntes`))
  }
}

/**
 * `0 ≤ rateBps ≤ 10000`; `validTo ≥ validFrom`; sin solape de vigencia para el
 * mismo `code`; cuentas existentes, activas y postables; `EXENTO ⇒ rateBps = 0`;
 * `RECARGO ⇒ linkedTaxRateId` a un IVA cuya vigencia cubra la del recargo.
 */
export function validateTaxRate(
  input: TaxRateInput,
  existing: readonly TaxRateRow[],
  plan: Plan,
  _refDate: Date
): Result<TaxRateRow> {
  const errors: AccountError[] = []

  if (!Number.isInteger(input.rateBps) || input.rateBps < 0 || input.rateBps > MAX_RATE_BPS) {
    errors.push(
      err("RATE_RANGE", "rateBps", `El tipo debe ser un entero de 0 a ${MAX_RATE_BPS} puntos básicos (0 % a 100 %)`)
    )
  }
  if (input.kind === "EXENTO" && input.rateBps !== 0) {
    errors.push(err("RATE_RANGE", "rateBps", "Un tipo exento no puede tener cuota: rateBps debe ser 0"))
  }
  if (input.code.trim() === "") {
    errors.push(err("CSV_ROW", "code", "El código del tipo impositivo es obligatorio"))
  }
  if (input.name.trim() === "") {
    errors.push(err("CSV_ROW", "name", "El nombre del tipo impositivo es obligatorio"))
  }
  if (input.validTo !== null && dayNumber(input.validTo) < dayNumber(input.validFrom)) {
    errors.push(err("VALIDITY_RANGE", "validTo", "El fin de vigencia no puede ser anterior a su inicio"))
  }

  checkAccount(plan, input.accountCode, "accountCode", errors)
  checkAccount(plan, input.counterAccountCode, "counterAccountCode", errors)

  // I-E2-3: sin solape para el mismo código (además del EXCLUDE de la BD).
  for (const other of existing) {
    if (other.code !== input.code) continue
    if (input.id !== undefined && other.id === input.id) continue
    if (overlaps(other, input)) {
      errors.push(
        err(
          "RATE_OVERLAP",
          "validFrom",
          `Ya existe un tipo ${input.code} vigente en ese periodo (desde ` +
            `${other.validFrom.toISOString().slice(0, 10)}` +
            `${other.validTo ? ` hasta ${other.validTo.toISOString().slice(0, 10)}` : ", sin fecha de fin"}). ` +
            `Cierra su vigencia con «Cerrar vigencia» poniéndole un fin anterior a ` +
            `${input.validFrom.toISOString().slice(0, 10)} y vuelve a crear el nuevo: los tipos no se ` +
            "editan, se suceden."
        )
      )
    }
  }

  // C-2: el recargo de equivalencia es un tributo distinto que acompaña a un IVA.
  if (input.kind === "RECARGO") {
    if (!input.linkedTaxRateId) {
      errors.push(
        err("RATE_LINK", "linkedTaxRateId", "Un recargo de equivalencia debe enlazarse al tipo de IVA al que acompaña")
      )
    } else {
      const linked = existing.find((r) => r.id === input.linkedTaxRateId)
      if (!linked) {
        errors.push(err("RATE_LINK", "linkedTaxRateId", "El tipo de IVA enlazado no existe"))
      } else if (linked.kind !== "IVA") {
        errors.push(err("RATE_LINK", "linkedTaxRateId", `El tipo enlazado ${linked.code} no es de IVA`))
      } else if (!overlaps(linked, input)) {
        errors.push(
          err("RATE_LINK", "linkedTaxRateId", `El IVA ${linked.code} no está vigente en el periodo del recargo`)
        )
      }
    }
  } else if (input.linkedTaxRateId) {
    errors.push(err("RATE_LINK", "linkedTaxRateId", "Sólo un recargo de equivalencia se enlaza a otro tipo"))
  }

  if (errors.length > 0) return { ok: false, errors }
  return ok({
    id: input.id ?? "",
    code: input.code.trim(),
    name: input.name.trim(),
    kind: input.kind,
    rateBps: input.rateBps,
    appliesTo: input.appliesTo,
    accountCode: input.accountCode,
    counterAccountCode: input.counterAccountCode,
    linkedTaxRateId: input.linkedTaxRateId,
    validFrom: input.validFrom,
    validTo: input.validTo,
    isActive: input.isActive ?? true,
    isSystem: input.isSystem ?? false,
  })
}

/** Cierre de vigencia (nunca borrado): `validTo` no puede ser anterior al inicio. */
export function closeTaxRateValidity(rate: TaxRateRow, validTo: Date): Result<Date> {
  if (dayNumber(validTo) < dayNumber(rate.validFrom)) {
    return fail(err("VALIDITY_RANGE", "validTo", "El fin de vigencia no puede ser anterior a su inicio"))
  }
  return ok(validTo)
}

// ─────────────────────────────────────────────────────────────────────────────
// Catálogo inicial (§3.1)
// ─────────────────────────────────────────────────────────────────────────────

type AccountResolver = (key: AccountKey) => string | null

type SeedSpec = {
  code: string
  name: string
  kind: TaxRateRow["kind"]
  rateBps: number
  appliesTo: TaxRateRow["appliesTo"]
  sale: AccountKey
  purchase: AccountKey | null
  linkedCode?: string
  /** IVA e IRPF tienen orígenes de vigencia distintos (§3.1). */
  since: "IVA" | "ORG"
}

/**
 * §3.1 — una fila por tipo, `appliesTo` y las dos cuentas (C-2). NO se siembra
 * ningún tipo derogado (IVA 18 %/16 %): quien migre contabilidad antigua lo
 * carga desde el editor con su vigencia (C-7).
 */
const SEED_SPECS: readonly SeedSpec[] = [
  { code: "IVA_21", name: "IVA 21 % general", kind: "IVA", rateBps: 2100, appliesTo: "BOTH", sale: "IVA_REPERCUTIDO", purchase: "IVA_SOPORTADO", since: "IVA" },
  { code: "IVA_10", name: "IVA 10 % reducido", kind: "IVA", rateBps: 1000, appliesTo: "BOTH", sale: "IVA_REPERCUTIDO", purchase: "IVA_SOPORTADO", since: "IVA" },
  { code: "IVA_4", name: "IVA 4 % superreducido", kind: "IVA", rateBps: 400, appliesTo: "BOTH", sale: "IVA_REPERCUTIDO", purchase: "IVA_SOPORTADO", since: "IVA" },
  { code: "IVA_0_INTRA", name: "Entrega intracomunitaria exenta (art. 25)", kind: "EXENTO", rateBps: 0, appliesTo: "SALE", sale: "IVA_REPERCUTIDO", purchase: null, since: "IVA" },
  { code: "IVA_0_EXPORT", name: "Exportación exenta (art. 21)", kind: "EXENTO", rateBps: 0, appliesTo: "SALE", sale: "IVA_REPERCUTIDO", purchase: null, since: "IVA" },
  { code: "IVA_EXENTO_20", name: "Exención art. 20 (genera prorrata)", kind: "EXENTO", rateBps: 0, appliesTo: "BOTH", sale: "IVA_REPERCUTIDO", purchase: "IVA_SOPORTADO", since: "IVA" },
  { code: "IVA_NO_SUJETO", name: "Operación no sujeta (art. 7)", kind: "EXENTO", rateBps: 0, appliesTo: "BOTH", sale: "IVA_REPERCUTIDO", purchase: "IVA_SOPORTADO", since: "IVA" },
  { code: "IVA_ISP", name: "Inversión del sujeto pasivo 21 % (art. 84.Uno.2º)", kind: "IVA", rateBps: 2100, appliesTo: "PURCHASE", sale: "IVA_REPERCUTIDO_ISP", purchase: "IVA_SOPORTADO_ISP", since: "IVA" },
  { code: "IVA_ADQ_INTRA_21", name: "Adquisición intracomunitaria 21 %", kind: "IVA", rateBps: 2100, appliesTo: "PURCHASE", sale: "IVA_REPERCUTIDO_ISP", purchase: "IVA_SOPORTADO_ISP", since: "IVA" },
  { code: "IVA_ADQ_INTRA_10", name: "Adquisición intracomunitaria 10 %", kind: "IVA", rateBps: 1000, appliesTo: "PURCHASE", sale: "IVA_REPERCUTIDO_ISP", purchase: "IVA_SOPORTADO_ISP", since: "IVA" },
  { code: "IVA_ADQ_INTRA_4", name: "Adquisición intracomunitaria 4 %", kind: "IVA", rateBps: 400, appliesTo: "PURCHASE", sale: "IVA_REPERCUTIDO_ISP", purchase: "IVA_SOPORTADO_ISP", since: "IVA" },
  { code: "REQ_5_2", name: "Recargo de equivalencia 5,2 %", kind: "RECARGO", rateBps: 520, appliesTo: "SALE", sale: "IVA_REPERCUTIDO", purchase: null, linkedCode: "IVA_21", since: "IVA" },
  { code: "REQ_1_4", name: "Recargo de equivalencia 1,4 %", kind: "RECARGO", rateBps: 140, appliesTo: "SALE", sale: "IVA_REPERCUTIDO", purchase: null, linkedCode: "IVA_10", since: "IVA" },
  { code: "REQ_0_5", name: "Recargo de equivalencia 0,5 %", kind: "RECARGO", rateBps: 50, appliesTo: "SALE", sale: "IVA_REPERCUTIDO", purchase: null, linkedCode: "IVA_4", since: "IVA" },
  // El caso que `ratePermille` no representaba (E-1): 1,75 % = 175 bps.
  { code: "REQ_1_75", name: "Recargo de equivalencia 1,75 % (labores del tabaco)", kind: "RECARGO", rateBps: 175, appliesTo: "SALE", sale: "IVA_REPERCUTIDO", purchase: null, linkedCode: "IVA_21", since: "IVA" },
  { code: "IRPF_PROF_15", name: "Retención profesionales 15 %", kind: "IRPF", rateBps: 1500, appliesTo: "BOTH", sale: "IRPF_PROFESIONALES_A_PAGAR", purchase: "IRPF_RETENIDO_CLIENTES", since: "ORG" },
  { code: "IRPF_PROF_7", name: "Retención profesionales 7 % (inicio de actividad)", kind: "IRPF", rateBps: 700, appliesTo: "BOTH", sale: "IRPF_PROFESIONALES_A_PAGAR", purchase: "IRPF_RETENIDO_CLIENTES", since: "ORG" },
  { code: "IRPF_ALQ_19", name: "Retención arrendamientos urbanos 19 % (modelo 115)", kind: "IRPF", rateBps: 1900, appliesTo: "BOTH", sale: "IRPF_ALQUILERES_A_PAGAR", purchase: "IRPF_RETENIDO_CLIENTES", since: "ORG" },
  { code: "IRPF_CURSOS_15", name: "Retención cursos y conferencias 15 %", kind: "IRPF", rateBps: 1500, appliesTo: "BOTH", sale: "IRPF_TRABAJO_A_PAGAR", purchase: "IRPF_RETENIDO_CLIENTES", since: "ORG" },
  { code: "IRPF_PI_15", name: "Retención propiedad intelectual 15 %", kind: "IRPF", rateBps: 1500, appliesTo: "BOTH", sale: "IRPF_PROFESIONALES_A_PAGAR", purchase: "IRPF_RETENIDO_CLIENTES", since: "ORG" },
  { code: "IRPF_PI_7", name: "Retención propiedad intelectual 7 %", kind: "IRPF", rateBps: 700, appliesTo: "BOTH", sale: "IRPF_PROFESIONALES_A_PAGAR", purchase: "IRPF_RETENIDO_CLIENTES", since: "ORG" },
  { code: "IRPF_AGRO_2", name: "Retención agrícola y ganadera 2 %", kind: "IRPF", rateBps: 200, appliesTo: "BOTH", sale: "IRPF_A_PAGAR", purchase: "IRPF_RETENIDO_CLIENTES", since: "ORG" },
  { code: "IRPF_AGRO_1", name: "Retención engorde porcino y avicultura 1 %", kind: "IRPF", rateBps: 100, appliesTo: "BOTH", sale: "IRPF_A_PAGAR", purchase: "IRPF_RETENIDO_CLIENTES", since: "ORG" },
  { code: "IRPF_FORESTAL_2", name: "Retención actividades forestales 2 %", kind: "IRPF", rateBps: 200, appliesTo: "BOTH", sale: "IRPF_A_PAGAR", purchase: "IRPF_RETENIDO_CLIENTES", since: "ORG" },
  { code: "IRPF_MODULOS_1", name: "Retención estimación objetiva 1 % (art. 95.6 RIRPF)", kind: "IRPF", rateBps: 100, appliesTo: "BOTH", sale: "IRPF_A_PAGAR", purchase: "IRPF_RETENIDO_CLIENTES", since: "ORG" },
  { code: "IRPF_CAPITAL_19", name: "Retención capital mobiliario 19 %", kind: "IRPF", rateBps: 1900, appliesTo: "BOTH", sale: "IRPF_A_PAGAR", purchase: "IRPF_RETENIDO_CLIENTES", since: "ORG" },
  { code: "IRPF_ADMIN_35", name: "Retención administradores 35 %", kind: "IRPF", rateBps: 3500, appliesTo: "SALE", sale: "IRPF_TRABAJO_A_PAGAR", purchase: null, since: "ORG" },
  { code: "IRPF_ADMIN_19", name: "Retención administradores 19 % (INCN < 100.000 €)", kind: "IRPF", rateBps: 1900, appliesTo: "SALE", sale: "IRPF_TRABAJO_A_PAGAR", purchase: null, since: "ORG" },
]

/** Fin de las rebajas temporales de IVA de 2022–2024 (C-7). */
export const VIGENCIA_IVA_2025 = new Date(Date.UTC(2025, 0, 1))

/**
 * Catálogo inicial. `resolve` traduce cada `AccountKey` al código realmente
 * mapeado en la organización (que puede no ser el default: la organización pudo
 * remapear, o `useSubaccounts` apuntar a `47510` en vez de a `4751`).
 *
 * DIVERGENCIA menor respecto a §3 (`seedTaxRates(plan, validFrom)`): se recibe
 * el resolutor del mapa en lugar del plan, porque las cuentas de los tipos son
 * precisamente las del mapa de sistema, no códigos cableados aquí.
 */
export function seedTaxRates(
  resolve: AccountResolver,
  opts: { ivaValidFrom?: Date; orgValidFrom: Date }
): TaxRateSeed[] {
  const out: TaxRateSeed[] = []
  for (const spec of SEED_SPECS) {
    const accountCode = resolve(spec.sale)
    if (!accountCode) continue
    const counterAccountCode = spec.purchase ? resolve(spec.purchase) : null
    out.push({
      code: spec.code,
      name: spec.name,
      kind: spec.kind,
      rateBps: spec.rateBps,
      appliesTo: spec.appliesTo,
      accountCode,
      counterAccountCode,
      linkedCode: spec.linkedCode ?? null,
      validFrom: spec.since === "IVA" ? (opts.ivaValidFrom ?? VIGENCIA_IVA_2025) : opts.orgValidFrom,
      validTo: null,
      isActive: true,
      isSystem: true,
    })
  }
  return out
}

/** Códigos del catálogo inicial (para tests y para el aviso de "tipo de sistema"). */
export const SEED_TAX_CODES: readonly string[] = SEED_SPECS.map((s) => s.code)
