# E5 — Validación contable de la liquidación de CECOs: drivers, cascada, periodo, invariantes y matriz imputada esperada

> Rol: `experto-contable`. Fuentes: `.claude/skills/contabilidad-analitica` (§Reglas de imputación / liquidación), `.claude/skills/fiabilidad` (**I4**, **I5**), **ADR-0004 (APROBADO)**, `docs/design/E4-analitica.md`, `docs/design/E4-validacion-analitica.md` (matriz sellada, **R-A1…R-A12**, **I-E4-1…12**, E4-D1/E4-D2), `docs/MODELO-DATOS.md` §Analítica (`AllocationRule`, `AllocationRuleTarget`, `AllocationRun`, `AllocationLine`, `Driver`, `TargetKind`, `AllocPeriod`), `lib/analytics/margins.ts` (matriz actual, **sin** imputaciones), `tests/fixtures/ejercicio-completo.json`.
> Norma: **RD 1514/2007** (PGC 2007; NRV 14ª devengo, modelo de PyG) · **Código de Comercio arts. 25–29** (la contabilidad analítica **no es libro obligatorio**) · **RD 602/2016**, **RD 1/2021**. La liquidación **nunca genera asientos financieros** (ADR-0004).
> **Todas las cifras proceden del fixture inmutable `tests/fixtures/ejercicio-completo.json`, que es ilustrativo.** Ningún importe procede de datos reales. Céntimos enteros en todo el documento.
> Entregables de esta épica: este documento · `docs/design/fixtures/build_liquidacion_esperada.py` (con `--check`) · `docs/design/fixtures/liquidacion-esperada.json`. **`tests/fixtures/*` no se toca**: es entrada, es inmutable y está sellado por E3.

---

## 0. Las tres decisiones de fondo de E5

Antes de la letra pequeña, tres decisiones que gobiernan todo lo demás y que no estaban escritas en ningún sitio.

| # | Decisión | Por qué es obligatoria |
|---|---|---|
| **E5-D1** | **El nivel de margen viaja con el importe, no con el receptor.** Un `AllocationLine` lleva su propio `marginLevel`, heredado del nivel en el que el importe se cargó originalmente (el `CostCenter.marginLevel` del CECO **donde nació el gasto**), y se absorbe en el receptor **en ese mismo nivel** | Sin esto, una cascada entre niveles (CC-GA `EBITDA` → CC-OPS `MC3`) movería importe de un nivel a otro y **rompería I4.a**: el total de la fila MC3 dejaría de coincidir con la PyG contable. Con esto, la imputación es un traspaso de **suma cero en cada nivel** y I4 se cumple al céntimo sin tolerancia. Es también la lectura de gestión correcta: el alquiler de la oficina no se convierte en coste operativo de un proyecto por el hecho de pasar por Operaciones |
| **E5-D2** | **`AllocationRule` gana `sourceShareBps`**: la fracción del saldo del CECO fuente que esa regla liquida, con Σ = 10000 por (CECO fuente, `period`) | Hoy el modelo permite N reglas por CECO y **no dice qué fracción del saldo liquida cada una**. Sin el campo, «CC-GA reparte 30 % a un sitio y 70 % a otro» no es representable salvo inventando una regla `MIXED` con targets heterogéneos, que además obliga a fijar por porcentaje lo que se quiere repartir por driver. Con `sourceShareBps`, cada regla conserva **un solo driver** y el reparto del saldo entre reglas es a su vez Hamilton (Σ exacta) |
| **E5-D3** | **La matriz gana columnas `BL:<código>`** para lo imputado a una línea de negocio y no bajado a proyecto | La definición canónica de I4 (skill `fiabilidad`) ya cuenta con «imputaciones a líneas de negocio **sin proyecto**» como columna del sumatorio; el esquema sellado de E4 no la tiene porque E4 es «sin imputaciones». Son columnas **reales del total**, distintas de `businessLineMatrixCents`, que es presentación (agregado de proyectos) y no suma. Tras E5, la fila de presentación de una LN = Σ sus proyectos **+** su columna `BL:` |

---

## 1. Semántica de los drivers

### 1.0 Definiciones comunes a todos los drivers

| Concepto | Definición exacta |
|---|---|
| **Periodo del run** `P` | Intervalo cerrado `[periodStart, periodEnd]` derivado de `AllocRule.period` (`MONTH`/`QUARTER`/`YEAR`) sobre el ejercicio. La base **siempre** se calcula sobre ese intervalo, nunca sobre otro |
| **Conjunto de líneas base** `L(P)` | Exactamente el conjunto de I3/I4: líneas de grupo 6/7 del ejercicio con `entryDate ∈ P` y `entryKind ∉ {REGULARIZATION, CLOSING, OPENING}`. **Desde el diario, nunca desde memoria ni desde una tabla de resultados** (ADR-0004) |
| **Aporte** | `aporte(l) = creditCents − debitCents`. Un coste es negativo. Los drivers de coste trabajan con `coste(l) = −aporte(l)`, positivo |
| **Saldo propio del CECO** `own(s,P)` | `Σ −aporte(l)` para `l ∈ L(P)` con `costCenterId = s` **y tipo efectivo `INDIRECTO_CECO`**. Nunca incluye `AMORTIZACION_DETERIORO` (nivel EBIT, R-A5 y decisión de E3), ni `FINANCIERO`, ni `EXTRAORDINARIO`, ni `NO_ANALITICO`, aunque la línea lleve ese CECO |
| **Base liquidable** `base(s,R)` | `own(s,P) − yaRepartido(s,P) + recibidoEnCascada(s,R)`, **por nivel de margen** (E5-D1). `yaRepartido` = Σ `AllocationLine` vigentes con fuente `s` emitidas por runs de periodo **más fino** contenidos en `P`. Esta definición es la que hace convivir una regla mensual y una anual sobre el mismo CECO sin doble reparto |
| **Base del driver** `w_i` | Peso **entero, adimensional y ≥ 0** de cada receptor. Los pesos se guardan en `AllocationLine.driverBase` (y su total en `driverBaseTotal`) para que la celda sea auditable sin recomputar |
| **Elegibilidad** | Un receptor entra en el reparto si pasa `targetFilter` **y** su dimensión está activa (`isActive`, no `archivedAt`) al `periodEnd`. Un proyecto entra si su `status ∈ targetFilter.projectStatus` (default `[ACTIVE]`) |

### 1.1 Tabla de drivers

