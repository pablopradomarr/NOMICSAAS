/**
 * E9 · T10 — Las nueve plantillas nuevas (T-29…T-37), el bloque RECC de T-08 y
 * T-09 y la T-25 corregida, contra los ejemplos del experto contable
 * (`docs/design/E9-validacion-cierre.md` §1 y §2, y `E9-cierre-recurrentes.md`
 * §4). Los importes son **los suyos**, no unos inventados aquí.
 */

import { describe, expect, it } from "vitest"

import { buildFromTemplate, TEMPLATE_CODES } from "@/lib/ledger/templates"
import type { AccountKey, EntryDraft, LedgerContext, PlanAccount, Result } from "@/lib/ledger/types"
import { ACCOUNT_KEY_DEFAULT_CODE, DEFERRED_ACCOUNT_KEYS } from "@/lib/accounts/map"
import { testContext } from "@/tests/support/ledger-context"

// ─────────────────────────────────────────────────────────────────────────────
// Contexto: el plan PYMES real + las dos cuentas de RECC + las 19 claves de E9
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `4728` y `4778` **no son cuentas oficiales** (O-14): se crean como hijas de
 * `472` y `477` por prefijo y heredan `statement` y `epigraph` del padre, para
 * que el balance no haya que remapear. Aquí se hace exactamente eso.
 */
function withReccAccounts(plan: LedgerContext["plan"]): LedgerContext["plan"] {
  const byCode = new Map(plan.byCode)
  for (const [code, parentCode] of [
    ["4728", "472"],
    ["4778", "477"],
  ] as const) {
    const parent = plan.byCode.get(parentCode)
    if (!parent) throw new Error(`El plan de pruebas no tiene la cuenta ${parentCode}`)
    const child: PlanAccount = {
      ...parent,
      code,
      name: `${parent.name} pendiente de devengo (RECC)`,
      level: parent.level + 1,
      parentCode,
      isPostable: true,
      isSystem: true,
    }
    byCode.set(code, child)
  }
  return { byCode, codes: [...byCode.keys()].sort() }
}

/** Hoja postable de un código, con la misma regla que `lib/accounts/map.ts`. */
function postableLeaf(plan: LedgerContext["plan"], code: string): string | null {
  const account = plan.byCode.get(code)
  if (!account) return null
  if (account.isPostable) return code
  const leaves = plan.codes.filter((c) => c !== code && c.startsWith(code) && plan.byCode.get(c)?.isPostable)
  return leaves.length > 0 ? leaves.sort()[0] : null
}

/**
 * Las diecinueve claves de E9 están **declaradas** pero no en el mapa
 * automático: las siembra la migración M4 sólo donde la cuenta exista y sea
 * postable. Aquí se siembran todas, que es el caso de una organización con el
 * plan completo.
 */
function e9Context(overrides: Parameters<typeof testContext>[0] = {}): LedgerContext {
  const base = testContext(overrides)
  const plan = withReccAccounts(base.plan)
  const extra = new Map<string, string>()
  for (const key of DEFERRED_ACCOUNT_KEYS) {
    const code = postableLeaf(plan, ACCOUNT_KEY_DEFAULT_CODE[key])
    if (code) extra.set(key, code)
  }
  return { ...base, plan, map: (key: AccountKey) => extra.get(key) ?? base.map(key) }
}

const ctx = e9Context()
const ctx2027 = e9Context({ refDate: "2027-12-31" })

const rows = (r: Result<EntryDraft>): [string, number, number][] => {
  if (!r.ok) throw new Error(`La plantilla falló: ${JSON.stringify(r.errors, null, 2)}`)
  return r.value.lines.map((l) => [l.accountCode, l.debitCents, l.creditCents])
}
const errorsOf = (r: Result<EntryDraft>): string[] => (r.ok ? [] : r.errors.map((e) => e.code))
const balanced = (r: Result<EntryDraft>): boolean => {
  if (!r.ok) return false
  const d = r.value.lines.reduce((a, l) => a + l.debitCents, 0)
  const c = r.value.lines.reduce((a, l) => a + l.creditCents, 0)
  return d === c
}
const key = (k: AccountKey): string => {
  const code = ctx.map(k)
  if (!code) throw new Error(`La clave ${k} no está mapeada`)
  return code
}

