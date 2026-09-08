/**
 * E9 · T14 — La distribución del resultado (O-18, R2-2, criterio 35 de §12).
 *
 * El caso que manda es el del experto: beneficio 1 497 322, **saldo acreedor de
 * `100` = 3 000 000 derivado del diario, no tecleado**, `112` previa 400 000 ⇒
 * dotación `min(149 732; 200 000) = 149 732`, dividendo 500 000 y el resto a
 * `113`. Y el reverso: un plan sin `100` postable con `capitalStockOverrideCents`
 * calcula igual pero sale **WARN** con `CAPITAL_SOCIAL_DECLARADO`.
 */

import { describe, expect, it } from "vitest"

import {
  CAPITAL_SOCIAL_DECLARADO,
  capitalStockCheck,
  capitalStockOf,
  checkDistributionBalances,
  distributionLines,
  distributionPlan,
  legalReserveCents,
  type DistributionAccounts,
  type ProfitDistributionInput,
} from "@/lib/closing/distribution"

const ACCOUNTS: DistributionAccounts = {
  resultAccountCode: "129",
  legalReserveAccountCode: "112",
  voluntaryReserveAccountCode: "113",
  carryForwardAccountCode: "120",
  dividendAccountCode: "526",
  interimDividendAccountCode: "557",
  lossCarryForwardAccountCode: "121",
}

const base = (over: Partial<ProfitDistributionInput> = {}): ProfitDistributionInput => ({
  resultCents: 1_497_322,
  meetingDate: "2027-06-25",
  capital: { cents: 3_000_000, source: "DIARIO", accountCode: "1000" },
  currentLegalReserveCents: 400_000,
  interimDividendCents: 0,
  voluntaryReserveCents: 0,
  carryForwardCents: 0,
  dividendCents: 500_000,
  accounts: ACCOUNTS,
  ...over,
})

describe("capitalStockOf — R2-2: el capital sale del DIARIO", () => {
  it("suma todas las subcuentas de 100 con su saldo acreedor", () => {
    const balances = new Map([
      ["1000", 2_000_000],
      ["1001", 1_000_000],
      ["113", 400_000],
      ["572", 90_000],
    ])
    expect(capitalStockOf(balances, null)).toEqual({ cents: 3_000_000, source: "DIARIO", accountCode: "1000" })
  })

  it("el diario GANA al capital declarado: una cifra almacenada no pisa al libro", () => {
    const balances = new Map([["100", 3_000_000]])
    expect(capitalStockOf(balances, 9_999_999)).toMatchObject({ cents: 3_000_000, source: "DIARIO" })
  })

  it("sin saldo derivable usa el declarado y lo marca DECLARADO", () => {
    expect(capitalStockOf(new Map([["113", 400_000]]), 3_000_000)).toEqual({
      cents: 3_000_000,
      source: "DECLARADO",
      accountCode: null,
    })
  })

  it("sin saldo y sin declarado: cero, y el paso no puede salir PASS", () => {
    const capital = capitalStockOf(new Map(), null)
    expect(capital.cents).toBe(0)
    expect(capitalStockCheck(capital, null).status).toBe("INFO")
  })

  it("el capital declarado deja el paso en WARN con su motivo y las DOS cifras", () => {
    const capital = capitalStockOf(new Map(), 3_000_000)
    const check = capitalStockCheck(capital, 3_000_000)
    expect(check.status).toBe("WARN")
    expect(check.evidencia).toContain(CAPITAL_SOCIAL_DECLARADO)
    expect(check.evidencia).toContain("3000000")
    expect(check.evidencia).toContain("0 c")
  })
})

