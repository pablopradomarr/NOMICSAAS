import { Skeleton } from "@/components/ui/skeleton"

/** E3 · T11 — Esqueleto de tabla mientras el diario se resuelve en el servidor. */
export default function LedgerLoading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-9 w-64" />
      <Skeleton className="h-24 w-full" />
      <div className="space-y-1">
        {Array.from({ length: 12 }, (_, index) => (
          <Skeleton key={index} className="h-8 w-full" />
        ))}
      </div>
    </div>
  )
}
