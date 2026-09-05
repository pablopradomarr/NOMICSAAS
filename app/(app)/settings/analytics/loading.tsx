import { Skeleton } from "@/components/ui/skeleton"

/** E4 · T13/T14 — Esqueleto mientras la analítica se resuelve en el servidor. */
export default function AnalyticsLoading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-9 w-72" />
      <Skeleton className="h-20 w-full" />
      <div className="space-y-1">
        {Array.from({ length: 12 }, (_, index) => (
          <Skeleton key={index} className="h-8 w-full" />
        ))}
      </div>
    </div>
  )
}
