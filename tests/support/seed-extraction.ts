/**
 * Arnés de los e2e del camino documental (E8 · T15-T17).
 *
 * **Por qué existe.** El flujo real empieza con una llamada a un proveedor de
 * lenguaje, y un test de interfaz no puede depender de que haya una clave de
 * API, ni de que el modelo devuelva hoy lo mismo que ayer. Lo que el test tiene
 * que probar es la pantalla: la bandeja, los cuatro badges, las comprobaciones,
 * el asiento propuesto, la confirmación y el drill-down.
 *
 * Así que este script hace lo que haría `runExtraction` **menos la llamada al
 * modelo**: escribe el documento en disco con su `sha256`, y siembra un
 * `ExtractionRun` con la propuesta ya puesta y el veredicto calculado por el
 * MISMO `reconcile()` que usa la aplicación, con el MISMO contexto leído de la
 * base. No hay veredicto de mentira: si la propuesta sembrada no cuadrase, la
 * pantalla enseñaría un FAIL de verdad y el test fallaría por la razón correcta.
 *
 *   npx tsx tests/support/seed-extraction.ts --org <id> [--case simple|ticket|mixta]
 *
 * Imprime en `stdout`, en una línea, `{ fileId, runId, status, documentNumber }`.
 * Es idempotente por caso: si el documento del caso ya existe, lo reutiliza.
 */

import { createHash, randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { tenantDb } from "@/lib/db"
import { reconcile } from "@/lib/extraction/reconcile"
import { documentWarnings, sealedReconcile } from "@/lib/extraction/seal"
import type { ExtractionProposal } from "@/lib/extraction/types"
import { getOrganizationUploadsDirectory, safePathJoin, unsortedFilePath } from "@/lib/files"
import { createExtractionRun } from "@/models/extraction"
import { createFile } from "@/models/files"
import { buildReconcileContext } from "@/models/reconcile-context"
import { prisma } from "@/lib/db"

type CaseName = "simple" | "ticket" | "mixta"

/** PNG de 1×1 gris: basta para que el visor y el `sha256` tengan algo real. */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
)

/**
 * Las propuestas de los tres casos. Las cifras cuadran con tolerancia 0 porque
 * es lo que RC-01 y RC-03 exigen; el caso `ticket` va con IVA incluido, que es
 * el camino de RC-17 y el del aviso de factura simplificada.
 */
