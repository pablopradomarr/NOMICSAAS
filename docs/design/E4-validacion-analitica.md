# E4 — Validación contable de la analítica base: destino analítico, PyG analítica esperada e invariante I4

> Rol: `experto-contable`. Fuentes: `.claude/skills/contabilidad-analitica`, `.claude/skills/fiabilidad` (I4), `.claude/skills/pgc-npgc`, `docs/MODELO-DATOS.md` §Analítica, `docs/design/E3-asientos-tipo.md` (28 plantillas y su destino analítico), `seeds/npgc.csv` (columna `tipo_analitico`), `tests/fixtures/ejercicio-completo.json`, `docs/design/fixtures/build_ejercicio_completo.py`, ADR-0004.
> Norma: **RD 1514/2007** (PGC 2007, NRV 2ª, 10ª, 14ª, 22ª) · **Código de Comercio arts. 25–33** (libros obligatorios) · **RD 1159/2010**, **RD 602/2016**, **RD 1/2021**.
> **Todas las cifras proceden del fixture inmutable `tests/fixtures/ejercicio-completo.json`, que es ilustrativo.** Ningún importe procede de datos reales. Céntimos enteros en todo el documento.
> Entregables de esta épica: este documento · `docs/design/fixtures/build_pyg_analitica_esperada.py` · `docs/design/fixtures/pyg-analitica-esperada.json`. **`tests/fixtures/*` no se toca**: es entrada, es inmutable y está sellado por E3.

---

## 0. Convenciones de la matriz

| Concepto | Definición |
|---|---|
| **Aporte de una línea** | `aporte = creditCents − debitCents`. Un ingreso en el haber aporta **+**; un gasto en el debe aporta **−**; `708`/`709`/`706` (contra-cuentas de ingreso) aportan **−**; `606`/`608`/`609` (contra-cuentas de gasto) aportan **+**. No hay importes negativos en el diario (C-2 de E3): el signo lo pone la columna, no el importe |
| **Periodo** | Líneas de grupo 6/7 con `fiscalYearCode = 2026` y `kind ∉ {REGULARIZATION, CLOSING, OPENING}` — exactamente el conjunto de I3 |
| **Contra-asientos** | El `REVERSAL` **no recibe tratamiento especial**: sus líneas llevan el mismo destino analítico que el original con las columnas invertidas, y por tanto se compensan solas (I-E3-1). No existe flag de exclusión |
| **Matriz cumulativa** | `matriz[nivel][col] = Σ aportes de todos los niveles ≤ nivel`. La fila `INGRESOS` es el margen bruto de ingresos, la fila `RESULTADO` es el resultado del ejercicio |
| **Columnas de línea de negocio** | Son **agregados de las columnas de proyecto**, para presentación. **No entran en el total**: sumarlas duplicaría los proyectos |
| **Resolución de cuenta** | `accountKey → ACCOUNT_KEY_DEFAULT_CODE → resolvePostable()` (misma regla que `lib/accounts/map.ts`): el fixture postea en `4300`, `6080`, `7080`, `6300`… no en los padres |
| **Herencia del `tipo_analitico`** | Si la hoja postable no trae `tipo_analitico` en el seed, hereda del ancestro más cercano que sí lo traiga (`6080 → 608 → COSTE_DIRECTO_MC1`; `6300 → 630 → NO_ANALITICO`) |

---

## 1. PyG analítica esperada del fixture `ejercicio-completo.json`

Calculada por **`docs/design/fixtures/build_pyg_analitica_esperada.py`** (Python puro, sin `lib/`, sin BD, sin float) y sellada en **`docs/design/fixtures/pyg-analitica-esperada.json`**. El motor de E4 debe reproducirla **byte a byte**; `--check` reconstruye y falla si difiere en un céntimo.

### 1.1 Matriz nivel × columna (céntimos, matriz cumulativa)

Columnas con importe. Las 4 columnas vacías del esquema (`CECO:FINANCIERO`, `CECO:EXTRAORDINARIO`, `CECO:OTROS`, `CECO:SIN_ASIGNAR`) existen en el JSON con valor 0 en todos los niveles y se omiten aquí.

| Nivel | P-01 | P-02 | P-03 | CECO OPS | CECO DEV | CECO MKT | CECO G&A | Amort./ deterioro | Financiero | No analítico | **TOTAL** |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **INGRESOS** | 2 050 000 | 2 550 000 | 1 650 000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **6 250 000** |
| **MC1** | 1 900 000 | 2 370 000 | 1 400 000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **5 670 000** |
| **MC2** | 316 000 | 1 560 000 | 1 400 000 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **3 276 000** |
| **MC3** | 316 000 | 1 560 000 | 1 400 000 | −91 890 | −100 000 | 0 | 0 | 0 | 0 | 0 | **3 084 110** |
| **EBITDA** | 316 000 | 1 560 000 | 1 400 000 | −91 890 | −100 000 | −60 500 | −633 180 | 0 | 0 | 0 | **2 390 430** |
| **EBIT** | 316 000 | 1 560 000 | 1 400 000 | −91 890 | −100 000 | −60 500 | −633 180 | −395 000 | 0 | 0 | **1 995 430** |
| **BAI** | 316 000 | 1 560 000 | 1 400 000 | −91 890 | −100 000 | −60 500 | −633 180 | −395 000 | **+1 000** | 0 | **1 996 430** |
| **RESULTADO** | 316 000 | 1 560 000 | 1 400 000 | −91 890 | −100 000 | −60 500 | −633 180 | −395 000 | +1 000 | **−499 108** | **1 497 322** |

### 1.2 Aporte por nivel (no cumulativo) — lo que entra en cada escalón

| Nivel | Columna | Aporte | Origen (cuenta hoja · destino) |
|---|---|---:|---|
| INGRESOS | P-01 | 2 050 000 | `705` +2 150 000 (P-01) · `7080` −100 000 (P-01, devolución de venta) |
| INGRESOS | P-02 | 2 550 000 | `705` (P-02) |
| INGRESOS | P-03 | 1 650 000 | `705` (P-03) |
| MC1 | P-01 | −150 000 | `607` −300 000 · `607` +100 000 (contra-asiento `REV-R-ERR`) · `6080` +50 000 (devolución de compra) |
| MC1 | P-02 | −180 000 | `607` (P-02) |
| MC1 | P-03 | −250 000 | `607` (P-03) |
| MC2 | P-01 | −1 584 000 | `640` −1 200 000 · `642` −384 000 |
| MC2 | P-02 | −810 000 | `640` −500 000 · `642` −160 000 · **`623` −150 000** (override implícito R-A3) |
| MC3 | CECO OPS | −91 890 | `628` (CC-OPS, `marginLevel = MC3`) |
| MC3 | CECO DEV | −100 000 | `623` (CC-DEV, `marginLevel = MC3`) |
| EBITDA | CECO MKT | −60 500 | `629` (CC-MKT) |
| EBITDA | CECO G&A | −633 180 | `621` −120 000 · `626` −500 · `628` −81 680 · `640` −300 000 · `642` −96 000 · `678` −35 000 (CC-GA) |
| EBIT | Amort./deterioro | −395 000 | `681` −120 000 (CC-GA) · `681` −275 000 (CC-OPS). **No pasa por el CECO**: `AMORTIZACION_DETERIORO` nunca entra en MC3/EBITDA |
| BAI | Financiero | +1 000 | `668` −5 000 · `768` +6 000 · `669` −1 · `769` +1 (todas en CC-FIN) |
| RESULTADO | No analítico | −499 108 | `6300` Impuesto corriente |

### 1.3 Columnas agregadas por línea de negocio (presentación)

| Nivel | `BL-CONS` (P-01 + P-02) | `BL-DEV` (P-03) |
|---|---:|---:|
| INGRESOS | 4 600 000 | 1 650 000 |
| MC1 | 4 270 000 | 1 400 000 |
| MC2 → RESULTADO | 1 876 000 | 1 400 000 |

Por debajo de MC2 los proyectos no reciben nada más en este fixture (no hay `AllocationRun`: E4 es **PyG analítica sin imputaciones**, ADR-0004). Con E5, el reparto de CECOs moverá importe de las columnas CECO a las columnas de proyecto **sin alterar ningún total de fila**: ése es precisamente el sentido de I4 y la razón de que la liquidación no toque el diario.

### 1.4 Verificación de I4 y nivel exacto del Impuesto sobre Sociedades

| Comprobación | Valor | Estado |
|---|---:|---|
| Σ columnas nivel `RESULTADO` | 1 497 322 | — |
| PyG contable I3 = Σ(haber − debe) de líneas 6/7 con `kind ∉ {REGULARIZATION, CLOSING, OPENING}` | 1 497 322 | **PASS (diff 0)** |
| `expected.resultadoAntesRegularizacionCents` del fixture E3 | 1 497 322 | coincide |
| `expected.saldo129Cents` tras T-26 | −1 497 322 (acreedor) | coincide (I3, segunda mitad) |
| Σ columnas nivel `BAI` | 1 996 430 | = `expected.resultadoAntesImpuestoCents` |
| Líneas 6/7 del periodo cubiertas por la matriz | 85 / 85 | **PASS** |

> **Corrección al enunciado del encargo.** El encargo pide verificar que la matriz cuadra con «1 497 322 **antes de IS**». Es al revés: en el fixture, `T-25 IMPUESTO_BENEFICIOS` tiene `kind = NORMAL`, luego su línea de `6300` (−499 108) **entra** en I3. Por tanto **1 996 430 es el resultado antes de impuesto (BAI) y 1 497 322 es el resultado después de impuesto**, que es el que I3 define y el que queda en `129`. La matriz cuadra con I3 en el nivel `RESULTADO`, no en `BAI`.

