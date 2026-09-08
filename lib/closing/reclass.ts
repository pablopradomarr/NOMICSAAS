/**
 * E9 · T9 — Reclasificación corriente / no corriente al cierre
 * (`docs/design/E9-cierre-recurrentes.md` §4.5, **R-RC-1…7**; ADR-0016 **D5**;
 * observaciones **O-6**, **O-7**, **O-8** y **R2-1** de la validación contable).
 *
 * Módulo **PURO**: sin `Date.now()`, sin Prisma, sin IO, sin LLM. Las posiciones
 * vivas, los pares sembrados y la fecha de corte entran por parámetro; salen
 * líneas de borrador, la lista de movimientos, las posiciones sin vencimiento y
 * las **bloqueantes**. Quien postea es T13/T15.
 *
 * ## Las seis decisiones que gobiernan este fichero
 *
 * 1. **La frontera se mide desde el CIERRE** (R-RC-1, norma 6ª de elaboración):
 *    «largo» es `dueDate > cutoff + thresholdMonths` (12 por defecto). Por eso el
 *    mismo saldo viaja `523 → 173` un año y `173 → 523` al siguiente.
 * 2. **Los pares sembrados** (R-RC-7, O-7 y **R2-1**), no seis. `176` va a **`5595`**
 *    y no a `526` —que es dividendo activo a pagar—, `177` va a **`500`**, y
 *    `514`, `527` y `528` **no forman par**: reclasificar los intereses a corto
 *    plazo de una deuda ya reclasificada duplicaría el pasivo corriente por su
 *    importe. Sin estos pares no hay error visible: hay un **balance mal
 *    clasificado en silencio**.
 * 3. **FIFO declarado con los matices del art. 1174 CC** (R-RC-3): por
 *    `(cuenta, contraparte, divisa)` y **jamás entre contrapartes**; orden por
 *    `dueDate` ascendente con desempate por `entryNumber` (determinismo P7);
 *    **sin compensar** deudor contra acreedor de la misma contraparte en cuentas
 *    distintas (art. 35.6 CCom); y **WARN** cuando los vencimientos del grupo
 *    tienen **onerosidad distinta**, porque ahí FIFO deja de ser neutral y la
 *    regla civil elegiría la deuda más onerosa. `SettlementAllocation` es E10.
 * 4. **(O-6) El desglose de vencimientos de la deuda es obligatorio**: una
 *    posición viva de `17x`/`52x` sin vencimientos deja el paso
 *    `RECLASIFICACION_VENCIMIENTOS` en **FAIL bloqueante** —no WARN, no lista
 *    informativa—. Presentar **cero** en «Deudas con entidades de crédito a corto
 *    plazo» teniendo préstamos vivos es lo primero que comprueba un auditor.
 *    El camino de salida es declarar el `DebtSchedule` y postear por **T-37**.
 * 5. **(R-RC-5) Una posición comercial sin `dueDate` no se reclasifica**: sale en
 *    `unknownMaturity` y decide una persona. Adivinar el vencimiento es inventar
 *    fondo de maniobra.
 * 6. **(O-8) Orden y numeración**: T-27 y T-28 llevan los saldos **ya
 *    reclasificados** y el contra-asiento de T-32 es el asiento **nº 2 de N+1**,
 *    después de la apertura. Posteado antes, el `OPENING` dejaba de ser el nº 1 e
 *    **I-E9-14** fallaba porque la apertura reproducía el cierre
 *    *desreclasificado*.
 *
 * ## Códigos de plantilla
 *
 * Las plantillas T-29…T-37 las escribe **T10** (agente B1 de la ola B). Aquí
 * viajan como **constantes de string documentadas** —con el mismo valor que
 * `TemplateCode`, que es el **nombre** (`RECLASIFICACION_VENCIMIENTOS`), no el
 * ordinal `T-32`—, no como importaciones: este módulo no depende del catálogo
 * para calcular, y así T9 y T10 avanzan sin tocar el mismo fichero.
 */

