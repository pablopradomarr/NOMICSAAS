-- E1-fix · RLS EFECTIVA (hallazgos BLOQUEA-1, BLOQUEA-2 y PUEDE-21 de la
-- revisión E1). ADR-0002 + ADR-0007.
--
-- Qué cambia respecto a 20260904120300_e1_rls:
--   1. Nueva función `app.current_user()` (GUC `app.current_user`), gemela de
--      `app.current_org()`.
--   2. `organizations` y `memberships` dejan de aislarse por `app.current_org`
--      (insatisfacible al CREAR una organización: su id no se conoce antes del
--      INSERT) y pasan a aislarse por PERTENENCIA del usuario. Eso además hace
--      posible el switcher de organizaciones bajo RLS estricta (#21).
--   3. `FORCE ROW LEVEL SECURITY` en todas las tablas con política: sin él, el
--      propietario de la tabla ignora las políticas y la barrera 2 es inerte.
--   4. `app_runtime` recibe contraseña si no la tenía, para que exista un rol de
--      runtime SIN BYPASSRLS conectable desde `DATABASE_URL` (el rol de
--      migraciones, propietario, va en `DIRECT_URL`).
--
-- La cláusula de escape `OR app.current_org() IS NULL` se mantiene SÓLO en
-- USING, y sólo hasta E3 (ADR-0007). WITH CHECK nunca la lleva: escribir sin
-- organización fijada está prohibido siempre.
--
-- NOTA sobre los hallazgos #12 y #13 (DROP INDEX sin IF EXISTS y slug de 6 hex
-- en 20260904120200/20260904120100): esas migraciones YA ESTÁN APLICADAS en los
-- entornos existentes y CLAUDE.md prohíbe reescribir una migración aplicada
-- (rompería su checksum y `prisma migrate deploy`). Quedan anotadas como
-- desviación aceptada en docs/design/E1-organizaciones-roles.md §"Desviaciones
-- aceptadas"; el test tests/integration/migration.test.ts verifica que la
-- cadena completa se aplica sin error sobre un dump pre-E1.

CREATE SCHEMA IF NOT EXISTS app;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. app.current_user()
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.current_user() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $fn$
  SELECT NULLIF(current_setting('app.current_user', true), '')::uuid
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Rol de runtime: existe desde 20260904120300 pero sin contraseña, así que no
--    era conectable. En local la contraseña es `app_runtime`; en Supabase /
--    producción el rol se gestiona fuera y esta rama no se ejecuta.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT
      PASSWORD 'app_runtime';
  ELSIF NOT EXISTS (SELECT 1 FROM pg_authid WHERE rolname = 'app_runtime' AND rolpassword IS NOT NULL) THEN
    ALTER ROLE app_runtime WITH LOGIN NOBYPASSRLS PASSWORD 'app_runtime';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. organizations — pertenencia del usuario
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS tenant_isolation ON "organizations";

CREATE POLICY tenant_isolation ON "organizations"
  USING (
    CASE
      WHEN app.current_user() IS NOT NULL THEN
        "id" IN (SELECT m."organization_id" FROM "memberships" m WHERE m."user_id" = app.current_user())
      ELSE "id" = app.current_org() OR app.current_org() IS NULL
    END
  )
  WITH CHECK (
    -- Alta de organización: su id aún no puede coincidir con ningún GUC y la
    -- membresía se crea en la MISMA transacción, así que basta con que haya un
    -- usuario identificado. Actualizaciones: la organización activa.
    app.current_user() IS NOT NULL OR "id" = app.current_org()
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. memberships — las propias del usuario (switcher) y las de la organización
--    activa (pantalla de miembros)
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS tenant_isolation ON "memberships";

CREATE POLICY tenant_isolation ON "memberships"
  USING (
    "user_id" = app.current_user()
    OR "organization_id" = app.current_org()
    OR (app.current_user() IS NULL AND app.current_org() IS NULL)
  )
  WITH CHECK (
    "organization_id" = app.current_org()
    OR (app.current_user() IS NOT NULL AND "user_id" = app.current_user())
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. FORCE ROW LEVEL SECURITY en todas las tablas con política
--    (los superusuarios siguen ignorando RLS por diseño de Postgres; el rol de
--    runtime `app_runtime` no es superusuario ni propietario)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'settings','categories','projects','fields','files','transactions',
    'currencies','app_data','progress','memberships','invitations','organizations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Privilegios
-- ─────────────────────────────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT USAGE ON SCHEMA app TO app_runtime;
GRANT EXECUTE ON FUNCTION app.current_org() TO app_runtime;
GRANT EXECUTE ON FUNCTION app.current_user() TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
