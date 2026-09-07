# E7 — Informe de auditoría de fiabilidad (T21)

> Entregable del agente `auditor-fiabilidad`, en **contexto limpio**. Diff auditado
> `0ff2a77…HEAD` (76d84c1, 86c282d, c8ca5b3, 34f2802). No se ha usado
> `lib/audit/**` ni `lib/bank/**` para reconstruir: la reconstrucción es SQL
> directo contra Postgres y aritmética en Python
> (`scratchpad/reconstruct.py`, 100 % independiente del motor).
>
> **Veredicto: DISCREPANCIA.** Siete hallazgos, tres de severidad ALTA.

---

## 1. Entorno y escenario

Base aislada `erp_audit_e7`, clonada de `erp_test` (todas las migraciones
aplicadas, ACL de `app_runtime`/`app_maintenance`/`app_auth` idénticas a la
plantilla — verificado columna a columna tras cada restauración). Dos
organizaciones con `tests/fixtures/ejercicio-completo.json` cargado por
`scripts/load-fixture.ts`:

| | |
|---|---|
| **ORG A** | fixture + escenario bancario (abajo). Es la que se audita |
| **ORG B** | fixture **intacto**, sin banca. Referencia de las cuatro cifras y del `ledgerHash` congelado |

Escenario bancario de A, montado **por los caminos de la aplicación**
(`createAccount`, `postEntry`, `createBankAccount`, `importStatement`,
`createMatchGroup`, `ignoreLine`), nunca por `INSERT`:

- **`AUD-EUR`** sobre `5730001`, EUR, anclaje 2026-07-01 con saldo 0. Cadena de
  cuatro extractos Norma 43 contiguos (jul, ago, sep, oct–dic), 12 apuntes.
  Grupos vivos: **`UNO_A_N`** (remesa: 1 abono de 8 420,00 € contra 3 recibos) y
  **`N_A_N`** (2 líneas contra 2 apuntes). Un `IGNORED`
  (`NO_ES_NUESTRA_CUENTA`, −125,00 €), un apunte de 0,00 € nacido
  `IGNORED/IMPORTE_CERO`, ocho pendientes de banco y uno de libros (cheque).
- **`AUD-USD`** sobre `5740001`, **USD**, anclaje 2026-07-01. Apuntes con
  `originalCurrency: USD`, `originalAmountCents` y `exchangeRateId` (0,90 y 0,92),
  contravalor en EUR. Extractos N43 con divisa 840.

Fecha de corte de referencia: **2026-12-31**.

---

## 2. Cifras reconstruidas (tolerancia 0)

### 2.1 Conciliación `E − B = Ue − Ub` (I-E7-1, I-E7-11, I-E7-13)

Reconstrucción propia: `B` = `Σ(debit_cents − credit_cents)` de `journal_lines`
con `account_code LIKE '<cuenta>%'`, `entry_date ≤ D`, `entry_kind <> 'CLOSING'`
(la apertura **sí** entra); `E` = `opening_balance_cents` del extracto que cubre
`D` más sus apuntes hasta `D`; `Ue` = Σ de las líneas de extracto que no
pertenecen a ningún grupo vivo; `Ub` = ídem para los apuntes de la 57x.

| Cuenta | Métrica | Motor (`reconciliationSummary`) | Reconstrucción SQL/Python | Δ |
|---|---|---:|---:|---:|
| `5730001` (EUR) | `E` | 885 950 | 885 950 | **0** |
| | `B` | 869 000 | 869 000 | **0** |
| | `Ue` | −16 050 | −16 050 | **0** |
| | `Ub` | −33 000 | −33 000 | **0** |
| | `(E−B)−(Ue−Ub)` | 0 | 0 | **0** |
| | Σ ignorados | −12 500 | −12 500 | **0** |
| `5740001` (USD) | `E` | 350 000 | 350 000 | **0** |
| | `B` | 320 000 | 320 000 | **0** |
| | `Ue` / `Ub` | 350 000 / 320 000 | 350 000 / 320 000 | **0** |

Los pendientes enumerados por el motor coinciden uno a uno con los míos (el
motor excluye de la lista los `IGNORED`, que sí entran en `Ue` y se presentan en
su línea propia — conforme a O-12). El grupo `UNO_A_N` de la remesa cuadra por Σ
(842 000 = 400 000 + 242 000 + 200 000).

