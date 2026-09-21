/**
 * E12 · ronda 1 (auditor H-1) — **carga del sustrato documental mínimo**.
 *
 * El fixture lo declara Python (`docs/design/fixtures/build_documental_minimo.py`,
 * con `--check` en el job 7 de CI); esto lo **carga por los caminos del
 * producto**, no por `INSERT` de arnés: `putObject`, `createFile`,
 * `createExtractionRun`, `createEmployeeTx`, `createTimeEntriesTx`,
 * `sealAllocationRunTx`, `getUsage` y `createVatSettlementTx`. Un sustrato
 * sembrado por SQL probaría el arnés (lección H-6 de E8) y, peor, podría
 * sembrar algo que el producto nunca produciría.
 *
 * ## La regla que no se rompe: el diario no se toca
 *
 * Las doce cifras canónicas y los cinco sellos del fixture `ejercicio-completo`
 * tienen que seguir siendo **exactamente los mismos** con esto cargado. Por eso:
 *
 *  · los dos documentos y sus extracciones **no se contabilizan**: quedan en la
 *    bandeja, que es donde un documento sin revisar tiene que estar;
 *  · la liquidación de IVA **no postea su asiento**: el fixture ya trae
 *    `IVA-Q1` (`REGULARIZACION_IVA`, 2026-03-31) contabilizado, y lo que falta
 *    es la fila de `vat_settlements` que lo sella. Se crea apuntando a ese
 *    asiento, con las cifras que el motor lee del libro registro.
 *
 * El único efecto sobre la analítica es el reparto (`allocation_runs`), que es
 * justo lo que la inyección #4 necesita; el test que lo carga comprueba después
 * que las doce cifras no se han movido.
 *
 * ## Por qué los bytes se escriben en los DOS sitios
 *
 * El producto lee los documentos del **almacén de objetos** (`readDocumentBytes`
 * → `putObject`), pero el lector que `runLedgerInvariants` recibe hoy en la
 * suite y en `scripts/run-invariants.ts` es `sha256OfStoredFile`, que lee del
 * **disco heredado** (`UPLOAD_PATH`). Los mismos bytes van a los dos, de modo
 * que I-E11-6 (almacén) e I-E8-2 (disco) tengan los dos algo que mirar y las
 * dos inyecciones muerdan. No es una doble escritura de producto: es un
 * sustrato de prueba que cubre los dos lectores que hoy existen.
 */

import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { readFileSync } from "node:fs"

import { tenantDb, tenantTransaction, type TenantTransactionClient } from "@/lib/db"
import { storedFilePath } from "@/lib/files-integrity"
import { canonicalJson } from "@/lib/extraction/hash"
import type { ExtractionProposal } from "@/lib/extraction/types"
import { unsortedFilePath } from "@/lib/files"
import { vatPeriodBounds, vatRegimeAt, type VatBookRowE9 } from "@/lib/closing/vat"
import type { LocalDate } from "@/lib/ledger/types"
import { createExtractionRun } from "@/models/extraction"
import { createFile } from "@/models/files"
import { putObject } from "@/models/storage"
import { createEmployeeRateTx, createEmployeeTx } from "@/models/employees"
import { createTimeEntriesTx, approveTimeEntriesTx } from "@/models/time"
import { createAllocationRuleTx, sealAllocationRunTx } from "@/models/allocations"
import { getUsage } from "@/models/usage"
import { computeLedgerHash } from "@/models/ledger"
import { createVatSettlementTx, readVatBook, readVatRegimePeriods } from "@/models/vat"

export type DocumentalFixture = {
  schemaVersion: string
  fiscalYear: string
  documentos: { ref: string; filename: string; mimetype: string; contenido: string; sha256: string; sizeBytes: number }[]
  extracciones: {
    documento: string
    kind: "LLM" | "MANUAL" | "IMPORTED"
    provider: string
    model: string
    promptCode: string
    promptSource: "GIT" | "ORG"
    prompt: string
    promptSha: string
    schemaVersion: string
    schema: unknown
    schemaSha: string
    proposal: ExtractionProposal
    proposalSha: string
    pagesSent: number
    pagesTotal: number
  }[]
  empleado: {
    code: string
    name: string
    hireDate: LocalDate
    rate: { validFrom: LocalDate; basis: string; costCentsPerHour: number }
  }
  partes: { date: LocalDate; projectCode: string; minutes: number }[]
  reglaImputacion: Record<string, unknown> & { code: string; sourceCostCenterCode: string }
  uso: { periodMonth: string }
  liquidacionIva: { periodKind: string; period: string; periodStart: LocalDate; periodEnd: LocalDate }
  esperado: Record<string, number>
}

