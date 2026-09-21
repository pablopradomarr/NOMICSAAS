import "server-only"

/**
 * E12 · T13 — **las cuatro escrituras de operador** (ADR-0020 D1–D6).
 *
 * `docs/design/E12-fiabilidad-dod.md` §5 ·
 * `docs/adr/0020-escrituras-de-operador-y-excepciones-auditadas.md`.
 *
 * Cada operación tiene **dos mitades** y las dos viven aquí:
 *
 *  · **`planX()`** — *enumera* lo que va a pasar: recuentos por tabla, plan de
 *    antes y de después, objetos a purgar, y el **motivo por el que no se puede
 *    hacer** si no se puede. No escribe nada. Es lo que el diálogo enseña antes
 *    de que nadie pulse (§5.5), y lo que el token de confirmación sella.
 *  · **`runX()`** — ejecuta, dentro de UNA transacción, bajo el rol
 *    `app_operator`, y **vuelve a comprobar el plan**. Si el mundo cambió entre
 *    los dos pasos, se niega.
 *
 * ## Lo que este fichero no puede hacer, por tres vías
 *
 * Ninguna escritura de aquí alcanza `journal_entries`, `journal_lines`,
 * `audit_logs`, `extraction_runs`, `invariant_runs` ni `closing_runs` (D2). Lo
 * garantizan, por separado: los **privilegios** de `app_operator`
 * (`20261001100000_e12_rol_de_operador`), el **test estático sobre el AST** de
 * `app/(app)/admin/**` (`tests/integration/e12-admin-ast.test.ts`) y el
 * invariante **`I-E12-5`** en el barrido. Una sola vía es una promesa; tres son
 * un control.
 *
 * La única escritura de este fichero sobre una de las seis es el **`INSERT` en
 * `audit_logs`** que D3 obliga a dejar —el cliente tiene derecho a ver que
 * alguien de la plataforma tocó algo suyo—, y pasa por `writeAuditLog`, el
 * mismo camino append-only que usa el resto del producto.
 *
 * ## La lista de tablas se DERIVA
 *
 * `reset-org` no mantiene una lista a mano: sale de `TENANT_MODELS` menos las
 * **exclusiones declaradas con motivo** de `RESET_PRESERVED`. Es la regla E-4 de
 * la v1.1 propuesta, y la lección de BUG-E7-1, BUG-E9-5, BUG-E10-1 y BUG-E11-2
 * —el mismo error cuatro veces—. Un test enfrenta las dos listas al esquema y
 * falla si sobra o falta una tabla.
 */

import { TENANT_MODELS, prismaSchemaMeta, tenantTransaction, type TenantTransactionClient } from "@/lib/db"
import { writeAuditLog } from "@/models/audit-log"
import { PLATFORM_ACTIONS, recordPlatformAuditTx } from "@/models/platform"
import { createOperatorException, listLiveOperatorExceptions } from "@/models/operator-exceptions"
import {
  MAX_EXCEPTION_HOURS,
  confirmsName,
  validateReason,
  type OperatorAction,
} from "@/lib/ledger/invariants-e12"
import { Prisma, type OperatorExceptionKind, type OperatorTargetKind } from "@/prisma/client"

// ─────────────────────────────────────────────────────────────────────────────
// El contrato común: enumerar, después hacer
// ─────────────────────────────────────────────────────────────────────────────

export type PlanStep = {
  /** Qué se va a hacer, en una línea de español. */
  label: string
  /** Filas afectadas, cuando la operación las cuenta. */
  rows?: number
  /** Matiz que el operador tiene que leer antes de pulsar. */
  note?: string
}

export type OperationPlan = {
  action: OperatorAction
  organizationId: string
  organizationName: string
  steps: readonly PlanStep[]
  /** Recuentos por tabla / por clave. Va tal cual al `detail` de los registros. */
  affectedCounts: Readonly<Record<string, number>>
  before: Readonly<Record<string, string | number | null>>
  after: Readonly<Record<string, string | number | null>>
  /**
   * Motivo por el que la operación **no se puede hacer**. Con esto puesto, la
   * segunda mitad ni se ofrece: el diálogo enseña la negativa y su porqué.
   */
  blocked: string | null
}

