/**
 * E2 · T2 — Red de regresión del seed `seeds/npgc.csv`.
 *
 * El trabajo de datos ya está hecho en `seeds/build_npgc.py`; este fichero es lo
 * que impide que se pierda: cifras acordadas, 0 huérfanos, `validate_analytic_coherence`
 * portado a TypeScript (I-E2-6) y las marcas de presentación (I-E2-5).
 */

import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { filterByVariant, parseNpgcCsv, seedRowsToPlanAccounts } from "@/lib/accounts/csv"
import { checkAnalyticCoherence, epigraphCatalog } from "@/lib/accounts/epigraphs"
import { buildPlan } from "@/lib/accounts/codes"
import { defaultAccountMap, REQUIRED_ACCOUNT_KEYS, validateAccountMap } from "@/lib/accounts/map"
import type { SeedAccount } from "@/lib/accounts/types"

const CSV = readFileSync(path.join(process.cwd(), "seeds", "npgc.csv"), "utf8")
const parsed = parseNpgcCsv(CSV)
if (!parsed.ok) throw new Error(`El seed no parsea: ${JSON.stringify(parsed.errors.slice(0, 5))}`)
const rows: SeedAccount[] = parsed.value

describe("seeds/npgc.csv — cifras acordadas (T2)", () => {
  it("906 filas, 0 códigos duplicados", () => {
    expect(rows).toHaveLength(906)
    expect(new Set(rows.map((r) => r.code)).size).toBe(906)
  })

  it("794 cuentas en PGC PYMES, 112 excluidas", () => {
    const pymes = rows.filter((r) => r.pymes)
    expect(pymes).toHaveLength(794)
    expect(rows.length - pymes.length).toBe(112)
  })

  it("165 contra-cuentas y 7 bidireccionales (I-E2-5, E-2/E-3)", () => {
    expect(rows.filter((r) => r.isContra)).toHaveLength(165)
    const bidireccionales = rows.filter((r) => r.bidirectional).map((r) => r.code)
    expect(bidireccionales).toHaveLength(7)
    expect(bidireccionales.sort()).toEqual(["551", "552", "5523", "5524", "5525", "554", "555"])
  })

  it("EXTRAORDINARIO no se usa en el seed a propósito (PGC 2007 lo suprimió)", () => {
    expect(rows.filter((r) => r.analyticType === "EXTRAORDINARIO")).toHaveLength(0)
  })

  it("0 padres huérfanos y `nivel === len(codigo)` en las 906 filas", () => {
    const codes = new Set(rows.map((r) => r.code))
    for (const row of rows) {
      expect(row.level, row.code).toBe(row.code.length)
      if (row.parentCode) expect(codes.has(row.parentCode), `${row.code} → ${row.parentCode}`).toBe(true)
    }
  })

  it("toda cuenta 6/7 de nivel ≥ 2 tiene tipo analítico; ninguna de los grupos 1–5 lo tiene", () => {
    for (const row of rows) {
      const group = row.code[0]
      if ((group === "6" || group === "7") && row.level >= 2) expect(row.analyticType, row.code).not.toBeNull()
      if ("12345".includes(group)) expect(row.analyticType, row.code).toBeNull()
    }
  })
})

describe("I-E2-6 · coherencia analítica (puerto de validate_analytic_coherence)", () => {
  it("0 divergencias sobre las 906 filas en variante GENERAL", () => {
    const accounts = seedRowsToPlanAccounts(rows)
    expect(checkAnalyticCoherence(accounts, "GENERAL")).toEqual([])
  })

  it("0 divergencias sobre las 794 filas en variante PYMES", () => {
    const filtered = filterByVariant(rows, "PYMES")
    expect(filtered.ok).toBe(true)
    if (!filtered.ok) return
    expect(checkAnalyticCoherence(seedRowsToPlanAccounts(filtered.value), "PYMES")).toEqual([])
  })

  it("detecta una divergencia introducida a mano (la red funciona)", () => {
    const accounts = seedRowsToPlanAccounts(rows).map((a) =>
      a.code === "705" ? { ...a, analyticType: "FINANCIERO" as const } : a
    )
    const divergencias = checkAnalyticCoherence(accounts, "GENERAL")
    expect(divergencias.map((d) => d.accountCode)).toEqual(["705"])
  })
})