**Nivel del IS — decisión.** `630` (y sus hojas `6300` impuesto corriente / `6301` impuesto diferido) tiene `tipo_analitico = NO_ANALITICO` en el seed y entra **exclusivamente en el nivel `RESULTADO`, en la columna `NO_ANALITICO`**. Razones:

| Motivo | Detalle |
|---|---|
| Norma | El IS es un gasto del ejercicio (NRV 13ª) que se determina sobre la **base imponible del sujeto pasivo**, no sobre el resultado de ningún proyecto: no es divisible por dimensión analítica sin inventar un criterio de reparto |
| Definición de márgenes | La tabla canónica de la skill fija `RESULTADO = BAI − impuesto (630, NO_ANALITICO)`. `BAI` es, por construcción, el último nivel con contenido analítico |
| Consistencia | Si el IS bajara a la columna de un proyecto, el margen del proyecto dependería de ajustes extracontables y de bases imponibles negativas de ejercicios anteriores, que no tienen dimensión |
| Prohibición explícita | `630` **nunca** admite `projectId` ni `costCenterId` (I-E4-4). T-25 ya lo marca "No (`NO_ANALITICO`)" |

**Corolario de presentación:** el margen % por proyecto se calcula hasta `MC3` (o `EBITDA` si la organización imputa CECOs de estructura); `EBIT`, `BAI` y `RESULTADO` solo tienen lectura **a nivel de compañía**, y la UI debe presentar las tres últimas filas de las columnas de proyecto en gris o con una nota, no como "margen del proyecto".

---

## 2. Reglas de destino analítico por cuenta y por plantilla

### 2.1 Reglas generales (`lib/ledger/validateAnalytics()` + `lib/analytics/route()`)

| Id | Regla | Efecto |
|---|---|---|
| **R-A1** | Solo las líneas de **grupo 6 y 7** tienen destino analítico. Grupos 1–5 **nunca** llevan `projectId`/`costCenterId`/`businessLineId`/`analyticType`: son balance, no PyG | bloquea si se informan |
| **R-A2** | El `analyticType` **efectivo** de una línea es, por precedencia: (1) `JournalLine.analyticType` si el usuario/plantilla lo informa; (2) override implícito por dimensión (R-A3/R-A4); (3) `LedgerAccount.analyticType` de la organización, cuyo default viene de `seeds/npgc.csv` | — |
| **R-A3** | Cuenta con default `INDIRECTO_CECO` posteada con `projectId` ⇒ tipo efectivo **`COSTE_DIRECTO_MC2`**. Un servicio exterior (62x), un tributo local (63x) o una pérdida de gestión (65x) atribuible a un proyecto concreto es coste directo de ese proyecto y se descuenta en MC2, no vía CECO | automático, sin WARN |
| **R-A4** | Cuenta con default directo (`INGRESO_DIRECTO`, `COSTE_DIRECTO_MC1`, `COSTE_DIRECTO_MC2`) posteada con `costCenterId` ⇒ tipo efectivo **`INDIRECTO_CECO`**. Ejemplo real del fixture: `640`/`642` de administración con `costCenterCode = CC-GA` | automático, sin WARN |
| **R-A5** | **La columna la fija el tipo efectivo, no la dimensión.** `AMORTIZACION_DETERIORO`, `FINANCIERO`, `EXTRAORDINARIO` y `NO_ANALITICO` tienen columna propia aunque la línea lleve un CECO. Excepción única: `AMORTIZACION_DETERIORO` **con `projectId`** (activo afecto) va a la columna del proyecto | — |
| **R-A6** | **El `CostCenter.marginLevel` solo aplica a líneas con tipo efectivo `INDIRECTO_CECO`.** Un `668` en `CC-FIN` (cuyo `marginLevel` es `EBITDA`) entra en `BAI`, no en `EBITDA`: manda el `AnalyticType` | — |
| **R-A7** | `MarginLevelConfig` fija nivel ⇐ `AnalyticType`. `MC3` y `EBITDA` **no listan tipos**: reciben `INDIRECTO_CECO` según el `marginLevel` del CECO. Es la única fuente de dinamismo por organización | — |
| **R-A8** | Con `Organization.analyticsRequired = true`, una línea 6/7 sin destino y sin `NO_ANALITICO` **bloquea el asiento** (C-9). Con `false`, se rutea al CECO de sistema `SIN_ASIGNAR` (`kind = SIN_ASIGNAR`, `marginLevel = EBITDA`, `allocatable = false`) y la pestaña Auditoría lo lista como WARN con importe y nº de líneas | bloquea / WARN |
| **R-A9** | `businessLineId` de la línea **se copia del proyecto en el alta** y no se recalcula nunca (E3 §I10, caso límite): si el proyecto cambia de línea de negocio, los informes de periodos cerrados no cambian. Línea con `costCenterId` ⇒ `businessLineId = NULL` | trigger + test |
| **R-A11** | **`NO_ANALITICO` no es homogéneo** (§8, respuesta 1). Cuentas `630`/`633`/`638` (impuesto sobre beneficios) ⇒ nivel **`RESULTADO`**, no configurable. El resto de `NO_ANALITICO` (`73x`, `74x`, `75x`: resultado de explotación sin dimensión) ⇒ nivel **`MarginLevelConfig.nonAnalyticLevel`**, default **`EBITDA`**. En ambos casos la **columna** es `NO_ANALITICO` | — |
| **R-A12** | **`74x` con override a `INGRESO_DIRECTO` se excluye del driver `REVENUE_SHARE`** de E5 (decisión del coordinador). Una subvención finalista no es capacidad de absorción de estructura: incluirla haría que el proyecto subvencionado cargase con más G&A por el mero hecho de estar subvencionado | regla de E5 |
| **R-A10** | El `AnalyticType` **`EXTRAORDINARIO` no se usa en el seed**: el PGC 2007 suprimió el resultado extraordinario y `678`/`778` (epígrafe 13 "Otros resultados") están dentro del resultado de explotación, con default `INDIRECTO_CECO`. La columna existe, siempre vale 0 con el seed de fábrica, y solo se activa si una organización reclasifica cuentas a mano | — |

### 2.2 Qué exige cada familia de cuentas

| Cuentas | `tipo_analitico` seed | Dimensión obligatoria | Nivel | Notas |
|---|---|---|---|---|
| `700`–`705` ventas y prestaciones de servicios | `INGRESO_DIRECTO` | **`projectId`** | INGRESOS | Es el ingreso que define la columna del proyecto |
| `706` dto. pronto pago · `708` devoluciones · `709` rappels sobre ventas | `INGRESO_DIRECTO` (`isContra`) | **`projectId`**, el **mismo** que la línea de ingreso rectificada | INGRESOS | **Los descuentos y rappels siguen al ingreso**: nunca a un CECO comercial. Un rappel sin proyecto rompería el margen del proyecto que lo generó. T-02 lo impone (`reason ∈ {DEVOLUCION, DESCUENTO_POSTERIOR, RAPPEL}` ⇒ misma dimensión que la línea rectificada, C-12) |
| `600`–`602`, `607` compras y subcontratación | `COSTE_DIRECTO_MC1` | **`projectId`** | MC1 | `607` es la subcontratación de proyecto: el coste directo más típico de una empresa de servicios |
| `606`/`608`/`609` dto., devoluciones y rappels sobre compras | `COSTE_DIRECTO_MC1` (`isContra`) | **`projectId`** de la compra rectificada | MC1 | Simétrico al anterior. **Siguen al gasto** |
| `61x`/`71x` variación de existencias | `COSTE_DIRECTO_MC1` | **`projectId`** si hay obra/proyecto en curso; **`costCenterId` `OPERACIONES_INDIRECTAS`** si el almacén es común | MC1 | **Decisión razonada §2.3** |
| `620`–`629` servicios exteriores | `INDIRECTO_CECO` | `costCenterId`, **o `projectId`** con R-A3 | MC2 (con proyecto) / MC3-EBITDA (con CECO) | Decisión **por línea**, no por cuenta. `626` comisiones bancarias: default CECO `G_A` (T-08/T-09) |
| `630`, `633`, `638` impuesto sobre beneficios | `NO_ANALITICO` | **Ninguna** (prohibida) | RESULTADO (fijo, no configurable) | §1.4, R-A11 |
| `631`, `634`, `636`, `639` otros tributos y ajustes de IVA | `INDIRECTO_CECO` | `costCenterId` (`G_A`), o `projectId` si el tributo es del proyecto (ICIO, tasas de obra) | MC2 / EBITDA | |
| `640`–`649` gastos de personal | `COSTE_DIRECTO_MC2` | `projectId` **o** `costCenterId` — **la decisión es por línea** | MC2 / MC3 / EBITDA | T-10 obliga a **una línea por destino**: una persona en 3 proyectos y G&A son 4 líneas de `640` en el mismo asiento |
| `650`, `651`, `659` otras pérdidas de gestión | `INDIRECTO_CECO` | `costCenterId`, o `projectId` con R-A3 | MC2 / EBITDA | **Decisión razonada §2.3** |
| `66x`/`76x`, `673`, `675`, `696`–`699`, `773`, `775`, `796`–`799` financieros | `FINANCIERO` | `costCenterId` del CECO `FINANCIERO` (convención; la columna es propia igualmente) | BAI | R-A5: la columna es "Financiero" aunque el CECO sea otro |
| `67x`/`77x` excepcionales por enajenación y deterioro de inmovilizado | `AMORTIZACION_DETERIORO` | `costCenterId`, o `projectId` si el activo estaba afecto | EBIT | |
| `678`/`778` gastos e ingresos excepcionales | `INDIRECTO_CECO` | `costCenterId` (default `G_A`) | EBITDA | Epígrafe 13, **dentro** del resultado de explotación (E3 §1 T-22). No son "extraordinario" |
| `68x` amortizaciones · `69x`/`79x` deterioros y reversiones | `AMORTIZACION_DETERIORO` | `costCenterId`, o `projectId` si el activo está afecto a un proyecto | **EBIT siempre** | **Nunca** se imputa vía `AllocationRun`, ni entra en MC1/MC2/MC3 (decisión aprobada en E3) |
| `73x` trabajos realizados para la empresa | `NO_ANALITICO` | **Ninguna** por defecto | **EBITDA** (R-A11) | **Decisión razonada §2.3** |
| `74x` subvenciones a la explotación | `NO_ANALITICO` | **Ninguna** por defecto; `projectId` admitido con override explícito | **EBITDA** (R-A11) / INGRESOS con override | **Decisión razonada §2.3** · excluida de `REVENUE_SHARE` (R-A12) |
| `75x` otros ingresos de gestión | `NO_ANALITICO` | **Ninguna** por defecto; override por organización | **EBITDA** (R-A11) | **Decisión razonada §2.3** |
| **`129`** resultado del ejercicio | — (grupo 1) | **Prohibida** | — | Patrimonio neto. T-26 lo mueve y su asiento es `REGULARIZATION`, excluido de I3/I4 por `kind` |
| **`4xx`** (`400`, `410`, `430`, `436`, `438`, `407`, `46x`, `47x`) | — | **Prohibida** | — | Créditos, deudas, IVA, IRPF, SS. Ver §2.4 |
| **`5xx`** (`570`, `572`, `55x`) | — | **Prohibida** | — | Tesorería. El cashflow tiene su propia dimensión (`cashflowCategory`), que no es la analítica |

