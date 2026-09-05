/**
 * E1-fix (#3) — Migración de disco: `uploads/<email>/…` → `uploads/<orgId>/…`
 *
 * Hasta E1-fix los ficheros se guardaban bajo un directorio derivado del EMAIL
 * del usuario que los subía. Desde E1-fix el sujeto del almacenamiento es la
 * organización. Este script mueve los directorios heredados a su sitio.
 *
 * Cómo decide la organización de destino, FICHERO A FICHERO (ronda 2, #10):
 *   1. El nombre del fichero almacenado es el uuid de su fila en `files`, así que
 *      se resuelve por clave primaria (`files.id`). Si el nombre no es un uuid,
 *      se busca por `path` ACOTANDO por `uploadedById`. Es el único criterio
 *      correcto: un usuario puede pertenecer a varias organizaciones y tener en
 *      su antiguo directorio ficheros de todas ellas (la versión inicial mandaba
 *      el directorio entero a la organización del PRIMER fichero del usuario,
 *      mezclando tenants).
 *   2. Los ficheros que no están en `files` (previews regenerables, `static/`,
 *      restos) van a la organización personal del usuario, o a su única
 *      membresía si no la hubiera.
 *   3. Si no hay forma de resolverla, se avisa y el fichero se queda donde está.
 *
 * Al terminar recalcula `organizations.storage_used` de cada organización
 * tocada, que si no queda contando un directorio que ya no existe.
 *
 * Idempotente: si el destino ya tiene el fichero con el mismo tamaño, no hace
 * nada. DRY-RUN POR DEFECTO: no toca nada sin `--apply`.
 *
 * Uso:
 *   npx tsx scripts/migrate-uploads-to-org.ts               # simulación
 *   npx tsx scripts/migrate-uploads-to-org.ts --apply       # ejecuta
 *   npx tsx scripts/migrate-uploads-to-org.ts --apply --uploads ./data/uploads
 */

// E3-T2 (ADR-0009 §6): este script recorre TODAS las organizaciones, así que
// desde la RLS estricta no puede conectar con el rol de la aplicación —vería 0
// filas y daría por bueno un barrido vacío—. Conecta como `app_maintenance`
// (BYPASSRLS) mediante `DATABASE_URL_MAINTENANCE`.
//
// Los módulos que abren la conexión se importan DINÁMICAMENTE, después de
// apuntar `DATABASE_URL` a la credencial de mantenimiento: `lib/db.ts` lee la
// variable al evaluarse, y un `import` estático se evaluaría antes.
import { maintenanceDatabaseUrl } from "@/lib/db-maintenance"
import type { PrismaClient } from "@/prisma/client"
import { constants } from "node:fs"
import { access, mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import path from "node:path"

type Movimiento = {
  /** Ruta relativa dentro del directorio heredado. */
  relative: string
  source: string
  target: string
  organizationId: string
  /** Cómo se resolvió la organización (para el informe). */
  origen: "files.id" | "files.path" | "organización personal" | "única membresía"
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parseArgs(argv: string[]) {
  const apply = argv.includes("--apply")
  const uploadsIndex = argv.indexOf("--uploads")
  const uploadsPath =
    uploadsIndex >= 0 && argv[uploadsIndex + 1]
      ? argv[uploadsIndex + 1]
      : process.env.UPLOAD_PATH || "./data/uploads"
  return { apply, uploadsPath: path.resolve(uploadsPath) }
}

let prisma: PrismaClient
let getOrganizationStorageUsed: (organization: { id: string }) => Promise<number>
let updateOrganization: (organizationId: string, data: { storageUsed: number }) => Promise<unknown>

/** Conecta como `app_maintenance` y comprueba que de verdad esquiva RLS. */
async function connectAsMaintenance(): Promise<void> {
  process.env.DATABASE_URL = maintenanceDatabaseUrl()
  const db = await import("@/lib/db")
  const files = await import("@/lib/files")
  const organizations = await import("@/models/organizations")
  prisma = db.prisma as unknown as PrismaClient
  getOrganizationStorageUsed = files.getOrganizationStorageUsed
  updateOrganization = organizations.updateOrganization as typeof updateOrganization

  const rows = await prisma.$queryRaw<{ rolname: string; rolbypassrls: boolean }[]>`
    SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = current_user
  `
  if (!rows[0]?.rolbypassrls) {
    throw new Error(
      `DATABASE_URL_MAINTENANCE conecta como \`${rows[0]?.rolname ?? "?"}\`, que NO tiene BYPASSRLS. ` +
        "Con RLS estricta (ADR-0009) este script vería 0 ficheros y no migraría nada. " +
        "Apunta la variable al rol `app_maintenance`."
    )
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** Ficheros (recursivo) relativos a `root`. */
async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await listFiles(root, relative)))
    } else if (entry.isFile()) {
      out.push(relative)
    }
  }
  return out
}

/** Organización de reserva del usuario: la personal, o su única membresía. */
async function fallbackOrganizationId(userId: string): Promise<{ id: string; origen: Movimiento["origen"] } | null> {
  const personal = await prisma.organization.findFirst({ where: { id: userId }, select: { id: true } })
  if (personal) return { id: personal.id, origen: "organización personal" }

  const memberships = await prisma.membership.findMany({
    where: { userId },
    orderBy: [{ createdAt: "asc" }],
    select: { organizationId: true },
  })
  // Con más de una membresía NO se adivina: mezclar tenants es peor que parar.
  if (memberships.length === 1) return { id: memberships[0].organizationId, origen: "única membresía" }
  return null
}

