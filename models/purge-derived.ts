/**
 * E12 · T10 — **`purgeDerived`: borrar todo lo que el sistema recuerda haber
 * calculado** (docs/design/E12-fiabilidad-dod.md §4.1).
 *
 * Es la mitad operativa del test que la `SPEC-FIABILIDAD` §6 nombra por su
 * nombre y que nunca se había hecho:
 *
 * > Borrado todo lo que el sistema recuerda haber calculado, y regenerado desde
 * > el diario, las cifras y los sellos son idénticos byte a byte.
 *
 * ## La lista es un REGISTRO EXPLÍCITO, y un detector vigila que no falte nadie
 *
 * Hasta la ronda 1 de E12 la lista salía de un criterio estructural —nombre
 * terminado en `_runs`/`_sweeps`, o columna con el hash de sus fuentes— y una
 * lista de excepciones. Era derivada, sí, pero decidía **sola** que una tabla
 * nueva es caché y la borraba: exactamente el error contrario al que E-4 quiere
 * evitar, y el que hizo falta parchear con excepciones cuatro veces
 * (`extraction_runs`, `closing_runs`, `cron_runs`, `onboarding_runs` — cuatro de
 * nueve candidatas: el criterio acertaba menos de la mitad de las veces).
 *
 * Ahora hay **dos piezas**, y ninguna sola basta:
 *
 *  1. **`DERIVED_MODELS`** — el registro: *qué es derivado*, tabla por tabla,
 *     **con el motivo escrito** y, si la tabla lo es sólo en parte, con el filtro
 *     de las filas que sí se purgan. Nada se borra por parecerlo.
 *  2. **El detector `pareceCache()`** — el criterio estructural de antes, que ya
 *     no decide nada: sólo **acusa**. Una tabla que lo cumple y no está ni en el
 *     registro ni declarada fuente aparece en `tablasSinDeclarar()`, y el test
 *     de T10 **falla nombrándola**. Una tabla `_runs` nueva no entra sola en la
 *     purga: obliga a alguien a decidir de qué lado cae y a escribir por qué.
 *
 * ## Qué es «derivado», escrito de una vez
 *
 * Derivado = **se puede volver a calcular desde la fuente única de verdad (el
 * diario, los documentos, la configuración versionada) y da exactamente lo
 * mismo**. Si borrarlo pierde un hecho —quién extrajo qué con qué modelo, que un
 * ejercicio se cerró tal día, que un job ya se devengó— no es caché: es fuente, y
 * conservarla no es una excepción al purgado, es su definición.
 *
 * ## Lo que NO se borra, y es la mitad del test
 *
 * El diario, los documentos y sus bytes, el `AuditLog`, los `ExtractionRun`, los
 * extractos bancarios y la configuración versionada. Eso es la fuente única de
 * verdad. Si algo de la SoT hiciera falta borrarlo para que el test pase, el
 * test estaría mal escrito; **si algo derivado no se puede borrar sin perder una
 * cifra, entonces es una fuente encubierta y el producto está mal**.
 *
 * ## El orden de borrado se comparte con `reset-org`
 *
 * Desde la ronda 1, el orden sale de `lib/platform/deletion-plan.ts` —topológico
 * sobre `pg_constraint`— y no de un `sort()` alfabético. Un `ManualReviewFlag` o
 * un cierre sellado que señalan un `InvariantRun` ya no rompen la purga con un
 * `23503`: **retienen** ese barrido, y la retención se declara en el informe.
 */

import { prismaSchemaMeta } from "@/lib/db"
import {
  deleteStatement,
  planDeletion,
  readForeignKeys,
  retainersOf,
} from "@/lib/platform/deletion-plan"
import { derivedSealColumns, type SchemaModel } from "@/lib/platform/backup"

/**
 * **El registro de lo derivado.** Una tabla se purga si y sólo si está aquí, con
 * su motivo. `where` acota las filas cuando la tabla es derivada sólo en parte.
 */
