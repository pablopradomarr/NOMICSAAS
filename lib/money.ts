/**
 * Utilidades de dinero (ADR-0006). Todo importe es un entero en céntimos.
 * Módulo puro: sin IO, sin fechas, sin dependencias.
 */

export type Cents = number

const isSafeInt = (n: number) => Number.isInteger(n) && Number.isSafeInteger(n)

export function assertCents(n: unknown, label = "importe"): asserts n is Cents {
  if (typeof n !== "number" || !isSafeInt(n)) {
    throw new TypeError(`${label} debe ser un entero en céntimos, recibido: ${String(n)}`)
  }
}

/** Redondeo half-even (banquero) de un número decimal a entero. */
export function roundHalfEven(x: number): number {
  if (!Number.isFinite(x)) throw new TypeError(`roundHalfEven: valor no finito ${x}`)
  const floor = Math.floor(x)
  const diff = x - floor
  const EPS = 1e-9
  const r = Math.abs(diff - 0.5) < EPS ? (floor % 2 === 0 ? floor : floor + 1) : diff > 0.5 ? floor + 1 : floor
  return r === 0 ? 0 : r // normaliza -0
}

/**
 * Parsea un importe textual ("1.234,56", "1234.56", "-12,5 €", "1 234,56") a céntimos.
 * Acepta separadores es-ES y en-US; el último separador (',' o '.') se toma como decimal
 * cuando va seguido de 1–2 dígitos. Devuelve null si no es interpretable.
 */
export function parseCents(input: string | number | null | undefined): Cents | null {
  if (input === null || input === undefined) return null
  if (typeof input === "number") return Number.isFinite(input) ? roundHalfEven(input * 100) : null
  let s = input.trim().replace(/[€$£\s ]/g, "")
  if (s === "") return null
  const negative = /^\(.*\)$/.test(s) || s.startsWith("-")
  s = s.replace(/^[-(]/, "").replace(/\)$/, "").replace(/^\+/, "")
  if (!/^[\d.,]+$/.test(s)) return null
  const lastComma = s.lastIndexOf(",")
  const lastDot = s.lastIndexOf(".")
  const lastSep = Math.max(lastComma, lastDot)
  let intPart = s
  let decPart = ""
  if (lastSep >= 0) {
    const after = s.slice(lastSep + 1)
    if (after.length >= 1 && after.length <= 2 && /^\d+$/.test(after)) {
      intPart = s.slice(0, lastSep)
      decPart = after
    }
  }
  intPart = intPart.replace(/[.,]/g, "")
  if (!/^\d*$/.test(intPart)) return null
  const cents = Number(intPart || "0") * 100 + Number((decPart + "00").slice(0, 2))
  if (!isSafeInt(cents)) return null
  return negative ? -cents : cents
}

export interface FormatOptions {
  currency?: string // ISO 4217; por defecto EUR
  locale?: string // por defecto es-ES
  zeroAsDash?: boolean
  showSign?: boolean
}

/** Formatea céntimos como "1.234,56 €" (es-ES). 0 → "—" si zeroAsDash. */
export function formatCents(cents: Cents, opts: FormatOptions = {}): string {
  assertCents(cents)
  const { currency = "EUR", locale = "es-ES", zeroAsDash = false, showSign = false } = opts
  if (cents === 0 && zeroAsDash) return "—"
  const fmt = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: showSign ? "exceptZero" : "auto",
    useGrouping: "always",
  })
  // Usamos signo menos tipográfico para negativos (guía ui-erp)
  return fmt.format(cents / 100).replace("-", "−")
}

/** Convierte céntimos aplicando un tipo en permille (21% = 210). Redondeo half-even. */
export function applyPermille(cents: Cents, permille: number): Cents {
  assertCents(cents)
  if (!isSafeInt(permille)) throw new TypeError("permille debe ser entero")
  return roundHalfEven((cents * permille) / 1000)
}

/**
 * Convierte con tasa en micro-unidades (rate × 1e6), **half-even y en enteros**.
 *
 * E8 · T13: es la ÚNICA conversión de divisa del producto. Antes había tres
 * copias —ésta, `lib/extraction/reconcile.convertWithRate` y la de
 * `lib/ledger/invariants-e8`— y dos de ellas se escribieron en `BigInt` porque
 * el producto `cents × rate` supera 2^53 en cuanto hay millones de euros: con
 * dobles, el céntimo del desempate deja de ser el real y el invariante que
 * compara las dos aritméticas falla sobre datos correctos. Se conserva la
 * exacta y las otras dos delegan aquí.
 */
export function convertWithRateMicro(cents: Cents, rateMicro: bigint | number): Cents {
  assertCents(cents)
  const r = typeof rateMicro === "bigint" ? rateMicro : BigInt(rateMicro)
  if (r <= BigInt(0)) throw new TypeError("rateMicro debe ser entero positivo")
  const two = BigInt(2)
  const one = BigInt(1)
  const denominator = BigInt(1_000_000)
  const product = BigInt(Math.abs(cents)) * r
  const quotient = product / denominator
  const remainder = product - quotient * denominator
  const twice = remainder * two
  const rounded = twice > denominator || (twice === denominator && quotient % two === one) ? quotient + one : quotient
  return (cents < 0 ? -1 : 1) * Number(rounded)
}

