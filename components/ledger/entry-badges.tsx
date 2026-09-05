import { ENTRY_KIND_LABELS, type EntryView } from "@/components/ledger/types"
import { cn } from "@/lib/utils"
import Link from "next/link"

/**
 * E3 · T11 — Distintivos de un asiento en el diario.
 *
 * Anular NO borra ni excluye nada (ADR-0003): el asiento anulado y su
 * contra-asiento aparecen los dos en el diario y en sumas y saldos y se
 * compensan por importe. Estos badges son lo único que los distingue.
 */

export function VoidedBadge({ entry, linkable = true }: { entry: EntryView; linkable?: boolean }) {
  if (!entry.voidedAt) return null
  const label = entry.reversedByEntryNumber ? `Anulado por el nº ${entry.reversedByEntryNumber}` : "Anulado"
  return (
    <span
      data-badge="anulado"
      title={entry.voidReason ?? undefined}
      className="inline-flex items-center rounded-md border border-[#F5A623] bg-[#F5A623]/15 px-1.5 py-0.5 text-[11px] leading-none font-medium whitespace-nowrap"
    >
      ⚠{" "}
      {linkable && entry.reversedByEntryId ? (
        <Link href={`/ledger/${entry.reversedByEntryId}`} className="ml-1 underline underline-offset-2">
          {label}
        </Link>
      ) : (
        <span className="ml-1">{label}</span>
      )}
    </span>
  )
}

export function ReversalBadge({ entry, linkable = true }: { entry: EntryView; linkable?: boolean }) {
  if (!entry.reversesEntryId) return null
  const label = entry.reversesEntryNumber ? `Anula el nº ${entry.reversesEntryNumber}` : "Contra-asiento"
  return (
    <span
      data-badge="contra-asiento"
      className="inline-flex items-center rounded-md border-transparent bg-[#0A0A0A] px-1.5 py-0.5 text-[11px] leading-none font-medium whitespace-nowrap text-white"
    >
      {linkable ? (
        <Link href={`/ledger/${entry.reversesEntryId}`} className="underline underline-offset-2">
          {label}
        </Link>
      ) : (
        label
      )}
    </span>
  )
}

export function KindBadge({ kind, className }: { kind: string; className?: string }) {
  if (kind === "NORMAL") return null
  return (
    <span
      data-entry-kind={kind}
      className={cn(
        "inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[11px] leading-none font-medium whitespace-nowrap text-muted-foreground",
        className
      )}
    >
      {ENTRY_KIND_LABELS[kind] ?? kind}
    </span>
  )
}
