/**
 * E9 · T12 — Inmovilizado: activos, revisiones y **atribución por activo**
 * (`docs/design/E9-cierre-recurrentes.md` §5.1 y **O-19**).
 *
 * El cuadro de amortización **no se almacena** (§3.6): es una función pura de
 * `(FixedAsset, AssetRevision[])`. Lo que sí se sella es `scheduleHash`, y por
 * eso este módulo lo recalcula en **toda** escritura que pueda cambiar el
 * cuadro: alta, revisión y baja. Un `scheduleHash` que no explica los asientos
 * de ayer es I-E9-3 en FAIL, y ése es el punto.
 *
 * ## O-19 · por qué `readAssetsWithRevisions` lee también las líneas
 *
 * `2811` es una cuenta **compartida**. Sin `journal_lines.fixed_asset_id`,
 * I-E9-5 se evalúa por agregado y deja pasar justo lo que busca: un activo
 * sobreamortizado compensado por otro infraamortizado. Aquí las Σ de `68x` y
 * `28x` se traen **por activo**, agregadas en SQL y en **una** consulta para
 * todos —el techo de `/settings/assets` con 300 activos es de 700 ms (§9) y
 * exige el índice `(organization_id, fixed_asset_id)`—.
 */

import { createHash } from "node:crypto"

import { depreciationSchedule, scheduleHashOf, type AssetRevisionRef, type FixedAssetRef } from "@/lib/closing/depreciation"
import type { TenantClient, TenantTransactionClient } from "@/lib/db"
import { fromUtcDate, toUtcDate } from "@/lib/ledger/dates"
import type { LocalDate } from "@/lib/ledger/types"
import { centsFromDb, centsFromDbNullable, centsToDb, centsToDbNullable } from "@/lib/money"
import type { Actor } from "@/models/accounts"
import { writeAuditLog } from "@/models/audit-log"
import { e9Abort } from "@/models/e9-errors"
import type { AssetStatus } from "@/prisma/client"

type AnyClient = TenantClient | TenantTransactionClient

/**
 * **O-12 · art. 108 LIVA.** Bien de inversión: coste > 3 005,06 € y vida útil
 * superior al año. Se **deriva** del alta y queda editable con motivo, porque
 * gobierna la guardia de regularización del art. 107.
 */
export const CAPITAL_GOOD_THRESHOLD_CENTS = 300_506

export const isCapitalGoodByRule = (costCents: number, usefulLifeMonths: number): boolean =>
  costCents > CAPITAL_GOOD_THRESHOLD_CENTS && usefulLifeMonths > 12

// ─────────────────────────────────────────────────────────────────────────────
// Lectura
// ─────────────────────────────────────────────────────────────────────────────

export type FixedAssetRow = FixedAssetRef & {
  organizationId: string
  name: string
  acquisitionDate: LocalDate
  status: AssetStatus
  isCapitalGood: boolean
  acquisitionProrrataBps: number | null
  scheduleHash: string
  disposalEntryId: string | null
  entryId: string | null
  transactionId: string | null
  fileId: string | null
}

export type AssetWithRevisions = {
  asset: FixedAssetRow
  revisions: AssetRevisionRef[]
  /** **O-19.** Σ de `68x` atribuida a ESTE activo, del diario. */
  expenseCents: number
  /** **O-19.** Σ de `28x` atribuida a ESTE activo (haber − debe). */
  accumulatedCents: number
  /** Periodos con dotación contabilizada, para el drill-down cuadro → asiento. */
  postedPeriods: string[]
}

type AssetSqlRow = {
  id: string
  organization_id: string
  code: string
  name: string
  asset_account_code: string
  accumulated_account_code: string
  expense_account_code: string
  acquisition_date: Date
  in_service_date: Date
  acquisition_cost_cents: bigint
  residual_value_cents: bigint
  method: FixedAssetRef["method"]
  useful_life_months: number
  is_capital_good: boolean
  acquisition_prorrata_bps: number | null
  project_id: string | null
  cost_center_id: string | null
  status: AssetStatus
  disposal_date: Date | null
  disposal_entry_id: string | null
  entry_id: string | null
  transaction_id: string | null
  file_id: string | null
  schedule_hash: string
  expense_cents: bigint
  accumulated_cents: bigint
  posted_periods: string[] | null
}

