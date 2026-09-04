import { PrismaPg } from "@prisma/adapter-pg"
import { Prisma, PrismaClient } from "@/prisma/client"
import { AsyncLocalStorage } from "node:async_hooks"

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

/**
 * E1-fix (#17): `log: ["query"]` imprime cada sentencia SQL CON SUS PARÁMETROS.
 * En producción eso vuelca datos de clientes (importes, NIF, emails) al log del
 * contenedor. Sólo se activa en desarrollo; en producción, avisos y errores.
 */
function prismaLogLevels(): Prisma.LogLevel[] {
  if (process.env.NODE_ENV === "production") return ["warn", "error"]
  if (process.env.NODE_ENV === "test") return ["error"]
  return ["query", "info", "warn", "error"]
}

function createPrismaClient() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
  return new PrismaClient({ adapter, log: prismaLogLevels() })
}

/**
 * Cliente Prisma SIN acotar a organización.
 * @internal Sólo para `lib/`, `models/users.ts`, `models/organizations.ts` y
 * `models/memberships.ts` (resuelven QUÉ organización, no pueden estar acotados).
 * En `models/` de negocio y en `app/` usa siempre `tenantDb(orgId)`.
 */
export const prisma = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma

// ─────────────────────────────────────────────────────────────────────────────
// tenantDb — barrera 1 de aislamiento multi-tenant (docs/design/E1, §3)
// ─────────────────────────────────────────────────────────────────────────────

/** Modelos con organizationId NOT NULL: filtro obligatorio en lectura y escritura. */
export const TENANT_MODELS: ReadonlySet<string> = new Set([
  "Setting",
  "Category",
  "Project",
  "Field",
  "File",
  "Transaction",
  "AppData",
  "Progress",
  "Membership",
  "Invitation",
  // E2 — plan de cuentas e impuestos (docs/design/E2-plan-cuentas.md §2.2)
  "LedgerAccount",
  "OrganizationAccountMap",
  "TaxRate",
  "AuditLog",
])

/** Modelos con organizationId nullable: lectura híbrida (org ∪ global), escritura siempre con org. */
export const TENANT_MODELS_WITH_GLOBAL: ReadonlySet<string> = new Set(["Currency"])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class TenantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TenantError"
  }
}

function assertUuid(value: string, label = "organizationId"): string {
  if (!UUID_RE.test(value)) {
    throw new TenantError(`tenantDb: ${label} no es un uuid válido`)
  }
  return value
}

type WhereRecord = Record<string, unknown>

function isPlainObject(value: unknown): value is WhereRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Compone con AND en lugar de hacer spread superficial: `{ ...where, organizationId }`
 * sería sobrescribible por un `where` que ya trajera organizationId.
 */
export function and(where: unknown, scope: WhereRecord): WhereRecord {
  if (!isPlainObject(where) || Object.keys(where).length === 0) {
    return { ...scope }
  }
  return { AND: [where, scope] }
}

/**
 * Aplana un selector único compuesto (`{ organizationId_code: { organizationId, code } }`
 * → `{ organizationId, code }`) para que el filtro de tenant se pueda componer con AND.
 * Sin esto, el organizationId de DENTRO del selector es el que localiza la fila y puede
 * ser de otra organización (fuga silenciosa, §3.3 del diseño).
 */
export function flattenUniqueWhere(where: unknown): WhereRecord {
  if (!isPlainObject(where)) return {}
  const out: WhereRecord = {}
  for (const [key, value] of Object.entries(where)) {
    if (key.includes("_") && isPlainObject(value)) {
      const segments = key.split("_")
      const valueKeys = Object.keys(value)
      const isCompositeSelector =
        segments.length === valueKeys.length && segments.every((segment) => valueKeys.includes(segment))
      if (isCompositeSelector) {
        for (const [innerKey, innerValue] of Object.entries(value)) {
          out[innerKey] = innerValue
        }
        continue
      }
    }
    out[key] = value
  }
  return out
}

/**
 * `where` de una operación dirigida (update/delete/upsert), acotado al tenant.
 *
 * Prisma exige un selector ÚNICO en estas operaciones, así que no vale componer
 * con `AND` (dejaría el `where` sin campo único y Prisma lo rechazaría). Se
 * reconstruye el selector forzando `organizationId = orgId` dentro del selector
 * compuesto y se añade `organizationId` como filtro extra no único
 * (extendedWhereUnique). Si el llamante traía una organización ajena, se LANZA:
 * un selector cruzado es un bug, no algo que silenciar.
 */
