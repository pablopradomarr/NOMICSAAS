# E5 — Auditoría adversarial de la liquidación de CECOs

> Rol: `auditor-fiabilidad` (SPEC-FIABILIDAD C4 capa 2), contexto limpio. Fecha: 2026-09-06.
> Objeto auditado: `git diff ab9fb99...HEAD` — `lib/analytics/allocate.ts`, `models/allocations.ts`,
> `lib/analytics/invariants.ts`, `lib/analytics/margins.ts`.
> Entradas: `tests/fixtures/ejercicio-completo.json` (inmutable) · `docs/design/fixtures/pyg-analitica-esperada.json`
> · `docs/design/fixtures/liquidacion-esperada.json` · `docs/design/E5-liquidacion.md` ·
> `docs/design/E5-validacion-liquidacion.md` · ADR-0013 · I5 de `.claude/skills/fiabilidad/SKILL.md`.
> **Reconstrucción independiente**: Python entero propio sobre `journal_lines` leídos por SQL
> (`psql`, rol propietario). **No** se ha usado `lib/analytics/allocate.ts`, `lib/analytics/margins.ts`
> ni `docs/design/fixtures/build_liquidacion_esperada.py`. No se ha recibido ni leído razonamiento del
> productor más allá de los documentos de diseño citados.

## 0. Método y entorno

1. Base limpia `erp_audit` (copia del esquema de `erp` con `pg_dump -s`), organización
   `aa000000-…-0001`, carga del fixture con `scripts/load-fixture.ts --ref-date 2027-01-31`
   (84 asientos, Σdebe = Σhaber = 67 193 629, `ledgerHash cb9c8744…`).
2. Alta de las **seis reglas** del diseño (§5.1 del documento del experto) por `createAllocationRulesTx`
   y **sellado de los 17 runs** (12 MONTH, 4 QUARTER, 1 YEAR) por `sealAllocationRunTx` — el motor real,
   ejecutado desde un script tsx del scratchpad, para producir el resultado que se audita.
3. Reconstrucción independiente en Python (drivers, doble Hamilton, cascada, base por nivel) y
   comparación a **tolerancia 0** contra (a) `allocation_lines` de la BD y (b) `liquidacion-esperada.json`.
4. Inyección de errores por SQL como propietario y comprobación de qué invariante los detecta.

> **Incidencia de entorno (no imputable a E5).** La primera pasada se hizo sobre la base `erp`; a mitad
> de la auditoría **otra sesión lanzó `tests/e2e/liquidacion.spec.ts` contra la misma base**, y su
> `beforeAll` recargó el fixture con `--reset-org`, purgando reglas y runs de la organización de
> auditoría (`audit_logs`: `JournalEntry|post` ×168 en dos tandas). Todo se rehízo en `erp_audit`, aislada,
> con resultado idéntico — lo que de paso acredita **I-E5-12** (dos cargas y dos liquidaciones
> independientes producen las mismas 14 líneas). La organización `audit-e5` se ha dejado en `erp`
> porque la suite e2e concurrente la está usando como «organización analítica»; `erp_audit` se elimina
> al cerrar la auditoría.

## 1. Reconstrucción de las 14 líneas de reparto

Coinciden **las tres fuentes** (motor / reconstrucción / fixture esperado) en las diez columnas de cada
línea: importe, nivel, `driverBase`, `driverBaseTotal`, `driverShareBps` y `fallbackApplied`.

