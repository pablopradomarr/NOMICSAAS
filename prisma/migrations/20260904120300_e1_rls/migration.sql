-- E1 · Paso 4 — RLS (barrera 2). ADR-0002 + ADR-0007.
-- Política con cláusula de escape `OR app.current_org() IS NULL` en USING
-- (deuda con fecha de retirada: E3). WITH CHECK NO lleva escape: escribir sin
-- organización fijada está prohibido siempre.

CREATE SCHEMA IF NOT EXISTS app;

-- Helper: NULL si el GUC no está fijado (segundo argumento = missing_ok)
CREATE OR REPLACE FUNCTION app.current_org() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $fn$
  SELECT NULLIF(current_setting('app.current_org', true), '')::uuid
$fn$;

-- Rol de runtime sin BYPASSRLS y que no es propietario de ninguna tabla.
-- Se crea sólo si no existe (en Supabase puede existir ya, gestionado aparte).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
  END IF;
END $$;

-- ENABLE RLS en las tablas de negocio.
-- NOTA: FORCE ROW LEVEL SECURITY queda pendiente de T10. Con FORCE, el
-- propietario (rol de las migraciones y, hoy todavía, del runtime heredado)
-- también queda sujeto a WITH CHECK, y el código heredado aún no fija
-- app.current_org en sus escrituras. Se activa en la misma migración que
-- retire la cláusula de escape (E3).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'settings','categories','projects','fields','files','transactions',
    'currencies','app_data','progress','memberships','invitations','organizations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- Tablas con organization_id (NOT NULL)
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
CREATE POLICY tenant_isolation ON "organizations"
  USING (id = app.current_org() OR app.current_org() IS NULL)
  WITH CHECK (id = app.current_org());

-- currencies: híbrida (catálogo global legible por todas, no modificable)
CREATE POLICY tenant_isolation ON "currencies"
  USING (organization_id IS NULL
         OR organization_id = app.current_org()
         OR app.current_org() IS NULL)
  WITH CHECK (organization_id = app.current_org());

-- Privilegios del rol de runtime
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT USAGE ON SCHEMA app TO app_runtime;
GRANT EXECUTE ON FUNCTION app.current_org() TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
