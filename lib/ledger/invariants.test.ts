/**
 * E3 · T6 — Invariantes I1, I7–I10 e I-E3-1…7, y el sello.
 *
 * Se ejecutan sobre los dos fixtures inmutables y sobre casos inyectados a
 * propósito (un céntimo de más, un hueco de numeración, una edición por SQL).
 */

import { describe, expect, it } from "vitest"

import { entryHash } from "@/lib/ledger/hash"
import {
  checkI1,
  checkI7,
  checkI8,
  checkI9,
  checkI10,
  checkIE31,
  checkIE32,
  checkIE34,
  checkIE35,
  checkIE36,
  checkIE37,
  checkN5,
  hasFailures,
  InvariantInput,
  runInvariants,
  seal,
} from "@/lib/ledger/invariants"
import { TEMPLATE_CODES } from "@/lib/ledger/templates"
import type { PostedEntry } from "@/lib/ledger/types"
import { loadFixture } from "@/tests/support/fixtures"

const completo = loadFixture("ejercicio-completo")
const minimo = loadFixture("ejercicio-minimo")

const inputFor = (loaded: typeof completo, over: Partial<InvariantInput> = {}): InvariantInput => ({
  runId: "run-test",
  gitSha: "abc1234",
  organizationId: loaded.ctx.organizationId,
  ledgerHash: "0".repeat(64),
  entries: loaded.posted,
  fiscalYears: loaded.fiscalYears.map((fy) => ({
    ...fy,
    lastEntryNumber: Math.max(0, ...loaded.posted.filter((e) => e.fiscalYearId === fy.id).map((e) => e.entryNumber)),
  })),
  periodLocks: [],
  accounts: [...loaded.plan.byCode.values()].map((a) => ({
    code: a.code,
    isPostable: a.isPostable,
    isActive: a.isActive,
    organizationId: loaded.ctx.organizationId,
  })),
  knownTemplateCodes: TEMPLATE_CODES,
  ...over,
})

/** Copia profunda de un asiento, para poder corromperlo sin tocar el fixture. */
const clone = (entries: readonly PostedEntry[]): PostedEntry[] =>
  entries.map((e) => ({ ...e, lines: e.lines.map((l) => ({ ...l })) }))

describe("I1 — partida doble por asiento", () => {
  it("los 84 asientos del fixture completo pasan", () => {
    expect(checkI1(completo.posted).status).toBe("PASS")
  })

  it("caso vacío: sin asientos, PASS trivial", () => {
    expect(checkI1([]).status).toBe("PASS")
  })

  it("un céntimo de más: FAIL con el nº de asiento y la diferencia", () => {
    const corrupted = clone(minimo.posted)
    corrupted[1].lines[0].debitCents += 100
    const result = checkI1(corrupted)
    expect(result.status).toBe("FAIL")
    expect(result.evidencia).toContain(`asiento ${corrupted[1].entryNumber}`)
    expect(result.evidencia).toContain("100")
  })

  it("importes negativos: FAIL", () => {
    const corrupted = clone(minimo.posted)
    corrupted[1].lines[0].debitCents = -100
    corrupted[1].lines[1].creditCents = -100
    expect(checkI1(corrupted).status).toBe("FAIL")
  })

  it("asiento de una sola línea: FAIL", () => {
    const corrupted = clone(minimo.posted)
    corrupted[0].lines = [corrupted[0].lines[0]]
    expect(checkI1(corrupted).status).toBe("FAIL")
  })

  it("asiento con todo al debe: FAIL por falta de contrapartida", () => {
    const corrupted = clone(minimo.posted)
    corrupted[0].lines[1] = { ...corrupted[0].lines[1], debitCents: 500000, creditCents: 0 }
    expect(checkI1(corrupted).status).toBe("FAIL")
  })
})

