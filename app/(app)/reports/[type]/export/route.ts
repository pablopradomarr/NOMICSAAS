/**
 * E6 · T15 — Descarga de un informe ya emitido: `GET
 * /reports/<tipo>/export?format=csv|xlsx|pdf&runId=…`.
 *
 * Es un **route handler** y no una server action porque devuelve un BINARIO: una
 * server action lo tendría que serializar a base64 y el navegador acabaría
 * reconstruyendo el fichero a mano.
 *
 * Rol mínimo `VIEWER`: exportar es leer. No recalcula nada — sirve la foto
 * congelada del `ReportRun`, que es lo único que el sello acredita.
 */

import { NextRequest, NextResponse } from "next/server"

import { requireOrg } from "@/lib/authz"
import { tenantDb } from "@/lib/db"
import { exportReportSchema } from "@/forms/reports"
import { exportRun, runToDocument, type ExportFormat } from "@/lib/export/report-export"
import { reportToPdf } from "@/lib/export/report-pdf"
import { NOTA_NO_COMPENSACION } from "@/lib/ledger/reports/balance"
import { CASHFLOW_HEADER_NOTE } from "@/lib/ledger/reports/cashflow"
import { AGING_GROUPING_NOTE } from "@/lib/ledger/reports/aging"
import { getReportRun } from "@/models/reports"
import { ReportType, Role } from "@/prisma/client"

function notesFor(type: ReportType): string[] {
  if (type === ReportType.BALANCE) return [NOTA_NO_COMPENSACION]
  // E7 · ADR-0015 D4: `CASHFLOW` unificado (el método viaja en `params`). Los
  // dos tipos viejos siguen declarados en el enum —PostgreSQL no permite
  // retirar un valor— y aquí se conservan para que un `ReportRun` histórico que
  // aún no haya migrado siga exportándose con su nota al pie.
  if (type === ReportType.CASHFLOW || type === ReportType.CASHFLOW_DIRECTO || type === ReportType.CASHFLOW_INDIRECTO) {
    return [CASHFLOW_HEADER_NOTE]
  }
  if (type === ReportType.DASHBOARD) return [AGING_GROUPING_NOTE]
  return []
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { org } = await requireOrg(Role.VIEWER)

  const parsed = exportReportSchema.safeParse({
    runId: request.nextUrl.searchParams.get("runId"),
    format: request.nextUrl.searchParams.get("format"),
  })
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Petición inválida" }, { status: 400 })
  }

  const run = await getReportRun(tenantDb(org.id), parsed.data.runId)
  // Un run de otra organización no se distingue de uno que no existe, y así debe
  // quedarse: la respuesta no puede confirmar su existencia.
  if (!run) return NextResponse.json({ error: "El informe pedido no existe" }, { status: 404 })

  const payload = {
    id: run.id,
    type: run.type,
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
    ledgerHash: run.ledgerHash,
    gitSha: run.gitSha,
    seal: run.seal,
    sealReasons: run.sealReasons,
    validation: run.validation,
    provenance: run.provenance,
    result: run.result,
    params: run.params,
  }
  const notes = notesFor(run.type)
  const format = parsed.data.format as ExportFormat

  if (format === "pdf") {
    const body = await reportToPdf(runToDocument(payload, notes))
    return binary(body, `${slug(run)}.pdf`, "application/pdf")
  }

  const file = await exportRun(payload, format, notes)
  return binary(file.body, file.filename, file.contentType, file.sha256)
}

const slug = (run: { type: string; periodStart: string; periodEnd: string }): string =>
  `${run.type}-${run.periodStart}-${run.periodEnd}`.toLowerCase()

function binary(body: Buffer, filename: string, contentType: string, sha256?: string): NextResponse {
  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(body.byteLength),
      // El hash viaja en la cabecera: quien reciba el fichero por correo puede
      // comprobar que es el que salió del ERP sin volver a entrar.
      ...(sha256 ? { "X-Report-Sha256": sha256 } : {}),
      "Cache-Control": "private, no-store",
    },
  })
}
