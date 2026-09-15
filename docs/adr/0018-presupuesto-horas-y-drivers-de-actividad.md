# ADR-0018 — Presupuesto versionado y sellado, horas como unidad entera aprobada, drivers de actividad con su cuarto sello, forecast derivado y umbrales de desviación

**Estado:** **APROBADO por Pablo el 2026-09-14** (permiso general delegado de 2026-09-04), **D1–D6**, más **D7 aprobado el 2026-09-15** (ronda 1) · **Nivel:** 2 · **Fecha:** 2026-09-14 · **Ronda 1** (validación de control de gestión incorporada) · **Épica:** E10 ·
**Complementa:** ADR-0003 (informes derivados, `ReportRun`, sello), ADR-0004 (capa analítica paralela), ADR-0006 (dinero en céntimos), ADR-0010 (reclasificación analítica), ADR-0012 (umbrales y motivos de sello), **ADR-0013 (liquidación de CECOs; este ADR cumple su D4)** · **No enmienda ninguno** ·
**Diseño:** `docs/design/E10-presupuesto-horas.md` ·
**Validación de control de gestión:** `docs/design/E10-validacion-controlling.md` (**CONFORME CON OBSERVACIONES**; cinco bloqueantes O-E10-1/2/4/5/6, veintidós observaciones O-E10-0…22, respuestas a Q-1…Q-7, cinco invariantes nuevos I-E10-14…18 y el contrato de cifras de su §6). **Las veintidós están incorporadas** y este ADR pasa de cinco decisiones a **seis**: **D6** congela ese contrato.

> **O-E10-0 aplicada**: la validación se llama `E10-validacion-controlling.md`, no
> `E10-validacion-presupuesto.md`. Una referencia rota en un documento de Nivel 2
> es un defecto, no una errata.

> **Firmado.** Las tareas que bloqueaba —T4, T7, T8, T9, T11 y T13 del plan de
> §13, y T10, que congela el contrato de cifras de D6— quedan **desbloqueadas**:
> E10 puede pasar a `/sprint E10` en las tres olas de §14 del diseño.

---

## Contexto

ADR-0013 cerró la liquidación de CECOs y dejó **dos drivers explícitamente
apagados**: `HOURS` y `HEADCOUNT` se rechazan en la acción **y** en la base
(`CHECK ("driver" NOT IN ('HOURS','HEADCOUNT'))`), porque no había datos que los
alimentaran. Su D4 fue tajante sobre las condiciones de encendido: *«E10 retira el
CHECK y, en la misma épica, cumple el contrato del experto (…) con su propio
fixture»*, y su alternativa descartada lo dijo con más claridad todavía: *«una
regla que existe, está vigente y reparte 0 € es indistinguible de una organización
que decidió no repartir»*.

Al diseñar E10 sobre el código real aparecen **seis decisiones que ningún ADR
anterior cubre** y que son de Nivel 2 porque cambian el esquema del motor de
liquidación, la definición de un invariante, la clave de reutilización de un
informe o la definición del sello:

1. **Retirar el `CHECK` no basta.** La base de `HOURS`/`HEADCOUNT` **no vive en
   el diario**: no entra en `ledgerHash`, ni en `dimensionsHash`, ni en
   `rulesHash`. Un `AllocationRun` sellado con `HOURS` seguiría luciendo vigente
   después de que alguien apruebe un parte tardío del periodo, con un reparto que
   ya no se puede reproducir. La derivación de `STALE` de ADR-0013 D5 se queda
   ciega justo donde hace falta.
2. **`Budget` no existe todavía** y arrastra la deuda **O-A6** desde E4: el
   `@@unique` con tres columnas nullables **no impide duplicados** (`NULL <> NULL`
   en PostgreSQL). Además hay que decidir el **signo** de un importe
   presupuestado, la **identidad** de una versión y qué la hace inmutable.
3. **El coste-hora es una cifra que mueve el margen de todos los proyectos y no
   sale del diario.** Sin decisión explícita, dos organizaciones —o dos periodos
   de la misma— compararían magnitudes distintas sin saberlo.
4. **El forecast es la cifra que más ERP almacenan y más divergen.** Sin decisión,
   acabaría en una tabla con un proceso que la mantenga al día.
5. **Un informe de presupuesto vs. real puede firmarse
   `VALIDADO AUTOMÁTICAMENTE` sin presupuesto, o con uno distinto del de ayer, o
   con dos desviaciones grandes que se anulan** — tres formas de mentir con un
   sello verde.
6. **Y hay siete cifras cuya forma exacta hay que fijar antes de sellar el
   fixture** —unidad de tiempo, redondeo del coste, las dos bases de driver, la
   forma canónica del `timeHash`, los prefijos de la nómina y el signo del
   presupuesto—, más la convención de la descomposición volumen/precio que E11
   implementará. Decidirlas después cuesta un reversionado cada una.

**Ronda 1.** La validación de control de gestión encontró **cinco bloqueantes** en
lo anterior, y los cinco están corregidos en el texto de las decisiones: el sello
del tiempo no cubría la ventana que el driver consume (O-E10-1), el aviso de horas
sin aprobar sólo saltaba con base cero (O-E10-2), **el presupuesto sin imputar se
comparaba con un real imputado** (O-E10-4), `EV-14` era inalcanzable por
contradicción con el propio esquema (O-E10-5) y **nada impedía teclear un gasto en
positivo** (O-E10-6).

---

## Decisión

### D1 — Drivers de actividad: base, sello, ventana y la garantía de ADR-0013 D4

**`HOURS`.** El peso de un receptor es `Σ TimeEntry.minutes` de las entradas
**`APROBADO` y `productive`** con ese receptor y `date` dentro de la **ventana
efectivamente consumida por el run**, contra-apuntes incluidos **con su signo**, y
`max(0, ·)` como en el resto de drivers. Receptores admitidos: proyectos, CECOs y
líneas de negocio (por el proyecto del parte). Cumple el contrato que el experto
fijó en E5: **unidad entera** —**minutos**, ver D6—, **sólo entradas aprobadas**
—una hora sin firmar no reparte dinero— y **las horas de personal ya imputado
directamente a MC2 cuentan igual**, porque el driver mide *consumo de estructura*,
no coste.

