# E13 — Autenticación con email + contraseña

> Diseño. Rama `feat/e13-auth`, en paralelo a E8. **Nivel 1**: no toca `lib/ledger`, `lib/analytics`, RLS,
> migraciones de negocio ni invariantes contables. ADR informativo: `docs/adr/0015-autenticacion-email-contrasena.md`.
> Estado: **PROPUESTO** (pendiente de validación de Pablo en las tres dudas de §9.3).

---

## 1. Objetivo y alcance

Dar al ERP un **login real** de email + contraseña sobre better-auth, con identidad visual CFOnomic en las
pantallas de acceso, alta por invitación fijando contraseña, recuperación por email, primer ADMIN por script
y restablecimiento asistido desde la gestión de miembros. El objetivo operativo es poder pasar el preview de
Vercel a `SELF_HOSTED_MODE=false` sin perder el modo self-hosted, que sigue siendo el modo de desarrollo y el
que ejercitan los e2e actuales.

**No incluye**: 2FA, SSO/Google/OIDC, Supabase Auth, Stripe, verificación de email por sí misma (la
invitación ya prueba la posesión del buzón), gestión de sesiones activas por el usuario, política de
caducidad de contraseñas, motor contable, informes, RLS nueva y migraciones de negocio.

---

## 2. Modelo de datos

### 2.1 Lo que ya existe (verificado en `prisma/schema.prisma`)

| Modelo | Tabla | Lo que aporta a E13 |
|---|---|---|
| `User` | `users` | `email @unique`, `name`, `emailVerified` (`is_email_verified`) |
| `Session` | `sessions` | `token @unique`, `expiresAt`, `userId` — revocar = borrar filas |
| `Account` | `account` | **`password String?` ya está**: es donde better-auth guarda el hash scrypt del proveedor `credential` |
| `Verification` | `verification` | `identifier`, `value`, `expiresAt` — es donde better-auth guarda el token de restablecimiento |
| `Membership` | `memberships` | rol `ADMIN\|EDITOR\|VIEWER` por organización (E1) |
| `Invitation` | `invitations` | `tokenHash @unique`, `status`, `expiresAt`, `attempts` (E1) |
| `AuditLog` | `audit_logs` | append-only, `organizationId NOT NULL` (ADR-0008) |

### 2.2 Migración

**Ninguna.** `emailAndPassword` de better-auth exige exactamente `account.password` (fila con
`provider_id = 'credential'` y `account_id = <userId>`) y la tabla `verification`; ambas existen desde el
bloque heredado de TaxHacker. **T2 incluye una comprobación explícita**: `npx prisma migrate diff
--from-schema-datamodel --to-schema-datasource` debe salir vacío tras activar el plugin. Si en la versión
instalada de better-auth apareciera una columna nueva (p. ej. `account.password_changed_at`), la migración
sería **aditiva** (`ALTER TABLE … ADD COLUMN … NULL`), ejecutable por el rol propietario no superusuario, y
**sin RLS nueva**: `account`, `sessions`, `verification` y `users` no llevan `organization_id`, son
pre-tenant y quedan fuera de `TENANT_MODELS` (regla de `.claude/skills/supabase-multitenant`).

### 2.3 Datos existentes

Los usuarios del preview de hoy (`taxhacker@localhost` y los creados por invitación) **no tienen contraseña**.
Al pasar a `SELF_HOSTED_MODE=false`:

1. el primer ADMIN se crea o se repara con `scripts/create-admin.ts` (T13);
2. cualquier otro usuario preexistente entra por **"He olvidado mi contraseña"** o por el enlace que le
   envíe un ADMIN desde `/settings/members` (T10);
3. `taxhacker@localhost` se queda como está: no es un buzón real, no puede recibir un reset y sólo se usa en
   `SELF_HOSTED_MODE=true`. **Ningún usuario sin contraseña puede entrar**: `signIn.email` contra una cuenta
   sin fila `credential` devuelve el mismo error genérico que una contraseña incorrecta.

---

## 3. Motor / funciones puras

**No aplica contabilidad**: E13 no produce ni transforma cifras, no toca `lib/ledger/` ni `lib/analytics/`.

Sí introduce dos piezas puras y testeables:

```ts
// forms/auth.ts — política de contraseña (zod, sin efectos, sin reloj)
export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_LENGTH = 128
export const passwordSchema: z.ZodString            // min 12, max 128, sin política exótica
export const newPasswordFormSchema: z.ZodType<{ password: string; confirm: string }>  // + refine igualdad
export const signInFormSchema: z.ZodType<{ email: string; password: string }>
export const forgotPasswordFormSchema: z.ZodType<{ email: string }>
export const setInvitedPasswordFormSchema: z.ZodType<{ name: string; password: string; confirm: string }>

/** Rechaza la parte local del correo como contraseña. Pura. */
export function isPasswordTooObvious(password: string, email: string): boolean
```

