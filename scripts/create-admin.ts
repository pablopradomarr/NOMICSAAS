/**
 * E13 · T13 — Primer ADMIN de un despliegue (docs/design/E13-autenticacion.md §8.1 criterio 13,
 * riesgo R1). Necesario antes de pasar el preview a `SELF_HOSTED_MODE=false`: hasta entonces
 * ningún usuario tiene contraseña (§2.3) y `signIn.email` rechaza a todos por igual.
 *
 * Crea (o repara) un usuario con contraseña, su organización personal y su membresía ADMIN,
 * reutilizando exactamente el camino de alta cloud (`getOrCreateCloudUser` →
 * `ensurePersonalOrganization` + `createOrganizationDefaults`, `models/users.ts`), NUNCA una
 * implementación paralela.
 *
 * La contraseña JAMÁS se acepta como argumento (quedaría en el historial del shell y en
 * `ps`): sólo por `ADMIN_PASSWORD` o por un prompt oculto en una TTY interactiva.
 *
 * Idempotente (criterio 13): ejecutarlo dos veces con los mismos argumentos deja UN usuario,
 * UNA organización y UNA membresía ADMIN. Si el usuario ya existe, la contraseña sólo se
 * reescribe con `--reset-password`; sin ese flag el script no toca nada más.
 *
 * Conecta como `app_maintenance` (`DATABASE_URL_MAINTENANCE`, BYPASSRLS, ADR-0009 §6), igual
 * que `scripts/migrate-uploads-to-org.ts`: es un script de operador que se ejecuta antes de que
 * exista ninguna sesión con la que resolver `app.current_org`. Los módulos que abren la
 * conexión se importan DINÁMICAMENTE, después de apuntar `DATABASE_URL` a la credencial de
 * mantenimiento (`lib/db.ts` lee la variable al evaluarse).
 *
 * Uso:
 *   ADMIN_PASSWORD=... DATABASE_URL_MAINTENANCE=... \
 *     npx tsx scripts/create-admin.ts --email admin@empresa.com --name "Nombre Apellido" \
 *                                      [--org "Nombre de la organización"] [--reset-password]
 *
 * Sin ADMIN_PASSWORD, y con la terminal en modo interactivo, la pide dos veces sin eco.
 * Runbook completo (local y Supabase, session pooler): docs/deploy/create-admin.md
 */

import { maintenanceDatabaseUrl } from "@/lib/db-maintenance"
import { authEmailSchema, passwordSchema } from "@/forms/auth"
import type { PrismaClient } from "@/prisma/client"
import * as readline from "node:readline"

const USAGE = `Uso:
  ADMIN_PASSWORD=... DATABASE_URL_MAINTENANCE=... npx tsx scripts/create-admin.ts \\
    --email <email> --name "<nombre>" [--org "<organización>"] [--reset-password]

  --email             obligatorio. Correo del administrador (también su login).
  --name              obligatorio. Nombre visible del usuario.
  --org               opcional. Nombre de la organización personal (por defecto, el nombre).
  --reset-password    opcional. Si el usuario ya existe, reescribe su contraseña.

La contraseña NUNCA se pasa por argumento: variable ADMIN_PASSWORD o prompt oculto (TTY).`

export type CreateAdminArgs = {
  email: string
  name: string
  org: string | null
  resetPassword: boolean
}

/**
 * Parseo puro de `argv` (testeable sin BD ni TTY). Lanza con `USAGE` si faltan
 * obligatorios o si alguien intenta colar `--password` (nunca soportado: es
 * precisamente lo que el diseño prohíbe, §8.1 criterio 13).
 */
export function parseCreateAdminArgs(argv: string[]): CreateAdminArgs {
  if (argv.includes("--password")) {
    throw new Error(
      `La contraseña nunca se pasa por argumento (quedaría en el historial del shell y en \`ps\`). ` +
        `Usa la variable ADMIN_PASSWORD o el prompt oculto.\n\n${USAGE}`
    )
  }

  const value = (flag: string): string | null => {
    const index = argv.indexOf(flag)
    return index >= 0 ? (argv[index + 1] ?? null) : null
  }

  const email = value("--email")
  const name = value("--name")
  const org = value("--org")
  const resetPassword = argv.includes("--reset-password")

  const missing = [!email && "--email", !name && "--name"].filter(Boolean) as string[]
  if (missing.length > 0) {
    throw new Error(`Faltan argumentos obligatorios: ${missing.join(", ")}\n\n${USAGE}`)
  }

  const parsedEmail = authEmailSchema.safeParse(email)
  if (!parsedEmail.success) {
    throw new Error(`--email inválido: ${parsedEmail.error.issues[0]?.message ?? email}`)
  }

  const trimmedName = (name as string).trim()
  if (!trimmedName) {
    throw new Error(`--name no puede estar vacío\n\n${USAGE}`)
  }

  return { email: parsedEmail.data, name: trimmedName, org: org?.trim() || null, resetPassword }
}

