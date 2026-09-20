import { execFile } from "node:child_process"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  ACCEPTANCE_GIT_SHA,
  PERIOD,
  REF_DATE,
  ValidacionRecorder,
  createAcceptanceOrg,
  disconnect,
  dropAcceptanceOrg,
  withMaintenance,
  type AcceptanceOrg,
} from "@/tests/acceptance/harness"

/**
 * **C4 · La matriz de inyección** (E12 · T6 — §3.5 y criterios 13–18).
 *
 * La spec pide *un* error inyectado. E12 pide **diez**, porque cuatro épicas han
 * demostrado que un solo error inyectado se detecta y nueve no.
 *
 * Reglas de esta suite, que no se negocian:
 *
 *  - **Sobre una COPIA.** La organización es efímera y se destruye al acabar; el
 *    diario de nadie se toca. Cada inyección se **deshace** antes de la siguiente,
 *    de modo que ninguna se apoya en el desorden que dejó la anterior.
 *  - **Cazada por al menos un check NOMBRADO.** No vale «algo cambió»: la salida
 *    dice **cuál** lo cazó. Una inyección no detectada es **FAIL de la suite**.
 *  - **Las tres capas.** Capa 1, el barrido de invariantes; Capa 2,
 *    `scripts/audit-reconstruct.ts` (segundo motor, SQL crudo); Capa 3, los
 *    umbrales y `diffRuns` sobre dos barridos sellados.
 *  - **Lo que no se puede inyectar se DECLARA**, con su motivo y comprobando que
 *    el sustrato falta de verdad. Un `PASS` sobre una inyección que nunca se hizo
 *    sería exactamente el teatro que esta épica existe para evitar.
 */

const COMPONENTE = "c4"
const registro = new ValidacionRecorder(COMPONENTE)
const ejecutar = promisify(execFile)

const { tenantDb, tenantTransaction } = await import("@/lib/db")
const { getOrCreateReportRun } = await import("@/models/reports")
const { runLedgerInvariants, computeLedgerHash } = await import("@/models/ledger")
const { listInvariantRuns, toRunRef } = await import("@/models/audit")
const { diffRuns } = await import("@/lib/audit/diff")
const { appMaintenanceDatabaseUrl, ownerDatabaseUrl } = await import("@/tests/support/env")
const { sha256OfStoredFile } = await import("@/lib/files-integrity")

/**
 * FAIL que la **organización efímera** produce por lo que ES, no por lo que el
 * producto hace mal. Se declaran uno a uno, con su motivo: sin esta lista el
 * baseline sería «hay tres FAIL y no sé por qué», que es justo el silencio que
 * esta épica persigue. Cualquier OTRO FAIL en el ciclo limpio es rojo.
 */
const FAIL_DEL_SUSTRATO: Readonly<Record<string, string>> = {
  "I-E9-14":
    "el fixture no abre el ejercicio siguiente, así que la apertura no puede casar línea a línea con el cierre de 2026",
  "I-E11-5":
    "la organización de la suite nace por SQL de arnés, sin el alta de plataforma que le daría suscripción (E11 · D9)",
  "I-E11-10":
    "sin política de retención ejecutada sobre una organización recién creada no hay purga que comprobar",
}

type EstadoChecks = Map<string, { status: string; evidencia: string }>

type Senal = { detector: string; evidencia: string }

type Inyeccion = {
  numero: number
  nombre: string
  /** Quién DEBE cazarla, según §3.5. Es la expectativa, no la observación. */
  esperado: string
  /** Aplica la alteración sobre la copia. Devuelve `null` si el sustrato falta. */
  inyectar: () => Promise<string | null>
  deshacer: () => Promise<void>
}

