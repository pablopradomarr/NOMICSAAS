# E1 — Organizaciones y roles (diseño)

**Épica:** E1 · **Nivel:** 2 (ADR-0002 APROBADO 2026-09-04) · **Depende de:** E0 (parte hecha: `lib/money.ts`, hook de pureza, `runs/registro.jsonl`; pendiente CI y `test:integration`, ver riesgo R6) · **Autor:** arquitecto · **Estado:** PROPUESTO

---

## 1. Objetivo y alcance

Convertir TaxHacker (aislamiento por `userId`, un usuario = un espacio de datos) en un SaaS multi-tenant por **organización**, con roles `ADMIN | EDITOR | VIEWER`, dos barreras de aislamiento (`tenantDb(orgId)` en la app, RLS en Postgres) e invitaciones por email. Todas las tablas de negocio heredadas pasan a llevar `organizationId`; cada `User` existente genera su **organización personal** con membresía `ADMIN`, sin pérdida de datos ni de uniques.

**NO incluye:** plan de cuentas (E2), ejercicios ni libro diario (E3), analítica ni CECOs (E4/E5), informes (E6), Stripe/planes/límites por plan (E11 — E1 sólo *mueve* las columnas de facturación y cuota de `User` a `Organization`), SSO/SCIM, organizaciones anidadas, transferencia de propiedad entre usuarios, borrado de organización (sólo desactivación lógica), y la sustitución del `Project` heredado por el `Project` analítico (E4: E1 se limita a añadirle `organizationId`).

**Invariante rector de la épica:** I10 (tenant) deja de ser una convención de código y pasa a ser verificable: ninguna fila de negocio es alcanzable desde una organización distinta a la suya, ni por la app ni por SQL directo con el rol de runtime.

---

## 2. Modelo de datos

### 2.1 Convenciones aplicadas

Según `docs/MODELO-DATOS.md`: ids `uuid` (`@db.Uuid`), **nombres físicos snake_case obligatorios** (`@@map` en tabla, `@map` en todo campo nuevo — el SQL de RLS y de informes usa snake_case), `createdAt/updatedAt`, uniques e índices **compuestos con `organizationId` en primera posición** (prefijo de índice reutilizable por las queries que sólo filtran por tenant).

Aviso sobre el esquema heredado: TaxHacker **no** aplica `@map` de forma sistemática (`Category.llm_prompt`, `Field.code`, `Transaction.name`, `Setting.code`… salen tal cual en camelCase o ya en snake). E1 **no** renombra columnas heredadas (rompería 10 migraciones aplicadas y todo el import/export); sólo garantiza snake_case en **columnas y tablas nuevas**. Deuda registrada como riesgo R5.

### 2.2 Fragmento Prisma — modelos nuevos

```prisma
enum Role {
  ADMIN
  EDITOR
  VIEWER

  @@map("role")
}

enum PgcVariant {
  GENERAL
  PYMES

  @@map("pgc_variant")
}

enum InvitationStatus {
  PENDING
  ACCEPTED
  REVOKED
  EXPIRED

  @@map("invitation_status")
}

model Organization {
  id                String     @id @default(uuid()) @db.Uuid
  slug              String     @unique
  name              String
  taxId             String?    @map("tax_id")
  baseCurrency      String     @default("EUR") @map("base_currency")
  timezone          String     @default("Europe/Madrid")
  pgcVariant        PgcVariant @default(PYMES) @map("pgc_variant")
  ledgerEnabled     Boolean    @default(true) @map("ledger_enabled")
  analyticsRequired Boolean    @default(true) @map("analytics_required")
  reviewThresholds  Json?      @map("review_thresholds")
  isPersonal        Boolean    @default(false) @map("is_personal")
  isActive          Boolean    @default(true) @map("is_active")

  // Datos de emisor de facturas — migrados desde User (ver §2.5)
  businessName        String? @map("business_name")
  businessAddress     String? @map("business_address")
  businessBankDetails String? @map("business_bank_details")
  businessLogo        String? @map("business_logo")

  // Facturación y cuotas — migrados desde User (ADR-0001: cloud a nivel organización)
  stripeCustomerId    String?   @map("stripe_customer_id")
  membershipPlan      String?   @map("membership_plan")
  membershipExpiresAt DateTime? @map("membership_expires_at")
  storageUsed         Int       @default(0) @map("storage_used")
  storageLimit        Int       @default(-1) @map("storage_limit")
  aiBalance           Int       @default(0) @map("ai_balance")

  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  memberships  Membership[]
  invitations  Invitation[]
  settings     Setting[]
  categories   Category[]
  projects     Project[]
  fields       Field[]
  files        File[]
  transactions Transaction[]
  currencies   Currency[]
  appData      AppData[]
  progress     Progress[]

  @@index([stripeCustomerId])
  @@map("organizations")
}

model Membership {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  userId         String       @map("user_id") @db.Uuid
  user           User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  role           Role
  invitedById    String?      @map("invited_by_id") @db.Uuid
  acceptedAt     DateTime?    @map("accepted_at")
  createdAt      DateTime     @default(now()) @map("created_at")
  updatedAt      DateTime     @updatedAt @map("updated_at")

  @@unique([organizationId, userId])
  @@index([userId])
  @@index([organizationId, role])
  @@map("memberships")
}

model Invitation {
  id             String           @id @default(uuid()) @db.Uuid
  organizationId String           @map("organization_id") @db.Uuid
  organization   Organization     @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  email          String                            // normalizado a lowercase
  role           Role
  tokenHash      String           @unique @map("token_hash")   // sha256(token) en hex; el token en claro NUNCA se persiste
  status         InvitationStatus @default(PENDING)
  invitedById    String           @map("invited_by_id") @db.Uuid
  expiresAt      DateTime         @map("expires_at")
  acceptedAt     DateTime?        @map("accepted_at")
  acceptedById   String?          @map("accepted_by_id") @db.Uuid
  revokedAt      DateTime?        @map("revoked_at")
  createdAt      DateTime         @default(now()) @map("created_at")
  updatedAt      DateTime         @updatedAt @map("updated_at")

  @@index([organizationId, status])
  @@index([email])
  @@map("invitations")
}
```

Unique parcial que Prisma no expresa (va en SQL manual dentro de la migración): **una sola invitación PENDING viva por (org, email)**:

```sql
CREATE UNIQUE INDEX invitations_org_email_pending_uniq
  ON invitations (organization_id, lower(email))
  WHERE status = 'PENDING';
```

### 2.3 Fragmento Prisma — `User` después de E1

```prisma
model User {
  id            String   @id @default(uuid()) @db.Uuid
  email         String   @unique
  name          String
  avatar        String?
  emailVerified Boolean  @default(false) @map("is_email_verified")
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")

  accounts    Account[]
  sessions    Session[]
  memberships Membership[]

  // ELIMINADOS en E1 (movidos a Organization): stripe_customer_id, membership_plan,
  // membership_expires_at, storage_used, storage_limit, ai_balance,
  // business_name, business_address, business_bank_details, business_logo.
  // ELIMINADAS las relaciones 1-N a settings/categories/projects/fields/files/
  // currencies/transactions/app_data/progress (ahora cuelgan de Organization).

  @@map("users")
}
```

**Decisión sobre `User.businessName / businessAddress / businessBankDetails / businessLogo` → `Organization`.** Son los datos del **emisor de la factura** (`app/(app)/apps/invoices/*` los usa para la cabecera del PDF). Un usuario que pertenece a dos empresas debe emitir con los datos de la empresa activa, no con los suyos; el dato es de la organización por naturaleza. Se mueven con `MOVE` real (backfill + `DROP COLUMN` en el mismo paso 3), no se duplican: mantener la columna en ambos sitios garantiza divergencia silenciosa en el PDF. Ficheros afectados: `app/(app)/apps/invoices/default-templates.ts`, `components/invoice-generator.tsx`, `components/invoice-page.tsx`, `components/invoice-pdf.tsx`, `forms/users.ts`, `components/settings/profile-settings-form.tsx` (el bloque "business" se traslada a `settings/organization`).

**Decisión sobre `stripeCustomerId / membershipPlan / membershipExpiresAt` (y por coherencia `storageUsed / storageLimit / aiBalance`) → `Organization`.** ADR-0001 fija "planes/membresía a nivel organización (cloud)" y el ROADMAP pone Stripe por organización en E11. Si el cliente de Stripe siguiera colgando de `User`, un usuario con dos organizaciones compartiría plan, saldo IA y cuota de almacenamiento entre empresas de clientes distintos — inaceptable y además irreversible una vez haya suscripciones vivas. El consumo (`storageUsed`, `aiBalance`) lo genera el trabajo sobre documentos de **una** organización, luego debe medirse ahí. E1 mueve columnas y adapta lecturas; E11 añade planes, límites y el flujo de checkout. Ficheros afectados: `lib/auth.ts` (`UserProfile`, `isSubscriptionExpired`, `isAiBalanceExhausted`), `models/users.ts` (`getUserByStripeCustomerId` → `getOrganizationByStripeCustomerId` en `models/organizations.ts`), `app/api/stripe/webhook/route.ts`, `app/api/stripe/portal/route.ts`, `app/(auth)/cloud/payment/success/page.tsx`, `components/settings/subscription-plan.tsx`, `components/sidebar/sidebar-user.tsx`, `lib/uploads.ts` + `lib/files.ts` (rutas de almacenamiento y contador de cuota pasan a colgar de `organizationId`), `app/(app)/layout.tsx`.

> Consecuencia para self-hosted: `SELF_HOSTED_USER` sigue existiendo, pero `getOrCreateSelfHostedUser()` pasa a crear también la organización `taxhacker-local` (`isPersonal = true`, `membershipPlan = "unlimited"`) y su `Membership(ADMIN)`. `config.selfHosted.isEnabled` sigue cortocircuitando la expiración de suscripción.

