import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

/**
 * **C6 · Memoria y revisión humana** (E12 · T8 — §3.3 y criterios 23–26).
 *
 * El camino completo, de punta a punta y por las **acciones reales**:
 *
 *  23. ADMIN fuerza revisión con motivo y familia ⇒ el sello pasa a `REQUIERE
 *      REVISIÓN` **nombrando el motivo**, el informe emitido en ese estado lo
 *      lleva impreso, y al limpiarlo con `clearReason` el sello vuelve.
 *  24. `VIEWER` no puede forzar ni limpiar: `withOrg` corta **en el servidor** y
 *      no se escribe nada.
 *  25. `UPDATE`/`DELETE` sobre `audit_logs` ⇒ `42501`.
 *  26. Ninguna fila de memoria contiene una cifra de negocio **como verdad
 *      vigente**: el registro guarda el HECHO (`before`/`after` de la entidad que
 *      cambió) y nunca un saldo, un total ni un resultado calculado.
 *
 * Las acciones se ejercen con el usuario real detrás: `@/lib/auth` está mockeado
 * para poder cambiar de ADMIN a VIEWER, y **nada más** — la autorización, la
 * validación con zod, el modelo y la base son los del producto.
 */

const cookieStore = { get: () => undefined, set: () => {}, delete: () => {} }
vi.mock("next/headers", () => ({ cookies: async () => cookieStore }))
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }))
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("redirect")
  },
  notFound: () => {
    throw new Error("notFound")
  },
}))
vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => usuarioActual,
  getSession: async () => ({ user: usuarioActual }),
  isSubscriptionExpired: () => false,
  isAiBalanceExhausted: () => false,
}))

let usuarioActual: { id: string; email: string; name: string } = { id: "", email: "", name: "" }

const {
  ACCEPTANCE_GIT_SHA,
  PERIOD,
  REF_DATE,
  ValidacionRecorder,
  createAcceptanceOrg,
  disconnect,
  dropAcceptanceOrg,
  sqlErrorCode,
  withRuntime,
} = await import("@/tests/acceptance/harness")
type AcceptanceOrg = Awaited<ReturnType<typeof createAcceptanceOrg>>

const COMPONENTE = "c6"
const registro = new ValidacionRecorder(COMPONENTE)

const { prisma, tenantDb } = await import("@/lib/db")
const { getOrCreateReportRun, listManualReviewFlags } = await import("@/models/reports")
const { runLedgerInvariants } = await import("@/models/ledger")
const { latestInvariantRun } = await import("@/models/audit")
const { forceReviewAction, clearReviewAction } = await import("@/app/(app)/audit/actions")

/**
 * Claves que serían una **cifra de negocio como verdad vigente** si aparecieran
 * en la raíz de una fila de memoria. Dentro de `before`/`after` son legítimas:
 * ahí son la foto de lo que cambió, no una afirmación sobre el saldo de hoy.
 */
const CLAVES_DE_CIFRA = /^(saldo|total|resultado|balance|importe|cents|suma)/i

