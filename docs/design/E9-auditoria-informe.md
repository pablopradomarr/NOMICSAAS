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
