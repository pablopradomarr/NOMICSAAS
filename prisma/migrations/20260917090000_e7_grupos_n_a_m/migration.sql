-- E7 · T11 — **M6: el grupo N-a-M, representable de verdad** (ADR-0015 D6.1,
-- diseño §2.2 O-3, §3.5 I-E7-11).
--
-- ## Por qué existe esta migración
--
-- `20260916110000_e7_conciliacion` dejó la conciliación N-a-M **imposible de
-- escribir**, por dos motivos que sólo se ven al implementar el camino de
-- escritura (T11) y que ningún test de M3 podía destapar porque todos sus
-- grupos son `SIMPLE`:
--
--  1. **La igualdad por PAREJA.** `app.bank_reconciliations_guard()` exigía
--     `linea.amount_cents = debe − haber` **en cada fila de pertenencia**. En una
--     remesa de 14 recibos contra un abono de 8 420,00 € ninguna pareja cumple
--     eso; la igualdad que el diseño pide es la del **GRUPO** (I-E7-11), y
--     I-E7-2 lo dice con todas las letras: «en grupo, la igualdad es la de
--     I-E7-11». El motor puro ya estaba escrito así (`checkIE72` sólo compara
--     pareja a pareja cuando el grupo tiene UN miembro).
--  2. **Los dos índices únicos parciales de I-E7-3.** Un grupo N-a-M se
--     representa como una **estrella**: la línea pivote emparejada con cada
--     apunte y el apunte pivote con cada línea (que es justo lo que consume
--     `checkIE711`, deduplicando ids). Con `UNIQUE (organization_id,
--     statement_line_id) WHERE group_unmatched_at IS NULL` la segunda fila de la
--     estrella choca **dentro del mismo grupo**, y la unicidad que I-E7-3 pide no
--     es «una fila» sino «**un grupo vivo**».
--
-- La corrección conserva la propiedad que M3 buscaba —que la unicidad viva EN LA
-- BASE, sin trigger con carrera— con dos columnas de **anclaje**: cada línea de
-- extracto y cada apunte están anclados **exactamente una vez** en su grupo, y
-- el índice único parcial se hace sobre las filas ancla. Las demás filas de la
-- estrella son emparejamientos internos del grupo y no compiten por nada.
--
-- Y la igualdad del grupo pasa a comprobarse **al COMMIT** con un
-- `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED`: durante la inserción de
-- la estrella el grupo está a medias por construcción, y al cerrar la
-- transacción tiene que cuadrar con tolerancia 0. I-E7-11 queda así en la base
-- **y** en el barrido, que es lo que R2 pide para el camino de escritura manual.
--
-- Sin SUPERUSER: sólo DDL de tablas propias del esquema de la aplicación.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Anclaje de la pertenencia
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "bank_reconciliations"
  ADD COLUMN "line_anchor" boolean NOT NULL DEFAULT true,
  ADD COLUMN "cash_anchor" boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN "bank_reconciliations"."line_anchor" IS
  'La fila que ancla ESTA línea de extracto en el grupo. Exactamente una por (grupo, línea): sobre ella vive el índice único parcial de I-E7-3.';
COMMENT ON COLUMN "bank_reconciliations"."cash_anchor" IS
  'La fila que ancla ESTE apunte de 57x en el grupo. Exactamente una por (grupo, apunte).';

-- Las filas existentes son todas de grupos SIMPLE (M3 no permitía otra cosa):
-- el DEFAULT `true` es su valor correcto y no hay backfill que hacer.

DROP INDEX IF EXISTS "bank_reconciliations_one_live_statement_line";
DROP INDEX IF EXISTS "bank_reconciliations_one_live_journal_line";

-- **I-E7-3 EN LA BASE, con grupos**: una línea de extracto está anclada en, a lo
-- sumo, UN grupo vivo. Igual para el apunte.
CREATE UNIQUE INDEX "bank_reconciliations_one_live_statement_line"
  ON "bank_reconciliations" ("organization_id", "statement_line_id")
  WHERE "group_unmatched_at" IS NULL AND "line_anchor";
