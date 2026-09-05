/**
 * E4 · T11 — Ventana y validación de la reclasificación analítica
 * (ADR-0010 APROBADO, `E4-analitica.md` §2.6).
 *
 * Módulo PURO: no toca la BD. `models/analytics.reclassifyLines` aplica lo que
 * esto autoriza, dentro de `runLedgerTransaction`.
 */

import { isPnlAccount, resolveEffectiveAnalyticType } from "@/lib/analytics/margins"
import type { AnalyticsConfig, AnalyticType, LocalDate } from "@/lib/analytics/types"
import { err, fail, LedgerError, ok, type Result } from "@/lib/ledger/types"

/** Motivo obligatorio (C-R3): ≥ 10 caracteres. */
export const MIN_RECLASSIFY_REASON = 10

export type ReclassifyTarget = {
  lineId: string
  projectId?: string | null
  costCenterId?: string | null
  analyticType?: AnalyticType | null
}

export type ReclassifyRequest = {
  reason: string
  targets: readonly ReclassifyTarget[]
}

/** Estado actual de una línea a reclasificar, leído por `models/`. */
export type CurrentLine = {
  id: string
  entryId: string
  entryNumber: number
  lineNo: number
  accountCode: string
  entryDate: LocalDate
  fiscalYearId: string
  entryKind: string
  projectId: string | null
  costCenterId: string | null
  businessLineId: string | null
  analyticType: AnalyticType | null
}

export type ReclassifyContext = {
  config: AnalyticsConfig
  /** Rol del actor. La ventana lo compara con la del periodo (C-R2). */
  role: "ADMIN" | "EDITOR" | "VIEWER"
  fiscalYears: readonly { id: string; code: string; status: "OPEN" | "CLOSED" }[]
  /** Meses bloqueados: `{ fiscalYearId, month }`. */
  periodLocks: readonly { fiscalYearId: string; month: number }[]
}

export type ResolvedReclassification = {
  lineId: string
  entryId: string
  before: Pick<CurrentLine, "projectId" | "costCenterId" | "businessLineId" | "analyticType">
  after: Pick<CurrentLine, "projectId" | "costCenterId" | "businessLineId" | "analyticType">
}

const monthOf = (date: LocalDate): number => Number(date.slice(5, 7))

/**
 * C-9 + C-R2 + C-R4. Devuelve las líneas ya resueltas (tipo efectivo y línea de
 * negocio incluidos) o TODOS los errores.
 */
