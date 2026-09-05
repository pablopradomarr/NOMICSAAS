/**
 * E2 · T3 — Reglas del editor de plan (R-01…R-21 de §3.2). Módulo puro:
 * devuelve `Result` en vez de lanzar, para que la server action pinte el error
 * bajo el campo.
 */

import {
  accountGroup,
  buildPlan,
  childrenOf,
  MIN_POSTABLE_LEVEL,
  resolveParentCode,
  validateAccountCode,
} from "@/lib/accounts/codes"
import { epigraphFor, isAnalyticCoherent } from "@/lib/accounts/epigraphs"
import {
  AccountError,
  AccountUsage,
  AccountWarning,
  AnalyticType,
  CashflowBucket,
  err,
  fail,
  ok,
  PgcVariant,
  Plan,
  PlanAccount,
  Result,
  Statement,
} from "@/lib/accounts/types"
import type { Role } from "@/prisma/client"

export type NewAccountInput = {
  code: string
  name: string
  statement?: Statement | null
  epigraph?: string | null
  epigraphPymes?: string | null
  analyticType?: AnalyticType | null
  cashflowBucket?: CashflowBucket | null
  bidirectional?: boolean
  isContra?: boolean
  origin?: PlanAccount["origin"]
}

export type AccountPatch = {
  name?: string
  code?: string
  statement?: Statement | null
  epigraph?: string | null
  analyticType?: AnalyticType | null
  cashflowBucket?: CashflowBucket | null
  isActive?: boolean
  reason?: string | null
}

export type EditContext = {
  plan: Plan
  role: Role
  variant: PgcVariant
  epigraphCatalog: ReadonlySet<string>
  usage: AccountUsage
  /** `false` hasta E3: no hay ejercicios ni líneas (R-10b). */
  hasClosedPeriodLines: boolean
  /** 0 hasta E5 (R-17). */
  activeAllocationRuns?: number
}

/** Grupos cuyo `statement` debe ser de balance/PN (R-11). */
const BALANCE_GROUPS = new Set(["1", "2", "3", "4", "5"])
const PYG_GROUPS = new Set(["6", "7"])
const ECPN_GROUPS = new Set(["8", "9"])
const BALANCE_STATEMENTS = new Set<Statement>(["BALANCE_ACTIVO", "BALANCE_PASIVO", "BALANCE_PN"] as Statement[])

/** R-11 / R-12: el estado financiero debe corresponder al grupo del código. */
export function checkStatementGroup(code: string, statement: Statement | null): AccountError | null {
  if (!statement) return null
  const group = accountGroup(code)
  if (PYG_GROUPS.has(group) && BALANCE_STATEMENTS.has(statement)) {
    return err(
      "STATEMENT_GROUP_MISMATCH",
      "statement",
      `Una cuenta del grupo ${group} es de pérdidas y ganancias: no puede presentarse en el balance (R-11)`
    )
  }
  if (BALANCE_GROUPS.has(group) && statement === ("PYG" as Statement)) {
    return err(
      "STATEMENT_GROUP_MISMATCH",
      "statement",
      `Una cuenta del grupo ${group} es de balance: no puede presentarse en la PyG (R-11)`
    )
  }
  if (statement === ("ECPN" as Statement) && !ECPN_GROUPS.has(group)) {
    return err(
      "STATEMENT_GROUP_MISMATCH",
      "statement",
      `El estado de cambios en el patrimonio neto sólo admite cuentas de los grupos 8 y 9 (R-12)`
    )
  }
  if (ECPN_GROUPS.has(group) && statement !== ("ECPN" as Statement)) {
    return err(
      "STATEMENT_GROUP_MISMATCH",
      "statement",
      `Las cuentas de los grupos 8 y 9 sólo alimentan el ECPN (R-12)`
    )
  }
  return null
}

