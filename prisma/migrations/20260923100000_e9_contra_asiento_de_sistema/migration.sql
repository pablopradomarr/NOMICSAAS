-- E9 · ronda 2 (R-1) — el contra-asiento de la reapertura hereda el `kind`
--
-- El defecto R-1 de la re-auditoría tenía dos mitades. La primera —la fecha—
-- se corrige en `models/fiscal-years.ts`: los contra-asientos de T-25…T-28 se
-- postean **dentro** del ejercicio reabierto. La segunda es ésta: con
-- `kind = REVERSAL`, el espejo de una apertura, un cierre o una regularización
-- **no** quedaba excluido por los filtros que dejan fuera los asientos de
-- sistema (la PyG de I3/I4, `readAccountBalances`, la continuidad de I-E7-14,
-- la cobertura analítica de I-E4-1). El original salía y el espejo entraba, de
-- modo que el par dejaba de netear y el saldo de 129 aparecía por el cierre ya
-- anulado.
--
-- Por eso el contra-asiento de un asiento de sistema —que sólo existe dentro de
-- una reapertura registrada— **hereda el `kind` del asiento que anula**. Sigue
-- siendo un contra-asiento: `reverses_entry_id`, plantilla `CONTRA_ASIENTO` y
-- espejo exacto línea a línea; lo único que cambia es que los dos entran o los
-- dos salen de cada filtro por `kind`.
--
-- La base lo admite sólo en esa forma exacta:
--   · `reverses_entry_id` con `kind` distinto de `REVERSAL` ⇒ el `kind` tiene
--     que ser **el mismo** que el del asiento anulado y ser uno de los tres de
--     sistema;
--   · y, como en `20260923090000`, la reapertura tiene que estar respaldada por
--     un `ClosingRun` real del mismo tenant en `CERRADO` o `REABIERTO`.
-- Cualquier otra combinación sigue siendo CA-1.
--
-- `CREATE OR REPLACE` sobre la función del trigger: sin SUPERUSER y sin editar
-- ninguna migración aplicada.

CREATE OR REPLACE FUNCTION app.assert_reversal_target() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_kind      entry_kind;
  v_reopening uuid := app.reopening_run_id();
  v_run_ok    boolean := false;
BEGIN
  IF NEW.reverses_entry_id IS NULL THEN RETURN NEW; END IF;

  SELECT kind INTO v_kind FROM journal_entries
   WHERE id = NEW.reverses_entry_id AND organization_id = NEW.organization_id;
  IF v_kind IS NULL THEN
    RAISE EXCEPTION 'el asiento anulado no existe en la organización' USING ERRCODE = '23503';
  END IF;
  IF v_kind = 'REVERSAL' THEN
    RAISE EXCEPTION 'un contra-asiento no puede anular otro contra-asiento (I-E3-4)'
      USING ERRCODE = '23514', CONSTRAINT = 'journal_entry_no_double_reversal';
  END IF;

  -- Un contra-asiento es `REVERSAL`, salvo el espejo de un asiento de sistema
  -- dentro de una reapertura registrada, que hereda el kind del original.
  IF NEW.kind <> 'REVERSAL'
     AND NOT (NEW.kind = v_kind AND v_kind IN ('OPENING', 'CLOSING', 'REGULARIZATION')) THEN
    RAISE EXCEPTION 'solo un asiento REVERSAL puede referenciar reverses_entry_id'
      USING ERRCODE = '23514', CONSTRAINT = 'journal_entry_reversal_kind';
  END IF;

  -- CA-1, con la única salida que la propia CA-1 nombra: la REAPERTURA
  -- REGISTRADA, respaldada por un `ClosingRun` real del mismo tenant, y con el
  -- espejo llevando el `kind` del asiento que anula.
  IF v_kind IN ('OPENING', 'CLOSING', 'REGULARIZATION') THEN
    IF v_reopening IS NOT NULL THEN
      SELECT true INTO v_run_ok
        FROM closing_runs r
       WHERE r.id = v_reopening
         AND r.organization_id = NEW.organization_id
         AND r.status IN ('CERRADO', 'REABIERTO');
    END IF;
    IF NOT COALESCE(v_run_ok, false) OR NEW.kind <> v_kind THEN
      RAISE EXCEPTION
        'los asientos de kind % no se anulan con contra-asiento: se deshacen reabriendo el ejercicio, con un ClosingRun CERRADO de la organización detrás y con el espejo llevando el mismo kind (CA-1)',
        v_kind
        USING ERRCODE = '23514', CONSTRAINT = 'journal_entry_reversal_target_kind';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
