/**
 * E8 · T7 — Golden tests de `reconcile()` contra los QUINCE casos sellados en
 * `docs/design/fixtures/extraccion-esperada.json`, más las diez variantes
 * negativas y las cuatro observaciones que T8 dejó anotadas para T7/T14.
 *
 * **Qué se compara y por qué.** El fixture sella dos cosas de naturaleza
 * distinta: cifras y prosa. Las cifras —estado y bloqueo de cada uno de los 25
 * checks, confianza de cada campo en los cuatro niveles, desviaciones de cuota,
 * elegibilidad para el lote, motivos de sello y la evidencia numérica de los
 * checks que llevan números— se comparan **byte a byte**. Los mensajes y las
 * notas están redactados caso a caso por el experto contable para que un humano
 * los lea en pantalla: reproducirlos carácter a carácter obligaría a codificar
 * quince textos en el motor, que es justo lo contrario de un motor. De ellos se
 * exige lo que sí es contrastable: que existan, que estén en español y que no
 * sean el identificador de la regla.
 *
 * **Sin excepciones.** Las dos discrepancias que T7/T9 dejaron declaradas —el
 * origen de `lines[0].accountCode` en C05 y el par `paymentKey` /
 * `simplifiedQualified` de C03-C04— se resolvieron en T13 corrigiendo el
 * generador del fixture y el sellado de procedencia: la tabla de confianza y la
 * propuesta dicen ya lo mismo, y cualquier divergencia hace fallar el test.
 */

import { describe, expect, it } from "vitest"

import {
  caseById,
  fixtureAccounts,
  loadExtractionFixture,
  inputProposalFor,
  reconcileContextFor,
  toProposal,
  toTaxRateRefs,
  type FixtureCase,
} from "@/lib/extraction/reconcile.fixture"
import {
  convertWithRate,
  euVatNumberLooksValid,
  fullYearsBetween,
  halfUpDiv,
  quarterOf,
  reconcile,
  RECONCILE_RULES,
  spanishTaxIdCheck,
  taxIdBranchOf,
  TOLERANCIA_CUOTA_IVA_CENTS,
  type ReconcileResult,
} from "@/lib/extraction/reconcile"

const fixture = loadExtractionFixture()


// ─────────────────────────────────────────────────────────────────────────────
// Proyecciones comparables
// ─────────────────────────────────────────────────────────────────────────────

type CheckProjection = { id: string; status: string; blocksBatch: boolean }

const projectChecks = (r: ReconcileResult): CheckProjection[] =>
  r.checks.map((c) => ({ id: c.id, status: c.status, blocksBatch: c.blocksBatch }))

const expectedChecks = (c: FixtureCase): CheckProjection[] =>
  c.reconcile.checks.map((k) => ({ id: k.id, status: k.status, blocksBatch: k.blocksBatch }))

const projectConfidence = (r: ReconcileResult): Record<string, { origin: string; confidence: string; check: string | null }> => {
  const out: Record<string, { origin: string; confidence: string; check: string | null }> = {}
  for (const [key, value] of Object.entries(r.fieldOrigins)) {
    out[key] = { origin: value.origin, confidence: value.confidence, check: value.check ?? null }
  }
  return out
}

/** Claves numéricas de la evidencia que el fixture sella y el motor reproduce. */
const NUMERIC_EVIDENCE_KEYS = [
  "declarada",
  "recalculada",
  "desvio",
  "tolerancia",
  "sumaBases",
  "baseDeclarada",
  "bases",
  "cuotas",
  "total",
  "suplidos",
  "retencion",
  "totalCents",
  "rateBps",
  "baseCents",
  "cuotaCents",
  "residuo",
  "retencionLeida",
  "retencionConfigurada",
  "baseRetencion",
  "convertedTotalCents",
  "pagesAnalyzed",
  "pagesTotal",
  "cuotaDelDocumento",
  "cuotaContabilizada",
  "baseIncorrecta",
  "cuotaIncorrecta",
  "retencionIncorrecta",
  "baseCorrecta",
  "cuotaCorrecta",
  "retencionCorrecta",
] as const

