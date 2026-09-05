# ESTADO DEL PROYECTO — punto de reanudación

Actualizado: 2026-09-05 (cierre E4) · Repo: `pablopradomarr/NOMICSAAS` rama `main` · Sesión origen: https://claude.ai/code/session_01HZCqGBP589Lkmf3TNgtTvb

## Hecho
| Épica | Estado | Commits |
|---|---|---|
| E0 Base (agentes, docs, ADR 1–7 aprobados, `lib/money.ts`, hook guard) | HECHO salvo CI/Docker | 2168fd7, c3ff192, 83cdf86 |
| E1 T1–T14 (tenancy, roles, RLS con escape, switcher, miembros, invitaciones) | IMPLEMENTADO, **revisión = CAMBIOS REQUERIDOS** | daf199f, 34e41cb, f65f37c, + commit QA |
| E1-fix ronda 1 (3 BLOQUEA + 15 DEBE + PUEDE #19/#20/#21/#24/#25/#26) | IMPLEMENTADO | 143a289 |
| E1-fix ronda 2 (2 BLOQUEA + 7 DEBE + 3 PUEDE de la re-revisión) | IMPLEMENTADO, pendiente de re-revisión | sin commit (working tree) |

QA: PASS condicionado (barrera 1 y authz resisten; migración CA-1 sin test). Revisor: 3 BLOQUEA, 15 DEBE, 8 PUEDE (informe completo en `docs/design/E1-revision.md`, ya con columna "Resolución").

**Sprint E1-fix (2026-09-04) — hecho.** RLS efectiva (`20260904140000_e1_rls_effective`: `app.current_user()`, políticas por pertenencia en `organizations`/`memberships`, `FORCE ROW LEVEL SECURITY`; `tenantDb` fija los GUC en cada operación; `DATABASE_URL`=`app_runtime` / `DIRECT_URL`=owner); ficheros por organización; members ADMIN-only sin escritura en RSC; `NO_ORGANIZATION` → `/organizations/new`; CI con `test:integration` y guard de pureza; validación de subidas; rate limit de invitaciones; aceptación transaccional; Stripe unique + log mínimo. Verificado: `npm run lint` 0 errores, `npx tsc --noEmit` limpio, `npm run test` 107 ✓, `npm run test:integration` 171 ✓, `npm run build` OK.

### Migración de ficheros en disco (obligatoria al desplegar E1-fix)
Las rutas físicas pasan de `uploads/<email>/…` a `uploads/<organizationId>/…`. Antes de arrancar la nueva versión:
```bash
npx tsx scripts/migrate-uploads-to-org.ts            # simulación: enumera qué movería
npx tsx scripts/migrate-uploads-to-org.ts --apply    # ejecuta (idempotente)
```
Resuelve la organización destino por `files.uploaded_by_id` y, en su defecto, por la organización personal del usuario. Sin este paso, los ficheros anteriores dejan de encontrarse (las filas de `files` no cambian: sólo cambia el directorio raíz).

### Deuda RLS retirada en E3 (migraciones `20260906090000_e3_rls_helpers` + `20260906100000_e3_rls_strict`)

**ADR-0009 (APROBADO) aplicado.** Las cinco deudas que introdujeron ADR-0007 y ADR-0008 están cerradas: no queda ninguna cláusula de escape y las **veinte** tablas de negocio (12 de E1 + 4 de E2 + 4 de E3) están en `ENABLE` + `FORCE ROW LEVEL SECURITY`. Una consulta de negocio que salga fuera de `tenantDb` / `tenantTransaction` / `withTenantGucs` ya no ve nada.

| Deuda (ADR-0007 / ADR-0008) | Cómo se ha cerrado |
|---|---|
| `WITH CHECK` de `organizations` con `OR app.current_user() IS NOT NULL` | Retirado. Queda `WITH CHECK (id = app.current_org())`. El alta pasa por un único camino (`createOrganizationWithOwner`), que genera el uuid y lo fija en `app.current_org` antes del INSERT — y desde E3 siembra el plan **en la misma transacción**. |
| Cláusula de escape `OR app.current_org() IS NULL` en los `USING` | Retirada de las dieciséis tablas. `currencies` conserva sólo su rama de catálogo global (`organization_id IS NULL`). |
| Una transacción por operación en `tenantDb` | **Deja de ser deuda de seguridad y queda como coste conocido** (§2.6 del diseño). Agrupados los caminos con ≥ 3 operaciones seguidas: `getOrgContext` (una transacción por petición, vía `getMembershipWithOrganization`), `isLastAdmin`, cada iteración de `runEmailSync` y el alta de organización con su siembra. El resto del código heredado se queda con la envoltura por operación. |
| Cláusula de escape en las cuatro tablas de E2 | Retirada, y `FORCE` activado en las cuatro (no lo tenían). |
| El append-only de `audit_logs` dependía de conectar como `app_runtime` | Cerrada: con `FORCE`, el propietario también queda sujeto a las políticas `RESTRICTIVE … USING (false)`. El registro es inmutable también para las migraciones y para un `psql` de operador. |

**Lo que queda (por diseño, no es deuda).** Tres puertas `SECURITY DEFINER` acotadas, propiedad de `app_maintenance` y con `GRANT EXECUTE` sólo a `app_runtime`, para los accesos que ninguna política puede autorizar: `app.invitation_by_token_hash(text)` (aceptar una invitación: no hay organización ni membresía todavía), `app.list_email_sync_targets()` (el cron enumera pares `(organización, usuario)` y acota cada iteración) y `app.organization_id_by_stripe_customer(text)` (el webhook no tiene sesión). Y el rol **`app_maintenance`** (`BYPASSRLS`, `NOLOGIN` por defecto, credencial en `DATABASE_URL_MAINTENANCE`) para los scripts de operador (`scripts/migrate-uploads-to-org.ts`) y el check de I10 (`scripts/run-invariants.ts`), que sólo puede detectar un cruce si consulta sin filtro de tenant. **La aplicación web nunca conecta con él.**

**Red de seguridad.** ESLint `no-restricted-imports` (importar `prisma`) + `no-restricted-syntax` (usar `prisma.<modelo de negocio>` dentro de la lista blanca) y la suite `test:integration:rls`, que demuestra tabla por tabla que **sin GUC no se lee (0 filas) ni se escribe (42501) nada**, que ninguna tabla queda en `NO FORCE` y que no sobrevive ninguna cláusula de escape.

**Patrón obligatorio para backfills futuros (ADR-0009 §7).** Con `FORCE`, una migración que actualice datos de negocio no ve nada. Hay que envolverla en `ALTER TABLE x NO FORCE ROW LEVEL SECURITY; … ; ALTER TABLE x FORCE ROW LEVEL SECURITY;` dentro de la misma migración, o ejecutarla como `app_maintenance`. Documentado también en `CLAUDE.md`.

### Deuda anotada: una transacción por operación
`tenantDb(orgId)` envuelve CADA operación en su propia transacción para poder fijar `app.current_org`/`app.current_user` (`SET LOCAL`) y que RLS filtre: son tres viajes extra a la base (BEGIN + dos `set_config` + COMMIT) y una conexión del pool ocupada mientras dura. Es el precio de tener la barrera 2 activa sin refactorizar de golpe los 32 ficheros heredados (ADR-0007). **En E3**, cuando el código de negocio esté agrupado dentro de `tenantTransaction`, la envoltura por operación deja de hacer falta: dentro de esa función todas las operaciones comparten una sola transacción. `tenantDb(org).$transaction()` lanza un error explícito que remite a `tenantTransaction`.

### Roles de base de datos
`DATABASE_URL` debe apuntar ahora al rol **`app_runtime`** (LOGIN, NOBYPASSRLS, no propietario) y `DIRECT_URL` al propietario, que es el que usan las migraciones (`prisma.config.ts`). Las migraciones **ya no fijan contraseñas** (quedarían en el repositorio): crean el rol sin LOGIN y garantizan `NOBYPASSRLS`. La credencial la pone el operador:

```bash
APP_RUNTIME_PASSWORD='…' APP_MAINTENANCE_PASSWORD='…' ./scripts/dev-db-setup.sh   # local y CI
```

Desde E3 hay un tercer rol: **`app_maintenance`** (`BYPASSRLS`, `NOLOGIN` por defecto). Se consume por `DATABASE_URL_MAINTENANCE` y **sólo** desde `scripts/`: `migrate-uploads-to-org.ts` y `run-invariants.ts` abortan con un mensaje explícito si la variable falta o si el rol no tiene `BYPASSRLS` — un barrido que ve 0 filas en silencio es peor que uno que no arranca.

**Acción pendiente del operador:** en cualquier entorno donde ya se aplicó `20260904140000_e1_rls_effective`, esa migración dejó la contraseña literal `app_runtime`; hay que ROTARLA. La migración no se edita porque ya está aplicada (`CLAUDE.md`).

### Deuda técnica: pg DeprecationWarning en tenantDb
`@prisma/adapter-pg@7.8 + pg@8.22` emiten «client is already executing a query» (DeprecationWarning) al resolver `include` multi-relación dentro de la transacción por operación de `tenantDb`. Sin efecto funcional; el e2e `libro-diario.spec.ts` lo excluye explícitamente. Cierre: actualizar adapter cuando corrija el issue upstream o agrupar en `tenantTransaction` (deuda E1 ya anotada).

### Comandos de test
```bash
npm run test                  # unitarios
npm run test:integration      # integración como PROPIETARIO (no ejerce RLS)
npm run test:integration:rls  # models/ como app_runtime: RLS efectiva
npm run test:all              # los tres
```

## Siguiente trabajo (en este orden) — épica E1 "fix" (COMPLETADA salvo lo indicado)
1. ✅ **BLOQUEA-1/2 RLS inerte**: cablear `tenantTransaction` en escrituras de `models/`; políticas de `organizations`/`memberships` por `user_id` (función `app.current_user()`); `SET LOCAL` en `createOrganizationWithOwner`; `.env.example`/docker-compose con rol `app_runtime`; test de humo con `app_runtime` en `test:integration`. Si no cabe en un sprint, ADR-0008 que reconozca RLS efectiva en E3 (Nivel 2: Pablo ya delegó aprobación general en sesión de setup).
2. ✅ **BLOQUEA-3 ficheros por organización**: rutas físicas `uploads/<organizationId>/…` + script de migración de disco; arregla también DEBE-4 (backup), DEBE-5 (logo), DEBE-6 (cuota).
3. ✅ DEBE-7/8 members: `requireOrg("ADMIN")` + `notFound()`; sin mutación en RSC.
4. ✅ DEBE-9 `NO_ORGANIZATION` → redirect a `/organizations/new` (sacar `/organizations/**` del layout).
5. ✅ DEBE-10/11 CI: `test:integration` obligatorio y falla si falta `DATABASE_URL_TEST`; versionar tests QA; test de migración con fixture `tests/fixtures/taxhacker-pre-e1.sql`.
6. ✅ DEBE-12..18: `DROP INDEX IF EXISTS`; slug con uuid completo; rate limit en invitación D-3; aceptación en `$transaction`; log Stripe solo id/type + unique parcial `stripe_customer_id`; `log` de Prisma por entorno; validación mimetype/tamaño en uploads.
7. ✅ PUEDE-19..26 según tiempo (documentar límite de `tenantDb` con relaciones; ESLint `lib/**` + patterns; política RLS `app.current_user()`; monedas duplicadas; `iat` en cookie; `AuthzError` → `ActionState`; alinear contrato de actions; `leaveOrganizationAction`).
8. ✅ Revisión final APROBADA (3 rondas). E1 CERRADA en ROADMAP; registro en runs/registro.jsonl.
9. ✅ E2 CERRADA (plan de cuentas, mapa, impuestos, AuditLog; revisión APROBADA).
10. ✅ E3 CERRADA 2026-09-05 (libro diario; auditor CONFORME; revisión APROBADA).
11. ✅ E4 DISEÑADA y aprobada (docs/design/E4-analitica.md, E4-validacion-analitica.md, ADR-0010). Backend implementado (commit 3b769f1: 615 unit / 798 integración / 85 RLS; matriz PyG analítica byte a byte con docs/design/fixtures/pyg-analitica-esperada.json). UI implementada (commit 0bf28a3: /analytics/pyg, projects, cost-centers, business-lines, /settings/analytics, reclasificación, dimensiones en asientos; 8 e2e verdes).
12. ✅ E4 CERRADA 2026-09-05 (bugs corregidos; QA PASS; auditor CONFORME; revisión APROBADA tras 1 ronda; ADR-0011). Deuda aceptada: matriz por agregado SQL, índices O(1) en resolveDestination, MLC por entryDate, seedAnalyticsDefaults con tx del llamante, $queryRawUnsafe documentado, closedProjectOverride sin superficie UI (derivar rol de withOrg al exponerla).
12-old. (cerrado) E4 pendiente de cierre — en este orden:
    a. Bugs reportados por dev-frontend, a corregir por dev-backend: (b) `lib/analytics` `resolveLevel` lanza `AnalyticsError TYPE_UNKNOWN` en vez de devolver FAIL → una línea 6/7 con costCenterId y analyticType NULL tumba /ledger/sumas-saldos (debe ser check FAIL/WARN, nunca excepción); (c) AuditLog de `reclassifyLines` con ~21 líneas falla «value too long» (before/after como JSON compacto o por lotes; comprobar tipo de columna); caché de `models/margins.ts::getAnalyticPnl` es de módulo (debe ser per-request y acotada; clave incluye dimensiones — ya parcheado por frontend).
    b. QA (qa-tester) sobre E4: criterios docs/design/E4-analitica.md §8; adversarial: xor project/ceco, FK cruzadas, reclasificación en ejercicio cerrado, hash v2 estable ante reclasificación, I4 con líneas CC-NA (WARN → REQUIERE REVISIÓN), VIEWER.
    c. auditor-fiabilidad en contexto limpio: reconstruir por SQL/Python la matriz (INGRESOS 6.250.000 · MC1 5.670.000 · MC2 3.276.000 · MC3 3.084.110 · EBITDA 2.390.430 · EBIT 1.995.430 · BAI 1.996.430 · RESULTADO 1.497.322) y P-02/CC-GA; error inyectado en dimensión.
    d. revisor-codigo en contexto limpio sobre `git diff a6e4a14...HEAD`; rondas de fix hasta APROBADO.
    e. documentador: ROADMAP E4 = CERRADA, runs/registro.jsonl, ESTADO; push.
13. **SIGUIENTE**: `/epica E6` (informes financieros: balance, PyG contable, cashflow, ReportRun persistente con sello, export) → `/epica E5` (liquidación de CECOs) → E8 (OCR → asientos) → E7 → E9…
~~11. `/epica E4` (analítica base: BusinessLine, Project, CostCenter, AnalyticType en líneas, MarginLevelConfig, PyG analítica sin imputaciones, I4; retirar CHECK NULL de dimensiones + FKs; fixtures con projectCode/costCenterCode activados) → `/sprint E4` → E6 (informes: balance, PyG, cashflow, ReportRun) → E5 (liquidación CECOs).
~~10. `/epica E3` (libro diario: FiscalYear, JournalEntry/Line, post/void, numeración, trigger Σdebe=Σhaber, plantillas de asientos, mayor, sumas y saldos, invariantes I1/I7–I10, ledgerHash) **+ retirada de deuda RLS de E1/E2 + pendientes E2 (importCustomPlan createMany, alta org+siembra atómica, virtualizar árbol)** → `/sprint E3`.

## Cómo reanudar (sesión nueva)
1. `git clone https://github.com/pablopradomarr/NOMICSAAS && cd NOMICSAAS && npm install --ignore-scripts --engine-strict=false`
2. Postgres local: `initdb` + `pg_ctl start` (ver `docs/design/E1-organizaciones-roles.md` §8 y `vitest.integration.setup.ts`); crear BDs `erp` y `erp_test`; `export DATABASE_URL=postgresql://postgres@localhost:5432/erp`; `npx prisma migrate deploy` en ambas.
3. Leer `CLAUDE.md`, este fichero y `docs/design/E1-revision.md`; seguir el flujo `/sprint` (dev → qa → revisor → auditor si cifras → documentador → registro).
4. Push: si el proxy devuelve 403, la sesión no tiene el repo autorizado → pedir a Pablo que añada `pablopradomarr/NOMICSAAS` a las fuentes de la sesión o un token fine-grained (Contents + Workflows: RW); mientras, entregar `git format-patch` o zip.

## Runbook de operación (E3)

**Backfills en migraciones bajo `FORCE ROW LEVEL SECURITY` (#7b de la revisión de E3).** El patrón obligatorio es `ALTER TABLE x NO FORCE` → backfill → `ALTER TABLE x FORCE` en la MISMA migración (CLAUDE.md), **y la marca de conversión se escribe ANTES del backfill**, no después: si se escribe después, el guard que la consulta no protege la primera ejecución y en un entorno donde el backfill ya se aplicó (propietario superusuario, que esquiva RLS) los valores se convertirían dos veces. `20260907110000_e3_backfill_prorrata_force` tenía ese orden invertido y lo corrige `20260907120000_e3_prorrata_marker_order`, que además verifica la marca y que la tabla no queda en `NO FORCE`. Tests: `tests/integration/e3-backfill-prorrata.test.ts`.

**FK `journal_entries.posted_by_id → users` (migración `20260907130000`).** Se añade `NOT VALID` y se valida en el acto **sólo si no hay filas huérfanas**; si las hay, la migración deja un `WARNING` y la constraint queda activa para las filas nuevas. Cierre manual del pendiente, una vez corregidas o borradas esas filas:

```sql
-- 1. Ver qué asientos no tienen autor real:
SELECT e.id, e.entry_number, e.posted_by_id FROM journal_entries e
  LEFT JOIN users u ON u.id = e.posted_by_id WHERE u.id IS NULL;
-- 2. Con la lista revisada (nunca se borran asientos: se corrige el autor), validar:
ALTER TABLE journal_entries VALIDATE CONSTRAINT journal_entries_posted_by_id_fkey;
```

**Invariantes reproducibles.** `scripts/run-invariants.ts --org <uuid> [--ref-date AAAA-MM-DD]`: sin `--ref-date` se usa hoy en Europe/Madrid, lo que hace que I8 dependa del día. Para comparar dos ejecuciones (o para los fixtures, que llegan a 2027) hay que pasarla explícita. `GIT_SHA` debe estar en el entorno: sin él, el sello es siempre `REQUIERE REVISIÓN` a propósito, porque no se puede acreditar con qué versión del motor se calculó la cifra.

## Pendiente de Pablo (no bloquea)
- Proyecto Supabase (crear o indicar existente) para el entorno preview/prod.
- Borrar el token temporal `nomicsaas-push` en GitHub cuando ya no haga falta.
