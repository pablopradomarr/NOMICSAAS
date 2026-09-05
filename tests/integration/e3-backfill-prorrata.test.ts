/**
 * E3 — El backfill de `prorrata_bps` sobrevive a `FORCE ROW LEVEL SECURITY`.
 *
 * Con `FORCE` (ADR-0009), el propietario de la tabla tampoco esquiva las
 * políticas: un `UPDATE` de datos dentro de una migración **no da error, ve 0
 * filas**. Es el fallo más silencioso que deja la RLS estricta, así que se
 * comprueba de dos maneras: que la migración usa el patrón obligatorio y que el
 * estado resultante de la BD es el correcto.
 */

import { readFileSync } from "node:fs"
import path from "node:path"

import { PrismaPg } from "@prisma/adapter-pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { PrismaClient } from "@/prisma/client/client"
import { ownerDatabaseUrl } from "@/tests/support/env"

const MIGRATION = path.join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260907110000_e3_backfill_prorrata_force",
  "migration.sql"
)

let prisma: PrismaClient

beforeAll(() => {
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: ownerDatabaseUrl() }) })
})

afterAll(async () => {
  await prisma.$disconnect()
})

describe("patrón obligatorio de backfill bajo FORCE (ADR-0009 §7)", () => {
  // Se mira SÓLO el SQL ejecutable: la cabecera de la migración cita el UPDATE
  // roto que esta corrige, y ese texto no debe contar como código.
  const sql = readFileSync(MIGRATION, "utf8")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")

  it("retira FORCE, hace el backfill y lo vuelve a poner, en ese orden", () => {
    const noForce = sql.indexOf("NO FORCE ROW LEVEL SECURITY")
    const update = sql.indexOf('UPDATE "organizations"')
    const force = sql.indexOf('ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY')

    expect(noForce).toBeGreaterThan(-1)
    expect(update).toBeGreaterThan(noForce)
    expect(force).toBeGreaterThan(update)
  })

  it("el backfill es idempotente: se marca para no repetirse", () => {
    expect(sql).toContain("prorrata_bps:convertido")
    expect(sql).toContain("COMMENT ON TABLE")
  })
})

describe("estado de la BD tras la cadena de migraciones", () => {
  it("`organizations` NO queda en NO FORCE", async () => {
    const rows = await prisma.$queryRaw<{ relforcerowsecurity: boolean; relrowsecurity: boolean }[]>`
      SELECT relforcerowsecurity, relrowsecurity FROM pg_class WHERE relname = 'organizations'`
    expect(rows[0].relrowsecurity).toBe(true)
    expect(rows[0].relforcerowsecurity).toBe(true)
  })

  it("la columna se llama `prorrata_bps` y `prorrata_permille` ya no existe", async () => {
    const rows = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'organizations' AND column_name LIKE 'prorrata%'`
    expect(rows.map((r) => r.column_name)).toEqual(["prorrata_bps"])
  })

  it("la conversión está marcada en el comentario de la tabla", async () => {
    const rows = await prisma.$queryRaw<{ comment: string | null }[]>`
      SELECT obj_description(c.oid, 'pg_class') AS comment
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'organizations'`
    expect(rows[0].comment).toContain("prorrata_bps:convertido")
  })

  it("el CHECK admite la escala de puntos básicos (0–10000), no la de por mil", async () => {
    const rows = await prisma.$queryRaw<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname = 'organizations_prorrata_bps_check'`
    expect(rows).toHaveLength(1)
    expect(rows[0].def).toContain("10000")
  })

  it("ninguna organización queda con la prorrata en la escala antigua", async () => {
    // Toda fila no nula debe ser un valor de bps válido. Con E2 sin escribir
    // nunca la columna esto es vacío, pero el día que deje de serlo el test
    // sigue siendo el que cuida la escala.
    const rows = await prisma.$queryRaw<{ id: string; prorrata_bps: number }[]>`
      SELECT id, prorrata_bps FROM organizations
       WHERE prorrata_bps IS NOT NULL AND (prorrata_bps < 0 OR prorrata_bps > 10000)`
    expect(rows).toEqual([])
  })
})
