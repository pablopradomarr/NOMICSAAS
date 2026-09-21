-- E12 · T13 — **el rol de operador**: la primera de las tres vías de ADR-0020 D2.
--
-- docs/design/E12-fiabilidad-dod.md §5.3 ·
-- docs/adr/0020-escrituras-de-operador-y-excepciones-auditadas.md D1/D2.
--
-- ## El problema que resuelve
--
-- ADR-0020 descarta un rol con `BYPASSRLS` para `/admin` (alternativa 5) y dice
-- que el panel «se sirve con el rol de aplicación y **privilegios explícitos por
-- tabla**». Pero `app_runtime` no puede borrar casi nada: veintiocho tablas de
-- tenant llevan una política `RESTRICTIVE FOR DELETE USING (false)` desde E5–E11
-- —son append-only a propósito— y una organización de demo no se vacía con
-- buenas intenciones.
--
-- La salida **no** es relajar esas políticas. Es un rol **`app_operator`**
-- (`NOBYPASSRLS`) al que `app_runtime` puede cambiarse dentro de la transacción
-- de la operación, y una condición —en la BASE— que sólo se cumple cuando la
-- organización **no tiene un solo asiento**:
--
--   current_user = 'app_operator'
--   AND app.current_org() IS NOT NULL
--   AND NOT EXISTS (SELECT 1 FROM journal_entries WHERE organization_id = app.current_org())
--
-- Con eso, **`reset-org` sobre una organización con un asiento es imposible**: no
-- hay `--force`, ni bandera, ni confirmación, ni bug de la aplicación que lo
-- supere, porque quien se niega es Postgres. Es el criterio 40 puesto donde no
-- se puede esquivar, exactamente igual que la partida doble.
--
-- Las **seis tablas prohibidas** de D2 —`journal_entries`, `journal_lines`,
-- `audit_logs`, `extraction_runs`, `invariant_runs`, `closing_runs`— NO entran
-- en esta relajación: conservan su `USING (false)` absoluto y `app_operator` no
-- recibe DELETE ni UPDATE sobre ninguna de ellas. Sobre `audit_logs` recibe
-- **INSERT y nada más**, porque D3 obliga a dejar la línea en el registro del
-- cliente y una traza que no se puede escribir no es una traza.
--
-- Ejecutable por un rol NO superusuario: `CREATE ROLE` necesita `CREATEROLE`,
-- que el `postgres` de Supabase tiene (CLAUDE.md). Sin `ALTER ROLE … SUPERUSER`,
-- sin `ALTER FUNCTION … OWNER TO`, sin extensiones. No mueve una sola fila.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. El rol
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_operator') THEN
    -- `NOLOGIN` a propósito: nadie se conecta como operador. Se LLEGA a él con
    -- `SET LOCAL ROLE` desde `app_runtime`, dentro de la transacción de la
    -- operación y sólo ahí. Un rol sin login es un rol que no se puede robar
    -- con una cadena de conexión filtrada.
    CREATE ROLE app_operator NOLOGIN NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

GRANT app_operator TO app_runtime;
GRANT USAGE ON SCHEMA public TO app_operator;
GRANT USAGE ON SCHEMA app TO app_operator;
GRANT EXECUTE ON FUNCTION app.current_org() TO app_operator;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. La condición, en la base
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `SECURITY INVOKER` (el defecto) **a propósito**: con `DEFINER`, `current_user`
-- dentro de la función sería el propietario y la comprobación de rol no diría
-- nada. Y el `EXISTS` sobre `journal_entries` se evalúa con la RLS del llamante,
-- que es lo correcto: `app_operator` sólo ve los asientos de su organización.
CREATE OR REPLACE FUNCTION app.operator_reset_allowed()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT current_user = 'app_operator'
     AND app.current_org() IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM "journal_entries" WHERE "organization_id" = app.current_org()
     )
$fn$;

REVOKE ALL ON FUNCTION app.operator_reset_allowed() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.operator_reset_allowed() TO app_runtime, app_operator;

COMMENT ON FUNCTION app.operator_reset_allowed() IS
  'E12 · ADR-0020 D1 — `reset-org` se niega si existe UN SOLO JournalEntry. La negativa vive aquí, en la base, y no en la aplicación: no hay --force que la supere.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Privilegios del operador
