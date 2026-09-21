-- E12 · T19 — `budget_capex_lines`: el presupuesto de INVERSIONES
-- (Q-4 de `docs/design/E10-validacion-controlling.md`; ADR-0018 **D2 ENMENDADA**
-- el 2026-09-15; `docs/design/E12-fiabilidad-dod.md` §6 deuda 11).
--
-- Tabla propia y no una línea más de `budget_lines`, por la razón que Q-4 dejó
-- escrita: presupuestar el grupo 2 allí obligaría a levantar el CHECK
-- `budget_lines_pnl_only` y a mezclar un presupuesto de **balance** con uno de
-- **explotación** en la misma tabla. Lo que sí se suma es su **dotación
-- derivada**: la `68x` propuesta pasa a ser la de los activos ya en alta
-- (`proposeDepreciationBudget`, E10) **más** la de estas altas previstas.
--
-- Aditiva pura: la tabla nace VACÍA, así que no hay backfill y no hace falta el
-- baile `NO FORCE → backfill → FORCE`. Ejecutable por un rol NO superusuario.
--
-- Reutiliza los cuatro triggers que E10 escribió para las otras dos tablas de
-- líneas —mes dentro del ejercicio, dimensión viva, y prohibición de escribir
-- en una versión sellada—, porque son exactamente las mismas reglas y
-- reescribirlas sería invitar a que una de las dos versiones se quedara atrás.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. La tabla
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "budget_capex_lines" (
  "id"                 uuid                 NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"    uuid                 NOT NULL,
  "budget_id"          uuid                 NOT NULL,
  -- Mes de ALTA prevista. No es el mes en que se paga: es aquel desde el que el
  -- activo empieza a amortizar.
  "month"              date                 NOT NULL,
  "account_code"       varchar(20)          NOT NULL,
  "project_id"         uuid,
  "cost_center_id"     uuid,
  -- Positivo: un activo que entra no es un gasto y no lleva la convención de
  -- signo de `budget_lines` (D2 · APORTE).
  "amount_cents"       integer              NOT NULL,
  "residual_cents"     integer              NOT NULL DEFAULT 0,
  "method"             "depreciation_method" NOT NULL DEFAULT 'LINEAL',
  "useful_life_months" integer              NOT NULL,
  "starts_at"          "depreciation_start" NOT NULL DEFAULT 'MES_DE_ALTA',
  "description"        varchar(255),
  "source"             "budget_line_source" NOT NULL DEFAULT 'MANUAL',
  "created_at"         timestamp(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "budget_capex_lines_pkey" PRIMARY KEY ("id"),

  -- Día 1 del mes, como las otras dos tablas de líneas.
  CONSTRAINT "budget_capex_lines_month_is_first_day"
    CHECK (date_part('day', "month") = 1),

  -- **Grupo 2 y nada más.** Es el espejo de `budget_lines_pnl_only`: allí se
  -- prohíbe el balance, aquí se exige. Sin este CHECK, la tabla sería un cajón.
  CONSTRAINT "budget_capex_lines_group_2_only"
    CHECK ("account_code" ~ '^2'),

  -- O-A6: exactamente UNA dimensión, ni las dos ni ninguna.
  CONSTRAINT "budget_capex_lines_one_dimension"
    CHECK (num_nonnulls("project_id", "cost_center_id") = 1),

  -- Importes y vida útil con sentido. Una vida útil de 0 meses haría una
  -- división por cero en el motor; una de 1 200 (cien años) es un dedo gordo.
  CONSTRAINT "budget_capex_lines_amount_positive"   CHECK ("amount_cents" > 0),
  CONSTRAINT "budget_capex_lines_residual_in_range" CHECK ("residual_cents" >= 0 AND "residual_cents" < "amount_cents"),
  CONSTRAINT "budget_capex_lines_life_in_range"     CHECK ("useful_life_months" BETWEEN 1 AND 1200)
);

CREATE INDEX "budget_capex_lines_organization_id_budget_id_month_idx"
  ON "budget_capex_lines" ("organization_id", "budget_id", "month");

COMMENT ON TABLE "budget_capex_lines" IS
  'E12 · T19 (Q-4, ADR-0018 D2 enmendada) — presupuesto de inversiones. Entra en el budgetHash: una inversión prevista cambia el EBIT presupuestado, y un sello que no la cubriera dejaría fuera una cifra que mueve el informe.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. FK — compuestas POR TENANT (O-A1), como las de `budget_lines`
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "budget_capex_lines"
  ADD CONSTRAINT "budget_capex_lines_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "budget_capex_lines_budget_fkey"
    FOREIGN KEY ("organization_id", "budget_id")
    REFERENCES "budgets"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "budget_capex_lines_project_fkey"
    FOREIGN KEY ("organization_id", "project_id")
    REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "budget_capex_lines_cost_center_fkey"
    FOREIGN KEY ("organization_id", "cost_center_id")
    REFERENCES "cost_centers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Los tres triggers de E10, reutilizados
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TRIGGER "budget_capex_lines_month_in_fiscal_year"
  BEFORE INSERT OR UPDATE ON "budget_capex_lines"
  FOR EACH ROW EXECUTE FUNCTION app.assert_budget_month_in_fiscal_year();

CREATE TRIGGER "budget_capex_lines_dimension_alive"
  BEFORE INSERT ON "budget_capex_lines"
  FOR EACH ROW EXECUTE FUNCTION app.assert_budget_dimension_alive();

CREATE TRIGGER "budget_capex_lines_no_write_when_sealed"
  BEFORE INSERT OR UPDATE OR DELETE ON "budget_capex_lines"
  FOR EACH ROW EXECUTE FUNCTION app.assert_budget_lines_not_sealed();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RLS estricta (ADR-0009) y privilegios
-- ─────────────────────────────────────────────────────────────────────────────
SELECT app.enforce_tenant_rls('budget_capex_lines');

GRANT SELECT, INSERT, UPDATE, DELETE ON "budget_capex_lines" TO app_runtime;

-- E12 · T13 — la tabla nueva entra **sola** en `reset-org` porque la lista se
-- deriva de `TENANT_MODELS` (regla E-4), pero los privilegios y la guardia del
-- operador sí hay que darlos aquí: es la primera tabla de tenant que nace
-- DESPUÉS de `20261001100000_e12_rol_de_operador`, y sin esto el vaciado
-- fallaría con «permission denied» en vez de vaciar.
GRANT SELECT, INSERT, UPDATE, DELETE ON "budget_capex_lines" TO app_operator;
DROP POLICY IF EXISTS "budget_capex_lines_operator_delete_guard" ON "budget_capex_lines";
CREATE POLICY "budget_capex_lines_operator_delete_guard" ON "budget_capex_lines"
  AS RESTRICTIVE FOR DELETE
  USING (current_user <> 'app_operator' OR app.operator_reset_allowed());

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Verificación
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT (SELECT relrowsecurity AND relforcerowsecurity
            FROM pg_class WHERE relname = 'budget_capex_lines') THEN
    RAISE EXCEPTION 'budget_capex_lines no ha quedado en ENABLE + FORCE ROW LEVEL SECURITY';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relname = 'budget_capex_lines' AND NOT t.tgisinternal) <> 3 THEN
    RAISE EXCEPTION 'budget_capex_lines no tiene los tres triggers de E10';
  END IF;
END $$;
