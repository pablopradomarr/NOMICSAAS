/**
 * E11 · T9 — **dos clases de cuota** (§3.5, **O-3**, **O-4**, **O-16**;
 * ADR-0019 **D7**).
 *
 * > **La regla, textual, y está en el ADR (D7):** *«Ningún límite de plan puede
 * > impedir el registro de un hecho contable ya ocurrido, ni en cuota agotada ni
 * > en mora.»*
 *
 * De ahí salen tres regímenes y no uno:
 *
 * | Clase | Claves | Régimen |
 * |---|---|---|
 * | **Cuota de recurso** — consumo real nuestro | `maxMembers`, `maxOcrDocsMonth`, `maxExportsMonth`, `maxBackupsMonth`, `maxOrganizations` | **Bloqueo legítimo.** No son hechos contables: son recursos de la plataforma |
 * | **Cuota de recurso con excepción por mora (O-16)** | `maxStorageBytes` | **Dura en `FULL`, blanda fuera de `FULL`.** Subir el justificante de un hecho ya ocurrido es parte del registro (art. 30 CCom, 165 LIVA): en mora avisa y deja subir |
 * | **Cuota sobre el registro contable** | `softMaxEntriesMonth` | **Blanda.** Nunca rechaza un `postEntry` |
 *
 * ## Por qué el tipo lo impide, y no una convención
 *
 * `checkLimit` sólo devuelve `ok: false` con una `HardLimitKey`. Una clave
 * blanda **no puede** producir un rechazo: el tipo de retorno no lo admite. Es
 * la diferencia entre una regla escrita en un documento y una regla que el
 * compilador sostiene — y la ronda 1 de la validación demostró que la primera no
 * basta (`maxEntriesMonth` pasaba por el guardián y el asiento 2.001 se
 * rechazaba).
 *
 * ## La excepción es automática y registrada
 *
 * La ronda 1 admitía superar un límite «si existe un `AuditLog` de excepción con
 * motivo», pero `/admin` es de sólo lectura y **nadie podía concederla**: un
 * callejón sin salida. Ahora la concede el propio motor al rebasar una cuota
 * blanda y queda en `PlatformAuditLog` (lo escribe `models/platform-limits.ts`).
 *
 * Módulo **PURO**: sin IO, sin `prisma`, sin `Date.now()`.
 */

import {
  HARD_LIMIT_KEYS,
  UNLIMITED,
  type AccessLevel,
  type HardLimitKey,
  type PlanLimits,
  type SoftLimitKey,
} from "@/lib/platform/types"

export { HARD_LIMIT_KEYS, UNLIMITED }
export type { AccessLevel, HardLimitKey, PlanLimits, SoftLimitKey }

/** El uso, en la misma escala que los límites. */
export type LimitUsage = {
  maxMembers: bigint
  maxOcrDocsMonth: bigint
  maxStorageBytes: bigint
  maxExportsMonth: bigint
  maxBackupsMonth: bigint
  maxOrganizations: bigint
  softMaxEntriesMonth: bigint
}

export type SoftWarning = {
  key: SoftLimitKey | "maxStorageBytes"
  current: bigint
  soft: bigint
  /** Puntos básicos de consumo: 8000 = 80 %. El aviso es al 80 % y al 100 %. */
  usedBps: number
  /** Motivo de plataforma que se enseña en cabecera y en /audit. */
  code: PlatformLimitReason
}

export type LimitVerdict =
  | { ok: true; warn?: SoftWarning }
  | { ok: false; key: HardLimitKey; current: bigint; limit: bigint; message: string }

/** Motivos de plataforma. Se enseñan en cabecera, en /settings y en /audit. */
export type PlatformLimitReason = "CUOTA_DE_ASIENTOS_SUPERADA" | "CUOTA_DE_ALMACEN_SUPERADA_EN_MORA"

/** Umbral del primer aviso: 80 % en puntos básicos. */
export const SOFT_WARNING_BPS = 8000

/** Nombre en español de cada cuota, para el mensaje de rechazo. */
export const HARD_LIMIT_LABELS_ES: Readonly<Record<HardLimitKey, string>> = {
  maxMembers: "miembros de la organización",
  maxOcrDocsMonth: "documentos analizados este mes",
  maxStorageBytes: "almacenamiento",
  maxExportsMonth: "exportaciones este mes",
  maxBackupsMonth: "copias de seguridad este mes",
  maxOrganizations: "organizaciones",
}

/**
 * **`maxStorageBytes` fuera de `FULL` es BLANDA** (O-16). Subir el justificante
 * de un hecho ya ocurrido es parte del registro; el OCR, no.
 */
export function isHardAt(key: HardLimitKey, access: AccessLevel): boolean {
  if (key === "maxStorageBytes") return access === "FULL"
  return true
}

/** Formato humano de bytes, para el mensaje. Sin decimales inventados. */
function humanBytes(value: bigint): string {
  const units = ["B", "KB", "MB", "GB", "TB"]
  let index = 0
  let n = Number(value)
  while (n >= 1024 && index < units.length - 1) {
    n /= 1024
    index += 1
  }
  return `${index === 0 ? n : n.toFixed(1)} ${units[index]}`
}

const formatFor = (key: HardLimitKey, value: bigint): string =>
  key === "maxStorageBytes" ? humanBytes(value) : value.toString()

