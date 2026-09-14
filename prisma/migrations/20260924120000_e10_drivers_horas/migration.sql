-- E10 · T4 — M4: encender los drivers `HOURS` y `HEADCOUNT`
-- (docs/design/E10-presupuesto-horas.md §2.3, ADR-0018 D1; deuda §0-bis #2).
--
-- ADR-0013 D4 se cumple del todo: E10 retira el CHECK **y** aporta los datos
-- (M3), la base sellada (`time_hash` + su ventana) y la validación al sellar. No
-- queda ninguna regla inerte: un driver disponible sin base es peor que un driver
-- bloqueado, porque reparte con un cero que nadie ve.
--
-- Aditiva y ejecutable por un rol NO superusuario. `allocation_runs` no tiene
-- filas con drivers de actividad, así que las dos columnas nuevas nacen con el
-- valor correcto (`'∅'` y ventana NULL) para todo lo ya sellado: no hay backfill.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Fuera el CHECK que bloqueaba los dos drivers
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "allocation_rules" DROP CONSTRAINT "allocation_rules_driver_available";

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. D1 + O-E10-1 — el CUARTO sello del run y LA VENTANA QUE CUBRE
--
--    La base de `HOURS`/`HEADCOUNT` no vive en el diario, y con fallback
--    `YTD`/`PRIOR_PERIOD` tampoco vive dentro del periodo del run: una regla con
--    `zeroBaseFallback = YTD` reparte con partes de TODO el ejercicio, así que
--    aprobar en mayo un parte de enero no cambiaba el `time_hash` de marzo y el
--    run seguía luciendo vigente. La ventana se PERSISTE para que la
--    comprobación de staleness sea reproducible sin releer las reglas.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "allocation_runs"
  ADD COLUMN "time_hash" varchar(64) NOT NULL DEFAULT '∅',
  ADD COLUMN "time_hash_window_start" date,
  ADD COLUMN "time_hash_window_end"   date;

ALTER TABLE "allocation_runs"
  ADD CONSTRAINT "allocation_runs_time_window" CHECK (
    ("time_hash" = '∅') = ("time_hash_window_start" IS NULL)
    AND ("time_hash_window_start" IS NULL) = ("time_hash_window_end" IS NULL)
    AND ("time_hash_window_end" IS NULL
         OR ("time_hash_window_end" >= "time_hash_window_start"
             -- La ventana CONTIENE al periodo del run: nunca se sella sobre
             -- menos partes de los que el reparto consumió.
             AND "time_hash_window_end" >= "period_end"
             AND "time_hash_window_start" <= "period_start")));

-- `app_runtime` NO puede actualizar las tres columnas: el run sigue siendo
-- append-only salvo en las cinco de sustitución y reversión (E5 §2.3 bloque 7).
-- El `GRANT UPDATE` de columna de E5 ya las excluye por construcción —lista
-- cerrada—, así que no hay nada que revocar; se deja escrito para que nadie lo dé
-- por olvidado.

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. `HEADCOUNT` sólo reparte entre CECOs (D1)
--
--    Con proyectos no hay plantilla declarada —`headcount_snapshots` es por
--    CECO— y derivarla de las horas sería el driver `HOURS` con otro nombre.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "allocation_rules" ADD CONSTRAINT "allocation_rules_headcount_targets"
  CHECK ("driver" <> 'HEADCOUNT' OR "target_kind" = 'COST_CENTERS');
