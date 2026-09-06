"use server"

/**
 * E8 · T17 — Series de facturación (§6, O-18).
 *
 * Dos actos de **ADMIN**, los dos auditados: dar de alta una serie y
 * activarla o desactivarla. No hay un tercero, y la ausencia es deliberada:
 *
 *  · **No se borra una serie.** `invoice_series` no admite `DELETE` (política
 *    RESTRICTIVE + `REVOKE`). Una factura emitida no se borra ni se renumera
 *    (art. 15.4 RD 1619/2012 y art. 6 RD 1619/2012), así que su serie tampoco
 *    puede desaparecer.
 *  · **No se edita el contador ni el tipo.** El trigger de la base rechaza que
 *    `next_number` retroceda o salte, y que el tipo cambie: la numeración sin
 *    huecos es el invariante I-E8-20, no una convención de pantalla.
 */

import type { ActionState } from "@/lib/actions"
import { withOrg } from "@/lib/authz"
import { writeAuditLog } from "@/models/audit-log"
import { createInvoiceSeries, setInvoiceSeriesActive } from "@/models/invoices"
import { Role, type InvoiceSeriesKind } from "@/prisma/client"
import { revalidatePath } from "next/cache"
import { z } from "zod"

const PATH = "/settings/invoicing"

const createSchema = z
  .object({
    code: z.string().trim().min(1).max(24),
    kind: z.enum(["ORDINARIA", "RECTIFICATIVA", "SIMPLIFICADA"]),
    prefix: z.string().trim().min(1).max(16),
    year: z.number().int().min(2000).max(2100).nullable().optional(),
  })
  .strict()

const toggleSchema = z.object({ seriesId: z.string().uuid(), isActive: z.boolean() }).strict()

export async function createInvoiceSeriesAction(input: unknown): Promise<ActionState<{ id: string }>> {
  return await withOrg(Role.ADMIN, async ({ db, user }): Promise<ActionState<{ id: string }>> => {
    const parsed = createSchema.safeParse(input)
    if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? "Datos inválidos" }

    try {
      const created = await createInvoiceSeries(db, {
        code: parsed.data.code,
        kind: parsed.data.kind as InvoiceSeriesKind,
        prefix: parsed.data.prefix,
        year: parsed.data.year ?? null,
      })
      await writeAuditLog(db, {
        entity: "InvoiceSeries",
        entityId: created.id,
        action: "create",
        after: { code: created.code, kind: created.kind, prefix: created.prefix, year: created.year },
        userId: user.id,
      })
      revalidatePath(PATH)
      return { success: true, data: { id: created.id } }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes("Unique constraint") || message.includes("invoice_series_org_code_year_key")) {
        return { success: false, error: `Ya existe una serie con el código ${parsed.data.code} para ese ejercicio` }
      }
      return { success: false, error: message }
    }
  })()
}

export async function setInvoiceSeriesActiveAction(input: unknown): Promise<ActionState<{ id: string }>> {
  return await withOrg(Role.ADMIN, async ({ db, user }): Promise<ActionState<{ id: string }>> => {
    const parsed = toggleSchema.safeParse(input)
    if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? "Datos inválidos" }

    const updated = await setInvoiceSeriesActive(db, parsed.data.seriesId, parsed.data.isActive)
    if (!updated) return { success: false, error: "La serie no existe en esta organización" }

    await writeAuditLog(db, {
      entity: "InvoiceSeries",
      entityId: updated.id,
      action: parsed.data.isActive ? "activate" : "deactivate",
      before: { isActive: !parsed.data.isActive },
      after: { isActive: parsed.data.isActive, code: updated.code, nextNumber: updated.nextNumber },
      userId: user.id,
    })

    revalidatePath(PATH)
    return { success: true, data: { id: updated.id } }
  })()
}
