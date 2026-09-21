#!/usr/bin/env -S npx tsx
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * AUDITOR AUTOMATIZADO — Capa 2 de C4 (SPEC-FIABILIDAD §C4, E12 · T5)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Segundo motor, mínimo y hostil. Reconstruye por un camino INDEPENDIENTE las
 * doce cifras canónicas del ejercicio y las contrasta con lo que el producto
 * tiene SELLADO. Su oficio no es confirmar: es refutar.
 *
 *   npx tsx scripts/audit-reconstruct.ts --org <uuid> [--fiscal-year <id|año>]
 *        [--ref-date <YYYY-MM-DD>] [--out <fichero.json>] [--database-url <url>]
 *
 * Exit code 0 sólo si el veredicto es CONFORME. `NO_VERIFICABLE` NO es un
 * aprobado (enmienda E-9 de la v1.1): falla igual que `DISCREPANCIA`.
 *
 * REGLA DE AUTORÍA (E12 §12, y `scripts/audit-reconstruct.imports.test.ts` la
 * impone sobre el AST):
 *
 *   Este fichero NO importa NADA de `lib/**`, `models/**`, `ai/**` ni `app/**`.
 *   Habla con la base por SQL crudo (`pg`), rehace los sellos desde la tupla
 *   de ADR-0011 y hace la aritmética con `BigInt`. Un hash que se compara
 *   consigo mismo no prueba nada; un total que sale de la misma función que lo
 *   produjo, tampoco.
 *
 * LAS DOCE CIFRAS CANÓNICAS (E12 §3.4 C4)
 *   1–8  Los ocho niveles de margen acumulados: INGRESOS, MC1, MC2, MC3,
 *        EBITDA, EBIT, BAI, RESULTADO.
 *   9    Σdebe del periodo (con Σdebe = Σhaber por asiento, I1).
 *   10   Activo.
 *   11   PN + Pasivo.
 *   12   Tesorería.
 *
 * DE DÓNDE SALE CADA REGLA (sólo fuentes normativas, nunca el motor)
 *   · `docs/adr/0011-forma-canonica-hashes.md` — forma canónica de `ledgerHash`
 *     (v2) y de `entryHash` (v2 y v3, por `journal_entries.hash_version`).
 *   · `.claude/skills/fiabilidad/SKILL.md` I1–I6 — partida doble, estados,
 *     definición única de la PyG (6/7 con `kind ∉ {REGULARIZATION, CLOSING,
 *     OPENING}`, y saldo de 129 si el ejercicio está regularizado), matriz
 *     analítica por nivel, y la identidad de tesorería.
 *   · `docs/MODELO-DATOS.md` — R-B1/R-B2/R-B4/R-B5 (balance y reclasificación
 *     de cuentas bidireccionales), R-A11 (`630`/`633`/`638` a RESULTADO; el
 *     resto de `NO_ANALITICO`, a `organizations.non_analytic_level`),
 *     `CostCenter.marginLevel` como router de `INDIRECTO_CECO` (R-A6/R-A7).
 *   · `prisma/migrations/20260909100000_e6_reports/migration.sql` §7 y
 *     `…/20260910100000_e5_allocations/migration.sql` — composición exacta de
 *     `report_runs.analytics_key`.
 *   · `prisma/schema.prisma` — nombres físicos de tablas y columnas.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUÉ **NO** PUEDE DETECTAR ESTE AUDITOR  (léase antes de confiar en un CONFORME)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  1. **Un diario coherente pero falso.** Reconstruye desde `journal_lines`, que
 *     es la fuente única (ADR-0003). Si el hecho económico nunca llegó al
 *     diario —una factura no contabilizada, un documento no ingerido— las doce
 *     cifras cuadran y el auditor calla. Eso lo cazan I-E8-* y la conciliación
 *     bancaria (I-E7-1), no esto.
 *  2. **Un error de clasificación contable consistente.** Un gasto imputado a
 *     la cuenta equivocada del mismo grupo, o un `analytic_type` mal resuelto en
 *     el ALTA de la línea (R-A2), se reconstruye igual de mal por los dos
 *     caminos: el auditor lee `analytic_type` persistido, no lo re-decide.
 *  3. **`budgetHash`.** ADR-0018 describe su contenido pero NO fija una forma
 *     canónica (orden, separadores, serialización), así que no es
 *     reimplementable sin leer el motor. Se comprueba sólo lo estructural (toda
 *     versión `VIGENTE` tiene sello). Lo recomputa I-E10-6, que es del motor.
 *  4. **`analyticsHash` completo y `marginConfigHash`.** ADR-0011 fija la tupla
 *     de dimensiones, pero no la concatenación con `marginConfigHash` ni con
 *     `allocationRunSetHash`. El auditor rehace la parte de dimensiones y, si
 *     no casa, lo declara INDETERMINADO — nunca DISCREPANCIA: una forma que no
 *     conoce no es una prueba de alteración.
 *  5. **Lo que el producto no ha sellado.** Si no hay `report_runs`,
 *     `invariant_runs`, `allocation_runs`, `closing_runs` ni `budgets` del
 *     periodo, no hay con qué contrastar: el veredicto es NO_VERIFICABLE. Un
 *     diario cargado y nunca informado no se audita solo.
 *  6. **La cascada de liquidación de CECOs (E5).** Mientras no haya
 *     `allocation_lines` del periodo, la matriz se reconstruye SIN repartir —los
 *     CECO caen en su propio nivel (`CostCenter.marginLevel`)— y desde la ronda
 *     1 de E12 se contrasta **celda a celda por dimensión** (AUD-8): una
 *     redistribución entre columnas con los totales intactos ya no pasa como
 *     `CONFORME`. Con reparto sellado, el auditor comprueba el cierre a cero y
 *     el nivel que viaja con el importe, pero **no rehace el Hamilton**
 *     receptor a receptor, así que **declara** que las celdas por dimensión no
 *     se contrastan (`A-MATRIZ-DIMENSION-NO-COMPARABLE`) en vez de callarse.
 *  7. **Alteraciones simultáneas y coherentes de diario y sellos.** Quien pueda
 *     escribir en `journal_lines` y en `report_runs` a la vez con el rol de
 *     mantenimiento reproduce ambos lados. Contra eso está la política
 *     append-only (RLS) y `audit_logs`, no la aritmética.
 *  8. **Multi-divisa.** Trabaja en la moneda base, en céntimos. No revalora
 *     partidas monetarias (NRV 11ª) ni cruza `original_amount_cents`.
 *  9. **Períodos que no son el ejercicio.** Las doce cifras se reconstruyen para
 *     UN ejercicio completo. Un informe mensual sellado no se compara: sólo se
 *     contrastan sellos cuyo `(period_start, period_end)` es el del ejercicio.
 * 10. **Su propio silencio.** Si una consulta devuelve cero filas por un filtro
 *     mal puesto, la cifra sale `null` y cuenta como no reconstruida — por eso
 *     menos de tres cifras reconstruidas es NO_VERIFICABLE y no un CONFORME
 *     barato.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
import { Client } from "pg"

const VERSION_AUDITOR = "1.0.0"

/** `BigInt(0)` y no `0n`: el `target` del repo es ES2017 y los literales BigInt
 *  no compilan. La aritmética sigue siendo entera y sin `Number` por medio. */
const CERO = BigInt(0)

/** Separador y centinela de la forma canónica (ADR-0011): TSV, `\n`, `∅`. */
const TAB = "\t"
const NL = "\n"
const NULO = "∅"

/** Orden canónico de los ocho niveles (enum `margin_level`). */
const NIVELES = ["INGRESOS", "MC1", "MC2", "MC3", "EBITDA", "EBIT", "BAI", "RESULTADO"] as const
type Nivel = (typeof NIVELES)[number]

/** `kind` que NO forman resultado del periodo (I3 de la SKILL). */
const KINDS_FUERA_PYG = ["REGULARIZATION", "CLOSING", "OPENING"]

/** R-A11: estas tres van SIEMPRE a RESULTADO, sean cuales sean la configuración
 *  de niveles y el `nonAnalyticLevel` de la organización (impuesto sobre
 *  beneficios y ajustes 633/638). */
/** Los tres tipos DIRECTOS (R-A5). Se escriben aquí: el auditor no importa nada. */
const TIPOS_DIRECTOS = ["INGRESO_DIRECTO", "COSTE_DIRECTO_MC1", "COSTE_DIRECTO_MC2"]

const PREFIJOS_IMPUESTO = ["630", "633", "638"]

