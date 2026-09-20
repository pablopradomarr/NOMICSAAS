-- =============================================================================
-- E12 · T21 — `supabase-bootstrap.sql`
-- Levantar una base **Supabase nueva** (preproducción, producción) sin
-- superusuario y **sin ninguna adaptación manual**.
-- =============================================================================
--
-- ## El problema que resuelve
--
-- `docs/deploy/DESPLIEGUE-PREVIEW.md` §4 documenta cuatro sentencias del
-- historial de migraciones que **no puede ejecutar el rol `postgres` de
-- Supabase** (`rolsuper = false`, `rolcreaterole = true`, `rolbypassrls = true`):
--
-- | Sentencia original | Migración | Error | Adaptación |
-- |---|---|---|---|
-- | `ALTER ROLE app_runtime WITH NOBYPASSRLS NOSUPERUSER` | `20260904150000` | `42501` | sin `NOSUPERUSER` |
-- | `ALTER ROLE app_maintenance WITH BYPASSRLS NOSUPERUSER …` | `20260906090000` | `42501` | sin `NOSUPERUSER` |
-- | `GRANT app_maintenance TO current_user` condicional | `20260906090000` | `42501 must be able to SET ROLE` | `GRANT … WITH SET TRUE, ADMIN TRUE` incondicional y **previo** |
-- | `ALTER FUNCTION app.* OWNER TO app_maintenance` | `20260906090000` | `42501 permission denied for schema app` | `GRANT CREATE ON SCHEMA app` antes, `REVOKE` después |
--
-- Las migraciones **no se editan** (CLAUDE.md: «nunca editar una migración
-- aplicada»). Lo que hace este script es **dejar la base en el estado en el que
-- esas cuatro sentencias sobran**, y registrar las dos migraciones como
-- aplicadas con su checksum real para que `prisma migrate deploy` ni las
-- reejecute ni denuncie deriva.
--
-- ## Cómo se usa (tres pasos, el script se ejecuta DOS veces)
--
-- ```bash
-- export SUPA="postgresql://postgres:<pass>@<host>:5432/postgres?sslmode=require"
--
-- psql "$SUPA" -v ON_ERROR_STOP=1 -f scripts/supabase-bootstrap.sql   # FASE 1
-- DIRECT_URL="$SUPA" npx prisma migrate deploy                        # el resto
-- psql "$SUPA" -v ON_ERROR_STOP=1 -f scripts/supabase-bootstrap.sql   # FASE 2
-- ```
--
-- El script **detecta solo en qué fase está** (por la existencia de
-- `public.organizations`) y es **idempotente**: ejecutarlo tres, cinco o
-- cincuenta veces deja exactamente el mismo estado. La fase 2 es la que aplica
-- los cuerpos adaptados —políticas, funciones-puerta, propiedad y privilegios—,
-- porque necesitan las tablas creadas.
--
-- Después: fijar contraseñas con `ALTER ROLE <rol> WITH LOGIN PASSWORD '…';`
-- (este script **no** pone ninguna contraseña: no habrá credenciales en el
-- repositorio, que es lo que la migración `20260904150000` decidió) y cargar las
-- variables de entorno del runbook §3.2 y §10.
--
-- ## `btree_gist` — DECISIÓN DECLARADA (deuda 15 de E12 §6)
--
-- El linter de seguridad de Supabase avisa (`extension_in_public`) de que
-- `btree_gist` vive en `public`. En el **preview** eso se **acepta y se cierra
-- como decisión, no como deuda**: `ALTER EXTENSION btree_gist SET SCHEMA
-- extensions` exige superusuario cuando hay objetos dependientes, y hay nueve
-- índices `EXCLUDE USING gist` aplicados (ejercicios, vigencias de niveles de
-- margen, periodos de IVA, planes, presupuestos, horas…). El riesgo real del
-- WARN es nulo aquí: el endurecimiento de `20260929090000` ya revocó `USAGE ON
-- SCHEMA public` a `anon` y `authenticated`, de modo que nadie puede ni ver ni
-- ejecutar nada de `public` por PostgREST.
--
-- En una base **nueva** sí se resuelve, y lo hace la fase 1 de este script:
-- `btree_gist` es una extensión **trusted** desde PostgreSQL 13, así que un rol
-- con `CREATE` sobre la base la instala **en `extensions`** sin ser
-- superusuario. Los `CREATE EXTENSION IF NOT EXISTS btree_gist` de las
-- migraciones posteriores se convierten entonces en no-ops y los índices
-- `EXCLUDE` resuelven sus clases de operadores por `search_path`. Si la
-- instalación en `extensions` no fuese posible (rol sin `CREATE`, versión
-- antigua), el script **lo dice y sigue**: la extensión acabará en `public` por
-- la migración de E4 y el WARN queda aceptado con el motivo de arriba escrito.
--
-- =============================================================================

