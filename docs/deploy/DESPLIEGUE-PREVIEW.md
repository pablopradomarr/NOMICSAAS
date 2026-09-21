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
>
> **Actualizado 2026-09-21 (E12, cierre del ciclo E0–E12).** El despliegue trae
> **nueve migraciones nuevas** y **tres variables que dejan de ser opcionales**:
> `PLATFORM_SIGNING_KEY`, `CRON_SECRET` y `PLATFORM_ADMIN_EMAILS`. Todo, con lo
> que hay que comprobar antes y después, está en la **§12**.

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

**El propietario de las migraciones necesita `BYPASSRLS`, y desde E12 se
comprueba** (hallazgo #10 de la ronda 1, cerrado en la ronda 2).
`operator_exceptions` está en `FORCE ROW LEVEL SECURITY` con la política
RESTRICTIVA `operator_exceptions_no_update`: con `FORCE`, el propietario tampoco
esquiva las políticas, así que el `UPDATE` de `app.revoke_operator_exception()`
—`SECURITY DEFINER`, que corre como el propietario— sólo ve sus filas gracias al
atributo de rol `BYPASSRLS`. Sin él, **revocar una excepción de operador
devolvería `false` sin error** y la excepción seguiría viva hasta caducar sola.
En Supabase `postgres` ya lo tiene (`rolbypassrls=true`, arriba); la migración
`20261003090000` para el despliegue nombrando el atributo si algún día no fuera
así, y el comentario de la función lo deja escrito en la propia base.

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

---

## 12. E12 — lo que el despliegue del cierre exige (2026-09-21)

### 12.1 Las tres variables que pasan a OBLIGATORIAS en Vercel

No son nuevas —las tres existen desde E11—, pero hasta ahora se podían dejar
vacías y el producto seguía arrancando. Tras E12 **una instalación con
cualquiera de las tres vacía está degradada de una forma que conviene que sea
una decisión, no un olvido**:

| Variable | Si falta | Por qué es obligatoria |
|---|---|---|
| **`PLATFORM_SIGNING_KEY`** | **No se emite ninguna copia de seguridad.** No se emite una sin firma: se rechaza el trabajo | La firma del manifest (HMAC con `PLATFORM_SIGNING_KEY_ID`, `k1` por defecto) se verifica **antes de descomprimir un byte**. Sin ella, P7 —«el backup es el criterio de reproducibilidad»— no se puede sostener |
| **`CRON_SECRET`** | `POST /api/cron/[job]` responde **401 siempre**: no corren `recurring-due`, `invariant-sweep`, `backup-worker` ni `retention` | Sin barrido programado nadie ejecuta los invariantes salvo a mano, y sin `retention` las copias no caducan. El secreto va **también** en el secreto homónimo del repositorio, que es quien dispara el reloj (`.github/workflows/cron.yml`) |
| **`PLATFORM_ADMIN_EMAILS`** | **No es operador de plataforma NADIE**: `/admin` responde 404 a todo el mundo y el plan no se puede cambiar desde la aplicación | **ADR-0022**: la lista vacía significa *nadie*, en los dos modos de facturación. Es cerrado por defecto **a propósito** —antes, con la lista vacía y facturación interna, lo era **cualquier usuario autenticado**—, pero en un preview con varias organizaciones deja el producto sin operador. El arranque lo **avisa en el log** (no falla) si hay más de una organización no personal y la lista está vacía |

`STORAGE_*` (`STORAGE_BACKEND`, `STORAGE_BUCKET`, `STORAGE_PREFIX`,
`STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY_ID`,
`STORAGE_SECRET_ACCESS_KEY`) sigue siendo **opcional**: el valor por defecto es
`STORAGE_BACKEND=local` y con él las subidas del preview son **efímeras** —viven
en el `/tmp` de la función—. Para el preview se recomienda `s3` (§10.2); para una
instalación de usar y tirar, `local` es una elección legítima **si se sabe**.

### 12.2 Las nueve migraciones que aplica este despliegue

Todas son ejecutables por un rol **no superusuario** (regla de `CLAUDE.md`) y las
aplica `prisma migrate deploy` en el build de Vercel, en este orden:

| Migración | Qué hace |
|---|---|
| `20260930090000_e12_branding_kind` | tipo de marca de la organización |
| `20260930091000_e12_retirar_columnas_de_almacen` | **elimina** `organizations.storage_used` y `storage_limit`: eran un contador vivo que podía divergir de los bytes reales. La cifra buena se deriva y su caché lleva `sourceHash` |
| `20260930092000_e12_backups_programados` | la programación de las copias |
| `20260930093000_e12_comentario_organizations` | `COMMENT` que deja escrito en la base por qué se fueron las dos columnas |
| `20261001090000_e12_excepciones_de_operador` | `operator_exceptions`: CHECK de caducidad **≤ 24 h en la base**, motivo con longitud mínima, `REVOKE UPDATE, DELETE` y dos políticas RESTRICTIVE |
| `20261001100000_e12_rol_de_operador` | rol `app_operator` (NOLOGIN, NOBYPASSRLS) y la política RESTRICTIVE de las 57 tablas vaciables |
| `20261001110000_e12_presupuesto_capex` | `budget_capex_lines` (ADR-0018 D2 enmendada) |
| `20261002090000_e12_operator_organizations_solo_operador` | el listado de organizaciones del operador, sólo para el operador |
| `20261003090000_e12_guarda_bypassrls_revoke_operator_exception` | **aditiva**: guarda de despliegue, `COMMENT` en la función y en la política. Ver §12.3 |

### 12.3 La condición `rolbypassrls` del propietario — **se cumple en Supabase**

La última migración **exige que el propietario de las migraciones tenga
`BYPASSRLS` (o sea superusuario)** y aborta con `RAISE` nombrando el atributo si
no lo tiene:

```sql
IF NOT (rolbypassrls OR rolsuper) THEN RAISE …
```

No es celo: `operator_exceptions` está en `FORCE ROW LEVEL SECURITY` con la
política RESTRICTIVA `operator_exceptions_no_update`, y con `FORCE` **el
propietario tampoco esquiva las políticas**. El `UPDATE` de
`app.revoke_operator_exception()` —`SECURITY DEFINER`, que corre como el
propietario— sólo ve sus filas gracias al atributo de rol. Sin él, **revocar una
excepción de operador devolvería `false` sin error** y la excepción seguiría viva
hasta caducar sola. Se reprodujo en un clon (`guard_r2`) con el propietario a
`NOSUPERUSER NOBYPASSRLS`: `f` en silencio; devolviendo la función a `postgres`:
`t`.

**Comprobación para este despliegue:** el rol `postgres` de Supabase —el que
`DIRECT_URL` usa para migrar— es `rolsuper=false`, `rolcreaterole=true`,
**`rolbypassrls=true`** (`CLAUDE.md` §«Convenciones de código» y §4 de este mismo
runbook). **Cumple la condición**, así que `20261003090000` aplica sin tocar
nada. Verificable en el SQL Editor antes de desplegar:

```sql
select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user;
-- esperado: postgres | f | t
```

Si algún día una base nueva no lo cumpliera, la migración **falla ruidosamente**
en vez de dejar el producto con una revocación muda. El arreglo es del operador
(`ALTER ROLE <propietario> WITH BYPASSRLS;`), no de la política: abrir el
`UPDATE` que `20261001090000` cerró sería un cambio de Nivel 2.

### 12.4 Verificación E12

- [ ] `prisma migrate deploy` aplica las nueve sin error; `20261003090000` no dispara su `RAISE`.
- [ ] Las tres variables de §12.1 tienen valor en Vercel; el log de arranque no avisa de lista de operadores vacía.
- [ ] `/admin` abre para un correo de `PLATFORM_ADMIN_EMAILS` y responde **404** para cualquier otro.
- [ ] Copias: crear → `DONE` con las **SIETE** comprobaciones en PASS (la séptima, `COBERTURA_INVENTARIO`, ya **decide**: con ella en FAIL el trabajo queda `DONE_UNVERIFIED`).
- [ ] `/audit` → **Ejecutar barrido**: sello con sus motivos, cinco hashes y cuatro cifras firmadas.
- [ ] Ninguna lectura viva nombra `storage_used` / `storage_limit` (lo comprueba un test estático, pero el despliegue las **borra**).