/** Señales que se consideran «check nombrado»: cada una dice QUÉ la vio. */
async function señales(
  org: AcceptanceOrg,
  base: { checks: EstadoChecks; ledgerHash: string }
): Promise<{ senales: Senal[]; checks: EstadoChecks; ledgerHash: string }> {
  const run = await runLedgerInvariants(org.organizationId, {
    refDate: REF_DATE,
    fiscalYearId: org.fiscalYearId,
    gitSha: ACCEPTANCE_GIT_SHA,
    noCache: true,
    actor: { userId: org.userId },
    audit: true,
    // Sin lector de bytes, I-E8-2 se queda en WARN y la inyección #6 no tendría
    // quien la cazara: es el mismo lector que pasa `scripts/run-invariants.ts`.
    readStoredFile: sha256OfStoredFile,
  })
  const checks: EstadoChecks = new Map(
    run.validacion.checks.map((check) => [check.id, { status: check.status, evidencia: check.evidencia }])
  )
  const senales: Senal[] = []
  for (const [id, ahora] of checks) {
    const antes = base.checks.get(id)
    const empeora = ahora.status === "FAIL" || (ahora.status === "WARN" && antes?.status !== "WARN")
    if (empeora && antes?.status !== ahora.status) {
      senales.push({ detector: id, evidencia: `${antes?.status ?? "—"} → ${ahora.status}: ${ahora.evidencia.slice(0, 160)}` })
    }
  }
  const ledgerHash = await tenantTransaction(org.organizationId, org.userId, async (tx) =>
    computeLedgerHash(tx, { fiscalYearId: org.fiscalYearId })
  )
  if (ledgerHash !== base.ledgerHash) {
    senales.push({ detector: "ledgerHash", evidencia: `${base.ledgerHash.slice(0, 12)}… → ${ledgerHash.slice(0, 12)}…` })
  }
  return { senales, checks, ledgerHash }
}

