-- E9 · T4 — M1: tipos de enum, SIN uso (docs/design/E9-cierre-recurrentes.md
-- §3.3, ADR-0016 APROBADO 2026-09-07).
--
-- Va SOLA porque `ALTER TYPE … ADD VALUE` no permite usar el valor nuevo en la
-- misma transacción que lo añade (lección de `20260913090000_e8_enums` y
-- `20260916090000_e7_enums`). Las migraciones que los USAN son
-- `20260920100000_e9_recurrentes`, `20260920110000_e9_iva` y
-- `20260920120000_e9_cierre`.
--
-- Ejecutable por un rol NO superusuario: `CREATE TYPE` y `ALTER TYPE` los puede
-- el propietario del esquema.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Tipos nuevos (§3.2)
-- ─────────────────────────────────────────────────────────────────────────────

-- A — recurrentes. La vigencia de una regla se expresa en PERIODOS, no en
-- fechas: el generador nunca compara contra el reloj.
CREATE TYPE "recurrence_freq"   AS ENUM ('MENSUAL', 'TRIMESTRAL', 'SEMESTRAL', 'ANUAL');
CREATE TYPE "recurrence_anchor" AS ENUM ('PRIMER_DIA', 'ULTIMO_DIA', 'DIA_DEL_MES');
CREATE TYPE "recurring_kind"    AS ENUM ('AMORTIZACION', 'PERIODIFICACION', 'IMPORTE_FIJO');
CREATE TYPE "recurring_status"  AS ENUM ('ACTIVA', 'PAUSADA', 'FINALIZADA');
-- O-22: `OMITIDA` con motivo `CUOTA_CERO` es la fila de la cuota de importe 0.
-- No generar asiento y no dejar rastro serían cosas distintas: la segunda hace
-- imposible demostrar que el cuadro se recorrió entero.
CREATE TYPE "occurrence_status" AS ENUM ('GENERADA', 'OMITIDA', 'FALLIDA');

-- B — inmovilizado. D2: sólo `LINEAL` se resuelve; los otros tres se declaran y
-- el motor los RECHAZA (mismo criterio que ADR-0013 D4 con `HOURS`). Declarar el
-- valor sin resolverlo es lo que impide que alguien lo dé por soportado.
CREATE TYPE "depreciation_method" AS ENUM ('LINEAL', 'SUMA_DIGITOS',
                                           'PORCENTAJE_CONSTANTE', 'UNIDADES_PRODUCCION');
CREATE TYPE "asset_status"        AS ENUM ('EN_USO', 'TOTALMENTE_AMORTIZADO', 'BAJA', 'VENDIDO');

-- C — periodificaciones. El tipo de periodificación fija el par de cuentas:
-- 480/6xx, 485/7xx, 567/662 y 568/762.
CREATE TYPE "accrual_kind"   AS ENUM ('GASTO_ANTICIPADO', 'INGRESO_ANTICIPADO',
                                      'INTERESES_PAGADOS_ANTICIPADO', 'INTERESES_COBRADOS_ANTICIPADO');
-- O-25: `TIPO_EFECTIVO` exige cuadro de deuda (CHECK G-7); el devengo de
-- intereses de un préstamo lo aporta su cuadro, no un reparto lineal.
CREATE TYPE "accrual_basis"  AS ENUM ('DIAS', 'MESES', 'TIPO_EFECTIVO');
CREATE TYPE "accrual_status" AS ENUM ('VIVA', 'AGOTADA', 'CANCELADA');

-- D — IVA. El régimen es un dato FECHADO (D8): entrar en REDEME en 2027 con una
-- columna habría reagrupado los periodos de 2026 YA PRESENTADOS.
CREATE TYPE "vat_period_kind"       AS ENUM ('MENSUAL', 'TRIMESTRAL');
CREATE TYPE "vat_settlement_status" AS ENUM ('LIQUIDADA', 'REVERTIDA');

-- F — el cierre como acto sellado.
CREATE TYPE "closing_run_status" AS ENUM ('BORRADOR', 'COMPROBADO', 'CERRADO', 'REABIERTO', 'ABORTADO');
-- D1: el estado SOCIETARIO, distinto del contable. Separa una reapertura
-- legítima —antes de formular, art. 253 LSC— de una REFORMULACIÓN de cuentas
-- aprobadas o depositadas (arts. 272 y 279 LSC), que no es operación de usuario.
CREATE TYPE "accounts_approval_status" AS ENUM ('BORRADOR', 'FORMULADAS', 'APROBADAS', 'DEPOSITADAS');
-- Q-1.2: si el modelo 200 ya se presentó, reabrir obliga a autoliquidación
-- complementaria o rectificativa (art. 122 LGT). El asistente lo advierte.
CREATE TYPE "tax_filing_status" AS ENUM ('NO_PRESENTADO', 'PRESENTADO', 'RECTIFICADO');

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Valores añadidos a tipos existentes
-- ─────────────────────────────────────────────────────────────────────────────

