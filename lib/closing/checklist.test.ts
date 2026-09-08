/**
 * E9 · T13 — El checklist del cierre, paso a paso.
 *
 * Lo que estos tests fijan no es «que devuelve algo», sino las cuatro reglas que
 * hacen que un cierre sea firmable:
 *
 *  1. **Siempre los mismos pasos**, en el mismo orden y con los **nueve
 *     bloqueantes** que §4.8 nombra uno a uno.
 *  2. **Nada sale PASS por vacuidad**: lo no evaluable es `INFO` diciendo qué
 *     falta, lo declarado sin responder es `WARN`, y lo societario posterior al
 *     cierre nace `NA`.
 *  3. **El sello se compone DESPUÉS de los motivos** (H-4 de E7): `seal` y
 *     `sealReasons` no pueden contradecirse.
 *  4. **La reapertura manda** (O-21): un paso en `PENDIENTE_RECOMPUTO` lo está
 *     aunque el dato de ayer diga PASS.
 */

import { describe, expect, it } from "vitest"

import {
  BLOCKING_STEP_CODES,
  CLOSING_ENTRY_ORDER,
  CLOSING_STEPS,
  PENDING_RECOMPUTE_STEP_CODES,
  REOPENING_REVERSAL_ORDER,
  blockingFailures,
  canCloseFiscalYear,
  closingChecklist,
  closingSeal,
  type ChecklistInput,
} from "@/lib/closing/checklist"

const REF = "2026-12-31"

/** El ejercicio ideal: todo derivado en PASS y nada declarado sin responder. */
function inputPerfecto(over: Partial<ChecklistInput> = {}): ChecklistInput {
  const declarados = Object.fromEntries(
    CLOSING_STEPS.filter((s) => s.nature === "DECLARADO").map((s) => [s.step, { status: "PASS" as const }])
  )
  return {
    fiscalYearCode: "2026",
    fiscalYearStart: "2026-01-01",
    fiscalYearEnd: "2026-12-31",
    fiscalYearStatus: "OPEN",
    accountsApprovalStatus: "BORRADOR",
    taxFilingStatus: "NO_PRESENTADO",
    reopened: false,

    invariants: [
      { id: "I1", status: "PASS" },
      { id: "I4", status: "PASS" },
      { id: "I5", status: "PASS" },
    ],
    failedRunIds: [],
    proposedDocuments: 0,
    unsortedFiles: 0,
    monthsWithEntries: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    monthlyImbalances: [],
    bridgeBalances: [{ accountCode: "555", balanceCents: 0 }],
    againstNature: [],

    unreconciledBankAccounts: [],

    pendingRecurring: [],
    assetsPendingDepreciation: [],
    assetsWithoutAttribution: [],
    accrualsNotExhausted: [],

    fxStep: { step: "DIFERENCIAS_DE_CAMBIO", block: "VALORACION", status: "PASS", blocking: true, evidencia: "3 posiciones ajustadas" },
    presentValuePending: [],
    reclassStep: { step: "RECLASIFICACION_VENCIMIENTOS", block: "PRESENTACION", status: "PASS", blocking: true, evidencia: "2 pares movidos" },
    positionsWithoutDueDate: 0,
    debtWithoutSchedule: [],

    unsettledVatPeriods: [],
    prorrataStep: { step: "PRORRATA_DEFINITIVA", block: "FISCAL", status: "PASS", blocking: true, evidencia: "definitiva 87 %" },
    capitalGoodsStep: { step: "BIENES_DE_INVERSION", block: "FISCAL", status: "PASS", blocking: true, evidencia: "sin desviación > 10 puntos" },
    reccPendingCents: 0,
    withholdingPendingModels: [],
    balance473Cents: 0,

    incomeTaxEntryId: "entry-t25",
    balance6300Cents: 500_000,
    regularizacionEntryId: "entry-t26",
    cierreEntryId: "entry-t27",
    aperturaEntryId: "entry-t28",

    distributionEntryId: null,
    previousResultPendingCents: 0,

    cecosPendientes: [],
    i4i5: [
      { id: "I4", status: "PASS" },
      { id: "I5", status: "PASS" },
    ],
    answers: declarados,
    ...over,
  }
}

