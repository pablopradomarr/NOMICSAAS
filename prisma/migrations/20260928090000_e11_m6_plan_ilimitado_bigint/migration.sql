-- E11 · integración de las tres olas — **M6**: el plan `ILIMITADO` del modo
-- INTERNO (ADR-0019 **D9**, aprobado por Pablo el 2026-09-15), los dos `bigint`
-- de §2.7 que la ola A dejó fuera y la retirada de `ai_balance`.
--
-- Ejecutable por un rol NO superusuario: ni `ALTER ROLE`, ni `OWNER TO`, ni una
-- sentencia que exija SUPERUSER. El baile `NO FORCE → backfill → FORCE` de
-- `CLAUDE.md` se hace dentro de la MISMA migración, que es transaccional.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. El plan `ILIMITADO` (D9)
--
--    **Por qué es una fila del catálogo y no una constante.** Porque el defecto
--    que E11 vino a cerrar era literalmente «el plan vive en una constante de
--    TypeScript (`PLANS` en `lib/stripe.ts`)». `Subscription.plan_id` apunta a
--    una VERSIÓN, y la única manera de que el modo interno respete D1.1 es que
--    su plan sea una versión más.
--
--    **No vendible**: `is_public = false` y `stripe_price_id = NULL`, así que no
--    aparece en el alta y `isSellable` lo rechaza. Los siete límites a `-1`, que
--    `checkLimit` resuelve ANTES de mirar el uso; `backup_retention_days = -1`
--    significa «sin caducidad» y `requestBackup` lo traduce a `expires_at NULL`,
--    que `expireBackups` nunca selecciona: en uso interno no hay motivo para
--    destruir una copia a los treinta días.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "plans" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "plans" (
  "id", "code", "name", "description",
  "list_price_cents", "currency", "interval", "stripe_price_id",
  "max_members", "max_ocr_docs_month", "max_storage_bytes",
  "max_exports_month", "max_backups_month", "max_organizations",
  "soft_max_entries_month", "grace_days", "backup_retention_days",
  "is_public", "valid_from", "valid_to", "updated_at"
) VALUES (
  '0e11a1a0-0000-4000-8000-000000000009'::uuid, 'ILIMITADO', 'Ilimitado (uso interno)',
  'Plan del modo interno (ADR-0019 D9): sin coste, sin cobro y sin ningun limite. No es vendible y no aparece en el alta.',
  0, 'EUR', 'MONTH', NULL,
  -1, -1, -1,
  -1, -1, -1,
  -1,
  0, 3650,
  false, DATE '2026-01-01', NULL, CURRENT_TIMESTAMP
)
ON CONFLICT ("code", "valid_from") DO NOTHING;

ALTER TABLE "plans" FORCE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Backfill de suscripciones al plan `ILIMITADO`
--
--    Dos poblaciones, y las dos por el mismo motivo: en modo INTERNO **toda
--    organización nace con `ILIMITADO`** (D9).
--
--    a) Las que no tienen fila. M4 sembró las que existían entonces; las creadas
--       despues de M4 y antes de que `ensureSubscriptionForOrganization` entrara
--       en el alta se quedaron sin ninguna, y `getSubscriptionContext` las
--       mandaba a `READ_ONLY` con un motivo que no era verdad.
--
--    b) Las que M4 dejo en `FREE` **sin haber contratado nada**
--       (`stripe_subscription_id IS NULL`). No se toca ni una suscripcion con
--       identificador de Stripe: eso seria reescribir lo que alguien contrato.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "subscriptions" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "subscriptions" (
  "organization_id", "plan_code", "plan_id", "status", "created_at", "updated_at"
)
SELECT o."id", 'ILIMITADO', '0e11a1a0-0000-4000-8000-000000000009'::uuid, 'ACTIVE',
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM "organizations" o
 WHERE NOT EXISTS (SELECT 1 FROM "subscriptions" s WHERE s."organization_id" = o."id");

UPDATE "subscriptions"
   SET "plan_code" = 'ILIMITADO',
       "plan_id"   = '0e11a1a0-0000-4000-8000-000000000009'::uuid,
       "status"    = 'ACTIVE',
       "grace_until" = NULL,
       "updated_at" = CURRENT_TIMESTAMP
 WHERE "plan_code" = 'FREE'
   AND "stripe_subscription_id" IS NULL;

ALTER TABLE "subscriptions" FORCE ROW LEVEL SECURITY;

