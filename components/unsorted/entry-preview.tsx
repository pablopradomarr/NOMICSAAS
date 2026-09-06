import { AmountPlain, formatLocalDate } from "@/components/ledger/amount"
import { ConfidenceBadge } from "@/components/ui/confidence-badge"
import type { AccountNameMap, EntryPreview as EntryPreviewData } from "@/components/unsorted/types"
import { formatCents } from "@/lib/money"
import { cn } from "@/lib/utils"

/**
 * E8 · T16 — Panel «Asiento propuesto» (§6).
 *
 * Lo que esta tabla enseña **no lo calcula el navegador**: es el `EntryDraft`
 * que `previewFromProposal()` construyó en el servidor con la misma función que
 * lo contabilizará al confirmar (I-E8-8). Por eso la fila de cuadre puede
 * afirmar «Σ debe − Σ haber = 0,00 €» y no «según mis cuentas»: si no cuadrase,
 * no habría borrador que pintar.
 *
 * Tres cosas que el diseño exige y que se ven aquí:
 *
 *  · **Bloques de pasivo desglosados** (O-3): un documento mixto de equipo y
 *    mantenimiento no deja 1.452.000 en una sola línea de 523; deja 523 por el
 *    inmovilizado y 410 por el servicio, cada uno con su base y su cuota. El
 *    desglose se pinta aparte para que la separación sea visible y auditable.
 *  · **La cuota contabilizada es la del documento** (ADR-0014 D3): cuando el
 *    motor la respeta pese a discrepar del recálculo, `taxOverrides` lo dice.
 *  · **Las cuatro fechas y el periodo de IVA**, que es lo que decide en qué
 *    trimestre se deduce.
 */

