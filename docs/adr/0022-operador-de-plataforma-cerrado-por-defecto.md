# ADR-0022 — Operador de plataforma: cerrado por defecto

**Estado:** **APROBADO por Pablo** (permiso general delegado de 2026-09-04)
**el 2026-09-21** · **Nivel:** 2 ·
**Fecha:** 2026-09-21 · **Épica:** E12 (ronda 1 de corrección) ·
**Revisión que lo motiva:** `docs/design/E12-revision.md` · hallazgo **#8** ·
**Complementa:** ADR-0019 D9 (el cambio de plan es una acción de administración
con `PlatformAuditLog`) y ADR-0020 §5.5 (el candado de `/admin`) ·
**Sustituye una sola frase de ADR-0019 D9**, la que decía que con
`PLATFORM_ADMIN_EMAILS` vacía el operador es, en modo interno, el ADMIN de la
organización. Ninguna otra decisión de esos dos ADR se toca.

---

## Contexto

`PLATFORM_ADMIN_EMAILS` decide quién es **operador de plataforma**: quién ve
`/admin`, quién enumera todas las organizaciones y quién puede pedir un
`reset-org`, un `unblock`, un cambio de plan o una purga de retención.

Con la lista **vacía**, hasta esta ronda regían dos reglas distintas según el
modo de facturación:

| Modo | Con la lista vacía, ¿quién era operador? |
|---|---|
| `stripe` | **Nadie** |
| interno (`none`) | **Cualquier usuario autenticado** de la instalación |

La segunda era una decisión escrita y defendible: en un self-hosted de una sola
empresa, quien opera y quien administra son la misma persona, y exigir una
variable de entorno para desbloquear un `PeriodLock` es un candado sin
cerradura.

**Lo que la hizo insostenible** es el preview: `BILLING_PROVIDER=none`,
`PLATFORM_ADMIN_EMAILS` declarada «Opcional» en el runbook y **varias
organizaciones conviviendo**. Ahí la regla dejaba de proteger a nadie:
cualquiera que se registrase veía el nombre, el slug, el número de asientos y el
sello de **todas** las organizaciones, y tenía a mano `reset-org` para las que
no tuvieran asientos.

## Decisión

**D1 · Lista vacía = nadie, en los dos modos.** `isPlatformAdminEmail()` devuelve
`false` cuando `PLATFORM_ADMIN_EMAILS` está vacía, sea cual sea
`BILLING_PROVIDER`. `/admin` responde 404 a todo el mundo y el cambio de plan
desde `/settings/subscription` se niega con el motivo escrito.

**D2 · Una sola definición.** El predicado vive en `app/(app)/admin/admin.ts` y
lo importa quien lo necesite. La copia que había en
`app/(app)/settings/subscription/actions.ts` —más permisiva que la otra— se
borra: dos predicados de autorización que no dicen lo mismo es la forma más
barata de que uno de los dos se quede abierto.

**D3 · El arranque avisa, no falla.** Con más de una organización no personal y
la lista vacía, `warnIfNoPlatformAdmins()` deja una línea en el log diciendo que
`/admin` está cerrado y por qué. Fallar el arranque castigaría a una instalación
recién creada que todavía no ha configurado nada; callar dejaría un 404 sin
explicación.

**D4 · El runbook del preview la declara OBLIGATORIA**
(`docs/deploy/DESPLIEGUE-PREVIEW.md` §10.1).

## Consecuencias

- Una instalación existente que dependiera de la regla vieja **pierde el acceso a
  `/admin` hasta declarar los correos**. Es el sentido del cambio: un candado se
  cierra por defecto, y el coste de abrirlo es una variable de entorno.
- El modo interno deja de tener un camino «sin configurar» para cambiar de plan.
  El aviso de arranque y el mensaje de la acción dicen exactamente qué poner.
- La negativa sigue viviendo además en la base: desde la migración
  `20261002090000`, `app_runtime` **no puede ejecutar**
  `app.operator_organizations`, así que un olvido de guardia en una acción nueva
  da `42501` en vez de enumerar la plataforma (ADR-0020 §5.5, DEBE #6).

## Alternativas descartadas

- **Dejarlo como estaba y arreglar sólo el runbook.** El runbook no es un
  control: la instalación siguiente volvería a nacer abierta.
- **Exigir la variable y fallar el arranque sin ella.** Rompe el arranque de toda
  instalación existente, incluidas las de una sola organización donde la regla
  vieja era razonable.
- **Restringir a «el ADMIN de la organización personal más antigua».** Un
  criterio implícito más, y el preview lo volvería a romper el día que alguien
  creara una organización antes.
