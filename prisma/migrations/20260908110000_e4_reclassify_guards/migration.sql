-- E4 · revisión ronda 1 — tres barreras que faltaban en
-- `20260908100000_e4_analytics` (BLOQUEA #2, #7 y #8 de la revisión).
--
-- No se edita la migración anterior: ya está aplicada (CLAUDE.md).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. (#8) La forma canónica v2 de `entry_hash`, como función reutilizable.
--    Hasta ahora vivía inline en el recálculo de la migración e4; extraerla
--    permite que el trigger de abajo compruebe el sello con EL MISMO código y
--    que un test compare este camino con `lib/ledger/hash.ts` (ADR-0011).
-- ─────────────────────────────────────────────────────────────────────────────
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
             ) AS fila
        FROM "journal_lines" jl
        JOIN "journal_entries" je ON je."id" = jl."entry_id"
       WHERE jl."entry_id" = p_entry_id
    ) AS f
$fn$;
COMMENT ON FUNCTION app.journal_entry_hash(uuid) IS
  'Forma canónica v2 de entry_hash (ADR-0011). Debe coincidir con lib/ledger/hash.ts::entryHash; hay un test que compara ambos caminos sobre todo el diario.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. (#8) `entry_hash` sólo admite el valor RECALCULADO de sus propias líneas.
--    El GRANT de columna deja a `app_runtime` escribir `entry_hash`, que es lo
--    que la reclasificación necesita (salvaguarda 2 de ADR-0010). Sin este
--    trigger, ese mismo GRANT permitiría escribir CUALQUIER valor y dejar un
--    asiento cuyo sello no describe su contenido, con I-E3-7 en PASS mintiendo.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.journal_entries_entry_hash_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_expected text;
BEGIN
  IF NEW."entry_hash" IS NOT DISTINCT FROM OLD."entry_hash" THEN
    RETURN NEW;  -- anulación y demás UPDATE que no tocan el sello
  END IF;
  v_expected := app.journal_entry_hash(NEW."id");
  IF v_expected IS NULL OR NEW."entry_hash" <> v_expected THEN
    RAISE EXCEPTION 'entry_hash sólo admite el sello recalculado de sus líneas (I-E3-7, ADR-0011)'
      USING ERRCODE = '23514', CONSTRAINT = 'journal_entries_entry_hash_guard';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER journal_entries_entry_hash_guard
  BEFORE UPDATE OF "entry_hash" ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION app.journal_entries_entry_hash_guard();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. (BLOQUEA #2) La ventana de reclasificación cubre además el contra-asiento
--    y el asiento anulado. Un `REVERSAL` hereda LITERALMENTE el destino del
--    original (§8.7): moverlo dejaría el par descuadrado por columna —Σ aporte
--    ≠ 0 por destino— mientras I4 seguiría en PASS, porque los totales de fila
--    son ciegos a la distribución. Reclasificar el ORIGINAL anulado rompe el
--    espejo por el otro lado. Ambos casos los detecta I-E4-11; aquí se impiden.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.journal_lines_reclassify_window() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_status text;
  v_voided boolean;
BEGIN
  SELECT "status"::text INTO v_status FROM "fiscal_years" WHERE "id" = NEW."fiscal_year_id";
  IF v_status = 'CLOSED' THEN
    RAISE EXCEPTION 'el ejercicio está cerrado: su analítica no se reclasifica'
      USING ERRCODE = '23514', CONSTRAINT = 'journal_lines_reclassify_window';
  END IF;

  IF NEW."entry_kind" = 'REVERSAL' THEN
    RAISE EXCEPTION 'un contra-asiento hereda el destino del original y no se reclasifica (I-E4-11)'
      USING ERRCODE = '23514', CONSTRAINT = 'journal_lines_reclassify_window';
  END IF;

  SELECT (e."voided_at" IS NOT NULL
          OR EXISTS (SELECT 1 FROM "journal_entries" r WHERE r."reverses_entry_id" = e."id"))
    INTO v_voided
    FROM "journal_entries" e
   WHERE e."id" = NEW."entry_id";
  IF v_voided THEN
    RAISE EXCEPTION 'el asiento está anulado: reclasificarlo rompería el espejo con su contra-asiento (I-E4-11)'
      USING ERRCODE = '23514', CONSTRAINT = 'journal_lines_reclassify_window';
  END IF;

  RETURN NEW;
END
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. (#7) `NO_ANALITICO` nunca lleva dimensión (I-E4-4), también en la BD.
--    El motor ya lo rechaza; hasta ahora la base no. Es el caso del `630`.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_non_analytic_has_no_dimension"
  CHECK ("analytic_type" IS DISTINCT FROM 'NO_ANALITICO'
         OR ("project_id" IS NULL AND "cost_center_id" IS NULL AND "business_line_id" IS NULL));
