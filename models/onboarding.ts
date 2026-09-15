/**
 * E11 · ola C · **T12** — la siembra ATÓMICA y el estado del asistente de alta.
 * (docs/design/E11-plataforma-saas.md §6, ADR-0019; invariante **I-E11-10**.)
 *
 * Tres ideas gobiernan este fichero, y las tres vienen de una lección que ya se
 * pagó dos veces:
 *
 *  1. **Una sola puerta de siembra.** `seedOrganization` es la única; la usan el
 *     asistente, `app/(app)/organizations/actions.ts`, los scripts de operador y
 *     el arnés de los e2e. Cuando hay dos puertas, una siembra la pieza y la otra
 *     no, y el invariante que la vigila pasa por vacuidad (R-2 de E9).
 *  2. **Todo en el paso 1, y dentro de la transacción de la organización.** Las
 *     nueve piezas nacen con la organización o no nace nada (O-7). En la ronda 1
 *     del diseño, las series se creaban en el paso 4: quien abandonaba en el paso
 *     3 dejaba **I-E11-10 fallando con datos limpios**, y un invariante que falla
 *     con datos limpios no distingue una manipulación.
 *  3. **La demo va a su propia organización** (O-6). Nunca dentro de la del
 *     cliente: sin marca por fila, I-E11-1 fallaría en toda organización con
 *     demo, y «vaciar la demo» acabaría borrando asientos posteados, contra el
 *     append-only de ADR-0003 y el art. 30 CCom. **No existe ningún botón que
 *     borre un asiento posteado.** Vaciar la demo es borrar la organización de
 *     demo entera, que no tiene asientos ajenos.
 *
 * Ninguna cifra contable se calcula aquí: se cuentan piezas y se comprueba que
 * existen.
 */

import { SEED_TRANSACTION_OPTIONS, tenantDb, tenantTransaction, withTenantGucs } from "@/lib/db"
import type { TenantClient, TenantTransactionClient } from "@/lib/db"
import type { AnyClient } from "@/models/ledger"
import { REQUIRED_ACCOUNT_KEYS } from "@/lib/accounts/map"
import type { LocalDate } from "@/lib/ledger/types"
import { fromUtcDate, toUtcDate } from "@/lib/ledger/dates"
import { seedReclassificationPairs } from "@/models/closing"
import { createOrganizationDefaults } from "@/models/defaults"
import { createOrganizationWithOwner, type CreateOrganizationInput } from "@/models/organizations"
import { writeAuditLog } from "@/models/audit-log"
import {
  InvoiceSeriesKind,
  OnboardingStep,
  PgcVariant,
  Role,
  type OnboardingRun,
  type Organization,
} from "@/prisma/client"

// ─────────────────────────────────────────────────────────────────────────────
// El informe de siembra: las NUEVE piezas de I-E11-10 (O-7c)
// ─────────────────────────────────────────────────────────────────────────────

/** Las nueve piezas, en el orden en que el asistente las enseña. */
export const SEED_PIECES = [
  "plan",
  "accountMap",
  "fiscalYear",
  "invoiceSeries",
  "reclassificationPairs",
  "marginLevels",
  "onboardingRun",
  "taxRates",
  "currency",
] as const

export type SeedPieceKey = (typeof SEED_PIECES)[number]

export type SeedPiece = {
  key: SeedPieceKey
  /** Texto en español contable: es lo que ve el cliente en el asistente. */
  label: string
  /** Lo contado. `null` cuando la pieza no es contable (se declara `detail`). */
  count: number | null
  /** Lo que la pieza exige para estar completa. */
  expected: string
  ok: boolean
  detail?: string
}

export type SeedReport = {
  organizationId: string
  seededAt: string
  pieces: SeedPiece[]
  /** Las NUEVE en verde. Es lo mismo que comprueba I-E11-10 (T20). */
  ok: boolean
}

/**
 * Lo que la siembra necesita saber. Nada de esto se adivina: la variante, la
 * moneda y el prefijo de la serie son decisiones del cliente en el paso 1.
 */
