import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  test: {
    environment: "node",
    // Vitest expone BASE_URL="/" (de Vite) y lib/config exige una URL absoluta.
    env: { BASE_URL: process.env.BASE_URL?.startsWith("http") ? process.env.BASE_URL : "http://localhost:7331" },
    include: ["ai/**/*.test.ts", "lib/**/*.test.ts", "forms/**/*.test.ts", "models/**/*.test.ts"],
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
