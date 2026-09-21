-- ─────────────────────────────────────────────────────────────────────────────
-- E12 · ronda 2 — **la dependencia invisible de `revoke_operator_exception`**
-- (hallazgo #10 de `docs/design/E12-revision.md`, reabierto por la re-revisión).
--
-- `operator_exceptions` es append-only por RLS: `enforce_tenant_rls` deja la
-- tabla en `ENABLE + FORCE ROW LEVEL SECURITY` y la migración
-- `20261001090000` le añade dos políticas RESTRICTIVAS —`no_update` y
-- `no_delete`, las dos `USING (false)`— para que revocar una excepción sea
-- llamar a `app.revoke_operator_exception()` y no un `UPDATE` libre que también
-- podría alargar `expires_at`.
--
-- Esa función es `SECURITY DEFINER`, así que su `UPDATE` corre como el
-- PROPIETARIO. Y con `FORCE ROW LEVEL SECURITY` **el propietario tampoco esquiva
-- las políticas**: lo único que hace que ese `UPDATE` vea sus filas es que el
-- propietario tenga el atributo de rol `BYPASSRLS` (o sea superusuario).
--
-- Es decir: la revocación de una excepción de operador —una escritura que
-- ADR-0020 exige que quede registrada y acotada— funciona hoy **por un atributo
-- de rol que ninguna migración pide, ningún comentario nombra y ningún test
-- comprueba**. Y falla de la peor manera posible: sin error. El `UPDATE` afecta
-- a 0 filas, `GET DIAGNOSTICS` devuelve 0, la función devuelve `false` y la
-- aplicación entiende «esa excepción ya estaba revocada o no existe». La
-- excepción sigue viva hasta que caduca sola.
--
-- Esta migración **no cambia comportamiento**: hace la dependencia explícita y
-- la convierte en una condición de despliegue que se comprueba. Si algún día el
-- propietario deja de tener `BYPASSRLS`, el despliegue se para aquí nombrando el
-- atributo, en vez de dejar `/admin` revocando excepciones que no se revocan.
--
-- Por qué una GUARDA y no una exención nominal del propietario en la política:
-- añadir `TO` o un predicado por rol a una política RLS es Nivel 2 (CLAUDE.md) y
-- abriría, aunque fuese nominalmente, el `UPDATE` que `20261001090000` cerró a
-- propósito. La guarda deja la política tal cual y sólo exige en voz alta lo que
-- ya hacía falta en silencio.
--
-- Migración ADITIVA y ejecutable por un rol NO superusuario: sólo `COMMENT` y un
-- bloque `DO` de lectura sobre `pg_proc` / `pg_roles`. Nivel 1.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_owner    name;
  v_bypass   boolean;
  v_super    boolean;
  v_force    boolean;
BEGIN
  SELECT r.rolname, r.rolbypassrls, r.rolsuper
    INTO v_owner, v_bypass, v_super
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles r     ON r.oid = p.proowner
   WHERE n.nspname = 'app'
     AND p.proname = 'revoke_operator_exception';

  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'app.revoke_operator_exception no existe: la migración 20261001090000 no está aplicada';
  END IF;

  SELECT relforcerowsecurity INTO v_force FROM pg_class WHERE relname = 'operator_exceptions';

  -- La guarda sólo hace falta mientras la tabla esté en FORCE. Si algún día
  -- dejara de estarlo, el propietario esquivaría las políticas por sí mismo…
  -- pero entonces el problema sería otro y más grave, y lo caza el test que
  -- comprueba que ninguna tabla de negocio queda en NO FORCE.
  IF v_force AND NOT (v_bypass OR v_super) THEN
    RAISE EXCEPTION
      'el propietario de app.revoke_operator_exception (%) no tiene BYPASSRLS y operator_exceptions está en FORCE ROW '
      'LEVEL SECURITY: la política RESTRICTIVA operator_exceptions_no_update bloquearía el UPDATE de la función y la '
      'revocación de una excepción de operador fallaría EN SILENCIO (0 filas, sin error). Concede BYPASSRLS al '
      'propietario de las migraciones (en Supabase, `postgres` ya lo tiene) o revisa ADR-0020 §Modelo.',
      v_owner;
  END IF;
END $$;

COMMENT ON FUNCTION app.revoke_operator_exception(uuid, timestamp(3)) IS
  'E12 · ADR-0020 — revoca una excepción de operador escribiendo SÓLO `revoked_at`, dentro de la organización de la '
  'sesión y sólo si estaba a NULL. DEPENDENCIA EXPLÍCITA (ronda 2, hallazgo #10): `operator_exceptions` está en FORCE '
  'ROW LEVEL SECURITY con la política RESTRICTIVA `operator_exceptions_no_update`, así que este UPDATE sólo ve sus '
  'filas porque el PROPIETARIO de la función tiene BYPASSRLS. Sin ese atributo la revocación devolvería false sin '
  'error. La migración 20261003090000 lo comprueba al desplegar.';

COMMENT ON POLICY "operator_exceptions_no_update" ON "operator_exceptions" IS
  'Append-only (ADR-0020 · Modelo): nadie actualiza una excepción por SQL libre; se revoca con '
  'app.revoke_operator_exception(), que es SECURITY DEFINER y atraviesa esta política por el BYPASSRLS de su '
  'propietario (ver migración 20261003090000).';
