/**
 * E12 · T1 — Andamiaje común de los tests de aceptación C1–C7
 * (`docs/design/E12-fiabilidad-dod.md` §3.1).
 *
 * El contrato de la suite, escrito **una sola vez**:
 *
 *  1. **Organización efímera por fichero.** Cada test nace con una organización
 *     nueva, con el fixture completo cargado **por el motor**
 *     (`scripts/load-fixture.ts`), nunca por SQL de arnés. Un test que se siembra
 *     a sí mismo con `INSERT` prueba el arnés (lección H-6 de E8).
 *  2. **`GIT_SHA` fijo y `refDate` explícita.** Nada depende del día en que corra
 *     el test ni del commit en el que esté el árbol.
 *  3. **Cada test escribe su `validacion.json`** en `artifacts/acceptance/<C>/`,
 *     con el MISMO formato que `scripts/run-invariants.ts` — es lo que CI publica.
 *  4. **Ningún test importa el módulo que prueba para calcular lo esperado.** Las
 *     doce cifras canónicas son literales congelados (§3.2) y los cruces se hacen
 *     con SQL propio.
 *
 * El módulo se importa desde ficheros que ya tienen `DATABASE_URL` puesta por
 * `vitest.acceptance.config.ts`; por eso aquí sí valen las importaciones
 * estáticas.
 */

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Client } from "pg"

import { prisma, tenantTransaction } from "@/lib/db"
import type { LocalDate } from "@/lib/ledger/types"
import { loadFixtureIntoOrg, resetOrganizationLedger } from "@/scripts/load-fixture"
import { appRuntimeDatabaseUrl, appMaintenanceDatabaseUrl, ownerDatabaseUrl } from "@/tests/support/env"

// ─────────────────────────────────────────────────────────────────────────────
// Constantes del contrato
// ─────────────────────────────────────────────────────────────────────────────

/** git-sha de la suite. Lo fija `vitest.acceptance.config.ts`; aquí sólo se lee. */
export const ACCEPTANCE_GIT_SHA = process.env.GIT_SHA ?? "e12acc0"

/** «Hoy» de la suite. El fixture llega a 2027: sin esto, I8 diría otra cosa cada año. */
export const REF_DATE: LocalDate = "2026-12-31"

/** Ejercicio 2026 del fixture completo, que es sobre el que se aceptan las cifras. */
export const PERIOD = { periodStart: "2026-01-01" as LocalDate, periodEnd: "2026-12-31" as LocalDate }

/** Alias cómodo para las firmas que piden `from`/`to` en vez de `periodStart`/`periodEnd`. */
export const RANGE = { from: PERIOD.periodStart, to: PERIOD.periodEnd }

export const BASE_CURRENCY = "EUR"

/**
 * **Las 12 cifras canónicas** de §3.2, en céntimos, sobre el fixture completo y
 * el ejercicio 2026. Son literales CONGELADOS: no se derivan del motor, que es
 * precisamente lo que se está juzgando.
 *
 * `#2` (activo) y `#3` (PN + pasivo) y `#5` (tesorería) no llevan literal en el
 * diseño —salen selladas del `InvariantRun`—, pero sí llevan su **relación**:
 * #2 = #3 con tolerancia 0, y la tesorería es la que el fixture sella en su
 * balance pre-cierre (572 + 570).
 */
export const CANONICAL_FIGURES = {
  /** #1 · Σdebe = Σhaber del diario, ejercicio 2026. */
  DEBE_HABER_2026: 52_884_809,
  /** #1 bis · el mismo agregado sobre TODO el diario del fixture (2025 + 2026). */
  DEBE_HABER_TOTAL: 67_193_629,
  /** #4 · resultado del ejercicio. El nudo: cierra el bloque contable y abre el analítico. */
  RESULTADO: 1_497_322,
  /** #5 · tesorería = saldo final de las 57x (572 + 570 del balance sellado). */
  TESORERIA: 2_943_920,
  /** #6…#12 · los niveles de la matriz analítica. */
  INGRESOS: 6_250_000,
  MC1: 5_670_000,
  MC2: 3_276_000,
  MC3: 3_084_110,
  EBITDA: 2_390_430,
  EBIT: 1_995_430,
  BAI: 1_996_430,
} as const

/** Los siete niveles de margen que son cifra canónica (RESULTADO se compara con #4). */
export const CANONICAL_LEVELS = ["INGRESOS", "MC1", "MC2", "MC3", "EBITDA", "EBIT", "BAI"] as const
export type CanonicalLevel = (typeof CANONICAL_LEVELS)[number]

/** Los cinco sellos de §3.2. */
export const SEAL_NAMES = ["ledgerHash", "analyticsKey", "planHash", "accountMapHash", "configHash"] as const
export type SealName = (typeof SEAL_NAMES)[number]