const IVA_SOP = key("IVA_SOPORTADO")
const IVA_REP = key("IVA_REPERCUTIDO")
const RECC_SOP = key("IVA_SOPORTADO_PENDIENTE_RECC")
const RECC_REP = key("IVA_REPERCUTIDO_PENDIENTE_RECC")
const ARANCELES = key("ARANCELES")
const ACREEDORES = key("ACREEDORES")
const BANCO = key("BANCO_DEFAULT")
const CLIENTES = key("CLIENTES")
const PROVEEDORES = key("PROVEEDORES")
const FX_NEG = key("DIFERENCIA_CAMBIO_NEGATIVA")
const FX_POS = key("DIFERENCIA_CAMBIO_POSITIVA")
const DEUDA_LP = key("DEUDA_LARGO_INMOVILIZADO")
const PROV_INMOV = key("PROVEEDORES_INMOVILIZADO")
const CREDITO_CP = key("CREDITO_ENAJENACION_CP")
const GANANCIA = key("BENEFICIO_BAJA_INMOVILIZADO")
const PERDIDA = key("PERDIDA_BAJA_INMOVILIZADO")
const INTERESES = key("INTERESES_DEUDAS")
const RESULTADO = key("RESULTADO_EJERCICIO")
const RESERVA_LEGAL = key("RESERVA_LEGAL")
const RESERVAS_VOL = key("RESERVAS_VOLUNTARIAS")
const REMANENTE = key("REMANENTE")
const DIVIDENDO = key("DIVIDENDO_ACTIVO_A_PAGAR")
const DIVIDENDO_CUENTA = key("DIVIDENDO_ACTIVO_A_CUENTA")
const PERDIDAS_ANT = key("RESULTADOS_NEGATIVOS_ANTERIORES")
const IS_CORRIENTE = key("IMPUESTO_CORRIENTE")
const HP_IS = key("HP_ACREEDORA_IS")
const RETENCIONES = key("IRPF_RETENIDO_CLIENTES")

/** Inmovilizado del ejemplo: maquinaria, su acumulada y su dotación. */
const MAQUINARIA = "213"
const ACUMULADA = "2813"
const DOTACION = "681"
const RATE_ID = "11111111-2222-3333-4444-555555555555"

