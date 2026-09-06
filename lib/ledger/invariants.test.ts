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
  checkIE81,
  checkIE82,
  checkIE84,
  checkIE89,
  checkIE810,
  checkIE815a,
  checkIE815b,
  checkIE815c,
  checkIE816,
  checkIE817,
  checkIE820,
  checkIE87b,
  checkN5,
  dataQualityWarnings,
  checkIE87a,
  checkIE811,
  contrastOf,
  runDocumentInvariants,
  vatBookRowFromEntry,
  vatBookRowFromProposal,
  E8_INVARIANT_IDS,
  E8_SEAL_REASONS,
  type DocumentsInvariantInput,
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
      razones: [],
    })
  })

  it("el git-sha desconocido se etiqueta ENTORNO, no como descuadre (auditor 5)", () => {
    const result = seal(clean, { gitSha: "desconocido" })
    expect(result.sello).toBe("REQUIERE REVISIÓN")
    expect(result.razones).toHaveLength(1)
    expect(result.razones[0].kind).toBe("ENTORNO")
    expect(result.razones[0].message).toMatch(/^ENTORNO · /)
    expect(result.razones.some((r) => r.kind === "INVARIANTE")).toBe(false)
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

// ─────────────────────────────────────────────────────────────────────────────
// E8 · T14 — I-E8-1…20, los tres puentes al 303 y el puente al 111/115
// ─────────────────────────────────────────────────────────────────────────────

describe("E8 · bloque documental", () => {
  const RUN_ID = "run-e8-1"
  const FILE_ID = "file-e8-1"
  const ENTRY_ID = "entry-e8-1"
  const SHA = "a".repeat(64)

  /**
   * Un documento correcto: factura recibida de 1 000 + 210 de IVA deducible,
   * recibida en el trimestre siguiente al de expedición (el caso C01 del
   * fixture sellado). Cada test lo corrompe por un sitio distinto — que es lo
   * que hace por SQL quien edita la base a mano.
   */
  const baseDocuments = (): DocumentsInvariantInput => ({
    runs: [
      {
        id: RUN_ID,
        fileId: FILE_ID,
        fileSha256: SHA,
        kind: "LLM",
        partial: false,
        reconcileStatus: "PASS",
        promptSha: "b".repeat(64),
        provider: "openai",
        quotaDeviationsCents: {},
        fieldConfidences: ["verificado", "interpretacion_ia"],
      },
    ],
    transactions: [
      {
        id: "tx-e8-1",
        status: "POSTED",
        journalEntryId: ENTRY_ID,
        voidedEntryId: null,
        fileId: FILE_ID,
        splitParentTransactionId: null,
        currency: "EUR",
        totalCents: 121000,
        convertedTotalCents: null,
        exchangeRateMicro: null,
        rateDate: null,
        rateSource: null,
        extractionRunId: RUN_ID,
      },
    ],
    files: [{ id: FILE_ID, sha256: SHA, diskSha256: SHA }],
    vatBook: [
      {
        entryId: ENTRY_ID,
        ivaPeriod: "2026-Q2",
        tipo: "RECIBIDAS",
        baseCents: 100000,
        cuotaTotalCents: 21000,
        cuotaDeducibleCents: 21000,
        cuotaNoDeducibleAlCosteCents: 0,
        cuotaRepercutidaCents: 0,
        cuotaDevengadaIspAibCents: 0,
        documentDate: "2026-03-28",
        deductionDate: "2026-05-04",
        /**
         * Ronda 1 (auditor H-1/H-2): la anotación sale del ASIENTO y lleva
         * como contraste la derivada del DOCUMENTO. I-E8-7a compara las dos.
         */
        contrast: {
          baseCents: 100000,
          cuotaTotalCents: 21000,
          cuotaDeducibleCents: 21000,
          cuotaNoDeducibleAlCosteCents: 0,
          cuotaRepercutidaCents: 0,
          cuotaDevengadaIspAibCents: 0,
        },
      },
    ],
    vatBalances: [{ ivaPeriod: "2026-Q2", saldo472Cents: 21000, saldo477Cents: 0 }],
    withholdings: [{ period: "2026-Q1", model: "111", practicadoCents: 15000, abonado4751Cents: 15000 }],
    exchangeRates: [
      { id: "rate-1", date: "2026-11-20", from: "USD", to: "EUR", rateMicro: BigInt(925926), source: "ECB_FRANKFURTER" },
    ],
    invoiceSeries: [{ code: "FV", kind: "ORDINARIA", numbers: [{ number: 1, date: "2026-01-10" }, { number: 2, date: "2026-02-10" }] }],
    duplicates: [],
    accounts: { inputVat: "472", outputVat: "477", withholding: "4751" },
  })

  const documentEntry = (): PostedEntry => ({
    id: ENTRY_ID,
    organizationId: "org-test",
    fiscalYearId: "fy-2026",
    entryNumber: 1,
    documentDate: "2026-03-28",
    accrualDate: null,
    entryDate: "2026-03-28",
    receptionDate: "2026-05-04",
    description: "Factura recibida F-2026-0001",
    kind: "NORMAL",
    taxRoundingMode: "PER_TIPO",
    sourceType: "INVOICE_IN",
    fileId: FILE_ID,
    extractionRunId: RUN_ID,
    lines: [
      lineOf(1, "607", 100000, 0),
      lineOf(2, "472", 21000, 0),
      lineOf(3, "400", 0, 121000),
    ],
  })

  function lineOf(lineNo: number, accountCode: string, debitCents: number, creditCents: number) {
    return {
      lineNo,
      accountCode,
      debitCents,
      creditCents,
      entryDate: "2026-03-28",
      fiscalYearId: "fy-2026",
      entryKind: "NORMAL" as const,
    }
  }

  const statusOf = (checks: readonly { id: string; status: string }[], id: string): string | undefined =>
    checks.find((c) => c.id === id)?.status

  it("el documento correcto pasa los veintitrés checks del bloque", () => {
    const checks = runDocumentInvariants(baseDocuments(), [documentEntry()], "EUR")
    expect(checks.map((c) => c.id)).toEqual(E8_INVARIANT_IDS)
    expect(checks.filter((c) => c.status === "FAIL")).toEqual([])
    expect(statusOf(checks, "I-E8-15a")).toBe("PASS")
    expect(statusOf(checks, "I-E8-15b")).toBe("PASS")
    expect(statusOf(checks, "I-E8-15c")).toBe("PASS")
  })

  it("run editado por SQL a FAIL: el asiento deja de estar respaldado (I-E8-1)", () => {
    const docs = baseDocuments()
    const runs = docs.runs.map((r) => ({ ...r, reconcileStatus: "FAIL" as const }))
    const result = checkIE81([documentEntry()], runs)
    expect(result.status).toBe("FAIL")
    expect(result.evidencia).toContain("FAIL")
  })

  it("run editado por SQL a IMPORTED o a parcial: tampoco respalda un asiento", () => {
    for (const patch of [{ kind: "IMPORTED" as const }, { partial: true }]) {
      const runs = baseDocuments().runs.map((r) => ({ ...r, ...patch }))
      expect(checkIE81([documentEntry()], runs).status).toBe("FAIL")
    }
  })

  it("sha256 alterado por SQL: el documento ya no es el que se analizó (I-E8-2)", () => {
    const docs = baseDocuments()
    docs.files[0] = { id: FILE_ID, sha256: "c".repeat(64), diskSha256: "c".repeat(64) }
    const result = checkIE82(docs, [documentEntry()])
    expect(result.status).toBe("FAIL")
    expect(result.evidencia).toContain("documento alterado")
  })

  it("bytes en disco distintos de los registrados: también FAIL", () => {
    const docs = baseDocuments()
    docs.files[0] = { id: FILE_ID, sha256: SHA, diskSha256: "d".repeat(64) }
    expect(checkIE82(docs, [documentEntry()]).status).toBe("FAIL")
  })

  it("sin sha en disco no se miente con un PASS: es WARN", () => {
    const docs = baseDocuments()
    docs.files[0] = { id: FILE_ID, sha256: SHA }
    expect(checkIE82(docs, [documentEntry()]).status).toBe("WARN")
  })

  it("POSTED sin asiento, VOID sin anulado y PROPOSED con asiento (I-E8-4)", () => {
    const docs = baseDocuments()
    const t = docs.transactions[0]
    expect(checkIE84({ ...docs, transactions: [{ ...t, journalEntryId: null }] }).status).toBe("FAIL")
    expect(
      checkIE84({ ...docs, transactions: [{ ...t, status: "VOID", journalEntryId: null, voidedEntryId: null }] }).status
    ).toBe("FAIL")
    expect(checkIE84({ ...docs, transactions: [{ ...t, status: "PROPOSED" }] }).status).toBe("FAIL")
    expect(
      checkIE84({ ...docs, transactions: [t, { ...t, id: "tx-e8-2" }] }).evidencia
    ).toContain("vivo en dos transacciones")
  })

  it("un fichero sin sha256 no puede tener run LLM ni asiento (I-E8-9)", () => {
    const docs = baseDocuments()
    docs.files[0] = { id: FILE_ID, sha256: null }
    const result = checkIE89(docs, [documentEntry()])
    expect(result.status).toBe("FAIL")
    expect(result.evidencia).toContain("sin sha256")
  })

  it("un run parcial no tiene ni un campo calculado ni verificado (I-E8-10)", () => {
    const docs = baseDocuments()
    const runs = docs.runs.map((r) => ({ ...r, partial: true }))
    const result = checkIE810({ ...docs, runs }, [documentEntry()])
    expect(result.status).toBe("FAIL")
    expect(result.evidencia).toContain("campo(s) calculado/verificado")
  })

  it("I-E8-15a · una cuota deducible que no llega a 472 rompe el puente al 303", () => {
    const docs = baseDocuments()
    docs.vatBalances = [{ ivaPeriod: "2026-Q2", saldo472Cents: 20999, saldo477Cents: 0 }]
    const result = checkIE815a(docs)
    expect(result.status).toBe("FAIL")
    expect(result.evidencia).toContain("2026-Q2")
  })

  it("I-E8-15b · un ticket no deducible NO rompe el puente: engorda el coste", () => {
    const docs = baseDocuments()
    docs.vatBook = [
      {
        ...docs.vatBook[0],
        cuotaTotalCents: 112,
        cuotaDeducibleCents: 0,
        cuotaNoDeducibleAlCosteCents: 112,
      },
    ]
    docs.vatBalances = [{ ivaPeriod: "2026-Q2", saldo472Cents: 0, saldo477Cents: 0 }]
    expect(checkIE815a(docs).status).toBe("PASS")
    expect(checkIE815b(docs).status).toBe("PASS")
  })

  it("I-E8-15b · una cuota no deducible que se PIERDE sí lo rompe", () => {
    const docs = baseDocuments()
    docs.vatBook = [{ ...docs.vatBook[0], cuotaTotalCents: 112, cuotaDeducibleCents: 0, cuotaNoDeducibleAlCosteCents: 0 }]
    docs.vatBalances = [{ ivaPeriod: "2026-Q2", saldo472Cents: 0, saldo477Cents: 0 }]
    expect(checkIE815b(docs).status).toBe("FAIL")
  })

  it("I-E8-15c · el 477 de una autorrepercusión viene del libro de RECIBIDAS (OBS-F1)", () => {
    const docs = baseDocuments()
    docs.vatBook = [
      {
        ...docs.vatBook[0],
        ivaPeriod: "2026-Q4",
        cuotaTotalCents: 63000,
        cuotaDeducibleCents: 63000,
        cuotaDevengadaIspAibCents: 63000,
      },
    ]
    docs.vatBalances = [{ ivaPeriod: "2026-Q4", saldo472Cents: 63000, saldo477Cents: 63000 }]
    expect(checkIE815c(docs).status).toBe("PASS")
    // Sin el término de ISP, el mismo asiento correcto daría FAIL.
    const sinIsp = { ...docs, vatBook: [{ ...docs.vatBook[0], cuotaDevengadaIspAibCents: 0 }] }
    expect(checkIE815c(sinIsp).status).toBe("FAIL")
  })

  it("I-E8-16 · nada se deduce pasados cuatro años (art. 99.Cinco LIVA)", () => {
    const docs = baseDocuments()
    docs.vatBook = [{ ...docs.vatBook[0], documentDate: "2021-03-28", deductionDate: "2026-05-04" }]
    expect(checkIE816(docs).status).toBe("FAIL")
  })

  it("I-E8-17 · la retención practicada es la abonada a 4751", () => {
    const docs = baseDocuments()
    expect(checkIE817(docs).status).toBe("PASS")
    docs.withholdings = [{ period: "2026-Q1", model: "111", practicadoCents: 15000, abonado4751Cents: 0 }]
    expect(checkIE817(docs).status).toBe("FAIL")
  })

  it("I-E8-20 · un hueco en la serie es FAIL; una serie sin emitir todavía, INFO", () => {
    const docs = baseDocuments()
    docs.invoiceSeries = [{ code: "FV", kind: "ORDINARIA", numbers: [{ number: 1, date: "2026-01-10" }, { number: 3, date: "2026-02-10" }] }]
    expect(checkIE820(docs).status).toBe("FAIL")
    expect(checkIE820({ ...docs, invoiceSeries: [{ code: "FV", kind: "ORDINARIA", numbers: [] }] }).status).toBe("INFO")
  })

  it("I-E8-7b es una MÉTRICA: un céntimo de desviación nunca es FAIL", () => {
    const docs = baseDocuments()
    docs.runs = docs.runs.map((r) => ({ ...r, quotaDeviationsCents: { IVA_21: 1, IVA_10: -1 } }))
    const result = checkIE87b(docs)
    expect(result.status).toBe("WARN")
    expect(result.evidencia).toContain("openai")
  })

  it("los WARN de calidad que E7 pinta salen del mismo bloque", () => {
    const docs = baseDocuments()
    docs.runs = [
      { ...docs.runs[0], partial: true, warnings: ["DEDUCIBILIDAD_PENDIENTE"] },
      { ...docs.runs[0], id: "run-2", reconcileStatus: "FAIL", warnings: ["TICKET_CUALIFICADO"] },
    ]
    const codes = dataQualityWarnings(docs).map((w) => w.code)
    expect(codes).toContain("EXTRACCION_PARCIAL")
    expect(codes).toContain("RUN_FAIL_SIN_RESOLVER")
    expect(codes).toContain("DEDUCIBILIDAD_PENDIENTE")
    expect(codes).toContain("TICKET_CUALIFICADO")
  })

  it("el libro registro derivado del DOCUMENTO reproduce el del asiento", () => {
    const row = vatBookRowFromProposal(
      {
        docKind: "TICKET",
        lines: [{ kind: "OPERACION", baseCents: 1122, taxRateCode: "IVA_10", deductibility: "NONE" }],
        taxes: [{ taxRateCode: "IVA_10", baseCents: 1122, quotaCents: 112 }],
      },
      { entryId: "e", ivaPeriod: "2026-Q2", documentDate: "2026-05-06", deductionDate: "2026-05-06", prorrataBps: null }
    )
    expect(row).toMatchObject({
      tipo: "RECIBIDAS",
      baseCents: 1122,
      cuotaTotalCents: 112,
      cuotaDeducibleCents: 0,
      cuotaNoDeducibleAlCosteCents: 112,
    })
  })

  it("el anticipo de cliente sin cobro no anota cuota devengada (OBS-F2)", () => {
    const row = vatBookRowFromProposal(
      {
        docKind: "FACTURA_ANTICIPO_CLIENTE",
        lines: [{ kind: "OPERACION", baseCents: 1000000, taxRateCode: "IVA_21" }],
        taxes: [{ taxRateCode: "IVA_21", baseCents: 1000000, quotaCents: 210000 }],
      },
      {
        entryId: "e",
        ivaPeriod: "2026-Q4",
        documentDate: "2026-12-10",
        deductionDate: "2026-12-10",
        prorrataBps: null,
        deferredByRc25: true,
      }
    )
    expect(row.cuotaRepercutidaCents).toBe(0)
    expect(row.baseCents).toBe(0)
  })

  it("los seis motivos de sello de E8 viajan en el sello del periodo (ADR-0014 D7)", () => {
    const validacion = runInvariants(inputFor(minimo), "2027-12-31")
    const result = seal(validacion, {
      gitSha: "abc1234",
      lastGitSha: "abc1234",
      documentReasons: ["RETENCION_NO_PRACTICADA", "DOCUMENTO_ALTERADO"],
    })
    expect(result.sello).toBe("REQUIERE REVISIÓN")
    expect(result.razones.filter((r) => r.kind === "DOCUMENTO").map((r) => r.code)).toEqual([
      "DOCUMENTO_ALTERADO",
      "RETENCION_NO_PRACTICADA",
    ])
    expect(E8_SEAL_REASONS).toHaveLength(6)
  })

  it("`runInvariants` cablea el bloque sólo cuando el llamante lo aporta", () => {
    const sinDocumentos = runInvariants(inputFor(minimo), "2027-12-31")
    expect(sinDocumentos.checks.some((c) => c.id.startsWith("I-E8-"))).toBe(false)
    const conDocumentos = runInvariants(
      inputFor(minimo, { documents: baseDocuments(), baseCurrency: "EUR", entries: [documentEntry()] }),
      "2027-12-31"
    )
    expect(conDocumentos.checks.filter((c) => c.id.startsWith("I-E8-")).map((c) => c.id)).toEqual(E8_INVARIANT_IDS)
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // E8 · ronda 1 de corrección — el libro registro sale del ASIENTO y la
  // propuesta CONTRASTA (auditor H-1, H-2 y H-5)
  // ─────────────────────────────────────────────────────────────────────────────

  describe("E8 ronda 1 · libro registro derivado del asiento, propuesta como contraste", () => {
    const opts = {
      entryId: "entry-fx",
      ivaPeriod: "2026-Q4",
      documentDate: "2026-11-20",
      deductionDate: "2026-11-23",
      prorrataBps: null,
    } as const

    /** C12 del fixture: 10 000,00 USD al 21 % y al 10 %, tasa 925 926 µ. */
    const c12: import("@/lib/ledger/invariants").BookableProposal = {
      docKind: "FACTURA_RECIBIDA",
      lines: [
        { kind: "OPERACION", baseCents: 500_000, taxRateCode: "IVA_21", deductibility: "FULL" },
        { kind: "OPERACION", baseCents: 359_091, taxRateCode: "IVA_10", deductibility: "FULL" },
      ],
      taxes: [
        { taxRateCode: "IVA_21", baseCents: 500_000, quotaCents: 105_000 },
        { taxRateCode: "IVA_10", baseCents: 359_091, quotaCents: 35_909 },
      ],
    }

    const fxEntry = (): PostedEntry => ({
      id: "entry-fx",
      organizationId: "org-test",
      fiscalYearId: "fy-2026",
      entryNumber: 12,
      documentDate: "2026-11-20",
      accrualDate: null,
      entryDate: "2026-11-20",
      receptionDate: "2026-11-23",
      description: "C12 · factura en dólares",
      kind: "NORMAL",
      taxRoundingMode: "PER_TIPO",
      sourceType: "INVOICE_IN",
      lines: [
        { lineNo: 1, accountCode: "600", debitCents: 462963, creditCents: 0, entryDate: "2026-11-20", fiscalYearId: "fy-2026", entryKind: "NORMAL" },
        { lineNo: 2, accountCode: "600", debitCents: 332492, creditCents: 0, entryDate: "2026-11-20", fiscalYearId: "fy-2026", entryKind: "NORMAL" },
        { lineNo: 3, accountCode: "472", debitCents: 97222, creditCents: 0, entryDate: "2026-11-20", fiscalYearId: "fy-2026", entryKind: "NORMAL" },
        { lineNo: 4, accountCode: "472", debitCents: 33249, creditCents: 0, entryDate: "2026-11-20", fiscalYearId: "fy-2026", entryKind: "NORMAL" },
        { lineNo: 5, accountCode: "400", debitCents: 0, creditCents: 925926, entryDate: "2026-11-20", fiscalYearId: "fy-2026", entryKind: "NORMAL" },
      ],
    })

    it("H-1 · sin tasa, la anotación del documento sigue en DÓLARES y no cuadra con el diario", () => {
      const sinTasa = vatBookRowFromProposal(c12, opts)
      expect(sinTasa.cuotaDeducibleCents).toBe(140_909) // 105 000 + 35 909, en USD
      // Que es justo la diferencia de −10 438 que el auditor midió contra el diario.
      expect(sinTasa.cuotaDeducibleCents - 130_471).toBe(10_438)
    })

    it("H-1 · con la tasa persistida, la anotación del documento llega en euros al céntimo del asiento", () => {
      const conTasa = vatBookRowFromProposal(c12, { ...opts, rateMicro: BigInt(925_926) })
      expect(conTasa.cuotaDeducibleCents).toBe(130_471)
      expect(conTasa.baseCents).toBe(795_455)

      const delAsiento = vatBookRowFromEntry(fxEntry(), {
        ...opts,
        rateMicro: BigInt(925_926),
        inputVatCode: "472",
        outputVatCode: "477",
        purchase: true,
        selfCharged: false,
        contrast: contrastOf(conTasa),
      })
      expect(delAsiento.cuotaDeducibleCents).toBe(130_471)
      const r = checkIE87a({ ...baseDocuments(), vatBook: [delAsiento] }, [fxEntry()])
      expect(r.status).toBe("PASS")
    })

    it("H-1 · si la conversión del documento no es la del asiento, I-E8-7a lo dice con la diferencia", () => {
      const malConvertido = vatBookRowFromProposal(c12, opts) // sin tasa: en dólares
      const delAsiento = vatBookRowFromEntry(fxEntry(), {
        ...opts,
        inputVatCode: "472",
        outputVatCode: "477",
        purchase: true,
        selfCharged: false,
        contrast: contrastOf(malConvertido),
      })
      const r = checkIE87a({ ...baseDocuments(), vatBook: [delAsiento] }, [fxEntry()])
      expect(r.status).toBe("FAIL")
      expect(r.evidencia).toMatch(/cuota deducible/)
      expect(r.evidencia).toMatch(/-10438/)
    })

    it("H-2 · rectificativa por SUSTITUCIÓN: la anotación es la DIFERENCIA, no la cuota del sustituto", () => {
      // C07: factura original de 100 000 + 21 000 sustituida por otra de 80 000.
      const c07: import("@/lib/ledger/invariants").BookableProposal = {
        docKind: "ABONO_EMITIDO",
        lines: [{ kind: "OPERACION", baseCents: 80_000, taxRateCode: "IVA_21" }],
        taxes: [{ taxRateCode: "IVA_21", baseCents: 80_000, quotaCents: 16_800 }],
      }
      const sinDelta = vatBookRowFromProposal(c07, { ...opts, ivaPeriod: "2026-Q3" })
      expect(sinDelta.cuotaRepercutidaCents).toBe(-16_800)

      const conDelta = vatBookRowFromProposal(c07, {
        ...opts,
        ivaPeriod: "2026-Q3",
        rectificationDelta: { baseByRate: { IVA_21: 20_000 }, quotaByRate: { IVA_21: 4_200 } },
      })
      expect(conDelta.cuotaRepercutidaCents).toBe(-4_200)
      // La diferencia entre las dos derivaciones es el +12 600 que rompía I-E8-15c.
      expect(conDelta.cuotaRepercutidaCents - sinDelta.cuotaRepercutidaCents).toBe(12_600)
    })

    it("sin contraste, I-E8-7a no miente con un PASS: avisa de que no ha podido comparar", () => {
      const docs = baseDocuments()
      docs.vatBook = docs.vatBook.map((row) => ({ ...row, contrast: null }))
      const r = checkIE87a(docs, [documentEntry()])
      expect(r.status).toBe("WARN")
      expect(r.evidencia).toMatch(/sin propuesta reconstruible/)
    })

    it("H-5 · I-E8-11 recomputa `proposal_sha` y delata un run editado después de sellarse", () => {
      const docs = baseDocuments()
      docs.runs = [{ ...docs.runs[0], proposalSha: "1".repeat(64), proposalShaExpected: "1".repeat(64) }]
      expect(checkIE811(docs).status).toBe("PASS")

      docs.runs = [{ ...docs.runs[0], proposalSha: "1".repeat(64), proposalShaExpected: "2".repeat(64) }]
      const r = checkIE811(docs)
      expect(r.status).toBe("FAIL")
      expect(r.evidencia).toMatch(/proposal_sha/)
      expect(r.evidencia).toMatch(/editado después de sellarse/)
    })

    it("H-5 · el sello del ESQUEMA también se recomputa cuando la versión es la vigente", () => {
      const docs = baseDocuments()
      docs.runs = [{ ...docs.runs[0], schemaSha: "a".repeat(64), schemaShaExpected: "b".repeat(64) }]
      expect(checkIE811(docs).evidencia).toMatch(/schema_sha/)
    })

    it("H-3 · un fichero que respalda un asiento y ya no se puede leer del almacén es FAIL, no WARN", () => {
      const docs = baseDocuments()
      docs.files = [{ id: docs.files[0].id, sha256: docs.files[0].sha256, path: "unsorted/x.pdf", diskError: "el fichero no está en el almacén" }]
      const r = checkIE82(docs, [documentEntry()])
      expect(r.status).toBe("FAIL")
      expect(r.evidencia).toMatch(/unsorted\/x\.pdf/)
      expect(r.evidencia).toMatch(/no está en el almacén/)
    })
  })

})
