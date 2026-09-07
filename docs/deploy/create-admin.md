# Primer ADMIN — `scripts/create-admin.ts`

E13 · T13. Crea (o repara) el primer usuario con contraseña de un despliegue: usuario +
organización personal + membresía ADMIN + defaults, reutilizando el mismo camino que el alta
cloud (`getOrCreateCloudUser`). Necesario **antes** de pasar `SELF_HOSTED_MODE=false` (docs/design/E13-autenticacion.md
riesgo R1): hasta entonces ningún usuario tiene contraseña y nadie puede entrar por `/enter`.

Idempotente (criterio 13 del diseño): ejecutarlo dos veces con los mismos argumentos deja **un**
usuario, **una** organización y **una** membresía ADMIN. Si el usuario ya existe, sólo se
reescribe la contraseña con `--reset-password`.

La contraseña **nunca** se pasa por `--argumento`: variable `ADMIN_PASSWORD` o prompt oculto en
una terminal interactiva (sin eco, dos veces).

## Local (docker-compose)

```bash
# app_maintenance ya existe en local (scripts/dev-db-setup.sh); su URL está en .env
ADMIN_PASSWORD='una-contraseña-de-al-menos-12' \
  npx tsx scripts/create-admin.ts --email admin@localhost --name "Admin local"
```

Sin `ADMIN_PASSWORD`, el script la pide dos veces por terminal (oculta):

```bash
npx tsx scripts/create-admin.ts --email admin@localhost --name "Admin local"
# Contraseña del administrador: ********
# Repite la contraseña: ********
```

## Supabase (preview / producción)

Requiere `DATABASE_URL_MAINTENANCE` apuntando al rol `app_maintenance` (BYPASSRLS, ADR-0009 §6)
por el **session pooler** — el transaction pooler (puerto 6543) no vale para el resto de la app,
y este script hereda el mismo cliente. `sslmode=no-verify`: `pg` en Node trata `require` como
verify-full y el certificado del pooler de Supabase lo rechaza (mismo hallazgo que
`DESPLIEGUE-PREVIEW.md` §9 con `DATABASE_URL`).

```bash
export DATABASE_URL_MAINTENANCE="postgresql://app_maintenance.<ref>:<password>@<pooler-host>:5432/postgres?sslmode=no-verify"

ADMIN_PASSWORD='una-contraseña-de-al-menos-12' \
  npx tsx scripts/create-admin.ts \
    --email admin@empresa.com \
    --name "Nombre Apellido" \
    --org "Nombre de la organización"
```

Salida (JSON por stdout): `email`, `userId`, `organizationId`, `organizationName`,
`userCreated`, `passwordWritten`. Verifica el login en `/enter` con esa contraseña **antes** de
cambiar `SELF_HOSTED_MODE` a `false` en el entorno (el runbook de despliegue lo exige, R1).

### Reparar el ADMIN tras perder la contraseña

```bash
ADMIN_PASSWORD='una-contraseña-nueva-de-al-menos-12' \
  npx tsx scripts/create-admin.ts --email admin@empresa.com --name "Nombre Apellido" --reset-password
```

Sin `--reset-password` sobre un usuario ya existente, el script no toca nada salvo comprobar que
su organización personal y su membresía ADMIN siguen ahí (`ensurePersonalOrganization` es
idempotente).

## Qué NO hace

- No crea sesión ni cookie: es un script de operador, no un flujo de login.
- No toca usuarios ni organizaciones que no sean los indicados en `--email`/`--org`.
- No sustituye a `sendMemberPasswordResetAction` (T10): ese es el camino para restablecer la
  contraseña de un miembro normal desde `/settings/members`, con ADMIN + `AuditLog` de por
  medio. `create-admin.ts` es sólo para el arranque del despliegue o para recuperar el acceso
  cuando `/settings/members` todavía no es alcanzable (no hay ningún ADMIN con contraseña).
