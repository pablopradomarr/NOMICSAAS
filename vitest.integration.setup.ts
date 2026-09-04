import { execFileSync } from "node:child_process"
import { DEFAULT_TEST_DATABASE_URL } from "./tests/support/env"

/**
 * Global setup de los tests de integración: aplica las migraciones a la base de
 * pruebas antes de ejecutar la suite.
 *
 * E1-fix (#10): en CI la ausencia de `DATABASE_URL_TEST` era un simple aviso, de
 * modo que los tests de fuga entre tenants se SALTABAN en silencio y el pipeline
 * salía verde sin haber comprobado el aislamiento. En CI ahora FALLA.
 *
 * Ronda 2 (#5): la URL sale del ENTORNO (la de CI lleva contraseña); el valor de
 * desarrollo es sólo un default, ya no un prefijo en el script de npm que pisaba
 * la variable.
 */
export default function setup() {
  if (!process.env.DATABASE_URL_TEST && process.env.CI === "true") {
    throw new Error(
      "DATABASE_URL_TEST no está definida: en CI los tests de integración son obligatorios " +
        "(los tests de fuga entre tenants y de migración no pueden saltarse). " +
        "Define DATABASE_URL_TEST apuntando a la base de pruebas."
    )
  }
  const url = process.env.DATABASE_URL_TEST || DEFAULT_TEST_DATABASE_URL
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
    stdio: "inherit",
  })
}
