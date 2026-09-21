# Preview en Vercel + Supabase — runbook

Estado: **DESPLEGADO Y VERIFICADO** (2026-09-05 20:45). URL: https://nomicsaas-preview-git-main-pablo-7579s-projects.vercel.app (login Vercel). §9 tiene el estado real; §3 queda como referencia histórica.

> **Actualizado 2026-09-15 (E11, ronda de integración).** El preview necesita
> ahora **tres variables nuevas** y un **paso de migración de ficheros**. Todo
> está en la **§10**, y el detalle completo en `docs/deploy/e11-plataforma.md`
> del repositorio. Lo más importante, en una línea: **`BILLING_PROVIDER=none` —
> esta instalación NO cobra**, y es el valor por defecto.
>
> **Actualizado 2026-09-15 (seguridad).** Los dos avisos críticos de Supabase
> del 13-sep están **resueltos**: §11.

## 0. Qué es y qué no es

| Es | No es |
|---|---|
| Entorno para **ver y trastear** el producto con una URL estable, protegida por Vercel Authentication | Producción: sin dominio ni SLA |
| Se actualiza solo con cada push a `main` (build → `prisma migrate deploy` → `next build`) | Un entorno para datos reales de ningún cliente |
| Base Supabase propia (`nomicsaas-preview`), separada de la BD de tests y de la futura prod | La base de producción: cuando llegue prod se crea OTRO proyecto Supabase |

Acceso: login propio (E13, email + contraseña) y protección de Vercel Authentication sobre los despliegues de `main`.

## 1. Hecho (por Claude, 2026-09-05)

### 1.1 Supabase
- Proyecto **`nomicsaas-preview`**, ref **`ilzqlmjbbmunwhoeyhoy`**, región `eu-west-1`, Postgres 17.6, plan gratuito (0 €/mes).
- Migraciones Prisma aplicadas y registradas en `_prisma_migrations` con el checksum sha256 real de cada `migration.sql` → `prisma migrate deploy` en el build de Vercel las ve como aplicadas y no re-ejecuta nada. Desde entonces, **cada push a `main` aplica las nuevas automáticamente** (todas cumplen la regla «ejecutable por rol no superusuario» de `CLAUDE.md`).
- Roles `app_runtime` (LOGIN, NOBYPASSRLS), `app_maintenance` (LOGIN, BYPASSRLS) y, desde E7, `app_auth` (better-auth). Contraseñas fijadas por Pablo; no están en el repo. Si se pierden: `ALTER ROLE <rol> WITH PASSWORD '…';` desde el SQL Editor.

### 1.2 Repo
- Build command en Vercel: `npx prisma generate && npx prisma migrate deploy && GIT_SHA="$VERCEL_GIT_COMMIT_SHA" npm run build` (sin `GIT_SHA`, el sello de informes es siempre REQUIERE REVISIÓN, ADR-0011). `vercel.json` lo declara desde E11.
- `package.json` → `engines.node: ">=24"`.
- `.env.preview.example` / `.env.example`: plantilla completa de variables con **defaults seguros** (`BILLING_PROVIDER=none`, `STORAGE_BACKEND=local`, `CRON_SECRET` vacío = ruta cerrada).

## 2. Hallazgos que hay que conocer (§4 tiene el detalle)
1. **Dos migraciones antiguas no corren en Supabase tal cual** (`20260904150000_e1_rls_round2`, `20260906090000_e3_rls_helpers`): `ALTER ROLE … NOSUPERUSER` y `ALTER FUNCTION … OWNER TO app_maintenance` fallan con `postgres` (no superusuario). El preview se migró con una copia adaptada (mismo efecto, mismo checksum registrado). **No se editan** (CLAUDE.md). Cualquier base Supabase NUEVA (prod) necesitará el mismo procedimiento; ver §4.
2. `20260909100000_e6_reports` incluye un backfill de `cashflow_bucket`: en base vacía no hace nada; las cuentas creadas después reciben el bucket desde `seeds/npgc.csv`.
3. Desde el sandbox de Claude no hay salida de red a la BD por Postgres (pooler ni directo); sí por el conector MCP de Supabase (SQL Editor). La carga del fixture demo se hace desde la propia app (E11: datos de demo en organización propia) o desde un PC con acceso (§5).

## 3. Alta inicial (referencia histórica, operador ~15 min)

### 3.1 Supabase
1. Dashboard → **Settings → Database → Reset database password** → `<POSTGRES_PASSWORD>`.
2. **Connect → Session pooler** → host `aws-1-eu-west-1.pooler.supabase.com`. Usuario del pooler = `<rol>.<ref>`. **Session pooler, puerto 5432** (el transaction pooler 6543 rompe `SET LOCAL` de `tenantDb`; la conexión directa es IPv6-only).

