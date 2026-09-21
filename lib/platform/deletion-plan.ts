/**
 * E12 · ronda 1 — **el orden de borrado, derivado del catálogo de Postgres**.
 *
 * Había dos borrados masivos en el producto —`reset-org` (ADR-0020 D1) y
 * `purgeDerived` (§4.1)— y cada uno se inventaba su orden: el primero con un
 * topológico que sólo miraba las claves ajenas **entre las tablas que borra**, el
 * segundo con un `sort()` alfabético. Los dos fallaban por la misma puerta, la
 * que el revisor abrió en la ronda 1:
 *
 *  · `invariant_runs → fiscal_years`, `invariant_runs → store_sweeps`,
 *    `closing_runs → fiscal_years`, `extraction_runs → files` —claves ajenas
 *    **entrantes desde tablas que se conservan**, todas `ON DELETE RESTRICT`—
 *    hacían que `reset-org` abortara con `23503` en cualquier organización que
 *    hubiera corrido un barrido;
 *  · `manual_review_flags → invariant_runs` y los `closing_runs` sellados
 *    —conservados por `filtroDe`— hacían lo mismo con la purga, y que hoy no
 *    saltara era suerte del alfabeto.
 *
 * Este módulo es **uno solo para los dos**, es **puro** (recibe las aristas; no
 * abre conexión) y deriva todo de `pg_constraint`: una tabla nueva, o una clave
 * ajena nueva, entran en el sitio correcto sin que nadie lo piense. Es la regla
 * **E-4** («todo inventario es derivado») aplicada al orden.
 *
 * ## La decisión: se RETIENE, no se desengancha
 *
 * Cuando una fila que **sobrevive** al borrado señala a una fila que iba a
 * borrarse, hay dos salidas: poner la clave ajena a `NULL` (desenganchar) o no
 * borrar esa fila (retener). Aquí se retiene **siempre**, y por dos razones que
 * no son de gusto:
 *
 *  1. En `reset-org` las tablas que retienen son las **seis de ADR-0020 D2**
 *     (diario, `audit_logs`, `extraction_runs`, `invariant_runs`,
 *     `closing_runs`): el operador **no tiene privilegio de `UPDATE`** sobre
 *     ellas, así que desenganchar no es una opción legal, es un `permission
 *     denied`. Un barrido sellado que nombra el ejercicio 2026 impide borrar el
 *     ejercicio 2026: correcto, y se dice.
 *  2. En `purgeDerived`, desenganchar sería **mutar una fila que el purgado
 *     declara conservar** —un cierre sellado, una marca de revisión humana— para
 *     poder borrar algo que esa fila señala. Una marca de revisión que apunta a
 *     un barrido que ya no existe es peor que un barrido conservado.
 *
 * Lo retenido **se declara** con el nombre de la tabla que retiene, y va al plan
 * (`reset-org`) y al informe (`purgeDerived`). Nada se retiene en silencio.
 */

export type ForeignKey = {
  /** Nombre de la restricción en el catálogo, para poder nombrarla en el plan. */
  constraint: string
  /** Tabla que **apunta**. */
  child: string
  /** Tabla **apuntada**. */
  parent: string
  /** Pares (columna del hijo → columna del padre), en el orden de la restricción. */
  columns: readonly { child: string; parent: string }[]
}

/**
 * Las claves ajenas reales, leídas del catálogo. La consulta es la misma para
 * los dos llamantes y devuelve **todas** las del esquema: quién borra decide
 * después qué subconjunto le afecta.
 */
export async function readForeignKeys(
  query: (sql: string) => Promise<Array<Record<string, unknown>>>
): Promise<ForeignKey[]> {
  const rows = await query(`
    SELECT c.conname                     AS constraint,
           c.conrelid::regclass::text    AS child,
           c.confrelid::regclass::text   AS parent,
           (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
              FROM unnest(c.conkey)  WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS child_columns,
           (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
              FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS parent_columns
      FROM pg_constraint c
     WHERE c.contype = 'f'
  `)
  return rows.map((row) => {
    const hijos = String(row.child_columns ?? "").split(",")
    const padres = String(row.parent_columns ?? "").split(",")
    return {
      constraint: String(row.constraint),
      child: String(row.child),
      parent: String(row.parent),
      columns: hijos.map((child, i) => ({ child, parent: padres[i] })),
    }
  })
}

export type RetainingKey = ForeignKey & { retainer: string }

export type DeletionPlan = {
  /** Orden topológico: primero las hojas, al final las que todos señalan. */
  order: readonly string[]
  /** Tablas que no entran en el orden por un ciclo entre ellas. Se declaran. */
  cycles: readonly string[]
  /**
   * Por tabla a borrar, las claves ajenas **entrantes** que pueden retener
   * filas. Se convierten en una guarda `NOT EXISTS` en el `DELETE`.
   */
  retainers: Readonly<Record<string, readonly ForeignKey[]>>
}

/**
 * Orden topológico sobre `tables`, y las guardas de retención de cada una.
 *
 * Pura: `edges` son las aristas del catálogo. El orden se decide **sólo** con
 * las aristas internas al conjunto (una tabla que se borra entera no retiene
 * nada); las guardas se calculan con **todas** las aristas entrantes, incluidas
 * las que vienen de tablas que no se borran o que se borran sólo en parte.
 */
