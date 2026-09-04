# ADR-0002 — Multi-tenant por organización, `tenantDb` y RLS en Supabase

**Estado:** APROBADO por Pablo el 2026-09-04 · **Nivel:** 2 · **Fecha:** 2026-09-04

## Contexto
Requisitos R9/R10/R11: varias empresas por usuario, roles ADMIN/EDITOR/VIEWER, Supabase Postgres. TaxHacker aísla por `userId` y tiene una fuga cross-tenant conocida (G-08).

## Decisión
- `Organization` + `Membership(role)`; toda tabla de negocio con `organizationId`; uniques e índices compuestos.
- Barrera 1 (app): `tenantDb(orgId)` (extensión Prisma que inyecta el filtro) obligatoria en `models/`; `requireOrg(minRole)` en toda server action; organización activa en sesión, nunca en query params.
- Barrera 2 (BD): RLS en todas las tablas de negocio con `current_setting('app.current_org')`, fijado con `SET LOCAL` en cada transacción; políticas `FOR DELETE USING(false)` en diario y runs.
- Prisma como fuente de migraciones; RLS/triggers en SQL dentro de la carpeta de migración.
- Test obligatorio de fuga entre tenants en CI.

## Alternativas descartadas
- Un schema Postgres por organización: complica migraciones y Prisma; innecesario a la escala objetivo (cientos de organizaciones).
- Solo RLS con JWT de Supabase Auth: implicaría sustituir better-auth; se pospone (posible v2).

## Consecuencias
Migración de datos existentes: cada `User` de TaxHacker genera una `Organization` personal con rol ADMIN. Coste: ~2 días. Riesgo: olvidar el filtro en una query → mitigado por lint `no-restricted-imports` + RLS.
