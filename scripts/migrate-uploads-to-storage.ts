/**
 * E11 · T7 — **del disco al almacén** (§4, ADR-0019 D3).
 *
 *   npx tsx scripts/migrate-uploads-to-storage.ts [--org <uuid>] [--apply]
 *
 * Por defecto **simula**: lee, comprueba y dice qué haría, sin escribir nada.
 * Con `--apply` sube de verdad. **Es idempotente**: la clave del objeto se
 * deriva del `sha256`, así que ejecutarlo dos veces no duplica ni un byte ni una
 * fila, y una ejecución interrumpida se reanuda sin más.
 *
 * Por cada `File`, en este orden:
 *
 *   1. leer los bytes del disco heredado (`uploads/<org>/<path>`);
 *   2. **comprobar su `sha256` contra `files.sha256`**;
 *   3. subir al almacén con la clave canónica;
 *   4. `head()` y verificar tamaño;
 *   5. crear el `StoredObject`.
 *
 * **Sha discordante ⇒ no se sube y se informa.** Un fichero alterado no se
 * propaga al almacén nuevo con la bendición de la migración: se queda donde
 * está, aparece en el informe y lo resuelve una persona. Ése es, literalmente,
 * el caso que I-E8-2 existe para detectar.
 *
 * Se ejecuta como **operador** (`DATABASE_URL_MAINTENANCE`, `app_maintenance`
 * BYPASSRLS), igual que `scripts/migrate-uploads-to-org.ts`: recorre todas las
 * organizaciones y no hay sesión de usuario de la que sacar el tenant.
 */

import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { prisma } from "@/lib/db"
import { storedFilePath } from "@/lib/files-integrity"
import { objectKey, storage } from "@/lib/storage"

export type MigrationReport = {
  organizations: number
  files: number
  uploaded: number
  alreadyThere: number
  missing: { fileId: string; path: string }[]
  mismatched: { fileId: string; expected: string; actual: string }[]
}

export async function migrateUploadsToStorage(options: {
  organizationId?: string
  apply: boolean
  log?: (message: string) => void
}): Promise<MigrationReport> {
  const say = options.log ?? ((message: string) => console.log(message))
  const { driver, prefix } = storage()

  const report: MigrationReport = {
    organizations: 0,
    files: 0,
    uploaded: 0,
    alreadyThere: 0,
    missing: [],
    mismatched: [],
  }

  const organizations = await prisma.organization.findMany({
    where: options.organizationId ? { id: options.organizationId } : {},
    select: { id: true, slug: true },
    orderBy: { slug: "asc" },
  })

  for (const organization of organizations) {
    report.organizations += 1
    const files = await prisma.file.findMany({
      where: { organizationId: organization.id },
      select: { id: true, path: true, sha256: true, mimetype: true },
      orderBy: { createdAt: "asc" },
    })
    say(`· ${organization.slug}: ${files.length} ficheros`)

    for (const file of files) {
      report.files += 1
      const key = objectKey({ prefix, organizationId: organization.id, kind: "DOCUMENT", sha256: file.sha256 })

      const existing = await prisma.storedObject.findFirst({
        where: { organizationId: organization.id, objectKey: key },
      })
      if (existing && (await driver.head(key))) {
        report.alreadyThere += 1
        continue
      }

      let bytes: Buffer
      try {
        bytes = await readFile(storedFilePath(organization.id, file.path))
      } catch {
        report.missing.push({ fileId: file.id, path: file.path })
        continue
      }

      const actual = createHash("sha256").update(bytes).digest("hex")
      if (actual !== file.sha256) {
        // No se sube. Un fichero alterado no se propaga al almacén nuevo.
        report.mismatched.push({ fileId: file.id, expected: file.sha256, actual })
        continue
      }

      if (!options.apply) {
        report.uploaded += 1
        continue
      }

      const { sizeBytes } = await driver.put(key, bytes, { mimeType: file.mimetype, sha256: file.sha256 })
      const head = await driver.head(key)
      if (!head || head.sizeBytes !== sizeBytes) {
        throw new Error(`el almacén no confirma el objeto ${key}`)
      }
      if (!existing) {
        await prisma.storedObject.create({
          data: {
            organizationId: organization.id,
            objectKey: key,
            backend: driver.backend,
            sha256: file.sha256,
            sizeBytes,
            mimeType: file.mimetype,
            kind: "DOCUMENT",
          },
        })
      }
      report.uploaded += 1
    }
  }

  return report
}

export const USAGE = `Migra los documentos del disco heredado al almacén de E11.

  npx tsx scripts/migrate-uploads-to-storage.ts [--org <uuid>] [--apply]

  --org <uuid>  Sólo esa organización. Por defecto, todas.
  --apply       Escribe de verdad. Sin él, simula y no toca nada.

Requiere DATABASE_URL_MAINTENANCE (rol app_maintenance) y STORAGE_* configurado.
`

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE)
    return
  }
  const organizationId = argv.includes("--org") ? argv[argv.indexOf("--org") + 1] : undefined
  const apply = argv.includes("--apply")

  console.log(apply ? "Migrando documentos al almacén…" : "SIMULACIÓN (sin --apply no se escribe nada)")
  const report = await migrateUploadsToStorage({ organizationId, apply })

  console.log("")
  console.log(`Organizaciones .......... ${report.organizations}`)
  console.log(`Ficheros examinados ..... ${report.files}`)
  console.log(`Subidos ................. ${report.uploaded}`)
  console.log(`Ya estaban .............. ${report.alreadyThere}`)
  console.log(`Sin bytes en disco ...... ${report.missing.length}`)
  console.log(`Sha256 discordante ...... ${report.mismatched.length}`)
  for (const row of report.mismatched) {
    console.log(`  ! ${row.fileId}: registrado ${row.expected}, en disco ${row.actual}`)
  }
  if (report.mismatched.length > 0) {
    console.log("")
    console.log("Hay ficheros alterados. NO se han subido: revísalos antes de repetir la migración.")
    process.exitCode = 1
  }
}

if (process.argv[1] && process.argv[1].endsWith("migrate-uploads-to-storage.ts")) {
  void main().finally(() => prisma.$disconnect())
}
