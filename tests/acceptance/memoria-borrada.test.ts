/**
 * E12 · T10 — **«memoria borrada»** (§4.1 del diseño; `SPEC-FIABILIDAD` §6).
 *
 * El test que la spec nombra por su nombre y que nunca se había hecho. Enunciado,
 * sin suavizar:
 *
 * > **Borrado todo lo que el sistema recuerda haber calculado, y regenerado
 * > desde el diario, las cifras y los sellos son idénticos byte a byte.**
 *
 * Lo que se borra lo decide `models/purge-derived.ts`, cuya lista **se deriva
 * del esquema**: una tabla `_runs` nueva, o una que declare el hash de sus
 * fuentes, entra sola. Lo que NO se borra es la fuente única de verdad —el
 * diario, los documentos, el `AuditLog`, los `ExtractionRun`, la configuración
 * versionada—, y ésa es la mitad del test: *si algo derivado no se pudiera
 * borrar sin perder una cifra, sería una fuente encubierta y el producto estaría
 * mal*.
 *
 * Tres variantes, y la tercera es la que muerde:
 *
 *  · (a) purgar → regenerar **en el mismo proceso**;
 *  · (b) purgar → **volver a abrir la conexión** (el equivalente en suite a
 *        reiniciar: se tira el pool de Prisma y con él toda caché de proceso) →
 *        regenerar;
 *  · (c) purgar → regenerar **en otro orden** (analítica antes que contable,
 *        mensual antes que anual). *Es donde este test tiene probabilidad real de
 *        encontrar algo.*
 *
 * Y una cuarta comprobación, **negativa**: tras la purga y ANTES de regenerar,
 * las pantallas de informes **no enseñan una cifra**. Si alguna enseñara un
 * número, ese número venía de la memoria y P4 estaba roto.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { prismaSchemaMeta } from "@/lib/db"
import {
  ACCEPTANCE_GIT_SHA,
  CANONICAL_FIGURES,
  REF_DATE,
  SEAL_NAMES,
  ValidacionRecorder,
  createAcceptanceOrg,
  disconnect,
  dropAcceptanceOrg,
  readCanonical,
  withMaintenance,
  type AcceptanceOrg,
  type CanonicalReading,
} from "./harness"
import {
  DERIVED_MODELS,
  FUENTES_AUNQUE_LO_PAREZCAN,
  SELLOS_NO_RECOMPUTABLES,
  derivedTables,
  tablasSinDeclarar,
  purgableSeals,
  purgeDerived,
  type PurgeReport,
} from "@/models/purge-derived"

const COMPONENTE = "memoria-borrada"
const recorder = new ValidacionRecorder(COMPONENTE)

let org: AcceptanceOrg
let lectura0: CanonicalReading

/** Ejecuta la purga con el rol de operador, que es el único que puede. */
async function purgar(): Promise<PurgeReport> {
  return await withMaintenance(async (client) =>
    await purgeDerived(org.organizationId, async (sql, params) => (await client.query(sql, params ? [...params] : [])).rows)
  )
}

