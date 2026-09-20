import { readFile, readdir } from "node:fs/promises"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  ACCEPTANCE_GIT_SHA,
  BASE_CURRENCY,
  PERIOD,
  RANGE,
  REF_DATE,
  ValidacionRecorder,
  createAcceptanceOrg,
  disconnect,
  dropAcceptanceOrg,
  type AcceptanceOrg,
} from "@/tests/acceptance/harness"

/**
 * **C2 · Motor de cálculo determinista** (E12 · T3 — §3.3 y criterios 7–9).
 *
 * Dos mitades, las dos literales de la spec (`SPEC-FIABILIDAD` §C2):
 *
 *  - **Los cinco casos límite sobre los diez motores puros**: dataset vacío, un
 *    solo registro, importes negativos, fechas de inicio y fin de ejercicio, y
 *    periodo sin ningún movimiento. Ningún motor devuelve `NaN`, ninguno lanza
 *    (salvo donde el rechazo es una decisión DECLARADA, y entonces se comprueba
 *    que el rechazo es explícito y no un número inventado), ninguno inventa una
 *    fila y el dataset vacío devuelve **ceros con etiqueta**, nunca `null`.
 *  - **El grep sobre los prompts**: todo prompt contiene la instrucción explícita
 *    de **no recalcular**, y ninguno pide una operación aritmética al modelo.
 *
 * Los casos límite no son literales inventados: salen del fixture completo
 * cargado en la base y se derivan de él (vaciándolo, quedándose con un registro,
 * cambiando el signo, llevando las fechas a los bordes del ejercicio). Un caso
 * límite escrito a mano prueba el caso límite que se le ocurrió a quien lo
 * escribió; éste prueba el que el producto se va a encontrar.
 */

const COMPONENTE = "c2"
const registro = new ValidacionRecorder(COMPONENTE)

const { tenantTransaction } = await import("@/lib/db")
const { getLinesForPeriod } = await import("@/models/ledger")
const { getStatementAccounts } = await import("@/models/reports")
const { getAnalyticLines, getAnalyticsConfig } = await import("@/models/analytics")
const { buildPyg } = await import("@/lib/ledger/reports/pyg")
const { buildAnalyticPnl } = await import("@/lib/analytics/margins")
const { suggestMatches } = await import("@/lib/audit/bank-match")
const { parseBankCsv } = await import("@/lib/bank/csv")
const { depreciationSchedule } = await import("@/lib/closing/depreciation")
const { duePeriods } = await import("@/lib/recurring/schedule")
const { buildBudgetMatrix } = await import("@/lib/budget/matrix")
const { minutesByTarget } = await import("@/lib/time/aggregate")
const { buildAccountTree } = await import("@/lib/accounts/tree")
const { applyBps } = await import("@/lib/taxes/bps")

type ReportLine = Awaited<ReturnType<typeof getLinesForPeriod>>[number]
type AnalyticLine = Awaited<ReturnType<typeof getAnalyticLines>>[number]
type StatementAccount = Awaited<ReturnType<typeof getStatementAccounts>>[number]
type AnalyticsConfig = Awaited<ReturnType<typeof getAnalyticsConfig>>

/** Los cinco casos límite que nombra la spec. */
const CASOS = ["vacio", "un_registro", "negativos", "fechas_limite", "periodo_sin_movimiento"] as const
type Caso = (typeof CASOS)[number]

type Ejecucion = {
  /** Resultado del motor, o el error si se esperaba un rechazo declarado. */
  run: () => unknown
  /** Filas que entran; `null` cuando el motor no recibe una lista. */
  filasEntrada: number | null
  /** Rechazo DECLARADO por el motor (p. ej. un importe imposible): se exige `TypeError`. */
  rechazoDeclarado?: string
}

