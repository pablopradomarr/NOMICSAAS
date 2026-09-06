-- E8 · T4 — `files.sha256` pasa a NOT NULL (G-11, I-E8-9).
--
-- `files.sha256` es el eslabón que ata un asiento a los bytes exactos del
-- documento: I-E8-2 lo comprueba contra el disco y contra
-- `extraction_runs.file_sha256`, RC-10 lo exige antes de contabilizar, e I-E8-9
-- prohíbe que un fichero sin sha tenga run `LLM` o asiento. La migración
-- `20260913100000_e8_documentos` crea la columna **nullable** porque una
-- migración no lee el sistema de ficheros: el sha lo calcula
-- `scripts/backfill-file-sha256.ts`, como `app_maintenance`, por organización y
-- en lotes reanudables.
--
-- **Por qué el endurecimiento es condicional y no un `ALTER … SET NOT NULL` a
-- secas.** El diseño dice «endurece cuando el script reporta 0 pendientes», y
-- eso es una precondición de OPERADOR que una migración no puede cumplir por sí
-- misma. Fallar aquí dejaría `prisma migrate deploy` **cortado a mitad de
-- cadena** en toda instalación heredada con ficheros previos —el caso que
-- ejerce `tests/integration/migration.test.ts` sobre un volcado real de
-- TaxHacker—, que es un desenlace peor que el problema: la base se queda con
-- media épica aplicada y el operador, con una migración en estado fallido.
--
-- Así que la migración hace las dos cosas que sí puede hacer sola:
--   1. deja `app.harden_files_sha256()`, que endurece la columna en cuanto no
--      queden pendientes y devuelve cuántos faltan si los hay;
--   2. la INVOCA. En una base nueva —y en la de tests— eso endurece aquí mismo;
--      en una heredada avisa con un WARNING que nombra el script exacto.
-- `scripts/backfill-file-sha256.ts` la llama al terminar con `--apply`, de modo
-- que el endurecimiento ocurre solo, sin un segundo despliegue.

CREATE OR REPLACE FUNCTION app.harden_files_sha256() RETURNS bigint
LANGUAGE plpgsql AS $fn$
DECLARE pendientes bigint;
BEGIN
  SELECT count(*) INTO pendientes FROM "files" WHERE "sha256" IS NULL;

  IF pendientes = 0 THEN
    -- Idempotente: si ya es NOT NULL, el ALTER no hace nada.
    ALTER TABLE "files" ALTER COLUMN "sha256" SET NOT NULL;
    COMMENT ON COLUMN "files"."sha256" IS
      'sha256 de los bytes del fichero (G-11). NOT NULL: sin él no hay eslabón entre el asiento y el documento (I-E8-2, I-E8-9).';
  ELSE
    COMMENT ON COLUMN "files"."sha256" IS
      'sha256 de los bytes del fichero (G-11). PENDIENTE de endurecer a NOT NULL: quedan ficheros sin sha. Ejecuta scripts/backfill-file-sha256.ts --all --apply.';
    RAISE WARNING
      'files: quedan % fichero(s) sin sha256, así que la columna sigue admitiendo NULL. Ejecuta: DATABASE_URL_MAINTENANCE=… npx tsx scripts/backfill-file-sha256.ts --all --apply (endurece la columna al terminar). Hasta entonces esos ficheros no se analizan ni se contabilizan (I-E8-9).',
      pendientes;
  END IF;

  RETURN pendientes;
END
$fn$;

REVOKE ALL ON FUNCTION app.harden_files_sha256() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.harden_files_sha256() TO app_maintenance;

SELECT app.harden_files_sha256();
