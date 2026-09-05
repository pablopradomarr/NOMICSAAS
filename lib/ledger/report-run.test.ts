/**
 * E6 · T10 — Clave de reutilización, forma canónica y política de umbrales.
 *
 * Lo que estos tests protegen es, sobre todo, el **no** disparar: un sello que
 * salta en cada cierre y en cada liquidación trimestral es un sello que nadie
 * lee, y entonces el que importa pasa desapercibido.
 */

import { describe, expect, it } from "vitest"

import {
  alwaysReviewReasons,
  analyticsKeyOf,
  canonicalJson,
  canonicalParams,
  canonicalResultJson,
  checkThresholds,
  DEFAULT_REVIEW_THRESHOLDS,
  paramsHash,
  reportRunKey,
  reportSealReasons,
  sealOf,
  SENTINEL,
  type ReviewThresholds,
} from "@/lib/ledger/report-run"

describe("forma canónica", () => {
  it("ordena las claves en TODOS los niveles", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
  })

  it("descarta `undefined` pero conserva `null`", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}')
  })

  it("respeta el orden de los arrays: en un array el orden ES el dato", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]")
  })

  it("rechaza NaN e Infinity antes de que entren en un hash", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/no finito/)
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(/no finito/)
  })

  it("dos peticiones con las mismas claves en distinto orden comparten hash", () => {
    expect(paramsHash({ variant: "PYMES", snapshot: "PRE_REGULARIZACION" })).toBe(
      paramsHash({ snapshot: "PRE_REGULARIZACION", variant: "PYMES" })
    )
  })

  it("dos peticiones con parámetros DISTINTOS no lo comparten (O-5)", () => {
    // Es el bug de caché que devuelve cifras correctas del informe equivocado:
    // dos balances del mismo periodo con distinta foto comparten `ledgerHash`.
    expect(paramsHash({ snapshot: "PRE_REGULARIZACION" })).not.toBe(paramsHash({ snapshot: "POST_CIERRE" }))
  })

  it("`paramsHash` es sha256 hexadecimal de 64 caracteres", () => {
    expect(paramsHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/)
  })

  it("I-E6-17: `canonicalResultJson` es estable ante el orden de inserción", () => {
    const a: Record<string, unknown> = {}
    a.total = 100
    a.detalle = [1, 2]
    const b: Record<string, unknown> = {}
    b.detalle = [1, 2]
    b.total = 100
    expect(canonicalResultJson(a)).toBe(canonicalResultJson(b))
  })
})

describe("analyticsKeyOf", () => {
  it("usa el centinela `∅`, porque en PostgreSQL NULL <> NULL", () => {
    // Un `@@unique` con columnas nullables NO impide duplicados (lección O-A6).
    expect(analyticsKeyOf({})).toBe([SENTINEL, SENTINEL, SENTINEL].join("|"))
    expect(analyticsKeyOf({ analyticsHash: "abc" })).toBe(`abc|${SENTINEL}|${SENTINEL}`)
  })

  it("distingue dos configuraciones analíticas distintas", () => {
    expect(analyticsKeyOf({ analyticsHash: "a" })).not.toBe(analyticsKeyOf({ analyticsHash: "b" }))
  })
})

describe("reportRunKey", () => {
  it("es el MISMO string que el @@unique de la tabla, con sus ocho campos", () => {
    const key = reportRunKey({
      organizationId: "org",
      type: "BALANCE",
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
      paramsHash: "p",
      ledgerHash: "l",
      analyticsKey: "a",
      gitSha: "g",
    })
    expect(key.split("|")).toHaveLength(8)
    expect(key).toBe("org|BALANCE|2026-01-01|2026-12-31|p|l|a|g")
  })
})

// ─────────────────────────────────────────────────────────────────────────────

const thresholds = DEFAULT_REVIEW_THRESHOLDS