function proposalFor(kind: CaseName, documentNumber: string, costCenterId: string | null): ExtractionProposal {
  if (kind === "ticket") {
    return {
      version: 1,
      docKind: "TICKET",
      documentNumber,
      counterparty: { name: "Cafetería del Puerto SL", taxId: "B12345674" },
      documentDate: "2026-03-12",
      accrualDate: "2026-03-12",
      receptionDate: "2026-03-12",
      operationDate: "2026-03-12",
      currency: "EUR",
      lines: [
        {
          kind: "OPERACION",
          baseCents: 1122,
          taxRateCode: "IVA_10",
          description: "Comida de trabajo",
          ...(costCenterId ? { costCenterId } : {}),
        },
      ],
      taxes: [{ taxRateCode: "IVA_10", baseCents: 1122, quotaCents: 112 }],
      paymentKey: "BANCO_DEFAULT",
      totalCents: 1234,
      description: "Ticket de restaurante",
    }
  }

  if (kind === "mixta") {
    return {
      version: 1,
      docKind: "FACTURA_RECIBIDA",
      documentNumber,
      counterparty: { name: "Suministros Industriales SA", taxId: "A58818501" },
      documentDate: "2026-04-02",
      accrualDate: "2026-04-02",
      receptionDate: "2026-04-10",
      operationDate: "2026-04-02",
      currency: "EUR",
      lines: [
        {
          kind: "OPERACION",
          baseCents: 1_000_000,
          taxRateCode: "IVA_21",
          description: "Equipo de laboratorio",
          accountCode: "217",
        },
        {
          kind: "OPERACION",
          baseCents: 200_000,
          taxRateCode: "IVA_21",
          description: "Mantenimiento anual",
          accountCode: "629",
          ...(costCenterId ? { costCenterId } : {}),
        },
      ],
      taxes: [{ taxRateCode: "IVA_21", baseCents: 1_200_000, quotaCents: 252_000 }],
      totalCents: 1_452_000,
      description: "Equipo y mantenimiento",
    }
  }

  return {
    version: 1,
    docKind: "FACTURA_RECIBIDA",
    documentNumber,
    counterparty: { name: "Servicios Generales SL", taxId: "B58818501" },
    documentDate: "2026-02-10",
    accrualDate: "2026-02-10",
    receptionDate: "2026-02-14",
    operationDate: "2026-02-10",
    currency: "EUR",
    lines: [
      {
        kind: "OPERACION",
        baseCents: 100_000,
        taxRateCode: "IVA_21",
        description: "Servicios de mantenimiento",
        accountCode: "629",
        ...(costCenterId ? { costCenterId } : {}),
      },
    ],
    taxes: [{ taxRateCode: "IVA_21", baseCents: 100_000, quotaCents: 21_000 }],
    totalCents: 121_000,
    description: "Factura de servicios",
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const organizationId = valueOf(args, "--org")
  if (!organizationId) throw new Error("Falta --org <organizationId>")
  const kind = (valueOf(args, "--case") ?? "simple") as CaseName
  const documentNumber = valueOf(args, "--number") ?? `E2E-${kind.toUpperCase()}-001`

  const organization = await prisma.organization.findUnique({ where: { id: organizationId } })
  if (!organization) throw new Error(`La organización ${organizationId} no existe`)

  const db = tenantDb(organizationId)

  // La moneda base tiene que estar en el catálogo de la organización: RC-04 la
  // busca ahí y sin ella el documento no cuadra por una razón que no tiene nada
  // que ver con el documento.
  const baseCurrency = organization.baseCurrency
  const currency = await db.currency.findFirst({ where: { code: baseCurrency } })
  if (!currency) {
    await db.currency.create({
      data: { organizationId, code: baseCurrency, name: baseCurrency },
    })
  }

  // Un destino analítico real: sin él RC-08 avisa y el documento no entra en el
  // lote (R-A8), que es correcto pero convertiría el caso feliz en un caso raro.
  const costCenter = await db.costCenter.findFirst({
    where: { isActive: true, code: { not: "CC-NA" } },
    select: { id: true },
    orderBy: { code: "asc" },
  })

  const proposal = proposalFor(kind, documentNumber, costCenter?.id ?? null)

  // La ficha del tercero: la calificación fiscal sale de aquí y no del papel
  // (O-11). Sin ella RC-11 avisa de que el NIF es válido pero desconocido, que
  // es correcto y no es lo que este arnés quiere probar.
  const taxId = proposal.counterparty.taxId
  if (taxId) {
    const known = await db.counterparty.findFirst({ where: { taxId } })
    if (!known) {
      await db.counterparty.create({
        data: {
          organizationId,
          code: taxId,
          name: proposal.counterparty.name ?? taxId,
          taxId,
          countryCode: "ES",
          withholdingRegime: "NINGUNO",
        },
      })
    }
  }

  const filename = `e2e-${kind}-${documentNumber}.png`
  // Bytes ÚNICOS por documento: dos ficheros con el mismo `sha256` son un
  // duplicado de manual y RC-12 los bloquea, con razón (I-E8-13).
  const bytes = Buffer.concat([PNG_1PX, Buffer.from(`\n%%e2e:${documentNumber}\n`, "utf8")])
  const sha256 = createHash("sha256").update(bytes).digest("hex")

  // Idempotencia: si el documento del caso ya está sembrado, se reutiliza en vez
  // de acumular ficheros en cada ejecución de la suite.
  const existing = await db.file.findFirst({ where: { filename }, orderBy: { createdAt: "desc" } })
  let fileId = existing?.id ?? null

  if (!fileId) {
    const fileUuid = randomUUID()
    const relativePath = unsortedFilePath(fileUuid, filename)
    const fullPath = safePathJoin(getOrganizationUploadsDirectory(organization), relativePath)
    await mkdir(path.dirname(fullPath), { recursive: true })
    await writeFile(fullPath, bytes)

    const created = await createFile(db, {
      id: fileUuid,
      organizationId,
      filename,
      path: relativePath,
      mimetype: "image/png",
      sha256,
      sizeBytes: bytes.length,
      isReviewed: false,
      metadata: { size: bytes.length, source: "e2e" },
    })
    fileId = created.id
  }

  const file = await db.file.findFirstOrThrow({ where: { id: fileId } })

  // El MISMO veredicto que da la aplicación, con el MISMO contexto de la base.
  const ctx = await buildReconcileContext(
    db,
    organization,
    {
      proposal,
      run: {
        kind: "LLM",
        partial: false,
        pagesSent: 1,
        pagesTotal: 1,
        fileSha256: file.sha256 ?? sha256,
        rawOutput: {},
        fieldOrigins: {},
      } as never,
      file,
    },
    { refDate: todayLocalDate() }
  )
  const result = reconcile(proposal, ctx)
  const warnings = documentWarnings(result, {
    counterpartyEnMaestro: ctx.counterparty?.enMaestro ?? false,
    withholdingRegime: ctx.counterparty?.withholdingRegime ?? null,
  })

  const run = await createExtractionRun(db, {
    fileId: file.id,
    fileSha256: file.sha256 ?? sha256,
    kind: "LLM",
    provider: "mock",
    model: "e2e-fixture",
    attempts: [],
    promptCode: "extraction",
    promptSource: "GIT",
    promptSha: createHash("sha256").update("e2e").digest("hex"),
    schemaVersion: "v1",
    schemaSha: createHash("sha256").update("e2e-schema").digest("hex"),
    pagesSent: 1,
    pagesTotal: 1,
    rawOutput: { seededBy: "tests/support/seed-extraction.ts", case: kind },
    proposal: result.normalized,
    fieldOrigins: result.fieldOrigins,
    reconcile: { status: result.status, detail: sealedReconcile(result, warnings as never) as unknown },
    durationMs: 0,
  })

  process.stdout.write(
    `${JSON.stringify({ fileId: file.id, runId: run.id, status: result.status, documentNumber })}\n`
  )
}

/** Hoy en `YYYY-MM-DD`, hora local del proceso. El motor nunca lo hace por su cuenta. */
function todayLocalDate(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
}

function valueOf(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag)
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
