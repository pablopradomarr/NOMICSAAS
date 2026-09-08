import { describe, expect, it } from "vitest"
import { buildPlan } from "@/lib/accounts/codes"
import {
  ACCOUNT_KEY_DEFAULT_CODE,
  DEFERRED_ACCOUNT_KEYS,
  defaultAccountMap,
  extraAccountsToCreate,
  OPTIONAL_ACCOUNT_KEYS,
  REQUIRED_ACCOUNT_KEYS,
  validateAccountMap,
} from "@/lib/accounts/map"
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

// E8 · T2: `PROVEEDORES_INMOVILIZADO` (523) subió el enum de 57 a 58 claves.
// E7 · ADR-0015 (m1): `INTERESES_DEUDAS` (662), `OTROS_GASTOS_FINANCIEROS` (669)
// e `INTERESES_DESCUENTO_EFECTOS` (665) lo suben a 61. Las cuatro son
// OPCIONALES —una organización cuyo plan no tenga la cuenta postable no debe
// fallar la migración—, así que las 43 obligatorias no se mueven.
describe("AccountKey — 80 claves, 43 obligatorias (D2-7, E-4, E8·T2, E7·ADR-0015, E9·ADR-0016)", () => {
  it("43 obligatorias + 18 declaradas + 19 diferidas a M4, sin solapes ni duplicados", () => {
    expect(REQUIRED_ACCOUNT_KEYS).toHaveLength(43)
    expect(OPTIONAL_ACCOUNT_KEYS).toHaveLength(18)
    // E9 · ADR-0016: las diecinueve nuevas se declaran pero NO entran en el mapa
    // automático (ver `DEFERRED_ACCOUNT_KEYS`): las siembra M4 donde la cuenta
    // exista y sea postable.
    expect(DEFERRED_ACCOUNT_KEYS).toHaveLength(19)
    const todas = [...REQUIRED_ACCOUNT_KEYS, ...OPTIONAL_ACCOUNT_KEYS, ...DEFERRED_ACCOUNT_KEYS]
    expect(new Set(todas).size).toBe(80)
    // La invariante que importa: NINGUNA clave del enum se queda sin declarar.
    expect(Object.keys(ACCOUNT_KEY_DEFAULT_CODE)).toHaveLength(80)
    expect(new Set(todas)).toEqual(new Set(Object.keys(ACCOUNT_KEY_DEFAULT_CODE)))
  })

  it("E9 · O-14 / O-27: las claves diferidas NO las resuelve `defaultAccountMap`", () => {
    // `4728` no es cuenta oficial: si entrara en el mapa automático,
    // `resolvePostable` subiría al ancestro y el IVA soportado PENDIENTE de
    // devengo del RECC caería en `472`, junto al ya deducible.
    for (const key of DEFERRED_ACCOUNT_KEYS) {
      expect(OPTIONAL_ACCOUNT_KEYS).not.toContain(key)
      expect(REQUIRED_ACCOUNT_KEYS).not.toContain(key)
    }
    expect(ACCOUNT_KEY_DEFAULT_CODE.IVA_SOPORTADO_PENDIENTE_RECC).toBe("4728")
    expect(ACCOUNT_KEY_DEFAULT_CODE.IVA_REPERCUTIDO_PENDIENTE_RECC).toBe("4778")
    // O-26: el impuesto corriente es **6300**, no `630`.
    expect(ACCOUNT_KEY_DEFAULT_CODE.IMPUESTO_CORRIENTE).toBe("6300")
    // O-24: la contrapartida de la venta de inmovilizado es `543`, no `430`.
    expect(ACCOUNT_KEY_DEFAULT_CODE.CREDITO_ENAJENACION_CP).toBe("543")
  })

  it("E7 · ADR-0015 (m1): las tres claves nuevas resuelven a 662, 669 y 665", () => {
    expect(ACCOUNT_KEY_DEFAULT_CODE.INTERESES_DEUDAS).toBe("662")
    expect(ACCOUNT_KEY_DEFAULT_CODE.OTROS_GASTOS_FINANCIEROS).toBe("669")
    expect(ACCOUNT_KEY_DEFAULT_CODE.INTERESES_DESCUENTO_EFECTOS).toBe("665")
  })

  it("E8 · ADR-0014 D6: `PROVEEDORES_INMOVILIZADO` resuelve a 523, no a 173", () => {
    expect(ACCOUNT_KEY_DEFAULT_CODE.PROVEEDORES_INMOVILIZADO).toBe("523")
  })

  it("todo código por defecto es un código PGC válido de 3 a 5 dígitos", () => {
    for (const [key, code] of Object.entries(ACCOUNT_KEY_DEFAULT_CODE)) {
      expect(code, key).toMatch(/^[1-9][0-9]{2,4}$/)
    }
  })
})

