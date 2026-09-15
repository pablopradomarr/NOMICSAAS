/**
 * E11 · ola A · T15 — el reloj: clave de periodo, vencimiento y retraso.
 *
 * El caso que sostiene **O-13** y el criterio 49 está aquí: el job lanzado con
 * dos días de retraso NO cambia de clave de periodo si se le pasa el `refDate`
 * de su disparo, y por tanto no genera nada dos veces ni fecha nada por el reloj.
 */

import { describe, expect, it } from "vitest"

import {
  CRON_BUDGET_MS,
  CRON_JOBS,
  CRON_JOB_SPECS,
  hasBudgetLeft,
  isCronJobName,
  isDue,
  isStale,
  periodKeyOf,
  type CronRunRow,
} from "./cron"

const T = (iso: string) => new Date(iso)

function run(over: Partial<CronRunRow> = {}): CronRunRow {
  return {
    job: "recurring-due",
    periodKey: "2026-09-26",
    status: "DONE",
    startedAt: T("2026-09-26T06:00:00.000Z"),
    finishedAt: T("2026-09-26T06:00:30.000Z"),
    ...over,
  }
}

describe("catálogo de jobs", () => {
  it("son los CUATRO de §7.1, ni uno más", () => {
    expect([...CRON_JOBS]).toEqual(["recurring-due", "invariant-sweep", "backup-worker", "retention"])
    expect(Object.keys(CRON_JOB_SPECS).sort()).toEqual([...CRON_JOBS].sort())
  })

  it("cada job declara POR ESCRITO qué hace en mora (§7.2)", () => {
    for (const job of CRON_JOBS) {
      expect(CRON_JOB_SPECS[job].runsInArrears, job).toBe(true)
      expect(CRON_JOB_SPECS[job].description.length, job).toBeGreaterThan(40)
    }
  })

  it("isCronJobName no deja pasar un nombre inventado", () => {
    expect(isCronJobName("retention")).toBe(true)
    expect(isCronJobName("email-sync")).toBe(false)
    expect(isCronJobName("../../etc/passwd")).toBe(false)
  })
})

describe("periodKeyOf", () => {
  it("DAILY: un día natural, en UTC", () => {
    expect(periodKeyOf("recurring-due", "DAILY", T("2026-09-26T06:00:00Z"))).toBe("2026-09-26")
    expect(periodKeyOf("recurring-due", "DAILY", T("2026-09-26T23:59:59Z"))).toBe("2026-09-26")
    expect(periodKeyOf("recurring-due", "DAILY", T("2026-09-27T00:00:00Z"))).toBe("2026-09-27")
  })

  it("EVERY_5_MIN: cubos de cinco minutos", () => {
    expect(periodKeyOf("backup-worker", "EVERY_5_MIN", T("2026-09-26T10:02:59Z"))).toBe("2026-09-26T10:00")
    expect(periodKeyOf("backup-worker", "EVERY_5_MIN", T("2026-09-26T10:05:00Z"))).toBe("2026-09-26T10:05")
    expect(periodKeyOf("backup-worker", "EVERY_5_MIN", T("2026-09-26T10:09:59Z"))).toBe("2026-09-26T10:05")
  })

  it("EVERY_15_MIN: cubos de cuarto de hora", () => {
    expect(periodKeyOf("backup-worker", "EVERY_15_MIN", T("2026-09-26T10:14:59Z"))).toBe("2026-09-26T10:00")
    expect(periodKeyOf("backup-worker", "EVERY_15_MIN", T("2026-09-26T10:45:00Z"))).toBe("2026-09-26T10:45")
  })

  it("WEEKLY se ancla al LUNES: un domingo retrasado al lunes no corre dos veces", () => {
    // 2026-09-27 es domingo; 2026-09-28, lunes.
    const domingo = periodKeyOf("retention", "WEEKLY", T("2026-09-27T04:00:00Z"))
    const lunesSiguiente = periodKeyOf("retention", "WEEKLY", T("2026-09-28T04:00:00Z"))
    expect(domingo).toBe("W2026-09-21")
    expect(lunesSiguiente).toBe("W2026-09-28")
    // …y dentro de la misma semana, la clave no se mueve.
    expect(periodKeyOf("retention", "WEEKLY", T("2026-09-22T04:00:00Z"))).toBe(domingo)
  })

  it("cruza fin de año y 29 de febrero sin romperse", () => {
    expect(periodKeyOf("recurring-due", "DAILY", T("2027-01-01T00:00:00Z"))).toBe("2027-01-01")
    expect(periodKeyOf("recurring-due", "DAILY", T("2028-02-29T12:00:00Z"))).toBe("2028-02-29")
  })

  it("**O-13 / criterio 49** — el mismo refDate da la misma clave por muy tarde que se lance", () => {
    const refDate = T("2026-09-26T06:00:00Z")
    const primeraVez = periodKeyOf("recurring-due", "DAILY", refDate)
    // Dos días después, el operador relanza el job DE ESE DÍA: misma clave, y
    // por tanto `cron_runs` lo rechaza como ya ejecutado. La ocurrencia no se
    // vuelve a fechar por el reloj.
    const relanzado = periodKeyOf("recurring-due", "DAILY", refDate)
    expect(relanzado).toBe(primeraVez)
    // Y el reloj de la máquina, dos días más tarde, produciría OTRA clave: por
    // eso el `refDate` explícito es lo que hace inocuo el retraso (R-6).
    expect(periodKeyOf("recurring-due", "DAILY", T("2026-09-28T06:00:00Z"))).not.toBe(primeraVez)
  })
})