export function planDeletion(
  tables: readonly string[],
  edges: readonly ForeignKey[],
  /**
   * Tablas del conjunto que se borran **sólo en parte** (llevan filtro de
   * filas): `closing_runs` en la purga. Sus filas supervivientes retienen.
   */
  filtered: ReadonlySet<string> = new Set()
): DeletionPlan {
  const set = new Set(tables)

  /**
   * **Quién puede quedar con filas cuando el borrado termine.** Una tabla que se
   * borra entera no retiene nada: para cuando le toque a su padre ya no queda
   * una sola fila que señale. Retienen (a) las que no se borran, (b) las que se
   * borran con filtro y (c) —por punto fijo— las que retienen porque algo de (a)
   * o (b) las señala. Sin este cálculo, el plan enumeraría como «retenida» una
   * `business_lines` que sólo espera a que se borren sus proyectos.
   */
  const sobreviven = new Set<string>(filtered)
  for (const fk of edges) {
    if (set.has(fk.parent) && !set.has(fk.child) && fk.child !== fk.parent) sobreviven.add(fk.parent)
  }
  for (let cambio = true; cambio; ) {
    cambio = false
    for (const fk of edges) {
      if (fk.child === fk.parent || !set.has(fk.parent)) continue
      if (sobreviven.has(fk.child) && !sobreviven.has(fk.parent)) {
        sobreviven.add(fk.parent)
        cambio = true
      }
    }
  }

  const dependents = new Map<string, Set<string>>()
  const pending = new Map<string, number>()
  for (const t of set) {
    dependents.set(t, new Set())
    pending.set(t, 0)
  }
  const retainers: Record<string, ForeignKey[]> = {}
  for (const t of set) retainers[t] = []

  for (const fk of edges) {
    if (!set.has(fk.parent) || fk.child === fk.parent) continue
    // Guarda de retención: sólo si el hijo puede quedar con filas cuando el
    // borrado termine. Si se borra entero, la guarda sobraría y además haría
    // que el plan contara como «retenidas» filas que sí se van a borrar.
    if (!set.has(fk.child) || sobreviven.has(fk.child)) retainers[fk.parent].push(fk)
    if (!set.has(fk.child)) continue
    if (dependents.get(fk.parent)!.has(fk.child)) continue
    dependents.get(fk.parent)!.add(fk.child)
    pending.set(fk.parent, (pending.get(fk.parent) ?? 0) + 1)
  }

  const order: string[] = []
  const ready = [...set].filter((t) => (pending.get(t) ?? 0) === 0).sort()
  const childrenOf = new Map<string, string[]>()
  for (const [parent, hijos] of dependents) {
    for (const h of hijos) childrenOf.set(h, [...(childrenOf.get(h) ?? []), parent])
  }
  while (ready.length > 0) {
    const t = ready.shift()!
    order.push(t)
    for (const parent of childrenOf.get(t) ?? []) {
      const n = (pending.get(parent) ?? 0) - 1
      pending.set(parent, n)
      if (n === 0) ready.push(parent)
    }
    ready.sort()
  }
  const cycles = [...set].filter((t) => !order.includes(t)).sort()
  return { order, cycles, retainers }
}

/**
 * El `WHERE` de un borrado: el filtro propio de la tabla más una guarda
 * `NOT EXISTS` por cada clave ajena entrante.
 *
 * `$1` es siempre la organización. La cláusula se escribe con nombres de
 * identificador entrecomillados y sin interpolar un solo valor: lo único que
 * viene de fuera son nombres leídos del catálogo de Postgres.
 */
export function retentionWhere(
  table: string,
  plan: DeletionPlan,
  extra: string | null = null,
  /**
   * Qué guardas **cuentan** en esta llamada. La enumeración las mira en orden
   * topológico y descarta las de los hijos que para entonces ya estarán vacíos:
   * así el plan dice lo que va a pasar y no una cota pesimista. En la ejecución
   * no se pasa nada —las filas hijas ya no están— y todas valen.
   */
  keep: (fk: ForeignKey) => boolean = () => true
): string {
  const partes = [`"${table}"."organization_id" = $1::uuid`]
  if (extra) partes.push(`(${extra})`)
  for (const fk of (plan.retainers[table] ?? []).filter(keep)) {
    const on = fk.columns.map(({ child, parent }) => `"h"."${child}" = "${table}"."${parent}"`).join(" AND ")
    partes.push(`NOT EXISTS (SELECT 1 FROM "${fk.child}" AS "h" WHERE ${on})`)
  }
  return partes.join(" AND ")
}

/** El `DELETE` completo de una tabla, con sus guardas. */
export function deleteStatement(
  table: string,
  plan: DeletionPlan,
  extra: string | null = null,
  keep: (fk: ForeignKey) => boolean = () => true
): string {
  return `DELETE FROM "${table}" WHERE ${retentionWhere(table, plan, extra, keep)}`
}

/**
 * Lo que quedó sin borrar y quién lo retiene. Se calcula **después** del
 * borrado, contando lo que sigue ahí: no se estima, se cuenta.
 */
export type Retention = { table: string; rows: number; retainedBy: readonly string[] }

export function retainersOf(table: string, plan: DeletionPlan): readonly string[] {
  return [...new Set((plan.retainers[table] ?? []).map((fk) => fk.child))].sort()
}
