import { defineConfig, devices } from "@playwright/test"
import { existsSync, readdirSync } from "node:fs"
import path from "node:path"

/**
 * E13 · T14 — configuración de los e2e de auth (docs/design/E13-autenticacion.md §8.3).
 *
 * Fichero de configuración SEPARADO de `playwright.config.ts` a propósito: los e2e
 * actuales corren en `SELF_HOSTED_MODE=true` y no se tocan; esta suite necesita lo
 * contrario (`SELF_HOSTED_MODE=false`, `DISABLE_SIGNUP=true`) y mezclar los dos
 * modos en un mismo config obligaría a reiniciar el servidor entre proyectos.
 * Puerto propio (7332) para poder correr ambas suites en paralelo sin chocar.
 */
const BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers"

function resolveChromium(): string | undefined {
  if (!existsSync(BROWSERS_PATH)) return undefined
  const candidates = readdirSync(BROWSERS_PATH)
    .filter((entry) => entry.startsWith("chromium-"))
    .sort()
    .reverse()
  for (const candidate of candidates) {
    const binary = path.join(BROWSERS_PATH, candidate, "chrome-linux", "chrome")
    if (existsSync(binary)) return binary
  }
  return undefined
}

const PORT = 7332
const baseURL = process.env.E2E_AUTH_BASE_URL || `http://localhost:${PORT}`

export default defineConfig({
  testDir: "./tests/e2e/auth",
  outputDir: "./tests/e2e/auth/.artifacts",
  globalSetup: "./tests/e2e/auth/global-setup.ts",
  // Compilación en frío de `next dev` (Turbopack): la primera visita a cada ruta
  // nueva puede tardar 30-90 s (docs/ESTADO.md, "e2e en un sandbox saturado").
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  use: {
    baseURL,
    locale: "es-ES",
    timezoneId: "Europe/Madrid",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 950 },
        launchOptions: {
          executablePath: resolveChromium(),
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
        },
      },
    },
  ],
  webServer: {
    command: `SELF_HOSTED_MODE=false DISABLE_SIGNUP=true BASE_URL=${baseURL} npx next dev -p ${PORT} --turbopack`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
