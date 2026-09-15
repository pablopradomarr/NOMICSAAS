/**
 * E11 · ola A — tipos de la plataforma (docs/design/E11-plataforma-saas.md §3.1).
 *
 * Este fichero, y todo `lib/platform/**`, es **PURO**: sin IO, sin BD, sin LLM y
 * **sin reloj implícito** — la fecha entra por `refDate`. Lo vigilan
 * `eslint.config.mjs` (`PURE_ENGINE_DIRS`) y `.claude/hooks/guard.sh`, los dos
 * extendidos a `lib/platform/` en T1.
 *
 * Aquí no hay ninguna cifra contable: la plataforma cobra, mide y limita, pero
 * **no toca el diario del cliente** (I-E11-8).
 */

import type { SubscriptionStatus, TaxTreatment } from "@/prisma/client"

// ─────────────────────────────────────────────────────────────────────────────
// Límites (§3.1, §3.5 — ADR-0019 D7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cuotas de **recurso**: consumo real nuestro, y por tanto bloqueo legítimo. No
 * son hechos contables — son plazas, análisis de un proveedor que pagamos,
 * bytes y ejecuciones.
 */
export type HardLimitKey =
  | "maxMembers"
  | "maxOcrDocsMonth"
  | "maxStorageBytes"
  | "maxExportsMonth"
  | "maxBackupsMonth"
  | "maxOrganizations"

/**
 * **O-3 · la única cuota sobre el registro contable, y es BLANDA.**
 *
 * *«Ningún límite de plan puede impedir el registro de un hecho contable ya
 * ocurrido, ni en cuota agotada ni en mora»* (ADR-0019 D7). El nombre lleva
 * `soft` para que nadie la cablee al guardián por descuido, y el tipo lo remata:
 * `assertWithinLimit` sólo acepta `HardLimitKey`, de modo que pasar ésta **no
 * compila**. I-E11-4c lo vuelve a comprobar contra el AST.
 */
export type SoftLimitKey = "softMaxEntriesMonth"

export type LimitKey = HardLimitKey | SoftLimitKey

/** Lista cerrada y enumerable de las cuotas duras: la recorre I-E11-4a. */
export const HARD_LIMIT_KEYS: readonly HardLimitKey[] = [
  "maxMembers",
  "maxOcrDocsMonth",
  "maxStorageBytes",
  "maxExportsMonth",
  "maxBackupsMonth",
  "maxOrganizations",
] as const

export const SOFT_LIMIT_KEYS: readonly SoftLimitKey[] = ["softMaxEntriesMonth"] as const

/** `-1` significa ILIMITADO y se resuelve ANTES de mirar el uso (criterio 19). */
export const UNLIMITED = BigInt(-1)

// ─────────────────────────────────────────────────────────────────────────────
// Acceso (§3.2 — ADR-0019 D6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `BLOCKED` **no lo produce jamás un impago**: sólo la desactivación que decide
 * el propio ADMIN de la organización (ADR-0019 D6). Un cliente que no paga
 * pierde la escritura ordinaria; nunca la lectura ni la exportación.
 */
export type AccessLevel = "FULL" | "READ_ONLY" | "BLOCKED"

/**
 * Las cuatro clases de escritura que la mora **no** detiene (§3.2). Lista
 * cerrada: I-E11-5 la enfrenta a las acciones marcadas `allowInReadOnly`.
 *
 * - `CONTRA_ASIENTO`: única forma de corregir (ADR-0003). Impedirla dejaría el
 *   error dentro del diario.
 * - `OBLIGACION_DEVENGADA`: recurrentes vencidos, devengo RECC (T-36),
 *   liquidación de IVA del periodo y los cuatro del cierre si el ejercicio vence
 *   durante la mora.
 * - `REGISTRO_DOCUMENTAL`: la anotación en el libro registro no se suspende
 *   porque nosotros no hayamos cobrado. **O-16**: incluye *subir el papel*
 *   (`uploadFileAction`) —sin bytes no hay `sha256` ni I-E8-2 que valga—, y
 *   **no** incluye `analyzeFileAction`: el OCR es consumo de un proveedor que
 *   pagamos nosotros, no un acto de llevanza.
 * - `PORTABILIDAD`: exportar, consultar y pedir un backup (D5 + D6 + O-4).
 * - `FACTURACION_PROPIA`: checkout y portal, que es **cómo se sale del impago**.
 * - `ORDINARIA`: todo lo demás. Es la única que la mora detiene… salvo el
 *   posteo, que O-3 saca de la cuota pero no de esta clase: véase
 *   `isPermittedInArrears`.
 */
export type WriteKind =
  | "CONTRA_ASIENTO"
  | "OBLIGACION_DEVENGADA"
  | "REGISTRO_CONTABLE_ORDINARIO"
  | "REGISTRO_DOCUMENTAL"
  | "PORTABILIDAD"
  | "FACTURACION_PROPIA"
  | "CONSUMO_IA"
  | "ORDINARIA"

// ─────────────────────────────────────────────────────────────────────────────
// Filas que consumen las funciones puras
//
// Son formas ESTRUCTURALES, no los tipos de Prisma: el motor no importa el
// cliente (no puede) y así los tests se escriben con literales.
// ─────────────────────────────────────────────────────────────────────────────

export type PlanLimits = {
  maxMembers: number
  maxOcrDocsMonth: number
  maxStorageBytes: bigint
  maxExportsMonth: number
  maxBackupsMonth: number
  maxOrganizations: number
  softMaxEntriesMonth: number
  graceDays: number
  backupRetentionDays: number
}

export type PlanRow = PlanLimits & {
  id: string
  code: string
  name: string
  listPriceCents: number
  currency: string
  interval: "MONTH" | "YEAR"
  stripePriceId: string | null
  isPublic: boolean
  validFrom: Date
  validTo: Date | null
}

export type SubscriptionRow = {
  organizationId: string
  planCode: string
  planId: string
  status: SubscriptionStatus
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
  cancelAtPeriodEnd: boolean
  trialEnd: Date | null
  graceUntil: Date | null
  exportWindowUntil: Date | null
  customerCountry: string | null
  vatNumber: string | null
  vatValidatedAt: Date | null
}

/** Ventana mínima de descarga tras `CANCELED` (O-4, ADR-0019 D5). */
export const EXPORT_WINDOW_DAYS = 90

// ─────────────────────────────────────────────────────────────────────────────
// Facturación de la plataforma (§2.2, C-1…C-5 — ADR-0019 D8)
// ─────────────────────────────────────────────────────────────────────────────

export type { TaxTreatment }

/**
 * Destinatario, tal y como hay que conocerlo **en el devengo** para decidir el
 * tratamiento. `viesValid` es el resultado de la consulta de ESE momento, no del
 * alta: un NIF-IVA se da de baja (C-1).
 */
export type InvoiceRecipient = {
  /** ISO-3166-1 alfa-2, en mayúsculas. */
  country: string
  vatNumber: string | null
  /** `null` = no se pudo consultar (VIES caído). **No es lo mismo que `false`.** */
  viesValid: boolean | null
}

export type TaxDecision = {
  treatment: TaxTreatment
  /** Puntos básicos de IVA repercutido: 2 100 = 21 %. Cero en no sujeción. */
  rateBps: number
  /** Texto impreso de la mención del art. 6.1.m RD 1619/2012, si procede. */
  mention: string | null
  /** Por qué, en español, para la pantalla y para `PlatformAuditLog`. */
  reason: string
}