### 2.3 Decisiones razonadas sobre las familias dudosas

| Familia | Decisión | Razón |
|---|---|---|
| **`61x`/`71x` variación de existencias** | **Se mantiene `COSTE_DIRECTO_MC1`, con dimensión obligatoria.** Regla operativa: `71x` (productos en curso/terminados) exige **`projectId`** — es la obra en curso del proyecto; `61x` (mercaderías, materias primas) exige `projectId` **si el consumo es identificable** y `costCenterId = OPERACIONES_INDIRECTAS` si el almacén es común y el consumo se reparte después por driver `DIRECT_COST_SHARE` (E5) | La variación de existencias es el **ajuste de periodificación del consumo**: `600 − 610` es el consumo real del periodo. Si la compra va al proyecto (MC1) y la variación va a un CECO (MC3/EBITDA), el MC1 del proyecto queda **sobrevalorado o infravalorado por el importe del stock**, que es el error clásico. Mantener ambos en MC1 y en la misma dimensión es la única forma de que `MC1 = Ingresos − consumo real`. Empresas de servicios puras no las usan: la regla es inocua ahí |
| **`65x` otras pérdidas de gestión corriente** | **`INDIRECTO_CECO` por defecto (CECO `G_A`), con override a proyecto por R-A3.** Caso particular: **`650` pérdidas de créditos comerciales incobrables → siempre `G_A`, nunca proyecto**, salvo override explícito con motivo | El fallido es un riesgo de crédito del **cliente**, no un coste de ejecución del proyecto: cargarlo al proyecto destruiría la comparabilidad del margen entre proyectos idénticos ejecutados para clientes de distinta solvencia. `651` (operaciones en común) y `659` sí admiten proyecto cuando el contrato lo identifica |
| **`73x` trabajos realizados para la empresa** | **`NO_ANALITICO` por defecto; override recomendado a `INGRESO_DIRECTO` con `projectId` si la organización gestiona su I+D o su desarrollo interno como proyecto** | Contablemente `73x` es un **ingreso de activación** que compensa gastos ya registrados en 6xx, no una venta. Si se dejara como `INGRESO_DIRECTO` de fábrica, el proyecto interno mostraría "ingresos" que nunca se facturan y el margen sería ficticio. Con override explícito y `projectId` del proyecto interno, el efecto es el correcto: el proyecto de desarrollo capitalizado sale a margen ≈ 0, que es la lectura de gestión útil. **Se registra como parámetro de organización, no se cambia el seed** |
| **`74x` subvenciones a la explotación** | **`NO_ANALITICO` por defecto; override a `INGRESO_DIRECTO` con `projectId` cuando la subvención es finalista de un proyecto identificado** | Una subvención genérica de explotación no es ingreso de ningún proyecto y llevarla a uno inflaría su margen. Una subvención finalista (CDTI, Kit Digital, fondos de un proyecto concreto) **sí** es ingreso de ese proyecto y omitirla lo dejaría en pérdidas artificiales. Por eso: default seguro (`NO_ANALITICO`), override deliberado y trazado |
| **`75x` otros ingresos de gestión** | **`NO_ANALITICO` por defecto.** Excepciones recomendadas por organización: `752` arrendamientos → `INGRESO_DIRECTO` con proyecto solo si se explota un inmueble como proyecto; `754` comisiones y `759` servicios diversos → `INGRESO_DIRECTO` con proyecto si son facturación accesoria del proyecto | Son ingresos de explotación heterogéneos (epígrafe 5 de la PyG) que en la mayoría de las PYMEs de servicios son residuales. Un default `INGRESO_DIRECTO` obligaría a inventar un proyecto para cada ingreso menor y dispararía el uso de `SIN_ASIGNAR`. Nótese la asimetría con la skill (`INGRESOS` = 70x, «75x configurable por org; default `NO_ANALITICO`»): el seed y esta decisión **coinciden** con la skill |

### 2.4 Líneas de IVA, IRPF, SS y tesorería — sin dimensión, nunca

| Familia | Cuentas | Regla | Por qué |
|---|---|---|---|
| IVA | `472`, `477`, `4700`, `4750`, `4720`/`4770` (ISP) | `projectId = costCenterId = businessLineId = analyticType = NULL`. Bloqueante | El IVA no es gasto ni ingreso: es un crédito/deuda con la Hacienda Pública (grupo 4). **Excepción documentada:** el IVA **no deducible** por prorrata o por exclusión **no va a 472**, engorda la línea de gasto (art. 103 LIVA, NRV 2ª y 10ª) y por tanto **hereda automáticamente el destino analítico de esa línea de gasto**. En el fixture: `628` en CC-GA por 81 680 = 80 000 de base + 1 680 de IVA no deducible; y `629` en CC-MKT por 60 500 con IVA íntegramente no deducible |
| IRPF | `473`, `4751`/`47510`/`47511`/`47512` | Sin dimensión. Bloqueante | Retención practicada o soportada: es un crédito/deuda tributaria, no coste. **El coste ya está** en la línea de `623`/`621`/`640`, que sí lleva destino |
| Seguridad Social | `476` (acreedora), `471` (deudora) | Sin dimensión. Bloqueante | La deuda con la TGSS es una sola. El coste analítico está en `642` (cuota patronal), que sí lleva destino, línea a línea con el mismo reparto que el bruto (T-10) |
| Personal, pasivos | `465`, `460` | Sin dimensión | Neto a pagar y anticipos: balance |
| Anticipos comerciales | `407`, `438` | Sin dimensión. Bloqueante | T-06/T-07 lo dicen explícitamente: el anticipo **no toca la PyG** y la imputación analítica llega con la factura |
| Tesorería | `570`, `572`, `55x` | Sin dimensión | El cashflow usa `LedgerAccount.cashflowCategory`, que es **otra** dimensión y otro informe (I6) |
| Patrimonio | `100`, `113`, `120`, `121`, `129` | Sin dimensión. Bloqueante | T-22 ya lo impone: «el ajuste a 113 no puede tener destino analítico (rompería I4: es patrimonio, no PyG)» |
| Inmovilizado | `2xx`, `28x`, `29x` | Sin dimensión | El consumo del activo llega a la analítica por `68x` (nivel EBIT), no por el activo |

### 2.5 Destino analítico por plantilla (recorrido de las 28 de E3)

| Plantillas | Líneas con destino obligatorio | Líneas sin dimensión |
|---|---|---|
| T-01 `FACTURA_EMITIDA_SERVICIOS` | `705`/`revenueAccountCode`: `projectId` | `430`, `473`, `438`, `477` |
| T-02 `ABONO_EMITIDO` | `706`/`708`/`709`/`705`: **misma** dimensión que la línea rectificada (C-12) | `477`, `473`, `430` |
| T-03 `FACTURA_RECIBIDA` | línea de gasto (base + IVA no deducible): `projectId` **o** `costCenterId` | `472`, `407`, `400`/`410`, `4751` |
| T-04 `FACTURA_RECIBIDA_ISP` | línea de gasto/inmovilizado (si es gasto) | `472`, `477` (ambas), `400`/`410` |
| T-05 `ABONO_RECIBIDO` | `606`/`608`/`609`/cuenta de gasto: misma dimensión que la rectificada | `400`/`410`, `4751`, `472` |
| T-06 / T-07 anticipos | **ninguna** | todas (`438`, `407`, `477`, `472`, `57x`) |
| T-08 / T-09 cobro y pago | `626` comisión (CECO `G_A`), `668`/`768` (CECO `FINANCIERO`), `669`/`769` (CECO `FINANCIERO`) | `57x`, `430`, `436`, `400`/`410` |
| T-10 `NOMINA` | `640` y `642`: **una línea por destino** | `465`, `460`, `476`, `4751` |
| T-11…T-13, T-24 pagos | **ninguna**; recargos/intereses en línea propia `631`/`669` **sí** llevan destino | `465`, `476`, `475x`, `57x` |
| T-14 `AMORTIZACION_MENSUAL` | `68x`: CECO, o proyecto si el activo está afecto → **nivel EBIT en ambos casos** | `28x` |
| T-15…T-18 periodificaciones | línea de 6xx/7xx: **misma dimensión que el gasto/ingreso original** | `480`, `485` |
| T-19 `TRASPASO_TESORERIA` | `626` si hay comisión | ambas cuentas 57x |
| T-20 `ASIENTO_MANUAL` | toda línea 6/7, sin excepciones (C-9 completo) | resto |
| T-21 `CONTRA_ASIENTO` | **copia literal** de la dimensión de la línea original; nunca se reasigna | idem |
| T-22 `AJUSTE_EJERCICIO_CERRADO` | `678`/`778`: CECO (`G_A` default). `113`/`121`: **prohibido** | contrapartida real |
| T-23 `REGULARIZACION_IVA` | **ninguna** | `477`, `472`, `4700`, `4750` |
| T-25 `IMPUESTO_BENEFICIOS` | **ninguna** — `630` es `NO_ANALITICO` (§1.4) | `4752`, `4709` |
| T-26 `REGULARIZACION_RESULTADO` | **ninguna**: sus líneas 6/7 **no llevan dimensión** y I4 las excluye por `kind = REGULARIZATION`, igual que I3 | todas |
| T-27 / T-28 cierre y apertura | **ninguna**: solo cuentas de balance, y `kind` excluido | todas |

