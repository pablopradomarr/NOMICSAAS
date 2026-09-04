import { execFileSync } from "node:child_process"

/**
 * Global setup de los tests de integración: aplica las migraciones a la BD de
 * pruebas indicada por DATABASE_URL_TEST antes de ejecutar la suite.
 */
export default function setup() {
  const url = process.env.DATABASE_URL_TEST
  if (!url) {
    console.warn("[integration] DATABASE_URL_TEST no definida: los tests de BD se saltarán")
    return
  }
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  })
}
