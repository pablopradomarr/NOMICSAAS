-- E5 · T3 — Liquidación de CECOs (docs/design/E5-liquidacion.md §2.3, ADR-0013).
--
-- Las cuatro tablas nacen VACÍAS, así que no hace falta el patrón
-- `NO FORCE → backfill → FORCE` salvo en el bloque 8 (`report_runs`, que sí
-- tiene filas en preview y cuyo `analytics_key` se recalcula: eso es DML).
--
-- Todo lo que aquí se ejecuta lo puede ejecutar un rol NO superusuario
-- (regla de CLAUDE.md): ni un `ALTER ROLE`, ni un `ALTER FUNCTION ... OWNER TO`,
-- ni una extensión nueva (`btree_gist` ya está desde E2).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Enums
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "target_kind"           AS ENUM ('PROJECTS', 'BUSINESS_LINES', 'COST_CENTERS', 'MIXED');
CREATE TYPE "allocation_driver"     AS ENUM ('FIXED_PERCENT', 'REVENUE_SHARE', 'DIRECT_COST_SHARE',
                                             'HOURS', 'HEADCOUNT', 'EQUAL', 'MANUAL');
CREATE TYPE "alloc_period"          AS ENUM ('MONTH', 'QUARTER', 'YEAR');
CREATE TYPE "zero_base_fallback"    AS ENUM ('SKIP_WARN', 'EQUAL', 'YTD', 'PRIOR_PERIOD');
CREATE TYPE "allocation_run_status" AS ENUM ('DRAFT', 'SEALED', 'SUPERSEDED', 'REVERSED');

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Tablas, con FK compuestas POR TENANT (O-A1)
-- ─────────────────────────────────────────────────────────────────────────────

-- `fiscal_years` necesita la unique compuesta para poder ser destino de la FK
-- por tenant de `allocation_runs` (las demás dimensiones ya la tienen desde E4).
CREATE UNIQUE INDEX IF NOT EXISTS "fiscal_years_organization_id_id_key"
  ON "fiscal_years" ("organization_id", "id");