/** Cuenta las filas de una tabla en la organización, con el rol de operador. */
async function contar(table: string, where = ""): Promise<number> {
  return await withMaintenance(async (client) => {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "${table}" WHERE organization_id = $1::uuid ${where}`,
      [org.organizationId]
    )
    return Number(rows[0]?.n ?? 0)
  })
}

/**
 * Las cifras y los sellos, en forma canónica y ordenada: es lo que se compara
 * **byte a byte**. Comparar objetos con `toEqual` pasaría por alto un cambio de
 * orden de claves que en un JSON serializado sí se ve.
 */
function formaCanonica(lectura: CanonicalReading): string {
  const cifras = Object.keys(lectura.figures)
    .sort()
    .map((clave) => `${clave}=${lectura.figures[clave]}`)
  const sellos = [...SEAL_NAMES].sort().map((nombre) => `${nombre}=${lectura.seals[nombre]}`)
  return [...cifras, ...sellos].join("\n")
}

beforeAll(async () => {
  org = await createAcceptanceOrg(COMPONENTE)
  recorder.org(org.organizationId)
  lectura0 = await readCanonical(org)
  recorder.hash(lectura0.seals.ledgerHash)
  recorder.seal(lectura0.sello.sello, lectura0.sello.motivos)
}, 600_000)

afterAll(async () => {
  await recorder.write()
  await dropAcceptanceOrg(org)
  await disconnect()
}, 300_000)

describe("E12 · T10 — la lista de lo derivado se DERIVA del esquema", () => {
  it("I-E12-1a · lo que se purga sale del REGISTRO, tabla por tabla y con motivo", () => {
    const meta = prismaSchemaMeta()
    const lista = derivedTables(meta).map((t) => t.table)

    // Las que §4.1 nombra: si alguna se cayera de la lista, la purga dejaría
    // memoria viva y el test siguiente pasaría por vacuidad.
    for (const esperada of ["report_runs", "invariant_runs", "usage_runs", "allocation_runs"]) {
      recorder.assert(
        `T10-lista-${esperada}`,
        lista.includes(esperada),
        `«${esperada}» ${lista.includes(esperada) ? "está" : "NO está"} en el registro DERIVED_MODELS`
      )
      expect(lista, `${esperada} tiene que estar en el registro`).toContain(esperada)
    }

    // Y la fuente NO entra: `extraction_runs` parece caché por su nombre y aun
    // así es procedencia (P1). Está declarada con motivo, y el motivo se lee.
    expect(lista).not.toContain("extraction_runs")
    expect(FUENTES_AUNQUE_LO_PAREZCAN.extraction_runs.length).toBeGreaterThan(40)
    recorder.add(
      "T10-lista-registro",
      "PASS",
      `${Object.keys(DERIVED_MODELS).length} tablas declaradas derivadas con motivo; ` +
        `${Object.keys(FUENTES_AUNQUE_LO_PAREZCAN).length} declaradas fuente pese a parecer caché`
    )
  })

  it("no queda ninguna tabla de caché SIN declarar: el detector acusa y el registro decide", () => {
    /**
     * La guardia que sustituye a «entra sola en la lista». El detector
     * estructural ya no borra nada: sólo señala. Una tabla `_runs` nueva sin
     * declarar rompe aquí, con su nombre, y obliga a decidir de qué lado cae.
     */
    const meta = prismaSchemaMeta()
    const sinDeclarar = tablasSinDeclarar(meta)
    recorder.assert(
      "T10-sin-declarar",
      sinDeclarar.length === 0,
      sinDeclarar.length === 0
        ? "ninguna tabla de caché fuera del registro"
        : `tabla(s) de caché sin declarar: ${sinDeclarar.join(", ")}`
    )
    expect(sinDeclarar).toEqual([])

    // Y una tabla de caché ficticia SÍ se detecta: el detector no está muerto.
    const ficticia = {
      model: "FixtureFicticioRun",
      table: "fixture_ficticio_runs",
      columns: [
        { field: "id", column: "id", type: "String", kind: "scalar" },
        { field: "organizationId", column: "organization_id", type: "String", kind: "scalar" },
      ],
    }
    expect(tablasSinDeclarar([...meta, ficticia])).toEqual(["fixture_ficticio_runs"])
    expect(derivedTables([...meta, ficticia]).map((t) => t.table)).not.toContain("fixture_ficticio_runs")
    recorder.add(
      "T10-detector-vivo",
      "PASS",
      "una tabla «fixture_ficticio_runs» sin declarar se detecta y NO se purga: nada se borra por parecerlo"
    )
  })

  it("los sellos que NO se purgan están declarados, y con motivo", () => {
    const meta = prismaSchemaMeta()
    const purgables = purgableSeals(meta).map((s) => `${s.table}.${s.column}`)
    for (const [clave, motivo] of Object.entries(SELLOS_NO_RECOMPUTABLES)) {
      expect(purgables, `«${clave}» está declarado no recomputable y aun así se purgaría`).not.toContain(clave)
      expect(motivo.length, `«${clave}» sin motivo escrito`).toBeGreaterThan(30)
    }
    // El sello de fila del asiento NUNCA se toca: lo protege un trigger.
    expect(purgables).not.toContain("journal_entries.entry_hash")
    recorder.add(
      "T10-sellos-purgables",
      "PASS",
      `${purgables.length} columnas-sello recomputables; ${Object.keys(SELLOS_NO_RECOMPUTABLES).length} declaradas fuente`
    )
  })
})

describe("E12 · T10 — memoria borrada: las tres variantes", () => {
  it("(a) purga → regenerar en el MISMO proceso ⇒ 12 cifras y 5 sellos idénticos byte a byte", async () => {
    const antes = formaCanonica(lectura0)
    const informe = await purgar()

    // La purga tiene que haber borrado ALGO: un test que pasa porque no había
    // nada que borrar pasa por vacuidad, que es el anti-patrón E-3.
    expect(informe.totalDeleted, `la purga no borró nada: ${JSON.stringify(informe.tables)}`).toBeGreaterThan(0)
    expect(await contar("invariant_runs")).toBe(0)
    expect(await contar("report_runs")).toBe(0)

    const despues = formaCanonica(await readCanonical(org))
    recorder.assert(
      "I-E12-1a",
      despues === antes,
      despues === antes
        ? `purga de ${informe.totalDeleted} fila(s) derivada(s) y las 12 cifras y los 5 sellos vuelven idénticos`
        : `DIFIEREN tras la purga:\\n${antes}\\n---\\n${despues}`
    )
    expect(despues).toBe(antes)
  }, 900_000)

  it("(b) purga → conexión NUEVA (sin caché de proceso) → regenerar ⇒ idénticos", async () => {
    const antes = formaCanonica(lectura0)
    await purgar()

    /**
     * El equivalente en suite a «reiniciar el proceso»: se tira el pool de
     * Prisma, y con él cualquier caché que viva en memoria entre peticiones. El
     * cliente se reconstruye solo en la primera consulta siguiente.
     */
    const { prisma } = await import("@/lib/db")
    await prisma.$disconnect()

    const despues = formaCanonica(await readCanonical(org))
    recorder.assert(
      "I-E12-1b",
      despues === antes,
      despues === antes
        ? "tras tirar el pool y regenerar, las 12 cifras y los 5 sellos siguen siendo los mismos"
        : `DIFIEREN tras reiniciar:\\n${antes}\\n---\\n${despues}`
    )
    expect(despues).toBe(antes)
  }, 900_000)

  it("(c) purga → regenerar EN OTRO ORDEN (analítica antes que contable, mes antes que año) ⇒ idénticos", async () => {
    const antes = formaCanonica(lectura0)
    await purgar()

    /**
     * **La variante que muerde.** Aquí se pide primero lo que en el orden normal
     * va después: la matriz analítica de un MES antes de que exista ningún
     * barrido del ejercicio, y el informe mensual antes que el anual. Si algún
     * derivado dependiera del orden en que alguien lo pidió —una caché que se
     * rellena de paso, un acumulado que hereda del anterior—, es aquí donde se
     * ve.
     */
    const { getAnalyticPnl } = await import("@/models/margins")
    const { tenantTransaction } = await import("@/lib/db")

    await tenantTransaction(org.organizationId, org.userId, async (tx) =>
      getAnalyticPnl(tx, {
        from: "2026-06-01",
        to: "2026-06-30",
        fiscalYearId: org.fiscalYearId,
        provenance: { runId: "orden-invertido", gitSha: ACCEPTANCE_GIT_SHA, baseCurrency: "EUR" },
      })
    )
    await tenantTransaction(org.organizationId, org.userId, async (tx) =>
      getAnalyticPnl(tx, {
        from: "2026-01-01",
        to: "2026-03-31",
        fiscalYearId: org.fiscalYearId,
        provenance: { runId: "orden-invertido", gitSha: ACCEPTANCE_GIT_SHA, baseCurrency: "EUR" },
      })
    )

    const despues = formaCanonica(await readCanonical(org))
    recorder.assert(
      "I-E12-1c",
      despues === antes,
      despues === antes
        ? "regenerando en otro orden (analítica mensual antes que el barrido anual) las cifras no se mueven"
        : `EL ORDEN IMPORTA, y no debería:\\n${antes}\\n---\\n${despues}`
    )
    expect(despues).toBe(antes)
  }, 900_000)

  it("comprobación NEGATIVA · tras purgar y ANTES de regenerar, no queda ni una cifra guardada", async () => {
    /**
     * **Criterio 33.** Si después de la purga alguna pantalla enseñara un número,
     * ese número venía de la memoria y P4 estaba roto. Las pantallas de informes
     * leen su cifra de `report_runs` y la de auditoría del último
     * `InvariantRun`: se comprueba que **no hay ninguno de los dos**, que es lo
     * que hace que la pantalla diga «sin calcular» en vez de un importe.
     *
     * Se mira la BASE y no el HTML a propósito: un test de pantalla probaría el
     * renderizado; lo que P4 afirma es que **no queda la cifra**, y eso se
     * comprueba donde la cifra estaría.
     */
    await purgar()

    const { latestInvariantRun } = await import("@/models/audit")
    const { tenantDb } = await import("@/lib/db")
    const run = await latestInvariantRun(tenantDb(org.organizationId))
    expect(run, "queda un InvariantRun tras la purga: la pantalla de auditoría enseñaría su cifra").toBeNull()

    for (const tabla of derivedTables().map((t) => t.table)) {
      const filas = await contar(tabla, derivedTables().find((t) => t.table === tabla)?.where ? "" : "")
      // `closing_runs` conserva los SELLADOS a propósito: son un hecho.
      if (tabla === "closing_runs") continue
      expect(filas, `«${tabla}» conserva ${filas} fila(s) tras la purga`).toBe(0)
    }

    recorder.add(
      "T10-negativa",
      "PASS",
      "tras la purga no queda ningún InvariantRun ni ReportRun: la pantalla no tiene cifra que enseñar"
    )

    // Y la SoT sigue en pie: el diario, los documentos y el registro de
    // auditoría. Si la purga los hubiera tocado, las cifras de arriba habrían
    // coincidido por la peor de las razones.
    expect(await contar("journal_entries")).toBeGreaterThan(0)
    expect(await contar("journal_lines")).toBeGreaterThan(0)
    expect(await contar("audit_logs")).toBeGreaterThan(0)
    recorder.add("T10-sot-intacta", "PASS", "diario, líneas y AuditLog siguen enteros tras la purga")
  }, 900_000)

  it("las 12 cifras son las CONGELADAS del diseño, no las que el motor diga hoy", async () => {
    /**
     * El cierre del test: que las cifras vuelvan idénticas no basta si vuelven
     * idénticamente mal. Se enfrentan a los literales de §3.2, que están
     * congelados en el harness y no salen del motor.
     */
    const lectura = await readCanonical(org)
    const esperadas: Array<[string, number]> = [
      ["DEBE", CANONICAL_FIGURES.DEBE_HABER_2026],
      ["HABER", CANONICAL_FIGURES.DEBE_HABER_2026],
      ["RESULTADO", CANONICAL_FIGURES.RESULTADO],
      ["TESORERIA", CANONICAL_FIGURES.TESORERIA],
      ["INGRESOS", CANONICAL_FIGURES.INGRESOS],
      ["MC1", CANONICAL_FIGURES.MC1],
      ["MC2", CANONICAL_FIGURES.MC2],
      ["MC3", CANONICAL_FIGURES.MC3],
      ["EBITDA", CANONICAL_FIGURES.EBITDA],
      ["EBIT", CANONICAL_FIGURES.EBIT],
      ["BAI", CANONICAL_FIGURES.BAI],
    ]
    for (const [clave, esperado] of esperadas) {
      recorder.assert(
        `T10-cifra-${clave}`,
        lectura.figures[clave] === esperado,
        `${clave}: ${lectura.figures[clave]} (esperado ${esperado})`
      )
      expect(lectura.figures[clave], clave).toBe(esperado)
    }
    // #2 = #3 con tolerancia 0, que es el enunciado de I2.
    expect(lectura.figures.ACTIVO).toBe(lectura.figures.PN_MAS_PASIVO)
    // Y #4 = RESULTADO del bloque analítico, que es por qué son 12 y no 13.
    expect(lectura.figures.RESULTADO_ANALITICO).toBe(lectura.figures.RESULTADO)
    recorder.add("T10-refdate", "PASS", `refDate ${REF_DATE} y gitSha ${ACCEPTANCE_GIT_SHA} fijos: nada depende del día`)
  }, 900_000)
})
