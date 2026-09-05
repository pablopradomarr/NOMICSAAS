/**
 * E3 · T4 — Construcción y validación del borrador de asiento.
 *
 * `buildEntry` normaliza (resuelve `AccountKey` → código, renumera, recorta,
 * omite líneas a cero, resuelve fecha y ejercicio, sella el modo de redondeo) y
 * llama a `checkDraft`, que aplica **los 13 checks C-1…C-13** de
 * `docs/design/E3-asientos-tipo.md` §0.2 en ese orden y devuelve **todos** los
 * errores, cada uno anclado a su `lineNo`.
 *
 * Módulo PURO: nada de aquí toca la BD. La persistencia (numeración con
 * `FOR UPDATE`, triggers diferidos) es `models/ledger.ts`.
 */

import { resolveEffectiveAnalyticType } from "@/lib/analytics/margins"
import { compareDates, findFiscalYear, isMonthLocked, isValidLocalDate, monthOf, resolveEntryDate } from "@/lib/ledger/dates"
import { isInForce, taxAppliesToSide } from "@/lib/taxes/rates"
import { toUtcDate } from "@/lib/ledger/dates"
import {
  AnalyticType,
  Cents,
  DraftLine,
  EntryDraft,
  EntryInput,
  err,
  fail,
  LedgerContext,
  LedgerError,
  ok,
  ResolvedLine,
  Result,
} from "@/lib/ledger/types"
import type { TaxSide } from "@/lib/taxes/types"

const MAX_DESCRIPTION = 512

/** Grupo PGC de una cuenta: el primer dígito del código. */
export const accountGroup = (code: string): number => Number(code.slice(0, 1))

const isPnlAccount = (code: string): boolean => accountGroup(code) === 6 || accountGroup(code) === 7

/**
 * Asientos exentos de C-9 (§8.7 y §2.5 de `E4-validacion-analitica.md`):
 * el contra-asiento hereda el destino del original, y la regularización, el
 * cierre y la apertura quedan fuera de I3/I4 por su `kind`.
 */
const EXEMPT_KINDS: ReadonlySet<string> = new Set(["REVERSAL", "REGULARIZATION", "CLOSING", "OPENING"])

const truncate = (s: string, max = MAX_DESCRIPTION): string => (s.length <= max ? s : s.slice(0, max))

/**
 * Datos del documento que originan C-5, C-6 y C-7. Solo las plantillas de
 * documento (T-01…T-05) los aportan; el resto de asientos no tiene documento.
 */
export type DocumentCheck = {
  /** Total del documento (lo que el tercero factura o cobra). */
  totalCents: Cents
  /** Base imponible declarada del documento. */
  baseCents: Cents
  /** Bases de cada línea del documento: `Σ Bᵢ = B` con tolerancia 0 (C-6). */
  lineBases: readonly Cents[]
  /** Cuotas repercutidas/soportadas que suman al total. */
  taxCents: Cents
  /** Retenciones, que RESTAN del total. */
  withholdingCents?: Cents
  /** Cuotas teóricas por tipo, para C-7. */
  expectedTaxByRate?: readonly Cents[]
  /** Importes que ya estaban anticipados y minoran el crédito/deuda. */
  appliedAdvanceCents?: Cents
}

