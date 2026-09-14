"use client"

import { answerClosingStepAction, postClosingStepAction } from "@/app/(app)/ledger/closing/actions"
import { EntryPreview, type PreviewDraft } from "@/components/closing/entry-preview"
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
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { parseCents } from "@/lib/money"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import type { ClosingStepView } from "./types"

/**
 * E9 · T16 — Los dos diálogos de un paso del cierre.
 *
 * · **Responder** (pasos `DECLARADO` y `POSTERIOR`): el arqueo, las existencias,
 *   el impuesto diferido. Sin responder el paso es **WARN**, nunca PASS: no
 *   responder no es cumplir, y quien responde queda en el `AuditLog`.
 * · **Vista previa y postear** (los cuatro asientos de las órdenes 5-8 de O-17):
 *   la pantalla recoge los **parámetros** del paso —la ventana de la tasa de
 *   cierre, el caso del valor actual, el tipo del impuesto— y **jamás la cifra**:
 *   el importe del ajuste lo deriva el servidor con el motor puro y vuelve en el
 *   borrador, con su cuadre a la vista. Postear sin haber mirado la vista previa
 *   no se puede: el botón nace deshabilitado.
 *
 * Los dos son ADMIN, y las acciones lo vuelven a exigir: ocultar no es proteger.
 */

const STATUS_OPTIONS = [
  { value: "PASS", label: "PASS · comprobado y correcto" },
  { value: "WARN", label: "WARN · con salvedad" },
  { value: "FAIL", label: "FAIL · incumplido" },
  { value: "NA", label: "NA · no procede en este ejercicio" },
] as const

