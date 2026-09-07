/**
 * E2 · T6 — Registro de auditoría de configuración (§7).
 *
 * `writeAuditLog` RECIBE el `tx` de `tenantTransaction`: nunca abre transacción
 * propia. El log y la mutación viven o mueren juntos — si el log pudiera fallar
 * aparte, habría mutaciones sin rastro, que es exactamente lo que E2 existe para
 * impedir. `audit_logs` es append-only en la barrera 2 (ADR-0008).
 */

import { TenantClient, TenantTransactionClient, tenantTransaction } from "@/lib/db"
import type { AuditLog, Prisma } from "@/prisma/client"

/** Modelos auditables. Cadena porque `AuditLog.entity` es texto, no enum. */
export type AuditEntity =
  | "LedgerAccount"
  | "OrganizationAccountMap"
  | "TaxRate"
  | "Organization"
  | "Membership"
  | "Invitation"
  // E3 · T8 — libro diario (docs/design/E3-libro-diario.md §4.1).
  | "JournalEntry"
  | "FiscalYear"
  | "PeriodLock"
  // E4 · T12 — analítica (docs/design/E4-analitica.md §4).
  | "BusinessLine"
  | "Project"
  | "CostCenter"
  | "MarginLevelConfig"
  | "JournalLine"
  // E6 · T14 — informes financieros (docs/design/E6-informes.md §4).
  | "ReportRun"
  | "ManualReviewFlag"
  // E5 · T10 — liquidación de CECOs (docs/design/E5-liquidacion.md §7).
  | "AllocationRule"
  | "AllocationRun"
  // E8 · T23 — calificación fiscal de la contraparte (ADR-0014 D11).
  | "Counterparty"
  // E8 · T13 — camino documental (§4.3): la evidencia de la extracción, los
  // prompts versionados y las series de facturación.
  | "ExtractionRun"
  | "PromptVersion"
  | "InvoiceSeries"
  /// La operación heredada de TaxHacker: anular-y-rehacer y duplicado forzado
  /// se registran sobre ella, que es lo que el usuario ve en `/transactions`.
  | "Transaction"
  // E7 · T9/T10/T11 — auditoría y conciliación bancaria (§4.3).
  | "BankAccount"
  | "BankStatement"
  | "BankStatementLine"
  | "BankMatchGroup"
  | "InvariantRun"
  | "StoreSweep"
  // E13 — autenticación email + contraseña (docs/design/E13-autenticacion.md §7).
  | "User"

export type AuditAction =
  | "create"
  | "update"
  | "deactivate"
  | "activate"
  | "delete"
  | "seed"
  | "import"
  | "remap"
  | "close"
  // E2 · T11 — cierre de los TODO(E2) de E1 (miembros e invitaciones).
  | "invite"
  | "revoke"
  | "leave"
  // E3 · T8 — posteo, anulación, bloqueo de meses y ciclo del ejercicio.
  | "post"
  | "void"
  | "lock"
  | "unlock"
  | "open"
  // E4 · T12 — archivado de dimensiones y reclasificación analítica (ADR-0010).
  | "archive"
  | "RECLASSIFY_ANALYTICS"
  // E6 · T14 — revisión manual y umbrales (ADR-0012 D3).
  | "FORCE_REVIEW"
  | "CLEAR_REVIEW"
  | "SET_THRESHOLDS"
  // E5 · T10 — política de liquidación y ciclo del run.
  | "supersede"
  | "seal"
  | "reverse"
  // E8 · T23 — la comprobación en VIES se REGISTRA con su fecha: es la
  // precondición (1) del ISP, y una comprobación sin fecha no acredita nada.
  | "vies_check"
  // E8 · T13 — actos del camino documental (§4.3). Todos con `before`/`after`
  // en la MISMA transacción: son las decisiones que un inspector pregunta.
  | "EXTRACT"
  | "CONFIRM_PROPOSAL"
  | "FORCE_FIELD"
  | "FORCE_DUPLICATE"
  | "MARK_SIMPLIFIED_QUALIFIED"
  | "REVOID_AND_REDO"
  | "SET_PROMPT_VERSION"
  | "SET_REGIME"
  | "EMIT_INVOICE"
  // E7 · T9/T10/T11 — actos de la pestaña Auditoría y de la conciliación.
  /** Conciliar un grupo N-a-M: quién, qué ids, qué suma y con qué método. */
  | "MATCH"
  /** Desconciliar el GRUPO, con motivo ≥ 10 caracteres. */
  | "UNMATCH"
  /** `IGNORED` del vocabulario cerrado, con su evidencia. */
  | "IGNORE_LINE"
  /** Tipar —o destipar— una partida en tránsito (O-8, H-5). Lo hace una persona. */
  | "TYPE_PENDING"
  | "RUN_INVARIANTS"
  | "SWEEP_STORE"
  | "cancel"
  /** Prueba de detección: no escribe en el diario, pero deja constancia (§9). */
  | "DETECTION_TEST"
  /** Propuesta de asiento desde un movimiento del extracto (T23). */
  | "PROPOSE_ENTRY_FROM_LINE"
  // E13 — contraseñas: nunca se registra el hash ni la longitud (§7).
  | "password_set"
  | "password_reset_sent"
  | "password_changed"

