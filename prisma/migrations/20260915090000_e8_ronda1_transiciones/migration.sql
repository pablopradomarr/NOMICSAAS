-- E8 · ronda 1 de corrección (revisor #6, PUEDE)
--
-- El trigger de transición de estado admitía `PROPOSED → DRAFT`, una rama que
-- §2.3 del diseño no enumera: el contrato aprobado es
-- `DRAFT → PROPOSED → POSTED → VOID`, el atajo `DRAFT → POSTED` y la vuelta
-- `VOID → PROPOSED` (anular y rehacer). La rama era inocua —`PROPOSED` no tiene
-- asiento, así que retroceder no dejaba nada colgando— pero una rama de más en
-- una máquina de estados que gobierna «POSTED ⟺ asiento» es exactamente lo que
-- no debe divergir del documento que la aprobó.
--
-- Migración ADITIVA y sin SUPERUSER: `CREATE OR REPLACE FUNCTION` sobre una
-- función que ya es propiedad del rol que ejecuta las migraciones. No toca
-- datos, no toca RLS y no reasigna propietario.
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
      (OLD."status" = 'PROPOSED' AND NEW."status" = 'POSTED')                OR
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
