/**
 * E2 · T5 — Mapa de cuentas de sistema (`OrganizationAccountMap`). Módulo puro.
 *
 * El motor contable NUNCA hardcodea un código: pide una `AccountKey` y este
 * módulo decide qué cuenta del plan de la organización la resuelve.
 */

import { childrenOf, isStrictPrefix } from "@/lib/accounts/codes"
import { AccountError, AccountKey, err, fail, ok, Plan, Result } from "@/lib/accounts/types"

export type AccountMapEntry = { key: AccountKey; accountCode: string }

export type DefaultMapOptions = {
  /** Crea/usa las hojas 5720, 47510-12… (§3.4). Default TRUE. */
  useSubaccounts: boolean
  /** 4720/4730/4760/4770 (convención de software, §2.5). Default FALSE. */
  createSoftwareAccounts?: boolean
}

/**
 * Las 43 claves del bloque obligatorio (I-plan-1). Las 14 restantes se declaran
 * en el enum pero no exigen mapeo hasta su épica.
 */
export const REQUIRED_ACCOUNT_KEYS: readonly AccountKey[] = [
  "CLIENTES",
  "PROVEEDORES",
  "ACREEDORES",
  "BANCO_DEFAULT",
  "CAJA",
  "IVA_SOPORTADO",
  "IVA_REPERCUTIDO",
  "IRPF_RETENIDO_CLIENTES",
  "IRPF_A_PAGAR",
  "HP_ACREEDORA_IVA",
  "HP_DEUDORA_IVA",
  "SS_ACREEDORA",
  "REMUNERACIONES_PENDIENTES",
  "RESULTADO_EJERCICIO",
  "VENTAS_DEFAULT",
  "COMPRAS_DEFAULT",
  "SUBCONTRATACION_DEFAULT",
  "ANTICIPOS_PROVEEDORES",
  "ANTICIPOS_CLIENTES",
  "DESCUENTO_PP_VENTAS",
  "DESCUENTO_PP_COMPRAS",
  "DEVOLUCION_VENTAS",
  "DEVOLUCION_COMPRAS",
  "RAPPEL_VENTAS",
  "RAPPEL_COMPRAS",
  "REDONDEO_GASTO",
  "REDONDEO_INGRESO",
  "IRPF_PROFESIONALES_A_PAGAR",
  "IRPF_ALQUILERES_A_PAGAR",
  "IRPF_TRABAJO_A_PAGAR",
  "IVA_SOPORTADO_ISP",
  "IVA_REPERCUTIDO_ISP",
  "AJUSTE_IVA_NEGATIVO",
  "AJUSTE_IVA_POSITIVO",
  "IMPUESTO_BENEFICIOS_GASTO",
  "HP_ACREEDORA_IS",
  "HP_DEUDORA_IS",
  "ACTIVO_IMPUESTO_DIFERIDO",
  "PASIVO_IMPUESTO_DIFERIDO",
  "PERIODIFICACION_GASTO",
  "PERIODIFICACION_INGRESO",
  "DIFERENCIA_CAMBIO_NEGATIVA",
  "DIFERENCIA_CAMBIO_POSITIVA",
] as const

/** Las 14 declaradas ahora y mapeadas por su épica (sin default obligatorio). */
export const OPTIONAL_ACCOUNT_KEYS: readonly AccountKey[] = [
  "RETENCIONES_CAPITAL_SOPORTADAS",
  "SS_DEUDORA",
  "ANTICIPOS_REMUNERACIONES",
  "SUELDOS_DEFAULT",
  "SS_EMPRESA_DEFAULT",
  "CLIENTES_DUDOSO_COBRO",
  "DETERIORO_CLIENTES",
  "DOTACION_DETERIORO_CREDITOS",
  "REVERSION_DETERIORO_CREDITOS",
  "PERDIDA_CREDITOS_INCOBRABLES",
  "CUENTA_PUENTE_TESORERIA",
  "COMISIONES_BANCARIAS",
  "REMANENTE",
  "RESULTADOS_NEGATIVOS_ANTERIORES",
] as const

