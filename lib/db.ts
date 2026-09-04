import { PrismaPg } from "@prisma/adapter-pg"
import { Prisma, PrismaClient } from "@/prisma/client"

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function createPrismaClient() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
  return new PrismaClient({ adapter, log: ["query", "info", "warn", "error"] })
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

function assertUuid(organizationId: string): string {
  if (!UUID_RE.test(organizationId)) {
    throw new TenantError(`tenantDb: organizationId no es un uuid válido`)
  }
  return organizationId
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

            if (READ_OPERATIONS.has(operation)) {
              return run({ ...typedArgs, where: and(typedArgs.where, readScope) })
            }

            switch (operation) {
              case "findUnique":
              case "findUniqueOrThrow": {
                // El callback query() ejecuta LA MISMA operación: para poder añadir un
                // filtro no único hay que reescribirla a findFirst sobre el cliente padre.
                const where = and(flattenUniqueWhere(typedArgs.where), readScope)
                const target = operation === "findUnique" ? "findFirst" : "findFirstOrThrow"
                const delegate = (client as unknown as ClientByModel)[delegateName(model)]
                return delegate[target]({ ...typedArgs, where })
              }

              case "update":
              case "delete":
                return run({ ...typedArgs, where: scopeUniqueWhere(typedArgs.where, organizationId) })

              case "updateMany":
              case "updateManyAndReturn":
              case "deleteMany":
                return run({ ...typedArgs, where: and(typedArgs.where, strictScope) })

              case "create":
                return run({ ...typedArgs, data: withOrg(typedArgs.data, organizationId) })

              case "createMany":
              case "createManyAndReturn": {
                const rows = Array.isArray(typedArgs.data) ? typedArgs.data : [typedArgs.data]
                return run({ ...typedArgs, data: rows.map((row) => withOrg(row, organizationId)) })
              }

              case "upsert":
                return run({
                  ...typedArgs,
                  where: scopeUniqueWhere(typedArgs.where, organizationId),
                  create: withOrg(typedArgs.create, organizationId),
                  update: typedArgs.update,
                })

              default:
                throw new TenantError(`tenantDb: operación no contemplada ${model}.${operation}`)
            }
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
 * Cliente Prisma acotado a una organización.
 * - Inyecta `where.organizationId` en lecturas, actualizaciones, borrados y agregados.
 * - Inyecta `data.organizationId` en creaciones (y LANZA si venía uno ajeno).
 * - Reescribe `findUnique`/`findUniqueOrThrow` a `findFirst`/`findFirstOrThrow`.
 * Memoizado por organización: la extensión no se recrea en cada llamada.
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
 * Transacción con `app.current_org` fijado vía SET LOCAL, para que RLS (barrera 2)
 * evalúe la política de la organización activa. Toda escritura de negocio debería
 * pasar por aquí. El uuid se valida con regex antes de interpolarlo: SET no admite
 * parámetros vinculados en Postgres.
 */
export async function tenantTransaction<T>(
  organizationId: string,
  fn: (tx: TenantTransactionClient) => Promise<T>
): Promise<T> {
  assertUuid(organizationId)
  // El cliente extendido propaga la extensión a su cliente de transacción: las
  // consultas de `tx` ya salen filtradas por organización.
  return tenantDb(organizationId).$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.current_org = '${organizationId}'`)
    return fn(tx as unknown as TenantTransactionClient)
  })
}
