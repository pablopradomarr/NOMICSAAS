"use client"

import { postTemplateFormAction, previewTemplateAction, type EntryPreview } from "@/app/(app)/ledger/ui-actions"
import { AccountCombobox } from "@/components/ledger/account-combobox"
import { Amount, AmountPlain } from "@/components/ledger/amount"
import type { AccountOption } from "@/components/ledger/types"
import { Button } from "@/components/ui/button"
import { ConfidenceBadge } from "@/components/ui/confidence-badge"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import type { FieldDescriptor, FieldNode, TemplateFormSpec } from "@/lib/ledger-ui/template-fields"
import { cn } from "@/lib/utils"
import { Trash2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

/**
 * E3 · T11 — Formulario de plantilla generado desde su schema zod.
 *
 * El descriptor (`TemplateFormSpec`) lo produce el servidor a partir del mismo
 * `schema` que valida la acción, así que la pantalla no puede desincronizarse
 * del motor. Todo viaja como **texto**: los importes se convierten a céntimos
 * en el servidor (`coerceRawInput`), nunca aquí.
 *
 * "Previsualizar" llama a `previewTemplateAction`, que construye el asiento con
 * `buildFromTemplate` + `checkDraft` y devuelve las líneas ya desglosadas —
 * incluidas las de impuesto y el reparto de prorrata— sin persistir nada.
 */

export type TaxRateOption = { code: string; label: string }

export function TemplateForm({
  spec,
  accounts,
  taxRates,
  canPost,
  defaultDate,
}: {
  spec: TemplateFormSpec
  accounts: readonly AccountOption[]
  taxRates: readonly TaxRateOption[]
  canPost: boolean
  defaultDate: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [raw, setRaw] = useState<Record<string, string>>(() => initialValues(spec, defaultDate))
  const [counts, setCounts] = useState<Record<string, number>>(() => initialCounts(spec))
  const [preview, setPreview] = useState<EntryPreview | null>(null)
  const [errors, setErrors] = useState<string[]>([])

  const set = (key: string, value: string) => {
    setRaw((current) => ({ ...current, [key]: value }))
    setPreview(null)
  }

  const runPreview = () =>
    startTransition(async () => {
      setErrors([])
      const state = await previewTemplateAction(spec.code, raw)
      if (!state.success || !state.data) {
        setPreview(null)
        setErrors(state.data?.errors ?? [state.error ?? "No se ha podido construir el asiento"])
        return
      }
      setPreview(state.data)
    })

  const post = () =>
    startTransition(async () => {
      setErrors([])
      const state = await postTemplateFormAction(spec.code, raw)
      if (!state.success || !state.data?.entryId) {
        setErrors(state.data?.errors ?? [state.error ?? "No se ha podido contabilizar el asiento"])
        return
      }
      router.push(`/ledger/${state.data.entryId}`)
      router.refresh()
    })

  return (
    <div className="space-y-5" data-testid="template-form" data-template-code={spec.code}>
      <div className="space-y-4">
        {spec.children.map((child) => (
          <NodeFields
            key={child.node === "field" ? child.field.path : child.path}
            node={child}
            prefix=""
            raw={raw}
            set={set}
            counts={counts}
            setCounts={setCounts}
            accounts={accounts}
            taxRates={taxRates}
          />
        ))}
      </div>

      {errors.length > 0 && (
        <ul
          className="list-disc space-y-1 rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-6 py-2 text-sm"
          role="alert"
          data-testid="template-errors"
        >
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}

      {preview && <PreviewTable preview={preview} />}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" onClick={runPreview} disabled={pending} data-testid="preview-entry">
          {pending ? "Calculando…" : "Previsualizar"}
        </Button>
        <Button
          type="button"
          onClick={post}
          disabled={!canPost || pending || !preview?.balanced}
          data-testid="post-template-entry"
        >
          {pending ? "Contabilizando…" : "Contabilizar"}
        </Button>
        {!canPost && <span className="text-sm text-muted-foreground">Se necesita rol EDITOR para contabilizar.</span>}
        {canPost && !preview && (
          <span className="text-sm text-muted-foreground">
            Previsualiza el asiento antes de contabilizarlo: las líneas de impuesto las calcula el servidor.
          </span>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function NodeFields({
  node,
  prefix,
  raw,
  set,
  counts,
  setCounts,
  accounts,
  taxRates,
}: {
  node: FieldNode
  prefix: string
  raw: Record<string, string>
  set: (key: string, value: string) => void
  counts: Record<string, number>
  setCounts: React.Dispatch<React.SetStateAction<Record<string, number>>>
  accounts: readonly AccountOption[]
  taxRates: readonly TaxRateOption[]
}) {
  if (node.node === "field") {
    const key = prefix === "" ? node.field.path : `${prefix}.${node.field.name}`
    return <Field field={node.field} fieldKey={key} value={raw[key] ?? ""} set={set} accounts={accounts} taxRates={taxRates} />
  }

  const name = node.path.split(".").pop() ?? node.path
  const groupKey = prefix === "" ? name : `${prefix}.${name}`
  const count = counts[groupKey] ?? node.minItems

  return (
    <fieldset className="rounded-md border p-3">
      <legend className="px-1 text-xs font-medium tracking-wide uppercase text-muted-foreground">{node.label}</legend>
      <div className="space-y-3">
        {Array.from({ length: count }, (_, index) => (
          <div key={index} className="grid gap-3 md:grid-cols-3" data-group-index={index}>
            {node.children.map((child) => (
              <NodeFields
                key={child.node === "field" ? child.field.path : child.path}
                node={child}
                prefix={`${groupKey}.${index}`}
                raw={raw}
                set={set}
                counts={counts}
                setCounts={setCounts}
                accounts={accounts}
                taxRates={taxRates}
              />
            ))}
            {node.isList && count > node.minItems && (
              <div className="flex items-end">
                <button
                  type="button"
                  aria-label={`Eliminar ${node.label} ${index + 1}`}
                  onClick={() => setCounts((current) => ({ ...current, [groupKey]: count - 1 }))}
                  className="rounded p-1 text-muted-foreground hover:bg-muted"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        ))}
        {node.isList && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setCounts((current) => ({ ...current, [groupKey]: count + 1 }))}
          >
            Añadir {node.label.toLowerCase()}
          </Button>
        )}
      </div>
    </fieldset>
  )
}

function Field({
  field,
  fieldKey,
  value,
  set,
  accounts,
  taxRates,
}: {
  field: FieldDescriptor
  fieldKey: string
  value: string
  set: (key: string, value: string) => void
  accounts: readonly AccountOption[]
  taxRates: readonly TaxRateOption[]
}) {
  const label = `${field.label}${field.optional ? "" : " *"}`

  if (field.kind === "account") {
    return (
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <AccountCombobox accounts={accounts} value={value} onChange={(code) => set(fieldKey, code)} label={field.label} />
      </label>
    )
  }

  if (field.kind === "select" || field.kind === "taxRate") {
    const options =
      field.kind === "taxRate"
        ? taxRates.map((rate) => ({ value: rate.code, label: rate.label }))
        : (field.options ?? [])
    return (
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <select
          aria-label={field.label}
          value={value}
          onChange={(event) => set(fieldKey, event.target.value)}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          <option value="">{field.optional ? "— sin especificar —" : "— elegir —"}</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    )
  }

  if (field.kind === "textarea") {
    return (
      <label className="flex flex-col gap-1 text-sm md:col-span-3">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Textarea
          aria-label={field.label}
          value={value}
          onChange={(event) => set(fieldKey, event.target.value)}
          rows={2}
          maxLength={512}
        />
      </label>
    )
  }

  const isAmount = field.kind === "amount" || field.kind === "signedAmount"
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <Input
        aria-label={field.label}
        type={field.kind === "date" ? "date" : "text"}
        inputMode={isAmount || field.kind === "integer" ? "decimal" : undefined}
        value={value}
        onChange={(event) => set(fieldKey, event.target.value)}
        placeholder={isAmount ? "0,00" : undefined}
        className={cn(isAmount && "text-right tabular-nums")}
      />
      {field.help && <span className="text-[11px] text-muted-foreground">{field.help}</span>}
    </label>
  )
}

function PreviewTable({ preview }: { preview: EntryPreview }) {
  return (
    <div className="space-y-2" data-testid="entry-preview">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Vista previa del asiento</h2>
        <ConfidenceBadge
          level="calculado"
          label="calculado por el servidor · sin contabilizar"
          title="Lo ha construido lib/ledger/templates y validado checkDraft. Todavía no se ha persistido nada."
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Fecha contable <span className="font-code">{preview.entryDate}</span>
        {preview.dateNote ? ` · ${preview.dateNote}` : ""}
      </p>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">#</th>
              <th className="px-3 py-2 text-left font-medium">Cuenta</th>
              <th className="px-3 py-2 text-left font-medium">Concepto</th>
              <th className="px-3 py-2 text-right font-medium">Debe</th>
              <th className="px-3 py-2 text-right font-medium">Haber</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {preview.lines.map((line) => (
              <tr key={line.lineNo} className="h-8">
                <td className="px-3 py-1 font-code text-xs text-muted-foreground">{line.lineNo}</td>
                <td className="px-3 py-1">
                  <span className="font-code text-xs">{line.accountCode}</span>{" "}
                  <span className="text-muted-foreground">{line.accountName}</span>
                </td>
                <td className="px-3 py-1 text-muted-foreground">{line.description ?? ""}</td>
                <td className="px-3 py-1 text-right">
                  <AmountPlain cents={line.debitCents} />
                </td>
                <td className="px-3 py-1 text-right">
                  <AmountPlain cents={line.creditCents} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 bg-muted/30 font-medium">
            <tr className="h-9">
              <td className="px-3 py-1" colSpan={3}>
                Σdebe − Σhaber
              </td>
              <td className="px-3 py-1 text-right" colSpan={2}>
                <Amount cents={preview.totalDebitCents - preview.totalCreditCents} zeroAsDash={false} />{" "}
                {preview.balanced ? "✓" : <span className="text-[#F5A623]">⚠</span>}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}

function walk(nodes: readonly FieldNode[], prefix: string, visit: (key: string, field: FieldDescriptor) => void): void {
  for (const node of nodes) {
    if (node.node === "field") {
      visit(prefix === "" ? node.field.path : `${prefix}.${node.field.name}`, node.field)
      continue
    }
    const name = node.path.split(".").pop() ?? node.path
    const groupKey = prefix === "" ? name : `${prefix}.${name}`
    for (let index = 0; index < node.minItems; index += 1) {
      walk(node.children, `${groupKey}.${index}`, visit)
    }
  }
}

function initialValues(spec: TemplateFormSpec, defaultDate: string): Record<string, string> {
  const out: Record<string, string> = {}
  walk(spec.children, "", (key, field) => {
    if (field.defaultValue !== undefined) out[key] = field.defaultValue
    else if (field.name === "documentDate") out[key] = defaultDate
  })
  return out
}

function initialCounts(spec: TemplateFormSpec): Record<string, number> {
  const out: Record<string, number> = {}
  const visit = (nodes: readonly FieldNode[], prefix: string) => {
    for (const node of nodes) {
      if (node.node === "field") continue
      const name = node.path.split(".").pop() ?? node.path
      const groupKey = prefix === "" ? name : `${prefix}.${name}`
      out[groupKey] = node.minItems
      for (let index = 0; index < node.minItems; index += 1) visit(node.children, `${groupKey}.${index}`)
    }
  }
  visit(spec.children, "")
  return out
}
