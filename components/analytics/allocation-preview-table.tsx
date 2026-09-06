"use client"

import {
  previewAllocationAction,
  sealAllocationRunAction,
} from "@/app/(app)/analytics/allocations/actions"
import {
  DRIVER_LABELS,
  FALLBACK_LABELS,
  MONTH_NAMES,
  PERIOD_LABELS,
  WARNING_LABELS,
  formatShareBps,
  periodLabelOf,
  periodRange,
} from "@/components/analytics/allocation-types"
import { AmountPlain } from "@/components/ledger/amount"
import { shortHash } from "@/components/ledger/types"
import { Button } from "@/components/ui/button"
import { ConfidenceBadge } from "@/components/ui/confidence-badge"
import { Input } from "@/components/ui/input"
import type { AllocationPreviewPayload } from "@/app/(app)/analytics/allocations/actions"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

/**
 * E5 · T12 — Simulación de la liquidación (`E5-liquidacion.md` §6).
 *
 * **Dry-run puro**: `previewAllocationAction` no escribe nada. Lo que se ve —
 * regla a regla: centro de coste fuente, saldo liquidable, base del driver,
 * receptor, cuota y nivel de margen— es EXACTAMENTE lo que se persistirá al
 * pulsar «Liquidar», porque el sellado va acompañado de los tres sellos que
 * devolvió esta simulación (`expectedHashes`). Si entre simular y sellar se
 * contabiliza un asiento del periodo, se reclasifica una línea o cambia una
 * regla, la acción responde `LIQUIDACION_DESFASADA` y **no persiste lo
 * aprobado**: obliga a volver a simular. Ese es el contrato.
 *
 * Aquí no se reparte ni se redondea nada: todos los importes llegan en céntimos
 * enteros del motor puro, con su base y su cuota en puntos básicos.
 */

const SELECT_CLASS =
  "h-8 rounded-md border border-input bg-transparent px-2 text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"

export type FiscalYearOption = { id: string; code: string; startDate: string; endDate: string }