describe("El catálogo de pasos (§4.8, O-29)", () => {
  it("tiene los nueve bloques enumerados y los 43 pasos de la tabla del diseño", () => {
    expect(new Set(CLOSING_STEPS.map((s) => s.block)).size).toBe(9)
    // §4.8 dice «41» y la tabla que los enumera contiene 43. Se implementan los
    // enumerados; el desajuste está declarado en la cabecera del módulo.
    expect(CLOSING_STEPS).toHaveLength(43)
    expect(new Set(CLOSING_STEPS.map((s) => s.step)).size).toBe(43)
  })

  it("los nueve bloqueantes son exactamente los que nombra el diseño", () => {
    expect([...BLOCKING_STEP_CODES].sort()).toEqual(
      [
        "BIENES_DE_INVERSION",
        "DIFERENCIAS_DE_CAMBIO",
        "INVARIANTES_PASS",
        "IVA_LIQUIDADO",
        "PRORRATA_DEFINITIVA",
        "RECC_DEVENGADO_31_12",
        "RECLASIFICACION_VENCIMIENTOS",
        "SIN_DOCUMENTOS_PROPOSED",
        "SIN_RUNS_FAIL",
      ].sort()
    )
    expect(BLOCKING_STEP_CODES).toHaveLength(9)
  })

  it("el orden de O-17 son doce asientos y la reclasificación va DESPUÉS del valor actual y del cambio", () => {
    expect(CLOSING_ENTRY_ORDER).toHaveLength(12)
    const pos = (t: string) => CLOSING_ENTRY_ORDER.findIndex((o) => o.templateCode === t)
    expect(pos("AJUSTE_VALOR_ACTUAL")).toBeLessThan(pos("DIFERENCIAS_CAMBIO_CIERRE"))
    expect(pos("DIFERENCIAS_CAMBIO_CIERRE")).toBeLessThan(pos("RECLASIFICACION_VENCIMIENTOS"))
    // Art. 10.3 LIS: el impuesto va tras TODO movimiento de 6/7 y antes de T-26.
    expect(pos("RECLASIFICACION_VENCIMIENTOS")).toBeLessThan(pos("IMPUESTO_BENEFICIOS"))
    expect(pos("IMPUESTO_BENEFICIOS")).toBeLessThan(pos("REGULARIZACION_RESULTADO"))
    expect(pos("REGULARIZACION_RESULTADO")).toBeLessThan(pos("CIERRE_EJERCICIO"))
    expect(pos("CIERRE_EJERCICIO")).toBeLessThan(pos("APERTURA_EJERCICIO"))
  })

  it("la reversión de la reapertura es T-28 → T-27 → T-26 → T-25 (O-21)", () => {
    expect(REOPENING_REVERSAL_ORDER).toEqual([
      "APERTURA_EJERCICIO",
      "CIERRE_EJERCICIO",
      "REGULARIZACION_RESULTADO",
      "IMPUESTO_BENEFICIOS",
    ])
  })
})

