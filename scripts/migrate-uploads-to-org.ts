/**
 * E1-fix (#3) — Migración de disco: `uploads/<email>/…` → `uploads/<orgId>/…`
 *
 * Hasta E1-fix los ficheros se guardaban bajo un directorio derivado del EMAIL
 * del usuario que los subía. Desde E1-fix el sujeto del almacenamiento es la
 * organización. Este script mueve los directorios heredados a su sitio.
 *
 * Cómo decide la organización de destino, en este orden:
 *   1. Si algún `files.uploaded_by_id` del usuario apunta a una organización,
 *      se usa ESA (el fichero pertenece a donde está registrado).
 *   2. Si no, la organización personal del usuario (id = users.id, convención
 *      del backfill 20260904120100).
 *   3. Si no hay ninguna, se avisa y se deja el directorio intacto.
 *
 * Idempotente: si el directorio de destino ya contiene el fichero con el mismo
 * tamaño, no hace nada; los directorios de origen vacíos se eliminan al final.
 * DRY-RUN POR DEFECTO: no toca nada sin `--apply`.
 *
 * Uso:
 *   npx tsx scripts/migrate-uploads-to-org.ts               # simulación
 *   npx tsx scripts/migrate-uploads-to-org.ts --apply       # ejecuta
 *   npx tsx scripts/migrate-uploads-to-org.ts --apply --uploads ./data/uploads
 */

import { prisma } from "@/lib/db"
import { constants } from "node:fs"
import { access, mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import path from "node:path"

type Plan = {
  email: string
  from: string
  to: string
  organizationId: string
  files: number
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

/** Organización de destino para el directorio de un email heredado. */
async function resolveOrganizationId(email: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } })
  if (!user) return null

  const uploaded = await prisma.file.findFirst({
    where: { uploadedById: user.id },
    orderBy: { createdAt: "asc" },
    select: { organizationId: true },
  })
  if (uploaded) return uploaded.organizationId

  const membership = await prisma.membership.findFirst({
    where: { userId: user.id },
    orderBy: [{ createdAt: "asc" }],
    select: { organizationId: true },
  })
  return membership?.organizationId ?? null
}

async function main() {
  const { apply, uploadsPath } = parseArgs(process.argv.slice(2))
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

  const plans: Plan[] = []
  for (const dir of legacyDirs) {
    const from = path.join(uploadsPath, dir.name)
    const organizationId = await resolveOrganizationId(dir.name)
    if (!organizationId) {
      console.warn(`[uploads] SIN DESTINO para ${dir.name}: no hay usuario ni membresía. Se deja intacto.`)
      continue
    }
    const files = await listFiles(from)
    plans.push({ email: dir.name, from, to: path.join(uploadsPath, organizationId), organizationId, files: files.length })
  }

  let moved = 0
  let skipped = 0

  for (const plan of plans) {
    console.log(`[uploads] ${plan.email} → ${plan.organizationId} (${plan.files} ficheros)`)
    if (!apply) continue

    for (const relative of await listFiles(plan.from)) {
      const source = path.join(plan.from, relative)
      const target = path.join(plan.to, relative)

      if (await exists(target)) {
        const [a, b] = await Promise.all([stat(source), stat(target)])
        if (a.size === b.size) {
          skipped++
          continue
        }
        console.warn(`[uploads] CONFLICTO (tamaños distintos), se conserva el destino: ${relative}`)
        skipped++
        continue
      }

      await mkdir(path.dirname(target), { recursive: true })
      await rename(source, target)
      moved++
    }

    // El directorio heredado sólo se borra si ha quedado vacío.
    const leftovers = await listFiles(plan.from)
    if (leftovers.length === 0) {
      await rm(plan.from, { recursive: true, force: true })
    } else {
      console.warn(`[uploads] ${plan.email}: quedan ${leftovers.length} ficheros sin mover, no se borra el directorio`)
    }
  }

  console.log(`[uploads] hecho. movidos=${moved} omitidos=${skipped} directorios=${plans.length}`)
  if (!apply) console.log("[uploads] no se ha modificado nada (simulación)")
}

main()
  .catch((error) => {
    console.error("[uploads] error:", error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