/** Código PGC "de libro" de cada clave (§3.1 y §3.2 de la validación contable). */
export const ACCOUNT_KEY_DEFAULT_CODE: Readonly<Record<AccountKey, string>> = {
  CLIENTES: "430",
  PROVEEDORES: "400",
  ACREEDORES: "410",
  BANCO_DEFAULT: "572",
  CAJA: "570",
  IVA_SOPORTADO: "472",
  IVA_REPERCUTIDO: "477",
  IRPF_RETENIDO_CLIENTES: "473",
  IRPF_A_PAGAR: "4751",
  HP_ACREEDORA_IVA: "4750",
  HP_DEUDORA_IVA: "4700",
  SS_ACREEDORA: "476",
  REMUNERACIONES_PENDIENTES: "465",
  RESULTADO_EJERCICIO: "129",
  VENTAS_DEFAULT: "705",
  // T-7: `COMPRAS_DEFAULT` conserva 600 (nombre canónico de MODELO-DATOS);
  // la empresa de servicios usa `SUBCONTRATACION_DEFAULT` 607. Se decide en E3
  // cuál toma por defecto la factura recibida.
  COMPRAS_DEFAULT: "600",
  SUBCONTRATACION_DEFAULT: "607",
  ANTICIPOS_PROVEEDORES: "407",
  ANTICIPOS_CLIENTES: "438",
  DESCUENTO_PP_VENTAS: "706",
  DESCUENTO_PP_COMPRAS: "606",
  DEVOLUCION_VENTAS: "708",
  DEVOLUCION_COMPRAS: "608",
  RAPPEL_VENTAS: "709",
  RAPPEL_COMPRAS: "609",
  REDONDEO_GASTO: "669",
  REDONDEO_INGRESO: "769",
  IRPF_PROFESIONALES_A_PAGAR: "4751",
  IRPF_ALQUILERES_A_PAGAR: "4751",
  IRPF_TRABAJO_A_PAGAR: "4751",
  IVA_SOPORTADO_ISP: "472",
  IVA_REPERCUTIDO_ISP: "477",
  AJUSTE_IVA_NEGATIVO: "634",
  AJUSTE_IVA_POSITIVO: "639",
  IMPUESTO_BENEFICIOS_GASTO: "630",
  HP_ACREEDORA_IS: "4752",
  HP_DEUDORA_IS: "4709",
  ACTIVO_IMPUESTO_DIFERIDO: "4740",
  PASIVO_IMPUESTO_DIFERIDO: "479",
  PERIODIFICACION_GASTO: "480",
  PERIODIFICACION_INGRESO: "485",
  DIFERENCIA_CAMBIO_NEGATIVA: "668",
  DIFERENCIA_CAMBIO_POSITIVA: "768",
  RETENCIONES_CAPITAL_SOPORTADAS: "473",
  SS_DEUDORA: "471",
  ANTICIPOS_REMUNERACIONES: "460",
  SUELDOS_DEFAULT: "640",
  SS_EMPRESA_DEFAULT: "642",
  CLIENTES_DUDOSO_COBRO: "436",
  DETERIORO_CLIENTES: "490",
  DOTACION_DETERIORO_CREDITOS: "694",
  REVERSION_DETERIORO_CREDITOS: "794",
  PERDIDA_CREDITOS_INCOBRABLES: "650",
  CUENTA_PUENTE_TESORERIA: "555",
  COMISIONES_BANCARIAS: "626",
  REMANENTE: "120",
  RESULTADOS_NEGATIVOS_ANTERIORES: "121",
}

/**
 * Subcuentas operativas que `useSubaccounts` añade al plan (§3.4). `4300`,
 * `4000` y `4100` YA EXISTEN en el seed oficial, así que sólo hacen falta la
 * bancaria y el desglose de retenciones por modelo (111 / 115 / 111 trabajo).
 */
export const SUBACCOUNTS: readonly { code: string; name: string }[] = [
  { code: "5720", name: "Banco c/c principal" },
  { code: "47510", name: "Hacienda Pública, acreedora por retenciones — profesionales (modelo 111)" },
  { code: "47511", name: "Hacienda Pública, acreedora por retenciones — arrendamientos (modelo 115)" },
  { code: "47512", name: "Hacienda Pública, acreedora por retenciones — trabajo (modelo 111)" },
]

