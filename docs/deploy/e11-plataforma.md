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
PLATFORM_ADMIN_EMAILS=""         # quién puede cambiar el plan de una organización
```

`PLATFORM_ADMIN_EMAILS` vacía en modo interno significa «el ADMIN de la
organización»: en una instalación de uso interno quien opera y quien administra
son la misma persona. En modo `stripe` vacía significa **nadie**, porque allí el
plan se cambia en el portal, que es donde están la tarjeta y los datos fiscales.

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
```

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
