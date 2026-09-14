"use client"

import { Amount } from "@/components/ledger/amount"
import { cn } from "@/lib/utils"

/**
 * E9 · T16 — Vista previa de **un** asiento del cierre, con el cuadre a la vista
 * (`ui-erp` §Formularios, §7 del diseño).
 *
 * Las líneas y sus importes vienen del **servidor** (`buildFromTemplate` en
 * `dryRun`), no de aquí. Las dos sumas del pie son **feedback visual** de lo que
 * el servidor ya ha compuesto y van marcadas como tal: la partida doble la
 * impone el motor y, en última instancia, el trigger de la base.
 */

export type PreviewLine = {
  lineNo: number
  accountCode?: string | null
  description?: string | null
  debitCents: number
  creditCents: number
}

export type PreviewDraft = {
  entryDate: string
  description: string
  templateCode?: string | null
  lines: readonly PreviewLine[]
}

export function EntryPreview({
  draft,
  parametros,
  avisos,
}: {
  draft: PreviewDraft
  parametros?: readonly { etiqueta: string; valor: string }[]
  avisos?: readonly string[]
}) {
  let debe = 0
  let haber = 0
  for (const line of draft.lines) {
    debe += line.debitCents
    haber += line.creditCents
  }
  const cuadra = debe === haber

  return (
    <div className="space-y-3" data-testid="entry-preview">
      <p className="text-sm">
        <span className="font-medium">{draft.description}</span>
        <span className="text-muted-foreground">
          {" · "}
          {draft.entryDate}
          {draft.templateCode ? ` · plantilla ${draft.templateCode}` : ""}
        </span>
      </p>

      {parametros && parametros.length > 0 && (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2" data-testid="preview-parametros">
          {parametros.map((p) => (
            <div key={p.etiqueta} className="flex justify-between gap-3 border-b py-1">
              <dt className="text-muted-foreground">{p.etiqueta}</dt>
              <dd className="tabular-nums">{p.valor}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-1 pr-2 font-medium">Cuenta</th>
              <th className="py-1 pr-2 font-medium">Concepto</th>
              <th className="py-1 pr-2 text-right font-medium">Debe</th>
              <th className="py-1 text-right font-medium">Haber</th>
            </tr>
          </thead>
          <tbody>
            {draft.lines.map((line) => (
              <tr key={line.lineNo} className="h-8 border-b last:border-0">
                <td className="font-code pr-2 whitespace-nowrap">{line.accountCode ?? "—"}</td>
                <td className="pr-2 text-muted-foreground">{line.description ?? ""}</td>
                <td className="pr-2 text-right">
                  <Amount cents={line.debitCents} />
                </td>
                <td className="text-right">
                  <Amount cents={line.creditCents} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t font-medium">
              <td className="py-1 pr-2" colSpan={2}>
                Σ Debe − Σ Haber <span className="text-xs font-normal text-muted-foreground">(vista previa)</span>
              </td>
              <td className="pr-2 text-right">
                <Amount cents={debe} zeroAsDash={false} />
              </td>
              <td className="text-right">
                <Amount cents={haber} zeroAsDash={false} />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p
        data-testid="preview-cuadre"
        data-cuadra={cuadra ? "si" : "no"}
        className={cn("text-sm font-medium", cuadra ? "text-foreground" : "text-[#1A202C]")}
      >
        {cuadra ? "✓ Σ Debe − Σ Haber = 0,00 €" : "⚠ El borrador no cuadra: el motor lo rechazará al postear"}
      </p>

      {avisos && avisos.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground" data-testid="preview-avisos">
          {avisos.map((aviso) => (
            <li key={aviso}>{aviso}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