```ts
// lib/auth-rate-limit.ts — envoltorio determinista sobre lib/rate-limit.ts (el reloj entra por argumento)
export const LOGIN_IP_LIMIT = 10;    export const LOGIN_IP_WINDOW_MS = 10 * 60 * 1000
export const LOGIN_EMAIL_LIMIT = 5;  export const LOGIN_EMAIL_WINDOW_MS = 15 * 60 * 1000
export const RESET_EMAIL_LIMIT = 3;  export const RESET_EMAIL_WINDOW_MS = 60 * 60 * 1000

/** `subject` es el sha256 del email en minúsculas, nunca el email en claro (mismo criterio que E1 con el token). */
export function checkAuthAttempt(
  kind: "login" | "reset",
  ip: string,
  subjectHash: string,
  now: number
): { allowed: boolean; retryAfterSeconds: number }
```

Y una envoltura de infraestructura (con IO, fuera de `lib/ledger`):

```ts
// lib/auth-password.ts — usa el hash propio de better-auth (scrypt), nunca uno nuestro
export async function hashPassword(plain: string): Promise<string>             // auth.$context → ctx.password.hash
export async function setUserPassword(userId: string, plain: string): Promise<void>  // upsert account providerId "credential"
export async function hasPassword(userId: string): Promise<boolean>
export async function revokeAllSessions(userId: string): Promise<number>       // DELETE FROM sessions WHERE user_id = …
```

`setUserPassword` es el **único** punto que escribe un hash, y lo hace con el hasher del propio better-auth
resuelto en runtime (`await auth.$context`), no con una implementación paralela: si better-auth cambia de
parámetros de scrypt, el login y el alta siguen coincidiendo.

---

## 4. Capa de aplicación

### 4.1 Configuración de better-auth (`lib/auth.ts`)

```ts
emailAndPassword: {
  enabled: true,
  disableSignUp: config.auth.disableSignup,     // DISABLE_SIGNUP=true o SELF_HOSTED_MODE=true
  minPasswordLength: 12,
  maxPasswordLength: 128,
  autoSignIn: false,
  requireEmailVerification: false,              // la invitación ya prueba la posesión del buzón
  resetPasswordTokenExpiresIn: 60 * 60,         // 1 h
  revokeSessionsOnPasswordReset: true,
  sendResetPassword: async ({ user, token }) => {
    await sendPasswordResetEmail({ email: user.email, resetUrl: `${config.app.baseURL}/reset-password/${token}` })
  },
  onPasswordReset: async ({ user }) => { await revokeAllSessions(user.id) },   // cinturón y tirantes
},
```

Cambios adicionales en el mismo fichero:

- **Se retira `emailOTP`** (decisión D-13-2, §9.2) del array de plugins y de `lib/auth-client.ts`.
- **`session.cookieCache.maxAge: 300`** (5 min) en lugar de 365 días. *Esto es un hallazgo de seguridad, no
  una preferencia*: con la caché de cookie a un año, una sesión revocada al cambiar la contraseña se seguiría
  aceptando durante un año sin volver a mirar la tabla `sessions`, y el requisito 8 del alcance quedaría
  incumplido de hecho.
- **`session.expiresIn`**: hoy son 180 días con un comentario que dice 365. Se fija en **30 días**
  (`updateAge` 1 día se mantiene): es un ERP con datos contables, no una app de notas. Duda D-1 de §9.3.
- **`hooks.before`** sobre `/sign-in/email` y `/request-password-reset`: `checkAuthAttempt` por IP y por
  hash del email; al superarlo, `APIError("TOO_MANY_REQUESTS")` con mensaje genérico.
- **`hooks.after`** sobre `/sign-in/email`: `logAuthEvent({ event: "login_ok" | "login_ko", ... })`.
- `config.brand` (nuevo en `lib/config.ts`): `{ product: "NOMIC", company: "CFOnomic" }`. Los asuntos de los
  correos de auth y los titulares de `(auth)` lo usan; **`config.app.title` no se toca**, para no renombrar
  el resto de la aplicación.

### 4.2 Server actions y endpoints

| Ruta / acción | Fichero | Autorización | Notas |
|---|---|---|---|
| `POST /api/auth/sign-in/email` | better-auth | pública, con rate limit | error genérico único |
| `POST /api/auth/request-password-reset` | better-auth | pública, con rate limit | **responde OK siempre**, exista o no el email |
| `POST /api/auth/reset-password` | better-auth | token de `verification` | 1 h, un solo uso, revoca sesiones |
| `POST /api/auth/change-password` | better-auth | sesión | exige `currentPassword`, `revokeOtherSessions: true` |
| `prepareInvitedAccountAction(token)` | `app/(auth)/invite/[token]/actions.ts` | invitación PENDING viva + rate limit E1 | ya existe; se conserva |
| `setInvitedPasswordAction(token, name, password)` | ídem | ídem | **nueva**; D-3: la invitación autoriza el alta aunque `DISABLE_SIGNUP=true` |
| `acceptInvitationAction(token)` | ídem | sesión con el email invitado | ya existe; **no se modifica** |
| `sendMemberPasswordResetAction(formData)` | `app/(app)/settings/members/actions.ts` | `withOrg(ADMIN)` | el destinatario debe ser miembro de la organización; rate limit 3/h por email |
| `changeMyPasswordAction(formData)` | `app/(app)/settings/profile/actions.ts` (nuevo) | sesión (cualquier rol) | contraseña actual obligatoria |

