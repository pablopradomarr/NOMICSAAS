"use client"

import type { AssetView } from "@/components/assets/types"
import { DisposeAssetDialog } from "@/components/assets/dispose-asset-dialog"
import { ReviseAssetDialog } from "@/components/assets/revise-asset-dialog"
import { Amount } from "@/components/ledger/amount"
import { Button } from "@/components/ui/button"
import { shortHash } from "@/components/ledger/types"
import Link from "next/link"
import { useState } from "react"

/**
 * E9 · T17 — Inmovilizado: activos, cuadro y drill-down (§7, ADR-0016 D2/D11).
 *
 * La ficha enseña el cuadro **mes a mes** y cada cuota ya contabilizada lleva
 * su enlace al asiento del periodo: es el camino «cuota → asiento → documento»
 * en tres clics que hace posible la prueba de detalle sobre el inmovilizado, y
 * que sólo existe porque la línea de `68x`/`28x` dice a qué activo pertenece
 * (`fixedAssetId`, O-19).
 *
 * El `scheduleHash` está a la vista: es lo que permite decir que el cuadro de
 * hoy es el que se selló al dar de alta el activo, y no uno reescrito después
 * (I-E9-3).
 */
export function AssetsPanel({
  assets,
  cutoff,
  canEdit,
  isAdmin,
}: {
  assets: AssetView[]
  cutoff: string
  canEdit: boolean
  isAdmin: boolean
}) {
  const [openId, setOpenId] = useState<string | null>(null)

  if (assets.length === 0) {
    return (
      <p className="rounded-md border p-6 text-sm text-muted-foreground" data-testid="assets-empty">
        Todavía no hay ningún activo dado de alta.{" "}
        {canEdit ? "Da de alta el primero arriba." : "Pídeselo a quien pueda editar."}
      </p>
    )
  }

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid="assets-table">
          <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Activo</th>
              <th className="px-3 py-2 text-left font-medium">Cuentas</th>
              <th className="px-3 py-2 text-left font-medium">En servicio</th>
              <th className="px-3 py-2 text-right font-medium">Coste</th>
              <th className="px-3 py-2 text-right font-medium">Acumulada</th>
              <th className="px-3 py-2 text-right font-medium">Valor neto contable</th>
              <th className="px-3 py-2 text-left font-medium">Estado</th>
              <th className="px-3 py-2 text-right font-medium">Ficha</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {assets.map((detail) => (
                <tr key={detail.asset.id} className="h-8" data-asset-code={detail.asset.code}>
                  <td className="px-3 py-1">
                    <span className="font-code text-xs">{detail.asset.code}</span> {detail.asset.name}
                    {detail.asset.isCapitalGood && (
                      <span className="ml-2 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                        bien de inversión
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1 font-code text-xs text-muted-foreground">
                    {detail.asset.assetAccountCode} / {detail.asset.accumulatedAccountCode} /{" "}
                    {detail.asset.expenseAccountCode}
                  </td>
                  <td className="px-3 py-1 font-code text-xs text-muted-foreground">{detail.asset.inServiceDate}</td>
                  <td className="px-3 py-1 text-right">
                    <Amount cents={detail.asset.acquisitionCostCents} />
                  </td>
                  <td className="px-3 py-1 text-right">
                    <Amount cents={detail.accumulatedCents} />
                  </td>
                  <td className="px-3 py-1 text-right">
                    <Amount cents={detail.netBookValueCents} />
                  </td>
                  <td className="px-3 py-1 text-xs">{detail.asset.status}</td>
                  <td className="px-3 py-1 text-right">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid={`open-asset-${detail.asset.code}`}
                      onClick={() => setOpenId(openId === detail.asset.id ? null : detail.asset.id)}
                    >
                      {openId === detail.asset.id ? "Ocultar" : "Ver cuadro"}
                    </Button>
                  </td>
                </tr>
            ))}
          </tbody>
        </table>
      </div>

      {assets
        .filter((detail) => detail.asset.id === openId)
        .map((detail) => (
          <AssetSchedule key={detail.asset.id} detail={detail} cutoff={cutoff} canEdit={canEdit} isAdmin={isAdmin} />
        ))}
    </div>
  )
}

function AssetSchedule({
  detail,
  cutoff,
  canEdit,
  isAdmin,
}: {
  detail: AssetView
  cutoff: string
  canEdit: boolean
  isAdmin: boolean
}) {
  const posted = new Set(detail.postedPeriods)

  return (
    <div className="space-y-3 rounded-md border p-4" data-testid={`asset-detail-${detail.asset.code}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">
            Cuadro de amortización de <span className="font-code">{detail.asset.code}</span> · {detail.asset.name}
          </h3>
          <p className="font-code text-xs text-muted-foreground" data-testid="asset-schedule-hash">
            scheduleHash {shortHash(detail.scheduleHash, 16)} · método {detail.asset.method} · vida útil{" "}
            {detail.asset.usefulLifeMonths} meses · corte {cutoff}
          </p>
        </div>
        <div className="flex gap-2">
          {canEdit && detail.asset.status === "EN_USO" && <ReviseAssetDialog detail={detail} />}
          {isAdmin && detail.asset.status !== "BAJA" && detail.asset.status !== "VENDIDO" && (
            <DisposeAssetDialog detail={detail} />
          )}
        </div>
      </div>

      {detail.mismatch && (
        <p
          className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 p-3 text-xs"
          data-testid="asset-schedule-mismatch"
        >
          ⚠ El cuadro sellado no explica los asientos: las cuotas contabilizadas suman{" "}
          <Amount cents={detail.explainedCents} /> y la amortización acumulada atribuida al activo en el
          diario es <Amount cents={detail.accumulatedCents} /> (I-E9-3/I-E9-5). Revise las
          revisiones y las dotaciones del periodo.
        </p>
      )}

      {detail.revisions.length > 0 && (
        <div className="rounded-md border p-3 text-xs" data-testid="asset-revisions">
          <p className="mb-1 font-medium">Revisiones prospectivas (NRV 22ª)</p>
          <ul className="space-y-1 text-muted-foreground">
            {detail.revisions.map((revision) => (
              <li key={`${revision.effectiveFrom}-${revision.reason ?? ""}`}>
                Desde <span className="font-code">{revision.effectiveFrom}</span>
                {revision.newUsefulLifeMonths != null && ` · vida útil total ${revision.newUsefulLifeMonths} meses`}
                {revision.newResidualValueCents != null && (
                  <>
                    {" · residual "}
                    <Amount cents={revision.newResidualValueCents} />
                  </>
                )}
                {revision.addedCostCents != null && (
                  <>
                    {" · mejora "}
                    <Amount cents={revision.addedCostCents} />
                  </>
                )}
                {revision.reason ? ` — ${revision.reason}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="max-h-96 overflow-auto rounded-md border">
        <table className="w-full text-sm" data-testid="asset-schedule">
          <thead className="sticky top-0 bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Periodo</th>
              <th className="px-3 py-2 text-right font-medium">Cuota</th>
              <th className="px-3 py-2 text-right font-medium">Acumulada</th>
              <th className="px-3 py-2 text-right font-medium">Valor neto contable</th>
              <th className="px-3 py-2 text-left font-medium">Asiento</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {detail.schedule.map((row) => (
              <tr key={row.period} className="h-8" data-period={row.period}>
                <td className="px-3 py-1 font-code text-xs">{row.period}</td>
                <td className="px-3 py-1 text-right">
                  <Amount cents={row.quotaCents} />
                </td>
                <td className="px-3 py-1 text-right">
                  <Amount cents={row.accumulatedCents} />
                </td>
                <td className="px-3 py-1 text-right">
                  <Amount cents={row.netBookValueCents} />
                </td>
                <td className="px-3 py-1 text-xs">
                  {posted.has(row.period) ? (
                    <Link
                      href={`/ledger?from=${row.from}&to=${row.to}&account=${detail.asset.accumulatedAccountCode}`}
                      className="underline underline-offset-4"
                      data-testid={`asset-entry-${row.period}`}
                    >
                      ver el asiento de {row.period}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">sin contabilizar</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        El cuadro <strong>no se almacena</strong>: se deriva del activo y de sus revisiones cada vez que se pide
        (ADR-0003). Una cuota de cero céntimos no genera asiento y no deja hueco en el cuadro.
      </p>
    </div>
  )
}