const toAssetRow = (r: AssetSqlRow): FixedAssetRow => ({
  id: r.id,
  organizationId: r.organization_id,
  code: r.code,
  name: r.name,
  method: r.method,
  inServiceDate: fromUtcDate(r.in_service_date),
  acquisitionDate: fromUtcDate(r.acquisition_date),
  acquisitionCostCents: centsFromDb(r.acquisition_cost_cents, "coste de adquisición"),
  residualValueCents: centsFromDb(r.residual_value_cents, "valor residual"),
  usefulLifeMonths: r.useful_life_months,
  assetAccountCode: r.asset_account_code,
  accumulatedAccountCode: r.accumulated_account_code,
  expenseAccountCode: r.expense_account_code,
  status: r.status,
  disposalDate: r.disposal_date ? fromUtcDate(r.disposal_date) : null,
  isCapitalGood: r.is_capital_good,
  acquisitionProrrataBps: r.acquisition_prorrata_bps,
  projectId: r.project_id,
  costCenterId: r.cost_center_id,
  scheduleHash: r.schedule_hash,
  disposalEntryId: r.disposal_entry_id,
  entryId: r.entry_id,
  transactionId: r.transaction_id,
  fileId: r.file_id,
})

/**
 * Activos + revisiones + **las líneas de `68x`/`28x` por `fixed_asset_id`**
 * (O-19), en **dos** consultas para todos los activos: una con los agregados
 * por activo en `LEFT JOIN LATERAL` y otra con las revisiones. Nunca una por
 * activo.
 */
export async function readAssetsWithRevisions(
  tx: TenantTransactionClient,
  opts: { status?: AssetStatus; assetId?: string; cutoff?: LocalDate } = {}
): Promise<AssetWithRevisions[]> {
  const cutoff = opts.cutoff ?? "9999-12-31"
  const rows = await tx.$queryRaw<AssetSqlRow[]>`
    SELECT a.*,
           COALESCE(l.expense_cents, 0)::bigint     AS expense_cents,
           COALESCE(l.accumulated_cents, 0)::bigint AS accumulated_cents,
           l.posted_periods
      FROM fixed_assets a
      LEFT JOIN LATERAL (
        SELECT SUM(CASE WHEN left(x.account_code, 2) = '68' THEN x.debit_cents - x.credit_cents ELSE 0 END) AS expense_cents,
               SUM(CASE WHEN left(x.account_code, 2) = '28' THEN x.credit_cents - x.debit_cents ELSE 0 END) AS accumulated_cents,
               array_agg(DISTINCT to_char(x.entry_date, 'YYYY-MM'))
                 FILTER (WHERE left(x.account_code, 2) = '68')                                              AS posted_periods
          FROM journal_lines x
         WHERE x.organization_id = a.organization_id
           AND x.fixed_asset_id = a.id
           AND x.entry_date <= ${toUtcDate(cutoff)}::date
      ) l ON TRUE
     WHERE a.organization_id = ${tx.$organizationId}::uuid
       AND (${opts.status ?? null}::text IS NULL OR a.status::text = ${opts.status ?? null})
       AND (${opts.assetId ?? null}::uuid IS NULL OR a.id = ${opts.assetId ?? null}::uuid)
     ORDER BY a.code`
  if (rows.length === 0) return []

  const revisions = await tx.assetRevision.findMany({
    where: { fixedAssetId: { in: rows.map((r) => r.id) } },
    orderBy: [{ fixedAssetId: "asc" }, { effectiveFrom: "asc" }],
  })
  const byAsset = new Map<string, AssetRevisionRef[]>()
  for (const r of revisions) {
    const list = byAsset.get(r.fixedAssetId) ?? []
    list.push({
      effectiveFrom: fromUtcDate(r.effectiveFrom),
      newUsefulLifeMonths: r.newUsefulLifeMonths,
      newResidualValueCents: centsFromDbNullable(r.newResidualValueCents, "valor residual revisado"),
      addedCostCents: centsFromDbNullable(r.addedCostCents, "mejora capitalizada"),
      reason: r.reason,
    })
    byAsset.set(r.fixedAssetId, list)
  }

  return rows.map((r) => ({
    asset: toAssetRow(r),
    revisions: byAsset.get(r.id) ?? [],
    expenseCents: centsFromDb(r.expense_cents, "dotación acumulada del activo"),
    accumulatedCents: centsFromDb(r.accumulated_cents, "amortización acumulada del activo"),
    postedPeriods: (r.posted_periods ?? []).slice().sort(),
  }))
}

