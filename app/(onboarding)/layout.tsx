import { Toaster } from "@/components/ui/sonner"
import "../globals.css"

/**
 * Route group de alta (E1-fix, hallazgo #9).
 *
 * `/organizations/new` NO puede colgar de `(app)`: aquel layout empieza por
 * `requireOrg("VIEWER")`, que lanza `NO_ORGANIZATION` justamente para el
 * usuario que viene a crear su primera organización. Redirigir desde ese layout
 * sería un bucle (la ruta destino usa el mismo layout), así que la pantalla vive
 * en un grupo propio, sin barra lateral ni guardia de organización: basta con
 * estar autenticado, y eso lo comprueba la propia página.
 */
export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto w-full max-w-2xl">{children}</div>
      <Toaster />
    </div>
  )
}

export const dynamic = "force-dynamic"