**La aritmética del cuadre EUR es correcta.** La discrepancia está en la cuenta
en divisa: véase **H-1**.

### 2.2 Las cuatro cifras del `headline` (O-19), sobre ORG B (fixture intacto), a 2026-12-31

| Métrica | Motor (`headlineFigures`) | Reconstrucción SQL | Referencia E6 | Δ |
|---|---:|---:|---:|---:|
| ACTIVO | **0** | **13 673 820** | 13 673 820 (`e6-reports.test.ts:177`) | **−13 673 820** |
| PN + PASIVO | **0** | **13 673 820** (PN 8 307 322 + pasivo 5 366 498) | PN 8 307 322 | **−13 673 820** |
| RESULTADO | 1 497 322 | 1 497 322 | 1 497 322 | 0 |
| TESORERÍA | 2 943 920 | 2 943 920 | 2 943 920 (572 2 913 920 + 570 30 000) | 0 |

Véase **H-2**. (Nota de encargo: la cifra 8 307 322 del enunciado es el **PN**,
no «PN + pasivo»; con el pasivo, `Activo = PN + Pasivo = 13 673 820` y **I2 se
cumple** en mi reconstrucción.)

---

## 3. Hallazgos

### H-1 · ALTA — Una cuenta bancaria en divisa cuadra mezclando monedas

`reconciliationSummary` obtiene `B` y `Ub` de `debit_cents − credit_cents`
(`lib/audit/invariants-e7.ts:355-372`, `lib/bank/types.ts:186`), que están en
**moneda base**, mientras `E` y `Ue` salen del extracto, que está en la **divisa
de la cuenta**. `models/bank.ts:642 listCashLines` ni siquiera lee
`original_amount_cents`, y `readBankInvariantInput` no aporta conversión alguna.

Evidencia (barrido real, cuenta `5740001` declarada en USD):

```
I-E7-1 PASS · 5740001: E 3500,00 € − B 3200,00 € = 300,00 €
              frente a Ue 3500,00 € − Ub 3200,00 € = 300,00 € · diferencia 0,00 €
```

`E` son 3 500,00 **USD** y `B` 3 200,00 **EUR**. La identidad se satisface
**trivialmente** porque nada está conciliado (`Ue` y `Ub` absorben todo), de
modo que I-E7-1 concede PASS a una cuenta cuyos dos lados están en monedas
distintas. En cuanto se intenta puntear, el servidor lo rechaza:

```
BankModelError: El grupo no cuadra: Σ extracto 100000 céntimos
  ≠ Σ (debe − haber) 90000 céntimos (I-E7-11/I-E7-2)
```

Consecuencia: **una cuenta en divisa sólo se puede conciliar si el contravalor
coincide céntimo a céntimo con el importe en divisa**, es decir, a paridad 1:1.
Con cualquier tipo de cambio real la conciliación es imposible y la cuenta queda
en un PASS vacío. Esto contradice ADR-0015 D6.2 y el propio §3.5 («el cuadre de
una cuenta en moneda extranjera se hace **en su divisa**»).

### H-2 · ALTA — `headline.activo` y `headline.pnMasPasivo` incluyen el asiento de cierre

`models/audit.ts:274-284`: `resultado` excluye `CLOSING/OPENING/REGULARIZATION` y
`tesoreria` excluye `CLOSING`, pero `activo` y `pn_mas_pasivo` **no filtran
`entry_kind`**. A fecha de cierre de ejercicio —el momento en que las cuatro
cifras se firman— el asiento de cierre deja ambas en **0,00 €** (tabla §2.2),
mientras el balance de E6 sobre el mismo estado da 13 673 820.

Efectos comprobados:
- La foto sellada del `InvariantRun` guarda `{"ACTIVO":{"cents":0}, "PN_MAS_PASIVO":{"cents":0}}`
  con provenance que apunta a una consulta que sí devuelve 13 673 820.
- El diff de O-19 nunca mueve dos de sus cuatro cifras: en la sonda de §4.6, un
  asiento de 1 234,00 € en la 573 mueve `TESORERIA` en +123 400 y deja
  `ACTIVO`/`PN_MAS_PASIVO` en 0 → 0.
- `I2` («Activo = PN + Pasivo») queda trivialmente satisfecha por el `headline`
  (0 = 0) justo donde debería ser informativa.

