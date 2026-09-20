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
 * ## La lista se DERIVA. No se escribe a mano.
 *
 * Una lista de tablas mantenida a mano ha fallado **cuatro veces** en este
 * proyecto —BUG-E7-1, BUG-E9-5, BUG-E10-1, BUG-E11-2—, siempre igual: una épica
 * añade una tabla, nadie se acuerda de añadirla a la lista, y el vaciado (o el
 * backup, o la purga) la deja fuera **en silencio**. La enmienda **E-4** lo
 * eleva a regla: *todo inventario es derivado*.
 *
 * Aquí una tabla de tenant es **derivada** cuando cumple una propiedad
 * ESTRUCTURAL, no cuando alguien la apunta:
 *
 *  1. **su nombre termina en `_runs` o `_sweeps`** — una «ejecución» o un
 *     «barrido» es, por definición, el registro de un cálculo; o
 *  2. **declara el hash de sus fuentes** (`source_hash`, `inputs_hash`,
 *     `source_sha256`) — que es, literalmente, la regla 4 de §7.3: *un derivado
 *     nuevo declara su hash de fuente; si no se puede recomputar, no es un
 *     derivado, es una fuente y necesita ADR*.
 *
 * Y se **excluyen** las que cumplen la propiedad y aun así son fuente, en una
 * lista **cerrada, corta y con el motivo escrito** (`FUENTES_AUNQUE_LO_PAREZCAN`).
 * Un test comprueba que cada exclusión sigue cumpliendo el criterio estructural:
 * si alguien mete ahí una tabla que no lo cumple, la exclusión sobra y se ve.
 *
 * ## Lo que NO se borra, y es la mitad del test
 *
 * El diario, los documentos y sus bytes, el `AuditLog`, los `ExtractionRun`, los
 * extractos bancarios y la configuración versionada. Eso es la fuente única de
 * verdad. Si algo de la SoT hiciera falta borrarlo para que el test pase, el
 * test estaría mal escrito; **si algo derivado no se puede borrar sin perder una
 * cifra, entonces es una fuente encubierta y el producto está mal**.
 */

import { prismaSchemaMeta } from "@/lib/db"
import { derivedSealColumns, type SchemaModel } from "@/lib/platform/backup"

/**
 * Tablas que cumplen el criterio estructural de «derivada» y **son fuente**.
 * Lista cerrada, con motivo. Cada entrada la audita un test.
 */
export const FUENTES_AUNQUE_LO_PAREZCAN: Readonly<Record<string, string>> = {
  extraction_runs:
    "Es la PROCEDENCIA de un asiento (P1, I-E8-11): qué modelo, con qué prompt y con qué sha propuso qué. " +
    "No se puede recomputar —el modelo ya no existe, el prompt cambió— y sin ella un asiento pierde su origen.",
  closing_runs:
    "Un cierre CERRADO o REABIERTO es un hecho contable: el ejercicio se cerró ese día y con esos asientos. " +
    "Los que están en BORRADOR, COMPROBADO o ABORTADO son cálculos a medias y sí se purgan (ver `filtroDe`).",
  cron_runs:
    "Es la bitácora del reloj y la clave de idempotencia `(job, periodKey)`: borrarla haría que un job " +
    "devengado volviera a ejecutarse. No es una caché, es una memoria de hechos (I-E11-12).",
  onboarding_runs:
    "Registra que una organización se sembró y con qué fixture. No se recomputa: el alta ocurrió una vez.",
}

/** El filtro de filas de una tabla parcialmente derivada. `null` = toda la tabla. */
export function filtroDe(table: string): string | null {
  /**
   * **`closing_runs` no sellados.** El diseño dice «`closing_runs` no sellados»;
   * el enumerado del esquema no tiene un valor `SELLADO`, tiene cinco estados, y
   * lo que «sellado» significa aquí es **el cierre que ya ocurrió**: `CERRADO` y
   * `REABIERTO` (una reapertura es un hecho tan registrado como el cierre, E9).
   * Lo demás —`BORRADOR`, `COMPROBADO`, `ABORTADO`— es un cálculo a medias que se
   * regenera.
   *
   * Los valores se escriben aquí, y no se derivan del enumerado, precisamente
   * porque **añadir un estado nuevo tiene que obligar a decidir de qué lado
   * cae**: derivarlo por descarte metería un estado futuro en la purga sin que
   * nadie lo pensara.
   */
  if (table === "closing_runs") return "status NOT IN ('CERRADO', 'REABIERTO')"
  return null
}

