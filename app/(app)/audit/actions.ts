"use server"

/**
 * E7 · T11 — Server actions de la pestaña Auditoría y de la conciliación
 * bancaria (`docs/design/E7-auditoria.md` §4.3).
 *
 * Todas empiezan por `withOrg(<rol>)`, validan con `zod` (`forms/audit.ts`,
 * `forms/bank.ts`) y escriben su `AuditLog` **en la misma transacción** que la
 * mutación. Ninguna calcula: componen el contexto y llaman al motor puro por
 * medio de `models/`.
 *
 * ## La matriz de roles (criterio 28)
 *
 * | Acción | Rol |
 * |---|---|
 * | leer `/audit`, `/audit/bank`, cuadre, historial, diff | `VIEWER` |
 * | barrer invariantes, importar, conciliar, desconciliar, ignorar, proponer y confirmar asiento | `EDITOR` |
 * | alta y edición de cuentas, forzar/levantar revisión, barrer el almacén, prueba de detección, `AuditLog` | `ADMIN` |
 *
 * Cada negativa se comprueba **en el servidor**: la UI oculta botones, pero la
 * puerta está aquí.
 *
 * ## Lo que estas acciones NO hacen
 *
 * · **No puntean solas.** `acceptSuggestionsAction` recibe ids elegidos uno a
 *   uno y **recomputa la sugerencia en servidor** antes de escribir: entre el
 *   render y el clic, otra persona pudo conciliar el candidato (§9.3).
 * · **No tocan el diario al conciliar.** Conciliar sobre un ejercicio `CLOSED`
 *   está permitido (O-13) porque no escribe un céntimo en `journal_lines`; la
 *   propuesta de asiento sí escribe y por eso pasa por `resolveEntryDate` y se
 *   bloquea si el ejercicio no está `OPEN`.
 * · **La prueba de detección no escribe nada** (§7): inyecta el error en una
 *   copia EN MEMORIA y corre el mismo motor puro sobre ella.
 */

import {
  cancelSweepSchema,
  clearReviewAuditSchema,
  detectionTestSchema,
  diffRunsSchema,
  forceReviewAuditSchema,
  invariantRunIdSchema,
  listInvariantRunsSchema,
  runInvariantsAuditSchema,
} from "@/forms/audit"
import {
  acceptSuggestionsSchema,
  bankPanelSchema,
  confirmEntryFromLineSchema,
  createBankAccountSchema,
  createMatchGroupSchema,
  ignoreLineSchema,
  importStatementSchema,
  proposeEntryFromLineSchema,
  unmatchGroupSchema,
  updateBankAccountSchema,
} from "@/forms/bank"
import { ActionState } from "@/lib/actions"
import { withOrg } from "@/lib/authz"
import { diffRuns, type RunDiff } from "@/lib/audit/diff"
import type { MatchSuggestionRow } from "@/lib/audit/bank-match"
import type { BankReconciliationSummary } from "@/lib/audit/invariants-e7"
import { runInvariants as runInvariantsPure } from "@/lib/ledger/invariants"
import type { CheckResult, Seal } from "@/lib/ledger/invariants"
import { tenantDb, tenantTransaction } from "@/lib/db"
import type { CsvMapping } from "@/lib/bank/csv"
import type { LocalDate } from "@/lib/ledger/types"
import {
  getInvariantRun,
  latestInvariantRun,
  listInvariantRuns,
  toRunRef,
  type InvariantRunRow,
} from "@/models/audit"
import { listAuditLog } from "@/models/audit-log"
import {
  createBankAccount,
  createMatchGroup,
  getBankAccount,
  ignoreLine,
  importStatement,
  listBankAccounts,
  listStatementLines,
  listStatements,
  pendingItems,
  suggestionsForAccount,
  unmatchGroup,
  updateBankAccount,
  BankModelError,
  type BankAccountRow,
  type ImportStatementResult,
} from "@/models/bank"
import { confirmEntryFromLine, previewEntryFromLine, ProposalFromLineError, type ProposalPreviewFromLine } from "@/models/bank-proposal"
import {
  listFiscalYearRefs,
  listPeriodLockRefs,
  readInvariantEntries,
  runLedgerInvariants,
  todayLocalDate,
} from "@/models/ledger"
import { getAccountMapByKey } from "@/models/account-map"
import { clearManualReviewFlag, getStatementAccounts, setManualReviewFlag } from "@/models/reports"
import { getSweep, latestSweep, requestCancel, type StoreSweepRow } from "@/models/store-sweep"
import { Role } from "@/prisma/client"
import { revalidatePath } from "next/cache"
import { z } from "zod"

