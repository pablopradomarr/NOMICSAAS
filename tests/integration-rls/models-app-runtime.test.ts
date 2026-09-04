import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * Ronda 2 (#1, #6) — el código REAL de `models/` ejecutado como `app_runtime`.
 *
 * `vitest.integration.rls.config.ts` apunta `DATABASE_URL` al rol de runtime
 * (LOGIN, NOBYPASSRLS, no propietario), así que aquí NO hay red de seguridad:
 * cualquier política mal escrita rompe el test. La suite anterior corría como
 * propietario/superusuario, que ignora RLS, y por eso daba verde con
 * `createOrganizationWithOwner` roto.
 *
 * Nada de SQL a mano para el camino feliz: se llaman las funciones de modelo que
 * usa la aplicación.
 */

const OWNER_URL = process.env.DATABASE_URL_OWNER as string

const USER_A = "cccccccc-cccc-4ccc-8ccc-cccccccccc10"
const USER_B = "cccccccc-cccc-4ccc-8ccc-cccccccccc20"
const USER_C = "cccccccc-cccc-4ccc-8ccc-cccccccccc30"

async function owner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: OWNER_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

const { createOrganizationWithOwner, ensurePersonalOrganization, updateOrganization } = await import(
  "@/models/organizations"
)
const { tenantDb, tenantTransaction, prisma } = await import("@/lib/db")
const { acceptInvitation, createInvitation, registerFailedInvitationAttempt, generateInvitationToken } =
  await import("@/models/invitations")
const { applySyncResult } = await import("@/lib/email-sync/ingest")

let orgA: { id: string }
let orgB: { id: string }

describe.skipIf(!OWNER_URL)("models/ ejecutados como app_runtime (RLS efectiva)", () => {
  beforeAll(async () => {
    await cleanup()
    // `users` no lleva RLS (es pre-tenant): el alta la hace el propietario, igual
    // que en la aplicación, antes de que exista ninguna organización.
    await owner(async (client) => {
      await client.query(
        `INSERT INTO "users" (id, email, name, updated_at) VALUES
           ($1,'rls-models-a@test.local','A', now()),
           ($2,'rls-models-b@test.local','B', now()),
           ($3,'rls-models-c@test.local','C', now())`,
        [USER_A, USER_B, USER_C]
      )
    })
  }, 60_000)

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  async function cleanup() {
    await owner(async (client) => {
      await client.query(
        `DELETE FROM "organizations" WHERE slug LIKE 'rls-models-%' OR id = ANY($1)`,
        [[USER_A, USER_B, USER_C]]
      )
      await client.query(`DELETE FROM "users" WHERE id = ANY($1)`, [[USER_A, USER_B, USER_C]])
    })
  }

  it("createOrganizationWithOwner() funciona bajo RLS (BLOQUEA-1: INSERT … RETURNING)", async () => {
    orgA = await createOrganizationWithOwner(
      { name: "RLS Models A", slug: "rls-models-a" },
      USER_A,
      new Date()
    )
    orgB = await createOrganizationWithOwner(
      { name: "RLS Models B", slug: "rls-models-b" },
      USER_B,
      new Date()
    )
    expect(orgA.id).not.toBe(orgB.id)

    // Y la membresía ADMIN nació en la MISMA transacción.
    const membresias = await owner(async (client) =>
      client.query(`SELECT role FROM "memberships" WHERE organization_id = $1`, [orgA.id])
    )
    expect(membresias.rows.map((r) => r.role)).toEqual(["ADMIN"])
  })

  it("ensurePersonalOrganization() funciona bajo RLS y es idempotente", async () => {
    const user = { id: USER_C, email: "rls-models-c@test.local", name: "C" }
    const first = await ensurePersonalOrganization(user, new Date())
    const second = await ensurePersonalOrganization(user, new Date())
    expect(first.id).toBe(USER_C)
    expect(second.id).toBe(first.id)
  })

  it("updateOrganization() pasa el WITH CHECK de organizations", async () => {
    const updated = await updateOrganization(orgA.id, { storageUsed: 4096 })
    expect(updated.storageUsed).toBe(4096)
  })

  it("CRUD de categorías y transacciones por tenantDb bajo RLS", async () => {
    const db = tenantDb(orgA.id)
    const categoria = await db.category.create({ data: { code: "rls-cat", name: "Categoría" } })
    expect(categoria.organizationId).toBe(orgA.id)

    const transaccion = await db.transaction.create({
      data: {
        name: "Factura RLS",
        type: "expense",
        total: 12345,
        currencyCode: "EUR",
        categoryCode: "rls-cat",
        issuedAt: new Date(),
      },
    })
    expect(transaccion.organizationId).toBe(orgA.id)

    // findUnique se reescribe a findFirst DENTRO de la transacción (ronda 2, #2):
    // si se escapara, no vería el GUC y RLS devolvería 0 filas.
    const leida = await db.transaction.findUnique({ where: { id: transaccion.id } })
    expect(leida?.id).toBe(transaccion.id)

    await db.transaction.update({ where: { id: transaccion.id }, data: { name: "Factura RLS v2" } })
    await db.category.update({ where: { organizationId_code: { organizationId: orgA.id, code: "rls-cat" } }, data: { name: "Cat v2" } })

    // Aislamiento: B no ve nada de A.
    expect(await tenantDb(orgB.id).transaction.count()).toBe(0)
    expect(await tenantDb(orgB.id).category.count()).toBe(0)

    await db.transaction.delete({ where: { id: transaccion.id } })
    await db.category.deleteMany({ where: { code: "rls-cat" } })
  })

  it("tenantTransaction agrupa varias escrituras en UNA transacción con GUC", async () => {
    const total = await tenantTransaction(orgA.id, USER_A, async (tx) => {
      await tx.category.create({ data: { code: "rls-tx", name: "En transacción" } })
      const guc = await tx.$queryRawUnsafe<{ o: string | null; u: string | null }[]>(
        "SELECT app.current_org() AS o, app.current_user() AS u"
      )
      expect(guc[0].o).toBe(orgA.id)
      expect(guc[0].u).toBe(USER_A)
      return await tx.category.count()
    })
    expect(total).toBe(1)
    await tenantDb(orgA.id).category.deleteMany({ where: { code: "rls-tx" } })
  })

  it("invitación: creación, intento fallido (#3) y aceptación transaccional (#15)", async () => {
    const tokenDeReferencia = generateInvitationToken()
    const db = tenantDb(orgA.id)
    const { invitation } = await createInvitation(db, {
      email: "rls-models-c@test.local",
      role: "EDITOR",
      invitedById: USER_A,
      now: new Date(),
    })
    expect(invitation.organizationId).toBe(orgA.id)

    // #3: el UPDATE del contador de intentos también pasa por el WITH CHECK.
    await registerFailedInvitationAttempt(invitation.id, invitation.organizationId)
    const tras = await db.invitation.findUnique({ where: { id: invitation.id } })
    expect(tras?.attempts).toBe(1)

    const { membership } = await acceptInvitation(invitation, USER_C, new Date())
    expect(membership.role).toBe("EDITOR")
    const aceptada = await db.invitation.findUnique({ where: { id: invitation.id } })
    expect(aceptada?.status).toBe("ACCEPTED")

    // Idempotente: repetir no duplica membresía (unique + P2002).
    await owner(async (client) => {
      const res = await client.query(`SELECT count(*)::int AS n FROM "memberships" WHERE organization_id = $1`, [
        orgA.id,
      ])
      expect(res.rows[0].n).toBe(2)
    })
    // El token en claro nunca se persiste: en BD sólo vive su sha256.
    expect(invitation.tokenHash).toHaveLength(64)
    expect(invitation.tokenHash).not.toContain(tokenDeReferencia)
  })

  it("email-sync applySyncResult() escribe app_data bajo RLS (#4)", async () => {
    const db = tenantDb(orgA.id)
    await db.appData.create({
      data: {
        userId: USER_A,
        app: "email",
        data: { servers: [{ id: "s1", isActive: true, lastProcessedUid: 0 }] },
      },
    })

    await applySyncResult(orgA.id, USER_A, {
      serverId: "s1",
      processed: 3,
      lastProcessedUid: 42,
      status: "ok",
    })

    const fila = await db.appData.findFirst({ where: { userId: USER_A, app: "email" } })
    const servers = (fila?.data as { servers: { lastProcessedUid: number; status: string }[] }).servers
    expect(servers[0].lastProcessedUid).toBe(42)
    expect(servers[0].status).toBe("ok")

    await db.appData.deleteMany({ where: { userId: USER_A, app: "email" } })
  })

  it("una escritura cruzada la corta la BASE DE DATOS, no sólo tenantDb", async () => {
    // `tenantDb` ya lanza TenantError antes de llegar a la base; aquí se
    // comprueba la barrera 2 saltándose la 1: SQL crudo dentro de la
    // transacción de A intentando escribir en B.
    await expect(
      tenantTransaction(orgA.id, USER_A, async (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "categories" (id, organization_id, code, name) VALUES (gen_random_uuid(), '${orgB.id}', 'intruso', 'Intruso')`
        )
      )
    ).rejects.toThrow(/row-level security/i)
  })
})
