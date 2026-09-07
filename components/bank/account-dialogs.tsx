"use client"

import { createBankAccountAction, importStatementAction, updateBankAccountAction } from "@/app/(app)/audit/actions"
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
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import type { BankAccountView } from "./types"

/**
 * E7 · T16 — Alta de cuenta bancaria con **anclaje**, mapeo CSV e importación
 * con vista previa (`docs/design/E7-auditoria.md` §6).
 *
 * El **anclaje** son dos datos que van juntos o no van: la fecha desde la que la
 * cuenta está conciliada y el saldo del extracto ese día. Sin él, I-E7-1 sale
 * **INFO** —nunca PASS— y el badge `✓ validado contra fuente` no se concede. Al
 * darla de alta, el servidor coteja ese saldo contra el saldo contable de la
 * subcuenta y devuelve `anchorDiffCents`: **la pantalla lo enseña siempre**, sea
 * cero o no. Una diferencia de anclaje escondida es una diferencia que reaparece
 * en el primer cierre.
 */

const centsFromInput = (value: string): number | null => {
  const clean = value.trim().replace(/\s/g, "").replace(/\./g, "").replace(",", ".")
  if (clean === "") return null
  const parsed = Number(clean)
  if (!Number.isFinite(parsed)) return null
  return Math.round(parsed * 100)
}

