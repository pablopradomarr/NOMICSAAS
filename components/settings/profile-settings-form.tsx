"use client"

import { saveBusinessSettingsAction, saveProfileAction } from "@/app/(app)/settings/actions"
import { FormError } from "@/components/forms/error"
import { FormAvatar, FormInput, FormTextarea } from "@/components/forms/simple"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Organization, User } from "@/prisma/client"
import { CircleCheckBig } from "lucide-react"
import { useActionState } from "react"
import { ChangePasswordForm } from "./change-password-form"
import { SubscriptionPlan } from "./subscription-plan"

export default function ProfileSettingsForm({
  user,
  organization,
  canEditBusiness,
  showPasswordSection,
}: {
  user: User
  organization: Organization
  canEditBusiness: boolean
  /** E13 · T12 — false en self-hosted: no hay contraseña que cambiar (§8.2 T12). */
  showPasswordSection: boolean
}) {
  const [saveState, saveAction, pending] = useActionState(saveProfileAction, null)
  const [businessState, businessAction, businessPending] = useActionState(saveBusinessSettingsAction, null)

  return (
    <div className="space-y-8">
      <SubscriptionPlan organization={organization} />

      <form action={saveAction} className="space-y-8">
        <div className="space-y-4">
          <h3 className="text-lg font-semibold">Your TaxHacker Profile</h3>
          <FormAvatar
            title="Avatar"
            name="avatar"
            className="w-24 h-24"
            defaultValue={user.avatar ? user.avatar + "?" + user.id : ""}
          />
          <FormInput title="Account Name" name="name" defaultValue={user.name || ""} />
          <div className="flex flex-row items-center gap-4">
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Save"}
            </Button>
            {saveState?.success && (
              <p className="text-green-500 flex flex-row items-center gap-2">
                <CircleCheckBig />
                Saved!
              </p>
            )}
          </div>
        </div>

        {saveState?.error && <FormError>{saveState.error}</FormError>}
      </form>

      {showPasswordSection && (
        <>
          <Separator />
          <ChangePasswordForm />
        </>
      )}

      <Separator />

      <form action={businessAction} className="space-y-8">
        <div className="space-y-4">
          <div className="space-y-1">
            <h3 className="text-lg font-semibold">Business Details of {organization.name}</h3>
            <p className="text-sm text-muted-foreground">
              Used on invoices and as defaults across the app. These belong to the organization, not to your personal
              account.
            </p>
          </div>
          <FormInput
            title="Business Name"
            name="businessName"
            placeholder="Acme Inc."
            defaultValue={organization.businessName ?? ""}
            disabled={!canEditBusiness}
          />
          <FormTextarea
            title="Business Address"
            name="businessAddress"
            placeholder="Street, City, State, Zip Code, Country, Tax ID"
            defaultValue={organization.businessAddress ?? ""}
            disabled={!canEditBusiness}
          />
          <FormTextarea
            title="Bank Details"
            name="businessBankDetails"
            placeholder="Bank Name, Account Number, BIC, IBAN, details of payment, etc."
            defaultValue={organization.businessBankDetails ?? ""}
            disabled={!canEditBusiness}
          />
          <FormAvatar title="Business Logo" name="businessLogo" className="w-52 h-52" defaultValue={organization.businessLogo ?? ""} />
        </div>

        {canEditBusiness && (
          <div className="flex flex-row items-center gap-4">
            <Button type="submit" disabled={businessPending}>
              {businessPending ? "Saving..." : "Save"}
            </Button>
            {businessState?.success && (
              <p className="text-green-500 flex flex-row items-center gap-2">
                <CircleCheckBig />
                Saved!
              </p>
            )}
          </div>
        )}

        {businessState?.error && <FormError>{businessState.error}</FormError>}
      </form>
    </div>
  )
}