-- 2.a `check_family`: la familia de los invariantes de cierre I-E9-1…26 (T11).
--     Es ENUM y no texto por lo mismo que en E7 (O-21): con texto libre una
--     errata acota la revisión a nada y el periodo queda sellado como si se
--     hubiera revisado.
ALTER TYPE "check_family" ADD VALUE IF NOT EXISTS 'CIERRE';

-- 2.b `account_key`: DIECINUEVE claves nuevas (§3.2). `INTERESES_DEUDAS` (662),
--     `DIFERENCIA_CAMBIO_*` (668/768), `PERIODIFICACION_*`,
--     `PROVEEDORES_INMOVILIZADO` (523), `REMANENTE` (120) y
--     `RESULTADOS_NEGATIVOS_ANTERIORES` (121) YA existen y no se tocan.
--
--     Las diecinueve se declaran aquí y las SIEMBRA M4, sólo donde la cuenta
--     exista y sea postable; en el resto, WARN de Auditoría (patrón de E8 §299).
--     No entran en el mapa automático de `defaultAccountMap`
--     (`DEFERRED_ACCOUNT_KEYS`, `lib/accounts/map.ts`): `resolvePostable` sube al
--     ancestro y `4728` —que no es cuenta oficial— habría resuelto a `472`,
--     dejando el IVA soportado PENDIENTE de devengo junto al ya deducible.

-- O-9: la prorrata definitiva usa las mismas cuentas que el ajuste de IVA
-- (634/639), pero son claves distintas porque el origen del ajuste —y por tanto
-- su evidencia— es el art. 105.Uno LIVA, no el art. 89.
ALTER TYPE "account_key" ADD VALUE IF NOT EXISTS 'AJUSTE_PRORRATA_NEGATIVO';
ALTER TYPE "account_key" ADD VALUE IF NOT EXISTS 'AJUSTE_PRORRATA_POSITIVO';
-- O-14: 4728/4778 NO son cuentas del PGC. Se crean como hijas de 472 y 477 y
-- heredan `statement` y `epigraph` del padre, para que el balance no haya que
-- remapear. Sin ellas, los puentes I-E8-15a/c fallaban por diseño en toda
-- organización acogida al RECC — y en la de su cliente.
ALTER TYPE "account_key" ADD VALUE IF NOT EXISTS 'IVA_SOPORTADO_PENDIENTE_RECC';
ALTER TYPE "account_key" ADD VALUE IF NOT EXISTS 'IVA_REPERCUTIDO_PENDIENTE_RECC';
-- O-16: los aranceles del DUA son MAYOR COSTE (NRV 10ª.1 y 2ª.1).
ALTER TYPE "account_key" ADD VALUE IF NOT EXISTS 'ARANCELES';
-- ADR-0014 D6: la separación 523 → 173 se mide desde el CIERRE.
ALTER TYPE "account_key" ADD VALUE IF NOT EXISTS 'DEUDA_LARGO_INMOVILIZADO';
-- O-24: baja y venta de inmovilizado. La contrapartida de la venta es 543/253,
-- **no 430**: no es una venta de la actividad y no entra en el aging de clientes.
ALTER TYPE "account_key" ADD VALUE IF NOT EXISTS 'BENEFICIO_BAJA_INMOVILIZADO';
ALTER TYPE "account_key" ADD VALUE IF NOT EXISTS 'PERDIDA_BAJA_INMOVILIZADO';
ALTER TYPE "account_key" ADD VALUE IF NOT EXISTS 'CREDITO_ENAJENACION_CP';
ALTER TYPE "account_key" ADD VALUE IF NOT EXISTS 'CREDITO_ENAJENACION_LP';
-- O-3: el lado activo del valor actual devenga en 762, no en 769.
ALTER TYPE "account_key" ADD VALUE IF NOT EXISTS 'INGRESOS_CREDITOS';
-- O-26: **6300**, no `630`. `IMPUESTO_BENEFICIOS_GASTO` se conserva.
ALTER TYPE "account_key" ADD VALUE IF NOT EXISTS 'IMPUESTO_CORRIENTE';
-- O-18: distribución del resultado (arts. 164 y 274 LSC).
ALTER TYPE "account_key" ADD VALUE IF NOT EXISTS 'RESERVA_LEGAL';
ALTER TYPE "account_key" ADD VALUE IF NOT EXISTS 'RESERVAS_VOLUNTARIAS';
ALTER TYPE "account_key" ADD VALUE IF NOT EXISTS 'DIVIDENDO_ACTIVO_A_PAGAR';
ALTER TYPE "account_key" ADD VALUE IF NOT EXISTS 'DIVIDENDO_ACTIVO_A_CUENTA';
-- O-27: `4751` partido POR MODELO. Sin las subcuentas, el puente I-E8-17 no
-- puede repartir el saldo y `RETENCIONES_LIQUIDADAS` no es verificable.
ALTER TYPE "account_key" ADD VALUE IF NOT EXISTS 'IRPF_A_PAGAR_111';
ALTER TYPE "account_key" ADD VALUE IF NOT EXISTS 'IRPF_A_PAGAR_115';
ALTER TYPE "account_key" ADD VALUE IF NOT EXISTS 'IRPF_A_PAGAR_123';
