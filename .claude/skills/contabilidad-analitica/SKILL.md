---
name: contabilidad-analitica
description: Modelo de contabilidad analítica del ERP para empresas de proyectos/servicios - proyectos directos con MC1/MC2/MC3, centros de coste (CECOs), líneas de negocio, reglas de imputación/liquidación y PyG analítica cuadrada con la contable. Úsala al diseñar, implementar o auditar cualquier cosa de proyectos, CECOs, márgenes, imputaciones o PyG analítica.
---

# Contabilidad analítica — modelo de referencia

## Dimensiones analíticas (todas por `organizationId`, código único, activables/archivables, nunca borrables si tienen líneas)

| Entidad | Qué es | Campos clave |
|---|---|---|
| `BusinessLine` (Línea de negocio) | Agrupación comercial de proyectos (p. ej. Consultoría, Desarrollo, Formación) | `code`, `name`, `color`, `sortOrder` |
| `Project` (Proyecto directo) | Unidad con ingresos y gastos directos propios; pertenece a UNA línea de negocio | `code`, `name`, `businessLineId`, `counterpartyId?`, `status` (`PLANNED/ACTIVE/CLOSED`), `startDate`, `endDate?`, `budgetRevenueCents?`, `budgetCostCents?` |
| `CostCenter` (CECO) | Centro de coste indirecto | `code`, `name`, `kind` (ver tipos), `marginLevel` (`MC3` o `EBITDA`), `allocatable` (bool) |
| `AnalyticType` | Clasificación de cada cuenta 6/7 | Enum fijo (abajo) |

### Tipos de CECO por defecto (seed por organización, editables)
`MARKETING_VENTAS` · `OPERACIONES_INDIRECTAS` · `G_A` (General & Administración) · `DESARROLLO_PRODUCTO` · `FINANCIERO` · `EXTRAORDINARIO` · `OTROS`. Cada CECO tiene `kind` de esta lista y un `marginLevel` que indica en qué nivel de margen se descuenta (ver abajo).

### `AnalyticType` (por cuenta, override por línea de asiento permitido)
`INGRESO_DIRECTO` · `COSTE_DIRECTO_MC1` · `COSTE_DIRECTO_MC2` · `INDIRECTO_CECO` · `AMORTIZACION_DETERIORO` · `FINANCIERO` · `EXTRAORDINARIO` · `NO_ANALITICO`. Esquema canónico: `docs/MODELO-DATOS.md`. Default por cuenta viene de `seeds/npgc.csv` (`tipo_analitico`) y es editable por organización.

## Regla de destino analítico de una línea de asiento
Cada `JournalLine` de cuenta grupo 6/7 debe tener exactamente UNO de: `projectId` (directo) o `costCenterId` (indirecto), salvo `NO_ANALITICO`. La validación es determinista en `lib/ledger/validateAnalytics()` y bloquea el asiento si falta destino (configurable por organización: `analyticsRequired: true|false`; si false, va a CECO `SIN_ASIGNAR` y la Auditoría lo marca).

## Niveles de margen (configurables por organización en `MarginLevelConfig`; defaults)

| Nivel | Fórmula | Incluye por defecto |
|---|---|---|
| `INGRESOS` | Σ `INGRESO_DIRECTO` del proyecto | 70x (75x configurable por org; default NO_ANALITICO) |
| `MC1` | Ingresos − `COSTE_DIRECTO_MC1` | 60x compras, 607 subcontratación, 61x/71x variación existencias |
| `MC2` | MC1 − `COSTE_DIRECTO_MC2` | 64x personal imputado directamente + 62x directos (viajes, materiales del proyecto) |
| `MC3` | MC2 − CECOs con `marginLevel = MC3` imputados (`INDIRECTO_CECO`) | OPERACIONES_INDIRECTAS, DESARROLLO_PRODUCTO (según config) |
| `EBITDA` | Σ MC3 − CECOs con `marginLevel = EBITDA` (`INDIRECTO_CECO`) | MARKETING_VENTAS, G_A |
| `EBIT` | EBITDA − `AMORTIZACION_DETERIORO` | 68x/69x/79x (nunca dentro de un CECO) |
| `BAI` | EBIT − `FINANCIERO` ± `EXTRAORDINARIO` | 66x/76x, 67x/77x |
| `RESULTADO` | BAI − impuesto (630, `NO_ANALITICO`) | |

La PyG analítica se presenta por **proyecto**, agregada por **línea de negocio**, y en columnas aparte los **CECOs no imputados**, **amortización/deterioro**, **financiero/extraordinario** y **no analítico**, para que la suma total iguale la PyG contable (invariante I4, definición única en skill `fiabilidad`).

## Reglas de imputación / liquidación (`AllocationRule`)

| Campo | Valores |
|---|---|
| `sourceCostCenterId` | CECO origen |
| `targetKind` | `PROJECTS` / `BUSINESS_LINES` / `COST_CENTERS` (cascada) / `MIXED` |
| `driver` | `FIXED_PERCENT` (tabla `AllocationRuleTarget` con %), `REVENUE_SHARE` (proporcional a ingresos directos del periodo), `DIRECT_COST_SHARE`, `HOURS` (de `TimeEntry`), `HEADCOUNT`, `EQUAL`, `MANUAL` |
| `targetFilter` | opcional: solo proyectos `ACTIVE`, solo una línea de negocio… |
| `period` | `MONTH` / `QUARTER` / `YEAR` |
| `priority` | orden de ejecución cuando un CECO se reparte a otro CECO antes que a proyectos (reparto en cascada, sin ciclos: validar DAG) |
| `validFrom` / `validTo` | versionado de la regla; nunca se edita una regla con liquidaciones, se cierra y se crea otra |

### Liquidación (`lib/analytics/allocate(ledgerLines, rules, period) → AllocationRun`)
1. Función pura; entrada = líneas del periodo + reglas vigentes + fecha de referencia.
2. Ordena reglas por `priority`; resuelve cascada CECO→CECO primero; detecta ciclos → error.
3. Para cada regla calcula base del driver desde el diario (nunca desde memoria), reparte en céntimos con método del mayor resto (Hamilton) para que Σ = saldo exacto (I5).
4. Produce `AllocationLine {runId, ruleId, sourceCostCenterId, targetProjectId|targetBusinessLineId|targetCostCenterId, amountCents, driverBase, driverSharePermille}`. **No toca el libro diario**: es capa analítica paralela, reversible (`AllocationRun.reversedAt`).
5. Rerun del mismo periodo = nuevo `AllocationRun` que sustituye al anterior (el anterior queda histórico con `supersededById`).

## Otros
- `TimeEntry` (horas por usuario/proyecto/día) opcional, sirve como driver `HOURS` y para coste de personal imputado (tarifa/hora por empleado en `EmployeeRate`, versionada).
- Presupuesto por proyecto y por CECO (`Budget` mensual) para desviaciones; la desviación es cálculo puro, nunca almacenada.
- Cierre de proyecto: al pasar a `CLOSED` se bloquean nuevas líneas salvo rol admin con motivo.
