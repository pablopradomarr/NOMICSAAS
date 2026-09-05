-- E4 · T3/T4 — Analítica base (docs/design/E4-analitica.md §2.7).
--
-- Crea las tres tablas de dimensiones con RLS estricta, extiende el `Project`
-- heredado (D-E4-1: se extiende, NO se recrea), retira el CHECK
-- `journal_lines_analytics_e4` de E3 y ata las FK compuestas por tenant (O-A1),
-- añade los CHECK de O-A2, siembra los ocho CECOs y la `MarginLevelConfig` de
-- cada organización, recalcula todos los `entry_hash` con la forma canónica v2
-- (E4-D2) y abre la puerta acotada de la reclasificación analítica (ADR-0010,
-- APROBADO).
--
-- Orden obligatorio de ADR-0009 §7 y del runbook de ESTADO.md: **la marca de
-- conversión va ANTES de cualquier backfill**, y todo backfill corre bajo
-- `NO FORCE → backfill → FORCE` dentro de esta misma transacción.

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. Marca de conversión (hallazgo #7b de E3: marca primero, backfill después)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE v_marked boolean := COALESCE(obj_description(
  (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'journal_entries'), 'pg_class'
) LIKE '%e4_analytics_backfill%', false);
BEGIN
  IF v_marked THEN
    RAISE EXCEPTION 'la marca e4_analytics_backfill ya está puesta: esta migración no se repite';
  END IF;
  EXECUTE 'COMMENT ON TABLE "journal_entries" IS ' || quote_literal(
    'Asientos del libro diario. e4_analytics_backfill — entry_hash recalculado con la forma canónica v2 (E4-D2); hash_version = 2.'
  );
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Enums
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "project_status"   AS ENUM ('PLANNED', 'ACTIVE', 'CLOSED');
CREATE TYPE "cost_center_kind" AS ENUM ('MARKETING_VENTAS', 'OPERACIONES_INDIRECTAS', 'G_A',
                                        'DESARROLLO_PRODUCTO', 'FINANCIERO', 'EXTRAORDINARIO',
                                        'OTROS', 'SIN_ASIGNAR');