/**
 * **I-E9-25 y el drill-down.** Activos **sin ninguna línea atribuida**: los
 * anteriores a E9 y los que alguien contabilizó a mano. No son un FAIL —el
 * histórico nace `NULL` (§3.5)—, pero tienen que **verse**: I-E9-5 sale `INFO`
 * nombrándolos, jamás PASS por vacuidad.
 */
export async function assetsWithoutAttribution(tx: TenantTransactionClient): Promise<{ id: string; code: string }[]> {
  return await tx.$queryRaw<{ id: string; code: string }[]>`
    SELECT a.id, a.code
      FROM fixed_assets a
     WHERE a.organization_id = ${tx.$organizationId}::uuid
       AND NOT EXISTS (
         SELECT 1 FROM journal_lines l
          WHERE l.organization_id = a.organization_id AND l.fixed_asset_id = a.id
       )
     ORDER BY a.code`
}

// ─────────────────────────────────────────────────────────────────────────────
// Escritura
// ─────────────────────────────────────────────────────────────────────────────

export type FixedAssetInput = {
  code: string
  name: string
  assetAccountCode: string
  accumulatedAccountCode: string
  expenseAccountCode: string
  acquisitionDate: LocalDate
  inServiceDate: LocalDate
  acquisitionCostCents: number
  residualValueCents?: number
  method?: FixedAssetRef["method"]
  usefulLifeMonths: number
  isCapitalGood?: boolean
  acquisitionProrrataBps?: number | null
  projectId?: string | null
  costCenterId?: string | null
  entryId?: string | null
  transactionId?: string | null
  fileId?: string | null
}

/** El `scheduleHash` del cuadro VIGENTE. Se recalcula, nunca se hereda. */
export function currentScheduleHash(asset: FixedAssetRef, revisions: readonly AssetRevisionRef[]): string {
  return scheduleHashOf(depreciationSchedule(asset, revisions))
}

