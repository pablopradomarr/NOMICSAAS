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
| `EBIT` | EBITDA − `AMORTIZACION_DETERIORO` | 68x/69x/79x. **No se imputa vía CECO** (nunca entra en un `AllocationRun`): si el activo está afecto a un proyecto, la línea lleva `projectId` directo y se descuenta en la columna del proyecto **por debajo de MC3**; si no, va a un CECO y se descuenta en la columna de amortización. En ambos casos el importe cae en el nivel EBIT, nunca en MC1/MC2/MC3 (E3, decisión aprobada) |
| `BAI` | EBIT − `FINANCIERO` ± `EXTRAORDINARIO` | 66x/76x, 67x/77x |
| `RESULTADO` | BAI − impuesto (630, `NO_ANALITICO`) | |

La PyG analítica se presenta por **proyecto**, agregada por **línea de negocio**, y en columnas aparte los **CECOs no imputados**, **amortización/deterioro**, **financiero/extraordinario** y **no analítico**, para que la suma total iguale la PyG contable (invariante I4, definición única en skill `fiabilidad`).

## Reglas de imputación / liquidación (`AllocationRule`)

| Campo | Valores |
|---|---|
| `sourceCostCenterId` | CECO origen |
| `targetKind` | `PROJECTS` / `BUSINESS_LINES` / `COST_CENTERS` (cascada). **`MIXED` se retiró en E10**: toda mezcla son N reglas con `sourceShareBps` complementarios, que es más explícito y cuadra por I-E5-3 |
| `driver` | `FIXED_PERCENT` (tabla `AllocationRuleTarget` con %), `REVENUE_SHARE` (proporcional a ingresos directos del periodo), `DIRECT_COST_SHARE`, `HOURS` y `HEADCOUNT` (**drivers de actividad**, ver abajo), `EQUAL`, `MANUAL` |
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

## Drivers de ACTIVIDAD: `HOURS` y `HEADCOUNT` (E10, ADR-0018 D1)

ADR-0013 D4 los dejó **rechazados** hasta que hubiera datos; E10 los enciende sin
tocar Hamilton, la cascada, **E5-D1 (el nivel viaja con el importe)** ni el
determinismo. Dos ramas en `driverWeights` y un campo en `AllocationInput`.

| Driver | Peso `wᵢ` | Notas |
|---|---|---|
| **`HOURS`** | `Σ minutes` de `TimeEntry` **APROBADO y productivo** con receptor `i` y fecha en la ventana del **periodo** —ensanchada sólo si el `zeroBaseFallback` se aplicó de hecho—, contra-apuntes con su signo, `max(0, ·)` | Mide **consumo de estructura**, no coste: las horas de personal ya imputado a MC2 cuentan igual |
| **`HEADCOUNT`** | `Σ fteMilli` de los `HeadcountSnapshot` del periodo (**FTE·mes**), sin división ni redondeo | **Sólo a `COST_CENTERS`**: con proyectos no hay plantilla declarada y derivarla sería `HOURS` con otro nombre. Un CECO que vive diez meses pesa diez meses, no el stock a 31-12 |

**Ninguna regla queda muda.** Base 0 ⇒ `W-E10-NO-HOURS` / `W-E10-NO-HEADCOUNT` y
el saldo se queda **visible** en «pendiente de liquidar» con su motivo. Base
**parcial** ⇒ `W-E10-UNAPPROVED-HOURS` con los minutos y su % sobre la base, y el
motivo de sello `HORAS_SIN_APROBAR` —**también con base aprobada 0**, que es el
caso extremo y el más grave—. Y `W-E10-HEADCOUNT-TRAPPED` cuando el receptor no
tiene a su vez regla hacia proyectos: el saldo quedaría atrapado un nivel abajo.

**El cuarto sello.** La base de estos dos drivers **no está en el diario**, así
que no entra en `ledgerHash`, ni en `analyticsHash`, ni en `rulesHash`.
`AllocationRun` persiste `timeHash` **y la ventana** que consumió: aprobar en mayo
un parte de enero caduca (`STALE`) el run de marzo que repartió con él.

## Horas y coste-hora (E10)

- **Minutos ENTEROS**, nunca centésimas de hora: 7 h 20 min son `440` exactos.
  Techo 1 440 **por fila y agregado por (empleado, día)**. Un parte APROBADO es
  inmutable: se corrige por **contra-apunte** con motivo, nunca se edita ni se
  borra.
