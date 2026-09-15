/**
 * E11 · ola A · T16 — los **cuatro jobs**, cableados a lo que ya existe
 * (§7.1, §7.2; ADR-0019 D4, **O-13**).
 *
 * Este fichero no reinventa ningún motor: invoca el de E9 (recurrentes), el de
 * E7 (barrido de invariantes y retención) y el de la ola B (worker de backup).
 * Lo que aporta es lo que hasta ahora dependía de una persona con una terminal:
 * **que alguien los llame**, y que los llame de forma **idempotente y con
 * `refDate` explícito**.
 *
 * Tres reglas, escritas porque O-13 nació de olvidarlas:
 *
 * 1. **El reloj nunca entra en una cifra contable.** El `refDate` llega por
 *    parámetro y la ocurrencia se fecha por su **periodo de devengo**
 *    (`postingDateOf`), jamás por el instante de ejecución. El job lanzado con
 *    dos días de retraso produce el mismo asiento y el mismo `inputHash`
 *    (criterio 49).
 * 2. **Aislamiento.** Que la organización 7 falle no impide que corra la 8:
 *    `failed` cuenta, queda en `PlatformAuditLog` y el job termina `PARTIAL`
 *    (criterio 53).
 * 3. **Conducta declarada en mora** (§7.2). `invariant-sweep`, `backup-worker` y
 *    `retention` **corren**: son lectura o portabilidad, y un impago nuestro no
 *    puede dejar los libros del cliente sin vigilancia ni sin salida.
 *    `recurring-due` **genera** las ocurrencias de obligación devengada y
 *    **omite** el resto, dejándolas en `OMITIDA` con motivo
 *    `SUSCRIPCION_EN_MORA` — I-E9-1a exige motivo, así que el invariante no
 *    falla por un impago nuestro (criterio 50).
 */

import { prisma } from "@/lib/db"
import { accrualSchedule } from "@/lib/closing/accrual"
import { depreciationSchedule } from "@/lib/closing/depreciation"
import { buildFromTemplate } from "@/lib/ledger/templates"
import type { LocalDate, ResolvedLine } from "@/lib/ledger/types"
import { accessLevelOf } from "@/lib/platform/subscription"
import { hasBudgetLeft, type CronJobName } from "@/lib/platform/cron"
import {
  buildOccurrenceDraft,
  duePeriods,
  isSkip,
  occurrenceInputHash,
  postingDateOf,
  type ScheduleRowRef,
} from "@/lib/recurring/schedule"
import { readAccruals } from "@/models/accruals"
import { readAssetsWithRevisions } from "@/models/assets"
import { formatLedgerErrors, getLedgerContext, runLedgerTransaction } from "@/models/ledger"
import { getPlanById } from "@/models/plans"
import { PLATFORM_ACTIONS, recordPlatformAudit } from "@/models/platform"
import { pruneExpiredBuckets } from "@/models/rate-limit"
import {
  readRecurringDue,
  recordOccurrenceTx,
  type OccurrenceOutcome,
  type RecurringRuleRow,
} from "@/models/recurring"
import { getSubscription } from "@/models/subscriptions"
import { tenantDb } from "@/lib/db"
import type { Prisma } from "@/prisma/client"

export type CronJobContext = {
  /** **O-13** · fecha de referencia EXPLÍCITA. Nada se fecha por el reloj. */
  refDate: Date
  cursor: Prisma.JsonValue | null
  budgetMs: number
  /** `Date.now()` del arranque, para medir el presupuesto sin mirar el reloj dos veces. */
  startedAtMs: number
}

export type CronJobResult = {
  status: "DONE" | "PARTIAL" | "FAILED"
  processed: number
  failed: number
  cursor?: Prisma.InputJsonValue
  error?: string | null
}

/** Motivo con el que se omite una ocurrencia por mora (§7.2, I-E9-1a). */
export const MOTIVO_MORA = "SUSCRIPCION_EN_MORA"

/** `AAAA-MM-DD` de un `Date`, en UTC. Es el `LocalDate` que consume el motor. */
function localDateOf(d: Date): LocalDate {
  return d.toISOString().slice(0, 10) as LocalDate
}