describe("defaultAccountMap — resolución a hoja postable", () => {
  it("plan vacío: ninguna clave resuelve", () => {
    const { entries, unresolved } = defaultAccountMap(buildPlan([]), { useSubaccounts: true })
    expect(entries).toEqual([])
    expect(unresolved).toHaveLength(61)
  })

  it("un solo registro: la clave cae en su cuenta y el resto queda sin resolver", () => {
    const plan = buildPlan([account("705")])
    const { entries } = defaultAccountMap(plan, { useSubaccounts: false })
    expect(entries).toEqual([
      { key: "VENTAS_DEFAULT", accountCode: "705", requested: "705", fallback: "NONE" },
    ])
  })

  it("si la cuenta del default tiene hijos, BAJA a la hoja de menor código (430 → 4300)", () => {
    const plan = buildPlan([
      account("430", { isPostable: false }),
      account("4300", { parentCode: "430" }),
      account("4309", { parentCode: "430" }),
    ])
    const { entries } = defaultAccountMap(plan, { useSubaccounts: false })
    const clientes = entries.find((e) => e.key === "CLIENTES")
    expect(clientes).toEqual({ key: "CLIENTES", accountCode: "4300", requested: "430", fallback: "DESCENDANT" })
  })

  it("si el código no existe, SUBE al ancestro más cercano y lo reporta", () => {
    const plan = buildPlan([account("475")])
    const { entries } = defaultAccountMap(plan, { useSubaccounts: false })
    const irpf = entries.find((e) => e.key === "IRPF_A_PAGAR")
    expect(irpf).toEqual({ key: "IRPF_A_PAGAR", accountCode: "475", requested: "4751", fallback: "ANCESTOR" })
  })

  it("useSubaccounts apunta las tres claves de IRPF a 47510/47511/47512", () => {
    const plan = buildPlan([
      account("4751", { isPostable: false }),
      account("47510", { parentCode: "4751" }),
      account("47511", { parentCode: "4751" }),
      account("47512", { parentCode: "4751" }),
    ])
    const { entries } = defaultAccountMap(plan, { useSubaccounts: true })
    const byKey = new Map(entries.map((e) => [e.key, e.accountCode]))
    expect(byKey.get("IRPF_PROFESIONALES_A_PAGAR")).toBe("47510")
    expect(byKey.get("IRPF_ALQUILERES_A_PAGAR")).toBe("47511")
    expect(byKey.get("IRPF_TRABAJO_A_PAGAR")).toBe("47512")
    expect(byKey.get("IRPF_A_PAGAR")).toBe("47510")
  })

  it("con cuentas de software, TODAS las claves de 472/477 bajan a la hoja (I-plan-1)", () => {
    const plan = buildPlan([
      account("472", { isPostable: false }),
      account("4720", { parentCode: "472" }),
      account("477", { isPostable: false }),
      account("4770", { parentCode: "477" }),
    ])
    const { entries } = defaultAccountMap(plan, { useSubaccounts: false, createSoftwareAccounts: true })
    const byKey = new Map(entries.map((e) => [e.key, e.accountCode]))
    expect(byKey.get("IVA_SOPORTADO")).toBe("4720")
    expect(byKey.get("IVA_SOPORTADO_ISP")).toBe("4720")
    expect(byKey.get("IVA_REPERCUTIDO")).toBe("4770")
    expect(byKey.get("IVA_REPERCUTIDO_ISP")).toBe("4770")
    expect(validateAccountMap(entries, plan, []).ok).toBe(true)
  })

  it("una cuenta inactiva no resuelve", () => {
    const plan = buildPlan([account("705", { isActive: false })])
    const { entries, unresolved } = defaultAccountMap(plan, { useSubaccounts: false })
    expect(entries).toEqual([])
    expect(unresolved).toContain("VENTAS_DEFAULT")
  })
})

describe("validateAccountMap (I-plan-1 / R-07)", () => {
  const plan = buildPlan([
    account("430", { isPostable: false }),
    account("4300", { parentCode: "430" }),
    account("640", { isActive: false }),
  ])

  it("una clave obligatoria sin mapear es un fallo", () => {
    const result = validateAccountMap([], plan, ["CLIENTES"])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0].code).toBe("KEY_MISSING")
  })

  it("apuntar a cuenta inexistente, inactiva o no postable falla", () => {
    const inexistente = validateAccountMap([{ key: "CLIENTES", accountCode: "999" }], plan, [])
    expect(inexistente.ok).toBe(false)
    if (!inexistente.ok) expect(inexistente.errors[0].code).toBe("ACCOUNT_NOT_FOUND")

    const noPostable = validateAccountMap([{ key: "CLIENTES", accountCode: "430" }], plan, [])
    expect(noPostable.ok).toBe(false)
    if (!noPostable.ok) expect(noPostable.errors[0].code).toBe("ACCOUNT_NOT_POSTABLE")

    const inactiva = validateAccountMap([{ key: "SUELDOS_DEFAULT", accountCode: "640" }], plan, [])
    expect(inactiva.ok).toBe(false)
    if (!inactiva.ok) expect(inactiva.errors[0].code).toBe("ACCOUNT_INACTIVE")
  })

  it("el caso correcto pasa", () => {
    expect(validateAccountMap([{ key: "CLIENTES", accountCode: "4300" }], plan, ["CLIENTES"]).ok).toBe(true)
  })
})

describe("extraAccountsToCreate", () => {
  it("no crea nada si no hay padre en el plan; crea 5720 si existe 572", () => {
    expect(extraAccountsToCreate(buildPlan([]), { useSubaccounts: true })).toEqual([])
    const plan = buildPlan([account("572")])
    expect(extraAccountsToCreate(plan, { useSubaccounts: true }).map((a) => a.code)).toEqual(["5720"])
  })

  it("no duplica las que ya existen", () => {
    const plan = buildPlan([account("572"), account("5720", { parentCode: "572" })])
    expect(extraAccountsToCreate(plan, { useSubaccounts: true })).toEqual([])
  })

  it("las de software sólo con `createSoftwareAccounts` (C-6: no por defecto)", () => {
    const plan = buildPlan([account("472"), account("477")])
    expect(extraAccountsToCreate(plan, { useSubaccounts: false })).toEqual([])
    expect(
      extraAccountsToCreate(plan, { useSubaccounts: false, createSoftwareAccounts: true }).map((a) => a.code)
    ).toEqual(["4720", "4770"])
  })
})