**`HEADCOUNT`.** El peso es **`Σ fteMilli` de los `HeadcountSnapshot` cuyo fin de
mes cae dentro del periodo del run** («FTE·mes», Q-7), y el driver **sólo admite
`targetKind = COST_CENTERS`**, con `CHECK` en la base y validación en la acción.
Para un run mensual hay **un solo snapshot** por receptor, así que es exactamente
el «stock a fin de periodo» que el experto decidió en E5 y **el fixture no se
mueve**; para `QUARTER` y `YEAR` deja de ser falso: un CECO que vive de febrero a
noviembre tenía **peso 0** en el run anual —stock a 31-12— y no absorbía nada de
sus diez meses vivos, trasladando esa estructura a los demás. Sin media, sin
división y sin redondeo. Repartir por plantilla a **proyectos** exigiría derivar el
FTE de las horas, que es el driver `HOURS` con otro nombre y un rodeo: el mismo
dato, dos veces, con dos resultados posibles.

**El cuarto sello, y su ventana.** `AllocationRun` gana
**`timeHash varchar(64) NOT NULL DEFAULT '∅'`** más
**`timeHashWindowStart`/`timeHashWindowEnd`**:

```
W        = ventana efectiva del run
           YTD          ⇒ [inicio del ejercicio, periodEnd]
           PRIOR_PERIOD ⇒ [inicio del periodo anterior, periodEnd]
           resto        ⇒ [periodStart, periodEnd]
timeHash = sha256( join("\n", entradas APROBADAS con date ∈ W,
                        ordenadas por (fecha, códigoEmpleado, códigoReceptor, minutos, productiva),
                        en la forma  fecha|códigoEmpleado|códigoReceptor|minutos|productiva) )
         = "∅"  cuando ninguna regla del run usa un driver de actividad
```

y la derivación de `STALE` (ADR-0013 D5, que sigue siendo **derivada y jamás
almacenada**) gana su **cuarta causa**: *el `timeHash` recomputado sobre la
ventana persistida difiere del sellado*.

**Por qué la ventana, y no sólo el hash** (O-E10-1, bloqueante). Con el sello
acotado al periodo, un run de **marzo** con `zeroBaseFallback = YTD` reparte usando
partes de **enero**; aprobar en mayo un parte de enero de 800 minutos **no cambiaba
el `timeHash` de marzo**, el run **no aparecía `STALE`** y lucía vigente con un
reparto que ya no se puede reproducir — literalmente el fallo que esta decisión
existe para cerrar. La ventana se **persiste** además de recomputarse para que la
comprobación de staleness no dependa de releer unas reglas que también cambian.
Lo comprueba **I-E10-17**.

**La forma canónica es UNA** (O-E10-3): `fecha|códigoEmpleado|códigoReceptor|
minutos|productiva`, **sin `id`**. La ronda 0 la definía dos veces y una de ellas
incluía el `id` —un uuid aleatorio—, con lo que el hash de un fixture recargado
nunca habría coincidido y la reproducibilidad byte a byte se caía sola.

**Cómo se cumple ADR-0013 D4 sin el `CHECK`.** La garantía «ninguna regla inerte»
se traslada, íntegra, a **tres** puntos con test propio:

1. **Al guardar la regla**: con `HOURS` o `HEADCOUNT`, la organización debe tener
   `timeTrackingEnabled = true` **y** al menos un dato de la clase que el driver
   consume en el ejercicio de `validFrom`. Si no, `DRIVER_UNAVAILABLE` con un
   texto que dice **qué falta y dónde darlo de alta**, no un «no disponible» mudo.
2. **Al simular y al sellar con base cero**: la regla emite `W-E10-NO-HOURS`,
   `W-E10-NO-HEADCOUNT` o `W-E10-UNAPPROVED-HOURS`, y el saldo del CECO queda
   **visible** en «pendiente de liquidar» con su motivo (mecanismo de E5 §3.3).
3. **Y con base PARCIAL** (O-E10-2, bloqueante). La ronda 0 sólo avisaba con base
   0, y el caso peligroso es el otro: con base aprobada 36 000 minutos y 12 000
   sin firmar de un receptor, el reparto de 900 000 c sale 480 000 / 270 000 /
   150 000 cuando con la base completa habría sido 360 000 / 202 500 / 337 500 —
   **187 500 c de diferencia**, publicados en silencio. `W-E10-UNAPPROVED-HOURS`
   se emite **siempre que existan minutos sin aprobar** de receptores elegibles en
   la ventana, con el importe y su **% sobre la base**, y **mueve el sello del
   propio `AllocationRun`** con `HORAS_SIN_APROBAR`.

Y un aviso más, **`W-E10-HEADCOUNT-TRAPPED`** (O-E10-16): una regla `HEADCOUNT`
que reparte a CECOs sin regla vigente propia deja el saldo atrapado un nivel más
abajo; I5.b lo detecta tarde y sin decir por qué.

**Lo que NO cambia**, y es la mitad del valor de esta decisión: `hamilton()`, el
grafo de cascada, `findCycle`, `checkTopologicalOrder`, `liquidableBase`, el orden
de ejecución de ocho pasos, **E5-D1 (el nivel de margen viaja con el importe)**,
`sourceShareBps`, los dos Hamilton anidados, el desempate por **menor código** y
la forma canónica de la salida. El test byte a byte contra
`liquidacion-esperada.json` sigue en verde **sin tocar el fixture**.

### D2 — Presupuesto versionado, sellado e inmutable; signo forzado; O-A6 cerrada

**Identidad y vigencia.** Una versión es `(organización, ejercicio, escenario,
revisión)`, con `escenario ∈ {BASE, REVISADO}` y `revisión` 0 para la `BASE` y
1..n para las sucesivas. Cada versión lleva **vigencia** (`validFrom`/`validTo`) y
un `EXCLUDE USING gist` impide que dos versiones no `BORRADOR` se solapen.

