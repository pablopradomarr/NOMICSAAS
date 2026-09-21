# Despliegue de E11 — plataforma SaaS

Runbook del operador. Cubre las variables de entorno, el orden de las
migraciones, la migración de los ficheros al almacén y las dos consultas SQL del
349 que **O-17** dejó como salida mientras no hay pantalla (E14).

Documentos que mandan sobre éste: `docs/adr/0019-plataforma-saas.md` (D1…**D9**)
y `docs/design/E11-plataforma-saas.md`.

---

## 1. El modo de facturación (ADR-0019 **D9**)

**Por defecto, esta instalación NO cobra.** `BILLING_PROVIDER=none` es el modo
INTERNO y es el valor que toma la aplicación si la variable no está: una
instalación que se olvide de configurarla no cobra, en vez de cobrar mal.

| | `none` (INTERNO, por defecto) | `stripe` |
|---|---|---|
| Claves de Stripe | **Ninguna** | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| `/api/stripe/checkout`, `/portal`, `/webhook` | **404** | Operativas |
| Plan de toda organización nueva | **`ILIMITADO`** (los siete límites a `-1`) | `FREE` |
| `READ_ONLY` por impago | **Nunca** | Según D6/D7 |
| Facturas de plataforma | **Ninguna** (art. 4.Uno LIVA: sin contraprestación no hay operación sujeta) | Serie `PLT-AAAA-NNNN` |

```bash
BILLING_PROVIDER="none"          # INTERNO. Ponga "stripe" sólo para cobrar de verdad
PLATFORM_ADMIN_EMAILS=""         # quién es OPERADOR DE PLATAFORMA. Vacía = nadie
```

