-- E11 · ola C · T12 / T14 / T21 — `onboarding_runs`, la marca de demo, las
-- preferencias de organización (D-3) y el índice del calendario de `/time` (D-8).
-- (docs/design/E11-plataforma-saas.md §2.6, §6, §12 techo 10.)
--
-- **Por qué esta migración y no M3/M4.** El plan de olas (§16) reparte M1/M3/M4/M5
-- a la ola A. Esta migración trae ÚNICAMENTE lo que la ola C necesita para existir
-- —la tabla del asistente, las tres columnas de `Organization` y un índice— y está
-- escrita **idempotente** (`IF NOT EXISTS` / `DO $$` con guarda) para que M3 y M4,
-- cuando lleguen, no choquen: la que corra segunda no hace nada. Ninguna cifra se
-- toca, así que no hace falta el baile `NO FORCE` → backfill → `FORCE`.
--
-- Aditiva pura y ejecutable por un rol NO superusuario.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Enums
-- ─────────────────────────────────────────────────────────────────────────────

-- Seis pasos (§6.2). El de facturación se fusiona con el de empresa: la serie se
-- siembra en el paso 1 (O-7a) y sólo se renombra mientras no haya números.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'onboarding_step') THEN
    CREATE TYPE "onboarding_step" AS ENUM ('COMPANY', 'PLAN_ACCOUNTS', 'FISCAL_YEAR', 'MEMBERS', 'DEMO', 'DONE');
  END IF;
END $$;

-- D-3: preferencia de organización, no un cálculo. Por defecto `MES_SIGUIENTE`,
-- que es lo que el motor de E9 ya hace — cambiar el valor por defecto alteraría
-- cuadros ya posteados, y eso no se hace en una épica de plataforma.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'depreciation_start') THEN
    CREATE TYPE "depreciation_start" AS ENUM ('MES_DE_ALTA', 'MES_SIGUIENTE');
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. `organizations`: la marca de demo y las dos preferencias
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "is_demo"                boolean              NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "depreciation_starts_on" "depreciation_start" NOT NULL DEFAULT 'MES_SIGUIENTE',
  ADD COLUMN IF NOT EXISTS "backup_retention_days"  integer              NOT NULL DEFAULT 30;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_backup_retention_days_range'
  ) THEN
    ALTER TABLE "organizations"
      ADD CONSTRAINT "organizations_backup_retention_days_range"
        CHECK ("backup_retention_days" BETWEEN 1 AND 3650);
  END IF;
END $$;

-- **O-6 · `isDemo` es INMUTABLE.** No es una etiqueta: decide si la organización
-- entra en el uso facturable, si cuenta contra `maxOrganizations` y si se puede
-- borrar entera. Si se pudiera cambiar, «vaciar la demo» se convertiría en un
-- camino para borrar asientos posteados de una organización real, que es
-- exactamente lo que ADR-0003 y el art. 30 CCom prohíben. Lo impide un trigger,
-- no la aplicación: un control que sólo vive en el navegador no es un control.
CREATE OR REPLACE FUNCTION app.organizations_is_demo_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."is_demo" IS DISTINCT FROM OLD."is_demo" THEN
    RAISE EXCEPTION 'La marca de demo de una organización es inmutable (O-6): % → %',
      OLD."is_demo", NEW."is_demo"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "organizations_is_demo_immutable" ON "organizations";
CREATE TRIGGER "organizations_is_demo_immutable"
  BEFORE UPDATE ON "organizations"
  FOR EACH ROW EXECUTE FUNCTION app.organizations_is_demo_immutable();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. `onboarding_runs` — el estado del asistente (§2.6)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "onboarding_runs" (
  "id"                   uuid              NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"      uuid              NOT NULL,
  "step"                 "onboarding_step" NOT NULL DEFAULT 'COMPANY',
  "completed_at"         timestamp(3),
  "pgc_variant"          "pgc_variant"     NOT NULL,
  -- **O-6**: la organización de DEMO que se creó desde este asistente, si se
  -- creó. La demo nunca vive dentro de la organización del cliente.
  "demo_organization_id" uuid,
  -- Qué se sembró, pieza a pieza: es la primera prueba que el producto le da al
  -- cliente de que sabe lo que hace (§10), y la que I-E11-10 vuelve a comprobar.
  "seed_report"          jsonb,
  "created_at"           timestamp(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           timestamp(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "onboarding_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "onboarding_runs_organization_id_key"
  ON "onboarding_runs" ("organization_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'onboarding_runs_organization_id_fkey') THEN
    ALTER TABLE "onboarding_runs"
      ADD CONSTRAINT "onboarding_runs_organization_id_fkey"
        FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id") ON DELETE CASCADE;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RLS estricta (ADR-0009) y privilegios
-- ─────────────────────────────────────────────────────────────────────────────

-- `onboarding_runs` lleva `organization_id`: nace con la política estricta Y entra
-- en `TENANT_MODELS` (lib/db.ts). Sin las dos cosas, una consulta fuera de
-- `tenantDb` devuelve VACÍO en silencio.
SELECT app.enforce_tenant_rls('onboarding_runs');

GRANT SELECT, INSERT, UPDATE ON "onboarding_runs" TO app_runtime;

-- Un asistente no se borra: se completa. Se conserva porque I-E11-10 lo exige
-- como una de las nueve piezas de toda organización activa.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'onboarding_runs' AND policyname = 'onboarding_runs_no_delete') THEN
    CREATE POLICY "onboarding_runs_no_delete" ON "onboarding_runs" AS RESTRICTIVE FOR DELETE USING (false);
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. D-8 — el índice del calendario de `/time` (§12, techo 10)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- El calendario agrega por **(empleado, día)**, no por (receptor, mes): el índice
-- de cobertura de E10 (`time_entries_org_date_cover`) sirve al agregado del
-- ejercicio, pero deja el `GROUP BY employee_id, date` ordenando 5 500 filas
-- (250 empleados × 22 días) por una columna que no está en la clave. Con
-- `employee_id` en la clave el escaneo vuelve a ser *index-only* y el techo de
-- 400 ms se cumple con UNA consulta agregada.
CREATE INDEX IF NOT EXISTS "time_entries_org_date_employee_cover"
  ON "time_entries" ("organization_id", "date", "employee_id")
  INCLUDE ("minutes", "status", "project_id", "cost_center_id");
