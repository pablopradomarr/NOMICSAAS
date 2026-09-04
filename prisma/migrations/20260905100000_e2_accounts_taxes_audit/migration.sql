-- E2 · T1 — Plan de cuentas, mapa de cuentas de sistema, tipos impositivos y
-- registro de auditoría (docs/design/E2-plan-cuentas.md §2.2 y §2.6).
--
-- Nivel 2 (ADR-0008): la FK compuesta (organization_id, code) que crean estas
-- tablas es el destino de la FK compuesta de `journal_lines` en E3 — la barrera
-- de BD que impide que una línea apunte a una cuenta de otra organización (I10).
--
-- DIVERGENCIA CONSCIENTE respecto a §2.6: el diseño coloca las restricciones
-- manuales en un `constraints.sql` DENTRO de esta carpeta. `prisma migrate
-- deploy` ejecuta únicamente `migration.sql`, así que ese fichero nunca se
-- aplicaría y los CHECK/EXCLUDE no existirían en ninguna base. Van aquí abajo,
-- en la sección "2. Restricciones manuales", en la misma migración.
--
-- Las tablas NACEN VACÍAS: no hay migración de datos. Las organizaciones ya
-- creadas se siembran con el backfill idempotente de T7
-- (`npx tsx seeds/import_npgc.ts --all`).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Esquema (generado por prisma migrate diff)
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateEnum
CREATE TYPE "nature" AS ENUM ('DEUDORA', 'ACREEDORA');

-- CreateEnum
CREATE TYPE "statement" AS ENUM ('BALANCE_ACTIVO', 'BALANCE_PASIVO', 'BALANCE_PN', 'PYG', 'ECPN');

-- CreateEnum
CREATE TYPE "analytic_type" AS ENUM ('INGRESO_DIRECTO', 'COSTE_DIRECTO_MC1', 'COSTE_DIRECTO_MC2', 'INDIRECTO_CECO', 'AMORTIZACION_DETERIORO', 'FINANCIERO', 'EXTRAORDINARIO', 'NO_ANALITICO');

-- CreateEnum
CREATE TYPE "cashflow_category" AS ENUM ('OPERATING', 'INVESTING', 'FINANCING');

-- CreateEnum
CREATE TYPE "account_key" AS ENUM ('CLIENTES', 'PROVEEDORES', 'ACREEDORES', 'BANCO_DEFAULT', 'CAJA', 'IVA_SOPORTADO', 'IVA_REPERCUTIDO', 'IRPF_RETENIDO_CLIENTES', 'IRPF_A_PAGAR', 'HP_ACREEDORA_IVA', 'HP_DEUDORA_IVA', 'SS_ACREEDORA', 'REMUNERACIONES_PENDIENTES', 'RESULTADO_EJERCICIO', 'VENTAS_DEFAULT', 'COMPRAS_DEFAULT', 'SUBCONTRATACION_DEFAULT', 'ANTICIPOS_PROVEEDORES', 'ANTICIPOS_CLIENTES', 'DESCUENTO_PP_VENTAS', 'DESCUENTO_PP_COMPRAS', 'DEVOLUCION_VENTAS', 'DEVOLUCION_COMPRAS', 'RAPPEL_VENTAS', 'RAPPEL_COMPRAS', 'REDONDEO_GASTO', 'REDONDEO_INGRESO', 'IRPF_PROFESIONALES_A_PAGAR', 'IRPF_ALQUILERES_A_PAGAR', 'IRPF_TRABAJO_A_PAGAR', 'IVA_SOPORTADO_ISP', 'IVA_REPERCUTIDO_ISP', 'AJUSTE_IVA_NEGATIVO', 'AJUSTE_IVA_POSITIVO', 'IMPUESTO_BENEFICIOS_GASTO', 'HP_ACREEDORA_IS', 'HP_DEUDORA_IS', 'ACTIVO_IMPUESTO_DIFERIDO', 'PASIVO_IMPUESTO_DIFERIDO', 'PERIODIFICACION_GASTO', 'PERIODIFICACION_INGRESO', 'DIFERENCIA_CAMBIO_NEGATIVA', 'DIFERENCIA_CAMBIO_POSITIVA', 'RETENCIONES_CAPITAL_SOPORTADAS', 'SS_DEUDORA', 'ANTICIPOS_REMUNERACIONES', 'SUELDOS_DEFAULT', 'SS_EMPRESA_DEFAULT', 'CLIENTES_DUDOSO_COBRO', 'DETERIORO_CLIENTES', 'DOTACION_DETERIORO_CREDITOS', 'REVERSION_DETERIORO_CREDITOS', 'PERDIDA_CREDITOS_INCOBRABLES', 'CUENTA_PUENTE_TESORERIA', 'COMISIONES_BANCARIAS', 'REMANENTE', 'RESULTADOS_NEGATIVOS_ANTERIORES');

