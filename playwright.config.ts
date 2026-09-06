import { defineConfig, devices } from "@playwright/test"
import { existsSync, readdirSync } from "node:fs"
import path from "node:path"

/**
 * E2 · T13 (resto de E0) — configuración de los tests de extremo a extremo.
 *
 * Los navegadores viven fuera del proyecto (`PLAYWRIGHT_BROWSERS_PATH`), y la
 * revisión instalada no tiene por qué coincidir con la que espera esta versión
 * de Playwright: por eso se resuelve el ejecutable a mano y se le pasa por
 * `executablePath`, que salta la comprobación de revisión. Si el navegador no
 * está donde se espera, Playwright usa el suyo.
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

const baseURL = process.env.E2E_BASE_URL || "http://localhost:7331"

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./tests/e2e/.artifacts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  use: {
    baseURL,
    locale: "es-ES",
    timezoneId: "Europe/Madrid",
    // Las capturas que toman los specs pasan `caret: "initial"` (ver
    // `tests/e2e/*.spec.ts`): con el valor por defecto (`hide`) Playwright
    // inyecta `style="caret-color: transparent"` en los `input` del DOM y, en
    // modo dev, React lo denuncia como desajuste de hidratación en la siguiente
    // navegación. Los specs que comprueban «cero errores de consola» fallaban de
    // forma intermitente por un artefacto del arnés, no por la aplicación.
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
  // El servidor de desarrollo ya arrancado se reutiliza; si no lo hay, se levanta.
  webServer: {
    command: "npm run dev",
    url: baseURL,
    reuseExistingServer: true,
    timeout: 180_000,
  },
})
