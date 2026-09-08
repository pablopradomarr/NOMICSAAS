-- E9 · T4 — M3: el IVA como dato fechado. Régimen con vigencia, liquidación,
-- prorrata, pares de reclasificación y `journal_entries.iva_period` con su
-- función IMMUTABLE, su trigger, su CHECK y su backfill.
-- (docs/design/E9-cierre-recurrentes.md §3.2, §3.3 y §3.5, ADR-0016 D4/D8.)
--
-- Ejecutable por un rol NO superusuario. `btree_gist` ya está instalada desde
-- E2 (`20260905100000`), así que el `CREATE EXTENSION IF NOT EXISTS` es un no-op
-- verificable y no exige privilegios nuevos.
--
-- PATRÓN DE BACKFILL (ADR-0009 §7, CLAUDE.md): con `FORCE` el propietario
-- tampoco esquiva las políticas, así que TODO DML de datos va entre
-- `NO FORCE` → … → `FORCE`, y la marca se escribe ANTES del backfill (lección
-- de `20260907120000`).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. `vat_regime_periods` — EL RÉGIMEN ES UN DATO FECHADO, NO UNA COLUMNA (D8)
--
--    Entrar en REDEME en 2027 con una columna en `organizations` habría
--    reagrupado los periodos de 2026 YA PRESENTADOS —de trimestres a meses— y
--    eso sólo se descubre en una inspección. `Organization.ivaRegime` se queda
--    donde está como valor por defecto para el alta; quien manda a partir de
--    aquí es la vigencia.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "vat_regime_periods" (
  "id"              uuid              NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" uuid              NOT NULL,
  "regime"          "iva_regime"      NOT NULL,
  "period_kind"     "vat_period_kind" NOT NULL,
  -- O-16: diferimiento del ingreso del IVA a la importación (art. 167.Dos LIVA,
  -- art. 74.1 RIVA). Opción con vigencia anual y sólo con periodo MENSUAL.
  "import_deferral" boolean           NOT NULL DEFAULT false,
  "valid_from"      date              NOT NULL,
  "valid_to"        date,
  "reason"          varchar(512),
  "created_at"      timestamp(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by_id"   uuid,
  CONSTRAINT "vat_regime_periods_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "vat_regime_periods_org_valid_from_idx"
  ON "vat_regime_periods" ("organization_id", "valid_from");

ALTER TABLE "vat_regime_periods"
  ADD CONSTRAINT "vat_regime_periods_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

ALTER TABLE "vat_regime_periods"
  ADD CONSTRAINT "vat_regime_periods_date_order"
    CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from"),
  -- O-16: el diferimiento exige periodo MENSUAL. Con trimestre no existe la
  -- casilla 77 y el DUA no puede devengar 477.
  ADD CONSTRAINT "vat_regime_periods_deferral_needs_monthly"
    CHECK (NOT "import_deferral" OR "period_kind" = 'MENSUAL'),
  -- R-IVA-20: REDEME es MENSUAL por definición (art. 30 RIVA).
  ADD CONSTRAINT "vat_regime_periods_redeme_monthly"
    CHECK ("regime" <> 'REDEME' OR "period_kind" = 'MENSUAL');

-- G-10. Vigencias sin solape, como `tax_rates` en E2. Dos regímenes vivos el
-- mismo día harían que el periodo de un asiento dependiera del orden de lectura.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "vat_regime_periods"
  ADD CONSTRAINT "vat_regime_periods_no_overlap"
  EXCLUDE USING gist (
    "organization_id" WITH =,
    daterange("valid_from", "valid_to", '[]') WITH &&
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. `app.iva_period(document_date, reception_date, kind) → text` — IMMUTABLE
--
--    IMMUTABLE de verdad, escrita con `extract` + `lpad`: `to_char` es STABLE
--    —depende de `lc_time` y `DateStyle`— y una función que la use no puede
--    entrar en un índice ni en un CHECK. Es justo lo que aquí hace falta.
--
--    R-IVA-8: el periodo es el de `max(reception_date, document_date)`.
--    `GREATEST` ignora los NULL, así que un asiento sin fecha de recepción usa
--    la del documento sin más. El trigger pasa `entry_date` como suelo, de modo
--    que la función nunca recibe dos nulos.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.iva_period(
  p_document_date  date,
  p_reception_date date,
  p_kind           "vat_period_kind"
) RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT CASE
    WHEN GREATEST(p_document_date, p_reception_date) IS NULL THEN NULL
    WHEN p_kind = 'MENSUAL' THEN
      lpad(EXTRACT(YEAR  FROM GREATEST(p_document_date, p_reception_date))::int::text, 4, '0') || '-' ||
      lpad(EXTRACT(MONTH FROM GREATEST(p_document_date, p_reception_date))::int::text, 2, '0')
    ELSE
      lpad(EXTRACT(YEAR FROM GREATEST(p_document_date, p_reception_date))::int::text, 4, '0') || '-T' ||
      (((EXTRACT(MONTH FROM GREATEST(p_document_date, p_reception_date))::int - 1) / 3) + 1)::text
  END
$fn$;
REVOKE ALL ON FUNCTION app.iva_period(date, date, "vat_period_kind") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.iva_period(date, date, "vat_period_kind") TO app_runtime, app_maintenance;

-- Helper: el `period_kind` VIGENTE a una fecha. No es IMMUTABLE —lee una
-- tabla—, y por eso vive separada de `app.iva_period`: la que entra en el CHECK
-- y en el índice es la pura.
CREATE OR REPLACE FUNCTION app.vat_period_kind_at(p_org uuid, p_date date)
RETURNS "vat_period_kind"
LANGUAGE sql
STABLE
AS $fn$
  SELECT "period_kind"
    FROM "vat_regime_periods"
   WHERE "organization_id" = p_org
     AND "valid_from" <= p_date
     AND ("valid_to" IS NULL OR "valid_to" >= p_date)
   ORDER BY "valid_from" DESC
   LIMIT 1
$fn$;
REVOKE ALL ON FUNCTION app.vat_period_kind_at(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.vat_period_kind_at(uuid, date) TO app_runtime, app_maintenance;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. `journal_entries.iva_period` — columna, no cálculo en memoria
--
--    Es columna porque B-6 (G-13, M5) tiene que poder RECHAZAR EN LA BASE un
--    asiento cuyo periodo de IVA ya esté liquidado, y porque el libro registro
--    se agrupa por ella con índice. Lo escribe el trigger, no quien inserta: un
--    periodo que llega desde fuera es un periodo que se puede falsear.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "journal_entries" ADD COLUMN "iva_period" varchar(8);

ALTER TABLE "journal_entries"
  ADD CONSTRAINT "journal_entries_iva_period_format"
    CHECK ("iva_period" IS NULL OR "iva_period" ~ '^[0-9]{4}-(0[1-9]|1[0-2]|T[1-4])$');

CREATE INDEX "journal_entries_organization_id_iva_period_idx"
  ON "journal_entries" ("organization_id", "iva_period");

CREATE OR REPLACE FUNCTION app.set_entry_iva_period()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_ref  date;
  v_kind "vat_period_kind";
BEGIN
  -- El suelo es `entry_date`, que nunca es nulo: un asiento sin fecha de
  -- documento ni de recepción sigue teniendo un periodo de IVA al que pertenece.
  v_ref  := COALESCE(GREATEST(NEW."document_date", NEW."reception_date"), NEW."entry_date");
  v_kind := COALESCE(app.vat_period_kind_at(NEW."organization_id", v_ref), 'TRIMESTRAL');
  NEW."iva_period" := app.iva_period(v_ref, NULL, v_kind);
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "journal_entries_set_iva_period"
  BEFORE INSERT ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION app.set_entry_iva_period();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. `vat_settlements` — el ACTO de liquidar, no sus cifras
--
--    Las casillas del 303 se derivan siempre (ADR-0003, §3.6): almacenarlas
--    dejaría mintiendo a una rectificativa posterior, y el modelo cambia cada
--    año por orden ministerial. `output_cents`, `input_cents`,
--    `carry_forward_cents` y `result_cents` son EVIDENCIA RECOMPUTABLE —patrón
--    de `recognized_difference_cents` en E7— e I-E9-9 los recalcula.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "vat_settlements" (
  "id"                   uuid                    NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"      uuid                    NOT NULL,
  "period_kind"          "vat_period_kind"       NOT NULL,
  "period"               varchar(8)              NOT NULL,
  "period_start"         date                    NOT NULL,
  "period_end"           date                    NOT NULL,
  "regime"               "iva_regime"            NOT NULL,
  "prorrata_bps"         integer,
  "import_deferral"      boolean                 NOT NULL DEFAULT false,
  "entry_id"             uuid                    NOT NULL,
  "output_cents"         bigint                  NOT NULL,
  "input_cents"          bigint                  NOT NULL,
  "carry_forward_cents"  bigint                  NOT NULL DEFAULT 0,
  "result_cents"         bigint                  NOT NULL,
  "ledger_hash"          char(64)                NOT NULL,
  "book_hash"            char(64)                NOT NULL,
  "git_sha"              text                    NOT NULL,
  "status"               "vat_settlement_status" NOT NULL DEFAULT 'LIQUIDADA',
  "reversed_by_entry_id" uuid,
  "reverse_reason"       varchar(512),
  "settled_at"           timestamp(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settled_by_id"        uuid,
  CONSTRAINT "vat_settlements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vat_settlements_organization_id_id_key" ON "vat_settlements" ("organization_id", "id");
CREATE INDEX "vat_settlements_org_kind_period_idx"
  ON "vat_settlements" ("organization_id", "period_kind", "period");

-- G-8. Una liquidación VIVA por periodo: índice único PARCIAL. Con un `UNIQUE`
-- a secas, revertir y re-liquidar —que es lo que hace una rectificativa— sería
-- imposible, y la alternativa sería borrar la liquidación anterior: exactamente
-- lo que ADR-0003 prohíbe.
CREATE UNIQUE INDEX "vat_settlements_one_live_per_period"
  ON "vat_settlements" ("organization_id", "period")
  WHERE "status" = 'LIQUIDADA';

ALTER TABLE "vat_settlements"
  ADD CONSTRAINT "vat_settlements_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "vat_settlements_entry_fkey"
    FOREIGN KEY ("organization_id", "entry_id")
    REFERENCES "journal_entries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "vat_settlements"
  ADD CONSTRAINT "vat_settlements_period_format"
    CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2]|T[1-4])$'),
  ADD CONSTRAINT "vat_settlements_period_matches_kind"
    CHECK (("period_kind" = 'MENSUAL') = ("period" !~ '-T')),
  ADD CONSTRAINT "vat_settlements_date_order" CHECK ("period_end" >= "period_start"),
  ADD CONSTRAINT "vat_settlements_amounts_nonneg"
    CHECK ("output_cents" >= 0 AND "input_cents" >= 0),
  -- G-9: puntos básicos, múltiplo de 100 (art. 104.Dos.2ª).
  ADD CONSTRAINT "vat_settlements_prorrata_bps_range"
    CHECK ("prorrata_bps" IS NULL OR
           ("prorrata_bps" BETWEEN 0 AND 10000 AND "prorrata_bps" % 100 = 0)),
  ADD CONSTRAINT "vat_settlements_deferral_needs_monthly"
    CHECK (NOT "import_deferral" OR "period_kind" = 'MENSUAL'),
  -- Una liquidación revertida dice CON QUÉ y POR QUÉ; una viva, ninguna cosa.
  ADD CONSTRAINT "vat_settlements_reversal_coherent"
    CHECK (("status" = 'REVERTIDA') = ("reversed_by_entry_id" IS NOT NULL)),
  ADD CONSTRAINT "vat_settlements_reverse_reason"
    CHECK ("status" <> 'REVERTIDA' OR ("reverse_reason" IS NOT NULL AND length(btrim("reverse_reason")) >= 10));

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. `prorrata_years` — arts. 104 y 105 LIVA
--
--    O-9/O-10/O-11: `prorrateable_quota_cents` es la BASE del ajuste —la cuota
--    soportada SOMETIDA a prorrata—, no lo ya deducido. Numerador y denominador
--    se DERIVAN del libro de emitidas con las exclusiones del art. 104.Tres
--    marcadas en el documento, y `unclassified_count > 0` obliga a INFO: con un
--    solo documento sin clave de operación, un porcentaje sería una invención.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "prorrata_years" (
  "id"                       uuid         NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"          uuid         NOT NULL,
  "year"                     integer      NOT NULL,
  "provisional_bps"          integer      NOT NULL,
  "definitive_bps"           integer,
  "numerator_cents"          bigint,
  "denominator_cents"        bigint,
  "prorrateable_quota_cents" bigint,
  "unclassified_count"       integer      NOT NULL DEFAULT 0,
  "adjustment_cents"         bigint,
  "regularization_entry_id"  uuid,
  "regularization_period"    varchar(8),
  "closed_at"                timestamp(3),
  "closed_by_id"             uuid,
  CONSTRAINT "prorrata_years_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "prorrata_years_organization_id_year_key" ON "prorrata_years" ("organization_id", "year");

ALTER TABLE "prorrata_years"
  ADD CONSTRAINT "prorrata_years_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

ALTER TABLE "prorrata_years"
  ADD CONSTRAINT "prorrata_years_year_range" CHECK ("year" BETWEEN 1990 AND 2999),
  -- G-9 en las dos: provisional y definitiva.
  ADD CONSTRAINT "prorrata_years_provisional_bps"
    CHECK ("provisional_bps" BETWEEN 0 AND 10000 AND "provisional_bps" % 100 = 0),
  ADD CONSTRAINT "prorrata_years_definitive_bps"
    CHECK ("definitive_bps" IS NULL OR
           ("definitive_bps" BETWEEN 0 AND 10000 AND "definitive_bps" % 100 = 0)),
  ADD CONSTRAINT "prorrata_years_terms_nonneg"
    CHECK (("numerator_cents"   IS NULL OR "numerator_cents"   >= 0)
       AND ("denominator_cents" IS NULL OR "denominator_cents" >= 0)
       AND ("prorrateable_quota_cents" IS NULL OR "prorrateable_quota_cents" >= 0)),
  -- El numerador es una PARTE del denominador (art. 104.Dos): si lo excediera,
  -- la prorrata pasaría del 100 % y el ajuste sería una deducción inventada.
  ADD CONSTRAINT "prorrata_years_numerator_le_denominator"
    CHECK ("numerator_cents" IS NULL OR "denominator_cents" IS NULL
           OR "numerator_cents" <= "denominator_cents"),
  ADD CONSTRAINT "prorrata_years_unclassified_nonneg" CHECK ("unclassified_count" >= 0),
  ADD CONSTRAINT "prorrata_years_regularization_period_format"
    CHECK ("regularization_period" IS NULL
           OR "regularization_period" ~ '^[0-9]{4}-(0[1-9]|1[0-2]|T[1-4])$'),
  -- I-E9-10b: si se practicó el ajuste, consta EN QUÉ PERIODO (art. 105.Uno: la
  -- ÚLTIMA declaración-liquidación del año, no en cualquiera).
  ADD CONSTRAINT "prorrata_years_regularization_coherent"
    CHECK (("regularization_entry_id" IS NULL) = ("regularization_period" IS NULL)),
  -- Un año cerrado tiene definitiva; sin ella no hay nada que cerrar.
  ADD CONSTRAINT "prorrata_years_closed_needs_definitive"
    CHECK ("closed_at" IS NULL OR "definitive_bps" IS NOT NULL);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. `reclassification_pairs` — O-7, los pares largo ↔ corto
--    Configuración versionada POR ORGANIZACIÓN, jamás códigos en el motor. La
--    siembra de los veintitrés pares la hace M4, cuando ya existe el plan.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "reclassification_pairs" (
  "id"                 uuid        NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"    uuid        NOT NULL,
  "long_account_code"  varchar(12) NOT NULL,
  "short_account_code" varchar(12) NOT NULL,
  -- Norma 6ª de elaboración de las cuentas anuales (RD 1514/2007).
  "threshold_months"   integer     NOT NULL DEFAULT 12,
  "is_active"          boolean     NOT NULL DEFAULT true,
  CONSTRAINT "reclassification_pairs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "reclassification_pairs_org_long_short_key"
  ON "reclassification_pairs" ("organization_id", "long_account_code", "short_account_code");

ALTER TABLE "reclassification_pairs"
  ADD CONSTRAINT "reclassification_pairs_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

-- G-11.
ALTER TABLE "reclassification_pairs"
  ADD CONSTRAINT "reclassification_pairs_accounts_distinct"
    CHECK ("long_account_code" <> "short_account_code"),
  ADD CONSTRAINT "reclassification_pairs_threshold_positive"
    CHECK ("threshold_months" > 0);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. RLS estricta y privilegios
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'vat_regime_periods', 'vat_settlements', 'prorrata_years', 'reclassification_pairs'
  ] LOOP
    PERFORM app.enforce_tenant_rls(t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "vat_regime_periods", "vat_settlements", "prorrata_years", "reclassification_pairs"
  TO app_runtime, app_maintenance;

-- `vat_settlements` es SEMI-append-only (patrón `store_sweeps`): una liquidación
-- es un hecho, pero revertirla es una operación legítima —art. 122 LGT— y tiene
-- que poder escribir su reversión. Lo que NO puede es reescribir sus cifras ni
-- su sello: si pudiera, I-E9-9 no tendría contra qué recomputar.
REVOKE UPDATE, DELETE ON "vat_settlements" FROM app_runtime;
GRANT UPDATE ("status", "reversed_by_entry_id", "reverse_reason") ON "vat_settlements" TO app_runtime;
CREATE POLICY "vat_settlements_no_delete" ON "vat_settlements" AS RESTRICTIVE FOR DELETE USING (false);

CREATE OR REPLACE FUNCTION app.vat_settlements_only_reversal()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."id"              IS DISTINCT FROM OLD."id"
     OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
     OR NEW."period"          IS DISTINCT FROM OLD."period"
     OR NEW."period_kind"     IS DISTINCT FROM OLD."period_kind"
     OR NEW."entry_id"        IS DISTINCT FROM OLD."entry_id"
     OR NEW."output_cents"    IS DISTINCT FROM OLD."output_cents"
     OR NEW."input_cents"     IS DISTINCT FROM OLD."input_cents"
     OR NEW."carry_forward_cents" IS DISTINCT FROM OLD."carry_forward_cents"
     OR NEW."result_cents"    IS DISTINCT FROM OLD."result_cents"
     OR NEW."ledger_hash"     IS DISTINCT FROM OLD."ledger_hash"
     OR NEW."book_hash"       IS DISTINCT FROM OLD."book_hash"
     OR NEW."settled_at"      IS DISTINCT FROM OLD."settled_at" THEN
    RAISE EXCEPTION 'vat_settlements: una liquidación sólo admite escribir su REVERSIÓN (E9, G-8)'
      USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'REVERTIDA' THEN
    RAISE EXCEPTION 'vat_settlements: la liquidación % ya estaba revertida', OLD."id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "vat_settlements_only_reversal_update"
  BEFORE UPDATE ON "vat_settlements"
  FOR EACH ROW EXECUTE FUNCTION app.vat_settlements_only_reversal();

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. BACKFILL de `journal_entries.iva_period` (§3.5)
--
--    Dos pasos y en este orden, que es el que impide repetirlo:
--      8.a la vigencia por defecto de cada organización —GENERAL / TRIMESTRAL /
--          sin diferimiento, desde su primer ejercicio—, para que el histórico
--          conserve EXACTAMENTE el trimestre que `quarterOf` calculaba;
--      8.b la MARCA, y sólo después el `UPDATE`.
--
--    I-E9-8b compara los dos caminos sobre el fixture completo antes de retirar
--    el cálculo en memoria: `quarterOf` de E8 no se borra, es el caso
--    TRIMESTRAL.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_marked boolean := COALESCE(obj_description(
    (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'journal_entries'), 'pg_class'
  ) LIKE '%iva_period:backfilled%', false);
  v_regimes integer := 0;
  v_entries integer := 0;
BEGIN
  IF v_marked THEN
    RAISE NOTICE 'iva_period ya backfilled: no se toca ninguna fila';
    RETURN;
  END IF;

  -- 1. LA MARCA VA PRIMERO, en la misma transacción que el backfill: o se
  --    aplican las dos cosas, o ninguna (lección de `20260907120000`).
  EXECUTE 'COMMENT ON TABLE "journal_entries" IS ' || quote_literal(
    'Libro diario. Asiento INMUTABLE salvo las columnas de anulación. ' ||
    'iva_period:backfilled — E9 M3: el periodo de IVA lo escribe el trigger ' ||
    'app.set_entry_iva_period; el histórico se rellenó una sola vez.'
  );

  -- 2. Vigencia por defecto para toda organización que aún no tenga ninguna.
  --    Arranca en el primer día del primer ejercicio; si la organización no
  --    tiene ejercicios todavía, en su fecha de alta.
  ALTER TABLE "vat_regime_periods" NO FORCE ROW LEVEL SECURITY;
  INSERT INTO "vat_regime_periods" ("organization_id", "regime", "period_kind", "import_deferral", "valid_from", "reason")
  SELECT o."id",
         'GENERAL'::"iva_regime",
         'TRIMESTRAL'::"vat_period_kind",
         false,
         COALESCE((SELECT min(fy."start_date") FROM "fiscal_years" fy WHERE fy."organization_id" = o."id"),
                  o."created_at"::date),
         'E9 M3: vigencia por defecto del histórico (ADR-0016 D8). El régimen real se declara en /settings/periods.'
    FROM "organizations" o
   WHERE NOT EXISTS (SELECT 1 FROM "vat_regime_periods" v WHERE v."organization_id" = o."id");
  GET DIAGNOSTICS v_regimes = ROW_COUNT;

  -- 3. Y ahora sí, el periodo de cada asiento del histórico.
  --    `vat_regime_periods` sigue en NO FORCE a propósito: `vat_period_kind_at`
  --    NO es `SECURITY DEFINER`, así que con FORCE puesto no vería las
  --    vigencias que se acaban de sembrar y todo el histórico caería en el
  --    default. Las dos tablas vuelven a FORCE juntas, más abajo.
  ALTER TABLE "journal_entries" NO FORCE ROW LEVEL SECURITY;
  UPDATE "journal_entries" je
     SET "iva_period" = app.iva_period(
           COALESCE(GREATEST(je."document_date", je."reception_date"), je."entry_date"),
           NULL,
           COALESCE(app.vat_period_kind_at(je."organization_id",
                    COALESCE(GREATEST(je."document_date", je."reception_date"), je."entry_date")),
                    'TRIMESTRAL')
         )
   WHERE je."iva_period" IS NULL;
  GET DIAGNOSTICS v_entries = ROW_COUNT;

  -- 4. La comprobación va AQUÍ, con la RLS todavía levantada: hecha después de
  --    `FORCE` no vería ninguna fila y saldría verde por vacuidad, que es la
  --    peor forma de pasar un control.
  IF EXISTS (SELECT 1 FROM "journal_entries" WHERE "iva_period" IS NULL) THEN
    RAISE EXCEPTION 'quedan asientos sin iva_period tras el backfill';
  END IF;

  ALTER TABLE "journal_entries"   FORCE ROW LEVEL SECURITY;
  ALTER TABLE "vat_regime_periods" FORCE ROW LEVEL SECURITY;

  RAISE NOTICE 'iva_period: % vigencia(s) sembradas, % asiento(s) rellenados', v_regimes, v_entries;
END $$;

-- La marca queda puesta pase lo que pase, y ninguna tabla en NO FORCE.
DO $$
BEGIN
  IF NOT COALESCE(obj_description(
       (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'journal_entries'), 'pg_class'
     ) LIKE '%iva_period:backfilled%', false) THEN
    RAISE EXCEPTION 'la marca iva_period:backfilled no ha quedado escrita';
  END IF;
  IF NOT (SELECT relforcerowsecurity FROM pg_class WHERE relname = 'journal_entries') THEN
    RAISE EXCEPTION 'journal_entries ha quedado en NO FORCE ROW LEVEL SECURITY';
  END IF;
  IF NOT (SELECT relforcerowsecurity FROM pg_class WHERE relname = 'vat_regime_periods') THEN
    RAISE EXCEPTION 'vat_regime_periods ha quedado en NO FORCE ROW LEVEL SECURITY';
  END IF;
END $$;
