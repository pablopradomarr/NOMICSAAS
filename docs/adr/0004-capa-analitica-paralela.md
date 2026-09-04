# ADR-0004 — Capa analítica paralela: dimensiones en la línea + liquidaciones en `AllocationRun`

**Estado:** PROPUESTO (pendiente de firma: Pablo) · **Nivel:** 2 · **Fecha:** 2026-09-04

## Contexto
R3–R6: proyectos directos con MC1/MC2/MC3, CECOs tipificados, líneas de negocio, liquidación de CECOs por regla propia. Debe cuadrar con la PyG contable (I4) y ser reversible.

## Decisión
- Dimensiones en la propia `JournalLine` (`projectId` xor `costCenterId`, `businessLineId` denormalizado, `analyticType` con default por cuenta). Validación determinista al postear.
- Niveles de margen configurables por organización (`MarginLevelConfig`), defaults: MC1 (aprovisionamiento/subcontratación), MC2 (personal y costes directos de operación), MC3 (CECOs operativos imputados), EBITDA, EBIT, BAI, Resultado.
- Liquidación de CECOs como capa aparte: `AllocationRule` versionada (drivers % fijo, ingresos, coste directo, horas, headcount, partes iguales, manual; cascada por prioridad sin ciclos) → `AllocationRun` (inmutable, `ledgerHash` + `rulesHash`, sustituible, reversible) → `AllocationLine` con reparto por mayor resto (Σ exacto, I5). **Nunca genera asientos financieros.**
- PyG analítica = función pura de (líneas, cuentas, config de márgenes, AllocationRun vigente); muestra CECOs no imputados en columna propia para que la suma iguale la contable.

## Alternativas descartadas
- Asientos analíticos en el diario (cuentas 9x): contamina el diario financiero y complica anulaciones.
- Tablas de "resultado por proyecto" mantenidas: doble verdad.

## Consecuencias
Requiere disciplina de destino analítico en toda línea 6/7 (`analyticsRequired`, CECO `SIN_ASIGNAR` con aviso en Auditoría). Beneficio: PyG analítica auditable y reconstruible en cualquier fecha con cualquier versión de reglas.
