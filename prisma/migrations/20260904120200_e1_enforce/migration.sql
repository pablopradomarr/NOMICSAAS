-- E1 · Paso 3 — refuerzo: NOT NULL, FK a organizations, uniques e índices
-- compuestos con organization_id en primera posición y FK compuestas de
-- transactions por organización.
--
-- DESVIACIÓN DELIBERADA respecto al diseño (§2.5 paso 3): NO se eliminan aquí
-- ni los uniques antiguos (user_id, code) ni las columnas user_id de las tablas
-- heredadas, ni las columnas business_*/stripe_* de users. Esas operaciones son
-- destructivas y sólo pueden aplicarse cuando el código de aplicación ya lea
-- organization_id (T9–T11). Quedan pendientes para la migración
-- NNNN_e1_drop_user_scope de T11. Las columnas user_id conservan su semántica
-- de "creado por" mientras tanto.

-- NOT NULL en las 8 tablas con organization_id obligatorio (currencies no)
ALTER TABLE "settings"     ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "categories"   ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "projects"     ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "fields"       ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "files"        ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "transactions" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "app_data"     ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "progress"     ALTER COLUMN "organization_id" SET NOT NULL;

-- settings.updated_at pasa a gestionarse por Prisma (@updatedAt)
ALTER TABLE "settings" ALTER COLUMN "updated_at" DROP DEFAULT;

-- Uniques compuestos (organization_id, …) — deben existir ANTES de las FK compuestas
CREATE UNIQUE INDEX "settings_organization_id_code_key"        ON "settings"("organization_id", "code");
CREATE UNIQUE INDEX "categories_organization_id_code_key"      ON "categories"("organization_id", "code");
CREATE UNIQUE INDEX "projects_organization_id_code_key"        ON "projects"("organization_id", "code");
CREATE UNIQUE INDEX "fields_organization_id_code_key"          ON "fields"("organization_id", "code");
CREATE UNIQUE INDEX "currencies_organization_id_code_key"      ON "currencies"("organization_id", "code");
CREATE UNIQUE INDEX "app_data_organization_id_user_id_app_key" ON "app_data"("organization_id", "user_id", "app");

-- Índices compuestos
CREATE INDEX "files_organization_id_created_at_idx"        ON "files"("organization_id", "created_at");
CREATE INDEX "files_organization_id_is_reviewed_idx"       ON "files"("organization_id", "is_reviewed");
CREATE INDEX "progress_organization_id_user_id_idx"        ON "progress"("organization_id", "user_id");
CREATE INDEX "transactions_organization_id_issued_at_idx"     ON "transactions"("organization_id", "issued_at");
CREATE INDEX "transactions_organization_id_category_code_idx" ON "transactions"("organization_id", "category_code");
CREATE INDEX "transactions_organization_id_project_code_idx"  ON "transactions"("organization_id", "project_code");
CREATE INDEX "transactions_organization_id_merchant_idx"      ON "transactions"("organization_id", "merchant");
CREATE INDEX "transactions_organization_id_total_idx"         ON "transactions"("organization_id", "total");
CREATE INDEX "transactions_organization_id_name_idx"          ON "transactions"("organization_id", "name");

-- Índices de una sola columna que quedan cubiertos por el prefijo organization_id
DROP INDEX "transactions_category_code_idx";
DROP INDEX "transactions_project_code_idx";
DROP INDEX "transactions_issued_at_idx";
DROP INDEX "transactions_merchant_idx";
DROP INDEX "transactions_name_idx";
DROP INDEX "transactions_total_idx";

-- FK a organizations
ALTER TABLE "settings"     ADD CONSTRAINT "settings_organization_id_fkey"     FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "categories"   ADD CONSTRAINT "categories_organization_id_fkey"   FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "projects"     ADD CONSTRAINT "projects_organization_id_fkey"     FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "fields"       ADD CONSTRAINT "fields_organization_id_fkey"       FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "files"        ADD CONSTRAINT "files_organization_id_fkey"        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "currencies"   ADD CONSTRAINT "currencies_organization_id_fkey"   FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "app_data"     ADD CONSTRAINT "app_data_organization_id_fkey"     FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "progress"     ADD CONSTRAINT "progress_organization_id_fkey"     FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- FK compuestas de transactions: de (code, user_id) a (code, organization_id).
-- Convierte I10 en garantía del motor de BD para categoría y proyecto.
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_category_code_user_id_fkey";
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_project_code_user_id_fkey";
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_code_organization_id_fkey" FOREIGN KEY ("category_code", "organization_id") REFERENCES "categories"("code", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_project_code_organization_id_fkey"  FOREIGN KEY ("project_code", "organization_id")  REFERENCES "projects"("code", "organization_id")  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Unique parcial: un solo código por moneda del catálogo global
CREATE UNIQUE INDEX "currencies_global_code_uniq" ON "currencies" ("code") WHERE "organization_id" IS NULL;
