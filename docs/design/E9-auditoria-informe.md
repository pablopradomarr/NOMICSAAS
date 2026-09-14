# E9 — Informe de auditoría de fiabilidad (cierre y recurrentes)

Auditor: `auditor-fiabilidad`, contexto limpio. Diff auditado `51608bb…HEAD`.
Método: reconstrucción por camino distinto — Python/`decimal` propio y SQL directo
contra una base aislada `erp_audit_e9` (clon de `erp_test`). **No** se ha reutilizado
`lib/closing/**`, `lib/recurring/**` ni las plantillas para reconstruir ninguna cifra;
esos módulos sólo se han ejecutado como *sujeto* de la comparación.

## 1. Entradas y montaje

| Pieza | Uso |
|---|---|
| `docs/design/fixtures/{cuadros,periodificaciones,liquidacion-iva,valor-actual}-esperada*.json` | Casos sellados; reconstruidos a mano en Python |
| Generadores `--check` | Los cuatro reproducen su JSON byte a byte |
| `tests/integration/e9-cierre-completo.test.ts` | Cierre real de un ejercicio (org `e9cc…001`), conservado con `E9_KEEP=1` |
| Organización propia `aud-e9` | 3 activos (uno con revisión, uno vendido, uno normal), periodificación 480 ACT/ACT, préstamo con `DebtSchedule` de 4 vencimientos, posición monetaria en USD y anticipo `407` no monetario |
| `postgres` (SQL de verificación) y `app_runtime` (denegaciones/RLS) | Roles separados |

Todo lo creado se ha eliminado al terminar (base `erp_audit_e9` borrada, ficheros de
prueba temporales borrados). No se ha tocado producto ni fixtures.

## 2. Cifras reconstruidas (tolerancia 0)

| # | Métrica | Motor | Reconstrucción propia | Δ |
|---|---|---|---|---|
| 1 | Cuadros de amortización, 8 casos / 164 filas + `scheduleHash` | filas y hashes | idénticas (lineal, mes entero, residuo a la última, revisión prospectiva) | **0** |
| 2 | Amortización 2026 contabilizada por activo (`journal_lines.fixed_asset_id`) | A1 600 000 · A2 1 053 655 · A3 320 000 | idem desde mi cuadro Python | **0** |
| 3 | Baja/venta: `2811`/`671`/`771` = precio − VNC | C6 671 766 676 · C7 771 140 000 · A3 671 180 000 | idem | **0** |
| 4 | Periodificación 480 ACT/ACT (prima 100 000, 15-11-26 → 14-11-27) | 12 876 / 87 124 | 12 876 / 87 124 | **0** |
| 5 | Casilla 71 = importe de T-23, cuatro liquidaciones (trimestral, mensual con DUA, con prorrata, RECC) | 39 500 · 420 000 · 114 000 · 86 776 | idem, recompuestas desde el libro registro | **0** |
| 6 | Prorrata definitiva y ajuste (O-9/O-10) | 8 700 bps · +7 000 (y −5 000, 8 800 bps) | `ceil(num·100/den)`, `trunc(prorrateable·bps)` | **0** |
| 7 | Valor actual e I-E9-19 (V1…V7) | Σ intereses = descuento; último *carrying* = nominal | `Decimal` exacto: desviación < 1 céntimo por truncamiento documentado | **0** |
| 8 | Diferencia de cambio `400` USD: `D×r − S` | +10 000 → `400 (D) / 768 (H)`; tras T-30, `D×r − S = 0` | +10 000 | **0** |
| 9 | `129` tras T-26 = PyG del ejercicio | 525 000 | 525 000 (1 050 000 + 50 000 − 400 000 − 175 000) | **0** |
| 10 | Reserva legal (O-18, R2-2) con capital del saldo de `100` | 149 732 | `min(10 % · 1 497 322; 20 % · 3 000 000 − 400 000)` | **0** |
| 11 | **Reclasificación 173 ↔ 523 al 31-12-2026** | `523 (D) 500 000 / 173 (H) 500 000` | `173 (D) 500 000 / 523 (H) 500 000` | **signo invertido** |

