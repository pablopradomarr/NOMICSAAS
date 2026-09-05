-- E3 · T1 — Libro diario (docs/design/E3-libro-diario.md §2.2 y §2.4).
--
-- Cuatro tablas nuevas (fiscal_years, period_locks, journal_entries,
-- journal_lines), el enganche de `transactions` y la integridad que NO puede
-- vivir solo en la app: CHECKs, EXCLUDE de solape de ejercicios, FK compuesta de
-- denormalización, constraint triggers DIFERIDOS de partida doble, triggers de
-- periodo/cuenta postable, índice único parcial de anulación, trigger anti
-- contra-contra-asiento, GRANTs de columna y RLS estricta con FORCE.
--
-- O-7: `organizations.prorrata_permille` (‰) → `prorrata_bps` (bps), valor × 10.

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. Enums
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "fy_status" AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE "entry_kind" AS ENUM ('NORMAL', 'OPENING', 'CLOSING', 'REGULARIZATION', 'REVERSAL', 'RECURRING');
CREATE TYPE "source_type" AS ENUM ('MANUAL', 'DOCUMENT', 'INVOICE_OUT', 'BANK_IMPORT', 'CSV_IMPORT', 'RECURRING', 'SYSTEM');
CREATE TYPE "transaction_status" AS ENUM ('DRAFT', 'PROPOSED', 'POSTED', 'VOID');

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. O-7 — prorrata en puntos básicos
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "organizations" DROP CONSTRAINT IF EXISTS "organizations_prorrata_permille_check";
ALTER TABLE "organizations" RENAME COLUMN "prorrata_permille" TO "prorrata_bps";
UPDATE "organizations" SET "prorrata_bps" = "prorrata_bps" * 10 WHERE "prorrata_bps" IS NOT NULL;
ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_prorrata_bps_check"
  CHECK ("prorrata_bps" IS NULL OR "prorrata_bps" BETWEEN 0 AND 10000);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Tablas
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "fiscal_years" (
  "id"                uuid        NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"   uuid        NOT NULL,
  "code"              varchar(16) NOT NULL,
  "start_date"        date        NOT NULL,
  "end_date"          date        NOT NULL,
  "status"            "fy_status" NOT NULL DEFAULT 'OPEN',
  "last_entry_number" integer     NOT NULL DEFAULT 0,
  "closed_at"         timestamp(3),
  "closed_by_id"      uuid,
  "created_at"        timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        timestamp(3) NOT NULL,
  CONSTRAINT "fiscal_years_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "period_locks" (
  "id"              uuid NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "fiscal_year_id"  uuid NOT NULL,
  "month"           integer NOT NULL,
  "locked_at"       timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_by_id"    uuid,
  "reason"          varchar(512),
  CONSTRAINT "period_locks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "journal_entries" (
  "id"                uuid    NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"   uuid    NOT NULL,
  "fiscal_year_id"    uuid    NOT NULL,
  "entry_number"      integer NOT NULL,
  "document_date"     date,
  "accrual_date"      date,
  "entry_date"        date    NOT NULL,
  "description"       varchar(512) NOT NULL,
  "kind"              "entry_kind" NOT NULL DEFAULT 'NORMAL',
  "tax_rounding_mode" "tax_rounding_mode" NOT NULL DEFAULT 'PER_TIPO',
  "source_type"       "source_type" NOT NULL DEFAULT 'MANUAL',
  "source_id"         varchar(128),
  "transaction_id"    uuid,
  "file_id"           uuid,
  "extraction_run_id" uuid,
  "template_code"     varchar(32),
  "reverses_entry_id" uuid,
  "voided_at"         timestamp(3),
  "voided_by_id"      uuid,
  "void_reason"       varchar(512),
  "posted_by_id"      uuid    NOT NULL,
  "posted_at"         timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "entry_hash"        varchar(64) NOT NULL,
  CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "journal_lines" (
  "id"               uuid    NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"  uuid    NOT NULL,
  "entry_id"         uuid    NOT NULL,
  "line_no"          integer NOT NULL,
  "account_code"     varchar(12) NOT NULL,
  "debit_cents"      integer NOT NULL DEFAULT 0,
  "credit_cents"     integer NOT NULL DEFAULT 0,
  "description"      varchar(512),
  "project_id"       uuid,
  "cost_center_id"   uuid,
  "business_line_id" uuid,
  "analytic_type"    "analytic_type",
  "tax_rate_id"      uuid,
  "tax_base_cents"   integer,
  "counterparty_id"  uuid,
  "due_date"         date,
  "entry_date"       date    NOT NULL,
  "fiscal_year_id"   uuid    NOT NULL,
  "entry_kind"       "entry_kind" NOT NULL,
  "created_at"       timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

-- transactions: enganche con el diario
ALTER TABLE "transactions"
  ADD COLUMN "status" "transaction_status" NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN "journal_entry_id" uuid;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Índices y unicidad
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "fiscal_years_organization_id_code_key" ON "fiscal_years" ("organization_id", "code");
CREATE INDEX "fiscal_years_organization_id_start_date_end_date_idx" ON "fiscal_years" ("organization_id", "start_date", "end_date");

CREATE UNIQUE INDEX "period_locks_organization_id_fiscal_year_id_month_key" ON "period_locks" ("organization_id", "fiscal_year_id", "month");

CREATE UNIQUE INDEX "journal_entries_organization_id_fiscal_year_id_entry_number_key"
  ON "journal_entries" ("organization_id", "fiscal_year_id", "entry_number");
-- Destino de la FK compuesta de denormalización de la línea.
CREATE UNIQUE INDEX "journal_entries_denorm_key"
  ON "journal_entries" ("organization_id", "id", "entry_date", "fiscal_year_id", "kind");
CREATE INDEX "journal_entries_organization_id_entry_date_idx" ON "journal_entries" ("organization_id", "entry_date");
CREATE INDEX "journal_entries_organization_id_transaction_id_idx" ON "journal_entries" ("organization_id", "transaction_id");
CREATE INDEX "journal_entries_organization_id_template_code_idx" ON "journal_entries" ("organization_id", "template_code");

CREATE UNIQUE INDEX "journal_lines_entry_id_line_no_key" ON "journal_lines" ("entry_id", "line_no");
CREATE INDEX "journal_lines_organization_id_entry_date_idx" ON "journal_lines" ("organization_id", "entry_date");
CREATE INDEX "journal_lines_organization_id_account_code_entry_date_idx" ON "journal_lines" ("organization_id", "account_code", "entry_date");
CREATE INDEX "journal_lines_organization_id_entry_id_idx" ON "journal_lines" ("organization_id", "entry_id");
CREATE INDEX "journal_lines_organization_id_project_id_idx" ON "journal_lines" ("organization_id", "project_id");
CREATE INDEX "journal_lines_organization_id_cost_center_id_idx" ON "journal_lines" ("organization_id", "cost_center_id");

CREATE UNIQUE INDEX "transactions_organization_id_id_key" ON "transactions" ("organization_id", "id");
CREATE INDEX "transactions_organization_id_status_idx" ON "transactions" ("organization_id", "status");

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Claves ajenas (todas compuestas con organization_id donde hay tenant, I10)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "fiscal_years" ADD CONSTRAINT "fiscal_years_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "period_locks" ADD CONSTRAINT "period_locks_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "period_locks" ADD CONSTRAINT "period_locks_fiscal_year_id_fkey"
  FOREIGN KEY ("fiscal_year_id") REFERENCES "fiscal_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_fiscal_year_id_fkey"
  FOREIGN KEY ("fiscal_year_id") REFERENCES "fiscal_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_organization_id_transaction_id_fkey"
  FOREIGN KEY ("organization_id", "transaction_id") REFERENCES "transactions"("organization_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reverses_entry_id_fkey"
  FOREIGN KEY ("reverses_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_id_fkey"
  FOREIGN KEY ("entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- I9 + I10 en la BD: la cuenta es del MISMO tenant (E2, ADR-0008 §4).
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_organization_id_account_code_fkey"
  FOREIGN KEY ("organization_id", "account_code") REFERENCES "accounts"("organization_id", "code")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_tax_rate_id_fkey"
  FOREIGN KEY ("tax_rate_id") REFERENCES "tax_rates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "transactions" ADD CONSTRAINT "transactions_journal_entry_id_fkey"
  FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. CHECKs (§2.4-1)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_amounts_nonneg"    CHECK ("debit_cents" >= 0 AND "credit_cents" >= 0),
  ADD CONSTRAINT "journal_lines_debit_xor_credit"  CHECK (("debit_cents" = 0) <> ("credit_cents" = 0)),
  ADD CONSTRAINT "journal_lines_line_no_positive"  CHECK ("line_no" >= 1),
  ADD CONSTRAINT "journal_lines_tax_base_sign"     CHECK ("tax_base_cents" IS NULL OR "tax_base_cents" >= 0),
  ADD CONSTRAINT "journal_lines_analytics_e4"      CHECK ("project_id" IS NULL AND "cost_center_id" IS NULL AND "business_line_id" IS NULL);
COMMENT ON CONSTRAINT "journal_lines_analytics_e4" ON "journal_lines" IS
  'E3: las dimensiones analíticas no existen hasta E4. Se elimina en la migración de E4 al crear sus FK compuestas.';

-- Coherencia de las tres fechas (O-1): resolveEntryDate solo desplaza HACIA
-- ADELANTE, así que la fecha contable nunca es anterior al devengo.
ALTER TABLE "journal_entries"
  ADD CONSTRAINT "journal_entries_dates_order" CHECK ("accrual_date" IS NULL OR "entry_date" >= "accrual_date"),
  ADD CONSTRAINT "journal_entries_number_positive" CHECK ("entry_number" >= 1);

ALTER TABLE "period_locks" ADD CONSTRAINT "period_locks_month_range" CHECK ("month" BETWEEN 1 AND 12);
ALTER TABLE "fiscal_years" ADD CONSTRAINT "fiscal_years_dates"   CHECK ("end_date" >= "start_date");
ALTER TABLE "fiscal_years" ADD CONSTRAINT "fiscal_years_counter" CHECK ("last_entry_number" >= 0);

-- Ejercicios de una misma organización que no se solapan (btree_gist, E2).
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "fiscal_years"
  ADD CONSTRAINT "fiscal_years_no_overlap"
  EXCLUDE USING gist ("organization_id" WITH =, daterange("start_date", "end_date", '[]') WITH &&);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. La denormalización la impone la BD, no el código (§2.4-2)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_entry_denorm_fkey"
  FOREIGN KEY ("organization_id", "entry_id", "entry_date", "fiscal_year_id", "entry_kind")
  REFERENCES "journal_entries" ("organization_id", "id", "entry_date", "fiscal_year_id", "kind")
  ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Partida doble: constraint trigger DIFERIDO (§2.4-3, I1 barrera 2)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.assert_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_entry uuid := COALESCE(NEW.entry_id, OLD.entry_id);
  v_debit  bigint;
  v_credit bigint;
  v_lines  int;
  v_with_debit  int;
  v_with_credit int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.id = v_entry) THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(SUM(debit_cents), 0), COALESCE(SUM(credit_cents), 0), COUNT(*),
         COUNT(*) FILTER (WHERE debit_cents > 0), COUNT(*) FILTER (WHERE credit_cents > 0)
    INTO v_debit, v_credit, v_lines, v_with_debit, v_with_credit
    FROM journal_lines WHERE entry_id = v_entry;
  IF v_lines < 2 THEN
    RAISE EXCEPTION 'asiento % con % línea(s): un asiento tiene al menos dos', v_entry, v_lines
      USING ERRCODE = '23514', CONSTRAINT = 'journal_entry_min_lines';
  END IF;
  IF v_with_debit = 0 OR v_with_credit = 0 THEN
    RAISE EXCEPTION 'asiento % sin contrapartida: % línea(s) al debe, % al haber',
      v_entry, v_with_debit, v_with_credit
      USING ERRCODE = '23514', CONSTRAINT = 'journal_entry_both_sides';
  END IF;
  IF v_debit <> v_credit THEN
    RAISE EXCEPTION 'asiento % descuadrado: debe % <> haber % (diferencia %)',
      v_entry, v_debit, v_credit, v_debit - v_credit
      USING ERRCODE = '23514', CONSTRAINT = 'journal_entry_balanced';
  END IF;
  RETURN NULL;
END $fn$;

CREATE CONSTRAINT TRIGGER journal_lines_balanced
  AFTER INSERT OR UPDATE OR DELETE ON "journal_lines"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assert_entry_balanced();

-- Un asiento SIN líneas también es un descuadre: se comprueba desde el asiento.
CREATE OR REPLACE FUNCTION app.assert_entry_has_lines() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_lines int;
BEGIN
  SELECT COUNT(*) INTO v_lines FROM journal_lines WHERE entry_id = NEW.id;
  IF v_lines < 2 THEN
    RAISE EXCEPTION 'asiento % sin líneas', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'journal_entry_min_lines';
  END IF;
  RETURN NULL;
END $fn$;

CREATE CONSTRAINT TRIGGER journal_entries_has_lines
  AFTER INSERT ON "journal_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assert_entry_has_lines();

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Fecha: ejercicio ABIERTO y mes NO bloqueado (§2.4-4, I8 barrera 2)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.assert_entry_period_open() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE fy record;
BEGIN
  SELECT * INTO fy FROM fiscal_years
   WHERE id = NEW.fiscal_year_id AND organization_id = NEW.organization_id;
  IF fy IS NULL THEN
    RAISE EXCEPTION 'ejercicio inexistente en la organización' USING ERRCODE = '23503';
  END IF;
  IF fy.status = 'CLOSED' THEN
    RAISE EXCEPTION 'el ejercicio % está cerrado', fy.code USING ERRCODE = '23514';
  END IF;
  IF NEW.entry_date < fy.start_date OR NEW.entry_date > fy.end_date THEN
    RAISE EXCEPTION 'la fecha % cae fuera del ejercicio % (% .. %)',
      NEW.entry_date, fy.code, fy.start_date, fy.end_date USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM period_locks pl
              WHERE pl.organization_id = NEW.organization_id
                AND pl.fiscal_year_id = NEW.fiscal_year_id
                AND pl.month = EXTRACT(MONTH FROM NEW.entry_date)::int) THEN
    RAISE EXCEPTION 'el mes % del ejercicio % está bloqueado',
      EXTRACT(MONTH FROM NEW.entry_date)::int, fy.code USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER journal_entries_period_open
  BEFORE INSERT ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION app.assert_entry_period_open();

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. La cuenta debe ser POSTABLE y ACTIVA (§2.4-5, I9 barrera 2)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.assert_line_account_postable() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE a record;
BEGIN
  SELECT is_postable, is_active INTO a FROM accounts
   WHERE organization_id = NEW.organization_id AND code = NEW.account_code;
  IF a IS NULL THEN
    RAISE EXCEPTION 'cuenta % inexistente en la organización', NEW.account_code USING ERRCODE = '23503';
  END IF;
  IF NOT a.is_postable OR NOT a.is_active THEN
    RAISE EXCEPTION 'la cuenta % no admite apuntes (postable=%, activa=%)',
      NEW.account_code, a.is_postable, a.is_active USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER journal_lines_account_postable
  BEFORE INSERT ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION app.assert_line_account_postable();

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. Anulación: una sola, y nunca de un contra-asiento (§2.4-6, I-E3-2/I-E3-4)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "journal_entries_one_reversal"
  ON "journal_entries" ("organization_id", "reverses_entry_id")
  WHERE "reverses_entry_id" IS NOT NULL;

CREATE OR REPLACE FUNCTION app.assert_reversal_target() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_kind entry_kind;
BEGIN
  IF NEW.reverses_entry_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.kind <> 'REVERSAL' THEN
    RAISE EXCEPTION 'solo un asiento REVERSAL puede referenciar reverses_entry_id'
      USING ERRCODE = '23514', CONSTRAINT = 'journal_entry_reversal_kind';
  END IF;
  SELECT kind INTO v_kind FROM journal_entries
   WHERE id = NEW.reverses_entry_id AND organization_id = NEW.organization_id;
  IF v_kind IS NULL THEN
    RAISE EXCEPTION 'el asiento anulado no existe en la organización' USING ERRCODE = '23503';
  END IF;
  IF v_kind = 'REVERSAL' THEN
    RAISE EXCEPTION 'un contra-asiento no puede anular otro contra-asiento (I-E3-4)'
      USING ERRCODE = '23514', CONSTRAINT = 'journal_entry_no_double_reversal';
  END IF;
  IF v_kind IN ('OPENING', 'CLOSING', 'REGULARIZATION') THEN
    RAISE EXCEPTION 'los asientos de kind % no se anulan con contra-asiento (CA-1)', v_kind
      USING ERRCODE = '23514', CONSTRAINT = 'journal_entry_reversal_target_kind';
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER journal_entries_reversal_target
  BEFORE INSERT ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION app.assert_reversal_target();

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. Nada se borra, nada se edita: privilegios (§2.4-7)
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON "journal_entries", "journal_lines" FROM app_runtime;
GRANT SELECT, INSERT ON "journal_entries", "journal_lines" TO app_runtime;
-- Única mutación admitida en todo el diario: marcar un asiento como anulado.
GRANT UPDATE ("voided_at", "voided_by_id", "void_reason") ON "journal_entries" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "fiscal_years", "period_locks" TO app_runtime;

-- ─────────────────────────────────────────────────────────────────────────────
-- 12. RLS estricta con FORCE en las cuatro tablas nuevas (§2.5, ADR-0009)
-- ─────────────────────────────────────────────────────────────────────────────
-- Las tablas de E3 NACEN sin escape (no hay `OR app.current_org() IS NULL`) y
-- con FORCE: ni siquiera el propietario esquiva la política. Se reutiliza
-- `app.enforce_tenant_rls()`, creada por 20260906100000_e3_rls_strict, en vez de
-- copiar el SQL (CLAUDE.md §RLS estricta: toda tabla de negocio nueva se
-- protege con ese helper y se añade a `TENANT_MODELS`).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fiscal_years', 'period_locks', 'journal_entries', 'journal_lines'] LOOP
    PERFORM app.enforce_tenant_rls(t);
  END LOOP;
END $$;

-- Nada se borra en el diario (MODELO-DATOS §Integridad). `fiscal_years` y
-- `period_locks` SÍ admiten UPDATE/DELETE: desbloquear un mes es borrar la fila.
CREATE POLICY "journal_entries_no_delete" ON "journal_entries" AS RESTRICTIVE FOR DELETE USING (false);
CREATE POLICY "journal_lines_no_delete"   ON "journal_lines"   AS RESTRICTIVE FOR DELETE USING (false);
-- journal_lines es además inmutable: ni siquiera las columnas de anulación.
CREATE POLICY "journal_lines_no_update"   ON "journal_lines"   AS RESTRICTIVE FOR UPDATE USING (false);