export function scopeUniqueWhere(where: unknown, organizationId: string): WhereRecord {
  const flat = flattenUniqueWhere(where)
  const given = flat.organizationId
  if (given !== undefined && given !== null && given !== organizationId) {
    throw new TenantError(`tenantDb: selector único de otra organización`)
  }

  const out: WhereRecord = {}
  if (isPlainObject(where)) {
    for (const [key, value] of Object.entries(where)) {
      if (key.includes("_") && isPlainObject(value) && "organizationId" in value) {
        out[key] = { ...value, organizationId }
        continue
      }
      out[key] = value
    }
  }
  out.organizationId = organizationId
  return out
}

/** Fija organizationId en los datos de creación; lanza si venía uno ajeno. */
export function withOrg(data: unknown, organizationId: string): WhereRecord {
  if (!isPlainObject(data)) {
    return { organizationId }
  }
  const existing = data.organizationId
  if (existing !== undefined && existing !== null && existing !== organizationId) {
    throw new TenantError(`tenantDb: intento de escritura cruzada (organizationId ajeno)`)
  }
  return { ...data, organizationId }
}

type DelegateOperation = (args: unknown) => Promise<unknown>
type ClientByModel = Record<string, Record<string, DelegateOperation>>

function delegateName(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1)
}

const READ_OPERATIONS = new Set(["findMany", "findFirst", "findFirstOrThrow", "count", "aggregate", "groupBy"])

// ─────────────────────────────────────────────────────────────────────────────
// GUC de tenant — barrera 2 (RLS). ADR-0002 + ADR-0007 + E1-fix (#1, #2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Contexto de la transacción de tenant en curso.
 *
 * `client` es el cliente CRUDO de la transacción (sin extensión) en la que ya
 * están fijados los GUC. Toda operación que la extensión intercepte estando
 * este contexto activo se despacha SOBRE ÉL: si se despachara sobre el cliente
 * base (`prisma`), la consulta saldría de la transacción y perdería
 * `app.current_org` / `app.current_user` — que es justo el fallo #2 de la
 * ronda 2 de revisión. Al ser crudo, además, no vuelve a entrar en la extensión.
 */
type TenantGucContext = { organizationId: string | null; userId?: string; client: ClientByModel }

const tenantGucStorage = new AsyncLocalStorage<TenantGucContext>()

/** Firma mínima que necesitan los helpers de GUC (cliente o cliente de transacción). */
type RawExecutor = { $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown> }

/**
 * Fija `app.current_org` y `app.current_user` como GUC LOCALES: duran hasta el
 * COMMIT/ROLLBACK, igual que `SET LOCAL`.
 *
 * Se usa `set_config(..., is_local => true)` y no `SET LOCAL` porque
 * `current_user` es palabra reservada de SQL y `SET LOCAL app.current_user`
 * ni siquiera parsea (error 42601). `set_config` además admite parámetros
 * vinculados, así que el valor no se interpola en la sentencia; aun así se
 * valida como uuid.
 *
 * Sin usuario se fija cadena vacía, que `app.current_user()` convierte en NULL:
 * una transacción nunca hereda el usuario de otra.
 */
async function applyTenantGucs(tx: RawExecutor, organizationId: string | null, userId?: string): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.current_org', ${organizationId ? assertUuid(organizationId) : ""}, true)`
  await tx.$executeRaw`SELECT set_config('app.current_user', ${userId ? assertUuid(userId, "userId") : ""}, true)`
}

/**
 * Ejecuta UNA operación de Prisma dentro de una transacción con los GUC de
 * tenant fijados. Se invoca desde la extensión cuando la llamada no viene ya
 * envuelta por `tenantTransaction`.
 *
 * Los args llegan YA acotados por la extensión (barrera 1), así que aquí se
 * ejecutan contra el cliente crudo de la transacción: no hay recursión.
 */
async function runWithTenantGucs(
  organizationId: string,
  model: string,
  operation: string,
  args: WhereRecord
): Promise<unknown> {
  const inherited = tenantGucStorage.getStore()
  const userId = inherited?.organizationId === organizationId ? inherited.userId : undefined
  return await prisma.$transaction(async (tx) => {
    await applyTenantGucs(tx, organizationId, userId)
    const rawClient = tx as unknown as ClientByModel
    // El contexto se publica también aquí para que cualquier operación anidada
    // (p. ej. la reescritura findUnique→findFirst) caiga en ESTA transacción.
    return await tenantGucStorage.run({ organizationId, userId, client: rawClient }, async () =>
      rawClient[delegateName(model)][operation](args)
    )
  })
}


