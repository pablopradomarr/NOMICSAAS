/**
 * E7 · T6 — El badge **`✓ validado contra fuente`** (§3.6, ADR-0015 D2, O-16/O-17).
 *
 * Dos precisiones sin las cuales el badge mentiría:
 *
 * **1 · Por composición (O-16).** El epígrafe `B.VII.1 Tesorería` agrega TODAS
 * las 57x, **caja incluida**, y la caja no tiene extracto ni puede tenerlo.
 *
 * > Una cifra lleva `✓ validado contra fuente` si y sólo si **todas** las cuentas
 * > que la componen están íntegramente conciliadas para el periodo, con I-E7-1 y
 * > **I-E7-6b** en PASS y **ni un pendiente sin explicar**.
 *
 * Consecuencia explícita y honesta: *una organización con caja no verá nunca el
 * badge en la tesorería total del balance; lo verá en el detalle por cuenta
 * bancaria y en el cashflow si su cashflow no incluye caja.* Un arqueo de caja
 * firmado **no** es fuente equivalente en E7 (podría serlo en E12, con ADR).
 *
 * **2 · `explicado`, con criterio verificable (O-17).** Listar un pendiente no lo
 * explica: eso es conceder el sello por enumeración, el anti-patrón de la spec §5.
 *
 * **El badge se deriva en lectura y no se persiste jamás.** Un extracto importado
 * en febrero puede traer un movimiento con fecha de operación de diciembre y
 * tiene que **retirar** un badge ya concedido sobre diciembre; un badge
 * almacenado no podría hacerlo (criterio 19).
 *
 * Módulo PURO.
 */

import type { BankReconciliationSummary, PendingItem } from "@/lib/audit/invariants-e7"
import type { Cents, LocalDate } from "@/lib/audit/types"
import { isCashAccount, isUnderAccount, type BankAccountRef } from "@/lib/bank/types"

/** Los tres niveles del motor contable. `verificado` es del camino documental. */
export type FigureConfidence = "calculado" | "comprobado" | "validado"

export type PendingExplanation = {
  pending: PendingItem
  explicado: boolean
  /** Por qué está —o no— explicado. Se pinta literal junto al pendiente. */
  motivo: string
}

export type BadgeInput = {
  /** Cuentas contables que COMPONEN la cifra (todas, no una muestra). */
  accountCodes: readonly string[]
  /** Cuentas bancarias del alcance, con su anclaje y su `transitWarnDays`. */
  bankAccounts: readonly BankAccountRef[]
  /** Cuadres ya calculados (uno por cuenta bancaria) a la fecha de la cifra. */
  summaries: readonly BankReconciliationSummary[]
  /** ¿Han pasado los invariantes del diario que sostienen la cifra? */
  invariantsPass: boolean
  /**
   * Pendientes que una conciliación posterior recoge, por id. Los aporta el
   * borde (T9): un pendiente de banco explicado por un asiento posterior ya
   * conciliado, o al revés.
   */
  resolvedLaterIds?: readonly string[]
}

export type BadgeResult = {
  badge: FigureConfidence
  /** Cuentas de la composición que no pueden tener fuente externa (caja). */
  cuentasSinFuente: readonly string[]
  /** Cuentas bancarias que no cuadran, no tienen anclaje o tienen hueco. */
  cuentasNoValidadas: readonly string[]
  pendientesSinExplicar: readonly PendingExplanation[]
  motivos: readonly string[]
}

/**
 * Un pendiente está **explicado** si (§3.6):
 *
 * 1. es del lado **banco** y existe ya un asiento posterior conciliado que lo
 *    recoge; **o**
 * 2. es del lado **libros** y existe ya una línea de extracto posterior
 *    conciliada que lo recoge; **o**
 * 3. está **tipado** y su antigüedad es **menor** que `transitWarnDays` de la
 *    cuenta.
 *
 * Cualquier otro pendiente es `sin explicar` y **retira el badge**.
 */
export function explainPending(
  pending: PendingItem,
  opts: { transitWarnDays: number; resolvedLaterIds: ReadonlySet<string> }
): PendingExplanation {
  if (opts.resolvedLaterIds.has(pending.id)) {
    return {
      pending,
      explicado: true,
      motivo:
        pending.side === "BANCO"
          ? "lo recoge un asiento posterior ya conciliado"
          : "lo recoge una línea de extracto posterior ya conciliada",
    }
  }
  if (pending.kind !== null && pending.ageDays < opts.transitWarnDays) {
    return {
      pending,
      explicado: true,
      motivo: `partida en tránsito tipada ${pending.kind} con ${pending.ageDays} día(s), por debajo del plazo declarado (${opts.transitWarnDays})`,
    }
  }
  if (pending.kind === null) {
    return { pending, explicado: false, motivo: "sin tipar: nadie ha dicho qué es" }
  }
  return {
    pending,
    explicado: false,
    motivo: `${pending.kind} con ${pending.ageDays} día(s), por encima del plazo declarado (${opts.transitWarnDays})`,
  }
}

