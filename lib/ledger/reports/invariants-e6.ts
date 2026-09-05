/**
 * E6 · T12 — Invariantes de los estados financieros: **I2, I3, I6** (los tres
 * que la skill `fiabilidad` reservaba para esta épica) y los diecinueve
 * `I-E6-1…19`.
 *
 * Formulación operativa: `docs/design/E6-validacion-estados.md` §4 y
 * `docs/design/E6-informes.md` §5. **Tolerancia 0 en todos.**
 *
 * Módulo PURO. Los cablea `runInvariants` (`lib/ledger/invariants.ts`) cuando el
 * llamante aporta el bloque de informes, igual que E4 aporta el analítico.
 */

import type { CheckResult } from "@/lib/ledger/invariants-types"
import type { Cents, EntryKind, LocalDate } from "@/lib/ledger/types"
import { buildBalance, computeI3, type BalanceReport } from "@/lib/ledger/reports/balance"
import {
  buildCashflowDirect,
  buildCashflowIndirect,
  indirectBlockOf,
  type CashflowDirectReport,
} from "@/lib/ledger/reports/cashflow"
import { buildPyg, type PygReport } from "@/lib/ledger/reports/pyg"
import type { AgingReport } from "@/lib/ledger/reports/aging"
import type { DashboardReport } from "@/lib/ledger/reports/dashboard"
import {
  buildAccountIndex,
  isCashAccount,
  SNAPSHOT_EXCLUDED,
  type AccountIndex,
  type BalanceSnapshot,
  type PgcVariant,
  type ReportLine,
  type StatementAccount,
} from "@/lib/ledger/reports/types"

const pass = (id: string, evidencia: string): CheckResult => ({ id, status: "PASS", evidencia })
const fail = (id: string, evidencia: string): CheckResult => ({ id, status: "FAIL", evidencia })
const warn = (id: string, evidencia: string): CheckResult => ({ id, status: "WARN", evidencia })
const check = (id: string, ok: boolean, evidencia: string): CheckResult =>
  ok ? pass(id, evidencia) : fail(id, evidencia)

export type ReportsInvariantInput = {
  lines: readonly ReportLine[]
  accounts: readonly StatementAccount[] | AccountIndex
  /** Cuenta mapeada a `RESULTADO_EJERCICIO` (129). Nunca escrita a mano. */
  resultAccountCode: string
  organizationId: string
  from: LocalDate
  to: LocalDate
  baseCurrency: string
  fiscalYearId?: string
  /** Ejercicio siguiente, para I-E6-9 (la apertura reproduce el formulado). */
  nextFiscalYearId?: string
  nextFiscalYearEnd?: LocalDate
  incomeTaxAccountCodes?: readonly string[]
  /** Aging y panel ya calculados: I-E6-14/15/19 los contrastan, no los rehacen. */
  aging?: readonly AgingReport[]
  dashboard?: DashboardReport
  /**
   * A1 / **I-E6-20** — deriva del diario. Lo compone `models/reports.ts`, que es
   * quien puede mirar el `ReportRun` anterior y el `AuditLog`; aquí sólo se
   * formula el check, para que salga en `validacion.json` junto a los demás.
   */
  ledgerDrift?: { previousHash: string; currentHash: string; explainingChanges: number } | null
}

const MODELS: readonly PgcVariant[] = ["GENERAL", "PYMES"]
const SNAPSHOTS: readonly BalanceSnapshot[] = ["PRE_REGULARIZACION", "POST_REGULARIZACION", "POST_CIERRE"]

// ─────────────────────────────────────────────────────────────────────────────
// I2 — Balance cuadrado
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `ACT(K) − PAS(K) − RES(K) = 0`, con la reclasificación de bidireccionales
 * aplicada ANTES de sumar y con `RES` **exclusivo** (R-B5).
 *
 * Nótese que la reclasificación **no altera** I2: mueve el mismo importe de un
 * lado al otro con el signo correcto. I2 no la detecta; la detecta I-E6-5.
 */