export const tenantExtension = (organizationId: string) =>
  Prisma.defineExtension((client) =>
    client.$extends({
      name: `tenant:${organizationId}`,
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            const isTenantModel = TENANT_MODELS.has(model)
            const isHybridModel = TENANT_MODELS_WITH_GLOBAL.has(model)
            if (!isTenantModel && !isHybridModel) {
              // User, Session, Account, Verification, Organization
              return query(args)
            }

            const strictScope: WhereRecord = { organizationId }
            const readScope: WhereRecord = isHybridModel
              ? { OR: [{ organizationId }, { organizationId: null }] }
              : strictScope
            const typedArgs = (args ?? {}) as WhereRecord

            // Args acotados por la barrera 1 + operación efectiva a ejecutar.
            let nextOperation = operation
            let nextArgs: WhereRecord

            if (READ_OPERATIONS.has(operation)) {
              nextArgs = { ...typedArgs, where: and(typedArgs.where, readScope) }
            } else {
              switch (operation) {
                case "findUnique":
                case "findUniqueOrThrow": {
                  // El callback query() ejecuta LA MISMA operación: para poder añadir
                  // un filtro no único hay que reescribirla a findFirst.
                  nextOperation = operation === "findUnique" ? "findFirst" : "findFirstOrThrow"
                  nextArgs = { ...typedArgs, where: and(flattenUniqueWhere(typedArgs.where), readScope) }
                  break
                }

                case "update":
                case "delete":
                  nextArgs = { ...typedArgs, where: scopeUniqueWhere(typedArgs.where, organizationId) }
                  break

                case "updateMany":
                case "updateManyAndReturn":
                case "deleteMany":
                  nextArgs = { ...typedArgs, where: and(typedArgs.where, strictScope) }
                  break

                case "create":
                  nextArgs = { ...typedArgs, data: withOrg(typedArgs.data, organizationId) }
                  break

                case "createMany":
                case "createManyAndReturn": {
                  const rows = Array.isArray(typedArgs.data) ? typedArgs.data : [typedArgs.data]
                  nextArgs = { ...typedArgs, data: rows.map((row) => withOrg(row, organizationId)) }
                  break
                }

                case "upsert":
                  nextArgs = {
                    ...typedArgs,
                    where: scopeUniqueWhere(typedArgs.where, organizationId),
                    create: withOrg(typedArgs.create, organizationId),
                    update: typedArgs.update,
                  }
                  break

                default:
                  throw new TenantError(`tenantDb: operación no contemplada ${model}.${operation}`)
              }
            }

            // E1-fix (#1): TODA operación de negocio se ejecuta con los GUC de
            // tenant fijados, para que RLS (barrera 2) evalúe la política.
            //
            // Ronda 2 (#2/#9): si ya hay una transacción de tenant abierta para
            // ESTA organización, la operación se despacha sobre SU cliente crudo
            // — nunca sobre `client`/`query`, que podrían ser el cliente base y
            // sacar la consulta de la transacción (perdiendo los GUC) o abrir una
            // segunda conexión.
            const store = tenantGucStorage.getStore()
            if (store && store.organizationId === organizationId) {
              return await store.client[delegateName(model)][nextOperation](nextArgs)
            }
            return await runWithTenantGucs(organizationId, model, nextOperation, nextArgs)
          },
        },
      },
    })
  )

function buildTenantClient(organizationId: string) {
  return prisma.$extends(tenantExtension(organizationId)).$extends({
    client: {
      // La organización activa, accesible desde `models/` para construir los
      // selectores únicos compuestos `organizationId_code`.
      $organizationId: organizationId,

      /**
       * Ronda 2 (#9): `tenantDb(org).$transaction(fn)` NO fija los GUC, así que
       * las escrituras de dentro violarían el `WITH CHECK` de RLS; y como la
       * extensión no vería contexto de tenant, cada operación abriría ADEMÁS su
       * propia transacción anidada (segunda conexión del pool con la primera
       * abierta). Se corta con un error explícito en lugar de fallar en
       * producción con un mensaje de Postgres.
       */
      $transaction(): never {
        throw new TenantError(
          "tenantDb(orgId).$transaction() no fija app.current_org/app.current_user y anidaría transacciones. " +
            "Usa tenantTransaction(orgId, userId?, async (tx) => …)."
        )
      },
    },
  })
}

export type TenantClient = ReturnType<typeof buildTenantClient>

