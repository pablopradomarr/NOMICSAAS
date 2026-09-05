/**
 * E2 · T4 — Parseo del seed NPGC, filtrado por variante y diff de plan.
 * Módulo PURO: recibe el texto del CSV, nunca lo lee del disco.
 */

import { ACCOUNT_CODE_RE, computeIsPostable, resolveParentCodeIn } from "@/lib/accounts/codes"
import {
  AccountError,
  AccountOrigin,
  AnalyticType,
  CashflowBucket,
  err,
  fail,
  Nature,
  ok,
  PgcVariant,
  Plan,
  PlanAccount,
  Result,
  SeedAccount,
  Statement,
} from "@/lib/accounts/types"

/** Cabecera EXACTA del seed regenerado (14 columnas tras E6, §3 `parseNpgcCsv`). */
export const NPGC_HEADER = [
  "codigo",
  "nombre",
  "nivel",
  "padre",
  "grupo",
  "naturaleza",
  "estado_financiero",
  "epigrafe",
  "tipo_analitico",
  "bidireccional",
  "is_contra",
  "pymes",
  "epigrafe_pymes",
  "cashflow_bucket",
] as const

const NATURES = new Set<string>(["DEUDORA", "ACREEDORA"])
const STATEMENTS = new Set<string>(["BALANCE_ACTIVO", "BALANCE_PASIVO", "BALANCE_PN", "PYG", "ECPN"])
const ANALYTIC_TYPES = new Set<string>([
  "INGRESO_DIRECTO",
  "COSTE_DIRECTO_MC1",
  "COSTE_DIRECTO_MC2",
  "INDIRECTO_CECO",
  "AMORTIZACION_DETERIORO",
  "FINANCIERO",
  "EXTRAORDINARIO",
  "NO_ANALITICO",
])
/** Buckets de cashflow del seed (E6). La `CashflowCategory` se DERIVA del bucket. */
const CASHFLOW_BUCKETS = new Set<string>([
  "COBROS_CLIENTES",
  "PAGOS_PROVEEDORES",
  "PAGOS_PERSONAL",
  "PAGOS_IMPUESTOS",
  "OTROS_EXPLOTACION",
  "INVERSION",
  "FINANCIACION",
])

/**
 * Parser CSV mínimo con comillas dobles (RFC 4180). El seed no las usa, pero un
 * plan importado por el usuario sí: un nombre de cuenta con coma es normal.
 *
 * `delimiter` es un ÚNICO carácter y se respeta dentro del parser. Antes se
 * normalizaba el fichero con `text.split(";").join(",")` antes de parsear, lo
 * que destrozaba cualquier `;` que viviera DENTRO de un campo entrecomillado
 * ("Servicios; consultoría") partiéndolo en dos columnas (revisión, hallazgo 6).
 */
export function parseCsvRows(text: string, delimiter: string = ","): string[][] {
  if (delimiter.length !== 1 || delimiter === '"' || delimiter === "\n" || delimiter === "\r") {
    throw new TypeError(`parseCsvRows: delimitador inválido ${JSON.stringify(delimiter)}`)
  }
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  let i = 0
  const push = () => {
    row.push(field)
    field = ""
  }
  const endRow = () => {
    push()
    // Una línea en blanco no es una fila.
    if (!(row.length === 1 && row[0].trim() === "")) rows.push(row)
    row = []
  }
  while (i < text.length) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      field += c
      i++
      continue
    }
    if (c === '"' && field === "") {
      quoted = true
      i++
      continue
    }
    if (c === delimiter) {
      push()
      i++
      continue
    }
    if (c === "\r") {
      i++
      continue
    }
    if (c === "\n") {
      endRow()
      i++
      continue
    }
    field += c
    i++
  }
  if (field !== "" || row.length > 0) endRow()
  return rows
}

const blank = (value: string | undefined): string | null => {
  const v = (value ?? "").trim()
  return v === "" ? null : v
}

/**
 * Parser del seed. Cabecera exacta de 14 columnas; valida que todo `padre`
 * exista, que `nivel === len(codigo)` y que los enums sean válidos. Todo o nada.
 */
