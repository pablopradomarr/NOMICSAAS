# E10 — Validación de control de gestión: presupuesto, horas, coste-hora, drivers de actividad, forecast y desviaciones

> Rol: `experto-contable`, con **sombrero de controller / CFO**.
> Fuentes: `.claude/agents/experto-contable.md` · `.claude/skills/contabilidad-analitica/SKILL.md`
> (dimensiones, niveles de margen, drivers) · `.claude/skills/fiabilidad/SKILL.md`
> (**I1–I10**, definición única de I4 e I5, sello del entregable) ·
> `.claude/skills/pgc-npgc/SKILL.md` · **ADR-0013 (E5, D1–D5)** y
> `docs/design/E5-validacion-liquidacion.md` §1.0–§1.4 (contrato de drivers) ·
> **ADR-0003, 0004, 0006, 0010, 0012, 0016** · objeto de la validación:
> `docs/design/E10-presupuesto-horas.md` (ronda 0) y
> `docs/adr/0018-presupuesto-horas-y-drivers-de-actividad.md` (**PROPUESTO**, D1–D5).
> Norma: **RD 1514/2007** (PGC 2007; NRV 14ª devengo), **RD 602/2016**, **RD 1/2021**,
> **Código de Comercio arts. 25–29** (la contabilidad analítica **no es libro
> obligatorio**), **art. 34.9 ET** (registro diario de jornada).
> **Todas las cifras son ILUSTRATIVAS**, en céntimos enteros, y no proceden de datos reales.
> Este documento **no modifica** el diseño ni el ADR: propone correcciones.
>
> **Nota de nomenclatura.** El diseño (§16, T1) y ADR-0018 (cabecera) remiten a
> `docs/design/E10-validacion-presupuesto.md`. Este entregable se ha escrito con el
> nombre `E10-validacion-controlling.md` por encargo expreso. **O-E10-0 (MENOR):**
> unificar la referencia en los dos documentos antes de la firma; una validación
> contable citada con un nombre que no existe es una referencia rota en un
> documento de Nivel 2.

---

## 0. Veredicto

**CONFORME CON OBSERVACIONES**, con **cinco bloqueantes** que deben resolverse
**antes de firmar ADR-0018** (todas cambian una cifra, un sello o un invariante, y
todas son gratis hoy y caras después de T10, que sella el fixture).

| Decisión | Veredicto | Condición |
|---|---|---|
| **D1** — drivers `HOURS`/`HEADCOUNT`, `timeHash`, garantía de ADR-0013 D4 | **CONFORME CON OBSERVACIONES** | O-E10-1 (ventana del `timeHash`), O-E10-2 (horas sin aprobar **parciales**), O-E10-3 (forma canónica sin `id`), O-E10-16 (`HEADCOUNT` en periodos > mes) |
| **D2** — presupuesto versionado, sellado, signo de aporte, O-A6 | **CONFORME CON OBSERVACIONES** | O-E10-6 (coherencia de signo), O-E10-7 (nivel de margen congelado en la línea), O-E10-8 (hueco de vigencias), O-E10-9 (completitud de la `REVISADO`), O-E10-10 (integridad referencial de `BudgetHoursLine`) |
| **D3** — coste-hora, `basis`, derivación desde 64x | **CONFORME CON OBSERVACIONES** | O-E10-11 (prefijos: fuera `641`), O-E10-12 (no hay nómina por empleado en el diario), O-E10-13 (Hamilton del coste-hora sin especificar), O-E10-14 (`COSTE_TOTAL_CON_ESTRUCTURA` duplica la imputación) |
| **D4** — forecast derivado, nunca tabla | **NO CONFORME en un punto** | **O-E10-4**: presupuesto **sin imputar** contra real **imputado** no es comparable. Es el bloqueante de fondo del informe |
| **D5** — umbrales, `EV-11…14`, motivos de sello | **CONFORME CON OBSERVACIONES** | O-E10-5 (`EV-14` es inalcanzable con el CHECK de M5: contradicción de esquema), O-E10-17 (motivo `HORAS_SIN_APROBAR` sin regla que lo emita), O-E10-18 (umbrales sólo a total compañía) |

**Bloqueantes:** O-E10-1, O-E10-2, O-E10-4, O-E10-5, O-E10-6.

Lo que está **bien y no debe tocarse**: la doctrina de que E10 **no genera ni un
asiento** (§3.7, confirmada en §3 de este documento); el signo **aporte** de
`BudgetLine.amountCents`; la reutilización de `resolveEffectiveAnalyticType` /
`resolveLevel` / `resolveColumn` en lugar de reimplementarlas; el forecast como
vista derivada; el cierre de **O-A6** con cuatro índices **parciales**; la tarifa
**del día del parte**; la derivación de nómina como **propuesta** y no como
aplicación; `HEADCOUNT` restringido a CECOs; y la conjunción `pctBps` **y**
`minAbsCents` en los tres umbrales nuevos.

---

## 1. Respuestas a Q-1 … Q-7

### Q-1 · Coste-hora: ¿con o sin Seguridad Social? ¿Y el default?

**Decisión: `COSTE_EMPRESA_CON_SS` como default del producto**, con
`basis` obligatoria, visible junto a cada cifra derivada y en el export
(el diseño ya lo hace: correcto).

| `basis` | Cuentas PGC que la componen | Uso legítimo |
|---|---|---|
| `BRUTO_SIN_SS` | **640** (Sueldos y salarios) | Sólo negociación salarial y comparación con convenio. **Nunca** para margen por hora |
| **`COSTE_EMPRESA_CON_SS`** *(default)* | **640** + **642** (SS a cargo de la empresa) + **645** (aportación definida, si se usa) + **649** (otros gastos sociales: formación, seguros, guardería) | Margen por hora, tarifa de recuperación, coste de proyecto. Es la magnitud de gestión |
| `COSTE_TOTAL_CON_ESTRUCTURA` | lo anterior + estructura imputada | **Ver O-E10-14: incompatible con el driver `HOURS` en el mismo informe.** Duplica la absorción |

**Fuera del default: `641` (Indemnizaciones).** Es un coste **no recurrente** y
además ligado a personas que dejan de generar horas: incluirlo dispara la tarifa
del último periodo del empleado y contamina el margen de los proyectos que
casualmente tocó ese mes. Va al CECO de G&A y se presupuesta como línea propia.

*Ejemplo ilustrativo (céntimos):* bruto anual 4.000.000 c; SS empresa al 31,9 %
= 1.276.000 c; coste empresa 5.276.000 c; horas productivas 1.500.

- `BRUTO_SIN_SS` = ⌊4.000.000 / 1.500⌋ = **2.666 c/h**
- `COSTE_EMPRESA_CON_SS` = ⌊5.276.000 / 1.500⌋ = **3.517 c/h**

Diferencia **851 c/h (+31,9 %)**. Un proyecto de 1.000 h medido con una y
comparado con otro medido con la otra difiere en **851.000 c** de margen sin que
nada haya pasado. De ahí que la `basis` viaje con la cifra, y de ahí O-E10-15
(prohibir agregar receptores con `basis` distinta).

### Q-2 · Unidad de las horas: centésimas o minutos enteros — **se decide una**