/** Cuentas de convención de software (§2.5, R-20): siempre subcuentas. */
export const SOFTWARE_ACCOUNTS: readonly { code: string; name: string }[] = [
  { code: "4720", name: "Hacienda Pública, IVA soportado (desglose)" },
  { code: "4730", name: "Hacienda Pública, retenciones y pagos a cuenta (desglose)" },
  { code: "4760", name: "Organismos de la Seguridad Social, acreedores (desglose)" },
  { code: "4770", name: "Hacienda Pública, IVA repercutido (desglose)" },
]

/** Preferencia de hoja cuando `useSubaccounts` está activo. */
const SUBACCOUNT_OVERRIDES: Partial<Record<AccountKey, string>> = {
  BANCO_DEFAULT: "5720",
  CLIENTES: "4300",
  PROVEEDORES: "4000",
  ACREEDORES: "4100",
  IRPF_A_PAGAR: "47510",
  IRPF_PROFESIONALES_A_PAGAR: "47510",
  IRPF_ALQUILERES_A_PAGAR: "47511",
  IRPF_TRABAJO_A_PAGAR: "47512",
}

/**
 * Preferencia cuando existen las cuentas de software. Ojo: al colgar `4720` de
 * `472`, la propia `472` deja de ser postable, así que TODAS las claves que
 * apuntaban a ella tienen que bajar a la hoja — si no, I-plan-1 se rompe.
 */
const SOFTWARE_OVERRIDES: Partial<Record<AccountKey, string>> = {
  IVA_SOPORTADO: "4720",
  IVA_SOPORTADO_ISP: "4720",
  IVA_REPERCUTIDO: "4770",
  IVA_REPERCUTIDO_ISP: "4770",
  IRPF_RETENIDO_CLIENTES: "4730",
  RETENCIONES_CAPITAL_SOPORTADAS: "4730",
  SS_ACREEDORA: "4760",
}

export type MapResolution = {
  key: AccountKey
  accountCode: string
  /** Código teórico si hubo que caer a otro (ancestro existente o hoja postable). */
  requested: string
  fallback: "NONE" | "ANCESTOR" | "DESCENDANT"
}

/**
 * Resuelve un código a una cuenta EXISTENTE, ACTIVA y POSTABLE del plan:
 * 1. si el código no existe, sube al ancestro más cercano que sí exista;
 * 2. si la cuenta encontrada no es postable (tiene hijos), baja a su
 *    descendiente postable de menor código — que en el PGC es siempre la
 *    subcuenta "general" (430 → 4300, 706 → 7060, 630 → 6300).
 */
export function resolvePostableCode(plan: Plan, code: string): MapResolution["fallback"] | null {
  return resolvePostable(plan, code)?.fallback ?? null
}

function resolvePostable(plan: Plan, code: string): { code: string; fallback: MapResolution["fallback"] } | null {
  let fallback: MapResolution["fallback"] = "NONE"
  let current = code
  if (!plan.byCode.has(current)) {
    let found: string | null = null
    for (let n = current.length - 1; n >= 1; n--) {
      const candidate = current.slice(0, n)
      if (plan.byCode.has(candidate)) {
        found = candidate
        break
      }
    }
    if (found === null) return null
    current = found
    fallback = "ANCESTOR"
  }
  const account = plan.byCode.get(current)
  if (!account) return null
  if (account.isPostable && account.isActive) return { code: current, fallback }

  // Descender a la hoja postable de menor código.
  const candidates = plan.codes
    .filter((c) => isStrictPrefix(current, c))
    .map((c) => plan.byCode.get(c))
    .filter((a) => a !== undefined && a.isPostable && a.isActive)
  const chosen = candidates[0]
  if (!chosen) return null
  return { code: chosen.code, fallback: fallback === "ANCESTOR" ? "ANCESTOR" : "DESCENDANT" }
}

/**
 * Defaults del mapa para un plan concreto. Sólo devuelve entradas que RESUELVEN;
 * las que no, van en `unresolved` (la organización las mapea a mano).
 */
