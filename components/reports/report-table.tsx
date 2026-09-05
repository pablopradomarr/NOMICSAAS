"use client"

import { AmountPlain } from "@/components/ledger/amount"
import type { Provenance } from "@/components/ledger/types"
import { shortHash } from "@/components/ledger/types"
import { Button } from "@/components/ui/button"
import { ConfidenceBadge, type ConfidenceLevel } from "@/components/ui/confidence-badge"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { ChevronDown, ChevronRight } from "lucide-react"
import Link from "next/link"
import { useMemo, useState } from "react"

/**
 * E3 · T12 — Tabla de informe jerárquica y colapsable (`ui-erp` §Tablas).
 *
 * Recibe el árbol **ya construido en el servidor** (grupo → subgrupo → cuenta)
 * con las cifras en céntimos y la `provenance` por celda. El cliente no suma
 * nada: pinta, colapsa y, al hacer clic en una cifra, abre su procedencia
 * (métrica, `run_id`, `ledgerHash`, módulo que la calculó y la consulta
 * parametrizada que la origina) con el enlace al mayor de esa cuenta.
 */

export type ReportColumn = {
  key: string
  header: string
  /** Por defecto `right`: las cifras van a la derecha. */
  align?: "left" | "right"
}

export type ReportNode = {
  id: string
  /** Código de cuenta o del agregado; se pinta en `.font-code`. */
  code: string
  label: string
  /** 0 = raíz del árbol dibujado; sube con cada nivel de anidamiento. */
  depth: number
  isAggregate: boolean
  values: Record<string, number>
  provenance?: Record<string, Provenance>
  children?: ReportNode[]
}

export type ReportFooterRow = {
  label: string
  values: Record<string, number>
  /** Fila de cuadre: `Σdeudor − Σacreedor = 0,00 €` con ✓/⚠. */
  check?: { differenceCents: number; balanced: boolean; label: string }
}

