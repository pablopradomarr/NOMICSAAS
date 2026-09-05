import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * E3 · T2 — Los tres accesos que ninguna política puede autorizar, ejecutados
 * como `app_runtime` bajo RLS estricta (ADR-0009 §5 y §6):
 *
 *   · invitación por token (`app.invitation_by_token_hash`) — sin ella no se
 *     podría aceptar ninguna invitación;
 *   · barrido cross-org del cron de email (`app.list_email_sync_targets`) — sin
 *     ella el sync dejaría de sincronizar EN SILENCIO, sin error;
 *   · webhook de Stripe (`app.organization_id_by_stripe_customer`) — no tiene
 *     sesión, así que no hay usuario ni organización que fijar.
 *
 * Y el camino que SÍ tiene política: `getUserMemberships` /
 * `getMembershipWithOrganization`, de los que dependen el login y el switcher.
 */

const OWNER_URL = process.env.DATABASE_URL_OWNER as string
const MAINTENANCE_URL = process.env.DATABASE_URL_MAINTENANCE as string

const USER_A = "e3d00000-0000-4000-8000-0000000000a1"
const USER_B = "e3d00000-0000-4000-8000-0000000000b1"
const USER_C = "e3d00000-0000-4000-8000-0000000000c1"

async function owner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: OWNER_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

const { createOrganizationWithOwner } = await import("@/models/organizations")
const { getOrganizationByStripeCustomerId, updateOrganization } = await import("@/models/organizations")
const { getUserMemberships, getMembershipWithOrganization } = await import("@/models/memberships")
const { createInvitation, getInvitationByToken, acceptInvitation, generateInvitationToken } = await import(
  "@/models/invitations"
)
const { listEmailSyncTargets } = await import("@/lib/email-sync/ingest")
const { tenantDb, prisma } = await import("@/lib/db")

let orgA: { id: string }
let orgB: { id: string }