\set ON_ERROR_STOP on

-- -----------------------------------------------------------------------------
-- 0 · Esquemas base y extensiones
-- -----------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS extensions;

DO $bootstrap_ext$
DECLARE
  v_schema text;
BEGIN
  SELECT n.nspname INTO v_schema
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname = 'btree_gist';

  IF v_schema IS NULL THEN
    -- Base nueva: se instala DONDE QUEREMOS, que es la única ventana que hay.
    BEGIN
      EXECUTE 'CREATE EXTENSION btree_gist WITH SCHEMA extensions';
      RAISE NOTICE 'btree_gist instalada en el esquema «extensions» (WARN del linter resuelto)';
    EXCEPTION WHEN insufficient_privilege OR feature_not_supported THEN
      RAISE NOTICE 'btree_gist NO se ha podido instalar en «extensions» (%). La migración de E4 la creará en «public»: WARN ACEPTADO, motivo en la cabecera de este script.', SQLERRM;
    END;
  ELSIF v_schema = 'public' THEN
    RAISE NOTICE 'btree_gist ya está en «public» con índices dependientes: moverla exige superusuario. WARN ACEPTADO (decisión de E12 · T21), no es deuda.';
  ELSE
    RAISE NOTICE 'btree_gist ya está en el esquema «%»: nada que hacer.', v_schema;
  END IF;
END
$bootstrap_ext$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- 1 · Los tres roles de la aplicación
--
-- `NOLOGIN` a propósito, igual que en las migraciones: la credencial la entrega
-- el operador fuera del repositorio. **Sin `NOSUPERUSER`**: es el atributo que
-- el `postgres` de Supabase no puede tocar, y no hace falta tocarlo — un rol
-- recién creado ya nace sin él.
--
-- | Rol | Para qué | BYPASSRLS |
-- |---|---|---|
-- | `app_runtime` | `DATABASE_URL` · la aplicación | **NO** (ADR-0009) |
-- | `app_maintenance` | `DATABASE_URL_MAINTENANCE` · scripts de operador, I10 | SÍ |
-- | `app_auth` | `AUTH_DATABASE_URL` · better-auth (E13) | NO |
-- -----------------------------------------------------------------------------