---

## 3. Reclasificación analítica de líneas ya posteadas

### 3.1 La pregunta

¿Es admisible cambiar `projectId`/`costCenterId`/`analyticType` de una `JournalLine` **ya posteada**, sin generar ningún asiento en el libro diario?

### 3.2 Argumentación

| Eje | Análisis |
|---|---|
| **Norma mercantil** | Los libros obligatorios son el **libro de inventarios y cuentas anuales** y el **libro diario** (art. 25.1 CdC). La contabilidad analítica (o de costes) **no es libro obligatorio**: no se legaliza (art. 27 CdC), no se deposita, y ningún precepto exige su inalterabilidad. El art. 29.1 CdC prohíbe «espacios en blanco, interpolaciones, tachaduras ni raspaduras» **en los libros de contabilidad**, y su objeto es el registro del hecho económico: importe, cuenta, fecha, contrapartida |
| **Qué NO cambia** | Una reclasificación analítica **no altera** `accountCode`, `debitCents`, `creditCents`, `entryDate`, `entryNumber`, `taxRateId` ni `entryHash` de la parte financiera. El hecho económico registrado es idéntico: cambia únicamente **a qué unidad de gestión interna se atribuye** |
| **Qué SÍ cambia** | Todo informe analítico posterior: PyG analítica, márgenes por proyecto, presupuesto vs real, y —vía `AllocationRun`— los drivers `REVENUE_SHARE` y `DIRECT_COST_SHARE` de E5, que se calculan **desde el diario** |
| **Riesgo real** | Un informe ya emitido y firmado (`ReportRun` con `Seal = VALIDADO_AUTOMATICAMENTE`) deja de ser reproducible si el `ledgerHash` que lo sella **incluye** las dimensiones: el hash no cambia (porque las cifras contables no cambian) pero el resultado sí. Eso es exactamente lo que P3 y P7 de SPEC-FIABILIDAD prohíben |
| **Coste de la alternativa** | Un "asiento analítico de traspaso" en el diario financiero exigiría cuentas de reflejo del grupo 9 (que el PGC 2007 dejó a criterio libre y el ERP no implementa), duplicaría el número de asientos por cada corrección de imputación —una operación **frecuente** en una empresa de proyectos: un gasto llega antes de saber a qué proyecto va— y ensuciaría el libro diario con movimientos que no son hechos económicos. ADR-0004 ya descartó los asientos de grupo 9 por esta razón |

### 3.3 Decisión

> **DECISIÓN E4-D1 — SÍ es admisible reclasificar las dimensiones analíticas de una línea posteada, sin tocar el diario financiero, bajo cinco condiciones acumulativas.** Se descarta el asiento analítico de traspaso en el diario. Se descarta también el traspaso mediante `AllocationLine` manual: la analítica de una línea mal imputada debe **corregirse en la línea**, no compensarse con un apunte espejo, porque un drill-down desde el margen del proyecto tiene que llevar al documento real.

| # | Condición | Implementación |
|---|---|---|
| **C-R1** | Solo se pueden mutar `projectId`, `costCenterId`, `businessLineId`, `analyticType`. Cualquier otra columna de `JournalLine` sigue siendo inmutable (`GRANT` de columna + RLS `FOR UPDATE`) | migración E4: ampliar el `GRANT UPDATE (…)` de `journal_lines` a estas 4 columnas, y **solo** a ellas |
| **C-R2** | Rol `EDITOR` con la línea en un **mes no bloqueado**; `ADMIN` con motivo en un mes bloqueado del **ejercicio abierto**; **prohibido** en ejercicio `CLOSED` (sin excepción de rol) | `requireOrg` + trigger que replica la lógica de `PeriodLock`/`FyStatus` para el `UPDATE` analítico |
| **C-R3** | Traza obligatoria en `AuditLog`: `entity = "JournalLine"`, `action = "RECLASSIFY_ANALYTICS"`, `before`/`after` con las 4 columnas, `reason` obligatorio ≥ 10 caracteres, en la **misma transacción** que el `UPDATE` | ya soportado por `AuditLog` (append-only desde E2, ADR-0008) |
| **C-R4** | El proyecto destino no puede estar `CLOSED` (regla de cierre de proyecto de la skill), y el CECO destino debe estar `isActive` | validación en `models/` |
| **C-R5** | Toda reclasificación **invalida los `AllocationRun` del periodo afectado** (`supersededAt`) y marca los `ReportRun` analíticos de ese periodo como `REQUIERE_REVISION`, porque su base cambió | `ManualReviewFlag` + recálculo de `analyticsHash` |

### 3.4 `ledgerHash` financiero vs `analyticsHash` — propuesta E4-D2

> **DECISIÓN E4-D2 — El `ledgerHash` financiero NO incluye las dimensiones analíticas; se añade un `analyticsHash` independiente.** Sin esta separación, C-R1 es incompatible con P3.

| Hash | Contenido exacto (líneas del periodo, orden `(entryDate, entryNumber, lineNo)`) | Cambia con |
|---|---|---|
| **`ledgerHash`** | `sha256` de `(entryId, lineNo, accountCode, debitCents, creditCents, entryDate, fiscalYearId, entryKind, taxRateId)` | Cualquier asiento nuevo, contra-asiento o cambio contable. **No** cambia con una reclasificación analítica |
| **`analyticsHash`** *(nuevo)* | `sha256` de `(entryId, lineNo, projectId, costCenterId, businessLineId, analyticType)` **+** `marginLevelConfigHash` **+** `allocationRunId` vigente | Cualquier reclasificación, cambio de `MarginLevelConfig`, cambio de `AnalyticType` de una cuenta, o nueva liquidación de CECOs |

Consecuencias que hay que implementar en E4:

| Elemento | Cambio |
|---|---|
| `ReportRun` | Añadir `analyticsHash String?`. Los informes **financieros** (`DIARIO`, `MAYOR`, `SUMAS_SALDOS`, `BALANCE`, `PYG`, `CASHFLOW_*`) lo dejan `NULL`; los **analíticos** (`PYG_ANALITICA`, `PRESUPUESTO_REAL`, `DASHBOARD`) lo exigen `NOT NULL` (check condicional por `type`) |
| Idempotencia de informes | La clave de reutilización de un `ReportRun` analítico pasa de `(organizationId, type, ledgerHash)` a `(organizationId, type, ledgerHash, analyticsHash)`; el índice se amplía |
| `AllocationRun` | Ya guarda `ledgerHash` + `rulesHash`; añadir `analyticsHash` para que un rerun detecte que cambió la imputación de origen aunque el diario esté intacto |
| Auditoría | Nuevo check informativo: nº de reclasificaciones del periodo, importe reclasificado y lista de `ReportRun` invalidados |
| Un valor positivo colateral | El `ledgerHash` deja de depender de datos de gestión: dos organizaciones con el mismo diario y distinta analítica producen el mismo `ledgerHash`, lo que hace comparables las verificaciones de I1–I3 |

**Alternativa descartada — asiento analítico de traspaso.** Se documenta por qué, para que no vuelva a plantearse:

| Motivo | Detalle |
|---|---|
| No es un hecho económico | Un cambio de imputación interna no cumple el devengo (NRV 14ª): no hay transacción, ni tercero, ni riesgo transmitido |
| Rompe el drill-down | La línea original seguiría apuntando al proyecto equivocado; el margen se corregiría por un apunte sin documento, y el usuario vería en `P-01` un cargo y un abono que no corresponden a ninguna factura |
| Rompe I5 y los drivers de E5 | `REVENUE_SHARE` y `DIRECT_COST_SHARE` se calculan «desde el diario, nunca desde memoria». Con traspasos, la base del driver dependería del orden en que se aplicaron las correcciones |
| Contradice ADR-0004 | «Asientos analíticos en el diario (cuentas 9x): contamina el diario financiero y complica anulaciones» — ya descartado y aprobado |
| Sí se conserva un caso | Cuando lo que cambia **no** es una imputación errónea sino un **reparto** de estructura (CECO → proyectos), la vía correcta **sigue siendo** `AllocationRun`, que ya es exactamente eso: un traspaso analítico reversible que no toca el diario |

---

## 4. CECOs por defecto y `MarginLevelConfig` por defecto

### 4.1 Semilla de centros de coste para una empresa de proyectos / servicios

Se siembran al crear la organización (`origin = SEED`, editables; **`CC-NA` no es editable ni borrable**).

