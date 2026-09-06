/**
 * E8 · T10 — Tasas de cambio: **fuente única, en el servidor, persistidas**.
 *
 * Cierra G-04. Hasta ahora la conversión ocurría en el navegador contra tres
 * fuentes (scraping de xe.com incluido), sin guardar nada: la misma factura
 * convertida dos veces daba dos cifras, y ninguna quedaba explicada. Ahora:
 *
 *  1. **Fuente única: Frankfurter**, que sirve la referencia diaria del BCE.
 *     Otra fuente exige ADR (ADR-0014 D2).
 *  2. **Tasa de la fecha del documento**, no la de hoy: confirmar una factura
 *     hoy o dentro de un mes produce el mismo asiento (NRV 11ª, tipo de contado
 *     de la fecha de la transacción).
 *  3. **Si el BCE no publicó ese día** (fin de semana, festivo), se usa la
 *     última publicada anterior y se persiste con su fecha **REAL**, que la UI
 *     muestra. La tasa no se «mueve» al día pedido: eso sería falsear la fuente.
 *  4. **Si la fuente no responde, se LANZA.** No hay fallback a otra fuente ni
 *     a una tasa aproximada. Una cifra contable inventada es peor que un error
 *     en pantalla: la primera se contabiliza y nadie la vuelve a mirar.
 *
 * **Sin caché en memoria de proceso.** La caché es la tabla `exchange_rates`,
 * que es global (ADR-0014 D7), append-only y auditable. Lo único que se admite
 * es un memo **por petición**, que el llamante crea y tira: convertir 50
 * facturas del mismo día es una llamada, no cincuenta (§9), y no sobrevive a la
 * petición, así que no puede servir una tasa que otro proceso ya corrigió.
 */

import type { TenantClient } from "@/lib/db"
import { ONE_MICRO, type RateRef } from "@/lib/fx/convert"
import { roundHalfEven } from "@/lib/money"

export const RATE_SOURCE_ECB = "ECB_FRANKFURTER"
export const RATE_SOURCE_IDENTITY = "IDENTITY"

/** Días hacia atrás que se piden a la fuente para encontrar la última publicada. */
const LOOKBACK_DAYS = 10
const WIDE_LOOKBACK_DAYS = 40

const FRANKFURTER_BASE_URL = (process.env.FRANKFURTER_BASE_URL ?? "https://api.frankfurter.app").replace(/\/+$/, "")

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/

export class ExchangeRateUnavailableError extends Error {
  readonly date: string
  readonly from: string
  readonly to: string

  constructor(date: string, from: string, to: string, cause: string) {
    super(
      `No hay tasa ${from}→${to} para el ${date}: ${cause}. ` +
        "La conversión NO se aproxima ni se inventa: vuelva a intentarlo o precargue el periodo."
    )
    this.name = "ExchangeRateUnavailableError"
    this.date = date
    this.from = from
    this.to = to
  }
}

/** Memo por PETICIÓN. Lo crea quien atiende la petición y muere con ella. */
export type RateMemo = Map<string, RateRef>

export const newRateMemo = (): RateMemo => new Map<string, RateRef>()

const memoKey = (date: string, from: string, to: string): string => `${date}|${from}|${to}`

const toDateOnly = (localDate: string): Date => new Date(`${localDate}T00:00:00.000Z`)

const toLocalDate = (value: Date): string => value.toISOString().slice(0, 10)

function shiftDays(localDate: string, days: number): string {
  const date = toDateOnly(localDate)
  date.setUTCDate(date.getUTCDate() + days)
  return toLocalDate(date)
}

function assertLocalDate(value: string): void {
  if (!LOCAL_DATE.test(value)) throw new TypeError(`Fecha esperada como "YYYY-MM-DD", recibido "${value}"`)
}

const normalizeCode = (code: string): string => code.trim().toUpperCase()

/**
 * Tasa a aplicar a un documento.
 *
 * @param db cliente de tenant. `exchange_rates` es global (no lleva
 *           `organization_id`), pero se accede por el mismo cliente para que la
 *           operación herede la transacción y los GUC de la petición.
 * @param date fecha del DOCUMENTO (`documentDate`), no la de hoy.
 * @param memo memo opcional por petición.
 * @throws ExchangeRateUnavailableError si la fuente no responde o no publica.
 */
