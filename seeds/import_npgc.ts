/**
 * E2 · T7 — CLI de siembra del plan NPGC (§4.4).
 *
 *   npx tsx seeds/import_npgc.ts --org <uuid> --variant PYMES [--dry-run]
 *                                [--no-subaccounts] [--software-accounts] [--reason "..."]
 *   npx tsx seeds/import_npgc.ts --all [--dry-run]     # backfill de organizaciones pre-E2
 *
 * Sin usuario de sesión: `AuditLog.userId = null`, `action: "seed"`. `--dry-run`
 * imprime el recuento y sale con 0 sin escribir. Sin `--org` ni `--all`, sale
 * con código 2 y el uso.
 *
 * El backfill es IDEMPOTENTE: ejecutarlo dos veces no crea nada nuevo, así que
 * es también la vía de recuperación si una siembra se quedó a medias.
 */

import { prisma } from "@/lib/db"
import { importNpgc, type ImportNpgcResult } from "@/models/accounts"
import { PgcVariant } from "@/prisma/client"
import path from "node:path"
import { fileURLToPath } from "node:url"

type Args = {
  org?: string
  all: boolean
  variant?: PgcVariant
  dryRun: boolean
  useSubaccounts: boolean
  softwareAccounts: boolean
  reason: string | null
}

const USAGE = `Uso:
  npx tsx seeds/import_npgc.ts --org <uuid> [--variant GENERAL|PYMES] [--dry-run]
                               [--no-subaccounts] [--software-accounts] [--reason "..."]
  npx tsx seeds/import_npgc.ts --all [--dry-run]

Sin --org ni --all no hay nada que sembrar.`

export function parseArgs(argv: readonly string[]): Args | null {
  const args: Args = {
    all: false,
    dryRun: false,
    useSubaccounts: true,
    softwareAccounts: false,
    reason: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case "--org":
        args.org = argv[++i]
        break
      case "--all":
        args.all = true
        break
      case "--variant": {
        const value = argv[++i]
        if (value !== "GENERAL" && value !== "PYMES") return null
        args.variant = value
        break
      }
      case "--dry-run":
        args.dryRun = true
        break
      case "--no-subaccounts":
        args.useSubaccounts = false
        break
      case "--software-accounts":
        args.softwareAccounts = true
        break
      case "--reason":
        args.reason = argv[++i] ?? null
        break
      default:
        return null
    }
  }
  if (!args.org && !args.all) return null
  if (args.org && args.all) return null
  return args
}

async function seedOne(
  organizationId: string,
  variant: PgcVariant,
  args: Args
): Promise<ImportNpgcResult> {
  return await importNpgc(organizationId, variant, {
    useSubaccounts: args.useSubaccounts,
    createSoftwareAccounts: args.softwareAccounts,
    actor: { userId: null },
    now: new Date(),
    dryRun: args.dryRun,
    reason: args.reason,
  })
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)
  if (!args) {
    console.error(USAGE)
    return 2
  }

  const targets = args.all
    ? await prisma.organization.findMany({ select: { id: true, slug: true, pgcVariant: true }, orderBy: { createdAt: "asc" } })
    : await prisma.organization.findMany({ where: { id: args.org }, select: { id: true, slug: true, pgcVariant: true } })

  if (targets.length === 0) {
    console.error(args.all ? "No hay ninguna organización que sembrar." : `No existe la organización ${args.org}`)
    return 1
  }

  let failed = 0
  for (const org of targets) {
    const variant = args.variant ?? org.pgcVariant
    try {
      const result = await seedOne(org.id, variant, args)
      console.log(
        `${args.dryRun ? "[dry-run] " : ""}${org.slug} (${org.id}) · ${variant}: ` +
          `creadas ${result.created}, actualizadas ${result.updated}, sin cambios ${result.skipped}, ` +
          `claves mapeadas ${result.mapKeys}, tipos impositivos ${result.taxRates}` +
          (result.unresolvedKeys.length > 0 ? `, claves sin resolver: ${result.unresolvedKeys.join(", ")}` : "")
      )
    } catch (error) {
      failed++
      console.error(`✗ ${org.slug} (${org.id}): ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return failed > 0 ? 1 : 0
}

// Sólo se ejecuta cuando el fichero ES el script invocado (no cuando lo importa
// un test): así `parseArgs` y `main` son testables sin efectos secundarios.
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then(async (code) => {
      await prisma.$disconnect()
      process.exit(code)
    })
    .catch(async (error) => {
      console.error(error)
      await prisma.$disconnect()
      process.exit(1)
    })
}