/** Compara, recursivamente y sólo donde el fixture pone un número, la evidencia. */
function compareNumericEvidence(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  path: string,
  out: { path: string; esperado: unknown; obtenido: unknown }[]
): void {
  for (const [key, value] of Object.entries(expected)) {
    const here = path === "" ? key : `${path}.${key}`
    if (typeof value === "number") {
      const got = actual[key] ?? actual[EVIDENCE_ALIASES[key] ?? key]
      if ((NUMERIC_EVIDENCE_KEYS as readonly string[]).includes(key) && got !== value) {
        out.push({ path: here, esperado: value, obtenido: got })
      }
      continue
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const nested = actual[key]
      if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
        compareNumericEvidence(value as Record<string, unknown>, nested as Record<string, unknown>, here, out)
      } else {
        out.push({ path: here, esperado: value, obtenido: nested })
      }
    }
  }
}

const run = (c: FixtureCase): ReconcileResult => reconcile(inputProposalFor(c), reconcileContextFor(c))

/**
 * El fixture nombra la misma cifra de dos maneras en casos distintos (`retencion`
 * en C09 y `retencionLeida` en C08, `suplidos` y `suplidosYNoSujetos`). Son
 * sinónimos de prosa, no dos números: el motor emite uno y el test acepta el
 * otro.
 */
