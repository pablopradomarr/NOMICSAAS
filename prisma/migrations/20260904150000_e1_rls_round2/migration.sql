-- E1-fix · ronda 2 de revisión — hallazgos BLOQUEA-1 y DEBE-8.
--
-- 1) organizations: la política SELECT dejaba fuera la propia fila recién
--    insertada. Prisma NO hace `INSERT`, hace `INSERT … RETURNING`, y el
--    RETURNING se evalúa contra la política de SELECT (USING): al crear una
--    organización la membresía todavía no existe, así que
--    `id IN (SELECT organization_id FROM memberships WHERE user_id = …)` es
--    falso y `createOrganizationWithOwner` reventaba como `app_runtime` con
--    «new row violates row-level security policy». Se añade
--    `OR id = app.current_org()`: la aplicación genera el uuid de la
--    organización y fija AMBOS GUC antes del INSERT, de modo que el RETURNING
--    ve su propia fila sin abrir la tabla a nadie más.
--
-- 2) app_runtime: la migración anterior (20260904140000) fijaba una contraseña
--    LITERAL ('app_runtime'). Eso es aceptable en local y NO lo es en ningún
--    otro sitio: quedaba en el repositorio y en el historial de migraciones.
--    Aquí ya no se fija ninguna contraseña. El rol se crea, si falta, SIN LOGIN;
--    es el OPERADOR quien le da contraseña (o autenticación IAM en Supabase) y
--    quien debe ROTAR la que dejó la migración anterior en los entornos donde ya
--    se aplicó. En local lo hace `scripts/dev-db-setup.sh`, que lee
--    `APP_RUNTIME_PASSWORD` (por defecto `app_runtime`).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. organizations — la fila propia también es visible durante su creación
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS tenant_isolation ON "organizations";

CREATE POLICY tenant_isolation ON "organizations"
  USING (
    "id" = app.current_org()
    OR (
      app.current_user() IS NOT NULL
      AND "id" IN (SELECT m."organization_id" FROM "memberships" m WHERE m."user_id" = app.current_user())
    )
    OR (app.current_user() IS NULL AND app.current_org() IS NULL)
  )
  WITH CHECK (
    -- Alta: la aplicación genera el uuid y lo fija en app.current_org antes del
    -- INSERT, así que la comprobación es exacta. Se mantiene la variante por
    -- usuario para el alta hecha sin conocer el id de antemano.
    "id" = app.current_org()
    OR app.current_user() IS NOT NULL
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. app_runtime sin contraseña en el repositorio
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    -- NOLOGIN a propósito: el operador le da credencial fuera de la migración.
    CREATE ROLE app_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
  END IF;
  -- Invariante que sí debe garantizar la migración, exista ya el rol o no.
  EXECUTE 'ALTER ROLE app_runtime WITH NOBYPASSRLS NOSUPERUSER';
END $$;

GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT USAGE ON SCHEMA app TO app_runtime;
GRANT EXECUTE ON FUNCTION app.current_org() TO app_runtime;
GRANT EXECUTE ON FUNCTION app.current_user() TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
