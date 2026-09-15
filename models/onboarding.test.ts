/**
 * E11 · ola C · T12 — las piezas PURAS de `models/onboarding.ts`.
 *
 * Lo que aquí se prueba no toca la base: el año natural del ejercicio
 * provisional, el prefijo de la rectificativa y el parseo de los correos del
 * paso 4. La siembra completa y las nueve piezas se prueban contra Postgres en
 * `tests/e2e/onboarding-plataforma.spec.ts` y las vuelve a comprobar I-E11-10.
 */

import { describe, expect, it } from "vitest"
import { SEED_PIECES, naturalYearWindow, parseMemberInvites, rectificativePrefixOf } from "@/models/onboarding"
import { Role } from "@/prisma/client"

describe("naturalYearWindow() — el ejercicio provisional (O-7b)", () => {
  it("es el año natural de la fecha, de enero a diciembre", () => {
    expect(naturalYearWindow(new Date("2026-09-15T10:00:00.000Z"))).toEqual({
      code: "2026",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    })
  })

  it("el 31 de diciembre sigue siendo su propio año, no el siguiente", () => {
    expect(naturalYearWindow(new Date("2026-12-31T23:59:59.000Z")).code).toBe("2026")
  })

  it("y el 1 de enero también: la ventana se deriva en UTC, no de la zona del navegador", () => {
    expect(naturalYearWindow(new Date("2027-01-01T00:00:00.000Z")).startDate).toBe("2027-01-01")
  })
})

describe("rectificativePrefixOf() — el prefijo de la rectificativa", () => {
  it("es el de la ordinaria con el sufijo -R", () => {
    expect(rectificativePrefixOf("FAC")).toBe("FAC-R")
  })

  it("no supera los 16 caracteres que admite la columna", () => {
    expect(rectificativePrefixOf("ABCDEFGHIJKLMNOP").length).toBeLessThanOrEqual(16)
  })
})

describe("parseMemberInvites() — los correos del paso 4", () => {
  it("admite coma, punto y coma, espacio y salto de línea", () => {
    const invites = parseMemberInvites("ana@x.es, luis@x.es; eva@x.es\nmar@x.es")
    expect(invites.map((i) => i.email)).toEqual(["ana@x.es", "luis@x.es", "eva@x.es", "mar@x.es"])
  })

  it("normaliza a minúsculas y no repite a nadie", () => {
    const invites = parseMemberInvites("Ana@X.es, ana@x.es")
    expect(invites).toHaveLength(1)
    expect(invites[0].email).toBe("ana@x.es")
  })

  it("descarta lo que no es un correo en vez de invitarlo", () => {
    expect(parseMemberInvites("ana@x.es, no-es-un-correo, , @")).toHaveLength(1)
  })

  it("lleva el rol que se le pase, no uno inventado", () => {
    expect(parseMemberInvites("ana@x.es", Role.VIEWER)[0].role).toBe(Role.VIEWER)
  })

  it("una cadena vacía no invita a nadie: el paso es saltable", () => {
    expect(parseMemberInvites("   ")).toEqual([])
  })
})

describe("SEED_PIECES — las NUEVE piezas de I-E11-10 (O-7c)", () => {
  it("son nueve, y no siete: `TaxRate` y `Currency` entraron con O-7c", () => {
    expect(SEED_PIECES).toHaveLength(9)
    expect(SEED_PIECES).toContain("taxRates")
    expect(SEED_PIECES).toContain("currency")
  })

  it("no hay ninguna repetida", () => {
    expect(new Set(SEED_PIECES).size).toBe(SEED_PIECES.length)
  })
})