**Y sin huecos** (O-E10-8). El `EXCLUDE` impedía el solape pero no el hueco:
sellar `2026-REV1` con `validFrom = 01-08` dejando la `BASE` en `validTo = 30-06`
dejaba **julio sin versión vigente**, y un informe de julio salía con la columna
vacía y `PRESUPUESTO_AUSENTE` **teniendo presupuesto**. `sealBudget` cierra la
versión anterior con `validTo = validFrom(nueva) − 1 día` **en la misma
transacción**, e **I-E10-15** exige que la unión de vigencias cubra el ejercicio
entero.

**Y sin versiones a medias** (O-E10-9). Una `REVISADO` que sólo trae julio-diciembre
dejaba la suma anual **a la mitad** sin que nada lo dijera. Toda versión no
`BORRADOR` cubre **los doce meses** o declara **`partialFrom`**; el informe
**compone** BASE(ene–jun) + REVISADO(jul–dic) y publica **de qué versión sale cada
mes**, igual que `provenanceByMonth` hace con el forecast (**I-E10-16**).

**Sello e inmutabilidad.** Al sellar se escriben `budgetHash`, `marginConfigHash`
y `gitSha`, y la versión pasa a `VIGENTE`:

```
budgetHash = sha256( cabecera(ejercicio, escenario, revisión, vigencia, partialFrom)
                     ‖ líneas de importe en forma canónica, CON su marginLevel
                     ‖ líneas de horas en forma canónica, en minutos
                     ‖ marginConfigHash )
```

**El `marginLevel` va congelado en cada línea** (O-E10-7), exactamente como
`AllocationLine.marginLevel` desde E5-D1 y por la misma razón: con
`INDIRECTO_CECO` el nivel lo pone `CostCenter.marginLevel`, que **no está cubierto
por `marginConfigHash`**, así que mover un CECO de MC3 a EBITDA después de sellar
leería el mismo presupuesto sellado en otra fila **sin cambiar el hash**, y la
desviación de MC3 se movería sola.

A partir del sellado la versión es inmutable (triggers) y **I-E10-6** recomputa el
hash sobre lo que la fila tiene hoy. Una versión sellada **no se retira ni se
corrige: se sustituye**, y el diff entre las dos es la información útil — la misma
doctrina de `ReportRun` (ADR-0012) y de `AllocationRun` (ADR-0013 D5).

**Convención de signo, y ahora también su validación** (O-E10-6, bloqueante).
`BudgetLine.amountCents` es el **aporte**, `haber − debe`: ingreso positivo, gasto
negativo — R-P1 de ADR-0012 y la convención de la matriz de E4, de modo que
`desviación = real − presupuesto` no lleva **ni una** conversión de signo. Pero en
la ronda 0 la convención **sólo existía en la documentación**: un `6400` tecleado
como `+1 200 000` contra un real de `−1 200 000` daba **−2 400 000 c de desviación
con ejecución exacta**, el doble del importe y con signo de «hemos gastado de
más». Se añade:

- **`analyticType` obligatorio en toda línea** (**O-E10-23**, `NOT NULL` +
  `CHECK budget_lines_type_required`). La ronda 1 sólo lo exigía cuando faltaba la
  cuenta, y ése era el hueco que dejaba el arreglo a medias: con el tipo nulo, la
  primera rama del CHECK de signo lo deja pasar, de modo que **la comprobación se
  saltaba a sí misma** y el `6400` en positivo volvía a entrar; y además la celda
  no tenía nivel de margen que congelar. El tipo lo resuelve
  `resolveEffectiveAnalyticType` al guardar —la misma función del diario—, así que
  exigirlo no cuesta un clic;
- **validación determinista por tipo analítico efectivo** al guardar la celda, y
  **CHECK de refuerzo** en la base: `INGRESO_DIRECTO ≥ 0`; `COSTE_DIRECTO_MC1`,
  `COSTE_DIRECTO_MC2`, `INDIRECTO_CECO` y `AMORTIZACION_DETERIORO ≤ 0`;
  `FINANCIERO`, `EXTRAORDINARIO` y `NO_ANALITICO` sin restricción;
- **tres excepciones admitidas con aviso, no con bloqueo** y marcadas
  (`signException`): `61x`/`71x`, `706`/`708`/`709` y `79x`/`759`, que
  **I-E10-14** lista en su evidencia;
- **rechazo del fichero CSV completo** cuando más del **90 %** de las líneas de
  cuentas del grupo 6 vienen en positivo: es el síntoma inequívoco de una hoja con
  la convención contraria, y aceptarla a medias es peor que rechazarla.

**Reutilización, no reimplementación.** La matriz de presupuesto se construye con
**las mismas funciones** que la del real (`resolveEffectiveAnalyticType`,
`resolveLevel`, `resolveColumn`). Reimplementarlas sería garantizar que las dos
matrices divergen el día que alguien toque una regla de destino.

**O-A6, cerrada aquí y con SQL.** El `CHECK` de exclusividad
`((project_id IS NULL) <> (cost_center_id IS NULL))` y los **cuatro índices únicos
PARCIALES** —proyecto+cuenta, proyecto sin cuenta, CECO+cuenta, CECO sin cuenta—
entran en la migración que crea `budgets`. Un `@@unique` con columnas nullables no
sirve: `NULL <> NULL`, y el duplicado entra. **Una deuda sólo se marca cerrada
cuando hay SQL que la cierra**, que es la lección literal del hallazgo #6 de la
revisión de E5. La misma disciplina se aplica a `budget_hours_lines` (O-E10-10):
FK compuestas por tenant, CHECK de día 1, trigger de mes dentro del ejercicio y
**índices parciales** en vez del `COALESCE` de la ronda 0.

### D3 — Coste-hora: base explícita, absorción plena, vigencias sin solape, derivación como propuesta

`EmployeeRate` guarda **céntimos por hora enteros** con vigencias sin solape
(`EXCLUDE USING gist`, patrón `TaxRate`) y una **`basis` obligatoria**:

| `basis` | Cuentas | Uso |
|---|---|---|
| `BRUTO_SIN_SS` | `640` | Negociación salarial. **Nunca** para margen por hora |
| **`COSTE_EMPRESA_CON_SS`** *(default)* | `640` + `642` + `645` + `649` | Margen por hora, tarifa de recuperación, coste de proyecto |
| `COSTE_TOTAL_CON_ESTRUCTURA` | lo anterior + estructura | **Excluyente** con las reglas de actividad (abajo) |

