/**
 * E11 · T20 — Invariantes de la **plataforma**, `I-E11-1…13`
 * (`docs/design/E11-plataforma-saas.md` §11; ADR-0019 D1–D9).
 *
 * Mismo contrato que los bloques de E7, E8, E9 y E10:
 *
 * > **nunca un PASS que no se haya comprobado**; lo no evaluable sale `INFO`
 * > diciendo **qué falta**; **tolerancia 0** en todo lo que compara cifras.
 *
 * Módulo **PURO**: sin `Date.now()`, sin Prisma, sin IO, sin LLM y sin importar
 * `lib/platform/**`. Todo entra por parámetro en **tipos planos**; quien lee la
 * base es `models/platform-invariants.ts`.
 *
 * ## Cuatro decisiones de este fichero, a propósito
 *
 * 1. **No se recomputa una cifra con la misma función que la produjo.** Lección
 *    de I-E9-16 y del hallazgo 2 del auditor de E5. Lo que llega aquí son las
 *    cifras **persistidas** (el `UsageRun` cacheado, el manifest, las seis
 *    comprobaciones del `RestoreJob`) y, al lado, la **Σ real recontada por otro
 *    camino** (SQL agregado) con la que enfrentarlas.
 * 2. **Siempre salen los trece resultados**, aunque falte el bloque. Un
 *    invariante que desaparece de la lista porque nadie aportó su bloque es
 *    exactamente el silencio que `/audit` existe para evitar (riesgo R3 de E7),
 *    y es el H-1 que E9 y E10 ya pagaron dos veces.
 * 3. **I-E11-7 es FUERTE en las dos direcciones** (auditor de E11, H-2). No
 *    basta con `TENANT_MODELS ⊆ inventario`: eso pasaba mientras `currencies`
 *    —177 filas por organización, con `organization_id` y RLS propia— se perdía
 *    en cada restauración con `verified = true`. Ahora falla **también** si
 *    existe en el esquema una tabla con `organization_id` que no esté ni en el
 *    inventario ni en la lista de exclusiones **declaradas y justificadas**.
 * 4. **Los motivos de sello de plataforma** son un código cerrado, como los
 *    cinco de E10 y los seis de E8: se filtran, se cuentan y se comparan.
 */

import type { CheckResult, CheckStatus } from "@/lib/ledger/invariants-types"

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades de resultado (mismas que E10, a propósito: una sola forma)
// ─────────────────────────────────────────────────────────────────────────────

const result = (id: string, status: CheckStatus, evidencia: string, query?: string): CheckResult =>
  query === undefined ? { id, status, evidencia } : { id, status, evidencia, query }

const pass = (id: string, evidencia: string, query?: string) => result(id, "PASS", evidencia, query)
const failed = (id: string, evidencia: string, query?: string) => result(id, "FAIL", evidencia, query)
const warn = (id: string, evidencia: string, query?: string) => result(id, "WARN", evidencia, query)
const info = (id: string, evidencia: string, query?: string) => result(id, "INFO", evidencia, query)

/** Lo NO evaluable nunca es un PASS: dice qué falta y quién lo aporta. */
const missing = (id: string, quéFalta: string): CheckResult => info(id, `no evaluable: ${quéFalta}`)

const cut = (items: readonly string[], max = 20): string =>
  items.length === 0 ? "—" : items.length <= max ? items.join(" · ") : `${items.slice(0, max).join(" · ")} · (+${items.length - max} más)`

const sortedSet = (items: Iterable<string>): string[] => [...new Set(items)].sort()

/**
 * Igualdad de conjuntos por comparación de su forma canónica.
 *
 * **Revisor R2-2.** El separador era un byte NUL **literal** en el fuente, y con
 * él git declaraba binario el fichero: `git diff` devolvía «Bin 0 -> 51375
 * bytes» y los mil y pico renglones de los trece invariantes **no se podían
 * revisar en un diff**. Ahora es una barra visible: ningún identificador de
 * acción, clave de cuota o nombre de tabla la contiene, así que separa igual y
 * además se lee.
 */
const SEPARADOR = "|"

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && sortedSet(a).join(SEPARADOR) === sortedSet(b).join(SEPARADOR)

// ─────────────────────────────────────────────────────────────────────────────
// Los motivos de sello de la plataforma (§3.5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **Código cerrado.** `CUOTA_DE_ASIENTOS_SUPERADA` es el de O-3: la cuota blanda
 * **nunca** rechaza un asiento, pero sí sella el periodo con motivo y pinta WARN
 * en la familia `PLATAFORMA` de `/audit`. `RESTAURACION_SIN_VERIFICAR` es O-2:
 * un `DONE_UNVERIFIED` no puede pasar inadvertido.
 */
export const E11_SEAL_REASONS = [
  "CUOTA_DE_ASIENTOS_SUPERADA",
  "CUOTA_DE_ALMACEN_SUPERADA_EN_MORA",
  "RESTAURACION_SIN_VERIFICAR",
  "COPIA_SIN_VERIFICAR",
] as const

export type E11SealReason = (typeof E11_SEAL_REASONS)[number]

export const E11_SEAL_REASON_TEXT: Readonly<Record<E11SealReason, string>> = {
  CUOTA_DE_ASIENTOS_SUPERADA:
    "el número de asientos del mes supera la cuota blanda del plan: el registro sigue abierto (D7) y lo accesorio queda bloqueado",
  CUOTA_DE_ALMACEN_SUPERADA_EN_MORA:
    "se ha subido un justificante por encima de la cuota de almacén estando fuera de FULL: excepción automática registrada (O-16)",
  RESTAURACION_SIN_VERIFICAR:
    "hay una restauración terminada en DONE_UNVERIFIED: la organización se conserva como evidencia y no acredita reproducibilidad (O-2)",
  COPIA_SIN_VERIFICAR: "hay una copia de seguridad cuyo manifest no se ha podido verificar contra su firma",
}

export const isE11SealReason = (code: string): code is E11SealReason =>
  (E11_SEAL_REASONS as readonly string[]).includes(code)

// ─────────────────────────────────────────────────────────────────────────────
// Tipos planos del bloque
// ─────────────────────────────────────────────────────────────────────────────

export type UsageFiguresRef = {
  members: number
  entries: number
  ocrDocs: number
  exports: number
  backups: number
  /** En bytes. `bigint` porque un plan puede tener 500 GB y no cabe en `Int`. */
  storageBytes: bigint
}

