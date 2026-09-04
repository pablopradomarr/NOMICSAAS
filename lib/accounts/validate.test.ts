import { describe, expect, it } from "vitest"
import { buildPlan } from "@/lib/accounts/codes"
import { buildAccountTree, flattenTree } from "@/lib/accounts/tree"
import { EMPTY_USAGE, type PlanAccount } from "@/lib/accounts/types"
import {
  applyNewAccount,
  canDeactivateAccount,
  canDeleteAccount,
  checkStatementGroup,
  validateAccountUpdate,
  validateNewAccount,
  validateVariantChange,
  type EditContext,
} from "@/lib/accounts/validate"

function account(code: string, extra: Partial<PlanAccount> = {}): PlanAccount {
  return {
    code,
    name: `Cuenta ${code}`,
    level: code.length,
    parentCode: code.length > 1 ? code.slice(0, code.length - 1) : null,
    nature: "DEUDORA",
    statement: null,
    epigraph: null,
    epigraphPymes: null,
    bidirectional: false,
    isContra: false,
    analyticType: null,
    cashflowCategory: null,
    isPostable: true,
    isActive: true,
    isSystem: false,
    origin: "SEED",
    ...extra,
  }
}

const plan = buildPlan([
  account("7", { parentCode: null, isPostable: false, nature: "ACREEDORA" }),
  account("70", { parentCode: "7", isPostable: false, nature: "ACREEDORA" }),
  account("705", {
    parentCode: "70",
    nature: "ACREEDORA",
    statement: "PYG",
    epigraph: "1. Importe neto de la cifra de negocios",
    epigraphPymes: "1. Importe neto de la cifra de negocios",
    analyticType: "INGRESO_DIRECTO",
  }),
  account("572", { parentCode: "57", isPostable: true, statement: "BALANCE_ACTIVO", isSystem: true }),
  account("57", { parentCode: "5", isPostable: false }),
  account("5", { parentCode: null, isPostable: false }),
  account("640", { parentCode: "64", isPostable: true, statement: "PYG", isActive: false }),
  account("64", { parentCode: "6", isPostable: false }),
  account("6", { parentCode: null, isPostable: false }),
])

const ctx = (over: Partial<EditContext> = {}): EditContext => ({
  plan,
  role: "ADMIN",
  variant: "GENERAL",
  epigraphCatalog: new Set(["1. Importe neto de la cifra de negocios", "5. Otros ingresos de explotación"]),
  usage: EMPTY_USAGE,
  hasClosedPeriodLines: false,
  activeAllocationRuns: 0,
  ...over,
})

