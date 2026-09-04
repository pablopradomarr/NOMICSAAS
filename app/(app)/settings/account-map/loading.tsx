import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <div className="flex w-full flex-col gap-4">
      <Skeleton className="h-10 w-72" />
      <Skeleton className="h-6 w-96" />
      <Skeleton className="h-[480px] w-full" />
    </div>
  )
}