| `code` | Nombre | `kind` | `marginLevel` | `allocatable` | Cuentas típicas que absorbe |
|---|---|---|---|---|---|
| `CC-OPS` | Operaciones indirectas | `OPERACIONES_INDIRECTAS` | **MC3** | sí | `640`/`642` de jefatura de operaciones y PMO no facturable · `621` (nave, taller) · `628` suministros de producción · `622` reparaciones · `629` |
| `CC-DEV` | Desarrollo de producto | `DESARROLLO_PRODUCTO` | **MC3** | sí | `640`/`642` de I+D · `623` consultoría técnica · `620` I+D del ejercicio · licencias de desarrollo en `621`/`629` |
| `CC-MKT` | Marketing y ventas | `MARKETING_VENTAS` | **EBITDA** | sí | `627` publicidad y RR.PP. · `640`/`642` comerciales · `625` seguros de RC comercial · `629` eventos · comisiones de venta en `623`/`649` |
| `CC-GA` | General y administración | `G_A` | **EBITDA** | sí | `621` alquiler de oficina · `623` asesoría, auditoría y abogados · `625` seguros generales · `626` comisiones bancarias · `628` suministros de oficina · `631` tributos locales · `640`/`642` de administración y dirección · `650` incobrables · `678` gastos excepcionales |
| `CC-FIN` | Financiero | `FINANCIERO` | EBITDA *(irrelevante: R-A6)* | **no** | `662`, `665`, `668`, `669`, `760`, `768`, `769`. **Nunca se imputa**: sus líneas caen en la columna Financiero, nivel BAI |
| `CC-EXT` | Otros extraordinarios | `EXTRAORDINARIO` | EBITDA *(irrelevante con `AnalyticType = EXTRAORDINARIO`)* | **no** | **Se siembra siempre** (decisión del coordinador), aunque quede vacío con el seed de fábrica (R-A10). Recibe lo que la organización reclasifique a `EXTRAORDINARIO` a mano |
| `CC-OTR` | Otros | `OTROS` | EBITDA | sí | Cajón de sastre configurable; la Auditoría lo lista como Info si supera un umbral del gasto total |
| `CC-NA` | Sin asignar | `SIN_ASIGNAR` | EBITDA | **no** | Destino automático con `analyticsRequired = false` (R-A8). **Saldo > 0 ⇒ WARN permanente en Auditoría**, con importe y nº de líneas. Nunca se imputa: dejarlo visible es el punto |

`CC-FIN`, `CC-EXT` y `CC-NA` son `allocatable = false` por razones distintas y las tres correctas: los dos primeros porque su importe no pertenece al resultado de explotación y repartirlo entre proyectos falsearía el MC3; el tercero porque repartir lo que no se sabe imputar convierte un error visible en un error invisible.

### 4.2 `MarginLevelConfig` por defecto

| `level` | `label` | `analyticTypes` | `sortOrder` | Fuente de la fila |
|---|---|---|---|---|
| `INGRESOS` | Ingresos de proyecto | `[INGRESO_DIRECTO]` | 1 | Tipo |
| `MC1` | Margen de contribución 1 (tras aprovisionamiento) | `[COSTE_DIRECTO_MC1]` | 2 | Tipo |
| `MC2` | Margen de contribución 2 (tras costes directos) | `[COSTE_DIRECTO_MC2]` | 3 | Tipo |
| `MC3` | Margen de contribución 3 (tras estructura operativa) | `[]` | 4 | **CECO** con `marginLevel = MC3` y tipo efectivo `INDIRECTO_CECO` |
| `EBITDA` | EBITDA | `[]` | 5 | **CECO** con `marginLevel = EBITDA` y tipo efectivo `INDIRECTO_CECO` |
| `EBIT` | EBIT (tras amortizaciones y deterioros) | `[AMORTIZACION_DETERIORO]` | 6 | Tipo |
| `BAI` | Resultado antes de impuestos | `[FINANCIERO, EXTRAORDINARIO]` | 7 | Tipo |
| `RESULTADO` | Resultado del ejercicio | `[NO_ANALITICO]` **solo `630`/`633`/`638`** | 8 | Tipo + prefijo de cuenta (R-A11) |

Reglas de validación del propio `MarginLevelConfig` (E4):

| Id | Regla |
|---|---|
| MLC-1 | Cada `AnalyticType` aparece **exactamente una vez** en toda la configuración de la organización. Un tipo en dos niveles duplicaría importe y rompería I4 |
| MLC-2 | `MC3` y `EBITDA` **no pueden** listar `INDIRECTO_CECO` en `analyticTypes`: ese tipo se rutea por `CostCenter.marginLevel` (R-A7). Listarlo lo contaría dos veces |
| MLC-3 | Los 8 niveles existen siempre; se puede cambiar `label` y mover un tipo de nivel, no borrar un nivel ni añadir uno nuevo |
| MLC-4 | Cambiar la configuración cambia `analyticsHash` (E4-D2) y marca `REQUIERE_REVISION` los `ReportRun` analíticos afectados. Nunca se recalcula un informe histórico en silencio |
| MLC-5 | `NO_ANALITICO` se parte por R-A11: el impuesto (`630`/`633`/`638`) queda **clavado** en `RESULTADO` y no es configurable; el resto se rige por `MarginLevelConfig.nonAnalyticLevel` (nuevo campo), cuyos valores admisibles son **`EBITDA`** (default), `EBIT` o `BAI` — nunca `INGRESOS`, `MC1`, `MC2` ni `MC3`, que contaminarían los márgenes de proyecto con importes sin dimensión |

### 4.3 Criterio `64x` directo (MC2) vs indirecto (CECO)

> **La decisión es SIEMPRE por línea, nunca por cuenta.** El default de la cuenta `640`/`642` en el seed es `COSTE_DIRECTO_MC2`, es decir, **directo**, y el CECO absorbe lo que no lo sea. T-10 ya obliga a "una línea por destino" en el mismo asiento de nómina, que es lo que hace la decisión por línea posible sin duplicar cuentas.

| Criterio | Va a **proyecto** (MC2) | Va a **CECO** (MC3 / EBITDA) |
|---|---|---|
| Trazabilidad | Hay parte de horas (`TimeEntry`) o asignación contractual a un proyecto identificado | No hay imputación de horas posible o el trabajo no es atribuible |
| Naturaleza del rol | Ejecución entregable: consultor, desarrollador, técnico de campo | Soporte: administración, RR.HH., dirección general, marketing |
| Rol mixto | **Se parte la nómina**: tantas líneas de `640` como destinos, con el reparto que dicten las horas. El `642` sigue el mismo reparto que el bruto salvo override explícito | — |
| Jefatura | Jefe de proyecto dedicado a proyectos concretos → proyecto | Jefe de operaciones / PMO transversal → `CC-OPS` (MC3, luego imputable a proyectos en E5) |
| Baja, vacaciones, formación | Se mantienen en el proyecto si la tarifa interna ya las absorbe (criterio de organización, sellado) | `CC-GA` si la organización costea a tarifa "hora productiva" |
| `649` otros gastos sociales | Sigue al destino del bruto de esa persona | `CC-GA` si es un beneficio general (seguro médico colectivo, formación transversal) |
| Regla de cierre | Si el 100 % de una nómina va a CECO durante 3 meses seguidos habiendo horas del empleado en proyectos, la Auditoría lo lista como **Info** (posible infra-imputación de MC2) | — |

**Por qué el default de la cuenta es directo y no indirecto:** en una empresa de proyectos el personal es el coste dominante y el error caro es el de **omisión** (dejar personal fuera del margen del proyecto, que hace parecer rentables proyectos que no lo son). Con default directo, el usuario que no informa dimensión choca con C-9 y tiene que decidir; con default indirecto, el gasto se colaría a un CECO sin fricción y el MC2 quedaría sistemáticamente sobrevalorado. El CECO absorbe lo indirecto **por decisión expresa de cada línea**, no por inercia.

---

## 5. Invariantes

### 5.1 I4 formulado como test (definición canónica en `.claude/skills/fiabilidad`)

```
-- Notación: L = { l ∈ journal_lines : l.organization_id = :org
--                                   ∧ l.entry_date ∈ [:from, :to]
--                                   ∧ l.entry_kind ∉ {REGULARIZATION, CLOSING, OPENING}
--                                   ∧ substr(l.account_code, 1, 1) ∈ {'6','7'} }
--         aporte(l) = l.credit_cents − l.debit_cents
--         M[nivel][col] = matriz analítica CUMULATIVA (§0)
--         C = conjunto de columnas: proyectos ∪ CECOs por kind ∪ {AMORT, FIN, EXTRA, NO_ANALITICO}
--             (las columnas de línea de negocio NO pertenecen a C: son agregados de proyecto)

I4.a  ∀ nivel ∈ {INGRESOS, MC1, MC2, MC3, EBITDA, EBIT, BAI, RESULTADO}:
          Σ_{c ∈ C} M[nivel][c]  =  Σ_{l ∈ L : nivel(l) ≤ nivel} aporte(l)          -- tolerancia 0

I4.b  Σ_{c ∈ C} M[RESULTADO][c]  =  Σ_{l ∈ L} aporte(l)  =  I3(:org, :from, :to)     -- tolerancia 0

I4.c  ∀ l ∈ L:  ∃! (nivel, columna) tal que l contribuye a M[nivel][columna]         -- cobertura y unicidad
```

```ts
// lib/analytics/invariants.test.ts  (fixture: tests/fixtures/ejercicio-completo.json,
//                                    esperado: docs/design/fixtures/pyg-analitica-esperada.json)
test.each(LEVELS)("I4 · nivel %s cuadra con la PyG contable", (level) => {
  const m = buildAnalyticMatrix(lines, accounts, marginConfig, /* allocationRun */ null)
  const sumColumns = COLUMNS.reduce((a, c) => a + m[level][c], 0)   // BigInt en el agregado
  expect(sumColumns).toBe(expectedJson.levelTotalsCents[level])     // tolerancia 0
})
test("I4.b · RESULTADO = I3", () => {
  expect(sumColumns("RESULTADO")).toBe(pygContable(lines))          // 1_497_322 en el fixture
})
test("I4.c · ninguna línea 6/7 fuera de la matriz", () => {
  expect(m.coveredLineIds.size).toBe(lines67(lines).length)         // 85 / 85 en el fixture
})
test("byte a byte contra el esperado sellado", () => {
  expect(canonicalJson(m)).toBe(readFileSync("docs/design/fixtures/pyg-analitica-esperada.json"))
})
```

