-- E11 · ola A — **M4**: siembra del catálogo de planes y backfill de
-- suscripciones (docs/design/E11-plataforma-saas.md §2.7, §2.8, §17.1;
-- ADR-0019 D1.5, O-14, P-1, P-2, P-8).
--
-- Aditiva y ejecutable por un rol NO superusuario. Lo único que esta migración
-- BORRA es nada: no hay un `DELETE`, ni un `DROP COLUMN`, ni un `UPDATE` sobre
-- una cifra contable.
--
-- **El baile obligatorio de `CLAUDE.md`.** Con `FORCE ROW LEVEL SECURITY` el
-- propietario TAMPOCO esquiva las políticas, así que un `INSERT` de datos ve 0
-- filas —o choca contra la política `RESTRICTIVE … USING (false)` de `plans`—.
-- Patrón, dentro de la MISMA migración (el DDL es transaccional):
--     ALTER TABLE x NO FORCE ROW LEVEL SECURITY;  →  backfill  →  FORCE;
-- y la marca (la política) escrita ANTES del backfill, como el runbook de E3
-- (`20260907120000_e3_prorrata_marker_order`). Al final se comprueba que
-- **ninguna tabla queda en NO FORCE**.
--
-- Lo que esta migración **NO** hace, y por qué:
--
--  · **`storage_used` / `storage_limit` a `bigint`.** El diseño §2.7 lo pide
--    (techo de 2,1 GB contra un plan PRO de 100 GB), pero las columnas las leen
--    `lib/files.ts`, `lib/auth.ts`, `lib/uploads.ts` y el layout — ficheros de la
--    **ola B** (T4/T5). Cambiar el tipo aquí rompería su compilación a mitad de
--    sprint. Va con M2, en la misma ola que su código.
--  · **Retirar `ai_balance`.** Se COMPRUEBA aquí (O-14, abajo) y se deja viva y
--    deprecada, como sus tres hermanas de §2.7: `ai/queue.ts`, `lib/auth.ts` y
--    el panel de perfil todavía la leen, y retirar la columna en la misma épica
--    que la sustituye haría imposible un rollback. Queda fechado en E12.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. **O-14** — guardia de `ai_balance > 0`, ANTES de tocar nada
--
--    `ai_balance` es un saldo prepagado, y un saldo prepagado es un PASIVO
--    (438/485 en NUESTRA contabilidad). Darlo de baja exige canje o devolución
--    ACEPTADOS, no una novación unilateral. P-4 lo verificó sobre el preview (1
--    organización, saldo 0) y el punto decae — pero se COMPRUEBA, no se supone.
--
--    Si aparece alguno, la migración ABORTA e imprime el importe en euros al
--    precio de venta, que es la cifra que hace falta para provisionar.
-- ─────────────────────────────────────────────────────────────────────────────
--    **La única salida es una decisión de operador, explícita y registrada.** Si
--    los saldos ya se han resuelto (canje, devolución o provisión contabilizada),
--    el operador lo declara ANTES de migrar:
--
--        ALTER DATABASE <base> SET app.e11_ai_balance_resuelto = 'si';
--
--    No es un interruptor para saltarse la comprobación: es la forma de dejar
--    escrito, en la propia base, que alguien se hizo cargo del pasivo. La
--    migración lo anota en `platform_audit_logs` con el importe encontrado, de
--    modo que la decisión queda en la auditoría y no en la memoria de nadie.
DO $$
DECLARE
  v_orgs     integer;
  v_saldo    bigint;
  v_resuelto text := coalesce(current_setting('app.e11_ai_balance_resuelto', true), '');
  -- Precio de venta del análisis con IA en el plan heredado `early_monthly`:
  -- 10 €/mes por 1 000 análisis = 1 céntimo por análisis (lib/stripe.ts, PLANS).
  v_precio_centimos_por_analisis constant integer := 1;
