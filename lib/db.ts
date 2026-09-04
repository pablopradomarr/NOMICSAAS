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

/** Contexto de la transacción de tenant en curso (evita anidar transacciones). */
type TenantGucContext = { organizationId: string; userId?: string }

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
    const delegate = (tx as unknown as ClientByModel)[delegateName(model)]
    return await delegate[operation](args)
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
            // `query` está tipado con los args del modelo concreto; aquí se compone
            // de forma genérica, así que se invoca a través de una firma laxa.
            const run = query as unknown as (nextArgs: WhereRecord) => Promise<unknown>

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
            // tenant fijados, para que RLS (barrera 2) evalúe la política. Si ya
            // estamos dentro de `tenantTransaction` de esta misma organización,
            // los GUC ya están puestos y se ejecuta en esa transacción (abrir otra
            // desde dentro consumiría una segunda conexión y podría interbloquear).
            const store = tenantGucStorage.getStore()
            if (store?.organizationId === organizationId) {
              if (nextOperation === operation) return run(nextArgs)
              const delegate = (client as unknown as ClientByModel)[delegateName(model)]
              return delegate[nextOperation](nextArgs)
            }
            return await runWithTenantGucs(organizationId, model, nextOperation, nextArgs)
          },
        },
      },
    })
  )

function buildTenantClient(organizationId: string) {
  return prisma.$extends(tenantExtension(organizationId)).$extends({
    // La organización activa, accesible desde `models/` para construir los
    // selectores únicos compuestos `organizationId_code`.
    client: { $organizationId: organizationId },
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
 * vía `SET LOCAL`, para que RLS (barrera 2) evalúe las políticas de la
 * organización activa y de la pertenencia del usuario.
 *
 * Úsala cuando varias operaciones deban ser atómicas o cuando la política
 * necesite el usuario (alta de organización, aceptación de invitación, gestión
 * de miembros). Para operaciones sueltas no hace falta: desde E1-fix (#1)
 * `tenantDb(orgId)` ya envuelve cada operación en su propia transacción con los
 * GUC puestos.
 *
 * Los uuid se validan con regex antes de interpolarse: `SET` no admite
 * parámetros vinculados en Postgres.
 */
export async function tenantTransaction<T>(
  organizationId: string,
  userIdOrFn: string | undefined | ((tx: TenantTransactionClient) => Promise<T>),
  maybeFn?: (tx: TenantTransactionClient) => Promise<T>
): Promise<T> {
  const userId = typeof userIdOrFn === "function" ? undefined : userIdOrFn
  const fn = typeof userIdOrFn === "function" ? userIdOrFn : maybeFn
  if (!fn) throw new TenantError("tenantTransaction: falta la función de transacción")
  assertUuid(organizationId)

  // El cliente extendido propaga la extensión a su cliente de transacción: las
  // consultas de `tx` ya salen filtradas por organización. El AsyncLocalStorage
  // le dice a la extensión que NO abra una transacción propia por operación.
  return await tenantGucStorage.run({ organizationId, userId }, async () =>
    tenantDb(organizationId).$transaction(async (tx) => {
      await applyTenantGucs(tx, organizationId, userId)
      return fn(tx as unknown as TenantTransactionClient)
    })
  )
}

/**
 * Igual que `tenantTransaction` pero sobre el cliente SIN acotar: para los
 * modelos que resuelven QUÉ organización (`organizations`, `memberships`) y por
 * tanto no pueden pasar por `tenantDb`. Fija los mismos GUC, de modo que las
 * políticas por pertenencia (`app.current_user()`) se evalúen correctamente.
 * @internal Sólo `models/organizations.ts` y `models/memberships.ts`.
 */
export async function withTenantGucs<T>(
  organizationId: string | null,
  userId: string | undefined,
  fn: (tx: Omit<PrismaClient, "$transaction" | "$connect" | "$disconnect" | "$on" | "$extends" | "$use">) => Promise<T>
): Promise<T> {
  return await prisma.$transaction(async (tx) => {
    await applyTenantGucs(tx, organizationId, userId)
    return fn(tx)
  })
}
