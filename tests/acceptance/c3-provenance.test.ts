import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  ACCEPTANCE_GIT_SHA,
  BASE_CURRENCY,
  CANONICAL_FIGURES,
  CANONICAL_LEVELS,
  PERIOD,
  RANGE,
  ValidacionRecorder,
  createAcceptanceOrg,
  disconnect,
  dropAcceptanceOrg,
  type AcceptanceOrg,
} from "@/tests/acceptance/harness"

/**
 * **C3 · Trazabilidad (provenance)** (E12 · T4 — §3.3 y criterios 10–12).
 *
 * La brecha que E12 cierra: **la consulta viaja y nadie la ejecuta**. Aquí se
 * ejecuta. Para cada celda de los informes y para las doce cifras canónicas:
 *
 *  10. se pide la celda al informe, se **ejecuta** su `registros_origen` con sus
 *      `parametros` dentro de `tenantTransaction`, y se exige `Σ(filas) = valor`
 *      con tolerancia 0;
 *  11. lo mismo en los **niveles acumulados** de la matriz analítica —MC3,
 *      EBITDA y BAI acumulan los niveles superiores, y es justo donde E10
 *      encontró la consulta devolviendo **0 filas**—;
 *  12. y se **cronometra** el camino de la celda al documento: ≤ 3 saltos de
 *      identificador y < 5 s de máquina (la spec cronometra 2 min de persona).
 *
 * Una provenance que devuelve cero filas sobre una celda con importe es **peor
 * que ninguna**: afirma que no hay origen. Por eso `filas = 0` con `valor ≠ 0`
 * es FAIL, no aviso.
 */

const COMPONENTE = "c3"
const registro = new ValidacionRecorder(COMPONENTE)

const { tenantTransaction } = await import("@/lib/db")
const { getOrCreateReportRun, getCashflowBucketDetail } = await import("@/models/reports")
const { getAnalyticPnl } = await import("@/models/margins")
const { headlineFigures } = await import("@/models/audit")

type Provenance = {
  valor: number
  metrica: string
  registros_origen: string
  parametros: unknown[]
  confianza: string
}

type Fila = {
  path: string
  cents: number
  isLeaf: boolean
  isComputed: boolean
  isContraCell: boolean
  provenance?: Provenance
  children?: Fila[]
}

const hojas = (rows: readonly Fila[]): Fila[] => rows.flatMap((row) => (row.children?.length ? hojas(row.children) : [row]))

/** `< 5 s` de máquina para el recorrido completo de una celda a su documento. */
const MAX_MS_DRILLDOWN = 5_000