const AUDIT_PATH = "/audit"

const today = (): LocalDate => todayLocalDate()

function invalid(error: z.ZodError): ActionState<never> {
  const issue = error.issues[0]
  return { success: false, error: issue ? issue.message : "Datos inválidos" }
}

/** Traduce los errores TIPADOS del modelo a mensajes; el resto se propaga. */
function failed(error: unknown): ActionState<never> {
  if (error instanceof BankModelError || error instanceof ProposalFromLineError) {
    return { success: false, error: error.message }
  }
  if (error instanceof Error) return { success: false, error: error.message }
  throw error
}

// ─────────────────────────────────────────────────────────────────────────────
// Barrido de invariantes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **Lock consultivo de proceso** contra barridos concurrentes de la misma
 * organización (§4.3). Es de proceso y así está declarado —igual que el rate
 * limit de E8—: frena el doble clic y las dos pestañas, no sustituye a un lock
 * de base. Lo que impide que dos barridos simultáneos se pisen de verdad es que
 * `invariant_runs` es append-only: dos fotos del mismo estado son dos filas
 * idénticas salvo el id, nunca una fila corrupta.
 */
const sweeping = new Set<string>()

export type InvariantRunSummary = {
  runId: string | null
  seal: Seal
  checks: readonly CheckResult[]
  auditReasons: readonly string[]
  origen: string
}

export async function runInvariantsAction(input: unknown = {}): Promise<ActionState<InvariantRunSummary>> {
  return await withOrg(Role.EDITOR, async ({ org, user }) => {
    const validated = runInvariantsAuditSchema.safeParse(input ?? {})
    if (!validated.success) return invalid(validated.error)
    const data = validated.data

    if (sweeping.has(org.id)) {
      return { success: false, error: "Ya hay un barrido en marcha en esta organización: espera a que termine" }
    }
    sweeping.add(org.id)
    try {
      const { sha256OfStoredFile } = await import("@/lib/files-integrity")
      const run = await runLedgerInvariants(org.id, {
        refDate: data.refDate ?? today(),
        ...(data.fiscalYearId ? { fiscalYearId: data.fiscalYearId } : {}),
        actor: { userId: user.id },
        readStoredFile: sha256OfStoredFile,
        audit: true,
        noCache: true,
        ...(data.persist
          ? {
              persist: {
                trigger: "MANUAL" as const,
                scopeKind: data.scopeKind,
                periodStart: data.periodStart ?? null,
                periodEnd: data.periodEnd ?? null,
                runById: user.id,
              },
            }
          : {}),
      })
      revalidatePath(AUDIT_PATH)
      return {
        success: true,
        data: {
          runId: run.persistedRunId ?? null,
          seal: run.sello,
          checks: run.validacion.checks,
          auditReasons: run.auditReasons ?? [],
          origen: run.origen,
        },
      }
    } catch (error) {
      return failed(error)
    } finally {
      sweeping.delete(org.id)
    }
  })()
}

export async function listInvariantRunsAction(input: unknown = {}): Promise<ActionState<InvariantRunRow[]>> {
  return await withOrg(Role.VIEWER, async ({ org }) => {
    const validated = listInvariantRunsSchema.safeParse(input ?? {})
    if (!validated.success) return invalid(validated.error)
    const rows = await listInvariantRuns(tenantDb(org.id), validated.data)
    return { success: true, data: rows }
  })()
}