export function checkI2(balance: BalanceReport, label: string): CheckResult {
  return check(
    `I2[${label}]`,
    balance.i2DiffCents === 0,
    `Activo ${balance.totalActivoCents} − (PN ${balance.totalPatrimonioNetoCents} + pasivo ` +
      `${balance.totalPasivoCents}) = ${balance.i2DiffCents}`
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// I3 — Resultado del periodo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `I3 = Σ(haber − debe)` de las líneas 6/7 con
 * `kind ∉ {REGULARIZATION, CLOSING, OPENING}` y, **si `saldo(129) ≠ 0`**,
 * `I3 = −saldo(129)`.
 *
 * Con la 129 a cero la segunda igualdad **no se evalúa**: no es un FAIL por
 * `0 ≠ 1 497 322`. El `K` para leer 129 es `{CLOSING}`, no `{}`.
 */
export function checkI3(lines: readonly ReportLine[], resultAccountCode: string): CheckResult {
  const i3 = computeI3(lines)
  const saldo129 = lines
    .filter((l) => l.accountCode === resultAccountCode && l.entryKind !== "CLOSING")
    .reduce((a, l) => a + l.debitCents - l.creditCents, 0)
  if (saldo129 === 0) {
    return pass("I3", `Resultado del periodo ${i3} céntimos; la 129 está a cero (ejercicio sin regularizar)`)
  }
  return check(
    "I3",
    i3 === -saldo129,
    `Resultado del periodo ${i3} céntimos; saldo acreedor de la ${resultAccountCode}: ${-saldo129}`
  )
}

/**
 * I-E6-13 — la regularización no está desfasada. Un FAIL significa **líneas 6/7
 * posteriores a la `REGULARIZATION`**: el balance sería correcto (lee 129) pero
 * INCOMPLETO, porque el resultado de esas líneas no está en ningún sitio.
 *
 * Es un FAIL, no un WARN, y quien lo caza es I3, no I2.
 */
export function checkIE613(lines: readonly ReportLine[], resultAccountCode: string): CheckResult {
  const i3 = computeI3(lines)
  const saldo129 = lines
    .filter((l) => l.accountCode === resultAccountCode && l.entryKind !== "CLOSING")
    .reduce((a, l) => a + l.debitCents - l.creditCents, 0)
  if (saldo129 === 0) {
    return pass("I-E6-13", "La 129 está a cero: la regularización todavía no se ha posteado y no puede desfasarse")
  }
  return check(
    "I-E6-13",
    i3 === -saldo129,
    // Las DOS cifras y su diferencia. Nunca se elige una en silencio.
    `PyG del periodo (I3) = ${i3} · saldo acreedor de la ${resultAccountCode} = ${-saldo129} · ` +
      `diferencia ${i3 - -saldo129}. Si no es 0, hay líneas de 6/7 posteriores a la regularización`
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// I6 — Cashflow
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Ejecución completa
// ─────────────────────────────────────────────────────────────────────────────

/**
 * I2, I3, I6 y los `I-E6-*` que se pueden comprobar en memoria. Los de
 * infraestructura —I-E6-16 (inmutabilidad de `report_runs`), I-E6-17
 * (reproducibilidad byte a byte) e I-E6-18 (caché con el `ledgerHash` vigente)—
 * viven en `models/reports.ts` y en la suite de integración: no se pueden
 * comprobar sin base de datos y fingir aquí que se comprueban sería peor que no
 * tenerlos.
 */
export function runReportInvariants(input: ReportsInvariantInput): CheckResult[] {
  const index = "byCode" in input.accounts ? (input.accounts as AccountIndex) : buildAccountIndex(input.accounts as StatementAccount[])
  const scoped = input.lines.filter(
    (l) => input.fiscalYearId === undefined || l.fiscalYearId === input.fiscalYearId
  )
  const out: CheckResult[] = []

  const period = {
    organizationId: input.organizationId,
    from: input.from,
    to: input.to,
    baseCurrency: input.baseCurrency,
    ...(input.fiscalYearId ? { fiscalYearId: input.fiscalYearId } : {}),
  }

  // ── I2 en las tres fotos × dos modelos, e I-E6-1/2/5/10/11/12 ──────────────
  const balances = new Map<string, BalanceReport>()
  for (const snapshot of SNAPSHOTS) {
    for (const variant of MODELS) {
      const report = buildBalance(input.lines, index, {
        ...period,
        variant,
        snapshot,
        resultAccountCode: input.resultAccountCode,
      })
      balances.set(`${snapshot}|${variant}`, report)
      out.push(checkI2(report, `${snapshot}/${variant === "GENERAL" ? "NORMAL" : "PYMES"}`))
    }
  }

  for (const snapshot of SNAPSHOTS) {
    const normal = balances.get(`${snapshot}|GENERAL`)!
    const pymes = balances.get(`${snapshot}|PYMES`)!
    out.push(
      check(
        `I-E6-1[${snapshot}]`,
        normal.totalActivoCents === pymes.totalActivoCents &&
          normal.totalPasivoYPatrimonioNetoCents === pymes.totalPasivoYPatrimonioNetoCents,
        `NORMAL ${normal.totalActivoCents} vs PYMES ${pymes.totalActivoCents}`
      )
    )
  }

  // I-E6-2: ninguna cuenta con saldo ≠ 0 y `statement ∈ BALANCE_*` queda fuera.
  const pre = balances.get("PRE_REGULARIZACION|GENERAL")!
  const excludedPre = SNAPSHOT_EXCLUDED.PRE_REGULARIZACION
  const balanceSaldos = new Map<string, Cents>()
  for (const l of scoped) {
    if (excludedPre.includes(l.entryKind)) continue
    const statement = index.statementOf(l.accountCode)
    if (statement === null || statement === "PYG" || statement === "ECPN") continue
    balanceSaldos.set(l.accountCode, (balanceSaldos.get(l.accountCode) ?? 0) + l.debitCents - l.creditCents)
  }
  const presented = new Set(pre.accountDetail.filter((a) => !a.synthetic).map((a) => a.code))
  const missing = [...balanceSaldos.entries()].filter(([code, saldo]) => saldo !== 0 && !presented.has(code))
  out.push(
    check(
      "I-E6-2",
      missing.length === 0,
      missing.length === 0
        ? `${presented.size} cuenta(s) de balance con saldo, todas mapeadas a un epígrafe`
        : `sin epígrafe y con saldo: ${missing.map(([c, s]) => `${c} (${s})`).join(", ")}`
    )
  )

  // I-E6-5: una bidireccional nunca aparece en los dos lados de la misma foto.
  const bothSides = pre.accountDetail
    .filter((a) => a.isBidirectional)
    .filter((a, _i, all) => all.filter((b) => b.code === a.code).length > 1)
  out.push(check("I-E6-5", bothSides.length === 0, `${bothSides.length} cuenta(s) bidireccionales en los dos lados`))

  // I-E6-10 e I-E6-12 son WARN de calidad de datos: no impiden emitir, sí marcan
  // el informe como revisable.
  out.push(
    pre.contraSignAnomalies.length === 0
      ? pass("I-E6-10", "ninguna contra-cuenta se presenta en positivo")
      : warn("I-E6-10", `contra-cuentas en positivo: ${pre.contraSignAnomalies.map((a) => a.code).join(", ")}`)
  )
  out.push(
    pre.ivaSignAnomalies.length === 0
      ? pass("I-E6-12", "472/477 con el signo natural o a cero")
      : warn(
          "I-E6-12",
          `IVA con signo contrario al natural: ${pre.ivaSignAnomalies.map((a) => `${a.code} (${a.saldoCents})`).join(", ")} — ` +
            "es un error de datos, no una situación patrimonial (R-B6): NO se reclasifica"
        )
  )
  out.push(
    pre.bridgeAccountWarnings.length === 0
      ? pass("I-E6-W555", "555 (partidas pendientes de aplicación) a cero")
      : warn("I-E6-W555", `555 con saldo al cierre: ${pre.bridgeAccountWarnings.map((a) => a.code).join(", ")}`)
  )

  // I-E6-11: pre y post regularización dan el mismo total y el mismo PN.
  const post = balances.get("POST_REGULARIZACION|GENERAL")!
  out.push(
    check(
      "I-E6-11",
      pre.totalActivoCents === post.totalActivoCents && pre.totalPatrimonioNetoCents === post.totalPatrimonioNetoCents,
      `pre (activo ${pre.totalActivoCents}, PN ${pre.totalPatrimonioNetoCents}) vs ` +
        `post (activo ${post.totalActivoCents}, PN ${post.totalPatrimonioNetoCents})`
    )
  )

  // I-E6-8: tras el CLOSING ninguna cuenta de balance conserva saldo.
  const cierre = balances.get("POST_CIERRE|GENERAL")!
  const hasClosing = scoped.some((l) => l.entryKind === "CLOSING")
  out.push(
    !hasClosing
      ? pass("I-E6-8", "el ejercicio no está cerrado: no procede")
      : check(
          "I-E6-8",
          cierre.accountDetail.length === 0,
          `tras el cierre quedan ${cierre.accountDetail.length} cuenta(s) con saldo`
        )
  )

  // I-E6-9: la apertura del ejercicio siguiente reproduce el formulado, 129 incl.
  if (input.nextFiscalYearId && input.nextFiscalYearEnd) {
    const apertura = buildBalance(input.lines, index, {
      ...period,
      to: input.nextFiscalYearEnd,
      fiscalYearId: input.nextFiscalYearId,
      variant: "GENERAL",
      snapshot: "POST_CIERRE",
      resultAccountCode: input.resultAccountCode,
    })
    const saldosOf = (r: BalanceReport): string =>
      JSON.stringify(Object.fromEntries(r.accountDetail.filter((a) => !a.synthetic).map((a) => [a.code, a.saldoCents])))
    out.push(
      check(
        "I-E6-9",
        saldosOf(apertura) === saldosOf(post),
        `apertura ${saldosOf(apertura).slice(0, 200)} vs formulado ${saldosOf(post).slice(0, 200)}`
      )
    )
  }

  // ── I3, I-E6-3, I-E6-4, I-E6-13 ───────────────────────────────────────────
  out.push(checkI3(scoped, input.resultAccountCode))
  out.push(checkIE613(scoped, input.resultAccountCode))

  const pygs = new Map<PgcVariant, PygReport>()
  for (const variant of MODELS) {
    pygs.set(variant, buildPyg(input.lines, index, { ...period, variant }))
  }
  const i3 = computeI3(scoped)
  for (const variant of MODELS) {
    const p = pygs.get(variant)!
    const s = p.subtotalsCents
    const label = variant === "GENERAL" ? "NORMAL" : "PYMES"
    out.push(
      check(
        `I-E6-4[${label}]`,
        s["A.4) RESULTADO DEL EJERCICIO"] === i3 &&
          s["A.1) RESULTADO DE EXPLOTACION"] + s["A.2) RESULTADO FINANCIERO"] === s["A.3) RESULTADO ANTES DE IMPUESTOS"],
        `A.4 ${s["A.4) RESULTADO DEL EJERCICIO"]} vs I3 ${i3} · A.1 ${s["A.1) RESULTADO DE EXPLOTACION"]} + A.2 ` +
          `${s["A.2) RESULTADO FINANCIERO"]} vs A.3 ${s["A.3) RESULTADO ANTES DE IMPUESTOS"]}`
      )
    )
  }
  // I-E6-3: A.3 tiene que ser el MISMO en los dos modelos. Que exista aparte de
  // I-E6-4 es deliberado: un motor que metiera `630` en «otros gastos de
  // explotación» acertaría A.4 y fallaría A.1/A.3.
  const a3Normal = pygs.get("GENERAL")!.subtotalsCents["A.3) RESULTADO ANTES DE IMPUESTOS"]
  const a3Pymes = pygs.get("PYMES")!.subtotalsCents["A.3) RESULTADO ANTES DE IMPUESTOS"]
  out.push(check("I-E6-3", a3Normal === a3Pymes, `A.3 NORMAL ${a3Normal} vs PYMES ${a3Pymes}`))

  // ── I6 y la exhaustividad de la partición ─────────────────────────────────
  const direct = buildCashflowDirect(input.lines, index, {
    ...period,
    ...(input.incomeTaxAccountCodes ? { incomeTaxAccountCodes: input.incomeTaxAccountCodes } : {}),
  })
  const indirect = buildCashflowIndirect(input.lines, period)
  out.push(
    check(
      "I6[directo]",
      direct.checkI6DirectCents === 0,
      `inicial ${direct.openingCashCents} + flujos ${direct.totalFlowsCents} − final ${direct.closingCashCents} = ${direct.checkI6DirectCents}`
    ),
    check(
      "I6[indirecto]",
      indirect.checkI6IndirectCents === 0,
      `Σ bloques ${indirect.totalCents} − Δ57x ${indirect.deltaCashCents} = ${indirect.checkI6IndirectCents}`
    ),
    check(
      "I6[coherencia]",
      direct.totalFlowsCents === indirect.totalCents,
      `directo ${direct.totalFlowsCents} vs indirecto ${indirect.totalCents}`
    ),
    check(
      "I-E6-6",
      lastRunningOf(direct) === direct.closingCashCents,
      `acumulado del último mes ${lastRunningOf(direct)} vs saldo final ${direct.closingCashCents}`
    ),
    check(
      "I-E6-7",
      indirect.blockCents.RESULTADO === i3,
      `bloque RESULTADO del indirecto ${indirect.blockCents.RESULTADO} vs I3 ${i3}`
    )
  )
  const sinBloque = [...new Set(scoped.map((l) => l.accountCode))].filter(
    (code) => !isCashAccount(code) && indirectBlockOf(code) === null
  )
  out.push(
    check(
      "I-E6-PARTICION",
      sinBloque.length === 0,
      sinBloque.length === 0
        ? "toda cuenta no-57x con movimiento cae en exactamente un bloque del indirecto"
        : `sin bloque: ${sinBloque.join(", ")} — romperían I6 en silencio`
    )
  )
  if (direct.ambiguousVatEntries.length > 0) {
    out.push(
      warn(
        "I-E6-W-IVA",
        `IVA con varios bloques comerciales en el mismo asiento (R-CF-7 no se puede aplicar): ${direct.ambiguousVatEntries.join(", ")}`
      )
    )
  }
  if (direct.unbucketedAccounts.length > 0) {
    out.push(
      warn(
        "I-E6-W-BUCKET",
        `cuentas con flujo y sin bucket de cashflow (R-18′): ${direct.unbucketedAccounts.map((a) => a.code).join(", ")}`
      )
    )
  }

  // ── O-4/O-13: inmovilizado contra `40x`/`41x`. WARN hasta que E8 traiga
  //    `AccountKey.PROVEEDORES_INMOVILIZADO → 523`. No se corrige en E6.
  const byEntry = new Map<string, ReportLine[]>()
  for (const l of scoped) {
    const list = byEntry.get(l.entryId) ?? []
    list.push(l)
    byEntry.set(l.entryId, list)
  }
  const o4 = [...byEntry.entries()]
    .filter(
      ([, ls]) =>
        ls.some((l) => l.accountCode.startsWith("2")) &&
        ls.some((l) => l.accountCode.startsWith("40") || l.accountCode.startsWith("41"))
    )
    .map(([id]) => id)
  if (o4.length > 0) {
    out.push(
      warn(
        "I-E6-W-O4",
        `asiento(s) con línea de grupo 2 y contrapartida 40x/41x: ${o4.join(", ")}. ` +
          "El modelo oficial quiere esa deuda en 523 (proveedores de inmovilizado); se corrige en E8"
      )
    )
  }

  // ── I-E6-14 / I-E6-15: aging ──────────────────────────────────────────────
  for (const [i, ag] of (input.aging ?? []).entries()) {
    out.push(
      check(
        `I-E6-14[${i}]`,
        ag.checkTotalCents === 0,
        `Σ tramos − saldo a ${ag.refDate} = ${ag.checkTotalCents}`
      )
    )
    if (ag.linesWithoutDueDate > 0) {
      out.push(
        warn(
          `I-E6-W-VENC[${i}]`,
          `${ag.linesWithoutDueDate} línea(s) sin fecha de vencimiento: van al tramo «Sin vencimiento», visible`
        )
      )
    }
  }

  // ── I-E6-19: el panel dice lo MISMO que los informes ──────────────────────
  if (input.dashboard) {
    const kpi = (key: string): Cents | undefined => input.dashboard!.kpis.find((k) => k.key === key)?.cents
    const pygNormal = pygs.get("GENERAL")!
    const problems: string[] = []
    if (kpi("ingresos") !== (pygNormal.byEpigraphNumberCents["1"] ?? 0)) {
      problems.push(`ingresos ${kpi("ingresos")} vs INCN de la PyG ${pygNormal.byEpigraphNumberCents["1"] ?? 0}`)
    }
    if (kpi("resultado") !== i3) problems.push(`resultado ${kpi("resultado")} vs I3 ${i3}`)
    if (kpi("tesoreria") !== direct.closingCashCents) {
      problems.push(`tesorería ${kpi("tesoreria")} vs saldo 57x ${direct.closingCashCents}`)
    }
    if (kpi("ebitda") !== pygNormal.ebitdaCents) {
      problems.push(`EBITDA ${kpi("ebitda")} vs A.1 revirtiendo 8 y 11 ${pygNormal.ebitdaCents}`)
    }
    out.push(
      check(
        "I-E6-19",
        problems.length === 0,
        problems.length === 0 ? "el panel reproduce las cifras de los informes" : problems.join(" · ")
      )
    )
  }

  // ── I-E6-20 (auditor A1): el diario no se mueve solo ──────────────────────
  //
  // La manipulación que pasa TODOS los demás invariantes es la «coherente»:
  // cambiar un `account_code` por SQL y recalcular el `entry_hash` para que
  // I-E3-7 no chille. Los importes siguen cuadrando, I1 pasa, el balance sigue
  // sumando cero… y presenta otra cosa. Lo único que la delata es que el
  // `ledgerHash` del periodo cambie sin que haya un asiento posteado, anulado o
  // reclasificado que lo justifique.
  if (input.ledgerDrift !== undefined) {
    const drift = input.ledgerDrift
    out.push(
      check(
        "I-E6-20",
        drift === null || drift.explainingChanges > 0,
        drift === null
          ? "El diario del periodo no ha cambiado desde el informe anterior"
          : `El ledgerHash del periodo pasó de sha256:${drift.previousHash.slice(0, 12)}… a ` +
            `sha256:${drift.currentHash.slice(0, 12)}… con ${drift.explainingChanges} cambio(s) registrados ` +
            "en el diario. Con 0, alguien ha escrito en `journal_lines` fuera de la aplicación"
      )
    )
  }

  return out
}

function lastRunningOf(direct: CashflowDirectReport): Cents {
  const months = Object.keys(direct.monthlyRunningCashCents).sort()
  return months.length > 0 ? direct.monthlyRunningCashCents[months[months.length - 1]] : direct.openingCashCents
}

export type { EntryKind }
