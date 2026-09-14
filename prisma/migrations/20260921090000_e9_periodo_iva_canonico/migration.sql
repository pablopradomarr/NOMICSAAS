-- E9 · ronda de integración — UNA forma canónica para la clave de periodo.
--
-- El defecto. La migración T4 (`20260920110000_e9_iva`) escribe el trimestre
-- como **`AAAA-Tn`** —`app.iva_period()`, el trigger `set_entry_iva_period` y
-- seis CHECK— mientras que el motor lo lee y lo escribe como **`AAAA-Qn`**:
-- `lib/recurring/schedule.periodKeyOf`, `lib/closing/vat.vatPeriodOf`,
-- `lib/extraction/reconcile.quarterOf` y `lib/ledger/invariants-e8.quarterOf`.
-- Con régimen TRIMESTRAL las dos claves no casan nunca: el trigger sobrescribe
-- lo que la aplicación acaba de escribir, el libro registro del periodo sale
-- **vacío** —`inPeriod()` compara `2026-Q3` con `2026-T3`—, la liquidación no
-- encuentra anotaciones y una regla recurrente trimestral no se puede ni dar de
-- alta. El arnés e2e lo rodeaba forzando el régimen MENSUAL, que es el único en
-- el que ambas formas coinciden (`AAAA-MM`).
--
-- La forma canónica es **`AAAA-Qn`**, la del diseño (§4.1
-- `PeriodKey = "2026-03" | "2026-Q2" | "2026-S1" | "2026"`, §5.3 y el mensaje
-- «el periodo 2026-Q2 está liquidado»), la de ADR-0014 D8 (`quarterOf` de E8) y
-- la de los fixtures sellados `extraccion-esperada.v1.1.json`,
-- `liquidacion-iva-esperada.json` y `periodificaciones-esperadas.json`. La `T`
-- de T4 es la excepción, y es la que se corrige aquí.
--
-- Migración **aditiva**: no se edita ninguna migración aplicada. Se reemplaza la
-- función, se sueltan los seis CHECK, se reescriben los datos ya guardados y se
-- vuelven a poner los CHECK con la forma canónica. El backfill va con el baile
-- `NO FORCE` / `FORCE` que exige la RLS estricta (CLAUDE.md, ADR-0009 §7): con
-- `FORCE`, el propietario tampoco esquiva las políticas y el `UPDATE` vería 0
-- filas — y `recurring_occurrences` lleva además una política RESTRICTIVA
-- `FOR UPDATE USING (false)` que sólo se calla con la tabla en `NO FORCE`.
--
-- El DDL es transaccional: si algo falla, la base queda como estaba.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. La función pura: `-T` → `-Q`. Sigue siendo IMMUTABLE (`extract` + `lpad`),
--    que es lo que le permite entrar en un CHECK y en un índice.
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
      lpad(EXTRACT(YEAR FROM GREATEST(p_document_date, p_reception_date))::int::text, 4, '0') || '-Q' ||
      (((EXTRACT(MONTH FROM GREATEST(p_document_date, p_reception_date))::int - 1) / 3) + 1)::text
  END
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Fuera los CHECK con la forma vieja. Se sueltan ANTES del backfill: un
--    CHECK no admite datos que lo violen ni un instante.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "journal_entries"      DROP CONSTRAINT IF EXISTS "journal_entries_iva_period_format";
ALTER TABLE "vat_settlements"      DROP CONSTRAINT IF EXISTS "vat_settlements_period_format";
ALTER TABLE "vat_settlements"      DROP CONSTRAINT IF EXISTS "vat_settlements_period_matches_kind";
ALTER TABLE "prorrata_years"       DROP CONSTRAINT IF EXISTS "prorrata_years_regularization_period_format";
ALTER TABLE "recurring_entries"    DROP CONSTRAINT IF EXISTS "recurring_entries_start_period_format";
ALTER TABLE "recurring_entries"    DROP CONSTRAINT IF EXISTS "recurring_entries_end_period_format";
ALTER TABLE "recurring_occurrences" DROP CONSTRAINT IF EXISTS "recurring_occurrences_period_format";

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Backfill de lo ya escrito, bajo NO FORCE / FORCE (CLAUDE.md).
--    `regexp_replace` con ancla: sólo se toca `-T` seguido de un dígito 1-4 al
--    final de la clave, nunca una `T` que forme parte de otra cosa.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t         text;
  v_entries bigint := 0;
  v_total   bigint := 0;
  v_touched bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'journal_entries', 'vat_settlements', 'prorrata_years',
    'recurring_entries', 'recurring_occurrences'
  ] LOOP
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
  END LOOP;

  UPDATE "journal_entries"
     SET "iva_period" = regexp_replace("iva_period", '^([0-9]{4})-T([1-4])$', '\1-Q\2')
   WHERE "iva_period" ~ '^[0-9]{4}-T[1-4]$';
  GET DIAGNOSTICS v_entries = ROW_COUNT;

  UPDATE "vat_settlements"
     SET "period" = regexp_replace("period", '^([0-9]{4})-T([1-4])$', '\1-Q\2')
   WHERE "period" ~ '^[0-9]{4}-T[1-4]$';
  GET DIAGNOSTICS v_touched = ROW_COUNT; v_total := v_total + v_touched;

  UPDATE "prorrata_years"
     SET "regularization_period" = regexp_replace("regularization_period", '^([0-9]{4})-T([1-4])$', '\1-Q\2')
   WHERE "regularization_period" ~ '^[0-9]{4}-T[1-4]$';
  GET DIAGNOSTICS v_touched = ROW_COUNT; v_total := v_total + v_touched;

  UPDATE "recurring_entries"
     SET "start_period" = regexp_replace("start_period", '^([0-9]{4})-T([1-4])$', '\1-Q\2')
   WHERE "start_period" ~ '^[0-9]{4}-T[1-4]$';
  GET DIAGNOSTICS v_touched = ROW_COUNT; v_total := v_total + v_touched;

  UPDATE "recurring_entries"
     SET "end_period" = regexp_replace("end_period", '^([0-9]{4})-T([1-4])$', '\1-Q\2')
   WHERE "end_period" ~ '^[0-9]{4}-T[1-4]$';
  GET DIAGNOSTICS v_touched = ROW_COUNT; v_total := v_total + v_touched;

  UPDATE "recurring_occurrences"
     SET "period" = regexp_replace("period", '^([0-9]{4})-T([1-4])$', '\1-Q\2')
   WHERE "period" ~ '^[0-9]{4}-T[1-4]$';
  GET DIAGNOSTICS v_touched = ROW_COUNT; v_total := v_total + v_touched;

  FOREACH t IN ARRAY ARRAY[
    'journal_entries', 'vat_settlements', 'prorrata_years',
    'recurring_entries', 'recurring_occurrences'
  ] LOOP
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;

  RAISE NOTICE 'periodo canónico AAAA-Qn: % asiento(s) y % clave(s) de E9 reescritas', v_entries, v_total;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Los CHECK, otra vez, con la forma canónica. Mismos nombres: la restricción
