/**
 * E11 · ola A · T3 — estado ⇔ acceso, gracia y qué sobrevive a la mora.
 *
 * Los casos obligatorios de `CLAUDE.md` para toda función pura (vacío, un
 * registro, límites de fecha) más los criterios de §14 que esta pieza sostiene:
 * 11, 12, 20, 21 y el enunciado de ADR-0019 D6 y D7.
 */

import { describe, expect, it } from "vitest"

import {
  accessLevelOf,
  addDays,
  canWrite,
  exportWindowUntilOf,
  graceUntilOf,
  isPermittedInArrears,
  mapStripeStatus,
  WRITE_KINDS_PERMITTED_IN_ARREARS,
} from "./subscription"
import type { SubscriptionRow, WriteKind } from "./types"

const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

function sub(over: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    organizationId: "org-1",
    planCode: "STARTER",
    planId: "plan-1",
    status: "ACTIVE",
    currentPeriodStart: D("2026-09-01"),
    currentPeriodEnd: D("2026-10-01"),
    cancelAtPeriodEnd: false,
    trialEnd: null,
    graceUntil: null,
    exportWindowUntil: null,
    customerCountry: "ES",
    vatNumber: null,
    vatValidatedAt: null,
    ...over,
  }
}

const STARTER = { graceDays: 14 }
const FREE = { graceDays: 0 }
const PRO = { graceDays: 30 }

describe("mapStripeStatus", () => {
  it("traduce los estados conocidos", () => {
    expect(mapStripeStatus("trialing")).toBe("TRIALING")
    expect(mapStripeStatus("active")).toBe("ACTIVE")
    expect(mapStripeStatus("past_due")).toBe("PAST_DUE")
    expect(mapStripeStatus("canceled")).toBe("CANCELED")
    expect(mapStripeStatus("paused")).toBe("PAUSED")
    expect(mapStripeStatus("incomplete")).toBe("INCOMPLETE")
    expect(mapStripeStatus("incomplete_expired")).toBe("INCOMPLETE")
  })

  it("`unpaid` es PAST_DUE y no CANCELED: el contrato sigue vivo", () => {
    expect(mapStripeStatus("unpaid")).toBe("PAST_DUE")
  })

  it("un estado desconocido no se adivina: INCOMPLETE, el más conservador", () => {
    expect(mapStripeStatus("")).toBe("INCOMPLETE")
    expect(mapStripeStatus("algo_que_stripe_invente_en_2028")).toBe("INCOMPLETE")
  })
})

describe("graceUntilOf", () => {
  it("sólo tiene sentido en mora: en ACTIVE y TRIALING no hay nada que graciar", () => {
    expect(graceUntilOf(sub({ status: "ACTIVE" }), STARTER, D("2026-10-05"))).toBeNull()
    expect(graceUntilOf(sub({ status: "TRIALING" }), STARTER, D("2026-10-05"))).toBeNull()
    expect(graceUntilOf(sub({ status: "CANCELED" }), STARTER, D("2026-10-05"))).toBeNull()
  })

  it("se cuenta desde el FIN DEL PERIODO PAGADO, no desde hoy", () => {
    const hasta = graceUntilOf(sub({ status: "PAST_DUE" }), STARTER, D("2026-10-05"))
    expect(hasta).toEqual(D("2026-10-15"))
    // Y no se mueve al volver a mirar tres días después: si se contara desde
    // `refDate`, la gracia no caducaría nunca.
    expect(graceUntilOf(sub({ status: "PAST_DUE" }), STARTER, D("2026-10-08"))).toEqual(D("2026-10-15"))
  })

  it("una gracia ya fijada no se recalcula: es una promesa con fecha a la vista", () => {
    const fijada = D("2026-10-20")
    expect(graceUntilOf(sub({ status: "PAST_DUE", graceUntil: fijada }), PRO, D("2026-10-05"))).toEqual(fijada)
  })

  it("FREE con graceDays = 0 devuelve la propia fecha de corte, no null", () => {
    expect(graceUntilOf(sub({ status: "PAST_DUE" }), FREE, D("2026-10-05"))).toEqual(D("2026-10-01"))
  })

  it("sin periodo conocido cuenta desde refDate: es lo único disponible", () => {
    expect(graceUntilOf(sub({ status: "PAST_DUE", currentPeriodEnd: null }), STARTER, D("2026-10-05"))).toEqual(
      D("2026-10-19")
    )
  })

  it("cruza fin de mes y año bisiesto sin saltarse un día", () => {
    const s = sub({ status: "PAST_DUE", currentPeriodEnd: D("2028-02-20") })
    expect(graceUntilOf(s, { graceDays: 14 }, D("2028-02-21"))).toEqual(D("2028-03-05"))
    expect(addDays(D("2028-02-28"), 1)).toEqual(D("2028-02-29"))
  })
})

