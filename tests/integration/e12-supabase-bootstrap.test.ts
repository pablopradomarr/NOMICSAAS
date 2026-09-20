/**
 * E12 · T21 — `scripts/supabase-bootstrap.sql` se audita desde el repositorio.
 *
 * El script lleva **embebidos** los `sha256` de las dos migraciones que el rol
 * `postgres` de Supabase no puede ejecutar (`20260904150000_e1_rls_round2` y
 * `20260906090000_e3_rls_helpers`), para registrarlas como aplicadas sin que
 * `prisma migrate deploy` denuncie deriva. Un checksum embebido que se queda
 * atrás es la peor clase de fallo de despliegue: la base se levanta «bien» y la
 * migración siguiente revienta en producción.
 *
 * Aquí se recomputan desde el disco. Las dos migraciones son **inmutables**
 * (CLAUDE.md), así que este test sólo puede ponerse rojo si alguien las editó —
 * y entonces tiene que ponerse rojo.
 *
 * Y las cuatro adaptaciones de `docs/deploy/DESPLIEGUE-PREVIEW.md` §4: se
 * comprueba que el script las cubre y que **no reintroduce** ninguna de las
 * sentencias que exigen SUPERUSER.
 */

import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"

const RAIZ = process.cwd()
const SCRIPT = path.join(RAIZ, "scripts", "supabase-bootstrap.sql")

/** Las dos migraciones que §4 del runbook declara no ejecutables tal cual. */
const NO_EJECUTABLES = ["20260904150000_e1_rls_round2", "20260906090000_e3_rls_helpers"] as const

async function leerScript(): Promise<string> {
  return await readFile(SCRIPT, "utf8")
}

/**
 * El script **sin comentarios**. La cabecera cita literalmente las cuatro
 * sentencias prohibidas de §4 del runbook —es la documentación de por qué se
 * adaptan— y una búsqueda ingenua las encontraría ahí. Lo que se audita es lo
 * que Postgres ejecuta, no lo que el fichero explica.
 */
function soloSentencias(script: string): string {
  return script
    .split("\n")
    .filter((linea) => !/^\s*(--|\*|\/\*)/.test(linea))
    .join("\n")
}

describe("E12 · T21 — bootstrap de una base Supabase nueva", () => {
  it("embebe el sha256 REAL de cada migración que registra como aplicada", async () => {
    const script = await leerScript()
    for (const nombre of NO_EJECUTABLES) {
      const cuerpo = await readFile(path.join(RAIZ, "prisma", "migrations", nombre, "migration.sql"))
      const checksum = createHash("sha256").update(cuerpo).digest("hex")
      expect(script, `el script no nombra la migración ${nombre}`).toContain(nombre)
      expect(
        script,
        `el checksum embebido para ${nombre} no es el del fichero (${checksum}). ` +
          "Las migraciones son inmutables: si esto falla, se ha editado una."
      ).toContain(checksum)
    }
  })

  it("no reintroduce ninguna sentencia que exija SUPERUSER en Supabase", async () => {
    const script = soloSentencias(await leerScript())
    // `NOSUPERUSER` sobre un rol y `ALTER EXTENSION … SET SCHEMA` son las dos
    // familias que el `postgres` de Supabase (rolsuper = false) no puede.
    const prohibidas: Array<[RegExp, string]> = [
      [/ALTER\s+ROLE\s+\w+\s+WITH[^;']*NOSUPERUSER/i, "ALTER ROLE … NOSUPERUSER"],
      [/ALTER\s+EXTENSION\s+\w+\s+SET\s+SCHEMA/i, "ALTER EXTENSION … SET SCHEMA"],
      [/CREATE\s+ROLE\s+\w+[^;]*\bSUPERUSER\b/i, "CREATE ROLE … SUPERUSER"],
    ]
    for (const [patron, nombre] of prohibidas) {
      expect(patron.test(script), `el bootstrap usa «${nombre}», que exige SUPERUSER`).toBe(false)
    }
  })

  it("cubre las cuatro adaptaciones de §4 del runbook y los tres roles", async () => {
    const script = await leerScript()
    // 1 y 2 · los dos roles con sus atributos, sin `NOSUPERUSER`.
    expect(script).toMatch(/ALTER ROLE app_runtime WITH NOBYPASSRLS/)
    expect(script).toMatch(/ALTER ROLE app_maintenance WITH BYPASSRLS/)
    // 3 · el GRANT incondicional con SET, que es lo que `ALTER … OWNER TO` exige.
    expect(script).toMatch(/GRANT app_maintenance TO %I WITH SET TRUE, ADMIN TRUE/)
    // 4 · CREATE sobre `app` antes de la cesión de propiedad, y revocado después.
    expect(script).toMatch(/GRANT CREATE ON SCHEMA app TO app_maintenance/)
    expect(script).toMatch(/REVOKE CREATE ON SCHEMA app FROM app_maintenance/)
    // El tercer rol (better-auth, E13) también se crea: si no, `AUTH_DATABASE_URL`
    // no tiene con quién conectar y el alta de la base queda a medias.
    expect(script).toMatch(/CREATE ROLE app_auth/)
  })

  it("declara la decisión sobre `btree_gist`: resuelta en base nueva, aceptada con motivo si no", async () => {
    const script = await leerScript()
    expect(script).toMatch(/CREATE EXTENSION btree_gist WITH SCHEMA extensions/)
    expect(script, "la aceptación con motivo tiene que estar escrita, no implícita").toMatch(/ACEPTADO/)
    // Y el `search_path` con `extensions`: sin él los índices EXCLUDE de las
    // migraciones no resuelven `gist_uuid_ops` y la base nueva no migra.
    expect(script).toMatch(/search_path = "\$user", public, extensions/)
  })

  it("es idempotente por construcción: toda creación va condicionada", async () => {
    const script = await leerScript()
    // Ninguna creación «a pelo»: o `IF NOT EXISTS`, o `OR REPLACE`, o dentro de
    // un `IF NOT EXISTS (SELECT 1 FROM pg_roles …)`.
    const creacionesDesnudas = script
      .split("\n")
      .map((linea, indice) => [linea.trim(), indice + 1] as const)
      .filter(([linea]) => /^(CREATE\s+(TABLE|SCHEMA|EXTENSION|POLICY|FUNCTION|ROLE)\b)/i.test(linea))
      .filter(([linea]) => !/IF NOT EXISTS|OR REPLACE/i.test(linea))
      // `CREATE ROLE` y `CREATE POLICY` viven dentro de bloques con guardia
      // explícita (`IF NOT EXISTS (SELECT 1 FROM pg_roles …)` / `DROP POLICY IF
      // EXISTS` inmediatamente antes): se comprueban aparte, más abajo.
      .filter(([linea]) => !/^CREATE\s+(ROLE|POLICY)\b/i.test(linea))
    expect(creacionesDesnudas.map(([l, n]) => `${n}: ${l}`)).toEqual([])
    // La política se recrea siempre precedida de su `DROP POLICY IF EXISTS`.
    expect(script).toMatch(/DROP POLICY IF EXISTS tenant_isolation ON "organizations"/)
  })
})
