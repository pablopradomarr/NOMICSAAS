import { execFileSync } from "node:child_process"
import { Client } from "pg"
import { appRuntimePassword, ownerDatabaseUrl } from "./tests/support/env"

/**
 * Aplica las migraciones con el rol propietario y da credencial al rol de
 * runtime (las migraciones ya no fijan contraseñas: ronda 2, #8), de forma que
 * la suite pueda conectar como `app_runtime` y ejercer RLS de verdad.
 */
export default async function setup() {
  if (!process.env.DATABASE_URL_TEST && process.env.CI === "true") {
    throw new Error("DATABASE_URL_TEST no está definida: la suite de RLS es obligatoria en CI")
  }
  const owner = ownerDatabaseUrl()

  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: owner, DIRECT_URL: owner },
    stdio: "inherit",
  })

  const client = new Client({ connectionString: owner })
  await client.connect()
  try {
    await client.query(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
           CREATE ROLE app_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
         END IF;
       END $$;`
    )
    await client.query(`ALTER ROLE app_runtime WITH LOGIN NOBYPASSRLS PASSWORD '${appRuntimePassword()}'`)
    await client.query(`GRANT USAGE ON SCHEMA public TO app_runtime`)
    // Los privilegios de tabla los conceden LAS MIGRACIONES (E1 sobre todas las
    // tablas + `ALTER DEFAULT PRIVILEGES` para las que nazcan después). El
    // `GRANT … ON ALL TABLES` que había aquí volvía a conceder UPDATE y DELETE
    // sobre `audit_logs` justo después de que la migración de E2 los revocara,
    // de modo que la suite no podía comprobar el append-only a nivel de
    // privilegio y el entorno de test divergía del real (revisión, hallazgo 1).
  } finally {
    await client.end()
  }
}
