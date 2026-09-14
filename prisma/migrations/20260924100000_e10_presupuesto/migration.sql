-- E10 · T4 — M2: `budgets`, `budget_lines`, `budget_hours_lines`
-- (docs/design/E10-presupuesto-horas.md §2.3, ADR-0018 D2).
--
-- Aditiva pura y ejecutable por un rol NO superusuario: ni un `ALTER ROLE`, ni un
-- `OWNER TO`, ni una extensión nueva (`btree_gist` está disponible desde E2). Las
-- tres tablas nacen VACÍAS, así que no hay backfill y no hace falta el baile
-- `NO FORCE` → backfill → `FORCE`.
--
-- Aquí se cierra **O-A6**, abierta desde E4 y fechada en E5 para esta migración:
-- un `@@unique` con columnas nullables NO impide duplicados (`NULL <> NULL` en
-- PostgreSQL). La exclusividad la dan CUATRO índices únicos PARCIALES más el
-- CHECK de dimensión excluyente.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Tablas
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE "budgets" (
  "id"                 uuid              NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"    uuid              NOT NULL,
  "fiscal_year_id"     uuid              NOT NULL,
  "scenario"           "budget_scenario" NOT NULL,
  -- 0 en BASE; 1..n en REVISADO. `(ejercicio, escenario, revisión)` es la
  -- identidad y produce el código visible `2026-BASE` / `2026-REV2`.
  "revision"           integer           NOT NULL DEFAULT 0,
  "name"               varchar(120)      NOT NULL,
  "note"               varchar(1000),
  "status"             "budget_status"   NOT NULL DEFAULT 'BORRADOR',
  -- Vigencia (D2). `valid_to` lo cierra `sealBudget` en la MISMA transacción con
  -- `validFrom(nueva) − 1 día` (O-E10-8): el EXCLUDE impide el solape pero no el
  -- HUECO, y un mes sin versión vigente disparaba `PRESUPUESTO_AUSENTE` teniendo
  -- presupuesto. La continuidad la exige I-E10-15.
  "valid_from"         date              NOT NULL,
  "valid_to"           date,
  -- O-E10-9. NULL = la versión cubre los DOCE meses. Con valor (día 1), es
  -- PARCIAL: sustituye desde ese mes y el informe COMPONE BASE + REVISADO
  -- diciendo de qué versión sale cada uno (I-E10-16).
  "partial_from"       date,
  "budget_hash"        char(64),
  "margin_config_hash" char(64),
  "git_sha"            varchar(64),
  "sealed_at"          timestamp(3),
  "sealed_by_id"       uuid,
  "superseded_by_id"   uuid,
  "created_by_id"      uuid,
  "created_at"         timestamp(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         timestamp(3)      NOT NULL,
  CONSTRAINT "budgets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "budgets_version_unique"
  ON "budgets" ("organization_id", "fiscal_year_id", "scenario", "revision");
CREATE UNIQUE INDEX "budgets_organization_id_id_key" ON "budgets" ("organization_id", "id");
CREATE INDEX "budgets_organization_id_fiscal_year_id_status_idx"
  ON "budgets" ("organization_id", "fiscal_year_id", "status");

CREATE TABLE "budget_lines" (
  "id"               uuid                 NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"  uuid                 NOT NULL,
  "budget_id"        uuid                 NOT NULL,
  -- Primer día del mes presupuestado, dentro del ejercicio de la versión.
  "month"            date                 NOT NULL,
  -- NULL = celda del total de la dimensión, sin desglose por cuenta.
  "account_code"     varchar(12),
  "project_id"       uuid,
  "cost_center_id"   uuid,
  -- Denormalizada del proyecto (R-A9): la escribe el código, la VERIFICA un
  -- trigger y no se recalcula nunca (rellenarla rompería `budget_hash`).
  "business_line_id" uuid,
  -- O-E10-23: OBLIGATORIO en toda línea, tenga cuenta o no.
  "analytic_type"    "analytic_type"      NOT NULL,
  -- O-E10-7: el nivel VIAJA CON LA LÍNEA, como `allocation_lines.margin_level`.
  "margin_level"     "margin_level"       NOT NULL,
  -- APORTE (`haber − debe`): ingreso +, gasto −. El signo lo fuerza el tipo.
  "amount_cents"     integer              NOT NULL,
  "sign_exception"   boolean              NOT NULL DEFAULT false,
  "source"           "budget_line_source" NOT NULL DEFAULT 'MANUAL',
  "note"             varchar(400),
  "created_at"       timestamp(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "budget_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "budget_lines_organization_id_budget_id_month_idx"
  ON "budget_lines" ("organization_id", "budget_id", "month");
CREATE INDEX "budget_lines_organization_id_budget_id_project_id_month_idx"
  ON "budget_lines" ("organization_id", "budget_id", "project_id", "month");
CREATE INDEX "budget_lines_organization_id_budget_id_cost_center_id_month_idx"
  ON "budget_lines" ("organization_id", "budget_id", "cost_center_id", "month");
CREATE INDEX "budget_lines_organization_id_budget_id_account_code_idx"
  ON "budget_lines" ("organization_id", "budget_id", "account_code");

-- Tabla aparte de `budget_lines` a propósito: las horas no tienen cuenta, no
-- llevan signo de aporte y no entran en ningún nivel de margen. Con un `kind` en
-- la misma tabla habría que meterlo en los cuatro índices únicos de O-A6, que es
-- justo el enredo que O-A6 existe para evitar.
CREATE TABLE "budget_hours_lines" (
  "id"              uuid                 NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" uuid                 NOT NULL,
  "budget_id"       uuid                 NOT NULL,
  "month"           date                 NOT NULL,
  "project_id"      uuid,
  "cost_center_id"  uuid,
  "employee_id"     uuid,
  -- Minutos enteros y ≥ 0 (Q-2). Alimentan el KPI de horas presupuestadas y la
  -- LIQUIDACIÓN PRESUPUESTARIA de los drivers de actividad (O-E10-4).
  "minutes"         integer              NOT NULL,
  "source"          "budget_line_source" NOT NULL DEFAULT 'MANUAL',
  "created_at"      timestamp(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "budget_hours_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "budget_hours_lines_organization_id_budget_id_month_idx"
  ON "budget_hours_lines" ("organization_id", "budget_id", "month");

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. FK — compuestas POR TENANT donde el destino es de negocio (O-A1)
--
--    `budget_hours_lines.employee_id` NO se ata aquí: `employees` la crea M3.
--    La FK compuesta `budget_hours_employee_fk` se añade al final de M3, que es
--    la primera migración en la que su destino existe. Es la misma FK que pide
--    O-E10-10, sólo que atada un fichero más tarde.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "budgets"
  ADD CONSTRAINT "budgets_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "budgets_fiscal_year_fkey"
    FOREIGN KEY ("organization_id", "fiscal_year_id")
    REFERENCES "fiscal_years"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "budgets_superseded_by_fkey"
    FOREIGN KEY ("superseded_by_id") REFERENCES "budgets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "budget_lines"
  ADD CONSTRAINT "budget_lines_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "budget_lines_budget_fkey"
    FOREIGN KEY ("organization_id", "budget_id")
    REFERENCES "budgets"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "budget_lines_project_fkey"
    FOREIGN KEY ("organization_id", "project_id")
    REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "budget_lines_cost_center_fkey"
    FOREIGN KEY ("organization_id", "cost_center_id")
    REFERENCES "cost_centers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "budget_lines_business_line_fkey"
    FOREIGN KEY ("organization_id", "business_line_id")
    REFERENCES "business_lines"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "budget_hours_lines"
  ADD CONSTRAINT "budget_hours_lines_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "budget_hours_lines_budget_fkey"
    FOREIGN KEY ("organization_id", "budget_id")
    REFERENCES "budgets"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "budget_hours_project_fk"
    FOREIGN KEY ("organization_id", "project_id")
    REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "budget_hours_cost_center_fk"
    FOREIGN KEY ("organization_id", "cost_center_id")
    REFERENCES "cost_centers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. CHECK de `budgets`
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "budgets"
  ADD CONSTRAINT "budgets_revision_base"     CHECK (("scenario" = 'BASE') = ("revision" = 0)),
  ADD CONSTRAINT "budgets_revision_positive" CHECK ("revision" >= 0),
  ADD CONSTRAINT "budgets_validity"          CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from"),
  -- Sellado ⇔ VIGENTE o SUSTITUIDO, y siempre con los tres sellos: un
  -- `budget_hash` sin `git_sha` no se puede reproducir, y un `sealed_at` sin
  -- hash no acredita nada.
  ADD CONSTRAINT "budgets_sealed_marks" CHECK (
    ("status" = 'BORRADOR') = ("sealed_at" IS NULL)
    AND ("sealed_at" IS NULL) = ("budget_hash" IS NULL)
    AND ("sealed_at" IS NULL) = ("margin_config_hash" IS NULL)
    AND ("sealed_at" IS NULL) = ("git_sha" IS NULL)),
  ADD CONSTRAINT "budgets_superseded_marks" CHECK (
    ("status" = 'SUSTITUIDO') = ("superseded_by_id" IS NOT NULL)),
  -- O-E10-9: una versión parcial declara desde qué mes sustituye, y ese mes es un
  -- día 1. La CONTINUIDAD (O-E10-8) la exige `sealBudget` en la misma transacción
  -- y la comprueba I-E10-15: un EXCLUDE no puede expresar «sin hueco».
  ADD CONSTRAINT "budgets_partial_from_first_day" CHECK (
    "partial_from" IS NULL OR date_part('day', "partial_from") = 1);

-- Una sola versión VIGENTE por ejercicio en cada fecha (I-E10-9). `btree_gist`
-- está disponible desde E2.
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_no_overlap"
  EXCLUDE USING gist ("organization_id" WITH =, "fiscal_year_id" WITH =,
                      daterange("valid_from", "valid_to", '[]') WITH &&)
  WHERE ("status" <> 'BORRADOR');

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. CHECK de `budget_lines` — O-A6 (primera mitad), O-E10-23 y O-E10-6
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "budget_lines"
  -- ══ O-A6, primera mitad: el CHECK de exclusividad ══════════════════════════
  ADD CONSTRAINT "budget_lines_one_dimension" CHECK (
    ("project_id" IS NULL) <> ("cost_center_id" IS NULL)),
  ADD CONSTRAINT "budget_lines_bl_needs_project" CHECK (
    "business_line_id" IS NULL OR "project_id" IS NOT NULL),
  -- ══ O-E10-23 ═══════════════════════════════════════════════════════════════
  -- `analytic_type` es OBLIGATORIO en toda línea, tenga cuenta o no. La ronda 1
  -- sólo lo exigía sin cuenta, y ése era el hueco: con el tipo nulo, la primera
  -- rama del CHECK de signo lo dejaba pasar, de modo que un `6400` tecleado en
  -- positivo volvía a entrar por la puerta de atrás, y la celda tampoco tenía
  -- nivel de margen que congelar. La columna ya es NOT NULL; el CHECK se declara
  -- igualmente porque es lo que I-E10-14 nombra y lo que el criterio 4-bis
  -- espera ver en `\d budget_lines`.
  ADD CONSTRAINT "budget_lines_type_required" CHECK ("analytic_type" IS NOT NULL),
  -- Presupuesto de EXPLOTACIÓN: la cuenta, si se declara, es de grupo 6 o 7. El
  -- CAPEX del grupo 2 va a E11 con su propia tabla (Q-4).
  ADD CONSTRAINT "budget_lines_pnl_only" CHECK (
    "account_code" IS NULL OR left("account_code", 1) IN ('6', '7')),
  ADD CONSTRAINT "budget_lines_month_is_first_day" CHECK (
    date_part('day', "month") = 1),
  -- O-E10-7: el nivel viaja con la línea, como en `allocation_lines`.
  ADD CONSTRAINT "budget_lines_margin_level" CHECK (
    "margin_level" IN ('INGRESOS', 'MC1', 'MC2', 'MC3', 'EBITDA', 'EBIT', 'BAI', 'RESULTADO')),
  -- ══ O-E10-6: el signo lo FUERZA el tipo analítico efectivo ══════════════════
  -- Un `6400` tecleado como +1.200.000 contra un real de −1.200.000 daba una
  -- desviación de −2.400.000 c con ejecución exacta: el doble del importe y con
  -- signo de «hemos gastado de más». La validación fina —mensajes y excepciones
  -- por cuenta (R-B-5)— vive en la acción; esto es el refuerzo de la base.
  ADD CONSTRAINT "budget_lines_sign_by_type" CHECK (
    "sign_exception"
    OR "analytic_type" IS NULL
    OR ("analytic_type" = 'INGRESO_DIRECTO' AND "amount_cents" >= 0)
    OR ("analytic_type" IN ('COSTE_DIRECTO_MC1', 'COSTE_DIRECTO_MC2',
                            'INDIRECTO_CECO', 'AMORTIZACION_DETERIORO')
        AND "amount_cents" <= 0)
    OR "analytic_type" IN ('FINANCIERO', 'EXTRAORDINARIO', 'NO_ANALITICO'));

-- ══ O-A6, segunda mitad: CUATRO índices únicos PARCIALES ═════════════════════
-- Un `@@unique(budget_id, month, account_code, project_id, cost_center_id)` NO
-- sirve: `NULL <> NULL` en PostgreSQL, así que dos filas con `account_code` nulo
-- o con `cost_center_id` nulo NO colisionan y el duplicado entra. Es la deuda
-- O-A6 literal, abierta desde E4 y fechada en E5 para esta migración.
CREATE UNIQUE INDEX "budget_lines_unique_proj_account" ON "budget_lines"
  ("organization_id", "budget_id", "month", "project_id", "account_code")
  WHERE "project_id" IS NOT NULL AND "account_code" IS NOT NULL;
CREATE UNIQUE INDEX "budget_lines_unique_proj_total" ON "budget_lines"
  ("organization_id", "budget_id", "month", "project_id", "analytic_type")
  WHERE "project_id" IS NOT NULL AND "account_code" IS NULL;
CREATE UNIQUE INDEX "budget_lines_unique_ceco_account" ON "budget_lines"
  ("organization_id", "budget_id", "month", "cost_center_id", "account_code")
  WHERE "cost_center_id" IS NOT NULL AND "account_code" IS NOT NULL;
CREATE UNIQUE INDEX "budget_lines_unique_ceco_total" ON "budget_lines"
  ("organization_id", "budget_id", "month", "cost_center_id", "analytic_type")
  WHERE "cost_center_id" IS NOT NULL AND "account_code" IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. CHECK e índices de `budget_hours_lines` — O-E10-10
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "budget_hours_lines"
  ADD CONSTRAINT "budget_hours_one_dimension" CHECK (
    ("project_id" IS NULL) <> ("cost_center_id" IS NULL)),
  ADD CONSTRAINT "budget_hours_nonneg" CHECK ("minutes" >= 0),
  ADD CONSTRAINT "budget_hours_month_is_first_day" CHECK (
    date_part('day', "month") = 1);

-- Cuatro índices PARCIALES, no un `COALESCE`: misma doctrina que O-A6 en
-- `budget_lines`. El `COALESCE` de la ronda 0 funcionaba, pero enterraba la
-- exclusividad en una expresión y no era legible en `\d`.
CREATE UNIQUE INDEX "budget_hours_unique_proj" ON "budget_hours_lines"
  ("organization_id", "budget_id", "month", "project_id", "employee_id")
  WHERE "project_id" IS NOT NULL AND "employee_id" IS NOT NULL;
CREATE UNIQUE INDEX "budget_hours_unique_proj_total" ON "budget_hours_lines"
  ("organization_id", "budget_id", "month", "project_id")
  WHERE "project_id" IS NOT NULL AND "employee_id" IS NULL;
CREATE UNIQUE INDEX "budget_hours_unique_ceco" ON "budget_hours_lines"
  ("organization_id", "budget_id", "month", "cost_center_id", "employee_id")
  WHERE "cost_center_id" IS NOT NULL AND "employee_id" IS NOT NULL;
CREATE UNIQUE INDEX "budget_hours_unique_ceco_total" ON "budget_hours_lines"
  ("organization_id", "budget_id", "month", "cost_center_id")
  WHERE "cost_center_id" IS NOT NULL AND "employee_id" IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Triggers — lo que ningún CHECK puede expresar porque MIRA OTRA TABLA
-- ─────────────────────────────────────────────────────────────────────────────

-- 6.a `business_line_id` coherente con el proyecto (R-A9, I-E10-8).
--     VERIFICA, nunca rellena: rellenar rompería `budget_hash`, que es la misma
--     lección que E4 aprendió con las líneas del diario.
CREATE OR REPLACE FUNCTION app.assert_budget_line_business_line()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_bl uuid;
BEGIN
  IF NEW."project_id" IS NULL THEN
    IF NEW."business_line_id" IS NOT NULL THEN
      RAISE EXCEPTION 'línea de presupuesto %: `business_line_id` sin proyecto (R-A9)', NEW."id"
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT "business_line_id" INTO v_bl
    FROM "projects"
   WHERE "id" = NEW."project_id" AND "organization_id" = NEW."organization_id";

  IF NEW."business_line_id" IS DISTINCT FROM v_bl THEN
    RAISE EXCEPTION 'línea de presupuesto %: `business_line_id` (%) no es la del proyecto (%) — R-A9',
      NEW."id", NEW."business_line_id", v_bl USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "budget_lines_business_line_denorm"
  BEFORE INSERT OR UPDATE ON "budget_lines"
  FOR EACH ROW EXECUTE FUNCTION app.assert_budget_line_business_line();

-- 6.b El mes cae DENTRO del ejercicio de la versión (I-E10-1). El MISMO trigger
--     se aplica a `budget_hours_lines` (O-E10-10): en la ronda 0 las horas
--     podían presupuestarse en un mes de otro ejercicio y nada lo veía.
CREATE OR REPLACE FUNCTION app.assert_budget_month_in_fiscal_year()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_start date;
  v_end   date;
BEGIN
  SELECT fy."start_date", fy."end_date" INTO v_start, v_end
    FROM "budgets" b
    JOIN "fiscal_years" fy
      ON fy."id" = b."fiscal_year_id" AND fy."organization_id" = b."organization_id"
   WHERE b."id" = NEW."budget_id" AND b."organization_id" = NEW."organization_id";

  IF v_start IS NULL THEN
    RAISE EXCEPTION 'la versión de presupuesto % no existe en la organización %',
      NEW."budget_id", NEW."organization_id" USING ERRCODE = '23503';
  END IF;

  IF NEW."month" < date_trunc('month', v_start)::date OR NEW."month" > v_end THEN
    RAISE EXCEPTION 'mes % fuera del ejercicio de la versión (% … %) — I-E10-1',
      NEW."month", v_start, v_end USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "budget_lines_month_in_fiscal_year"
  BEFORE INSERT OR UPDATE ON "budget_lines"
  FOR EACH ROW EXECUTE FUNCTION app.assert_budget_month_in_fiscal_year();

CREATE TRIGGER "budget_hours_lines_month_in_fiscal_year"
  BEFORE INSERT OR UPDATE ON "budget_hours_lines"
  FOR EACH ROW EXECUTE FUNCTION app.assert_budget_month_in_fiscal_year();

-- 6.c `margin_level` coincide con el que resolverían el tipo efectivo y el
--     `CostCenter.marginLevel` VIGENTES (O-E10-7, I-E10-1). VERIFICA, nunca
--     rellena, por la misma razón que 6.a.
--
--     Espeja `resolveLevel` de `lib/analytics/margins.ts`:
--       INDIRECTO_CECO → `cost_centers.margin_level` del CECO de la línea
--       NO_ANALITICO   → RESULTADO si la cuenta empieza por 630/633/638
--                        (`INCOME_TAX_PREFIXES`, lib/analytics/types.ts),
--                        si no `organizations.non_analytic_level`  (R-A11)
--       resto          → `margin_level_configs` vigente AL MES; sin
--                        configuración, el mismo respaldo de NO_ANALITICO
--     `CostCenter.marginLevel` NO se aplica a ningún otro tipo: un `668` en
--     CC-FIN cae en BAI, no en EBITDA (R-A6).
CREATE OR REPLACE FUNCTION app.assert_budget_line_margin_level()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_expected "margin_level";
  v_fallback "margin_level";
BEGIN
  IF NEW."account_code" IS NOT NULL
     AND (NEW."account_code" LIKE '630%' OR NEW."account_code" LIKE '633%' OR NEW."account_code" LIKE '638%')
  THEN
    v_fallback := 'RESULTADO';
  ELSE
    SELECT "non_analytic_level" INTO v_fallback
      FROM "organizations" WHERE "id" = NEW."organization_id";
  END IF;

  IF NEW."analytic_type" = 'INDIRECTO_CECO' THEN
    SELECT "margin_level" INTO v_expected
      FROM "cost_centers"
     WHERE "id" = NEW."cost_center_id" AND "organization_id" = NEW."organization_id";
    IF v_expected IS NULL THEN
      RAISE EXCEPTION 'línea de presupuesto %: `INDIRECTO_CECO` sin centro de coste conocido (R-A6)', NEW."id"
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."analytic_type" = 'NO_ANALITICO' THEN
    v_expected := v_fallback;
  ELSE
    SELECT mlc."level" INTO v_expected
      FROM "margin_level_configs" mlc
     WHERE mlc."organization_id" = NEW."organization_id"
       AND NEW."analytic_type" = ANY (mlc."analytic_types")
       AND mlc."valid_from" <= NEW."month"
       AND (mlc."valid_to" IS NULL OR mlc."valid_to" >= NEW."month")
     ORDER BY mlc."valid_from" DESC
     LIMIT 1;
    IF v_expected IS NULL THEN v_expected := v_fallback; END IF;
  END IF;

  IF NEW."margin_level" <> v_expected THEN
    RAISE EXCEPTION 'línea de presupuesto %: `margin_level` % ≠ el vigente para % (%) — O-E10-7',
      NEW."id", NEW."margin_level", NEW."analytic_type", v_expected USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "budget_lines_margin_level_matches"
  BEFORE INSERT OR UPDATE ON "budget_lines"
  FOR EACH ROW EXECUTE FUNCTION app.assert_budget_line_margin_level();

-- 6.d La dimensión está VIVA en el mes presupuestado (I-E10-8): ni archivada, ni
--     el CECO de sistema `SIN_ASIGNAR`, ni un proyecto cerrado ANTES del mes.
--     Presupuestar a `CC-FIN`/`CC-EXT`/`CC-NA` SÍ está permitido (R-B-4): son
--     costes reales que hay que prever, sólo que esas columnas no se liquidan.
CREATE OR REPLACE FUNCTION app.assert_budget_dimension_alive()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_archived timestamp(3);
  v_code     varchar(24);
  v_status   "project_status";
  v_closed   date;
  v_system   boolean;
BEGIN
  IF NEW."project_id" IS NOT NULL THEN
    SELECT "archived_at", "status", "closed_at", "code"
      INTO v_archived, v_status, v_closed, v_code
      FROM "projects"
     WHERE "id" = NEW."project_id" AND "organization_id" = NEW."organization_id";
    IF v_archived IS NOT NULL THEN
      RAISE EXCEPTION 'proyecto % archivado: no admite presupuesto (I-E10-8)', v_code USING ERRCODE = '23514';
    END IF;
    -- Un proyecto cerrado admite presupuesto de los meses ANTERIORES a su cierre
    -- (el año en que se cerró tuvo plan); de los posteriores, no.
    IF v_status = 'CLOSED' AND v_closed IS NOT NULL AND NEW."month" > v_closed THEN
      RAISE EXCEPTION 'proyecto % cerrado el %: no admite presupuesto de % (I-E10-8)',
        v_code, v_closed, NEW."month" USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT "archived_at", "is_system", "code"
      INTO v_archived, v_system, v_code
      FROM "cost_centers"
     WHERE "id" = NEW."cost_center_id" AND "organization_id" = NEW."organization_id";
    IF v_archived IS NOT NULL THEN
      RAISE EXCEPTION 'centro de coste % archivado: no admite presupuesto (I-E10-8)', v_code USING ERRCODE = '23514';
    END IF;
    IF v_code = 'SIN_ASIGNAR' THEN
      RAISE EXCEPTION 'el centro de coste de sistema SIN_ASIGNAR no admite presupuesto (I-E10-8)'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "budget_lines_dimension_alive"
  BEFORE INSERT ON "budget_lines"
  FOR EACH ROW EXECUTE FUNCTION app.assert_budget_dimension_alive();

CREATE TRIGGER "budget_hours_lines_dimension_alive"
  BEFORE INSERT ON "budget_hours_lines"
  FOR EACH ROW EXECUTE FUNCTION app.assert_budget_dimension_alive();

-- 6.e Una versión NO `BORRADOR` es INMUTABLE salvo en las columnas de la
--     ceremonia de sellado y sustitución (I-E10-6, R-B-3).
CREATE OR REPLACE FUNCTION app.assert_budget_immutable_when_sealed()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD."status" = 'BORRADOR' THEN RETURN NEW; END IF;

  IF NEW."id"                 IS DISTINCT FROM OLD."id"
     OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
     OR NEW."fiscal_year_id"  IS DISTINCT FROM OLD."fiscal_year_id"
     OR NEW."scenario"        IS DISTINCT FROM OLD."scenario"
     OR NEW."revision"        IS DISTINCT FROM OLD."revision"
     OR NEW."valid_from"      IS DISTINCT FROM OLD."valid_from"
     OR NEW."partial_from"    IS DISTINCT FROM OLD."partial_from"
     OR NEW."budget_hash"     IS DISTINCT FROM OLD."budget_hash"
     OR NEW."margin_config_hash" IS DISTINCT FROM OLD."margin_config_hash"
     OR NEW."git_sha"         IS DISTINCT FROM OLD."git_sha"
     OR NEW."sealed_at"       IS DISTINCT FROM OLD."sealed_at"
     OR NEW."sealed_by_id"    IS DISTINCT FROM OLD."sealed_by_id"
     OR NEW."created_by_id"   IS DISTINCT FROM OLD."created_by_id"
     OR NEW."created_at"      IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'la versión de presupuesto % está sellada: sólo admite `status`, `valid_to`, `superseded_by_id`, `name`, `note` y `updated_at` (I-E10-6)',
      OLD."id" USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "budgets_immutable_when_sealed"
  BEFORE UPDATE ON "budgets"
  FOR EACH ROW EXECUTE FUNCTION app.assert_budget_immutable_when_sealed();

-- 6.f Las líneas de una versión SELLADA no se tocan (I-E10-6). En `BORRADOR` se
--     editan y se borran libremente: es una hoja de cálculo y nadie ha afirmado
--     nada todavía.
CREATE OR REPLACE FUNCTION app.assert_budget_lines_not_sealed()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  -- `COALESCE(NEW, OLD)` no vale en plpgsql: son variables de tipo registro, no
  -- expresiones. Se elige por `TG_OP`.
  v_row    record;
  v_status "budget_status";
BEGIN
  IF TG_OP = 'DELETE' THEN v_row := OLD; ELSE v_row := NEW; END IF;

  SELECT "status" INTO v_status
    FROM "budgets"
   WHERE "id" = v_row."budget_id" AND "organization_id" = v_row."organization_id";

  -- La versión puede estar borrándose en cascada con su organización: no hay
  -- nada que proteger.
  IF v_status IS NULL THEN RETURN v_row; END IF;

  IF v_status <> 'BORRADOR' THEN
    RAISE EXCEPTION 'la versión de presupuesto % está sellada (%): sus líneas son inmutables (I-E10-6)',
      v_row."budget_id", v_status USING ERRCODE = '23514';
  END IF;
  RETURN v_row;
END
$fn$;

CREATE TRIGGER "budget_lines_no_write_when_sealed"
  BEFORE INSERT OR UPDATE OR DELETE ON "budget_lines"
  FOR EACH ROW EXECUTE FUNCTION app.assert_budget_lines_not_sealed();

CREATE TRIGGER "budget_hours_lines_no_write_when_sealed"
  BEFORE INSERT OR UPDATE OR DELETE ON "budget_hours_lines"
  FOR EACH ROW EXECUTE FUNCTION app.assert_budget_lines_not_sealed();

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. RLS estricta (ADR-0009) y privilegios
--
--    Las tres entran a la vez en `TENANT_MODELS` (lib/db.ts): o están las dos
--    cosas, o la barrera 1 no las acota y una consulta fuera de `tenantDb`
--    devuelve VACÍO en silencio.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['budgets', 'budget_lines', 'budget_hours_lines'] LOOP
    PERFORM app.enforce_tenant_rls(t);
  END LOOP;
END $$;

-- OJO: `ALTER DEFAULT PRIVILEGES` de esta base concede `arwd` a `app_runtime`
-- sobre TODA tabla nueva, así que un `GRANT SELECT, INSERT` no acota nada: hay
-- que REVOCAR primero. Sin este `REVOKE`, el semi-append-only de la cabecera y
-- su GRANT de columna serían decorativos y la prueba de privilegio pasaría por
-- vacuidad (lección de `closing_runs`, E9 M4).
REVOKE UPDATE, DELETE ON "budgets" FROM app_runtime;

-- Las líneas de un BORRADOR se editan y se borran: es una hoja de cálculo. El
-- sellado lo protege el trigger 6.f, no el privilegio.
GRANT SELECT, INSERT, UPDATE, DELETE ON "budget_lines", "budget_hours_lines" TO app_runtime;

-- La cabecera es SEMI-append-only (patrón ADR-0010 / `manual_review_flags`).
GRANT SELECT, INSERT ON "budgets" TO app_runtime;
GRANT UPDATE ("status", "valid_to", "superseded_by_id", "budget_hash",
              "margin_config_hash", "git_sha", "sealed_at", "sealed_by_id",
              "name", "note", "updated_at") ON "budgets" TO app_runtime;
CREATE POLICY "budgets_no_delete" ON "budgets" AS RESTRICTIVE FOR DELETE USING (false);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "budgets", "budget_lines", "budget_hours_lines" TO app_maintenance;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Verificación: ninguna tabla queda en NO FORCE (ADR-0009 §7)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['budgets', 'budget_lines', 'budget_hours_lines'] LOOP
    IF NOT (SELECT relforcerowsecurity FROM pg_class WHERE relname = t) THEN
      RAISE EXCEPTION '% ha quedado en NO FORCE ROW LEVEL SECURITY', t;
    END IF;
  END LOOP;
END $$;
