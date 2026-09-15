# E10 — Auditoría adversarial de fiabilidad (presupuesto, horas y drivers de actividad)

Auditor `auditor-fiabilidad`, contexto limpio. Diff auditado `fc4a863…HEAD`. Se
recibieron **sólo** entradas y entregables (diseño §3/§5, ADR-0018 D1–D6,
validación de controlling, fixture sellado y fixture v2, tests de integración
como guía). No se ha leído ni usado razonamiento del productor.

## Método

Reconstrucción **por otro camino**, tolerancia 0 céntimos:

- **Python propio** (`sha256`/entero, sin `float`) para la forma canónica y el
  `budgetHash`, la composición de versiones, la matriz de presupuesto, los
  agregados de horas, el `timeHash`, el Hamilton del coste-hora, la absorción,
  las bases `HOURS`/`HEADCOUNT`, la cascada de liquidación real y en dry-run, la
  desviación, el `varianceBps` y el forecast. **No** se importó ni ejecutó
  `lib/budget/**`, `lib/time/**` ni `lib/analytics/allocate.ts`.
- **SQL directo** sobre una base aislada clonada de `erp_test`, con el fixture
  `ejercicio-completo.json` cargado por el camino de la aplicación, para la PyG
  analítica real de E4/E5, la nómina 64x, los CHECK, los triggers, los GRANT de
  columna y la RLS. La base clonada se ha **eliminado** al terminar; el producto
  y los fixtures no se han modificado.

## Cifras reconstruidas (todas cuadran al céntimo)

| Métrica | Motor / sellado | Reconstrucción | Δ | Método |
|---|---:|---:|---:|---|
| `marginConfigHash` | `c758026c…` | `c758026c…` | — | Python sha256 |
| `budgetHash` 2026-BASE | `2b6e0cee…` | `2b6e0cee…` | — | Python, forma canónica del diseño sobre `budgetLines` |
| `budgetHash` 2026-REV1 | `a8daf55c…` | `a8daf55c…` | — | ídem |
| Totales presupuesto por nivel (8) | INGRESOS 6 326 400 … RESULTADO 1 767 633 | idénticos | 0 | Σ líneas compuestas por `marginLevel` |
| Matriz presupuesto (8×17 acumulada) | 136 celdas | idénticas | 0 | Σ contribuciones por nivel |
| Composición BASE+REV1 | ene–jun BASE / jul–dic REV1, 80 líneas | idéntica | 0 | última no parcial + `partialFrom` |
| Totales reales por nivel (8) | INGRESOS 6 250 000 … RESULTADO 1 497 322 | idénticos | 0 | **SQL** sobre `journal_lines` con R-A2…R-A11 reimplementadas |
| Desviación INGRESOS | −76 400 | −76 400 | 0 | real − presupuesto |
| Desviación MC3 | +63 350 | +63 350 | 0 | ídem |
| Desviación EBITDA | +228 797 | +228 797 | 0 | ídem |
| `varianceCents` / `varianceBps` de las 40+ celdas | — | idénticos | 0 | resta entera y `⌊·⌋` con signo |
| Minutos aprobados y productivos por proyecto | 16 588 / 14 932 / 20 684 | idénticos | 0 | Σ con contra-apuntes |
| Minutos sin aprobar | P-01 276, P-03 700 | idénticos | 0 | ídem |
| `timeHash` (3 ventanas) | `6b67f1e5…`, `530d4525…`, `29b910f3…` | idénticos | — | `fecha\|empleado\|receptor\|minutos\|productiva` |
| Coste-hora por receptor | 834 500 / 694 910 / 1 087 803 | idénticos | 0 | `T=⌊Σmᵢrᵢ/60⌋` + mayor resto |
| Reparto Hamilton por parte (muestra 12) | — | idénticos | 0 | pesos `mᵢ·rᵢ`, desempate (fecha, empleado, id) |
| Partes sin tarifa | 2 (E-05, 13 y 20-06) | idénticos | — | vigencias sin solape; **nunca 0** |
| Absorción | −22 787 c / −86 bps | −22 787 c / −86 bps | 0 | Σ valorado − Σ 64x (2 640 000) |
| Base `HEADCOUNT` FTE·mes | CC-OPS 48 000, CC-DEV 30 000 | idénticas | 0 | Σ `fteMilli` de snapshots del periodo |
| `allocation_lines` reales (17) | — | idénticas | 0 | cascada MONTH→QUARTER→YEAR, Hamilton, nivel viaja con el importe |
| `allocation_lines` dry-run presupuesto (18) | — | idénticas | 0 | ídem con horas y CECOs presupuestados |
| Forecast (12 meses) | corte 2026-06 | idéntico | 0 | 6 reales + 6 presupuesto, sin solape ni hueco |
| Margen/hora MC2 y MC3 y tarifa media (3 proyectos) | — | idénticos | 0 | `⌊x·60/min⌋` |