### 2.4 Fragmento Prisma — tablas heredadas con `organizationId`

Patrón común: `organizationId String @map("organization_id") @db.Uuid` **NOT NULL** (excepto `Currency`), FK `onDelete: Cascade`, y **el unique compuesto `(organizationId, code)` sustituye al `(userId, code)`**.

```prisma
model Setting {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  code           String
  name           String
  description    String?
  value          String?
  version        Int          @default(1)                      // gap MEDIA: settings versionados
  updatedAt      DateTime     @updatedAt @map("updated_at")

  @@unique([organizationId, code])           // sustituye a @@unique([userId, code])
  @@map("settings")
}

model Category {
  id             String        @id @default(uuid()) @db.Uuid
  organizationId String        @map("organization_id") @db.Uuid
  organization   Organization  @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  code           String
  name           String
  color          String        @default("#000000")
  llm_prompt     String?
  transactions   Transaction[]
  createdAt      DateTime      @default(now()) @map("created_at")

  @@unique([organizationId, code])
  @@map("categories")
}

model Project {                                  // Project heredado de TaxHacker; el Project analítico llega en E4
  id             String        @id @default(uuid()) @db.Uuid
  organizationId String        @map("organization_id") @db.Uuid
  organization   Organization  @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  code           String
  name           String
  color          String        @default("#000000")
  llm_prompt     String?
  transactions   Transaction[]
  createdAt      DateTime      @default(now()) @map("created_at")

  @@unique([organizationId, code])
  @@map("projects")
}

model Field {
  id                  String       @id @default(uuid()) @db.Uuid
  organizationId      String       @map("organization_id") @db.Uuid
  organization        Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  code                String
  name                String
  type                String       @default("string")
  llm_prompt          String?
  options             Json?
  createdAt           DateTime     @default(now()) @map("created_at")
  isVisibleInList     Boolean      @default(false) @map("is_visible_in_list")
  isVisibleInAnalysis Boolean      @default(false) @map("is_visible_in_analysis")
  isRequired          Boolean      @default(false) @map("is_required")
  isExtra             Boolean      @default(true) @map("is_extra")

  @@unique([organizationId, code])
  @@map("fields")
}

model File {
  id                String       @id @default(uuid()) @db.Uuid
  organizationId    String       @map("organization_id") @db.Uuid
  organization      Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  uploadedById      String?      @map("uploaded_by_id") @db.Uuid   // ex user_id: autoría, NO tenancy
  filename          String
  path              String
  mimetype          String
  metadata          Json?
  isReviewed        Boolean      @default(false) @map("is_reviewed")
  isSplitted        Boolean      @default(false) @map("is_splitted")
  cachedParseResult Json?        @map("cached_parse_result")       // se elimina en E8 (G-03)
  createdAt         DateTime     @default(now()) @map("created_at")

  @@index([organizationId, createdAt])
  @@index([organizationId, isReviewed])
  @@map("files")
}

model Transaction {
  id                    String       @id @default(uuid()) @db.Uuid
  organizationId        String       @map("organization_id") @db.Uuid
  organization          Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  createdById           String?      @map("created_by_id") @db.Uuid  // ex user_id
  name                  String?
  description           String?
  merchant              String?
  total                 Int?
  currencyCode          String?      @map("currency_code")
  convertedTotal        Int?         @map("converted_total")
  convertedCurrencyCode String?      @map("converted_currency_code")
  type                  String?      @default("expense")
  items                 Json         @default("[]")
  note                  String?
  files                 Json         @default("[]")
  extra                 Json?
  category              Category?    @relation(fields: [categoryCode, organizationId], references: [code, organizationId])
  categoryCode          String?      @map("category_code")
  project               Project?     @relation(fields: [projectCode, organizationId], references: [code, organizationId])
  projectCode           String?      @map("project_code")
  issuedAt              DateTime?    @map("issued_at")
  createdAt             DateTime     @default(now()) @map("created_at")
  updatedAt             DateTime     @updatedAt @map("updated_at")
  text                  String?

  @@index([organizationId, issuedAt])
  @@index([organizationId, categoryCode])
  @@index([organizationId, projectCode])
  @@index([organizationId, merchant])
  @@index([organizationId, total])
  @@index([organizationId, name])
  @@map("transactions")
}

model Currency {                                    // ÚNICO modelo con organizationId nullable
  id             String        @id @default(uuid()) @db.Uuid
  organizationId String?       @map("organization_id") @db.Uuid
  organization   Organization? @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  code           String
  name           String

  @@unique([organizationId, code])
  @@map("currencies")
}

model AppData {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  userId         String       @map("user_id") @db.Uuid              // estado de app por usuario dentro de la org
  app            String
  data           Json

  @@unique([organizationId, userId, app])          // sustituye a @@unique([userId, app])
  @@map("app_data")
}

model Progress {
  id             String       @id @default(uuid()) @db.Uuid
  organizationId String       @map("organization_id") @db.Uuid
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  userId         String       @map("user_id") @db.Uuid              // el SSE es del usuario que lanzó el proceso
  type           String
  data           Json?
  current        Int          @default(0)
  total          Int          @default(0)
  createdAt      DateTime     @default(now()) @map("created_at")

  @@index([organizationId, userId])
  @@map("progress")
}
```

**Decisión `Currency` nullable.** TaxHacker ya tiene `userId String?`: `null` = moneda del catálogo global (semilla `DEFAULT_CURRENCIES`), no-null = moneda añadida por el usuario. Se conserva la semántica cambiando el eje a organización: `organizationId = NULL` ⇒ catálogo global de sólo lectura, visible por todas las organizaciones. Postgres considera distintos los `NULL` en un unique, luego `@@unique([organizationId, code])` **no** impide dos globales con el mismo código; se refuerza con índice parcial en SQL manual:

```sql
CREATE UNIQUE INDEX currencies_global_code_uniq ON currencies (code) WHERE organization_id IS NULL;
```

`Currency` es por tanto el **único modelo con lectura híbrida** (`organizationId = orgId OR organizationId IS NULL`) y requiere tratamiento explícito en `tenantDb` (§3.4) y en RLS (§5).

**Decisión sobre `user_id` en tablas heredadas.** En `Setting`, `Category`, `Project`, `Field` y `Currency` la columna se **elimina**: la entidad es de la organización y su autor no aporta nada. En `File` y `Transaction` se **renombra** a `uploaded_by_id` / `created_by_id` y se hace nullable: es provenance (SPEC-FIABILIDAD C3, y E8 lo necesita para `ExtractionRun.createdBy`). En `AppData` y `Progress` se **conserva** `user_id` junto a `organization_id`: son estado por usuario **dentro** de la organización.

**Consecuencia crítica de las FK compuestas de `Transaction`.** La FK pasa de `(category_code, user_id) → categories(code, user_id)` a `(category_code, organization_id) → categories(code, organization_id)`. Esto convierte I10 (tenant) en garantía de motor de base de datos para categoría y proyecto: es imposible referenciar una categoría de otra organización. Es el mismo patrón que E3 usará para `(organization_id, account_code) → accounts(organization_id, code)`.

### 2.5 Estrategia de migración en 3 pasos

Tres migraciones Prisma independientes, aplicables con la app en marcha (paso 1 y 2 no rompen el código antiguo). Nombres según convención `NNNN_<que_hace>`. La numeración continúa la existente (`20250523104130_split_tx_items` es la última aplicada).

#### Paso 1 — `0011_add_organizations_nullable` (aditiva, reversible, sin downtime)

- `CREATE TYPE role`, `pgc_variant`, `invitation_status`.
- `CREATE TABLE organizations`, `memberships`, `invitations` + índices y el unique parcial de invitaciones PENDING.
- `ALTER TABLE <t> ADD COLUMN organization_id uuid NULL` en las **9** tablas: `settings`, `categories`, `projects`, `fields`, `files`, `transactions`, `currencies`, `app_data`, `progress`.
- `ALTER TABLE settings ADD COLUMN version int NOT NULL DEFAULT 1, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now()`.
- En este punto **no** se toca ningún unique ni FK. El código actual (filtro por `user_id`) sigue funcionando intacto.

#### Paso 2 — `0012_backfill_personal_orgs` (SQL puro, idempotente, sin Prisma Client)

Una organización personal por usuario, con su membresía `ADMIN`, y propagación a las 9 tablas. Todo en una transacción; idempotente por `ON CONFLICT DO NOTHING` + `WHERE organization_id IS NULL`.