describe("I-E2-7 · variante (filterByVariant)", () => {
  it("GENERAL crea 906 cuentas y PYMES 794, sin huérfanos", () => {
    const general = filterByVariant(rows, "GENERAL")
    const pymes = filterByVariant(rows, "PYMES")
    expect(general.ok && general.value).toHaveLength(906)
    expect(pymes.ok && pymes.value).toHaveLength(794)
  })

  it("PYMES no contiene ninguna cuenta con pymes = 0 ni grupos 8/9", () => {
    const pymes = filterByVariant(rows, "PYMES")
    if (!pymes.ok) throw new Error("filtro PYMES fallido")
    expect(pymes.value.every((r) => r.pymes)).toBe(true)
    expect(pymes.value.filter((r) => r.code.startsWith("8") || r.code.startsWith("9"))).toHaveLength(0)
    expect(pymes.value.find((r) => r.code === "6632")).toBeUndefined()
  })

  it("`isPostable` se RECALCULA sobre el subconjunto, no se copia del seed", () => {
    const pymes = filterByVariant(rows, "PYMES")
    if (!pymes.ok) throw new Error("filtro PYMES fallido")
    const plan = buildPlan(seedRowsToPlanAccounts(pymes.value))
    // 663 conserva 6630/6631/6633 en PYMES: sigue siendo agregadora (ver DUDA-2
    // del informe: el diseño la daba por postable tras filtrar sólo 6632).
    expect(plan.byCode.get("663")?.isPostable).toBe(false)
    expect(plan.byCode.get("6630")?.isPostable).toBe(true)
    // Toda cuenta postable es hoja y tiene al menos 3 dígitos.
    for (const account of plan.byCode.values()) {
      if (!account.isPostable) continue
      expect(account.code.length, account.code).toBeGreaterThanOrEqual(3)
      expect(plan.codes.some((c) => c !== account.code && c.startsWith(account.code)), account.code).toBe(false)
    }
  })

  it("toda cuenta PYMES con estado financiero trae epígrafe abreviado", () => {
    const pymes = rows.filter((r) => r.pymes && r.statement !== null && r.epigraph !== null)
    const sinEpigrafePymes = pymes.filter((r) => r.epigraphPymes === null)
    expect(sinEpigrafePymes.map((r) => r.code)).toEqual([])
  })

  it("el catálogo de epígrafes es cerrado y distinto por variante (R-15)", () => {
    const general = epigraphCatalog(rows, "GENERAL")
    const pymes = epigraphCatalog(rows, "PYMES")
    expect(general.size).toBeGreaterThan(0)
    expect(pymes.size).toBeGreaterThan(0)
    expect(general.has("20. Impuestos sobre beneficios")).toBe(true)
    expect(pymes.has("20. Impuestos sobre beneficios")).toBe(false)
    expect(pymes.has("19. Impuestos sobre beneficios")).toBe(true)
  })
})

describe("I-plan-1 · el mapa de sistema resuelve en ambas variantes y con ambos `useSubaccounts`", () => {
  for (const variant of ["GENERAL", "PYMES"] as const) {
    for (const useSubaccounts of [true, false]) {
      it(`${variant} · useSubaccounts=${useSubaccounts}: las 43 claves obligatorias resuelven a hoja activa`, () => {
        const filtered = filterByVariant(rows, variant)
        if (!filtered.ok) throw new Error("filtro fallido")
        const accounts = seedRowsToPlanAccounts(filtered.value)
        // Las subcuentas operativas se añaden como haría `importNpgc`.
        if (useSubaccounts) {
          const extra = [
            { code: "5720", parent: "572" },
            { code: "47510", parent: "4751" },
            { code: "47511", parent: "4751" },
            { code: "47512", parent: "4751" },
          ]
          for (const row of extra) {
            const parent = accounts.find((a) => a.code === row.parent)
            if (!parent) continue
            parent.isPostable = false
            accounts.push({ ...parent, code: row.code, level: row.code.length, parentCode: parent.code, isPostable: true })
          }
        }
        const plan = buildPlan(accounts)
        const { entries, unresolved } = defaultAccountMap(plan, { useSubaccounts })
        expect(unresolved).toEqual([])
        const check = validateAccountMap(entries, plan, REQUIRED_ACCOUNT_KEYS)
        expect(check.ok, check.ok ? "" : JSON.stringify(check.errors)).toBe(true)
        // E8 · T2: 15 opcionales desde `PROVEEDORES_INMOVILIZADO` (523).
        // E7 · ADR-0015 (m1): 18 con 662, 669 y 665.
        expect(entries.length).toBe(REQUIRED_ACCOUNT_KEYS.length + 18)
      })
    }
  }
})
