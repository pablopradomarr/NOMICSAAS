import { USAGE_EXCLUSIONS_ES } from "@/lib/platform/usage"
import type { PlanLimits } from "@/lib/platform/types"
import type { UsageFigures } from "@/lib/platform/usage"

/**
 * E11 · ola C · **T22** — el uso del mes, con sus **seis barras** (§10).
 *
 * Ámbar al 80 %, rojo al 100 %. Y, junto a cada cifra, **la exclusión declarada**
 * (P6): una cifra derivada se enseña con lo que la produjo, o el cliente no
 * puede saber por qué su contador dice 118 y él cree haber hecho 126 asientos.
 *
 * Aquí no se calcula nada: el porcentaje es feedback visual sobre dos números
 * que ya vienen del servidor, y está marcado como tal.
 */

export type UsageBarsProps = {
  figures: UsageFigures
  limits: PlanLimits | null
  computedAt: Date
  gitSha: string
  fromCache: boolean
  periodMonth: string
}

type Row = {
  key: keyof UsageFigures
  label: string
  used: number
  limit: number | null
  format: (n: number) => string
}

const integer = (n: number) => new Intl.NumberFormat("es-ES").format(n)

/** Bytes legibles. No es una cifra contable: es el tamaño de un almacén. */
function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = n / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(value >= 100 ? 0 : 1).replace(".", ",")} ${units[i]}`
}

/** `-1` en el plan significa «sin límite», no cero. */
const cap = (n: number | bigint | undefined): number | null => {
  if (n === undefined) return null
  const value = typeof n === "bigint" ? Number(n) : n
  return value < 0 ? null : value
}

export function UsageBars({ figures, limits, computedAt, gitSha, fromCache, periodMonth }: UsageBarsProps) {
  const rows: Row[] = [
    { key: "members", label: "Miembros", used: figures.members, limit: cap(limits?.maxMembers), format: integer },
    {
      key: "entries",
      label: "Asientos del mes",
      used: figures.entries,
      limit: cap(limits?.softMaxEntriesMonth),
      format: integer,
    },
    {
      key: "ocrDocs",
      label: "Documentos analizados",
      used: figures.ocrDocs,
      limit: cap(limits?.maxOcrDocsMonth),
      format: integer,
    },
    { key: "exports", label: "Exportaciones", used: figures.exports, limit: cap(limits?.maxExportsMonth), format: integer },
    { key: "backups", label: "Copias de seguridad", used: figures.backups, limit: cap(limits?.maxBackupsMonth), format: integer },
    {
      key: "storageBytes",
      label: "Almacenamiento",
      used: Number(figures.storageBytes),
      limit: cap(limits?.maxStorageBytes),
      format: bytes,
    },
  ]

  return (
    <section className="space-y-4" data-testid="usage-bars">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold">Uso de {periodMonth}</h3>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Las seis cifras se <strong>derivan</strong> de tus datos cada vez que cambian; no se almacena ningún contador
          que pueda quedarse viejo. Debajo de cada una está escrito exactamente qué entra y qué no.
        </p>
      </div>

      <ul className="space-y-3">
        {rows.map((row) => (
          <UsageRow key={row.key} row={row} />
        ))}
      </ul>

      <p className="font-mono text-[11px] text-muted-foreground" data-testid="usage-seal">
        calculado {computedAt.toISOString()} · {gitSha.slice(0, 12)} · {fromCache ? "de caché válida" : "recalculado"}
      </p>
    </section>
  )
}

function UsageRow({ row }: { row: Row }) {
  // Feedback VISUAL, marcado como tal: la cifra contable es `used`, que viene
  // del servidor. El porcentaje sólo dibuja la barra.
  const share = row.limit === null || row.limit === 0 ? 0 : Math.min(100, Math.round((row.used / row.limit) * 100))
  const tone =
    row.limit !== null && row.used >= row.limit
      ? "bg-[#B3261E]"
      : share >= 80
        ? "bg-[#F5A623]"
        : "bg-foreground"

  return (
    <li className="space-y-1" data-testid={`usage-${row.key}`} data-used={row.used} data-limit={row.limit ?? "none"}>
      <div className="flex items-baseline justify-between gap-4 text-sm">
        <span className="font-medium">{row.label}</span>
        <span className="tabular-nums">
          {row.format(row.used)}
          {row.limit !== null && <span className="text-muted-foreground"> de {row.format(row.limit)}</span>}
          {row.limit === null && <span className="text-muted-foreground"> · sin límite</span>}
        </span>
      </div>
      <div className="h-1.5 w-full rounded-sm bg-muted" aria-hidden>
        <div className={`h-1.5 rounded-sm ${tone}`} style={{ width: `${share}%` }} />
      </div>
      <p className="text-xs text-muted-foreground">{USAGE_EXCLUSIONS_ES[row.key]}</p>
    </li>
  )
}