describe("closingChecklist", () => {
  it("devuelve SIEMPRE los 43 pasos, en el orden del catálogo", () => {
    const steps = closingChecklist(inputPerfecto(), REF)
    expect(steps).toHaveLength(43)
    expect(steps.map((s) => s.step)).toEqual(CLOSING_STEPS.map((s) => s.step))
  })

  it("con todo en orden, los nueve bloqueantes pasan y el ejercicio se puede cerrar", () => {
    const steps = closingChecklist(inputPerfecto(), REF)
    expect(blockingFailures(steps)).toEqual([])
    expect(canCloseFiscalYear(steps).ok).toBe(true)
  })

  it("un documento en PROPOSED es FAIL bloqueante y el cierre se rechaza (criterio 31)", () => {
    const steps = closingChecklist(inputPerfecto({ proposedDocuments: 3 }), REF)
    const paso = steps.find((s) => s.step === "SIN_DOCUMENTOS_PROPOSED")!
    expect(paso.status).toBe("FAIL")
    expect(paso.evidencia).toContain("3")
    expect(canCloseFiscalYear(steps).ok).toBe(false)
  })

  it("deuda de 17x/52x SIN cuadro es FAIL bloqueante que NOMBRA la deuda (O-6, I-E9-25)", () => {
    const steps = closingChecklist(
      inputPerfecto({ debtWithoutSchedule: [{ accountCode: "170", balanceCents: 5_000_000 }] }),
      REF
    )
    const paso = steps.find((s) => s.step === "RECLASIFICACION_VENCIMIENTOS")!
    expect(paso.status).toBe("FAIL")
    expect(paso.evidencia).toContain("170")
    expect(paso.evidencia).toContain("T-37")
    expect(paso.sealReason).toBe("DEUDA_SIN_DESGLOSE")
  })

  it("sin invariantes ejecutados el paso es INFO, nunca PASS por vacuidad", () => {
    const steps = closingChecklist(inputPerfecto({ invariants: [] }), REF)
    const paso = steps.find((s) => s.step === "INVARIANTES_PASS")!
    expect(paso.status).toBe("INFO")
    expect(paso.evidencia).toContain("No evaluable")
    // INFO no mueve el sello, pero tampoco deja cerrar: es un bloqueante que no
    // está en PASS.
    expect(canCloseFiscalYear(steps).ok).toBe(false)
  })

  it("un paso declarado sin responder sale WARN, no PASS", () => {
    const steps = closingChecklist(inputPerfecto({ answers: {} }), REF)
    const arqueo = steps.find((s) => s.step === "ARQUEO_DE_CAJA")!
    expect(arqueo.status).toBe("WARN")
    expect(arqueo.evidencia).toContain("Sin responder")
  })

  it("los societarios posteriores al cierre nacen NA y se completan después", () => {
    const steps = closingChecklist(inputPerfecto({ answers: {} }), REF)
    for (const code of ["LEGALIZACION_LIBROS", "FORMULACION", "JUNTA_GENERAL", "DEPOSITO_CUENTAS"]) {
      expect(steps.find((s) => s.step === code)!.status).toBe("NA")
    }
  })

  it("RECC: sin régimen de caja el paso es NA; con cuota pendiente, FAIL que pide T-36", () => {
    expect(closingChecklist(inputPerfecto({ reccPendingCents: null }), REF).find((s) => s.step === "RECC_DEVENGADO_31_12")!.status).toBe("NA")
    const conPendiente = closingChecklist(inputPerfecto({ reccPendingCents: 86_776 }), REF)
    const paso = conPendiente.find((s) => s.step === "RECC_DEVENGADO_31_12")!
    expect(paso.status).toBe("FAIL")
    expect(paso.evidencia).toContain("T-36")
  })

  it("473 con saldo deja el impuesto en WARN nombrando la sobrevaloración (O-26)", () => {
    const steps = closingChecklist(inputPerfecto({ balance473Cents: 300_000 }), REF)
    expect(steps.find((s) => s.step === "PAGOS_FRACCIONADOS_CONCILIADOS")!.status).toBe("WARN")
    const impuesto = steps.find((s) => s.step === "IMPUESTO_BENEFICIOS")!
    expect(impuesto.status).toBe("WARN")
    expect(impuesto.evidencia).toContain("300000")
  })

  it("un activo sin línea atribuida deja la amortización en INFO nombrándolo (O-19)", () => {
    const steps = closingChecklist(inputPerfecto({ assetsWithoutAttribution: [{ code: "AC-0007" }] }), REF)
    const paso = steps.find((s) => s.step === "AMORTIZACION_AL_DIA")!
    expect(paso.status).toBe("INFO")
    expect(paso.evidencia).toContain("AC-0007")
  })

  it("posiciones vivas sin vencimiento añaden VENCIMIENTOS_SIN_FECHA sin tapar el paso", () => {
    const steps = closingChecklist(inputPerfecto({ positionsWithoutDueDate: 4 }), REF)
    const paso = steps.find((s) => s.step === "RECLASIFICACION_VENCIMIENTOS")!
    expect(paso.sealReason).toBe("VENCIMIENTOS_SIN_FECHA")
    expect(paso.status).toBe("WARN")
    expect(paso.evidencia).toContain("4 posiciones")
  })

  it("con el ejercicio en curso, EJERCICIO_COMPLETO es INFO y no un falso WARN", () => {
    const steps = closingChecklist(inputPerfecto({ monthsWithEntries: [1, 2, 3] }), "2026-03-31")
    expect(steps.find((s) => s.step === "EJERCICIO_COMPLETO")!.status).toBe("INFO")
  })

  it("O-21: un paso en PENDIENTE_RECOMPUTO lo está aunque el dato diga PASS", () => {
    const steps = closingChecklist(inputPerfecto({ pendingRecompute: PENDING_RECOMPUTE_STEP_CODES }), REF)
    for (const code of PENDING_RECOMPUTE_STEP_CODES) {
      const paso = steps.find((s) => s.step === code)!
      expect(paso.status).toBe("PENDIENTE_RECOMPUTO")
      expect(paso.evidencia).toContain("reabierto")
    }
    expect(canCloseFiscalYear(steps).ok).toBe(false)
  })

  it("reabierto: el paso de cierre pierde el PASS y aporta CIERRE_REABIERTO", () => {
    const steps = closingChecklist(inputPerfecto({ reopened: true }), REF)
    const paso = steps.find((s) => s.step === "CIERRE_APERTURA")!
    expect(paso.status).toBe("WARN")
    expect(paso.sealReason).toBe("CIERRE_REABIERTO")
  })

  it("Q-1.2: reabierto con el modelo 200 presentado, el impuesto avisa del art. 122 LGT", () => {
    const steps = closingChecklist(inputPerfecto({ reopened: true, taxFilingStatus: "PRESENTADO" }), REF)
    const paso = steps.find((s) => s.step === "IMPUESTO_BENEFICIOS")!
    expect(paso.sealReason).toBe("MODELO_200_PRESENTADO")
    expect(paso.evidencia).toContain("art. 122 LGT")
  })

  it("O-18: resultado de un ejercicio aprobado sin distribuir avisa con su importe", () => {
    const steps = closingChecklist(inputPerfecto({ previousResultPendingCents: 1_497_322 }), REF)
    const paso = steps.find((s) => s.step === "DISTRIBUCION_RESULTADO")!
    expect(paso.status).toBe("WARN")
    expect(paso.sealReason).toBe("RESULTADO_SIN_DISTRIBUIR")
    expect(paso.evidencia).toContain("1497322")
  })
})