export function ReportTable({
  columns,
  nodes,
  footer,
  mayorHref,
  emptyMessage = "No hay movimientos en el periodo.",
  defaultExpandedDepth = 1,
}: {
  columns: readonly ReportColumn[]
  nodes: readonly ReportNode[]
  footer?: ReportFooterRow
  /** Base del enlace de drill-down: `/ledger/mayor?from=…&to=…`. */
  mayorHref?: string
  emptyMessage?: string
  defaultExpandedDepth?: number
}) {
  const initial = useMemo(() => {
    const open = new Set<string>()
    const walk = (list: readonly ReportNode[]) => {
      for (const node of list) {
        if (node.depth < defaultExpandedDepth && node.children?.length) open.add(node.id)
        if (node.children) walk(node.children)
      }
    }
    walk(nodes)
    return open
  }, [nodes, defaultExpandedDepth])

  const [expanded, setExpanded] = useState<Set<string>>(initial)
  const [detail, setDetail] = useState<{ node: ReportNode; columnKey: string } | null>(null)

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const flat: ReportNode[] = []
  const push = (list: readonly ReportNode[]) => {
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
        <table className="w-full text-sm" data-testid="report-table">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Cuenta</th>
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={cn("px-3 py-2 font-medium", column.align === "left" ? "text-left" : "text-right")}
                >
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
                  data-account-code={node.code}
                  data-aggregate={node.isAggregate ? "1" : "0"}
                  className={cn("h-8", node.isAggregate && "bg-muted/20 font-medium")}
                >
                  <td className="px-3 py-1">
                    <div className="flex items-center gap-1" style={{ paddingLeft: `${node.depth * 14}px` }}>
                      {hasChildren ? (
                        <button
                          type="button"
                          onClick={() => toggle(node.id)}
                          aria-expanded={isOpen}
                          aria-label={`${isOpen ? "Contraer" : "Desplegar"} ${node.code}`}
                          className="rounded p-0.5 hover:bg-muted"
                        >
                          {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        </button>
                      ) : (
                        <span className="inline-block w-[18px]" />
                      )}
                      <span className="font-code text-xs">{node.code}</span>
                      <span className="truncate text-muted-foreground">{node.label}</span>
                    </div>
                  </td>
                  {columns.map((column) => {
                    const value = node.values[column.key] ?? 0
                    const prov = node.provenance?.[column.key]
                    return (
                      <td
                        key={column.key}
                        className={cn("px-3 py-1", column.align === "left" ? "text-left" : "text-right")}
                      >
                        {prov ? (
                          <button
                            type="button"
                            onClick={() => setDetail({ node, columnKey: column.key })}
                            className="rounded px-1 underline-offset-2 hover:underline"
                            aria-label={`Procedencia de ${column.header} de la cuenta ${node.code}`}
                          >
                            <AmountPlain cents={value} />
                          </button>
                        ) : (
                          <AmountPlain cents={value} />
                        )}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
          {footer && (
            <tfoot className="border-t-2 bg-muted/30 font-medium">
              <tr className="h-9" data-testid="report-footer">
                <td className="px-3 py-1">{footer.label}</td>
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn("px-3 py-1", column.align === "left" ? "text-left" : "text-right")}
                  >
                    <AmountPlain cents={footer.values[column.key] ?? 0} zeroAsDash={false} />
                  </td>
                ))}
              </tr>
              {footer.check && (
                <tr className="h-9 border-t" data-testid="report-balance-check">
                  <td className="px-3 py-1" colSpan={columns.length}>
                    <span className="text-muted-foreground">{footer.check.label} = </span>
                    <span className="font-code" data-balance-difference={footer.check.differenceCents}>
                      {new Intl.NumberFormat("es-ES", {
                        style: "currency",
                        currency: "EUR",
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                        useGrouping: "always",
                      })
                        .format(footer.check.differenceCents / 100)
                        .replace("-", "−")}
                    </span>
                  </td>
                  <td className="px-3 py-1 text-right">
                    {footer.check.balanced ? (
                      <span className="text-[#0A0A0A]">✓</span>
                    ) : (
                      <span className="text-[#F5A623]">⚠</span>
                    )}
                  </td>
                </tr>
              )}
            </tfoot>
          )}
        </table>
      </div>

      {detail && (
        <ProvenanceDialog
          node={detail.node}
          provenance={detail.node.provenance?.[detail.columnKey]}
          columnLabel={columns.find((c) => c.key === detail.columnKey)?.header ?? detail.columnKey}
          mayorHref={mayorHref}
          onClose={() => setDetail(null)}
        />
      )}
    </>
  )
}

function ProvenanceDialog({
  node,
  provenance,
  columnLabel,
  mayorHref,
  onClose,
}: {
  node: ReportNode
  provenance?: Provenance
  columnLabel: string
  mayorHref?: string
  onClose: () => void
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            <span className="font-code">{node.code}</span> · {columnLabel}
          </DialogTitle>
          <DialogDescription>
            De dónde sale esta cifra (`lib/ledger/provenance.ts`). No se ha calculado en el navegador.
          </DialogDescription>
        </DialogHeader>

        {provenance ? (
          <dl className="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Valor</dt>
            <dd>
              <AmountPlain cents={provenance.valor} zeroAsDash={false} /> {provenance.moneda}
            </dd>
            <dt className="text-muted-foreground">Métrica</dt>
            <dd className="font-code text-xs break-all">{provenance.metrica}</dd>
            <dt className="text-muted-foreground">Confianza</dt>
            <dd>
              <ConfidenceBadge level={provenance.confianza as ConfidenceLevel} />
            </dd>
            <dt className="text-muted-foreground">run_id</dt>
            <dd className="font-code text-xs break-all">{provenance.run_id}</dd>
            <dt className="text-muted-foreground">ledgerHash</dt>
            <dd className="font-code text-xs break-all" title={provenance.ledgerHash}>
              {shortHash(provenance.ledgerHash, 24)}
            </dd>
            <dt className="text-muted-foreground">Calculado por</dt>
            <dd className="font-code text-xs break-all">{provenance.calculado_por}</dd>
            <dt className="text-muted-foreground">Registros origen</dt>
            <dd className="font-code rounded bg-muted/50 p-2 text-[11px] break-all">
              {provenance.registros_origen}
              <div className="mt-1 text-muted-foreground">
                parámetros: {provenance.parametros.map((p) => String(p)).join(" · ")}
              </div>
            </dd>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">Esta celda es un agregado de presentación y no lleva provenance propia.</p>
        )}

        <DialogFooter>
          {mayorHref && !node.isAggregate && (
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