export type AuditLogInput = {
  entity: AuditEntity
  entityId: string
  action: AuditAction
  before?: unknown
  after?: unknown
  reason?: string | null
  userId?: string | null
}

/** Cliente mínimo que necesita el escritor: el de `tenantTransaction` lo cumple. */
type AuditWriter = Pick<TenantTransactionClient, "auditLog" | "$organizationId">

/**
 * Serializa a JSON almacenable: `Date` → ISO, `BigInt` → **cadena decimal**,
 * `undefined` → ausente. Sin esto, Prisma rechaza un `Date` dentro de un `Json`
 * y el log se pierde por un detalle de tipos.
 *
 * **`BigInt` como cadena y no como `number`** (E7, ADR-0015 D1): desde que el
 * diario y las tablas de conciliación son `bigint`, una fila cruda que va al
 * `before`/`after` trae `BigInt`, y `JSON.stringify` lanza «Do not know how to
 * serialize a BigInt» — es decir, la mutación se abortaba por culpa del log.
 * La cadena conserva el céntimo exacto; el `number` podría no hacerlo, y un
 * registro de auditoría que redondea no vale para auditar.
 */
export function toAuditJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined
  return JSON.parse(
    JSON.stringify(value, (_key, v) =>
      v instanceof Date ? v.toISOString() : typeof v === "bigint" ? v.toString() : v
    )
  ) as Prisma.InputJsonValue
}

export async function writeAuditLog(tx: AuditWriter, input: AuditLogInput): Promise<AuditLog> {
  return await tx.auditLog.create({
    data: {
      // `tenantDb` lo inyectaría igualmente; explícito porque el tipo de Prisma
      // lo exige y porque un valor ajeno haría saltar `TenantError` (barrera 1).
      organizationId: tx.$organizationId,
      entity: input.entity,
      entityId: input.entityId,
      action: input.action,
      before: toAuditJson(input.before),
      after: toAuditJson(input.after),
      reason: input.reason ?? null,
      userId: input.userId ?? null,
    },
  })
}

/** Longitud de `audit_logs.entity_id` (VARCHAR(64) en el esquema). */
export const AUDIT_ENTITY_ID_MAX = 64

/**
 * E4-UI-1.c — Escritura de VARIAS filas de auditoría en un solo `createMany`.
 *
 * Existe porque una mutación masiva (la reclasificación analítica de N líneas)
 * no cabe en una sola fila: `entity_id` es `VARCHAR(64)`, así que concatenar los
 * ids de las líneas revienta con «value too long» a partir de la segunda. El
 * patrón correcto es **una fila por entidad tocada** (más una de resumen), no
 * una fila con una lista dentro.
 */
export async function writeAuditLogs(tx: AuditWriter, inputs: readonly AuditLogInput[]): Promise<number> {
  if (inputs.length === 0) return 0
  for (const input of inputs) {
    if (input.entityId.length > AUDIT_ENTITY_ID_MAX) {
      throw new Error(
        `AuditLog.entityId de ${input.entityId.length} caracteres para ${input.entity}: el máximo es ${AUDIT_ENTITY_ID_MAX}. ` +
          "Escribe una fila por entidad, no una lista concatenada."
      )
    }
  }
  const result = await tx.auditLog.createMany({
    data: inputs.map((input) => ({
      organizationId: tx.$organizationId,
      entity: input.entity,
      entityId: input.entityId,
      action: input.action,
      before: toAuditJson(input.before),
      after: toAuditJson(input.after),
      reason: input.reason ?? null,
      userId: input.userId ?? null,
    })),
  })
  return result.count
}

/**
 * E2 · T11 — Escritura de un asiento de auditoría SUELTO, en su propia
 * transacción de tenant.
 *
 * Existe sólo para cerrar los `TODO(E2): auditLog(...)` que dejó E1 en
 * `settings/members` y `settings/organization`: aquellas mutaciones se
 * escribieron antes de que existiera `AuditLog` y no corren dentro de una
 * `tenantTransaction`, así que no hay `tx` que compartir. Para todo lo demás se
 * usa `writeAuditLog(tx, …)`, que ata el log a la mutación.
 */
export async function recordAuditLog(organizationId: string, input: AuditLogInput): Promise<AuditLog> {
  return await tenantTransaction(organizationId, input.userId ?? undefined, async (tx) => writeAuditLog(tx, input))
}

export type AuditLogFilter = {
  entity?: AuditEntity
  entityId?: string
  action?: AuditAction
  userId?: string
  since?: Date
  until?: Date
  take?: number
}

/** Consulta del registro (la consume la pestaña Auditoría en E7). */
export async function listAuditLog(db: TenantClient, filter: AuditLogFilter = {}): Promise<AuditLog[]> {
  return await db.auditLog.findMany({
    where: {
      ...(filter.entity ? { entity: filter.entity } : {}),
      ...(filter.entityId ? { entityId: filter.entityId } : {}),
      ...(filter.action ? { action: filter.action } : {}),
      ...(filter.userId ? { userId: filter.userId } : {}),
      ...(filter.since || filter.until
        ? { ts: { ...(filter.since ? { gte: filter.since } : {}), ...(filter.until ? { lte: filter.until } : {}) } }
        : {}),
    },
    orderBy: { ts: "desc" },
    take: filter.take ?? 200,
  })
}