export type CheckDraftOptions = {
  document?: DocumentCheck
  /**
   * I-E4-10 (gap de QA) — excepción para postear a un proyecto ya `CLOSED`.
   *
   * Un proyecto se cierra cuando se entrega, pero las facturas de los últimos
   * subcontratistas y la nómina del mes llegan DESPUÉS: sin excepción, ese
   * coste acabaría en un CECO y el margen del proyecto quedaría falseado al
   * alza justo en el momento en que se mide si fue rentable. Con excepción, la
   * autoriza un `ADMIN`, exige motivo y queda en `AuditLog`; el invariante
   * I-E4-10 la sigue listando como WARN, que es su oficio.
   */
  closedProjectOverride?: { role: "ADMIN" | "EDITOR" | "VIEWER"; reason: string }
  /**
   * C-12: líneas homólogas del documento rectificado. Cada entrada es la
   * cuenta y el lado que tenía en el original; la rectificativa debe llevar el
   * contrario.
   */
  rectifies?: readonly {
    accountCode: string
    side: "DEBIT" | "CREDIT"
    amountCents: Cents
    /** E4 · C-12 analítico (I-E4-12): destino de la línea rectificada. */
    projectId?: string | null
    costCenterId?: string | null
  }[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalización
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resuelve la cuenta de una línea. `accountKey` manda sobre `accountCode`:
 * toda contrapartida que decide el MOTOR es una clave del mapa.
 */
export function resolveAccount(line: DraftLine, ctx: LedgerContext): { code: string } | { error: LedgerError } {
  if (line.accountKey) {
    const code = ctx.map(line.accountKey)
    if (!code) {
      return {
        error: err(
          "MAP_KEY_UNMAPPED",
          "accountKey",
          `La clave ${line.accountKey} no está mapeada a ninguna cuenta del plan (I-plan-1)`,
          { lineNo: line.lineNo }
        ),
      }
    }
    return { code }
  }
  if (line.accountCode && line.accountCode.trim() !== "") return { code: line.accountCode.trim() }
  return {
    error: err("ACCOUNT_UNKNOWN", "accountCode", "La línea no indica ni clave ni código de cuenta", {
      lineNo: line.lineNo,
    }),
  }
}

/**
 * `buildEntry` — normaliza el input y lo valida.
 *
 * Orden: omitir líneas a cero → resolver cuentas → renumerar 1..n → resolver
 * fecha y ejercicio → sellar `taxRoundingMode` → `checkDraft`.
 */
export function buildEntry(input: EntryInput, ctx: LedgerContext, opts: CheckDraftOptions = {}): Result<EntryDraft> {
  const errors: LedgerError[] = []

  if (input.organizationId !== ctx.organizationId) {
    errors.push(
      err("TENANT_MISMATCH", "organizationId", "El asiento pertenece a otra organización que la del contexto", {
        check: "C-13",
      })
    )
  }
  if (input.description.trim() === "") {
    errors.push(err("TEMPLATE_INPUT", "description", "El concepto del asiento es obligatorio"))
  }

  // Se omiten —no se rechazan— las líneas que quedarían a cero: es lo que
  // permite que una plantilla emita líneas condicionales (retención, anticipo,
  // recargo) sin ramificar (C-3 se cumple por construcción).
  const kept = input.lines.filter((l) => (l.debitCents ?? 0) !== 0 || (l.creditCents ?? 0) !== 0)

  const lines: ResolvedLine[] = []
  kept.forEach((line, index) => {
    const resolved = resolveAccount(line, ctx)
    if ("error" in resolved) {
      errors.push({ ...resolved.error, lineNo: index + 1 })
      return
    }
    lines.push({
      ...line,
      lineNo: index + 1,
      accountCode: resolved.code,
      accountKey: line.accountKey ?? null,
      description: line.description ? truncate(line.description) : null,
    })
  })

  // Fecha contable: la fija el motor, no el usuario (§2.2).
  let entryDate = input.entryDate ?? null
  let fiscalYearId: string | null = null
  let description = truncate(input.description.trim())

  if (entryDate !== null) {
    if (!isValidLocalDate(entryDate)) {
      errors.push(err("DATE_FORMAT", "entryDate", `Fecha contable inválida: ${entryDate}`))
    } else {
      const fy = findFiscalYear(ctx, entryDate)
      if (!fy) {
        errors.push(err("FY_NOT_FOUND", "entryDate", `No hay ejercicio que contenga la fecha ${entryDate}`))
      } else {
        fiscalYearId = fy.id
      }
    }
  } else {
    const resolved = resolveEntryDate({ documentDate: input.documentDate, accrualDate: input.accrualDate }, ctx)
    if (!resolved.ok) {
      errors.push(...resolved.errors)
    } else {
      entryDate = resolved.value.entryDate
      fiscalYearId = resolved.value.fiscalYearId
      if (resolved.value.note) description = truncate(`${description} ${resolved.value.note}`)
    }
  }

  if (errors.length > 0 || entryDate === null || fiscalYearId === null) {
    return fail<EntryDraft>(...errors)
  }

  const draft: EntryDraft = {
    organizationId: ctx.organizationId,
    fiscalYearId,
    documentDate: input.documentDate ?? null,
    accrualDate: input.accrualDate ?? null,
    entryDate,
    description,
    kind: input.kind ?? "NORMAL",
    sourceType: input.sourceType ?? "MANUAL",
    sourceId: input.sourceId ?? null,
    transactionId: input.transactionId ?? null,
    fileId: input.fileId ?? null,
    templateCode: input.templateCode ?? null,
    taxRoundingMode: ctx.policy.taxRoundingMode,
    reversesEntryId: input.reversesEntryId ?? null,
    lines,
  }

  // #12: el destino analítico se resuelve AQUÍ, una sola vez, produciendo un
  // borrador nuevo. `checkDraft` valida sobre él sin volver a escribir nada.
  return checkDraft(resolveAnalytics(draft, ctx), ctx, opts)
}

// ─────────────────────────────────────────────────────────────────────────────
// C-1 … C-13
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Los trece checks comunes, en orden, devolviendo TODOS los errores. Ninguno
 * corta la ejecución de los siguientes: un formulario con tres problemas debe
 * enseñar los tres a la vez.
 */
export function checkDraft(draft: EntryDraft, ctx: LedgerContext, opts: CheckDraftOptions = {}): Result<EntryDraft> {
  const errors: LedgerError[] = []

  // ── C-2 línea bien formada · C-3 sin líneas a cero ──
  for (const line of draft.lines) {
    const d = line.debitCents
    const c = line.creditCents
    if (!Number.isInteger(d) || !Number.isInteger(c)) {
      errors.push(
        err("LINE_NEGATIVE", "debitCents", "Los importes son enteros en céntimos", { lineNo: line.lineNo, check: "C-2" })
      )
      continue
    }
    if (d < 0 || c < 0) {
      errors.push(
        err(
          "LINE_NEGATIVE",
          d < 0 ? "debitCents" : "creditCents",
          "Un importe negativo no existe: un abono es la columna contraria, no un signo",
          { lineNo: line.lineNo, check: "C-2" }
        )
      )
    }
    if (d === 0 && c === 0) {
      errors.push(err("ZERO_LINE", "debitCents", "Una línea a cero no se contabiliza", { lineNo: line.lineNo, check: "C-3" }))
    } else if (d !== 0 && c !== 0) {
      errors.push(
        err("LINE_SIDE", "debitCents", "Exactamente una de las dos columnas lleva importe", {
          lineNo: line.lineNo,
          check: "C-2",
        })
      )
    }
  }

  // ── C-4 mínimo dos líneas y ≥ 1 a cada lado ──
  if (draft.lines.length < 2) {
    errors.push(
      err("TOO_FEW_LINES", "lines", `Un asiento tiene al menos dos líneas (tiene ${draft.lines.length})`, {
        check: "C-4",
      })
    )
  } else {
    const withDebit = draft.lines.filter((l) => l.debitCents > 0).length
    const withCredit = draft.lines.filter((l) => l.creditCents > 0).length
    if (withDebit === 0 || withCredit === 0) {
      errors.push(
        err(
          "ONE_SIDED_ENTRY",
          "lines",
          `Asiento sin contrapartida: ${withDebit} línea(s) al debe y ${withCredit} al haber`,
          { check: "C-4" }
        )
      )
    }
  }

  // ── C-1 partida doble (tolerancia 0) ──
  const totalDebit = draft.lines.reduce((a, l) => a + (l.debitCents || 0), 0)
  const totalCredit = draft.lines.reduce((a, l) => a + (l.creditCents || 0), 0)
  if (totalDebit !== totalCredit) {
    errors.push(
      err(
        "UNBALANCED",
        "lines",
        `Asiento descuadrado: debe ${totalDebit} ≠ haber ${totalCredit} (diferencia ${totalDebit - totalCredit})`,
        { check: "C-1" }
      )
    )
  }

  // ── C-5 documento cuadrado · C-6 detalle cuadrado · C-7 coherencia de cuota ──
  if (opts.document) errors.push(...checkDocument(opts.document))

  // ── C-8 cuentas: existen, de la organización, activas y postables ──
  for (const line of draft.lines) {
    const account = ctx.plan.byCode.get(line.accountCode)
    if (!account) {
      errors.push(
        err("ACCOUNT_UNKNOWN", "accountCode", `La cuenta ${line.accountCode} no existe en el plan de la organización`, {
          lineNo: line.lineNo,
          check: "C-8",
        })
      )
      continue
    }
    if (!account.isActive) {
      errors.push(
        err("ACCOUNT_INACTIVE", "accountCode", `La cuenta ${line.accountCode} está desactivada`, {
          lineNo: line.lineNo,
          check: "C-8",
        })
      )
    }
    if (!account.isPostable) {
      errors.push(
        err(
          "ACCOUNT_NOT_POSTABLE",
          "accountCode",
          `La cuenta ${line.accountCode} tiene subcuentas y no admite apuntes`,
          { lineNo: line.lineNo, check: "C-8" }
        )
      )
    }
  }

  // ── C-9 destino analítico (E4 · T6: ACTIVO) ──
  errors.push(...validateAnalytics(draft, ctx, opts.closedProjectOverride))

  // ── C-10 tipos vigentes (se seleccionan con `documentDate`, no `entryDate`) ──
  const taxRefDate = draft.documentDate ?? draft.entryDate
  for (const line of draft.lines) {
    if (!line.taxRateId) continue
    const rate = ctx.rates.find((r) => r.id === line.taxRateId)
    if (!rate) {
      errors.push(
        err("TAX_RATE_NOT_IN_FORCE", "taxRateId", `El tipo impositivo ${line.taxRateId} no existe en la organización`, {
          lineNo: line.lineNo,
          check: "C-10",
        })
      )
      continue
    }
    if (!rate.isActive || !isInForce(rate, toUtcDate(taxRefDate))) {
      errors.push(
        err("TAX_RATE_NOT_IN_FORCE", "taxRateId", `El tipo ${rate.code} no está vigente a ${taxRefDate}`, {
          lineNo: line.lineNo,
          check: "C-10",
        })
      )
    }
    // El lado se deduce de la columna. La EXCEPCIÓN es la inversión del sujeto
    // pasivo (T-04): sus dos líneas de IVA comparten el MISMO `taxRateId` —uno
    // de `appliesTo = PURCHASE`— y una de ellas va al haber por diseño, así que
    // la comprobación de lado no aplica a la autorrepercusión.
    const side: TaxSide = line.debitCents > 0 ? "PURCHASE" : "SALE"
    const isSelfAssessed = draft.templateCode === "FACTURA_RECIBIDA_ISP"
    if (!isSelfAssessed && !taxAppliesToSide(rate, side)) {
      errors.push(
        err("TAX_SIDE_MISMATCH", "taxRateId", `El tipo ${rate.code} no es aplicable en ese lado del asiento`, {
          lineNo: line.lineNo,
          check: "C-10",
        })
      )
    }
    if (line.taxBaseCents !== null && line.taxBaseCents !== undefined && line.taxBaseCents < 0) {
      errors.push(
        err("TAX_BASE_MISMATCH", "taxBaseCents", "La base de una cuota no puede ser negativa", {
          lineNo: line.lineNo,
          check: "C-7",
        })
      )
    }
  }

  // ── C-11 periodo: ejercicio OPEN, dentro de rango, mes no bloqueado, ≤ refDate ──
  errors.push(...checkPeriod(draft, ctx))

  // ── C-12 signos en rectificativas ──
  if (opts.rectifies) errors.push(...checkRectification(draft, opts.rectifies))

  // ── C-13 tenant ──
  if (draft.organizationId !== ctx.organizationId) {
    errors.push(
      err("TENANT_MISMATCH", "organizationId", "El asiento no pertenece a la organización del contexto", {
        check: "C-13",
      })
    )
  }

  return errors.length > 0 ? fail<EntryDraft>(...errors) : ok(draft)
}

/** Alias explícito del diseño (§3.2): validar un borrador ya construido. */
export const validateEntry = checkDraft

// ─────────────────────────────────────────────────────────────────────────────
// C-9 — destino analítico (E4 · T6, `E4-analitica.md` §2.4 y §3.3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resuelve el destino analítico de una línea 6/7: el tipo efectivo
 * (R-A2/R-A3/R-A4), el ruteo a `CC-NA` con `analyticsRequired = false` (R-A8) y
 * la denormalización de `businessLineId` desde el proyecto (R-A9).
 *
 * **Función pura** (hallazgo #12): devuelve las tres columnas resueltas y no
 * toca la línea. Quien decide escribirlas es `resolveAnalytics`, y sólo dentro
 * de `buildEntry`, que es el único sitio donde el borrador todavía se está
 * construyendo. Así `checkDraft` puede validar sin efectos secundarios y dos
 * llamadas seguidas dan el mismo resultado.
 */
export function resolveLineAnalytics(
  line: Pick<ResolvedLine, "accountCode" | "analyticType" | "projectId" | "costCenterId">,
  ctx: LedgerContext,
  analyticTypeByAccount: ReadonlyMap<string, AnalyticType | null>
): { analyticType: AnalyticType | null; projectId: string | null; costCenterId: string | null; businessLineId: string | null } {
  const projectId = line.projectId ?? null
  let costCenterId = line.costCenterId ?? null

  let effective = resolveEffectiveAnalyticType(
    { accountCode: line.accountCode, analyticType: line.analyticType ?? null, projectId, costCenterId },
    { analyticTypeByAccount }
  )

  // R-A8: con la regla relajada, la línea sin destino va a `CC-NA` en vez de
  // quedarse invisible en todas las columnas.
  if (!projectId && !costCenterId && effective !== "NO_ANALITICO" && effective !== null && !ctx.policy.analyticsRequired) {
    const unassigned = ctx.dimensions.unassignedCostCenterId ?? null
    if (unassigned) {
      costCenterId = unassigned
      effective = resolveEffectiveAnalyticType(
        { accountCode: line.accountCode, projectId: null, costCenterId: unassigned },
        { analyticTypeByAccount }
      )
    }
  }

  return {
    analyticType: effective,
    projectId,
    costCenterId,
    // R-A9: la línea de negocio se COPIA del proyecto en el alta y no se
    // recalcula nunca. Con CECO, va a NULL.
    businessLineId: projectId
      ? ((ctx.dimensions.projects ?? []).find((p) => p.id === projectId)?.businessLineId ?? null)
      : null,
  }
}

/** Índice `código de cuenta → analyticType` del plan. */
const analyticTypeIndex = (ctx: LedgerContext): ReadonlyMap<string, AnalyticType | null> =>
  new Map<string, AnalyticType | null>([...ctx.plan.byCode.entries()].map(([code, a]) => [code, a.analyticType]))

/**
 * Devuelve un borrador NUEVO con el destino analítico ya resuelto en cada línea
 * 6/7. No muta el que recibe (hallazgo #12).
 *
 * `REVERSAL`, `REGULARIZATION`, `CLOSING` y `OPENING` se devuelven intactos
 * (§8.7 y §2.5 del experto): el contra-asiento copia literalmente las cuatro
 * columnas del original —debe poder postearse aunque el proyecto se haya
 * cerrado entretanto— y los tres de sistema quedan fuera de I3/I4 por su `kind`.
 */
export function resolveAnalytics(draft: EntryDraft, ctx: LedgerContext): EntryDraft {
  if (!ctx.dimensions.available || EXEMPT_KINDS.has(draft.kind)) return draft
  const analyticTypeByAccount = analyticTypeIndex(ctx)
  return {
    ...draft,
    lines: draft.lines.map((line) =>
      isPnlAccount(line.accountCode) ? { ...line, ...resolveLineAnalytics(line, ctx, analyticTypeByAccount) } : line
    ),
  }
}

/**
 * C-9 completo. Devuelve TODOS los errores, cada uno anclado a su línea.
 *
 * - R-A1 / I-E4-5: grupos 1–5 sin dimensión ni `analyticType`.
 * - I-E4-4: `NO_ANALITICO` (en particular `630`) sin ninguna dimensión.
 * - destino excluyente, existente, del tenant y activo.
 * - proyecto `CLOSED` no admite líneas nuevas.
 * - con `analyticsRequired`, faltar el destino BLOQUEA el asiento.
 */
/** Motivo mínimo de la excepción de proyecto cerrado, igual que en la anulación. */
export const MIN_OVERRIDE_REASON = 10

export function validateAnalytics(
  draft: EntryDraft,
  ctx: LedgerContext,
  closedProjectOverride?: { role: "ADMIN" | "EDITOR" | "VIEWER"; reason: string }
): LedgerError[] {
  const errors: LedgerError[] = []
  const overrideOk =
    closedProjectOverride !== undefined &&
    closedProjectOverride.role === "ADMIN" &&
    (closedProjectOverride.reason ?? "").trim().length >= MIN_OVERRIDE_REASON

  if (!ctx.dimensions.available) {
    // Guarda de §2.3 (E3): sin tablas destino ninguna línea puede llevar una
    // dimensión, y el CHECK de la BD dice lo mismo.
    for (const line of draft.lines) {
      if (line.projectId || line.costCenterId || line.businessLineId) {
        errors.push(
          err(
            "ANALYTIC_DIM_UNAVAILABLE",
            "projectId",
            "Las dimensiones analíticas (proyecto, centro de coste, línea de negocio) no existen hasta E4",
            { lineNo: line.lineNo, check: "C-9" }
          )
        )
      }
    }
    return errors
  }

  // §8.7: el contra-asiento hereda el destino y NO pasa validateAnalytics —
  // debe poder postearse aunque el proyecto se haya cerrado entretanto.
  // T-26/T-27/T-28 (§2.5 del experto): sus líneas 6/7 **no llevan dimensión** y
  // I3/I4 las excluyen por `kind`, así que exigirles destino sería contradecir
  // el propio invariante que C-9 sirve.
  if (EXEMPT_KINDS.has(draft.kind)) return errors

  // #12: se valida sobre el destino RESUELTO, pero sin escribirlo. Quien lo
  // escribe es `buildEntry` llamando a `resolveAnalytics`, y lo hace antes.
  const analyticTypeByAccount = analyticTypeIndex(ctx)
  const projects = ctx.dimensions.projects ?? []
  const costCenters = ctx.dimensions.costCenters ?? []

  for (const raw of draft.lines) {
    const pnl = isPnlAccount(raw.accountCode)
    const line = pnl ? { ...raw, ...resolveLineAnalytics(raw, ctx, analyticTypeByAccount) } : raw

    // R-A1 / I-E4-5 — los grupos 1–5 son balance, no PyG.
    if (!pnl) {
      if (line.projectId || line.costCenterId || line.businessLineId || line.analyticType) {
        errors.push(
          err(
            "ANALYTIC_DIM_ON_NON_PNL",
            "projectId",
            `La cuenta ${line.accountCode} no es de grupo 6 ni 7: no admite destino analítico (R-A1)`,
            { lineNo: line.lineNo, check: "C-9" }
          )
        )
      }
      continue
    }

    // I-E4-4 — `NO_ANALITICO` nunca lleva dimensión.
    if (line.analyticType === "NO_ANALITICO") {
      if (line.projectId || line.costCenterId || line.businessLineId) {
        errors.push(
          err(
            "ANALYTIC_DIM_ON_NON_ANALYTIC",
            "projectId",
            `La cuenta ${line.accountCode} es NO_ANALITICO y no admite proyecto ni centro de coste (I-E4-4)`,
            { lineNo: line.lineNo, check: "C-9" }
          )
        )
      }
      continue
    }

    // Destino excluyente (I-E4-2).
    if (line.projectId && line.costCenterId) {
      errors.push(
        err("ANALYTIC_DEST_BOTH", "projectId", "Una línea lleva proyecto O centro de coste, nunca los dos", {
          lineNo: line.lineNo,
          check: "C-9",
        })
      )
      continue
    }

    if (line.projectId) {
      const project = projects.find((p) => p.id === line.projectId)
      if (!project) {
        errors.push(
          err("ANALYTIC_DEST_UNKNOWN", "projectId", `El proyecto ${line.projectId} no existe en esta organización`, {
            lineNo: line.lineNo,
            check: "C-9",
          })
        )
      } else {
        if (!project.isActive) {
          errors.push(
            err("ANALYTIC_DEST_INACTIVE", "projectId", `El proyecto ${project.code} está archivado`, {
              lineNo: line.lineNo,
              check: "C-9",
            })
          )
        }
        if (project.status === "CLOSED" && !overrideOk) {
          errors.push(
            err(
              "ANALYTIC_PROJECT_CLOSED",
              "projectId",
              `El proyecto ${project.code} está cerrado y no admite líneas nuevas (I-E4-10). ` +
                `Un ADMIN puede posterlas con motivo (≥ ${MIN_OVERRIDE_REASON} caracteres), que queda en el AuditLog`,
              { lineNo: line.lineNo, check: "C-9" }
            )
          )
        }
      }
      continue
    }

    if (line.costCenterId) {
      const ceco = costCenters.find((c) => c.id === line.costCenterId)
      if (!ceco) {
        errors.push(
          err("ANALYTIC_DEST_UNKNOWN", "costCenterId", `El centro de coste ${line.costCenterId} no existe en esta organización`, {
            lineNo: line.lineNo,
            check: "C-9",
          })
        )
      } else if (!ceco.isActive) {
        errors.push(
          err("ANALYTIC_DEST_INACTIVE", "costCenterId", `El centro de coste ${ceco.code} está archivado`, {
            lineNo: line.lineNo,
            check: "C-9",
          })
        )
      }
      continue
    }

    // Sin destino: con la regla estricta, bloquea (R-A8).
    if (ctx.policy.analyticsRequired) {
      errors.push(
        err(
          "ANALYTIC_DEST_MISSING",
          "projectId",
          `La cuenta ${line.accountCode} exige exactamente un destino analítico (proyecto o centro de coste)`,
          { lineNo: line.lineNo, check: "C-9" }
        )
      )
    }
  }

  return errors
}

/** C-5, C-6 y C-7 sobre los importes declarados del documento. */
export function checkDocument(doc: DocumentCheck): LedgerError[] {
  const errors: LedgerError[] = []
  const sumLineBases = doc.lineBases.reduce((a, b) => a + b, 0)

  // C-6: Σ bases de línea = base del documento, tolerancia 0.
  if (sumLineBases !== doc.baseCents) {
    errors.push(
      err(
        "TAX_BASE_MISMATCH",
        "lines",
        `La suma de las bases de línea (${sumLineBases}) no es la base del documento (${doc.baseCents})`,
        { check: "C-6" }
      )
    )
  }

  // C-5: base + impuestos repercutidos − retenciones = total del documento.
  const withholding = doc.withholdingCents ?? 0
  const computedTotal = doc.baseCents + doc.taxCents - withholding
  if (computedTotal !== doc.totalCents) {
    errors.push(
      err(
        "DOCUMENT_TOTAL_MISMATCH",
        "totalCents",
        `El documento no cuadra: base ${doc.baseCents} + impuestos ${doc.taxCents} − retenciones ${withholding} = ` +
          `${computedTotal}, pero el total declarado es ${doc.totalCents}`,
        { check: "C-5" }
      )
    )
  }

  // C-7: |Σ cuotas − Σ cuotas teóricas| ≤ 1 × nº de tipos (R-IVA-5).
  if (doc.expectedTaxByRate) {
    const expected = doc.expectedTaxByRate.reduce((a, b) => a + b, 0)
    const slack = doc.expectedTaxByRate.length
    if (Math.abs(doc.taxCents - expected) > slack) {
      errors.push(
        err(
          "TAX_BASE_MISMATCH",
          "taxCents",
          `Las cuotas declaradas (${doc.taxCents}) se apartan de las calculadas (${expected}) más de ${slack} céntimo(s)`,
          { check: "C-7" }
        )
      )
    }
  }
  return errors
}

/** C-11 — periodo. Es lo mismo que repiten los triggers `journal_entries_*`. */
export function checkPeriod(draft: EntryDraft, ctx: LedgerContext): LedgerError[] {
  const errors: LedgerError[] = []
  if (!isValidLocalDate(draft.entryDate)) {
    return [err("DATE_FORMAT", "entryDate", `Fecha contable inválida: ${draft.entryDate}`, { check: "C-11" })]
  }
  const fy = ctx.fiscalYears.find((f) => f.id === draft.fiscalYearId)
  if (!fy) {
    return [
      err("FY_NOT_FOUND", "fiscalYearId", "El ejercicio del asiento no existe en la organización", { check: "C-11" }),
    ]
  }
  if (fy.status === "CLOSED") {
    errors.push(err("FY_CLOSED", "fiscalYearId", `El ejercicio ${fy.code} está cerrado`, { check: "C-11" }))
  }
  if (compareDates(draft.entryDate, fy.startDate) < 0 || compareDates(draft.entryDate, fy.endDate) > 0) {
    errors.push(
      err(
        "DATE_OUT_OF_FY",
        "entryDate",
        `La fecha ${draft.entryDate} cae fuera del ejercicio ${fy.code} (${fy.startDate} .. ${fy.endDate})`,
        { check: "C-11" }
      )
    )
  }
  if (isMonthLocked(ctx, fy.id, monthOf(draft.entryDate))) {
    errors.push(
      err("MONTH_LOCKED", "entryDate", `El mes ${monthOf(draft.entryDate)} del ejercicio ${fy.code} está bloqueado`, {
        check: "C-11",
      })
    )
  }
  if (compareDates(draft.entryDate, ctx.refDate) > 0) {
    // O-8: en E3 no hay previsiones, así que toda fecha futura bloquea.
    errors.push(
      err("FUTURE_DATE", "entryDate", `La fecha ${draft.entryDate} es posterior a hoy (${ctx.refDate})`, {
        check: "C-11",
      })
    )
  }
  if (draft.accrualDate && compareDates(draft.entryDate, draft.accrualDate) < 0) {
    errors.push(
      err("DATE_FORMAT", "entryDate", "La fecha contable no puede ser anterior a la de devengo", { check: "C-11" })
    )
  }
  return errors
}

/**
 * C-12 — toda línea de una rectificativa lleva el signo CONTRARIO al de su
 * homóloga en el documento rectificado, y no puede excederla en importe.
 */
export function checkRectification(
  draft: EntryDraft,
  original: readonly {
    accountCode: string
    side: "DEBIT" | "CREDIT"
    amountCents: Cents
    projectId?: string | null
    costCenterId?: string | null
  }[]
): LedgerError[] {
  const errors: LedgerError[] = []
  const byAccount = new Map<
    string,
    { side: "DEBIT" | "CREDIT"; amountCents: Cents; projectId?: string | null; costCenterId?: string | null }
  >()
  for (const o of original) {
    const prev = byAccount.get(o.accountCode)
    byAccount.set(o.accountCode, {
      side: o.side,
      amountCents: (prev?.amountCents ?? 0) + o.amountCents,
      projectId: o.projectId ?? null,
      costCenterId: o.costCenterId ?? null,
    })
  }
  const rectifiedByAccount = new Map<string, number>()
  for (const line of draft.lines) {
    const source = byAccount.get(line.accountCode)
    if (!source) continue
    const side = line.debitCents > 0 ? "DEBIT" : "CREDIT"
    if (side === source.side) {
      errors.push(
        err(
          "RECTIFICATION_SIGN",
          "lines",
          `La cuenta ${line.accountCode} va al mismo lado que en el documento rectificado: una rectificativa invierte la columna`,
          { lineNo: line.lineNo, check: "C-12" }
        )
      )
    }
    // E4 · C-12 analítico (I-E4-12): la rectificativa hereda la dimensión de la
    // línea que rectifica. Un rappel sin el proyecto que lo generó rompería el
    // margen de ese proyecto.
    if (isPnlAccount(line.accountCode) && (source.projectId !== undefined || source.costCenterId !== undefined)) {
      const sameProject = (line.projectId ?? null) === (source.projectId ?? null)
      const sameCostCenter = (line.costCenterId ?? null) === (source.costCenterId ?? null)
      if (!sameProject || !sameCostCenter) {
        errors.push(
          err(
            "ANALYTIC_DEST_UNKNOWN",
            "projectId",
            `La rectificativa de ${line.accountCode} debe llevar la MISMA dimensión que la línea rectificada (I-E4-12)`,
            { lineNo: line.lineNo, check: "C-12" }
          )
        )
      }
    }

    const amount = line.debitCents + line.creditCents
    rectifiedByAccount.set(line.accountCode, (rectifiedByAccount.get(line.accountCode) ?? 0) + amount)
  }
  for (const [code, amount] of rectifiedByAccount) {
    const source = byAccount.get(code)
    if (source && amount > source.amountCents) {
      errors.push(
        err(
          "RECTIFICATION_EXCEEDS",
          "lines",
          `La rectificativa de la cuenta ${code} (${amount}) excede el importe del documento original (${source.amountCents})`,
          { check: "C-12" }
        )
      )
    }
  }
  return errors
}