export function defaultAccountMap(
  plan: Plan,
  opts: DefaultMapOptions
): { entries: MapResolution[]; unresolved: AccountKey[] } {
  const entries: MapResolution[] = []
  const unresolved: AccountKey[] = []
  const keys: AccountKey[] = [...REQUIRED_ACCOUNT_KEYS, ...OPTIONAL_ACCOUNT_KEYS]

  for (const key of keys) {
    let requested = ACCOUNT_KEY_DEFAULT_CODE[key]
    if (opts.createSoftwareAccounts && SOFTWARE_OVERRIDES[key] && plan.byCode.has(SOFTWARE_OVERRIDES[key]!)) {
      requested = SOFTWARE_OVERRIDES[key]!
    } else if (opts.useSubaccounts && SUBACCOUNT_OVERRIDES[key] && plan.byCode.has(SUBACCOUNT_OVERRIDES[key]!)) {
      requested = SUBACCOUNT_OVERRIDES[key]!
    }
    const resolved = resolvePostable(plan, requested)
    if (!resolved) {
      unresolved.push(key)
      continue
    }
    entries.push({ key, accountCode: resolved.code, requested, fallback: resolved.fallback })
  }
  return { entries, unresolved }
}

/**
 * I-plan-1 (R-07): toda entrada del mapa resuelve a una cuenta existente,
 * activa, postable y de la organización; y las claves `required` están todas.
 */
export function validateAccountMap(
  entries: readonly AccountMapEntry[],
  plan: Plan,
  required: readonly AccountKey[] = REQUIRED_ACCOUNT_KEYS
): Result<void> {
  const errors: AccountError[] = []
  const present = new Set(entries.map((e) => e.key))

  for (const key of required) {
    if (!present.has(key)) {
      errors.push(err("KEY_MISSING", "key", `La clave obligatoria ${key} no está mapeada a ninguna cuenta (I-plan-1)`))
    }
  }
  for (const entry of entries) {
    const account = plan.byCode.get(entry.accountCode)
    if (!account) {
      errors.push(
        err("ACCOUNT_NOT_FOUND", "accountCode", `${entry.key} apunta a ${entry.accountCode}, que no existe en el plan`)
      )
      continue
    }
    if (!account.isActive) {
      errors.push(err("ACCOUNT_INACTIVE", "accountCode", `${entry.key} apunta a ${entry.accountCode}, que está desactivada`))
    }
    if (!account.isPostable) {
      errors.push(
        err(
          "ACCOUNT_NOT_POSTABLE",
          "accountCode",
          `${entry.key} apunta a ${entry.accountCode}, que tiene subcuentas y no admite apuntes`
        )
      )
    }
  }
  return errors.length > 0 ? fail<void>(...errors) : ok(undefined as void)
}

/** Códigos que deben quedar `isSystem = true` (R-06): los del mapa. */
export function systemAccountCodes(entries: readonly AccountMapEntry[]): Set<string> {
  return new Set(entries.map((e) => e.accountCode))
}

/**
 * Cuentas que `useSubaccounts` / `createSoftwareAccounts` deben CREAR sobre un
 * plan ya sembrado (las que ya existen no se tocan). Su padre debe existir.
 */
export function extraAccountsToCreate(
  plan: Plan,
  opts: DefaultMapOptions
): { code: string; name: string }[] {
  const wanted = [...(opts.useSubaccounts ? SUBACCOUNTS : []), ...(opts.createSoftwareAccounts ? SOFTWARE_ACCOUNTS : [])]
  return wanted.filter((row) => {
    if (plan.byCode.has(row.code)) return false
    // Sólo se crea si su padre por prefijo existe en el plan de la variante.
    for (let n = row.code.length - 1; n >= 1; n--) {
      if (plan.byCode.has(row.code.slice(0, n))) return true
    }
    return false
  })
}

/** Hijos activos de una cuenta: usado por la UI para explicar por qué no es postable. */
export const activeChildrenOf = (plan: Plan, code: string) => childrenOf(plan, code).filter((c) => c.isActive)
