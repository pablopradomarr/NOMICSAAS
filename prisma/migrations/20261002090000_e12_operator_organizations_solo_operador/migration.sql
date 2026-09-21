-- ─────────────────────────────────────────────────────────────────────────────
-- E12 · ronda 1 — **`app.operator_organizations` deja de ser alcanzable desde
-- `app_runtime`** (DEBE #6 de `docs/design/E12-revision.md`).
--
-- La función es `SECURITY DEFINER` y cruza todos los tenants: devuelve nombre,
-- slug, número de asientos y sello de TODAS las organizaciones. El
-- `GRANT EXECUTE` estaba también a `app_runtime`, que es el rol con el que se
-- sirve la aplicación entera, y la única autorización vivía en
-- `requirePlatformAdmin()` — justo donde ADR-0020 insiste en no dejar una sola
-- vía. Un olvido de guardia en una acción futura enumeraba la plataforma.
--
-- Desde aquí sólo la ejecutan `app_operator` (al que se llega con
-- `SET LOCAL ROLE` desde `app_runtime`, y sólo dentro de la transacción que lo
-- hace, porque `app_runtime` es `NOINHERIT`) y `app_maintenance` (los scripts de
-- operador). La negativa vive en la base, como el resto de D1–D6.
--
-- Nivel 1: no cambia el motor contable ni el esquema de asientos. ADR-0020 ya
-- cubre el rol de operador; esto sólo estrecha un privilegio que sobraba.
-- ─────────────────────────────────────────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION app.operator_organizations(timestamp(3)) FROM app_runtime;
GRANT EXECUTE ON FUNCTION app.operator_organizations(timestamp(3)) TO app_operator, app_maintenance;

COMMENT ON FUNCTION app.operator_organizations(timestamp(3)) IS
  'E12 · ADR-0020 §5.5 — el inventario de /admin. Devuelve AGREGADOS (cuánto), nunca filas de negocio (qué). '
  'Ronda 1: NO la puede ejecutar app_runtime; hay que entrar con SET LOCAL ROLE app_operator, de modo que la '
  'negativa no dependa sólo de requirePlatformAdmin().';

-- Verificación: la migración comprueba lo que promete.
DO $$
DECLARE tiene boolean;
BEGIN
  SELECT has_function_privilege('app_runtime', 'app.operator_organizations(timestamp(3))', 'EXECUTE') INTO tiene;
  IF tiene THEN
    RAISE EXCEPTION 'app_runtime sigue pudiendo ejecutar app.operator_organizations';
  END IF;
  SELECT has_function_privilege('app_operator', 'app.operator_organizations(timestamp(3))', 'EXECUTE') INTO tiene;
  IF NOT tiene THEN
    RAISE EXCEPTION 'app_operator no puede ejecutar app.operator_organizations: /admin se queda sin inventario';
  END IF;
END $$;
