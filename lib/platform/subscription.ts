/**
 * E11 · ola A — estado de la suscripción ⇔ nivel de acceso (§3.2, ADR-0019 D6/D7).
 *
 * **PURO**: la fecha entra por `refDate`. Sin BD, sin fetch, sin reloj.
 *
 * La regla se define **una sola vez, aquí**, y la verifica **I-E11-5**. No se
 * reparte por treinta ficheros: `requireOrg` consulta `accessLevelOf` y lanza
 * `SubscriptionReadOnlyError` para toda acción no marcada `allowInReadOnly`.
 *
 * | Estado                                                        | Acceso      |
 * |---------------------------------------------------------------|-------------|
 * | `TRIALING`, `ACTIVE`                                           | `FULL`      |
 * | `PAST_DUE` dentro de gracia (14 d, P-2)                        | `FULL` + aviso |
 * | `PAST_DUE` fuera de gracia · `GRACE` · `CANCELED` · `PAUSED` · `INCOMPLETE` | `READ_ONLY` |
 * | Organización desactivada por su propio ADMIN                   | `BLOCKED`   |
 *
 * **Nunca `BLOCKED` por impago.** Un cliente que no paga pierde la escritura
 * ordinaria; jamás la lectura, la exportación ni la llevanza de sus libros.
 */

import type { AccessLevel, SubscriptionRow, WriteKind } from "./types"
import { EXPORT_WINDOW_DAYS } from "./types"
import type { SubscriptionStatus } from "@/prisma/client"

// ─────────────────────────────────────────────────────────────────────────────
// Aritmética de fechas, explícita
//
// `new Date(ms)` con argumento SÍ es puro: lo que el motor no puede hacer es
// preguntar la hora. Todas las funciones de abajo derivan de `refDate`.
// ─────────────────────────────────────────────────────────────────────────────

const MS_POR_DIA = 24 * 60 * 60 * 1000

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_POR_DIA)
}

// ─────────────────────────────────────────────────────────────────────────────
// Mapeo de los estados de Stripe
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Traduce el `status` de una suscripción de Stripe al nuestro.
 *
 * Un estado **desconocido** no se adivina: se trata como `INCOMPLETE`, que es el
 * más conservador de los que dejan `READ_ONLY` sin cancelar nada. Suponer
 * `ACTIVE` regalaría el producto; suponer `CANCELED` se lo quitaría a quien paga.
 *
 * `unpaid` de Stripe se mapea a `PAST_DUE` y **no** a `CANCELED`: para Stripe es
 * el estado al que cae una suscripción tras agotar los reintentos, pero el
 * contrato sigue vivo y el cliente puede pagar. La gracia la decide `graceUntilOf`.
 */