### 3.2 Vercel
1. Import `pablopradomarr/NOMICSAAS` como `nomicsaas-preview`.
2. Variables: `DATABASE_URL` (app_runtime, session pooler, `sslmode=no-verify` — `pg` rechaza la cadena del pooler con `require`), `DIRECT_URL` (postgres, `sslmode=require`), `AUTH_DATABASE_URL` (app_auth), `BETTER_AUTH_SECRET`, `BASE_URL`, `DISABLE_SIGNUP=true`, y desde E11 las de la §10. **No** poner `DATABASE_URL_MAINTENANCE`.
3. **Deployment Protection → Vercel Authentication**.
4. Production Branch = `production-frozen`; `main` despliega como preview protegido (plan Hobby).

## 4. Detalle técnico de las migraciones antiguas en Supabase

`postgres` en Supabase: `rolsuper=false`, `rolcreaterole=true`, `rolbypassrls=true`.

| Sentencia original | Error | Adaptación aplicada en el preview |
|---|---|---|
| `ALTER ROLE app_runtime WITH NOBYPASSRLS NOSUPERUSER` (`20260904150000`) | `42501` | `ALTER ROLE app_runtime WITH NOBYPASSRLS` |
| `ALTER ROLE app_maintenance WITH BYPASSRLS NOSUPERUSER …` (`20260906090000`) | ídem | sin `NOSUPERUSER` |
| `GRANT app_maintenance TO current_user` condicional | `42501 must be able to SET ROLE` | `GRANT … WITH SET TRUE` incondicional |
| `ALTER FUNCTION app.* OWNER TO app_maintenance` | `42501 permission denied for schema app` | `GRANT CREATE ON SCHEMA app` antes, `REVOKE` después |

Para la próxima base Supabase (prod) **ya no hay procedimiento manual**: `scripts/supabase-bootstrap.sql` (E12 · T21) lleva las cuatro adaptaciones, es idempotente y se ejecuta **dos veces**, antes y después de `prisma migrate deploy`:

```bash
export SUPA="postgresql://postgres:<pass>@<host>:5432/postgres?sslmode=require"
psql "$SUPA" -v ON_ERROR_STOP=1 -f scripts/supabase-bootstrap.sql   # FASE 1: roles + extensiones + registro de las dos migraciones
DIRECT_URL="$SUPA" npx prisma migrate deploy                        # todo lo demás
psql "$SUPA" -v ON_ERROR_STOP=1 -f scripts/supabase-bootstrap.sql   # FASE 2: políticas, puertas SECURITY DEFINER y privilegios
```

La fase 2 termina con `bootstrap CONFORME` o falla nombrando lo que falta. Las contraseñas de los tres roles las pone el operador aparte (`ALTER ROLE <rol> WITH LOGIN PASSWORD '…';`): el script no escribe ninguna.

**`btree_gist`, decidido (deuda 15 de E12 cerrada).** En una base **nueva** el bootstrap la instala en el esquema `extensions` —es una extensión *trusted* desde PostgreSQL 13, así que no hace falta superusuario— y el WARN del linter no llega a aparecer. En el **preview ya existente** el WARN se **acepta con motivo escrito**: moverla exige superusuario porque hay nueve índices `EXCLUDE USING gist` dependientes, y el riesgo es nulo desde §11 (`anon`/`authenticated` no tienen ni `USAGE ON SCHEMA public`). Deja de figurar como deuda.

## 5. Datos de demo
Opción A (E11): Configuración → Organización → «Crear organización de demo» (fixture reproducible de 84 asientos en una organización propia con `isDemo` inmutable). Esperado: INGRESOS 6.250.000 · MC1 5.670.000 · MC2 3.276.000 · MC3 3.084.110 · EBITDA 2.390.430 · EBIT 1.995.430 · BAI 1.996.430 · RESULTADO 1.497.322 (céntimos).
Opción B: `scripts/load-fixture.ts` desde un PC con acceso a la BD.

## 6. Verificación tras cada despliegue
- [ ] Build verde; log de `prisma migrate deploy` sin errores.
- [ ] URL pide login (Vercel + app).
- [ ] `/dashboard`, `/ledger`, `/analytics/pyg`, `/reports`, `/audit`, `/ledger/closing`, `/analytics/budget`, `/settings/subscription` abren sin 500.
- [ ] Vercel → Logs: sin `permission denied`.
- [ ] Desde E11: §10.4. Desde el endurecimiento: §11.

## 7. Limitaciones conocidas del preview
- ~~Subidas efímeras en `/tmp`~~ → cerrado en E11 con `STORAGE_BACKEND=s3` (§10.2); en `local` siguen siendo efímeras.
- Cron: `POST /api/cron/[job]` con `CRON_SECRET`, disparado por `.github/workflows/cron.yml` (GitHub Actions, gratis) y Vercel Cron diario de respaldo.
- Free tier Supabase: se pausa tras 7 días sin actividad → «Restore project».
- Rendimiento: session pooler → páginas algo más lentas que en local. Aceptado.

## 8. Rollback / limpieza
- Borrar el proyecto Vercel: no afecta a la BD.
- Vaciar la BD: Supabase → Settings → General → «Pause»/«Delete project».
- Nunca apuntar este preview a datos reales.

