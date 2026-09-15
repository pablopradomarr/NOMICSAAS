-- E11 · ola B — M2: `usage_runs`, `backup_jobs`, `restore_jobs`, `stored_objects`
-- (docs/design/E11-plataforma-saas.md §2.3, §2.4, §2.5; ADR-0019 D2 y D3).
--
-- **Aditiva pura y ejecutable por un rol NO superusuario**: ni `ALTER ROLE`, ni
-- `ALTER FUNCTION … OWNER TO`, ni extensiones nuevas. Las cuatro tablas nacen
-- VACÍAS, así que no hay backfill y no hace falta el baile
-- `NO FORCE` → backfill → `FORCE` de `CLAUDE.md`.
--
-- M1/M3/M4/M5 (planes, suscripciones, plataforma, facturación) son de la ola A y
-- llevan sus propios timestamps `20260926*`: esta migración no las toca.
--
-- Append-only, y por qué en cada tabla:
--   · `usage_runs`   — caché derivada (patrón `report_runs`): se inserta y se
--                      lee; reescribir una cifra de uso ya servida es
--                      exactamente lo que P6 prohíbe. Append-only PURO.
--   · `backup_jobs`  — el job es evidencia: se insertan y sólo avanzan las
--                      columnas de progreso y de resultado (GRANT DE COLUMNA,
--                      patrón `allocation_runs`). Nunca DELETE: la caducidad
--                      borra el OBJETO y pasa la fila a `EXPIRED` (§5.5).
--   · `restore_jobs` — idem: progreso, verificación y desenlace.
--   · `stored_objects` — localización de bytes; sólo `verified_at` se reescribe
--                      (`StoreSweep`). El borrado del objeto en el almacén no
--                      borra la fila: se conserva la traza.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Enums
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "backup_status"  AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'EXPIRED');
-- `SCHEDULED` queda declarado para el job `backup-schedule` que §0.3 aplaza a
-- E12. Como `EXIT`, no consume cuota; el uso derivado sólo cuenta `MANUAL`.
CREATE TYPE "backup_trigger" AS ENUM ('MANUAL', 'SCHEDULED', 'EXIT');
-- O-2: `DONE` queda reservado a `verified = true`.
CREATE TYPE "restore_status" AS ENUM ('QUEUED', 'RUNNING', 'VERIFYING', 'DONE', 'DONE_UNVERIFIED', 'FAILED');
CREATE TYPE "storage_backend" AS ENUM ('LOCAL', 'SUPABASE', 'S3');
CREATE TYPE "stored_object_kind" AS ENUM ('DOCUMENT', 'PREVIEW', 'BACKUP', 'LOGO', 'AVATAR', 'PLATFORM_INVOICE');

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. `usage_runs` — el uso es una VISTA; esto es su caché por `source_hash`
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "usage_runs" (
  "id"              uuid         NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" uuid         NOT NULL,
  -- Mes natural en la zona de la organización, primer día. Nunca `now()`.
  "period_month"    date         NOT NULL,
  "source_hash"     varchar(64)  NOT NULL,
  "git_sha"         varchar(40)  NOT NULL,
  "members"         integer      NOT NULL,
  "entries"         integer      NOT NULL,
  "ocr_docs"        integer      NOT NULL,
  "exports"         integer      NOT NULL,
  "backups"         integer      NOT NULL,
  -- `bigint`: un plan PRO son 100 GB y `integer` techa en 2,1 GB.
  "storage_bytes"   bigint       NOT NULL,
  "computed_at"     timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "duration_ms"     integer      NOT NULL,
  CONSTRAINT "usage_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "usage_runs_period_month_is_first_day" CHECK (date_part('day', "period_month") = 1),
  CONSTRAINT "usage_runs_non_negative" CHECK (
    "members" >= 0 AND "entries" >= 0 AND "ocr_docs" >= 0 AND
    "exports" >= 0 AND "backups" >= 0 AND "storage_bytes" >= 0
  )
);

CREATE UNIQUE INDEX "usage_runs_cache_key"
  ON "usage_runs" ("organization_id", "period_month", "source_hash", "git_sha");
CREATE INDEX "usage_runs_organization_id_period_month_idx"
  ON "usage_runs" ("organization_id", "period_month");
CREATE UNIQUE INDEX "usage_runs_organization_id_id_key" ON "usage_runs" ("organization_id", "id");