// ─────────────────────────────────────────────────────────────────────────────
// Organización efímera
// ─────────────────────────────────────────────────────────────────────────────

export type AcceptanceOrg = {
  organizationId: string
  userId: string
  fiscalYearId: string
  slug: string
}

/**
 * uuid determinista por (componente, índice): un test que se corta a la mitad
 * deja la MISMA organización que su siguiente ejecución vuelve a vaciar, en vez
 * de sembrar la base de huérfanas.
 */
const uuidFor = (component: string, index: number): string => {
  const hex = [...component].reduce((acc, ch) => (acc * 33 + ch.charCodeAt(0)) % 0xffffffff, 7)
  const head = hex.toString(16).padStart(8, "0").slice(0, 8)
  return `${head}-0e12-4000-8000-${String(index).padStart(12, "0")}`
}

export const acceptanceOrgId = (component: string): string => uuidFor(component, 1)
export const acceptanceUserId = (component: string): string => uuidFor(component, 2)

/**
 * Crea la organización efímera del componente y le carga el fixture completo
 * **por el motor**. Idempotente: si la anterior ejecución dejó restos, los vacía.
 */
export async function createAcceptanceOrg(
  component: string,
  opts: { suffix?: string; fixture?: "ejercicio-completo" | "ejercicio-minimo"; loadFixture?: boolean } = {}
): Promise<AcceptanceOrg> {
  const key = opts.suffix ? `${component}-${opts.suffix}` : component
  const organizationId = acceptanceOrgId(key)
  const userId = acceptanceUserId(key)
  await dropAcceptanceOrg({ organizationId, userId })

  await prisma.user.create({ data: { id: userId, email: `acc-${key}@test.local`, name: `Aceptación ${key}` } })
  await prisma.organization.create({
    data: { id: organizationId, slug: `acc-${key}`, name: `Aceptación ${key}`, pgcVariant: "PYMES", updatedAt: new Date() },
  })
  await prisma.membership.create({
    data: { organizationId, userId, role: "ADMIN", acceptedAt: new Date(), updatedAt: new Date() },
  })

  if (opts.loadFixture !== false) {
    const report = await loadFixtureIntoOrg({
      fixture: opts.fixture ?? "ejercicio-completo",
      organizationId,
      userId,
    })
    if (report.mismatches.length > 0) {
      throw new Error(`El fixture no reproduce sus cifras selladas: ${report.mismatches.join(" · ")}`)
    }
  }

  const fiscalYearId = opts.loadFixture === false
    ? ""
    : await tenantTransaction(organizationId, userId, async (tx) =>
        (await tx.fiscalYear.findFirstOrThrow({ where: { code: "2026" } })).id
      )

  return { organizationId, userId, fiscalYearId, slug: `acc-${key}` }
}

/**
 * Vacía y borra la organización efímera. El vaciado de los libros lo hace el
 * script de operador (`resetOrganizationLedger`, con `app_maintenance`), que es
 * quien sabe el orden de las dependencias; lo que él conserva a propósito
 * (`RESET_ORG_PRESERVED`) se borra aquí porque la organización desaparece.
 */