export const DERIVED_MODELS: Readonly<Record<string, { motivo: string; where?: string }>> = {
  allocation_runs: {
    motivo:
      "Una ejecución de imputación: reparte costes según las reglas vigentes y el diario. Se vuelve a correr y da " +
      "lo mismo (R-A3/R-A4). No guarda ningún hecho que no esté en la fuente.",
  },
  invariant_runs: {
    motivo:
      "El barrido de invariantes ES el cálculo: lee el diario y dice si cuadra. Regenerarlo sobre el mismo diario " +
      "da el mismo sello y las mismas cifras — y que eso sea cierto es justo lo que el test de «memoria borrada» comprueba.",
  },
  report_runs: {
    motivo:
      "Los informes son VISTAS del libro diario (principio 3 de CLAUDE.md): balance, PyG, cashflow y PyG analítica " +
      "se derivan por SQL del diario. Una cifra de informe guardada es caché, nunca fuente.",
  },
  store_sweeps: {
    motivo:
      "El barrido del almacén recorre los objetos y compara sha256 contra `stored_objects`. Lo que afirma se puede " +
      "volver a mirar: los bytes son la fuente, el barrido es la lectura.",
  },
  usage_runs: {
    motivo:
      "El consumo del periodo se recalcula contando lo que hay (documentos, asientos, bytes). Es un agregado, y su " +
      "entrada en la factura vive en `PlatformInvoice`, que no se purga.",
  },
  closing_runs: {
    motivo:
      "Derivada SÓLO en los estados de cálculo a medias. Un cierre CERRADO o REABIERTO es un HECHO contable —el " +
      "ejercicio se cerró ese día y con esos asientos—: es un sello, no una caché, y se conserva. BORRADOR, " +
      "COMPROBADO y ABORTADO son intentos y sí se purgan. Los valores se escriben aquí, y no se derivan del " +
      "enumerado, para que añadir un estado nuevo OBLIGUE a decidir de qué lado cae.",
    where: "status NOT IN ('CERRADO', 'REABIERTO')",
  },
}

/**
 * Tablas que **parecen** caché por su forma y son fuente. Lista cerrada, con
 * motivo: es lo que impide que el detector acuse a un inocente cada vez.
 */
export const FUENTES_AUNQUE_LO_PAREZCAN: Readonly<Record<string, string>> = {
  extraction_runs:
    "Es la PROCEDENCIA de un asiento (P1, I-E8-11): qué modelo, con qué prompt y con qué sha propuso qué. " +
    "No se puede recomputar —el modelo ya no existe, el prompt cambió— y sin ella un asiento pierde su origen.",
  cron_runs:
    "Es la bitácora del reloj y la clave de idempotencia `(job, periodKey)`: borrarla haría que un job " +
    "devengado volviera a ejecutarse. No es una caché, es una memoria de hechos (I-E11-12).",
  onboarding_runs:
    "Registra que una organización se sembró y con qué fixture. No se recomputa: el alta ocurrió una vez.",
}

/**
 * El detector. **No decide**: acusa. Cumplirlo es motivo suficiente para que
 * alguien tenga que declarar la tabla, en un lado o en el otro.
 */
export function pareceCache(model: SchemaModel): boolean {
  return (
    /_(runs|sweeps)$/.test(model.table) ||
    model.columns.some((column) => /(^|_)(source_hash|inputs_hash|source_sha256)$/.test(column.column))
  )
}

/**
 * Las tablas de tenant que el detector acusa y **nadie ha declarado**: ni en
 * `DERIVED_MODELS` ni en `FUENTES_AUNQUE_LO_PAREZCAN`. El test de T10 falla
 * nombrándolas. Es la guardia que sustituye a «entra sola en la lista».
 */
export function tablasSinDeclarar(meta: readonly SchemaModel[] = prismaSchemaMeta()): string[] {
  return meta
    .filter((model) => pareceCache(model))
    .filter((model) => model.columns.some((column) => column.column === "organization_id"))
    .map((model) => model.table)
    .filter((table) => DERIVED_MODELS[table] === undefined && FUENTES_AUNQUE_LO_PAREZCAN[table] === undefined)
    .sort()
}

/** El filtro de filas de una tabla parcialmente derivada. `null` = toda la tabla. */
export function filtroDe(table: string): string | null {
  return DERIVED_MODELS[table]?.where ?? null
}

export type TablaDerivada = { table: string; where: string | null; motivo: string }

/**
 * Las tablas que se purgan: las del registro **que existen en el esquema y son
 * de tenant**. Es pura —recibe el modelo de datos por parámetro— y una entrada
 * del registro que nombre una tabla inexistente la caza el test de T10, no un
 * `DELETE` contra una tabla que no está.
 */
export function derivedTables(meta: readonly SchemaModel[] = prismaSchemaMeta()): TablaDerivada[] {
  const out: TablaDerivada[] = []
  for (const [table, { motivo, where }] of Object.entries(DERIVED_MODELS)) {
    const model = meta.find((m) => m.table === table)
    if (!model) continue
    // Sólo tablas de tenant: una tabla global no es de nadie y no se purga por
    // organización.
    if (!model.columns.some((column) => column.column === "organization_id")) continue
    out.push({ table, where: where ?? null, motivo })
  }
  return out.sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0))
}