export class OperatorDenied extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OperatorDenied"
  }
}

export type OperatorContext = {
  actor: string
  userId: string
  reason: string
  confirmedName: string
  /** Fecha de referencia. Nunca se lee el reloj dentro de la lógica. */
  now: Date
}

/**
 * Validaciones de D3 y D4, **en el servidor** y en un solo sitio.
 * Criterio 41: sin motivo, con motivo genérico o sin el nombre exacto ⇒ negada.
 */
export function assertReasonAndName(ctx: OperatorContext, organizationName: string): void {
  const verdict = validateReason(ctx.reason)
  if (!verdict.ok) throw new OperatorDenied(verdict.error)
  if (!confirmsName(ctx.confirmedName, organizationName)) {
    throw new OperatorDenied(
      `Para confirmar hay que teclear el nombre exacto de la organización («${organizationName}»). ` +
        "La comparación se hace en el servidor: una confirmación que sólo vive en el diálogo no es una confirmación."
    )
  }
}

/**
 * Abre la transacción del operador: tenant + `SET LOCAL ROLE app_operator`.
 *
 * El `SET LOCAL` dura hasta el `COMMIT`, así que **fuera de esta función el
 * proceso vuelve a ser `app_runtime`**. Es la propiedad que hace que el rol de
 * operador no se filtre a una petición cualquiera.
 */
