import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  test: {
    environment: "node",
    // Vitest expone BASE_URL="/" (de Vite) y lib/config exige una URL absoluta.
    env: { BASE_URL: process.env.BASE_URL?.startsWith("http") ? process.env.BASE_URL : "http://localhost:7331" },
    include: [
      "ai/**/*.test.ts",
      "lib/**/*.test.ts",
      "forms/**/*.test.ts",
      "models/**/*.test.ts",
      "components/**/*.test.tsx",
      /**
       * **BLOQUEA 2 / H-2 de la ronda 1.** `scripts/**` faltaba, y con él el
       * único control que protege la independencia del auditor
       * (`scripts/audit-reconstruct.imports.test.ts`, criterio 14 e I-E12-2):
       * el fichero existía, pasaba a mano y **no lo ejecutaba nadie**. Con la
       * enmienda E-1 —un control sin llamante no cuenta como implementado— eso
       * dejaba en FAIL la afirmación central de la épica. Ahora corre en
       * `npm run test`, y además como paso propio del job 6 de CI.
       */
      "scripts/**/*.test.ts",
    ],
  },
  resolve: {
    alias: [
      // `server-only` es un centinela de Next sin implementación instalada: en
      // vitest se resuelve a un módulo vacío para poder probar los ficheros de
      // servidor que lo declaran (T13).
      { find: /^server-only$/, replacement: path.resolve(__dirname, "tests/support/server-only.ts") },
      { find: /^@\/prisma\/client$/, replacement: path.resolve(__dirname, "prisma/client/client.ts") },
      { find: /^@\//, replacement: path.resolve(__dirname, ".") + "/" },
    ],
  },
})