DO $bootstrap_roles$
DECLARE
  v_role text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOLOGIN NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
  END IF;
  -- Sin `NOSUPERUSER`: **ésta es la adaptación 1 de §4 del runbook**.
  EXECUTE 'ALTER ROLE app_runtime WITH NOBYPASSRLS NOCREATEDB NOCREATEROLE';

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_maintenance') THEN
    CREATE ROLE app_maintenance NOLOGIN NOCREATEDB NOCREATEROLE BYPASSRLS NOINHERIT;
  END IF;
  -- Adaptación 2: `BYPASSRLS` sí, `NOSUPERUSER` no.
  EXECUTE 'ALTER ROLE app_maintenance WITH BYPASSRLS NOCREATEDB NOCREATEROLE';

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_auth') THEN
    CREATE ROLE app_auth NOLOGIN NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
  END IF;
  EXECUTE 'ALTER ROLE app_auth WITH NOBYPASSRLS NOCREATEDB NOCREATEROLE';

  /**
   * Adaptación 3. La migración `20260906090000` hace
   * `GRANT app_maintenance TO current_user` **condicionado** a
   * `pg_has_role(current_user, 'app_maintenance', 'MEMBER')`, y en PostgreSQL 16+
   * ser MEMBER no basta para `ALTER … OWNER TO`: hace falta poder **SET ROLE**.
   * Se concede aquí, incondicional y con las dos opciones, de modo que la
   * comprobación de la migración salga cierta y su `GRANT` no llegue a correr.
   */
  v_role := current_user;
  EXECUTE format('GRANT app_maintenance TO %I WITH SET TRUE, ADMIN TRUE', v_role);
  EXECUTE format('GRANT app_runtime      TO %I WITH SET TRUE, ADMIN TRUE', v_role);
  EXECUTE format('GRANT app_auth         TO %I WITH SET TRUE, ADMIN TRUE', v_role);
EXCEPTION WHEN insufficient_privilege THEN
  RAISE EXCEPTION 'el rol % no puede crear/administrar los roles de la aplicación: ejecuta este script como el rol «postgres» del proyecto Supabase', current_user;
END
$bootstrap_roles$;

-- -----------------------------------------------------------------------------
-- 2 · Privilegios de esquema
--
-- Adaptación 4: `app_maintenance` necesita `CREATE ON SCHEMA app` **antes** de
-- que la migración de E3 le ceda la propiedad de las tres funciones-puerta. Se
-- concede aquí y la fase 2 lo revoca al terminar, que es exactamente lo que se
-- hizo a mano en el preview.
-- -----------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public, app, extensions TO app_runtime;
GRANT USAGE ON SCHEMA public, app, extensions TO app_maintenance;
GRANT USAGE ON SCHEMA public, extensions       TO app_auth;
GRANT CREATE ON SCHEMA app TO app_maintenance;

-- El `search_path` de la base incluye `extensions`: sin él, los índices
-- `EXCLUDE USING gist` de las migraciones no encuentran `gist_uuid_ops` cuando
-- la extensión no está en `public`.
DO $bootstrap_path$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET search_path = "$user", public, extensions', current_database());
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'sin privilegio para fijar el search_path de la base; Supabase ya lo trae con «extensions».';
END
$bootstrap_path$;

-- -----------------------------------------------------------------------------
-- 3 · FASE 1 — registrar como aplicadas las dos migraciones no ejecutables
--
-- Con los roles ya creados y con los atributos correctos, lo único que las dos
-- migraciones aportarían y este script no es su **cuerpo de datos**: la política
-- de `organizations`, las tres funciones-puerta y los `GRANT` sobre tablas. Eso
-- lo aplica la FASE 2, cuando las tablas existen. Aquí se marcan como aplicadas
-- con su **checksum real** para que `prisma migrate deploy` las salte sin
-- denunciar deriva.
--
-- Los dos checksums son el `sha256` de sendos `migration.sql`, que son
-- **inmutables** (CLAUDE.md). `tests/integration/e12-supabase-bootstrap.test.ts`
-- los recomputa desde el disco y falla si alguien los mueve.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public._prisma_migrations (
  id                      varchar(36) PRIMARY KEY,
  checksum                varchar(64) NOT NULL,
  finished_at             timestamptz,
  migration_name          varchar(255) NOT NULL,
  logs                    text,
  rolled_back_at          timestamptz,
  started_at              timestamptz NOT NULL DEFAULT now(),
  applied_steps_count     integer NOT NULL DEFAULT 0
);

DO $bootstrap_registro$
DECLARE
  v_pendientes text[][] := ARRAY[
    ARRAY['20260904150000_e1_rls_round2',  '9c9621215a55589b83053290064dc66c05d3fb6cf256f38d21166913fd1f6ca5'],
    ARRAY['20260906090000_e3_rls_helpers', '36c386a7cd2122e436d20428757dd342459993077b1932bfad7261edac2d42f2']
  ];
  v_fila text[];
