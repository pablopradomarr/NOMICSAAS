"use client"

import { setAnalyticsPolicyAction, updateMarginLevelConfigAction } from "@/app/(app)/analytics/actions"
import { ANALYTIC_TYPE_LABELS, type MarginLevelRowView } from "@/components/analytics/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

/**
 * E4 · T13 — Configuración analítica de la organización (`/settings/analytics`).
 *
 * Dos cosas, las dos de ADMIN:
 *
 * 1. **Política**: `analyticsRequired` (si faltar el destino bloquea el asiento
 *    o lo rutea a `CC-NA`) y `nonAnalyticLevel` (dónde cae lo `NO_ANALITICO`
 *    que no es impuesto sobre beneficios).
 * 2. **`MarginLevelConfig` versionada**: los ocho niveles con los tipos
 *    analíticos que los componen y una fecha de vigencia. Guardar no edita la
 *    versión anterior: la cierra y abre una nueva (MLC-4), de modo que un
 *    ejercicio cerrado reimprime su PyG analítica con SU configuración.
 *
 * MLC-2: `MC3` y `EBITDA` nunca listan `INDIRECTO_CECO` — ese tipo lo rutea el
 * `marginLevel` del centro de coste, y listarlo aquí contaría el importe dos
 * veces. La casilla está deshabilitada, y el CHECK de la base lo repite.
 */

const ANALYTIC_TYPES = Object.keys(ANALYTIC_TYPE_LABELS)

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"

export function AnalyticsPolicyForm({
  analyticsRequired,
  nonAnalyticLevel,
  isAdmin,
}: {
  analyticsRequired: boolean
  nonAnalyticLevel: string
  isAdmin: boolean
}) {
  const router = useRouter()
  const [required, setRequired] = useState(analyticsRequired)
  const [level, setLevel] = useState(nonAnalyticLevel)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, startTransition] = useTransition()

  const submit = () =>
    startTransition(async () => {
      setError(null)
      setSaved(false)
      const state = await setAnalyticsPolicyAction({ analyticsRequired: required, nonAnalyticLevel: level })
      if (!state.success) {
        setError(state.error ?? "No se ha podido guardar la política analítica")
        return
      }
      setSaved(true)
      router.refresh()
    })

  return (
    <section className="space-y-3 rounded-md border p-4">
      <h2 className="text-sm font-semibold tracking-tight">Política analítica</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Destino analítico obligatorio</span>
          <select
            aria-label="Destino analítico obligatorio"
            className={SELECT_CLASS}
            disabled={!isAdmin}
            value={required ? "1" : "0"}
            onChange={(event) => setRequired(event.target.value === "1")}
          >
            <option value="1">Sí: sin destino, el asiento no se contabiliza</option>
            <option value="0">No: sin destino, la línea va al centro «Sin asignar»</option>
          </select>
          <span className="text-[11px] text-muted-foreground">
            Con «No», la Auditoría lista las líneas en `CC-NA` como aviso, con importe y recuento (R-A8).
          </span>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Nivel de lo no analítico</span>
          <select
            aria-label="Nivel de lo no analítico"
            className={SELECT_CLASS}
            disabled={!isAdmin}
            value={level}
            onChange={(event) => setLevel(event.target.value)}
          >
            <option value="EBITDA">EBITDA</option>
            <option value="EBIT">EBIT</option>
            <option value="BAI">Resultado antes de impuestos</option>
          </select>
          <span className="text-[11px] text-muted-foreground">
            El impuesto sobre beneficios (630, 633, 638) va SIEMPRE a Resultado y no es configurable (R-A11).
          </span>
        </label>
      </div>
      {error && (
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert">
          {error}
        </p>
      )}
      {saved && <p className="text-xs text-muted-foreground">Guardado. Queda en la auditoría.</p>}
      {isAdmin && (
        <Button type="button" size="sm" onClick={submit} disabled={pending} data-testid="save-analytics-policy">
          {pending ? "Guardando…" : "Guardar política"}
        </Button>
      )}
    </section>
  )
}

