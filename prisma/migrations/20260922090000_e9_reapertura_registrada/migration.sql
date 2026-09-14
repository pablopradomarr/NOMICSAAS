-- E9 · ronda 1 de corrección — **H-3: la reapertura del ejercicio era imposible**
--
-- El defecto. `reopenFiscalYear` (D1 / O-21) deshace un cierre con **cuatro
-- contra-asientos en orden inverso**: T-28 (apertura) → T-27 (cierre) → T-26
-- (regularización) → T-25 (impuesto). Los tres primeros son de `kind`
-- `OPENING`, `CLOSING` y `REGULARIZATION`, y **CA-1** —en el motor
-- (`lib/ledger/void.ts`) y en esta misma base (`app.assert_reversal_target`,
-- migración `20260907100000_e3_ledger`)— prohíbe anularlos:
--
--     reopenFiscalYearAction → «Los asientos de tipo OPENING no se anulan con
--     contra-asiento»
--
-- Con lo que D1, O-21 e I-E9-21 eran **inalcanzables sobre un ejercicio
-- realmente cerrado**, y el test que los cubría pasaba en vacío (forzaba
-- `status = CLOSED` sobre un ejercicio sin ninguno de los cuatro asientos, así
-- que el bucle no encontraba objetivo y nunca llegaba al contra-asiento).
--
-- La corrección **no debilita CA-1**: la propia CA-1 dice que estos asientos «se
-- deshacen **reabriendo el ejercicio**», y eso es precisamente lo que hay que
-- dejar pasar. Se abre el paso **sólo por la vía registrada**, identificada por
-- el `ClosingRun` que se está reabriendo:
--
--   · en la aplicación, `VoidOptions.reopeningRunId`, que **sólo** pasa
--     `reopenFiscalYear`; `voidEntry` —la anulación pública, la del botón del
--     diario— no lo pasa nunca;
--   · en la base, el GUC de transacción `app.reopening_run_id`, que fija
--     `SET LOCAL` esa misma función dentro de su transacción y que muere con
--     ella. Sin él, el trigger sigue rechazando los tres kind exactamente igual
--     que antes — también para un `INSERT` por SQL directo o por un script.
--
-- Es la misma forma que ya usa el resto del producto para el tenant
-- (`app.current_org()`): un dato de transacción, no un privilegio de rol. No
-- exige SUPERUSER, no toca privilegios y no edita ninguna migración aplicada:
-- reemplaza la función por `CREATE OR REPLACE`, que es lo que un cambio de
-- regla de negocio hace.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. `app.reopening_run_id()` — el id de la reapertura en curso, o NULL
--
--    `current_setting(..., true)` devuelve NULL cuando el GUC no está fijado, y
--    la cadena vacía cuando `SET LOCAL … = ''`. Los dos casos son «no hay
--    reapertura». Un valor que no sea un uuid **es un error**, no un permiso:
--    se rechaza en vez de tragárselo, o cualquier cadena abriría la puerta.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.reopening_run_id() RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $fn$
DECLARE v_raw text;
BEGIN
  v_raw := nullif(current_setting('app.reopening_run_id', true), '');
  IF v_raw IS NULL THEN RETURN NULL; END IF;
  RETURN v_raw::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RAISE EXCEPTION 'app.reopening_run_id no es un uuid: la reapertura se identifica por su ClosingRun'
    USING ERRCODE = '22P02';
END $fn$;
REVOKE ALL ON FUNCTION app.reopening_run_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reopening_run_id() TO app_runtime, app_maintenance;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. `app.assert_reversal_target()` — CA-1 con su única salida
--
--    CA-2 (un contra-asiento no anula otro contra-asiento), la coherencia del
--    `kind` y la existencia del objetivo **no cambian**: la reapertura no los
--    necesita y relajarlos sería otra cosa.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.assert_reversal_target() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_kind      entry_kind;
  v_reopening uuid := app.reopening_run_id();
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
  -- CA-1, con la salida que la propia CA-1 nombra: la REAPERTURA REGISTRADA.
  IF v_kind IN ('OPENING', 'CLOSING', 'REGULARIZATION') AND v_reopening IS NULL THEN
    RAISE EXCEPTION 'los asientos de kind % no se anulan con contra-asiento: se deshacen reabriendo el ejercicio (CA-1)', v_kind
      USING ERRCODE = '23514', CONSTRAINT = 'journal_entry_reversal_target_kind';
  END IF;
  RETURN NEW;
END $fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Verificación: sin GUC, los tres kind siguen cerrados; el helper existe y
--    rechaza un valor que no sea uuid.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE v_ok boolean;
BEGIN
  IF app.reopening_run_id() IS NOT NULL THEN
    RAISE EXCEPTION 'sin SET LOCAL, app.reopening_run_id() tiene que ser NULL';
  END IF;
  BEGIN
    PERFORM set_config('app.reopening_run_id', 'no-es-un-uuid', true);
    PERFORM app.reopening_run_id();
    RAISE EXCEPTION 'app.reopening_run_id() ha admitido un valor que no es uuid';
  EXCEPTION WHEN invalid_text_representation THEN
    v_ok := true;
  END;
  PERFORM set_config('app.reopening_run_id', '', true);
  IF NOT v_ok THEN RAISE EXCEPTION 'la comprobación del uuid no se ha ejecutado'; END IF;
END $$;
