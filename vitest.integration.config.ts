import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  test: {
    environment: "node",
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