| Driver | Fórmula exacta del peso `wᵢ` | Base (qué líneas, qué periodo) | Notas contables |
|---|---|---|---|
| **`REVENUE_SHARE`** | `wᵢ = max(0, Σ aporte(l))` para `l ∈ L(P)` con `projectId = i` y **tipo efectivo `INGRESO_DIRECTO`**, **excluyendo toda cuenta con prefijo `74`** (**R-A12**) | Ingresos directos del **periodo del run**, por proyecto elegible | Es el driver de «capacidad de absorción». La exclusión de `74x` es la regla heredada de E4: una subvención finalista no es capacidad de absorción de estructura, y contarla haría que el proyecto subvencionado cargase con más G&A por el mero hecho de estar subvencionado. `706`/`708`/`709` **sí** entran (con signo negativo, porque son contra-cuentas del mismo `INGRESO_DIRECTO` y minoran la cifra de negocio real del proyecto) |
| **`DIRECT_COST_SHARE`** | `wᵢ = max(0, Σ −aporte(l))` para `l ∈ L(P)` con `projectId = i` y tipo efectivo **∈ {`COSTE_DIRECTO_MC1`, `COSTE_DIRECTO_MC2`}** | Costes directos MC1 + MC2 del periodo, por proyecto elegible | Es decir: **todo lo que el proyecto consume por encima de MC2**. No incluye `INDIRECTO_CECO` (sería circular: repartir estructura en función de la estructura ya repartida), ni `AMORTIZACION_DETERIORO` (nivel EBIT), ni imputaciones previas de otros CECOs (no son coste directo). Es el driver por defecto para CECOs de operaciones: la estructura operativa se consume en proporción a la actividad ejecutada |
| **`HOURS`** *(contrato; datos en E10)* | `wᵢ = Σ TimeEntry.minutes` con `projectId = i` y `date ∈ P`, sobre entradas **aprobadas** (`TimeEntry.approvedAt IS NOT NULL`) | Partes de horas del periodo | **Contrato que E10 debe cumplir**: (a) minutos enteros, nunca horas decimales; (b) solo entradas aprobadas — una hora sin aprobar no reparte dinero; (c) las horas de personal **ya imputado directamente a MC2** cuentan igual: el driver mide *consumo de estructura*, no coste; (d) si la organización no tiene `TimeEntry` en el periodo, la regla cae en `zeroBaseFallback`. Mientras E10 no exista, `HOURS` es **rechazado al guardar la regla** (`DRIVER_UNAVAILABLE`), no silenciado. Base sintética del fixture y reparto ilustrativo: §5.6 |
| **`HEADCOUNT`** *(contrato; datos en E10)* | `wᵢ = Σ` FTE asignados al receptor a `periodEnd`, en **milésimas de FTE** (`fteMilli`), desde `EmployeeAssignment` | Plantilla asignada al cierre del periodo, no media del periodo | Se elige **stock a fin de periodo** y no media, por simplicidad auditable y porque el driver se usa para repartir costes de RR.HH. y espacio, que se consumen por presencia. Si la organización quiere media, es un driver distinto (`HEADCOUNT_AVG`), no un parámetro |
| **`EQUAL`** | `wᵢ = 1` para todo receptor elegible | El propio conjunto de receptores elegibles del periodo | Partes iguales. Es el único driver cuyo resultado **no depende del diario**, y por eso es el fallback natural de base cero. Advertencia de gestión que la UI debe mostrar: reparte igual un proyecto de 2 M€ y uno de 20 k€ |
| **`FIXED_PERCENT`** | `wᵢ = AllocationRuleTarget.percentBps`, con **Σ wᵢ = 10000** (validación dura) | No lee el diario: la base es la propia tabla de targets | Único driver con targets explícitos. Σ ≠ 10000 ⇒ la regla **no se guarda** (I-E5-2). Un target con 0 bps es admisible (documenta la exclusión deliberada) |
| **`MANUAL`** | `wᵢ` no se usa: el usuario informa **importes** en `AllocationRuleTarget.amountCents` | Ninguna | **Σ importes = base liquidable del CECO en el periodo, exigido antes de persistir el run** (I-E5-10). Si el saldo cambia (un asiento tardío del periodo), el run queda `STALE` y hay que reeditar: un reparto manual **nunca se reescala solo**, porque el usuario declaró importes, no proporciones. Requiere `reason` obligatorio y rol `ADMIN` |

### 1.2 Tratamiento de la base cero

> **Regla por defecto: `SKIP_WARN` — no se reparte nada y el importe queda visible en la columna del CECO.** Nunca se inventa un reparto.

`AllocationRule.zeroBaseFallback` (nuevo campo, enum) permite apartarse de ella de forma **declarada y auditable**:

| Valor | Comportamiento cuando `Σ wᵢ = 0` | Cuándo es correcto |
|---|---|---|
| **`SKIP_WARN`** *(default)* | No se emite ningún `AllocationLine`. El saldo permanece en la columna del CECO y la Auditoría emite `W-E5-ZERO-BASE` con CECO, periodo, regla e importe no repartido | Siempre que la ausencia de base sea **información**: si no hubo ingresos, decir que la estructura no se absorbió es la verdad |
| **`EQUAL`** | Se reparte a partes iguales entre los receptores elegibles | Estructura que se consume por existir (seguros, licencias por sede) |
| **`YTD`** | La base se amplía al **acumulado del ejercicio hasta `periodEnd`** con el mismo driver | Driver de actividad con estacionalidad fuerte o con costes que llegan en un mes sin actividad. Es el caso del fixture (§5.2) |
| **`PRIOR_PERIOD`** | Se usa la base del periodo inmediatamente anterior del mismo tipo | Cuando el mes de referencia es un hueco puntual (agosto) |

Reglas comunes a los cuatro: (a) el fallback aplicado se **persiste en cada `AllocationLine`** (`fallbackApplied`), no solo en la regla; (b) si el fallback tampoco produce base > 0, se degrada a `SKIP_WARN`; (c) la Auditoría lista todo periodo con fallback aplicado, porque un fallback recurrente es señal de que la regla está mal elegida.

### 1.3 Bases negativas, saldo fuente negativo y proyectos cerrados

| Caso | Regla | Razón |
|---|---|---|
| **Un receptor con base negativa** (proyecto con abono neto de ingresos o de coste en el periodo) | `wᵢ = max(0, base)` ⇒ **peso 0, excluido**, con WARN `W-E5-NEG-BASE` que nombra al receptor | Un peso negativo en un reparto proporcional produce cuotas > 100 % en los demás y una cuota de **signo contrario** en él: el proyecto con una devolución **recibiría un ingreso de estructura**. Es matemáticamente inestable (con Σ pesos → 0 las cuotas divergen) y contablemente falso |
| **Todos los receptores con base ≤ 0** | Σ pesos = 0 ⇒ se aplica §1.2 (base cero) | — |
| **Saldo del CECO fuente negativo** (más `79x`/`759` reversiones que gasto, o un abono de proveedor de estructura) | **Se reparte igualmente**, con el mismo driver y el mismo Hamilton aplicado sobre `|importe|` y el signo restituido al final | El CECO tiene que quedar liquidado también cuando su saldo es acreedor; si no, la columna del CECO conservaría un saldo positivo permanente y I5.b fallaría. Aplicar Hamilton sobre el valor absoluto evita el sesgo de redondeo hacia cero del truncamiento con signo |
| **Proyecto que se cierra dentro del periodo** | Para drivers de actividad (`REVENUE_SHARE`, `DIRECT_COST_SHARE`, `HOURS`): **entra** si tuvo base > 0 en el periodo, aunque esté `CLOSED` al `periodEnd`. Para `EQUAL`, `HEADCOUNT` y `FIXED_PERCENT`: **entra solo si está `ACTIVE` al `periodEnd`** | Un proyecto que consumió estructura en enero y cerró en marzo **debe** cargar con la estructura de enero: excluirlo la trasladaría a los proyectos vivos y falsearía dos márgenes a la vez. En cambio dar 1/N a un proyecto cerrado sin actividad es puro reparto ciego. El `targetFilter` por defecto (`projectStatus: [ACTIVE]`) se interpreta con esta matización, y la excepción queda anotada en la línea (`eligibilityReason = "ACTIVITY_IN_PERIOD"`) |
| **Proyecto `PLANNED`** | Nunca recibe imputación, tenga o no base | No ha empezado: cargarle estructura crea un margen negativo antes del primer ingreso |
| **Dimensión archivada** (`isActive = false` / `archivedAt`) | **Nunca** es destino. Si el diario tiene actividad del periodo contra ella, la regla emite `W-E5-ARCHIVED-TARGET` y la Auditoría exige desarchivar o reclasificar | I-E5-7 |

### 1.4 Redondeo: mayor resto (Hamilton), determinista