export type SeedSpec = {
  pgcVariant: PgcVariant
  baseCurrency: string
  /** Prefijo de la serie ORDINARIA. Renombrable mientras no haya número emitido. */
  seriesPrefix: string
  /** Por defecto, el AÑO NATURAL de `now` (ejercicio provisional, O-7b). */
  fiscalYearStart?: LocalDate
  fiscalYearEnd?: LocalDate
  useSubaccounts?: boolean
}

const DEFAULT_SERIES_PREFIX = "FAC"
const RECTIFICATIVA_PREFIX_SUFFIX = "-R"

/** Prefijo por defecto de la rectificativa: el de la ordinaria con `-R`. */
export const rectificativePrefixOf = (prefix: string): string =>
  `${prefix}${RECTIFICATIVA_PREFIX_SUFFIX}`.slice(0, 16)

/** El año natural de una fecha, como ejercicio provisional (O-7b). */
export function naturalYearWindow(now: Date): { code: string; startDate: LocalDate; endDate: LocalDate } {
  const year = now.getUTCFullYear()
  return { code: String(year), startDate: `${year}-01-01`, endDate: `${year}-12-31` }
}

// ─────────────────────────────────────────────────────────────────────────────
// La siembra
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **La única puerta de siembra.** Se ejecuta DENTRO de la transacción que crea la
 * organización (`createOrganizationWithOwner({ seed })`), de modo que un fallo al
 * sembrar el mapa no deja una organización sin plan: revierte todo (criterio 44).
 *
 * Orden, y por qué:
 *
 *  1. **El ejercicio provisional PRIMERO.** `seedAnalyticsDefaults` fecha el
 *     `MarginLevelConfig` en el inicio del ejercicio más antiguo y, sin ninguno,
 *     lo deja en 1970-01-01. Con el ejercicio ya creado, la configuración de
 *     márgenes nace vigente desde el primer día del ejercicio, que es lo que
 *     `/analytics` espera.
 *  2. `createOrganizationDefaults`: proyectos, categorías **con su
 *     deducibilidad**, monedas, campos, settings, plan NPGC, mapa de cuentas de
 *     sistema, tipos impositivos, dimensiones analíticas y los 22 pares.
 *  3. Las series `ORDINARIA` y `RECTIFICATIVA`, con el contador **a cero**
 *     (`nextNumber = 1`): I-E8-20 sigue en `INFO` hasta la primera factura, que
 *     es su contrato, y el prefijo se puede renombrar mientras eso dure.
 *  4. La moneda base, si no viniera en el catálogo por defecto.
 *  5. El `OnboardingRun`, con su informe dentro.
 */
