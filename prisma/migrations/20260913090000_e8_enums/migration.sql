-- E8 · T3 — Valores de enum, SIN uso (docs/design/E8-documentos-asientos.md §2.3).
--
-- Va SOLA porque `ALTER TYPE … ADD VALUE` no permite usar el valor nuevo en la
-- misma transacción que lo añade. La migración que los USA es
-- `20260913100000_e8_documentos`.
--
-- Ejecutable por un rol NO superusuario: `ALTER TYPE` lo puede el propietario
-- del tipo, que es el propietario del esquema.

ALTER TYPE "source_type" ADD VALUE IF NOT EXISTS 'INVOICE_IN';
ALTER TYPE "account_key" ADD VALUE IF NOT EXISTS 'PROVEEDORES_INMOVILIZADO';