describe("I7 — numeración contigua sin huecos", () => {
  it("ambos fixtures tienen numeración 1..n por ejercicio", () => {
    expect(checkI7(inputFor(completo)).status).toBe("PASS")
    expect(checkI7(inputFor(minimo)).status).toBe("PASS")
  })

  it("un hueco en la numeración: FAIL nombrando el número que falta", () => {
    const corrupted = clone(minimo.posted)
    corrupted[2].entryNumber = 99
    const result = checkI7(inputFor(minimo, { entries: corrupted }))
    expect(result.status).toBe("FAIL")
    expect(result.evidencia).toContain("huecos")
  })

  it("un número repetido: FAIL", () => {
    const corrupted = clone(minimo.posted)
    corrupted[2].entryNumber = corrupted[1].entryNumber
    expect(checkI7(inputFor(minimo, { entries: corrupted })).status).toBe("FAIL")
  })

  it("`lastEntryNumber` que no es el máximo: FAIL", () => {
    const input = inputFor(minimo)
    const result = checkI7({ ...input, fiscalYears: input.fiscalYears.map((fy) => ({ ...fy, lastEntryNumber: 99 })) })
    expect(result.status).toBe("FAIL")
  })

  it("N-5 es Info, no FAIL: un asiento con fecha retroactiva no rompe nada", () => {
    const corrupted = clone(minimo.posted)
    corrupted[2].entryDate = "2026-01-02"
    const result = checkN5(corrupted)
    expect(result.status).toBe("INFO")
    expect(result.evidencia).toContain("fuera de secuencia")
  })
})

describe("I8 — fechas", () => {
  it("los fixtures caen dentro de su ejercicio y no son futuros", () => {
    expect(checkI8(inputFor(completo), "2027-12-31").status).toBe("PASS")
  })

  it("una fecha fuera del ejercicio: FAIL", () => {
    const corrupted = clone(minimo.posted)
    corrupted[1].entryDate = "2027-03-10"
    corrupted[1].lines.forEach((l) => (l.entryDate = "2027-03-10"))
    expect(checkI8(inputFor(minimo, { entries: corrupted }), "2027-12-31").status).toBe("FAIL")
  })

  it("una fecha futura respecto de refDate: FAIL (O-8, sin excepción en E3)", () => {
    expect(checkI8(inputFor(minimo), "2026-06-30").status).toBe("FAIL")
  })

  it("la denormalización de la línea debe coincidir con el asiento", () => {
    const corrupted = clone(minimo.posted)
    corrupted[1].lines[0].entryDate = "2026-01-01"
    const result = checkI8(inputFor(minimo, { entries: corrupted }), "2027-12-31")
    expect(result.status).toBe("FAIL")
    expect(result.evidencia).toContain("denormalización")
  })

  it("la apertura va en el primer día del ejercicio y el cierre en el último", () => {
    const corrupted = clone(minimo.posted)
    corrupted[0].entryDate = "2026-01-15"
    corrupted[0].lines.forEach((l) => (l.entryDate = "2026-01-15"))
    expect(checkI8(inputFor(minimo, { entries: corrupted }), "2027-12-31").status).toBe("FAIL")
  })

  it("29-feb de un bisiesto es una fecha válida", () => {
    const corrupted = clone(minimo.posted)
    corrupted[1].entryDate = "2026-02-28"
    corrupted[1].lines.forEach((l) => (l.entryDate = "2026-02-28"))
    expect(checkI8(inputFor(minimo, { entries: corrupted }), "2027-12-31").status).toBe("PASS")
  })
})

describe("I9 — cuenta válida del plan", () => {
  it("el fixture mínimo referencia cuentas del plan", () => {
    expect(checkI9(inputFor(minimo)).status).toBe("PASS")
  })

  it("una cuenta que no está en el plan: FAIL", () => {
    const corrupted = clone(minimo.posted)
    corrupted[1].lines[0].accountCode = "999999"
    expect(checkI9(inputFor(minimo, { entries: corrupted })).status).toBe("FAIL")
  })

  it("una cuenta DESACTIVADA después no invalida el histórico (R-09)", () => {
    const input = inputFor(minimo)
    const accounts = input.accounts.map((a) => (a.code === "572" ? { ...a, isActive: false } : a))
    expect(checkI9({ ...input, accounts }).status).toBe("PASS")
  })

  it("una cuenta padre (no postable) sí es FAIL", () => {
    const input = inputFor(minimo)
    const accounts = input.accounts.map((a) => (a.code === "572" ? { ...a, isPostable: false } : a))
    expect(checkI9({ ...input, accounts }).status).toBe("FAIL")
  })
})

describe("I10 — aislamiento multi-tenant", () => {
  it("el fixture no cruza organizaciones", () => {
    expect(checkI10(inputFor(completo)).status).toBe("PASS")
  })

  it("un asiento de otra organización: FAIL", () => {
    const corrupted = clone(minimo.posted)
    corrupted[1].organizationId = "org-otra"
    expect(checkI10(inputFor(minimo, { entries: corrupted })).status).toBe("FAIL")
  })

  it("una cuenta de otra organización: FAIL", () => {
    const input = inputFor(minimo)
    const accounts = input.accounts.map((a) => (a.code === "572" ? { ...a, organizationId: "org-otra" } : a))
    expect(checkI10({ ...input, accounts }).status).toBe("FAIL")
  })
})