export function ProposedEntry({
  entry,
  error,
  accountNames,
  currency,
  className,
}: {
  entry: EntryPreviewData | null
  error: { code: string; message: string } | null
  accountNames: AccountNameMap
  currency: string
  className?: string
}) {
  if (!entry) {
    return (
      <section className={cn("space-y-2", className)} data-testid="proposed-entry-error">
        <h2 className="text-sm font-semibold tracking-tight">Asiento propuesto</h2>
        <div className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-3 text-sm">
          <p className="font-medium">No hay asiento que proponer.</p>
          <p className="text-muted-foreground">
            {error?.message ?? "La propuesta no está reconciliada."}{" "}
            {error?.code && <span className="font-code text-xs">({error.code})</span>}
          </p>
        </div>
      </section>
    )
  }

  const cuadra = entry.descuadreCents === 0

  return (
    <section className={cn("space-y-3", className)} data-testid="proposed-entry">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-tight">Asiento propuesto</h2>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            Plantilla <span className="font-code">{entry.templateCode}</span>
          </span>
          <span>·</span>
          <span>
            Origen <span className="font-code">{entry.sourceType}</span>
          </span>
          <ConfidenceBadge level="calculado" title="Borrador construido por el motor contable, sin persistir." />
        </div>
      </header>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid="proposed-entry-lines">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="w-10 px-3 py-2 text-left font-medium">#</th>
              <th className="px-3 py-2 text-left font-medium">Cuenta</th>
              <th className="px-3 py-2 text-left font-medium">Concepto</th>
              <th className="px-3 py-2 text-left font-medium">Dimensión</th>
              <th className="px-3 py-2 text-right font-medium">Debe</th>
              <th className="px-3 py-2 text-right font-medium">Haber</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {entry.lines.map((line) => (
              <tr key={line.lineNo} className="h-8" data-line-no={line.lineNo} data-account={line.accountCode}>
                <td className="px-3 py-1 font-code text-xs text-muted-foreground">{line.lineNo}</td>
                <td className="px-3 py-1">
                  <span className="font-code text-xs">{line.accountCode}</span>{" "}
                  <span className="text-muted-foreground">{accountNames[line.accountCode] ?? ""}</span>
                  {line.taxRateCode && (
                    <span className="ml-1 rounded bg-muted px-1 py-0.5 font-code text-[10px]">{line.taxRateCode}</span>
                  )}
                  {line.originalCurrency && line.originalAmountCents !== null && (
                    <span className="ml-1 text-[10px] text-muted-foreground">
                      ({formatCents(line.originalAmountCents, { currency: line.originalCurrency })} originales)
                    </span>
                  )}
                </td>
                <td className="px-3 py-1 text-muted-foreground">{line.description ?? ""}</td>
                <td className="px-3 py-1 text-xs text-muted-foreground">
                  {line.projectId || line.costCenterId ? (
                    <span className="font-code">{line.projectId ?? line.costCenterId}</span>
                  ) : (
                    "—"
                  )}
                  {line.deductibility && line.deductibility !== "FULL" && (
                    <span className="ml-1 rounded bg-muted px-1 py-0.5 text-[10px] uppercase">{line.deductibility}</span>
                  )}
                  {line.nonDeductibleIncludedCents > 0 && (
                    <span className="ml-1 text-[10px]">
                      IVA no deducible incorporado: {formatCents(line.nonDeductibleIncludedCents, { currency })}
                    </span>
                  )}
                </td>
                <td className="px-3 py-1 text-right">
                  <AmountPlain cents={line.debitCents} />
                </td>
                <td className="px-3 py-1 text-right">
                  <AmountPlain cents={line.creditCents} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 bg-muted/30 font-medium">
            <tr className="h-9">
              <td className="px-3 py-1" colSpan={4}>
                Totales ({currency})
              </td>
              <td className="px-3 py-1 text-right">
                <AmountPlain cents={entry.totalDebitCents} zeroAsDash={false} />
              </td>
              <td className="px-3 py-1 text-right">
                <AmountPlain cents={entry.totalCreditCents} zeroAsDash={false} />
              </td>
            </tr>
            <tr className="h-9" data-testid="entry-balance" data-descuadre={entry.descuadreCents}>
              <td className="px-3 py-1" colSpan={4}>
                Σ Debe − Σ Haber
              </td>
              <td className="px-3 py-1 text-right" colSpan={2}>
                <span className={cn("tabular-nums", !cuadra && "font-semibold")}>
                  {formatCents(entry.descuadreCents, { currency, zeroAsDash: false })} {cuadra ? "✓" : "⚠"}
                </span>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {entry.payableBlocks.length > 0 && (
        <div className="space-y-1" data-testid="payable-blocks">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Bloques de pasivo desglosados
          </h3>
          <p className="text-[11px] text-muted-foreground">
            El pasivo de un documento mixto se reparte por naturaleza: el inmovilizado a 523 y los bienes y servicios
            corrientes a 400/410, cada bloque con su base y su cuota. La reclasificación a 173 se mide desde el cierre
            del ejercicio y es un asiento de E9, nunca del alta.
          </p>
          <table className="w-full overflow-hidden rounded-md border text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Bloque</th>
                <th className="px-3 py-2 text-left font-medium">Cuenta</th>
                <th className="px-3 py-2 text-right font-medium">Base</th>
                <th className="px-3 py-2 text-right font-medium">Cuota</th>
                <th className="px-3 py-2 text-right font-medium">Importe</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {entry.payableBlocks.map((block) => (
                <tr key={`${block.payableKey}-${block.accountCode}`} className="h-8" data-payable-key={block.payableKey}>
                  <td className="px-3 py-1 font-code text-xs">{block.payableKey}</td>
                  <td className="px-3 py-1 font-code text-xs">{block.accountCode}</td>
                  <td className="px-3 py-1 text-right">
                    <AmountPlain cents={block.baseCents} />
                  </td>
                  <td className="px-3 py-1 text-right">
                    <AmountPlain cents={block.quotaCents} />
                  </td>
                  <td className="px-3 py-1 text-right">
                    <AmountPlain cents={block.amountCents} zeroAsDash={false} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {entry.taxOverrides.length > 0 && (
        <div className="rounded-md border px-3 py-2 text-xs" data-testid="tax-overrides">
          <p className="font-medium">Cuota del documento respetada</p>
          <p className="text-muted-foreground">
            El asiento lleva la cuota que dice la factura, no la recalculada (ADR-0014 D3): el libro registro de
            facturas recibidas y el modelo 303 tienen que coincidir con el papel.{" "}
            {entry.taxOverrides
              .map((o) => `${o.taxRateCode}: ${formatCents(o.quotaCents, { currency })}`)
              .join(" · ")}
          </p>
        </div>
      )}

      <dl className="grid gap-x-6 gap-y-2 rounded-md border p-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <Item label="Fecha contable" value={formatLocalDate(entry.entryDate)} />
        <Item label="Fecha del documento" value={formatLocalDate(entry.documentDate)} />
        <Item label="Fecha de devengo" value={formatLocalDate(entry.operationDate)} />
        <Item label="Fecha de recepción" value={formatLocalDate(entry.receptionDate)} />
        <Item label="Periodo de IVA" value={entry.ivaPeriod ?? "—"} mono />
        <Item label="Libro registro" value={entry.ledgerBook?.tipo ?? "—"} mono />
      </dl>

      {entry.ledgerBook && (
        <div className="rounded-md border px-3 py-2 text-xs" data-testid="vat-book">
          <p className="font-medium">
            Libro registro de IVA · <span className="font-code">{entry.ledgerBook.tipo}</span> ·{" "}
            {entry.ledgerBook.ivaPeriod ?? "sin periodo"}
          </p>
          <p className="text-muted-foreground">
            Base {formatCents(entry.ledgerBook.baseCents, { currency })} · cuota total{" "}
            {formatCents(entry.ledgerBook.cuotaTotalCents, { currency })} · deducible{" "}
            {formatCents(entry.ledgerBook.cuotaDeducibleCents, { currency })} · no deducible incorporada al coste{" "}
            {formatCents(entry.ledgerBook.cuotaNoDeducibleAlCosteCents, { currency })} · repercutida{" "}
            {formatCents(entry.ledgerBook.cuotaRepercutidaCents, { currency })} · devengada por ISP/AIB{" "}
            {formatCents(entry.ledgerBook.cuotaDevengadaIspAibCents, { currency })}
          </p>
        </div>
      )}
    </section>
  )
}

function Item({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-code text-xs break-all" : ""}>{value}</dd>
    </div>
  )
}