CREATE UNIQUE INDEX "bank_reconciliations_one_live_journal_line"
  ON "bank_reconciliations" ("organization_id", "journal_line_id")
  WHERE "group_unmatched_at" IS NULL AND "cash_anchor";

-- Y la pareja no se repite dentro del grupo (la estrella no duplica aristas).
CREATE UNIQUE INDEX "bank_reconciliations_pair_per_group"
  ON "bank_reconciliations" ("organization_id", "group_id", "statement_line_id", "journal_line_id");

GRANT UPDATE ("group_unmatched_at") ON "bank_reconciliations" TO app_runtime;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. La igualdad de importes: por PAREJA en `SIMPLE`, por GRUPO en el resto
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app.bank_reconciliations_guard()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_group  RECORD;
  v_line   RECORD;
  v_jl     RECORD;
  v_acct   varchar(12);
BEGIN
  SELECT g."unmatched_at", g."bank_account_id", g."kind" INTO v_group
    FROM "bank_match_groups" g
   WHERE g."organization_id" = NEW."organization_id" AND g."id" = NEW."group_id";
  IF v_group."unmatched_at" IS NOT NULL THEN
    RAISE EXCEPTION 'bank_reconciliations: no se añaden miembros a un grupo ya desconciliado'
      USING ERRCODE = '23514';
  END IF;
  -- El espejo lo escribe la base, no quien inserta.
  NEW."group_unmatched_at" := NULL;

  SELECT l."amount_cents", l."bank_account_id", l."status", l."operation_date"
    INTO v_line
    FROM "bank_statement_lines" l
   WHERE l."organization_id" = NEW."organization_id" AND l."id" = NEW."statement_line_id";
  IF v_line."bank_account_id" IS DISTINCT FROM v_group."bank_account_id" THEN
    RAISE EXCEPTION 'bank_reconciliations: la línea de extracto es de otra cuenta bancaria que el grupo'
      USING ERRCODE = '23514';
  END IF;
  IF v_line."status" = 'IGNORED' THEN
    RAISE EXCEPTION 'bank_reconciliations: una línea IGNORED no se concilia; levanta antes el ignorado'
      USING ERRCODE = '23514';
  END IF;

  SELECT j."account_code", j."debit_cents", j."credit_cents", j."entry_date"
    INTO v_jl
    FROM "journal_lines" j
   WHERE j."organization_id" = NEW."organization_id" AND j."id" = NEW."journal_line_id";

  SELECT b."account_code" INTO v_acct
    FROM "bank_accounts" b
   WHERE b."organization_id" = NEW."organization_id" AND b."id" = v_group."bank_account_id";
  IF v_jl."account_code" IS DISTINCT FROM v_acct THEN
    RAISE EXCEPTION 'bank_reconciliations: el apunte es de la cuenta % y la cuenta bancaria puntea contra la % (§2.4)',
      v_jl."account_code", v_acct USING ERRCODE = '23514';
  END IF;
  -- **D6.4 · I-E7-2 en el camino de escritura.** En un grupo `SIMPLE` la
  -- igualdad ES la de la pareja —es lo que impedía puntear 100,00 € contra
  -- 1 000,00 €—; en un grupo N-a-M la igualdad es la del GRUPO y la comprueba,
  -- al COMMIT, `app.bank_match_groups_balanced()`.
  IF v_group."kind" = 'SIMPLE'
     AND v_line."amount_cents" IS DISTINCT FROM (v_jl."debit_cents" - v_jl."credit_cents") THEN
    RAISE EXCEPTION 'bank_reconciliations: el apunte del banco (%) y el del libro (%) no son el mismo importe con signo (I-E7-2, tolerancia 0)',
      v_line."amount_cents", (v_jl."debit_cents" - v_jl."credit_cents") USING ERRCODE = '23514';
  END IF;
  -- O-10: el desfase se SELLA aquí y no se juzga.
  NEW."date_gap_days" := abs(v_line."operation_date" - v_jl."entry_date");
  RETURN NEW;
