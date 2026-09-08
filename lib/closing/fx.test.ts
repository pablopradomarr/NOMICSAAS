/**
 * E9 · T9 — `lib/closing/fx.ts` (R-FX-1…6).
 *
 * Casos obligatorios de todo módulo puro (CLAUDE.md) y los que sellan la tarea:
 * el **criterio 20** (universo monetario y el ejemplo del `400` en USD) y el
 * **criterio 21** (tasa efectiva del 29-12-2028 para un cierre en domingo).
 */

import { describe, expect, it } from "vitest"

import {
  closingRateFor,
  fxClosingAdjustments,
  fxLines,
  FX_RATE_WINDOW_DAYS,
  fxStep,
  type ClosingRate,
  type FxPosition,
} from "@/lib/closing/fx"

const rate = (over: Partial<ClosingRate> = {}): ClosingRate => ({
  currency: "USD",
  rateMicro: BigInt(900_000), // 1 USD = 0,90 EUR
  rateDate: "2026-12-31",
  ...over,
})

const position = (over: Partial<FxPosition> = {}): FxPosition => ({
  accountCode: "400",
  counterpartyId: "cp-1",
  currency: "USD",
  baseBalanceCents: -460_000,
  currencyBalanceCents: -500_000,
  isMonetary: true,
  ...over,
})

const CUTOFF = "2026-12-31"

// ─────────────────────────────────────────────────────────────────────────────
// Casos obligatorios
// ─────────────────────────────────────────────────────────────────────────────