**`setInvitedPasswordAction` — por qué no usamos `signUp.email`.** Con `DISABLE_SIGNUP=true` el endpoint
público de alta está cerrado, y abrirlo "sólo para invitados" significaría meter una excepción en la ruta
pública de better-auth. En su lugar la acción, dentro del guardado de E1 (validación de token, `attempts`,
rate limit por IP y por hash del token):

1. `getOrCreateInvitedUser(email, name)` — reutiliza D-3 tal cual;
2. si el usuario **ya tiene** contraseña → error "Ya tienes una cuenta; entra con tu contraseña" (no se
   pisa la credencial de nadie por poseer un enlace de invitación);
3. `setUserPassword(user.id, password)` y `emailVerified = true` (el enlace llegó a su buzón);
4. devuelve `{ email }`. El cliente hace `authClient.signIn.email(...)` y a continuación
   `acceptInvitationAction(token)`, que es exactamente el flujo E1 de siempre.

El endpoint público de alta queda cerrado en todos los modos; `DISABLE_SIGNUP=true` sigue impidiendo el
registro libre.

### 4.3 Matriz de roles (E13)

| Acción | VIEWER | EDITOR | ADMIN |
|---|---|---|---|
| Entrar, cambiar **mi** contraseña, pedir **mi** reset | ✓ | ✓ | ✓ |
| Ver `/settings/members` | ✗ (404) | ✗ (404) | ✓ |
| Enviar enlace de restablecimiento a otro miembro | ✗ | ✗ | ✓ |
| Fijar la contraseña de otra persona a mano | ✗ | ✗ | **✗ — no existe en el producto** |

---

## 5. Invariantes

**Invariantes contables: no aplica** — E13 no escribe en `journal_entries` ni `journal_lines`; I1–I10 quedan
intactos y sus tests no se tocan.

Invariantes de seguridad que E13 introduce, con su test:

| Id | Invariante | Test |
|---|---|---|
| **S1** | Ninguna respuesta de auth revela si un email existe: `sign-in` con email inexistente y con contraseña incorrecta devuelven el mismo texto y el mismo código; `request-password-reset` devuelve OK siempre | `tests/e2e/auth/login.spec.ts` + unitario del mapeo de errores |
| **S2** | Cambiar o restablecer la contraseña deja **cero** filas en `sessions` para ese usuario (salvo la sesión que hace el cambio, si `revokeOtherSessions`) | `lib/auth-password.test.ts` (integración) + e2e con dos contextos de navegador |
| **S3** | Un token de reset es de **un solo uso** y caduca a la hora: el segundo `resetPassword` con el mismo token falla | e2e `reset.spec.ts` |
| **S4** | El hash nunca sale del servidor: ninguna respuesta JSON ni RSC serializa `account.password` | unitario sobre el selector de `models/users.ts` + revisión de `UserProfile` |
| **S5** | `SELF_HOSTED_MODE=true` no pide credenciales: `/dashboard` responde 200 sin cookie de sesión y `/enter` redirige | suite e2e actual, sin cambios |
| **S6** | Con `DISABLE_SIGNUP=true`, `POST /api/auth/sign-up/email` responde 403 y no crea usuario, incluso con una invitación viva en la mano | `tests/e2e/auth/invite.spec.ts` |

---

## 6. UI

### 6.1 Rutas

| Ruta | Estado | Qué hace |
|---|---|---|
| `/enter` | **rediseñada** | email + contraseña, enlace "¿No recuerdas la contraseña?"; en self-hosted redirige a `/self-hosted/redirect` (como hoy) |
| `/forgot-password` | **nueva** | pide el email; confirma siempre con el mismo texto |
| `/reset-password/[token]` | **nueva** | contraseña nueva + confirmación; **token en el path, nunca en query** (mismo criterio que E1: no acaba en `Referer` ni en logs de proxy) |
| `/invite/[token]` | **rediseñada** | nombre + contraseña + confirmación; con sesión válida, el botón "Aceptar invitación" de E1 |
| `/self-hosted`, `/cloud` | sin cambios | siguen con shadcn; el kit de marca es opt-in por componente |
| `/settings/members` | + botón | "Enviar enlace de restablecimiento" por fila, sólo ADMIN |
| `/settings/profile` | + sección | "Cambiar contraseña": actual, nueva, confirmación |

