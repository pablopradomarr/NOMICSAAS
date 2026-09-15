-- E11 · ola A — los enums de plataforma, SOLOS
-- (docs/design/E11-plataforma-saas.md §2.2, §2.6; ADR-0019 D1, D4, D8).
--
-- Van en su propia migración por exigencia de PostgreSQL: un tipo enumerado
-- creado en la MISMA transacción que su primer uso no se puede referenciar
-- («unsafe use of new value of enum type»). Es la razón por la que E9 y E10 ya
-- los separaron (`20260920090000_e9_enums`, `20260924090000_e10_enums`).
--
-- Aditiva pura y ejecutable por un rol NO superusuario (CLAUDE.md): `CREATE
-- TYPE` sólo exige `CREATE` sobre el esquema, que el propietario ya tiene. Ni un
-- `ALTER ROLE`, ni un `OWNER TO`, ni una extensión nueva.
--
-- `stored_object_kind` NO se toca aquí: lo crea la ola B en M2 con el valor
-- `PLATFORM_INVOICE` ya dentro (C-5, O-9). Un `ALTER TYPE … ADD VALUE` desde
-- esta ola llegaría antes que el tipo y no haría nada.

-- Periodicidad de la suscripción. No hay `WEEK` ni `DAY`: el devengo del
-- art. 75.Uno.7º LIVA se razona por periodos de facturación, no por días.
CREATE TYPE "plan_interval" AS ENUM ('MONTH', 'YEAR');

-- Los siete estados de §3.2. `GRACE` existe como estado propio y no sólo como
-- «PAST_DUE con fecha»: el aviso al cliente cambia y la transición queda en
-- `subscription_events` (I-E11-9). **Ninguno de ellos significa BLOQUEADO**: el
-- impago nunca retira la lectura ni la exportación (ADR-0019 D6).
CREATE TYPE "subscription_status" AS ENUM (
  'TRIALING', 'ACTIVE', 'PAST_DUE', 'GRACE', 'CANCELED', 'INCOMPLETE', 'PAUSED'
);

-- Art. 15.3 RD 1619/2012: la rectificativa consigna o bien la RECTIFICACIÓN
-- efectuada (diferencias) o bien el importe rectificado tal como queda
-- (sustitución). No es un detalle de presentación: cambia la base declarada.
CREATE TYPE "rectification_mode" AS ENUM ('DIFERENCIAS', 'SUSTITUCION');

-- **O-15.** Para NOSOTROS la venta a empresario UE no es «una ISP»: es una NO
-- SUJECIÓN por regla de localización (art. 69.Uno.1º LIVA). La inversión la
-- aplica el destinatario en su Estado; en la FACTURA sí se imprime la mención
-- (art. 6.1.m RD 1619/2012). Llamarla ISP en el código lleva a buscar una cuota
-- que no existe.
--
-- No hay `OSS_<país>`: la venta es **B2B-only con NIF-IVA obligatorio y
-- validado** (P-1, C-1). Admitir B2C UE obligaría a alta en OSS (modelos 035 y
-- 369) por un segmento residual.
CREATE TYPE "tax_treatment" AS ENUM (
  'REPERCUTIDO_ES',
  'NO_SUJETO_LOCALIZACION_UE',
  'NO_SUJETO_TERCER_PAIS',
  'NO_SUJETO_CANARIAS_CEUTA_MELILLA'
);

-- `PARTIAL` no es un fallo: es un job que agotó su presupuesto de 240 s y dejó
-- cursor. **Un job que no cabe nunca se declara `DONE`** (§7.2).
CREATE TYPE "cron_status" AS ENUM ('RUNNING', 'DONE', 'PARTIAL', 'FAILED');