export function MarginConfigTable({
  levels,
  history,
  isAdmin,
  defaultValidFrom,
}: {
  levels: readonly MarginLevelRowView[]
  /** Todas las versiones, la vigente incluida, más recientes primero. */
  history: readonly MarginLevelRowView[]
  isAdmin: boolean
  defaultValidFrom: string
}) {
  const router = useRouter()
  const [rows, setRows] = useState<MarginLevelRowView[]>(() => levels.map((l) => ({ ...l, analyticTypes: [...l.analyticTypes] })))
  const [validFrom, setValidFrom] = useState(defaultValidFrom)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const toggle = (level: string, type: string) =>
    setRows((current) =>
      current.map((row) =>
        row.level === level
          ? {
              ...row,
              analyticTypes: row.analyticTypes.includes(type)
                ? row.analyticTypes.filter((t) => t !== type)
                : [...row.analyticTypes, type],
            }
          : row
      )
    )

  const submit = () =>
    startTransition(async () => {
      setError(null)
      setSaved(null)
      const state = await updateMarginLevelConfigAction({
        validFrom,
        rows: rows.map((row) => ({
          level: row.level,
          label: row.label,
          analyticTypes: row.analyticTypes,
          isVisible: row.isVisible,
        })),
      })
      if (!state.success) {
        setError(state.error ?? "No se ha podido guardar la configuración de márgenes")
        return
      }
      setSaved(`Nueva versión con vigencia desde ${validFrom} (${state.data?.versions ?? 0} niveles).`)
      router.refresh()
    })

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">Niveles de margen</h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Qué tipos analíticos componen cada nivel. Guardar <strong>no edita la versión vigente</strong>: la cierra y
            abre otra con la fecha de vigencia que indiques, para que los periodos anteriores se reimpriman con su
            propia configuración.
          </p>
        </div>
        {isAdmin && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">Vigente desde</span>
            <Input
              aria-label="Vigente desde"
              type="date"
              value={validFrom}
              onChange={(event) => setValidFrom(event.target.value)}
            />
          </label>
        )}
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" data-testid="margin-config-table">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Nivel</th>
              <th className="px-3 py-2 text-left font-medium">Etiqueta</th>
              {ANALYTIC_TYPES.map((type) => (
                <th key={type} className="px-2 py-2 text-center font-medium">
                  <span className="block max-w-[6rem] text-[10px] leading-tight normal-case">
                    {ANALYTIC_TYPE_LABELS[type]}
                  </span>
                </th>
              ))}
              <th className="px-3 py-2 text-left font-medium">Vigente desde</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => (
              <tr key={row.level} className="h-8" data-margin-level={row.level}>
                <td className="px-3 py-1 font-code text-xs">{row.level}</td>
                <td className="px-3 py-1">{row.label}</td>
                {ANALYTIC_TYPES.map((type) => {
                  // MLC-2 + los dos CHECK de §2.7: `INDIRECTO_CECO` no se lista
                  // en NINGÚN nivel, ni siquiera en MC3 o EBITDA.
                  const forbidden = type === "INDIRECTO_CECO"
                  return (
                    <td key={type} className="px-2 py-1 text-center">
                      <input
                        type="checkbox"
                        aria-label={`${ANALYTIC_TYPE_LABELS[type]} en ${row.level}`}
                        className={cn("h-3.5 w-3.5 align-middle", forbidden && "opacity-40")}
                        disabled={!isAdmin || forbidden}
                        checked={row.analyticTypes.includes(type)}
                        onChange={() => toggle(row.level, type)}
                      />
                    </td>
                  )
                })}
                <td className="px-3 py-1 font-code text-xs text-muted-foreground">{row.validFrom}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        `INDIRECTO_CECO` no se lista en ningún nivel: lo rutea el nivel de margen del propio centro de coste (MLC-2,
        R-A7). Listarlo aquí contaría el importe dos veces y la base lo rechaza.
      </p>

      {error && (
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert">
          {error}
        </p>
      )}
      {saved && <p className="text-xs text-muted-foreground">{saved}</p>}
      {isAdmin && (
        <Button type="button" size="sm" onClick={submit} disabled={pending} data-testid="save-margin-config">
          {pending ? "Guardando…" : "Guardar versión nueva"}
        </Button>
      )}

      <details className="rounded-md border p-3 text-sm">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
          Historial de versiones ({history.length})
        </summary>
        <table className="mt-2 w-full text-xs" data-testid="margin-config-history">
          <thead className="text-muted-foreground">
            <tr>
              <th className="px-2 py-1 text-left font-medium">Nivel</th>
              <th className="px-2 py-1 text-left font-medium">Vigente desde</th>
              <th className="px-2 py-1 text-left font-medium">Vigente hasta</th>
              <th className="px-2 py-1 text-left font-medium">Tipos</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {history.map((row) => (
              <tr key={`${row.level}-${row.validFrom}`}>
                <td className="px-2 py-1 font-code">{row.level}</td>
                <td className="px-2 py-1 font-code">{row.validFrom}</td>
                <td className="px-2 py-1 font-code">{row.validTo ?? "vigente"}</td>
                <td className="px-2 py-1 text-muted-foreground">
                  {row.analyticTypes.length === 0 ? "—" : row.analyticTypes.join(", ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  )
}