export async function getInvariantRunAction(input: unknown): Promise<ActionState<InvariantRunRow>> {
  return await withOrg(Role.VIEWER, async ({ org }) => {
    const validated = invariantRunIdSchema.safeParse(input)
    if (!validated.success) return invalid(validated.error)
    const row = await getInvariantRun(tenantDb(org.id), validated.data.id)
    if (!row) return { success: false, error: "Ese barrido no existe en esta organización" }
    return { success: true, data: row }
  })()
}

export async function latestInvariantRunAction(): Promise<ActionState<InvariantRunRow | null>> {
  return await withOrg(Role.VIEWER, async ({ org }) => ({
    success: true,
    data: await latestInvariantRun(tenantDb(org.id)),
  }))()
}

/** Compara **dos fotos**: qué checks cambiaron, qué cifras y **por qué** (O-19/O-20). */
export async function diffRunsAction(input: unknown): Promise<ActionState<RunDiff>> {
  return await withOrg(Role.VIEWER, async ({ org }) => {
    const validated = diffRunsSchema.safeParse(input)
    if (!validated.success) return invalid(validated.error)
    const db = tenantDb(org.id)
    const a = await getInvariantRun(db, validated.data.a)
    const b = await getInvariantRun(db, validated.data.b)
    if (!a || !b) return { success: false, error: "Alguno de los dos barridos no existe en esta organización" }
    return { success: true, data: diffRuns(toRunRef(a), toRunRef(b)) }
  })()
}

// ─────────────────────────────────────────────────────────────────────────────
// Revisión manual (E6, con lo que E7 le añade)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **ADMIN.** Permitida explícitamente **sobre un ejercicio `CLOSED`** (O-21):
 * descubrir un error después del cierre es justo cuando se fuerza una revisión.
 */
export async function forceReviewAction(input: unknown): Promise<ActionState<{ id: string }>> {
  return await withOrg(Role.ADMIN, async ({ org, user }) => {
    const validated = forceReviewAuditSchema.safeParse(input)
    if (!validated.success) return invalid(validated.error)
    try {
      const flag = await setManualReviewFlag(org.id, validated.data, { userId: user.id })
      revalidatePath(AUDIT_PATH)
      return { success: true, data: { id: flag.id } }
    } catch (error) {
      return failed(error)
    }
  })()
}

export async function clearReviewAction(input: unknown): Promise<ActionState<{ id: string }>> {
  return await withOrg(Role.ADMIN, async ({ org, user }) => {
    const validated = clearReviewAuditSchema.safeParse(input)
    if (!validated.success) return invalid(validated.error)
    try {
      const flag = await clearManualReviewFlag(org.id, validated.data, { userId: user.id })
      revalidatePath(AUDIT_PATH)
      return { success: true, data: { id: flag.id } }
    } catch (error) {
      return failed(error)
    }
  })()
}

// ─────────────────────────────────────────────────────────────────────────────
// Barrido del almacén (T10)
// ─────────────────────────────────────────────────────────────────────────────

export async function runStoreSweepAction(): Promise<ActionState<{ sweepId: string; progressId: string }>> {
  return await withOrg(Role.ADMIN, async ({ org, user }) => {
    try {
      const { enqueueStoreSweep } = await import("@/ai/store-sweep")
      const { sweepId, progressId } = await enqueueStoreSweep(org.id, { userId: user.id })
      revalidatePath(AUDIT_PATH)
      return { success: true, data: { sweepId, progressId } }
    } catch (error) {
      return failed(error)
    }
  })()
}

export async function cancelStoreSweepAction(input: unknown): Promise<ActionState<StoreSweepRow>> {
  return await withOrg(Role.ADMIN, async ({ org, user }) => {
    const validated = cancelSweepSchema.safeParse(input)
    if (!validated.success) return invalid(validated.error)
    try {
      const row = await requestCancel(org.id, validated.data.id, { userId: user.id })
      revalidatePath(AUDIT_PATH)
      return { success: true, data: row }
    } catch (error) {
      return failed(error)
    }
  })()
}