CREATE TABLE "allocation_rules" (
  "id"                    uuid               NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"       uuid               NOT NULL,
  "code"                  varchar(24)        NOT NULL,
  "name"                  varchar(120)       NOT NULL,
  "source_cost_center_id" uuid               NOT NULL,
  "target_kind"           "target_kind"       NOT NULL,
  "driver"                "allocation_driver" NOT NULL,
  "period"                "alloc_period"      NOT NULL,
  "priority"              integer            NOT NULL,
  "source_share_bps"      integer            NOT NULL DEFAULT 10000,
  "zero_base_fallback"    "zero_base_fallback" NOT NULL DEFAULT 'SKIP_WARN',
  "target_filter"         jsonb,
  "valid_from"            date               NOT NULL,
  "valid_to"              date,
  "is_active"             boolean            NOT NULL DEFAULT true,
  "created_by_id"         uuid,
  "closed_by_id"          uuid,
  "created_at"            timestamp(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            timestamp(3)       NOT NULL,
  CONSTRAINT "allocation_rules_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "allocation_rules_org_code_valid_from_key"
  ON "allocation_rules" ("organization_id", "code", "valid_from");
CREATE UNIQUE INDEX "allocation_rules_organization_id_id_key"
  ON "allocation_rules" ("organization_id", "id");
CREATE INDEX "allocation_rules_org_source_period_priority_idx"
  ON "allocation_rules" ("organization_id", "source_cost_center_id", "period", "priority");
CREATE INDEX "allocation_rules_org_active_validity_idx"
  ON "allocation_rules" ("organization_id", "is_active", "valid_from", "valid_to");

ALTER TABLE "allocation_rules"
  ADD CONSTRAINT "allocation_rules_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "allocation_rules_source_cost_center_fkey"
    FOREIGN KEY ("organization_id", "source_cost_center_id")
    REFERENCES "cost_centers"("organization_id", "id") ON DELETE RESTRICT;

CREATE TABLE "allocation_rule_targets" (
  "id"               uuid         NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"  uuid         NOT NULL,
  "rule_id"          uuid         NOT NULL,
  "project_id"       uuid,
  "business_line_id" uuid,
  "cost_center_id"   uuid,
  "percent_bps"      integer,
  "amount_cents"     integer,
  "sort_order"       integer      NOT NULL DEFAULT 0,
  "created_at"       timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "allocation_rule_targets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "allocation_rule_targets_unique_dest"
  ON "allocation_rule_targets" ("rule_id", "project_id", "business_line_id", "cost_center_id");
CREATE INDEX "allocation_rule_targets_org_rule_sort_idx"
  ON "allocation_rule_targets" ("organization_id", "rule_id", "sort_order");

ALTER TABLE "allocation_rule_targets"
  ADD CONSTRAINT "allocation_rule_targets_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "allocation_rule_targets_rule_fkey"
    FOREIGN KEY ("organization_id", "rule_id")
    REFERENCES "allocation_rules"("organization_id", "id") ON DELETE CASCADE,
  ADD CONSTRAINT "allocation_rule_targets_project_fkey"
    FOREIGN KEY ("organization_id", "project_id")
    REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "allocation_rule_targets_business_line_fkey"
    FOREIGN KEY ("organization_id", "business_line_id")
    REFERENCES "business_lines"("organization_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "allocation_rule_targets_cost_center_fkey"
    FOREIGN KEY ("organization_id", "cost_center_id")
    REFERENCES "cost_centers"("organization_id", "id") ON DELETE RESTRICT;

CREATE TABLE "allocation_runs" (
  "id"                    uuid                    NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"       uuid                    NOT NULL,
  "fiscal_year_id"        uuid                    NOT NULL,
  "period_kind"           "alloc_period"           NOT NULL,
  "period_start"          date                    NOT NULL,
  "period_end"            date                    NOT NULL,
  "status"                "allocation_run_status"  NOT NULL DEFAULT 'SEALED',
  "ledger_hash"           char(64)                NOT NULL,
  "analytics_hash"        char(64)                NOT NULL,
  "rules_hash"            char(64)                NOT NULL,
  "git_sha"               varchar(64)             NOT NULL,
  "line_count"            integer                 NOT NULL DEFAULT 0,
  "total_allocated_cents" integer                 NOT NULL DEFAULT 0,
  "warnings"              jsonb                   NOT NULL DEFAULT '[]',
  "run_by_id"             uuid,
  "run_at"                timestamp(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "superseded_by_id"      uuid,
  "reversed_at"           timestamp(3),
  "reversed_by_id"        uuid,
  "reversal_reason"       varchar(1000),
  CONSTRAINT "allocation_runs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "allocation_runs_organization_id_id_key"
  ON "allocation_runs" ("organization_id", "id");
CREATE INDEX "allocation_runs_org_period_status_idx"
  ON "allocation_runs" ("organization_id", "period_start", "period_end", "status");
CREATE INDEX "allocation_runs_org_fy_kind_start_idx"
  ON "allocation_runs" ("organization_id", "fiscal_year_id", "period_kind", "period_start");

ALTER TABLE "allocation_runs"
  ADD CONSTRAINT "allocation_runs_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "allocation_runs_fiscal_year_fkey"
    FOREIGN KEY ("organization_id", "fiscal_year_id")
    REFERENCES "fiscal_years"("organization_id", "id") ON DELETE RESTRICT,
  -- DIFERIBLE a propósito: un rerun marca el run anterior como SUPERSEDED con el
  -- id del nuevo ANTES de insertarlo, porque el índice único parcial
  -- `allocation_runs_one_sealed_per_period` no admite dos SEALED del mismo
  -- periodo ni por un instante. Con la FK diferida las dos sentencias conviven
  -- dentro de la transacción y la integridad se comprueba al confirmar.
  ADD CONSTRAINT "allocation_runs_superseded_by_fkey"
    FOREIGN KEY ("superseded_by_id") REFERENCES "allocation_runs"("id") ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE "allocation_lines" (
  "id"                      uuid         NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"         uuid         NOT NULL,
  "run_id"                  uuid         NOT NULL,
  "rule_id"                 uuid         NOT NULL,
  "source_cost_center_id"   uuid         NOT NULL,
  "target_project_id"       uuid,
  "target_business_line_id" uuid,
  "target_cost_center_id"   uuid,
  "margin_level"            "margin_level" NOT NULL,
  "amount_cents"            integer      NOT NULL,
  "driver_base"             integer      NOT NULL,
  "driver_base_total"       integer      NOT NULL,
  "driver_share_bps"        integer      NOT NULL,
  "fallback_applied"        "zero_base_fallback",
  "eligibility_reason"      varchar(40),
  "created_at"              timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "allocation_lines_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "allocation_lines_org_run_idx"          ON "allocation_lines" ("organization_id", "run_id");
CREATE INDEX "allocation_lines_org_source_level_idx" ON "allocation_lines" ("organization_id", "source_cost_center_id", "margin_level");
CREATE INDEX "allocation_lines_org_project_idx"      ON "allocation_lines" ("organization_id", "target_project_id");
CREATE INDEX "allocation_lines_org_ceco_idx"         ON "allocation_lines" ("organization_id", "target_cost_center_id");
CREATE INDEX "allocation_lines_org_bl_idx"           ON "allocation_lines" ("organization_id", "target_business_line_id");

ALTER TABLE "allocation_lines"
  ADD CONSTRAINT "allocation_lines_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "allocation_lines_run_fkey"
    FOREIGN KEY ("organization_id", "run_id")
    REFERENCES "allocation_runs"("organization_id", "id") ON DELETE CASCADE,
  ADD CONSTRAINT "allocation_lines_rule_fkey"
    FOREIGN KEY ("organization_id", "rule_id")
    REFERENCES "allocation_rules"("organization_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "allocation_lines_source_cost_center_fkey"
    FOREIGN KEY ("organization_id", "source_cost_center_id")
    REFERENCES "cost_centers"("organization_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "allocation_lines_target_project_fkey"
    FOREIGN KEY ("organization_id", "target_project_id")
    REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "allocation_lines_target_business_line_fkey"
    FOREIGN KEY ("organization_id", "target_business_line_id")
    REFERENCES "business_lines"("organization_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "allocation_lines_target_cost_center_fkey"
    FOREIGN KEY ("organization_id", "target_cost_center_id")
    REFERENCES "cost_centers"("organization_id", "id") ON DELETE RESTRICT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. CHECK declarativos (§2.3 bloque 3)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "allocation_rules"
  ADD CONSTRAINT "allocation_rules_source_share_bps" CHECK ("source_share_bps" BETWEEN 0 AND 10000),
  ADD CONSTRAINT "allocation_rules_priority_positive" CHECK ("priority" >= 0),
  ADD CONSTRAINT "allocation_rules_validity" CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from"),
  -- Pablo, 2026-09-06: HOURS y HEADCOUNT no entran hasta E10. Rechazo en la BD
  -- además de en la acción: una regla inerte reparte 0 € en silencio, que es
  -- exactamente la clase de fallo que la capa de fiabilidad prohíbe.
  ADD CONSTRAINT "allocation_rules_driver_available" CHECK ("driver" NOT IN ('HOURS', 'HEADCOUNT'));

ALTER TABLE "allocation_rule_targets"
  ADD CONSTRAINT "allocation_rule_targets_one_dest" CHECK (
    (("project_id" IS NOT NULL)::int + ("business_line_id" IS NOT NULL)::int
     + ("cost_center_id" IS NOT NULL)::int) = 1),
  ADD CONSTRAINT "allocation_rule_targets_one_value" CHECK (
    ("percent_bps" IS NULL) <> ("amount_cents" IS NULL)),
  ADD CONSTRAINT "allocation_rule_targets_percent_range" CHECK (
    "percent_bps" IS NULL OR "percent_bps" BETWEEN 0 AND 10000);

ALTER TABLE "allocation_runs"
  ADD CONSTRAINT "allocation_runs_period_order" CHECK ("period_end" >= "period_start"),
  ADD CONSTRAINT "allocation_runs_reversal" CHECK (
    ("reversed_at" IS NULL) = ("reversal_reason" IS NULL)
    AND ("reversal_reason" IS NULL OR length("reversal_reason") >= 10)),
  ADD CONSTRAINT "allocation_runs_status_marks" CHECK (
    ("status" = 'SUPERSEDED') = ("superseded_by_id" IS NOT NULL)
    AND ("status" = 'REVERSED') = ("reversed_at" IS NOT NULL)),
  ADD CONSTRAINT "allocation_runs_totals_nonneg" CHECK ("line_count" >= 0);

ALTER TABLE "allocation_lines"
  ADD CONSTRAINT "allocation_lines_one_dest" CHECK (
    (("target_project_id" IS NOT NULL)::int + ("target_business_line_id" IS NOT NULL)::int
     + ("target_cost_center_id" IS NOT NULL)::int) = 1),
  -- E5-D1: el nivel que viaja con el importe sólo puede ser uno de los dos
  -- niveles admisibles para un CECO (mismo CHECK que `cost_centers`).
  ADD CONSTRAINT "allocation_lines_margin_level" CHECK ("margin_level" IN ('MC3', 'EBITDA')),
  ADD CONSTRAINT "allocation_lines_no_self" CHECK (
    "target_cost_center_id" IS NULL OR "target_cost_center_id" <> "source_cost_center_id"),
  ADD CONSTRAINT "allocation_lines_driver_base" CHECK (
    "driver_base" >= 0 AND "driver_base_total" >= 0 AND "driver_share_bps" BETWEEN 0 AND 10000);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. EXCLUDE de vigencias (patrón `TaxRate` de E2): dos versiones de la misma
--    regla nunca se solapan en el tiempo.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "allocation_rules" ADD CONSTRAINT "allocation_rules_no_overlap"
  EXCLUDE USING gist ("organization_id" WITH =, "code" WITH =,
                      daterange("valid_from", "valid_to", '[]') WITH &&);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Un solo run VIGENTE por periodo (índice único PARCIAL, no `@@unique`: con
--    `status` dentro, dos SEALED distintos pasarían con sólo diferir otra
--    columna, y `NULL <> NULL` — lección O-A6).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "allocation_runs_one_sealed_per_period"
  ON "allocation_runs" ("organization_id", "period_start", "period_end")
  WHERE "status" = 'SEALED';

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Triggers de integridad — lo que ningún CHECK puede expresar porque exige
--    mirar otra tabla.
-- ─────────────────────────────────────────────────────────────────────────────

-- 6a. I-E5-5 / I-E5-7 sobre la LÍNEA: ni fuente ni destino no imputables,
--     archivados o en un estado que no admite imputación.
CREATE OR REPLACE FUNCTION app.allocation_lines_allocatable()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_ok boolean; v_code text;
BEGIN
  SELECT c."allocatable" AND c."is_active" AND c."archived_at" IS NULL, c."code"
    INTO v_ok, v_code
    FROM "cost_centers" c
   WHERE c."organization_id" = NEW."organization_id" AND c."id" = NEW."source_cost_center_id";
  IF NOT COALESCE(v_ok, false) THEN
    RAISE EXCEPTION 'el centro de coste fuente % no es imputable, está archivado o no existe', COALESCE(v_code, NEW."source_cost_center_id"::text)
      USING ERRCODE = '23514';
  END IF;

  IF NEW."target_cost_center_id" IS NOT NULL THEN
    SELECT c."allocatable" AND c."is_active" AND c."archived_at" IS NULL, c."code"
      INTO v_ok, v_code
      FROM "cost_centers" c
     WHERE c."organization_id" = NEW."organization_id" AND c."id" = NEW."target_cost_center_id";
    IF NOT COALESCE(v_ok, false) THEN
      RAISE EXCEPTION 'el centro de coste destino % no es imputable o está archivado', COALESCE(v_code, NEW."target_cost_center_id"::text)
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."target_project_id" IS NOT NULL THEN
    SELECT p."is_active" AND p."archived_at" IS NULL AND p."status" <> 'PLANNED', p."code"
      INTO v_ok, v_code
      FROM "projects" p
     WHERE p."organization_id" = NEW."organization_id" AND p."id" = NEW."target_project_id";
    IF NOT COALESCE(v_ok, false) THEN
      RAISE EXCEPTION 'el proyecto destino % está archivado o en estado PLANNED', COALESCE(v_code, NEW."target_project_id"::text)
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."target_business_line_id" IS NOT NULL THEN
    SELECT b."is_active" AND b."archived_at" IS NULL, b."code"
      INTO v_ok, v_code
      FROM "business_lines" b
     WHERE b."organization_id" = NEW."organization_id" AND b."id" = NEW."target_business_line_id";
    IF NOT COALESCE(v_ok, false) THEN
      RAISE EXCEPTION 'la línea de negocio destino % está archivada', COALESCE(v_code, NEW."target_business_line_id"::text)
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "allocation_lines_allocatable"
  BEFORE INSERT ON "allocation_lines"
  FOR EACH ROW EXECUTE FUNCTION app.allocation_lines_allocatable();

-- 6b. I-E5-5 sobre la REGLA y sus targets, en el momento de guardarla.
CREATE OR REPLACE FUNCTION app.allocation_rules_allocatable()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_ok boolean; v_code text;
BEGIN
  SELECT c."allocatable" AND c."is_active" AND c."archived_at" IS NULL, c."code"
    INTO v_ok, v_code
    FROM "cost_centers" c
   WHERE c."organization_id" = NEW."organization_id" AND c."id" = NEW."source_cost_center_id";
  IF NOT COALESCE(v_ok, false) THEN
    RAISE EXCEPTION 'el centro de coste fuente % no es imputable o está archivado', COALESCE(v_code, NEW."source_cost_center_id"::text)
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "allocation_rules_allocatable"
  BEFORE INSERT OR UPDATE ON "allocation_rules"
  FOR EACH ROW EXECUTE FUNCTION app.allocation_rules_allocatable();

CREATE OR REPLACE FUNCTION app.allocation_rule_targets_allocatable()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_ok boolean; v_code text;
BEGIN
  IF NEW."cost_center_id" IS NOT NULL THEN
    SELECT c."allocatable" AND c."is_active" AND c."archived_at" IS NULL, c."code"
      INTO v_ok, v_code
      FROM "cost_centers" c
     WHERE c."organization_id" = NEW."organization_id" AND c."id" = NEW."cost_center_id";
    IF NOT COALESCE(v_ok, false) THEN
      RAISE EXCEPTION 'el centro de coste destino % no es imputable o está archivado', COALESCE(v_code, NEW."cost_center_id"::text)
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."project_id" IS NOT NULL THEN
    SELECT p."is_active" AND p."archived_at" IS NULL AND p."status" <> 'PLANNED', p."code"
      INTO v_ok, v_code
      FROM "projects" p
     WHERE p."organization_id" = NEW."organization_id" AND p."id" = NEW."project_id";
    IF NOT COALESCE(v_ok, false) THEN
      RAISE EXCEPTION 'el proyecto destino % está archivado o en estado PLANNED', COALESCE(v_code, NEW."project_id"::text)
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "allocation_rule_targets_allocatable"
  BEFORE INSERT OR UPDATE ON "allocation_rule_targets"
  FOR EACH ROW EXECUTE FUNCTION app.allocation_rule_targets_allocatable();

-- 6c. I-E5-1 + I-E5-8: DAG y orden topológico del grafo `fuente → CECO destino`
--     de las reglas VIGENTES del mismo `period`. Constraint trigger DIFERIDO:
--     una regla y sus targets se insertan en varias sentencias y el grafo sólo
--     es evaluable cuando la transacción está completa.
CREATE OR REPLACE FUNCTION app.allocation_rules_dag()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_org  uuid := COALESCE(NEW."organization_id", OLD."organization_id");
  v_cycle text;
  v_bad   text;
BEGIN
  -- Aristas vigentes: (period, fuente → CECO destino).
  WITH edges AS (
    SELECT r."period", r."source_cost_center_id" AS src, t."cost_center_id" AS dst,
           r."priority", r."code"
      FROM "allocation_rules" r
      JOIN "allocation_rule_targets" t
        ON t."organization_id" = r."organization_id" AND t."rule_id" = r."id"
     WHERE r."organization_id" = v_org
       AND r."is_active"
       AND t."cost_center_id" IS NOT NULL
  ),
  -- Recorrido con corte por profundidad (R6: 16 saltos).
  walk AS (
    WITH RECURSIVE w(period, origin, node, depth, path, looped) AS (
      SELECT e."period", e.src, e.dst, 1, ARRAY[e.src, e.dst], e.src = e.dst FROM edges e
      UNION ALL
      SELECT w.period, w.origin, e.dst, w.depth + 1, w.path || e.dst, e.dst = ANY(w.path)
        FROM w JOIN edges e ON e."period" = w.period AND e.src = w.node
       WHERE NOT w.looped AND w.depth < 16
    )
    SELECT * FROM w
  )
  SELECT string_agg(DISTINCT array_to_string(path, ' → '), '; ') INTO v_cycle
    FROM walk WHERE looped;

  IF v_cycle IS NOT NULL THEN
    RAISE EXCEPTION 'las reglas de liquidación forman un ciclo: %. Ninguna liquidación puede resolverlo', v_cycle
      USING ERRCODE = '23514';
  END IF;

  -- I-E5-8: para toda arista a → b, TODA regla con fuente b y el mismo `period`
  -- debe tener `priority` estrictamente mayor que la de la regla a → b.
  SELECT string_agg(DISTINCT x, '; ') INTO v_bad FROM (
    SELECT r."code" || ' → ' || r2."code" AS x
      FROM "allocation_rules" r
      JOIN "allocation_rule_targets" t
        ON t."organization_id" = r."organization_id" AND t."rule_id" = r."id"
      JOIN "allocation_rules" r2
        ON r2."organization_id" = r."organization_id"
       AND r2."source_cost_center_id" = t."cost_center_id"
       AND r2."period" = r."period"
       AND r2."is_active"
     WHERE r."organization_id" = v_org
       AND r."is_active"
       AND t."cost_center_id" IS NOT NULL
       AND r2."priority" <= r."priority"
  ) s;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'la prioridad de las reglas no es un orden topológico de la cascada: %', v_bad
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER "allocation_rules_dag"
  AFTER INSERT OR UPDATE ON "allocation_rules"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.allocation_rules_dag();

CREATE CONSTRAINT TRIGGER "allocation_rule_targets_dag"
  AFTER INSERT OR UPDATE ON "allocation_rule_targets"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.allocation_rules_dag();

-- 6d. Versionado: una regla con líneas emitidas NO se edita. Sólo se puede
--     cerrar (`valid_to`), desactivar (`is_active`) y anotar quién la cerró.
CREATE OR REPLACE FUNCTION app.allocation_rules_immutable_when_used()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_used boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM "allocation_lines" l
                  WHERE l."organization_id" = OLD."organization_id" AND l."rule_id" = OLD."id")
    INTO v_used;
  IF NOT v_used THEN RETURN NEW; END IF;

  IF (NEW."code", NEW."name", NEW."source_cost_center_id", NEW."target_kind", NEW."driver",
      NEW."period", NEW."priority", NEW."source_share_bps", NEW."zero_base_fallback",
      NEW."target_filter", NEW."valid_from", NEW."created_by_id")
     IS DISTINCT FROM
     (OLD."code", OLD."name", OLD."source_cost_center_id", OLD."target_kind", OLD."driver",
      OLD."period", OLD."priority", OLD."source_share_bps", OLD."zero_base_fallback",
      OLD."target_filter", OLD."valid_from", OLD."created_by_id") THEN
    RAISE EXCEPTION 'la regla % ya ha emitido líneas: ciérrala con valid_to y crea una versión nueva', OLD."code"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "allocation_rules_immutable_when_used"
  BEFORE UPDATE ON "allocation_rules"
  FOR EACH ROW EXECUTE FUNCTION app.allocation_rules_immutable_when_used();

-- 6e. I-E5-11: `allocation_runs` append-only salvo las cinco columnas de
--     sustitución/reversión (barrera de trigger, además del GRANT de columna).
CREATE OR REPLACE FUNCTION app.allocation_runs_append_only()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW."id", NEW."organization_id", NEW."fiscal_year_id", NEW."period_kind",
      NEW."period_start", NEW."period_end", NEW."ledger_hash", NEW."analytics_hash",
      NEW."rules_hash", NEW."git_sha", NEW."line_count", NEW."total_allocated_cents",
      NEW."warnings", NEW."run_by_id", NEW."run_at")
     IS DISTINCT FROM
     (OLD."id", OLD."organization_id", OLD."fiscal_year_id", OLD."period_kind",
      OLD."period_start", OLD."period_end", OLD."ledger_hash", OLD."analytics_hash",
      OLD."rules_hash", OLD."git_sha", OLD."line_count", OLD."total_allocated_cents",
      OLD."warnings", OLD."run_by_id", OLD."run_at") THEN
    RAISE EXCEPTION 'allocation_runs es append-only: sólo status, superseded_by_id, reversed_at, reversed_by_id y reversal_reason admiten UPDATE'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "allocation_runs_append_only"
  BEFORE UPDATE ON "allocation_runs"
  FOR EACH ROW EXECUTE FUNCTION app.allocation_runs_append_only();

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. RLS estricta y append-only (ADR-0009)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['allocation_rules', 'allocation_rule_targets',
                           'allocation_runs', 'allocation_lines'] LOOP
    PERFORM app.enforce_tenant_rls(t);
  END LOOP;
END $$;

-- Reglas y targets: mutables mientras no tengan líneas (lo cierra el trigger 6d).
GRANT SELECT, INSERT, UPDATE ON "allocation_rules", "allocation_rule_targets" TO app_runtime;
REVOKE DELETE ON "allocation_rules", "allocation_rule_targets" FROM app_runtime;
CREATE POLICY "allocation_rules_no_delete"        ON "allocation_rules"        AS RESTRICTIVE FOR DELETE USING (false);
CREATE POLICY "allocation_rule_targets_no_delete" ON "allocation_rule_targets" AS RESTRICTIVE FOR DELETE USING (false);

-- Runs: append-only con GRANT DE COLUMNA (patrón ADR-0010 / manual_review_flags).
GRANT SELECT, INSERT ON "allocation_runs" TO app_runtime;
REVOKE UPDATE, DELETE ON "allocation_runs" FROM app_runtime;
GRANT UPDATE ("status", "superseded_by_id", "reversed_at", "reversed_by_id", "reversal_reason")
  ON "allocation_runs" TO app_runtime;
CREATE POLICY "allocation_runs_no_delete" ON "allocation_runs" AS RESTRICTIVE FOR DELETE USING (false);

-- Líneas: append-only PURO, como `report_runs`.
GRANT SELECT, INSERT ON "allocation_lines" TO app_runtime;
REVOKE UPDATE, DELETE ON "allocation_lines" FROM app_runtime;
CREATE POLICY "allocation_lines_no_update" ON "allocation_lines" AS RESTRICTIVE FOR UPDATE USING (false);
CREATE POLICY "allocation_lines_no_delete" ON "allocation_lines" AS RESTRICTIVE FOR DELETE USING (false);

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. `report_runs`: `allocation_run_id` (singular) → `allocation_run_set_hash`
--    (O-E5-7). El DDL lo ejecuta el PROPIETARIO y las políticas RESTRICTIVE sólo
--    afectan a DML, así que no hace falta `NO FORCE` para el ALTER; el recálculo
--    del `analytics_key` sí es DML y va bajo `NO FORCE → UPDATE → FORCE`.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "report_runs"
  DROP COLUMN "allocation_run_id",
  ADD COLUMN "allocation_run_set_hash" char(64);

CREATE OR REPLACE FUNCTION app.report_runs_analytics_key()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  NEW."analytics_key" :=
       COALESCE(NEW."analytics_hash", '∅') || '|'
    || COALESCE(NEW."margin_config_hash", '∅') || '|'
    || COALESCE(NEW."allocation_run_set_hash", '∅');
  RETURN NEW;
END
$fn$;

ALTER TABLE "report_runs" NO FORCE ROW LEVEL SECURITY;
UPDATE "report_runs"
   SET "analytics_key" = COALESCE("analytics_hash", '∅') || '|'
                      || COALESCE("margin_config_hash", '∅') || '|'
                      || COALESCE("allocation_run_set_hash", '∅');
ALTER TABLE "report_runs" FORCE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Comentarios de tabla (documentación viva en la propia base)
-- ─────────────────────────────────────────────────────────────────────────────
COMMENT ON TABLE "allocation_rules" IS
  'Reglas de liquidación de CECOs, VERSIONADAS (E5, ADR-0013). Una regla con líneas emitidas no se edita: se cierra con valid_to y se crea otra. Sin DELETE.';
COMMENT ON TABLE "allocation_rule_targets" IS
  'Destinos explícitos de FIXED_PERCENT (percent_bps, Σ = 10000) y MANUAL (amount_cents). Los drivers calculados no tienen targets.';
COMMENT ON TABLE "allocation_runs" IS
  'Liquidación sellada de un periodo (E5). APPEND-ONLY: sólo status, superseded_by_id, reversed_at, reversed_by_id y reversal_reason admiten UPDATE. Sin DELETE. STALE se DERIVA de los tres sellos, no se almacena.';
COMMENT ON TABLE "allocation_lines" IS
  'Celdas de reparto (E5, ADR-0004: NO tocan el libro diario). APPEND-ONLY PURO. margin_level VIAJA CON EL IMPORTE (E5-D1): es el del CECO donde nació el gasto, no el del receptor.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. Guarda final: ninguna tabla de negocio queda en NO FORCE
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO v_bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity AND NOT c.relforcerowsecurity;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'tablas con RLS sin FORCE tras la migración de E5: %', v_bad;
  END IF;
END $$;
