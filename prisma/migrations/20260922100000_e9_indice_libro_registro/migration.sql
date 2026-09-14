-- E9 · ronda 1 de corrección — el índice que el LIBRO REGISTRO necesita
--
-- §9 fija un techo de **800 ms** para `/reports/vat` con 2 000 documentos en el
-- año (criterio 39). Al activarlo en `tests/integration/perf-closing.test.ts`
-- (DEBE 3 de la revisión) la lectura se medía en **~1 500 ms** sobre una base
-- con el resto de suites cargadas, mientras que sobre una base pequeña bajaba de
-- 800: la diferencia es el **tamaño de `journal_lines`**, no el del periodo.
--
-- El motivo está en el plan. `readVatBook` acota los asientos del periodo con:
--
--     EXISTS (SELECT 1 FROM journal_lines v
--              WHERE v.organization_id = e.organization_id AND v.entry_id = e.id
--                AND v.account_code IN (472, 477, 4728, 4778))
--
-- y no había ningún índice que sirviera a la vez para el tenant, la CUENTA y el
-- asiento: el índice `(organization_id, account_code, entry_date)` no lleva
-- `entry_id`, y `(organization_id, entry_id)` no lleva la cuenta, así que el
-- planificador acaba recorriendo la tabla y filtrando por `account_code`.
--
-- `(organization_id, account_code, entry_id)` cubre el semijoin entero: la
-- condición de existencia se resuelve en el índice y no visita la tabla. Es
-- además el orden natural de la agrupación del libro (por cuenta de IVA y por
-- asiento).
--
-- Índice puro, sin DDL de tabla y sin datos que tocar: no exige SUPERUSER, no
-- necesita el baile `NO FORCE`/`FORCE` —no escribe filas— y no edita ninguna
-- migración aplicada.

CREATE INDEX IF NOT EXISTS "journal_lines_organization_id_account_code_entry_id_idx"
  ON "journal_lines" ("organization_id", "account_code", "entry_id");
