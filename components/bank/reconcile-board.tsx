"use client"

import {
  acceptSuggestionsAction,
  confirmEntryFromLineAction,
  createMatchGroupAction,
  ignoreLineAction,
  proposeEntryFromLineAction,
  unmatchGroupAction,
} from "@/app/(app)/audit/actions"
import { Amount } from "@/components/ledger/amount"
import { Button } from "@/components/ui/button"
import { ConfidenceBadge } from "@/components/ui/confidence-badge"
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
import { cn } from "@/lib/utils"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useMemo, useState, useTransition } from "react"
import { toast } from "sonner"

import {
  GROUP_KIND_LABEL,
  IGNORE_REASON_LABEL,
  MATCH_REASON_LABEL,
  PROPOSAL_ACCOUNT_LABEL,
  type JournalCashLineView,
  type MatchGroupView,
  type StatementLineView,
  type SuggestionView,
} from "./types"

/**
 * E7 · T16 — El tablero de conciliación: **extracto ↔ diario**, N-a-M.
 *
 * Cuatro decisiones de esta pantalla que no son de estilo:
 *
 * 1. **Selección múltiple a los dos lados.** Una remesa son catorce apuntes
 *    contra un abono, y un descuento de efectos son tres cuentas contra el abono
 *    neto: sin grupos N-a-M no se pueden conciliar sin inventarse asientos.
 * 2. **La Σ de la selección es una VISTA PREVIA**, marcada como tal. La igualdad
 *    que decide (I-E7-11: Σ líneas = Σ debe − haber) la revalida el servidor
 *    antes de escribir; lo de aquí es ayuda visual, no una cifra contable.
 * 3. **Las sugerencias se marcan como sugerencias**, con su puntuación entera y
 *    sus motivos. Un **empate no produce sugerencia**: la línea sale «ambigua»
 *    con los candidatos listados y elige una persona. Un desempate automático es
 *    donde se cuela el error silencioso.
 * 4. **Un movimiento del banco sin asiento no es ignorable**: se propone asiento.
 *    Ignorarlo no lo concilia, lo esconde, y deja la 572 corta para siempre.
 *
 * Desconciliar exige motivo (≥ 10) e ignorar exige uno del **vocabulario
 * cerrado** —con evidencia en dos de sus cuatro valores—. El servidor lo vuelve
 * a exigir: la puerta está allí, aquí sólo está el formulario.
 */

type Props = {
  bankAccountId: string
  currency: string
  canEdit: boolean
  lines: readonly StatementLineView[]
  cashLines: readonly JournalCashLineView[]
  suggestions: readonly SuggestionView[]
  groups: readonly MatchGroupView[]
  accountKeys: readonly string[]
  /** Destinos analíticos de la organización, para la propuesta de asiento. */
  destinations: readonly { id: string; kind: "PROJECT" | "COST_CENTER"; label: string }[]
}

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0)

