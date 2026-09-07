import { RunSummary } from "@/components/audit/blocks"
import { ExportValidacionButton } from "@/components/audit/export-validacion"
import { FamilyCards } from "@/components/audit/family-cards"
import { ForceReviewFromRunDialog } from "@/components/audit/force-review-dialog"
import { Button } from "@/components/ui/button"
import { tenantPage } from "@/lib/page-tenant"
import { getInvariantRun } from "@/models/audit"
import { listFiscalYears } from "@/models/fiscal-years"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { originRecordsOf, sealReasonsOf, toCheckViews, toFamilyCards, toRunSummary } from "../../shared"

export const metadata: Metadata = { title: "Barrido de invariantes" }

/**
 * E7 · T13 — La **foto** de un barrido (`docs/design/E7-auditoria.md` §6).
 *
 * Un `InvariantRun` es append-only: lo que se ve aquí es exactamente lo que se
 * selló, no un recálculo. De ahí que la pantalla no ofrezca «actualizar»: para
 * tener otra foto se ejecuta otro barrido y se comparan las dos.
 *
 * Enseña los checks por familia con su drill-down, la cobertura —qué NO se
 * evaluó y por qué—, los cinco hashes, las cuatro cifras, y exporta el
 * `validacion.json` en el mismo formato que `scripts/run-invariants.ts`.
 */
export default tenantPage<{ params: Promise<{ id: string }> }>(async ({ db, org, role, params }) => {
  const { id } = await params
  const run = await getInvariantRun(db, id)
  if (!run) notFound()

  const fiscalYears = await listFiscalYears(db)
  const records = await originRecordsOf(db, run.checks)
  const checkViews = toCheckViews(run.checks, records)
  const families = toFamilyCards(checkViews, run.checks)
  const motivos = sealReasonsOf(run)

  /**
   * El formato de `validacion.json` de `docs/design/E3-libro-diario.md` §5, tal
   * cual: `run_id`, `ledgerHash`, `gitSha`, `organizationId`, `refDate`, el
   * `sello` y los `checks` con su evidencia y su consulta.
   */
  const validacion = JSON.stringify(
    {
      run_id: run.id,
      ledgerHash: run.ledgerHash,
      gitSha: run.gitSha,
      organizationId: org.id,
      refDate: run.refDate,
      sello: {
        sello: run.seal === "VALIDADO_AUTOMATICAMENTE" ? "VALIDADO AUTOMÁTICAMENTE" : "REQUIERE REVISIÓN",
        motivos,
      },
      checks: run.checks,
    },
    null,
    2
  )

  const periodStart = run.periodStart ?? run.refDate
  const periodEnd = run.periodEnd ?? run.refDate

  return (
    <div className="space-y-8">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-3">
          <Link href="/audit">← Auditoría</Link>
        </Button>
      </div>

      <RunSummary
        run={toRunSummary(run, fiscalYears.find((year) => year.id === run.fiscalYearId)?.code ?? null, motivos)}
        actions={
          <div className="flex flex-wrap justify-end gap-2">
            <ExportValidacionButton filename={`validacion-${run.id.slice(0, 8)}.json`} json={validacion} />
            {role === Role.ADMIN && (
              <ForceReviewFromRunDialog
                invariantRunId={run.id}
                defaultPeriodStart={periodStart}
                defaultPeriodEnd={periodEnd}
              />
            )}
          </div>
        }
      />

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Comprobaciones por familia</h2>
        <FamilyCards families={families} />
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Procedencia</h2>
        <p className="text-sm text-muted-foreground">
          Cada comprobación de esta foto se calculó sobre el estado sellado por los cinco hashes de arriba, con el motor
          en <span className="font-code">{run.gitSha}</span> y fecha de referencia {run.refDate}. El sello de los
          propios <span className="font-code">checks</span> es{" "}
          <span className="font-code" title={run.checksHash}>
            {run.checksHash.slice(0, 16)}
          </span>
          : si alguien editara una fila por SQL, I-E7-7 lo delataría nombrando este barrido.
        </p>
      </section>
    </div>
  )
})