Comprobaciones de comportamiento verificadas contra la base:

- Línea de gasto **positiva sin excepción** → `budget_lines_sign_by_type`
  rechaza; `INGRESO_DIRECTO` negativo también; `margin_level` incoherente con el
  tipo → trigger `assert_budget_line_margin_level` (O-E10-7).
- Parte de **1 441 min** y **dos partes de 1 440 el mismo día** → rechazados por
  `assert_time_entry_daily_ceiling` (O-E10-21, techo agregado, no por fila).
- `UPDATE`/`DELETE` de un parte **APROBADO** → rechazados por trigger; el
  contra-apunte positivo y el que excede al original, también.
- Regla **`HEADCOUNT` a `PROJECTS`** → `allocation_rules_headcount_targets`.
- `UPDATE` de `budget_lines` de una versión **sellada** → trigger
  `assert_budget_lines_not_sealed`. Forzado desactivando el trigger, la
  recomputación del `budgetHash` delata **un céntimo** de diferencia.
- Alterar un parte aprobado, o **aprobar un parte tardío** dentro de la ventana,
  cambia el `timeHash` recomputado ⇒ el run queda `STALE` por la rama (d) de
  `allocationRunStalenessBatch`, que usa la ventana que el propio run persiste.
- Siete tablas nuevas en `FORCE ROW LEVEL SECURITY`, `tenant_isolation`, 0 filas
  sin GUC y **42501** como `app_runtime` sobre las columnas no concedidas
  (`budgets` y `time_entries` tienen GRANT **de columna**: sólo `status`,
  `valid_to`, sellos y `approved_*`).
- `budget_hash` está en el índice único de caché de `report_runs` y el CHECK
  `report_runs_budget_hash_required` impide un `PRESUPUESTO_REAL` con `'∅'`:
  sellar otra versión produce **run nuevo**, no caché.
- E10 **no escribe ni un asiento**: ningún `journalEntry.create`/`postEntry` en
  `models/budget.ts`, `models/time.ts`, `models/employees.ts`, `lib/budget/**`,
  `lib/time/**`. `lib/time/payroll-reclass.ts` es puro y sólo **propone**;
  `reclassifyLines` no se ha tocado en este diff.
- `liquidacion-esperada.json` y `pyg-analitica-esperada.json` **byte a byte
  intactos** respecto de `fc4a863`, y ninguna de las seis reglas de E5 usa un
  driver de actividad.

## Hallazgos

**H-1 · GRAVE — los dieciocho invariantes I-E10-1…18 son código muerto en
producción.** `runInvariants` los ejecuta `if (input.budget || input.time)`
(`lib/ledger/invariants.ts:577`), pero `models/ledger.runLedgerInvariants`
compone `analytics`, `documents`, `allocations` y `closing` y **nunca** los
bloques `budget` / `time` (`models/ledger.ts` ≈2192-2223). `runBudgetInvariants`
y `budgetSealReasons` no tienen ni un llamante fuera de `lib/` y sus tests. La
familia `PRESUPUESTO` de `/audit` saldrá siempre `SIN_EVALUAR` y los cinco
motivos de sello de E10 no llegan al sello del periodo. Es literalmente el
hallazgo **H-2 de E9** («el bloque `closing`, que nadie rellenaba») repetido, y
documentado como tal en el propio comentario del fichero. Consecuencia directa
para esta auditoría: los errores inyectados (a), (b) y (c) **no pueden ser
detectados por el producto**, sólo por recomputación externa.

