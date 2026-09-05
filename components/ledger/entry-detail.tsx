import { AmountPlain, formatLocalDate } from "@/components/ledger/amount"
import { KindBadge, ReversalBadge, VoidedBadge } from "@/components/ledger/entry-badges"
import type { EntryView } from "@/components/ledger/types"
import { SOURCE_TYPE_LABELS, shortHash } from "@/components/ledger/types"
import { ConfidenceBadge } from "@/components/ui/confidence-badge"
import Link from "next/link"

/**
 * E3 · T11 — Detalle de un asiento, en sólo lectura (ADR-0003: nada es
 * editable) con su trazabilidad completa (§7): las tres fechas, el modo de
 * redondeo sellado, quién lo contabilizó y cuándo, el documento origen, el
 * `entryHash` y el par anulado / anulador.
 */
export function EntryDetail({ entry, baseCurrency }: { entry: EntryView; baseCurrency: string }) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Asiento nº <span className="font-code">{entry.entryNumber}</span>
          </h1>
          <p className="text-sm text-muted-foreground">{entry.description}</p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <KindBadge kind={entry.kind} />
            <VoidedBadge entry={entry} />
            <ReversalBadge entry={entry} />
            <ConfidenceBadge level="comprobado" title="Cuadre garantizado por la base de datos (I1)." />
          </div>
        </div>
      </div>

      {entry.voidedAt && (
        <div className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" data-testid="voided-banner">
          Asiento anulado el {formatLocalDate(entry.voidedAt.slice(0, 10))}
          {entry.reversedByEntryId && (
            <>
              {" "}
              por el{" "}
              <Link href={`/ledger/${entry.reversedByEntryId}`} className="underline underline-offset-2">
                asiento nº {entry.reversedByEntryNumber}
              </Link>
            </>
          )}
          {entry.voidReason && <>. Motivo: “{entry.voidReason}”</>}
        </div>
      )}

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid="entry-lines">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="w-10 px-3 py-2 text-left font-medium">#</th>
              <th className="px-3 py-2 text-left font-medium">Cuenta</th>
              <th className="px-3 py-2 text-left font-medium">Concepto</th>
              {/* E4 · T15 — destino analítico: sólo lo llevan las líneas de
                  grupo 6/7 (R-A1); en el resto se pinta `—`. */}
              <th className="px-3 py-2 text-left font-medium">Destino analítico</th>
              <th className="px-3 py-2 text-left font-medium">Vencimiento</th>
              <th className="px-3 py-2 text-right font-medium">Debe</th>
              <th className="px-3 py-2 text-right font-medium">Haber</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {entry.lines.map((line) => (
              <tr key={line.lineNo} className="h-8" data-line-no={line.lineNo}>
                <td className="px-3 py-1 font-code text-xs text-muted-foreground">{line.lineNo}</td>
                <td className="px-3 py-1">
                  <Link href={`/ledger/mayor?account=${line.accountCode}`} className="font-code text-xs underline-offset-2 hover:underline">
                    {line.accountCode}
                  </Link>{" "}
                  <span className="text-muted-foreground">{line.accountName}</span>
                </td>
                <td className="px-3 py-1 text-muted-foreground">{line.description ?? ""}</td>
                <td className="px-3 py-1 text-xs" data-destination={line.destinationCode ?? ""}>
                  {line.isPnlLine ? (
                    <>
                      <span className="font-code">{line.destinationCode ?? "—"}</span>
                      {line.destinationName && <span className="ml-1 text-muted-foreground">{line.destinationName}</span>}
                      {line.analyticType && (
                        <span className="ml-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                          {line.analyticType}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-1 tabular-nums text-muted-foreground">{line.dueDate ? formatLocalDate(line.dueDate) : "—"}</td>
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
              <td className="px-3 py-1" colSpan={5}>
                Totales ({baseCurrency})
              </td>
              <td className="px-3 py-1 text-right">
                <AmountPlain cents={entry.totalDebitCents} zeroAsDash={false} />
              </td>
              <td className="px-3 py-1 text-right">
                <AmountPlain cents={entry.totalCreditCents} zeroAsDash={false} />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold tracking-tight">Trazabilidad</h2>
        <dl className="grid gap-x-6 gap-y-2 rounded-md border p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Item label="Fecha del documento" value={formatLocalDate(entry.documentDate)} />
          <Item label="Fecha de devengo" value={formatLocalDate(entry.accrualDate)} />
          <Item label="Fecha contable" value={formatLocalDate(entry.entryDate)} />
          <Item label="Ejercicio" value={entry.fiscalYearCode ?? "—"} mono />
          <Item label="Origen" value={SOURCE_TYPE_LABELS[entry.sourceType] ?? entry.sourceType} />
          <Item label="Plantilla" value={entry.templateCode ?? "—"} mono />
          <Item label="Modo de redondeo sellado" value={entry.taxRoundingMode ?? "—"} mono />
          <Item label="Contabilizado por" value={entry.postedByName ?? "—"} />
          <Item
            label="Contabilizado el"
            value={entry.postedAt ? new Date(entry.postedAt).toLocaleString("es-ES") : "—"}
          />
          <Item label="entryHash" value={shortHash(entry.entryHash, 24)} mono title={entry.entryHash ?? undefined} />
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">Documento origen</dt>
            <dd>
              {entry.transactionId ? (
                <Link href={`/transactions/${entry.transactionId}`} className="underline underline-offset-2">
                  Ver la operación
                </Link>
              ) : entry.fileId ? (
                <Link href={`/files/${entry.fileId}`} className="underline underline-offset-2">
                  Ver el documento
                </Link>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">Anulación</dt>
            <dd>
              {entry.reversesEntryId ? (
                <Link href={`/ledger/${entry.reversesEntryId}`} className="underline underline-offset-2">
                  Anula al asiento nº {entry.reversesEntryNumber ?? "—"}
                </Link>
              ) : entry.reversedByEntryId ? (
                <Link href={`/ledger/${entry.reversedByEntryId}`} className="underline underline-offset-2">
                  Anulado por el asiento nº {entry.reversedByEntryNumber ?? "—"}
                </Link>
              ) : (
                <span className="text-muted-foreground">Vigente</span>
              )}
            </dd>
          </div>
        </dl>
      </section>
    </div>
  )
}

function Item({ label, value, mono, title }: { label: string; value: string; mono?: boolean; title?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-code text-xs break-all" : ""} title={title}>
        {value}
      </dd>
    </div>
  )
}