/** I-E11-1 — la caché servida frente a la Σ real recontada ahora. */
export type UsageBlock = {
  periodMonth: string
  /** El `UsageRun` que el producto serviría hoy, o `null` si no hay ninguno. */
  served: { sourceHash: string; gitSha: string; figures: UsageFiguresRef } | null
  /** Recontado AHORA desde las fuentes, con las exclusiones de §3.4. */
  actual: { sourceHash: string; figures: UsageFiguresRef }
}

/** I-E11-2 — un `RestoreJob` terminado y sus seis comprobaciones. */
export type RestoreJobRef = {
  id: string
  status: string
  verified: boolean
  /** Ids y estado de las comprobaciones de §5.4, tal como quedaron escritas. */
  checks: readonly { id: string; status: string }[]
}

/** I-E11-3 — el manifest de una copia, recomputado y verificado. */
export type BackupManifestRef = {
  id: string
  status: string
  /** El sha declarado en `BackupJob.manifestSha256`. */
  declaredSha256: string | null
  /** El sha recomputado sobre la forma canónica del manifest del ZIP. */
  recomputedSha256: string | null
  /** `true` si el HMAC valida con su `keyId`; `null` si no se ha podido comprobar. */
  signatureValid: boolean | null
  signingKeyId: string | null
  /** Entradas del manifest cuyo sha256 se ha recomputado. Muestra o total. */
  entries: readonly { path: string; declared: string; actual: string | null }[]
  /** `true` en el barrido nocturno (todas), `false` en el de petición (muestra). */
  full: boolean
}

/** I-E11-4 — cuotas: las duras, la blanda y el test estático sobre el AST. */
export type QuotaBlock = {
  /** (a) — una fila por clave de recurso, con su límite resuelto (`-1` = sin techo). */
  hardLimits: readonly { key: string; used: bigint; limit: bigint }[]
  /** (b) — superaciones de la cuota blanda vivas en el periodo. */
  softExcesses: readonly { key: string; used: bigint; soft: bigint }[]
  /** (b) — excepciones automáticas registradas en `platform_audit_logs`. */
  automaticExceptions: readonly { key: string; actor: string }[]
  /** (c) — quién llama a `assertWithinLimit`, leído del AST de `app/`. */
  ast?: {
    callers: readonly string[]
    expected: readonly string[]
    /** Acciones de posteo que NO pueden invocarlo (O-3). */
    postingActions: readonly string[]
  }
}

/** I-E11-5 — estado ⇔ acceso, y la puerta de la suscripción. */
export type AccessBlock = {
  /**
   * El universo evaluado. **Acotado**, no «toda la base»: el barrido de una
   * organización mira la suya; el barrido de plataforma, las que le pasen.
   */
  organizations: readonly {
    organizationId: string
    subscriptions: number
    /** Nivel efectivo que el producto está aplicando. */
    effectiveAccess: string | null
    /** El que `accessLevelOf` calcula desde el estado de la suscripción. */
    expectedAccess: string | null
  }[]
  /** Las clases de acción marcadas `allowInReadOnly`, leídas del código. */
  allowInReadOnly?: { declared: readonly string[]; expected: readonly string[] }
}

/** I-E11-6 — los bytes del almacén frente a la fila. */
export type StoreBlock = {
  objects: readonly {
    id: string
    kind: string
    sha256: string
    sizeBytes: bigint
    /** Lo que responde el almacén. `null` = no se ha podido preguntar. */
    storeSha256: string | null
    storeSizeBytes: bigint | null
    present: boolean | null
    /**
     * `true` si el `sha256` lo publica el propio almacén como metadato
     * (`x-amz-meta-sha256`) en vez de recomputarse descargando los bytes
     * (revisor PUEDE 11). Se **enseña**: una alteración que reescriba también el
     * metadato pasaría la comprobación superficial.
     */
     shaFromStoreMetadata?: boolean
  }[]
  /** `File` sin objeto en el almacén. */
  filesWithoutObject: readonly string[]
  /** Familias que sí consumen cuota, para dejar por escrito el filtro (O-12c). */
  billableKinds: readonly string[]
}

/** I-E11-7 — cobertura del backup. La comprobación FUERTE de H-2. */
export type CoverageBlock = {
  /** Modelos de `TENANT_MODELS` ∪ `TENANT_MODELS_WITH_GLOBAL`. */
  tenantModels: readonly string[]
  /** Tablas que `backupInventory()` devuelve. */
  inventory: readonly string[]
  /** **Toda** tabla del esquema con columna `organization_id`, según Prisma. */
  tablesWithOrganizationId: readonly string[]
  /**
   * Lo mismo, pero leído de **`information_schema`** (auditor, ronda 2).
   *
   * Las dos fuentes tienen que decir lo mismo. La de Prisma describe lo que el
   * CÓDIGO cree que hay; ésta, lo que la BASE tiene. Una tabla creada por una
   * migración y nunca añadida al esquema —o al revés— es exactamente el hueco
   * por el que se coló `currencies`, y con una sola fuente el invariante no lo
   * puede ver. Opcional: el barrido que no la aporte lo dice en la evidencia.
   */
  tablesWithOrganizationIdInDatabase?: readonly string[]
  /**
   * Exclusiones **declaradas y justificadas**: tablas con `organization_id` que
   * NO son datos del tenant. Una tabla nueva no entra aquí por descuido: hay que
   * escribirla, y este invariante enseña la lista.
   */
  declaredExclusions: readonly { table: string; reason: string }[]
  /** Columnas-sello del esquema y las que `derivedSealColumns()` cubre. */
  sealColumnsInSchema: readonly string[]
  derivedSealColumns: readonly string[]
  /** Tablas que aparecen en el manifest de la última copia, con su recuento. */
  manifestTables?: readonly { name: string; rows: number }[]
}

/** I-E11-8 — la plataforma no toca el diario del cliente. */
export type IsolationBlock = {
  /** Asientos que referencian una fila de plataforma por cualquier camino. */
  entriesReferencingPlatform: readonly string[]
  /** `Transaction` / `ExtractionRun` / `File` con origen en una `PlatformInvoice`. */
  documentsFromPlatformInvoice: readonly string[]
  /** Plantillas de asiento que nombran una tabla de plataforma. */
  templatesNamingPlatform: readonly string[]
  /** Organizaciones marcadas como «organización plataforma» con privilegios. */
  privilegedPlatformOrganizations: readonly string[]
}