**H-2 · GRAVE — el `budgetHash` de toda versión relevada deja de ser
reproducible.** `valid_to` entra en la cabecera de la forma canónica (§3.1, §3.8,
ADR-0018 D2), pero el trigger `app.assert_budget_immutable_when_sealed` lo deja
**mutable tras sellar** y `sealBudgetTx` (`models/budget.ts:528-545`) cierra la
versión anterior con `validTo = validFrom − 1 día` en la misma transacción
(O-E10-8). Reproducido por el camino del producto sobre base real: sellada la
BASE con `validTo = NULL` su hash es `8d2bf1ba…`; sellada después la REV1
parcial, la BASE queda con `validTo = 2026-06-30` y su hash recomputado sobre lo
que la fila tiene hoy es `9cc18b3d…`. **I-E10-6 daría FAIL sobre datos
íntegros**, y una manipulación real sería indistinguible del caso rutinario. El
fixture sellado lo oculta porque calcula el hash de la BASE con `validTo` ya a
`2026-06-30`, un estado que `sealBudget` nunca produce en el instante del sello.
Arreglo: sacar `valid_to` de la forma canónica (la vigencia no es contenido del
presupuesto), o congelarla y no reescribirla.

**H-3 · MEDIO — el `budgetHash` no cubre las horas presupuestadas.** §3.8 y
ADR-0018 D2 dicen «‖ líneas de horas en forma canónica, en minutos»; ni
`canonicalBudgetForm` (`lib/budget/hash.ts:56-66`) ni el generador las incluyen,
y la reconstrucción confirma que el hash sellado sale **sólo** de las líneas de
importe. `budgetHoursHash` existe pero no se persiste ni entra en la clave de
caché. Las horas presupuestadas alimentan `settleBudgetMatrix`, es decir la
columna de presupuesto de MC3 **por dimensión**: el sello no atestigua la base
con la que se repartió. El trigger `budget_hours_lines_no_write_when_sealed`
protege el camino SQL, pero eso es defensa, no sello.

**H-4 · MENOR — el CHECK de signo es más débil que el código que refuerza.**
`budget_lines_sign_by_type` empieza por `sign_exception OR …`, sin comprobar que
la cuenta pertenezca a las familias declaradas (`61x`/`71x`, `706`/`708`/`709`,
`79x`/`759`). Insertada por SQL una línea `640` de **+123 456 c** con
`sign_exception = true`: entra. El camino de la aplicación la rechaza
(`models/budget.ts:754`, `WRONG_SIGN` aborta con independencia de la bandera),
así que el riesgo es de carga directa o de importador futuro.

**H-5 · MENOR — el desglose de absorción por CECO no informa.**
`absorption.byCostCenter` trae `valuedCents: 0` en las tres filas mientras
`payrollCents` va desglosado por la dimensión de la línea 64x (y dos filas
llevan `PROJ:P-01` / `PROJ:P-02` en un campo llamado `costCenterCode`). El total
es correcto (−22 787 c / −86 bps), pero el desglose que O-E10-20 pide para el
comité muestra **infraabsorción del 100 % en todas las unidades**.

**H-6 · MENOR (documental) — §3.6 define mal la base del driver `HOURS`.** La
tabla dice que el peso son los minutos «dentro de la ventana efectiva del run
(§3.5 `timeWindowOf`)»; el fixture y `checkIE103`/`driverWindowOf` usan la
ventana del **periodo** y sólo la ensanchan cuando el fallback se aplicó de
hecho. Con la letra del diseño, el run de 2026-11 tendría base 52 204 min y no
4 532. La implementación es la correcta; el texto (y la redacción de I-E10-3)
debe alinearse.

