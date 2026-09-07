/**
 * E13 · T14 — Arnés de los e2e de auth (docs/design/E13-autenticacion.md §8.3).
 *
 * Siembra el entorno mínimo que necesita `tests/e2e/auth/*.spec.ts` en la base de
 * pruebas, con el mismo espíritu que `tests/support/ensure-self-hosted.ts`:
 * IDEMPOTENTE y ejecutado con `npx tsx` porque necesita el código de la aplicación
 * (better-auth, `models/`) y el cargador ESM de Playwright no puede importarlo
 * directamente.
 *
 * Siembra:
 *  - `admin.e2e@nomic.local` — ADMIN con contraseña conocida, organización propia
 *    con plan de cuentas (vía `getOrCreateCloudUser`, el mismo camino de alta que
 *    usa `scripts/create-admin.ts`, nunca una implementación paralela).
 *  - `viewer.e2e@nomic.local` — VIEWER con contraseña conocida, miembro de la
 *    MISMA organización que el admin (criterio 11 y matriz de roles §4.3).
 *  - `reset.e2e@nomic.local` — cuenta dedicada para el flujo de restablecimiento
 *    (T7/T9), separada del admin para no invalidar la contraseña que usan el resto
 *    de specs cuando `reset.spec.ts` la cambia. Su contraseña se REESCRIBE en cada
 *    ejecución del arnés para que el spec sea repetible.
 *  - una invitación PENDING con **token conocido** (rol EDITOR) en la organización
 *    del admin, para `invite.spec.ts`. Si el email de la invitación ya tiene cuenta
 *    de una ejecución anterior (el propio spec la crea al fijar la contraseña), el
 *    arnés la BORRA primero: es una dirección exclusiva de este arnés, sin datos de
 *    negocio que perder, y sin este reseteo el criterio 7 ("invitación a quien ya
 *    tiene cuenta") se dispararía siempre a partir de la segunda ejecución.
 *
 * Conecta como `app_maintenance` (BYPASSRLS, ADR-0009 §6), igual que
 * `scripts/create-admin.ts`: es el único rol que puede crear la organización y la
 * invitación sin una sesión previa con la que fijar `app.current_org`.
 *
 *   DATABASE_URL_MAINTENANCE=… npx tsx tests/support/ensure-cloud-auth.ts
 *
 * Imprime en `stdout`, en una sola línea, el JSON con todo lo que los specs
 * necesitan (ids, emails, contraseñas en claro —de un entorno de pruebas efímero,
 * nunca de un despliegue real— y el token de invitación).
 */

import { maintenanceDatabaseUrl } from "@/lib/db-maintenance"
import type { Prisma } from "@/prisma/client"

export const ADMIN_EMAIL = "admin.e2e@nomic.local"
export const ADMIN_PASSWORD = "AdminE2E-Passw0rd!"
export const VIEWER_EMAIL = "viewer.e2e@nomic.local"
export const VIEWER_PASSWORD = "ViewerE2E-Passw0rd!"
export const RESET_USER_EMAIL = "reset.e2e@nomic.local"
export const RESET_USER_INITIAL_PASSWORD = "ResetE2E-Initial-Pwd1"
export const PROFILE_USER_EMAIL = "profile.e2e@nomic.local"
export const PROFILE_USER_INITIAL_PASSWORD = "ProfileE2E-Initial-Pwd1"
export const INVITE_EMAIL = "invite.e2e@nomic.local"
export const INVITE_ROLE = "EDITOR" as const
/**
 * Token EN CLARO fijo: los specs lo leen de aquí, nunca de un correo real (no hay Resend).
 * Debe cumplir `invitationTokenSchema` (`forms/invitations.ts`): exactamente 43 caracteres
 * base64url, la misma longitud que produce `generateInvitationToken()` en producción.
 */
export const INVITE_TOKEN = "e13e2efixedinvitetoken0001AAAAAAAAAAAAAAAAA"

export type CloudAuthSeed = {
  organizationId: string
  admin: { id: string; email: string; password: string }
  viewer: { id: string; email: string; password: string }
  resetUser: { id: string; email: string; password: string }
  profileUser: { id: string; email: string; password: string }
  invite: { token: string; email: string; role: string; organizationId: string }
}

