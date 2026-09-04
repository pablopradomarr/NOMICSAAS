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
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime`)
  } finally {
    await client.end()
  }
}
