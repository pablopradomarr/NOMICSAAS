-- E3 · T2 — Puertas estrechas y rol de mantenimiento (ADR-0009 §5 y §6).
--
-- Esta migración NO cambia ninguna política: sólo AÑADE las tres funciones
-- `SECURITY DEFINER` acotadas y el rol `app_maintenance`, para que el refactor
-- de T2 (`models/{organizations,memberships,invitations}.ts`,
-- `lib/email-sync/ingest.ts`) se pueda desplegar SOLO, antes de que T3 retire la
-- cláusula de escape. Con el escape todavía puesto, el comportamiento es
-- idéntico al de hoy; sin él, estas funciones son lo único que autoriza los dos
-- accesos que ninguna política puede autorizar (ADR-0009 §5).
--
-- ¿Por qué las funciones NO son propiedad del dueño de las tablas?
-- `SECURITY DEFINER` ejecuta con los privilegios del PROPIETARIO DE LA FUNCIÓN,
-- y T3 activa `FORCE ROW LEVEL SECURITY`, que somete también al propietario de
-- la tabla a las políticas. Una función propiedad del dueño de las tablas
-- devolvería 0 filas tras T3. Se hacen propiedad de `app_maintenance`, que tiene
-- `BYPASSRLS`: es el único rol al que la retirada del escape no ciega, y su
-- superficie queda limitada a lo que estas tres funciones devuelven.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Rol de mantenimiento (ADR-0009 §6)
--    NOLOGIN: la credencial la entrega el operador fuera de la migración
--    (`scripts/dev-db-setup.sh` en local y CI). La aplicación web NUNCA conecta
--    con este rol; sí lo hacen los scripts de operador y el check de I10.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_maintenance') THEN
    CREATE ROLE app_maintenance NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS NOINHERIT;
  END IF;
  EXECUTE 'ALTER ROLE app_maintenance WITH BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE';
  -- Para poder cederle la propiedad de las funciones, el rol que ejecuta la
  -- migración debe ser miembro suyo (o superusuario, que ya lo puede).
  IF NOT pg_has_role(current_user, 'app_maintenance', 'MEMBER') THEN
    EXECUTE format('GRANT app_maintenance TO %I', current_user);
  END IF;
END $$;

GRANT USAGE ON SCHEMA public, app TO app_maintenance;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_maintenance;
GRANT EXECUTE ON FUNCTION app.current_org(), app.current_user() TO app_maintenance;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_maintenance;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Invitación por hash de token (ADR-0009 §5, primera puerta)
--    Aceptar una invitación ocurre ANTES de tener organización activa y ANTES de
--    existir la membresía: ninguna política de `invitations` puede autorizarlo.
--    La puerta se abre por un secreto de 256 bits que sólo viaja por email; el
--    parámetro es el sha256 que ya guarda la tabla, nunca el token en claro.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.invitation_by_token_hash(p_hash text)
RETURNS TABLE (
  id uuid,
  organization_id uuid,
  email text,
  role role,
  status invitation_status,
  expires_at timestamp(3),
  attempts integer,
  invited_by_id uuid
)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $fn$
  SELECT i.id, i.organization_id, i.email, i.role, i.status, i.expires_at, i.attempts, i.invited_by_id
  FROM invitations i
  WHERE i.token_hash = p_hash
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Destinos del sync de email (ADR-0009 §5, segunda puerta)
--    El cron recorre TODAS las organizaciones a propósito. Devuelve SÓLO el par
--    (organización, usuario): ni credenciales, ni `data`, ni nada más. El bucle
--    acota después cada iteración con `tenantDb` / `withTenantGucs`.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.list_email_sync_targets()
RETURNS TABLE (organization_id uuid, user_id uuid)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $fn$
  SELECT d.organization_id, d.user_id
  FROM app_data d
  JOIN organizations o ON o.id = d.organization_id
  WHERE d.app = 'email' AND o.is_active
  ORDER BY d.organization_id, d.user_id
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Organización por cliente de Stripe (§2.6 del diseño)
--    El webhook de Stripe no tiene sesión: no hay usuario ni organización activa
--    que fijar en los GUC. `stripe_customer_id` es UNIQUE desde
--    20260904140100, así que la puerta devuelve como mucho una fila y sólo el
--    id: el resto lo lee ya `getOrganizationById` con `app.current_org` fijado.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.organization_id_by_stripe_customer(p_customer_id text)
RETURNS uuid
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $fn$
  SELECT o.id FROM organizations o WHERE o.stripe_customer_id = p_customer_id
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Propiedad y privilegios de las tres puertas
-- ─────────────────────────────────────────────────────────────────────────────
ALTER FUNCTION app.invitation_by_token_hash(text) OWNER TO app_maintenance;
ALTER FUNCTION app.list_email_sync_targets() OWNER TO app_maintenance;
ALTER FUNCTION app.organization_id_by_stripe_customer(text) OWNER TO app_maintenance;

REVOKE ALL ON FUNCTION app.invitation_by_token_hash(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.list_email_sync_targets() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.organization_id_by_stripe_customer(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.invitation_by_token_hash(text) TO app_runtime;
GRANT EXECUTE ON FUNCTION app.list_email_sync_targets() TO app_runtime;
GRANT EXECUTE ON FUNCTION app.organization_id_by_stripe_customer(text) TO app_runtime;
