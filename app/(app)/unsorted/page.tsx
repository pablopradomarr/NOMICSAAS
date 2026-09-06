import { InboxTable } from "@/components/unsorted/inbox-table"
import { INBOX_STATUS_LABEL, type InboxRowView, type InboxStatus } from "@/components/unsorted/types"
import { Button } from "@/components/ui/button"
import { UploadButton } from "@/components/files/upload-button"
import { tenantTransaction } from "@/lib/db"
import { tenantPage } from "@/lib/page-tenant"
import { countPendingByStatus, listInboxWithLatestRun } from "@/models/extraction"
import { Role, type ReconcileStatus } from "@/prisma/client"
import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = {
  title: "Bandeja de documentos",
  description: "Documentos pendientes de contabilizar, con el estado de su última extracción",
}

/**
 * E8 · T15 — Bandeja (`/unsorted`, §6).
 *
 * Sustituye a la pantalla heredada de TaxHacker, que pintaba un formulario de
 * análisis por fichero y hacía una consulta por fila. Aquí el listado es una
 * tabla densa con el estado del último run, y las cifras que enseña —el total
 * del documento— son las que el run selló, no un recálculo de pantalla.
 *
 * **Sin N+1** (§9, estándar de calidad): tres consultas fijas, independientes
 * del número de ficheros —la bandeja con su `DISTINCT ON`, los veredictos
 * sellados de los runs listados y el recuento de extracciones por fichero—, más
 * la agregada de los contadores de cabecera.
 *
 * Lecturas en SERIE: `tenantPage` abre UNA transacción para todo el render.
 */

/** Veredicto sellado del run, tal y como lo escribió `sealedReconcile`. */
type SealedDetail = {
  status?: string
  elegibleParaLote?: boolean
  checks?: { id: string; status: string; blocksBatch: boolean; message: string }[]
}

const STATUS_FILTERS: readonly { value: string; label: string }[] = [
  { value: "", label: "Todos" },
  { value: "SIN_RUN", label: "Sin analizar" },
  { value: "PASS", label: "Conformes" },
  { value: "WARN", label: "Con avisos" },
  { value: "FAIL", label: "No conformes" },
]

