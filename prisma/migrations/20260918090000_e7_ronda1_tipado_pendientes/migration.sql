-- E7 · ronda 1 de corrección — **H-5**: el TIPADO de un pendiente (O-8).
--
-- El diseño (§3.5, tabla de tipos de pendiente) declara seis tipos de partida en
-- tránsito y hace depender de ellos el criterio 3 de «explicado» de §3.6 y el
-- motivo de sello `PARTIDA_EN_TRANSITO_ANTIGUA`. La ronda 1 los declaró en los
-- tipos del motor (`lib/bank/types.ts`) y los leyó en el cuadre, pero **no había
-- dónde escribirlos**: el barrido real devolvía `kind: null` en los doce
-- pendientes y toda la taxonomía era código muerto.
--
-- ## Por qué una tabla y no una columna
--
-- El tipado es de los DOS lados: una línea de extracto sin asiento
-- (`MOVIMIENTO_BANCO_SIN_ASIENTO`) y un apunte sin movimiento
-- (`CHEQUE_EMITIDO_NO_CARGADO`, `REMESA_NO_ABONADA`…). El lado de libros es una
-- `journal_line`, y `journal_lines` es **append-only**: `app_runtime` sólo tiene
-- `SELECT, INSERT` (ADR-0009/ADR-0010) y no existe un `GRANT UPDATE` acotado
-- sobre ella. Añadir ahí una columna escribible abriría el diario a la
-- aplicación por una razón que no es contable: el tipo de un pendiente es un
-- dato de CONCILIACIÓN, no del asiento, y no entra en `entry_hash`.
--
-- Una tabla propia lo dice mejor: el diario no se toca, el dato lleva autor y
-- fecha (P6), y el tipado desaparece con el pendiente —cuando la línea o el
-- apunte se concilian o se ignoran ya no hay nada que tipar—.
--
-- Ejecutable por un rol **NO superusuario**: `CREATE TYPE`, `CREATE TABLE`,
-- `GRANT` sobre tablas propias y `app.enforce_tenant_rls` (ADR-0009 §6).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Enum — el vocabulario CERRADO de §3.5, uno a uno con `PendingKind`
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "pending_kind" AS ENUM (
  'CHEQUE_EMITIDO_NO_CARGADO',
  'REMESA_NO_ABONADA',
  'TRASPASO_ENTRE_CUENTAS_EN_CAMINO',
  'MOVIMIENTO_BANCO_SIN_ASIENTO',
  'APUNTE_SIN_MOVIMIENTO',
  'EFECTO_EN_GESTION_DE_COBRO'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Tabla
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "bank_pending_kinds" (
  "id"                uuid           NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"   uuid           NOT NULL,
  "bank_account_id"   uuid           NOT NULL,
  -- **Exactamente uno** de los dos: un tipado es de una línea de extracto o de
  -- un apunte, nunca de los dos ni de ninguno.
  "statement_line_id" uuid,
  "journal_line_id"   uuid,
  "kind"              "pending_kind" NOT NULL,
  "note"              varchar(512),
  "declared_by_id"    uuid,
  "declared_at"       timestamp(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bank_pending_kinds_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bank_pending_kinds_one_side"
    CHECK (num_nonnulls("statement_line_id", "journal_line_id") = 1)
);

CREATE UNIQUE INDEX "bank_pending_kinds_organization_id_id_key"
  ON "bank_pending_kinds" ("organization_id", "id");
-- Un pendiente tiene UN tipo: volver a tiparlo lo sustituye, no lo acumula.
CREATE UNIQUE INDEX "bank_pending_kinds_one_per_statement_line"
  ON "bank_pending_kinds" ("organization_id", "statement_line_id")
  WHERE "statement_line_id" IS NOT NULL;
CREATE UNIQUE INDEX "bank_pending_kinds_one_per_journal_line"
  ON "bank_pending_kinds" ("organization_id", "journal_line_id")
  WHERE "journal_line_id" IS NOT NULL;
CREATE INDEX "bank_pending_kinds_org_account_idx"
  ON "bank_pending_kinds" ("organization_id", "bank_account_id");

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. FK — compuestas POR TENANT (§2.3 punto 5)
--
-- `CASCADE` a propósito en las dos referencias al dato tipado: el tipado es
-- accesorio del pendiente y no puede impedir nada. Con `RESTRICT` habríamos
-- repetido BUG-E7-1 —una fila accesoria bloqueando el borrado de la principal—.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "bank_pending_kinds"
  ADD CONSTRAINT "bank_pending_kinds_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "bank_pending_kinds_bank_account_fkey"
    FOREIGN KEY ("organization_id", "bank_account_id")
    REFERENCES "bank_accounts"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "bank_pending_kinds_statement_line_fkey"
    FOREIGN KEY ("organization_id", "statement_line_id")
    REFERENCES "bank_statement_lines"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "bank_pending_kinds_journal_line_fkey"
    FOREIGN KEY ("organization_id", "journal_line_id")
    REFERENCES "journal_lines"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "bank_pending_kinds_declared_by_fkey"
    FOREIGN KEY ("declared_by_id") REFERENCES "users"("id") ON DELETE SET NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RLS estricta (ADR-0009) + GRANT
--
-- Aquí SÍ hacen falta `UPDATE` y `DELETE`: retipar un pendiente y **destiparlo**
-- cuando se concilia o se ignora son operaciones normales de la pantalla. No es
-- un hecho contable: es una anotación sobre algo que todavía no ha cuadrado.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT app.enforce_tenant_rls('bank_pending_kinds');
GRANT SELECT, INSERT, UPDATE, DELETE ON "bank_pending_kinds" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "bank_pending_kinds" TO app_maintenance;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. **PUEDE 5 del revisor** — todo grupo VIVO tiene al menos un miembro.
--
-- El `CONSTRAINT TRIGGER` de I-E7-11 (`bank_reconciliations_group_balanced`,
-- migración `20260917090000`) es `AFTER INSERT` **sobre `bank_reconciliations`**:
-- un grupo creado sin ninguna fila de pertenencia no se comprueba jamás y queda
-- vivo, cuadrando por vacuidad (`Σ = 0 = 0`). Hoy es inalcanzable —
-- `createMatchGroup` inserta la estrella en la misma transacción—, pero la
-- garantía se apoyaba en la aplicación y no en la base.
--
-- Un `CHECK` no puede mirar otra tabla, así que la garantía es un
-- `CONSTRAINT TRIGGER` **diferido al COMMIT** sobre el grupo: al terminar la
-- transacción, un grupo vivo sin pertenencias aborta. Diferido a propósito, para
-- que el orden natural (crear el grupo y luego sus filas) siga valiendo.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.bank_match_groups_has_members()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_members integer;
BEGIN
  IF NEW."unmatched_at" IS NOT NULL THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO v_members
    FROM "bank_reconciliations" r
   WHERE r."organization_id" = NEW."organization_id" AND r."group_id" = NEW."id";
  IF v_members = 0 THEN
    RAISE EXCEPTION 'bank_match_groups: el grupo % está vivo y no tiene ninguna pertenencia; un grupo vacío cuadraría por vacuidad (I-E7-11)',
      NEW."id" USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER "bank_match_groups_not_empty"
  AFTER INSERT OR UPDATE ON "bank_match_groups"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.bank_match_groups_has_members();

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. **H-1 (ALTA)** — la igualdad de importes se comprueba EN LA DIVISA DE LA
--    CUENTA, también en la base (ADR-0015 D6.2).
--
-- Los dos guardias de I-E7-2 e I-E7-11 comparaban `bank_statement_lines.amount_cents`
-- —que está en la divisa del extracto, o sea la de la cuenta— contra
-- `debit_cents − credit_cents`, que está en **moneda base**. En una cuenta en
-- dólares eso sólo cuadra a paridad 1:1: con cualquier tipo de cambio real la
-- conciliación era imposible y la cuenta se quedaba en un PASS vacío.
--
-- Se corrigen en la base y no sólo en la aplicación porque la barrera de M3 es
-- justamente que la igualdad viva EN LA BASE: si sólo la arreglara
-- `createMatchGroup`, el `INSERT` directo seguiría rechazando la conciliación
-- correcta de una cuenta en divisa.
-- ─────────────────────────────────────────────────────────────────────────────

/**
 * Importe con signo de un apunte **en la moneda de la cuenta bancaria**.
 * `NULL` = el apunte no lleva su importe en esa divisa y la comparación NO SE
 * PUEDE hacer: quien llama lo delata, no lo aproxima.
 * `original_amount_cents` se guarda SIN signo (igual que debe y haber): el signo
 * sale del lado del apunte.
 */
CREATE OR REPLACE FUNCTION app.bank_line_amount_in_currency(
  p_debit bigint, p_credit bigint, p_original_currency varchar, p_original_amount bigint,
  p_account_currency varchar, p_base_currency varchar
) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    WHEN upper(p_account_currency) = upper(p_base_currency) THEN p_debit - p_credit
    WHEN p_original_amount IS NULL OR upper(COALESCE(p_original_currency, '')) <> upper(p_account_currency) THEN NULL
    WHEN p_debit - p_credit < 0 THEN -abs(p_original_amount)
    ELSE abs(p_original_amount)
  END
$fn$;

CREATE OR REPLACE FUNCTION app.bank_reconciliations_guard()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_group   record;
  v_line    record;
  v_jl      record;
  v_acct    varchar(12);
  v_curr    varchar(3);
  v_base    varchar(3);
  v_signed  bigint;
BEGIN
  SELECT g."organization_id", g."bank_account_id", g."unmatched_at", g."kind"
    INTO v_group
    FROM "bank_match_groups" g
   WHERE g."organization_id" = NEW."organization_id" AND g."id" = NEW."group_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank_reconciliations: el grupo % no existe en esta organización', NEW."group_id"
      USING ERRCODE = '23503';
  END IF;
  IF v_group."unmatched_at" IS NOT NULL THEN
    RAISE EXCEPTION 'bank_reconciliations: el grupo % está desconciliado; no admite pertenencias nuevas', NEW."group_id"
      USING ERRCODE = '23514';
  END IF;
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

  SELECT j."account_code", j."debit_cents", j."credit_cents", j."entry_date",
         j."original_currency", j."original_amount_cents"
    INTO v_jl
    FROM "journal_lines" j
   WHERE j."organization_id" = NEW."organization_id" AND j."id" = NEW."journal_line_id";

  SELECT b."account_code", b."currency" INTO v_acct, v_curr
    FROM "bank_accounts" b
   WHERE b."organization_id" = NEW."organization_id" AND b."id" = v_group."bank_account_id";
  IF v_jl."account_code" IS DISTINCT FROM v_acct THEN
    RAISE EXCEPTION 'bank_reconciliations: el apunte es de la cuenta % y la cuenta bancaria puntea contra la % (§2.4)',
      v_jl."account_code", v_acct USING ERRCODE = '23514';
  END IF;

  SELECT o."base_currency" INTO v_base
    FROM "organizations" o WHERE o."id" = NEW."organization_id";

  v_signed := app.bank_line_amount_in_currency(
    v_jl."debit_cents", v_jl."credit_cents", v_jl."original_currency", v_jl."original_amount_cents",
    v_curr, v_base);
  IF v_signed IS NULL THEN
    RAISE EXCEPTION 'bank_reconciliations: la cuenta está en % y el apunte % no lleva su importe en esa divisa (original_amount_cents); conciliar contra el contravalor en % sería cuadrar mezclando monedas (ADR-0015 D6.2)',
      v_curr, NEW."journal_line_id", v_base USING ERRCODE = '23514';
  END IF;

  -- **D6.4 · I-E7-2 en el camino de escritura.** En un grupo `SIMPLE` la
  -- igualdad ES la de la pareja; en un grupo N-a-M la igualdad es la del GRUPO y
  -- la comprueba, al COMMIT, `app.bank_match_groups_balanced()`.
  IF v_group."kind" = 'SIMPLE' AND v_line."amount_cents" IS DISTINCT FROM v_signed THEN
    RAISE EXCEPTION 'bank_reconciliations: el apunte del banco (%) y el del libro (%) no son el mismo importe con signo en % (I-E7-2, tolerancia 0)',
      v_line."amount_cents", v_signed, v_curr USING ERRCODE = '23514';
  END IF;
  -- O-10: el desfase se SELLA aquí y no se juzga.
  NEW."date_gap_days" := abs(v_line."operation_date" - v_jl."entry_date");
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION app.bank_match_groups_balanced()
RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_alive   timestamp(3);
  v_lines   bigint;
  v_cash    bigint;
  v_nulls   bigint;
  v_curr    varchar(3);
  v_base    varchar(3);
BEGIN
  SELECT g."unmatched_at", b."currency" INTO v_alive, v_curr
    FROM "bank_match_groups" g
    JOIN "bank_accounts" b
      ON b."organization_id" = g."organization_id" AND b."id" = g."bank_account_id"
   WHERE g."organization_id" = NEW."organization_id" AND g."id" = NEW."group_id";
  IF v_alive IS NOT NULL THEN RETURN NULL; END IF;

  SELECT o."base_currency" INTO v_base FROM "organizations" o WHERE o."id" = NEW."organization_id";

  SELECT COALESCE(SUM(l."amount_cents"), 0) INTO v_lines
    FROM (SELECT DISTINCT r."statement_line_id"
            FROM "bank_reconciliations" r
           WHERE r."organization_id" = NEW."organization_id" AND r."group_id" = NEW."group_id") m
    JOIN "bank_statement_lines" l
      ON l."organization_id" = NEW."organization_id" AND l."id" = m."statement_line_id";

  SELECT COALESCE(SUM(app.bank_line_amount_in_currency(
           j."debit_cents", j."credit_cents", j."original_currency", j."original_amount_cents", v_curr, v_base)), 0),
         COUNT(*) FILTER (WHERE app.bank_line_amount_in_currency(
           j."debit_cents", j."credit_cents", j."original_currency", j."original_amount_cents", v_curr, v_base) IS NULL)
    INTO v_cash, v_nulls
    FROM (SELECT DISTINCT r."journal_line_id"
            FROM "bank_reconciliations" r
           WHERE r."organization_id" = NEW."organization_id" AND r."group_id" = NEW."group_id") m
    JOIN "journal_lines" j
      ON j."organization_id" = NEW."organization_id" AND j."id" = m."journal_line_id";

  IF v_nulls > 0 THEN
    RAISE EXCEPTION 'bank_match_groups: el grupo % está en % y % apunte(s) no llevan su importe en esa divisa: no se puede cuadrar sin mezclar monedas (ADR-0015 D6.2)',
      NEW."group_id", v_curr, v_nulls USING ERRCODE = '23514';
  END IF;
  IF v_lines IS DISTINCT FROM v_cash THEN
    RAISE EXCEPTION 'bank_match_groups: el grupo % no cuadra: Σ extracto % ≠ Σ apuntes % en % (I-E7-11, tolerancia 0)',
      NEW."group_id", v_lines, v_cash, v_curr USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$fn$;
