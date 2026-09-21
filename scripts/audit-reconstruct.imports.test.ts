/**
 * ─────────────────────────────────────────────────────────────────────────────
 * TEST ESTÁTICO DE IMPORTACIONES DEL AUDITOR (E12 · T5, criterio C4-14)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `scripts/audit-reconstruct.ts` es la Capa 2 de C4: el motor que REFUTA. Si
 * comparte una sola línea de código con el que produce las cifras, deja de
 * refutar y pasa a confirmar —«el auditor automatizado deriva hacia el motor»
 * es el primer riesgo de §13 de `docs/design/E12-fiabilidad-dod.md`—.
 *
 * Este control lee el AST del auditor con el compilador de TypeScript y falla
 * si aparece CUALQUIER dependencia de `lib/**`, `models/**`, `ai/**` o `app/**`,
 * en cualquiera de sus formas: `import`, `import type`, `export … from`,
 * `import()` dinámico y `require()`. No es una promesa en un comentario: es una
 * comprobación sobre el árbol sintáctico, que es lo que §13 exige.
 *
 * DOS MODOS, a propósito (regla E-1: un control sin llamante no cuenta como
 * implementado; `vitest.config.ts` no incluye hoy `scripts/**`):
 *
 *   npx tsx scripts/audit-reconstruct.imports.test.ts   → ejecuta y sale ≠ 0 si falla
 *   npx vitest run scripts/audit-reconstruct.imports…   → cuando CI añada scripts/** al include
 */

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const AQUI = dirname(fileURLToPath(import.meta.url))
const AUDITOR = resolve(AQUI, "audit-reconstruct.ts")

/** Los cuatro territorios del productor. Tocarlos es perder la independencia. */
const PROHIBIDOS = ["lib", "models", "ai", "app"]

/** Lo único que el auditor puede importar: el cliente crudo de Postgres y el
 *  runtime de Node. Cualquier otra cosa entra por la puerta de atrás. */
const PERMITIDOS = new Set(["pg"])

export type Importacion = { especificador: string; linea: number; forma: string }

