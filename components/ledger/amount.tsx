import { formatCents } from "@/lib/money"
import { cn } from "@/lib/utils"

/**
 * E3 · T11/T12 — Celda de importe de las tablas financieras (`ui-erp` §Tablas).
 *
 * Alineada a la derecha, `tabular-nums`, formato `es-ES` (`1.234.567,89 €`),
 * cero como `—` y negativos con el signo tipográfico `−` en texto secundario
 * (nunca rojo semáforo). El formateo NO es un cálculo: la cifra llega ya hecha
 * del servidor y aquí sólo se pinta.
 */
export function Amount({
  cents,
  currency = "EUR",
  zeroAsDash = true,
  className,
  title,
}: {
  cents: number
  currency?: string
  zeroAsDash?: boolean
  className?: string
  title?: string
}) {
  const negative = cents < 0
  return (
    <span
      title={title}
      data-cents={cents}
      className={cn(
        "tabular-nums whitespace-nowrap",
        cents === 0 && zeroAsDash && "text-muted-foreground",
        negative && "text-muted-foreground",
        className
      )}
    >
      {formatCents(cents, { currency, zeroAsDash })}
    </span>
  )
}

/** Importe sin símbolo de moneda, para columnas donde la moneda va en la cabecera. */
export function AmountPlain({ cents, zeroAsDash = true, className }: { cents: number; zeroAsDash?: boolean; className?: string }) {
  if (cents === 0 && zeroAsDash) {
    return <span className={cn("tabular-nums text-muted-foreground", className)}>—</span>
  }
  // `useGrouping: "always"` a propósito: es-ES no agrupa por defecto los
  // números de cuatro cifras («1210,00») y una columna contable tiene que
  // separar el millar siempre, igual que hace `formatCents` (`ui-erp` §Tablas).
  const text = new Intl.NumberFormat("es-ES", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: "always",
  })
    .format(cents / 100)
    .replace("-", "−")
  return (
    <span data-cents={cents} className={cn("tabular-nums whitespace-nowrap", cents < 0 && "text-muted-foreground", className)}>
      {text}
    </span>
  )
}

/** Fecha contable `YYYY-MM-DD` → `10/03/2026`, sin pasar por `Date` ni por zonas. */
export function formatLocalDate(date: string | null | undefined): string {
  if (!date) return "—"
  const [y, m, d] = date.split("-")
  if (!y || !m || !d) return date
  return `${d}/${m}/${y}`
}
