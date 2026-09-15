/**
 * E11 · ola A — resolución y sello del catálogo de planes (§3.3, ADR-0019 D1.1).
 *
 * **PURO**: la fecha entra por `refDate`.
 *
 * El catálogo es global y **versionado por vigencia**. La base garantiza que no
 * hay solape (`EXCLUDE USING gist` de M1). Si aun así aparecieran dos versiones
 * vigentes el mismo día, `resolvePlanAt` **LANZA**: nunca «la primera que
 * aparezca». Dos juegos de límites vigentes a la vez son un cliente al que nadie
 * sabe qué se le prometió, y elegir en silencio convierte un fallo de datos en
 * una decisión comercial arbitraria.
 */

import { createHash } from "node:crypto"

import type { PlanLimits, PlanRow } from "./types"

export class PlanResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PlanResolutionError"
  }
}

/** Compara sólo el día: las vigencias son `@db.Date`, sin hora. */
function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}`
}

/** Vigencia cerrada por ambos extremos, inclusive: `[validFrom, validTo]`. */
function vigenteEn(plan: PlanRow, day: string): boolean {
  if (ymd(plan.validFrom) > day) return false
  if (plan.validTo && ymd(plan.validTo) < day) return false
  return true
}

/**
 * La versión del plan `code` vigente en `refDate`.
 *
 * @throws {PlanResolutionError} si no hay ninguna (el catálogo está incompleto
 *   para esa fecha) o si hay dos (el `EXCLUDE` de la base se ha saltado por un
 *   `UPDATE` directo, y eso hay que verlo, no absorberlo).
 */
export function resolvePlanAt(plans: readonly PlanRow[], code: string, refDate: Date): PlanRow {
  const day = ymd(refDate)
  const candidatos = plans.filter((p) => p.code === code && vigenteEn(p, day))

  if (candidatos.length === 0) {
    throw new PlanResolutionError(
      `No hay ninguna versión del plan ${code} vigente el ${day}. ` +
        "El catálogo de planes lo cambia una migración: revise las vigencias sembradas."
    )
  }
  if (candidatos.length > 1) {
    const ids = candidatos.map((p) => `${p.id} (${ymd(p.validFrom)})`).join(", ")
    throw new PlanResolutionError(
      `El plan ${code} tiene ${candidatos.length} versiones vigentes el ${day}: ${ids}. ` +
        "Las vigencias no pueden solaparse (EXCLUDE USING gist en `plans`): " +
        "no se elige una por conveniencia."
    )
  }
  return candidatos[0]
}

/** Los límites de una versión, sin el resto de la ficha comercial. */
export function limitsOf(plan: PlanRow): PlanLimits {
  return {
    maxMembers: plan.maxMembers,
    maxOcrDocsMonth: plan.maxOcrDocsMonth,
    maxStorageBytes: plan.maxStorageBytes,
    maxExportsMonth: plan.maxExportsMonth,
    maxBackupsMonth: plan.maxBackupsMonth,
    maxOrganizations: plan.maxOrganizations,
    softMaxEntriesMonth: plan.softMaxEntriesMonth,
    graceDays: plan.graceDays,
    backupRetentionDays: plan.backupRetentionDays,
  }
}

/**
 * Sello del catálogo, en **forma canónica** (ADR-0011): las filas ordenadas por
 * `(code, validFrom)` y cada campo con su nombre, separadores explícitos y los
 * `bigint` en decimal.
 *
 * Sirve para dos cosas: detectar que el catálogo cambió sin migración (una fila
 * tocada por SQL) y entrar como fuente en la caché de uso. **No entra ninguna
 * cifra derivada**: se validaría a sí misma.
 */
export function planCatalogHash(plans: readonly PlanRow[]): string {
  const ordenadas = [...plans].sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1
    const fa = ymd(a.validFrom)
    const fb = ymd(b.validFrom)
    return fa < fb ? -1 : fa > fb ? 1 : 0
  })

  const canonico = ordenadas
    .map((p) =>
      [
        `code=${p.code}`,
        `validFrom=${ymd(p.validFrom)}`,
        `validTo=${p.validTo ? ymd(p.validTo) : ""}`,
        `listPriceCents=${p.listPriceCents}`,
        `currency=${p.currency}`,
        `interval=${p.interval}`,
        `stripePriceId=${p.stripePriceId ?? ""}`,
        `maxMembers=${p.maxMembers}`,
        `maxOcrDocsMonth=${p.maxOcrDocsMonth}`,
        `maxStorageBytes=${p.maxStorageBytes.toString()}`,
        `maxExportsMonth=${p.maxExportsMonth}`,
        `maxBackupsMonth=${p.maxBackupsMonth}`,
        `maxOrganizations=${p.maxOrganizations}`,
        `softMaxEntriesMonth=${p.softMaxEntriesMonth}`,
        `graceDays=${p.graceDays}`,
        `backupRetentionDays=${p.backupRetentionDays}`,
        `isPublic=${p.isPublic ? "1" : "0"}`,
      ].join("|")
    )
    .join("\n")

  return createHash("sha256").update(canonico, "utf8").digest("hex")
}

/**
 * Los planes que se pueden ofrecer en el alta a `refDate`: públicos y vigentes,
 * la versión más reciente de cada código.
 *
 * **P-1 · FREE no es vendible**: aparece en el alta (`isPublic`) pero sin
 * `stripePriceId` no hay checkout posible, y `startCheckout` lo rechaza.
 */
export function publicPlansAt(plans: readonly PlanRow[], refDate: Date): PlanRow[] {
  const day = ymd(refDate)
  const codes = [...new Set(plans.map((p) => p.code))].sort()
  const salida: PlanRow[] = []
  for (const code of codes) {
    const vigentes = plans.filter((p) => p.code === code && p.isPublic && vigenteEn(p, day))
    if (vigentes.length === 1) salida.push(vigentes[0])
    else if (vigentes.length > 1) throw new PlanResolutionError(`El plan ${code} tiene vigencias solapadas el ${day}`)
  }
  return salida.sort((a, b) => a.listPriceCents - b.listPriceCents)
}

/** ¿Se puede contratar? Sin precio en Stripe, no (P-1). */
export function isSellable(plan: PlanRow): boolean {
  return plan.listPriceCents > 0 && !!plan.stripePriceId
}
