import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { createHmac, randomUUID } from "node:crypto"
import { Client } from "pg"
import type { Browser, BrowserContext } from "@playwright/test"
import type { CloudAuthSeed } from "@/tests/support/ensure-cloud-auth"

/**
 * E13 · T14 — soporte compartido de los e2e de auth (docs/design/E13-autenticacion.md §8.3).
 *
 * Mismo espíritu que `tests/e2e/session.ts`: nada se da por hecho, todo se lee de lo que
 * sembró `global-setup.ts` o directamente de la base con el rol PROPIETARIO (`DIRECT_URL`),
 * que en local no lleva `FORCE ROW LEVEL SECURITY` aplicada a su propio rol (mismo criterio
 * que `tests/e2e/session.ts`: "las lecturas y siembras del arnés van por el rol PROPIETARIO").
 */

function appEnv(): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const file of [".env", ".env.local"]) {
    const full = path.join(process.cwd(), file)
    if (!existsSync(full)) continue
    for (const line of readFileSync(full, "utf8").split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
      if (!match) continue
      merged[match[1]] = match[2].trim().replace(/^["']|["']$/g, "")
    }
  }
  return { ...merged, ...(process.env as Record<string, string>) }
}

const ENV = appEnv()

export const DATABASE_URL =
  ENV.DIRECT_URL || ENV.DATABASE_URL_OWNER || ENV.DATABASE_URL || "postgresql://postgres@localhost:5432/erp"

export async function withDb<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: DATABASE_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/** Lee la siembra que dejó `global-setup.ts` en `.seed.json`. */
export function readSeed(): CloudAuthSeed {
  const full = path.join(process.cwd(), "tests/e2e/auth/.seed.json")
  if (!existsSync(full)) {
    throw new Error("No hay .seed.json: ¿ha corrido el globalSetup de playwright.auth.config.ts?")
  }
  return JSON.parse(readFileSync(full, "utf8")) as CloudAuthSeed
}

/**
 * Crea un contexto de navegador con una IP simulada propia (`x-forwarded-for`), para que el
 * rate limit de `lib/auth-rate-limit.ts` (por IP) de cada test no se mezcle con el de los
 * demás: sin esto, todas las peticiones del navegador comparten la MISMA ip real
 * (`ipFromHeaders` cae a "unknown" si el navegador no manda la cabecera) y el bucket de 10
 * intentos/10 min de LOGIN_IP_LIMIT se agotaría con la suma de TODOS los specs, no del test
 * que de verdad quiere probar el límite.
 */
export async function newIsolatedContext(browser: Browser, label: string): Promise<BrowserContext> {
  const ip = `10.13.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 200) + 1}`
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": `${ip}-${label}` } })
  return context
}

/** Email exclusivo de un test: evita que dos tests compartan el bucket de rate limit POR EMAIL. */
export function uniqueEmail(label: string): string {
  return `qa-${label}-${randomUUID().slice(0, 8)}@nomic.local`
}

/**
 * Token de reset EN CLARO más reciente para `userId`, leído de `verification`
 * (better-auth: `identifier = "reset-password:<token>"`, `value = userId`) — la misma
 * técnica que documenta §8.3, porque la suite no depende de Resend.
 */
export async function latestResetToken(userId: string): Promise<string> {
  return await withDb(async (client) => {
    const { rows } = await client.query<{ identifier: string }>(
      `SELECT identifier FROM verification
        WHERE identifier LIKE 'reset-password:%' AND value = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [userId]
    )
    if (rows.length === 0) throw new Error(`No hay token de reset en \`verification\` para el usuario ${userId}`)
    return rows[0].identifier.replace(/^reset-password:/, "")
  })
}

export async function sessionCount(userId: string): Promise<number> {
  return await withDb(async (client) => {
    const { rows } = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM sessions WHERE user_id = $1`, [
      userId,
    ])
    return Number(rows[0]?.count ?? 0)
  })
}

/** Inserta una sesión "antigua" directamente en la base, para comprobar que un reset la revoca. */
export async function seedOldSession(userId: string): Promise<string> {
  const token = randomUUID().replace(/-/g, "")
  await withDb(async (client) => {
    await client.query(
      `INSERT INTO sessions (id, token, expires_at, created_at, updated_at, user_id)
       VALUES ($1, $2, now() + interval '1 day', now(), now(), $3)`,
      [randomUUID(), token, userId]
    )
  })
  return token
}

/**
 * Firma el valor de la cookie de sesión EXACTAMENTE como `ctx.setSignedCookie` de better-call
 * (`node_modules/better-auth/node_modules/better-call/dist/{context,crypto}.mjs`): HMAC-SHA256
 * del token con `BETTER_AUTH_SECRET`, en base64 estándar (no url-safe), como `"<token>.<firma>"`.
 *
 * IMPORTANTE (hallazgo de este arnés): `tests/e2e/session.ts::seedSession` — el helper de la
 * suite self-hosted, pensado también para plantar sesión fuera de `SELF_HOSTED_MODE` — NO firma
 * el valor, planta el token en claro. En este sandbox esa rama nunca se ejercita
 * (`SELF_HOSTED_MODE=true` siempre en la suite actual), así que el gap no se había detectado:
 * un `getSignedCookie` sin firma válida devuelve `false`, la sesión no se reconoce y la petición
 * cae como no autenticada. Aquí SÍ importa (esta suite corre en `SELF_HOSTED_MODE=false`), así
 * que `plantSession` firma correctamente; no se toca `tests/e2e/session.ts` (fuera del alcance
 * de E13, y los e2e self-hosted no lo necesitan porque ese modo ni siquiera mira la cookie).
 */
function signSessionCookieValue(token: string, secret: string): string {
  const signature = createHmac("sha256", secret).update(token).digest("base64")
  return `${token}.${signature}`
}

/**
 * Firma la cookie de organización activa igual que `lib/authz-core.ts::signActiveOrgCookie`:
 * `<orgId>.<hmac-sha256(orgId:userId)>` en base64url.
 */
function signActiveOrgCookieValue(organizationId: string, userId: string, secret: string): string {
  const signature = createHmac("sha256", secret)
    .update(`${organizationId}:${userId}`)
    .digest("base64url")
  return `${organizationId}.${signature}`
}

/**
 * Siembra una sesión de better-auth para `userId` y planta su cookie FIRMADA en el contexto. Se
 * usa cuando el test quiere entrar directamente a una pantalla protegida (rol VIEWER, cambio de
 * contraseña) SIN gastar presupuesto del rate limit de `/sign-in/email` (compartido por IP,
 * S1/S3) con un login real que no es lo que ese test está comprobando.
 *
 * Planta TAMBIÉN la cookie de organización activa cuando se pasa `organizationId`: sin ella,
 * `getOrgContext` cae a la membresía [0] del usuario (`getUserMemberships`), y un usuario
 * sembrado con `getOrCreateCloudUser` (como `viewer.e2e@nomic.local`) tiene DOS membresías —
 * la de su propia organización personal (ahí es ADMIN) y la de la organización compartida del
 * arnés (ahí es VIEWER) — así que sin fijar explícitamente la organización, el test podía
 * acabar comprobando el rol equivocado en la organización equivocada.
 */
export async function plantSession(
  context: BrowserContext,
  baseURL: string,
  userId: string,
  organizationId?: string
): Promise<void> {
  const secret = ENV.BETTER_AUTH_SECRET
  if (!secret) throw new Error("BETTER_AUTH_SECRET no está en el entorno: no se puede firmar la cookie de sesión")

  const token = randomUUID().replace(/-/g, "")
  await withDb(async (client) => {
    await client.query(
      `INSERT INTO sessions (id, token, expires_at, created_at, updated_at, user_id)
       VALUES ($1, $2, now() + interval '1 day', now(), now(), $3)`,
      [randomUUID(), token, userId]
    )
  })
  const url = new URL(baseURL)
  const cookies = [
    {
      name: "taxhacker.session_token",
      value: signSessionCookieValue(token, secret),
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax" as const,
    },
  ]
  if (organizationId) {
    cookies.push({
      name: "taxhacker.active_org",
      value: signActiveOrgCookieValue(organizationId, userId, secret),
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax" as const,
    })
  }
  await context.addCookies(cookies)
}

export async function membershipRole(organizationId: string, userId: string): Promise<string | null> {
  return await withDb(async (client) => {
    const { rows } = await client.query<{ role: string }>(
      `SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2`,
      [organizationId, userId]
    )
    return rows[0]?.role ?? null
  })
}

/** Igual que `membershipRole`, pero resolviendo el usuario por email (el id no se conoce de antemano). */
export async function membershipRoleByEmail(organizationId: string, email: string): Promise<string | null> {
  return await withDb(async (client) => {
    const { rows } = await client.query<{ role: string }>(
      `SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1 AND u.email = $2`,
      [organizationId, email.toLowerCase()]
    )
    return rows[0]?.role ?? null
  })
}
