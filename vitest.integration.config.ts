import { defineConfig } from "vitest/config"
import path from "path"
import { DEFAULT_TEST_DATABASE_URL } from "./tests/support/env"

export default defineConfig({
  test: {
    environment: "node",
    // Vitest expone BASE_URL="/" (de Vite) y lib/config exige una URL absoluta.
    env: {
      BASE_URL: process.env.BASE_URL?.startsWith("http") ? process.env.BASE_URL : "http://localhost:7331",
      // Ronda 2 (#5): la variable de CI manda; el default sólo cubre el local.
      DATABASE_URL_TEST: process.env.DATABASE_URL_TEST || DEFAULT_TEST_DATABASE_URL,
    },
    include: ["lib/**/*.test.ts", "forms/**/*.test.ts", "models/**/*.test.ts", "tests/integration/**/*.test.ts"],
    globalSetup: ["./vitest.integration.setup.ts"],
    fileParallelism: false,
  },
  resolve: {
    alias: [
      { find: /^@\/prisma\/client$/, replacement: path.resolve(__dirname, "prisma/client/client.ts") },
      { find: /^@\//, replacement: path.resolve(__dirname, ".") + "/" },
    ],
  },
})