```
Entrada: importe T (céntimos, con signo), pesos wᵢ ≥ 0 enteros, W = Σwᵢ > 0
  signo = sign(T);  A = |T|
  qᵢ    = ⌊A·wᵢ / W⌋                     (división entera, sin float en ningún punto)
  restoᵢ = A·wᵢ − qᵢ·W                    (entero, comparable sin error)
  r     = A − Σqᵢ                         (0 ≤ r < n)
  se suma 1 céntimo a los r receptores de mayor restoᵢ
  empate de restoᵢ  →  gana el de CÓDIGO MENOR (orden lexicográfico del code)
  resultadoᵢ = signo · qᵢ
```

| Regla | Valor |
|---|---|
| Σ resultadoᵢ = T | **exacto, tolerancia 0** — de ahí que I5 se exija a 0 y no a 1 céntimo |
| Remanente repartido `r` | `0 ≤ r ≤ n − 1` céntimos, uno como máximo por receptor (**I-E5-4**) |
| Desempate | **menor código**. No «el mayor receptor»: el mayor receptor no es determinista cuando dos empatan y depende del orden de lectura de la BD, lo que rompería P7 (reproducibilidad byte a byte) |
| Prohibido | `float`, `Decimal`, `round()`, porcentajes intermedios. Todo el cálculo es aritmética entera sobre `A·wᵢ` |

> **Enmienda propuesta a la skill `fiabilidad`, I5.** El texto vigente dice «Σ importes imputados = saldo del CECO en el periodo; remanente ≤ 1 céntimo asignado al mayor receptor · tolerancia **1 céntimo**». Con el mayor resto la suma es **exacta**: la tolerancia correcta es **0**, y el «remanente ≤ 1 céntimo» describe el remanente **por receptor**, no el del reparto (que es ≤ n−1 céntimos en total). Redacción propuesta: «Σ `AllocationLine` por CECO fuente y nivel = base liquidable del CECO en el periodo (**tolerancia 0**, garantizada por el método del mayor resto); ningún receptor absorbe más de 1 céntimo de remanente». Sin esta corrección, un motor que dejase 1 céntimo sin repartir pasaría el invariante y la columna del CECO nunca llegaría a 0.

---

## 2. Cascada CECO → CECO

### 2.1 Orden de ejecución dentro de un run

1. Se seleccionan las reglas **vigentes** a `periodEnd` (`validFrom ≤ periodEnd`, `validTo IS NULL OR validTo ≥ periodEnd`) y `isActive`, del mismo `period` que el run.
2. Se ordenan por **`(priority ASC, code ASC)`** — el `code` desempata para que el orden sea total y reproducible (P7).
3. Se construye el grafo dirigido `G` con una arista `fuente → destino` por cada `AllocationRuleTarget` de `targetKind ∈ {COST_CENTERS, MIXED}`. **Si `G` tiene ciclo, el run falla entero** (`ALLOCATION_CYCLE`), no se persiste nada y se nombran los CECOs del ciclo (**I-E5-1**). No hay reparto parcial: un ciclo no es un aviso, es una configuración imposible.
4. Se comprueba que el orden por prioridad es un **orden topológico** de `G`: para toda arista `a → b`, toda regla con fuente `b` y el mismo `period` debe tener `priority` estrictamente mayor que la de la regla `a → b` (**I-E5-8**). Si no lo es, error de configuración con la lista de aristas infractoras: se rechaza en vez de reordenar en silencio, porque reordenar cambiaría el resultado que el usuario ve en la simulación.
5. Se ejecutan las reglas en ese orden. La base de cada fuente se recalcula **en el momento de ejecutarla**, incluyendo lo recibido en cascada dentro del propio run (§1.0, `base(s,R)`). Así **un CECO que recibe y reparte en la misma liquidación** funciona sin ninguna pasada extra.

### 2.2 Periodos y cascada

> **Una arista de cascada solo une reglas del MISMO `period`.** Un donante `YEAR` no puede alimentar a un receptor que reparte `MONTH`: la liquidación mensual de noviembre no puede conocer un importe anual que aún no existe.

Consecuencia práctica, y es la del fixture: si CC-GA reparte **anualmente** el 30 % a CC-OPS, CC-OPS necesita **dos reglas** — una `MONTH` que liquida su propio coste mes a mes, y una `YEAR` que redistribuye lo recibido en cascada. No hay doble reparto porque la base anual de CC-OPS es `own(YEAR) − yaRepartido(mensual) + recibido = 0 + recibido` (§1.0). El motor lo valida (`CASCADE_PERIOD_MISMATCH`) en vez de intentar prorratear un importe anual entre meses, que sería inventar devengo.

### 2.3 Tabla de destinos permitidos y nivel de absorción en el receptor

`ℓ` = nivel que **viaja con el importe** (E5-D1), fijado por el `CostCenter.marginLevel` del CECO **donde nació el gasto**, no por el del CECO que lo está repartiendo.

| CECO fuente | `marginLevel` | Destino `PROJECTS` | Destino `BUSINESS_LINES` | Destino `COST_CENTERS` | Nivel absorbido en el receptor |
|---|---|---|---|---|---|
| `CC-OPS` Operaciones indirectas | **MC3** | ✔ | ✔ | ✔ *(solo CECOs `allocatable`)* | **MC3** de la columna del receptor |
| `CC-DEV` Desarrollo de producto | **MC3** | ✔ | ✔ | ✔ | **MC3** |
| `CC-MKT` Marketing y ventas | **EBITDA** | ✔ | ✔ | ✔ | **EBITDA** |
| `CC-GA` General y administración | **EBITDA** | ✔ | ✔ | ✔ | **EBITDA** |
| `CC-OTR` Otros | EBITDA | ✔ | ✔ | ✔ | EBITDA |
| `CC-FIN` Financiero | — | ✖ | ✖ | ✖ | **Nunca fuente ni destino** (`allocatable = false`) |
| `CC-EXT` Extraordinario | — | ✖ | ✖ | ✖ | **Nunca fuente ni destino** |
| `CC-NA` Sin asignar | — | ✖ | ✖ | ✖ | **Nunca fuente ni destino** |

**Cómo leer la fila «cascada» sin equivocarse.** La restricción del enunciado —«un CECO MC3 solo puede repartir a proyectos o a CECOs MC3»— es la formulación **conservadora** de la regla correcta, y es innecesariamente estrecha en un sentido y peligrosamente laxa en otro:

| Movimiento | ¿Permitido? | Nivel absorbido | Comentario |
|---|---|---|---|
| MC3 → CECO MC3 → proyecto | Sí | MC3 | Caso trivial |
| **EBITDA → CECO MC3** (CC-GA → CC-OPS, el del fixture) | **Sí** | **EBITDA** | Es un movimiento organizativamente normal (parte de G&A es coste de soporte a Operaciones). Lo que **no** se permite es que ese importe se convierta en MC3 al pasar por CC-OPS: si lo hiciera, el MC3 de la compañía bajaría 189 954 c sin que la PyG contable cambiara y **I4.a fallaría en la fila MC3**. El importe conserva `marginLevel = EBITDA` y aterriza en el EBITDA de los proyectos |
| **MC3 → CECO EBITDA** | Sí, pero **sube el importe a EBITDA solo si se le cambiara el nivel** ⇒ **prohibido cambiarlo**: conserva MC3 | Mismo argumento, simétrico |
| Cualquiera → `CC-FIN`/`CC-EXT`/`CC-NA` | **No** (`ALLOCATION_TARGET_NOT_ALLOCATABLE`) | — | Un CECO no imputable no puede recibir: quedaría con saldo inmovilizado y sin regla para sacarlo |
| Cualquiera → sí mismo | **No** (autoarista = ciclo trivial) | — | I-E5-1 |
| CECO → proyecto `CLOSED`/`PLANNED` o dimensión archivada | **No** | — | §1.3, I-E5-7 |

