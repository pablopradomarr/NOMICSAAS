-- E7 · T4 — M4: `journal_lines` a `bigint` (**ADR-0015 D1**, APROBADO).
--
-- Por qué: `debit_cents` y `credit_cents` eran `integer` y el techo estaba en
-- 21 474 836,47 €. El producto se vende a empresas de **1 a 100 M€**
-- (`SPEC-FUNCIONAL` §0). En `allocation_lines` el mismo problema se retiró en E5.
-- El techo pasa a ser el entero seguro de JavaScript, 2^53 − 1 ≈ 90 mil millones
-- de euros, que es donde el borde (`models/ledger.ts`) planta `Number.isSafeInteger`.
--
-- **No cambia ni un valor.** `ALTER COLUMN … TYPE bigint` preserva el valor
-- exacto de todo `integer`: no hay redondeo, ni reescalado, ni cambio de
-- representación decimal. Por tanto `canonicalEntryForm`, `entryHash`,
-- `ledgerHash`, `ejercicio-{minimo,completo}`, `estados-esperados.json` y
-- `pyg-analitica-esperada.json` NO se mueven, y con I1/I2/I3/I6 a tolerancia 0
-- cualquier desviación saltaría de inmediato (criterio de aceptación 24).
--
-- Es **DDL puro y no exige SUPERUSER**, pero reescribe la tabla más grande con
-- `ACCESS EXCLUSIVE`: ventana de mantenimiento.
--
-- ── MEDICIÓN (T4, 2026-09-07, PostgreSQL local, disco SSD) ───────────────────
--   · **Fixture completo** (`tests/fixtures/ejercicio-completo.json` cargado con
--     `scripts/load-fixture.ts`: 92 asientos, 350 líneas, 608 kB de tabla):
--     **ALTER TABLE 24 ms** (`BEGIN` → `ALTER` → `ROLLBACK`, `\timing on`).
--   · **Extrapolación** sobre un clon estructural con **500 000 líneas** —el
--     diario de unos cinco ejercicios de una empresa de 10 M€—, mismas cuatro
--     columnas y un índice: **1,48 s**. La reescritura es lineal en filas y no
--     depende del valor: `bigint` ocupa 8 bytes donde `integer` ocupaba 4.
--   · Conclusión operativa: en el preview la ventana es de **segundos**, no de
--     minutos. Aun así se ejecuta en ventana de mantenimiento porque el bloqueo
--     es `ACCESS EXCLUSIVE` y cualquier lectura del diario espera.
--
-- Lo que NO se toca:
--   · Los `::bigint` que ya había en los agregados de `models/` (los `SUM()`
--     sobre `bigint` devuelven `numeric`, y ese cast es lo que los mantiene
--     enteros).
--   · `app.journal_entry_hash`: concatena `debit_cents::text`, y el texto de un
--     `bigint` es el mismo que el del `integer` que era.
--   · El `GRANT UPDATE` acotado de ADR-0010 sobre `journal_lines`: cambiar el
--     tipo de una columna no altera sus privilegios.

ALTER TABLE "journal_lines"
  ALTER COLUMN "debit_cents"           TYPE bigint,
  ALTER COLUMN "credit_cents"          TYPE bigint,
  ALTER COLUMN "tax_base_cents"        TYPE bigint,
  ALTER COLUMN "original_amount_cents" TYPE bigint;

COMMENT ON COLUMN "journal_lines"."debit_cents" IS
  'Céntimos enteros, bigint desde E7 (ADR-0015 D1). El motor y la UI siguen en number: la conversión vive en el borde (models/ledger.ts) con Number.isSafeInteger.';
COMMENT ON COLUMN "journal_lines"."credit_cents" IS
  'Céntimos enteros, bigint desde E7 (ADR-0015 D1). Ver debit_cents.';