**Decisión: MINUTOS ENTEROS.** Se **confirma el contrato de E5** (§1.1 de
`E5-validacion-liquidacion.md`) y se **retira la divergencia** que ADR-0018
declara en «Alternativas descartadas».

Razón, y es la única que decide: **la fuente primaria del dato es el registro de
jornada del art. 34.9 ET, que se lleva en `hh:mm`**. Todo valor `hh:mm` es un
entero exacto de minutos. En centésimas de hora **no lo es**: un minuto son
5/3 centésimas, entero sólo cuando los minutos son múltiplo de 3.

*Ejemplo ilustrativo:* un parte de fichaje de **7 h 20 min** = 440 min exactos.
En centésimas: 440 / 0,6 = **733,33** → hay que redondear a 733 (= 439,8 min).
Se pierden 0,2 min por parte. Con 40 empleados × 220 partes = 8.800 partes al
año → **1.760 min = 29,33 h** desaparecidas del denominador; valoradas a 3.517
c/h son del orden de **103.000 c** de coste que el sistema no sabe dónde poner, y
un descuadre permanente entre el registro legal de jornada y el denominador del
coste-hora.

Los dos argumentos del diseño a favor de la centésima no se sostienen:

1. *«Es la unidad de los partes reales»* — es la unidad de **presentación** de
   muchas hojas de horas (1,25 h), no la del dato de origen. Y toda entrada en
   décimas o cuartos es exacta en minutos (0,1 h = 6 min; 0,25 h = 15 min).
2. *«Evita un redondeo al multiplicar por un coste-hora en céntimos»* — no lo
   evita: `⌊h × r / 100⌋` trunca igual que `⌊m × r / 60⌋`. En los dos casos el
   truncamiento se compensa con el mismo Hamilton entero (O-E10-13), así que la
   tolerancia 0 no depende de la unidad.

Consecuencias mecánicas del cambio, todas menores **si se hacen antes de T10**:
`hoursCenti → hoursMinutes` en `TimeEntry` y `BudgetHoursLine`;
`time_entries_daily_ceiling` pasa de `BETWEEN -2400 AND 2400` a
`BETWEEN -1440 AND 1440`; el coste pasa a `⌊minutos × hourlyCostCents / 60⌋`;
los KPI de §5.2 pasan de `× 100` a `× 60`;
`Organization.productiveHoursPerYearCenti` → `productiveMinutesPerYear`
(ver O-E10-19 sobre su valor por defecto).

*Alternativa mejor que ambas, por si se prefiere no elegir:* **segundos enteros**
es el refinamiento común (0,01 h = 36 s; 1 min = 60 s) y representa exactamente
las dos fuentes; el techo diario es 86.400 y cabe de sobra en `Int`. Si se toma,
tómese **ahora**, por la misma razón.

### Q-3 · Horas no productivas: fuera del driver y fuera del denominador — pero entonces **su coste no se reparte otra vez**

**Decisión: modelo de absorción plena en la tarifa.**

| Regla | Decisión |
|---|---|
| ¿Entran en el driver `HOURS`? | **No.** Vacaciones, formación, baja y comercial no facturable no consumen estructura de proyecto |
| ¿Entran en el denominador del coste-hora? | **No.** Denominador = horas **productivas** (aprobadas). Es el «coste-hora de recuperación», comparable con la tarifa de venta |
| ¿Su coste se imputa aparte a proyectos? | **NO. Y aquí el diseño se contradice** → **O-E10-14** |

La frase del diseño «*fuera del denominador (…), **con el coste en el CECO del
empleado***» combina las dos mitades de dos modelos incompatibles:

- **Modelo A (el que se adopta):** denominador = horas productivas ⇒ la tarifa
  **ya absorbe** el coste de las horas no productivas. El coste de esas horas
  **no vuelve a repartirse**.
- **Modelo B:** denominador = horas pagadas ⇒ la tarifa **no** absorbe lo no
  productivo, y ese coste queda en un CECO y se reparte por un driver.

*Ejemplo ilustrativo del doble cómputo:* coste empresa 5.276.000 c; 1.800 h
pagadas, 1.500 productivas, 300 no productivas. Tarifa (modelo A) = 3.517 c/h.

- Valoración de las 1.500 h productivas: 1.500 × 3.517 = **5.275.500 c** ≈ la
  nómina entera. Correcto.
- Si **además** el CECO conserva el coste de las 300 h no productivas y una regla
  `HOURS` lo reparte: 300 × 3.517 = **1.055.100 c** más.
- Total atribuido a proyectos **6.330.600 c** contra una nómina de **5.276.000 c**
  ⇒ exceso de **1.054.600 c (+20,0 %)** ⇒ **I-E10-12 en FAIL** todos los meses.

**Corrección concreta:** escribir en D3 que el modelo es el A, y que en el camino
por defecto (§3.7 a) **el reparto lo hace la regla `HOURS` sobre el saldo real del
CECO** —que ya contiene la nómina íntegra, productiva y no— con Hamilton, de modo
que Σ imputado = saldo, exacto: **la tarifa no es una segunda vía de imputación,
es una unidad de medida para KPI**. Y añadir el informe de absorción de O-E10-20.

### Q-4 · Presupuesto de inversiones y de amortización

**Decisión: se confirma que E10 presupuesta SÓLO explotación (grupos 6 y 7)**, con
la `68x` como una línea más. El `CHECK budget_lines_pnl_only` es correcto.

Pero «presupuestar la 68x a mano» no es aceptable como estado final, porque **la
mayor parte de esa cifra ya es determinista y está en el sistema**: los activos
en alta a 1 de enero tienen su cuadro de amortización calculado por el motor de
E3/E9. Teclearla a mano es invitar a un error de 6 cifras en la línea que separa
EBITDA de EBIT.

**Corrección concreta (dos tramos):**

1. **En E10, sin ADR nuevo:** `models/budget.ts` ofrece
   `proposeDepreciationBudget(fiscalYearId)` — una **propuesta** (nunca una
   aplicación, patrón `deriveHourlyCost`) que precarga las líneas `68x` mes a mes
   con la dotación **de los activos ya en alta**, con su dimensión analítica y
   con sus términos (`assetId`, base, método, vida útil restante). El usuario la
   acepta, la edita o la ignora. Coste marginal: reutiliza el cuadro existente.
2. **El CAPEX (grupo 2) va a E11**, con su tabla propia (`BudgetCapexLine`:
   mes de alta previsto, importe, método, vida útil, dimensión) y la dotación
   derivada **sumada** a la del tramo 1. Presupuestar el grupo 2 en
   `budget_lines` obligaría a levantar el CHECK y a mezclar un presupuesto de
   balance con uno de explotación en la misma tabla: no.

*Ejemplo ilustrativo:* activo de 3.000.000 c, lineal a 5 años, alta en abril ⇒
dotación presupuestada del ejercicio = 3.000.000 × 9 / 60 = **450.000 c**,
repartida 50.000 c/mes de abril a diciembre. Es un número que el sistema conoce y
que hoy el diseño pide teclear.

### Q-5 · ¿Presupuesto directo sobre una línea de negocio?

**Decisión: NO.** Se confirma el diseño: la LN es un **agregado de presentación**
y sólo se presupuesta a **proyecto** o a **CECO**. Admitirlo produciría dos cifras
verdaderas que se contradicen: la desviación de la LN dejaría de ser la suma de
las desviaciones de sus proyectos.