describe("checkThresholds — la CONJUNCIÓN es lo que hace útil el sello", () => {
  it("criterio 14: +20 % y +200 000,00 € sobre ingresos dispara con deltaBps 2000", () => {
    const breaches = checkThresholds({ ingresos: 120_000_000 }, { ingresos: 100_000_000 }, thresholds)
    expect(breaches).toHaveLength(1)
    expect(breaches[0].code).toBe("VARIACION_KPI")
    expect(breaches[0].kpi).toBe("ingresos")
    expect(breaches[0].deltaBps).toBe(2000)
    expect(breaches[0].kind).toBe("VARIACION")
  })

  it("+50 % sobre 40,00 € NO dispara: falla el suelo absoluto", () => {
    // Sin `minAbsCents`, pasar de 100 € a 300 € de gastos financieros ahogaría
    // el sello en ruido y la gente aprendería a ignorarlo.
    expect(checkThresholds({ ingresos: 6_000 }, { ingresos: 4_000 }, thresholds)).toEqual([])
  })

  it("+2 000 000,00 € con sólo un +2 % NO dispara: falla el umbral relativo", () => {
    expect(checkThresholds({ ingresos: 10_200_000_000 }, { ingresos: 10_000_000_000 }, thresholds)).toEqual([])
  })

  it("sin comparativo no hay variación que medir: lista vacía, no un 100 %", () => {
    expect(checkThresholds({ ingresos: 5_000_000 }, null, thresholds)).toEqual([])
  })

  it("EV-3: la parte estructural se descuenta ANTES de aplicar el umbral", () => {
    // El asiento del impuesto sobre beneficios mueve el resultado en el cierre y
    // no es una variación del negocio.
    const current = { resultado: 40_000_000 }
    const previous = { resultado: 100_000_000 }
    // −60 % y −600 000,00 €: dispara.
    expect(checkThresholds(current, previous, thresholds)).toHaveLength(1)
    // Descontados los −550 000,00 € del impuesto, la variación real es −5 %.
    expect(
      checkThresholds(current, previous, thresholds, { structuralDeltaByKpi: { resultado: -55_000_000 } })
    ).toEqual([])
  })

  it("EV-5: un REVERSAL y su original en el mismo periodo se netean antes", () => {
    const current = { ingresos: 200_000_000 }
    const previous = { ingresos: 100_000_000 }
    expect(checkThresholds(current, previous, thresholds)).toHaveLength(1)
    expect(checkThresholds(current, previous, thresholds, { reversalNetByKpi: { ingresos: 100_000_000 } })).toEqual([])
  })

  it("EV-6: un KPI por dimensión no se compara si la dimensión no vive en los dos periodos", () => {
    const custom: ReviewThresholds = {
      ...thresholds,
      kpis: { ...thresholds.kpis, "ingresos:PRJ-9": { pctBps: 1500, minAbsCents: 500_000 } },
    }
    const args = [{ "ingresos:PRJ-9": 5_000_000 }, { "ingresos:PRJ-9": 1_000_000 }, custom] as const
    expect(checkThresholds(...args)).toHaveLength(1)
    expect(checkThresholds(...args, { dimensionsAliveInBoth: [] })).toEqual([])
  })

  it("base `NONE`: no se compara con nada", () => {
    expect(
      checkThresholds({ ingresos: 120_000_000 }, { ingresos: 100_000_000 }, thresholds, { comparativeBasis: "NONE" })
    ).toEqual([])
  })

  it("margen bruto se compara en PUNTOS, no en variación relativa", () => {
    // Pasar del 2 % al 3 % es +50 % y es irrelevante; +400 bps sí lo es.
    const t: ReviewThresholds = { ...thresholds, kpis: { margenBruto: thresholds.kpis.margenBruto } }
    expect(checkThresholds({ margenBruto: 300 }, { margenBruto: 200 }, t)).toEqual([])
    expect(checkThresholds({ margenBruto: 600 }, { margenBruto: 200 }, t)).toHaveLength(1)
  })

  it("aparecer desde 0 por encima del suelo absoluto sí es revisable", () => {
    const breaches = checkThresholds({ tesoreria: 5_000_000 }, { tesoreria: 0 }, thresholds)
    expect(breaches).toHaveLength(1)
    // Sin base no hay porcentaje: `null`, nunca Infinity.
    expect(breaches[0].deltaBps).toBeNull()
  })

  it("un KPI que no está en los dos snapshots se ignora, no se asume 0", () => {
    expect(checkThresholds({ ingresos: 999_999_999 }, {}, thresholds)).toEqual([])
  })
})

