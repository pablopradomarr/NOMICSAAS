-- E8 · T3 — Documentos → asientos (docs/design/E8-documentos-asientos.md §2.3,
-- ADR-0014 APROBADO). Todo lo que aquí se ejecuta lo puede ejecutar un rol NO
-- superusuario (regla de CLAUDE.md): ni un `ALTER ROLE`, ni un `OWNER TO`, ni
-- una extensión nueva. Los valores de enum que esta migración USA se añadieron
-- en `20260913090000_e8_enums`, que va aparte por exigencia de `ALTER TYPE`.
--
-- PATRÓN DE BACKFILL (ADR-0009 §7, CLAUDE.md): con `FORCE` el propietario
-- tampoco esquiva las políticas, así que TODO DML de datos va entre
-- `NO FORCE` → … → `FORCE`. El test «ninguna tabla en NO FORCE» de
-- `tests/integration-rls/rls-strict.test.ts` es la red que lo comprueba.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Tipos y tablas nuevas
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "extraction_kind"       AS ENUM ('LLM', 'MANUAL', 'IMPORTED');
CREATE TYPE "prompt_source"         AS ENUM ('GIT', 'ORG');
CREATE TYPE "reconcile_status"      AS ENUM ('PASS', 'WARN', 'FAIL');
CREATE TYPE "invoice_series_kind"   AS ENUM ('ORDINARIA', 'RECTIFICATIVA', 'SIMPLIFICADA');
CREATE TYPE "withholding_regime"    AS ENUM ('NINGUNO', 'PROFESIONAL', 'PROFESIONAL_INICIO',
                                             'ARRENDADOR', 'AGRICOLA', 'MODULOS');
CREATE TYPE "default_deductibility" AS ENUM ('FULL', 'NONE', 'REQUIERE_DECISION');
CREATE TYPE "iva_regime"            AS ENUM ('GENERAL', 'RECC', 'REDEME', 'OTRO');

-- `files` necesita la unique compuesta ANTES de ser destino de las FK por tenant.
CREATE UNIQUE INDEX IF NOT EXISTS "files_organization_id_id_key"
  ON "files" ("organization_id", "id");