-- I-E11-5, comprobado aqui y no solo en el barrido nocturno.
DO $$
DECLARE v_huerfanas integer;
BEGIN
  SELECT count(*) INTO v_huerfanas
    FROM "organizations" o
   WHERE NOT EXISTS (SELECT 1 FROM "subscriptions" s WHERE s."organization_id" = o."id");
  IF v_huerfanas > 0 THEN
    RAISE EXCEPTION 'I-E11-5: % organizacion(es) sin Subscription tras el backfill de M6', v_huerfanas;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. `storage_used` y `storage_limit` a `bigint` (§2.7)
--
--    `integer` topa en 2,147 GB y el plan PRO promete 100 GB: la columna se
--    desbordaba **antes** de llegar al limite del plan. M4 lo dejo fuera a
--    proposito («las columnas las leen ficheros de la ola B»); esas dos olas ya
--    han aterrizado, asi que el cambio va aqui.
--
--    `ALTER TYPE integer -> bigint` reescribe la tabla, pero `organizations`
--    tiene decenas de filas, no millones. No hay conversion de valores: todo
--    `integer` cabe en `bigint`.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "organizations" ALTER COLUMN "storage_used"  TYPE bigint USING "storage_used"::bigint;
ALTER TABLE "organizations" ALTER COLUMN "storage_limit" TYPE bigint USING "storage_limit"::bigint;
ALTER TABLE "organizations" ALTER COLUMN "storage_used"  SET DEFAULT 0;
ALTER TABLE "organizations" ALTER COLUMN "storage_limit" SET DEFAULT -1;

COMMENT ON COLUMN "organizations"."storage_used" IS
  'DEPRECADA (E11, ADR-0019 D1.5): el uso es DERIVADO (stored_objects, models/usage.ts), no un contador. Se mantiene por compatibilidad del codigo heredado; retirada fechada en E12.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Retirada de `ai_balance` (ADR-0019 D1.5, **O-14**)
--
--    M4 comprobo que ningun saldo era > 0 y dejo la columna viva y deprecada
--    para permitir un rollback dentro de la misma epica. Con las tres olas
--    aterrizadas y `ai/queue.ts` ya sin lectores, se retira.
--
--    La guardia de O-14 se repite AQUI y no se supone: un saldo prepagado es un
--    PASIVO (438/485 en NUESTRA contabilidad) y borrar la columna que lo
--    acredita sin haberlo resuelto seria destruir la evidencia de una deuda.
-- ─────────────────────────────────────────────────────────────────────────────

--    La **salida es la misma que la de M4**, y a proposito: el operador declara
--    ANTES de migrar que los saldos estan resueltos (canje, devolucion o
--    provision contabilizada), y la declaracion queda en la propia base:
--
--        ALTER DATABASE <base> SET app.e11_ai_balance_resuelto = 'si';
--
--    No es un interruptor para saltarse la comprobacion: es la forma de dejar
--    escrito quien se hizo cargo del pasivo. La migracion lo anota en
--    `platform_audit_logs` con el importe encontrado.
DO $$
DECLARE
  v_orgs     integer := 0;
  v_saldo    bigint  := 0;
  v_resuelto text := coalesce(current_setting('app.e11_ai_balance_resuelto', true), '');
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'organizations' AND column_name = 'ai_balance') THEN
    SELECT count(*), COALESCE(sum("ai_balance"), 0) INTO v_orgs, v_saldo
      FROM "organizations" WHERE "ai_balance" > 0;

    IF v_orgs > 0 AND v_resuelto = 'si' THEN
      INSERT INTO "platform_audit_logs" ("actor", "action", "detail")
      VALUES ('operator:migration', 'limit.soft_exceeded',
              jsonb_build_object(
                'reason', 'O-14/M6: ai_balance > 0 declarado RESUELTO por el operador antes de retirar la columna',
                'current', v_saldo,
                'limit', 0));
      RAISE NOTICE 'O-14/M6: % organizacion(es) con ai_balance > 0 (% analisis). El operador lo declara RESUELTO y queda en platform_audit_logs.', v_orgs, v_saldo;
      v_orgs := 0;
    END IF;

    IF v_orgs > 0 THEN
      RAISE EXCEPTION
        'O-14: % organizacion(es) con ai_balance > 0 (total % analisis). Un saldo prepagado es un PASIVO: '
        'su baja exige canje o devolucion ACEPTADOS. Resuelvalo antes de retirar la columna.', v_orgs, v_saldo;
    END IF;
  END IF;
END $$;

ALTER TABLE "organizations" DROP COLUMN IF EXISTS "ai_balance";

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Verificacion: ninguna tabla queda en NO FORCE (ADR-0009 §7)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['plans', 'subscriptions'] LOOP
    IF NOT (SELECT relforcerowsecurity FROM pg_class WHERE relname = t) THEN
      RAISE EXCEPTION '% ha quedado en NO FORCE ROW LEVEL SECURITY', t;
    END IF;
  END LOOP;
END $$;
