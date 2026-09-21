/**
 * E12 · ronda 1 — **el registro de lo derivado**, y el detector que lo vigila.
 *
 * El DEBE #3 de la revisión pedía decidir y escribir qué es «derivado». La
 * decisión está en `DERIVED_MODELS` (tabla por tabla, con motivo) y la guardia
 * es este fichero: **si aparece una tabla de caché fuera del registro, falla**.
 *
 * Es un test de unidad a propósito: las funciones son puras y reciben el modelo
 * de datos por parámetro, así que el registro se contrasta contra el esquema
 * real sin abrir una conexión, y corre en `npm run test`.
 */

import { describe, expect, it } from "vitest"

import { prismaSchemaMeta } from "@/lib/db"
import type { SchemaModel } from "@/lib/platform/backup"
import {
  DERIVED_MODELS,
  FUENTES_AUNQUE_LO_PAREZCAN,
  SELLOS_NO_RECOMPUTABLES,
  derivedTables,
  filtroDe,
  pareceCache,
  purgableSeals,
  tablasSinDeclarar,
} from "@/models/purge-derived"

const meta = prismaSchemaMeta()

describe("E12 · T10 — el registro DERIVED_MODELS", () => {
  it("ninguna tabla de caché queda fuera del registro (ni declarada fuente)", () => {
    /**
     * **El test que el DEBE #3 pide.** El detector estructural —nombre `_runs` /
     * `_sweeps`, o columna con el hash de sus fuentes— recorre el esquema y
     * acusa. Una tabla acusada tiene que estar en uno de los dos lados, con su
     * motivo escrito. Añadir una `_runs` nueva y no declararla rompe aquí, con
     * el nombre de la tabla en el mensaje.
     */
    const sinDeclarar = tablasSinDeclarar(meta)
    expect(
      sinDeclarar,
      `tabla(s) de caché sin declarar: ${sinDeclarar.join(", ")}. Decide si son derivadas ` +
        "(DERIVED_MODELS, con motivo) o fuente (FUENTES_AUNQUE_LO_PAREZCAN, con motivo)."
    ).toEqual([])
  })

  it("una tabla de caché NUEVA no entra sola en la purga: obliga a declararla", () => {
    const ficticia: SchemaModel = {
      model: "FixtureFicticioRun",
      table: "fixture_ficticio_runs",
      columns: [
        { field: "id", column: "id", type: "String", kind: "scalar" },
        { field: "organizationId", column: "organization_id", type: "String", kind: "scalar" },
      ],
    } as SchemaModel

    // El detector la caza…
    expect(pareceCache(ficticia)).toBe(true)
    expect(tablasSinDeclarar([...meta, ficticia])).toEqual(["fixture_ficticio_runs"])
    // …y, mientras nadie la declare, la purga NO la toca. Es la diferencia con
    // el criterio estructural de antes, que la habría borrado sin preguntar.
    expect(derivedTables([...meta, ficticia]).map((t) => t.table)).not.toContain("fixture_ficticio_runs")
  })

  it("cada entrada del registro existe en el esquema, es de tenant y tiene motivo", () => {
    for (const [table, { motivo }] of Object.entries(DERIVED_MODELS)) {
      const model = meta.find((m) => m.table === table)
      expect(model, `«${table}» está en el registro y no existe en el esquema`).toBeDefined()
      expect(
        model!.columns.some((c) => c.column === "organization_id"),
        `«${table}» no es de tenant: no se puede purgar por organización`
      ).toBe(true)
      expect(motivo.length, `«${table}» sin motivo escrito`).toBeGreaterThan(60)
    }
  })

  it("cada tabla declarada fuente CUMPLE el criterio del detector: si no, la excepción sobra", () => {
    for (const [table, motivo] of Object.entries(FUENTES_AUNQUE_LO_PAREZCAN)) {
      const model = meta.find((m) => m.table === table)
      expect(model, `la excepción «${table}» nombra una tabla que no existe`).toBeDefined()
      expect(pareceCache(model!), `la excepción «${table}» no cumple el criterio: sobra`).toBe(true)
      expect(motivo.length, `«${table}» sin motivo escrito`).toBeGreaterThan(40)
      expect(derivedTables(meta).map((t) => t.table)).not.toContain(table)
    }
  })

  it("las tablas que §4.1 nombra están, y `closing_runs` sólo en sus estados a medias", () => {
    const lista = derivedTables(meta).map((t) => t.table)
    for (const esperada of ["report_runs", "invariant_runs", "usage_runs", "allocation_runs", "store_sweeps"]) {
      expect(lista, `«${esperada}» tiene que estar en el registro`).toContain(esperada)
    }
    expect(filtroDe("closing_runs")).toBe("status NOT IN ('CERRADO', 'REABIERTO')")
    expect(filtroDe("report_runs")).toBeNull()
    // Un cierre sellado es un sello, no una caché: la purga no lo alcanza.
    expect(DERIVED_MODELS.closing_runs.motivo).toContain("HECHO contable")
  })

  it("los sellos que NO se purgan están declarados, y con motivo", () => {
    const purgables = purgableSeals(meta).map((s) => `${s.table}.${s.column}`)
    for (const [clave, motivo] of Object.entries(SELLOS_NO_RECOMPUTABLES)) {
      expect(purgables, `«${clave}» está declarado no recomputable y aun así se purgaría`).not.toContain(clave)
      expect(motivo.length, `«${clave}» sin motivo escrito`).toBeGreaterThan(30)
    }
    expect(purgables).not.toContain("journal_entries.entry_hash")
    expect(purgables.length, "no queda ninguna columna-sello purgable: el purgado de sellos sería vacuo").toBeGreaterThan(0)
  })
})