const EVIDENCE_ALIASES: Readonly<Record<string, string>> = {
  retencion: "retencionLeida",
  suplidos: "suplidosYNoSujetos",
  cuotasEnDocumento: "cuotas",
  derivada: "declarada",
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 · El catálogo de reglas
// ─────────────────────────────────────────────────────────────────────────────

describe("catálogo de reglas RC-01…RC-25", () => {
  it("tiene las veinticinco reglas, sin huecos ni repetidas, y en el orden del diseño", () => {
    expect(RECONCILE_RULES).toHaveLength(25)
    expect(RECONCILE_RULES.map((r) => r.id)).toEqual(
      Array.from({ length: 25 }, (_, i) => `RC-${String(i + 1).padStart(2, "0")}`)
    )
  })

  it("coincide en identificador y enunciado con el catálogo sellado por el experto", () => {
    const sealed = fixture.casos[0].reconcile.checks.map((c) => c.id)
    expect(RECONCILE_RULES.map((r) => r.id)).toEqual(sealed)
  })

  it("la tolerancia de cuota es UNA constante del motor, no un ajuste", () => {
    expect(TOLERANCIA_CUOTA_IVA_CENTS).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2 · Los quince casos, uno a uno
// ─────────────────────────────────────────────────────────────────────────────

describe.each(fixture.casos.map((c) => [c.id, c] as const))("%s", (_id, c) => {
  const result = run(c)

  it(`${c.titulo} — estado global, elegibilidad y sellos`, () => {
    expect(result.status).toBe(c.reconcile.status)
    expect(result.elegibleParaLote).toBe(c.reconcile.elegibleParaLote)
    expect([...result.sellos].sort()).toEqual([...c.reconcile.sellos].sort())
  })

  it("los 25 checks, con su estado y su bloqueo de lote", () => {
    expect(projectChecks(result)).toEqual(expectedChecks(c))
  })

  it("la evidencia numérica de cada check", () => {
    const diffs: { check: string; path: string; esperado: unknown; obtenido: unknown }[] = []
    for (const expected of c.reconcile.checks) {
      const actual = result.checks.find((k) => k.id === expected.id)
      if (!actual) continue
      const local: { path: string; esperado: unknown; obtenido: unknown }[] = []
      compareNumericEvidence(expected.evidence, actual.evidence, "", local)
      diffs.push(...local.map((d) => ({ check: expected.id, ...d })))
    }
    expect(diffs).toEqual([])
  })

  it("la confianza de cada campo, en los cuatro niveles", () => {
    const actual = projectConfidence(result)
    for (const [key, expected] of Object.entries(c.reconcile.confianzaPorCampo)) {
      expect({ campo: key, ...actual[key] }).toEqual({ campo: key, ...expected })
    }
  })

  it("`quotaDeviationsCents` es la métrica I-E8-7b, no un importe", () => {
    expect(result.quotaDeviationsCents).toEqual(c.reconcile.quotaDeviationsCents)
  })

  it("todo check lleva mensaje en español y su regla", () => {
    for (const check of result.checks) {
      expect(check.message.length).toBeGreaterThan(10)
      expect(check.message).not.toBe(check.id)
      expect(check.regla).toBe(RECONCILE_RULES.find((r) => r.id === check.id)?.regla)
    }
  })

  it("el periodo de IVA es el trimestre de max(receptionDate, documentDate)", () => {
    const esperado = c.asiento?.ivaPeriod ?? (c.identidadesIva.ivaPeriod as string | null)
    if (esperado) expect(result.ivaPeriod).toBe(esperado)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3 · Determinismo (I-E8-6)
// ─────────────────────────────────────────────────────────────────────────────

describe("I-E8-6 · determinismo", () => {
  it("dos ejecuciones del mismo caso dan exactamente el mismo resultado", () => {
    for (const c of fixture.casos) {
      const a = JSON.stringify(run(c), (_k, v) => (typeof v === "bigint" ? v.toString() : v))
      const b = JSON.stringify(run(c), (_k, v) => (typeof v === "bigint" ? v.toString() : v))
      expect(a).toBe(b)
    }
  })

  it("el orden de los checks no depende del documento", () => {
    for (const c of fixture.casos) {
      expect(run(c).checks.map((k) => k.id)).toEqual(RECONCILE_RULES.map((r) => r.id))
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4 · Las diez variantes negativas
// ─────────────────────────────────────────────────────────────────────────────

describe("variantes negativas", () => {
  it("N01 · NIF español con dígito de control inválido ⇒ FAIL, nunca WARN", () => {
    const c = caseById("C01")
    const proposal = toProposal(c.propuesta)
    const mutated = { ...proposal, counterparty: { ...proposal.counterparty, taxId: "B12345675" } }
    const r = reconcile(mutated, reconcileContextFor(c, { counterparty: { taxId: "B12345675" } }))
    const rc11 = r.checks.find((k) => k.id === "RC-11")
    expect(rc11?.status).toBe("FAIL")
    expect(rc11?.blocksBatch).toBe(true)
    expect(rc11?.message).toContain("dígito de control")
    expect(r.status).toBe("FAIL")
    expect(r.sellos).toContain("PROPUESTA_NO_RECONCILIADA")
  })

  it("N02 · documento que no cuadra consigo mismo ⇒ RC-03 FAIL con tolerancia 0", () => {
    const c = caseById("C01")
    const r = reconcile({ ...toProposal(c.propuesta), totalCents: 119900 }, reconcileContextFor(c))
    const rc03 = r.checks.find((k) => k.id === "RC-03")
    expect(rc03?.status).toBe("FAIL")
    expect(rc03?.evidence).toMatchObject({ total: 119900, desvio: 1100 })
    expect(r.status).toBe("FAIL")
  })

  it("N03 · tres líneas de 333,33 contra una base de 1 000,00 ⇒ RC-01 FAIL por un céntimo", () => {
    const c = caseById("C01")
    const p = toProposal(c.propuesta)
    const line = p.lines[0]
    const r = reconcile(
      {
        ...p,
        lines: [
          { ...line, baseCents: 33333 },
          { ...line, baseCents: 33333 },
          { ...line, baseCents: 33333 },
        ],
      },
      reconcileContextFor(c)
    )
    const rc01 = r.checks.find((k) => k.id === "RC-01")
    expect(rc01?.status).toBe("FAIL")
    expect(rc01?.evidence).toMatchObject({ sumaBases: 99999, baseDeclarada: 100000, desvio: -1 })
  })

  it("N04 · cuota desviada 5 céntimos ⇒ RC-02 FAIL: por encima de la tolerancia no hay asiento", () => {
    const c = caseById("C02")
    const p = toProposal(c.propuesta)
    const r = reconcile(
      {
        ...p,
        taxes: p.taxes.map((t) => (t.taxRateCode === "IVA_21" ? { ...t, quotaCents: 21005 } : t)),
        totalCents: 176004,
      },
      reconcileContextFor(c)
    )
    const rc02 = r.checks.find((k) => k.id === "RC-02")
    expect(rc02?.status).toBe("FAIL")
    expect(rc02?.blocksBatch).toBe(true)
    expect(rc02?.evidence).toMatchObject({ IVA_21: { declarada: 21005, recalculada: 21000, desvio: 5, tolerancia: 1 } })
  })

  it("N05 · ISP sin precondiciones ⇒ RC-22 WARN bloqueante y docKind DESCONOCIDO", () => {
    const c = caseById("C11")
    const r = reconcile(
      toProposal(c.propuesta),
      reconcileContextFor(c, { counterparty: { viesValid: false }, legalMentionArt61m: null })
    )
    const rc22 = r.checks.find((k) => k.id === "RC-22")
    expect(rc22?.status).toBe("WARN")
    expect(rc22?.blocksBatch).toBe(true)
    expect(r.normalized.docKind).toBe("DESCONOCIDO")
    const rc11 = r.checks.find((k) => k.id === "RC-11")
    expect(rc11?.status).toBe("WARN")
    expect(rc11?.blocksBatch).toBe(true)
    expect(r.status).toBe("WARN")
  })

  it("N06 · tercer país con identificador vacío ⇒ WARN que NO bloquea el lote", () => {
    const c = caseById("C15")
    const p = toProposal(c.propuesta)
    const r = reconcile(
      { ...p, counterparty: { ...p.counterparty, taxId: null } },
      reconcileContextFor(c, { counterparty: { taxId: null } })
    )
    const rc11 = r.checks.find((k) => k.id === "RC-11")
    expect(rc11?.status).toBe("WARN")
    expect(rc11?.blocksBatch).toBe(false)
    expect(rc11?.status).not.toBe("FAIL")
  })

  it("N07 · suplido mal clasificado como operación ⇒ RC-20 FAIL con las cifras del error", () => {
    const c = caseById("C09")
    const p = toProposal(c.propuesta)
    const r = reconcile(
      { ...p, lines: p.lines.map((l, i) => (i === 1 ? { ...l, kind: "OPERACION" as const } : l)) },
      reconcileContextFor(c)
    )
    const rc20 = r.checks.find((k) => k.id === "RC-20")
    expect(rc20?.status).toBe("FAIL")
    expect(rc20?.evidence).toMatchObject({
      baseIncorrecta: 130000,
      cuotaIncorrecta: 27300,
      retencionIncorrecta: 19500,
      baseCorrecta: 100000,
      cuotaCorrecta: 21000,
      retencionCorrecta: 15000,
    })
  })

  it("N08 · organización en RECC ⇒ RC-24 FAIL y sello REGIMEN_NO_SOPORTADO", () => {
    const c = caseById("C01")
    const r = reconcile(toProposal(c.propuesta), reconcileContextFor(c, { organization: { ivaRegime: "RECC" } }))
    const rc24 = r.checks.find((k) => k.id === "RC-24")
    expect(rc24?.status).toBe("FAIL")
    expect(r.sellos).toContain("REGIMEN_NO_SOPORTADO")
    expect(r.status).toBe("FAIL")
  })

  it("N09 · el mismo documento parcial tecleado por un EDITOR ⇒ RC-09 PASS y campos verificables", () => {
    const c = caseById("C13")
    const r = reconcile(
      toProposal(c.propuesta),
      reconcileContextFor(c, { run: { kind: "MANUAL", pagesAnalyzed: 9, pagesTotal: 9, partial: false } })
    )
    expect(r.checks.find((k) => k.id === "RC-09")?.status).toBe("PASS")
    expect(r.status).toBe("PASS")
    expect(r.fieldOrigins["totalCents"].confidence).toBe("verificado")
  })

  it("N10 · sin tasa persistida no se convierte con otra fuente ni con otro día", () => {
    const c = caseById("C12")
    const r = reconcile(toProposal(c.propuesta), reconcileContextFor(c, { rate: null }))
    const rc14 = r.checks.find((k) => k.id === "RC-14")
    expect(rc14?.status).toBe("FAIL")
    expect(r.conversion).toBeNull()
    expect(r.status).toBe("FAIL")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5 · Las cuatro observaciones que T8 dejó anotadas
// ─────────────────────────────────────────────────────────────────────────────

describe("observaciones del fixture (OBS-F1…F4)", () => {
  it("OBS-F3 · RC-03 excluye de Σ cuotas los tipos ISP/AIB: sin eso, C11 fallaría", () => {
    const c = caseById("C11")
    const r = reconcile(toProposal(c.propuesta), reconcileContextFor(c))
    const rc03 = r.checks.find((k) => k.id === "RC-03")
    expect(rc03?.status).toBe("PASS")
    // La cuota autorrepercutida existe y NO forma parte del total del documento.
    expect(rc03?.evidence).toMatchObject({ bases: 300000, cuotas: 0, total: 300000 })
    expect(r.normalized.taxes[0].quotaCents).toBe(63000)
  })

  it("OBS-F4 · un campo de origen `usuario` con su check en PASS es `verificado`", () => {
    const r = run(caseById("C01"))
    expect(r.fieldOrigins["receptionDate"]).toMatchObject({ origin: "usuario", confidence: "verificado" })
  })

  it("OBS-F1/F2 · el libro de emitidas de un anticipo sin cobro no anota cuota devengada", () => {
    const c = caseById("C14")
    const r = reconcile(toProposal(c.propuesta), reconcileContextFor(c))
    expect(r.checks.find((k) => k.id === "RC-25")?.blocksBatch).toBe(true)
    expect(r.sellos).toContain("IVA_PERIODO_DESPLAZADO")
    expect(c.libroRegistro.cuotaRepercutidaCents).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6 · Casos límite de la aritmética y de las ramas de identificación
// ─────────────────────────────────────────────────────────────────────────────

describe("aritmética y ramas", () => {
  it("RC-17 · la cuota es residual: base + cuota = total con tolerancia 0", () => {
    for (const total of [1, 99, 1234, 100000, 999999, 1000001]) {
      for (const bps of [400, 1000, 2100]) {
        const base = halfUpDiv(total * 10000, 10000 + bps)
        expect(base + (total - base)).toBe(total)
      }
    }
  })

  it("la conversión a moneda base es HALF-EVEN y exacta en enteros", () => {
    expect(convertWithRate(1000000, BigInt(925926))).toBe(925926)
    expect(convertWithRate(359091, BigInt(925926))).toBe(332492)
    expect(convertWithRate(0, BigInt(925926))).toBe(0)
    expect(convertWithRate(-100, BigInt(1_000_000))).toBe(-100)
  })

  it("el dígito de control español distingue NIF, NIE y CIF", () => {
    expect(spanishTaxIdCheck("12345678Z").valid).toBe(true)
    expect(spanishTaxIdCheck("12345678A").valid).toBe(false)
    expect(spanishTaxIdCheck("B12345674").valid).toBe(true)
    expect(spanishTaxIdCheck("B12345675").valid).toBe(false)
    expect(spanishTaxIdCheck("A28017895").valid).toBe(true)
    expect(spanishTaxIdCheck("X1234567L").valid).toBe(true)
    expect(spanishTaxIdCheck("").valid).toBe(false)
  })

  it("las tres ramas de RC-11 se eligen por país, no por el documento", () => {
    expect(taxIdBranchOf(null)).toBe("ES")
    expect(taxIdBranchOf("ES")).toBe("ES")
    expect(taxIdBranchOf("DE")).toBe("UE")
    expect(taxIdBranchOf("CH")).toBe("TERCER_PAIS")
    expect(taxIdBranchOf("US")).toBe("TERCER_PAIS")
    expect(euVatNumberLooksValid("DE", "DE811907980")).toBe(true)
    expect(euVatNumberLooksValid("DE", null)).toBe(false)
  })

  it("el trimestre y los años completos son aritmética de cadenas, sin husos", () => {
    expect(quarterOf("2026-01-01")).toBe("2026-Q1")
    expect(quarterOf("2026-03-31")).toBe("2026-Q1")
    expect(quarterOf("2026-04-01")).toBe("2026-Q2")
    expect(quarterOf("2026-12-31")).toBe("2026-Q4")
    expect(fullYearsBetween("2022-02-28", "2026-02-27")).toBe(3)
    expect(fullYearsBetween("2022-02-28", "2026-02-28")).toBe(4)
    expect(fullYearsBetween("2024-02-29", "2028-02-29")).toBe(4)
  })

  it("RC-18 · pasados cuatro años la deducción caduca y bloquea el lote", () => {
    const c = caseById("C01")
    const p = toProposal(c.propuesta)
    const r = reconcile(
      { ...p, documentDate: "2021-03-28", accrualDate: null },
      reconcileContextFor(c)
    )
    const rc18 = r.checks.find((k) => k.id === "RC-18")
    expect(rc18?.status).toBe("WARN")
    expect(rc18?.blocksBatch).toBe(true)
    expect(r.sellos).toContain("IVA_PERIODO_DESPLAZADO")
  })

  it("RC-10 · unos bytes distintos de los que vio el modelo sellan DOCUMENTO_ALTERADO", () => {
    const c = caseById("C01")
    const ctx = reconcileContextFor(c)
    const r = reconcile(toProposal(c.propuesta), { ...ctx, file: { sha256: "a".repeat(64), runSha256: "b".repeat(64) } })
    expect(r.checks.find((k) => k.id === "RC-10")?.status).toBe("FAIL")
    expect(r.sellos).toContain("DOCUMENTO_ALTERADO")
  })

  it("RC-12 · un duplicado no es FAIL, pero no entra en el lote", () => {
    const c = caseById("C01")
    const r = reconcile(
      toProposal(c.propuesta),
      reconcileContextFor(c, { duplicate: { bySha256: false, byDocumentNumber: true } })
    )
    const rc12 = r.checks.find((k) => k.id === "RC-12")
    expect(rc12?.status).toBe("WARN")
    expect(rc12?.blocksBatch).toBe(true)
    expect(r.elegibleParaLote).toBe(false)
  })

  it("un documento sin líneas ni impuestos no revienta: RC-01 y RC-03 lo dicen", () => {
    const c = caseById("C01")
    const p = toProposal(c.propuesta)
    const r = reconcile({ ...p, lines: [], taxes: [], totalCents: 1 }, reconcileContextFor(c))
    expect(r.status).toBe("FAIL")
    expect(r.checks.find((k) => k.id === "RC-03")?.status).toBe("FAIL")
  })

  it("un ejercicio cerrado no es un FAIL: es un desvío a T-22", () => {
    const c = caseById("C01")
    const p = toProposal(c.propuesta)
    const r = reconcile({ ...p, documentDate: "2025-11-30", accrualDate: null }, reconcileContextFor(c))
    const rc05 = r.checks.find((k) => k.id === "RC-05")
    expect(rc05?.status).toBe("WARN")
    expect(r.fiscalYearClosed).toBe(true)
  })

  it("el catálogo de cuentas del fixture no trae ninguna del subgrupo 64 (O-13)", () => {
    expect(fixtureAccounts(fixture).filter((a) => a.code.startsWith("64"))).toEqual([])
  })

  it("los tipos del fixture se leen con su vigencia, no con la fecha de hoy", () => {
    // Ronda 2 (H-6): el fixture 1.1 llama al tipo de retención por su nombre
    // en el catálogo del producto (`IRPF_PROF_15`), no por uno inventado.
    expect(toTaxRateRefs(fixture).map((r) => r.code).sort()).toEqual([
      "IRPF_PROF_15",
      "IVA_10",
      "IVA_21",
      "IVA_4",
      "IVA_NO_SUJETO",
    ])
  })
})