### H-3 · ALTA — I-E7-12 no puede medir nunca la diferencia de cambio 768/668

`BankInvariantInput.fx` (`lib/audit/invariants-e7.ts:97-111`) **no se rellena en
ningún sitio de producción**: no está en `models/bank.ts readBankInvariantInput`
ni en `models/audit.ts auditBlock` (`grep -n "fx" models/audit.ts models/bank.ts
"app/(app)/audit/actions.ts"` → sin resultados). El barrido real devuelve
siempre:

```
I-E7-12 INFO · sin tasa de cierre no se puede medir la diferencia de cambio de 5740001
```

Y el panel tampoco la enseña: `toSummaryView` acepta `fxDifferenceCents`
(`app/(app)/audit/bank/shared.ts:57,89`) pero **ningún llamante lo pasa**, así
que `diferenciaDeCambioCents` es siempre `null`. El motivo de sello
`DIFERENCIA_DE_CAMBIO_SIN_RECONOCER` es inalcanzable.

El único test que ejerce el WARN (`lib/audit/invariants-e7.test.ts:704-765`) es
**autocontradictorio**: construye el apunte de libros con `debitCents: 100000`,
el mismo número que los 100 000 céntimos de USD de la línea de extracto (paridad
1:1, que es lo que hace pasar I-E7-1), y a la vez declara
`baseBalanceCents: 95000` para I-E7-12. La misma línea del diario vale como USD
para un invariante y como EUR para el otro. Por eso H-1 no lo detectó nadie.

### H-4 · MEDIA — Los motivos de sello propios de E7 no bajan el sello

`lib/audit/run.ts:150-192`: `computedSeal` se calcula **antes** de componer
`auditReasons`, y éstos sólo se concatenan en `sealReasons`; `seal` queda
intacto. `models/ledger.ts:2299-2305` devuelve el `sello` sin ellos.

Evidencia (`invariant_runs` de la organización auditada):

```
seal         | VALIDADO_AUTOMATICAMENTE
seal_reasons | [{"code":"CONCILIACION_PENDIENTE","kind":"AVISO",…},
                {"code":"PARTIDA_EN_TRANSITO_ANTIGUA","kind":"AVISO",…}]
```

…con ocho pendientes de 183, 153, 152, 122, 121, 92 y 91 días sobre un
`transitWarnDays` de 90. Un AVISO que no mueve el sello es decorativo: el
periodo se firma como «validado automáticamente» con la conciliación abierta,
que es exactamente lo que §3.2 quería evitar.

### H-5 · MEDIA — Ningún pendiente puede quedar «explicado» en producción

Las tres vías de O-17 (`explainPending`, `lib/audit/confidence.ts:82-110`) están
cerradas en el borde:

1. `resolvedLaterIds` se pasa **fijo a `new Set()`** en
   `app/(app)/audit/bank/shared.ts:34` — las vías 1 y 2 nunca se cumplen.
2. `pendingKind` **no lo escribe nadie**: sólo aparece leído
   (`lib/audit/invariants-e7.ts:368-391`) y declarado (`lib/bank/types.ts:143,164`).
   En el barrido real los 12 pendientes salieron con `kind: null` → vía 3 cerrada.

Consecuencia: toda la taxonomía de pendientes tipados y envejecidos de O-8
(`CHEQUE_EMITIDO_NO_CARGADO`, `TRASPASO_ENTRE_CUENTAS_EN_CAMINO`,
`EFECTO_EN_GESTION_DE_COBRO` y su exclusión del cuadre) es código muerto, y el
badge sólo se concede con **cero** pendientes. Es un fallo conservador —el badge
se retiene de más, no se concede de menos— pero deja sin implementar una de las
observaciones bloqueantes de la ronda 2.

### H-6 · MEDIA — I-E7-14 es inevaluable justo en el alcance con que se sella un ejercicio

`checkIE714` necesita las líneas `OPENING` del ejercicio **siguiente**
(`lib/audit/invariants-e7.ts:953-957`), que por definición no están en el
alcance `FISCAL_YEAR`. Comprobado sobre el fixture intacto:

| Alcance | I-E7-14 |
|---|---|
| `FISCAL_YEAR` 2026 | `INFO · ningún ejercicio con asiento de apertura: …` |
| Organización (2026 + 2027) | `PASS · 1 apertura(s) cuadran cuenta a cuenta` |

