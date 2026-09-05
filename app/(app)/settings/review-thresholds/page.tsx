import { ReviewThresholdsForm, type KpiThresholdRow } from "@/components/reports/review-thresholds-form"
import { requireOrg } from "@/lib/authz"
import { DEFAULT_KPI_THRESHOLDS } from "@/lib/ledger/report-run"
import { thresholdsOf } from "@/models/reports"
import { Role } from "@/prisma/client"
import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = { title: "Umbrales de revisión" }

/**
 * E6 · T17 — Umbrales de revisión (`Organization.reviewThresholds`).
 *
 * Los LEE cualquier rol —saber cuándo un informe pasa a revisión no es un
 * privilegio— y sólo un ADMIN los cambia; la acción lo vuelve a exigir, así que
 * ocultar el botón es cortesía, no la protección.
 */

const DEFINITIONS: Record<string, { label: string; definition: string }> = {
  ingresos: { label: "Ingresos", definition: "Epígrafe 1 · importe neto de la cifra de negocios" },
  ebitda: { label: "EBITDA", definition: "A.1 revirtiendo los epígrafes 8 y 11" },
  resultado: { label: "Resultado", definition: "A.4 de la cuenta de pérdidas y ganancias" },
  tesoreria: { label: "Tesorería", definition: "Saldo final de las cuentas 57x" },
  deuda: { label: "Deuda", definition: "17x + 52x + 40x + 41x" },
  dso: { label: "DSO", definition: "430 / INCN × 365 · el suelo son días" },
  margenBruto: { label: "Margen bruto", definition: "MC1 en porcentaje · se mide en puntos de margen" },
}

export default async function ReviewThresholdsPage() {
  const { org, role } = await requireOrg(Role.VIEWER)
  const isAdmin = role === Role.ADMIN
  const thresholds = thresholdsOf(org.reviewThresholds)

  const keys = [...new Set([...Object.keys(DEFAULT_KPI_THRESHOLDS), ...Object.keys(thresholds.kpis ?? {})])]
  const rows: KpiThresholdRow[] = keys.map((key) => {
    const current = thresholds.kpis?.[key] ?? DEFAULT_KPI_THRESHOLDS[key]
    return {
      key,
      label: DEFINITIONS[key]?.label ?? key,
      definition: DEFINITIONS[key]?.definition ?? "KPI definido por la organización",
      pctBps: current?.pctBps ?? null,
      minAbsCents: current?.minAbsCents ?? null,
      minPointsBps: current?.minPointsBps ?? null,
    }
  })

  return (
    <div className="space-y-6">
      <div className="space-y-1 border-b pb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Umbrales de revisión</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          A partir de cuánta variación un informe deja de sellarse como{" "}
          <strong>VALIDADO AUTOMÁTICAMENTE</strong> y pasa a <strong>REQUIERE REVISIÓN</strong> con el motivo{" "}
          <span className="font-code">VARIACION_KPI</span>. Un KPI dispara sólo si supera los <em>dos</em> umbrales: la
          variación relativa y el suelo absoluto. Los cambios quedan en la{" "}
          <Link href="/settings/audit" className="underline underline-offset-2">
            auditoría de cambios
          </Link>{" "}
          con el valor anterior y el nuevo.
        </p>
      </div>

      {!isAdmin && (
        <p className="rounded-md border p-3 text-sm text-muted-foreground">
          Sólo un administrador puede cambiar los umbrales. Aquí puedes consultarlos.
        </p>
      )}

      <ReviewThresholdsForm comparativeBasis={thresholds.comparativeBasis} rows={rows} isAdmin={isAdmin} />

      <p className="max-w-3xl text-xs text-muted-foreground">
        Hay variaciones que <strong>nunca</strong> disparan por umbral porque son estructurales (periodos con apertura,
        regularización o cierre; contra-asientos neteados con su original; meses de liquidación comparados contra la
        media trimestral) y otras que disparan <strong>siempre</strong>, sin mirar umbrales: cambio del motor
        (<span className="font-code">MOTOR_CAMBIADO</span>), redefinición de la analítica, cambio del epígrafe de una
        cuenta con movimiento y cualquier invariante en FAIL.
      </p>
    </div>
  )
}