describe("casos obligatorios", () => {
  it("sin posiciones no hay asiento y el paso pasa", () => {
    const r = fxClosingAdjustments([], [rate()], CUTOFF)
    expect(r.lines).toEqual([])
    expect(r.byPosition).toEqual([])
    expect(fxStep(r, CUTOFF).status).toBe("PASS")
  })

  it("una posición sin diferencia no genera línea", () => {
    const r = fxClosingAdjustments([position({ baseBalanceCents: -450_000 })], [rate()], CUTOFF)
    expect(r.byPosition[0].deltaCents).toBe(0)
    expect(r.lines).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Criterio 20 (O-4) · universo monetario y el ejemplo del experto
// ─────────────────────────────────────────────────────────────────────────────

describe("criterio 20 · el 400 en USD y el anticipo en 407", () => {
  it("D = −500 000, S = −460 000, r = 0,90 ⇒ 400 (D) 10 000 / 768 (H) 10 000", () => {
    const r = fxClosingAdjustments([position()], [rate()], CUTOFF)
    expect(r.byPosition[0].deltaCents).toBe(10_000)
    expect(r.lines).toHaveLength(2)
    expect(r.lines[0]).toMatchObject({ accountCode: "400", debitCents: 10_000, creditCents: 0 })
    expect(r.lines[1]).toMatchObject({ accountKey: "DIFERENCIA_CAMBIO_POSITIVA", creditCents: 10_000, analyticType: "FINANCIERO" })
  })

  it("un anticipo en 407 NO genera diferencia de cambio (isMonetary = false)", () => {
    const r = fxClosingAdjustments(
      [position(), position({ accountCode: "407", isMonetary: false, baseBalanceCents: 100_000, currencyBalanceCents: 120_000 })],
      [rate()],
      CUTOFF
    )
    expect(r.byPosition.map((p) => p.accountCode)).toEqual(["400"])
    expect(r.excludedNonMonetary.map((p) => p.accountCode)).toEqual(["407"])
    expect(fxStep(r, CUTOFF).evidencia).toContain("no monetaria")
  })

  it("Δ < 0 carga 668 y abona la cuenta; nunca 669/769", () => {
    const r = fxClosingAdjustments([position({ baseBalanceCents: -430_000 })], [rate()], CUTOFF)
    expect(r.byPosition[0].deltaCents).toBe(-20_000)
    expect(r.lines[0]).toMatchObject({ accountCode: "400", creditCents: 20_000 })
    expect(r.lines[1]).toMatchObject({ accountKey: "DIFERENCIA_CAMBIO_NEGATIVA", debitCents: 20_000 })
    expect(JSON.stringify(r.lines)).not.toContain("669")
  })

  it("R-FX-1: lo ya reconocido en 668/768 está DENTRO de S y no se resta otra vez (N-1 de E7)", () => {
    // Primer cierre: se reconocen 10 000. Segundo barrido sobre la posición ya
    // ajustada (S = −450 000): la diferencia es 0, no otros 10 000.
    const primero = fxClosingAdjustments([position()], [rate()], CUTOFF)
    const ajustada = position({ baseBalanceCents: position().baseBalanceCents + primero.byPosition[0].deltaCents })
    const segundo = fxClosingAdjustments([ajustada], [rate()], CUTOFF)
    expect(segundo.byPosition[0].deltaCents).toBe(0)
  })

  it("R-FX-4 (I-E9-18): las líneas de la partida llevan divisa y originalAmountCents = 0", () => {
    const r = fxClosingAdjustments([position()], [rate()], CUTOFF)
    expect(r.lines[0]).toMatchObject({ originalCurrency: "USD", originalAmountCents: 0 })
    const porDivisa = r.lines
      .filter((l) => l.originalCurrency)
      .reduce((acc, l) => acc + (l.originalAmountCents ?? 0), 0)
    expect(porDivisa).toBe(0)
  })

  it("el asiento cuadra con varias divisas y una sola línea por lado", () => {
    const r = fxClosingAdjustments(
      [
        position(),
        position({ accountCode: "430", currency: "GBP", baseBalanceCents: 100_000, currencyBalanceCents: 80_000 }),
      ],
      [rate(), rate({ currency: "GBP", rateMicro: BigInt(1_100_000) })],
      CUTOFF
    )
    const debe = r.lines.reduce((a, l) => a + l.debitCents, 0)
    const haber = r.lines.reduce((a, l) => a + l.creditCents, 0)
    expect(debe).toBe(haber)
    expect(r.lines.filter((l) => l.accountKey === "DIFERENCIA_CAMBIO_POSITIVA")).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Criterio 21 (O-5) · la tasa efectiva y su ventana
// ─────────────────────────────────────────────────────────────────────────────

describe("criterio 21 · tasa de cierre efectiva", () => {
  const DOMINGO = "2028-12-31"
  const rates = [
    rate({ rateDate: "2028-12-28", rateMicro: BigInt(880_000) }),
    rate({ rateDate: "2028-12-29", rateMicro: BigInt(890_000) }),
    rate({ rateDate: "2029-01-02", rateMicro: BigInt(950_000) }),
  ]

  it("usa la del 29-12-2028 y la sella; nunca una posterior al corte", () => {
    const r = closingRateFor(rates, "USD", DOMINGO)
    expect(r?.rateDate).toBe("2028-12-29")
    expect(r?.rateMicro).toBe(BigInt(890_000))
  })

  it("el cierre AVANZA y la fecha efectiva se enseña", () => {
    const r = fxClosingAdjustments([position()], rates, DOMINGO)
    const step = fxStep(r, DOMINGO)
    expect(step.status).toBe("PASS")
    expect(step.evidencia).toContain("2028-12-29")
    expect(r.byPosition[0].rateDate).toBe("2028-12-29")
  })

  it("sin ninguna tasa en los 7 días previos, FAIL con evidencia y sin inventar tasa", () => {
    const r = fxClosingAdjustments([position()], [rate({ rateDate: "2028-12-01" })], DOMINGO)
    expect(r.missingRates).toEqual(["USD"])
    expect(r.byPosition).toEqual([])
    const step = fxStep(r, DOMINGO)
    expect(step.status).toBe("FAIL")
    expect(step.blocking).toBe(true)
    expect(step.evidencia).toContain(`${FX_RATE_WINDOW_DAYS} día`)
  })

  it("la ventana es declarada: con 30 días la misma tasa vale", () => {
    const r = closingRateFor([rate({ rateDate: "2028-12-01" })], "USD", DOMINGO, 30)
    expect(r?.rateDate).toBe("2028-12-01")
  })

  it("el 29-feb de un bisiesto entra en la ventana sin saltos", () => {
    expect(closingRateFor([rate({ rateDate: "2028-02-29" })], "USD", "2028-03-05", 7)?.rateDate).toBe("2028-02-29")
    expect(closingRateFor([rate({ rateDate: "2028-02-29" })], "USD", "2028-03-08", 7)).toBeNull()
  })
})

describe("fxLines", () => {
  it("sin ajustes no produce líneas", () => {
    expect(fxLines([])).toEqual([])
  })
})
