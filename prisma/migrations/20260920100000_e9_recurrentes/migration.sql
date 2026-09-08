-- E9 · T4 — M2: recurrentes, inmovilizado, periodificaciones y deuda con cuadro
-- (docs/design/E9-cierre-recurrentes.md §3.2 y §3.3, ADR-0016 D2/D3/D11).
--
-- Aditiva pura y ejecutable por un rol NO superusuario (CLAUDE.md): ni un
-- `ALTER ROLE`, ni un `OWNER TO`, ni una extensión nueva. Los valores de enum
-- que usa se añadieron en `20260920090000_e9_enums`, que va aparte por exigencia
-- de `ALTER TYPE`.
--
-- Las siete tablas nacen con FK COMPUESTA por tenant `(organization_id, <id>)`,
-- dinero en `bigint` (ADR-0015 D1), fechas de negocio en `date` y RLS estricta
-- por `app.enforce_tenant_rls` (ADR-0009). No hay backfill: ninguna tabla tiene
-- datos previos (§3.5).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. `fixed_assets` — el activo. El CUADRO no se almacena (§3.6): es función
--    pura de `(FixedAsset, AssetRevision[])` y se sella con `schedule_hash`.
--    Almacenarlo crearía una segunda verdad que se desincroniza a la primera
--    revisión de vida útil y obligaría a reescribir filas que ya respaldan
--    asientos.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "fixed_assets" (
  "id"                        uuid                  NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"           uuid                  NOT NULL,
  "code"                      varchar(32)           NOT NULL,
  "name"                      varchar(160)          NOT NULL,
  -- Las tres cuentas salen del plan de la organización y se validan (postables
  -- y activas). NUNCA hardcodeadas.
  "asset_account_code"        varchar(12)           NOT NULL,
  "accumulated_account_code"  varchar(12)           NOT NULL,
  "expense_account_code"      varchar(12)           NOT NULL,
  "acquisition_date"          date                  NOT NULL,
  -- Puesta en condiciones de funcionamiento (NRV 2ª.1 y 3ª), no la factura.
  "in_service_date"           date                  NOT NULL,
  "acquisition_cost_cents"    bigint                NOT NULL,
  "residual_value_cents"      bigint                NOT NULL DEFAULT 0,
  "method"                    "depreciation_method" NOT NULL DEFAULT 'LINEAL',
  "useful_life_months"        integer               NOT NULL,
  -- O-12: bien de inversión del art. 108 LIVA. Gobierna la guardia de
  -- regularización del art. 107.
  "is_capital_good"           boolean               NOT NULL DEFAULT false,
  "acquisition_prorrata_bps"  integer,
  "project_id"                uuid,
  "cost_center_id"            uuid,
  "status"                    "asset_status"        NOT NULL DEFAULT 'EN_USO',
  "disposal_date"             date,
  "disposal_entry_id"         uuid,
  "entry_id"                  uuid,
  "transaction_id"            uuid,
  "file_id"                   uuid,
  "schedule_hash"             char(64)              NOT NULL,
  "created_at"                timestamp(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                timestamp(3)          NOT NULL,
  CONSTRAINT "fixed_assets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "fixed_assets_organization_id_code_key" ON "fixed_assets" ("organization_id", "code");
CREATE UNIQUE INDEX "fixed_assets_organization_id_id_key"   ON "fixed_assets" ("organization_id", "id");
CREATE INDEX "fixed_assets_organization_id_status_idx"      ON "fixed_assets" ("organization_id", "status");

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. `asset_revisions` — cambio de ESTIMACIÓN (NRV 22ª), prospectivo.
--    APPEND-ONLY: una revisión es un hecho fechado. O-1: reconocer tarde el
--    valor actual NO es un cambio de estimación sino la corrección de un error,
--    y no usa esta tabla.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "asset_revisions" (
  "id"                       uuid         NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"          uuid         NOT NULL,
  "fixed_asset_id"           uuid         NOT NULL,
  "effective_from"           date         NOT NULL,
  "new_useful_life_months"   integer,
  "new_residual_value_cents" bigint,
  "added_cost_cents"         bigint,
  "reason"                   varchar(512) NOT NULL,
  "created_at"               timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by_id"            uuid,
  CONSTRAINT "asset_revisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "asset_revisions_org_asset_effective_key"
  ON "asset_revisions" ("organization_id", "fixed_asset_id", "effective_from");

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. `debt_schedules` / `debt_installments` — O-6, la pieza que faltaba.
--    EXCEPCIÓN DECLARADA a §3.6: el cuadro de la deuda SÍ se persiste. No es
--    derivable de la deuda; es un dato del contrato que el banco entrega, y es
--    precisamente su ausencia lo que deja el balance presentando CERO en
--    «Deudas con entidades de crédito a corto plazo» teniendo préstamos vivos.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "debt_schedules" (
  "id"                     uuid         NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"        uuid         NOT NULL,
  "code"                   varchar(32)  NOT NULL,
  "name"                   varchar(160) NOT NULL,
  -- Par largo/corto de la deuda; se valida contra `reclassification_pairs` (M4).
  "long_account_code"      varchar(12)  NOT NULL,
  "short_account_code"     varchar(12)  NOT NULL,
  "counterparty_id"        uuid,
  "principal_cents"        bigint       NOT NULL,
  "currency"               varchar(3)   NOT NULL DEFAULT 'EUR',
  -- O-2: tipo MENSUAL en punto fijo, misma convención que el descuento. `i/12`
  -- sólo vale para un TIN: convertir un TAE dividiendo entre doce es un error
  -- de valoración que se arrastra a todo el cuadro.
  "monthly_rate_micro_bps" integer,
  "start_date"             date         NOT NULL,
  "entry_id"               uuid,
  "schedule_hash"          char(64)     NOT NULL,
  "created_at"             timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             timestamp(3) NOT NULL,
  CONSTRAINT "debt_schedules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "debt_schedules_organization_id_code_key" ON "debt_schedules" ("organization_id", "code");
CREATE UNIQUE INDEX "debt_schedules_organization_id_id_key"   ON "debt_schedules" ("organization_id", "id");

CREATE TABLE "debt_installments" (
  "id"               uuid   NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"  uuid   NOT NULL,
  "debt_schedule_id" uuid   NOT NULL,
  "seq"              integer NOT NULL,
  "due_date"         date   NOT NULL,
  "principal_cents"  bigint NOT NULL,
  "interest_cents"   bigint NOT NULL,
  CONSTRAINT "debt_installments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "debt_installments_org_schedule_seq_key"
  ON "debt_installments" ("organization_id", "debt_schedule_id", "seq");
CREATE INDEX "debt_installments_org_due_date_idx"
  ON "debt_installments" ("organization_id", "due_date");

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. `accruals` — periodificaciones y devengo de intereses
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "accruals" (
  "id"                   uuid            NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"      uuid            NOT NULL,
  "code"                 varchar(32)     NOT NULL,
  "name"                 varchar(160)    NOT NULL,
  "kind"                 "accrual_kind"  NOT NULL,
  "accrual_account_code" varchar(12)     NOT NULL,
  "pnl_account_code"     varchar(12)     NOT NULL,
  "total_cents"          bigint          NOT NULL,
  "period_start"         date            NOT NULL,
  "period_end"           date            NOT NULL,
  "basis"                "accrual_basis" NOT NULL DEFAULT 'MESES',
  "debt_schedule_id"     uuid,
  "project_id"           uuid,
  "cost_center_id"       uuid,
  "source_entry_id"      uuid,
  "status"               "accrual_status" NOT NULL DEFAULT 'VIVA',
  "schedule_hash"        char(64)        NOT NULL,
  "created_at"           timestamp(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           timestamp(3)    NOT NULL,
  CONSTRAINT "accruals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "accruals_organization_id_code_key" ON "accruals" ("organization_id", "code");
CREATE UNIQUE INDEX "accruals_organization_id_id_key"   ON "accruals" ("organization_id", "id");
CREATE INDEX "accruals_org_status_period_end_idx"       ON "accruals" ("organization_id", "status", "period_end");

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. `recurring_entries` / `recurring_occurrences`
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "recurring_entries" (
  "id"              uuid                NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" uuid                NOT NULL,
  "code"            varchar(32)         NOT NULL,
  "name"            varchar(160)        NOT NULL,
  "kind"            "recurring_kind"    NOT NULL,
  "template_code"   varchar(32)         NOT NULL,
  "template_input"  jsonb               NOT NULL,
  "amount_cents"    bigint,
  "frequency"       "recurrence_freq"   NOT NULL,
  "anchor"          "recurrence_anchor" NOT NULL DEFAULT 'ULTIMO_DIA',
  "day_of_month"    integer,
  -- Vigencia en PERIODOS, no en fechas.
  "start_period"    varchar(8)          NOT NULL,
  "end_period"      varchar(8),
  "status"          "recurring_status"  NOT NULL DEFAULT 'ACTIVA',
  "fixed_asset_id"  uuid,
  "accrual_id"      uuid,
  "created_at"      timestamp(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by_id"   uuid,
  "updated_at"      timestamp(3)        NOT NULL,
  CONSTRAINT "recurring_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "recurring_entries_organization_id_code_key" ON "recurring_entries" ("organization_id", "code");
CREATE UNIQUE INDEX "recurring_entries_organization_id_id_key"   ON "recurring_entries" ("organization_id", "id");
CREATE INDEX "recurring_entries_org_status_frequency_idx"
  ON "recurring_entries" ("organization_id", "status", "frequency");

CREATE TABLE "recurring_occurrences" (
  "id"                 uuid                NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"    uuid                NOT NULL,
  "recurring_entry_id" uuid                NOT NULL,
  "period"             varchar(8)          NOT NULL,
  "posting_date"       date                NOT NULL,
  "status"             "occurrence_status" NOT NULL,
  "reason"             varchar(512),
  "entry_id"           uuid,
  -- sha256 canónico del input EFECTIVO (I-E9-1b): el asiento de marzo no se
  -- explica con la regla de septiembre.
  "input_hash"         char(64)            NOT NULL,
  "generated_at"       timestamp(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "generated_by_id"    uuid,
  CONSTRAINT "recurring_occurrences_pkey" PRIMARY KEY ("id")
);

-- G-1. ESTE índice **ES** la idempotencia: dos generaciones simultáneas no
-- producen dos asientos porque la segunda choca contra el índice, no porque el
-- código mire antes. Un `SELECT … IF NOT EXISTS` en la aplicación es una
-- comprobación con ventana de carrera; un índice único, no.
CREATE UNIQUE INDEX "recurring_occurrences_org_entry_period_key"
  ON "recurring_occurrences" ("organization_id", "recurring_entry_id", "period");
CREATE UNIQUE INDEX "recurring_occurrences_organization_id_id_key"
  ON "recurring_occurrences" ("organization_id", "id");
CREATE INDEX "recurring_occurrences_org_period_idx"
  ON "recurring_occurrences" ("organization_id", "period");

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. FK — compuestas POR TENANT donde el destino es de negocio (O-A1)
--
--    `journal_entries` no tenía todavía índice único `(organization_id, id)`:
--    hasta E9 nadie lo apuntaba por tenant (la FK compuesta iba siempre en la
--    otra dirección). Tres tablas de E9 sí lo hacen —`recurring_occurrences`,
--    `vat_settlements` (M3) y `profit_distributions` (M4)—, y una FK compuesta
--    exige un único que la respalde. Es aditivo: `(organization_id, id)` ya era
--    único de hecho, porque `id` lo es.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "journal_entries_organization_id_id_key"
  ON "journal_entries" ("organization_id", "id");

ALTER TABLE "fixed_assets"
  ADD CONSTRAINT "fixed_assets_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "fixed_assets_project_fkey"
    FOREIGN KEY ("organization_id", "project_id")
    REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "fixed_assets_cost_center_fkey"
    FOREIGN KEY ("organization_id", "cost_center_id")
    REFERENCES "cost_centers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "asset_revisions"
  ADD CONSTRAINT "asset_revisions_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "asset_revisions_fixed_asset_fkey"
    FOREIGN KEY ("organization_id", "fixed_asset_id")
    REFERENCES "fixed_assets"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "debt_schedules"
  ADD CONSTRAINT "debt_schedules_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

ALTER TABLE "debt_installments"
  ADD CONSTRAINT "debt_installments_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "debt_installments_schedule_fkey"
    FOREIGN KEY ("organization_id", "debt_schedule_id")
    REFERENCES "debt_schedules"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "accruals"
  ADD CONSTRAINT "accruals_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "accruals_debt_schedule_fkey"
    FOREIGN KEY ("organization_id", "debt_schedule_id")
    REFERENCES "debt_schedules"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "accruals_project_fkey"
    FOREIGN KEY ("organization_id", "project_id")
    REFERENCES "projects"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "accruals_cost_center_fkey"
    FOREIGN KEY ("organization_id", "cost_center_id")
    REFERENCES "cost_centers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "recurring_entries"
  ADD CONSTRAINT "recurring_entries_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "recurring_entries_fixed_asset_fkey"
    FOREIGN KEY ("organization_id", "fixed_asset_id")
    REFERENCES "fixed_assets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "recurring_entries_accrual_fkey"
    FOREIGN KEY ("organization_id", "accrual_id")
    REFERENCES "accruals"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "recurring_occurrences"
  ADD CONSTRAINT "recurring_occurrences_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "recurring_occurrences_recurring_entry_fkey"
    FOREIGN KEY ("organization_id", "recurring_entry_id")
    REFERENCES "recurring_entries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "recurring_occurrences_entry_fkey"
    FOREIGN KEY ("organization_id", "entry_id")
    REFERENCES "journal_entries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. CHECK — las reglas de integridad G-2…G-7 y G-17 (§3.4)
-- ─────────────────────────────────────────────────────────────────────────────

-- G-5. Un activo de coste 0 o de residual ≥ coste no tiene cuadro posible; una
-- vida útil de 0 meses dividiría por cero, y una puesta en funcionamiento
-- anterior a la adquisición es una fecha imposible (NRV 2ª.1).
ALTER TABLE "fixed_assets"
  ADD CONSTRAINT "fixed_assets_cost_positive"    CHECK ("acquisition_cost_cents" > 0),
  ADD CONSTRAINT "fixed_assets_residual_range"
    CHECK ("residual_value_cents" >= 0 AND "residual_value_cents" < "acquisition_cost_cents"),
  ADD CONSTRAINT "fixed_assets_useful_life_range"
    CHECK ("useful_life_months" BETWEEN 1 AND 1200),
  ADD CONSTRAINT "fixed_assets_in_service_after_acquisition"
    CHECK ("in_service_date" >= "acquisition_date"),
  -- G-9: la prorrata va en puntos básicos y es múltiplo de 100 (art. 104.Dos.2ª:
  -- el porcentaje se redondea por exceso a la unidad superior).
  ADD CONSTRAINT "fixed_assets_prorrata_bps_range"
    CHECK ("acquisition_prorrata_bps" IS NULL OR
           ("acquisition_prorrata_bps" BETWEEN 0 AND 10000 AND "acquisition_prorrata_bps" % 100 = 0)),
  -- Un activo dado de baja o vendido tiene fecha de baja, y sólo ésos.
  ADD CONSTRAINT "fixed_assets_disposal_coherent"
    CHECK (("status" IN ('BAJA', 'VENDIDO')) = ("disposal_date" IS NOT NULL));

-- G-6. La revisión entra el día 1 de un mes: el cuadro se recorre por meses
-- completos y una revisión a mitad de mes partiría una cuota ya contabilizada.
-- Que no sea anterior al último periodo contabilizado lo comprueba el servidor,
-- que es quien sabe hasta dónde llegó la generación.
ALTER TABLE "asset_revisions"
  ADD CONSTRAINT "asset_revisions_effective_first_day"
    CHECK (EXTRACT(DAY FROM "effective_from") = 1),
  -- Una revisión que no cambia nada no es una revisión.
  ADD CONSTRAINT "asset_revisions_has_change"
    CHECK ("new_useful_life_months" IS NOT NULL
        OR "new_residual_value_cents" IS NOT NULL
        OR "added_cost_cents" IS NOT NULL),
  ADD CONSTRAINT "asset_revisions_values_valid"
    CHECK (("new_useful_life_months" IS NULL OR "new_useful_life_months" BETWEEN 1 AND 1200)
       AND ("new_residual_value_cents" IS NULL OR "new_residual_value_cents" >= 0)
       AND ("added_cost_cents" IS NULL OR "added_cost_cents" <> 0)),
  ADD CONSTRAINT "asset_revisions_reason_length" CHECK (length(btrim("reason")) >= 10);

-- G-7. `TIPO_EFECTIVO` sin cuadro de deuda no tiene de dónde sacar el devengo
-- (O-25): el interés de un préstamo lo aporta su cuadro, no un reparto lineal.
ALTER TABLE "accruals"
  ADD CONSTRAINT "accruals_period_order"   CHECK ("period_end" >= "period_start"),
  ADD CONSTRAINT "accruals_total_positive" CHECK ("total_cents" > 0),
  ADD CONSTRAINT "accruals_effective_rate_needs_schedule"
    CHECK ("basis" <> 'TIPO_EFECTIVO' OR "debt_schedule_id" IS NOT NULL);

ALTER TABLE "debt_schedules"
  ADD CONSTRAINT "debt_schedules_principal_positive" CHECK ("principal_cents" > 0),
  ADD CONSTRAINT "debt_schedules_accounts_distinct"
    CHECK ("long_account_code" <> "short_account_code"),
  ADD CONSTRAINT "debt_schedules_rate_nonneg"
    CHECK ("monthly_rate_micro_bps" IS NULL OR "monthly_rate_micro_bps" >= 0),
  ADD CONSTRAINT "debt_schedules_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "debt_installments"
  ADD CONSTRAINT "debt_installments_seq_positive"  CHECK ("seq" >= 1),
  ADD CONSTRAINT "debt_installments_amounts_nonneg"
    CHECK ("principal_cents" >= 0 AND "interest_cents" >= 0);

-- G-2 / G-3. El importe fijo es el ÚNICO que lleva cifra propia: en los otros
-- dos la aporta un cuadro determinista, y una regla de amortización con importe
-- escrito a mano sería una cifra de informe almacenada (ADR-0003).
ALTER TABLE "recurring_entries"
  ADD CONSTRAINT "recurring_entries_amount_iff_fixed"
    CHECK (("amount_cents" IS NOT NULL) = ("kind" = 'IMPORTE_FIJO')),
  ADD CONSTRAINT "recurring_entries_amount_positive"
    CHECK ("amount_cents" IS NULL OR "amount_cents" > 0),
  ADD CONSTRAINT "recurring_entries_asset_iff_amortizacion"
    CHECK (("fixed_asset_id" IS NOT NULL) = ("kind" = 'AMORTIZACION')),
  ADD CONSTRAINT "recurring_entries_accrual_iff_periodificacion"
    CHECK (("accrual_id" IS NOT NULL) = ("kind" = 'PERIODIFICACION')),
  -- G-3: `day_of_month` sólo con `DIA_DEL_MES`; el motor SATURA al último día
  -- del mes (un 31 en febrero es el 28 o el 29, no un error).
  ADD CONSTRAINT "recurring_entries_day_iff_anchor"
    CHECK (("day_of_month" IS NOT NULL) = ("anchor" = 'DIA_DEL_MES')),
  ADD CONSTRAINT "recurring_entries_day_range"
    CHECK ("day_of_month" IS NULL OR "day_of_month" BETWEEN 1 AND 31),
  -- El periodo es `AAAA-MM` o `AAAA-Tn`: la vigencia se compara como texto y
  -- una errata de formato la haría comparar mal en silencio.
  ADD CONSTRAINT "recurring_entries_start_period_format"
    CHECK ("start_period" ~ '^[0-9]{4}-(0[1-9]|1[0-2]|T[1-4])$'),
  ADD CONSTRAINT "recurring_entries_end_period_format"
    CHECK ("end_period" IS NULL OR "end_period" ~ '^[0-9]{4}-(0[1-9]|1[0-2]|T[1-4])$'),
  ADD CONSTRAINT "recurring_entries_period_order"
    CHECK ("end_period" IS NULL OR "end_period" >= "start_period"),
  ADD CONSTRAINT "recurring_entries_template_input_object"
    CHECK (jsonb_typeof("template_input") = 'object');

-- G-4. Una ocurrencia GENERADA tiene asiento y ninguna otra lo tiene; y toda la
-- que no lo es lleva MOTIVO — incluida la de cuota cero (O-22), cuyo motivo es
-- el vocabulario reservado `CUOTA_CERO`. Sin el motivo, la fila dice que no se
-- generó pero no por qué, y la diferencia entre «pausada» y «el cuadro daba 0»
-- es justo lo que hay que poder demostrar.
ALTER TABLE "recurring_occurrences"
  ADD CONSTRAINT "recurring_occurrences_entry_iff_generada"
    CHECK (("entry_id" IS NOT NULL) = ("status" = 'GENERADA')),
  ADD CONSTRAINT "recurring_occurrences_reason_when_not_generada"
    CHECK ("status" = 'GENERADA' OR ("reason" IS NOT NULL AND length(btrim("reason")) > 0)),
  ADD CONSTRAINT "recurring_occurrences_period_format"
    CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2]|T[1-4])$');

-- G-17. `Σ principal = principal_cents` y `seq` correlativo sin huecos. Va como
-- constraint DIFERIDO —igual que el cuadre de partida doble de E3—: el cuadro
-- se inserta fila a fila y sólo cuadra al terminar la transacción.
CREATE OR REPLACE FUNCTION app.assert_debt_schedule_complete()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_schedule_id uuid := COALESCE(NEW."debt_schedule_id", OLD."debt_schedule_id");
  v_org         uuid := COALESCE(NEW."organization_id", OLD."organization_id");
  v_principal   bigint;
  v_sum         bigint;
  v_count       integer;
  v_max         integer;
BEGIN
  SELECT "principal_cents" INTO v_principal
    FROM "debt_schedules" WHERE "id" = v_schedule_id AND "organization_id" = v_org;
  -- El cuadro puede haberse borrado en cascada con su deuda: no hay nada que
  -- comprobar.
  IF v_principal IS NULL THEN RETURN NULL; END IF;

  SELECT COALESCE(sum("principal_cents"), 0), count(*), COALESCE(max("seq"), 0)
    INTO v_sum, v_count, v_max
    FROM "debt_installments"
   WHERE "debt_schedule_id" = v_schedule_id AND "organization_id" = v_org;

  -- Un cuadro vacío es una deuda todavía sin cargar, no un cuadro roto.
  IF v_count = 0 THEN RETURN NULL; END IF;

  IF v_sum <> v_principal THEN
    RAISE EXCEPTION 'cuadro de deuda %: Σ principal de las cuotas (%) ≠ principal de la deuda (%) — G-17',
      v_schedule_id, v_sum, v_principal USING ERRCODE = '23514';
  END IF;
  IF v_max <> v_count THEN
    RAISE EXCEPTION 'cuadro de deuda %: la numeración de cuotas tiene huecos (% cuotas, máximo %) — G-17',
      v_schedule_id, v_count, v_max USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER "debt_installments_schedule_complete"
  AFTER INSERT OR UPDATE OR DELETE ON "debt_installments"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.assert_debt_schedule_complete();

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. O-19 — `journal_lines.fixed_asset_id`: la amortización, POR ACTIVO
--    `2811` es una cuenta COMPARTIDA. Sin esta columna, I-E9-5 se evalúa por
--    agregado y deja pasar justo lo que busca: un activo sobreamortizado
--    compensado por otro infraamortizado. Y el drill-down «cuota → asiento» de
--    `/settings/assets` no existe.
--    Queda NULL en todo el histórico (§3.5): I-E9-5 sale INFO para los activos
--    anteriores a E9 —diciendo que no hay atribución—, nunca PASS por vacuidad.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "journal_lines" ADD COLUMN "fixed_asset_id" uuid;

ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_fixed_asset_fkey"
    FOREIGN KEY ("organization_id", "fixed_asset_id")
    REFERENCES "fixed_assets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "journal_lines_organization_id_fixed_asset_id_idx"
  ON "journal_lines" ("organization_id", "fixed_asset_id");

-- G-15. La atribución sólo tiene sentido en las cuentas del ciclo del activo:
-- dotación (68x), acumulada (28x) y resultado de la baja (671/771). Atribuir un
-- gasto de suministros a un activo sería ruido que I-E9-5 tomaría por cuota.
ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_fixed_asset_accounts" CHECK (
    "fixed_asset_id" IS NULL
    OR "account_code" LIKE '68%'
    OR "account_code" LIKE '28%'
    OR "account_code" LIKE '671%'
    OR "account_code" LIKE '771%'
  );

-- La columna es INMUTABLE como el resto de la línea: `journal_lines` ya tiene
-- `journal_lines_no_update` RESTRICTIVE y no hay `GRANT UPDATE`, así que no hace
-- falta añadir nada. Se deja escrito para que nadie lo dé por olvidado.

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. RLS estricta (ADR-0009) sobre las siete tablas nuevas
--    Se reutiliza `app.enforce_tenant_rls` (20260906100000) en vez de copiar
--    SQL. Las siete entran a la vez en `TENANT_MODELS` (lib/db.ts): o están las
--    dos cosas, o la barrera 1 no las acota y una consulta fuera de `tenantDb`
--    devuelve VACÍO en silencio.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'fixed_assets', 'asset_revisions', 'debt_schedules', 'debt_installments',
    'accruals', 'recurring_entries', 'recurring_occurrences'
  ] LOOP
    PERFORM app.enforce_tenant_rls(t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "fixed_assets", "asset_revisions", "debt_schedules", "debt_installments",
  "accruals", "recurring_entries", "recurring_occurrences" TO app_runtime;

-- 9.a APPEND-ONLY con las dos cerraduras —privilegio y política—, patrón de
--     `audit_logs` / `invariant_runs`. Las dos tablas son HECHOS fechados:
--     una ocurrencia dice qué se generó en qué periodo y con qué input; una
--     revisión, qué estimación cambió y desde cuándo. Si se pudieran editar,
--     `input_hash` no acreditaría nada e I-E9-1b no tendría contra qué comparar.
REVOKE UPDATE, DELETE ON "recurring_occurrences", "asset_revisions" FROM app_runtime;
CREATE POLICY "recurring_occurrences_no_update" ON "recurring_occurrences" AS RESTRICTIVE FOR UPDATE USING (false);
CREATE POLICY "recurring_occurrences_no_delete" ON "recurring_occurrences" AS RESTRICTIVE FOR DELETE USING (false);
CREATE POLICY "asset_revisions_no_update"       ON "asset_revisions"       AS RESTRICTIVE FOR UPDATE USING (false);
CREATE POLICY "asset_revisions_no_delete"       ON "asset_revisions"       AS RESTRICTIVE FOR DELETE USING (false);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "fixed_assets", "asset_revisions", "debt_schedules", "debt_installments",
  "accruals", "recurring_entries", "recurring_occurrences" TO app_maintenance;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. Verificación: ninguna tabla queda en NO FORCE (ADR-0009 §7)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'fixed_assets', 'asset_revisions', 'debt_schedules', 'debt_installments',
    'accruals', 'recurring_entries', 'recurring_occurrences'
  ] LOOP
    IF NOT (SELECT relforcerowsecurity FROM pg_class WHERE relname = t) THEN
      RAISE EXCEPTION '% ha quedado en NO FORCE ROW LEVEL SECURITY', t;
    END IF;
  END LOOP;
END $$;
