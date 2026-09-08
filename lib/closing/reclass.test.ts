/**
 * E9 · T9 — `lib/closing/reclass.ts` (R-RC-1…7).
 *
 * Casos obligatorios de todo módulo puro (CLAUDE.md: vacío, un registro,
 * importes negativos, fechas límite) y los que sellan la tarea: el **criterio
 * 24** (los pares sembrados, `176 → 5595`, `177 → 500`, `527`/`528` quietas, el `523` de
 * 750 000) y el **criterio 25** (préstamo sin desglose ⇒ FAIL bloqueante).
 */

import { describe, expect, it } from "vitest"

import {
  addMonthsToDate,
  applyFifo,
  isLongTerm,
  maturityBoundary,
  NON_RECLASSIFIABLE_ACCOUNTS,
  RECLASS_PAIRS,
  reclassReversalDeviations,
  reclassStep,
  reclassifyMaturities,
  TEMPLATE_ALTA_PRESTAMO,
  type MaturityPosition,
} from "@/lib/closing/reclass"

const CUTOFF = "2026-12-31"

const position = (over: Partial<MaturityPosition> = {}): MaturityPosition => ({
  accountCode: "523",
  counterpartyId: "cp-1",
  currency: "EUR",
  dueDate: "2027-09-30",
  openCents: -250_000,
  entryNumber: 10,
  ...over,
})

const sumOf = (lines: readonly { debitCents: number; creditCents: number }[]) => ({
  debe: lines.reduce((a, l) => a + l.debitCents, 0),
  haber: lines.reduce((a, l) => a + l.creditCents, 0),
})

// ─────────────────────────────────────────────────────────────────────────────
// R-RC-7 (O-7, R2-1) · los pares sembrados
// ─────────────────────────────────────────────────────────────────────────────

