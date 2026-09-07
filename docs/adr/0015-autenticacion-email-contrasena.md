# ADR-0015 — Autenticación con email + contraseña sobre better-auth

- **Estado**: PROPUESTO
- **Fecha**: 2026-09-07
- **Nivel**: 1 (informativo — no toca motor contable, invariantes, esquema de asientos, reglas de imputación
  ni RLS; no requiere migración). Se escribe porque cambia el **modo de despliegue del preview** y retira un
  método de acceso existente.
- **Épica**: E13 — `docs/design/E13-autenticacion.md`
- **Relacionados**: ADR-0001 (fork de TaxHacker), ADR-0002 (multi-tenant), ADR-0008/0009 (`audit_logs`
  append-only y RLS estricta con `FORCE`)

---

## Contexto

El ERP hereda de TaxHacker una autenticación better-auth (adaptador Prisma, tablas `users`, `sessions`,
`account`, `verification`) con un **único** método activo: `emailOTP`, es decir, un código de seis dígitos
enviado con Resend. Además, `SELF_HOSTED_MODE=true` —el valor por defecto de `lib/config.ts`— **elimina el
login por completo**: `getSession()` resuelve un usuario local fijo (`taxhacker@localhost`) y `proxy.ts` deja
pasar cualquier petición. El preview de Vercel corre hoy así, de modo que quien conozca la URL entra.

E1 ya aportó lo que hay encima de la identidad: `Organization`, `Membership` con roles `ADMIN|EDITOR|VIEWER`,
invitaciones con token hasheado, límite de intentos y `requireOrg(minRole)`. Lo que falta es la parte de
abajo: **una credencial que la persona pueda usar a diario** y un camino de recuperación que no dependa de
acertar con el buzón en cada entrada.

Tres opciones sobre la mesa.

## Decisión

**Activar `emailAndPassword` de better-auth como método único de acceso**, con el hash scrypt del propio
better-auth, mínimo de 12 caracteres y sin política de composición; restablecimiento por enlace de un solo uso
con caducidad de 1 hora (`sendResetPassword` + tabla `verification`); alta de invitados fijando contraseña
dentro del flujo de invitación de E1; y **retirada del plugin `emailOTP`**.

En consecuencia, **el preview pasa a `SELF_HOSTED_MODE=false`**, con `DISABLE_SIGNUP=true` (no hay registro
libre: sólo se entra por invitación o por el script del primer ADMIN). El modo self-hosted se conserva
íntegro: es el modo de desarrollo del repositorio y el que ejercitan las cinco suites e2e existentes.

### Detalles que la decisión fija

1. **Sin migración.** `account.password` y la tabla `verification` ya existen. Si una versión futura de
   better-auth exigiera una columna, sería aditiva, ejecutable por el rol propietario no superusuario, y sin
   RLS nueva: son tablas pre-tenant, sin `organization_id`.
2. **El alta de invitados no pasa por `signUp.email`.** Una server action fija el hash con el hasher de
   `auth.$context` tras validar la invitación (D-3 de E1: la invitación es la autorización de alta). El
   endpoint público de registro queda cerrado en todos los modos.
3. **Revocación de sesiones** al cambiar o restablecer la contraseña, y `session.cookieCache.maxAge` bajado
   de 365 días a 5 minutos, sin lo cual la revocación sería nominal.
4. **Ningún ADMIN fija la contraseña de un tercero**: sólo dispara un enlace de restablecimiento, y queda en
   `AuditLog`.
5. **Trazabilidad partida**: lo org-scoped (envío de reset, cambio, alta de invitado) va a `AuditLog`; lo
   pre-tenant (login OK/KO, reset solicitado) va a un log de proceso estructurado, porque
   `audit_logs.organization_id` es `NOT NULL` y una petición no autenticada no debe poder escribir en una
   tabla de tenant.

## Alternativas consideradas

**Supabase Auth.** Aporta reset, verificación y OAuth de fábrica y quita código propio de encima. Se descarta
porque saca la identidad de Prisma: `getSession`, `getCurrentUser` y `proxy.ts` se reescriben, y el `sub` del
JWT deja de ser `users.id`, con lo que `Membership.userId`, `AuditLog.userId` y `JournalEntry.postedById`
exigirían migración de datos sobre tablas de negocio con RLS estricta — Nivel 2 y riesgo alto para un
beneficio que hoy no necesitamos (no hay SSO en el alcance).

**Seguir sólo con OTP.** Cero credenciales que robar y ya funciona. Se descarta por producto: convierte cada
entrada diaria en un viaje al correo y deja el acceso al ERP colgando por completo de la entrega de Resend —
sin correo, nadie entra, ni siquiera el ADMIN.

**Contraseña + OTP como método alternativo.** Se descarta por seguridad y coste: dos caminos de toma de
control por buzón sobre la misma cuenta duplican la superficie y obligan a mantener dos rate limits, dos
plantillas y dos ramas de e2e, a cambio de una comodidad que el restablecimiento —acotado en el tiempo y de un
solo uso— ya cubre. Si más adelante hace falta (kioscos, usuarios sin gestor de contraseñas), se reintroduce
con su propio ADR.

## Consecuencias

**Positivas.** El preview deja de estar abierto. Cada apunte queda atribuido a una persona que ha probado
poseer una credencial, que es la premisa del no-repudio contable. La recuperación es autoservicio. El primer
ADMIN se crea de forma reproducible y sin secretos en `argv`.

**Negativas / a vigilar.** Aparece material sensible que antes no existía (hashes, tokens de reset) y con él
la superficie clásica: enumeración de usuarios, fuerza bruta, robo de enlaces de reset. Se mitiga con mensajes
de error indistinguibles, rate limit por IP y por email, y tokens de un solo uso en el *path* de la URL, nunca
en query. El rate limit reutiliza `lib/rate-limit.ts`, que es **en memoria** y no se comparte entre réplicas:
deuda ya declarada en E1, con cierre previsto en E11.

**Operativas.** Antes de cambiar `SELF_HOSTED_MODE` en Vercel hay que ejecutar `scripts/create-admin.ts` y
comprobar el login; si no, el despliegue queda sin nadie que pueda entrar. Los usuarios existentes del preview
entran por reset. `RESEND_API_KEY` y `RESEND_FROM_EMAIL` pasan de conveniencia a **requisito** del modo cloud.

**Reversibilidad.** Alta: volver a `SELF_HOSTED_MODE=true` restaura el comportamiento actual sin tocar datos,
y las contraseñas creadas quedan inertes en `account`.

## Verificación

Los quince criterios Given/When/Then de `docs/design/E13-autenticacion.md` §8.1 y los invariantes de seguridad
S1–S6 de §5, con la suite `tests/e2e/auth/` (`SELF_HOSTED_MODE=false`) conviviendo con la suite self-hosted
actual, que no se modifica.