describe("C6 · la revisión humana de punta a punta y la memoria que no guarda cifras", () => {
  let org: AcceptanceOrg
  let viewerId = ""
  let invariantRunId = ""

  const informe = (noCache = true) =>
    getOrCreateReportRun(org.organizationId, {
      type: "PYG",
      periodStart: PERIOD.periodStart,
      periodEnd: PERIOD.periodEnd,
      fiscalYearId: org.fiscalYearId,
      params: { variant: "PYMES" },
      actor: { userId: org.userId },
      noCache,
    })

  beforeAll(async () => {
    org = await createAcceptanceOrg(COMPONENTE)
    registro.org(org.organizationId)
    usuarioActual = { id: org.userId, email: `acc-${COMPONENTE}@test.local`, name: "ADMIN de aceptación" }

    viewerId = org.userId.replace(/.$/, "9")
    await prisma.user.create({ data: { id: viewerId, email: `acc-${COMPONENTE}-viewer@test.local`, name: "Viewer" } })
    await prisma.membership.create({
      data: { organizationId: org.organizationId, userId: viewerId, role: "VIEWER", acceptedAt: new Date(), updatedAt: new Date() },
    })

    const barrido = await runLedgerInvariants(org.organizationId, {
      refDate: REF_DATE,
      fiscalYearId: org.fiscalYearId,
      gitSha: ACCEPTANCE_GIT_SHA,
      noCache: true,
      actor: { userId: org.userId },
      persist: { trigger: "MANUAL", scopeKind: "FISCAL_YEAR", runById: org.userId },
    })
    registro.seal(barrido.sello.sello, barrido.sello.motivos)
    const fila = await latestInvariantRun(tenantDb(org.organizationId))
    invariantRunId = fila?.id ?? ""
  })

  afterAll(async () => {
    await registro.write()
    await prisma.membership.deleteMany({ where: { organizationId: org.organizationId, userId: viewerId } }).catch(() => undefined)
    await dropAcceptanceOrg(org)
    await prisma.user.deleteMany({ where: { id: viewerId } }).catch(() => undefined)
    await disconnect()
  })

  it("criterio 23 · forzar → el sello nombra el motivo en el informe emitido → limpiar → vuelve", async () => {
    const antes = await informe()
    registro.hash(antes.ledgerHash)
    registro.assert(
      "C6-1",
      !antes.sealReasons.some((reason) => reason.code === "REVISION_FORZADA"),
      `antes de forzar, el informe no lleva REVISION_FORZADA (sello ${antes.seal})`
    )

    const MOTIVO = "el asesor tiene que revisar la periodificación de diciembre antes de firmar"
    usuarioActual = { id: org.userId, email: `acc-${COMPONENTE}@test.local`, name: "ADMIN de aceptación" }
    const forzado = await forceReviewAction({
      periodStart: PERIOD.periodStart,
      periodEnd: PERIOD.periodEnd,
      scope: null,
      reason: MOTIVO,
      invariantRunId,
      checkFamily: "CIERRE",
    })
    expect(forzado.success, JSON.stringify(forzado)).toBe(true)
    if (!forzado.success) return

    const flag = (await listManualReviewFlags(tenantDb(org.organizationId), { activeOnly: true }))[0]
    registro.assert(
      "C6-2",
      flag?.invariantRunId === invariantRunId && flag?.checkFamily === "CIERRE",
      `el aviso queda con su barrido (${flag?.invariantRunId}) y su familia ENUM (${flag?.checkFamily})`
    )

    const conRevision = await informe()
    const motivoImpreso = conRevision.sealReasons.find((reason) => reason.code === "REVISION_FORZADA")
    registro.assert(
      "C6-3",
      conRevision.seal === "REQUIERE_REVISION" && motivoImpreso !== undefined && motivoImpreso.message.includes(MOTIVO),
      `el informe emitido sale ${conRevision.seal} con el motivo impreso: «${motivoImpreso?.message ?? "—"}»`
    )

    const limpiado = await clearReviewAction({ id: forzado.data.id, reason: "revisado con el asesor el 15 de enero" })
    expect(limpiado.success, JSON.stringify(limpiado)).toBe(true)

    const despues = await informe()
    const vuelve = !despues.sealReasons.some((reason) => reason.code === "REVISION_FORZADA")
    registro.assert("C6-4", vuelve, `tras limpiar con motivo, el informe vuelve a ${despues.seal} sin REVISION_FORZADA`)

    // El aviso NO se borra: se marca, con autor y motivo. La historia se queda.
    const todos = await listManualReviewFlags(tenantDb(org.organizationId), {})
    const marcado = todos.find((f) => f.id === forzado.data.id)
    registro.assert(
      "C6-5",
      marcado?.clearedAt !== null && marcado?.clearReason === "revisado con el asesor el 15 de enero",
      `el aviso ${forzado.data.id} sigue en la base, marcado como levantado y con su motivo`
    )

    expect(conRevision.seal).toBe("REQUIERE_REVISION")
    expect(motivoImpreso?.message).toContain(MOTIVO)
    expect(vuelve).toBe(true)
    expect(marcado?.clearedAt).not.toBeNull()
  })

  it("criterio 24 · un VIEWER no puede forzar ni limpiar, y no se escribe nada", async () => {
    const antes = await listManualReviewFlags(tenantDb(org.organizationId), {})
    usuarioActual = { id: viewerId, email: `acc-${COMPONENTE}-viewer@test.local`, name: "Viewer" }

    const forzado = await forceReviewAction({
      periodStart: PERIOD.periodStart,
      periodEnd: PERIOD.periodEnd,
      scope: null,
      reason: "un viewer intentando forzar la revisión del ejercicio",
    })
    const limpiado = await clearReviewAction({ id: antes[0]?.id ?? "00000000-0000-4000-8000-000000000000", reason: "un viewer intentando levantarla" })
    usuarioActual = { id: org.userId, email: `acc-${COMPONENTE}@test.local`, name: "ADMIN de aceptación" }

    const despues = await listManualReviewFlags(tenantDb(org.organizationId), {})
    const rechazado = forzado.success === false && limpiado.success === false
    registro.assert(
      "C6-6",
      rechazado && despues.length === antes.length,
      `el VIEWER recibe «${forzado.success === false ? forzado.error : "¡permitido!"}» y los avisos siguen siendo ${despues.length}`
    )
    expect(forzado.success).toBe(false)
    expect(limpiado.success).toBe(false)
    expect(despues.length).toBe(antes.length)
  })

  it("criterio 25 · `audit_logs` es append-only: UPDATE y DELETE como `app_runtime` ⇒ 42501", async () => {
    const fila = await prisma.auditLog.findFirst({ where: { organizationId: org.organizationId }, orderBy: { ts: "desc" } })
    expect(fila, "no hay ni una fila de memoria que proteger: el criterio pasaría por vacuidad").not.toBeNull()
    if (!fila) return

    const update = await withRuntime(org.organizationId, (client) =>
      sqlErrorCode(() => client.query(`UPDATE audit_logs SET reason = 'reescrito' WHERE id = $1::uuid`, [fila.id]))
    )
    const del = await withRuntime(org.organizationId, (client) =>
      sqlErrorCode(() => client.query(`DELETE FROM audit_logs WHERE id = $1::uuid`, [fila.id]))
    )
    const intacta = await prisma.auditLog.findFirst({ where: { id: fila.id } })

    registro.assert("C6-7", update === "42501", `UPDATE sobre audit_logs como app_runtime devolvió ${update}`)
    registro.assert("C6-8", del === "42501", `DELETE sobre audit_logs como app_runtime devolvió ${del}`)
    registro.assert("C6-9", intacta?.reason === fila.reason, `la fila ${fila.id} conserva su motivo original`)

    expect(update).toBe("42501")
    expect(del).toBe("42501")
    expect(intacta?.reason).toBe(fila.reason)
  })

  it("criterio 26 · ninguna fila de memoria guarda una cifra de negocio como verdad vigente", async () => {
    const filas = await prisma.auditLog.findMany({ where: { organizationId: org.organizationId }, take: 500 })
    expect(filas.length, "la organización no tiene memoria escrita: el criterio pasaría por vacuidad").toBeGreaterThan(0)

    const sospechosas: string[] = []
    for (const fila of filas) {
      // La memoria guarda QUÉ cambió (`before`/`after`, la foto de la entidad) y
      // POR QUÉ (`reason`). Una cifra suelta en la raíz sería el sistema
      // «recordando» un saldo en vez de recalcularlo desde el diario (P4).
      for (const campo of ["before", "after"] as const) {
        const valor = fila[campo]
        if (valor === null || typeof valor !== "object" || Array.isArray(valor)) continue
        const entidad = valor as Record<string, unknown>
        // Lo que NO puede haber es una cifra DERIVADA: un saldo, un total, un
        // resultado. Los importes propios de la entidad (`debitCents` de una
        // línea, `amountCents` de un parte) son el hecho, no un derivado.
        for (const clave of Object.keys(entidad)) {
          if (/^(saldo|total|resultado|balance)[A-Za-z]*$/i.test(clave)) {
            sospechosas.push(`${fila.entity}#${fila.entityId}.${campo}.${clave}`)
          }
        }
      }
      if (fila.reason && CLAVES_DE_CIFRA.test(fila.reason) && /\d{4,}/.test(fila.reason)) {
        sospechosas.push(`${fila.entity}#${fila.entityId}.reason parece una cifra: «${fila.reason.slice(0, 60)}»`)
      }
    }

    registro.assert(
      "C6-10",
      sospechosas.length === 0,
      sospechosas.length === 0
        ? `${filas.length} filas de memoria: ninguna guarda un saldo, un total ni un resultado como verdad vigente`
        : `filas con cifra derivada: ${sospechosas.slice(0, 10).join(" · ")}`
    )
    expect(sospechosas, sospechosas.join("\n")).toEqual([])
    expect(registro.failures.map((check) => `${check.id}: ${check.evidencia}`)).toEqual([])
  })
})
