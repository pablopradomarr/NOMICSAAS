import { Skeleton } from "@/components/ui/skeleton"

/**
 * E6 · T16 — Esqueleto mientras el informe se emite en el servidor.
 *
 * Un informe puede tardar: lee el diario, calcula los invariantes y sella el
 * `ReportRun`. Mejor un esqueleto que una tabla a medias.
 */
export default function ReportsLoading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-20 w-full" />
      <div className="space-y-1">
        {Array.from({ length: 14 }, (_, index) => (
          <Skeleton key={index} className="h-8 w-full" />
        ))}
      </div>
    </div>
  )
}
