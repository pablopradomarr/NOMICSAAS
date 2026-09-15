-- E11 · ola A — **M5**: `platform_invoice_series` y `platform_invoices`
-- (docs/design/E11-plataforma-saas.md §2.2, §2.8; ADR-0019 **D8**;
--  validación contable C-1…C-5, O-9, O-10, O-12a, O-15).
--
-- Aditiva y ejecutable por un rol NO superusuario. Dos tablas nuevas, una
-- función `SECURITY DEFINER` acotada y la siembra de las dos series bajo el
-- baile `NO FORCE` → siembra → `FORCE`.
--
-- **Por qué numeramos nosotros.** La numeración correlativa dentro de serie la
-- asigna el EXPEDIDOR (arts. 6.1.a y 7 RD 1619/2012), que somos nosotros. Stripe
-- deja HUECOS (borradores anulados, `void`, `draft` no finalizadas) y según
-- configuración numera por cliente: no puede ser nuestra serie. Stripe queda
-- como pasarela de cobro y generador del PDF. **I-E11-13** vigila esta serie
-- exactamente como I-E8-20 vigila la del cliente — es indefendible exigirle al
-- cliente un rigor que no nos aplicamos (O-10).
--
-- Lo que esta migración **NO** hace: el índice `(organization_id, work_date,
-- employee_id)` de `time_entries` que §2.8 colgaba de M5 (D-8). Ya existe desde
-- `20260925110000_e10_indice_agregado_horas`, y el calendario de `/time` es de la
-- ola C (T21). No se duplica.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. `platform_invoice_series` — serie GLOBAL, de CFOnomic, no de la organización
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE "platform_invoice_series" (
  "id"          uuid                  NOT NULL DEFAULT gen_random_uuid(),
  "code"        varchar(16)           NOT NULL,
  -- Reutiliza el enum del cliente: la distinción ORDINARIA / RECTIFICATIVA es la
  -- misma norma (art. 15.4 RD 1619/2012 exige serie especial y numeración propia
  -- para las rectificativas), y tener dos enums para el mismo concepto invita a
  -- que diverjan. `SIMPLIFICADA` no se usa aquí: B2B-only (P-1).
  "kind"        "invoice_series_kind" NOT NULL,
  "prefix"      varchar(16)           NOT NULL,
  -- ÚLTIMO número emitido (no «siguiente»): 0 = serie virgen, e I-E8-20 / -13
  -- están en INFO hasta la primera factura, que es su contrato.
  "last_number" integer               NOT NULL DEFAULT 0,
  "created_at"  timestamp(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_invoice_series_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platform_invoice_series_code_key" ON "platform_invoice_series" ("code");

ALTER TABLE "platform_invoice_series" ADD CONSTRAINT "platform_invoice_series_contador_no_negativo"
  CHECK ("last_number" >= 0);
ALTER TABLE "platform_invoice_series" ADD CONSTRAINT "platform_invoice_series_kind_admisible"
  CHECK ("kind" IN ('ORDINARIA', 'RECTIFICATIVA'));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. `platform_invoices` — la factura que CFOnomic EMITE al cliente
--
--    **No genera asiento (I-E11-8) y no tiene ni una columna que lo permita**:
--    no hay `journal_entry_id`, ni `transaction_id`, ni `file_id`. La puerta
--    indirecta también está cerrada (O-8): ningún `Transaction`, `ExtractionRun`
--    ni `File` puede tener por origen una `PlatformInvoice`.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE "platform_invoices" (
  "id"                     uuid           NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"        uuid           NOT NULL,
  "subscription_id"        uuid,

  -- ── Serie propia (O-9, O-10) ──
  "series_id"              uuid           NOT NULL,
  "number"                 integer        NOT NULL,
  -- `PLT-2026-0001`. Denormalizado para imprimir y para indexar el objeto.
  "full_number"            varchar(32)    NOT NULL,

  "rectifies_invoice_id"   uuid,
  "rectification_cause"    varchar(256),
  "rectification_mode"     "rectification_mode",

  -- ── Fechas (C-2) ──
  -- El plazo de expedición para destinatario empresario llega al día 16 del mes
  -- siguiente al devengo (art. 11 RD 1619/2012), y si las fechas difieren AMBAS
  -- deben constar (art. 6.1.f). `issued_at` NO es la fecha de devengo.
  "operation_date"         date           NOT NULL,
  "issued_at"              date           NOT NULL,
  -- Clave canónica del ERP `AAAA-Qn` (ADR-0014 D8), derivada de operation_date:
  -- el periodo de declaración lo manda el DEVENGO, nunca la expedición ni el cobro.
  "iva_period"             varchar(8)     NOT NULL,
  "period_start"           date,
  "period_end"             date,

  -- ── Régimen fiscal (C-1, C-6, O-15) ──
  "tax_treatment"          "tax_treatment" NOT NULL,
  "customer_country"       varchar(2)     NOT NULL,
  "vat_number"             varchar(20),
  "vat_validated_at"       timestamp(3),
  "vat_validation_source"  varchar(24),
  "vat_validation_ref"     varchar(64),
  -- Texto IMPRESO de la mención obligatoria (art. 6.1.m RD 1619/2012).
  "reverse_charge_mention" varchar(256),

  -- ── Cifras, tal cual las publica Stripe, en céntimos de SU moneda…
  "subtotal_cents"         integer        NOT NULL,
  "tax_cents"              integer        NOT NULL,
  "total_cents"            integer        NOT NULL,
  "currency"               varchar(3)     NOT NULL,
  -- …y la CUOTA, **siempre además en euros** (C-4: la cuota tributaria
  -- repercutida se expresa en euros, siempre), a la tasa del DEVENGO. Se
  -- convierte UNA SOLA VEZ y se sella: no se recalcula al mirarla.
  "tax_cents_eur"          integer        NOT NULL,
  "fx_rate_micro"          bigint,
  "fx_rate_date"           date,
  "fx_source"              varchar(24),

  "status"                 varchar(24)    NOT NULL,
  "stripe_invoice_id"      varchar(64)    NOT NULL,
  "hosted_invoice_url"     varchar(512),
  -- C-5 · el PDF COPIADO a nuestro almacén. Un `hosted_invoice_url` no es una
  -- copia conservada: es un enlace a la copia de otro (art. 165.Uno LIVA, arts.
  -- 19–23 RD 1619/2012). Sin FK: `stored_objects` es de la ola B (M2) y esta
  -- tabla no puede depender de su calendario; la correspondencia la comprueba
  -- I-E11-6 en el barrido.
  "stored_object_id"       uuid,

  "created_at"             timestamp(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_invoices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platform_invoices_series_id_number_key"
  ON "platform_invoices" ("series_id", "number");
CREATE UNIQUE INDEX "platform_invoices_stripe_invoice_id_key"
  ON "platform_invoices" ("stripe_invoice_id");
CREATE UNIQUE INDEX "platform_invoices_full_number_key"
  ON "platform_invoices" ("full_number");
-- El 349 y el 303 se agrupan por DEVENGO (O-17): el índice sigue esa consulta.
CREATE INDEX "platform_invoices_organization_id_operation_date_idx"
  ON "platform_invoices" ("organization_id", "operation_date");
CREATE INDEX "platform_invoices_iva_period_idx" ON "platform_invoices" ("iva_period");
CREATE UNIQUE INDEX "platform_invoices_organization_id_id_key"
  ON "platform_invoices" ("organization_id", "id");

ALTER TABLE "platform_invoices"
  ADD CONSTRAINT "platform_invoices_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "platform_invoices"
  ADD CONSTRAINT "platform_invoices_subscription_fkey"
  FOREIGN KEY ("organization_id", "subscription_id")
  REFERENCES "subscriptions"("organization_id", "id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "platform_invoices"
  ADD CONSTRAINT "platform_invoices_series_id_fkey"
  FOREIGN KEY ("series_id") REFERENCES "platform_invoice_series"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "platform_invoices"
  ADD CONSTRAINT "platform_invoices_rectifies_fkey"
  FOREIGN KEY ("rectifies_invoice_id") REFERENCES "platform_invoices"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Numeración: 1..N. El `0` y los negativos no son números de factura.
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_numero_positivo"
  CHECK ("number" > 0);
-- O-12a · C-4: `*_cents` presupone dos decimales.
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_moneda_admisible"
  CHECK ("currency" IN ('EUR', 'USD'));
-- La cuota en euros SIEMPRE existe; si la factura va en EUR, es la misma cifra y
-- no hay conversión que sellar. Si va en otra moneda, la tasa, su fecha y su
-- fuente viajan con ella o la cuota en euros no es verificable (C-4).
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_cuota_en_euros_sellada"
  CHECK (
    ("currency" = 'EUR' AND "tax_cents_eur" = "tax_cents"
      AND "fx_rate_micro" IS NULL AND "fx_rate_date" IS NULL AND "fx_source" IS NULL)
    OR ("currency" <> 'EUR'
      AND "fx_rate_micro" IS NOT NULL AND "fx_rate_micro" > 0
      AND "fx_rate_date" IS NOT NULL AND "fx_source" IS NOT NULL)
  );
-- La fecha de la tasa es la del devengo o la ÚLTIMA ANTERIOR (C-4: RC-14 no
-- aplica, la factura hay que emitirla igual). Nunca posterior al devengo.
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_tasa_no_posterior_al_devengo"
  CHECK ("fx_rate_date" IS NULL OR "fx_rate_date" <= "operation_date");
-- Art. 11 RD 1619/2012: la expedición nunca precede al devengo.
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_expedicion_no_anterior_al_devengo"
  CHECK ("issued_at" >= "operation_date");
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_periodo_coherente"
  CHECK ("period_end" IS NULL OR "period_start" IS NULL OR "period_end" >= "period_start");
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_iva_period_canonico"
  CHECK ("iva_period" ~ '^[0-9]{4}-Q[1-4]$');
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_pais_iso"
  CHECK ("customer_country" ~ '^[A-Z]{2}$');
-- Σ: el total es base + cuota. Tolerancia CERO.
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_total_cuadrado"
  CHECK ("total_cents" = "subtotal_cents" + "tax_cents");
-- **C-1 / O-15** · el régimen no es una etiqueta decorativa:
--   · Sólo `REPERCUTIDO_ES` puede llevar cuota. En los tres tratamientos de no
--     sujeción la cuota es 0 por definición — no hay IVA español que repercutir.
--   · La no sujeción por localización UE exige NIF-IVA **y su prueba fechada**:
--     con VIES caído o NIF inválido se repercute el 21 % y nunca se presume (R-5).
--   · Y exige la mención impresa (art. 6.1.m RD 1619/2012).
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_regimen_coherente"
  CHECK (
    ("tax_treatment" = 'REPERCUTIDO_ES' AND "customer_country" = 'ES')
    OR ("tax_treatment" <> 'REPERCUTIDO_ES' AND "tax_cents" = 0 AND "tax_cents_eur" = 0)
  );
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_no_sujecion_ue_probada"
  CHECK (
    "tax_treatment" <> 'NO_SUJETO_LOCALIZACION_UE'
    OR ("vat_number" IS NOT NULL
        AND "vat_validated_at" IS NOT NULL
        AND "vat_validation_source" IS NOT NULL
        AND "reverse_charge_mention" IS NOT NULL)
  );
-- Art. 15 RD 1619/2012: la rectificativa lleva serie específica, referencia
-- inequívoca a la rectificada, causa y modo. Las cuatro cosas, o ninguna.
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_rectificativa_completa"
  CHECK (
    ("rectifies_invoice_id" IS NULL AND "rectification_cause" IS NULL AND "rectification_mode" IS NULL)
    OR ("rectifies_invoice_id" IS NOT NULL AND "rectification_cause" IS NOT NULL
        AND "rectification_mode" IS NOT NULL)
  );

-- Y la pieza que el CHECK no puede ver: una rectificativa tiene que vivir en una
-- serie RECTIFICATIVA, y una ordinaria en una ORDINARIA. Es un trigger porque el
-- `kind` está en la otra tabla.
CREATE OR REPLACE FUNCTION app.platform_invoice_serie_coherente()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_kind "invoice_series_kind";
BEGIN
  SELECT s."kind" INTO v_kind FROM "platform_invoice_series" s WHERE s."id" = NEW."series_id";
  IF NEW."rectifies_invoice_id" IS NOT NULL AND v_kind <> 'RECTIFICATIVA' THEN
    RAISE EXCEPTION 'I-E11-13: una factura rectificativa exige serie RECTIFICATIVA (art. 15.4 RD 1619/2012); la serie % es %',
      NEW."series_id", v_kind;
  END IF;
  IF NEW."rectifies_invoice_id" IS NULL AND v_kind <> 'ORDINARIA' THEN
    RAISE EXCEPTION 'I-E11-13: la serie RECTIFICATIVA solo admite facturas que rectifiquen a otra';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "platform_invoices_serie_coherente"
  BEFORE INSERT OR UPDATE OF "series_id", "rectifies_invoice_id" ON "platform_invoices"
  FOR EACH ROW EXECUTE FUNCTION app.platform_invoice_serie_coherente();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. La puerta de numeración: `SECURITY DEFINER` acotada al webhook (§9.5)
--
--    `platform_invoice_series` es catálogo GLOBAL con escritura cerrada a
--    `app_runtime`. La serie la mueve ESTA función y sólo ésta: reserva el
--    siguiente número **con `FOR UPDATE`** sobre la fila de la serie, igual que
--    `nextInvoiceNumberTx` hace con la del cliente (models/invoices.ts).
--
--    El bloqueo serializa a los emisores concurrentes: dos webhooks a la vez
--    obtienen números distintos y consecutivos, y el segundo espera al COMMIT
--    del primero. Sin él, dos lecturas del mismo contador producen la misma
--    factura dos veces — el error que ninguna inspección perdona.
--
--    Debe invocarse DENTRO de la transacción que inserta la factura: si ésta
--    revierte, el número vuelve atrás y **no queda hueco** (I-E11-13).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.next_platform_invoice_number(p_series_code text)
RETURNS TABLE (series_id uuid, series_code text, series_kind text, prefix text, number integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE r record;
BEGIN
  SELECT s."id", s."code", s."kind", s."prefix", s."last_number"
    INTO r
    FROM "platform_invoice_series" s
   WHERE s."code" = p_series_code
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No existe la serie de plataforma %', p_series_code;
  END IF;

  UPDATE "platform_invoice_series"
     SET "last_number" = r."last_number" + 1
   WHERE "id" = r."id";

  series_id   := r."id";
  series_code := r."code";
  series_kind := r."kind"::text;
  prefix      := r."prefix";
  number      := r."last_number" + 1;
  RETURN NEXT;
END
$fn$;

ALTER FUNCTION app.next_platform_invoice_number(text) OWNER TO app_maintenance;
REVOKE ALL ON FUNCTION app.next_platform_invoice_number(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.next_platform_invoice_number(text) TO app_runtime;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RLS y privilegios
--
--    `platform_invoices` es de TENANT (el cliente ve SUS facturas) → entra en
--    `TENANT_MODELS`. `platform_invoice_series` es catálogo GLOBAL: patrón de
--    `exchange_rates` / `plans`, con la excepción de la puerta de §3.
--
--    **Una factura emitida no se borra ni se renumera: se rectifica.** El
--    append-only lo sostienen el `REVOKE` y la política RESTRICTIVE, no la
--    buena voluntad del código.
-- ─────────────────────────────────────────────────────────────────────────────

SELECT app.enforce_tenant_rls('platform_invoices');

REVOKE DELETE ON "platform_invoices" FROM app_runtime;
-- Semi-append-only (patrón `budgets`, E10 M2): el estado de cobro y el
-- `stored_object_id` del PDF conservado llegan DESPUÉS del `invoice.finalized`.
-- Ni el número, ni la serie, ni las fechas, ni las cifras, ni el régimen fiscal.
GRANT SELECT, INSERT ON "platform_invoices" TO app_runtime;
GRANT UPDATE ("status", "stored_object_id", "hosted_invoice_url")
  ON "platform_invoices" TO app_runtime;
CREATE POLICY "platform_invoices_no_delete" ON "platform_invoices"
  AS RESTRICTIVE FOR DELETE USING (false);
GRANT SELECT, INSERT, UPDATE, DELETE ON "platform_invoices" TO app_maintenance;

ALTER TABLE "platform_invoice_series" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "platform_invoice_series_read" ON "platform_invoice_series" FOR SELECT USING (true);
CREATE POLICY "platform_invoice_series_no_insert" ON "platform_invoice_series"
  AS RESTRICTIVE FOR INSERT WITH CHECK (false);
CREATE POLICY "platform_invoice_series_no_update" ON "platform_invoice_series"
  AS RESTRICTIVE FOR UPDATE USING (false);
CREATE POLICY "platform_invoice_series_no_delete" ON "platform_invoice_series"
  AS RESTRICTIVE FOR DELETE USING (false);
ALTER TABLE "platform_invoice_series" FORCE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON "platform_invoice_series" FROM app_runtime;
GRANT SELECT ON "platform_invoice_series" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "platform_invoice_series" TO app_maintenance;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Siembra de las DOS series, bajo el baile NO FORCE → siembra → FORCE
--
--    Nacen con `last_number = 0`: I-E11-13 queda en INFO hasta la primera
--    factura, que es su contrato (igual que I-E8-20 con las del cliente).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "platform_invoice_series" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "platform_invoice_series" ("id", "code", "kind", "prefix", "last_number") VALUES
  ('0e11a5e0-0000-4000-8000-000000000001'::uuid, 'PLT',   'ORDINARIA',     'PLT-2026-',   0),
  ('0e11a5e0-0000-4000-8000-000000000002'::uuid, 'PLT-R', 'RECTIFICATIVA', 'PLT-R-2026-', 0);

ALTER TABLE "platform_invoice_series" FORCE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Verificación: ninguna tabla queda en NO FORCE (ADR-0009 §7)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['platform_invoice_series', 'platform_invoices'] LOOP
    IF NOT (SELECT relforcerowsecurity FROM pg_class WHERE relname = t) THEN
      RAISE EXCEPTION '% ha quedado en NO FORCE ROW LEVEL SECURITY', t;
    END IF;
  END LOOP;
END $$;