END
$fn$;

-- **I-E7-11 en la base, al COMMIT.** Σ (líneas distintas) = Σ (debe − haber de
-- los apuntes distintos), tolerancia 0, sobre grupos VIVOS. Diferido porque
-- durante el alta de la estrella el grupo está incompleto por construcción.
CREATE OR REPLACE FUNCTION app.bank_match_groups_balanced()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_alive   timestamp(3);
  v_lines   bigint;
  v_cash    bigint;
  v_kind    "match_group_kind";
BEGIN
  SELECT g."unmatched_at", g."kind" INTO v_alive, v_kind
    FROM "bank_match_groups" g
   WHERE g."organization_id" = NEW."organization_id" AND g."id" = NEW."group_id";
  IF v_alive IS NOT NULL THEN RETURN NULL; END IF;

  SELECT COALESCE(SUM(l."amount_cents"), 0) INTO v_lines
    FROM (SELECT DISTINCT r."statement_line_id"
            FROM "bank_reconciliations" r
           WHERE r."organization_id" = NEW."organization_id" AND r."group_id" = NEW."group_id") m
    JOIN "bank_statement_lines" l
      ON l."organization_id" = NEW."organization_id" AND l."id" = m."statement_line_id";

  SELECT COALESCE(SUM(j."debit_cents" - j."credit_cents"), 0) INTO v_cash
    FROM (SELECT DISTINCT r."journal_line_id"
            FROM "bank_reconciliations" r
           WHERE r."organization_id" = NEW."organization_id" AND r."group_id" = NEW."group_id") m
    JOIN "journal_lines" j
      ON j."organization_id" = NEW."organization_id" AND j."id" = m."journal_line_id";

  IF v_lines IS DISTINCT FROM v_cash THEN
    RAISE EXCEPTION 'bank_match_groups: el grupo % no cuadra: Σ extracto % ≠ Σ apuntes % (I-E7-11, tolerancia 0)',
      NEW."group_id", v_lines, v_cash USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER "bank_reconciliations_group_balanced"
  AFTER INSERT ON "bank_reconciliations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.bank_match_groups_balanced();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. El anclaje es inmutable, como el resto de la pertenencia
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app.bank_reconciliations_mirror_guard()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_group_unmatched timestamp(3);
BEGIN
  IF NEW."id"                 IS DISTINCT FROM OLD."id"
     OR NEW."organization_id"   IS DISTINCT FROM OLD."organization_id"
     OR NEW."group_id"          IS DISTINCT FROM OLD."group_id"
     OR NEW."statement_line_id" IS DISTINCT FROM OLD."statement_line_id"
     OR NEW."journal_line_id"   IS DISTINCT FROM OLD."journal_line_id"
     OR NEW."method"            IS DISTINCT FROM OLD."method"
     OR NEW."score_bps"         IS DISTINCT FROM OLD."score_bps"
     OR NEW."date_gap_days"     IS DISTINCT FROM OLD."date_gap_days"
     OR NEW."line_anchor"       IS DISTINCT FROM OLD."line_anchor"
     OR NEW."cash_anchor"       IS DISTINCT FROM OLD."cash_anchor"
     OR NEW."matched_by_id"     IS DISTINCT FROM OLD."matched_by_id"
     OR NEW."matched_at"        IS DISTINCT FROM OLD."matched_at" THEN
    RAISE EXCEPTION 'bank_reconciliations: la pertenencia es inmutable; se desconcilia el GRUPO (ADR-0015 D6.1)'
      USING ERRCODE = '23514';
  END IF;
  SELECT g."unmatched_at" INTO v_group_unmatched
    FROM "bank_match_groups" g
   WHERE g."organization_id" = NEW."organization_id" AND g."id" = NEW."group_id";
  IF NEW."group_unmatched_at" IS DISTINCT FROM v_group_unmatched THEN
    RAISE EXCEPTION 'bank_reconciliations: group_unmatched_at es el ESPEJO del grupo y lo escribe la base'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;