Cuadres verificados por SQL sobre el cierre real: I-E9-12 (todas las 6/7 —`6300`
incluida— a 0 tras T-26), I-E9-13, cierre deja todo a 0, I-E9-14 (apertura = cierre
línea a línea, 7/7 cuentas espejo), orden O-17 (T-25 nº 8 → T-26 nº 9 → T-27 nº 10 →
T-28 nº 1 de N+1), T-25 con `6300 (D) 175 000 / 473 (H) 50 000 / 4752 (H) 125 000`
(cancelación de `473`, O-26), numeración correlativa sin huecos, y recurrentes
idempotentes (3 ocurrencias `GENERADA` con asiento; repetir no duplica).

## 3. Hallazgos

### H-1 · BLOQUEANTE — la reclasificación corriente / no corriente se postea con el signo invertido

`lib/closing/reclass.ts` documenta `MaturityPosition.openCents` como **debe − haber**
(`debtor = openCents > 0`; su propia evidencia declara
`sum(l.debit_cents - l.credit_cents) AS abierto`, y `reclass.test.ts:128` usa
`openCents: -500_000` para un `173`). Pero `models/closing.ts:readMaturityPositions`
devuelve `SUM(credit_cents - debit_cents)` y los **dos** llamantes lo pasan tal cual:

- `app/(app)/ledger/closing/actions.ts` (~línea 470) — el asiento T-32 que se postea;
- `models/closing.ts:1097` — el paso `RECLASIFICACION_VENCIMIENTOS` del checklist.

Evidencia (base aislada, préstamo de 1 500 000 con 500 000 venciendo en 2027):

```
523 | 200000 D | 2027-03-31      esperado: 173 (D) / 523 (H)
173 |        H | 200000
523 | 300000 D | 2027-09-30
173 |        H | 300000
saldos finales: 173 = 2 000 000 (H)   523 = −500 000 (saldo DEUDOR)
```

El pasivo no corriente se infla por el importe reclasificado y el corriente queda
**negativo**. Es exactamente el error que R-RC-4 dice que un auditor comprueba primero,
y es **silencioso**: I-E9-16 (`Σ largo + Σ corto` invariante) sigue cuadrando y el paso
del checklist sale `PASS`. La propia evidencia del producto lo delata cuando se borra
el cuadro: *«Deuda viva de 17x/52x SIN cuadro: 173 2000000 c, 523 -500000 c»*.

### H-2 · BLOQUEANTE — los 26 invariantes I-E9-* no se ejecutan nunca

§6.3 dice que entran en `runLedgerInvariants`, en `InvariantRun`, en
`ReportRun.validation` y en `/audit` bajo la familia `CIERRE`.
`lib/ledger/invariants.ts:536` los ejecuta sólo `if (input.closing)`, y
**`models/ledger.ts` (montaje de `InvariantInput`, ~líneas 2137-2185) nunca rellena
`closing`**. Verificado en la base: sobre el ejercicio realmente cerrado,
`select count(*) from invariant_runs, jsonb_array_elements(checks) c where c->>'id' like 'I-E9%'`
→ **0 de 215 checks**; y ningún `closing_runs.steps` contiene un id `I-E9-*`.

Consecuencia: I-E9-1…26 son código muerto en producción. Tienen tests unitarios, pero
ninguna de las garantías de tolerancia 0 del cierre está realmente vigilada sobre datos
reales — incluida I-E9-16, que es la que debería haber cazado H-1.

### H-3 · BLOQUEANTE — la reapertura del ejercicio es imposible

`models/fiscal-years.ts:641` recorre `REOPENING_REVERSAL_ORDER`
(`APERTURA_EJERCICIO → CIERRE_EJERCICIO → REGULARIZACION_RESULTADO → IMPUESTO_BENEFICIOS`)
y llama a `voidEntryInTx` → `buildReversal`, que aplica **CA-1**
(`lib/ledger/void.ts:35`: `NON_REVERSIBLE_KINDS = {OPENING, CLOSING, REGULARIZATION}`).
Sobre el ejercicio realmente cerrado:

```
reopenFiscalYearAction → «Los asientos de tipo OPENING no se anulan con contra-asiento»
```

D1/O-21 y I-E9-21 son inalcanzables. El test que cubre O-21
(`tests/integration/e9-acciones.test.ts:386`) pasa **en vacío**: fuerza
`status: CLOSED` sobre un ejercicio que no tiene ninguno de los cuatro asientos, el
bucle no encuentra objetivo y nunca llega al contra-asiento. En consecuencia no ha sido
posible verificar el resto del punto 5 (no duplicar el IS al recerrar,
`PENDIENTE_RECOMPUTO`, numeración viva tras la reapertura).