export async function createAssetTx(
  tx: TenantTransactionClient,
  input: FixedAssetInput,
  actor: Actor
): Promise<FixedAssetRow> {
  const draft: FixedAssetRef = {
    id: "pendiente",
    code: input.code,
    name: input.name,
    method: input.method ?? "LINEAL",
    inServiceDate: input.inServiceDate,
    acquisitionCostCents: input.acquisitionCostCents,
    residualValueCents: input.residualValueCents ?? 0,
    usefulLifeMonths: input.usefulLifeMonths,
    assetAccountCode: input.assetAccountCode,
    accumulatedAccountCode: input.accumulatedAccountCode,
    expenseAccountCode: input.expenseAccountCode,
    projectId: input.projectId ?? null,
    costCenterId: input.costCenterId ?? null,
  }
  if (draft.method !== "LINEAL") {
    e9Abort(
      "ASSET_NOT_LINEAL",
      "method",
      `El método ${draft.method} está declarado pero el motor lo RECHAZA (D2.1): sólo se resuelve LINEAL`
    )
  }

  const row = await tx.fixedAsset.create({
    data: {
      organizationId: tx.$organizationId,
      code: input.code,
      name: input.name,
      assetAccountCode: input.assetAccountCode,
      accumulatedAccountCode: input.accumulatedAccountCode,
      expenseAccountCode: input.expenseAccountCode,
      acquisitionDate: toUtcDate(input.acquisitionDate),
      inServiceDate: toUtcDate(input.inServiceDate),
      acquisitionCostCents: centsToDb(input.acquisitionCostCents, "coste de adquisición"),
      residualValueCents: centsToDb(input.residualValueCents ?? 0, "valor residual"),
      method: draft.method,
      usefulLifeMonths: input.usefulLifeMonths,
      isCapitalGood: input.isCapitalGood ?? isCapitalGoodByRule(input.acquisitionCostCents, input.usefulLifeMonths),
      acquisitionProrrataBps: input.acquisitionProrrataBps ?? null,
      projectId: input.projectId ?? null,
      costCenterId: input.costCenterId ?? null,
      entryId: input.entryId ?? null,
      transactionId: input.transactionId ?? null,
      fileId: input.fileId ?? null,
      scheduleHash: currentScheduleHash(draft, []),
    },
  })

  // El id entra en `FixedAssetRef` pero NO en el cuadro: el hash del alta es el
  // mismo antes y después de conocerlo. Se recalcula igualmente para que la
  // fila declare el hash del cuadro que de verdad se deriva de ella.
  const hash = currentScheduleHash({ ...draft, id: row.id }, [])
  if (hash !== row.scheduleHash) {
    await tx.fixedAsset.update({ where: { id: row.id }, data: { scheduleHash: hash } })
  }

  await writeAuditLog(tx, {
    entity: "FixedAsset",
    entityId: row.id,
    action: "create",
    after: {
      code: row.code,
      acquisitionCostCents: input.acquisitionCostCents,
      usefulLifeMonths: input.usefulLifeMonths,
      inServiceDate: input.inServiceDate,
      isCapitalGood: row.isCapitalGood,
      scheduleHash: hash,
    },
    userId: actor.userId ?? null,
  })
  const created = await getAsset(tx, row.id)
  if (!created) e9Abort("ASSET_NOT_FOUND", "id", "El activo recién creado no es legible en esta transacción")
  return created
}

/**
 * **R-AM-5 · revisión PROSPECTIVA** (NRV 22ª). No toca el pasado y **no hay
 * asiento de ajuste**: cambia el cuadro desde `effectiveFrom` y con él el
 * `scheduleHash`, que es lo que I-E9-3 comprueba.
 *
 * **O-1**: reconocer tarde el valor actual **no** es un cambio de estimación
 * sino la corrección de un error, y NO usa esta tabla.
 */
export async function reviseAssetTx(
  tx: TenantTransactionClient,
  input: {
    fixedAssetId: string
    effectiveFrom: LocalDate
    newUsefulLifeMonths?: number | null
    newResidualValueCents?: number | null
    addedCostCents?: number | null
    reason: string
  },
  actor: Actor
): Promise<{ scheduleHash: string }> {
  const [current] = await readAssetsWithRevisions(tx, { assetId: input.fixedAssetId })
  if (!current) e9Abort("ASSET_NOT_FOUND", "fixedAssetId", "El activo no existe en esta organización")

  await tx.assetRevision.create({
    data: {
      organizationId: tx.$organizationId,
      fixedAssetId: input.fixedAssetId,
      effectiveFrom: toUtcDate(input.effectiveFrom),
      newUsefulLifeMonths: input.newUsefulLifeMonths ?? null,
      newResidualValueCents: centsToDbNullable(input.newResidualValueCents ?? null, "valor residual revisado"),
      addedCostCents: centsToDbNullable(input.addedCostCents ?? null, "mejora capitalizada"),
      reason: input.reason,
      createdById: actor.userId ?? null,
    },
  })

  const revisions: AssetRevisionRef[] = [
    ...current.revisions,
    {
      effectiveFrom: input.effectiveFrom,
      newUsefulLifeMonths: input.newUsefulLifeMonths ?? null,
      newResidualValueCents: input.newResidualValueCents ?? null,
      addedCostCents: input.addedCostCents ?? null,
      reason: input.reason,
    },
  ]
  const scheduleHash = currentScheduleHash(current.asset, revisions)
  await tx.fixedAsset.update({ where: { id: input.fixedAssetId }, data: { scheduleHash } })

  await writeAuditLog(tx, {
    entity: "AssetRevision",
    entityId: input.fixedAssetId,
    action: "REVISE_ASSET",
    before: { scheduleHash: current.asset.scheduleHash },
    after: {
      effectiveFrom: input.effectiveFrom,
      newUsefulLifeMonths: input.newUsefulLifeMonths ?? null,
      newResidualValueCents: input.newResidualValueCents ?? null,
      addedCostCents: input.addedCostCents ?? null,
      scheduleHash,
    },
    reason: input.reason,
    userId: actor.userId ?? null,
  })
  return { scheduleHash }
}