-- CreateEnum
CREATE TYPE "tax_kind" AS ENUM ('IVA', 'IRPF', 'RECARGO', 'EXENTO');

-- CreateEnum
CREATE TYPE "tax_applies_to" AS ENUM ('SALE', 'PURCHASE', 'BOTH');

-- CreateEnum
CREATE TYPE "tax_rounding_mode" AS ENUM ('PER_TIPO', 'PER_LINEA');

-- CreateEnum
CREATE TYPE "account_origin" AS ENUM ('SEED', 'MANUAL', 'CSV_IMPORT');

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "prorrata_permille" INTEGER,
ADD COLUMN     "redondeo_tolerancia_cents" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "tax_rounding_mode" "tax_rounding_mode" NOT NULL DEFAULT 'PER_TIPO';

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" VARCHAR(12) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "level" INTEGER NOT NULL,
    "parent_code" VARCHAR(12),
    "nature" "nature" NOT NULL,
    "statement" "statement",
    "epigraph" VARCHAR(255),
    "epigraph_pymes" VARCHAR(255),
    "bidirectional" BOOLEAN NOT NULL DEFAULT false,
    "is_contra" BOOLEAN NOT NULL DEFAULT false,
    "analytic_type" "analytic_type",
    "cashflow_category" "cashflow_category",
    "is_postable" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "origin" "account_origin" NOT NULL DEFAULT 'MANUAL',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_account_maps" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "key" "account_key" NOT NULL,
    "account_code" VARCHAR(12) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_account_maps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rates" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" VARCHAR(24) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "kind" "tax_kind" NOT NULL,
    "rate_bps" INTEGER NOT NULL,
    "applies_to" "tax_applies_to" NOT NULL DEFAULT 'BOTH',
    "account_code" VARCHAR(12) NOT NULL,
    "counter_account_code" VARCHAR(12),
    "linked_tax_rate_id" UUID,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID,
    "entity" VARCHAR(64) NOT NULL,
    "entity_id" VARCHAR(64) NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" VARCHAR(512),
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "accounts_organization_id_parent_code_idx" ON "accounts"("organization_id", "parent_code");

-- CreateIndex
CREATE INDEX "accounts_organization_id_is_active_is_postable_idx" ON "accounts"("organization_id", "is_active", "is_postable");

-- CreateIndex
CREATE INDEX "accounts_organization_id_statement_idx" ON "accounts"("organization_id", "statement");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_organization_id_code_key" ON "accounts"("organization_id", "code");

-- CreateIndex
CREATE INDEX "organization_account_maps_organization_id_account_code_idx" ON "organization_account_maps"("organization_id", "account_code");

-- CreateIndex
CREATE UNIQUE INDEX "organization_account_maps_organization_id_key_key" ON "organization_account_maps"("organization_id", "key");

-- CreateIndex
CREATE INDEX "tax_rates_organization_id_kind_valid_from_idx" ON "tax_rates"("organization_id", "kind", "valid_from");

-- CreateIndex
CREATE INDEX "tax_rates_organization_id_account_code_idx" ON "tax_rates"("organization_id", "account_code");

