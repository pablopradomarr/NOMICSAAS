-- E7 · T3 — M1: tipos de enum, SIN uso (docs/design/E7-auditoria.md §2.3,
-- ADR-0015 APROBADO).
--
-- Va SOLA porque `ALTER TYPE … ADD VALUE` no permite usar el valor nuevo en la
-- misma transacción que lo añade (lección de `20260913090000_e8_enums`). Las
-- migraciones que los USAN son `20260916100000_e7_auditoria` y
-- `20260916110000_e7_conciliacion`.
--
-- Ejecutable por un rol NO superusuario: `CREATE TYPE` y `ALTER TYPE` los puede
-- el propietario del esquema.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Tipos nuevos (§2.2)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "audit_scope_kind"  AS ENUM ('ORGANIZATION', 'FISCAL_YEAR', 'PERIOD');
CREATE TYPE "audit_trigger"     AS ENUM ('MANUAL', 'SCHEDULED', 'POST_CLOSE', 'POST_IMPORT');
-- O-21: las siete familias como ENUM y no como texto. Con texto libre una
-- errata en `manual_review_flags.check_family` acota la revisión a nada y el
-- periodo queda sellado como si se hubiera revisado.
CREATE TYPE "check_family"      AS ENUM ('PARTIDA_DOBLE', 'ESTADOS', 'ANALITICA', 'LIQUIDACION',
                                         'DOCUMENTAL', 'CONCILIACION', 'INTEGRIDAD');
CREATE TYPE "sweep_status"      AS ENUM ('RUNNING', 'DONE', 'FAILED', 'CANCELLED');
CREATE TYPE "statement_format"  AS ENUM ('CSV', 'N43', 'MANUAL');
-- `SUGGESTED` no existe a propósito: una sugerencia es un cálculo sobre el
-- estado de hoy, no un hecho, y no se persiste.
CREATE TYPE "bank_line_status"  AS ENUM ('UNMATCHED', 'MATCHED', 'IGNORED');
-- O-4/O-12 + m2: vocabulario CERRADO de ignorado. `IMPORTE_CERO` lo pone la
-- importación sola y es el único cuya evidencia es el propio importe.
CREATE TYPE "ignore_reason"     AS ENUM ('ERROR_BANCO_REVERSADO', 'NO_ES_NUESTRA_CUENTA',
                                         'YA_CONTABILIZADO_EN_OTRA_CUENTA', 'IMPORTE_CERO');
-- O-3 (ADR-0015 D6.1): la conciliación es N-a-M. `SIMPLE` es el 1:1 de siempre.
CREATE TYPE "match_group_kind"  AS ENUM ('SIMPLE', 'N_A_1', 'UNO_A_N', 'N_A_N');
-- No hay `AUTO`: E7 no puntea solo. El valor se añadiría en E12, con ADR.
CREATE TYPE "match_method"      AS ENUM ('MANUAL', 'SUGGESTION_ACCEPTED');

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Valores añadidos a tipos existentes
-- ─────────────────────────────────────────────────────────────────────────────

-- ADR-0015 D4: el método del cashflow es un PARÁMETRO del mismo informe sobre el
-- mismo periodo y el mismo `ledgerHash`, no dos tipos de informe. Los dos
-- valores viejos NO se borran (PostgreSQL no lo permite sin recrear el tipo):
-- quedan prohibidos para filas nuevas por el CHECK `NOT VALID` que crea
-- `20260916100000_e7_auditoria` y que valida
-- `scripts/migrate-cashflow-report-type.ts` al terminar.
ALTER TYPE "report_type" ADD VALUE IF NOT EXISTS 'CASHFLOW';

-- O-4: el asiento propuesto desde un movimiento de extracto guarda su origen.
-- `BANK_IMPORT` ya existía y significa otra cosa (import masivo).
ALTER TYPE "source_type" ADD VALUE IF NOT EXISTS 'BANK_RECONCILIATION';

-- m1: TRES claves nuevas. `COMISIONES_BANCARIAS` (626) y las dos de diferencias
-- de cambio (`DIFERENCIA_CAMBIO_NEGATIVA` 668, `DIFERENCIA_CAMBIO_POSITIVA` 768)
-- ya existen desde E2/E8 y no se tocan.
ALTER TYPE "account_key" ADD VALUE IF NOT EXISTS 'INTERESES_DEUDAS';
ALTER TYPE "account_key" ADD VALUE IF NOT EXISTS 'OTROS_GASTOS_FINANCIEROS';
ALTER TYPE "account_key" ADD VALUE IF NOT EXISTS 'INTERESES_DESCUENTO_EFECTOS';
