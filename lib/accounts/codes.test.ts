import { describe, expect, it } from "vitest"
import {
  accountLevel,
  buildPlan,
  childrenOf,
  computeIsPostable,
  descendantsOf,
  isStrictPrefix,
  resolveParentCode,
  validateAccountCode,
} from "@/lib/accounts/codes"
import type { PlanAccount } from "@/lib/accounts/types"

function account(code: string, extra: Partial<PlanAccount> = {}): PlanAccount {
  return {
    code,
    name: `Cuenta ${code}`,
    level: code.length,
    parentCode: null,
    nature: "DEUDORA",
    statement: null,
    epigraph: null,
    epigraphPymes: null,
    bidirectional: false,
    isContra: false,
    analyticType: null,
    cashflowBucket: null,
    isPostable: true,
    isActive: true,
    isSystem: false,
    origin: "SEED",
    ...extra,
  }
}

describe("validateAccountCode (R-01 / R-02)", () => {
  it("acepta los códigos límite: 1 dígito y 12 dígitos", () => {
    expect(validateAccountCode("7").ok).toBe(true)
    expect(validateAccountCode("123456789012").ok).toBe(true)
  })

  it("rechaza 13 dígitos, cero a la izquierda, vacío y no numéricos", () => {
    for (const bad of ["1234567890123", "0705", "", "70a", "70-5", " 705 x"]) {
      const result = validateAccountCode(bad)
      expect(result.ok, bad).toBe(false)
      if (!result.ok) expect(result.errors[0].code).toBe("CODE_FORMAT")
    }
  })

  it("R-02: con menos de 3 dígitos no puede ser postable", () => {
    const result = validateAccountCode("70", { mustBePostable: true })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0].code).toBe("CODE_TOO_SHORT")
    expect(validateAccountCode("705", { mustBePostable: true }).ok).toBe(true)
  })

  it("normaliza espacios alrededor", () => {
    const result = validateAccountCode("  705  ")
    expect(result.ok && result.value).toBe("705")
  })
})

describe("resolveParentCode (I-E2-1, divergencia T-6)", () => {
  const plan = buildPlan([account("7"), account("70"), account("705")])

  it("plan vacío: no hay padre posible", () => {
    expect(resolveParentCode("705", buildPlan([]))).toBeNull()
  })

  it("un solo registro: el prefijo existente", () => {
    expect(resolveParentCode("705", buildPlan([account("7")]))).toBe("7")
  })

  it("prefijo existente MÁS LARGO, no code[:-1]", () => {
    expect(resolveParentCode("7050001", plan)).toBe("705")
  })

  it("una cuenta raíz de un dígito no tiene padre", () => {
    expect(resolveParentCode("7", plan)).toBeNull()
  })

  it("isStrictPrefix no considera padre de sí misma", () => {
    expect(isStrictPrefix("705", "705")).toBe(false)
    expect(isStrictPrefix("705", "7050")).toBe(true)
  })
})

describe("computeIsPostable (I-E2-2)", () => {
  it("caso vacío: una cuenta de 3 dígitos sola es postable", () => {
    expect(computeIsPostable("705", new Set(["705"]))).toBe(true)
  })

  it("con un hijo deja de serlo, y al desaparecer el hijo vuelve a serlo", () => {
    expect(computeIsPostable("705", new Set(["705", "7050"]))).toBe(false)
    expect(computeIsPostable("705", new Set(["705"]))).toBe(true)
  })

  it("grupos y subgrupos nunca son postables (R-02)", () => {
    expect(computeIsPostable("7", new Set(["7"]))).toBe(false)
    expect(computeIsPostable("70", new Set(["70"]))).toBe(false)
  })

  it("un descendiente lejano también degrada al ancestro", () => {
    expect(computeIsPostable("705", new Set(["705", "7050001"]))).toBe(false)
  })
})

describe("buildPlan / childrenOf / descendantsOf", () => {
  const plan = buildPlan([
    account("7050", { parentCode: "705" }),
    account("705", { parentCode: "70" }),
    account("70", { parentCode: "7" }),
    account("7"),
    account("70500001", { parentCode: "7050" }),
  ])

  it("ordena por código ascendente", () => {
    expect(plan.codes).toEqual(["7", "70", "705", "7050", "70500001"])
  })

  it("plan vacío", () => {
    const empty = buildPlan([])
    expect(empty.codes).toEqual([])
    expect(empty.byCode.size).toBe(0)
  })

  it("childrenOf devuelve sólo los hijos directos", () => {
    expect(childrenOf(plan, "705").map((a) => a.code)).toEqual(["7050"])
  })

  it("descendantsOf devuelve toda la rama", () => {
    expect(descendantsOf(plan, "705").map((a) => a.code)).toEqual(["7050", "70500001"])
  })

  it("accountLevel es la longitud del código", () => {
    expect(accountLevel("70500001")).toBe(8)
  })
})