- **`EmployeeRate`** con vigencias sin solape y **`basis` explícita**
  (`BRUTO_SIN_SS` vs `COSTE_EMPRESA_CON_SS`, que difieren ~31,9 %): la `basis`
  **viaja con la cifra** en pantalla y en el export. Sin tarifa vigente el coste
  del receptor es **NO EVALUABLE** — jamás 0 ni la tarifa anterior.
- **Coste de un parte**: `T = ⌊Σ mᵢrᵢ / 60⌋` por receptor y Hamilton sobre los
  pesos `mᵢ·rᵢ`, con desempate por (fecha, código de empleado, id).
- **Absorción** (O-E10-20): `Σ (minutos × tarifa / 60) − Σ 64x`, con su signo, su
  % y su desglose. Es **información de gestión**, no un invariante. El desglose
  por CECO agrupa lo valorado por el CECO del **empleado** y la nómina por el de
  la **línea 64x**: son dos dimensiones distintas y la asimetría se **declara**
  (`SIN_NOMINA_QUE_ABSORBER`) en vez de publicarse como sobreabsorción falsa.
- **Imputar personal a proyectos** tiene dos caminos, los dos sin asiento nuevo:
  (a) el driver `HOURS` sobre el saldo del CECO —el que vale cuando el coste se
  reparte— y (b) la **reclasificación analítica** de ADR-0010 cuando la línea 64x
  es **íntegramente** de un proyecto (concentración 10 000 bps **fija**). El (b)
  baja el importe de MC3 a MC2 por R-A3, así que **mueve periodos ya
  informados**: lo acota la ventana temporal de ADR-0010 (mes bloqueado ⇒ sólo
  ADMIN; ejercicio cerrado ⇒ nunca).

## Presupuesto (E10, ADR-0018 D2 y D4)

- **Versionado y sellado**: `(ejercicio, escenario, revisión)` con vigencias sin
  solape **ni hueco**, `partialFrom` para las revisiones que sólo traen medio
  año, y la versión **efectiva** se **compone** mes a mes (O-E10-9). Una
  `REVISADO` de julio-diciembre sin componer desinflaba el año a la mitad.
- **`amountCents` es un APORTE** (ingreso +, gasto −) y **su signo lo fuerza el
  tipo analítico**; la excepción sólo vale en familias declaradas (`61x`/`71x`,
  `706`/`708`/`709`, `79x`/`759`). Un `6400` tecleado en positivo duplicaba la
  desviación con ejecución exacta.
- **`budgetHash`** = sha256(cabecera ‖ líneas de importe **con su `marginLevel`
  congelado** ‖ **líneas de horas en minutos** ‖ `marginConfigHash`). **`valid_to`
  NO entra**: es mutable por diseño —al sellar la siguiente versión se cierra la
  anterior— y dentro del sello hacía irreproducible el hash de toda versión
  relevada. Sellada, la versión no se edita: **se sustituye**.
- **Presupuesto y real se comparan en el MISMO estado de imputación**: con
  imputaciones, el presupuesto pasa por `settleBudgetMatrix()` —las mismas reglas
  y `allocate()`, con las **horas presupuestadas** como base—, y si no puede
  seguirlo, las celdas por dimensión de nivel ≥ MC3 **no se publican**.
- **El forecast es una vista derivada**, nunca una tabla: real hasta el corte,
  presupuesto después, con el corte en `paramsHash`.
- Sin presupuesto para una celda, las columnas derivadas salen **vacías con
  leyenda**: nunca a cero. Un cero es una cifra y afirma algo falso.

## Otros
- Cierre de proyecto: al pasar a `CLOSED` se bloquean nuevas líneas salvo rol
  admin con motivo. Para el reparto, un proyecto CERRADO que **consumió** horas
  en el periodo sigue absorbiendo su estructura (§1.3); uno `PLANNED` —el
  contenedor `P-<LN>-NUEVOS`— admite presupuesto y **nunca** recibe imputación.
- Motores puros: `lib/budget/` (hash y composición, matriz, desviación, forecast)
  y `lib/time/` (agregados, coste-hora, propuesta de reclasificación de nómina).
  Sin IO, sin `Date.now()`, sin LLM.
