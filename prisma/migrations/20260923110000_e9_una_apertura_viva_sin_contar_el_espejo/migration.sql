-- E9 · ronda 2 (R-1) — «una apertura viva» cuenta aperturas, no sus espejos
--
-- Con el contra-asiento de la reapertura heredando el `kind` del asiento que
-- anula (migración `20260923100000`), el espejo de la apertura de N+1 es un
-- asiento **vivo** de kind `OPENING`: ocupaba la plaza del índice único
-- «una apertura viva por ejercicio» y el **recierre no podía postear la apertura
-- nueva**. Lo mismo valdría para el cierre.
--
-- El índice quería decir «un ejercicio no tiene dos aperturas vigentes». Un
-- contra-asiento no es una apertura: es su anulación, y neteará a cero con ella
-- para siempre. Se excluyen del índice los asientos con `reverses_entry_id`, que
-- es exactamente lo que los distingue.
--
-- DROP + CREATE de dos índices únicos parciales: sin SUPERUSER y sin tocar
-- ninguna migración aplicada.

DROP INDEX IF EXISTS "journal_entries_one_live_opening_per_fiscal_year";
CREATE UNIQUE INDEX "journal_entries_one_live_opening_per_fiscal_year"
  ON "journal_entries" ("organization_id", "fiscal_year_id")
  WHERE ("kind" = 'OPENING' AND "voided_at" IS NULL AND "reverses_entry_id" IS NULL);

DROP INDEX IF EXISTS "journal_entries_one_live_closing_per_fiscal_year";
CREATE UNIQUE INDEX "journal_entries_one_live_closing_per_fiscal_year"
  ON "journal_entries" ("organization_id", "fiscal_year_id")
  WHERE ("kind" = 'CLOSING' AND "voided_at" IS NULL AND "reverses_entry_id" IS NULL);