**`641` (indemnizaciones) queda fuera** (O-E10-11): es un coste no recurrente y
ligado a personas que dejan de generar horas, así que incluirlo dispara la tarifa
del último periodo del empleado y contamina el margen de los proyectos que
casualmente tocó ese mes. Va a G&A y se presupuesta como línea propia. La
diferencia entre `BRUTO_SIN_SS` y `COSTE_EMPRESA_CON_SS` es del orden del **31,9 %**
(4 000 000 c y 5 276 000 c sobre 1 500 h: **2 666** frente a **3 517 c/h**), así que
la `basis` **viaja con la cifra** y se muestra siempre junto a ella, también en el
export; y un KPI que agregue receptores con `basis` distinta sale **no evaluable**
con las bases en conflicto (O-E10-15), nunca sumado.

**Modelo de absorción: A, y escrito** (Q-3 / O-E10-14). El denominador son las
horas **productivas**, luego **la tarifa ya absorbe** el coste de las no
productivas y ese coste **no se vuelve a repartir**. La ronda 0 mezclaba las dos
mitades de dos modelos incompatibles («fuera del denominador… con el coste en el
CECO del empleado»), y eso es un **doble cómputo**: con 1 800 h pagadas y 1 500
productivas, valorar las productivas da ≈ la nómina entera (5 275 500 c) y repartir
además las 300 no productivas añade 1 055 100 c ⇒ **+20 % sobre la nómina** e
**I-E10-12 en FAIL todos los meses**. Queda escrito: **la tarifa es una unidad de
medida para KPI, no una segunda vía de imputación**; quien reparte es la regla
`HOURS` sobre el **saldo real del CECO**, que ya contiene la nómina íntegra. Por lo
mismo, `COSTE_TOTAL_CON_ESTRUCTURA` es **excluyente** con la existencia de reglas
de actividad vigentes (`RATE_BASIS_CONFLICT`), con aviso permanente en el informe.

**Aplicación de la tarifa y su Hamilton** (O-E10-13). Se aplica la tarifa vigente
**el día de cada parte**, no la de fin de periodo. Y el reparto del truncamiento se
define, porque sin definirlo dos implementaciones dan cifras distintas: con partes
`i` de `mᵢ` minutos y tarifa `rᵢ`,

```
T = ⌊ Σ (mᵢ · rᵢ) / 60 ⌋      y T se reparte entre los partes por MAYOR RESTO
                              sobre los pesos mᵢ·rᵢ, con empate a favor del parte
                              de menor (fecha, código de empleado, id)
```

—el mismo desempate determinista de ADR-0013 D5—. **Sin tarifa vigente para un
parte, la cifra es «no evaluable»**, con el empleado y la fecha nombrados: jamás 0
ni la tarifa anterior. Y **mueve el sello** (`TARIFA_AUSENTE`): un margen por hora
calculado con partes sin tarifa no es un margen.

**La derivación desde la nómina es una propuesta, no una aplicación**:

```
hourlyCostCents = ⌊ payrollCents × 60 / productiveMinutes ⌋
```

y **con un ámbito declarado** (O-E10-12), porque `JournalLine` no tiene
`employeeId` y la nómina se contabiliza normalmente por CECO, no por persona — con
el diseño de la ronda 0 la función **no tenía fuente**:

- **`scope = "COST_CENTER"` (default)**: tarifa media del CECO, aplicable a los
  empleados sin tarifa propia. Honesto y suficiente para gestión.
- **`scope = "EMPLOYEE"`**: sólo si las líneas `64x` llevan el `counterpartyId` del
  empleado, y la propuesta **declara su cobertura** («8 de 34 líneas, 78 % del
  importe»), quedando **no evaluable** por debajo del umbral configurado. Nunca
  extrapola en silencio.

Con 0 minutos productivos o sin nómina, **no evaluable**, nunca ∞ ni 0. Se guardan
**los términos** en `EmployeeRate.derivation` para que el número se pueda rehacer a
mano, y aplicar la propuesta es un acto de un **ADMIN** con `AuditLog`.

### D4 — Forecast derivado; y presupuesto y real, siempre en el mismo estado de imputación

**El forecast no se persiste.**

```
forecast(m) = real(m)         si m ≤ cutoff   (mes cerrado)
            = presupuesto(m)  si m >  cutoff  (mes abierto)
```

`cutoff` es el **último mes cerrado**, lo decide el borde y viaja como **parámetro**
dentro de `paramsHash`; las dos mitades quedan selladas por `ledgerHash` y
`budgetHash`. Guardarlo crearía una tercera verdad que puede diverger de las otras
dos a la vez y obligaría a un proceso que la mantuviera al día en cada asiento
(ADR-0003, P2). **I-E10-7** exige que cada mes aparezca **exactamente una vez y con
una sola procedencia**: ni solape —un mes contado dos veces infla el año— ni hueco.
Una reproyección con cifras **distintas** de las presupuestadas no es un forecast:
es una **versión `REVISADO n`**, que sí se persiste porque es una decisión.

**Y la comparabilidad, que es el bloqueante de fondo** (O-E10-4). El presupuesto se
teclea sobre proyectos y CECOs; el real con `withAllocations = true` ya ha
trasladado el saldo de los CECOs a las columnas de proyecto. **Por debajo de MC2
las dos matrices no miden lo mismo**: con `CC-OPS` presupuestado y ejecutado en
900 000 c exactos y las horas exactamente previstas, P-01 recibe 400 000 c en el
real y 0 en el presupuesto, y el informe publicaba **−400 000 c de desviación de
MC3 en P-01 con ejecución perfecta** — mientras el total compañía cuadraba, que es
lo que hace que nadie lo detecte.

- **Corrección**: `buildBudgetMatrix` pasa por una **liquidación presupuestaria en
  dry-run puro** —las mismas `AllocationRule` vigentes, el mismo `allocate()`, y
  los drivers de actividad alimentados por las **horas presupuestadas**
  (`BudgetHoursLine`, que para eso existen y hasta ahora no alimentaban nada)—.
  **No se persiste**: no es un `AllocationRun`, no ocupa el índice único de periodo
  y no caduca informes; el `rulesHash` usado viaja en `params` del `ReportRun`.