export async function sweepStatusAction(input: unknown = {}): Promise<ActionState<StoreSweepRow | null>> {
  return await withOrg(Role.VIEWER, async ({ org }) => {
    const parsed = z.object({ id: z.string().uuid().optional() }).safeParse(input ?? {})
    if (!parsed.success) return invalid(parsed.error)
    const db = tenantDb(org.id)
    const row = parsed.data.id ? await getSweep(db, parsed.data.id) : await latestSweep(db)
    return { success: true, data: row }
  })()
}

// ─────────────────────────────────────────────────────────────────────────────
// Cuentas bancarias
// ─────────────────────────────────────────────────────────────────────────────

export async function listBankAccountsAction(): Promise<ActionState<BankAccountRow[]>> {
  return await withOrg(Role.VIEWER, async ({ org }) => ({
    success: true,
    data: await listBankAccounts(tenantDb(org.id)),
  }))()
}

export async function createBankAccountAction(input: unknown): Promise<ActionState<{ id: string; anchorDiffCents: number | null }>> {
  return await withOrg(Role.ADMIN, async ({ org, user }) => {
    const validated = createBankAccountSchema.safeParse(input)
    if (!validated.success) return invalid(validated.error)
    try {
      const { account, anchorContrast } = await createBankAccount(
        org.id,
        { ...validated.data, csvMapping: validated.data.csvMapping ?? null },
        { userId: user.id }
      )
      revalidatePath("/audit/bank")
      return { success: true, data: { id: account.id, anchorDiffCents: anchorContrast?.diffCents ?? null } }
    } catch (error) {
      return failed(error)
    }
  })()
}

export async function updateBankAccountAction(input: unknown): Promise<ActionState<{ id: string }>> {
  return await withOrg(Role.ADMIN, async ({ org, user }) => {
    const validated = updateBankAccountSchema.safeParse(input)
    if (!validated.success) return invalid(validated.error)
    const { id, reason, ...patch } = validated.data
    try {
      const account = await updateBankAccount(org.id, id, patch, { userId: user.id }, reason)
      revalidatePath("/audit/bank")
      return { success: true, data: { id: account.id } }
    } catch (error) {
      return failed(error)
    }
  })()
}

// ─────────────────────────────────────────────────────────────────────────────
// Extractos
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tamaño máximo del extracto. Un N43 de un año no llega a 5 MB.
 *
 * **No se exporta** (E7 · T16): un fichero `"use server"` sólo puede exportar
 * funciones asíncronas, y en cuanto un componente de cliente importa de aquí,
 * exportar una constante rompe la pantalla entera en tiempo de ejecución.
 */
const MAX_STATEMENT_BYTES = 8 * 1024 * 1024

/**
 * Importa un extracto. **EDITOR.** Valida tamaño, calcula el `sha256` en
 * servidor, parsea y corre **I-E7-5, I-E7-6a y la comprobación de divisa ANTES
 * de escribir**: un fichero que no cuadra se rechaza entero.
 */
export async function importStatementAction(formData: FormData): Promise<ActionState<ImportStatementResult>> {
  return await withOrg(Role.EDITOR, async ({ org, user }) => {
    const file = formData.get("file")
    const validated = importStatementSchema.safeParse({
      bankAccountId: formData.get("bankAccountId"),
      format: formData.get("format"),
      fileName: file instanceof File ? file.name : String(formData.get("fileName") ?? ""),
    })
    if (!validated.success) return invalid(validated.error)
    if (!(file instanceof File)) return { success: false, error: "No se ha recibido ningún fichero" }
    if (file.size === 0) return { success: false, error: "El fichero está vacío" }
    if (file.size > MAX_STATEMENT_BYTES) {
      return { success: false, error: `El fichero pesa más de ${Math.round(MAX_STATEMENT_BYTES / 1024 / 1024)} MB` }
    }

    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const account = await getBankAccount(tenantDb(org.id), validated.data.bankAccountId)
      if (!account) return { success: false, error: "La cuenta bancaria no existe en esta organización" }
      const result = await importStatement(
        org.id,
        {
          bankAccountId: validated.data.bankAccountId,
          fileName: validated.data.fileName,
          bytes,
          format: validated.data.format,
          ...(validated.data.format === "CSV" ? { mapping: (account.csvMapping ?? undefined) as CsvMapping | undefined } : {}),
        },
        { userId: user.id }
      )
      revalidatePath("/audit/bank")
      return { success: true, data: result }
    } catch (error) {
      return failed(error)
    }
  })()
}

