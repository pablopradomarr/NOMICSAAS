/**
 * E7 · T5 — Dos barridos comparados (`docs/design/E7-auditoria.md` §3.3).
 *
 * La exigencia es la de SPEC-FIABILIDAD §0: «dos ejecuciones que se contradigan,
 * explicables por diff, **nunca un misterio**». Por eso `cause` no se adivina:
 * sale de comparar los sellos.
 *
 * | Qué cambió | `cause` |
 * |---|---|
 * | sólo `gitSha` | `MOTOR` |
 * | `ledgerHash` o `analyticsKey` | `DATOS` |
 * | `configHash`, `planHash` o `accountMapHash` | `CONFIGURACION` |
 * | más de uno de los anteriores | `VARIOS` |
 * | nada, y los checks tampoco | `NINGUNA` |
 *
 * Y el caso que el criterio 4 declara imposible —`NINGUNA` con deltas— no se
 * devuelve nunca: si ningún sello se movió y los checks sí, el diff lo declara
 * `VARIOS` y **añade el `checksHash` de los dos runs a `hashChanges`**. Ese es
 * justo el hallazgo de I-E7-7: alguien editó una fila.
 *
 * Y el criterio del CFO (O-19): lo que mira quien firma no es un check, es una
 * cifra. Las cuatro salen de `headline`, ya derivado por SQL de cada
 * `ledgerHash`.
 *
 * Módulo PURO.
 */

import { familyOf } from "@/lib/audit/families"
import { checksHashOf } from "@/lib/audit/run"
import {
  HEADLINE_METRICS,
  type Cents,
  type CheckFamily,
  type CheckStatus,
  type HeadlineMetric,
  type InvariantRunRef,
  type Provenance,
} from "@/lib/audit/types"

export type CheckDelta = {
  id: string
  family: CheckFamily
  from: CheckStatus | null
  to: CheckStatus | null
  evidenciaFrom?: string
  evidenciaTo?: string
}

/** O-19: lo que mira quien firma no es un check, es una cifra. */
export type FigureDelta = {
  metric: HeadlineMetric
  fromCents: Cents
  toCents: Cents
  deltaCents: Cents
  provenance?: Provenance
}

export type DiffCause = "DATOS" | "MOTOR" | "CONFIGURACION" | "VARIOS" | "NINGUNA"

export type RunDiff = {
  deltas: readonly CheckDelta[]
  figures: readonly FigureDelta[]
  cause: DiffCause
  hashChanges: readonly { hash: string; from: string; to: string }[]
}

const HASHES: readonly { name: string; get: (r: InvariantRunRef) => string; cause: DiffCause }[] = [
  { name: "ledgerHash", get: (r) => r.ledgerHash, cause: "DATOS" },
  { name: "analyticsKey", get: (r) => r.analyticsKey, cause: "DATOS" },
  // El plan y el mapa de cuentas son configuración contable de la organización:
  // cambiarlos mueve un check sin mover un asiento, igual que un umbral.
  { name: "planHash", get: (r) => r.planHash, cause: "CONFIGURACION" },
  { name: "accountMapHash", get: (r) => r.accountMapHash, cause: "CONFIGURACION" },
  { name: "configHash", get: (r) => r.configHash, cause: "CONFIGURACION" },
  { name: "gitSha", get: (r) => r.gitSha, cause: "MOTOR" },
]

export function diffRuns(a: InvariantRunRef, b: InvariantRunRef): RunDiff {
  const hashChanges: { hash: string; from: string; to: string }[] = []
  const causes = new Set<DiffCause>()
  for (const h of HASHES) {
    const from = h.get(a)
    const to = h.get(b)
    if (from !== to) {
      hashChanges.push({ hash: h.name, from, to })
      causes.add(h.cause)
    }
  }

  const byId = new Map<string, { from?: (typeof a.checks)[number]; to?: (typeof b.checks)[number] }>()
  for (const check of a.checks) byId.set(check.id, { ...(byId.get(check.id) ?? {}), from: check })
  for (const check of b.checks) byId.set(check.id, { ...(byId.get(check.id) ?? {}), to: check })

  const deltas: CheckDelta[] = []
  for (const [id, pair] of [...byId.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    const fromStatus = pair.from?.status ?? null
    const toStatus = pair.to?.status ?? null
    const fromEvidencia = pair.from?.evidencia
    const toEvidencia = pair.to?.evidencia
    if (fromStatus === toStatus && fromEvidencia === toEvidencia) continue
    const delta: CheckDelta = { id, family: familyOf(id), from: fromStatus, to: toStatus }
    if (fromEvidencia !== undefined) delta.evidenciaFrom = fromEvidencia
    if (toEvidencia !== undefined) delta.evidenciaTo = toEvidencia
    deltas.push(delta)
  }

  const figures: FigureDelta[] = HEADLINE_METRICS.map((metric) => {
    const from = a.headline[metric]?.cents ?? 0
    const to = b.headline[metric]?.cents ?? 0
    const provenance = b.headline[metric]?.provenance ?? a.headline[metric]?.provenance
    const figure: FigureDelta = { metric, fromCents: from, toCents: to, deltaCents: to - from }
    if (provenance !== undefined) figure.provenance = provenance
    return figure
  })

  const movedFigures = figures.some((f) => f.deltaCents !== 0)
  let cause: DiffCause =
    causes.size === 0 ? "NINGUNA" : causes.size === 1 ? ([...causes][0] as DiffCause) : "VARIOS"

  if (cause === "NINGUNA" && (deltas.length > 0 || movedFigures)) {
    // Ningún sello se movió y el resultado sí. No es un misterio: es que uno de
    // los dos runs no dice lo que dijo cuando se selló (I-E7-7).
    cause = "VARIOS"
    hashChanges.push({ hash: "checksHash", from: checksHashOf(a.checks), to: checksHashOf(b.checks) })
  }

  return { deltas, figures, cause, hashChanges }
}
