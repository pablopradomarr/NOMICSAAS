import { AccountMapTable, type AccountMapRow, type PostableOption } from "@/components/accounts/account-map-table"
import { SoftwareAccountsForm } from "@/components/accounts/software-accounts-form"
import { SettingsPageHeader } from "@/components/settings/page-header"
import { Separator } from "@/components/ui/separator"
import {
  ACCOUNT_KEY_DEFAULT_CODE,
  OPTIONAL_ACCOUNT_KEYS,
  REQUIRED_ACCOUNT_KEYS,
  SOFTWARE_ACCOUNTS,
} from "@/lib/accounts/map"
import { planAccounts } from "@/lib/accounts/tree"
import { getAccountMap, validateOrganizationAccountMap } from "@/models/account-map"
import { getPlan } from "@/models/accounts"
import { AccountKey, Role } from "@/prisma/client"
import { Metadata } from "next"
import { tenantPage } from "@/lib/page-tenant"

export const metadata: Metadata = {
  title: "Mapa de cuentas",
}

/**
 * E2 · T11 — Mapa de cuentas de sistema (§6).
 *
 * Dos bloques: las claves obligatorias que el motor necesita para poder
 * contabilizar (I-plan-1) y las que se mapearán cuando llegue su épica.
 */
export default tenantPage(async ({ db, role }) => {
  const canEdit = role === Role.ADMIN

  // Secuencial: cada consulta de `tenantDb` abre su propia transacción con los
  // GUC de la organización y en paralelo agotan el pool.
  const plan = await getPlan(db)
  const entries = await getAccountMap(db)
  const check = await validateOrganizationAccountMap(db)

  const byKey = new Map(entries.map((entry) => [entry.key, entry.accountCode]))
  const options: PostableOption[] = planAccounts(plan)
    .filter((account) => account.isPostable && account.isActive)
    .map((account) => ({ code: account.code, name: account.name }))

  const toRow = (key: AccountKey, required: boolean): AccountMapRow => {
    const accountCode = byKey.get(key) ?? null
    const account = accountCode ? plan.byCode.get(accountCode) : undefined
    const defaultCode = ACCOUNT_KEY_DEFAULT_CODE[key]
    let problem: string | null = null
    if (accountCode && !account) problem = `La cuenta ${accountCode} no existe en el plan`
    else if (account && !account.isActive) problem = `La cuenta ${accountCode} está desactivada`
    else if (account && !account.isPostable) problem = `La cuenta ${accountCode} tiene subcuentas y no admite apuntes`
    else if (!accountCode && required) problem = "Clave obligatoria sin asignar"

    const fallback =
      accountCode && accountCode !== defaultCode && !problem
        ? `Se asignó ${accountCode} en lugar de la cuenta ${defaultCode} del PGC`
        : null

    return {
      key,
      defaultCode,
      accountCode,
      accountName: account?.name ?? null,
      problem,
      fallback,
      required,
    }
  }

  const requiredRows = REQUIRED_ACCOUNT_KEYS.map((key) => toRow(key, true))
  const optionalRows = OPTIONAL_ACCOUNT_KEYS.map((key) => toRow(key, false))
  const existingSoftware = SOFTWARE_ACCOUNTS.filter((account) => plan.byCode.has(account.code)).map((a) => a.code)

  return (
    <div className="space-y-8">
      <SettingsPageHeader
        title="Mapa de cuentas de sistema"
        description="Qué cuenta usa el motor contable para cada concepto. Ningún código está escrito en el código fuente: se resuelve aquí, por organización."
      />

      {!check.ok && (
        <div className="space-y-1 rounded-md border border-destructive bg-destructive/5 p-3 text-sm">
          <p className="font-medium">El mapa no resuelve (I-plan-1). El motor no podría contabilizar:</p>
          <ul className="list-inside list-disc">
            {check.errors.map((issue) => (
              <li key={issue.message}>{issue.message}</li>
            ))}
          </ul>
        </div>
      )}

      <AccountMapTable
        rows={requiredRows}
        options={options}
        canEdit={canEdit}
        title={`Claves obligatorias (${requiredRows.length})`}
        description="Todas deben apuntar a una cuenta existente, activa y que admita apuntes."
      />

      <Separator />

      <AccountMapTable
        rows={optionalRows}
        options={options}
        canEdit={canEdit}
        title={`Claves pendientes de su épica (${optionalRows.length})`}
        description="Declaradas ya para no encadenar migraciones; se asignan cuando su módulo entra en servicio (nóminas, tesorería, deterioros, cierre)."
      />

      {canEdit && (
        <>
          <Separator />
          <section className="space-y-3">
            <h3 className="text-lg font-semibold">Cuentas de desglose de IVA y retenciones</h3>
            <p className="text-sm text-muted-foreground">
              No son cuentas oficiales del PGC. Sólo hacen falta con varios tipos de IVA simultáneos o con inversión
              del sujeto pasivo y adquisiciones intracomunitarias, donde el doble apunte sobre la misma cuenta hace
              ilegible el mayor.
            </p>
            <SoftwareAccountsForm options={SOFTWARE_ACCOUNTS} existing={existingSoftware} />
          </section>
        </>
      )}
    </div>
  )
})
