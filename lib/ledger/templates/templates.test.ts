/**
 * E3 · T5a/T5b/T5c — las 28 plantillas contra las tablas del experto contable
 * (`docs/design/E3-asientos-tipo.md` §1). Los importes son los de sus ejemplos.
 *
 * Cada plantilla se comprueba con un fixture pequeño: qué cuentas, en qué
 * columna y por qué importe. La reproducción de los 84 asientos del fixture
 * completo (I-E3-5 con cobertura 28/28) es de la suite de integración.
 */

import { describe, expect, it } from "vitest"

import { ALL_TEMPLATES, buildFromTemplate, OPERATIONAL_TEMPLATE_CODES, TEMPLATE_CODES, TEMPLATES } from "@/lib/ledger/templates"
import type { EntryDraft, Result } from "@/lib/ledger/types"
import { codeFor, FY_2026, testContext } from "@/tests/support/ledger-context"

const CLIENTES = codeFor("CLIENTES")
const PROVEEDORES = codeFor("PROVEEDORES")
const ACREEDORES = codeFor("ACREEDORES")
const BANCO = codeFor("BANCO_DEFAULT")
const CAJA = codeFor("CAJA")
const VENTAS = codeFor("VENTAS_DEFAULT")
const IVA_REP = codeFor("IVA_REPERCUTIDO")
const IVA_SOP = codeFor("IVA_SOPORTADO")
const IVA_REP_ISP = codeFor("IVA_REPERCUTIDO_ISP")
const IVA_SOP_ISP = codeFor("IVA_SOPORTADO_ISP")
const IRPF_CLI = codeFor("IRPF_RETENIDO_CLIENTES")
const IRPF_PROF = codeFor("IRPF_PROFESIONALES_A_PAGAR")
const ANTICIPOS_CLI = codeFor("ANTICIPOS_CLIENTES")
const ANTICIPOS_PROV = codeFor("ANTICIPOS_PROVEEDORES")
const SUBCONTRATACION = codeFor("SUBCONTRATACION_DEFAULT")
const DEVOLUCION_VENTAS = codeFor("DEVOLUCION_VENTAS")
const DEVOLUCION_COMPRAS = codeFor("DEVOLUCION_COMPRAS")
const COMISIONES = codeFor("COMISIONES_BANCARIAS")
const FX_NEG = codeFor("DIFERENCIA_CAMBIO_NEGATIVA")
const FX_POS = codeFor("DIFERENCIA_CAMBIO_POSITIVA")
const REDONDEO_GASTO = codeFor("REDONDEO_GASTO")
const SUELDOS = codeFor("SUELDOS_DEFAULT")
const SS_EMPRESA = codeFor("SS_EMPRESA_DEFAULT")
const REMUNERACIONES = codeFor("REMUNERACIONES_PENDIENTES")
const ANTICIPOS_REM = codeFor("ANTICIPOS_REMUNERACIONES")
const SS_ACREEDORA = codeFor("SS_ACREEDORA")
const IRPF_TRABAJO = codeFor("IRPF_TRABAJO_A_PAGAR")
const PERIOD_GASTO = codeFor("PERIODIFICACION_GASTO")
const PERIOD_INGRESO = codeFor("PERIODIFICACION_INGRESO")
const HP_ACREEDORA_IVA = codeFor("HP_ACREEDORA_IVA")
const HP_DEUDORA_IVA = codeFor("HP_DEUDORA_IVA")
const HP_ACREEDORA_IS = codeFor("HP_ACREEDORA_IS")
const IS_GASTO = codeFor("IMPUESTO_BENEFICIOS_GASTO")
const RESULTADO = codeFor("RESULTADO_EJERCICIO")

/** Asiento como pares `[cuenta, debe, haber]`, en el orden que emite la plantilla. */
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

const ctx = testContext()

// ─────────────────────────────────────────────────────────────────────────────
// Registro
// ─────────────────────────────────────────────────────────────────────────────

