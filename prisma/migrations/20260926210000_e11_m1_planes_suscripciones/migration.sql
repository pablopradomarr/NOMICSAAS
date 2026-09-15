-- E11 · ola A — **M1**: `plans`, `subscriptions`, `subscription_events`
-- (docs/design/E11-plataforma-saas.md §2.2 y §2.8; ADR-0019 D1).
--
-- Aditiva pura y ejecutable por un rol NO superusuario (CLAUDE.md): las tres
-- tablas nacen VACÍAS —la siembra del catálogo y el backfill de suscripciones
-- son M4—, así que aquí no hay backfill y no hace falta el baile
-- `NO FORCE` → backfill → `FORCE`. Ni un `ALTER ROLE`, ni un `OWNER TO`, ni una
-- extensión nueva: `btree_gist` está disponible desde E2.
--
-- Tres decisiones de fondo, todas de ADR-0019 D1:
--
--  1. **Los límites son COLUMNAS, no JSON.** Así la base los puede comprobar
--     (CHECK) y un cambio de forma exige migración. Un JSON sin CHECK y sin tipo
--     rompe en silencio.
--  2. **`plans` es catálogo GLOBAL versionado por vigencia** y lo cambia una
--     MIGRACIÓN: `ENABLE` + `FORCE` con `SELECT` abierto y `RESTRICTIVE … USING
--     (false)` en escritura para `app_runtime`. Patrón exacto de
--     `exchange_rates` (20260913100000_e8_documentos).
--  3. **`subscription_events` es append-only** con `stripe_event_id` UNIQUE: ésa,
--     y no otra cosa, es la idempotencia del webhook (I-E11-9).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. `plans` — catálogo global versionado
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE "plans" (
  "id"                     uuid           NOT NULL DEFAULT gen_random_uuid(),
  "code"                   varchar(32)    NOT NULL,
  "name"                   varchar(64)    NOT NULL,
  "description"            varchar(512)   NOT NULL,
  "list_price_cents"       integer        NOT NULL,
  "currency"               varchar(3)     NOT NULL DEFAULT 'EUR',
  "interval"               "plan_interval" NOT NULL,
  -- NULL (y no cadena vacía) en el plan NO VENDIBLE: `FREE` no tiene precio en
  -- Stripe (P-1). Con cadena vacía el UNIQUE sólo admitiría uno, y el día que
  -- haya un segundo plan no vendible reventaría por donde no se espera.
  "stripe_price_id"        varchar(64),
  -- Cuotas de RECURSO (bloquean, §3.5). `-1` = ilimitado, y se resuelve ANTES de
  -- mirar el uso (criterio 19).
  "max_members"            integer        NOT NULL,
  "max_ocr_docs_month"     integer        NOT NULL,
  "max_storage_bytes"      bigint         NOT NULL,
  "max_exports_month"      integer        NOT NULL,
  "max_backups_month"      integer        NOT NULL,
  "max_organizations"      integer        NOT NULL,
  -- Cuota BLANDA sobre el registro contable (O-3, ADR-0019 D7). El nombre lleva
  -- `soft_` para que nadie la cablee al guardián por descuido: `HardLimitKey` no
  -- la admite, el tipo lo impide y **I-E11-4c lo comprueba contra el AST**.
  "soft_max_entries_month" integer        NOT NULL,
  "grace_days"             integer        NOT NULL DEFAULT 14,
  "backup_retention_days"  integer        NOT NULL DEFAULT 30,
  "is_public"              boolean        NOT NULL DEFAULT true,
  "valid_from"             date           NOT NULL,
  "valid_to"               date,
  "created_at"             timestamp(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             timestamp(3)   NOT NULL,
  CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plans_code_valid_from_key" ON "plans" ("code", "valid_from");
CREATE UNIQUE INDEX "plans_stripe_price_id_key" ON "plans" ("stripe_price_id");
CREATE INDEX "plans_code_valid_from_desc_idx" ON "plans" ("code", "valid_from" DESC);

-- Vigencias SIN SOLAPE por código. `resolvePlanAt` lanza si aun así encuentra
-- dos (nunca «la primera que aparezca»), pero el sitio donde esto se garantiza
-- es la base: un catálogo con dos versiones vigentes el mismo día es un cliente
-- con dos juegos de límites y nadie sabría cuál se le prometió.
ALTER TABLE "plans"
  ADD CONSTRAINT "plans_vigencias_sin_solape"
  EXCLUDE USING gist (
    "code" WITH =,
    daterange("valid_from", "valid_to", '[]') WITH &&
  );

ALTER TABLE "plans" ADD CONSTRAINT "plans_vigencia_coherente"
  CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from");
ALTER TABLE "plans" ADD CONSTRAINT "plans_precio_no_negativo"
  CHECK ("list_price_cents" >= 0);
ALTER TABLE "plans" ADD CONSTRAINT "plans_gracia_no_negativa"
  CHECK ("grace_days" >= 0 AND "backup_retention_days" > 0);
-- `-1` (ilimitado) o un entero positivo. Un `0` sería un plan que no deja hacer
-- nada y un `-2` no significa nada.
ALTER TABLE "plans" ADD CONSTRAINT "plans_cuotas_admisibles"
  CHECK (
    "max_members"            >= -1 AND "max_members"            <> 0 AND
    "max_ocr_docs_month"     >= -1 AND
    "max_storage_bytes"      >= -1 AND
    "max_exports_month"      >= -1 AND
    "max_backups_month"      >= -1 AND
    "max_organizations"      >= -1 AND "max_organizations"      <> 0 AND
    "soft_max_entries_month" >= -1
  );
-- C-4 / O-12a: `*_cents` presupone dos decimales. Restringir la moneda es más
-- barato que arrastrar un `minorUnitScale` por todo el modelo.
ALTER TABLE "plans" ADD CONSTRAINT "plans_moneda_admisible"
  CHECK ("currency" IN ('EUR', 'USD'));
-- P-1 · **FREE no es vendible**: un plan a coste cero NO puede tener precio en
-- Stripe, porque no hay operación sujeta que cobrar (C-7: sin contraprestación
-- no hay operación sujeta, art. 4.Uno LIVA, y no se emite factura a cero).
--
-- La implicación va sólo en ese sentido. Un plan de pago SÍ puede sembrarse sin
-- `stripe_price_id`: el precio se crea en Stripe cuando se ponen precios en
-- producción (T18 los entrega) y hasta entonces el plan existe en el catálogo
-- pero no se puede contratar. Exigirlo aquí obligaría a sembrar un identificador
-- inventado, que es precisamente el dato falso que una migración no debe crear.
ALTER TABLE "plans" ADD CONSTRAINT "plans_gratuito_sin_precio_stripe"
  CHECK ("list_price_cents" > 0 OR "stripe_price_id" IS NULL);

COMMENT ON TABLE "plans" IS
  'E11 · catálogo GLOBAL de planes, versionado por vigencia. Lo cambia una MIGRACIÓN (ADR-0019 D1.1).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. `subscriptions` — una y sólo una por organización (I-E11-5)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE "subscriptions" (
  "id"                     uuid                  NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"        uuid                  NOT NULL,
  "plan_code"              varchar(32)           NOT NULL,
  -- FK a la VERSIÓN contratada: un cambio de límites NO reescribe
  -- retroactivamente lo que se le prometió a un cliente (ADR-0019 D1.2).
  "plan_id"                uuid                  NOT NULL,
  "stripe_subscription_id" varchar(64),
  "status"                 "subscription_status" NOT NULL DEFAULT 'TRIALING',
  "current_period_start"   timestamp(3),
  "current_period_end"     timestamp(3),
  "cancel_at_period_end"   boolean               NOT NULL DEFAULT false,
  "trial_end"              timestamp(3),
  "grace_until"            timestamp(3),
  -- **O-4**: ventana de descarga tras CANCELED (90 días), POR ENCIMA de la
  -- retención del plan. La portabilidad no la puede desactivar un precio.
  "export_window_until"    timestamp(3),
  -- C-1 · la prueba de la condición de empresario del destinatario es NUESTRA
  -- (art. 164 LIVA), se conserva en nuestro lado y se revalida EN CADA DEVENGO.
  "customer_country"       varchar(2),
  "vat_number"             varchar(20),
  "vat_validated_at"       timestamp(3),
  "vat_validation_source"  varchar(24),
  "vat_validation_ref"     varchar(64),
  "created_at"             timestamp(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             timestamp(3)          NOT NULL,
  CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "subscriptions_organization_id_key" ON "subscriptions" ("organization_id");
CREATE UNIQUE INDEX "subscriptions_stripe_subscription_id_key"
  ON "subscriptions" ("stripe_subscription_id");
-- El barrido del cron y el cálculo de gracia entran por aquí.
CREATE INDEX "subscriptions_status_current_period_end_idx"
  ON "subscriptions" ("status", "current_period_end");
-- Requerida por las FK compuestas por tenant de las tablas que la referencian.
CREATE UNIQUE INDEX "subscriptions_organization_id_id_key"
  ON "subscriptions" ("organization_id", "id");

ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- `RESTRICT`: retirar del catálogo una versión que alguien tiene contratada
-- borraría la prueba de qué límites se le prometieron.
ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_plan_id_fkey"
  FOREIGN KEY ("plan_id") REFERENCES "plans"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_periodo_coherente"
  CHECK ("current_period_end" IS NULL OR "current_period_start" IS NULL
         OR "current_period_end" >= "current_period_start");
-- C-1 / P-1 · **B2B-only**: si hay país, hay país de dos letras en mayúsculas.
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_pais_iso"
  CHECK ("customer_country" IS NULL OR "customer_country" ~ '^[A-Z]{2}$');
-- Una validación sin fecha no es una prueba: no se puede saber si valía en el
-- devengo. Las tres viajan juntas o no viaja ninguna.
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_prueba_vies_completa"
  CHECK (
    ("vat_validated_at" IS NULL AND "vat_validation_source" IS NULL AND "vat_validation_ref" IS NULL)
    OR ("vat_validated_at" IS NOT NULL AND "vat_validation_source" IS NOT NULL)
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. `subscription_events` — append-only, `stripe_event_id` UNIQUE (I-E11-9)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE "subscription_events" (
  "id"              uuid                  NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" uuid                  NOT NULL,
  "subscription_id" uuid,
  "stripe_event_id" varchar(64)           NOT NULL,
  "event_type"      varchar(64)           NOT NULL,
  "occurred_at"     timestamp(3)          NOT NULL,
  "status_before"   "subscription_status",
  "status_after"    "subscription_status" NOT NULL,
  -- §9.2 · payload RECORTADO: ids, tipo, precio, periodo y estado. NUNCA el
  -- objeto íntegro de Stripe, que lleva email, dirección de facturación e
  -- importes del cliente (regla de E1 #16).
  "payload"         jsonb                 NOT NULL,
  "created_at"      timestamp(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscription_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "subscription_events_stripe_event_id_key"
  ON "subscription_events" ("stripe_event_id");
CREATE INDEX "subscription_events_organization_id_occurred_at_idx"
  ON "subscription_events" ("organization_id", "occurred_at");

ALTER TABLE "subscription_events"
  ADD CONSTRAINT "subscription_events_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- FK COMPUESTA por tenant: una suscripción de OTRA organización no puede
-- colarse en el evento (patrón O-A1 de E10).
ALTER TABLE "subscription_events"
  ADD CONSTRAINT "subscription_events_subscription_fkey"
  FOREIGN KEY ("organization_id", "subscription_id")
  REFERENCES "subscriptions"("organization_id", "id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RLS
--
--    `subscriptions` y `subscription_events` son de TENANT: nacen con
--    `app.enforce_tenant_rls` Y entran en `TENANT_MODELS` (lib/db.ts). Sin las
--    dos cosas, una consulta fuera de `tenantDb` devuelve VACÍO en silencio
--    (ADR-0009).
--
--    `plans` es catálogo GLOBAL: patrón de `exchange_rates`.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['subscriptions', 'subscription_events'] LOOP
    PERFORM app.enforce_tenant_rls(t);
  END LOOP;
END $$;

-- `ALTER DEFAULT PRIVILEGES` de esta base concede `arwd` a `app_runtime` sobre
-- TODA tabla nueva: un `GRANT SELECT, INSERT` no acota nada si antes no se
-- REVOCA. Sin este `REVOKE` el append-only de abajo sería decorativo y la prueba
-- de privilegio pasaría por vacuidad (lección de `closing_runs`, E9 M4).
REVOKE UPDATE, DELETE ON "subscription_events" FROM app_runtime;
GRANT SELECT, INSERT ON "subscription_events" TO app_runtime;
CREATE POLICY "subscription_events_no_update" ON "subscription_events"
  AS RESTRICTIVE FOR UPDATE USING (false);
CREATE POLICY "subscription_events_no_delete" ON "subscription_events"
  AS RESTRICTIVE FOR DELETE USING (false);

-- La suscripción SÍ se actualiza (es el estado vigente), pero no se borra: su
-- historia vive en `subscription_events` y perderla sería perder la trazabilidad
-- de por qué una organización quedó en READ_ONLY.
REVOKE DELETE ON "subscriptions" FROM app_runtime;
GRANT SELECT, INSERT, UPDATE ON "subscriptions" TO app_runtime;
CREATE POLICY "subscriptions_no_delete" ON "subscriptions"
  AS RESTRICTIVE FOR DELETE USING (false);

GRANT SELECT, INSERT, UPDATE, DELETE ON "subscriptions", "subscription_events"
  TO app_maintenance;

-- `plans`: catálogo global, lectura abierta y escritura CERRADA a `app_runtime`.
ALTER TABLE "plans" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "plans_read"      ON "plans" FOR SELECT USING (true);
CREATE POLICY "plans_no_insert" ON "plans" AS RESTRICTIVE FOR INSERT WITH CHECK (false);
CREATE POLICY "plans_no_update" ON "plans" AS RESTRICTIVE FOR UPDATE USING (false);
CREATE POLICY "plans_no_delete" ON "plans" AS RESTRICTIVE FOR DELETE USING (false);
ALTER TABLE "plans" FORCE ROW LEVEL SECURITY;
GRANT SELECT ON "plans" TO app_runtime;
REVOKE INSERT, UPDATE, DELETE ON "plans" FROM app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "plans" TO app_maintenance;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Verificación: ninguna tabla queda en NO FORCE (ADR-0009 §7)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['plans', 'subscriptions', 'subscription_events'] LOOP
    IF NOT (SELECT relforcerowsecurity FROM pg_class WHERE relname = t) THEN
      RAISE EXCEPTION '% ha quedado en NO FORCE ROW LEVEL SECURITY', t;
    END IF;
  END LOOP;
END $$;
