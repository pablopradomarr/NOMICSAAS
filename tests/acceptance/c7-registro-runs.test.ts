import { execFileSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  ACCEPTANCE_GIT_SHA,
  PERIOD,
  REF_DATE,
  ValidacionRecorder,
  createAcceptanceOrg,
  disconnect,
  dropAcceptanceOrg,
  type AcceptanceOrg,
} from "@/tests/acceptance/harness"
import { RUNS_SIN_GIT_SHA_BASE, gitShaOf, parseRunRegistry } from "@/runs/registro.schema"

/**
 * **C7 · Versionado del propio sistema** (E12 · T9 — §3.3 y criterios 27–29).
 *
 *  27. `runs/registro.jsonl` valida contra su **schema zod** (`runs/registro.schema.ts`),
 *      sin `run_id` duplicado, y **un run sin `git_sha_base` es rojo**.
 *  28. Dado **cualquier** `ReportRun` histórico se recupera versión + snapshot +
 *      parámetros y **se reemite idéntico**: trazabilidad inversa de verdad, no
 *      un campo guardado que nadie usa.
 *  29. Dos versiones del motor sobre el **mismo snapshot** ⇒ diff cero **o**
 *      diff clasificado como `MOTOR`. Nunca «no se sabe».
 *
 * Y la regla que sostiene al registro: es **append-only**. Lo que ya está
 * escrito no se edita ni se reordena; se compara con la versión de `HEAD`.
 */

const COMPONENTE = "c7"
const registro = new ValidacionRecorder(COMPONENTE)
const REGISTRO = path.resolve(process.cwd(), "runs", "registro.jsonl")

const { getOrCreateReportRun, getReportRun } = await import("@/models/reports")
const { canonicalResultJson } = await import("@/lib/ledger/report-run")
const { runLedgerInvariants } = await import("@/models/ledger")
const { latestInvariantRun, listInvariantRuns, toRunRef } = await import("@/models/audit")
const { diffRuns } = await import("@/lib/audit/diff")
const { tenantDb } = await import("@/lib/db")

/** `git show HEAD:<fichero>`; `null` si no hay repositorio o el fichero es nuevo. */
function contenidoEnHead(fichero: string): string | null {
  try {
    return execFileSync("git", ["show", `HEAD:${fichero}`], { encoding: "utf8", cwd: process.cwd() })
  } catch {
    return null
  }
}