**Casos límite que el test debe cubrir explícitamente:**

| Caso | Comportamiento esperado |
|---|---|
| Periodo sin líneas 6/7 | Matriz de ceros; I4 PASS (0 = 0), no error |
| Contra-asiento del mismo periodo | Se compensa solo, sin tratamiento especial; I4 PASS |
| Contra-asiento en periodo posterior (mes del original bloqueado) | El importe **cambia de periodo**: I4 PASS en ambos periodos por separado, y la Auditoría lo explica. No es un descuadre |
| Línea con `NO_ANALITICO` y dimensión informada | FAIL de I-E4-4 **antes** de calcular la matriz (no se "arregla" silenciosamente) |
| `AMORTIZACION_DETERIORO` con `projectId` | Cae en la columna del proyecto, nivel EBIT. La fila MC3 del proyecto **no** cambia |
| CECO con `marginLevel` distinto de `MC3`/`EBITDA` | Error de configuración, no de cuadre: bloquea el informe |
| Reclasificación entre dos ejecuciones | `analyticsHash` distinto ⇒ nuevo `ReportRun`; el anterior queda histórico (P3) |
| Importe agregado > 2³¹ | Los agregados en `BigInt`; la línea sigue siendo `Int` (misma regla que I1) |

### 5.2 Invariantes propios de E4 (propuesta, se añaden a la pestaña Auditoría)

| Id | Regla | Fórmula / comprobación | Severidad |
|---|---|---|---|
| **I-E4-1** | **Cobertura total.** Toda línea 6/7 del periodo tiene destino: `projectId` xor `costCenterId`, o `analyticType = NO_ANALITICO`. Con `analyticsRequired = false`, las huérfanas están en `CC-NA` y su importe se reporta | `count(L sin destino y sin NO_ANALITICO) = 0` | FAIL (WARN si `analyticsRequired = false`, con importe) |
| **I-E4-2** | **Exclusividad de dimensión.** `(projectId IS NULL) <> (costCenterId IS NULL)` en toda línea 6/7 no `NO_ANALITICO`. Nunca las dos, nunca ninguna | CHECK en BD + test | FAIL |
| **I-E4-3** | **Coherencia de línea de negocio.** `businessLineId` de toda línea con proyecto = `businessLineId` **que tenía el proyecto en la fecha de alta**; línea con CECO ⇒ `businessLineId IS NULL` | trigger + test sobre el fixture | FAIL |
| **I-E4-4** | **`NO_ANALITICO` sin dimensión.** Ninguna línea con tipo efectivo `NO_ANALITICO` lleva `projectId`, `costCenterId` ni `businessLineId`. Aplica en particular a `630` | `count = 0` | FAIL |
| **I-E4-5** | **Sin dimensión fuera de 6/7.** Ninguna línea de grupos 1–5 lleva `projectId`, `costCenterId`, `businessLineId` ni `analyticType` | CHECK en BD | FAIL |
| **I-E4-6** | **Ningún porcentaje de margen se persiste.** No existe columna ni tabla con `marginPercent`, `mc1Percent`… Los % son cálculo puro en el renderizador, sobre céntimos, y con ingresos = 0 se muestra `—`, nunca `0 %` ni `∞` | revisión de código + grep en CI | FAIL de revisión |
| **I-E4-7** | **Tenant de las dimensiones.** `project(l).organizationId = costCenter(l).organizationId = businessLine(l).organizationId = l.organizationId` (extensión de I10, ahora con FK compuesta real: E4 retira el "sin FK hasta E4" de `MODELO-DATOS`) | FK compuesta + check sin filtro de tenant | FAIL |
| **I-E4-8** | **Estabilidad de la matriz.** Dos ejecuciones con el mismo `(ledgerHash, analyticsHash, marginLevelConfigHash, allocationRunId)` producen matrices **idénticas byte a byte** (P7) | test de reproducibilidad | FAIL |
| **I-E4-9** | **Unicidad de tipo por nivel.** Cada `AnalyticType` aparece exactamente una vez en `MarginLevelConfig` de la organización, y `MC3`/`EBITDA` no listan `INDIRECTO_CECO` (MLC-1, MLC-2) | validación al guardar | FAIL |
| **I-E4-10** | **Proyecto cerrado sin líneas nuevas.** Ninguna línea con `entryDate` posterior al paso a `CLOSED` apunta a ese proyecto, salvo asientos con `AuditLog` de excepción de `ADMIN` | check + lista en Auditoría | WARN |
| **I-E4-11** | **Contra-asiento con dimensión espejo.** Para todo par `(original, REVERSAL)`, `Σ aporte = 0` **por cuenta y por (proyecto, CECO, analyticType)**, no solo por cuenta (refuerzo analítico de I-E3-1 / CA-5) | test sobre el fixture | FAIL |
| **I-E4-12** | **Rectificativas con la dimensión del rectificado.** Toda línea de `606`/`608`/`609`/`706`/`708`/`709` tiene la misma dimensión que la línea que rectifica (C-12 ampliado a la analítica) | check al postear T-02/T-05 | FAIL |

---

## 6. Veredicto sobre `docs/MODELO-DATOS.md` §Analítica

### **CONFORME CON OBSERVACIONES** — el modelo soporta la matriz de §1, el invariante I4 y las reglas de destino de §2 sin ningún cambio de ruptura. Faltan **5 restricciones**, **3 campos** y **1 corrección de convención** para que E4 sea implementable exactamente como está especificado aquí.

**Lo que está bien y no debe tocarse**

| Elemento | Valoración |
|---|---|
| Dimensiones en la propia `JournalLine` (`projectId`, `costCenterId`, `businessLineId`, `analyticType`) en vez de una tabla de imputaciones aparte | Correcto y es lo que hace I4 computable con un solo `GROUP BY`, sin `JOIN` ni riesgo de líneas sin imputar |
| `analyticType` **en la línea** además de en la cuenta | Correcto: es lo que permite R-A2/R-A3 y el caso real del fixture (`623` con `projectCode = P-02`) sin duplicar cuentas del plan |
| `businessLineId` **denormalizado** en la línea | Correcto: el proyecto puede cambiar de línea de negocio y los informes históricos no pueden cambiar (R-A9) |
| `CostCenter.marginLevel ∈ {MC3, EBITDA}` validado, con `MarginLevel` como enum de 8 valores | Correcto: separa "en qué nivel se descuenta este CECO" de "qué niveles existen" |
| `MarginLevelConfig` por organización con `analyticTypes[]` | Correcto y suficiente, dado R-A7 |
| `CostCenterKind` incluye **`SIN_ASIGNAR`** (que la skill `contabilidad-analitica` **omite** en su lista de 7 tipos) | El modelo tiene razón y la skill se queda corta: sin ese `kind`, `analyticsRequired = false` no tiene destino tipificado. **Corregir la skill**, no el modelo |
| `AllocationRun` con `ledgerHash` + `rulesHash` + `supersededById` + `reversedAt`, y `AllocationLine` sin tocar el diario | Correcto (ADR-0004). E5 lo consumirá tal cual |
| `AnalyticType.EXTRAORDINARIO` conservado aunque el seed no lo use | Correcto: el enum es el contrato, y una organización puede reclasificar (R-A10) |
| `enum ReportType` ya incluye `PYG_ANALITICA` y `PRESUPUESTO_REAL` | Correcto |

**Observaciones** (O-A1…O-A9). Nivel 2 las que tocan esquema del motor o invariantes ⇒ ADR + firma humana.