```sql
-- 2.1 Una organización personal por usuario (id determinista = user_id: simplifica el backfill y el rollback)
INSERT INTO organizations (
  id, slug, name, is_personal, base_currency, timezone, pgc_variant,
  business_name, business_address, business_bank_details, business_logo,
  stripe_customer_id, membership_plan, membership_expires_at,
  storage_used, storage_limit, ai_balance, created_at, updated_at)
SELECT
  u.id,
  -- slug estable y único: base del email + sufijo corto del uuid
  regexp_replace(lower(split_part(u.email, '@', 1)), '[^a-z0-9]+', '-', 'g')
    || '-' || substr(replace(u.id::text, '-', ''), 1, 6),
  COALESCE(NULLIF(u.business_name, ''), NULLIF(u.name, ''), split_part(u.email, '@', 1)),
  true, 'EUR', 'Europe/Madrid', 'PYMES',
  u.business_name, u.business_address, u.business_bank_details, u.business_logo,
  u.stripe_customer_id, u.membership_plan, u.membership_expires_at,
  u.storage_used, u.storage_limit, u.ai_balance, u.created_at, now()
FROM users u
ON CONFLICT (id) DO NOTHING;

-- 2.2 Membresía ADMIN aceptada
INSERT INTO memberships (id, organization_id, user_id, role, accepted_at, created_at, updated_at)
SELECT gen_random_uuid(), u.id, u.id, 'ADMIN', now(), now(), now()
FROM users u
ON CONFLICT (organization_id, user_id) DO NOTHING;

-- 2.3 Propagación (misma sentencia para las 8 tablas con user_id NOT NULL)
UPDATE settings     SET organization_id = user_id WHERE organization_id IS NULL;
UPDATE categories   SET organization_id = user_id WHERE organization_id IS NULL;
UPDATE projects     SET organization_id = user_id WHERE organization_id IS NULL;
UPDATE fields       SET organization_id = user_id WHERE organization_id IS NULL;
UPDATE files        SET organization_id = user_id WHERE organization_id IS NULL;
UPDATE transactions SET organization_id = user_id WHERE organization_id IS NULL;
UPDATE app_data     SET organization_id = user_id WHERE organization_id IS NULL;
UPDATE progress     SET organization_id = user_id WHERE organization_id IS NULL;

-- 2.4 Currencies: user_id NULL ⇒ catálogo global, se queda con organization_id NULL
UPDATE currencies SET organization_id = user_id WHERE organization_id IS NULL AND user_id IS NOT NULL;

-- 2.5 Verificación previa al paso 3 (aborta si queda huérfano)
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM (
    SELECT 1 FROM settings WHERE organization_id IS NULL
    UNION ALL SELECT 1 FROM categories   WHERE organization_id IS NULL
    UNION ALL SELECT 1 FROM projects     WHERE organization_id IS NULL
    UNION ALL SELECT 1 FROM fields       WHERE organization_id IS NULL
    UNION ALL SELECT 1 FROM files        WHERE organization_id IS NULL
    UNION ALL SELECT 1 FROM transactions WHERE organization_id IS NULL
    UNION ALL SELECT 1 FROM app_data     WHERE organization_id IS NULL
    UNION ALL SELECT 1 FROM progress     WHERE organization_id IS NULL
  ) x;
  IF n > 0 THEN RAISE EXCEPTION 'backfill incompleto: % filas sin organization_id', n; END IF;
END $$;
```

> `id = user_id` para la organización personal es deliberado: hace el backfill trivial (`organization_id = user_id`), el rollback trivial y el diagnóstico legible. No se expone en UI (la UI usa `slug`) y no compromete nada: los uuid de `users` son opacos. Las organizaciones creadas después usan `gen_random_uuid()` normal.

#### Paso 3 — `0013_org_tenancy_enforce` (destructiva, requiere ventana corta)

1. `ALTER TABLE <9> ALTER COLUMN organization_id SET NOT NULL` (todas salvo `currencies`).
2. FK a `organizations(id) ON DELETE CASCADE` en las 9.
3. **Drop de uniques antiguos y creación de los nuevos:**
   `settings_user_id_code_key` → `settings_organization_id_code_key`; ídem `categories`, `projects`, `fields`, `currencies`; `app_data_user_id_app_key` → `app_data_organization_id_user_id_app_key`.
4. FK compuestas de `transactions`: `DROP CONSTRAINT transactions_category_code_user_id_fkey` / `..._project_code_user_id_fkey`; `ADD FOREIGN KEY (category_code, organization_id) REFERENCES categories(code, organization_id)` e idéntica para `project_code`. Requiere que los uniques del punto 3 existan **antes**.
5. Índices nuevos (§2.4) y `DROP INDEX` de los índices de un solo `user_id` que quedan cubiertos por el prefijo `organization_id`.
6. `ALTER TABLE files RENAME COLUMN user_id TO uploaded_by_id; ALTER COLUMN uploaded_by_id DROP NOT NULL;` e igual en `transactions` → `created_by_id`.
7. `ALTER TABLE settings|categories|projects|fields|currencies DROP COLUMN user_id`.
8. `ALTER TABLE users DROP COLUMN business_name, business_address, business_bank_details, business_logo, stripe_customer_id, membership_plan, membership_expires_at, storage_used, storage_limit, ai_balance`.
9. Índices parciales: `currencies_global_code_uniq`, `invitations_org_email_pending_uniq`.

#### Paso 4 (separado) — `0014_rls_tenancy` (SQL manual, §5)

Se numera aparte porque su rollback es independiente y porque `get_advisors(security)` debe correr contra ella sola.

**Rollback.** Pasos 1 y 2 son reversibles sin pérdida (drop de columnas y tablas nuevas). El paso 3 **no** lo es (drop de columnas de `users`): antes de aplicarlo en producción, `pg_dump` completo + verificación de los conteos del script de verificación de la §8. Regla operativa: pasos 1+2 se despliegan en un release; el paso 3 en el siguiente, cuando el código nuevo ya está en producción y leyendo `organization_id`.

---

## 3. Motor / helpers: `tenantDb(orgId)`

`tenantDb` no es motor contable (no vive en `lib/ledger/`), pero sí es la pieza determinista de la que dependen todos los `models/`. Va en `lib/db.ts` (junto al `prisma` base, que pasa a no exportarse fuera de `lib/` y `models/users.ts`).

### 3.1 Contrato

```ts
/** Modelos con organizationId NOT NULL: filtro obligatorio en lectura y escritura. */
const TENANT_MODELS = new Set([
  "Setting", "Category", "Project", "Field", "File",
  "Transaction", "AppData", "Progress", "Membership", "Invitation",
])

/** Modelos con organizationId nullable: lectura híbrida (org ∪ global), escritura siempre con org. */
const TENANT_MODELS_WITH_GLOBAL = new Set(["Currency"])

export type TenantClient = ReturnType<typeof tenantDb>

/**
 * Cliente Prisma acotado a una organización.
 * - Inyecta `where.organizationId` en toda lectura/actualización/borrado/agregado.
 * - Inyecta `data.organizationId` en toda creación (y lo VERIFICA si venía puesto).
 * - `findUnique`/`findUniqueOrThrow` se reescriben a `findFirst`/`findFirstOrThrow`.
 * - `$transaction` fija `app.current_org` con SET LOCAL para que RLS aplique.
 * Memoizado por orgId dentro del request (React `cache`) para no recrear la extensión.
 */
export function tenantDb(organizationId: string): TenantClient
```

Uso obligatorio en `models/` de negocio; se fuerza con regla ESLint:

```js
// eslint.config.mjs
{
  files: ["models/**/*.ts", "app/**/*.ts", "app/**/*.tsx"],
  rules: {
    "no-restricted-imports": ["error", {
      paths: [{
        name: "@/lib/db",
        importNames: ["prisma"],
        message: "Usa tenantDb(orgId). El cliente sin tenant sólo se permite en lib/db.ts, models/users.ts y models/organizations.ts (pre-tenant).",
      }],
    }],
  },
}
```

Excepciones legítimas al lint (fichero por fichero, con `eslint-disable-next-line` y comentario): `models/users.ts` (auth, pre-tenant), `models/organizations.ts` y `models/memberships.ts` (resuelven **qué** organización, no pueden estar acotadas a una), `models/invitations.ts::acceptInvitation` (busca por `tokenHash` sin org conocida).

### 3.2 Forma de la extensión (Prisma 7 `$extends`)

```ts
import { Prisma } from "@/prisma/client"

const tenantExtension = (organizationId: string) =>
  Prisma.defineExtension((client) =>
    client.$extends({
      name: `tenant:${organizationId}`,
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            if (!TENANT_MODELS.has(model) && !TENANT_MODELS_WITH_GLOBAL.has(model)) {
              return query(args)   // User, Session, Account, Verification, Organization
            }
            const hybrid = TENANT_MODELS_WITH_GLOBAL.has(model)
            const scope = hybrid
              ? { OR: [{ organizationId }, { organizationId: null }] }
              : { organizationId }

            switch (operation) {
              // ── lecturas ────────────────────────────────────────────
              case "findMany": case "findFirst": case "findFirstOrThrow":
              case "count": case "aggregate": case "groupBy":
                return query({ ...args, where: and(args.where, scope) })

              // ── findUnique: se reescribe a findFirst (§3.3) ─────────
              case "findUnique": case "findUniqueOrThrow": {
                const where = and(flattenUniqueWhere(model, args.where), scope)
                const target = operation === "findUnique" ? "findFirst" : "findFirstOrThrow"
                // delegación al cliente padre: cambia la operación, no sólo los args
                return (client as any)[lowerFirst(model)][target]({ ...args, where })
              }

              // ── escrituras dirigidas ────────────────────────────────
              case "update": case "delete": {
                // Prisma exige `where` único; extendedWhereUnique permite añadir filtros
                // no únicos, pero un `update` que no encuentra fila LANZA P2025 en lugar
                // de devolver 0 filas: eso es exactamente lo que queremos (fallo ruidoso).
                return query({ ...args, where: and(flattenUniqueWhere(model, args.where), { organizationId }) })
              }
              case "updateMany": case "deleteMany":
                return query({ ...args, where: and(args.where, { organizationId }) })

              // ── creaciones: se fija, no se confía ───────────────────
              case "create":
                return query({ ...args, data: withOrg(args.data, organizationId, model) })
              case "createMany": case "createManyAndReturn":
                return query({
                  ...args,
                  data: (Array.isArray(args.data) ? args.data : [args.data])
                    .map((d) => withOrg(d, organizationId, model)),
                })

              // ── upsert: los tres lados ──────────────────────────────
              case "upsert":
                return query({
                  ...args,
                  where: and(flattenUniqueWhere(model, args.where), { organizationId }),
                  create: withOrg(args.create, organizationId, model),
                  update: args.update,
                })

              default:
                // aggregateRaw, $queryRaw, findRaw… no pasan por aquí; ver §3.5
                throw new Error(`tenantDb: operación no contemplada ${model}.${operation}`)
            }
          },
        },
      },
    })
  )
```

