/**
 * E11 · T8 — **el uso, derivado** (docs/design/E11-plataforma-saas.md §3.4,
 * ADR-0019 D1, observaciones **O-5**, **O-6**, **O-12b** y **O-12c**).
 *
 * ## La decisión de fondo
 *
 * **No existe ningún contador que se incremente al escribir.** El uso es una
 * *vista*: seis cifras que salen de agregados SQL sobre las fuentes, con sus
 * exclusiones declaradas. Lo único que se persiste es una caché invalidable por
 * `sourceHash` (`UsageRun`), con el patrón de `ReportRun` (ADR-0012).
 *
 * Por qué `sourceHash` y no `updatedAt`: un `updatedAt` **no detecta un
 * borrado**, y el uso tiene que BAJAR cuando alguien anula. El hash se calcula
 * sobre recuentos y sellos, que sí bajan.
 *
 * ## Las exclusiones, y por qué cada una
 *
 * | Métrica | Qué cuenta |
 * |---|---|
 * | `members` | `Membership` con `acceptedAt IS NOT NULL`. Las invitaciones pendientes no cuentan aquí, pero **sí** al invitar: no se promete una plaza que no existe |
 * | `entries` | `JournalEntry` del mes por `entryDate`, **excluyendo** (O-5) contra-asientos, asientos de sistema (`REGULARIZATION`/`CLOSING`/`OPENING`/`REVERSAL`) y los de una organización `isDemo` (O-6) |
 * | `ocrDocs` | `ExtractionRun` con `parentRunId IS NULL`. Un run de revisión no consume: ya lo pagó el original (ADR-0014 D5) |
 * | `exports` | `ReportRun` con export materializado + `BackupJob` del mes con `trigger = MANUAL`. Un informe visto en pantalla no es una exportación |
 * | `storageBytes` | `Σ StoredObject.sizeBytes` con `kind ∈ {DOCUMENT, PREVIEW}` — **por `kind`, no por prefijo** (O-12c) |
 * | `backups` | `BackupJob` del mes en `DONE`/`RUNNING` con `trigger = MANUAL`. **`EXIT` nunca cuenta** (O-4), ni `SCHEDULED` |
 *
 * **O-5 en una línea:** corregir un error no puede costar el doble que dejarlo,
 * cuando el contra-asiento es el **único** camino admitido (ADR-0003).
 *
 * Módulo **PURO**: sin IO, sin `prisma`, sin LLM, sin `Date.now()`. La fecha de
 * referencia y todas las fuentes entran por parámetro. Quien las lee de la base
 * es `models/usage.ts`.
 */

import { createHash } from "node:crypto"

const NULL_TOKEN = "∅"
const sha256 = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex")

/** Las seis cifras. Nada más, y nada menos: §3.4 las enumera cerradas. */
export type UsageFigures = {
  members: number
  entries: number
  ocrDocs: number
  exports: number
  backups: number
  storageBytes: bigint
}

/**
 * Recuento por tabla que entra en `usageSourceHash`. `maxUpdatedAt` es un ISO
 * o `null`; **el recuento por sí solo no basta** (borrar una fila y crear otra
 * deja el mismo número) y `maxUpdatedAt` por sí solo tampoco (no detecta el
 * borrado): hacen falta los dos, y por eso van juntos.
 */
export type SourceCount = { table: string; rows: number; maxUpdatedAt: string | null }

export type UsageInput = {
  organizationId: string
  /** Mes natural, primer día, en la zona de la organización. `AAAA-MM-01`. */
  periodMonth: string
  /** `true` ⇒ el uso de esta organización es cero: la demo no se factura (O-6). */
  isDemo: boolean
  /** Las seis cifras ya agregadas por SQL con sus exclusiones. */
  figures: UsageFigures
  /** Recuentos y marcas de las tablas fuente (sin cifras derivadas). */
  sources: readonly SourceCount[]
  /**
   * **O-12b**: el `ledgerHash` **del periodo `periodMonth`**, no el del
   * ejercicio ni el «vigente». Declararlo evita que dos meses colisionen.
   */
  ledgerHashOfMonth: string | null
  /** Σ por `kind` de `stored_objects.size_bytes` (O-12c), en orden de `kind`. */
  storageByKind: readonly { kind: string; bytes: bigint }[]
  /** `Membership` aceptadas. Se declara aparte porque no tiene `updatedAt` útil. */
  acceptedMembers: number
}

/** `AAAA-MM-01` o nada. Un mes mal formado envenena la clave de caché. */
const MONTH_RE = /^\d{4}-\d{2}-01$/

export class UsageInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageInputError"
  }
}

/**
 * Forma canónica de las **FUENTES** → sha256.
 *
 * Entran: recuentos y `max(updated_at)` por tabla, el `ledgerHash` del periodo
 * (O-12b), `Σ stored_objects.size_bytes` **por kind** (O-12c) y los miembros
 * aceptados. **NO entra ninguna cifra derivada**: se validaría a sí misma, y una
 * caché que se autovalida es peor que no tener caché.
 */
