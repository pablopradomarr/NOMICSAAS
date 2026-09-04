# ADR-0007 — RLS estricta con cláusula de escape temporal hasta E3

**Estado:** APROBADO por Pablo el 2026-09-04 (permiso general delegado en la sesión de setup) · **Nivel:** 2 · **Fecha:** 2026-09-04

## Contexto
ADR-0002 exige RLS en Supabase con `current_setting('app.current_org')`. Envolver desde E1 toda lectura de la app en una transacción con `SET LOCAL` obliga a refactorizar 32 ficheros heredados de golpe y bloquea el sprint; sin embargo, no queremos aplazar la activación de RLS.

## Decisión
- RLS se **habilita en E1** en todas las tablas con `organization_id`, con política `USING (organization_id = app.current_org() OR app.current_org() IS NULL)`.
- La app conecta con un rol **sin BYPASSRLS** (`app_runtime`) desde E1; el rol de migraciones (`DIRECT_URL`) es el owner.
- `tenantDb(orgId)` fija `SET LOCAL app.current_org` en toda `$transaction`; las lecturas fuera de transacción quedan protegidas solo por la barrera 1 (filtro inyectado) hasta E3.
- En **E3** (libro diario) se retira la cláusula `OR app.current_org() IS NULL` en una migración propia (Nivel 2, ADR nuevo) tras verificar en CI que ninguna query de negocio corre fuera de transacción (lint `no-restricted-imports` + test de cobertura de tenant).
- Decisiones asociadas de E1: Stripe/plan/cuotas se mueven a `Organization` (D-1); una invitación puede crear cuenta aunque `DISABLE_SIGNUP=true` (D-3); invitaciones caducan a los 7 días (D-4).

## Alternativas descartadas
- RLS estricta ya: refactor masivo con riesgo de romper la app heredada antes de tener tests de integración.
- Sin RLS hasta E3: pierde la segunda barrera durante dos épicas.

## Consecuencias
Fuga cross-tenant durante E1–E2 solo posible si una query evita `tenantDb` (lint lo impide) Y no hay transacción. Deuda explícita con fecha de retirada (E3).