El invariante funciona; simplemente no se ejecuta en el alcance normal de la
pestaña de auditoría.

### H-7 · BAJA — El periodo del extracto se deduce de los movimientos, no del registro 11

`models/bank.ts:534-535` fija `periodStart`/`periodEnd` con la fecha de
operación del primer y último apunte **nuevos**, descartando el periodo
declarado en la cabecera N43 (posiciones 21-32), que el parser sí lee
(`lib/bank/n43.ts:172-186`). Comprobado: un extracto declarado 2026-07-01…07-31
cuyo primer movimiento es del día 6 se almacena como 07-06…07-22, y la cadena de
I-E7-6b denuncia un hueco 07-01…07-06 que el banco sí cubre. En una cartera real
—extractos mensuales sin movimiento el día 1 o el último día— I-E7-6b sale FAIL
casi siempre, I-E7-1 queda en INFO y el badge P6 no se concede jamás. (En este
informe fue necesario alinear los movimientos con los bordes del periodo para
poder evaluar I-E7-1.)

---

## 4. Comprobaciones que SÍ pasan

### 4.1 Errores inyectados

| # | Inyección | Resultado |
|---|---|---|
| a | `UPDATE bank_statement_lines SET amount_cents = …` sobre una línea conciliada | **Rechazado incluso como superusuario** por `app.bank_statement_lines_only_status()` (ADR-0010). Con el trigger deshabilitado a la fuerza: **I-E7-1, I-E7-2, I-E7-6a e I-E7-11 en FAIL** y sello `REQUIERE REVISIÓN`. En grupo `UNO_A_N`/`N_A_N` la igualdad por fila de I-E7-2 no aplica (`simple = members.length === 1`) y quien delata es I-E7-11, conforme al diseño; con un grupo `SIMPLE` I-E7-2 sí falla nombrando el signo |
| b | `UPDATE`/`DELETE` de `invariant_runs` como `app_runtime` | **`ERROR: permission denied for table invariant_runs` (42501)**. Ídem `journal_lines`. Como propietario, alterar un `check` sin tocar `checks_hash` → **I-E7-7 FAIL** nombrando el run y ambos hashes |
| c | Borrado del extracto intermedio (agosto) | **I-E7-6b FAIL** (`hueco 2026-08-01…2026-09-01`) e **I-E7-1 INFO**, nunca PASS. Sello `REQUIERE REVISIÓN` |
| d | `UPDATE allocation_lines SET amount_cents = amount_cents + 1` bajo un `ReportRun` `PYG_ANALITICA` vigente | **I-E7-10 PASS → FAIL**, nombrando liquidación, informe, `linesHash` sellado y recomputado |
| e | `detectionTestAction` | El test de integración `e7-conciliacion` lo verifica y pasa; auditado el cuerpo de la acción (`app/(app)/audit/actions.ts:649-760`): la **única** escritura es el `AuditLog` con `escrito: false`. `ledgerHash` antes = después |

### 4.2 Badge «validado contra fuente»

| Composición | Badge | Motivo |
|---|---|---|
| `5750001` (cuenta íntegramente conciliada, sin pendientes) | **`validado`** | — |
| `5750001` + `570` (caja) | `comprobado` | «la cifra incluye caja (570), que no tiene extracto…» |
| `5750001` + `5730001` (9 pendientes sin explicar) | `comprobado` | pendientes sin explicar |
| `5750001`, tras importar un extracto **retroactivo** que abre un hueco | `comprobado` | «5730001…/5750001 no cuadra: I-E7-1 no está en PASS» |

Conforme a O-16/O-17 y a I-E7-6b. El badge no se persiste.

### 4.3 `bigint` (ADR-0015 D1)

Asiento de **25 000 000,00 €** posteado por `postEntry` (camino real, no
`INSERT`): aceptado, almacenado exacto (`debit_cents = 2500000000`), con
`entry_hash` bien formado. Y el `ledgerHash` de la organización con el fixture
intacto es **`cb9c874479ffc2e7e7acc4e9cc49e0cea6dc49090c360cdd327e07d98660769e`**,
idéntico al literal congelado en `lib/ledger/fixtures.test.ts:196`.
`lib/ledger/{fixtures,hash,hash.e7-bigint}.test.ts` → 63 tests en verde.