/** I-E11-9 — webhook idempotente. */
export type WebhookBlock = {
  events: readonly {
    id: string
    stripeEventId: string
    occurredAt: string
    statusBefore: string | null
    statusAfter: string
  }[]
  /** `true` cuando el proveedor de facturación es interno: no hay webhook. */
  internalBilling: boolean
}

/** I-E11-10 — la siembra, nueve piezas (O-7c). */
export type SeedingBlock = {
  organizations: readonly {
    organizationId: string
    baseCurrency: string
    /** Las nueve piezas, cada una con lo que se encontró. */
    postablePlanAccounts: number
    accountMapKeys: number
    requiredAccountMapKeys: number
    fiscalYears: number
    overlappingFiscalYears: number
    seriesCodes: readonly string[]
    reclassificationPairs: number
    marginLevelConfigs: number
    onboardingRuns: number
    taxRateKinds: readonly string[]
    currencyCodes: readonly string[]
    exchangeRatesAvailable: number
  }[]
}

/** I-E11-11 — retención honrada. */
export type RetentionBlock = {
  backups: readonly {
    id: string
    status: string
    expiresAt: string | null
    objectAlive: boolean
    hasLiveRestore: boolean
  }[]
  /** Objetos `PLATFORM_INVOICE` con caducidad: no puede haber ninguno (O-11). */
  expiredPlatformInvoiceObjects: readonly string[]
  refDate: string
}

/** I-E11-12 — el reloj. */
export type CronBlock = {
  runs: readonly {
    job: string
    periodKey: string
    status: string
    refDate: string
    startedAt: string
  }[]
  /** Cadencia declarada de cada job, en horas. */
  cadenceHours: Readonly<Record<string, number>>
  /** Ocurrencias generadas cuya fecha se puede contrastar con su devengo (O-13). */
  occurrences: readonly { id: string; period: string; postingDate: string }[]
  refDate: string
}

/** I-E11-13 — nuestra serie de facturación (O-10). Espejo de I-E8-20. */
export type PlatformInvoiceBlock = {
  series: readonly { id: string; code: string; kind: string; lastNumber: number }[]
  invoices: readonly {
    id: string
    seriesId: string
    number: number
    fullNumber: string
    operationDate: string
    rectifiesInvoiceId: string | null
  }[]
}