describe("alwaysReviewReasons — EV-7…EV-10", () => {
  it("EV-8: primer run tras cambiar el motor → MOTOR_CAMBIADO", () => {
    const reasons = alwaysReviewReasons({ gitSha: "b2b2b2b", lastGitSha: "a1a1a1a" })
    expect(reasons.map((r) => r.code)).toContain("MOTOR_CAMBIADO")
  })

  it("mismo git-sha: no dispara", () => {
    expect(alwaysReviewReasons({ gitSha: "a1a1a1a", lastGitSha: "a1a1a1a" })).toEqual([])
  })

  it("git-sha desconocido es de ENTORNO, no un descuadre de cifras", () => {
    const reasons = alwaysReviewReasons({ gitSha: "desconocido" })
    expect(reasons[0].code).toBe("GIT_SHA_DESCONOCIDO")
    expect(reasons[0].kind).toBe("ENTORNO")
  })

  it("EV-7: `analyticsHash` distinto es una REDEFINICIÓN de la métrica", () => {
    const reasons = alwaysReviewReasons({ gitSha: "a1a1a1a", analyticsHash: "y", lastAnalyticsHash: "x" })
    expect(reasons.map((r) => r.code)).toEqual(["ANALITICA_REDEFINIDA"])
  })

  it("EV-10: un epígrafe reclasificado con líneas en el periodo comparado", () => {
    const reasons = alwaysReviewReasons({ gitSha: "a1a1a1a", reclassifiedAccounts: ["705"] })
    expect(reasons.map((r) => r.code)).toEqual(["EPIGRAFE_CAMBIADO"])
    expect(reasons[0].message).toContain("705")
  })

  it("revisión forzada por un ADMIN, con su motivo", () => {
    const reasons = alwaysReviewReasons({ gitSha: "a1a1a1a", manualReviewReason: "cierre pendiente de revisar" })
    expect(reasons.map((r) => r.code)).toEqual(["REVISION_FORZADA"])
    expect(reasons[0].message).toContain("cierre pendiente de revisar")
  })

  it("I-E6-13: `REGULARIZACION_DESFASADA` muestra LAS DOS cifras y su diferencia", () => {
    const reasons = alwaysReviewReasons({
      gitSha: "a1a1a1a",
      regularizacionDesfasada: { i3Cents: 1_500_000, saldo129Cents: -1_497_322 },
    })
    expect(reasons[0].code).toBe("REGULARIZACION_DESFASADA")
    expect(reasons[0].invariantId).toBe("I-E6-13")
    // Nunca se elige una en silencio: las dos y la diferencia.
    expect(reasons[0].message).toContain("1500000")
    expect(reasons[0].message).toContain("1497322")
    expect(reasons[0].message).toContain("2678")
  })
})

describe("reportSealReasons y sealOf", () => {
  const ok = { gitSha: "a1a1a1a", lastGitSha: "a1a1a1a" }

  it("todo en PASS y sin variaciones → VALIDADO AUTOMÁTICAMENTE", () => {
    const reasons = reportSealReasons({ checks: [{ id: "I2", status: "PASS", evidencia: "0" }], always: ok })
    expect(reasons).toEqual([])
    expect(sealOf(reasons)).toBe("VALIDADO_AUTOMATICAMENTE")
  })

  it("EV-9: un invariante en FAIL sella REQUIERE REVISIÓN con su ID", () => {
    const reasons = reportSealReasons({
      checks: [{ id: "I2", status: "FAIL", evidencia: "difiere en 1 céntimo" }],
      always: ok,
    })
    expect(reasons[0].code).toBe("INVARIANTE_FAIL")
    expect(reasons[0].invariantId).toBe("I2")
    expect(sealOf(reasons)).toBe("REQUIERE_REVISION")
  })

  it("un WARN de calidad de datos también marca revisable, con su etiqueta", () => {
    const reasons = reportSealReasons({
      checks: [{ id: "I-E6-12", status: "WARN", evidencia: "477 deudor" }],
      always: ok,
    })
    expect(reasons.map((r) => r.kind)).toEqual(["AVISO"])
    expect(sealOf(reasons)).toBe("REQUIERE_REVISION")
  })

  it("los códigos son CERRADOS: la Auditoría filtra por `code`, no hace LIKE", () => {
    const reasons = reportSealReasons({
      checks: [{ id: "I2", status: "FAIL", evidencia: "x" }],
      breaches: checkThresholds({ ingresos: 120_000_000 }, { ingresos: 100_000_000 }, thresholds),
      always: { gitSha: "b", lastGitSha: "a", manualReviewReason: "revisión trimestral pactada" },
    })
    const codes = new Set(reasons.map((r) => r.code))
    expect([...codes].sort()).toEqual(["INVARIANTE_FAIL", "MOTOR_CAMBIADO", "REVISION_FORZADA", "VARIACION_KPI"])
  })
})

describe("canonicalParams", () => {
  it("es el string que se hashea, y es legible", () => {
    expect(canonicalParams({ variant: "PYMES", currency: "EUR" })).toBe('{"currency":"EUR","variant":"PYMES"}')
  })
})
