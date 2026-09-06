/**
 * E8 ronda 2 — el formato de fecha de pantalla es el MISMO en servidor y
 * navegador. El e2e de la bandeja lo destapó a las 22:5x UTC: React denunciaba
 * el desajuste de hidratación, regeneraba el árbol y la navegación por los
 * filtros se quedaba colgada. No era el arnés.
 */

import { describe, expect, it } from "vitest"

import { fechaHoraUtc, fechaUtc } from "@/lib/dates-ui"

describe("fechas de pantalla en UTC", () => {
  it("no depende de la zona del proceso: el mismo instante da el mismo día", () => {
    // 2026-09-06T22:55Z es el 7 de septiembre en Europe/Madrid (UTC+2). El
    // servidor formateaba 6 y el navegador 7, y de ahí el desajuste.
    const instante = "2026-09-06T22:55:00.000Z"
    expect(fechaUtc(instante)).toBe("6/9/2026")
    expect(fechaHoraUtc(instante)).toBe("6/9/2026, 22:55")
    // Y lo que `toLocaleDateString` habría dado en Madrid es otro día: por eso
    // no se usa para una fecha que se renderiza en los dos lados.
    expect(new Date(instante).toLocaleDateString("es-ES", { timeZone: "Europe/Madrid" })).toBe("7/9/2026")
  })

  it("acepta `Date` y cadena, y no revienta con una fecha inválida", () => {
    expect(fechaUtc(new Date("2026-01-02T00:00:00.000Z"))).toBe("2/1/2026")
    expect(fechaUtc("no es una fecha")).toBe("—")
    expect(fechaHoraUtc("no es una fecha")).toBe("—")
  })

  it("rellena la hora a dos dígitos", () => {
    expect(fechaHoraUtc("2026-03-04T05:06:00.000Z")).toBe("4/3/2026, 05:06")
  })
})