| Run | Regla | Fuente → destino | Nivel | Importe | Base driver | bps | Fallback |
|---|---|---|---|---:|---:|---:|---|
| 2026-11 | AL-OPS-M | CC-OPS → P-01 | MC3 | 53 577 | 1 734 000/2 974 000 | 5 830 | YTD |
| 2026-11 | AL-OPS-M | CC-OPS → P-02 | MC3 | 30 589 | 990 000/2 974 000 | 3 328 | YTD |
| 2026-11 | AL-OPS-M | CC-OPS → P-03 | MC3 | 7 724 | 250 000/2 974 000 | 840 | YTD |
| 2026-Q2 | AL-DEV-Q | CC-DEV → BL-CONS | MC3 | 60 000 | 6 000/10 000 bps | 6 000 | — |
| 2026-Q2 | AL-DEV-Q | CC-DEV → BL-DEV | MC3 | 40 000 | 4 000/10 000 bps | 4 000 | — |
| 2026-Q2 | AL-MKT-Q | CC-MKT → P-01 | EBITDA | 34 571 | 600 000/1 050 000 | 5 714 | — |
| 2026-Q2 | AL-MKT-Q | CC-MKT → P-02 | EBITDA | 25 929 | 450 000/1 050 000 | 4 285 | — |
| 2026 | AL-GA-OPS-Y | CC-GA → CC-OPS | EBITDA | 189 954 | 10 000/10 000 bps | 10 000 | — |
| 2026 | AL-GA-PRY-Y | CC-GA → P-01/02/03 | EBITDA | 147 742 ×3 | 1/3 | 3 333 | — |
| 2026 | AL-OPS-Y | CC-OPS → P-01 | EBITDA | 110 753 | 1 734 000/2 974 000 | 5 830 | — |
| 2026 | AL-OPS-Y | CC-OPS → P-02 | EBITDA | 63 233 | 990 000/2 974 000 | 3 328 | — |
| 2026 | AL-OPS-Y | CC-OPS → P-03 | EBITDA | 15 968 | 250 000/2 974 000 | 840 | — |

Total repartido **1 075 524 c** en 14 líneas; 14 de los 17 runs quedan vacíos, como declara el diseño.
Casos límite verificados por camino propio: **base cero** en `AL-OPS-M` de noviembre (ningún proyecto
tiene coste directo en el mes ⇒ `W-E5-ZERO-BASE` y ampliación `YTD` a enero–noviembre) y **base negativa**
de P-03 en `AL-MKT-Q` (ingresos netos −90 000 c en Q2 ⇒ peso 0, `W-E5-NEG-BASE`, reparto sólo entre
P-01 y P-02). Ambos avisos los emite también mi reconstrucción, con los mismos receptores.

También reproducidos de forma independiente: la exclusión de `74x` en `REVENUE_SHARE`, el desempate de
Hamilton por **menor código**, el reparto 30/70 del saldo de CC-GA por `sourceShareBps` (189 954 + 443 226
= 633 180) y la cascada CC-GA → CC-OPS → proyectos **conservando el nivel EBITDA** (E5-D1).

## 2. Invariantes reconstruidos

**I5.a** — Σ imputado = base liquidable, por (run, CECO fuente, nivel), **diff 0** en las 5 combinaciones:

| Run | Fuente | Nivel | Imputado | Base = own − yaRepartido + recibido |
|---|---|---|---:|---|
| 2026 | CC-GA | EBITDA | 633 180 | 633 180 − 0 + 0 |
| 2026 | CC-OPS | EBITDA | 189 954 | 0 − 0 + 189 954 |
| 2026-Q2 | CC-DEV | MC3 | 100 000 | 100 000 − 0 + 0 |
| 2026-Q2 | CC-MKT | EBITDA | 60 500 | 60 500 − 0 + 0 |
| 2026-11 | CC-OPS | MC3 | 91 890 | 91 890 − 0 + 0 |

**I5.b** — tras la liquidación completa, los cuatro CECOs imputables con regla (CC-OPS, CC-DEV, CC-MKT,
CC-GA) quedan a **0** en MC3 y en EBITDA; CC-OTR (imputable, sin saldo y sin regla) queda a 0 por vacío.
**I5.c** — CC-FIN, CC-EXT y CC-NA no aparecen ni como fuente ni como destino.

**I4 tras imputar** — los ocho totales de nivel coinciden **al céntimo** con `pyg-analitica-esperada.json`:
6 250 000 · 5 670 000 · 3 276 000 · 3 084 110 · 2 390 430 · 1 995 430 · 1 996 430 · **1 497 322**.

**EBITDA por proyecto reconstruido**: P-01 **−30 643** · P-02 **1 292 507** · P-03 **1 228 566**.
MC3 por proyecto: 262 423 / 1 529 411 / 1 392 276. Columnas `BL:` en MC3: BL-CONS −60 000, BL-DEV −40 000.
La matriz que devuelve el motor (`getAnalyticPnl` con `withAllocations`) da exactamente lo mismo.

