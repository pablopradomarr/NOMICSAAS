-- E10 · T4 — M6: deuda heredada §0-bis #3 y #4, y el proyecto contenedor de Q-5
-- (docs/design/E10-presupuesto-horas.md §2.3 y §0-bis, ADR-0018 D2).
--
-- Dos valores de enum que nunca tuvieron una fila y que, precisamente por eso,
-- eran una puerta que alguien acabaría abriendo:
--   · `target_kind.MIXED`        — contrato desaconsejado desde E5 (§2.4 del
--     experto): con `source_share_bps` toda mezcla se expresa como N reglas de un
--     solo `target_kind` y un solo driver.
--   · `allocation_run_status.DRAFT` — E5 nunca lo persistió: la simulación es un
--     dry-run en memoria (`previewAllocation`, ADR-0013 D5).
--
-- PostgreSQL no permite eliminar un valor de un enum, así que se RECREA el tipo.
-- El `DO $$` de guardia aborta si alguien los usa: la migración **nunca pierde un
-- dato**. Ejecutable por un rol NO superusuario: `CREATE TYPE`, `ALTER TABLE` y
-- `DROP TYPE` sobre objetos propios no exigen SUPERUSER.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Guardia — si hay una sola fila, no se retira nada
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "allocation_rules" WHERE "target_kind" = 'MIXED';
  IF n > 0 THEN
    RAISE EXCEPTION 'hay % reglas con target_kind = MIXED: no se retira el valor', n;
  END IF;

  SELECT count(*) INTO n FROM "allocation_runs" WHERE "status" = 'DRAFT';
  IF n > 0 THEN
    RAISE EXCEPTION 'hay % runs en DRAFT: no se retira el valor', n;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. `target_kind` sin `MIXED`
--
--    El CHECK de M4 lleva el literal tipado `'COST_CENTERS'::target_kind`, que
--    mantendría vivo el tipo viejo: se retira antes y se vuelve a poner después.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "allocation_rules" DROP CONSTRAINT "allocation_rules_headcount_targets";

CREATE TYPE "target_kind_v2" AS ENUM ('PROJECTS', 'BUSINESS_LINES', 'COST_CENTERS');
ALTER TABLE "allocation_rules" ALTER COLUMN "target_kind"
  TYPE "target_kind_v2" USING ("target_kind"::text::"target_kind_v2");
DROP TYPE "target_kind";
ALTER TYPE "target_kind_v2" RENAME TO "target_kind";

ALTER TABLE "allocation_rules" ADD CONSTRAINT "allocation_rules_headcount_targets"
  CHECK ("driver" <> 'HEADCOUNT' OR "target_kind" = 'COST_CENTERS');

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. `allocation_run_status` sin `DRAFT`
--
--    Cuelgan del tipo el DEFAULT `'SEALED'`, un CHECK y DOS índices parciales
--    (`allocation_runs_one_sealed_per_period` de E5 y
--    `allocation_runs_sin_lines_hash` de E7). Se sueltan, se cambia el tipo y se
--    rehacen IDÉNTICOS: ni la unicidad del run vigente ni el enumerado barato de
--    I-E7-9 pueden quedarse por el camino.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "allocation_runs" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "allocation_runs" DROP CONSTRAINT "allocation_runs_status_marks";
DROP INDEX "allocation_runs_one_sealed_per_period";
DROP INDEX "allocation_runs_sin_lines_hash";

CREATE TYPE "allocation_run_status_v2" AS ENUM ('SEALED', 'SUPERSEDED', 'REVERSED');
ALTER TABLE "allocation_runs" ALTER COLUMN "status"
  TYPE "allocation_run_status_v2" USING ("status"::text::"allocation_run_status_v2");
DROP TYPE "allocation_run_status";
ALTER TYPE "allocation_run_status_v2" RENAME TO "allocation_run_status";

ALTER TABLE "allocation_runs" ALTER COLUMN "status" SET DEFAULT 'SEALED';

ALTER TABLE "allocation_runs" ADD CONSTRAINT "allocation_runs_status_marks" CHECK (
  (("status" = 'SUPERSEDED') = ("superseded_by_id" IS NOT NULL))
  AND (("status" = 'REVERSED') = ("reversed_at" IS NOT NULL)));

CREATE UNIQUE INDEX "allocation_runs_one_sealed_per_period" ON "allocation_runs"
  ("organization_id", "period_start", "period_end") WHERE "status" = 'SEALED';
CREATE INDEX "allocation_runs_sin_lines_hash" ON "allocation_runs"
  ("organization_id", "period_start") WHERE "lines_hash" IS NULL AND "status" = 'SEALED';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Q-5 — el proyecto contenedor `P-<LN>-NUEVOS`
--
--    No se presupuesta sobre una línea de negocio sin proyecto: la LN es un
--    agregado de PRESENTACIÓN y viaja denormalizada desde el proyecto (R-A9). El
--    caso real —presupuestar en noviembre negocio aún no contratado— se resuelve
--    con un proyecto contenedor en `PLANNED`, que admite presupuesto y queda
--    FUERA del reparto de estructura (el `targetFilter` por defecto de E5 es
--    `projectStatus: [ACTIVE]`). Su reasignación posterior a los proyectos reales
--    es una `REVISADO n` fechada cuyo diff enseña qué se movió de pipeline a
--    cartera (criterio 32).
--
--    Único backfill de la épica, y por eso el único baile `NO FORCE` → backfill →
--    `FORCE`: con `FORCE ROW LEVEL SECURITY` el propietario TAMPOCO esquiva las
--    políticas y el `INSERT … SELECT` vería 0 filas (ADR-0009, §Convenciones de
--    CLAUDE.md). El DDL es transaccional, así que la ventana no se queda abierta
--    ni siquiera si algo falla en medio.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "projects"       NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "business_lines" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "projects"
  ("id", "organization_id", "business_line_id", "code", "name", "status", "sort_order", "updated_at")
SELECT gen_random_uuid(), bl."organization_id", bl."id",
       'P-' || bl."code" || '-NUEVOS',
       'Nuevos negocios — ' || bl."name",
       'PLANNED', 9000, CURRENT_TIMESTAMP
  FROM "business_lines" bl
 WHERE bl."is_active" AND bl."archived_at" IS NULL
ON CONFLICT ("organization_id", "code") DO NOTHING;

ALTER TABLE "projects"       FORCE ROW LEVEL SECURITY;
ALTER TABLE "business_lines" FORCE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Verificación: ninguna tabla queda en NO FORCE (ADR-0009 §7)
--
--    El check recorre TODAS las tablas de negocio con `organization_id`, no sólo
--    las dos que aquí se abrieron: si una migración anterior dejó una abierta,
--    aquí se ve.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organization_id' AND a.attnum > 0
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
  LOOP
    IF NOT (SELECT relforcerowsecurity FROM pg_class WHERE relname = t) THEN
      RAISE EXCEPTION '% ha quedado en NO FORCE ROW LEVEL SECURITY', t;
    END IF;
  END LOOP;
END $$;