### H-4 · MENOR — el desempate declarado del FIFO no está cableado

Los dos llamantes pasan `entryNumber: 0` para todas las posiciones (R-RC-3 exige
desempate por `entryNumber`, P7). Es inocuo hoy porque el eje viene agregado por
`(cuenta, contraparte, divisa, vencimiento)` y no puede haber empate dentro del grupo,
pero la garantía declarada no existe si el agregado cambia.

### H-5 · MENOR — aviso de partidas no monetarias inalcanzable

`readFxPositions` ya filtra por `accounts.is_monetary`, así que
`result.excludedNonMonetary` llega siempre vacío y el aviso de O-4/I-E9-24 nunca se
muestra. La exclusión **sí funciona** (el anticipo en `407` USD quedó fuera del
barrido, verificado por SQL); lo que no llega al usuario es la explicación.

### H-6 · MENOR — alterar un `DebtSchedule` tras el cierre no lo detecta nadie

Cambiar `debt_installments.due_date` después de posteado T-32 se acepta sin traza y el
paso vuelve a salir `PASS`. Sólo el borrado completo del cuadro produce `FAIL`
(I-E9-25 por existencia). Con H-2 encima, no hay invariante que lo compare.

### Lo que resistió el ataque (positivo)

- **Alterar una cuota `68x` contabilizada por SQL: rechazado por la base** con
  `23514 · «una línea posteada solo admite reclasificación analítica (ADR-0010)»`,
  incluso como `postgres`. La manipulación no llega a necesitar invariante.
- **Asiento en un ejercicio `CLOSED`**: rechazado, `23514`.
- **`UPDATE` sobre `closing_runs` como `app_runtime`**: `42501` (append-only).
- **Borrar las liquidaciones de IVA**: `IVA_LIQUIDADO` pasa a `FAIL` nombrando los
  cuatro periodos.
- **Tenant**: como `app_runtime` con `app.current_org` fijado, 0 filas visibles de otras
  organizaciones en `journal_lines`, `fixed_assets` y `closing_runs` (103 propias / 103
  totales).
- **Trazabilidad**: de `IVA_LIQUIDADO: FAIL` a los periodos, y de `6300 = 175 000` al
  asiento T-25 y de ahí al asiento nº 7 origen de la retención en `473`, en segundos.
  Salvedad: `closing_runs.income_tax_entry_id` quedó a `NULL` tras relanzar el
  checklist, así que el sello del run no sirve de puerta de entrada; hubo que ir por
  `template_code`.

### Observaciones no bloqueantes de contenido

- L1 casilla 28 incluye la base de una factura del art. 96 con cuota deducible 0
  (700 000 = 400 000 + 100 000 + 200 000). Es defendible, conviene dejarlo escrito.
- L4 (RECC) usa base en periodo = cobro − cuota devengada (413 224) en vez del
  proporcional puro (413 223), para que base + cuota = cobro exacto. Correcto y
  determinista; merece una línea en la norma de valoración.

## 4. Alcance no cubierto

Por H-3 no se ha podido ejercer la reapertura real ni el recierre. El punto 4 se ha
verificado sobre el cierre real de la organización del test de integración (sin FX ni
deuda) y los puntos de FX/reclasificación sobre la organización propia, cuyo cierre no
se completó porque su diario se sembró por SQL (`I-E3-7` de `entry_hash` y los I-E4 de
analítica salen `FAIL`, artefacto del montaje del auditor, no del producto).

## 5. Recomendación

1. Corregir el signo de `readMaturityPositions` (o negar en los dos llamantes) y añadir
   un test que compruebe la **dirección** del asiento T-32 sobre un pasivo real.
2. Cablear el bloque `closing` en `models/ledger.ts` para que los I-E9-* corran de
   verdad; sin eso, ninguna de las garantías de tolerancia 0 del cierre está vigente.
3. Permitir el contra-asiento de `OPENING`/`CLOSING`/`REGULARIZATION` **sólo** por la
   vía de la reapertura registrada, y rehacer el test de O-21 sobre un ejercicio con
   sus cuatro asientos.