describe("C7 · el registro de runs valida, es append-only y la trazabilidad es inversa", () => {
  let org: AcceptanceOrg
  let contenido = ""

  beforeAll(async () => {
    contenido = await readFile(REGISTRO, "utf8")
    org = await createAcceptanceOrg(COMPONENTE)
    registro.org(org.organizationId)
  })

  afterAll(async () => {
    await registro.write()
    await dropAcceptanceOrg(org)
    await disconnect()
  })

  it("criterio 27 · `registro.jsonl` valida contra su schema, sin duplicados y sin runs sin git-sha", () => {
    const informe = parseRunRegistry(contenido)

    expect(informe.runs.length, "el registro está vacío: el test pasaría por vacuidad").toBeGreaterThan(50)
    registro.add(
      "C7-1",
      informe.errores.length === 0 ? "PASS" : "FAIL",
      informe.errores.length === 0
        ? `las ${informe.runs.length} líneas del registro validan contra el schema`
        : informe.errores.map((error) => `línea ${error.linea} (${error.run_id ?? "?"}): ${error.mensaje}`).join(" · ")
    )
    registro.assert(
      "C7-2",
      informe.duplicados.length === 0,
      informe.duplicados.length === 0
        ? `los ${informe.runs.length} \`run_id\` son únicos`
        : `run_id duplicados: ${informe.duplicados.join(", ")}`
    )

    // La lista de excepciones es CERRADA: ningún run nuevo puede entrar en ella.
    const sinSha = informe.runs.filter((run) => !run.git_sha_base).map((run) => run.run_id)
    const nuevosSinSha = sinSha.filter((id) => !RUNS_SIN_GIT_SHA_BASE.includes(id))
    registro.assert(
      "C7-3",
      nuevosSinSha.length === 0,
      nuevosSinSha.length === 0
        ? `los únicos runs sin \`git_sha_base\` son los ${RUNS_SIN_GIT_SHA_BASE.length} históricos declarados`
        : `runs NUEVOS sin git_sha_base: ${nuevosSinSha.join(", ")}`
    )

    expect(informe.errores, informe.errores.map((e) => `${e.linea}: ${e.mensaje}`).join("\n")).toEqual([])
    expect(informe.duplicados).toEqual([])
    expect(nuevosSinSha).toEqual([])
  })

  it("criterio 27 bis · un run sin `git_sha_base` es ROJO: el schema lo rechaza (prueba negativa)", () => {
    const malo = JSON.stringify({
      run_id: "2099-01-01_run_inventado",
      ts_utc: "2099-01-01T00:00:00Z",
      tipo: "tarea",
      epica: "E99",
      agentes: ["dev-backend"],
    })
    const informe = parseRunRegistry(malo)
    const rechazado = informe.runs.length === 0 && informe.errores.some((error) => error.mensaje.includes("git_sha_base"))
    registro.assert("C7-4", rechazado, `un run sin git_sha_base se rechaza: ${informe.errores.map((e) => e.mensaje).join(" · ")}`)
    expect(rechazado).toBe(true)

    // Y un `tipo` fuera del vocabulario cerrado, también.
    const tipoRaro = parseRunRegistry(
      JSON.stringify({
        run_id: "2099-01-02_tipo_raro",
        ts_utc: "2099-01-02T00:00:00Z",
        tipo: "lo-que-sea",
        epica: "E99",
        agentes: ["dev-backend"],
        git_sha_base: "abcdef1",
      })
    )
    registro.assert("C7-5", tipoRaro.runs.length === 0, `un \`tipo\` fuera del vocabulario cerrado se rechaza`)
    expect(tipoRaro.runs.length).toBe(0)
  })

  it("criterio 27 ter · `tests` admite UN nivel de detalle tipado, y sólo uno (N-1 de la ronda 2)", () => {
    /**
     * La ronda 1 escribió `tests.e2e_detalle` como objeto y el esquema lo
     * rechazaba: la suite que acredita la épica quedó roja por el commit que la
     * cerraba. Se amplió el esquema a propósito —el detalle de los trece e2e es
     * información, no ruido— pero **acotado**: un nivel, valores `string` o
     * lista de `string`. Este test es la mitad negativa de esa decisión.
     */
    const base = {
      ts_utc: "2099-01-03T00:00:00Z",
      tipo: "tarea" as const,
      epica: "E99",
      agentes: ["dev-backend"],
      git_sha_base: "abcdef1",
    }
    const bueno = parseRunRegistry(
      JSON.stringify({
        ...base,
        run_id: "2099-01-03_detalle_valido",
        tests: { unit: 10, fail: 0, e2e_detalle: { verdes: ["admin 4/4"], nota: "la máquina se saturó" } },
      })
    )
    registro.assert(
      "C7-5-bis",
      bueno.errores.length === 0 && bueno.runs.length === 1,
      bueno.errores.length === 0
        ? "un `tests.e2e_detalle` de un nivel (frases y listas de frases) valida"
        : `el detalle de un nivel se rechazó: ${bueno.errores.map((e) => e.mensaje).join(" · ")}`
    )
    expect(bueno.errores).toEqual([])

    // Dos niveles NO: un registro no es un almacén de estructuras.
    const anidadoDoble = parseRunRegistry(
      JSON.stringify({
        ...base,
        run_id: "2099-01-04_detalle_anidado_doble",
        tests: { e2e_detalle: { bloque: { mas: "adentro" } } },
      })
    )
    registro.assert(
      "C7-5-ter",
      anidadoDoble.runs.length === 0,
      "un segundo nivel de anidamiento en `tests` se rechaza"
    )
    expect(anidadoDoble.runs.length).toBe(0)
  })

  it("el registro es APPEND-ONLY: lo que ya estaba en HEAD no se ha editado ni reordenado", () => {
    const enHead = contenidoEnHead("runs/registro.jsonl")
    if (enHead === null) {
      registro.add("C7-6", "WARN", "no hay versión en HEAD con la que comparar (repositorio sin commits o fichero nuevo)")
      return
    }
    const anteriores = enHead.split(/\r?\n/).filter((linea) => linea.trim() !== "")
    const actuales = contenido.split(/\r?\n/).filter((linea) => linea.trim() !== "")
    const prefijo = anteriores.every((linea, i) => actuales[i] === linea)
    registro.assert(
      "C7-6",
      prefijo && actuales.length >= anteriores.length,
      prefijo
        ? `las ${anteriores.length} líneas de HEAD siguen siendo el prefijo exacto de las ${actuales.length} actuales`
        : `una línea ya escrita cambió: el registro dejó de ser append-only`
    )
    expect(prefijo, "el registro dejó de ser append-only").toBe(true)
    expect(actuales.length).toBeGreaterThanOrEqual(anteriores.length)
  })

  it("criterio 28 · trazabilidad inversa: de un `ReportRun` histórico se reemite el MISMO informe", async () => {
    const emitido = await getOrCreateReportRun(org.organizationId, {
      type: "BALANCE",
      periodStart: PERIOD.periodStart,
      periodEnd: PERIOD.periodEnd,
      fiscalYearId: org.fiscalYearId,
      params: { snapshot: "PRE_REGULARIZACION", variant: "PYMES" },
      actor: { userId: org.userId },
    })

    // Desde aquí, SÓLO se conoce el id: todo lo demás se recupera de la fila.
    const historico = await getReportRun(tenantDb(org.organizationId), emitido.id)
    expect(historico, "el ReportRun no se puede recuperar por su id").not.toBeNull()
    if (!historico) return

    const reemitido = await getOrCreateReportRun(org.organizationId, {
      type: historico.type,
      periodStart: historico.periodStart,
      periodEnd: historico.periodEnd,
      params: historico.params,
      actor: { userId: org.userId },
      noCache: true,
      ...(emitido.result && typeof emitido.result === "object" ? {} : {}),
      fiscalYearId: org.fiscalYearId,
    })

    const identico = canonicalResultJson(reemitido.result) === canonicalResultJson(historico.result)
    const mismoSnapshot = reemitido.ledgerHash === historico.ledgerHash && reemitido.paramsHash === historico.paramsHash
    const mismaVersion = reemitido.gitSha === historico.gitSha && historico.gitSha === ACCEPTANCE_GIT_SHA

    registro.hash(historico.ledgerHash)
    registro.assert(
      "C7-7",
      identico && mismoSnapshot && mismaVersion,
      `del ReportRun ${historico.id} se recuperan git-sha ${historico.gitSha}, snapshot ${historico.ledgerHash.slice(0, 12)}… ` +
        `y parámetros ${JSON.stringify(historico.params)}, y el informe reemitido es byte-idéntico`
    )
    expect(identico, "el informe reemitido no es byte-idéntico al histórico").toBe(true)
    expect(mismoSnapshot).toBe(true)
    expect(mismaVersion).toBe(true)
  })

  it("todo barrido sellado es localizable por su `run_id`, y su `validacion.json` viaja con él", async () => {
    const run = await runLedgerInvariants(org.organizationId, {
      refDate: REF_DATE,
      fiscalYearId: org.fiscalYearId,
      gitSha: ACCEPTANCE_GIT_SHA,
      noCache: true,
      actor: { userId: org.userId },
      persist: { trigger: "MANUAL", scopeKind: "FISCAL_YEAR", runById: org.userId },
    })
    const fila = await latestInvariantRun(tenantDb(org.organizationId))
    expect(fila).not.toBeNull()
    if (!fila) return

    const localizable = fila.id === run.persistedRunId && fila.gitSha === ACCEPTANCE_GIT_SHA && fila.checks.length > 0
    registro.seal(run.sello.sello, run.sello.motivos)
    registro.assert(
      "C7-8",
      localizable,
      `el InvariantRun ${fila.id} lleva su git-sha (${fila.gitSha}), sus ${fila.checks.length} checks y sus cinco sellos ` +
        `(${[fila.ledgerHash, fila.analyticsKey, fila.planHash, fila.accountMapHash, fila.configHash].map((h) => h.slice(0, 8)).join("/")}…)`
    )
    expect(localizable).toBe(true)
  })

  it("criterio 29 · dos versiones del motor sobre el MISMO snapshot: diff cero o diff `MOTOR`", async () => {
    const barrido = async (gitSha: string) => {
      await runLedgerInvariants(org.organizationId, {
        refDate: REF_DATE,
        fiscalYearId: org.fiscalYearId,
        gitSha,
        noCache: true,
        actor: { userId: org.userId },
        persist: { trigger: "MANUAL", scopeKind: "FISCAL_YEAR", runById: org.userId },
      })
      const fila = await latestInvariantRun(tenantDb(org.organizationId))
      if (!fila) throw new Error("el barrido no dejó InvariantRun")
      return fila
    }

    const viejo = await barrido("0000aaa")
    const nuevo = await barrido("0000bbb")
    const diff = diffRuns(toRunRef(viejo), toRunRef(nuevo))

    const clasificado = diff.cause === "MOTOR"
    const cifrasIguales = diff.figures.every((figura) => figura.deltaCents === 0)
    registro.assert(
      "C7-9",
      clasificado && cifrasIguales,
      `el mismo snapshot con dos motores: causa ${diff.cause}, ${diff.deltas.length} check(s) movido(s) y ` +
        `${diff.figures.filter((f) => f.deltaCents !== 0).length} cifra(s) con delta`
    )
    expect(diff.cause, "el diff entre dos motores sobre el mismo snapshot no dice MOTOR").toBe("MOTOR")
    expect(cifrasIguales, "cambiar de motor movió una cifra: eso no es un cambio de motor, es un cambio de resultado").toBe(true)

    // Y el histórico queda: los dos runs siguen ahí, no se pisan.
    const historial = await listInvariantRuns(tenantDb(org.organizationId), { take: 10 })
    registro.assert("C7-10", historial.length >= 2, `el historial conserva ${historial.length} barridos`)
    expect(historial.length).toBeGreaterThanOrEqual(2)
    expect(registro.failures.map((check) => `${check.id}: ${check.evidencia}`)).toEqual([])
  })

  it("todo run del registro que declare git-sha lo declara resoluble (o dice que no lo sabe)", () => {
    const informe = parseRunRegistry(contenido)
    const desconocidos = informe.runs
      .map((run) => ({ id: run.run_id, sha: gitShaOf(run) }))
      .filter((run) => run.sha !== "" && run.sha !== "desconocido")
      .filter((run) => {
        try {
          execFileSync("git", ["cat-file", "-e", `${run.sha}^{commit}`], { cwd: process.cwd(), stdio: "ignore" })
          return false
        } catch {
          return true
        }
      })
    // Un sha que el repositorio no conoce puede ser de una rama podada: se dice,
    // no se calla, y no tumba la suite —el registro es histórico y el repositorio
    // de CI puede venir con `--depth`—.
    registro.add(
      "C7-11",
      desconocidos.length === 0 ? "PASS" : "WARN",
      desconocidos.length === 0
        ? "todos los git-sha del registro existen en el repositorio"
        : `git-sha no resolubles en este clon (rama podada o clon superficial): ${desconocidos
            .map((run) => `${run.id}→${run.sha}`)
            .join(", ")}`
    )
    expect(informe.runs.length).toBeGreaterThan(50)
  })
})