## 3. Errores inyectados

| # | Alteración (SQL, rol propietario) | Qué la detecta |
|---|---|---|
| A | `amount_cents` 53 577 → 53 677 en una línea de `AL-OPS-M` | **I5** (`I5.b CC-OPS/MC3: quedan −100 c`), **I-E5-4** (importe fuera de `[floor, floor+1]`) e **I-E5-9** (la matriz suma 1 075 624 y los runs declaran 1 075 524). I4 sigue PASS, y es correcto: el Δ es de suma cero por nivel |
| B | Traslado del **céntimo de remanente** de Hamilton entre dos receptores del mismo run/regla/nivel (P-01 53 577→53 576, P-03 7 724→7 725) | **NADA.** `run-invariants` devuelve todo PASS/INFO. Ver hallazgo 1 |
| C | Asiento nuevo (628 / 4100, 10 000 c, CC-OPS) con fecha 2026-11-20 | **Sí**: el run anual y el de noviembre pasan a `STALE` («el diario del periodo ha cambiado; se ha reclasificado alguna línea del periodo»), el de Q2 no (correcto: no contiene noviembre); `analyticsHash` cambia ⇒ `analyticsKey` distinto ⇒ la PyG analítica cacheada se invalida; e **I5 pasa a FAIL** por los 10 000 c sin liquidar |
| D | `UPDATE` y `DELETE` sobre `allocation_lines` como `app_runtime` | Rechazados por `GRANT` (`permission denied for table allocation_lines`). Append-only efectivo (I-E5-11) |
| E | Reversión del run de noviembre (`reverseAllocationRunTx`) | Deja de aportar: MC3 de P-01 vuelve a 316 000 y CC-OPS conserva −91 890 pendiente; los runs vigentes bajan de 17 a 16 e I4 sigue PASS (**I-E5-9** correcto) |

## 4. Hallazgos

1. **(MEDIA) El sello del run no cubre sus propias líneas.** `AllocationRun` guarda
   `ledgerHash`, `analyticsHash`, `rulesHash` y `gitSha`, pero **ningún hash de los `AllocationLine`
   emitidos** (`docs/design/E5-liquidacion.md` §2.2; `models/allocations.ts:638` en adelante). En
   consecuencia el caso B es indetectable: un `UPDATE` directo que mueva el céntimo de remanente entre
   dos receptores mantiene Σ por (run, fuente, nivel), mantiene el cierre a 0, mantiene los importes
   dentro de `[floor, floor+1]` de I-E5-4 y mantiene el total del run — y **todos los invariantes de
   producción dan PASS** pese a que el reparto ya no es el que dicta el desempate por menor código
   (P7). Recomendación: añadir `linesHash` (sha256 de las líneas en forma canónica) al run y
   comprobarlo en Auditoría; con él, I-E5-12 deja de ser INFO y pasa a ser verificable sobre datos.
2. **(MEDIA) I5.a no se evalúa nunca en producción.** `checkI5` (`lib/analytics/invariants.ts:440`)
   comprueba I5.a recorriendo `input.balances`, y el único llamante real —`models/ledger.ts:1556`—
   construye el contexto de liquidación con `{ allocations, rules, runs }`, **sin `balances`**. El
   resultado es `combos = 0`: la evidencia del PASS lo declara («0 combinación(es)»). Sólo I5.b e I5.c
   protegen hoy la liquidación; I5.a existe en el motor y en los tests unitarios, no en el barrido.
3. **(BAJA) O-E5-7 implementado a medias en el camino de informes.** `analyticsKeyOf`
   (`lib/ledger/report-run.ts:72-78`) sigue nombrando su tercer componente `allocationRunId`, y
   `models/reports.ts:276` lo invoca **sin informarlo**, mientras el trigger
   `app.report_runs_analytics_key` compone la clave con `allocation_run_set_hash`. Hoy coinciden (∅ y
   columna NULL) porque el `ReportRun` de `PYG_ANALITICA` se construye siempre **sin** imputaciones
   (`models/reports.ts:428` llama a `getAnalyticPnl` sin `withAllocations`), de modo que la PyG
   analítica **sellada/exportable de E6 no incluye la liquidación**: sólo la ve la pantalla. El día que
   un informe se selle con imputaciones, la clave que calcula la aplicación y la que escribe el trigger
   divergirán y la caché dejará de acertar. Renombrar el parámetro y pasarlo cierra el riesgo.