En consecuencia, `AllocationLine` **necesita un campo `marginLevel`** (`MC3` | `EBITDA`) y la base liquidable de un CECO se lleva **por nivel**: un CECO en cascada puede estar sosteniendo simultáneamente un bucket MC3 (suyo) y un bucket EBITDA (recibido), y cada uno se reparte por separado, con su propio Hamilton. Es la única forma de que I4 se cumpla nivel a nivel con tolerancia 0.

### 2.4 Destino `BUSINESS_LINES` y `MIXED`

- **`BUSINESS_LINES`**: el importe se queda en la **columna `BL:<código>`** (E5-D3), en el nivel `ℓ`. No se prorratea después entre los proyectos de la LN: si la organización quiere eso, la regla correcta es `PROJECTS` con `targetFilter.businessLineCode`. Presentar la LN como receptor final es honesto cuando el coste es de la línea (dirección de la LN, producto común) y no atribuible a un proyecto.
- **`MIXED`**: se **desaconseja y no se usa en el fixture**. Con `sourceShareBps` (E5-D2), toda mezcla se expresa como varias reglas de un solo `targetKind` y un solo driver, que es más legible y más auditable. Se conserva en el enum porque es contrato, y si se usa, sus targets deben ser todos `FIXED_PERCENT` con Σ = 10000.

---

## 3. Periodo de liquidación y su relación con el periodo del informe

### 3.1 Reglas

| Situación | Comportamiento |
|---|---|
| **Informe de periodo `P` con reglas de periodo más fino** (informe trimestral, reglas mensuales) | La matriz suma los `AllocationLine` de **todos los runs vigentes cuyo `[periodStart, periodEnd]` esté contenido en `P`**. No se re-liquida nada: `Σ runs` es exacto porque cada run ya cuadra a 0 (I5.a) |
| **Informe de periodo `P` con reglas de periodo más grueso** (informe mensual, regla `YEAR`) | **No hay liquidación**: el importe **no se reparte a medias ni se prorratea**. El CECO conserva su saldo, la columna del CECO lo muestra, y la matriz añade la marca **«pendiente de liquidar»** con el importe y la fecha en que se liquidará (`nextSettlementDate = periodEnd` de la regla). Prorratear un anual entre meses sería inventar un devengo que la regla no declara |
| **Run que se solapa parcialmente con el informe** (regla trimestral, informe de febrero) | **Nunca se trocea un run.** El run entra entero o no entra; con un informe que corta un run por la mitad, el run **no entra** y su importe aparece como pendiente de liquidar. Trocear exigiría un criterio de reparto intra-periodo que la regla no tiene |
| **Ejercicio a caballo / periodo del informe que cruza ejercicios** | Prohibido: un `AllocationRun` pertenece a **un** `fiscalYear`. La base y las reglas vigentes son las de ese ejercicio |

**Presentación (`ui-erp`).** Tres cifras por CECO en toda vista analítica: `saldoPropio`, `imputado`, `pendienteDeLiquidar = saldoPropio + recibido − imputado`. Un CECO con pendiente ≠ 0 se marca en la cabecera de la columna y la nota al pie dice por qué (regla anual no vencida, base cero con `SKIP_WARN`, o sin regla). Nunca se muestra un margen «MC3 imputado» sin decir qué parte de la estructura falta por absorber.

### 3.2 Inmutabilidad, sustitución y reversión

| Concepto | Regla |
|---|---|
| **Inmutabilidad** | `AllocationRun` y sus `AllocationLine` son **append-only**: sin `UPDATE` (salvo las columnas `supersededById`, `reversedAt`, `reversedById`, `reversalReason`) y sin `DELETE`. Mismo patrón de `GRANT` de columna que `journal_lines` en E3 |
| **Rerun / sustitución** | Volver a liquidar el mismo `(organizationId, periodStart, periodEnd)` crea un **run nuevo**; el anterior recibe `supersededById = nuevo.id` y **deja de aportar** a cualquier matriz (I-E5-9). Nunca se sobrescribe: el histórico es la prueba de por qué un informe emitido decía lo que decía (P3) |
| **Reversión** | `reversedAt` + `reversedById` + `reversalReason` (≥ 10 caracteres, rol `ADMIN`) para deshacer **sin** sustituir. Un run revertido tampoco aporta. La reversión **no genera asientos**: se limita a apagar el run (ADR-0004) |
| **Disparadores automáticos de caducidad** | (a) Cualquier asiento nuevo o contra-asiento con `entryDate` dentro del periodo del run ⇒ `ledgerHash` distinto ⇒ el run queda `STALE` y la Auditoría lo lista; (b) toda **reclasificación analítica** del periodo (E4-D1 / ADR-0010, salvaguarda 5) ⇒ `analyticsHash` distinto ⇒ el run se marca `supersededAt` y hay que relanzarlo; (c) cambio de una `AllocationRule` vigente ⇒ `rulesHash` distinto. Un run `STALE` **no se borra**: se sustituye |
| **Versionado de reglas** | «Nunca se edita una regla con liquidaciones»: se cierra con `validTo` y se crea otra (skill `contabilidad-analitica`). Un `UPDATE` sobre una `AllocationRule` referenciada por algún `AllocationLine` se rechaza en BD |
| **Sellos del run** | `AllocationRun` guarda `ledgerHash` + `analyticsHash` + `rulesHash` + `gitSha`. `rulesHash` = `sha256` de las reglas vigentes en forma canónica ordenada por `(priority, code)`, **con `sourceShareBps`, `zeroBaseFallback` y los targets dentro** |

### 3.3 `allocationRunId` dentro de `analyticsKey` de `ReportRun`

E4-D2 definió `analyticsHash` incluyendo «**el `allocationRunId` vigente**», en singular. **Es insuficiente y hay que corregirlo en E5**: un informe anual con reglas mensuales se apoya en **12 runs**, y uno con reglas de tres periodicidades distintas, en 17. Corrección:

```
analyticsHash = sha256(
    dimensiones de las líneas del periodo (entryId, lineNo, projectId, costCenterId, businessLineId, analyticType)
  ‖ marginConfigHash
  ‖ allocationRunSetHash )

allocationRunSetHash = sha256( join("\n", sorted( id de TODO AllocationRun vigente
                                                  —no superseded, no reversed—
                                                  con [periodStart, periodEnd] ⊆ periodo del informe )) )
```

Con conjunto vacío, `allocationRunSetHash` = `sha256("")`, que es lo que hace que la PyG analítica **sin** imputaciones de E4 y la **con** imputaciones de E5 sean dos `ReportRun` distintos y no se sirvan la una por la otra desde caché. La clave de reutilización sigue siendo `(organizationId, type, ledgerHash, analyticsHash)`.

---

## 4. Invariantes

### 4.1 I5 — formulación exacta

```
Notación (por organización y por AllocationRun R de periodo P):
  own(s,P)        = Σ −aporte(l),  l ∈ L(P), l.costCenterId = s, tipoEfectivo(l) = INDIRECTO_CECO
  yaRepartido(s,P)= Σ AllocationLine.amountCents de runs VIGENTES de periodo más fino ⊂ P, fuente s
  recibido(s,R)   = Σ AllocationLine.amountCents de R con targetCostCenterId = s
  base(s,R,ℓ)     = [own(s,P) restringido al nivel ℓ] − yaRepartido(s,P,ℓ) + recibido(s,R,ℓ)

I5.a  (por run, fuente y nivel)
      ∀R, ∀s, ∀ℓ:  Σ AllocationLine{runId=R, sourceCostCenterId=s, marginLevel=ℓ}.amountCents
                   = base(s,R,ℓ)                                        -- TOLERANCIA 0

I5.b  (cierre del ejercicio)
      ∀ CECO s con allocatable = true y al menos una regla vigente:
          own(s, ejercicio) + Σ recibido(s) − Σ imputado(s)  =  0        -- TOLERANCIA 0
      es decir: su columna en la matriz vale 0 en TODOS los niveles

I5.c  (no imputables)
      ∀ s ∈ {CC-FIN, CC-EXT, CC-NA}:  Σ AllocationLine{source = s} = 0
                                   ∧  Σ AllocationLine{target = s} = 0
```