/** Cliente de transacción acotado (sin $transaction/$connect/…). */
export type TenantTransactionClient = Omit<
  TenantClient,
  "$transaction" | "$connect" | "$disconnect" | "$on" | "$extends" | "$use" | "$executeRawUnsafe"
>

const tenantClients = new Map<string, TenantClient>()

/**
 * Cliente Prisma acotado a una organización (barrera 1).
 *
 * - Inyecta `where.organizationId` en lecturas, actualizaciones, borrados y agregados.
 * - Inyecta `data.organizationId` en creaciones (y LANZA si venía uno ajeno).
 * - Reescribe `findUnique`/`findUniqueOrThrow` a `findFirst`/`findFirstOrThrow`.
 * - Desde E1-fix (#1) ejecuta cada operación dentro de una transacción con
 *   `app.current_org` (y `app.current_user`, si lo hereda de `tenantTransaction`)
 *   fijados por `SET LOCAL`, de modo que RLS (barrera 2) también filtra.
 *
 * Memoizado por organización: la extensión no se recrea en cada llamada.
 *
 * ## LÍMITES CONOCIDOS (hallazgo #19 de la revisión E1)
 *
 * 1. **Relaciones anidadas.** El filtro se aplica al modelo RAÍZ de la
 *    operación, no a los `include` / `select` anidados ni a las escrituras
 *    anidadas (`create: { files: { create: [...] } }`). Hoy no hay fuga porque
 *    las FK son COMPUESTAS por `(organization_id, …)` (migración
 *    20260904120200) y la BD rechaza cruzar organizaciones; pero al añadir una
 *    relación nueva hay que mantener esa FK compuesta o filtrar a mano.
 * 2. **SQL crudo.** `$queryRaw`, `$queryRawUnsafe`, `$executeRaw*` NO pasan por
 *    la extensión: el `WHERE organization_id` es responsabilidad de quien
 *    escribe la consulta. Desde E1-fix corren, además, con `app.current_org`
 *    fijado sólo si van dentro de `tenantTransaction`.
 * 3. **Modelos fuera de `TENANT_MODELS`.** `User`, `Session`, `Account`,
 *    `Verification` y `Organization` pasan sin tocar: son pre-tenant o
 *    resuelven QUÉ organización.
 *
 * Ambos límites están cubiertos por tests en `lib/db.test.ts`.
 */
export function tenantDb(organizationId: string): TenantClient {
  assertUuid(organizationId)
  const cached = tenantClients.get(organizationId)
  if (cached) return cached
  const client = buildTenantClient(organizationId)
  tenantClients.set(organizationId, client)
  return client
}

/**
 * Transacción con `app.current_org` (y opcionalmente `app.current_user`) fijados
 * como GUC locales, para que RLS (barrera 2) evalúe las políticas de la
 * organización activa y de la pertenencia del usuario.
 *
 * Úsala cuando varias operaciones deban ser ATÓMICAS o cuando la política
 * necesite el usuario (alta de organización, aceptación de invitación, gestión
 * de miembros). Para operaciones sueltas no hace falta: `tenantDb(orgId)` ya
 * envuelve cada operación en su propia transacción con los GUC puestos.
 *
 * ## Coste (deuda anotada en docs/ESTADO.md, se retira en E3)
 * Una operación suelta por `tenantDb` = un `BEGIN` + dos `set_config` + la
 * consulta + `COMMIT`: tres viajes extra a la base y una conexión del pool
 * ocupada mientras dura. Es el precio de tener RLS efectiva sin refactorizar de
 * golpe los 32 ficheros heredados (ADR-0007). Cuando el código de negocio esté
 * agrupado dentro de `tenantTransaction` (E3), la envoltura por operación
 * dejará de hacer falta: dentro de esta función TODAS las operaciones comparten
 * la misma transacción y no abren ninguna más.
 */
/**
 * Cliente que ve `fn` dentro de `tenantTransaction`: los delegados de modelo van
 * al cliente ACOTADO (barrera 1; la extensión los despacha sobre la transacción
 * gracias al AsyncLocalStorage) y los métodos `$…` —en particular `$queryRaw*` y
 * `$executeRaw*`— van DIRECTOS a la transacción, que es donde están fijados los
 * GUC. Sin esto, un `$queryRaw` dentro de la transacción saldría por otra
 * conexión y no vería `app.current_org`.
 */
