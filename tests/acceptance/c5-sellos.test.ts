import { readFile } from "node:fs/promises"
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
 * **C5 · Niveles de confianza y sellos** (E12 · T7 — §3.3 y criterios 19–22).
 *
 *  19. **Cero celdas de informe sin etiqueta** de confianza.
 *  20. El badge `✓ validado contra fuente` se concede **por composición** y se
 *      **retira** cuando llega un dato nuevo: un extracto de febrero con un
 *      movimiento de diciembre retira el badge de diciembre.
 *  21. **Vocabulario cerrado**: ningún motivo de sello emitido que la skill no
 *      declare, y ninguno declarado que nadie emita.
 *  22. Una familia cuyo bloque de entrada no se compone sale `SIN_EVALUAR` y el
 *      periodo sale `REQUIERE REVISIÓN`; **nunca** PASS.
 */

const COMPONENTE = "c5"
const registro = new ValidacionRecorder(COMPONENTE)
const SKILL = path.resolve(process.cwd(), ".claude", "skills", "fiabilidad", "SKILL.md")

const { tenantTransaction } = await import("@/lib/db")
const { getOrCreateReportRun } = await import("@/models/reports")
const { getAnalyticPnl } = await import("@/models/margins")
const { runLedgerInvariants } = await import("@/models/ledger")
const { badgeForFigure } = await import("@/lib/audit/confidence")
const { groupByFamily, familyStatus, CHECK_FAMILIES } = await import("@/lib/audit/families")
const { E7_SEAL_REASONS } = await import("@/lib/audit/run")
const { E8_SEAL_REASONS } = await import("@/lib/ledger/invariants")
const { E9_SEAL_REASONS } = await import("@/lib/closing/invariants-e9")
const { E10_SEAL_REASONS } = await import("@/lib/budget/invariants-e10")
const { E11_SEAL_REASONS } = await import("@/lib/ledger/invariants-e11")

/** Los cuatro niveles de confianza que el producto puede poner en una celda. */
const ETIQUETAS = new Set(["calculado", "comprobado", "validado", "interpretacion_ia", "no_verificado"])

type Provenance = { valor: number; confianza?: string; registros_origen: string; parametros: unknown[] }
type Fila = { path: string; cents: number; isLeaf: boolean; isComputed: boolean; provenance?: Provenance; children?: Fila[] }
const hojas = (rows: readonly Fila[]): Fila[] => rows.flatMap((row) => (row.children?.length ? hojas(row.children) : [row]))

/**
 * **Divergencias entre el vocabulario del código y el de la skill: NINGUNA.**
 *
 * La ola A de E12 encontró once (ocho motivos emitidos y no declarados, tres
 * declarados sin emisor) y las congeló aquí con dueño: **T23**. T23 las cerró en
 * `.claude/skills/fiabilidad/SKILL.md` —los cinco del cierre que faltaban y los
 * tres del camino documental, y los tres «declarados sin emisor» resultaron no
 * ser motivos de sello sino avisos de calidad (`DataQualityWarning`), que ahora
 * viven en su propia tabla, fuera del vocabulario cerrado—.
 *
 * La lista se queda **vacía a propósito**, no se borra: es la forma de que el
 * test siga siendo exacto. Aparece una divergencia nueva ⇒ rojo. Y si alguien
 * vuelve a «resolverla» metiéndola aquí en vez de en la skill, el diff lo canta.
 */
const DIVERGENCIAS_T23 = {
  /** Códigos que el motor emite y la tabla de la skill no declara. */
  emitidosSinDeclarar: [] as readonly string[],
  /** Códigos que la tabla declara y que ningún motor emite como motivo de sello. */
  declaradosSinEmitir: [] as readonly string[],
} as const

