-- E9 · T4 — M5: B-6 (G-13). Ningún asiento nuevo con línea de IVA en un periodo
-- YA LIQUIDADO. (docs/design/E9-cierre-recurrentes.md §3.3 y §5.3.)
--
-- Es la BARRERA 2. La 1 la da la server action, con el mensaje legible y la
-- salida —«revierta la liquidación de 2026-T2 o contabilice en el periodo
-- corriente»—. Ésta es la que impide que un `INSERT` por SQL, un script o un
-- reintento de la cola metan una cuota en un trimestre ya presentado: el modelo
-- 303 dejaría de cuadrar con el libro y sólo se descubriría en una inspección.
--
-- Va DESPUÉS de M3 y M4 porque necesita `journal_entries.iva_period` y
-- `vat_settlements`, y en migración propia porque es una regla de negocio con
-- su propio test.

CREATE OR REPLACE FUNCTION app.assert_vat_period_open()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_period    text;
  v_settled   uuid;
BEGIN
  -- Sólo las líneas de IVA cierran el periodo. `472%` cubre `4720` (desglose de
  -- software) y `4728` (RECC); `477%`, `4770` y `4778`. Una línea de `473` o de
  -- `475x` no pertenece al 303 y no se bloquea aquí.
  IF NEW."account_code" NOT LIKE '472%' AND NEW."account_code" NOT LIKE '477%' THEN
    RETURN NEW;
  END IF;

  SELECT je."iva_period" INTO v_period
    FROM "journal_entries" je
   WHERE je."id" = NEW."entry_id" AND je."organization_id" = NEW."organization_id";

  IF v_period IS NULL THEN RETURN NEW; END IF;

  SELECT vs."id" INTO v_settled
    FROM "vat_settlements" vs
   WHERE vs."organization_id" = NEW."organization_id"
     AND vs."period" = v_period
     AND vs."status" = 'LIQUIDADA'
   LIMIT 1;

  IF v_settled IS NOT NULL THEN
    RAISE EXCEPTION
      'B-6: el periodo de IVA % ya está liquidado (liquidación %). Revierta la liquidación o contabilice en el periodo corriente',
      v_period, v_settled
      USING ERRCODE = '23514', CONSTRAINT = 'journal_entries_vat_period_settled';
  END IF;

  RETURN NEW;
END
$fn$;

-- Va sobre la LÍNEA y no sobre el asiento porque es la línea la que dice si hay
-- IVA: un asiento se conoce entero sólo cuando sus líneas están puestas, y un
-- trigger de asiento tendría que ser diferido y volver a leerlas.
CREATE TRIGGER "journal_entries_vat_period_settled"
  BEFORE INSERT ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION app.assert_vat_period_open();
