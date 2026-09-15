-- E10 · ronda 1 — auditoría H-4, QA BUG-E10-2 y dos PUEDE de la revisión
--
-- Migración ADITIVA. No edita ninguna migración aplicada, no exige SUPERUSER, no
-- toca propietarios y no mueve una sola cifra: cambia CHECKs, un trigger y un
-- privilegio.
--
--  1. **H-4** — `budget_lines_sign_by_type` empezaba por `sign_exception OR …`
--     sin comprobar que la cuenta perteneciera a una familia con excepción
--     declarada. Por SQL directo entraba una `640` de **+123 456 c** con
--     `sign_exception = true`: la aplicación la rechaza (`WRONG_SIGN` aborta con
--     independencia de la bandera), pero la base decía menos que el código y el
--     riesgo era la carga directa o un importador futuro.
--  2. **PUEDE (10)** — se retira la rama `OR "analytic_type" IS NULL`, que es
--     inalcanzable desde que O-E10-23 hizo la columna `NOT NULL` y añadió
--     `budget_lines_type_required`. Dejaba a la vista en `\d` exactamente el
--     agujero que O-E10-23 cerró.
--  3. **QA BUG-E10-2** — un parte APROBADO no se borra «ni por
--     `app_maintenance`», así que `scripts/load-fixture.ts --reset-org` no podía
--     vaciar la organización y las suites e2e se contaminaban entre ficheros.
--     Se abre **una sola** salida, del mismo patrón que `app.reopening_run_id`
--     de E9: el GUC de transacción `app.maintenance_reset_org`, verificado
--     contra la organización de la fila **y** contra el rol de operador. La
--     aplicación nunca conecta con ese rol (CLAUDE.md), así que el camino de
--     producto sigue siendo contra-apunte y nada más.
--  4. **PUEDE (11)** — `employees` es la única de las siete tablas que dependía
--     de una sola barrera para el borrado (la política `employees_no_delete`),
--     sin el `REVOKE DELETE` que M2/M3 sí aplican. Se añade por coherencia.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1 + 2. El CHECK de signo mira la FAMILIA de la cuenta
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Las familias son exactamente las que declara `SIGN_EXCEPTION_PREFIXES` de
-- `lib/budget/hash.ts` y las que el mensaje de `checkBudgetSign` nombra:
-- variación de existencias (`61x` / `71x`), rappels y devoluciones
-- (`706` / `708` / `709`) y reversiones (`79x` / `759`). Se declaran en una
-- función inmutable para que el CHECK sea legible en `\d` y la lista viva en un
-- solo sitio dentro de la base.

CREATE OR REPLACE FUNCTION app.budget_sign_exception_allowed(p_account_code text)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT p_account_code IS NOT NULL
     AND (p_account_code LIKE '61%'  OR p_account_code LIKE '71%'
       OR p_account_code LIKE '706%' OR p_account_code LIKE '708%' OR p_account_code LIKE '709%'
       OR p_account_code LIKE '79%'  OR p_account_code LIKE '759%')
$fn$;

REVOKE ALL ON FUNCTION app.budget_sign_exception_allowed(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.budget_sign_exception_allowed(text) TO app_runtime, app_maintenance;

ALTER TABLE "budget_lines" DROP CONSTRAINT IF EXISTS "budget_lines_sign_by_type";
ALTER TABLE "budget_lines"
  ADD CONSTRAINT "budget_lines_sign_by_type" CHECK (
    -- La excepción de signo SÓLO vale en una cuenta de familia con excepción
    -- declarada (H-4). Una línea sin cuenta (total de la dimensión) no puede
    -- ampararse en ella: no hay familia que la justifique.
    ("sign_exception" AND app.budget_sign_exception_allowed("account_code"))
    OR ("analytic_type" = 'INGRESO_DIRECTO' AND "amount_cents" >= 0)
    OR ("analytic_type" IN ('COSTE_DIRECTO_MC1', 'COSTE_DIRECTO_MC2',
                            'INDIRECTO_CECO', 'AMORTIZACION_DETERIORO')
        AND "amount_cents" <= 0)
    OR "analytic_type" IN ('FINANCIERO', 'EXTRAORDINARIO', 'NO_ANALITICO'));

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. BUG-E10-2 — el borrado de operador, registrado y verificado
-- ─────────────────────────────────────────────────────────────────────────────

-- `app.maintenance_reset_org()` — la organización que se está vaciando, o NULL.
-- Mismo contrato que `app.reopening_run_id()`: sin `SET LOCAL` es NULL, y un
-- valor que no sea un uuid es un ERROR, no un «no aplica» silencioso.
CREATE OR REPLACE FUNCTION app.maintenance_reset_org() RETURNS uuid
LANGUAGE plpgsql STABLE AS $fn$
DECLARE v_raw text;
BEGIN
  v_raw := nullif(current_setting('app.maintenance_reset_org', true), '');
  IF v_raw IS NULL THEN RETURN NULL; END IF;
  BEGIN
    RETURN v_raw::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'app.maintenance_reset_org no es un uuid: el vaciado se identifica por su organización'
      USING ERRCODE = '22P02';
  END;
END $fn$;

REVOKE ALL ON FUNCTION app.maintenance_reset_org() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.maintenance_reset_org() TO app_runtime, app_maintenance;

-- El «token de operador» es el ROL: `app_maintenance` es el único con
-- `BYPASSRLS` y **la aplicación nunca conecta con él** (`DATABASE_URL` →
-- `app_runtime`). Un GUC inventado desde la aplicación no abre nada, igual que
-- un uuid inventado no abría CA-1 sin su `ClosingRun`.
CREATE OR REPLACE FUNCTION app.is_maintenance_operator() RETURNS boolean
LANGUAGE sql STABLE AS $fn$
  SELECT pg_has_role(current_user, 'app_maintenance', 'USAGE')
$fn$;

REVOKE ALL ON FUNCTION app.is_maintenance_operator() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_maintenance_operator() TO app_runtime, app_maintenance;

CREATE OR REPLACE FUNCTION app.assert_time_entry_not_deleted_when_approved()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD."status" <> 'APROBADO' THEN RETURN OLD; END IF;

  -- BUG-E10-2: la ÚNICA salida es el vaciado de operador, y tiene que nombrar
  -- **esta** organización y venir de un rol de mantenimiento. Nada de esto está
  -- al alcance de la aplicación.
  IF app.maintenance_reset_org() IS NOT DISTINCT FROM OLD."organization_id"
     AND app.is_maintenance_operator()
  THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'el parte de horas % está aprobado: no se borra, se contra-apunta (I-E10-4)',
    OLD."id" USING ERRCODE = '23514';
END
$fn$;

-- Verificación: sin GUC sigue siendo NULL, y el GUC por sí solo no basta si el
-- rol no es de mantenimiento (el rechazo entero lo ejercen
-- `tests/integration/e10-ronda1.test.ts` y la suite RLS sobre datos reales).
DO $$
BEGIN
  IF app.maintenance_reset_org() IS NOT NULL THEN
    RAISE EXCEPTION 'sin SET LOCAL, app.maintenance_reset_org() tiene que ser NULL';
  END IF;
  PERFORM set_config('app.maintenance_reset_org', gen_random_uuid()::text, true);
  IF app.maintenance_reset_org() IS NULL THEN
    RAISE EXCEPTION 'app.maintenance_reset_org() no lee el GUC';
  END IF;
  PERFORM set_config('app.maintenance_reset_org', '', true);
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. `employees`: dos barreras, como las otras seis tablas
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE DELETE ON "employees" FROM app_runtime;
