"use client"

import { postManualEntryAction } from "@/app/(app)/ledger/actions"
import { DimensionCombobox, EMPTY_DIMENSION, type DimensionValue } from "@/components/analytics/dimension-combobox"
import type { DimensionOption } from "@/components/analytics/types"
import { AccountCombobox } from "@/components/ledger/account-combobox"
import { Amount } from "@/components/ledger/amount"
import type { AccountOption } from "@/components/ledger/types"
import { Button } from "@/components/ui/button"
import { ConfidenceBadge } from "@/components/ui/confidence-badge"
import { Input } from "@/components/ui/input"
import { parseCents } from "@/lib/money"
import { cn } from "@/lib/utils"
import { Trash2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

/**
 * E3 · T11 — Asiento manual en modo libre (T-20, diseño §6).
 *
 * Tabla editable Debe/Haber con autocompletado de cuenta. La fila de diferencia
 * `Σdebe − Σhaber` está **siempre visible** y va marcada como *vista previa*:
 * es feedback de pantalla, no una cifra contable. Los totales buenos son los
 * que devuelve el servidor tras contabilizar (`postManualEntryAction` →
 * `buildEntry` → `checkDraft` → constraint trigger de la base).
 *
 * Por eso "Contabilizar" se deshabilita con diferencia ≠ 0 **y** el servidor
 * vuelve a comprobarlo: ocultar no es proteger.
 */

type DraftRow = {
  key: string
  accountCode: string
  debit: string
  credit: string
  description: string
  dueDate: string
  /** E4 · T15 — destino analítico de la línea: proyecto XOR centro de coste. */
  dimension: DimensionValue
}

const emptyRow = (): DraftRow => ({
  key: Math.random().toString(36).slice(2),
  accountCode: "",
  debit: "",
  credit: "",
  description: "",
  dueDate: "",
  dimension: EMPTY_DIMENSION,
})

/** Cuentas con vencimiento: 40x, 41x, 43x, 44x, 47x (`ui-erp` §Formularios). */
const wantsDueDate = (code: string) => /^(40|41|43|44|47)/.test(code)

/**
 * E4 · R-A1 — sólo las cuentas de grupo 6 y 7 llevan destino analítico. Fuera
 * de ahí el selector va deshabilitado y en gris; la base lo repite con el CHECK
 * `journal_lines_analytics_only_pnl`.
 */
const wantsDimension = (code: string) => /^[67]/.test(code)

export function ManualEntryForm({
  accounts,
  canPost,
  defaultDate,
  dimensions = [],
  analyticsRequired = false,
}: {
  accounts: readonly AccountOption[]
  canPost: boolean
  defaultDate: string
  /** Proyectos y centros de coste activos del tenant. */
  dimensions?: readonly DimensionOption[]
  /** Con `true`, faltar el destino en una línea 6/7 bloquea el asiento (C-9). */
  analyticsRequired?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [description, setDescription] = useState("")
  const [documentDate, setDocumentDate] = useState(defaultDate)
  const [accrualDate, setAccrualDate] = useState("")
  const [rows, setRows] = useState<DraftRow[]>([emptyRow(), emptyRow()])
  const [error, setError] = useState<string | null>(null)
  const [lineErrors, setLineErrors] = useState<Record<number, string>>({})
  /**
   * #8 · clave de idempotencia del formulario: se genera al MONTAR y se reenvía
   * en cada intento, de modo que un doble clic no contabiliza dos asientos. Al
   * fallar la validación se REGENERA: lo que se envía después ya es otro
   * asiento y reutilizar la clave devolvería el anterior.
   */
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => crypto.randomUUID())

  const update = (key: string, patch: Partial<DraftRow>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)))

  // ── VISTA PREVIA ────────────────────────────────────────────────────────────
  // Lo único que el navegador suma. No es la cifra del asiento: es el aviso que
  // evita mandar al servidor un asiento que se sabe descuadrado.
  const previewDebit = rows.reduce((acc, row) => acc + (parseCents(row.debit) ?? 0), 0)
  const previewCredit = rows.reduce((acc, row) => acc + (parseCents(row.credit) ?? 0), 0)
  const previewDifference = previewDebit - previewCredit

  const filled = rows.filter((row) => row.accountCode !== "" && (row.debit !== "" || row.credit !== ""))
  const bothSides =
    filled.some((row) => (parseCents(row.debit) ?? 0) > 0) && filled.some((row) => (parseCents(row.credit) ?? 0) > 0)
  /**
   * Sólo aviso de pantalla (C-9 lo impone el servidor): una línea 6/7 sin
   * destino con `analyticsRequired` no se va a poder contabilizar.
   */
  const missingDimension = analyticsRequired
    ? filled.filter(
        (row) =>
          wantsDimension(row.accountCode) &&
          row.dimension.projectId === null &&
          row.dimension.costCenterId === null
      )
    : []

  /**
   * El destino analítico NO deshabilita "Contabilizar": C-9 la impone
   * `validateAnalytics` en el servidor, que además sabe si la organización
   * rutea a `CC-NA` en vez de bloquear. Aquí sólo se avisa —campo marcado en
   * ámbar y nota bajo el botón— y el error de la línea se enseña tal y como lo
   * devuelve el servidor. Deshabilitar por una regla que el cliente no puede
   * evaluar del todo sería adivinar.
   */
  const readyToPost =
    canPost && description.trim().length > 0 && filled.length >= 2 && bothSides && previewDifference === 0

  const reason = !canPost
    ? "Se necesita rol EDITOR para contabilizar."
    : description.trim() === ""
      ? "Falta el concepto del asiento."
      : filled.length < 2
        ? "Un asiento tiene al menos dos líneas con cuenta e importe."
        : !bothSides
          ? "Falta contrapartida: hace falta al menos una línea al Debe y otra al Haber (C-4)."
          : previewDifference !== 0
            ? "El asiento está descuadrado: Σdebe − Σhaber debe ser 0,00 € (C-1)."
            : missingDimension.length > 0
              ? "Aviso: falta el destino analítico en una línea de grupo 6/7 y esta organización lo exige (C-9). El servidor lo comprobará al contabilizar."
              : null

  const submit = () => {
    setError(null)
    setLineErrors({})
    startTransition(async () => {
      const state = await postManualEntryAction({
        idempotencyKey,
        description: description.trim(),
        documentDate: documentDate || undefined,
        accrualDate: accrualDate || undefined,
        lines: filled.map((row) => ({
          accountCode: row.accountCode,
          debit: row.debit,
          credit: row.credit,
          description: row.description || undefined,
          dueDate: row.dueDate || undefined,
          projectId: wantsDimension(row.accountCode) ? row.dimension.projectId : null,
          costCenterId: wantsDimension(row.accountCode) ? row.dimension.costCenterId : null,
        })),
      })
      if (!state.success) {
        setError(state.error ?? "No se ha podido contabilizar el asiento")
        if (state.data?.lineErrors) setLineErrors(state.data.lineErrors)
        setIdempotencyKey(crypto.randomUUID())
        return
      }
      router.push(state.data?.entryId ? `/ledger/${state.data.entryId}` : "/ledger")
      router.refresh()
    })
  }

  return (
    <div className="space-y-4" data-testid="manual-entry-form">
      <div className="grid gap-3 md:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm md:col-span-3">
          <span className="text-xs font-medium text-muted-foreground">Concepto</span>
          <Input
            aria-label="Concepto del asiento"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={512}
            placeholder="Ventas del mes de marzo"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Fecha del documento</span>
          <Input
            aria-label="Fecha del documento"
            type="date"
            value={documentDate}
            onChange={(event) => setDocumentDate(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Fecha de devengo (opcional)</span>
          <Input
            aria-label="Fecha de devengo"
            type="date"
            value={accrualDate}
            onChange={(event) => setAccrualDate(event.target.value)}
          />
        </label>
        <p className="self-end text-xs text-muted-foreground md:col-span-1">
          La <strong>fecha contable</strong> la decide el servidor: si el mes está bloqueado, el asiento se desplaza al
          primer mes abierto y se anota el devengo en el concepto.
        </p>
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="w-10 px-2 py-2 text-left font-medium">#</th>
              <th className="px-3 py-2 text-left font-medium">Cuenta</th>
              <th className="px-3 py-2 text-left font-medium">Concepto de la línea</th>
              <th className="w-32 px-3 py-2 text-right font-medium">Debe</th>
              <th className="w-32 px-3 py-2 text-right font-medium">Haber</th>
              <th className="w-56 px-3 py-2 text-left font-medium">
                Destino analítico{analyticsRequired ? " *" : ""}
              </th>
              <th className="w-36 px-3 py-2 text-left font-medium">Vencimiento</th>
              <th className="w-10 px-2 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row, index) => (
              <tr key={row.key} className="h-9" data-row-index={index + 1}>
                <td className="px-2 py-1 font-code text-xs text-muted-foreground">{index + 1}</td>
                <td className="px-3 py-1">
                  <AccountCombobox
                    accounts={accounts}
                    value={row.accountCode}
                    onChange={(code) => update(row.key, { accountCode: code })}
                    label={`Cuenta de la línea ${index + 1}`}
                    invalid={Boolean(lineErrors[index + 1])}
                  />
                </td>
                <td className="px-3 py-1">
                  <Input
                    aria-label={`Concepto de la línea ${index + 1}`}
                    className="h-8 text-xs"
                    value={row.description}
                    onChange={(event) => update(row.key, { description: event.target.value })}
                    maxLength={512}
                  />
                </td>
                <td className="px-3 py-1">
                  <Input
                    aria-label={`Debe de la línea ${index + 1}`}
                    inputMode="decimal"
                    className="h-8 text-right tabular-nums text-xs"
                    value={row.debit}
                    onChange={(event) => update(row.key, { debit: event.target.value, credit: "" })}
                    placeholder="0,00"
                  />
                </td>
                <td className="px-3 py-1">
                  <Input
                    aria-label={`Haber de la línea ${index + 1}`}
                    inputMode="decimal"
                    className="h-8 text-right tabular-nums text-xs"
                    value={row.credit}
                    onChange={(event) => update(row.key, { credit: event.target.value, debit: "" })}
                    placeholder="0,00"
                  />
                </td>
                <td className="px-3 py-1">
                  {wantsDimension(row.accountCode) ? (
                    <DimensionCombobox
                      options={dimensions}
                      value={row.dimension}
                      onChange={(dimension) => update(row.key, { dimension })}
                      label={`Destino analítico de la línea ${index + 1}`}
                      required={analyticsRequired}
                      invalid={
                        analyticsRequired &&
                        row.dimension.projectId === null &&
                        row.dimension.costCenterId === null
                      }
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground" title="Sólo las cuentas 6 y 7 llevan destino (R-A1)">
                      —
                    </span>
                  )}
                </td>
                <td className="px-3 py-1">
                  {wantsDueDate(row.accountCode) ? (
                    <Input
                      aria-label={`Vencimiento de la línea ${index + 1}`}
                      type="date"
                      className="h-8 text-xs"
                      value={row.dueDate}
                      onChange={(event) => update(row.key, { dueDate: event.target.value })}
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-2 py-1">
                  <button
                    type="button"
                    aria-label={`Eliminar la línea ${index + 1}`}
                    disabled={rows.length <= 2}
                    onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                    className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-40"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 bg-muted/30">
            <tr className="h-9" data-testid="preview-totals">
              <td className="px-2 py-1" colSpan={3}>
                <span className="text-muted-foreground">Sumas</span>{" "}
                {/* #14: la fila de totales la calcula el NAVEGADOR. Decirlo evita
                    que alguien la lea como cifra contable antes de contabilizar. */}
                <span className="text-xs text-muted-foreground" data-testid="preview-label">
                  previsualización (no contabilizado)
                </span>
              </td>
              <td className="px-3 py-1 text-right font-medium">
                <Amount cents={previewDebit} zeroAsDash={false} />
              </td>
              <td className="px-3 py-1 text-right font-medium">
                <Amount cents={previewCredit} zeroAsDash={false} />
              </td>
              <td className="px-3 py-1" colSpan={3} />
            </tr>
            <tr className="h-10 border-t" data-testid="preview-difference">
              <td className="px-2 py-1" colSpan={3}>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Σdebe − Σhaber</span>
                  <ConfidenceBadge
                    level="calculado"
                    label="vista previa · interpretación, no cifra contable"
                    title="Lo calcula el navegador sólo para avisar. La cifra contable es la que devuelve el servidor al contabilizar."
                  />
                </div>
              </td>
              <td className="px-3 py-1 text-right font-semibold" colSpan={2}>
                <span
                  className={cn("font-code", previewDifference !== 0 && "text-[#F5A623]")}
                  data-difference-cents={previewDifference}
                >
                  <Amount cents={previewDifference} zeroAsDash={false} />
                </span>
              </td>
              <td className="px-3 py-1" colSpan={3}>
                {previewDifference === 0 ? (
                  <span className="text-xs">✓ cuadrado</span>
                ) : (
                  <span className="text-xs text-[#F5A623]">⚠ descuadrado</span>
                )}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={() => setRows((current) => [...current, emptyRow()])}>
          Añadir línea
        </Button>
        <Button type="button" onClick={submit} disabled={!readyToPost || pending} data-testid="post-entry">
          {pending ? "Contabilizando…" : "Contabilizar"}
        </Button>
        {reason && (
          <span className="text-sm text-muted-foreground" data-testid="post-disabled-reason">
            {reason}
          </span>
        )}
      </div>

      {error && (
        <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert">
          {error}
        </p>
      )}
      {Object.keys(lineErrors).length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {Object.entries(lineErrors).map(([lineNo, message]) => (
            <li key={lineNo}>
              Línea {lineNo}: {message}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
