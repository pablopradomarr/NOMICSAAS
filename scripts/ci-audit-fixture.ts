/**
 * E12 · T22 — Sembrado del job `auditor-automatizado` de CI.
 *
 *   npx tsx scripts/ci-audit-fixture.ts [--org <uuid>] [--out artifacts/validacion.json]
 *
 * Deja la base lista para que `scripts/audit-reconstruct.ts` tenga **algo que
 * refutar**, y en ese orden exacto:
 *
 *   1. crea la organización del run y le carga `ejercicio-completo` **por el
 *      motor** (`loadFixtureIntoOrg`), nunca por SQL de arnés;
 *   2. **emite los informes ANTES del auditor**: BALANCE, PyG, CASHFLOW mensual
 *      y PyG analítica. Sin ellos el auditor no tiene cifras selladas contra las
 *      que contrastar y su veredicto sería `NO_VERIFICABLE`, que en CI **falla
 *      igual que `DISCREPANCIA`** (enmienda E-9 de la v1.1). El `CASHFLOW`
 *      mensual está aquí a propósito: es la forma que destapó el falso
 *      `P-PRODUCTO-CONTRADICTORIO` de la ola A;
 *   3. corre el barrido y lo **persiste** (`InvariantRun`), que es de donde
 *      salen las cuatro cifras de cabecera y los cinco sellos;
 *   4. escribe el `validacion.json` del barrido, que CI publica como artefacto.
 *
 * Este script **sí** es del productor (importa `models/**`): su trabajo es
 * producir. El que no puede importar nada del productor es el auditor, y eso lo
 * impone `scripts/audit-reconstruct.imports.test.ts` sobre el AST.
 *
 * El `--org` es fijo y determinista para que un run que se corte a la mitad no
 * deje la base sembrada de huérfanas: la siguiente ejecución lo vacía y vuelve.
 */

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { prisma, tenantTransaction } from "@/lib/db"
import type { LocalDate } from "@/lib/ledger/types"
import { runLedgerInvariants } from "@/models/ledger"
import { getOrCreateReportRun } from "@/models/reports"
import { loadFixtureIntoOrg, resetOrganizationLedger } from "@/scripts/load-fixture"

/** uuid fijo del run de CI. */
const ORG_POR_DEFECTO = "c1ac1ac1-0e12-4000-8000-000000000001"
const USER_POR_DEFECTO = "c1ac1ac1-0e12-4000-8000-000000000002"

/** El fixture llega a 2027: «hoy» se fija, nunca se lee del reloj. */
const REF_DATE = "2026-12-31" as LocalDate
const PERIODO = { periodStart: "2026-01-01" as LocalDate, periodEnd: "2026-12-31" as LocalDate }

/** Los cuatro informes que el auditor contrasta. El orden es el de lectura. */
const INFORMES = [
  ["BALANCE", { snapshot: "PRE_REGULARIZACION", variant: "PYMES" }],
  ["PYG", { variant: "PYMES" }],
  ["CASHFLOW", { method: "DIRECTO", granularity: "MENSUAL", view: "GESTION" }],
  ["PYG_ANALITICA", { dimension: "PROJECT" }],
] as const

function argumento(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}

async function main(): Promise<void> {
  const organizationId = argumento("--org") ?? ORG_POR_DEFECTO
  const userId = argumento("--user") ?? USER_POR_DEFECTO
  const out = argumento("--out") ?? "artifacts/validacion.json"
  const gitSha = process.env.GIT_SHA
  if (!gitSha) {
    // Sin `GIT_SHA` el sello sale `REQUIERE REVISIÓN` por diseño (runbook de E3)
    // y el job diría que algo va mal cuando lo que falta es la variable.
    throw new Error("GIT_SHA no está definida: sin ella el sello del barrido no es el del commit")
  }

  // Idempotencia: lo que dejara un run cortado se vacía antes de empezar.
  await resetOrganizationLedger(organizationId).catch(() => undefined)
  await prisma.user.upsert({
    where: { id: userId },
    update: {},
    create: { id: userId, email: `ci-auditor@test.local`, name: "Auditor CI" },
  })
  await prisma.organization.upsert({
    where: { id: organizationId },
    update: {},
    create: { id: organizationId, slug: "ci-auditor", name: "Auditor CI", pgcVariant: "PYMES", updatedAt: new Date() },
  })
  await prisma.membership.upsert({
    where: { organizationId_userId: { organizationId, userId } },
    update: {},
    create: { organizationId, userId, role: "ADMIN", acceptedAt: new Date(), updatedAt: new Date() },
  })

  const carga = await loadFixtureIntoOrg({ fixture: "ejercicio-completo", organizationId, userId })
  if (carga.mismatches.length > 0) {
    throw new Error(`el fixture no reproduce sus cifras selladas: ${carga.mismatches.join(" · ")}`)
  }

  const fiscalYearId = await tenantTransaction(organizationId, userId, async (tx) =>
    (await tx.fiscalYear.findFirstOrThrow({ where: { code: "2026" } })).id
  )

  for (const [type, params] of INFORMES) {
    const run = await getOrCreateReportRun(organizationId, {
      type,
      periodStart: PERIODO.periodStart,
      periodEnd: PERIODO.periodEnd,
      fiscalYearId,
      params,
      actor: { userId },
    })
    console.log(`· informe ${type} sellado (${run.id.slice(0, 8)}, ledgerHash ${run.ledgerHash.slice(0, 12)}…)`)
  }

  const barrido = await runLedgerInvariants(organizationId, {
    refDate: REF_DATE,
    fiscalYearId,
    gitSha,
    noCache: true,
    audit: true,
    actor: { userId },
    persist: { trigger: "MANUAL", scopeKind: "FISCAL_YEAR", runById: userId },
  })

  await mkdir(path.dirname(path.resolve(out)), { recursive: true })
  await writeFile(path.resolve(out), `${JSON.stringify(barrido.validacion, null, 2)}\n`, "utf8")

  // El sello y los CINCO hashes, aparte: `validacion.json` sólo lleva el
  // `ledgerHash`, y el resumen del PR los pide todos (§8 del diseño).
  const { latestInvariantRun } = await import("@/models/audit")
  const { tenantDb } = await import("@/lib/db")
  const fila = await latestInvariantRun(tenantDb(organizationId))
  const sellos = {
    organizationId,
    sello: barrido.sello.sello,
    motivos: [...barrido.sello.motivos],
    gitSha,
    refDate: REF_DATE,
    seals: fila
      ? {
          ledgerHash: fila.ledgerHash,
          analyticsKey: fila.analyticsKey,
          planHash: fila.planHash,
          accountMapHash: fila.accountMapHash,
          configHash: fila.configHash,
        }
      : null,
  }
  await writeFile(
    path.join(path.dirname(path.resolve(out)), "barrido.json"),
    `${JSON.stringify(sellos, null, 2)}\n`,
    "utf8"
  )

  const fallos = barrido.validacion.checks.filter((c) => c.status === "FAIL")
  console.log(
    `· barrido sellado: «${barrido.sello.sello}»` +
      (barrido.sello.motivos.length > 0 ? ` (${barrido.sello.motivos.join(", ")})` : "") +
      ` · ${barrido.validacion.checks.length} checks, ${fallos.length} FAIL → ${out}`
  )
  console.log(`ORG=${organizationId}`)
}

main()
  .then(async () => {
    await prisma.$disconnect()
    process.exit(0)
  })
  .catch(async (error) => {
    console.error(error)
    await prisma.$disconnect()
    process.exit(1)
  })
