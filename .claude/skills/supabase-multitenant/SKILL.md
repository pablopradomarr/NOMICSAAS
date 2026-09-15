---
name: supabase-multitenant
description: Multi-tenancy y seguridad del ERP sobre Supabase Postgres con Prisma - organizaciones, membresías y roles (admin/editor/viewer), helper withTenant, RLS como segunda barrera, migraciones, branches de Supabase y checklist de fuga entre tenants. Úsala al crear tablas, server actions, migraciones, políticas RLS o al configurar entornos.
---

# Multi-tenant en Supabase + Prisma

## Modelo
```prisma
model Organization { id String @id @default(uuid()) @db.Uuid; slug String @unique; name String; baseCurrency String @default("EUR"); timezone String @default("Europe/Madrid"); pgcVariant PgcVariant @default(PYMES); ledgerEnabled Boolean @default(true); analyticsRequired Boolean @default(true); reviewThresholds Json?; memberships Membership[]; createdAt DateTime @default(now()) @@map("organizations") }  // esquema canónico: docs/MODELO-DATOS.md
model Membership { id String @id @default(uuid()) @db.Uuid; organizationId String @db.Uuid; userId String @db.Uuid; role Role; invitedBy String? @db.Uuid; acceptedAt DateTime?; @@unique([organizationId, userId]) }
enum Role { ADMIN EDITOR VIEWER }
```
Toda tabla de negocio: `organizationId String @db.Uuid` + índice compuesto `@@index([organizationId, ...])` + uniques compuestos `@@unique([organizationId, code])`.

## Permisos por rol (aplicados en server actions, `lib/authz.ts`)
| Acción | VIEWER | EDITOR | ADMIN |
|---|---|---|---|
| Ver informes, diario, auditoría, documentos | ✓ | ✓ | ✓ |
| Subir documentos, proponer/confirmar asientos, editar operaciones, liquidar CECOs | | ✓ | ✓ |
| Anular asientos, cerrar ejercicio/periodo | | ✓ (con motivo) | ✓ |
| Plan de cuentas, CECOs, LN, reglas de imputación, impuestos, mapeos de sistema | | | ✓ |
| Usuarios, roles, facturación, LLM keys, backups, borrar organización | | | ✓ |

Helper: `requireRole(orgId, userId, "EDITOR")` lanza si no cumple. Toda server action empieza por `const { org, user, role } = await requireOrg(minRole)`.

## Aislamiento en la app (barrera 1)
- `lib/db.ts` exporta `tenantDb(orgId)` = `prisma.$extends` que añade `where: { organizationId }` a `findMany/findFirst/update/delete/count/aggregate` y `data.organizationId` a `create` para todos los modelos con ese campo. Prohibido usar `prisma` directo en `models/` de negocio (lint rule `no-restricted-imports`).
- La organización activa viaja en la sesión (`activeOrganizationId`), cambiable en el switcher; nunca desde query params.

## RLS en Supabase (barrera 2, Nivel 2)
Prisma conecta como rol de servicio → RLS no filtra la app, pero protege accesos directos (dashboard SQL, PostgREST, futuros clientes). Política por tabla:
```sql
ALTER TABLE journal_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON journal_lines USING (organization_id = current_setting('app.current_org', true)::uuid);
```
Y la app ejecuta `SET LOCAL app.current_org = '<uuid>'` dentro de cada transacción (`tenantDb` lo hace en `$transaction`). Test: con `SET app.current_org` de A, `SELECT count(*)` de datos de B = 0.

## Integridad contable en BD (Nivel 2)
- Trigger `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` sobre `journal_lines` que al commit verifica Σdebit = Σcredit por `entry_id` → `RAISE EXCEPTION 'asiento descuadrado'`.
- `CHECK (debit_cents >= 0 AND credit_cents >= 0 AND (debit_cents = 0) <> (credit_cents = 0))`.
- FK compuesta `(organization_id, account_code) → accounts(organization_id, code)` para impedir cuentas de otra organización.
- `journal_entries`: sin `DELETE` (política RLS `FOR DELETE USING (false)`) — anulación por `voided_at` + contra-asiento.
- Secuencia de `entry_number` por `(organization_id, fiscal_year_id)` con `SELECT ... FOR UPDATE` sobre `fiscal_years`.