`withOrg(data, orgId, model)` **lanza** si `data.organizationId` viene con un valor distinto de `orgId` (intento de escritura cruzada = bug, no se silencia sobrescribiendo). `and(a, b)` compone con `AND` en vez de hacer spread superficial: `{ ...args.where, organizationId }` sería sobrescribible por un `where` que ya trajera `organizationId`, y además un `where: { OR: [...] }` del llamante quedaría fuera del ámbito si se mezclara mal.

### 3.3 El problema de `findUnique` (y la solución)

Tres problemas distintos, uno de ellos serio:

1. **`where` de `findUnique` es un input *único*, no un filtro.** Desde Prisma 5 (`extendedWhereUnique` GA) sí admite campos no únicos adicionales — de hecho TaxHacker ya lo usa: `models/transactions.ts:120` hace `findUnique({ where: { id, userId } })`. Pero eso sólo funciona cuando **al menos un** selector único está presente; una extensión genérica no puede garantizarlo para todos los modelos ni para todas las formas de `where`.

2. **El `where` puede venir como selector compuesto anidado.** El código heredado llama `prisma.setting.upsert({ where: { userId_code: { userId, code } } })` (`models/settings.ts:141`, `models/defaults.ts`). Tras E1 será `organizationId_code: { organizationId, code }`. Si la extensión hace un merge plano `{ ...where, organizationId }`, el resultado es `{ organizationId_code: {...}, organizationId }` — válido sintácticamente, pero el `organizationId` de dentro del selector compuesto es el que manda para localizar la fila, y **puede ser de otra organización**: el filtro extra sólo se evalúa después, y en `upsert` el lado `create` ya se habría podido ejecutar con datos ajenos. Es una fuga silenciosa. Por eso `flattenUniqueWhere(model, where)` **aplana** el selector compuesto (`{ organizationId_code: { organizationId: X, code: "c" } }` → `{ organizationId: X, code: "c" }`) **antes** de componer con `AND { organizationId: orgId }`: si `X ≠ orgId`, el `AND` es insatisfacible y la query devuelve `null` / lanza `P2025`, que es el comportamiento correcto.

3. **`findUnique` es batcheable, `findFirst` no.** Prisma agrupa `findUnique` concurrentes del mismo modelo en un `IN (...)` (dataloader). Reescribir a `findFirst` pierde ese batching y puede convertir un patrón N+1 latente en N consultas reales. Se acepta a cambio de la garantía de aislamiento, y se mitiga: los `models/` cargan relaciones con `include`/`select` explícitos, nunca con `findUnique` en bucle (revisar en `revisor-codigo`).

**Por qué reescribir y no simplemente añadir el filtro:** el callback `query(args)` de una extensión ejecuta *la misma* operación; no puede cambiar `findUnique` por `findFirst`. La reescritura exige tener el cliente padre a mano, y por eso la extensión se define con `Prisma.defineExtension((client) => ...)` en lugar de `prisma.$extends({...})` a secas. Alternativa descartada: `Prisma.getExtensionContext(this).$parent` — funciona, pero el tipado es peor y obliga a `any` en más sitios.

Efecto colateral deseado: con `findUnique` reescrito a `findFirst`, **`findUniqueOrThrow` sobre una fila de otra organización lanza `NotFoundError` en vez de devolverla**, que es el resultado que el tenant leak test verifica (§8, criterio CA-3).

### 3.4 `Currency` y la lectura híbrida

Los cuatro modelos de auth (`User`, `Session`, `Account`, `Verification`) y `Organization` quedan fuera del filtro (no tienen `organizationId`). `Currency` usa `scope = OR[{orgId}, {null}]` **sólo en lectura**; en `create`/`upsert` se fija `organizationId = orgId` (nunca se crean globales desde la app: el catálogo global sólo lo escribe el seed). `update`/`delete` usan el `scope` estricto `{ organizationId: orgId }` para que una organización no pueda modificar ni borrar una moneda global.

### 3.5 `SET LOCAL app.current_org` y transacciones

RLS lee `current_setting('app.current_org')`, que es **por sesión/transacción**, no por consulta. Con pooling (Supabase pgBouncer en modo transaction) una sesión se reparte entre requests, luego `SET` a secas es inseguro: sólo vale `SET LOCAL` dentro de una transacción explícita.

```ts
async function $tenantTransaction<T>(orgId: string, fn: (tx: TenantTx) => Promise<T>, opts?) {
  return prisma.$transaction(async (tx) => {
    // set_config(..., true) == SET LOCAL, pero admite parámetro vinculado.
    // `SET LOCAL app.current_org = $1` NO es válido en Postgres (SET no acepta binds),
    // y construirlo por interpolación abriría una inyección: se usa set_config.
    await tx.$executeRaw`SELECT set_config('app.current_org', ${orgId}::text, true)`
    return fn(tx.$extends(tenantExtension(orgId)) as TenantTx)
  }, opts)
}
```

`tenantDb(orgId).$transaction(fn)` delega en esto. **Consecuencia importante:** las consultas *fuera* de una transacción explícita no llevan `app.current_org` fijado; con `current_setting('app.current_org', true)` devolviendo `NULL`, la política de RLS de la §5 **deniega todo**. Dos opciones:

- (A) Envolver toda lectura en transacción → correcto pero costoso (una transacción por `findMany` de una página).
- (B) **Elegida:** el rol de runtime de Prisma es `app_runtime`, con `BYPASSRLS` **NO** concedido pero con una `GRANT`ada política de lectura que exige `app.current_org`; y `tenantDb` fija el GUC en **todas** las operaciones envolviéndolas en la transacción implícita sólo cuando la operación es de escritura, mientras que las lecturas se sirven con el filtro de aplicación (barrera 1) y quedan cubiertas por RLS **si** se ejecutan dentro de transacción.

Ambigüedad real: RLS como *segunda* barrera para el runtime de la app o como barrera para *accesos externos* (dashboard SQL, PostgREST, futuros clientes). ADR-0002 dice literalmente "protege accesos directos". **Decisión de E1:** RLS se activa con `FORCE` en todas las tablas de negocio y se dimensiona para accesos externos y escrituras; el runtime de Prisma usa `app_runtime`, que **sí** tiene `BYPASSRLS` desactivado, y `tenantDb` envuelve en `$tenantTransaction` (a) toda escritura y (b) toda lectura de `models/` que ya esté en transacción. Para no romper las lecturas sueltas, la política incluye una cláusula de escape auditada:

```sql
USING (organization_id = app.current_org() OR app.current_org() IS NULL)
```

…que se **elimina** (queda sólo `= app.current_org()`) en E3, cuando todas las lecturas de negocio pasen por `models/ledger.ts` y ya vayan en transacción. **Esto requiere decisión humana** (§9, D-2): la alternativa es pagar ya el coste de envolver todo en transacción y tener RLS estricta desde E1.

---

## 4. Capa de aplicación

### 4.1 `lib/authz.ts` — `requireOrg(minRole)`

```ts
import { Role } from "@/prisma/client"

export const ROLE_RANK: Record<Role, number> = { VIEWER: 1, EDITOR: 2, ADMIN: 3 }

export type OrgContext = {
  org: Organization
  user: User
  role: Role
  db: TenantClient          // tenantDb(org.id), ya memoizado
}

/** Lanza redirect a /enter si no hay sesión, a /organizations si no hay membresía,
 *  y ForbiddenError (→ 403 / notFound()) si el rol no alcanza. Nunca devuelve null. */
export async function requireOrg(minRole: Role = "VIEWER"): Promise<OrgContext>

/** Variante no-lanzante para RSC que deban renderizar UI degradada. */
export async function getOrgContext(): Promise<OrgContext | null>

/** Comprobación pura, testeable sin BD. */
export function hasRole(role: Role, minRole: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minRole]
}

/** Guard para UI: no autoriza nada, sólo decide qué se pinta. */
export function can(role: Role, action: Action): boolean
```

Algoritmo de `requireOrg`:

1. `session = await getSession()` (better-auth, `lib/auth.ts`; en self-hosted devuelve `SELF_HOSTED_USER`).
2. Si no hay sesión → `redirect(config.auth.loginUrl)`.
3. `orgId = await readActiveOrgCookie()` — cookie firmada `active_org` (ver §4.2). Si no hay o la firma no valida → `null`.
4. `membership = orgId ? await getMembership(orgId, user.id) : null`. **La cookie nunca es autoridad**: si no hay `Membership` aceptada para ese par, se ignora (y se borra la cookie).
5. Si `membership == null`: se resuelve la organización por defecto = membresía con `acceptedAt` más reciente (desempate por `createdAt`). Si el usuario no tiene ninguna → `redirect("/organizations/new")`.
6. Si `!org.isActive` → `redirect("/organizations")`.
7. `if (!hasRole(membership.role, minRole)) throw new ForbiddenError(...)`.
8. Devuelve `{ org, user, role: membership.role, db: tenantDb(org.id) }`, memoizado con `cache()` de React (una resolución por request, aunque la llamen 12 componentes).

### 4.2 Dónde vive la organización activa: cookie firmada `active_org`

**Decisión: cookie firmada `active_org` (HttpOnly, `SameSite=Lax`, `Secure` en producción, `Path=/`, prefijo `taxhacker.` para alinear con `advanced.cookiePrefix`), con HMAC-SHA256 sobre `orgId + userId` usando `BETTER_AUTH_SECRET`.** No un campo en `Session`.

Justificación (los tres puntos son propiedades reales de esta instalación, no preferencias):

