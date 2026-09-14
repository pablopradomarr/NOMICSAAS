import { Skeleton } from "@/components/ui/skeleton"

/** E9 · T16 — Esqueleto mientras el `ClosingRun` y sus 43 pasos se resuelven en servidor. */
export default function ClosingLoading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-9 w-72" />
      <Skeleton className="h-20 w-full" />
      <div className="space-y-2">
        {Array.from({ length: 9 }, (_, index) => (
          <Skeleton key={index} className="h-10 w-full" />
        ))}
      </div>
      <div className="space-y-1">
        {Array.from({ length: 12 }, (_, index) => (
          <Skeleton key={index} className="h-8 w-full" />
        ))}
      </div>
    </div>
  )
}
