# ESTADO DEL PROYECTO — punto de reanudación

Actualizado: 2026-09-04 (cierre E1) · Repo: `pablopradomarr/NOMICSAAS` rama `main` · Sesión origen: https://claude.ai/code/session_01HZCqGBP589Lkmf3TNgtTvb

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

### Deuda RLS a retirar en E3
ADR-0007 está aprobado y es inmutable, así que la deuda que introduce E1-fix se anota aquí. Las tres se retiran en la misma migración de E3 (Nivel 2, ADR nuevo), cuando todo el código de negocio corra dentro de `tenantTransaction`:

| Deuda | Dónde | Riesgo real hoy | Condición para retirarla |
|---|---|---|---|
| `WITH CHECK` de `organizations` con `OR app.current_user() IS NOT NULL` | `20260904150000_e1_rls_round2` | Un usuario identificado podría insertar una organización con el id que quisiera **si esquivara la barrera 1**; hoy sólo `createOrganizationWithOwner` escribe en esa tabla, y fija `app.current_org` con el uuid que acaba de generar. | Que TODA alta de organización pase por ese camino (ya lo hace) y un test lo garantice ⇒ dejar sólo `id = app.current_org()`. |
| Cláusula de escape `OR app.current_org() IS NULL` en los `USING` | `20260904120300_e1_rls` (todas las tablas de negocio) | Una lectura que olvide fijar el GUC ve TODAS las organizaciones; la barrera 1 (`tenantDb`) es la que filtra. | Verificar en CI que ninguna query de negocio corre fuera de transacción (lint `no-restricted-imports` + suite `test:integration:rls`) ⇒ borrar el `OR …  IS NULL`. |
| Una transacción por operación en `tenantDb` | `lib/db.ts` | Ninguno de seguridad: es coste (BEGIN + dos `set_config` + COMMIT por consulta y una conexión del pool ocupada). | Código de negocio agrupado dentro de `tenantTransaction` ⇒ la envoltura por operación deja de hacer falta. |

### Deuda anotada: una transacción por operación
`tenantDb(orgId)` envuelve CADA operación en su propia transacción para poder fijar `app.current_org`/`app.current_user` (`SET LOCAL`) y que RLS filtre: son tres viajes extra a la base (BEGIN + dos `set_config` + COMMIT) y una conexión del pool ocupada mientras dura. Es el precio de tener la barrera 2 activa sin refactorizar de golpe los 32 ficheros heredados (ADR-0007). **En E3**, cuando el código de negocio esté agrupado dentro de `tenantTransaction`, la envoltura por operación deja de hacer falta: dentro de esa función todas las operaciones comparten una sola transacción. `tenantDb(org).$transaction()` lanza un error explícito que remite a `tenantTransaction`.

### Roles de base de datos
`DATABASE_URL` debe apuntar ahora al rol **`app_runtime`** (LOGIN, NOBYPASSRLS, no propietario) y `DIRECT_URL` al propietario, que es el que usan las migraciones (`prisma.config.ts`). Las migraciones **ya no fijan contraseñas** (quedarían en el repositorio): crean el rol sin LOGIN y garantizan `NOBYPASSRLS`. La credencial la pone el operador:

```bash
APP_RUNTIME_PASSWORD='…' ./scripts/dev-db-setup.sh     # local y CI (default: app_runtime)
```

**Acción pendiente del operador:** en cualquier entorno donde ya se aplicó `20260904140000_e1_rls_effective`, esa migración dejó la contraseña literal `app_runtime`; hay que ROTARLA. La migración no se edita porque ya está aplicada (`CLAUDE.md`).

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
9. **SIGUIENTE**: `/epica E2` (plan de cuentas e impuestos) → `/sprint E2` → `/epica E3` (diario + retirada de deuda RLS).

## Cómo reanudar (sesión nueva)
1. `git clone https://github.com/pablopradomarr/NOMICSAAS && cd NOMICSAAS && npm install --ignore-scripts --engine-strict=false`
2. Postgres local: `initdb` + `pg_ctl start` (ver `docs/design/E1-organizaciones-roles.md` §8 y `vitest.integration.setup.ts`); crear BDs `erp` y `erp_test`; `export DATABASE_URL=postgresql://postgres@localhost:5432/erp`; `npx prisma migrate deploy` en ambas.
3. Leer `CLAUDE.md`, este fichero y `docs/design/E1-revision.md`; seguir el flujo `/sprint` (dev → qa → revisor → auditor si cifras → documentador → registro).
4. Push: si el proxy devuelve 403, la sesión no tiene el repo autorizado → pedir a Pablo que añada `pablopradomarr/NOMICSAAS` a las fuentes de la sesión o un token fine-grained (Contents + Workflows: RW); mientras, entregar `git format-patch` o zip.

## Pendiente de Pablo (no bloquea)
- Proyecto Supabase (crear o indicar existente) para el entorno preview/prod.
- Borrar el token temporal `nomicsaas-push` en GitHub cuando ya no haga falta.
