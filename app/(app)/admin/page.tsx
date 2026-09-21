import { requirePlatformAdmin } from "./admin"
import { listOrganizationsForOperator } from "@/models/platform"
import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = { title: "Operación de plataforma" }
export const dynamic = "force-dynamic"

/**
 * E12 · T13 — **`/admin`**: la lista de organizaciones (ADR-0020 §5.5).
 *
 * Lo que enseña, y en este orden: **las excepciones de operador vivas en rojo
 * arriba del todo**, y después cada organización con su plan, su uso grueso y el
 * sello de su último barrido.
 *
 * Lo que **no** enseña: ni un email, ni un NIF, ni una cifra del diario. El
 * operador ve *cuánto*, no *qué* — la misma regla de `/api/health` (§9.2). El
 * nombre de la organización sí, porque es lo que hay que teclear para confirmar.
 *
 * A quien no es operador de plataforma, `notFound()`: **404, no 403** (criterio
 * 46). Un 403 confirmaría que este panel existe.
 */
export default async function AdminPage() {
  await requirePlatformAdmin()
  const now = new Date()
  const orgs = await listOrganizationsForOperator(now)
  const conExcepcion = orgs.filter((o) => o.liveExceptions > 0)

  return (
    <main className="p-6 space-y-6" data-testid="admin-page">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Operación de plataforma</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Cuatro escrituras de operador, y ni una más (ADR-0020 D1). Todas dejan motivo, actor y recuentos en el
          registro de plataforma <strong>y</strong> en el registro de la organización. Ninguna toca el diario.
        </p>
      </header>

      {conExcepcion.length > 0 && (
        <section
          className="rounded-lg border border-destructive/50 bg-destructive/5 p-4"
          data-testid="admin-excepciones-vivas"
        >
          <h2 className="font-semibold text-destructive">
            {conExcepcion.length} organización(es) con una excepción de operador viva
          </h2>
          <p className="mt-1 text-sm">
            Mientras la excepción viva, el periodo de esa organización <strong>no</strong> se puede firmar como
            «validado automáticamente»: sale con <code>EXCEPCION_DE_OPERADOR_VIGENTE</code>. Caduca sola en 24 h.
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {conExcepcion.map((o) => (
              <li key={o.id}>
                <Link href={`/admin/${o.id}`} className="underline">
                  {o.name}
                </Link>{" "}
                · {o.liveExceptions} viva(s)
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="admin-organizaciones">
          <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="py-2 pr-4">Organización</th>
              <th className="py-2 pr-4">Plan</th>
              <th className="py-2 pr-4 text-right">Asientos</th>
              <th className="py-2 pr-4 text-right">Miembros</th>
              <th className="py-2 pr-4">Último sello</th>
              <th className="py-2 pr-4 text-right">Excepciones</th>
            </tr>
          </thead>
          <tbody>
            {orgs.map((o) => (
              <tr key={o.id} className="border-t" data-testid={`admin-org-${o.slug}`}>
                <td className="py-2 pr-4">
                  <Link href={`/admin/${o.id}`} className="font-medium underline">
                    {o.name}
                  </Link>
                  <div className="text-xs text-muted-foreground">
                    {o.slug}
                    {!o.isActive && " · desactivada"}
                    {o.isPersonal && " · personal"}
                  </div>
                </td>
                <td className="py-2 pr-4">
                  {o.planCode ?? "—"}
                  {o.subscriptionStatus && (
                    <span className="text-xs text-muted-foreground"> · {o.subscriptionStatus}</span>
                  )}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">{o.journalEntries}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{o.members}</td>
                <td className="py-2 pr-4">
                  {o.lastSeal ? (
                    <>
                      <span>{o.lastSeal}</span>
                      <div className="text-xs text-muted-foreground">{o.lastSweepAt?.slice(0, 19).replace("T", " ")}</div>
                    </>
                  ) : (
                    <span className="text-muted-foreground">sin barrer</span>
                  )}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">
                  {o.liveExceptions > 0 ? (
                    <span className="font-semibold text-destructive">{o.liveExceptions}</span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {orgs.length === 0 && (
          <p className="py-6 text-sm text-muted-foreground" data-testid="admin-vacio">
            No hay ninguna organización en esta instalación todavía.
          </p>
        )}
      </section>
    </main>
  )
}
