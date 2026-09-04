import { SubscriptionExpired } from "@/components/auth/subscription-expired"
import ScreenDropArea from "@/components/files/screen-drop-area"
import MobileMenu from "@/components/sidebar/mobile-menu"
import { AppSidebar } from "@/components/sidebar/sidebar"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { Toaster } from "@/components/ui/sonner"
import { isSubscriptionExpired } from "@/lib/auth"
import { requireOrg } from "@/lib/authz"
import config from "@/lib/config"
import { getApps } from "@/app/(app)/apps/common"
import { getUnsortedFilesCount } from "@/models/files"
import type { Metadata, Viewport } from "next"
import "../globals.css"
import { NotificationProvider } from "./context"

export const metadata: Metadata = {
  title: {
    template: "%s | TaxHacker",
    default: config.app.title,
  },
  description: config.app.description,
  icons: {
    icon: "/favicon.ico",
    shortcut: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
  manifest: "/site.webmanifest",
}

export const viewport: Viewport = {
  themeColor: "#ffffff",
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { db, org, user } = await requireOrg("VIEWER")
  const [unsortedFilesCount, apps] = await Promise.all([getUnsortedFilesCount(db), getApps()])

  // Identidad del usuario + plan/cuota de la organización activa (T11).
  const userProfile = {
    id: user.id,
    name: user.name || "",
    email: user.email,
    avatar: user.avatar ? user.avatar + "?" + user.id : undefined,
    organizationName: org.name,
    membershipPlan: org.membershipPlan || "unlimited",
    storageUsed: org.storageUsed || 0,
    storageLimit: org.storageLimit || -1,
    aiBalance: org.aiBalance || 0,
  }

  return (
    <NotificationProvider>
      <ScreenDropArea>
        <SidebarProvider>
          <MobileMenu unsortedFilesCount={unsortedFilesCount} />
          <AppSidebar
            profile={userProfile}
            unsortedFilesCount={unsortedFilesCount}
            isSelfHosted={config.selfHosted.isEnabled}
            apps={apps.map((app) => ({
              id: app.id,
              name: app.manifest.name,
              icon: app.manifest.icon,
            }))}
          />
          <SidebarInset className="w-full h-full mt-[60px] md:mt-0 overflow-auto">
            {isSubscriptionExpired(org) && <SubscriptionExpired />}
            {children}
          </SidebarInset>
        </SidebarProvider>
        <Toaster />
      </ScreenDropArea>
    </NotificationProvider>
  )
}

export const dynamic = "force-dynamic"
