/**
 * E6 · T11 — Aging: tramos desde el VENCIMIENTO, `refDate` por parámetro y
 * `Σ tramos = saldo de la cuenta` (I-E6-14).
 */

import { describe, expect, it } from "vitest"

import { agingBucketOf, buildAging, daysBetween, AGING_BUCKET_ORDER } from "@/lib/ledger/reports/aging"
import type { ReportLine } from "@/lib/ledger/reports/types"

const line = (over: Partial<ReportLine> & { accountCode: string; debitCents: number; creditCents: number }): ReportLine => ({
  entryId: "e1",
  entryNumber: 1,
  entryDate: "2026-01-15",
  entryKind: "MANUAL",
  fiscalYearId: "fy",
  lineNo: 1,
  ...over,
})

const REF = "2026-12-31"

describe("daysBetween", () => {
  it("cuenta días naturales, sin horas ni husos", () => {
    expect(daysBetween("2026-12-01", "2026-12-31")).toBe(30)
    expect(daysBetween("2026-12-31", "2026-12-31")).toBe(0)
    expect(daysBetween("2027-01-01", "2026-12-31")).toBe(-1)
  })

  it("cruza el 29 de febrero de un bisiesto", () => {
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2)
    expect(daysBetween("2026-02-28", "2026-03-01")).toBe(1)
  })
})

describe("agingBucketOf — el aging mide MORA, no antigüedad", () => {
  it("una factura a 90 días emitida hace 80 NO está vencida", () => {
    // Es el error que hace que una empresa con plazos largos parezca morosa.
    expect(agingBucketOf("2027-01-15", REF, 100)).toBe("NO_VENCIDO")
  })

  it("los cinco tramos de mora se cortan en 0/30/60/90", () => {
    expect(agingBucketOf("2026-12-31", REF, 100)).toBe("NO_VENCIDO")
    expect(agingBucketOf("2026-12-30", REF, 100)).toBe("D_1_30")
    expect(agingBucketOf("2026-12-01", REF, 100)).toBe("D_1_30")
    expect(agingBucketOf("2026-11-30", REF, 100)).toBe("D_31_60")
    expect(agingBucketOf("2026-11-01", REF, 100)).toBe("D_31_60")
    expect(agingBucketOf("2026-10-31", REF, 100)).toBe("D_61_90")
    // 90 días es además el umbral del art. 13.1.a LIS: hay que poder señalarlo.
    expect(agingBucketOf("2026-10-02", REF, 100)).toBe("D_61_90")
    expect(agingBucketOf("2026-10-01", REF, 100)).toBe("D_MAS_90")
  })

  it("sin `dueDate` → tramo propio VISIBLE, ni vencido ni no vencido", () => {
    expect(agingBucketOf(null, REF, 100)).toBe("SIN_VENCIMIENTO")
    expect(agingBucketOf(undefined, REF, 100)).toBe("SIN_VENCIMIENTO")
    // Y es el PRIMERO de la tabla, no un pie de página.
    expect(AGING_BUCKET_ORDER[0]).toBe("SIN_VENCIMIENTO")
  })

  it("un importe de signo contrario va a `A_APLICAR` y no compensa la mora", () => {
    expect(agingBucketOf("2026-01-01", REF, -100)).toBe("A_APLICAR")
  })
})