BEGIN
  SELECT count(*), COALESCE(sum("ai_balance"), 0)
    INTO v_orgs, v_saldo
    FROM "organizations"
   WHERE "ai_balance" > 0;

  IF v_orgs > 0 AND v_resuelto = 'si' THEN
    INSERT INTO "platform_audit_logs" ("actor", "action", "detail")
    VALUES ('operator:migration', 'limit.soft_exceeded',
            jsonb_build_object(
              'reason', 'O-14: ai_balance > 0 declarado RESUELTO por el operador antes de migrar',
              'current', v_saldo,
              'limit', 0));
    RAISE NOTICE 'O-14: % organizacion(es) con ai_balance > 0 (% analisis). El operador lo declara RESUELTO (app.e11_ai_balance_resuelto = si) y queda en platform_audit_logs.', v_orgs, v_saldo;
    v_orgs := 0;
  END IF;

  IF v_orgs > 0 THEN
    RAISE EXCEPTION
      'O-14: % organizacion(es) con ai_balance > 0 (total % analisis, equivalentes a %,% EUR al precio de venta). '
      'Un saldo prepagado es un PASIVO: su baja exige canje o devolucion ACEPTADOS, no una novacion unilateral. '
      'Resuelvalo (canje por plan, devolucion o provision) y vuelva a aplicar la migracion.',
      v_orgs,
      v_saldo,
      (v_saldo * v_precio_centimos_por_analisis) / 100,
      lpad((((v_saldo * v_precio_centimos_por_analisis) % 100))::text, 2, '0');
  END IF;
END $$;

COMMENT ON COLUMN "organizations"."ai_balance" IS
  'DEPRECADA (E11, ADR-0019 D1.5): saldo que se decrementaba al escribir, prohibido por P2/P4 y que ademas nunca funciono (G-12). Sin lectores nuevos; retirada fechada en E12.';
COMMENT ON COLUMN "organizations"."membership_plan" IS
  'DEPRECADA (E11): el plan vive en subscriptions.plan_code. Retirada fechada en E12.';
COMMENT ON COLUMN "organizations"."membership_expires_at" IS
  'DEPRECADA (E11): la vigencia vive en subscriptions.current_period_end. Retirada fechada en E12.';
COMMENT ON COLUMN "organizations"."storage_limit" IS
  'DEPRECADA (E11): el limite vive en plans.max_storage_bytes. Retirada fechada en E12.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Catálogo de planes (§17.1, P-1) — el PARÁMETRO aprobado por Pablo
