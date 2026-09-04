-- E2 · T8 — RLS (barrera 2) de las cuatro tablas nuevas. ADR-0008 (APROBADO).
--
-- Mismo patrón que E1 (20260904120300): `USING (organization_id =
-- app.current_org() OR app.current_org() IS NULL)` con la cláusula de escape de
-- ADR-0007, y `WITH CHECK` SIN escape (escribir sin organización fijada está
-- prohibido siempre). Sin `FORCE ROW LEVEL SECURITY`, igual que las tablas de
-- E1: se activa en la misma migración de E3 que retire el escape de las ocho.
--
-- `audit_logs` NO hereda la deuda en UPDATE/DELETE: es append-only (ADR-0008 §3).
-- Un registro de evidencia que se puede editar o borrar no es evidencia. La
-- corrección de un log erróneo es una entrada nueva, nunca una edición.
--
-- Deuda anotada en docs/ESTADO.md §"Deuda RLS a retirar en E3".

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. ENABLE + tenant_isolation en las cuatro tablas
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['accounts', 'organization_account_maps', 'tax_rates', 'audit_logs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (organization_id = app.current_org() OR app.current_org() IS NULL)
        WITH CHECK (organization_id = app.current_org())
    $f$, t);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. audit_logs append-only (ADR-0008 §3)
-- ─────────────────────────────────────────────────────────────────────────────
-- Las políticas son PERMISIVAS y se combinan con OR, así que `tenant_isolation`
-- por sí sola ya autorizaría un UPDATE. Se restringe con políticas RESTRICTIVE
-- (se combinan con AND): ninguna fila de `audit_logs` es actualizable ni
-- borrable por nadie que no sea propietario de la tabla.
CREATE POLICY audit_logs_no_update ON "audit_logs" AS RESTRICTIVE FOR UPDATE USING (false);
CREATE POLICY audit_logs_no_delete ON "audit_logs" AS RESTRICTIVE FOR DELETE USING (false);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Privilegios del rol de runtime
-- ─────────────────────────────────────────────────────────────────────────────
-- `ALTER DEFAULT PRIVILEGES` de E1 sólo alcanza a las tablas creadas por el
-- MISMO rol que lo ejecutó; se conceden explícitamente para no depender de ello.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "accounts", "organization_account_maps", "tax_rates" TO app_runtime;
-- audit_logs: sin UPDATE ni DELETE tampoco a nivel de privilegio (defensa en
-- profundidad: si algún día se añadiera una política permisiva, el GRANT sigue
-- negando). El borrado en cascada al eliminar la organización lo hace la FK,
-- que se evalúa con los permisos del propietario de la tabla.
GRANT SELECT, INSERT ON "audit_logs" TO app_runtime;