describe("I-E3-1 … I-E3-7", () => {
  it("I-E3-1: el contra-asiento del fixture es espejo exacto de su original", () => {
    expect(checkIE31(completo.posted).status).toBe("PASS")
  })

  it("I-E3-1: un espejo que no cuadra a 0 por cuenta es FAIL", () => {
    const corrupted = clone(completo.posted)
    const reversal = corrupted.find((e) => e.kind === "REVERSAL")!
    reversal.lines[0].debitCents += 1
    expect(checkIE31(corrupted).status).toBe("FAIL")
  })

  it("I-E3-2: dos contra-asientos sobre el mismo asiento es FAIL", () => {
    const corrupted = clone(completo.posted)
    const reversal = corrupted.find((e) => e.kind === "REVERSAL")!
    corrupted.push({ ...reversal, id: "entry-duplicado", entryNumber: 999 })
    expect(checkIE32(corrupted).status).toBe("FAIL")
    expect(checkIE32(completo.posted).status).toBe("PASS")
  })

  it("I-E3-4: anular un contra-asiento es FAIL", () => {
    const corrupted = clone(completo.posted)
    const reversal = corrupted.find((e) => e.kind === "REVERSAL")!
    corrupted.push({ ...reversal, id: "entry-x", entryNumber: 998, reversesEntryId: reversal.id })
    expect(checkIE34(corrupted).status).toBe("FAIL")
  })

  it("I-E3-5: cobertura 28/28 en el fixture completo", () => {
    const result = checkIE35(inputFor(completo, { requiredTemplateCoverage: 28 }))
    expect(result.status).toBe("PASS")
    expect(result.evidencia).toContain("28")
  })

  it("I-E3-5: una plantilla fuera del catálogo es FAIL", () => {
    const corrupted = clone(minimo.posted)
    corrupted[0].templateCode = "PLANTILLA_INVENTADA"
    expect(checkIE35(inputFor(minimo, { entries: corrupted })).status).toBe("FAIL")
  })

  it("I-E3-6: la apertura de 2027 es el espejo del cierre de 2026", () => {
    expect(checkIE36(inputFor(completo)).status).toBe("PASS")
  })

  it("I-E3-6: un céntimo de diferencia entre cierre y apertura es FAIL", () => {
    const corrupted = clone(completo.posted)
    const opening = corrupted.find((e) => e.kind === "OPENING" && e.entryDate >= "2027-01-01")!
    opening.lines[0].creditCents += 1
    expect(checkIE36(inputFor(completo, { entries: corrupted })).status).toBe("FAIL")
  })

  it("I-E3-7: el sello de contenido detecta una edición por SQL (criterio 14)", () => {
    expect(checkIE37(completo.posted).status).toBe("PASS")
    const corrupted = clone(minimo.posted)
    // Lo que haría un `UPDATE journal_lines SET debit_cents = … ` a mano.
    corrupted[1].lines[0].debitCents += 100
    const result = checkIE37(corrupted)
    expect(result.status).toBe("FAIL")
    expect(result.evidencia).toContain("hash almacenado")
  })

  it("I-E3-7: recalcular el hash tras la edición vuelve a cuadrar (R7)", () => {
    const corrupted = clone(minimo.posted)
    corrupted[1].lines[0].debitCents += 100
    corrupted[1].entryHash = entryHash(
      corrupted[1].lines.map((l) => ({
        entryId: corrupted[1].id,
        entryDate: corrupted[1].entryDate,
        entryNumber: corrupted[1].entryNumber,
        lineNo: l.lineNo,
        accountCode: l.accountCode,
        debitCents: l.debitCents,
        creditCents: l.creditCents,
        entryKind: corrupted[1].kind,
        fiscalYearId: l.fiscalYearId,
        taxRateId: l.taxRateId ?? null,
        taxBaseCents: l.taxBaseCents ?? null,
        counterpartyId: l.counterpartyId ?? null,
        dueDate: l.dueDate ?? null,
        description: l.description ?? null,
        analyticType: l.analyticType ?? null,
        projectId: l.projectId ?? null,
        costCenterId: l.costCenterId ?? null,
        businessLineId: l.businessLineId ?? null,
      }))
    )
    // El hash detecta corrupción NO intencionada, no a un atacante con acceso
    // de propietario: contra eso está FORCE + REVOKE UPDATE (§2.4).
    expect(checkIE37(corrupted).status).toBe("PASS")
  })
})