- `lib/auth.ts` configura `session.strategy: "jwt"` **y** `session.cookieCache.enabled` con `maxAge` de 365 días. Con caché de cookie, la sesión que lee `auth.api.getSession()` sale de la cookie firmada, no de la fila `sessions`. Un campo `Session.activeOrganizationId` escrito en BD **no se vería** hasta que la caché expirase o se forzase un refresco: el switcher aparentaría no funcionar. Habría que invalidar la caché en cada cambio, es decir, reconstruir la sesión — más caro y más frágil que una cookie propia.
- El cambio de organización es una acción de UI frecuente (varias veces por sesión en un despacho). Una cookie evita un `UPDATE sessions` por cada switch.
- La cookie es un **hint**, no una credencial: `requireOrg` siempre consulta `Membership`. Aunque un atacante forjara la cookie (necesitaría el secreto), sin membresía no obtiene nada. La firma existe sólo para evitar que un `orgId` manipulado provoque enumeración por temporización o ruido en logs.
- Se incluye `userId` en el payload firmado para que la cookie no sobreviva a un cambio de usuario en el mismo navegador.

Descartado explícitamente: `?org=` en query params o path (`/[orgSlug]/...`). ADR-0002 lo prohíbe ("organización activa en sesión, nunca en query params") y además obligaría a reescribir todas las rutas heredadas. Descartado también el plugin `organization` de better-auth: aporta su propio esquema (`organization`, `member`, `invitation`) que **no** coincide con `docs/MODELO-DATOS.md` (sin `pgcVariant`, `baseCurrency`, `analyticsRequired`) y ataría la evolución del modelo contable a un paquete externo.

### 4.3 Server actions nuevas (`app/(app)/settings/organization/actions.ts`, `.../members/actions.ts`, `app/(app)/organizations/actions.ts`)

Todas con `ActionState<T>` (`lib/actions.ts`) y zod en `forms/organizations.ts` + `forms/memberships.ts`.

| Acción | Rol mínimo | Schema zod | Notas |
|---|---|---|---|
| `switchOrganizationAction(orgId)` | VIEWER | `z.object({ organizationId: z.string().uuid() })` | Verifica `Membership` antes de escribir la cookie; `revalidatePath("/", "layout")` |
| `createOrganizationAction(fd)` | — (usuario autenticado) | `name`, `taxId?`, `baseCurrency`, `timezone`, `pgcVariant` | Crea org + `Membership(ADMIN)` + defaults (`createOrganizationDefaults`) en una transacción |
| `updateOrganizationAction(fd)` | **ADMIN** | `name`, `taxId?`, `baseCurrency` (ISO-4217), `timezone` (IANA), `pgcVariant`, `business*` | `baseCurrency` se bloquea si `ledgerEnabled` y ya hay asientos (E3) |
| `inviteMemberAction(fd)` | **ADMIN** | `email` (lowercase), `role` | Genera token, guarda `sha256(token)`, envía email |
| `revokeInvitationAction(id)` | **ADMIN** | `uuid` | `status = REVOKED` |
| `resendInvitationAction(id)` | **ADMIN** | `uuid` | Rota el token (nuevo hash), reinicia `expiresAt` |
| `changeMemberRoleAction(fd)` | **ADMIN** | `membershipId`, `role` | **Invariante: no puede quedar la organización sin ADMIN** |
| `removeMemberAction(id)` | **ADMIN** | `uuid` | Idem; un ADMIN no puede eliminarse a sí mismo si es el último |
| `acceptInvitationAction(token)` | — (autenticado) | `z.string().length(64)` | Compara `sha256(token)`; exige que el email de la sesión coincida |
| `leaveOrganizationAction()` | VIEWER | — | Bloqueada si es el último ADMIN |

### 4.4 Refactor del patrón `getCurrentUser()` → `requireOrg(minRole)`

Grep real: **`getCurrentUser` aparece en 30 ficheros / 47 llamadas**. Clasificación y rol mínimo propuesto:

**Server actions (rol ≥ EDITOR salvo indicación) — 8 ficheros**

| Fichero | Llamadas | Rol destino |
|---|---|---|
| `app/(app)/transactions/actions.ts` | 7 (líneas 36, 78, 101, 124, 155, 228, 240) | EDITOR (crear/editar/borrar/bulk) |
| `app/(app)/unsorted/actions.ts` | 3 (32, 100, 115) | EDITOR |
| `app/(app)/files/actions.ts` | 1 (11) | EDITOR |
| `app/(app)/settings/actions.ts` | 2 (33 `saveSettingsAction`, 75 `saveProfileAction`) | **ADMIN** para settings de org y LLM; el bloque de perfil (nombre/avatar) se separa a `updateProfileAction` sin `requireOrg` (dato del usuario, no de la org) |
| `app/(app)/settings/backups/actions.ts` | 3 (26, 168, 183) | **ADMIN** (backup = volcado íntegro del tenant) |
| `app/(app)/apps/email/actions.ts` | 5 (24, 57, 92, 118, 156) | ADMIN para configurar la cuenta IMAP, EDITOR para lanzar sync |
| `app/(app)/apps/invoices/actions.ts` | 1 (66) | EDITOR |
| `app/(app)/import/csv/actions.tsx` | 1 (50) | EDITOR |

**RSC / páginas y layouts (rol VIEWER) — 13 ficheros**
`app/(app)/layout.tsx:34` (además: pasa `org` + `role` al `AppSidebar` y monta el switcher), `app/(app)/dashboard/page.tsx:20`, `app/(app)/transactions/page.tsx:25`, `app/(app)/transactions/[transactionId]/{layout,page}.tsx`, `app/(app)/unsorted/page.tsx:27`, `app/(app)/import/csv/page.tsx:6`, `app/(app)/apps/email/page.tsx:39`, `app/(app)/apps/invoices/page.tsx:14`, `app/(app)/settings/{categories,currencies,fields,llm,projects}/page.tsx`, `app/(app)/settings/profile/page.tsx:6` (**se queda con `getCurrentUser`**: es perfil personal).

**Route handlers (VIEWER, salvo los de escritura) — 8 ficheros**
`app/(app)/export/transactions/route.ts:32`, `app/(app)/files/download/[fileId]/route.ts:10`, `app/(app)/files/preview/[fileId]/route.ts:14`, `app/(app)/files/static/[filename]/route.ts:9`, `app/(app)/settings/backups/data/route.ts:15` (ADMIN), `app/api/email/sync/route.ts:8,39` (EDITOR), `app/api/stripe/portal/route.ts:6` (**ADMIN**, y pasa a leer `org.stripeCustomerId`), `app/api/unsorted/analyze/route.ts` (EDITOR; usa `user.aiBalance` → `org.aiBalance`), `app/api/progress/[progressId]/route.ts` (VIEWER + comprobación de `userId` propio).

**Componentes servidor — 3 ficheros**
`components/dashboard/stats-widget.tsx:15`, `components/dashboard/welcome-widget.tsx:13`, `components/transactions/new.tsx:9`. Los tres pasan a `requireOrg("VIEWER")` y reciben `db` para consultar.

**Fuera del refactor:** `app/(auth)/actions.ts` y `app/landing/actions.ts` (no usan `getCurrentUser`; son pre-autenticación), `lib/auth.ts` (define la función).

**Forma canónica del refactor (ejemplo, `transactions/actions.ts`):**

```ts
// antes
const user = await getCurrentUser()
if (isSubscriptionExpired(user)) return { success: false, error: "Subscription expired" }
const transaction = await createTransaction(user.id, validated.data)

// después
const { org, user, db } = await requireOrg("EDITOR")
if (isSubscriptionExpired(org)) return { success: false, error: "Suscripción expirada" }
const transaction = await createTransaction(db, validated.data, { createdById: user.id })
```

y la firma de `models/` cambia de `(userId: string, ...)` a `(db: TenantClient, ...)`. Es una firma **más segura que `(orgId: string, ...)`**: hace imposible que un modelo reciba un `orgId` y por descuido use el `prisma` global. Modelos afectados (14): `models/{transactions,categories,projects,fields,files,currencies,settings,progress,apps,stats,defaults,backups,export_and_import}.ts` (+ `models/users.ts`, que **no** cambia).

**Bugs cross-tenant que este refactor cierra de paso** (G-08 de `docs/AUDITORIA-FIABILIDAD.md`): `models/export_and_import.ts:139` y `:157` hacen `prisma.project.findFirst({ where: { OR: [{code},{name}] } })` **sin filtro de usuario** — hoy un import de CSV puede engancharse al proyecto de otro usuario. Con `tenantDb` el filtro se inyecta y el bug desaparece por construcción; el test de fuga lo cubre explícitamente.

---

## 5. RLS (barrera 2)

### 5.1 Rol de conexión de Prisma — el punto que decide si RLS sirve de algo

En Supabase, el rol `postgres` del connection string por defecto **es superusuario a efectos prácticos y tiene `BYPASSRLS`**; además, el **propietario de una tabla ignora RLS** salvo que la tabla tenga `FORCE ROW LEVEL SECURITY`. Si Prisma se conecta como `postgres`, las políticas no se evalúan nunca y la barrera 2 es decorativa.

**Decisión:**

- **Migraciones** (`prisma migrate deploy`, `DIRECT_URL`): rol `postgres` (necesita DDL y `CREATE POLICY`). Las tablas quedan propiedad de `postgres`.
- **Runtime** (`DATABASE_URL`, pooler): rol dedicado **`app_runtime`**, `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT`, con sólo `SELECT, INSERT, UPDATE, DELETE` sobre las tablas de negocio y `USAGE` sobre `public` y `app`. No es propietario de nada ⇒ RLS **sí** se le aplica.
- `FORCE ROW LEVEL SECURITY` en todas las tablas de negocio de todos modos, para que ni una conexión accidental como `postgres` desde la app se salte las políticas.
- Las tablas de auth (`users`, `sessions`, `account`, `verification`) **no** llevan RLS: better-auth necesita leerlas antes de que exista organización activa. Se protegen por privilegios (el `app_runtime` las lee, nadie más).