export function usageSourceHash(input: UsageInput): string {
  if (!MONTH_RE.test(input.periodMonth)) {
    throw new UsageInputError(`periodMonth debe ser AAAA-MM-01 y es ${input.periodMonth}`)
  }
  const lines: string[] = [
    `org\t${input.organizationId}`,
    `month\t${input.periodMonth}`,
    `demo\t${input.isDemo ? "1" : "0"}`,
    `ledgerHash\t${input.ledgerHashOfMonth ?? NULL_TOKEN}`,
    `members\t${input.acceptedMembers}`,
  ]
  for (const source of [...input.sources].sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0))) {
    lines.push(`table\t${source.table}\t${source.rows}\t${source.maxUpdatedAt ?? NULL_TOKEN}`)
  }
  for (const bucket of [...input.storageByKind].sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))) {
    lines.push(`storage\t${bucket.kind}\t${bucket.bytes.toString()}`)
  }
  return sha256(lines.join("\n"))
}

/**
 * Las seis cifras a devolver. Es deliberadamente delgada: **el trabajo lo hace
 * el SQL** (`models/usage.ts`), porque materializar 50 000 asientos en memoria
 * para contarlos es exactamente lo que el estándar de calidad prohíbe. Aquí se
 * aplica lo que NO puede hacer una consulta: la regla de la demo (O-6), que
 * anula las seis de golpe, y la validación de la forma.
 *
 * `refDate` entra por parámetro y se usa para rechazar un periodo futuro: un
 * uso de un mes que aún no ha ocurrido no es cero, es un error de llamada.
 */
export function computeUsage(input: UsageInput, refDate: Date): UsageFigures {
  if (!MONTH_RE.test(input.periodMonth)) {
    throw new UsageInputError(`periodMonth debe ser AAAA-MM-01 y es ${input.periodMonth}`)
  }
  const refMonth = `${refDate.toISOString().slice(0, 7)}-01`
  if (input.periodMonth > refMonth) {
    throw new UsageInputError(`periodMonth ${input.periodMonth} es posterior a la fecha de referencia ${refMonth}`)
  }
  if (input.isDemo) {
    // O-6: la demo vive en su propia organización, no cuenta contra
    // `maxOrganizations` y **no entra en el uso**. Si no se excluyera aquí Y en
    // `usageSourceHash`, I-E11-1 fallaría en toda organización con demo, que es
    // el caso por defecto del alta.
    return { members: 0, entries: 0, ocrDocs: 0, exports: 0, backups: 0, storageBytes: BigInt(0) }
  }
  const f = input.figures
  for (const [name, value] of Object.entries({
    members: f.members,
    entries: f.entries,
    ocrDocs: f.ocrDocs,
    exports: f.exports,
    backups: f.backups,
  })) {
    if (!Number.isInteger(value) || value < 0) {
      throw new UsageInputError(`la métrica ${name} no es un entero no negativo: ${value}`)
    }
  }
  if (f.storageBytes < BigInt(0)) throw new UsageInputError(`storageBytes no puede ser negativo: ${f.storageBytes}`)
  return { ...f }
}

/** Primer día del mes natural de `date`, en UTC, como `AAAA-MM-01`. */
export function periodMonthOf(date: Date): string {
  return `${date.toISOString().slice(0, 7)}-01`
}

/** Límites `[inicio, finExclusivo)` del mes, para el `WHERE` de los agregados. */
export function monthBounds(periodMonth: string): { start: Date; endExclusive: Date } {
  if (!MONTH_RE.test(periodMonth)) {
    throw new UsageInputError(`periodMonth debe ser AAAA-MM-01 y es ${periodMonth}`)
  }
  const start = new Date(`${periodMonth}T00:00:00.000Z`)
  const endExclusive = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))
  return { start, endExclusive }
}

/**
 * **Los tipos de asiento que NO cuentan** (O-5). Se declara aquí, una sola vez,
 * y `models/usage.ts` la traduce a SQL: si mañana nace un `kind` de sistema, se
 * añade en un sitio y no en cinco.
 */
export const SYSTEM_ENTRY_KINDS: readonly string[] = ["REGULARIZATION", "CLOSING", "OPENING", "REVERSAL"]

/** Familias de `StoredObject` que consumen cuota del cliente (O-12c). */
/** **E12 · T15**: las imágenes de marca (`BRANDING`) NO son cuota del cliente. */
export const BILLABLE_STORAGE_KINDS: readonly string[] = ["DOCUMENT", "PREVIEW"]

/** Disparadores de backup que consumen `maxBackupsMonth`. Sólo uno (O-4). */
export const BILLABLE_BACKUP_TRIGGERS: readonly string[] = ["MANUAL"]

/**
 * Texto de la exclusión, para enseñarlo junto a `computedAt` y `gitSha`. P6
 * obliga: una cifra derivada se muestra con lo que la produjo.
 */
export const USAGE_EXCLUSIONS_ES: Readonly<Record<keyof UsageFigures, string>> = {
  members: "Miembros con invitación aceptada. Las pendientes no cuentan aquí, pero sí al invitar.",
  entries:
    "Asientos del mes por fecha contable, excluidos los contra-asientos de anulación, los asientos de sistema " +
    "(regularización, cierre y apertura) y los de la organización de demo.",
  ocrDocs: "Extracciones raíz del mes. Una revisión no consume: ya la pagó el original.",
  exports: "Informes exportados a fichero y backups manuales del mes. Un informe visto en pantalla no cuenta.",
  backups: "Backups manuales del mes. Los de portabilidad y los programados nunca consumen cuota.",
  storageBytes:
    "Documentos y vistas previas. Ni el logotipo y los avatares (BRANDING), ni los ZIP de copia, ni nuestras facturas cuentan.",
}