describe("runInvariants y validacion.json", () => {
  it("el fixture mínimo pasa todos los invariantes de E3", () => {
    const validacion = runInvariants(inputFor(minimo), "2027-12-31")
    expect(validacion.checks.filter((c) => c.status === "FAIL")).toEqual([])
    expect(hasFailures(validacion)).toBe(false)
  })

  it("el fixture completo pasa TODOS los invariantes de E3, sin excepciones", () => {
    const validacion = runInvariants(inputFor(completo, { requiredTemplateCoverage: 28 }), "2027-12-31")
    expect(validacion.checks.filter((c) => c.status === "FAIL")).toEqual([])
    expect(hasFailures(validacion)).toBe(false)
  })

  it("I9: las 326 líneas apuntan a una cuenta postable del plan PYMES", () => {
    expect(checkI9(inputFor(completo)).status).toBe("PASS")
  })

  it("tiene la forma `{run_id, checks: [{id, status, evidencia}]}` de la skill", () => {
    const validacion = runInvariants(inputFor(minimo), "2027-12-31")
    expect(validacion.run_id).toBe("run-test")
    expect(validacion.gitSha).toBe("abc1234")
    expect(validacion.ledgerHash).toHaveLength(64)
    for (const check of validacion.checks) {
      expect(check.id).toBeTruthy()
      expect(["PASS", "FAIL", "WARN", "INFO"]).toContain(check.status)
      expect(check.evidencia).toBeTruthy()
    }
    expect(validacion.checks.map((c) => c.id)).toEqual([
      "I1",
      "I7",
      "N-5",
      "I8",
      "I9",
      "I10",
      "I-E3-1",
      "I-E3-2",
      "I-E3-3",
      "I-E3-4",
      "I-E3-5",
      "I-E3-6",
      "I-E3-7",
    ])
  })

  it("caso vacío: un diario sin asientos no falla ningún invariante", () => {
    const validacion = runInvariants(inputFor(minimo, { entries: [] }), "2027-12-31")
    expect(hasFailures(validacion)).toBe(false)
  })
})

describe("sello (§5)", () => {
  const clean = runInvariants(inputFor(completo, { requiredTemplateCoverage: 28 }), "2027-12-31")

  it("todos PASS y mismo gitSha: VALIDADO AUTOMÁTICAMENTE", () => {
    expect(seal(clean, { gitSha: "abc1234", lastGitSha: "abc1234" })).toEqual({
      sello: "VALIDADO AUTOMÁTICAMENTE",
      motivos: [],
    })
  })

  it("cualquier FAIL: REQUIERE REVISIÓN nombrando el invariante", () => {
    const corrupted = clone(minimo.posted)
    corrupted[1].lines[0].debitCents += 100
    const validacion = runInvariants(inputFor(minimo, { entries: corrupted }), "2027-12-31")
    const result = seal(validacion, { gitSha: "abc1234", lastGitSha: "abc1234" })
    expect(result.sello).toBe("REQUIERE REVISIÓN")
    expect(result.motivos[0]).toContain("I1")
    expect(result.motivos[0]).toContain("I-E3-7")
  })

  it("primer run tras cambiar el motor: REQUIERE REVISIÓN", () => {
    const result = seal(clean, { gitSha: "nuevo", lastGitSha: "abc1234" })
    expect(result.sello).toBe("REQUIERE REVISIÓN")
    expect(result.motivos[0]).toContain("primer run tras cambiar el motor")
  })

  it("revisión forzada por configuración de la organización", () => {
    expect(seal(clean, { gitSha: "abc1234", lastGitSha: "abc1234", forceReview: true }).sello).toBe("REQUIERE REVISIÓN")
  })

  it("sin `lastGitSha` (primer run del histórico) no se exige revisión por ese motivo", () => {
    expect(seal(clean, { gitSha: "abc1234" }).sello).toBe("VALIDADO AUTOMÁTICAMENTE")
  })

  // Revisión ronda 1 (#4): sin git-sha no hay trazabilidad del motor.
  it.each(["", "desconocido", "unknown", "dev", "HEAD", "  "])(
    "git-sha desconocido (%j): REQUIERE REVISIÓN aunque todo esté en PASS",
    (gitSha) => {
      const result = seal(clean, { gitSha })
      expect(result.sello).toBe("REQUIERE REVISIÓN")
      expect(result.motivos.join(" ")).toMatch(/git-sha del motor desconocido/)
    }
  )

  it("un git-sha real no añade ese motivo", () => {
    expect(seal(clean, { gitSha: "c0e828f" }).motivos).toEqual([])
  })
})
