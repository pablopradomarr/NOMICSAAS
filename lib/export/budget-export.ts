/**
 * E10 · T13 — Export CSV / XLSX / PDF de **presupuesto vs real** (§5.1).
 *
 * Reutiliza el motor de E6 sin cambiarlo: `ExportDocument` → `reportToCsv` /
 * `reportToXlsx` / `reportToPdfModel`, con el mismo `sha256` estable y la misma
 * fecha fija dentro del zip. Lo único propio es **qué hojas lleva**, y son tres
 * cosas que el informe de presupuesto necesita y los de E6 no:
 *
 *  1. La hoja de **Procedencia con TRES consultas** (P6): una celda de
 *     desviación no se reproduce con una sola. El real sale de `journal_lines`,
 *     lo imputado de `allocation_lines` y el presupuesto de `budget_lines`, y
 *     los tres sellos (`ledgerHash`, `budgetHash`, `analyticsKey`) viajan juntos.
 *  2. La **procedencia del presupuesto mes a mes** (O-E10-9): con versiones
 *     parciales, decir de qué versión sale cada mes no es un adorno — un año
 *     compuesto a medias sin declararlo es un año mal sumado.
 *  3. Las celdas **no comparables** (I-E10-18) salen VACÍAS con su leyenda, y
 *     las que no tienen presupuesto también: **nunca a cero**, que es una cifra
 *     y afirmaría algo falso (misma regla que el comparativo de ADR-0012).
 *
 * Módulo sin IO propio: recibe el `result` ya sellado del `ReportRun` y devuelve
 * bytes. Dos exports del mismo run dan **el mismo sha256**.
 */

import { createHash } from "node:crypto"

import {
  reportToCsv,
  reportToPdfModel,
  reportToXlsx,
  type ExportDocument,
  type ExportFormat,
  type ExportSheet,
  type ExportedFile,
} from "@/lib/export/report-export"

/** Lo que el route handler saca del `ReportRun` de presupuesto vs real. */
export type BudgetExportRun = {
  id: string
  periodStart: string
  periodEnd: string
  ledgerHash: string
  budgetHash: string
  analyticsKey: string
  gitSha: string
  seal: string
  sealReasons: readonly { code: string; message: string }[]
  validation: { checks: readonly { id: string; status: string; evidencia: string }[] }
  params: Record<string, unknown>
  result: {
    granularity?: string
    withAllocations?: boolean
    budgetComposition?: Record<string, string>
    budgetAllocationState?: string
    notSettleableReason?: string | null
    variance?: readonly BudgetVarianceRow[]
    profitability?: readonly BudgetProfitabilityExportRow[]
    absorption?: { absorptionCents?: number; absorptionBps?: number | null; direction?: string } | null
    monthsWithoutBudget?: readonly string[]
    openMonths?: readonly string[]
  }
}

export type BudgetVarianceRow = {
  level: string
  column: string
  month: string | null
  actualCents: number
  budgetCents: number | null
  varianceCents: number | null
  varianceBps: number | null
  forecastCents: number | null
  notComparable: boolean
}

export type BudgetProfitabilityExportRow = {
  projectCode: string
  actualMinutes: number
  budgetMinutes: number | null
  minutesVariance: number | null
  hourlyCostCents: number | null
  basis: string | null
  notEvaluableReason: string | null
  marginPerHourMc2Cents: number | null
  marginPerHourMc3Cents: number | null
  billedRatePerHourCents: number | null
}

/**
 * Celda vacía **con leyenda**, nunca un cero. El cero es una cifra y aquí
 * significaría «desviación nula», que es justo lo contrario de «no hay
 * presupuesto con el que comparar».
 */
const EMPTY_CELL = "—"

const cell = (value: number | null): number | string => (value === null ? EMPTY_CELL : value)