La tolerancia es **0**, no 1 céntimo: el mayor resto reparte el remanente entero (§1.4). Un céntimo sin repartir es un **fallo**, no un redondeo aceptable.

### 4.2 I4 después de imputar

```
Sea Δ[ℓ][c] el efecto de las imputaciones sobre la matriz:
    Δ[ℓ][columna del CECO fuente]  += +amountCents      (alivio)
    Δ[ℓ][columna del receptor]     += −amountCents      (cargo)
  con el MISMO ℓ en las dos (E5-D1)

I4.post  ∀ℓ:  Σ_c Δ[ℓ][c] = 0                                     -- traspaso interno de suma cero
         ⇒   Σ_c M_E5[ℓ][c] = Σ_c M_E4[ℓ][c] = PyG contable acumulada hasta ℓ   -- tolerancia 0
```

Es decir: **I4 no se «vuelve a comprobar» tras imputar, se cumple por construcción**, y el test lo verifica comparando los ocho totales de nivel de `liquidacion-esperada.json` contra los de `pyg-analitica-esperada.json`. Si un solo nivel difiere, o el motor movió importe entre niveles (violación de E5-D1) o perdió/duplicó una línea.

### 4.3 Invariantes propios de E5

| Id | Regla | Comprobación | Severidad |
|---|---|---|---|
| **I-E5-1** | **Sin ciclos.** El grafo de aristas `fuente → CECO destino` de las reglas vigentes del mismo `period` es un DAG; no hay autoaristas | DFS al guardar la regla **y** al lanzar el run | FAIL (el run no se persiste) |
| **I-E5-2** | **Σ % = 100 %.** Toda regla `FIXED_PERCENT`: `Σ AllocationRuleTarget.percentBps = 10000` | CHECK diferido + validación al guardar | FAIL |
| **I-E5-3** | **Σ del saldo fuente = 100 %.** Por cada `(sourceCostCenterId, period)` con reglas vigentes: `Σ sourceShareBps = 10000` | validación al guardar (E5-D2) | FAIL |
| **I-E5-4** | **Remanente acotado.** En todo reparto, los céntimos de remanente `r` cumplen `0 ≤ r ≤ n − 1` y ningún receptor recibe más de 1 céntimo de remanente | test de propiedad sobre Hamilton | FAIL |
| **I-E5-5** | **Fuentes y destinos legales.** Ningún `AllocationLine` tiene por fuente o por destino un CECO con `allocatable = false` (`CC-FIN`, `CC-EXT`, `CC-NA`) | consulta + CHECK por FK a vista | FAIL |
| **I-E5-6** | **El nivel viaja con el importe.** `Σ_c Δ[ℓ][c] = 0` en cada nivel de margen; `AllocationLine.marginLevel` de una línea de cascada es igual al de la línea que la alimentó | test sobre el fixture | FAIL |
| **I-E5-7** | **Ningún destino archivado.** Ningún `AllocationLine` apunta a proyecto `CLOSED`/`PLANNED` (salvo la excepción `ACTIVITY_IN_PERIOD` de §1.3, que se anota), ni a LN o CECO con `isActive = false` | consulta | FAIL |
| **I-E5-8** | **Cascada resuelta.** El orden `(priority, code)` es orden topológico del grafo; todo CECO que recibe y reparte en el mismo run lo hace después de recibir | validación al lanzar | FAIL |
| **I-E5-9** | **Run supersedido no cuenta.** `Σ AllocationLine de runs vigentes = Σ AllocationLine que aporta la matriz`; ningún run con `supersededById` o `reversedAt` contribuye | consulta + test | FAIL |
| **I-E5-10** | **`MANUAL` cuadrado.** Toda regla `MANUAL`: `Σ AllocationRuleTarget.amountCents = base(s,R,ℓ)` antes de persistir el run | validación al lanzar | FAIL (no se persiste) |
| **I-E5-11** | **Inmutabilidad del run.** Ningún `UPDATE` sobre `allocation_lines`; sobre `allocation_runs` solo `supersededById`, `reversedAt`, `reversedById`, `reversalReason`. Ningún `DELETE` en ninguna de las dos | `GRANT` de columna + trigger, test de integración | FAIL |
| **I-E5-12** | **Reproducibilidad.** Dos ejecuciones con el mismo `(ledgerHash, analyticsHash, rulesHash)` producen el **mismo** conjunto de `AllocationLine` byte a byte, incluidos el orden y los desempates (P7) | test de reproducibilidad | FAIL |

---

## 5. Fixture esperado: liquidación de `ejercicio-completo.json` (2026)

Calculada por **`docs/design/fixtures/build_liquidacion_esperada.py`** (Python puro, sin `lib/`, sin BD, sin float; reutiliza el generador de E4 como única fuente de verdad para la resolución de cuentas y el tipo efectivo) y sellada en **`docs/design/fixtures/liquidacion-esperada.json`**. `--check` reconstruye y falla si difiere en un céntimo.

### 5.1 Las seis reglas

| `code` | Fuente | `period` | `priority` | `sourceShareBps` | `targetKind` | `driver` | Targets / filtro | `zeroBaseFallback` |
|---|---|---|---|---:|---|---|---|---|
| `AL-OPS-M` | `CC-OPS` (MC3) | MONTH | 10 | 10000 | `PROJECTS` | `DIRECT_COST_SHARE` | proyectos `ACTIVE` | **`YTD`** |
| `AL-DEV-Q` | `CC-DEV` (MC3) | QUARTER | 10 | 10000 | `BUSINESS_LINES` | `FIXED_PERCENT` | `BL-CONS` 6000 bps · `BL-DEV` 4000 bps | `SKIP_WARN` |
| `AL-MKT-Q` | `CC-MKT` (EBITDA) | QUARTER | 20 | 10000 | `PROJECTS` | `REVENUE_SHARE` | proyectos `ACTIVE`, `74x` excluido (R-A12) | `SKIP_WARN` |
| `AL-GA-OPS-Y` | `CC-GA` (EBITDA) | YEAR | 10 | **3000** | `COST_CENTERS` | `FIXED_PERCENT` | `CC-OPS` 10000 bps | `SKIP_WARN` |
| `AL-GA-PRY-Y` | `CC-GA` (EBITDA) | YEAR | 20 | **7000** | `PROJECTS` | `EQUAL` | proyectos `ACTIVE` | `SKIP_WARN` |
| `AL-OPS-Y` | `CC-OPS` | YEAR | 30 | 10000 | `PROJECTS` | `DIRECT_COST_SHARE` | proyectos `ACTIVE` | `SKIP_WARN` |

`AL-OPS-Y` es la regla que exige §2.2: CC-GA reparte **anualmente** a CC-OPS, luego CC-OPS necesita una regla anual con la que sacar lo recibido. Su base anual es `own(YEAR) − yaRepartido(mensual) + recibido = 91 890 − 91 890 + 189 954 = 189 954`, todo en nivel **EBITDA** (el nivel viaja con el dinero: es dinero de G&A). Prioridades `10 < 20 < 30` ⇒ orden topológico correcto (I-E5-8).

### 5.2 Runs con importe (3 de 17)

| Run | Periodo | Reglas | Líneas | Importe liquidado |
|---|---|---|---:|---:|
| `RUN-2026-11` | 2026-11-01 … 2026-11-30 | `AL-OPS-M` | 3 | 91 890 |
| `RUN-2026-Q2` | 2026-04-01 … 2026-06-30 | `AL-DEV-Q`, `AL-MKT-Q` | 4 | 160 500 |
| `RUN-2026` | 2026-01-01 … 2026-12-31 | `AL-GA-OPS-Y`, `AL-GA-PRY-Y`, `AL-OPS-Y` | 7 | 823 134 |