export const DOCUMENTAL_MINIMO_PATH = "tests/fixtures/documental-minimo.json"

export function readDocumentalFixture(): DocumentalFixture {
  return JSON.parse(readFileSync(path.resolve(DOCUMENTAL_MINIMO_PATH), "utf8")) as DocumentalFixture
}

export type DocumentalReport = {
  fileIds: string[]
  runIds: string[]
  timeEntryIds: string[]
  allocationRunId: string | null
  allocationLines: number
  usageRunSourceHash: string
  vatSettlementPeriod: string | null
  /** Discrepancias entre lo que el fixture declara y lo que el producto calcula. */
  mismatches: string[]
}

const sha256Hex = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex")

/**
 * Carga el sustrato en una organización que YA tiene el fixture
 * `ejercicio-completo`. Idempotente por documento y por regla: si ya está, no
 * duplica.
 */
export async function loadDocumentalMinimo(opts: {
  organizationId: string
  userId: string
  gitSha: string
  /** «Hoy» del sustrato. Nunca se lee el reloj. */
  refDate: LocalDate
}): Promise<DocumentalReport> {
  const fixture = readDocumentalFixture()
  const { organizationId, userId, gitSha, refDate } = opts
  const actor = { userId }
  const db = tenantDb(organizationId)
  const mismatches: string[] = []
  const report: DocumentalReport = {
    fileIds: [],
    runIds: [],
    timeEntryIds: [],
    allocationRunId: null,
    allocationLines: 0,
    usageRunSourceHash: "",
    vatSettlementPeriod: null,
    mismatches,
  }

  // ── 1 · Los documentos: bytes al almacén, al disco y su fila ───────────────
  const fileIdByRef = new Map<string, string>()
  for (const doc of fixture.documentos) {
    const bytes = Buffer.from(doc.contenido, "utf8")
    const sha256 = sha256Hex(bytes)
    if (sha256 !== doc.sha256) {
      mismatches.push(`${doc.ref}: el sha256 de los bytes (${sha256.slice(0, 12)}) no es el declarado (${doc.sha256.slice(0, 12)})`)
    }
    if (bytes.length !== doc.sizeBytes) {
      mismatches.push(`${doc.ref}: ${bytes.length} B y el fixture declara ${doc.sizeBytes} B`)
    }

    const existing = await db.file.findFirst({ where: { filename: doc.filename } })
    let fileId = existing?.id ?? null
    if (!fileId) {
      const relativePath = unsortedFilePath(crypto.randomUUID(), doc.filename)
      await putObject(db, {
        organizationId,
        kind: "DOCUMENT",
        sha256,
        mimeType: doc.mimetype,
        body: bytes,
      })
      const full = storedFilePath(organizationId, relativePath)
      await mkdir(path.dirname(full), { recursive: true })
      await writeFile(full, bytes)
      const created = await createFile(db, {
        organizationId,
        filename: doc.filename,
        path: relativePath,
        mimetype: doc.mimetype,
        sha256,
        sizeBytes: bytes.length,
        isReviewed: false,
        metadata: { size: bytes.length, source: "documental-minimo" },
      })
      fileId = created.id
    }
    fileIdByRef.set(doc.ref, fileId)
    report.fileIds.push(fileId)
  }

  // ── 2 · Las extracciones, con su propuesta y sus tres sellos ──────────────
  for (const extraccion of fixture.extracciones) {
    const fileId = fileIdByRef.get(extraccion.documento)
    if (!fileId) throw new Error(`la extracción apunta al documento ${extraccion.documento}, que no se ha cargado`)
    const doc = fixture.documentos.find((d) => d.ref === extraccion.documento)!

    const yaEsta = await db.extractionRun.findFirst({ where: { fileId } })
    if (yaEsta) {
      report.runIds.push(yaEsta.id)
      continue
    }
    const run = await createExtractionRun(db, {
      fileId,
      fileSha256: doc.sha256,
      kind: extraccion.kind,
      provider: extraccion.provider,
      model: extraccion.model,
      promptCode: extraccion.promptCode,
      promptSource: extraccion.promptSource,
      promptSha: extraccion.promptSha,
      schemaVersion: extraccion.schemaVersion,
      schemaSha: extraccion.schemaSha,
      pagesSent: extraccion.pagesSent,
      pagesTotal: extraccion.pagesTotal,
      rawOutput: { fixture: "documental-minimo", documento: extraccion.documento },
      proposal: extraccion.proposal,
      durationMs: 0,
      createdById: userId,
    })
    /**
     * **El tercer camino.** El `proposalSha` lo calcula el producto con
     * `canonicalJson` de ADR-0011; el fixture lo calcula Python con la misma
     * regla reimplementada. Si no coinciden, una de las dos se ha movido, y se
     * dice aquí en vez de descubrirlo tres épicas después.
     */
    if (run.proposalSha !== extraccion.proposalSha) {
      mismatches.push(
        `${extraccion.documento}: proposalSha del producto ${run.proposalSha?.slice(0, 12)} ≠ ` +
          `${extraccion.proposalSha.slice(0, 12)} del fixture (forma canónica de ADR-0011: ` +
          `${canonicalJson(extraccion.proposal).slice(0, 60)}…)`
      )
    }
    report.runIds.push(run.id)
  }

  // ── 3 · Empleado, tarifa y partes de horas (la base del driver HOURS) ─────
  await tenantTransaction(organizationId, userId, async (tx: TenantTransactionClient) => {
    const ya = await tx.employee.findFirst({ where: { code: fixture.empleado.code }, select: { id: true } })
    const employeeId =
      ya?.id ??
      (
        await createEmployeeTx(
          tx,
          { code: fixture.empleado.code, name: fixture.empleado.name, hireDate: fixture.empleado.hireDate },
          actor
        )
      ).id
    if (!ya) {
      await createEmployeeRateTx(
        tx,
        {
          employeeId,
          hourlyCostCents: fixture.empleado.rate.costCentsPerHour,
          basis: fixture.empleado.rate.basis as never,
          validFrom: fixture.empleado.rate.validFrom,
        },
        actor
      )
    }

    const yaHayPartes = await tx.timeEntry.count()
    if (yaHayPartes === 0) {
      const proyectos = await tx.project.findMany({ select: { id: true, code: true } })
      const idByCode = new Map(proyectos.map((p) => [p.code, p.id]))
      const filas = fixture.partes.map((parte) => {
        const projectId = idByCode.get(parte.projectCode)
        if (!projectId) throw new Error(`el parte apunta al proyecto ${parte.projectCode}, que el fixture no trae`)
        return { employeeId, date: parte.date, projectId, minutes: parte.minutes }
      })
      const created = await createTimeEntriesTx(tx, filas, actor)
      report.timeEntryIds = created.ids
      await approveTimeEntriesTx(
        tx,
        { ids: created.ids, approvedAt: new Date(`${refDate}T00:00:00.000Z`), actorIsAdmin: true },
        actor
      )
    }
  })

  // ── 4 · La regla de imputación y el reparto sellado ───────────────────────
  await tenantTransaction(organizationId, userId, async (tx: TenantTransactionClient) => {
    const regla = fixture.reglaImputacion
    const yaExiste = await tx.allocationRule.findFirst({ where: { code: regla.code }, select: { id: true } })
    if (!yaExiste) {
      const ceco = await tx.costCenter.findFirst({
        where: { code: regla.sourceCostCenterCode },
        select: { id: true },
      })
      if (!ceco) throw new Error(`la regla nombra el CECO ${regla.sourceCostCenterCode}, que el fixture no trae`)
      await createAllocationRuleTx(
        tx,
        {
          code: regla.code,
          name: regla.name,
          sourceCostCenterId: ceco.id,
          targetKind: regla.targetKind,
          driver: regla.driver,
          period: regla.period,
          priority: regla.priority,
          sourceShareBps: regla.sourceShareBps,
          zeroBaseFallback: regla.zeroBaseFallback,
          validFrom: regla.validFrom,
          validTo: null,
          targets: [],
        } as never,
        actor
      )
    }
  })

  const fiscalYearId = await tenantTransaction(organizationId, userId, async (tx) =>
    (await tx.fiscalYear.findFirstOrThrow({ where: { code: fixture.fiscalYear } })).id
  )

  const yaSellado = await tenantDb(organizationId).allocationRun.findFirst({ where: { status: "SEALED" } })
  if (yaSellado) {
    report.allocationRunId = yaSellado.id
    report.allocationLines = yaSellado.lineCount
  } else {
    const detalle = await tenantTransaction(organizationId, userId, async (tx: TenantTransactionClient) =>
      sealAllocationRunTx(
        tx,
        {
          fiscalYearId,
          periodKind: "YEAR",
          periodStart: "2026-01-01",
          periodEnd: "2026-12-31",
          gitSha,
        } as never,
        actor
      )
    )
    report.allocationRunId = detalle.id
    report.allocationLines = detalle.lineCount
  }

  // ── 6 · La liquidación de IVA del trimestre, sobre el asiento que YA existe ─
  await tenantTransaction(organizationId, userId, async (tx: TenantTransactionClient) => {
    const { period, periodKind } = fixture.liquidacionIva
    const ya = await tx.vatSettlement.findFirst({ where: { period } })
    if (ya) {
      report.vatSettlementPeriod = period
      return
    }
    const { start, end } = vatPeriodBounds(period)
    /**
     * El asiento de la regularización **ya está contabilizado** en el fixture
     * (`IVA-Q1`): se busca por su plantilla y su fecha. Si no estuviera, no se
     * inventa uno —eso movería el diario y con él las doce cifras—: se dice.
     */
    const asiento = await tx.journalEntry.findFirst({
      where: { templateCode: "REGULARIZACION_IVA", entryDate: new Date(`${end}T00:00:00.000Z`) },
      select: { id: true },
    })
    if (!asiento) {
      mismatches.push(`no hay asiento REGULARIZACION_IVA del ${end} en el fixture: la liquidación no se sella`)
      return
    }

    const { book } = await readVatBook(tx, { period, inputVatCode: "472", outputVatCode: "477" })
    const regimes = await readVatRegimePeriods(tx)
    const regime = vatRegimeAt(regimes, end)

    /**
     * **Las cifras salen del LIBRO REGISTRO, no del constructor.**
     * `vatSettlement()` es el camino de la acción, y la acción liquida **antes**
     * de postear su asiento: llamarlo ahora se niega con `R-IVA-9` («el libro y
     * el diario no dicen lo mismo»), y con razón — el asiento de regularización
     * del fixture ya ha dejado el saldo de 472/477 del trimestre a cero. Lo que
     * la fila sella son las cuotas del trimestre, y ésas están en el libro: la
     * misma suma que I-E8-15a y I-E8-15c usan para cruzarlo con el diario.
     */
    const outputCents =
      book.filter((r) => r.tipo === "EMITIDAS").reduce((a, r) => a + r.cuotaRepercutidaCents, 0) +
      book.filter((r) => r.tipo === "RECIBIDAS").reduce((a, r) => a + r.cuotaDevengadaIspAibCents, 0)
    const inputCents = book.filter((r) => r.tipo === "RECIBIDAS").reduce((a, r) => a + r.cuotaDeducibleCents, 0)
    if (book.length === 0) {
      mismatches.push(`el libro registro de ${period} está vacío: la liquidación no sellaría nada`)
      return
    }

    await createVatSettlementTx(
      tx,
      {
        periodKind: (regime?.periodKind ?? periodKind) as never,
        period,
        periodStart: start,
        periodEnd: end,
        regime: (regime?.regime ?? "GENERAL") as never,
        entryId: asiento.id,
        outputCents,
        inputCents,
        resultCents: outputCents - inputCents,
        ledgerHash: await computeLedgerHash(tx, { from: start, to: end }),
        bookHash: bookHashOf(book),
        gitSha,
      },
      actor
    )
    report.vatSettlementPeriod = period
  })

  /**
   * **El consumo, EL ÚLTIMO.** Su `sourceHash` resume el recuento y el
   * `max(updated_at)` de las tablas que lo alimentan: calcularlo antes de
   * sembrar el reparto o la liquidación lo dejaría desfasado en el mismo
   * instante, y I-E11-1 —que recomputa y compara— saldría en FAIL sobre un
   * sustrato recién creado.
   */
  const uso = await getUsage(organizationId, new Date(`${refDate}T12:00:00.000Z`), {
    periodMonth: fixture.uso.periodMonth,
    recompute: true,
  })
  report.usageRunSourceHash = uso.sourceHash
  return report
}

/**
 * El `bookHash` **con la misma forma** que `app/(app)/reports/vat/actions.ts`.
 * Se repite aquí, y no se importa, porque la acción es un módulo `"use server"`
 * que arrastra medio producto a la suite; el test de T24 compara las dos formas
 * para que no puedan divergir.
 */
export function bookHashOf(book: readonly VatBookRowE9[]): string {
  return createHash("sha256")
    .update(book.map((r) => `${r.id}|${r.ivaPeriod}|${r.baseCents}|${r.cuotaTotalCents}`).join("\n"))
    .digest("hex")
}