4. **(BAJA) Techos aritméticos de la liquidación.** `amount_cents`, `driver_base` y `driver_base_total`
   son `integer`: el máximo representable es **21 474 836,47 €**. `driverBaseTotal` agrega la base de
   **todo un periodo**, así que un `REVENUE_SHARE`/`DIRECT_COST_SHARE` anual de una organización por
   encima de esa cifra —dentro del rango de producto declarado en `CLAUDE.md`, «hasta 100 M€»— hace que
   el sellado falle con `integer out of range`, un error crudo de base de datos. En el mismo terreno,
   `hamilton()` (`lib/analytics/allocate.ts:219-254`) opera con `number` (doble IEEE-754) sobre
   productos `A·wᵢ` que con esas magnitudes superan `2^53`; **no he encontrado contraejemplo en 4 000
   casos aleatorios** (importes ≤ 5 M€, pesos ≤ 20 M€) y la suma fue exacta en todos, pero la
   exactitud deja de estar garantizada *por construcción*, que es lo que exige §1.4 («prohibido float…
   todo el cálculo es aritmética entera»). `bigint` en las tres columnas y `BigInt` en el producto
   eliminan ambas dudas sin cambiar ningún resultado actual.

**Observación (no es un hallazgo de E5).** El saldo de CC-GA incluye 35 000 c de la cuenta **678
«Gastos excepcionales»** con `analytic_type = INDIRECTO_CECO` a nivel de línea (una de las 9 líneas del
fixture cuyo tipo de línea difiere del tipo por defecto de la cuenta), de modo que acaba imputada al
EBITDA de los tres proyectos. Es coherente con E4 y con la matriz esperada; se anota porque una
reclasificación de este tipo mueve resultado extraordinario a márgenes de proyecto y conviene que sea
una decisión escrita del `experto-contable`, no un efecto lateral del fixture.

## 5. Trazabilidad

Celda elegida: **EBITDA de P-01** (−30 643 c). Recorrido, dos consultas y **menos de un minuto**:

1. `getAllocationCellDetail({ level: "EBITDA", column: "PROJ:P-01" })` → **−293 066 c** en tres líneas,
   cada una con regla, run, base del driver y cuota: `AL-GA-PRY-Y` CC-GA −147 742 (1/3, 3 333 bps),
   `AL-OPS-Y` CC-OPS −110 753 (1 734 000/2 974 000, 5 830 bps), `AL-MKT-Q` CC-MKT −34 571
   (600 000/1 050 000, 5 714 bps). El detalle devuelve además la `query` y los `runIds` que la componen.
2. `getCellDetail({ level: "EBITDA", column: "CECO:G_A" })` → **−633 180 c** en 14 apuntes del diario
   con número de asiento, fecha, cuenta y nombre (621 Arrendamientos 120 000, 640 Sueldos 75 000,
   642 Seguridad Social 24 000, 678 Gastos excepcionales 35 000, 628 Suministros 81 680, …).

**Trazabilidad: OK.**

## 6. Reproducción

```bash
createdb -T … erp_audit && pg_dump -s erp | psql erp_audit          # base aislada
DATABASE_URL=…/erp_audit npx tsx scripts/load-fixture.ts --org <uuid> \
  --user <uuid> --fixture tests/fixtures/ejercicio-completo.json --ref-date 2027-01-31
DATABASE_URL=…/erp_audit npx tsx <scratchpad>/seal.ts               # 6 reglas + 17 runs sellados
python3 <scratchpad>/recon.py                                        # 14 líneas: motor = recon = esperado
python3 <scratchpad>/recon2.py                                       # I5.a/b/c, I4, EBITDA por proyecto
DATABASE_URL_MAINTENANCE=…/erp_audit npx tsx scripts/run-invariants.ts --org <uuid> --ref-date 2027-01-31
```