Los otros 14 runs (11 mensuales, 3 trimestrales) existen y quedan **vacíos**: sus CECOs fuente no tienen saldo en el periodo. Un run vacío se persiste igualmente (es la prueba de que el periodo se liquidó y de que no había nada que repartir), con `lineCount = 0`.

### 5.3 Los 14 `AllocationLine`

| Run | Regla | Fuente | → Destino | Nivel | Importe | Base driver | Cuota (bps) | Fallback |
|---|---|---|---|---|---:|---:|---:|---|
| `RUN-2026-11` | `AL-OPS-M` | CC-OPS | P-01 | **MC3** | 53 577 | 1 734 000 / 2 974 000 | 5 830 | `YTD` |
| `RUN-2026-11` | `AL-OPS-M` | CC-OPS | P-02 | MC3 | 30 589 | 990 000 / 2 974 000 | 3 328 | `YTD` |
| `RUN-2026-11` | `AL-OPS-M` | CC-OPS | P-03 | MC3 | 7 724 | 250 000 / 2 974 000 | 840 | `YTD` |
| `RUN-2026-Q2` | `AL-DEV-Q` | CC-DEV | **BL-CONS** | MC3 | 60 000 | 6 000 / 10 000 bps | 6 000 | — |
| `RUN-2026-Q2` | `AL-DEV-Q` | CC-DEV | **BL-DEV** | MC3 | 40 000 | 4 000 / 10 000 bps | 4 000 | — |
| `RUN-2026-Q2` | `AL-MKT-Q` | CC-MKT | P-01 | **EBITDA** | 34 571 | 600 000 / 1 050 000 | 5 714 | — |
| `RUN-2026-Q2` | `AL-MKT-Q` | CC-MKT | P-02 | EBITDA | **25 929** | 450 000 / 1 050 000 | 4 285 | — |
| `RUN-2026` | `AL-GA-OPS-Y` | CC-GA | **CC-OPS** | EBITDA | 189 954 | 10 000 / 10 000 bps | 10 000 | — |
| `RUN-2026` | `AL-GA-PRY-Y` | CC-GA | P-01 | EBITDA | 147 742 | 1 / 3 | 3 333 | — |
| `RUN-2026` | `AL-GA-PRY-Y` | CC-GA | P-02 | EBITDA | 147 742 | 1 / 3 | 3 333 | — |
| `RUN-2026` | `AL-GA-PRY-Y` | CC-GA | P-03 | EBITDA | 147 742 | 1 / 3 | 3 333 | — |
| `RUN-2026` | `AL-OPS-Y` | CC-OPS | P-01 | EBITDA | 110 753 | 1 734 000 / 2 974 000 | 5 830 | — |
| `RUN-2026` | `AL-OPS-Y` | CC-OPS | P-02 | EBITDA | **63 233** | 990 000 / 2 974 000 | 3 328 | — |
| `RUN-2026` | `AL-OPS-Y` | CC-OPS | P-03 | EBITDA | **15 968** | 250 000 / 2 974 000 | 840 | — |

Las tres cifras en negrita son las que llevan **+1 céntimo de remanente** de Hamilton. Comprobaciones al céntimo: `53 577 + 30 589 + 7 724 = 91 890` · `34 571 + 25 929 = 60 500` · `189 954 + 443 226 = 633 180` (3000/7000 bps) · `147 742 × 3 = 443 226` · `110 753 + 63 233 + 15 968 = 189 954`.

**Los dos casos límite que el fixture ejercita de verdad:**

| Caso | Dónde | Qué pasa |
|---|---|---|
| **Base cero** | `AL-OPS-M` en 2026-11: CC-OPS carga sus 91 890 c (`628`) en noviembre, y en noviembre **ningún proyecto tiene coste directo** (Σ base = 0) | Con el default `SKIP_WARN` el importe se quedaría sin repartir para siempre y la columna CC-OPS no llegaría a 0. La regla declara `zeroBaseFallback = YTD`, se emite `W-E5-ZERO-BASE`, la base se amplía al acumulado enero-noviembre (1 734 000 / 990 000 / 250 000) y el reparto se hace sobre él. **El fallback queda escrito en cada línea** |
| **Base negativa** | `AL-MKT-Q` en 2026-Q2: P-03 tiene ingresos netos **−90 000 c** en el trimestre (abono de junio) | P-03 recibe peso 0 y queda **excluido** del reparto (`W-E5-NEG-BASE`); los 60 500 c se reparten solo entre P-01 y P-02. Si P-03 hubiera entrado con peso negativo, habría **recibido un ingreso** de marketing |

### 5.4 Matriz analítica imputada 2026 (céntimos, cumulativa)

Columnas con importe. Las de CECO valen **0 en todos los niveles** (todos los imputables quedan liquidados); `CECO:FINANCIERO`, `CECO:EXTRAORDINARIO`, `CECO:OTROS` y `CECO:SIN_ASIGNAR` siguen a 0 y se omiten.

| Nivel | P-01 | P-02 | P-03 | BL-CONS *(imp.)* | BL-DEV *(imp.)* | CECOs | Amort./ deterioro | Financiero | No analítico | **TOTAL** | **= E4** |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:--:|
| **INGRESOS** | 2 050 000 | 2 550 000 | 1 650 000 | 0 | 0 | 0 | 0 | 0 | 0 | **6 250 000** | ✔ |
| **MC1** | 1 900 000 | 2 370 000 | 1 400 000 | 0 | 0 | 0 | 0 | 0 | 0 | **5 670 000** | ✔ |
| **MC2** | 316 000 | 1 560 000 | 1 400 000 | 0 | 0 | 0 | 0 | 0 | 0 | **3 276 000** | ✔ |
| **MC3** | **262 423** | **1 529 411** | **1 392 276** | **−60 000** | **−40 000** | **0** | 0 | 0 | 0 | **3 084 110** | ✔ |
| **EBITDA** | **−30 643** | **1 292 507** | **1 228 566** | −60 000 | −40 000 | **0** | 0 | 0 | 0 | **2 390 430** | ✔ |
| **EBIT** | −30 643 | 1 292 507 | 1 228 566 | −60 000 | −40 000 | 0 | −395 000 | 0 | 0 | **1 995 430** | ✔ |
| **BAI** | −30 643 | 1 292 507 | 1 228 566 | −60 000 | −40 000 | 0 | −395 000 | +1 000 | 0 | **1 996 430** | ✔ |
| **RESULTADO** | −30 643 | 1 292 507 | 1 228 566 | −60 000 | −40 000 | 0 | −395 000 | +1 000 | −499 108 | **1 497 322** | ✔ |

Las cuatro filas superiores son **idénticas** a las de E4: la liquidación no toca ingresos ni costes directos. De MC3 hacia abajo, todo el importe que en E4 estaba en las columnas de CECO se ha trasladado a proyectos y líneas de negocio **sin mover un céntimo de ningún total de fila**: eso es I4 después de imputar.

**Columnas de línea de negocio (presentación = Σ proyectos + columna `BL:` propia):**

| Nivel | `BL-CONS` (P-01 + P-02 + BL:BL-CONS) | `BL-DEV` (P-03 + BL:BL-DEV) |
|---|---:|---:|
| INGRESOS | 4 600 000 | 1 650 000 |
| MC1 | 4 270 000 | 1 400 000 |
| MC2 | 1 876 000 | 1 400 000 |
| MC3 | 1 731 834 | 1 352 276 |
| EBITDA → RESULTADO | 1 201 864 | 1 188 566 |

### 5.5 Lectura de gestión (lo que el CFO ve y E4 no dejaba ver)

