"use client"

import { allocationCellDetailAction, analyticCellDetailAction } from "@/app/(app)/analytics/actions"
import type { AllocationCellDetail } from "@/models/margins"
import { formatBps, type CellDetail, type CellLine, type MatrixView } from "@/components/analytics/types"
import { AmountPlain } from "@/components/ledger/amount"
import { shortHash } from "@/components/ledger/types"
import { Button } from "@/components/ui/button"
import { ConfidenceBadge, type ConfidenceLevel } from "@/components/ui/confidence-badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { useEffect, useState } from "react"

/**
 * E4 · T14 — Matriz de la PyG analítica (`E4-analitica.md` §6).
 *
 * Recibe la matriz **ya orientada y ya calculada en el servidor**: niveles ×
 * columnas (o transpuesta), con las filas de porcentaje en puntos básicos
 * enteros que devuelve `marginBps`. El navegador no suma, no divide y no
 * acumula: pinta, y al pulsar una celda abre su procedencia con las líneas del
 * diario que la aportan.
 *
 * Reglas de presentación de `ui-erp`: importes a la derecha con `tabular-nums`,
 * ceros `—`, negativos con `−` en texto secundario, filas de 32 px, sin
 * rojo/verde semáforo. Las columnas de línea de negocio son **agregados de
 * presentación** y se marcan como tales: no entran en el total (I4).
 */
export type MatrixPeriod = { from: string; to: string; fiscalYearId?: string }