import { daysInMonth, formatLocalDate, parseLocalDate } from "@/lib/ledger/dates"
import type { Cents, DraftLine, LocalDate } from "@/lib/ledger/types"
import type { ClosingStepResult } from "@/lib/closing/vat"

// ─────────────────────────────────────────────────────────────────────────────
// Códigos de plantilla (T10 · agente B1). Constantes documentadas, no imports.
// ─────────────────────────────────────────────────────────────────────────────

/** **T-32** — el asiento de reclasificación del cierre. */
export const TEMPLATE_RECLASIFICACION = "RECLASIFICACION_VENCIMIENTOS"
/** **T-37** — alta con **una línea de `170`/`520` por vencimiento** (O-6). */
export const TEMPLATE_ALTA_PRESTAMO = "ALTA_PRESTAMO"

// ─────────────────────────────────────────────────────────────────────────────
// Tipos planos
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Posición viva por vencimiento. `openCents` va **con signo** (`debe − haber`):
 * positivo = deudora (un crédito), negativo = acreedora (una deuda).
 */
export type MaturityPosition = {
  accountCode: string
  counterpartyId: string | null
  currency: string
  dueDate: LocalDate | null
  openCents: Cents
  /** Desempate determinista del FIFO (P7). */
  entryNumber: number
  /** Identificación legible en la evidencia (nº de préstamo, factura…). */
  reference?: string | null
  /**
   * ¿El vencimiento tiene **interés implícito reconocido** (T-31)? Con
   * onerosidad distinta dentro del grupo, FIFO deja de ser neutral (art. 1174
   * CC) y se emite **WARN** con el caso: es la única forma de decirlo sin
   * inventar una imputación que el usuario no ha declarado (E10).
   */
  hasImplicitInterest?: boolean
}

/** Par sembrado: la cuenta de **largo** plazo y su gemela de **corto**. */
export type ReclassPairRef = {
  longCode: string
  shortCode: string
  /** Bloque del PGC al que pertenece, para la evidencia. */
  block?: string
}

export type ReclassDirection = "A_CORTO" | "A_LARGO"

export type ReclassMove = {
  fromCode: string
  toCode: string
  direction: ReclassDirection
  counterpartyId: string | null
  currency: string
  dueDate: LocalDate
  /** Importe movido, **siempre positivo**. */
  amountCents: Cents
  /**
   * ¿El saldo movido era **deudor**? El movimiento se enseña por su importe
   * —siempre positivo—, pero el lado del asiento lo decide el signo del saldo:
   * un crédito (deudor) se carga en la cuenta de destino y una deuda (acreedor)
   * se carga en la de origen.
   */
  debtor: boolean
  entryNumber: number
  reference?: string | null
}

/** Posición que **impide cerrar** (O-6): deuda de `17x`/`52x` sin desglose. */
export type BlockingPosition = {
  accountCode: string
  counterpartyId: string | null
  currency: string
  openCents: Cents
  reference?: string | null
  motivo: string
}

export type ReclassWarning = {
  code: "ONEROSIDAD_DISTINTA" | "PAR_NO_SEMBRADO" | "CUENTA_NO_RECLASIFICABLE"
  accountCode: string
  counterpartyId: string | null
  currency: string
  mensaje: string
}

export type ReclassOptions = {
  /** Norma 6ª: doce meses por defecto. */
  thresholdMonths?: number
  /**
   * Cuentas que existen y son postables en el plan de la organización. Cuando
   * se aporta, un par cuya cuenta no exista **no se usa** y se avisa (D5.2:
   * «siembra sólo donde ambas cuentas existan y sean postables»).
   */
  postableAccountCodes?: readonly string[]
}

export type ReclassResult = {
  lines: DraftLine[]
  moved: ReclassMove[]
  unknownMaturity: MaturityPosition[]
  blocking: BlockingPosition[]
  warnings: ReclassWarning[]
  /** Frontera efectiva: `cutoff + thresholdMonths`. Se enseña en pantalla. */
  boundaryDate: LocalDate
}