export async function seedOrganization(
  tx: TenantTransactionClient,
  spec: SeedSpec,
  now: Date,
  userId?: string | null
): Promise<SeedReport> {
  const organizationId = tx.$organizationId

  // 1 · Ejercicio provisional por año natural (O-7b). UNO solo: el paso 3 lo
  // EDITA mientras no tenga asientos, nunca crea otro.
  const window = {
    ...naturalYearWindow(now),
    ...(spec.fiscalYearStart && spec.fiscalYearEnd
      ? { startDate: spec.fiscalYearStart, endDate: spec.fiscalYearEnd }
      : {}),
  }
  const existingYears = await tx.fiscalYear.findMany({ select: { id: true } })
  if (existingYears.length === 0) {
    await tx.fiscalYear.create({
      data: {
        organizationId,
        code: window.code,
        startDate: toUtcDate(window.startDate),
        endDate: toUtcDate(window.endDate),
        status: "OPEN",
        lastEntryNumber: 0,
      },
    })
  }

  // 2 · El resto de la semilla heredada, que ya es idempotente.
  await createOrganizationDefaults(tenantDb(organizationId), {
    pgcVariant: spec.pgcVariant,
    now,
    userId: userId ?? null,
  })

  // Cinturón y tirantes sobre los 22 pares: `createOrganizationDefaults` los
  // siembra, pero esta función es la puerta y no puede depender de que la otra
  // no cambie. Es idempotente: si ya están, no hace nada.
  await seedReclassificationPairs(tx, { userId: userId ?? null })

  // 3 · Las dos series, con el contador a CERO (O-7a, D-2).
  const prefix = (spec.seriesPrefix || DEFAULT_SERIES_PREFIX).trim().toUpperCase().slice(0, 16)
  for (const [code, kind, seriesPrefix] of [
    ["ORDINARIA", InvoiceSeriesKind.ORDINARIA, prefix],
    ["RECTIFICATIVA", InvoiceSeriesKind.RECTIFICATIVA, rectificativePrefixOf(prefix)],
  ] as const) {
    const already = await tx.invoiceSeries.findFirst({ where: { code } })
    if (already) continue
    await tx.invoiceSeries.create({
      data: { organizationId, code, kind, prefix: seriesPrefix, nextNumber: 1, isActive: true },
    })
  }

  // 4 · La moneda base. Sin `Currency` de la moneda base no hay conversión
  // posible y RC-14 deja la organización sin poder contabilizar en divisa.
  const baseCurrency = (spec.baseCurrency || "EUR").toUpperCase()
  const currency = await tx.currency.findFirst({ where: { code: baseCurrency } })
  if (!currency) {
    await tx.currency.create({ data: { organizationId, code: baseCurrency, name: baseCurrency } })
  }

  // 5 · El asistente, con su informe.
  const report = await buildSeedReport(tx, now)
  await tx.onboardingRun.upsert({
    where: { organizationId },
    update: { pgcVariant: spec.pgcVariant, seedReport: report as unknown as object },
    create: {
      organizationId,
      pgcVariant: spec.pgcVariant,
      step: OnboardingStep.PLAN_ACCOUNTS,
      seedReport: report as unknown as object,
    },
  })

  await writeAuditLog(tx, {
    entity: "Organization",
    entityId: organizationId,
    action: "seed",
    after: { pieces: report.pieces.map((p) => `${p.key}=${p.count ?? p.detail ?? "—"}`), ok: report.ok },
    userId: userId ?? null,
  })

  // El informe se recalcula después del upsert para que la pieza
  // `onboardingRun` salga en verde en lo que se devuelve al asistente.
  return await buildSeedReport(tx, now)
}

/**
 * Cuenta las nueve piezas **contra la base**, no contra lo que la siembra creyó
 * hacer. Es el espejo en la aplicación de I-E11-10 (T20, familia `PLATAFORMA`);
 * el invariante lo repite en su contexto y con su sello.
 *
 * Nunca un PASS que no se haya comprobado: lo que no se puede evaluar sale `ok:
 * false` con el motivo, no en verde por omisión.
 */