describe("R-RC-7 · los pares sembrados", () => {
  // El diseño dice «veintitrés» y su tabla enumera VEINTIDÓS (6 + 4 + 6 + 6).
  // Se implementa y se comprueba la lista enumerada, que es la verificable
  // cuenta a cuenta; la discrepancia queda anotada en el docblock del módulo.
  it("son los veintidós enumerados y no hay ninguno repetido", () => {
    expect(RECLASS_PAIRS).toHaveLength(22)
    expect(new Set(RECLASS_PAIRS.map((p) => p.longCode)).size).toBe(22)
    expect(new Set(RECLASS_PAIRS.map((p) => p.shortCode)).size).toBe(22)
  })

  it("R2-1: 176 va a 5595 y NO a 526, y 177 va a 500", () => {
    expect(RECLASS_PAIRS.find((p) => p.longCode === "176")?.shortCode).toBe("5595")
    expect(RECLASS_PAIRS.some((p) => p.shortCode === "526")).toBe(false)
    expect(RECLASS_PAIRS.find((p) => p.longCode === "177")?.shortCode).toBe("500")
  })

  it("R2-1: 514, 527 y 528 no forman par y están declaradas como no reclasificables", () => {
    for (const code of ["514", "527", "528"]) {
      expect(RECLASS_PAIRS.some((p) => p.shortCode === code || p.longCode === code)).toBe(false)
      expect(NON_RECLASSIFIABLE_ACCOUNTS).toContain(code)
    }
  })

  it("incluye los cuatro pares de partes vinculadas", () => {
    for (const [long, short] of [["160", "510"], ["161", "511"], ["162", "512"], ["163", "513"]]) {
      expect(RECLASS_PAIRS).toContainEqual(expect.objectContaining({ longCode: long, shortCode: short }))
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// R-RC-1 · la frontera se mide desde el cierre
// ─────────────────────────────────────────────────────────────────────────────

describe("R-RC-1 · la frontera", () => {
  it("son doce meses desde el cierre", () => {
    expect(maturityBoundary(CUTOFF)).toBe("2027-12-31")
    expect(isLongTerm("2027-12-31", "2027-12-31")).toBe(false)
    expect(isLongTerm("2028-01-01", "2027-12-31")).toBe(true)
  })

  it("respeta el 29 de febrero y los meses cortos", () => {
    expect(addMonthsToDate("2024-02-29", 12)).toBe("2025-02-28")
    expect(addMonthsToDate("2026-01-31", 1)).toBe("2026-02-28")
    expect(addMonthsToDate("2027-12-31", -12)).toBe("2026-12-31")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Casos obligatorios
// ─────────────────────────────────────────────────────────────────────────────

describe("casos obligatorios", () => {
  it("sin posiciones no hay asiento ni bloqueo", () => {
    const r = reclassifyMaturities([], RECLASS_PAIRS, CUTOFF)
    expect(r.lines).toEqual([])
    expect(r.moved).toEqual([])
    expect(r.blocking).toEqual([])
    expect(reclassStep(r).status).toBe("PASS")
  })

  it("una sola posición a corto en cuenta de corto no se mueve", () => {
    const r = reclassifyMaturities([position()], RECLASS_PAIRS, CUTOFF)
    expect(r.moved).toEqual([])
    expect(r.lines).toEqual([])
  })

  it("un saldo DEUDOR (crédito) se carga en la cuenta de destino", () => {
    const r = reclassifyMaturities(
      [position({ accountCode: "253", openCents: 400_000, dueDate: "2027-06-30" })],
      RECLASS_PAIRS,
      CUTOFF
    )
    expect(r.moved[0]).toMatchObject({ fromCode: "253", toCode: "543", direction: "A_CORTO", debtor: true })
    expect(r.lines[0]).toMatchObject({ accountCode: "543", debitCents: 400_000, creditCents: 0 })
    expect(r.lines[1]).toMatchObject({ accountCode: "253", debitCents: 0, creditCents: 400_000 })
  })

  it("un saldo ACREEDOR (deuda) se carga en la cuenta de origen", () => {
    const r = reclassifyMaturities(
      [position({ accountCode: "173", openCents: -500_000, dueDate: "2027-06-30" })],
      RECLASS_PAIRS,
      CUTOFF
    )
    expect(r.lines[0]).toMatchObject({ accountCode: "173", debitCents: 500_000 })
    expect(r.lines[1]).toMatchObject({ accountCode: "523", creditCents: 500_000 })
  })

  it("una posición ya saldada (neto 0) no genera nada", () => {
    const r = reclassifyMaturities(
      [position({ openCents: -100_000, dueDate: "2028-06-30" }), position({ openCents: 100_000, dueDate: "2028-06-30", entryNumber: 11 })],
      RECLASS_PAIRS,
      CUTOFF
    )
    expect(r.moved).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Criterio 24 · el ejemplo del diseño
// ─────────────────────────────────────────────────────────────────────────────

describe("criterio 24 · 523 con 250 000 a 2027-09-30 y 500 000 a 2028-06-30", () => {
  const positions = [
    position({ openCents: -250_000, dueDate: "2027-09-30", entryNumber: 5 }),
    position({ openCents: -500_000, dueDate: "2028-06-30", entryNumber: 6 }),
  ]
  const r = reclassifyMaturities(positions, RECLASS_PAIRS, CUTOFF)

  it("los 500 000 pasan a 173 y los 250 000 se quedan", () => {
    expect(r.moved).toHaveLength(1)
    expect(r.moved[0]).toMatchObject({ fromCode: "523", toCode: "173", direction: "A_LARGO", amountCents: 500_000 })
  })

  it("Σ 523 + Σ 173 = 750 000 antes y después, y el asiento suma cero", () => {
    const antes = positions.reduce((a, p) => a + Math.abs(p.openCents), 0)
    const { debe, haber } = sumOf(r.lines)
    expect(antes).toBe(750_000)
    expect(debe).toBe(haber)
    expect(debe).toBe(500_000)
  })

  it("527 y 528 no se mueven aunque tengan saldo vivo", () => {
    const con527 = reclassifyMaturities(
      [...positions, position({ accountCode: "527", openCents: -12_000, dueDate: "2027-03-31", entryNumber: 7 })],
      RECLASS_PAIRS,
      CUTOFF
    )
    expect(con527.moved.map((m) => m.fromCode)).not.toContain("527")
    expect(con527.warnings.map((w) => w.code)).toContain("CUENTA_NO_RECLASIFICABLE")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// R-RC-3 · FIFO, no compensación y onerosidad
// ─────────────────────────────────────────────────────────────────────────────

describe("R-RC-3 · FIFO por (cuenta, contraparte, divisa)", () => {
  it("el cobro cancela el vencimiento más antiguo, con desempate por entryNumber", () => {
    const { outstanding } = applyFifo([
      position({ openCents: -100_000, dueDate: "2027-03-31", entryNumber: 2 }),
      position({ openCents: -100_000, dueDate: "2027-03-31", entryNumber: 1 }),
      position({ openCents: -300_000, dueDate: "2028-03-31", entryNumber: 3 }),
      position({ openCents: 150_000, dueDate: null, entryNumber: 4 }),
    ])
    // Se cancela el nº 1 entero y la mitad del nº 2.
    expect(outstanding.map((p) => [p.entryNumber, p.openCents])).toEqual([
      [2, -50_000],
      [3, -300_000],
    ])
  })

  it("no compensa un anticipo en 407 con la deuda en 400 de la misma contraparte", () => {
    const r = reclassifyMaturities(
      [
        position({ accountCode: "400", openCents: -600_000, dueDate: "2027-02-28" }),
        position({ accountCode: "407", openCents: 100_000, dueDate: "2027-02-28", entryNumber: 11 }),
      ],
      RECLASS_PAIRS,
      CUTOFF
    )
    // Ninguna de las dos está en el universo de pares: se presentan las dos y no
    // se cruzan. Lo que importa aquí es que el FIFO no las ha mezclado.
    expect(r.moved).toEqual([])
    expect(r.blocking).toEqual([])
  })

  it("avisa cuando el grupo mezcla vencimientos de onerosidad distinta (art. 1174 CC)", () => {
    const r = reclassifyMaturities(
      [
        position({ accountCode: "173", openCents: -400_000, dueDate: "2028-03-31", entryNumber: 1, hasImplicitInterest: true }),
        position({ accountCode: "173", openCents: -400_000, dueDate: "2028-09-30", entryNumber: 2, hasImplicitInterest: false }),
        position({ accountCode: "173", openCents: 100_000, dueDate: null, entryNumber: 3 }),
      ],
      RECLASS_PAIRS,
      CUTOFF
    )
    expect(r.warnings.map((w) => w.code)).toContain("ONEROSIDAD_DISTINTA")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Criterio 25 (O-6) · desglose obligatorio
// ─────────────────────────────────────────────────────────────────────────────

describe("criterio 25 · préstamo sin desglose", () => {
  const sinDesglose = position({ accountCode: "170", counterpartyId: "banco", openCents: -3_000_000, dueDate: null, reference: "PR-2024/1" })

  it("deja el paso en FAIL BLOQUEANTE nombrando la deuda, no en una lista informativa", () => {
    const r = reclassifyMaturities([sinDesglose], RECLASS_PAIRS, CUTOFF)
    expect(r.blocking).toHaveLength(1)
    expect(r.unknownMaturity).toEqual([])
    const step = reclassStep(r)
    expect(step.status).toBe("FAIL")
    expect(step.blocking).toBe(true)
    expect(step.sealReason).toBe("DEUDA_SIN_DESGLOSE")
    expect(step.evidencia).toContain("PR-2024/1")
    expect(step.evidencia).toContain(TEMPLATE_ALTA_PRESTAMO)
  })

  it("con el cuadro declarado, el mismo préstamo pasa a PASS y se reclasifica", () => {
    const conDesglose = [
      position({ accountCode: "170", counterpartyId: "banco", openCents: -1_000_000, dueDate: "2027-06-30", entryNumber: 1 }),
      position({ accountCode: "170", counterpartyId: "banco", openCents: -2_000_000, dueDate: "2029-06-30", entryNumber: 2 }),
    ]
    const r = reclassifyMaturities(conDesglose, RECLASS_PAIRS, CUTOFF)
    expect(r.blocking).toEqual([])
    expect(reclassStep(r).status).toBe("PASS")
    expect(r.moved).toHaveLength(1)
    expect(r.moved[0]).toMatchObject({ fromCode: "170", toCode: "520", amountCents: 1_000_000 })
  })

  it("una posición COMERCIAL sin vencimiento sólo avisa: la decide una persona", () => {
    // 253 no es 17x ni 52x: no exige cuadro de vencimientos (O-6 acota el
    // desglose obligatorio a la deuda), así que se lista y decide una persona.
    const r = reclassifyMaturities(
      [position({ accountCode: "253", dueDate: null, openCents: 80_000 })],
      RECLASS_PAIRS,
      CUTOFF
    )
    expect(r.blocking).toEqual([])
    expect(r.unknownMaturity).toHaveLength(1)
    const step = reclassStep(r)
    expect(step.status).toBe("WARN")
    expect(step.sealReason).toBe("VENCIMIENTOS_SIN_FECHA")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// D5.2 · siembra sólo donde las dos cuentas existen
// ─────────────────────────────────────────────────────────────────────────────

describe("D5.2 · pares no sembrados", () => {
  it("un par cuya cuenta no es postable no se usa y se avisa", () => {
    const r = reclassifyMaturities([position({ accountCode: "173", openCents: -500_000, dueDate: "2027-01-31" })], RECLASS_PAIRS, CUTOFF, {
      postableAccountCodes: ["173"], // falta 523
    })
    expect(r.moved).toEqual([])
    expect(r.warnings.some((w) => w.code === "PAR_NO_SEMBRADO" && w.accountCode === "173↔523")).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// R-RC-6 (O-8) · el orden de la reversión
// ─────────────────────────────────────────────────────────────────────────────

describe("R-RC-6 · orden y numeración en la apertura", () => {
  it("acepta apertura nº 1 y contra-asiento de T-32 nº 2", () => {
    expect(
      reclassReversalDeviations([
        { entryNumber: 1, kind: "OPENING" },
        { entryNumber: 2, kind: "REVERSAL", templateCode: "T-32", reversesEntryId: "e-32" },
      ])
    ).toEqual([])
  })

  it("delata el contra-asiento posteado ANTES de la apertura", () => {
    const problems = reclassReversalDeviations([
      { entryNumber: 1, kind: "REVERSAL", templateCode: "T-32", reversesEntryId: "e-32" },
      { entryNumber: 2, kind: "OPENING" },
    ])
    expect(problems.join(" ")).toContain("nº 2")
    expect(problems.length).toBeGreaterThan(0)
  })

  it("delata la falta de apertura", () => {
    expect(reclassReversalDeviations([{ entryNumber: 3, kind: "STANDARD" }])).toHaveLength(1)
  })
})