## 7. Veredicto

**CONFORME** en cifras: las 14 líneas de reparto, las 5 combinaciones de I5.a, el cierre a 0 de los CECOs
imputables, los 8 totales de nivel de I4 y el EBITDA de los tres proyectos se reconstruyen por camino
independiente con **diferencia 0 céntimos**. Los cuatro hallazgos son de **detección y de límites**, no de
importes: ninguno altera un número del ejercicio auditado. Los dos primeros deberían cerrarse antes de
que la liquidación se use sobre datos reales, porque hoy una alteración de suma cero dentro de un run
—o una I5.a que nunca se evalúa— dejaría de avisar.

---

# Re-auditoría — ronda 1 de correcciones (`17b8fe9…62ded40`)

> Rol: `auditor-fiabilidad`. Fecha: 2026-09-06. Base aislada `erp_audit2` (esquema de `erp` con la
> migración `20260910110000_e5_fixes` aplicada), fixture recargado y las seis reglas y los 17 runs
> vueltos a sellar con el motor real. Reconstrucción, otra vez, con el Python entero propio sobre
> `journal_lines`; ninguna función de `lib/analytics/` interviene en ella.

## R.1 Las cifras no se han movido (a)

Tras el paso a `BigInt`/`bigint`, motor = reconstrucción = `liquidacion-esperada.json` en las **14
líneas** y sus diez columnas; **I5.a** cuadra en las 5 combinaciones (diff 0); **I5.b** deja los cuatro
CECOs imputables a 0; los **8 totales de I4** siguen en 6 250 000 · 5 670 000 · 3 276 000 · 3 084 110 ·
2 390 430 · 1 995 430 · 1 996 430 · **1 497 322**; **EBITDA por proyecto** −30 643 / 1 292 507 / 1 228 566
y MC3 262 423 / 1 529 411 / 1 392 276. **Δ = 0 en todo.** El cambio de tipo no ha alterado ni un céntimo.

## R.2 Hallazgo 1 — CERRADO (b)

`allocation_runs.lines_hash` se persiste en los tres runs con líneas (p. ej. `9bbf141f…` en 2026-11) y
**I-E5-12 lo verifica sobre datos** («las líneas de 17 run(s) reproducen su linesHash sellado, desempates
incluidos»). Repetida la alteración de suma cero que en la ronda 0 era invisible —mover el céntimo de
remanente de Hamilton, P-01 53 577→53 576 y P-03 7 724→7 725, mismo run, misma regla, mismo nivel—:

```
I-E5-12  FAIL  run 3d1c4a1e…: las líneas de hoy hashean 2c370c1712ab… y el run selló 9bbf141f6ff0…
sello: REQUIERE REVISIÓN · motivos: […, «invariantes en FAIL: I-E5-12»]
```

Restaurados los dos importes, I-E5-12 vuelve a PASS y no queda ningún FAIL.

## R.3 Hallazgo 2 — CERRADO (c)

`run-invariants` sobre el fixture: **`I5 PASS · 5 combinación(es) (run, CECO fuente, nivel) con
diferencia 0 · 14 línea(s) de reparto`**. En la ronda 0 la misma evidencia decía «0 combinación(es)»:
I5.a se evalúa ahora de verdad en producción, con las mismas cinco combinaciones que reconstruí a mano.

## R.4 Hallazgo 3 — CERRADO (d)

Emitidos los dos `ReportRun` de `PYG_ANALITICA` del ejercicio:

| Informe | `allocation_run_set_hash` | 3.er componente de `analytics_key` | EBITDA P-01 |
|---|---|---|---:|
| sin imputaciones | NULL | `∅` | 316 000 |
| con imputaciones | `157a29cd4b99…` | `157a29cd4b99…` (idéntico) | **−30 643** |

