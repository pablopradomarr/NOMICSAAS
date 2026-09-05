/**
 * E6 · T6 — Balance de situación (ADR-0012 D1, reglas R-B1…R-B6).
 *
 * Cuatro fotos (`PRE_REGULARIZACION`, `POST_REGULARIZACION`, `POST_CIERRE` y la
 * apertura del ejercicio siguiente, que es `POST_CIERRE` sobre el FY nuevo), dos
 * modelos (NORMAL y PYMES) y comparativo doble.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠ NO RESTAR LAS CONTRA-CUENTAS (R-B3).
 *
 * `isContra` **no interviene en el cálculo**. Con R-B2 la contra-cuenta ya resta
 * sola: `2816` tiene saldo acreedor y sale como −300 000 dentro de su epígrafe
 * de activo. Aplicar `isContra` ADEMÁS del signo la restaría dos veces y el
 * inmovilizado del fixture pasaría de 2 665 000 a 3 935 000. Es el error que la
 * ronda 1 del diseño tenía escrito y que cualquiera puede «re-arreglar» al leer
 * la columna. `isContra` es (a) marca `(−)` en pantalla y (b) check de signo
 * (I-E6-10). Nada más.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Módulo PURO: sin IO, sin `Date.now()`, sin Prisma.
 */

import { cellProvenance } from "@/lib/ledger/provenance"
import type { Cents, EntryKind, LocalDate } from "@/lib/ledger/types"
import { buildEpigraphTree, type EpigraphLeaf } from "@/lib/ledger/reports/epigraphs-tree"
import {
  balancesByAccount,
  buildAccountIndex,
  excludingKinds,
  SNAPSHOT_EXCLUDED,
  type AccountIndex,
  type BalanceSnapshot,
  type PgcVariant,
  type ProvenanceContext,
  type ReportLine,
  type ReportPeriod,
  type StatementAccount,
  type StatementRow,
} from "@/lib/ledger/reports/types"

// ─────────────────────────────────────────────────────────────────────────────
// R-B4 — espejo de las 7 cuentas bidireccionales
//
// El seed guarda SIEMPRE la ruta deudora (activo). Con saldo acreedor la cuenta
// migra al epígrafe de pasivo de esta tabla, que es CERRADA y no configurable
// por el usuario: son siete cuentas y la correspondencia la fija el modelo
// oficial, no una preferencia. Cadenas verbatim del seed
// (`bidirectionalMirror` de `docs/design/fixtures/estados-esperados.json`).
// ─────────────────────────────────────────────────────────────────────────────

const OTROS_PASIVOS_FINANCIEROS_NORMAL =
  "C) Pasivo corriente / III. Deudas a corto plazo / 5. Otros pasivos financieros"
const OTROS_PASIVOS_FINANCIEROS_PYMES =
  "C) Pasivo corriente / II. Deudas a corto plazo / 5. Otros pasivos financieros"
const DEUDAS_GRUPO_NORMAL = "C) Pasivo corriente / IV. Deudas con empresas del grupo y asociadas a corto plazo"
const DEUDAS_GRUPO_PYMES = "C) Pasivo corriente / III. Deudas con empresas del grupo y asociadas a corto plazo"
const ACREEDORES_VARIOS_NORMAL =
  "C) Pasivo corriente / V. Acreedores comerciales y otras cuentas a pagar / 3. Acreedores varios"
const ACREEDORES_VARIOS_PYMES =
  "C) Pasivo corriente / IV. Acreedores comerciales y otras cuentas a pagar / 3. Acreedores varios"

export const BIDIRECTIONAL_MIRROR: Readonly<Record<string, Readonly<Record<PgcVariant, string>>>> = {
  "551": { GENERAL: OTROS_PASIVOS_FINANCIEROS_NORMAL, PYMES: OTROS_PASIVOS_FINANCIEROS_PYMES },
  "552": { GENERAL: DEUDAS_GRUPO_NORMAL, PYMES: DEUDAS_GRUPO_PYMES },
  "5523": { GENERAL: DEUDAS_GRUPO_NORMAL, PYMES: DEUDAS_GRUPO_PYMES },
  "5524": { GENERAL: DEUDAS_GRUPO_NORMAL, PYMES: DEUDAS_GRUPO_PYMES },
  "5525": { GENERAL: OTROS_PASIVOS_FINANCIEROS_NORMAL, PYMES: OTROS_PASIVOS_FINANCIEROS_PYMES },
  "554": { GENERAL: ACREEDORES_VARIOS_NORMAL, PYMES: ACREEDORES_VARIOS_PYMES },
  "555": { GENERAL: ACREEDORES_VARIOS_NORMAL, PYMES: ACREEDORES_VARIOS_PYMES },
}