function tenantTransactionFacade(organizationId: string, tx: object): TenantTransactionClient {
  const scoped = tenantDb(organizationId) as unknown as Record<string, unknown>
  const rawTx = tx as unknown as Record<string, unknown>
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== "string") return undefined
        if (property === "$organizationId") return organizationId
        if (property.startsWith("$")) {
          const value = rawTx[property]
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(rawTx) : value
        }
        return scoped[property]
      },
    }
  ) as unknown as TenantTransactionClient
}

/**
 * Límites de la transacción. Prisma corta a los 5 s por defecto (`timeout`) y
 * espera 2 s por una conexión libre (`maxWait`): suficiente para una mutación de
 * formulario, NO para una siembra de plan contable (900 cuentas + mapa + tipos),
 * que aborta a mitad con «Transaction already closed» y deja al usuario sin
 * plan. Quien haga un lote largo debe declarar su presupuesto explícitamente.
 */
export type TenantTransactionOptions = { timeout?: number; maxWait?: number }

/** Presupuesto de las operaciones de siembra/importación masiva (E2, T7). */
export const SEED_TRANSACTION_OPTIONS: TenantTransactionOptions = { timeout: 60_000, maxWait: 10_000 }

export async function tenantTransaction<T>(
  organizationId: string,
  userIdOrFn: string | undefined | ((tx: TenantTransactionClient) => Promise<T>),
  fnOrOptions?: ((tx: TenantTransactionClient) => Promise<T>) | TenantTransactionOptions,
  maybeOptions?: TenantTransactionOptions
): Promise<T> {
  const userId = typeof userIdOrFn === "function" ? undefined : userIdOrFn
  const fn = typeof userIdOrFn === "function" ? userIdOrFn : (typeof fnOrOptions === "function" ? fnOrOptions : undefined)
  const options: TenantTransactionOptions | undefined =
    typeof userIdOrFn === "function"
      ? (fnOrOptions as TenantTransactionOptions | undefined)
      : (maybeOptions ?? (typeof fnOrOptions === "function" ? undefined : fnOrOptions))
  if (!fn) throw new TenantError("tenantTransaction: falta la función de transacción")
  assertUuid(organizationId)

  const outer = tenantGucStorage.getStore()
  if (outer && outer.organizationId === organizationId) {
    // Reentrante: ya hay transacción de tenant abierta para esta organización.
    // Abrir otra tomaría una segunda conexión del pool mientras la primera sigue
    // viva → interbloqueo bajo carga. Se reutiliza la que hay (#9). Los límites
    // los fijó quien abrió la transacción externa: aquí ya no se pueden ampliar.
    return await fn(tenantTransactionFacade(organizationId, outer.client))
  }

  // La transacción se abre sobre el cliente CRUDO y se publica en el
  // AsyncLocalStorage; `fn` recibe el cliente acotado de siempre y la extensión
  // despacha cada operación sobre esta transacción (ver TenantGucContext).
  return await prisma.$transaction(async (tx) => {
    await applyTenantGucs(tx, organizationId, userId)
    return await tenantGucStorage.run(
      { organizationId, userId, client: tx as unknown as ClientByModel },
      async () => fn(tenantTransactionFacade(organizationId, tx))
    )
  }, options)
}

/**
 * Igual que `tenantTransaction` pero entrega el cliente SIN acotar: para los
 * modelos que resuelven QUÉ organización (`organizations`, `memberships`,
 * `invitations` por token) y por tanto no pueden pasar por `tenantDb`. Fija los
 * mismos GUC, de modo que las políticas por pertenencia (`app.current_user()`)
 * se evalúen correctamente.
 *
 * Publica además el contexto en el AsyncLocalStorage (#9): si dentro se usa
 * `tenantDb(orgId)` de la misma organización, sus operaciones entran en ESTA
 * transacción en lugar de abrir una segunda conexión.
 *
 * @internal Sólo `models/{organizations,memberships,invitations}.ts` y `lib/email-sync`.
 */
export async function withTenantGucs<T>(
  organizationId: string | null,
  userId: string | undefined,
  fn: (tx: Omit<PrismaClient, "$transaction" | "$connect" | "$disconnect" | "$on" | "$extends" | "$use">) => Promise<T>
): Promise<T> {
  const outer = tenantGucStorage.getStore()
  if (outer && outer.organizationId === organizationId) {
    return await fn(outer.client as unknown as Parameters<typeof fn>[0])
  }
  return await prisma.$transaction(async (tx) => {
    await applyTenantGucs(tx, organizationId, userId)
    return await tenantGucStorage.run(
      { organizationId, userId, client: tx as unknown as ClientByModel },
      async () => fn(tx)
    )
  })
}
