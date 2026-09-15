/**
 * E11 · T6 — **resolución del almacén, en un solo sitio**.
 *
 * Quien guarda o lee bytes llama a `storage()` y no sabe nada más. La elección
 * del driver es de configuración, y la configuración no se lee en veinte
 * ficheros: se lee aquí.
 *
 * `lib/config.ts` es de la **ola A** (T1), así que este módulo no lo toca: lee
 * `process.env` con los mismos nombres que T1 declarará (`STORAGE_DRIVER`,
 * `STORAGE_PREFIX`, `STORAGE_S3_*`) y, cuando T1 aterrice, bastará con que
 * `storageConfig()` los tome de `config.storage`. El contrato no cambia.
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

function required(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === "") {
    throw new Error(`STORAGE_DRIVER=s3 exige ${name}`)
  }
  return value.trim()
}

export function storageConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const prefix = normalizePrefix(env.STORAGE_PREFIX)
  const driver = (env.STORAGE_DRIVER ?? "local").trim().toLowerCase()
  if (driver === "s3" || driver === "supabase") {
    return {
      driver: "s3",
      prefix,
      s3: {
        endpoint: required("STORAGE_S3_ENDPOINT"),
        region: required("STORAGE_S3_REGION"),
        bucket: required("STORAGE_S3_BUCKET"),
        accessKeyId: required("STORAGE_S3_ACCESS_KEY_ID"),
        secretAccessKey: required("STORAGE_S3_SECRET_ACCESS_KEY"),
        forcePathStyle: (env.STORAGE_S3_FORCE_PATH_STYLE ?? "true") !== "false",
        backend: driver === "supabase" ? ("SUPABASE" as StorageBackend) : ("S3" as StorageBackend),
      },
    }
  }
  if (driver !== "local") {
    throw new Error(`STORAGE_DRIVER no admitido: ${driver} (local | s3 | supabase)`)
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
