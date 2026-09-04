# ADR-0008 — RLS de las tablas de E2 y `audit_logs` append-only

**Estado:** APROBADO por Pablo el 2026-09-04 (permiso general delegado) · **Nivel:** 2 · **Fecha:** 2026-09-04 · **Épica:** E2 · **Diseño:** `docs/design/E2-plan-cuentas.md`

## Contexto
E2 crea cuatro tablas de negocio nuevas (`accounts`, `organization_account_maps`, `tax_rates`, `audit_logs`) y la FK compuesta `(organization_id, code)` sobre la que E3 anclará `journal_lines`. Tocar RLS y esquema de sistema es Nivel 2 (CLAUDE.md), aunque la épica en conjunto sea de configuración.

ADR-0002 exige RLS en toda tabla con `organization_id`. ADR-0007 aceptó, hasta E3, la cláusula de escape `OR app.current_org() IS NULL` en el `USING` y no activar `FORCE ROW LEVEL SECURITY`, porque el código heredado no corre siempre dentro de `tenantTransaction`. `audit_logs` es distinta del resto: es un registro de evidencia, y un registro que se puede editar o borrar no es evidencia.

## Decisión
1. Las cuatro tablas se crean con `ENABLE ROW LEVEL SECURITY` y política `tenant_isolation` **idéntica al patrón de E1**: `USING (organization_id = app.current_org() OR app.current_org() IS NULL)` y `WITH CHECK (organization_id = app.current_org())` (el `WITH CHECK` nunca lleva escape). Sin `FORCE`, igual que las tablas de E1.
2. La deuda que esto añade (cuatro tablas más con escape) se anota en `docs/ESTADO.md` §"Deuda RLS a retirar en E3" y **se retira en la misma migración de E3** que retire la de E1, no más tarde.
3. `audit_logs` es **append-only en la barrera 2**: además de `tenant_isolation` para `SELECT`/`INSERT`, lleva políticas `FOR UPDATE USING (false)` y `FOR DELETE USING (false)`. Ni `app_runtime` ni la aplicación pueden modificar ni borrar una entrada. La corrección de un log erróneo es una entrada nueva, nunca una edición.
4. La FK compuesta `(organization_id, parent_code) → accounts(organization_id, code)` y el `@@unique([organizationId, code])` que la sostiene se crean en E2 porque son el destino de la FK compuesta de `journal_lines` en E3: es la barrera de BD que impide que una línea de asiento apunte a una cuenta de otra organización (I10).
5. Restricción de vigencia de `tax_rates` por `EXCLUDE USING gist (organization_id WITH =, code WITH =, daterange(valid_from, valid_to, '[]') WITH &&)` (extensión `btree_gist`), no solo por código de aplicación. Se acompaña de `CHECK (rate_bps BETWEEN 0 AND 10000)` y `CHECK (kind = 'EXENTO' ⇒ rate_bps = 0)`.
6. **Ronda 2 (validación contable).** Las tablas llevan las columnas que el experto exige (`accounts.bidirectional`, `accounts.is_contra`, `accounts.epigraph_pymes`; `tax_rates.rate_bps` en lugar de `rate_permille`, `applies_to`, `linked_tax_rate_id`) y el modelo Prisma de la cuenta contable se llama `LedgerAccount` — better-auth conserva `Account`. **Nada de esto cambia el alcance de RLS**: las políticas siguen siendo por `organization_id` y la tabla física sigue llamándose `accounts`, que es el nombre que usa este ADR y todo el SQL posterior.

## Alternativas descartadas
- **RLS estricta ya en las tablas nuevas** (sin escape, con `FORCE`): tendría dos regímenes distintos conviviendo, y `createOrganizationDefaults` siembra el plan desde caminos que en parte son heredados. Se prefiere un solo patrón, retirado de golpe en E3.
- **`audit_logs` sin políticas de UPDATE/DELETE** (denegadas por ausencia de política): funciona hoy porque no hay `FORCE`, pero deja de funcionar en cuanto alguien añada una política permisiva genérica. Se prefiere el `USING (false)` explícito.
- **Borrado físico de cuentas siempre prohibido por RLS** (`FOR DELETE USING (false)` también en `accounts`): E2 exige poder borrar una cuenta sin movimientos. La condición ("sin movimientos, sin hijos, no mapeada, no de sistema") es demasiado rica para una política y vive en `canDeleteAccount` + FK `ON DELETE RESTRICT`.

## Consecuencias
- Durante E2 hay ocho tablas de negocio con escape en el `USING`; la barrera 1 (`tenantDb`) sigue siendo la que filtra de verdad en las lecturas que no abren transacción.
- El registro de auditoría es inmutable desde el primer día, así que E7 puede apoyarse en él sin cualificaciones.
- E3 hereda una tarea concreta y acotada: una migración que retire el escape de las ocho tablas, active `FORCE` y ajuste el `WITH CHECK` de `organizations`.