### 6.2 Identidad CFOnomic — sólo en `app/(auth)/`

Fuentes con `next/font/google` en `app/(auth)/layout.tsx` (el root layout ya carga JetBrains Mono; ahí no se
toca nada): **League Spartan** 900, **Playfair Display** italic 400, **Open Sans** 400/600. Se exponen como
variables CSS en el `div` raíz del layout de auth, de modo que **nada fuera del grupo `(auth)` cambia**.

Tokens (sólo estos cinco): `--nomic-white #FFFFFF` · `--nomic-carbon #1A202C` · `--nomic-black #0A0A0A` ·
`--nomic-lime #EAFF69` · `--nomic-gray #737373`.

Componentes nuevos en `components/auth/brand/`:

- `AuthShell` — fondo blanco, columna centrada máx. 420 px, sin card, sin sombra.
- `AuthHeadline` — League Spartan 900, una palabra de acento en Playfair Display italic, **punto final lima**.
  Ej.: *"Entra en tu **contabilidad**."* con "contabilidad" en itálica y el punto en lima.
- `LineInput` — sólo línea inferior 1px `--nomic-gray`, que pasa a carbón en `:focus-visible`; label encima en
  Open Sans, MAYÚSCULAS, `letter-spacing: 1px`, 11 px. Sin borde, sin fondo, sin icono.
- `ChipLabel` — JetBrains Mono 11 px para etiquetas de estado (`INVITACIÓN · EDITOR`, `ENLACE CADUCADO`).
- `PrimaryButton` — fondo negro `#0A0A0A`, texto blanco MAYÚSCULAS con `letter-spacing: 1px`, flecha `→` a la
  derecha; en `:hover` la flecha se desplaza 2 px. Sobre negro, el CTA alternativo lleva borde lima.
- `AuthError` — texto carbón sobre fondo blanco con borde izquierdo 2px carbón. Sin rojo semáforo (marca).

Sin gradientes, sin sombras, sin iconos decorativos, sin logotipo de TaxHacker (se retira el `Image` del
`/enter` actual). Copy corto y de tú: *"Entra"*, *"Te hemos enviado un enlace si esa dirección tiene cuenta"*,
*"Elige tu contraseña"*, *"Mínimo 12 caracteres"*.

En las pantallas de auth el producto se llama **NOMIC**, de **CFOnomic**. No se renombra nada más.

### 6.3 Estados y accesibilidad

Cada formulario: `idle` / `enviando…` (botón deshabilitado, texto "ENTRANDO…") / `error` (mensaje genérico
bajo el formulario, `role="alert"`, `aria-describedby` en el input) / `éxito`. `autocomplete="email"`,
`"current-password"`, `"new-password"`. Labels reales (no `placeholder` como label). Contraste: carbón sobre
blanco ≥ 12:1; **el lima nunca lleva texto encima** (sólo punto, borde y filo de foco), que es lo que lo
mantiene accesible.

### 6.4 Qué ve cada rol

`/settings/members` responde **404** a quien no es ADMIN (comportamiento E1, no se cambia), así que el botón
de restablecimiento no necesita guardia extra en cliente; aun así se renderiza condicionado a `canManage`, y
la server action vuelve a comprobar `withOrg(ADMIN)`. El cambio de contraseña propia lo ve todo el mundo.

---

## 7. Trazabilidad

Dos destinos, deliberadamente distintos:

**a) `AuditLog` (organización)** — para lo que ocurre *dentro* de una organización y tiene actor y sujeto:

| Entidad | Acción | Cuándo | `after` |
|---|---|---|---|
| `User` | `password_reset_sent` | un ADMIN envía el enlace desde `/settings/members` | `{ targetUserId, email }` |
| `User` | `password_changed` | el usuario cambia su contraseña desde el perfil | `{ sessionsRevoked: n }` |
| `User` | `password_set` | un invitado fija su contraseña al aceptar | `{ invitationId }` |

Requiere **dos líneas** en `models/audit-log.ts`: `"User"` en `AuditEntity` y las tres acciones en
`AuditAction`. Es el único fichero de código compartido con E8 (§8.4). **Nunca** se registra el hash ni la
contraseña, ni siquiera su longitud.

**b) Log de auth (proceso)** — `lib/auth-log.ts`, línea JSON estructurada a `stdout` + breadcrumb de Sentry,
para lo que es **pre-tenant**: `login_ok`, `login_ko`, `reset_requested`, `reset_completed`. Campos:
`event`, `emailHash` (sha256, nunca el email), `ip`, `userAgent`, `ts`, `userId?`.