## 9. Estado real (2026-09-05, sesión de Pablo)
Proyecto Vercel `nomicsaas-preview` (team `pablo-7579s-projects`) importado; rama `production-frozen` como producción; `main` como preview protegido. URL: **https://nomicsaas-preview-git-main-pablo-7579s-projects.vercel.app**.

---

## 10. E11 — lo que cambia en el preview (2026-09-15)

Runbook completo: **`docs/deploy/e11-plataforma.md`**.

### 10.1 Tres variables nuevas
```
BILLING_PROVIDER=none
PLATFORM_SIGNING_KEY=<cadena larga y aleatoria>
PLATFORM_SIGNING_KEY_ID=k1
PLATFORM_ADMIN_EMAILS=pablo@cfonomic.com      # OBLIGATORIA: sin ella /admin queda cerrado
```
`BILLING_PROVIDER=none` = **modo INTERNO** (ADR-0019 D9, aprobado por Pablo el 2026-09-15) y valor por defecto: sin Stripe (`/api/stripe/*` → 404, sin claves), toda organización con plan `ILIMITADO`, nunca `READ_ONLY` por impago, ninguna factura de plataforma; `/settings/subscription` enseña «Modo interno: sin facturación», el plan y el uso del mes. `PLATFORM_SIGNING_KEY` firma el manifest de los backups (sin ella no se emite ninguna copia).

**`PLATFORM_ADMIN_EMAILS` es OBLIGATORIA en el preview** (ronda 1 de E12, DEBE #8 de la revisión). Desde ADR-0020 y su corrección, con la lista **vacía no es operador de plataforma NADIE**, en ningún modo de facturación: `/admin` responde 404 a todo el mundo y el plan no se puede cambiar desde la aplicación. Antes, con la lista vacía y facturación interna, lo era **cualquier usuario autenticado**, y en el preview conviven varias organizaciones: ahí eso significaba enumeración cruzada y `reset-org` al alcance de quien se registrara. El arranque avisa en el log (no falla) si hay más de una organización no personal y la lista está vacía.

### 10.2 Almacén de objetos
```
STORAGE_BACKEND=s3
STORAGE_BUCKET=<bucket del entorno>
STORAGE_PREFIX=erp
STORAGE_ENDPOINT=https://ilzqlmjbbmunwhoeyhoy.supabase.co/storage/v1/s3
STORAGE_REGION=eu-west-1
STORAGE_ACCESS_KEY_ID=<S3 access key de Supabase Storage>
STORAGE_SECRET_ACCESS_KEY=<S3 secret>
```
Un bucket por entorno con prefijo por organización. En `local` el preview sigue escribiendo en `/tmp` (efímero).

### 10.3 Migrar al almacén lo ya subido
`DATABASE_URL_MAINTENANCE=… npx tsx scripts/migrate-uploads-to-storage.ts` (simulación) / `--apply`. Idempotente; verifica `sha256` antes de subir.

### 10.4 Verificación E11
- [ ] `prisma migrate deploy` aplica las migraciones de E11; **M6 no aborta** (aborta sólo con `ai_balance > 0`; en el preview es 0).
- [ ] `GET /api/health` responde con `git_sha`; `GET /api/stripe/portal` → 404.
- [ ] Configuración → Suscripción y uso: «Modo interno», plan `ILIMITADO`, seis barras de uso.
- [ ] Copias de seguridad: crear → `DONE` con sha256, firma y sellos; restaurar → organización NUEVA con las **seis comprobaciones** PASS.
- [ ] `CRON_SECRET` en Vercel y en el secreto homónimo del repositorio.

---

## 11. Endurecimiento frente a la API de Supabase (2026-09-15) — avisos de seguridad RESUELTOS

Los dos avisos críticos del 13-sep («Table publicly accessible», «Sensitive data publicly accessible») venían de que Supabase concede por defecto **ALL** a los roles `anon` y `authenticated` sobre toda tabla de `public` y la expone por PostgREST con la clave anon. Esta aplicación no usa esa API (conecta por Postgres con `app_runtime`/`app_auth`/`app_maintenance`), así que ese privilegio era superficie de ataque pura.

Aplicado a mano en el preview el 2026-09-15 a las 21:46 UTC (migración `20260929090000_supabase_api_hardening`, idempotente, registrada en `_prisma_migrations` con su checksum; Vercel no la repite):
- revocados **todos** los privilegios presentes y futuros de `anon`/`authenticated` en `public` y `app` (tablas, secuencias, funciones, USAGE de esquema, ALTER DEFAULT PRIVILEGES);
- RLS activada en `sessions`, `account`, `verification` y `_prisma_migrations` con política sólo para los roles de la aplicación;
- `search_path` fijo en las 63 funciones de `app`.

Verificado con el linter de seguridad de Supabase: **0 errores** (queda un WARN: `btree_gist` en `public`, moverla exige superusuario; deuda E12). Comprobación rápida en el SQL Editor: `select count(*) from information_schema.role_table_grants where grantee in ('anon','authenticated')` → **0**. En cualquier base Supabase nueva la migración se aplica sola con `prisma migrate deploy`.
