import { Skeleton } from "@/components/ui/skeleton"

/** E8 · T15 — Estado de carga de la revisión de un documento. */
export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2 border-b pb-4">
        <Skeleton className="h-8 w-96" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <Skeleton className="h-[560px] w-full" />
        <div className="space-y-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    </div>
  )
}