- **Degradación honesta**: si el presupuesto **no puede seguir** al real, las
  celdas **por dimensión** de nivel ≥ MC3 salen **no publicadas** con su motivo
  —INGRESOS, MC1 y MC2 sí, y el total compañía también, porque ahí la imputación es
  de suma cero (E5-D1)— y **el toggle se bloquea**. En ningún caso una matriz
  mixta. Lo comprueba **I-E10-18**.

### D5 — Umbrales de desviación, seis reglas EV y cinco motivos de sello

`Organization.reviewThresholds` gana **cuatro** KPI —`desviacionIngresos`,
`desviacionEbitda`, `desviacionMc3` y **`desviacionMaxDimension`**— con la misma
forma que los siete de ADR-0012: `pctBps` **y** `minAbsCents`, y disparan sólo si
**superan los dos**. Editables únicamente por ADMIN, con `AuditLog`, y en
configuración versionada.

**El cuarto es de la ronda 1** (O-E10-18): los tres primeros son «total compañía»,
y dos desviaciones grandes de signo contrario **se anulan** —MC3 de P-01 a
−1 500 000 c y de P-02 a +1 500 000 c dan 0 c y 0 bps—, con lo que el informe se
firmaba **`VALIDADO AUTOMÁTICAMENTE` con dos proyectos fuera de control**.
`desviacionMaxDimension` evalúa `max |desviación|` **por dimensión** en INGRESOS,
MC2 y MC3, con coste marginal nulo: la matriz ya está calculada.

Reglas de la familia `EV-*`, funciones puras con test:

- **EV-11 · dispara siempre**: `budgetHash` distinto del del run anterior. Cambiar
  de versión **redefine la medida**; presentarlo como variación escondería una
  reproyección detrás de un «dentro de umbral». Mismo criterio que EV-7.
- **EV-12 · no dispara por variación, pero mueve el sello**: no hay versión vigente
  para el periodo ⇒ columna **vacía con leyenda** —nunca 0— y `PRESUPUESTO_AUSENTE`.
- **EV-13 · no dispara**: el periodo contiene meses **no cerrados**; la desviación
  es parcial por construcción y lo que informa ahí es el forecast.
- **~~EV-14~~ · retirada** (O-E10-5, bloqueante). Presuponía que un `BORRADOR` puede
  emitir un `ReportRun`, y **el esquema lo impide**: `budgets_sealed_marks` obliga a
  `budget_hash IS NULL` mientras el estado es `BORRADOR`, y
  `report_runs_budget_hash_required` exige `budget_hash <> '∅'` para este tipo —no
  hay hash que escribir, la fila no se puede crear—. La ambigüedad se cierra por el
  lado correcto: **un borrador nunca produce un `ReportRun`**, y compararse contra
  él es una **previsualización no sellada** (sin fila, con banda «borrador, no
  firmable»), igual que `previewAllocation` en E5. `PRESUPUESTO_NO_SELLADO` deja de
  ser motivo de sello y pasa a ser **rechazo** `BUDGET_NOT_SEALED`. Es lo que ya
  decía la propia frase de esta decisión: *«un presupuesto sin sellar no puede
  firmar un informe»*.
- **EV-15 · dispara siempre** (O-E10-2/17): hay minutos **sin aprobar** del periodo
  que alguna regla de actividad habría usado ⇒ `HORAS_SIN_APROBAR`.
- **EV-16 · dispara siempre** (O-E10-16): una regla `HEADCOUNT` reparte a un CECO
  **sin snapshot** en el periodo ⇒ `PLANTILLA_AUSENTE`. Un snapshot con
  `fteMilli = 0` **no** dispara: es un dato, no un hueco.
- **EV-17 · dispara siempre**: hay partes **sin tarifa vigente** y el informe
  publica coste-hora o margen por hora ⇒ `TARIFA_AUSENTE`.

`SealReasonCode` gana **`DESVIACION_PRESUPUESTO`**, **`PRESUPUESTO_AUSENTE`**,
**`HORAS_SIN_APROBAR`**, **`PLANTILLA_AUSENTE`** y **`TARIFA_AUSENTE`**, todos de
**código cerrado**. Y **ningún motivo sin regla que lo emita**: es la comprobación
que O-E10-17 exige, con test propio. Un motivo sin regla es decoración, que es la
lección H-4 de E7 que esta decisión invoca.

Y **`ReportRun` gana `budget_hash varchar(64) NOT NULL DEFAULT '∅'` dentro de la
clave de reutilización**: dos `PRESUPUESTO_REAL` del mismo periodo y el mismo
diario con versiones distintas de presupuesto son informes distintos, y sin el hash
en la clave la caché serviría el equivocado. Es el mismo razonamiento de
`paramsHash` (O-5 de E6) y de `allocationRunSetHash` (O-E5-7).

### D6 ✚ — Contrato de cifras congelado antes de T10

`T10` sella `presupuesto-horas-esperado.json`; a partir de ahí, cada uno de estos
siete puntos cuesta un reversionado del fixture. Son los que fija §6 de la
validación, y se firman **ahora** precisamente por eso:

| # | Punto | Valor congelado |
|---|---|---|
| 1 | **Unidad de tiempo** | **Minutos enteros** (`minutes`). Techo diario **1 440** por fila **y por (empleado, día)** (O-E10-21). La centésima de hora queda descartada: la fuente es el `hh:mm` del art. 34.9 ET, y convertirla pierde 0,2 min por parte (≈ 29 h/año con 8 800 partes) |
| 2 | **Coste de un parte** | `⌊ mᵢ · rᵢ / 60 ⌋`, con Hamilton sobre `T = ⌊Σ mᵢrᵢ / 60⌋` y desempate por `(fecha, código de empleado, id)` |
| 3 | **Base de `HOURS`** | Σ minutos **aprobados y productivos**, contra-apuntes con su signo, `max(0, ·)` por receptor, sobre la **ventana efectiva** del run |
| 4 | **Base de `HEADCOUNT`** | Σ `fteMilli` de los snapshots mensuales del periodo (**FTE·mes**); un mes ⇒ un snapshot ⇒ idéntico al stock |
| 5 | **Forma canónica del `timeHash`** | `fecha\|códigoEmpleado\|códigoReceptor\|minutos\|productiva`, **sin `id`** |
| 6 | **`basis` y prefijos** | `COSTE_EMPRESA_CON_SS` = `640`+`642`+`645`+`649`; **`641` excluido**; `BRUTO_SIN_SS` = `640` |
| 7 | **Signo del presupuesto** | **Aporte** (`haber − debe`), con la validación de coherencia de I-E10-14 |

