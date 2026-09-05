/**
 * Conexión de MANTENIMIENTO — rol `app_maintenance` (ADR-0009 §6).
 *
 * Es el único rol con `BYPASSRLS` del sistema y existe para lo que
 * legítimamente necesita ver MÁS DE UNA organización:
 *
 *   · scripts de operador (`scripts/migrate-uploads-to-org.ts`, backfills);
 *   · el check del invariante **I10** (`scripts/run-invariants.ts`), que sólo
 *     puede detectar un cruce entre organizaciones si consulta SIN filtro de
 *     tenant — con `tenantDb` el cruce sería invisible por construcción.
 *
 * **La aplicación web NUNCA conecta con este rol.** Este módulo vive fuera de
 * `lib/db.ts` a propósito: nada de `app/` ni de `models/` debe importarlo, y no
 * abre ninguna conexión al importarse (la abre `withMaintenanceClient`, y la
 * cierra siempre).
 *
 * Credencial en `DATABASE_URL_MAINTENANCE`, que el operador entrega aparte. Si
 * no está definida, o si el rol resulta NO tener `BYPASSRLS`, se aborta con un
 * mensaje explícito: un script de mantenimiento que se ejecuta a medias y en
 * silencio (viendo 0 filas por RLS) es peor que uno que no arranca.
 */
import { Client } from "pg"

export class MaintenanceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MaintenanceError"
  }
}

export function maintenanceDatabaseUrl(): string {
  const url = process.env.DATABASE_URL_MAINTENANCE
  if (!url) {
    throw new MaintenanceError(
      "DATABASE_URL_MAINTENANCE no está definida. Este proceso necesita el rol `app_maintenance` " +
        "(BYPASSRLS) porque recorre TODAS las organizaciones; con el rol de la aplicación (`app_runtime`) " +
        "vería 0 filas en silencio. Pídele la credencial al operador " +
        "(en local: APP_MAINTENANCE_PASSWORD=… ./scripts/dev-db-setup.sh)."
    )
  }
  return url
}

export function isMaintenanceConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL_MAINTENANCE)
}

/**
 * Abre una conexión como `app_maintenance`, comprueba que de verdad esquiva RLS
 * y ejecuta `fn`. Cierra la conexión pase lo que pase.
 */
export async function withMaintenanceClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: maintenanceDatabaseUrl() })
  await client.connect()
  try {
    const check = await client.query<{ rolname: string; rolbypassrls: boolean }>(
      `SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    )
    const role = check.rows[0]
    if (!role?.rolbypassrls) {
      throw new MaintenanceError(
        `DATABASE_URL_MAINTENANCE conecta como \`${role?.rolname ?? "?"}\`, que NO tiene BYPASSRLS. ` +
          "Con RLS estricta (ADR-0009) este proceso vería 0 filas y daría por bueno un barrido vacío. " +
          "Apunta la variable al rol `app_maintenance`."
      )
    }
    return await fn(client)
  } finally {
    await client.end()
  }
}
