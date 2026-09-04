---
name: supabase-multitenant
description: Multi-tenancy y seguridad del ERP sobre Supabase Postgres con Prisma - organizaciones, membresías y roles (admin/editor/viewer), helper withTenant, RLS como segunda barrera, migraciones, branches de Supabase y checklist de fuga entre tenants. Úsala al crear tablas, server actions, migraciones, políticas RLS o al configurar entornos.
---

# Multi-tenant en Supabase + Prisma

## Modelo
```prisma
model Organization { id String @id @default(uuid()) @db.Uuid; slug String @unique; name String; baseCurrency String @default("EUR"); timezone String @default("Europe/Madrid"); pgcVariant String @default("PYMES"); settings Json?; memberships Membership[]; createdAt DateTime @default(now()) }
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

## Checklist antes de merge (revisor-codigo + qa-tester)
- [ ] Tabla nueva con `organizationId`, índices y uniques compuestos, RLS habilitada y política creada.
- [ ] Ningún `prisma.` directo en `models/` de negocio.
- [ ] Server action con `requireOrg(minRole)`.
- [ ] Tenant leak test verde. `get_advisors(security)` sin avisos nuevos.
