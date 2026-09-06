"use client"

import { ChecksPanel } from "@/components/unsorted/checks-panel"
import { DocumentNotices } from "@/components/unsorted/document-notices"
import { ProposedEntry } from "@/components/unsorted/entry-preview"
import { FieldConfidence, FieldLabel } from "@/components/unsorted/field-confidence"
import { ForceFieldDialog } from "@/components/unsorted/force-field-dialog"
import {
  DATE_EXPLANATIONS,
  DEDUCTIBILITY_LABEL,
  DOC_KIND_LABEL,
  LINE_KIND_LABEL,
  type AccountNameMap,
  type FieldOriginView,
  type ProposalFormOptions,
  type ProposalPreview,
} from "@/components/unsorted/types"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { confirmFromFormAction, previewFromFormAction, type RawProposal } from "@/app/(app)/unsorted/ui-actions"
import { MOTIVO_MIN } from "@/forms/extraction"
import { formatCents } from "@/lib/money"
import { cn } from "@/lib/utils"
import { useRouter } from "next/navigation"
import { useMemo, useState, useTransition } from "react"

/**
 * E8 · T15/T16 — Formulario de la propuesta y confirmación del asiento.
 *
 * Cuatro reglas gobiernan este componente, y ninguna es de estilo:
 *
 * 1. **El navegador no calcula ninguna cifra contable.** Los importes se
 *    teclean como texto y viajan como texto; quien los convierte a céntimos es
 *    `ui-actions.ts` en el servidor, y quien los juzga es `reconcile()`. Aquí no
 *    se suma una base ni se deriva una cuota: el cuadre que se ve viene del
 *    borrador que construyó `previewFromProposal()`.
 * 2. **Editar no modifica la extracción**: al confirmar con cambios,
 *    `confirmProposalAction` abre un run de revisión colgado del original
 *    (ADR-0014 D5). Por eso el botón dice «Confirmar» y no «Guardar».
 * 3. **`FAIL` cierra la puerta y la explica.** El botón se apaga con el motivo
 *    escrito debajo, y no hay forma de forzarlo (R6): el forzado existe para el
 *    duplicado, el `convertedTotal` y el ticket cualificado, los tres auditados.
 * 4. **Un `VIEWER` lo ve todo y no muta nada.** Ve la propuesta, las
 *    comprobaciones y el asiento propuesto —es información de auditoría— con los
 *    campos en sólo lectura y sin un solo botón de mutación.
 */

type RawLine = RawProposal["lines"][number]
type RawTax = RawProposal["taxes"][number]

/** Céntimos → texto editable en `es-ES`. Formatear no es calcular. */
const centsToText = (cents: number | null | undefined): string =>
  cents === null || cents === undefined
    ? ""
    : new Intl.NumberFormat("es-ES", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
        useGrouping: false,
      }).format(cents / 100)

function rawFromPreview(preview: ProposalPreview): RawProposal {
  const p = preview.proposal
  return {
    docKind: p.docKind,
    documentNumber: p.documentNumber ?? "",
    counterpartyName: p.counterparty.name ?? "",
    counterpartyTaxId: p.counterparty.taxId ?? "",
    documentDate: p.documentDate ?? "",
    accrualDate: p.accrualDate ?? "",
    receptionDate: p.receptionDate ?? "",
    operationDate: p.operationDate ?? "",
    currency: p.currency,
    totalText: centsToText(p.totalCents),
    paymentKey: p.paymentKey ?? "",
    description: p.description ?? "",
    lines: p.lines.map((line) => ({
      kind: line.kind,
      description: line.description ?? "",
      baseText: centsToText(line.baseCents),
      discountText: centsToText(line.discountCents ?? 0),
      taxRateCode: line.taxRateCode ?? "",
      accountCode: line.accountCode ?? "",
      deductibility: line.deductibility ?? "",
      projectId: line.projectId ?? "",
      costCenterId: line.costCenterId ?? "",
    })),
    taxes: p.taxes.map((tax) => ({
      taxRateCode: tax.taxRateCode,
      baseText: centsToText(tax.baseCents),
      quotaText: centsToText(tax.quotaCents),
      operationKey: tax.operationKey ?? "",
    })),
  }
}

