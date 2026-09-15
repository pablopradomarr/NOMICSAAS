-- E11 · ola A — **corrección de M5**: el semi-append-only de `platform_invoices`
-- era decorativo (docs/design/E11-plataforma-saas.md §2.2, ADR-0019 D8).
--
-- M5 concedía `UPDATE` por COLUMNA sobre las tres únicas que llegan después del
-- `invoice.finalized` (`status`, `stored_object_id`, `hosted_invoice_url`)…
-- **pero sólo revocaba `DELETE`**. Y `ALTER DEFAULT PRIVILEGES` de esta base ya
-- había concedido `arwd` a `app_runtime` sobre toda tabla nueva, así que el
-- `GRANT UPDATE (…)` no acotaba nada: `app_runtime` podía reescribir el número,
-- las fechas, las cifras y el régimen fiscal de una factura ya emitida.
--
-- Es exactamente la lección que E10 M2 dejó escrita para `budgets` y que E9 M4
-- había aprendido con `closing_runs`: **hay que REVOCAR primero**, o la prueba de
-- privilegio pasa por vacuidad. Aquí la detectó el test de integración de T2, que
-- esperaba `42501` al tocar `number` y recibió un `23505` — la factura se estaba
-- dejando reescribir y lo único que la paraba era un índice único.
--
-- Va en su propia migración y no editando M5 porque **una migración aplicada no
-- se edita** (CLAUDE.md). Aditiva y sin SUPERUSER: dos `REVOKE` y un `GRANT`.

REVOKE UPDATE ON "platform_invoices" FROM app_runtime;

-- Sólo las tres de §2.2. Ni el número, ni la serie, ni `operation_date`, ni
-- `issued_at`, ni `iva_period`, ni las cifras, ni el tratamiento fiscal, ni la
-- prueba del NIF-IVA: **una factura emitida no se borra ni se renumera, se
-- rectifica** (art. 15 RD 1619/2012, I-E11-13).
GRANT UPDATE ("status", "stored_object_id", "hosted_invoice_url")
  ON "platform_invoices" TO app_runtime;

-- Verificación en la propia migración: `app_runtime` NO puede actualizar
-- `number`, y SÍ puede actualizar `status`. Si un día alguien vuelve a poner un
-- `GRANT UPDATE` a secas, esta migración ya estará aplicada y no avisará — por
-- eso el test de T2 lo comprueba también desde fuera.
DO $$
BEGIN
  IF has_column_privilege('app_runtime', 'platform_invoices', 'number', 'UPDATE') THEN
    RAISE EXCEPTION 'app_runtime puede reescribir platform_invoices.number: el semi-append-only no se sostiene';
  END IF;
  IF NOT has_column_privilege('app_runtime', 'platform_invoices', 'status', 'UPDATE') THEN
    RAISE EXCEPTION 'app_runtime no puede actualizar platform_invoices.status: el estado de cobro llega despues del finalized';
  END IF;
END $$;
