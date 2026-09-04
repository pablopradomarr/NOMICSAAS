-- E1 · T11 — retirada del eje de aislamiento por usuario.
--
-- 1) Traslado REAL (no copia) de facturación, cuotas y datos de emisor de
--    `users` a `organizations`: el backfill (0012) ya los copió a la
--    organización personal; aquí se sincroniza lo que hubiera cambiado desde
--    entonces y se ELIMINAN las columnas de `users`, que queda sólo con
--    auth/perfil.
-- 2) Se eliminan los uniques heredados (user_id, code), ya sustituidos por
--    (organization_id, code) en 0013_e1_enforce.
-- 3) `user_id` desaparece de settings/categories/projects/fields/currencies
--    (la entidad es de la organización) y se renombra a uploaded_by_id /
--    created_by_id en files/transactions, donde su semántica es autoría
--    (provenance, SPEC-FIABILIDAD C3). app_data y progress lo conservan:
--    son estado por usuario DENTRO de la organización.
--
-- IRREVERSIBLE: requiere pg_dump previo en producción (riesgo R1 del diseño).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Sincronización final users → organizations (idempotente)
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE organizations o
SET
  business_name          = COALESCE(o.business_name, u.business_name),
  business_address       = COALESCE(o.business_address, u.business_address),
  business_bank_details  = COALESCE(o.business_bank_details, u.business_bank_details),
  business_logo          = COALESCE(o.business_logo, u.business_logo),
  stripe_customer_id     = COALESCE(o.stripe_customer_id, u.stripe_customer_id),
  membership_plan        = COALESCE(o.membership_plan, u.membership_plan),
  membership_expires_at  = COALESCE(o.membership_expires_at, u.membership_expires_at),
  storage_used           = GREATEST(o.storage_used, u.storage_used),
  storage_limit          = CASE WHEN o.storage_limit = -1 THEN u.storage_limit ELSE o.storage_limit END,
  ai_balance            = GREATEST(o.ai_balance, u.ai_balance),
  updated_at             = now()
FROM users u
WHERE o.id = u.id AND o.is_personal = true;

-- Verificación: ninguna organización personal puede quedarse sin el plan del usuario
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n
  FROM users u
  JOIN organizations o ON o.id = u.id AND o.is_personal = true
  WHERE u.membership_plan IS NOT NULL AND o.membership_plan IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'traslado incompleto: % organizaciones personales sin membership_plan', n;
  END IF;
END $$;

ALTER TABLE "users"
  DROP COLUMN "business_name",
  DROP COLUMN "business_address",
  DROP COLUMN "business_bank_details",
  DROP COLUMN "business_logo",
  DROP COLUMN "stripe_customer_id",
  DROP COLUMN "membership_plan",
  DROP COLUMN "membership_expires_at",
  DROP COLUMN "storage_used",
  DROP COLUMN "storage_limit",
  DROP COLUMN "ai_balance";

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Uniques heredados (user_id, code) — sustituidos por (organization_id, code)
-- ─────────────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS "settings_user_id_code_key";
DROP INDEX IF EXISTS "categories_user_id_code_key";
DROP INDEX IF EXISTS "projects_user_id_code_key";
DROP INDEX IF EXISTS "fields_user_id_code_key";
DROP INDEX IF EXISTS "currencies_user_id_code_key";
DROP INDEX IF EXISTS "app_data_user_id_app_key";

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. user_id: se elimina donde la entidad es de la organización
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "settings"   DROP CONSTRAINT IF EXISTS "settings_user_id_fkey";
ALTER TABLE "categories" DROP CONSTRAINT IF EXISTS "categories_user_id_fkey";
ALTER TABLE "projects"   DROP CONSTRAINT IF EXISTS "projects_user_id_fkey";
ALTER TABLE "fields"     DROP CONSTRAINT IF EXISTS "fields_user_id_fkey";
ALTER TABLE "currencies" DROP CONSTRAINT IF EXISTS "currencies_user_id_fkey";

ALTER TABLE "settings"   DROP COLUMN "user_id";
ALTER TABLE "categories" DROP COLUMN "user_id";
ALTER TABLE "projects"   DROP COLUMN "user_id";
ALTER TABLE "fields"     DROP COLUMN "user_id";
ALTER TABLE "currencies" DROP COLUMN "user_id";

-- … y se renombra a autoría donde la trazabilidad la necesita (files, transactions)
ALTER TABLE "files"        DROP CONSTRAINT IF EXISTS "files_user_id_fkey";
ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_user_id_fkey";

DROP INDEX IF EXISTS "transactions_user_id_idx";
DROP INDEX IF EXISTS "progress_user_id_idx";

ALTER TABLE "files"        RENAME COLUMN "user_id" TO "uploaded_by_id";
ALTER TABLE "transactions" RENAME COLUMN "user_id" TO "created_by_id";
ALTER TABLE "files"        ALTER COLUMN "uploaded_by_id" DROP NOT NULL;
ALTER TABLE "transactions" ALTER COLUMN "created_by_id" DROP NOT NULL;

CREATE INDEX "files_organization_id_uploaded_by_id_idx"      ON "files"("organization_id", "uploaded_by_id");
CREATE INDEX "transactions_organization_id_created_by_id_idx" ON "transactions"("organization_id", "created_by_id");
