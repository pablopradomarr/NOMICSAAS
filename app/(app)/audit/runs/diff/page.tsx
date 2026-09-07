import { CheckStatusChip } from "@/components/ui/check-status"
import { Amount } from "@/components/ledger/amount"
import { Button } from "@/components/ui/button"
import { FAMILY_LABEL } from "@/lib/audit/families"
import { HEADLINE_LABEL, short } from "@/components/audit/types"
import { fechaHoraUtc } from "@/lib/dates-ui"
import { diffRuns } from "@/lib/audit/diff"
import { tenantPage } from "@/lib/page-tenant"
import { getInvariantRun, toRunRef } from "@/models/audit"
import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = { title: "Comparación de barridos" }

const CAUSE_TEXT: Readonly<Record<string, string>> = {
  DATOS: "Han cambiado los datos: el diario o el bloque analítico no son los mismos.",
  MOTOR: "Ha cambiado el motor: los mismos datos, otra versión del código.",
  CONFIGURACION: "Ha cambiado la configuración: un umbral, el plan o el mapa de cuentas.",
  VARIOS: "Ha cambiado más de una cosa a la vez: mírense los hashes de abajo uno a uno.",
  NINGUNA: "No ha cambiado ningún sello.",
}

/**
 * E7 · T13 — Diff de dos barridos (`docs/design/E7-auditoria.md` §6, O-19/O-20).
 *
 * Lo que mira quien firma no es un check: es una **cifra**. Por eso el diff
 * abre con los Δ de activo, patrimonio neto + pasivo, resultado y tesorería, y
 * sólo después enseña qué comprobaciones cambiaron de estado.
 *
 * La **causa** no se adivina: sale de comparar los cinco sellos y el `gitSha`
 * de los dos barridos (`diffRuns`, motor puro). Que dos ejecuciones se
 * contradigan tiene que ser explicable, nunca un misterio (spec §0).
 */
export default tenantPage<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>(
  async ({ db, searchParams }) => {
    const query = await searchParams
    const first = (key: string): string | undefined => {
      const value = query[key]
      return Array.isArray(value) ? value[0] : value
    }
    const aId = first("a")
    const bId = first("b")

    if (!aId || !bId) {
      return (
        <div className="space-y-3">
          <h1 className="text-2xl font-semibold tracking-tight">Comparación de barridos</h1>
          <p className="rounded-md border border-dashed px-4 py-6 text-sm text-muted-foreground" data-testid="diff-empty">
            Elija <strong>dos</strong> barridos en el historial de Auditoría y pulse «Comparar».
          </p>
          <Button asChild variant="outline" size="sm">
            <Link href="/audit">Ir al historial</Link>
          </Button>
        </div>
      )
    }

    const a = await getInvariantRun(db, aId)
    const b = await getInvariantRun(db, bId)
    if (!a || !b) {
      return (
        <div className="space-y-3">
          <h1 className="text-2xl font-semibold tracking-tight">Comparación de barridos</h1>
          <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-4 py-6 text-sm" role="alert">
            Alguno de los dos barridos no existe en esta organización.
          </p>
          <Button asChild variant="outline" size="sm">
            <Link href="/audit">Volver a Auditoría</Link>
          </Button>
        </div>
      )
    }

    const diff = diffRuns(toRunRef(a), toRunRef(b))

    return (
      <div className="space-y-8">
        <header className="space-y-2 border-b pb-4">
          <Button asChild variant="ghost" size="sm" className="-ml-3">
            <Link href="/audit">← Auditoría</Link>
          </Button>
          <h1 className="text-2xl font-semibold tracking-tight">Comparación de barridos</h1>
          <p className="text-sm text-muted-foreground">
            <Link href={`/audit/runs/${a.id}`} className="underline underline-offset-2">
              A · {fechaHoraUtc(a.createdAt)}
            </Link>{" "}
            →{" "}
            <Link href={`/audit/runs/${b.id}`} className="underline underline-offset-2">
              B · {fechaHoraUtc(b.createdAt)}
            </Link>
          </p>
          <p className="rounded-md border px-3 py-2 text-sm" data-testid="diff-cause" data-cause={diff.cause}>
            <strong>Causa: {diff.cause}.</strong> {CAUSE_TEXT[diff.cause] ?? ""}
          </p>
        </header>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Las cuatro cifras</h2>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="p-2 text-left font-medium">Cifra</th>
                  <th className="p-2 text-right font-medium">A</th>
                  <th className="p-2 text-right font-medium">B</th>
                  <th className="p-2 text-right font-medium">Δ</th>
                  <th className="p-2 text-left font-medium">Procedencia</th>
                </tr>
              </thead>
              <tbody>
                {diff.figures.map((figure) => (
                  <tr key={figure.metric} className="border-t" data-testid={`diff-figure-${figure.metric}`}>
                    <td className="p-2">{HEADLINE_LABEL[figure.metric]}</td>
                    <td className="p-2 text-right">
                      <Amount cents={figure.fromCents} zeroAsDash={false} />
                    </td>
                    <td className="p-2 text-right">
                      <Amount cents={figure.toCents} zeroAsDash={false} />
                    </td>
                    <td className="p-2 text-right" data-delta={figure.deltaCents}>
                      <Amount cents={figure.deltaCents} zeroAsDash={false} />
                    </td>
                    <td className="font-code p-2 text-xs text-muted-foreground">
                      {figure.provenance ? short(JSON.stringify(figure.provenance), 48) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Sellos que han cambiado</h2>
          {diff.hashChanges.length === 0 ? (
            <p className="text-sm text-muted-foreground">Ninguno: los dos barridos miran exactamente el mismo estado.</p>
          ) : (
            <ul className="space-y-1 text-sm" data-testid="diff-hashes">
              {diff.hashChanges.map((change) => (
                <li key={change.hash} className="font-code text-xs">
                  {change.hash}: <span title={change.from}>{short(change.from, 16)}</span> →{" "}
                  <span title={change.to}>{short(change.to, 16)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Comprobaciones que han cambiado</h2>
          {diff.deltas.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="diff-no-deltas">
              Ninguna comprobación ha cambiado de estado entre los dos barridos.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="p-2 text-left font-medium">Comprobación</th>
                    <th className="p-2 text-left font-medium">Familia</th>
                    <th className="p-2 text-left font-medium">A</th>
                    <th className="p-2 text-left font-medium">B</th>
                    <th className="p-2 text-left font-medium">Evidencia en A</th>
                    <th className="p-2 text-left font-medium">Evidencia en B</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.deltas.map((delta) => (
                    <tr key={delta.id} className="border-t align-top" data-testid={`diff-check-${delta.id}`}>
                      <td className="font-code p-2 text-xs">{delta.id}</td>
                      <td className="p-2 text-xs">{FAMILY_LABEL[delta.family]}</td>
                      <td className="p-2">
                        {delta.from ? <CheckStatusChip status={delta.from} /> : <span className="text-xs">no estaba</span>}
                      </td>
                      <td className="p-2">
                        {delta.to ? <CheckStatusChip status={delta.to} /> : <span className="text-xs">ya no está</span>}
                      </td>
                      <td className="p-2 text-xs text-muted-foreground">{delta.evidenciaFrom ?? "—"}</td>
                      <td className="p-2 text-xs text-muted-foreground">{delta.evidenciaTo ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    )
  }
)