export function NewBankAccountDialog() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [form, setForm] = useState({
    code: "",
    name: "",
    accountCode: "5720000",
    currency: "EUR",
    iban: "",
    matchToleranceDays: "3",
    transitWarnDays: "90",
    anchorDate: "",
    anchorBalance: "",
  })
  const [anchorDiff, setAnchorDiff] = useState<number | null>(null)

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }))

  const submit = (): void => {
    start(async () => {
      const anchorBalanceCents = centsFromInput(form.anchorBalance)
      const state = await createBankAccountAction({
        code: form.code,
        name: form.name,
        accountCode: form.accountCode,
        currency: form.currency,
        iban: form.iban || null,
        matchToleranceDays: Number(form.matchToleranceDays) || 3,
        transitWarnDays: Number(form.transitWarnDays) || 90,
        reconciledFromDate: form.anchorDate || null,
        reconciledOpeningBalanceCents: form.anchorDate ? anchorBalanceCents : null,
      })
      if (!state.success || !state.data) {
        toast.error(state.success ? "El alta no ha devuelto resultado" : state.error)
        return
      }
      setAnchorDiff(state.data.anchorDiffCents)
      toast.success("Cuenta bancaria dada de alta")
      router.refresh()
    })
  }

  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)} data-testid="open-new-bank-account">
        Nueva cuenta bancaria
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Nueva cuenta bancaria</DialogTitle>
            <DialogDescription>
              Sólo se concilian las cuentas 572, 573, 574 y 575 (y sus subcuentas): la caja no tiene extracto y no puede
              tenerlo. El <strong>anclaje</strong> son las dos cosas —fecha y saldo del extracto ese día—: sin él el
              cuadre no puede dar PASS, sólo INFO.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="ba-code">Código</Label>
              <Input id="ba-code" value={form.code} onChange={set("code")} data-testid="ba-code" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ba-name">Nombre</Label>
              <Input id="ba-name" value={form.name} onChange={set("name")} data-testid="ba-name" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ba-account">Subcuenta contable (57x)</Label>
              <Input id="ba-account" value={form.accountCode} onChange={set("accountCode")} data-testid="ba-account" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ba-currency">Divisa</Label>
              <Input id="ba-currency" value={form.currency} onChange={set("currency")} maxLength={3} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ba-iban">IBAN</Label>
              <Input id="ba-iban" value={form.iban} onChange={set("iban")} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ba-tolerance">Tolerancia de fechas (días)</Label>
              <Input id="ba-tolerance" value={form.matchToleranceDays} onChange={set("matchToleranceDays")} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ba-transit">Plazo de partida en tránsito (días)</Label>
              <Input id="ba-transit" value={form.transitWarnDays} onChange={set("transitWarnDays")} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ba-anchor-date">Conciliada desde</Label>
              <Input id="ba-anchor-date" type="date" value={form.anchorDate} onChange={set("anchorDate")} data-testid="ba-anchor-date" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ba-anchor-balance">Saldo del extracto ese día</Label>
              <Input
                id="ba-anchor-balance"
                value={form.anchorBalance}
                onChange={set("anchorBalance")}
                placeholder="1.234,56"
                data-testid="ba-anchor-balance"
              />
            </div>
          </div>

          {anchorDiff !== null && (
            <div
              className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm"
              role="status"
              data-testid="anchor-diff"
              data-cents={anchorDiff}
            >
              Diferencia del anclaje contra el saldo contable de la subcuenta:{" "}
              <Amount cents={anchorDiff} zeroAsDash={false} />.{" "}
              {anchorDiff === 0
                ? "El anclaje cuadra con los libros."
                : "No cuadra: hasta que se explique, el cuadre arrastrará esta diferencia."}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cerrar
            </Button>
            <Button type="button" onClick={submit} disabled={pending} data-testid="submit-bank-account">
              {pending ? "Guardando…" : "Dar de alta"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Mapeo CSV de un banco y anclaje: mover el anclaje **exige motivo**. */
export function EditBankAccountDialog({ account }: { account: BankAccountView }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [anchorDate, setAnchorDate] = useState(account.anchorDate ?? "")
  const [anchorBalance, setAnchorBalance] = useState(
    account.anchorBalanceCents === null ? "" : (account.anchorBalanceCents / 100).toFixed(2).replace(".", ",")
  )
  const [reason, setReason] = useState("")
  const [mapping, setMapping] = useState(
    JSON.stringify(
      {
        delimiter: ";",
        decimal: ",",
        dateFormat: "dd/MM/yyyy",
        signMode: "SIGNED",
        skipRows: 1,
        columns: { operationDate: 0, valueDate: 1, description: 2, amount: 3, reference1: 4 },
      },
      null,
      2
    )
  )

  const submit = (): void => {
    start(async () => {
      let parsedMapping: unknown = undefined
      if (mapping.trim() !== "") {
        try {
          parsedMapping = JSON.parse(mapping)
        } catch {
          toast.error("El mapeo CSV no es un JSON válido")
          return
        }
      }
      const state = await updateBankAccountAction({
        id: account.id,
        matchToleranceDays: account.matchToleranceDays,
        transitWarnDays: account.transitWarnDays,
        reconciledFromDate: anchorDate || null,
        reconciledOpeningBalanceCents: anchorDate ? centsFromInput(anchorBalance) : null,
        csvMapping: parsedMapping,
        ...(reason.trim().length >= 10 ? { reason: reason.trim() } : {}),
      })
      if (!state.success) {
        toast.error(state.error)
        return
      }
      toast.success("Cuenta actualizada")
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)} data-testid={`edit-account-${account.id}`}>
        Configurar
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Configurar {account.name}</DialogTitle>
            <DialogDescription>
              El mapeo CSV declara qué columna es cada cosa en el fichero de <em>este</em> banco. Si no hay columna de
              referencia de remesa, la agrupación N-a-1 simplemente no se ofrece: no se inventa.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="ea-date">Conciliada desde</Label>
                <Input id="ea-date" type="date" value={anchorDate} onChange={(e) => setAnchorDate(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ea-balance">Saldo del extracto ese día</Label>
                <Input id="ea-balance" value={anchorBalance} onChange={(e) => setAnchorBalance(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="ea-reason">Motivo (obligatorio para mover el anclaje, ≥ 10 caracteres)</Label>
              <Input id="ea-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ea-mapping">Mapeo CSV</Label>
              <textarea
                id="ea-mapping"
                value={mapping}
                onChange={(event) => setMapping(event.target.value)}
                rows={10}
                className="font-code w-full rounded-md border bg-background p-2 text-xs"
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="button" onClick={submit} disabled={pending}>
              {pending ? "Guardando…" : "Guardar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

type ImportResult = {
  statementId: string | null
  fileSha256: string
  alreadyImported: boolean
  imported: number
  skipped: readonly { sha256: string; operationDate: string; amountCents: number; description: string }[]
  zeroAmount: number
  periodStart: string
  periodEnd: string
}

/**
 * Importar un extracto. El servidor **parsea y comprueba antes de escribir**
 * (I-E7-5, I-E7-6a y la divisa): un fichero que no cuadra se rechaza entero, y
 * lo que se ve aquí después es lo que de verdad ha entrado —importadas,
 * repetidas **una a una** y apuntes de importe cero, que nacen ignorados—.
 */
export function ImportStatementDialog({ account }: { account: BankAccountView }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [format, setFormat] = useState<"N43" | "CSV">("N43")
  const [file, setFile] = useState<File | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)

  const submit = (): void => {
    if (!file) {
      toast.error("Elija un fichero de extracto")
      return
    }
    start(async () => {
      const data = new FormData()
      data.set("bankAccountId", account.id)
      data.set("format", format)
      data.set("file", file)
      const state = await importStatementAction(data)
      if (!state.success || !state.data) {
        toast.error(state.success ? "La importación no ha devuelto resultado" : state.error)
        return
      }
      setResult(state.data as unknown as ImportResult)
      toast.success(
        state.data.alreadyImported
          ? "Ese fichero ya estaba importado: no se ha creado ni una línea"
          : `${state.data.imported} movimiento(s) importado(s)`
      )
      router.refresh()
    })
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} data-testid={`import-${account.id}`}>
        Importar extracto
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Importar extracto · {account.name}</DialogTitle>
            <DialogDescription>
              El fichero se comprueba <strong>antes de escribir</strong>: numeración correlativa, cotejo contra el
              registro 33 del cuaderno 43 y divisa de la cuenta. Si algo no cuadra, no se importa a medias: se rechaza
              entero y se dice por qué.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="imp-format">Formato</Label>
              <select
                id="imp-format"
                value={format}
                onChange={(event) => setFormat(event.target.value as "N43" | "CSV")}
                className="h-9 rounded-md border bg-background px-2 text-sm"
                data-testid="import-format"
              >
                <option value="N43">Norma 43 (cuaderno 43 del CSB)</option>
                <option value="CSV">CSV del banco (usa el mapeo configurado)</option>
              </select>
              {format === "CSV" && !account.hasCsvMapping && (
                <p className="text-xs text-[#8a6100]">
                  Esta cuenta no tiene mapeo CSV configurado: configúrelo antes de importar un CSV.
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="imp-file">Fichero</Label>
              <input
                id="imp-file"
                type="file"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                className="block w-full text-sm"
                data-testid="import-file"
              />
            </div>

            {result && (
              <div className="rounded-md border p-3 text-sm" data-testid="import-result">
                <p>
                  <strong>{result.imported}</strong> movimiento(s) importado(s) · periodo {result.periodStart} –{" "}
                  {result.periodEnd} · {result.zeroAmount} de importe cero (nacen ignorados con motivo{" "}
                  <span className="font-code">IMPORTE_CERO</span>)
                </p>
                <p className="font-code mt-1 text-xs text-muted-foreground" title={result.fileSha256}>
                  sha256 del fichero {result.fileSha256.slice(0, 16)}
                </p>
                {result.alreadyImported && (
                  <p className="mt-1" data-testid="import-already">
                    Ese fichero ya estaba importado: no se ha creado ni una línea.
                  </p>
                )}
                {result.skipped.length > 0 && (
                  <div className="mt-2" data-testid="import-skipped">
                    <p className="font-medium">
                      {result.skipped.length} movimiento(s) ya estaban en la cuenta y no se han duplicado:
                    </p>
                    <ul className="mt-1 max-h-40 list-disc overflow-y-auto pl-5 text-xs text-muted-foreground">
                      {result.skipped.map((line) => (
                        <li key={line.sha256}>
                          {line.operationDate} · <Amount cents={line.amountCents} zeroAsDash={false} /> · {line.description}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cerrar
            </Button>
            <Button type="button" onClick={submit} disabled={pending} data-testid="submit-import">
              {pending ? "Importando…" : "Importar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
