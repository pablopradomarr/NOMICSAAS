# ADR-0006 — Dinero en céntimos enteros; moneda base por organización; `ExchangeRate` persistido

**Estado:** APROBADO por Pablo el 2026-09-04 · **Nivel:** 2 · **Fecha:** 2026-09-04

## Decisión
- Todo importe en `Int` céntimos (heredado de TaxHacker `Transaction.total`); agregados SQL en `BIGINT`; tasas en `rateMicro BigInt` (10⁻⁶); porcentajes en permille `Int`.
- Redondeo half-even en `lib/money.ts`; reparto de importes con método del mayor resto; `Float` prohibido en todo el código de negocio (lint + revisor).
- Cada organización tiene `baseCurrency`; el diario se lleva en moneda base; la moneda original y la tasa se conservan en la operación (`Transaction`) y en la línea si aplica (v1.1: multidivisa en diario).
- Formato de salida `es-ES` (`1.234,56 €`) solo en UI/export.

## Alternativas descartadas
`Decimal` de Prisma: correcto pero más lento y propenso a `Number()` accidentales; el upstream ya usa céntimos.

## Consecuencias
Import CSV y facturas deben redondear explícitamente (cierra G-07). Migración: ninguna para `Transaction`.
