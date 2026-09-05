"use client"

import { formatLocalDate } from "@/components/ledger/amount"
import type { ReportHeaderView } from "@/components/ledger/types"
import { shortHash } from "@/components/ledger/types"
import { Button } from "@/components/ui/button"
import { CheckStatusList } from "@/components/ui/check-status"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { SealBlock } from "@/components/ui/seal-badge"
import { useState } from "react"

/**
 * E3 · T12 — Cabecera de informe (`ui-erp` §Tablas, diseño §5).
 *
 * Periodo, moneda base, **sello** salido de `validacion.json` (`runInvariants`
 * + `sealFor`), `run_id` y `ledgerHash` abreviado en `.font-code`, y el botón
 * "Ver validación" que lista I1, I7–I10 e I-E3-*. Mientras no exista
 * `ReportRun` (E6) el sello se recalcula en cada render, así que lo que se ve
 * corresponde al diario de este instante.
 */
export function ReportHeader({
  title,
  description,
  header,
  actions,
}: {
  title: string
  description?: string
  header: ReportHeaderView
  actions?: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const failed = header.checks.filter((c) => c.status === "FAIL").length

  return (
    <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>}
        <p className="text-sm text-muted-foreground">
          Periodo {formatLocalDate(header.from)} – {formatLocalDate(header.to)} · moneda base {header.baseCurrency}
        </p>
        <p className="font-code text-xs text-muted-foreground">
          run_id {shortHash(header.runId, 12)} · ledgerHash {shortHash(header.ledgerHash, 16)} · motor{" "}
          {shortHash(header.gitSha, 8)}
        </p>
      </div>

      <div className="flex flex-col items-end gap-2">
        <SealBlock seal={header.seal} />
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
            Ver validación{failed > 0 ? ` (${failed} en FAIL)` : ""}
          </Button>
          {actions}
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Validación del libro diario</DialogTitle>
            <DialogDescription>
              Invariantes de Capa 1 sobre el diario de esta organización: I1 (partida doble), I7 (numeración sin
              huecos), I8 (fechas y periodos), I9 (cuentas del plan), I10 (tenant) y los propios de la épica I-E3-1…7.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto pr-1">
            <CheckStatusList checks={header.checks} />
          </div>
          <p className="font-code text-[11px] text-muted-foreground break-all">
            run_id {header.runId} · ledgerHash {header.ledgerHash}
          </p>
        </DialogContent>
      </Dialog>
    </div>
  )
}