export async function buildSeedReport(db: AnyClient, now: Date): Promise<SeedReport> {
  const organizationId = db.$organizationId

  const postableAccounts = await db.ledgerAccount.count({ where: { isPostable: true, isActive: true } })
  const mapEntries = await db.organizationAccountMap.findMany({ select: { key: true } })
  const mapKeys = new Set(mapEntries.map((e) => e.key as string))
  const missingKeys = REQUIRED_ACCOUNT_KEYS.filter((key) => !mapKeys.has(key))

  const fiscalYears = await db.fiscalYear.findMany({ select: { code: true, startDate: true, endDate: true } })
  const overlapping = fiscalYears.some((a, i) =>
    fiscalYears.some((b, j) => i !== j && a.startDate <= b.endDate && a.endDate >= b.startDate)
  )

  const series = await db.invoiceSeries.findMany({ select: { kind: true, prefix: true, nextNumber: true } })
  const hasOrdinaria = series.some((s) => s.kind === InvoiceSeriesKind.ORDINARIA)
  const hasRectificativa = series.some((s) => s.kind === InvoiceSeriesKind.RECTIFICATIVA)

  const pairs = await db.reclassificationPair.count()
  const levels = await db.marginLevelConfig.count()
  const run = await db.onboardingRun.findFirst({ select: { id: true, step: true } })

  // `TaxRate` vigente de IVA **y** de IRPF: la novena pieza que O-7c añadió. Sin
  // ella `postFromProposal` no puede construir la línea de IVA y el camino
  // documental completo de E8 queda muerto.
  const today = toUtcDate(fromUtcDate(now))
  const rates = await db.taxRate.findMany({
    where: { validFrom: { lte: today }, OR: [{ validTo: null }, { validTo: { gte: today } }] },
    select: { code: true, kind: true },
  })
  const hasIva = rates.some((r) => String(r.kind) === "IVA")
  const hasIrpf = rates.some((r) => String(r.kind) === "IRPF")

  const organization = await withOrganization(organizationId)
  const baseCurrency = (organization?.baseCurrency ?? "EUR").toUpperCase()
  const currency = await db.currency.findFirst({ where: { code: baseCurrency } })
  // Si la moneda base no es el euro hace falta además una tasa accesible: con
  // RC-14 la organización no podría convertir nada.
  const needsRate = baseCurrency !== "EUR"
  const rateCount = needsRate ? await db.exchangeRate.count() : 0

  const pieces: SeedPiece[] = [
    {
      key: "plan",
      label: "Plan General Contable",
      count: postableAccounts,
      expected: "al menos una cuenta postable y activa",
      ok: postableAccounts > 0,
    },
    {
      key: "accountMap",
      label: "Mapa de cuentas de sistema",
      count: mapKeys.size,
      expected: `las ${REQUIRED_ACCOUNT_KEYS.length} claves obligatorias`,
      ok: missingKeys.length === 0,
      detail: missingKeys.length > 0 ? `Faltan: ${missingKeys.slice(0, 5).join(", ")}` : undefined,
    },
    {
      key: "fiscalYear",
      label: "Ejercicio contable",
      count: fiscalYears.length,
      expected: "exactamente uno, sin solape",
      ok: fiscalYears.length === 1 && !overlapping,
      detail: overlapping ? "Hay ejercicios solapados" : undefined,
    },
    {
      key: "invoiceSeries",
      label: "Series de facturación",
      count: series.length,
      expected: "ORDINARIA y RECTIFICATIVA",
      ok: hasOrdinaria && hasRectificativa,
      detail: series.map((s) => `${s.prefix} (nº ${s.nextNumber - 1} emitido)`).join(" · ") || undefined,
    },
    {
      key: "reclassificationPairs",
      label: "Pares de reclasificación largo/corto plazo",
      count: pairs,
      expected: "22 pares",
      ok: pairs >= 22,
    },
    {
      key: "marginLevels",
      label: "Niveles de margen de la analítica",
      count: levels,
      expected: "al menos un nivel vigente",
      ok: levels > 0,
    },
    {
      key: "onboardingRun",
      label: "Asistente de alta",
      count: run ? 1 : 0,
      expected: "una ejecución registrada",
      ok: run !== null,
      detail: run ? `Paso ${run.step}` : undefined,
    },
    {
      key: "taxRates",
      label: "Tipos impositivos vigentes",
      count: rates.length,
      expected: "IVA e IRPF vigentes hoy",
      ok: hasIva && hasIrpf,
      detail: !hasIva ? "Sin tipo de IVA vigente" : !hasIrpf ? "Sin tipo de IRPF vigente" : undefined,
    },
    {
      key: "currency",
      label: `Moneda base (${baseCurrency})`,
      count: currency ? 1 : 0,
      expected: needsRate ? "la moneda y al menos un tipo de cambio" : "la moneda dada de alta",
      ok: currency !== null && (!needsRate || rateCount > 0),
      detail: needsRate && rateCount === 0 ? "Sin tipo de cambio accesible" : undefined,
    },
  ]

  return {
    organizationId,
    seededAt: now.toISOString(),
    pieces,
    ok: pieces.every((p) => p.ok),
  }
}

/** La organización, leída con su GUC puesto (no está en `TENANT_MODELS`). */
async function withOrganization(organizationId: string): Promise<Organization | null> {
  return await withTenantGucs(organizationId, undefined, async (tx) =>
    tx.organization.findUnique({ where: { id: organizationId } })
  )
}

/**
 * Alta completa: organización + membresía ADMIN + las nueve piezas, **en una sola
 * transacción**. Falla al sembrar ⇒ no nace nada (criterio 44).
 */