**Pero hay que resolver el caso real que motiva la pregunta**, y el diseño lo deja
sin respuesta: el presupuesto se hace en noviembre, cuando **los proyectos del año
siguiente todavía no existen**. La salida correcta no es una dimensión nueva:

**Corrección concreta:** por cada LN, un **proyecto contenedor** sembrado
(`P-<LN>-NUEVOS`, `status = PLANNED`, `businessLineId` de la LN) que recoge el
presupuesto de negocio aún no contratado. Ventajas: el presupuesto sigue en grano
de proyecto, la identidad «desviación LN = Σ desviaciones de sus proyectos» se
mantiene, y **la reasignación posterior a los proyectos reales es una `REVISADO n`
fechada** — es decir, el traspaso de pipeline a cartera queda documentado, que es
justo lo que un CFO quiere ver. Debe quedar excluido del reparto de estructura
(`targetFilter` por defecto `projectStatus: [ACTIVE]` ya lo excluye: correcto).

### Q-6 · Desviación en volumen vs. precio, y la convención del término cruzado

**Decisión: descomposición secuencial de dos términos, con el CRUCE AL PRECIO.**
No se implementa en E10 (correcto), pero **la convención se fija ahora** para que
las columnas no cambien de significado en E11.

```
Δ total   = P_r·Q_r − P_p·Q_p
Δ volumen = (Q_r − Q_p) · P_p          ← al precio PRESUPUESTADO
Δ precio  = (P_r − P_p) · Q_r          ← a la cantidad REAL  (absorbe el cruce)
Δ volumen + Δ precio = Δ total         (exacto, sin residuo)
```

**Por qué el cruce al precio y no al volumen ni aparte.** El efecto volumen debe
medirse a condiciones del plan, porque es lo único que el responsable de
producción controla; el efecto precio se mide sobre la actividad realmente
ejecutada, porque es la decisión comercial aplicada al volumen que hubo. Un tercer
término «cruce» es matemáticamente honesto e **inservible en un comité**: nadie
tiene responsabilidad sobre él. Es la convención estándar y la que deja dos
cifras con dueño.

**Regla de implementación entera, obligatoria** (si no, las dos partes no suman el
total): el precio unitario **no se almacena** y `importe / horas` no es exacto. Se
calcula el volumen sobre el importe presupuestado y **el precio como residuo**:

```
Δ volumen = ⌊ (Q_r − Q_p) × Importe_ppto / Q_p ⌋     (Q_p ≠ 0; si Q_p = 0, todo es volumen)
Δ precio  = Δ total − Δ volumen                       (residuo ⇒ Σ exacta, tolerancia 0)
```

*Ejemplo ilustrativo:* presupuesto 1.000 h y 6.000.000 c (6.000 c/h); real 1.100 h
y 6.930.000 c (6.300 c/h). Δ total = **+930.000 c**.
Δ volumen = ⌊100 × 6.000.000 / 1.000⌋ = **+600.000 c**.
Δ precio = 930.000 − 600.000 = **+330.000 c**.
Comprobación: (6.300 − 6.000) × 1.100 = **330.000 c** ✔.

**No se descompone el efecto mezcla (mix) en E11.** Con más de un proyecto por
línea, el mix existe, pero exige una jerarquía de producto que el modelo no tiene;
mejor no publicarlo que publicarlo mal.

### Q-7 · `HEADCOUNT`: stock a fin de periodo o media

**Decisión: se confirma el STOCK a fin de periodo para runs MENSUALES, y se
corrige para periodicidades superiores** — sin introducir ninguna media y sin
ninguna división.

**Peso = Σ de los `fteMilli` de los snapshots mensuales cuyo fin de mes cae dentro
del periodo del run** («FTE·mes»). Para un run `MONTH` es exactamente la
definición actual (un solo snapshot), así que **D1 no cambia para el caso normal y
el fixture no se mueve**; para `QUARTER` y `YEAR` deja de ser falsa.

*Ejemplo ilustrativo:* CECO `CC-SOP` que nace el 1-feb y se cierra el 30-nov, con
3.000 `fteMilli` mientras vive. Run **anual**: stock a 31-dic = **0** ⇒ peso 0 ⇒
`CC-SOP` no absorbe **nada** de los diez meses en que tuvo tres personas, y toda
esa estructura se traslada a los demás CECOs. Con FTE·mes: peso = 10 × 3.000 =
**30.000**, proporcional a la presencia real. Sin división, sin redondeo, entero.

**CECO sin snapshot en ningún mes del periodo:** peso 0 y
`W-E10-NO-HEADCOUNT` nombrándolo — correcto — **pero además debe mover el sello**
del run: la ausencia de un snapshot es un **hueco de datos**, no un cero. Motivo
de sello nuevo `PLANTILLA_AUSENTE` (O-E10-16). Un cero declarado (snapshot con
`fteMilli = 0`) sí es un dato y no mueve nada: la diferencia entre «no hay nadie»
y «no lo hemos rellenado» es exactamente lo que ADR-0013 D4 existe para no perder.

---

## 2. Observaciones, con corrección concreta

Severidad: **B** = bloqueante para la firma · **M** = mayor (antes de T9/T13) ·
**m** = menor.

### Drivers de actividad

**O-E10-1 (B) · El `timeHash` no cubre la ventana que el driver realmente
consume.**
`AllocationInput.timeEntries` es *«los partes del ejercicio, no sólo del periodo:
`YTD` y `PRIOR_PERIOD` los necesitan»* (§3.6) — pero el `timeHash` de D1 se sella
sobre `date ∈ [periodStart, periodEnd]`. Una regla con
`zeroBaseFallback = YTD` reparte con una base que **no está sellada**.
*Fallo:* run de marzo con fallback `YTD`; en mayo se aprueba un parte de **enero**
de 800 minutos. El `timeHash` de marzo **no cambia** ⇒ el run **no aparece
`STALE`** ⇒ luce vigente con un reparto que ya no se reproduce. Es literalmente el
fallo que D1 dice cerrar.
*Corrección:* `timeHash` se calcula sobre la **ventana efectivamente consumida por
el run**: `[inicio del ejercicio, periodEnd]` si alguna regla del run tiene
fallback `YTD`; `[inicio del periodo anterior, periodEnd]` con `PRIOR_PERIOD`;
`[periodStart, periodEnd]` en el resto. La ventana usada se **persiste** junto al
hash (`timeHashWindowStart/End`) para que la comprobación de staleness sea
reproducible sin releer las reglas.

**O-E10-2 (B) · Las horas sin aprobar sólo se avisan cuando la base es CERO; el
caso peligroso es el parcial.**
§3.6 emite `W-E10-UNAPPROVED-HOURS` cuando *«la base es 0 en todos los
receptores»*. Con base > 0 y una parte del periodo sin firmar, el reparto se hace
sobre una actividad incompleta **en silencio**, y al aprobar el resto cambia.
*Ejemplo:* `CC-OPS` con 900.000 c a repartir. Aprobadas: P-01 19.200 / P-02 10.800
/ P-03 6.000 min (Σ 36.000). Sin aprobar: P-03 12.000 min.