describe("validateNewAccount (R-01…R-05, criterio 3)", () => {
  it("hereda del padre y nace postable", () => {
    const result = validateNewAccount({ code: "7050001", name: "Consultoría – Cliente X" }, plan, EMPTY_USAGE)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({
      parentCode: "705",
      level: 7,
      statement: "PYG",
      epigraph: "1. Importe neto de la cifra de negocios",
      analyticType: "INGRESO_DIRECTO",
      nature: "ACREEDORA",
      isPostable: true,
      origin: "MANUAL",
    })
  })

  it("rechaza el código duplicado", () => {
    const result = validateNewAccount({ code: "705", name: "Otra" }, plan, EMPTY_USAGE)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("CODE_DUPLICATE")
  })

  it("R-05: no se cuelga un hijo de una cuenta con apuntes", () => {
    const result = validateNewAccount({ code: "7050002", name: "X" }, plan, { ...EMPTY_USAGE, movementCount: 3 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("PARENT_HAS_MOVEMENTS")
  })

  it("R-03: padre inactivo bloquea", () => {
    const result = validateNewAccount({ code: "6400001", name: "X" }, plan, EMPTY_USAGE)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("PARENT_INACTIVE")
  })

  it("plan vacío: no hay padre donde colgarla", () => {
    const result = validateNewAccount({ code: "705", name: "X" }, buildPlan([]), EMPTY_USAGE)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("PARENT_NOT_FOUND")
  })
})

describe("applyNewAccount (R-04 / I-E2-2)", () => {
  it("degrada al padre a no postable y lo REPORTA para persistirlo en la misma transacción", () => {
    const nueva = validateNewAccount({ code: "7050001", name: "X" }, plan, EMPTY_USAGE)
    if (!nueva.ok) throw new Error("alta inválida")
    const { plan: next, parentDemoted } = applyNewAccount(plan, nueva.value)
    expect(parentDemoted).toBe("705")
    expect(next.byCode.get("705")?.isPostable).toBe(false)
    expect(next.byCode.get("7050001")?.isPostable).toBe(true)
  })

  it("si el padre ya era agregadora no hay nada que degradar", () => {
    const cuenta = account("5721", { parentCode: "572" })
    const conHijo = applyNewAccount(plan, cuenta)
    expect(conHijo.parentDemoted).toBe("572")
    const otra = applyNewAccount(conHijo.plan, account("5722", { parentCode: "572" }))
    expect(otra.parentDemoted).toBeNull()
  })
})

describe("checkStatementGroup (R-11 / R-12)", () => {
  it("un gasto no puede presentarse en balance ni un activo en PyG", () => {
    expect(checkStatementGroup("640", "BALANCE_ACTIVO")?.code).toBe("STATEMENT_GROUP_MISMATCH")
    expect(checkStatementGroup("430", "PYG")?.code).toBe("STATEMENT_GROUP_MISMATCH")
  })

  it("ECPN sólo en grupos 8/9, y los grupos 8/9 sólo en ECPN", () => {
    expect(checkStatementGroup("705", "ECPN")?.code).toBe("STATEMENT_GROUP_MISMATCH")
    expect(checkStatementGroup("800", "PYG")?.code).toBe("STATEMENT_GROUP_MISMATCH")
    expect(checkStatementGroup("800", "ECPN")).toBeNull()
  })

  it("los casos correctos no producen error", () => {
    expect(checkStatementGroup("705", "PYG")).toBeNull()
    expect(checkStatementGroup("430", "BALANCE_ACTIVO")).toBeNull()
    expect(checkStatementGroup("705", null)).toBeNull()
  })
})

describe("validateAccountUpdate (R-06, R-10a, R-10b, R-15, R-16, R-19, R-21)", () => {
  const cuenta = plan.byCode.get("705") as PlanAccount

  it("R-19: renombrar siempre se permite, también en cuentas de sistema", () => {
    const sistema = plan.byCode.get("572") as PlanAccount
    const result = validateAccountUpdate(sistema, { name: "Banco Santander c/c" }, ctx())
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.patch).toEqual({ name: "Banco Santander c/c" })
  })

  it("R-10a: el estado financiero de una cuenta oficial de nivel ≤ 3 está bloqueado para todos", () => {
    const result = validateAccountUpdate(cuenta, { statement: "BALANCE_ACTIVO" }, ctx())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0].code).toBe("STATEMENT_LOCKED")
  })

  it("R-10b: cambiar el epígrafe exige ADMIN y motivo", () => {
    const sinMotivo = validateAccountUpdate(cuenta, { epigraph: "5. Otros ingresos de explotación" }, ctx())
    expect(sinMotivo.ok).toBe(false)
    if (!sinMotivo.ok) expect(sinMotivo.errors.map((e) => e.code)).toContain("REASON_REQUIRED")

    const comoEditor = validateAccountUpdate(
      cuenta,
      { epigraph: "5. Otros ingresos de explotación", reason: "reclasificación" },
      ctx({ role: "EDITOR" })
    )
    expect(comoEditor.ok).toBe(false)
    if (!comoEditor.ok) expect(comoEditor.errors.map((e) => e.code)).toContain("ROLE_REQUIRED")

    const conMotivo = validateAccountUpdate(
      cuenta,
      { epigraph: "5. Otros ingresos de explotación", reason: "reclasificación" },
      ctx()
    )
    expect(conMotivo.ok).toBe(true)
  })

  it("R-15: un epígrafe fuera del catálogo cerrado se rechaza", () => {
    const result = validateAccountUpdate(cuenta, { epigraph: "Ventas varias", reason: "porque sí" }, ctx())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("EPIGRAPH_UNKNOWN")
  })

  it("R-10b: con líneas en un ejercicio cerrado, prohibido", () => {
    const result = validateAccountUpdate(
      cuenta,
      { epigraph: "5. Otros ingresos de explotación", reason: "reclasificación" },
      ctx({ hasClosedPeriodLines: true })
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("CLOSED_PERIOD")
  })

  it("R-16 / R-17 / R-18 son AVISOS: la mutación se guarda", () => {
    const result = validateAccountUpdate(cuenta, { analyticType: "FINANCIERO" }, ctx({ activeAllocationRuns: 2 }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.patch.analyticType).toBe("FINANCIERO")
    expect(result.value.warnings.map((w) => w.code).sort()).toEqual(["ALLOCATION_STALE", "ANALYTIC_INCOHERENT"])

    const cashflow = validateAccountUpdate(cuenta, { cashflowCategory: "OPERATING" }, ctx())
    expect(cashflow.ok).toBe(true)
    if (cashflow.ok) expect(cashflow.value.warnings[0].code).toBe("CASHFLOW_UNEXPECTED")
  })

  it("R-21 / T-5: el código es inmutable en E2", () => {
    const result = validateAccountUpdate(cuenta, { code: "7051" }, ctx())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0].code).toBe("CODE_IMMUTABLE")
  })

  it("desactivar exige motivo y respeta R-06", () => {
    const sinMotivo = validateAccountUpdate(cuenta, { isActive: false }, ctx())
    expect(sinMotivo.ok).toBe(false)
    if (!sinMotivo.ok) expect(sinMotivo.errors.map((e) => e.code)).toContain("REASON_REQUIRED")

    const conMotivo = validateAccountUpdate(cuenta, { isActive: false, reason: "no se usa" }, ctx())
    expect(conMotivo.ok).toBe(true)
    if (conMotivo.ok) expect(conMotivo.value.patch.isActive).toBe(false)
  })
})