**Justificación de la separación (decisión D-13-3).** `audit_logs.organization_id` es `NOT NULL` y la tabla es
append-only bajo RLS estricta (ADR-0008/0009). Un login fallido no tiene organización — el usuario puede no
existir— y permitir que una petición **no autenticada** provoque escrituras en una tabla de tenant es a la vez
un vector de DoS por inflado y una fuga (la mera existencia de una fila revelaría qué emails tienen cuenta,
justo lo que S1 impide). Por eso lo pre-tenant va al log de proceso y sólo lo org-scoped va al `AuditLog`.

---

## 8. Criterios de aceptación y plan de tareas

### 8.1 Criterios (Given / When / Then)

1. **Login correcto** — *Dado* un usuario con contraseña y membresía, *cuando* introduce email y contraseña
   correctos en `/enter`, *entonces* se crea una fila en `sessions`, se planta la cookie `taxhacker.session_token`
   y aterriza en `/dashboard` con su organización activa.
2. **Login incorrecto** — *Dado* cualquier email, *cuando* la contraseña es incorrecta **o** el email no
   existe **o** el usuario no tiene contraseña, *entonces* la pantalla muestra exactamente
   *"Correo o contraseña incorrectos"* y ninguna respuesta difiere entre los tres casos (ni texto, ni código,
   ni tiempo perceptible).
3. **Rate limit** — *Dado* un mismo email, *cuando* falla 5 veces en 15 minutos, *entonces* el sexto intento
   responde *"Demasiados intentos. Vuelve a probar en unos minutos"* sin consultar la contraseña.
4. **Política** — *Dado* el formulario de contraseña nueva, *cuando* se envían menos de 12 caracteres,
   *entonces* el cliente y el servidor la rechazan con el mismo mensaje y no se escribe nada.
5. **Alta por invitación** — *Dado* un enlace `/invite/<token>` PENDING no caducado y `DISABLE_SIGNUP=true`,
   *cuando* el invitado pone nombre y contraseña, *entonces* queda con sesión iniciada, con `Membership` del
   **rol de la invitación**, la invitación pasa a `ACCEPTED` y aterriza en `/dashboard`.
6. **Invitación caducada / bloqueada** — *Dado* un token caducado, revocado o con 5 intentos fallidos,
   *cuando* se abre, *entonces* se muestra el mensaje E1 correspondiente y **no** se crea usuario ni contraseña.
7. **Invitación a quien ya tiene cuenta** — *Dado* un invitado que ya tiene contraseña, *cuando* abre el
   enlace, *entonces* se le pide entrar con su contraseña y aceptar; su credencial no se sobrescribe.
8. **Olvido** — *Dado* cualquier email en `/forgot-password`, *cuando* se envía, *entonces* la pantalla dice
   siempre lo mismo, y **sólo** si existe cuenta sale un correo con un enlace válido 1 hora.
9. **Reset** — *Dado* un enlace de reset válido, *cuando* se fija la contraseña nueva, *entonces* se puede
   entrar con ella, **todas** las sesiones previas quedan revocadas y el token no vuelve a funcionar.
10. **Reset por ADMIN** — *Dado* un ADMIN en `/settings/members`, *cuando* pulsa "Enviar enlace de
    restablecimiento" sobre un miembro, *entonces* sale el correo, aparece un `AuditLog`
    `User/password_reset_sent` y **en ningún momento** el ADMIN ve ni fija la contraseña.
11. **VIEWER** — *Dado* un usuario VIEWER, *cuando* abre `/settings/members`, *entonces* recibe 404; y si
    invoca `sendMemberPasswordResetAction` directamente, recibe `{ success: false, error: "Sin permiso" }`.
12. **Cambio desde el perfil** — *Dado* un usuario con sesión, *cuando* cambia su contraseña dando la actual,
    *entonces* sus otras sesiones dejan de valer y la suya sigue viva; con la actual equivocada, nada cambia.
13. **Primer ADMIN** — *Dado* un despliegue con base vacía, *cuando* se ejecuta `scripts/create-admin.ts`
    dos veces seguidas con los mismos argumentos, *entonces* hay **un** usuario, **una** organización y
    **una** membresía ADMIN, y la contraseña no se lee de `argv` ni queda en el historial del shell.
14. **Self-hosted intacto** — *Dado* `SELF_HOSTED_MODE=true`, *cuando* se ejecuta `npm run test:e2e`,
    *entonces* las cinco suites actuales pasan sin cambios y nunca aparece la pantalla `/enter`.
15. **Sin migración** — *Dado* el esquema tras E13, *cuando* se ejecuta `prisma migrate diff` contra la base,
    *entonces* la salida es vacía.

### 8.2 Plan de tareas