Son dos runs distintos —la caché no sirve el uno por el otro— y la clave que compone la aplicación
coincide **carácter a carácter** con la que escribe el trigger `app.report_runs_analytics_key`. Al
**revertir** el run de noviembre, el conjunto vigente cambia (`2f8c547f5956…`), la caché caduca y se
emite un `ReportRun` nuevo con EBITDA de P-01 = **22 934** (= −30 643 + 53 577, el importe que la
liquidación revertida ya no imputa), mientras el total de nivel EBITDA sigue en 2 390 430: I4 aguanta.
Reemitir sin cambios sí devuelve el mismo run, luego la caché sigue sirviendo cuando debe.

## R.5 Hallazgo 4 — CERRADO (e)

En el ejercicio 2027, con las mismas reglas vigentes: CC-GA con **30 M€** de estructura y **60 M€** de
coste directo repartido 20/15/25 M€ entre los tres proyectos — todo por encima del techo de `integer`
(21 474 836,47 €). El run anual **se sella sin abortar**: 7 líneas, 3 900 000 000 c. Los repartos:

| Regla | Destino | Importe | Base driver |
|---|---|---:|---|
| AL-GA-OPS-Y | CC-OPS | 900 000 000 | 10 000/10 000 bps |
| AL-GA-PRY-Y | P-01/02/03 | 700 000 000 ×3 | 1/3 |
| AL-OPS-Y | P-01 / P-02 / P-03 | 300 000 000 / 225 000 000 / 375 000 000 | 2 000/1 500/2 500 M€ sobre 6 000 M€ |

`driver_base_total = 6 000 000 000` (2,8 × el techo antiguo) se persiste sin problema y el reparto
coincide **exactamente** con mi cálculo entero en Python; Σ = 900 000 000 = base. Los productos `A·wᵢ`
llegan a 2,25·10¹⁸, muy por encima de `2^53`: es justo el régimen en el que la aritmética en `double`
dejaba de estar garantizada, y `BigInt` lo resuelve. Nota honesta: en la ronda 0 no encontré
contraejemplo numérico con doubles; la corrección elimina el riesgo estructural, no un error observado.

> Comprobación colateral: tras revertir el run de noviembre (paso d), `I5` pasa a
> `FAIL — I5.b CC-OPS/MC3: quedan 91 890 c sin liquidar al cierre`. Es el residuo **real** de la
> reversión, no un falso positivo: el invariante hace exactamente lo que debe.

## R.6 Veredicto de la re-auditoría

```
VEREDICTO: CONFORME
Cifras reconstruidas: | Métrica | Motor | Reconstrucción | Δ | Método |
  | 14 AllocationLine (importe, nivel, bases, bps, fallback) | 1.075.524 c | 1.075.524 c | 0 | drivers + doble Hamilton + cascada propios en Python entero |
  | I5.a — 5 combinaciones (run, fuente, nivel) | = base | = base | 0 | own − yaRepartido + recibido desde journal_lines |
  | I4 — 8 totales de nivel | 1.497.322 c (RESULTADO) | 1.497.322 c | 0 | matriz por columna/nivel con Δ de imputación |
  | EBITDA por proyecto | −30.643 / 1.292.507 / 1.228.566 | idénticos | 0 | ídem |
  | Reparto > techo integer (2027) | 900.000.000 c en 3 cuotas | 300/225/375 M | 0 | Hamilton entero sobre bases de 6.000 M c |
Hallazgos: los cuatro de la ronda 0 quedan CERRADOS y verificados sobre datos (linesHash + I-E5-12;
  I5.a con 5 combinaciones; allocation_run_set_hash en el ReportRun, igual al del trigger, y caducidad
  al revertir; bigint/BigInt sin abortar y con reparto exacto). No aparecen hallazgos nuevos.
Trazabilidad: OK (sin cambios respecto de §5; el drill-down de la celda imputada sigue llegando a los
  apuntes de origen en dos consultas).
Recomendación: nada bloqueante. Dos apuntes menores para E7: (1) `lines_hash` queda NULL en runs
  anteriores a la migración e I-E5-12 los declara «sin sello» — conviene listarlos en Auditoría para que
  el hueco sea visible y finito; (2) `journal_lines.debit_cents/credit_cents` siguen en `integer`
  (21,47 M€ por apunte), coherente con ADR-0006 pero ahora asimétrico con la liquidación en `bigint`.
```