// ─────────────────────────────────────────────────────────────────────────────
// R-RC-7 (O-7, R2-1) · los veintitrés pares
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **Los pares.** Se siembran en la base (M1…M6 de T4); esta constante es la
 * **misma lista**, para que el motor pueda calcular sin base de datos y para que
 * un test compare las dos.
 *
 * **Discrepancia documental anotada (T9).** §4.5 del diseño y D5.2 de ADR-0016
 * dicen «veintitrés pares», pero la tabla que los enumera —la misma en los dos
 * documentos— contiene **veintidós**: 6 del PGC + 4 de partes vinculadas + 6 del
 * resto de deuda (172, 175, 176, 177, 180, 185) + 6 de inversiones financieras
 * (250, 251, 254, 258, 260, 265). Se implementa **la lista enumerada**, que es
 * la que se puede verificar cuenta a cuenta, y se deja escrito aquí: inventar un
 * par nº 23 para cuadrar un cardinal sería sembrar una reclasificación que nadie
 * ha validado. Pendiente de confirmación del `experto-contable`.
 */
export const RECLASS_PAIRS: readonly ReclassPairRef[] = [
  // Los seis del PGC ya previstos.
  { longCode: "170", shortCode: "520", block: "PGC" },
  { longCode: "171", shortCode: "521", block: "PGC" },
  { longCode: "173", shortCode: "523", block: "PGC" },
  { longCode: "174", shortCode: "524", block: "PGC" },
  { longCode: "252", shortCode: "542", block: "PGC" },
  { longCode: "253", shortCode: "543", block: "PGC" },
  // Partes vinculadas, cuatro pares.
  { longCode: "160", shortCode: "510", block: "PARTES_VINCULADAS" },
  { longCode: "161", shortCode: "511", block: "PARTES_VINCULADAS" },
  { longCode: "162", shortCode: "512", block: "PARTES_VINCULADAS" },
  { longCode: "163", shortCode: "513", block: "PARTES_VINCULADAS" },
  // Resto de deuda. `176 → 5595` (R2-1), NO `526`; `177 → 500` (R2-1), faltaba.
  { longCode: "172", shortCode: "522", block: "DEUDA" },
  { longCode: "175", shortCode: "525", block: "DEUDA" },
  { longCode: "176", shortCode: "5595", block: "DEUDA" },
  { longCode: "177", shortCode: "500", block: "DEUDA" },
  { longCode: "180", shortCode: "560", block: "DEUDA" },
  { longCode: "185", shortCode: "561", block: "DEUDA" },
  // Inversiones financieras.
  { longCode: "250", shortCode: "540", block: "INVERSIONES" },
  { longCode: "251", shortCode: "541", block: "INVERSIONES" },
  { longCode: "254", shortCode: "544", block: "INVERSIONES" },
  { longCode: "258", shortCode: "548", block: "INVERSIONES" },
  { longCode: "260", shortCode: "565", block: "INVERSIONES" },
  { longCode: "265", shortCode: "566", block: "INVERSIONES" },
]

/**
 * **R2-1.** Cuentas que **no se reclasifican por sí mismas**, aunque lo parezca:
 *
 * - `514` «Otras deudas a corto plazo con partes vinculadas»: no tiene simétrica
 *   de largo plazo en `16x`.
 * - `527` y `528`: **intereses a corto plazo** de deudas *ya* reclasificadas.
 *   Moverlos duplicaría el pasivo corriente por el importe de los intereses.
 */
export const NON_RECLASSIFIABLE_ACCOUNTS: readonly string[] = ["514", "527", "528"]

/**
 * Prefijos cuya posición viva **exige** desglose de vencimientos (O-6): deuda a
 * largo y a corto plazo con entidades de crédito y asimiladas.
 */
const DEBT_PREFIXES: readonly string[] = ["17", "52"]

const requiresSchedule = (accountCode: string): boolean =>
  DEBT_PREFIXES.some((p) => accountCode.startsWith(p)) && !NON_RECLASSIFIABLE_ACCOUNTS.includes(accountCode)

// ─────────────────────────────────────────────────────────────────────────────
// Fechas
// ─────────────────────────────────────────────────────────────────────────────

