/**
 * E12 · ronda 1 — el planificador de borrado, probado **sin base de datos**.
 *
 * Las aristas son las reales del esquema (las cuatro que el revisor encontró:
 * `invariant_runs→fiscal_years`, `invariant_runs→store_sweeps`,
 * `closing_runs→fiscal_years`, `extraction_runs→files`), escritas a mano aquí
 * para poder razonar sobre ellas; que coinciden con el catálogo lo comprueba el
 * test de integración `e12-ronda1`, que las lee de `pg_constraint`.
 */

import { describe, expect, it } from "vitest"

import {
  deleteStatement,
  planDeletion,
  retainersOf,
  retentionWhere,
  type ForeignKey,
} from "@/lib/platform/deletion-plan"

const fk = (constraint: string, child: string, parent: string, cols: [string, string][] = [["x_id", "id"]]): ForeignKey => ({
  constraint,
  child,
  parent,
  columns: cols.map(([c, p]) => ({ child: c, parent: p })),
})

/** Un recorte fiel del grafo real alrededor de `fiscal_years` y `files`. */
const ARISTAS: ForeignKey[] = [
  fk("invariant_runs_fiscal_year_fkey", "invariant_runs", "fiscal_years", [
    ["organization_id", "organization_id"],
    ["fiscal_year_id", "id"],
  ]),
  fk("invariant_runs_store_sweep_fkey", "invariant_runs", "store_sweeps", [
    ["organization_id", "organization_id"],
    ["store_sweep_id", "id"],
  ]),
  fk("closing_runs_fiscal_year_fkey", "closing_runs", "fiscal_years", [
    ["organization_id", "organization_id"],
    ["fiscal_year_id", "id"],
  ]),
  fk("extraction_runs_file_fkey", "extraction_runs", "files", [
    ["organization_id", "organization_id"],
    ["file_id", "id"],
  ]),
  fk("budgets_fiscal_year_fkey", "budgets", "fiscal_years", [
    ["organization_id", "organization_id"],
    ["fiscal_year_id", "id"],
  ]),
  fk("bank_statements_file_fkey", "bank_statements", "files", [
    ["organization_id", "organization_id"],
    ["file_id", "id"],
  ]),
  fk("files_parent_fkey", "files", "files", [["parent_id", "id"]]),
]

describe("planDeletion · el orden topológico", () => {
  it("borra los hijos antes que los padres", () => {
    const { order, cycles } = planDeletion(["fiscal_years", "budgets", "files", "bank_statements"], ARISTAS)
    expect(cycles).toEqual([])
    expect(order.indexOf("budgets")).toBeLessThan(order.indexOf("fiscal_years"))
    expect(order.indexOf("bank_statements")).toBeLessThan(order.indexOf("files"))
  })

  it("una autorreferencia no crea ciclo: un DELETE se lleva la tabla entera de una vez", () => {
    const { order, cycles } = planDeletion(["files"], ARISTAS)
    expect(cycles).toEqual([])
    expect(order).toEqual(["files"])
  })

  it("un ciclo entre tablas distintas se DECLARA en vez de fallar en silencio", () => {
    const ciclo = [fk("a_b", "a", "b"), fk("b_a", "b", "a")]
    const { order, cycles } = planDeletion(["a", "b"], ciclo)
    expect(order).toEqual([])
    expect(cycles).toEqual(["a", "b"])
  })
})

describe("planDeletion · las claves ajenas ENTRANTES desde tablas que se conservan", () => {
  /**
   * El BLOQUEA 1 de la revisión, escrito como test: el conjunto que borra
   * `reset-org` incluye `fiscal_years`, `store_sweeps` y `files`, pero NO
   * `invariant_runs`, `closing_runs` ni `extraction_runs` (las seis de D2). El
   * planificador anterior ignoraba esas aristas por completo —`if (!set.has(child))
   * continue`— y el `DELETE FROM fiscal_years` reventaba con `23503`.
   */
  const CONJUNTO = ["fiscal_years", "store_sweeps", "files", "budgets", "bank_statements"]

  it("las cuatro aristas RESTRICT desde tablas preservadas ponen guarda", () => {
    const plan = planDeletion(CONJUNTO, ARISTAS)
    expect(retainersOf("fiscal_years", plan)).toEqual(["closing_runs", "invariant_runs"])
    expect(retainersOf("store_sweeps", plan)).toEqual(["invariant_runs"])
    expect(retainersOf("files", plan)).toEqual(["extraction_runs"])
    // Y `budgets` / `bank_statements`, que se borran ENTEROS, no ponen guarda:
    // cuando le toque al padre no quedará una sola fila suya que lo señale.
    expect(retainersOf("fiscal_years", plan)).not.toContain("budgets")
    expect(retainersOf("files", plan)).not.toContain("bank_statements")
  })

  it("la guarda es un NOT EXISTS por arista, con las columnas de la restricción", () => {
    const plan = planDeletion(CONJUNTO, ARISTAS)
    const sql = deleteStatement("store_sweeps", plan)
    expect(sql).toContain('DELETE FROM "store_sweeps"')
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM "invariant_runs" AS "h"')
    expect(sql).toContain('"h"."store_sweep_id" = "store_sweeps"."id"')
    expect(sql).toContain('"h"."organization_id" = "store_sweeps"."organization_id"')
  })

  it("el filtro propio de la tabla se suma a las guardas, no las sustituye", () => {
    const plan = planDeletion(["fiscal_years"], ARISTAS)
    const where = retentionWhere("fiscal_years", plan, "status <> 'CERRADO'")
    expect(where).toContain(`"fiscal_years"."organization_id" = $1::uuid`)
    expect(where).toContain("(status <> 'CERRADO')")
    expect(where).toContain("NOT EXISTS")
  })

  it("una tabla que se borra SÓLO EN PARTE sí retiene a su padre", () => {
    // `closing_runs` en la purga: los sellados sobreviven y retienen su ejercicio.
    const plan = planDeletion(["fiscal_years", "closing_runs"], ARISTAS, new Set(["closing_runs"]))
    expect(retainersOf("fiscal_years", plan)).toContain("closing_runs")
    // Sin declararla parcial, el plan la trata como borrado entero y no retiene.
    expect(retainersOf("fiscal_years", planDeletion(["fiscal_years", "closing_runs"], ARISTAS))).not.toContain(
      "closing_runs"
    )
  })

  it("una tabla sin aristas entrantes no lleva guarda: no se paga lo que no hace falta", () => {
    const plan = planDeletion(["budgets"], ARISTAS)
    expect(deleteStatement("budgets", plan)).toBe(`DELETE FROM "budgets" WHERE "budgets"."organization_id" = $1::uuid`)
  })

  it("una arista NUEVA entra sola: el plan sale del catálogo, no de una lista", () => {
    const conNueva = [...ARISTAS, fk("tabla_nueva_fiscal_year_fkey", "tabla_nueva", "fiscal_years")]
    const plan = planDeletion(["fiscal_years"], conNueva)
    expect(retainersOf("fiscal_years", plan)).toContain("tabla_nueva")
  })
})