| | P-01 | P-02 | P-03 |
|---|---:|---:|---:|
| Reparto con base aprobada (36.000) | 480.000 c | 270.000 c | 150.000 c |
| Reparto con base completa (48.000) | 360.000 c | 202.500 c | 337.500 c |
| **Diferencia** | **−120.000 c** | **−67.500 c** | **+187.500 c** |

*Corrección:* emitir `W-E10-UNAPPROVED-HOURS` **siempre que existan minutos sin
aprobar de receptores elegibles en la ventana del driver**, con el importe y el
% que representan sobre la base, **independientemente de que la base sea 0**; y
que ese aviso emita el motivo de sello `HORAS_SIN_APROBAR` **en el
`AllocationRun`**, no sólo en el `ReportRun`.

**O-E10-3 (M) · La forma canónica del `timeHash` está definida dos veces y de dos
maneras, y una de ellas no es reproducible.**
ADR-0018 D1: `fecha|empleado|receptor|horas|productiva`. Diseño §3.5
`canonicalTimeForm`: *«(id, fecha, receptor, horas, productiva)»* — **con `id` y
sin empleado**. El `id` es un uuid aleatorio: incluirlo hace que el hash de un
fixture recargado **nunca** coincida y tumba la reproducibilidad byte a byte de
T10 y el criterio 12.
*Corrección:* una sola definición, sin `id` en la carga:
`fecha|códigoEmpleado|códigoReceptor|minutos|productiva`, ordenada por esa misma
tupla y con desempate por el orden natural del renglón completo. El `id` puede
usarse para ordenar sólo si dos renglones son idénticos, en cuyo caso el hash no
cambia.

**O-E10-16 (M) · `HEADCOUNT`: base FTE·mes y motivo de sello por snapshot
ausente.** Ver Q-7. Corrección: peso = Σ `fteMilli` de los snapshots del periodo;
`SealReasonCode += PLANTILLA_AUSENTE`; e I-E10-11 se reescribe contra la nueva
base. Añadir además un aviso cuando una regla `HEADCOUNT` reparte a CECOs que **no
tienen a su vez regla vigente** hacia proyectos: el saldo queda atrapado un nivel
más abajo y la columna del CECO receptor no llega a 0 (I5.b lo detectará, pero
tarde y sin decir por qué).

### Presupuesto y comparabilidad

**O-E10-4 (B) · Presupuesto SIN imputar contra real IMPUTADO: la desviación de
MC3 y de EBITDA por proyecto es falsa.**
El presupuesto se teclea directamente sobre proyectos y CECOs. El real, con
`withAllocations = true`, ha pasado por la liquidación y ha trasladado el saldo de
los CECOs a las columnas de proyecto. **Las dos matrices no miden lo mismo por
debajo de MC2.**
*Ejemplo:* `CC-OPS` presupuestado en 900.000 c y ejecutado en 900.000 c
exactamente; horas exactamente las previstas. Real imputado: P-01 recibe 400.000 c
⇒ MC3(P-01) = MC2(P-01) − 400.000. Presupuesto: los 900.000 c siguen en la columna
`CC-OPS` ⇒ MC3(P-01) presupuestado = MC2(P-01) presupuestado. **Desviación de MC3
de P-01 = −400.000 c con ejecución perfecta.** El informe acusa a un proyecto de
una desviación que no existe, y el total compañía sí cuadra, que es lo que hace
que nadie lo detecte.
*Corrección (elegir una y escribirla en D2/D4):*
 **(a) recomendada** — `buildBudgetMatrix` pasa por una **liquidación
 presupuestaria** en dry-run puro: las mismas `AllocationRule` vigentes, el mismo
 `allocate()`, sobre el presupuesto en vez de sobre el diario; no se persiste
 nada (no es un `AllocationRun`), y su resultado entra en el `budgetHash` a través
 del `rulesHash` usado. Los drivers de actividad usan las **horas
 presupuestadas** (`BudgetHoursLine`), que para eso existen y hoy no alimentan
 nada.
 **(b) mínima** — el informe **no publica** columnas de desviación por proyecto
 para niveles MC3, EBITDA, EBIT, BAI y RESULTADO cuando `withAllocations = true`
 y el presupuesto no está imputado; esas filas sólo se publican a total compañía,
 con leyenda. Es peor producto, pero no miente.
 En los dos casos: el toggle «con / sin imputaciones» debe **bloquearse** si el
 presupuesto no puede seguirlo, en vez de producir una matriz mixta.

**O-E10-5 (B) · `EV-14` es inalcanzable: contradicción entre D5 y el esquema de
M5.** `EV-14` («la versión usada es un `BORRADOR`») presupone que un
`PRESUPUESTO_REAL` puede emitirse con un borrador. Pero `budgets_sealed_marks`
obliga a `budget_hash IS NULL` mientras el estado es `BORRADOR`, y
`report_runs_budget_hash_required` exige `budget_hash <> '∅'` para ese tipo de
informe. No hay hash que escribir: el `ReportRun` **no se puede crear**.
*Corrección:* eliminar la ambigüedad por el lado correcto — **un `BORRADOR` nunca
produce un `ReportRun`**. La comparación contra un borrador existe sólo como
**previsualización no sellada** (dry-run, sin fila en `report_runs`, con banda
«borrador, no firmable»), igual que `previewAllocation` en E5. `EV-14` se retira o
se reformula como validación de la acción (`BUDGET_NOT_SEALED`), y
`PRESUPUESTO_NO_SELLADO` deja de ser motivo de sello para pasar a ser causa de
rechazo. Es más coherente con la propia frase de D5: *«un presupuesto sin sellar
no puede firmar un informe»*.

**O-E10-6 (B) · Nada impide teclear un gasto presupuestado en positivo, y el
error es invisible.** La convención de aporte es correcta, pero sólo existe en la
documentación: no hay CHECK ni validación que ligue el signo con la cuenta o con
el tipo analítico.
*Ejemplo:* línea de presupuesto `6400`, marzo, P-01, `amountCents = +1.200.000`
(el usuario teclea «12.000 € de personal»). Real: aporte = −1.200.000.
Desviación = −1.200.000 − (+1.200.000) = **−2.400.000 c** con ejecución exacta —
el doble del importe, y con signo de «hemos gastado de más».
*Corrección:* validación determinista al guardar la celda y CHECK de refuerzo, por
tipo analítico efectivo (que es lo que decide, no el grupo):
`INGRESO_DIRECTO ⇒ amountCents ≥ 0`;
`COSTE_DIRECTO_MC1 | COSTE_DIRECTO_MC2 | INDIRECTO_CECO | AMORTIZACION_DETERIORO ⇒ amountCents ≤ 0`;
`FINANCIERO | EXTRAORDINARIO | NO_ANALITICO` sin restricción.
Excepciones que hay que admitir **con aviso, no con bloqueo**: `61x`/`71x`
(variación de existencias), `706`/`708`/`709` (rappels y devoluciones, negativos
sobre ingreso) y `79x`/`759` (reversiones, positivos sobre gasto). El importador
CSV debe además rechazar el fichero completo si **más del 90 % de las líneas de
cuentas 6 vienen en positivo**: es el síntoma inequívoco de una hoja con la
convención contraria, y aceptarla a medias es peor que rechazarla.