| Id | Tarea | Dep. | Agente | Nivel | Días | Ficheros |
|---|---|---|---|---|---|---|
| **T1** | `config.brand` (`NOMIC`/`CFOnomic`), `config.auth.{minPasswordLength, resetTokenTtlSeconds, sessionDays}`, variable opcional `AUTH_SESSION_DAYS`; documentar en `.env.example` | — | dev-backend | 1 | 0,5 | `lib/config.ts`, `.env.example` |
| **T2** | Activar `emailAndPassword` (12 car., `autoSignIn:false`, `disableSignUp`, `revokeSessionsOnPasswordReset`), retirar `emailOTP`, **`cookieCache.maxAge: 300`**, `expiresIn` 30 d, `hooks.before` de rate limit, `hooks.after` de log; `prisma migrate diff` vacío (criterio 15) | T1 | dev-backend | 1 | 1 | `lib/auth.ts`, `lib/auth-client.ts` |
| **T3** | `lib/auth-password.ts` (`hashPassword` vía `auth.$context`, `setUserPassword`, `hasPassword`, `revokeAllSessions`), `lib/auth-rate-limit.ts`, `lib/auth-log.ts`, `forms/auth.ts` + tests unitarios (S2, S4) | T2 | dev-backend | 1 | 1 | `lib/auth-password.ts`, `lib/auth-rate-limit.ts`, `lib/auth-log.ts`, `forms/auth.ts` (+ `.test.ts`) |
| **T4** | `sendPasswordResetEmail` + `components/emails/password-reset-email.tsx` (marca NOMIC); retirar `sendOTPCodeEmail` y `otp-email.tsx`; test de render | T1 | dev-backend | 1 | 0,5 | `lib/email.ts`, `components/emails/*` |
| **T5** | Kit de marca `components/auth/brand/{auth-shell,auth-headline,line-input,chip-label,primary-button,auth-error}.tsx` + fuentes `next/font/google` en el layout de auth, como variables CSS del grupo (nada fuera de `(auth)` cambia) | T1 | dev-frontend | 1 | 1 | `app/(auth)/layout.tsx`, `components/auth/brand/*` |
| **T6** | `/enter` rediseñada + `login-form.tsx` reescrito (email + contraseña, error genérico único, enlace de olvido) | T2, T5 | dev-frontend | 1 | 1 | `app/(auth)/enter/page.tsx`, `components/auth/login-form.tsx` |
| **T7** | `/forgot-password` y `/reset-password/[token]` (token en el path), con sus estados y `PasswordFields` reutilizable | T4, T5 | dev-frontend | 1 | 0,5 | `app/(auth)/forgot-password/page.tsx`, `app/(auth)/reset-password/[token]/page.tsx`, `components/auth/password-fields.tsx` |
| **T8** | `setInvitedPasswordAction` reutilizando el guardado E1 (token, `attempts`, rate limit) + `getOrCreateInvitedUser(email, name)`; `AuditLog User/password_set` | T3 | dev-backend | 1 | 1 | `app/(auth)/invite/[token]/actions.ts`, `models/audit-log.ts` |
| **T9** | `invite-form.tsx` → nombre + contraseña + confirmación (y sign-in + `acceptInvitationAction`); página de invitación con marca y `ChipLabel` del rol | T8, T5 | dev-frontend | 1 | 0,5 | `components/auth/invite-form.tsx`, `app/(auth)/invite/[token]/page.tsx` |
| **T10** | `sendMemberPasswordResetAction` (`withOrg(ADMIN)`, miembro de la org, rate limit 3/h, `AuditLog User/password_reset_sent`) | T2, T3 | dev-backend | 1 | 0,5 | `app/(app)/settings/members/actions.ts`, `models/audit-log.ts`, `forms/memberships.ts` |
| **T11** | Botón "Enviar enlace de restablecimiento" por fila, con confirmación y estado enviado | T10 | dev-frontend | 1 | 0,5 | `components/settings/members-table.tsx` |
| **T12** | Sección "Cambiar contraseña" en el perfil + `changeMyPasswordAction` (exige la actual, revoca las demás sesiones, `AuditLog User/password_changed`) | T3 | dev-backend + dev-frontend | 1 | 1 | `app/(app)/settings/profile/actions.ts` (nuevo), `components/settings/profile-settings-form.tsx` |
| **T13** | `scripts/create-admin.ts --email --name [--org] [--reset-password]`, contraseña por `ADMIN_PASSWORD` o prompt oculto, idempotente; runbook local y Supabase | T3 | dev-backend | 1 | 1 | `scripts/create-admin.ts`, `docs/deploy/` (runbook) |
| **T14** | e2e: `playwright.auth.config.ts` (proyecto propio, puerto 7332, `SELF_HOSTED_MODE=false`), `tests/support/ensure-cloud-auth.ts`, `tests/e2e/auth/{login,invite,reset,roles}.spec.ts`; verificar que la suite self-hosted sigue verde | T6, T7, T9, T11, T12 | qa-tester | 1 | 1 | `playwright.auth.config.ts`, `package.json` (script), `tests/support/ensure-cloud-auth.ts`, `tests/e2e/auth/*` |
| **T15** | Cierre: `ESTADO.md` (deuda: rate limit en memoria, sin 2FA, sin verificación de email), `ROADMAP.md` E13 → CERRADA, runbook del preview con `SELF_HOSTED_MODE=false`, ADR-0015 → APROBADO, `runs/registro.jsonl` | T14 | arquitecto | 1 | 0,5 | `docs/ESTADO.md`, `docs/ROADMAP.md`, `docs/adr/0015-*.md`, `runs/registro.jsonl` |

