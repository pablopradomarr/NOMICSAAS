-- E1 · Paso 2 — backfill idempotente (SQL puro, sin Prisma Client).
-- Una organización personal por usuario (id determinista = users.id), membresía
-- ADMIN, propagación de organization_id a las 9 tablas y copia de los datos de
-- emisor y de facturación (D-1) a la organización.

-- 2.1 Una organización personal por usuario
INSERT INTO "organizations" (
  "id", "slug", "name", "is_personal", "base_currency", "timezone", "pgc_variant",
  "business_name", "business_address", "business_bank_details", "business_logo",
  "stripe_customer_id", "membership_plan", "membership_expires_at",
  "storage_used", "storage_limit", "ai_balance", "created_at", "updated_at")
SELECT
  u."id",
  regexp_replace(lower(split_part(u."email", '@', 1)), '[^a-z0-9]+', '-', 'g')
    || '-' || substr(replace(u."id"::text, '-', ''), 1, 6),
  COALESCE(NULLIF(u."business_name", ''), NULLIF(u."name", ''), split_part(u."email", '@', 1)),
  true, 'EUR', 'Europe/Madrid', 'PYMES',
  u."business_name", u."business_address", u."business_bank_details", u."business_logo",
  u."stripe_customer_id", u."membership_plan", u."membership_expires_at",
  u."storage_used", u."storage_limit", u."ai_balance", u."created_at", now()
FROM "users" u
ON CONFLICT ("id") DO NOTHING;

-- 2.2 Membresía ADMIN aceptada
INSERT INTO "memberships" ("id", "organization_id", "user_id", "role", "accepted_at", "created_at", "updated_at")
SELECT gen_random_uuid(), u."id", u."id", 'ADMIN', now(), now(), now()
FROM "users" u
ON CONFLICT ("organization_id", "user_id") DO NOTHING;

-- 2.3 Propagación a las 8 tablas con user_id NOT NULL
UPDATE "settings"     SET "organization_id" = "user_id" WHERE "organization_id" IS NULL;
UPDATE "categories"   SET "organization_id" = "user_id" WHERE "organization_id" IS NULL;
UPDATE "projects"     SET "organization_id" = "user_id" WHERE "organization_id" IS NULL;
UPDATE "fields"       SET "organization_id" = "user_id" WHERE "organization_id" IS NULL;
UPDATE "files"        SET "organization_id" = "user_id" WHERE "organization_id" IS NULL;
UPDATE "transactions" SET "organization_id" = "user_id" WHERE "organization_id" IS NULL;
UPDATE "app_data"     SET "organization_id" = "user_id" WHERE "organization_id" IS NULL;
UPDATE "progress"     SET "organization_id" = "user_id" WHERE "organization_id" IS NULL;

-- 2.4 Currencies: user_id NULL ⇒ catálogo global, se queda con organization_id NULL
UPDATE "currencies" SET "organization_id" = "user_id"
WHERE "organization_id" IS NULL AND "user_id" IS NOT NULL;

-- 2.5 Verificación previa al paso 3 (aborta si queda huérfano)
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM (
    SELECT 1 FROM "settings"     WHERE "organization_id" IS NULL
    UNION ALL SELECT 1 FROM "categories"   WHERE "organization_id" IS NULL
    UNION ALL SELECT 1 FROM "projects"     WHERE "organization_id" IS NULL
    UNION ALL SELECT 1 FROM "fields"       WHERE "organization_id" IS NULL
    UNION ALL SELECT 1 FROM "files"        WHERE "organization_id" IS NULL
    UNION ALL SELECT 1 FROM "transactions" WHERE "organization_id" IS NULL
    UNION ALL SELECT 1 FROM "app_data"     WHERE "organization_id" IS NULL
    UNION ALL SELECT 1 FROM "progress"     WHERE "organization_id" IS NULL
  ) x;
  IF n > 0 THEN RAISE EXCEPTION 'backfill incompleto: % filas sin organization_id', n; END IF;
END $$;
