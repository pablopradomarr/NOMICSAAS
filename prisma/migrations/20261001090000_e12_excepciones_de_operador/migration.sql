-- E12 · T12 — Excepciones de operador (ADR-0020 D5/D6)
-- docs/design/E12-fiabilidad-dod.md §5.4 · docs/adr/0020-escrituras-de-operador-y-excepciones-auditadas.md
--
-- ADITIVA: crea dos enums, una tabla y una función. NO mueve una sola fila de
-- las existentes, así que no hace falta el baile `NO FORCE → backfill → FORCE`.
--
-- **Ejecutable por un rol NO superusuario** (CLAUDE.md): sólo `CREATE TYPE`,
-- `CREATE TABLE`, `CREATE INDEX`, `CREATE POLICY`, `GRANT`/`REVOKE` y una
-- `CREATE FUNCTION … SECURITY DEFINER` cuyo propietario es el que ejecuta la
-- migración. Ni `ALTER ROLE`, ni `ALTER FUNCTION … OWNER TO`, ni extensiones.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Enums (ADR-0020 · Modelo)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "operator_exception_kind" AS ENUM (
  'UNBLOCK_PERIOD_LOCK',
  'UNBLOCK_CLOSING_GUARD',
  'UNSTICK_RESTORE_JOB',
  'UNSTICK_CRON_JOB'
);

CREATE TYPE "operator_target_kind" AS ENUM (
  'PERIOD_LOCK',
  'FISCAL_YEAR',
  'RESTORE_JOB',
  'CRON_JOB'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. La tabla
--
-- `organization_id` con `ON DELETE RESTRICT` **a propósito** (ADR-0020): la
-- excepción es el registro de que alguien de la plataforma tocó algo de esa
-- organización, y ese registro no puede desaparecer por arrastre.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "operator_exceptions" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "kind"            "operator_exception_kind" NOT NULL,
  "target_kind"     "operator_target_kind"    NOT NULL,
  "target_id"       UUID,
  "target_ref"      VARCHAR(120),
  "reason"          VARCHAR(1000) NOT NULL,
  "requested_by"    VARCHAR(120)  NOT NULL,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at"      TIMESTAMP(3) NOT NULL,
  "revoked_at"      TIMESTAMP(3),

  CONSTRAINT "operator_exceptions_pkey" PRIMARY KEY ("id"),

  -- **D5, en la base y no en la aplicación.** Una excepción que dure más de
  -- 24 h no es una excepción: es un estado, y los estados no caducan solos.
  CONSTRAINT "operator_exceptions_expires_after_created"
    CHECK ("expires_at" > "created_at"),
  CONSTRAINT "operator_exceptions_expires_within_24h"
    CHECK ("expires_at" <= "created_at" + INTERVAL '24 hours'),

  -- **D3**: motivo de verdad. El filtro de genéricos vive en la aplicación
  -- (lista negra), pero la longitud mínima es estructural.
  CONSTRAINT "operator_exceptions_reason_min_length"
    CHECK (length(btrim("reason")) >= 20),

  -- La revocación nunca precede a la creación.
  CONSTRAINT "operator_exceptions_revoked_after_created"
    CHECK ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
);

ALTER TABLE "operator_exceptions"
  ADD CONSTRAINT "operator_exceptions_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "operator_exceptions_organization_id_expires_at_idx"
  ON "operator_exceptions" ("organization_id", "expires_at");

COMMENT ON TABLE "operator_exceptions" IS
  'E12 · ADR-0020 — excepción de operador a una GUARDIA, acotada y caduca (<= 24 h). NO es una excepción a un invariante: el invariante sigue en FAIL y sigue moviendo el sello (I-E12-5, EXCEPCION_DE_OPERADOR_VIGENTE).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. RLS estricta (ADR-0009) y append-only (ADR-0020 · Modelo)
--
-- `app_runtime` puede LEER e INSERTAR. No puede actualizar ni borrar: revocar
-- una excepción es escribir `revoked_at` por la función acotada de §4, no un
-- `UPDATE` libre que también podría mover `expires_at`.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT app.enforce_tenant_rls('operator_exceptions');

GRANT SELECT, INSERT ON "operator_exceptions" TO app_runtime;
REVOKE UPDATE, DELETE ON "operator_exceptions" FROM app_runtime;

CREATE POLICY "operator_exceptions_no_update" ON "operator_exceptions"
  AS RESTRICTIVE FOR UPDATE USING (false);
CREATE POLICY "operator_exceptions_no_delete" ON "operator_exceptions"
  AS RESTRICTIVE FOR DELETE USING (false);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Revocar: una función acotada, no un UPDATE
--
-- `SECURITY DEFINER` con `search_path` fijo (endurecimiento de
-- `20260929090000_supabase_api_hardening`). Sólo escribe `revoked_at`, sólo si
-- estaba a NULL, y sólo dentro de la organización de la sesión: ni siquiera
-- puede alargar una excepción, que es la única cosa que esta función NO debe
-- poder hacer nunca.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.revoke_operator_exception(p_id uuid, p_at timestamp(3))
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_org uuid := app.current_org();
  v_rows int;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'app.revoke_operator_exception: no hay organización en la sesión';
  END IF;

  UPDATE "operator_exceptions"
     SET "revoked_at" = p_at
   WHERE "id" = p_id
     AND "organization_id" = v_org
     AND "revoked_at" IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END
$fn$;

REVOKE ALL ON FUNCTION app.revoke_operator_exception(uuid, timestamp(3)) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.revoke_operator_exception(uuid, timestamp(3)) TO app_runtime;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Verificación (el patrón de E11: la migración comprueba lo que promete)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT (SELECT relrowsecurity AND relforcerowsecurity
            FROM pg_class WHERE relname = 'operator_exceptions') THEN
    RAISE EXCEPTION 'operator_exceptions no ha quedado en ENABLE + FORCE ROW LEVEL SECURITY';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE tablename = 'operator_exceptions') <> 3 THEN
    RAISE EXCEPTION 'operator_exceptions no tiene las tres políticas esperadas (tenant_isolation + no_update + no_delete)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.table_privileges
     WHERE table_name = 'operator_exceptions'
       AND grantee = 'app_runtime'
       AND privilege_type IN ('UPDATE', 'DELETE')
  ) THEN
    RAISE EXCEPTION 'app_runtime conserva UPDATE/DELETE sobre operator_exceptions';
  END IF;
END $$;