/**
 * **T-33 / T-34 (O-24).** Marca la baja o la venta. El asiento —con la dotación
 * previa hasta el mes de baja inclusive y `543`/`253`, **nunca `430`**— lo
 * construye `disposalLines` (T6) y lo postea la acción; aquí se cierra la ficha
 * y se recalcula el cuadro, que ahora termina en el mes de la baja (R-AM-6).
 */
export async function markAssetDisposedTx(
  tx: TenantTransactionClient,
  input: { fixedAssetId: string; kind: "BAJA" | "VENTA"; disposalDate: LocalDate; disposalEntryId: string; reason?: string | null },
  actor: Actor
): Promise<{ scheduleHash: string }> {
  const [current] = await readAssetsWithRevisions(tx, { assetId: input.fixedAssetId })
  if (!current) e9Abort("ASSET_NOT_FOUND", "fixedAssetId", "El activo no existe en esta organización")
  if (current.asset.status === "BAJA" || current.asset.status === "VENDIDO") {
    e9Abort(
      "ASSET_ALREADY_DISPOSED",
      "fixedAssetId",
      `El activo ${current.asset.code} ya está dado de baja el ${current.asset.disposalDate ?? "—"}: anular es contra-asiento`
    )
  }

  const scheduleHash = currentScheduleHash({ ...current.asset, disposalDate: input.disposalDate }, current.revisions)
  await tx.fixedAsset.update({
    where: { id: input.fixedAssetId },
    data: {
      status: input.kind === "VENTA" ? "VENDIDO" : "BAJA",
      disposalDate: toUtcDate(input.disposalDate),
      disposalEntryId: input.disposalEntryId,
      scheduleHash,
    },
  })
  await writeAuditLog(tx, {
    entity: "FixedAsset",
    entityId: input.fixedAssetId,
    action: "DISPOSE_ASSET",
    before: { status: current.asset.status, scheduleHash: current.asset.scheduleHash },
    after: { kind: input.kind, disposalDate: input.disposalDate, disposalEntryId: input.disposalEntryId, scheduleHash },
    reason: input.reason ?? null,
    userId: actor.userId ?? null,
  })
  return { scheduleHash }
}

/**
 * **O-12 · la guardia del art. 107.** Altas de grupo 2 marcadas como bien de
 * inversión dentro de la ventana de regularización, con su prorrata de
 * adquisición sellada. Agregado en SQL y acotado por fecha: sin `isCapitalGood`
 * ni `acquisitionProrrataBps` la guardia no puede comparar los diez puntos.
 */
export type CapitalGoodRow = {
  id: string
  code: string
  name: string
  inServiceDate: LocalDate
  acquisitionCostCents: number
  acquisitionProrrataBps: number | null
  isBuilding: boolean
}

