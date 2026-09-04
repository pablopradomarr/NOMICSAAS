# Revisión E1 — organizaciones y roles (`git diff 83cdf86...HEAD`) · revisor-codigo, contexto limpio, 2026-09-04

Veredicto: **CAMBIOS REQUERIDOS** (3 BLOQUEA · 15 DEBE · 8 PUEDE). QA: PASS condicionado (tests adversariales añadidos en tests/integration/e1-*.test.ts; CA-1 migración sin test).

| # | Fichero:línea | Sev. | Problema | Sugerencia |
|---|---|---|---|---|
| 1 | lib/db.ts:269-280 · prisma/migrations/20260904120300_e1_rls/migration.sql:29-38 | BLOQUEA | `tenantTransaction` (único punto que ejecuta `SET LOCAL app.current_org`) no se invoca en producción; sin FORCE RLS; `.env.example`/docker-compose no usan `app_runtime` → barrera 2 inerte. ADR-0007 exige app_runtime + SET LOCAL desde E1. | Cablear app_runtime + FORCE RLS + envolver escrituras en tenantTransaction, o ADR nuevo con aprobación. |
| 2 | migration.sql:48-59 · models/organizations.ts:47 | BLOQUEA | Con app_runtime la app no arranca: WITH CHECK sin escape y GUC nunca fijado; crear `organizations` exige id = app.current_org() (insatisfacible). | Políticas de organizations/memberships por user_id; SET LOCAL en createOrganizationWithOwner; test de humo con app_runtime. |
| 3 | lib/files.ts:13-15,39-42 · app/(app)/files/download/[fileId]/route.ts:132 · app/(app)/export/transactions/route.ts:250,341 | BLOQUEA | Ruta física derivada del email del solicitante: otro miembro de la org recibe 404. | uploads/<organizationId>/… con migración de disco, o resolver por file.uploadedById. |
| 4 | app/(app)/settings/backups/data/route.ts:405 | DEBE | Backup solo empaqueta el directorio del ADMIN que lo lanza. | Recorrer todos los miembros o directorio de org. |
| 5 | app/(app)/files/static/[filename]/route.ts:167 | DEBE | Logo de facturación servido desde directorio del usuario: 404 para otros miembros. | Igual que 3. |
| 6 | lib/files.ts:118-126 | DEBE | Cuota suma directorios de todos los emails de miembros → cruce entre orgs. | Medir por organizationId. |
| 7 | app/(app)/settings/members/page.tsx:23 | DEBE | requireOrg("VIEWER"): cualquier miembro ve lista y emails de invitaciones. | requireOrg("ADMIN") + notFound(). |
| 8 | app/(app)/settings/members/page.tsx:33-39 | DEBE | RSC escribe en BD (markInvitationExpired) con rol VIEWER. | Mover a job/action; filtrar en memoria. |
| 9 | app/(app)/layout.tsx:36 · lib/authz.ts:69 | DEBE | AuthzError("NO_ORGANIZATION") no capturado; usuario sin membresía → 500 y no alcanza /organizations/new. | redirect a /organizations/new o sacar /organizations/** del layout. |
| 10 | package.json:15 · vitest.config.ts:9 | DEBE | `npm run test` excluye tests/integration; skipIf sin DATABASE_URL_TEST → leak test no corre en CI. | test:integration en pipeline; fallar si falta la variable. |
| 11 | tests/integration/ | DEBE | Tests QA sin versionar (ya corregido en commit siguiente); falta migration.test.ts con fixture TaxHacker. | Versionar + fixture tests/fixtures/taxhacker-pre-e1.sql. |
| 12 | 20260904120200_e1_enforce/migration.sql:46-51 | DEBE | Seis DROP INDEX sin IF EXISTS. | DROP INDEX IF EXISTS. |
| 13 | 20260904120100_e1_backfill/migration.sql:14-22 | DEBE | Slug email+6 hex; colisión en organizations_slug_key aborta backfill. | uuid completo o ON CONFLICT DO NOTHING. |
| 14 | models/users.ts:75-83 · app/(auth)/invite/[token]/actions.ts:25-41 | DEBE | D-3: alta sin verificación de email ni rate limit. | Rate limit por IP/token; cuenta utilizable solo tras OTP. |
| 15 | app/(auth)/invite/[token]/actions.ts:85-96 | DEBE | Aceptación en 3 pasos sin transacción. | $transaction + unique de memberships. |
| 16 | app/api/stripe/webhook/route.ts:29 · models/organizations.ts:38 | DEBE | console.log del evento Stripe íntegro; stripe_customer_id no único → findFirst arbitrario. | Log id/type; unique parcial. |
| 17 | lib/db.ts:10 | DEBE | log: ["query",...] imprime SQL con parámetros en producción. | Por entorno. |
| 18 | app/(app)/files/actions.ts:12-44 | DEBE | Sin validación de mimetype/tamaño por fichero; file.type del cliente. | Lista blanca + límite + detección por buffer. |
| 19 | lib/db.ts:156-227 | PUEDE | Extensión no cubre include anidados ni $queryRaw (hoy tapado por FK compuestas). | Documentar + test. |
| 20 | eslint.config.mjs:48-63 | PUEDE | Regla no cubre lib/** ni `import * as`. | Añadir lib/** y patterns. |
| 21 | migration.sql:41-59 (RLS) | PUEDE | Bajo RLS estricta el switcher (getUserMemberships) es imposible. | Política adicional user_id = app.current_user(). |
| 22 | models/defaults.ts:39-45 · models/currencies.ts:10 | PUEDE | Monedas duplicadas (org + catálogo global). | Sembrar solo las que falten o quitar lectura híbrida. |
| 23 | lib/authz-core.ts:47-49 · lib/authz.ts:93 | PUEDE | Cookie sin iat/versión, 365 días. | Incluir iat y rechazar por antigüedad. |
| 24 | lib/authz.ts:66-75 | PUEDE | AuthzError no capturado → excepción genérica. | ActionState{success:false} / notFound(). |
| 25 | app/(app)/settings/members/actions.ts:167,197 · forms/memberships.ts:89,95 | PUEDE | Contrato por userId vs diseño por membershipId. | Alinear y anotar. |
| 26 | docs/design/E1-organizaciones-roles.md:694 | PUEDE | leaveOrganizationAction no implementada. | Implementar o marcar diferida. |

Sólido: tenantDb compone con AND, aplana uniques compuestos, findUnique→findFirst, lanza en escritura cruzada; ESLint dispara; uniques/FK compuestas (I10 garantizado por motor); backfill idempotente; token randomBytes(32)+sha256; cookie timingSafeEqual; matriz de roles correcta en 70 llamadas salvo #7.