CREATE TABLE "extraction_runs" (
  "id"                uuid               NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"   uuid               NOT NULL,
  "file_id"           uuid               NOT NULL,
  "file_sha256"       char(64)           NOT NULL,
  "kind"              "extraction_kind"  NOT NULL,
  "parent_run_id"     uuid,
  "provider"          varchar(64)        NOT NULL,
  "model"             varchar(128)       NOT NULL,
  "temperature_bps"   integer            NOT NULL DEFAULT 0,
  "attempts"          jsonb              NOT NULL DEFAULT '[]',
  "prompt_code"       varchar(64)        NOT NULL,
  "prompt_source"     "prompt_source"    NOT NULL,
  "prompt_version_id" uuid,
  "prompt_sha"        char(64)           NOT NULL,
  "schema_version"    varchar(16)        NOT NULL,
  "schema_sha"        char(64)           NOT NULL,
  "pages_sent"        integer            NOT NULL,
  "pages_total"       integer            NOT NULL,
  "partial"           boolean            NOT NULL DEFAULT false,
  "raw_output"        jsonb              NOT NULL,
  "proposal"          jsonb,
  "proposal_sha"      char(64),
  "field_origins"     jsonb              NOT NULL DEFAULT '{}',
  "reconcile"         jsonb,
  "reconcile_status"  "reconcile_status",
  "tokens_in"         integer,
  "tokens_out"        integer,
  "cost_micros"       bigint,
  "duration_ms"       integer            NOT NULL,
  "git_sha"           varchar(64)        NOT NULL,
  "created_by_id"     uuid,
  "created_at"        timestamp(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "extraction_runs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "extraction_runs_organization_id_id_key"
  ON "extraction_runs" ("organization_id", "id");
CREATE INDEX "extraction_runs_org_file_created_idx"
  ON "extraction_runs" ("organization_id", "file_id", "created_at" DESC);
CREATE INDEX "extraction_runs_org_status_idx"
  ON "extraction_runs" ("organization_id", "reconcile_status");

ALTER TABLE "extraction_runs"
  ADD CONSTRAINT "extraction_runs_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "extraction_runs_file_fkey"
    FOREIGN KEY ("organization_id", "file_id")
    REFERENCES "files"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "extraction_runs_parent_fkey"
    FOREIGN KEY ("parent_run_id") REFERENCES "extraction_runs"("id") ON DELETE RESTRICT;

CREATE TABLE "prompt_versions" (
  "id"              uuid         NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" uuid         NOT NULL,
  "code"            varchar(64)  NOT NULL,
  "version"         integer      NOT NULL,
  "content"         text         NOT NULL,
  "sha256"          char(64)     NOT NULL,
  "notes"           varchar(512),
  "created_by_id"   uuid,
  "created_at"      timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "prompt_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "prompt_versions_org_code_version_key"
  ON "prompt_versions" ("organization_id", "code", "version");
ALTER TABLE "prompt_versions"
  ADD CONSTRAINT "prompt_versions_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

-- GLOBAL, sin `organization_id` (ADR-0014 D7).
CREATE TABLE "exchange_rates" (
  "id"         uuid         NOT NULL DEFAULT gen_random_uuid(),
  "date"       date         NOT NULL,
  "from"       varchar(3)   NOT NULL,
  "to"         varchar(3)   NOT NULL,
  "rate_micro" bigint       NOT NULL,
  "source"     varchar(32)  NOT NULL,
  "fetched_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "exchange_rates_date_from_to_source_key"
  ON "exchange_rates" ("date", "from", "to", "source");
CREATE INDEX "exchange_rates_from_to_date_idx"
  ON "exchange_rates" ("from", "to", "date" DESC);

CREATE TABLE "invoice_series" (
  "id"              uuid                  NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" uuid                  NOT NULL,
  "code"            varchar(24)           NOT NULL,
  "kind"            "invoice_series_kind" NOT NULL DEFAULT 'ORDINARIA',
  "prefix"          varchar(16)           NOT NULL,
  "next_number"     integer               NOT NULL DEFAULT 1,
  "year"            integer,
  "last_hash"       char(64),
  "is_active"       boolean               NOT NULL DEFAULT true,
  "created_at"      timestamp(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      timestamp(3)          NOT NULL,
  CONSTRAINT "invoice_series_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "invoice_series_org_code_year_key"
  ON "invoice_series" ("organization_id", "code", "year");
CREATE INDEX "invoice_series_org_kind_active_idx"
  ON "invoice_series" ("organization_id", "kind", "is_active");
ALTER TABLE "invoice_series"
  ADD CONSTRAINT "invoice_series_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

-- T23 — maestro de terceros con su calificación fiscal (ADR-0014 D11).
CREATE TABLE "counterparties" (
  "id"                    uuid                 NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"       uuid                 NOT NULL,
  "code"                  varchar(24)          NOT NULL,
  "name"                  varchar(255)         NOT NULL,
  "tax_id"                varchar(20),
  "country_code"          varchar(2),
  "vat_number"            varchar(20),
  "vies_valid"            boolean,
  "vies_checked_at"       timestamp(3),
  "withholding_regime"    "withholding_regime" NOT NULL DEFAULT 'NINGUNO',
  "withholding_rate_code" varchar(24),
  "surcharge_regime"      boolean              NOT NULL DEFAULT false,
  "is_employee"           boolean              NOT NULL DEFAULT false,
  "is_active"             boolean              NOT NULL DEFAULT true,
  "notes"                 varchar(512),
  "created_at"            timestamp(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            timestamp(3)         NOT NULL,
  CONSTRAINT "counterparties_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "counterparties_org_code_key" ON "counterparties" ("organization_id", "code");
CREATE UNIQUE INDEX "counterparties_organization_id_id_key" ON "counterparties" ("organization_id", "id");
CREATE INDEX "counterparties_org_name_idx"   ON "counterparties" ("organization_id", "name");
CREATE INDEX "counterparties_org_tax_id_idx" ON "counterparties" ("organization_id", "tax_id");
ALTER TABLE "counterparties"
  ADD CONSTRAINT "counterparties_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Columnas nuevas en tablas existentes (§2.2)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "files"
  ADD COLUMN "sha256"     char(64),
  ADD COLUMN "size_bytes" integer;
CREATE INDEX "files_org_sha256_idx" ON "files" ("organization_id", "sha256");

ALTER TABLE "transactions"
  ADD COLUMN "exchange_rate_micro"            bigint,
  ADD COLUMN "rate_date"                      date,
  ADD COLUMN "rate_source"                    varchar(32),
  ADD COLUMN "converted_total_override_reason" varchar(512),
  ADD COLUMN "extraction_run_id"              uuid,
  ADD COLUMN "voided_entry_id"                uuid,
  ADD COLUMN "voided_entry_ids"               uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  ADD COLUMN "split_parent_transaction_id"    uuid;

ALTER TABLE "journal_entries"
  ADD COLUMN "reception_date"   date,
  ADD COLUMN "operation_date"   date,
  ADD COLUMN "template_version" integer NOT NULL DEFAULT 1;

-- T2b — divisa ORIGINAL en la línea (ADR-0014 D2, O-8).
ALTER TABLE "journal_lines"
  ADD COLUMN "original_currency"     varchar(3),
  ADD COLUMN "original_amount_cents" integer,
  ADD COLUMN "exchange_rate_id"      uuid;

ALTER TABLE "counterparties" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "invoice_series" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "categories"
  ADD COLUMN "default_account_code"  varchar(12),
  ADD COLUMN "default_deductibility" "default_deductibility" NOT NULL DEFAULT 'FULL';

ALTER TABLE "organizations"
  ADD COLUMN "roi_registered" boolean     NOT NULL DEFAULT false,
  ADD COLUMN "iva_regime"     "iva_regime" NOT NULL DEFAULT 'GENERAL';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. FK compuestas POR TENANT (§2.3 punto 5) y la global de divisa
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "journal_entries"
  ADD CONSTRAINT "journal_entries_file_fkey"
    FOREIGN KEY ("organization_id", "file_id")
    REFERENCES "files"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "journal_entries_extraction_run_fkey"
    FOREIGN KEY ("organization_id", "extraction_run_id")
    REFERENCES "extraction_runs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_exchange_rate_fkey"
    FOREIGN KEY ("exchange_rate_id") REFERENCES "exchange_rates"("id") ON DELETE RESTRICT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RLS
--    4.a Tablas de tenant: política estricta + ENABLE + FORCE por el helper.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['extraction_runs','prompt_versions','invoice_series','counterparties'] LOOP
    PERFORM app.enforce_tenant_rls(t);
  END LOOP;
END $$;

-- 4.b `extraction_runs` y `prompt_versions` APPEND-ONLY (I-E8-3): la evidencia
--     de una extracción no es un borrador mutable —eso era `cachedParseResult`—.
--     Las dos cerraduras del patrón `audit_logs`: privilegio y política.
GRANT SELECT, INSERT ON "extraction_runs", "prompt_versions" TO app_runtime;
REVOKE UPDATE, DELETE ON "extraction_runs", "prompt_versions" FROM app_runtime;
CREATE POLICY "extraction_runs_no_update" ON "extraction_runs" AS RESTRICTIVE FOR UPDATE USING (false);
CREATE POLICY "extraction_runs_no_delete" ON "extraction_runs" AS RESTRICTIVE FOR DELETE USING (false);
CREATE POLICY "prompt_versions_no_update" ON "prompt_versions" AS RESTRICTIVE FOR UPDATE USING (false);
CREATE POLICY "prompt_versions_no_delete" ON "prompt_versions" AS RESTRICTIVE FOR DELETE USING (false);

-- 4.c `exchange_rates`: tabla de REFERENCIA global. No pasa por
--     `enforce_tenant_rls` porque no tiene `organization_id`, pero SÍ lleva
--     `FORCE`, de modo que el test de «ninguna tabla en NO FORCE» sigue siendo
--     válido sobre ella. Append-only: una tasa publicada no se reescribe.
ALTER TABLE "exchange_rates" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "exchange_rates_read"   ON "exchange_rates";
DROP POLICY IF EXISTS "exchange_rates_insert" ON "exchange_rates";
CREATE POLICY "exchange_rates_read"      ON "exchange_rates" FOR SELECT USING (true);
CREATE POLICY "exchange_rates_insert"    ON "exchange_rates" FOR INSERT WITH CHECK (true);
CREATE POLICY "exchange_rates_no_update" ON "exchange_rates" AS RESTRICTIVE FOR UPDATE USING (false);
CREATE POLICY "exchange_rates_no_delete" ON "exchange_rates" AS RESTRICTIVE FOR DELETE USING (false);
ALTER TABLE "exchange_rates" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON "exchange_rates" TO app_runtime;
REVOKE UPDATE, DELETE ON "exchange_rates" FROM app_runtime;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "extraction_runs", "prompt_versions", "exchange_rates", "invoice_series", "counterparties"
  TO app_maintenance;
GRANT SELECT, INSERT, UPDATE, DELETE ON "invoice_series", "counterparties" TO app_runtime;
-- Una serie no se borra: se desactiva (O-18).
REVOKE DELETE ON "invoice_series" FROM app_runtime;
CREATE POLICY "invoice_series_no_delete" ON "invoice_series" AS RESTRICTIVE FOR DELETE USING (false);

-- 4.d Las tres columnas de divisa de `journal_lines` son INMUTABLES: NO entran
--     en el GRANT UPDATE acotado de ADR-0010 (§2.3 punto 6). El GRANT vigente
--     se reescribe tal cual estaba, sin añadirlas.
DO $$
DECLARE cols text;
BEGIN
  SELECT string_agg(format('%I', a.attname), ', ' ORDER BY a.attnum) INTO cols
    FROM information_schema.column_privileges p
    JOIN pg_class c ON c.relname = p.table_name AND c.relnamespace = 'public'::regnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = p.column_name
   WHERE p.table_name = 'journal_lines' AND p.grantee = 'app_runtime' AND p.privilege_type = 'UPDATE';
  IF cols IS NOT NULL THEN
    RAISE NOTICE 'journal_lines: GRANT UPDATE acotado vigente sobre (%). Las columnas de divisa NO se añaden.', cols;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. CHECK y triggers
-- ─────────────────────────────────────────────────────────────────────────────

-- 5.a `extraction_runs`
ALTER TABLE "extraction_runs"
  ADD CONSTRAINT "extraction_runs_pages_range"
    CHECK ("pages_sent" BETWEEN 0 AND "pages_total"),
  ADD CONSTRAINT "extraction_runs_manual_origin"
    CHECK ("kind" <> 'MANUAL' OR "parent_run_id" IS NOT NULL OR "provider" = 'formulario'),
  -- Cota de tamaño: ningún run supera 256 KB (criterio 31 de rendimiento).
  ADD CONSTRAINT "extraction_runs_payload_size"
    CHECK (pg_column_size("raw_output") + COALESCE(pg_column_size("proposal"), 0) < 262144);

-- `partial` NO se confía a quien inserta: lo escribe el trigger (G-02, O-20.3).
CREATE OR REPLACE FUNCTION app.extraction_runs_set_partial()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  NEW."partial" := (NEW."pages_sent" < NEW."pages_total");
  RETURN NEW;
END
$fn$;
CREATE TRIGGER "extraction_runs_set_partial_insert"
  BEFORE INSERT ON "extraction_runs"
  FOR EACH ROW EXECUTE FUNCTION app.extraction_runs_set_partial();

-- 5.b `exchange_rates`
ALTER TABLE "exchange_rates"
  ADD CONSTRAINT "exchange_rates_rate_positive" CHECK ("rate_micro" > 0),
  ADD CONSTRAINT "exchange_rates_distinct"      CHECK ("from" <> "to"),
  ADD CONSTRAINT "exchange_rates_iso_length"
    CHECK (char_length("from") = 3 AND char_length("to") = 3);

-- 5.c `transactions` — CHECK de ADR-0014 D1 **reescrito** (O-9.ii): el de la
--     ronda 1 dejaba pasar `VOID` sin asiento anulado por precedencia de
--     operadores. Las cuatro ramas, explícitas.
ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_status_entry_d1" CHECK (
    ("status" = 'DRAFT'    AND "journal_entry_id" IS NULL     AND "voided_entry_id" IS NULL) OR
    ("status" = 'PROPOSED' AND "journal_entry_id" IS NULL)                                   OR
    ("status" = 'POSTED'   AND "journal_entry_id" IS NOT NULL)                               OR
    ("status" = 'VOID'     AND "journal_entry_id" IS NULL     AND "voided_entry_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "transactions_override_reason_len" CHECK (
    "converted_total_override_reason" IS NULL
    OR char_length(btrim("converted_total_override_reason")) >= 10
  );

-- Traslado a `voided_entry_id` + apilado append-only, y transiciones legales.
CREATE OR REPLACE FUNCTION app.transactions_status_transition()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  -- El histórico de anulaciones es APPEND-ONLY: nadie lo acorta ni lo reescribe.
  IF NOT (OLD."voided_entry_ids" OPERATOR(pg_catalog.<@) NEW."voided_entry_ids") THEN
    RAISE EXCEPTION 'transactions: voided_entry_ids es append-only (ADR-0014 D1)'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NOT (
      (OLD."status" = 'DRAFT'    AND NEW."status" IN ('PROPOSED', 'POSTED')) OR
      (OLD."status" = 'PROPOSED' AND NEW."status" IN ('DRAFT', 'POSTED'))    OR
      (OLD."status" = 'POSTED'   AND NEW."status" = 'VOID')                  OR
      -- Anular y rehacer: sin esta rama la única salida sería volver a subir el
      -- fichero, que además chocaría con la detección de duplicados (O-9).
      (OLD."status" = 'VOID'     AND NEW."status" = 'PROPOSED')
    ) THEN
      RAISE EXCEPTION 'transactions: transición de estado % → % no permitida (ADR-0014 D1)',
        OLD."status", NEW."status" USING ERRCODE = '23514';
    END IF;

    -- Al anular, el asiento se TRASLADA: nada se pierde y `POSTED ⟺ asiento`
    -- sigue siendo cierto (I-E8-4).
    IF NEW."status" = 'VOID' THEN
      IF NEW."voided_entry_id" IS NULL THEN
        NEW."voided_entry_id" := OLD."journal_entry_id";
      END IF;
      NEW."journal_entry_id" := NULL;
      IF NEW."voided_entry_id" IS NOT NULL
         AND NOT (NEW."voided_entry_id" = ANY (NEW."voided_entry_ids")) THEN
        NEW."voided_entry_ids" := NEW."voided_entry_ids" || NEW."voided_entry_id";
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END
$fn$;
CREATE TRIGGER "transactions_status_transition_update"
  BEFORE UPDATE ON "transactions"
  FOR EACH ROW EXECUTE FUNCTION app.transactions_status_transition();

-- 5.d `organizations` — techo DURO de la tolerancia de tesorería (O-16).
ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_redondeo_tolerancia_range"
    CHECK ("redondeo_tolerancia_cents" BETWEEN 0 AND 5);

-- 5.e `categories` — ninguna categoría apunta al subgrupo 64 (O-13): las
--     nóminas entran por T-10, jamás por una plantilla de compra.
ALTER TABLE "categories"
  ADD CONSTRAINT "categories_default_account_not_64"
    CHECK ("default_account_code" IS NULL OR left("default_account_code", 2) <> '64');

-- 5.f `journal_lines` — coherencia de la divisa original (T2b).
ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_original_currency_pair"
    CHECK (("original_currency" IS NULL) = ("original_amount_cents" IS NULL)),
  ADD CONSTRAINT "journal_lines_original_currency_rate"
    CHECK ("original_currency" IS NULL OR "exchange_rate_id" IS NOT NULL),
  ADD CONSTRAINT "journal_lines_original_amount_nonneg"
    CHECK ("original_amount_cents" IS NULL OR "original_amount_cents" >= 0);

-- 5.g `invoice_series` — numeración SIN HUECOS (O-18, I-E8-20). El contador
--     avanza de uno en uno y jamás retrocede; el tipo de la serie no muta (una
--     serie rectificativa no se convierte en ordinaria: se crea otra).
CREATE OR REPLACE FUNCTION app.invoice_series_no_gaps()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."next_number" <> OLD."next_number"
     AND NEW."next_number" <> OLD."next_number" + 1 THEN
    RAISE EXCEPTION 'invoice_series %: la numeración avanza de uno en uno y no retrocede (% → %)',
      OLD."code", OLD."next_number", NEW."next_number" USING ERRCODE = '23514';
  END IF;
  IF NEW."kind" IS DISTINCT FROM OLD."kind" THEN
    RAISE EXCEPTION 'invoice_series %: el tipo de serie no se cambia; crea otra serie (art. 15.4 RD 1619/2012)',
      OLD."code" USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER "invoice_series_no_gaps_update"
  BEFORE UPDATE ON "invoice_series"
  FOR EACH ROW EXECUTE FUNCTION app.invoice_series_no_gaps();
ALTER TABLE "invoice_series"
  ADD CONSTRAINT "invoice_series_next_number_positive" CHECK ("next_number" >= 1);

-- 5.h `app.journal_entry_hash` aprende la forma canónica **v3** (T2b).
--
--     Esta función es la réplica en SQL de `lib/ledger/hash.ts::entryHash`, y la
--     usa el trigger `journal_entries_entry_hash_guard` de
--     `20260908110000_e4_reclassify_guards` para que nadie pueda escribir en
--     `entry_hash` un valor que no describa sus líneas. Con `hashVersion = 3`
--     conviviendo, la función tiene que **despachar por versión**: recomponer
--     una fila v2 con la forma v3 —o al revés— daría un sello distinto y el
--     trigger rechazaría una reclasificación perfectamente legítima.
--
--     La v3 es la v2 MÁS las tres columnas de divisa al final, igual que en
--     TypeScript; un test compara los dos caminos sobre todo el diario.
CREATE OR REPLACE FUNCTION app.journal_entry_hash(p_entry_id uuid) RETURNS text
LANGUAGE sql STABLE AS $fn$
  SELECT encode(
           sha256(convert_to(
             COALESCE(string_agg(f.fila, E'\n' ORDER BY f.entry_date, f.entry_number, f.line_no), ''), 'UTF8')),
           'hex')
    FROM (
      SELECT jl."entry_date", je."entry_number", jl."line_no",
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
             )
             || CASE WHEN je."hash_version" >= 3 THEN
                  concat(E'\t', COALESCE(NULLIF(jl."original_currency", ''), '∅'),
                         E'\t', COALESCE(jl."original_amount_cents"::text, '∅'),
                         E'\t', COALESCE(jl."exchange_rate_id"::text, '∅'))
                ELSE '' END AS fila
        FROM "journal_lines" jl
        JOIN "journal_entries" je ON je."id" = jl."entry_id"
       WHERE jl."entry_id" = p_entry_id
    ) AS f
$fn$;
COMMENT ON FUNCTION app.journal_entry_hash(uuid) IS
  'Forma canónica de entry_hash con despacho por hash_version: v2 (ADR-0011) y v3 (ADR-0014 D2, + divisa original). Debe coincidir con lib/ledger/hash.ts::entryHash; hay un test que compara ambos caminos sobre todo el diario.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Backfill de `cached_parse_result` → `ExtractionRun` (§2.4) y siembras.
--    TODO bajo el patrón obligatorio NO FORCE → DML → FORCE.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "files"                     NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "extraction_runs"           NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "categories"                NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "invoice_series"            NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "organization_account_maps" NO FORCE ROW LEVEL SECURITY;

-- 6.a Lo memorizado por TaxHacker se convierte en evidencia declarada como lo
--     que es: `importado sin origen`, sin propuesta y sin `reconcile_status`.
--     Carga el formulario para que nadie pierda su trabajo, pero cada campo se
--     pinta `no verificado` y `postFromProposal()` lo rechaza (P4).
INSERT INTO "extraction_runs" (
  "id", "organization_id", "file_id", "file_sha256", "kind", "provider", "model",
  "prompt_code", "prompt_source", "prompt_sha", "schema_version", "schema_sha",
  "pages_sent", "pages_total", "raw_output", "proposal", "field_origins",
  "reconcile", "reconcile_status", "duration_ms", "git_sha", "created_at"
)
SELECT
  gen_random_uuid(), f."organization_id", f."id",
  -- Sin bytes verificados no hay sha: el centinela lo dice con todas sus letras
  -- y RC-10 lo rechazará. `scripts/backfill-file-sha256.ts` lo repara.
  repeat('0', 64), 'IMPORTED', 'importado', 'desconocido',
  'importado', 'GIT', encode(sha256(''::bytea), 'hex'), '0', encode(sha256(''::bytea), 'hex'),
  0, 0, f."cached_parse_result", NULL, '{}'::jsonb,
  '{"status":"NO_VERIFICADO","reason":"importado sin origen","checks":[]}'::jsonb,
  NULL, 0, 'backfill-e8', f."created_at"
FROM "files" f
WHERE f."cached_parse_result" IS NOT NULL;

-- 6.b Mapa de cuentas: `PROVEEDORES_INMOVILIZADO → 523` en toda organización
--     que no lo tenga y cuyo plan tenga la cuenta POSTABLE. Una organización sin
--     523 postable NO falla la migración: queda como WARN de Auditoría (§2.3.9).
INSERT INTO "organization_account_maps" ("id", "organization_id", "key", "account_code", "created_at", "updated_at")
SELECT gen_random_uuid(), a."organization_id", 'PROVEEDORES_INMOVILIZADO', a."code",
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM "accounts" a
 WHERE a."code" = '523' AND a."is_postable" AND a."is_active"
   AND NOT EXISTS (
     SELECT 1 FROM "organization_account_maps" m
      WHERE m."organization_id" = a."organization_id" AND m."key" = 'PROVEEDORES_INMOVILIZADO'
   );

-- 6.c Deducibilidad `REQUIERE_DECISION` en las categorías del art. 96 LIVA y del
--     art. 95.Tres.2ª (O-17): hostelería y restauración, atenciones a clientes,
--     espectáculos y combustible de turismos. El camino silencioso —confirmar en
--     lote sin mirar— dejaba de deducirse por defecto aquí.
UPDATE "categories"
   SET "default_deductibility" = 'REQUIERE_DECISION'
 WHERE "code" IN ('food', 'events', 'travel', 'transport')
   AND "default_deductibility" = 'FULL';

-- 6.d Serie RECTIFICATIVA por organización (O-18, art. 15.4 RD 1619/2012).
INSERT INTO "invoice_series" ("id", "organization_id", "code", "kind", "prefix", "next_number", "is_active", "created_at", "updated_at")
SELECT gen_random_uuid(), o."id", 'RECT', 'RECTIFICATIVA', 'R-', 1, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM "organizations" o
 WHERE NOT EXISTS (
   SELECT 1 FROM "invoice_series" s
    WHERE s."organization_id" = o."id" AND s."kind" = 'RECTIFICATIVA'
 );

ALTER TABLE "organization_account_maps" FORCE ROW LEVEL SECURITY;
ALTER TABLE "invoice_series"            FORCE ROW LEVEL SECURITY;
ALTER TABLE "categories"                FORCE ROW LEVEL SECURITY;
ALTER TABLE "extraction_runs"           FORCE ROW LEVEL SECURITY;
ALTER TABLE "files"                     FORCE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. La columna que E8 elimina (G-03). La memoria de un parseo no es evidencia:
--    no tiene proveedor, ni modelo, ni prompt, ni sha, y se sobrescribía sola.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "files" DROP COLUMN "cached_parse_result";