export function mapStripeStatus(raw: string): SubscriptionStatus {
  switch (raw) {
    case "trialing":
      return "TRIALING"
    case "active":
      return "ACTIVE"
    case "past_due":
    case "unpaid":
      return "PAST_DUE"
    case "canceled":
      return "CANCELED"
    case "incomplete":
    case "incomplete_expired":
      return "INCOMPLETE"
    case "paused":
      return "PAUSED"
    default:
      return "INCOMPLETE"
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Gracia (P-2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fecha hasta la que una suscripción impagada conserva el acceso COMPLETO.
 *
 * Se cuenta desde el **fin del periodo pagado** (`currentPeriodEnd`), no desde
 * hoy: si no fuera así, cada visita a la página movería la fecha hacia delante y
 * la gracia no caducaría nunca. Sin `currentPeriodEnd` conocido se cuenta desde
 * `refDate`, que es lo único disponible, y el aviso lo dice.
 *
 * `graceDays = 0` (el FREE, P-2 · §17.1) devuelve la propia fecha de corte: no
 * hay gracia, pero tampoco un `null` que el llamante tenga que interpretar.
 *
 * Sólo tiene sentido en `PAST_DUE`/`GRACE`; en cualquier otro estado devuelve
 * `null`, porque no hay nada que graciar.
 */
export function graceUntilOf(
  sub: Pick<SubscriptionRow, "status" | "currentPeriodEnd" | "graceUntil">,
  limits: { graceDays: number },
  refDate: Date
): Date | null {
  if (sub.status !== "PAST_DUE" && sub.status !== "GRACE") return null
  // Una gracia ya fijada NO se recalcula: es una promesa hecha al cliente con
  // una fecha concreta a la vista, y moverla —en cualquier dirección— sería
  // cambiarle las reglas a mitad del impago.
  if (sub.graceUntil) return sub.graceUntil
  const desde = sub.currentPeriodEnd ?? refDate
  return addDays(desde, limits.graceDays)
}

/**
 * Ventana de descarga tras `CANCELED` (**O-4**, ADR-0019 D5): 90 días, **por
 * encima** de la retención del plan. *La portabilidad no la puede desactivar un
 * precio.*
 */
export function exportWindowUntilOf(
  sub: Pick<SubscriptionRow, "status" | "exportWindowUntil" | "currentPeriodEnd">,
  refDate: Date
): Date | null {
  if (sub.status !== "CANCELED") return sub.exportWindowUntil
  if (sub.exportWindowUntil) return sub.exportWindowUntil
  return addDays(sub.currentPeriodEnd ?? refDate, EXPORT_WINDOW_DAYS)
}

// ─────────────────────────────────────────────────────────────────────────────
// Estado ⇔ acceso (I-E11-5)
// ─────────────────────────────────────────────────────────────────────────────

export type AccessVerdict = {
  level: AccessLevel
  /** Motivo en español, listo para la cabecera. `null` cuando el acceso es pleno. */
  reason: string | null
  /** Fecha exacta hasta la que dura la gracia, cuando la hay. */
  graceUntil: Date | null
}

const FMT = new Intl.DateTimeFormat("es-ES", { day: "2-digit", month: "2-digit", year: "numeric" })

/** Fecha en español para el aviso. Determinista: no mira el reloj ni la zona. */
function diaEs(d: Date): string {
  return FMT.format(d)
}

/**
 * El nivel efectivo de acceso de una organización.
 *
 * `organizationIsActive = false` es lo **único** que produce `BLOCKED`, y lo
 * decide el propio ADMIN de la organización. Ni el impago, ni la cuota agotada,
 * ni un estado raro de Stripe bloquean: eso es ADR-0019 D6 y se comprueba en
 * I-E11-5.
 */
export function accessLevelOf(
  sub: Pick<SubscriptionRow, "status" | "currentPeriodEnd" | "graceUntil">,
  limits: { graceDays: number },
  refDate: Date,
  opts: { organizationIsActive?: boolean } = {}
): AccessVerdict {
  if (opts.organizationIsActive === false) {
    return {
      level: "BLOCKED",
      reason: "La organización está desactivada por su administrador.",
      graceUntil: null,
    }
  }

  switch (sub.status) {
    case "ACTIVE":
      return { level: "FULL", reason: null, graceUntil: null }

    case "TRIALING":
      return { level: "FULL", reason: null, graceUntil: null }

    case "PAST_DUE":
    case "GRACE": {
      const hasta = graceUntilOf(sub, limits, refDate)
      if (hasta && refDate.getTime() <= hasta.getTime()) {
        return {
          level: "FULL",
          reason:
            `Hay un recibo pendiente de pago. Conserva el acceso completo hasta el ${diaEs(hasta)}; ` +
            "a partir de esa fecha la organización pasa a sólo lectura, pero podrá seguir " +
            "consultando, exportando y descargando una copia de sus libros.",
          graceUntil: hasta,
        }
      }
      return {
        level: "READ_ONLY",
        reason:
          "La suscripción está impagada y el plazo de gracia ha terminado: la organización está en " +
          "sólo lectura. Puede seguir consultando y exportando sus libros, descargar una copia " +
          "completa de sus datos y registrar los hechos contables ya ocurridos. " +
          "Regularice el pago para recuperar el resto.",
        graceUntil: hasta,
      }
    }

    case "CANCELED":
      return {
        level: "READ_ONLY",
        reason:
          "La suscripción está cancelada. La llevanza sigue siendo suya: puede consultar, exportar " +
          "y descargar una copia completa de sus libros sin coste ni límite.",
        graceUntil: null,
      }

    case "PAUSED":
      return {
        level: "READ_ONLY",
        reason: "La suscripción está en pausa: la organización está en sólo lectura.",
        graceUntil: null,
      }

    case "INCOMPLETE":
      return {
        level: "READ_ONLY",
        reason:
          "La suscripción no ha llegado a activarse (el primer pago no se completó). " +
          "Complete el pago para activar la organización.",
        graceUntil: null,
      }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Qué sobrevive a la mora (O-3, O-16)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Las clases de escritura que la mora **no** detiene. Lista cerrada, verificada
 * por I-E11-5 contra las acciones marcadas `allowInReadOnly`.
 *
 * `REGISTRO_CONTABLE_ORDINARIO` está dentro: es la corrección de **O-3**. Un
 * diario con un salto de tres semanas y un ticket que diga «límite de plan» lo
 * rechaza un auditor, y el impedimento lo habríamos creado nosotros (art. 28.2
 * CCom, plazos del SII). Registrar un hecho ya ocurrido no es un favor que se
 * retira por un impago: es una obligación del cliente que nosotros no podemos
 * suspender.
 *
 * `CONSUMO_IA` está fuera, y es la asimetría de **O-16**: el OCR es consumo de
 * un proveedor que pagamos nosotros, no un acto de llevanza, y el documento se
 * puede registrar y contabilizar a mano.
 */
export function isPermittedInArrears(op: WriteKind): boolean {
  switch (op) {
    case "CONTRA_ASIENTO":
    case "OBLIGACION_DEVENGADA":
    case "REGISTRO_CONTABLE_ORDINARIO":
    case "REGISTRO_DOCUMENTAL":
    case "PORTABILIDAD":
    case "FACTURACION_PROPIA":
      return true
    case "CONSUMO_IA":
    case "ORDINARIA":
      return false
  }
}

/** Las clases permitidas en mora, enumerables: I-E11-5 las recorre. */
export const WRITE_KINDS_PERMITTED_IN_ARREARS: readonly WriteKind[] = [
  "CONTRA_ASIENTO",
  "OBLIGACION_DEVENGADA",
  "REGISTRO_CONTABLE_ORDINARIO",
  "REGISTRO_DOCUMENTAL",
  "PORTABILIDAD",
  "FACTURACION_PROPIA",
] as const

/**
 * ¿Se puede ejecutar esta clase de escritura con este nivel de acceso?
 *
 * `BLOCKED` no admite ninguna: la desactivación la decidió el propio ADMIN de la
 * organización y no es una mora nuestra.
 */
export function canWrite(level: AccessLevel, op: WriteKind): boolean {
  if (level === "FULL") return true
  if (level === "BLOCKED") return false
  return isPermittedInArrears(op)
}