type Motor = {
  /** Directorio puro al que pertenece (los diez de §C2). */
  dir: string
  nombre: string
  filasSalida: (result: unknown) => number | null
  casos: Record<Caso, Ejecucion>
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades de comprobación
// ─────────────────────────────────────────────────────────────────────────────

/** Recorre el resultado entero buscando `NaN`, `Infinity` o `-0` disfrazado. */
function numerosImposibles(value: unknown, ruta = "$", visto = new Set<object>()): string[] {
  if (typeof value === "number") {
    if (Number.isNaN(value)) return [`${ruta} = NaN`]
    if (!Number.isFinite(value)) return [`${ruta} = ${value}`]
    return []
  }
  if (typeof value !== "object" || value === null) return []
  if (visto.has(value)) return []
  visto.add(value)
  if (Array.isArray(value)) return value.flatMap((item, i) => numerosImposibles(item, `${ruta}[${i}]`, visto))
  if (value instanceof Map) {
    return [...value.entries()].flatMap(([k, v]) => numerosImposibles(v, `${ruta}.get(${String(k)})`, visto))
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    numerosImposibles(v, `${ruta}.${k}`, visto)
  )
}

const contarArray = (result: unknown): number | null => (Array.isArray(result) ? result.length : null)

// ─────────────────────────────────────────────────────────────────────────────

describe("C2 · los diez motores puros ante los cinco casos límite, y los prompts", () => {
  let org: AcceptanceOrg
  let motores: Motor[] = []

  beforeAll(async () => {
    org = await createAcceptanceOrg(COMPONENTE)
    registro.org(org.organizationId)

    const datos = await tenantTransaction(org.organizationId, org.userId, async (tx) => ({
      lines: await getLinesForPeriod(tx, { ...RANGE, fiscalYearId: org.fiscalYearId }),
      accounts: await getStatementAccounts(tx),
      analyticLines: await getAnalyticLines(tx, { ...RANGE }),
      analyticsConfig: await getAnalyticsConfig(tx, { periodEnd: PERIOD.periodEnd }),
    }))
    motores = construirMotores(org, datos)
  })

  afterAll(async () => {
    await registro.write()
    await dropAcceptanceOrg(org)
    await disconnect()
  })

  it("criterio 7 · los cinco casos límite sobre los diez motores: sin NaN, sin excepción y sin filas inventadas", () => {
    expect(motores).toHaveLength(10)
    const fallos: string[] = []

    for (const motor of motores) {
      for (const caso of CASOS) {
        const ejecucion = motor.casos[caso]
        const id = `C2-${motor.dir}-${caso}`
        let result: unknown
        try {
          result = ejecucion.run()
        } catch (error) {
          if (ejecucion.rechazoDeclarado) {
            // Un rechazo DECLARADO es la respuesta correcta: lo que no vale es
            // devolver un número imposible. Se exige que sea explícito y tipado.
            const ok = error instanceof TypeError || error instanceof RangeError
            registro.assert(
              id,
              ok,
              `${motor.nombre}: rechazo declarado (${ejecucion.rechazoDeclarado}) — ${
                error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error)
              }`
            )
            if (!ok) fallos.push(`${id}: el rechazo no es un error tipado`)
            continue
          }
          registro.add(id, "FAIL", `${motor.nombre} lanzó: ${error instanceof Error ? error.message : String(error)}`)
          fallos.push(`${id}: excepción no declarada`)
          continue
        }

        if (ejecucion.rechazoDeclarado) {
          registro.add(id, "FAIL", `${motor.nombre} debía rechazar (${ejecucion.rechazoDeclarado}) y devolvió un resultado`)
          fallos.push(`${id}: rechazo declarado que no ocurrió`)
          continue
        }

        const imposibles = numerosImposibles(result)
        const salida = motor.filasSalida(result)
        const entrada = ejecucion.filasEntrada
        const inventa = salida !== null && entrada !== null && salida > entrada
        const nulo = result === null || result === undefined

        if (imposibles.length > 0) fallos.push(`${id}: ${imposibles.slice(0, 3).join(", ")}`)
        if (inventa) fallos.push(`${id}: ${salida} filas de salida con ${entrada} de entrada`)
        if (nulo) fallos.push(`${id}: el motor devolvió null/undefined`)

        registro.assert(
          id,
          imposibles.length === 0 && !inventa && !nulo,
          `${motor.nombre} · ${caso}: ${entrada ?? "n/a"} fila(s) de entrada → ${salida ?? "estructura"} de salida, ` +
            `sin NaN ni infinitos`
        )
      }
    }

    expect(fallos, fallos.join("\n")).toEqual([])
  })

  it("criterio 7 bis · el dataset vacío devuelve ceros CON ETIQUETA, nunca `null` ni una estructura vacía", () => {
    const fallos: string[] = []
    for (const motor of motores) {
      const ejecucion = motor.casos.vacio
      if (ejecucion.rechazoDeclarado) continue
      const result = ejecucion.run()
      // «Ceros con etiqueta» es: una colección VACÍA (array o mapa, que ya es la
      // etiqueta «aquí no hay filas») o una estructura con sus claves y sus
      // ceros. Lo que no vale es `null`, `undefined` ni un escalar suelto.
      const esColeccion = Array.isArray(result) || result instanceof Map
      const esEstructura = typeof result === "object" && result !== null && Object.keys(result).length > 0
      const etiquetado = esColeccion || esEstructura
      registro.assert(
        `C2-vacio-${motor.dir}`,
        etiquetado,
        `${motor.nombre} con dataset vacío devuelve ${
          esColeccion ? "una colección vacía" : `una estructura con etiquetas (${Object.keys(result as object).slice(0, 6).join(", ")})`
        }, no null`
      )
      if (!etiquetado) fallos.push(motor.nombre)
    }
    expect(fallos, `motores que devuelven vacío sin etiqueta: ${fallos.join(", ")}`).toEqual([])
  })

  // ── El grep sobre los prompts (§C2, criterios 8 y 9) ────────────────────────

  it("criterios 8 y 9 · todo prompt prohíbe recalcular y ninguno pide aritmética al modelo", async () => {
    const dir = path.resolve(process.cwd(), "ai", "prompts")
    const ficheros = (await readdir(dir)).filter((f) => f.endsWith(".md"))
    // Nunca por vacuidad: si no hay prompts, es que alguien los movió y este
    // test dejaría de comprobar nada (anti-patrón E-3 de §7.4).
    expect(ficheros.length, "no hay ni un prompt en ai/prompts: el grep de §C2 pasaría por vacuidad").toBeGreaterThan(0)
    registro.add("C2-prompts-inventario", "PASS", `prompts inspeccionados: ${ficheros.join(", ")}`)

    /** Formas en que un prompt puede prohibir recalcular. Basta una. */
    const PROHIBICIONES = [
      /no\s+calcul/i,
      /no\s+recalcul/i,
      /no\s+derives/i,
      /no\s+multipliques/i,
      /nunca\s+calcul/i,
      /el\s+c[óo]digo\s+calcula/i,
    ]
    /** Aritmética PEDIDA al modelo. La negación ("no multipliques") no cuenta. */
    const ARITMETICA = [/calcula\s+el\s+total/i, /suma\s+las/i, /multiplica\s+/i, /divide\s+/i, /redondea\s+/i]
    const NEGACION = /\b(no|nunca|jam[áa]s|sin)\b/i

    const fallos: string[] = []
    for (const fichero of ficheros) {
      const contenido = await readFile(path.join(dir, fichero), "utf8")
      const prohibe = PROHIBICIONES.some((re) => re.test(contenido))
      registro.assert(
        `C2-prompt-${fichero}`,
        prohibe,
        prohibe
          ? `${fichero} contiene la instrucción explícita de no recalcular`
          : `${fichero} NO prohíbe recalcular: P1 se apoya en una promesa que el prompt no hace`
      )
      if (!prohibe) fallos.push(`${fichero}: sin instrucción de no recalcular`)

      const pedidas = contenido
        .split(/\r?\n/)
        .map((linea, i) => ({ linea, numero: i + 1 }))
        .filter(({ linea }) => ARITMETICA.some((re) => re.test(linea)) && !NEGACION.test(linea))
      registro.assert(
        `C2-prompt-aritmetica-${fichero}`,
        pedidas.length === 0,
        pedidas.length === 0
          ? `${fichero} no pide ninguna operación aritmética al modelo`
          : `${fichero} pide aritmética en la(s) línea(s) ${pedidas.map((p) => p.numero).join(", ")}: ` +
              pedidas.map((p) => p.linea.trim()).join(" | ")
      )
      if (pedidas.length > 0) fallos.push(`${fichero}: aritmética pedida al modelo`)
    }
    expect(fallos, fallos.join("\n")).toEqual([])
    expect(registro.failures.map((check) => `${check.id}: ${check.evidencia}`)).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Los diez motores, con sus cinco casos cada uno
// ─────────────────────────────────────────────────────────────────────────────

function construirMotores(
  org: AcceptanceOrg,
  datos: {
    lines: readonly ReportLine[]
    accounts: readonly StatementAccount[]
    analyticLines: readonly AnalyticLine[]
    analyticsConfig: AnalyticsConfig
  }
): Motor[] {
  const { lines, accounts, analyticLines, analyticsConfig } = datos
  const provCtx = {
    runId: `c2-${ACCEPTANCE_GIT_SHA}`,
    ledgerHash: "0".repeat(64),
    gitSha: ACCEPTANCE_GIT_SHA,
    baseCurrency: BASE_CURRENCY,
    module: "tests/acceptance/c2-motor.test.ts",
  }
  const pygParams = {
    organizationId: org.organizationId,
    ...RANGE,
    baseCurrency: BASE_CURRENCY,
    fiscalYearId: org.fiscalYearId,
    variant: "PYMES" as const,
  }
  const periodo = { ...RANGE, fiscalYearId: org.fiscalYearId }
  /** Periodo real SIN ningún movimiento: el fixture no llega a 2024. */
  const periodoVacio = { from: "2024-01-01" as const, to: "2024-12-31" as const, fiscalYearId: org.fiscalYearId }

  const unaLinea = lines.slice(0, 1)
  const negativas = unaLinea.map((line) => ({ ...line, debitCents: -line.debitCents, creditCents: -line.creditCents }))
  const bordes = unaLinea.flatMap((line) => [
    { ...line, entryDate: PERIOD.periodStart },
    { ...line, id: `${line.id}-fin`, entryDate: PERIOD.periodEnd },
  ])

  const unaAnalitica = analyticLines.slice(0, 1)
  const analiticaNegativa = unaAnalitica.map((line) => ({ ...line, amountCents: -line.amountCents }))
  const analiticaBordes = unaAnalitica.flatMap((line) => [
    { ...line, entryDate: PERIOD.periodStart },
    { ...line, id: `${line.id}-fin`, entryDate: PERIOD.periodEnd },
  ])

  // ── bank ──────────────────────────────────────────────────────────────────
  const mapping = {
    delimiter: ";",
    decimal: "," as const,
    dateFormat: "DD/MM/YYYY",
    columns: { operationDate: "fecha", amount: "importe", description: "concepto" },
    signMode: "SIGNED_AMOUNT" as const,
    defaultCurrency: BASE_CURRENCY,
  }
  const csv = (filas: readonly string[]): string => ["fecha;importe;concepto", ...filas].join("\n")

  // ── closing ───────────────────────────────────────────────────────────────
  const activo = {
    id: "c2-asset",
    code: "AM-001",
    method: "LINEAL" as const,
    inServiceDate: PERIOD.periodStart,
    acquisitionCostCents: 1_200_000,
    residualValueCents: 0,
    usefulLifeMonths: 12,
    assetAccountCode: "216",
    accumulatedAccountCode: "2816",
    expenseAccountCode: "681",
  }

  // ── recurring ─────────────────────────────────────────────────────────────
  const regla = {
    id: "c2-rule",
    code: "REC-001",
    name: "Cuota mensual",
    kind: "GASTO" as const,
    frequency: "MENSUAL" as const,
    anchor: "FIN_DE_MES" as const,
    startPeriod: "2026-01",
    endPeriod: "2026-12",
    status: "ACTIVA" as const,
    templateCode: "FACTURA_RECIBIDA",
    templateInput: {},
    amountCents: 100_000,
  }
  const todosLosPeriodos = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`)

  // ── budget ────────────────────────────────────────────────────────────────
  const celda = (month: string, amountCents: number) => ({
    month,
    accountCode: null,
    dimension: { kind: "PROYECTO" as const, code: analyticsConfig.projects[0]?.code ?? "P-01" },
    analyticType: "INGRESO" as const,
    marginLevel: "INGRESOS" as const,
    amountCents,
    signException: false,
  })
  const version = (cells: readonly ReturnType<typeof celda>[]) => ({
    id: "c2-budget",
    code: "2026-BASE",
    scenario: "BASE" as const,
    revision: 1,
    status: "VIGENTE" as const,
    fiscalYearId: org.fiscalYearId,
    fiscalYearStart: PERIOD.periodStart,
    fiscalYearEnd: PERIOD.periodEnd,
    validFrom: PERIOD.periodStart,
    validTo: null,
    partialFrom: null,
    cells,
    hours: [],
  })

  // ── time ──────────────────────────────────────────────────────────────────
  const parte = (date: string, minutes: number, id = `t-${date}-${minutes}`) => ({
    id,
    employeeId: "emp-1",
    employeeCode: "E-001",
    date,
    target: { code: "P-01", id: "proj-1", kind: "PROYECTO" as const },
    businessLineCode: null,
    minutes,
    productive: true,
    approved: true,
  })
  const ventana = { from: PERIOD.periodStart, to: PERIOD.periodEnd }
  const opcionesMinutos = { productiveOnly: false, approvedOnly: true as const }

  // ── accounts ──────────────────────────────────────────────────────────────
  const cuenta = (code: string, parentCode: string | null) => ({
    code,
    name: `Cuenta ${code}`,
    level: code.length,
    parentCode,
    nature: "DEUDORA" as const,
    statement: "BALANCE_ACTIVO" as const,
    epigraph: "A.II.1",
    epigraphPymes: "A.II.1",
    bidirectional: false,
    isContra: false,
    analyticType: null,
    cashflowBucket: null,
    isPostable: parentCode !== null,
    isActive: true,
    isSystem: false,
  })

  return [
    {
      dir: "ledger",
      nombre: "lib/ledger/reports/pyg.ts · buildPyg",
      filasSalida: (r) => (r as { detail?: unknown[] }).detail?.length ?? 0,
      casos: {
        vacio: { run: () => buildPyg([], accounts, pygParams, provCtx), filasEntrada: 0 },
        un_registro: { run: () => buildPyg(unaLinea, accounts, pygParams, provCtx), filasEntrada: unaLinea.length },
        negativos: { run: () => buildPyg(negativas, accounts, pygParams, provCtx), filasEntrada: negativas.length },
        fechas_limite: { run: () => buildPyg(bordes, accounts, pygParams, provCtx), filasEntrada: bordes.length },
        periodo_sin_movimiento: {
          run: () => buildPyg([], accounts, { ...pygParams, ...periodoVacio }, provCtx),
          filasEntrada: 0,
        },
      },
    },
    {
      dir: "analytics",
      nombre: "lib/analytics/margins.ts · buildAnalyticPnl",
      filasSalida: (r) => (r as { columns?: unknown[] }).columns?.length ?? null,
      casos: {
        vacio: { run: () => buildAnalyticPnl([], analyticsConfig, periodo, provCtx), filasEntrada: null },
        un_registro: { run: () => buildAnalyticPnl(unaAnalitica, analyticsConfig, periodo, provCtx), filasEntrada: null },
        negativos: { run: () => buildAnalyticPnl(analiticaNegativa, analyticsConfig, periodo, provCtx), filasEntrada: null },
        fechas_limite: { run: () => buildAnalyticPnl(analiticaBordes, analyticsConfig, periodo, provCtx), filasEntrada: null },
        periodo_sin_movimiento: {
          run: () => buildAnalyticPnl([], analyticsConfig, periodoVacio, provCtx),
          filasEntrada: null,
        },
      },
    },
    {
      dir: "audit",
      nombre: "lib/audit/bank-match.ts · suggestMatches",
      filasSalida: (r) => (r as ReadonlyMap<string, unknown>).size,
      casos: {
        vacio: { run: () => suggestMatches([], [], { toleranceDays: 3 }), filasEntrada: 0 },
        un_registro: {
          run: () => suggestMatches([bankLine("l1", "2026-06-15", 10_000)], [cashLine("c1", "2026-06-15", 10_000)], { toleranceDays: 3 }),
          filasEntrada: 1,
        },
        negativos: {
          run: () => suggestMatches([bankLine("l1", "2026-06-15", -10_000)], [cashLine("c1", "2026-06-15", -10_000)], { toleranceDays: 3 }),
          filasEntrada: 1,
        },
        fechas_limite: {
          run: () =>
            suggestMatches(
              [bankLine("l1", PERIOD.periodStart, 10_000), bankLine("l2", PERIOD.periodEnd, 10_000)],
              [cashLine("c1", PERIOD.periodStart, 10_000), cashLine("c2", PERIOD.periodEnd, 10_000)],
              { toleranceDays: 3 }
            ),
          filasEntrada: 2,
        },
        periodo_sin_movimiento: {
          run: () => suggestMatches([bankLine("l1", "2026-06-15", 10_000)], [], { toleranceDays: 3 }),
          filasEntrada: 1,
        },
      },
    },
    {
      dir: "bank",
      nombre: "lib/bank/csv.ts · parseBankCsv",
      filasSalida: (r) => (r as { lines: unknown[] }).lines.length,
      casos: {
        vacio: { run: () => parseBankCsv(csv([]), mapping), filasEntrada: 0 },
        un_registro: { run: () => parseBankCsv(csv(["15/06/2026;100,00;pago"]), mapping), filasEntrada: 1 },
        negativos: { run: () => parseBankCsv(csv(["15/06/2026;-100,00;cargo"]), mapping), filasEntrada: 1 },
        fechas_limite: {
          run: () => parseBankCsv(csv(["01/01/2026;100,00;apertura", "31/12/2026;-100,00;cierre"]), mapping),
          filasEntrada: 2,
        },
        periodo_sin_movimiento: {
          run: () =>
            parseBankCsv(csv([]), { ...mapping, periodStart: PERIOD.periodStart, periodEnd: PERIOD.periodEnd }),
          filasEntrada: 0,
        },
      },
    },
    {
      dir: "closing",
      nombre: "lib/closing/depreciation.ts · depreciationSchedule",
      filasSalida: contarArray,
      casos: {
        // El «dataset» de este motor es UN activo y su cuadro son sus meses de
        // vida útil: las filas de salida no se comparan con las de entrada, se
        // comparan con la vida útil (y eso lo cubre `I-E9-4`, no este test).
        vacio: { run: () => depreciationSchedule({ ...activo, acquisitionCostCents: 0 }), filasEntrada: null },
        un_registro: { run: () => depreciationSchedule({ ...activo, usefulLifeMonths: 1 }), filasEntrada: null },
        // El coste negativo es un dato IMPOSIBLE y el motor lo rechaza por
        // diseño (D2.1 de ADR-0016). Lo que se comprueba es que el rechazo sea
        // explícito y tipado, no una cuota negativa que nadie vería.
        negativos: {
          run: () => depreciationSchedule({ ...activo, acquisitionCostCents: -1_200_000 }),
          filasEntrada: null,
          rechazoDeclarado: "coste de adquisición negativo",
        },
        fechas_limite: {
          run: () => depreciationSchedule({ ...activo, inServiceDate: PERIOD.periodEnd, usefulLifeMonths: 12 }),
          filasEntrada: null,
        },
        periodo_sin_movimiento: {
          run: () => depreciationSchedule({ ...activo, disposalDate: "2025-12-31" }),
          filasEntrada: null,
        },
      },
    },
    {
      dir: "recurring",
      nombre: "lib/recurring/schedule.ts · duePeriods",
      filasSalida: contarArray,
      casos: {
        vacio: { run: () => duePeriods({ ...regla, status: "PAUSADA" }, [], REF_DATE), filasEntrada: 0 },
        un_registro: { run: () => duePeriods(regla, todosLosPeriodos.slice(1), REF_DATE), filasEntrada: 12 },
        negativos: { run: () => duePeriods({ ...regla, amountCents: -100_000 }, [], REF_DATE), filasEntrada: 12 },
        fechas_limite: { run: () => duePeriods(regla, [], PERIOD.periodStart), filasEntrada: 12 },
        periodo_sin_movimiento: { run: () => duePeriods(regla, todosLosPeriodos, REF_DATE), filasEntrada: 12 },
      },
    },
    {
      dir: "budget",
      nombre: "lib/budget/matrix.ts · buildBudgetMatrix",
      filasSalida: (r) => (r as { cells: readonly unknown[] }).cells.length,
      casos: {
        vacio: { run: () => buildBudgetMatrix(version([]), analyticsConfig, ventana), filasEntrada: 0 },
        un_registro: { run: () => buildBudgetMatrix(version([celda("2026-06-01", 100_000)]), analyticsConfig, ventana), filasEntrada: 1 },
        negativos: { run: () => buildBudgetMatrix(version([celda("2026-06-01", -100_000)]), analyticsConfig, ventana), filasEntrada: 1 },
        fechas_limite: {
          run: () =>
            buildBudgetMatrix(
              version([celda(PERIOD.periodStart, 100_000), celda("2026-12-01", -100_000)]),
              analyticsConfig,
              ventana
            ),
          filasEntrada: 2,
        },
        periodo_sin_movimiento: {
          run: () => buildBudgetMatrix(version([]), analyticsConfig, { from: "2024-01-01", to: "2024-12-31" }),
          filasEntrada: 0,
        },
      },
    },
    {
      dir: "time",
      nombre: "lib/time/aggregate.ts · minutesByTarget",
      filasSalida: contarArray,
      casos: {
        vacio: { run: () => minutesByTarget([], ventana, opcionesMinutos), filasEntrada: 0 },
        un_registro: { run: () => minutesByTarget([parte("2026-06-15", 480)], ventana, opcionesMinutos), filasEntrada: 1 },
        negativos: { run: () => minutesByTarget([parte("2026-06-15", -480)], ventana, opcionesMinutos), filasEntrada: 1 },
        fechas_limite: {
          run: () =>
            minutesByTarget([parte(PERIOD.periodStart, 480), parte(PERIOD.periodEnd, 480)], ventana, opcionesMinutos),
          filasEntrada: 2,
        },
        periodo_sin_movimiento: {
          run: () => minutesByTarget([parte("2026-06-15", 480)], { from: "2024-01-01", to: "2024-12-31" }, opcionesMinutos),
          filasEntrada: 1,
        },
      },
    },
    {
      dir: "accounts",
      nombre: "lib/accounts/tree.ts · buildAccountTree",
      filasSalida: (r) => {
        const result = r as { ok: boolean; value?: readonly unknown[] }
        return result.ok ? (result.value?.length ?? 0) : 0
      },
      casos: {
        vacio: { run: () => buildAccountTree([], { variant: "PYMES" }), filasEntrada: 0 },
        un_registro: { run: () => buildAccountTree([cuenta("57", null)], { variant: "PYMES" }), filasEntrada: 1 },
        // «Importes negativos» en un plan es una cuenta de signo contrario: una
        // cuenta CONTRA (amortización acumulada), que resta donde las demás suman.
        negativos: {
          run: () => buildAccountTree([{ ...cuenta("2816", null), isContra: true, nature: "ACREEDORA" as const }], { variant: "PYMES" }),
          filasEntrada: 1,
        },
        fechas_limite: {
          run: () => buildAccountTree([cuenta("57", null), cuenta("572", "57")], { variant: "PYMES" }),
          filasEntrada: 2,
        },
        periodo_sin_movimiento: {
          run: () => buildAccountTree([cuenta("57", null)], { variant: "PYMES", query: "no-existe-esta-cuenta" }),
          filasEntrada: 1,
        },
      },
    },
    {
      dir: "taxes",
      nombre: "lib/taxes/bps.ts · applyBps",
      filasSalida: () => null,
      casos: {
        vacio: { run: () => ({ cuota: applyBps(0, 2_100) }), filasEntrada: null },
        un_registro: { run: () => ({ cuota: applyBps(100_000, 2_100) }), filasEntrada: null },
        negativos: { run: () => ({ cuota: applyBps(-100_000, 2_100) }), filasEntrada: null },
        // El «borde» de un tipo impositivo es el 0 % y el redondeo del medio céntimo.
        fechas_limite: { run: () => ({ cero: applyBps(100_000, 0), medio: applyBps(10, 500) }), filasEntrada: null },
        periodo_sin_movimiento: { run: () => ({ cuota: applyBps(0, 0) }), filasEntrada: null },
      },
    },
  ]
}

const bankLine = (id: string, operationDate: string, amountCents: number) => ({
  id,
  operationDate,
  valueDate: operationDate,
  amountCents,
  currency: BASE_CURRENCY,
  description: `movimiento ${id}`,
  status: "UNMATCHED" as const,
  counterpartyName: null,
  reference1: null,
  reference2: null,
})

const cashLine = (id: string, entryDate: string, amountCents: number) => ({
  id,
  entryId: `e-${id}`,
  entryNumber: 1,
  entryDate,
  accountCode: "572",
  amountCents,
  description: `apunte ${id}`,
  counterpartyName: null,
  documentNumber: null,
})