export type PlatformInvariantInput = {
  usage?: UsageBlock
  restores?: readonly RestoreJobRef[]
  backups?: readonly BackupManifestRef[]
  quotas?: QuotaBlock
  access?: AccessBlock
  store?: StoreBlock
  coverage?: CoverageBlock
  isolation?: IsolationBlock
  webhook?: WebhookBlock
  seeding?: SeedingBlock
  retention?: RetentionBlock
  cron?: CronBlock
  platformInvoices?: PlatformInvoiceBlock
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E11-1 — Uso derivado = Σ real
// ─────────────────────────────────────────────────────────────────────────────

const USAGE_KEYS = ["members", "entries", "ocrDocs", "exports", "backups", "storageBytes"] as const

/**
 * **La caché servida se enfrenta a la Σ real.** No es «una caché caducada»: una
 * cifra que ya no describe la realidad y que el producto sirve es FAIL.
 *
 * Cierra el H-7 del auditor: alterando las seis columnas de `usage_runs` **sin
 * tocar `source_hash`**, `getUsage` devolvía `members: 77, entries: 4242` con
 * `fromCache: true` cuando la Σ real era `1` y `5`, y nada lo comparaba jamás.
 */
export function checkIE111(input: PlatformInvariantInput): CheckResult {
  const block = input.usage
  if (!block) return missing("I-E11-1", "el bloque de uso (models/platform-invariants)")
  if (!block.served) {
    return info(
      "I-E11-1",
      `no evaluable: el periodo ${block.periodMonth} no tiene ningún UsageRun servible; ` +
        `la Σ real recontada ahora es ${describeFigures(block.actual.figures)}`
    )
  }
  const diffs: string[] = []
  for (const key of USAGE_KEYS) {
    const servido = block.served.figures[key]
    const real = block.actual.figures[key]
    if (String(servido) !== String(real)) diffs.push(`${key}: servido ${servido} ≠ Σ real ${real}`)
  }
  const hashMatches = block.served.sourceHash === block.actual.sourceHash
  if (diffs.length === 0 && hashMatches) {
    return pass(
      "I-E11-1",
      `las seis cifras del UsageRun de ${block.periodMonth} coinciden con la Σ real recontada ` +
        `(${describeFigures(block.actual.figures)}), y el sourceHash es el vigente`
    )
  }
  const motivos = [
    ...diffs,
    ...(hashMatches
      ? []
      : [`sourceHash servido ${block.served.sourceHash.slice(0, 12)}… ≠ vigente ${block.actual.sourceHash.slice(0, 12)}…`]),
  ]
  return failed(
    "I-E11-1",
    `el uso servido de ${block.periodMonth} no es la Σ real: ${cut(motivos)}. ` +
      "Una caché que no describe la realidad no es una caché caducada: es una cifra falsa (§3.4)"
  )
}

const describeFigures = (f: UsageFiguresRef): string =>
  `miembros ${f.members} · asientos ${f.entries} · OCR ${f.ocrDocs} · exportaciones ${f.exports} · ` +
  `copias ${f.backups} · almacén ${f.storageBytes} B`

// ─────────────────────────────────────────────────────────────────────────────
// I-E11-2 — Restauración reproducible (P7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Las de §5.4, por si el documento de verificación entrega menos.
 *
 * **Ronda 1 de E12 (auditor H-6): son SIETE.** `COBERTURA_INVENTARIO` va
 * delante de las seis porque comprueba lo que ninguna de ellas podía: que el
 * manifest declare las tablas que el inventario **derivado del esquema** exige.
 * Quitar una tabla del ZIP **y** del manifest a la vez pasaba las seis.
 */
export const REQUIRED_RESTORE_CHECKS: readonly string[] = [
  "COBERTURA_INVENTARIO",
  "RECUENTOS",
  "NUMERACION",
  "SELLOS_DERIVADOS",
  "AUDIT_LOG",
  "SELLOS_Y_CIERRE",
  "BARRIDO_INVARIANTES",
]

export function checkIE112(input: PlatformInvariantInput): CheckResult {
  const jobs = input.restores
  if (!jobs) return missing("I-E11-2", "el bloque de restauraciones")
  const terminados = jobs.filter((job) => job.status === "DONE" || job.status === "DONE_UNVERIFIED")
  if (terminados.length === 0) return info("I-E11-2", "no evaluable: no hay ninguna restauración terminada")

  const problemas: string[] = []
  for (const job of terminados) {
    const byId = new Map(job.checks.map((check) => [check.id, check.status] as const))
    const ausentes = REQUIRED_RESTORE_CHECKS.filter((id) => !byId.has(id))
    const noVerdes = REQUIRED_RESTORE_CHECKS.filter((id) => byId.has(id) && byId.get(id) !== "PASS")
    if (ausentes.length > 0) problemas.push(`${job.id}: faltan ${ausentes.join(", ")}`)
    if (noVerdes.length > 0) {
      problemas.push(`${job.id}: ${noVerdes.map((id) => `${id}=${byId.get(id)}`).join(", ")}`)
    }
    if (job.status === "DONE_UNVERIFIED") problemas.push(`${job.id}: DONE_UNVERIFIED (O-2)`)
    if (job.status === "DONE" && !job.verified) problemas.push(`${job.id}: DONE sin verified`)
  }
  if (problemas.length === 0) {
    return pass(
      "I-E11-2",
      `${terminados.length} restauración(es) terminada(s) con las SIETE comprobaciones de §5.4 en verde`
    )
  }
  return failed("I-E11-2", `restauraciones que no acreditan reproducibilidad: ${cut(problemas)}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E11-3 — Manifest íntegro y firmado
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE113(input: PlatformInvariantInput): CheckResult {
  const backups = input.backups
  if (!backups) return missing("I-E11-3", "el bloque de copias de seguridad")
  const emitidos = backups.filter((backup) => backup.status === "DONE")
  if (emitidos.length === 0) return info("I-E11-3", "no evaluable: no hay ninguna copia emitida")

  const problemas: string[] = []
  const sinComprobar: string[] = []
  for (const backup of emitidos) {
    if (backup.recomputedSha256 === null || backup.signatureValid === null) {
      sinComprobar.push(backup.id)
      continue
    }
    if (backup.declaredSha256 !== backup.recomputedSha256) {
      problemas.push(`${backup.id}: sha declarado ${backup.declaredSha256 ?? "∅"} ≠ recomputado ${backup.recomputedSha256}`)
    }
    if (!backup.signatureValid) problemas.push(`${backup.id}: firma inválida (keyId ${backup.signingKeyId ?? "∅"})`)
    for (const entry of backup.entries) {
      if (entry.actual === null) {
        sinComprobar.push(`${backup.id}:${entry.path}`)
      } else if (entry.actual !== entry.declared) {
        problemas.push(`${backup.id}:${entry.path} sha ${entry.actual} ≠ ${entry.declared}`)
      }
    }
  }
  if (problemas.length > 0) {
    return failed("I-E11-3", `copias con manifest o firma discordante: ${cut(problemas)}`)
  }
  const alcance = emitidos.every((backup) => backup.full) ? "completo" : "muestra (barrido de petición)"
  if (sinComprobar.length > 0) {
    return info(
      "I-E11-3",
      `no evaluable del todo: ${cut(sinComprobar)} sin recomputar (el ZIP no estaba disponible). ` +
        `Lo comprobado (${emitidos.length} copia(s), alcance ${alcance}) cuadra`
    )
  }
  return pass(
    "I-E11-3",
    `${emitidos.length} copia(s) con el sha256 del manifest recomputado, la firma válida con su keyId y ` +
      `el sha256 de cada entrada verificado — alcance ${alcance}`
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E11-4 — Cuotas (a, b, c)
// ─────────────────────────────────────────────────────────────────────────────

const UNLIMITED = BigInt(-1)

export function checkIE114(input: PlatformInvariantInput): CheckResult {
  const block = input.quotas
  if (!block) return missing("I-E11-4", "el bloque de cuotas")

  // (a) ninguna cuota de recurso superada.
  const superadas = block.hardLimits
    .filter((row) => row.limit !== UNLIMITED && row.used > row.limit)
    .map((row) => `${row.key}: ${row.used} sobre ${row.limit}`)

  // (b) toda superación blanda con su excepción AUTOMÁTICA registrada.
  const conExcepcion = new Set(block.automaticExceptions.map((row) => row.key))
  const sinExcepcion = block.softExcesses.filter((row) => !conExcepcion.has(row.key)).map((row) => `${row.key}: ${row.used} sobre ${row.soft}`)
  const deOperador = block.automaticExceptions
    .filter((row) => row.actor !== "motor" && row.actor !== "cron" && row.actor !== "sistema")
    .map((row) => `${row.key} concedida por «${row.actor}»`)

  // (c) test estático sobre el AST.
  const astProblemas: string[] = []
  if (block.ast) {
    const sobran = block.ast.callers.filter((caller) => !block.ast!.expected.includes(caller))
    const faltan = block.ast.expected.filter((expected) => !block.ast!.callers.includes(expected))
    const posteo = block.ast.postingActions.filter((action) => block.ast!.callers.includes(action))
    if (sobran.length > 0) astProblemas.push(`invocan de más: ${sobran.join(", ")}`)
    if (faltan.length > 0) astProblemas.push(`no invocan: ${faltan.join(", ")}`)
    if (posteo.length > 0) astProblemas.push(`una acción de POSTEO invoca el guardián (O-3): ${posteo.join(", ")}`)
  }

  const fallos = [...superadas, ...sinExcepcion, ...deOperador, ...astProblemas]
  if (fallos.length > 0) return failed("I-E11-4", cut(fallos))

  // La cuota blanda superada y bien registrada no es un fallo: es un WARN, y es
  // el que §3.5 manda pintar en la familia PLATAFORMA de /audit.
  if (block.softExcesses.length > 0) {
    return warn(
      "I-E11-4",
      `cuota blanda superada con excepción automática registrada: ` +
        `${block.softExcesses.map((row) => `${row.key} ${row.used}/${row.soft}`).join(" · ")}. ` +
        "Ningún hecho contable se ha rechazado (D7); lo accesorio queda bloqueado"
    )
  }
  const astTexto = block.ast
    ? `; AST: las ${block.ast.expected.length} acciones esperadas invocan assertWithinLimit y ninguna de posteo lo hace`
    : "; AST no evaluado en este barrido (lo cubre el test estático de T20)"
  return pass(
    "I-E11-4",
    `${block.hardLimits.length} cuota(s) de recurso dentro del plan y ninguna superación blanda${astTexto}`
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E11-5 — Estado ⇔ acceso, y toda organización con suscripción vigente única
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE115(input: PlatformInvariantInput): CheckResult {
  const block = input.access
  if (!block) return missing("I-E11-5", "el bloque de acceso y suscripciones")
  if (block.organizations.length === 0) {
    return info("I-E11-5", "no evaluable: el barrido no ha recibido ninguna organización en su alcance")
  }
  const sinFila = block.organizations.filter((row) => row.subscriptions === 0).map((row) => row.organizationId)
  const conDos = block.organizations
    .filter((row) => row.subscriptions > 1)
    .map((row) => `${row.organizationId} (${row.subscriptions})`)
  const discordantes = block.organizations
    .filter((row) => row.expectedAccess !== null && row.effectiveAccess !== null && row.effectiveAccess !== row.expectedAccess)
    .map((row) => `${row.organizationId}: aplica ${row.effectiveAccess}, corresponde ${row.expectedAccess}`)

  const readOnly = block.allowInReadOnly
  const readOnlyProblemas =
    readOnly && !sameSet(readOnly.declared, readOnly.expected)
      ? [
          `allowInReadOnly declara [${sortedSet(readOnly.declared).join(", ")}] y §3.2 exige ` +
            `[${sortedSet(readOnly.expected).join(", ")}]`,
        ]
      : []

  const fallos = [
    ...sinFila.map((id) => `${id}: sin Subscription`),
    ...conDos.map((id) => `${id}: más de una Subscription`),
    ...discordantes,
    ...readOnlyProblemas,
  ]
  if (fallos.length > 0) return failed("I-E11-5", cut(fallos))
  return pass(
    "I-E11-5",
    `${block.organizations.length} organización(es) del alcance con exactamente una suscripción vigente y ` +
      "el nivel de acceso que su estado determina"
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E11-6 — Ficheros: sha256 = almacén
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE116(input: PlatformInvariantInput): CheckResult {
  const block = input.store
  if (!block) return missing("I-E11-6", "el bloque del almacén")
  if (block.objects.length === 0 && block.filesWithoutObject.length === 0) {
    return info("I-E11-6", "no evaluable: la organización no tiene ningún objeto en el almacén")
  }
  const problemas: string[] = []
  const sinComprobar: string[] = []
  let superficiales = 0
  for (const object of block.objects) {
    if (object.present === null) {
      sinComprobar.push(object.id)
      continue
    }
    if (!object.present) {
      problemas.push(`${object.id} (${object.kind}): el objeto no está en el almacén`)
      continue
    }
    if (object.storeSizeBytes !== null && object.storeSizeBytes !== object.sizeBytes) {
      problemas.push(`${object.id}: ${object.storeSizeBytes} B en el almacén y ${object.sizeBytes} B registrados`)
    }
    if (object.storeSha256 !== null && object.storeSha256 !== object.sha256) {
      problemas.push(`${object.id}: sha256 ${object.storeSha256} en el almacén y ${object.sha256} registrado`)
    }
    if (object.storeSha256 === null) sinComprobar.push(`${object.id} (el backend no publica sha256)`)
    if (object.shaFromStoreMetadata === true) superficiales += 1
  }
  for (const file of block.filesWithoutObject) problemas.push(`File ${file} sin objeto en el almacén`)
  if (problemas.length > 0) return failed("I-E11-6", cut(problemas))

  /**
   * **Revisor PUEDE 11, escrito en el enunciado.** `head()` de S3 devuelve el
   * `sha256` que publica el **propio almacén** (`x-amz-meta-sha256`): una
   * alteración que reescriba también el metadato pasaría sin descargar un byte.
   * Se dice aquí, en la evidencia, en vez de dejar un PASS que promete más de lo
   * que ha comprobado.
   */
  const nota =
    superficiales > 0
      ? ` · ${superficiales} objeto(s) comprobados con el sha256 que publica el almacén (metadato), no recomputado: ` +
        "el barrido profundo descarga y recomputa una muestra"
      : ""
  if (sinComprobar.length > 0) {
    return info(
      "I-E11-6",
      `no evaluable del todo: ${cut(sinComprobar)}. El resto (${block.objects.length - sinComprobar.length} objeto(s), ` +
        `kinds con cuota: ${block.billableKinds.join("/")}) cuadra${nota}`
    )
  }
  return pass(
    "I-E11-6",
    `${block.objects.length} objeto(s): sha256 y tamaño coinciden con el almacén, y todo File tiene sus bytes${nota}`
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E11-7 — Cobertura del backup. **FUERTE en las dos direcciones** (H-2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * La comprobación que habría cazado `currencies`.
 *
 * La ronda anterior sólo exigía `TENANT_MODELS ⊆ inventario`, que es una
 * tautología cuando el inventario **se deriva** de `TENANT_MODELS`: pasaba
 * siempre, mientras la tabla con `organization_id` que no estaba en el conjunto
 * se perdía en cada restauración con `verified = true`. Ahora se exige además
 * `{tablas con organization_id} ⊆ inventario ∪ exclusiones declaradas`.
 */
export function checkIE117(input: PlatformInvariantInput): CheckResult {
  const block = input.coverage
  if (!block) return missing("I-E11-7", "el bloque de cobertura del backup")

  const inventory = new Set(block.inventory)
  const excluded = new Map(block.declaredExclusions.map((row) => [row.table, row.reason] as const))

  // (1) Dirección débil: nada de TENANT_MODELS fuera del inventario.
  const modelosFuera = block.tenantModels.filter((table) => !inventory.has(table))

  // (2) **Dirección fuerte**: ninguna tabla con organization_id fuera del
  //     inventario que no esté declarada y justificada.
  const huerfanas = block.tablesWithOrganizationId.filter((table) => !inventory.has(table) && !excluded.has(table))

  // (3) Exclusiones que ya no existen: una lista que se pudre miente. Y una
  //     exclusión sin MOTIVO escrito es una exclusión sin justificar (R2-7):
  //     el tipo exige el campo, pero la cadena vacía lo dejaba pasar imprimiendo
  //     «tabla ()».
  const exclusionesMuertas = [...excluded.keys()].filter(
    (table) => !block.tablesWithOrganizationId.includes(table)
  )
  const exclusionesSinMotivo = block.declaredExclusions
    .filter((row) => row.reason.trim().length === 0)
    .map((row) => row.table)

  // (3-bis) **Las dos fuentes del esquema** (auditor, ronda 2): lo que Prisma
  //         describe y lo que `information_schema` tiene. Una tabla con
  //         `organization_id` que exista en la BASE y no en el cliente generado
  //         —o al revés— es un esquema que ha divergido del código, y la copia
  //         del cliente se calcula con el código.
  const enBase = block.tablesWithOrganizationIdInDatabase
  const soloEnBase = enBase ? enBase.filter((table) => !block.tablesWithOrganizationId.includes(table)) : []
  const soloEnCodigo = enBase ? block.tablesWithOrganizationId.filter((table) => !enBase.includes(table)) : []
  const huerfanasEnBase = enBase
    ? enBase.filter((table) => !inventory.has(table) && !excluded.has(table))
    : []

  // (4) Columnas-sello del esquema que `derivedSealColumns()` no cubre.
  const cubiertas = new Set(block.derivedSealColumns)
  const sellosFuera = block.sealColumnsInSchema.filter((column) => !cubiertas.has(column))

  // (5) Toda tabla del inventario, en el manifest con su recuento.
  const manifestProblemas: string[] = []
  if (block.manifestTables) {
    const enManifest = new Map(block.manifestTables.map((row) => [row.name, row.rows] as const))
    for (const table of block.inventory) {
      if (!enManifest.has(table)) manifestProblemas.push(`${table} no aparece en el manifest`)
    }
    for (const row of block.manifestTables) {
      if (!inventory.has(row.name)) manifestProblemas.push(`${row.name} en el manifest y fuera del inventario`)
    }
  }

  const fallos = [
    ...modelosFuera.map((table) => `${table}: en TENANT_MODELS y fuera del inventario`),
    ...huerfanas.map(
      (table) =>
        `${table}: lleva organization_id y NO está en el inventario ni declarada como exclusión ` +
        "— se perdería en cada restauración (H-2 del auditor: currencies, 177 filas por organización)"
    ),
    ...exclusionesMuertas.map((table) => `${table}: exclusión declarada sobre una tabla que ya no lleva organization_id`),
    ...exclusionesSinMotivo.map((table) => `${table}: exclusión declarada SIN motivo escrito`),
    ...soloEnBase.map(
      (table) => `${table}: lleva organization_id en information_schema y el cliente generado no la conoce`
    ),
    ...soloEnCodigo.map(
      (table) => `${table}: el cliente generado le pone organization_id y information_schema no la tiene`
    ),
    ...huerfanasEnBase.map(
      (table) =>
        `${table}: information_schema la ve con organization_id y NO está en el inventario ni declarada como exclusión`
    ),
    ...sellosFuera.map((column) => `${column}: columna-sello del esquema fuera de derivedSealColumns()`),
    ...manifestProblemas,
  ]
  if (fallos.length > 0) return failed("I-E11-7", cut(fallos, 30))

  const exclusiones =
    block.declaredExclusions.length === 0
      ? "sin exclusiones"
      : `exclusiones declaradas: ${block.declaredExclusions.map((row) => `${row.table} (${row.reason})`).join(" · ")}`
  const fuentes = enBase
    ? `las DOS fuentes coinciden (cliente generado e information_schema, ${enBase.length} tablas)`
    : "sólo se ha contrastado contra el cliente generado: information_schema no se ha aportado en este barrido"
  return pass(
    "I-E11-7",
    `${fuentes}; ${block.inventory.length} tabla(s) en el inventario cubren las ${block.tablesWithOrganizationId.length} del esquema ` +
      `con organization_id (${exclusiones}); ${block.derivedSealColumns.length} columna(s)-sello cubiertas` +
      (block.manifestTables ? `; el manifest trae las ${block.manifestTables.length} con su recuento` : "")
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E11-8 — La plataforma no toca el diario del cliente (O-8)
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE118(input: PlatformInvariantInput): CheckResult {
  const block = input.isolation
  if (!block) return missing("I-E11-8", "el bloque de aislamiento de la plataforma")
  const fallos = [
    ...block.entriesReferencingPlatform.map((id) => `asiento ${id} referencia una fila de plataforma`),
    ...block.documentsFromPlatformInvoice.map((id) => `${id} tiene por origen una PlatformInvoice`),
    ...block.templatesNamingPlatform.map((code) => `la plantilla ${code} nombra una tabla de plataforma`),
    ...block.privilegedPlatformOrganizations.map((id) => `${id} es una «organización plataforma» con privilegios`),
  ]
  if (fallos.length > 0) return failed("I-E11-8", cut(fallos))
  return pass(
    "I-E11-8",
    "ningún asiento referencia PlatformInvoice, Subscription ni BackupJob; ninguna Transaction, ExtractionRun " +
      "ni File tiene por origen una factura de plataforma; ninguna plantilla las nombra; y no existe una " +
      "organización de plataforma con privilegios (O-8)"
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E11-9 — Webhook idempotente
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE119(input: PlatformInvariantInput): CheckResult {
  const block = input.webhook
  if (!block) return missing("I-E11-9", "el bloque de eventos de suscripción")
  if (block.internalBilling && block.events.length === 0) {
    return info(
      "I-E11-9",
      "no evaluable: facturación en modo INTERNO (D9), no hay webhook de Stripe ni eventos que encadenar"
    )
  }
  if (block.events.length === 0) return info("I-E11-9", "no evaluable: no hay ningún SubscriptionEvent")

  const porEvento = new Map<string, number>()
  for (const event of block.events) porEvento.set(event.stripeEventId, (porEvento.get(event.stripeEventId) ?? 0) + 1)
  const duplicados = [...porEvento.entries()].filter(([, n]) => n > 1).map(([id, n]) => `${id} ×${n}`)

  const orden = [...block.events].sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0))
  const huecos: string[] = []
  for (let i = 1; i < orden.length; i += 1) {
    const anterior = orden[i - 1]
    const actual = orden[i]
    if (actual.statusBefore !== null && actual.statusBefore !== anterior.statusAfter) {
      huecos.push(`${actual.stripeEventId}: viene de ${actual.statusBefore} y el anterior dejó ${anterior.statusAfter}`)
    }
  }
  const fallos = [...duplicados.map((d) => `stripeEventId duplicado: ${d}`), ...huecos]
  if (fallos.length > 0) return failed("I-E11-9", cut(fallos))
  return pass(
    "I-E11-9",
    `${block.events.length} evento(s) con stripeEventId único y la cadena statusBefore→statusAfter sin hueco`
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E11-10 — Siembra completa, NUEVE piezas (O-7c)
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE1110(input: PlatformInvariantInput): CheckResult {
  const block = input.seeding
  if (!block) return missing("I-E11-10", "el bloque de siembra")
  if (block.organizations.length === 0) {
    return info("I-E11-10", "no evaluable: el barrido no ha recibido ninguna organización en su alcance")
  }
  const fallos: string[] = []
  for (const org of block.organizations) {
    const faltan: string[] = []
    if (org.postablePlanAccounts === 0) faltan.push("plan postable")
    if (org.accountMapKeys < org.requiredAccountMapKeys) {
      faltan.push(`mapa de cuentas (${org.accountMapKeys}/${org.requiredAccountMapKeys} claves)`)
    }
    if (org.fiscalYears !== 1) faltan.push(`exactamente un ejercicio (hay ${org.fiscalYears})`)
    if (org.overlappingFiscalYears > 0) faltan.push(`${org.overlappingFiscalYears} solape(s) de ejercicio`)
    for (const code of ["ORDINARIA", "RECTIFICATIVA"]) {
      if (!org.seriesCodes.includes(code)) faltan.push(`serie ${code}`)
    }
    if (org.reclassificationPairs < 22) faltan.push(`22 pares de reclasificación (hay ${org.reclassificationPairs})`)
    if (org.marginLevelConfigs === 0) faltan.push("MarginLevelConfig vigente")
    if (org.onboardingRuns === 0) faltan.push("OnboardingRun")
    for (const kind of ["IVA", "IRPF"]) {
      if (!org.taxRateKinds.includes(kind)) faltan.push(`TaxRate vigente de ${kind}`)
    }
    if (!org.currencyCodes.includes(org.baseCurrency)) faltan.push(`Currency de su baseCurrency (${org.baseCurrency})`)
    if (org.baseCurrency !== "EUR" && org.exchangeRatesAvailable === 0) {
      faltan.push(`ninguna ExchangeRate accesible con baseCurrency ${org.baseCurrency} (RC-14)`)
    }
    if (faltan.length > 0) fallos.push(`${org.organizationId}: ${faltan.join(", ")}`)
  }
  if (fallos.length > 0) return failed("I-E11-10", cut(fallos))
  return pass(
    "I-E11-10",
    `${block.organizations.length} organización(es) con las NUEVE piezas: plan postable · mapa completo · un ` +
      "ejercicio sin solape · series ORDINARIA y RECTIFICATIVA · 22 pares · MarginLevelConfig · OnboardingRun · " +
      "TaxRate de IVA e IRPF · Currency de su moneda base"
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E11-11 — Retención honrada
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE1111(input: PlatformInvariantInput): CheckResult {
  const block = input.retention
  if (!block) return missing("I-E11-11", "el bloque de retención")
  if (block.backups.length === 0 && block.expiredPlatformInvoiceObjects.length === 0) {
    return info("I-E11-11", "no evaluable: no hay ninguna copia de seguridad")
  }
  const fallos: string[] = []
  for (const backup of block.backups) {
    if (backup.status === "DONE" && backup.objectAlive && backup.expiresAt !== null && backup.expiresAt < block.refDate) {
      fallos.push(`${backup.id}: objeto vivo y caducado el ${backup.expiresAt}`)
    }
    if (backup.status === "EXPIRED" && backup.hasLiveRestore) {
      fallos.push(`${backup.id}: borrado con un RestoreJob vivo que lo referencia`)
    }
    if (backup.status === "EXPIRED" && backup.expiresAt !== null && backup.expiresAt > block.refDate) {
      fallos.push(`${backup.id}: borrado antes de tiempo (caduca el ${backup.expiresAt})`)
    }
  }
  for (const id of block.expiredPlatformInvoiceObjects) {
    fallos.push(`${id}: objeto PLATFORM_INVOICE caducado — están excluidos de la retención (O-11, art. 165.Uno LIVA)`)
  }
  if (fallos.length > 0) return failed("I-E11-11", cut(fallos))
  return pass(
    "I-E11-11",
    `${block.backups.length} copia(s): ninguna viva pasada su caducidad, ninguna borrada antes de tiempo ni con ` +
      "una restauración viva, y ninguna copia de nuestras facturas caducada"
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E11-12 — Cron idempotente y al día (O-13)
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE1112(input: PlatformInvariantInput): CheckResult {
  const block = input.cron
  if (!block) return missing("I-E11-12", "el bloque del reloj")
  if (block.runs.length === 0 && block.occurrences.length === 0) {
    return info("I-E11-12", "no evaluable: el reloj no ha ejecutado ningún job")
  }
  const fallos: string[] = []

  // (a) `(job, periodKey)` único.
  const claves = new Map<string, number>()
  for (const run of block.runs) {
    const clave = `${run.job}|${run.periodKey}`
    claves.set(clave, (claves.get(clave) ?? 0) + 1)
  }
  for (const [clave, n] of claves) if (n > 1) fallos.push(`(job, periodKey) duplicado: ${clave} ×${n}`)

  // (b) ningún job con la última ejecución más vieja que dos cadencias sin un
  //     PARTIAL/FAILED que lo explique.
  const refMs = Date.parse(block.refDate)
  for (const [job, cadencia] of Object.entries(block.cadenceHours)) {
    const delJob = block.runs.filter((run) => run.job === job)
    if (delJob.length === 0) continue
    const ultimo = delJob.reduce((a, b) => (a.startedAt >= b.startedAt ? a : b))
    const antigüedadH = (refMs - Date.parse(ultimo.startedAt)) / 3_600_000
    if (antigüedadH > cadencia * 2 && ultimo.status !== "PARTIAL" && ultimo.status !== "FAILED") {
      fallos.push(
        `${job}: última ejecución hace ${antigüedadH.toFixed(1)} h, más de dos cadencias de ${cadencia} h, ` +
          `y terminó en ${ultimo.status} — nada lo explica`
      )
    }
  }

  // (c) **O-13**: ninguna ocurrencia fechada por el instante de ejecución en vez
  //     de por su periodo de devengo. La `postingDate` tiene que caer DENTRO de
  //     su periodo, y nunca en el futuro respecto de la referencia.
  for (const occurrence of block.occurrences) {
    const periodo = occurrence.period.slice(0, 7)
    if (occurrence.postingDate.slice(0, 7) !== periodo) {
      fallos.push(
        `ocurrencia ${occurrence.id}: fechada el ${occurrence.postingDate} y su periodo de devengo es ${periodo} (O-13)`
      )
    }
    if (occurrence.postingDate > block.refDate) {
      fallos.push(`ocurrencia ${occurrence.id}: fechada en el FUTURO (${occurrence.postingDate} > ${block.refDate})`)
    }
  }

  if (fallos.length > 0) return failed("I-E11-12", cut(fallos))
  return pass(
    "I-E11-12",
    `${block.runs.length} ejecución(es) con (job, periodKey) único y al día, y ${block.occurrences.length} ` +
      "ocurrencia(s) fechadas por su periodo de devengo y nunca en el futuro"
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// I-E11-13 — Nuestra serie de facturación (O-10). Espejo exacto de I-E8-20
// ─────────────────────────────────────────────────────────────────────────────

export function checkIE1113(input: PlatformInvariantInput): CheckResult {
  const block = input.platformInvoices
  if (!block) return missing("I-E11-13", "el bloque de facturas de plataforma")
  if (block.invoices.length === 0) {
    return info(
      "I-E11-13",
      `no evaluable: ${block.series.length} serie(s) de plataforma sin ninguna factura emitida ` +
        "(mismo contrato que I-E8-20: una serie sin facturas está en INFO hasta la primera)"
    )
  }
  const porSerie = new Map(block.series.map((serie) => [serie.id, serie] as const))
  const fallos: string[] = []

  for (const serie of block.series) {
    const facturas = block.invoices
      .filter((invoice) => invoice.seriesId === serie.id)
      .sort((a, b) => a.number - b.number)
    if (facturas.length === 0) continue

    // Correlativa sin huecos y sin duplicados.
    const numeros = facturas.map((invoice) => invoice.number)
    const duplicados = numeros.filter((n, i) => i > 0 && n === numeros[i - 1])
    if (duplicados.length > 0) fallos.push(`serie ${serie.code}: números duplicados ${cut(duplicados.map(String))}`)
    const huecos: number[] = []
    for (let n = 1; n <= numeros[numeros.length - 1]; n += 1) if (!numeros.includes(n)) huecos.push(n)
    if (huecos.length > 0) fallos.push(`serie ${serie.code}: huecos en ${cut(huecos.map(String))}`)
    if (serie.lastNumber !== numeros[numeros.length - 1]) {
      fallos.push(`serie ${serie.code}: lastNumber ${serie.lastNumber} y la última factura es la ${numeros[numeros.length - 1]}`)
    }

    // `operationDate` NO decreciente respecto del número.
    for (let i = 1; i < facturas.length; i += 1) {
      if (facturas[i].operationDate < facturas[i - 1].operationDate) {
        fallos.push(
          `serie ${serie.code}: la ${facturas[i].fullNumber} opera el ${facturas[i].operationDate}, antes que la ` +
            `${facturas[i - 1].fullNumber} (${facturas[i - 1].operationDate})`
        )
      }
    }
  }

  // Toda rectificativa, en una serie RECTIFICATIVA y sobre una existente.
  const porId = new Map(block.invoices.map((invoice) => [invoice.id, invoice] as const))
  for (const invoice of block.invoices) {
    if (invoice.rectifiesInvoiceId === null) continue
    const serie = porSerie.get(invoice.seriesId)
    if (!serie || serie.kind !== "RECTIFICATIVA") {
      fallos.push(`${invoice.fullNumber}: rectifica y su serie ${serie?.code ?? "∅"} no es RECTIFICATIVA`)
    }
    if (!porId.has(invoice.rectifiesInvoiceId)) {
      fallos.push(`${invoice.fullNumber}: rectifica la factura ${invoice.rectifiesInvoiceId}, que no existe`)
    }
  }

  if (fallos.length > 0) return failed("I-E11-13", cut(fallos))
  return pass(
    "I-E11-13",
    `${block.invoices.length} factura(s) de plataforma en ${block.series.length} serie(s): numeración correlativa ` +
      "sin huecos ni duplicados, fecha de operación no decreciente y toda rectificativa en su serie sobre una existente"
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// El bloque completo: SIEMPRE los trece
// ─────────────────────────────────────────────────────────────────────────────

export const E11_INVARIANT_IDS: readonly string[] = [
  "I-E11-1",
  "I-E11-2",
  "I-E11-3",
  "I-E11-4",
  "I-E11-5",
  "I-E11-6",
  "I-E11-7",
  "I-E11-8",
  "I-E11-9",
  "I-E11-10",
  "I-E11-11",
  "I-E11-12",
  "I-E11-13",
]

/**
 * **Siempre trece resultados.** Un invariante que desaparece porque su bloque no
 * llegó es el silencio que la pestaña de auditoría existe para evitar: sale
 * `INFO` diciendo qué falta.
 */
export function runPlatformInvariants(input: PlatformInvariantInput): CheckResult[] {
  return [
    checkIE111(input),
    checkIE112(input),
    checkIE113(input),
    checkIE114(input),
    checkIE115(input),
    checkIE116(input),
    checkIE117(input),
    checkIE118(input),
    checkIE119(input),
    checkIE1110(input),
    checkIE1111(input),
    checkIE1112(input),
    checkIE1113(input),
  ]
}

/**
 * Los motivos de sello que aporta la plataforma, compuestos **a partir de los
 * datos** y no de los checks: lección H-4 de E7, `seal` y `sealReasons` dicen lo
 * mismo.
 */
export function platformSealReasons(input: PlatformInvariantInput): E11SealReason[] {
  const out = new Set<E11SealReason>()
  for (const excess of input.quotas?.softExcesses ?? []) {
    if (excess.key === "softMaxEntriesMonth") out.add("CUOTA_DE_ASIENTOS_SUPERADA")
    if (excess.key === "maxStorageBytes") out.add("CUOTA_DE_ALMACEN_SUPERADA_EN_MORA")
  }
  for (const exception of input.quotas?.automaticExceptions ?? []) {
    if (exception.key === "softMaxEntriesMonth") out.add("CUOTA_DE_ASIENTOS_SUPERADA")
    if (exception.key === "maxStorageBytes") out.add("CUOTA_DE_ALMACEN_SUPERADA_EN_MORA")
  }
  for (const job of input.restores ?? []) {
    if (job.status === "DONE_UNVERIFIED" || (job.status === "DONE" && !job.verified)) {
      out.add("RESTAURACION_SIN_VERIFICAR")
    }
  }
  for (const backup of input.backups ?? []) {
    if (backup.status === "DONE" && backup.signatureValid === false) out.add("COPIA_SIN_VERIFICAR")
  }
  return [...out].sort()
}
