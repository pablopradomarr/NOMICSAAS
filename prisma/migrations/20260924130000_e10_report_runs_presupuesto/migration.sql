-- E10 · T4 — M5: `report_runs.budget_hash` y la clave de reutilización
-- (docs/design/E10-presupuesto-horas.md §2.3, ADR-0018 D4).
--
-- Dos `PRESUPUESTO_REAL` del mismo periodo y el mismo diario con VERSIONES
-- DISTINTAS de presupuesto son informes distintos. Sin el hash en la clave, la
-- caché serviría el de la versión equivocada — el mismo razonamiento de
-- `params_hash` (O-5) y de `allocation_run_set_hash` (O-E5-7).

ALTER TABLE "report_runs" ADD COLUMN "budget_hash" varchar(64) NOT NULL DEFAULT '∅';

-- Las filas existentes quedan con `'∅'` y **su clave no cambia**: sólo se le
-- añade un componente constante, así que NINGÚN informe cacheado se invalida por
-- la migración. Es lo contrario de lo que habría pasado recomponiendo
-- `analytics_key`, que es la alternativa descartada en §15.
DROP INDEX "report_runs_cache_key";
CREATE UNIQUE INDEX "report_runs_cache_key" ON "report_runs"
  ("organization_id", "type", "period_start", "period_end", "params_hash",
   "ledger_hash", "analytics_key", "git_sha", "budget_hash");

-- Un `PRESUPUESTO_REAL` sin presupuesto sellado no existe (O-E10-5, R-B-7): la
-- comparación contra un BORRADOR es previsualización no sellada, sin fila aquí.
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_budget_hash_required"
  CHECK ("type" <> 'PRESUPUESTO_REAL' OR "budget_hash" <> '∅');