| # | Carencia | Propuesta | Nivel | Bloquea E4 |
|---|---|---|---|---|
| **O-A1** | `JournalLine.projectId/costCenterId/businessLineId` están declarados **"nullable y SIN FK hasta E4"**. Sin FK compuesta, I-E4-7 solo se comprueba en código y una dimensión de otro tenant es representable en BD | FK compuestas `(organization_id, project_id) → projects(organization_id, id)` y equivalentes para CECO y LN, con `@@unique([organizationId, id])` en las tres tablas destino (mismo patrón que la FK de `accounts` de E2) | 2 | **Sí** |
| **O-A2** | Nada impide en BD que una línea lleve **proyecto y CECO a la vez**, ni que una línea de grupo 1–5 lleve dimensiones | Dos CHECK: `CHECK (project_id IS NULL OR cost_center_id IS NULL)` y `CHECK (left(account_code,1) IN ('6','7') OR (project_id IS NULL AND cost_center_id IS NULL AND business_line_id IS NULL AND analytic_type IS NULL))` (I-E4-2, I-E4-5) | 2 | **Sí** |
| **O-A3** | No existe `analyticsHash`. Con E4-D1 (reclasificación admitida), un `ReportRun` analítico sellado **deja de ser reproducible** y se viola P3/P7 | `ReportRun.analyticsHash String?` (obligatorio para `PYG_ANALITICA`/`PRESUPUESTO_REAL`/`DASHBOARD`), `AllocationRun.analyticsHash String`, índice `(organizationId, type, ledgerHash, analyticsHash)`. Definir en `lib/analytics/hash.ts` que el `ledgerHash` financiero **excluye** las 4 columnas analíticas (E4-D2) | 2 | **Sí** |
| **O-A4** | `JournalLine` es inmutable salvo las tres columnas de anulación (`GRANT` de columna, E3). La reclasificación de E4-D1 no es posible sin ampliar ese `GRANT`, y ampliarlo sin control abriría la puerta a mutar importes | Ampliar el `GRANT UPDATE` a **exactamente** `project_id`, `cost_center_id`, `business_line_id`, `analytic_type` + trigger que exige `AuditLog` en la misma transacción y rechaza el `UPDATE` si el mes está bloqueado o el ejercicio `CLOSED` (C-R1…C-R3) | 2 | **Sí** |
| **O-A5** | **Ninguno** de los 14 modelos del bloque §Analítica declara `@@map`/`@map` en snake_case, pese a que §0 del propio documento lo declara **obligatorio** ("el SQL de RLS, triggers e informes usa snake_case") | Añadir `@@map("business_lines")`, `"projects"`, `"cost_centers"`, `"margin_level_configs"`, `"allocation_rules"`, `"allocation_rule_targets"`, `"allocation_runs"`, `"allocation_lines"`, `"budgets"`, `"time_entries"`, `"employee_rates"`, `"counterparties"` y los `@map` de columna. Sin esto, las políticas RLS y los checks de invariantes no encuentran las tablas | 1 (docs) → 2 (migración) | **Sí** |
| **O-A6** | `Budget @@unique([organizationId, year, month, projectId, costCenterId, accountCode])` con **tres columnas nullables**: en PostgreSQL `NULL` no es igual a `NULL`, así que el índice **no impide duplicados** de presupuestos generales de proyecto (`accountCode = NULL`) | Índices únicos **parciales** por combinación (proyecto+cuenta, proyecto sin cuenta, CECO+cuenta, CECO sin cuenta), o `NULLS NOT DISTINCT` (PG 15+). Añadir además `CHECK (project_id IS NULL) <> (cost_center_id IS NULL)` | 2 | No (E5/E7) |
| **O-A7** | `MarginLevelConfig` no está versionado ni tiene `sortOrder` obligatorio ni validación MLC-1/MLC-2. Un cambio de configuración altera en silencio todos los informes analíticos históricos | `validFrom`/`validTo` (o al menos `updatedAt` + inclusión en `analyticsHash`), `sortOrder Int` no nulo, y validación de unicidad de `AnalyticType` al guardar (I-E4-9) | 2 | Parcial |
| **O-A8** | `Project` no tiene campo para el momento del cierre ni `CostCenter` para su origen. I-E4-10 ("proyecto `CLOSED` sin líneas nuevas") no es comprobable sin fecha | `Project.closedAt Date?`, `Project.closedById?`; `CostCenter.origin AccountOrigin` y `isSystem Boolean` (para blindar `CC-NA`), simétrico a `LedgerAccount` | 1 | No |
| **O-A9** | El documento no dice **quién** fija el `AnalyticType` por cuenta a nivel de organización ni cómo se audita su cambio. Cambiar `LedgerAccount.analyticType` mueve importe entre niveles de todos los periodos abiertos | Aplicar a `analyticType` la misma regla que E2 dio a `epigraph` (R-10b): `ADMIN` + motivo + `AuditLog`, **prohibido si la cuenta tiene líneas en un ejercicio `CLOSED`**, y siempre incluido en `analyticsHash` | 1 | No |

**Divergencias detectadas con otros documentos, que deben corregirse ahí y no aquí**

| Documento | Divergencia | Corrección |
|---|---|---|
| `.claude/skills/contabilidad-analitica` §"Tipos de CECO por defecto" | Lista 7 `kind` y omite `SIN_ASIGNAR`, que el modelo sí tiene y que R-A8 necesita | Añadir `SIN_ASIGNAR` a la skill |
| `.claude/skills/contabilidad-analitica` §"Niveles de margen", fila `MC2` | Dice «64x personal imputado directamente **+ 62x directos**». El seed marca 62x como `INDIRECTO_CECO`: la coherencia solo existe gracias a la regla de override implícito R-A3, que hasta ahora no estaba escrita en ningún sitio | Referenciar R-A3 en la skill (o dejar la regla solo aquí y citarla) |
| Enunciado de la épica E4 | «Σ7−Σ6 … = 1 497 322 **antes de IS**» | 1 497 322 es **después** de IS; antes de IS es 1 996 430 (§1.4) |
| `docs/MODELO-DATOS.md` §Integridad, fila "6/7 con destino analítico si `analyticsRequired`" → "código" | Debe ser "código **+ CHECK + FK compuesta**" tras O-A1/O-A2 | Actualizar la tabla |

**Nada de lo anterior invalida el modelo.** O-A1…O-A5 deben entrar en la migración de E4 (son baratos ahora y caros con líneas posteadas y con RLS `FORCE` ya activa); O-A6 puede esperar a E5/E7 con la deuda anotada; O-A7…O-A9 son mejoras de gobernanza que no bloquean la matriz de §1.

---

## 7. Artefactos de esta épica

| Fichero | Qué es | Mutable |
|---|---|---|
| `docs/design/E4-validacion-analitica.md` | Este documento | Sí (se versiona con ADR si cambia una decisión) |
| `docs/design/fixtures/build_pyg_analitica_esperada.py` | Generador determinista de la matriz esperada, Python puro, sin `lib/`, sin BD, sin float | Sí |
| `docs/design/fixtures/pyg-analitica-esperada.json` | Matriz esperada sellada: `matrixCents`, `businessLineMatrixCents`, `levelTotalsCents`, `contributionByLevelCents`, `checks`, `lineDetail` (85 líneas con su ruteo) | **No** — se regenera, no se edita; CI ejecuta `--check` |
| `tests/fixtures/ejercicio-completo.json` · `ejercicio-minimo.json` | Fixtures de E3. **Entrada de solo lectura de esta épica** | **No** |

---

## 8. Respuestas al arquitecto (`docs/design/E4-analitica.md` §9.3)

### 8.1 — `NO_ANALITICO`: **la propuesta del arquitecto es correcta**; `630`/`633`/`638` → `RESULTADO`, el resto → `nonAnalyticLevel` con default **`EBITDA`**

**Decisión: se acepta el desdoblamiento, con dos matices.** (a) El nivel del **impuesto** es **fijo y no configurable** (`630` impuesto corriente, `633` ajustes negativos, `638` ajustes positivos; se añade `6300`/`6301` por herencia de hoja): el IS se determina sobre la base imponible del sujeto pasivo, no sobre ningún resultado de gestión, y `RESULTADO = BAI − impuesto` es la definición canónica de la skill. Permitir moverlo dejaría que una organización calculase un "EBITDA con impuesto dentro", que no es EBITDA. (b) El resto de `NO_ANALITICO` (`73x` trabajos para la empresa, `74x` subvenciones, `75x` otros ingresos de gestión) es **resultado de explotación** (epígrafes 3, 5 y 9 del modelo de PyG del PGC): ponerlo en `RESULTADO` lo sacaría del EBITDA y produciría un EBITDA que no es el de las cuentas anuales, que es la cifra que el banco y el comité miran. Por eso `nonAnalyticLevel` **default `EBITDA`**, con valores admisibles `{EBITDA, EBIT, BAI}` y **prohibidos** `{INGRESOS, MC1, MC2, MC3}` (MLC-5 reescrito): un importe sin dimensión por encima de MC3 contaminaría los márgenes de proyecto, que es exactamente el defecto que la columna `NO_ANALITICO` existe para evitar. Se **descarta** la tercera opción ("repartirse por epígrafe de PyG"): un epígrafe no es un nivel de margen, la correspondencia no es biyectiva (el epígrafe 13 "Otros resultados" contiene `678`/`778`, que ya van por CECO) y ataría el modelo analítico al formato de depósito de cuentas. Formalizado como **R-A11** (§2.1) e implementado en `build_pyg_analitica_esperada.py` (`nonAnalyticSplit`). **Efecto en la matriz del fixture: ninguno** — no hay líneas de `73x`/`74x`/`75x`, y los ocho totales de §1.1 son idénticos antes y después del cambio, lo que confirma que la regla es aditiva y no reabre I4.

### 8.2 — `INDIRECTO_CECO` con `projectId`: **se admite, y cae en `COSTE_DIRECTO_MC2` del proyecto — no en MC3, y no se rechaza**

**Decisión: R-A3, override implícito a `COSTE_DIRECTO_MC2`.** Se descartan las dos alternativas del arquitecto por razones distintas. **Rechazar la combinación es inviable**: el propio fixture sellado de E3 la contiene (`623` Servicios de profesionales independientes con `projectCode = P-02`, 150 000 c) y la skill `contabilidad-analitica` ya define MC2 como «64x personal imputado directamente **+ 62x directos** (viajes, materiales del proyecto)»; rechazarla obligaría a duplicar medio grupo 62 en el plan (`623-DIR` / `623-IND`), que es precisamente lo que `AnalyticType` en la línea existe para no tener que hacer. **Dejarlo caer en MC3 del proyecto es contablemente falso**: MC3 es "margen tras absorber estructura", y un alquiler de obra o un subcontratista técnico de un proyecto concreto **no es estructura**, es coste directo de ejecución; si cayera en MC3, MC2 quedaría sistemáticamente sobrevalorado y dos proyectos idénticos —uno que alquila la grúa y otro que la tiene en propiedad— mostrarían MC2 distinto y MC3 igual, que es el diagnóstico invertido. El criterio de frontera es el de siempre: **directo = desaparece si el proyecto no existe** (alquiler de obra, dietas del equipo, licencia comprada para el cliente); **indirecto = permanece** (alquiler de la oficina, asesoría fiscal). La conversión es **automática y sin WARN** porque el usuario ya expresó su intención al informar `projectId`; lo que sí queda trazado es el `analyticType` efectivo, que se persiste en la línea y entra en el `analyticsHash`.

### 8.3 — `678`/`778`: **se mantienen `INDIRECTO_CECO` en nivel EBITDA; el `EXTRAORDINARIO` sigue vacío por diseño**