export type TablaDerivada = { table: string; where: string | null; motivo: string }

/**
 * La lista de tablas derivadas, **derivada del esquema**.
 *
 * Es pura: recibe el modelo de datos por parámetro (igual que `backupInventory`
 * y `derivedSealColumns`), de modo que se puede probar sin base y que una tabla
 * nueva entra sola.
 */
export function derivedTables(meta: readonly SchemaModel[] = prismaSchemaMeta()): TablaDerivada[] {
  const out: TablaDerivada[] = []
  for (const model of meta) {
    const esRunOSweep = /_(runs|sweeps)$/.test(model.table)
    const columnaDeFuente = model.columns.find((column) =>
      /(^|_)(source_hash|inputs_hash|source_sha256)$/.test(column.column)
    )
    if (!esRunOSweep && !columnaDeFuente) continue
    // Sólo tablas de tenant: una tabla global no es de nadie y no se purga por
    // organización.
    if (!model.columns.some((column) => column.column === "organization_id")) continue

    const excluida = FUENTES_AUNQUE_LO_PAREZCAN[model.table]
    if (excluida !== undefined && filtroDe(model.table) === null) continue

    out.push({
      table: model.table,
      where: filtroDe(model.table),
      motivo: esRunOSweep
        ? `«${model.table}» registra una ejecución: su nombre termina en _runs/_sweeps`
        : `«${model.table}» declara el hash de sus fuentes (${columnaDeFuente!.column}), luego es recomputable`,
    })
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
 * **Sólo las columnas que admiten `NULL`**: una columna `NOT NULL` que llevara un
 * sello es, por construcción, un sello que la fila no puede no tener — y eso la
 * hace parte de la fila, no una caché encima de ella.
 */
export function purgableSeals(meta: readonly SchemaModel[] = prismaSchemaMeta()): SelloPurgable[] {
  return derivedSealColumns(meta)
    .filter(({ table, column }) => SELLOS_NO_RECOMPUTABLES[`${table}.${column}`] === undefined)
    .filter(({ table }) => {
      const model = meta.find((m) => m.table === table)
      return model?.columns.some((column) => column.column === "organization_id") ?? false
    })
}

export type PurgeReport = {
  tables: Array<{ table: string; deleted: number }>
  seals: Array<{ table: string; column: string; nulled: number }>
  totalDeleted: number
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
  const report: PurgeReport = { tables: [], seals: [], totalDeleted: 0 }

  for (const { table, where } of derivedTables(meta)) {
    const filtro = where ? ` AND (${where})` : ""
    const filas = await query(
      `DELETE FROM "${table}" WHERE organization_id = $1::uuid${filtro} RETURNING 1 AS borrada`,
      [organizationId]
    )
    report.tables.push({ table, deleted: filas.length })
    report.totalDeleted += filas.length
  }

  for (const { table, column } of purgableSeals(meta)) {
    try {
      const filas = await query(
        `UPDATE "${table}" SET "${column}" = NULL
          WHERE organization_id = $1::uuid AND "${column}" IS NOT NULL RETURNING 1 AS tocada`,
        [organizationId]
      )
      report.seals.push({ table, column, nulled: filas.length })
    } catch {
      /**
       * Una columna-sello `NOT NULL`, o protegida por un disparador, no se puede
       * vaciar. **Eso no es un fallo del purgado: es la base diciendo que ese
       * sello es parte de la fila y no una caché encima de ella.** Se anota con
       * cero —queda en el informe, no desaparece— y se sigue; lo que decide si
       * el producto está bien es la comparación de las cifras, no si este
       * `UPDATE` pudo correr.
       */
      report.seals.push({ table, column, nulled: 0 })
    }
  }

  return report
}