Total ≈ 11,5 días-persona. Camino crítico: T1 → T2 → T3 → T8 → T9 → T14 → T15.

### 8.3 e2e: cómo conviven los dos modos

Los e2e actuales corren en `SELF_HOSTED_MODE=true` y **no se tocan**. La suite de auth necesita lo contrario,
y mezclar los dos modos en un mismo `playwright.config.ts` obliga a reiniciar el servidor entre proyectos.
Propuesta: **un segundo fichero de configuración**, `playwright.auth.config.ts`, con

- `testDir: "./tests/e2e/auth"`, `baseURL: http://localhost:7332`,
- `webServer.command: "SELF_HOSTED_MODE=false DISABLE_SIGNUP=true BASE_URL=http://localhost:7332 npm run dev -- -p 7332"`,
  `reuseExistingServer: false`,
- `globalSetup` → `tests/support/ensure-cloud-auth.ts`, idempotente y con el mismo espíritu que
  `ensure-self-hosted.ts`: siembra `admin.e2e@nomic.local` (ADMIN con contraseña conocida),
  `viewer.e2e@nomic.local` (VIEWER con contraseña), una organización con plan de cuentas y **una invitación
  PENDING** con token conocido. Escribe con `DIRECT_URL` (rol propietario), igual que el arnés existente.
- Correo: la suite **no** depende de Resend. `ensure-cloud-auth.ts` lee el token de reset directamente de
  `verification` por `identifier`, que es la misma técnica que ya usa `seedSession` con `sessions`.
- Script nuevo: `"test:e2e:auth": "playwright test --config playwright.auth.config.ts"`. `test:e2e` no cambia.

Ventaja frente a añadir un `project` al config actual: cero riesgo de romper la suite verde de E8/E5 y cero
conflicto de fichero con la otra rama.

### 8.4 Ficheros que toca E13 y solape con E8

Ficheros de E13 (los de §8.2), agrupados: `lib/{auth,auth-client,config,email,auth-password,auth-rate-limit,auth-log}.ts` ·
`forms/auth.ts`, `forms/memberships.ts` · `app/(auth)/**` · `components/auth/**`, `components/emails/**` ·
`app/(app)/settings/members/actions.ts`, `app/(app)/settings/profile/actions.ts` ·
`components/settings/{members-table,profile-settings-form}.tsx` · `models/audit-log.ts` ·
`scripts/create-admin.ts` · `playwright.auth.config.ts`, `tests/support/ensure-cloud-auth.ts`, `tests/e2e/auth/**` ·
`package.json` (un script) · `.env.example` · `docs/**`.

Contrastado con el plan de tareas de `docs/design/E8-documentos-asientos.md` (T1–T23):

- E8 toca `prisma/schema.prisma` y tres migraciones (T2, T2b, T3). **E13 no toca ninguna de las dos cosas**
  (§2.2): es el solape más peligroso y queda eliminado por diseño.
- E8 toca `app/(app)/unsorted/**`, `ai/**`, `lib/{extraction,fx,ledger,uploads}`, `models/{extraction,prompts,fx,counterparties}`,
  `forms/{extraction,transactions}`, `components/settings/{category-default-form,currency-defaults-form,organization-settings-form}`
  y `/settings/{prompts,invoicing,currencies,organization,counterparties}`. **Intersección vacía** con la lista de E13:
  E8 no entra en `/settings/members` ni en `/settings/profile`, y E13 no entra en ninguna de las suyas.
- **Único solape real: `models/audit-log.ts`.** E8 T23 añade `"Counterparty"` a `AuditEntity` y `"vies_check"`
  a `AuditAction`; E13 añade `"User"` y tres acciones. Mitigación: cada rama **añade sus valores al final de
  cada unión, en un bloque propio precedido del comentario de su épica** (`// E13 · T8/T10/T12 — …`), sin
  reordenar ni reformatear el resto. Así el conflicto, si aparece, es de dos bloques contiguos y se resuelve
  conservando ambos. Si Pablo prefiere cero conflictos, la alternativa es que E13 declare sus valores en un
  módulo aparte (`models/audit-log-auth.ts`) que exporte un helper tipado y ensanche la unión por
  declaración; se descarta por añadir una indirección permanente para ahorrar un conflicto de dos líneas.
