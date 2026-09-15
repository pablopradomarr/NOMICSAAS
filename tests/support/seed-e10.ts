/**
 * Arnés de los e2e de presupuesto y horas (E10 · T16/T17).
 *
 * **Por qué existe.** El recorrido de `/analytics/budget-vs-actual` empieza con
 * una **versión de presupuesto sellada**: sin ella el informe responde
 * `BUDGET_NOT_FOUND` y no hay matriz que comparar. El editor de presupuesto es
 * la pantalla de otra tarea de la misma ola (T15), así que el escenario se
 * siembra por el **mismo camino que la aplicación** —`createBudgetVersionTx`,
 * `upsertBudgetCellsTx`, `upsertBudgetHoursTx` y `sealBudgetTx`—, nunca con
 * `INSERT` a pelo: un presupuesto sembrado por SQL no tendría `budgetHash` ni
 * habría pasado la validación de signo, y el test estaría probando otra cosa.
 *
 * Lo que NO siembra, a propósito: el empleado, su tarifa y sus partes. Eso lo
 * hace el test **por pantalla**, que es lo que T17 tiene que demostrar.
 *
 *   npx tsx tests/support/seed-e10.ts --org <id> --user <id>
 *
 * Imprime en `stdout`, en una línea:
 * `{ budgetId, label, budgetHash, fiscalYearId, periodStart, periodEnd, projectCode, costCenterCode, revenueCents, directCostCents, budgetMinutes }`.
 * Es IDEMPOTENTE: si la versión `BASE` del ejercicio ya está sellada, la
 * reutiliza y devuelve sus datos.
 */

import { tenantTransaction } from "@/lib/db"
import { marginConfigHash } from "@/lib/analytics/hash"
import { getAnalyticsConfig } from "@/models/analytics"
import {
  budgetLabel,
  createBudgetVersionTx,
  listBudgets,
  sealBudgetTx,
  upsertBudgetCellsTx,
  upsertBudgetHoursTx,
} from "@/models/budget"

/** Doce meses de ingreso directo y de coste directo del proyecto elegido. */
const REVENUE_PER_MONTH_CENTS = 1_000_000
const DIRECT_COST_PER_MONTH_CENTS = -600_000
/** Estructura presupuestada en el CECO, que es lo que la liquidación reparte. */
const CECO_COST_PER_MONTH_CENTS = -75_000
/** Horas presupuestadas del proyecto: 100 h al mes. */
const BUDGET_MINUTES_PER_MONTH = 6_000

export type SeedE10Result = {
  budgetId: string
  label: string
  budgetHash: string
  fiscalYearId: string
  periodStart: string
  periodEnd: string
  projectCode: string
  costCenterCode: string
  revenueCents: number
  directCostCents: number
  budgetMinutes: number
}

export async function seedE10Budget(organizationId: string, userId: string): Promise<SeedE10Result> {
  return await tenantTransaction(organizationId, userId, async (tx) => {
    const fiscalYear = await tx.fiscalYear.findFirst({
      where: { status: "OPEN" },
      orderBy: { startDate: "asc" },
      select: { id: true, code: true, startDate: true, endDate: true },
    })
    if (!fiscalYear) throw new Error("La organización no tiene ningún ejercicio abierto que presupuestar")

    const periodStart = fiscalYear.startDate.toISOString().slice(0, 10)
    const periodEnd = fiscalYear.endDate.toISOString().slice(0, 10)
    const config = await getAnalyticsConfig(tx, { periodEnd })
    const project = config.projects.find((p) => p.isActive) ?? config.projects[0]
    const costCenter = config.costCenters.find((c) => c.allocatable) ?? config.costCenters[0]
    if (!project || !costCenter) {
      throw new Error("La organización no tiene proyecto y centro de coste con los que presupuestar")
    }

    const existing = await listBudgets(tx, { fiscalYearId: fiscalYear.id })
    const sealed = existing.find((b) => b.scenario === "BASE" && b.budgetHash !== null)
    if (sealed) {
      return {
        budgetId: sealed.id,
        label: sealed.label,
        budgetHash: sealed.budgetHash as string,
        fiscalYearId: fiscalYear.id,
        periodStart,
        periodEnd,
        projectCode: project.code,
        costCenterCode: costCenter.code,
        revenueCents: REVENUE_PER_MONTH_CENTS * 12,
        directCostCents: DIRECT_COST_PER_MONTH_CENTS * 12,
        budgetMinutes: BUDGET_MINUTES_PER_MONTH * 12,
      }
    }

    const draft =
      existing.find((b) => b.scenario === "BASE" && b.status === "BORRADOR") ??
      (await createBudgetVersionTx(
        tx,
        {
          fiscalYearId: fiscalYear.id,
          scenario: "BASE",
          name: "Presupuesto base e2e",
          validFrom: periodStart,
        },
        { userId }
      ))

    const year = periodStart.slice(0, 4)
    const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}-01`)

    await upsertBudgetCellsTx(
      tx,
      {
        budgetId: draft.id,
        config,
        cells: months.flatMap((month) => [
          {
            month,
            accountCode: "705",
            projectId: project.id,
            analyticType: "INGRESO_DIRECTO" as const,
            amountCents: REVENUE_PER_MONTH_CENTS,
          },
          {
            month,
            accountCode: "607",
            projectId: project.id,
            analyticType: "COSTE_DIRECTO_MC1" as const,
            amountCents: DIRECT_COST_PER_MONTH_CENTS,
          },
          {
            month,
            accountCode: "629",
            costCenterId: costCenter.id,
            analyticType: "INDIRECTO_CECO" as const,
            amountCents: CECO_COST_PER_MONTH_CENTS,
          },
        ]),
      },
      { userId }
    )

    await upsertBudgetHoursTx(
      tx,
      {
        budgetId: draft.id,
        rows: months.map((month) => ({ month, projectId: project.id, minutes: BUDGET_MINUTES_PER_MONTH })),
      },
      { userId }
    )

    const seal = await sealBudgetTx(
      tx,
      {
        budgetId: draft.id,
        gitSha: process.env.GIT_SHA ?? "e2e",
        marginConfigHash: marginConfigHash(config),
        sealedAt: new Date(),
      },
      { userId }
    )

    return {
      budgetId: draft.id,
      label: budgetLabel(fiscalYear.code, "BASE", 0),
      budgetHash: seal.budgetHash,
      fiscalYearId: fiscalYear.id,
      periodStart,
      periodEnd,
      projectCode: project.code,
      costCenterCode: costCenter.code,
      revenueCents: REVENUE_PER_MONTH_CENTS * 12,
      directCostCents: DIRECT_COST_PER_MONTH_CENTS * 12,
      budgetMinutes: BUDGET_MINUTES_PER_MONTH * 12,
    }
  })
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const valueOf = (flag: string): string | undefined => {
    const at = args.indexOf(flag)
    return at >= 0 ? args[at + 1] : undefined
  }
  const organizationId = valueOf("--org")
  const userId = valueOf("--user")
  if (!organizationId || !userId) {
    throw new Error("Uso: npx tsx tests/support/seed-e10.ts --org <id> --user <id>")
  }
  const result = await seedE10Budget(organizationId, userId)
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && process.argv[1].endsWith("seed-e10.ts")) {
  main().then(
    () => process.exit(0),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    }
  )
}