// ─────────────────────────────────────────────────────────────────────────────
// Conciliación
// ─────────────────────────────────────────────────────────────────────────────

export type BankPanel = {
  account: BankAccountRow
  summary: BankReconciliationSummary | null
  suggestions: readonly MatchSuggestionRow[]
}

/** Lectura del panel: cuadre, pendientes tipados y sugerencias. **VIEWER.** */
export async function bankPanelAction(input: unknown): Promise<ActionState<BankPanel>> {
  return await withOrg(Role.VIEWER, async ({ org, user }) => {
    const validated = bankPanelSchema.safeParse(input)
    if (!validated.success) return invalid(validated.error)
    const cutoff = validated.data.cutoff ?? today()
    try {
      return await tenantTransaction(org.id, user.id, async (tx) => {
        const account = await getBankAccount(tx, validated.data.bankAccountId)
        if (!account) return { success: false as const, error: "La cuenta bancaria no existe en esta organización" }
        const organization = await tx.organization.findFirstOrThrow({ select: { baseCurrency: true } })
        const [summary] = await pendingItems(tx, {
          cutoff,
          baseCurrency: organization.baseCurrency,
          bankAccountId: account.id,
        })
        const suggestions = await suggestionsForAccount(tx, { bankAccountId: account.id, cutoff })
        return { success: true as const, data: { account, summary: summary ?? null, suggestions } }
      })
    } catch (error) {
      return failed(error)
    }
  })()
}

export async function createMatchGroupAction(input: unknown): Promise<ActionState<{ groupId: string; kind: string }>> {
  return await withOrg(Role.EDITOR, async ({ org, user }) => {
    const validated = createMatchGroupSchema.safeParse(input)
    if (!validated.success) return invalid(validated.error)
    try {
      const result = await tenantTransaction(org.id, user.id, async (tx) =>
        createMatchGroup(
          tx,
          {
            bankAccountId: validated.data.bankAccountId,
            statementLineIds: validated.data.statementLineIds,
            journalLineIds: validated.data.journalLineIds,
            note: validated.data.note ?? null,
            method: "MANUAL",
          },
          { userId: user.id }
        )
      )
      revalidatePath("/audit/bank")
      return { success: true, data: { groupId: result.groupId, kind: result.kind } }
    } catch (error) {
      return failed(error)
    }
  })()
}

/**
 * Acepta N sugerencias **elegidas explícitamente**. Antes de escribir, la
 * sugerencia se **recomputa en servidor**: si entre el render y el clic otra
 * persona concilió el candidato, la línea se devuelve con su motivo en vez de
 * conciliarse contra un apunte que ya no está libre (§9.3).
 */