### 4.4 Reproducibilidad (P7)

Dos barridos consecutivos sobre el mismo estado y el mismo `gitSha` producen los
cinco hashes idénticos y el **mismo `checks` byte a byte**, salvo I-E7-7, que
pasa de `INFO` a `PASS` porque el segundo run ya tiene un run anterior que
verificar (autorreferencia esperada, no deriva).

### 4.5 Tenant

Como `app_runtime` con `app.current_org` = ORG B, las seis tablas nuevas de A
devuelven **0 filas** (`bank_accounts`, `bank_statements`,
`bank_statement_lines`, `bank_match_groups`, `bank_reconciliations`,
`invariant_runs`), y también `allocation_runs` y `report_runs`, mientras B sigue
viendo sus 326 líneas de diario. Sin fuga.

### 4.6 Diff entre barridos

| Qué cambia | `cause` | `hashChanges` | Δ cifras |
|---|---|---|---|
| Sólo `gitSha` | `MOTOR` | `gitSha` | todas 0 |
| Sólo `matchToleranceDays` (3 → 9) | `CONFIGURACION` | `configHash` | todas 0 |
| Sólo el diario (asiento de 1 234,00 € en la 573) | `DATOS` | `ledgerHash`, `analyticsKey` | **TESORERIA +123 400** (exacto), resto 0 |

Las causas son correctas y el Δ de tesorería cuadra al céntimo con mi SQL. Las Δ
de activo y PN+pasivo son 0 por **H-2**, no porque no hayan cambiado.

### 4.7 Trazabilidad

Desde la evidencia de un check en FAIL (que nombra el `groupId`) hasta el
registro origen, en **una sola consulta, ~3 segundos**: grupo →
`bank_reconciliations` → `bank_statement_lines` (`line_no`, `operation_date`,
importe, `sha256`) → `bank_statements` (`file_name`, `file_sha256`, periodo) →
`journal_lines` → `journal_entries` (`entry_number`, `entry_hash`, `posted_at`).
**OK**, muy por debajo de los 2 minutos.

---

## 5. Recomendación

1. **Bloqueantes antes de cerrar E7**: convertir `B`/`Ub` a la divisa de la
   cuenta (o declarar explícitamente que E7 no soporta cuentas en divisa y
   rechazar su alta) — **H-1**; excluir `CLOSING` de `activo` y `pn_mas_pasivo`
   en `headlineFigures` — **H-2**; poblar `fx` en `auditBlock` o degradar
   I-E7-12 a `SIN_EVALUAR` declarado en `coverage` en vez de INFO silencioso —
   **H-3**. Y corregir el test de I-E7-12, que hoy tapa H-1.
2. **Importantes**: hacer que `auditReasons` entre en el cálculo del sello
   (**H-4**); poblar `pendingKind` y `resolvedLaterIds` en el borde o retirar del
   diseño la taxonomía de O-8 (**H-5**); dar a I-E7-14 el alcance que necesita
   (**H-6**); conservar el periodo declarado del registro 11 (**H-7**).
3. Todo lo demás —la identidad del cuadre, la append-only, los cuatro errores
   inyectados, el `bigint`, el diff, el tenant y la trazabilidad— **está bien y
   se ha reconstruido por camino independiente**.

---

# Re-auditoría (ronda 1) — diff `34f2802…f227f1a`

Mismo método y contexto limpio: base aislada clonada de `erp_test` (44
migraciones), fixture en dos organizaciones, reconstrucción por SQL crudo +
Python (`scratchpad/reconstruct.py`), sin reutilizar `lib/audit/**` ni
`lib/bank/**`. Escenario ampliado: tercera cuenta bancaria «limpia», cuenta USD
con tasa histórica **0,92** y tasa de **cierre 0,95**, extracto de enero de 2027
y dos pendientes tipados.

**Veredicto: DISCREPANCIA** — seis de los siete hallazgos están cerrados y
verificados; queda **uno nuevo de severidad ALTA** introducido por el propio
arreglo de H-3.

## Estado de los siete hallazgos

