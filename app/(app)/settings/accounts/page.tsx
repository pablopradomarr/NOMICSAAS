import { AccountsTree } from "@/components/accounts/accounts-tree"
import type { ClassificationCatalog } from "@/components/accounts/types"
import { SettingsPageHeader } from "@/components/settings/page-header"
import { Button } from "@/components/ui/button"
import { checkAnalyticCoherence, epigraphCatalog } from "@/lib/accounts/epigraphs"
import { planAccounts } from "@/lib/accounts/tree"
import { requireOrg } from "@/lib/authz"
import { getPlan } from "@/models/accounts"
import { getAccountMap } from "@/models/account-map"
import { loadNpgcSeed } from "@/models/npgc-seed"
import { AnalyticType, CashflowBucket, Role, Statement } from "@/prisma/client"
import { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = {
  title: "Plan de cuentas",
}

/**
 * E2 · T10 — Plan contable de la organización (§6).
 *
 * Server Component: el plan completo (794–910 filas) se lee una vez con
 * `tenantDb` y viaja ya resuelto al árbol. El cliente no consulta la base ni
 * calcula nada; `VIEWER` y `EDITOR` reciben la misma pantalla sin controles.
 */
export default async function AccountsSettingsPage() {
  const { db, org, role } = await requireOrg(Role.VIEWER)
  const canEdit = role === Role.ADMIN

  // Secuencial y una sola lectura del plan: cada consulta de `tenantDb` abre su
  // propia transacción con los GUC de la organización, y lanzarlas en paralelo
  // agota el pool antes de que la primera termine.
  const plan = await getPlan(db)
  const mapEntries = await getAccountMap(db)
  const accounts = planAccounts(plan)
  // I-E2-6 (aviso): se calcula sobre el plan ya leído, sin volver a la base.
  const warnings = checkAnalyticCoherence(accounts, org.pgcVariant)

  const catalog: ClassificationCatalog = {
    variant: org.pgcVariant,
    epigraphs: [...epigraphCatalog(loadNpgcSeed().rows, org.pgcVariant)].sort((a, b) => a.localeCompare(b, "es")),
    analyticTypes: Object.values(AnalyticType),
    cashflowBuckets: Object.values(CashflowBucket),
    statements: Object.values(Statement),
  }

  const warningsByCode: Record<string, string> = {}
  for (const warning of warnings) warningsByCode[warning.accountCode] = warning.message

  const mappedKeysByCode: Record<string, string[]> = {}
  for (const entry of mapEntries) {
    mappedKeysByCode[entry.accountCode] = [...(mappedKeysByCode[entry.accountCode] ?? []), entry.key]
  }

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title="Plan de cuentas"
        description="Cuadro de cuentas del PGC 2007 de esta organización: grupo → subgrupo → cuenta → subcuenta. Renombrar, crear subcuentas y clasificar es cosa del administrador; todo cambio queda en la auditoría."
      />

      {accounts.length === 0 ? (
        <div className="space-y-3 rounded-md border p-6">
          <p className="text-sm text-muted-foreground">
            Esta organización todavía no tiene plan contable sembrado.
          </p>
          {canEdit && (
            <Button asChild>
              <Link href="/settings/accounts/import">Importar un plan</Link>
            </Button>
          )}
        </div>
      ) : (
        <>
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <Link href="/settings/account-map">Mapa de cuentas de sistema</Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href="/settings/accounts/import">Importar plan desde CSV</Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href="/settings/audit">Auditoría de cambios</Link>
              </Button>
            </div>
          )}

          {warnings.length > 0 && (
            <p className="rounded-md border border-[#F5A623] bg-[#F5A623]/10 px-3 py-2 text-sm">
              ⚠ {warnings.length} cuenta(s) con un tipo analítico que no encaja con el bloque de PyG de su epígrafe
              (R-16). No bloquea la contabilidad: deja abierta la conciliación EBITDA/EBIT.
            </p>
          )}

          <AccountsTree
            organizationId={org.id}
            accounts={accounts}
            catalog={catalog}
            canEdit={canEdit}
            warningsByCode={warningsByCode}
            mappedKeysByCode={mappedKeysByCode}
          />
        </>
      )}
    </div>
  )
}
