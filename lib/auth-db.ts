/**
 * E7 · T14 — **El segundo cliente Prisma: el del camino de autenticación**
 * (ADR-0015 D5, APROBADO).
 *
 * `users` era la única tabla sin RLS. No era descuido: no tiene
 * `organization_id` —un usuario pertenece a varias organizaciones— y el camino
 * de autenticación la lee **sin sesión**, así que ninguna política acotada por
 * `app.current_org()` podía autorizarlo. Pero mientras tanto un
 * `SELECT * FROM users` desde `app_runtime` enumeraba los correos de todos los
 * clientes del SaaS.
 *
 * La migración `20260916130000_e7_users_rls` cierra eso con políticas **por
 * rol**, y ese es el coste conocido que el ADR aceptó: hace falta una segunda
 * conexión, con el rol `app_auth`, para el alta, el OTP, la verificación y la
 * sesión. Es literalmente lo único que este cliente hace; no es un segundo
 * `app_runtime` con otro nombre:
 *
 *   · `app_auth` tiene `GRANT` sobre CUATRO tablas —`users`, `sessions`,
 *     `account`, `verification`— y sobre ninguna más.
 *   · Es `NOBYPASSRLS`. Darle `BYPASSRLS` habría sido reabrir el agujero que
 *     ADR-0009 cerró: seguiría sujeto a las políticas de todo lo demás.
 *   · No conoce `tenantDb`: aquí no hay organización que acotar todavía. Todo
 *     lo que sea de negocio sigue pasando por `tenantDb(orgId)`.
 *
 * Sin `AUTH_DATABASE_URL` definida, el cliente cae en `DATABASE_URL` y **avisa
 * una vez**: en desarrollo y CI local el propietario es superusuario y no
 * notaría nada, pero en un despliegue con `app_runtime` de verdad el alta de un
 * usuario fallaría con `permission denied`. Media RLS es peor que ninguna
 * porque parece que protege, así que el aviso dice exactamente qué falta.
 */

import { PrismaPg } from "@prisma/adapter-pg"

import { PrismaClient } from "@/prisma/client"
import { DEFAULT_TRANSACTION_OPTIONS, poolConfig } from "./db"

const globalForAuthPrisma = globalThis as unknown as {
  authPrisma: PrismaClient | undefined
}

let avisado = false

/**
 * URL del camino de autenticación. En producción apunta a `app_auth`; en local
 * y CI, si no está declarada, al mismo destino que `DATABASE_URL`.
 */
export function authDatabaseUrl(): string | undefined {
  const declared = process.env.AUTH_DATABASE_URL
  if (declared !== undefined && declared.trim() !== "") return declared
  if (!avisado && process.env.NODE_ENV !== "test") {
    avisado = true
    console.warn(
      "[auth] AUTH_DATABASE_URL no está definida: el camino de autenticación usará DATABASE_URL. " +
        "Con RLS en `users` (ADR-0015 D5), `app_runtime` no puede dar de alta usuarios y el alta fallará " +
        "con «permission denied». Declara AUTH_DATABASE_URL con el rol `app_auth`."
    )
  }
  return process.env.DATABASE_URL
}

function createAuthPrismaClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: authDatabaseUrl(), ...poolConfig() })
  return new PrismaClient({ adapter, transactionOptions: { ...DEFAULT_TRANSACTION_OPTIONS } })
}

/**
 * Cliente del camino de autenticación. **Sólo** `users`, `sessions`, `account`
 * y `verification`: cualquier otra tabla no la puede leer ni escribir, porque
 * `app_auth` no tiene privilegio sobre ella.
 */
export const authPrisma: PrismaClient = globalForAuthPrisma.authPrisma ?? createAuthPrismaClient()

if (process.env.NODE_ENV !== "production") globalForAuthPrisma.authPrisma = authPrisma
