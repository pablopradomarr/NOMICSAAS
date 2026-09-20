import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  ACCEPTANCE_GIT_SHA,
  PERIOD,
  REF_DATE,
  ValidacionRecorder,
  createAcceptanceOrg,
  disconnect,
  dropAcceptanceOrg,
  sqlErrorCode,
  withMaintenance,
  withRuntime,
  type AcceptanceOrg,
} from "@/tests/acceptance/harness"

/**
 * **C1 · Snapshots versionados** (E12 · T2 — `docs/design/E12-fiabilidad-dod.md`
 * §3.3 y criterios 3–6 de §10).
 *
 * La aceptación literal de la spec, de punta a punta:
 *
 *  3. Dos ciclos sobre el mismo `ledgerHash` ⇒ resultados **byte-idénticos** y el
 *     segundo **servido de caché** (< 50 ms).
 *  4. Un asiento nuevo ⇒ `ledgerHash` distinto, informe nuevo, **el anterior intacto**.
 *  5. `UPDATE report_runs` como `app_runtime` ⇒ `42501`.
 *  6. Tras `prune-runs.ts`, quedan ≥ 12 runs recientes y ≥ 1 por mes histórico.
 *
 * Lo que este fichero **no** hace es fiarse del motor para saber qué esperar: el
 * ciclo se repite y se comparan bytes, y la retención se mide contando filas en
 * la base con SQL propio, no preguntándole al script cuántas dice que dejó.
 */

const COMPONENTE = "c1"
const registro = new ValidacionRecorder(COMPONENTE)

const { getOrCreateReportRun, getReportRun, listReportRuns } = await import("@/models/reports")
const { canonicalResultJson } = await import("@/lib/ledger/report-run")
const { computeLedgerHash, postEntry, getLedgerContext } = await import("@/models/ledger")
const { buildEntry } = await import("@/lib/ledger/post")
const { tenantDb, tenantTransaction } = await import("@/lib/db")
const { pruneRuns } = await import("@/scripts/prune-runs")

/** Los cuatro informes del ciclo, con sus parámetros congelados. */
const CICLO = [
  { type: "BALANCE" as const, params: { snapshot: "PRE_REGULARIZACION", variant: "PYMES" } },
  { type: "PYG" as const, params: { variant: "PYMES" } },
  { type: "CASHFLOW" as const, params: { method: "DIRECTO", granularity: "MENSUAL", view: "GESTION" } },
  { type: "DASHBOARD" as const, params: { refDate: REF_DATE, variant: "PYMES" } },
]

