"use client"

import {
  distributeProfitAction,
  setAccountsApprovalAction,
  setTaxFilingStatusAction,
} from "@/app/(app)/ledger/closing/actions"
import { Amount } from "@/components/ledger/amount"
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
import { parseCents } from "@/lib/money"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { APPROVAL_LABEL, TAX_FILING_LABEL, type DistributionRowView, type FiscalYearView } from "./types"

/**
 * E9 · T16 — Estado societario, estado fiscal y **distribución del resultado**
 * (§7, ADR-0016 D10, O-18).
 *
 * Dos cosas que la pantalla tiene que decir bien:
 *
 * · **Al marcar APROBADAS se abre la distribución.** Sin ella, `129` se arrastra
 *   y el patrimonio neto es incorrecto desde el segundo ejercicio. La acción
 *   devuelve `requiresDistribution` y aquí se obedece.
 * · **La reserva legal no se teclea.** La calcula el motor con el capital
 *   derivado del saldo acreedor de `100` (art. 274 LSC, R2-2); el formulario ni
 *   siquiera tiene campo. Si la organización usa el capital **declarado** como
 *   contingencia, la vista previa sale con **WARN** y las dos cifras a la vista.
 */

const APPROVAL_ORDER: readonly FiscalYearView["accountsApprovalStatus"][] = [
  "BORRADOR",
  "FORMULADAS",
  "APROBADAS",
  "DEPOSITADAS",
]

const TAX_ORDER: readonly FiscalYearView["taxFilingStatus"][] = ["NO_PRESENTADO", "PRESENTADO", "RECTIFICADO"]

type Preview = {
  resultCents: number
  legalReserveCents: number
  voluntaryReserveCents: number
  carryForwardCents: number
  dividendCents: number
  interimDividendCents: number
  lossCarryForwardCents: number
  capitalStockCents: number
  capitalStockSource: "DIARIO" | "DECLARADO"
  warnings: readonly string[]
} | null