describe("catálogo", () => {
  it("las nueve plantillas de E9 están en el catálogo de 37", () => {
    for (const code of [
      "DUA_IMPORTACION",
      "DIFERENCIAS_CAMBIO_CIERRE",
      "AJUSTE_VALOR_ACTUAL",
      "RECLASIFICACION_VENCIMIENTOS",
      "BAJA_INMOVILIZADO",
      "VENTA_INMOVILIZADO",
      "DISTRIBUCION_RESULTADO",
      "DEVENGO_RECC",
      "ALTA_PRESTAMO",
    ]) {
      expect(TEMPLATE_CODES).toContain(code)
    }
    expect(TEMPLATE_CODES).toHaveLength(37)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T-29 · DUA_IMPORTACION (R-IVA-18, O-16)
// ─────────────────────────────────────────────────────────────────────────────

describe("T-29 DUA_IMPORTACION", () => {
  const base = {
    documentNumber: "DUA-2026-0001",
    documentDate: "2026-05-10",
    customsValueCents: 12_000_000,
    dutiesCents: 500_000,
    vatQuotaCents: 2_520_000,
  }

  it("ordinaria: aranceles a mayor coste, 472 al debe y el acreedor por la suma; SIN 477", () => {
    const r = buildFromTemplate("DUA_IMPORTACION", { ...base, periodKind: "TRIMESTRAL" }, ctx)
    expect(rows(r)).toEqual([
      [ARANCELES, 500_000, 0],
      [IVA_SOP, 2_520_000, 0],
      [ACREEDORES, 0, 3_020_000],
    ])
    expect(balanced(r)).toBe(true)
  })

  it("con diferimiento (art. 167.Dos): aparece 477 y sólo el arancel se paga", () => {
    const r = buildFromTemplate(
      "DUA_IMPORTACION",
      { ...base, importDeferral: true, periodKind: "MENSUAL" },
      ctx
    )
    expect(rows(r)).toEqual([
      [ARANCELES, 500_000, 0],
      [IVA_SOP, 2_520_000, 0],
      [IVA_REP, 0, 2_520_000],
      [ACREEDORES, 0, 500_000],
    ])
    expect(balanced(r)).toBe(true)
  })

  it("el diferimiento exige periodo MENSUAL (art. 74.1 RIVA)", () => {
    const r = buildFromTemplate("DUA_IMPORTACION", { ...base, importDeferral: true, periodKind: "TRIMESTRAL" }, ctx)
    expect(errorsOf(r)).toContain("TEMPLATE_INPUT")
  })

  it("la base declarada es la del DUA, no la de la factura del proveedor", () => {
    const r = buildFromTemplate("DUA_IMPORTACION", base, ctx)
    if (!r.ok) throw new Error("falló")
    const vatLine = r.value.lines.find((l) => l.accountCode === IVA_SOP)
    expect(vatLine?.taxBaseCents).toBe(12_000_000)
  })

  it("sin aranceles el asiento son dos líneas", () => {
    const r = buildFromTemplate("DUA_IMPORTACION", { ...base, dutiesCents: 0 }, ctx)
    expect(rows(r)).toEqual([
      [IVA_SOP, 2_520_000, 0],
      [ACREEDORES, 0, 2_520_000],
    ])
  })

  it("un DUA sin cuota no se contabiliza con T-29", () => {
    expect(errorsOf(buildFromTemplate("DUA_IMPORTACION", { ...base, vatQuotaCents: 0 }, ctx))).toContain(
      "TEMPLATE_INPUT"
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T-30 · DIFERENCIAS_CAMBIO_CIERRE (R-FX-1…6)
// ─────────────────────────────────────────────────────────────────────────────

describe("T-30 DIFERENCIAS_CAMBIO_CIERRE", () => {
  const adj = (over: Record<string, unknown> = {}) => ({
    accountCode: PROVEEDORES,
    currency: "USD",
    deltaCents: 10_000,
    exchangeRateId: RATE_ID,
    rateDate: "2026-12-31",
    ...over,
  })

  it("ejemplo del experto: 400 en USD con Δ = +10.000 ⇒ 400 (D) / 768 (H)", () => {
    const r = buildFromTemplate("DIFERENCIAS_CAMBIO_CIERRE", { cutoff: "2026-12-31", adjustments: [adj()] }, ctx)
    expect(rows(r)).toEqual([
      [PROVEEDORES, 10_000, 0],
      [FX_POS, 0, 10_000],
    ])
  })

  it("Δ < 0 ⇒ 668 (D) / cuenta (H), sin distinguir activo de pasivo", () => {
    const r = buildFromTemplate(
      "DIFERENCIAS_CAMBIO_CIERRE",
      { cutoff: "2026-12-31", adjustments: [adj({ accountCode: CLIENTES, deltaCents: -4_200 })] },
      ctx
    )
    expect(rows(r)).toEqual([
      [CLIENTES, 0, 4_200],
      [FX_NEG, 4_200, 0],
    ])
  })

  it("varias posiciones: orden canónico y 668/768 agregados en una línea cada uno", () => {
    const r = buildFromTemplate(
      "DIFERENCIAS_CAMBIO_CIERRE",
      {
        cutoff: "2026-12-31",
        adjustments: [
          adj({ accountCode: PROVEEDORES, currency: "USD", deltaCents: 10_000 }),
          adj({ accountCode: CLIENTES, currency: "GBP", deltaCents: -4_200 }),
          adj({ accountCode: CLIENTES, currency: "USD", deltaCents: 1_300 }),
        ],
      },
      ctx
    )
    // Orden canónico: cuenta, contraparte, divisa (4000 antes que 4300; dentro
    // de 4300, GBP antes que USD). No depende del orden del input.
    expect(rows(r)).toEqual([
      [PROVEEDORES, 10_000, 0],
      [CLIENTES, 0, 4_200],
      [CLIENTES, 1_300, 0],
      [FX_NEG, 4_200, 0],
      [FX_POS, 0, 11_300],
    ])
    expect(balanced(r)).toBe(true)
  })

  it("R-FX-4: la línea de la partida lleva la divisa, importe original 0 y la tasa sellada", () => {
    const r = buildFromTemplate("DIFERENCIAS_CAMBIO_CIERRE", { cutoff: "2026-12-31", adjustments: [adj()] }, ctx)
    if (!r.ok) throw new Error("falló")
    const line = r.value.lines[0]
    expect(line.originalCurrency).toBe("USD")
    expect(line.originalAmountCents).toBe(0)
    expect(line.exchangeRateId).toBe(RATE_ID)
    expect(line.description).toContain("2026-12-31")
  })

  it("sin diferencia no hay asiento (idempotencia del recierre)", () => {
    const r = buildFromTemplate(
      "DIFERENCIAS_CAMBIO_CIERRE",
      { cutoff: "2026-12-31", adjustments: [adj({ deltaCents: 0 })] },
      ctx
    )
    expect(errorsOf(r)).toContain("TEMPLATE_INPUT")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T-31 · AJUSTE_VALOR_ACTUAL (R-VA-1, O-1)
// ─────────────────────────────────────────────────────────────────────────────

describe("T-31 AJUSTE_VALOR_ACTUAL", () => {
  it("caso A completo: descuento, reversión del exceso amortizado e interés implícito", () => {
    const r = buildFromTemplate(
      "AJUSTE_VALOR_ACTUAL",
      {
        entryDate: "2026-12-31",
        case: "A_EJERCICIO_CORRIENTE",
        side: "PASIVO",
        positionAccountCode: DEUDA_LP,
        assetAccountCode: MAQUINARIA,
        discountCents: 1_100_036,
        excessDepreciationCents: 183_340,
        accumulatedAccountCode: ACUMULADA,
        depreciationExpenseAccountCode: DOTACION,
        implicitInterestCents: 454_133,
      },
      ctx
    )
    expect(rows(r)).toEqual([
      [DEUDA_LP, 1_100_036, 0],
      [MAQUINARIA, 0, 1_100_036],
      [ACUMULADA, 183_340, 0],
      [DOTACION, 0, 183_340],
      [INTERESES, 454_133, 0],
      [DEUDA_LP, 0, 454_133],
    ])
    expect(balanced(r)).toBe(true)
  })

  it("el caso B (ejercicio cerrado) no entra por T-31: el schema sólo admite A y C", () => {
    const r = buildFromTemplate(
      "AJUSTE_VALOR_ACTUAL",
      {
        entryDate: "2026-12-31",
        case: "B_EJERCICIO_CERRADO",
        positionAccountCode: DEUDA_LP,
        assetAccountCode: MAQUINARIA,
        discountCents: 1_000,
      },
      ctx
    )
    expect(errorsOf(r)).toContain("TEMPLATE_INPUT")
  })

  it("caso C: contra el gasto original, y no admite reversión de amortización", () => {
    const ok = buildFromTemplate(
      "AJUSTE_VALOR_ACTUAL",
      {
        entryDate: "2026-12-31",
        case: "C_NO_INMOVILIZADO",
        side: "PASIVO",
        positionAccountCode: PROV_INMOV,
        originAccountCode: "621",
        discountCents: 50_000,
      },
      ctx
    )
    expect(rows(ok)).toEqual([
      [PROV_INMOV, 50_000, 0],
      ["621", 0, 50_000],
    ])

    const ko = buildFromTemplate(
      "AJUSTE_VALOR_ACTUAL",
      {
        entryDate: "2026-12-31",
        case: "C_NO_INMOVILIZADO",
        positionAccountCode: PROV_INMOV,
        originAccountCode: "621",
        discountCents: 50_000,
        excessDepreciationCents: 1_000,
        accumulatedAccountCode: ACUMULADA,
        depreciationExpenseAccountCode: DOTACION,
      },
      ctx
    )
    expect(errorsOf(ko)).toContain("TEMPLATE_INPUT")
  })

  it("el caso A sin cuenta de inmovilizado no construye", () => {
    const r = buildFromTemplate(
      "AJUSTE_VALOR_ACTUAL",
      { entryDate: "2026-12-31", case: "A_EJERCICIO_CORRIENTE", positionAccountCode: DEUDA_LP, discountCents: 1_000 },
      ctx
    )
    expect(errorsOf(r)).toContain("TEMPLATE_INPUT")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T-32 · RECLASIFICACION_VENCIMIENTOS (R-RC-1…7)
// ─────────────────────────────────────────────────────────────────────────────

describe("T-32 RECLASIFICACION_VENCIMIENTOS", () => {
  it("ejemplo del experto: 523 → 173 por 500.000, suma cero por par (I-E9-16)", () => {
    const r = buildFromTemplate(
      "RECLASIFICACION_VENCIMIENTOS",
      {
        cutoff: "2026-12-31",
        moves: [
          {
            fromAccountCode: PROV_INMOV,
            toAccountCode: DEUDA_LP,
            amountCents: 500_000,
            side: "PASIVO",
            dueDate: "2028-06-30",
          },
        ],
      },
      ctx
    )
    expect(rows(r)).toEqual([
      [PROV_INMOV, 500_000, 0],
      [DEUDA_LP, 0, 500_000],
    ])
    expect(balanced(r)).toBe(true)
  })

  it("un crédito se reclasifica al revés que una deuda", () => {
    const r = buildFromTemplate(
      "RECLASIFICACION_VENCIMIENTOS",
      {
        cutoff: "2026-12-31",
        moves: [{ fromAccountCode: "253", toAccountCode: "543", amountCents: 120_000, side: "ACTIVO" }],
      },
      ctx
    )
    expect(rows(r)).toEqual([
      ["543", 120_000, 0],
      ["253", 0, 120_000],
    ])
  })

  it("reclasificar una cuenta sobre sí misma es un error", () => {
    const r = buildFromTemplate(
      "RECLASIFICACION_VENCIMIENTOS",
      {
        cutoff: "2026-12-31",
        moves: [{ fromAccountCode: DEUDA_LP, toAccountCode: DEUDA_LP, amountCents: 1_000, side: "PASIVO" }],
      },
      ctx
    )
    expect(errorsOf(r)).toContain("TEMPLATE_INPUT")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T-33 · BAJA_INMOVILIZADO · T-34 · VENTA_INMOVILIZADO (R-AM-6/R-AM-7)
// ─────────────────────────────────────────────────────────────────────────────

const activo = {
  documentDate: "2026-09-30",
  assetCode: "MAQ-001",
  assetAccountCode: MAQUINARIA,
  accumulatedAccountCode: ACUMULADA,
  acquisitionCostCents: 1_000_000,
  accumulatedCents: 640_000,
  fixedAssetId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
}

describe("T-33 BAJA_INMOVILIZADO", () => {
  it("ejemplo del experto: 2811 (D) 640.000 · 671 (D) 360.000 · 2131 (H) 1.000.000", () => {
    const r = buildFromTemplate("BAJA_INMOVILIZADO", activo, ctx)
    expect(rows(r)).toEqual([
      [ACUMULADA, 640_000, 0],
      [PERDIDA, 360_000, 0],
      [MAQUINARIA, 0, 1_000_000],
    ])
    expect(balanced(r)).toBe(true)
  })

  it("O-19: las líneas del activo llevan `fixedAssetId`", () => {
    const r = buildFromTemplate("BAJA_INMOVILIZADO", activo, ctx)
    if (!r.ok) throw new Error("falló")
    for (const line of r.value.lines) {
      expect((line as { fixedAssetId?: string | null }).fixedAssetId).toBe(activo.fixedAssetId)
    }
  })

  it("un activo totalmente amortizado se da de baja sin 671", () => {
    const r = buildFromTemplate("BAJA_INMOVILIZADO", { ...activo, accumulatedCents: 1_000_000 }, ctx)
    expect(rows(r)).toEqual([
      [ACUMULADA, 1_000_000, 0],
      [MAQUINARIA, 0, 1_000_000],
    ])
  })

  it("una acumulada mayor que el coste bloquea (I-E9-5)", () => {
    expect(errorsOf(buildFromTemplate("BAJA_INMOVILIZADO", { ...activo, accumulatedCents: 1_200_000 }, ctx))).toContain(
      "TEMPLATE_INPUT"
    )
  })
})

describe("T-34 VENTA_INMOVILIZADO", () => {
  it("ejemplo del experto: 543 605.000 · 2811 640.000 · 2131 1.000.000 · 477 105.000 · 771 140.000", () => {
    const r = buildFromTemplate(
      "VENTA_INMOVILIZADO",
      { ...activo, priceCents: 500_000, vatQuotaCents: 105_000 },
      ctx
    )
    expect(rows(r)).toEqual([
      [CREDITO_CP, 605_000, 0],
      [ACUMULADA, 640_000, 0],
      [MAQUINARIA, 0, 1_000_000],
      [IVA_REP, 0, 105_000],
      [GANANCIA, 0, 140_000],
    ])
    expect(balanced(r)).toBe(true)
  })

  it("la contrapartida NUNCA es 430: con aplazamiento largo, 253", () => {
    const r = buildFromTemplate(
      "VENTA_INMOVILIZADO",
      { ...activo, priceCents: 500_000, vatQuotaCents: 105_000, receivableKey: "CREDITO_ENAJENACION_LP" },
      ctx
    )
    expect(rows(r)[0][0]).toBe(key("CREDITO_ENAJENACION_LP"))
    expect(rows(r).map((x) => x[0])).not.toContain(CLIENTES)
  })

  it("vender por debajo del valor neto contable lleva la diferencia a 671", () => {
    const r = buildFromTemplate("VENTA_INMOVILIZADO", { ...activo, priceCents: 300_000, vatQuotaCents: 63_000 }, ctx)
    expect(rows(r)).toEqual([
      [CREDITO_CP, 363_000, 0],
      [ACUMULADA, 640_000, 0],
      [PERDIDA, 60_000, 0],
      [MAQUINARIA, 0, 1_000_000],
      [IVA_REP, 0, 63_000],
    ])
    expect(balanced(r)).toBe(true)
  })

  it("venta exenta: sin línea de 477", () => {
    const r = buildFromTemplate("VENTA_INMOVILIZADO", { ...activo, priceCents: 360_000, vatQuotaCents: 0 }, ctx)
    expect(rows(r)).toEqual([
      [CREDITO_CP, 360_000, 0],
      [ACUMULADA, 640_000, 0],
      [MAQUINARIA, 0, 1_000_000],
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T-35 · DISTRIBUCION_RESULTADO (§4.9, O-18)
// ─────────────────────────────────────────────────────────────────────────────

describe("T-35 DISTRIBUCION_RESULTADO", () => {
  it("ejemplo del experto: 129 (D) 1.497.322 / 112 149.732 / 113 847.590 / 526 500.000", () => {
    const r = buildFromTemplate(
      "DISTRIBUCION_RESULTADO",
      {
        entryDate: "2027-06-25",
        profitCents: 1_497_322,
        legalReserveCents: 149_732,
        voluntaryReserveCents: 847_590,
        dividendCents: 500_000,
      },
      ctx2027
    )
    expect(rows(r)).toEqual([
      [RESULTADO, 1_497_322, 0],
      [RESERVA_LEGAL, 0, 149_732],
      [RESERVAS_VOL, 0, 847_590],
      [DIVIDENDO, 0, 500_000],
    ])
    expect(balanced(r)).toBe(true)
  })

  it("el dividendo a cuenta ya satisfecho (557) se cancela contra el resultado", () => {
    const r = buildFromTemplate(
      "DISTRIBUCION_RESULTADO",
      {
        entryDate: "2027-06-25",
        profitCents: 1_000_000,
        legalReserveCents: 100_000,
        remainderCents: 400_000,
        dividendCents: 500_000,
        interimDividendPaidCents: 200_000,
      },
      ctx2027
    )
    expect(rows(r)).toEqual([
      [RESULTADO, 1_000_000, 0],
      [RESERVA_LEGAL, 0, 100_000],
      [REMANENTE, 0, 400_000],
      [DIVIDENDO_CUENTA, 0, 200_000],
      [DIVIDENDO, 0, 300_000],
    ])
    expect(balanced(r)).toBe(true)
  })

  it("un reparto que no agota el resultado bloquea (I-E9-23)", () => {
    const r = buildFromTemplate(
      "DISTRIBUCION_RESULTADO",
      { entryDate: "2027-06-25", profitCents: 1_000_000, legalReserveCents: 100_000 },
      ctx2027
    )
    expect(errorsOf(r)).toContain("TEMPLATE_INPUT")
  })

  it("un dividendo a cuenta mayor que el acordado bloquea", () => {
    const r = buildFromTemplate(
      "DISTRIBUCION_RESULTADO",
      {
        entryDate: "2027-06-25",
        profitCents: 500_000,
        dividendCents: 100_000,
        remainderCents: 400_000,
        interimDividendPaidCents: 300_000,
      },
      ctx2027
    )
    expect(errorsOf(r)).toContain("TEMPLATE_INPUT")
  })

  it("pérdida: 121 (D) / 129 (H), sin reparto", () => {
    const r = buildFromTemplate("DISTRIBUCION_RESULTADO", { entryDate: "2027-06-25", lossCents: 250_000 }, ctx2027)
    expect(rows(r)).toEqual([
      [PERDIDAS_ANT, 250_000, 0],
      [RESULTADO, 0, 250_000],
    ])
  })

  it("sin resultado no hay distribución", () => {
    expect(errorsOf(buildFromTemplate("DISTRIBUCION_RESULTADO", { entryDate: "2027-06-25" }, ctx2027))).toContain(
      "TEMPLATE_INPUT"
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T-36 · DEVENGO_RECC (R-IVA-19)
// ─────────────────────────────────────────────────────────────────────────────

describe("T-36 DEVENGO_RECC", () => {
  const pending = [
    {
      id: "1",
      side: "EMITIDA" as const,
      documentNumber: "2025/014",
      operationDate: "2025-03-10",
      totalQuotaCents: 210_000,
      accruedCents: 86_776,
    },
    {
      id: "2",
      side: "RECIBIDA" as const,
      documentNumber: "P-2025/009",
      operationDate: "2025-11-02",
      totalQuotaCents: 42_000,
      accruedCents: 0,
    },
    {
      id: "3",
      side: "EMITIDA" as const,
      documentNumber: "2026/031",
      operationDate: "2026-04-01",
      totalQuotaCents: 10_000,
      accruedCents: 0,
    },
  ]

  it("barre lo del año anterior y NO lo del ejercicio en curso", () => {
    const r = buildFromTemplate("DEVENGO_RECC", { cutoff: "2026-12-31", pending }, ctx)
    expect(rows(r)).toEqual([
      [RECC_REP, 123_224, 0],
      [IVA_REP, 0, 123_224],
      [IVA_SOP, 42_000, 0],
      [RECC_SOP, 0, 42_000],
    ])
    expect(balanced(r)).toBe(true)
  })

  it("sin nada pendiente del año anterior no hay barrido", () => {
    const r = buildFromTemplate("DEVENGO_RECC", { cutoff: "2026-12-31", pending: [pending[2]] }, ctx)
    expect(errorsOf(r)).toContain("TEMPLATE_INPUT")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T-37 · ALTA_PRESTAMO (R-RC-4, O-6)
// ─────────────────────────────────────────────────────────────────────────────

describe("T-37 ALTA_PRESTAMO", () => {
  const prestamo = {
    documentDate: "2026-01-15",
    scheduleCode: "PR-2026-01",
    longAccountCode: "170",
    shortAccountCode: "5200",
    principalCents: 4_000_000,
    installments: [
      { seq: 1, dueDate: "2026-07-15", principalCents: 1_000_000 },
      { seq: 2, dueDate: "2027-01-15", principalCents: 1_000_000 },
      { seq: 3, dueDate: "2027-07-15", principalCents: 1_000_000 },
      { seq: 4, dueDate: "2028-01-17", principalCents: 1_000_000 },
    ],
  }

  it("una línea por vencimiento, con su fecha y su cuenta corto / largo", () => {
    const r = buildFromTemplate("ALTA_PRESTAMO", prestamo, ctx)
    expect(rows(r)).toEqual([
      [BANCO, 4_000_000, 0],
      ["5200", 0, 1_000_000],
      ["5200", 0, 1_000_000],
      ["170", 0, 1_000_000],
      ["170", 0, 1_000_000],
    ])
    if (!r.ok) throw new Error("falló")
    expect(r.value.lines.slice(1).map((l) => l.dueDate)).toEqual([
      "2026-07-15",
      "2027-01-15",
      "2027-07-15",
      "2028-01-17",
    ])
  })

  it("la comisión de apertura tiene línea propia y minora el efectivo recibido", () => {
    const r = buildFromTemplate("ALTA_PRESTAMO", { ...prestamo, arrangementFeeCents: 40_000 }, ctx)
    expect(rows(r)[0]).toEqual([BANCO, 3_960_000, 0])
    expect(rows(r)[1]).toEqual([key("COMISIONES_BANCARIAS"), 40_000, 0])
    expect(balanced(r)).toBe(true)
  })

  it("un cuadro que no agota el principal bloquea (I-E9-25)", () => {
    const r = buildFromTemplate(
      "ALTA_PRESTAMO",
      { ...prestamo, installments: prestamo.installments.slice(0, 3) },
      ctx
    )
    expect(errorsOf(r)).toContain("TEMPLATE_INPUT")
  })

  it("un préstamo sin desglose no se puede dar de alta: el schema exige el cuadro", () => {
    expect(errorsOf(buildFromTemplate("ALTA_PRESTAMO", { ...prestamo, installments: [] }, ctx))).toContain(
      "TEMPLATE_INPUT"
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T-08 / T-09 · bloque RECC (O-15) · T-25 corregida (O-26)
// ─────────────────────────────────────────────────────────────────────────────

describe("T-08 / T-09 con RECC", () => {
  const recc = {
    documentNumber: "2026/044",
    totalInvoiceCents: 1_210_000,
    totalQuotaCents: 210_000,
  }

  it("ejemplo del experto: cobro de 500.000 sobre 1.210.000 ⇒ 4778 (D) 86.776 / 477 (H)", () => {
    const r = buildFromTemplate(
      "COBRO_CLIENTE",
      {
        documentDate: "2026-06-30",
        settlements: [{ amountCents: 500_000 }],
        amountReceivedCents: 500_000,
        recc,
      },
      ctx
    )
    expect(rows(r)).toEqual([
      [BANCO, 500_000, 0],
      [CLIENTES, 0, 500_000],
      [RECC_REP, 86_776, 0],
      [IVA_REP, 0, 86_776],
    ])
    expect(balanced(r)).toBe(true)
  })

  it("el último cobro arrastra el residuo y salda la cuota (I-E9-26)", () => {
    const r = buildFromTemplate(
      "COBRO_CLIENTE",
      {
        documentDate: "2026-09-30",
        settlements: [{ amountCents: 710_000 }],
        amountReceivedCents: 710_000,
        recc: { ...recc, alreadyAccruedCents: 86_776, isFinal: true },
      },
      ctx
    )
    expect(rows(r)[2]).toEqual([RECC_REP, 123_224, 0])
  })

  it("T-09: el destinatario de un proveedor en RECC deduce al pago (472 / 4728)", () => {
    const r = buildFromTemplate(
      "PAGO_PROVEEDOR",
      {
        documentDate: "2026-06-30",
        settlements: [{ amountCents: 500_000 }],
        amountPaidCents: 500_000,
        recc,
      },
      ctx
    )
    expect(rows(r)).toEqual([
      [PROVEEDORES, 500_000, 0],
      [BANCO, 0, 500_000],
      [IVA_SOP, 86_776, 0],
      [RECC_SOP, 0, 86_776],
    ])
  })

  it("sin bloque RECC, T-08 emite exactamente las líneas de E3", () => {
    const r = buildFromTemplate(
      "COBRO_CLIENTE",
      { documentDate: "2026-06-30", settlements: [{ amountCents: 500_000 }], amountReceivedCents: 500_000 },
      ctx
    )
    expect(rows(r)).toEqual([
      [BANCO, 500_000, 0],
      [CLIENTES, 0, 500_000],
    ])
  })

  it("imputar a la factura más de su total bloquea", () => {
    const r = buildFromTemplate(
      "COBRO_CLIENTE",
      {
        documentDate: "2026-06-30",
        settlements: [{ amountCents: 500_000 }],
        amountReceivedCents: 500_000,
        recc: { ...recc, collectedCents: 2_000_000 },
      },
      ctx
    )
    expect(errorsOf(r)).toContain("TEMPLATE_INPUT")
  })
})

describe("T-25 IMPUESTO_BENEFICIOS con las correcciones de O-26", () => {
  it("ejemplo del experto: 6300 (D) 500.000 / 473 (H) 300.000 / 4752 (H) 200.000", () => {
    const r = buildFromTemplate(
      "IMPUESTO_BENEFICIOS",
      { documentDate: "2026-12-31", taxableBaseCents: 2_000_000, rateBps: 2500, prepaymentsCents: 300_000 },
      ctx
    )
    expect(rows(r)).toEqual([
      [IS_CORRIENTE, 500_000, 0],
      [RETENCIONES, 0, 300_000],
      [HP_IS, 0, 200_000],
    ])
    expect(balanced(r)).toBe(true)
  })

  it("la cuenta es 6300, no el padre 630", () => {
    expect(IS_CORRIENTE).toBe("6300")
  })

  it("con pagos a cuenta mayores que la cuota, 473 se cancela IGUAL y 4709 va al debe", () => {
    const r = buildFromTemplate(
      "IMPUESTO_BENEFICIOS",
      { documentDate: "2026-12-31", taxableBaseCents: 400_000, rateBps: 2500, prepaymentsCents: 300_000 },
      ctx
    )
    expect(rows(r)).toEqual([
      [IS_CORRIENTE, 100_000, 0],
      [RETENCIONES, 0, 300_000],
      [key("HP_DEUDORA_IS"), 200_000, 0],
    ])
    expect(balanced(r)).toBe(true)
  })

  it("sin base imponible positiva no hay cuota que contabilizar", () => {
    expect(
      errorsOf(
        buildFromTemplate("IMPUESTO_BENEFICIOS", { documentDate: "2026-12-31", taxableBaseCents: -50_000, rateBps: 2500 }, ctx)
      )
    ).toContain("TEMPLATE_INPUT")
  })
})
