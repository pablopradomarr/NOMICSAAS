"use client"

/**
 * E10 · T15 — Editor de presupuesto **tipo hoja** (§7 del diseño).
 *
 * Filas = dimensión × cuenta × tipo analítico; columnas = los doce meses del
 * ejercicio + total. Lo que este componente hace y lo que **no**:
 *
 * · **No suma.** Los totales de fila, de mes, por nivel de margen y el general
 *   los compone el servidor (`app/(app)/analytics/budget/shared.ts`). Mientras
 *   hay cambios sin guardar, los totales se marcan «pendientes de recalcular»
 *   en vez de recalcularse en el navegador: una cifra contable de este producto
 *   no sale nunca de una suma hecha aquí.
 * · **No convierte.** El importe viaja en texto hasta `ui-actions.ts`, que lo
 *   pasa por `lib/money.parseCents`.
 * · **Sí avisa del signo en el acto** (O-E10-6): el tipo analítico exige signo,
 *   y la celda lo dice mientras se teclea. Quien decide es el servidor —y
 *   detrás el `CHECK budget_lines_sign_by_type`—, y su mensaje es el que se
 *   pinta al guardar.
 * · **Sí admite pegar desde una hoja de cálculo**: el portapapeles se reparte
 *   por tabuladores (meses) y saltos de línea (filas), tal cual, sin
 *   interpretar ningún número.
 */

import { saveBudgetCellsFromFormAction, type RawBudgetCell } from "@/app/(app)/analytics/budget/ui-actions"
import {
  EXPECTED_SIGN,
  SIGN_LABEL,
  monthLabel,
  sheetRowKey,
  BUDGET_ANALYTIC_TYPES,
  type BudgetDimensionOption,
  type BudgetSheetRow,
  type BudgetSheetView,
} from "@/components/budget/types"
import { AmountPlain } from "@/components/ledger/amount"
import { ANALYTIC_TYPE_LABELS, MARGIN_LEVEL_LABELS } from "@/components/analytics/types"
import { Button } from "@/components/ui/button"
import { ConfidenceBadge } from "@/components/ui/confidence-badge"
import { Input } from "@/components/ui/input"
import { useRouter } from "next/navigation"
import { useMemo, useState, useTransition } from "react"

const SELECT_CLASS =
  "h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"

/**
 * Céntimos → texto editable `-1234,56`. Presentación, no cálculo contable, y
 * con el menos ASCII a propósito: es el que `lib/money.parseCents` entiende
 * cuando el texto vuelve al servidor (el `−` tipográfico se queda para lo que
 * sólo se lee, `AmountPlain`).
 */
const toText = (cents: number | null): string => (cents === null ? "" : (cents / 100).toFixed(2).replace(".", ","))

/** Signo tecleado, sin interpretar la cifra. */
const typedSign = (text: string): "POSITIVO" | "NEGATIVO" | "VACIO" => {
  const clean = text.trim()
  if (clean === "") return "VACIO"
  if (clean.startsWith("-") || clean.startsWith("−")) return "NEGATIVO"
  return "POSITIVO"
}

type DraftRow = {
  key: string
  dimensionKind: "PROJECT" | "COST_CENTER"
  dimensionId: string
  dimensionCode: string
  dimensionName: string
  accountCode: string | null
  analyticType: string
}

const cellKey = (rowKey: string, month: string): string => `${rowKey}|${month}`

