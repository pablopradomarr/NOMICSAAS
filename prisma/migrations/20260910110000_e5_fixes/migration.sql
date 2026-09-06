-- ─────────────────────────────────────────────────────────────────────────────
-- E5 · ronda 1 de corrección — barreras que faltaban en la liquidación de CECOs
--
-- Aditiva. NO edita ninguna migración aplicada. Ejecutable por un rol NO
-- superusuario (Supabase: `postgres` con rolsuper = false): sólo `ALTER TABLE`,
-- `CREATE FUNCTION`/`TRIGGER` y `GRANT` sobre objetos propios.
--
--  1. `allocation_runs.lines_hash` — el sello de la SALIDA del run
--     (auditoría E5, hallazgo 1). Sin él, mover el céntimo de remanente de
--     Hamilton entre dos receptores del mismo (run, regla, nivel) por `UPDATE`
--     directo era INDETECTABLE: Σ por fuente, cierre a 0, cota de I-E5-4 y total
--     del run se mantienen, y todos los invariantes daban PASS.
--  2. `bigint` en `amount_cents`, `driver_base`, `driver_base_total` y
--     `total_allocated_cents` (auditoría E5, hallazgo 4 · revisión #11): con
--     `integer` el techo son 21 474 836,47 €, dentro del rango de producto
--     declarado en CLAUDE.md («hasta 100 M€»), y `driver_base_total` agrega la
--     base de TODO un periodo. El sellado fallaba con `integer out of range`,
--     un error crudo de base de datos.
--  3. `Σ percent_bps = 10000` en toda regla `FIXED_PERCENT`, como CONSTRAINT
--     TRIGGER DIFERIDO (BUG-E5-1 del QA · I-E5-2). Un `CHECK` no puede
--     expresarlo: agrega sobre otras filas. Diferido porque la regla y sus
--     destinos se insertan en la misma sentencia.
--  4. Inmutabilidad de `allocation_rule_targets` cuando la regla ya emitió
--     líneas (revisión #5). El trigger de 20260910100000 sólo protegía
--     `allocation_rules`; los destinos tenían `GRANT … UPDATE` y ningún trigger,
--     así que «el pasado no cambia» no era demostrable.
--  5. El `linesHash` entra en la lista de columnas inmutables de
--     `allocation_runs` (append-only).
--
-- Sin backfill de datos: `lines_hash` queda NULL en los runs anteriores a esta
-- migración (I-E5-12 los declara «sin sello de líneas» en vez de fingir uno), y
-- el cambio de tipo de las cuatro columnas es DDL puro. Por tanto **no hace
-- falta el patrón `NO FORCE → UPDATE → FORCE`**: no hay ni una sentencia DML.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Sello de las líneas del run
ALTER TABLE "allocation_runs"
  ADD COLUMN IF NOT EXISTS "lines_hash" char(64);

COMMENT ON COLUMN "allocation_runs"."lines_hash" IS
  'sha256 de las líneas del run en forma canónica (lib/analytics/allocate.ts::canonicalLinesForm). Sella la SALIDA, no sólo las entradas: I-E5-12 lo verifica sobre datos. NULL en runs anteriores a 20260910110000.';

-- 2. Techos aritméticos: bigint
ALTER TABLE "allocation_lines"
  ALTER COLUMN "amount_cents"       TYPE bigint,
  ALTER COLUMN "driver_base"        TYPE bigint,
  ALTER COLUMN "driver_base_total"  TYPE bigint;

ALTER TABLE "allocation_runs"
  ALTER COLUMN "total_allocated_cents" TYPE bigint;

COMMENT ON COLUMN "allocation_lines"."amount_cents" IS
  'Céntimos ENTEROS, bigint (auditoría E5 hallazgo 4): con integer el techo eran 21.474.836,47 €, por debajo del rango de producto. Convención de COSTE: positivo = coste que sale del CECO fuente.';

-- 3. I-E5-2 en la BASE: Σ percent_bps = 10000 por regla FIXED_PERCENT
CREATE OR REPLACE FUNCTION app.allocation_rules_fixed_percent_100()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_rule_id uuid;
  v_org     uuid;
  v_bad     text;
BEGIN
  IF TG_TABLE_NAME = 'allocation_rules' THEN
    v_rule_id := NEW."id";
    v_org     := NEW."organization_id";
  ELSE
    v_rule_id := NEW."rule_id";
    v_org     := NEW."organization_id";
  END IF;

  SELECT string_agg(r."code", ', ') INTO v_bad
    FROM "allocation_rules" r
   WHERE r."organization_id" = v_org
     AND r."id" = v_rule_id
     AND r."driver" = 'FIXED_PERCENT'
     AND COALESCE((SELECT sum(t."percent_bps")
                     FROM "allocation_rule_targets" t
                    WHERE t."organization_id" = r."organization_id"
                      AND t."rule_id" = r."id"), 0) <> 10000;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'la regla % reparte un porcentaje distinto del 100%%: Σ de porcentajes de una regla FIXED_PERCENT debe ser exactamente 10000 bps', v_bad
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER "allocation_rules_fixed_percent_100"
  AFTER INSERT OR UPDATE ON "allocation_rules"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.allocation_rules_fixed_percent_100();

CREATE CONSTRAINT TRIGGER "allocation_rule_targets_fixed_percent_100"
  AFTER INSERT OR UPDATE ON "allocation_rule_targets"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.allocation_rules_fixed_percent_100();

-- 4. Versionado sin agujeros: los DESTINOS de una regla con líneas tampoco se
--    tocan. `DELETE` ya está prohibido por GRANT + política RESTRICTIVE, así que
--    basta con cubrir `INSERT` (añadir un destino a una regla ya usada cambiaría
--    el reparto futuro sin versionar) y `UPDATE`.
CREATE OR REPLACE FUNCTION app.allocation_rule_targets_immutable_when_used()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_used boolean;
  v_code text;
BEGIN
  SELECT EXISTS (SELECT 1 FROM "allocation_lines" l
                  WHERE l."organization_id" = NEW."organization_id"
                    AND l."rule_id" = NEW."rule_id")
    INTO v_used;
  IF NOT v_used THEN RETURN NEW; END IF;

  -- Un UPDATE que no cambia nada (reescritura idéntica) no es un cambio.
  IF TG_OP = 'UPDATE'
     AND (NEW."project_id", NEW."business_line_id", NEW."cost_center_id",
          NEW."percent_bps", NEW."amount_cents", NEW."sort_order", NEW."rule_id")
         IS NOT DISTINCT FROM
         (OLD."project_id", OLD."business_line_id", OLD."cost_center_id",
          OLD."percent_bps", OLD."amount_cents", OLD."sort_order", OLD."rule_id") THEN
    RETURN NEW;
  END IF;

  SELECT r."code" INTO v_code FROM "allocation_rules" r
   WHERE r."organization_id" = NEW."organization_id" AND r."id" = NEW."rule_id";

  RAISE EXCEPTION 'la regla % ya ha emitido líneas: sus destinos no se editan, ciérrala con valid_to y crea una versión nueva', COALESCE(v_code, NEW."rule_id"::text)
    USING ERRCODE = '23514';
END
$fn$;

CREATE TRIGGER "allocation_rule_targets_immutable_when_used"
  BEFORE INSERT OR UPDATE ON "allocation_rule_targets"
  FOR EACH ROW EXECUTE FUNCTION app.allocation_rule_targets_immutable_when_used();

-- 5. `lines_hash` es append-only como el resto del run
CREATE OR REPLACE FUNCTION app.allocation_runs_append_only()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW."id", NEW."organization_id", NEW."fiscal_year_id", NEW."period_kind",
      NEW."period_start", NEW."period_end", NEW."ledger_hash", NEW."analytics_hash",
      NEW."rules_hash", NEW."lines_hash", NEW."git_sha", NEW."line_count",
      NEW."total_allocated_cents", NEW."warnings", NEW."run_by_id", NEW."run_at")
     IS DISTINCT FROM
     (OLD."id", OLD."organization_id", OLD."fiscal_year_id", OLD."period_kind",
      OLD."period_start", OLD."period_end", OLD."ledger_hash", OLD."analytics_hash",
      OLD."rules_hash", OLD."lines_hash", OLD."git_sha", OLD."line_count",
      OLD."total_allocated_cents", OLD."warnings", OLD."run_by_id", OLD."run_at") THEN
    RAISE EXCEPTION 'allocation_runs es append-only: sólo status, superseded_by_id, reversed_at, reversed_by_id y reversal_reason admiten UPDATE'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

-- 6. Guarda final: ninguna tabla de negocio queda en NO FORCE
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO v_bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity AND NOT c.relforcerowsecurity;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'tablas con RLS sin FORCE tras la migración de correcciones de E5: %', v_bad;
  END IF;
END $$;
