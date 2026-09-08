/**
 * E7 · T5 — Agregación por familia y semáforo (`docs/design/E7-auditoria.md` §3.1).
 *
 * La composición del semáforo se escribe **una sola vez**, aquí:
 *
 * > un solo FAIL pinta la familia en **FALLO**; sin FAIL, un WARN la pinta en
 * > **AVISO**; si todo lo que hay es INFO —o no hay nada—, **`SIN_EVALUAR`**, que
 * > no es «OK».
 *
 * Ese último punto es el riesgo R3 de la épica y el fallo más peligroso de una
 * pestaña de auditoría: un semáforo en verde con la mitad sin evaluar. Por eso
 * `SIN_EVALUAR` es un estado propio y no un color más suave del verde.
 *
 * Un id que nadie ha clasificado se devuelve como `INTEGRIDAD` **y** se declara
 * en `unknownIds`: un check nuevo no puede desaparecer del semáforo por olvidar
 * añadirlo a una tabla.
 *
 * Módulo PURO.
 */

import type { AuditCounts, CheckFamily, CheckResult, FamilyStatus, FamilySummary } from "@/lib/audit/types"

/** Orden de presentación de las tarjetas (§6). E9 añade `CIERRE` (§6.3). */
export const CHECK_FAMILIES: readonly CheckFamily[] = [
  "PARTIDA_DOBLE",
  "ESTADOS",
  "ANALITICA",
  "LIQUIDACION",
  "DOCUMENTAL",
  "CONCILIACION",
  "CIERRE",
  "INTEGRIDAD",
]

export const FAMILY_LABEL: Readonly<Record<CheckFamily, string>> = {
  PARTIDA_DOBLE: "Partida doble",
  ESTADOS: "Estados financieros",
  ANALITICA: "Analítica",
  LIQUIDACION: "Liquidación de CECOs",
  DOCUMENTAL: "Camino documental",
  CONCILIACION: "Conciliación bancaria",
  CIERRE: "Cierre y recurrentes",
  INTEGRIDAD: "Integridad y trazabilidad",
}

/** Ids con familia asignada explícitamente, cuando el prefijo no basta. */
const EXPLICIT: Readonly<Record<string, CheckFamily>> = {
  I1: "PARTIDA_DOBLE",
  "N-5": "PARTIDA_DOBLE",
  I2: "ESTADOS",
  I3: "ESTADOS",
  I6: "ESTADOS",
  I4: "ANALITICA",
  I5: "LIQUIDACION",
  I7: "INTEGRIDAD",
  I8: "INTEGRIDAD",
  I9: "INTEGRIDAD",
  I10: "INTEGRIDAD",
}

/** Los I-E7-* no caen en una sola familia: cada uno audita lo suyo (§3.1). */
const E7_FAMILY: Readonly<Record<string, CheckFamily>> = {
  "I-E7-1": "CONCILIACION",
  "I-E7-2": "CONCILIACION",
  "I-E7-3": "CONCILIACION",
  "I-E7-4": "CONCILIACION",
  "I-E7-5": "CONCILIACION",
  "I-E7-6a": "CONCILIACION",
  "I-E7-6b": "CONCILIACION",
  "I-E7-7": "INTEGRIDAD",
  "I-E7-8": "DOCUMENTAL",
  "I-E7-9": "LIQUIDACION",
  "I-E7-10": "LIQUIDACION",
  "I-E7-11": "CONCILIACION",
  "I-E7-12": "CONCILIACION",
  "I-E7-13": "CONCILIACION",
  "I-E7-14": "ESTADOS",
  "I-E7-15": "ESTADOS",
  "I-E7-16": "ESTADOS",
  "I-E7-17": "ESTADOS",
}

const PREFIX: readonly [string, CheckFamily][] = [
  ["I-E3-", "PARTIDA_DOBLE"],
  ["I-E4-", "ANALITICA"],
  ["I-E5-", "LIQUIDACION"],
  ["I-E6-", "ESTADOS"],
  ["I-E8-", "DOCUMENTAL"],
  // E9 · §6.3: los I-E9-* (incluidos 1a/1b, 8a′ y 10b) van a la familia CIERRE.
  ["I-E9-", "CIERRE"],
]

/**
 * Familia de un check. Un id desconocido cae en `INTEGRIDAD` —nunca se pierde—
 * y `unknownCheckIds` lo nombra para que alguien lo clasifique.
 */
export function familyOf(checkId: string): CheckFamily {
  const id = checkId.trim()
  const explicit = EXPLICIT[id]
  if (explicit !== undefined) return explicit
  const e7 = E7_FAMILY[id]
  if (e7 !== undefined) return e7
  for (const [prefix, family] of PREFIX) if (id.startsWith(prefix)) return family
  return "INTEGRIDAD"
}

/** ¿Está el id declarado en alguna tabla, o lo estamos acogiendo por defecto? */
export function isKnownCheckId(checkId: string): boolean {
  const id = checkId.trim()
  if (EXPLICIT[id] !== undefined || E7_FAMILY[id] !== undefined) return true
  return PREFIX.some(([prefix]) => id.startsWith(prefix))
}

export function unknownCheckIds(checks: readonly CheckResult[]): readonly string[] {
  return [...new Set(checks.filter((c) => !isKnownCheckId(c.id)).map((c) => c.id))].sort()
}

export function countsOf(checks: readonly CheckResult[]): AuditCounts {
  const counts: AuditCounts = { PASS: 0, FAIL: 0, WARN: 0, INFO: 0, total: checks.length }
  for (const check of checks) counts[check.status] += 1
  return counts
}

/**
 * El semáforo de una familia. `SIN_EVALUAR` cuando no hay ni un PASS: sólo INFO,
 * o nada. **Un INFO jamás se pinta como OK** (criterio 2).
 */
export function familyStatus(checks: readonly CheckResult[]): FamilyStatus {
  if (checks.some((c) => c.status === "FAIL")) return "FALLO"
  if (checks.some((c) => c.status === "WARN")) return "AVISO"
  if (checks.some((c) => c.status === "PASS")) return "OK"
  return "SIN_EVALUAR"
}

/**
 * Las familias SIEMPRE, en orden fijo y aunque estén vacías: una familia
 * que desaparece de la pantalla porque nadie la evaluó es exactamente el
 * silencio que R3 describe.
 */
export function groupByFamily(checks: readonly CheckResult[]): FamilySummary[] {
  const byFamily = new Map<CheckFamily, CheckResult[]>()
  for (const family of CHECK_FAMILIES) byFamily.set(family, [])
  for (const check of checks) byFamily.get(familyOf(check.id))?.push(check)
  return CHECK_FAMILIES.map((family) => {
    const list = byFamily.get(family) ?? []
    return {
      family,
      status: familyStatus(list),
      counts: countsOf(list),
      checkIds: list.map((c) => c.id),
    }
  })
}

/** Semáforo global: el peor de todas, con la misma composición. */
export function globalStatus(checks: readonly CheckResult[]): FamilyStatus {
  return familyStatus(checks)
}