/**
 * Decide, de forma pura, si toca escribir un hash nuevo (idempotencia, criterio
 * 13): un usuario nuevo siempre lo necesita; uno existente sólo con
 * `--reset-password`.
 */
export function shouldWritePassword(input: { userExists: boolean; resetPassword: boolean }): boolean {
  return !input.userExists || input.resetPassword
}

/** Oculta el eco de la terminal mientras se escribe: truco estándar sobre `readline`, sin dependencias. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const output = rl as unknown as { _writeToOutput?: (chunk: string) => void }
    const originalWrite = output._writeToOutput?.bind(rl)
    let muted = false
    if (originalWrite) {
      output._writeToOutput = (chunk: string) => {
        if (!muted || chunk.includes("\n") || chunk.includes("\r")) {
          originalWrite(chunk)
        }
      }
    }
    rl.question(question, (answer) => {
      rl.close()
      process.stdout.write("\n")
      resolve(answer)
    })
    muted = true
  })
}

/** `ADMIN_PASSWORD` si está definida; si no, prompt oculto en TTY (nunca `argv`). */
async function resolvePassword(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const fromEnv = env.ADMIN_PASSWORD
  if (fromEnv) return fromEnv

  if (!process.stdin.isTTY) {
    throw new Error(
      "No hay ADMIN_PASSWORD y la entrada no es una terminal interactiva: no se puede pedir la " +
        "contraseña sin eco. Define ADMIN_PASSWORD o ejecuta el script en una TTY."
    )
  }

  const password = await promptHidden("Contraseña del administrador: ")
  const confirm = await promptHidden("Repite la contraseña: ")
  if (password !== confirm) {
    throw new Error("Las contraseñas no coinciden")
  }
  const parsed = passwordSchema.safeParse(password)
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Contraseña inválida")
  }
  return parsed.data
}

type MaintenanceModules = {
  prisma: PrismaClient
  getUserByEmail: (email: string) => Promise<{ id: string; email: string } | null>
  getOrCreateCloudUser: (
    email: string,
    data: { email: string; name: string; emailVerified?: boolean },
    organizationData?: Record<string, unknown>
  ) => Promise<{ id: string; email: string }>
  ensurePersonalOrganization: (
    user: { id: string; email: string; name: string | null },
    now: Date
  ) => Promise<{ id: string; name: string }>
  setUserPassword: (userId: string, plain: string) => Promise<void>
}

/** Conecta como `app_maintenance` y comprueba que de verdad esquiva RLS (mismo patrón que migrate-uploads-to-org.ts). */
async function connectAsMaintenance(): Promise<MaintenanceModules> {
  process.env.DATABASE_URL = maintenanceDatabaseUrl()

  const db = await import("@/lib/db")
  const users = await import("@/models/users")
  const organizations = await import("@/models/organizations")
  const authPassword = await import("@/lib/auth-password")

  const prisma = db.prisma as unknown as PrismaClient
  const rows = await (prisma as unknown as { $queryRaw: <T>(query: TemplateStringsArray) => Promise<T> }).$queryRaw<
    { rolname: string; rolbypassrls: boolean }[]
  >`SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = current_user`
  if (!rows[0]?.rolbypassrls) {
    throw new Error(
      `DATABASE_URL_MAINTENANCE conecta como \`${rows[0]?.rolname ?? "?"}\`, que NO tiene BYPASSRLS. ` +
        "Con RLS estricta (ADR-0009) este script no podría crear la organización personal. " +
        "Apunta la variable al rol `app_maintenance`."
    )
  }

  return {
    prisma,
    getUserByEmail: users.getUserByEmail,
    getOrCreateCloudUser: users.getOrCreateCloudUser as MaintenanceModules["getOrCreateCloudUser"],
    ensurePersonalOrganization: organizations.ensurePersonalOrganization,
    setUserPassword: authPassword.setUserPassword,
  }
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE)
    return
  }

  const args = parseCreateAdminArgs(argv)
  const password = await resolvePassword()

  const { getUserByEmail, getOrCreateCloudUser, ensurePersonalOrganization, setUserPassword } =
    await connectAsMaintenance()

  const existing = await getUserByEmail(args.email)
  const writePassword = shouldWritePassword({ userExists: Boolean(existing), resetPassword: args.resetPassword })

  const user = existing
    ? existing
    : await getOrCreateCloudUser(
        args.email,
        { email: args.email, name: args.name, emailVerified: true },
        args.org ? { name: args.org } : {}
      )

  // Idempotente por diseño: no crea una segunda organización ni una segunda
  // membresía si ya existían (`ensurePersonalOrganization`, models/organizations.ts).
  const organization = await ensurePersonalOrganization({ id: user.id, email: user.email, name: args.name }, new Date())

  if (writePassword) {
    await setUserPassword(user.id, password)
  }

  console.log(
    JSON.stringify(
      {
        email: user.email,
        userId: user.id,
        organizationId: organization.id,
        organizationName: organization.name,
        userCreated: !existing,
        passwordWritten: writePassword,
      },
      null,
      2
    )
  )
}

if (process.argv[1] && process.argv[1].endsWith("create-admin.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