function usedBpsOf(current: bigint, limit: bigint): number {
  if (limit <= BigInt(0)) return 0
  const bps = (current * BigInt(10000)) / limit
  return Number(bps > BigInt(1_000_000) ? BigInt(1_000_000) : bps)
}

/**
 * **El veredicto.** PURA. `-1` (ilimitado) se resuelve antes de mirar el uso; una
 * clave blanda NUNCA devuelve `ok: false` porque el tipo no lo permite.
 *
 * `delta` es lo que la operación va a consumir: 1 plaza, 1 run de OCR, los bytes
 * del fichero. Se suma al uso ANTES de comparar, porque la pregunta no es «¿estoy
 * por debajo?» sino «¿seguiré por debajo después de esto?».
 */
export function checkLimit(
  key: HardLimitKey,
  usage: LimitUsage,
  limits: PlanLimits,
  delta: bigint,
  access: AccessLevel
): LimitVerdict {
  if (delta < BigInt(0)) throw new Error(`checkLimit: delta no puede ser negativo (${key} = ${delta})`)

  const rawLimit = limits[key]
  const limit = typeof rawLimit === "bigint" ? rawLimit : BigInt(rawLimit)
  if (limit < BigInt(0)) return { ok: true } // ilimitado

  const current = usage[key]
  const after = current + delta

  if (after <= limit) {
    // Aviso temprano sólo en la clave que puede degradarse a blanda; el resto
    // avisa en la interfaz, no aquí.
    if (key === "maxStorageBytes") {
      const bps = usedBpsOf(after, limit)
      if (bps >= SOFT_WARNING_BPS && access !== "FULL") {
        return {
          ok: true,
          warn: {
            key: "maxStorageBytes",
            current: after,
            soft: limit,
            usedBps: bps,
            code: "CUOTA_DE_ALMACEN_SUPERADA_EN_MORA",
          },
        }
      }
    }
    return { ok: true }
  }

  if (!isHardAt(key, access)) {
    // **O-16**: excepción automática y registrada. No impide subir el papel.
    return {
      ok: true,
      warn: {
        key: "maxStorageBytes",
        current: after,
        soft: limit,
        usedBps: usedBpsOf(after, limit),
        code: "CUOTA_DE_ALMACEN_SUPERADA_EN_MORA",
      },
    }
  }

  return {
    ok: false,
    key,
    current,
    limit,
    message:
      `Se ha alcanzado el límite del plan para ${HARD_LIMIT_LABELS_ES[key]}: ` +
      `${formatFor(key, after)} sobre un máximo de ${formatFor(key, limit)}. ` +
      `Cambia de plan o libera cuota; los libros y las exportaciones siguen disponibles.`,
  }
}

/**
 * **La cuota blanda del registro contable** (O-3). No devuelve un rechazo porque
 * no existe el rechazo: devuelve el aviso, y quien la llama lo enseña y sigue
 * adelante. Bloquea sólo lo **accesorio** (la demo, las importaciones masivas,
 * organizaciones nuevas), nunca un asiento.
 */
export function checkSoftEntries(
  entriesThisMonth: bigint,
  limits: PlanLimits,
  delta: bigint = BigInt(1)
): { warn: SoftWarning | null; blocksAccessory: boolean } {
  const soft = BigInt(limits.softMaxEntriesMonth)
  if (soft < BigInt(0)) return { warn: null, blocksAccessory: false }
  const after = entriesThisMonth + delta
  const bps = usedBpsOf(after, soft)
  if (bps < SOFT_WARNING_BPS) return { warn: null, blocksAccessory: false }
  return {
    warn: {
      key: "softMaxEntriesMonth",
      current: after,
      soft,
      usedBps: bps,
      code: "CUOTA_DE_ASIENTOS_SUPERADA",
    },
    blocksAccessory: after > soft,
  }
}

/**
 * **Portabilidad sin cuota** (O-4). Tres reglas del ADR, en una función:
 *
 * 1. El backup de salida (`EXIT`) no consume `maxBackupsMonth`. Nunca.
 * 2. Tampoco lo consume ninguno pedido por una organización que no esté en
 *    `FULL`: `maxBackupsMonth` **nunca** se aplica fuera de `FULL`.
 * 3. El programado (`SCHEDULED`) tampoco: no lo pide el cliente.
 *
 * Sin esto, un FREE con `maxBackupsMonth = 1` que ya gastó su backup del mes no
 * puede llevarse sus libros — la portabilidad que D6 declara innegociable
 * desactivada por un número de la tabla de precios.
 */
export function backupConsumesQuota(trigger: "MANUAL" | "SCHEDULED" | "EXIT", access: AccessLevel): boolean {
  if (trigger !== "MANUAL") return false
  return access === "FULL"
}

/** Mensaje de `READ_ONLY`, en español y sin eufemismo (§3.2). */
export const READ_ONLY_MESSAGE_ES =
  "La suscripción está pendiente de pago. Puedes seguir registrando hechos contables, anular por contra-asiento, " +
  "subir justificantes, consultar, exportar y descargar una copia completa de tus libros: la llevanza sigue siendo " +
  "tuya y tus datos también. Lo que queda suspendido es el análisis automático de documentos y la creación de " +
  "organizaciones nuevas."
