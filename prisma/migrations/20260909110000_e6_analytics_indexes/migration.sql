-- E6 · T20 (deuda aceptada de E4) — índices que hacen O(1) la matriz analítica
-- y las cuatro fotos del balance.
--
-- `getAnalyticAggregates` agrupa `journal_lines` por la tupla de destino
-- `(account_code, analytic_type, project_id, cost_center_id, business_line_id)`
-- acotada por organización y rango de fechas; los estados financieros agregan
-- por cuenta EXCLUYENDO `entry_kind` (la foto). Sin índice, cada render obliga a
-- un `Seq Scan` + `HashAggregate` sobre toda la tabla.
--
-- Los índices por proyecto y por CECO ya existen desde E4
-- (`journal_lines_organization_id_project_id_entry_date_idx` y su equivalente de
-- CECO): no se duplican aquí.
--
-- Son índices de LECTURA: no cambian una sola cifra y se revierten con un
-- `DROP INDEX`. Se crean sin `CONCURRENTLY` porque una migración de Prisma corre
-- dentro de una transacción; con la tabla ya grande en producción, el runbook
-- indica recrearlos con `CONCURRENTLY` fuera de la migración.

CREATE INDEX IF NOT EXISTS "journal_lines_organization_id_entry_date_account_code_analytic_type_idx"
  ON "journal_lines" ("organization_id", "entry_date", "account_code", "analytic_type");

CREATE INDEX IF NOT EXISTS "journal_lines_organization_id_account_code_entry_kind_entry_date_idx"
  ON "journal_lines" ("organization_id", "account_code", "entry_kind", "entry_date");