describe("canDeactivateAccount / canDeleteAccount (R-06, R-08)", () => {
  it("una cuenta de sistema no se desactiva ni se borra", () => {
    const sistema = plan.byCode.get("572") as PlanAccount
    const off = canDeactivateAccount(sistema, plan)
    expect(off.ok).toBe(false)
    if (!off.ok) expect(off.errors[0].code).toBe("SYSTEM_ACCOUNT")
  })

  it("no se desactiva una cuenta con hijos activos", () => {
    const con = canDeactivateAccount(plan.byCode.get("70") as PlanAccount, plan)
    expect(con.ok).toBe(false)
    if (!con.ok) expect(con.errors.map((e) => e.code)).toContain("HAS_CHILDREN")
  })

  it("criterio 4: la cuenta mapeada falla con IS_MAPPED; la libre se borra", () => {
    const cuenta = plan.byCode.get("705") as PlanAccount
    const mapeada = canDeleteAccount(cuenta, plan, { ...EMPTY_USAGE, mappedKeys: ["VENTAS_DEFAULT"] })
    expect(mapeada.ok).toBe(false)
    if (!mapeada.ok) expect(mapeada.errors.map((e) => e.code)).toContain("IS_MAPPED")

    expect(canDeleteAccount(cuenta, plan, EMPTY_USAGE).ok).toBe(true)
  })

  it("con apuntes o con tipos impositivos que la usan, tampoco", () => {
    const cuenta = plan.byCode.get("705") as PlanAccount
    const conApuntes = canDeleteAccount(cuenta, plan, { ...EMPTY_USAGE, movementCount: 1 })
    expect(conApuntes.ok).toBe(false)
    if (!conApuntes.ok) expect(conApuntes.errors.map((e) => e.code)).toContain("HAS_MOVEMENTS")

    const conTipos = canDeleteAccount(cuenta, plan, { ...EMPTY_USAGE, taxRateCodes: ["IVA_21"] })
    expect(conTipos.ok).toBe(false)
    if (!conTipos.ok) expect(conTipos.errors.map((e) => e.code)).toContain("IS_TAXED")
  })
})

describe("validateVariantChange (R-14)", () => {
  it("sin asientos posteados el cambio pasa; con asientos, VARIANT_LOCKED", () => {
    expect(validateVariantChange("PYMES", "GENERAL", 0).ok).toBe(true)
    const bloqueado = validateVariantChange("PYMES", "GENERAL", 1)
    expect(bloqueado.ok).toBe(false)
    if (!bloqueado.ok) expect(bloqueado.errors[0].code).toBe("VARIANT_LOCKED")
  })

  it("no cambiar de variante nunca bloquea, ni con asientos", () => {
    expect(validateVariantChange("PYMES", "PYMES", 999).ok).toBe(true)
  })
})

describe("buildAccountTree", () => {
  it("plan vacío devuelve árbol vacío", () => {
    const result = buildAccountTree([], { variant: "GENERAL" })
    expect(result.ok && result.value).toEqual([])
  })

  it("la búsqueda devuelve las coincidencias más sus ancestros", () => {
    const result = buildAccountTree([...plan.byCode.values()], { variant: "GENERAL", query: "705" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const flat = flattenTree(result.value)
    expect(flat.map((n) => n.account.code)).toEqual(["7", "70", "705"])
    expect(flat.filter((n) => n.matched).map((n) => n.account.code)).toEqual(["705"])
  })

  it("oculta las inactivas salvo que se pidan", () => {
    const sin = buildAccountTree([...plan.byCode.values()], { variant: "GENERAL" })
    const con = buildAccountTree([...plan.byCode.values()], { variant: "GENERAL", showInactive: true })
    expect(sin.ok && flattenTree(sin.value).some((n) => n.account.code === "640")).toBe(false)
    expect(con.ok && flattenTree(con.value).some((n) => n.account.code === "640")).toBe(true)
  })

  it("detecta un ciclo en la jerarquía", () => {
    const ciclo = [account("100", { parentCode: "200" }), account("200", { parentCode: "100" })]
    const result = buildAccountTree(ciclo, { variant: "GENERAL" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0].code).toBe("CSV_CYCLE")
  })
})
