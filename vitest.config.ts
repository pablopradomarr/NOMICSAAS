import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  test: {
    environment: "node",
    // Vitest expone BASE_URL="/" (de Vite) y lib/config exige una URL absoluta.
    env: { BASE_URL: process.env.BASE_URL?.startsWith("http") ? process.env.BASE_URL : "http://localhost:7331" },
    include: ["lib/**/*.test.ts", "forms/**/*.test.ts", "models/**/*.test.ts"],
  },
  resolve: {
    alias: [
      { find: /^@\/prisma\/client$/, replacement: path.resolve(__dirname, "prisma/client/client.ts") },
      { find: /^@\//, replacement: path.resolve(__dirname, ".") + "/" },
    ],
  },
})
