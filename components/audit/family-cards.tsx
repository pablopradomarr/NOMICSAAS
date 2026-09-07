"use client"

import { CheckStatusChip } from "@/components/ui/check-status"
import { cn } from "@/lib/utils"
import Link from "next/link"
import { useState } from "react"

import { FAMILY_HELP, FAMILY_STATUS_LABEL, type CheckView, type FamilyCardView, type FamilyStatus } from "./types"

/**
 * E7 · T12 — Las siete familias con semáforo y el drill-down de tres clics
 * (`docs/design/E7-auditoria.md` §6, criterio 3).
 *
 * **`SIN_EVALUAR` nunca sale en verde.** No es un «OK tímido»: es la diferencia
 * entre «comprobado y bien» y «no comprobado», que es la razón de ser de esta
 * pantalla (riesgo R3 de la épica). El estado lo compone `familyStatus()` en
 * `lib/audit/families.ts` —una sola vez, en el motor puro— y aquí sólo se
 * pinta: este componente no deriva ningún estado de los recuentos.
 *
 * El camino son **tres clics**, contados en el e2e:
 *   1. la tarjeta de la familia,
 *   2. el check,
 *   3. «Ver registros de origen» → los asientos y su documento.
 *
 * Los registros los resuelve el servidor a partir de la evidencia literal del
 * check (`page.tsx`): el navegador no interpreta una evidencia para inventar un
 * enlace.
 */

const STATUS_STYLE: Record<FamilyStatus, string> = {
  // Negro de marca: comprobado y sin hallazgos.
  OK: "border-[#0A0A0A] bg-[#0A0A0A] text-white",
  // Ámbar de aviso (#F5A623). Sin rojo/verde semáforo (`ui-erp` §Estilo).
  AVISO: "border-[#F5A623] bg-[#F5A623]/15 text-[#1A202C]",
  FALLO: "border-[#F5A623] bg-[#F5A623]/35 text-[#1A202C]",
  // Borde discontinuo: lo no comprobado se ve que no se ha comprobado.
  SIN_EVALUAR: "border-dashed border-muted-foreground/60 bg-transparent text-muted-foreground",
}

const STATUS_MARK: Record<FamilyStatus, string> = {
  OK: "✓",
  AVISO: "⚠",
  FALLO: "✗",
  SIN_EVALUAR: "·",
}

function CheckRow({ check }: { check: CheckView }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="py-2" data-check-id={check.id}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 text-left"
        data-testid={`check-row-${check.id}`}
      >
        <span className="font-code w-24 shrink-0 text-xs">{check.id}</span>
        <CheckStatusChip status={check.status} />
        <span className="min-w-0 flex-1 text-sm text-muted-foreground">{check.evidencia}</span>
        <span aria-hidden className="text-xs text-muted-foreground">
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open && (
        <div className="mt-2 ml-24 space-y-3 border-l pl-3" data-testid={`check-detail-${check.id}`}>
          {check.query && (
            <div>
              <p className="text-xs font-medium">Consulta que reproduce el hallazgo</p>
              <pre className="font-code mt-1 overflow-x-auto rounded bg-muted px-2 py-1.5 text-[11px] whitespace-pre-wrap">
                {check.query}
              </pre>
            </div>
          )}
          <div data-testid={`origin-records-${check.id}`}>
            <p className="text-xs font-medium">Registros de origen</p>
            {check.registros.length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">
                La evidencia de este check no nombra asientos concretos: el alcance es el periodo entero.
              </p>
            ) : (
              <table className="mt-1 w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="text-left font-medium">Asiento</th>
                    <th className="text-left font-medium">Fecha</th>
                    <th className="text-left font-medium">Concepto</th>
                    <th className="text-left font-medium">Documento</th>
                  </tr>
                </thead>
                <tbody>
                  {check.registros.map((record) => (
                    <tr key={record.entryId} className="border-t">
                      <td className="py-1">
                        <Link
                          href={`/ledger/${record.entryId}`}
                          className="underline underline-offset-2"
                          data-testid={`origin-entry-${record.entryNumber}`}
                        >
                          nº {record.entryNumber}
                        </Link>
                      </td>
                      <td className="py-1 text-muted-foreground">{record.entryDate}</td>
                      <td className="py-1 text-muted-foreground">{record.description}</td>
                      <td className="py-1">
                        {record.fileId ? (
                          <Link
                            href={`/unsorted/${record.fileId}`}
                            className="underline underline-offset-2"
                            data-testid={`origin-document-${record.entryNumber}`}
                          >
                            ver documento
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">sin documento</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </li>
  )
}

export function FamilyCards({ families }: { families: readonly FamilyCardView[] }) {
  const [open, setOpen] = useState<string | null>(null)
  const active = families.find((family) => family.family === open) ?? null

  return (
    <section className="space-y-3" data-testid="familias">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {families.map((family) => (
          <button
            key={family.family}
            type="button"
            onClick={() => setOpen((value) => (value === family.family ? null : family.family))}
            aria-expanded={open === family.family}
            data-testid={`family-card-${family.family}`}
            data-family-status={family.status}
            className={cn(
              "rounded-md border px-3 py-2 text-left transition",
              STATUS_STYLE[family.status],
              open === family.family && "ring-2 ring-[#EAFF69] ring-offset-1"
            )}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{family.label}</span>
              <span aria-hidden className="text-sm">
                {STATUS_MARK[family.status]}
              </span>
            </span>
            <span className="mt-1 block text-[11px] opacity-80">{FAMILY_STATUS_LABEL[family.status]}</span>
            <span className="font-code mt-1 block text-[11px] opacity-80">
              {family.counts.PASS} PASS · {family.counts.FAIL} FAIL · {family.counts.WARN} WARN ·{" "}
              {family.counts.INFO} INFO
            </span>
          </button>
        ))}
      </div>

      {active && (
        <div className="rounded-md border p-3" data-testid={`family-detail-${active.family}`}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold">{active.label}</h3>
            <p className="text-xs text-muted-foreground">{FAMILY_HELP[active.family]}</p>
          </div>
          {active.checks.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Esta familia no tiene ninguna comprobación en el último barrido: por eso está{" "}
              <strong>sin evaluar</strong> y no en verde.
            </p>
          ) : (
            <ul className="mt-2 divide-y">
              {active.checks.map((check) => (
                <CheckRow key={check.id} check={check} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