export async function createOrganizationWithSeed(
  input: CreateOrganizationInput & { seriesPrefix?: string },
  ownerUserId: string,
  now: Date
): Promise<{ organization: Organization; report: SeedReport }> {
  let report: SeedReport | null = null
  const organization = await createOrganizationWithOwner(input, ownerUserId, now, {
    seed: async (organizationId) => {
      report = await tenantTransaction(organizationId, ownerUserId, async (tx) =>
        seedOrganization(
          tx,
          {
            pgcVariant: input.pgcVariant ?? PgcVariant.PYMES,
            baseCurrency: input.baseCurrency ?? "EUR",
            seriesPrefix: input.seriesPrefix ?? DEFAULT_SERIES_PREFIX,
          },
          now,
          ownerUserId
        )
      )
    },
    transaction: SEED_TRANSACTION_OPTIONS,
  })
  if (!report) throw new Error("La siembra no devolvió informe")
  return { organization, report }
}

// ─────────────────────────────────────────────────────────────────────────────
// El estado del asistente
// ─────────────────────────────────────────────────────────────────────────────

export type OnboardingView = {
  run: OnboardingRun | null
  report: SeedReport | null
  /** La demo, si se creó desde este asistente y sigue viva. */
  demo: { id: string; name: string; slug: string } | null
}

export async function readOnboarding(db: AnyClient, now: Date): Promise<OnboardingView> {
  const run = await db.onboardingRun.findFirst()
  if (!run) return { run: null, report: null, demo: null }
  const report = await buildSeedReport(db, now)
  const demo = run.demoOrganizationId
    ? await withTenantGucs(run.demoOrganizationId, undefined, async (tx) =>
        tx.organization.findUnique({
          where: { id: run.demoOrganizationId as string },
          select: { id: true, name: true, slug: true },
        })
      )
    : null
  return { run, report, demo }
}

/** Avanza (o retrocede: «volver atrás» sin perder lo escrito) el asistente. */
export async function setOnboardingStep(db: TenantClient, step: OnboardingStep): Promise<OnboardingRun> {
  const run = await db.onboardingRun.findFirst()
  if (!run) throw new Error("Esta organización no tiene asistente de alta")
  return await db.onboardingRun.update({ where: { id: run.id }, data: { step } })
}

/** Paso 6: listo. `completedAt` es lo que cierra el asistente. */
export async function completeOnboarding(db: TenantClient, now: Date): Promise<OnboardingRun> {
  const run = await db.onboardingRun.findFirst()
  if (!run) throw new Error("Esta organización no tiene asistente de alta")
  return await db.onboardingRun.update({
    where: { id: run.id },
    data: { step: OnboardingStep.DONE, completedAt: run.completedAt ?? now },
  })
}

export class OnboardingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OnboardingError"
  }
}

/**
 * **Criterio 43.** Renombrar el prefijo de una serie es legal **sólo** mientras no
 * haya emitido ningún número (art. 6.1.a RD 1619/2012): a partir del primero, la
 * serie es el identificador de facturas ya expedidas y renombrarla las reescribe.
 * `nextNumber = 1` ⇔ `lastNumber = 0` ⇔ ningún número emitido.
 */
export async function renameSeriesPrefix(
  db: TenantClient,
  input: { seriesId: string; prefix: string },
  userId?: string | null
): Promise<{ id: string; prefix: string }> {
  const series = await db.invoiceSeries.findFirst({ where: { id: input.seriesId } })
  if (!series) throw new OnboardingError("La serie no existe en esta organización")
  if (series.nextNumber > 1) {
    throw new OnboardingError(
      `La serie ${series.prefix} ya ha emitido ${series.nextNumber - 1} factura(s): su prefijo no se puede cambiar ` +
        "(art. 6.1.a RD 1619/2012). Para otro prefijo, otra serie."
    )
  }
  const prefix = input.prefix.trim().toUpperCase().slice(0, 16)
  if (prefix.length === 0) throw new OnboardingError("El prefijo no puede estar vacío")

  const updated = await db.invoiceSeries.update({ where: { id: series.id }, data: { prefix } })
  await writeAuditLog(db, {
    entity: "InvoiceSeries",
    entityId: series.id,
    action: "update",
    before: { prefix: series.prefix },
    after: { prefix },
    userId: userId ?? null,
  })
  return { id: updated.id, prefix: updated.prefix }
}