BEGIN
  FOREACH v_fila SLICE 1 IN ARRAY v_pendientes LOOP
    IF NOT EXISTS (SELECT 1 FROM public._prisma_migrations WHERE migration_name = v_fila[1]) THEN
      INSERT INTO public._prisma_migrations
        (id, checksum, finished_at, migration_name, logs, started_at, applied_steps_count)
      VALUES
        (gen_random_uuid()::text, v_fila[2], now(), v_fila[1],
         'Aplicada por scripts/supabase-bootstrap.sql (E12 · T21): cuerpo adaptado a Supabase, '
         'mismo efecto, sin las sentencias que exigen SUPERUSER. Ver §4 del runbook.',
         now(), 1);
      RAISE NOTICE 'registrada como aplicada: %', v_fila[1];
    END IF;
  END LOOP;
END
$bootstrap_registro$;

-- -----------------------------------------------------------------------------
-- 4 · FASE 2 — los cuerpos adaptados (sólo cuando el esquema ya existe)
--
-- Todo lo de aquí adentro está condicionado a que `prisma migrate deploy` haya
-- corrido. En la primera pasada el bloque no hace nada y lo dice.
-- -----------------------------------------------------------------------------

DO $bootstrap_fase2$
BEGIN
  IF to_regclass('public.organizations') IS NULL THEN
    RAISE NOTICE 'FASE 1 completada. Ejecuta ahora «prisma migrate deploy» y vuelve a lanzar este script.';
    RETURN;
  END IF;

  RAISE NOTICE 'FASE 2: aplicando los cuerpos adaptados sobre el esquema ya migrado.';

  -- 4.1 · `20260904150000` — la política de `organizations` que deja ver la
  --       fila propia durante su creación (`INSERT … RETURNING`).
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON "organizations"';
  EXECUTE $pol$
    CREATE POLICY tenant_isolation ON "organizations"
      USING (
        "id" = app.current_org()
        OR (
          app.current_user() IS NOT NULL
          AND "id" IN (SELECT m."organization_id" FROM "memberships" m WHERE m."user_id" = app.current_user())
        )
        OR (app.current_user() IS NULL AND app.current_org() IS NULL)
      )
      WITH CHECK ("id" = app.current_org() OR app.current_user() IS NOT NULL)
  $pol$;

  -- 4.2 · `20260906090000` — las tres funciones-puerta `SECURITY DEFINER`.
  --       Idénticas a la migración: se recrean con `CREATE OR REPLACE`, de modo
  --       que si `migrate deploy` ya las hubiera creado (base donde la
  --       migración sí corrió) el resultado es el mismo.
  EXECUTE $fn1$
    CREATE OR REPLACE FUNCTION app.invitation_by_token_hash(p_hash text)
    RETURNS TABLE (
      id uuid, organization_id uuid, email text, role role,
      status invitation_status, expires_at timestamp(3), attempts integer, invited_by_id uuid
    )
    LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $body$
      SELECT i.id, i.organization_id, i.email, i.role, i.status, i.expires_at, i.attempts, i.invited_by_id
        FROM invitations i WHERE i.token_hash = p_hash
    $body$
  $fn1$;

  EXECUTE $fn2$
    CREATE OR REPLACE FUNCTION app.list_email_sync_targets()
    RETURNS TABLE (organization_id uuid, user_id uuid)
    LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $body$
      SELECT d.organization_id, d.user_id
        FROM app_data d JOIN organizations o ON o.id = d.organization_id
       WHERE d.app = 'email' AND o.is_active
       ORDER BY d.organization_id, d.user_id
    $body$
  $fn2$;

  EXECUTE $fn3$
    CREATE OR REPLACE FUNCTION app.organization_id_by_stripe_customer(p_customer_id text)
    RETURNS uuid
    LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $body$
      SELECT o.id FROM organizations o WHERE o.stripe_customer_id = p_customer_id
    $body$
  $fn3$;

  -- 4.3 · Propiedad de las tres puertas. **Ésta es la sentencia que fallaba con
  --       `42501 permission denied for schema app`**: ahora `app_maintenance`
  --       tiene `CREATE` sobre `app` (§2) y quien ejecuta puede `SET ROLE` a
  --       `app_maintenance` (§1). Con `SECURITY DEFINER` + `FORCE RLS`, el dueño
  --       tiene que ser el rol con `BYPASSRLS` o las puertas devuelven 0 filas.
  EXECUTE 'ALTER FUNCTION app.invitation_by_token_hash(text) OWNER TO app_maintenance';
  EXECUTE 'ALTER FUNCTION app.list_email_sync_targets() OWNER TO app_maintenance';
  EXECUTE 'ALTER FUNCTION app.organization_id_by_stripe_customer(text) OWNER TO app_maintenance';

  EXECUTE 'REVOKE ALL ON FUNCTION app.invitation_by_token_hash(text) FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION app.list_email_sync_targets() FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION app.organization_id_by_stripe_customer(text) FROM PUBLIC';

  EXECUTE 'GRANT EXECUTE ON FUNCTION app.invitation_by_token_hash(text) TO app_runtime';
  EXECUTE 'GRANT EXECUTE ON FUNCTION app.list_email_sync_targets() TO app_runtime';
  EXECUTE 'GRANT EXECUTE ON FUNCTION app.organization_id_by_stripe_customer(text) TO app_runtime';

  -- 4.4 · Privilegios sobre las tablas, presentes y futuras.
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_maintenance';
  EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_maintenance';
  EXECUTE 'GRANT EXECUTE ON FUNCTION app.current_org(), app.current_user() TO app_runtime, app_maintenance';

  -- 4.5 · Se retira el `CREATE` sobre `app`: era para la cesión de propiedad y
  --       nada más. Un rol de mantenimiento que pueda crear objetos en `app` es
  --       una puerta que no necesita estar abierta.
  EXECUTE 'REVOKE CREATE ON SCHEMA app FROM app_maintenance';

  RAISE NOTICE 'FASE 2 completada.';