export async function acceptSuggestionsAction(
  input: unknown
): Promise<ActionState<{ accepted: string[]; rejected: { statementLineId: string; reason: string }[] }>> {
  return await withOrg(Role.EDITOR, async ({ org, user }) => {
    const validated = acceptSuggestionsSchema.safeParse(input)
    if (!validated.success) return invalid(validated.error)
    const cutoff = validated.data.cutoff ?? today()
    try {
      const outcome = await tenantTransaction(org.id, user.id, async (tx) => {
        const rows = await suggestionsForAccount(tx, { bankAccountId: validated.data.bankAccountId, cutoff })
        const byLine = new Map(rows.map((r) => [r.statementLineId, r]))
        const accepted: string[] = []
        const rejected: { statementLineId: string; reason: string }[] = []

        for (const statementLineId of validated.data.statementLineIds) {
          const row = byLine.get(statementLineId)
          if (!row || row.candidates.length === 0) {
            rejected.push({
              statementLineId,
              reason: "ya no hay sugerencia para esa línea: otra persona la concilió o el apunte dejó de estar libre",
            })
            continue
          }
          if (row.ambiguous) {
            rejected.push({ statementLineId, reason: "la sugerencia es ambigua: elige tú el apunte (empate ⇒ ninguna sugerencia)" })
            continue
          }
          const candidate = row.candidates[0]
          try {
            await createMatchGroup(
              tx,
              {
                bankAccountId: validated.data.bankAccountId,
                statementLineIds: [statementLineId],
                journalLineIds: candidate.journalLineIds,
                method: "SUGGESTION_ACCEPTED",
                scoreBps: candidate.scoreBps,
              },
              { userId: user.id }
            )
            accepted.push(statementLineId)
          } catch (error) {
            rejected.push({ statementLineId, reason: error instanceof Error ? error.message : "no se pudo conciliar" })
          }
        }
        return { accepted, rejected }
      })
      revalidatePath("/audit/bank")
      return { success: true, data: outcome }
    } catch (error) {
      return failed(error)
    }
  })()
}

export async function unmatchGroupAction(input: unknown): Promise<ActionState<{ groupId: string }>> {
  return await withOrg(Role.EDITOR, async ({ org, user }) => {
    const validated = unmatchGroupSchema.safeParse(input)
    if (!validated.success) return invalid(validated.error)
    try {
      const result = await tenantTransaction(org.id, user.id, async (tx) =>
        unmatchGroup(tx, validated.data, { userId: user.id })
      )
      revalidatePath("/audit/bank")
      return { success: true, data: { groupId: result.groupId } }
    } catch (error) {
      return failed(error)
    }
  })()
}

export async function ignoreLineAction(input: unknown): Promise<ActionState<{ id: string }>> {
  return await withOrg(Role.EDITOR, async ({ org, user }) => {
    const validated = ignoreLineSchema.safeParse(input)
    if (!validated.success) return invalid(validated.error)
    try {
      await tenantTransaction(org.id, user.id, async (tx) =>
        ignoreLine(
          tx,
          { id: validated.data.id, reason: validated.data.reason, evidenceId: validated.data.evidenceId ?? null },
          { userId: user.id }
        )
      )
      revalidatePath("/audit/bank")
      return { success: true, data: { id: validated.data.id } }
    } catch (error) {
      return failed(error)
    }
  })()
}

// ─────────────────────────────────────────────────────────────────────────────
// T23 — propuesta de asiento desde el extracto
// ─────────────────────────────────────────────────────────────────────────────

export async function proposeEntryFromLineAction(input: unknown): Promise<ActionState<ProposalPreviewFromLine>> {
  return await withOrg(Role.EDITOR, async ({ org, user }) => {
    const validated = proposeEntryFromLineSchema.safeParse(input)
    if (!validated.success) return invalid(validated.error)
    try {
      const preview = await tenantTransaction(org.id, user.id, async (tx) => {
        const organization = await tx.organization.findFirstOrThrow()
        return await previewEntryFromLine(tx, organization, { ...validated.data, refDate: today() })
      })
      return { success: true, data: preview }
    } catch (error) {
      return failed(error)
    }
  })()
}

/**
 * Confirma la propuesta: **asiento y conciliación en la misma transacción**. Si
 * el devengo cae en un ejercicio que no está `OPEN`, `resolveEntryDate` lo
 * bloquea y no se escribe nada (O-13).
 */
