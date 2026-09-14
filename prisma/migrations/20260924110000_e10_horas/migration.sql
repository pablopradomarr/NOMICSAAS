-- E10 · T4 — M3: `employees`, `employee_rates`, `headcount_snapshots`,
-- `time_entries`, y las cinco columnas de configuración de `organizations`
-- (docs/design/E10-presupuesto-horas.md §2.3, ADR-0018 D1/D3).
--
-- Aditiva pura y ejecutable por un rol NO superusuario. Las cuatro tablas nacen
-- VACÍAS y las cinco columnas nacen con DEFAULT, así que no hay backfill de
-- cifras y no hace falta el baile `NO FORCE` → backfill → `FORCE`.
--
-- Tiempo en MINUTOS ENTEROS (Q-2): la fuente primaria es el registro de jornada
-- del art. 34.9 ET, que se lleva en `hh:mm`, y todo `hh:mm` es un entero exacto
-- de minutos mientras que en centésimas no lo es (un minuto son 5/3 centésimas).
-- FTE en milésimas (`fte_milli`, 1000 = jornada completa).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Tablas
-- ─────────────────────────────────────────────────────────────────────────────

-- `Employee` es un maestro de CONTROLLING, no un expediente laboral: E10 no
-- calcula nóminas (`SPEC-FUNCIONAL.md` §4), las lee.
CREATE TABLE "employees" (
  "id"                     uuid         NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"        uuid         NOT NULL,
  "code"                   varchar(24)  NOT NULL,
  "name"                   varchar(120) NOT NULL,
  -- Enlaces OPCIONALES al maestro documental de E8 y al usuario: hay empleados
  -- que no entran en la aplicación y notas de gasto de quien no imputa horas.
  "counterparty_id"        uuid,
  "user_id"                uuid,
  "default_cost_center_id" uuid,
  -- Jornada en milésimas de FTE. Entra en el driver `HEADCOUNT`.
  "fte_milli"              integer      NOT NULL DEFAULT 1000,
  "hire_date"              date,
  "end_date"               date,
  "is_active"              boolean      NOT NULL DEFAULT true,
  "archived_at"            timestamp(3),
  "created_at"             timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             timestamp(3) NOT NULL,
  CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "employees_organization_id_code_key" ON "employees" ("organization_id", "code");
CREATE UNIQUE INDEX "employees_organization_id_id_key"   ON "employees" ("organization_id", "id");
CREATE INDEX "employees_organization_id_is_active_idx"   ON "employees" ("organization_id", "is_active");

-- Una tarifa no se edita: se cierra su vigencia y se abre otra (patrón `TaxRate`
-- de E2). Por eso es APPEND-ONLY pura y por eso lleva `EXCLUDE` de vigencias.
CREATE TABLE "employee_rates" (
  "id"                uuid                   NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"   uuid                   NOT NULL,
  "employee_id"       uuid                   NOT NULL,
  -- Céntimos por hora, entero y > 0 (ADR-0006).
  "hourly_cost_cents" integer                NOT NULL,
  "basis"             "employee_rate_basis"  NOT NULL,
  "source"            "employee_rate_source" NOT NULL DEFAULT 'DECLARADO',
  -- Sólo con `DERIVADO_NOMINA`: los TÉRMINOS exactos con los que salió la cifra,
  -- para que el número se pueda rehacer a mano (O-E10-12). Un coste-hora
  -- derivado sin sus términos es un número de origen desconocido.
  "derivation"        jsonb,
  "valid_from"        date                   NOT NULL,
  "valid_to"          date,
  "note"              varchar(400),
  "created_by_id"     uuid,
  "created_at"        timestamp(3)           NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "employee_rates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "employee_rates_organization_id_employee_id_valid_from_idx"
  ON "employee_rates" ("organization_id", "employee_id", "valid_from");

-- Plantilla a FIN DE MES por CECO. El driver `HEADCOUNT` lee esta tabla y sólo
-- esta tabla: un snapshot con `fte_milli = 0` SÍ es un dato y no mueve nada; la
-- diferencia entre «no hay nadie» y «no lo hemos rellenado» es lo que ADR-0013
-- D4 existe para no perder (R-C-2).
CREATE TABLE "headcount_snapshots" (
  "id"              uuid               NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" uuid               NOT NULL,
  "cost_center_id"  uuid               NOT NULL,
  "period_end"      date               NOT NULL,
  "fte_milli"       integer            NOT NULL,
  "headcount"       integer            NOT NULL,
  "source"          "headcount_source" NOT NULL DEFAULT 'MANUAL',
  "note"            varchar(400),
  "created_by_id"   uuid,
  "created_at"      timestamp(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "headcount_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "headcount_snapshots_org_cost_center_period_end_key"
  ON "headcount_snapshots" ("organization_id", "cost_center_id", "period_end");
CREATE INDEX "headcount_snapshots_organization_id_period_end_idx"
  ON "headcount_snapshots" ("organization_id", "period_end");

CREATE TABLE "time_entries" (
  "id"                uuid                NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"   uuid                NOT NULL,
  "employee_id"       uuid                NOT NULL,
  -- Fecha del TRABAJO, no de la captura. Cae dentro de un `FiscalYear` abierto.
  "date"              date                NOT NULL,
  "project_id"        uuid,
  "cost_center_id"    uuid,
  "business_line_id"  uuid,
  -- Minutos enteros. 7 h 20 min = 440, exacto. Positivo en una entrada normal;
  -- NEGATIVO sólo en un contra-apunte.
  "minutes"           integer             NOT NULL,
  -- Sólo las PRODUCTIVAS alimentan el driver `HOURS` y el denominador del
  -- coste-hora (Q-3, modelo A de absorción plena): la tarifa ya absorbe el coste
  -- de las no productivas, así que ese coste NO se vuelve a repartir.
  "productive"        boolean             NOT NULL DEFAULT true,
  "note"              varchar(400),
  "source"            "time_entry_source" NOT NULL DEFAULT 'MANUAL',
  "status"            "time_entry_status" NOT NULL DEFAULT 'BORRADOR',
  "approved_at"       timestamp(3),
  "approved_by_id"    uuid,
  "corrects_entry_id" uuid,
  "correction_reason" varchar(1000),
  -- Idempotencia del import CSV: `sha256(fichero ‖ nº de línea)`.
  "import_key"        varchar(64),
  "created_by_id"     uuid,
  "created_at"        timestamp(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "time_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "time_entries_organization_id_id_key" ON "time_entries" ("organization_id", "id");
CREATE INDEX "time_entries_organization_id_date_idx"      ON "time_entries" ("organization_id", "date");
CREATE INDEX "time_entries_organization_id_employee_id_date_idx"
  ON "time_entries" ("organization_id", "employee_id", "date");
CREATE INDEX "time_entries_organization_id_project_id_date_idx"
  ON "time_entries" ("organization_id", "project_id", "date");
CREATE INDEX "time_entries_organization_id_cost_center_id_date_idx"
  ON "time_entries" ("organization_id", "cost_center_id", "date");

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. FK — compuestas POR TENANT (O-A1)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "employees"
  ADD CONSTRAINT "employees_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "employees_default_cost_center_fkey"
    FOREIGN KEY ("organization_id", "default_cost_center_id")
    REFERENCES "cost_centers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "employee_rates"
  ADD CONSTRAINT "employee_rates_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "employee_rates_employee_fkey"
    FOREIGN KEY ("organization_id", "employee_id")
    REFERENCES "employees"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "headcount_snapshots"
  ADD CONSTRAINT "headcount_snapshots_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "headcount_snapshots_cost_center_fkey"
    FOREIGN KEY ("organization_id", "cost_center_id")
    REFERENCES "cost_centers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "time_entries"
  ADD CONSTRAINT "time_entries_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "time_entries_employee_fkey"
    FOREIGN KEY ("organization_id", "employee_id")
    REFERENCES "employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "time_entries_project_fkey"
    FOREIGN KEY ("organization_id", "project_id")
    REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "time_entries_cost_center_fkey"
    FOREIGN KEY ("organization_id", "cost_center_id")
    REFERENCES "cost_centers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "time_entries_business_line_fkey"
    FOREIGN KEY ("organization_id", "business_line_id")
    REFERENCES "business_lines"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "time_entries_corrects_entry_fkey"
    FOREIGN KEY ("corrects_entry_id") REFERENCES "time_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- O-E10-10, la FK que M2 no pudo atar: `employees` no existía todavía. Es la
-- tercera FK compuesta de `budget_hours_lines` y cierra la observación.
ALTER TABLE "budget_hours_lines"
  ADD CONSTRAINT "budget_hours_employee_fk"
    FOREIGN KEY ("organization_id", "employee_id")
    REFERENCES "employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. CHECK
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "employees"
  ADD CONSTRAINT "employees_fte_range"  CHECK ("fte_milli" BETWEEN 0 AND 1000),
  ADD CONSTRAINT "employees_date_order" CHECK ("end_date" IS NULL OR "hire_date" IS NULL OR "end_date" >= "hire_date");

ALTER TABLE "employee_rates"
  ADD CONSTRAINT "employee_rates_positive" CHECK ("hourly_cost_cents" > 0),
  ADD CONSTRAINT "employee_rates_validity" CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from"),
  -- Una derivación sin términos no se puede auditar; unos términos sin
  -- derivación son ruido.
  ADD CONSTRAINT "employee_rates_derivation" CHECK (
    ("source" = 'DERIVADO_NOMINA') = ("derivation" IS NOT NULL));

-- I-E10-5: un coste-hora vigente y SÓLO UNO en cada fecha. Sin tarifa vigente el
-- cálculo es NO EVALUABLE, nunca cero (R-R-1).
ALTER TABLE "employee_rates" ADD CONSTRAINT "employee_rates_no_overlap"
  EXCLUDE USING gist ("organization_id" WITH =, "employee_id" WITH =,
                      daterange("valid_from", "valid_to", '[]') WITH &&);

ALTER TABLE "headcount_snapshots"
  ADD CONSTRAINT "headcount_nonneg" CHECK ("fte_milli" >= 0 AND "headcount" >= 0),
  -- El stock es a FIN de periodo (contrato del experto en E5, confirmado en D1).
  ADD CONSTRAINT "headcount_last_day" CHECK (
    "period_end" = (date_trunc('month', "period_end") + interval '1 month - 1 day')::date);

ALTER TABLE "time_entries"
  ADD CONSTRAINT "time_entries_one_dimension" CHECK (
    ("project_id" IS NULL) <> ("cost_center_id" IS NULL)),
  ADD CONSTRAINT "time_entries_bl_needs_project" CHECK (
    "business_line_id" IS NULL OR "project_id" IS NOT NULL),
  ADD CONSTRAINT "time_entries_minutes_nonzero" CHECK ("minutes" <> 0),
  -- Minutos negativos SÓLO en un contra-apunte, y un contra-apunte SÓLO negativo.
  ADD CONSTRAINT "time_entries_negative_iff_correction" CHECK (
    ("minutes" < 0) = ("corrects_entry_id" IS NOT NULL)),
  ADD CONSTRAINT "time_entries_correction_reason" CHECK (
    "corrects_entry_id" IS NULL
    OR ("correction_reason" IS NOT NULL AND length(btrim("correction_reason")) >= 10)),
  ADD CONSTRAINT "time_entries_approval_marks" CHECK (
    ("status" = 'APROBADO') = ("approved_at" IS NOT NULL)
    AND ("approved_at" IS NULL) = ("approved_by_id" IS NULL)),
  -- Techo de cordura POR FILA: 24 h = 1 440 minutos. Un parte de 30 h es un error
  -- de tecleo, y detectarlo al insertar es más barato que en el informe.
  -- **O-E10-21**: el techo por fila NO basta —cuatro partes de 1 440 dan 96 h en
  -- un día y ningún CHECK lo ve—, así que el agregado
  -- `Σ minutos por (empleado, fecha) ≤ 1 440` va en el trigger 4.f, en I-E10-10 y
  -- como aviso en la acción de alta.
  ADD CONSTRAINT "time_entries_daily_ceiling" CHECK ("minutes" BETWEEN -1440 AND 1440);

CREATE UNIQUE INDEX "time_entries_import_key" ON "time_entries"
  ("organization_id", "import_key") WHERE "import_key" IS NOT NULL;
-- El agregado del driver sólo mira APROBADAS y PRODUCTIVAS: índices parciales.
CREATE INDEX "time_entries_approved_project" ON "time_entries"
  ("organization_id", "project_id", "date") WHERE "status" = 'APROBADO' AND "productive";
CREATE INDEX "time_entries_approved_ceco" ON "time_entries"
  ("organization_id", "cost_center_id", "date") WHERE "status" = 'APROBADO' AND "productive";

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Triggers
-- ─────────────────────────────────────────────────────────────────────────────

-- 4.a Una entrada APROBADA es inmutable (I-E10-4, R-H-1). La ÚNICA transición
--     admitida es `BORRADOR → APROBADO`, que escribe `status`, `approved_at` y
--     `approved_by_id` y nada más.
CREATE OR REPLACE FUNCTION app.assert_time_entry_immutable()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD."status" = 'APROBADO' THEN
    RAISE EXCEPTION 'el parte de horas % está aprobado: es inmutable y se corrige con un CONTRA-APUNTE (I-E10-4)',
      OLD."id" USING ERRCODE = '23514';
  END IF;

  -- `BORRADOR → APROBADO`: sólo las tres columnas de la aprobación.
  IF NEW."status" = 'APROBADO' THEN
    IF NEW."employee_id"     IS DISTINCT FROM OLD."employee_id"
       OR NEW."date"         IS DISTINCT FROM OLD."date"
       OR NEW."project_id"   IS DISTINCT FROM OLD."project_id"
       OR NEW."cost_center_id" IS DISTINCT FROM OLD."cost_center_id"
       OR NEW."business_line_id" IS DISTINCT FROM OLD."business_line_id"
       OR NEW."minutes"      IS DISTINCT FROM OLD."minutes"
       OR NEW."productive"   IS DISTINCT FROM OLD."productive"
       OR NEW."corrects_entry_id" IS DISTINCT FROM OLD."corrects_entry_id"
    THEN
      RAISE EXCEPTION 'la aprobación del parte % sólo puede escribir `status`, `approved_at` y `approved_by_id` (I-E10-4)',
        OLD."id" USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "time_entries_immutable_when_approved"
  BEFORE UPDATE ON "time_entries"
  FOR EACH ROW EXECUTE FUNCTION app.assert_time_entry_immutable();

-- 4.b Una entrada aprobada no se borra. Un BORRADOR sí: nadie ha afirmado nada.
--     Va en trigger y no en política porque una política no puede mirar
--     `OLD.status` en `DELETE` sin bloquear también los borradores.
CREATE OR REPLACE FUNCTION app.assert_time_entry_not_deleted_when_approved()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD."status" = 'APROBADO' THEN
    RAISE EXCEPTION 'el parte de horas % está aprobado: no se borra, se contra-apunta (I-E10-4)',
      OLD."id" USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END
$fn$;

CREATE TRIGGER "time_entries_no_delete_when_approved"
  BEFORE DELETE ON "time_entries"
  FOR EACH ROW EXECUTE FUNCTION app.assert_time_entry_not_deleted_when_approved();

-- 4.c El contra-apunte CASA con su original: mismo empleado, misma fecha, misma
--     dimensión, original APROBADO, y Σ de contra-apuntes que nunca supera en
--     magnitud al original (R-H-2: no se puede «desimputar» más de lo imputado).
CREATE OR REPLACE FUNCTION app.assert_time_entry_correction_mirror()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  o        record;
  v_sofar  bigint;
BEGIN
  IF NEW."corrects_entry_id" IS NULL THEN RETURN NEW; END IF;

  SELECT * INTO o FROM "time_entries"
   WHERE "id" = NEW."corrects_entry_id" AND "organization_id" = NEW."organization_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'el contra-apunte apunta a un parte inexistente en la organización' USING ERRCODE = '23503';
  END IF;
  IF o."status" <> 'APROBADO' THEN
    RAISE EXCEPTION 'sólo se contra-apunta un parte APROBADO: el % está en %', o."id", o."status"
      USING ERRCODE = '23514';
  END IF;
  IF o."corrects_entry_id" IS NOT NULL THEN
    RAISE EXCEPTION 'un contra-apunte no se contra-apunta: corrige el original %', o."corrects_entry_id"
      USING ERRCODE = '23514';
  END IF;
  IF NEW."employee_id" <> o."employee_id"
     OR NEW."date" <> o."date"
     OR NEW."project_id" IS DISTINCT FROM o."project_id"
     OR NEW."cost_center_id" IS DISTINCT FROM o."cost_center_id"
  THEN
    RAISE EXCEPTION 'el contra-apunte no casa con el parte %: empleado, fecha y dimensión deben coincidir', o."id"
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(sum(-"minutes"), 0) INTO v_sofar
    FROM "time_entries"
   WHERE "corrects_entry_id" = o."id" AND "organization_id" = NEW."organization_id";

  IF v_sofar + (-NEW."minutes") > o."minutes" THEN
    RAISE EXCEPTION 'los contra-apuntes del parte % suman % minutos y el original sólo tiene %: no se desimputa más de lo imputado (R-H-2)',
      o."id", v_sofar + (-NEW."minutes"), o."minutes" USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "time_entries_correction_mirror"
  BEFORE INSERT ON "time_entries"
  FOR EACH ROW EXECUTE FUNCTION app.assert_time_entry_correction_mirror();

-- 4.d La fecha cae en un ejercicio ABIERTO y en un mes sin bloqueo (B-9, R-H-5):
--     la cifra de horas alimenta informes ya rendidos.
CREATE OR REPLACE FUNCTION app.assert_time_entry_date_open()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_fy     record;
  v_locked boolean;
BEGIN
  SELECT * INTO v_fy FROM "fiscal_years"
   WHERE "organization_id" = NEW."organization_id"
     AND NEW."date" BETWEEN "start_date" AND "end_date";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'la fecha % no cae en ningún ejercicio de la organización', NEW."date"
      USING ERRCODE = '23514';
  END IF;
  IF v_fy."status" = 'CLOSED' THEN
    RAISE EXCEPTION 'el ejercicio % está cerrado: no admite partes de horas', v_fy."code"
      USING ERRCODE = '23514';
  END IF;

  -- `period_locks` guarda el bloqueo como `(ejercicio, mes)`: la EXISTENCIA de la
  -- fila ES el bloqueo (E3, no hay columna booleana).
  SELECT true INTO v_locked FROM "period_locks"
   WHERE "organization_id" = NEW."organization_id"
     AND "fiscal_year_id" = v_fy."id"
     AND "month" = date_part('month', NEW."date")::integer
   LIMIT 1;

  IF COALESCE(v_locked, false) THEN
    RAISE EXCEPTION 'el periodo de % está bloqueado: no admite partes de horas (B-9)', NEW."date"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "time_entries_date_in_fiscal_year"
  BEFORE INSERT ON "time_entries"
  FOR EACH ROW EXECUTE FUNCTION app.assert_time_entry_date_open();

-- 4.e `business_line_id` coherente con el proyecto: igual que en `budget_lines` y
--     por lo mismo (R-A9). Se reutiliza la función de M2 — la firma es la misma
--     (`project_id`, `business_line_id`, `organization_id`).
CREATE TRIGGER "time_entries_business_line_denorm"
  BEFORE INSERT OR UPDATE ON "time_entries"
  FOR EACH ROW EXECUTE FUNCTION app.assert_budget_line_business_line();

-- 4.f **O-E10-21** — techo AGREGADO por (empleado, día): 1 440 minutos. El CHECK
--     por fila no lo ve (cuatro partes de 1 440 dan 96 h en un día), y aquí sí se
--     puede mirar el resto de filas del día. Los contra-apuntes RESTAN, así que
--     el techo se aplica al NETO, que es la cifra que consume el driver.
CREATE OR REPLACE FUNCTION app.assert_time_entry_daily_ceiling()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_total bigint;
BEGIN
  SELECT COALESCE(sum("minutes"), 0) INTO v_total
    FROM "time_entries"
   WHERE "organization_id" = NEW."organization_id"
     AND "employee_id" = NEW."employee_id"
     AND "date" = NEW."date"
     AND "id" <> NEW."id";

  IF v_total + NEW."minutes" > 1440 THEN
    RAISE EXCEPTION 'el empleado % acumularía % minutos el %: el techo diario es 1 440 (I-E10-10, O-E10-21)',
      NEW."employee_id", v_total + NEW."minutes", NEW."date" USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "time_entries_daily_ceiling_aggregate"
  BEFORE INSERT OR UPDATE ON "time_entries"
  FOR EACH ROW EXECUTE FUNCTION app.assert_time_entry_daily_ceiling();

-- 4.g `fte_milli` dentro de `[0, 1000]` también cuando lo mueve un UPDATE. El
--     CHECK ya lo cubre; el trigger existe para dar el mensaje de dominio que
--     pide el diseño (`employees_fte_range`) sin depender de leer un `23514`.
CREATE OR REPLACE FUNCTION app.assert_employee_fte_range()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."fte_milli" < 0 OR NEW."fte_milli" > 1000 THEN
    RAISE EXCEPTION 'el empleado % tiene fte_milli = %: la jornada va en milésimas de FTE, entre 0 y 1000',
      NEW."code", NEW."fte_milli" USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "employees_fte_range"
  BEFORE INSERT OR UPDATE ON "employees"
  FOR EACH ROW EXECUTE FUNCTION app.assert_employee_fte_range();

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Configuración de la organización (§2.2, «Cambios en modelos existentes»)
--
--    Cinco columnas con DEFAULT: ninguna organización queda sin valor y no hay
--    backfill. El registro de horas es OPCIONAL (`SPEC-FUNCIONAL.md` §3.4), así
--    que nace apagado.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "organizations"
  ADD COLUMN "time_tracking_enabled" boolean NOT NULL DEFAULT false,
  ADD COLUMN "default_rate_basis" "employee_rate_basis" NOT NULL DEFAULT 'COSTE_EMPRESA_CON_SS',
  -- O-E10-19: 90 000 minutos = 1 500 h productivas. El default de la ronda 0
  -- (1 700 h) era JORNADA anual, no horas productivas, e infravaloraba la tarifa
  -- ~12 %. Denominador de RESPALDO, nunca por delante de los partes reales.
  ADD COLUMN "reference_productive_minutes_per_year" integer NOT NULL DEFAULT 90000,
  -- Q-1 / O-E10-11: 640 + 642 + 645 + 649, sin 641.
  ADD COLUMN "payroll_account_prefixes" text[] NOT NULL DEFAULT ARRAY['640', '642', '645', '649'],
  ADD COLUMN "derivation_min_coverage_bps" integer NOT NULL DEFAULT 7500;

ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_reference_minutes_positive"
    CHECK ("reference_productive_minutes_per_year" > 0),
  ADD CONSTRAINT "organizations_derivation_coverage_bps_range"
    CHECK ("derivation_min_coverage_bps" BETWEEN 0 AND 10000);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. RLS estricta (ADR-0009) y privilegios
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['employees', 'employee_rates', 'headcount_snapshots', 'time_entries'] LOOP
    PERFORM app.enforce_tenant_rls(t);
  END LOOP;
END $$;

-- El `ALTER DEFAULT PRIVILEGES` de esta base concede `arwd` a `app_runtime` sobre
-- toda tabla nueva: sin REVOCAR primero, el append-only sería decorativo.
REVOKE UPDATE, DELETE ON "employee_rates", "headcount_snapshots", "time_entries" FROM app_runtime;

GRANT SELECT, INSERT, UPDATE ON "employees" TO app_runtime;
CREATE POLICY "employees_no_delete" ON "employees" AS RESTRICTIVE FOR DELETE USING (false);

-- `employee_rates` y `headcount_snapshots`: APPEND-ONLY puras. Una tarifa no se
-- edita —se cierra su vigencia y se abre otra (patrón `TaxRate`)—, y un snapshot
-- es un hecho fechado. El cierre de vigencia lo hace `app_maintenance` o un
-- `INSERT` de la siguiente tarifa con su `valid_from`.
GRANT SELECT, INSERT ON "employee_rates", "headcount_snapshots" TO app_runtime;
CREATE POLICY "employee_rates_no_update"      ON "employee_rates"      AS RESTRICTIVE FOR UPDATE USING (false);
CREATE POLICY "employee_rates_no_delete"      ON "employee_rates"      AS RESTRICTIVE FOR DELETE USING (false);
CREATE POLICY "headcount_snapshots_no_update" ON "headcount_snapshots" AS RESTRICTIVE FOR UPDATE USING (false);
CREATE POLICY "headcount_snapshots_no_delete" ON "headcount_snapshots" AS RESTRICTIVE FOR DELETE USING (false);

-- `time_entries`: SEMI-append-only con GRANT DE COLUMNA. Sólo las tres columnas
-- de la aprobación; todo lo demás es inmutable por privilegio, y la inmutabilidad
-- de lo YA aprobado —que un privilegio no distingue— la pone el trigger 4.a.
-- El DELETE de un BORRADOR sí se permite: no hay política restrictiva de borrado
-- porque una política no puede mirar `OLD.status`; lo acota el trigger 4.b.
GRANT SELECT, INSERT, DELETE ON "time_entries" TO app_runtime;
GRANT UPDATE ("status", "approved_at", "approved_by_id") ON "time_entries" TO app_runtime;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "employees", "employee_rates", "headcount_snapshots", "time_entries" TO app_maintenance;

-- El cierre de vigencia de una tarifa (`valid_to`) es de `app_maintenance` y de
-- los `models/` que corren con él; `app_runtime` abre la siguiente, no toca la
-- anterior. Queda escrito para que nadie lo dé por olvidado.

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Verificación: ninguna tabla queda en NO FORCE (ADR-0009 §7)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['employees', 'employee_rates', 'headcount_snapshots', 'time_entries'] LOOP
    IF NOT (SELECT relforcerowsecurity FROM pg_class WHERE relname = t) THEN
      RAISE EXCEPTION '% ha quedado en NO FORCE ROW LEVEL SECURITY', t;
    END IF;
  END LOOP;
END $$;
