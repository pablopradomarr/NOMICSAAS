import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  ACCEPTANCE_GIT_SHA,
  BASE_CURRENCY,
  CANONICAL_FIGURES,
  CANONICAL_LEVELS,
  PERIOD,
  RANGE,
  REF_DATE,
  SEAL_NAMES,
  ValidacionRecorder,
  createAcceptanceOrg,
  disconnect,
  dropAcceptanceOrg,
  readCanonical,
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
const { loadDocumentalMinimo } = await import("@/tests/support/documental-minimo")

/**
 * El `ledgerHash` que el fixture `ejercicio-completo` sella, y que los seis
 * `validacion.json` de `artifacts/acceptance/` publican. Se escribe aquí para que
 * la demostración de H-9 no dependa sólo de comparar antes/después: si el
 * sustrato moviera el diario, este literal también fallaría.
 */
const LEDGER_HASH_CANONICO = "4a1af0ee555fe6089a4bba5194f251c0ebc0e13defc507ace2e592a60dafd61f"

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

  /**
   * **H-9, cerrado en la ronda 2.**
   *
   * La ronda 1 re-fechó este criterio a E14 con un motivo FALSO: «atar un
   * documento a un asiento del fixture movería el diario y con él las doce
   * cifras canónicas». No es así, y el auditor lo demostró (N-4): ni
   * `canonicalForm` —la del `ledgerHash`— ni `canonicalEntryForm`/`V3` —la del
   * `entryHash`— incluyen `journal_entries.file_id` (`lib/ledger/hash.ts`), y
   * ese campo no entra en ninguna de las doce cifras. Un motivo falso en
   * `ESTADO.md` es el que nadie vuelve a cuestionar, así que aquí se cierra en
   * vez de re-escribirse.
   *
   * Y al intentarlo apareció lo de verdad grave: **el tercer salto no se podía
   * ejecutar**. La consulta era
   * `FROM transactions t JOIN files f ON f.id = t.file_id`, y `transactions`
   * **no tiene** `file_id` (tiene `files jsonb` y `journal_entry_id`): la
   * consulta habría dado `42703 column t.file_id does not exist`. No saltaba
   * porque el fixture deja `transaction_id` a NULL y la rama nunca corría. Es
   * la misma forma de H-4 y de BLOQUEA-2: un control que no puede fallar
   * porque no se ejecuta. El salto va ahora por `journal_entries.file_id`, que
   * es la columna que el modelo de datos tiene y la que ADR-0011 deja fuera de
   * sus formas canónicas.
   *
   * El test ata un documento del sustrato `documental-minimo` al asiento que
   * sostiene la celda, y **demuestra** que no mueve nada: los cinco sellos y
   * las doce cifras, antes y después, idénticos.
   */
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

    // ── Atar un documento al asiento que sostiene la celda (H-9) ─────────────
    //
    // Antes: las doce cifras y los cinco sellos, por el camino del producto.
    const antes = await readCanonical(org)

    const sustrato = await loadDocumentalMinimo({
      organizationId: org.organizationId,
      userId: org.userId,
      gitSha: ACCEPTANCE_GIT_SHA,
      refDate: REF_DATE,
    })
    if (sustrato.mismatches.length > 0) {
      throw new Error(`el sustrato documental no reproduce lo que declara: ${sustrato.mismatches.join(" · ")}`)
    }
    expect(sustrato.fileIds.length, "el sustrato documental no dejó ni un documento que atar").toBeGreaterThan(0)

    /**
     * Medida intermedia, y se declara en vez de esconderse: **el sustrato
     * documental no toca el diario, pero sí la CONFIGURACIÓN analítica** (trae
     * su regla de reparto y su ejecución), y eso mueve `analyticsKey`, que es
     * precisamente el sello que existe para delatar un cambio de reglas. Las
     * doce cifras y los otros cuatro sellos —`ledgerHash` el primero— no se
     * mueven. Separar las dos medidas es lo que permite afirmar que lo que NO
     * mueve nada es atar el documento.
     */
    const trasSustrato = await readCanonical(org)
    const movidasPorSustrato = Object.keys(antes.figures).filter((k) => antes.figures[k] !== trasSustrato.figures[k])
    const sellosPorSustrato = SEAL_NAMES.filter((sello) => antes.seals[sello] !== trasSustrato.seals[sello])
    registro.assert(
      "C3-sustrato-no-toca-el-diario",
      movidasPorSustrato.length === 0 && !sellosPorSustrato.includes("ledgerHash"),
      `cargar el sustrato documental deja las ${Object.keys(antes.figures).length} cifras intactas y el ledgerHash ` +
        `en ${trasSustrato.seals.ledgerHash.slice(0, 12)}…; mueve ${sellosPorSustrato.join(", ") || "ningún sello"} ` +
        "(la regla de reparto que el sustrato trae ES un cambio de configuración analítica, y el sello existe para decirlo)"
    )
    expect(movidasPorSustrato, "el sustrato documental movió una cifra canónica").toEqual([])
    expect(sellosPorSustrato).not.toContain("ledgerHash")
    /**
     * **N-5 del auditor.** `not.toContain("ledgerHash")` deja pasar que el
     * sustrato mueva cualquier OTRO sello sin que nadie se entere. El conjunto
     * de sellos que se mueven es exactamente uno —`analyticsKey`, por la regla
     * de reparto que el sustrato trae— y se afirma como tal: si mañana el
     * sustrato moviera `planHash`, `accountMapHash`, `configHash` o el propio
     * `ledgerHash`, esta línea lo dice con su nombre.
     */
    expect(
      sellosPorSustrato,
      "el sustrato documental mueve un sello que no es `analyticsKey`: revisa qué ha cambiado"
    ).toEqual(["analyticsKey"])

    const atado = await tenantTransaction(org.organizationId, org.userId, async (tx) => {
      const lineas = await tx.$queryRawUnsafe<{ id: string }[]>(prov.registros_origen, ...prov.parametros)
      const [fila] = await tx.$queryRawUnsafe<{ entry_id: string }[]>(
        `SELECT entry_id FROM journal_lines WHERE id = $1::uuid`,
        lineas[0]?.id
      )
      // `file_id`, no `transaction_id`: es la columna real, y ADR-0011 la deja
      // fuera de las tres formas canónicas. No se toca `entry_hash` —hay un
      // trigger que lo impide— ni ninguna columna que entre en una cifra.
      await tx.$executeRawUnsafe(
        `UPDATE journal_entries SET file_id = $1::uuid WHERE id = $2::uuid AND organization_id = $3::uuid`,
        sustrato.fileIds[0],
        fila.entry_id,
        org.organizationId
      )
      return { entryId: fila.entry_id, fileId: sustrato.fileIds[0] }
    })

    // Después: la demostración. Si esto se moviera, el motivo de la ronda 1
    // habría sido cierto y el cierre de H-9 estaría mal.
    const despues = await readCanonical(org)
    const movidas = Object.keys(trasSustrato.figures).filter((k) => trasSustrato.figures[k] !== despues.figures[k])
    const sellosMovidos = SEAL_NAMES.filter((sello) => trasSustrato.seals[sello] !== despues.seals[sello])
    registro.assert(
      "C3-drilldown-no-mueve-cifras",
      movidas.length === 0 && sellosMovidos.length === 0,
      movidas.length === 0 && sellosMovidos.length === 0
        ? `atar el documento ${atado.fileId.slice(0, 8)} al asiento ${atado.entryId.slice(0, 8)} deja las ` +
            `${Object.keys(trasSustrato.figures).length} cifras y los CINCO sellos INTACTOS ` +
            `(ledgerHash ${despues.seals.ledgerHash.slice(0, 12)}…)`
        : `atar el documento movió ${movidas.join(", ") || "ninguna cifra"} y los sellos ${sellosMovidos.join(", ")}`
    )
    expect(movidas, "atar un documento a un asiento movió una cifra canónica").toEqual([])
    expect(sellosMovidos, "atar un documento a un asiento movió un sello").toEqual([])
    expect(despues.seals.ledgerHash).toBe(LEDGER_HASH_CANONICO)

    const startedAt = performance.now()
    const recorrido = await tenantTransaction(org.organizationId, org.userId, async (tx) => {
      // Salto 1 · celda → líneas
      const lineas = await tx.$queryRawUnsafe<{ id: string }[]>(prov.registros_origen, ...prov.parametros)
      // Salto 2 · línea → asiento
      const asiento = await tx.$queryRawUnsafe<{ id: string; entry_number: number; file_id: string | null }[]>(
        `SELECT e.id, e.entry_number, e.file_id
           FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
          WHERE l.id = $1::uuid`,
        lineas[0]?.id
      )
      // Salto 3 · asiento → documento origen, por `journal_entries.file_id`.
      // Se ejecuta SIEMPRE que el asiento traiga documento; un asiento manual
      // sin documento también es una respuesta, no un error — pero desde H-9
      // este asiento SÍ lo trae, y el salto se ejerce de verdad.
      const documento = asiento[0]?.file_id
        ? await tx.$queryRawUnsafe<{ id: string; filename: string }[]>(
            `SELECT f.id, f.filename FROM files f WHERE f.id = $1::uuid`,
            asiento[0].file_id
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

    // **H-9 cerrado**: el tercer salto llega a un fichero de verdad. Ya no es un
    // WARN con excusa; es un PASS con el nombre del documento.
    registro.assert(
      "C3-drilldown-documento",
      recorrido.documento !== null,
      recorrido.documento
        ? `el asiento nº ${recorrido.asiento?.entry_number} lleva al documento «${recorrido.documento.filename}» ` +
            "en el tercer salto, sin mover ni una cifra"
        : "el tercer salto no llegó a ningún documento: H-9 no está cerrado"
    )

    expect(recorrido.lineas).toBeGreaterThan(0)
    expect(recorrido.asiento).not.toBeNull()
    expect(recorrido.documento, "el tercer salto no llega al documento: criterio 12 en WARN otra vez").not.toBeNull()
    expect(ms).toBeLessThan(MAX_MS_DRILLDOWN)
    expect(registro.failures.map((check) => `${check.id}: ${check.evidencia}`)).toEqual([])
  })
})
