import { Skeleton } from "@/components/ui/skeleton"

/** E7 · T12 — Esqueleto mientras el barrido y sus bloques se resuelven en servidor. */
export default function AuditLoading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-9 w-64" />
      <Skeleton className="h-24 w-full" />
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-20 w-full" />
        ))}
      </div>
      <div className="space-y-1">
        {Array.from({ length: 10 }, (_, index) => (
          <Skeleton key={index} className="h-8 w-full" />
        ))}
      </div>
    </div>
  )
}
