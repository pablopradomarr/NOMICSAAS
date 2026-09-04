-- E1 · Paso 1 — aditiva y reversible: enums, tablas nuevas y organization_id NULLABLE.
-- No toca ningún unique ni FK existente: el código heredado (filtro por user_id)
-- sigue funcionando sin cambios.

-- CreateEnum
CREATE TYPE "role" AS ENUM ('ADMIN', 'EDITOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "pgc_variant" AS ENUM ('GENERAL', 'PYMES');

-- CreateEnum
CREATE TYPE "invitation_status" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tax_id" TEXT,
    "base_currency" TEXT NOT NULL DEFAULT 'EUR',
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Madrid',
    "pgc_variant" "pgc_variant" NOT NULL DEFAULT 'PYMES',
    "ledger_enabled" BOOLEAN NOT NULL DEFAULT true,
    "analytics_required" BOOLEAN NOT NULL DEFAULT true,
    "review_thresholds" JSONB,
    "is_personal" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "business_name" TEXT,
    "business_address" TEXT,
    "business_bank_details" TEXT,
    "business_logo" TEXT,
    "stripe_customer_id" TEXT,
    "membership_plan" TEXT,
    "membership_expires_at" TIMESTAMP(3),
    "storage_used" INTEGER NOT NULL DEFAULT 0,
    "storage_limit" INTEGER NOT NULL DEFAULT -1,
    "ai_balance" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "role" NOT NULL,
    "invited_by_id" UUID,
    "accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "role" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" "invitation_status" NOT NULL DEFAULT 'PENDING',
    "invited_by_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "accepted_by_id" UUID,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");
CREATE INDEX "organizations_stripe_customer_id_idx" ON "organizations"("stripe_customer_id");
CREATE INDEX "memberships_user_id_idx" ON "memberships"("user_id");
CREATE INDEX "memberships_organization_id_role_idx" ON "memberships"("organization_id", "role");
CREATE UNIQUE INDEX "memberships_organization_id_user_id_key" ON "memberships"("organization_id", "user_id");
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");
CREATE INDEX "invitations_organization_id_status_idx" ON "invitations"("organization_id", "status");
CREATE INDEX "invitations_email_idx" ON "invitations"("email");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Índice parcial: una sola invitación PENDING viva por (organización, email)
CREATE UNIQUE INDEX "invitations_org_email_pending_uniq"
  ON "invitations" ("organization_id", lower("email"))
  WHERE "status" = 'PENDING';

-- AlterTable: organization_id NULLABLE en las 9 tablas de negocio
ALTER TABLE "settings"     ADD COLUMN "organization_id" UUID;
ALTER TABLE "categories"   ADD COLUMN "organization_id" UUID;
ALTER TABLE "projects"     ADD COLUMN "organization_id" UUID;
ALTER TABLE "fields"       ADD COLUMN "organization_id" UUID;
ALTER TABLE "files"        ADD COLUMN "organization_id" UUID;
ALTER TABLE "transactions" ADD COLUMN "organization_id" UUID;
ALTER TABLE "currencies"   ADD COLUMN "organization_id" UUID;
ALTER TABLE "app_data"     ADD COLUMN "organization_id" UUID;
ALTER TABLE "progress"     ADD COLUMN "organization_id" UUID;

-- Settings versionados (gap MEDIA). El DEFAULT de updated_at se retira en el paso 3.
ALTER TABLE "settings"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