describe("isDue", () => {
  const spec = CRON_JOB_SPECS["recurring-due"]

  it("sin ejecución previa, toca", () => {
    expect(isDue(spec, null, T("2026-09-26T06:00:00Z"))).toBe(true)
  })

  it("ya ejecutado en este periodo, no toca (criterio 48)", () => {
    expect(isDue(spec, run(), T("2026-09-26T07:00:00Z"))).toBe(false)
  })

  it("periodo nuevo, toca", () => {
    expect(isDue(spec, run(), T("2026-09-27T06:00:00Z"))).toBe(true)
  })

  it("un PARTIAL SIEMPRE toca: si no, el troceado nunca termina (criterio 52)", () => {
    expect(isDue(spec, run({ status: "PARTIAL", finishedAt: null }), T("2026-09-26T06:10:00Z"))).toBe(true)
  })
})

describe("isStale — I-E11-12", () => {
  const spec = CRON_JOB_SPECS["recurring-due"]

  it("sin ejecución previa: está parado", () => {
    expect(isStale(spec, null, T("2026-09-26T06:00:00Z"))).toBe(true)
  })

  it("una cadencia de retraso se tolera (R-6: los schedule de GitHub llegan tarde)", () => {
    expect(isStale(spec, run(), T("2026-09-27T12:00:00Z"))).toBe(false)
  })

  it("más de dos cadencias sin explicación: reloj parado", () => {
    expect(isStale(spec, run(), T("2026-09-29T06:00:00Z"))).toBe(true)
  })

  it("un PARTIAL o un FAILED lo EXPLICAN: no es staleness, es un fallo con nombre", () => {
    expect(isStale(spec, run({ status: "PARTIAL" }), T("2026-10-30T06:00:00Z"))).toBe(false)
    expect(isStale(spec, run({ status: "FAILED" }), T("2026-10-30T06:00:00Z"))).toBe(false)
  })
})

describe("presupuesto", () => {
  it("240 s, con 60 s de reserva sobre el corte de Vercel", () => {
    expect(CRON_BUDGET_MS).toBe(240_000)
    expect(hasBudgetLeft(239_999)).toBe(true)
    expect(hasBudgetLeft(240_000)).toBe(false)
  })
})