## Entornos
| Entorno | BD | Notas |
|---|---|---|
| Local | `docker compose` Postgres 17 | `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/erp` |
| Preview | Supabase branch por PR (`create_branch`) | migraciones con `apply_migration`; `get_advisors` para RLS/seguridad antes de merge |
| Producción | Supabase project | `DIRECT_URL` para migraciones, pooler para runtime |

Migraciones: Prisma es la fuente (`prisma/migrations`); RLS/triggers van en migraciones SQL manuales `NNNN_rls_*.sql` dentro de la carpeta de la migración Prisma. Nunca `prisma db push` en producción.

## La tabla nueva y la COPIA del cliente (E11)

Añadir una tabla de negocio son **dos** listas, no una, y la segunda es la que
cuatro épicas seguidas se olvidaron (BUG-E7-1, BUG-E9-5, BUG-E10-1 y el H-2 del
auditor de E11: `currencies`, 177 filas por organización, se perdía en cada
restauración **con las seis comprobaciones en PASS**):

1. `SELECT app.enforce_tenant_rls('<tabla>')` en la migración **y** el modelo en
   `TENANT_MODELS` (`lib/db.ts`) — la barrera 1. Sin esto, una consulta fuera de
   `tenantDb` no falla: **devuelve vacío**.
2. El **inventario del backup**, que se DERIVA de
   `BACKUP_TENANT_MODELS` = `TENANT_MODELS` ∪ `TENANT_MODELS_WITH_GLOBAL` −
   `PLATFORM_ONLY_TABLES`. Si la tabla es de lectura híbrida (nullable, como
   `Currency`) entra por la unión; si NO es dato del cliente, se declara en
   `PLATFORM_ONLY_TABLES` **con motivo escrito**.

**I-E11-7** no deja elegir: falla si aparece en el esquema cualquier tabla con
`organization_id` que no esté en el inventario ni declarada, si una exclusión
declarada ya no existe, si su motivo está en blanco, o si el cliente Prisma
generado y `information_schema` no dicen lo mismo. Y `--reset-org`
(`scripts/load-fixture.ts`) tiene su propio test que **deriva** la lista de
`TENANT_MODELS` y exige que toda tabla de tenant o se vacíe o esté en
`RESET_ORG_PRESERVED` con su razón.

### Lo que NO viaja en la copia, y por qué

`platform_audit_logs` (registro nuestro, con filas sin organización),
`platform_invoices` (serie correlativa **global**: duplicar `(serie, número)` al
restaurar falsifica nuestra numeración, art. 28.2 CCom), `subscriptions`
(`organization_id` UNIQUE y el destino nace con la suya) y `subscription_events`
(`stripe_event_id` UNIQUE global). Restaurar es **siempre a organización nueva**,
y una sola fila rechazada aborta el trabajo entero.

### Almacén de ficheros

Clave por `sha256` con **prefijo por organización**, y `assertKeyBelongsTo` como
segunda barrera en las tres puertas del driver (`putObject`, `getObjectBuffer`,
`deleteObject`): la RLS sobre `stored_objects` filtra la FILA, pero la CLAVE que
se le pasa al almacén también tiene que ser suya.

## Checklist antes de merge (revisor-codigo + qa-tester)
- [ ] Tabla nueva con `organizationId`, índices y uniques compuestos, RLS habilitada y política creada.
- [ ] Ningún `prisma.` directo en `models/` de negocio.
- [ ] Server action con `requireOrg(minRole)`.
- [ ] Tenant leak test verde. `get_advisors(security)` sin avisos nuevos.
- [ ] Modelo en `TENANT_MODELS` **y** cubierto por el inventario del backup (o declarado en `PLATFORM_ONLY_TABLES` con motivo). I-E11-7 en PASS.
- [ ] Si la tabla se llena en las pruebas: vaciada por `--reset-org` o declarada en `RESET_ORG_PRESERVED`.
