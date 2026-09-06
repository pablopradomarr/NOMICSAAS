/**
 * E8 · ronda 1 de corrección — **los quince casos sellados, sobre el plan NPGC
 * real**, y los cinco hallazgos del auditor cerrados con evidencia.
 *
 * ## Por qué este fichero existe
 *
 * `lib/extraction/reconcile.fixture.ts` construye un `Plan` **sintético** a
 * propósito, y hace bien: comparar el motor puro contra el plan sembrado
 * mediría la siembra en vez del asiento. Pero eso dejaba un hueco que el
 * auditor nombró (H-6): **ningún test replicaba los quince casos sobre el NPGC
 * de verdad**, así que un cambio en `seeds/npgc.csv` o en
 * `organization_account_maps` no rompía nada de E8. El replay de la auditoría
 * fue el primero en hacerlo, y para lograrlo hubo que traducir a mano cinco
 * cuentas y un código de retención.
 *
 * Aquí esa traducción es **automática y explícita**: el fixture nombra `400` y
 * el plan sembrado hace postable la `4000`, así que se busca en el plan real la
 * cuenta postable que cuelga del código del fixture. Si mañana el seed cambia,
 * este test cambia con él o falla; que es lo que se quería.
 *
 * ## Qué se comprueba
 *
 *  1. **H-1 y H-2** — los tres puentes al 303 (`I-E8-15a/b/c`) dan **0** sobre
 *     los quince casos, con divisa (C12, USD) y con rectificativa por
 *     sustitución (C07) incluidas. Antes daban FAIL: −10 438 en Q4 por anotar
 *     dólares contra un diario en euros, +12 600 en Q3 por anotar la cuota del
 *     documento sustituto en lugar de la diferencia contabilizada.
 *  2. **I-E8-7a** — el puente documento ↔ asiento cuadra documento a documento.
 *  3. **D2 · Hamilton** — un caso en divisa cuyo residuo de conversión **no es
 *     cero**, que es la rama que ningún caso sellado ejercía (H-7).
 *  4. **H-5** — editar por SQL la propuesta de un run YA contabilizado hace que
 *     `I-E8-11` recompute `proposal_sha` y lo delate.
 *  5. **H-3** — `I-E8-2` compara los bytes del almacén (se prueba además en
 *     `e8-qa.test.ts`, con el fichero ausente y con los bytes alterados).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL

const ORG = "e8a10000-0000-4000-8000-00000000001a"
const USER = "e8a10000-0000-4000-8000-0000000e0001"

let currentUser: { id: string; email: string; name: string }

const cookieStore = { get: () => undefined, set: () => {}, delete: () => {} }
vi.mock("next/headers", () => ({ cookies: async () => cookieStore }))
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }))
vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => currentUser,
  getSession: async () => ({ user: currentUser }),
  isSubscriptionExpired: () => false,
  isAiBalanceExhausted: () => false,
}))

const { createHash } = await import("node:crypto")
const { mkdir, rm, writeFile } = await import("node:fs/promises")
const { dirname, join } = await import("node:path")

const { prisma, tenantTransaction } = await import("@/lib/db")
const { importNpgc } = await import("@/models/accounts")
const { openFiscalYear } = await import("@/models/fiscal-years")
const { seedAnalyticsDefaults } = await import("@/models/analytics")
const { DEFAULT_CURRENCIES } = await import("@/models/defaults-data")
const { createExtractionRun } = await import("@/models/extraction")
const { createFile } = await import("@/models/files")
const { buildReconcileContext } = await import("@/models/reconcile-context")
const { getAccountMapByKey } = await import("@/models/account-map")
const { listTaxRates } = await import("@/models/tax-rates")
const { getLedgerContext, postEntryTx, runLedgerInvariants } = await import("@/models/ledger")
const { reconcile } = await import("@/lib/extraction/reconcile")
const { documentWarnings, sealedReconcile } = await import("@/lib/extraction/seal")
const { postFromProposal } = await import("@/lib/ledger/postFromProposal")
const { FILE_UPLOAD_PATH, unsortedFilePath } = await import("@/lib/files")
const { sha256OfStoredFile: readStoredFile } = await import("@/lib/files-integrity")
const { inputProposalFor, loadExtractionFixture } = await import("@/lib/extraction/reconcile.fixture")

type Proposal = import("@/lib/extraction/types").ExtractionProposal
type Organization = import("@/prisma/client").Organization

describe.skipIf(!TEST_DATABASE_URL)("E8 ronda 1 · los quince casos sobre el plan NPGC sembrado", () => {
  let organization: Organization
  const entryIdByCase = new Map<string, string>()
  let rectifiedFv41 = ""

  async function cleanup(): Promise<void> {
    for (const table of [
      "journal_lines",
      "allocation_lines",
      "transactions",
      "period_locks",
      // Los contra-asientos primero: `reverses_entry_id` es RESTRICT.
      "journal_entries WHERE reverses_entry_id IS NOT NULL AND",
      "journal_entries",
      "extraction_runs",
      "files",
      "audit_logs",
      "counterparties",
      "categories",
      "projects",
      "cost_centers",
      "organization_account_maps",
      "tax_rates",
      "accounts",
      "currencies",
      "fiscal_years",
      "memberships",
    ]) {
      const sql = table.includes(" WHERE ")
        ? `DELETE FROM ${table} organization_id = $1::uuid`
        : `DELETE FROM ${table} WHERE organization_id = $1::uuid`
      await prisma.$executeRawUnsafe(sql, ORG).catch(() => undefined)
    }
    await prisma.$executeRawUnsafe(`DELETE FROM organizations WHERE id = $1::uuid`, ORG).catch(() => undefined)
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE id = $1::uuid`, USER).catch(() => undefined)
    await rm(join(FILE_UPLOAD_PATH, ORG), { recursive: true, force: true }).catch(() => undefined)
  }

  /**
   * La propuesta del fixture, tal cual, **sin una sola traducción de arnés**
   * (ronda 2, H-6).
   *
   * Las cuentas del documento (`600`, `623`, `217`…) van verbatim: el motor las
   * usa así en producción, y las de contrapartida las resuelve él por
   * `ctx.map(AccountKey)` contra el `OrganizationAccountMap` sembrado, que es
   * el mecanismo del producto. El código de retención también va verbatim
   * porque el fixture 1.1 ya lo llama como el catálogo (`IRPF_PROF_15`).
   *
   * Lo único que se retira son las dimensiones analíticas (`PRJ-ALFA`,
   * `CC-OPS`): son uuid inventados para el plan sintético y no existen en esta
   * organización. No es una traducción, es no usarlas: lo que este test mide es
   * el puente al 303 y la cadena documento → asiento, no la analítica —que
   * tiene sus propios invariantes en E4— y la organización va con
   * `analytics_required = false`.
   */
  function onRealPlan(proposal: Proposal): Proposal {
    return {
      ...proposal,
      lines: proposal.lines.map(({ projectId: _p, costCenterId: _c, ...l }) => l),
    }
  }

  /**
   * El camino REAL, entero: fichero con sus bytes en disco y su sha, contexto
   * leído de la base, `reconcile`, `postFromProposal` y `postEntryTx`. No se
   * simula ningún tramo; lo único que no ocurre es la llamada al modelo.
   */
  async function postDocument(args: {
    key: string
    proposal: Proposal
    refDate: string
    categoryCode?: string | null
    documentNumber: string
    /** RC-22 precondición 3: la mención del art. 6.1.m LEÍDA del documento. */
    legalMentions?: string | null
    /** Páginas vistas / totales: C13 es una extracción PARCIAL y no se contabiliza. */
    pages?: { sent: number; total: number; partial: boolean }
  }): Promise<{ entryId: string; runId: string; status: string }> {
    const bytes = Buffer.from(`%PDF-1.4 e8-ronda1 ${args.key} ${args.documentNumber}\n`, "utf8")
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    const fileUuid = crypto.randomUUID()
    const relativePath = unsortedFilePath(fileUuid, `${args.key}.pdf`)
    const fullPath = join(FILE_UPLOAD_PATH, ORG, relativePath)
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, bytes)

    return await tenantTransaction(ORG, USER, async (db) => {
      const file = await createFile(db, {
        id: fileUuid,
        organizationId: ORG,
        filename: `${args.key}.pdf`,
        path: relativePath,
        mimetype: "application/pdf",
        sha256,
        sizeBytes: bytes.length,
        isReviewed: false,
        metadata: {},
      })

      const ctx = await buildReconcileContext(
        db,
        organization,
        {
          proposal: args.proposal,
          run: {
            kind: "LLM",
            partial: args.pages?.partial ?? false,
            pagesSent: args.pages?.sent ?? 1,
            pagesTotal: args.pages?.total ?? 1,
            fileSha256: sha256,
            rawOutput: {},
            // `legalMentionOf` (models/reconcile-context) espera un ARRAY de
            // textos leídos del documento y busca en él la mención del art. 84.
            fieldOrigins: args.legalMentions
              ? { legalMentions: { value: [args.legalMentions], origin: "llm", confidence: "interpretacion_ia" } }
              : {},
          } as never,
          file,
        },
        { refDate: args.refDate, ...(args.categoryCode ? { categoryCode: args.categoryCode } : {}) }
      )
      const result = reconcile(args.proposal, ctx)
      const warnings = documentWarnings(result, {
        counterpartyEnMaestro: ctx.counterparty?.enMaestro ?? false,
        withholdingRegime: ctx.counterparty?.withholdingRegime ?? null,
      })
      const run = await createExtractionRun(db, {
        fileId: file.id,
        fileSha256: sha256,
        kind: "LLM",
        provider: "fixture",
        model: "e8-ronda1",
        attempts: [],
        promptCode: "extraccion",
        promptSource: "GIT",
        promptSha: createHash("sha256").update("prompt").digest("hex"),
        schemaVersion: "v-fixture",
        schemaSha: createHash("sha256").update("schema").digest("hex"),
        pagesSent: args.pages?.sent ?? 1,
        pagesTotal: args.pages?.total ?? 1,
        rawOutput: { case: args.key },
        proposal: result.normalized,
        fieldOrigins: result.fieldOrigins,
        reconcile: { status: result.status, detail: sealedReconcile(result, warnings as never) as unknown },
        durationMs: 0,
      })

      if (result.status === "FAIL") return { entryId: "", runId: run.id, status: result.status }

      const ledgerContext = await getLedgerContext(db, args.refDate)
      const draft = postFromProposal(result, ledgerContext, { extractionRunId: run.id, fileId: file.id })
      if (!draft.ok) {
        const detalle = result.checks
          .filter((c) => c.status !== "PASS")
          .map((c) => `${c.id} ${c.status} ${c.message} ${JSON.stringify(c.evidence)}`)
          .join(" | ")
        throw new Error(`${args.key}: ${draft.errors.map((e) => e.message).join(" · ")} :: ${detalle}`)
      }

      const operation = await db.transaction.create({
        data: {
          organizationId: ORG,
          createdById: USER,
          status: "DRAFT",
          name: args.documentNumber,
          total: result.normalized.totalCents,
          currencyCode: result.normalized.currency,
          convertedTotal: result.conversion?.convertedTotalCents ?? null,
          exchangeRateMicro: result.conversion?.rateMicro ?? null,
          rateDate: result.conversion ? new Date(`${result.conversion.rateDate}T00:00:00.000Z`) : null,
          rateSource: result.conversion?.source ?? null,
          extractionRunId: run.id,
          files: [{ id: file.id, filename: file.filename }] as unknown as object,
        },
      })
      draft.value.draft.transactionId = operation.id
      const entry = await postEntryTx(db, draft.value.draft, { userId: USER })
      await db.transaction.update({ where: { id: operation.id }, data: { status: "POSTED", journalEntryId: entry.id } })
      return { entryId: entry.id, runId: run.id, status: result.status }
    })
  }

  beforeAll(async () => {
    await cleanup()
    currentUser = await prisma.user.create({ data: { id: USER, email: "e8-ronda1@test.local", name: "Ronda 1" } })
    const fixture = loadExtractionFixture()
    const org = fixture.contextoComun.organization

    await prisma.organization.create({
      data: { id: ORG, slug: "e8-ronda1", name: "E8 ronda 1", pgcVariant: "PYMES", updatedAt: new Date() },
    })
    await prisma.membership.create({
      data: { organizationId: ORG, userId: USER, role: "ADMIN", acceptedAt: new Date(), updatedAt: new Date() },
    })
    await importNpgc(ORG, "PYMES", { actor: { userId: USER }, now: new Date("2025-01-01"), useSubaccounts: false })
    for (const [code, from, to, status] of [
      ["2025", "2025-01-01", "2025-12-31", "CLOSED"],
      ["2026", "2026-01-01", "2026-12-31", "OPEN"],
    ] as const) {
      const fy = await openFiscalYear(ORG, { code, startDate: from, endDate: to }, { userId: USER })
      if (!fy.ok) throw new Error(`no se pudo abrir el ejercicio ${code}`)
      if (status === "CLOSED") {
        await prisma.$executeRawUnsafe(
          `UPDATE fiscal_years SET status = 'CLOSED' WHERE organization_id = $1::uuid AND code = $2`,
          ORG,
          code
        )
      }
    }

    await tenantTransaction(ORG, USER, async (db) => {
      await seedAnalyticsDefaults(db, { validFrom: "2025-01-01", userId: null })
      await db.currency.createMany({ data: DEFAULT_CURRENCIES.map((c) => ({ ...c, organizationId: ORG })) })

      // La organización del fixture, campo a campo: sin `roiRegistered` no hay
      // ISP válida (RC-22) y sin `GENERAL` RC-24 bloquea todo (ADR-0014 D10).
      await db.$executeRawUnsafe(
        `UPDATE organizations SET base_currency = $2, tax_rounding_mode = 'PER_TIPO', redondeo_tolerancia_cents = $3,
                prorrata_bps = $4, roi_registered = $5, iva_regime = $6::iva_regime, analytics_required = false
          WHERE id = $1::uuid`,
        ORG,
        org.baseCurrency,
        org.redondeoToleranciaCents,
        org.prorrataBps,
        org.roiRegistered,
        org.ivaRegime
      )

      // Contrapartes del fixture, con su régimen: la calificación fiscal sale de
      // la ficha y no del papel (O-11).
      for (const cp of Object.values(fixture.contextoComun.counterparties)) {
        if (!cp.id) continue
        await db.counterparty.create({
          data: {
            id: uuidOfEntity(cp.id),
            organizationId: ORG,
            code: cp.id,
            name: cp.name ?? cp.id,
            taxId: cp.taxId,
            countryCode: cp.countryCode,
            vatNumber: cp.vatNumber,
            viesValid: cp.viesValid,
            viesCheckedAt: cp.viesCheckedAt ? new Date(`${cp.viesCheckedAt}T00:00:00.000Z`) : null,
            withholdingRegime: cp.withholdingRegime as never,
            withholdingRateCode: cp.withholdingRateCode,
            surchargeRegime: cp.surchargeRegime,
            isEmployee: cp.isEmployee,
          },
        })
      }

      // Categorías que algún caso usa como contexto (C01, C03, C04).
      const categories = new Map<string, { defaultAccountCode: string | null; defaultDeductibility: string }>()
      for (const c of fixture.casos) {
        const cat = c.contexto.categoria
        if (cat) categories.set(cat.code, { defaultAccountCode: cat.defaultAccountCode, defaultDeductibility: cat.defaultDeductibility })
      }

      // Tasas del fixture, persistidas: sin ellas `getOrFetchRate` saldría a la
      // red, que es exactamente lo que un test no puede hacer.
      // `exchange_rates` es GLOBAL y append-only (ADR-0014 D7): si otra suite
      // ya sembró la misma fila, se reutiliza en lugar de fallar.
      await db.exchangeRate.createMany({
        data: fixture.contextoComun.exchangeRates.map((rate) => ({
          date: new Date(`${rate.date}T00:00:00.000Z`),
          from: rate.from,
          to: rate.to,
          rateMicro: BigInt(rate.rateMicro),
          source: rate.source,
        })),
        skipDuplicates: true,
      })

      /**
       * **H-6 — el fixture tiene que caber en el plan REAL, sin traducciones.**
       * Si una cuenta que el documento cita no es postable en el NPGC sembrado,
       * o un tipo impositivo no está en el catálogo, el fallo es del fixture y
       * este test lo dice por su nombre en vez de disimularlo traduciéndolo.
       */
      const accounts = await db.ledgerAccount.findMany({ select: { code: true, isPostable: true, isActive: true } })
      const postable = new Set(accounts.filter((a) => a.isPostable && a.isActive).map((a) => a.code))
      const citadas = new Set<string>()
      for (const c of fixture.casos) for (const l of c.propuesta.lines) if (l.accountCode) citadas.add(l.accountCode)
      for (const c of fixture.casos) if (c.contexto.categoria?.defaultAccountCode) citadas.add(c.contexto.categoria.defaultAccountCode)
      const noPostables = [...citadas].filter((code) => !postable.has(code)).sort()
      if (noPostables.length > 0) {
        throw new Error(
          `el fixture cita cuentas que el NPGC sembrado no admite como postables: ${noPostables.join(", ")}. ` +
            "Corrija el fixture (docs/design/fixtures/build_extraccion_esperada.py), no el test"
        )
      }
      const catalogo = new Set((await listTaxRates(db, {})).map((r) => r.code))
      const tiposDelFixture = new Set(Object.keys(fixture.contextoComun.taxRates))
      const desconocidos = [...tiposDelFixture].filter((code) => !catalogo.has(code)).sort()
      if (desconocidos.length > 0) {
        throw new Error(
          `el fixture usa tipos impositivos que el catálogo del producto no tiene: ${desconocidos.join(", ")}. ` +
            "Corrija el fixture, no el test"
        )
      }
      // Y las claves de contrapartida se resuelven con el mecanismo del
      // producto: el mapa de la organización, no una tabla de este fichero.
      const mapa = await getAccountMapByKey(db)
      for (const key of ["PROVEEDORES", "ACREEDORES", "CLIENTES", "IVA_SOPORTADO", "IVA_REPERCUTIDO", "IRPF_PROFESIONALES_A_PAGAR"] as const) {
        expect(mapa.get(key), `la clave ${key} no está mapeada en el plan sembrado`).toBeTruthy()
      }

      for (const [code, cat] of categories) {
        await db.category.create({
          data: {
            organizationId: ORG,
            code,
            name: code,
            defaultAccountCode: cat.defaultAccountCode,
            defaultDeductibility: cat.defaultDeductibility as never,
          },
        })
      }
    })

    organization = await prisma.organization.findUniqueOrThrow({ where: { id: ORG } })

    // El asiento ORIGINAL que C07 rectifica por sustitución: 100 000 de base y
    // 21 000 de cuota repercutida, contabilizado por el mismo motor.
    const original = await postDocument({
      key: "FV2026-0041",
      documentNumber: "FV2026/0041",
      refDate: "2026-09-30",
      proposal: onRealPlan({
        version: 1,
        docKind: "FACTURA_EMITIDA",
        documentNumber: "FV2026/0041",
        counterparty: { name: "Constructora del Ebro SA", taxId: "A28017895", id: uuidOfEntity("CP-ES-CLIENTE") },
        documentDate: "2026-09-01",
        receptionDate: "2026-09-01",
        currency: "EUR",
        lines: [{ kind: "OPERACION", baseCents: 100_000, taxRateCode: "IVA_21", accountCode: "705" }],
        taxes: [{ taxRateCode: "IVA_21", baseCents: 100_000, quotaCents: 21_000 }],
        totalCents: 121_000,
        description: "Factura original que C07 rectifica",
      } as Proposal),
    })
    rectifiedFv41 = original.entryId

    for (const c of loadExtractionFixture().casos) {
      const base = onRealPlan(inputProposalFor(c))
      const proposal: Proposal = {
        ...base,
        ...(base.rectifies
          ? {
              rectifies: {
                ...base.rectifies,
                ...(c.id === "C07"
                  ? { entryId: rectifiedFv41 }
                  : entryIdByCase.get("C01")
                    ? { entryId: entryIdByCase.get("C01") as string }
                    : {}),
              },
            }
          : {}),
      }
      const posted = await postDocument({
        key: c.id,
        documentNumber: c.propuesta.documentNumber ?? c.id,
        refDate: c.contexto.refDate,
        categoryCode: c.contexto.categoria?.code ?? null,
        legalMentions: legalMentionOf(c),
        pages: { sent: c.contexto.run.pagesAnalyzed, total: c.contexto.run.pagesTotal, partial: c.contexto.run.partial },
        proposal,
      })
      if (posted.entryId) entryIdByCase.set(c.id, posted.entryId)
    }
  }, 600_000)

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  it("los catorce casos contabilizables producen asiento sobre el plan real; C13 (extracción parcial) no", () => {
    expect(entryIdByCase.size).toBe(14)
    expect(entryIdByCase.has("C13")).toBe(false)
  })

  it("H-1 y H-2 · los tres puentes al 303 dan 0 con divisa y con rectificativa por sustitución", async () => {
    const validation = await runLedgerInvariants(ORG, { refDate: "2026-12-31", noCache: true, actor: { userId: USER }, readStoredFile })
    const statusOf = (id: string): { status: string; evidencia: string } => {
      const check = validation.validacion.checks.find((c) => c.id === id)
      return { status: check?.status ?? "AUSENTE", evidencia: check?.evidencia ?? "" }
    }
    for (const id of ["I-E8-15a", "I-E8-15b", "I-E8-15c"]) {
      const check = statusOf(id)
      expect(`${id}: ${check.status} — ${check.evidencia}`).toMatch(new RegExp(`^${id}: PASS`))
    }
    // Y el puente documento ↔ asiento, que es donde vive ahora la comparación.
    const ie87a = statusOf("I-E8-7a")
    expect(`${ie87a.status} — ${ie87a.evidencia}`).toMatch(/^PASS/)
    // H-3: los bytes del almacén se comprueban de verdad y coinciden.
    const ie82 = statusOf("I-E8-2")
    expect(`${ie82.status} — ${ie82.evidencia}`).toMatch(/^PASS/)
    expect(ie82.evidencia).toMatch(/sha en disco/)
  }, 300_000)

  it("H-5 · editar por SQL la propuesta de un run YA contabilizado ⇒ I-E8-11 FAIL nombrando el run", async () => {
    const entryId = entryIdByCase.get("C01") as string
    const [row] = await prisma.$queryRawUnsafe<{ extraction_run_id: string }[]>(
      `SELECT extraction_run_id FROM journal_entries WHERE id = $1::uuid`,
      entryId
    )
    const runId = row.extraction_run_id

    const antes = await runLedgerInvariants(ORG, { refDate: "2026-12-31", noCache: true, actor: { userId: USER }, readStoredFile })
    expect(antes.validacion.checks.find((c) => c.id === "I-E8-11")?.status).toBe("PASS")

    // La manipulación: se cambia la cuota de la propuesta sin tocar el sello.
    // `extraction_runs` es inmutable por PERMISOS para `app_runtime`; como
    // propietario se puede escribir, y ése es justo el escenario de H-5.
    const [before] = await prisma.$queryRawUnsafe<{ proposal: unknown }[]>(
      `SELECT proposal FROM extraction_runs WHERE id = $1::uuid`,
      runId
    )
    await prisma.$executeRawUnsafe(
      `UPDATE extraction_runs
          SET proposal = jsonb_set(proposal, '{taxes,0,quotaCents}', '25000'::jsonb)
        WHERE id = $1::uuid`,
      runId
    )
    try {
      const despues = await runLedgerInvariants(ORG, { refDate: "2026-12-31", noCache: true, actor: { userId: USER }, readStoredFile })
      const check = despues.validacion.checks.find((c) => c.id === "I-E8-11")
      expect(check?.status).toBe("FAIL")
      expect(check?.evidencia).toContain(runId)
      expect(check?.evidencia).toMatch(/proposal_sha/)
      expect(despues.sello.sello).toBe("REQUIERE REVISIÓN")
    } finally {
      await prisma.$executeRawUnsafe(`UPDATE extraction_runs SET proposal = $2::jsonb WHERE id = $1::uuid`, runId, JSON.stringify(before.proposal))
    }
    const restaurado = await runLedgerInvariants(ORG, { refDate: "2026-12-31", noCache: true, actor: { userId: USER }, readStoredFile })
    expect(restaurado.validacion.checks.find((c) => c.id === "I-E8-11")?.status).toBe("PASS")
  }, 300_000)

  /**
   * **Ronda 2, R2-2 — el puente al 303 con vigilancia propia.**
   *
   * Desde la ronda 1 el libro registro sale del ASIENTO, así que I-E8-15a/b/c
   * ya no pueden detectar por sí solos una propuesta manipulada: quien lo hace
   * es I-E8-7a, comparando la anotación del asiento con la que se deriva del
   * documento. Ese contraste necesita su propio caso adverso permanente, o
   * nadie se enteraría el día que se rompiera.
   *
   * La manipulación es la del auditor (H-5), pero mirada desde el otro lado: se
   * cambia por SQL la cuota de la propuesta de un run YA contabilizado. El
   * asiento no se mueve —es inmutable— así que documento y asiento dejan de
   * decir lo mismo y **I-E8-7a lo dice con la diferencia**.
   */
  it("R2-2 · la cuota de la propuesta alterada por SQL rompe el puente documento ↔ asiento: I-E8-7a FAIL", async () => {
    const entryId = entryIdByCase.get("C01") as string
    const [row] = await prisma.$queryRawUnsafe<{ extraction_run_id: string; entry_number: number }[]>(
      `SELECT extraction_run_id, entry_number FROM journal_entries WHERE id = $1::uuid`,
      entryId
    )
    const runId = row.extraction_run_id

    const limpio = await runLedgerInvariants(ORG, { refDate: "2026-12-31", noCache: true, actor: { userId: USER }, readStoredFile })
    expect(limpio.validacion.checks.find((c) => c.id === "I-E8-7a")?.status).toBe("PASS")

    const [before] = await prisma.$queryRawUnsafe<{ proposal: unknown }[]>(
      `SELECT proposal FROM extraction_runs WHERE id = $1::uuid`,
      runId
    )
    const original = (before.proposal as { taxes: { quotaCents: number }[] }).taxes[0].quotaCents
    await prisma.$executeRawUnsafe(
      `UPDATE extraction_runs
          SET proposal = jsonb_set(proposal, '{taxes,0,quotaCents}', to_jsonb($2::int))
        WHERE id = $1::uuid`,
      runId,
      original + 1_000
    )
    try {
      const roto = await runLedgerInvariants(ORG, { refDate: "2026-12-31", noCache: true, actor: { userId: USER }, readStoredFile })
      const ie87a = roto.validacion.checks.find((c) => c.id === "I-E8-7a")
      expect(ie87a?.status).toBe("FAIL")
      expect(ie87a?.evidencia).toMatch(new RegExp(`asiento ${row.entry_number}:`))
      expect(ie87a?.evidencia).toMatch(/cuota deducible/)
      expect(ie87a?.evidencia).toMatch(/diferencia -1000/)
      expect(roto.sello.sello).toBe("REQUIERE REVISIÓN")
      // Y los tres puentes al 303 siguen cuadrados: el asiento no se ha tocado.
      // Es la prueba de que I-E8-7a es quien vigila el documento, no ellos.
      for (const id of ["I-E8-15a", "I-E8-15b", "I-E8-15c"]) {
        expect(`${id}: ${roto.validacion.checks.find((c) => c.id === id)?.status}`).toBe(`${id}: PASS`)
      }
    } finally {
      await prisma.$executeRawUnsafe(
        `UPDATE extraction_runs SET proposal = $2::jsonb WHERE id = $1::uuid`,
        runId,
        JSON.stringify(before.proposal)
      )
    }
    const restaurado = await runLedgerInvariants(ORG, { refDate: "2026-12-31", noCache: true, actor: { userId: USER }, readStoredFile })
    expect(restaurado.validacion.checks.find((c) => c.id === "I-E8-7a")?.status).toBe("PASS")
  }, 300_000)

  it("D2 · un documento en divisa con residuo de conversión ≠ 0 reparte por Hamilton y cuadra a cero", async () => {
    // 1 CHF = 0,920000 EUR. Bases 33 333 + 33 333 + 33 334 y dos tipos: la suma
    // de los contravalores redondeados NO da el contravalor del total, así que
    // el reparto por mayor resto tiene trabajo — la rama que C12 (residuo 0) no
    // ejercía (auditor H-7).
    await tenantTransaction(ORG, USER, async (db) => {
      await db.exchangeRate.createMany({
        data: [
          {
            date: new Date("2026-06-15T00:00:00.000Z"),
            from: "CHF",
            to: "EUR",
            rateMicro: BigInt(920_000),
            source: "ECB_FRANKFURTER",
          },
        ],
        skipDuplicates: true,
      })
    })

    const bases = [33_333, 33_333, 33_334]
    const cuota21 = Math.round((bases[0] + bases[1]) * 0.21)
    const cuota10 = Math.round(bases[2] * 0.1)
    const total = bases[0] + bases[1] + bases[2] + cuota21 + cuota10

    const posted = await postDocument({
      key: "FX-RESIDUO",
      documentNumber: "CHF-2026-0007",
      refDate: "2026-12-31",
      proposal: onRealPlan({
        version: 1,
        docKind: "FACTURA_RECIBIDA",
        documentNumber: "CHF-2026-0007",
        counterparty: { name: "Alpina Components AG", taxId: "CHE-116.281.710", id: uuidOfEntity("CP-CH-BIENES") },
        documentDate: "2026-06-15",
        receptionDate: "2026-06-15",
        currency: "CHF",
        lines: [
          { kind: "OPERACION", baseCents: bases[0], taxRateCode: "IVA_21", accountCode: "600" },
          { kind: "OPERACION", baseCents: bases[1], taxRateCode: "IVA_21", accountCode: "600" },
          { kind: "OPERACION", baseCents: bases[2], taxRateCode: "IVA_10", accountCode: "600" },
        ],
        taxes: [
          { taxRateCode: "IVA_21", baseCents: bases[0] + bases[1], quotaCents: cuota21 },
          { taxRateCode: "IVA_10", baseCents: bases[2], quotaCents: cuota10 },
        ],
        totalCents: total,
        description: "Compra en francos con residuo de conversión",
      } as Proposal),
    })
    expect(posted.entryId).not.toBe("")

    const lines = await prisma.$queryRawUnsafe<
      { account_code: string; debit_cents: number; credit_cents: number; original_amount_cents: number | null; original_currency: string | null }[]
    >(
      `SELECT account_code, debit_cents, credit_cents, original_amount_cents, original_currency
         FROM journal_lines WHERE entry_id = $1::uuid ORDER BY line_no`,
      posted.entryId
    )
    const debe = lines.reduce((a, l) => a + Number(l.debit_cents), 0)
    const haber = lines.reduce((a, l) => a + Number(l.credit_cents), 0)
    expect(debe).toBe(haber)

    // Contravalor exacto del total (half-even), sin línea de ajuste: el residuo
    // lo absorbieron las cuotas (ADR-0014 D2). Y no hay 668/768 ni 669/769.
    const payable = lines.find((l) => Number(l.credit_cents) > 0 && l.original_currency === "CHF")
    expect(payable).toBeTruthy()
    expect(Number(payable?.credit_cents)).toBe(Math.round((total * 920_000) / 1_000_000))
    expect(lines.some((l) => ["668", "768", "669", "769"].includes(l.account_code))).toBe(false)

    // Revisor #4: el importe original es el del DOCUMENTO, no la inversa.
    expect(Number(payable?.original_amount_cents)).toBe(total)

    // Y los invariantes siguen en verde con el caso dentro.
    const validation = await runLedgerInvariants(ORG, { refDate: "2026-12-31", noCache: true, actor: { userId: USER }, readStoredFile })
    for (const id of ["I-E8-7a", "I-E8-15a", "I-E8-15b", "I-E8-15c", "I-E8-19"]) {
      const check = validation.validacion.checks.find((c) => c.id === id)
      expect(`${id}: ${check?.status} — ${check?.evidencia}`).toMatch(new RegExp(`^${id}: PASS`))
    }
  }, 300_000)
})