/**
 * R-01…R-05: alta de cuenta. Hereda del padre la clasificación que no se dé.
 * `usage` es el uso DEL PADRE resuelto (R-05: no se cuelga un hijo de una cuenta
 * con líneas).
 */
export function validateNewAccount(
  input: NewAccountInput,
  plan: Plan,
  parentUsage: AccountUsage,
  opts: { epigraphCatalog?: ReadonlySet<string> } = {}
): Result<PlanAccount> {
  const errors: AccountError[] = []

  const codeResult = validateAccountCode(input.code, { mustBePostable: true })
  if (!codeResult.ok) return codeResult as Result<PlanAccount>
  const code = codeResult.value

  if (plan.byCode.has(code)) {
    errors.push(err("CODE_DUPLICATE", "code", `La cuenta ${code} ya existe en el plan`))
  }
  if (!input.name || input.name.trim() === "") {
    errors.push(err("CSV_ROW", "name", "El nombre de la cuenta es obligatorio"))
  }

  const parentCode = resolveParentCode(code, plan)
  const parent = parentCode ? plan.byCode.get(parentCode) : undefined
  if (!parent) {
    errors.push(
      err("PARENT_NOT_FOUND", "code", `No existe ninguna cuenta que sea prefijo de ${code}: no hay dónde colgarla`)
    )
  } else {
    if (!parent.isActive) {
      errors.push(err("PARENT_INACTIVE", "code", `La cuenta padre ${parent.code} está desactivada (R-03)`))
    }
    if (parentUsage.movementCount > 0) {
      errors.push(
        err(
          "PARENT_HAS_MOVEMENTS",
          "code",
          `La cuenta ${parent.code} ya tiene apuntes: no puede convertirse en cuenta agregadora (R-05)`
        )
      )
    }
  }

  const statement = input.statement !== undefined ? input.statement : (parent?.statement ?? null)
  const statementError = checkStatementGroup(code, statement)
  if (statementError) errors.push(statementError)

  // R-15 también en el ALTA, no sólo en la edición: una subcuenta nueva con un
  // epígrafe inventado no agrega en ningún informe y nadie se entera hasta que
  // el balance no cuadra. Si no se pasa catálogo, no se comprueba (el seed y los
  // tests que construyen planes a mano no lo necesitan).
  if (opts.epigraphCatalog && input.epigraph !== undefined && input.epigraph !== null) {
    if (!opts.epigraphCatalog.has(input.epigraph)) {
      errors.push(
        err(
          "EPIGRAPH_UNKNOWN",
          "epigraph",
          `«${input.epigraph}» no pertenece al catálogo de epígrafes de la variante (R-15)`
        )
      )
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  const account: PlanAccount = {
    code,
    name: input.name.trim(),
    level: code.length,
    parentCode: parent ? parent.code : null,
    nature: parent!.nature,
    statement,
    epigraph: input.epigraph !== undefined ? input.epigraph : (parent?.epigraph ?? null),
    epigraphPymes: input.epigraphPymes !== undefined ? input.epigraphPymes : (parent?.epigraphPymes ?? null),
    bidirectional: input.bidirectional ?? parent?.bidirectional ?? false,
    isContra: input.isContra ?? parent?.isContra ?? false,
    analyticType: input.analyticType !== undefined ? input.analyticType : (parent?.analyticType ?? null),
    // R-18′: el hijo HEREDA el bucket del padre salvo declaración explícita,
    // igual que en `validate_cashflow()` del generador del seed.
    cashflowBucket:
      input.cashflowBucket !== undefined ? input.cashflowBucket : (parent?.cashflowBucket ?? null),
    isPostable: true,
    isActive: true,
    isSystem: false,
    origin: input.origin ?? "MANUAL",
  }
  return ok(account)
}

/**
 * R-04: el alta de un hijo degrada al padre a no postable. Devuelve el plan
 * resultante y QUÉ padre hay que degradar; la persistencia de ambos cambios la
 * hace `models/accounts.ts` en UNA transacción (I-E2-2).
 */
export function applyNewAccount(plan: Plan, account: PlanAccount): { plan: Plan; parentDemoted: string | null } {
  const accounts = [...plan.byCode.values()]
  let parentDemoted: string | null = null
  const next = accounts.map((existing) => {
    if (account.parentCode && existing.code === account.parentCode && existing.isPostable) {
      parentDemoted = existing.code
      return { ...existing, isPostable: false }
    }
    return existing
  })
  next.push(account)
  return { plan: buildPlan(next), parentDemoted }
}

/**
 * R-06/R-10a/R-10b/R-11/R-12/R-15/R-16/R-18/R-19/R-21. Devuelve el parche ya
 * normalizado (sólo los campos que cambian de verdad) y los avisos.
 */
export function validateAccountUpdate(
  before: PlanAccount,
  patch: AccountPatch,
  ctx: EditContext
): Result<{ patch: AccountPatch; warnings: AccountWarning[] }> {
  const errors: AccountError[] = []
  const warnings: AccountWarning[] = []
  const next: AccountPatch = {}
  const isOfficial = before.origin === "SEED"
  const isOfficialLowLevel = isOfficial && before.level <= MIN_POSTABLE_LEVEL

  // R-21 / T-5: en E2 el código es inmutable (recodificar = crear + desactivar).
  if (patch.code !== undefined && patch.code !== before.code) {
    errors.push(
      err(
        "CODE_IMMUTABLE",
        "code",
        "El código de una cuenta no se puede cambiar en E2: crea la cuenta nueva y desactiva la anterior"
      )
    )
  }

  // R-19: renombrar siempre se permite, incluso en cuentas de sistema.
  if (patch.name !== undefined && patch.name.trim() !== before.name) {
    if (patch.name.trim() === "") {
      errors.push(err("CSV_ROW", "name", "El nombre de la cuenta es obligatorio"))
    } else {
      next.name = patch.name.trim()
    }
  }

  // R-10a: `statement` de cuenta oficial de nivel ≤ 3, prohibido a todos los roles.
  if (patch.statement !== undefined && patch.statement !== before.statement) {
    if (isOfficialLowLevel) {
      errors.push(
        err(
          "STATEMENT_LOCKED",
          "statement",
          `El estado financiero de la cuenta oficial ${before.code} no se puede cambiar (R-10a): ` +
            "crea una subcuenta con la clasificación que necesitas"
        )
      )
    } else {
      const statementError = checkStatementGroup(before.code, patch.statement)
      if (statementError) errors.push(statementError)
      else next.statement = patch.statement
    }
  }

  // R-10b + R-15: `epigraph` sólo ADMIN, con motivo y del catálogo de la variante.
  if (patch.epigraph !== undefined && patch.epigraph !== epigraphFor(before, ctx.variant)) {
    if (ctx.role !== "ADMIN") {
      errors.push(err("ROLE_REQUIRED", "epigraph", "Cambiar el epígrafe de una cuenta requiere rol ADMIN (R-10b)"))
    }
    if (isOfficial && !patch.reason?.trim()) {
      errors.push(
        err("REASON_REQUIRED", "reason", "Cambiar el epígrafe de una cuenta sembrada exige un motivo (R-10b)")
      )
    }
    if (ctx.hasClosedPeriodLines) {
      errors.push(
        err(
          "CLOSED_PERIOD",
          "epigraph",
          `La cuenta ${before.code} tiene líneas en un ejercicio cerrado: reexpresaría cuentas anuales ya formuladas (R-10b)`
        )
      )
    }
    if (patch.epigraph !== null && !ctx.epigraphCatalog.has(patch.epigraph)) {
      errors.push(
        err(
          "EPIGRAPH_UNKNOWN",
          "epigraph",
          `«${patch.epigraph}» no pertenece al catálogo de epígrafes de la variante ${ctx.variant} (R-15)`
        )
      )
    }
    if (errors.length === 0) next.epigraph = patch.epigraph
  }

  // R-16: aviso, nunca bloqueo.
  if (patch.analyticType !== undefined && patch.analyticType !== before.analyticType) {
    next.analyticType = patch.analyticType
    const candidate = { ...before, analyticType: patch.analyticType }
    if (!isAnalyticCoherent(candidate, ctx.variant)) {
      warnings.push({
        code: "ANALYTIC_INCOHERENT",
        accountCode: before.code,
        message:
          `El tipo analítico ${patch.analyticType} no encaja con el bloque de PyG del epígrafe ` +
          `«${epigraphFor(before, ctx.variant)}» (R-16): la conciliación EBITDA/EBIT quedará abierta`,
      })
    }
    // R-17: imputaciones ya calculadas con la clasificación anterior.
    if ((ctx.activeAllocationRuns ?? 0) > 0) {
      warnings.push({
        code: "ALLOCATION_STALE",
        accountCode: before.code,
        message: "Hay liquidaciones analíticas vigentes basadas en la clasificación anterior: recalcúlalas (R-17)",
      })
    }
  }

  // R-18′ (ADR-0012 D2, sustituye a R-18, que estaba INVERTIDA — O-12).
  //
  // El bucket clasifica la CONTRAPARTIDA de un movimiento de tesorería, así que
  // es obligatorio en toda cuenta postable **salvo** 57x, que es la propia
  // tesorería y el sujeto del informe. La regla vieja avisaba justo cuando el
  // dato estaba bien puesto; una cuenta postable sin bucket es un hueco que
  // rompería el cashflow directo en silencio.
  if (patch.cashflowBucket !== undefined && patch.cashflowBucket !== before.cashflowBucket) {
    next.cashflowBucket = patch.cashflowBucket
    if (patch.cashflowBucket !== null && before.code.startsWith("57")) {
      warnings.push({
        code: "CASHFLOW_UNEXPECTED",
        accountCode: before.code,
        message:
          `${before.code} es tesorería (57x): es el sujeto del cashflow, no una contrapartida, ` +
          "y su bucket no lo lee nadie (R-18′)",
      })
    }
    if (patch.cashflowBucket === null && before.isPostable && !before.code.startsWith("57")) {
      warnings.push({
        code: "CASHFLOW_UNEXPECTED",
        accountCode: before.code,
        message:
          `La cuenta postable ${before.code} se queda sin bucket de cashflow: sus movimientos contra ` +
          "tesorería no aparecerán en ningún bloque del informe directo (R-18′)",
      })
    }
  }

  // R-06: desactivar una cuenta de sistema, prohibido; motivo obligatorio.
  if (patch.isActive !== undefined && patch.isActive !== before.isActive) {
    if (patch.isActive === false) {
      const deactivation = canDeactivateAccount(before, ctx.plan, ctx.usage)
      if (!deactivation.ok) errors.push(...deactivation.errors)
      if (!patch.reason?.trim()) {
        errors.push(err("REASON_REQUIRED", "reason", "Desactivar una cuenta exige un motivo"))
      }
    }
    if (errors.length === 0) next.isActive = patch.isActive
  }

  if (errors.length > 0) return { ok: false, errors }
  return ok({ patch: next, warnings })
}

/**
 * R-06 + R-09: desactivar nunca borra historia. No se permite en cuentas de
 * sistema ni con hijos activos (la cascada NO se hace: se listan y decide el usuario).
 */
export function canDeactivateAccount(account: PlanAccount, plan: Plan, usage?: AccountUsage): Result<void> {
  const errors: AccountError[] = []
  if (account.isSystem) {
    errors.push(
      err(
        "SYSTEM_ACCOUNT",
        "isActive",
        `La cuenta ${account.code} está marcada como cuenta de sistema: no se puede desactivar (R-06)`
      )
    )
  }
  // El flag `isSystem` es un CACHE, y un cache puede quedarse atrás: si un
  // remapeo o el alta de un tipo impositivo no lo actualizó, desactivar la
  // cuenta dejaría el mapa apuntando a una cuenta inactiva y rompería I-plan-1.
  // Cuando el llamante trae el uso real, manda el uso.
  if (usage) {
    if (usage.mappedKeys.length > 0 && !account.isSystem) {
      errors.push(
        err(
          "IS_MAPPED",
          "isActive",
          `La cuenta ${account.code} resuelve las claves de sistema ${usage.mappedKeys.join(", ")}: ` +
            "remapéalas antes de desactivarla (I-plan-1)"
        )
      )
    }
    if (usage.taxRateCodes.length > 0 && !account.isSystem) {
      errors.push(
        err(
          "IS_TAXED",
          "isActive",
          `La usan los tipos impositivos ${usage.taxRateCodes.join(", ")}: no se puede desactivar`
        )
      )
    }
  }
  const activeChildren = childrenOf(plan, account.code).filter((c) => c.isActive)
  if (activeChildren.length > 0) {
    errors.push(
      err(
        "HAS_CHILDREN",
        "isActive",
        `La cuenta ${account.code} tiene ${activeChildren.length} subcuenta(s) activa(s): ` +
          `desactívalas primero (${activeChildren.map((c) => c.code).join(", ")})`
      )
    )
  }
  return errors.length > 0 ? fail<void>(...errors) : ok(undefined as void)
}

/**
 * R-08: borrado sólo sin apuntes, sin hijos, no de sistema, no mapeada y sin
 * tipos impositivos que la usen. `usage.movementCount` es 0 hasta E3 (riesgo R6).
 */
export function canDeleteAccount(account: PlanAccount, plan: Plan, usage: AccountUsage): Result<void> {
  const errors: AccountError[] = []
  if (usage.movementCount > 0) {
    errors.push(
      err("HAS_MOVEMENTS", "code", `La cuenta ${account.code} tiene ${usage.movementCount} apunte(s): no se borra, se desactiva (R-08)`)
    )
  }
  if (childrenOf(plan, account.code).length > 0) {
    errors.push(err("HAS_CHILDREN", "code", `La cuenta ${account.code} tiene subcuentas: bórralas primero (R-08)`))
  }
  if (account.isSystem) {
    errors.push(err("SYSTEM_ACCOUNT", "code", `La cuenta ${account.code} es cuenta de sistema (R-06)`))
  }
  if (usage.mappedKeys.length > 0) {
    errors.push(
      err(
        "IS_MAPPED",
        "code",
        `La cuenta ${account.code} está mapeada a ${usage.mappedKeys.join(", ")}: remapea la clave antes de borrarla (R-07)`
      )
    )
  }
  if (usage.taxRateCodes.length > 0) {
    errors.push(
      err("IS_TAXED", "code", `La usan los tipos impositivos ${usage.taxRateCodes.join(", ")}: no se puede borrar`)
    )
  }
  return errors.length > 0 ? fail<void>(...errors) : ok(undefined as void)
}

/**
 * R-14: la variante de PGC es inmutable con asientos posteados. En E2 no hay
 * diario, así que `postedEntries` es 0 y el cambio pasa; la comprobación queda
 * cableada contra la misma interfaz para el día que E3 cree `journal_entries`.
 */
export function validateVariantChange(
  before: PgcVariant,
  next: PgcVariant,
  postedEntries: number
): Result<PgcVariant> {
  if (before === next) return ok(next)
  if (postedEntries > 0) {
    return fail(
      err(
        "VARIANT_LOCKED",
        "pgcVariant",
        `No se puede cambiar la variante del PGC con ${postedEntries} asiento(s) posteados: ` +
          "cambiaría el modelo de cuentas anuales de periodos ya informados (R-14)"
      )
    )
  }
  return ok(next)
}
