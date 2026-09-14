import { Amount } from "@/components/ledger/amount"
import type { EntryDraft } from "@/lib/ledger/types"

/**
 * E9 · T17/T18 — Vista previa de un asiento propuesto, compartida por las
 * pantallas de la épica (baja y venta de un activo, alta de préstamo por T-37 y
 * liquidación de IVA por T-23).
 *
 * Enseña las líneas tal cual las devuelve el motor. Los dos totales del pie son
 * **feedback de vista previa** en el sentido de `ui-erp` §Formularios —la suma
 * de las líneas que ya trae el borrador— y no una cifra contable calculada por
 * el navegador: el asiento que se persiste es el que construyó y validó el
 * servidor, y la base rechaza cualquiera descuadrado.
 */
export function EntryDraftPreview({
  draft,
  title = "Asiento propuesto",
  testId = "entry-draft",
}: {
  draft: EntryDraft
  title?: string
  testId?: string
}) {
  const totalDebitCents = draft.lines.reduce((acc, line) => acc + line.debitCents, 0)
  const totalCreditCents = draft.lines.reduce((acc, line) => acc + line.creditCents, 0)

  return (
    <div className="space-y-2 rounded-md border p-3" data-testid={testId}>
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted-foreground">
        Fecha <span className="font-code">{draft.entryDate}</span> · {draft.description}
        {draft.templateCode ? (
          <>
            {" · plantilla "}
            <span className="font-code">{draft.templateCode}</span>
          </>
        ) : null}
      </p>
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-2 py-1 text-left font-medium">Cuenta</th>
            <th className="px-2 py-1 text-left font-medium">Concepto</th>
            <th className="px-2 py-1 text-right font-medium">Debe</th>
            <th className="px-2 py-1 text-right font-medium">Haber</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {draft.lines.map((line) => (
            <tr key={line.lineNo} className="h-7">
              <td className="px-2 py-1 font-code text-xs">{line.accountCode ?? line.accountKey ?? "—"}</td>
              <td className="px-2 py-1 text-xs text-muted-foreground">{line.description ?? ""}</td>
              <td className="px-2 py-1 text-right">
                <Amount cents={line.debitCents} />
              </td>
              <td className="px-2 py-1 text-right">
                <Amount cents={line.creditCents} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t font-medium">
            <td className="px-2 py-1 text-xs" colSpan={2}>
              Vista previa · Σ Debe − Σ Haber ={" "}
              {totalDebitCents - totalCreditCents === 0 ? "0,00 € ✓" : "descuadrado ⚠"}
            </td>
            <td className="px-2 py-1 text-right">
              <Amount cents={totalDebitCents} />
            </td>
            <td className="px-2 py-1 text-right">
              <Amount cents={totalCreditCents} />
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