/**
 * Las columnas-sello **recomputables** que se ponen a `NULL`.
 *
 * Salen de `derivedSealColumns()` —la misma lista que usa el backup, derivada
 * del modelo de datos— menos las que **no** se pueden recomputar desde la
 * fuente, que se declaran aquí con su motivo. Compartir la derivación con el
 * backup no es una comodidad: es lo que impide que las dos listas se separen.
 */
export const SELLOS_NO_RECOMPUTABLES: Readonly<Record<string, string>> = {
  "invitations.token_hash":
    "Es el hash de un SECRETO de acceso, no una huella del contenido: no se deriva de ningún dato y ponerlo " +
    "a NULL invalidaría invitaciones vivas.",
  "journal_entries.entry_hash":
    "Es el sello DE FILA del asiento, y un trigger de la base impide escribirlo con otro valor que el " +
    "recalculado: ponerlo a NULL no es purgar una caché, es intentar romper una guardia (I-E3-7).",
  "extraction_runs.prompt_sha":
    "Procedencia de la extracción: el prompt de entonces. No se recomputa desde los datos de hoy.",
  "extraction_runs.schema_sha": "Ídem: el esquema de extracción de entonces.",
  "extraction_runs.proposal_sha": "Ídem: la propuesta que el modelo hizo y que I-E8-11 vigila.",
  "extraction_runs.file_sha256": "Es el sha de los BYTES del documento, que son la fuente (I-E8-2).",
  "files.sha256": "La verdad sobre los bytes del documento (I-E8-2). Es fuente, no derivado.",
  "stored_objects.sha256": "El sha de los bytes que hay en el almacén: fuente.",
  "bank_statements.file_sha256": "El sha del extracto bancario, que es la fuente externa (C5).",
  "audit_logs.record_sha256": "El registro de auditoría es append-only y es memoria de hechos, no caché.",
}

export type SelloPurgable = { table: string; column: string }

/**
 * Las columnas-sello que `purgeDerived` pone a `NULL`, derivadas de
 * `derivedSealColumns()` menos las declaradas no recomputables.
 *
 * Es la lista de **candidatas**: el modelo de datos del cliente Prisma no dice
 * si una columna admite `NULL`, así que quién puede vaciarse de verdad lo decide
 * `purgeDerived` preguntándoselo al catálogo. Una columna `NOT NULL` que lleva un
 * sello es, por construcción, un sello que la fila no puede no tener —parte de la
 * fila, no una caché encima de ella— y se **salta declarándolo**, que es la
 * diferencia con comerse la excepción (H-7).
 */
export function purgableSeals(meta: readonly SchemaModel[] = prismaSchemaMeta()): SelloPurgable[] {
  return derivedSealColumns(meta)
    .filter(({ table, column }) => SELLOS_NO_RECOMPUTABLES[`${table}.${column}`] === undefined)
    .filter(({ table }) => {
      const model = meta.find((m) => m.table === table)
      return model?.columns.some((c) => c.column === "organization_id") ?? false
    })
}

export type PurgeReport = {
  tables: Array<{ table: string; deleted: number }>
  /**
   * Una columna-sello puesta a `NULL`. `nulled` es el número de filas tocadas;
   * `error` está puesto **sólo** si el `UPDATE` no pudo correr. Antes las dos
   * cosas se escribían igual (`nulled: 0`) y «no había nada que anular» era
   * indistinguible de «falló» (H-7 de la auditoría).
   */
  seals: Array<{ table: string; column: string; nulled: number; error?: string; skipped?: string }>
  /** Lo que NO se borró porque una fila superviviente lo señala. Se declara. */
  retained: Array<{ table: string; rows: number; retainedBy: readonly string[] }>
  totalDeleted: number
  totalNulled: number
  /** Columnas-sello cuyo `UPDATE` falló. Si hay alguna, el llamante lo sabe. */
  sealErrors: number
  /** Columnas-sello `NOT NULL`: no se intentan, y se dice por qué. */
  sealSkipped: number
}