CREATE TYPE "margin_level"     AS ENUM ('INGRESOS', 'MC1', 'MC2', 'MC3', 'EBITDA', 'EBIT', 'BAI', 'RESULTADO');

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Tablas nuevas
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "business_lines" (
  "id"              uuid         NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" uuid         NOT NULL,
  "code"            varchar(24)  NOT NULL,
  "name"            varchar(120) NOT NULL,
  "color"           varchar(9)   NOT NULL DEFAULT '#0A0A0A',
  "sort_order"      integer      NOT NULL DEFAULT 0,
  "is_active"       boolean      NOT NULL DEFAULT true,
  "archived_at"     timestamp(3),
  "is_system"       boolean      NOT NULL DEFAULT false,
  "created_at"      timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      timestamp(3) NOT NULL,
  CONSTRAINT "business_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "business_lines_organization_id_code_key" ON "business_lines" ("organization_id", "code");
CREATE UNIQUE INDEX "business_lines_organization_id_id_key"   ON "business_lines" ("organization_id", "id");
CREATE INDEX "business_lines_organization_id_is_active_sort_order_idx"
  ON "business_lines" ("organization_id", "is_active", "sort_order");
ALTER TABLE "business_lines" ADD CONSTRAINT "business_lines_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "cost_centers" (
  "id"              uuid             NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" uuid             NOT NULL,
  "code"            varchar(24)      NOT NULL,
  "name"            varchar(120)     NOT NULL,
  "kind"            cost_center_kind NOT NULL,
  "margin_level"    margin_level     NOT NULL,
  "allocatable"     boolean          NOT NULL DEFAULT true,
  "sort_order"      integer          NOT NULL DEFAULT 0,
  "is_active"       boolean          NOT NULL DEFAULT true,
  "archived_at"     timestamp(3),
  "origin"          account_origin   NOT NULL DEFAULT 'MANUAL',
  "is_system"       boolean          NOT NULL DEFAULT false,
  "created_at"      timestamp(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      timestamp(3)     NOT NULL,
  CONSTRAINT "cost_centers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "cost_centers_organization_id_code_key" ON "cost_centers" ("organization_id", "code");
CREATE UNIQUE INDEX "cost_centers_organization_id_id_key"   ON "cost_centers" ("organization_id", "id");
CREATE INDEX "cost_centers_organization_id_is_active_sort_order_idx"
  ON "cost_centers" ("organization_id", "is_active", "sort_order");
CREATE INDEX "cost_centers_organization_id_kind_idx" ON "cost_centers" ("organization_id", "kind");
ALTER TABLE "cost_centers" ADD CONSTRAINT "cost_centers_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "margin_level_configs" (
  "id"              uuid            NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" uuid            NOT NULL,
  "level"           margin_level    NOT NULL,
  "label"           varchar(60)     NOT NULL,
  "analytic_types"  analytic_type[] NOT NULL DEFAULT ARRAY[]::analytic_type[],
  "sort_order"      integer         NOT NULL,
  "is_visible"      boolean         NOT NULL DEFAULT true,
  "valid_from"      date            NOT NULL,
  "valid_to"        date,
  "created_at"      timestamp(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      timestamp(3)    NOT NULL,
  CONSTRAINT "margin_level_configs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "margin_level_configs_organization_id_level_valid_from_key"
  ON "margin_level_configs" ("organization_id", "level", "valid_from");
CREATE INDEX "margin_level_configs_organization_id_valid_from_valid_to_idx"
  ON "margin_level_configs" ("organization_id", "valid_from", "valid_to");
ALTER TABLE "margin_level_configs" ADD CONSTRAINT "margin_level_configs_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. CHECKs de las tablas nuevas (§2.7)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "cost_centers"
  ADD CONSTRAINT "cost_centers_margin_level" CHECK ("margin_level" IN ('MC3', 'EBITDA')),
  ADD CONSTRAINT "cost_centers_unassigned_is_system"
    CHECK ("kind" <> 'SIN_ASIGNAR' OR ("is_system" AND NOT "allocatable" AND "is_active"));

ALTER TABLE "margin_level_configs"
  ADD CONSTRAINT "margin_level_configs_dates" CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from"),
  -- MLC-2: MC3 y EBITDA reciben INDIRECTO_CECO por `CostCenter.marginLevel`,
  -- jamás por lista: listarlo contaría el importe dos veces.
  ADD CONSTRAINT "margin_level_configs_no_indirect_list"
    CHECK ("level" NOT IN ('MC3', 'EBITDA') OR NOT ('INDIRECTO_CECO' = ANY("analytic_types"))),
  ADD CONSTRAINT "margin_level_configs_indirect_only_ceco"
    CHECK ("level" IN ('MC3', 'EBITDA') OR NOT ('INDIRECTO_CECO' = ANY("analytic_types")));

-- Sin solape de vigencias por (organización, nivel). btree_gist ya está desde E2.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "margin_level_configs"
  ADD CONSTRAINT "margin_level_configs_no_overlap"
  EXCLUDE USING gist ("organization_id" WITH =, "level" WITH =,
                      daterange("valid_from", "valid_to", '[]') WITH &&);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. `organizations.non_analytic_level` (MLC-5)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "organizations" ADD COLUMN "non_analytic_level" margin_level NOT NULL DEFAULT 'EBITDA';
ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_non_analytic_level"
  CHECK ("non_analytic_level" IN ('EBITDA', 'EBIT', 'BAI'));

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. `projects` extendido (D-E4-1) y `journal_entries.hash_version`
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "projects"
  ADD COLUMN "business_line_id"     uuid,
  ADD COLUMN "counterparty_id"      uuid,
  ADD COLUMN "status"               project_status NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "start_date"           date,
  ADD COLUMN "end_date"             date,
  ADD COLUMN "closed_at"            date,
  ADD COLUMN "closed_by_id"         uuid,
  ADD COLUMN "budget_revenue_cents" integer,
  ADD COLUMN "budget_cost_cents"    integer,
  ADD COLUMN "sort_order"           integer      NOT NULL DEFAULT 0,
  ADD COLUMN "is_active"            boolean      NOT NULL DEFAULT true,
  ADD COLUMN "archived_at"          timestamp(3),
  ADD COLUMN "updated_at"           timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX "projects_organization_id_id_key" ON "projects" ("organization_id", "id");
CREATE INDEX "projects_organization_id_business_line_id_idx" ON "projects" ("organization_id", "business_line_id");
CREATE INDEX "projects_organization_id_status_is_active_idx" ON "projects" ("organization_id", "status", "is_active");

ALTER TABLE "projects"
  ADD CONSTRAINT "projects_dates" CHECK ("end_date" IS NULL OR "start_date" IS NULL OR "end_date" >= "start_date"),
  ADD CONSTRAINT "projects_closed_has_date" CHECK ("status" <> 'CLOSED' OR "closed_at" IS NOT NULL),
  ADD CONSTRAINT "projects_budget_nonneg"
    CHECK (("budget_revenue_cents" IS NULL OR "budget_revenue_cents" >= 0)
       AND ("budget_cost_cents"    IS NULL OR "budget_cost_cents"    >= 0));

ALTER TABLE "journal_entries" ADD COLUMN "hash_version" integer NOT NULL DEFAULT 2;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. RLS estricta de las tablas nuevas (ADR-0009) y privilegios
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['business_lines', 'cost_centers', 'margin_level_configs'] LOOP
    PERFORM app.enforce_tenant_rls(t);
  END LOOP;
END $$;

-- Sin DELETE: nada se borra, se archiva. El borrado real de una dimensión sin
-- líneas ni transacciones lo hace `app_maintenance` desde scripts/.
GRANT SELECT, INSERT, UPDATE ON "business_lines", "cost_centers", "margin_level_configs" TO app_runtime;
CREATE POLICY "business_lines_no_delete"       ON "business_lines"       AS RESTRICTIVE FOR DELETE USING (false);
CREATE POLICY "cost_centers_no_delete"         ON "cost_centers"         AS RESTRICTIVE FOR DELETE USING (false);
CREATE POLICY "margin_level_configs_no_delete" ON "margin_level_configs" AS RESTRICTIVE FOR DELETE USING (false);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Backfill (§2.7 bloque 2), bajo el patrón NO FORCE → backfill → FORCE
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "business_lines"       NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "cost_centers"         NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "margin_level_configs" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "projects"             NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "journal_lines"        NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "journal_entries"      NO FORCE ROW LEVEL SECURITY;

-- El CHECK de E3 que forzaba las tres dimensiones a NULL sale AQUÍ: el backfill
-- 7e las escribe. Las FK compuestas se atan después, ya con los datos puestos.
ALTER TABLE "journal_lines" DROP CONSTRAINT "journal_lines_analytics_e4";

-- 7a. Línea de negocio GENERAL (isSystem) en toda organización.
INSERT INTO "business_lines" ("organization_id", "code", "name", "sort_order", "is_system", "updated_at")
SELECT o."id", 'GENERAL', 'General', 1, true, CURRENT_TIMESTAMP
  FROM "organizations" o
 ON CONFLICT ("organization_id", "code") DO NOTHING;

-- 7b. `projects.business_line_id` + NOT NULL + FK compuesta.
UPDATE "projects" p
   SET "business_line_id" = b."id"
  FROM "business_lines" b
 WHERE b."organization_id" = p."organization_id" AND b."code" = 'GENERAL'
   AND p."business_line_id" IS NULL;

-- 7c. Los ocho CECOs por defecto (§2.8), `origin = SEED`.
INSERT INTO "cost_centers"
  ("organization_id", "code", "name", "kind", "margin_level", "allocatable", "sort_order", "origin", "is_system", "updated_at")
SELECT o."id", d."code", d."name", d."kind"::cost_center_kind, d."margin_level"::margin_level,
       d."allocatable", d."sort_order", 'SEED'::account_origin, d."is_system", CURRENT_TIMESTAMP
  FROM "organizations" o
 CROSS JOIN (VALUES
   ('CC-OPS', 'Operaciones indirectas',   'OPERACIONES_INDIRECTAS', 'MC3',    true,  1, false),
   ('CC-DEV', 'Desarrollo de producto',   'DESARROLLO_PRODUCTO',    'MC3',    true,  2, false),
   ('CC-MKT', 'Marketing y ventas',       'MARKETING_VENTAS',       'EBITDA', true,  3, false),
   ('CC-GA',  'General y administración', 'G_A',                    'EBITDA', true,  4, false),
   ('CC-FIN', 'Financiero',               'FINANCIERO',             'EBITDA', false, 5, false),
   ('CC-EXT', 'Otros extraordinarios',    'EXTRAORDINARIO',         'EBITDA', false, 6, false),
   ('CC-OTR', 'Otros',                    'OTROS',                  'EBITDA', true,  7, false),
   ('CC-NA',  'Sin asignar',              'SIN_ASIGNAR',            'EBITDA', false, 8, true)
 ) AS d("code", "name", "kind", "margin_level", "allocatable", "sort_order", "is_system")
 ON CONFLICT ("organization_id", "code") DO NOTHING;

-- 7d. Las ocho filas de MarginLevelConfig. `valid_from` = inicio del ejercicio
--     más antiguo de la organización, o 1970-01-01 si todavía no tiene ninguno.
INSERT INTO "margin_level_configs"
  ("organization_id", "level", "label", "analytic_types", "sort_order", "valid_from", "updated_at")
SELECT o."id", d."level"::margin_level, d."label", d."types"::analytic_type[], d."sort_order",
       COALESCE((SELECT min(fy."start_date") FROM "fiscal_years" fy WHERE fy."organization_id" = o."id"), DATE '1970-01-01'),
       CURRENT_TIMESTAMP
  FROM "organizations" o
 CROSS JOIN (VALUES
   ('INGRESOS',  'Ingresos de proyecto',                                 '{INGRESO_DIRECTO}',           1),
   ('MC1',       'Margen de contribución 1 (tras aprovisionamiento)',    '{COSTE_DIRECTO_MC1}',         2),
   ('MC2',       'Margen de contribución 2 (tras costes directos)',      '{COSTE_DIRECTO_MC2}',         3),
   ('MC3',       'Margen de contribución 3 (tras estructura operativa)', '{}',                          4),
   ('EBITDA',    'EBITDA',                                               '{}',                          5),
   ('EBIT',      'EBIT (tras amortizaciones y deterioros)',              '{AMORTIZACION_DETERIORO}',    6),
   ('BAI',       'Resultado antes de impuestos',                         '{FINANCIERO,EXTRAORDINARIO}', 7),
   ('RESULTADO', 'Resultado del ejercicio',                              '{NO_ANALITICO}',              8)
 ) AS d("level", "label", "types", "sort_order")
 ON CONFLICT ("organization_id", "level", "valid_from") DO NOTHING;

-- 7e. §2.4: las líneas 6/7 con destino exigible y sin dimensión se rutean al
--     CECO `CC-NA` de su organización. Hoy son 0 filas (E3 las forzaba a NULL
--     con el CHECK `journal_lines_analytics_e4`), y queda registrado.
DO $$
DECLARE v_rows integer;
BEGIN
  UPDATE "journal_lines" l
     SET "cost_center_id" = c."id"
    FROM "cost_centers" c
   WHERE c."organization_id" = l."organization_id" AND c."code" = 'CC-NA'
     AND left(l."account_code", 1) IN ('6', '7')
     AND COALESCE(l."analytic_type"::text, '') <> 'NO_ANALITICO'
     AND l."project_id" IS NULL AND l."cost_center_id" IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE 'E4 · ruteo a CC-NA de líneas 6/7 sin destino: % fila(s)', v_rows;
END $$;

-- 7f. E4-D2: recálculo de `journal_entries.entry_hash` con la forma canónica v2
--     (todas las columnas de la línea, `∅` para nulos, TSV, orden
--     `(entry_date, entry_number, line_no)`) — idéntica a
--     `lib/ledger/hash.ts::canonicalEntryForm`. Un test de integración compara
--     ambos caminos, que es lo que impide que diverjan.
DO $$
DECLARE v_rows integer;
BEGIN
  UPDATE "journal_entries" e
     SET "entry_hash" = h."hash", "hash_version" = 2
    FROM (
      SELECT l."entry_id",
             encode(sha256(convert_to(
               string_agg(l."fila", E'\n' ORDER BY l."entry_date", l."entry_number", l."line_no"), 'UTF8')), 'hex') AS "hash"
        FROM (
          SELECT jl."entry_id", jl."entry_date", je."entry_number", jl."line_no",
                 concat_ws(E'\t',
                   jl."entry_id"::text,
                   je."entry_number"::text,
                   jl."line_no"::text,
                   jl."account_code",
                   jl."debit_cents"::text,
                   jl."credit_cents"::text,
                   to_char(jl."entry_date", 'YYYY-MM-DD'),
                   COALESCE(jl."fiscal_year_id"::text, '∅'),
                   jl."entry_kind"::text,
                   COALESCE(jl."tax_rate_id"::text, '∅'),
                   COALESCE(jl."tax_base_cents"::text, '∅'),
                   COALESCE(jl."counterparty_id"::text, '∅'),
                   COALESCE(to_char(jl."due_date", 'YYYY-MM-DD'), '∅'),
                   COALESCE(NULLIF(jl."description", ''), '∅'),
                   COALESCE(jl."analytic_type"::text, '∅'),
                   COALESCE(jl."project_id"::text, '∅'),
                   COALESCE(jl."cost_center_id"::text, '∅'),
                   COALESCE(jl."business_line_id"::text, '∅')
                 ) AS "fila"
            FROM "journal_lines" jl
            JOIN "journal_entries" je ON je."id" = jl."entry_id"
        ) AS l
       GROUP BY l."entry_id"
    ) AS h
   WHERE h."entry_id" = e."id";
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE 'E4-D2 · entry_hash recalculado a la forma v2 en % asiento(s)', v_rows;
END $$;

-- Los constraint triggers diferidos de E3 dejan eventos pendientes tras el
-- backfill y `ALTER TABLE` los rechaza ("pending trigger events"). Se fuerzan
-- aquí: si el backfill hubiese descuadrado algo, esta línea lo revienta ahora.
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE "journal_entries"      FORCE ROW LEVEL SECURITY;
ALTER TABLE "journal_lines"        FORCE ROW LEVEL SECURITY;
ALTER TABLE "projects"             FORCE ROW LEVEL SECURITY;
ALTER TABLE "margin_level_configs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "cost_centers"         FORCE ROW LEVEL SECURITY;
ALTER TABLE "business_lines"       FORCE ROW LEVEL SECURITY;

ALTER TABLE "projects" ALTER COLUMN "business_line_id" SET NOT NULL;
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_business_line_fk"
  FOREIGN KEY ("organization_id", "business_line_id")
  REFERENCES "business_lines"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. `journal_lines`: fuera el CHECK de E3, dentro las FK compuestas (O-A1)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_project_fk" FOREIGN KEY ("organization_id", "project_id")
    REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "journal_lines_cost_center_fk" FOREIGN KEY ("organization_id", "cost_center_id")
    REFERENCES "cost_centers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "journal_lines_business_line_fk" FOREIGN KEY ("organization_id", "business_line_id")
    REFERENCES "business_lines"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "journal_lines" VALIDATE CONSTRAINT "journal_lines_project_fk";
ALTER TABLE "journal_lines" VALIDATE CONSTRAINT "journal_lines_cost_center_fk";
ALTER TABLE "journal_lines" VALIDATE CONSTRAINT "journal_lines_business_line_fk";

-- O-A2 · I-E4-2 e I-E4-5, las dos barreras que faltaban.
ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_analytic_dest_xor"
    CHECK ("project_id" IS NULL OR "cost_center_id" IS NULL),
  ADD CONSTRAINT "journal_lines_business_line_needs_project"
    CHECK ("business_line_id" IS NULL OR "project_id" IS NOT NULL),
  ADD CONSTRAINT "journal_lines_analytics_only_pnl"
    CHECK (left("account_code", 1) IN ('6', '7')
           OR ("project_id" IS NULL AND "cost_center_id" IS NULL
               AND "business_line_id" IS NULL AND "analytic_type" IS NULL));

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Coherencia de la denormalización (R-A9): el código la escribe, la base la
--    VERIFICA. Nunca la rellena: rompería `entry_hash`.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.journal_lines_business_line_denorm() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_bl uuid;
BEGIN
  IF NEW."project_id" IS NULL THEN
    IF NEW."business_line_id" IS NOT NULL THEN
      RAISE EXCEPTION 'línea % con línea de negocio pero sin proyecto', NEW."line_no"
        USING ERRCODE = '23514', CONSTRAINT = 'journal_lines_business_line_denorm';
    END IF;
    RETURN NEW;
  END IF;
  SELECT "business_line_id" INTO v_bl FROM "projects"
   WHERE "organization_id" = NEW."organization_id" AND "id" = NEW."project_id";
  IF v_bl IS DISTINCT FROM NEW."business_line_id" THEN
    RAISE EXCEPTION 'línea %: línea de negocio % no coincide con la del proyecto (%)',
      NEW."line_no", NEW."business_line_id", v_bl
      USING ERRCODE = '23514', CONSTRAINT = 'journal_lines_business_line_denorm';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER journal_lines_business_line_denorm
  BEFORE INSERT OR UPDATE ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION app.journal_lines_business_line_denorm();

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. Reclasificación analítica (ADR-0010 APROBADO, salvaguardas 1, 2 y 4)
-- ─────────────────────────────────────────────────────────────────────────────
-- E3 dejó `journal_lines` con una política RESTRICTIVE que prohíbe todo UPDATE.
-- Se sustituye por otra que autoriza EXACTAMENTE la reclasificación: el resto
-- de columnas queda cerrado por GRANT y por el trigger de abajo.
DROP POLICY IF EXISTS "journal_lines_no_update" ON "journal_lines";

GRANT UPDATE ("project_id", "cost_center_id", "business_line_id", "analytic_type")
  ON "journal_lines" TO app_runtime;
GRANT UPDATE ("entry_hash") ON "journal_entries" TO app_runtime;

CREATE OR REPLACE FUNCTION app.journal_lines_only_analytics_update() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW."id", NEW."organization_id", NEW."entry_id", NEW."line_no", NEW."account_code",
      NEW."debit_cents", NEW."credit_cents", NEW."description", NEW."tax_rate_id",
      NEW."tax_base_cents", NEW."counterparty_id", NEW."due_date", NEW."entry_date",
      NEW."fiscal_year_id", NEW."entry_kind")
     IS DISTINCT FROM
     (OLD."id", OLD."organization_id", OLD."entry_id", OLD."line_no", OLD."account_code",
      OLD."debit_cents", OLD."credit_cents", OLD."description", OLD."tax_rate_id",
      OLD."tax_base_cents", OLD."counterparty_id", OLD."due_date", OLD."entry_date",
      OLD."fiscal_year_id", OLD."entry_kind")
  THEN
    RAISE EXCEPTION 'una línea posteada solo admite reclasificación analítica (ADR-0010)'
      USING ERRCODE = '23514', CONSTRAINT = 'journal_lines_only_analytics_update';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER journal_lines_only_analytics_update
  BEFORE UPDATE ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION app.journal_lines_only_analytics_update();

-- Ventana (C-R2): nunca con el ejercicio cerrado. El mes bloqueado lo autoriza
-- la acción con rol ADMIN; aquí se corta lo que ningún rol puede hacer.
CREATE OR REPLACE FUNCTION app.journal_lines_reclassify_window() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_status text;
BEGIN
  SELECT "status"::text INTO v_status FROM "fiscal_years" WHERE "id" = NEW."fiscal_year_id";
  IF v_status = 'CLOSED' THEN
    RAISE EXCEPTION 'el ejercicio está cerrado: su analítica no se reclasifica'
      USING ERRCODE = '23514', CONSTRAINT = 'journal_lines_reclassify_window';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER journal_lines_reclassify_window
  BEFORE UPDATE ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION app.journal_lines_reclassify_window();

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. Índices de apoyo a los checks de Auditoría
-- ─────────────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS "journal_lines_organization_id_project_id_idx";
DROP INDEX IF EXISTS "journal_lines_organization_id_cost_center_id_idx";
CREATE INDEX "journal_lines_organization_id_project_id_entry_date_idx"
  ON "journal_lines" ("organization_id", "project_id", "entry_date");
CREATE INDEX "journal_lines_organization_id_cost_center_id_entry_date_idx"
  ON "journal_lines" ("organization_id", "cost_center_id", "entry_date");
CREATE INDEX "journal_lines_organization_id_business_line_id_entry_date_idx"
  ON "journal_lines" ("organization_id", "business_line_id", "entry_date");
CREATE INDEX "journal_lines_no_analytic_dest"
  ON "journal_lines" ("organization_id", "entry_date")
  WHERE "project_id" IS NULL AND "cost_center_id" IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 12. Ninguna tabla puede quedar en NO FORCE (lo comprueba integration-rls)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['business_lines', 'cost_centers', 'margin_level_configs',
                           'projects', 'journal_lines', 'journal_entries'] LOOP
    IF NOT (SELECT relforcerowsecurity FROM pg_class WHERE relname = t) THEN
      RAISE EXCEPTION '% ha quedado en NO FORCE ROW LEVEL SECURITY', t;
    END IF;
  END LOOP;
END $$;
