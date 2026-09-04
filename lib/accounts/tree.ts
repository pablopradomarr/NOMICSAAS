/**
 * E2 · T3 — Árbol del plan para la UI (§3, `buildAccountTree`). Módulo puro.
 */

import { err, fail, ok } from "@/lib/accounts/types"
import { epigraphFor } from "@/lib/accounts/epigraphs"
import type { PgcVariant, Plan, PlanAccount, Result } from "@/lib/accounts/types"

export type AccountNode = {
  account: PlanAccount
  /** Epígrafe de la variante activa (el de la otra va en el tooltip de la UI). */
  epigraph: string | null
  /** `true` si la fila casa con la búsqueda (sus ancestros vienen con `false`). */
  matched: boolean
  children: AccountNode[]
}

export type BuildTreeOptions = {
  variant: PgcVariant
  query?: string
  showInactive?: boolean
}

function matches(account: PlanAccount, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === "") return true
  return account.code.toLowerCase().includes(q) || account.name.toLowerCase().includes(q)
}

/**
 * Árbol ordenado por código. Con `query` devuelve las coincidencias MÁS SUS
 * ANCESTROS (marcados `matched: false`), para que la rama siga siendo navegable.
 * Detecta ciclos en `parentCode` → `CSV_CYCLE`.
 */
export function buildAccountTree(
  accounts: readonly PlanAccount[],
  opts: BuildTreeOptions
): Result<AccountNode[]> {
  const visible = opts.showInactive ? accounts : accounts.filter((a) => a.isActive)
  const byCode = new Map(visible.map((a) => [a.code, a]))

  // Detección de ciclos: recorrer la cadena de padres de cada cuenta.
  for (const account of visible) {
    const seen = new Set<string>([account.code])
    let current = account.parentCode
    while (current) {
      if (seen.has(current)) {
        return fail(
          err("CSV_CYCLE", "parentCode", `Ciclo en la jerarquía del plan alrededor de la cuenta ${current}`)
        )
      }
      seen.add(current)
      current = byCode.get(current)?.parentCode ?? null
    }
  }

  const query = opts.query?.trim() ?? ""
  let keep: Set<string>
  if (query === "") {
    keep = new Set(visible.map((a) => a.code))
  } else {
    keep = new Set<string>()
    for (const account of visible) {
      if (!matches(account, query)) continue
      keep.add(account.code)
      let parent = account.parentCode
      while (parent && !keep.has(parent)) {
        keep.add(parent)
        parent = byCode.get(parent)?.parentCode ?? null
      }
    }
  }

  const nodes = new Map<string, AccountNode>()
  const ordered = visible
    .filter((a) => keep.has(a.code))
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))

  for (const account of ordered) {
    nodes.set(account.code, {
      account,
      epigraph: epigraphFor(account, opts.variant),
      matched: query === "" ? true : matches(account, query),
      children: [],
    })
  }

  const roots: AccountNode[] = []
  for (const account of ordered) {
    const node = nodes.get(account.code)
    if (!node) continue
    const parent = account.parentCode ? nodes.get(account.parentCode) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return ok(roots)
}

/** Aplana un árbol en orden de lectura (útil para la lista virtualizada y los tests). */
export function flattenTree(nodes: readonly AccountNode[]): AccountNode[] {
  const out: AccountNode[] = []
  const walk = (list: readonly AccountNode[]) => {
    for (const node of list) {
      out.push(node)
      walk(node.children)
    }
  }
  walk(nodes)
  return out
}

/** Devuelve el plan como lista ordenada por código. */
export function planAccounts(plan: Plan): PlanAccount[] {
  return plan.codes.map((code) => plan.byCode.get(code)).filter((a): a is PlanAccount => a !== undefined)
}