| Proyecto | MC2 | MC3 | EBITDA | % s/ ingresos (EBITDA) | Diagnóstico |
|---|---:|---:|---:|---:|---|
| **P-01** | 316 000 | 262 423 | **−30 643** | **−1,5 %** | Parecía rentable (MC2 15,4 %) y **destruye valor** tras absorber estructura. Es el hallazgo del ejercicio: su coste directo (1 734 000 c, el 58 % del total) le hace absorber la mayor cuota de CC-OPS y de la G&A repartida a partes iguales |
| **P-02** | 1 560 000 | 1 529 411 | 1 292 507 | 50,7 % | Sano |
| **P-03** | 1 400 000 | 1 392 276 | 1 228 566 | 74,5 % | El más rentable; apenas consume estructura operativa |

Dos avisos de método que la UI debe llevar impresos: (a) el reparto **`EQUAL` de la G&A** cobra a P-03 los mismos 147 742 c que a P-01, teniendo P-03 un tercio del coste directo — es una elección de política, no un hecho, y es la principal palanca del resultado de P-01; (b) las filas `EBIT`, `BAI` y `RESULTADO` de las columnas de proyecto **no son márgenes de proyecto** (E4 §1.4): amortización, financiero e impuesto no se imputan y solo tienen lectura a nivel de compañía.

### 5.6 Anexo: driver `HOURS` sobre base sintética (E10)

`TimeEntry` no existe hasta E10, así que el fixture **no usa** `HOURS` en ninguna regla. Para que E10 tenga contra qué implementar, el JSON incluye una base sintética determinista —minutos/mes por proyecto: P-01 19 200, P-02 10 800, P-03 6 000 (320/180/100 h)— y el reparto anual **ilustrativo** de los 91 890 c de CC-OPS por ese driver: P-01 49 008 · P-02 27 567 · P-03 15 315 (Σ = 91 890). **No forma parte de la matriz comprobada** y está marcado como tal (`annexHoursIllustrative`).

### 5.7 Comprobaciones selladas en el JSON

| Check | Contenido | Estado |
|---|---|---|
| `I4.<nivel>` × 8 | Σ columnas del nivel tras imputar **=** `levelTotalsCents` de `pyg-analitica-esperada.json` | **PASS** (los 8, diff 0) |
| `I4.b` | Σ columnas `RESULTADO` = PyG contable I3 = 1 497 322 | **PASS** |
| `I5.a` | Σ `AllocationLine` por `(run, fuente, nivel)` = base liquidable. 5 combinaciones, todas con `diffCents = 0` | **PASS** |
| `I5.b` | Cierre anual: los 4 CECOs imputables con regla quedan a **0** en MC3 y EBITDA | **PASS** |
| `I-E5-1 … I-E5-9` | DAG, Σ % = 10000, Σ `sourceShareBps` = 10000, remanente acotado, no imputables fuera, suma cero por nivel, sin destinos cerrados, orden topológico, runs vigentes | **PASS** |

---

## 6. Veredicto sobre `docs/MODELO-DATOS.md` §`AllocationRule` / `AllocationRuleTarget` / `AllocationRun` / `AllocationLine`

### **CONFORME CON OBSERVACIONES** — la arquitectura es correcta y no hay nada que deshacer: la liquidación como capa paralela, versionada, inmutable, sustituible y reversible, con `ledgerHash`/`analyticsHash`/`rulesHash` y reparto por mayor resto, es exactamente lo que I4 e I5 necesitan. Faltan **4 campos**, **2 correcciones de definición** y **4 restricciones** para que E5 sea implementable tal y como está especificado aquí.

**Lo que está bien y no debe tocarse**

| Elemento | Valoración |
|---|---|
| Liquidación fuera del diario, `AllocationRun` inmutable con `supersededById` + `reversedAt` | Correcto (ADR-0004). Es lo que permite reconstruir cualquier informe histórico y lo que evita cuentas de reflejo del grupo 9 |
| `AllocationRun` con `ledgerHash` + `analyticsHash` + `rulesHash` + `gitSha` | Correcto y completo: los tres sellos cubren las tres formas en que un run puede quedar obsoleto |
| `AllocationRule` versionada con `validFrom`/`validTo` y `priority` | Correcto: sin versionado, editar una regla reescribiría en silencio liquidaciones ya emitidas |
| `AllocationLine` con `driverBase` y `sourceCostCenterId` denormalizado | Correcto: la celda es auditable sin recomputar el driver, que es lo que exige el drill-down |
| `TargetKind` y `Driver` como enums cerrados, con los 7 drivers de la skill | Correcto y suficiente |
| Los tres destinos mutuamente excluyentes en `AllocationLine` (`targetProjectId` / `targetBusinessLineId` / `targetCostCenterId`) | Correcto |

**Observaciones** (O-E5-1…O-E5-10). Nivel 2 las que tocan esquema del motor o invariantes ⇒ ADR + firma humana.

| # | Carencia | Propuesta | Nivel | Bloquea E5 |
|---|---|---|---|---|
| **O-E5-1** | **`AllocationLine` no tiene `marginLevel`.** Sin él, el nivel de absorción se deduce del `CostCenter.marginLevel` del **receptor** o del emisor inmediato, y una cascada entre niveles (`CC-GA` EBITDA → `CC-OPS` MC3) mueve importe de EBITDA a MC3: **I4.a falla en la fila MC3** | `AllocationLine.marginLevel MarginLevel @map("margin_level")` con `CHECK (margin_level IN ('MC3','EBITDA'))`, poblado con el nivel de origen del importe (E5-D1) | 2 | **Sí** |
| **O-E5-2** | **`AllocationRule` no dice qué fracción del saldo liquida.** Con dos reglas sobre el mismo CECO, el reparto del saldo entre ellas es indefinido | `AllocationRule.sourceShareBps Int @default(10000)` + `CHECK BETWEEN 0 AND 10000` + validación `Σ = 10000` por `(sourceCostCenterId, period)` vigente (E5-D2, I-E5-3) | 2 | **Sí** |
| **O-E5-3** | **`AllocationRuleTarget.percentPermille`**: el nombre dice **milésimas** (Σ = 1000) y el uso real —y el enunciado de la épica— es **puntos básicos** (Σ = 10000). Con milésimas, el mínimo representable es 0,1 %, insuficiente para un 60/40 con decimales o para un reparto entre 15 proyectos; y convive con `AllocationLine.driverSharePermille`, que sí es informativo | Renombrar a **`percentBps Int?`** (Σ = 10000, I-E5-2) y `AllocationLine.driverSharePermille` → **`driverShareBps Int`**. Hacerlo ahora: no hay datos | 2 | **Sí** |
| **O-E5-4** | **No hay campo de tratamiento de base cero**, así que el comportamiento quedaría en el código y sería invisible en la ficha de la regla | `AllocationRule.zeroBaseFallback ZeroBaseFallback @default(SKIP_WARN)` con enum `{SKIP_WARN, EQUAL, YTD, PRIOR_PERIOD}` + `AllocationLine.fallbackApplied String?` (§1.2) | 2 | **Sí** |
| **O-E5-5** | **`MANUAL` no tiene dónde poner los importes**: `AllocationRuleTarget` solo tiene `percentPermille` | `AllocationRuleTarget.amountCents Int?` + `CHECK` de exclusividad con `percentBps` según el `driver` de la regla, y I-E5-10 al lanzar el run | 2 | **Sí** (si se quiere `MANUAL` en E5) |
| **O-E5-6** | **`AllocationRun` no tiene ni `fiscalYearId` ni `periodKind` ni estado.** Sin `periodKind` no se puede saber si un run es mensual o anual sin inferirlo de las fechas; sin estado, `STALE` no es representable | `fiscalYearId`, `periodKind AllocPeriod`, `status AllocationRunStatus {ACTIVE, SUPERSEDED, REVERSED, STALE}`, `reversedById`, `reversalReason`, `lineCount`, `totalAllocatedCents`. `@@unique([organizationId, periodStart, periodEnd, status]) WHERE status = 'ACTIVE'` (índice parcial): **un solo run vigente por periodo** | 2 | **Sí** |
| **O-E5-7** | **`analyticsHash` se definió con `allocationRunId` en singular** (E4-D2). Un informe anual con reglas mensuales depende de 12 runs | Sustituir por `allocationRunSetHash` sobre el **conjunto ordenado** de runs vigentes contenidos en el periodo del informe (§3.3). Corrección en `MODELO-DATOS.md` §Analítica y en `lib/analytics/hash.ts` | 2 | **Sí** |
| **O-E5-8** | **Nada impide en BD que un `AllocationLine` tenga dos destinos, ni que la fuente o el destino sea un CECO `allocatable = false`, ni que fuente = destino** | Tres CHECK: exactamente un destino no nulo; `source ≠ targetCostCenterId`; y trigger que rechaza fuente o destino con `allocatable = false` o dimensión archivada (I-E5-5, I-E5-7). Más `allocation_runs`/`allocation_lines` en `TENANT_MODELS` con `app.enforce_tenant_rls` y **sin `GRANT DELETE`** (I-E5-11) | 2 | **Sí** |
| **O-E5-9** | **La matriz sellada de E4 no tiene columnas `BL:<código>`**, y la definición canónica de I4 sí las contempla («imputaciones a líneas de negocio sin proyecto») | Ampliar `ColumnKey` en `lib/analytics/types.ts` con `BL:${code}` y actualizar `buildAnalyticPnl` / `buildMatrixView` / `cellQuery`. El esquema sellado de E4 no se toca: E5 produce **su propio** fichero esperado (E5-D3) | 2 | **Sí** |
| **O-E5-10** | **`AllocationRule` no tiene `code` único ni `name` obligatorio** en el fragmento, pese a que `code` es el desempate del orden de ejecución (P7) y el identificador que el usuario ve | `@@unique([organizationId, code])`, `name` no nulo, y `@@index([organizationId, sourceCostCenterId, period, priority])` | 1 | No |

