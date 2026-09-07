-- E7 · T14 — M5: RLS en `users` con políticas POR ROL (**ADR-0015 D5**, APROBADO).
--
-- `users` era la única tabla sin RLS. No era descuido: no tiene
-- `organization_id` (un usuario pertenece a varias organizaciones) y el camino
-- de autenticación la lee **sin sesión**. Pero hoy un `SELECT * FROM users`
-- desde `app_runtime` enumera los correos de todos los clientes del SaaS.
--
-- La decisión aprovecha que las políticas de PostgreSQL se acotan **por rol**:
--   · `app_auth`   → rol NUEVO, LOGIN, NOBYPASSRLS, consumido SÓLO por
--                    `AUTH_DATABASE_URL` desde el adaptador de better-auth y
--                    `models/users.ts`: `USING(true)` / `WITH CHECK(true)`.
--   · `app_runtime`→ `SELECT` de uno mismo y de quien comparte la organización
--                    activa; `UPDATE` sólo de la propia fila; `DELETE` prohibido
--                    por política `RESTRICTIVE`.
--
-- Ejecutable por un rol NO superusuario: `CREATE ROLE` lo puede `postgres` en
-- Supabase (`rolcreaterole`), igual que ya hace `20260906090000_e3_rls_helpers`
-- con `app_maintenance`. La CONTRASEÑA no la fija ninguna migración (quedaría en
-- el repositorio): la pone el operador (`scripts/dev-db-setup.sh` en local y CI).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. El rol de autenticación
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_auth') THEN
    CREATE ROLE app_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
  END IF;
  -- NOBYPASSRLS explícito: dar `BYPASSRLS` al rol de autenticación sería el
  -- agujero que ADR-0009 cerró.
  EXECUTE 'ALTER ROLE app_auth WITH NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE';
END $$;

GRANT USAGE ON SCHEMA public, app TO app_auth;
-- La superficie de `app_auth` son las CUATRO tablas del camino de
-- autenticación, y nada más. No es un segundo `app_runtime`.
GRANT SELECT, INSERT, UPDATE, DELETE ON "sessions", "account", "verification" TO app_auth;
-- `users` no: un usuario NO se borra desde ningún camino de la aplicación (la
-- política RESTRICTIVE de abajo lo repite, pero el privilegio es la cerradura
-- que da 42501 en vez de un `DELETE` silencioso de cero filas).
GRANT SELECT, INSERT, UPDATE ON "users" TO app_auth;
REVOKE DELETE ON "users" FROM app_auth;
GRANT EXECUTE ON FUNCTION app.current_org(), app.current_user() TO app_auth;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. `users` bajo RLS, con FORCE (el propietario tampoco se la salta)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_auth_full"      ON "users";
DROP POLICY IF EXISTS "users_runtime_select" ON "users";
DROP POLICY IF EXISTS "users_runtime_update" ON "users";
DROP POLICY IF EXISTS "users_no_delete"      ON "users";

-- 2.a El camino de autenticación: lee y escribe sin sesión, que es lo que
--     necesita (alta, OTP, verificación, sesión).
CREATE POLICY "users_auth_full" ON "users" TO app_auth USING (true) WITH CHECK (true);

-- 2.b El runtime: uno mismo y quien comparte la organización ACTIVA. La
--     subconsulta mira `memberships` de `app.current_org()`, que es
--     exactamente lo que la política de `memberships` ya deja ver: ni recursión
--     ni puerta trasera.
CREATE POLICY "users_runtime_select" ON "users" FOR SELECT TO app_runtime USING (
  "id" = app.current_user()
  OR EXISTS (
    SELECT 1 FROM "memberships" m
     WHERE m."user_id" = "users"."id" AND m."organization_id" = app.current_org()
  )
);

-- 2.c Sólo la propia fila, y sigue siendo la propia después del UPDATE.
CREATE POLICY "users_runtime_update" ON "users" FOR UPDATE TO app_runtime
  USING ("id" = app.current_user())
  WITH CHECK ("id" = app.current_user());

-- 2.d Un usuario no se borra desde la aplicación. RESTRICTIVE: aplica a TODOS
--     los roles sujetos a políticas, `app_auth` incluido.
CREATE POLICY "users_no_delete" ON "users" AS RESTRICTIVE FOR DELETE USING (false);

ALTER TABLE "users" FORCE ROW LEVEL SECURITY;

-- 2.e Y la segunda cerradura, la de privilegio: `app_runtime` no da de alta
--     usuarios ni los borra. Eso es del camino de autenticación (`app_auth`).
REVOKE INSERT, DELETE ON "users" FROM app_runtime;
GRANT SELECT, UPDATE ON "users" TO app_runtime;
