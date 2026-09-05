"use client"

import { AmountPlain } from "@/components/ledger/amount"
import { shortHash } from "@/components/ledger/types"
import { Button } from "@/components/ui/button"
import { ConfidenceBadge } from "@/components/ui/confidence-badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { ChevronDown, ChevronRight } from "lucide-react"
import Link from "next/link"
import { useMemo, useState } from "react"

/**
 * E6 · T16 — Tabla de estado financiero: **epígrafe → cuenta**, colapsable,
 * con comparativo y drill-down por celda (`ui-erp` §Tablas, diseño §6).
 *
 * Se distingue de `ReportTable` (que agrupa por código de cuenta) en que aquí
 * la jerarquía es la del MODELO OFICIAL: la ruta de epígrafes que trae cada
 * `StatementRow`, en el orden que fija `segmentOrder` —nunca lexicográfico—.
 *
 * El cliente no suma nada. Todas las cifras llegan en céntimos, ya presentadas
 * con su signo (R-B2) y ya comparadas en el servidor contra el run del periodo
 * anterior. `null` en una celda significa **«sin comparativo»** y se pinta como
 * tal: jamás como 0 (§8.7).
 */

export type StatementColumn = {
  key: string
  header: string
  /**
   * `cents` (por defecto) pinta un importe; `bps` pinta un porcentaje con un
   * decimal a partir de puntos básicos ENTEROS calculados en el servidor.
   */
  kind?: "cents" | "bps"
  /** Leyenda para las celdas `null` de esta columna. */
  emptyLabel?: string
}

export type StatementNode = {
  id: string
  /** Ruta completa del epígrafe; el drill-down la usa como métrica. */
  path: string
  label: string
  depth: number
  isAccount: boolean
  code?: string
  isContraCell?: boolean
  isComputed?: boolean
  /** Subtotal oficial (A.1–A.4): se destaca y no se puede desplegar. */
  isSubtotal?: boolean
  accountCodes: string[]
  values: Record<string, number | null>
  children?: StatementNode[]
}

export type StatementFooterCheck = {
  label: string
  differenceCents: number
  balanced: boolean
}