```sql
-- 0014_rls_tenancy.sql  (migración SQL manual)
CREATE SCHEMA IF NOT EXISTS app;

-- Helper: NULL si no se ha fijado el GUC (no lanza gracias al segundo argumento).
CREATE OR REPLACE FUNCTION app.current_org() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.current_org', true), '')::uuid
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'settings','categories','projects','fields','files','transactions',
    'app_data','progress','memberships','invitations','organizations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- Tablas con organization_id NOT NULL (9 de negocio + memberships + invitations)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'settings','categories','projects','fields','files','transactions',
    'app_data','progress','memberships','invitations'
  ] LOOP
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (organization_id = app.current_org() OR app.current_org() IS NULL)
        WITH CHECK (organization_id = app.current_org())
    $f$, t);
  END LOOP;
END $$;

-- organizations: la fila propia
CREATE POLICY tenant_isolation ON organizations
  USING (id = app.current_org() OR app.current_org() IS NULL)
  WITH CHECK (id = app.current_org());

-- currencies: híbrida (catálogo global visible por todos, no modificable)
ALTER TABLE currencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE currencies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON currencies
  USING (organization_id IS NULL
         OR organization_id = app.current_org()
         OR app.current_org() IS NULL)
  WITH CHECK (organization_id = app.current_org());

GRANT USAGE ON SCHEMA public, app TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
```

Notas:

- `WITH CHECK` **no** lleva la cláusula de escape `OR app.current_org() IS NULL`: escribir sin organización fijada está prohibido siempre. Toda escritura pasa por `$tenantTransaction`, que fija el GUC.
- La cláusula de escape en `USING` es la deuda controlada de la §3.5 (decisión D-2): se retira en E3 con la migración `NNNN_rls_strict`.
- Políticas `FOR DELETE USING (false)` sobre diario y runs: pertenecen a E3/E6, no a E1 (aquí aún no existen esas tablas). E1 sólo deja el patrón montado.
- Antes de merge: `get_advisors(security)` sobre la branch de Supabase del PR, sin avisos nuevos (checklist de la skill `supabase-multitenant`).

---

## 6. Invitaciones

**Modelo de amenaza:** el token es una credencial de un solo uso que concede acceso a datos contables. Nunca se persiste en claro (una filtración de BD no debe conceder acceso), nunca viaja en el `Referer` (se entrega por path, no por query) y caduca.

**Flujo:**

1. **Emitir** (`inviteMemberAction`, ADMIN): `token = base64url(randomBytes(32))` (43 chars) → `tokenHash = sha256(token)` hex. Se persiste `Invitation{ organizationId, email: lower, role, tokenHash, status: PENDING, invitedById, expiresAt: now + 7d }`. Si el email ya tiene `Membership` en la org → error "ya es miembro". Si ya hay una `PENDING` → se rota (revoca la anterior, crea nueva) gracias al índice parcial único.
2. **Email** (`lib/email.ts`, Resend — mismo patrón que `sendOTPCodeEmail`): nueva función `sendOrganizationInviteEmail({ email, orgName, inviterName, role, token })` + plantilla React en `components/emails/organization-invite-email.tsx` (junto a `otp-email.tsx` y `newsletter-welcome-email.tsx`). Enlace: `${config.app.baseURL}/invitations/${token}` — **path, no query**, para que el token no acabe en logs de proxy ni en `Referer` hacia terceros. Texto en español; asunto `«{inviterName} te invita a {orgName} en …»`.
3. **Aceptar** (`/invitations/[token]/page.tsx` → `acceptInvitationAction`): busca por `tokenHash` (índice único; el token en claro nunca toca la BD). Valida en orden: existe · `status = PENDING` · `expiresAt > now` (si no, `status = EXPIRED` y mensaje) · hay sesión (si no, `redirect(/enter?next=/invitations/<token>)`) · **`session.user.email === invitation.email`** (si no, pantalla "esta invitación es para otra dirección"). En una transacción: `Membership.create({ organizationId, userId, role, invitedById, acceptedAt: now })` + `Invitation.update({ status: ACCEPTED, acceptedAt, acceptedById })` + cookie `active_org` apuntando a la nueva org. Idempotente: si ya existe la membresía, sólo marca la invitación.
4. **Usuario sin cuenta:** el enlace lleva a `/enter` (better-auth `emailOTP`) y vuelve. Ojo: `emailOTP` está configurado con `disableSignUp: config.auth.disableSignup`, y `sendVerificationOTP` **lanza `NOT_FOUND` si el usuario no existe** (`lib/auth.ts`). Para que una invitación pueda crear cuenta, `acceptInvitationAction` necesita un camino de alta: se añade a `models/users.ts` un `getOrCreateInvitedUser(email)` invocado **sólo** cuando existe una invitación PENDING válida para ese email. Es el único punto que salta `disableSignup`, y está justificado: la invitación **es** la autorización de alta. (Ver D-3, requiere validación de producto.)
5. **Revocar / reenviar** (ADMIN): `REVOKED` es terminal; reenviar rota el token.
6. **Limpieza:** las `PENDING` caducadas se marcan `EXPIRED` de forma perezosa al listarlas (no hace falta cron en E1).

---

## 7. UI

### 7.1 Switcher de organización — `components/sidebar/org-switcher.tsx`

Sustituye al bloque `SidebarHeader` de `components/sidebar/sidebar.tsx:82-92` (hoy: logo + nombre/email del usuario). Patrón shadcn `SidebarMenuButton size="lg"` + `DropdownMenu` (ya en `components/ui/`, usado por `sidebar-user.tsx`):

- Cabecera: avatar/inicial de la organización, `org.name`, subtítulo `org.taxId ?? org.baseCurrency`.
- Menú: lista de organizaciones del usuario (de `getUserMemberships(user.id)`, resuelto en `app/(app)/layout.tsx` y pasado como prop — el sidebar es `"use client"` y no debe consultar), con badge de rol; separador; "Crear organización" → `/organizations/new`; "Miembros" (sólo ADMIN) → `/settings/members`.
- Al seleccionar: `switchOrganizationAction(orgId)` → cookie → `revalidatePath("/", "layout")`. Estado de carga: item con spinner y menú deshabilitado. Error: `toast.error` (sonner, ya montado en el layout).
- Colapsado (`collapsible="icon"`): sólo la inicial, tooltip con el nombre.
- El identificador de usuario (hoy en la cabecera) se mueve al pie, junto a `SidebarUser`, que ya existe.

### 7.2 `/settings/organization` (ADMIN edita, VIEWER/EDITOR ven en sólo lectura)

Formulario único (patrón `components/settings/*-form.tsx` + `useActionState`): **Nombre**, **NIF/CIF** (`taxId`), **Moneda base** (select ISO-4217 desde `Currency` globales; deshabilitado con explicación si ya hay asientos — E3), **Zona horaria** (select IANA, default `Europe/Madrid`), **Variante PGC** (`GENERAL | PYMES`, radio con ayuda: "PYMES es el plan abreviado; GENERAL incluye los grupos 8 y 9"), **Datos de facturación** (business name/address/bank details/logo, migrados desde el perfil). Zona de peligro (ADMIN): "Desactivar organización" (`isActive = false`, no borra nada — regla "nada se borra").

### 7.3 `/settings/members` (ADMIN)

- **Tabla de miembros:** avatar, nombre, email, rol (`Select` inline → `changeMemberRoleAction`), "miembro desde" (`acceptedAt`), acción "Quitar" (`AlertDialog` de confirmación). El último ADMIN aparece con el select y el botón deshabilitados y tooltip "La organización debe conservar al menos un administrador".
- **Tabla de invitaciones pendientes:** email, rol, invitado por, caduca en, acciones "Reenviar" / "Revocar".
- **Formulario de invitación:** email + rol + botón. Feedback con `toast`.
- **Qué ve cada rol:** `VIEWER` y `EDITOR` **no ven la entrada "Miembros"** en el sidebar y reciben `notFound()` en la ruta (no un 403 con contenido: no se filtra ni la existencia de la lista). Autorización siempre en servidor (`requireOrg("ADMIN")`); `can(role, action)` sólo decide el render.

**Matriz de visibilidad (E1)** — coherente con la tabla de la skill `supabase-multitenant`:

| Elemento | VIEWER | EDITOR | ADMIN |
|---|:--:|:--:|:--:|
| Switcher, dashboard, transacciones, unsorted (lectura) | ✓ | ✓ | ✓ |
| Botón "Upload", crear/editar/borrar transacción, import CSV, analizar con IA | | ✓ | ✓ |
| `/settings/{categories,projects,fields,currencies}` (edición) | | ✓ | ✓ |
| `/settings/organization` (edición), `/settings/members`, `/settings/llm`, `/settings/backups` | | | ✓ |
| `/settings/profile` (personal) | ✓ | ✓ | ✓ |

Para `VIEWER` el `UploadButton` del sidebar y el `ScreenDropArea` se ocultan (props `canEdit` desde el layout).

### 7.4 `/invitations/[token]` y `/organizations`

- `/invitations/[token]`: página pública. Estados: **válida** (tarjeta "Te han invitado a *{org}* como *{rol}*" + botón "Aceptar"), **caducada**, **revocada/usada**, **email distinto** (indica con qué dirección debe entrar, sin revelar la invitada completa), **sin sesión** (botón "Entrar y aceptar" → `/enter?next=…`).
- `/organizations`: listado cuando el usuario tiene 0 organizaciones activas o llega desde un switch inválido. `/organizations/new`: alta (nombre, NIF, moneda, zona horaria, variante PGC) → crea org + membresía ADMIN + defaults.

