"use client"

import { setReviewThresholdsAction } from "@/app/(app)/reports/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

/**
 * E6 · T17 — Umbrales de revisión de la organización (**ADMIN**).
 *
 * Un KPI dispara `REQUIERE REVISIÓN` sólo si supera **los dos** umbrales:
 * la variación relativa (`pctBps`, en puntos básicos) **y** el suelo absoluto
 * (`minAbsCents`). La conjunción es lo que impide que pasar de 100 € a 300 € de
 * gastos financieros ahogue el sello en ruido — un sello que salta siempre deja
 * de significar nada, que es peor que no tenerlo.
 *
 * Los KPI que ya son un porcentaje (margen bruto) se miden en **puntos de
 * margen** (`minPointsBps`), no en variación relativa.
 */

export type KpiThresholdRow = {
  key: string
  label: string
  definition: string
  pctBps: number | null
  minAbsCents: number | null
  minPointsBps: number | null
}

const BASES = [
  { value: "SAME_PERIOD_PREVIOUS_YEAR", label: "Mismo periodo del ejercicio anterior (recomendado)" },
  { value: "PREVIOUS_FISCAL_YEAR_CLOSE", label: "Cierre del ejercicio anterior" },
  { value: "PREVIOUS_PERIOD", label: "Periodo inmediatamente anterior" },
  { value: "NONE", label: "Sin comparativo" },
] as const

const toNumber = (raw: string): number | null => {
  const trimmed = raw.trim()
  if (trimmed === "") return null
  const value = Number(trimmed)
  return Number.isFinite(value) ? Math.round(value) : null
}

export function ReviewThresholdsForm({
  comparativeBasis,
  rows,
  isAdmin,
}: {
  comparativeBasis: string
  rows: readonly KpiThresholdRow[]
  isAdmin: boolean
}) {
  const router = useRouter()
  const [basis, setBasis] = useState(comparativeBasis)
  const [draft, setDraft] = useState<Record<string, { pctBps: string; minAbsCents: string; minPointsBps: string }>>(
    Object.fromEntries(
      rows.map((row) => [
        row.key,
        {
          pctBps: row.pctBps === null ? "" : String(row.pctBps),
          minAbsCents: row.minAbsCents === null ? "" : String(row.minAbsCents),
          minPointsBps: row.minPointsBps === null ? "" : String(row.minPointsBps),
        },
      ])
    )
  )
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, startTransition] = useTransition()

  const submit = () =>
    startTransition(async () => {
      setError(null)
      setSaved(false)
      const state = await setReviewThresholdsAction({
        version: 1,
        comparativeBasis: basis,
        kpis: Object.fromEntries(
          rows.map((row) => [
            row.key,
            {
              pctBps: toNumber(draft[row.key]?.pctBps ?? ""),
              minAbsCents: toNumber(draft[row.key]?.minAbsCents ?? ""),
              minPointsBps: toNumber(draft[row.key]?.minPointsBps ?? ""),
            },
          ])
        ),
      })
      if (!state.success) {
        setError(state.error ?? "No se han podido guardar los umbrales")
        return
      }
      setSaved(true)
      router.refresh()
    })

  const cell = (key: string, field: "pctBps" | "minAbsCents" | "minPointsBps", label: string) => (
    <Input
      aria-label={`${label} de ${key}`}
      inputMode="numeric"
      className="h-8 w-28 text-right tabular-nums"
      disabled={!isAdmin}
      value={draft[key]?.[field] ?? ""}
      onChange={(event) =>
        setDraft((current) => ({
          ...current,
          [key]: { ...current[key], [field]: event.target.value },
        }))
      }
      placeholder="—"
    />
  )

  return (
    <div className="space-y-4">
      <label className="flex max-w-xl flex-col gap-1 text-sm">
        <span className="text-xs font-medium text-muted-foreground">Base de comparación</span>
        <select
          aria-label="Base de comparación"
          className="h-9 rounded-md border bg-background px-2 text-sm"
          disabled={!isAdmin}
          value={basis}
          onChange={(event) => setBasis(event.target.value)}
        >
          {BASES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-muted-foreground">
          Comparar contra el mes anterior en una empresa de proyectos genera falsos positivos sistemáticos (agosto,
          cierres de hito, liquidaciones trimestrales).
        </span>
      </label>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid="thresholds-table">
          <thead className="bg-muted/40 text-xs tracking-wide text-muted-foreground uppercase">
            <tr>
              <th className="px-3 py-2 text-left font-medium">KPI</th>
              <th className="px-3 py-2 text-right font-medium">Variación (pb)</th>
              <th className="px-3 py-2 text-right font-medium">Suelo absoluto (céntimos)</th>
              <th className="px-3 py-2 text-right font-medium">Puntos de margen (pb)</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => (
              <tr key={row.key} className="h-10" data-kpi={row.key}>
                <td className="px-3 py-1">
                  <span className="font-medium">{row.label}</span>
                  <span className="block text-[11px] text-muted-foreground">{row.definition}</span>
                </td>
                <td className="px-3 py-1 text-right">{cell(row.key, "pctBps", "Variación en puntos básicos")}</td>
                <td className="px-3 py-1 text-right">{cell(row.key, "minAbsCents", "Suelo absoluto en céntimos")}</td>
                <td className="px-3 py-1 text-right">{cell(row.key, "minPointsBps", "Puntos de margen")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {error && (
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert">
          {error}
        </p>
      )}
      {saved && <p className="text-sm text-muted-foreground">Umbrales guardados. Quedan registrados en la auditoría de cambios.</p>}

      {isAdmin && (
        <Button type="button" onClick={submit} disabled={pending} data-testid="save-thresholds">
          {pending ? "Guardando…" : "Guardar umbrales"}
        </Button>
      )}
    </div>
  )
}
