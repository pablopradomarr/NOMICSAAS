-- E7 · T3 — M2: el barrido sellado (`invariant_runs`) y el del almacén
-- (`store_sweeps`). docs/design/E7-auditoria.md §2.2 y §2.3, ADR-0015 APROBADO.
--
-- Aditiva pura. Todo lo que aquí se ejecuta lo puede ejecutar un rol NO
-- superusuario (CLAUDE.md): ni un `ALTER ROLE`, ni un `OWNER TO`, ni una
-- extensión nueva. Los valores de enum que usa se añadieron en
-- `20260916090000_e7_enums`, que va aparte por exigencia de `ALTER TYPE`.
--
-- PATRÓN DE BACKFILL (ADR-0009 §7, CLAUDE.md): con `FORCE` el propietario
-- tampoco esquiva las políticas, así que TODO DML de datos va entre
-- `NO FORCE` → … → `FORCE`, y la marca —cuando la hay— se escribe ANTES del
-- backfill (lección de `20260907120000`).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. `invariant_runs` — la foto del cuadre, sellada y comparable
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "invariant_runs" (
  "id"                 uuid               NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"    uuid               NOT NULL,
  "scope_kind"         "audit_scope_kind" NOT NULL,
  "fiscal_year_id"     uuid,
  "period_start"       date,
  "period_end"         date,
  "trigger"            "audit_trigger"    NOT NULL,
  -- La fecha de referencia que decidió I8. Sin ella el run no es reproducible.
  "ref_date"           date               NOT NULL,
  -- Los cinco sellos del estado sobre el que se calculó.
  "ledger_hash"        char(64)           NOT NULL,
  "analytics_key"      varchar(210)       NOT NULL DEFAULT '∅',
  "plan_hash"          char(64)           NOT NULL,
  "account_map_hash"   char(64)           NOT NULL,
  -- O-20 (ADR-0015 D6.5): la configuración que puede mover un check sin mover
  -- un dato. Sin él, bajar un umbral servía el barrido cacheado —justo cuando
  -- hay que rebarrer— y `diffRuns` concluía `cause: "NINGUNA"` con deltas.
  "config_hash"        char(64)           NOT NULL,
  "git_sha"            varchar(64)        NOT NULL,
  -- I-E7-7: sha256 de la forma canónica de `checks`, para demostrar que la fila
  -- no se ha tocado por SQL.
  "checks_hash"        char(64)           NOT NULL,
  "checks"             jsonb              NOT NULL,
  "counts"             jsonb              NOT NULL,
  "coverage"           jsonb              NOT NULL,
  -- O-19: las cuatro cifras de cierre derivadas de este estado.
  "headline"           jsonb              NOT NULL,
  "seal"               "seal"             NOT NULL,
  "seal_reasons"       jsonb              NOT NULL DEFAULT '[]',
  "store_sweep_id"     uuid,
  "duration_ms"        integer            NOT NULL,
  "run_by_id"          uuid,
  "created_at"         timestamp(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "invariant_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "invariant_runs_organization_id_id_key"
  ON "invariant_runs" ("organization_id", "id");
CREATE INDEX "invariant_runs_org_created_idx"
  ON "invariant_runs" ("organization_id", "created_at" DESC);
CREATE INDEX "invariant_runs_org_scope_created_idx"
  ON "invariant_runs" ("organization_id", "scope_kind", "fiscal_year_id", "created_at" DESC);
CREATE INDEX "invariant_runs_org_ledger_hash_idx"
  ON "invariant_runs" ("organization_id", "ledger_hash");

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. `store_sweeps` — el barrido del almacén (cierra la deuda de I-E8-2)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "store_sweeps" (
  "id"                uuid           NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"   uuid           NOT NULL,
  "status"            "sweep_status" NOT NULL DEFAULT 'RUNNING',
  "files_total"       integer        NOT NULL DEFAULT 0,
  "files_ok"          integer        NOT NULL DEFAULT 0,
  "files_missing"     integer        NOT NULL DEFAULT 0,
  "files_altered"     integer        NOT NULL DEFAULT 0,
  "bytes_read"        bigint         NOT NULL DEFAULT 0,
  -- SÓLO los hallazgos, con cota dura de 1000 + `findings_overflow`.
  "findings"          jsonb          NOT NULL DEFAULT '[]',
  "findings_overflow" integer        NOT NULL DEFAULT 0,
  "started_at"        timestamp(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at"       timestamp(3),
  "run_by_id"         uuid,
  CONSTRAINT "store_sweeps_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "store_sweeps_organization_id_id_key"
  ON "store_sweeps" ("organization_id", "id");
CREATE INDEX "store_sweeps_org_started_idx"
  ON "store_sweeps" ("organization_id", "started_at" DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. FK — compuestas POR TENANT donde el destino es de negocio
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "invariant_runs"
  ADD CONSTRAINT "invariant_runs_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "invariant_runs_fiscal_year_fkey"
    FOREIGN KEY ("organization_id", "fiscal_year_id")
    REFERENCES "fiscal_years"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "invariant_runs_store_sweep_fkey"
    FOREIGN KEY ("organization_id", "store_sweep_id")
    REFERENCES "store_sweeps"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "store_sweeps"
  ADD CONSTRAINT "store_sweeps_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. CHECK
--    4.a Coherencia del alcance: un run de PERIODO sin periodo, o uno de
--        ORGANIZACIÓN con ejercicio, sería una foto que no se sabe de qué.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "invariant_runs"
  ADD CONSTRAINT "invariant_runs_scope_coherent" CHECK (
    ("scope_kind" = 'ORGANIZATION' AND "fiscal_year_id" IS NULL
       AND "period_start" IS NULL AND "period_end" IS NULL) OR
    ("scope_kind" = 'FISCAL_YEAR'  AND "fiscal_year_id" IS NOT NULL
       AND "period_start" IS NULL AND "period_end" IS NULL) OR
    ("scope_kind" = 'PERIOD'       AND "period_start" IS NOT NULL AND "period_end" IS NOT NULL)
  ),
  ADD CONSTRAINT "invariant_runs_period_order"
    CHECK ("period_start" IS NULL OR "period_end" IS NULL OR "period_end" >= "period_start"),
  ADD CONSTRAINT "invariant_runs_duration" CHECK ("duration_ms" >= 0),
  -- Cota dura de 1 MB en `checks` (§2.3 M2): el barrido guarda el resultado de
  -- los checks, no el diario que recorrieron.
  ADD CONSTRAINT "invariant_runs_checks_size" CHECK (pg_column_size("checks") <= 1048576),
  ADD CONSTRAINT "invariant_runs_checks_array" CHECK (jsonb_typeof("checks") = 'array'),
  ADD CONSTRAINT "invariant_runs_seal_reasons_array" CHECK (jsonb_typeof("seal_reasons") = 'array');

-- 4.b `store_sweeps`: los contadores no son negativos y los hallazgos tienen
--     cota dura de 1000 entradas; lo que no cabe se cuenta en el desbordamiento.
ALTER TABLE "store_sweeps"
  ADD CONSTRAINT "store_sweeps_counters_nonneg" CHECK (
    "files_total" >= 0 AND "files_ok" >= 0 AND "files_missing" >= 0
    AND "files_altered" >= 0 AND "bytes_read" >= 0 AND "findings_overflow" >= 0
  ),
  ADD CONSTRAINT "store_sweeps_findings_array" CHECK (jsonb_typeof("findings") = 'array'),
  ADD CONSTRAINT "store_sweeps_findings_bound" CHECK (jsonb_array_length("findings") <= 1000),
  -- Un barrido terminado tiene fecha de fin, y uno en marcha no la tiene.
  ADD CONSTRAINT "store_sweeps_finished_coherent"
    CHECK (("status" = 'RUNNING') = ("finished_at" IS NULL));

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. RLS estricta (ADR-0009) sobre las dos tablas nuevas
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invariant_runs','store_sweeps'] LOOP
    PERFORM app.enforce_tenant_rls(t);
  END LOOP;
END $$;

-- 5.a `invariant_runs` APPEND-ONLY, con las dos cerraduras (patrón
--     `report_runs` / `audit_logs`): privilegio y política. Un barrido sellado
--     es un HECHO fechado; si se pudiera editar, `checksHash` no acreditaría
--     nada y I-E7-7 no tendría contra qué comparar.
GRANT SELECT, INSERT ON "invariant_runs" TO app_runtime;
REVOKE UPDATE, DELETE ON "invariant_runs" FROM app_runtime;
CREATE POLICY "invariant_runs_no_update" ON "invariant_runs" AS RESTRICTIVE FOR UPDATE USING (false);
CREATE POLICY "invariant_runs_no_delete" ON "invariant_runs" AS RESTRICTIVE FOR DELETE USING (false);

-- 5.b `store_sweeps` SEMI-append-only (patrón ADR-0010, `GRANT` de columna +
--     trigger). El barrido nace `RUNNING` y avanza: sin `UPDATE` no podría
--     escribir su progreso ni terminar. Lo que NO puede es reescribir su
--     identidad ni su arranque, ni volver a un estado terminal ya alcanzado.
REVOKE UPDATE, DELETE ON "store_sweeps" FROM app_runtime;
GRANT SELECT, INSERT ON "store_sweeps" TO app_runtime;
GRANT UPDATE ("status","files_total","files_ok","files_missing","files_altered",
              "bytes_read","findings","findings_overflow","finished_at")
  ON "store_sweeps" TO app_runtime;
CREATE POLICY "store_sweeps_no_delete" ON "store_sweeps" AS RESTRICTIVE FOR DELETE USING (false);

CREATE OR REPLACE FUNCTION app.store_sweeps_only_progress()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."id"              IS DISTINCT FROM OLD."id"
     OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
     OR NEW."started_at"      IS DISTINCT FROM OLD."started_at"
     OR NEW."run_by_id"       IS DISTINCT FROM OLD."run_by_id" THEN
    RAISE EXCEPTION 'store_sweeps: sólo se puede escribir el PROGRESO del barrido (E7, ADR-0010)'
      USING ERRCODE = '23514';
  END IF;
  -- Un barrido terminado no se reabre: se lanza otro.
  IF OLD."status" <> 'RUNNING' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'store_sweeps: el barrido % ya terminó en %; lanza otro', OLD."id", OLD."status"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER "store_sweeps_only_progress_update"
  BEFORE UPDATE ON "store_sweeps"
  FOR EACH ROW EXECUTE FUNCTION app.store_sweeps_only_progress();

GRANT SELECT, INSERT, UPDATE, DELETE ON "invariant_runs", "store_sweeps" TO app_maintenance;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. `manual_review_flags` gana el run y la familia (§2.7)
--    `check_family` es ENUM y no texto (O-21): con texto libre una errata acota
--    la revisión a nada y el periodo queda sellado como si se hubiera revisado.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "manual_review_flags"
  ADD COLUMN "invariant_run_id" uuid,
  ADD COLUMN "check_family"     "check_family";

ALTER TABLE "manual_review_flags"
  ADD CONSTRAINT "manual_review_flags_invariant_run_fkey"
    FOREIGN KEY ("organization_id", "invariant_run_id")
    REFERENCES "invariant_runs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "manual_review_flags_org_invariant_run_idx"
  ON "manual_review_flags" ("organization_id", "invariant_run_id");

-- Las dos columnas nuevas se escriben AL CREAR el flag y son inmutables: el
-- `GRANT UPDATE` acotado de E6 sigue siendo `(cleared_at, cleared_by_id,
-- clear_reason)` y no se amplía. El trigger `manual_review_flags_only_clear`
-- las protege sin tocarlo: cualquier columna fuera de esas tres que cambie ya
-- estaba prohibida por el privilegio.

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. ADR-0015 D4 — `CASHFLOW_DIRECTO` / `CASHFLOW_INDIRECTO` prohibidos para
--    filas NUEVAS. `NOT VALID`: las filas históricas siguen ahí y las migra
--    `scripts/migrate-cashflow-report-type.ts`, que al terminar ejecuta
--    `VALIDATE CONSTRAINT`. PostgreSQL no permite retirar un valor de un enum
--    sin recrear el tipo, así que la prohibición vive en un CHECK.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "report_runs"
  ADD CONSTRAINT "report_runs_no_cashflow_legacy"
    CHECK ("type" NOT IN ('CASHFLOW_DIRECTO', 'CASHFLOW_INDIRECTO')) NOT VALID;
ALTER TABLE "manual_review_flags"
  ADD CONSTRAINT "manual_review_flags_no_cashflow_legacy"
    CHECK ("scope" IS NULL OR "scope" NOT IN ('CASHFLOW_DIRECTO', 'CASHFLOW_INDIRECTO')) NOT VALID;

-- El trigger de E6 (`app.manual_review_flags_only_clear`) prohíbe tocar `scope`,
-- y con razón: el ámbito de una revisión forzada es parte del hecho de gobierno.
-- Pero la conversión de D4 tiene que reapuntar los flags históricos, y hacerlo
-- desactivando el trigger exigiría ser propietario de la tabla — que el rol del
-- script (`app_maintenance`) no es. Se abre UNA transición, la mínima: de un
-- ámbito viejo al unificado, sin que cambie NADA más de la fila. Cualquier otro
-- cambio de `scope` sigue prohibido, y `app_runtime` ni siquiera tiene el
-- privilegio de columna para intentarlo (el `GRANT UPDATE` de E6 es sólo sobre
-- las tres columnas de limpieza).
CREATE OR REPLACE FUNCTION app.manual_review_flags_only_clear()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_solo_unifica_cashflow boolean;
BEGIN
  v_solo_unifica_cashflow :=
    OLD."scope" IN ('CASHFLOW_DIRECTO', 'CASHFLOW_INDIRECTO') AND NEW."scope" = 'CASHFLOW';

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
     OR NEW."period_start"    IS DISTINCT FROM OLD."period_start"
     OR NEW."period_end"      IS DISTINCT FROM OLD."period_end"
     OR (NEW."scope"          IS DISTINCT FROM OLD."scope" AND NOT v_solo_unifica_cashflow)
     OR NEW."reason"          IS DISTINCT FROM OLD."reason"
     OR NEW."created_by_id"   IS DISTINCT FROM OLD."created_by_id"
     OR NEW."created_at"      IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'manual_review_flags: sólo se pueden modificar cleared_at, cleared_by_id y clear_reason (E6, ADR-0010)'
      USING ERRCODE = '23514';
  END IF;

  -- La conversión de D4 no limpia nada: sólo reapunta el ámbito.
  IF v_solo_unifica_cashflow THEN
    RETURN NEW;
  END IF;

  -- Y una vez limpiado, se queda limpiado: no se "reabre" un flag, se crea otro.
  IF OLD."cleared_at" IS NOT NULL THEN
    RAISE EXCEPTION 'manual_review_flags: el flag % ya está limpiado; crea uno nuevo', OLD."id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. I-E7-9 — índice parcial que enumera BARATO los runs de liquidación
--    sellados sin `lines_hash`. No se rellenan por script (§2.5): un
--    `linesHash` calculado hoy sobre líneas que quizá alguien tocó ayer no es
--    un sello. La pantalla los lista para re-liquidarlos (`supersede`).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX "allocation_runs_sin_lines_hash"
  ON "allocation_runs" ("organization_id", "period_start")
  WHERE "lines_hash" IS NULL AND "status" = 'SEALED';

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Siembra de las TRES `AccountKey` nuevas (m1) en toda organización cuyo
--    plan tenga la cuenta POSTABLE y ACTIVA. Una organización que no la tenga
--    NO falla la migración: queda como WARN de Auditoría, igual que 523 en E8.
--    Bajo el patrón obligatorio NO FORCE → DML → FORCE.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "organization_account_maps" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "organization_account_maps" ("id", "organization_id", "key", "account_code", "created_at", "updated_at")
SELECT gen_random_uuid(), a."organization_id", k."key"::"account_key", a."code",
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM (VALUES ('INTERESES_DEUDAS', '662'),
               ('OTROS_GASTOS_FINANCIEROS', '669'),
               ('INTERESES_DESCUENTO_EFECTOS', '665')) AS k("key", "code")
  JOIN "accounts" a ON a."code" = k."code" AND a."is_postable" AND a."is_active"
 WHERE NOT EXISTS (
   SELECT 1 FROM "organization_account_maps" m
    WHERE m."organization_id" = a."organization_id" AND m."key" = k."key"::"account_key"
 );

ALTER TABLE "organization_account_maps" FORCE ROW LEVEL SECURITY;
