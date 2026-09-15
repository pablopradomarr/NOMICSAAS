/**
 * E11 · integración — **ADR-0019 D9**: el modo INTERNO, verificado.
 *
 * Cinco enunciados, uno por punto de la decisión:
 *
 *  1. en modo `none` el acceso es **`FULL` siempre**, cualquiera que sea el
 *     estado de la suscripción — no hay mora donde no hay precio;
 *  2. el plan por defecto al alta es **`ILIMITADO`**;
 *  3. `assertWithinLimit` **nunca bloquea** con los límites a `-1`;
 *  4. la cuota blanda **no avisa** con `softMaxEntriesMonth = -1`;
 *  5. el **modo `stripe` queda intacto**: los mismos estados siguen dando
 *     `READ_ONLY`, que es lo que D6 y D7 describen.
 */

import { describe, expect, it } from "vitest"

import {
  INTERNAL_BILLING_NOTICE_ES,
  INTERNAL_PLAN_CODE,
  INTERNAL_PLAN_LIMITS,
  defaultPlanCodeFor,
  internalAccessLevel,
  isInternalBilling,
  isStripeEnabled,
} from "./billing"
import { checkLimit, checkSoftEntries } from "./limits"
import { accessLevelOf } from "./subscription"
import type { SubscriptionStatus } from "@/prisma/client"

const REF = new Date("2026-09-15T10:00:00.000Z")

/** Una suscripción caducada hace un año: el peor caso posible del modo `stripe`. */
const MOROSA = {
  status: "PAST_DUE" as SubscriptionStatus,
  currentPeriodEnd: new Date("2025-09-15T00:00:00.000Z"),
  graceUntil: null,
}

const TODOS_LOS_ESTADOS: SubscriptionStatus[] = [
  "TRIALING",
  "ACTIVE",
  "PAST_DUE",
  "GRACE",
  "CANCELED",
  "PAUSED",
  "INCOMPLETE",
]

describe("D9 · modo de facturación", () => {
  it("`none` es el modo interno y `stripe` el de pago", () => {
    expect(isInternalBilling("none")).toBe(true)
    expect(isInternalBilling("stripe")).toBe(false)
    expect(isStripeEnabled("none")).toBe(false)
    expect(isStripeEnabled("stripe")).toBe(true)
  })

  it("toda organización nace con ILIMITADO en modo interno, y con FREE en modo stripe", () => {
    expect(defaultPlanCodeFor("none")).toBe(INTERNAL_PLAN_CODE)
    expect(defaultPlanCodeFor("none")).toBe("ILIMITADO")
    expect(defaultPlanCodeFor("stripe")).toBe("FREE")
  })

  it("el aviso de la pantalla se redacta una sola vez y dice que no se factura", () => {
    expect(INTERNAL_BILLING_NOTICE_ES).toMatch(/Modo interno: sin facturación/)
    expect(INTERNAL_BILLING_NOTICE_ES).toMatch(/no cobra/)
  })
})

describe("D9 · READ_ONLY por impago NUNCA en modo interno", () => {
  it.each(TODOS_LOS_ESTADOS)("estado %s ⇒ FULL", (status) => {
    const verdict = accessLevelOf({ ...MOROSA, status }, { graceDays: 0 }, REF, { billingProvider: "none" })
    expect(verdict.level).toBe("FULL")
    expect(verdict.reason).toBeNull()
    expect(verdict.graceUntil).toBeNull()
  })

  it("lo único que sigue bloqueando es la desactivación que decide el propio ADMIN", () => {
    const verdict = accessLevelOf(MOROSA, { graceDays: 0 }, REF, {
      billingProvider: "none",
      organizationIsActive: false,
    })
    expect(verdict.level).toBe("BLOCKED")
    expect(verdict.reason).toMatch(/desactivada por su administrador/)
  })

  it("`internalAccessLevel` devuelve null fuera del modo interno: el llamante sigue con accessLevelOf", () => {
    expect(internalAccessLevel("stripe")).toBeNull()
    expect(internalAccessLevel("none")?.level).toBe("FULL")
  })
})