/** `date + n` meses, ajustando el día al último del mes cuando no existe. */
export function addMonthsToDate(date: LocalDate, n: number): LocalDate {
  const ymd = parseLocalDate(date)
  if (!ymd) throw new TypeError(`fecha inválida: ${date}`)
  const total = ymd.year * 12 + (ymd.month - 1) + n
  const year = Math.floor(total / 12)
  const month = (total % 12) + 1
  return formatLocalDate({ year, month, day: Math.min(ymd.day, daysInMonth(year, month)) })
}

/**
 * **R-RC-1.** Frontera corriente / no corriente: es **largo plazo** lo que vence
 * *después* de `cutoff + thresholdMonths`.
 */
export function maturityBoundary(cutoff: LocalDate, thresholdMonths = 12): LocalDate {
  return addMonthsToDate(cutoff, thresholdMonths)
}

export const isLongTerm = (dueDate: LocalDate, boundary: LocalDate): boolean => dueDate > boundary

// ─────────────────────────────────────────────────────────────────────────────
// R-RC-3 · FIFO por (cuenta, contraparte, divisa)
// ─────────────────────────────────────────────────────────────────────────────

const groupKey = (p: { accountCode: string; counterpartyId: string | null; currency: string }): string =>
  `${p.accountCode} ${p.counterpartyId ?? ""} ${p.currency}`

/** Orden del FIFO: `dueDate` ascendente, y a igualdad, `entryNumber` (P7). */
export const byMaturity = (a: MaturityPosition, b: MaturityPosition): number => {
  const da = a.dueDate ?? "9999-12-31"
  const db = b.dueDate ?? "9999-12-31"
  if (da !== db) return da < db ? -1 : 1
  return a.entryNumber - b.entryNumber
}

/**
 * **R-RC-3 · FIFO declarado.** Dentro de un grupo `(cuenta, contraparte,
 * divisa)`, las filas de signo **contrario** al neto del grupo son cobros o
 * pagos todavía **sin imputar** a un vencimiento concreto: se aplican a los
 * vencimientos **más antiguos primero**. Nunca cruzan de grupo, así que no hay
 * compensación entre contrapartes ni entre cuentas (art. 35.6 CCom).
 *
 * Devuelve los vencimientos **vivos** tras la imputación, con su importe
 * pendiente, y avisa cuando el grupo mezcla vencimientos de **onerosidad
 * distinta** (art. 1174 CC: en su defecto se paga la deuda más onerosa, no la
 * más antigua).
 */
export function applyFifo(group: readonly MaturityPosition[]): {
  outstanding: MaturityPosition[]
  allocatedCents: Cents
  mixedOnerosity: boolean
} {
  const net = group.reduce((acc, p) => acc + p.openCents, 0)
  const sign = net === 0 ? 0 : net > 0 ? 1 : -1
  if (sign === 0) {
    return { outstanding: [], allocatedCents: 0, mixedOnerosity: false }
  }
  const dues = group.filter((p) => Math.sign(p.openCents) === sign).sort(byMaturity)
  const settlements = group.filter((p) => Math.sign(p.openCents) === -sign)
  let toAllocate = settlements.reduce((acc, p) => acc + Math.abs(p.openCents), 0)
  const allocated = toAllocate
  const outstanding: MaturityPosition[] = []
  for (const due of dues) {
    const open = Math.abs(due.openCents)
    if (toAllocate >= open) {
      toAllocate -= open
      continue
    }
    const remaining = open - toAllocate
    toAllocate = 0
    outstanding.push({ ...due, openCents: sign > 0 ? remaining : -remaining })
  }
  const onerosities = new Set(dues.map((d) => d.hasImplicitInterest === true))
  return { outstanding, allocatedCents: allocated, mixedOnerosity: allocated > 0 && onerosities.size > 1 }
}