**H-7 · MENOR — la provenance de `PRESUPUESTO_REAL` no es por celda.** §5.1 exige
tres consultas parametrizadas por celda de desviación; lo que se persiste es un
bloque de run con `generatedFrom: ["journal_lines","allocation_lines",
"budget_lines"]` y los tres sellos (`models/reports.ts` ≈2199-2208). Es
suficiente para reconstruir a mano, no para el drill-down prometido.

## Trazabilidad

**OK.** Celda elegida: desviación MC3 de `PROJ:P-01`, +129 580 c. Real 316 000 c
reconstruido desde `journal_lines` (ingreso 2 050 000, MC1 −150 000, MC2
−1 584 000) en una consulta; presupuesto 186 420 c desde las líneas de
`2026-BASE`/`2026-REV1` del mes correspondiente; ambos en menos de dos minutos.
La ruta no viene dada por la provenance del run (H-7): hubo que escribir las
consultas.

## Recomendación

1. Cablear `budget`/`time` en `runLedgerInvariants` (H-1) antes de dar E10 por
   cerrada: sin eso la familia `PRESUPUESTO` no vigila nada.
2. Sacar `valid_to` de la forma canónica del `budgetHash` y regenerar el fixture
   (H-2); añadir las líneas de horas al sello o corregir §3.8/D2 (H-3).
3. Cerrar H-4 (CHECK) y H-5 (desglose de absorción) antes de publicar la
   pantalla; H-6 y H-7 son deuda documentada.

---

# Re-auditoría (ronda 1, `5d2d2ba…aa7a7d0`)

Mismo método: Python propio para la forma canónica nueva y SQL directo sobre una
base aislada clonada de `erp_test` (eliminada al terminar). Producto y fixtures
no modificados.

| Hallazgo ronda 0 | Estado | Evidencia |
|---|---|---|
| **H-1** invariantes muertos | **CERRADO** | `models/ledger.ts:2209-2259` rellena `budget`/`time` vía `models/budget-invariants.readBudgetInvariantInput`. Barrido real: 90 checks (antes 26) con los **18 `I-E10-*`**; un FAIL mueve el sello a `REQUIERE REVISIÓN` |
| **H-2** `valid_to` en el sello | **CERRADO** | `canonicalBudgetForm` ya no lleva `valid_to`. Sellada BASE y después REV1, `I-E10-6` **PASS** |
| **H-3** horas fuera del sello | **CERRADO** | Bloque `∅HORAS` + filas de horas. Python reproduce `c32cdecf…` (BASE, 36 filas) y `dc11871c…` (REV1, 18) del fixture **v1.1**; `--check` byte a byte OK; sensible a **1 c** y a **1 min** |
| **H-4** CHECK de signo | **CERRADO** | `budget_lines_sign_by_type` llama a `app.budget_sign_exception_allowed()`: `640` +123 456 c con `sign_exception` **rechazado**; `706` +5 000 c admitido |
| **H-5** desglose de absorción | **ABIERTO en el fixture** | `models/reports.ts:2524-2541` ya reparte lo valorado por el CECO del empleado, pero `presupuesto-horas-esperado.v1.1.json` sigue con `valuedCents: 0` en las tres filas y `PROJ:P-01`/`PROJ:P-02` como `costCenterCode`: **Σ valorado por CECO = 0** y Σ absorción por CECO = **−2 640 000 c ≠ −22 787 c**. `build_absorption()` del generador no se tocó: el contrato congelado (D6) y el producto dicen cosas distintas |
| **H-6** texto de §3.6 | corregido en el diseño | — |
| **H-7** provenance por celda | **PARCIAL** | `report_runs.provenance.byCell` se persiste con sus consultas. Pero en la celda citada, **MC3 `PROJ:P-01`** (desviación −4 484 000 c), `real` y `presupuesto` devuelven **0 filas**: `real` filtra `analytic_type` a los tipos **del nivel**, y la matriz es **acumulativa**; y `presupuesto` fija una celda anual a `month = '2026-01-01'`. Sólo cuadra el nivel base (INGRESOS `PROJ:P-01`: 7 líneas, 2 050 000 c = `actualCents`) |