/** Códigos de motivo declarados en las tablas «Motivos de sello …» de la skill. */
function motivosDeclarados(skill: string): Set<string> {
  const codigos = new Set<string>()
  const lineas = skill.split(/\r?\n/)
  let dentro = false
  for (const linea of lineas) {
    if (/^#{2,4}\s/.test(linea)) dentro = /Motivos de sello/i.test(linea)
    if (!dentro) continue
    const celda = /^\|\s*`([A-Z][A-Z0-9_]{4,})`\s*\|/.exec(linea)
    if (celda?.[1]) codigos.add(celda[1])
  }
  return codigos
}

describe("C5 · etiquetas de confianza, badges por composición y vocabulario cerrado de motivos", () => {
  let org: AcceptanceOrg

  beforeAll(async () => {
    org = await createAcceptanceOrg(COMPONENTE)
    registro.org(org.organizationId)
  })

  afterAll(async () => {
    await registro.write()
    await dropAcceptanceOrg(org)
    await disconnect()
  })

  it("criterio 19 · cero celdas sin etiqueta de confianza en los informes y en la matriz", async () => {
    const emitir = (type: "BALANCE" | "PYG", params: Record<string, unknown>) =>
      getOrCreateReportRun(org.organizationId, {
        type,
        periodStart: PERIOD.periodStart,
        periodEnd: PERIOD.periodEnd,
        fiscalYearId: org.fiscalYearId,
        params,
        actor: { userId: org.userId },
      })

    const balance = await emitir("BALANCE", { snapshot: "PRE_REGULARIZACION", variant: "PYMES" })
    const pyg = await emitir("PYG", { variant: "PYMES" })
    registro.hash(balance.ledgerHash)

    const sinEtiqueta: string[] = []
    let etiquetadas = 0
    const revisar = (nombre: string, filas: readonly Fila[]) => {
      for (const fila of hojas(filas).filter((f) => f.isLeaf && !f.isComputed)) {
        const etiqueta = fila.provenance?.confianza
        if (etiqueta === undefined || !ETIQUETAS.has(etiqueta)) sinEtiqueta.push(`${nombre} · ${fila.path}: ${etiqueta ?? "sin etiqueta"}`)
        else etiquetadas++
      }
    }
    const bal = balance.result as { activo: Fila[]; patrimonioNeto: Fila[]; pasivo: Fila[] }
    revisar("balance/activo", bal.activo)
    revisar("balance/pn", bal.patrimonioNeto)
    revisar("balance/pasivo", bal.pasivo)
    revisar("pyg", (pyg.result as { lines: Fila[] }).lines)

    const pnl = await tenantTransaction(org.organizationId, org.userId, async (tx) =>
      getAnalyticPnl(tx, {
        ...RANGE,
        fiscalYearId: org.fiscalYearId,
        provenance: { runId: "c5", gitSha: ACCEPTANCE_GIT_SHA, baseCurrency: BASE_CURRENCY },
      })
    )
    for (const [clave, prov] of pnl.pnl.provenance.entries()) {
      const etiqueta = (prov as Provenance).confianza
      if (etiqueta === undefined || !ETIQUETAS.has(etiqueta)) sinEtiqueta.push(`matriz · ${clave}`)
      else etiquetadas++
    }

    registro.assert(
      "C5-1",
      sinEtiqueta.length === 0,
      sinEtiqueta.length === 0
        ? `${etiquetadas} celdas de informe y de matriz, todas con etiqueta de confianza`
        : `celdas sin etiqueta: ${sinEtiqueta.slice(0, 10).join(" · ")}`
    )
    expect(etiquetadas, "no se inspeccionó ni una celda: el criterio pasaría por vacuidad").toBeGreaterThan(50)
    expect(sinEtiqueta, sinEtiqueta.join("\n")).toEqual([])
  })

  it("criterio 20 · el badge se concede por COMPOSICIÓN y un extracto de febrero retira el de diciembre", () => {
    const cuenta = {
      id: "cuenta-1",
      organizationId: org.organizationId,
      code: "BANCO-1",
      accountCode: "572",
      currency: BASE_CURRENCY,
      reconciledFromDate: "2026-01-01" as const,
      reconciledOpeningBalanceCents: 0,
      matchToleranceDays: 3,
      transitWarnDays: 10,
    }
    const cuadre = (pendientesBanco: readonly unknown[], resolvedLaterIds: readonly string[] = []) => ({
      bankAccountId: cuenta.id,
      accountCode: "572",
      currency: BASE_CURRENCY,
      cutoff: "2026-12-31" as const,
      anchored: true,
      chain: { covered: true, gaps: [], contradictoryOverlaps: [], anchored: true },
      saldoExtracto: 0,
      saldoContable: 0,
      ue: 0,
      ub: 0,
      diferencia: 0,
      pendientesBanco,
      pendientesLibros: [],
      ignoradosCents: 0,
      ignoradosCount: 0,
      importeCeroCount: 0,
      pendientesAntiguos: [],
      regularizationLineIds: [],
      evaluable: true,
      motivoNoEvaluable: null,
      moneda: BASE_CURRENCY,
      enDivisa: false,
      fxDifferenceCents: null,
      divisaCompleta: true,
      resolvedLaterIds,
    })

    // (a) Composición limpia: todas las cuentas conciliadas, sin pendientes.
    const limpio = badgeForFigure({
      accountCodes: ["572"],
      bankAccounts: [cuenta],
      summaries: [cuadre([])],
      invariantsPass: true,
    })
    registro.assert("C5-2", limpio.badge === "validado", `composición limpia ⇒ badge \`${limpio.badge}\``)

    // (b) Llega el extracto de FEBRERO con un movimiento de DICIEMBRE: aparece un
    //     pendiente de diciembre sin tipar, de 62 días. El badge de diciembre
    //     **se retira** —el badge se deriva en lectura y no se persiste jamás—.
    const pendienteDeDiciembre = {
      side: "BANCO" as const,
      id: "mov-dic-2026",
      date: "2026-12-20" as const,
      amountCents: 150_000,
      kind: null,
      ageDays: 62,
      description: "cargo de diciembre que el banco trae en el extracto de febrero",
    }
    const conDatoNuevo = badgeForFigure({
      accountCodes: ["572"],
      bankAccounts: [cuenta],
      summaries: [cuadre([pendienteDeDiciembre])],
      invariantsPass: true,
    })
    const retirado = conDatoNuevo.badge !== "validado" && conDatoNuevo.pendientesSinExplicar.length === 1
    registro.assert(
      "C5-3",
      retirado,
      `el movimiento de diciembre que llega en febrero retira el badge: \`${conDatoNuevo.badge}\` — ${conDatoNuevo.motivos.join("; ")}`
    )

    // (c) Y cuando ese pendiente queda recogido por la conciliación posterior,
    //     el badge vuelve solo: no hay estado persistido que haya que limpiar.
    const recogido = badgeForFigure({
      accountCodes: ["572"],
      bankAccounts: [cuenta],
      summaries: [cuadre([pendienteDeDiciembre], [pendienteDeDiciembre.id])],
      invariantsPass: true,
    })
    registro.assert("C5-4", recogido.badge === "validado", `recogido por la conciliación posterior ⇒ badge \`${recogido.badge}\``)

    // (d) La caja NO tiene extracto: una cifra que la incluye no puede llevar el
    //     badge más fuerte, y el motivo lo dice (consecuencia declarada en §C5).
    const conCaja = badgeForFigure({
      accountCodes: ["572", "570"],
      bankAccounts: [cuenta],
      summaries: [cuadre([])],
      invariantsPass: true,
    })
    registro.assert(
      "C5-5",
      conCaja.badge !== "validado" && conCaja.cuentasSinFuente.includes("570"),
      `la tesorería con caja sale \`${conCaja.badge}\`: ${conCaja.motivos[0]}`
    )

    // (e) Sin invariantes en PASS no hay badge, por muy conciliada que esté.
    const sinInvariantes = badgeForFigure({
      accountCodes: ["572"],
      bankAccounts: [cuenta],
      summaries: [cuadre([])],
      invariantsPass: false,
    })
    registro.assert("C5-6", sinInvariantes.badge === "calculado", `sin invariantes en PASS ⇒ \`${sinInvariantes.badge}\``)

    expect(limpio.badge).toBe("validado")
    expect(retirado, "el dato nuevo no retiró el badge ya concedido").toBe(true)
    expect(recogido.badge).toBe("validado")
    expect(conCaja.badge).not.toBe("validado")
    expect(sinInvariantes.badge).toBe("calculado")
  })

  it("criterio 21 · vocabulario CERRADO: lo que el motor emite y lo que la skill declara coinciden", async () => {
    const skill = await readFile(SKILL, "utf8")
    const declarados = motivosDeclarados(skill)
    const enCodigo = new Set<string>([
      ...E7_SEAL_REASONS,
      ...E8_SEAL_REASONS,
      ...E9_SEAL_REASONS,
      ...E10_SEAL_REASONS,
      ...E11_SEAL_REASONS,
    ])

    expect(declarados.size, "la skill no declara ni un motivo: el criterio pasaría por vacuidad").toBeGreaterThan(15)
    expect(enCodigo.size).toBeGreaterThan(20)

    const emitidosSinDeclarar = [...enCodigo].filter((code) => !declarados.has(code)).sort()
    const declaradosSinEmitir = [...declarados].filter((code) => !enCodigo.has(code)).sort()

    registro.add(
      "C5-7",
      emitidosSinDeclarar.length === 0 ? "PASS" : "WARN",
      emitidosSinDeclarar.length === 0
        ? `los ${enCodigo.size} motivos que el motor emite están declarados en la skill`
        : `motivos emitidos y NO declarados (hallazgo para T23): ${emitidosSinDeclarar.join(", ")}`
    )
    registro.add(
      "C5-8",
      declaradosSinEmitir.length === 0 ? "PASS" : "WARN",
      declaradosSinEmitir.length === 0
        ? "ningún motivo declarado se queda sin emisor"
        : `motivos declarados que nadie emite (hallazgo para T23): ${declaradosSinEmitir.join(", ")}`
    )

    // La comparación es EXACTA contra la lista de divergencias conocidas: una
    // nueva es roja, y arreglar una sin vaciar la lista también.
    expect(emitidosSinDeclarar, "el conjunto de motivos emitidos-sin-declarar cambió: actualiza DIVERGENCIAS_T23").toEqual(
      [...DIVERGENCIAS_T23.emitidosSinDeclarar].sort()
    )
    expect(declaradosSinEmitir, "el conjunto de motivos declarados-sin-emitir cambió: actualiza DIVERGENCIAS_T23").toEqual(
      [...DIVERGENCIAS_T23.declaradosSinEmitir].sort()
    )
  })

  it("criterio 22 · una familia sin componer sale SIN_EVALUAR, jamás en verde, y mueve el sello", async () => {
    const run = await runLedgerInvariants(org.organizationId, {
      refDate: REF_DATE,
      fiscalYearId: org.fiscalYearId,
      gitSha: ACCEPTANCE_GIT_SHA,
      noCache: true,
      actor: { userId: org.userId },
      persist: { trigger: "MANUAL", scopeKind: "FISCAL_YEAR", runById: org.userId },
    })
    registro.seal(run.sello.sello, run.sello.motivos)

    const familias = groupByFamily(run.validacion.checks)
    // Las diez familias se IMPRIMEN siempre, con o sin checks.
    registro.assert(
      "C5-9",
      familias.length === CHECK_FAMILIES.length,
      `el barrido compone las ${familias.length} familias de \`lib/audit/families.ts\``
    )

    const enVerdeSinChecks = familias.filter((familia) => familia.checkIds.length === 0 && familia.status === "OK")
    registro.assert(
      "C5-10",
      enVerdeSinChecks.length === 0,
      enVerdeSinChecks.length === 0
        ? "ninguna familia sin checks sale en verde"
        : `familias vacías en PASS: ${enVerdeSinChecks.map((f) => f.family).join(", ")}`
    )

    const sinEvaluar = familias.filter((familia) => familia.status === "SIN_EVALUAR")
    const selloCoherente = sinEvaluar.length === 0 || !run.sello.sello.startsWith("VALIDADO")
    registro.assert(
      "C5-11",
      selloCoherente,
      sinEvaluar.length === 0
        ? `las ${familias.length} familias están evaluadas y el periodo sale «${run.sello.sello}»`
        : `familias SIN_EVALUAR (${sinEvaluar.map((f) => f.family).join(", ")}) con sello «${run.sello.sello}»`
    )

    // Y la prueba negativa, que es la que hace que esto no pase por vacuidad:
    // una familia sin un solo check NUNCA puede salir PASS.
    registro.assert("C5-12", familyStatus([]) === "SIN_EVALUAR", `familyStatus([]) = ${familyStatus([])}`)

    expect(familias.length).toBe(CHECK_FAMILIES.length)
    expect(enVerdeSinChecks.map((f) => f.family)).toEqual([])
    expect(selloCoherente, "hay familias sin evaluar y el periodo se firmó como validado").toBe(true)
    expect(familyStatus([])).toBe("SIN_EVALUAR")
    expect(registro.failures.map((check) => `${check.id}: ${check.evidencia}`)).toEqual([])
  })
})