/**
 * El badge de UNA cifra, derivado en lectura. Nunca devuelve `validado` sin
 * haber mirado todas las cuentas que la componen.
 */
export function badgeForFigure(input: BadgeInput): BadgeResult {
  const motivos: string[] = []
  const resolved = new Set(input.resolvedLaterIds ?? [])

  if (!input.invariantsPass) {
    return {
      badge: "calculado",
      cuentasSinFuente: [],
      cuentasNoValidadas: [],
      pendientesSinExplicar: [],
      motivos: ["los invariantes que sostienen la cifra no están en PASS"],
    }
  }

  const cuentasSinFuente = input.accountCodes.filter((code) => isCashAccount(code))
  const cuentasNoValidadas: string[] = []
  const pendientesSinExplicar: PendingExplanation[] = []

  for (const code of input.accountCodes) {
    if (isCashAccount(code)) continue
    const account = input.bankAccounts.find((a) => isUnderAccount(code, a.accountCode) || isUnderAccount(a.accountCode, code))
    if (account === undefined) {
      cuentasNoValidadas.push(code)
      motivos.push(`${code} no tiene cuenta bancaria declarada: no hay fuente contra la que validarla`)
      continue
    }
    const summary = input.summaries.find((s) => s.bankAccountId === account.id)
    if (summary === undefined) {
      cuentasNoValidadas.push(code)
      motivos.push(`${code} no tiene cuadre calculado para el periodo`)
      continue
    }
    if (!summary.anchored) {
      cuentasNoValidadas.push(code)
      motivos.push(`${code} no tiene anclaje: no se sabe desde qué fecha está conciliada`)
      continue
    }
    if (!summary.chain.covered) {
      cuentasNoValidadas.push(code)
      motivos.push(`${code} tiene hueco en la cadena de extractos (I-E7-6b)`)
      continue
    }
    if (summary.diferencia !== 0) {
      cuentasNoValidadas.push(code)
      motivos.push(`${code} no cuadra: I-E7-1 no está en PASS`)
      continue
    }
    // Los pendientes que el propio cuadre declara recogidos por un grupo a
    // caballo del corte cuentan siempre, aunque el llamante no los pase (H-5).
    const resolvedHere = new Set([...resolved, ...summary.resolvedLaterIds])
    for (const pending of [...summary.pendientesBanco, ...summary.pendientesLibros]) {
      const explained = explainPending(pending, {
        transitWarnDays: account.transitWarnDays,
        resolvedLaterIds: resolvedHere,
      })
      if (!explained.explicado) pendientesSinExplicar.push(explained)
    }
  }

  if (cuentasSinFuente.length > 0) {
    motivos.push(
      `la cifra incluye caja (${cuentasSinFuente.join(", ")}), que no tiene extracto: el badge se concede por composición y la caja lo impide`
    )
  }
  for (const p of pendientesSinExplicar) {
    motivos.push(`pendiente sin explicar ${p.pending.id} (${p.motivo})`)
  }

  const validado = cuentasSinFuente.length === 0 && cuentasNoValidadas.length === 0 && pendientesSinExplicar.length === 0
  return {
    badge: validado ? "validado" : "comprobado",
    cuentasSinFuente,
    cuentasNoValidadas,
    pendientesSinExplicar,
    motivos,
  }
}

/** Datos que la pantalla necesita junto al badge de una cuenta bancaria. */
export type AccountBadgeRow = {
  accountCode: string
  badge: FigureConfidence
  diferenciaCents: Cents | null
  ignoradosCents: Cents
  cutoff: LocalDate
}

export function badgeByBankAccount(input: Omit<BadgeInput, "accountCodes">): readonly AccountBadgeRow[] {
  return input.summaries.map((summary) => ({
    accountCode: summary.accountCode,
    badge: badgeForFigure({ ...input, accountCodes: [summary.accountCode] }).badge,
    diferenciaCents: summary.diferencia,
    ignoradosCents: summary.ignoradosCents,
    cutoff: summary.cutoff,
  }))
}