--
--    Tres planes, vigentes desde 2026-01-01 y sin fecha de fin. Un cambio de
--    precios o de cuotas NO edita estas filas: añade una versión con otro
--    `valid_from` y cierra la anterior con `valid_to`. El `EXCLUDE USING gist`
--    de M1 impide el solape, y la FK de `subscriptions.plan_id` a la VERSIÓN
--    hace que a un cliente no se le reescriban retroactivamente sus límites.
--
--    `stripe_price_id` va a NULL en los tres: los precios de producción se crean
--    en Stripe al poner precios (T18) y se enlazan con una versión nueva. Sembrar
--    un identificador inventado sería un dato falso en un catálogo.
--
--    `-1` = ilimitado, y `checkLimit` lo resuelve ANTES de mirar el uso.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "plans" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "plans" (
  "id", "code", "name", "description",
  "list_price_cents", "currency", "interval", "stripe_price_id",
  "max_members", "max_ocr_docs_month", "max_storage_bytes",
  "max_exports_month", "max_backups_month", "max_organizations",
  "soft_max_entries_month", "grace_days", "backup_retention_days",
  "is_public", "valid_from", "valid_to", "updated_at"
) VALUES
  (
    '0e11a1a0-0000-4000-8000-000000000001'::uuid, 'FREE', 'Gratuito',
    'Plan de entrada, sin coste. Una organizacion, dos personas y el motor contable completo: la contabilidad nunca se limita, solo los recursos de la plataforma.',
    0, 'EUR', 'MONTH', NULL,
    2, 20, 524288000,          -- 2 miembros · 20 OCR/mes · 500 MB
    5, 1, 1,                   -- 5 exportaciones · 1 backup/mes · 1 organizacion
    100,                       -- BLANDO: 100 asientos/mes, avisa y nunca bloquea
    0, 7,                      -- sin gracia (P-2) · 7 dias de retencion de ZIP
    -- P-1: FREE **no es vendible**. `is_public` lo mantiene ofrecible en el alta
    -- pero sin `stripe_price_id` no hay checkout posible.
    true, DATE '2026-01-01', NULL, CURRENT_TIMESTAMP
  ),
  (
    '0e11a1a0-0000-4000-8000-000000000002'::uuid, 'STARTER', 'Starter',
    'Para la PYME que lleva su contabilidad completa: cinco personas, trescientos documentos con OCR al mes y diez gigas de archivo.',
    4900, 'EUR', 'MONTH', NULL,
    5, 300, 10737418240,       -- 5 miembros · 300 OCR/mes · 10 GB
    100, 10, 3,                -- 100 exportaciones · 10 backups/mes · 3 organizaciones
    2000,                      -- BLANDO
    14, 30,                    -- 14 dias de gracia (P-2) · 30 dias de retencion (P-8)
    true, DATE '2026-01-01', NULL, CURRENT_TIMESTAMP
  ),
  (
    '0e11a1a0-0000-4000-8000-000000000003'::uuid, 'PRO', 'Pro',
    'Para el despacho y el grupo: veinticinco personas, tres mil documentos con OCR al mes, cien gigas y exportaciones y copias sin limite.',
    14900, 'EUR', 'MONTH', NULL,
    25, 3000, 107374182400,    -- 25 miembros · 3 000 OCR/mes · 100 GB
    -1, -1, 10,                -- exportaciones y backups ilimitados · 10 organizaciones
    20000,                     -- BLANDO
    30, 90,                    -- 30 dias de gracia · 90 dias de retencion
    true, DATE '2026-01-01', NULL, CURRENT_TIMESTAMP
  );

ALTER TABLE "plans" FORCE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Backfill de `subscriptions` — **I-E11-5 exige que ninguna organización se
--    quede sin fila**, y un `accessLevelOf` sin suscripción no sabría decir si
--    la organización puede escribir.
--
--    Toda organización existente recibe `FREE` / `ACTIVE` sin
--    `stripe_subscription_id`: no se le atribuye a nadie una suscripción de pago
--    que no ha contratado, y `ACTIVE` (no `TRIALING`) porque no hay periodo de
--    prueba que contar hacia atras.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "subscriptions" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "subscriptions" (
  "organization_id", "plan_code", "plan_id", "status", "created_at", "updated_at"
)
SELECT o."id", 'FREE', '0e11a1a0-0000-4000-8000-000000000001'::uuid, 'ACTIVE',
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM "organizations" o
 WHERE NOT EXISTS (SELECT 1 FROM "subscriptions" s WHERE s."organization_id" = o."id");

ALTER TABLE "subscriptions" FORCE ROW LEVEL SECURITY;

-- I-E11-5, comprobado aquí y no sólo en el invariante nocturno: si el backfill
-- deja una organización fuera, la migración no se aplica.
DO $$
DECLARE v_huerfanas integer;
BEGIN
  SELECT count(*) INTO v_huerfanas
    FROM "organizations" o
   WHERE NOT EXISTS (SELECT 1 FROM "subscriptions" s WHERE s."organization_id" = o."id");
  IF v_huerfanas > 0 THEN
    RAISE EXCEPTION 'I-E11-5: % organizacion(es) sin Subscription tras el backfill', v_huerfanas;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Verificación: ninguna tabla queda en NO FORCE (ADR-0009 §7)
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