export function ProposalForm({
  initialPreview,
  options,
  accountNames,
  canEdit,
  fileId,
}: {
  initialPreview: ProposalPreview
  options: ProposalFormOptions
  accountNames: AccountNameMap
  canEdit: boolean
  fileId: string
}) {
  const router = useRouter()
  const [preview, setPreview] = useState<ProposalPreview>(initialPreview)
  const [raw, setRaw] = useState<RawProposal>(() => rawFromPreview(initialPreview))
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [confirmed, setConfirmed] = useState<{ entryNumber: number; entryId: string } | null>(null)
  const [pending, startTransition] = useTransition()

  const origins = preview.fieldOrigins as Record<string, FieldOriginView | undefined>
  const originOf = (key: string): FieldOriginView | undefined => origins[key]

  const unverifiedFields = useMemo(
    () =>
      Object.entries(origins)
        .filter(([, value]) => value?.confidence === "no_verificado")
        .map(([key]) => key),
    [origins]
  )

  const patch = (change: Partial<RawProposal>) => {
    setRaw((current) => ({ ...current, ...change }))
    setDirty(true)
  }

  const patchLine = (index: number, change: Partial<RawLine>) => {
    setRaw((current) => ({
      ...current,
      lines: current.lines.map((line, i) => (i === index ? { ...line, ...change } : line)),
    }))
    setDirty(true)
  }

  const patchTax = (index: number, change: Partial<RawTax>) => {
    setRaw((current) => ({
      ...current,
      taxes: current.taxes.map((tax, i) => (i === index ? { ...tax, ...change } : tax)),
    }))
    setDirty(true)
  }

  const recalculate = () =>
    startTransition(async () => {
      setError(null)
      const state = await previewFromFormAction({ runId: preview.runId, raw })
      if (!state.success || !state.data) {
        setError(state.error ?? "No se ha podido recalcular la propuesta")
        return
      }
      setPreview(state.data)
      setDirty(false)
    })

  const confirm = () =>
    startTransition(async () => {
      setError(null)
      const state = await confirmFromFormAction({
        runId: preview.runId,
        raw,
        ...(reason.trim().length >= MOTIVO_MIN ? { forceReason: reason.trim() } : {}),
        idempotencyKey: `${preview.runId}:${preview.proposal.totalCents}:${preview.proposal.documentNumber ?? "sn"}`,
      })
      if (!state.success || !state.data) {
        setError(state.error ?? "No se ha podido contabilizar el documento")
        return
      }
      setConfirmOpen(false)
      setConfirmed({ entryNumber: state.data.entryNumber, entryId: state.data.entryId })
      router.refresh()
    })

  const blockedByFail = preview.status === "FAIL"
  const failedChecks = preview.checks.filter((c) => c.status === "FAIL")
  const partialBlocks = preview.partial && preview.runKind === "LLM"
  const needsReason = unverifiedFields.length > 0
  const readOnly = !canEdit

  return (
    <div className="space-y-6" data-testid="proposal-form" data-status={preview.status}>
      {preview.partial && (
        <div className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-3 text-sm" data-testid="partial-banner">
          <p className="font-medium">Extracción parcial</p>
          <p className="text-muted-foreground">
            El modelo vio parte del documento. Esta extracción <strong>no puede contabilizarse tal cual</strong>:
            revise y teclee las cifras, y quedará registrada como revisión humana, con los campos a nombre de quien
            los asume.
          </p>
        </div>
      )}

      {preview.runKind === "IMPORTED" && (
        <div className="rounded-md border border-dashed px-3 py-3 text-sm" data-testid="imported-banner">
          <p className="font-medium">Importado sin origen</p>
          <p className="text-muted-foreground">
            Esta propuesta procede de la memoria de análisis heredada, sin proveedor, prompt ni esquema conocidos. Se
            carga en el formulario para que no se pierda el trabajo, pero <strong>no respalda ningún asiento</strong>:
            una memoria no es fuente de cifras. Vuelva a analizar el documento o teclee las cifras.
          </p>
        </div>
      )}

      {confirmed && (
        <div className="rounded-md border px-3 py-3 text-sm" data-testid="confirmed-banner">
          Documento contabilizado en el asiento nº <span className="font-code">{confirmed.entryNumber}</span>.{" "}
          <a href={`/ledger/${confirmed.entryId}`} className="underline underline-offset-2">
            Ver el asiento
          </a>
        </div>
      )}

      {/* ── Cabecera del documento ───────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold tracking-tight">Documento</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1">
            <FieldLabel label="Tipo de documento" htmlFor="docKind" origin={originOf("docKind")} />
            <select
              id="docKind"
              className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
              value={raw.docKind}
              disabled={readOnly}
              onChange={(event) => patch({ docKind: event.target.value })}
            >
              {Object.entries(DOC_KIND_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <FieldLabel label="Número de documento" htmlFor="documentNumber" origin={originOf("documentNumber")} />
            <Input
              id="documentNumber"
              value={raw.documentNumber}
              disabled={readOnly}
              onChange={(event) => patch({ documentNumber: event.target.value })}
            />
          </div>

          <div className="space-y-1">
            <FieldLabel label="Moneda" htmlFor="currency" origin={originOf("currency")} />
            <Input
              id="currency"
              value={raw.currency}
              maxLength={3}
              disabled={readOnly}
              onChange={(event) => patch({ currency: event.target.value.toUpperCase() })}
            />
          </div>

          <div className="space-y-1">
            <FieldLabel label="Tercero" htmlFor="counterpartyName" origin={originOf("counterparty.name")} />
            <Input
              id="counterpartyName"
              value={raw.counterpartyName}
              disabled={readOnly}
              onChange={(event) => patch({ counterpartyName: event.target.value })}
            />
          </div>

          <div className="space-y-1">
            <FieldLabel
              label="NIF / identificador fiscal"
              htmlFor="counterpartyTaxId"
              origin={originOf("counterparty.taxId")}
              help="La calificación fiscal (retención, recargo, país) sale de la ficha del tercero, no del documento."
            />
            <Input
              id="counterpartyTaxId"
              value={raw.counterpartyTaxId}
              disabled={readOnly}
              onChange={(event) => patch({ counterpartyTaxId: event.target.value })}
            />
          </div>

          <div className="space-y-1">
            <FieldLabel label="Total del documento" htmlFor="totalText" origin={originOf("totalCents")} />
            <Input
              id="totalText"
              value={raw.totalText}
              disabled={readOnly}
              inputMode="decimal"
              className="text-right tabular-nums"
              onChange={(event) => patch({ totalText: event.target.value })}
              data-testid="total-input"
            />
          </div>

          {raw.docKind === "TICKET" && (
            <div className="space-y-1">
              <FieldLabel label="Medio de pago" htmlFor="paymentKey" origin={originOf("paymentKey")} />
              <select
                id="paymentKey"
                className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
                value={raw.paymentKey}
                disabled={readOnly}
                onChange={(event) => patch({ paymentKey: event.target.value })}
              >
                <option value="">Sin decidir</option>
                <option value="BANCO_DEFAULT">Banco</option>
                <option value="CAJA">Caja</option>
              </select>
            </div>
          )}
        </div>
      </section>

      {/* ── Las cuatro fechas, explicadas ────────────────────────────────── */}
      <section className="space-y-3" data-testid="dates-block">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold tracking-tight">Las cuatro fechas</h2>
          <p className="text-xs text-muted-foreground">
            Periodo de IVA: <span className="font-code" data-testid="iva-period">{preview.ivaPeriod ?? "—"}</span>
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {DATE_EXPLANATIONS.map((date) => (
            <div key={date.field} className="space-y-1" data-date-field={date.field}>
              <FieldLabel
                label={date.label}
                htmlFor={date.field}
                origin={originOf(date.field)}
                help={date.help}
              />
              <Input
                id={date.field}
                type="date"
                value={raw[date.field as keyof RawProposal] as string}
                disabled={readOnly}
                onChange={(event) => patch({ [date.field]: event.target.value } as Partial<RawProposal>)}
              />
            </div>
          ))}
        </div>
      </section>

      {/* ── Líneas ───────────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold tracking-tight">Líneas del documento</h2>
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm" data-testid="proposal-lines">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-2 py-2 text-left font-medium">Naturaleza</th>
                <th className="px-2 py-2 text-left font-medium">Concepto</th>
                <th className="px-2 py-2 text-left font-medium">Cuenta</th>
                <th className="px-2 py-2 text-left font-medium">Tipo de IVA</th>
                <th className="px-2 py-2 text-left font-medium">Deducibilidad</th>
                <th className="px-2 py-2 text-right font-medium">Base</th>
                <th className="px-2 py-2 text-left font-medium">Procedencia</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {raw.lines.map((line, index) => (
                <tr key={index} data-line-index={index}>
                  <td className="px-2 py-1">
                    <select
                      className="h-8 w-full rounded-md border bg-transparent px-1 text-xs"
                      value={line.kind}
                      disabled={readOnly}
                      onChange={(event) => patchLine(index, { kind: event.target.value })}
                      aria-label={`Naturaleza de la línea ${index + 1}`}
                    >
                      {Object.entries(LINE_KIND_LABEL).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-1">
                    <Input
                      className="h-8 text-xs"
                      value={line.description}
                      disabled={readOnly}
                      onChange={(event) => patchLine(index, { description: event.target.value })}
                      aria-label={`Concepto de la línea ${index + 1}`}
                    />
                  </td>
                  <td className="px-2 py-1">
                    <select
                      className="h-8 w-full rounded-md border bg-transparent px-1 font-code text-xs"
                      value={line.accountCode}
                      disabled={readOnly}
                      onChange={(event) => patchLine(index, { accountCode: event.target.value })}
                      aria-label={`Cuenta de la línea ${index + 1}`}
                    >
                      <option value="">Según la plantilla</option>
                      {options.accountCodes.map((account) => (
                        <option key={account.code} value={account.code}>
                          {account.code} · {account.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-1">
                    <select
                      className="h-8 w-full rounded-md border bg-transparent px-1 font-code text-xs"
                      value={line.taxRateCode}
                      disabled={readOnly}
                      onChange={(event) => patchLine(index, { taxRateCode: event.target.value })}
                      aria-label={`Tipo de IVA de la línea ${index + 1}`}
                    >
                      <option value="">Sin tipo</option>
                      {options.taxRateCodes.map((rate) => (
                        <option key={rate.code} value={rate.code}>
                          {rate.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-1">
                    <select
                      className="h-8 w-full rounded-md border bg-transparent px-1 text-xs"
                      value={line.deductibility}
                      disabled={readOnly}
                      onChange={(event) => patchLine(index, { deductibility: event.target.value })}
                      aria-label={`Deducibilidad de la línea ${index + 1}`}
                    >
                      <option value="">Sin decidir</option>
                      {Object.entries(DEDUCTIBILITY_LABEL).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-1">
                    <Input
                      className="h-8 text-right text-xs tabular-nums"
                      value={line.baseText}
                      disabled={readOnly}
                      inputMode="decimal"
                      onChange={(event) => patchLine(index, { baseText: event.target.value })}
                      aria-label={`Base de la línea ${index + 1}`}
                    />
                  </td>
                  <td className="px-2 py-1">
                    <FieldConfidence origin={originOf(`lines[${index}].baseCents`)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Impuestos: la cuota del documento es la que se contabiliza ───── */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold tracking-tight">Impuestos del documento</h2>
        <p className="text-[11px] text-muted-foreground">
          La cuota que se contabiliza es <strong>la que dice la factura</strong> (ADR-0014 D3). El recálculo del motor
          sólo la contrasta: si difieren en un céntimo, sale un aviso y el campo queda como interpretación; si difieren
          más, no hay asiento.
        </p>
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm" data-testid="proposal-taxes">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-2 py-2 text-left font-medium">Tipo</th>
                <th className="px-2 py-2 text-left font-medium">Clave de operación</th>
                <th className="px-2 py-2 text-right font-medium">Base</th>
                <th className="px-2 py-2 text-right font-medium">Cuota del documento</th>
                <th className="px-2 py-2 text-left font-medium">Procedencia</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {raw.taxes.length === 0 && (
                <tr>
                  <td className="px-2 py-3 text-muted-foreground" colSpan={5}>
                    El documento no repercute ni soporta cuota.
                  </td>
                </tr>
              )}
              {raw.taxes.map((tax, index) => (
                <tr key={index} data-tax-index={index} data-tax-code={tax.taxRateCode}>
                  <td className="px-2 py-1 font-code text-xs">{tax.taxRateCode}</td>
                  <td className="px-2 py-1 text-xs text-muted-foreground">{tax.operationKey || "GENERAL"}</td>
                  <td className="px-2 py-1">
                    <Input
                      className="h-8 text-right text-xs tabular-nums"
                      value={tax.baseText}
                      disabled={readOnly}
                      inputMode="decimal"
                      onChange={(event) => patchTax(index, { baseText: event.target.value })}
                      aria-label={`Base del tipo ${tax.taxRateCode}`}
                    />
                  </td>
                  <td className="px-2 py-1">
                    <Input
                      className="h-8 text-right text-xs tabular-nums"
                      value={tax.quotaText}
                      disabled={readOnly}
                      inputMode="decimal"
                      onChange={(event) => patchTax(index, { quotaText: event.target.value })}
                      aria-label={`Cuota del tipo ${tax.taxRateCode}`}
                    />
                  </td>
                  <td className="px-2 py-1">
                    <FieldConfidence origin={originOf(`taxes[${tax.taxRateCode}].quotaCents`)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {preview.conversion && (
        <section className="rounded-md border px-3 py-2 text-xs" data-testid="conversion-block">
          <p className="font-medium">Conversión a moneda base</p>
          <p className="text-muted-foreground">
            Tasa de {preview.conversion.rateDate} ({preview.conversion.source}), {preview.conversion.rateMicro}{" "}
            millonésimas. Total convertido:{" "}
            {formatCents(preview.conversion.convertedTotalCents, { currency: options.baseCurrency })}. La tasa la
            resuelve el servidor y queda persistida: el navegador no convierte nada.
          </p>
        </section>
      )}

      <DocumentNotices preview={preview} canEdit={canEdit} />

      <ChecksPanel checks={preview.checks} />

      <ProposedEntry
        entry={preview.asiento}
        error={preview.asientoError}
        accountNames={accountNames}
        currency={options.baseCurrency}
      />

      {/* ── Acciones ─────────────────────────────────────────────────────── */}
      <div className="sticky bottom-0 space-y-2 border-t bg-background/95 py-3 backdrop-blur">
        {error && (
          <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm" role="alert" data-testid="form-error">
            {error}
          </p>
        )}

        {dirty && (
          <p className="text-xs text-muted-foreground" data-testid="dirty-hint">
            Hay cambios sin recalcular: el veredicto y el asiento que se ven son los de la propuesta anterior.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" onClick={recalculate} disabled={pending} data-testid="recalculate">
            {pending ? "Recalculando…" : "Recalcular comprobaciones"}
          </Button>

          {canEdit && (
            <>
              <Button
                type="button"
                onClick={() => setConfirmOpen(true)}
                disabled={pending || blockedByFail || partialBlocks || preview.asiento === null}
                data-testid="confirm-proposal"
              >
                Confirmar asiento
              </Button>
              <ForceFieldDialog runId={preview.runId} fields={unverifiedFields} />
            </>
          )}
        </div>

        {(blockedByFail || partialBlocks || preview.asiento === null) && (
          <div className="text-xs text-muted-foreground" data-testid="confirm-blocked-reason">
            {blockedByFail && (
              <p>
                No se puede contabilizar: {failedChecks.map((c) => `${c.id} — ${c.message}`).join(" · ")}. Un fallo
                aritmético no se fuerza; se corrige el documento o la propuesta.
              </p>
            )}
            {!blockedByFail && partialBlocks && (
              <p>
                No se puede contabilizar desde una extracción parcial de un modelo. Revise las cifras y confirme: se
                registrará como revisión humana.
              </p>
            )}
            {!blockedByFail && !partialBlocks && preview.asiento === null && (
              <p>{preview.asientoError?.message ?? "No hay borrador de asiento que confirmar."}</p>
            )}
          </div>
        )}

        <p className="text-[11px] text-muted-foreground">
          Documento <span className="font-code">{fileId.slice(0, 8)}</span> · extracción{" "}
          <span className="font-code">{preview.runId.slice(0, 8)}</span> ·{" "}
          {preview.elegibleParaLote ? "elegible para confirmación por lote" : "exige decisión individual"}
        </p>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirmar el asiento</DialogTitle>
            <DialogDescription>
              {needsReason
                ? `Hay ${unverifiedFields.length} campo(s) sin verificar (${unverifiedFields.slice(0, 4).join(", ")}). Confirmar es asumirlos: escriba el motivo, que queda en el registro de auditoría.`
                : "Se contabilizará el borrador que se ve arriba. Si ha editado la propuesta, se registrará una revisión humana colgada de la extracción original."}
            </DialogDescription>
          </DialogHeader>
          {needsReason && (
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={`Motivo (mínimo ${MOTIVO_MIN} caracteres)`}
              rows={3}
              data-testid="confirm-reason"
            />
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirmOpen(false)}>
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={confirm}
              disabled={pending || (needsReason && reason.trim().length < MOTIVO_MIN)}
              data-testid="confirm-proposal-submit"
              className={cn(pending && "opacity-70")}
            >
              {pending ? "Contabilizando…" : "Contabilizar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
