import { ClosingChecklist } from "@/components/closing/checklist"
import { CloseFiscalYearDialog, ReopenFiscalYearDialog, RunChecklistButton } from "@/components/closing/close-panel"
import { SocietarioPanel } from "@/components/closing/societario"
import { Blockers, ClosingEntries, ClosingHeader } from "@/components/closing/summary"
import { tenantPage } from "@/lib/page-tenant"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"

import { readClosingPage } from "./shared"

export const metadata: Metadata = { title: "Cierre del ejercicio" }

/**
 * E9 · T16 — **Asistente de cierre** (`docs/design/E9-cierre-recurrentes.md` §7).
 *
 * Una pantalla que contesta tres preguntas sin salir de ella: *¿puedo cerrar?*,
 * *¿qué me lo impide?* y *¿de dónde sale este veredicto?*. Por eso:
 *
 * · los **43 pasos en nueve bloques** llevan semáforo, evidencia literal y
 *   `registros_origen`, y el drill-down es de **tres clics** —bloque → paso →
 *   asiento—;
 * · los **nueve bloqueantes** que faltan salen arriba, por su nombre;
 * · cada paso con asiento ofrece **vista previa** antes de postear, en el orden
 *   de O-17, con el cuadre a la vista;
 * · **cerrar** exige un `ClosingRun` COMPROBADO y **reabrir** es doble
 *   confirmación, aparte y con el mensaje que ofrece salida.
 *
 * Server Component: `tenantPage` abre UNA transacción para todo el render y las
 * lecturas van en serie. `VIEWER` lo ve todo, sin un solo botón de mutación; y
 * lo que aquí se oculta, las acciones lo vuelven a exigir.
 */
export default tenantPage<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>(
  async ({ db, role, searchParams }) => {
    const query = await searchParams
    const raw = query.fy
    const fiscalYearId = Array.isArray(raw) ? raw[0] : raw

    const view = await readClosingPage(db, { fiscalYearId: fiscalYearId ?? null })
    const isAdmin = role === Role.ADMIN
    const canEdit = role === Role.EDITOR || role === Role.ADMIN

    if (!view) {
      return (
        <section className="space-y-3" data-testid="closing-empty">
          <h1 className="text-2xl font-semibold tracking-tight">Cierre del ejercicio</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Esta organización todavía no tiene ningún ejercicio abierto. Cree el primero en Configuración › Ejercicios:
            sin ejercicio no hay nada que cerrar y el asistente no puede afirmar nada.
          </p>
        </section>
      )
    }

    const { fiscalYear, run, blocks, blockers, entries, distribution, totals, fiscalYears } = view
    const abierto = fiscalYear.status === "OPEN"

    const acciones = (
      <div className="flex flex-wrap items-end justify-end gap-2">
        {canEdit && abierto && <RunChecklistButton fiscalYearId={fiscalYear.id} />}
        {isAdmin && abierto && <CloseFiscalYearDialog fiscalYear={fiscalYear} run={run} blockers={blockers} />}
        {/* «Reabrir» NO va aquí: vive aparte, al pie, con su aviso (§7). Dos
            botones idénticos para una operación que postea cuatro
            contra-asientos es exactamente lo que no debe pasar. */}
      </div>
    )

    return (
      <div className="space-y-8">
        <ClosingHeader
          fiscalYear={fiscalYear}
          fiscalYears={fiscalYears}
          run={run}
          totals={totals}
          actions={acciones}
        />

        {run ? (
          <Blockers blockers={blockers} />
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="closing-not-run">
            Ejecute el checklist para que el motor evalúe los {totals.steps} pasos sobre el diario. Hasta entonces esta
            pantalla no puede decir si el ejercicio se puede cerrar: ningún paso está en verde por defecto.
          </p>
        )}

        <ClosingChecklist blocks={blocks} fiscalYearId={fiscalYear.id} isAdmin={isAdmin} canPost={abierto} />

        <ClosingEntries entries={entries} />

        <SocietarioPanel fiscalYear={fiscalYear} distribution={distribution} isAdmin={isAdmin} />

        {!abierto && (
          <section className="space-y-2 rounded-md border border-[#F5A623] p-3" data-testid="reopen-block">
            <h2 className="text-sm font-semibold">Reapertura del ejercicio</h2>
            <p className="max-w-3xl text-xs text-muted-foreground">
              Reabrir postea cuatro contra-asientos (apertura, cierre, regularización del resultado e impuesto) y deja el
              valor actual, las diferencias de cambio y la reclasificación pendientes de recomputar. Exige ADMIN, motivo
              de al menos 30 caracteres y escribir el código del ejercicio. Con las cuentas{" "}
              <strong>formuladas, aprobadas o depositadas</strong> el servidor lo rechaza indicando el camino —acuerdo de
              reformulación, NRV 23ª—, no diciendo que sea imposible.
            </p>
            {isAdmin && <ReopenFiscalYearDialog fiscalYear={fiscalYear} />}
          </section>
        )}
      </div>
    )
  }
)
