import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { Client } from "pg"
import type { BrowserContext, Page } from "@playwright/test"

/**
 * E2 · T13 — sesión para los tests de extremo a extremo.
 *
 * En `SELF_HOSTED_MODE` (el modo de desarrollo de este repositorio) la app
 * resuelve el usuario local sin pasar por better-auth: no hay nada que iniciar.
 * Fuera de ese modo se SIEMBRA una sesión de better-auth directamente en la
 * base y se planta su cookie, para no depender del correo del código OTP.
 *
 * En ambos casos el objetivo es el mismo: que el smoke pruebe el plan de
 * cuentas, no el buzón de correo. El login real lo cubre `login.spec.ts` cuando
 * la instalación no es self-hosted.
 */

/**
 * Entorno EFECTIVO de la aplicación bajo prueba: el fichero `.env` que Next
 * carga al arrancar, más lo que ya venga en `process.env` (que manda, igual que
 * en Next). Playwright no carga `.env` por su cuenta, así que sin esto el
 * helper leía un entorno VACÍO y no el de la app que está probando.
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

/**
 * Entorno efectivo de la aplicación bajo prueba, para los tests que necesitan
 * un valor concreto (p. ej. `BETTER_AUTH_SECRET`, con el que se firma la cookie
 * de organización activa).
 */
export const APP_ENV: Readonly<Record<string, string>> = ENV

/**
 * Conexión de INSPECCIÓN de los tests, no la de la aplicación.
 *
 * E3 (ADR-0009): desde la RLS estricta, `DATABASE_URL` apunta al rol
 * `app_runtime` también en local — que es lo que hace que el smoke ejercite de
 * verdad la barrera 2. Ese rol, sin `app.current_org` fijado, no ve NADA: un
 * `SELECT … FROM audit_logs` de comprobación devolvería 0 filas y el test
 * fallaría por la razón equivocada. Las lecturas y siembras del arnés van, por
 * tanto, por el rol PROPIETARIO (`DIRECT_URL`), igual que `DATABASE_URL_OWNER`
 * en la suite `test:integration:rls`.
 */
export const DATABASE_URL =
  ENV.DIRECT_URL || ENV.DATABASE_URL_OWNER || ENV.DATABASE_URL || "postgresql://postgres@localhost:5432/erp"

/**
 * Modo de la instalación, resuelto con la MISMA regla y la misma fuente que
 * `lib/config` (`SELF_HOSTED_MODE`, con `"true"` por defecto).
 *
 * Antes se leía `process.env.SELF_HOSTED_MODE` a secas: como Playwright no
 * carga `.env`, una instalación con `SELF_HOSTED_MODE=false` se veía aquí como
 * self-hosted, el helper NO sembraba sesión, la app mandaba el smoke a `/enter`
 * y el fallo se leía como «no encuentro la cuenta 430» en vez de «no hay
 * sesión» (revisión, hallazgo 14).
 *
 * No se importa `lib/config` directamente porque arrastra `package.json` con un
 * `import` sin atributo `type: json`, que el cargador ESM de Playwright rechaza
 * («Module … needs an import attribute») y deja la suite entera sin tests.
 */
export const IS_SELF_HOSTED = (ENV.SELF_HOSTED_MODE ?? "true") === "true"

export async function withDb<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: DATABASE_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/**
 * SIEMBRA el entorno mínimo de la base de desarrollo, en vez de darlo por hecho
 * (revisión E5 ronda 1): el usuario global de `SELF_HOSTED_MODE`
 * (`taxhacker@localhost`), su organización personal, su membresía ADMIN y los
 * valores por defecto.
 *
 * Sin esto, una base sin ese usuario mandaba la suite al asistente «TaxHacker:
 * Self-Hosted Edition» y el primer `expect` fallaba con un mensaje que no decía
 * nada del problema real. Es IDEMPOTENTE y se ejecuta una sola vez por proceso.
 * Va por `npx tsx` porque necesita el código de la aplicación y el cargador ESM
 * de Playwright no puede importarlo.
 */
type SelfHostedSeed = { userId: string; organizationId: string; analyticsOrganizationId: string }