type Veredicto = "CONFORME" | "DISCREPANCIA" | "NO_VERIFICABLE"

type Cifra = {
  metrica: string
  producto: string | null
  reconstruccion: string | null
  delta: string | null
  metodo: string
  fuenteProducto: string | null
}

type Hallazgo = {
  codigo: string
  gravedad: "ALTA" | "MEDIA" | "BAJA" | "INFO"
  mensaje: string
  evidencia?: unknown
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades: aritmética entera y hashing
// ─────────────────────────────────────────────────────────────────────────────

/** Postgres devuelve `bigint`/`numeric` como texto: nunca pasa por `number`. */
function aBigInt(v: unknown): bigint {
  if (v === null || v === undefined) return CERO
  if (typeof v === "bigint") return v
  const s = String(v).trim()
  if (!/^-?\d+$/.test(s)) throw new Error(`valor no entero devuelto por la base: ${JSON.stringify(v)}`)
  return BigInt(s)
}

function texto(v: unknown): string {
  return v === null || v === undefined ? NULO : String(v)
}

/** sha256 hexadecimal minúscula sobre UTF-8, alimentado fila a fila para no
 *  materializar el diario entero en memoria (ADR-0011: `\n` ENTRE filas). */
function hashDeFilas(filas: Iterable<string>): string {
  const h = createHash("sha256")
  let primera = true
  for (const fila of filas) {
    h.update(primera ? fila : NL + fila, "utf8")
    primera = false
  }
  return h.digest("hex")
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

type Opciones = {
  org: string
  fiscalYear: string | null
  refDate: string | null
  out: string | null
  databaseUrl: string
}

const AYUDA = `
Auditor automatizado (Capa 2 de C4). Reconstruye las doce cifras canónicas por
un camino independiente y las contrasta con lo que el producto tiene sellado.

  npx tsx scripts/audit-reconstruct.ts --org <uuid> [opciones]

  --org <uuid>            Organización a auditar. Obligatorio.
  --fiscal-year <id|año>  Ejercicio: uuid o código ("2026"). Por defecto, el que
                          más líneas de diario tiene.
  --ref-date <fecha>      Fecha con la que se elige la configuración vigente de
                          niveles de margen. Por defecto, el fin del ejercicio.
  --out <fichero>         Escribe el veredicto completo en JSON.
  --database-url <url>    Conexión. Por defecto DATABASE_URL_MAINTENANCE y, si
                          no está, DATABASE_URL.
  --help                  Esto.

Exit code 0 sólo con veredicto CONFORME: NO_VERIFICABLE falla igual que
DISCREPANCIA (enmienda E-9 de SPEC-FIABILIDAD v1.1).
`

function parsearArgv(argv: string[]): Opciones | null {
  const leer = (nombre: string): string | null => {
    const i = argv.indexOf(nombre)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(AYUDA)
    return null
  }
  const org = leer("--org")
  if (!org) {
    process.stderr.write("Falta --org (uuid de la organización).\n" + AYUDA)
    process.exit(2)
  }
  const databaseUrl =
    leer("--database-url") || process.env.DATABASE_URL_MAINTENANCE || process.env.DATABASE_URL || ""
  if (!databaseUrl) {
    process.stderr.write("Sin conexión: pase --database-url o defina DATABASE_URL_MAINTENANCE.\n")
    process.exit(2)
  }
  return {
    org,
    fiscalYear: leer("--fiscal-year"),
    refDate: leer("--ref-date"),
    out: leer("--out"),
    databaseUrl,
  }
}

/** La URL viaja al JSON de trazabilidad: la contraseña, no. */
function urlSinSecreto(url: string): string {
  try {
    const u = new URL(url)
    if (u.password) u.password = "***"
    return u.toString()
  } catch {
    return "(url no parseable)"
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sondeo del lado PRODUCTO: se busca la cifra dentro del JSON sellado
// ─────────────────────────────────────────────────────────────────────────────

/** Normaliza una clave para compararla: minúsculas, sin acentos ni separadores. */
function normalizar(clave: string): string {
  return clave
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
}

/** Claves aceptadas por métrica. El auditor NO conoce la forma del `result` del
 *  producto —leerla exigiría leer el motor—, así que sondea el JSON sellado por
 *  nombre canónico y declara la RUTA en la que encontró el valor. */
const ALIAS: Record<string, string[]> = {
  INGRESOS: ["ingresos", "nivelingresos", "ingresoscents"],
  MC1: ["mc1", "nivelmc1", "mc1cents"],
  MC2: ["mc2", "nivelmc2", "mc2cents"],
  MC3: ["mc3", "nivelmc3", "mc3cents"],
  EBITDA: ["ebitda", "nivelebitda", "ebitdacents"],
  EBIT: ["ebit", "nivelebit", "ebitcents"],
  BAI: ["bai", "nivelbai", "baicents", "resultadoantesdeimpuestos"],
  RESULTADO: ["resultado", "nivelresultado", "resultadocents", "resultadodelejercicio", "pyg", "pygcontable"],
  SUMA_DEBE: ["sumadebe", "totaldebe", "debe", "debitcents", "totaldebitcents", "sumadebitcents"],
  ACTIVO: ["activo", "totalactivo", "activototal", "activocents", "totalactivocents"],
  PN_MAS_PASIVO: [
    "pnmaspasivo",
    "pasivomaspn",
    "patrimonioypasivo",
    "totalpasivopn",
    "totalpnmaspasivo",
    "pnmaspasivocents",
  ],
  TESORERIA: ["tesoreria", "tesoreriafinal", "saldofinaltesoreria", "tesoreriacents"],
}

type Sonda = { valor: bigint; ruta: string }

/**
 * **E12 · T23 — la corrección del sondeo (hallazgo C4 de la ola A).**
 *
 * El sondeo recorría el JSON sellado entero y se quedaba con **todo** valor
 * entero cuya clave casara con un alias. Sobre una copia **intacta** eso bastaba
 * para declarar `P-PRODUCTO-CONTRADICTORIO`: el `CASHFLOW` mensual y el
 * `DASHBOARD` sellan la **serie por meses**, y doce celdas `ingresos` de doce
 * meses distintos son doce valores distintos para `INGRESOS`. El auditor
 * afirmaba que el producto se contradecía cuando lo único que pasaba es que el
 * auditor estaba leyendo mal. Un refutador que grita con razón una vez y sin
 * razón diez deja de servir: el ruido se acaba silenciando entero.
 *
 * La regla, escrita una vez: **una cifra DEL PERIODO no vive dentro de una
 * serie**. Por eso el sondeo descarta un valor si su camino:
 *
 *  1. atraviesa un **elemento de lista** (`…[3].ingresos`): una lista sellada es
 *     un desglose —meses, buckets, líneas, columnas—, nunca el total; o
 *  2. atraviesa una clave de **serie declarada** (`buckets`, `meses`,
 *     `porMes`, `desglose`…), que es como viajan las series indexadas por
 *     etiqueta en vez de por posición.
 *
 * Lo que queda son los escalares de cabecera, que es lo que el producto afirma
 * como cifra del periodo y lo único con lo que tiene sentido contrastar. Si tras
 * el filtro siguen saliendo dos valores distintos, la contradicción es **real** y
 * el hallazgo se mantiene: el filtro quita ruido, no capacidad de refutar.
 */
const CLAVES_DE_SERIE = new Set([
  "buckets",
  "bucket",
  "monthlycents",
  "mensualcents",
  "quarterly",
  "trimestral",
  "meses",
  "months",
  "monthly",
  "mensual",
  "pormes",
  "bymonth",
  "series",
  "serie",
  "desglose",
  "breakdown",
  "periodos",
  "periods",
  "timeline",
  "celdas",
  "cells",
  "columnas",
  "columns",
  "detalle",
  "detail",
  "lines",
  "lineas",
  "children",
  "hijos",
])

/**
 * Una clave que es una **etiqueta de periodo** (`2026`, `2026-03`, `2026-03-31`)
 * sólo puede ser el índice de una serie: nadie llama así a una cifra. Es la
 * tercera forma de indexar un desglose, además de la lista y de la clave de
 * serie declarada, y es la que usa `directo.monthlyCents["2026-02"]`.
 */
const ETIQUETA_DE_PERIODO = /^\d{4}(-(Q[1-4]|\d{2})(-\d{2})?)?$/

/**
 * ¿El camino RELATIVO A LA RAÍZ de esta sonda atraviesa una serie o una lista?
 * Se compara sobre el relativo porque la raíz (`report_runs[PYG/ab12].result`)
 * trae sus propios corchetes y no es parte del JSON sellado.
 */
function dentroDeSerie(rutaRelativa: string): boolean {
  if (rutaRelativa.includes("[")) return true
  const segmentos = rutaRelativa.split(".").filter((s) => s.length > 0)
  // El último segmento es la clave de la cifra; lo que la sitúa es su camino.
  return segmentos
    .slice(0, -1)
    .some((s) => CLAVES_DE_SERIE.has(normalizar(s)) || ETIQUETA_DE_PERIODO.test(s))
}

/** Recorre un JSON sellado y devuelve los valores enteros cuyo camino termina en
 *  una clave reconocida. Acepta el contrato de provenance de C3
 *  (`{valor, metrica, …}`) y el valor desnudo. */
function sondear(json: unknown, alias: string[], raiz: string): Sonda[] {
  const buscadas = new Set(alias)
  const encontradas: Sonda[] = []

  const valorEntero = (v: unknown): bigint | null => {
    if (typeof v === "number") return Number.isInteger(v) ? BigInt(v) : null
    if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v)
    if (typeof v === "bigint") return v
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>
      for (const k of ["valor", "value", "cents", "amountCents", "importeCents", "totalCents"]) {
        if (k in o) {
          const r = valorEntero(o[k])
          if (r !== null) return r
        }
      }
    }
    return null
  }

  const andar = (nodo: unknown, relativa: string, profundidad: number): void => {
    if (profundidad > 8 || nodo === null || typeof nodo !== "object") return
    if (Array.isArray(nodo)) {
      nodo.forEach((x, i) => andar(x, `${relativa}[${i}]`, profundidad + 1))
      return
    }
    for (const [k, v] of Object.entries(nodo as Record<string, unknown>)) {
      const hija = `${relativa}.${k}`
      if (buscadas.has(normalizar(k)) && !dentroDeSerie(hija)) {
        const n = valorEntero(v)
        if (n !== null) encontradas.push({ valor: n, ruta: `${raiz}${hija}` })
      }
      andar(v, hija, profundidad + 1)
    }
  }

  andar(json, "", 0)
  return encontradas
}

// ─────────────────────────────────────────────────────────────────────────────
// Programa
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opciones = parsearArgv(process.argv.slice(2))
  if (!opciones) return

  const hallazgos: Hallazgo[] = []
  const cliente = new Client({ connectionString: opciones.databaseUrl })
  await cliente.connect()

  try {
    const q = async (sql: string, params: unknown[] = []) => (await cliente.query(sql, params)).rows

    // ── 0. Organización y ejercicio ──────────────────────────────────────────
    const orgs = await q(
      `SELECT id, name, base_currency, non_analytic_level::text AS non_analytic_level
         FROM organizations WHERE id = $1::uuid`,
      [opciones.org]
    )
    if (orgs.length === 0) {
      throw new Error(`la organización ${opciones.org} no existe en esta base`)
    }
    const org = orgs[0]

    const ejercicios = await q(
      `SELECT fy.id, fy.code, fy.status::text AS status,
              to_char(fy.start_date, 'YYYY-MM-DD') AS start_date,
              to_char(fy.end_date,   'YYYY-MM-DD') AS end_date,
              (SELECT count(*) FROM journal_lines l
                WHERE l.organization_id = fy.organization_id AND l.fiscal_year_id = fy.id)::text AS lineas
         FROM fiscal_years fy
        WHERE fy.organization_id = $1::uuid
        ORDER BY fy.start_date`,
      [opciones.org]
    )
    if (ejercicios.length === 0) throw new Error("la organización no tiene ningún ejercicio")

    let fy = null as (typeof ejercicios)[number] | null
    if (opciones.fiscalYear) {
      fy = ejercicios.find((e) => e.id === opciones.fiscalYear || e.code === opciones.fiscalYear) ?? null
      if (!fy) throw new Error(`no hay ejercicio '${opciones.fiscalYear}' en esta organización`)
    } else {
      fy = ejercicios.reduce((a, b) => (aBigInt(b.lineas) > aBigInt(a.lineas) ? b : a))
      hallazgos.push({
        codigo: "A-EJERCICIO-IMPLICITO",
        gravedad: "INFO",
        mensaje: `sin --fiscal-year: se audita ${fy.code} (${fy.lineas} líneas), el ejercicio con más diario`,
      })
    }
    const fyId = fy.id as string
    const refDate = opciones.refDate || (fy.end_date as string)

    // ── 1. Configuración leída de la BASE (nunca del código) ─────────────────
    const configNiveles = await q(
      `SELECT level::text AS level, analytic_types::text[] AS tipos, sort_order,
              to_char(valid_from,'YYYY-MM-DD') AS valid_from,
              to_char(valid_to,  'YYYY-MM-DD') AS valid_to
         FROM margin_level_configs
        WHERE organization_id = $1::uuid
          AND valid_from <= $2::date
          AND (valid_to IS NULL OR valid_to >= $2::date)
        ORDER BY sort_order`,
      [opciones.org, refDate]
    )
    /** tipo analítico → nivel, según la configuración VIGENTE de la base. */
    const nivelDeTipo = new Map<string, Nivel>()
    for (const fila of configNiveles) {
      for (const tipo of (fila.tipos ?? []) as string[]) {
        if (nivelDeTipo.has(tipo)) {
          hallazgos.push({
            codigo: "A-CONFIG-TIPO-DUPLICADO",
            gravedad: "ALTA",
            mensaje: `el tipo analítico ${tipo} está en dos niveles vigentes (I-E4-9)`,
          })
        }
        nivelDeTipo.set(tipo, fila.level as Nivel)
      }
    }
    if (configNiveles.length !== 8) {
      hallazgos.push({
        codigo: "A-CONFIG-NIVELES",
        gravedad: "ALTA",
        mensaje: `la configuración vigente a ${refDate} tiene ${configNiveles.length} niveles, no 8`,
      })
    }

    const cecos = await q(
      `SELECT id, code, kind::text AS kind, margin_level::text AS margin_level, allocatable
         FROM cost_centers WHERE organization_id = $1::uuid`,
      [opciones.org]
    )
    const nivelDeCeco = new Map<string, Nivel>(cecos.map((c) => [c.id as string, c.margin_level as Nivel]))
    /** Columna de la matriz de un CECO: `CECO:<kind>` (no por código: por FAMILIA). */
    const columnaDeCeco = new Map<string, string>(cecos.map((c) => [c.id as string, `CECO:${c.kind as string}`]))
    const proyectos = await q(`SELECT id, code FROM projects WHERE organization_id = $1::uuid`, [opciones.org])
    const columnaDeProyecto = new Map<string, string>(proyectos.map((p) => [p.id as string, `PROJ:${p.code as string}`]))
    const nivelNoAnalitico = (org.non_analytic_level as string as Nivel) ?? "EBITDA"

    // ── 2. I1 · Σdebe = Σhaber, por asiento y del periodo ─────────────────────
    const totales = await q(
      `SELECT COALESCE(SUM(l.debit_cents),0)::text  AS debe,
              COALESCE(SUM(l.credit_cents),0)::text AS haber,
              count(*)::text AS lineas,
              count(DISTINCT l.entry_id)::text AS asientos
         FROM journal_lines l
        WHERE l.organization_id = $1::uuid AND l.fiscal_year_id = $2::uuid`,
      [opciones.org, fyId]
    )
    const sumaDebe = aBigInt(totales[0].debe)
    const sumaHaber = aBigInt(totales[0].haber)
    const nLineas = aBigInt(totales[0].lineas)
    const nAsientos = aBigInt(totales[0].asientos)

    const descuadrados = await q(
      `SELECT e.entry_number,
              COALESCE(SUM(l.debit_cents),0)::text  AS d,
              COALESCE(SUM(l.credit_cents),0)::text AS c,
              count(l.id)::int AS n
         FROM journal_entries e
         LEFT JOIN journal_lines l ON l.entry_id = e.id AND l.organization_id = e.organization_id
        WHERE e.organization_id = $1::uuid AND e.fiscal_year_id = $2::uuid
        GROUP BY e.id, e.entry_number
       HAVING COALESCE(SUM(l.debit_cents),0) <> COALESCE(SUM(l.credit_cents),0) OR count(l.id) < 2
        ORDER BY e.entry_number
        LIMIT 20`,
      [opciones.org, fyId]
    )
    if (descuadrados.length > 0) {
      hallazgos.push({
        codigo: "I1-DESCUADRE",
        gravedad: "ALTA",
        mensaje: `${descuadrados.length} asiento(s) sin Σdebe = Σhaber o con menos de dos líneas`,
        evidencia: descuadrados.map((r) => ({ asiento: r.entry_number, debe: r.d, haber: r.c, lineas: r.n })),
      })
    }
    if (sumaDebe !== sumaHaber) {
      hallazgos.push({
        codigo: "I1-DESCUADRE-PERIODO",
        gravedad: "ALTA",
        mensaje: `Σdebe (${sumaDebe}) ≠ Σhaber (${sumaHaber}) en el ejercicio`,
      })
    }

    // ── 3. Los ocho niveles de margen ────────────────────────────────────────
    //
    //  Universo: líneas de grupos 6 y 7 del ejercicio con `kind` fuera de los
    //  tres de sistema. Aporte = haber − debe. El nivel de cada línea sale de
    //  la configuración de la base; `INDIRECTO_CECO` se rutea por el
    //  `margin_level` del CECO (R-A6/R-A7) y `NO_ANALITICO` por R-A11.
    const lineas67 = await q(
      `SELECT l.account_code,
              COALESCE(l.analytic_type::text, '${NULO}') AS analytic_type,
              l.cost_center_id,
              l.project_id,
              SUM(l.credit_cents - l.debit_cents)::text AS aporte,
              count(*)::text AS n
         FROM journal_lines l
        WHERE l.organization_id = $1::uuid
          AND l.fiscal_year_id = $2::uuid
          AND left(l.account_code, 1) IN ('6','7')
          AND l.entry_kind::text <> ALL ($3::text[])
        GROUP BY 1, 2, 3, 4`,
      [opciones.org, fyId, KINDS_FUERA_PYG]
    )

    const aportePorNivel = new Map<Nivel, bigint>(NIVELES.map((n) => [n, CERO]))
    /**
     * **Aporte por nivel Y COLUMNA** (auditor AUD-8 / H-5 de la ronda 1).
     *
     * Hasta esta ronda el auditor sólo contrastaba AGREGADOS: mover cien mil
     * céntimos de `PROJ:P-01` a `PROJ:P-02` dentro de un informe sellado, con
     * los totales de nivel intactos, salía `CONFORME`. Un auditor que no ve una
     * redistribución por dimensión no puede decir que la matriz está bien, y su
     * cabecera tampoco lo declaraba: era un hueco, no un límite.
     *
     * La columna de una línea es una decisión SIMPLE —el proyecto manda sobre el
     * CECO, y el CECO va por su familia (`CECO:<kind>`)—, mientras que el NIVEL
     * es la parte difícil (R-A3/R-A4/R-A6/R-A7/R-A11) y ya está reconstruida
     * arriba. Las columnas que no son de dimensión (`FINANCIERO`,
     * `NO_ANALITICO`, `AMORTIZACION_DETERIORO`, `EXTRAORDINARIO`) no se
     * reconstruyen: su reparto depende de reglas de presentación y se declara.
     */
    const aportePorNivelYColumna = new Map<string, bigint>()
    let lineasSinNivel = CERO
    let lineas67Contadas = CERO
    for (const fila of lineas67) {
      const aporte = aBigInt(fila.aporte)
      lineas67Contadas += aBigInt(fila.n)
      /**
       * **Tipo EFECTIVO (R-A3/R-A4)**: la dimensión de la línea manda cuando
       * contradice al tipo persistido. Sin esto, MC2 y MC3 salen 246 000
       * céntimos por debajo —lo comprobó el auditor humano de T25 por un tercer
       * camino—, y la columna de la línea se elige mal.
       */
      const tipoDeclarado = fila.analytic_type as string
      const tieneProyecto = fila.project_id !== null && fila.project_id !== undefined
      const tieneCeco = fila.cost_center_id !== null && fila.cost_center_id !== undefined
      const tipo =
        tipoDeclarado === "INDIRECTO_CECO" && tieneProyecto && !tieneCeco
          ? "COSTE_DIRECTO_MC2"
          : TIPOS_DIRECTOS.includes(tipoDeclarado) && tieneCeco && !tieneProyecto
            ? "INDIRECTO_CECO"
            : tipoDeclarado
      let nivel: Nivel | null = null
      if (tipo === "INDIRECTO_CECO") {
        nivel = fila.cost_center_id ? nivelDeCeco.get(fila.cost_center_id as string) ?? null : null
        if (!nivel) {
          hallazgos.push({
            codigo: "A-CECO-SIN-NIVEL",
            gravedad: "ALTA",
            mensaje: `línea INDIRECTO_CECO de la cuenta ${fila.account_code} sin CECO o con CECO sin nivel (R-A7)`,
          })
        }
      } else if (tipo === "NO_ANALITICO") {
        // R-A11: 630/633/638 a RESULTADO siempre; el resto, al nivel declarado
        // por la organización.
        nivel = PREFIJOS_IMPUESTO.includes(String(fila.account_code).slice(0, 3))
          ? "RESULTADO"
          : nivelNoAnalitico
      } else if (tipo !== NULO) {
        nivel = nivelDeTipo.get(tipo) ?? null
        if (!nivel) {
          hallazgos.push({
            codigo: "A-TIPO-SIN-NIVEL",
            gravedad: "ALTA",
            mensaje: `el tipo analítico ${tipo} no está en ninguna configuración vigente a ${refDate}`,
          })
        }
      }
      if (!nivel) {
        lineasSinNivel += aBigInt(fila.n)
        continue
      }
      aportePorNivel.set(nivel, (aportePorNivel.get(nivel) ?? CERO) + aporte)

      /**
       * **La columna la fija el TIPO efectivo, no la dimensión** (R-A5 de
       * `docs/MODELO-DATOS.md`), con una excepción única: una amortización CON
       * proyecto va a la columna del proyecto. Reimplementado desde la regla
       * escrita, no copiado del motor.
       */
      const columnaProyecto = tieneProyecto ? columnaDeProyecto.get(fila.project_id as string) ?? null : null
      const columna =
        tipo === "INDIRECTO_CECO"
          ? tieneCeco
            ? columnaDeCeco.get(fila.cost_center_id as string) ?? "NO_ANALITICO"
            : "NO_ANALITICO"
          : TIPOS_DIRECTOS.includes(tipo)
            ? columnaProyecto ?? "NO_ANALITICO"
            : tipo === "AMORTIZACION_DETERIORO"
              ? columnaProyecto ?? "AMORTIZACION_DETERIORO"
              : tipo === "FINANCIERO" || tipo === "EXTRAORDINARIO"
                ? tipo
                : "NO_ANALITICO"
      const clave = `${nivel}|${columna}`
      aportePorNivelYColumna.set(clave, (aportePorNivelYColumna.get(clave) ?? CERO) + aporte)
    }
    if (lineasSinNivel > CERO) {
      hallazgos.push({
        codigo: "I4-LINEA-FUERA-DE-MATRIZ",
        gravedad: "ALTA",
        mensaje: `${lineasSinNivel} línea(s) 6/7 sin nivel de margen: la matriz no es exhaustiva (I4)`,
      })
    }

    /** Acumulado: cada nivel arrastra los anteriores (cascada de márgenes). */
    const nivelAcumulado = new Map<Nivel, bigint>()
    let acumulado = CERO
    for (const n of NIVELES) {
      acumulado += aportePorNivel.get(n) ?? CERO
      nivelAcumulado.set(n, acumulado)
    }

    // ── 4. PyG contable por las DOS vías (I3) ────────────────────────────────
    const pygDirecta = aBigInt(
      (
        await q(
          `SELECT COALESCE(SUM(l.credit_cents - l.debit_cents),0)::text AS v
             FROM journal_lines l
            WHERE l.organization_id = $1::uuid AND l.fiscal_year_id = $2::uuid
              AND left(l.account_code,1) IN ('6','7')
              AND l.entry_kind::text <> ALL ($3::text[])`,
          [opciones.org, fyId, KINDS_FUERA_PYG]
        )
      )[0].v
    )
    const saldo129 = aBigInt(
      (
        await q(
          `SELECT COALESCE(SUM(l.credit_cents - l.debit_cents),0)::text AS v
             FROM journal_lines l
            WHERE l.organization_id = $1::uuid AND l.fiscal_year_id = $2::uuid
              AND l.account_code = '129' AND l.entry_kind::text <> 'CLOSING'`,
          [opciones.org, fyId]
        )
      )[0].v
    )
    const regularizado = saldo129 !== CERO
    if (regularizado && saldo129 !== pygDirecta) {
      hallazgos.push({
        codigo: "I3-DOS-VIAS",
        gravedad: "ALTA",
        mensaje: `la PyG por grupos 6/7 (${pygDirecta}) no coincide con el saldo de la 129 (${saldo129})`,
      })
    }
    if (nivelAcumulado.get("RESULTADO") !== pygDirecta) {
      hallazgos.push({
        codigo: "I4-MATRIZ",
        gravedad: "ALTA",
        mensaje: `la matriz analítica en RESULTADO (${nivelAcumulado.get("RESULTADO")}) no cuadra con la PyG contable (${pygDirecta})`,
      })
    }

    // ── 5. Balance: activo y PN + pasivo (R-B1/R-B2/R-B4/R-B5, I2) ───────────
    //
    //  Saldo = Σdebe − Σhaber (positivo = deudor). Se excluye `CLOSING` —y sólo
    //  `CLOSING`—: incluirlo deja activo y PN+pasivo en cero justo el 31-12.
    const saldos = await q(
      `SELECT l.account_code,
              a.statement::text AS statement,
              a.bidirectional,
              SUM(l.debit_cents - l.credit_cents)::text AS saldo
         FROM journal_lines l
         JOIN accounts a ON a.organization_id = l.organization_id AND a.code = l.account_code
        WHERE l.organization_id = $1::uuid AND l.fiscal_year_id = $2::uuid
          AND l.entry_kind::text <> 'CLOSING'
        GROUP BY 1, 2, 3`,
      [opciones.org, fyId]
    )
    let activo = CERO
    let pnMasPasivo = CERO
    let sinEstado = 0
    let reclasificadas = 0
    for (const fila of saldos) {
      const saldo = aBigInt(fila.saldo)
      if (saldo === CERO) continue
      const statement = fila.statement as string | null
      if (statement === "BALANCE_ACTIVO") {
        if (fila.bidirectional && saldo < CERO) {
          // R-B4: la bidireccional con saldo acreedor se presenta en el pasivo.
          pnMasPasivo += -saldo
          reclasificadas += 1
        } else {
          activo += saldo
        }
      } else if (statement === "BALANCE_PASIVO" || statement === "BALANCE_PN") {
        if (fila.bidirectional && saldo > CERO) {
          activo += saldo
          reclasificadas += 1
        } else {
          pnMasPasivo += -saldo
        }
      } else if (statement === "PYG" || statement === "ECPN") {
        // Con el ejercicio regularizado, 6/7 quedan a cero: si no, el resultado
        // se inyecta más abajo (R-B5) y estas cuentas no van al balance.
        continue
      } else {
        sinEstado += 1
      }
    }
    if (sinEstado > 0) {
      hallazgos.push({
        codigo: "A-CUENTA-SIN-ESTADO",
        gravedad: "MEDIA",
        mensaje: `${sinEstado} cuenta(s) con saldo y sin \`statement\` en el plan: no entran en el balance`,
      })
    }
    if (!regularizado) {
      // R-B5: sin regularizar, el resultado del periodo se inyecta en PN. Nunca
      // las dos cosas.
      pnMasPasivo += pygDirecta
    }

    // ── 6. Tesorería (I6) ────────────────────────────────────────────────────
    const tesoreria = await q(
      `SELECT
         COALESCE(SUM(CASE WHEN l.entry_kind::text = 'OPENING'
                           THEN l.debit_cents - l.credit_cents ELSE 0 END),0)::text AS inicial,
         COALESCE(SUM(CASE WHEN l.entry_kind::text NOT IN ('OPENING','CLOSING')
                           THEN l.debit_cents - l.credit_cents ELSE 0 END),0)::text AS flujos,
         COALESCE(SUM(CASE WHEN l.entry_kind::text <> 'CLOSING'
                           THEN l.debit_cents - l.credit_cents ELSE 0 END),0)::text AS final
         FROM journal_lines l
        WHERE l.organization_id = $1::uuid AND l.fiscal_year_id = $2::uuid
          AND left(l.account_code, 2) = '57'`,
      [opciones.org, fyId]
    )
    const tesoreriaInicial = aBigInt(tesoreria[0].inicial)
    const tesoreriaFlujos = aBigInt(tesoreria[0].flujos)
    const tesoreriaFinal = aBigInt(tesoreria[0].final)
    if (tesoreriaInicial + tesoreriaFlujos !== tesoreriaFinal) {
      hallazgos.push({
        codigo: "I6-TESORERIA",
        gravedad: "ALTA",
        mensaje: `saldo inicial (${tesoreriaInicial}) + flujos (${tesoreriaFlujos}) ≠ saldo final (${tesoreriaFinal})`,
      })
    }
    // Y la identidad fuerte (R-CF-3): en todo asiento con tesorería, la suma de
    // las contrapartidas es exactamente el Δ57x del asiento. Un descuadre aquí
    // es un asiento roto que I1 ya habría cazado, pero por OTRA vía.
    const flujoPorContrapartida = await q(
      `SELECT COALESCE(SUM(-(l.debit_cents - l.credit_cents)),0)::text AS v
         FROM journal_lines l
        WHERE l.organization_id = $1::uuid AND l.fiscal_year_id = $2::uuid
          AND left(l.account_code, 2) <> '57'
          AND l.entry_kind::text NOT IN ('OPENING','CLOSING')
          AND EXISTS (SELECT 1 FROM journal_lines t
                       WHERE t.entry_id = l.entry_id AND t.organization_id = l.organization_id
                         AND left(t.account_code, 2) = '57')`,
      [opciones.org, fyId]
    )
    const flujosPorContrapartida = aBigInt(flujoPorContrapartida[0].v)
    if (flujosPorContrapartida !== tesoreriaFlujos) {
      hallazgos.push({
        codigo: "I6-CONTRAPARTIDAS",
        gravedad: "ALTA",
        mensaje: `los flujos por contrapartida (${flujosPorContrapartida}) no reproducen el Δ57x (${tesoreriaFlujos})`,
      })
    }

    // ── 7. Los sellos, reimplementados desde ADR-0011 ────────────────────────
    //
    //  `ledgerHash` v2: una fila TSV por línea con
    //  (entryDate, entryNumber, lineNo, accountCode, debitCents, creditCents,
    //   entryKind), orden canónico (entryDate, entryNumber, lineNo), `\n` entre
    //  filas, sha256 hex minúscula sobre UTF-8. Sin uuids: el sello es función
    //  del CONTENIDO CONTABLE y es comparable entre cargas.
    const ledgerHashDe = async (desde: string | null, hasta: string | null): Promise<string> => {
      const filas = await q(
        `SELECT to_char(l.entry_date,'YYYY-MM-DD') AS f, e.entry_number, l.line_no,
                l.account_code, l.debit_cents::text AS d, l.credit_cents::text AS c,
                l.entry_kind::text AS k
           FROM journal_lines l
           JOIN journal_entries e ON e.id = l.entry_id AND e.organization_id = l.organization_id
          WHERE l.organization_id = $1::uuid
            AND ($2::date IS NULL OR l.entry_date >= $2::date)
            AND ($3::date IS NULL OR l.entry_date <= $3::date)
          ORDER BY l.entry_date, e.entry_number, l.line_no`,
        [opciones.org, desde, hasta]
      )
      return hashDeFilas(
        filas.map((r) =>
          [r.f, String(r.entry_number), String(r.line_no), r.account_code, r.d, r.c, r.k].join(TAB)
        )
      )
    }
    const ledgerHashPeriodo = await ledgerHashDe(fy.start_date as string, fy.end_date as string)
    const ledgerHashOrg = await ledgerHashDe(null, null)

    //  `entryHash` v2/v3: sello de FILA, con TODAS las columnas, uuids
    //  incluidos. v3 (ADR-0014 D2) añade las tres columnas de divisa original.
    const lineasSello = await q(
      `SELECT l.entry_id, e.entry_number, l.line_no, l.account_code,
              l.debit_cents::text AS d, l.credit_cents::text AS c,
              to_char(l.entry_date,'YYYY-MM-DD') AS f, l.fiscal_year_id, l.entry_kind::text AS k,
              l.tax_rate_id, l.tax_base_cents::text AS tb, l.counterparty_id,
              to_char(l.due_date,'YYYY-MM-DD') AS venc, l.description, l.analytic_type::text AS at,
              l.project_id, l.cost_center_id, l.business_line_id,
              l.original_currency, l.original_amount_cents::text AS oa, l.exchange_rate_id,
              e.entry_hash, e.hash_version
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.entry_id AND e.organization_id = l.organization_id
        WHERE l.organization_id = $1::uuid AND l.fiscal_year_id = $2::uuid
        ORDER BY l.entry_id, l.line_no`,
      [opciones.org, fyId]
    )
    const porAsiento = new Map<string, { filas: string[]; sello: string; version: number }>()
    for (const l of lineasSello) {
      const base = [
        String(l.entry_id),
        String(l.entry_number),
        String(l.line_no),
        String(l.account_code),
        String(l.d),
        String(l.c),
        String(l.f),
        String(l.fiscal_year_id),
        String(l.k),
        texto(l.tax_rate_id),
        texto(l.tb),
        texto(l.counterparty_id),
        texto(l.venc),
        texto(l.description),
        texto(l.at),
        texto(l.project_id),
        texto(l.cost_center_id),
        texto(l.business_line_id),
      ]
      const v3 = Number(l.hash_version) >= 3
      const fila = (v3
        ? base.concat([texto(l.original_currency), texto(l.oa), texto(l.exchange_rate_id)])
        : base
      ).join(TAB)
      const clave = String(l.entry_id)
      const actual = porAsiento.get(clave)
      if (actual) actual.filas.push(fila)
      else porAsiento.set(clave, { filas: [fila], sello: String(l.entry_hash), version: Number(l.hash_version) })
    }
    let sellosOk = 0
    const sellosRotos: string[] = []
    for (const [id, a] of porAsiento) {
      if (hashDeFilas(a.filas) === a.sello) sellosOk += 1
      else if (sellosRotos.length < 20) sellosRotos.push(id)
      else sellosRotos.push("…")
    }
    const totalAsientos = porAsiento.size
    if (totalAsientos > 0 && sellosOk === 0) {
      // Ni uno solo cuadra: lo honesto es decir que la forma reimplementada no
      // reproduce la del producto, NO acusar al diario de estar alterado.
      hallazgos.push({
        codigo: "A-ENTRYHASH-FORMA",
        gravedad: "MEDIA",
        mensaje:
          "la tupla de ADR-0011 reimplementada no reproduce NINGÚN entry_hash: " +
          "o la forma canónica implementada difiere del ADR, o el sello es de otra versión. No se concluye nada del diario",
      })
    } else if (sellosRotos.length > 0) {
      hallazgos.push({
        codigo: "I-E3-7-SELLO-ROTO",
        gravedad: "ALTA",
        mensaje: `${sellosRotos.length} asiento(s) con entry_hash que no reproduce su contenido (${sellosOk}/${totalAsientos} correctos)`,
        evidencia: sellosRotos.slice(0, 20),
      })
    }

    //  `analyticsHash` — parte de DIMENSIONES de la tupla de ADR-0011. La
    //  concatenación con `marginConfigHash` y `allocationRunSetHash` no está
    //  fijada canónicamente: se reconstruye la parte que sí lo está.
    const filasDimensiones = await q(
      `SELECT l.entry_id, l.line_no, l.project_id, l.cost_center_id, l.business_line_id,
              l.analytic_type::text AS at
         FROM journal_lines l
        WHERE l.organization_id = $1::uuid AND l.fiscal_year_id = $2::uuid
        ORDER BY l.entry_id, l.line_no`,
      [opciones.org, fyId]
    )
    const analyticsHashDimensiones = hashDeFilas(
      filasDimensiones.map((r) =>
        [
          String(r.entry_id),
          String(r.line_no),
          texto(r.project_id),
          texto(r.cost_center_id),
          texto(r.business_line_id),
          texto(r.at),
        ].join(TAB)
      )
    )

    // ── 8. Lo que el producto tiene SELLADO ──────────────────────────────────
    const reportRuns = await q(
      `SELECT id, type::text AS type, to_char(period_start,'YYYY-MM-DD') AS ps,
              to_char(period_end,'YYYY-MM-DD') AS pe, ledger_hash, analytics_hash,
              margin_config_hash, allocation_run_set_hash, analytics_key, budget_hash,
              seal::text AS seal, result, provenance, created_at
         FROM report_runs
        WHERE organization_id = $1::uuid
          AND period_start = $2::date AND period_end = $3::date
        ORDER BY created_at DESC
        LIMIT 40`,
      [opciones.org, fy.start_date, fy.end_date]
    )
    const invariantRuns = await q(
      `SELECT id, ledger_hash, analytics_key, headline, seal::text AS seal,
              scope_kind::text AS scope_kind,
              to_char(period_start,'YYYY-MM-DD') AS ps, to_char(period_end,'YYYY-MM-DD') AS pe
         FROM invariant_runs
        WHERE organization_id = $1::uuid
          AND (fiscal_year_id = $2::uuid
               OR (period_start = $3::date AND period_end = $4::date))
        ORDER BY created_at DESC
        LIMIT 20`,
      [opciones.org, fyId, fy.start_date, fy.end_date]
    )
    const allocationRuns = await q(
      `SELECT id, status::text AS status, ledger_hash, analytics_hash, lines_hash,
              total_allocated_cents::text AS total, line_count,
              to_char(period_start,'YYYY-MM-DD') AS ps, to_char(period_end,'YYYY-MM-DD') AS pe
         FROM allocation_runs
        WHERE organization_id = $1::uuid AND fiscal_year_id = $2::uuid
        ORDER BY period_start`,
      [opciones.org, fyId]
    )
    const closingRuns = await q(
      `SELECT id, status::text AS status, ledger_hash, seal::text AS seal,
              to_char(ref_date,'YYYY-MM-DD') AS ref
         FROM closing_runs
        WHERE organization_id = $1::uuid AND fiscal_year_id = $2::uuid
        ORDER BY created_at DESC`,
      [opciones.org, fyId]
    )
    const presupuestos = await q(
      `SELECT id, scenario::text AS scenario, revision, status::text AS status, budget_hash
         FROM budgets
        WHERE organization_id = $1::uuid AND fiscal_year_id = $2::uuid
        ORDER BY revision`,
      [opciones.org, fyId]
    )

    // Sondeo de las cifras dentro de los JSON sellados.
    const sondas = new Map<string, Sonda[]>()
    for (const metrica of Object.keys(ALIAS)) {
      const alias = ALIAS[metrica]
      const encontradas: Sonda[] = []
      for (const r of invariantRuns) {
        encontradas.push(
          ...sondear(r.headline, alias, `invariant_runs[${String(r.id).slice(0, 8)}].headline`)
        )
      }
      for (const r of reportRuns) {
        encontradas.push(
          ...sondear(r.result, alias, `report_runs[${r.type}/${String(r.id).slice(0, 8)}].result`)
        )
        encontradas.push(
          ...sondear(r.provenance, alias, `report_runs[${r.type}/${String(r.id).slice(0, 8)}].provenance`)
        )
      }
      sondas.set(metrica, encontradas)
    }

    // ── 9. Las doce filas ────────────────────────────────────────────────────
    const reconstruido = new Map<string, bigint>([
      ...NIVELES.map((n) => [n, nivelAcumulado.get(n) as bigint] as [string, bigint]),
      ["SUMA_DEBE", sumaDebe],
      ["ACTIVO", activo],
      ["PN_MAS_PASIVO", pnMasPasivo],
      ["TESORERIA", tesoreriaFinal],
    ])
    const metodo: Record<string, string> = {
      SUMA_DEBE: "Σ debit_cents de journal_lines del ejercicio (BigInt); Σdebe=Σhaber comprobado por asiento en SQL",
      ACTIVO:
        "Σ(debe−haber) por cuenta con kind ≠ CLOSING, agrupado por accounts.statement; bidireccionales reclasificadas (R-B4)",
      PN_MAS_PASIVO:
        "Σ(haber−debe) de BALANCE_PN + BALANCE_PASIVO con kind ≠ CLOSING; resultado inyectado sólo si la 129 está a cero (R-B5)",
      TESORERIA: "Σ(debe−haber) de las cuentas 57x con kind ≠ CLOSING; contrastado con inicial + flujos y con las contrapartidas",
    }
    for (const n of NIVELES) {
      metodo[n] =
        "cascada acumulada sobre líneas 6/7 con kind ∉ {REGULARIZATION, CLOSING, OPENING}; " +
        "nivel por margin_level_configs vigente, INDIRECTO_CECO por cost_centers.margin_level, NO_ANALITICO por R-A11"
    }

    const cifras: Cifra[] = []
    let reconstruidas = 0
    let comparadas = 0
    for (const metrica of [...NIVELES, "SUMA_DEBE", "ACTIVO", "PN_MAS_PASIVO", "TESORERIA"]) {
      const rec = reconstruido.get(metrica) ?? null
      if (rec !== null) reconstruidas += 1
      const encontradas = sondas.get(metrica) ?? []
      const distintas = [...new Set(encontradas.map((s) => s.valor.toString()))]
      let producto: bigint | null = null
      let fuente: string | null = null
      if (distintas.length === 1) {
        producto = BigInt(distintas[0])
        fuente = encontradas[0].ruta
        comparadas += 1
      } else if (distintas.length > 1) {
        hallazgos.push({
          codigo: "P-PRODUCTO-CONTRADICTORIO",
          gravedad: "ALTA",
          mensaje: `el producto tiene sellados ${distintas.length} valores distintos para ${metrica}`,
          evidencia: encontradas.map((s) => ({ ruta: s.ruta, valor: s.valor.toString() })),
        })
      }
      const delta = producto !== null && rec !== null ? producto - rec : null
      if (delta !== null && delta !== CERO) {
        hallazgos.push({
          codigo: "C4-DELTA",
          gravedad: "ALTA",
          mensaje: `${metrica}: el producto sella ${producto} y la reconstrucción da ${rec} (Δ ${delta})`,
          evidencia: { fuente },
        })
      }
      cifras.push({
        metrica,
        producto: producto === null ? null : producto.toString(),
        reconstruccion: rec === null ? null : rec.toString(),
        delta: delta === null ? null : delta.toString(),
        metodo: metodo[metrica],
        fuenteProducto: fuente,
      })
    }

    // ── 10. Los sellos, contra lo sellado ────────────────────────────────────
    const sellos: Cifra[] = []
    const compararSello = (
      metrica: string,
      producto: string | null,
      reconstruccion: string | null,
      metodoTxt: string,
      fuente: string | null,
      gravedad: Hallazgo["gravedad"] = "ALTA"
    ): void => {
      const iguales = producto !== null && reconstruccion !== null ? producto === reconstruccion : null
      if (iguales === false) {
        hallazgos.push({
          codigo: gravedad === "ALTA" ? "C4-SELLO" : "C4-SELLO-INDETERMINADO",
          gravedad,
          mensaje: `${metrica}: el producto sella ${String(producto).slice(0, 16)}… y la reconstrucción da ${String(
            reconstruccion
          ).slice(0, 16)}…`,
          evidencia: { fuente, producto, reconstruccion },
        })
      }
      sellos.push({
        metrica,
        producto,
        reconstruccion,
        delta: iguales === null ? null : iguales ? "0" : "≠",
        metodo: metodoTxt,
        fuenteProducto: fuente,
      })
    }

    // Cada artefacto sellado se contrasta con el hash recomputado sobre SU
    // periodo, no sobre uno prestado.
    const cacheLedger = new Map<string, string>([
      [`${fy.start_date}|${fy.end_date}`, ledgerHashPeriodo],
      ["|", ledgerHashOrg],
    ])
    const ledgerHashCacheado = async (ps: string | null, pe: string | null): Promise<string> => {
      const clave = `${ps ?? ""}|${pe ?? ""}`
      const hit = cacheLedger.get(clave)
      if (hit) return hit
      const v = await ledgerHashDe(ps, pe)
      cacheLedger.set(clave, v)
      return v
    }

    for (const r of reportRuns.slice(0, 10)) {
      compararSello(
        `ledgerHash · report_run ${r.type}`,
        r.ledger_hash,
        await ledgerHashCacheado(r.ps as string, r.pe as string),
        "forma canónica v2 de ADR-0011 recomputada en Node sobre el periodo del propio informe",
        `report_runs[${String(r.id).slice(0, 8)}]`
      )
      // `analytics_key` la compone un trigger: recomponerla delata un UPDATE.
      const esperada = `${r.analytics_hash ?? NULO}|${r.margin_config_hash ?? NULO}|${
        r.allocation_run_set_hash ?? NULO
      }`
      compararSello(
        `analyticsKey · report_run ${r.type}`,
        r.analytics_key,
        esperada,
        "recomposición de analytics_hash|margin_config_hash|allocation_run_set_hash (trigger app.report_runs_analytics_key)",
        `report_runs[${String(r.id).slice(0, 8)}]`
      )
    }
    for (const r of invariantRuns.slice(0, 5)) {
      // El ámbito del barrido decide el periodo del hash: PERIOD trae sus
      // fechas, FISCAL_YEAR es el ejercicio entero y ORGANIZATION, todo.
      const esperadoLedger =
        r.scope_kind === "PERIOD" && r.ps && r.pe
          ? await ledgerHashCacheado(r.ps as string, r.pe as string)
          : r.scope_kind === "FISCAL_YEAR"
            ? ledgerHashPeriodo
            : ledgerHashOrg
      compararSello(
        `ledgerHash · invariant_run ${r.scope_kind}`,
        r.ledger_hash,
        esperadoLedger,
        "forma canónica v2 de ADR-0011 recomputada sobre el ámbito del barrido",
        `invariant_runs[${String(r.id).slice(0, 8)}]`
      )
    }
    for (const r of closingRuns.slice(0, 5)) {
      compararSello(
        "ledgerHash · closing_run",
        r.ledger_hash,
        ledgerHashPeriodo,
        "forma canónica v2 de ADR-0011 recomputada sobre el ejercicio del cierre",
        `closing_runs[${String(r.id).slice(0, 8)}]`
      )
    }
    for (const r of allocationRuns.filter((x) => x.status === "SEALED").slice(0, 12)) {
      compararSello(
        "ledgerHash · allocation_run",
        r.ledger_hash,
        await ledgerHashCacheado(r.ps as string, r.pe as string),
        "forma canónica v2 de ADR-0011 recomputada sobre el periodo del reparto",
        `allocation_runs[${String(r.id).slice(0, 8)}]`
      )
      compararSello(
        "analyticsHash(dimensiones) · allocation_run",
        r.analytics_hash,
        analyticsHashDimensiones,
        "tupla de dimensiones de ADR-0011; la concatenación con marginConfigHash NO es canónica: un ≠ aquí es INDETERMINADO",
        `allocation_runs[${String(r.id).slice(0, 8)}]`,
        "BAJA"
      )
      if (!r.lines_hash) {
        hallazgos.push({
          codigo: "I-E7-9",
          gravedad: "MEDIA",
          mensaje: `el reparto sellado ${String(r.id).slice(0, 8)} no tiene linesHash: su salida no está sellada`,
        })
      }
    }
    // ── 8-bis · La matriz analítica, CELDA A CELDA (AUD-8 / H-5) ────────────
    //
    //  Comparar sólo totales dejaba pasar una redistribución entre columnas: el
    //  auditor decía CONFORME sobre un informe en el que cien mil céntimos
    //  habían cambiado de proyecto. Aquí se reconstruye la matriz ACUMULADA por
    //  nivel y columna de dimensión y se contrasta con la sellada.
    const analiticasSelladas = reportRuns.filter((r) => r.type === "PYG_ANALITICA")
    const repartosVigentes = allocationRuns.filter((x) => x.status === "SEALED")
    if (analiticasSelladas.length > 0 && repartosVigentes.length > 0) {
      hallazgos.push({
        codigo: "A-MATRIZ-DIMENSION-NO-COMPARABLE",
        gravedad: "BAJA",
        mensaje:
          `hay ${repartosVigentes.length} reparto(s) sellado(s) en el periodo: la matriz por dimensión incluye la ` +
          "cascada de liquidación de CECOs, que este auditor NO rehace receptor a receptor (límite 6). " +
          "Las celdas por dimensión no se contrastan; los totales de nivel sí",
      })
    } else {
      for (const informe of analiticasSelladas.slice(0, 3)) {
        const resultado = (informe.result ?? {}) as { matrixCents?: Record<string, Record<string, unknown>> }
        const matriz = resultado.matrixCents
        if (!matriz) continue
        /** Acumulada por columna: cada nivel arrastra los anteriores. */
        const acumuladoPorColumna = new Map<string, bigint>()
        const desviadas: string[] = []
        let celdasComparadas = 0
        for (const nivel of NIVELES) {
          const fila = matriz[nivel]
          if (!fila) continue
          for (const columna of Object.keys(fila)) {
            if (!columna.startsWith("PROJ:") && !columna.startsWith("CECO:")) continue
            const previo = acumuladoPorColumna.get(columna) ?? CERO
            const esperado = previo + (aportePorNivelYColumna.get(`${nivel}|${columna}`) ?? CERO)
            acumuladoPorColumna.set(columna, esperado)
            const sellado = aBigInt(String(fila[columna] ?? "0"))
            celdasComparadas += 1
            if (sellado !== esperado) {
              desviadas.push(`${nivel}/${columna}: sellado ${sellado} vs reconstruido ${esperado} (Δ ${sellado - esperado})`)
            }
          }
        }
        if (desviadas.length > 0) {
          hallazgos.push({
            codigo: "I4-DIMENSION",
            gravedad: "ALTA",
            mensaje:
              `la matriz analítica sellada no reproduce ${desviadas.length} de ${celdasComparadas} celda(s) por dimensión ` +
              "sobre el diario (los totales de nivel pueden estar intactos: una redistribución entre columnas los conserva)",
            evidencia: desviadas.slice(0, 20),
          })
        } else if (celdasComparadas > 0) {
          sellos.push({
            metrica: `matrizPorDimension · report_run ${String(informe.id).slice(0, 8)}`,
            producto: `${celdasComparadas} celdas`,
            reconstruccion: `${celdasComparadas} celdas`,
            delta: "0",
            metodo: "matriz acumulada por nivel y columna (PROJ:/CECO:) reconstruida por SQL crudo sobre journal_lines",
            fuenteProducto: `report_runs[${String(informe.id).slice(0, 8)}].matrixCents`,
          })
        }
      }
    }

    for (const b of presupuestos) {
      if (b.status === "VIGENTE" && !b.budget_hash) {
        hallazgos.push({
          codigo: "I-E10-6-ESTRUCTURAL",
          gravedad: "ALTA",
          mensaje: `el presupuesto ${b.scenario}-${b.revision} está VIGENTE sin budgetHash`,
        })
      }
      sellos.push({
        metrica: `budgetHash · ${b.scenario}-${b.revision}`,
        producto: (b.budget_hash as string) ?? null,
        reconstruccion: null,
        delta: null,
        metodo: "NO reconstruible: ADR-0018 describe el contenido pero no fija la forma canónica (ver cabecera, límite 3)",
        fuenteProducto: `budgets[${String(b.id).slice(0, 8)}]`,
      })
    }

    if (
      reportRuns.length === 0 &&
      invariantRuns.length === 0 &&
      allocationRuns.length === 0 &&
      closingRuns.length === 0 &&
      presupuestos.length === 0
    ) {
      hallazgos.push({
        codigo: "P-SIN-SELLOS",
        gravedad: "ALTA",
        mensaje:
          `el producto no ha sellado nada del ejercicio ${fy.code}: no hay report_runs, invariant_runs, ` +
          "allocation_runs, closing_runs ni budgets con los que contrastar. La reconstrucción existe, la comparación no",
      })
    }

    // ── 11. Veredicto ────────────────────────────────────────────────────────
    const contradiccionesInternas = hallazgos.filter(
      (h) => h.gravedad === "ALTA" && !h.codigo.startsWith("P-SIN-SELLOS")
    )
    let veredicto: Veredicto
    if (reconstruidas < 3) {
      veredicto = "NO_VERIFICABLE"
    } else if (contradiccionesInternas.length > 0) {
      veredicto = "DISCREPANCIA"
    } else if (comparadas === 0 && sellos.filter((s) => s.delta === "0").length === 0) {
      veredicto = "NO_VERIFICABLE"
    } else {
      veredicto = "CONFORME"
    }

    const salida = {
      veredicto,
      cifras,
      sellos,
      hallazgos,
      trazabilidad: {
        auditor: "scripts/audit-reconstruct.ts",
        versionAuditor: VERSION_AUDITOR,
        generadoEn: new Date().toISOString(),
        base: urlSinSecreto(opciones.databaseUrl),
        organizacion: { id: org.id, nombre: org.name, monedaBase: org.base_currency },
        ejercicio: { id: fyId, codigo: fy.code, desde: fy.start_date, hasta: fy.end_date, estado: fy.status },
        refDate,
        universo: {
          asientos: nAsientos.toString(),
          lineas: nLineas.toString(),
          lineas67: lineas67Contadas.toString(),
          kindsExcluidosPyG: KINDS_FUERA_PYG,
          cuentasBidireccionalesReclasificadas: reclasificadas,
        },
        configuracion: {
          nivelesVigentes: configNiveles.map((c) => ({ nivel: c.level, tipos: c.tipos, desde: c.valid_from })),
          nivelNoAnalitico,
          prefijosImpuestoAResultado: PREFIJOS_IMPUESTO,
          cecosPorNivel: cecos.map((c) => ({ codigo: c.code, nivel: c.margin_level, imputable: c.allocatable })),
        },
        contrastes: {
          pygPorGrupos67: pygDirecta.toString(),
          saldo129: saldo129.toString(),
          ejercicioRegularizado: regularizado,
          tesoreriaInicial: tesoreriaInicial.toString(),
          tesoreriaFlujos: tesoreriaFlujos.toString(),
          entryHashCorrectos: `${sellosOk}/${totalAsientos}`,
        },
        sellosReconstruidos: {
          ledgerHashEjercicio: ledgerHashPeriodo,
          ledgerHashOrganizacion: ledgerHashOrg,
          analyticsHashDimensiones,
        },
        fuentesProducto: {
          reportRuns: reportRuns.length,
          invariantRuns: invariantRuns.length,
          allocationRuns: allocationRuns.length,
          closingRuns: closingRuns.length,
          budgets: presupuestos.length,
        },
        cifrasReconstruidas: reconstruidas,
        cifrasComparadas: comparadas,
        codigoNoDetecta: "ver la cabecera del script: diez límites declarados",
      },
    }

    if (opciones.out) writeFileSync(opciones.out, JSON.stringify(salida, null, 2) + "\n", "utf8")

    // ── 12. Consola: 30 líneas como mucho ────────────────────────────────────
    const lineasSalida: string[] = []
    lineasSalida.push(
      `auditor · org ${String(org.id).slice(0, 8)} · ejercicio ${fy.code} (${fy.start_date}…${fy.end_date}) · ${nAsientos} asientos`
    )
    for (const c of cifras) {
      const p = c.producto ?? "—"
      const r = c.reconstruccion ?? "—"
      const d = c.delta === null ? "sin comparar" : c.delta === "0" ? "Δ 0" : `Δ ${c.delta}`
      lineasSalida.push(`  ${c.metrica.padEnd(14)} producto ${p.padStart(12)} · auditor ${r.padStart(12)} · ${d}`)
    }
    const sellosOkN = sellos.filter((s) => s.delta === "0").length
    const sellosKoN = sellos.filter((s) => s.delta === "≠").length
    lineasSalida.push(
      `  sellos: ${sellosOkN} coinciden, ${sellosKoN} no, ${sellos.length - sellosOkN - sellosKoN} sin contraste · entry_hash ${sellosOk}/${totalAsientos} · ledgerHash ${ledgerHashPeriodo.slice(0, 12)}…`
    )
    const hueco = 29 - lineasSalida.length
    const graves = hallazgos.filter((h) => h.gravedad !== "INFO")
    for (const h of graves.slice(0, Math.max(0, hueco - 1))) {
      lineasSalida.push(`  [${h.gravedad}] ${h.codigo}: ${h.mensaje}`.slice(0, 160))
    }
    if (graves.length > Math.max(0, hueco - 1)) {
      lineasSalida.push(`  … y ${graves.length - Math.max(0, hueco - 1)} hallazgo(s) más en el JSON`)
    }
    lineasSalida.push(
      `VEREDICTO: ${veredicto} · ${reconstruidas}/12 reconstruidas · ${comparadas}/12 contrastadas · ${hallazgos.length} hallazgo(s)` +
        (opciones.out ? ` · ${opciones.out}` : "")
    )
    process.stdout.write(lineasSalida.slice(0, 30).join("\n") + "\n")

    process.exitCode = veredicto === "CONFORME" ? 0 : 1
  } finally {
    await cliente.end()
  }
}

main().catch((e: unknown) => {
  // Un auditor que revienta NO es un aprobado: sale con veredicto NO_VERIFICABLE.
  process.stderr.write(`VEREDICTO: NO_VERIFICABLE · el auditor no pudo completar: ${String(e)}\n`)
  process.exit(1)
})
