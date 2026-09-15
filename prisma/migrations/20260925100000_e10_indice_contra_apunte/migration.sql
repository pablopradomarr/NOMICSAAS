-- E10 · ronda 1 — índice del contra-apunte de horas
--
-- `time_entries.corrects_entry_id` es una FK a la propia tabla y **no tenía
-- índice**. Dos consecuencias, las dos reales:
--
--  1. **Producto**: «¿qué contra-apuntes corrigen este parte?» —lo que I-E10-4
--     comprueba y lo que la ficha del parte enseña— era un recorrido secuencial
--     de `time_entries`.
--  2. **Operación**: sin índice, PostgreSQL verifica el `ON DELETE` de la FK
--     con un SEQ SCAN **por fila borrada**. Vaciar los 120 000 partes del techo
--     de §9 pasaba a ser cuadrático, y el `afterAll` de
--     `tests/integration/perf-budget.test.ts` agotaba diez minutos dejando la
--     tabla llena para los ficheros siguientes — que es lo que hacía fallar por
--     897 ms el techo de `/audit/bank/[id]` de E7, ya medido y en verde.
--
-- Índice PARCIAL: sólo una minoría de los partes son contra-apuntes, y el
-- planificador no necesita las filas con `NULL` para resolver ni la FK ni la
-- pregunta del producto.
--
-- Migración ADITIVA: ni DDL destructivo, ni SUPERUSER, ni datos tocados.

CREATE INDEX IF NOT EXISTS "time_entries_corrects_entry_id_idx"
  ON "time_entries" ("corrects_entry_id")
  WHERE "corrects_entry_id" IS NOT NULL;