// ─────────────────────────────────────────────────────────────────────────────
// El asiento (T-32)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **R-RC-1…7.** Reclasificación de las posiciones vivas a la fecha de cierre.
 *
 * - Un saldo en la cuenta **de largo** que vence *dentro* de la frontera baja a
 *   la cuenta de **corto**, y al revés.
 * - Una posición **sin `dueDate`** en cuentas comerciales sale en
 *   `unknownMaturity`: no se adivina.
 * - Una posición viva de **`17x`/`52x` sin vencimientos** sale en `blocking`:
 *   el paso queda en **FAIL bloqueante** (O-6) hasta que se declare el
 *   `DebtSchedule` y se postee por **T-37**.
 * - `514`, `527` y `528` no se mueven (R2-1) y se dejan dichas en `warnings`.
 *
 * El asiento resultante **suma cero por par y por contraparte** (I-E9-16).
 */
export function reclassifyMaturities(
  positions: readonly MaturityPosition[],
  pairs: readonly ReclassPairRef[],
  cutoff: LocalDate,
  options: ReclassOptions = {}
): ReclassResult {
  const thresholdMonths = options.thresholdMonths ?? 12
  const boundaryDate = maturityBoundary(cutoff, thresholdMonths)
  const postable = options.postableAccountCodes ? new Set(options.postableAccountCodes) : null

  const usable = pairs.filter((p) => {
    if (!postable) return true
    return postable.has(p.longCode) && postable.has(p.shortCode)
  })
  const longToShort = new Map(usable.map((p) => [p.longCode, p]))
  const shortToLong = new Map(usable.map((p) => [p.shortCode, p]))

  const warnings: ReclassWarning[] = []
  if (postable) {
    for (const pair of pairs) {
      if (usable.includes(pair)) continue
      warnings.push({
        code: "PAR_NO_SEMBRADO",
        accountCode: `${pair.longCode}↔${pair.shortCode}`,
        counterpartyId: null,
        currency: "",
        mensaje: `el par ${pair.longCode}↔${pair.shortCode} no se siembra: alguna de las dos cuentas no existe o no es postable en el plan`,
      })
    }
  }

  // Agrupación por (cuenta, contraparte, divisa): el FIFO jamás cruza de grupo.
  const groups = new Map<string, MaturityPosition[]>()
  for (const p of positions) {
    const list = groups.get(groupKey(p))
    if (list) list.push(p)
    else groups.set(groupKey(p), [p])
  }

  const moved: ReclassMove[] = []
  const unknownMaturity: MaturityPosition[] = []
  const blocking: BlockingPosition[] = []

  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key) as MaturityPosition[]
    const head = group[0]

    if (NON_RECLASSIFIABLE_ACCOUNTS.includes(head.accountCode)) {
      warnings.push({
        code: "CUENTA_NO_RECLASIFICABLE",
        accountCode: head.accountCode,
        counterpartyId: head.counterpartyId,
        currency: head.currency,
        mensaje:
          head.accountCode === "514"
            ? "514 no tiene simétrica de largo plazo en 16x: no se reclasifica (R2-1)"
            : `${head.accountCode} son intereses a corto plazo de una deuda ya reclasificada: moverlos duplicaría el pasivo corriente (R2-1)`,
      })
      continue
    }

    const pair = longToShort.get(head.accountCode) ?? shortToLong.get(head.accountCode)
    const isLongAccount = longToShort.has(head.accountCode)

    const { outstanding, mixedOnerosity } = applyFifo(group)
    if (mixedOnerosity) {
      warnings.push({
        code: "ONEROSIDAD_DISTINTA",
        accountCode: head.accountCode,
        counterpartyId: head.counterpartyId,
        currency: head.currency,
        mensaje:
          "el grupo mezcla vencimientos con y sin interés implícito reconocido: FIFO deja de ser neutral " +
          "(art. 1174 CC elegiría la deuda más onerosa). La imputación explícita llega en E10",
      })
    }

    for (const position of outstanding) {
      if (position.openCents === 0) continue
      if (position.dueDate === null) {
        if (requiresSchedule(position.accountCode)) {
          blocking.push({
            accountCode: position.accountCode,
            counterpartyId: position.counterpartyId,
            currency: position.currency,
            openCents: position.openCents,
            reference: position.reference ?? null,
            motivo:
              `declare el cuadro de vencimientos de la deuda ${position.reference ?? position.accountCode}: ` +
              `sin desglose no se puede presentar su parte corriente (O-6). Se registra por ${TEMPLATE_ALTA_PRESTAMO}`,
          })
        } else {
          unknownMaturity.push(position)
        }
        continue
      }
      if (!pair) continue // cuenta fuera del universo de la reclasificación

      const long = isLongTerm(position.dueDate, boundaryDate)
      if (isLongAccount && long) continue
      if (!isLongAccount && !long) continue

      moved.push({
        fromCode: position.accountCode,
        toCode: isLongAccount ? pair.shortCode : pair.longCode,
        direction: isLongAccount ? "A_CORTO" : "A_LARGO",
        counterpartyId: position.counterpartyId,
        currency: position.currency,
        dueDate: position.dueDate,
        amountCents: Math.abs(position.openCents),
        debtor: position.openCents > 0,
        entryNumber: position.entryNumber,
        reference: position.reference ?? null,
      })
    }
  }

  return { lines: reclassLines(moved), moved, unknownMaturity, blocking, warnings, boundaryDate }
}

