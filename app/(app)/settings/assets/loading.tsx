import { Skeleton } from "@/components/ui/skeleton"

/** E9 · T17/T18 — Esqueleto de «Inmovilizado» mientras el servidor resuelve las cifras. */
export default function AssetsLoading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-9 w-72" />
      <Skeleton className="h-16 w-full" />
      <div className="space-y-1">
        {Array.from({ length: 12 }, (_, index) => (
          <Skeleton key={index} className="h-8 w-full" />
        ))}
      </div>
    </div>
  )
}