| # | Estado | Evidencia |
|---|---|---|
| **H-1** divisa | **CERRADO** | `E`, `B`, `Ue`, `Ub` de `5740001` salen los cuatro en **USD** (`moneda: "USD"`, `enDivisa: true`, `divisaCompleta: true`). Punteo **100,00 USD ↔ 92,00 EUR** (con `original_amount_cents = 10000`) **ACEPTADO** (`SIMPLE`, `Σ = 10000`); punteo **100,00 USD ↔ 100,00 EUR base** (sin importe en divisa) **RECHAZADO**: «El apunte … no lleva su importe en USD … conciliar comparando el contravalor en moneda base sería cuadrar mezclando monedas» |
| **H-2** headline | **CERRADO** | Sobre el fixture intacto a 31-12-2026: motor `ACTIVO 13.673.820`, `PN_MAS_PASIVO 13.673.820`, `RESULTADO 1.497.322`, `TESORERIA 2.943.920`; mi SQL da lo mismo, con `PN 8.307.322 + PASIVO 5.366.498 = 13.673.820`. **Δ = 0 en las cuatro** |
| **H-3** 768/668 | **PARCIAL — ver N-1** | `readFxCloses` ya puebla `fx` y I-E7-12 mide: `WARN · diferencia de cambio 10,50 €`, exactamente mi cifra. Pero **reconocerla no lleva a PASS** |
| **H-4** sello | **CERRADO** | El run con ocho partidas en tránsito de 91–183 días (`transitWarnDays 90`) sale **`REQUIERE REVISIÓN`**, con `CONCILIACION_PENDIENTE`, `PARTIDA_EN_TRANSITO_ANTIGUA` y `DIFERENCIA_DE_CAMBIO_SIN_RECONOCER` en `motivos` |
| **H-5** explicado | **CERRADO** | Cheque de 2026-08-20 (−330,00 €) conciliado contra la línea de **2027-01-15**: a 31-12 **sigue pendiente** —entra en `Ub` y la identidad se mantiene— y sale **explicado** («lo recoge una línea de extracto posterior ya conciliada»). Cheque de 2026-12-20 tipado `CHEQUE_EMITIDO_NO_CARGADO` (11 días < 90): **explicado** por el criterio 3, y su cuenta conserva el badge **`validado`** con un pendiente vivo |
| **H-6** I-E7-14 | **CERRADO** | Sobre el fixture intacto, alcance `FISCAL_YEAR` 2026: `PASS · 1 apertura(s) cuadran cuenta a cuenta` (antes `INFO`) |
| **H-7** periodo N43 | **CERRADO** | `eur5.n43` declara 2027-01-01…01-31 con un único movimiento el 15: se almacena con el **periodo declarado**, no con `01-15…01-15` |

## N-1 · ALTA (nuevo) — Reconocer la diferencia de cambio en 768/668 la duplica

`fxDifferenceOf = convert(saldoContable, tasa) − baseBalanceCents −
recognizedDifferenceCents` (`lib/audit/invariants-e7.ts:1000-1003`), pero
`readFxCloses` (`models/bank.ts`) calcula `baseBalanceCents` como el saldo
**completo** de la 57x —que ya incluye el apunte del asiento de reconocimiento— y
`recognizedDifferenceCents` a partir del 768/668 de **ese mismo asiento**. La
reconocida se resta dos veces. Y no hay forma de evitarlo: la subconsulta de
`recognized_cents` sólo cuenta un 768/668 cuyo asiento **contenga una línea de la
cuenta bancaria** (`EXISTS … b.account_code LIKE c.code_pattern`), así que el
asiento tiene que mover la 57x por narices.

Comprobado de punta a punta (contravalor histórico 322,00 €, cierre 0,95):

```
antes    I-E7-12 WARN · … = 332,50 € EUR frente a 322,00 € contabilizados
                            y 0,00 € reconocidos: diferencia de cambio  10,50 €
reconozco 5740001 (D) 10,50 € / 768 (H) 10,50 €   ← asiento correcto, NRV 11ª.2.2
después  I-E7-12 WARN · … = 332,50 € EUR frente a 332,50 € contabilizados
                            y 10,50 € reconocidos: diferencia de cambio −10,50 €
```

La propia evidencia se contradice: 332,50 € valorados **= 332,50 €
contabilizados**, luego la diferencia es 0 y el invariante dice −10,50 €.
Consecuencia agravada por el arreglo de H-4: `DIFERENCIA_DE_CAMBIO_SIN_RECONOCER`
ya **sí** mueve el sello, de modo que una cuenta en divisa correctamente
regularizada queda en **`REQUIERE REVISIÓN` para siempre**.