export async function readCapitalGoods(
  tx: TenantTransactionClient,
  opts: { from: LocalDate; to: LocalDate }
): Promise<CapitalGoodRow[]> {
  const rows = await tx.$queryRaw<
    {
      id: string
      code: string
      name: string
      in_service_date: Date
      acquisition_cost_cents: bigint
      acquisition_prorrata_bps: number | null
      asset_account_code: string
    }[]
  >`
    SELECT a.id, a.code, a.name, a.in_service_date, a.acquisition_cost_cents,
           a.acquisition_prorrata_bps, a.asset_account_code
      FROM fixed_assets a
     WHERE a.organization_id = ${tx.$organizationId}::uuid
       AND a.is_capital_good = TRUE
       AND left(a.asset_account_code, 1) = '2'
       AND a.in_service_date BETWEEN ${toUtcDate(opts.from)}::date AND ${toUtcDate(opts.to)}::date
     ORDER BY a.in_service_date, a.code`
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    inServiceDate: fromUtcDate(r.in_service_date),
    acquisitionCostCents: centsFromDb(r.acquisition_cost_cents, "coste del bien de inversión"),
    acquisitionProrrataBps: r.acquisition_prorrata_bps,
    // Art. 107.Tres: los terrenos y las edificaciones regularizan nueve años,
    // no cuatro. La cuenta lo dice: `210` y `211` del PGC.
    isBuilding: r.asset_account_code.startsWith("210") || r.asset_account_code.startsWith("211"),
  }))
}

/**
 * **O-19 · la atribución.** Marca con `fixed_asset_id` las líneas de un asiento
 * que pertenecen a este activo.
 *
 * Existe aquí, y no en el camino de escritura del diario, por la frontera de
 * §4.10: **`lib/ledger/post.ts` no se toca** en E9. El motor postea el asiento y
 * la capa de inmovilizado dice a qué activo pertenece cada línea, en la **misma
 * transacción**. El CHECK **G-15** de la base sólo lo admite en líneas cuyo
 * `account_code` empieza por `68`, `28`, `671` o `771`, así que un intento de
 * atribuir una línea de tesorería no se cuela: lo rechaza Postgres.
 *
 * Devuelve cuántas líneas quedaron atribuidas. **Cero es un dato**: significa que
 * el asiento no tiene ninguna línea atribuible y que I-E9-5 saldrá `INFO` para
 * este activo, no PASS por vacuidad.
 */
export async function attributeLinesToAssetTx(
  tx: TenantTransactionClient,
  input: { entryId: string; fixedAssetId: string; accountPrefixes?: readonly string[] }
): Promise<number> {
  const prefixes = [...(input.accountPrefixes ?? ["68", "28", "671", "771"])]
  const updated = await tx.$executeRaw`
    UPDATE journal_lines l
       SET fixed_asset_id = ${input.fixedAssetId}::uuid
     WHERE l.organization_id = ${tx.$organizationId}::uuid
       AND l.entry_id = ${input.entryId}::uuid
       AND EXISTS (SELECT 1 FROM unnest(${prefixes}::text[]) p WHERE l.account_code LIKE p || '%')`
  return Number(updated)
}

/** sha256 canónico de una lista de códigos: sella qué activos entraron. */
export const assetSetHash = (codes: readonly string[]): string =>
  createHash("sha256").update([...codes].sort().join("\n")).digest("hex")

/** Lectura simple por id, para las acciones que sólo necesitan la ficha. */
export async function getAsset(db: AnyClient, id: string): Promise<FixedAssetRow | null> {
  const row = await db.fixedAsset.findFirst({ where: { id } })
  if (!row) return null
  return {
    id: row.id,
    organizationId: row.organizationId,
    code: row.code,
    name: row.name,
    method: row.method,
    inServiceDate: fromUtcDate(row.inServiceDate),
    acquisitionDate: fromUtcDate(row.acquisitionDate),
    acquisitionCostCents: centsFromDb(row.acquisitionCostCents, "coste de adquisición"),
    residualValueCents: centsFromDb(row.residualValueCents, "valor residual"),
    usefulLifeMonths: row.usefulLifeMonths,
    assetAccountCode: row.assetAccountCode,
    accumulatedAccountCode: row.accumulatedAccountCode,
    expenseAccountCode: row.expenseAccountCode,
    status: row.status,
    disposalDate: row.disposalDate ? fromUtcDate(row.disposalDate) : null,
    isCapitalGood: row.isCapitalGood,
    acquisitionProrrataBps: row.acquisitionProrrataBps,
    projectId: row.projectId,
    costCenterId: row.costCenterId,
    scheduleHash: row.scheduleHash,
    disposalEntryId: row.disposalEntryId,
    entryId: row.entryId,
    transactionId: row.transactionId,
    fileId: row.fileId,
  }
}