/**
 * Reparto de un importe total según pesos, sin perder ni crear céntimos
 * (método del mayor resto / Hamilton). Los restos se asignan por mayor fracción y,
 * en empate, al de mayor peso; en empate total, al de menor índice.
 * Σ resultado === total siempre. Pesos ≥ 0; si todos son 0 → reparto igualitario.
 */
export function splitLargestRemainder(total: Cents, weights: number[]): Cents[] {
  assertCents(total, "total")
  if (weights.length === 0) return []
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) throw new TypeError("pesos deben ser ≥ 0")
  const sumW = weights.reduce((a, b) => a + b, 0)
  const w = sumW === 0 ? weights.map(() => 1) : weights
  const sw = sumW === 0 ? weights.length : sumW
  const sign = total < 0 ? -1 : 1
  const abs = Math.abs(total)
  const exact = w.map((x) => (abs * x) / sw)
  const base = exact.map((x) => Math.floor(x))
  let remainder = abs - base.reduce((a, b) => a + b, 0)
  const order = exact
    .map((x, i) => ({ i, frac: x - base[i], w: w[i] }))
    .sort((a, b) => b.frac - a.frac || b.w - a.w || a.i - b.i)
  for (const { i } of order) {
    if (remainder <= 0) break
    base[i] += 1
    remainder -= 1
  }
  return base.map((x) => sign * x)
}

/** Suma segura de céntimos (lanza si algún elemento no es entero). */
export function sumCents(values: Iterable<Cents>): Cents {
  let acc = 0
  for (const v of values) {
    assertCents(v)
    acc += v
    if (!isSafeInt(acc)) throw new RangeError("suma fuera de rango seguro; usar BigInt")
  }
  return acc
}

/**
 * Puntos básicos como porcentaje con dos decimales, **sin coma flotante**
 * (revisión E5 ronda 1, #13). `(bps / 100).toFixed(2)` repartido por el motor,
 * los formularios y los modelos era el mismo patrón copiado cuatro veces y, aun
 * siendo presentación y no dinero, el checklist es literal: la conversión vive
 * aquí y es aritmética entera. Devuelve sólo el número (`"70.00"`); el signo `%`
 * lo pone el mensaje, que decide si lleva espacio duro.
 */
export function formatBps(bps: number): string {
  const n = Math.trunc(bps)
  const abs = Math.abs(n)
  return `${n < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`
}

// ─────────────────────────────────────────────────────────────────────────────
// El borde `bigint` ↔ `number` (E7 · ADR-0015 D1)
//
// Desde E7, `journal_lines.debit_cents`, `credit_cents`, `tax_base_cents` y
// `original_amount_cents` son `bigint` en PostgreSQL (el techo de `integer`
// eran 21 474 836,47 € y el producto se vende a empresas de 1 a 100 M€). El
// motor contable y la interfaz SIGUEN en `number`: la conversión vive en el
// borde (`models/ledger.ts`, `models/analytics.ts`), igual que en
// `models/allocations.ts` desde E5.
//
// **El riesgo real está aquí, no en el DDL** (ADR-0015 D1, O-23): Prisma
// devuelve `BigInt`, `JSON.stringify(BigInt)` LANZA, y el arreglo apresurado
// —serializar como cadena `"1234"`— SÍ cambiaría `entryHash` y `ledgerHash` sin
// cambiar una sola cifra. Por eso el borde es explícito y ruidoso:
// `Number.isSafeInteger` o excepción, nunca una pérdida de precisión callada.
// ─────────────────────────────────────────────────────────────────────────────

/** Techo del borde: 2^53 − 1 céntimos ≈ 90 mil millones de euros. */
export const MAX_SAFE_CENTS: Cents = Number.MAX_SAFE_INTEGER

/**
 * `bigint` de la base → `Cents` del motor. **Lanza** por encima de 2^53 − 1 en
 * vez de perder precisión en silencio (ADR-0015 D1, aserción (b) del criterio
 * de aceptación 24).
 */
export function centsFromDb(value: bigint | number | string, label = "importe"): Cents {
  // El driver `pg` devuelve `int8` y `numeric` como CADENA de dígitos; Prisma,
  // con el adaptador, como `BigInt`. Los dos caminos existen en el repositorio
  // (`$queryRaw` y `Client.query`) y los dos pasan por aquí.
  if (typeof value === "string" && !/^-?\d+$/.test(value.trim())) {
    throw new RangeError(`${label}: «${value}» no es un entero en céntimos`)
  }
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(
      `${label}: ${String(value)} céntimos supera el entero seguro de JavaScript (${MAX_SAFE_CENTS}); ` +
        "convertirlo perdería precisión. ADR-0015 D1."
    )
  }
  return n
}

/** Igual que `centsFromDb`, conservando el `null` de una columna opcional. */
export function centsFromDbNullable(value: bigint | number | string | null | undefined, label = "importe"): Cents | null {
  return value === null || value === undefined ? null : centsFromDb(value, label)
}

/**
 * `Cents` del motor → `bigint` de la base. Rechaza lo que no es un entero
 * seguro ANTES de escribirlo: un `NaN` o un decimal colado llegaría a la base
 * como un importe cualquiera.
 */
export function centsToDb(value: Cents, label = "importe"): bigint {
  assertCents(value, label)
  return BigInt(value)
}

/** Igual que `centsToDb`, conservando el `null` de una columna opcional. */
export function centsToDbNullable(value: Cents | null | undefined, label = "importe"): bigint | null {
  return value === null || value === undefined ? null : centsToDb(value, label)
}