export default tenantPage<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>(
  async ({ db, role, searchParams }) => {
    const params = await searchParams
    const statusParam = typeof params.status === "string" ? params.status : ""
    const canEdit = role === Role.EDITOR || role === Role.ADMIN

    /**
     * `listInboxWithLatestRun` y `countPendingByStatus` resuelven la bandeja con SQL
     * crudo (`DISTINCT ON`, `COUNT(*) FILTER`), y el SQL crudo **no pasa por la
     * extensión de tenant**: sólo ve `app.current_org` si se ejecuta sobre el
     * cliente de una transacción de tenant (límite #2 documentado en `lib/db.ts`).
     * Llamadas con el `db` acotado a secas, RLS las deja en cero filas —sin error, y
     * ése es justo el modo de fallo que el proyecto declara peligroso—. Por eso van
     * envueltas: dentro de `tenantPage` la transacción ya está abierta, así que
     * `tenantTransaction` la REUTILIZA y no abre ninguna conexión más.
     */
    const counts = await tenantTransaction(db.$organizationId, async (tx) => await countPendingByStatus(tx))
    const inbox = await tenantTransaction(
      db.$organizationId,
      async (tx) =>
        await listInboxWithLatestRun(tx, {
          limit: 200,
          ...(statusParam === "" ? {} : { status: statusParam as ReconcileStatus | "SIN_RUN" }),
        })
    )

    const runIds = inbox.rows.map((row) => row.runId).filter((id): id is string => Boolean(id))
    const sealed = runIds.length
      ? await db.extractionRun.findMany({
          where: { id: { in: runIds } },
          select: { id: true, reconcile: true },
        })
      : []
    const sealedById = new Map(sealed.map((run) => [run.id, (run.reconcile as SealedDetail | null) ?? null]))

    const fileIds = inbox.rows.map((row) => row.fileId)
    const runCounts = fileIds.length
      ? await db.extractionRun.groupBy({ by: ["fileId"], where: { fileId: { in: fileIds } }, _count: { _all: true } })
      : []
    const runCountByFile = new Map(runCounts.map((row) => [row.fileId, row._count._all]))

    const rows: InboxRowView[] = inbox.rows.map((row) => {
      const detail = (row.runId ? sealedById.get(row.runId) : null) ?? null
      const status = statusOf(row.runKind, row.reconcileStatus, row.partial)
      const motivo = ineligibilityOf(status, detail)
      return {
        fileId: row.fileId,
        filename: row.filename,
        mimetype: row.mimetype,
        uploadedAt: row.fileCreatedAt.toISOString(),
        sha256: row.sha256,
        runId: row.runId,
        runCount: runCountByFile.get(row.fileId) ?? 0,
        runCreatedAt: row.runCreatedAt ? row.runCreatedAt.toISOString() : null,
        status,
        docKind: row.docKind,
        documentNumber: row.documentNumber,
        totalCents: row.totalCents,
        currency: row.currency,
        elegibleParaLote: motivo === null,
        motivoNoElegible: motivo,
      }
    })

    return (
      <div className="space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Bandeja de documentos</h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Documentos subidos y todavía sin contabilizar, con el veredicto de su última extracción. Ninguna cifra de
              esta pantalla la ha calculado un modelo: lo que se ve es lo que el documento dice y lo que{" "}
              <span className="font-code">reconcile()</span> ha podido comprobar contra el plan, los tipos vigentes y la
              ficha del tercero.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/unsorted/batch">Confirmación por lote</Link>
            </Button>
            {canEdit && <UploadButton size="sm">Subir documento</UploadButton>}
          </div>
        </header>

        <section className="flex flex-wrap gap-3" data-testid="inbox-counters">
          <Counter label="Sin analizar" value={counts.sinRun} />
          <Counter label={INBOX_STATUS_LABEL.PASS} value={counts.pass} />
          <Counter label={INBOX_STATUS_LABEL.WARN} value={counts.warn} />
          <Counter label={INBOX_STATUS_LABEL.FAIL} value={counts.fail} />
          <Counter label="Extracción parcial" value={counts.partial} />
          <Counter label="Pendientes en total" value={counts.total} />
        </section>

        <nav className="flex flex-wrap gap-2" aria-label="Filtro por estado">
          {STATUS_FILTERS.map((filter) => (
            <Link
              key={filter.value || "todos"}
              href={filter.value === "" ? "/unsorted" : `/unsorted?status=${filter.value}`}
              data-testid={`filter-${filter.value || "todos"}`}
              className={
                statusParam === filter.value
                  ? "rounded-md bg-[#0A0A0A] px-2 py-1 text-xs text-white"
                  : "rounded-md border px-2 py-1 text-xs hover:bg-muted"
              }
            >
              {filter.label}
            </Link>
          ))}
        </nav>

        {rows.length === 0 ? (
          <div className="rounded-md border border-dashed px-6 py-16 text-center" data-testid="inbox-empty">
            <p className="text-sm font-medium">No hay documentos pendientes con este filtro.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Suba una factura o un ticket y quedará aquí hasta que alguien lo revise y lo contabilice.
            </p>
            <div className="mt-6 flex justify-center gap-2">
              {canEdit && <UploadButton size="sm">Subir documento</UploadButton>}
              <Button asChild variant="outline" size="sm">
                <Link href="/ledger">Ir al libro diario</Link>
              </Button>
            </div>
          </div>
        ) : (
          <InboxTable rows={rows} canEdit={canEdit} />
        )}
      </div>
    )
  }
)

function Counter({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-[8rem] rounded-md border px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  )
}

function statusOf(runKind: string | null, reconcileStatus: string | null, partial: boolean | null): InboxStatus {
  if (runKind === null) return "SIN_ANALIZAR"
  if (runKind === "IMPORTED") return "IMPORTADO"
  if (partial) return "PARCIAL"
  if (reconcileStatus === "PASS" || reconcileStatus === "WARN" || reconcileStatus === "FAIL") return reconcileStatus
  return "SIN_ANALIZAR"
}

/**
 * Por qué un documento **no** entra en el lote, con el mismo criterio que
 * `batchIneligibility` aplica en el servidor al confirmarlo: run parcial, FAIL,
 * cualquier check con `blocksBatch` o una decisión individual pendiente. Se lee
 * del veredicto ya sellado; no se recalcula nada.
 */
function ineligibilityOf(status: InboxStatus, detail: SealedDetail | null): string | null {
  if (status === "SIN_ANALIZAR") return "sin analizar"
  if (status === "IMPORTADO") return "importado sin origen: no respalda ningún asiento"
  if (status === "PARCIAL") return "extracción parcial: hay que revisar y teclear las cifras"
  if (status === "FAIL") return "la propuesta no está reconciliada"
  const blocking = (detail?.checks ?? []).filter((check) => check.blocksBatch)
  if (blocking.length > 0) return `bloquean el lote: ${blocking.map((check) => check.id).join(", ")}`
  if (detail?.elegibleParaLote === false) return "exige una decisión individual"
  return null
}