describe("buildAging", () => {
  it("I-E6-14: Σ tramos = saldo de la cuenta a refDate, tolerancia 0", () => {
    const report = buildAging(
      [
        line({ accountCode: "4300", debitCents: 500_000, creditCents: 0, dueDate: "2026-06-30" }),
        line({ accountCode: "4300", debitCents: 300_000, creditCents: 0, dueDate: "2027-03-31" }),
        line({ accountCode: "4300", debitCents: 0, creditCents: 100_000, dueDate: null }),
        line({ accountCode: "4300", debitCents: 121_000, creditCents: 0, dueDate: null }),
      ],
      { refDate: REF, accountPrefixes: ["43"], naturalSide: "DEUDOR" }
    )
    expect(report.checkTotalCents).toBe(0)
    expect(report.totalCents).toBe(500_000 + 300_000 - 100_000 + 121_000)
    expect(report.byAccountCents["4300"]).toBe(report.totalCents)
  })

  it("I-E6-15: ninguna línea cae en dos tramos", () => {
    const report = buildAging(
      [
        line({ accountCode: "4300", debitCents: 100, creditCents: 0, dueDate: "2026-06-30" }),
        line({ accountCode: "4300", debitCents: 200, creditCents: 0, dueDate: "2026-12-01" }),
      ],
      { refDate: REF, accountPrefixes: ["43"], naturalSide: "DEUDOR" }
    )
    expect(report.rows.reduce((a, r) => a + r.lineCount, 0)).toBe(2)
  })

  it("las siete filas se imprimen SIEMPRE, con ceros explícitos", () => {
    // Un informe con tramos ausentes es indistinguible de uno truncado.
    const report = buildAging([], { refDate: REF, accountPrefixes: ["43"], naturalSide: "DEUDOR" })
    expect(report.rows.map((r) => r.bucket)).toEqual([...AGING_BUCKET_ORDER])
    expect(report.rows.every((r) => r.cents === 0)).toBe(true)
    expect(report.checkTotalCents).toBe(0)
  })

  it("un anticipo NO se compensa con una factura vencida", () => {
    const report = buildAging(
      [
        line({ accountCode: "4300", debitCents: 100_000, creditCents: 0, dueDate: "2026-01-31" }),
        line({ accountCode: "4300", debitCents: 0, creditCents: 100_000, dueDate: null }),
      ],
      { refDate: REF, accountPrefixes: ["43"], naturalSide: "DEUDOR" }
    )
    // La mora sigue ahí: 100 000 a más de 90 días y −100 000 pendiente de aplicar.
    expect(report.rows.find((r) => r.bucket === "D_MAS_90")?.cents).toBe(100_000)
    expect(report.rows.find((r) => r.bucket === "A_APLICAR")?.cents).toBe(-100_000)
    expect(report.totalCents).toBe(0)
  })

  it("proveedores: el saldo acreedor se presenta en positivo", () => {
    const report = buildAging(
      [line({ accountCode: "4000", debitCents: 0, creditCents: 250_000, dueDate: "2026-06-30" })],
      { refDate: REF, accountPrefixes: ["400"], naturalSide: "ACREEDOR" }
    )
    expect(report.rows.find((r) => r.bucket === "D_MAS_90")?.cents).toBe(250_000)
  })

  it("las líneas posteriores a `refDate` no cuentan: el aging es una foto", () => {
    const report = buildAging(
      [line({ accountCode: "4300", entryDate: "2027-06-01", debitCents: 999, creditCents: 0, dueDate: "2027-06-30" })],
      { refDate: REF, accountPrefixes: ["43"], naturalSide: "DEUDOR" }
    )
    expect(report.totalCents).toBe(0)
  })

  it("mismo `ledgerHash` y misma `refDate` → mismo aging (determinismo)", () => {
    const lines = [line({ accountCode: "4300", debitCents: 100, creditCents: 0, dueDate: "2026-05-05" })]
    const opts = { refDate: REF, accountPrefixes: ["43"], naturalSide: "DEUDOR" as const }
    expect(JSON.stringify(buildAging(lines, opts))).toBe(JSON.stringify(buildAging(lines, opts)))
  })

  it("cuenta las líneas sin vencimiento como WARN de calidad de datos", () => {
    const report = buildAging(
      [line({ accountCode: "4300", debitCents: 100, creditCents: 0, dueDate: null })],
      { refDate: REF, accountPrefixes: ["43"], naturalSide: "DEUDOR" }
    )
    expect(report.linesWithoutDueDate).toBe(1)
    expect(report.groupingNote).toContain("no por cliente")
  })
})