**Divergencias con otros documentos, que se corrigen ahí y no aquí**

| Documento | Divergencia | Corrección |
|---|---|---|
| `.claude/skills/fiabilidad`, **I5** | «remanente ≤ 1 céntimo asignado al mayor receptor · tolerancia **1 céntimo**» | Tolerancia **0** (el mayor resto es exacto); «≤ 1 céntimo» es **por receptor**; el desempate es por **menor código**, no por «mayor receptor», que no es determinista. Redacción propuesta en §1.4 |
| `.claude/skills/contabilidad-analitica`, §Liquidación, punto 5 | «Rerun del mismo periodo = nuevo `AllocationRun` que sustituye al anterior» — no dice qué pasa con los informes ya emitidos | Añadir: el run sustituido queda histórico y **caduca únicamente** los `ReportRun` analíticos (`PYG_ANALITICA`, `PRESUPUESTO_REAL`, `DASHBOARD`) vía `analyticsHash`; los financieros no se tocan (E4-D2) |
| `.claude/skills/contabilidad-analitica`, §`AllocationRule` | La tabla de campos no incluye `sourceShareBps` ni `zeroBaseFallback`, y `priority` se describe solo como «orden de reparto» | Incorporar ambos y precisar que `priority` debe ser **orden topológico** del grafo de cascada, no una preferencia (I-E5-8) |
| `docs/design/E4-analitica.md` §2.5 y `MODELO-DATOS.md` §Analítica | `analyticsHash` con «`allocationRunId` vigente» singular | `allocationRunSetHash` (O-E5-7) |
| `lib/analytics/margins.ts` | `buildAnalyticPnl` no acepta imputaciones (la firma de E4 ya reserva el parámetro `allocationRun`) | Aceptar `readonly AllocationLine[]` y aplicar el Δ de §4.2 **por nivel**, nunca por receptor |

**Nada de lo anterior invalida el modelo.** O-E5-1…O-E5-9 deben entrar en la migración de E5 (son baratos ahora, sin datos, y caros después); O-E5-10 es higiene. La deuda **O-A6** de E4 (uniques parciales de `Budget`) sigue abierta y le corresponde a E5/E7 según lo anotado en `MODELO-DATOS.md`.

---

## 7. Artefactos de esta épica

| Fichero | Qué es | Mutable |
|---|---|---|
| `docs/design/E5-validacion-liquidacion.md` | Este documento | Sí (se versiona con ADR si cambia una decisión) |
| `docs/design/fixtures/build_liquidacion_esperada.py` | Generador determinista de la liquidación esperada. Python puro, sin `lib/`, sin BD, sin float. Reutiliza `build_pyg_analitica_esperada.py` como fuente única de la resolución de cuentas | Sí |
| `docs/design/fixtures/liquidacion-esperada.json` | Liquidación esperada sellada: `rules`, `driverBases`, `runs`, `allocationLines`, `warnings`, `allocationDeltaCents`, `matrixCents`, `businessLineMatrixCents`, `levelTotalsCents`, `levelTotalsE4Cents`, `annexHoursIllustrative`, `checks` | **No** — se regenera, no se edita; CI ejecuta `--check` |
| `docs/design/fixtures/pyg-analitica-esperada.json` | Matriz de E4 **sin** imputaciones. **Entrada de solo lectura**: es el patrón contra el que se verifica I4 | **No** |
| `tests/fixtures/ejercicio-completo.json` | Fixture de E3. **Entrada de solo lectura** | **No** |

**Comando de CI:**

```
python3 docs/design/fixtures/build_pyg_analitica_esperada.py --check
python3 docs/design/fixtures/build_liquidacion_esperada.py  --check
```

---

## 8. Dudas abiertas para el arquitecto / el coordinador

| # | Duda | Recomendación |
|---|---|---|
| **1** | **`sourceShareBps` (O-E5-2) es un campo nuevo en una tabla de ADR-0004 aprobado.** ¿Se tramita como enmienda a ADR-0004 o como ADR-0013 propio de E5? | ADR nuevo. ADR-0004 fijó la arquitectura; E5 añade campos y **una decisión de fondo nueva** (E5-D1, el nivel viaja con el importe), que merece firma propia |
| **2** | **¿Se admite `MANUAL` en E5 o se difiere?** Requiere `amountCents` en los targets (O-E5-5), rol `ADMIN`, motivo y el estado `STALE` cuando el saldo cambia | Definirlo ahora en el modelo, implementarlo en E7 con la pantalla. El fixture no lo usa |
| **3** | **`HOURS` y `HEADCOUNT` dependen de E10.** ¿Se rechaza la regla al guardarla o se acepta inerte? | **Rechazar** (`DRIVER_UNAVAILABLE`). Una regla que no reparte y no avisa es la peor opción; una inerte con WARN se olvida |
| **4** | **`zeroBaseFallback = YTD` en `AL-OPS-M`** salva el fixture, pero el caso real (un CECO que carga todo su coste en un mes sin actividad) sugiere que la periodicidad elegida es errónea | Que la Auditoría emita **Info** cuando una regla aplique fallback en ≥ 2 periodos del ejercicio: es la señal de que la regla debería ser trimestral o anual |
| **5** | **Reparto `EQUAL` de la G&A**: es el que convierte P-01 en pérdida (§5.5). ¿Debe la UI ofrecer simulación comparando drivers antes de sellar el run? | Sí, y es barato: el motor es una función pura; una previsualización con 2-3 drivers alternativos sobre la misma base, **sin persistir run**, evita discusiones de comité sobre una cifra ya publicada |
