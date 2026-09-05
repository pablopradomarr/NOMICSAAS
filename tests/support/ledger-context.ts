/**
 * E3 — Contexto sintético para los tests del motor.
 *
 * Reutiliza el plan PYMES real del seed y el mapa de defaults (los mismos que
 * usa el fixture), de modo que los tests unitarios se ejecutan contra el plan de
 * verdad y no contra un mapa de mentira que oculte un `MAP_KEY_UNMAPPED`.
 */

import { loadFixture } from "@/tests/support/fixtures"
import type { FiscalYearRef, LedgerContext, LocalDate, PeriodLockRef } from "@/lib/ledger/types"

const base = loadFixture("ejercicio-minimo")

export const FY_2026: FiscalYearRef = {
  id: "fy-2026",
  code: "2026",
  startDate: "2026-01-01",
  endDate: "2026-12-31",
  status: "OPEN",
}

/** 2025 cerrado: es el que dirige un documento antiguo a T-22. */
export const FY_2025_CLOSED: FiscalYearRef = {
  id: "fy-2025",
  code: "2025",
  startDate: "2025-01-01",
  endDate: "2025-12-31",
  status: "CLOSED",
}

export const FY_2027: FiscalYearRef = {
  id: "fy-2027",
  code: "2027",
  startDate: "2027-01-01",
  endDate: "2027-12-31",
  status: "OPEN",
}

export type ContextOverrides = {
  refDate?: LocalDate
  fiscalYears?: readonly FiscalYearRef[]
  periodLocks?: readonly PeriodLockRef[]
  prorrataBps?: number | null
  taxRoundingMode?: "PER_TIPO" | "PER_LINEA"
  redondeoToleranciaCents?: number
  analyticsRequired?: boolean
  dimensionsAvailable?: boolean
  balances?: ReadonlyMap<string, number>
}

export function testContext(overrides: ContextOverrides = {}): LedgerContext {
  return {
    ...base.ctx,
    organizationId: "org-test",
    refDate: overrides.refDate ?? "2026-12-31",
    fiscalYears: overrides.fiscalYears ?? [FY_2025_CLOSED, FY_2026, FY_2027],
    periodLocks: overrides.periodLocks ?? [],
    policy: {
      taxRoundingMode: overrides.taxRoundingMode ?? "PER_TIPO",
      prorrataBps: overrides.prorrataBps === undefined ? null : overrides.prorrataBps,
      redondeoToleranciaCents: overrides.redondeoToleranciaCents ?? 1,
      analyticsRequired: overrides.analyticsRequired ?? false,
    },
    dimensions: { available: overrides.dimensionsAvailable ?? false },
    ...(overrides.balances ? { balances: overrides.balances } : {}),
  }
}

/** Código PGC al que resuelve una clave del mapa en el plan PYMES de defaults. */
export const codeFor = (key: Parameters<LedgerContext["map"]>[0]): string => {
  const code = base.ctx.map(key)
  if (!code) throw new Error(`La clave ${key} no está mapeada en el plan de pruebas`)
  return code
}

export const testRates = base.ctx.rates
export const testPlan = base.plan