export async function confirmEntryFromLineAction(
  input: unknown
): Promise<ActionState<{ entryId: string; entryNumber: number; groupId: string }>> {
  return await withOrg(Role.EDITOR, async ({ org, user }) => {
    const validated = confirmEntryFromLineSchema.safeParse(input)
    if (!validated.success) return invalid(validated.error)
    try {
      const result = await tenantTransaction(org.id, user.id, async (tx) => {
        const organization = await tx.organization.findFirstOrThrow()
        return await confirmEntryFromLine(
          tx,
          organization,
          { ...validated.data, refDate: today() },
          { userId: user.id }
        )
      })
      revalidatePath("/audit/bank")
      revalidatePath("/ledger")
      return { success: true, data: result }
    } catch (error) {
      return failed(error)
    }
  })()
}

// ─────────────────────────────────────────────────────────────────────────────
// Prueba de detección (§7) y registro
// ─────────────────────────────────────────────────────────────────────────────

export type DetectionTestResult = {
  /** Marcado `PRUEBA`: no es un barrido y no se persiste. */
  kind: "PRUEBA"
  entryId: string
  lineNo: number
  alteredCents: number
  before: readonly CheckResult[]
  after: readonly CheckResult[]
  /** Ids que pasan de PASS a FAIL: la demostración. */
  detectedBy: string[]
}

/**
 * **ADMIN.** El error se inyecta en una **copia en memoria** de la entrada del
 * motor —nunca en `journal_lines`— y se corre el **mismo** motor puro sobre
 * ella. La línea alterada se elige de forma **determinista** (la primera por
 * `(entryDate, entryNumber, lineNo)`), con la semilla a la vista: elegir «una
 * cualquiera» hacía que el resultado dependiera del orden de los uuid (lección
 * del flaky del criterio 15 de E6).
 *
 * La variante destructiva —`UPDATE` real como `app_maintenance`— vive en los
 * tests, que es donde tiene que estar (R6).
 */