export function StatementTable({
  caption,
  columns,
  nodes,
  totalLabel,
  totalValues,
  check,
  mayorHref,
  runInfo,
  defaultExpandedDepth = 1,
  testId = "statement-table",
  emptyMessage = "No hay saldos en el periodo.",
}: {
  caption?: string
  columns: readonly StatementColumn[]
  nodes: readonly StatementNode[]
  totalLabel?: string
  totalValues?: Record<string, number | null>
  check?: StatementFooterCheck
  /** Base del enlace de drill-down al mayor: `/ledger/mayor?from=…&to=…`. */
  mayorHref?: string
  runInfo?: { runId: string; ledgerHash: string; gitSha: string; module: string }
  defaultExpandedDepth?: number
  testId?: string
  emptyMessage?: string
}) {
  const initial = useMemo(() => {
    const open = new Set<string>()
    const walk = (list: readonly StatementNode[]) => {
      for (const node of list) {
        if (node.depth < defaultExpandedDepth && node.children?.length) open.add(node.id)
        if (node.children) walk(node.children)
      }
    }
    walk(nodes)
    return open
  }, [nodes, defaultExpandedDepth])

  const [expanded, setExpanded] = useState<Set<string>>(initial)
  const [detail, setDetail] = useState<{ node: StatementNode; columnKey: string } | null>(null)

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const flat: StatementNode[] = []
  const push = (list: readonly StatementNode[]) => {
    for (const node of list) {
      flat.push(node)
      if (node.children?.length && expanded.has(node.id)) push(node.children)
    }
  }
  push(nodes)

  if (nodes.length === 0) {
    return <p className="rounded-md border p-6 text-sm text-muted-foreground">{emptyMessage}</p>
  }

  return (
    <>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid={testId}>
          {caption && (
            <caption className="bg-muted/40 px-3 py-2 text-left text-xs font-semibold tracking-wide uppercase">
              {caption}
            </caption>
          )}
          <thead className="bg-muted/40 text-xs tracking-wide text-muted-foreground uppercase">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Epígrafe</th>
              {columns.map((column) => (
                <th key={column.key} className="px-3 py-2 text-right font-medium">
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {flat.map((node) => {
              const hasChildren = Boolean(node.children?.length)
              const isOpen = expanded.has(node.id)
              return (
                <tr
                  key={node.id}
                  data-epigraph={node.path}
                  data-account-code={node.code ?? ""}
                  data-subtotal={node.isSubtotal ? "1" : "0"}
                  className={cn(
                    "h-8",
                    !node.isAccount && node.depth === 0 && "bg-muted/20 font-medium",
                    node.isSubtotal && "border-y bg-[#EDF2F7] font-semibold"
                  )}
                >
                  <td className="px-3 py-1">
                    <div className="flex items-center gap-1" style={{ paddingLeft: `${node.depth * 14}px` }}>
                      {hasChildren ? (
                        <button
                          type="button"
                          onClick={() => toggle(node.id)}
                          aria-expanded={isOpen}
                          aria-label={`${isOpen ? "Contraer" : "Desplegar"} ${node.label}`}
                          className="rounded p-0.5 hover:bg-muted"
                        >
                          {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        </button>
                      ) : (
                        <span className="inline-block w-[18px]" />
                      )}
                      {node.code && <span className="font-code text-xs">{node.code}</span>}
                      <span className={cn("truncate", node.isAccount && "text-muted-foreground")}>{node.label}</span>
                      {node.isContraCell && (
                        <span className="text-xs text-muted-foreground" title="Cuenta correctora: minora su epígrafe">
                          (−)
                        </span>
                      )}
                      {node.isComputed && (
                        <span
                          className="text-[10px] text-muted-foreground"
                          title="Cifra inyectada por el motor (R-B5), no leída de una cuenta"
                        >
                          calculado
                        </span>
                      )}
                    </div>
                  </td>
                  {columns.map((column) => {
                    const value = node.values[column.key]
                    return (
                      <td key={column.key} className="px-3 py-1 text-right">
                        {value === null || value === undefined ? (
                          <span className="text-xs text-muted-foreground">{column.emptyLabel ?? "sin comparativo"}</span>
                        ) : column.kind === "bps" ? (
                          <span className="tabular-nums text-muted-foreground">{formatBps(value)}</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setDetail({ node, columnKey: column.key })}
                            className="rounded px-1 underline-offset-2 hover:underline"
                            aria-label={`Detalle de ${column.header} en ${node.label}`}
                          >
                            <AmountPlain cents={value} />
                          </button>
                        )}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
          {(totalValues || check) && (
            <tfoot className="border-t-2 bg-muted/30 font-medium">
              {totalValues && (
                <tr className="h-9" data-testid={`${testId}-total`}>
                  <td className="px-3 py-1">{totalLabel ?? "Total"}</td>
                  {columns.map((column) => {
                    const value = totalValues[column.key]
                    return (
                      <td key={column.key} className="px-3 py-1 text-right">
                        {value === null || value === undefined ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : column.kind === "bps" ? (
                          <span className="tabular-nums">{formatBps(value)}</span>
                        ) : (
                          <AmountPlain cents={value} zeroAsDash={false} />
                        )}
                      </td>
                    )
                  })}
                </tr>
              )}
              {check && (
                <tr className="h-9 border-t" data-testid="report-balance-check">
                  <td className="px-3 py-1" colSpan={columns.length}>
                    <span className="text-muted-foreground">{check.label} = </span>
                    <span className="font-code" data-balance-difference={check.differenceCents}>
                      {formatEuro(check.differenceCents)}
                    </span>
                  </td>
                  <td className="px-3 py-1 text-right">
                    {check.balanced ? (
                      <span className="text-[#0A0A0A]" aria-label="cuadra">
                        ✓
                      </span>
                    ) : (
                      <span className="text-[#F5A623]" aria-label="no cuadra">
                        ⚠
                      </span>
                    )}
                  </td>
                </tr>
              )}
            </tfoot>
          )}
        </table>
      </div>

      {detail && (
        <CellDialog
          node={detail.node}
          columnLabel={columns.find((c) => c.key === detail.columnKey)?.header ?? detail.columnKey}
          value={detail.node.values[detail.columnKey] ?? 0}
          mayorHref={mayorHref}
          runInfo={runInfo}
          onClose={() => setDetail(null)}
        />
      )}
    </>
  )
}

/** Puntos básicos ENTEROS (calculados en el servidor) → `12,3 %`. */
function formatBps(bps: number): string {
  return `${new Intl.NumberFormat("es-ES", { minimumFractionDigits: 1, maximumFractionDigits: 1 })
    .format(bps / 100)
    .replace("-", "−")} %`
}

function formatEuro(cents: number): string {
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: "always",
  })
    .format(cents / 100)
    .replace("-", "−")
}

/**
 * Drill-down por celda: de qué cuentas del plan sale la cifra y con qué run se
 * emitió. El enlace lleva al mayor de la cuenta, que es donde están los
 * asientos que la componen — no se recalcula nada en el navegador.
 */
function CellDialog({
  node,
  columnLabel,
  value,
  mayorHref,
  runInfo,
  onClose,
}: {
  node: StatementNode
  columnLabel: string
  value: number
  mayorHref?: string
  runInfo?: { runId: string; ledgerHash: string; gitSha: string; module: string }
  onClose: () => void
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl" data-testid="cell-detail">
        <DialogHeader>
          <DialogTitle className="text-base">
            {node.code ? <span className="font-code">{node.code} · </span> : null}
            {node.label}
          </DialogTitle>
          <DialogDescription>
            {columnLabel} · de dónde sale esta cifra. Calculada en el servidor y congelada en el informe.
          </DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Importe</dt>
          <dd>
            <AmountPlain cents={value} zeroAsDash={false} /> €
          </dd>
          <dt className="text-muted-foreground">Epígrafe</dt>
          <dd className="break-words">{node.path}</dd>
          <dt className="text-muted-foreground">Confianza</dt>
          <dd>
            <ConfidenceBadge level="calculado" />
          </dd>
          <dt className="text-muted-foreground">Cuentas</dt>
          <dd className="font-code flex flex-wrap gap-1 text-xs" data-testid="cell-accounts">
            {node.accountCodes.length === 0 ? (
              <span className="text-muted-foreground">—</span>
            ) : (
              node.accountCodes.map((code) =>
                mayorHref ? (
                  <Link
                    key={code}
                    href={`${mayorHref}${mayorHref.includes("?") ? "&" : "?"}account=${code}`}
                    className="rounded bg-muted px-1.5 py-0.5 underline-offset-2 hover:underline"
                  >
                    {code}
                  </Link>
                ) : (
                  <span key={code} className="rounded bg-muted px-1.5 py-0.5">
                    {code}
                  </span>
                )
              )
            )}
          </dd>
          {runInfo && (
            <>
              <dt className="text-muted-foreground">run_id</dt>
              <dd className="font-code text-xs break-all">{runInfo.runId}</dd>
              <dt className="text-muted-foreground">ledgerHash</dt>
              <dd className="font-code text-xs break-all" title={runInfo.ledgerHash}>
                {shortHash(runInfo.ledgerHash, 24)}
              </dd>
              <dt className="text-muted-foreground">Calculado por</dt>
              <dd className="font-code text-xs break-all">
                {runInfo.module}@{shortHash(runInfo.gitSha, 8)}
              </dd>
            </>
          )}
        </dl>

        <DialogFooter>
          {mayorHref && node.code && (
            <Button asChild variant="outline">
              <Link href={`${mayorHref}${mayorHref.includes("?") ? "&" : "?"}account=${node.code}`}>
                Ver movimientos en el mayor
              </Link>
            </Button>
          )}
          <Button type="button" onClick={onClose}>
            Cerrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
