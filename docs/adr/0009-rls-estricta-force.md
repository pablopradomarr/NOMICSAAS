# ADR-0009 — RLS estricta: retirada de las cláusulas de escape y `FORCE ROW LEVEL SECURITY`

**Estado:** APROBADO por Pablo el 2026-09-04 (permiso general delegado) · **Nivel:** 2 · **Fecha:** 2026-09-04 · **Épica:** E3 · **Diseño:** `docs/design/E3-libro-diario.md` §2.5, §2.6

## Contexto

ADR-0007 (APROBADO, inmutable) habilitó RLS en E1 con la cláusula de escape `OR app.current_org() IS NULL` en los `USING` y sin `FORCE ROW LEVEL SECURITY`, para no refactorizar 32 ficheros heredados de golpe, y **fijó E3 como fecha de retirada** con un ADR nuevo. ADR-0008 extendió el mismo patrón a las cuatro tablas de E2 y anotó que la retirada sería la misma migración. `docs/ESTADO.md` §"Deuda RLS a retirar en E3" enumera las cinco deudas.

E3 crea el libro diario: las tablas que contienen las cifras. No es aceptable que nazcan conviviendo con dieciséis tablas que cualquier consulta sin GUC lee enteras.

Desde E1-fix, `tenantDb(orgId)` envuelve **cada** operación en una transacción con `app.current_org` / `app.current_user` fijados, así que la mayor parte del código heredado ya cumple. La auditoría de `docs/design/E3-libro-diario.md` §2.6 localizó los casos que **no**: `models/organizations.ts`, `models/memberships.ts` (los usa `getOrgContext` en cada petición: sin escape, nadie tendría organización ni rol), `models/invitations.ts` (búsqueda por token, sin organización activa por definición), `lib/email-sync/ingest.ts` (barrido cross-org deliberado del cron) y `scripts/migrate-uploads-to-org.ts` (script de operador).

## Decisión

1. **Se retira `OR app.current_org() IS NULL`** de los `USING` de las dieciséis tablas de negocio de E1 y E2. La política queda `USING (organization_id = app.current_org()) WITH CHECK (organization_id = app.current_org())`. `currencies` conserva su rama de catálogo global (`organization_id IS NULL`).
2. **Se retira `OR app.current_user() IS NOT NULL`** del `WITH CHECK` de `organizations`, y el escape doble-NULL de `organizations` y `memberships`. El alta de organización pasa por un único camino (`createOrganizationWithOwner`) que fija `app.current_org` con el uuid que acaba de generar, y E3 lo unifica además con la siembra en una sola `tenantTransaction`.
3. **`FORCE ROW LEVEL SECURITY` en las veinte tablas de negocio** (12 de E1 + 4 de E2 + 4 de E3). Consecuencia buscada: `audit_logs` y `journal_lines` pasan a ser inmutables también para el propietario de las tablas.
4. **Las cuatro tablas de E3** (`fiscal_years`, `period_locks`, `journal_entries`, `journal_lines`) nacen con política estricta, `FORCE`, `RESTRICTIVE … FOR DELETE USING (false)` en las dos del diario y `RESTRICTIVE … FOR UPDATE USING (false)` en `journal_lines`. El único `UPDATE` admitido en todo el diario es el de las tres columnas informativas de anulación de `journal_entries`, concedido por GRANT de columna.
5. **Dos puertas estrechas en lugar de un escape general.** Los dos accesos que ninguna política puede autorizar se resuelven con funciones `SECURITY DEFINER` acotadas y con `GRANT EXECUTE` explícito a `app_runtime`: `app.invitation_by_token_hash(text)` (aceptar una invitación) y `app.list_email_sync_targets()` (el cron enumera `(organization_id, user_id)` y luego acota cada iteración).
6. **Rol `app_maintenance`** (`BYPASSRLS`, `NOLOGIN` por defecto, credencial entregada por el operador) para lo que legítimamente necesita ver más de una organización: los scripts de operador (`scripts/migrate-uploads-to-org.ts`, backfills) y **el check del invariante I10**, que solo puede detectar un cruce entre organizaciones si consulta sin filtro de tenant — de ahí que `scripts/run-invariants.ts` sea el otro consumidor previsto. Un privilegio nominal y auditable sustituye a un agujero en la política. La aplicación web nunca conecta con este rol.
7. **Patrón obligatorio para migraciones con backfill** bajo `FORCE`: `ALTER TABLE x NO FORCE ROW LEVEL SECURITY; … ; ALTER TABLE x FORCE ROW LEVEL SECURITY;` dentro de la misma migración (DDL transaccional), o ejecutarlo como `app_maintenance`. Se documenta en `CLAUDE.md` y un test comprueba que ninguna tabla de negocio queda en `NO FORCE`.
8. **Condición de mezcla.** La migración no se aplica hasta que `test:integration:rls` —ampliada a **todos** los `models/`— pase en verde como `app_runtime`: login, switcher, invitaciones, sync de email y siembra de plan incluidos. El refactor previo (§2.6) se despliega **antes**, por separado, y no cambia comportamiento.

## Alternativas descartadas

- **Mantener el escape una épica más.** Dejaría el libro diario conviviendo con dieciséis tablas legibles sin GUC durante E3 y E4. ADR-0007 ya fijó la fecha y el trabajo real está acotado.
- **Escape condicional por GUC de mantenimiento** (`app.bypass = on`). Un interruptor así acaba encendido en algún camino de producción y no deja rastro. Un rol con `BYPASSRLS` y credencial propia sí.
- **Dar `BYPASSRLS` al rol de migraciones.** Simplificaría los backfills, pero anularía el punto 3: `audit_logs` volvería a ser editable por el propietario y el registro dejaría de ser evidencia.
- **`FORCE` solo en el diario y en `audit_logs`.** Dejaría dos regímenes conviviendo, que es justo lo que ADR-0008 quiso evitar.

## Consecuencias

- Desaparece la posibilidad de fuga cross-tenant por una consulta que olvide fijar el GUC: la barrera 2 pasa a filtrar de verdad, no solo a acompañar.
- Cinco deudas de `docs/ESTADO.md` se cierran de una vez; la sexta (una transacción por operación en `tenantDb`) deja de ser deuda de seguridad y queda como coste conocido, acotado en `docs/design/E3-libro-diario.md` §2.6.
- Cualquier código nuevo que lea una tabla de negocio fuera de `tenantDb`/`tenantTransaction`/`withTenantGucs` **falla en silencio devolviendo vacío**, no con un error. La red contra eso es la regla ESLint `no-restricted-syntax` y la suite `test:integration:rls` completa; ambas son obligatorias en CI a partir de E3.