**Regresión nueva · GRAVE — `I-E10-12` da FAIL sobre datos íntegros.**
`readPayrollAbsorption` (`models/budget-invariants.ts:453-465`) no excluye
`REGULARIZATION`/`CLOSING`/`OPENING`, así que el asiento de regularización de
cierre —que **abona** 640/642— deja la nómina de diciembre en **−2 640 000 c** y
la guarda lee `0 ≤ −2 640 000` como exceso: *«2026-12: 0 c imputados … sobre
-2640000 c contabilizados en 64x (exceso de 2640000 c)»*. Todo ejercicio cerrado
queda con la familia `PRESUPUESTO` en FAIL y el periodo en `REQUIERE REVISIÓN` de
forma permanente — el mismo vicio que H-2 en la ronda 0: un invariante que falla
con datos limpios no distingue una manipulación.

**Inyecciones.** (a) 1 c en una línea sellada y 1 min en una línea de horas
sellada ⇒ `I-E10-6` **FAIL** y sello `REQUIERE REVISIÓN` (además el trigger las
bloquea; hubo que desactivarlo). (b) parte **APROBADO** alterado por SQL ⇒
**ningún `I-E10-*` lo detecta** en un tenant sin `AllocationRun` sellado con
driver de actividad: la detección vive en el `timeHash`/`STALE` y en `I-E10-17`,
que necesitan un run — la afirmación «(b) → FAIL» es **condicional**. (c) no
re-verificada: el arnés no tiene ningún run con driver `HOURS`.

**D7 · verificado.** `SET LOCAL app.maintenance_reset_org` con el uuid correcto
de la organización, como `app_runtime`, sigue devolviendo `23514` al borrar un
parte aprobado (`app.is_maintenance_operator()` exige el rol); un parte
`BORRADOR` se borra con normalidad.

**Cifras de la ronda 0 sobre v1.1 · Δ = 0** en las ocho: totales de presupuesto
por nivel, totales reales por nivel reconstruidos por SQL, desviaciones
**−76 400 / +63 350 / +228 797**, minutos aprobados y productivos, los tres
`timeHash`, coste-hora y Hamilton por parte, absorción **−22 787 c / −86 bps**,
FTE·mes, las 17 + 18 líneas de liquidación y el forecast de doce meses.

```
VEREDICTO: DISCREPANCIA
Cifras reconstruidas: | budgetHash BASE/REV1 v1.1 | c32cdecf…/dc11871c… | idénticos | 0 | Python, forma canónica nueva |
                      | Desviaciones INGRESOS/MC3/EBITDA | −76 400/+63 350/+228 797 | idénticas | 0 | SQL + Python |
                      | Absorción total | −22 787 c / −86 bps | idéntica | 0 | Σ valorado − Σ 64x |
                      | Absorción por CECO (fixture) | Σ −2 640 000 c | esperado −22 787 c | ≠ | Σ filas byCostCenter |
                      | Nómina de 2026-12 para I-E10-12 | −2 640 000 c | +0 c (sin REGULARIZATION) | ≠ | SQL por entry_kind |
                      | Provenance MC3 PROJ:P-01 | −4 484 000 c | 0 filas en sus dos consultas | ≠ | ejecutadas contra la BD |
Hallazgos: 1. I-E10-12 FAIL con datos íntegros: la nómina de la guarda no excluye
  REGULARIZATION/CLOSING/OPENING (models/budget-invariants.ts:453-465).
  2. H-5 cerrado en el producto pero NO en el fixture sellado v1.1 (build_absorption
  del generador sin tocar): el contrato congelado de D6 contradice al motor.
  3. H-7 parcial: las consultas por celda reproducen la CONTRIBUCIÓN del nivel, no la
  celda acumulada, y fijan una celda anual a enero ⇒ 0 filas salvo en el nivel base.
  4. La inyección (b) no la detecta ningún I-E10-* sin un run con driver de actividad.
  5. CERRADOS y re-verificados: H-1, H-2, H-3, H-4, H-6 y D7.
Trazabilidad: FALLO PARCIAL — desviación MC3 de PROJ:P-01 (−4 484 000 c): las dos
  consultas que el run entrega devuelven 0 filas; sólo se llega al origen escribiendo
  uno mismo la consulta acumulada. En INGRESOS la provenance sí cuadra al céntimo.
Recomendación: filtrar entry_kind en readPayrollAbsorption y volver a correr el
  barrido; regenerar el bloque de absorción del fixture v1.1; acumular niveles y
  abrir el rango de meses en las consultas de provenance por celda.
```