- Solapes documentales esperables y triviales: `docs/ESTADO.md`, `docs/ROADMAP.md`, `runs/registro.jsonl`
  (append-only: se resuelve conservando las dos líneas). E13 **no** edita `docs/MODELO-DATOS.md` ni
  `docs/ARQUITECTURA.md` (nada que añadir al modelo; §7 de Arquitectura ya describe better-auth), que son los
  que E8 T22 reescribe. `package.json`: E13 añade **una** línea de script; E8 no toca esa sección.

---

## 9. Riesgos y alternativas descartadas

### 9.1 Riesgos

| Id | Riesgo | Mitigación |
|---|---|---|
| R1 | **Quedarse fuera del preview**: se pasa a `SELF_HOSTED_MODE=false` y nadie tiene contraseña | T13 antes del cambio de variable; el runbook exige ejecutar `create-admin.ts` y verificar el login **antes** de tocar la variable en Vercel |
| R2 | **Caché de cookie de sesión**: revocar sesiones no surte efecto mientras la caché firmada siga viva | T2 baja `cookieCache.maxAge` a 5 min; S2 lo verifica con dos contextos de navegador |
| R3 | **Resend no configurado o correo en spam** en el preview: sin correo no hay reset ni invitación | `isEmailDeliveryEnabled()` ya existe: si no hay proveedor, la UI de invitación enseña el enlace (E1). Para el reset **no** se enseña el enlace en pantalla (sería un bypass); se registra `reset_requested` y el operador lo saca del log |
| R4 | **Rate limit en memoria**: no sobrevive a un reinicio ni se comparte entre réplicas de Vercel | Deuda ya declarada en E1; se anota en `ESTADO.md` con épica de cierre (E11) y se complementa con el límite propio de better-auth |
| R5 | **Enumeración de usuarios por tiempo de respuesta**: un email inexistente responde antes que uno con hash que verificar | El propio better-auth hace un hash señuelo; el criterio 2 exige que no haya diferencia perceptible, y T14 lo mide |
| R6 | **Divergencia de hash** si se implementara scrypt a mano | `setUserPassword` usa el hasher de `auth.$context`; prohibido cualquier otro |
| R7 | **Fuentes de Google en el arranque**: cuatro familias en el layout de auth pueden penalizar el LCP | `display: "swap"`, sólo los pesos usados (900 / italic 400 / 400 / 600) y sólo en `(auth)` |
| R8 | **Conflicto de merge con E8** en `models/audit-log.ts` | §8.4: bloques por épica al final de cada unión |

### 9.2 Alternativas descartadas

- **Supabase Auth.** Traería reset, verificación y OAuth de fábrica, pero obliga a mover la identidad fuera de
  Prisma, a reescribir `getSession`/`getCurrentUser`/`proxy.ts` y a un `sub` de JWT que ya no es
  `users.id`, con lo que `Membership.userId`, `AuditLog.userId` y `JournalEntry.postedById` necesitarían
  migración de datos — es decir, Nivel 2 sobre tablas de negocio, justo lo que E13 tiene prohibido.
- **Sólo OTP (mantener el estado actual).** Es más seguro por defecto (nada que robar del lado del cliente)
  pero convierte cada entrada en un viaje al buzón y depende por completo de Resend: sin correo, nadie entra.
  Para un ERP de uso diario es una fricción que Pablo ya ha descartado.
- **OTP como segundo método junto a la contraseña.** Descartado (D-13-2): dos caminos de toma de control por
  buzón sobre la misma cuenta duplican la superficie y obligan a mantener dos rate limits, dos plantillas de
  correo y dos ramas de e2e. El restablecimiento por email cubre la recuperación con **un solo** camino, ya
  acotado en el tiempo y de un solo uso. Si más adelante hace falta OTP, se reintroduce con su propio ADR.
- **Que el ADMIN fije la contraseña de un tercero.** Descartado por producto y por auditoría: rompe el
  no-repudio (cualquier apunte podría atribuirse a un ADMIN que conoció la credencial). El ADMIN sólo dispara
  un enlace, y queda registrado.
- **Un `project` extra en `playwright.config.ts`** para la suite de auth: obliga a reiniciar el servidor entre
  proyectos y a tocar un fichero que E8 T20 también usa. Se descarta a favor de un config aparte (§8.3).

### 9.3 Dudas para Pablo

| Id | Duda | Recomendación por defecto (se aplica si no hay respuesta) |
|---|---|---|
| **D-1** | Duración de la sesión: hoy 180 días con caché de cookie de 365 | **30 días** de sesión y **5 minutos** de caché de cookie |
| **D-2** | ¿Se retira `emailOTP` del todo o se deja como método alternativo? | **Retirarlo** (D-13-2); el reset por email cubre la recuperación |
| **D-3** | Nombre visible en las pantallas de acceso y en los correos de auth | **"NOMIC"**, con "de CFOnomic" en el pie; `config.app.title` intacto |
