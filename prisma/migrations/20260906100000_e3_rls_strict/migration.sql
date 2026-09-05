-- E3 · T3 — RLS ESTRICTA: retirada de la cláusula de escape y `FORCE` en todas
-- las tablas de negocio. ADR-0009 (APROBADO), diseño `docs/design/E3-libro-diario.md` §2.5.
--
-- Qué cambia:
--   1. Desaparece `OR app.current_org() IS NULL` del `USING` de las dieciséis
--      tablas de negocio de E1 y E2 (ADR-0007 fijó E3 como fecha de retirada).
--   2. Desaparece `OR app.current_user() IS NOT NULL` del `WITH CHECK` de
--      `organizations` y el escape doble-NULL de `organizations`/`memberships`.
--   3. `FORCE ROW LEVEL SECURITY` en las CUATRO tablas de E2 que aún no lo
--      tenían (las doce de E1 lo llevan desde 20260904140000). Consecuencia
--      buscada: `audit_logs` pasa a ser append-only también para el propietario.
--   4. Se consolidan los GRANT del rol `app_maintenance` (creado en
--      20260906090000_e3_rls_helpers) y se deja `app.enforce_tenant_rls()` para
--      que las tablas de negocio que nazcan después (E3 y siguientes) apliquen
--      el mismo patrón sin copiar SQL.
--
-- Requisito previo (T2, desplegado por separado): TODO acceso de negocio pasa
-- por `tenantDb` / `tenantTransaction` / `withTenantGucs`, y los tres accesos
-- que ninguna política puede autorizar (invitación por token, barrido del cron
-- de email, webhook de Stripe) van por las funciones `SECURITY DEFINER` de
-- 20260906090000. Sin ese refactor, esta migración deja la aplicación ciega.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- PATRÓN OBLIGATORIO PARA BACKFILLS FUTUROS (ADR-0009 §7, también en CLAUDE.md)
-- Con `FORCE`, el propietario deja de esquivar las políticas: una migración que
-- haga backfill de datos NO VERÁ NADA. El patrón es, dentro de la MISMA
-- migración (el DDL de Postgres es transaccional):
--
--     ALTER TABLE x NO FORCE ROW LEVEL SECURITY;
--     UPDATE x SET …;                 -- backfill
--     ALTER TABLE x FORCE ROW LEVEL SECURITY;
--
-- o ejecutar el backfill como `app_maintenance` (BYPASSRLS). El test
-- `tests/integration-rls/rls-strict.test.ts` falla si alguna tabla de negocio
-- queda en `NO FORCE` al final de la cadena de migraciones.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. Helper reutilizable: política estricta + ENABLE + FORCE sobre una tabla
--    con `organization_id NOT NULL`. Lo usan el bucle de abajo y las migraciones
--    de las tablas de negocio que nazcan después (E3 en adelante).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.enforce_tenant_rls(p_table text)
RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', p_table);
  EXECUTE format($f$CREATE POLICY tenant_isolation ON %I
                      USING (organization_id = app.current_org())
                      WITH CHECK (organization_id = app.current_org())$f$, p_table);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', p_table);
END
$fn$;
REVOKE ALL ON FUNCTION app.enforce_tenant_rls(text) FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Las trece tablas de organization_id NOT NULL de E1 + E2
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'settings','categories','projects','fields','files','transactions',
    'app_data','progress','invitations',
    'accounts','organization_account_maps','tax_rates','audit_logs'
  ] LOOP
    PERFORM app.enforce_tenant_rls(t);
  END LOOP;
END $$;

-- `audit_logs` vuelve a quedar inmutable: `enforce_tenant_rls` recreó la
-- política PERMISIVA, y las RESTRICTIVAS de ADR-0008 siguen ahí (no se tocaron),
-- pero se recrean por idempotencia con `IF NOT EXISTS` semántico.
DROP POLICY IF EXISTS audit_logs_no_update ON "audit_logs";
DROP POLICY IF EXISTS audit_logs_no_delete ON "audit_logs";
CREATE POLICY audit_logs_no_update ON "audit_logs" AS RESTRICTIVE FOR UPDATE USING (false);
CREATE POLICY audit_logs_no_delete ON "audit_logs" AS RESTRICTIVE FOR DELETE USING (false);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. currencies — híbrida: conserva el catálogo global (organization_id IS NULL)
--    y pierde el escape por GUC sin fijar.
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS tenant_isolation ON "currencies";
CREATE POLICY tenant_isolation ON "currencies"
  USING (organization_id IS NULL OR organization_id = app.current_org())
  WITH CHECK (organization_id = app.current_org());
ALTER TABLE "currencies" FORCE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. organizations — pertenencia. Se retiran las DOS deudas de ESTADO.md:
--    el escape doble-NULL del USING y `OR app.current_user() IS NOT NULL` del
--    WITH CHECK. El alta pasa por un único camino
--    (`createOrganizationWithOwner`) que genera el uuid y lo fija en
--    `app.current_org` ANTES del INSERT, así que `id = app.current_org()` es
--    suficiente y exacto (también para el `INSERT … RETURNING` de Prisma).
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS tenant_isolation ON "organizations";
CREATE POLICY tenant_isolation ON "organizations"
  USING (
    "id" = app.current_org()
    OR (
      app.current_user() IS NOT NULL
      AND "id" IN (SELECT m."organization_id" FROM "memberships" m WHERE m."user_id" = app.current_user())
    )
  )
  WITH CHECK ("id" = app.current_org());
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. memberships — las propias del usuario (switcher, `getUserMemberships`) y
--    las de la organización activa (pantalla de miembros). Sin escape doble-NULL.
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS tenant_isolation ON "memberships";
CREATE POLICY tenant_isolation ON "memberships"
  USING (
    "user_id" = app.current_user()
    OR "organization_id" = app.current_org()
  )
  WITH CHECK (
    "organization_id" = app.current_org()
    OR (app.current_user() IS NOT NULL AND "user_id" = app.current_user())
  );
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Privilegios (idempotentes). `app_maintenance` existe desde
--    20260906090000_e3_rls_helpers; aquí se consolidan sus GRANT por si la
--    migración anterior se aplicó antes de crear alguna tabla.
-- ─────────────────────────────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA public, app TO app_maintenance;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_maintenance;
GRANT EXECUTE ON FUNCTION app.current_org(), app.current_user() TO app_maintenance;
GRANT EXECUTE ON FUNCTION app.enforce_tenant_rls(text) TO app_maintenance;

GRANT USAGE ON SCHEMA public, app TO app_runtime;
GRANT EXECUTE ON FUNCTION app.current_org(), app.current_user() TO app_runtime;
-- `audit_logs` sigue sin UPDATE ni DELETE a nivel de privilegio (20260905120000).
REVOKE UPDATE, DELETE ON "audit_logs" FROM app_runtime;