Como en la ronda 0, lo tapa un test con datos irrealizables:
`lib/audit/invariants-e7.test.ts:822` («reconocida en 768/668, ya no avisa»)
fabrica `baseBalanceCents: 92000` **sin mover** por el reconocimiento y
`recognizedDifferenceCents: −2000` a la vez — una combinación que
`readFxCloses` no puede producir nunca.

**Arreglo**: restar sólo `baseBalanceCents` (que ya contiene el reconocimiento),
o excluir del saldo base la línea del asiento de reconocimiento. Y sustituir el
fixture del test unitario por uno que salga de `readFxCloses`.

## Observaciones menores

- **O-1.** La cuenta USD luce badge **`validado`** con I-E7-12 en `WARN` por
  10,50 € sin reconocer: la cifra está conciliada contra fuente en USD, pero su
  contravalor en euros no. Merece, al menos, que el badge lo diga.
- **O-2.** `createMatchGroup` → `clearPendingKinds` borra el tipado de un
  pendiente **a caballo del corte**, que a la fecha de corte sigue siendo
  pendiente: se enseña con `kind: null` aunque esté explicado por el criterio 1.

## Cifras y pruebas repetidas de la ronda 0 (todas Δ = 0)

| Métrica | Motor | Reconstrucción | Δ |
|---|---:|---:|---:|
| `5730001` EUR · `E` / `B` | 885 950 / 869 000 | 885 950 / 869 000 | 0 |
| `5730001` EUR · `Ue` / `Ub` | −16 050 / −33 000 | −16 050 / −33 000 | 0 |
| `5730001` EUR · Σ ignorados | −12 500 | −12 500 | 0 |
| `5740001` **USD** · `E` / `B` / `Ue` / `Ub` | 35 000 / 35 000 / 0 / 0 | ídem, desde `original_amount_cents` | 0 |
| `5750001` EUR · `E` / `B` / `Ue` / `Ub` | 500 000 / 495 000 / 0 / −5 000 | ídem | 0 |
| Diferencia de cambio | 1 050 | 350,00 USD × 0,95 − 322,00 € = 1 050 | 0 |
| `headline` × 4 (fixture) | 13 673 820 / 13 673 820 / 1 497 322 / 2 943 920 | ídem | 0 |

- **Inyecciones**: (a) importe de una línea conciliada → **rechazado por trigger
  incluso como superusuario**; forzado, `I-E7-1/2/6a/11` en FAIL y sello
  `REQUIERE REVISIÓN`. (b) `UPDATE`/`DELETE` de `invariant_runs` como
  `app_runtime` → **42501**; alterado un `check` como propietario → `I-E7-7 FAIL`.
  (c) borrado del extracto de septiembre → `I-E7-6b FAIL` e `I-E7-1 INFO`.
  (d) `allocation_lines` alterada bajo un `ReportRun` vigente → `I-E7-10`
  PASS → **FAIL**. (e) prueba de detección sin escribir en `journal_lines` y con
  `ledgerHash` idéntico: verde en la suite.
- **`bigint`**: 25 000 000,00 € por `postEntry`, almacenados exactos; el
  `ledgerHash` del fixture sigue siendo `cb9c8744…60769e`, el literal congelado.
- **Diff**: sólo `gitSha` → `MOTOR` con las cuatro Δ a 0; sólo diario →
  `DATOS` con **ΔTESORERÍA = +2 500 000 000** exacta. Ahora `ACTIVO` y
  `PN_MAS_PASIVO` leen 13 673 820 en vez de 0.
- **Tenant**: desde la organización B, 0 filas en las **siete** tablas de E7
  (incluida la nueva `bank_pending_kinds`). **Trazabilidad**: del grupo al fichero
  N43 (`file_sha256`) y al asiento (`entry_hash`), con el importe en divisa, en
  una consulta de 0,06 s.
- **Suite**: `e7-conciliacion`, `e7-ronda1`, `e7-esquema` y `e7-qa` → **57 tests
  en verde**; `lib/ledger/{fixtures,hash,hash.e7-bigint}` → 63 en verde.

## Recomendación

Un solo bloqueante: **N-1**. Corregir la doble resta de
`recognizedDifferenceCents` y su test unitario; con eso E7 queda cerrable.
O-1 y O-2, a `ESTADO.md` con fecha.
