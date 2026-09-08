-- E9 · T4 — M6: numeración VIVA (O-20, ADR-0016 D1).
-- (docs/design/E9-cierre-recurrentes.md §3.3, §4.8 y §6.2.)
--
-- QUÉ ESTABA MAL. N-1 y N-5 de E3 hablan de POSICIONES ABSOLUTAS: el `OPENING`
-- es el asiento nº 1 del ejercicio y el `CLOSING`, el último. En cuanto D1
-- permite reabrir —art. 253 LSC, antes de formular—, esa lectura deja el
-- ejercicio incapaz de volver a cerrarse: la reapertura anula T-25…T-28, pero
-- los asientos anulados siguen ahí (ADR-0003: nada se borra), así que el
-- siguiente cierre encuentra un `CLOSING` que ya no es el último y un `OPENING`
-- que ya no es el nº 1, e I-E9-14 falla sobre un ejercicio perfectamente sano.
--
-- CÓMO SE ARREGLA. Las dos comprobaciones se reformulan en términos de ASIENTO
-- VIVO —no anulado—: hay a lo sumo UN `OPENING` vivo y UN `CLOSING` vivo por
-- ejercicio, y son el primero y el último de los vivos. Lo que queda anulado es
-- historia, y la historia no cuenta para la posición.
--
-- Aditiva y ejecutable por un rol NO superusuario.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. N-1′ — a lo sumo un `OPENING` vivo y un `CLOSING` vivo por ejercicio
--    Índices únicos PARCIALES: la regla vive en la base, no sólo en el motor.
--    Con la regla en TypeScript, un segundo cierre por SQL —o por un reintento
--    de la cola tras un timeout— dejaba dos asientos de cierre y un balance de
--    apertura duplicado.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "journal_entries_one_live_opening_per_fiscal_year"
  ON "journal_entries" ("organization_id", "fiscal_year_id")
  WHERE "kind" = 'OPENING' AND "voided_at" IS NULL;

CREATE UNIQUE INDEX "journal_entries_one_live_closing_per_fiscal_year"
  ON "journal_entries" ("organization_id", "fiscal_year_id")
  WHERE "kind" = 'CLOSING' AND "voided_at" IS NULL;

-- Índice de apoyo: la comprobación de posición recorre los asientos VIVOS del
-- ejercicio por número, y sin él sería un escaneo del diario entero.
CREATE INDEX "journal_entries_live_by_number_idx"
  ON "journal_entries" ("organization_id", "fiscal_year_id", "entry_number")
  WHERE "voided_at" IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. `app.numeracion_viva(org, fiscal_year)` — N-1′ y N-5′ calculados en SQL
--
--    Devuelve las cifras con las que el motor decide, no un veredicto: quien
--    compone el paso del checklist y su evidencia es `lib/closing/checklist.ts`
--    (T13), y quien las convierte en invariante, `lib/closing/invariants-e9.ts`
--    (T11). Aquí sólo vive el agregado, porque es lo que no debe materializarse
--    en memoria (estándar de calidad: agregados en SQL).
--
--    · `ok_n1`: el `OPENING` vivo, si lo hay, es el de menor número vivo, y el
--      `CLOSING` vivo, el de mayor.
--    · `ok_n5`: la numeración de los asientos VIVOS es no decreciente en fecha.
--      Sigue siendo INFO y no FAIL (E3): el diario se presenta ordenado por
--      `(entry_date, entry_number)`.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.numeracion_viva(p_org uuid, p_fiscal_year uuid)
RETURNS TABLE (
  live_count      bigint,
  min_number      integer,
  max_number      integer,
  opening_number  integer,
  closing_number  integer,
  out_of_order    bigint,
  ok_n1           boolean,
  ok_n5           boolean
)
LANGUAGE sql
STABLE
AS $fn$
  WITH vivos AS (
    SELECT je."entry_number", je."entry_date", je."kind"
      FROM "journal_entries" je
     WHERE je."organization_id" = p_org
       AND je."fiscal_year_id"  = p_fiscal_year
       AND je."voided_at" IS NULL
  ),
  desorden AS (
    SELECT count(*) AS n
      FROM (
        SELECT "entry_date",
               lag("entry_date") OVER (ORDER BY "entry_number") AS anterior
          FROM vivos
      ) s
     WHERE s.anterior IS NOT NULL AND s."entry_date" < s.anterior
  )
  SELECT
    (SELECT count(*) FROM vivos),
    (SELECT min("entry_number") FROM vivos),
    (SELECT max("entry_number") FROM vivos),
    (SELECT min("entry_number") FROM vivos WHERE "kind" = 'OPENING'),
    (SELECT max("entry_number") FROM vivos WHERE "kind" = 'CLOSING'),
    (SELECT n FROM desorden),
    -- N-1′: si hay apertura viva es la primera, y si hay cierre vivo es el
    -- último. Un ejercicio sin ninguno de los dos cumple N-1′ por definición.
    COALESCE((SELECT min("entry_number") FROM vivos WHERE "kind" = 'OPENING')
               = (SELECT min("entry_number") FROM vivos), true)
    AND COALESCE((SELECT max("entry_number") FROM vivos WHERE "kind" = 'CLOSING')
               = (SELECT max("entry_number") FROM vivos), true),
    (SELECT n FROM desorden) = 0
$fn$;

REVOKE ALL ON FUNCTION app.numeracion_viva(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.numeracion_viva(uuid, uuid) TO app_runtime, app_maintenance;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Comprobación sobre lo YA existente
--    Si alguna base tuviera dos `OPENING` o dos `CLOSING` vivos en el mismo
--    ejercicio, los índices únicos de arriba habrían fallado al crearse. Que la
--    migración se aplique ES la comprobación; se deja escrito para que nadie
--    tenga que deducirlo leyendo el SQL.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE indexname = 'journal_entries_one_live_closing_per_fiscal_year') THEN
    RAISE EXCEPTION 'M6: el índice de CLOSING vivo no se ha creado';
  END IF;
END $$;
