-- E3 · revisión ronda 1 — hallazgos #2 (autor obligatorio y verificable) y #8
-- (idempotencia de formulario).
--
-- #2. `posted_by_id` ya era NOT NULL, pero nada garantizaba que apuntara a un
-- usuario real: `models/ledger.postEntry` caía a `organizationId` cuando el
-- actor no traía usuario, de modo que el asiento quedaba «firmado» por la
-- organización y la traza (P6 de SPEC-FIABILIDAD) se perdía en silencio. El
-- código lo exige ahora y la FK lo repite en la base de datos.
--
-- La constraint se añade NOT VALID y se valida en el mismo paso SOLO si no hay
-- filas huérfanas: en un entorno de desarrollo con asientos «firmados» por la
-- organización, la migración no puede reventar el despliegue, pero tampoco
-- puede callarse. Deja aviso y la constraint activa para las filas NUEVAS.
ALTER TABLE "journal_entries" DROP CONSTRAINT IF EXISTS "journal_entries_posted_by_id_fkey";
ALTER TABLE "journal_entries"
  ADD CONSTRAINT "journal_entries_posted_by_id_fkey"
  FOREIGN KEY ("posted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

DO $$
DECLARE v_orphans integer;
BEGIN
  SELECT count(*) INTO v_orphans
    FROM "journal_entries" e
    LEFT JOIN "users" u ON u.id = e.posted_by_id
   WHERE u.id IS NULL;

  IF v_orphans = 0 THEN
    ALTER TABLE "journal_entries" VALIDATE CONSTRAINT "journal_entries_posted_by_id_fkey";
  ELSE
    RAISE WARNING 'journal_entries: % asiento(s) con posted_by_id sin usuario. La FK queda NOT VALID: '
                  'corrige esas filas y ejecuta ALTER TABLE journal_entries VALIDATE CONSTRAINT '
                  'journal_entries_posted_by_id_fkey;', v_orphans;
  END IF;
END $$;

-- #8. Idempotencia por organización. Índice ÚNICO PARCIAL: los asientos sin
-- clave (los del cargador de fixtures, los de sistema) no compiten entre sí.
ALTER TABLE "journal_entries" ADD COLUMN IF NOT EXISTS "idempotency_key" VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS "journal_entries_idempotency_key"
  ON "journal_entries" ("organization_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

COMMENT ON COLUMN "journal_entries"."idempotency_key" IS
  'Clave de idempotencia del formulario que originó el asiento (uuid generado en el cliente al montar). Un reenvío devuelve el asiento existente en vez de duplicarlo.';
