import { defineConfig } from "vitest/config"
import path from "path"
import { appAuthDatabaseUrl, appMaintenanceDatabaseUrl, appRuntimeDatabaseUrl, ownerDatabaseUrl } from "./tests/support/env"

/**
 * Suite de RLS EFECTIVA (ronda 2, hallazgo #6).
 *
 * `vitest.integration.config.ts` conecta como PROPIETARIO de las tablas, que en
 * local es además superusuario: Postgres le deja saltarse cualquier política, de
 * modo que aquella suite no ejerce RLS en absoluto y daba verde con políticas
 * rotas. Esta variante apunta `DATABASE_URL` —la que lee `lib/db.ts` al
 * importarse— al rol `app_runtime` (LOGIN, NOBYPASSRLS, no propietario), que es
 * con el que la aplicación conecta en producción, y ejecuta el código REAL de
 * `models/` contra él.
 */
export default defineConfig({
  test: {
    environment: "node",
    env: {
      BASE_URL: process.env.BASE_URL?.startsWith("http") ? process.env.BASE_URL : "http://localhost:7331",
      // Lo que ve `lib/db.ts`: el rol de runtime, sujeto a las políticas.
      DATABASE_URL: appRuntimeDatabaseUrl(),
      // Para fixtures y limpieza (usuarios y datos pre-tenant).
      DATABASE_URL_OWNER: ownerDatabaseUrl(),
      // Rol de mantenimiento (BYPASSRLS): scripts de operador e I10, ADR-0009 §6.
      DATABASE_URL_MAINTENANCE: appMaintenanceDatabaseUrl(),
      // E7 · T14 (ADR-0015 D5): el camino de autenticación conecta con `app_auth`.
      AUTH_DATABASE_URL: appAuthDatabaseUrl(),
    },
    include: ["tests/integration-rls/**/*.test.ts"],
    globalSetup: ["./vitest.integration.rls.setup.ts"],
    fileParallelism: false,
  },
  resolve: {
    alias: [
      { find: /^@\/prisma\/client$/, replacement: path.resolve(__dirname, "prisma/client/client.ts") },
      { find: /^@\//, replacement: path.resolve(__dirname, ".") + "/" },
    ],
  },
})
