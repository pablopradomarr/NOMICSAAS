-- E10 · T4 — M1: los enums de presupuesto y horas, SOLOS
-- (docs/design/E10-presupuesto-horas.md §2.3, ADR-0018 D1–D6).
--
-- Van en su propia migración por exigencia de PostgreSQL: un tipo enumerado
-- creado en la MISMA transacción que su primer uso no se puede referenciar
-- («unsafe use of new value of enum type»). Es la razón por la que E9 ya los
-- separó en `20260920090000_e9_enums`, y la misma aquí.
--
-- Son OCHO, no siete: el diseño §2.2 declara `budget_scenario`, `budget_status`,
-- `budget_line_source`, `time_entry_source`, `time_entry_status`,
-- `employee_rate_source`, `employee_rate_basis` y `headcount_source`. El «siete»
-- de §2.3 y de T3 es un recuento corto del propio documento, no un enum de menos:
-- los ocho están en el fragmento Prisma y los ocho hacen falta.
--
-- Aditiva pura y ejecutable por un rol NO superusuario (CLAUDE.md): `CREATE TYPE`
-- sólo exige `CREATE` sobre el esquema, que el propietario ya tiene.

-- ── Presupuesto ──────────────────────────────────────────────────────────────

-- `BASE` es la versión aprobada al abrir el ejercicio; `REVISADO`, las
-- reproyecciones numeradas. Un «optimista/pesimista» es otra `REVISADO` con su
-- vigencia (D2): como dimensión obligaría a elegir cuál es «el» presupuesto en
-- cada informe, decisión que debe tomar una persona y quedar escrita.
CREATE TYPE "budget_scenario" AS ENUM ('BASE', 'REVISADO');

-- Sin `ANULADO`: una versión sellada no se retira, se sustituye (ADR-0013 D5).
CREATE TYPE "budget_status" AS ENUM ('BORRADOR', 'VIGENTE', 'SUSTITUIDO');

CREATE TYPE "budget_line_source" AS ENUM ('MANUAL', 'CSV_IMPORT', 'COPIED_FROM_VERSION');

-- ── Horas, empleados y plantilla ─────────────────────────────────────────────

CREATE TYPE "time_entry_source" AS ENUM ('MANUAL', 'CSV_IMPORT');

-- Sin `ANULADO`: una entrada aprobada se corrige con CONTRA-APUNTE, igual que un
-- asiento se anula con un contra-asiento (ADR-0003). Un `BORRADOR` sí se borra,
-- porque nadie ha afirmado nada todavía.
CREATE TYPE "time_entry_status" AS ENUM ('BORRADOR', 'APROBADO');

CREATE TYPE "employee_rate_source" AS ENUM ('DECLARADO', 'DERIVADO_NOMINA');

-- Q-1: `COSTE_EMPRESA_CON_SS` = 640 + 642 + 645 + 649, **sin 641**
-- (indemnizaciones: coste no recurrente ligado a personas que dejan de generar
-- horas, O-E10-11). `BRUTO_SIN_SS` y `COSTE_EMPRESA_CON_SS` difieren ~31,9 %, así
-- que la base viaja en la tarifa y nunca es implícita.
CREATE TYPE "employee_rate_basis" AS ENUM ('BRUTO_SIN_SS', 'COSTE_EMPRESA_CON_SS', 'COSTE_TOTAL_CON_ESTRUCTURA');

-- Un snapshot es un HECHO declarado, se teclee o se derive de `employees`; en
-- los dos casos queda sellado con quién y cuándo.
CREATE TYPE "headcount_source" AS ENUM ('MANUAL', 'DERIVADO_EMPLEADOS');
