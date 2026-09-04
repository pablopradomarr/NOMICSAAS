import { execFileSync } from "node:child_process"

/**
 * Global setup de los tests de integración: aplica las migraciones a la BD de
 * pruebas indicada por DATABASE_URL_TEST antes de ejecutar la suite.
 *
 * E1-fix (#10): en CI la ausencia de `DATABASE_URL_TEST` era un simple aviso, de
 * modo que los tests de fuga entre tenants se SALTABAN en silencio y el
 * pipeline salía verde sin haber comprobado el aislamiento. En CI ahora FALLA.
 * En local sigue avisando: no todo el mundo tiene Postgres levantado.
 */
export default function setup() {
  const url = process.env.DATABASE_URL_TEST
  if (!url) {
    if (process.env.CI === "true") {
      throw new Error(
        "DATABASE_URL_TEST no está definida: en CI los tests de integración son obligatorios " +
          "(los tests de fuga entre tenants y de migración no pueden saltarse). " +
          "Define DATABASE_URL_TEST apuntando a la base de pruebas."
      )
    }
    console.warn("[integration] DATABASE_URL_TEST no definida: los tests de BD se saltarán")
    return
  }
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
    stdio: "inherit",
  })
}