export function parseNpgcCsv(csvText: string): Result<SeedAccount[]> {
  const rows = parseCsvRows(csvText)
  if (rows.length === 0) {
    return fail(err("CSV_HEADER", "file", "El fichero está vacío"))
  }
  const header = rows[0].map((h) => h.trim())
  if (header.length !== NPGC_HEADER.length || header.some((h, i) => h !== NPGC_HEADER[i])) {
    return fail(
      err(
        "CSV_HEADER",
        "file",
        `Cabecera inesperada. Se esperaba exactamente: ${NPGC_HEADER.join(",")}`
      )
    )
  }

  const errors: AccountError[] = []
  const parsed: SeedAccount[] = []
  const seen = new Set<string>()

  for (let r = 1; r < rows.length; r++) {
    const line = rows[r]
    const rowNumber = r
    if (line.length !== NPGC_HEADER.length) {
      errors.push(err("CSV_ROW", "file", `La fila tiene ${line.length} columnas y se esperaban ${NPGC_HEADER.length}`, rowNumber))
      continue
    }
    const [codigo, nombre, nivel, padre, grupo, naturaleza, estado, epigrafe, analitico, bidir, contra, pymes, epiPymes, cashflow] =
      line.map((v) => v.trim())

    if (!ACCOUNT_CODE_RE.test(codigo)) {
      errors.push(err("CSV_ROW", "codigo", `Código inválido «${codigo}»`, rowNumber))
      continue
    }
    if (seen.has(codigo)) {
      errors.push(err("CSV_ROW", "codigo", `Código duplicado «${codigo}»`, rowNumber))
      continue
    }
    seen.add(codigo)
    if (nombre === "") {
      errors.push(err("CSV_ROW", "nombre", `La cuenta ${codigo} no tiene nombre`, rowNumber))
    }
    if (Number(nivel) !== codigo.length) {
      errors.push(
        err("CSV_ROW", "nivel", `La cuenta ${codigo} declara nivel ${nivel} y su código tiene ${codigo.length} dígitos`, rowNumber)
      )
    }
    if (!NATURES.has(naturaleza)) {
      errors.push(err("CSV_ROW", "naturaleza", `Naturaleza desconocida «${naturaleza}» en ${codigo}`, rowNumber))
    }
    if (estado !== "" && !STATEMENTS.has(estado)) {
      errors.push(err("CSV_ROW", "estado_financiero", `Estado financiero desconocido «${estado}» en ${codigo}`, rowNumber))
    }
    if (analitico !== "" && !ANALYTIC_TYPES.has(analitico)) {
      errors.push(err("CSV_ROW", "tipo_analitico", `Tipo analítico desconocido «${analitico}» en ${codigo}`, rowNumber))
    }
    if (cashflow !== "" && !CASHFLOW_BUCKETS.has(cashflow)) {
      errors.push(err("CSV_ROW", "cashflow_bucket", `Bucket de cashflow desconocido «${cashflow}» en ${codigo}`, rowNumber))
    }

    parsed.push({
      code: codigo,
      name: nombre,
      level: codigo.length,
      parentCode: blank(padre),
      group: grupo,
      nature: naturaleza as Nature,
      statement: (blank(estado) as Statement | null) ?? null,
      epigraph: blank(epigrafe),
      analyticType: (blank(analitico) as AnalyticType | null) ?? null,
      bidirectional: bidir === "1",
      isContra: contra === "1",
      pymes: pymes === "1",
      epigraphPymes: blank(epiPymes),
      cashflowBucket: (blank(cashflow) as CashflowBucket | null) ?? null,
    })
  }

  // Integridad referencial del árbol.
  for (const row of parsed) {
    if (row.parentCode && !seen.has(row.parentCode)) {
      errors.push(err("CSV_ROW", "padre", `La cuenta ${row.code} cuelga de ${row.parentCode}, que no existe`))
    }
    if (row.parentCode && !row.code.startsWith(row.parentCode)) {
      errors.push(err("CSV_ROW", "padre", `El padre ${row.parentCode} no es prefijo de ${row.code}`))
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return ok(parsed)
}

/**
 * `GENERAL` = todas; `PYMES` = `pymes = 1`. Función tonta a propósito: el
 * criterio contable (P-01…P-13) vive en `seeds/build_npgc.py`.
 *
 * REVALIDA 0 padres huérfanos sobre el subconjunto y RECALCULA `parentCode`
 * (el prefijo existente más largo tras el filtro).
 */
export function filterByVariant(rows: readonly SeedAccount[], variant: PgcVariant): Result<SeedAccount[]> {
  const kept = variant === "PYMES" ? rows.filter((r) => r.pymes) : [...rows]
  const codes = new Set(kept.map((r) => r.code))
  const errors: AccountError[] = []
  const out = kept.map((row) => {
    const parentCode = resolveParentCodeIn(row.code, codes)
    if (row.parentCode && !codes.has(row.parentCode) && parentCode === null && row.code.length > 1) {
      errors.push(
        err("CSV_ROW", "padre", `Tras el filtro ${variant} la cuenta ${row.code} queda huérfana (padre ${row.parentCode})`)
      )
    }
    return { ...row, parentCode }
  })
  if (errors.length > 0) return { ok: false, errors }
  return ok(out.sort((a, b) => (a.code < b.code ? -1 : 1)))
}

/**
 * Convierte filas del seed (ya filtradas) en cuentas del plan, recalculando
 * `isPostable` SOBRE EL SUBCONJUNTO (§2.4): al excluir hijos, el padre puede
 * pasar a ser hoja y postable. No se copia del seed.
 */
export function seedRowsToPlanAccounts(
  rows: readonly SeedAccount[],
  origin: AccountOrigin = "SEED"
): PlanAccount[] {
  const codes = new Set(rows.map((r) => r.code))
  return rows.map((row) => ({
    code: row.code,
    name: row.name,
    level: row.code.length,
    parentCode: row.parentCode,
    nature: row.nature,
    statement: row.statement,
    epigraph: row.epigraph,
    epigraphPymes: row.epigraphPymes,
    bidirectional: row.bidirectional,
    isContra: row.isContra,
    analyticType: row.analyticType,
    cashflowBucket: row.cashflowBucket,
    isPostable: computeIsPostable(row.code, codes),
    isActive: true,
    isSystem: false,
    origin,
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// planDiff — idempotencia de `importNpgc` (§2.4)
// ─────────────────────────────────────────────────────────────────────────────

export type PlanDiffPolicy = "seed" | "import"

export type PlanDiff = {
  create: PlanAccount[]
  /** Cuentas existentes con los campos a actualizar (sólo `policy: "import"`). */
  update: { code: string; patch: Partial<PlanAccount> }[]
  skip: string[]
  /** Cuentas del plan que ganan/pierden `isPostable` por el alta de descendientes. */
  postableChanges: { code: string; isPostable: boolean }[]
}

/** Campos que un import PUEDE refrescar. Nunca `name` (R-19: lo edita el usuario). */
const IMPORTABLE_FIELDS: (keyof PlanAccount)[] = [
  "statement",
  "epigraph",
  "epigraphPymes",
  "analyticType",
  "bidirectional",
  "isContra",
]

/**
 * `policy: "seed"` — nunca desactiva, nunca renombra, nunca pisa una fila con
 * `origin !== SEED`; en la práctica sólo CREA lo que falta (idempotencia).
 * `policy: "import"` — además refresca los campos mapeados de las filas cuyo
 * `origin` sea `SEED` o `CSV_IMPORT`.
 */
export function planDiff(
  existing: Plan,
  incoming: readonly PlanAccount[],
  policy: PlanDiffPolicy
): PlanDiff {
  const create: PlanAccount[] = []
  const update: PlanDiff["update"] = []
  const skip: string[] = []

  for (const row of incoming) {
    const current = existing.byCode.get(row.code)
    if (!current) {
      create.push(row)
      continue
    }
    if (policy === "seed" || current.origin === "MANUAL") {
      skip.push(row.code)
      continue
    }
    const patch: Partial<PlanAccount> = {}
    for (const field of IMPORTABLE_FIELDS) {
      if (row[field] !== current[field]) {
        // @ts-expect-error índice homogéneo sobre la misma clave
        patch[field] = row[field]
      }
    }
    if (Object.keys(patch).length === 0) skip.push(row.code)
    else update.push({ code: row.code, patch })
  }

  // I-E2-2 sobre el plan RESULTANTE: un padre existente deja de ser postable en
  // cuanto se crea su primer hijo.
  const finalCodes = new Set<string>([...existing.codes, ...incoming.map((r) => r.code)])
  const postableChanges: PlanDiff["postableChanges"] = []
  for (const code of existing.codes) {
    const account = existing.byCode.get(code)
    if (!account) continue
    const shouldBePostable = computeIsPostable(code, finalCodes)
    if (shouldBePostable !== account.isPostable) postableChanges.push({ code, isPostable: shouldBePostable })
  }
  return { create, update, skip, postableChanges }
}

// ─────────────────────────────────────────────────────────────────────────────
// parseCustomPlanCsv — import de plan propio (§3, R4)
// ─────────────────────────────────────────────────────────────────────────────

/** Tope de filas de un plan importado (hallazgo 8). El PGC completo son 906. */
export const MAX_IMPORT_ROWS = 5000

export type ColumnMapping = {
  code: string
  name: string
  statement?: string
  epigraph?: string
  analyticType?: string
  nature?: string
}

export type ImportDefaults = {
  nature: Nature
  statement: Statement | null
  epigraphCatalog: ReadonlySet<string>
  /** Separador del fichero del usuario; el seed siempre es coma. */
  delimiter?: string
}

/** Sinónimos en español para normalizar textos libres contra los enums. */
const NATURE_SYNONYMS: Record<string, Nature> = {
  deudora: "DEUDORA",
  deudor: "DEUDORA",
  debe: "DEUDORA",
  activo: "DEUDORA",
  acreedora: "ACREEDORA",
  acreedor: "ACREEDORA",
  haber: "ACREEDORA",
  pasivo: "ACREEDORA",
}

const STATEMENT_SYNONYMS: Record<string, Statement> = {
  activo: "BALANCE_ACTIVO",
  "balance activo": "BALANCE_ACTIVO",
  balance_activo: "BALANCE_ACTIVO",
  pasivo: "BALANCE_PASIVO",
  "balance pasivo": "BALANCE_PASIVO",
  balance_pasivo: "BALANCE_PASIVO",
  "patrimonio neto": "BALANCE_PN",
  pn: "BALANCE_PN",
  balance_pn: "BALANCE_PN",
  pyg: "PYG",
  "perdidas y ganancias": "PYG",
  "pérdidas y ganancias": "PYG",
  resultados: "PYG",
  ecpn: "ECPN",
}

const normalize = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")

/**
 * Import de un plan ajeno. Todo o nada: cualquier fila mala rechaza el fichero
 * entero, con su número de fila (riesgo R4).
 */
export function parseCustomPlanCsv(
  csvText: string,
  mapping: ColumnMapping,
  defaults: ImportDefaults
): Result<SeedAccount[]> {
  const delimiter = defaults.delimiter ?? ","
  const rows = parseCsvRows(csvText, delimiter)
  if (rows.length < 2) {
    return fail(err("CSV_HEADER", "file", "El fichero no tiene ninguna fila de datos"))
  }
  // Tope de tamaño: un fichero de 200.000 filas no es un plan contable, es un
  // error de fichero o un intento de agotar la memoria del servidor. Se corta
  // ANTES de construir nada (revisión, hallazgo 8).
  if (rows.length - 1 > MAX_IMPORT_ROWS) {
    return fail(
      err(
        "CSV_ROW",
        "file",
        `El fichero trae ${rows.length - 1} filas y el máximo admitido son ${MAX_IMPORT_ROWS}: ` +
          "un plan contable completo no llega a mil cuentas"
      )
    )
  }
  const header = rows[0].map((h) => h.trim())
  const indexOf = (column: string | undefined): number => (column === undefined ? -1 : header.indexOf(column))

  const iCode = indexOf(mapping.code)
  const iName = indexOf(mapping.name)
  if (iCode < 0 || iName < 0) {
    return fail(
      err("CSV_HEADER", "file", `No se encuentran las columnas obligatorias «${mapping.code}» y «${mapping.name}»`)
    )
  }
  const iStatement = indexOf(mapping.statement)
  const iEpigraph = indexOf(mapping.epigraph)
  const iAnalytic = indexOf(mapping.analyticType)
  const iNature = indexOf(mapping.nature)

  const errors: AccountError[] = []
  const parsed: SeedAccount[] = []
  const seen = new Set<string>()

  for (let r = 1; r < rows.length; r++) {
    const line = rows[r]
    const rowNumber = r
    const code = (line[iCode] ?? "").trim()
    const name = (line[iName] ?? "").trim()
    if (code === "" && name === "") continue
    if (!ACCOUNT_CODE_RE.test(code)) {
      errors.push(err("CSV_ROW", "code", `Código inválido «${code}»: sólo dígitos, sin ceros a la izquierda`, rowNumber))
      continue
    }
    if (seen.has(code)) {
      errors.push(err("CSV_ROW", "code", `Código duplicado «${code}»`, rowNumber))
      continue
    }
    seen.add(code)
    if (name === "") {
      errors.push(err("CSV_ROW", "name", `La cuenta ${code} no tiene nombre`, rowNumber))
      continue
    }

    let nature = defaults.nature
    if (iNature >= 0) {
      const raw = normalize(line[iNature] ?? "")
      if (raw !== "") {
        const resolved = NATURE_SYNONYMS[raw] ?? (raw.toUpperCase() as Nature)
        if (resolved !== "DEUDORA" && resolved !== "ACREEDORA") {
          errors.push(err("CSV_ROW", "nature", `Naturaleza no reconocida «${line[iNature]}»`, rowNumber))
          continue
        }
        nature = resolved
      }
    }

    let statement = defaults.statement
    if (iStatement >= 0) {
      const raw = normalize(line[iStatement] ?? "")
      if (raw !== "") {
        const resolved = STATEMENT_SYNONYMS[raw] ?? (raw.toUpperCase().replace(/ /g, "_") as Statement)
        if (!STATEMENTS.has(resolved)) {
          errors.push(err("CSV_ROW", "statement", `Estado financiero no reconocido «${line[iStatement]}»`, rowNumber))
          continue
        }
        statement = resolved
      }
    }

    let epigraph: string | null = null
    if (iEpigraph >= 0) {
      epigraph = blank(line[iEpigraph])
      if (epigraph !== null && !defaults.epigraphCatalog.has(epigraph)) {
        errors.push(
          err("CSV_ROW", "epigraph", `El epígrafe «${epigraph}» no está en el catálogo de la variante (R-15)`, rowNumber)
        )
        continue
      }
    }

    let analyticType: AnalyticType | null = null
    if (iAnalytic >= 0) {
      const raw = (line[iAnalytic] ?? "").trim().toUpperCase().replace(/ /g, "_")
      if (raw !== "") {
        if (!ANALYTIC_TYPES.has(raw)) {
          errors.push(err("CSV_ROW", "analyticType", `Tipo analítico no reconocido «${line[iAnalytic]}»`, rowNumber))
          continue
        }
        analyticType = raw as AnalyticType
      }
    }

    parsed.push({
      code,
      name,
      level: code.length,
      parentCode: null,
      group: code.slice(0, 1),
      nature,
      statement,
      epigraph,
      analyticType,
      bidirectional: false,
      isContra: false,
      pymes: true,
      epigraphPymes: epigraph,
      // Un plan importado por el usuario no trae bucket de cashflow: se declara
      // ausente y R-18′ avisa al editar la cuenta, en vez de inventarlo.
      cashflowBucket: null,
    })
  }

  if (errors.length > 0) return { ok: false, errors }
  return ok(parsed.sort((a, b) => (a.code < b.code ? -1 : 1)))
}

/**
 * Nº de fila del fichero para cada código, para que los errores posteriores
 * (resolución de padres) puedan señalar la línea original.
 */
export function rowNumbersByCode(csvText: string, mapping: ColumnMapping, delimiter: string = ","): Map<string, number> {
  const rows = parseCsvRows(csvText, delimiter)
  const out = new Map<string, number>()
  if (rows.length === 0) return out
  const index = rows[0].map((h) => h.trim()).indexOf(mapping.code)
  if (index < 0) return out
  for (let r = 1; r < rows.length; r++) {
    const code = (rows[r][index] ?? "").trim()
    if (code !== "" && !out.has(code)) out.set(code, r)
  }
  return out
}

/**
 * Resuelve `parentCode` de las filas importadas contra el plan YA EXISTENTE más
 * las propias filas: un plan ajeno no trae jerarquía explícita.
 */
export function resolveImportedParents(
  rows: readonly SeedAccount[],
  existing: Plan,
  /** Nº de fila del fichero por código, para que el error señale la línea (hallazgo 9). */
  rowNumberByCode?: ReadonlyMap<string, number>
): Result<SeedAccount[]> {
  const codes = new Set<string>([...existing.codes, ...rows.map((r) => r.code)])
  const errors: AccountError[] = []
  const out = rows.map((row) => {
    const parentCode = resolveParentCodeIn(row.code, codes)
    if (parentCode === null && row.code.length > 1) {
      errors.push(
        err(
          "CSV_ROW",
          "code",
          `La cuenta ${row.code} no tiene ninguna cuenta padre en el plan: crea antes el grupo o subgrupo del que cuelga`,
          rowNumberByCode?.get(row.code)
        )
      )
    }
    return { ...row, parentCode }
  })
  if (errors.length > 0) return { ok: false, errors }
  return ok(out)
}
