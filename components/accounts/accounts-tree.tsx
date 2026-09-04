"use client"

import { renameAccountAction } from "@/app/(app)/settings/accounts/actions"
import { AccountRowActions } from "@/components/accounts/account-row-actions"
import {
  ANALYTIC_TYPE_LABELS,
  CASHFLOW_LABELS,
  levelLabel,
  STATEMENT_LABELS,
  type ClassificationCatalog,
  type PlanAccount,
} from "@/components/accounts/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { buildAccountTree, type AccountNode } from "@/lib/accounts/tree"
import { cn } from "@/lib/utils"
import { ChevronDown, ChevronRight, Lock, Search } from "lucide-react"
import { useRouter } from "next/navigation"
import { useEffect, useMemo, useState, useTransition } from "react"

const ALL = "__all__"

type Filters = {
  query: string
  showInactive: boolean
  onlyPostable: boolean
  statement: string
}

/** Siguiente dígito libre bajo un padre: sugerencia de la UI, la valida el servidor. */
function suggestChildCode(parentCode: string, codes: ReadonlySet<string>): string {
  for (let digit = 0; digit <= 9; digit++) {
    const candidate = `${parentCode}${digit}`
    if (!codes.has(candidate)) return candidate
  }
  return `${parentCode}0`
}

function storageKey(organizationId: string): string {
  return `erp.accounts.expanded.${organizationId}`
}

/**
 * Árbol del plan contable: grupo → subgrupo → cuenta → subcuenta.
 *
 * El plan llega COMPLETO desde el Server Component; aquí sólo se filtra y se
 * pinta. No hay ninguna cifra: E2 es configuración, así que nada que sumar.
 * `VIEWER` y `EDITOR` reciben `canEdit = false` y no ven un solo control de
 * mutación (la autorización real vive en las server actions).
 */