**O-E10-7 (M) · El nivel de margen de una línea de presupuesto no está congelado
en la línea; es la lección de E5-D1 sin aplicar.** `BudgetLine` guarda
`analyticType` resuelto (bien), pero para `INDIRECTO_CECO` el **nivel** lo pone
`CostCenter.marginLevel` en el momento de leer la matriz. Si un CECO pasa de MC3 a
EBITDA después de sellar, el `budgetHash` **no cambia** (`marginConfigHash` cubre
`MarginLevelConfig`, no el nivel de cada CECO) y el mismo presupuesto sellado se
lee en otra fila: la desviación de MC3 se mueve sola.
*Corrección:* añadir `marginLevel` a `BudgetLine`, poblado al guardar con el nivel
vigente —exactamente lo que `AllocationLine.marginLevel` hace desde E5-D1, y por
la misma razón— y meterlo en la forma canónica del `budgetHash`. Alternativa
peor: incluir un `costCenterLevelsHash` en el sello (arrastra recomputaciones y no
resuelve el drill-down).

**O-E10-8 (M) · Las vigencias no pueden solaparse, pero sí pueden dejar un
HUECO.** El `EXCLUDE` impide el solape; nada impide sellar `2026-REV1` con
`validFrom = 01-08` cuando la `BASE` quedó con `validTo = 30-06`. Julio se queda
sin versión vigente ⇒ un informe de julio dispara `EV-12 PRESUPUESTO_AUSENTE` y
sale con la columna vacía **aunque haya presupuesto**.
*Corrección:* `sealBudget` cierra la versión anterior con
`validTo = validFrom(nueva) − 1 día`, exigido en la misma transacción, y
**I-E10-9 gana la continuidad**: para todo ejercicio con al menos una versión no
`BORRADOR`, la unión de las vigencias cubre `[inicio, fin]` del ejercicio sin
hueco.

**O-E10-9 (M) · Una `REVISADO n` puede estar incompleta y desinflar el año sin que
nada lo diga.** Si una revisión de julio contiene sólo julio-diciembre, la suma
anual del presupuesto vigente en agosto es la mitad del plan.
*Corrección:* invariante nuevo — toda versión no `BORRADOR` cubre **los doce meses
del ejercicio**, o declara explícitamente `partialFrom` (mes desde el que
sustituye) y el informe **compone** BASE(ene–jun) + REV1(jul–dic) diciendo de qué
versión sale cada mes, como ya hace `provenanceByMonth` con el forecast. La
opción implícita de hoy —copiar y editar— no está garantizada por nada.

**O-E10-10 (M) · `BudgetHoursLine` no tiene integridad referencial ni control de
periodo.** En el fragmento Prisma, `projectId`, `costCenterId` y `employeeId` son
uuid **sin `@relation`**, sin FK compuesta por tenant, sin CHECK de mes = día 1 y
sin el trigger `month_in_fiscal_year` que sí tiene `budget_lines`.
*Corrección:* las tres FK compuestas `(organization_id, id)` con `onDelete:
Restrict`, `CHECK date_part('day', month) = 1`, y el mismo trigger de mes dentro
del ejercicio. Y el índice único con `COALESCE(project_id, cost_center_id)`
conviene sustituirlo por **dos índices parciales** (uno por proyecto, otro por
CECO), consistentes con la doctrina de O-A6 en `budget_lines`.

### Coste-hora

**O-E10-11 (M) · Los prefijos por defecto de la derivación incluyen `641`.** Ver
Q-1. *Corrección:* default `["640","642","645","649"]`; `641` **excluido** y
documentado como tal en la ficha de la tarifa. `BRUTO_SIN_SS` = `["640"]`.

**O-E10-12 (M) · No existe forma de obtener del diario la nómina DE UN EMPLEADO:
`deriveHourlyCost` recibe un `payrollCents` que nadie sabe calcular.**
`JournalLine` tiene `counterpartyId` pero **no** `employeeId`, y la nómina se
contabiliza normalmente en una o dos líneas de `640` por CECO, no por persona.
Con el diseño actual, `proposeHourlyCost(employeeId, …)` no tiene fuente.
*Corrección (una de las dos, declarada):*
 (a) **Tarifa media por CECO** —`deriveHourlyCost` propone
 `⌊ 64x del CECO / horas productivas aprobadas del CECO ⌋`— y la propuesta se
 aplica a todos los empleados del CECO sin tarifa propia. Es honesto y suficiente
 para gestión.
 (b) **Tarifa individual**, sólo si las líneas `64x` llevan el
 `counterpartyId` del `Counterparty` del empleado; la propuesta debe entonces
 informar la cobertura («calculada sobre 8 de 34 líneas de 64x del periodo,
 78 % del importe») y quedar **no evaluable** por debajo de una cobertura
 configurable. Nunca extrapolar en silencio.

**O-E10-13 (M) · El Hamilton del coste-hora está enunciado pero no definido, y sin
definición dos implementaciones dan cifras distintas.** «*Σ coste por parte =
coste del receptor*» no dice qué es el coste del receptor.
*Corrección, exacta:* con partes `i` de `mᵢ` minutos y tarifa `rᵢ` c/h del día del
parte, `T = ⌊ Σ (mᵢ·rᵢ) / 60 ⌋`; se reparte `T` entre los partes por mayor resto
sobre los pesos `mᵢ·rᵢ`, con **empate a favor del parte de menor (fecha, código de
empleado, id)** — el mismo desempate determinista de ADR-0013 D5.
*Ejemplo ilustrativo (en centésimas, para comparar con el diseño actual):* tarifa
2.667 c/h; parte A 733 c-h → 19.549,11 → ⌊⌋ 19.549; parte B 267 c-h → 7.120,89 →
⌊⌋ 7.120. Σ⌊⌋ = 26.669. Total exacto = ⌊1.000 × 2.667 / 100⌋ = **26.670**. El
céntimo que falta va al mayor resto (0,89, parte B) ⇒ **7.121**. Sin esta regla
escrita, el motor puede perder ese céntimo en cada receptor y cada mes.

**O-E10-14 (M) · `COSTE_TOTAL_CON_ESTRUCTURA` no puede coexistir con el driver
`HOURS` en el mismo informe.** Si la tarifa ya lleva estructura imputada y además
una regla `HOURS` reparte los CECOs a los proyectos, la estructura se carga dos
veces. *Corrección:* o se retira el valor del enum en E10, o se declara mutuamente
excluyente con la existencia de reglas de actividad vigentes, con validación al
fijar la tarifa y aviso permanente en el informe. La solución también resuelve el
mismo riesgo en Q-3.

**O-E10-15 (m) · Agregar receptores con `basis` distinta produce una cifra sin
significado.** El coste-hora medio de un proyecto en el que trabajaron dos
empleados con `BRUTO_SIN_SS` y `COSTE_EMPRESA_CON_SS` no es ninguna de las dos
cosas. *Corrección:* el KPI sale **no evaluable** con la lista de bases en
conflicto, en vez de sumar.

### Informe, umbrales e invariantes

**O-E10-17 (m) · `HORAS_SIN_APROBAR` es un motivo de sello sin ninguna regla `EV`
que lo emita.** §5.3 lo declara; `EV-11…14` no lo producen. *Corrección:*
`EV-15 · dispara siempre`: existen minutos sin aprobar del periodo que alguna
regla de actividad habría usado (liga con O-E10-2). Y `EV-16` para
`PLANTILLA_AUSENTE` (O-E10-16). Un motivo sin regla es decoración, que es
justamente la lección H-4 de E7 que D5 invoca.