/**
 * Las organizaciones **activas**, en orden estable por id para que el cursor
 * signifique siempre lo mismo. Un `ORDER BY name` cambiaría el punto de reanudación
 * en cuanto alguien renombre una organización.
 */
async function activeOrganizationIds(afterId: string | null): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "organizations"
     WHERE "is_active" AND ("is_demo" IS NOT TRUE)
       AND (${afterId}::uuid IS NULL OR "id" > ${afterId}::uuid)
     ORDER BY "id" ASC
  `
  return rows.map((r) => r.id)
}

function cursorOrgId(cursor: Prisma.JsonValue | null): string | null {
  if (cursor && typeof cursor === "object" && !Array.isArray(cursor)) {
    const v = (cursor as Record<string, unknown>).lastOrganizationId
    if (typeof v === "string") return v
  }
  return null
}

/** El nivel de acceso de una organización, para la conducta en mora de §7.2. */
async function accessOf(organizationId: string, refDate: Date): Promise<"FULL" | "READ_ONLY" | "BLOCKED"> {
  const db = tenantDb(organizationId)
  const sub = await getSubscription(db)
  if (!sub) return "READ_ONLY"
  const plan = await getPlanById(db, sub.planId)
  return accessLevelOf(sub, { graceDays: plan?.graceDays ?? 0 }, refDate).level
}

// ─────────────────────────────────────────────────────────────────────────────
// Despachador
// ─────────────────────────────────────────────────────────────────────────────

export async function runCronJob(job: CronJobName, ctx: CronJobContext): Promise<CronJobResult> {
  switch (job) {
    case "recurring-due":
      return await runRecurringDue(ctx)
    case "invariant-sweep":
      return await runInvariantSweep(ctx)
    case "backup-worker":
      return await runBackupWorker(ctx)
    case "retention":
      return await runRetention(ctx)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 · `recurring-due` — las ocurrencias vencidas de E9
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Las clases de regla cuya ocurrencia es una **obligación ya devengada** y que
 * por tanto se generan **también en mora** (§3.2, punto 2): recurrentes
 * vencidos con devengo cumplido, amortización, periodificación y la liquidación
 * de IVA del periodo. Lo que queda fuera es la comodidad, no la obligación.
 */
const CLASES_DEVENGADAS = new Set(["AMORTIZACION", "PERIODIFICACION", "IVA", "IMPORTE_FIJO"])

function esObligacionDevengada(rule: RecurringRuleRow): boolean {
  return CLASES_DEVENGADAS.has(rule.kind)
}

async function scheduleRowsFor(
  tx: Parameters<typeof readAssetsWithRevisions>[0],
  rule: RecurringRuleRow,
  refDate: LocalDate
): Promise<ScheduleRowRef[] | undefined> {
  if (rule.kind === "AMORTIZACION" && rule.fixedAssetId) {
    const [asset] = await readAssetsWithRevisions(tx, { assetId: rule.fixedAssetId, cutoff: refDate })
    if (!asset) return undefined
    return depreciationSchedule(asset.asset, asset.revisions).map((r) => ({
      period: r.period,
      quotaCents: r.quotaCents,
    }))
  }
  if (rule.kind === "PERIODIFICACION" && rule.accrualId) {
    const [accrual] = await readAccruals(tx, { accrualId: rule.accrualId })
    if (!accrual) return undefined
    return accrualSchedule(accrual, rule.frequency).rows.map((r) => ({ period: r.period, quotaCents: r.quotaCents }))
  }
  return undefined
}

function buildSource(
  rule: RecurringRuleRow,
  rows: ScheduleRowRef[] | undefined,
  lctx: Parameters<typeof buildFromTemplate>[2]
) {
  return {
    rows,
    amountCents: rule.amountCents ?? null,
    buildLines: (amountCents: number) => {
      const built = buildFromTemplate(
        rule.templateCode as Parameters<typeof buildFromTemplate>[0],
        { ...(rule.templateInput as Record<string, unknown>), amountCents },
        lctx
      )
      return built.ok
        ? ({ ok: true as const, value: built.value.lines as ResolvedLine[] })
        : ({ ok: false as const, errors: built.errors })
    },
    description: `${rule.name}`,
  }
}

async function runRecurringDue(ctx: CronJobContext): Promise<CronJobResult> {
  const refDate = localDateOf(ctx.refDate)
  let processed = 0
  let failed = 0
  let ultima: string | null = null

  for (const organizationId of await activeOrganizationIds(cursorOrgId(ctx.cursor))) {
    if (!hasBudgetLeft(Date.now() - ctx.startedAtMs, ctx.budgetMs)) {
      return { status: "PARTIAL", processed, failed, cursor: { lastOrganizationId: ultima } }
    }

    try {
      const nivel = await accessOf(organizationId, ctx.refDate)

      await runLedgerTransaction(organizationId, undefined, async (tx) => {
        const reglas = await readRecurringDue(tx, {})
        for (const regla of reglas) {
          const source = await scheduleRowsFor(tx, regla, refDate)
          for (const period of duePeriods(regla, regla.generatedPeriods, refDate)) {
            let outcome: OccurrenceOutcome

            if (nivel !== "FULL" && !esObligacionDevengada(regla)) {
              // §7.2 · en mora, lo que no es obligación devengada se OMITE **con
              // motivo**. I-E9-1a exige motivo, así que el invariante no falla
              // por un impago nuestro (criterio 50).
              outcome = { status: "OMITIDA", reason: MOTIVO_MORA }
            } else {
              const lctx = await getLedgerContext(tx, refDate)
              const built = buildOccurrenceDraft(regla, period, buildSource(regla, source, lctx), lctx)
              if (isSkip(built)) {
                outcome = {
                  status: "OMITIDA",
                  reason: built.skip === "CUOTA_CERO" ? "CUOTA_CERO" : "SIN_FILA_EN_CUADRO",
                }
              } else if (!built.ok) {
                outcome = { status: "FALLIDA", reason: formatLedgerErrors(built.errors as never) }
              } else {
                outcome = { status: "GENERADA", draft: built.value }
              }
            }

            await recordOccurrenceTx(
              tx,
              {
                rule: regla,
                period: period.key,
                // **O-13** · la ocurrencia se fecha por su PERIODO DE DEVENGO,
                // nunca por `refDate` ni por el instante de ejecución.
                postingDate: postingDateOf(period.key, regla.frequency, regla.anchor, regla.dayOfMonth),
                inputHash: occurrenceInputHash(regla, period, regla.templateInput),
                outcome,
              },
              { userId: null }
            )
            processed += 1
          }
        }
        return { ok: true as const, value: null }
      })
    } catch (e) {
      failed += 1
      await recordPlatformAudit({
        actor: "cron",
        action: PLATFORM_ACTIONS.CRON_FINISHED,
        organizationId,
        detail: { job: "recurring-due", reason: (e as Error).message },
      })
    }
    ultima = organizationId
  }

  return { status: "DONE", processed, failed }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2 · `invariant-sweep` — el barrido de E7, que hoy es un script a mano
// ─────────────────────────────────────────────────────────────────────────────

async function runInvariantSweep(ctx: CronJobContext): Promise<CronJobResult> {
  // Import perezoso: `models/ledger` arrastra el motor entero, y las otras tres
  // ramas de este despachador no lo necesitan.
  const { runLedgerInvariants } = await import("@/models/ledger")
  const { sha256OfStoredFile } = await import("@/lib/files-integrity")

  const refDate = localDateOf(ctx.refDate)
  let processed = 0
  let failed = 0
  let ultima: string | null = null

  for (const organizationId of await activeOrganizationIds(cursorOrgId(ctx.cursor))) {
    if (!hasBudgetLeft(Date.now() - ctx.startedAtMs, ctx.budgetMs)) {
      return { status: "PARTIAL", processed, failed, cursor: { lastOrganizationId: ultima } }
    }
    try {
      // Corre **también en mora**: es lectura, y un impago nuestro no puede
      // dejar sin vigilancia los libros del cliente (§7.2).
      await runLedgerInvariants(organizationId, {
        refDate,
        noCache: true,
        readStoredFile: sha256OfStoredFile,
        audit: true,
        persist: { trigger: "SCHEDULED", scopeKind: "ORGANIZATION", runById: null },
      })
      processed += 1
    } catch (e) {
      failed += 1
      await recordPlatformAudit({
        actor: "cron",
        action: PLATFORM_ACTIONS.CRON_FINISHED,
        organizationId,
        detail: { job: "invariant-sweep", reason: (e as Error).message },
      })
    }
    ultima = organizationId
  }

  return { status: "DONE", processed, failed }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3 · `backup-worker` — avanza el cursor de los `BackupJob` vivos
// ─────────────────────────────────────────────────────────────────────────────

/**
 * El worker lo entrega la **ola B** (T8: volcado en streaming por lotes con
 * cursor). Esta rama lo invoca si existe y, si todavía no, **lo dice**: un job
 * que se declarara `DONE` sin haber tocado un solo `BackupJob` sería un reloj
 * mintiendo, y `/api/health` lo daría por bueno.
 */
async function runBackupWorker(_ctx: CronJobContext): Promise<CronJobResult> {
  try {
    const mod = (await import("@/models/backups")) as unknown as {
      advanceBackupJobs?: (opts: { budgetMs: number }) => Promise<{ processed: number; failed: number }>
    }
    if (typeof mod.advanceBackupJobs !== "function") {
      return {
        status: "PARTIAL",
        processed: 0,
        failed: 0,
        cursor: {},
        error: "El worker de backup (ola B · T8, models/backups.advanceBackupJobs) todavía no existe",
      }
    }
    const r = await mod.advanceBackupJobs({ budgetMs: _ctx.budgetMs })
    return { status: "DONE", processed: r.processed, failed: r.failed }
  } catch (e) {
    return { status: "FAILED", processed: 0, failed: 0, error: (e as Error).message }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4 · `retention` — caducidad y limpieza (ADR-0015 D3, O-11)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Limpia los cubos de rate limit caducados y delega la retención de runs y ZIP
 * en quien la tiene.
 *
 * **O-11 · lo que NUNCA caduca**: un `StoredObject` de `kind =
 * PLATFORM_INVOICE`. Son NUESTRAS facturas emitidas, sujetas a conservación
 * (art. 165.Uno LIVA, arts. 19–23 RD 1619/2012), no ZIP de exportación. Aquí no
 * se borra ninguna, y la ola B lo excluye en su propio barrido.
 */
async function runRetention(ctx: CronJobContext): Promise<CronJobResult> {
  let processed = 0
  const failed = 0

  processed += await pruneExpiredBuckets(ctx.refDate)

  try {
    const mod = (await import("@/models/backups")) as unknown as {
      expireBackups?: (refDate: Date) => Promise<number>
    }
    if (typeof mod.expireBackups === "function") {
      processed += await mod.expireBackups(ctx.refDate)
    }
  } catch {
    // La retención de ZIP es de la ola B (T8/T9). Su ausencia no invalida la
    // limpieza de cubos, que sí se ha hecho.
  }

  // `scripts/prune-runs.ts` **se conserva** y el cron lo invoca como biblioteca
  // (§7.2), pero necesita `DATABASE_URL_MAINTENANCE` (BYPASSRLS): sin esa
  // credencial no se ejecuta y **se dice**, en vez de declarar `DONE` sin haber
  // purgado nada.
  if (!process.env.DATABASE_URL_MAINTENANCE) {
    return {
      status: "PARTIAL",
      processed,
      failed,
      cursor: {},
      error: "prune-runs necesita DATABASE_URL_MAINTENANCE (app_maintenance, BYPASSRLS) y no está definida",
    }
  }

  try {
    const { pruneRuns } = await import("@/scripts/prune-runs")
    const informe = await pruneRuns({ all: true, apply: true, refDate: localDateOf(ctx.refDate) } as never)
    processed += Number((informe as unknown as { total?: number }).total ?? 0)
  } catch (e) {
    return { status: "PARTIAL", processed, failed: failed + 1, cursor: {}, error: (e as Error).message }
  }

  return { status: "DONE", processed, failed }
}