ALTER TABLE "usage_runs"
  ADD CONSTRAINT "usage_runs_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. `backup_jobs`
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "backup_jobs" (
  "id"               uuid             NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"  uuid             NOT NULL,
  "status"           "backup_status"  NOT NULL DEFAULT 'QUEUED',
  "trigger"          "backup_trigger" NOT NULL,
  "progress_bps"     integer          NOT NULL DEFAULT 0,
  "format_version"   varchar(8)       NOT NULL,
  "schema_version"   varchar(16)      NOT NULL,
  "git_sha"          varchar(40)      NOT NULL,
  "object_key"       varchar(512),
  "size_bytes"       bigint,
  "archive_sha256"   varchar(64),
  "manifest_sha256"  varchar(64),
  "signature"        varchar(128),
  "signing_key_id"   varchar(16),
  "ledger_hash"      varchar(64),
  "analytics_key"    varchar(64),
  "budget_hash"      varchar(64),
  "row_counts"       jsonb,
  "error"            varchar(1024),
  "requested_by_id"  uuid,
  "started_at"       timestamp(3),
  "finished_at"      timestamp(3),
  "expires_at"       timestamp(3),
  "download_count"   integer          NOT NULL DEFAULT 0,
  "created_at"       timestamp(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "backup_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "backup_jobs_progress_bps_range" CHECK ("progress_bps" BETWEEN 0 AND 10000),
  -- Un backup `DONE` sin objeto, sin manifest o sin firma no es un backup:
  -- es una fila que miente. La BD lo impide, no sólo la aplicación (P2).
  CONSTRAINT "backup_jobs_done_is_complete" CHECK (
    "status" <> 'DONE' OR (
      "object_key" IS NOT NULL AND "archive_sha256" IS NOT NULL AND
      "manifest_sha256" IS NOT NULL AND "signature" IS NOT NULL AND "signing_key_id" IS NOT NULL
    )
  ),
  CONSTRAINT "backup_jobs_format_version_is_2" CHECK ("format_version" = '2.0')
);

CREATE INDEX "backup_jobs_organization_id_created_at_idx" ON "backup_jobs" ("organization_id", "created_at");
CREATE INDEX "backup_jobs_status_created_at_idx"          ON "backup_jobs" ("status", "created_at");
-- Cuota de `maxBackupsMonth`: el uso derivado cuenta los `MANUAL` del mes.
CREATE INDEX "backup_jobs_usage_idx" ON "backup_jobs" ("organization_id", "trigger", "created_at");
CREATE UNIQUE INDEX "backup_jobs_organization_id_id_key" ON "backup_jobs" ("organization_id", "id");

ALTER TABLE "backup_jobs"
  ADD CONSTRAINT "backup_jobs_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. `restore_jobs`
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "restore_jobs" (
  "id"              uuid             NOT NULL DEFAULT gen_random_uuid(),
  -- Organización DESTINO: es la que acota la RLS de esta fila.
  "organization_id" uuid             NOT NULL,
  "backup_job_id"   uuid,
  "status"          "restore_status" NOT NULL DEFAULT 'QUEUED',
  "progress_bps"    integer          NOT NULL DEFAULT 0,
  "verification"    jsonb,
  "verified"        boolean          NOT NULL DEFAULT false,
  "rejected"        jsonb,
  "error"           varchar(1024),
  "requested_by_id" uuid,
  "started_at"      timestamp(3),
  "finished_at"     timestamp(3),
  "created_at"      timestamp(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "restore_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "restore_jobs_progress_bps_range" CHECK ("progress_bps" BETWEEN 0 AND 10000),
  -- **O-2, en la base y no sólo en el enum.** `DONE` ⇔ `verified`. Un operador
  -- que filtre por DONE no puede leer como bueno lo que el ADR declara FAIL.
  CONSTRAINT "restore_jobs_done_is_verified" CHECK ("verified" = ("status" = 'DONE')),
  -- Y un desenlace verificado o no verificado exige el documento de las seis
  -- comprobaciones: sin `verification` no hay P7 que enseñar.
  CONSTRAINT "restore_jobs_outcome_has_verification" CHECK (
    "status" NOT IN ('DONE', 'DONE_UNVERIFIED') OR "verification" IS NOT NULL
  )
);

CREATE INDEX "restore_jobs_organization_id_created_at_idx" ON "restore_jobs" ("organization_id", "created_at");
CREATE INDEX "restore_jobs_backup_job_id_idx"              ON "restore_jobs" ("backup_job_id");
CREATE UNIQUE INDEX "restore_jobs_organization_id_id_key"  ON "restore_jobs" ("organization_id", "id");

ALTER TABLE "restore_jobs"
  ADD CONSTRAINT "restore_jobs_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restore_jobs"
  ADD CONSTRAINT "restore_jobs_backup_job_id_fkey"
  FOREIGN KEY ("backup_job_id") REFERENCES "backup_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. `stored_objects`
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "stored_objects" (
  "id"              uuid                 NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" uuid                 NOT NULL,
  -- `<STORAGE_PREFIX>/<organizationId>/<kind>/<sha256[0:2]>/<sha256>` (D3).
  "object_key"      varchar(512)         NOT NULL,
  "backend"         "storage_backend"    NOT NULL,
  "sha256"          varchar(64)          NOT NULL,
  "size_bytes"      bigint               NOT NULL,
  "mime_type"       varchar(128)         NOT NULL,
  "kind"            "stored_object_kind" NOT NULL,
  "verified_at"     timestamp(3),
  "created_at"      timestamp(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stored_objects_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stored_objects_size_bytes_non_negative" CHECK ("size_bytes" >= 0),
  -- El sha256 es la identidad del objeto: 64 hex en MINÚSCULA, como
  -- `files.sha256`. Sin esto, el mismo fichero entra dos veces con dos claves.
  CONSTRAINT "stored_objects_sha256_is_hex" CHECK ("sha256" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "stored_objects_organization_id_object_key_key"
  ON "stored_objects" ("organization_id", "object_key");
CREATE INDEX "stored_objects_organization_id_sha256_idx"
  ON "stored_objects" ("organization_id", "sha256");
-- **O-12c**: la cuota se evalúa filtrando por `kind`, no por prefijo. Éste es el
-- índice que sirve esa suma.
CREATE INDEX "stored_objects_organization_id_kind_created_at_idx"
  ON "stored_objects" ("organization_id", "kind", "created_at");
CREATE UNIQUE INDEX "stored_objects_organization_id_id_key" ON "stored_objects" ("organization_id", "id");

ALTER TABLE "stored_objects"
  ADD CONSTRAINT "stored_objects_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. RLS estricta (ADR-0009) y append-only por GRANT DE COLUMNA
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['usage_runs', 'backup_jobs', 'restore_jobs', 'stored_objects'] LOOP
    PERFORM app.enforce_tenant_rls(t);
  END LOOP;
END $$;

-- `usage_runs`: append-only PURO, como `report_runs`.
GRANT SELECT, INSERT ON "usage_runs" TO app_runtime;
REVOKE UPDATE, DELETE ON "usage_runs" FROM app_runtime;
CREATE POLICY "usage_runs_no_update" ON "usage_runs" AS RESTRICTIVE FOR UPDATE USING (false);
CREATE POLICY "usage_runs_no_delete" ON "usage_runs" AS RESTRICTIVE FOR DELETE USING (false);

-- `backup_jobs`: se insertan en `QUEUED` y sólo avanzan. La caducidad borra el
-- OBJETO y escribe `EXPIRED`; la fila nunca se borra (§5.5, I-E11-11).
GRANT SELECT, INSERT ON "backup_jobs" TO app_runtime;
REVOKE UPDATE, DELETE ON "backup_jobs" FROM app_runtime;
GRANT UPDATE (
  "status", "progress_bps", "object_key", "size_bytes", "archive_sha256", "manifest_sha256",
  "signature", "signing_key_id", "ledger_hash", "analytics_key", "budget_hash", "row_counts",
  "error", "started_at", "finished_at", "expires_at", "download_count"
) ON "backup_jobs" TO app_runtime;
CREATE POLICY "backup_jobs_no_delete" ON "backup_jobs" AS RESTRICTIVE FOR DELETE USING (false);

-- `restore_jobs`: ídem. `organization_id` y `backup_job_id` son inmutables: un
-- trabajo de restauración no cambia de destino ni de origen a mitad de camino.
GRANT SELECT, INSERT ON "restore_jobs" TO app_runtime;
REVOKE UPDATE, DELETE ON "restore_jobs" FROM app_runtime;
GRANT UPDATE (
  "status", "progress_bps", "verification", "verified", "rejected", "error",
  "started_at", "finished_at"
) ON "restore_jobs" TO app_runtime;
CREATE POLICY "restore_jobs_no_delete" ON "restore_jobs" AS RESTRICTIVE FOR DELETE USING (false);

-- `stored_objects`: la localización no se reescribe; sólo el barrido sella
-- `verified_at`. El DELETE sí se permite —un objeto retirado del almacén deja de
-- existir como localización— pero lo acota la política de tenant.
GRANT SELECT, INSERT, DELETE ON "stored_objects" TO app_runtime;
REVOKE UPDATE ON "stored_objects" FROM app_runtime;
GRANT UPDATE ("verified_at") ON "stored_objects" TO app_runtime;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Comentarios de tabla (los lee el runbook y la pestaña Auditoría)
-- ─────────────────────────────────────────────────────────────────────────────
COMMENT ON TABLE "usage_runs" IS
  'Caché del uso mensual DERIVADO por agregados SQL (E11 §2.3). Nunca un contador: se invalida por source_hash.';
COMMENT ON TABLE "backup_jobs" IS
  'Exportación ZIP formato 2.0 firmada (E11 §5). trigger EXIT/SCHEDULED no consumen maxBackupsMonth (O-4).';
COMMENT ON TABLE "restore_jobs" IS
  'Restauración SIEMPRE a organización nueva (E11 §5.4). DONE exige las seis comprobaciones; si no, DONE_UNVERIFIED (O-2).';
COMMENT ON TABLE "stored_objects" IS
  'Localización e integridad de los bytes en el almacén (E11 §2.5, ADR-0019 D3). La cuota filtra por kind, no por prefijo (O-12c).';