---

## 8. Trazabilidad, invariantes, criterios de aceptación y plan

### 8.1 Trazabilidad (provenance de E1)

E1 no genera cifras, pero sí decisiones de acceso. Se registra: `Membership{ invitedById, acceptedAt, createdAt, updatedAt }`, `Invitation{ invitedById, acceptedById, acceptedAt, revokedAt, tokenHash }` (nunca el token), `File.uploadedById`, `Transaction.createdById`. **`AuditLog` es de E2** (así lo fija el ROADMAP); E1 deja las acciones sensibles (`changeMemberRole`, `removeMember`, `updateOrganization`, `inviteMember`) con un `TODO(E2): auditLog(...)` en el mismo punto donde se insertará, para que E2 sea un diff mecánico. Cada tarea cerrada añade su línea a `runs/registro.jsonl`.

### 8.2 Invariantes afectados

| Inv. | Enunciado (skill `fiabilidad`) | Qué introduce E1 | Test |
|---|---|---|---|
| **I7** | Unicidad `(organizationId, code)` | Sustituye los uniques `(userId, code)` en 5 tablas | `tests/integration/tenancy.test.ts::uniques` — dos organizaciones pueden tener el mismo `code`; la misma organización no |
| **I10** | Tenant: nada apunta a otra organización | Es *el* invariante de la épica: `tenantDb` + FK compuestas + RLS | `tests/integration/tenant-leak.test.ts` (obligatorio en CI por ADR-0002) |

`lib/ledger/invariants.test.ts` **no** se toca en E1 (I1–I6, I8, I9 requieren diario: E3). Se crea el fichero `tests/integration/tenant-leak.test.ts` como raíz de la verificación de I10, que E3 extenderá a `journal_lines`.

### 8.3 Tests

**Unitarios (vitest, sin BD) — `include` actual es `lib/**/*.test.ts` y `forms/**/*.test.ts`, encaja sin tocar `vitest.config.ts`:**

- `lib/authz.test.ts` — jerarquía: `hasRole(r, m)` para las 9 combinaciones (`VIEWER<EDITOR<ADMIN`; `hasRole("EDITOR","ADMIN") === false`, `hasRole("ADMIN","VIEWER") === true`, reflexividad); `can(role, action)` para la matriz de la §7.3; que `ROLE_RANK` cubre exhaustivamente el enum `Role` (test de exhaustividad que falla al añadir un rol nuevo sin actualizar la tabla).
- `lib/db.tenant.test.ts` — **con mock de Prisma** (objeto que registra los `args` recibidos y devuelve `[]`), verifica para los 10 modelos y las 14 operaciones que: (a) `where` sale con `AND organizationId`; (b) `create`/`createMany` inyectan `data.organizationId`; (c) `create` con `organizationId` ajeno **lanza**; (d) `findUnique` se convierte en `findFirst`; (e) `upsert` protege `where` y `create`; (f) un `where` compuesto `{ organizationId_code: { organizationId: "OTRA", code } }` produce una condición insatisfacible y no una consulta a "OTRA"; (g) `Currency` lee híbrido y escribe estricto; (h) `User`/`Session`/`Account`/`Verification` pasan sin tocar.
- `forms/organizations.test.ts`, `forms/memberships.test.ts` — zod: slug, ISO-4217, IANA, email lowercase, rol válido.

**Integración (requiere `DATABASE_URL`; script `test:integration` — dependencia de E0, ver R6). Si no hay `DATABASE_URL`, `describe.skip` con aviso, mismo patrón que `getSelfHostedUser`:**

- `tests/integration/tenant-leak.test.ts` — **el test obligatorio de ADR-0002**. Fixture: orgs A y B, cada una con settings, categorías, proyectos, campos, ficheros, transacciones, monedas propias y una moneda global compartida. Asserts:
  1. `tenantDb(A).transaction.findMany()` no devuelve ninguna fila de B, en las 10 tablas.
  2. `tenantDb(A).transaction.findUnique({ where: { id: idDeB } })` → `null`; `findUniqueOrThrow` → lanza.
  3. `tenantDb(A).setting.upsert({ where: { organizationId_code: { organizationId: B, code: "x" } }, ... })` **no** modifica la fila de B (regresión del bug de la §3.3).
  4. `tenantDb(A).transaction.updateMany({ data })` afecta 0 filas de B; `deleteMany` idem.
  5. `tenantDb(A).transaction.create({ data: { organizationId: B } })` lanza.
  6. `importProject(db_A, "Proyecto de B")` **crea** uno nuevo en A y no engancha el de B (regresión G-08).
  7. Intento de crear en A una `Transaction` con `categoryCode` existente sólo en B → error de FK (garantía de BD, no de app).
  8. **RLS:** conectando como `app_runtime` fuera de la app, `SELECT set_config('app.current_org', A, true); SELECT count(*) FROM transactions;` = sólo filas de A, y `INSERT` con `organization_id = B` es rechazado por `WITH CHECK`.
- `tests/integration/authz.test.ts` — `requireOrg` con cookie ausente / firmada mal / de una org sin membresía / de un rol insuficiente; último-ADMIN no removible; aceptación de invitación caducada, revocada, de otro email, y doble aceptación (idempotente).
- `tests/integration/migration.test.ts` — **migración sobre fixture de datos TaxHacker**. `tests/fixtures/taxhacker-pre-e1.sql` (hoy `tests/fixtures/` sólo tiene `.gitkeep`): volcado de una BD en el estado `20250523104130_split_tx_items` con 3 usuarios, uno de ellos con transacciones que referencian categorías y proyectos con **el mismo `code` que otro usuario** (caso que rompería un unique mal migrado), monedas globales y de usuario, `app_data` y `progress`. El test: restaura el fixture → aplica 0011, 0012, 0013 → verifica (a) `count(organizations) == count(users)`, (b) `count(memberships where role='ADMIN') == count(users)`, (c) para cada tabla, conteo por organización **idéntico** al conteo previo por usuario, (d) 0 filas con `organization_id IS NULL` (salvo monedas globales), (e) toda `transaction.categoryCode` no nulo resuelve a una categoría de su propia organización, (f) `business_*` y `stripe_customer_id` de cada org coinciden con los del usuario original, (g) el paso 2 es idempotente (aplicarlo dos veces no duplica organizaciones ni membresías).

### 8.4 Criterios de aceptación (Given/When/Then)

- **CA-1 (migración).** *Dado* el fixture TaxHacker con 3 usuarios y datos solapados en `code`, *cuando* se aplican 0011→0013, *entonces* existen 3 organizaciones personales con 3 membresías ADMIN, ninguna tabla tiene `organization_id` nulo (salvo monedas globales) y los conteos por tabla coinciden 1:1 con los previos por usuario.
- **CA-2 (aislamiento app).** *Dado* usuario U con membresía sólo en A, *cuando* fuerza la cookie `active_org` a B (firmada con el secreto), *entonces* `requireOrg` la descarta, la borra y resuelve A; y ninguna consulta llega a tocar datos de B.
- **CA-3 (fuga por id).** *Dado* el id de una transacción de B, *cuando* U (miembro de A) navega a `/transactions/<id>`, *entonces* obtiene 404, no 500 ni el contenido.
- **CA-4 (aislamiento BD).** *Dado* el rol `app_runtime`, *cuando* se fija `app.current_org = A` y se consulta cualquier tabla de negocio, *entonces* no aparece ninguna fila de B; y un `INSERT` con `organization_id = B` es rechazado.
- **CA-5 (roles).** *Dado* un `VIEWER`, *cuando* invoca directamente `saveSettingsAction` o `changeMemberRoleAction` (sin pasar por UI), *entonces* la acción falla con error de permiso y no escribe nada; y `/settings/members` devuelve 404.
- **CA-6 (último ADMIN).** *Dado* una organización con un solo ADMIN, *cuando* este intenta degradarse a EDITOR, quitarse o abandonar, *entonces* la acción falla con "la organización debe conservar al menos un administrador" y la membresía queda intacta.
- **CA-7 (invitación).** *Dado* un ADMIN que invita a `x@y.com` como EDITOR, *cuando* el destinatario abre el enlace, entra con ese email y acepta, *entonces* obtiene `Membership(EDITOR)` aceptada, la invitación queda `ACCEPTED`, la organización pasa a ser la activa, y el mismo enlace usado de nuevo no crea nada.
- **CA-8 (invitación indebida).** *Dado* un token caducado, revocado o abierto por otro email, *entonces* no se crea membresía y el mensaje no revela datos de la organización más allá del nombre.
- **CA-9 (switcher).** *Dado* U con membresías en A y B, *cuando* cambia a B en el switcher, *entonces* todas las páginas (dashboard, transacciones, settings) muestran datos de B tras un único `revalidatePath`, sin recargar sesión ni volver a autenticarse.
- **CA-10 (no regresión).** `npm run lint && npm run test` en verde; la regla `no-restricted-imports` falla si alguien importa `prisma` en `models/` de negocio o en `app/`.

### 8.5 Plan de tareas atómicas

Nivel 1 = se implementa y se notifica · Nivel 2 = requiere ADR firmado (ADR-0002 ya está APROBADO, cubre T3, T4 y T7; sólo D-2 de la §9 abre un ADR-0007 si se decide RLS estricta ya).

