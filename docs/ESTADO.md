# ESTADO DEL PROYECTO — punto de reanudación

Actualizado: 2026-09-04 ~17:00 Europe/Madrid · Repo: `pablopradomarr/NOMICSAAS` rama `main` · Sesión origen: https://claude.ai/code/session_01HZCqGBP589Lkmf3TNgtTvb

## Hecho
| Épica | Estado | Commits |
|---|---|---|
| E0 Base (agentes, docs, ADR 1–7 aprobados, `lib/money.ts`, hook guard) | HECHO salvo CI/Docker | 2168fd7, c3ff192, 83cdf86 |
| E1 T1–T14 (tenancy, roles, RLS con escape, switcher, miembros, invitaciones) | IMPLEMENTADO, **revisión = CAMBIOS REQUERIDOS** | daf199f, 34e41cb, f65f37c, + commit QA |

QA: PASS condicionado (barrera 1 y authz resisten; migración CA-1 sin test). Revisor: 3 BLOQUEA, 15 DEBE, 8 PUEDE (informe completo en `docs/design/E1-revision.md`).

## Siguiente trabajo (en este orden) — épica E1 "fix"
1. **BLOQUEA-1/2 RLS inerte**: cablear `tenantTransaction` en escrituras de `models/`; políticas de `organizations`/`memberships` por `user_id` (función `app.current_user()`); `SET LOCAL` en `createOrganizationWithOwner`; `.env.example`/docker-compose con rol `app_runtime`; test de humo con `app_runtime` en `test:integration`. Si no cabe en un sprint, ADR-0008 que reconozca RLS efectiva en E3 (Nivel 2: Pablo ya delegó aprobación general en sesión de setup).
2. **BLOQUEA-3 ficheros por organización**: rutas físicas `uploads/<organizationId>/…` + script de migración de disco; arregla también DEBE-4 (backup), DEBE-5 (logo), DEBE-6 (cuota).
3. DEBE-7/8 members: `requireOrg("ADMIN")` + `notFound()`; sin mutación en RSC.
4. DEBE-9 `NO_ORGANIZATION` → redirect a `/organizations/new` (sacar `/organizations/**` del layout).
5. DEBE-10/11 CI: `test:integration` obligatorio y falla si falta `DATABASE_URL_TEST`; versionar tests QA; test de migración con fixture `tests/fixtures/taxhacker-pre-e1.sql`.
6. DEBE-12..18: `DROP INDEX IF EXISTS`; slug con uuid completo; rate limit en invitación D-3; aceptación en `$transaction`; log Stripe solo id/type + unique parcial `stripe_customer_id`; `log` de Prisma por entorno; validación mimetype/tamaño en uploads.
7. PUEDE-19..26 según tiempo (documentar límite de `tenantDb` con relaciones; ESLint `lib/**` + patterns; política RLS `app.current_user()`; monedas duplicadas; `iat` en cookie; `AuthzError` → `ActionState`; alinear contrato de actions; `leaveOrganizationAction`).
8. Re-lanzar `revisor-codigo` (contexto limpio) → APROBADO → `documentador` (ROADMAP E1 = CERRADA, manual) → `runs/registro.jsonl` → push.
9. Después: `/epica E2` (plan de cuentas e impuestos) → `/sprint E2` → `/epica E3` (diario).

## Cómo reanudar (sesión nueva)
1. `git clone https://github.com/pablopradomarr/NOMICSAAS && cd NOMICSAAS && npm install --ignore-scripts --engine-strict=false`
2. Postgres local: `initdb` + `pg_ctl start` (ver `docs/design/E1-organizaciones-roles.md` §8 y `vitest.integration.setup.ts`); crear BDs `erp` y `erp_test`; `export DATABASE_URL=postgresql://postgres@localhost:5432/erp`; `npx prisma migrate deploy` en ambas.
3. Leer `CLAUDE.md`, este fichero y `docs/design/E1-revision.md`; seguir el flujo `/sprint` (dev → qa → revisor → auditor si cifras → documentador → registro).
4. Push: si el proxy devuelve 403, la sesión no tiene el repo autorizado → pedir a Pablo que añada `pablopradomarr/NOMICSAAS` a las fuentes de la sesión o un token fine-grained (Contents + Workflows: RW); mientras, entregar `git format-patch` o zip.

## Pendiente de Pablo (no bloquea)
- Proyecto Supabase (crear o indicar existente) para el entorno preview/prod.
- Borrar el token temporal `nomicsaas-push` en GitHub cuando ya no haga falta.
