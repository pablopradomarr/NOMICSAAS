import { Skeleton } from "@/components/ui/skeleton"

/** E10 · T15 — Esqueleto mientras el presupuesto se compone en el servidor. */
export default function BudgetLoading() {
  return (
    <div className="space-y-4" data-testid="budget-loading">
      <Skeleton className="h-9 w-64" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-32 w-full" />
      <div className="space-y-1">
        {Array.from({ length: 10 }, (_, index) => (
          <Skeleton key={index} className="h-8 w-full" />
        ))}
      </div>
    </div>
  )
}