/**
 * **R-RC-2.** Líneas de **T-32**: el saldo sale de su cuenta y entra en la
 * gemela. Un saldo **deudor** (un crédito) se abona en la de origen y se carga
 * en la de destino; un saldo **acreedor** (una deuda), al revés. La suma es cero
 * por par y por contraparte (**I-E9-16**), y el vencimiento viaja en la línea
 * para que la reclasificación del año siguiente pueda medirse.
 */
export function reclassLines(moves: readonly ReclassMove[]): DraftLine[] {
  const lines: DraftLine[] = []
  let lineNo = 1
  for (const move of moves) {
    const debtor = move.debtor
    const amount = move.amountCents
    const common = {
      counterpartyId: move.counterpartyId,
      dueDate: move.dueDate,
      analyticType: "NO_ANALITICO" as const,
      description:
        `Reclasificación ${move.direction === "A_CORTO" ? "a corto" : "a largo"} plazo ` +
        `${move.fromCode} → ${move.toCode}${move.reference ? ` (${move.reference})` : ""}`,
    }
    // Destino y origen, en este orden: primero el cargo, luego el abono.
    lines.push(
      debtor
        ? { lineNo: lineNo++, accountCode: move.toCode, debitCents: amount, creditCents: 0, ...common }
        : { lineNo: lineNo++, accountCode: move.fromCode, debitCents: amount, creditCents: 0, ...common }
    )
    lines.push(
      debtor
        ? { lineNo: lineNo++, accountCode: move.fromCode, debitCents: 0, creditCents: amount, ...common }
        : { lineNo: lineNo++, accountCode: move.toCode, debitCents: 0, creditCents: amount, ...common }
    )
  }
  return lines
}

// ─────────────────────────────────────────────────────────────────────────────
// El paso del checklist (O-6): FAIL BLOQUEANTE sin desglose
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **`RECLASIFICACION_VENCIMIENTOS`.** Bloqueante siempre (uno de los nueve de
 * §4.8):
 *
 * - deuda de `17x`/`52x` **sin desglose** ⇒ **FAIL**, sello `DEUDA_SIN_DESGLOSE`;
 * - posiciones comerciales **sin vencimiento** ⇒ **WARN**, sello
 *   `VENCIMIENTOS_SIN_FECHA` (una persona decide, el cierre no las adivina);
 * - en otro caso, **PASS** con el detalle de lo movido.
 */