/** `hh:mm` a partir de minutos enteros (Q-2). 440 minutos son `7:20`, exacto. */
export function minutesToHhMm(minutes: number | null): string {
  if (minutes === null) return EMPTY_CELL
  const sign = minutes < 0 ? "-" : ""
  const abs = Math.abs(minutes)
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, "0")}`
}

/** Las notas al pie que el informe de gestión lleva SIEMPRE (§5.1). */
export const BUDGET_EXPORT_NOTES: readonly string[] = [
  "Informe de GESTIÓN: no es una cuenta anual ni un estado financiero del PGC.",
  "El presupuesto es una DECISIÓN, no un cálculo: no se deriva del libro diario y no cuadra con él por construcción.",
  "Las filas EBIT, BAI y RESULTADO de una columna de proyecto NO son márgenes de proyecto: recogen partidas que no se imputan a proyecto.",
  "Una celda vacía significa «sin presupuesto» o «no comparable» (I-E10-18), nunca cero.",
]

export function budgetRunToDocument(run: BudgetExportRun): ExportDocument {
  const result = run.result
  const sheets: ExportSheet[] = []

  // ── Presupuesto vs real, cinco columnas por celda ─────────────────────────
  sheets.push({
    name: "Presupuesto vs real",
    header: ["Nivel", "Columna", "Mes", "Real", "Presupuesto", "Desviación", "Desviación (bps)", "Forecast", "Nota"],
    rows: (result.variance ?? []).map((v) => [
      v.level,
      v.column,
      v.month ?? "acumulado",
      v.actualCents,
      cell(v.budgetCents),
      cell(v.varianceCents),
      cell(v.varianceBps),
      cell(v.forecastCents),
      v.notComparable
        ? "no comparable: el presupuesto y el real están en estados de imputación distintos (I-E10-18)"
        : v.budgetCents === null
          ? "sin presupuesto para la celda"
          : "",
    ]),
  })

  // ── O-E10-9: de qué versión sale cada mes ─────────────────────────────────
  const composition = Object.entries(result.budgetComposition ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))
  if (composition.length > 0) {
    sheets.push({
      name: "Procedencia del presupuesto",
      header: ["Mes", "Versión"],
      rows: composition.map(([month, label]) => [month, label]),
    })
  }

  // ── §5.2: rentabilidad con horas, con la `basis` JUNTO a cada cifra ───────
  if ((result.profitability ?? []).length > 0) {
    sheets.push({
      name: "Rentabilidad con horas",
      header: [
        "Proyecto",
        "Horas reales",
        "Horas presupuestadas",
        "Desviación de horas",
        "Coste-hora",
        "Base del coste-hora",
        "Margen/hora MC2",
        "Margen/hora MC3",
        "Tarifa media facturada",
        "Nota",
      ],
      rows: (result.profitability ?? []).map((p) => [
        p.projectCode,
        minutesToHhMm(p.actualMinutes),
        minutesToHhMm(p.budgetMinutes),
        minutesToHhMm(p.minutesVariance),
        cell(p.hourlyCostCents),
        // Q-1: `BRUTO_SIN_SS` y `COSTE_EMPRESA_CON_SS` difieren ~31,9 %, así que
        // la base viaja pegada a la cifra. Sin ella, comparar dos proyectos es
        // comparar dos magnitudes distintas.
        p.basis ?? EMPTY_CELL,
        cell(p.marginPerHourMc2Cents),
        cell(p.marginPerHourMc3Cents),
        cell(p.billedRatePerHourCents),
        p.notEvaluableReason ?? "",
      ]),
    })
  }

  // ── O-E10-20: la absorción, con su signo y su porcentaje ──────────────────
  if (result.absorption) {
    sheets.push({
      name: "Absorción",
      header: ["Concepto", "Valor"],
      rows: [
        ["Desviación de absorción (céntimos)", result.absorption.absorptionCents ?? 0],
        ["Desviación de absorción (bps)", result.absorption.absorptionBps ?? EMPTY_CELL],
        ["Sentido", result.absorption.direction ?? EMPTY_CELL],
        [
          "Nota",
          "Es información de gestión, no un FAIL: I-E10-12 sólo comprueba que no se sobre-absorba, " +
            "así que una infraabsorción pasaba el invariante en silencio (O-E10-20)",
        ],
      ],
    })
  }

  // ── P6 — la hoja de PROCEDENCIA, con las TRES consultas y los TRES sellos ─
  sheets.push({
    name: "Procedencia",
    header: ["Campo", "Valor"],
    rows: [
      ["Informe", "PRESUPUESTO_REAL"],
      ["Identificador del run", run.id],
      ["Periodo", `${run.periodStart} … ${run.periodEnd}`],
      ["Sello del diario (ledgerHash)", `sha256:${run.ledgerHash}`],
      ["Sello del presupuesto (budgetHash)", `sha256:${run.budgetHash}`],
      ["Sello analítico (analyticsKey)", run.analyticsKey],
      ["Versión del motor (gitSha)", run.gitSha],
      ["Parámetros", JSON.stringify(run.params)],
      [
        "Consulta · real",
        "SELECT id FROM journal_lines WHERE organization_id = $1 AND entry_date BETWEEN $2 AND $3 " +
          "AND (project_id = $4 OR cost_center_id = $4)",
      ],
      [
        "Consulta · imputado",
        "SELECT id FROM allocation_lines WHERE organization_id = $1 AND run_id = ANY($2) AND target_project_id = $3",
      ],
      [
        "Consulta · presupuesto",
        "SELECT id FROM budget_lines WHERE organization_id = $1 AND budget_id = $2 AND month BETWEEN $3 AND $4",
      ],
      ["Confianza", "calculado"],
    ],
  })

  // ── Validación: los checks y el sello CON SUS MOTIVOS ─────────────────────
  sheets.push({
    name: "Validación",
    header: ["Comprobación", "Estado", "Evidencia"],
    rows: [
      ["SELLO", run.seal, run.sealReasons.map((r) => `${r.code}: ${r.message}`).join(" · ") || "sin motivos"],
      [
        "ESTADO DE IMPUTACIÓN",
        result.budgetAllocationState ?? "NONE",
        result.notSettleableReason ??
          "presupuesto y real en el mismo estado: las celdas por dimensión son comparables en todos los niveles",
      ],
      [
        "MESES SIN PRESUPUESTO",
        (result.monthsWithoutBudget ?? []).length === 0 ? "PASS" : "WARN",
        (result.monthsWithoutBudget ?? []).join(", ") || "todos los meses del periodo tienen versión vigente",
      ],
      [
        "MESES NO CERRADOS",
        (result.openMonths ?? []).length === 0 ? "PASS" : "INFO",
        (result.openMonths ?? []).join(", ") ||
          "el periodo está cerrado: la desviación es definitiva, no parcial (EV-13)",
      ],
      ...run.validation.checks.map((c) => [c.id, c.status, c.evidencia] as const),
    ],
  })

  return {
    title: `Presupuesto vs real · ${run.periodStart} a ${run.periodEnd}`,
    subtitle:
      `Sello: ${run.seal} · run ${run.id} · motor ${run.gitSha} · ` +
      `presupuesto sha256:${run.budgetHash.slice(0, 12)}…`,
    notes: BUDGET_EXPORT_NOTES,
    sheets,
  }
}

/**
 * CSV (tres ficheros en un `.zip`), XLSX o el modelo del PDF. El `sha256` del
 * fichero es **estable**: dos exports del mismo run dan el mismo byte —la fecha
 * dentro del zip es fija—, que es lo que permite acreditar que el fichero que
 * circula por correo es el que el sistema selló.
 */
export async function exportBudgetRun(run: BudgetExportRun, format: ExportFormat): Promise<ExportedFile> {
  const doc = budgetRunToDocument(run)
  const slug = `presupuesto-real-${run.periodStart}-${run.periodEnd}`
  if (format === "csv") return await reportToCsv(doc, slug)
  if (format === "xlsx") return await reportToXlsx(doc, slug)
  // El PDF lo compone el route handler con `@react-pdf/renderer`; aquí se
  // devuelve el modelo serializado para que el motor no dependa de React.
  const body = Buffer.from(JSON.stringify(reportToPdfModel(doc)), "utf8")
  return {
    filename: `${slug}.pdf.json`,
    contentType: "application/json",
    body,
    sha256: createHash("sha256").update(body).digest("hex"),
  }
}

/**
 * El documento que el route handler del PDF consume. Existe aparte de
 * `exportBudgetRun` porque el PDF lo compone `@react-pdf/renderer` en el borde y
 * el motor de export no debe depender de React (mismo patrón que E6).
 */
export const budgetExportDocument = budgetRunToDocument