**O-E10-18 (M) · Los tres umbrales son «total compañía»: dos desviaciones grandes
de signo contrario se anulan y el informe se firma en verde.**
*Ejemplo:* MC3 de P-01 −1.500.000 c y MC3 de P-02 +1.500.000 c ⇒ desviación total
0 c y 0 bps ⇒ ni `desviacionMc3` ni ningún otro dispara ⇒
**`VALIDADO AUTOMÁTICAMENTE`** con dos proyectos fuera de control.
*Corrección:* un cuarto KPI `desviacionMaxDimension` con la misma forma
(`pctBps` + `minAbsCents`), evaluado sobre `max |desviación|` **por dimensión** en
los niveles INGRESOS, MC2 y MC3. Coste marginal nulo: la matriz ya está calculada.

**O-E10-19 (m) · `productiveHoursPerYearCenti = 170000` (1.700 h) no son horas
productivas, son jornada anual.** El convenio-tipo español ronda 1.780–1.800 h de
jornada; descontadas vacaciones, festivos, formación y absentismo, las productivas
rondan 1.450–1.550. Usar 1.700 como denominador **infravalora la tarifa en torno a
un 12 %**. *Corrección:* default 1.500 h (con minutos, `90000`), renombrado a algo
que diga lo que es (`referenceProductiveMinutesPerYear`) y usado **sólo** como
denominador de respaldo cuando no hay partes reales, nunca por delante de ellos.

**O-E10-20 (M) · Falta la desviación de absorción, que es la primera cifra que un
CFO pide cuando hay tarifas.** Con tarifa estándar y coste real coexistiendo, la
diferencia entre `Σ (horas × tarifa)` y el `64x` realmente contabilizado es la
**sub/sobreabsorción**, y hoy no aparece en ninguna pantalla: I-E10-12 sólo
comprueba que no se pase (`≤`), de modo que una infraabsorción del 20 % pasa el
invariante en silencio.
*Corrección:* bloque en `/analytics/projects` y en el `PRESUPUESTO_REAL`:
`absorción = Σ horas valoradas − Σ (−aporte) de 64x del periodo`, con su signo,
su % y su desglose por CECO. **No** convertirlo en FAIL: es información de
gestión, y su sitio es el informe, no el invariante.

**O-E10-21 (m) · El techo de 24 h es por fila, no por empleado y día.** Cuatro
partes de 1.440 minutos dan 96 h en un día y ningún CHECK lo ve.
*Corrección:* añadir a **I-E10-10** el agregado
`Σ minutos por (empleado, fecha) ≤ 1.440` (contra-apuntes con su signo), evaluado
como invariante y como aviso en la acción de alta.

**O-E10-22 (m) · La reclasificación de personal (camino b) admite bajar el umbral
de concentración por debajo del 100 %.** `concentrationBps` con default 10000 pero
parametrizable: con 8000, una línea de 300.000 c de la que el proyecto sólo
consumió el 80 % se reasigna **entera**, y el MC2 del proyecto se lleva 60.000 c
que no son suyos. *Corrección:* fijar `concentrationBps = 10000` sin parámetro
(el caso no íntegro es el camino a, y así lo dice ya el propio comentario de
`proposePayrollReclass`); si se conserva el parámetro, sólo `ADMIN`, con motivo y
con aviso permanente en el informe del proyecto afectado.

---

## 3. Las dos confirmaciones que el diseño solicita (§16, cierre)

**(i) La imputación de coste de personal a proyectos por horas NO genera ningún
hecho contable y por tanto ningún asiento. CONFIRMADO.**

| Fundamento | Por qué cierra la cuestión |
|---|---|
| **NRV 14ª (RD 1514/2007)** | El devengo registra **transacciones y hechos económicos**. Trasladar un coste ya registrado de una dimensión de gestión a otra no altera patrimonio, resultado ni relación con un tercero: no hay hecho económico que registrar |
| **Código de Comercio arts. 25–29** | Los libros obligatorios son diario, inventarios y cuentas anuales. **La contabilidad analítica no es libro obligatorio**: no puede exigir asientos, y meterlos en el diario obligatorio contamina un libro que sí tiene forma legal |
| **PGC 2007, grupo 9** | El grupo 9 es **libre** en el PGC español y está reservado a la contabilidad interna; usarlo obligaría a levantar una partida doble analítica paralela completa. Ni el diseño lo necesita ni ADR-0004 lo permite |
| **ADR-0003 / `CLAUDE.md`** | Los informes son **vistas del diario**. Un asiento de traspaso 64x → 64x exigiría un flag que lo excluyese de la PyG — expresamente prohibido |
| **ADR-0010, salvaguarda 1** | La reclasificación cambia **sólo las cuatro columnas analíticas**, recalcula `entryHash`, deja `ledgerHash` **intacto**, exige motivo y deja `AuditLog`. Es una reclasificación de gestión auditada, no una corrección contable |

Los dos caminos de §3.7 son los correctos y están bien delimitados: **(a)** driver
`HOURS` sobre el saldo del CECO cuando el consumo es compartido —Hamilton, Σ =
saldo, reversible, sellado—; **(b)** reclasificación auditada sólo cuando la línea
es **íntegramente** de un proyecto (con O-E10-22 aplicada). Prohibir partir una
`JournalLine` es correcto y no admite excepción.

**Matiz que debe quedar escrito:** el camino (b) **cambia el nivel de margen** del
importe (de `INDIRECTO_CECO`/MC3 a `COSTE_DIRECTO_MC2` por R-A3). Es la lectura
correcta, pero significa que una reclasificación **mueve MC2 y MC3 de periodos ya
informados**. La ventana temporal de ADR-0010 (ejercicio `OPEN`; mes bloqueado
sólo `ADMIN`; ejercicio `CLOSED` nunca) es la salvaguarda adecuada y debe citarse
expresamente en §3.7, no darse por sabida.

**(ii) Un presupuesto sellado no es un documento contable. CONFIRMADO.** No es
libro obligatorio, no se deposita, no se audita en el sentido del art. 268 LSC y
no tiene forma legal. La ceremonia que el diseño le pone —versión, vigencia sin
solape, sello con `budgetHash` + `marginConfigHash` + `gitSha`, inmutabilidad por
trigger, sustitución en vez de corrección y `AuditLog`— es **suficiente y
proporcionada**. Un CFO no pide más; pide exactamente eso, y pide poder ver el
**diff entre dos versiones**, que la doctrina de sustitución ya hace posible y que
conviene ofrecer como pantalla (no está en §7).

---

## 4. Invariantes: revisión de I-E10-1…13

**Son correctos en su enunciado, la tolerancia 0 está bien puesta donde compara
cifras, y ninguno afirma un PASS sin comprobarlo.** Tres precisiones y cinco
huecos.