**Decisión: la propuesta actual del arquitecto es correcta y el seed no se toca.** El RD 1514/2007 **suprimió el resultado extraordinario**: `678`/`778` son "Gastos e ingresos excepcionales" del **epígrafe 13 «Otros resultados»**, que está **dentro del resultado de explotación** y por tanto **por encima del EBITDA** en el modelo normal y en el abreviado. Marcarlas `EXTRAORDINARIO` las sacaría del margen operativo, produciría un EBITDA distinto del de las cuentas anuales depositadas y reintroduciría por la puerta de atrás una categoría que la norma eliminó — con el agravante de que es la vía clásica de maquillaje ("mi EBITDA recurrente excluye lo excepcional"), que un ERP no debe facilitar por defecto. Coherencia ya establecida: E3 T-22 manda los errores no significativos de ejercicios cerrados a `678`/`778` y dice literalmente «epígrafe 13, **dentro** del resultado de explotación»; el fixture tiene `AJ-001` (35 000 c a `678`, CC-GA) y esos 35 000 c están dentro de los −633 180 de la columna `CECO G&A` del nivel EBITDA (§1.2). El enum `EXTRAORDINARIO` **se conserva** (es contrato, y una organización con actividad realmente ajena puede reclasificar con `ADMIN` + motivo, O-A9) y su columna vale 0 con el seed de fábrica: una columna vacía cuesta cero y evita una migración de enum el día que haga falta. El CECO `CC-EXT` "Otros extraordinarios" **se siembra igualmente** (decisión del coordinador), no imputable.

### 8.4 — `MarginLevelConfig`: **las dos cosas — `validFrom`/`validTo` Y `configHash` en la provenance**; no son alternativas

**Decisión: versionado temporal + hash, porque resuelven problemas distintos.** El **`validFrom`/`validTo`** (mismo patrón que `AllocationRule`, y por la misma razón: «nunca se edita una regla con liquidaciones, se cierra y se crea otra») resuelve la **corrección**: un ejercicio cerrado tiene que poder reimprimir su PyG analítica con la configuración que tenía cuando se cerró, y sin versión eso es imposible — el usuario que reordena niveles en 2027 reescribiría en silencio los márgenes de 2026, que es el defecto R4 que el arquitecto señala. El **`marginConfigHash` dentro de `analyticsHash`** (E4-D2) resuelve la **detección**: es lo que hace que un `ReportRun` emitido con la configuración *n* no se reutilice como caché para la *n+1* y quede marcado histórico en vez de sobrescrito (P3), y lo que permite a la Auditoría explicar por qué dos informes del mismo periodo difieren. Con solo el hash, el informe es reproducible pero el histórico es irrecuperable una vez editada la config; con solo `validFrom`, el histórico se conserva pero nada impide servir un informe cacheado con la configuración equivocada. Regla operativa: **la configuración vigente se selecciona por `entryDate` del periodo del informe, no por la fecha de ejecución**, y el par `(configId, marginConfigHash)` va en `ReportRun.provenance`. Coste: una tabla que ya existe más dos columnas de fecha.

### 8.5 — Reclasificación en mes bloqueado: **sí, con `ADMIN`, motivo y `AuditLog`; el ejercicio `CLOSED` es la línea correcta**

**Decisión: la propuesta del arquitecto es defendible y se confirma tal cual (C-R2 = salvaguarda 4 de ADR-0010).** Es defendible ante un auditor porque lo que el `PeriodLock` protege es **la cifra rendida**: el mes bloqueado congela el libro diario, los saldos, el 303 presentado y el balance, y **ninguno de los cuatro se mueve** — hay test que lo exige al céntimo. La analítica **no es libro obligatorio** (arts. 25 y 27 CdC): no se legaliza, no se deposita y no forma parte de la información que el auditor verifica; su calidad es un asunto de control interno, y el control interno adecuado es exactamente el que se propone: rol `ADMIN`, motivo obligatorio, `AuditLog` nominal en la misma transacción y caducidad de los informes derivados. La razón práctica es determinante: la información de a qué proyecto pertenece un gasto **llega sistemáticamente tarde** (el jefe de proyecto revisa la imputación al cerrar el mes o el trimestre, después de que administración haya bloqueado). Congelar la analítica con el mes obligaría a elegir entre bloquear tarde —perdiendo la protección contable, que sí importa— o convivir con un histórico mal imputado para siempre. El **ejercicio `CLOSED` sí es la frontera correcta y absoluta**: ahí hay cuentas formuladas y normalmente aprobadas y depositadas (arts. 253, 272 y 279 LSC), los informes de gestión de ese ejercicio han servido para decidir y para retribuir, y reescribirlos a posteriori es alterar la historia, no corregir un dato. Sin excepción de rol, con barrera en la acción y en el trigger.

> **Enmienda necesaria a ADR-0010, salvaguarda 5.** El ADR dice que la reclasificación «cambia el `ledgerHash` del periodo». Eso es incorrecto y hay que corregirlo antes de la firma: si el `ledgerHash` incluye las cuatro columnas analíticas, una reimputación de proyecto **invalida el balance, la PyG contable, el cashflow y el libro diario** ya sellados, que no han cambiado en un solo céntimo, y obliga a reemitir informes financieros idénticos. Redacción propuesta, coherente con E4-D2 (§3.4): el **`entryHash`** de la línea/asiento **sí** se recalcula (es el sello de la fila y cubre todas sus columnas — salvaguarda 2 del ADR, correcta); el **`ledgerHash`** de informe **excluye** `project_id`, `cost_center_id`, `business_line_id` y `analytic_type` y por tanto **no cambia**; se añade **`analyticsHash`**, que sí cambia y es el que caduca únicamente los `ReportRun` de tipo `PYG_ANALITICA`, `PRESUPUESTO_REAL` y `DASHBOARD`. Confirmado por el coordinador: **`analyticsHash` entra en E4**, no se difiere (O-A3).

### 8.6 — CECOs `FINANCIERO` y `EXTRAORDINARIO` **no imputables: de acuerdo, sin excepciones por reparto**

**Decisión: `allocatable = false` en ambos, y el caso de la comisión bancaria de proyecto se resuelve por otra vía.** Repartir un CECO cuyo importe se descuenta **por debajo de EBIT** entre columnas de proyecto rompería la propia definición de los niveles: el importe entraría en MC3 (que es donde aterriza un `AllocationLine`) y saldría del nivel BAI, de modo que el EBITDA de la compañía cambiaría según cómo se repartan los intereses de un préstamo — es decir, el resultado de explotación dependería de la estructura de financiación, que es exactamente lo que el EBITDA existe para aislar. Además, la carga financiera responde a decisiones de tesorería y de estructura de capital, no a la ejecución del proyecto, y penalizaría a los proyectos grandes por el mero hecho de serlo. El caso que plantea el arquitecto **no necesita reparto**: una comisión bancaria atribuible a un proyecto concreto (aval de licitación, comisión de una garantía, gastos de una carta de crédito de ese contrato) es **coste directo del proyecto desde el momento del asiento**, y la vía correcta es postear la línea de `626`/`669` **con `projectId`**, que por R-A3 la convierte en `COSTE_DIRECTO_MC2` y la deja donde debe estar, en el margen del proyecto, sin pasar por `CC-FIN` ni por ningún `AllocationRun`. La regla general que se deriva: **lo directo se imputa en el asiento; el reparto es solo para lo que no se puede imputar**. `CC-NA` (`SIN_ASIGNAR`) también es `allocatable = false`, y por el motivo inverso pero igual de firme: repartir lo que no se sabe imputar convierte un error visible en un error invisible. En resumen, tres CECOs no imputables (`CC-FIN`, `CC-EXT`, `CC-NA`) y cinco imputables (`CC-OPS`, `CC-DEV`, `CC-MKT`, `CC-GA`, `CC-OTR`).

### 8.7 — Contra-asiento: **hereda siempre el destino del original, sin excepción; corregir imputación no es anular**

**Decisión: la herencia literal de E3 §4.2 es correcta en todos los casos y no admite supuestos especiales.** El contra-asiento existe para **deshacer un hecho económico que no debió registrarse**; si el hecho no existe, tampoco existe su imputación, y la única forma de que su rastro analítico sea exactamente cero es que las dos líneas compartan `(proyecto, CECO, analyticType)` con las columnas invertidas. Eso es lo que hace comprobable **I-E4-11** (Σ aporte = 0 **por cuenta y por destino analítico**, no solo por cuenta): si la anulación fuera a otro destino, el par cuadraría en la PyG contable y **descuadraría en dos columnas de la matriz** —una con un cargo huérfano y otra con un abono huérfano—, mientras I4 seguiría en PASS porque los totales de fila son ciegos a la distribución. Sería un descuadre analítico invisible al invariante, que es la peor clase. El fixture ya lo ejercita: `REV-R-ERR` devuelve +100 000 c de `607` a `P-01`, exactamente donde estaba el cargo, y por eso MC1 de P-01 sale −150 000 y no −250 000 (§1.2). El único supuesto que parece una excepción **no lo es**: cuando lo que está mal no es el asiento sino la imputación, la operación correcta **no es anular** sino **reclasificar** (E4-D1 / ADR-0010) — y si por cualquier motivo se anula y se vuelve a postear, es el **asiento nuevo** el que lleva el destino corregido, nunca el `REVERSAL`. Regla de implementación: `T-21` **copia** las cuatro columnas analíticas y `validateAnalytics()` **no se ejecuta** sobre un `REVERSAL` (aunque el proyecto se haya cerrado o el CECO archivado entretanto, la anulación debe poder postearse: bloquearla dejaría un asiento erróneo vivo para siempre). Excepción de I-E4-10 documentada: un `REVERSAL` puede apuntar a un proyecto `CLOSED` sin generar WARN.
