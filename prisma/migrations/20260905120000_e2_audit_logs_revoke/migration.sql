-- E2 · revisión ronda 1 (hallazgos 1 y 13).
--
-- 1) `audit_logs` append-only TAMBIÉN a nivel de PRIVILEGIO.
--
--    La migración `20260905110000_e2_rls` concedía sólo `SELECT, INSERT` sobre
--    `audit_logs` y su comentario afirmaba que con eso `app_runtime` no tenía
--    UPDATE/DELETE. **Ese comentario era falso** y se corrige aquí en lugar de
--    editar una migración ya aplicada: `20260904120300_e1_rls` dejó puesto un
--    `ALTER DEFAULT PRIVILEGES … GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES
--    TO app_runtime`, de modo que TODA tabla creada después por el mismo rol
--    —incluida `audit_logs`— nace con los cuatro privilegios. Conceder un
--    subconjunto no revoca nada.
--
--    Hoy el candado real son las políticas `RESTRICTIVE … USING (false)`, que sí
--    funcionan; esto añade la segunda cerradura que el ADR-0008 daba por hecha,
--    para que el día que alguien añada una política permisiva genérica el
--    registro siga siendo inmutable.
REVOKE UPDATE, DELETE ON "audit_logs" FROM app_runtime;

-- Y que las tablas futuras no vuelvan a heredarlos por defecto sin querer:
-- el default se mantiene (lo necesitan las tablas de negocio de E3), así que la
-- revocación explícita hay que repetirla si alguna vez nace otra tabla-registro.
-- Anotado en docs/ESTADO.md §"Deuda RLS a retirar en E3".

-- 2) Hallazgo 13 — FK del árbol de cuentas con `ON UPDATE CASCADE`.
--
--    `accounts_organization_id_parent_code_fkey` nacía con `NO ACTION` en UPDATE
--    mientras que las otras tres FK compuestas contra `accounts(organization_id,
--    code)` (mapa y las dos de `tax_rates`) usan `CASCADE`. La asimetría no
--    muerde hoy porque en E2 el `code` es inmutable (T-5), pero E3 implementa la
--    recodificación en cascada (R-21) y con `NO ACTION` el UPDATE del padre
--    fallaría dejando la cascada a medias. Se unifica ahora, que la tabla está
--    vacía de historia, y no en medio de la épica que la necesita.
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_organization_id_parent_code_fkey";
ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_organization_id_parent_code_fkey"
  FOREIGN KEY ("organization_id", "parent_code")
  REFERENCES "accounts"("organization_id", "code")
  ON DELETE NO ACTION ON UPDATE CASCADE;