| Invariante | Juicio |
|---|---|
| I-E10-1, I-E10-2, I-E10-7 | **Correctos**, tolerancia 0 bien elegida. I-E10-2 debe evaluarse **también** sobre los agregados de trimestre, año y YTD, no sólo celda a celda (el enunciado ya lo dice: mantenerlo) |
| I-E10-3 | Correcto, pero su base debe ser la de **O-E10-1** (ventana efectiva), no `[periodStart, periodEnd]` |
| I-E10-5 | **La severidad se queda corta.** Un margen por hora calculado con partes sin tarifa vigente no es un margen. `INFO` en el invariante es aceptable, pero debe **mover el sello**: motivo `TARIFA_AUSENTE`, que hoy no existe |
| I-E10-11 | Debe reescribirse contra la base FTE·mes (Q-7 / O-E10-16) |
| I-E10-12 | **Correcto como guarda (`≤`)**, pero insuficiente como información: la infraabsorción lo pasa en silencio. Se complementa con el informe de O-E10-20, **no** endureciéndolo a igualdad (la igualdad sólo se da con horas y tarifas perfectas) |
| I-E10-6, I-E10-4, I-E10-8, I-E10-9, I-E10-10, I-E10-13 | **Correctos** |

**Cinco invariantes que faltan** (numeración propuesta, continuando la serie):

| Id propuesto | Qué garantiza | Tol. | Origen |
|---|---|---|---|
| **I-E10-14** | **Coherencia de signo**: toda `BudgetLine` tiene el signo que le corresponde por su tipo analítico efectivo, salvo las excepciones declaradas (`61x`/`71x`, `706`/`708`/`709`, `79x`/`759`), que salen listadas | — | O-E10-6 |
| **I-E10-15** | **Continuidad de vigencias**: la unión de las vigencias de las versiones no `BORRADOR` de un ejercicio lo cubre entero, sin hueco | — | O-E10-8 |
| **I-E10-16** | **Completitud de la versión**: toda versión no `BORRADOR` cubre los doce meses, o declara su `partialFrom` y el informe compone la procedencia mes a mes | — | O-E10-9 |
| **I-E10-17** | **El `timeHash` cubre la ventana consumida**: para todo run con fallback `YTD`/`PRIOR_PERIOD`, la ventana sellada contiene la ventana usada por el driver | — | O-E10-1 |
| **I-E10-18** | **Comparabilidad**: si el informe publica desviación por dimensión en niveles ≥ MC3 con `withAllocations = true`, el presupuesto está imputado con las mismas reglas; en caso contrario esas celdas salen **no publicadas**, nunca calculadas | 0 | O-E10-4 |

Y una precisión operativa: **I-E10-10** debe incluir el techo agregado
`Σ minutos por (empleado, fecha) ≤ 1.440` (O-E10-21).

---

## 5. Qué rechazaría un CFO en la revisión de este entregable

En orden de gravedad, y todo ya recogido arriba:

1. **Una desviación de MC3 por proyecto que no es comparable** porque el
   presupuesto no está imputado y el real sí (O-E10-4). Es la cifra sobre la que
   se toman decisiones de cartera; si es falsa, el informe entero pierde crédito.
2. **Un informe firmado en verde con dos proyectos descontrolados** que se
   compensan en el total compañía (O-E10-18).
3. **Un gasto presupuestado tecleado en positivo** que duplica la desviación y no
   lo detecta nada (O-E10-6).
4. **Un reparto por horas hecho sobre el 75 % de la actividad** sin que el informe
   lo diga (O-E10-2), y un run que envejece en silencio con fallback `YTD`
   (O-E10-1).
5. **Un coste-hora que no se puede rehacer a mano** porque nadie sabe de dónde
   sale la nómina de esa persona (O-E10-12), o que duplica la estructura
   (O-E10-14 / Q-3).
6. **La ausencia de la desviación de absorción** cuando el sistema maneja tarifas
   estándar (O-E10-20).
7. **Un plan de amortización tecleado a mano** cuando el sistema ya conoce la
   dotación de los activos en alta (Q-4).
8. **Que la unidad de las horas no case con el registro de jornada legal**
   (Q-2): explicar en una inspección por qué el ERP dice 7,33 h donde el fichaje
   dice 7:20 es una conversación que no compensa.

---

## 6. Contrato de cifras que debe quedar congelado ANTES de T10

T10 sella `presupuesto-horas-esperado.json`; a partir de ahí, cada uno de estos
puntos cuesta un reversionado. Los siete están decididos en §1 y §2:

| # | Punto | Valor fijado |
|---|---|---|
| 1 | Unidad de horas | **Minutos enteros** (`hoursMinutes`); techo diario 1.440 por fila y por (empleado, día) |
| 2 | Coste de un parte | `⌊ mᵢ · rᵢ / 60 ⌋` con Hamilton sobre `T = ⌊Σ mᵢrᵢ / 60⌋`, desempate por (fecha, código de empleado, id) |
| 3 | Base de `HOURS` | Σ minutos **aprobados y productivos**, contra-apuntes con su signo, `max(0, ·)` por receptor, sobre la **ventana efectiva** del run |
| 4 | Base de `HEADCOUNT` | Σ `fteMilli` de los snapshots mensuales del periodo (**FTE·mes**); un mes es un snapshot ⇒ idéntico al stock actual |
| 5 | Forma canónica del `timeHash` | `fecha\|códigoEmpleado\|códigoReceptor\|minutos\|productiva`, **sin `id`** |
| 6 | `basis` por defecto y prefijos | `COSTE_EMPRESA_CON_SS` = `640` + `642` + `645` + `649`; **`641` excluido** |
| 7 | Signo del presupuesto | **Aporte** (`haber − debe`), con la validación de coherencia de I-E10-14 |

Y una recomendación de contenido para el fixture, porque un fixture que sólo
recorre el camino feliz no prueba nada: debe incluir **un mes con horas aprobadas
y sin aprobar mezcladas**, **un empleado sin tarifa vigente durante dos semanas**,
**un CECO que nace en febrero y muere en noviembre**, **una `REVISADO` que sólo
cubre el segundo semestre** y **una línea de presupuesto de ingreso con signo
correcto y otra de gasto que el importador rechaza por signo**.

---

## 7. Ronda 2 — verificación contra el texto reescrito (2026-09-14)

Verificado **contra el texto real** de `docs/design/E10-presupuesto-horas.md`
(2.625 líneas) y `docs/adr/0018-…md` (611 líneas, **D1–D6**, ronda 1), punto por
punto.

### 7.1 Estado de las 22 observaciones y las 7 cuestiones