---

# Verificación final (ronda 2, `aa7a7d0…0e9c5c8`)

```
VEREDICTO: DISCREPANCIA (residual, no bloqueante salvo el punto 1)
Cifras reconstruidas: | budgetHash BASE/REV1 v1.2 | idénticos | 0 | Python, forma canónica |
  | Desviaciones INGRESOS/MC3/EBITDA | −76.400/+63.350/+228.797 | idénticas | 0 | SQL+Python |
  | Absorción total y Σ byCostCenter v1.2 | −22.787 c / −86 bps | idénticas | 0 | Σ filas = total |
  | Provenance MC3 PROJ:P-01 | real 316.000 = actualCents · ppto 4.800.000 = budgetCents · horas 72.000 min · imputado 28.755 | idénticas | 0 | 4 consultas del run ejecutadas tal cual |
  | Las 8 cifras de la ronda 0 sobre v1.2 | idénticas | 0 | scripts propios |
Hallazgos: 1. I-E10-12 SIGUE dando FAIL con datos íntegros. El `entry_kind` está
  arreglado (diciembre ya no sale a −2.640.000 c), pero `readPayrollAbsorption`
  cuenta como «personal imputado por horas» TODA línea de allocation con driver
  HOURS a proyecto, sea cual sea la cuenta de origen, y compara MES A MES: con la
  regla del propio diseño (AL-OPS-M reparte CC-OPS, cuenta 628) el barrido da
  «2026-11: 91890 c imputados sobre 0 c contabilizados en 64x». Y mide otra cosa
  que el fixture, que compara el AÑO valorado a tarifa (2.617.213 ≤ 2.640.000).
  2. Menor: el desglose de absorción cuadra en total pero cruza dos claves (lo
  valorado por CECO del empleado, la nómina por dimensión de la línea), así que
  2.244.000 c caen en `SIN_CECO` y CC-OPS luce +1.436.857 c de sobreabsorción.
  3. CERRADOS y re-verificados: H-1, H-2, H-3, H-4, H-5, H-6, H-7, D7 y las
  inyecciones — (a) 1 c / 1 min ⇒ I-E10-6 FAIL; (b) parte aprobado alterado ⇒
  I-E10-17 FAIL («el run está CADUCADO») + I-E10-3 FAIL; (c) allocation_line de
  1 c ⇒ I5, I-E5-9 e I-E5-12 FAIL. Sello `REQUIERE REVISIÓN` en los tres casos.
Trazabilidad: OK. Las cuatro consultas del `byCell` reproducen la celda al céntimo
  sin escribir nada: 316.000 − 28.755 = 287.245 y 4.800.000 − 900.000 = 3.900.000.
Recomendación: acotar `imputado` de I-E10-12 a los repartos cuyo origen son cuentas
  64x y compararlo contra el ejercicio, no contra el mes; alinear la definición con
  la del fixture. Sin eso la guarda deja en REQUIERE REVISIÓN a quien use el driver
  HOURS sobre un CECO que no es de personal — el caso del propio diseño.
```