---

# Re-auditoría (ronda 1) — diff `98e89cc…5632ee5`

Base aislada `erp_audit_e9` (clon de `erp_test`, 54 migraciones), organización propia
montada **por `postEntry`** —el camino de la aplicación— con tres activos (uno con
revisión, uno vendido), periodificación `480`, préstamo con `DebtSchedule` de cuatro
vencimientos, posición monetaria en USD y anticipo `407` no monetario, cierre real,
reapertura y recierre. Reconstrucción en Python/`decimal` y SQL propios. Todo borrado
al terminar.

## Estado de los hallazgos de la ronda 0

| # | Estado | Evidencia |
|---|---|---|
| **H-1** signo de T-32 | **CORREGIDO** | T-32 postea `173 (D) 200 000 / 523 (H) 200 000` y `173 (D) 300 000 / 523 (H) 300 000`; saldos al corte `173 = 1 000 000`, `523 = 500 000` — exactamente mi FIFO recalculado (frontera 2027-12-31: 200 000 + 300 000 corriente, 400 000 + 600 000 no corriente) |
| **H-2** I-E9-* muertos | **CORREGIDO, con reserva** | 29 checks `I-E9-*` en el barrido y en `InvariantRun`. Ver R-1 |
| **H-3** reapertura imposible | **CORREGIDO** | `voidEntry` público sobre el `CLOSING` → `CA-1` («se deshacen reabriendo el ejercicio»); como `app_runtime` con `SET LOCAL app.reopening_run_id` inventado, el `INSERT` → **23514**; la vía registrada devuelve los **cuatro** contra-asientos (T-28, T-27, T-26, **T-25**), `pendingRecompute = [VALOR_ACTUAL_APLAZAMIENTO, DIFERENCIAS_DE_CAMBIO, RECLASIFICACION_VENCIMIENTOS]`, run `REABIERTO` + sello `REQUIERE_REVISION` + `CIERRE_REABIERTO`, y numeración viva y sin huecos (2026: 1–49; 2027: 1–6, con el `OPENING` anulado conservando su nº 1) |
| **H-4** `entryNumber: 0` | **CORREGIDO** | `readMaturityPositions` devuelve `first_entry_number` y los dos llamantes lo pasan |
| **H-5** aviso de no monetarias | **SIN CAMBIO** (menor) | `407` sigue correctamente fuera del barrido; el aviso sigue sin poder emitirse |
| **H-6** cuadro alterado | **CORREGIDO** | Cambiar `debt_installments.due_date` tras el cierre → **I-E9-25 FAIL** nombrando `PREST-1` con hash sellado vs recomputado; al restaurar, `PASS` |

## Hallazgos nuevos

### R-1 · BLOQUEANTE — el recierre tras una reapertura no postea nada y sella un estado falso

Los cuatro contra-asientos de la reapertura se fechan **01-01-2027** (la fecha de
reversión se empuja al primer periodo abierto, porque el cierre bloqueó el mes 12 de
2026), mientras que los asientos que anulan son de **31-12-2026**. Visto desde dentro
del ejercicio 2026, el T-25/T-26/T-27 anulado **sigue plenamente en vigor**:

```
saldos 6/7 al 2026-12-31 tras la reapertura:  621=0  6300=0  671=0  6813=0  705=0  768=0
```

`closeFiscalYear` decide con `getAccountBalances(upTo: 31/12/2026)`: no ve saldo de
6/7, **omite T-26, T-27 y T-28** y aun así pone `status = CLOSED` y el `ClosingRun` en
`CERRADO`. Resultado medido del recierre: `entryIds = {regularizacion: null, cierre:
null, apertura: null}`, ningún asiento nuevo, **2026 cerrado sin regularizar, sin
asiento de cierre y sin apertura de 2027**, con `129 = 0` y el `OPENING` de 2027
anulado y no regenerado. Es silencioso: los nueve bloqueantes salen `PASS`.

Dos corolarios: **I-E9-21** («el saldo de cada cuenta de los grupos 1 a 7 vuelve al
previo al cierre») es **falso dentro del ejercicio** y no lo detecta porque devolvió
`INFO` en todos los barridos; y «no duplicar el IS al recerrar» se cumple sólo por
vacuidad —no se postea ningún IS— (`6300`: 4 líneas, debe = haber = 1 473 172, neto 0,
0 asientos de impuesto vivos).