--    es la misma regla, no una nueva.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "journal_entries"
  ADD CONSTRAINT "journal_entries_iva_period_format"
    CHECK ("iva_period" IS NULL OR "iva_period" ~ '^[0-9]{4}-(0[1-9]|1[0-2]|Q[1-4])$');

ALTER TABLE "vat_settlements"
  ADD CONSTRAINT "vat_settlements_period_format"
    CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2]|Q[1-4])$'),
  ADD CONSTRAINT "vat_settlements_period_matches_kind"
    CHECK (("period_kind" = 'MENSUAL') = ("period" !~ '-Q'));

ALTER TABLE "prorrata_years"
  ADD CONSTRAINT "prorrata_years_regularization_period_format"
    CHECK ("regularization_period" IS NULL
           OR "regularization_period" ~ '^[0-9]{4}-(0[1-9]|1[0-2]|Q[1-4])$');

ALTER TABLE "recurring_entries"
  ADD CONSTRAINT "recurring_entries_start_period_format"
    CHECK ("start_period" ~ '^[0-9]{4}-(0[1-9]|1[0-2]|Q[1-4])$'),
  ADD CONSTRAINT "recurring_entries_end_period_format"
    CHECK ("end_period" IS NULL OR "end_period" ~ '^[0-9]{4}-(0[1-9]|1[0-2]|Q[1-4])$');

ALTER TABLE "recurring_occurrences"
  ADD CONSTRAINT "recurring_occurrences_period_format"
    CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2]|Q[1-4])$');

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Verificación: ni una clave con la forma vieja, ni una tabla en NO FORCE.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM "journal_entries"      WHERE "iva_period"            ~ '-T[1-4]$')
  OR EXISTS (SELECT 1 FROM "vat_settlements"      WHERE "period"                ~ '-T[1-4]$')
  OR EXISTS (SELECT 1 FROM "prorrata_years"       WHERE "regularization_period" ~ '-T[1-4]$')
  OR EXISTS (SELECT 1 FROM "recurring_entries"    WHERE "start_period"          ~ '-T[1-4]$'
                                                     OR "end_period"            ~ '-T[1-4]$')
  OR EXISTS (SELECT 1 FROM "recurring_occurrences" WHERE "period"               ~ '-T[1-4]$') THEN
    RAISE EXCEPTION 'quedan claves de periodo con la forma AAAA-Tn tras el backfill';
  END IF;

  IF app.iva_period(DATE '2026-08-14', NULL, 'TRIMESTRAL') <> '2026-Q3' THEN
    RAISE EXCEPTION 'app.iva_period no devuelve la forma canónica AAAA-Qn';
  END IF;

  FOREACH t IN ARRAY ARRAY[
    'journal_entries', 'vat_settlements', 'prorrata_years',
    'recurring_entries', 'recurring_occurrences'
  ] LOOP
    IF NOT (SELECT relforcerowsecurity FROM pg_class WHERE relname = t) THEN
      RAISE EXCEPTION '% ha quedado en NO FORCE ROW LEVEL SECURITY', t;
    END IF;
  END LOOP;
END $$;
