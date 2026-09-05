import { redirect } from "next/navigation"

/** E4 · T13 — `/analytics` no tiene pantalla propia: la portada es la PyG analítica. */
export default function AnalyticsIndexPage(): never {
  redirect("/analytics/pyg")
}