Y **la convención de la descomposición volumen / precio**, que **no se implementa
en E10** pero se fija ahora para que las columnas no cambien de significado cuando
llegue en E11 (Q-6):

```
Δ total   = P_r·Q_r − P_p·Q_p
Δ volumen = ⌊ (Q_r − Q_p) × Importe_ppto / Q_p ⌋      (Q_p = 0 ⇒ todo volumen)
Δ precio  = Δ total − Δ volumen                        ← RESIDUO ⇒ Σ exacta
```

**El cruce va al precio**: el efecto volumen se mide a condiciones del plan —lo
único que controla producción— y el efecto precio sobre la actividad realmente
ejecutada. Un tercer término «cruce» es matemáticamente honesto e **inservible en
un comité**: nadie tiene responsabilidad sobre él. El precio unitario **no se
almacena** y `importe / horas` no es exacto, de ahí que el precio sea el residuo y
la suma cuadre con tolerancia 0. **No se descompone el efecto mezcla**: exige una
jerarquía de producto que el modelo no tiene, y mejor no publicarlo que publicarlo
mal.

**El fixture no recorre sólo el camino feliz.** T10 y T20 incluyen, por exigencia
de §6 de la validación: un mes con horas aprobadas y sin aprobar mezcladas, un
empleado sin tarifa vigente durante dos semanas, un CECO que nace en febrero y
muere en noviembre, una `REVISADO` que sólo cubre el segundo semestre, y una línea
de presupuesto de gasto en positivo que el importador rechaza.

---

### D7 ✚ — El borrado de operador de un parte APROBADO, por GUC registrado y verificado

> **Nota fechada de la ronda 1 — aprobada por Pablo el 2026-09-15** (permiso
> general delegado de 2026-09-04). **Nivel 2**: toca una regla de inmutabilidad.
> Este ADR pasa de seis decisiones a **siete**. No enmienda D1–D6.

**El problema (QA, BUG-E10-2).** D1 y R-H-1 hacen INMUTABLE un `TimeEntry`
`APROBADO`: no se edita y no se borra, se **contra-apunta** (I-E10-4). El trigger
`assert_time_entry_not_deleted_when_approved` lo aplicaba **sin excepción, ni
siquiera a `app_maintenance`**, y eso rompió una operación legítima que no es de
la aplicación: `scripts/load-fixture.ts --reset-org`, el vaciado de operador que
las suites e2e ejecutan entre ficheros. El resultado no era «más seguridad»: era
una organización de pruebas que no se podía vaciar y partes de un `.spec` que
contaminaban al siguiente.

**La decisión.** Se abre **una sola** salida, con la forma que E9 ya fijó para la
reapertura registrada (`app.reopening_run_id`, migración
`20260923090000_e9_reapertura_guc_verificado`): un **GUC de transacción
verificado**, no una bandera que baste con fijar.

```
app.maintenance_reset_org  →  uuid de la organización que se está vaciando
```

El trigger sólo deja pasar el `DELETE` de un parte `APROBADO` cuando se cumplen
**las dos** condiciones a la vez:

1. `app.maintenance_reset_org()` es **exactamente la `organization_id` de la
   fila** —el GUC de otro tenant no abre nada—, y
2. `app.is_maintenance_operator()`, es decir el rol de la sesión es miembro de
   `app_maintenance`.

La segunda es la que hace que esto **no sea un agujero en el producto**: por
ADR-0009 §6 y `CLAUDE.md`, `DATABASE_URL` conecta con `app_runtime` y **la
aplicación nunca conecta con `app_maintenance`**. Un GUC inventado desde una
server action —o desde SQL con el rol de la aplicación— sigue chocando con el
trigger. Y `SET LOCAL` muere con la transacción, así que la excepción dura lo que
dura el vaciado.

**Por qué no las alternativas.** *Quitar el trigger y confiar en la política RLS*:
`app_maintenance` tiene `BYPASSRLS`, así que no quedaría barrera ninguna.
*Permitirlo a `app_maintenance` sin GUC*: el rol existe para todos los scripts de
operador, no sólo para el vaciado, y un borrado accidental de partes aprobados en
una organización viva no dejaría rastro de intención. *No borrar y truncar la
base entre ficheros e2e*: el vaciado es **por organización** y la base la
comparten varias.

**Lo que NO cambia.** El camino del producto sigue siendo el contra-apunte, con
su motivo de ≥ 10 caracteres y su trigger espejo (§3.5). `UPDATE` de un parte
aprobado sigue prohibido **sin excepción alguna**, también para
`app_maintenance`: corregir no es vaciar. I-E10-4 sigue vigilando la inmutabilidad
sobre los datos.

Migración: `20260925090000_e10_ronda1_signo_y_reset`. Tests:
`tests/integration/e10-ronda1.test.ts` (sin GUC ni `app_maintenance` puede; con
el GUC de otra organización, tampoco; con el de la suya y desde el rol de
operador, sí; y fuera de la transacción el GUC vuelve a ser `NULL`).

---

## Alternativas descartadas

- **Retirar el `CHECK` de `HOURS`/`HEADCOUNT` y nada más.** Es lo que ADR-0013 D4
  prohíbe con nombre y apellidos: una regla vigente que reparte 0 € es
  indistinguible de una organización que decidió no repartir. Retirar el `CHECK`
  sin trasladar la garantía sería cumplir la letra de D4 y romper su motivo.