export async function detectionTestAction(input: unknown = {}): Promise<ActionState<DetectionTestResult>> {
  return await withOrg(Role.ADMIN, async ({ org, user }) => {
    const validated = detectionTestSchema.safeParse(input ?? {})
    if (!validated.success) return invalid(validated.error)
    const refDate = validated.data.refDate ?? today()

    try {
      const result = await tenantTransaction(org.id, user.id, async (tx) => {
        const entries = await readInvariantEntries(tx, validated.data.fiscalYearId)
        if (entries.length === 0) {
          return { ok: false as const, error: "No hay asientos en el alcance: no hay nada que probar" }
        }
        const fiscalYears = await listFiscalYearRefs(tx)
        const periodLocks = await listPeriodLockRefs(tx)
        const accounts = (await tx.ledgerAccount.findMany({ select: { code: true, isPostable: true, isActive: true } })).map(
          (a) => ({ ...a, organizationId: org.id })
        )

        /**
         * **E7 · T12/T13 — cierra la deuda de la ola B.** Sin el bloque de
         * informes, la prueba demostraba la detección con I1 y el sello de fila
         * I-E3-7, pero **I2 no participaba**: el balance no se construía, así
         * que un céntimo de más en el activo no se veía descuadrar. El bloque se
         * arma con las MISMAS líneas que el motor ya tiene delante —una
         * `ReportLine` es una línea de asiento con su cabecera—, de modo que la
         * alteración de la copia se propaga a los dos bloques a la vez y no hay
         * una segunda lectura que pudiera discrepar.
         */
        const statementAccounts = await getStatementAccounts(tx)
        const accountMap = await getAccountMapByKey(tx)
        const resultAccountCode = accountMap.get("RESULTADO_EJERCICIO") ?? "129"
        const dates = entries.map((entry) => entry.entryDate).sort()
        const { baseCurrency } = await tx.organization.findFirstOrThrow({ select: { baseCurrency: true } })
        const reportsOf = (source: readonly (typeof entries)[number][]) => ({
          lines: source.flatMap((entry) =>
            entry.lines.map((line) => ({
              entryId: entry.id,
              entryNumber: entry.entryNumber,
              entryDate: entry.entryDate,
              entryKind: entry.kind,
              fiscalYearId: entry.fiscalYearId,
              lineNo: line.lineNo,
              accountCode: line.accountCode,
              debitCents: line.debitCents,
              creditCents: line.creditCents,
              description: line.description ?? null,
            }))
          ),
          accounts: statementAccounts,
          resultAccountCode,
          organizationId: org.id,
          from: dates[0] ?? refDate,
          to: dates[dates.length - 1] ?? refDate,
          baseCurrency,
        })

        const base = {
          runId: "prueba-de-deteccion",
          gitSha: process.env.GIT_SHA ?? "desconocido",
          organizationId: org.id,
          ledgerHash: "0".repeat(64),
          fiscalYears,
          periodLocks,
          accounts,
        }
        const before = runInvariantsPure({ ...base, entries, reports: reportsOf(entries) }, refDate).checks

        // La copia: se ordena de forma determinista y se altera UN céntimo.
        const sorted = [...entries].sort((a, b) =>
          a.entryDate === b.entryDate ? a.entryNumber - b.entryNumber : a.entryDate < b.entryDate ? -1 : 1
        )
        const target = sorted[0]
        const copy = entries.map((entry) =>
          entry.id === target.id
            ? {
                ...entry,
                lines: entry.lines.map((line, index) =>
                  index === 0 ? { ...line, debitCents: line.debitCents + 1 } : line
                ),
              }
            : entry
        )
        const after = runInvariantsPure({ ...base, entries: copy, reports: reportsOf(copy) }, refDate).checks

        const beforeById = new Map(before.map((c) => [c.id, c.status]))
        const detectedBy = after
          .filter((c) => c.status === "FAIL" && beforeById.get(c.id) !== "FAIL")
          .map((c) => c.id)

        await import("@/models/audit-log").then(({ writeAuditLog }) =>
          writeAuditLog(tx, {
            entity: "InvariantRun",
            entityId: target.id,
            action: "DETECTION_TEST",
            after: { entryId: target.id, alteredCents: 1, detectedBy, escrito: false },
            userId: user.id,
          })
        )

        return {
          ok: true as const,
          data: {
            kind: "PRUEBA" as const,
            entryId: target.id,
            lineNo: target.lines[0]?.lineNo ?? 1,
            alteredCents: 1,
            before,
            after,
            detectedBy,
          },
        }
      })
      if (!result.ok) return { success: false, error: result.error }
      return { success: true, data: result.data }
    } catch (error) {
      return failed(error)
    }
  })()
}

/** El registro completo es **ADMIN** (fuga de gobierno si lo ve un EDITOR). */
export async function auditLogAction(input: unknown = {}): Promise<ActionState<unknown[]>> {
  return await withOrg(Role.ADMIN, async ({ org }) => {
    const parsed = z
      .object({ entity: z.string().optional(), take: z.number().int().min(1).max(200).default(50) })
      .safeParse(input ?? {})
    if (!parsed.success) return invalid(parsed.error)
    const rows = await listAuditLog(tenantDb(org.id), {
      ...(parsed.data.entity ? { entity: parsed.data.entity as never } : {}),
      take: parsed.data.take,
    })
    return { success: true, data: rows }
  })()
}

/** Extractos y líneas de una cuenta, para la pantalla. **VIEWER.** */
export async function statementLinesAction(input: unknown): Promise<ActionState<unknown>> {
  return await withOrg(Role.VIEWER, async ({ org }) => {
    const parsed = z
      .object({ bankAccountId: z.string().uuid(), take: z.number().int().min(1).max(1000).default(500) })
      .safeParse(input)
    if (!parsed.success) return invalid(parsed.error)
    const db = tenantDb(org.id)
    const statements = await listStatements(db, { bankAccountId: parsed.data.bankAccountId })
    const lines = await listStatementLines(db, { bankAccountId: parsed.data.bankAccountId, take: parsed.data.take })
    return { success: true, data: { statements, lines } }
  })()
}
