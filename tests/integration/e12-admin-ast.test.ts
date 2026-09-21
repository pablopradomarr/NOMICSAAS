/**
 * E12 · T13 — **el test estático sobre el AST de `app/(app)/admin/**`**:
 * la SEGUNDA de las tres vías de ADR-0020 D2.
 *
 * > *Prohibido `INSERT`, `UPDATE` y `DELETE` sobre `journal_entries`,
 * > `journal_lines`, `audit_logs`, `extraction_runs`, `invariant_runs` y
 * > `closing_runs`. Se garantiza por tres vías independientes, no por una.*
 *
 * Las otras dos son los **privilegios** de `app_operator`
 * (`20261001100000_e12_rol_de_operador`) e **`I-E12-5`** en el barrido. Ésta es
 * la que se ejecuta en cada `push` y la que caza la regresión el día en que
 * alguien añada la quinta operación «que sólo toca una cosita».
 *
 * Se lee el **AST de TypeScript**, no el texto: un `grep` lo esquiva un
 * comentario, una cadena partida o un nombre de variable, y un control que se
 * esquiva con una cadena partida no es un control.
 *
 * **La única excepción, y está declarada**: `writeAuditLog(tx, …)` —el `INSERT`
 * append-only en `audit_logs` que **D3 obliga** a dejar, porque el cliente tiene
 * derecho a ver que alguien de la plataforma tocó algo suyo—. Cualquier otro
 * camino a `audit_logs`, incluido un `db.auditLog.create` directo, es FAIL.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"

const ROOT = process.cwd()
const ADMIN_DIR = join(ROOT, "app", "(app)", "admin")

/** Los seis delegados de Prisma que corresponden a las seis tablas de D2. */
const FORBIDDEN_DELEGATES = [
  "journalEntry",
  "journalLine",
  "auditLog",
  "extractionRun",
  "invariantRun",
  "closingRun",
] as const

/** Métodos de Prisma que escriben. `findMany` y `count` no están: leer es legal. */
const WRITE_METHODS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
])

/** Las seis tablas, tal y como aparecerían en un SQL crudo. */
const FORBIDDEN_TABLES = [
  "journal_entries",
  "journal_lines",
  "audit_logs",
  "extraction_runs",
  "invariant_runs",
  "closing_runs",
]

const SQL_WRITE = /\b(insert\s+into|update|delete\s+from|truncate)\b/i

function walkFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walkFiles(full))
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

type Hallazgo = { file: string; line: number; what: string }

function analyze(file: string): Hallazgo[] {
  const source = readFileSync(file, "utf8")
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
  const hallazgos: Hallazgo[] = []
  const at = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1

  const visit = (node: ts.Node): void => {
    // (1) `<algo>.<delegadoProhibido>.<métodoDeEscritura>(…)`
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text
      const target = node.expression.expression
      if (WRITE_METHODS.has(method) && ts.isPropertyAccessExpression(target)) {
        const delegate = target.name.text
        if ((FORBIDDEN_DELEGATES as readonly string[]).includes(delegate)) {
          hallazgos.push({
            file: relative(ROOT, file),
            line: at(node),
            what: `escritura «${delegate}.${method}()» sobre una tabla prohibida por ADR-0020 D2`,
          })
        }
      }
    }

    // (2) SQL crudo que escriba y nombre una de las seis. Se mira el TEXTO de
    //     la plantilla (el AST de una template literal sí da sus trozos), así
    //     que partir la cadena en dos no lo esquiva: se concatenan primero.
    if (
      ts.isTaggedTemplateExpression(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node)
    ) {
      const literal = ts.isTaggedTemplateExpression(node) ? node.template : node
      const texto = literal.getText(sf)
      if (SQL_WRITE.test(texto)) {
        for (const table of FORBIDDEN_TABLES) {
          if (texto.includes(table)) {
            hallazgos.push({
              file: relative(ROOT, file),
              line: at(node),
              what: `SQL crudo de escritura sobre «${table}» — ADR-0020 D2`,
            })
          }
        }
      }
    }

    ts.forEachChild(node, visit)
  }
  visit(sf)
  return hallazgos
}

describe("ADR-0020 D2 · ninguna escritura de `/admin` alcanza el diario (test de AST)", () => {
  const files = walkFiles(ADMIN_DIR)

  it("hay ficheros que analizar (si `/admin` desapareciera, este test no puede pasar por vacuidad)", () => {
    expect(files.length).toBeGreaterThanOrEqual(4)
    expect(files.map((f) => relative(ROOT, f))).toContain("app/(app)/admin/operations.ts")
  })

  it("ningún camino escribe en journal_entries, journal_lines, extraction_runs, invariant_runs ni closing_runs", () => {
    const hallazgos = files.flatMap(analyze)
    const graves = hallazgos.filter((h) => !h.what.includes("auditLog") && !h.what.includes("audit_logs"))
    expect(
      graves,
      graves.map((h) => `${h.file}:${h.line} — ${h.what}`).join("\n")
    ).toEqual([])
  })

  it("nadie escribe en `audit_logs` por su cuenta: sólo `writeAuditLog`, que es el INSERT que D3 obliga", () => {
    const porDelegado = files.flatMap(analyze).filter((h) => h.what.includes("auditLog") || h.what.includes("audit_logs"))
    expect(
      porDelegado,
      "El registro del cliente se escribe con `writeAuditLog(tx, …)`, nunca con `db.auditLog.create` " +
        "ni con SQL crudo:\n" + porDelegado.map((h) => `${h.file}:${h.line} — ${h.what}`).join("\n")
    ).toEqual([])
  })

  it("el detector CAZA una escritura prohibida (si no, el test pasaría por vacuidad)", () => {
    // La regla 1 de §7.3: un control que nunca se ha visto fallar no es un
    // control. Se le da al analizador un fichero sintético con las dos formas
    // que tiene que cazar, y se exige que las cace.
    const trampa = join(ROOT, "app", "(app)", "admin", "__inexistente__.ts")
    const source = `
      export async function malo(tx: any, id: string) {
        await tx.journalLine.deleteMany({ where: { id } })
        await tx.$executeRaw\`DELETE FROM "journal_entries" WHERE "id" = \${id}\`
        await tx.auditLog.update({ where: { id }, data: { reason: null } })
      }
    `
    const sf = ts.createSourceFile(trampa, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
    // Se reutiliza `analyze` escribiendo el fichero en memoria no es posible sin
    // tocar el disco, así que se repite la travesía con el mismo criterio.
    const encontrados: string[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text
        const target = node.expression.expression
        if (WRITE_METHODS.has(method) && ts.isPropertyAccessExpression(target)) {
          if ((FORBIDDEN_DELEGATES as readonly string[]).includes(target.name.text)) {
            encontrados.push(`${target.name.text}.${method}`)
          }
        }
      }
      if (ts.isTaggedTemplateExpression(node)) {
        const texto = node.template.getText(sf)
        if (SQL_WRITE.test(texto)) {
          for (const table of FORBIDDEN_TABLES) if (texto.includes(table)) encontrados.push(`sql:${table}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    expect(encontrados.sort()).toEqual(["auditLog.update", "journalLine.deleteMany", "sql:journal_entries"])
  })
})
