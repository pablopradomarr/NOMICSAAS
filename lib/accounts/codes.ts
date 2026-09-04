/**
 * E2 · T3 — Códigos de cuenta y jerarquía por prefijo (§3, reglas R-01…R-04).
 * Módulo puro.
 */

import { AccountCode, err, fail, ok, Plan, PlanAccount, Result } from "@/lib/accounts/types"

/** R-01: dígitos, sin `0` a la izquierda, de 1 a 12 caracteres. Igual que el CHECK de BD. */
export const ACCOUNT_CODE_RE = /^[1-9][0-9]{0,11}$/

/** Longitud mínima para que una cuenta pueda recibir apuntes (R-02). */
export const MIN_POSTABLE_LEVEL = 3

export const MAX_CODE_LENGTH = 12

/**
 * R-01 (+R-02 si `mustBePostable`). Devuelve el código como `AccountCode`.
 * No consulta el plan: la unicidad la comprueba `validateNewAccount`.
 */
export function validateAccountCode(code: string, opts: { mustBePostable?: boolean } = {}): Result<AccountCode> {
  const value = code.trim()
  if (!ACCOUNT_CODE_RE.test(value)) {
    return fail(
      err(
        "CODE_FORMAT",
        "code",
        `El código «${code}» debe tener entre 1 y ${MAX_CODE_LENGTH} dígitos y no empezar por 0`
      )
    )
  }
  if (opts.mustBePostable && value.length < MIN_POSTABLE_LEVEL) {
    return fail(
      err(
        "CODE_TOO_SHORT",
        "code",
        `Una cuenta con apuntes necesita al menos ${MIN_POSTABLE_LEVEL} dígitos: «${value}» es un grupo o subgrupo`
      )
    )
  }
  return ok(value as AccountCode)
}

/** Nivel de una cuenta = longitud de su código. */
export function accountLevel(code: string): number {
  return code.length
}

/** Grupo PGC (primer dígito) del código. */
export function accountGroup(code: string): string {
  return code.slice(0, 1)
}

/**
 * Prefijo estricto MÁS LARGO que existe en el plan (divergencia consciente T-6
 * respecto a R-03, que exige `code[:-1]`): `7050001` cuelga de `705` aunque
 * `70500` y `705000` no existan. El agregado por prefijo sigue siendo exacto.
 */
export function resolveParentCode(code: string, plan: Plan): string | null {
  for (let n = code.length - 1; n >= 1; n--) {
    const candidate = code.slice(0, n)
    if (plan.byCode.has(candidate)) return candidate
  }
  return null
}

/** Igual que `resolveParentCode` pero sobre un conjunto de códigos (usado por el seed). */
export function resolveParentCodeIn(code: string, codes: ReadonlySet<string>): string | null {
  for (let n = code.length - 1; n >= 1; n--) {
    const candidate = code.slice(0, n)
    if (codes.has(candidate)) return candidate
  }
  return null
}

/** `true` si `parent` es prefijo estricto de `code`. */
export function isStrictPrefix(parent: string, code: string): boolean {
  return parent.length < code.length && code.startsWith(parent)
}

/** Construye el índice inmutable del plan. Ordena por código ascendente. */
export function buildPlan(accounts: readonly PlanAccount[]): Plan {
  const sorted = [...accounts].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
  const byCode = new Map<string, PlanAccount>()
  for (const account of sorted) byCode.set(account.code, account)
  return { byCode, codes: sorted.map((a) => a.code) }
}

/** Hijos DIRECTOS de una cuenta (los que la tienen como `parentCode`). */
export function childrenOf(plan: Plan, code: string): PlanAccount[] {
  const out: PlanAccount[] = []
  for (const child of plan.byCode.values()) {
    if (child.parentCode === code) out.push(child)
  }
  return out.sort((a, b) => (a.code < b.code ? -1 : 1))
}

/** Descendientes (por prefijo) de una cuenta, ordenados. */
export function descendantsOf(plan: Plan, code: string): PlanAccount[] {
  const out: PlanAccount[] = []
  for (const candidate of plan.codes) {
    if (isStrictPrefix(code, candidate)) {
      const account = plan.byCode.get(candidate)
      if (account) out.push(account)
    }
  }
  return out
}

/**
 * I-E2-2: una cuenta es postable si y solo si no tiene hijos.
 * Se recalcula sobre el conjunto de códigos EFECTIVAMENTE creado (tras el
 * filtrado por variante): al excluir `6632`, `663` sigue teniendo `6630`, y al
 * excluir todos los hijos de una cuenta, ésta pasa a ser hoja y postable.
 */
export function computeIsPostable(code: string, allCodes: ReadonlySet<string>): boolean {
  if (code.length < MIN_POSTABLE_LEVEL) return false
  for (const candidate of allCodes) {
    if (isStrictPrefix(code, candidate)) return false
  }
  return true
}
