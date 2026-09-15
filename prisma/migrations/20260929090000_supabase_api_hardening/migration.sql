-- Endurecimiento frente a la API automática de Supabase (PostgREST).
--
-- Contexto: en Supabase, los roles `anon` y `authenticated` reciben por defecto
-- TODOS los privilegios sobre cualquier tabla nueva de `public` (ALTER DEFAULT
-- PRIVILEGES de la plataforma). Esta aplicación NUNCA usa la API REST de
-- Supabase: conecta con `app_runtime` / `app_auth` / `app_maintenance` por
-- Postgres. Cualquier privilegio de `anon`/`authenticated` es, por tanto,
-- superficie de ataque pura (aviso «rls_disabled_in_public» y
-- «sensitive_columns_exposed» del 2026-09-13).
--
-- Qué hace (idempotente; ejecutable por el rol `postgres` de Supabase, no
-- superusuario; inocua en local/CI donde esos roles no existen):
--   1. Revoca a `anon` y `authenticated` todo privilegio presente y futuro sobre
--      los esquemas `public` y `app` (tablas, secuencias, funciones, USAGE).
--   2. Activa RLS en las cuatro tablas que quedaban sin ella (`_prisma_migrations`,
--      `sessions`, `account`, `verification`) con una política que sólo admite a
--      los roles de la aplicación. Sin FORCE en `_prisma_migrations`: su
--      propietario (`postgres`) la sigue gestionando; Prisma no cambia de rol.
--   3. Fija `search_path` en todas las funciones del esquema `app`
--      (aviso «function_search_path_mutable»).
-- No mueve `btree_gist` de esquema: la extensión la referencian índices EXCLUDE
-- aplicados y moverla exige superusuario en Supabase (deuda anotada, E12).

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA app FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA app FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM %I', r);
      EXECUTE format('REVOKE USAGE ON SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE USAGE ON SCHEMA app FROM %I', r);
      -- Privilegios por defecto de quien ejecuta las migraciones (postgres en
      -- Supabase): que las tablas futuras tampoco se concedan.
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- 2. RLS en las cuatro tablas restantes. Política de «sólo roles de la app».
DO $$
DECLARE
  t text;
  app_roles text := 'app_runtime, app_auth, app_maintenance';
BEGIN
  FOREACH t IN ARRAY ARRAY['sessions', 'account', 'verification'] LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_app_roles', t);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO %s USING (true) WITH CHECK (true)',
        t || '_app_roles', t, app_roles);
    END IF;
  END LOOP;
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public._prisma_migrations ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS prisma_migrations_app_roles ON public._prisma_migrations';
    EXECUTE format(
      'CREATE POLICY prisma_migrations_app_roles ON public._prisma_migrations FOR ALL TO %s USING (true) WITH CHECK (true)',
      app_roles);
  END IF;
END $$;

-- 3. search_path fijo en todas las funciones del esquema app.
DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app' AND p.prokind = 'f'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = app, public, pg_temp', f.sig);
  END LOOP;
END $$;

-- Verificación: ninguna tabla de public/app concede nada a anon/authenticated.
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n
  FROM information_schema.role_table_grants
  WHERE table_schema IN ('public', 'app') AND grantee IN ('anon', 'authenticated');
  IF n > 0 THEN
    RAISE EXCEPTION 'supabase_api_hardening: quedan % privilegios de anon/authenticated', n;
  END IF;
END $$;