- **Sellar el run sin `timeHash`.** El run sería irreproducible en cuanto alguien
  aprobara un parte tardío, y `STALE` —que existe precisamente para eso— no lo
  vería. Es el mismo agujero que O-E5-7 cerró con el conjunto de runs, una capa
  más abajo.
- **Sellar el `timeHash` sobre el periodo del run** (lo que decía la ronda 0).
  Con `zeroBaseFallback = YTD` el driver consume partes de **todo el ejercicio**,
  así que el sello no cubre su propia base y el run envejece en silencio
  (O-E10-1). La ventana efectiva, **persistida**, es la corrección mínima.
- **Avisar de las horas sin aprobar sólo cuando la base es cero.** El caso
  frecuente y peligroso es el **parcial**: se reparte sobre el 75 % de la
  actividad y el informe no lo dice (O-E10-2).
- **Incluir el `id` en la forma canónica del `timeHash`.** Es un uuid aleatorio:
  el hash de un fixture recargado no coincidiría nunca y la reproducibilidad byte
  a byte se caería sola (O-E10-3).
- **`STALE` almacenado** «ahora que hay una causa más». Sigue exigiendo un
  `UPDATE` sobre una tabla append-only y un proceso que lo mantenga; derivarlo de
  los cuatro sellos es exacto en todo momento y no escribe nada (ADR-0013 D5).
- **`HEADCOUNT` repartiendo a proyectos**, derivando el FTE de las horas
  aprobadas. Es el driver `HOURS` con otro nombre: el mismo dato, dos veces, con
  dos resultados posibles y ninguna forma de saber cuál manda.
- **`HEADCOUNT_AVG` (media del periodo) como parámetro** del driver `HEADCOUNT`.
  Es un **driver distinto**, no un parámetro; el experto ya lo dijo en E5. Si se
  quiere, se añade como valor nuevo del enum con su ADR. **FTE·mes no es una
  media**: es una suma entera, sin división y sin redondeo.
- **Stock a 31-12 también en los runs anuales** (lo que decía la ronda 0). Un CECO
  que vive de febrero a noviembre tendría peso 0 y no absorbería nada de sus diez
  meses vivos (Q-7).
- **Horas en centésimas de hora**, que es lo que proponía la ronda 0 apartándose
  del contrato de E5. **Descartada por Q-2**: la fuente primaria es el registro de
  jornada del art. 34.9 ET, que se lleva en `hh:mm`, y todo `hh:mm` es un entero
  exacto de minutos mientras que en centésimas no lo es. Los dos argumentos de la
  ronda 0 no se sostenían: la centésima es unidad de **presentación** (1,25 h), no
  del dato de origen, y el truncamiento no se evita —`⌊h·r/100⌋` trunca igual que
  `⌊m·r/60⌋`, y en los dos casos lo compensa el mismo Hamilton—. **Segundos
  enteros** se consideró como refinamiento y se descarta por no aportar nada sobre
  el minuto en este dominio.
- **Horas en `Decimal` o `Float`.** Misma razón que el céntimo (ADR-0006): una
  suma de 120 000 partes en coma flotante no es reproducible byte a byte y P7 deja
  de valer.
- **`Forecast` como tabla.** Una tercera verdad que puede diverger de las otras
  dos a la vez, y un proceso de mantenimiento que puede quedarse atrás. Es
  exactamente lo que ADR-0003 prohíbe con las cifras de informe.
- **Desviación almacenada** para que el informe vaya rápido. Es almacenar una
  resta. Si va lenta, se indexa el minuendo.
- **`amountCents` con el signo natural del gasto** (gasto positivo). Obliga a una
  conversión de signo en cada comparación con la matriz de E4 y deja dos
  convenciones de signo en el mismo producto, que es la fábrica de errores de
  signo que R-B1/R-P1 existen para cerrar.
- **`@@unique(budget_id, month, account_code, project_id, cost_center_id)`** en
  lugar de los cuatro índices parciales. Es literalmente O-A6: con `NULL <>
  NULL`, dos filas con la cuenta o el CECO nulos **no colisionan** y el duplicado
  entra. Se descartó ya en E4, se volvió a descartar en E5 y aquí se cierra.
- **Un `ReportType` nuevo por escenario** (`PRESUPUESTO_BASE`,
  `PRESUPUESTO_REVISADO`). Son parámetros; para eso están `paramsHash` y
  `budgetHash`. Misma lección que la foto del balance en ADR-0012.
- **Recomponer `analytics_key` para meter `budgetHash` dentro.** Cambiaría la
  clave de **todos** los `ReportRun` ya emitidos y los invalidaría en bloque por
  un componente que sólo interesa a un tipo de informe. Una columna nueva en el
  índice no toca nada de lo ya emitido.
- **Permitir editar una versión sellada «sólo un poco».** Destruye P3/P7: la foto
  dejaría de ser una foto. Se crea una revisión.
- **Dejar la convención de signo sólo en la documentación.** Un `6400` en positivo
  duplica la desviación con ejecución exacta y **nada lo detecta** (O-E10-6).
- **Admitir líneas de presupuesto sin `analyticType`** cuando llevan cuenta. El
  CHECK de signo tiene una rama que las deja pasar, así que la validación se
  saltaría a sí misma justo en el caso más común (O-E10-23).
- **Aceptar a medias un CSV con la convención de signo invertida.** Deja un
  presupuesto medio correcto, que es peor que ninguno: se rechaza el fichero.
- **Dejar el nivel de margen fuera de la línea de presupuesto**, confiando en
  `marginConfigHash`. No cubre `CostCenter.marginLevel`: el presupuesto sellado se
  leería en otra fila sin cambiar el hash (O-E10-7). Es E5-D1 otra vez.
- **Publicar la desviación por dimensión en MC3 con el presupuesto sin imputar.**
  Es el bloqueante O-E10-4: cifras que no miden lo mismo, con el total cuadrando.
  La salida «no publicar esas celdas» se conserva **sólo como degradación**.
- **Mantener `EV-14`.** Es inalcanzable: el esquema impide que un borrador emita
  un `ReportRun` (O-E10-5). Un motivo de sello que no puede dispararse nunca es
  peor que no tenerlo.
