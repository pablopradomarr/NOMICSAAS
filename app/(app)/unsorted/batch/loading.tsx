import { Skeleton } from "@/components/ui/skeleton"

/** E8 · T17 — Estado de carga de la confirmación por lote. */
export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2 border-b pb-4">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-4 w-full max-w-3xl" />
      </div>
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  )
}
