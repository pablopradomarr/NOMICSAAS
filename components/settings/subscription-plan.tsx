import { Organization } from "@/prisma/client"

import { PricingCard } from "@/components/auth/pricing-card"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import config from "@/lib/config"
import { PLANS } from "@/lib/stripe"
import { formatBytes, formatNumber } from "@/lib/utils"
import { formatDate } from "date-fns"
import { BrainCog, CalendarSync, HardDrive } from "lucide-react"
import Link from "next/link"
import { Badge } from "../ui/badge"

// E1 (T11): plan, cuotas y cliente de Stripe son de la organización.
export function SubscriptionPlan({ organization }: { organization: Organization }) {
  const plan = PLANS[organization.membershipPlan as keyof typeof PLANS] || PLANS.unlimited

  return (
    <div className="flex flex-wrap gap-5">
      <div className="flex flex-col gap-2 flex-1 items-center justify-center max-w-[300px]">
        <PricingCard plan={plan} hideButton={true} />
        <Badge variant="outline">Current Plan</Badge>
      </div>
      <div className="flex-1">
        <Card className="w-full p-4">
          <div className="space-y-2">
            <strong className="text-lg">Usage:</strong>
            <div className="flex items-center gap-2">
              <HardDrive className="h-4 w-4" />
              <span>
                <strong className="font-semibold">Storage:</strong> {formatBytes(organization.storageUsed)} /{" "}
                {organization.storageLimit > 0 ? formatBytes(organization.storageLimit) : "Unlimited"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <BrainCog className="h-4 w-4" />
              <span>
                <strong className="font-semibold">AI Analyses:</strong> {formatNumber(plan.limits.ai - organization.aiBalance)}{" "}
                / {plan.limits.ai > 0 ? formatNumber(plan.limits.ai) : "Unlimited"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <CalendarSync className="h-4 w-4" />
              <span>
                <strong className="font-semibold">Expiration Date:</strong>{" "}
                {organization.membershipExpiresAt ? formatDate(organization.membershipExpiresAt, "yyyy-MM-dd") : "Never"}
              </span>
            </div>
          </div>

          <div className="space-y-4 mt-6 text-center">
            {organization.stripeCustomerId && (
              <Button asChild className="w-full">
                <Link href="/api/stripe/portal">Manage Subscription</Link>
              </Button>
            )}

            {!organization.stripeCustomerId && organization.membershipExpiresAt && (
              <Button asChild className="w-full">
                <Link href="/cloud">Buy Subscription</Link>
              </Button>
            )}

            <Link href={`mailto:${config.app.supportEmail}`} className="block text-sm text-muted-foreground">
              Contact Us
            </Link>
          </div>
        </Card>
      </div>
    </div>
  )
}