/** Espejo de la cuenta o del ancestro más cercano que lo declare. */
export function mirrorEpigraphOf(code: string, variant: PgcVariant): string | null {
  for (let cur = code; cur.length > 0; cur = cur.slice(0, -1)) {
    const mirror = BIDIRECTIONAL_MIRROR[cur]
    if (mirror) return mirror[variant]
  }
  return null
}

/**
 * Nota al pie OBLIGATORIA (§7.4 de la validación contable, decisión 4 del
 * coordinador). Viaja en el `result` y se imprime en pantalla, en el PDF y en la
 * hoja del XLSX: muchos programas netean `473` contra `4752` y el ERP no lo
 * hace; hay que decirlo, no dejarlo implícito.
 */
/** Límite inferior del drill-down de una celda de balance: el saldo es acumulado. */
export const BALANCE_DRILLDOWN_FROM = "0001-01-01"

export const NOTA_NO_COMPENSACION =
  "Sin compensación de saldos: los créditos frente a la Hacienda Pública (retenciones y pagos a " +
  "cuenta soportados, 473) se presentan en el activo y la deuda por impuesto corriente (4752) en el " +
  "pasivo, sin netear (art. 37 CdC y NRV 9ª)."

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

export type BalanceComparative = {
  lines: readonly ReportLine[]
  from: LocalDate
  to: LocalDate
  /**
   * Ejercicio ANTERIOR. Sin él, la foto comparativa filtraría por el ejercicio
   * en curso y saldría vacía: el balance se acota por ejercicio, no por fechas.
   */
  fiscalYearId?: string
  label: string
  basis: string
}

export type BalanceParams = ReportPeriod & {
  variant: PgcVariant
  snapshot: BalanceSnapshot
  /** Cuenta mapeada a `RESULTADO_EJERCICIO` (129), para R-B5. */
  resultAccountCode: string
  /** Misma fecha del ejercicio anterior (§8.7). */
  comparative?: BalanceComparative
  /** Cierre del ejercicio anterior: el balance lo lleva SIEMPRE (columnas N/N−1). */
  previousClose?: BalanceComparative
}

export type BalanceSide = "BALANCE_ACTIVO" | "BALANCE_PASIVO" | "BALANCE_PN"

export type BalanceAccountDetail = {
  code: string
  name: string
  saldoCents: Cents
  statement: BalanceSide
  side: BalanceSide
  epigraph: string
  presentedCents: Cents
  isContra: boolean
  isBidirectional: boolean
  /** El resultado inyectado por R-B5 no viene de ninguna línea del diario. */
  synthetic?: boolean
}

export type BidirectionalReclass = {
  code: string
  saldoCents: Cents
  from: string
  to: string
  side: BalanceSide
}

