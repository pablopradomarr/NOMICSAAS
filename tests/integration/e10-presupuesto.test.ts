import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

/**
 * E10 · T19 — `e10-presupuesto.test.ts`, **el fichero que §13 nombra** y que la
 * ronda 0 no llegó a crear (hallazgo 1 de la revisión).
 *
 * No duplica los criterios que ya están probados en otro sitio —eso sería un
 * segundo juego de pruebas del mismo comportamiento, que es peor que ninguno:
 * cuando divergen, nadie sabe cuál manda—. Lo que hace es **cerrar el hueco que
 * hizo posible el hallazgo**: que un criterio de aceptación de §12 se quede sin
 * ninguna prueba **y nadie se entere**.
 *
 * Es un índice EJECUTABLE: lee los **cuarenta y un** criterios de §12 del propio
 * diseño y exige que cada uno esté reclamado por su número (`criterio N`) en al
 * menos un test del repositorio. Si mañana el diseño gana un criterio 34, este
 * test falla hasta que alguien lo pruebe o lo feche en `docs/ESTADO.md`.
 *
 * El mapa de dónde vive cada familia, para quien llegue de nuevo:
 *
 *  · 1–11, 13–19       `lib/budget/**`, `lib/time/**`, `lib/analytics/allocate.test.ts`
 *                      (motor puro, byte a byte contra el fixture sellado v1.1)
 *  · 12, 12-bis, 21    `tests/integration/e10-staleness.test.ts`
 *  · 13, 13-bis        `tests/integration/e10-ronda-integracion.test.ts`
 *  · 20, 22, 23        `tests/integration/e10-esquema.test.ts` (CHECK y triggers)
 *  · 24                `tests/integration-rls/e10-tenant.test.ts` (las siete tablas)
 *  · 25, 27–33         `tests/integration/e10-acciones.test.ts` y `e10-modelos.test.ts`
 *  · 26                `tests/integration/perf-budget.test.ts` (los nueve techos)
 *  · auditoría ronda 1 `tests/integration/e10-ronda1.test.ts` (H-1…H-4, BUG-E10-2)
 */

const DESIGN = path.join(process.cwd(), "docs", "design", "E10-presupuesto-horas.md")
const ROOTS = ["lib", "models", "app", "tests"]

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out)
      continue
    }
    if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

/** Los criterios de §12, leídos del diseño: `1.`, `4-bis.`, `27-bis.`… */
function criteriaOfDesign(): string[] {
  const doc = readFileSync(DESIGN, "utf8")
  const from = doc.indexOf("## 12. Criterios de aceptación")
  const to = doc.indexOf("## 13. Plan de tareas")
  if (from < 0 || to < 0) throw new Error("El diseño ya no tiene §12 o §13: este índice hay que reescribirlo")
  return [...doc.slice(from, to).matchAll(/^(\d+(?:-bis)?)\. \*\*/gm)].map((m) => m[1])
}

describe("E10 · §12 — todos los criterios de aceptación tienen quien los pruebe", () => {
  const criteria = criteriaOfDesign()
  const claimed = new Set<string>()
  for (const root of ROOTS) {
    for (const file of sourceFiles(path.join(process.cwd(), root))) {
      for (const m of readFileSync(file, "utf8").matchAll(/criterio (\d+(?:-bis)?)/g)) claimed.add(m[1])
    }
  }

  it("§12 declara los cuarenta y un criterios que el plan de tareas reparte", () => {
    expect(criteria.length).toBe(41)
    expect(criteria[0]).toBe("1")
    expect(criteria).toContain("26")
  })

  it("ninguno se queda sin prueba: el hueco de T19 no se puede repetir en silencio", () => {
    const missing = criteria.filter((c) => !claimed.has(c))
    expect(
      missing,
      `Criterios de §12 sin ninguna prueba que los reclame por número: ${missing.join(", ")}. ` +
        "Pruébalos, o féchalos en docs/ESTADO.md con épica de cierre (CLAUDE.md, §Estándar de calidad)."
    ).toEqual([])
  })

  it("los tres ficheros que §13 nombra para T19 existen", () => {
    for (const file of [
      "tests/integration/e10-presupuesto.test.ts",
      "tests/integration/e10-tenant.test.ts".replace("integration/", "integration-rls/"),
      "tests/integration/perf-budget.test.ts",
    ]) {
      expect(() => statSync(path.join(process.cwd(), file)), file).not.toThrow()
    }
  })
})
