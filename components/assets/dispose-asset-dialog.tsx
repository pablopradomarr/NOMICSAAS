"use client"

import { disposeAssetAction, sellAssetAction, type DisposalResult } from "@/app/(app)/settings/assets/actions"
import { EntryDraftPreview } from "@/components/assets/entry-draft-preview"
import type { AssetView } from "@/components/assets/types"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { parseCents } from "@/lib/money"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

/**
 * E9 · T17 — **Baja y venta** del activo (**ADMIN**, T-33 y T-34, O-24).
 *
 * Tres cosas que esta pantalla dice y que no automatiza nadie:
 *
 * · La contrapartida de la venta es **`543`** (crédito a corto por enajenación
 *   de inmovilizado) o `253` a largo, **nunca `430`**: colar la venta de una
 *   máquina en clientes comerciales falsea la cifra de negocios y el periodo
 *   medio de cobro. El formulario lo trae por defecto y la acción lo exige.
 * · El **aviso del art. 110 LIVA**: entregar un bien de inversión dentro del
 *   periodo de regularización obliga a regularizar de una vez las cuotas de los
 *   años que faltan. Se **enseña**, no se contabiliza solo.
 * · La amortización acumulada que entra en el asiento es la del cuadro **hasta
 *   el mes de la baja inclusive** (R-AM-6): la calcula el servidor.
 */
export function DisposeAssetDialog({ detail }: { detail: AssetView }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [kind, setKind] = useState<"BAJA" | "VENTA">("VENTA")
  const [reason, setReason] = useState("")
  const [result, setResult] = useState<DisposalResult | null>(null)

  const submit = (form: FormData): void => {
    const disposalDate = String(form.get("disposalDate") ?? "")
    start(async () => {
      const state =
        kind === "BAJA"
          ? await disposeAssetAction({ fixedAssetId: detail.asset.id, disposalDate, reason })
          : await sellAssetAction({
              fixedAssetId: detail.asset.id,
              disposalDate,
              salePriceCents: parseCents(String(form.get("price") ?? "")) ?? 0,
              receivableAccountCode: String(form.get("receivable") ?? "543").trim(),
              taxRateCode: String(form.get("taxRateCode") ?? "").trim() || null,
              reason,
            })
      if (!state.success || !state.data) {
        toast.error(state.error ?? "No se ha podido dar de baja el activo")
        return
      }
      setResult(state.data)
      toast.success(kind === "BAJA" ? "Baja contabilizada" : "Venta contabilizada")
      router.refresh()
    })
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="border-[#F5A623] text-[#1A202C]"
        onClick={() => setOpen(true)}
        data-testid="open-dispose-asset"
      >
        Baja o venta
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setResult(null)
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Baja o venta de {detail.asset.code}</DialogTitle>
            <DialogDescription>
              El asiento lleva la amortización acumulada del cuadro hasta el mes de la baja inclusive. Nada se borra:
              el activo queda marcado y el asiento es el que explica su salida.
            </DialogDescription>
          </DialogHeader>

          {(detail.asset.isCapitalGood || detail.asset.isBuilding) && (
            <div className="space-y-1 rounded-md border border-[#F5A623] bg-[#F5A623]/10 p-3 text-xs" data-testid="art110-notice">
              {detail.asset.isCapitalGood && (
                <p>
                  ⚠ <strong>Art. 110 LIVA</strong>: es un bien de inversión. Si la entrega ocurre dentro del periodo de
                  regularización, hay que regularizar de una sola vez las cuotas de los años que quedan. Este ERP{" "}
                  <strong>no</strong> lo contabiliza automáticamente: revíselo antes de liquidar el periodo.
                </p>
              )}
              {detail.asset.isBuilding && (
                <p>
                  ⚠ <strong>Art. 20.Uno.22º LIVA</strong>: segunda entrega de edificación, exenta salvo renuncia del
                  art. 84.Uno.2º.e). Compruebe si procede la renuncia y la inversión del sujeto pasivo.
                </p>
              )}
            </div>
          )}

          {result ? (
            <div className="space-y-3" data-testid="disposal-result">
              <p className="text-sm">
                {result.kind === "BAJA" ? "Baja" : "Venta"} contabilizada como asiento nº{" "}
                <span className="font-code">{result.entryNumber}</span>, con {result.attributedLines} línea(s)
                atribuidas al activo.{" "}
                {result.entryId && (
                  <Link href={`/ledger/${result.entryId}`} className="underline underline-offset-4" data-testid="disposal-entry-link">
                    Ver el asiento
                  </Link>
                )}
              </p>
              {result.warnings.length > 0 && (
                <ul className="space-y-1 rounded-md border border-[#F5A623] bg-[#F5A623]/10 p-3 text-xs" data-testid="disposal-warnings">
                  {result.warnings.map((warning) => (
                    <li key={warning.code}>
                      ⚠ <span className="font-code">{warning.code}</span> — {warning.message}
                    </li>
                  ))}
                </ul>
              )}
              {result.draft && <EntryDraftPreview draft={result.draft} title="Asiento contabilizado" testId="disposal-draft" />}
              <DialogFooter>
                <Button type="button" onClick={() => setOpen(false)}>
                  Cerrar
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <form action={submit} className="space-y-3" data-testid="dispose-form">
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="dispose-kind">Operación</Label>
                  <select
                    id="dispose-kind"
                    data-testid="dispose-kind"
                    className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                    value={kind}
                    onChange={(event) => setKind(event.target.value as typeof kind)}
                  >
                    <option value="VENTA">Venta (T-34)</option>
                    <option value="BAJA">Baja sin contraprestación (T-33)</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="dispose-date">Fecha de la operación</Label>
                  <Input id="dispose-date" name="disposalDate" type="date" required data-testid="dispose-date" />
                </div>
                {kind === "VENTA" && (
                  <>
                    <div className="space-y-1">
                      <Label htmlFor="dispose-price">Precio de venta (base)</Label>
                      <Input id="dispose-price" name="price" inputMode="decimal" required data-testid="dispose-price" />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="dispose-receivable">Cuenta de crédito</Label>
                      <Input
                        id="dispose-receivable"
                        name="receivable"
                        defaultValue="543"
                        required
                        data-testid="dispose-receivable"
                      />
                      <p className="text-xs text-muted-foreground">543 a corto o 253 a largo; nunca 430 (O-24).</p>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="dispose-tax">Tipo impositivo (código)</Label>
                      <Input id="dispose-tax" name="taxRateCode" placeholder="IVA21" data-testid="dispose-tax" />
                    </div>
                  </>
                )}
              </div>
              <div className="space-y-1">
                <Label htmlFor="dispose-reason">Motivo (mínimo 10 caracteres)</Label>
                <Textarea
                  id="dispose-reason"
                  data-testid="dispose-reason"
                  rows={3}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </div>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                  Cancelar
                </Button>
                <Button type="submit" disabled={pending || reason.trim().length < 10} data-testid="dispose-submit">
                  {pending ? "Contabilizando…" : kind === "BAJA" ? "Dar de baja" : "Contabilizar la venta"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