export type BalanceReport = {
  model: PgcVariant
  snapshot: BalanceSnapshot
  activo: StatementRow[]
  patrimonioNeto: StatementRow[]
  pasivo: StatementRow[]
  totalActivoCents: Cents
  totalPatrimonioNetoCents: Cents
  totalPasivoCents: Cents
  totalPasivoYPatrimonioNetoCents: Cents
  /** I2. Cero o el informe no se emite como validado. */
  i2DiffCents: Cents
  /** Cómo se obtuvo el resultado del ejercicio (R-B5 es EXCLUSIVA). */
  resultado: { cents: Cents; source: "INYECTADO_I3" | "LEIDO_129" | "NINGUNO"; saldo129Cents: Cents; i3Cents: Cents }
  reclasificacionesBidireccionales: BidirectionalReclass[]
  /** I-E6-10: contra-cuentas presentadas en positivo. */
  contraSignAnomalies: { code: string; cents: Cents; epigraph: string }[]
  /** I-E6-12: `472`/`477` con saldo de signo contrario al natural (WARN, R-B6). */
  ivaSignAnomalies: { code: string; saldoCents: Cents }[]
  /** `555` con saldo ≠ 0 al cierre: cuenta puente que debería estar a cero. */
  bridgeAccountWarnings: { code: string; saldoCents: Cents }[]
  accountDetail: BalanceAccountDetail[]
  notes: readonly string[]
  comparativeLabel?: string
  previousCloseLabel?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// I3 — resultado del periodo. Definición ÚNICA (skill `fiabilidad`).
// ─────────────────────────────────────────────────────────────────────────────

const PNL_EXCLUDED_KINDS: readonly EntryKind[] = ["REGULARIZATION", "CLOSING", "OPENING"]

/** Cuenta de PyG: grupo 6 o 7. El grupo lo da el primer dígito del código. */
export const isPnlAccount = (code: string): boolean => code.startsWith("6") || code.startsWith("7")

/**
 * I3 = `Σ(haber − debe)` de las líneas 6/7 con
 * `kind ∉ {REGULARIZATION, CLOSING, OPENING}`.
 *
 * **Sin ningún filtro de anulados**: un contra-asiento y su original se
 * neutralizan solos (E3 §4.2). Filtrar por `voidedAt`/`reversesEntryId` daría un
 * resultado distinto del que suma el diario, que es justo lo que ADR-0003
 * prohíbe.
 */
export function computeI3(lines: readonly ReportLine[]): Cents {
  let total = 0
  for (const l of lines) {
    if (!isPnlAccount(l.accountCode)) continue
    if (PNL_EXCLUDED_KINDS.includes(l.entryKind)) continue
    total += l.creditCents - l.debitCents
  }
  return total
}

/** Saldo de una cuenta excluyendo unos `kind`. */
export function balanceOfAccount(
  lines: readonly ReportLine[],
  code: string,
  excluded: readonly EntryKind[]
): Cents {
  let total = 0
  for (const l of lines) {
    if (l.accountCode !== code) continue
    if (excluded.includes(l.entryKind)) continue
    total += l.debitCents - l.creditCents
  }
  return total
}

// ─────────────────────────────────────────────────────────────────────────────
// El balance
// ─────────────────────────────────────────────────────────────────────────────

const BALANCE_SIDES: readonly string[] = ["BALANCE_ACTIVO", "BALANCE_PASIVO", "BALANCE_PN"]

type Sides = { activo: Map<string, EpigraphLeaf[]>; pasivo: Map<string, EpigraphLeaf[]>; pn: Map<string, EpigraphLeaf[]> }

const push = (map: Map<string, EpigraphLeaf[]>, leaf: EpigraphLeaf): void => {
  const list = map.get(leaf.path) ?? []
  list.push(leaf)
  map.set(leaf.path, list)
}

const collapse = (map: Map<string, EpigraphLeaf[]>): EpigraphLeaf[] =>
  [...map.entries()].map(([path, leaves]) => ({
    path,
    cents: leaves.reduce((a, l) => a + l.cents, 0),
    accountCodes: leaves.flatMap((l) => [...l.accountCodes]),
    isContraCell: leaves.every((l) => l.isContraCell === true),
    isComputed: leaves.some((l) => l.isComputed === true),
  }))

const totalOf = (leaves: readonly EpigraphLeaf[]): Cents => leaves.reduce((a, l) => a + l.cents, 0)

/**
 * Balance de situación.
 *
 * Algoritmo (§3.3 del diseño):
 *  1. Excluir los `kind` de la foto y quedarse con TODAS las líneas hasta `to`
 *     —apertura incluida—: el balance es un saldo de stock, no un flujo.
 *  2. Saldo por cuenta (R-B1).
 *  3. Presentación por masa (R-B2): activo `+saldo`, pasivo y PN `−saldo`.
 *  4. Bidireccionales al epígrafe espejo si el saldo es acreedor (R-B4), ANTES
 *     de agregar y **por cuenta postable**, nunca por línea ni por el padre.
 *  5. Resultado del ejercicio por R-B5, que es EXCLUSIVA.
 *  6. Árbol de epígrafes, sin imprimir vacíos.
 *  7. `i2DiffCents` = I2 y las notas al pie.
 */
export function buildBalance(
  lines: readonly ReportLine[],
  accounts: readonly StatementAccount[] | AccountIndex,
  params: BalanceParams,
  ctx?: ProvenanceContext
): BalanceReport {
  const index = "byCode" in accounts ? (accounts as AccountIndex) : buildAccountIndex(accounts as StatementAccount[])
  const excluded = SNAPSHOT_EXCLUDED[params.snapshot]
  // Acotado al EJERCICIO cuando el llamante lo pide: la apertura de 2027 y el
  // cierre de 2026 conviven en el mismo rango de fechas y mezclarlos daría un
  // balance que no es de ningún ejercicio.
  const scoped = lines.filter(
    (l) => l.entryDate <= params.to && (params.fiscalYearId === undefined || l.fiscalYearId === params.fiscalYearId)
  )
  const universe = excludingKinds(scoped, excluded)
  const balances = balancesByAccount(universe)

  const sides: Sides = { activo: new Map(), pasivo: new Map(), pn: new Map() }
  const reclass: BidirectionalReclass[] = []
  const contraSignAnomalies: BalanceReport["contraSignAnomalies"] = []
  const ivaSignAnomalies: BalanceReport["ivaSignAnomalies"] = []
  const bridgeAccountWarnings: BalanceReport["bridgeAccountWarnings"] = []
  const accountDetail: BalanceAccountDetail[] = []

  for (const code of [...balances.keys()].sort()) {
    const saldo = balances.get(code) ?? 0
    const statement = index.statementOf(code)
    if (statement === null || !BALANCE_SIDES.includes(statement)) continue
    // Un saldo a cero NO se presenta. El fixture cierra a cero nueve cuentas a
    // propósito: un motor que las arrastrara imprimiría epígrafes fantasma.
    if (saldo === 0) continue

    // R-B6: `472`/`477` nunca se reclasifican; un signo contrario al natural es
    // un WARN de calidad de datos (I-E6-12), no una situación patrimonial.
    if (code.startsWith("472") && saldo < 0) ivaSignAnomalies.push({ code, saldoCents: saldo })
    if (code.startsWith("477") && saldo > 0) ivaSignAnomalies.push({ code, saldoCents: saldo })
    if (code.startsWith("555")) bridgeAccountWarnings.push({ code, saldoCents: saldo })

    let epigraph = index.epigraphOf(code, params.variant)
    let side = statement as BalanceSide
    // R-B2 — UN SOLO `CASE`, no dos ramas de código.
    let value = side === "BALANCE_ACTIVO" ? saldo : -saldo

    // R-B4 — reclasificación por SIGNO al epígrafe espejo, por cuenta postable.
    const bidirectional = index.isBidirectional(code)
    if (bidirectional && saldo < 0) {
      const mirror = mirrorEpigraphOf(code, params.variant)
      if (mirror) {
        reclass.push({ code, saldoCents: saldo, from: epigraph ?? "", to: mirror, side: "BALANCE_PASIVO" })
        epigraph = mirror
        side = "BALANCE_PASIVO"
        value = -saldo
      }
    }
    if (!epigraph) continue

    const isContra = index.isContra(code)
    // I-E6-10: una contra-cuenta presentada en positivo es anómala.
    if (isContra && value > 0) contraSignAnomalies.push({ code, cents: value, epigraph })

    const target = side === "BALANCE_ACTIVO" ? sides.activo : side === "BALANCE_PASIVO" ? sides.pasivo : sides.pn
    push(target, { path: epigraph, cents: value, accountCodes: [code], isContraCell: isContra })
    accountDetail.push({
      code,
      name: index.nameOf(code),
      saldoCents: saldo,
      statement: statement as BalanceSide,
      side,
      epigraph,
      presentedCents: value,
      isContra,
      isBidirectional: bidirectional,
    })
  }

  // ── R-B5, EXCLUSIVA y decidida por el SALDO de 129 ─────────────────────────
  //
  // `saldo(129) = 0` → el resultado (I3) se INYECTA en PN A-1) VII.
  // `saldo(129) ≠ 0` → se LEE de 129, que ya está en `sides.pn` como una cuenta
  // más. Nunca las dos: sumarlas da `I2 = 1 497 322` el día del cierre y sólo
  // ese día, que es el fallo más caro de detectar porque el informe cuadra los
  // 364 días anteriores.
  //
  // Decide el SALDO, no `FiscalYear.status`: el ejercicio puede seguir `OPEN`
  // con la regularización ya posteada, y al revés no ocurre.
  const saldo129 = balances.get(params.resultAccountCode) ?? 0
  // I3 canónico: SIEMPRE excluyendo REGULARIZATION/CLOSING/OPENING, sea cual sea
  // la foto. Es el que compara I-E6-13 contra el saldo de 129.
  const i3 = computeI3(scoped)
  // Lo que hay que inyectar es el resultado que las cuentas 6/7 **todavía
  // arrastran en esta foto**: `Σ(haber − debe)` sobre el universo de la foto.
  //   · PRE_REGULARIZACION → los 6/7 llevan el resultado entero: = I3.
  //   · POST_REGULARIZACION → la regularización los dejó a cero: = 0, y además
  //     129 tiene saldo, así que se lee de ahí.
  //   · POST_CIERRE → todo a cero: no se inyecta nada, o el balance cerrado
  //     resucitaría un patrimonio que ya no está en los libros.
  const pendingResult = universe.reduce(
    (a, l) => (isPnlAccount(l.accountCode) ? a + l.creditCents - l.debitCents : a),
    0
  )
  let resultado: BalanceReport["resultado"]
  if (saldo129 === 0) {
    if (pendingResult !== 0) {
      const epigraph = index.epigraphOf(params.resultAccountCode, params.variant)
      if (epigraph) {
        push(sides.pn, { path: epigraph, cents: pendingResult, accountCodes: [params.resultAccountCode], isComputed: true })
        accountDetail.push({
          code: params.resultAccountCode,
          name: "Resultado del ejercicio (calculado, I3)",
          saldoCents: -pendingResult,
          statement: "BALANCE_PN",
          side: "BALANCE_PN",
          epigraph,
          presentedCents: pendingResult,
          isContra: false,
          isBidirectional: false,
          synthetic: true,
        })
      }
      resultado = { cents: pendingResult, source: "INYECTADO_I3", saldo129Cents: 0, i3Cents: i3 }
    } else {
      resultado = { cents: 0, source: "NINGUNO", saldo129Cents: 0, i3Cents: 0 }
    }
  } else {
    resultado = { cents: -saldo129, source: "LEIDO_129", saldo129Cents: saldo129, i3Cents: i3 }
  }

  const activoLeaves = collapse(sides.activo)
  const pnLeaves = collapse(sides.pn)
  const pasivoLeaves = collapse(sides.pasivo)

  const totalActivo = totalOf(activoLeaves)
  const totalPn = totalOf(pnLeaves)
  const totalPasivo = totalOf(pasivoLeaves)

  // Comparativo: el mismo cálculo sobre las líneas del periodo comparado. Se
  // recalcula en vez de leerse de otro run porque la foto y la variante pueden
  // ser distintas y una columna comparativa de otro informe sería una mentira
  // con formato de tabla.
  const previousByPath = params.comparative
    ? leavesByPath(
        buildBalance(params.comparative.lines, index, {
          ...params,
          from: params.comparative.from,
          to: params.comparative.to,
          // El ejercicio del COMPARATIVO, no el de la foto actual.
          ...(params.comparative.fiscalYearId
            ? { fiscalYearId: params.comparative.fiscalYearId }
            : { fiscalYearId: undefined }),
          comparative: undefined,
          previousClose: undefined,
        })
      )
    : undefined

  const treeOpts = previousByPath ? { previousByPath } : {}

  const report: BalanceReport = {
    model: params.variant,
    snapshot: params.snapshot,
    activo: buildEpigraphTree(activoLeaves, treeOpts),
    patrimonioNeto: buildEpigraphTree(pnLeaves, treeOpts),
    pasivo: buildEpigraphTree(pasivoLeaves, treeOpts),
    totalActivoCents: totalActivo,
    totalPatrimonioNetoCents: totalPn,
    totalPasivoCents: totalPasivo,
    totalPasivoYPatrimonioNetoCents: totalPn + totalPasivo,
    i2DiffCents: totalActivo - (totalPn + totalPasivo),
    resultado,
    reclasificacionesBidireccionales: reclass.sort((a, b) => (a.code < b.code ? -1 : 1)),
    contraSignAnomalies,
    ivaSignAnomalies,
    bridgeAccountWarnings,
    accountDetail: accountDetail.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
    notes: [NOTA_NO_COMPENSACION],
    ...(params.comparative ? { comparativeLabel: params.comparative.label } : {}),
    ...(params.previousClose ? { previousCloseLabel: params.previousClose.label } : {}),
  }

  if (ctx) attachProvenance(report, params, ctx, excluded)
  return report
}

/** Importes por ruta hoja de un balance ya construido (entrada del comparativo). */
function leavesByPath(report: BalanceReport): Map<string, Cents> {
  const out = new Map<string, Cents>()
  for (const row of [...report.activo, ...report.patrimonioNeto, ...report.pasivo]) {
    if (row.isLeaf) out.set(row.path, row.cents)
  }
  return out
}

/**
 * Provenance por celda. La consulta es **parametrizada** y lleva dentro el
 * ejercicio y los `kind` excluidos de la foto (corrección #10 de E3): sin ellos
 * el drill-down devolvería líneas que no suman esa cifra.
 */
function attachProvenance(
  report: BalanceReport,
  params: BalanceParams,
  ctx: ProvenanceContext,
  excluded: readonly EntryKind[]
): void {
  for (const row of [...report.activo, ...report.patrimonioNeto, ...report.pasivo]) {
    const extra: (string | readonly string[])[] = []
    if (params.fiscalYearId) extra.push(params.fiscalYearId)
    if (row.accountCodes.length > 0) extra.push(row.accountCodes)
    if (excluded.length > 0) extra.push(excluded as readonly string[])
    row.provenance = cellProvenance(
      `balance.${params.snapshot}.${params.variant}.${row.path}`,
      row.cents,
      {
        organizationId: params.organizationId,
        // El balance es un SALDO DE STOCK: la celda la componen TODAS las líneas
        // hasta la fecha de corte, no sólo las del periodo pedido. Con
        // `from = params.from` el drill-down de un balance a 30 de junio se
        // dejaría fuera el primer semestre y no reproduciría la cifra.
        from: BALANCE_DRILLDOWN_FROM,
        to: params.to,
        query: registrosOrigen({
          withFiscalYear: Boolean(params.fiscalYearId),
          withAccounts: row.accountCodes.length > 0,
          withExcludedKinds: excluded.length > 0,
        }),
        extraParams: extra,
      },
      ctx
    )
  }
}

/**
 * `registros_origen` PARAMETRIZADA: el drill-down la ejecuta tal cual dentro de
 * `tenantTransaction`. Nada se interpola — ni los códigos de cuenta, que viajan
 * como array de verdad (`= ANY($n)`), ni los `kind` excluidos de la foto.
 *
 * El orden de los parámetros es el que compone `attachProvenance`:
 * `$1 org, $2 from, $3 to, [$n fiscalYearId], [$n accountCodes], [$n excludedKinds]`.
 */
export function registrosOrigen(opts: {
  withFiscalYear: boolean
  withAccounts: boolean
  withExcludedKinds: boolean
}): string {
  let sql = "SELECT l.id FROM journal_lines l WHERE l.organization_id = $1 AND l.entry_date BETWEEN $2 AND $3"
  let n = 3
  if (opts.withFiscalYear) sql += ` AND l.fiscal_year_id = $${++n}::uuid`
  if (opts.withAccounts) sql += ` AND l.account_code = ANY($${++n}::text[])`
  if (opts.withExcludedKinds) sql += ` AND NOT (l.entry_kind::text = ANY($${++n}::text[]))`
  return sql
}