| # | Estado | Dónde se comprueba |
|---|---|---|
| **O-E10-0** nombre de la validación | **CERRADA** | Cabecera de ADR-0018 y §16 del diseño citan `E10-validacion-controlling.md` |
| **O-E10-1** ventana del `timeHash` *(B)* | **CERRADA** | D1: `W = YTD ⇒ [inicio ejercicio, periodEnd]`, `PRIOR_PERIOD ⇒ [inicio periodo anterior, periodEnd]`; `timeHashWindowStart/End` **persistidas**; `timeWindowOf` en §3.5; **I-E10-17** |
| **O-E10-2** aviso con base **parcial** *(B)* | **CERRADA** | D1 punto 3 + `unapprovedMinutesByTarget` (§3.5) con `shareOfBaseBps`; `W-E10-UNAPPROVED-HOURS` siempre que haya minutos sin firmar; mueve el sello del **`AllocationRun`**; `EV-15` |
| **O-E10-3** forma canónica única, sin `id` | **CERRADA** | D1 y §3.5: `fecha\|códigoEmpleado\|códigoReceptor\|minutos\|productiva`; T5 exige «`canonicalTimeForm` **sin `id`**» |
| **O-E10-4** comparabilidad imputado/imputado *(B)* | **CERRADA** | D4 + `settleBudgetMatrix` (dry-run puro, mismas reglas, **horas presupuestadas** como driver, no persiste, `rulesHash` en `params`); degradación «no publicar ≥ MC3 por dimensión» y toggle bloqueado; **I-E10-18** |
| **O-E10-5** `EV-14` inalcanzable *(B)* | **CERRADA** | D5: `EV-14` **retirada**; `PRESUPUESTO_NO_SELLADO` pasa a rechazo `BUDGET_NOT_SEALED`; el borrador sólo produce previsualización sin fila |
| **O-E10-6** signo del presupuesto *(B)* | **CERRADA con matiz** → ver **O-E10-23** | `budget_lines_sign_by_type` (M2), `signException`, rechazo del CSV al 90 %, **I-E10-14** |
| **O-E10-7** `marginLevel` congelado | **CERRADA** | `BudgetLine.marginLevel MarginLevel` **NOT NULL**, en el `budgetHash`, `budget_lines_margin_level` |
| **O-E10-8** hueco de vigencias | **CERRADA** | D2 + `sealBudget` cierra con `validFrom − 1 día`; **I-E10-15** |
| **O-E10-9** versión incompleta | **CERRADA** | `partialFrom` + composición BASE/REVISADO con procedencia por mes; **I-E10-16** |
| **O-E10-10** integridad de `BudgetHoursLine` | **CERRADA** | Tres FK compuestas por tenant `onDelete: Restrict`, CHECK de día 1, trigger de mes y **cuatro** índices parciales (se retira el `COALESCE`) |
| **O-E10-11** `641` fuera | **CERRADA** | D3 y `payrollAccountPrefixes = ["640","642","645","649"]` |
| **O-E10-12** ámbito de la derivación | **CERRADA** | `scope = COST_CENTER` (default) / `EMPLOYEE` con `coverageBps` y `derivationMinCoverageBps = 7500` |
| **O-E10-13** Hamilton del coste-hora | **CERRADA** | D3: `T = ⌊Σ mᵢrᵢ/60⌋`, mayor resto sobre `mᵢ·rᵢ`, desempate `(fecha, código de empleado, id)` |
| **O-E10-14** absorción plena y conflicto de `basis` | **CERRADA** | D3 «modelo A, y escrito»; `COSTE_TOTAL_CON_ESTRUCTURA` excluyente (`RATE_BASIS_CONFLICT`) |
| **O-E10-15** agregar `basis` distintas | **CERRADA** | KPI **no evaluable** con las bases en conflicto |
| **O-E10-16** FTE·mes, snapshot ausente, saldo atrapado | **CERRADA** | D1 (`Σ fteMilli` del periodo), `EV-16`/`PLANTILLA_AUSENTE`, `W-E10-HEADCOUNT-TRAPPED` |
| **O-E10-17** motivo sin regla | **CERRADA** | `EV-15/16/17` y **criterio 33**: el test recorre motivos ↔ reglas |
| **O-E10-18** umbral por dimensión | **CERRADA** | Cuarto KPI `desviacionMaxDimension` (INGRESOS, MC2, MC3) |
| **O-E10-19** denominador de respaldo | **CERRADA** | `referenceProductiveMinutesPerYear = 90000` (1 500 h), sólo respaldo |
| **O-E10-20** desviación de absorción | **CERRADA** | `absorptionVariance()` y bloque en §5.2; no se endurece I-E10-12 |
| **O-E10-21** techo diario agregado | **CERRADA** | `CHECK BETWEEN -1440 AND 1440` **y** `Σ por (empleado, fecha) ≤ 1 440` en **I-E10-10** |
| **O-E10-22** `concentrationBps` | **CERRADA** | Fijo en 10000, sin parámetro |
| **Q-1 … Q-7** | **CERRADAS** | Q-1 `640+642+645+649` · Q-2 **minutos enteros** (campo `minutes`, techo 1 440, centésima descartada con su motivo) · Q-3 absorción plena · Q-4 `proposeDepreciationBudget` + CAPEX a E11 (criterio 31) · Q-5 proyecto contenedor `P-<LN>-NUEVOS` (criterio 32) · Q-6 **cruce al precio**, precio como residuo, sin mix, en **D6** · Q-7 FTE·mes |
| **Confirmaciones (i) y (ii)** | **CERRADAS** | §1 del diseño cita la **ventana temporal de ADR-0010** en el camino (b); `/analytics/budget/diff` recoge el diff entre versiones que pedía (ii) |

**22 de 22 observaciones incorporadas. 5 bloqueantes resueltos. 0 reaperturas.**
Los cinco invariantes propuestos están en el texto como **I-E10-14…18** y el
contrato de cifras está congelado en **D6**, que es el sitio correcto: firmado
antes de T10, no documentado después.

### 7.2 Lo único que queda abierto

**O-E10-23 (MENOR) · El `CHECK` de signo se puede esquivar dejando el tipo
analítico nulo.** `budget_lines_level_resolvable` admite
`account_code IS NOT NULL AND analytic_type IS NULL`, y
`budget_lines_sign_by_type` empieza por `"analytic_type" IS NULL OR …`: una línea
`6400` de marzo con `analytic_type` nulo y `amount_cents = +1 200 000` **entra**,
y contra un real de `−1 200 000` vuelve a dar **−2 400 000 c de desviación con
ejecución exacta** — el agujero de O-E10-6 por la puerta de atrás. La acción
resuelve siempre el tipo, pero el `CHECK` existe justamente para cuando la acción
no está en medio.

*Corrección exacta, una línea de SQL en M2, sin cambiar el modelo ni el ADR:*

```sql
ALTER TABLE "budget_lines"
  ADD CONSTRAINT "budget_lines_type_required" CHECK ("analytic_type" IS NOT NULL);
```

Es coherente con lo que el diseño ya afirma (*«tipo efectivo ya resuelto al
guardar»*) y con que `margin_level` sea **NOT NULL**: si el nivel es obligatorio,
el tipo del que se deriva no puede ser opcional. Con él, la rama
`"analytic_type" IS NULL OR` de `budget_lines_sign_by_type` queda muerta y puede
conservarse tal cual. Añádase el caso al **criterio 4** (insertar `6400` positivo
sin tipo ⇒ `23514`) e inclúyase en la evidencia de **I-E10-14**.

### 7.3 Veredicto final

> **CONFORME CON OBSERVACIONES** — una sola, **O-E10-23**, de severidad **MENOR**
> y con corrección de una línea de SQL. **No procede una tercera ronda**: se
> aplica en M2 junto con el resto de los `CHECK` de `budget_lines` y se verifica
> en T4/T19.
>
> **ADR-0018 (D1–D6) queda CONFORME para la firma humana**, y el diseño
> `E10-presupuesto-horas.md` **CONFORME** con esa corrección incorporada.
> Ningún punto del control de gestión queda abierto: base y ventana de los
> drivers, coste-hora y su absorción, signo y sello del presupuesto,
> comparabilidad de la desviación, forecast, umbrales por dimensión, KPI de
> rentabilidad por hora y los dieciocho invariantes están cerrados y con criterio
> de aceptación propio.