-- CreateIndex
CREATE UNIQUE INDEX "tax_rates_organization_id_code_valid_from_key" ON "tax_rates"("organization_id", "code", "valid_from");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_ts_idx" ON "audit_logs"("organization_id", "ts");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_entity_entity_id_ts_idx" ON "audit_logs"("organization_id", "entity", "entity_id", "ts");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_organization_id_parent_code_fkey" FOREIGN KEY ("organization_id", "parent_code") REFERENCES "accounts"("organization_id", "code") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "organization_account_maps" ADD CONSTRAINT "organization_account_maps_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_account_maps" ADD CONSTRAINT "organization_account_maps_organization_id_account_code_fkey" FOREIGN KEY ("organization_id", "account_code") REFERENCES "accounts"("organization_id", "code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_organization_id_account_code_fkey" FOREIGN KEY ("organization_id", "account_code") REFERENCES "accounts"("organization_id", "code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_organization_id_counter_account_code_fkey" FOREIGN KEY ("organization_id", "counter_account_code") REFERENCES "accounts"("organization_id", "code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_linked_tax_rate_id_fkey" FOREIGN KEY ("linked_tax_rate_id") REFERENCES "tax_rates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Restricciones manuales (§2.6, ADR-0008 puntos 4 y 5)
-- ─────────────────────────────────────────────────────────────────────────────

-- R-01: el código es una cadena de dígitos que no empieza por 0, de 1 a 12
-- caracteres. La jerarquía es por prefijo de TEXTO, así que un `0` a la
-- izquierda o un carácter no numérico rompería toda la agregación.
ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_code_format_check"
  CHECK ("code" ~ '^[1-9][0-9]{0,11}$');

-- `level` es longitud del código, no un dato independiente que pueda divergir.
ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_level_check"
  CHECK ("level" = length("code"));

-- I-E2-1: el padre es un prefijo ESTRICTO del hijo. La FK compuesta garantiza
-- que exista y sea de la misma organización; esto garantiza que además sea su
-- prefijo (no basta la FK: apuntaría a cualquier cuenta de la organización).
ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_parent_prefix_check"
  CHECK (
    "parent_code" IS NULL
    OR (length("parent_code") < length("code") AND left("code", length("parent_code")) = "parent_code")
  );

-- Un tipo impositivo es un ratio en puntos básicos: 0 % … 100 %.
ALTER TABLE "tax_rates"
  ADD CONSTRAINT "tax_rates_rate_bps_range_check"
  CHECK ("rate_bps" BETWEEN 0 AND 10000);

-- Un tipo EXENTO con cuota no es exento.
ALTER TABLE "tax_rates"
  ADD CONSTRAINT "tax_rates_exento_zero_check"
  CHECK ("kind" <> 'EXENTO' OR "rate_bps" = 0);

-- Vigencia coherente. `valid_to` NULL = abierta hacia adelante (nunca hacia atrás).
ALTER TABLE "tax_rates"
  ADD CONSTRAINT "tax_rates_validity_range_check"
  CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from");

-- Un RECARGO existe siempre asociado al tipo de IVA al que acompaña (C-2).
ALTER TABLE "tax_rates"
  ADD CONSTRAINT "tax_rates_recargo_link_check"
  CHECK ("kind" <> 'RECARGO' OR "linked_tax_rate_id" IS NOT NULL);

-- Prorrata general en tanto por mil.
ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_prorrata_permille_check"
  CHECK ("prorrata_permille" IS NULL OR "prorrata_permille" BETWEEN 0 AND 1000);

ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_redondeo_tolerancia_check"
  CHECK ("redondeo_tolerancia_cents" >= 0);

-- I-E2-3: dos tipos con el mismo `code` en la misma organización no pueden
-- solapar vigencias. El `@@unique(organizationId, code, validFrom)` sólo impide
-- el duplicado exacto de fecha de inicio; el solape lo corta esto.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "tax_rates"
  ADD CONSTRAINT "tax_rates_validity_overlap_excl"
  EXCLUDE USING gist (
    "organization_id" WITH =,
    "code" WITH =,
    daterange("valid_from", "valid_to", '[]') WITH &&
  );