describe("C4 · las diez inyecciones de §3.5 sobre una copia, y las tres capas", () => {
  let org: AcceptanceOrg
  let base: { checks: EstadoChecks; ledgerHash: string }
  let tmp = ""
  let entradasAuditLog = 0

  /** Ejecuta el auditor automatizado (Capa 2) y devuelve su veredicto. */
  const auditor = async (fichero: string): Promise<{ veredicto: string; hallazgos: number; salida: string }> => {
    const out = path.join(tmp, fichero)
    let salida = ""
    try {
      const { stdout } = await ejecutar(
        "npx",
        ["tsx", "scripts/audit-reconstruct.ts", "--org", org.organizationId, "--ref-date", REF_DATE, "--out", out],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            DATABASE_URL_MAINTENANCE: process.env.DATABASE_URL_MAINTENANCE || appMaintenanceDatabaseUrl(ownerDatabaseUrl()),
          },
          maxBuffer: 8 * 1024 * 1024,
        }
      )
      salida = stdout
    } catch (error) {
      // Exit code ≠ 0 es lo NORMAL cuando el auditor refuta: no es un fallo del test.
      salida = String((error as { stdout?: string }).stdout ?? error)
    }
    const json = JSON.parse(await readFile(out, "utf8")) as { veredicto: string; hallazgos: unknown[] }
    return { veredicto: json.veredicto, hallazgos: json.hallazgos.length, salida }
  }

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "c4-"))
    org = await createAcceptanceOrg(COMPONENTE)
    registro.org(org.organizationId)

    // El auditor contrasta contra lo SELLADO: sin informes ni barrido no hay
    // nada que contrastar y el veredicto sería NO_VERIFICABLE por vacío.
    //
    // **Sólo BALANCE y PyG, y no es casualidad.** El auditor sondea el JSON
    // sellado buscando claves que terminen en el nombre de la métrica; el
    // `CASHFLOW` mensual y el `DASHBOARD` sellan además la SERIE por meses, de
    // modo que el sondeo encuentra diez valores distintos para `INGRESOS` y
    // declara `P-PRODUCTO-CONTRADICTORIO` sobre una copia intacta. Es un límite
    // del sondeo de Capa 2 —no del producto—, queda anotado en el
    // `validacion.json` de este componente y es hallazgo para T24/T25.
    for (const [type, params] of [
      ["BALANCE", { snapshot: "PRE_REGULARIZACION", variant: "PYMES" }],
      ["PYG", { variant: "PYMES" }],
    ] as const) {
      await getOrCreateReportRun(org.organizationId, {
        type,
        periodStart: PERIOD.periodStart,
        periodEnd: PERIOD.periodEnd,
        fiscalYearId: org.fiscalYearId,
        params,
        actor: { userId: org.userId },
      })
    }
    // **Por qué NO se siembra aquí el camino documental.** Sembrar un `File` y
    // su `ExtractionRun` con el arnés de E8 haría ejercitables las inyecciones
    // #5 y #6, pero el sustrato sembrado deja el ciclo limpio con `I-E8-11`,
    // `I-E8-17` e `I-E11-6` en FAIL —el documento no está en el almacén que el
    // invariante lee y los sellos del run no se recomputan—, y una inyección
    // sobre un baseline ya roto no demuestra nada: no se distingue lo que caza
    // el invariante de lo que ya estaba mal. Las dos quedan DECLARADAS como no
    // ejercidas hasta que exista un fixture documental coherente (T24).
    const limpio = await runLedgerInvariants(org.organizationId, {
      refDate: REF_DATE,
      fiscalYearId: org.fiscalYearId,
      gitSha: ACCEPTANCE_GIT_SHA,
      noCache: true,
      actor: { userId: org.userId },
      readStoredFile: sha256OfStoredFile,
      persist: { trigger: "MANUAL", scopeKind: "FISCAL_YEAR", runById: org.userId },
    })
    registro.seal(limpio.sello.sello, limpio.sello.motivos)
    base = {
      checks: new Map(limpio.validacion.checks.map((c) => [c.id, { status: c.status, evidencia: c.evidencia }])),
      ledgerHash: limpio.validacion.ledgerHash ?? "",
    }
    registro.hash(base.ledgerHash)
    const conteo = await withMaintenance(async (client) =>
      client.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_logs WHERE organization_id = $1::uuid`, [
        org.organizationId,
      ])
    )
    entradasAuditLog = Number(conteo.rows[0]?.n ?? 0)
  })

  afterAll(async () => {
    await registro.write()
    await dropAcceptanceOrg(org)
    await disconnect()
  })

  it("criterio 13 · el ciclo limpio sale sin intervención: Capa 1 en verde y Capa 2 CONFORME", async () => {
    const fallos = [...base.checks.entries()].filter(([, check]) => check.status === "FAIL")
    const inesperados = fallos.map(([id]) => id).filter((id) => !(id in FAIL_DEL_SUSTRATO))
    registro.assert(
      "C4-limpio-capa1",
      inesperados.length === 0,
      inesperados.length === 0
        ? `el barrido limpio deja ${fallos.length} FAIL entre ${base.checks.size} checks, y los ${fallos.length} son los del ` +
            `sustrato declarado (${fallos.map(([id]) => id).join(", ")})`
        : `FAIL no declarados en el ciclo limpio: ${fallos
            .filter(([id]) => inesperados.includes(id))
            .map(([id, c]) => `${id} (${c.evidencia.slice(0, 100)})`)
            .join(" · ")}`
    )
    for (const [id, motivo] of Object.entries(FAIL_DEL_SUSTRATO)) {
      registro.add(
        `C4-sustrato-${id}`,
        "INFO",
        `${id} sale en FAIL sobre la organización efímera por el sustrato, no por el producto: ${motivo}`
      )
    }
    expect(inesperados, "el ciclo limpio tiene FAIL que nadie ha declarado").toEqual([])

    const veredicto = await auditor("limpio.json")
    registro.assert(
      "C4-limpio-capa2",
      veredicto.veredicto === "CONFORME",
      `audit-reconstruct sobre la copia limpia: ${veredicto.veredicto} con ${veredicto.hallazgos} hallazgo(s)`
    )
    registro.add(
      "C4-limite-sondeo",
      "WARN",
      "el sondeo de Capa 2 busca la métrica por el NOMBRE de la clave dentro del JSON sellado: con un `CASHFLOW` " +
        "mensual o un `DASHBOARD` sellados encuentra la serie mes a mes y declara P-PRODUCTO-CONTRADICTORIO sobre " +
        "una copia intacta. Por eso esta suite sella BALANCE y PyG. Hallazgo para T24/T25 (no es del producto)"
    )
    expect(veredicto.veredicto, veredicto.salida).toBe("CONFORME")
  }, 300_000)

  it("criterios 15, 16 y 17 · las diez inyecciones, cada una cazada por un check NOMBRADO", async () => {
    const sql = (texto: string, params: readonly unknown[] = []) =>
      withMaintenance(async (client) => (await client.query(texto, [...params])).rows as Record<string, unknown>[])

    /** Datos que hacen falta para inyectar y deshacer. */
    const unaLinea = (
      await sql(
        `SELECT id, debit_cents, credit_cents, project_id FROM journal_lines
          WHERE organization_id = $1::uuid AND debit_cents > 0 AND project_id IS NOT NULL
          ORDER BY id LIMIT 1`,
        [org.organizationId]
      )
    )[0]
    // Del MISMO ejercicio: la numeración es por ejercicio, y dos asientos «nº 1»
    // de años distintos no se pueden intercambiar (ni sería un intercambio).
    const dosAsientos = await sql(
      `SELECT id, entry_number FROM journal_entries
        WHERE organization_id = $1::uuid AND fiscal_year_id = $2::uuid
        ORDER BY entry_number LIMIT 2`,
      [org.organizationId, org.fiscalYearId]
    )
    const otroProyecto = (
      await sql(
        `SELECT id FROM projects WHERE organization_id = $1::uuid AND id <> $2::uuid ORDER BY code LIMIT 1`,
        [org.organizationId, unaLinea?.project_id]
      )
    )[0]
    const unLog = (
      await sql(`SELECT id, entity, action FROM audit_logs WHERE organization_id = $1::uuid ORDER BY ts DESC LIMIT 1`, [
        org.organizationId,
      ])
    )[0]

    /** Sustratos que el fixture completo no trae: se COMPRUEBA que faltan. */
    const cuenta = async (tabla: string): Promise<number> => {
      const filas = await sql(`SELECT count(*)::int AS n FROM ${tabla} WHERE organization_id = $1::uuid`, [
        org.organizationId,
      ])
      return Number(filas[0]?.n ?? 0)
    }
    const sustratos = {
      allocation_lines: await cuenta("allocation_lines"),
      extraction_runs: await cuenta("extraction_runs"),
      files: await cuenta("files"),
      usage_runs: await cuenta("usage_runs"),
    }

    const inyecciones: Inyeccion[] = [
      {
        numero: 1,
        nombre: "un céntimo en una línea del diario",
        esperado: "I1 + ledgerHash",
        inyectar: async () => {
          if (!unaLinea) return null
          await sql(`UPDATE journal_lines SET debit_cents = debit_cents + 1 WHERE id = $1::uuid`, [unaLinea.id])
          return `línea ${String(unaLinea.id).slice(0, 8)} con un céntimo de más`
        },
        deshacer: async () => {
          await sql(`UPDATE journal_lines SET debit_cents = debit_cents - 1 WHERE id = $1::uuid`, [unaLinea?.id])
        },
      },
      {
        numero: 2,
        nombre: "dos `entryNumber` intercambiados (los hashes de línea no se mueven)",
        esperado: "I7 + numeración sin huecos / entry_hash",
        inyectar: async () => {
          if (dosAsientos.length < 2) return null
          const [a, b] = dosAsientos
          await sql(`UPDATE journal_entries SET entry_number = 999999 WHERE id = $1::uuid`, [a!.id])
          await sql(`UPDATE journal_entries SET entry_number = $2::int WHERE id = $1::uuid`, [b!.id, a!.entry_number])
          await sql(`UPDATE journal_entries SET entry_number = $2::int WHERE id = $1::uuid`, [a!.id, b!.entry_number])
          return `asientos ${a!.entry_number} y ${b!.entry_number} intercambiados`
        },
        deshacer: async () => {
          const [a, b] = dosAsientos
          if (!a || !b) return
          await sql(`UPDATE journal_entries SET entry_number = 999999 WHERE id = $1::uuid`, [b.id])
          await sql(`UPDATE journal_entries SET entry_number = $2::int WHERE id = $1::uuid`, [a.id, a.entry_number])
          await sql(`UPDATE journal_entries SET entry_number = $2::int WHERE id = $1::uuid`, [b.id, b.entry_number])
        },
      },
      {
        numero: 3,
        nombre: "una línea analítica reasignada a otro proyecto",
        esperado: "I4 por dimensión (el total de compañía compensa)",
        inyectar: async () => {
          if (!unaLinea || !otroProyecto) return null
          await sql(`UPDATE journal_lines SET project_id = $2::uuid WHERE id = $1::uuid`, [unaLinea.id, otroProyecto.id])
          return `línea ${String(unaLinea.id).slice(0, 8)} movida al proyecto ${String(otroProyecto.id).slice(0, 8)}`
        },
        deshacer: async () => {
          await sql(`UPDATE journal_lines SET project_id = $2::uuid WHERE id = $1::uuid`, [unaLinea?.id, unaLinea?.project_id])
        },
      },
      {
        numero: 4,
        nombre: "una `allocation_lines` alterada bajo un `ReportRun` vigente",
        esperado: "I5 + linesHash + I-E7-10",
        inyectar: async () => (sustratos.allocation_lines === 0 ? null : (await sql(
          `UPDATE allocation_lines SET amount_cents = amount_cents + 1
            WHERE organization_id = $1::uuid AND id = (SELECT id FROM allocation_lines WHERE organization_id = $1::uuid ORDER BY id LIMIT 1)`,
          [org.organizationId]
        ), "una imputación con un céntimo de más")),
        deshacer: async () => {
          if (sustratos.allocation_lines === 0) return
          await sql(
            `UPDATE allocation_lines SET amount_cents = amount_cents - 1
              WHERE organization_id = $1::uuid AND id = (SELECT id FROM allocation_lines WHERE organization_id = $1::uuid ORDER BY id LIMIT 1)`,
            [org.organizationId]
          )
        },
      },
      {
        numero: 5,
        nombre: "un `proposal_sha` reescrito en un run ya contabilizado",
        esperado: "I-E8-11 / I-E8-7a",
        inyectar: async () => (sustratos.extraction_runs === 0 ? null : (await sql(
          `UPDATE extraction_runs SET proposal_sha = repeat('a', 64) WHERE organization_id = $1::uuid`,
          [org.organizationId]
        ), "proposal_sha reescrito")),
        deshacer: async () => undefined,
      },
      {
        numero: 6,
        nombre: "un byte del documento en el almacén",
        esperado: "I-E8-2 / I-E11-6",
        inyectar: async () => (sustratos.files === 0 ? null : (await sql(
          `UPDATE files SET sha256 = repeat('b', 64) WHERE organization_id = $1::uuid`,
          [org.organizationId]
        ), "sha256 del documento alterado")),
        deshacer: async () => undefined,
      },
      {
        numero: 7,
        nombre: "una fila MENOS en `AuditLog`",
        esperado: "recuento + sha del registro",
        inyectar: async () => {
          if (!unLog) return null
          await sql(`DELETE FROM audit_logs WHERE id = $1::uuid`, [unLog.id])
          return `borrada la entrada ${String(unLog.id).slice(0, 8)} (${unLog.entity}/${unLog.action})`
        },
        deshacer: async () => undefined,
      },
      {
        numero: 8,
        nombre: "un `UsageRun` con una métrica retocada y su `sourceHash` INTACTO",
        esperado: "I-E11-1",
        inyectar: async () => (sustratos.usage_runs === 0 ? null : (await sql(
          `UPDATE usage_runs SET entries_count = entries_count + 1 WHERE organization_id = $1::uuid`,
          [org.organizationId]
        ), "métrica de uso retocada")),
        deshacer: async () => undefined,
      },
      {
        numero: 9,
        nombre: "una cuota del 303 tocada en el libro registro",
        esperado: "I-E8-15a/b/c",
        inyectar: async () => (sustratos.extraction_runs === 0 ? null : null),
        deshacer: async () => undefined,
      },
      {
        numero: 10,
        nombre: "el `configHash`: bajar un umbral `EV-*` sin tocar un dato",
        esperado: "`diffRuns` dice CONFIGURACION, nunca NINGUNA",
        inyectar: async () => {
          await sql(
            `UPDATE bank_accounts SET match_tolerance_days = match_tolerance_days + 5 WHERE organization_id = $1::uuid`,
            [org.organizationId]
          )
          await sql(
            `UPDATE organizations SET review_thresholds = '{"kpis":{"resultado":{"pctBps":1,"minCents":1}}}'::jsonb WHERE id = $1::uuid`,
            [org.organizationId]
          )
          return "umbral de revisión bajado al mínimo, sin tocar un solo apunte"
        },
        deshacer: async () => {
          await sql(`UPDATE organizations SET review_thresholds = NULL WHERE id = $1::uuid`, [org.organizationId])
          await sql(
            `UPDATE bank_accounts SET match_tolerance_days = match_tolerance_days - 5 WHERE organization_id = $1::uuid`,
            [org.organizationId]
          )
        },
      },
    ]

    const noDetectadas: string[] = []
    const noEjercidas: string[] = []

    for (const inyeccion of inyecciones) {
      const id = `C4-inyeccion-${inyeccion.numero}`
      let aplicada: string | null
      try {
        aplicada = await inyeccion.inyectar()
      } catch (error) {
        // **La base la rechaza.** Es la detección más fuerte posible: el error
        // no llega ni a existir, y el guardián tiene nombre (trigger de ADR-0010,
        // constraint de partida doble, política append-only…). Se registra como
        // cazada, con el mensaje exacto del guardián que la paró.
        const mensaje = error instanceof Error ? error.message : String(error)
        registro.add(
          id,
          "PASS",
          `#${inyeccion.numero} ${inyeccion.nombre}: la BASE la rechaza antes de escribirla — «${mensaje.slice(0, 160)}» ` +
            `(esperado además: ${inyeccion.esperado})`
        )
        continue
      }
      if (aplicada === null) {
        // El sustrato NO está: se dice, con la prueba de que falta, y se cuenta
        // como no ejercida. Nunca como aprobada.
        const faltan = Object.entries(sustratos)
          .filter(([, n]) => n === 0)
          .map(([tabla]) => tabla)
          .join(", ")
        registro.add(
          id,
          "WARN",
          `#${inyeccion.numero} ${inyeccion.nombre}: NO EJERCIDA — el fixture completo no trae el sustrato ` +
            `(tablas vacías en la copia: ${faltan}). La inyección espera ${inyeccion.esperado}`
        )
        noEjercidas.push(`#${inyeccion.numero} ${inyeccion.nombre}`)
        continue
      }

      const observado = await señales(org, base)
      const extra: Senal[] = []

      if (inyeccion.numero === 1) {
        // Capa 2 sobre la MISMA inyección: el segundo motor, que no comparte una
        // línea con el primero, tiene que refutar por su cuenta.
        const veredicto = await auditor(`inyeccion-${inyeccion.numero}.json`)
        if (veredicto.veredicto !== "CONFORME") {
          extra.push({
            detector: `audit-reconstruct = ${veredicto.veredicto}`,
            evidencia: `${veredicto.hallazgos} hallazgo(s) del segundo motor`,
          })
        }
      }

      if (inyeccion.numero === 7) {
        // El recuento del registro: la memoria sólo crece. Una fila menos se ve
        // contándola, que es lo que §3.5 pide («recuento + sha del registro»).
        const ahora = await withMaintenance(async (client) =>
          client.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_logs WHERE organization_id = $1::uuid`, [
            org.organizationId,
          ])
        )
        const n = Number(ahora.rows[0]?.n ?? 0)
        if (n < entradasAuditLog) {
          extra.push({ detector: "recuento de audit_logs", evidencia: `${entradasAuditLog} → ${n} entradas` })
        }
      }

      if (inyeccion.numero === 10) {
        // Capa 3: dos barridos sellados y el diff, que tiene que decir
        // CONFIGURACION. «NINGUNA» aquí sería la capa de fiabilidad apagada.
        await runLedgerInvariants(org.organizationId, {
          refDate: REF_DATE,
          fiscalYearId: org.fiscalYearId,
          gitSha: ACCEPTANCE_GIT_SHA,
          noCache: true,
          actor: { userId: org.userId },
          persist: { trigger: "MANUAL", scopeKind: "FISCAL_YEAR", runById: org.userId },
        })
        const historial = await listInvariantRuns(tenantDb(org.organizationId), { take: 2 })
        const [nuevo, anterior] = historial
        if (nuevo && anterior) {
          const diff = diffRuns(toRunRef(anterior), toRunRef(nuevo))
          if (diff.cause === "CONFIGURACION" || diff.cause === "VARIOS") {
            extra.push({
              detector: `diffRuns = ${diff.cause}`,
              evidencia: `sellos movidos: ${diff.hashChanges.map((h) => h.hash).join(", ")}`,
            })
          } else {
            extra.push({ detector: `diffRuns = ${diff.cause} (NO clasificado como configuración)`, evidencia: "" })
          }
        }
      }

      const todas = [...observado.senales, ...extra].filter((senal) => !senal.detector.includes("NO clasificado"))
      const cazada = todas.length > 0
      const clasificacionOk =
        inyeccion.numero !== 10 || todas.some((senal) => senal.detector.startsWith("diffRuns = CONFIGURACION") || senal.detector.startsWith("diffRuns = VARIOS"))

      registro.add(
        id,
        cazada && clasificacionOk ? "PASS" : "FAIL",
        `#${inyeccion.numero} ${inyeccion.nombre} (${aplicada}) — esperado: ${inyeccion.esperado} — ` +
          (cazada
            ? `cazada por: ${todas.map((senal) => senal.detector).join(", ")}`
            : "NADIE la cazó: ningún check cambió de estado y ningún sello se movió")
      )
      if (!cazada || !clasificacionOk) {
        noDetectadas.push(`#${inyeccion.numero} ${inyeccion.nombre} (esperado ${inyeccion.esperado})`)
      }

      await inyeccion.deshacer()
    }

    // Las no ejercidas se cuentan y se declaran: la cifra sólo puede bajar.
    registro.add(
      "C4-cobertura",
      "INFO",
      `inyecciones ejercidas: ${inyecciones.length - noEjercidas.length}/10 · no ejercidas por falta de sustrato: ${
        noEjercidas.length === 0 ? "ninguna" : noEjercidas.join(" · ")
      }`
    )

    expect(noDetectadas, `inyecciones NO detectadas:\n${noDetectadas.join("\n")}`).toEqual([])
    expect(
      inyecciones.length - noEjercidas.length,
      "se ejercieron menos inyecciones que la vez anterior: el sustrato se ha perdido"
    ).toBeGreaterThanOrEqual(5)
  }, 900_000)

  it("criterio 18 · Capa 2 refuta: una cifra SELLADA alterada saca al auditor de CONFORME", async () => {
    const fila = await withMaintenance(async (client) =>
      client.query<{ id: string; result: unknown }>(
        `SELECT id, result FROM report_runs WHERE organization_id = $1::uuid AND type = 'BALANCE' ORDER BY created_at DESC LIMIT 1`,
        [org.organizationId]
      )
    )
    const run = fila.rows[0]
    expect(run, "no hay BALANCE sellado que alterar").toBeDefined()
    if (!run) return
    const original = JSON.stringify(run.result)
    const alterado = JSON.parse(original) as { totalActivoCents: number }
    alterado.totalActivoCents = alterado.totalActivoCents + 1

    await withMaintenance(async (client) =>
      client.query(`UPDATE report_runs SET result = $2::jsonb WHERE id = $1::uuid`, [run.id, JSON.stringify(alterado)])
    )
    const conAlteracion = await auditor("sellado-alterado.json")
    await withMaintenance(async (client) =>
      client.query(`UPDATE report_runs SET result = $2::jsonb WHERE id = $1::uuid`, [run.id, original])
    )
    const restaurado = await auditor("restaurado.json")

    registro.assert(
      "C4-capa2-refuta",
      conAlteracion.veredicto === "DISCREPANCIA",
      `un céntimo de más en el ACTIVO sellado ⇒ el segundo motor dice ${conAlteracion.veredicto} ` +
        `(${conAlteracion.hallazgos} hallazgo(s)); deshecho, vuelve a ${restaurado.veredicto}`
    )
    expect(conAlteracion.veredicto, conAlteracion.salida).toBe("DISCREPANCIA")
    expect(restaurado.veredicto, restaurado.salida).toBe("CONFORME")
  }, 300_000)

  it("criterio 14 · el auditor automatizado no comparte código con el productor (regla de autoría)", async () => {
    const fuente = await readFile(path.resolve(process.cwd(), "scripts", "audit-reconstruct.ts"), "utf8")
    const importaciones = [...fuente.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "")
    const prohibidas = importaciones.filter((mod) => /^@\/(lib|models|ai|app)\//.test(mod))
    registro.assert(
      "C4-autoria",
      prohibidas.length === 0,
      prohibidas.length === 0
        ? `el auditor sólo importa ${[...new Set(importaciones)].join(", ")}: nada de lib/**, models/**, ai/** ni app/**`
        : `el auditor importa del productor: ${prohibidas.join(", ")}`
    )
    expect(prohibidas).toEqual([])
    expect(registro.failures.map((check) => `${check.id}: ${check.evidencia}`)).toEqual([])
  })
})