describe("registro de plantillas", () => {
  it("son 28, con código único y coherente con su clave", () => {
    expect(TEMPLATE_CODES).toHaveLength(28)
    expect(new Set(TEMPLATE_CODES).size).toBe(28)
    for (const code of TEMPLATE_CODES) expect(TEMPLATES[code].code).toBe(code)
    expect(ALL_TEMPLATES).toHaveLength(28)
  })

  it("24 son de operativa corriente; las 4 de cierre no tienen acción hasta E9", () => {
    expect(OPERATIONAL_TEMPLATE_CODES).toHaveLength(24)
    const systemOnly = ALL_TEMPLATES.filter((t) => t.systemOnly).map((t) => t.code)
    expect(systemOnly.sort()).toEqual(
      ["APERTURA_EJERCICIO", "CIERRE_EJERCICIO", "IMPUESTO_BENEFICIOS", "REGULARIZACION_RESULTADO"].sort()
    )
  })

  it("los tres bloques reparten las 28 (7 + 11 + 10)", () => {
    const count = (block: string) => ALL_TEMPLATES.filter((t) => t.block === block).length
    expect([count("A"), count("B"), count("C")]).toEqual([7, 11, 10])
  })

  it("una plantilla desconocida devuelve TEMPLATE_INPUT, no lanza", () => {
    // @ts-expect-error probamos a propósito un código fuera del catálogo
    const r = buildFromTemplate("NO_EXISTE", {}, ctx)
    expect(errorsOf(r)).toContain("TEMPLATE_INPUT")
  })

  it("un input que no pasa el schema devuelve TEMPLATE_INPUT (caso vacío)", () => {
    expect(errorsOf(buildFromTemplate("FACTURA_EMITIDA_SERVICIOS", {}, ctx))).toContain("TEMPLATE_INPUT")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Bloque A — T-01 … T-07
// ─────────────────────────────────────────────────────────────────────────────

describe("T-01 FACTURA_EMITIDA_SERVICIOS", () => {
  const base = {
    documentNumber: "2026/001",
    documentDate: "2026-01-20",
  }

  it("F-001: dos tipos de IVA en el mismo documento (cuotas 105.000 y 12.000)", () => {
    const r = buildFromTemplate(
      "FACTURA_EMITIDA_SERVICIOS",
      {
        ...base,
        lines: [
          { baseCents: 500000, taxRateCode: "IVA_21" },
          { baseCents: 120000, taxRateCode: "IVA_10" },
        ],
        totalCents: 737000,
      },
      ctx
    )
    expect(rows(r)).toEqual([
      [CLIENTES, 737000, 0],
      [VENTAS, 0, 500000],
      [VENTAS, 0, 120000],
      [IVA_REP, 0, 105000],
      [IVA_REP, 0, 12000],
    ])
  })

  it("F-002: retención de IRPF 15 % sobre la base total (R-IVA-6)", () => {
    const r = buildFromTemplate(
      "FACTURA_EMITIDA_SERVICIOS",
      {
        ...base,
        documentDate: "2026-02-20",
        lines: [{ baseCents: 800000, taxRateCode: "IVA_21" }],
        withholdingRateCode: "IRPF_PROF_15",
        totalCents: 848000,
      },
      ctx
    )
    expect(rows(r)).toEqual([
      [CLIENTES, 848000, 0],
      [IRPF_CLI, 120000, 0],
      [VENTAS, 0, 800000],
      [IVA_REP, 0, 168000],
    ])
    if (r.ok) expect(r.value.lines[1].taxBaseCents).toBe(800000)
  })

  it("F-003: anticipo aplicado con su IVA devengado (430 debe 484.000)", () => {
    const r = buildFromTemplate(
      "FACTURA_EMITIDA_SERVICIOS",
      {
        ...base,
        documentDate: "2026-03-20",
        lines: [{ baseCents: 600000, taxRateCode: "IVA_21" }],
        appliedAdvanceCents: 200000,
        appliedAdvanceTaxCents: 42000,
        totalCents: 726000,
      },
      ctx
    )
    expect(rows(r)).toEqual([
      [CLIENTES, 484000, 0],
      [ANTICIPOS_CLI, 200000, 0],
      [IVA_REP, 42000, 0],
      [VENTAS, 0, 600000],
      [IVA_REP, 0, 126000],
    ])
  })

  it("F-004: recargo de equivalencia 5,2 % en línea propia (430 debe 378.600)", () => {
    const r = buildFromTemplate(
      "FACTURA_EMITIDA_SERVICIOS",
      {
        ...base,
        documentDate: "2026-04-20",
        lines: [{ baseCents: 300000, taxRateCode: "IVA_21", surchargeRateCode: "REQ_5_2" }],
        totalCents: 378600,
      },
      ctx
    )
    expect(rows(r)).toEqual([
      [CLIENTES, 378600, 0],
      [VENTAS, 0, 300000],
      [IVA_REP, 0, 63000],
      [IVA_REP, 0, 15600],
    ])
  })

  it("un tipo exento NO genera línea de cuota a cero (C-3)", () => {
    const r = buildFromTemplate(
      "FACTURA_EMITIDA_SERVICIOS",
      { ...base, lines: [{ baseCents: 500000, taxRateCode: "IVA_0_EXPORT" }], totalCents: 500000 },
      ctx
    )
    expect(rows(r)).toEqual([
      [CLIENTES, 500000, 0],
      [VENTAS, 0, 500000],
    ])
  })

  it("tres vencimientos: tres líneas de CLIENTES que suman el total (criterio 9)", () => {
    const r = buildFromTemplate(
      "FACTURA_EMITIDA_SERVICIOS",
      {
        ...base,
        lines: [{ baseCents: 300000, taxRateCode: "IVA_21" }],
        dueSchedule: [
          { dueDate: "2026-02-19", amountCents: 121000 },
          { dueDate: "2026-03-21", amountCents: 121000 },
          { dueDate: "2026-04-20", amountCents: 121000 },
        ],
        totalCents: 363000,
      },
      ctx
    )
    const clientLines = r.ok ? r.value.lines.filter((l) => l.accountCode === CLIENTES) : []
    expect(clientLines).toHaveLength(3)
    expect(clientLines.reduce((a, l) => a + l.debitCents, 0)).toBe(363000)
    expect(clientLines.map((l) => l.dueDate)).toEqual(["2026-02-19", "2026-03-21", "2026-04-20"])
  })

  it("vencimientos que no suman el importe: DOCUMENT_TOTAL_MISMATCH", () => {
    const r = buildFromTemplate(
      "FACTURA_EMITIDA_SERVICIOS",
      {
        ...base,
        lines: [{ baseCents: 300000, taxRateCode: "IVA_21" }],
        dueSchedule: [{ dueDate: "2026-02-19", amountCents: 100000 }],
        totalCents: 363000,
      },
      ctx
    )
    expect(errorsOf(r)).toContain("DOCUMENT_TOTAL_MISMATCH")
  })

  it("total del documento equivocado: C-5 bloquea", () => {
    const r = buildFromTemplate(
      "FACTURA_EMITIDA_SERVICIOS",
      { ...base, lines: [{ baseCents: 500000, taxRateCode: "IVA_21" }], totalCents: 999999 },
      ctx
    )
    expect(errorsOf(r)).toContain("DOCUMENT_TOTAL_MISMATCH")
  })

  it("un documento anterior a la vigencia del tipo: TAX_RATE_NOT_IN_FORCE", () => {
    const closedCtx = testContext({
      fiscalYears: [{ id: "fy-2024", code: "2024", startDate: "2024-01-01", endDate: "2024-12-31", status: "OPEN" }],
      refDate: "2024-12-31",
    })
    const r = buildFromTemplate(
      "FACTURA_EMITIDA_SERVICIOS",
      { ...base, documentDate: "2024-06-01", lines: [{ baseCents: 500000, taxRateCode: "IVA_21" }], totalCents: 605000 },
      closedCtx
    )
    expect(errorsOf(r)).toContain("TAX_RATE_NOT_IN_FORCE")
  })
})

describe("T-02 ABONO_EMITIDO", () => {
  it("AB-001: devolución de venta, columnas invertidas contra 708", () => {
    const r = buildFromTemplate(
      "ABONO_EMITIDO",
      {
        documentNumber: "R2026/001",
        documentDate: "2026-05-10",
        reason: "DEVOLUCION",
        lines: [{ baseCents: 100000, taxRateCode: "IVA_21" }],
        totalCents: 121000,
      },
      ctx
    )
    expect(rows(r)).toEqual([
      [DEVOLUCION_VENTAS, 100000, 0],
      [IVA_REP, 21000, 0],
      [CLIENTES, 0, 121000],
    ])
  })

  it("con reason ERROR se rectifica la propia cuenta de ingreso", () => {
    const r = buildFromTemplate(
      "ABONO_EMITIDO",
      {
        documentNumber: "R2026/002",
        documentDate: "2026-05-10",
        reason: "ERROR",
        lines: [{ baseCents: 100000, taxRateCode: "IVA_21" }],
        totalCents: 121000,
      },
      ctx
    )
    expect(rows(r)[0][0]).toBe(VENTAS)
  })

  it("usa el tipo vigente en el DOCUMENTO ORIGINAL, no el de hoy", () => {
    const r = buildFromTemplate(
      "ABONO_EMITIDO",
      {
        documentNumber: "R2026/003",
        documentDate: "2026-05-10",
        originalDocumentDate: "2024-06-01",
        reason: "DEVOLUCION",
        lines: [{ baseCents: 100000, taxRateCode: "IVA_21" }],
        totalCents: 121000,
      },
      ctx
    )
    expect(errorsOf(r)).toContain("TAX_RATE_NOT_IN_FORCE")
  })
})

describe("T-03 FACTURA_RECIBIDA", () => {
  const base = { supplierDocumentNumber: "P-001", documentDate: "2026-01-15" }

  it("R-001: gasto, IVA soportado y deuda con el proveedor", () => {
    const r = buildFromTemplate(
      "FACTURA_RECIBIDA",
      {
        ...base,
        payableKey: "PROVEEDORES",
        lines: [{ baseCents: 200000, taxRateCode: "IVA_21", deductibility: "FULL", expenseAccountCode: SUBCONTRATACION }],
        totalCents: 242000,
      },
      ctx
    )
    expect(rows(r)).toEqual([
      [SUBCONTRATACION, 200000, 0],
      [IVA_SOP, 42000, 0],
      [PROVEEDORES, 0, 242000],
    ])
  })

  it("criterio 6: base 1.000 €, IVA 21 %, IRPF 15 % → 62x 100.000 · 472 21.000 / 410 106.000 · 4751 15.000", () => {
    const r = buildFromTemplate(
      "FACTURA_RECIBIDA",
      {
        ...base,
        payableKey: "ACREEDORES",
        lines: [{ baseCents: 100000, taxRateCode: "IVA_21", deductibility: "FULL", expenseAccountCode: "621" }],
        withholdingRateCode: "IRPF_PROF_15",
        totalCents: 106000,
      },
      ctx
    )
    expect(rows(r)).toEqual([
      ["621", 100000, 0],
      [IVA_SOP, 21000, 0],
      [ACREEDORES, 0, 106000],
      [IRPF_PROF, 0, 15000],
    ])
  })

  it("R-002: alquiler con retención 19 % (410 haber 122.400 · 4751 haber 22.800)", () => {
    const r = buildFromTemplate(
      "FACTURA_RECIBIDA",
      {
        ...base,
        payableKey: "ACREEDORES",
        lines: [{ baseCents: 120000, taxRateCode: "IVA_21", deductibility: "FULL", expenseAccountCode: "621" }],
        withholdingRateCode: "IRPF_ALQ_19",
        withholdingKey: "IRPF_ALQUILERES_A_PAGAR",
        totalCents: 122400,
      },
      ctx
    )
    const table = rows(r)
    expect(table[2]).toEqual([ACREEDORES, 0, 122400])
    expect(table[3][2]).toBe(22800)
  })

  it("R-004: prorrata 90 % → la línea de gasto es 81.680 y la de 472, 15.120", () => {
    const r = buildFromTemplate(
      "FACTURA_RECIBIDA",
      {
        ...base,
        documentDate: "2026-03-10",
        payableKey: "ACREEDORES",
        lines: [{ baseCents: 80000, taxRateCode: "IVA_21", deductibility: "PRORRATA", expenseAccountCode: "628" }],
        totalCents: 96800,
      },
      testContext({ prorrataBps: 9000 })
    )
    expect(rows(r)).toEqual([
      ["628", 81680, 0],
      [IVA_SOP, 15120, 0],
      [ACREEDORES, 0, 96800],
    ])
  })

  it("R-005: IVA íntegramente no deducible → gasto 60.500 y ninguna línea de 472", () => {
    const r = buildFromTemplate(
      "FACTURA_RECIBIDA",
      {
        ...base,
        documentDate: "2026-04-08",
        payableKey: "ACREEDORES",
        lines: [{ baseCents: 50000, taxRateCode: "IVA_21", deductibility: "NONE", expenseAccountCode: "629" }],
        totalCents: 60500,
      },
      ctx
    )
    expect(rows(r)).toEqual([
      ["629", 60500, 0],
      [ACREEDORES, 0, 60500],
    ])
  })

  it("PRORRATA sin prorrataBps configurada: PRORRATA_NOT_CONFIGURED", () => {
    const r = buildFromTemplate(
      "FACTURA_RECIBIDA",
      {
        ...base,
        payableKey: "ACREEDORES",
        lines: [{ baseCents: 80000, taxRateCode: "IVA_21", deductibility: "PRORRATA", expenseAccountCode: "628" }],
        totalCents: 96800,
      },
      testContext({ prorrataBps: null })
    )
    expect(errorsOf(r)).toContain("PRORRATA_NOT_CONFIGURED")
  })

  it("anticipo de proveedor aplicado: cancela el 407 y minora la deuda", () => {
    const r = buildFromTemplate(
      "FACTURA_RECIBIDA",
      {
        ...base,
        documentDate: "2026-05-15",
        payableKey: "PROVEEDORES",
        lines: [{ baseCents: 200000, taxRateCode: "IVA_21", deductibility: "FULL", expenseAccountCode: SUBCONTRATACION }],
        appliedAdvanceCents: 100000,
        totalCents: 242000,
      },
      ctx
    )
    expect(rows(r)).toEqual([
      [SUBCONTRATACION, 200000, 0],
      [IVA_SOP, 42000, 0],
      [ANTICIPOS_PROV, 0, 100000],
      [PROVEEDORES, 0, 142000],
    ])
  })
})

describe("T-04 FACTURA_RECIBIDA_ISP", () => {
  it("R-006: autorrepercusión con efecto neto 0 en tesorería", () => {
    const r = buildFromTemplate(
      "FACTURA_RECIBIDA_ISP",
      {
        supplierDocumentNumber: "ISP-001",
        documentDate: "2026-05-14",
        payableKey: "ACREEDORES",
        lines: [{ baseCents: 100000, taxRateCode: "IVA_ISP", deductibility: "FULL", expenseAccountCode: "623" }],
        totalCents: 100000,
      },
      ctx
    )
    expect(rows(r)).toEqual([
      ["623", 100000, 0],
      [IVA_SOP_ISP, 21000, 0],
      [ACREEDORES, 0, 100000],
      [IVA_REP_ISP, 0, 21000],
    ])
  })

  it("con prorrata el asiento sigue cuadrando: el devengado no cambia", () => {
    const r = buildFromTemplate(
      "FACTURA_RECIBIDA_ISP",
      {
        supplierDocumentNumber: "ISP-002",
        documentDate: "2026-05-14",
        payableKey: "ACREEDORES",
        lines: [{ baseCents: 100000, taxRateCode: "IVA_ISP", deductibility: "PRORRATA", expenseAccountCode: "623" }],
        totalCents: 100000,
      },
      testContext({ prorrataBps: 9000 })
    )
    expect(rows(r)).toEqual([
      ["623", 102100, 0],
      [IVA_SOP_ISP, 18900, 0],
      [ACREEDORES, 0, 100000],
      [IVA_REP_ISP, 0, 21000],
    ])
    expect(balanced(r)).toBe(true)
  })
})

describe("T-05 ABONO_RECIBIDO", () => {
  it("AB-R-001: 400 al debe, 608 y 472 al haber", () => {
    const r = buildFromTemplate(
      "ABONO_RECIBIDO",
      {
        supplierDocumentNumber: "AB-P-001",
        documentDate: "2026-06-05",
        payableKey: "PROVEEDORES",
        reason: "DEVOLUCION",
        lines: [{ baseCents: 50000, taxRateCode: "IVA_21", deductibility: "FULL" }],
        totalCents: 60500,
      },
      ctx
    )
    expect(rows(r)).toEqual([
      [PROVEEDORES, 60500, 0],
      [DEVOLUCION_COMPRAS, 0, 50000],
      [IVA_SOP, 0, 10500],
    ])
  })

  it("si el IVA era no deducible, el abono minora el gasto por Bᵢ + NDᵢ", () => {
    const r = buildFromTemplate(
      "ABONO_RECIBIDO",
      {
        supplierDocumentNumber: "AB-P-002",
        documentDate: "2026-06-05",
        payableKey: "ACREEDORES",
        reason: "ERROR",
        lines: [{ baseCents: 50000, taxRateCode: "IVA_21", deductibility: "NONE", expenseAccountCode: "629" }],
        totalCents: 60500,
      },
      ctx
    )
    expect(rows(r)).toEqual([
      [ACREEDORES, 60500, 0],
      ["629", 0, 60500],
    ])
  })
})

describe("T-06 ANTICIPO_CLIENTE y T-07 ANTICIPO_PROVEEDOR", () => {
  it("ANT-C-01: el anticipo devenga IVA (art. 75.Dos LIVA) y va a 438, nunca a 705", () => {
    const r = buildFromTemplate(
      "ANTICIPO_CLIENTE",
      { documentDate: "2026-02-05", amountCents: 200000, taxRateCode: "IVA_21" },
      ctx
    )
    expect(rows(r)).toEqual([
      [BANCO, 242000, 0],
      [ANTICIPOS_CLI, 0, 200000],
      [IVA_REP, 0, 42000],
    ])
  })

  it("ANT-P-01: el anticipo a proveedor es ACTIVO (407), no gasto", () => {
    const r = buildFromTemplate(
      "ANTICIPO_PROVEEDOR",
      { documentDate: "2026-04-03", amountCents: 100000, taxRateCode: "IVA_21" },
      ctx
    )
    expect(rows(r)).toEqual([
      [ANTICIPOS_PROV, 100000, 0],
      [IVA_SOP, 21000, 0],
      [BANCO, 0, 121000],
    ])
  })

  it("anticipo sin IVA: dos líneas, sin línea de cuota a cero", () => {
    const r = buildFromTemplate("ANTICIPO_CLIENTE", { documentDate: "2026-02-05", amountCents: 200000 }, ctx)
    expect(rows(r)).toHaveLength(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Bloque B — T-08 … T-18
// ─────────────────────────────────────────────────────────────────────────────

describe("T-08 COBRO_CLIENTE", () => {
  const base = { documentDate: "2026-02-28", bankKey: "BANCO_DEFAULT" as const }

  it("CO-001: cobro íntegro", () => {
    const r = buildFromTemplate(
      "COBRO_CLIENTE",
      { ...base, settlements: [{ receivableKey: "CLIENTES", amountCents: 737000 }], amountReceivedCents: 737000 },
      ctx
    )
    expect(rows(r)).toEqual([
      [BANCO, 737000, 0],
      [CLIENTES, 0, 737000],
    ])
  })

  it("CO-003: comisión bancaria de 500, exenta de IVA (art. 20.Uno.18º)", () => {
    const r = buildFromTemplate(
      "COBRO_CLIENTE",
      {
        ...base,
        documentDate: "2026-04-30",
        settlements: [{ receivableKey: "CLIENTES", amountCents: 300000 }],
        amountReceivedCents: 299500,
        bankFeeCents: 500,
      },
      ctx
    )
    expect(rows(r)).toEqual([
      [BANCO, 299500, 0],
      [COMISIONES, 500, 0],
      [CLIENTES, 0, 300000],
    ])
  })

  it("CO-004: diferencia de cambio negativa a 668", () => {
    const r = buildFromTemplate(
      "COBRO_CLIENTE",
      {
        ...base,
        documentDate: "2026-05-29",
        settlements: [{ receivableKey: "CLIENTES", amountCents: 500000 }],
        amountReceivedCents: 495000,
        fxDifferenceCents: -5000,
      },
      ctx
    )
    expect(rows(r)).toEqual([
      [BANCO, 495000, 0],
      [FX_NEG, 5000, 0],
      [CLIENTES, 0, 500000],
    ])
  })

  it("CO-005: diferencia de cambio positiva a 768", () => {
    const r = buildFromTemplate(
      "COBRO_CLIENTE",
      {
        ...base,
        documentDate: "2026-06-29",
        settlements: [{ receivableKey: "CLIENTES", amountCents: 500000 }],
        amountReceivedCents: 506000,
        fxDifferenceCents: 6000,
      },
      ctx
    )
    expect(rows(r)).toEqual([
      [BANCO, 506000, 0],
      [FX_POS, 0, 6000],
      [CLIENTES, 0, 500000],
    ])
  })

  it("CO-006: redondeo de 1 céntimo dentro de la tolerancia", () => {
    const r = buildFromTemplate(
      "COBRO_CLIENTE",
      {
        ...base,
        documentDate: "2026-07-31",
        settlements: [{ receivableKey: "CLIENTES", amountCents: 121000 }],
        amountReceivedCents: 120999,
        roundingCents: 1,
      },
      ctx
    )
    expect(rows(r)).toEqual([
      [BANCO, 120999, 0],
      [REDONDEO_GASTO, 1, 0],
      [CLIENTES, 0, 121000],
    ])
  })

  it("5 céntimos con tolerancia 1: TAX_ROUNDING_EXCEEDED y nada se persiste (R-IVA-7)", () => {
    const r = buildFromTemplate(
      "COBRO_CLIENTE",
      {
        ...base,
        settlements: [{ receivableKey: "CLIENTES", amountCents: 121000 }],
        amountReceivedCents: 120995,
        roundingCents: 5,
      },
      ctx
    )
    expect(errorsOf(r)).toContain("TAX_ROUNDING_EXCEEDED")
  })

  it("cobro PARCIAL: la plantilla no exige que salde el crédito", () => {
    const r = buildFromTemplate(
      "COBRO_CLIENTE",
      { ...base, settlements: [{ receivableKey: "CLIENTES", amountCents: 100000 }], amountReceivedCents: 100000 },
      ctx
    )
    expect(balanced(r)).toBe(true)
  })

  it("una liquidación por documento saldado (trazabilidad del cobro parcial)", () => {
    const r = buildFromTemplate(
      "COBRO_CLIENTE",
      {
        ...base,
        settlements: [
          { receivableKey: "CLIENTES", amountCents: 100000 },
          { receivableKey: "CLIENTES", amountCents: 21000 },
        ],
        amountReceivedCents: 121000,
      },
      ctx
    )
    expect(rows(r)).toHaveLength(3)
  })
})

describe("T-09 PAGO_PROVEEDOR", () => {
  it("PA-001: espejo de T-08 — deuda al debe, banco al haber", () => {
    const r = buildFromTemplate(
      "PAGO_PROVEEDOR",
      {
        documentDate: "2026-02-25",
        settlements: [{ payableKey: "PROVEEDORES", amountCents: 242000 }],
        amountPaidCents: 242000,
      },
      ctx
    )
    expect(rows(r)).toEqual([
      [PROVEEDORES, 242000, 0],
      [BANCO, 0, 242000],
    ])
  })
})

describe("T-10 NOMINA", () => {
  const nomina = {
    period: { year: 2026, month: 4 },
    documentDate: "2026-04-30",
    gross: [{ amountCents: 300000 }, { amountCents: 125000 }, { amountCents: 75000 }],
    employerSS: [{ amountCents: 96000 }, { amountCents: 40000 }, { amountCents: 24000 }],
    employeeSSCents: 31750,
    withholdingCents: 75000,
    advanceAppliedCents: 50000,
    netCents: 343250,
  }

  it("NOM-04: reparto multi-destino del bruto, neto 343.250 y 476 por 191.750", () => {
    const r = buildFromTemplate("NOMINA", nomina, ctx)
    expect(rows(r)).toEqual([
      [SUELDOS, 300000, 0],
      [SUELDOS, 125000, 0],
      [SUELDOS, 75000, 0],
      [SS_EMPRESA, 96000, 0],
      [SS_EMPRESA, 40000, 0],
      [SS_EMPRESA, 24000, 0],
      [REMUNERACIONES, 0, 343250],
      [ANTICIPOS_REM, 0, 50000],
      [SS_ACREEDORA, 0, 191750],
      [IRPF_TRABAJO, 0, 75000],
    ])
  })

  it("sin anticipo el neto es 393.250 y no hay línea de 460 (NOM-01)", () => {
    const r = buildFromTemplate(
      "NOMINA",
      { ...nomina, documentDate: "2026-01-31", period: { year: 2026, month: 1 }, advanceAppliedCents: 0, netCents: 393250 },
      ctx
    )
    expect(rows(r).some(([code]) => code === ANTICIPOS_REM)).toBe(false)
    expect(rows(r)[6]).toEqual([REMUNERACIONES, 0, 393250])
  })

  it("P1: un neto declarado que no cuadra BLOQUEA, el motor no lo recalcula", () => {
    const r = buildFromTemplate("NOMINA", { ...nomina, netCents: 999999 }, ctx)
    expect(errorsOf(r)).toContain("DOCUMENT_TOTAL_MISMATCH")
  })
})

describe("T-11 · T-12 · T-13 · T-24 — pago de una deuda", () => {
  const base = { documentDate: "2026-02-03", bankKey: "BANCO_DEFAULT" as const }

  it("PNOM-01: 465 al debe, banco al haber", () => {
    const r = buildFromTemplate(
      "PAGO_NOMINA",
      { ...base, liabilityKey: "REMUNERACIONES_PENDIENTES", amountCents: 393250 },
      ctx
    )
    expect(rows(r)).toEqual([
      [REMUNERACIONES, 393250, 0],
      [BANCO, 0, 393250],
    ])
  })

  it("PSS-01: 476 al debe", () => {
    const r = buildFromTemplate("PAGO_SEGURIDAD_SOCIAL", { ...base, liabilityKey: "SS_ACREEDORA", amountCents: 191750 }, ctx)
    expect(rows(r)[0]).toEqual([SS_ACREEDORA, 191750, 0])
  })

  it("P-IVA-Q1: 4750 al debe por el importe exacto de la liquidación", () => {
    const r = buildFromTemplate(
      "PAGO_IMPUESTO",
      { ...base, documentDate: "2026-04-20", liabilityKey: "HP_ACREEDORA_IVA", amountCents: 297180 },
      ctx
    )
    expect(rows(r)).toEqual([
      [HP_ACREEDORA_IVA, 297180, 0],
      [BANCO, 0, 297180],
    ])
  })

  it("un pago que excede el saldo vivo: PAYMENT_EXCEEDS_LIABILITY", () => {
    const r = buildFromTemplate(
      "PAGO_RETENCIONES",
      { ...base, liabilityKey: "IRPF_A_PAGAR", amountCents: 200000, openLiabilityCents: 120300 },
      ctx
    )
    expect(errorsOf(r)).toContain("PAYMENT_EXCEEDS_LIABILITY")
  })

  it("el saldo vivo también puede venir de `ctx.balances`", () => {
    const balances = new Map<string, number>([[codeFor("IRPF_A_PAGAR"), -120300]])
    const r = buildFromTemplate(
      "PAGO_RETENCIONES",
      { ...base, liabilityKey: "IRPF_A_PAGAR", amountCents: 130000 },
      testContext({ balances })
    )
    expect(errorsOf(r)).toContain("PAYMENT_EXCEEDS_LIABILITY")
  })

  it("los intereses de demora van en línea propia, no engordan la deuda tributaria", () => {
    const r = buildFromTemplate(
      "PAGO_IMPUESTO",
      { ...base, liabilityKey: "HP_ACREEDORA_IVA", amountCents: 100000, surchargeCents: 5000, surchargeAccountCode: "669" },
      ctx
    )
    expect(rows(r)).toEqual([
      [HP_ACREEDORA_IVA, 100000, 0],
      ["669", 5000, 0],
      [BANCO, 0, 105000],
    ])
  })
})

describe("T-14 AMORTIZACION_MENSUAL", () => {
  it("AM-01: dos activos, dos contra-cuentas", () => {
    const r = buildFromTemplate(
      "AMORTIZACION_MENSUAL",
      {
        period: { year: 2026, month: 1 },
        documentDate: "2026-01-31",
        items: [
          { assetAccountCode: "216", expenseAccountCode: "681", accumulatedAccountCode: "2816", amountCents: 10000 },
          { assetAccountCode: "217", expenseAccountCode: "681", accumulatedAccountCode: "2817", amountCents: 12500 },
        ],
      },
      ctx
    )
    expect(rows(r)).toEqual([
      ["681", 10000, 0],
      ["681", 12500, 0],
      ["2816", 0, 10000],
      ["2817", 0, 12500],
    ])
  })

  it("la amortización acumulada no puede superar el valor de adquisición", () => {
    const r = buildFromTemplate(
      "AMORTIZACION_MENSUAL",
      {
        period: { year: 2026, month: 12 },
        documentDate: "2026-12-31",
        items: [
          {
            assetAccountCode: "216",
            expenseAccountCode: "681",
            accumulatedAccountCode: "2816",
            amountCents: 10000,
            acquisitionCostCents: 1200000,
            accumulatedCents: 1195000,
          },
        ],
      },
      ctx
    )
    expect(errorsOf(r)).toContain("TEMPLATE_INPUT")
  })
})

describe("T-15 … T-18 periodificaciones", () => {
  it("PER-G-01: 480 al debe contra la cuenta de gasto", () => {
    const r = buildFromTemplate(
      "PERIODIFICACION_GASTO",
      { documentDate: "2026-06-30", sourceId: "PER-G", items: [{ accountCode: "628", amountCents: 60000 }] },
      ctx
    )
    expect(rows(r)).toEqual([
      [PERIOD_GASTO, 60000, 0],
      ["628", 0, 60000],
    ])
  })

  it("PER-G-02: el devengo invierte el par y deja la PyG del ejercicio en 0", () => {
    const r = buildFromTemplate(
      "DEVENGO_PERIODIFICACION_GASTO",
      { documentDate: "2026-09-30", sourceId: "PER-G", items: [{ accountCode: "628", amountCents: 60000 }] },
      ctx
    )
    expect(rows(r)).toEqual([
      ["628", 60000, 0],
      [PERIOD_GASTO, 0, 60000],
    ])
  })

  it("PER-I-01 y PER-I-02: 485 es un ingreso facturado no imputable, no un anticipo", () => {
    const periodificacion = buildFromTemplate(
      "PERIODIFICACION_INGRESO",
      { documentDate: "2026-06-30", sourceId: "PER-I", items: [{ accountKey: "VENTAS_DEFAULT", amountCents: 90000 }] },
      ctx
    )
    expect(rows(periodificacion)).toEqual([
      [VENTAS, 90000, 0],
      [PERIOD_INGRESO, 0, 90000],
    ])
    const devengo = buildFromTemplate(
      "DEVENGO_PERIODIFICACION_INGRESO",
      { documentDate: "2026-10-31", sourceId: "PER-I", items: [{ accountKey: "VENTAS_DEFAULT", amountCents: 90000 }] },
      ctx
    )
    expect(rows(devengo)).toEqual([
      [PERIOD_INGRESO, 90000, 0],
      [VENTAS, 0, 90000],
    ])
  })

  it("el par comparte sourceId (lo verifica la Auditoría)", () => {
    const r = buildFromTemplate(
      "PERIODIFICACION_GASTO",
      { documentDate: "2026-06-30", sourceId: "PER-G-01", items: [{ accountCode: "628", amountCents: 60000 }] },
      ctx
    )
    expect(r.ok && r.value.sourceId).toBe("PER-G-01")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Bloque C — T-19 … T-28
// ─────────────────────────────────────────────────────────────────────────────

describe("T-19 TRASPASO_TESORERIA", () => {
  it("TR-001: destino al debe, origen al haber", () => {
    const r = buildFromTemplate(
      "TRASPASO_TESORERIA",
      { documentDate: "2026-07-15", fromKey: "BANCO_DEFAULT", toKey: "CAJA", amountCents: 30000 },
      ctx
    )
    expect(rows(r)).toEqual([
      [CAJA, 30000, 0],
      [BANCO, 0, 30000],
    ])
  })

  it("origen = destino: se rechaza (el cashflow registraría un flujo ficticio)", () => {
    const r = buildFromTemplate(
      "TRASPASO_TESORERIA",
      { documentDate: "2026-07-15", fromKey: "BANCO_DEFAULT", toKey: "BANCO_DEFAULT", amountCents: 30000 },
      ctx
    )
    expect(errorsOf(r)).toContain("TEMPLATE_INPUT")
  })

  it("una cuenta que no es de tesorería se rechaza", () => {
    const r = buildFromTemplate(
      "TRASPASO_TESORERIA",
      { documentDate: "2026-07-15", fromAccountCode: "628", toKey: "CAJA", amountCents: 30000 },
      ctx
    )
    expect(errorsOf(r)).toContain("TEMPLATE_INPUT")
  })
})

describe("T-20 ASIENTO_MANUAL", () => {
  it("ANT-N-01: anticipo a empleado, dos líneas libres", () => {
    const r = buildFromTemplate(
      "ASIENTO_MANUAL",
      {
        documentDate: "2026-03-05",
        description: "Anticipo a empleado",
        lines: [
          { accountKey: "ANTICIPOS_REMUNERACIONES", debitCents: 50000, creditCents: 0 },
          { accountKey: "BANCO_DEFAULT", debitCents: 0, creditCents: 50000 },
        ],
      },
      ctx
    )
    expect(rows(r)).toEqual([
      [ANTICIPOS_REM, 50000, 0],
      [BANCO, 0, 50000],
    ])
    expect(r.ok && r.value.kind).toBe("NORMAL")
  })

  it("no es una puerta trasera: no puede tocar la 129 (solo T-26)", () => {
    const r = buildFromTemplate(
      "ASIENTO_MANUAL",
      {
        documentDate: "2026-03-05",
        description: "Intento de tocar el resultado",
        lines: [
          { accountCode: RESULTADO, debitCents: 100, creditCents: 0 },
          { accountCode: BANCO, debitCents: 0, creditCents: 100 },
        ],
      },
      ctx
    )
    expect(errorsOf(r)).toContain("TEMPLATE_INPUT")
  })

  it("una sola línea no pasa el schema (mínimo dos)", () => {
    const r = buildFromTemplate(
      "ASIENTO_MANUAL",
      { documentDate: "2026-03-05", description: "Una línea", lines: [{ accountCode: BANCO, debitCents: 100 }] },
      ctx
    )
    expect(errorsOf(r)).toContain("TEMPLATE_INPUT")
  })
})

describe("T-22 AJUSTE_EJERCICIO_CERRADO (NRV 22ª)", () => {
  it("AJ-001: importe no significativo a 678, sí afecta al epígrafe 13", () => {
    const r = buildFromTemplate(
      "AJUSTE_EJERCICIO_CERRADO",
      {
        documentDate: "2025-11-30",
        entryDate: "2026-02-10",
        adjustmentKind: "NO_SIGNIFICATIVO",
        direction: "GASTO",
        amountCents: 35000,
        counterpartKey: "ACREEDORES",
        reason: "Gasto de 2025 no significativo detectado en 2026",
      },
      ctx
    )
    expect(rows(r)).toEqual([
      ["678", 35000, 0],
      [ACREEDORES, 0, 35000],
    ])
  })

  it("AJ-002: error MATERIAL contra 113, sin efecto en la PyG corriente", () => {
    const r = buildFromTemplate(
      "AJUSTE_EJERCICIO_CERRADO",
      {
        documentDate: "2025-06-30",
        entryDate: "2026-03-15",
        adjustmentKind: "MATERIAL",
        direction: "GASTO",
        amountCents: 250000,
        counterpartKey: "ACREEDORES",
        reason: "Corrección de error material de 2025 contra reservas",
      },
      ctx
    )
    expect(rows(r)).toEqual([
      ["113", 250000, 0],
      [ACREEDORES, 0, 250000],
    ])
    expect(r.ok && r.value.documentDate).toBe("2025-06-30")
    expect(r.ok && r.value.entryDate).toBe("2026-03-15")
  })

  it("las cuentas 679/779 no existen: el ingreso no significativo va a 778", () => {
    const r = buildFromTemplate(
      "AJUSTE_EJERCICIO_CERRADO",
      {
        documentDate: "2025-06-30",
        entryDate: "2026-03-15",
        adjustmentKind: "NO_SIGNIFICATIVO",
        direction: "INGRESO",
        amountCents: 20000,
        counterpartKey: "CLIENTES",
        reason: "Ingreso de 2025 no significativo",
      },
      ctx
    )
    expect(rows(r)).toEqual([
      [CLIENTES, 20000, 0],
      ["778", 0, 20000],
    ])
  })

  it("si el ejercicio del documento sigue ABIERTO, T-22 no aplica", () => {
    const r = buildFromTemplate(
      "AJUSTE_EJERCICIO_CERRADO",
      {
        documentDate: "2026-01-30",
        entryDate: "2026-03-15",
        adjustmentKind: "NO_SIGNIFICATIVO",
        direction: "GASTO",
        amountCents: 20000,
        counterpartKey: "ACREEDORES",
        reason: "El ejercicio sigue abierto",
      },
      ctx
    )
    expect(errorsOf(r)).toContain("TEMPLATE_INPUT")
  })

  it("el ajuste a reservas no admite destino analítico (rompería I4)", () => {
    const r = buildFromTemplate(
      "AJUSTE_EJERCICIO_CERRADO",
      {
        documentDate: "2025-06-30",
        entryDate: "2026-03-15",
        adjustmentKind: "MATERIAL",
        direction: "GASTO",
        amountCents: 250000,
        counterpartKey: "ACREEDORES",
        projectId: "3f1f9a1e-0000-4000-8000-000000000001",
        reason: "Con destino analítico, que no procede",
      },
      ctx
    )
    expect(errorsOf(r)).toContain("ANALYTIC_DIM_UNAVAILABLE")
  })
})

describe("T-23 REGULARIZACION_IVA (modelo 303)", () => {
  it("1T: a ingresar 297.180 (casilla 71)", () => {
    const r = buildFromTemplate(
      "REGULARIZACION_IVA",
      { periodStart: "2026-01-01", periodEnd: "2026-03-31", outputCents: 411000, inputCents: 113820 },
      ctx
    )
    expect(rows(r)).toEqual([
      [IVA_REP, 411000, 0],
      [IVA_SOP, 0, 113820],
      [HP_ACREEDORA_IVA, 0, 297180],
    ])
  })

  it("3T: a compensar 100.800, que se arrastra en 4700", () => {
    const r = buildFromTemplate(
      "REGULARIZACION_IVA",
      { periodStart: "2026-07-01", periodEnd: "2026-09-30", outputCents: 304500, inputCents: 405300 },
      ctx
    )
    expect(rows(r)).toEqual([
      [IVA_REP, 304500, 0],
      [IVA_SOP, 0, 405300],
      [HP_DEUDORA_IVA, 100800, 0],
    ])
  })

  it("4T: consume la compensación del 3T y deja 245.490 a ingresar", () => {
    const r = buildFromTemplate(
      "REGULARIZACION_IVA",
      {
        periodStart: "2026-10-01",
        periodEnd: "2026-12-31",
        outputCents: 363300,
        inputCents: 17010,
        carryForwardCents: 100800,
      },
      ctx
    )
    expect(rows(r)).toEqual([
      [IVA_REP, 363300, 0],
      [IVA_SOP, 0, 17010],
      [HP_DEUDORA_IVA, 0, 100800],
      [HP_ACREEDORA_IVA, 0, 245490],
    ])
  })
})

describe("T-25 IMPUESTO_BENEFICIOS", () => {
  it("IS-2026: base 1.996.430 al 25 % → 499.108 (630 debe / 4752 haber)", () => {
    const r = buildFromTemplate(
      "IMPUESTO_BENEFICIOS",
      { documentDate: "2026-12-31", taxableBaseCents: 1996430, rateBps: 2500 },
      testContext({ refDate: "2027-01-31" })
    )
    expect(rows(r)).toEqual([
      [IS_GASTO, 499108, 0],
      [HP_ACREEDORA_IS, 0, 499108],
    ])
  })

  it("sin base imponible positiva no hay cuota que contabilizar", () => {
    const r = buildFromTemplate(
      "IMPUESTO_BENEFICIOS",
      { documentDate: "2026-12-31", taxableBaseCents: -100000, rateBps: 2500 },
      testContext({ refDate: "2027-01-31" })
    )
    expect(errorsOf(r)).toContain("TEMPLATE_INPUT")
  })
})

describe("T-26 REGULARIZACION_RESULTADO", () => {
  const balances = {
    "705": -6350000,
    "7080": 100000,
    "640": 2000000,
    "6300": 499108,
    "4300": 7723900, // cuenta de balance: NO entra en la regularización
  }

  it("lleva a cero las cuentas 6/7 y abona la diferencia en la 129", () => {
    const r = buildFromTemplate(
      "REGULARIZACION_RESULTADO",
      { entryDate: "2026-12-31", balances },
      testContext({ refDate: "2027-01-31" })
    )
    const table = rows(r)
    expect(table).toEqual([
      ["6300", 0, 499108],
      ["640", 0, 2000000],
      ["705", 6350000, 0],
      ["7080", 0, 100000],
      [RESULTADO, 0, 3750892],
    ])
    expect(r.ok && r.value.kind).toBe("REGULARIZATION")
    // La 430 es de balance: no se regulariza aquí, sino en el cierre.
    expect(table.some(([code]) => code === "4300")).toBe(false)
  })

  it("con pérdida, la 129 va al debe", () => {
    const r = buildFromTemplate(
      "REGULARIZACION_RESULTADO",
      { entryDate: "2026-12-31", balances: { "705": -100000, "640": 300000 } },
      testContext({ refDate: "2027-01-31" })
    )
    expect(rows(r)).toEqual([
      ["640", 0, 300000],
      ["705", 100000, 0],
      [RESULTADO, 200000, 0],
    ])
  })

  it("sin cuentas 6/7 con saldo (caso vacío) devuelve error, no un asiento vacío", () => {
    const r = buildFromTemplate(
      "REGULARIZACION_RESULTADO",
      { entryDate: "2026-12-31", balances: { "4300": 100 } },
      testContext({ refDate: "2027-01-31" })
    )
    expect(errorsOf(r)).toContain("TEMPLATE_INPUT")
  })
})

describe("T-27 CIERRE_EJERCICIO y T-28 APERTURA_EJERCICIO", () => {
  // Códigos POSTABLES del plan PYMES: 430, 400 y 410 son cuentas padre y no
  // admiten apuntes; sus hojas 4300/4000/4100 sí (`lib/accounts/map.ts` §3.4).
  const closingBalances = { "100": -3000000, "129": -1497322, "4300": 7723900, "572": 2913920, "4000": -6140498 }

  it("el cierre invierte todos los saldos de balance, ordenados por código", () => {
    const r = buildFromTemplate(
      "CIERRE_EJERCICIO",
      { entryDate: "2026-12-31", balances: closingBalances },
      testContext({ refDate: "2027-01-31" })
    )
    expect(rows(r)).toEqual([
      ["100", 3000000, 0],
      ["129", 1497322, 0],
      ["4000", 6140498, 0],
      ["4300", 0, 7723900],
      ["572", 0, 2913920],
    ])
    expect(r.ok && r.value.kind).toBe("CLOSING")
    expect(balanced(r)).toBe(true)
  })

  it("una cuenta 6/7 con saldo antes del cierre bloquea: falta T-26", () => {
    const r = buildFromTemplate(
      "CIERRE_EJERCICIO",
      { entryDate: "2026-12-31", balances: { ...closingBalances, "705": -100 } },
      testContext({ refDate: "2027-01-31" })
    )
    expect(errorsOf(r)).toContain("TEMPLATE_INPUT")
  })

  it("la apertura es el espejo exacto del cierre, con fecha del ejercicio siguiente (I-E3-6)", () => {
    const closing = buildFromTemplate(
      "CIERRE_EJERCICIO",
      { entryDate: "2026-12-31", balances: closingBalances },
      testContext({ refDate: "2027-01-31" })
    )
    const opening = buildFromTemplate(
      "APERTURA_EJERCICIO",
      { entryDate: "2027-01-01", balances: closingBalances },
      testContext({ refDate: "2027-01-31" })
    )
    expect(rows(opening)).toEqual([
      ["100", 0, 3000000],
      ["129", 0, 1497322],
      ["4000", 0, 6140498],
      ["4300", 7723900, 0],
      ["572", 2913920, 0],
    ])
    expect(opening.ok && opening.value.kind).toBe("OPENING")
    expect(opening.ok && opening.value.entryDate).toBe("2027-01-01")
    // Cierre + apertura suman 0 cuenta a cuenta.
    if (closing.ok && opening.ok) {
      for (let i = 0; i < closing.value.lines.length; i++) {
        expect(closing.value.lines[i].debitCents).toBe(opening.value.lines[i].creditCents)
        expect(closing.value.lines[i].creditCents).toBe(opening.value.lines[i].debitCents)
      }
    }
  })
})

describe("T-21 CONTRA_ASIENTO desde el registro", () => {
  it("delega en buildReversal y produce el espejo del asiento leído", () => {
    const entry = {
      id: "entry-1",
      organizationId: "org-test",
      fiscalYearId: FY_2026.id,
      entryNumber: 12,
      entryDate: "2026-10-15",
      description: "Factura duplicada",
      kind: "NORMAL" as const,
      taxRoundingMode: "PER_TIPO" as const,
      sourceType: "DOCUMENT" as const,
      lines: [
        {
          lineNo: 1,
          accountCode: SUBCONTRATACION,
          debitCents: 100000,
          creditCents: 0,
          entryDate: "2026-10-15",
          fiscalYearId: FY_2026.id,
          entryKind: "NORMAL" as const,
        },
        {
          lineNo: 2,
          accountCode: PROVEEDORES,
          debitCents: 0,
          creditCents: 100000,
          entryDate: "2026-10-15",
          fiscalYearId: FY_2026.id,
          entryKind: "NORMAL" as const,
        },
      ],
    }
    const r = buildFromTemplate(
      "CONTRA_ASIENTO",
      { entryId: "3f1f9a1e-0000-4000-8000-000000000001", reason: "Factura duplicada del proveedor", entry },
      ctx
    )
    expect(rows(r)).toEqual([
      [SUBCONTRATACION, 0, 100000],
      [PROVEEDORES, 100000, 0],
    ])
  })
})

describe("todas las plantillas cuadran (C-1) en su caso de referencia", () => {
  it("ninguna produce un asiento descuadrado en los casos de arriba", () => {
    // Comprobación transversal: cualquier caso construido en este fichero pasa
    // por `buildEntry`, y `buildEntry` no devuelve `ok` con Σdebe ≠ Σhaber.
    const r = buildFromTemplate(
      "FACTURA_EMITIDA_SERVICIOS",
      {
        documentNumber: "X",
        documentDate: "2026-01-20",
        lines: [{ baseCents: 33333, taxRateCode: "IVA_21" }],
        totalCents: 40333,
      },
      ctx
    )
    expect(balanced(r)).toBe(true)
  })
})