export function AccountsTree({
  organizationId,
  accounts,
  catalog,
  canEdit,
  warningsByCode,
  mappedKeysByCode,
}: {
  organizationId: string
  accounts: PlanAccount[]
  catalog: ClassificationCatalog
  canEdit: boolean
  warningsByCode: Record<string, string>
  mappedKeysByCode: Record<string, string[]>
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [filters, setFilters] = useState<Filters>({
    query: "",
    showInactive: false,
    onlyPostable: false,
    statement: ALL,
  })
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<string | null>(null)
  const [draftName, setDraftName] = useState("")
  const [error, setError] = useState<string | null>(null)

  // Estado de expansión por organización: lo que un ADMIN dejó abierto sigue
  // abierto en la siguiente visita. Es preferencia de interfaz, no dato.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(storageKey(organizationId))
      // `localStorage` no existe en el servidor: la preferencia sólo puede
      // hidratarse después del montaje, de ahí el setState en el efecto.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (stored) setExpanded(new Set(JSON.parse(stored) as string[]))
    } catch {
      // Sin almacenamiento local el árbol arranca plegado: no es un error.
    }
  }, [organizationId])

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey(organizationId), JSON.stringify([...expanded]))
    } catch {
      // Ídem: no bloquea la pantalla.
    }
  }, [expanded, organizationId])

  const codes = useMemo(() => new Set(accounts.map((account) => account.code)), [accounts])

  const filtered = useMemo(() => {
    return accounts.filter((account) => {
      if (filters.onlyPostable && !account.isPostable) return false
      if (filters.statement !== ALL && account.statement !== filters.statement) return false
      return true
    })
  }, [accounts, filters.onlyPostable, filters.statement])

  const tree = useMemo(
    () =>
      buildAccountTree(filtered, {
        variant: catalog.variant,
        query: filters.query,
        showInactive: filters.showInactive,
      }),
    [filtered, catalog.variant, filters.query, filters.showInactive]
  )

  const searching = filters.query.trim() !== ""

  const visible = useMemo(() => {
    if (!tree.ok) return []
    const rows: { node: AccountNode; depth: number }[] = []
    const walk = (nodes: readonly AccountNode[], depth: number) => {
      for (const node of nodes) {
        rows.push({ node, depth })
        // Buscando, la rama que lleva a una coincidencia se abre sola.
        const open = searching || expanded.has(node.account.code)
        if (open) walk(node.children, depth + 1)
      }
    }
    walk(tree.ok ? tree.value : [], 0)
    return rows
  }, [tree, expanded, searching])

  const shownCount = useMemo(() => {
    if (!tree.ok) return 0
    let total = 0
    const walk = (nodes: readonly AccountNode[]) => {
      for (const node of nodes) {
        total++
        walk(node.children)
      }
    }
    walk(tree.value)
    return total
  }, [tree])

  const activeCount = accounts.filter((account) => account.isActive).length
  const postableCount = accounts.filter((account) => account.isPostable && account.isActive).length

  const toggle = (code: string) =>
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })

  const expandAll = () => setExpanded(new Set(accounts.filter((a) => a.level <= 2).map((a) => a.code)))
  const collapseAll = () => setExpanded(new Set())

  const commitRename = (account: PlanAccount) => {
    const name = draftName.trim()
    setEditing(null)
    if (name === "" || name === account.name) return
    setError(null)
    startTransition(async () => {
      const formData = new FormData()
      formData.set("code", account.code)
      formData.set("name", name)
      const state = await renameAccountAction(null, formData)
      if (!state.success) {
        setError(state.error ?? "No se ha podido renombrar la cuenta")
        return
      }
      router.refresh()
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex min-w-64 flex-1 flex-col gap-1">
          <span className="text-sm font-medium">Buscar</span>
          <span className="relative">
            <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={filters.query}
              onChange={(event) => setFilters((f) => ({ ...f, query: event.target.value }))}
              placeholder="Código o nombre (p. ej. 572 o «Bancos»)"
              className="pl-8"
              aria-label="Buscar cuenta por código o nombre"
            />
          </span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Estado financiero</span>
          <Select
            value={filters.statement}
            onValueChange={(value) => setFilters((f) => ({ ...f, statement: value }))}
          >
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Todos</SelectItem>
              {catalog.statements.map((statement) => (
                <SelectItem key={statement} value={statement}>
                  {STATEMENT_LABELS[statement] ?? statement}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <label className="flex items-center gap-2 pb-2 text-sm">
          <Checkbox
            checked={!filters.showInactive}
            onCheckedChange={(checked) => setFilters((f) => ({ ...f, showInactive: checked !== true }))}
          />
          Sólo activas
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <Checkbox
            checked={filters.onlyPostable}
            onCheckedChange={(checked) => setFilters((f) => ({ ...f, onlyPostable: checked === true }))}
          />
          Sólo cuentas que admiten apuntes
        </label>

        <div className="flex gap-2 pb-1">
          <Button type="button" variant="outline" size="sm" onClick={expandAll}>
            Desplegar
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={collapseAll}>
            Plegar
          </Button>
        </div>
      </div>

      {/* `div`, no `p`: el `Badge` de shadcn renderiza un `div` y anidarlo en un
          párrafo rompe la hidratación. */}
      <div className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
        <span>Variante</span>
        <Badge variant="secondary">{catalog.variant}</Badge>
        <span>
          · {accounts.length} cuentas en el plan · {activeCount} activas · {postableCount} admiten apuntes ·{" "}
          {shownCount} coinciden con el filtro
        </span>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {!tree.ok && (
        <p className="text-sm text-destructive">{tree.errors.map((issue) => issue.message).join(" · ")}</p>
      )}

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full min-w-4xl text-sm">
          <thead className="bg-muted/50 text-left">
            <tr className="h-8">
              <th className="px-2 font-medium">Cuenta</th>
              <th className="px-2 font-medium">Nivel</th>
              <th className="px-2 font-medium">Estado financiero</th>
              <th className="px-2 font-medium">Epígrafe ({catalog.variant})</th>
              <th className="px-2 font-medium">Tipo analítico</th>
              <th className="px-2 font-medium">Cashflow</th>
              <th className="w-10 px-2" />
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={7} className="p-6 text-center text-muted-foreground">
                  Ninguna cuenta coincide con la búsqueda.
                </td>
              </tr>
            )}
            {visible.map(({ node, depth }) => {
              const account = node.account
              const hasChildren = node.children.length > 0
              const open = searching || expanded.has(account.code)
              const warning = warningsByCode[account.code]
              const mapped = mappedKeysByCode[account.code] ?? []
              return (
                <tr
                  key={account.code}
                  data-account-code={account.code}
                  className={cn(
                    "h-8 border-t align-middle",
                    !account.isActive && "text-muted-foreground line-through decoration-1",
                    node.matched && searching && "bg-[#EAFF69]/25"
                  )}
                >
                  <td className="px-2">
                    <span className="flex items-center gap-1" style={{ paddingLeft: `${depth * 14}px` }}>
                      {hasChildren ? (
                        <button
                          type="button"
                          onClick={() => toggle(account.code)}
                          aria-label={open ? `Plegar ${account.code}` : `Desplegar ${account.code}`}
                          aria-expanded={open}
                          className="rounded p-0.5 hover:bg-muted"
                        >
                          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        </button>
                      ) : (
                        <span className="inline-block w-[18px]" />
                      )}
                      <span className="font-code tabular-nums">{account.code}</span>
                      {editing === account.code ? (
                        <Input
                          autoFocus
                          value={draftName}
                          onChange={(event) => setDraftName(event.target.value)}
                          onBlur={() => commitRename(account)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") commitRename(account)
                            if (event.key === "Escape") setEditing(null)
                          }}
                          className="h-6 w-96 py-0"
                          aria-label={`Nombre de la cuenta ${account.code}`}
                        />
                      ) : (
                        <span
                          data-account-name={account.code}
                          className={cn("truncate", canEdit && "cursor-text")}
                          onDoubleClick={() => {
                            if (!canEdit) return
                            setEditing(account.code)
                            setDraftName(account.name)
                          }}
                          title={canEdit ? "Doble clic para renombrar" : undefined}
                        >
                          {account.name}
                        </span>
                      )}
                      {account.isSystem && (
                        <span
                          className="inline-flex items-center gap-1 rounded bg-[#EAFF69] px-1 text-[10px] font-semibold text-[#1A202C]"
                          title={
                            mapped.length > 0
                              ? `Cuenta de sistema · ${mapped.join(", ")}`
                              : "Cuenta de sistema: la usa el motor contable"
                          }
                        >
                          <Lock className="h-3 w-3" /> sistema
                        </span>
                      )}
                      {account.isContra && (
                        <span className="text-xs text-muted-foreground" title="Contra-cuenta: resta en su masa (R-13)">
                          (−)
                        </span>
                      )}
                      {account.bidirectional && (
                        <span
                          className="text-xs text-muted-foreground"
                          title="Saldo indistinto: el balance la reclasifica por signo"
                        >
                          (↔)
                        </span>
                      )}
                      {!account.isActive && <span className="text-xs">· inactiva</span>}
                      {warning && (
                        <span className="text-xs text-[#B37400]" title={warning}>
                          ⚠
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-2 text-muted-foreground">{levelLabel(account.level)}</td>
                  <td className="px-2">
                    {account.statement ? (STATEMENT_LABELS[account.statement] ?? account.statement) : "—"}
                  </td>
                  <td className="px-2">{node.epigraph ?? "—"}</td>
                  <td className="px-2">
                    {account.analyticType ? (ANALYTIC_TYPE_LABELS[account.analyticType] ?? account.analyticType) : "—"}
                  </td>
                  <td className="px-2">
                    {account.cashflowCategory
                      ? (CASHFLOW_LABELS[account.cashflowCategory] ?? account.cashflowCategory)
                      : "—"}
                  </td>
                  <td className="px-2">
                    {canEdit && (
                      <AccountRowActions
                        account={account}
                        catalog={catalog}
                        suggestedChildCode={suggestChildCode(account.code, codes)}
                        canDelete={!account.isSystem && !hasChildren && mapped.length === 0}
                        deleteBlockedReason={
                          account.isSystem
                            ? "Es una cuenta de sistema: remapea la clave antes de borrarla (R-06/R-07)"
                            : hasChildren
                              ? "Tiene subcuentas: bórralas primero (R-08)"
                              : null
                        }
                      />
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {pending && <p className="text-sm text-muted-foreground">Guardando…</p>}
      {!canEdit && (
        <p className="text-sm text-muted-foreground">
          Sólo un administrador puede modificar el plan de cuentas. Estás viendo la configuración en modo lectura.
        </p>
      )}
    </div>
  )
}
