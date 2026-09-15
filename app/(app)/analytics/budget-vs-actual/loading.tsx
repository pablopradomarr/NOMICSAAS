import { Skeleton } from "@/components/ui/skeleton"

/** E10 · T16 — Esqueleto de «Presupuesto vs real» mientras el servidor compone la matriz. */
export default function BudgetVsActualLoading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-9 w-80" />
      <Skeleton className="h-20 w-full" />
      <div className="space-y-1">
        {Array.from({ length: 16 }, (_, index) => (
          <Skeleton key={index} className="h-8 w-full" />
        ))}
      </div>
    </div>
  )
}