async function operatorTransaction<T>(
  organizationId: string,
  userId: string,
  fn: (tx: TenantTransactionClient) => Promise<T>
): Promise<T> {
  return await tenantTransaction(organizationId, userId, async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_operator`
    return await fn(tx)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Inventario derivado para `reset-org`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lo que `reset-org` **conserva a propósito**, con su motivo. Es lo único que se
 * escribe a mano, y por eso lleva la razón al lado: un test enfrenta
 * `TENANT_MODELS` con esta lista y con la de vaciado, y falla si sobra o falta.
 */
export const RESET_PRESERVED: readonly { model: string; reason: string }[] = [
  // Las seis de ADR-0020 D2. No es que se conserven: es que el operador no las
  // puede tocar por privilegios, y una lista que fingiera lo contrario mentiría.
  { model: "JournalEntry", reason: "ADR-0020 D2 · el diario no se toca; y con un asiento la operación ni existe" },
  { model: "JournalLine", reason: "ADR-0020 D2 · el diario no se toca" },
  { model: "AuditLog", reason: "ADR-0020 D2 y ADR-0008 · append-only: la traza de lo que se hizo no se borra" },
  { model: "ExtractionRun", reason: "ADR-0020 D2 · evidencia de la extracción, append-only" },
  { model: "InvariantRun", reason: "ADR-0020 D2 · barridos sellados, append-only" },
  { model: "ClosingRun", reason: "ADR-0020 D2 · el acto de cerrar, append-only" },
  // Lo que dejaría la organización rota o falsificaría nuestra contabilidad.
  { model: "Membership", reason: "quién pertenece a la organización: vaciarlo la dejaría sin dueño" },
  { model: "Subscription", reason: "toda organización tiene que conservar la suya (I-E11-5)" },
  { model: "SubscriptionEvent", reason: "append-only: es la historia de la suscripción (I-E11-9)" },
  {
    model: "PlatformInvoice",
    reason: "son NUESTRAS facturas emitidas, sujetas a conservación (O-11, art. 165.Uno LIVA)",
  },
  {
    model: "OperatorException",
    reason: "ADR-0020 · append-only: es el registro de lo que el propio operador hizo, y no se autoborra",
  },
]

const PRESERVED_MODELS: ReadonlySet<string> = new Set(RESET_PRESERVED.map((p) => p.model))

/** Modelos que `reset-org` vacía: `TENANT_MODELS` menos lo declarado. DERIVADO. */
export function resetModels(): readonly string[] {
  return [...TENANT_MODELS].filter((m) => !PRESERVED_MODELS.has(m)).sort()
}

/** Nombre de tabla de cada modelo, leído del cliente Prisma generado. */
export function tableOf(model: string): string {
  const meta = prismaSchemaMeta().find((m) => m.model === model)
  if (!meta) throw new OperatorDenied(`el modelo ${model} no existe en el esquema`)
  return meta.table
}

/**
 * Orden de borrado: **topológico sobre las claves ajenas reales**, leído de
 * `pg_constraint`. No es una lista de tablas «en orden de FK» escrita a mano —
 * ésa es exactamente la que ha fallado cuatro veces—. Una tabla nueva entra en
 * el sitio correcto sin que nadie lo piense.
 *
 * Las autorreferencias se ignoran (un `DELETE FROM t WHERE …` borra todas sus
 * filas en una sentencia y la FK se comprueba al final). Un ciclo entre tablas
 * distintas se **declara** en el plan en vez de fallar en silencio.
 */
export async function deletionOrder(
  tx: Pick<TenantTransactionClient, "$queryRaw">,
  tables: readonly string[]
): Promise<{ order: readonly string[]; cycles: readonly string[] }> {
  const set = new Set(tables)
  const edges = await tx.$queryRaw<{ child: string; parent: string }[]>`
    SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
      FROM pg_constraint c
     WHERE c.contype = 'f'
       AND c.conrelid <> c.confrelid
  `
  // hijos de cada padre, restringido a nuestro conjunto
  const dependents = new Map<string, Set<string>>()
  const pending = new Map<string, number>()
  for (const t of set) {
    dependents.set(t, new Set())
    pending.set(t, 0)
  }
  for (const { child, parent } of edges) {
    if (!set.has(child) || !set.has(parent) || child === parent) continue
    if (dependents.get(parent)!.has(child)) continue
    dependents.get(parent)!.add(child)
    pending.set(parent, (pending.get(parent) ?? 0) + 1)
  }

  // Se borra primero lo que NO tiene hijos pendientes (las hojas del grafo).
  const order: string[] = []
  const ready = [...set].filter((t) => (pending.get(t) ?? 0) === 0).sort()
  const childrenOf = new Map<string, string[]>()
  for (const [parent, hijos] of dependents) for (const h of hijos) {
    childrenOf.set(h, [...(childrenOf.get(h) ?? []), parent])
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
  return { order, cycles }
}

async function countRows(
  tx: Pick<TenantTransactionClient, "$queryRaw">,
  table: string,
  organizationId: string
): Promise<number> {
  const rows = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM ${Prisma.raw(`"${table}"`)} WHERE "organization_id" = ${organizationId}::uuid
  `
  return Number(rows[0]?.n ?? 0)
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 · reset-org (D1: se niega con un solo asiento, y no hay --force)
// ─────────────────────────────────────────────────────────────────────────────

export async function planResetOrg(organizationId: string): Promise<OperationPlan> {
  return await tenantTransaction(organizationId, async (tx) => {
    const org = await tx.organization.findFirstOrThrow({ select: { name: true, isPersonal: true } })
    const entries = await tx.journalEntry.count()

    const tables = resetModels().map(tableOf)
    const { order, cycles } = await deletionOrder(tx, tables)
    const affectedCounts: Record<string, number> = {}
    for (const table of [...tables].sort()) {
      const n = await countRows(tx, table, organizationId)
      if (n > 0) affectedCounts[table] = n
    }

    const total = Object.values(affectedCounts).reduce((a, b) => a + b, 0)
    const steps: PlanStep[] = [
      {
        label: `Vaciar ${Object.keys(affectedCounts).length} tabla(s) con filas, ${total} fila(s) en total`,
        rows: total,
        note: "La lista se deriva de TENANT_MODELS; una tabla nueva entra sola (regla E-4).",
      },
      ...Object.entries(affectedCounts)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([table, rows]) => ({ label: table, rows })),
      {
        label: `Se CONSERVAN ${RESET_PRESERVED.length} tablas declaradas`,
        note: RESET_PRESERVED.map((p) => `${tableOf(p.model)}: ${p.reason}`).join(" · "),
      },
    ]
    if (cycles.length > 0) {
      steps.push({ label: "Ciclo de claves ajenas detectado", note: cycles.join(", ") })
    }

    // **El límite que no se negocia** (D1). Aquí sólo se *anuncia*: quien de
    // verdad se niega es Postgres, en `app.operator_reset_allowed()`.
    const blocked =
      entries > 0
        ? `Esta organización tiene ${entries} asiento(s) contabilizado(s). Vaciarla no es una operación de ` +
          "operador: es una decisión contable, y la respuesta es que no se hace. Un asiento se anula con " +
          "contra-asiento (ADR-0003). No hay «--force»: la propia base de datos lo impide."
        : cycles.length > 0
          ? `Hay un ciclo de claves ajenas entre ${cycles.join(", ")}: el borrado no tiene orden seguro y se detiene.`
          : null

    return {
      action: "admin.reset_org" as const,
      organizationId,
      organizationName: org.name,
      steps,
      affectedCounts,
      before: { journalEntries: entries, tablasConFilas: Object.keys(affectedCounts).length, filas: total },
      after: { journalEntries: entries, tablasConFilas: 0, filas: 0 },
      blocked,
      // El orden no viaja al token: es un detalle de ejecución, no algo que el
      // operador decida. (Se recalcula dentro de la transacción de escritura.)
      _order: order,
    } as OperationPlan & { _order: readonly string[] }
  })
}

export async function runResetOrg(organizationId: string, ctx: OperatorContext): Promise<OperationPlan> {
  const plan = await planResetOrg(organizationId)
  assertReasonAndName(ctx, plan.organizationName)
  if (plan.blocked) throw new OperatorDenied(plan.blocked)

  const borradas: Record<string, number> = {}
  await operatorTransaction(organizationId, ctx.userId, async (tx) => {
    const tables = resetModels().map(tableOf)
    const { order } = await deletionOrder(tx, tables)
    for (const table of order) {
      const n = await tx.$executeRaw(
        Prisma.sql`DELETE FROM ${Prisma.raw(`"${table}"`)} WHERE "organization_id" = ${organizationId}::uuid`
      )
      if (n > 0) borradas[table] = n
    }
    // D3 · la línea en el registro DEL CLIENTE. Es el único `INSERT` que este
    // fichero hace sobre una de las seis tablas de D2, y es el que D3 exige.
    await writeAuditLog(tx, {
      entity: "Organization",
      entityId: organizationId,
      action: "OPERATOR_RESET_ORG",
      before: plan.before as Record<string, unknown>,
      after: { ...plan.after, tablasVaciadas: Object.keys(borradas).length },
      reason: `[operador ${ctx.actor}] ${ctx.reason}`,
      userId: ctx.userId,
    })
    await recordPlatformAuditTx(tx, {
      actor: ctx.actor,
      action: PLATFORM_ACTIONS.ADMIN_RESET_ORG,
      detail: {
        reason: ctx.reason,
        confirmedName: ctx.confirmedName,
        before: plan.before,
        after: plan.after,
        affectedCounts: borradas,
      },
    })
  })

  return { ...plan, affectedCounts: borradas, blocked: null }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2 · unblock (D5: crea una excepción caduca; NO levanta el invariante)
// ─────────────────────────────────────────────────────────────────────────────

export type UnblockTarget = {
  kind: OperatorExceptionKind
  targetKind: OperatorTargetKind
  targetId?: string | null
  /** Para el cron, que se nombra por `job:periodKey` y no por uuid. */
  targetRef?: string | null
}

/** Las guardias que hoy se pueden levantar, y nada más (D1). */
export const UNBLOCK_KINDS: Readonly<Record<OperatorExceptionKind, { label: string; target: OperatorTargetKind }>> = {
  UNBLOCK_PERIOD_LOCK: { label: "Un bloqueo de periodo puesto por error", target: "PERIOD_LOCK" },
  UNBLOCK_CLOSING_GUARD: { label: "Una guardia de cierre de ejercicio", target: "FISCAL_YEAR" },
  UNSTICK_RESTORE_JOB: { label: "Una restauración colgada", target: "RESTORE_JOB" },
  UNSTICK_CRON_JOB: { label: "Un job de cron atascado en PARTIAL", target: "CRON_JOB" },
}

export async function planUnblock(organizationId: string, target: UnblockTarget, now: Date): Promise<OperationPlan> {
  return await tenantTransaction(organizationId, async (tx) => {
    const org = await tx.organization.findFirstOrThrow({ select: { name: true } })
    const vivas = await listLiveOperatorExceptions(tx, now)
    const expiresAt = new Date(now.getTime() + MAX_EXCEPTION_HOURS * 3_600_000)

    const yaViva = vivas.some(
      (e) => e.kind === target.kind && e.targetId === (target.targetId ?? null) && e.targetRef === (target.targetRef ?? null)
    )

    const steps: PlanStep[] = [
      { label: `Levantar la puerta: ${UNBLOCK_KINDS[target.kind].label}` },
      {
        label: `Caduca sola el ${expiresAt.toISOString()}`,
        note: `${MAX_EXCEPTION_HOURS} h exactas. No hay renovación: vencida, hay que crear otra excepción, con su motivo y su registro.`,
      },
      {
        label: "El invariante que cerró la puerta NO se levanta",
        note: "Sigue en FAIL y sigue moviendo el sello. Lo que caduca es la puerta, no la comprobación.",
      },
      {
        label: "El sello del periodo pasa a REQUIERE REVISIÓN",
        note: "Motivo EXCEPCION_DE_OPERADOR_VIGENTE mientras la excepción esté viva (ADR-0020 D6).",
      },
    ]

    return {
      action: "admin.unblock" as const,
      organizationId,
      organizationName: org.name,
      steps,
      affectedCounts: { excepcionesVivasAntes: vivas.length, excepcionesVivasDespues: vivas.length + (yaViva ? 0 : 1) },
      before: { excepcionesVivas: vivas.length, sello: vivas.length > 0 ? "REQUIERE REVISIÓN" : "—" },
      // `expiresAt` va en los PASOS, no en `after`: es una fecha derivada del
      // instante de la enumeración y cambiaría entre el primer paso y el
      // segundo, invalidando el token de confirmación en cada intento. Lo que
      // el token tiene que sellar es lo que va a CAMBIAR, no cuándo se miró.
      after: { excepcionesVivas: vivas.length + (yaViva ? 0 : 1), sello: "REQUIERE REVISIÓN" },
      blocked: yaViva ? "Ya hay una excepción viva sobre esa misma guardia. Espera a que caduque o revócala." : null,
    }
  })
}

export async function runUnblock(
  organizationId: string,
  target: UnblockTarget,
  ctx: OperatorContext
): Promise<OperationPlan> {
  const plan = await planUnblock(organizationId, target, ctx.now)
  assertReasonAndName(ctx, plan.organizationName)
  if (plan.blocked) throw new OperatorDenied(plan.blocked)

  await operatorTransaction(organizationId, ctx.userId, async (tx) => {
    const exception = await createOperatorException(tx, {
      kind: target.kind,
      targetKind: target.targetKind,
      targetId: target.targetId ?? null,
      targetRef: target.targetRef ?? null,
      reason: ctx.reason,
      requestedBy: ctx.actor,
      now: ctx.now,
    })
    await writeAuditLog(tx, {
      entity: "OperatorException",
      entityId: exception.id,
      action: "OPERATOR_UNBLOCK",
      before: plan.before as Record<string, unknown>,
      after: { kind: exception.kind, targetKind: exception.targetKind, expiresAt: exception.expiresAt },
      reason: `[operador ${ctx.actor}] ${ctx.reason}`,
      userId: ctx.userId,
    })
    await recordPlatformAuditTx(tx, {
      actor: ctx.actor,
      action: PLATFORM_ACTIONS.ADMIN_UNBLOCK,
      detail: {
        reason: ctx.reason,
        confirmedName: ctx.confirmedName,
        before: plan.before,
        after: plan.after,
        affectedCounts: plan.affectedCounts,
        // `exceptionId` ata la excepción con su línea **por identidad**:
        // I-E12-5 no compara relojes, compara identificadores.
        exceptionId: exception.id,
        kind: exception.kind,
        targetKind: exception.targetKind,
        targetId: exception.targetId,
        targetRef: exception.targetRef,
        expiresAt: exception.expiresAt,
      },
    })
    return exception
  })

  return plan
}

// ─────────────────────────────────────────────────────────────────────────────
// 3 · reassign-plan (D1: ya existía en E11 D9; gana motivo y doble confirmación)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `_now` no se usa hoy —`listPlans` resuelve la vigencia con el `tx`— pero entra
 * en la firma como en las otras tres: la fecha de referencia es parte del
 * contrato de toda operación de operador, y quitarla de una sola invitaría a
 * que mañana esa función leyera el reloj por su cuenta.
 */
export async function planReassignPlan(
  organizationId: string,
  planCode: string,
  _now: Date
): Promise<OperationPlan> {
  const { listPlans } = await import("@/models/plans")
  const { getSubscription } = await import("@/models/subscriptions")
  return await tenantTransaction(organizationId, async (tx) => {
    const org = await tx.organization.findFirstOrThrow({ select: { name: true } })
    const antes = await getSubscription(tx)
    const disponibles = await listPlans(tx)
    const destino = disponibles.find((p) => p.code === planCode.trim().toUpperCase())

    const steps: PlanStep[] = destino
      ? [
          { label: `Plan: ${antes?.planCode ?? "sin suscripción"} → ${destino.code}` },
          {
            label: "Cambian los límites de la organización ahora mismo",
            note: "La cuota blanda de asientos nunca rechaza un asiento (ADR-0019 D7): avisa y sella el periodo.",
          },
          { label: "Se registra en PlatformAuditLog y en el AuditLog del cliente" },
        ]
      : []

    return {
      action: "admin.plan_changed" as const,
      organizationId,
      organizationName: org.name,
      steps,
      affectedCounts: { suscripciones: 1 },
      before: { planCode: antes?.planCode ?? null, status: antes?.status ?? null },
      after: { planCode: destino?.code ?? null, status: antes?.status ?? "ACTIVE" },
      blocked: destino
        ? antes?.planCode === destino.code
          ? `La organización ya está en el plan ${destino.code}.`
          : null
        : `No existe hoy un plan con código «${planCode}». Planes vigentes: ${disponibles.map((p) => p.code).join(", ")}.`,
    }
  })
}

export async function runReassignPlan(
  organizationId: string,
  planCode: string,
  ctx: OperatorContext
): Promise<OperationPlan> {
  const plan = await planReassignPlan(organizationId, planCode, ctx.now)
  assertReasonAndName(ctx, plan.organizationName)
  if (plan.blocked) throw new OperatorDenied(plan.blocked)

  // El cambio en sí lo hace el camino de E11 (D9), que ya es correcto y ya
  // escribe su `AuditLog`: aquí no se reimplementa, se **envuelve** con lo que
  // ADR-0020 añade — motivo obligatorio, confirmación por nombre y la línea
  // `admin.plan_changed` con `before`/`after`.
  const { changeOrganizationPlan } = await import("@/models/subscriptions")
  const resultado = await changeOrganizationPlan(organizationId, planCode.trim().toUpperCase(), ctx.now, ctx.actor)

  await tenantTransaction(organizationId, ctx.userId, async (tx) => {
    await writeAuditLog(tx, {
      entity: "Organization",
      entityId: organizationId,
      action: "OPERATOR_PLAN_CHANGED",
      before: plan.before as Record<string, unknown>,
      after: { planCode: resultado.planCode },
      reason: `[operador ${ctx.actor}] ${ctx.reason}`,
      userId: ctx.userId,
    })
    await recordPlatformAuditTx(tx, {
      actor: ctx.actor,
      action: PLATFORM_ACTIONS.ADMIN_PLAN_CHANGED,
      detail: {
        reason: ctx.reason,
        confirmedName: ctx.confirmedName,
        before: plan.before,
        after: { planCode: resultado.planCode },
        affectedCounts: plan.affectedCounts,
        planCode: resultado.planCode,
      },
    })
  })

  return { ...plan, after: { planCode: resultado.planCode } }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4 · purge-retention (D1: sólo lo vencido; enumera antes de borrar)
// ─────────────────────────────────────────────────────────────────────────────

export async function planPurgeRetention(organizationId: string, now: Date): Promise<OperationPlan> {
  return await tenantTransaction(organizationId, async (tx) => {
    const org = await tx.organization.findFirstOrThrow({ select: { name: true, backupRetentionDays: true } })

    const candidatos = await tx.backupJob.findMany({
      where: { status: "DONE", expiresAt: { lt: now }, objectKey: { not: null } },
      select: { id: true, expiresAt: true, objectKey: true, sizeBytes: true },
      orderBy: { expiresAt: "asc" },
    })
    const conRestauracionViva = await tx.restoreJob.findMany({
      where: { status: { in: ["QUEUED", "RUNNING", "VERIFYING"] }, backupJobId: { in: candidatos.map((c) => c.id) } },
      select: { backupJobId: true },
    })
    const bloqueados = new Set(conRestauracionViva.map((r) => r.backupJobId))
    const purgables = candidatos.filter((c) => !bloqueados.has(c.id))

    const steps: PlanStep[] = [
      {
        label: `Caducar ${purgables.length} copia(s) de seguridad vencida(s)`,
        rows: purgables.length,
        note: `Retención declarada: ${org.backupRetentionDays} días. Sólo se purga lo que «expiresAt» ya declara vencido.`,
      },
      ...purgables.map((c) => ({
        label: `${c.objectKey ?? c.id} · vencida el ${c.expiresAt?.toISOString() ?? "—"}`,
      })),
      {
        label: "La fila del BackupJob NO se borra: pasa a EXPIRED",
        note: "Lo que se retira es el objeto del almacén. La historia de las copias no se pierde.",
      },
    ]
    if (bloqueados.size > 0) {
      steps.push({
        label: `${bloqueados.size} copia(s) vencida(s) NO se purgan: tienen una restauración viva`,
        note: "I-E11-11: nunca se retira el origen de una restauración en curso.",
      })
    }

    return {
      action: "admin.purge_retention" as const,
      organizationId,
      organizationName: org.name,
      steps,
      affectedCounts: { copiasVencidas: candidatos.length, purgables: purgables.length, bloqueadas: bloqueados.size },
      before: { copiasVivas: candidatos.length },
      after: { copiasVivas: candidatos.length - purgables.length },
      blocked:
        purgables.length === 0
          ? "No hay nada vencido que purgar. La retención no ordena borrar ninguna copia hoy."
          : null,
    }
  })
}

export async function runPurgeRetention(organizationId: string, ctx: OperatorContext): Promise<OperationPlan> {
  const plan = await planPurgeRetention(organizationId, ctx.now)
  assertReasonAndName(ctx, plan.organizationName)
  if (plan.blocked) throw new OperatorDenied(plan.blocked)

  // La purga la ejecuta el camino de E11 (`expireBackups`), que ya respeta las
  // dos prohibiciones de I-E11-11 —restauración viva y factura de plataforma—.
  // Envolverlo es mejor que duplicarlo: dos purgas con reglas distintas es el
  // principio de que una de las dos se quede atrás.
  const { expireBackups } = await import("@/models/backups")
  const purgadas = await expireBackups(organizationId, ctx.now)

  await tenantTransaction(organizationId, ctx.userId, async (tx) => {
    await writeAuditLog(tx, {
      entity: "BackupJob",
      entityId: organizationId,
      action: "OPERATOR_PURGE_RETENTION",
      before: plan.before as Record<string, unknown>,
      after: { purgadas },
      reason: `[operador ${ctx.actor}] ${ctx.reason}`,
      userId: ctx.userId,
    })
    await recordPlatformAuditTx(tx, {
      actor: ctx.actor,
      action: PLATFORM_ACTIONS.ADMIN_PURGE_RETENTION,
      detail: {
        reason: ctx.reason,
        confirmedName: ctx.confirmedName,
        before: plan.before,
        after: { copiasVivas: Number(plan.before.copiasVivas ?? 0) - purgadas },
        affectedCounts: { ...plan.affectedCounts, purgadas },
      },
    })
  })

  return { ...plan, affectedCounts: { ...plan.affectedCounts, purgadas } }
}