describe("C1 · snapshots versionados, inmutables y con retención", () => {
  let org: AcceptanceOrg
  let orgMut: AcceptanceOrg

  const emitir = (target: AcceptanceOrg, index: number, extra: Record<string, unknown> = {}) =>
    getOrCreateReportRun(target.organizationId, {
      type: CICLO[index]!.type,
      periodStart: PERIOD.periodStart,
      periodEnd: PERIOD.periodEnd,
      fiscalYearId: target.fiscalYearId,
      params: { ...CICLO[index]!.params, ...extra },
      actor: { userId: target.userId },
    })

  beforeAll(async () => {
    org = await createAcceptanceOrg(COMPONENTE)
    // Los tests que MUTAN el diario van en su propia organización: al postear un
    // asiento cambia el `ledgerHash` y todo lo emitido después sella
    // `LEDGER_DRIFT`. Cada bloque en la suya y el orden deja de importar.
    orgMut = await createAcceptanceOrg(COMPONENTE, { suffix: "mut" })
    registro.org(org.organizationId)
  })

  afterAll(async () => {
    await registro.write()
    await dropAcceptanceOrg(org)
    await dropAcceptanceOrg(orgMut)
    await disconnect()
  })

  it("criterio 3 · dos ciclos sobre el mismo `ledgerHash`: byte-idénticos y el segundo de caché en < 50 ms", async () => {
    const primera = []
    for (let i = 0; i < CICLO.length; i++) primera.push(await emitir(org, i))
    registro.hash(primera[0]!.ledgerHash)
    expect(primera.every((run) => run.origen === "fresh")).toBe(true)

    const startedAt = performance.now()
    const segunda = []
    for (let i = 0; i < CICLO.length; i++) segunda.push(await emitir(org, i))
    const ms = performance.now() - startedAt

    const identicos = segunda.every((run, i) => canonicalResultJson(run.result) === canonicalResultJson(primera[i]!.result))
    const mismoId = segunda.every((run, i) => run.id === primera[i]!.id)
    const deCache = segunda.every((run) => run.origen === "cache")

    registro.assert(
      "C1-1",
      identicos && mismoId && deCache,
      `los cuatro informes del segundo ciclo son el MISMO run servido de caché y su JSON canónico es byte-idéntico ` +
        `(${segunda.map((r) => `${r.type}:${r.origen}`).join(", ")})`
    )
    registro.assert("C1-2", ms < 50 * CICLO.length, `el segundo ciclo tardó ${Math.round(ms)} ms para ${CICLO.length} informes (techo: 50 ms cada uno)`)

    expect(identicos, "el segundo ciclo no reprodujo el JSON byte a byte").toBe(true)
    expect(mismoId).toBe(true)
    expect(deCache).toBe(true)
    expect(ms).toBeLessThan(50 * CICLO.length)
  })

  it("criterio 4 · un asiento nuevo cambia el `ledgerHash`; el informe anterior sigue existiendo intacto", async () => {
    const antes = await emitir(orgMut, 0)
    const hashAntes = antes.ledgerHash

    await tenantTransaction(orgMut.organizationId, orgMut.userId, async (tx) => {
      const context = await getLedgerContext(tx, "2026-12-30")
      const draft = buildEntry(
        {
          organizationId: orgMut.organizationId,
          entryDate: "2026-12-30",
          description: "C1 · asiento que mueve el ledgerHash",
          kind: "NORMAL",
          sourceType: "MANUAL",
          lines: [
            { lineNo: 1, accountCode: "572", debitCents: 1_000, creditCents: 0 },
            { lineNo: 2, accountCode: "570", debitCents: 0, creditCents: 1_000 },
          ],
        },
        context
      )
      if (!draft.ok) throw new Error(`el asiento de prueba no se pudo componer: ${JSON.stringify(draft.errors)}`)
      await postEntry(orgMut.organizationId, draft.value, { userId: orgMut.userId }, { refDate: REF_DATE })
    })

    const vigente = await tenantTransaction(orgMut.organizationId, orgMut.userId, async (tx) =>
      computeLedgerHash(tx, { fiscalYearId: orgMut.fiscalYearId })
    )
    const despues = await emitir(orgMut, 0)
    const anterior = await getReportRun(tenantDb(orgMut.organizationId), antes.id)

    const cambio = vigente !== hashAntes && despues.ledgerHash === vigente && despues.id !== antes.id
    const intacto =
      anterior !== null &&
      anterior.ledgerHash === hashAntes &&
      canonicalResultJson(anterior.result) === canonicalResultJson(antes.result)

    registro.assert("C1-3", cambio, `el asiento movió el ledgerHash ${hashAntes.slice(0, 12)}… → ${vigente.slice(0, 12)}… y produjo un run nuevo`)
    registro.assert("C1-4", intacto, `el ReportRun ${antes.id} sigue en la base con su hash y su resultado originales`)
    expect(cambio).toBe(true)
    expect(intacto).toBe(true)
  })

  it("criterio 5 · `UPDATE`/`DELETE` sobre `report_runs` como `app_runtime` ⇒ 42501 y fila intacta", async () => {
    const run = await emitir(org, 1)
    const update = await withRuntime(org.organizationId, (client) =>
      sqlErrorCode(() =>
        client.query(`UPDATE report_runs SET seal = 'VALIDADO_AUTOMATICAMENTE' WHERE id = $1::uuid`, [run.id])
      )
    )
    const del = await withRuntime(org.organizationId, (client) =>
      sqlErrorCode(() => client.query(`DELETE FROM report_runs WHERE id = $1::uuid`, [run.id]))
    )
    const after = await getReportRun(tenantDb(org.organizationId), run.id)

    registro.assert("C1-5", update === "42501", `UPDATE como app_runtime devolvió ${update}`, "UPDATE report_runs SET seal = … WHERE id = $1")
    registro.assert("C1-6", del === "42501", `DELETE como app_runtime devolvió ${del}`, "DELETE FROM report_runs WHERE id = $1")
    registro.assert("C1-7", after !== null && after.seal === run.seal, `la fila ${run.id} conserva su sello ${run.seal}`)

    expect(update).toBe("42501")
    expect(del).toBe("42501")
    expect(after?.seal).toBe(run.seal)
  })

  it("criterio 6 · la retención mínima: ≥ 12 runs recientes y ≥ 1 por mes histórico sobreviven a `prune-runs.ts`", async () => {
    // Doce runs RECIENTES (distinta foto ⇒ distinto `paramsHash` ⇒ filas
    // distintas) y tres en un mes MUY antiguo, del mismo tipo: el suelo dice que
    // de esos tres sobrevive exactamente el último, y que los doce se quedan.
    const recientes: string[] = []
    for (let i = 0; i < 12; i++) {
      const run = await emitir(org, 0, { serie: `reciente-${i}` })
      recientes.push(run.id)
    }
    const antiguos: string[] = []
    for (let i = 0; i < 3; i++) {
      const run = await emitir(org, 0, { serie: `antiguo-${i}` })
      antiguos.push(run.id)
    }
    // Se envejecen con el rol de operador: `report_runs` es append-only para la
    // aplicación, y esto es exactamente lo que un archivo de hace tres años es.
    await withMaintenance(async (client) => {
      for (let i = 0; i < antiguos.length; i++) {
        await client.query(`UPDATE report_runs SET created_at = $2::timestamptz WHERE id = $1::uuid`, [
          antiguos[i],
          `2024-03-${String(10 + i).padStart(2, "0")}T10:00:00Z`,
        ])
      }
    })

    const dryRun = await pruneRuns({ org: org.organizationId, refDate: "2026-12-31" })
    const informe = await pruneRuns({ org: org.organizationId, apply: true, refDate: "2026-12-31" })

    const vivos = await listReportRuns(tenantDb(org.organizationId), {})
    const vivosIds = new Set(vivos.map((run) => run.id))
    const recientesVivos = recientes.filter((id) => vivosIds.has(id))
    const antiguosVivos = antiguos.filter((id) => vivosIds.has(id))

    const sueloReciente = recientesVivos.length === recientes.length
    // De los tres del mismo mes histórico sobrevive el ÚLTIMO, y sobrevive uno:
    // ni cero (la retención tiene suelo) ni tres (la purga tiene que purgar).
    const sueloHistorico = antiguosVivos.length === 1 && antiguosVivos[0] === antiguos[antiguos.length - 1]
    const purgoAlgo = informe.reportRuns >= 2 && dryRun.reportRuns === informe.reportRuns

    registro.assert("C1-8", sueloReciente, `los ${recientes.length} runs recientes siguen vivos tras la purga`)
    registro.assert(
      "C1-9",
      sueloHistorico,
      `del mes histórico con 3 runs sobrevive 1 —el último— y no ninguno: ${antiguosVivos.length} superviviente(s)`
    )
    registro.assert(
      "C1-10",
      purgoAlgo,
      `la purga borró ${informe.reportRuns} report_runs y el ensayo en seco anunció los mismos (${dryRun.reportRuns})`
    )

    expect(sueloReciente, "la purga cruzó el suelo de los 12 runs recientes").toBe(true)
    expect(sueloHistorico, "el mes histórico se quedó sin su run o conservó los tres").toBe(true)
    expect(purgoAlgo).toBe(true)
  })

  it("el sello y el git-sha de la suite son los declarados: sin ellos la mitad de los asertos serían falsos", async () => {
    const run = await emitir(org, 1)
    registro.assert("C1-11", run.gitSha === ACCEPTANCE_GIT_SHA, `los runs se emiten con GIT_SHA ${run.gitSha}`)
    registro.seal(run.seal, run.sealReasons.map((reason) => reason.code))
    expect(run.gitSha).toBe(ACCEPTANCE_GIT_SHA)
    expect(registro.failures).toEqual([])
  })
})