export function BudgetSheet({
  budgetId,
  sheet,
  dimensions,
  canEdit,
  currency,
  sealed,
}: {
  budgetId: string
  sheet: BudgetSheetView
  dimensions: readonly BudgetDimensionOption[]
  /** `EDITOR` o `ADMIN` **y** versión en borrador. */
  canEdit: boolean
  currency: string
  sealed: boolean
}) {
  const router = useRouter()
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [drafts, setDrafts] = useState<DraftRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<readonly string[]>([])
  const [pending, start] = useTransition()

  const [newDimension, setNewDimension] = useState("")
  const [newAccount, setNewAccount] = useState("")
  const [newType, setNewType] = useState<string>("COSTE_DIRECTO_MC1")

  const rows: readonly (BudgetSheetRow | DraftRow)[] = useMemo(() => [...sheet.rows, ...drafts], [sheet.rows, drafts])
  const dirty = Object.keys(edits).length > 0

  const rowOf = (row: BudgetSheetRow | DraftRow): BudgetSheetRow | null => ("cells" in row ? row : null)

  const setCell = (rowKey: string, month: string, value: string): void =>
    setEdits((current) => ({ ...current, [cellKey(rowKey, month)]: value }))

  /** Pegado desde hoja de cálculo: tabuladores = meses, saltos = filas. */
  const handlePaste = (rowIndex: number, monthIndex: number, text: string): boolean => {
    if (!text.includes("\t") && !text.includes("\n")) return false
    const lines = text.replace(/\r/g, "").split("\n").filter((line) => line.trim() !== "")
    const patch: Record<string, string> = {}
    lines.forEach((line, lineOffset) => {
      const target = rows[rowIndex + lineOffset]
      if (!target) return
      line.split("\t").forEach((value, columnOffset) => {
        const month = sheet.months[monthIndex + columnOffset]
        if (!month) return
        patch[cellKey(target.key, month)] = value.trim()
      })
    })
    setEdits((current) => ({ ...current, ...patch }))
    return true
  }

  const valueOf = (row: BudgetSheetRow | DraftRow, month: string): string => {
    const key = cellKey(row.key, month)
    if (key in edits) return edits[key]
    const stored = rowOf(row)?.cells[month]
    return toText(stored?.amountCents ?? null)
  }

  const save = () =>
    start(async () => {
      setError(null)
      setDone(null)
      setWarnings([])
      const cells: RawBudgetCell[] = []
      for (const [key, amountText] of Object.entries(edits)) {
        const separator = key.lastIndexOf("|")
        const rowKey = key.slice(0, separator)
        const month = key.slice(separator + 1)
        const row = rows.find((r) => r.key === rowKey)
        if (!row) continue
        cells.push({
          month: `${month}-01`,
          accountCode: row.accountCode,
          projectId: row.dimensionKind === "PROJECT" ? row.dimensionId : null,
          costCenterId: row.dimensionKind === "COST_CENTER" ? row.dimensionId : null,
          analyticType: row.analyticType,
          amountText,
          signException: rowOf(row)?.cells[month]?.signException ?? false,
        })
      }
      if (cells.length === 0) return
      const state = await saveBudgetCellsFromFormAction({ budgetId, cells })
      if (!state.success) {
        setError(state.error ?? "No se han podido guardar las celdas")
        return
      }
      setEdits({})
      setDrafts([])
      setWarnings((state.data?.warnings ?? []).map((w) => w.message))
      setDone(`Guardadas ${state.data?.written ?? 0} celdas. Los totales los ha recompuesto el servidor.`)
      router.refresh()
    })

  const addDraft = (): void => {
    const option = dimensions.find((d) => d.id === newDimension)
    if (!option) return
    const draft: DraftRow = {
      key: sheetRowKey({
        dimensionKind: option.kind,
        dimensionId: option.id,
        accountCode: newAccount.trim() === "" ? null : newAccount.trim(),
        analyticType: newType,
      }),
      dimensionKind: option.kind,
      dimensionId: option.id,
      dimensionCode: option.code,
      dimensionName: option.name,
      accountCode: newAccount.trim() === "" ? null : newAccount.trim(),
      analyticType: newType,
    }
    if (rows.some((r) => r.key === draft.key)) {
      setError("Esa combinación de dimensión, cuenta y tipo analítico ya está en la hoja")
      return
    }
    setError(null)
    setDrafts((current) => [...current, draft])
    setNewAccount("")
  }

  if (sheet.rows.length === 0 && drafts.length === 0 && !canEdit) {
    return (
      <p className="rounded-md border p-6 text-sm text-muted-foreground" data-testid="budget-sheet-empty">
        Esta versión no tiene ninguna celda presupuestada. Un presupuesto vacío no es un presupuesto a cero: la columna
        de presupuesto de los informes saldrá <strong>vacía con leyenda</strong> y su sello llevará{" "}
        <span className="font-code">PRESUPUESTO_AUSENTE</span>.
      </p>
    )
  }

  return (
    <section className="space-y-3" data-testid="budget-sheet">
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full min-w-[1100px] border-collapse text-xs">
          <thead className="bg-muted/40">
            <tr className="[&>th]:px-2 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
              <th>Nivel</th>
              <th>Dimensión</th>
              <th>Cuenta</th>
              <th>Tipo analítico</th>
              <th>Signo</th>
              {sheet.months.map((month) => (
                <th key={month} className="text-right whitespace-nowrap">
                  {monthLabel(month)}
                </th>
              ))}
              <th className="text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => {
              const stored = rowOf(row)
              const expected = EXPECTED_SIGN[row.analyticType] ?? "LIBRE"
              return (
                <tr key={row.key} className="border-t [&>td]:px-2 [&>td]:py-1" data-row-key={row.key}>
                  <td className="whitespace-nowrap text-muted-foreground">
                    {stored ? (MARGIN_LEVEL_LABELS[stored.marginLevel] ?? stored.marginLevel) : "—"}
                  </td>
                  <td className="whitespace-nowrap">
                    <span className="font-code">{row.dimensionCode}</span>
                    {row.dimensionName && <span className="ml-1 text-muted-foreground">{row.dimensionName}</span>}
                  </td>
                  <td className="font-code whitespace-nowrap">{row.accountCode ?? "—"}</td>
                  <td className="whitespace-nowrap text-muted-foreground">
                    {ANALYTIC_TYPE_LABELS[row.analyticType] ?? row.analyticType}
                  </td>
                  <td className="whitespace-nowrap" data-expected-sign={expected}>
                    {SIGN_LABEL[expected]}
                  </td>
                  {sheet.months.map((month, monthIndex) => {
                    const key = cellKey(row.key, month)
                    const text = valueOf(row, month)
                    const wrongSign =
                      (expected === "POSITIVO" && typedSign(text) === "NEGATIVO") ||
                      (expected === "NEGATIVO" && typedSign(text) === "POSITIVO")
                    const issue = stored?.signIssues.find((s) => s.month === month) ?? null
                    if (!canEdit) {
                      return (
                        <td key={month} className="text-right">
                          <AmountPlain cents={stored?.cells[month]?.amountCents ?? 0} />
                        </td>
                      )
                    }
                    return (
                      <td key={month} className="text-right">
                        <Input
                          aria-label={`${row.dimensionCode} ${row.accountCode ?? "sin cuenta"} ${monthLabel(month)}`}
                          className={`h-7 w-24 text-right font-code text-xs tabular-nums ${
                            wrongSign ? "border-[#F5A623]" : ""
                          } ${key in edits ? "bg-[#EDF2F7]" : ""}`}
                          value={text}
                          data-cell={key}
                          data-sign-warning={wrongSign || issue !== null ? "1" : undefined}
                          title={issue?.message ?? (wrongSign ? `Este tipo analítico exige ${SIGN_LABEL[expected]}` : undefined)}
                          onChange={(event) => setCell(row.key, month, event.target.value)}
                          onPaste={(event) => {
                            const text = event.clipboardData.getData("text")
                            if (handlePaste(rowIndex, monthIndex, text)) event.preventDefault()
                          }}
                        />
                      </td>
                    )
                  })}
                  <td className="text-right font-code">
                    {stored ? <AmountPlain cents={stored.totalCents} /> : <span className="text-muted-foreground">—</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
          <tfoot className="border-t-2 bg-muted/30">
            <tr className="[&>td]:px-2 [&>td]:py-2 [&>td]:font-medium">
              <td colSpan={5}>Total del presupuesto (compuesto en el servidor)</td>
              {sheet.months.map((month) => (
                <td key={month} className="text-right font-code" data-month-total={month}>
                  <AmountPlain cents={sheet.monthTotalsCents[month] ?? 0} />
                </td>
              ))}
              <td className="text-right font-code" data-testid="budget-total">
                <AmountPlain cents={sheet.totalCents} />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span>
          Moneda base {currency}. Importes en <strong>aporte</strong>: el ingreso presupuestado es positivo y el gasto
          negativo (ADR-0018 D2). Los ceros se pintan <span className="font-code">—</span>.
        </span>
        {dirty && (
          <span
            className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-2 py-1"
            role="status"
            data-testid="budget-dirty"
          >
            Hay cambios sin guardar: los totales de arriba son los de la última versión guardada y no se recalculan en
            el navegador.
            <ConfidenceBadge level="calculado" className="ml-2 align-middle" title="Aviso del formulario." />
          </span>
        )}
      </div>

      {sheet.levelTotalsCents.length > 0 && (
        <div className="overflow-x-auto rounded-md border" data-testid="budget-level-totals">
          <table className="w-full border-collapse text-xs">
            <thead className="bg-muted/40">
              <tr className="[&>th]:px-2 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
                <th>Nivel de margen</th>
                <th className="text-right">Presupuesto del ejercicio</th>
              </tr>
            </thead>
            <tbody>
              {sheet.levelTotalsCents.map((level) => (
                <tr key={level.level} className="border-t [&>td]:px-2 [&>td]:py-1">
                  <td>{MARGIN_LEVEL_LABELS[level.level] ?? level.level}</td>
                  <td className="text-right font-code" data-level-total={level.level}>
                    <AmountPlain cents={level.cents} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {sheet.unresolved.length > 0 && (
        <div className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 p-3 text-xs" data-testid="budget-unresolved">
          <p className="font-medium">Celdas que la matriz no ha podido situar</p>
          <ul className="mt-1 space-y-1">
            {sheet.unresolved.map((item, index) => (
              <li key={`${item.month}-${item.dimensionCode}-${index}`}>
                <span className="font-code">{item.code}</span> · {item.month} · {item.dimensionCode}: {item.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {canEdit && (
        <div className="flex flex-wrap items-end gap-3 rounded-md border p-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">Dimensión</span>
            <select
              aria-label="Dimensión de la fila nueva"
              className={SELECT_CLASS}
              value={newDimension}
              onChange={(event) => setNewDimension(event.target.value)}
              data-testid="new-row-dimension"
            >
              <option value="">Elige proyecto o centro de coste…</option>
              {dimensions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.kind === "PROJECT" ? "Proyecto" : "CECO"} · {option.code} · {option.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">Cuenta (opcional)</span>
            <Input
              className="h-8 w-28 font-code text-xs"
              aria-label="Cuenta de la fila nueva"
              value={newAccount}
              placeholder="6400"
              onChange={(event) => setNewAccount(event.target.value)}
              data-testid="new-row-account"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">Tipo analítico</span>
            <select
              aria-label="Tipo analítico de la fila nueva"
              className={SELECT_CLASS}
              value={newType}
              onChange={(event) => setNewType(event.target.value)}
              data-testid="new-row-type"
            >
              {BUDGET_ANALYTIC_TYPES.map((type) => (
                <option key={type} value={type}>
                  {ANALYTIC_TYPE_LABELS[type] ?? type} ({SIGN_LABEL[EXPECTED_SIGN[type] ?? "LIBRE"]})
                </option>
              ))}
            </select>
          </label>
          <Button type="button" variant="outline" size="sm" onClick={addDraft} data-testid="add-budget-row">
            Añadir fila
          </Button>
          <Button type="button" size="sm" onClick={save} disabled={pending || !dirty} data-testid="save-budget-cells">
            {pending ? "Guardando…" : "Guardar cambios"}
          </Button>
        </div>
      )}

      {sealed && (
        <p className="rounded-md border p-3 text-xs text-muted-foreground" data-testid="budget-sealed-note">
          Esta versión está <strong>sellada</strong>: no se edita. Para cambiarla se crea una revisión, que deja las dos
          versiones enteras y su diff a la vista. Sustituir, no corregir.
        </p>
      )}

      {error && (
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert" data-testid="budget-sheet-error">
          {error}
        </p>
      )}
      {warnings.length > 0 && (
        <ul className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-xs" data-testid="budget-sign-warnings">
          {warnings.map((message, index) => (
            <li key={index}>{message}</li>
          ))}
        </ul>
      )}
      {done && (
        <p className="rounded-md border px-3 py-2 text-sm" role="status" data-testid="budget-sheet-done">
          {done}
        </p>
      )}
    </section>
  )
}