`PLATFORM_ADMIN_EMAILS` **vacía significa NADIE, en los dos modos** (ronda 1 de
E12, DEBE #8). Hasta entonces, en modo interno significaba «el ADMIN de la
organización» —quien opera y quien administra son la misma persona en una
instalación de una sola empresa—, pero en cuanto una instalación tiene dos
organizaciones esa regla abre `/admin` a cualquiera que se registre. Un candado
se cierra por defecto: quien quiera operar declara quién opera.

**Para probar los límites** (D7, D9.4): Configuración → Suscripción y uso →
*Cambiar el plan*. Asignar `STARTER` o `FREE` a una organización hace que las
cuotas de recurso bloqueen y que la cuota de asientos avise **sin bloquear
nunca**. Cada cambio queda en `platform_audit_logs` (`plan.changed`) y en el
`AuditLog` de la organización.

---

## 2. Variables de entorno

```bash
# ── Firma de los backups (§5.2). Sin ella NO se emite ninguna copia ──────────
PLATFORM_SIGNING_KEY="<cadena larga y aleatoria>"
PLATFORM_SIGNING_KEY_ID="k1"        # viaja en el manifest, para poder ROTAR
PLATFORM_SIGNING_KEY_PREVIOUS=""    # al rotar: la anterior sigue VERIFICANDO

# ── Almacén de objetos (§4, ADR-0019 D3) ────────────────────────────────────
STORAGE_BACKEND="local"             # local | s3   (Supabase se consume por S3)
STORAGE_PREFIX="erp"                # un bucket por ENTORNO, prefijo por organización
STORAGE_LOCAL_ROOT="./data/storage" # sólo con STORAGE_BACKEND=local
STORAGE_BUCKET=""
STORAGE_ENDPOINT=""                 # https://<proyecto>.supabase.co/storage/v1/s3
STORAGE_REGION="auto"
STORAGE_ACCESS_KEY_ID=""
STORAGE_SECRET_ACCESS_KEY=""

# ── Reloj de plataforma (§7.2). Vacío = la ruta está CERRADA ────────────────
CRON_SECRET="<cadena larga y aleatoria>"

# ── Procedencia del cálculo (P6). En Vercel se inyecta SOLA ─────────────────
GIT_SHA="$VERCEL_GIT_COMMIT_SHA"    # ya declarado en `vercel.json`
```

> **Defaults seguros, y son deliberados.** Una instalación que se olvide de
> configurar algo **no hace la cosa peligrosa**: `BILLING_PROVIDER="none"` no
> cobra en vez de cobrar mal; `STORAGE_BACKEND="local"` escribe donde se ve en
> vez de fingir un S3; `CRON_SECRET=""` deja la ruta del reloj devolviendo 401
> siempre; y `PLATFORM_SIGNING_KEY=""` **no emite ninguna copia** antes que
> emitir una sin firma, que es una copia que nadie puede verificar.

> **`GIT_SHA`.** Lo inyecta Vercel desde `VERCEL_GIT_COMMIT_SHA` (mapeado en
> `vercel.json`), y no es cosmética: sin él, `sealPure` añade el motivo de
> entorno «git-sha del motor desconocido» y el periodo sale **REQUIERE
> REVISIÓN** — correctamente, porque no se puede acreditar con qué versión del
> motor se calculó la cifra (P6/P7). En Docker autoalojado, páselo en el
> `build-arg` o en el `environment` del compose.

> **Nombres.** La ola B se escribió contra `STORAGE_DRIVER` y `STORAGE_S3_*`. Los
> canónicos son los de arriba; los antiguos se siguen leyendo como **alias** para
> no romper un entorno ya configurado. No mezcle los dos juegos en el mismo
> `.env`: es así como se despliega una instalación que cree tener S3 y escribe
> en `/tmp`.

Rotar la clave de firma: mueva la vigente a `PLATFORM_SIGNING_KEY_PREVIOUS`,
ponga la nueva en `PLATFORM_SIGNING_KEY` y **suba `PLATFORM_SIGNING_KEY_ID`**.
Los ZIP ya emitidos siguen verificando; los nuevos se firman con la vigente.

---

## 3. Migraciones

```bash
DIRECT_URL="postgresql://<propietario>@<host>:5432/<base>" npx prisma migrate deploy
```

Todas son **aditivas** y ejecutables por un rol **NO superusuario** (Supabase:
`postgres` tiene `rolsuper=false`). Orden y contenido:

| Migración | Qué hace |
|---|---|
| `…_e11_enums` | Los enums de plataforma |
| `…_e11_m1_planes_suscripciones` | Catálogo versionado, `subscriptions`, `subscription_events` |
| `…_e11_m3_plataforma` | `cron_runs`, `platform_audit_logs`, `rate_limit_buckets` |
| `…_e11_m4_backfill_suscripciones` | Siembra FREE/STARTER/PRO, backfill y **guardia O-14** |
| `…_e11_m5_facturacion_plataforma` | `platform_invoices` y su serie |
| `…_e11_m2_uso_backups_almacen` | `usage_runs`, `backup_jobs`, `restore_jobs`, `stored_objects` |
| `…_e11_m6_plan_ilimitado_bigint` | **D9**: plan `ILIMITADO` + backfill · `storage_used`/`storage_limit` a `bigint` · **retirada de `ai_balance`** |

### La guardia O-14, y su única salida

M4 y M6 **abortan** si encuentran `ai_balance > 0`. No es una comprobación
paranoica: un saldo prepagado es un **pasivo** (438/485 en *nuestra*
contabilidad) y darlo de baja exige canje o devolución **aceptados**, no una
novación unilateral.

Si los saldos ya se han resuelto, el operador lo declara **antes** de migrar:

```sql
ALTER DATABASE <base> SET app.e11_ai_balance_resuelto = 'si';
```

No es un interruptor para saltarse la comprobación: es la forma de dejar escrito,
en la propia base, que alguien se hizo cargo del pasivo. La migración lo anota en
`platform_audit_logs` con el importe encontrado.

---

## 4. Migrar los ficheros al almacén (T7 + integración)

Desde la ronda de integración, **la ingesta escribe sólo en el almacén**: se ha
retirado la doble escritura transitoria. Los ficheros subidos **antes** siguen en
disco y hay que subirlos.

```bash
# 1. SIMULACIÓN (por defecto): lee, comprueba y dice qué haría. No escribe nada.
DATABASE_URL_MAINTENANCE="postgresql://app_maintenance:…@…/erp" \
  npx tsx scripts/migrate-uploads-to-storage.ts

# 2. Una sola organización, para probar.
DATABASE_URL_MAINTENANCE=… npx tsx scripts/migrate-uploads-to-storage.ts --org <uuid>

# 3. De verdad.
DATABASE_URL_MAINTENANCE=… npx tsx scripts/migrate-uploads-to-storage.ts --apply
```

**Es idempotente.** La clave del objeto se deriva del `sha256`, así que
ejecutarlo dos veces no duplica ni un byte ni una fila, y una ejecución
interrumpida se reanuda sin más. Se puede lanzar tantas veces como haga falta.

Por cada `File`: lee los bytes del disco → **comprueba el `sha256` contra
`files.sha256`** → sube → `head()` y verifica el tamaño → crea el `StoredObject`.

> **Sha discordante ⇒ no se sube y se informa.** Un fichero alterado no se
> propaga al almacén nuevo con la bendición de la migración: se queda donde está,
> aparece en el informe y lo resuelve una persona. Ése es, literalmente, el caso
> que I-E8-2 existe para detectar. Reviértalo desde su copia buena o vuelva a
> subir el documento; **no** fuerce la migración.

Se ejecuta como **operador** (`app_maintenance`, BYPASSRLS): recorre todas las
organizaciones y no hay sesión de usuario de la que sacar el tenant. La
aplicación nunca conecta con ese rol.

Mientras queden ficheros sin migrar, los lectores caen al disco heredado
(`lib/documents.ts`). Ese camino se retira en **E12**, cuando el script haya
corrido en todos los entornos.

---

## 5. Comprobación tras el despliegue

```bash
curl -s https://<host>/api/health | jq          # git_sha, migraciones, reloj
curl -s -o /dev/null -w "%{http_code}\n" https://<host>/api/stripe/portal   # 404 en modo interno
```

En la aplicación:

- **Configuración → Suscripción y uso**: «Modo interno: sin facturación», el plan
  `ILIMITADO` y **las seis barras** de uso con su sello.
- **Configuración → Copias de seguridad**: crear una copia deja el trabajo en
  `DONE` con su `sha256`, su firma y sus tres sellos, y se descarga.
- **Restaurar** esa copia crea una **organización nueva** y enseña las **seis
  comprobaciones** de §5.4. `DONE_UNVERIFIED` es un **FAIL**, no un «casi bien»:
  la organización se conserva y se marca, y no se da por buena.

---

## 5-bis. El reloj en GitHub Actions

`.github/workflows/cron.yml` golpea `POST /api/cron/[job]` con
`Authorization: Bearer ${{ secrets.CRON_SECRET }}`. Cuatro cosas que no son
opcionales:

- el secreto se compara en **tiempo constante** y con el buffer igualado en
  longitud; sin cabecera o con un token equivocado, **401 con el mismo cuerpo**,
  sin pista, y consumiendo cubo de rate limit también en el rechazo;
- cada llamada pasa **`refDate` explícito** (O-13): la `periodKey` se deriva de
  él y no del instante de ejecución, de modo que un retraso del runner es
  inocuo y **ninguna ocurrencia se fecha por cuándo corrió el reloj**;
- la idempotencia es una **inserción** en `cron_runs (job, period_key)`: si
  choca, `200 {skipped:true}` y no se ejecuta nada. Dos disparos del mismo
  periodo hacen un trabajo, no dos;
- un job que no cabe en el presupuesto cierra **`PARTIAL` con cursor y 202**,
  nunca `DONE`. `I-E11-12` avisa si alguno lleva más de dos cadencias sin
  ejecutarse y nada lo explica.

## 5-ter. Supabase Storage (opcional, pero recomendado en cloud)

`STORAGE_BACKEND=s3` contra el endpoint S3 de Supabase Storage
(`https://<proyecto>.supabase.co/storage/v1/s3`), **un bucket por entorno** y
prefijo por organización. Por qué importa: en una función serverless el disco es
efímero y `/tmp` pierde el justificante entre dos peticiones —era la deuda D-11—.
Con `local` el producto funciona igual y escribe en `STORAGE_LOCAL_ROOT`, que es
lo correcto en autoalojado con volumen persistente.

El driver S3 firma SigV4 a mano, con **endpoint fijo por configuración** (no hay
SSRF posible: la URL no viene de un dato) y comprobando el `sha256` **antes** de
enviar. La clave de cada objeto se deriva del `sha256` bajo el prefijo de su
organización, y `assertKeyBelongsTo` lo verifica en las tres puertas del driver.

## 6. El 349 mientras no hay pantalla (**O-17**, E14)

Sólo aplica en modo `stripe`: en modo interno no se emite ninguna factura de
plataforma. Las dos consultas las ejecuta un test de integración para que no se
pudran al cambiar una columna.

**Declaración recapitulativa, agrupada por `operation_date`** (el devengo, no la
fecha de emisión — art. 75.Uno.7º LIVA):

```sql
SELECT i.vat_number,
       i.customer_country,
       sum(i.base_cents_eur)::bigint AS base_cents_eur
  FROM platform_invoices i
 WHERE i.tax_treatment = 'NO_SUJETO_LOCALIZACION_UE'
   AND i.operation_date >= DATE :desde
   AND i.operation_date <  DATE :hasta
 GROUP BY i.vat_number, i.customer_country
 ORDER BY i.vat_number;
```

**Umbral de periodicidad** (arts. 79–81 RIVA: mensual pasados 50 000 € en el
trimestre en curso o en alguno de los cuatro anteriores):

```sql
SELECT date_trunc('quarter', i.operation_date)::date AS trimestre,
       sum(i.base_cents_eur)::bigint                 AS base_cents_eur,
       sum(i.base_cents_eur) > 5000000               AS supera_50000_eur
  FROM platform_invoices i
 WHERE i.tax_treatment = 'NO_SUJETO_LOCALIZACION_UE'
   AND i.operation_date >= (DATE :hasta - INTERVAL '15 months')
 GROUP BY 1
 ORDER BY 1 DESC;
```

La **pantalla** está fechada en **E14** (`docs/ESTADO.md`). El SQL es una salida,
no un cierre.

## 7. Cierre de E11 (2026-09-15) — las ONCE migraciones, y `GIT_SHA`

**Las migraciones de E11 son ONCE**, no siete. El runbook del preview hablaba de siete porque se
escribió en la ronda de integración; las dos últimas son de las rondas de
corrección y ninguna mueve una sola fila:

| Migración | Qué hace |
|---|---|
| `…091000_e11_platform_audit_logs_por_tenant` | `platform_audit_logs` deja de ser legible por **cualquier** tenant: su política pasa a `organization_id IS NULL OR = app.current_org()`. Las filas sin organización (`ORPHAN_WEBHOOK`, arranques del reloj) siguen siendo legibles: no son de nadie. Append-only intacto |
| `…092000_e11_check_family_plataforma` | `ALTER TYPE check_family ADD VALUE 'PLATAFORMA'`, **sola** en su migración (`ADD VALUE` no permite usar el valor en la misma transacción). Sin ella, acotar una revisión manual a la familia nueva fallaría con `22P02` |

> La segunda se **renombró** de `…090000_…` a `…092000_…` antes de empujarse:
> compartía sello temporal con `…090000_e11_m6_plan_ilimitado_bigint` y el orden
> quedaba fijado por el alfabeto en vez de por el sello. Si su base ya la tiene
> aplicada con el nombre viejo, acompañe el renombrado de
> `UPDATE _prisma_migrations SET migration_name='20260928092000_e11_check_family_plataforma' WHERE migration_name='20260928090000_e11_check_family_plataforma';`

**`GIT_SHA`: Vercel ya lo inyecta, y no es cosmético.** El `buildCommand` del
proyecto lo pasa como `GIT_SHA="$VERCEL_GIT_COMMIT_SHA"`, y desde el cierre está
además declarado en `vercel.json` (`env` y `build.env`). Sin él, `sealPure` añade
el motivo de entorno «git-sha del motor desconocido» y **todo periodo sale
REQUIERE REVISIÓN**: no se puede acreditar con qué versión del motor se calculó
la cifra (P6/P7). Es el comportamiento correcto, pero conviene no provocarlo.

**Añada a la lista de verificación de la §5:**

- [ ] `/audit` enseña la tarjeta **«Plataforma y copias»** con los trece
      `I-E11-*`. Una familia sin evaluar sale `SIN_EVALUAR`, **jamás en verde**.
- [ ] El ZIP de una copia lleva `currencies` con sus filas (177 por organización
      recién sembrada) y **no** lleva `platform_invoices`, `subscriptions` ni
      `subscription_events`: son nuestra facturación, no los libros del cliente, y
      restaurarlas duplicaría una serie correlativa global.
- [ ] Cerrar un ejercicio **no** se bloquea por un fallo de plataforma: la familia
      `PLATAFORMA` está fuera de la puerta `INVARIANTES_PASS` (ADR-0019 **D7**).

> **Espejo en el runbook del preview.** `DESPLIEGUE-PREVIEW.md` (documento de
> proyecto) lleva esto mismo en su §10. Si los dos divergen, manda **este**
> fichero: está en el repositorio y se revisa con el código.

## Endurecimiento frente a la API de Supabase (2026-09-15, aviso «rls_disabled_in_public»)

Supabase concede por defecto ALL a `anon` y `authenticated` sobre toda tabla nueva de
`public`, y expone `public` por PostgREST con la clave anon. Esta aplicación no usa esa
API. La migración `20260929090000_supabase_api_hardening` (idempotente, sin SUPERUSER)
revoca todo privilegio presente y futuro a esos dos roles en `public` y `app`, activa RLS
en `sessions`, `account`, `verification` y `_prisma_migrations` con política sólo para
`app_runtime`/`app_auth`/`app_maintenance`, y fija `search_path` en las funciones de
`app`. Aplicada a mano en el preview el 2026-09-15 (registrada en `_prisma_migrations`
con su checksum). Verificación: `select count(*) from information_schema.role_table_grants
where grantee in ('anon','authenticated')` debe ser 0 y el linter de seguridad de
Supabase no debe mostrar errores. Queda un WARN (`btree_gist` en `public`): moverla exige
superusuario; deuda anotada en E12.
