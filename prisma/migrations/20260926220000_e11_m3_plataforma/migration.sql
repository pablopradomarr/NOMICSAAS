-- E11 · ola A — **M3**: `cron_runs`, `rate_limit_buckets`, `platform_audit_logs`
-- (docs/design/E11-plataforma-saas.md §2.6, §7.2, §9.2/§9.3/§9.5; ADR-0019 D4).
--
-- `onboarding_runs` NO está aquí: lo trae la ola C con `Organization.is_demo` y
-- las preferencias de D-3 (`20260926090000_e11_onboarding_demo_preferencias`).
-- Dos olas nunca tocan la misma tabla (§16).
--
-- Aditiva pura y ejecutable por un rol NO superusuario: tres `CREATE TABLE`
-- vacíos, sus índices y sus políticas. Sin backfill, así que sin baile
-- `NO FORCE` → backfill → `FORCE`.
--
-- **Las tres van SIN `organization_id`, y por tanto FUERA de `TENANT_MODELS`**
-- (§9.5). No es un descuido: si estuvieran, `tenantDb` les inyectaría un filtro
-- por una columna que no existe y toda lectura fallaría — el aviso que ADR-0014
-- D7 dejó escrito. Son tablas de PLATAFORMA: el reloj no es de nadie, el cubo de
-- rate limit se llena antes de saber quién llama, y un webhook cuyo cliente no
-- resuelve es justamente la fila que hay que poder ver.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. `cron_runs` — idempotencia del reloj (I-E11-12)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE "cron_runs" (
  "id"          uuid          NOT NULL DEFAULT gen_random_uuid(),
  "job"         varchar(48)   NOT NULL,
  -- Clave de periodo del job: `recurring-due:2026-09-26`, `backup-worker:
  -- 2026-09-26T10:05`. La calcula `periodKeyOf` (lib/platform/cron.ts, PURA) a
  -- partir del `refDate`, nunca del reloj de la máquina.
  "period_key"  varchar(24)   NOT NULL,
  "status"      "cron_status" NOT NULL DEFAULT 'RUNNING',
  -- **O-13** · la fecha de referencia con la que se invocó. Un asiento generado
  -- por el reloj tiene que poder explicar con qué `refDate` se fechó: el job
  -- lanzado con dos días de retraso produce el MISMO asiento y el mismo
  -- `inputHash` (criterio 49), y eso sólo es auditable si la fecha se persiste.
  "ref_date"    date          NOT NULL,
  "cursor"      jsonb,
  "processed"   integer       NOT NULL DEFAULT 0,
  "failed"      integer       NOT NULL DEFAULT 0,
  "error"       varchar(1024),
  "started_at"  timestamp(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" timestamp(3),
  CONSTRAINT "cron_runs_pkey" PRIMARY KEY ("id")
);

-- LA garantía de idempotencia: la ruta INSERTA primero; si choca, devuelve
-- `200 {skipped:true}` y no ejecuta nada (§7.2). Dos invocaciones simultáneas
-- del mismo periodo producen las mismas ocurrencias que una sola (criterio 48).
CREATE UNIQUE INDEX "cron_runs_job_period_key_key" ON "cron_runs" ("job", "period_key");
CREATE INDEX "cron_runs_job_started_at_idx" ON "cron_runs" ("job", "started_at" DESC);

ALTER TABLE "cron_runs" ADD CONSTRAINT "cron_runs_contadores_no_negativos"
  CHECK ("processed" >= 0 AND "failed" >= 0);
-- Un job terminado tiene hora de fin; uno en curso, no. Sin esto, `/api/health`
-- no puede distinguir «corriendo» de «murió sin cerrar la fila».
ALTER TABLE "cron_runs" ADD CONSTRAINT "cron_runs_fin_coherente"
  CHECK (("status" = 'RUNNING') = ("finished_at" IS NULL));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. `rate_limit_buckets` — cierra **D-10** (ADR-0017 R4)
--
--    El rate limit dejaba de existir al reiniciar el proceso y no se compartía
--    entre réplicas: seis intentos repartidos entre dos réplicas contaban como
--    tres y tres (criterio 57).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE "rate_limit_buckets" (
  "id"         uuid         NOT NULL DEFAULT gen_random_uuid(),
  "scope"      varchar(48)  NOT NULL,
  -- §9.2 · SIEMPRE un sha256: `sha256(email)` o `sha256(ip)`, nunca el valor en
  -- claro. Un cubo de rate limit no es sitio para PII.
  "key"        varchar(64)  NOT NULL,
  "window_at"  timestamp(3) NOT NULL,
  "count"      integer      NOT NULL DEFAULT 0,
  "expires_at" timestamp(3) NOT NULL,
  CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rate_limit_buckets_scope_key_window_at_key"
  ON "rate_limit_buckets" ("scope", "key", "window_at");
-- El job `retention` barre por aquí (§7.1).
CREATE INDEX "rate_limit_buckets_expires_at_idx" ON "rate_limit_buckets" ("expires_at");

ALTER TABLE "rate_limit_buckets" ADD CONSTRAINT "rate_limit_buckets_contador_no_negativo"
  CHECK ("count" >= 0);
-- Los 64 hex de un sha256, ni uno más ni uno menos. El CHECK es la barrera que
-- impide que un descuido meta un email en claro en la columna.
ALTER TABLE "rate_limit_buckets" ADD CONSTRAINT "rate_limit_buckets_clave_es_sha256"
  CHECK ("key" ~ '^[0-9a-f]{64}$');
ALTER TABLE "rate_limit_buckets" ADD CONSTRAINT "rate_limit_buckets_ventana_coherente"
  CHECK ("expires_at" > "window_at");

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. `platform_audit_logs` — append-only, patrón RESTRICTIVE de `audit_logs`
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE "platform_audit_logs" (
  "id"              uuid         NOT NULL DEFAULT gen_random_uuid(),
  "at"              timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- "stripe" | "cron" | "operator:<sha256>". Nunca un email.
  "actor"           varchar(64)  NOT NULL,
  "action"          varchar(64)  NOT NULL,
  -- OPCIONAL a propósito: un webhook cuyo cliente no resuelve (`ORPHAN_WEBHOOK`)
  -- es justamente la fila que hay que poder ver.
  "organization_id" uuid,
  "detail"          jsonb        NOT NULL,
  CONSTRAINT "platform_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "platform_audit_logs_at_idx" ON "platform_audit_logs" ("at" DESC);
CREATE INDEX "platform_audit_logs_organization_id_at_idx"
  ON "platform_audit_logs" ("organization_id", "at" DESC);

-- Sin FK a `organizations`: la fila huérfana es el caso de uso. Un `ON DELETE
-- SET NULL` tampoco valdría, porque no existe borrado de organización (O-11).

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RLS y privilegios
--
--    Las tres llevan `ENABLE` + `FORCE` con políticas explícitas: el test de
--    «ninguna tabla en NO FORCE» (ADR-0009 §7) las cubre igual que a las de
--    tenant. Que no tengan `organization_id` no las deja fuera de la barrera.
-- ─────────────────────────────────────────────────────────────────────────────

-- `cron_runs`: la ruta autenticada las crea y las avanza (cursor, contadores,
-- estado). No se borran: la edad del último run es lo que `/api/health` enseña.
ALTER TABLE "cron_runs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cron_runs_read"      ON "cron_runs" FOR SELECT USING (true);
CREATE POLICY "cron_runs_insert"    ON "cron_runs" FOR INSERT WITH CHECK (true);
CREATE POLICY "cron_runs_update"    ON "cron_runs" FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "cron_runs_no_delete" ON "cron_runs" AS RESTRICTIVE FOR DELETE USING (false);
ALTER TABLE "cron_runs" FORCE ROW LEVEL SECURITY;
REVOKE DELETE ON "cron_runs" FROM app_runtime;
GRANT SELECT, INSERT, UPDATE ON "cron_runs" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "cron_runs" TO app_maintenance;

-- `rate_limit_buckets`: el único de los tres que SÍ se borra — es un cubo, no un
-- registro. Lo barre el job `retention` (§7.1).
ALTER TABLE "rate_limit_buckets" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rate_limit_buckets_all" ON "rate_limit_buckets" USING (true) WITH CHECK (true);
ALTER TABLE "rate_limit_buckets" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "rate_limit_buckets" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "rate_limit_buckets" TO app_maintenance;

-- `platform_audit_logs`: APPEND-ONLY, como `audit_logs` desde ADR-0008. El
-- `REVOKE` va ANTES del `GRANT` porque `ALTER DEFAULT PRIVILEGES` ya concedió
-- `arwd`; sin él la política restrictiva sería lo único que sostiene el
-- append-only y la prueba de privilegio pasaría por vacuidad.
ALTER TABLE "platform_audit_logs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "platform_audit_logs_read"   ON "platform_audit_logs" FOR SELECT USING (true);
CREATE POLICY "platform_audit_logs_insert" ON "platform_audit_logs" FOR INSERT WITH CHECK (true);
CREATE POLICY "platform_audit_logs_no_update" ON "platform_audit_logs"
  AS RESTRICTIVE FOR UPDATE USING (false);
CREATE POLICY "platform_audit_logs_no_delete" ON "platform_audit_logs"
  AS RESTRICTIVE FOR DELETE USING (false);
ALTER TABLE "platform_audit_logs" FORCE ROW LEVEL SECURITY;
REVOKE UPDATE, DELETE ON "platform_audit_logs" FROM app_runtime;
GRANT SELECT, INSERT ON "platform_audit_logs" TO app_runtime;
-- Ni `app_maintenance` puede reescribir la auditoría de plataforma: la política
-- RESTRICTIVE aplica a todo rol sin BYPASSRLS y el privilegio tampoco se da.
REVOKE UPDATE, DELETE ON "platform_audit_logs" FROM app_maintenance;
GRANT SELECT, INSERT ON "platform_audit_logs" TO app_maintenance;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Verificación: ninguna tabla queda en NO FORCE (ADR-0009 §7)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cron_runs', 'rate_limit_buckets', 'platform_audit_logs'] LOOP
    IF NOT (SELECT relforcerowsecurity FROM pg_class WHERE relname = t) THEN
      RAISE EXCEPTION '% ha quedado en NO FORCE ROW LEVEL SECURITY', t;
    END IF;
  END LOOP;
END $$;
