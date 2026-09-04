import { fetchEmails } from "@/app/(app)/apps/email/scripts/fetch-emails"
import { requireOrg } from "@/lib/authz"
import { NextRequest, NextResponse } from "next/server"

export async function POST(_request: NextRequest) {
  try {
    // Lanzar una sincronización crea documentos → EDITOR
    const { org, user } = await requireOrg("EDITOR")

    console.log(`🔄 Manual email sync triggered by user: ${user.email}`)

    // Run the email sync (sólo la organización activa)
    await fetchEmails({ organizationId: org.id })

    return NextResponse.json({
      success: true,
      message: "Email sync completed successfully",
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("❌ Error in manual email sync:", error)

    return NextResponse.json(
      {
        error: "Email sync failed",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}

export async function GET(_request: NextRequest) {
  try {
    await requireOrg("VIEWER")

    return NextResponse.json({
      message: "Email sync API is ready",
      endpoint: "/api/email/sync",
      methods: ["POST"],
      description: "Trigger manual email synchronization",
    })
  } catch (_error) {
    return NextResponse.json({ error: "Failed to get sync status" }, { status: 500 })
  }
}
