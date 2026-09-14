-- E9 · ronda 2 — el GUC de reapertura tiene que ser un `ClosingRun` REAL
--
-- PUEDE (a) de la revisión de la ronda 1. `20260922090000_e9_reapertura_registrada`
-- abrió CA-1 para los tres kind de sistema cuando la transacción lleva
-- `app.reopening_run_id`, y el revisor lo aceptó **con reparo**: cualquier uuid
-- valía, así que un `SET LOCAL` inventado —desde SQL directo, desde un script,
-- desde cualquier sitio que pudiera fijar el GUC— abría la puerta igual. Lo que
-- protegía el flanco era la capa de aplicación, y la base decía menos que antes.
--
-- Aquí la base vuelve a decirlo entera: el uuid tiene que corresponder a un
-- `ClosingRun` **de la organización del asiento** y en un estado que signifique
-- «se está deshaciendo este cierre» — `CERRADO` (el que se va a reabrir) o
-- `REABIERTO` (la reapertura ya marcó el run antes de terminar la transacción).
-- Con eso, un GUC inventado no vale de nada: no hay run que lo respalde.
--
-- Se comprueba **dentro del trigger**, con el `organization_id` del asiento que
-- se está insertando, así que tampoco sirve el run de otro tenant.
--
-- `CREATE OR REPLACE` sobre la función del trigger: sin SUPERUSER, sin tocar
-- privilegios y sin editar ninguna migración aplicada.

CREATE OR REPLACE FUNCTION app.assert_reversal_target() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_kind      entry_kind;
  v_reopening uuid := app.reopening_run_id();
  v_run_ok    boolean := false;
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

  -- CA-1, con la única salida que la propia CA-1 nombra: la REAPERTURA
  -- REGISTRADA, y **respaldada por un `ClosingRun` real del mismo tenant**.
  IF v_kind IN ('OPENING', 'CLOSING', 'REGULARIZATION') THEN
    IF v_reopening IS NOT NULL THEN
      SELECT true INTO v_run_ok
        FROM closing_runs r
       WHERE r.id = v_reopening
         AND r.organization_id = NEW.organization_id
         AND r.status IN ('CERRADO', 'REABIERTO');
    END IF;
    IF NOT COALESCE(v_run_ok, false) THEN
      RAISE EXCEPTION
        'los asientos de kind % no se anulan con contra-asiento: se deshacen reabriendo el ejercicio, y la reapertura tiene que estar respaldada por un ClosingRun CERRADO de la organización (CA-1)',
        v_kind
        USING ERRCODE = '23514', CONSTRAINT = 'journal_entry_reversal_target_kind';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;

-- Verificación: sin GUC sigue siendo NULL, y un uuid que no respalda ningún
-- `ClosingRun` no puede pasar por bueno (se comprueba el helper; el rechazo
-- entero lo ejerce `tests/integration/e9-ronda2.test.ts` sobre datos reales).
DO $$
BEGIN
  IF app.reopening_run_id() IS NOT NULL THEN
    RAISE EXCEPTION 'sin SET LOCAL, app.reopening_run_id() tiene que ser NULL';
  END IF;
  PERFORM set_config('app.reopening_run_id', gen_random_uuid()::text, true);
  IF app.reopening_run_id() IS NULL THEN
    RAISE EXCEPTION 'app.reopening_run_id() no lee el GUC';
  END IF;
  IF EXISTS (SELECT 1 FROM closing_runs WHERE id = app.reopening_run_id()) THEN
    RAISE EXCEPTION 'el uuid de prueba no debería existir como ClosingRun';
  END IF;
  PERFORM set_config('app.reopening_run_id', '', true);
END $$;