export async function dropAcceptanceOrg(org: { organizationId: string; userId?: string }): Promise<void> {
  await resetOrganizationLedger(org.organizationId).catch(() => undefined)
  await withMaintenance(async (client) => {
    for (const table of [
      "manual_review_flags",
      "report_runs",
      "invariant_runs",
      "store_sweeps",
      "audit_logs",
      "prompt_versions",
      "counterparties",
      "invoice_series",
      "tax_rates",
      "organization_account_maps",
      "accounts",
      "currencies",
      "fields",
      "categories",
      "settings",
      "app_data",
      "progress",
      "invitations",
      "subscription_events",
      "platform_invoices",
      "subscriptions",
      "memberships",
    ]) {
      await client
        .query(`DELETE FROM ${table} WHERE organization_id = $1::uuid`, [org.organizationId])
        .catch(() => undefined)
    }
    await client.query(`DELETE FROM organizations WHERE id = $1::uuid`, [org.organizationId]).catch(() => undefined)
    if (org.userId) await client.query(`DELETE FROM users WHERE id = $1::uuid`, [org.userId]).catch(() => undefined)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Los tres roles de base de datos
// ─────────────────────────────────────────────────────────────────────────────

async function withClient<T>(connectionString: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/** Rol PROPIETARIO: migraciones, fixtures y lecturas de comprobación. */
export const withOwner = <T>(fn: (client: Client) => Promise<T>): Promise<T> =>
  withClient(ownerDatabaseUrl(), fn)

/** Rol de la aplicación (`app_runtime`, NOBYPASSRLS): el que tiene que chocar con los 42501. */
export const withRuntime = <T>(organizationId: string, fn: (client: Client) => Promise<T>): Promise<T> =>
  withClient(appRuntimeDatabaseUrl(), async (client) => {
    await client.query("SELECT set_config('app.current_org', $1, false)", [organizationId])
    return await fn(client)
  })

/** Rol de operador (`app_maintenance`, BYPASSRLS): vaciados e inyecciones sobre copia. */
export const withMaintenance = <T>(fn: (client: Client) => Promise<T>): Promise<T> =>
  withClient(process.env.DATABASE_URL_MAINTENANCE || appMaintenanceDatabaseUrl(), fn)

/** El código de error de Postgres, si la sentencia lo produjo. */
export async function sqlErrorCode(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn()
    return null
  } catch (error) {
    const code = (error as { code?: unknown }).code
    return typeof code === "string" ? code : "sin-codigo"
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// `validacion.json` por test
// ─────────────────────────────────────────────────────────────────────────────

export type CheckStatus = "PASS" | "FAIL" | "WARN" | "INFO"

export type AcceptanceCheck = {
  id: string
  status: CheckStatus
  evidencia: string
  query: string | null
}

export type AcceptanceValidacion = {
  run_id: string
  componente: string
  ledgerHash: string | null
  gitSha: string
  organizationId: string | null
  refDate: LocalDate
  sello?: { sello: string; motivos: string[] }
  checks: AcceptanceCheck[]
}

/**
 * Acumulador del `validacion.json` de un componente. Mismo formato que
 * `scripts/run-invariants.ts`: quien ya lo consume no se entera de nada.
 *
 * **Nunca un PASS que no se haya comprobado**: `add()` exige evidencia y el
 * fichero se escribe aunque el test falle (por eso se vuelca en `afterAll`).
 */
export class ValidacionRecorder {
  private readonly checks: AcceptanceCheck[] = []
  private ledgerHash: string | null = null
  private sello: { sello: string; motivos: string[] } | undefined

  constructor(
    readonly componente: string,
    private organizationId: string | null = null
  ) {}

  org(organizationId: string): void {
    this.organizationId = organizationId
  }

  hash(ledgerHash: string | null): void {
    this.ledgerHash = ledgerHash
  }

  seal(sello: string, motivos: readonly string[]): void {
    this.sello = { sello, motivos: [...motivos] }
  }

  add(id: string, status: CheckStatus, evidencia: string, query: string | null = null): void {
    if (evidencia.trim().length === 0) throw new Error(`El check ${id} no trae evidencia`)
    this.checks.push({ id, status, evidencia, query })
  }

  /** `PASS` si la condición se cumple, `FAIL` si no. La evidencia va siempre. */
  assert(id: string, condition: boolean, evidencia: string, query: string | null = null): boolean {
    this.add(id, condition ? "PASS" : "FAIL", evidencia, query)
    return condition
  }

  get failures(): readonly AcceptanceCheck[] {
    return this.checks.filter((check) => check.status === "FAIL")
  }

  snapshot(): AcceptanceValidacion {
    return {
      run_id: `${this.componente}-${ACCEPTANCE_GIT_SHA}`,
      componente: this.componente,
      ledgerHash: this.ledgerHash,
      gitSha: ACCEPTANCE_GIT_SHA,
      organizationId: this.organizationId,
      refDate: REF_DATE,
      ...(this.sello ? { sello: this.sello } : {}),
      checks: this.checks,
    }
  }

  /** Escribe `artifacts/acceptance/<componente>/validacion.json`. */
  async write(): Promise<string> {
    const dir = path.resolve(process.cwd(), "artifacts", "acceptance", this.componente)
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, "validacion.json")
    await writeFile(file, JSON.stringify(this.snapshot(), null, 2) + "\n", "utf8")
    return file
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Las 12 cifras y los 5 sellos, leídos del producto
// ─────────────────────────────────────────────────────────────────────────────

export type CanonicalReading = {
  /** Las doce cifras, tal y como las produce el sistema (no las esperadas). */
  figures: Record<string, number>
  seals: Record<SealName, string>
  invariantRunId: string
  validacionRunId: string
  sello: { sello: string; motivos: string[] }
  checks: readonly { id: string; status: string; evidencia: string }[]
}

/**
 * Lee las doce cifras y los cinco sellos **por el camino del producto**: un
 * barrido sellado (`InvariantRun`, que trae las cuatro cifras de cabecera y los
 * cinco sellos) y la matriz analítica (que trae los ocho niveles). El Σdebe/Σhaber
 * se toma del propio barrido (I1) y se cruza aparte con SQL en C3/C4.
 */
export async function readCanonical(org: AcceptanceOrg): Promise<CanonicalReading> {
  const { runLedgerInvariants } = await import("@/models/ledger")
  const { getAnalyticPnl } = await import("@/models/margins")
  const { latestInvariantRun } = await import("@/models/audit")
  const { tenantDb } = await import("@/lib/db")

  const run = await runLedgerInvariants(org.organizationId, {
    refDate: REF_DATE,
    fiscalYearId: org.fiscalYearId,
    gitSha: ACCEPTANCE_GIT_SHA,
    noCache: true,
    actor: { userId: org.userId },
    persist: { trigger: "MANUAL", scopeKind: "FISCAL_YEAR", runById: org.userId },
  })

  const row = await latestInvariantRun(tenantDb(org.organizationId))
  if (!row) throw new Error("El barrido sellado no dejó `InvariantRun`: sin él no hay cifras canónicas que leer")

  const pnl = await tenantTransaction(org.organizationId, org.userId, async (tx) =>
    getAnalyticPnl(tx, {
      ...RANGE,
      fiscalYearId: org.fiscalYearId,
      provenance: { runId: row.id, gitSha: ACCEPTANCE_GIT_SHA, baseCurrency: BASE_CURRENCY },
    })
  )

  const debeHaber = await tenantTransaction(org.organizationId, org.userId, async (tx) => {
    const rows = await tx.$queryRaw<{ debe: bigint; haber: bigint }[]>`
      SELECT COALESCE(SUM(debit_cents), 0)::bigint AS debe, COALESCE(SUM(credit_cents), 0)::bigint AS haber
        FROM journal_lines
       WHERE organization_id = ${org.organizationId}::uuid
         AND fiscal_year_id = ${org.fiscalYearId}::uuid`
    return { debe: Number(rows[0]?.debe ?? 0), haber: Number(rows[0]?.haber ?? 0) }
  })

  const figures: Record<string, number> = {
    DEBE: debeHaber.debe,
    HABER: debeHaber.haber,
    ACTIVO: row.headline.ACTIVO.cents,
    PN_MAS_PASIVO: row.headline.PN_MAS_PASIVO.cents,
    RESULTADO: row.headline.RESULTADO.cents,
    TESORERIA: row.headline.TESORERIA.cents,
  }
  for (const level of CANONICAL_LEVELS) {
    figures[level] = pnl.pnl.levelTotalsCents[level]
  }
  figures.RESULTADO_ANALITICO = pnl.pnl.levelTotalsCents.RESULTADO

  return {
    figures,
    seals: {
      ledgerHash: row.ledgerHash,
      analyticsKey: row.analyticsKey,
      planHash: row.planHash,
      accountMapHash: row.accountMapHash,
      configHash: row.configHash,
    },
    invariantRunId: row.id,
    validacionRunId: run.validacion.run_id,
    sello: { sello: run.sello.sello, motivos: [...run.sello.motivos] },
    checks: run.validacion.checks.map((check) => ({
      id: check.id,
      status: check.status,
      evidencia: check.evidencia,
    })),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// El segundo sustrato: el preview local
// ─────────────────────────────────────────────────────────────────────────────

export type PreviewSubstrate = { available: boolean; baseUrl: string | null; motivo: string }

/**
 * §3.1 pide **dos** sustratos: el fixture y el **preview local**. El preview no
 * se levanta desde dentro de un test —`docker compose up` + `prisma migrate
 * deploy` + siembra por el asistente tarda minutos y no cabe en un `beforeAll`—:
 * se levanta fuera (`npm run dev` o `docker compose up`) y se declara con
 * `ACCEPTANCE_PREVIEW_URL`.
 *
 * Lo que este helper garantiza es que **no hay PASS silencioso**: si el preview
 * no está, el test lo anota con `SIN_EVALUAR` en su `validacion.json` y lo dice
 * con su motivo; nunca se calla ni se pinta en verde (regla E-2 de §7.4).
 */
export async function previewSubstrate(): Promise<PreviewSubstrate> {
  const baseUrl = process.env.ACCEPTANCE_PREVIEW_URL ?? null
  if (!baseUrl) {
    return {
      available: false,
      baseUrl: null,
      motivo:
        "ACCEPTANCE_PREVIEW_URL no está definida: el preview local se levanta fuera de la suite " +
        "(`docker compose up` + `prisma migrate deploy` + siembra por el asistente) y se declara con esa variable",
    }
  }
  try {
    const response = await fetch(new URL("/api/health", baseUrl), { signal: AbortSignal.timeout(5_000) })
    if (!response.ok) {
      return { available: false, baseUrl, motivo: `el preview respondió ${response.status} en /api/health` }
    }
    return { available: true, baseUrl, motivo: `preview vivo en ${baseUrl}` }
  } catch (error) {
    return {
      available: false,
      baseUrl,
      motivo: `el preview declarado en ${baseUrl} no responde: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** Cierra el pool de Prisma. Lo llama el `afterAll` de cada fichero. */
export const disconnect = async (): Promise<void> => {
  await prisma.$disconnect()
}
