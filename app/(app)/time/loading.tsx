import { Skeleton } from "@/components/ui/skeleton"

/** E10 · T17 — Esqueleto de «Partes de horas». */
export default function TimeLoading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-9 w-72" />
      <Skeleton className="h-10 w-96" />
      <Skeleton className="h-40 w-full" />
      <div className="space-y-1">
        {Array.from({ length: 10 }, (_, index) => (
          <Skeleton key={index} className="h-8 w-full" />
        ))}
      </div>
    </div>
  )
}