--
-- SELECT sobre todo lo de tenant: enumerar antes de borrar es la mitad de la
-- operación (§5.5), y no se puede enumerar lo que no se ve.
-- DELETE sólo sobre las tablas vaciables; las seis de D2 se revocan al final,
-- después del `GRANT ALL`, para que el orden no deje una rendija.
-- ─────────────────────────────────────────────────────────────────────────────
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_operator;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_operator;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- E1/E2 — configuración y catálogo del tenant
    'settings','categories','projects','fields','files','transactions','app_data','progress',
    'invitations','accounts','organization_account_maps','tax_rates','counterparties',
    -- E3 — ejercicio y bloqueos (el DIARIO no: D2)
    'fiscal_years','period_locks',
    -- E4/E5 — analítica y liquidación
    'business_lines','cost_centers','margin_level_configs',
    'allocation_rules','allocation_rule_targets','allocation_runs','allocation_lines',
    -- E6 — informes
    'report_runs','manual_review_flags',
    -- E7 — conciliación y barrido del almacén
    'bank_accounts','bank_statements','bank_statement_lines','bank_match_groups',
    'bank_reconciliations','bank_pending_kinds','store_sweeps',
    -- E8 — camino documental (`extraction_runs` no: D2)
    'prompt_versions','invoice_series',
    -- E9 — cierre, recurrentes y fiscalidad (`closing_runs` no: D2)
    'recurring_entries','recurring_occurrences','fixed_assets','asset_revisions','accruals',
    'debt_schedules','debt_installments','vat_regime_periods','vat_settlements','prorrata_years',
    'reclassification_pairs','profit_distributions',
    -- E10 — presupuesto y horas
    'budgets','budget_lines','budget_hours_lines','time_entries','employees','employee_rates',
    'headcount_snapshots',
    -- E11 — uso, copias y almacén
    'usage_runs','backup_jobs','restore_jobs','stored_objects','onboarding_runs'
  ] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_operator', t);
  END LOOP;
END $$;

-- **D2, sin rendijas.** Las seis tablas prohibidas: el operador SÓLO lee. La
-- única excepción es el `INSERT` en `audit_logs`, que D3 exige —el cliente tiene
-- derecho a ver que alguien de la plataforma tocó algo suyo— y que de todos
-- modos es append-only para todo el mundo.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'journal_entries','journal_lines','audit_logs','extraction_runs','invariant_runs','closing_runs'
  ] LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %I FROM app_operator', t);
  END LOOP;
END $$;
GRANT INSERT ON "audit_logs" TO app_operator;

-- `operator_exceptions` es la traza de lo que el operador hizo: la escribe, no
-- la borra. Misma regla que `audit_logs`.
REVOKE UPDATE, DELETE ON "operator_exceptions" FROM app_operator;
GRANT INSERT ON "operator_exceptions" TO app_operator;
GRANT EXECUTE ON FUNCTION app.revoke_operator_exception(uuid, timestamp(3)) TO app_operator;

-- `platform_audit_logs`: el operador ESCRIBE su propia traza y no puede
-- reescribirla. D3 exige que toda escritura deje motivo, actor y recuentos
-- aquí, y una traza que el actor no puede escribir no es una traza —es un
-- hueco—. La tabla es append-only para todo el mundo (dos políticas RESTRICTIVE
-- desde M3), así que INSERT es todo lo que hace falta y todo lo que se da.
GRANT INSERT ON "platform_audit_logs" TO app_operator;
REVOKE UPDATE, DELETE ON "platform_audit_logs" FROM app_operator;

