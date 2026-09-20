import path from "path"
import { defineConfig } from "vitest/config"
import { DEFAULT_TEST_DATABASE_URL, appMaintenanceDatabaseUrl } from "./tests/support/env"

/**
 * E12 · T1 — Suite de **aceptación** de la capa de fiabilidad
 * (`docs/design/E12-fiabilidad-dod.md` §3.1).
 *
 * Es una suite APARTE de la de integración, y no por gusto:
 *
 *  - **Secuencial y sin paralelismo entre ficheros.** Cada test carga el fixture
 *    completo en una organización efímera propia; en paralelo, siete cargas
 *    simultáneas agotan el pool de Prisma y lo que falla es el arnés, no el
 *    producto (misma lección que `vitest.integration.config.ts`).
 *  - **`GIT_SHA` fijo y explícito.** Sin él el sello sale `REQUIERE REVISIÓN` a
 *    propósito (runbook de E3) y la mitad de los asertos serían falsos negativos.
 *    Se fija aquí, en un sitio, y `harness.ts` lo reexporta: ningún test lo
 *    inventa por su cuenta.
 *  - **`TZ` fija.** La hidratación de fechas ya costó dos incidentes.
 *  - **`DATABASE_URL_MAINTENANCE`**: el vaciado de una organización efímera es
 *    una operación de operador (ADR-0009 §6) y necesita el rol con `BYPASSRLS`.
 *
 * Ejecutar: `npm run test:acceptance`.
 */

const databaseUrl = process.env.DATABASE_URL_TEST || DEFAULT_TEST_DATABASE_URL

export default defineConfig({
  test: {
    environment: "node",
    env: {
      BASE_URL: process.env.BASE_URL?.startsWith("http") ? process.env.BASE_URL : "http://localhost:7331",
      DATABASE_URL_TEST: databaseUrl,
      // La suite conecta con el rol PROPIETARIO salvo donde un test pide otro
      // explícitamente (`app_runtime` para los 42501, `app_maintenance` para el
      // vaciado y las inyecciones sobre copia).
      DATABASE_URL: databaseUrl,
      DATABASE_URL_MAINTENANCE: process.env.DATABASE_URL_MAINTENANCE || appMaintenanceDatabaseUrl(databaseUrl),
      GIT_SHA: process.env.GIT_SHA || "e12acc0",
      TZ: "Europe/Madrid",
    },
    include: ["tests/acceptance/**/*.test.ts"],
    globalSetup: ["./vitest.integration.setup.ts"],
    fileParallelism: false,
    maxConcurrency: 1,
    // El fixture completo son 84 asientos por organización y siete ficheros lo
    // cargan: los `beforeAll` son lentos por diseño, no por descuido.
    testTimeout: 300_000,
    hookTimeout: 900_000,
  },
  resolve: {
    alias: [
      { find: /^server-only$/, replacement: path.resolve(__dirname, "tests/support/server-only.ts") },
      { find: /^@\/prisma\/client$/, replacement: path.resolve(__dirname, "prisma/client/client.ts") },
      { find: /^@\//, replacement: path.resolve(__dirname, ".") + "/" },
    ],
  },
})