describe("C3 · la provenance de cada celda se EJECUTA y reproduce su cifra", () => {
  let org: AcceptanceOrg
  let ejecutar: (prov: Provenance) => Promise<{ filas: number; debeMenosHaber: number; haberMenosDebe: number }>

  beforeAll(async () => {
    org = await createAcceptanceOrg(COMPONENTE)
    registro.org(org.organizationId)

    ejecutar = async (prov) =>
      await tenantTransaction(org.organizationId, org.userId, async (tx) => {
        // La consulta se ejecuta TAL CUAL, con sus parámetros: nada se interpola
        // (es la promesa de `cellProvenance`) y nada se reescribe para que cuadre.
        const filas = await tx.$queryRawUnsafe<{ id: string }[]>(prov.registros_origen, ...prov.parametros)
        if (filas.length === 0) return { filas: 0, debeMenosHaber: 0, haberMenosDebe: 0 }
        const agregado = await tx.$queryRawUnsafe<{ dc: bigint; cd: bigint }[]>(
          `SELECT COALESCE(SUM(debit_cents - credit_cents), 0)::bigint AS dc,
                  COALESCE(SUM(credit_cents - debit_cents), 0)::bigint AS cd
             FROM journal_lines WHERE id = ANY($1::uuid[])`,
          filas.map((fila) => fila.id)
        )
        return {
          filas: filas.length,
          debeMenosHaber: Number(agregado[0]?.dc ?? 0),
          haberMenosDebe: Number(agregado[0]?.cd ?? 0),
        }
      })
  })

  afterAll(async () => {
    await registro.write()
    await dropAcceptanceOrg(org)
    await disconnect()
  })

  const peticion = (type: "BALANCE" | "PYG" | "CASHFLOW" | "DIARIO", params: Record<string, unknown>) =>
    getOrCreateReportRun(org.organizationId, {
      type,
      periodStart: PERIOD.periodStart,
      periodEnd: PERIOD.periodEnd,
      fiscalYearId: org.fiscalYearId,
      params,
      actor: { userId: org.userId },
    })

  it("criterio 10 · balance: TODA hoja con importe ejecuta su consulta y reproduce su cifra", async () => {
    const run = await peticion("BALANCE", { snapshot: "PRE_REGULARIZACION", variant: "PYMES" })
    registro.hash(run.ledgerHash)
    const result = run.result as {
      activo: Fila[]
      patrimonioNeto: Fila[]
      pasivo: Fila[]
      totalActivoCents: number
      totalPasivoYPatrimonioNetoCents: number
      i2DiffCents: number
    }

    const fallos: string[] = []
    let comprobadas = 0
    let inyectadas = 0
    for (const [bloque, filas] of [
      ["activo", result.activo],
      ["patrimonio-neto", result.patrimonioNeto],
      ["pasivo", result.pasivo],
    ] as const) {
      for (const fila of hojas(filas).filter((f) => f.isLeaf)) {
        if (fila.isComputed) {
          // R-B5 inyecta «VII. Resultado del ejercicio» desde I3: no tiene
          // líneas propias y su origen se comprueba en el bloque de la PyG.
          inyectadas++
          registro.add(
            `C3-balance-inyectada-${fila.path}`,
            "INFO",
            `${fila.path} = ${fila.cents} es una celda INYECTADA por R-B5 desde I3: su origen se comprueba en la PyG`
          )
          continue
        }
        if (!fila.provenance) {
          fallos.push(`${bloque} · ${fila.path}: celda SIN consulta`)
          registro.add(`C3-balance-${fila.path}`, "FAIL", `${fila.path} no trae provenance`)
          continue
        }
        const ejecucion = await ejecutar(fila.provenance)
        const reproduce = ejecucion.debeMenosHaber === fila.cents || ejecucion.haberMenosDebe === fila.cents
        const vacioConImporte = ejecucion.filas === 0 && fila.cents !== 0
        comprobadas++
        if (!reproduce || vacioConImporte) {
          fallos.push(
            `${bloque} · ${fila.path}: celda ${fila.cents}, consulta ${ejecucion.filas} fila(s) → ` +
              `${ejecucion.debeMenosHaber} / ${ejecucion.haberMenosDebe}`
          )
        }
        registro.assert(
          `C3-balance-${fila.path}`,
          reproduce && !vacioConImporte,
          `${fila.path}: ${ejecucion.filas} línea(s) reproducen ${fila.cents} céntimos`,
          fila.provenance.registros_origen
        )
      }
    }

    registro.assert(
      "C3-balance-totales",
      result.i2DiffCents === 0 && result.totalActivoCents === result.totalPasivoYPatrimonioNetoCents,
      `Activo ${result.totalActivoCents} = PN + Pasivo ${result.totalPasivoYPatrimonioNetoCents} (I2 = ${result.i2DiffCents})`
    )

    expect(comprobadas, "el balance no trajo ni una celda con consulta: el test pasaría por vacuidad").toBeGreaterThan(10)
    expect(inyectadas, "R-B5 dejó de inyectar el resultado: la comprobación cambia de sitio").toBeGreaterThan(0)
    expect(fallos, fallos.join("\n")).toEqual([])
    expect(result.i2DiffCents).toBe(0)
  })

  it("criterio 10 · PyG: cada línea reproduce su cifra, y el resultado del ejercicio es la cifra canónica #4", async () => {
    const run = await peticion("PYG", { variant: "PYMES" })
    const result = run.result as { lines: Fila[]; resultadoDelEjercicioCents: number; ebitdaCents: number }

    const fallos: string[] = []
    let comprobadas = 0
    for (const fila of hojas(result.lines).filter((f) => f.isLeaf && !f.isComputed)) {
      if (!fila.provenance) {
        fallos.push(`${fila.path}: celda SIN consulta`)
        continue
      }
      const ejecucion = await ejecutar(fila.provenance)
      const reproduce = ejecucion.haberMenosDebe === fila.cents || ejecucion.debeMenosHaber === fila.cents
      const vacioConImporte = ejecucion.filas === 0 && fila.cents !== 0
      comprobadas++
      if (!reproduce || vacioConImporte) {
        fallos.push(`${fila.path}: celda ${fila.cents} vs ${ejecucion.haberMenosDebe} en ${ejecucion.filas} fila(s)`)
      }
      registro.assert(
        `C3-pyg-${fila.path}`,
        reproduce && !vacioConImporte,
        `${fila.path}: ${ejecucion.filas} línea(s) reproducen ${fila.cents} céntimos`,
        fila.provenance.registros_origen
      )
    }

    registro.assert(
      "C3-cifra-4-resultado",
      result.resultadoDelEjercicioCents === CANONICAL_FIGURES.RESULTADO,
      `cifra canónica #4 · resultado del ejercicio = ${result.resultadoDelEjercicioCents} (esperado ${CANONICAL_FIGURES.RESULTADO})`
    )
    registro.assert(
      "C3-cifra-10-ebitda",
      result.ebitdaCents === CANONICAL_FIGURES.EBITDA,
      `cifra canónica #10 · EBITDA contable = ${result.ebitdaCents}`
    )

    expect(comprobadas).toBeGreaterThan(5)
    expect(fallos, fallos.join("\n")).toEqual([])
    expect(result.resultadoDelEjercicioCents).toBe(CANONICAL_FIGURES.RESULTADO)
  })

  it("criterio 11 · la matriz analítica: las siete cifras de nivel y los niveles ACUMULADOS, celda a celda", async () => {
    const pnl = await tenantTransaction(org.organizationId, org.userId, async (tx) =>
      getAnalyticPnl(tx, {
        ...RANGE,
        fiscalYearId: org.fiscalYearId,
        provenance: { runId: `c3-${COMPONENTE}`, gitSha: process.env.GIT_SHA ?? "e12acc0", baseCurrency: BASE_CURRENCY },
      })
    )

    const fallos: string[] = []
    for (const level of CANONICAL_LEVELS) {
      let suma = 0
      let filas = 0
      let sinConsulta = 0
      for (const column of pnl.pnl.columns) {
        const prov = pnl.pnl.provenance.get(`${level}|${column}`) as Provenance | undefined
        if (!prov) {
          sinConsulta++
          continue
        }
        const ejecucion = await ejecutar(prov)
        suma += ejecucion.haberMenosDebe
        filas += ejecucion.filas
        if (ejecucion.filas === 0 && prov.valor !== 0) {
          fallos.push(`${level}|${column}: celda ${prov.valor} con CERO filas de origen`)
        }
        if (ejecucion.filas > 0 && ejecucion.haberMenosDebe !== prov.valor) {
          fallos.push(`${level}|${column}: celda ${prov.valor} ≠ Σ filas ${ejecucion.haberMenosDebe}`)
        }
      }

      const esperado = CANONICAL_FIGURES[level]
      const total = pnl.pnl.levelTotalsCents[level]
      if (sinConsulta > 0) fallos.push(`${level}: ${sinConsulta} columna(s) sin consulta`)
      if (total !== esperado) fallos.push(`${level}: total ${total} ≠ cifra canónica ${esperado}`)
      if (suma !== total) fallos.push(`${level}: Σ de las consultas ${suma} ≠ total del nivel ${total}`)

      registro.assert(
        `C3-nivel-${level}`,
        total === esperado && suma === total && sinConsulta === 0 && filas > 0,
        `${level} = ${total} céntimos reproducidos por ${filas} línea(s) en ${pnl.pnl.columns.length} columna(s)`
      )
    }

    // Los acumulados: MC3 ⊇ MC2 ⊇ MC1 ⊇ INGRESOS. Si un nivel acumulado trae
    // MENOS líneas que el anterior, la consulta acumulada no está acumulando
    // (el 0 filas de E10 es el caso extremo de esto).
    const filasPorNivel: Record<string, number> = {}
    for (const level of CANONICAL_LEVELS) {
      let filas = 0
      for (const column of pnl.pnl.columns) {
        const prov = pnl.pnl.provenance.get(`${level}|${column}`) as Provenance | undefined
        if (prov) filas += (await ejecutar(prov)).filas
      }
      filasPorNivel[level] = filas
    }
    const monotono = CANONICAL_LEVELS.every(
      (level, i) => i === 0 || filasPorNivel[level]! >= filasPorNivel[CANONICAL_LEVELS[i - 1]!]!
    )
    registro.assert(
      "C3-acumulados",
      monotono,
      `líneas por nivel acumulado: ${CANONICAL_LEVELS.map((l) => `${l}=${filasPorNivel[l]}`).join(", ")}`
    )
    if (!monotono) fallos.push("los niveles acumulados no acumulan líneas")

    expect(fallos, fallos.join("\n")).toEqual([])
  })

  it("criterio 10 · tesorería (#5) y el drill-down del cashflow, que se recompone del run", async () => {
    const run = await peticion("CASHFLOW", { method: "DIRECTO", granularity: "MENSUAL", view: "GESTION" })
    const result = run.result as {
      directo: { openingCashCents: number; closingCashCents: number; totalFlowsCents: number; buckets: string[] }
    }
    const directo = result.directo

    registro.assert(
      "C3-cifra-5-tesoreria",
      directo.closingCashCents === CANONICAL_FIGURES.TESORERIA,
      `cifra canónica #5 · tesorería final = ${directo.closingCashCents} (esperado ${CANONICAL_FIGURES.TESORERIA})`
    )
    registro.assert(
      "C3-i6",
      directo.openingCashCents + directo.totalFlowsCents === directo.closingCashCents,
      `I6 · ${directo.openingCashCents} + ${directo.totalFlowsCents} = ${directo.closingCashCents}`
    )

    // El `result` del cashflow se guarda RESUMIDO (D-E6-4): las líneas no caben.
    // El drill-down las recompone del run con el MISMO motor y trae la consulta.
    let conFilas = 0
    const fallos: string[] = []
    for (const bucket of directo.buckets) {
      const detalle = await getCashflowBucketDetail(org.organizationId, run.id, bucket, { userId: org.userId })
      const prov = detalle.provenance as Provenance | undefined
      if (!prov) {
        fallos.push(`bucket ${bucket}: el drill-down no trae consulta`)
        continue
      }
      const ejecucion = await ejecutar(prov)
      if (ejecucion.filas === 0 && detalle.cents !== 0) {
        fallos.push(`bucket ${bucket}: ${detalle.cents} céntimos con CERO filas de origen`)
      }
      if (ejecucion.filas > 0) conFilas++
      registro.assert(
        `C3-cashflow-${bucket}`,
        !(ejecucion.filas === 0 && detalle.cents !== 0),
        `bucket ${bucket}: ${detalle.cents} céntimos con ${ejecucion.filas} línea(s) de origen`,
        prov.registros_origen
      )
    }
    expect(conFilas, "ningún bucket del cashflow devolvió líneas: el drill-down no prueba nada").toBeGreaterThan(0)
    expect(fallos, fallos.join("\n")).toEqual([])
    expect(directo.closingCashCents).toBe(CANONICAL_FIGURES.TESORERIA)
  })

  it("criterio 10 · las CUATRO cifras firmadas del barrido ejecutan su consulta (hallazgo C3 de la ola A)", async () => {
    /**
     * La ola A encontró que la provenance de `headlineFigures` **no era
     * ejecutable**: una sola consulta agregada con `$1` y `$2` mientras
     * `cellProvenance` le mandaba tres parámetros (`08P01`). T23 le dio una
     * consulta por cifra, que devuelve `journal_lines.id` como todas las demás,
     * con los parámetros que declara y ni uno más. Aquí se ejecutan las cuatro.
     */
    const headline = await tenantTransaction(org.organizationId, org.userId, async (tx) =>
      headlineFigures(tx, {
        ...RANGE,
        fiscalYearId: org.fiscalYearId,
        ledgerHash: "0".repeat(64),
        runId: `c3-headline`,
        gitSha: ACCEPTANCE_GIT_SHA,
        baseCurrency: BASE_CURRENCY,
      })
    )

    const fallos: string[] = []
    for (const [nombre, figura] of Object.entries(headline) as [string, { cents: number; provenance: Provenance }][]) {
      const ejecucion = await ejecutar(figura.provenance)
      const reproduce = ejecucion.debeMenosHaber === figura.cents || ejecucion.haberMenosDebe === figura.cents
      const vacioConImporte = ejecucion.filas === 0 && figura.cents !== 0
      if (!reproduce || vacioConImporte) {
        fallos.push(
          `${nombre}: celda ${figura.cents}, consulta ${ejecucion.filas} fila(s) → ` +
            `${ejecucion.debeMenosHaber} / ${ejecucion.haberMenosDebe}`
        )
      }
      registro.assert(
        `C3-headline-${nombre}`,
        reproduce && !vacioConImporte,
        `${nombre}: ${ejecucion.filas} línea(s) reproducen ${figura.cents} céntimos`,
        figura.provenance.registros_origen
      )
    }

    // Y las dos que además son cifra canónica, para que esto no pase por vacuidad.
    registro.assert(
      "C3-headline-canonicas",
      headline.RESULTADO.cents === CANONICAL_FIGURES.RESULTADO && headline.TESORERIA.cents === CANONICAL_FIGURES.TESORERIA,
      `resultado ${headline.RESULTADO.cents} (#4) y tesorería ${headline.TESORERIA.cents} (#5)`
    )
    registro.assert(
      "C3-headline-i2",
      headline.ACTIVO.cents === headline.PN_MAS_PASIVO.cents,
      `I2 sobre las cifras firmadas: activo ${headline.ACTIVO.cents} = PN + pasivo ${headline.PN_MAS_PASIVO.cents}`
    )

    expect(fallos, fallos.join("\n")).toEqual([])
    expect(headline.RESULTADO.cents).toBe(CANONICAL_FIGURES.RESULTADO)
    expect(headline.TESORERIA.cents).toBe(CANONICAL_FIGURES.TESORERIA)
    expect(headline.ACTIVO.cents).toBe(headline.PN_MAS_PASIVO.cents)
  })

  it("criterio 12 · de la celda al documento: ≤ 3 saltos de identificador y < 5 s", async () => {
    const pnl = await tenantTransaction(org.organizationId, org.userId, async (tx) =>
      getAnalyticPnl(tx, {
        ...RANGE,
        fiscalYearId: org.fiscalYearId,
        provenance: { runId: `c3-drill`, gitSha: process.env.GIT_SHA ?? "e12acc0", baseCurrency: BASE_CURRENCY },
      })
    )
    const columna = pnl.pnl.columns.find((c) => (pnl.pnl.matrixCents.MC3[c] ?? 0) !== 0)
    expect(columna, "la matriz no tiene ni una celda MC3 con importe").toBeDefined()
    const prov = pnl.pnl.provenance.get(`MC3|${columna}`) as Provenance

    const startedAt = performance.now()
    const recorrido = await tenantTransaction(org.organizationId, org.userId, async (tx) => {
      // Salto 1 · celda → líneas
      const lineas = await tx.$queryRawUnsafe<{ id: string }[]>(prov.registros_origen, ...prov.parametros)
      // Salto 2 · línea → asiento
      const asiento = await tx.$queryRawUnsafe<{ id: string; entry_number: number; transaction_id: string | null }[]>(
        `SELECT e.id, e.entry_number, e.transaction_id
           FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
          WHERE l.id = $1::uuid`,
        lineas[0]?.id
      )
      // Salto 3 · asiento → documento origen. Se ejecuta SIEMPRE que el asiento
      // tenga operación: un asiento manual no la tiene, y eso también es una
      // respuesta («este asiento no nace de un documento»), no un error.
      const documento = asiento[0]?.transaction_id
        ? await tx.$queryRawUnsafe<{ id: string; filename: string }[]>(
            `SELECT f.id, f.filename
               FROM transactions t JOIN files f ON f.id = t.file_id
              WHERE t.id = $1::uuid`,
            asiento[0].transaction_id
          )
        : []
      return { lineas: lineas.length, asiento: asiento[0] ?? null, documento: documento[0] ?? null }
    })
    const ms = performance.now() - startedAt

    registro.assert(
      "C3-drilldown-saltos",
      recorrido.lineas > 0 && recorrido.asiento !== null,
      `celda MC3|${columna} → ${recorrido.lineas} línea(s) → asiento nº ${recorrido.asiento?.entry_number} en 3 saltos de identificador`
    )
    registro.assert("C3-drilldown-ms", ms < MAX_MS_DRILLDOWN, `el recorrido completo tardó ${Math.round(ms)} ms (techo ${MAX_MS_DRILLDOWN} ms)`)

    // El fixture completo se compone de asientos MANUALES: no adjunta documentos.
    // El tercer salto EXISTE y se ejecuta; que no encuentre fichero es una
    // propiedad del sustrato, no del producto, y se dice en vez de callarse.
    registro.add(
      "C3-drilldown-documento",
      recorrido.documento ? "PASS" : "WARN",
      recorrido.documento
        ? `el asiento lleva al documento ${recorrido.documento.filename}`
        : "el asiento del fixture completo es MANUAL y no tiene documento adjunto: el tercer salto se ejecuta y " +
            "devuelve vacío. El camino celda→documento con fichero lo ejerce el camino documental (E8) en su e2e"
    )

    expect(recorrido.lineas).toBeGreaterThan(0)
    expect(recorrido.asiento).not.toBeNull()
    expect(ms).toBeLessThan(MAX_MS_DRILLDOWN)
    expect(registro.failures.map((check) => `${check.id}: ${check.evidencia}`)).toEqual([])
  })
})