/** El texto del art. 6.1.m que el documento trae, tal como lo selló RC-22. */
function legalMentionOf(c: import("@/lib/extraction/reconcile.fixture").FixtureCase): string | null {
  const rc22 = c.reconcile.checks.find((k) => k.id === "RC-22")
  const texto = (rc22?.evidence as { textoLeido?: unknown } | undefined)?.textoLeido
  return typeof texto === "string" ? texto : null
}

/** Los uuid fijos de las entidades del fixture, sin exportar el mapa entero. */
function uuidOfEntity(name: string): string {
  const table: Readonly<Record<string, string>> = {
    "CP-CH-BIENES": "00000000-0000-4000-8000-0000000000c1",
    "CP-DE-AIB": "00000000-0000-4000-8000-0000000000c2",
    "CP-ES-ABOGADO": "00000000-0000-4000-8000-0000000000c3",
    "CP-ES-CLIENTE": "00000000-0000-4000-8000-0000000000c4",
    "CP-ES-INFORMATICA": "00000000-0000-4000-8000-0000000000c5",
    "CP-ES-SERVICIOS": "00000000-0000-4000-8000-0000000000c6",
    "CP-ES-SUBCON": "00000000-0000-4000-8000-0000000000c7",
    "CP-US-CONSULT": "00000000-0000-4000-8000-0000000000c8",
  }
  return table[name] ?? name
}