/**
 * Borra **todo lo derivado** de una organización.
 *
 * Se ejecuta con un cliente de OPERADOR (`app_maintenance`, BYPASSRLS): la
 * aplicación no puede hacer esto y no debe poder. El llamante pasa la función de
 * consulta; así el módulo no decide con qué credencial se conecta —el mismo
 * patrón que `scripts/prune-runs.ts`— y el test puede ejercerlo sin que exista
 * un camino de producto que lo alcance.
 *
 * **El orden.** Topológico sobre `pg_constraint`, compartido con `reset-org`
 * (`lib/platform/deletion-plan.ts`). Cada `DELETE` lleva, además del filtro de
 * la tabla, una guarda `NOT EXISTS` por cada clave ajena entrante: una fila que
 * sobrevive —un `ManualReviewFlag`, un cierre `CERRADO`— **retiene** lo que
 * señala, y la retención va al informe con el nombre de quien retiene. No se
 * desengancha poniendo la clave a `NULL`: eso sería mutar una fila que el
 * purgado declara conservar.
 *
 * **Sobre el baile `NO FORCE → UPDATE → FORCE`.** CLAUDE.md lo exige para los
 * backfills *de migración*, porque con `FORCE ROW LEVEL SECURITY` ni el
 * propietario esquiva las políticas y el `UPDATE` vería cero filas — y ofrece
 * explícitamente la alternativa: **ejecutarlo como `app_maintenance`**. Es la que
 * se usa aquí, y es mejor por dos razones: `app_maintenance` tiene `BYPASSRLS`,
 * así que ve las filas sin tocar nada; y **no es propietario de las tablas**, así
 * que ni siquiera *puede* dejarse una en `NO FORCE` por un fallo a mitad. La
 * segunda barrera del multi-tenant no se abre en ningún momento.
 */
export async function purgeDerived(
  organizationId: string,
  query: (sql: string, params?: readonly unknown[]) => Promise<Array<Record<string, unknown>>>,
  meta: readonly SchemaModel[] = prismaSchemaMeta()
): Promise<PurgeReport> {
  const report: PurgeReport = {
    tables: [],
    seals: [],
    retained: [],
    totalDeleted: 0,
    totalNulled: 0,
    sealErrors: 0,
    sealSkipped: 0,
  }

  const tablas = derivedTables(meta)
  const filtros = new Map(tablas.map((t) => [t.table, t.where]))
  const edges = await readForeignKeys(async (sql) => await query(sql))
  const plan = planDeletion(
    tablas.map((t) => t.table),
    edges,
    new Set(tablas.filter((t) => t.where !== null).map((t) => t.table))
  )
  if (plan.cycles.length > 0) {
    throw new Error(
      `ciclo de claves ajenas entre ${plan.cycles.join(", ")}: la purga no tiene orden seguro y se detiene`
    )
  }

  for (const table of plan.order) {
    const filas = await query(`${deleteStatement(table, plan, filtros.get(table) ?? null)} RETURNING 1 AS borrada`, [
      organizationId,
    ])
    report.tables.push({ table, deleted: filas.length })
    report.totalDeleted += filas.length
  }

  // Lo retenido se CUENTA después de borrar; no se estima.
  for (const table of [...plan.order].sort()) {
    const where = filtros.get(table) ?? null
    const quedan = await query(
      `SELECT count(*)::text AS n FROM "${table}" WHERE "${table}"."organization_id" = $1::uuid` +
        (where ? ` AND (${where})` : ""),
      [organizationId]
    )
    const n = Number(quedan[0]?.n ?? 0)
    if (n > 0) report.retained.push({ table, rows: n, retainedBy: retainersOf(table, plan) })
  }

  /**
   * La nulabilidad **la dice el catálogo**, no el modelo de datos: el
   * `_runtimeDataModel` de Prisma no la expone, y adivinarla fue justo lo que
   * convirtió doce excepciones en doce «0 filas tocadas» (H-7).
   */
  const nulables = new Set(
    (
      await query(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND is_nullable = 'YES'`
      )
    ).map((row) => `${String(row.table_name)}.${String(row.column_name)}`)
  )

  for (const { table, column } of purgableSeals(meta)) {
    if (!nulables.has(`${table}.${column}`)) {
      report.seals.push({
        table,
        column,
        nulled: 0,
        skipped: "NOT NULL: el sello es parte de la fila, no una caché encima de ella",
      })
      report.sealSkipped += 1
      continue
    }
    try {
      const filas = await query(
        `UPDATE "${table}" SET "${column}" = NULL
          WHERE organization_id = $1::uuid AND "${column}" IS NOT NULL RETURNING 1 AS tocada`,
        [organizationId]
      )
      report.seals.push({ table, column, nulled: filas.length })
      report.totalNulled += filas.length
    } catch (error) {
      /**
       * Una columna-sello `NOT NULL`, o protegida por un disparador, no se puede
       * vaciar. **Eso no es un fallo del purgado: es la base diciendo que ese
       * sello es parte de la fila y no una caché encima de ella.** Pero ahora se
       * anota **como error, con su mensaje**, y no como `nulled: 0`: «no había
       * nada que anular» y «el UPDATE falló» son cosas distintas y el informe
       * las distingue (H-7).
       */
      report.seals.push({ table, column, nulled: 0, error: error instanceof Error ? error.message : String(error) })
      report.sealErrors += 1
    }
  }

  return report
}