export function checkReclassify(
  request: ReclassifyRequest,
  current: readonly CurrentLine[],
  ctx: ReclassifyContext
): Result<ResolvedReclassification[]> {
  const errors: LedgerError[] = []

  const reason = (request.reason ?? "").trim()
  if (reason.length < MIN_RECLASSIFY_REASON) {
    errors.push(
      err("TEMPLATE_INPUT", "reason", `El motivo es obligatorio y debe tener al menos ${MIN_RECLASSIFY_REASON} caracteres`, {
        check: "C-R3",
      })
    )
  }
  if (request.targets.length === 0) {
    errors.push(err("TEMPLATE_INPUT", "targets", "No hay ninguna línea que reclasificar"))
  }

  const byId = new Map(current.map((l) => [l.id, l]))
  const fyById = new Map(ctx.fiscalYears.map((f) => [f.id, f]))
  const locked = new Set(ctx.periodLocks.map((l) => `${l.fiscalYearId}:${l.month}`))
  const resolved: ResolvedReclassification[] = []

  for (const target of request.targets) {
    const line = byId.get(target.lineId)
    if (!line) {
      errors.push(err("ANALYTIC_DEST_UNKNOWN", "lineId", `La línea ${target.lineId} no existe en esta organización`))
      continue
    }

    // R-A1: los grupos 1–5 no se reclasifican porque nunca tuvieron destino.
    if (!isPnlAccount(line.accountCode)) {
      errors.push(
        err("ANALYTIC_DIM_ON_NON_PNL", "lineId", `La cuenta ${line.accountCode} no es de grupo 6 ni 7 (R-A1)`, {
          lineNo: line.lineNo,
        })
      )
      continue
    }

    // C-R2 — ventana. El ejercicio cerrado es frontera absoluta, sin excepción
    // de rol (arts. 253, 272 y 279 LSC).
    const fy = fyById.get(line.fiscalYearId)
    if (!fy) {
      errors.push(err("FY_NOT_FOUND", "fiscalYearId", "El ejercicio de la línea no existe", { lineNo: line.lineNo }))
      continue
    }
    if (fy.status === "CLOSED") {
      errors.push(
        err("FY_CLOSED", "fiscalYearId", `El ejercicio ${fy.code} está cerrado: su analítica no se reclasifica`, {
          lineNo: line.lineNo,
          check: "C-R2",
        })
      )
      continue
    }
    if (locked.has(`${fy.id}:${monthOf(line.entryDate)}`) && ctx.role !== "ADMIN") {
      errors.push(
        err(
          "MONTH_LOCKED",
          "entryDate",
          `El mes ${monthOf(line.entryDate)} de ${fy.code} está bloqueado: la reclasificación exige rol ADMIN`,
          { lineNo: line.lineNo, check: "C-R2" }
        )
      )
      continue
    }
    if (ctx.role === "VIEWER") {
      errors.push(err("TEMPLATE_INPUT", "role", "Se requiere rol EDITOR o ADMIN", { lineNo: line.lineNo, check: "C-R2" }))
      continue
    }

    const projectId = target.projectId ?? null
    const costCenterId = target.costCenterId ?? null

    if (projectId && costCenterId) {
      errors.push(
        err("ANALYTIC_DEST_BOTH", "projectId", "Una línea lleva proyecto O centro de coste, nunca los dos", {
          lineNo: line.lineNo,
        })
      )
      continue
    }

    const effective = resolveEffectiveAnalyticType(
      { accountCode: line.accountCode, analyticType: target.analyticType ?? null, projectId, costCenterId },
      ctx.config
    )

    if (effective === "NO_ANALITICO") {
      if (projectId || costCenterId) {
        errors.push(
          err("ANALYTIC_DIM_ON_NON_ANALYTIC", "projectId", `La cuenta ${line.accountCode} es NO_ANALITICO (I-E4-4)`, {
            lineNo: line.lineNo,
          })
        )
        continue
      }
    } else if (!projectId && !costCenterId) {
      errors.push(
        err("ANALYTIC_DEST_MISSING", "projectId", "La reclasificación debe indicar un destino (proyecto o centro de coste)", {
          lineNo: line.lineNo,
        })
      )
      continue
    }

    // C-R4 — proyecto destino no CLOSED y CECO destino activo.
    let businessLineId: string | null = null
    if (projectId) {
      const project = ctx.config.projects.find((p) => p.id === projectId)
      if (!project) {
        errors.push(err("ANALYTIC_DEST_UNKNOWN", "projectId", `El proyecto ${projectId} no existe`, { lineNo: line.lineNo }))
        continue
      }
      if (project.status === "CLOSED") {
        errors.push(
          err("ANALYTIC_PROJECT_CLOSED", "projectId", `El proyecto ${project.code} está cerrado`, {
            lineNo: line.lineNo,
            check: "C-R4",
          })
        )
        continue
      }
      if (!project.isActive) {
        errors.push(
          err("ANALYTIC_DEST_INACTIVE", "projectId", `El proyecto ${project.code} está archivado`, {
            lineNo: line.lineNo,
            check: "C-R4",
          })
        )
        continue
      }
      businessLineId = project.businessLineId
    }
    if (costCenterId) {
      const ceco = ctx.config.costCenters.find((c) => c.id === costCenterId)
      if (!ceco) {
        errors.push(err("ANALYTIC_DEST_UNKNOWN", "costCenterId", `El centro de coste ${costCenterId} no existe`, { lineNo: line.lineNo }))
        continue
      }
      if (!ceco.isActive) {
        errors.push(
          err("ANALYTIC_DEST_INACTIVE", "costCenterId", `El centro de coste ${ceco.code} está archivado`, {
            lineNo: line.lineNo,
            check: "C-R4",
          })
        )
        continue
      }
    }

    resolved.push({
      lineId: line.id,
      entryId: line.entryId,
      before: {
        projectId: line.projectId,
        costCenterId: line.costCenterId,
        businessLineId: line.businessLineId,
        analyticType: line.analyticType,
      },
      after: { projectId, costCenterId, businessLineId, analyticType: effective },
    })
  }

  return errors.length > 0 ? fail<ResolvedReclassification[]>(...errors) : ok(resolved)
}

/** ¿Cambia algo? Reclasificar a lo mismo no consume ni traza ni transacción. */
export const isNoop = (r: ResolvedReclassification): boolean =>
  r.before.projectId === r.after.projectId &&
  r.before.costCenterId === r.after.costCenterId &&
  r.before.businessLineId === r.after.businessLineId &&
  r.before.analyticType === r.after.analyticType
