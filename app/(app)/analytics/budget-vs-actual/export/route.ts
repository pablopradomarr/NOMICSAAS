/**
 * E10 · T14 — Descarga del informe de presupuesto vs real ya emitido:
 * `GET /analytics/budget-vs-actual/export?format=csv|xlsx|pdf&runId=…`.
 *
 * Es un **route handler** y no una server action porque devuelve un BINARIO
 * (patrón de E6): una server action lo tendría que serializar a base64 y el
 * navegador acabaría reconstruyendo el fichero a mano.
 *
 * Rol mínimo `VIEWER`: exportar es leer. **No recalcula nada** — sirve la foto
 * congelada del `ReportRun`, que es lo único que el sello acredita, con su hoja
 * de **Procedencia** (las tres consultas) y su hoja de Validación.
 *
 * Desviación declarada: el diseño (§4.2) sitúa la ruta en
 * `/analytics/budget/export`. Ese árbol es de C2 en esta misma ola y la regla es
 * «un fichero, un agente»; la ruta cuelga del informe que exporta, que es el
 * árbol de este lote. Se recoge en el registro de la ola.
 */

import { exportBudgetRunSchema } from "@/forms/budget"
import { requireOrg } from "@/lib/authz"
import { tenantDb } from "@/lib/db"
import { budgetRunToDocument, exportBudgetRun, type BudgetExportRun } from "@/lib/export/budget-export"
import { reportToPdf } from "@/lib/export/report-pdf"
import { getReportRun } from "@/models/reports"
import { ReportType, Role } from "@/prisma/client"
import { NextRequest, NextResponse } from "next/server"

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { org } = await requireOrg(Role.VIEWER)

  const parsed = exportBudgetRunSchema.safeParse({
    runId: request.nextUrl.searchParams.get("runId"),
    format: request.nextUrl.searchParams.get("format"),
  })
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Petición inválida" }, { status: 400 })
  }

  const run = await getReportRun(tenantDb(org.id), parsed.data.runId)
  // Un run de otra organización no se distingue de uno que no existe, y así debe
  // quedarse: la respuesta no puede confirmar su existencia.
  if (!run || run.type !== ReportType.PRESUPUESTO_REAL) {
    return NextResponse.json({ error: "El informe pedido no existe" }, { status: 404 })
  }

  const provenance = (run.provenance ?? {}) as { budgetHash?: string }
  const payload: BudgetExportRun = {
    id: run.id,
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
    ledgerHash: run.ledgerHash,
    budgetHash: (provenance.budgetHash ?? "").replace(/^sha256:/, ""),
    analyticsKey: run.analyticsKey,
    gitSha: run.gitSha,
    seal: run.seal,
    sealReasons: run.sealReasons as unknown as readonly { code: string; message: string }[],
    validation: run.validation as unknown as BudgetExportRun["validation"],
    params: run.params,
    result: (run.result ?? {}) as BudgetExportRun["result"],
  }

  if (parsed.data.format === "pdf") {
    const body = await reportToPdf(budgetRunToDocument(payload))
    return binary(body, `presupuesto-real-${run.periodStart}-${run.periodEnd}.pdf`, "application/pdf")
  }

  const file = await exportBudgetRun(payload, parsed.data.format)
  return binary(file.body, file.filename, file.contentType, file.sha256)
}

function binary(body: Buffer, filename: string, contentType: string, sha256?: string): NextResponse {
  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(body.byteLength),
      ...(sha256 ? { "X-Content-Sha256": sha256 } : {}),
    },
  })
}