export function ReconcileBoard({
  bankAccountId,
  currency,
  canEdit,
  lines,
  cashLines,
  suggestions,
  groups,
  accountKeys,
  destinations,
}: Props) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [selectedLines, setSelectedLines] = useState<string[]>([])
  const [selectedCash, setSelectedCash] = useState<string[]>([])
  const [onlyUnmatched, setOnlyUnmatched] = useState(true)

  const suggestionByLine = useMemo(
    () => new Map(suggestions.map((suggestion) => [suggestion.statementLineId, suggestion])),
    [suggestions]
  )
  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups])

  const lineById = useMemo(() => new Map(lines.map((line) => [line.id, line])), [lines])
  const cashById = useMemo(() => new Map(cashLines.map((line) => [line.id, line])), [cashLines])

  // VISTA PREVIA: lo único que el navegador suma, y va marcado como tal.
  const sumaLineas = sum(selectedLines.map((id) => lineById.get(id)?.amountCents ?? 0))
  const sumaApuntes = sum(selectedCash.map((id) => cashById.get(id)?.signedCents ?? 0))

  const visibleLines = onlyUnmatched ? lines.filter((line) => line.status === "UNMATCHED") : lines
  const visibleCash = onlyUnmatched ? cashLines.filter((line) => line.groupId === null) : cashLines

  const toggle = (setter: React.Dispatch<React.SetStateAction<string[]>>) => (id: string) =>
    setter((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]))

  const conciliar = (): void => {
    start(async () => {
      const state = await createMatchGroupAction({
        bankAccountId,
        statementLineIds: selectedLines,
        journalLineIds: selectedCash,
      })
      if (!state.success || !state.data) {
        toast.error(state.success ? "La conciliación no ha devuelto resultado" : state.error)
        return
      }
      toast.success(`Conciliado (${GROUP_KIND_LABEL[state.data.kind as keyof typeof GROUP_KIND_LABEL] ?? state.data.kind})`)
      setSelectedLines([])
      setSelectedCash([])
      router.refresh()
    })
  }

  const aceptar = (statementLineId: string): void => {
    start(async () => {
      const state = await acceptSuggestionsAction({ bankAccountId, statementLineIds: [statementLineId] })
      if (!state.success || !state.data) {
        toast.error(state.success ? "La sugerencia no ha devuelto resultado" : state.error)
        return
      }
      if (state.data.rejected.length > 0) {
        toast.error(state.data.rejected[0].reason)
      } else {
        toast.success("Sugerencia aceptada")
      }
      router.refresh()
    })
  }

  return (
    <section className="space-y-3" data-testid="tablero-conciliacion">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={onlyUnmatched}
            onChange={(event) => setOnlyUnmatched(event.target.checked)}
            data-testid="only-unmatched"
          />
          Ver sólo lo que falta por conciliar
        </label>
        {canEdit && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm" data-testid="suma-seleccion">
              <ConfidenceBadge level="no_verificado" label="vista previa" className="mr-2" />
              Extracto <Amount cents={sumaLineas} currency={currency} zeroAsDash={false} /> · diario{" "}
              <Amount cents={sumaApuntes} currency={currency} zeroAsDash={false} /> · diferencia{" "}
              <Amount cents={sumaLineas - sumaApuntes} currency={currency} zeroAsDash={false} />
            </span>
            <Button
              type="button"
              size="sm"
              onClick={conciliar}
              disabled={pending || selectedLines.length === 0 || selectedCash.length === 0}
              data-testid="conciliar"
            >
              Conciliar {selectedLines.length} ↔ {selectedCash.length}
            </Button>
          </div>
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* ── Extracto ─────────────────────────────────────────────────── */}
        <div className="rounded-md border" data-testid="columna-extracto">
          <p className="border-b bg-muted/50 px-3 py-2 text-sm font-medium">Extracto del banco</p>
          {visibleLines.length === 0 ? (
            <p className="px-3 py-6 text-sm text-muted-foreground" data-testid="extracto-vacio">
              No hay líneas de extracto que enseñar. Importe un extracto para empezar.
            </p>
          ) : (
            <ul className="max-h-[32rem] divide-y overflow-y-auto">
              {visibleLines.map((line) => {
                const suggestion = suggestionByLine.get(line.id)
                return (
                  <li
                    key={line.id}
                    className={cn("px-3 py-2 text-sm", selectedLines.includes(line.id) && "bg-[#EDF2F7]")}
                    data-testid={`statement-line-${line.id}`}
                    data-status={line.status}
                  >
                    <div className="flex items-start gap-2">
                      {canEdit && line.status === "UNMATCHED" && (
                        <input
                          type="checkbox"
                          className="mt-1"
                          aria-label={`Seleccionar el movimiento del ${line.operationDate}`}
                          checked={selectedLines.includes(line.id)}
                          onChange={() => toggle(setSelectedLines)(line.id)}
                          data-testid={`select-line-${line.id}`}
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-baseline gap-2">
                          <span className="tabular-nums">{line.operationDate}</span>
                          <Amount cents={line.amountCents} currency={currency} zeroAsDash={false} />
                          <span className="text-xs text-muted-foreground">
                            fecha valor {line.valueDate} (informativa: la que manda es la de operación)
                          </span>
                        </p>
                        <p className="text-muted-foreground">{line.description}</p>
                        <p className="text-xs text-muted-foreground">
                          nº {line.lineNo}
                          {line.reference1 ? ` · remesa ${line.reference1}` : ""}
                          {line.counterpartyName ? ` · ${line.counterpartyName}` : ""} ·{" "}
                          {line.status === "MATCHED"
                            ? "conciliada"
                            : line.status === "IGNORED"
                              ? `ignorada (${line.ignoreReason ? IGNORE_REASON_LABEL[line.ignoreReason] : "sin motivo"})`
                              : "pendiente"}
                        </p>

                        {suggestion && line.status === "UNMATCHED" && (
                          <div className="mt-1 rounded border border-dashed px-2 py-1" data-testid={`sugerencia-${line.id}`}>
                            <p className="text-xs font-medium">
                              {suggestion.ambiguous ? "Sugerencia ambigua (empate): elija usted" : "Sugerencia"}
                            </p>
                            <ul className="text-xs text-muted-foreground">
                              {suggestion.candidates.map((candidate, index) => (
                                <li key={index}>
                                  {GROUP_KIND_LABEL[candidate.kind]} · puntuación {candidate.scoreBps} ·{" "}
                                  {candidate.reasons.map((reason) => MATCH_REASON_LABEL[reason] ?? reason).join(", ")}
                                </li>
                              ))}
                            </ul>
                            {canEdit && !suggestion.ambiguous && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="mt-1"
                                onClick={() => aceptar(line.id)}
                                disabled={pending}
                                data-testid={`aceptar-sugerencia-${line.id}`}
                              >
                                Aceptar la sugerencia
                              </Button>
                            )}
                          </div>
                        )}

                        {canEdit && (
                          <div className="mt-1 flex flex-wrap gap-2">
                            {line.status === "UNMATCHED" && (
                              <>
                                <ProposeEntryDialog statementLineId={line.id} accountKeys={accountKeys} destinations={destinations} />
                                <IgnoreLineDialog statementLineId={line.id} />
                              </>
                            )}
                            {line.status === "MATCHED" && line.groupId && (
                              <UnmatchDialog groupId={line.groupId} group={groupById.get(line.groupId) ?? null} />
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* ── Diario ───────────────────────────────────────────────────── */}
        <div className="rounded-md border" data-testid="columna-diario">
          <p className="border-b bg-muted/50 px-3 py-2 text-sm font-medium">Apuntes de la cuenta 57x</p>
          {visibleCash.length === 0 ? (
            <p className="px-3 py-6 text-sm text-muted-foreground" data-testid="diario-vacio">
              No hay apuntes de esta cuenta que enseñar en el periodo.
            </p>
          ) : (
            <ul className="max-h-[32rem] divide-y overflow-y-auto">
              {visibleCash.map((line) => (
                <li
                  key={line.id}
                  className={cn("px-3 py-2 text-sm", selectedCash.includes(line.id) && "bg-[#EDF2F7]")}
                  data-testid={`journal-line-${line.id}`}
                  data-matched={line.groupId !== null}
                >
                  <div className="flex items-start gap-2">
                    {canEdit && line.groupId === null && (
                      <input
                        type="checkbox"
                        className="mt-1"
                        aria-label={`Seleccionar el apunte del asiento ${line.entryNumber}`}
                        checked={selectedCash.includes(line.id)}
                        onChange={() => toggle(setSelectedCash)(line.id)}
                        data-testid={`select-cash-${line.id}`}
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-baseline gap-2">
                        <span className="tabular-nums">{line.entryDate}</span>
                        <Amount cents={line.signedCents} currency={currency} zeroAsDash={false} />
                        <Link href={`/ledger/${line.entryId}`} className="text-xs underline underline-offset-2">
                          asiento nº {line.entryNumber}
                        </Link>
                      </p>
                      <p className="text-muted-foreground">{line.description}</p>
                      <p className="font-code text-xs text-muted-foreground">
                        {line.accountCode} · línea {line.lineNo} · {line.groupId ? "conciliado" : "pendiente"}
                      </p>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Desconciliar, ignorar y proponer asiento
// ─────────────────────────────────────────────────────────────────────────────

function UnmatchDialog({ groupId, group }: { groupId: string; group: MatchGroupView | null }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [pending, start] = useTransition()

  const submit = (): void => {
    start(async () => {
      const state = await unmatchGroupAction({ groupId, reason })
      if (!state.success) {
        toast.error(state.error)
        return
      }
      toast.success("Grupo desconciliado")
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)} data-testid={`unmatch-${groupId}`}>
        Desconciliar
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Desconciliar el grupo</DialogTitle>
            <DialogDescription>
              {group ? `${GROUP_KIND_LABEL[group.kind]} · ${group.statementLineIds.length} línea(s) de extracto contra ${group.journalLineIds.length} apunte(s).` : ""}{" "}
              Desconciliar <strong>no toca el libro diario</strong>: no se escribe ni un céntimo. Queda el motivo en el
              registro de auditoría.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="um-reason">Motivo (mínimo 10 caracteres)</Label>
            <Input id="um-reason" value={reason} onChange={(event) => setReason(event.target.value)} data-testid="unmatch-reason" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="button" onClick={submit} disabled={pending || reason.trim().length < 10} data-testid="confirm-unmatch">
              {pending ? "Guardando…" : "Desconciliar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

const IGNORE_WITH_EVIDENCE = ["ERROR_BANCO_REVERSADO", "YA_CONTABILIZADO_EN_OTRA_CUENTA"]

function IgnoreLineDialog({ statementLineId }: { statementLineId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("NO_ES_NUESTRA_CUENTA")
  const [evidenceId, setEvidenceId] = useState("")
  const [pending, start] = useTransition()
  const needsEvidence = IGNORE_WITH_EVIDENCE.includes(reason)

  const submit = (): void => {
    start(async () => {
      const state = await ignoreLineAction({
        id: statementLineId,
        reason,
        evidenceId: evidenceId.trim() === "" ? null : evidenceId.trim(),
      })
      if (!state.success) {
        toast.error(state.error)
        return
      }
      toast.success("Línea ignorada: su importe sigue contando en el cuadre como línea propia")
      setOpen(false)
      router.refresh()
    })
  }

  return (
    <>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)} data-testid={`ignore-${statementLineId}`}>
        Ignorar
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ignorar el movimiento</DialogTitle>
            <DialogDescription>
              El vocabulario es <strong>cerrado</strong>: fuera de estos motivos, nada es ignorable. Un cargo que existe
              en el banco y no en los libros <strong>no se ignora</strong>: se propone asiento, o la cuenta se queda
              corta para siempre. Σ de lo ignorado se presenta como línea propia del cuadre.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="ig-reason">Motivo</Label>
              <select
                id="ig-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                data-testid="ignore-reason"
              >
                {(Object.keys(IGNORE_REASON_LABEL) as (keyof typeof IGNORE_REASON_LABEL)[])
                  .filter((key) => key !== "IMPORTE_CERO")
                  .map((key) => (
                    <option key={key} value={key}>
                      {IGNORE_REASON_LABEL[key]}
                    </option>
                  ))}
              </select>
              <p className="text-xs text-muted-foreground">
                <span className="font-code">IMPORTE_CERO</span> lo pone la importación sola: la evidencia es el propio
                importe.
              </p>
            </div>
            {needsEvidence && (
              <div className="space-y-1">
                <Label htmlFor="ig-evidence">Evidencia (identificador de la línea o del apunte que lo respalda)</Label>
                <Input
                  id="ig-evidence"
                  value={evidenceId}
                  onChange={(event) => setEvidenceId(event.target.value)}
                  data-testid="ignore-evidence"
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="button" onClick={submit} disabled={pending} data-testid="confirm-ignore">
              {pending ? "Guardando…" : "Ignorar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

type PreviewLine = { accountCode: string; debitCents: number; creditCents: number; description?: string | null }

/**
 * «Proponer asiento» desde un movimiento sin apunte (O-4).
 *
 * La cuenta sale del **mapa de cuentas de la organización**, nunca del texto del
 * movimiento: deducirla del concepto es auto-punteo por patrón. La propuesta
 * pasa por el mismo `previewFromProposal` del camino documental y exige
 * confirmación humana. Si la cuenta elegida lleva IVA soportado asociado, el
 * servidor bloquea y lo explica: los servicios financieros están exentos (art.
 * 20.Uno.18º LIVA), pero la gestión de cobro de efectos está sujeta y tiene que
 * entrar con su factura por el camino documental.
 */
function ProposeEntryDialog({
  statementLineId,
  accountKeys,
  destinations,
}: {
  statementLineId: string
  accountKeys: readonly string[]
  destinations: readonly { id: string; kind: "PROJECT" | "COST_CENTER"; label: string }[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [accountKey, setAccountKey] = useState(accountKeys[0] ?? "COMISIONES_BANCARIAS")
  const [description, setDescription] = useState("")
  /** `"<PROJECT|COST_CENTER>:<id>"`, o vacío. Uno y sólo uno (R-A1 de E4). */
  const [destination, setDestination] = useState(
    destinations.length > 0 ? `${destinations[0].kind}:${destinations[0].id}` : ""
  )
  const [pending, start] = useTransition()
  const [preview, setPreview] = useState<{
    accountCode: string
    bankAccountCode: string
    amountCents: number
    operationDate: string
    lines: readonly PreviewLine[]
    error: { code: string; message: string } | null
  } | null>(null)

  const destinoPayload = (): Record<string, string> => {
    if (!destination) return {}
    const [kind, id] = destination.split(":")
    return kind === "PROJECT" ? { projectId: id } : { costCenterId: id }
  }

  const proponer = (): void => {
    start(async () => {
      const state = await proposeEntryFromLineAction({
        statementLineId,
        accountKey,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...destinoPayload(),
      })
      if (!state.success || !state.data) {
        // El motivo se enseña **dentro del diálogo**, no sólo en un aviso que se
        // va: una propuesta bloqueada (cuenta sin mapear, IVA del art. 20.Uno.18º,
        // ejercicio no abierto) es información que quien concilia necesita leer
        // entera para decidir qué hace.
        setPreview({
          accountCode: "—",
          bankAccountCode: "—",
          amountCents: 0,
          operationDate: "—",
          lines: [],
          error: { code: "PROPUESTA_BLOQUEADA", message: state.success ? "La propuesta no ha devuelto resultado" : (state.error ?? "La propuesta no se ha podido preparar") },
        })
        return
      }
      const data = state.data as unknown as {
        accountCode: string
        bankAccountCode: string
        amountCents: number
        operationDate: string
        draft: { draft?: { lines?: PreviewLine[] } } | null
        error: { code: string; message: string } | null
      }
      setPreview({
        accountCode: data.accountCode,
        bankAccountCode: data.bankAccountCode,
        amountCents: data.amountCents,
        operationDate: data.operationDate,
        lines: data.draft?.draft?.lines ?? [],
        error: data.error,
      })
    })
  }

  const confirmar = (): void => {
    start(async () => {
      const state = await confirmEntryFromLineAction({
        statementLineId,
        accountKey,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...destinoPayload(),
        idempotencyKey: `bank-${statementLineId}-${accountKey}`,
      })
      if (!state.success || !state.data) {
        toast.error(state.success ? "La confirmación no ha devuelto resultado" : state.error)
        return
      }
      toast.success(`Asiento nº ${state.data.entryNumber} contabilizado y conciliado en la misma transacción`)
      setOpen(false)
      router.refresh()
    })
  }

  const totalDebe = preview ? sum(preview.lines.map((line) => line.debitCents)) : 0
  const totalHaber = preview ? sum(preview.lines.map((line) => line.creditCents)) : 0

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        data-testid={`propose-${statementLineId}`}
      >
        Proponer asiento
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Proponer asiento desde el extracto</DialogTitle>
            <DialogDescription>
              El movimiento existe en el banco y no en los libros. La contrapartida se elige del <strong>mapa de
              cuentas</strong> de la organización —nunca del texto del movimiento— y la propuesta pasa por el mismo
              motor que el camino documental. Al confirmar, el asiento y la conciliación se escriben en la{" "}
              <strong>misma transacción</strong>.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="pe-account">Contrapartida</Label>
              <select
                id="pe-account"
                value={accountKey}
                onChange={(event) => {
                  setAccountKey(event.target.value)
                  setPreview(null)
                }}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                data-testid="propose-account-key"
              >
                {accountKeys.map((key) => (
                  <option key={key} value={key}>
                    {PROPOSAL_ACCOUNT_LABEL[key] ?? key}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="pe-destination">Destino analítico</Label>
              <select
                id="pe-destination"
                value={destination}
                onChange={(event) => {
                  setDestination(event.target.value)
                  setPreview(null)
                }}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                data-testid="propose-destination"
              >
                <option value="">Sin destino</option>
                {destinations.map((option) => (
                  <option key={`${option.kind}:${option.id}`} value={`${option.kind}:${option.id}`}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Una comisión bancaria es una cuenta 626: como toda cuenta 6/7, lleva <strong>un</strong> destino
                analítico —proyecto o centro de coste, nunca los dos—. Sin él la propuesta se bloquea.
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="pe-description">Concepto (opcional)</Label>
              <Input id="pe-description" value={description} onChange={(event) => setDescription(event.target.value)} />
            </div>

            {preview && (
              <div className="rounded-md border p-3 text-sm" data-testid="propose-preview">
                <p>
                  {preview.operationDate} · <Amount cents={preview.amountCents} zeroAsDash={false} /> ·{" "}
                  <span className="font-code">{preview.accountCode}</span> contra{" "}
                  <span className="font-code">{preview.bankAccountCode}</span>
                </p>
                {preview.error ? (
                  <p className="mt-2 rounded border border-[#F5A623] bg-[#F5A623]/10 px-2 py-1" role="alert" data-testid="propose-error">
                    {preview.error.message}
                  </p>
                ) : (
                  <>
                    <table className="mt-2 w-full text-xs">
                      <thead className="text-muted-foreground">
                        <tr>
                          <th className="text-left font-medium">Cuenta</th>
                          <th className="text-left font-medium">Concepto</th>
                          <th className="text-right font-medium">Debe</th>
                          <th className="text-right font-medium">Haber</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.lines.map((line, index) => (
                          <tr key={index} className="border-t">
                            <td className="font-code py-1">{line.accountCode}</td>
                            <td className="py-1 text-muted-foreground">{line.description ?? ""}</td>
                            <td className="py-1 text-right">
                              <Amount cents={line.debitCents} />
                            </td>
                            <td className="py-1 text-right">
                              <Amount cents={line.creditCents} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="mt-1 text-xs" data-testid="propose-cuadre">
                      Σdebe − Σhaber = <Amount cents={totalDebe - totalHaber} zeroAsDash={false} />
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Servicio financiero <strong>exento</strong> (art. 20.Uno.18º LIVA): la propuesta no lleva cuota.
                    </p>
                  </>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="button" variant="outline" onClick={proponer} disabled={pending} data-testid="propose-preview-button">
              {pending ? "…" : "Previsualizar"}
            </Button>
            <Button
              type="button"
              onClick={confirmar}
              disabled={pending || preview === null || preview.error !== null}
              data-testid="confirm-propose"
            >
              Confirmar y conciliar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
