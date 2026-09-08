-- E9 · T4 — M4: el cierre como acto sellado, la distribución del resultado, las
-- columnas nuevas de las tablas existentes y las tres siembras.
-- (docs/design/E9-cierre-recurrentes.md §3.2, §3.3 y §3.5, ADR-0016 D1/D10/D12.)
--
-- Ejecutable por un rol NO superusuario. Todo lo aditivo lleva default, así que
-- ninguna columna nueva rompe una fila existente.
--
-- PATRÓN DE BACKFILL: NO FORCE → DML → FORCE, con la marca ANTES cuando el DML
-- convierte valores. Aquí las tres siembras son INSERT idempotentes por
-- `NOT EXISTS`, así que no necesitan marca: repetirlas no duplica nada.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. `closing_runs` — el cierre con su checklist y su sello
--    APPEND-ONLY SALVO `status`, `steps`, `seal`, `seal_reasons`, `duration_ms`,
--    las columnas de los doce asientos y las de reapertura, por GRANT UPDATE de
--    columna (patrón de `journal_entries.voided_*`). El cierre AVANZA: nace
--    BORRADOR, se comprueba, se postea y se sella.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "closing_runs" (
  "id"                        uuid                 NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"           uuid                 NOT NULL,
  "fiscal_year_id"            uuid                 NOT NULL,
  "status"                    "closing_run_status" NOT NULL DEFAULT 'BORRADOR',
  "ref_date"                  date                 NOT NULL,
  -- O-29: los 41 pasos en nueve bloques.
  "steps"                     jsonb                NOT NULL,
  "ledger_hash"               char(64)             NOT NULL,
  "plan_hash"                 char(64)             NOT NULL,
  "account_map_hash"          char(64)             NOT NULL,
  "config_hash"               char(64)             NOT NULL,
  "git_sha"                   text                 NOT NULL,
  "invariant_run_id"          uuid,
  -- Los doce asientos del cierre, en el orden de O-17.
  "recurring_entry_ids"       jsonb                NOT NULL DEFAULT '[]',
  "recc_accrual_entry_id"     uuid,
  "prorrata_entry_id"         uuid,
  "vat_settlement_entry_id"   uuid,
  "present_value_entry_id"    uuid,
  "fx_entry_id"               uuid,
  "reclass_entry_id"          uuid,
  "income_tax_entry_id"       uuid,
  "regularizacion_entry_id"   uuid,
  "cierre_entry_id"           uuid,
  "apertura_entry_id"         uuid,
  "reclass_reversal_entry_id" uuid,
  "seal"                      "seal"               NOT NULL,
  "seal_reasons"              jsonb                NOT NULL DEFAULT '[]',
  "duration_ms"               integer              NOT NULL,
  "closed_at"                 timestamp(3),
  "closed_by_id"              uuid,
  -- O-21: la reapertura revierte T-28 → T-27 → T-26 → T-25.
  "reopened_at"               timestamp(3),
  "reopened_by_id"            uuid,
  "reopen_reason"             varchar(512),
  "reopen_entry_ids"          jsonb                NOT NULL DEFAULT '[]',
  "created_at"                timestamp(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "closing_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "closing_runs_organization_id_id_key" ON "closing_runs" ("organization_id", "id");
CREATE INDEX "closing_runs_org_fy_created_idx"
  ON "closing_runs" ("organization_id", "fiscal_year_id", "created_at" DESC);

-- G-12. Un cierre CERRADO vivo por ejercicio, índice único PARCIAL: reabrir y
-- volver a cerrar tiene que ser posible (D1), y con un `UNIQUE` a secas el
-- segundo cierre chocaría contra el primero, ya reabierto.
CREATE UNIQUE INDEX "closing_runs_one_closed_per_fiscal_year"
  ON "closing_runs" ("organization_id", "fiscal_year_id")
  WHERE "status" = 'CERRADO';

ALTER TABLE "closing_runs"
  ADD CONSTRAINT "closing_runs_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "closing_runs_fiscal_year_fkey"
    FOREIGN KEY ("organization_id", "fiscal_year_id")
    REFERENCES "fiscal_years"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "closing_runs_invariant_run_fkey"
    FOREIGN KEY ("organization_id", "invariant_run_id")
    REFERENCES "invariant_runs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "closing_runs"
  ADD CONSTRAINT "closing_runs_steps_array"        CHECK (jsonb_typeof("steps") = 'array'),
  ADD CONSTRAINT "closing_runs_seal_reasons_array" CHECK (jsonb_typeof("seal_reasons") = 'array'),
  ADD CONSTRAINT "closing_runs_recurring_ids_array" CHECK (jsonb_typeof("recurring_entry_ids") = 'array'),
  ADD CONSTRAINT "closing_runs_reopen_ids_array"   CHECK (jsonb_typeof("reopen_entry_ids") = 'array'),
  ADD CONSTRAINT "closing_runs_duration_nonneg"    CHECK ("duration_ms" >= 0),
  -- Un cierre CERRADO tiene fecha de cierre y los cuatro asientos estructurales
  -- del final del orden de O-17; uno que no lo está, ninguna de las dos cosas.
  ADD CONSTRAINT "closing_runs_closed_coherent"
    CHECK (("status" IN ('CERRADO', 'REABIERTO')) = ("closed_at" IS NOT NULL)),
  -- O-21: la reapertura deja SIEMPRE motivo. Sin él, `AuditLog` recoge que
  -- alguien reabrió un ejercicio y no por qué, que es no recoger nada.
  ADD CONSTRAINT "closing_runs_reopen_coherent"
    CHECK (("status" = 'REABIERTO') = ("reopened_at" IS NOT NULL)),
  ADD CONSTRAINT "closing_runs_reopen_reason"
    CHECK ("reopened_at" IS NULL OR ("reopen_reason" IS NOT NULL AND length(btrim("reopen_reason")) >= 10));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. `profit_distributions` — O-18, la distribución acordada por la junta
--    Sin ella, `129` se arrastra indefinidamente, la reserva legal no se dota
--    (art. 274 LSC) y el patrimonio neto es incorrecto desde el segundo
--    ejercicio. No es un extra: es el asiento que cierra el ciclo societario.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "profit_distributions" (
  "id"                       uuid         NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"          uuid         NOT NULL,
  "fiscal_year_id"           uuid         NOT NULL,
  -- Fecha de la junta. El asiento se postea con ella, en el ejercicio ABIERTO
  -- (art. 164 LSC: dentro de los seis meses siguientes al cierre).
  "meeting_date"             date         NOT NULL,
  "result_cents"             bigint       NOT NULL,
  "legal_reserve_cents"      bigint       NOT NULL DEFAULT 0,
  "voluntary_reserve_cents"  bigint       NOT NULL DEFAULT 0,
  "carry_forward_cents"      bigint       NOT NULL DEFAULT 0,
  "dividend_cents"           bigint       NOT NULL DEFAULT 0,
  "interim_dividend_cents"   bigint       NOT NULL DEFAULT 0,
  "loss_carry_forward_cents" bigint       NOT NULL DEFAULT 0,
  "entry_id"                 uuid         NOT NULL,
  "approved_at"              timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approved_by_id"           uuid,
  CONSTRAINT "profit_distributions_pkey" PRIMARY KEY ("id")
);

-- G-16: una distribución por ejercicio. El resultado de 2026 se reparte una vez.
CREATE UNIQUE INDEX "profit_distributions_org_fiscal_year_key"
  ON "profit_distributions" ("organization_id", "fiscal_year_id");
CREATE UNIQUE INDEX "profit_distributions_organization_id_id_key"
  ON "profit_distributions" ("organization_id", "id");

ALTER TABLE "profit_distributions"
  ADD CONSTRAINT "profit_distributions_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "profit_distributions_fiscal_year_fkey"
    FOREIGN KEY ("organization_id", "fiscal_year_id")
    REFERENCES "fiscal_years"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "profit_distributions_entry_fkey"
    FOREIGN KEY ("organization_id", "entry_id")
    REFERENCES "journal_entries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- G-16. `Σ destinos = result_cents`, CON SIGNO y con el dividendo a cuenta
-- restando: `557` ya se satisfizo durante el ejercicio y se cancela contra el
-- resultado en esta misma distribución. Un beneficio se reparte entre reservas,
-- remanente y dividendo; una pérdida va a `121`. Los destinos no son negativos:
-- el signo lo lleva el resultado, no cada línea.
ALTER TABLE "profit_distributions"
  ADD CONSTRAINT "profit_distributions_amounts_nonneg" CHECK (
    "legal_reserve_cents" >= 0 AND "voluntary_reserve_cents" >= 0
    AND "carry_forward_cents" >= 0 AND "dividend_cents" >= 0
    AND "interim_dividend_cents" >= 0 AND "loss_carry_forward_cents" >= 0
  ),
  ADD CONSTRAINT "profit_distributions_sum_matches_result" CHECK (
    "result_cents" =
      "legal_reserve_cents" + "voluntary_reserve_cents" + "carry_forward_cents"
      + "dividend_cents" + "interim_dividend_cents" - "loss_carry_forward_cents"
  ),
  -- Una pérdida no dota reservas ni reparte dividendo (art. 273 LSC).
  ADD CONSTRAINT "profit_distributions_loss_only_to_121" CHECK (
    "result_cents" >= 0 OR (
      "legal_reserve_cents" = 0 AND "voluntary_reserve_cents" = 0
      AND "carry_forward_cents" = 0 AND "dividend_cents" = 0
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Columnas nuevas en tablas existentes (§3.2), todas aditivas con default
-- ─────────────────────────────────────────────────────────────────────────────

-- 3.a `fiscal_years`: el estado SOCIETARIO (D1) y el del modelo 200 (Q-1.2).
--     `status` sigue siendo el contable; son cosas distintas y confundirlas es
--     lo que permite «reabrir» un ejercicio cuyas cuentas ya están depositadas.
ALTER TABLE "fiscal_years"
  ADD COLUMN "accounts_approval_status" "accounts_approval_status" NOT NULL DEFAULT 'BORRADOR',
  ADD COLUMN "formulated_at"            timestamp(3),
  ADD COLUMN "approved_at"              timestamp(3),
  ADD COLUMN "deposited_at"             timestamp(3),
  ADD COLUMN "tax_filing_status"        "tax_filing_status" NOT NULL DEFAULT 'NO_PRESENTADO';

-- El estado societario AVANZA y no retrocede solo: cada escalón tiene su fecha,
-- y sin fecha no se puede acreditar cuándo se formuló o se depositó.
ALTER TABLE "fiscal_years"
  ADD CONSTRAINT "fiscal_years_approval_dates_coherent" CHECK (
    ("accounts_approval_status" = 'BORRADOR'   AND "formulated_at" IS NULL
       AND "approved_at" IS NULL AND "deposited_at" IS NULL) OR
    ("accounts_approval_status" = 'FORMULADAS' AND "formulated_at" IS NOT NULL
       AND "approved_at" IS NULL AND "deposited_at" IS NULL) OR
    ("accounts_approval_status" = 'APROBADAS'  AND "formulated_at" IS NOT NULL
       AND "approved_at" IS NOT NULL AND "deposited_at" IS NULL) OR
    ("accounts_approval_status" = 'DEPOSITADAS' AND "formulated_at" IS NOT NULL
       AND "approved_at" IS NOT NULL AND "deposited_at" IS NOT NULL)
  );

-- 3.b `organizations`: valoración (O-1, O-2) y la contingencia de R2-2.
ALTER TABLE "organizations"
  ADD COLUMN "discount_rate_monthly_micro_bps" integer,
  ADD COLUMN "pv_materiality_cents"            bigint NOT NULL DEFAULT 0,
  ADD COLUMN "capital_stock_override_cents"    bigint;

ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_discount_rate_nonneg"
    CHECK ("discount_rate_monthly_micro_bps" IS NULL OR "discount_rate_monthly_micro_bps" >= 0),
  ADD CONSTRAINT "organizations_pv_materiality_nonneg" CHECK ("pv_materiality_cents" >= 0),
  ADD CONSTRAINT "organizations_capital_override_positive"
    CHECK ("capital_stock_override_cents" IS NULL OR "capital_stock_override_cents" > 0);

-- 3.c `counterparties`: D8. Un proveedor en RECC difiere MI deducción (art. 163
--     terdecies): la dirección que se olvida y la que la Inspección comprueba.
ALTER TABLE "counterparties"
  ADD COLUMN "iva_regime" "iva_regime" NOT NULL DEFAULT 'GENERAL';

-- 3.d `transactions` / `extraction_runs`: la clave de operación del libro
--     registro (O-10) y los cobros/pagos del art. 61 decies y undecies RIVA
--     (O-14). Sin fechas, importes y medio empleado, el libro de RECC no cumple.
ALTER TABLE "transactions"
  ADD COLUMN "vat_operation_key" varchar(16),
  ADD COLUMN "recc_payments"     jsonb NOT NULL DEFAULT '[]';

ALTER TABLE "extraction_runs"
  ADD COLUMN "vat_operation_key" varchar(16),
  ADD COLUMN "recc_payments"     jsonb NOT NULL DEFAULT '[]';

-- Vocabulario CERRADO: con texto libre, una errata en la clave de operación
-- deja el documento fuera del numerador de la prorrata sin que nadie lo vea.
ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_vat_operation_key_vocab"
    CHECK ("vat_operation_key" IS NULL OR "vat_operation_key" IN
           ('GENERAL', 'ISP', 'AIB', 'EXENTA_25', 'EXPORTACION', 'NO_SUJETA')),
  ADD CONSTRAINT "transactions_recc_payments_array" CHECK (jsonb_typeof("recc_payments") = 'array');

ALTER TABLE "extraction_runs"
  ADD CONSTRAINT "extraction_runs_vat_operation_key_vocab"
    CHECK ("vat_operation_key" IS NULL OR "vat_operation_key" IN
           ('GENERAL', 'ISP', 'AIB', 'EXENTA_25', 'EXPORTACION', 'NO_SUJETA')),
  ADD CONSTRAINT "extraction_runs_recc_payments_array" CHECK (jsonb_typeof("recc_payments") = 'array');

-- 3.e `accounts.is_monetary` — O-4. NRV 11ª.2.2: sólo las partidas MONETARIAS
--     se convierten al tipo de cierre. Sin el atributo,
--     `original_currency IS NOT NULL` arrastraba `407` y `438` —anticipos, que
--     NO son monetarios— e inventaba resultado. Es un dato del PLAN, no una
--     lista de códigos en el motor, y se edita con `AuditLog`.
ALTER TABLE "accounts" ADD COLUMN "is_monetary" boolean NOT NULL DEFAULT false;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RLS estricta y privilegios de las dos tablas nuevas
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['closing_runs', 'profit_distributions'] LOOP
    PERFORM app.enforce_tenant_rls(t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON "closing_runs", "profit_distributions" TO app_maintenance;

-- OJO: `ALTER DEFAULT PRIVILEGES` de esta base concede `arwd` a `app_runtime`
-- sobre TODA tabla nueva, así que un `GRANT SELECT, INSERT` no acota nada: hay
-- que REVOCAR primero. Sin este `REVOKE`, el append-only de la distribución y el
-- GRANT de columna del cierre serían decorativos y la prueba de privilegio
-- pasaría por vacuidad.
REVOKE UPDATE, DELETE ON "closing_runs", "profit_distributions" FROM app_runtime;
GRANT SELECT, INSERT ON "closing_runs", "profit_distributions" TO app_runtime;

-- `closing_runs` avanza por GRANT de columna; nada más se puede reescribir.
GRANT UPDATE ("status", "steps", "seal", "seal_reasons", "duration_ms",
              "invariant_run_id", "recurring_entry_ids",
              "recc_accrual_entry_id", "prorrata_entry_id", "vat_settlement_entry_id",
              "present_value_entry_id", "fx_entry_id", "reclass_entry_id",
              "income_tax_entry_id", "regularizacion_entry_id", "cierre_entry_id",
              "apertura_entry_id", "reclass_reversal_entry_id",
              "closed_at", "closed_by_id",
              "reopened_at", "reopened_by_id", "reopen_reason", "reopen_entry_ids")
  ON "closing_runs" TO app_runtime;
CREATE POLICY "closing_runs_no_delete" ON "closing_runs" AS RESTRICTIVE FOR DELETE USING (false);

-- La distribución es un HECHO societario: se acuerda una vez y se contabiliza.
-- Append-only con las dos cerraduras.
CREATE POLICY "profit_distributions_no_update" ON "profit_distributions" AS RESTRICTIVE FOR UPDATE USING (false);
CREATE POLICY "profit_distributions_no_delete" ON "profit_distributions" AS RESTRICTIVE FOR DELETE USING (false);

CREATE OR REPLACE FUNCTION app.closing_runs_immutable_seal()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."id"               IS DISTINCT FROM OLD."id"
     OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
     OR NEW."fiscal_year_id"  IS DISTINCT FROM OLD."fiscal_year_id"
     OR NEW."ref_date"        IS DISTINCT FROM OLD."ref_date"
     OR NEW."ledger_hash"     IS DISTINCT FROM OLD."ledger_hash"
     OR NEW."plan_hash"       IS DISTINCT FROM OLD."plan_hash"
     OR NEW."account_map_hash" IS DISTINCT FROM OLD."account_map_hash"
     OR NEW."config_hash"     IS DISTINCT FROM OLD."config_hash"
     OR NEW."git_sha"         IS DISTINCT FROM OLD."git_sha"
     OR NEW."created_at"      IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'closing_runs: los cinco sellos y la identidad del cierre son INMUTABLES (E9, D1)'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER "closing_runs_immutable_seal_update"
  BEFORE UPDATE ON "closing_runs"
  FOR EACH ROW EXECUTE FUNCTION app.closing_runs_immutable_seal();

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. SIEMBRA 1 — `accounts.is_monetary` (O-4, §3.5)
--
--    Monetarias: 17x, 40x, 41x, 43x, 44x, 46x, 52x, 53x, 54x, 55x, 57x y las
--    fianzas y depósitos de 18x/26x.
--    NO monetarias: 20x, 21x, 3xx y, dentro de las anteriores, `407` y `438`
--    —anticipos: dan derecho a recibir un BIEN, no una cantidad fija de dinero
--    (NRV 11ª.2.2)—, `480` y `485`.
--
--    OJO CON LA RLS: `accounts` lleva FORCE, así que el propietario TAMPOCO
--    esquiva la política y un `UPDATE` sin el baile NO FORCE → … → FORCE vería
--    CERO filas y saldría verde sin haber sembrado nada. Es lo que le pasó a la
--    siembra de claves de `20260916100000_e7_auditoria` §9, que hace el JOIN
--    contra `accounts` con FORCE puesto: queda anotado para que se corrija en su
--    épica, aquí se hace bien.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "accounts" NO FORCE ROW LEVEL SECURITY;

UPDATE "accounts"
   SET "is_monetary" = true
 WHERE (
        "code" LIKE '17%' OR "code" LIKE '40%' OR "code" LIKE '41%'
     OR "code" LIKE '43%' OR "code" LIKE '44%' OR "code" LIKE '46%'
     OR "code" LIKE '52%' OR "code" LIKE '53%' OR "code" LIKE '54%'
     OR "code" LIKE '55%' OR "code" LIKE '57%'
     -- Fianzas y depósitos constituidos o recibidos: derecho u obligación por
     -- una cantidad FIJA de dinero, luego monetarios.
     OR "code" LIKE '180%' OR "code" LIKE '181%' OR "code" LIKE '185%' OR "code" LIKE '186%'
     OR "code" LIKE '260%' OR "code" LIKE '265%' OR "code" LIKE '266%'
   )
   AND "code" NOT LIKE '407%'   -- anticipos a proveedores
   AND "code" NOT LIKE '438%'   -- anticipos de clientes
   AND "is_monetary" = false;

ALTER TABLE "accounts" FORCE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. SIEMBRA 2 — los pares de reclasificación (O-7, R2-1, §4.5 R-RC-7)
--
--    Sólo donde AMBAS cuentas existan y sean postables en el plan de esa
--    organización; en el resto, WARN de Auditoría, nunca un fallo de migración.
--
--    Tres precisiones de la re-validación que la ronda 1 tenía mal: `176` va a
--    `5595` —no a `526`, que es dividendo activo a pagar y no tiene nada que
--    ver—; `177` va a `500`, y faltaba; y `514`, `527` y `528` NO forman par
--    —los dos últimos son intereses a corto plazo de deudas ya reclasificadas y
--    reclasificarlos duplicaría el pasivo corriente por su importe—.
--
--    NOTA DE DISCREPANCIA CON EL DISEÑO: §4.5 R-RC-7 los llama «veintitrés» pero
--    la tabla enumera VEINTIDÓS (6 + 4 + 6 + 6). Se siembran los veintidós
--    listados; inventar un par número veintitrés para cuadrar un recuento sería
--    sembrar una reclasificación que nadie ha validado. Queda anotado para T26.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "accounts" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "reclassification_pairs" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "reclassification_pairs" ("id", "organization_id", "long_account_code", "short_account_code")
SELECT gen_random_uuid(), l."organization_id", p."largo", p."corto"
  FROM (VALUES
    -- Los seis del PGC ya previstos
    ('170', '520'), ('171', '521'), ('173', '523'), ('174', '524'),
    ('252', '542'), ('253', '543'),
    -- Partes vinculadas
    ('160', '510'), ('161', '511'), ('162', '512'), ('163', '513'),
    -- Resto de deuda
    ('172', '522'), ('175', '525'), ('176', '5595'), ('177', '500'),
    ('180', '560'), ('185', '561'),
    -- Inversiones financieras
    ('250', '540'), ('251', '541'), ('254', '544'), ('258', '548'),
    ('260', '565'), ('265', '566')
  ) AS p("largo", "corto")
  JOIN "accounts" l ON l."code" = p."largo" AND l."is_postable" AND l."is_active"
  JOIN "accounts" s ON s."code" = p."corto" AND s."is_postable" AND s."is_active"
                   AND s."organization_id" = l."organization_id"
 WHERE NOT EXISTS (
   SELECT 1 FROM "reclassification_pairs" r
    WHERE r."organization_id" = l."organization_id"
      AND r."long_account_code" = p."largo"
      AND r."short_account_code" = p."corto"
 );

ALTER TABLE "reclassification_pairs" FORCE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. SIEMBRA 3 — las `AccountKey` nuevas (§3.2), sólo donde la cuenta exista y
--    sea postable. Las que no resuelven quedan sin mapear: WARN de Auditoría,
--    igual que `523` en E8 y las tres de E7.
--
--    `4728`/`4778` y `47513` NO se crean aquí: colgar `4728` de `472` dejaría
--    `472` sin ser postable y arrastraría a TODAS las claves que apuntan a ella
--    —el mismo efecto que documentan las cuentas de software en
--    `lib/accounts/map.ts`—. Se crean cuando la organización activa el RECC o el
--    modelo 123, que es cuando hacen falta y cuando se puede remapear a la vez.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "organization_account_maps" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "organization_account_maps" ("id", "organization_id", "key", "account_code", "created_at", "updated_at")
SELECT gen_random_uuid(), a."organization_id", k."key"::"account_key", a."code",
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM (VALUES
    ('AJUSTE_PRORRATA_NEGATIVO',    '634'),
    ('AJUSTE_PRORRATA_POSITIVO',    '639'),
    ('ARANCELES',                   '600'),
    ('DEUDA_LARGO_INMOVILIZADO',    '173'),
    ('BENEFICIO_BAJA_INMOVILIZADO', '771'),
    ('PERDIDA_BAJA_INMOVILIZADO',   '671'),
    ('CREDITO_ENAJENACION_CP',      '543'),
    ('CREDITO_ENAJENACION_LP',      '253'),
    ('INGRESOS_CREDITOS',           '762'),
    ('IMPUESTO_CORRIENTE',          '6300'),
    ('RESERVA_LEGAL',               '112'),
    ('RESERVAS_VOLUNTARIAS',        '113'),
    ('DIVIDENDO_ACTIVO_A_PAGAR',    '526'),
    ('DIVIDENDO_ACTIVO_A_CUENTA',   '557'),
    ('IRPF_A_PAGAR_111',            '47510'),
    ('IRPF_A_PAGAR_115',            '47511')
  ) AS k("key", "code")
  JOIN "accounts" a ON a."code" = k."code" AND a."is_postable" AND a."is_active"
 WHERE NOT EXISTS (
   SELECT 1 FROM "organization_account_maps" m
    WHERE m."organization_id" = a."organization_id" AND m."key" = k."key"::"account_key"
 );

ALTER TABLE "organization_account_maps" FORCE ROW LEVEL SECURITY;
ALTER TABLE "accounts" FORCE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Verificación: ninguna tabla queda en NO FORCE (ADR-0009 §7)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'closing_runs', 'profit_distributions', 'accounts',
    'reclassification_pairs', 'organization_account_maps'
  ] LOOP
    IF NOT (SELECT relforcerowsecurity FROM pg_class WHERE relname = t) THEN
      RAISE EXCEPTION '% ha quedado en NO FORCE ROW LEVEL SECURITY', t;
    END IF;
  END LOOP;
END $$;