/** Extrae TODOS los especificadores de módulo del fichero, sea cual sea su forma. */
export function extraerImportaciones(codigo: string, nombre = "audit-reconstruct.ts"): Importacion[] {
  const fuente = ts.createSourceFile(nombre, codigo, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
  const encontradas: Importacion[] = []

  const anotar = (nodo: ts.Node, especificador: string, forma: string): void => {
    const { line } = fuente.getLineAndCharacterOfPosition(nodo.getStart(fuente))
    encontradas.push({ especificador, linea: line + 1, forma })
  }

  const visitar = (nodo: ts.Node): void => {
    if (ts.isImportDeclaration(nodo) && ts.isStringLiteral(nodo.moduleSpecifier)) {
      anotar(nodo, nodo.moduleSpecifier.text, "import")
    } else if (
      ts.isExportDeclaration(nodo) &&
      nodo.moduleSpecifier &&
      ts.isStringLiteral(nodo.moduleSpecifier)
    ) {
      anotar(nodo, nodo.moduleSpecifier.text, "export … from")
    } else if (ts.isImportEqualsDeclaration(nodo) && ts.isExternalModuleReference(nodo.moduleReference)) {
      const expr = nodo.moduleReference.expression
      if (ts.isStringLiteral(expr)) anotar(nodo, expr.text, "import =")
    } else if (ts.isCallExpression(nodo)) {
      const esDinamico = nodo.expression.kind === ts.SyntaxKind.ImportKeyword
      const esRequire = ts.isIdentifier(nodo.expression) && nodo.expression.text === "require"
      if ((esDinamico || esRequire) && nodo.arguments.length > 0) {
        const arg = nodo.arguments[0]
        if (ts.isStringLiteral(arg)) anotar(nodo, arg.text, esDinamico ? "import()" : "require()")
        else anotar(nodo, "(especificador no literal)", esDinamico ? "import()" : "require()")
      }
    }
    ts.forEachChild(nodo, visitar)
  }

  visitar(fuente)
  return encontradas
}

/** ¿Este especificador entra en territorio del productor? Cubre el alias `@/`,
 *  las rutas relativas que salen de `scripts/` y las absolutas del repo. */
export function esDelProductor(especificador: string): boolean {
  const limpio = especificador.replace(/^@\//, "").replace(/^\.\.\//g, "").replace(/^\.\//, "")
  const normalizado = limpio.replace(/^\/+/, "")
  const primerTramo = normalizado.split("/")[0]
  if (PROHIBIDOS.includes(primerTramo)) return true
  // `../../lib/x`, `/home/…/micro-erp/models/x` y demás rodeos.
  return PROHIBIDOS.some((p) => new RegExp(`(^|/)${p}/`).test(especificador))
}

export type Resultado = { errores: string[]; importaciones: Importacion[] }

export function verificar(codigo: string): Resultado {
  const importaciones = extraerImportaciones(codigo)
  const errores: string[] = []
  for (const imp of importaciones) {
    if (imp.especificador === "(especificador no literal)") {
      errores.push(
        `línea ${imp.linea}: ${imp.forma} con especificador calculado — el control no puede leerlo, y lo que no se puede comprobar no pasa`
      )
      continue
    }
    if (esDelProductor(imp.especificador)) {
      errores.push(
        `línea ${imp.linea}: ${imp.forma} "${imp.especificador}" entra en el motor (lib/models/ai/app): el auditor dejaría de ser independiente`
      )
      continue
    }
    const externo = !imp.especificador.startsWith(".") && !imp.especificador.startsWith("node:")
    if (externo && !PERMITIDOS.has(imp.especificador)) {
      errores.push(
        `línea ${imp.linea}: ${imp.forma} "${imp.especificador}" no está en la lista de dependencias admitidas del auditor (${[
          ...PERMITIDOS,
        ].join(", ")} y node:*)`
      )
    }
    if (imp.especificador.startsWith(".")) {
      errores.push(
        `línea ${imp.linea}: ${imp.forma} "${imp.especificador}" — el auditor no comparte código con nadie, tampoco dentro de scripts/`
      )
    }
  }
  return { errores, importaciones }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ejecución
// ─────────────────────────────────────────────────────────────────────────────

const codigoAuditor = readFileSync(AUDITOR, "utf8")

/** Control negativo: si el detector no caza esto, tampoco cazaría lo de verdad. */
const CEBO = `
import { computeLedgerHash } from "@/models/ledger"
import { canonicalForm } from "../lib/ledger/hash"
const m = require("../../models/reports")
const p = await import("@/lib/analytics/margins")
`

const ejecucionDirecta =
  typeof process.argv[1] === "string" && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (ejecucionDirecta) {
  const { errores, importaciones } = verificar(codigoAuditor)
  const cebo = verificar(CEBO)
  const fallos: string[] = [...errores]
  if (cebo.errores.length < 4) {
    fallos.push(
      `el control negativo sólo cazó ${cebo.errores.length} de 4 importaciones prohibidas: el detector está ciego`
    )
  }
  if (fallos.length > 0) {
    process.stderr.write("FALLO — scripts/audit-reconstruct.ts no es independiente:\n")
    for (const f of fallos) process.stderr.write(`  · ${f}\n`)
    process.exit(1)
  }
  process.stdout.write(
    `OK — el auditor importa ${importaciones.length} módulo(s), ninguno de lib/models/ai/app: ` +
      `${importaciones.map((i) => i.especificador).join(", ")}\n`
  )
} else {
  const { describe, it, expect } = await import("vitest")

  describe("scripts/audit-reconstruct.ts — independencia del auditor (C4, criterio 14)", () => {
    it("no importa nada de lib/**, models/**, ai/** ni app/**", () => {
      expect(verificar(codigoAuditor).errores).toEqual([])
    })

    it("sólo depende de `pg` y del runtime de Node", () => {
      const externas = extraerImportaciones(codigoAuditor)
        .map((i) => i.especificador)
        .filter((e) => !e.startsWith("node:"))
      expect(externas.every((e) => PERMITIDOS.has(e))).toBe(true)
    })

    it("el detector caza las cuatro formas de importar el motor (control negativo)", () => {
      const cebo = verificar(CEBO)
      expect(cebo.errores.length).toBeGreaterThanOrEqual(4)
      expect(cebo.importaciones.map((i) => i.forma).sort()).toEqual(
        ["import", "import", "import()", "require()"].sort()
      )
    })

    it("reconoce el territorio del productor por alias, ruta relativa y ruta absoluta", () => {
      expect(esDelProductor("@/lib/ledger/hash")).toBe(true)
      expect(esDelProductor("../models/ledger")).toBe(true)
      expect(esDelProductor("../../ai/prompts")).toBe(true)
      expect(esDelProductor("/home/x/micro-erp/app/actions")).toBe(true)
      expect(esDelProductor("pg")).toBe(false)
      expect(esDelProductor("node:crypto")).toBe(false)
    })
  })
}