| ID | Tarea | Depende de | Nivel | Horas |
|---|---|---|---|---|
| **T1** | Esquema Prisma: `Organization`, `Membership`, `Invitation`, enums, `organizationId` en las 9 tablas, uniques/índices/FK compuestas; migración **0011** (aditiva nullable) | — | 2 | 4 |
| **T2** | Migración **0012** de backfill (SQL, idempotente, con verificación) + `tests/fixtures/taxhacker-pre-e1.sql` | T1 | 2 | 5 |
| **T3** | Migración **0013** de refuerzo: NOT NULL, uniques nuevos, FK compuestas, renombrado/drop de `user_id`, drop de columnas de `users`, índices parciales | T2 | 2 | 4 |
| **T4** | `tenantDb(orgId)` en `lib/db.ts`: extensión, `flattenUniqueWhere`, `withOrg`, `$tenantTransaction` con `set_config`, memoización por request | T1 | 2 | 8 |
| **T5** | `lib/db.tenant.test.ts` (mock de Prisma, 8 grupos de asserts de la §8.3) | T4 | 1 | 5 |
| **T6** | `lib/authz.ts`: `ROLE_RANK`, `hasRole`, `can`, `requireOrg`, `getOrgContext`, cookie firmada `active_org` (HMAC), `ForbiddenError` + `lib/authz.test.ts` | T1 | 2 | 6 |
| **T7** | Migración **0014** RLS: schema `app`, `app.current_org()`, políticas, `FORCE`, rol `app_runtime` + GRANTs; documentar `DATABASE_URL`/`DIRECT_URL` en `.env.example` y `docs/self-hosted-public-access.md` | T3 | 2 | 5 |
| **T8** | `models/organizations.ts`, `models/memberships.ts`, `models/invitations.ts` + `createOrganizationDefaults` (refactor de `models/defaults.ts` de user a org) + `getOrCreateSelfHostedUser` con org local | T4, T6 | 1 | 5 |
| **T9** | Refactor de los 14 `models/` de negocio: firma `(db: TenantClient, …)`; corrección de G-08 en `export_and_import.ts`; `models/backups.ts` por organización | T4, T8 | 1 | 8 |
| **T10** | Refactor de las 8 server actions + 8 route handlers + 13 RSC + 3 componentes servidor a `requireOrg(minRole)` (tabla §4.4); regla ESLint `no-restricted-imports` | T6, T9 | 1 | 10 |
| **T11** | Traslado de facturación/negocio a `Organization` en el código: `UserProfile`, `isSubscriptionExpired`/`isAiBalanceExhausted`, Stripe (webhook, portal, success, `subscription-plan`), `lib/uploads.ts`/`lib/files.ts` (cuota y rutas), plantillas de factura | T3, T10 | 1 | 6 |
| **T12** | UI switcher: `components/sidebar/org-switcher.tsx`, cambios en `sidebar.tsx` y `app/(app)/layout.tsx` (pasa `org`, `role`, `memberships`, `canEdit`), ocultar acciones a VIEWER | T6, T10 | 1 | 6 |
| **T13** | UI `settings/organization` + `settings/members` + `organizations/new` + `organizations` + `forms/organizations.ts`/`forms/memberships.ts` + sus actions | T8, T12 | 1 | 10 |
| **T14** | Invitaciones: `sendOrganizationInviteEmail` en `lib/email.ts`, plantilla `components/emails/organization-invite-email.tsx`, `/invitations/[token]`, `acceptInvitationAction`, `getOrCreateInvitedUser` | T8, T13 | 1 | 7 |
| **T15** | `tests/integration/{tenant-leak,authz,migration}.test.ts` + script `test:integration` en CI (coordinar con E0) | T5, T7, T10, T14 | 1 | 10 |
| **T16** | Documentación: actualizar `docs/MODELO-DATOS.md` (§Heredado), `.claude/skills/codebase-taxhacker/SKILL.md` (patrón `requireOrg`), `CLAUDE.md` si cambia el comando de seed; marcar E1 `CERRADA` en `docs/ROADMAP.md`; `runs/registro.jsonl` | T15 | 1 | 3 |

**Total: 102 h** (~13 jornadas). Camino crítico: T1 → T2 → T3 → T7 → T15 (28 h) y T1 → T4 → T6 → T10 → T13 → T14 → T15 (61 h). T4/T6 y T12/T13 admiten paralelismo backend/frontend. La estimación de ADR-0002 ("~2 días" para la migración de datos) se refiere sólo a T1+T2+T3 = 13 h ≈ 1,6 jornadas: coherente.

---

## 9. Riesgos, decisiones humanas pendientes y alternativas descartadas

### 9.1 Riesgos

- **R1 — La migración 0013 es irreversible.** Elimina 10 columnas de `users`. *Mitigación:* `pg_dump` previo obligatorio; despliegue en dos releases (0011+0012 con el código antiguo aún funcionando, 0013 después); `tests/integration/migration.test.ts` sobre fixture ejecutado en CI antes de cada despliegue.
- **R2 — Olvidar el filtro de tenant en una query nueva.** *Mitigación en tres capas:* regla ESLint `no-restricted-imports`, RLS (segunda barrera), y el tenant leak test en CI. Aun así, un `$queryRaw` a mano se salta la extensión: **todo `$queryRaw` debe ir dentro de `$tenantTransaction`** y llevar `organization_id = $1` explícito; se añade al checklist de `revisor-codigo`.
- **R3 — Pérdida de batching de `findUnique`.** Puede degradar listados que resuelvan relaciones en bucle. *Mitigación:* `include`/`select` explícitos; medir el dashboard y `/transactions` antes/después con el log de queries que `lib/db.ts` ya tiene activado.
- **R4 — Cuota y plan cambian de sujeto.** Un usuario cloud con datos y saldo IA pasa a tener ese saldo en su organización personal; si luego crea una segunda organización, esta nace con `aiBalance = 0`. Es el comportamiento correcto pero **sorprende**: requiere copy en la UI y aviso en el changelog (coordinar con E11).
- **R5 — Deuda de snake_case.** Las columnas heredadas (`llm_prompt`, `code`, `name`, `total`…) no llevan `@map`; el SQL de E3+ debe consultar los nombres reales, no asumir snake_case. Se documenta en `docs/MODELO-DATOS.md`.
- **R6 — Dependencia de E0.** `test:integration` y el CI que ejecuta el tenant leak test son tareas de E0 marcadas EN CURSO. Si E0 no las entrega, T15 queda a medias y ADR-0002 incumplido ("test obligatorio en CI"). *Mitigación:* T15 incluye el script; el CI lo consume.
- **R7 — Self-hosted.** El modo self-hosted no tiene sesión real (`getSelfHostedUser`); `requireOrg` debe devolver siempre la organización local con rol ADMIN, y el switcher ocultarse. Fácil de olvidar y de romper (`config.selfHosted.isEnabled` aparece en 8 sitios).

### 9.2 Decisiones que requieren humano

- **D-1 — ¿Se mueven `stripeCustomerId`/`membershipPlan`/cuotas a `Organization` ya en E1, o se pospone a E11?** Recomendación del arquitecto: **ahora** (§2.3). Posponerlo significa migrar suscripciones Stripe vivas más adelante, que es estrictamente peor. Impacto si se pospone: T11 desaparece de E1 (−6 h) y el modelo queda con facturación por usuario durante 6 épicas.
- **D-2 — RLS estricta desde E1 o cláusula de escape `OR app.current_org() IS NULL` hasta E3** (§3.5, §5). Estricta obliga a envolver **toda** lectura en transacción explícita (coste de rendimiento y refactor mayor en T9/T10); la escape deja RLS efectiva sólo para escrituras y accesos externos durante 2 épicas. Si se elige estricta, abrir `docs/adr/0007-rls-estricta.md`.
- **D-3 — ¿Una invitación puede crear cuenta cuando `DISABLE_SIGNUP=true`?** (§6.4). Recomendación: sí, la invitación es la autorización; pero es una decisión de producto/seguridad, no de arquitectura.
- **D-4 — Caducidad de invitaciones: 7 días propuestos.** Confirmar.
- **D-5 — Datos contables:** ninguno en E1. (Si al definir `baseCurrency` bloqueada por existencia de asientos surge duda sobre el tratamiento de multi-moneda en la organización → **consultar experto-contable** en E3.)

### 9.3 Alternativas descartadas

- **Un schema Postgres por organización.** Aislamiento perfecto y RLS innecesaria, pero multiplica las migraciones por el número de clientes y Prisma no lo soporta bien (un cliente por schema). Ya descartada en ADR-0002.
- **Plugin `organization` de better-auth.** Resolvería switcher e invitaciones "gratis", pero impone su propio esquema (`organization`/`member`/`invitation`) incompatible con `docs/MODELO-DATOS.md` (faltan `pgcVariant`, `baseCurrency`, `timezone`, `analyticsRequired`, `reviewThresholds`) y ataría el modelo contable a la evolución de un paquete externo. Se reimplementa el mínimo (≈15 h de T13+T14) a cambio de control total.
- **Campo `activeOrganizationId` en `Session`.** Es lo que haría el plugin, pero con `session.strategy: "jwt"` + `cookieCache` de 365 días el valor de BD no se refleja hasta refrescar la sesión, y el switcher aparentaría fallar (§4.2).
- **Organización en la ruta (`/[orgSlug]/transactions`).** URLs compartibles y sin estado oculto, pero ADR-0002 prohíbe la organización fuera de la sesión y obligaría a reescribir las ~20 rutas heredadas y todos los `revalidatePath`/`Link`. Reconsiderable en v2.
- **Filtro por middleware en vez de extensión Prisma.** `prisma.$use` está deprecado en Prisma 7 en favor de `$extends`; además el middleware no puede reescribir la operación (`findUnique` → `findFirst`), que es justo lo que la §3.3 necesita.
- **Mantener `userId` junto a `organizationId` en las tablas de negocio como red de seguridad.** Duplica la fuente de verdad del aislamiento y hace ambiguo qué filtro manda; el primer bug de divergencia sería silencioso. Sólo se conserva donde la semántica es autoría (`created_by_id`, `uploaded_by_id`) o estado por usuario (`app_data`, `progress`).
