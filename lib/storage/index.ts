/**
 * E11 · T6 — **resolución del almacén, en un solo sitio**.
 *
 * Quien guarda o lee bytes llama a `storage()` y no sabe nada más. La elección
 * del driver es de configuración, y la configuración no se lee en veinte
 * ficheros: se lee aquí.
 *
 * **E11 · integración de olas — los nombres, unificados.** La ola B escribió
 * este módulo contra `STORAGE_DRIVER` y `STORAGE_S3_*` «hasta que T1 aterrice»;
 * la ola A declaró en `lib/config.ts` `STORAGE_BACKEND`, `STORAGE_ENDPOINT`,
 * `STORAGE_REGION`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID` y
 * `STORAGE_SECRET_ACCESS_KEY`. Dos juegos de variables para una sola cosa es
 * cómo se despliega una instalación que cree tener S3 y escribe en `/tmp`.
 * **Manda el de `.env.example`** (el de la ola A); los de la ola B se siguen
 * leyendo como alias para no romper un entorno ya configurado.
 *
 * **Por defecto, `local`.** Un despliegue que se olvide de configurar S3 escribe
 * en disco y lo dice en el `backend` de cada `StoredObject`; lo que no puede
 * pasar es que escriba en un bucket que nadie declaró.
 */

import path from "node:path"
import type { StorageBackend } from "@/prisma/client"
import type { StorageDriver } from "./driver"
import { normalizePrefix } from "./keys"
import { LocalDriver } from "./local"
import { S3Driver, type S3Config } from "./s3"

export * from "./driver"
export * from "./keys"
export { LocalDriver } from "./local"
export { S3Driver } from "./s3"

export type StorageConfig =
  | { driver: "local"; prefix: string; root: string }
  | { driver: "s3"; prefix: string; s3: S3Config }

/** El primero de los alias que traiga valor. Canónico primero. */
function firstOf(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]
    if (value && value.trim() !== "") return value.trim()
  }
  return undefined
}

export function storageConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const prefix = normalizePrefix(env.STORAGE_PREFIX)
  const driver = (firstOf(env, "STORAGE_BACKEND", "STORAGE_DRIVER") ?? "local").toLowerCase()
  if (driver === "s3" || driver === "supabase") {
    const need = (canonical: string, legacy: string): string => {
      const value = firstOf(env, canonical, legacy)
      if (!value) throw new Error(`STORAGE_BACKEND=${driver} exige ${canonical}`)
      return value
    }
    return {
      driver: "s3",
      prefix,
      s3: {
        endpoint: need("STORAGE_ENDPOINT", "STORAGE_S3_ENDPOINT"),
        region: need("STORAGE_REGION", "STORAGE_S3_REGION"),
        bucket: need("STORAGE_BUCKET", "STORAGE_S3_BUCKET"),
        accessKeyId: need("STORAGE_ACCESS_KEY_ID", "STORAGE_S3_ACCESS_KEY_ID"),
        secretAccessKey: need("STORAGE_SECRET_ACCESS_KEY", "STORAGE_S3_SECRET_ACCESS_KEY"),
        forcePathStyle: (env.STORAGE_S3_FORCE_PATH_STYLE ?? "true") !== "false",
        backend: driver === "supabase" ? ("SUPABASE" as StorageBackend) : ("S3" as StorageBackend),
      },
    }
  }
  if (driver !== "local") {
    throw new Error(`STORAGE_BACKEND no admitido: ${driver} (local | s3 | supabase)`)
  }
  // Mismo raíz que el almacén heredado: la migración de T7 mueve los objetos
  // dentro de él y un self-hosted no tiene que mover un byte de sitio.
  const root = env.STORAGE_LOCAL_ROOT ?? env.UPLOAD_PATH ?? "./uploads"
  return { driver: "local", prefix, root: path.isAbsolute(root) ? root : path.resolve(root) }
}

export function buildStorageDriver(config: StorageConfig = storageConfig()): StorageDriver {
  return config.driver === "local" ? new LocalDriver(config.root) : new S3Driver(config.s3)
}

let cached: { driver: StorageDriver; prefix: string } | null = null

/** El almacén del proceso. Memoizado: construirlo no toca la red. */
export function storage(): { driver: StorageDriver; prefix: string } {
  if (!cached) {
    const config = storageConfig()
    cached = { driver: buildStorageDriver(config), prefix: config.prefix }
  }
  return cached
}

/**
 * **Inyección explícita para tests y scripts** (mismo patrón que el arreglo de
 * H-3 de E8: `readStoredFile` se inyecta, no se parchea). La suite instala un
 * `LocalDriver` sobre un directorio temporal y nunca abre una conexión de red.
 */
export function setStorage(driver: StorageDriver, prefix = normalizePrefix(process.env.STORAGE_PREFIX)): void {
  cached = { driver, prefix }
}

export function resetStorage(): void {
  cached = null
}