describe("D9 · el modo stripe queda intacto", () => {
  it("una impagada fuera de gracia sigue cayendo a READ_ONLY sin pasar el modo", () => {
    // Sin cuarto argumento: exactamente como llaman las suites de la ola A.
    expect(accessLevelOf(MOROSA, { graceDays: 14 }, REF).level).toBe("READ_ONLY")
  })

  it("y también pasándolo explícitamente", () => {
    expect(accessLevelOf(MOROSA, { graceDays: 14 }, REF, { billingProvider: "stripe" }).level).toBe("READ_ONLY")
  })

  it("dentro de gracia sigue siendo FULL con aviso y fecha", () => {
    const verdict = accessLevelOf(
      { ...MOROSA, currentPeriodEnd: new Date("2026-09-10T00:00:00.000Z") },
      { graceDays: 14 },
      REF,
      { billingProvider: "stripe" }
    )
    expect(verdict.level).toBe("FULL")
    expect(verdict.reason).toMatch(/recibo pendiente de pago/)
    expect(verdict.graceUntil).not.toBeNull()
  })
})

describe("D9 · con los límites a −1 el guardián no bloquea nunca", () => {
  const USO_DESORBITADO = {
    maxMembers: BigInt(10_000),
    maxOcrDocsMonth: BigInt(10_000_000),
    maxStorageBytes: BigInt("9007199254740991"),
    maxExportsMonth: BigInt(10_000),
    maxBackupsMonth: BigInt(10_000),
    maxOrganizations: BigInt(10_000),
    softMaxEntriesMonth: BigInt(10_000_000),
  }

  it.each([
    "maxMembers",
    "maxOcrDocsMonth",
    "maxStorageBytes",
    "maxExportsMonth",
    "maxBackupsMonth",
    "maxOrganizations",
  ] as const)("%s con −1 devuelve ok y sin aviso", (key) => {
    const verdict = checkLimit(key, USO_DESORBITADO, INTERNAL_PLAN_LIMITS, BigInt(1), "FULL")
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.warn).toBeUndefined()
  })

  it("los siete límites del plan interno son −1", () => {
    expect(INTERNAL_PLAN_LIMITS.maxMembers).toBe(-1)
    expect(INTERNAL_PLAN_LIMITS.maxOcrDocsMonth).toBe(-1)
    expect(INTERNAL_PLAN_LIMITS.maxStorageBytes).toBe(BigInt(-1))
    expect(INTERNAL_PLAN_LIMITS.maxExportsMonth).toBe(-1)
    expect(INTERNAL_PLAN_LIMITS.maxBackupsMonth).toBe(-1)
    expect(INTERNAL_PLAN_LIMITS.maxOrganizations).toBe(-1)
    expect(INTERNAL_PLAN_LIMITS.softMaxEntriesMonth).toBe(-1)
  })

  it("la retención NO es −1: el CHECK de `plans` exige > 0 y una retención de cero caducaría el ZIP al crearlo", () => {
    expect(INTERNAL_PLAN_LIMITS.backupRetentionDays).toBeGreaterThan(0)
  })
})

describe("D9 · la cuota blanda no avisa con −1", () => {
  it("un millón de asientos en el mes no produce ni un aviso", () => {
    const resultado = checkSoftEntries(BigInt(1_000_000), INTERNAL_PLAN_LIMITS, BigInt(1))
    expect(resultado.warn).toBeNull()
    expect(resultado.blocksAccessory).toBe(false)
  })

  it("y con un límite real sí avisa: la diferencia es el −1, no el modo", () => {
    const resultado = checkSoftEntries(BigInt(95), { ...INTERNAL_PLAN_LIMITS, softMaxEntriesMonth: 100 }, BigInt(1))
    expect(resultado.warn?.code).toBe("CUOTA_DE_ASIENTOS_SUPERADA")
  })
})
