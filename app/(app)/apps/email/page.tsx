import { getAppData } from "@/models/apps"
import { getSettings } from "@/models/settings"
import { EmailServerManager } from "./components/email-server-manager"
import { manifest } from "./manifest"
import { tenantPage } from "@/lib/page-tenant"

export type EmailProvider = "gmail" | "outlook" | "hotmail" | "fastmail" | "yahoo" | "apple" | "custom"

export type EmailServer = {
  id: string
  name: string
  provider: EmailProvider
  host: string
  port: number
  username: string
  password: string
  useSSL: boolean
  isActive: boolean
  lastSync?: Date
  lastSyncedAt?: Date
  status: "connected" | "error" | "pending" | "paused"
  allowedExtensions: string[]
  syncInterval: number // minutes
  addedAt: string
  initialSince?: string // ISO date; bounds the first sync ("" / unset = entire mailbox)
  lastProcessedUid?: number
  errorMessage?: string
}

export type EmailAppData = {
  servers: EmailServer[]
  globalSettings: {
    defaultExtensions: string[]
    defaultSyncInterval: number // minutes
  }
}

export default tenantPage(async ({ db, user }) => {
  const settings = await getSettings(db)
  const appData = (await getAppData(db, user.id, "email")) as EmailAppData | null

  const sanitizedAppData = appData
    ? { ...appData, servers: appData.servers.map((s) => ({ ...s, password: "" })) }
    : null

  return (
    <div>
      <header className="flex flex-wrap items-center justify-between gap-2 mb-8">
        <h2 className="flex flex-row gap-3 md:gap-5">
          <span className="text-3xl font-bold tracking-tight">
            {manifest.icon} {manifest.name}
          </span>
        </h2>
      </header>
      <EmailServerManager user={user} settings={settings} appData={sanitizedAppData} />
    </div>
  )
})