async function main() {
  const { apply, uploadsPath } = parseArgs(process.argv.slice(2))
  await connectAsMaintenance()
  console.log(`[uploads] raíz: ${uploadsPath}`)
  console.log(apply ? "[uploads] MODO REAL (--apply)" : "[uploads] SIMULACIÓN (usa --apply para ejecutar)")

  if (!(await exists(uploadsPath))) {
    console.log("[uploads] la raíz no existe: nada que migrar")
    return
  }

  const entries = await readdir(uploadsPath, { withFileTypes: true })
  const legacyDirs = entries.filter((entry) => entry.isDirectory() && !UUID_RE.test(entry.name))

  if (legacyDirs.length === 0) {
    console.log("[uploads] no hay directorios heredados (todos son uuid de organización)")
    return
  }

  const movimientos: Movimiento[] = []
  const sinDestino: string[] = []
  const organizacionesTocadas = new Set<string>()

  for (const dir of legacyDirs) {
    const from = path.join(uploadsPath, dir.name)
    const user = await prisma.user.findUnique({ where: { email: dir.name.toLowerCase() } })
    if (!user) {
      console.warn(`[uploads] ${dir.name}: no hay usuario con ese correo. Directorio intacto.`)
      continue
    }
    const fallback = await fallbackOrganizationId(user.id)

    for (const relative of await listFiles(from)) {
      // Ronda 3 (B): el nombre del fichero almacenado ES el uuid de la fila de
      // `files` (`unsortedFilePath`/`getTransactionFileUploadPath` lo componen
      // así), de modo que se resuelve por CLAVE PRIMARIA. Si no lo fuera, se cae
      // a `path`, pero ACOTANDO por `uploadedById`: dos organizaciones distintas
      // pueden tener filas con el mismo `path` relativo y `findFirst` a secas
      // devolvía una cualquiera.
      const posixPath = relative.split(path.sep).join("/")
      const fileUuid = path.basename(relative, path.extname(relative))

      const registrado = UUID_RE.test(fileUuid)
        ? await prisma.file.findUnique({ where: { id: fileUuid }, select: { organizationId: true } })
        : null

      const porRuta =
        registrado ??
        (await prisma.file.findFirst({
          where: { path: posixPath, uploadedById: user.id },
          select: { organizationId: true },
        }))

      const destino = porRuta
        ? { id: porRuta.organizationId, origen: registrado ? ("files.id" as const) : ("files.path" as const) }
        : fallback

      if (!destino) {
        sinDestino.push(path.join(dir.name, relative))
        continue
      }

      organizacionesTocadas.add(destino.id)
      movimientos.push({
        relative,
        source: path.join(from, relative),
        target: path.join(uploadsPath, destino.id, relative),
        organizationId: destino.id,
        origen: destino.origen,
      })
    }
  }

  const porOrganizacion = new Map<string, number>()
  for (const m of movimientos) porOrganizacion.set(m.organizationId, (porOrganizacion.get(m.organizationId) ?? 0) + 1)
  for (const [organizationId, n] of porOrganizacion) {
    console.log(`[uploads] → ${organizationId}: ${n} ficheros`)
  }
  const porResolucion = new Map<string, number>()
  for (const m of movimientos) porResolucion.set(m.origen, (porResolucion.get(m.origen) ?? 0) + 1)
  for (const [origen, n] of porResolucion) console.log(`[uploads]   resueltos por ${origen}: ${n}`)
  for (const huerfano of sinDestino) {
    console.warn(`[uploads] SIN DESTINO (no está en files y el usuario tiene varias organizaciones): ${huerfano}`)
  }

  if (!apply) {
    console.log(`[uploads] simulación: ${movimientos.length} ficheros se moverían. No se ha modificado nada.`)
    return
  }

  let moved = 0
  let skipped = 0
  for (const m of movimientos) {
    if (await exists(m.target)) {
      const [a, b] = await Promise.all([stat(m.source), stat(m.target)])
      if (a.size !== b.size) {
        console.warn(`[uploads] CONFLICTO (tamaños distintos), se conserva el destino: ${m.relative}`)
      }
      skipped++
      continue
    }
    await mkdir(path.dirname(m.target), { recursive: true })
    await rename(m.source, m.target)
    moved++
  }

  // Directorios heredados que hayan quedado vacíos.
  for (const dir of legacyDirs) {
    const from = path.join(uploadsPath, dir.name)
    if (!(await exists(from))) continue
    if ((await listFiles(from)).length === 0) {
      await rm(from, { recursive: true, force: true })
    } else {
      console.warn(`[uploads] ${dir.name}: quedan ficheros sin mover, no se borra el directorio`)
    }
  }

  // La cuota se mide sobre el directorio de la organización: si no se recalcula,
  // `storage_used` sigue reflejando un reparto que ya no existe (#10).
  for (const organizationId of organizacionesTocadas) {
    const storageUsed = await getOrganizationStorageUsed({ id: organizationId })
    await updateOrganization(organizationId, { storageUsed })
    console.log(`[uploads] storage_used de ${organizationId} = ${storageUsed} bytes`)
  }

  console.log(`[uploads] hecho. movidos=${moved} omitidos=${skipped} sin destino=${sinDestino.length}`)
}

main()
  .catch((error) => {
    console.error("[uploads] error:", error)
    process.exitCode = 1
  })
  .finally(async () => {
    // `prisma` sólo existe si `connectAsMaintenance()` llegó a ejecutarse.
    await prisma?.$disconnect()
  })
