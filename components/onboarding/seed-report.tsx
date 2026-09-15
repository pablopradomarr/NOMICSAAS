import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { SeedPiece, SeedReport } from "@/models/onboarding"

/**
 * E11 · ola C · T14 — **qué se ha sembrado**, pieza a pieza (§10).
 *
 * Las **nueve piezas** de I-E11-10, contadas contra la base y no contra lo que la
 * siembra creyó hacer. El asistente las enseña en vez de un spinner: es la
 * primera prueba que el producto le da al cliente de que sabe lo que hace, y es
 * exactamente lo que el invariante vuelve a comprobar cada noche.
 *
 * Nunca un ✓ que no se haya comprobado: la pieza no evaluable sale con su motivo.
 */
export function SeedReportTable({ report }: { report: SeedReport | null }) {
  if (!report) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="seed-report-empty">
        Todavía no hay nada sembrado: el asistente lo creará al dar de alta la empresa.
      </p>
    )
  }

  return (
    <div className="space-y-2" data-testid="seed-report">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[45%]">Pieza</TableHead>
              <TableHead className="text-right tabular-nums">Sembrado</TableHead>
              <TableHead>Lo que se exige</TableHead>
              <TableHead className="w-[1%]">Estado</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.pieces.map((piece) => (
              <SeedPieceRow key={piece.key} piece={piece} />
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="seed-report-summary">
        {report.ok
          ? "Las nueve piezas de la siembra están completas (I-E11-10)."
          : "Faltan piezas por sembrar: revisa las marcadas y vuelve a intentarlo."}
      </p>
    </div>
  )
}

function SeedPieceRow({ piece }: { piece: SeedPiece }) {
  return (
    <TableRow data-testid={`seed-piece-${piece.key}`} data-piece-ok={piece.ok ? "true" : "false"}>
      <TableCell className="font-medium">
        {piece.label}
        {piece.detail && <span className="block text-xs font-normal text-muted-foreground">{piece.detail}</span>}
      </TableCell>
      <TableCell className="text-right tabular-nums">{piece.count ?? "—"}</TableCell>
      <TableCell className="text-sm text-muted-foreground">{piece.expected}</TableCell>
      <TableCell>
        <span
          className={
            piece.ok
              ? "rounded-sm bg-foreground px-2 py-0.5 text-xs font-medium text-background"
              : "rounded-sm border border-dashed border-[#F5A623] px-2 py-0.5 text-xs font-medium text-[#B26E00]"
          }
        >
          {piece.ok ? "✓ sembrado" : "⚠ falta"}
        </span>
      </TableCell>
    </TableRow>
  )
}