-- Plataforma: el operador lee y cambia el plan (D1), pero no reescribe nuestra
-- facturación ni la historia de la suscripción.
GRANT UPDATE ON "subscriptions" TO app_operator;
REVOKE INSERT, UPDATE, DELETE ON "platform_invoices" FROM app_operator;
REVOKE UPDATE, DELETE ON "subscription_events" FROM app_operator;
-- `memberships` se conserva: vaciarla dejaría la organización sin dueño.
REVOKE DELETE ON "memberships" FROM app_operator;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Las veintiocho políticas append-only, con una puerta que sólo abre el
--    operador y sólo sobre una organización SIN asientos
--
-- La política sigue siendo `RESTRICTIVE`. Para cualquier rol que no sea
-- `app_operator`, `app.operator_reset_allowed()` devuelve `false` y el efecto es
-- **idéntico** al `USING (false)` de antes: `app_runtime` no puede borrar un
-- `report_run` por ningún camino, igual que ayer.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'allocation_lines','allocation_rule_targets','allocation_rules','allocation_runs',
    'asset_revisions','backup_jobs','bank_match_groups','bank_reconciliations',
    'bank_statement_lines','bank_statements','budgets','business_lines','cost_centers',
    'employee_rates','employees','headcount_snapshots','invoice_series','manual_review_flags',
    'margin_level_configs','onboarding_runs','profit_distributions','prompt_versions',
    'recurring_occurrences','report_runs','restore_jobs','store_sweeps','usage_runs',
    'vat_settlements'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_no_delete', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I AS RESTRICTIVE FOR DELETE USING (app.operator_reset_allowed())',
      t || '_no_delete', t
    );
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4.bis  La guardia, sobre TODAS las tablas vaciables — no sólo las append-only
--
-- Sin esto la puerta quedaba entreabierta: `projects`, `files` o `transactions`
-- **no** tienen política `RESTRICTIVE FOR DELETE`, así que `app_operator` las
-- habría vaciado en una organización CON asientos si la aplicación se hubiera
-- equivocado. Y el criterio 40 dice que la negativa no depende de la aplicación.
--
-- La política es `RESTRICTIVE` y su condición es:
--
--   current_user <> 'app_operator' OR app.operator_reset_allowed()
--
-- Para cualquier otro rol la primera rama es cierta y el comportamiento es
-- **exactamente el de antes** (manda la política permisiva de tenant). Para
-- `app_operator`, el borrado sólo existe si la organización no tiene un solo
-- asiento. No hay bandera, ni confirmación, ni bug que lo supere.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'settings','categories','projects','fields','files','transactions','app_data','progress',
    'invitations','accounts','organization_account_maps','tax_rates','counterparties',
    'fiscal_years','period_locks',
    'business_lines','cost_centers','margin_level_configs',
    'allocation_rules','allocation_rule_targets','allocation_runs','allocation_lines',
    'report_runs','manual_review_flags',
    'bank_accounts','bank_statements','bank_statement_lines','bank_match_groups',
    'bank_reconciliations','bank_pending_kinds','store_sweeps',
    'prompt_versions','invoice_series',
    'recurring_entries','recurring_occurrences','fixed_assets','asset_revisions','accruals',
    'debt_schedules','debt_installments','vat_regime_periods','vat_settlements','prorrata_years',
    'reclassification_pairs','profit_distributions',
    'budgets','budget_lines','budget_hours_lines','time_entries','employees','employee_rates',
    'headcount_snapshots',
    'usage_runs','backup_jobs','restore_jobs','stored_objects','onboarding_runs'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_operator_delete_guard', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I AS RESTRICTIVE FOR DELETE '
      'USING (current_user <> ''app_operator'' OR app.operator_reset_allowed())',
      t || '_operator_delete_guard', t
    );
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4.ter  El inventario que ve `/admin`: una función, no un permiso de lectura
--
-- La lista de organizaciones es lo único de `/admin` que cruza tenants, y la
-- tentación evidente sería dar a `app_operator` un `SELECT` sobre
-- `organizations`, `journal_entries` y `memberships`. **No.** Eso convertiría el
-- panel en una llave para leer el diario de cualquier cliente, y ADR-0020 §9.2
-- dice que el operador ve **cuánto**, no **qué**.
--
-- En su lugar, una función `SECURITY DEFINER` que devuelve EXACTAMENTE los
-- agregados de la pantalla —nombre, plan, recuentos, sello y excepciones vivas—
-- y ni una fila de negocio. Lo que el operador puede obtener es lo que esta
-- función devuelve; no hay una consulta más amplia que hacer.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.operator_organizations(p_ref_date timestamp(3))
RETURNS TABLE (
  id uuid,
  slug text,
  name text,
  is_active boolean,
  is_personal boolean,
  plan_code text,
  subscription_status text,
  journal_entries bigint,
  members bigint,
  last_seal text,
  last_sweep_at timestamp(3),
  live_exceptions bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT o."id", o."slug", o."name", o."is_active", o."is_personal",
         s."plan_code", s."status"::text,
         (SELECT count(*) FROM "journal_entries" je WHERE je."organization_id" = o."id")::bigint,
         (SELECT count(*) FROM "memberships" m     WHERE m."organization_id" = o."id")::bigint,
         ir."seal"::text,
         ir."created_at",
         (SELECT count(*) FROM "operator_exceptions" oe
           WHERE oe."organization_id" = o."id"
             AND oe."revoked_at" IS NULL
             AND oe."expires_at" > p_ref_date)::bigint
    FROM "organizations" o
    LEFT JOIN "subscriptions" s ON s."organization_id" = o."id"
    LEFT JOIN LATERAL (
      SELECT i."seal", i."created_at"
        FROM "invariant_runs" i
       WHERE i."organization_id" = o."id"
       ORDER BY i."created_at" DESC
       LIMIT 1
    ) ir ON true
   ORDER BY (SELECT count(*) FROM "operator_exceptions" oe2
              WHERE oe2."organization_id" = o."id"
                AND oe2."revoked_at" IS NULL
                AND oe2."expires_at" > p_ref_date) DESC,
            o."name" ASC
$fn$;

REVOKE ALL ON FUNCTION app.operator_organizations(timestamp(3)) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.operator_organizations(timestamp(3)) TO app_runtime, app_operator;

COMMENT ON FUNCTION app.operator_organizations(timestamp(3)) IS
  'E12 · ADR-0020 §5.5 — el inventario de /admin. Devuelve AGREGADOS (cuánto), nunca filas de negocio (qué). Quien autoriza es requirePlatformAdmin(); esta función existe para que el operador no necesite SELECT sobre el diario de nadie.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Verificación — la migración comprueba lo que promete
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE faltan text;
BEGIN
  -- (a) las seis prohibidas: el operador NO escribe (salvo el INSERT de D3).
  SELECT string_agg(format('%s:%s', table_name, privilege_type), ', ')
    INTO faltan
    FROM information_schema.table_privileges
   WHERE grantee = 'app_operator'
     AND table_name IN ('journal_entries','journal_lines','extraction_runs','invariant_runs','closing_runs')
     AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE');
  IF faltan IS NOT NULL THEN
    RAISE EXCEPTION 'app_operator conserva escritura sobre tablas prohibidas por ADR-0020 D2: %', faltan;
  END IF;

  SELECT string_agg(privilege_type, ', ')
    INTO faltan
    FROM information_schema.table_privileges
   WHERE grantee = 'app_operator' AND table_name = 'audit_logs'
     AND privilege_type IN ('UPDATE','DELETE','TRUNCATE');
  IF faltan IS NOT NULL THEN
    RAISE EXCEPTION 'app_operator puede modificar audit_logs (%): sólo puede INSERTAR', faltan;
  END IF;

  -- (b) `journal_entries` y `journal_lines` conservan su DELETE absoluto.
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename IN ('journal_entries','journal_lines','audit_logs','extraction_runs','invariant_runs','closing_runs')
       AND permissive = 'RESTRICTIVE' AND cmd = 'DELETE'
       AND qual <> 'false'
  ) THEN
    RAISE EXCEPTION 'una de las seis tablas de ADR-0020 D2 ha perdido su DELETE absoluto';
  END IF;

  -- (c) `app_operator` no puede saltarse la RLS por ningún camino.
  IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'app_operator') THEN
    RAISE EXCEPTION 'app_operator tiene BYPASSRLS: ADR-0020 descarta esa alternativa (nº 5)';
  END IF;
  IF (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'app_operator') THEN
    RAISE EXCEPTION 'app_operator puede iniciar sesión: se llega a él con SET LOCAL ROLE, no con una cadena de conexión';
  END IF;
END $$;
