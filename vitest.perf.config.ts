import path from "path"
import { defineConfig } from "vitest/config"

import { DEFAULT_TEST_DATABASE_URL } from "./tests/support/env"

/**
 * E12 · T17 — la suite de **rendimiento con volumen real** (§12 de E11, techos
 * 3, 5, 6 y 8; §8 del diseño de E12).
 *
 * Va aparte de `test:integration`, y no por gusto: siembra el fixture
 * `gran-volumen` —50 000 asientos, 150 000 líneas, 2 000 documentos / 1,5 GB y
 * 50 organizaciones—, tarda unos seis minutos y deja la base con *bloat* aunque
 * borre sus filas al terminar. Metida en la pasada de cada PR, lo que rompe no
 * es ella: es el techo de `perf-audit`, que mide **conexiones simultáneas** y
 * por tanto depende de lo que tarde cada consulta sobre una base cargada.
 *
 * **No se escribe con `mergeConfig` sobre la de integración.** `mergeConfig`
 * CONCATENA los arrays, así que el `include` de la otra seguiría dentro y la
 * suite entera correría también aquí — que es exactamente lo que pasó al
 * intentarlo. Se declara entera: son quince líneas y no mienten.
 *
 * Ejecutar: `npm run test:perf`. En CI, sólo en `push` a `main`.
 */
export default defineConfig({
  test: {
    environment: "node",
    env: {
      BASE_URL: process.env.BASE_URL?.startsWith("http") ? process.env.BASE_URL : "http://localhost:7331",
      DATABASE_URL_TEST: process.env.DATABASE_URL_TEST || DEFAULT_TEST_DATABASE_URL,
    },
    include: ["tests/integration/perf-platform.test.ts"],
    globalSetup: ["./vitest.integration.setup.ts"],
    fileParallelism: false,
    maxConcurrency: 1,
    testTimeout: 3_600_000,
    hookTimeout: 600_000,
  },
  resolve: {
    alias: [
      { find: /^server-only$/, replacement: path.resolve(__dirname, "tests/support/server-only.ts") },
      { find: /^@\/prisma\/client$/, replacement: path.resolve(__dirname, "prisma/client/client.ts") },
      { find: /^@\//, replacement: path.resolve(__dirname, ".") + "/" },
    ],
  },
})