export function reclassStep(result: ReclassResult): ClosingStepResult {
  const step = "RECLASIFICACION_VENCIMIENTOS"
  const block = "Presentación"
  const query =
    "SELECT l.account_code, l.counterparty_id, l.due_date, sum(l.debit_cents - l.credit_cents) AS abierto " +
    "FROM journal_lines l WHERE l.organization_id = $1 AND l.account_code = ANY($2) " +
    "GROUP BY 1, 2, 3 HAVING sum(l.debit_cents - l.credit_cents) <> 0"

  if (result.blocking.length > 0) {
    return {
      step,
      block,
      status: "FAIL",
      blocking: true,
      evidencia:
        `${result.blocking.length} deuda(s) viva(s) sin cuadro de vencimientos: ` +
        result.blocking
          .slice(0, 10)
          .map((b) => `${b.reference ?? b.accountCode} (${b.accountCode}, ${b.openCents} c): ${b.motivo}`)
          .join(" · "),
      sealReason: "DEUDA_SIN_DESGLOSE",
      query,
    }
  }
  if (result.unknownMaturity.length > 0) {
    return {
      step,
      block,
      status: "WARN",
      blocking: true,
      evidencia:
        `${result.unknownMaturity.length} posición(es) sin fecha de vencimiento no se reclasifican: ` +
        result.unknownMaturity
          .slice(0, 10)
          .map((p) => `${p.accountCode}/${p.counterpartyId ?? "sin contraparte"} (${p.openCents} c)`)
          .join(" · ") +
        ". Adivinar el vencimiento es inventar fondo de maniobra (R-RC-5)",
      sealReason: "VENCIMIENTOS_SIN_FECHA",
      query,
    }
  }
  return {
    step,
    block,
    status: "PASS",
    blocking: true,
    evidencia:
      `${result.moved.length} posición(es) reclasificada(s) con frontera ${result.boundaryDate} ` +
      `(${result.moved.filter((m) => m.direction === "A_CORTO").length} a corto, ` +
      `${result.moved.filter((m) => m.direction === "A_LARGO").length} a largo); ` +
      "toda posición viva tiene vencimiento",
    query,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// R-RC-6 (O-8) · el orden de la reversión en la apertura
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **R-RC-6 (O-8).** El orden **no es un detalle**: la reclasificación es un
 * ajuste de *presentación*, no un hecho económico. Si se dejara «pegada», los
 * pagos del año siguiente cancelarían `173` en vez de `523` y la base del FIFO
 * quedaría contaminada; y si su contra-asiento se posteara **antes** de T-28, el
 * `OPENING` dejaría de ser el nº 1 y la apertura reproduciría el cierre
 * *desreclasificado* (**I-E9-14** en FAIL).
 */
export const RECLASS_REVERSAL_ORDER: readonly { orden: number; asiento: string; entryNumberEsperado: number | null }[] = [
  { orden: 1, asiento: "T-27 (cierre de N, con los saldos ya reclasificados)", entryNumberEsperado: null },
  { orden: 2, asiento: "T-28 (apertura de N+1, espejo exacto)", entryNumberEsperado: 1 },
  { orden: 3, asiento: `contra-asiento de T-32 (${TEMPLATE_RECLASIFICACION})`, entryNumberEsperado: 2 },
]

export type OpeningEntryRef = {
  entryNumber: number
  kind: string
  templateCode?: string | null
  reversesEntryId?: string | null
}

/**
 * ¿La apertura de N+1 es el nº 1 y el contra-asiento de T-32 el nº 2? Devuelve
 * la lista de desviaciones (vacía = correcto). Lo consume **I-E9-14** y el
 * asistente de cierre.
 */
export function reclassReversalDeviations(entries: readonly OpeningEntryRef[]): string[] {
  const problems: string[] = []
  const opening = entries.find((e) => e.kind === "OPENING")
  if (!opening) return ["no hay asiento de apertura en el ejercicio siguiente"]
  if (opening.entryNumber !== 1) {
    problems.push(`la apertura es el asiento nº ${opening.entryNumber} y debe ser el nº 1 (O-8)`)
  }
  const reversal = entries.find((e) => e.templateCode === TEMPLATE_RECLASIFICACION && e.reversesEntryId)
  if (reversal && reversal.entryNumber <= opening.entryNumber) {
    problems.push(
      `el contra-asiento de T-32 (${TEMPLATE_RECLASIFICACION}) es el nº ${reversal.entryNumber}, anterior o igual a la apertura: ` +
        "debe ser el nº 2 de N+1 (O-8)"
    )
  }
  return problems
}
