/**
 * Resolución de URLs de base de datos para los tests (ronda 2, hallazgo #5).
 *
 * El prefijo `DATABASE_URL_TEST=…` que llevaba el script `test:integration`
 * PISABA la variable que inyecta CI (donde Postgres va con contraseña), de modo
 * que en CI la suite intentaba conectar a un servidor sin credenciales. Ahora el
 * script no lleva prefijo: la variable manda y sólo se aplica un valor por
 * defecto de desarrollo cuando no está definida.
 */

/** BD de pruebas local por defecto. Sólo se usa si `DATABASE_URL_TEST` no está. */
export const DEFAULT_TEST_DATABASE_URL = "postgresql://postgres@localhost:5432/erp_test"

/** URL del rol PROPIETARIO (migraciones y fixtures). */
export function ownerDatabaseUrl(): string {
  return process.env.DATABASE_URL_TEST || DEFAULT_TEST_DATABASE_URL
}

/** Contraseña del rol de runtime; la fija `scripts/dev-db-setup.sh` en local y CI. */
export function appRuntimePassword(): string {
  return process.env.APP_RUNTIME_PASSWORD || "app_runtime"
}

/** Misma base que `ownerDatabaseUrl()` pero con el rol `app_runtime` (NOBYPASSRLS). */
export function appRuntimeDatabaseUrl(base: string = ownerDatabaseUrl()): string {
  const url = new URL(base)
  url.username = "app_runtime"
  url.password = appRuntimePassword()
  return url.toString()
}

/** Contraseña del rol de mantenimiento (ADR-0009 §6); la fija `scripts/dev-db-setup.sh`. */
export function appMaintenancePassword(): string {
  return process.env.APP_MAINTENANCE_PASSWORD || "app_maintenance"
}

/**
 * Misma base que `ownerDatabaseUrl()` pero con el rol `app_maintenance`
 * (BYPASSRLS). Es lo que consume `DATABASE_URL_MAINTENANCE`: los scripts de
 * operador y el check de I10, nunca la aplicación.
 */
export function appMaintenanceDatabaseUrl(base: string = ownerDatabaseUrl()): string {
  const url = new URL(base)
  url.username = "app_maintenance"
  url.password = appMaintenancePassword()
  return url.toString()
}