let selfHostedSeed: SelfHostedSeed | null = null

export function ensureSelfHostedSeed(): SelfHostedSeed {
  if (selfHostedSeed) return selfHostedSeed
  const out = execFileSync("npx", ["tsx", "tests/support/ensure-self-hosted.ts"], {
    // El script escribe con el rol PROPIETARIO: crea organización, membresía y
    // catálogos, cosas que `app_runtime` no puede hacer sin organización activa.
    env: { ...process.env, DATABASE_URL, DIRECT_URL: DATABASE_URL, PRISMA_LOG: "" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  })
  const line = out.trim().split("\n").filter((l) => l.trim().startsWith("{")).pop()
  if (!line) throw new Error(`El arnés no ha podido sembrar el usuario self-hosted: ${out.slice(-500)}`)
  selfHostedSeed = JSON.parse(line) as SelfHostedSeed
  return selfHostedSeed
}

/** Correo del usuario con el que corre el smoke. ADMIN de la organización. */
export async function adminUserId(): Promise<string> {
  const seed = ensureSelfHostedSeed()
  return await withDb(async (client) => {
    const { rows } = await client.query<{ user_id: string }>(
      `SELECT m.user_id
         FROM memberships m
         JOIN organizations o ON o.id = m.organization_id
        WHERE m.role = 'ADMIN'
        ORDER BY o.created_at ASC
        LIMIT 1`
    )
    // Sin ADMIN no se lanza: se devuelve el usuario SEMBRADO. Las suites que
    // degradan el rol para probar el VIEWER (`setRole`) dejan la base sin ningún
    // ADMIN mientras dura el test, y el `finally` que restaura el rol volvía a
    // pedir el ADMIN — que ya no existía— y moría sin restaurar nada.
    return rows.length > 0 ? rows[0].user_id : seed.userId
  })
}

/**
 * La organización sobre la que corren los e2e que cargan fixtures: la que más
 * líneas con proyecto tiene y, si todavía no hay ninguna (base recién sembrada),
 * la organización `e2e-analitica` que siembra el arnés — que es donde el
 * `beforeAll` de cada suite carga el fixture. Antes lanzaba «Ninguna
 * organización tiene analítica cargada» y obligaba a preparar la base a mano.
 */
export async function analyticsOrganization(): Promise<{ id: string; name: string }> {
  const seed = ensureSelfHostedSeed()
  return await withDb(async (client) => {
    const { rows } = await client.query<{ id: string; name: string }>(
      `SELECT o.id, o.name
         FROM organizations o
         JOIN journal_lines l ON l.organization_id = o.id AND l.project_id IS NOT NULL
        WHERE o.is_active
        GROUP BY o.id, o.name
        ORDER BY count(*) DESC
        LIMIT 1`
    )
    if (rows.length > 0) return rows[0]
    const personal = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM organizations WHERE id = $1`,
      [seed.analyticsOrganizationId]
    )
    if (personal.rows.length === 0) {
      throw new Error("El arnés ha sembrado el entorno pero no encuentra la organización analítica")
    }
    return personal.rows[0]
  })
}

/**
 * Inserta una sesión de better-auth y la deja lista en el contexto del
 * navegador. Sólo se usa fuera de `SELF_HOSTED_MODE`.
 */
export async function seedSession(context: BrowserContext, baseURL: string): Promise<void> {
  const userId = await adminUserId()
  const token = randomUUID().replace(/-/g, "")
  await withDb(async (client) => {
    await client.query(
      `INSERT INTO sessions (id, token, expires_at, created_at, updated_at, user_id)
       VALUES ($1, $2, now() + interval '1 day', now(), now(), $3)`,
      [randomUUID(), token, userId]
    )
  })
  const url = new URL(baseURL)
  await context.addCookies([
    {
      name: "taxhacker.session_token",
      value: token,
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ])
}

/** Deja la página autenticada, sea cual sea el modo de la instalación. */
export async function signIn(page: Page, baseURL: string): Promise<void> {
  if (!IS_SELF_HOSTED) await seedSession(page.context(), baseURL)
}
