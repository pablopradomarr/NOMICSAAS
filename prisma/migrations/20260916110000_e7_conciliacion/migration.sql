-- E7 · T3 — M3: la conciliación bancaria con el esquema de ADR-0015 **D6**
-- (grupos N-a-M, divisa, anclaje, `date_gap_days`, vocabulario cerrado de
-- ignorado). docs/design/E7-auditoria.md §2.2, §2.3 y §2.4.
--
-- Aditiva pura, ejecutable por un rol NO superusuario. Los tipos de enum que usa
-- se crearon en `20260916090000_e7_enums`.
--
-- Las cinco tablas nacen VACÍAS (§2.5): no se reconstruye histórico bancario.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Tablas
-- ─────────────────────────────────────────────────────────────────────────────

-- 1.a `bank_accounts` — la cuenta corriente y su ANCLAJE (O-1, ADR-0015 D6.3).
CREATE TABLE "bank_accounts" (
  "id"                               uuid         NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"                  uuid         NOT NULL,
  "code"                             varchar(24)  NOT NULL,
  "name"                             varchar(200) NOT NULL,
  -- O-7: la subcuenta 57x contra la que se puntea. Una cuenta bancaria por
  -- subcuenta: dos contra la misma computarían `B` dos veces e I-E7-1
  -- descuadraría por diseño.
  "account_code"                     varchar(12)  NOT NULL,
  "iban"                             varchar(34),
  "bic"                              varchar(11),
  "currency"                         varchar(3)   NOT NULL DEFAULT 'EUR',
  -- O-1 · el anclaje. Sin él, I-E7-1 sale INFO, nunca PASS: no se puede afirmar
  -- que un saldo cuadra si no se sabe desde dónde.
  "reconciled_from_date"             date,
  "reconciled_opening_balance_cents" bigint,
  "csv_mapping"                      jsonb,
  -- O-10: SÓLO alimenta la sugerencia; no entra en ningún invariante (P7), sí
  -- en `config_hash`.
  "match_tolerance_days"             integer      NOT NULL DEFAULT 3,
  -- O-8: umbral de tránsito. Configuración, nunca constante del código.
  "transit_warn_days"                integer      NOT NULL DEFAULT 90,
  "is_active"                        boolean      NOT NULL DEFAULT true,
  "created_at"                       timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                       timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bank_accounts_org_code_key"          ON "bank_accounts" ("organization_id", "code");
CREATE UNIQUE INDEX "bank_accounts_org_account_code_key"  ON "bank_accounts" ("organization_id", "account_code");
CREATE UNIQUE INDEX "bank_accounts_organization_id_id_key" ON "bank_accounts" ("organization_id", "id");

-- 1.b `bank_statements` — el extracto importado. APPEND-ONLY y **no se purga
--     nunca** (ADR-0015 D3, art. 30 CCom seis años; diez con BIN, art. 26.5 LIS).
CREATE TABLE "bank_statements" (
  "id"                    uuid               NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"       uuid               NOT NULL,
  "bank_account_id"       uuid               NOT NULL,
  "format"                "statement_format" NOT NULL,
  -- sha256 de los BYTES importados: clave de idempotencia (I-E7-5).
  "file_sha256"           char(64)           NOT NULL,
  "file_name"             varchar(255)       NOT NULL,
  -- El `File` original: es la «fuente» del badge P6 y tiene que poder enseñarse.
  "file_id"               uuid,
  -- O-5: divisa del extracto. La importación exige que coincida con la de la
  -- cuenta y rechaza el fichero entero si no (trigger, §5).
  "currency"              varchar(3)         NOT NULL DEFAULT 'EUR',
  -- O-6: los periodos se acotan por FECHA DE OPERACIÓN.
  "period_start"          date               NOT NULL,
  "period_end"            date               NOT NULL,
  -- Saldos DECLARADOS POR EL BANCO (registros 11 y 33 de la N43).
  "opening_balance_cents" bigint             NOT NULL,
  "closing_balance_cents" bigint             NOT NULL,
  -- Registro 33: número de apuntes declarado por el banco (O-11).
  "declared_line_count"   integer,
  "line_count"            integer            NOT NULL DEFAULT 0,
  "imported_by_id"        uuid,
  "imported_at"           timestamp(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bank_statements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bank_statements_org_account_sha_key"
  ON "bank_statements" ("organization_id", "bank_account_id", "file_sha256");
CREATE UNIQUE INDEX "bank_statements_organization_id_id_key"
  ON "bank_statements" ("organization_id", "id");
CREATE INDEX "bank_statements_org_account_period_idx"
  ON "bank_statements" ("organization_id", "bank_account_id", "period_start");

-- 1.c `bank_statement_lines` — el apunte del banco.
CREATE TABLE "bank_statement_lines" (
  "id"                    uuid                NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"       uuid                NOT NULL,
  "statement_id"          uuid                NOT NULL,
  "bank_account_id"       uuid                NOT NULL,
  -- Orden en el extracto, 1..n, SIN HUECOS (I-E7-5).
  "line_no"               integer             NOT NULL,
  -- O-6: `operation_date` es la ÚNICA que corta periodos. `value_date` es dato
  -- financiero y está PROHIBIDA en toda agregación de cuadre.
  "operation_date"        date                NOT NULL,
  "value_date"            date                NOT NULL,
  -- CON SIGNO: negativo = cargo, positivo = abono, en la divisa de la cuenta.
  "amount_cents"          bigint              NOT NULL,
  "currency"              varchar(3)          NOT NULL,
  -- O-5: registro 24 de la N43, que la ronda 1 decía parsear y no guardaba.
  "original_currency"     varchar(3),
  "original_amount_cents" bigint,
  "balance_cents"         bigint,
  "description"           varchar(512)        NOT NULL,
  -- O-15: el registro 22 lleva DOS referencias y la 1 identifica la REMESA.
  "reference_1"           varchar(12),
  "reference_2"           varchar(16),
  "concept_common"        varchar(2),
  "concept_own"           varchar(3),
  "counterparty_name"     varchar(200),
  -- Forma canónica de la línea (§2.4, `lib/bank/hash.ts`).
  "sha256"                char(64)            NOT NULL,
  "status"                "bank_line_status"  NOT NULL DEFAULT 'UNMATCHED',
  "ignore_reason"         "ignore_reason",
  -- Sin FK: apunta a `bank_statement_lines` (ERROR_BANCO_REVERSADO) o a
  -- `journal_lines` (YA_CONTABILIZADO_EN_OTRA_CUENTA) según el motivo. El
  -- trigger `bank_statement_lines_ignore_guard` comprueba que existe y en cuál.
  "ignore_evidence_id"    uuid,
  "ignored_by_id"         uuid,
  "ignored_at"            timestamp(3),
  CONSTRAINT "bank_statement_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bank_statement_lines_org_statement_lineno_key"
  ON "bank_statement_lines" ("organization_id", "statement_id", "line_no");
CREATE UNIQUE INDEX "bank_statement_lines_org_account_sha_key"
  ON "bank_statement_lines" ("organization_id", "bank_account_id", "sha256");
CREATE UNIQUE INDEX "bank_statement_lines_organization_id_id_key"
  ON "bank_statement_lines" ("organization_id", "id");
-- O-6: el índice de trabajo de la pantalla va por FECHA DE OPERACIÓN.
CREATE INDEX "bank_statement_lines_org_account_status_date_idx"
  ON "bank_statement_lines" ("organization_id", "bank_account_id", "status", "operation_date");

-- 1.d `bank_match_groups` — O-3 (ADR-0015 D6.1). El 1:1 no representa una
--     remesa, una nómina en un cargo global, un descuento de efectos ni una
--     devolución parcial. SEMI-append-only.
CREATE TABLE "bank_match_groups" (
  "id"               uuid                NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"  uuid                NOT NULL,
  "bank_account_id"  uuid                NOT NULL,
  "kind"             "match_group_kind"  NOT NULL,
  "note"             varchar(500),
  "created_by_id"    uuid,
  "created_at"       timestamp(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "unmatched_at"     timestamp(3),
  "unmatched_by_id"  uuid,
  "unmatch_reason"   varchar(1000),
  CONSTRAINT "bank_match_groups_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bank_match_groups_organization_id_id_key"
  ON "bank_match_groups" ("organization_id", "id");
CREATE INDEX "bank_match_groups_org_account_alive_idx"
  ON "bank_match_groups" ("organization_id", "bank_account_id", "unmatched_at");

-- 1.e `bank_reconciliations` — la FILA DE PERTENENCIA a un grupo.
CREATE TABLE "bank_reconciliations" (
  "id"                 uuid           NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"    uuid           NOT NULL,
  "group_id"           uuid           NOT NULL,
  "statement_line_id"  uuid           NOT NULL,
  -- Una `journal_line` de una cuenta 57x, NO un asiento: un traspaso mueve dos
  -- bancos y conciliar el asiento cruzaría las dos cuentas.
  "journal_line_id"    uuid           NOT NULL,
  "method"             "match_method" NOT NULL,
  "score_bps"          integer        NOT NULL DEFAULT 0,
  -- O-10 (D6.4): desfase SELLADO en el punteo, inmune a que alguien cambie
  -- `match_tolerance_days` después. Alimenta `DESFASE_FECHA_ALTO` (WARN).
  "date_gap_days"      integer        NOT NULL,
  -- **Denormalizado, lo escribe el trigger, nadie más.** Los dos índices únicos
  -- parciales de I-E7-3 son `WHERE unmatched_at IS NULL` y un índice parcial no
  -- puede mirar la columna de OTRA tabla: la aliveness del grupo tiene que
  -- estar aquí para que la unicidad viva EN LA BASE y no en un trigger con
  -- carrera. Espejo exacto de `bank_match_groups.unmatched_at`.
  "group_unmatched_at" timestamp(3),
  "matched_by_id"      uuid,
  "matched_at"         timestamp(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bank_reconciliations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bank_reconciliations_organization_id_id_key"
  ON "bank_reconciliations" ("organization_id", "id");
CREATE INDEX "bank_reconciliations_org_group_idx"
  ON "bank_reconciliations" ("organization_id", "group_id");
CREATE INDEX "bank_reconciliations_org_journal_line_idx"
  ON "bank_reconciliations" ("organization_id", "journal_line_id");
CREATE INDEX "bank_reconciliations_org_statement_line_idx"
  ON "bank_reconciliations" ("organization_id", "statement_line_id");

-- **I-E7-3 EN LA BASE** (§2.4): una línea de extracto y un apunte 57x
-- pertenecen A LO SUMO A UN GRUPO VIVO. Siguen valiendo con grupos: lo que era
-- «un par» ahora es «una pertenencia».
CREATE UNIQUE INDEX "bank_reconciliations_one_live_statement_line"
  ON "bank_reconciliations" ("organization_id", "statement_line_id")
  WHERE "group_unmatched_at" IS NULL;
CREATE UNIQUE INDEX "bank_reconciliations_one_live_journal_line"
  ON "bank_reconciliations" ("organization_id", "journal_line_id")
  WHERE "group_unmatched_at" IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. FK — compuestas POR TENANT (§2.3 punto 5)
--
-- `journal_lines` necesita la unique compuesta ANTES de ser destino de la FK por
-- tenant de `bank_reconciliations` (mismo patrón que `files` en E8). Es un
-- índice nuevo sobre la tabla más grande, pero UNIQUE sobre `(organization_id,
-- id)` con `id` ya único: no puede fallar por datos.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "journal_lines_organization_id_id_key"
  ON "journal_lines" ("organization_id", "id");

ALTER TABLE "bank_accounts"
  ADD CONSTRAINT "bank_accounts_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "bank_accounts_account_fkey"
    FOREIGN KEY ("organization_id", "account_code")
    REFERENCES "accounts"("organization_id", "code") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "bank_statements"
  ADD CONSTRAINT "bank_statements_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "bank_statements_bank_account_fkey"
    FOREIGN KEY ("organization_id", "bank_account_id")
    REFERENCES "bank_accounts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- El `File` del extracto NO se borra nunca (O-22): `RESTRICT` lo dice también
  -- en la base, además de la comprobación de `scripts/prune-runs.ts`.
  ADD CONSTRAINT "bank_statements_file_fkey"
    FOREIGN KEY ("organization_id", "file_id")
    REFERENCES "files"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "bank_statement_lines"
  ADD CONSTRAINT "bank_statement_lines_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "bank_statement_lines_statement_fkey"
    FOREIGN KEY ("organization_id", "statement_id")
    REFERENCES "bank_statements"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "bank_statement_lines_bank_account_fkey"
    FOREIGN KEY ("organization_id", "bank_account_id")
    REFERENCES "bank_accounts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "bank_match_groups"
  ADD CONSTRAINT "bank_match_groups_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "bank_match_groups_bank_account_fkey"
    FOREIGN KEY ("organization_id", "bank_account_id")
    REFERENCES "bank_accounts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "bank_reconciliations"
  ADD CONSTRAINT "bank_reconciliations_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "bank_reconciliations_group_fkey"
    FOREIGN KEY ("organization_id", "group_id")
    REFERENCES "bank_match_groups"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "bank_reconciliations_statement_line_fkey"
    FOREIGN KEY ("organization_id", "statement_line_id")
    REFERENCES "bank_statement_lines"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "bank_reconciliations_journal_line_fkey"
    FOREIGN KEY ("organization_id", "journal_line_id")
    REFERENCES "journal_lines"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. CHECK (§2.3 M3 y §2.4)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "bank_accounts"
  -- O-7: 572/573/574/575 o subcuenta suya. Quedan FUERA 570/571 (caja: no tiene
  -- extracto y no es conciliable jamás) y 576.
  ADD CONSTRAINT "bank_accounts_account_57x"
    CHECK (left("account_code", 3) IN ('572', '573', '574', '575')),
  ADD CONSTRAINT "bank_accounts_currency_iso"  CHECK (char_length("currency") = 3),
  ADD CONSTRAINT "bank_accounts_tolerance_range"
    CHECK ("match_tolerance_days" BETWEEN 0 AND 60),
  ADD CONSTRAINT "bank_accounts_transit_range"
    CHECK ("transit_warn_days" BETWEEN 1 AND 3650),
  -- O-1: el anclaje es fecha Y saldo, o ninguno de los dos. Media ancla no ancla.
  ADD CONSTRAINT "bank_accounts_anchor_pair"
    CHECK (("reconciled_from_date" IS NULL) = ("reconciled_opening_balance_cents" IS NULL));

ALTER TABLE "bank_statements"
  ADD CONSTRAINT "bank_statements_period"      CHECK ("period_end" >= "period_start"),
  ADD CONSTRAINT "bank_statements_currency_iso" CHECK (char_length("currency") = 3),
  ADD CONSTRAINT "bank_statements_line_counts"
    CHECK ("line_count" >= 0 AND ("declared_line_count" IS NULL OR "declared_line_count" >= 0));

ALTER TABLE "bank_statement_lines"
  ADD CONSTRAINT "bank_statement_lines_lineno" CHECK ("line_no" >= 1),
  -- **m2 (ADR-0015 D6.6).** El CHECK es `IS NOT NULL`, **jamás `<> 0`**: los
  -- bancos emiten apuntes de 0,00 € y rechazarlos dejaría un hueco en `line_no`
  -- (I-E7-5 FAIL) y descuadraría el cotejo con el registro 33 (I-E7-6a FAIL),
  -- por un movimiento que el banco sí declaró.
  ADD CONSTRAINT "bank_statement_lines_amount_not_null" CHECK ("amount_cents" IS NOT NULL),
  ADD CONSTRAINT "bank_statement_lines_currency_iso"    CHECK (char_length("currency") = 3),
  ADD CONSTRAINT "bank_statement_lines_original_pair"
    CHECK (("original_currency" IS NULL) = ("original_amount_cents" IS NULL)),
  -- O-4/O-12: vocabulario CERRADO con dato asociado obligatorio. `IGNORED` con
  -- texto libre era la puerta por la que se escapa el rigor.
  ADD CONSTRAINT "bank_statement_lines_ignored_pair"
    CHECK (("status" = 'IGNORED') = ("ignore_reason" IS NOT NULL)),
  ADD CONSTRAINT "bank_statement_lines_ignore_evidence"
    CHECK (
      "ignore_reason" IS NULL
      OR ("ignore_reason" IN ('ERROR_BANCO_REVERSADO', 'YA_CONTABILIZADO_EN_OTRA_CUENTA')
            AND "ignore_evidence_id" IS NOT NULL)
      OR ("ignore_reason" = 'NO_ES_NUESTRA_CUENTA')
      -- m2: la única causa que NO exige evidencia, porque la evidencia es el
      -- propio importe. La pone la importación sola, sin usuario.
      OR ("ignore_reason" = 'IMPORTE_CERO' AND "amount_cents" = 0)
    ),
  ADD CONSTRAINT "bank_statement_lines_ignored_author"
    CHECK ("ignore_reason" IS NULL OR "ignore_reason" = 'IMPORTE_CERO' OR "ignored_by_id" IS NOT NULL);

ALTER TABLE "bank_match_groups"
  -- Desconciliar es del GRUPO, con autor y motivo ≥ 10 caracteres.
  ADD CONSTRAINT "bank_match_groups_unmatch_triple"
    CHECK (("unmatched_at" IS NULL AND "unmatch_reason" IS NULL AND "unmatched_by_id" IS NULL)
        OR ("unmatched_at" IS NOT NULL AND char_length(btrim("unmatch_reason")) >= 10));

ALTER TABLE "bank_reconciliations"
  -- O-10: el desfase se sella, no se juzga aquí. Nunca negativo (es |Δ|).
  ADD CONSTRAINT "bank_reconciliations_date_gap_nonneg" CHECK ("date_gap_days" >= 0),
  ADD CONSTRAINT "bank_reconciliations_score_range"     CHECK ("score_bps" BETWEEN 0 AND 10000);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RLS estricta (ADR-0009) sobre las cinco tablas
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bank_accounts','bank_statements','bank_statement_lines',
                           'bank_match_groups','bank_reconciliations'] LOOP
    PERFORM app.enforce_tenant_rls(t);
  END LOOP;
END $$;

-- 4.a `bank_accounts`: configuración. Se edita; NO se borra si tiene extractos
--     (FK `RESTRICT`) y para retirarla está `is_active`.
GRANT SELECT, INSERT, UPDATE, DELETE ON "bank_accounts" TO app_runtime;

-- 4.b `bank_statements` APPEND-ONLY salvo `line_count`, que lo escribe la propia
--     importación al terminar de insertar las líneas. Un extracto importado es
--     un HECHO: ni se reescribe ni se borra (O-22, art. 30 CCom).
REVOKE UPDATE, DELETE ON "bank_statements" FROM app_runtime;
GRANT SELECT, INSERT ON "bank_statements" TO app_runtime;
GRANT UPDATE ("line_count") ON "bank_statements" TO app_runtime;
CREATE POLICY "bank_statements_no_delete" ON "bank_statements" AS RESTRICTIVE FOR DELETE USING (false);

-- 4.c `bank_statement_lines` SEMI-append-only: el apunte del banco es
--     inmutable; lo único que se escribe después es su estado de punteo y la
--     marca de ignorado (patrón ADR-0010: `GRANT` de columna + trigger).
REVOKE UPDATE, DELETE ON "bank_statement_lines" FROM app_runtime;
GRANT SELECT, INSERT ON "bank_statement_lines" TO app_runtime;
GRANT UPDATE ("status", "ignore_reason", "ignore_evidence_id", "ignored_by_id", "ignored_at")
  ON "bank_statement_lines" TO app_runtime;
CREATE POLICY "bank_statement_lines_no_delete"
  ON "bank_statement_lines" AS RESTRICTIVE FOR DELETE USING (false);

-- 4.d `bank_match_groups` SEMI-append-only: sólo las TRES columnas de
--     desconciliación (ADR-0015 D6.1).
REVOKE UPDATE, DELETE ON "bank_match_groups" FROM app_runtime;
GRANT SELECT, INSERT ON "bank_match_groups" TO app_runtime;
GRANT UPDATE ("unmatched_at", "unmatched_by_id", "unmatch_reason")
  ON "bank_match_groups" TO app_runtime;
CREATE POLICY "bank_match_groups_no_delete"
  ON "bank_match_groups" AS RESTRICTIVE FOR DELETE USING (false);

-- 4.e `bank_reconciliations`: la pertenencia no se borra ni se reescribe. La
--     ÚNICA columna escribible es el espejo `group_unmatched_at`, y el trigger
--     `bank_reconciliations_mirror_guard` exige que su valor sea exactamente el
--     del grupo: tocarla a mano no desconcilia nada, sólo falla.
REVOKE UPDATE, DELETE ON "bank_reconciliations" FROM app_runtime;
GRANT SELECT, INSERT ON "bank_reconciliations" TO app_runtime;
GRANT UPDATE ("group_unmatched_at") ON "bank_reconciliations" TO app_runtime;
CREATE POLICY "bank_reconciliations_no_delete"
  ON "bank_reconciliations" AS RESTRICTIVE FOR DELETE USING (false);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "bank_accounts", "bank_statements", "bank_statement_lines",
  "bank_match_groups", "bank_reconciliations"
  TO app_maintenance;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Triggers — lo que un CHECK no puede mirar porque vive en otra tabla
-- ─────────────────────────────────────────────────────────────────────────────

-- 5.a O-5: el extracto está EN LA DIVISA DE LA CUENTA, y la línea en la del
--     extracto. Un extracto en USD sobre una cuenta declarada en EUR pasaba
--     todos los checks del diseño de la ronda 1.
CREATE OR REPLACE FUNCTION app.bank_statements_currency_guard()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_currency varchar(3);
BEGIN
  SELECT b."currency" INTO v_currency
    FROM "bank_accounts" b
   WHERE b."organization_id" = NEW."organization_id" AND b."id" = NEW."bank_account_id";
  IF v_currency IS DISTINCT FROM NEW."currency" THEN
    RAISE EXCEPTION 'bank_statements: el extracto viene en % y la cuenta está declarada en % (ADR-0015 D6.2); se rechaza el fichero entero',
      NEW."currency", v_currency USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER "bank_statements_currency_guard_insert"
  BEFORE INSERT ON "bank_statements"
  FOR EACH ROW EXECUTE FUNCTION app.bank_statements_currency_guard();

CREATE OR REPLACE FUNCTION app.bank_statement_lines_guard()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_statement RECORD;
  v_exists    boolean;
BEGIN
  SELECT s."currency", s."bank_account_id" INTO v_statement
    FROM "bank_statements" s
   WHERE s."organization_id" = NEW."organization_id" AND s."id" = NEW."statement_id";
  IF v_statement."currency" IS DISTINCT FROM NEW."currency" THEN
    RAISE EXCEPTION 'bank_statement_lines: la línea viene en % y el extracto en % (ADR-0015 D6.2)',
      NEW."currency", v_statement."currency" USING ERRCODE = '23514';
  END IF;
  IF v_statement."bank_account_id" IS DISTINCT FROM NEW."bank_account_id" THEN
    RAISE EXCEPTION 'bank_statement_lines: la línea dice ser de otra cuenta bancaria que su extracto'
      USING ERRCODE = '23514';
  END IF;
  -- O-4: la evidencia del ignorado EXISTE, y en la tabla que le corresponde. Un
  -- uuid inventado dejaría un ignorado sin nada detrás, que es exactamente lo
  -- que el vocabulario cerrado viene a impedir.
  IF NEW."ignore_reason" = 'ERROR_BANCO_REVERSADO' THEN
    SELECT EXISTS (SELECT 1 FROM "bank_statement_lines" l
                    WHERE l."organization_id" = NEW."organization_id"
                      AND l."id" = NEW."ignore_evidence_id") INTO v_exists;
    IF NOT v_exists THEN
      RAISE EXCEPTION 'bank_statement_lines: ERROR_BANCO_REVERSADO exige la línea de extracto que lo revierte'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."ignore_reason" = 'YA_CONTABILIZADO_EN_OTRA_CUENTA' THEN
    SELECT EXISTS (SELECT 1 FROM "journal_lines" j
                    WHERE j."organization_id" = NEW."organization_id"
                      AND j."id" = NEW."ignore_evidence_id") INTO v_exists;
    IF NOT v_exists THEN
      RAISE EXCEPTION 'bank_statement_lines: YA_CONTABILIZADO_EN_OTRA_CUENTA exige el journal_line_id concreto'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER "bank_statement_lines_guard_insert"
  BEFORE INSERT ON "bank_statement_lines"
  FOR EACH ROW EXECUTE FUNCTION app.bank_statement_lines_guard();

-- El apunte del banco es INMUTABLE salvo su punteo y su marca de ignorado.
CREATE OR REPLACE FUNCTION app.bank_statement_lines_only_status()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."id"                  IS DISTINCT FROM OLD."id"
     OR NEW."organization_id"     IS DISTINCT FROM OLD."organization_id"
     OR NEW."statement_id"        IS DISTINCT FROM OLD."statement_id"
     OR NEW."bank_account_id"     IS DISTINCT FROM OLD."bank_account_id"
     OR NEW."line_no"             IS DISTINCT FROM OLD."line_no"
     OR NEW."operation_date"      IS DISTINCT FROM OLD."operation_date"
     OR NEW."value_date"          IS DISTINCT FROM OLD."value_date"
     OR NEW."amount_cents"        IS DISTINCT FROM OLD."amount_cents"
     OR NEW."currency"            IS DISTINCT FROM OLD."currency"
     OR NEW."original_currency"   IS DISTINCT FROM OLD."original_currency"
     OR NEW."original_amount_cents" IS DISTINCT FROM OLD."original_amount_cents"
     OR NEW."balance_cents"       IS DISTINCT FROM OLD."balance_cents"
     OR NEW."description"         IS DISTINCT FROM OLD."description"
     OR NEW."reference_1"         IS DISTINCT FROM OLD."reference_1"
     OR NEW."reference_2"         IS DISTINCT FROM OLD."reference_2"
     OR NEW."sha256"              IS DISTINCT FROM OLD."sha256" THEN
    RAISE EXCEPTION 'bank_statement_lines: el apunte del banco es inmutable; sólo se escribe su punteo y su marca de ignorado (E7, ADR-0010)'
      USING ERRCODE = '23514';
  END IF;
  -- Una línea ignorada no se puede conciliar sin levantar antes el ignorado, y
  -- un ignorado no se «desmarca» a la ligera: se cambia de motivo con autor.
  IF OLD."status" = 'MATCHED' AND NEW."status" = 'IGNORED' THEN
    RAISE EXCEPTION 'bank_statement_lines: una línea conciliada no se ignora; desconcilia el grupo primero'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER "bank_statement_lines_only_status_update"
  BEFORE UPDATE ON "bank_statement_lines"
  FOR EACH ROW EXECUTE FUNCTION app.bank_statement_lines_only_status();

-- 5.b El grupo: sólo se DESCONCILIA, y una sola vez.
CREATE OR REPLACE FUNCTION app.bank_match_groups_only_unmatch()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."id"               IS DISTINCT FROM OLD."id"
     OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
     OR NEW."bank_account_id" IS DISTINCT FROM OLD."bank_account_id"
     OR NEW."kind"            IS DISTINCT FROM OLD."kind"
     OR NEW."note"            IS DISTINCT FROM OLD."note"
     OR NEW."created_by_id"   IS DISTINCT FROM OLD."created_by_id"
     OR NEW."created_at"      IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'bank_match_groups: sólo se pueden escribir unmatched_at, unmatched_by_id y unmatch_reason (E7, ADR-0010)'
      USING ERRCODE = '23514';
  END IF;
  IF OLD."unmatched_at" IS NOT NULL THEN
    RAISE EXCEPTION 'bank_match_groups: el grupo % ya está desconciliado; vuelve a conciliar creando otro', OLD."id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER "bank_match_groups_only_unmatch_update"
  BEFORE UPDATE ON "bank_match_groups"
  FOR EACH ROW EXECUTE FUNCTION app.bank_match_groups_only_unmatch();

-- Al desconciliar, el espejo de las pertenencias se propaga en la MISMA
-- transacción: los dos índices únicos parciales liberan la línea y el apunte.
CREATE OR REPLACE FUNCTION app.bank_match_groups_propagate_unmatch()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."unmatched_at" IS DISTINCT FROM OLD."unmatched_at" THEN
    UPDATE "bank_reconciliations"
       SET "group_unmatched_at" = NEW."unmatched_at"
     WHERE "organization_id" = NEW."organization_id" AND "group_id" = NEW."id";
  END IF;
  RETURN NULL;
END
$fn$;
CREATE TRIGGER "bank_match_groups_propagate_unmatch_update"
  AFTER UPDATE ON "bank_match_groups"
  FOR EACH ROW EXECUTE FUNCTION app.bank_match_groups_propagate_unmatch();

-- 5.c La pertenencia: **I-E7-2 revisada (ADR-0015 D6.4) también en el camino de
--     escritura**, que es el que usa una persona con prisa en un cierre. La
--     ronda 1 dejaba pasar un punteo manual de 100,00 € contra 1 000,00 €.
CREATE OR REPLACE FUNCTION app.bank_reconciliations_guard()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_group  RECORD;
  v_line   RECORD;
  v_jl     RECORD;
  v_acct   varchar(12);
BEGIN
  SELECT g."unmatched_at", g."bank_account_id" INTO v_group
    FROM "bank_match_groups" g
   WHERE g."organization_id" = NEW."organization_id" AND g."id" = NEW."group_id";
  IF v_group."unmatched_at" IS NOT NULL THEN
    RAISE EXCEPTION 'bank_reconciliations: no se añaden miembros a un grupo ya desconciliado'
      USING ERRCODE = '23514';
  END IF;
  -- El espejo lo escribe la base, no quien inserta.
  NEW."group_unmatched_at" := NULL;

  SELECT l."amount_cents", l."bank_account_id", l."status", l."operation_date"
    INTO v_line
    FROM "bank_statement_lines" l
   WHERE l."organization_id" = NEW."organization_id" AND l."id" = NEW."statement_line_id";
  IF v_line."bank_account_id" IS DISTINCT FROM v_group."bank_account_id" THEN
    RAISE EXCEPTION 'bank_reconciliations: la línea de extracto es de otra cuenta bancaria que el grupo'
      USING ERRCODE = '23514';
  END IF;
  IF v_line."status" = 'IGNORED' THEN
    RAISE EXCEPTION 'bank_reconciliations: una línea IGNORED no se concilia; levanta antes el ignorado'
      USING ERRCODE = '23514';
  END IF;

  SELECT j."account_code", j."debit_cents", j."credit_cents", j."entry_date"
    INTO v_jl
    FROM "journal_lines" j
   WHERE j."organization_id" = NEW."organization_id" AND j."id" = NEW."journal_line_id";

  SELECT b."account_code" INTO v_acct
    FROM "bank_accounts" b
   WHERE b."organization_id" = NEW."organization_id" AND b."id" = v_group."bank_account_id";
  IF v_jl."account_code" IS DISTINCT FROM v_acct THEN
    RAISE EXCEPTION 'bank_reconciliations: el apunte es de la cuenta % y la cuenta bancaria puntea contra la % (§2.4)',
      v_jl."account_code", v_acct USING ERRCODE = '23514';
  END IF;
  -- **La igualdad de importes ES el invariante** (D6.4): con signo, al céntimo
  -- y en la divisa de la cuenta.
  IF v_line."amount_cents" IS DISTINCT FROM (v_jl."debit_cents" - v_jl."credit_cents") THEN
    RAISE EXCEPTION 'bank_reconciliations: el apunte del banco (%) y el del libro (%) no son el mismo importe con signo (I-E7-2, tolerancia 0)',
      v_line."amount_cents", (v_jl."debit_cents" - v_jl."credit_cents") USING ERRCODE = '23514';
  END IF;
  -- O-10: el desfase se SELLA aquí y no se juzga. Se recalcula para que nadie
  -- pueda escribir un desfase que no es el suyo.
  NEW."date_gap_days" := abs(v_line."operation_date" - v_jl."entry_date");
  RETURN NEW;
END
$fn$;
CREATE TRIGGER "bank_reconciliations_guard_insert"
  BEFORE INSERT ON "bank_reconciliations"
  FOR EACH ROW EXECUTE FUNCTION app.bank_reconciliations_guard();

-- El espejo sólo puede tomar el valor del grupo: tocarlo a mano no desconcilia
-- nada, sólo falla.
CREATE OR REPLACE FUNCTION app.bank_reconciliations_mirror_guard()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_group_unmatched timestamp(3);
BEGIN
  IF NEW."id"                 IS DISTINCT FROM OLD."id"
     OR NEW."organization_id"   IS DISTINCT FROM OLD."organization_id"
     OR NEW."group_id"          IS DISTINCT FROM OLD."group_id"
     OR NEW."statement_line_id" IS DISTINCT FROM OLD."statement_line_id"
     OR NEW."journal_line_id"   IS DISTINCT FROM OLD."journal_line_id"
     OR NEW."method"            IS DISTINCT FROM OLD."method"
     OR NEW."score_bps"         IS DISTINCT FROM OLD."score_bps"
     OR NEW."date_gap_days"     IS DISTINCT FROM OLD."date_gap_days"
     OR NEW."matched_by_id"     IS DISTINCT FROM OLD."matched_by_id"
     OR NEW."matched_at"        IS DISTINCT FROM OLD."matched_at" THEN
    RAISE EXCEPTION 'bank_reconciliations: la pertenencia es inmutable; se desconcilia el GRUPO (ADR-0015 D6.1)'
      USING ERRCODE = '23514';
  END IF;
  SELECT g."unmatched_at" INTO v_group_unmatched
    FROM "bank_match_groups" g
   WHERE g."organization_id" = NEW."organization_id" AND g."id" = NEW."group_id";
  IF NEW."group_unmatched_at" IS DISTINCT FROM v_group_unmatched THEN
    RAISE EXCEPTION 'bank_reconciliations: group_unmatched_at es el ESPEJO del grupo y lo escribe la base'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER "bank_reconciliations_mirror_guard_update"
  BEFORE UPDATE ON "bank_reconciliations"
  FOR EACH ROW EXECUTE FUNCTION app.bank_reconciliations_mirror_guard();