export function SocietarioPanel({
  fiscalYear,
  distribution,
  isAdmin,
}: {
  fiscalYear: FiscalYearView
  distribution: DistributionRowView | null
  isAdmin: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [approval, setApproval] = useState<string>(fiscalYear.accountsApprovalStatus)
  const [date, setDate] = useState(fiscalYear.endDate)
  const [taxStatus, setTaxStatus] = useState<string>(fiscalYear.taxFilingStatus)
  const [distributionOpen, setDistributionOpen] = useState(false)

  return (
    <section className="space-y-3" data-testid="societario">
      <h2 className="text-lg font-semibold">Estado societario y fiscal</h2>
      <p className="text-sm text-muted-foreground">
        {APPROVAL_LABEL[fiscalYear.accountsApprovalStatus]} · {TAX_FILING_LABEL[fiscalYear.taxFilingStatus]}
      </p>

      {isAdmin && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="approval-status" className="text-xs">
              Estado de las cuentas
            </Label>
            <select
              id="approval-status"
              value={approval}
              onChange={(event) => setApproval(event.target.value)}
              className="h-9 rounded-md border bg-background px-2 text-sm"
              data-testid="approval-status"
            >
              {APPROVAL_ORDER.map((status) => (
                <option key={status} value={status}>
                  {APPROVAL_LABEL[status]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="approval-date" className="text-xs">
              Fecha del acto
            </Label>
            <Input
              id="approval-date"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              className="h-9 w-40"
              data-testid="approval-date"
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            data-testid="approval-submit"
            onClick={() =>
              start(async () => {
                const state = await setAccountsApprovalAction({ fiscalYearId: fiscalYear.id, status: approval, date })
                if (!state.success) {
                  toast.error(state.error ?? "No se ha podido cambiar el estado societario")
                  return
                }
                toast.success(APPROVAL_LABEL[approval as FiscalYearView["accountsApprovalStatus"]])
                // O-18: al aprobar, la distribución deja de ser opcional.
                if (state.data?.requiresDistribution && !distribution) setDistributionOpen(true)
                router.refresh()
              })
            }
          >
            Guardar estado
          </Button>

          <div className="space-y-1">
            <Label htmlFor="tax-status" className="text-xs">
              Modelo 200
            </Label>
            <select
              id="tax-status"
              value={taxStatus}
              onChange={(event) => setTaxStatus(event.target.value)}
              className="h-9 rounded-md border bg-background px-2 text-sm"
              data-testid="tax-status"
            >
              {TAX_ORDER.map((status) => (
                <option key={status} value={status}>
                  {TAX_FILING_LABEL[status]}
                </option>
              ))}
            </select>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            data-testid="tax-status-submit"
            onClick={() =>
              start(async () => {
                const state = await setTaxFilingStatusAction({ fiscalYearId: fiscalYear.id, status: taxStatus })
                if (!state.success) {
                  toast.error(state.error ?? "No se ha podido cambiar el estado fiscal")
                  return
                }
                toast.success(TAX_FILING_LABEL[taxStatus as FiscalYearView["taxFilingStatus"]])
                router.refresh()
              })
            }
          >
            Guardar modelo 200
          </Button>
        </div>
      )}

      {distribution ? (
        <div className="rounded-md border p-3 text-sm" data-testid="distribution-done">
          <p className="font-medium">Resultado distribuido en la junta de {distribution.meetingDate}</p>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
            <Row label="Resultado" cents={distribution.resultCents} />
            <Row label="Reserva legal" cents={distribution.legalReserveCents} />
            <Row label="Reservas voluntarias" cents={distribution.voluntaryReserveCents} />
            <Row label="Remanente" cents={distribution.carryForwardCents} />
            <Row label="Dividendo" cents={distribution.dividendCents} />
          </dl>
          {distribution.entry && (
            <p className="mt-2">
              <a href={`/ledger/${distribution.entry.id}`} className="underline underline-offset-2">
                Asiento nº {distribution.entry.entryNumber ?? "—"}
              </a>
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="distribution-pending">
          El resultado del ejercicio todavía no se ha distribuido: hasta que la junta lo acuerde, el saldo de 129 se
          arrastra (arts. 273 y 274 LSC · I-E9-23).
        </p>
      )}

      {isAdmin && !distribution && (
        <DistributionDialog
          fiscalYear={fiscalYear}
          open={distributionOpen}
          onOpenChange={setDistributionOpen}
        />
      )}
    </section>
  )
}

function Row({ label, cents }: { label: string; cents: number }) {
  return (
    <div className="flex justify-between gap-3 border-b py-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>
        <Amount cents={cents} />
      </dd>
    </div>
  )
}

function DistributionDialog({
  fiscalYear,
  open,
  onOpenChange,
}: {
  fiscalYear: FiscalYearView
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [meetingDate, setMeetingDate] = useState(fiscalYear.endDate)
  const [voluntary, setVoluntary] = useState("")
  const [carryForward, setCarryForward] = useState("")
  const [dividend, setDividend] = useState("")
  const [interim, setInterim] = useState("")
  const [preview, setPreview] = useState<Preview>(null)

  const payload = (dryRun: boolean) => ({
    fiscalYearId: fiscalYear.id,
    meetingDate,
    voluntaryReserveCents: parseCents(voluntary) ?? 0,
    carryForwardCents: parseCents(carryForward) ?? 0,
    dividendCents: parseCents(dividend) ?? 0,
    interimDividendCents: parseCents(interim) ?? 0,
    dryRun,
  })

  const run = (dryRun: boolean): void => {
    start(async () => {
      const state = await distributeProfitAction(payload(dryRun))
      if (!state.success || !state.data) {
        toast.error(state.error ?? "La distribución no ha devuelto resultado")
        return
      }
      if (dryRun) {
        setPreview(state.data)
        return
      }
      toast.success("Distribución del resultado contabilizada")
      onOpenChange(false)
      router.refresh()
    })
  }

  return (
    <>
      <Button size="sm" onClick={() => onOpenChange(true)} data-testid="open-distribution">
        Distribuir el resultado
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          onOpenChange(next)
          if (!next) setPreview(null)
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Distribución del resultado de {fiscalYear.code}</DialogTitle>
            <DialogDescription>
              La junta acuerda reservas voluntarias, remanente y dividendo. La <strong>reserva legal la calcula el
              motor</strong> con el capital derivado del saldo acreedor de 100 y no es editable a la baja (art. 274
              LSC). El asiento se postea en el ejercicio abierto, con la fecha de la junta.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="meeting-date">Fecha de la junta</Label>
              <Input
                id="meeting-date"
                type="date"
                value={meetingDate}
                onChange={(event) => setMeetingDate(event.target.value)}
                data-testid="meeting-date"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="voluntary">Reservas voluntarias (€)</Label>
              <Input id="voluntary" value={voluntary} onChange={(e) => setVoluntary(e.target.value)} data-testid="voluntary" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="carry-forward">Remanente (€)</Label>
              <Input
                id="carry-forward"
                value={carryForward}
                onChange={(e) => setCarryForward(e.target.value)}
                data-testid="carry-forward"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="dividend">Dividendo (€)</Label>
              <Input id="dividend" value={dividend} onChange={(e) => setDividend(e.target.value)} data-testid="dividend" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="interim">Dividendo a cuenta ya satisfecho (€)</Label>
              <Input id="interim" value={interim} onChange={(e) => setInterim(e.target.value)} data-testid="interim" />
            </div>
          </div>

          {preview && (
            <div className="space-y-2 rounded-md border p-3" data-testid="distribution-preview">
              <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                <Row label="Resultado regularizado (129)" cents={preview.resultCents} />
                <Row label="Reserva legal calculada (112)" cents={preview.legalReserveCents} />
                <Row label="Reservas voluntarias (113)" cents={preview.voluntaryReserveCents} />
                <Row label="Remanente (120)" cents={preview.carryForwardCents} />
                <Row label="Dividendo (526)" cents={preview.dividendCents} />
                <Row label="Dividendo a cuenta (557)" cents={preview.interimDividendCents} />
                <Row label="Resultados negativos (121)" cents={preview.lossCarryForwardCents} />
                <Row label="Capital social" cents={preview.capitalStockCents} />
              </dl>
              <p className="text-xs text-muted-foreground" data-testid="capital-source">
                Capital{" "}
                {preview.capitalStockSource === "DIARIO"
                  ? "derivado del saldo acreedor de 100 en el diario"
                  : "declarado en la configuración de la organización"}
                .
              </p>
              {preview.warnings.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-xs text-[#1A202C]" data-testid="distribution-warnings">
                  {preview.warnings.map((warning) => (
                    <li key={warning}>⚠ {warning}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancelar
            </Button>
            <Button variant="outline" onClick={() => run(true)} disabled={pending} data-testid="distribution-dry-run">
              {pending ? "Calculando…" : "Vista previa"}
            </Button>
            <Button onClick={() => run(false)} disabled={pending || !preview} data-testid="distribution-submit">
              Contabilizar el acuerdo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
