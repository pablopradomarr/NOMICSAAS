-- E11 · ronda 1 — **H-8 del auditor / PUEDE 13 del revisor**: `platform_audit_logs`
-- deja de ser legible por cualquier tenant.
--
-- M3 la creó con `FOR SELECT USING (true)`: cualquier sesión `app_runtime` veía
-- las líneas de TODAS las organizaciones. Hoy no es explotable —`listPlatformAudit`
-- no tiene llamante en `app/` ni en `components/`—, pero es una fuga latente en
-- cuanto alguien pinte la familia `PLATAFORMA` de /audit que §3.5 promete, y T20
-- acaba de escribir ese camino: `models/platform-invariants.ts` lee esta tabla
-- para I-E11-4(b).
--
-- La política nueva es la que el propio revisor propone:
--
--   organization_id IS NULL OR organization_id = app.current_org()
--
-- Las filas **sin organización** (`ORPHAN_WEBHOOK`, arranques del cron) siguen
-- siendo legibles: no son de nadie y perderlas dejaría ciega la traza de
-- plataforma. Las de una organización, sólo desde esa organización.
--
-- El `INSERT` no cambia: escribe el motor, y una excepción automática de una
-- organización se registra desde su propia sesión. `app_maintenance`
-- (`BYPASSRLS`) sigue viéndolo todo, que es para lo que existe el rol de
-- operador (ADR-0009 §6).
--
-- APPEND-ONLY intacto: las dos políticas `RESTRICTIVE` de UPDATE/DELETE y los
-- `REVOKE` de M3 no se tocan.
--
-- Ejecutable por un rol NO superusuario: `CREATE/DROP POLICY` lo puede el
-- propietario de la tabla. No mueve una sola fila.

DROP POLICY IF EXISTS "platform_audit_logs_read" ON "platform_audit_logs";
CREATE POLICY "platform_audit_logs_read" ON "platform_audit_logs"
  FOR SELECT USING ("organization_id" IS NULL OR "organization_id" = app.current_org());

-- Verificación: la tabla sigue en FORCE y conserva sus cuatro políticas.
DO $$
BEGIN
  IF NOT (SELECT relforcerowsecurity FROM pg_class WHERE relname = 'platform_audit_logs') THEN
    RAISE EXCEPTION 'platform_audit_logs ha quedado en NO FORCE ROW LEVEL SECURITY';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE tablename = 'platform_audit_logs') <> 4 THEN
    RAISE EXCEPTION 'platform_audit_logs no tiene las cuatro políticas esperadas';
  END IF;
END $$;
