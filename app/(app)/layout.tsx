import { SubscriptionExpired } from "@/components/auth/subscription-expired"
import ScreenDropArea from "@/components/files/screen-drop-area"
import MobileMenu from "@/components/sidebar/mobile-menu"
import { AppSidebar } from "@/components/sidebar/sidebar"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { Toaster } from "@/components/ui/sonner"
import { isSubscriptionExpired } from "@/lib/auth"
import { AuthzError, requireOrg, roleSatisfies } from "@/lib/authz"
import { runWithRequestTenant } from "@/lib/db"
import config from "@/lib/config"
import { getApps } from "@/app/(app)/apps/common"
import { getUnsortedFilesCount } from "@/models/files"
import { getUserMemberships } from "@/models/memberships"
import type { Metadata, Viewport } from "next"
import { redirect } from "next/navigation"
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
  // E1-fix (#9): un usuario autenticado SIN membresía activa no puede ver esta
  // sección, pero tampoco debe recibir un 500: se le manda a crear su primera
  // organización (`/organizations/new` vive en el grupo `(onboarding)`, fuera de
  // este layout, así que no hay bucle de redirección).
  let context
  try {
    context = await requireOrg("VIEWER")
  } catch (error) {
    if (error instanceof AuthzError && error.code === "NO_ORGANIZATION") {
      redirect("/organizations/new")
    }
    throw error
  }
  const { db, org, user, role } = context

  // E6-perf: UNA transacción para todo el layout. Antes cada lectura abría la
  // suya (`tenantDb` fija los GUC con `SET LOCAL`), y como Next renderiza el
  // layout EN PARALELO con la página, entre los dos podían pedir una decena de
  // conexiones a la vez y agotar el pool. Las lecturas van en serie: comparten
  // una sola conexión, así que no hay paralelismo que ganar y solaparlas
  // dispararía el aviso de `pg`. `getApps()` lee el disco, no la base.
  const unsortedFilesCount = await runWithRequestTenant(org.id, user.id, async () => getUnsortedFilesCount(db), {
    readOnly: true,
  })
  // FUERA de la transacción anterior a propósito: `getUserMemberships` enumera
  // TODAS las organizaciones del usuario, así que va con `app.current_org` sin
  // fijar (`withTenantGucs(null, …)`) y no puede compartirla. Encadenado, no en
  // paralelo: así el layout nunca tiene dos conexiones abiertas a la vez.
  const memberships = await getUserMemberships(user.id)
  const apps = await getApps()

  // El switcher es un Client Component: recibe las organizaciones ya resueltas.
  const organizations = memberships.map((membership) => ({
    id: membership.organizationId,
    name: membership.organization.name,
    subtitle: membership.organization.taxId ?? membership.organization.baseCurrency,
    role: membership.role,
  }))

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
            organizations={organizations}
            activeOrganizationId={org.id}
            isAdmin={role === "ADMIN"}
            canEdit={roleSatisfies(role, "EDITOR")}
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