describe("closingSeal (H-4 de E7: el sello se compone DESPUÉS de los motivos)", () => {
  it("todo en PASS ⇒ VALIDADO_AUTOMATICAMENTE y sin motivos", () => {
    const { seal, reasons } = closingSeal(closingChecklist(inputPerfecto(), REF))
    expect(seal).toBe("VALIDADO_AUTOMATICAMENTE")
    expect(reasons).toEqual([])
  })

  it("un WARN mueve el sello aunque no aporte motivo", () => {
    const { seal } = closingSeal(closingChecklist(inputPerfecto({ unsortedFiles: 2 }), REF))
    expect(seal).toBe("REQUIERE_REVISION")
  })

  it("hay motivo ⇒ hay REQUIERE_REVISION: seal y sealReasons nunca se contradicen", () => {
    const steps = closingChecklist(inputPerfecto({ unsettledVatPeriods: ["2026-Q4"] }), REF)
    const { seal, reasons } = closingSeal(steps)
    expect(reasons).toContain("IVA_NO_LIQUIDADO")
    expect(seal).toBe("REQUIERE_REVISION")
  })

  it("los motivos van sin repetir y ordenados: son un dato de auditoría, no una frase", () => {
    const steps = closingChecklist(
      inputPerfecto({
        unsettledVatPeriods: ["2026-Q3", "2026-Q4"],
        pendingRecurring: [
          { code: "REC-01", period: "2026-11" },
          { code: "REC-01", period: "2026-12" },
        ],
      }),
      REF
    )
    const { reasons } = closingSeal(steps)
    expect(reasons).toEqual([...new Set(reasons)].sort())
    expect(reasons).toContain("IVA_NO_LIQUIDADO")
    expect(reasons).toContain("RECURRENTES_PENDIENTES")
  })

  it("INFO y NA no mueven el sello: son «no evaluable» y «todavía no toca»", () => {
    const soloNa = closingChecklist(inputPerfecto(), REF).map((s) =>
      s.status === "PASS" ? { ...s, status: "NA" as const } : s
    )
    expect(closingSeal(soloNa).seal).toBe("VALIDADO_AUTOMATICAMENTE")
  })
})