async function main(): Promise<CloudAuthSeed> {
  const url = maintenanceDatabaseUrl()
  process.env.DATABASE_URL = url
  // E7 · T14 (ADR-0015 D5): `models/users.ts` y `lib/auth-password.ts` escriben por
  // `authPrisma` (`AUTH_DATABASE_URL`, rol `app_auth`). El arnés siembra ADEMÁS la
  // organización y la membresía, que `app_auth` no puede tocar: se le fuerza el mismo
  // `app_maintenance` que al resto del script, como hace `scripts/create-admin.ts`.
  process.env.AUTH_DATABASE_URL = url

  const db = await import("@/lib/db")
  const users = await import("@/models/users")
  const organizations = await import("@/models/organizations")
  const memberships = await import("@/models/memberships")
  const invitations = await import("@/models/invitations")
  const authPassword = await import("@/lib/auth-password")
  const { Role } = await import("@/prisma/client")

  const prisma = db.prisma as unknown as {
    $queryRaw: <T>(query: TemplateStringsArray) => Promise<T>
    account: {
      deleteMany: (args: unknown) => Promise<unknown>
      create: (args: unknown) => Promise<unknown>
    }
    membership: { deleteMany: (args: unknown) => Promise<unknown> }
    invitation: { deleteMany: (args: unknown) => Promise<unknown>; findFirst: (args: unknown) => Promise<{ id: string } | null> }
    user: { deleteMany: (args: unknown) => Promise<unknown>; findUnique: (args: unknown) => Promise<{ id: string } | null> }
  }

  const { randomUUID } = await import("node:crypto")

  /**
   * BUG-E13-1 (ver informe QA): `setUserPassword` falla con "Argument `id` is
   * missing" para CUALQUIER usuario que todavía no tiene fila `account` —
   * exactamente el caso de un usuario recién creado (primer ADMIN, invitado que
   * fija su contraseña por primera vez) — porque `account.id` no tiene
   * `@default(uuid())` en el esquema (a diferencia de `users`/`sessions`) y el
   * adaptador de better-auth espera que el DEFAULT de la base rellene el id.
   *
   * Workaround SOLO de este arnés de pruebas, para poder sembrar el resto de la
   * suite sin depender de que el bug se corrija: si `setUserPassword` falla así,
   * se inserta la fila `account` a mano con el MISMO hash que generaría
   * better-auth (`hashPassword`, el hasher real). El bug de producto en sí lo
   * reproduce y documenta `invite.spec.ts` llamando al camino real
   * (`setInvitedPasswordAction`), sin este parche.
   */
  async function seedPassword(userId: string, plain: string): Promise<void> {
    try {
      await authPassword.setUserPassword(userId, plain)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes("Argument `id` is missing")) throw error
      const hashed = await authPassword.hashPassword(plain)
      await prisma.account.deleteMany({ where: { userId, providerId: "credential" } })
      await prisma.account.create({
        data: {
          id: randomUUID(),
          accountId: userId,
          providerId: "credential",
          userId,
          password: hashed,
          updatedAt: new Date(),
        },
      })
    }
  }

  const rows = await prisma.$queryRaw<
    { rolname: string; rolbypassrls: boolean }[]
  >`SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = current_user`
  if (!rows[0]?.rolbypassrls) {
    throw new Error(
      `DATABASE_URL_MAINTENANCE conecta como \`${rows[0]?.rolname ?? "?"}\`, sin BYPASSRLS. ` +
        "El arnés de e2e necesita `app_maintenance` para sembrar organización + invitación sin sesión previa."
    )
  }

  // 1. Admin — mismo camino de alta cloud que `scripts/create-admin.ts`.
  const admin = await users.getOrCreateCloudUser(
    ADMIN_EMAIL,
    { email: ADMIN_EMAIL, name: "Admin E2E", emailVerified: true },
    { name: "Organización QA e2e" }
  )
  const organization = await organizations.ensurePersonalOrganization(
    { id: admin.id, email: admin.email, name: "Admin E2E" },
    new Date()
  )
  await seedPassword(admin.id, ADMIN_PASSWORD)

  // 2. Viewer — cuenta propia, membresía VIEWER en la organización del admin (no en la suya).
  const viewer = await users.getOrCreateCloudUser(VIEWER_EMAIL, {
    email: VIEWER_EMAIL,
    name: "Viewer E2E",
    emailVerified: true,
  })
  await seedPassword(viewer.id, VIEWER_PASSWORD)
  const existingViewerMembership = await memberships.getMembership(organization.id, viewer.id)
  if (!existingViewerMembership) {
    await memberships.createMembership({
      organizationId: organization.id,
      userId: viewer.id,
      role: Role.VIEWER,
      now: new Date(),
    })
  } else if (existingViewerMembership.role !== Role.VIEWER) {
    await db.tenantDb(organization.id).membership.update({
      where: { organizationId_userId: { organizationId: organization.id, userId: viewer.id } },
      data: { role: Role.VIEWER },
    })
  }

  // 3. Cuenta dedicada al flujo de reset — contraseña reescrita en cada ejecución
  // para que `reset.spec.ts` sea repetible aunque haya cambiado la contraseña la
  // vez anterior. Miembro EDITOR de la misma organización (rol irrelevante para
  // ese spec, sólo hace falta que pueda entrar).
  const resetUser = await users.getOrCreateCloudUser(RESET_USER_EMAIL, {
    email: RESET_USER_EMAIL,
    name: "Reset E2E",
    emailVerified: true,
  })
  await seedPassword(resetUser.id, RESET_USER_INITIAL_PASSWORD)
  await authPassword.revokeAllSessions(resetUser.id)
  const existingResetMembership = await memberships.getMembership(organization.id, resetUser.id)
  if (!existingResetMembership) {
    await memberships.createMembership({
      organizationId: organization.id,
      userId: resetUser.id,
      role: Role.EDITOR,
      now: new Date(),
    })
  }

  // 3b. Cuenta dedicada a "cambiar mi contraseña desde el perfil" (criterio 12): separada de
  // `resetUser` porque ese spec YA cambia una contraseña por otro camino (el token de reset) y
  // compartir cuenta entre ambos specs dejaría una carrera entre archivos de test.
  const profileUser = await users.getOrCreateCloudUser(PROFILE_USER_EMAIL, {
    email: PROFILE_USER_EMAIL,
    name: "Profile E2E",
    emailVerified: true,
  })
  await seedPassword(profileUser.id, PROFILE_USER_INITIAL_PASSWORD)
  await authPassword.revokeAllSessions(profileUser.id)
  const existingProfileMembership = await memberships.getMembership(organization.id, profileUser.id)
  if (!existingProfileMembership) {
    await memberships.createMembership({
      organizationId: organization.id,
      userId: profileUser.id,
      role: Role.EDITOR,
      now: new Date(),
    })
  }

  // 4. Invitación PENDING con token conocido — se resetea por completo en cada
  // ejecución: si el email ya tiene cuenta (el spec anterior fijó su contraseña),
  // se borra para que el criterio 5 (alta por invitación) sea repetible.
  const existingInvitedUser = await prisma.user.findUnique({ where: { email: INVITE_EMAIL } })
  if (existingInvitedUser) {
    await prisma.membership.deleteMany({ where: { userId: existingInvitedUser.id } })
    await prisma.account.deleteMany({ where: { userId: existingInvitedUser.id } })
    await prisma.user.deleteMany({ where: { id: existingInvitedUser.id } })
  }
  await prisma.invitation.deleteMany({ where: { organizationId: organization.id, email: INVITE_EMAIL } })

  // organizationId lo inyecta tenantDb (barrera 1); igual que `createInvitation` en
  // `models/invitations.ts`, el tipo estricto de Prisma no lo sabe.
  const tenantDb = db.tenantDb(organization.id)
  await tenantDb.invitation.create({
    data: {
      email: INVITE_EMAIL,
      role: Role.EDITOR,
      tokenHash: invitations.hashInvitationToken(INVITE_TOKEN),
      invitedById: admin.id,
      expiresAt: invitations.invitationExpiresAt(new Date()),
      status: "PENDING",
    } satisfies Omit<Prisma.InvitationUncheckedCreateInput, "organizationId"> as Prisma.InvitationUncheckedCreateInput,
  })

  return {
    organizationId: organization.id,
    admin: { id: admin.id, email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    viewer: { id: viewer.id, email: VIEWER_EMAIL, password: VIEWER_PASSWORD },
    resetUser: { id: resetUser.id, email: RESET_USER_EMAIL, password: RESET_USER_INITIAL_PASSWORD },
    profileUser: { id: profileUser.id, email: PROFILE_USER_EMAIL, password: PROFILE_USER_INITIAL_PASSWORD },
    invite: { token: INVITE_TOKEN, email: INVITE_EMAIL, role: INVITE_ROLE, organizationId: organization.id },
  }
}

main()
  .then((seed) => {
    process.stdout.write(`${JSON.stringify(seed)}\n`)
    process.exit(0)
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error)
    process.exit(1)
  })
