/**
 * E11 · integración — **Stripe como módulo apagado** (ADR-0019 **D9**).
 *
 * Con `BILLING_PROVIDER ≠ stripe` las tres rutas de `/api/stripe/*` responden
 * **404**, no 501 ni 403. El código importa: un 501 dice «esto existe y aún no
 * está implementado» y un 403 dice «existe y no puedes»; los dos confirman que
 * la ruta está ahí. En modo INTERNO **no hay integración de pagos**, y la
 * respuesta correcta a una sonda —o a un webhook de una cuenta de Stripe que
 * alguien dejó apuntando aquí— es que el recurso no existe.
 *
 * No hace falta ninguna clave: la comprobación es de configuración, así que se
 * resuelve **antes** de tocar `stripeClient`, la sesión o la base de datos.
 */

import { NextResponse } from "next/server"

import config from "@/lib/config"
import { isStripeEnabled } from "@/lib/platform/billing"

/** `null` cuando Stripe está encendido; la respuesta 404 cuando no. */
export function stripeModuleOff(): NextResponse | null {
  if (isStripeEnabled(config.billing.provider)) return null
  return NextResponse.json(
    {
      error: "No encontrado",
      detail:
        "Esta instalación funciona en modo interno (BILLING_PROVIDER=none): no hay facturación, " +
        "ni cobro, ni integración con Stripe.",
    },
    { status: 404, headers: { "Cache-Control": "no-store" } }
  )
}