export function AllocationPreviewPanel({
  fiscalYears,
  canSeal,
  currency,
}: {
  fiscalYears: readonly FiscalYearOption[]
  /** EDITOR o ADMIN. Un VIEWER simula pero no ve el botón de liquidar. */
  canSeal: boolean
  currency: string
}) {
  const router = useRouter()
  const first = fiscalYears[0]
  const [fiscalYearId, setFiscalYearId] = useState(first?.id ?? "")
  const [periodKind, setPeriodKind] = useState<"MONTH" | "QUARTER" | "YEAR">("YEAR")
  const [index, setIndex] = useState(0)
  const [preview, setPreview] = useState<AllocationPreviewPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [supersede, setSupersede] = useState(false)
  const [reason, setReason] = useState("")
  const [pending, startTransition] = useTransition()

  const fiscalYear = fiscalYears.find((fy) => fy.id === fiscalYearId) ?? first ?? null
  const year = fiscalYear ? Number(fiscalYear.startDate.slice(0, 4)) : new Date().getUTCFullYear()
  const range = periodRange(periodKind, year, index)
  const label = periodLabelOf(periodKind, range.start)

  const simulate = () =>
    startTransition(async () => {
      setError(null)
      setDone(null)
      const state = await previewAllocationAction({
        periodKind,
        periodStart: range.start,
        periodEnd: range.end,
      })
      if (!state.success || !state.data) {
        setPreview(null)
        setError(state.error ?? "No se ha podido simular la liquidación")
        return
      }
      setPreview(state.data)
    })

  const seal = () =>
    startTransition(async () => {
      setError(null)
      setDone(null)
      if (!preview) return
      const state = await sealAllocationRunAction({
        periodKind,
        periodStart: range.start,
        periodEnd: range.end,
        expectedHashes: preview.seals,
        supersede,
        reason: supersede ? reason.trim() : null,
      })
      if (!state.success) {
        setError(state.error ?? "No se ha podido sellar la liquidación")
        return
      }
      setDone(`Liquidación ${label} sellada: ${state.data?.lineCount ?? 0} líneas.`)
      setPreview(null)
      router.refresh()
    })

  const seals = preview?.seals ?? null
  const result = preview?.result ?? null
  const lines = result?.lines ?? []
  const balances = result?.balances ?? []
  const warnings = result?.warnings ?? []
  const residual = balances.reduce((acc, b) => acc + b.residualCents, 0)

  return (
    <section className="space-y-4" data-testid="allocation-preview">
      <div className="flex flex-wrap items-end gap-3 rounded-md border p-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Ejercicio</span>
          <select
            aria-label="Ejercicio"
            className={SELECT_CLASS}
            value={fiscalYearId}
            onChange={(event) => setFiscalYearId(event.target.value)}
          >
            {fiscalYears.map((fy) => (
              <option key={fy.id} value={fy.id}>
                {fy.code}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Periodicidad</span>
          <select
            aria-label="Periodicidad"
            className={SELECT_CLASS}
            value={periodKind}
            onChange={(event) => {
              setPeriodKind(event.target.value as "MONTH" | "QUARTER" | "YEAR")
              setIndex(0)
              setPreview(null)
            }}
            data-testid="period-kind"
          >
            {["MONTH", "QUARTER", "YEAR"].map((kind) => (
              <option key={kind} value={kind}>
                {PERIOD_LABELS[kind]}
              </option>
            ))}
          </select>
        </label>

        {periodKind !== "YEAR" && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">
              {periodKind === "MONTH" ? "Mes" : "Trimestre"}
            </span>
            <select
              aria-label={periodKind === "MONTH" ? "Mes" : "Trimestre"}
              className={SELECT_CLASS}
              value={index}
              onChange={(event) => {
                setIndex(Number(event.target.value))
                setPreview(null)
              }}
              data-testid="period-index"
            >
              {(periodKind === "MONTH" ? MONTH_NAMES : (["T1", "T2", "T3", "T4"] as const)).map((name, i) => (
                <option key={name} value={i}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Periodo</span>
          <Input className="h-8 w-40 font-code text-xs" readOnly aria-label="Periodo" value={`${range.start} → ${range.end}`} />
        </div>

        <Button type="button" size="sm" onClick={simulate} disabled={pending} data-testid="simulate">
          {pending ? "Simulando…" : "Simular"}
        </Button>
      </div>

      {error && (
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-3 text-sm" role="alert" data-testid="preview-error">
          {error}
        </p>
      )}
      {done && (
        <p className="rounded-md border px-3 py-3 text-sm" role="status" data-testid="seal-done">
          {done}
        </p>
      )}

      {result && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm">
            <div className="space-y-1">
              <p>
                Simulación de <strong data-testid="preview-period">{label}</strong> · {lines.length} línea
                {lines.length === 1 ? "" : "s"} · total repartido{" "}
                <strong>
                  <AmountPlain cents={result.totalAllocatedCents} zeroAsDash={false} /> {currency}
                </strong>
                <ConfidenceBadge
                  level="calculado"
                  className="ml-2 align-middle"
                  title="Cifras del motor puro lib/analytics/allocate.ts. No se ha persistido nada: es una simulación."
                />
              </p>
              <p className="font-code text-xs text-muted-foreground" data-testid="preview-seals">
                ledgerHash {shortHash(seals?.ledgerHash ?? "", 16)} · dimensionsHash{" "}
                {shortHash(seals?.dimensionsHash ?? "", 16)} · rulesHash {shortHash(seals?.rulesHash ?? "", 16)}
              </p>
              <p className="text-xs text-muted-foreground">
                Reglas aplicadas, en orden de ejecución:{" "}
                <span className="font-code">{result.rulesApplied.join(" → ") || "ninguna"}</span>
              </p>
            </div>
            {canSeal && (
              <div className="flex flex-col items-end gap-2">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" checked={supersede} onChange={(e) => setSupersede(e.target.checked)} data-testid="supersede-run" />
                  Sustituir la liquidación vigente de este periodo
                </label>
                {supersede && (
                  <Input
                    className="h-8 w-72"
                    aria-label="Motivo de la sustitución"
                    placeholder="Motivo de la sustitución (mínimo 10 caracteres)"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                )}
                <Button
                  type="button"
                  size="sm"
                  onClick={seal}
                  disabled={pending || lines.length === 0 || residual !== 0 || (supersede && reason.trim().length < 10)}
                  data-testid="seal-run"
                >
                  {pending ? "Liquidando…" : "Liquidar"}
                </Button>
                <span className="text-[11px] text-muted-foreground">
                  Al liquidar caducan la PyG analítica, el presupuesto vs real y el panel de este periodo. El balance,
                  la PyG contable y el cashflow no se tocan.
                </span>
              </div>
            )}
          </div>

          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm" data-testid="preview-table">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Regla</th>
                  <th className="px-3 py-2 text-left font-medium">Centro de coste fuente</th>
                  <th className="px-3 py-2 text-left font-medium">Receptor</th>
                  <th className="px-3 py-2 text-left font-medium">Nivel</th>
                  <th className="px-3 py-2 text-right font-medium">Base del driver</th>
                  <th className="px-3 py-2 text-right font-medium">Base total</th>
                  <th className="px-3 py-2 text-right font-medium">Cuota</th>
                  <th className="px-3 py-2 text-right font-medium">Importe</th>
                  <th className="px-3 py-2 text-left font-medium">Base cero</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {lines.length === 0 && (
                  <tr>
                    <td className="px-3 py-6 text-sm text-muted-foreground" colSpan={9} data-testid="preview-empty">
                      Ninguna regla reparte nada en este periodo. Puede ser que no haya reglas de esta periodicidad,
                      que su base sea cero con «no repartir y avisar», o que el centro de coste no tenga saldo.
                    </td>
                  </tr>
                )}
                {lines.map((line, i) => (
                  <tr key={`${line.ruleCode}-${line.target.code}-${i}`} className="h-8" data-preview-line={`${line.ruleCode}|${line.target.code}`}>
                    <td className="px-3 py-1 font-code text-xs">{line.ruleCode}</td>
                    <td className="px-3 py-1 font-code text-xs">{line.sourceCostCenterCode}</td>
                    <td className="px-3 py-1">
                      <span className="font-code text-xs">{line.target.code}</span>
                      <span className="ml-2 text-[11px] text-muted-foreground">
                        {line.target.kind === "PROJECT"
                          ? "proyecto"
                          : line.target.kind === "BUSINESS_LINE"
                            ? "línea de negocio"
                            : "centro de coste"}
                      </span>
                    </td>
                    <td className="px-3 py-1 font-code text-xs">{line.marginLevel}</td>
                    <td className="px-3 py-1 text-right">
                      <AmountPlain cents={line.driverBase} />
                    </td>
                    <td className="px-3 py-1 text-right text-muted-foreground">
                      <AmountPlain cents={line.driverBaseTotal} />
                    </td>
                    <td className="px-3 py-1 text-right font-code text-xs">{formatShareBps(line.driverShareBps)}</td>
                    <td className="px-3 py-1 text-right font-medium">
                      <AmountPlain cents={line.amountCents} />
                    </td>
                    <td className="px-3 py-1 text-xs text-muted-foreground">
                      {line.fallbackApplied ? (FALLBACK_LABELS[line.fallbackApplied] ?? line.fallbackApplied) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm" data-testid="preview-balances">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Centro de coste</th>
                  <th className="px-3 py-2 text-left font-medium">Nivel</th>
                  <th className="px-3 py-2 text-right font-medium">Saldo liquidable</th>
                  <th className="px-3 py-2 text-right font-medium">Declarado</th>
                  <th className="px-3 py-2 text-right font-medium">Repartido</th>
                  <th className="px-3 py-2 text-right font-medium">Residuo</th>
                  <th className="px-3 py-2 text-right font-medium">Pendiente de liquidar</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {balances.map((b) => (
                  <tr key={`${b.sourceCostCenterCode}|${b.marginLevel}`} className="h-8">
                    <td className="px-3 py-1 font-code text-xs">{b.sourceCostCenterCode}</td>
                    <td className="px-3 py-1 font-code text-xs">{b.marginLevel}</td>
                    <td className="px-3 py-1 text-right">
                      <AmountPlain cents={b.baseCents} />
                    </td>
                    <td className="px-3 py-1 text-right">
                      <AmountPlain cents={b.liquidatedCents} />
                    </td>
                    <td className="px-3 py-1 text-right">
                      <AmountPlain cents={b.allocatedCents} />
                    </td>
                    <td className="px-3 py-1 text-right" data-residual={b.residualCents}>
                      <AmountPlain cents={b.residualCents} />
                    </td>
                    <td className="px-3 py-1 text-right text-muted-foreground">
                      <AmountPlain cents={b.pendingCents} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 bg-muted/30 font-medium">
                <tr className="h-9" data-testid="preview-balance-check">
                  <td className="px-3 py-1" colSpan={6}>
                    <span className="text-muted-foreground">Σ repartido − Σ declarado (I5) = </span>
                    <span className="font-code" data-balance-difference={residual}>
                      <AmountPlain cents={residual} zeroAsDash={false} />
                    </span>
                  </td>
                  <td className="px-3 py-1 text-right">
                    {residual === 0 ? <span className="text-[#0A0A0A]">✓</span> : <span className="text-[#F5A623]">⚠</span>}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="rounded-md border p-3" data-testid="preview-warnings">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Avisos</p>
            {warnings.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">Ninguno: todas las reglas han encontrado base.</p>
            ) : (
              <ul className="mt-1 space-y-1 text-sm">
                {warnings.map((w, i) => (
                  <li key={`${w.code}-${i}`} data-warning-code={w.code}>
                    <span className="font-code text-xs">{w.code}</span> ·{" "}
                    <strong>{WARNING_LABELS[w.code] ?? w.code}</strong> · regla{" "}
                    <span className="font-code text-xs">{w.ruleCode}</span> ({w.period}): {w.detail}
                    {"fallback" in w && w.fallback ? ` · se ha aplicado: ${FALLBACK_LABELS[w.fallback] ?? w.fallback}` : ""}
                    {"targets" in w && w.targets.length > 0 ? ` · receptores: ${w.targets.join(", ")}` : ""}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[11px] text-muted-foreground">
              Los drivers de horas y plantilla se rechazan al guardar la regla: necesitan los partes de horas y las
              asignaciones de personal, que llegan en E10. Ninguna regla puede quedar inerte repartiendo 0 € en
              silencio.
            </p>
          </div>
        </>
      )}

      {!result && !error && (
        <p className="rounded-md border p-6 text-sm text-muted-foreground" data-testid="preview-idle">
          Elige un periodo y pulsa <strong>Simular</strong>. La simulación no escribe nada: es la única vía para
          liquidar, y garantiza que lo que se sella es exactamente lo que has aprobado. Drivers disponibles:{" "}
          {Object.entries(DRIVER_LABELS)
            .filter(([code]) => code !== "HOURS" && code !== "HEADCOUNT")
            .map(([, label]) => label)
            .join(" · ")}
          .
        </p>
      )}
    </section>
  )
}