export function AnswerStepDialog({ fiscalYearId, step }: { fiscalYearId: string; step: ClosingStepView }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<string>(step.answer?.status ?? "PASS")
  const [note, setNote] = useState(step.answer?.note ?? "")
  const [pending, start] = useTransition()

  const submit = (): void => {
    start(async () => {
      const state = await answerClosingStepAction({ fiscalYearId, step: step.step, status, note: note.trim() || null })
      if (!state.success) {
        toast.error(state.error ?? "No se ha podido registrar la respuesta")
        return
      }
      toast.success(`Paso «${step.titulo}» respondido como ${status}`)
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} data-testid={`answer-${step.step}`}>
        Responder
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{step.titulo}</DialogTitle>
            <DialogDescription>
              {step.norma ? `${step.norma}. ` : ""}La respuesta queda firmada con su usuario en el registro de auditoría y
              recalcula el sello del cierre.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor={`status-${step.step}`}>Respuesta</Label>
              <select
                id={`status-${step.step}`}
                value={status}
                onChange={(event) => setStatus(event.target.value)}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                data-testid="answer-status"
              >
                {STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`note-${step.step}`}>Nota (opcional, 512 caracteres)</Label>
              <Textarea
                id={`note-${step.step}`}
                value={note}
                maxLength={512}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Arqueo firmado por la dirección financiera el 31-12; sin diferencias."
                data-testid="answer-note"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancelar
            </Button>
            <Button onClick={submit} disabled={pending} data-testid="answer-submit">
              {pending ? "Guardando…" : "Registrar respuesta"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Vista previa y posteo de un asiento del cierre
// ─────────────────────────────────────────────────────────────────────────────

type Params = Record<string, unknown>

type PreviewState = {
  draft: PreviewDraft
  parametros: readonly { etiqueta: string; valor: string }[]
  avisos: readonly string[]
} | null

export function PostStepDialog({ fiscalYearId, step }: { fiscalYearId: string; step: ClosingStepView }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<PreviewState>(null)
  const [pending, start] = useTransition()

  // Parámetros por paso. Ninguno es un importe contable salvo el nominal
  // aplazado, que es un dato del contrato y no una cifra derivada del diario.
  const [fxWindowDays, setFxWindowDays] = useState("7")
  const [thresholdMonths, setThresholdMonths] = useState("12")
  const [pvCase, setPvCase] = useState("A_EJERCICIO_CORRIENTE")
  const [pvSide, setPvSide] = useState("PASIVO")
  const [pvPositionAccountCode, setPvPositionAccountCode] = useState("")
  const [pvAssetAccountCode, setPvAssetAccountCode] = useState("")
  const [pvOriginAccountCode, setPvOriginAccountCode] = useState("")
  const [pvNominal, setPvNominal] = useState("")
  const [pvMonths, setPvMonths] = useState("24")
  const [taxRate, setTaxRate] = useState("25")
  const [taxPrepayments, setTaxPrepayments] = useState("")

  const params = (): Params => {
    switch (step.step) {
      case "DIFERENCIAS_DE_CAMBIO":
        return { fxWindowDays: Number(fxWindowDays) || 7 }
      case "RECLASIFICACION_VENCIMIENTOS":
        return { reclassThresholdMonths: Number(thresholdMonths) || 12 }
      case "VALOR_ACTUAL_APLAZAMIENTO":
        return {
          pvCase,
          pvSide,
          pvPositionAccountCode: pvPositionAccountCode.trim() || undefined,
          pvAssetAccountCode: pvAssetAccountCode.trim() || undefined,
          pvOriginAccountCode: pvOriginAccountCode.trim() || undefined,
          pvNominalCents: parseCents(pvNominal) ?? undefined,
          pvMonths: Number(pvMonths) || undefined,
        }
      case "IMPUESTO_BENEFICIOS":
        return {
          taxRateBps: Math.round((Number(taxRate) || 0) * 100),
          taxPrepaymentsCents: taxPrepayments.trim() === "" ? undefined : (parseCents(taxPrepayments) ?? undefined),
        }
      default:
        return {}
    }
  }

  const run = (dryRun: boolean): void => {
    start(async () => {
      const state = await postClosingStepAction({ fiscalYearId, step: step.step, dryRun, params: params() })
      if (!state.success || !state.data) {
        toast.error(state.error ?? "El paso no ha devuelto borrador")
        return
      }
      const data = state.data
      if (dryRun) {
        setPreview({
          draft: {
            entryDate: data.draft?.entryDate ?? "",
            description: data.draft?.description ?? step.titulo,
            templateCode: data.draft?.templateCode ?? step.templateCode,
            lines: (data.draft?.lines ?? []).map((line) => ({
              lineNo: line.lineNo,
              accountCode: line.accountCode ?? null,
              description: line.description ?? null,
              debitCents: line.debitCents,
              creditCents: line.creditCents,
            })),
          },
          parametros: data.parametros,
          avisos: data.avisos,
        })
        return
      }
      toast.success(`Asiento nº ${data.entryNumber ?? "—"} posteado para «${step.titulo}»`)
      setOpen(false)
      setPreview(null)
      router.refresh()
    })
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} data-testid={`post-${step.step}`}>
        Vista previa y postear
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setPreview(null)
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {step.orden ? `Asiento ${step.orden} de 12 · ` : ""}
              {step.titulo}
            </DialogTitle>
            <DialogDescription>
              {step.norma ? `${step.norma}. ` : ""}Los parámetros los fija usted; <strong>las cifras las deriva el
              servidor</strong> con el motor del cierre y se enseñan en el borrador antes de postear nada.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {step.step === "DIFERENCIAS_DE_CAMBIO" && (
              <div className="space-y-1">
                <Label htmlFor="fx-window">Ventana de búsqueda de la tasa de cierre (días naturales)</Label>
                <Input
                  id="fx-window"
                  type="number"
                  min={1}
                  max={31}
                  value={fxWindowDays}
                  onChange={(event) => setFxWindowDays(event.target.value)}
                  data-testid="fx-window"
                />
                <p className="text-xs text-muted-foreground">
                  Se usa la tasa publicada de mayor fecha ≤ corte dentro de la ventana; se sella en el asiento y se
                  enseña (O-5). Nunca se interpola.
                </p>
              </div>
            )}

            {step.step === "RECLASIFICACION_VENCIMIENTOS" && (
              <div className="space-y-1">
                <Label htmlFor="reclass-threshold">Frontera corriente / no corriente (meses)</Label>
                <Input
                  id="reclass-threshold"
                  type="number"
                  min={1}
                  max={60}
                  value={thresholdMonths}
                  onChange={(event) => setThresholdMonths(event.target.value)}
                  data-testid="reclass-threshold"
                />
                <p className="text-xs text-muted-foreground">Norma 6ª de elaboración de las cuentas anuales: doce meses.</p>
              </div>
            )}

            {step.step === "VALOR_ACTUAL_APLAZAMIENTO" && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="pv-case">Caso</Label>
                  <select
                    id="pv-case"
                    value={pvCase}
                    onChange={(event) => setPvCase(event.target.value)}
                    className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                    data-testid="pv-case"
                  >
                    <option value="A_EJERCICIO_CORRIENTE">A · inmovilizado del propio ejercicio</option>
                    <option value="C_NO_INMOVILIZADO">C · gasto o ingreso del propio ejercicio</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="pv-side">Lado</Label>
                  <select
                    id="pv-side"
                    value={pvSide}
                    onChange={(event) => setPvSide(event.target.value)}
                    className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                    data-testid="pv-side"
                  >
                    <option value="PASIVO">Pasivo · débito aplazado (523/173)</option>
                    <option value="ACTIVO">Activo · crédito aplazado (253/543)</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="pv-position">Cuenta de la posición aplazada</Label>
                  <Input
                    id="pv-position"
                    value={pvPositionAccountCode}
                    onChange={(event) => setPvPositionAccountCode(event.target.value)}
                    placeholder="173"
                    className="font-code"
                    data-testid="pv-position"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="pv-asset">Cuenta del inmovilizado / del origen</Label>
                  <Input
                    id="pv-asset"
                    value={pvCase === "A_EJERCICIO_CORRIENTE" ? pvAssetAccountCode : pvOriginAccountCode}
                    onChange={(event) =>
                      pvCase === "A_EJERCICIO_CORRIENTE"
                        ? setPvAssetAccountCode(event.target.value)
                        : setPvOriginAccountCode(event.target.value)
                    }
                    placeholder={pvCase === "A_EJERCICIO_CORRIENTE" ? "2131" : "621"}
                    className="font-code"
                    data-testid="pv-asset"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="pv-nominal">Nominal aplazado (€)</Label>
                  <Input
                    id="pv-nominal"
                    value={pvNominal}
                    onChange={(event) => setPvNominal(event.target.value)}
                    placeholder="120.000,00"
                    data-testid="pv-nominal"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="pv-months">Meses hasta el vencimiento</Label>
                  <Input
                    id="pv-months"
                    type="number"
                    min={1}
                    max={600}
                    value={pvMonths}
                    onChange={(event) => setPvMonths(event.target.value)}
                    data-testid="pv-months"
                  />
                </div>
                <p className="col-span-full text-xs text-muted-foreground">
                  El valor actual y el descuento los calcula el servidor con el tipo mensual declarado de la
                  organización (O-2) y sólo se ajusta por encima de la materialidad y de los doce meses (R-VA-1/2).
                </p>
              </div>
            )}

            {step.step === "IMPUESTO_BENEFICIOS" && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="tax-rate">Tipo de gravamen (%)</Label>
                  <Input
                    id="tax-rate"
                    value={taxRate}
                    onChange={(event) => setTaxRate(event.target.value)}
                    data-testid="tax-rate"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="tax-prepayments">Pagos fraccionados y retenciones (€)</Label>
                  <Input
                    id="tax-prepayments"
                    value={taxPrepayments}
                    onChange={(event) => setTaxPrepayments(event.target.value)}
                    placeholder="Vacío: el saldo deudor de 473"
                    data-testid="tax-prepayments"
                  />
                </div>
                <p className="col-span-full text-xs text-muted-foreground">
                  La base es el <strong>resultado contable antes de impuestos</strong>, derivado del diario. Los ajustes
                  extracontables, las bases imponibles negativas y las diferencias temporarias llegan en E10: si los
                  hay, revise la cuota antes de postear.
                </p>
              </div>
            )}

            {preview && <EntryPreview draft={preview.draft} parametros={preview.parametros} avisos={preview.avisos} />}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancelar
            </Button>
            <Button variant="outline" onClick={() => run(true)} disabled={pending} data-testid="step-dry-run">
              {pending ? "Calculando…" : "Vista previa"}
            </Button>
            <Button onClick={() => run(false)} disabled={pending || !preview} data-testid="step-post">
              Postear el asiento
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