describe("legalReserveCents — art. 274 LSC", () => {
  it("el caso del experto: min(10 % de 1 497 322; 20 % de 3 000 000 − 400 000) = 149 732", () => {
    expect(
      legalReserveCents({
        profitCents: 1_497_322,
        capital: { cents: 3_000_000, source: "DIARIO", accountCode: "100" },
        currentReserveCents: 400_000,
      })
    ).toBe(149_732)
  })

  it("manda el TOPE cuando la reserva ya está cerca del 20 % del capital", () => {
    expect(
      legalReserveCents({
        profitCents: 1_000_000,
        capital: { cents: 3_000_000, source: "DIARIO", accountCode: "100" },
        currentReserveCents: 570_000,
      })
    ).toBe(30_000)
  })

  it("con la reserva ya al 20 % del capital no se dota nada", () => {
    expect(
      legalReserveCents({
        profitCents: 1_000_000,
        capital: { cents: 3_000_000, source: "DIARIO", accountCode: "100" },
        currentReserveCents: 600_000,
      })
    ).toBe(0)
  })

  it("con pérdida no se dota", () => {
    expect(
      legalReserveCents({
        profitCents: -500_000,
        capital: { cents: 3_000_000, source: "DIARIO", accountCode: "100" },
        currentReserveCents: 0,
      })
    ).toBe(0)
  })

  it("trunca hacia cero, nunca redondea al alza", () => {
    expect(
      legalReserveCents({
        profitCents: 999,
        capital: { cents: 10_000_000, source: "DIARIO", accountCode: "100" },
        currentReserveCents: 0,
      })
    ).toBe(99)
  })
})

describe("distributionLines — T-35", () => {
  it("criterio 35: 129 (D) 1 497 322 / 112 149 732 / 113 847 590 / 526 500 000", () => {
    const result = distributionLines(base({ voluntaryReserveCents: 847_590 }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual([
      expect.objectContaining({ accountCode: "129", debitCents: 1_497_322, creditCents: 0 }),
      expect.objectContaining({ accountCode: "112", creditCents: 149_732 }),
      expect.objectContaining({ accountCode: "113", creditCents: 847_590 }),
      expect.objectContaining({ accountCode: "526", creditCents: 500_000 }),
    ])
    const debe = result.value.reduce((a, l) => a + l.debitCents, 0)
    const haber = result.value.reduce((a, l) => a + l.creditCents, 0)
    expect(debe).toBe(haber)
  })

  it("lo no aplicado va a remanente (120): Σ destinos = resultado, tolerancia 0", () => {
    const plan = distributionPlan(base())
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.carryForwardCents).toBe(1_497_322 - 149_732 - 500_000)
    expect(checkDistributionBalances(plan.value).status).toBe("PASS")
  })

  it("el dividendo a cuenta ya satisfecho se CANCELA al haber en 557", () => {
    const result = distributionLines(base({ interimDividendCents: 300_000, dividendCents: 200_000 }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toContainEqual(expect.objectContaining({ accountCode: "557", creditCents: 300_000, debitCents: 0 }))
    expect(result.value.reduce((a, l) => a + l.debitCents - l.creditCents, 0)).toBe(0)
  })

  it("rechaza un reparto que exceda el resultado, diciendo la reserva obligatoria", () => {
    const result = distributionLines(base({ dividendCents: 1_400_000 }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0].message).toContain("149732")
  })

  it("pérdida: 121 (D) / 129 (H), y nada más", () => {
    const result = distributionLines(base({ resultCents: -640_000, dividendCents: 0 }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual([
      expect.objectContaining({ accountCode: "121", debitCents: 640_000 }),
      expect.objectContaining({ accountCode: "129", creditCents: 640_000 }),
    ])
  })

  it("con pérdida no se reparte nada (art. 273.2 LSC)", () => {
    expect(distributionLines(base({ resultCents: -640_000, dividendCents: 1 })).ok).toBe(false)
  })

  it("un resultado de 0 no genera asiento", () => {
    expect(distributionLines(base({ resultCents: 0, dividendCents: 0 })).ok).toBe(false)
  })

  it("ningún destino negativo", () => {
    expect(distributionLines(base({ dividendCents: -1 })).ok).toBe(false)
  })

  it("el capital DECLARADO calcula la reserva igual que el derivado", () => {
    const declarado = distributionPlan(base({ capital: { cents: 3_000_000, source: "DECLARADO", accountCode: null } }))
    const derivado = distributionPlan(base())
    expect(declarado.ok && derivado.ok).toBe(true)
    if (!declarado.ok || !derivado.ok) return
    expect(declarado.value.legalReserveCents).toBe(derivado.value.legalReserveCents)
  })
})