### R-2 · ALTO — I-E9-16 sigue sin poder cazar el signo invertido en una organización nueva

Los 22 pares de reclasificación se siembran **sólo por el backfill** de la migración
`20260920120000_e9_cierre`; ningún código los crea para una organización dada de alta
después. Con `reclassification_pairs` vacía —el caso de mi organización, `0` filas—
`readClosingInvariantInput` deriva `accountCodes = []`, no lee ninguna posición y
**I-E9-16 devuelve PASS sobre el conjunto vacío**, mientras la *acción* sí reclasifica
porque cae al *fallback* de las constantes `RECLASS_PAIRS`. Comprobado en las dos
direcciones: reintroducido el signo invertido por SQL sobre las líneas de T-32,

- con la tabla vacía → `I-E9-16: PASS`;
- sembrado el par `173/523` → `I-E9-16: FAIL · «173/sin contraparte vence 2027-03-31 ≤ 2027-12-31 y sigue en la cuenta de largo»`.

El invariante es correcto; lo que falla es que su universo puede quedar vacío justo en
la organización donde el asiento sí se postea.

## Cifras verificadas de nuevo (tolerancia 0)

Las **once** de la ronda 0 se rehicieron contra el motor actual: cuadros de
amortización (8 casos, 164 filas y `scheduleHash`), periodificaciones (9 casos),
las cuatro liquidaciones de IVA con sus **176 casillas** y la 71 = T-23
(39 500 / 420 000 / 114 000 / 86 776), las cinco prorratas, RECC, las cinco guardias
de bienes de inversión y los siete valores actuales — **Δ = 0 en todas**; la única
diferencia frente al sellado es un campo `evidencia` nuevo, sin efecto numérico. Los
cuatro generadores `--check` siguen reproduciendo su JSON byte a byte.

Sobre el cierre real de esta ronda, recalculado a mano: resultado antes de impuestos
`6 060 000 − 3 113 655 = 2 946 345` (el motor: 29 463,45 €), cuota `25 % ⇒ 736 586`,
`4752 = 736 586 − 50 000 = 686 586`, `129 = 2 209 759` = Σ 6/7 del ejercicio; **todas
las 6/7 a 0 tras T-26**, el cierre deja **0** cuentas con saldo, y la apertura es el
espejo exacto del cierre en **13 de 13** cuentas.

**Paso 12 de O-17** ✓: el contra-asiento de T-32 es el asiento **nº 2 de 2027**,
después del `OPENING` (nº 1), y es el espejo exacto: `173 (H) 200 000 / 523 (D)
200 000` y `173 (H) 300 000 / 523 (D) 300 000`.

**Caso A de D7 — 442 817 confirmado.** Con el único tipo mensual de D7.3
(`i_m = 48 675 506` micro-bps, y `(1+i_m)^12 = 1,06000000` exacto), devengando diez
meses sobre el coste amortizado desde `PV = 8 899 964` con truncamiento mensual:
`43 321 + 43 531 + 43 743 + 43 956 + 44 170 + 44 385 + 44 601 + 44 818 + 45 036 +
45 256 = 442 817`. Las demás cifras del caso también cuadran: descuento 1 100 036,
amortización bruta 10 m 1 666 660, corregida 1 483 320, exceso 183 340. El antiguo
454 133 no es reproducible con ninguna de las dos convenciones (al nominal 6 %/12 da
455 139), lo que confirma la explicación de la nota del ADR.

## Inyecciones (a)–(e)

| Ataque | Resultado |
|---|---|
| (a) alterar una cuota `68x` por SQL | **rechazado, 23514** (ADR-0010), incluso como `postgres` |
| (b) borrar las liquidaciones de IVA | `IVA_LIQUIDADO` → **FAIL** con los cinco periodos nombrados |
| (c) `UPDATE` de `closing_runs` como `app_runtime` | **42501** (append-only) |
| (d) asiento en ejercicio `CLOSED` | **rechazado, 23514** |
| (e) alterar `debt_installments` tras el cierre | **I-E9-25 FAIL** (hash sellado ≠ recomputado) |
| tenant | `app_runtime` con `app.current_org`: **0** filas de otras organizaciones |