END
$bootstrap_fase2$;

-- -----------------------------------------------------------------------------
-- 5 · Comprobación final — el script se audita a sí mismo
-- -----------------------------------------------------------------------------

DO $bootstrap_check$
DECLARE
  v_problemas text[] := ARRAY[]::text[];
  v_expuestas bigint;
BEGIN
  IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'app_runtime') THEN
    v_problemas := v_problemas || 'app_runtime tiene BYPASSRLS (ADR-0009 lo prohíbe)';
  END IF;
  IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'app_maintenance') THEN
    v_problemas := v_problemas || 'app_maintenance NO tiene BYPASSRLS';
  END IF;

  IF to_regclass('public.organizations') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'organizations' AND policyname = 'tenant_isolation') THEN
      v_problemas := v_problemas || 'falta la política tenant_isolation en organizations';
    END IF;
    IF (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = 'app.invitation_by_token_hash(text)'::regprocedure)
       IS DISTINCT FROM 'app_maintenance' THEN
      v_problemas := v_problemas || 'app.invitation_by_token_hash no es propiedad de app_maintenance';
    END IF;
    SELECT count(*) INTO v_expuestas
      FROM information_schema.role_table_grants
     WHERE grantee IN ('anon', 'authenticated');
    IF v_expuestas > 0 THEN
      v_problemas := v_problemas || format('%s privilegios de anon/authenticated sin revocar: falta la migración 20260929090000', v_expuestas);
    END IF;
  END IF;

  IF array_length(v_problemas, 1) IS NULL THEN
    RAISE NOTICE 'bootstrap CONFORME.';
  ELSE
    RAISE EXCEPTION 'bootstrap NO CONFORME: %', array_to_string(v_problemas, ' · ');
  END IF;
END
$bootstrap_check$;
