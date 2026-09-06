/**
 * E8 · T23 — Maestro de terceros y su **calificación fiscal**
 * (`docs/design/E8-documentos-asientos.md` §4.2, ADR-0014 D11).
 *
 * Este maestro es donde vive lo que el documento **no** decide: el país, el
 * NIF-IVA y su comprobación en VIES, el régimen de retención, el recargo de
 * equivalencia y si el tercero es un empleado. El motivo es siempre el mismo:
 *
 *  · La **retención** es obligación del pagador (arts. 99, 101 y 107 LIRPF). Si
 *    el profesional no la consigna en su factura, la sociedad sigue obligada y
 *    responde de la deuda. Leerla del PDF sería delegar en el proveedor una
 *    obligación que no es suya; lo leído sólo **contrasta** (RC-19).
 *  · La calificación **ISP** exige cuatro precondiciones verificables (RC-22),
 *    nunca el silencio del documento: autorrepercutir sobre una importación
 *    inventa una cuota devengada y una deducible sin soporte.
 *  · El **recargo de equivalencia** se aplica según el régimen del cliente
 *    registrado, no según lo que diga el documento.
 *
 * Nada de aquí calcula: es IO acotado por tenant, y todo cambio deja `AuditLog`
 * con `before`/`after` porque cambiar un régimen de retención cambia asientos
 * futuros y eso tiene que poder explicarse.
 */

import { TenantClient, TenantTransactionClient, tenantTransaction } from "@/lib/db"
import { writeAuditLog } from "@/models/audit-log"
import type { Counterparty, WithholdingRegime } from "@/prisma/client"

type AnyClient = TenantClient | TenantTransactionClient

export type CounterpartyInput = {
  code: string
  name: string
  taxId?: string | null
  countryCode?: string | null
  vatNumber?: string | null
  withholdingRegime?: WithholdingRegime
  withholdingRateCode?: string | null
  surchargeRegime?: boolean
  isEmployee?: boolean
  isActive?: boolean
  notes?: string | null
}

export type Actor = { userId?: string | null }

export async function listCounterparties(
  db: AnyClient,
  filter: { search?: string; onlyActive?: boolean } = {}
): Promise<Counterparty[]> {
  return await db.counterparty.findMany({
    where: {
      ...(filter.onlyActive ? { isActive: true } : {}),
      ...(filter.search
        ? {
            OR: [
              { name: { contains: filter.search, mode: "insensitive" as const } },
              { code: { contains: filter.search, mode: "insensitive" as const } },
              { taxId: { contains: filter.search, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
  })
}

export async function getCounterparty(db: AnyClient, id: string): Promise<Counterparty | null> {
  return await db.counterparty.findFirst({ where: { id } })
}

/** Por NIF: es como RC-11 y RC-12 buscan al tercero de un documento. */
export async function findCounterpartyByTaxId(db: AnyClient, taxId: string): Promise<Counterparty | null> {
  return await db.counterparty.findFirst({ where: { taxId } })
}

/** El código de un tercero identifica, así que se normaliza a mayúsculas sin espacios. */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, "-")
}

/** El NIF se compara sin espacios ni guiones: «B-12 345 674» y «B12345674» son el mismo. */
export function normalizeTaxId(taxId: string | null | undefined): string | null {
  if (!taxId) return null
  const clean = taxId.replace(/[\s.-]/g, "").toUpperCase()
  return clean === "" ? null : clean
}

function sanitize(input: CounterpartyInput) {
  return {
    code: normalizeCode(input.code),
    name: input.name.trim(),
    taxId: normalizeTaxId(input.taxId),
    countryCode: input.countryCode ? input.countryCode.trim().toUpperCase() : null,
    vatNumber: normalizeTaxId(input.vatNumber),
    withholdingRegime: input.withholdingRegime ?? ("NINGUNO" as WithholdingRegime),
    withholdingRateCode: input.withholdingRateCode?.trim() || null,
    surchargeRegime: input.surchargeRegime ?? false,
    isEmployee: input.isEmployee ?? false,
    isActive: input.isActive ?? true,
    notes: input.notes?.trim() || null,
  }
}

export async function createCounterparty(
  organizationId: string,
  input: CounterpartyInput,
  actor: Actor
): Promise<Counterparty> {
  const data = sanitize(input)
  return await tenantTransaction(organizationId, actor.userId ?? undefined, async (tx) => {
    const created = await tx.counterparty.create({ data: { organizationId, ...data } })
    await writeAuditLog(tx, {
      entity: "Counterparty",
      entityId: created.id,
      action: "create",
      after: data,
      userId: actor.userId ?? null,
    })
    return created
  })
}

/**
 * Edición. **`code` no se toca**: es el identificador con el que las propuestas
 * ya confirmadas apuntan al tercero, y renombrarlo rompería esa referencia sin
 * dejar rastro. Para un tercero equivocado se desactiva y se crea otro.
 */
export async function updateCounterparty(
  organizationId: string,
  id: string,
  patch: Omit<CounterpartyInput, "code">,
  actor: Actor,
  reason?: string | null
): Promise<Counterparty> {
  const data = sanitize({ ...patch, code: "X" })
  const { code: _code, ...withoutCode } = data
  void _code
  return await tenantTransaction(organizationId, actor.userId ?? undefined, async (tx) => {
    const before = await tx.counterparty.findFirst({ where: { id } })
    if (!before) throw new Error(`El tercero ${id} no existe en esta organización`)
    const updated = await tx.counterparty.update({ where: { id }, data: withoutCode })
    await writeAuditLog(tx, {
      entity: "Counterparty",
      entityId: id,
      action: "update",
      before: {
        name: before.name,
        taxId: before.taxId,
        countryCode: before.countryCode,
        vatNumber: before.vatNumber,
        withholdingRegime: before.withholdingRegime,
        withholdingRateCode: before.withholdingRateCode,
        surchargeRegime: before.surchargeRegime,
        isEmployee: before.isEmployee,
        isActive: before.isActive,
      },
      after: withoutCode,
      reason: reason ?? null,
      userId: actor.userId ?? null,
    })
    return updated
  })
}

/**
 * Resultado de VIES **persistido con su fecha**: la precondición (1) del ISP es
 * «NIF-IVA validado en VIES **con fecha y resultado persistidos**». Una
 * comprobación que no se guarda no acredita nada seis meses después.
 *
 * La llamada a la red la hará `checkVies` en T7/T11; aquí sólo se registra lo
 * que aquélla devuelva, con el `checkedAt` que el llamante aporta (nada de
 * `new Date()` implícito).
 */
export async function recordViesCheck(
  organizationId: string,
  id: string,
  result: { valid: boolean; checkedAt: Date },
  actor: Actor
): Promise<Counterparty> {
  return await tenantTransaction(organizationId, actor.userId ?? undefined, async (tx) => {
    const updated = await tx.counterparty.update({
      where: { id },
      data: { viesValid: result.valid, viesCheckedAt: result.checkedAt },
    })
    await writeAuditLog(tx, {
      entity: "Counterparty",
      entityId: id,
      action: "vies_check",
      after: { viesValid: result.valid, viesCheckedAt: result.checkedAt.toISOString() },
      userId: actor.userId ?? null,
    })
    return updated
  })
}