## Recomendación

1. **R-1**: fechar los contra-asientos de T-25/T-26/T-27 **dentro** del ejercicio que
   se reabre (desbloqueando el mes 12 en la misma transacción), o hacer que
   `closeFiscalYear` excluya los asientos con `voidedAt` al calcular los saldos; y
   negarse a marcar `CLOSED` cuando no se ha posteado T-27. Hacer que **I-E9-21** deje
   de salir `INFO` para que cace este caso.
2. **R-2**: sembrar los 22 pares al dar de alta la organización (o dar a
   `readClosingInvariantInput` el mismo *fallback* a `RECLASS_PAIRS` que ya tiene la
   acción), para que I-E9-16 no pueda pasar por vacuidad.

---

# Verificación final — diff `5632ee5…43386eb`

Base aislada `erp_audit_e9` (clon de `erp_test`, 57 migraciones), organización nueva
montada por `postEntry`, con **0 filas** en `reclassification_pairs` (el caso que
destapó R-2). Reconstrucción propia en Python/`decimal` y SQL. Todo borrado al terminar.

| Comprobación | Resultado |
|---|---|
| **R-1 · reapertura y recierre** | Los contra-asientos se fechan **31-12-2026**, dentro del ejercicio reabierto, y **heredan el kind** (nº 50 `CLOSING`, 51 `REGULARIZATION`, 52 `REVERSAL` de T-25; nº 3 de 2027 `OPENING` de T-28). Dentro de 2026 los grupos 6/7 vuelven a su saldo previo (`705 = 6 050 000`, `6813 = −1 973 655`…), `129 = 0`, `6300 = 0`, y **I-E9-21 sale PASS** con evidencia (antes `INFO`). El recierre postea **cuatro asientos nuevos** (nº 53 T-26, 54 T-27, 2027 nº 4 T-28) y deja 2026 `CLOSED` |
| **129 y PyG** | PyG del ejercicio recalculada por SQL (espejos neutralizándose entre sí) = **2 946 345** = `129` del asiento de cierre nuevo. `6300` neto = **0** porque la reapertura anuló T-25 y el paso 8 no se repitió; ningún asiento descuadrado (0) |
| **Apertura y numeración** | Apertura de 2027 **regenerada** y cuadrada (9 950 000 = 9 950 000); espejo exacto del cierre en **14 de 14** cuentas; con todos los asientos, el ejercicio cierra a **0 en todas** las cuentas; numeración viva y sin huecos (2026: 1–54; 2027: 1–4, con el `OPENING` anulado conservando su nº 1) |
| **R-2 · I-E9-16** | Con `reclassification_pairs` **vacía**, invertido T-32 por SQL → **I-E9-16 FAIL** («173 vence 2027-03-31 ≤ 2027-12-31 y sigue en la cuenta de largo», y la de 2027-09-30); restaurado → **PASS**. El *fallback* a `RECLASS_PAIRS` cierra el hueco |
| **H-5** | El aviso ya se emite: «407 en USD queda fuera del barrido: la cuenta no es monetaria en el plan (O-4, I-E9-24)» |
| **Puertas de la reapertura** | `voidEntry` público sobre el `CLOSING` → **CA-1**; como `app_runtime` con `app.reopening_run_id` **inventado** → **23514**; con el de **otro tenant** → **23514**; tenant: 0 filas ajenas |
| **Las 11 cifras** | Δ = **0** en todas: 8 cuadros (164 filas + `scheduleHash`), 9 periodificaciones, 4 liquidaciones con sus 176 casillas y la 71 = T-23, 5 prorratas, RECC, 5 guardias de bienes de inversión, 7 valores actuales. Los cuatro generadores `--check` siguen byte a byte. Caso A de D7.3: **442 817** recomputado a mano |

**Observación menor (no bloqueante).** Tras una reapertura, el recierre **no repone
T-25**: `IMPUESTO_BENEFICIOS` no es uno de los nueve bloqueantes, así que el ejercicio
se puede volver a cerrar sin impuesto corriente (`129` pasa a ser el resultado **antes**
de impuestos, aquí 2 946 345 frente a 2 209 759). Es coherente y visible en el
checklist, pero conviene que el paso salga marcado como pendiente tras reabrir.

```
VEREDICTO: CONFORME
```