- **Umbrales sólo a total compañía.** Dos desviaciones de signo contrario se
  anulan y el informe se firma en verde con dos proyectos descontrolados
  (O-E10-18).
- **Denominador de 1 700 h** como «horas productivas». Es **jornada anual**, no
  horas productivas: infravalora la tarifa ~12 % (O-E10-19).
- **Tarifa con estructura incluida conviviendo con el driver `HOURS`.** Carga la
  estructura dos veces (O-E10-14).
- **Denominador de horas productivas y, además, repartir el coste de las no
  productivas.** Es el doble cómputo de Q-3: +20 % sobre la nómina e I-E10-12 en
  FAIL todos los meses.
- **`proposeHourlyCost` por empleado sin declarar su cobertura.** Extrapolaría en
  silencio desde una fracción de la nómina (O-E10-12).
- **`concentrationBps` parametrizable** en la reclasificación de personal: con
  8000, una línea consumida al 80 % se reasigna entera y el MC2 del proyecto se
  lleva importe ajeno (O-E10-22).
- **Endurecer I-E10-12 a igualdad** en lugar de publicar la absorción. La igualdad
  sólo se da con horas y tarifas perfectas; lo que faltaba era una cifra en el
  informe (O-E10-20).
- **Un tercer término «cruce»** en la descomposición volumen/precio, o
  **descomponer el efecto mezcla** (Q-6): el primero no tiene dueño, el segundo
  exige una jerarquía de producto que el modelo no tiene.
- **Aplicar automáticamente el coste-hora derivado de la nómina.** Convierte una
  estimación de controlling en un dato del sistema sin que nadie la firme.
- **Partir una `JournalLine` de 64x entre varios proyectos** para imputar
  personal. Prohibido por ADR-0003 y por la salvaguarda 1 de ADR-0010 (sólo
  cambian las cuatro columnas analíticas). Ese caso es exactamente para lo que
  existe el driver `HOURS`.
- **Un asiento de traspaso analítico 64x → 64x por dimensión.** No es un hecho
  económico (NRV 14ª), contaminaría el diario, obligaría a un flag de exclusión de
  informes —prohibido por `CLAUDE.md`— y ya lo descartaron ADR-0004 y ADR-0013.

---

## Consecuencias

La liquidación gana sus **dos últimos drivers** sin tocar una línea del núcleo
—Hamilton, cascada, E5-D1, determinismo y forma canónica quedan intactos, y el
fixture `liquidacion-esperada.json` no se reversiona—, y gana además el **cuarto
sello** que le faltaba para que un reparto por actividad sea tan reproducible como
uno por ingresos. El presupuesto entra en el producto como lo que es —una
**decisión** versionada, fechada, sellada e inmutable—, se lee en **la misma
matriz** que el real con **las mismas funciones**, y la desviación es una resta
exacta con tolerancia 0. El forecast no crea una cifra nueva que mantener.

A cambio:

- **Siete tablas nuevas** (`budgets`, `budget_lines`, `budget_hours_lines`,
  `time_entries`, `employees`, `employee_rates`, `headcount_snapshots`), **cuatro
  columnas** en tablas del motor (`allocation_runs.time_hash` **+ su ventana** y
  `report_runs.budget_hash`) y **cinco** en `Organization`.
- **La clave de reutilización de `ReportRun` pasa de ocho a nueve componentes.**
  Las filas existentes quedan con `'∅'` y su clave **no cambia** (sólo se le añade
  un componente constante), así que ningún informe cacheado se invalida por la
  migración.
- **`Project.budgetRevenueCents` / `budgetCostCents` se deprecan**: pasan a
  derivarse de la versión vigente y la ficha deja de admitir su edición, con un
  WARN de calidad de datos mientras difieran. Dos verdades para la misma cifra no
  sobreviven a este ADR.
- **La obligación permanente** de que la matriz de presupuesto y la del real usen
  las mismas funciones de nivel y de columna. Un cambio que lo viole tumba el test
  byte a byte contra `presupuesto-horas-esperado.json` antes de llegar a revisión.
- **La unidad del tiempo queda fijada en minutos enteros** y sellada en un
  fixture, junto con los otros seis puntos de **D6**: cambiar cualquiera de ellos
  después obliga a reversionarlo. Por eso T10 no arranca hasta que el ADR esté
  firmado.
- **El coste-hora deja de ser un número suelto**: lleva `basis`, y `basis`
  condiciona qué se puede agregar y qué reglas de reparto pueden coexistir con
  ella. Es una restricción real de producto, y es la que impide medir dos
  proyectos con magnitudes distintas.
- **El informe de presupuesto vs. real no publica siempre todas sus celdas.** Con
  el presupuesto incapaz de seguir al real en la imputación, las de nivel ≥ MC3
  por dimensión salen en blanco con su motivo. Es peor producto que una matriz
  llena y **es la única forma de que no mienta**.
- **La ronda 1 añade 108 h al plan** (470 → 578) y una dependencia nueva entre
  tareas: la liquidación presupuestaria (T8) necesita los drivers encendidos (T9).
  El calendario en tres olas pasa de ≈ 226 h a ≈ 264 h.
- `docs/MODELO-DATOS.md` §Analítica queda actualizado con `Budget`, `TimeEntry`,
  `EmployeeRate`, `Employee` y `HeadcountSnapshot` en su forma final, y **O-A6
  pasa por fin a CERRADA, con el SQL que la cierra a la vista** — abierta desde
  E4, mal declarada cerrada en E5 y reabierta con fecha en la ronda 1 de su
  revisión.
- `TargetKind.MIXED` y `AllocationRunStatus.DRAFT`, contratos sin uso desde E5, se
  **retiran** de los enums en la misma épica, con una migración que aborta si
  alguna fila los usa.

**Firmado el 2026-09-14**, así que E10 entra completa: los drivers, el
presupuesto, el coste-hora, el forecast, los umbrales y el contrato de cifras de
D6 quedan desbloqueados, y `/sprint E10` puede arrancar por las tres olas de §14
del diseño. Lo que sigue sin poder empezar hasta que el fixture esté sellado (T10)
es cualquier cambio de los siete puntos de D6: a partir de ahí cada uno cuesta un
reversionado.