/**
 * **Paso 3, criterio 42.** EDITA el ejercicio provisional; no crea otro. Sólo
 * mientras no tenga asientos: con un asiento dentro, mover las fechas cambiaría
 * el ejercicio al que pertenece un hecho ya registrado.
 */
export async function updateProvisionalFiscalYear(
  db: TenantClient,
  input: { startDate: LocalDate; endDate: LocalDate; code?: string },
  userId?: string | null
): Promise<{ id: string; code: string; startDate: LocalDate; endDate: LocalDate }> {
  if (input.endDate <= input.startDate) {
    throw new OnboardingError("La fecha de fin del ejercicio tiene que ser posterior a la de inicio")
  }
  const years = await db.fiscalYear.findMany({ orderBy: { startDate: "asc" } })
  if (years.length === 0) throw new OnboardingError("Esta organización no tiene ningún ejercicio")
  if (years.length > 1) {
    throw new OnboardingError("Esta organización ya tiene más de un ejercicio: edítalos en Configuración → Ejercicios")
  }
  const year = years[0]
  const entries = await db.journalEntry.count({ where: { fiscalYearId: year.id } })
  if (entries > 0) {
    throw new OnboardingError(
      `El ejercicio ${year.code} ya tiene ${entries} asiento(s): sus fechas no se pueden cambiar desde el asistente`
    )
  }

  const updated = await db.fiscalYear.update({
    where: { id: year.id },
    data: {
      code: input.code?.trim() || year.code,
      startDate: toUtcDate(input.startDate),
      endDate: toUtcDate(input.endDate),
    },
  })
  await writeAuditLog(db, {
    entity: "FiscalYear",
    entityId: year.id,
    action: "update",
    before: { code: year.code, startDate: fromUtcDate(year.startDate), endDate: fromUtcDate(year.endDate) },
    after: { code: updated.code, startDate: input.startDate, endDate: input.endDate },
    userId: userId ?? null,
  })
  return {
    id: updated.id,
    code: updated.code,
    startDate: fromUtcDate(updated.startDate),
    endDate: fromUtcDate(updated.endDate),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// La demo, en su propia organización (O-6)
// ─────────────────────────────────────────────────────────────────────────────

export type DemoResult = {
  organizationId: string
  name: string
  /** Asientos posteados POR EL MOTOR. La demo es un test de humo de producción. */
  entries: number
  ledgerHash: string
}

/**
 * Crea `Demo — <nombre>` con `isDemo` (inmutable por trigger) y carga en ella el
 * fixture `ejercicio-completo` **por el camino del producto**: `postEntry`, con
 * su validación C-1…C-13, su `FOR UPDATE` y sus triggers. Si el fixture no se
 * puede cargar por ahí, el producto está roto, y nos enteramos en el alta y no en
 * el sprint siguiente — que es exactamente lo que pasó con
 * `ejercicio-completo-v2`.
 *
 * La demo **no cuenta** contra `maxOrganizations`, no entra en el uso y se puede
 * borrar entera.
 */
export async function createDemoOrganization(
  ownerUserId: string,
  sourceOrganizationName: string,
  now: Date
): Promise<DemoResult> {
  const name = `Demo — ${sourceOrganizationName}`.slice(0, 120)

  const organization = await createOrganizationWithOwner(
    { name, pgcVariant: PgcVariant.PYMES, baseCurrency: "EUR" },
    ownerUserId,
    now,
    {
      seed: async (organizationId) => {
        // La demo se marca ANTES de tener una sola fila: `isDemo` es inmutable, así
        // que no hay una segunda oportunidad de ponerlo.
        await withTenantGucs(organizationId, ownerUserId, async (tx) => {
          await tx.$executeRaw`UPDATE organizations SET is_demo = true WHERE id = ${organizationId}::uuid`
        })
      },
      transaction: SEED_TRANSACTION_OPTIONS,
    }
  )

  // El cargador vive en `scripts/` y arrastra los fixtures: import dinámico para
  // no meterlo en el bundle de la aplicación. Si no está disponible (despliegue
  // sin los fixtures), se dice, no se inventa una demo vacía.
  let loadFixtureIntoOrg: (typeof import("@/scripts/load-fixture"))["loadFixtureIntoOrg"]
  try {
    ;({ loadFixtureIntoOrg } = await import("@/scripts/load-fixture"))
  } catch {
    throw new OnboardingError(
      "Los datos de demostración no están disponibles en esta instalación. La organización de demo se ha creado vacía."
    )
  }

  const report = await loadFixtureIntoOrg({
    fixture: "ejercicio-completo",
    organizationId: organization.id,
    userId: ownerUserId,
  })

  return {
    organizationId: organization.id,
    name: organization.name,
    entries: (report as { entries?: number }).entries ?? 0,
    ledgerHash: (report as { ledgerHash?: string }).ledgerHash ?? "",
  }
}

/** Ata la demo a la ejecución del asistente que la pidió. */
export async function linkDemoOrganization(db: TenantClient, demoOrganizationId: string): Promise<void> {
  const run = await db.onboardingRun.findFirst()
  if (!run) throw new OnboardingError("Esta organización no tiene asistente de alta")
  await db.onboardingRun.update({ where: { id: run.id }, data: { demoOrganizationId } })
}

/**
 * **«Vaciar la demo» = borrar la organización de demo ENTERA** (O-6, criterio 46).
 * No hay ningún camino que borre un asiento posteado: se borra el contenedor, que
 * por construcción no tiene asientos ajenos, y sólo si `isDemo` es cierto.
 */
export async function deleteDemoOrganization(
  db: TenantClient,
  demoOrganizationId: string,
  userId?: string | null
): Promise<void> {
  const demo = await withOrganization(demoOrganizationId)
  if (!demo) throw new OnboardingError("Esa organización de demostración ya no existe")
  if (!demo.isDemo) {
    throw new OnboardingError(
      "Esa organización no está marcada como demostración: no se borra. Sólo se borra entera una organización de demo."
    )
  }

  const run = await db.onboardingRun.findFirst()
  if (run?.demoOrganizationId === demoOrganizationId) {
    await db.onboardingRun.update({ where: { id: run.id }, data: { demoOrganizationId: null } })
  }

  await writeAuditLog(db, {
    entity: "Organization",
    entityId: demoOrganizationId,
    action: "delete",
    before: { name: demo.name, isDemo: true },
    reason: "Vaciado de los datos de demostración (O-6): se borra la organización de demo entera",
    userId: userId ?? null,
  })

  // El borrado va con el GUC de la PROPIA demo: su política RLS es la que tiene
  // que autorizarlo, no la de la organización del cliente.
  await withTenantGucs(demoOrganizationId, userId ?? undefined, async (tx) => {
    await tx.$executeRaw`DELETE FROM organizations WHERE id = ${demoOrganizationId}::uuid AND is_demo = true`
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Paso 4 — el equipo
// ─────────────────────────────────────────────────────────────────────────────

export type MemberInvite = { email: string; role: Role }

/**
 * Forma mínima de un correo. No pretende validar la RFC —eso lo hace el envío—,
 * sino no dar por invitado a alguien cuyo texto no puede ser una dirección: un
 * `@` suelto no es una invitación pendiente, es una errata.
 */
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/** Emails y rol del paso 4, normalizados y sin duplicados. */
export function parseMemberInvites(raw: string, role: Role = Role.EDITOR): MemberInvite[] {
  const seen = new Set<string>()
  const invites: MemberInvite[] = []
  for (const chunk of raw.split(/[\s,;]+/)) {
    const email = chunk.trim().toLowerCase()
    if (!EMAIL_SHAPE.test(email) || seen.has(email)) continue
    seen.add(email)
    invites.push({ email, role })
  }
  return invites
}