export async function getOrFetchRate(
  db: TenantClient,
  date: string,
  from: string,
  to: string,
  memo?: RateMemo
): Promise<RateRef> {
  assertLocalDate(date)
  const fromCode = normalizeCode(from)
  const toCode = normalizeCode(to)

  if (fromCode === toCode) {
    return { id: null, from: fromCode, to: toCode, rateMicro: ONE_MICRO, rateDate: date, source: RATE_SOURCE_IDENTITY }
  }

  const key = memoKey(date, fromCode, toCode)
  const memoized = memo?.get(key)
  if (memoized) return memoized

  // 1 — ¿ya está en la tabla, con esa fecha exacta?
  const stored = await db.exchangeRate.findFirst({
    where: { date: toDateOnly(date), from: fromCode, to: toCode, source: RATE_SOURCE_ECB },
  })
  if (stored) {
    const hit = rowToRef(stored)
    memo?.set(key, hit)
    return hit
  }

  // 2 — la serie hasta esa fecha; la última publicada ≤ date.
  const published = await fetchLastPublished(date, fromCode, toCode)

  // 3 — persistir con su fecha REAL (puede ser anterior a la pedida).
  const saved = await persistRate(db, published)
  const hit = rowToRef(saved)
  memo?.set(key, hit)
  if (published.date !== date) memo?.set(memoKey(published.date, fromCode, toCode), hit)
  return hit
}

export async function listRatesForPeriod(
  db: TenantClient,
  fromDate: string,
  toDate: string,
  pair?: { from: string; to: string }
): Promise<RateRef[]> {
  assertLocalDate(fromDate)
  assertLocalDate(toDate)
  const rows = await db.exchangeRate.findMany({
    where: {
      date: { gte: toDateOnly(fromDate), lte: toDateOnly(toDate) },
      ...(pair ? { from: normalizeCode(pair.from), to: normalizeCode(pair.to) } : {}),
    },
    orderBy: [{ date: "desc" }, { from: "asc" }, { to: "asc" }],
  })
  return rows.map(rowToRef)
}

type ExchangeRateRow = {
  id: string
  date: Date
  from: string
  to: string
  rateMicro: bigint
  source: string
}

function rowToRef(row: ExchangeRateRow): RateRef {
  return {
    id: row.id,
    from: row.from,
    to: row.to,
    rateMicro: BigInt(row.rateMicro),
    rateDate: toLocalDate(row.date),
    source: row.source,
  }
}

type PublishedRate = { date: string; from: string; to: string; rateMicro: bigint }

/**
 * Inserta la tasa. `exchange_rates` es **append-only**: si otra petición ganó la
 * carrera, se lee la suya en lugar de escribir encima. Dos procesos que
 * consultan el mismo día al BCE obtienen el mismo número; quedarse con el
 * primero es correcto y evita un `UPDATE` que la política RESTRICTIVE prohíbe.
 */
async function persistRate(db: TenantClient, published: PublishedRate): Promise<ExchangeRateRow> {
  try {
    return await db.exchangeRate.create({
      data: {
        date: toDateOnly(published.date),
        from: published.from,
        to: published.to,
        rateMicro: published.rateMicro,
        source: RATE_SOURCE_ECB,
      },
    })
  } catch {
    const existing = await db.exchangeRate.findFirst({
      where: {
        date: toDateOnly(published.date),
        from: published.from,
        to: published.to,
        source: RATE_SOURCE_ECB,
      },
    })
    if (existing) return existing
    throw new ExchangeRateUnavailableError(
      published.date,
      published.from,
      published.to,
      "no se pudo persistir la tasa recibida"
    )
  }
}

type FrankfurterSeries = { rates?: Record<string, Record<string, number>> }

/**
 * Última tasa publicada con fecha ≤ `date`. Pide una **serie** en lugar de un
 * día suelto porque así la respuesta dice explícitamente qué día publicó el
 * BCE, y esa fecha es la que se persiste y la que ve el usuario.
 */
async function fetchLastPublished(date: string, from: string, to: string): Promise<PublishedRate> {
  for (const lookback of [LOOKBACK_DAYS, WIDE_LOOKBACK_DAYS]) {
    const start = shiftDays(date, -lookback)
    const url = `${FRANKFURTER_BASE_URL}/${start}..${date}?from=${from}&to=${to}`

    let payload: FrankfurterSeries
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" } })
      if (!response.ok) {
        throw new ExchangeRateUnavailableError(date, from, to, `la fuente respondió HTTP ${response.status}`)
      }
      payload = (await response.json()) as FrankfurterSeries
    } catch (error) {
      if (error instanceof ExchangeRateUnavailableError) throw error
      throw new ExchangeRateUnavailableError(
        date,
        from,
        to,
        `la fuente no respondió (${error instanceof Error ? error.message : String(error)})`
      )
    }

    const days = Object.keys(payload.rates ?? {})
      .filter((day) => LOCAL_DATE.test(day) && day <= date)
      .sort()
    const lastDay = days.at(-1)
    if (!lastDay) continue

    const value = payload.rates?.[lastDay]?.[to]
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue

    return { date: lastDay, from, to, rateMicro: BigInt(roundHalfEven(value * 1_000_000)) }
  }

  throw new ExchangeRateUnavailableError(date, from, to, "la fuente no publica ese par en las semanas anteriores")
}