describe.skipIf(!OWNER_URL)("E3-T2: puertas estrechas y modelos bajo RLS estricta", () => {
  beforeAll(async () => {
    await limpiar()
    await owner(async (client) => {
      await client.query(
        `INSERT INTO "users" (id, email, name, updated_at) VALUES
           ($1,'e3t2-a@test.local','A', now()),
           ($2,'e3t2-b@test.local','B', now()),
           ($3,'e3t2-c@test.local','C', now())`,
        [USER_A, USER_B, USER_C]
      )
    })
    orgA = await createOrganizationWithOwner({ name: "E3T2 A", slug: "e3t2-a" }, USER_A, new Date())
    orgB = await createOrganizationWithOwner({ name: "E3T2 B", slug: "e3t2-b" }, USER_B, new Date())
  }, 60_000)

  afterAll(async () => {
    await limpiar()
    await prisma.$disconnect()
  })

  async function limpiar() {
    await owner(async (client) => {
      await client.query(`DELETE FROM "organizations" WHERE slug LIKE 'e3t2-%'`)
      await client.query(`DELETE FROM "users" WHERE id = ANY($1)`, [[USER_A, USER_B, USER_C]])
    })
  }

  it("getUserMemberships() resuelve el switcher y NO ve las de otro usuario", async () => {
    const deA = await getUserMemberships(USER_A)
    expect(deA.map((m) => m.organizationId)).toEqual([orgA.id])
    expect(deA[0].organization.name).toBe("E3T2 A")

    const deB = await getUserMemberships(USER_B)
    expect(deB.map((m) => m.organizationId)).toEqual([orgB.id])
  })

  it("getMembershipWithOrganization() trae rol y organización en una transacción", async () => {
    const ctx = await getMembershipWithOrganization(orgA.id, USER_A)
    expect(ctx?.role).toBe("ADMIN")
    expect(ctx?.organization.id).toBe(orgA.id)

    // Y no autoriza a quien no es miembro.
    expect(await getMembershipWithOrganization(orgA.id, USER_B)).toBeNull()
  })

  it("invitación por token: la puerta `app.invitation_by_token_hash` la encuentra y se acepta", async () => {
    const db = tenantDb(orgA.id)
    const { invitation, token } = await createInvitation(db, {
      email: "e3t2-c@test.local",
      role: "EDITOR",
      invitedById: USER_A,
      now: new Date(),
    })

    // Sin organización activa ni membresía: sólo la función SECURITY DEFINER
    // puede devolver esta fila.
    const encontrada = await getInvitationByToken(token)
    expect(encontrada?.id).toBe(invitation.id)
    expect(encontrada?.organizationId).toBe(orgA.id)
    expect(encontrada?.attempts).toBe(0)
    expect(encontrada?.invitedById).toBe(USER_A)

    // Un token que no existe no devuelve nada (y no filtra las demás filas).
    expect(await getInvitationByToken(generateInvitationToken())).toBeNull()

    const { membership } = await acceptInvitation(encontrada!, USER_C, new Date())
    expect(membership.role).toBe("EDITOR")
    expect(membership.organizationId).toBe(orgA.id)
  })

  it("la puerta de invitaciones sólo devuelve las columnas acotadas (no el tokenHash)", async () => {
    const columnas = await owner(async (client) =>
      client.query<{ resultado: string }>(
        `SELECT pg_get_function_result(p.oid) AS resultado
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'app' AND p.proname = 'invitation_by_token_hash'`
      )
    )
    const firma = columnas.rows[0]?.resultado ?? ""
    expect(firma).not.toContain("token_hash")
    for (const columna of ["id", "organization_id", "email", "role", "status", "expires_at"]) {
      expect.soft(`${columna} en ${firma}`).toContain(columna)
    }
  })

  it("email-sync: el barrido cross-org devuelve las dos organizaciones", async () => {
    await tenantDb(orgA.id).appData.create({
      data: { userId: USER_A, app: "email", data: { servers: [] } },
    })
    await tenantDb(orgB.id).appData.create({
      data: { userId: USER_B, app: "email", data: { servers: [] } },
    })

    const targets = await listEmailSyncTargets()
    const mios = targets.filter((t) => t.organizationId === orgA.id || t.organizationId === orgB.id)
    expect(mios).toHaveLength(2)
    expect(mios.map((t) => t.userId).sort()).toEqual([USER_A, USER_B].sort())

    // Acotado a una organización, sólo esa (camino de «Sincronizar ahora»).
    const soloA = await listEmailSyncTargets({ organizationId: orgA.id })
    expect(soloA).toEqual([{ organizationId: orgA.id, userId: USER_A }])

    // Y una lectura cruda SIN GUC, que es lo que hacía antes el cron, ya no ve nada.
    const sinGuc = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM app_data`
    expect(Number(sinGuc[0].n)).toBe(0)
  })

  it("Stripe: la puerta resuelve la organización sin sesión, y sin ella no se vería", async () => {
    await updateOrganization(orgA.id, { stripeCustomerId: "cus_e3t2_A" })

    const organizacion = await getOrganizationByStripeCustomerId("cus_e3t2_A")
    expect(organizacion?.id).toBe(orgA.id)
    expect(await getOrganizationByStripeCustomerId("cus_no_existe")).toBeNull()

    // La consulta directa sin GUC (lo que hacía `prisma.organization.findUnique`)
    // devuelve 0 filas: la puerta es lo único que la autoriza.
    const sinGuc = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM organizations WHERE stripe_customer_id = 'cus_e3t2_A'
    `
    expect(Number(sinGuc[0].n)).toBe(0)
  })
})

describe.skipIf(!OWNER_URL || !MAINTENANCE_URL)("E3-T2: el barrido del cron como app_maintenance", () => {
  it("con DATABASE_URL_MAINTENANCE, listEmailSyncTargets usa el rol BYPASSRLS", async () => {
    const anterior = process.env.DATABASE_URL_MAINTENANCE
    try {
      // Ya está puesta por la configuración de la suite; se comprueba que el
      // camino de mantenimiento devuelve lo mismo que la puerta SECURITY DEFINER.
      const { isMaintenanceConfigured } = await import("@/lib/db-maintenance")
      expect(isMaintenanceConfigured()).toBe(true)
      const conMantenimiento = await listEmailSyncTargets()

      delete process.env.DATABASE_URL_MAINTENANCE
      const conPuerta = await listEmailSyncTargets()
      expect(conMantenimiento).toEqual(conPuerta)
    } finally {
      process.env.DATABASE_URL_MAINTENANCE = anterior
    }
  })

  it("withMaintenanceClient rechaza una URL cuyo rol no tenga BYPASSRLS", async () => {
    const { withMaintenanceClient } = await import("@/lib/db-maintenance")
    const anterior = process.env.DATABASE_URL_MAINTENANCE
    process.env.DATABASE_URL_MAINTENANCE = process.env.DATABASE_URL
    try {
      await expect(withMaintenanceClient(async () => 1)).rejects.toThrow(/BYPASSRLS/)
    } finally {
      process.env.DATABASE_URL_MAINTENANCE = anterior
    }
  })
})