describe("accessLevelOf — la regla de ADR-0019 D6, definida una sola vez", () => {
  it("ACTIVE y TRIALING son FULL sin aviso", () => {
    expect(accessLevelOf(sub({ status: "ACTIVE" }), STARTER, D("2026-09-15"))).toEqual({
      level: "FULL",
      reason: null,
      graceUntil: null,
    })
    expect(accessLevelOf(sub({ status: "TRIALING" }), STARTER, D("2026-09-15")).level).toBe("FULL")
  })

  // Criterio 11
  it("PAST_DUE dentro de gracia: FULL, con aviso y la FECHA EXACTA", () => {
    const v = accessLevelOf(sub({ status: "PAST_DUE" }), STARTER, D("2026-10-05"))
    expect(v.level).toBe("FULL")
    expect(v.graceUntil).toEqual(D("2026-10-15"))
    expect(v.reason).toContain("15/10/2026")
  })

  it("el último día de gracia todavía es FULL; el siguiente, READ_ONLY", () => {
    expect(accessLevelOf(sub({ status: "PAST_DUE" }), STARTER, D("2026-10-15")).level).toBe("FULL")
    expect(accessLevelOf(sub({ status: "PAST_DUE" }), STARTER, D("2026-10-16")).level).toBe("READ_ONLY")
  })

  // Criterio 12
  it("PAST_DUE fuera de gracia, GRACE, CANCELED, PAUSED e INCOMPLETE son READ_ONLY", () => {
    for (const status of ["PAST_DUE", "GRACE", "CANCELED", "PAUSED", "INCOMPLETE"] as const) {
      const v = accessLevelOf(sub({ status, currentPeriodEnd: D("2026-08-01") }), STARTER, D("2026-10-05"))
      expect(v.level, status).toBe("READ_ONLY")
      expect(v.reason, status).toBeTruthy()
    }
  })

  it("NUNCA devuelve BLOCKED por impago: eso es ADR-0019 D6", () => {
    for (const status of ["PAST_DUE", "GRACE", "CANCELED", "PAUSED", "INCOMPLETE", "ACTIVE", "TRIALING"] as const) {
      expect(accessLevelOf(sub({ status, currentPeriodEnd: D("2020-01-01") }), FREE, D("2026-10-05")).level).not.toBe(
        "BLOCKED"
      )
    }
  })

  it("lo ÚNICO que bloquea es la desactivación que decide el propio ADMIN", () => {
    const v = accessLevelOf(sub({ status: "ACTIVE" }), STARTER, D("2026-10-05"), { organizationIsActive: false })
    expect(v.level).toBe("BLOCKED")
    expect(v.reason).toContain("desactivada")
  })

  it("el mensaje de READ_ONLY dice sin eufemismo que la llevanza sigue siendo suya", () => {
    const v = accessLevelOf(sub({ status: "CANCELED" }), STARTER, D("2026-10-05"))
    expect(v.reason).toMatch(/exportar/i)
    expect(v.reason).toMatch(/copia completa/i)
  })
})

describe("exportWindowUntilOf — O-4: la portabilidad no la desactiva un precio", () => {
  // Criterio 21
  it("CANCELED abre 90 días desde el fin del periodo, aunque el plan retenga 7", () => {
    expect(exportWindowUntilOf(sub({ status: "CANCELED", currentPeriodEnd: D("2026-10-01") }), D("2026-10-02"))).toEqual(
      D("2026-12-30")
    )
  })

  it("una ventana ya fijada se respeta", () => {
    const fijada = D("2027-01-31")
    expect(exportWindowUntilOf(sub({ status: "CANCELED", exportWindowUntil: fijada }), D("2026-10-02"))).toEqual(fijada)
  })

  it("en cualquier otro estado devuelve lo que hubiera, sin inventar ventana", () => {
    expect(exportWindowUntilOf(sub({ status: "ACTIVE" }), D("2026-10-02"))).toBeNull()
  })
})

describe("isPermittedInArrears — O-3 y O-16", () => {
  const TODAS: WriteKind[] = [
    "CONTRA_ASIENTO",
    "OBLIGACION_DEVENGADA",
    "REGISTRO_CONTABLE_ORDINARIO",
    "REGISTRO_DOCUMENTAL",
    "PORTABILIDAD",
    "FACTURACION_PROPIA",
    "CONSUMO_IA",
    "ORDINARIA",
  ]

  it("la lista cerrada y la función dicen lo mismo (I-E11-5)", () => {
    const permitidas = TODAS.filter(isPermittedInArrears)
    expect(new Set(permitidas)).toEqual(new Set(WRITE_KINDS_PERMITTED_IN_ARREARS))
  })

  it("registrar un hecho contable ya ocurrido NO lo detiene la mora (O-3)", () => {
    expect(isPermittedInArrears("REGISTRO_CONTABLE_ORDINARIO")).toBe(true)
    expect(isPermittedInArrears("CONTRA_ASIENTO")).toBe(true)
    expect(isPermittedInArrears("OBLIGACION_DEVENGADA")).toBe(true)
  })

  it("subir el papel sí, analizarlo con IA no: la asimetría de O-16", () => {
    expect(isPermittedInArrears("REGISTRO_DOCUMENTAL")).toBe(true)
    expect(isPermittedInArrears("CONSUMO_IA")).toBe(false)
  })

  it("el checkout y el portal siguen abiertos: es cómo se sale del impago", () => {
    expect(isPermittedInArrears("FACTURACION_PROPIA")).toBe(true)
  })
})

describe("canWrite", () => {
  it("FULL lo permite todo", () => {
    expect(canWrite("FULL", "ORDINARIA")).toBe(true)
    expect(canWrite("FULL", "CONSUMO_IA")).toBe(true)
  })

  it("READ_ONLY se rige por las cuatro clases de §3.2", () => {
    expect(canWrite("READ_ONLY", "REGISTRO_CONTABLE_ORDINARIO")).toBe(true)
    expect(canWrite("READ_ONLY", "PORTABILIDAD")).toBe(true)
    expect(canWrite("READ_ONLY", "ORDINARIA")).toBe(false)
  })

  it("BLOCKED no admite ninguna: no es una mora nuestra", () => {
    for (const op of WRITE_KINDS_PERMITTED_IN_ARREARS) {
      expect(canWrite("BLOCKED", op), op).toBe(false)
    }
  })
})