export function MarginMatrix({
  view,
  currency,
  period,
  withAllocations = false,
}: {
  view: MatrixView
  currency: string
  /** Periodo del informe: lo que el diálogo envía para pedir las líneas de una celda. */
  period: MatrixPeriod
  /**
   * E5 · T13 — con imputaciones, el drill-down de una celda pide TAMBIÉN las
   * líneas de reparto: una celda MC3 imputada no se reproduce con una sola
   * consulta al diario, y enseñar sólo esa mentiría por omisión.
   */
  withAllocations?: boolean
}) {
  const [detail, setDetail] = useState<CellDetail | null>(null)

  return (
    <>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid="margin-matrix">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="sticky left-0 z-10 bg-muted/40 px-3 py-2 text-left font-medium">{view.cornerLabel}</th>
              {view.headers.map((header) => (
                <th
                  key={header.key}
                  data-column-key={header.key}
                  data-column-kind={header.kind}
                  className={cn(
                    "px-3 py-2 text-right font-medium whitespace-nowrap",
                    header.aggregate && "bg-[#EDF2F7]/70",
                    header.kind === "total" && "border-l-2 bg-muted/60"
                  )}
                  title={header.aggregate ? "Agregado de presentación: no suma al total" : undefined}
                >
                  <span className="block">{header.label}</span>
                  {header.sub && (
                    <span className="block font-code text-[10px] normal-case tracking-normal text-muted-foreground">
                      {header.sub}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {view.rows.map((row) => (
              <tr
                key={row.id}
                data-row-id={row.id}
                data-row-kind={row.kind}
                className={cn("h-8", row.kind === "margin" && "bg-muted/10", row.kind === "pending" && "border-t-2 bg-[#F5A623]/5")}
              >
                <th
                  scope="row"
                  className="sticky left-0 z-10 bg-background px-3 py-1 text-left font-medium whitespace-nowrap"
                >
                  <span className={cn(row.kind === "margin" && "text-xs font-normal text-muted-foreground")}>
                    {row.label}
                  </span>
                  {row.kind === "margin" && (
                    <ConfidenceBadge level="calculado" className="ml-2 align-middle" title="Porcentaje derivado de dos cifras del motor; no se persiste (I-E4-6)." />
                  )}
                  {row.note && <span className="ml-2 text-[11px] text-muted-foreground">{row.note}</span>}
                </th>
                {row.cells.map((cell, index) => {
                  const header = view.headers[index]
                  const detailForCell = cell.detailKey ? view.details[cell.detailKey] : undefined
                  const content =
                    row.kind === "margin" ? (
                      <span className={cn("tabular-nums", cell.bps === null && "text-muted-foreground")}>
                        {formatBps(cell.bps ?? null)}
                      </span>
                    ) : (
                      <AmountPlain cents={cell.cents ?? 0} />
                    )
                  return (
                    <td
                      key={header.key}
                      data-cell={`${row.id}|${header.key}`}
                      className={cn(
                        "px-3 py-1 text-right",
                        header.aggregate && "bg-[#EDF2F7]/40",
                        header.kind === "total" && "border-l-2 bg-muted/30 font-medium",
                        cell.muted && "text-muted-foreground"
                      )}
                      title={cell.muted ? "Lectura de compañía, no margen de proyecto" : undefined}
                    >
                      {detailForCell ? (
                        <button
                          type="button"
                          onClick={() => setDetail(detailForCell)}
                          className="rounded px-1 underline-offset-2 hover:underline"
                          aria-label={`Procedencia de ${row.label} en ${header.label}`}
                        >
                          {content}
                        </button>
                      ) : (
                        content
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 bg-muted/30 font-medium">
            <tr className="h-9" data-testid="matrix-balance-check">
              <td className="px-3 py-1" colSpan={view.headers.length}>
                <span className="text-muted-foreground">{view.check.label} = </span>
                <span className="font-code" data-balance-difference={view.check.differenceCents}>
                  {new Intl.NumberFormat("es-ES", {
                    style: "currency",
                    currency,
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                    useGrouping: "always",
                  })
                    .format(view.check.differenceCents / 100)
                    .replace("-", "−")}
                </span>
              </td>
              <td className="px-3 py-1 text-right">
                {view.check.balanced ? (
                  <span className="text-[#0A0A0A]">✓</span>
                ) : (
                  <span className="text-[#F5A623]">⚠</span>
                )}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {detail && (
        <CellDialog
          detail={detail}
          currency={currency}
          period={period}
          withAllocations={withAllocations}
          onClose={() => setDetail(null)}
        />
      )}
    </>
  )
}

function CellDialog({
  detail,
  currency,
  period,
  withAllocations,
  onClose,
}: {
  detail: CellDetail
  currency: string
  period: MatrixPeriod
  withAllocations: boolean
  onClose: () => void
}) {
  const prov = detail.provenance
  const [allocation, setAllocation] = useState<AllocationCellDetail | null>(null)

  useEffect(() => {
    if (!withAllocations) return
    let cancelled = false
    void allocationCellDetailAction({
      level: detail.level,
      column: detail.columnKey,
      from: period.from,
      to: period.to,
    }).then((result) => {
      if (cancelled) return
      if (result.success && result.data) setAllocation(result.data)
    })
    return () => {
      cancelled = true
    }
  }, [withAllocations, detail.level, detail.columnKey, period.from, period.to])
  /**
   * Hallazgo #5: las líneas del diario NO viajan con la matriz. Al abrir la
   * celda se piden al servidor, que ejecuta **la consulta de la provenance de
   * esta misma celda** — la que se muestra justo encima en «Registros origen»—,
   * de modo que lo que se lista es exactamente lo que suma la cifra.
   */
  const [lines, setLines] = useState<CellLine[] | null>(detail.lines.length > 0 ? detail.lines : null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (detail.lines.length > 0) return
    let cancelled = false
    void analyticCellDetailAction({
      level: detail.level,
      column: detail.columnKey,
      from: period.from,
      to: period.to,
      ...(period.fiscalYearId ? { fiscalYearId: period.fiscalYearId } : {}),
    }).then((result) => {
      if (cancelled) return
      if (!result.success || !result.data) {
        setError(result.error ?? "No se han podido leer las líneas de esta celda")
        setLines([])
        return
      }
      setLines(
        result.data.lines.map((l) => ({
          entryRef: l.entryRef,
          lineNo: l.lineNo,
          accountCode: l.accountCode,
          accountName: l.accountName,
          analyticType: l.analyticType,
          projectCode: l.projectCode,
          costCenterCode: l.costCenterCode,
          amountCents: l.amountCents,
        }))
      )
    })
    return () => {
      cancelled = true
    }
  }, [detail.level, detail.columnKey, detail.lines, period.from, period.to, period.fiscalYearId])
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{detail.title}</DialogTitle>
          <DialogDescription>
            De dónde sale esta cifra (`lib/analytics/margins.ts`). No se ha calculado en el navegador.
          </DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Acumulado del nivel</dt>
          <dd>
            <AmountPlain cents={detail.cumulativeCents} zeroAsDash={false} /> {currency}
          </dd>
          <dt className="text-muted-foreground">Aporte de este nivel</dt>
          <dd>
            <AmountPlain cents={detail.contributionCents} zeroAsDash={false} /> {currency}
          </dd>
          {prov && (
            <>
              <dt className="text-muted-foreground">Métrica</dt>
              <dd className="font-code text-xs break-all">{prov.metrica}</dd>
              <dt className="text-muted-foreground">Confianza</dt>
              <dd>
                <ConfidenceBadge level={prov.confianza as ConfidenceLevel} />
              </dd>
              <dt className="text-muted-foreground">run_id</dt>
              <dd className="font-code text-xs break-all">{prov.run_id}</dd>
              <dt className="text-muted-foreground">ledgerHash</dt>
              <dd className="font-code text-xs break-all" title={prov.ledgerHash}>
                {shortHash(prov.ledgerHash, 24)}
              </dd>
              <dt className="text-muted-foreground">Calculado por</dt>
              <dd className="font-code text-xs break-all">{prov.calculado_por}</dd>
              <dt className="text-muted-foreground">Registros origen</dt>
              <dd className="font-code rounded bg-muted/50 p-2 text-[11px] break-all">
                {prov.registros_origen}
                <div className="mt-1 text-muted-foreground">
                  parámetros: {prov.parametros.map((p) => String(p)).join(" · ")}
                </div>
              </dd>
            </>
          )}
        </dl>

        <div className="max-h-[40vh] overflow-y-auto rounded-md border">
          <table className="w-full text-sm" data-testid="cell-lines">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Asiento</th>
                <th className="px-3 py-2 text-left font-medium">Cuenta</th>
                <th className="px-3 py-2 text-left font-medium">Tipo analítico</th>
                <th className="px-3 py-2 text-left font-medium">Destino</th>
                <th className="px-3 py-2 text-right font-medium">Aporte</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {lines === null && (
                <tr>
                  <td className="px-3 py-3 text-muted-foreground" colSpan={5}>
                    Leyendo las líneas de esta celda…
                  </td>
                </tr>
              )}
              {lines !== null && lines.length === 0 && (
                <tr>
                  <td className="px-3 py-3 text-muted-foreground" colSpan={5}>
                    {error ?? "Ninguna línea del diario aporta a este nivel en esta columna."}
                  </td>
                </tr>
              )}
              {(lines ?? []).map((line) => (
                <tr key={`${line.entryRef}-${line.lineNo}`} className="h-8">
                  <td className="px-3 py-1 font-code text-xs">
                    {line.entryRef}/{line.lineNo}
                  </td>
                  <td className="px-3 py-1">
                    <span className="font-code text-xs">{line.accountCode}</span>{" "}
                    <span className="text-muted-foreground">{line.accountName}</span>
                  </td>
                  <td className="px-3 py-1 text-xs text-muted-foreground">{line.analyticType}</td>
                  <td className="px-3 py-1 font-code text-xs">{line.projectCode ?? line.costCenterCode ?? "—"}</td>
                  <td className="px-3 py-1 text-right">
                    <AmountPlain cents={line.amountCents} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {withAllocations && allocation && allocation.lines.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              <strong>Imputaciones que aportan a esta celda.</strong> Una celda imputada no se reproduce con una sola
              consulta al diario: ésta es la segunda mitad de su procedencia, las líneas de reparto de las
              liquidaciones vigentes del periodo.{" "}
              <span className="font-code break-all">{allocation.query}</span>
            </p>
            <div className="max-h-[30vh] overflow-y-auto rounded-md border">
              <table className="w-full text-sm" data-testid="cell-allocation-lines">
                <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Regla</th>
                    <th className="px-3 py-2 text-left font-medium">Centro de coste fuente</th>
                    <th className="px-3 py-2 text-left font-medium">Nivel</th>
                    <th className="px-3 py-2 text-right font-medium">Cuota</th>
                    <th className="px-3 py-2 text-right font-medium">Aporte</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {allocation.lines.map((line, index) => (
                    <tr key={`${line.runId}-${line.ruleCode}-${index}`} className="h-8">
                      <td className="px-3 py-1 font-code text-xs">{line.ruleCode}</td>
                      <td className="px-3 py-1 font-code text-xs">{line.sourceCostCenterCode}</td>
                      <td className="px-3 py-1 font-code text-xs">{line.marginLevel}</td>
                      <td className="px-3 py-1 text-right font-code text-xs tabular-nums">
                        {(line.driverShareBps / 100).toFixed(2).replace(".", ",")} %
                      </td>
                      <td className="px-3 py-1 text-right">
                        <AmountPlain cents={line.amountCents} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button type="button" onClick={onClose}>
            Cerrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
