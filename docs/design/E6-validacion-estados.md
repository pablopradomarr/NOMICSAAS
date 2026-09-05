# E6 — Validación contable de los informes financieros: balance, PyG, cashflow, invariantes I2/I3/I6 y umbrales de revisión

> Rol: `experto-contable`. Fuentes: `.claude/skills/estados-financieros`, `.claude/skills/fiabilidad` (I2, I3, I6), `.claude/skills/pgc-npgc`, `docs/MODELO-DATOS.md` (§`LedgerAccount`, §`ReportRun`/`ReportType`/`Seal`), `seeds/npgc.csv` (14 columnas tras E6), `tests/fixtures/ejercicio-completo.json` + `docs/design/fixtures/build_ejercicio_completo.py`, `docs/design/E3-asientos-tipo.md` §2 y §4, `docs/design/E4-validacion-analitica.md`, ADR-0010.
> Norma: **RD 1514/2007** (PGC 2007) y **RD 1515/2007** (PGC PYMES), actualizados por **RD 1159/2010**, **RD 602/2016** y **RD 1/2021** · **Código de Comercio arts. 25–34** · **LSC arts. 253, 272, 279** · **Resolución ICAC 16/05/1991** (modelos de cuentas anuales).
> **Todas las cifras proceden del fixture inmutable `tests/fixtures/ejercicio-completo.json`, que es ilustrativo.** Ningún importe procede de datos reales. Céntimos enteros en todo el documento.
> Entregables: este documento · `docs/design/fixtures/build_estados_esperados.py` · `docs/design/fixtures/estados-esperados.json` (47 checks en PASS, `--check` reproduce byte a byte). **`tests/fixtures/*` no se toca**: es entrada, es inmutable y está sellado por E3.

---

## 0. Convenciones de signo — las siete reglas que fijan todo lo demás

| Regla | Enunciado | Consecuencia |
|---|---|---|
| **R-B1** | `saldo(cuenta) = Σ debitCents − Σ creditCents`. Positivo = **deudor** | No hay importes negativos en el diario (C-2 de E3). El signo lo pone la agregación, nunca la línea |
| **R-B2** | Presentación: `BALANCE_ACTIVO → +saldo`; `BALANCE_PASIVO` y `BALANCE_PN → −saldo` | Un activo con saldo deudor sale positivo; un pasivo con saldo acreedor sale positivo. **Un solo `CASE`, no dos ramas de código** |
| **R-B3** | **`isContra` NO interviene en el cálculo.** Con R-B2 la contra-cuenta ya resta: `2816` tiene saldo acreedor (−300 000) y aparece como **−300 000** dentro de su epígrafe de activo | `isContra` es (a) presentación —marca `(−)` en la UI, R-16 de E2— y (b) **check de signo**: una contra-cuenta con importe presentado positivo es anómala (I-E6-10). El renderizador que "resta las contra-cuentas" a mano las restaría **dos veces** |
| **R-B4** | **`bidirectional`**: el seed guarda siempre la ruta **deudora**. Si `saldo ≥ 0` → epígrafe de activo del seed; si `saldo < 0` → **epígrafe espejo de pasivo** por `−saldo` (tabla §1.4). Nunca en los dos lados | Es la única reclasificación por signo del balance. 7 cuentas, tabla cerrada, no configurable por el usuario |
| **R-B5** | Si el ejercicio **no está regularizado** (`saldo(129) = 0`), el resultado del periodo (I3) se **inyecta** en PN `A-1) VII. Resultado del ejercicio`. Si lo está, se **lee de 129**. **Nunca las dos cosas** | Es lo que hace que el balance cuadre (I2 = 0) durante todo el ejercicio y no solo el 31 de diciembre a las 23:59 |
| **R-B6** | `472`/`477` **no son bidireccionales**: el motor las liquida contra `4700`/`4750` cada trimestre (T-24). Un saldo **acreedor en 472** o **deudor en 477** a fecha de balance es **anomalía** (WARN de Auditoría), no una reclasificación | La separación deudor/acreedor de la Hacienda por IVA ya la hace el **plan de cuentas** (4700 activo / 4750 pasivo), no el renderizador |
| **R-P1** | PyG: `aporte = creditCents − debitCents`. Ingresos **+**, gastos **−**. `708`/`709`/`706` aportan **−**; `606`/`608`/`609` aportan **+** | Idéntica a la convención de la matriz analítica de E4 (§0), de modo que I3 e I4 se comparan sin conversión |

**Periodo de la PyG (I3, definición única de la skill `fiabilidad`)**: líneas de grupo 6/7 con `kind ∉ {REGULARIZATION, CLOSING, OPENING}`. **Periodo del cashflow**: los mismos `kind` excluidos, por motivos distintos —`OPENING` fija el saldo inicial, `CLOSING` lo anula, `REGULARIZATION` solo reordena 6/7 → 129— y ninguno de los tres mueve un euro.

---

## 1. Balance de situación esperado a 31/12/2026

Calculado por **`docs/design/fixtures/build_estados_esperados.py`** (Python puro, sin `lib/`, sin BD, sin float) y sellado en **`estados-esperados.json`**. El motor de E6 debe reproducirlo byte a byte.

### 1.1 Las cuatro fotos

| Foto | `kind` incluidos | Qué es | `saldo(129)` | PN `A-1) VII` |
|---|---|---|---|---|
| **PRE_REGULARIZACION** | todos menos `REGULARIZATION`, `CLOSING` | El balance que ve el usuario **durante** el ejercicio y a 31/12 antes de T-26. Es el modo por defecto del informe | `0` | **1 497 322 inyectados por R-B5** |
| **POST_REGULARIZACION** | todos menos `CLOSING` | El **balance formulado** (art. 254 LSC): tras T-26 (`7xx → 129`, `129 → 6xx`) y antes del asiento de cierre | `−1 497 322` (acreedor) | 1 497 322 **leídos de 129** |
| **POST_CIERRE** | todos | Tras T-27. **Todas las cuentas de balance a cero** | `0` | — |
| **APERTURA_2027** | ejercicio 2027 | Tras el asiento de apertura. Reproduce **exactamente** POST_REGULARIZACION, **129 incluida** | `−1 497 322` | 1 497 322 |

> Las dos primeras fotos dan **el mismo balance al céntimo**. Eso es el resultado, no la casualidad: es precisamente lo que R-B5 garantiza y lo que I-E6-11 comprueba. La regularización no cambia el patrimonio, solo mueve de dónde se lee.
> **129 en la apertura**: el asiento de apertura **sí reabre 129**. El resultado sigue *pendiente de aplicación* hasta el acuerdo de la junta (T-28), que es el que lo lleva a `120`/`121`/reservas/dividendo. Un motor que reabriera 129 directamente en 120 estaría contabilizando un acuerdo que aún no existe.

### 1.2 Balance por epígrafe — **modelo NORMAL** (idéntico en las cuatro fotos salvo POST_CIERRE)

| Epígrafe | Céntimos | Cuentas |
|---|---:|---|
| **A) Activo no corriente** | **2 665 000** | |
| &nbsp;&nbsp;II. Inmovilizado material | 2 665 000 | |
| &nbsp;&nbsp;&nbsp;&nbsp;2. Instalaciones técnicas y otro inmovilizado material | 2 665 000 | `216` 1 200 000 · `217` 2 100 000 · `2816` **−300 000** · `2817` **−335 000** |
| **B) Activo corriente** | **11 008 820** | |
| &nbsp;&nbsp;II. Existencias | 100 000 | |
| &nbsp;&nbsp;&nbsp;&nbsp;6. Anticipos a proveedores | 100 000 | `407` |
| &nbsp;&nbsp;III. Deudores comerciales y otras cuentas a cobrar | 7 964 900 | |
| &nbsp;&nbsp;&nbsp;&nbsp;1. Clientes por ventas y prestaciones de servicios | 7 844 900 | `4300` 7 723 900 · `436` 121 000 |
| &nbsp;&nbsp;&nbsp;&nbsp;6. Otros créditos con las Administraciones Públicas | 120 000 | `473` |
| &nbsp;&nbsp;VII. Efectivo y otros activos líquidos equivalentes | 2 943 920 | |
| &nbsp;&nbsp;&nbsp;&nbsp;1. Tesorería | 2 943 920 | `572` 2 913 920 · `570` 30 000 |
| **TOTAL ACTIVO** | **13 673 820** | |
| **A) Patrimonio neto** | **8 307 322** | |
| &nbsp;&nbsp;A-1) Fondos propios | 8 307 322 | |
| &nbsp;&nbsp;&nbsp;&nbsp;I. Capital / 1. Capital escriturado | 3 000 000 | `100` |
| &nbsp;&nbsp;&nbsp;&nbsp;III. Reservas / 2. Otras reservas | 250 000 | `113` |
| &nbsp;&nbsp;&nbsp;&nbsp;V. Resultados de ejercicios anteriores / 1. Remanente | 3 560 000 | `120` |
| &nbsp;&nbsp;&nbsp;&nbsp;**VII. Resultado del ejercicio** | **1 497 322** | `129` (o inyectado, R-B5) |
| **C) Pasivo corriente** | **5 366 498** | |
| &nbsp;&nbsp;V. Acreedores comerciales y otras cuentas a pagar | 5 366 498 | |
| &nbsp;&nbsp;&nbsp;&nbsp;1. Proveedores | 1 959 800 | `4000` |
| &nbsp;&nbsp;&nbsp;&nbsp;3. Acreedores varios | 2 587 100 | `4100` |
| &nbsp;&nbsp;&nbsp;&nbsp;5. Pasivos por impuesto corriente | 499 108 | `4752` |
| &nbsp;&nbsp;&nbsp;&nbsp;6. Otras deudas con las Administraciones Públicas | 320 490 | `4750` 245 490 · `4751` 75 000 |
| **TOTAL PN + PASIVO** | **13 673 820** | |
| **I2** | **0** | ✅ |

Cuentas con saldo **cero** a 31/12 y por tanto ausentes del balance (el renderizador **no imprime epígrafes vacíos**): `472`, `477`, `4700`, `476`, `465`, `438`, `480`, `485`, `460`. Todas ellas ejercitadas durante el año: el fixture las cierra a cero a propósito, para que un motor que "arrastre" saldos falle.

### 1.3 Modelo PYMES / abreviado — **la única diferencia es la numeración romana**

| Epígrafe NORMAL | Epígrafe PYMES | Motivo |
|---|---|---|
| B) Activo corriente / **II.** Existencias | B) Activo corriente / **I.** Existencias | El abreviado suprime `I. Activos no corrientes mantenidos para la venta` |
| B) **III.** Deudores comerciales… | B) **II.** Deudores comerciales… | idem |
| B) **VII.** Efectivo… | B) **VI.** Efectivo… | idem |
| C) Pasivo corriente / **V.** Acreedores comerciales… | C) Pasivo corriente / **IV.** Acreedores comerciales… | El abreviado suprime `I. Pasivos vinculados con activos no corrientes mantenidos para la venta` |
| C) **III.** Deudas a corto plazo | C) **II.** Deudas a corto plazo | idem |
| C) **IV.** Deudas con empresas del grupo… | C) **III.** Deudas con empresas del grupo… | idem |

**Los importes y los totales son idénticos** (I-E6-1: 13 673 820 en los dos modelos, en las cuatro fotos). Las dos cadenas viven en el seed (`epigrafe`, `epigrafe_pymes`) y se seleccionan con `epigraphFor(account, variant)`; **no se derivan una de otra por regex**, porque los grupos I…VII no se desplazan de forma uniforme (en el activo se salta uno, en el pasivo también, pero el desdoblamiento `A-1)/A-2)` del PN no cambia).

### 1.4 Cuentas bidireccionales — tabla de reclasificación (R-B4)

**Ninguna de las 7 se mueve en el fixture.** La regla se documenta aquí y se testea con la tabla sintética `bidirectionalScenarios` del JSON (saldo +100 000 / −100 000 / 0 por cuenta y modelo), que es la entrada de I-E6-5b.

| Cuenta | Saldo **deudor** → epígrafe de activo | Saldo **acreedor** → epígrafe de pasivo |
|---|---|---|
| **551** C/c con socios y administradores | B) **V.** Inversiones financieras a c/p / 5. Otros activos financieros | C) **III.** Deudas a c/p / **5. Otros pasivos financieros** |
| **552** C/c con otras personas y entidades vinculadas | B) **IV.** Inversiones en empresas del grupo y asociadas a c/p / 5. Otros activos financieros | C) **IV. Deudas con empresas del grupo y asociadas a c/p** |
| **5523** C/c con empresas del grupo | B) IV. … / 5. Otros activos financieros | C) IV. Deudas con empresas del grupo y asociadas a c/p |
| **5524** C/c con empresas asociadas | B) IV. … / 5. Otros activos financieros | C) IV. Deudas con empresas del grupo y asociadas a c/p |
| **5525** C/c con otras partes vinculadas | B) V. Inversiones financieras a c/p / 5. Otros activos financieros | C) III. Deudas a c/p / 5. Otros pasivos financieros |
| **554** C/c con UTEs y comunidades de bienes | B) III. Deudores comerciales… / 3. Deudores varios | C) **V.** Acreedores comerciales… / **3. Acreedores varios** |
| **555** Partidas pendientes de aplicación | B) III. Deudores comerciales… / 3. Deudores varios | C) V. Acreedores comerciales… / 3. Acreedores varios |

(En PYMES, los romanos bajan uno según §1.3; las cadenas exactas están en `bidirectionalMirror` del JSON.)

Tres precisiones que un motor ingenuo se salta:
1. La reclasificación es **por cuenta, por su saldo neto a la fecha del balance**, nunca por línea ni por movimiento. Una `551` que oscila de signo doce veces en el año se presenta **una sola vez**, en el lado que le corresponda el 31/12.
2. Con **subcuentas** (`5510` socio A deudor, `5511` socio B acreedor) la reclasificación se aplica a **cada cuenta postable por separado**, no al padre agregado. Es lo correcto: son créditos y deudas frente a personas distintas y **no procede compensarlos** (NRV 9ª y art. 37 CdC, prohibición de compensación). Un motor que agregase en `551` y reclasificase el neto estaría compensando activos con pasivos.
3. `555` **Partidas pendientes de aplicación** con saldo distinto de cero a fecha de balance es, además de una reclasificación, un **WARN de Auditoría**: es una cuenta puente y debería estar a cero al cierre.

### 1.5 Partidas que exigen regla especial — y por qué

| Partida | Tratamiento | Razón |
|---|---|---|
| **4700 vs 4750** | **Ya separadas por el plan**: `4700` es `BALANCE_ACTIVO` (B.III.6 Otros créditos con AAPP) y `4750` es `BALANCE_PASIVO` (C.V.6 Otras deudas con AAPP). El renderizador **no decide nada**: es T-24 quien, al liquidar cada trimestre, elige la cuenta según el signo del resultado del periodo | Es la solución correcta y es superior a marcar `470`/`475` como bidireccionales: la elección de cuenta queda **sellada en el asiento** y es auditable en el modelo 303, en vez de recalcularse en cada informe. En el fixture: Q3 salió a compensar (−100 800) y **no** generó saldo en 4700 porque T-24 lo compensó en Q4 (`compensadoCents: 100 800`); el saldo final de 4750 es 245 490 = resultado de Q4 |
| **472 / 477** | Deben quedar a **cero** tras cada liquidación. No son bidireccionales (R-B6). Saldo residual ≠ 0 a 31/12 → sí se presentan (472 en activo B.III.6, 477 en pasivo C.V.6), y **con signo contrario al natural** disparan WARN | Un `477` deudor significa una liquidación mal construida o una factura rectificativa posterior al modelo 303: es un error de datos, no una situación patrimonial |
| **4751 / 4752** | `4751` (retenciones) → C.V.**6** Otras deudas con AAPP. `4752` (IS) → C.V.**5 Pasivos por impuesto corriente**, epígrafe propio | El modelo oficial separa el impuesto sobre beneficios del resto de deudas tributarias. Un motor que mande `475` entero a V.6 pierde el epígrafe V.5 |
| **473** | Retenciones y pagos a cuenta **soportados** → activo B.III.6 (120 000 en el fixture) | Es un crédito contra Hacienda. No se compensa con `4752` en el balance: compensarlos exigiría que fueran la misma deuda y el mismo impuesto **y** que hubiera intención de liquidar por el neto (art. 37 CdC). El neto se presenta en la **liquidación del IS**, no en el balance. **Aviso**: muchos programas los compensan; el ERP **no**, y esto es una decisión consciente |
| **407 Anticipos a proveedores** | Activo corriente **II. Existencias / 6. Anticipos a proveedores** (PYMES: I.6) | Contraintuitivo pero es el modelo oficial: el anticipo a proveedor **no** es un deudor, es una existencia en curso de adquisición. En el fixture produce el único importe del bloque Existencias (100 000) en una empresa de servicios que no tiene existencias, y es correcto |
| **438 Anticipos de clientes** | Pasivo corriente **V.7 Anticipos de clientes** (PYMES IV.7), epígrafe propio | Simétrico pero **no** en Existencias: el anticipo recibido es una obligación de entregar el servicio. En el fixture cierra a 0 (`ANT-C-01` de febrero se aplica en `F-003` de marzo) |
| **480 / 485 Periodificaciones** | `480` → activo B.**VI** Periodificaciones a c/p (PYMES B.V); `485` → pasivo C.**VI** (PYMES C.V) | Epígrafe propio en los dos modelos, **fuera** de deudores y de acreedores. En el fixture cierran a 0 (devengados en `PER-G-02` y `PER-I-02`) |
| **436 Clientes de dudoso cobro** | Suma en B.III.**1** Clientes por ventas y prestaciones de servicios, junto a `4300` | El modelo oficial no le da línea propia: el deterioro se refleja con `490` (contra, `isContra = 1`), que **resta en el mismo epígrafe** por R-B2/R-B3. En el fixture hay 436 (121 000) sin `490`: reclasificación sin deterioro dotado, que es lo que corresponde cuando el cobro es dudoso pero no incobrable |
| **129 con pérdidas** | Saldo **deudor** → PN A-1) VII con importe **negativo**. No se reclasifica al activo, no se cambia de signo, no se lleva a `121` | `121` recibe el resultado en el asiento de **distribución del ejercicio siguiente** (T-28), no en el cierre. El PN puede quedar negativo (causa de disolución del art. 363 LSC, que es información, no un error de cuadre) e I2 sigue en 0 |
| **Contra-cuentas del activo (`28x`, `29x`, `39x`, `49x`, `59x`)** | Restan **solas** por R-B2/R-B3 | El error clásico es aplicar `isContra` **además** del signo: la amortización acumulada acabaría sumando |

---

## 2. Cuenta de pérdidas y ganancias esperada — 2026

I3 = **1 497 322** ✅ (coincide con `expected.resultadoAntesRegularizacionCents` y con el saldo acreedor de 129 tras T-26). BAI = **1 996 430** ✅ (coincide con `expected.resultadoAntesImpuestoCents` y con la fila `BAI` de la matriz analítica de E4).

### 2.1 Modelo NORMAL y modelo PYMES en paralelo

| # normal | # PYMES | Epígrafe | Céntimos | Detalle |
|---:|---:|---|---:|---|
| 1 | 1 | **Importe neto de la cifra de negocios** | **6 250 000** | |
| | | &nbsp;&nbsp;a) Ventas | −100 000 | `7080` (contra) |
| | | &nbsp;&nbsp;b) Prestaciones de servicios | 6 350 000 | `705` |
| 2 | 2 | Variación de existencias de PT y en curso | 0 | |
| 3 | 3 | Trabajos realizados por la empresa para su activo | 0 | |
| 4 | 4 | **Aprovisionamientos** | **−580 000** | |
| | | &nbsp;&nbsp;a) Consumo de mercaderías | +50 000 | `6080` (contra) |
| | | &nbsp;&nbsp;c) Trabajos realizados por otras empresas | −630 000 | `607` (730 000 − 100 000 del contra-asiento `REV-R-ERR`) |
| 5 | 5 | Otros ingresos de explotación | 0 | |
| 6 | 6 | **Gastos de personal** | **−2 640 000** | a) `640` −2 000 000 · b) `642` −640 000 |
| 7 | 7 | **Otros gastos de explotación** | **−604 570** | a) Servicios exteriores: `621` −120 000 · `623` −250 000 · `626` −500 · `628` −173 570 · `629` −60 500 |
| 8 | 8 | **Amortización del inmovilizado** | **−395 000** | `681`, 12 asientos mensuales |
| 9 | 9 | Imputación de subvenciones | 0 | |
| 10 | 10 | Excesos de provisiones | 0 | |
| 11 | 11 | Deterioro y rdo. por enajenaciones del inmovilizado | 0 | |
| 12 | — | Diferencia negativa de combinaciones de negocio | 0 | **no existe en PYMES** |
| 13 | 12 | **Otros resultados** | **−35 000** | `678` (`AJ-001`, ajuste de ejercicio cerrado no significativo, T-22) |
| | | **A.1) RESULTADO DE EXPLOTACIÓN** | **1 995 430** | |
| 14 | 13 | Ingresos financieros | +1 | b) `769` (redondeo, `PA-003`) |
| 15 | 14 | Gastos financieros | −1 | b) `669` (redondeo, `CO-006`) |
| 16 | 15 | Variación de valor razonable en instrumentos financieros | 0 | |
| 17 | 16 | **Diferencias de cambio** | **+1 000** | `768` +6 000 (`CO-005`) · `668` −5 000 (`CO-004`) |
| 18 | 17 | Deterioro y rdo. por enajenaciones de instrumentos financieros | 0 | |
| 19 | 18 | Otros ingresos y gastos de carácter financiero | 0 | **sin cuentas mapeadas en el seed** → O-2 |
| | | **A.2) RESULTADO FINANCIERO** | **+1 000** | |
| | | **A.3) RESULTADO ANTES DE IMPUESTOS** | **1 996 430** ✅ | |
| 20 | 19 | **Impuestos sobre beneficios** | **−499 108** | `6300` (25 % de 1 996 430 = 499 107,5 → 499 108, redondeo al alza) |
| | | **A.4) RESULTADO DEL EJERCICIO** | **1 497 322** ✅ | = I3 = saldo acreedor de 129 |

Fórmulas de los subtotales (`pygSubtotals` del JSON), **por número de epígrafe, no por rango de cuentas**:

| Subtotal | NORMAL | PYMES |
|---|---|---|
| A.1 Resultado de explotación | Σ 1…13 | Σ 1…12 |
| A.2 Resultado financiero | Σ 14…19 | Σ 13…18 |
| A.3 Resultado antes de impuestos | A.1 + A.2 = Σ 1…19 | A.1 + A.2 = Σ 1…18 |
| A.4 Resultado del ejercicio | A.3 + 20 | A.3 + 19 |

### 2.2 Lo que el fixture demuestra sobre los signos

| Caso | Efecto | Por qué importa |
|---|---|---|
| `7080` **Devoluciones de ventas** (contra, `is_contra = 1`) | Aporta **−100 000** dentro del **epígrafe 1** | Con R-P1 el signo sale solo: la devolución se anotó en el **debe** de una cuenta del grupo 7. Un renderizador que "restara las contra-cuentas" además del signo sumaría +100 000 |
| `6080` **Devoluciones de compras** (contra) | Aporta **+50 000** dentro del **epígrafe 4** | Simétrico. Aprovisionamientos queda en −580 000 y no en −680 000 |
| `REV-R-ERR` (`kind = REVERSAL`) | Devuelve +100 000 a `607` | **Sin tratamiento especial** (E3 §4.2): el par original + contra-asiento se neutraliza solo. **No existe filtro de anulados** |
| `AJ-002` (`113` contra `4100`, 250 000) | **No aparece en la PyG** | Ajuste **material** de ejercicio cerrado → contra reservas (T-22). Correcto: no contamina el resultado de 2026 |
| `IS-2026` (`6300` / `4752`) | Epígrafe 20/19, **después** de A.3 | Es lo que hace que A.3 = 1 996 430 y A.4 = 1 497 322. Si el motor metiera `630` en "otros gastos de explotación" (error frecuente), A.1 y el EBITDA saldrían mal y **A.4 seguiría bien**: el invariante que lo caza es I-E6-3 sobre A.3, no I3 |

### 2.3 Anomalías de mapeo detectadas en el seed (no bloqueantes)

| # | Hallazgo | Efecto en el fixture | Propuesta |
|---|---|---|---|
| **O-1** | `7080`/`708` mapean al epígrafe **1.a) Ventas**, pero el abono del fixture rectifica una **prestación de servicios** (`705`, 1.b). El INCN total es correcto; el desglose a/b no | −100 000 en `a) Ventas` con `a) Ventas` = 0 en bruto: aparece un epígrafe negativo aislado | Desdoblar `7080…7089` por tipo de operación no es viable (el PGC define `708x` por causa, no por naturaleza del ingreso). **Solución**: el motor imputa `706/708/709` al mismo subepígrafe (a/b) que la **cuenta de ingreso rectificada**, tomada del asiento origen (`reversesEntryId` o `sourceId`); si no la puede resolver, al subepígrafe **con mayor INCN del periodo**, y lo marca en `provenance` |
| **O-2** | El seed **no mapea ninguna cuenta** al epígrafe normal 19 / PYMES 18 «Otros ingresos y gastos de carácter financiero» (añadido por RD 602/2016) | Epígrafe siempre a 0 | Es correcto de fábrica: el epígrafe recoge `766`/`666` (por deudas con partes vinculadas) y la incorporación de resultados de participaciones; con el seed actual esas cuentas van a 14/15. **No bloquea E6**; se corrige en el seed, no en el renderizador |
| **O-3** | El seed no marca `6080` como perteneciente al mismo subepígrafe que la compra rectificada (mismo problema que O-1 en el lado del gasto) | +50 000 en `4.a) Consumo de mercaderías` en una empresa sin compras de mercaderías | Misma solución que O-1 |

---

## 3. Cashflow esperado — 2026

Tesorería = cuentas con prefijo **57** (`570` caja, `572` bancos). Saldo inicial = líneas 57x del asiento `OPENING` = **4 000 000**. Saldo final = **2 943 920**. **Δ = −1 056 080**.

### 3.1 Método directo — reglas

| Regla | Enunciado |
|---|---|
| **R-CF-1** | Tesorería = prefijo `57`. El saldo inicial se lee del asiento `OPENING`, **no** de un campo de configuración |
| **R-CF-2** | Universo = asientos del ejercicio con `kind ∉ {OPENING, CLOSING, REGULARIZATION}` |
| **R-CF-3** | **Regla POR LÍNEA, exacta.** Para cada asiento con ≥ 1 línea 57x, cada línea **no-57x** aporta `−(debit − credit)` a su bloque. Como el asiento está cuadrado (I1), la suma de aportes es **exactamente** el Δ57x del asiento. **El reparto proporcional se rechaza**: es innecesario aquí y destruye el drill-down línea a línea |
| **R-CF-4** | Asiento cuyas únicas líneas son 57x (**traspaso interno**, `TR-001`): Δ = 0, se **excluye** del cashflow y se lista en `internalTransfers`. Ya validado en el asiento por T-19 (las dos cuentas 57x y distintas) |
| **R-CF-7** | En un asiento que mezcla tesorería, una contrapartida **comercial** (`43x`/`40x`/`41x`/`438`/`407`) y las cuentas de **IVA de esa misma operación** (`472`/`477`), las líneas de IVA se asignan al **bloque comercial**, no a `PAGOS_IMPUESTOS`. Solo si hay **exactamente un** bloque comercial en el asiento; con varios, el IVA queda en impuestos y la Auditoría lo lista como WARN |

> **Por qué R-CF-3 basta y el reparto proporcional sobra.** El "problema de las varias contrapartidas" desaparece si se mira desde la línea y no desde el asiento. `CO-003` (cobro de 300 000 con 500 de comisión bancaria) genera **dos** aportes exactos —`+300 000` a cobros de clientes y `−500` a otros pagos de explotación— cuya suma es el Δ572 de 299 500. Repartir proporcionalmente los 299 500 entre las dos contrapartidas daría 299 001 y 499, que **no corresponden a ningún hecho** y no se pueden explicar al usuario. La proporcionalidad solo haría falta si la clasificación viviera en el asiento en vez de en la cuenta; no es el caso.
>
> **Por qué R-CF-7 es necesaria.** `ANT-C-01` (anticipo de cliente: `572` 242 000 / `438` 200 000 + `477` 42 000) tiene el IVA devengado **en el mismo asiento** que el cobro. Sin R-CF-7, el EFE mostraría un cobro de clientes de 200 000 y un **cobro de Hacienda de 42 000**, que es falso: Hacienda no ha pagado nada. El EFE mide cobros y pagos **brutos** (con IVA); el flujo con Hacienda aparece en su momento, en la liquidación trimestral. Cuando la factura y el cobro son asientos distintos —el caso normal— la cuestión no se plantea, porque en el asiento de cobro la única contrapartida es `430` por el importe bruto.

### 3.2 Tabla cuenta → bucket del método directo — **`seeds/npgc.csv`, columna `cashflow_bucket`**

Resuelve **O-9** y **O-10**. La tabla vive en `seeds/build_npgc.py` (`CASHFLOW_BUCKET`), se materializa como **14.ª columna** de `seeds/npgc.csv` y es la **única fuente de verdad**: ni el generador de fixtures ni el motor la redefinen. Se resuelve por **prefijo más largo que case**, igual que `naturaleza` y `estado_financiero`.

**Siete buckets** (enum de sistema `CashflowBucket`). La `CashflowCategory` de tres valores **se deriva**, no se almacena:

| Prefijos en `CASHFLOW_BUCKET` | Bucket | Categoría derivada | Filas del seed |
|---|---|---|---:|
| `43`, `438` | **COBROS_CLIENTES** | OPERATING | 24 |
| `40`, `407`, `41` | **PAGOS_PROVEEDORES** | OPERATING | 23 |
| `460`, `465`, `466`, `471`, `476` | **PAGOS_PERSONAL** | OPERATING | 5 |
| `47` (`470`, `472`, `473`, `475`, `477`, `479`…) | **PAGOS_IMPUESTOS** | OPERATING | 18 |
| `3`, `44`, `46`, `48`, `49`, `55`, `6`, `7` | **OTROS_EXPLOTACION** | OPERATING | 401 |
| `2`, `53`, `54`, `58`, `59` | **INVERSION** | INVESTING | 193 |
| `1`, `50`, `51`, `52`, `56` | **FINANCIACION** | FINANCING | 170 |
| `57` · contenedores `4` y `5` · grupos 8 y 9 | *(vacío)* | — | 72 |

`906 = 834 con bucket + 72 sin`. **OPERATING 471 · INVESTING 193 · FINANCING 170.**

Cinco decisiones que conviene fijar por escrito:
- **`57x` va vacío a propósito.** Es el sujeto del informe, no una contrapartida. Un asiento cuyas únicas líneas son 57x tiene Δ = 0 y se excluye (R-CF-4). Esto **invierte el aviso R-18 de E2** (O-12): la validación correcta es «`cashflowBucket` obligatorio en toda cuenta postable **salvo** 57x», y la exhaustividad la comprueba `validate_cashflow()` en el propio generador del seed, sobre las 906 filas.
- **`476` (Seguridad Social) → PERSONAL, no impuestos.** La cuota patronal es coste laboral, no tributo; agruparla con el IVA hace ilegible el bloque de personal. **Fijo por defecto**, override por organización en E9 vía mapa de buckets.
- **El impuesto sobre beneficios NO es un bucket** (R-CF-8). El EFE lo separa en la línea **8.d** «Pagos (cobros) por impuesto sobre beneficios», pero se **deriva dentro de `PAGOS_IMPUESTOS`** por las claves **`HP_ACREEDORA_IS`** y **`HP_DEUDORA_IS`** del `OrganizationAccountMap`, nunca por los códigos `4752`/`4709` escritos a mano. En el fixture vale **0**: el IS de 2026 se paga en julio de 2027 (`efeImpuestoBeneficiosCents: 0`, `efeOtrosImpuestosCents: −793 080`).
- **`66x`/`76x` contra tesorería → OPERATIVO.** El EFE sitúa «pagos de intereses» y «cobros de intereses y dividendos» en 8.b y 8.c, dentro de explotación, no en financiación. En el fixture son los redondeos y las diferencias de cambio de los cobros.
- **`407` y `438` siguen al flujo, no al epígrafe.** El anticipo a proveedor se presenta en el balance dentro de Existencias (§1.5) y el de cliente dentro de Acreedores, pero en el cashflow son un pago a proveedor y un cobro de cliente. Bucket y epígrafe son dimensiones distintas y no tienen por qué coincidir.

Coherencia padre-hijo: `validate_cashflow()` exige que un hijo solo cambie de bucket respecto de su padre si su prefijo está **declarado explícitamente** en `CASHFLOW_BUCKET`. Evita que una subcuenta nueva herede en silencio un bucket equivocado.

### 3.3 Cashflow directo mensual (céntimos)

| Mes | Cobros clientes | Pagos proveedores | Pagos personal | Pagos impuestos | Otros explotación | **Total** | **Saldo 57x** |
|---|---:|---:|---:|---:|---:|---:|---:|
| *inicial* | | | | | | | **4 000 000** |
| 2026-01 | 0 | 0 | 0 | 0 | 0 | 0 | 4 000 000 |
| 2026-02 | 979 000 | −242 000 | −585 000 | 0 | 0 | **152 000** | 4 152 000 |
| 2026-03 | 400 000 | 0 | −50 000 | 0 | 0 | **350 000** | 4 502 000 |
| 2026-04 | 300 000 | −121 000 | 0 | −417 480 | −500 | **−238 980** | 4 263 020 |
| 2026-05 | 500 000 | 0 | −535 000 | 0 | −5 000 | **−40 000** | 4 223 020 |
| 2026-06 | 300 000 | −100 000 | 0 | 0 | 6 000 | **206 000** | 4 429 020 |
| 2026-07 | 121 000 | 0 | 0 | −300 600 | −1 | **−179 601** | 4 249 419 |
| 2026-08 | 0 | −60 500 | −585 000 | 0 | 1 | **−645 499** | 3 603 920 |
| 2026-09 | 0 | 0 | 0 | 0 | 0 | 0 | 3 603 920 |
| 2026-10 | 0 | 0 | 0 | −75 000 | 0 | **−75 000** | 3 528 920 |
| 2026-11 | 0 | 0 | −585 000 | 0 | 0 | **−585 000** | 2 943 920 |
| 2026-12 | 0 | 0 | 0 | 0 | 0 | 0 | 2 943 920 |
| **ANUAL** | **2 600 000** | **−523 500** | **−2 340 000** | **−793 080** | **500** | **−1 056 080** | **2 943 920** |

`INVERSION` y `FINANCIACION` valen **0** en 2026 y se imprimen igualmente. Por categoría: **OPERATING −1 056 080 · INVESTING 0 · FINANCING 0**. **I6 = 0** ✅ (4 000 000 − 1 056 080 = 2 943 920). Desglose R-CF-8 de `PAGOS_IMPUESTOS`: **impuesto sobre beneficios 0 · otros tributos −793 080**.

Los meses sin flujo (enero, septiembre, diciembre) se imprimen **con ceros explícitos**: un informe mensual con meses ausentes es indistinguible de un informe truncado.

### 3.4 Método indirecto — regla y tabla

| Regla | Enunciado |
|---|---|
| **R-CF-5** | **Partición mecánica y exhaustiva.** Toda cuenta **no-57x** pertenece a **exactamente un** bloque. El aporte de cada línea es `−(debit − credit)`. Por construcción `Σ bloques = Δ57x`, con **tolerancia 0 y sin ajuste de cuadre** |
| **R-CF-6** | Los asientos **sin ninguna línea 57x** que tocan inversión o financiación son «operaciones que no han supuesto flujos de efectivo» (nota de la memoria del EFE): se listan en `nonCashEntries` y **explican** por qué el indirecto reparte importes que el directo nunca ve |

> **Por qué mecánica y no "contable".** El EFE oficial se construye a mano a partir del balance comparado, y por eso siempre hay una línea de ajuste. Aquí el indirecto se deriva del **diario**, y la identidad `Σ(debe−haber) = 0` de todo asiento garantiza que `Δ57x = −Σ Δsaldo(cuentas no-57x)`. Si cada cuenta cae en un bloque y solo en uno, la suma de bloques **es** Δ57x por álgebra, no por casualidad. El precio es que algún importe cae en un bloque que no le corresponde económicamente (§3.6); el beneficio es un invariante con tolerancia cero y sin partida de cierre.

| Bloque | Prefijos | 2026 (céntimos) | Cuentas |
|---|---|---:|---|
| **RESULTADO** | `6`, `7`, `129` | **1 497 322** | = I3 exactamente (I-E6-7) |
| **AJUSTES_NO_MONETARIOS** | `14`, `28`, `29`, `39`, `49`, `529`, `59` | **395 000** | `2816` 120 000 · `2817` 275 000 → la amortización del año, que anula el epígrafe 8 de la PyG |
| **VAR_CIRCULANTE_EXISTENCIAS** | `30`–`36` | 0 | |
| **VAR_CIRCULANTE_DEUDORES** | `43`, `44` | **−4 844 900** | `4300` −4 723 900 · `436` −121 000 |
| **VAR_CIRCULANTE_ACREEDORES** | `40`, `41`, `407`, `438` | **2 946 900** | `4000` 459 800 · `4100` 2 587 100 · `407` −100 000 · `438` 0 |
| **VAR_CIRCULANTE_ADMIN_PUBLICAS** | `47`, `476` | **699 598** | `4750` 245 490 · `4751` 75 000 · `4752` 499 108 · `473` −120 000 · resto 0 |
| **VAR_CIRCULANTE_PERIODIFICACIONES** | `48` | 0 | `480`, `485` cierran a 0 |
| **VAR_CIRCULANTE_OTROS** | `460`, `465`, `466`, `55` | 0 | |
| **INVERSION** | `20`–`27`, `53`, `54` | **−1 500 000** | `217` (compra de equipos, `R-009`) |
| **FINANCIACION** | `10`–`13`, `15`–`19`, `50`, `51`, `52`, `56` | **−250 000** | `113` (`AJ-002`, ajuste material contra reservas) |
| **TOTAL** | | **−1 056 080** | **= Δ57x** ✅ **= total del directo** ✅ |

### 3.5 Operaciones sin flujo de efectivo (R-CF-6)

`nonCashEntries = ['AJ-002', 'R-009']`.

| Asiento | Qué es | Efecto en el indirecto |
|---|---|---|
| **R-009** | Compra de equipos por 1 815 000 (1 500 000 + IVA) **a crédito**, contra `4100` | Inversión −1 500 000 e IVA +315 000 en AAPP, compensados por +1 815 000 en acreedores. Neto sobre la tesorería: **0**. El directo, correctamente, no lo ve |
| **AJ-002** | Ajuste **material** de ejercicio cerrado contra reservas `113`, 250 000, con `4100` de contrapartida | Financiación −250 000 compensada en acreedores. Neto: **0** |

Los dos deben ir en la nota de la memoria y, en la UI, en un desplegable «operaciones sin flujo de efectivo» bajo el cuadro del indirecto. Sin esa nota, un lector ve una inversión de 1 500 000 y una variación de acreedores de 2 946 900 que no cuadran con nada de lo que ha visto en el banco.

### 3.6 Distorsión conocida y aceptada

`R-009` compra inmovilizado contra **`4100` Acreedores por prestaciones de servicios**, no contra **`523` Proveedores de inmovilizado a corto plazo**. Consecuencias: (a) el balance presenta 1 815 000 de deuda por inmovilizado dentro de «Acreedores varios» del circulante comercial, cuando el modelo oficial la quiere en `C) III. Deudas a corto plazo`; (b) el indirecto mete esos 1 815 000 en variación de circulante en vez de en el bloque de inversión, e infla el fondo de maniobra aparente.

**No es un fallo del renderizador y no se corrige en E6**: el fixture es inmutable y el asiento es el que es. Se registra como **O-4** y la corrección corresponde a E8: la plantilla `FACTURA_RECIBIDA` debe elegir `523` cuando alguna línea es de inmovilizado (grupo 2), y el mapa de organización necesita una clave `PROVEEDORES_INMOVILIZADO → 523`, que **hoy no existe** entre las 57 `AccountKey`. Mientras tanto, la Auditoría lista como **WARN** todo asiento con una línea de grupo 2 y contrapartida `40x`/`41x`.

---

## 4. Invariantes formulados como test

Sobre `docs/design/fixtures/estados-esperados.json`, que es la referencia sellada. Tolerancia **0 céntimos** en todos. `L` = conjunto de `JournalLine` de la organización con `fiscalYearId = FY`; `saldo(c, K) = Σ_{l ∈ L, l.accountCode = c, l.kind ∉ K} (debit − credit)`.

### 4.1 I2 — Balance cuadrado

```
ACT(K)  = Σ_{c : statement(c) = BALANCE_ACTIVO}                    saldo(c, K)
PAS(K)  = Σ_{c : statement(c) ∈ {BALANCE_PASIVO, BALANCE_PN}}    (−saldo(c, K))
RES(K)  = I3  si  saldo("129", K) = 0  else  0            // R-B5, exclusivo
I2(K)   = ACT(K) − PAS(K) − RES(K)                        // debe ser 0
```
con la corrección de bidireccionales aplicada **antes** de sumar: para toda cuenta `c` con `bidirectional` y `saldo(c,K) < 0`, `c` se retira de ACT y se añade a PAS por `−saldo`. Nótese que la reclasificación **no altera** I2 (mueve el mismo importe de un lado al otro con el signo correcto): I2 no la detecta, la detecta I-E6-5.

| Caso límite | `K` | Resultado esperado |
|---|---|---|
| Ejercicio **sin regularizar** | `{REGULARIZATION, CLOSING}` | `saldo(129) = 0` → `RES = 1 497 322` · I2 = 0 |
| **Tras regularización** (balance formulado) | `{CLOSING}` | `saldo(129) = −1 497 322` → `RES = 0` · I2 = 0 |
| **Tras cierre** | `{}` | Todos los saldos a 0 · ACT = PAS = RES = 0 · I2 = 0 (**y además I-E6-8**) |
| **Apertura del siguiente** | FY 2027, `{}` | ACT = 13 673 820 · PAS = 13 673 820 · I2 = 0 |
| **129 con pérdidas** | cualquiera | `saldo(129) > 0` → PN A-1) VII **negativo**; `RES` se inyecta negativo si no está regularizado. I2 = 0. El PN total puede ser negativo sin que I2 falle |
| **Diario vacío** | — | 0 − 0 − 0 = 0. **PASS**, no error de división |

**Trampa a evitar**: `RES` e `saldo(129)` son **excluyentes**. Sumar los dos (o inyectar I3 «por si acaso») duplica el resultado y da `I2 = 1 497 322` justo el día del cierre — el fallo más caro de detectar, porque el informe cuadra los 364 días anteriores.

### 4.2 I3 — Resultado del periodo

```
I3 = Σ_{l ∈ L : grupo(l.accountCode) ∈ {6,7} ∧ l.kind ∉ {REGULARIZATION, CLOSING, OPENING}} (credit − debit)
```
Y, si el ejercicio está regularizado: `I3 = −saldo("129", {CLOSING})`.

| Caso límite | Esperado |
|---|---|
| Sin regularizar | I3 = 1 497 322 · `saldo(129) = 0` · la segunda igualdad **no se evalúa** |
| Regularizado | I3 = 1 497 322 = `−saldo(129)` · las dos igualdades en PASS |
| Tras cierre | I3 **no cambia** (el `CLOSING` está excluido) = 1 497 322 · `saldo(129) = 0` → la segunda igualdad **no se evalúa** (no «FAIL por 0 ≠ 1 497 322»: `K` para leer 129 es `{CLOSING}`, no `{}`) |
| Apertura del siguiente | I3(FY2027) = 0: la apertura es `OPENING` y está excluida. **No hereda el resultado de 2026** |
| Pérdidas | I3 < 0 = `−saldo(129)` con 129 deudor |
| Contra-asiento en el periodo | Se neutraliza solo. **Prohibido** cualquier filtro de `voidedAt`/`reversesEntryId` |
| Modelo PYMES | I3 idéntico: el modelo es presentación (I3[PYMES=NORMAL]) |
| BAI | `A.3 = 1 996 430`; `A.4 = A.3 + epígrafe 20 = I3`. Un motor puede acertar I3 y equivocar A.1/A.3 |

### 4.3 I6 — Cashflow

```
CASH   = {c : c LIKE '57%'}
inicial = Σ_{c ∈ CASH} saldo_OPENING(c)
Δ57x    = Σ_{l ∈ L : l.accountCode ∈ CASH ∧ l.kind ∉ {OPENING, CLOSING, REGULARIZATION}} (debit − credit)
final   = inicial + Δ57x

I6-directo    : inicial + Σ_bloques(directo)   = final
I6-indirecto  : Σ_bloques(indirecto)           = Δ57x
I6-coherencia : Σ_bloques(directo)             = Σ_bloques(indirecto)
I6-mensual    : inicial + Σ_{m=1..12} total(m) = final   (y el acumulado de cada mes = saldo 57x a fin de mes)
```

| Caso límite | Esperado |
|---|---|
| Sin regularizar / regularizado / tras cierre | **Idéntico**: los tres `kind` excluidos no tocan 57x salvo el `CLOSING`, que está fuera. El cashflow **no depende** del estado de cierre |
| Apertura del siguiente | `inicial(2027) = 2 943 920` (= final 2026, I-E6-9) · `Δ = 0` si no hay más asientos |
| Traspaso interno `570 ↔ 572` | Δ = 0, **excluido**, listado en `internalTransfers`. Un motor que clasificase por contrapartida sin R-CF-4 registraría +30 000 y −30 000 en «otros», inflando los dos lados del EFE |
| Mes sin movimiento | Fila con ceros, **presente** |
| Asiento con 2 líneas 57x y contrapartida (cobro repartido entre caja y banco) | R-CF-3 sigue siendo exacta: los aportes de las líneas no-57x suman el Δ conjunto |
| Diario vacío | inicial = 0, Δ = 0, final = 0. PASS |

### 4.4 Invariantes propuestos I-E6-x

| ID | Enunciado | Tolerancia | Estado en el fixture |
|---|---|---|---|
| **I-E6-1** | Balance **NORMAL** y balance **PYMES** cuadran al **mismo total de activo y de PN+pasivo**, en las cuatro fotos | 0 | PASS (4 fotos) |
| **I-E6-2** | **Σ epígrafes = Σ saldos**: ninguna cuenta con saldo ≠ 0 y `statement ∈ BALANCE_*` queda fuera de un epígrafe, y ningún epígrafe recibe una cuenta que no exista en el plan | 0 | PASS (4 fotos × 2 modelos) |
| **I-E6-3** | `A.3 = BAI` declarado por E4 (1 996 430) en los dos modelos | 0 | PASS |
| **I-E6-4** | `A.4 = I3` y `A.1 + A.2 = A.3` en los dos modelos | 0 | PASS |
| **I-E6-5** | Una cuenta **bidireccional nunca aparece en los dos lados** del balance en la misma foto | — | PASS (vacío en el fixture) |
| **I-E6-5b** | Para las 7 bidireccionales, la tabla `bidirectionalScenarios` (saldo +/−/0) reproduce exactamente `bidirectionalMirror`; saldo 0 no se presenta en ningún lado | 0 | PASS (sintético) |
| **I-E6-6** | Cashflow **mensual**: `inicial + Σ 12 meses = final`, y el acumulado de cada mes = saldo 57x a fin de mes | 0 | PASS |
| **I-E6-7** | El bloque `RESULTADO` del indirecto **es** I3, sin ajuste | 0 | PASS |
| **I-E6-8** | Tras el `CLOSING`, **ninguna** cuenta de balance conserva saldo | 0 | PASS |
| **I-E6-9** | El asiento de **apertura** del ejercicio siguiente reproduce el **balance formulado** cuenta a cuenta, **129 incluida** | 0 | PASS |
| **I-E6-10** | Toda cuenta `isContra` presenta importe **negativo** en su epígrafe (signo coherente con su naturaleza) | — | PASS. En PyG, `7080` y `6080` son la excepción intencionada: la contra de un **gasto** aporta positivo |
| **I-E6-11** | Balance **pre** y **post** regularización dan el mismo total y el mismo PN (R-B5 es neutra) | 0 | PASS |
| **I-E6-12** | `472` y `477` con saldo de **signo contrario** al natural a fecha de balance → WARN, nunca reclasificación (R-B6) | — | PASS (ambas a 0) |
| **I-E6-13** | **Regularización no desfasada**: `saldo(129) ≠ 0 ⇒ I3 = −saldo(129)`. Un FAIL significa líneas 6/7 posteriores a la `REGULARIZATION` (§8.6) | 0 | PASS |
| **I-E6-14** | **Aging**: `Σ tramos = saldo de la cuenta` a `refDate`, incluido el tramo `SIN_VENCIMIENTO` (§8.8) | 0 | *(pendiente del informe de aging)* |
| **I-E6-15** | **Aging**: ninguna línea aparece en dos tramos | — | *(pendiente del informe de aging)* |

I-E6-1 … I-E6-4, I-E6-6 … I-E6-9, I-E6-11, I-E6-13 y I-E6-14 son **FAIL** (bloquean el sello). I-E6-5b y I-E6-15 son de contrato. I-E6-10 e I-E6-12 son **WARN** de calidad de datos: no impiden emitir, sí marcan `REQUIERE_REVISIÓN`.

---

## 5. Comparativo y umbrales de revisión (`Organization.reviewThresholds`)

Estructura propuesta (bloque `reviewThresholds` del JSON). Un KPI dispara `REQUIERE_REVISIÓN` si **`|variación| > pctBps` Y `|variación absoluta| > minAbsCents`**. El suelo absoluto es imprescindible: sin él, pasar de 100 € a 300 € de gastos financieros dispara un 200 % y ahoga el sello en ruido.

| KPI | Definición | `pctBps` | `minAbsCents` | Por qué ese umbral |
|---|---|---:|---:|---|
| **ingresos** | Epígrafe 1 (INCN) | 1500 (15 %) | 500 000 (5 000 €) | En una PYME de proyectos, el 15 % mes a mes es ruido comercial normal (un hito facturado antes o después). Por encima suele ser un hito grande o una factura duplicada |
| **ebitda** | A.1 − epígrafe 8 | 2500 (25 %) | 300 000 | Más volátil que ingresos por apalancamiento operativo: los costes fijos no siguen a la facturación |
| **resultado** | A.4 | 3000 (30 %) | 300 000 | Apalancado sobre el EBITDA y, además, el IS solo aparece en el cierre |
| **tesorería** | Saldo final 57x | 2000 (20 %) | 1 000 000 (10 000 €) | Un cobro grande a fin de mes desplaza el saldo sin significar nada. Suelo alto a propósito |
| **deuda** | `17x + 52x + 40x + 41x` | 1000 (10 %) | 500 000 | La deuda se mueve por contrato, no por ruido: umbral estrecho. Un salto del 10 % sin operación conocida es un error de imputación |
| **dso** | `430 / INCN × 365` | 2000 | suelo de **10 días** | Muy sensible al mix de facturación |
| **margen bruto** | MC1 % | — | suelo de **300 bps** | Se compara en **puntos de margen**, no en porcentaje de variación: pasar del 2 % al 3 % es +50 % y es irrelevante |

**Base comparativa por defecto**: `SAME_PERIOD_PREVIOUS_YEAR`. Comparar contra el **mes anterior** en una empresa de proyectos genera falsos positivos sistemáticos (agosto, cierres de hito).

### 5.1 Variaciones **explicables** que NO deben disparar revisión

| ID | Situación | Regla |
|---|---|---|
| **EV-1** | El periodo comparado contiene `kind = OPENING` | Se excluyen `OPENING`/`CLOSING`/`REGULARIZATION` de **todo KPI de flujo** (PyG, cashflow). Nunca dispara |
| **EV-2** | Primer mes del ejercicio frente al último del anterior | La caída del resultado a cero en enero es **estructural**. Los KPIs de PyG se comparan **YoY del mismo mes**, jamás contra el mes anterior de otro ejercicio |
| **EV-3** | El periodo contiene el asiento del IS (T-25) o la regularización | La variación de `resultado` atribuible al epígrafe 20/19 y a `kind = REGULARIZATION` **se descuenta** antes de aplicar el umbral |
| **EV-4** | Liquidación trimestral de IVA/IRPF (meses 1, 4, 7, 10) | El pico de `PAGOS_IMPUESTOS` es esperado: el umbral se aplica sobre la **media de los cuatro trimestres**, no mes a mes |
| **EV-5** | Un `REVERSAL` y su original caen en el mismo periodo | Se **netean** antes de calcular la variación |
| **EV-6** | Alta o baja de un proyecto o CECO | Los KPIs por dimensión se comparan solo sobre dimensiones **vivas en ambos** periodos; las nuevas se listan como «altas», no como variación |

### 5.2 Variaciones que **SÍ** disparan revisión siempre, con independencia del umbral

| ID | Situación | Motivo |
|---|---|---|
| **EV-7** | Cambio de `AllocationRun` o de `MarginLevelConfig` (`analyticsHash` distinto) | **No es una variación: es una redefinición de la métrica.** Comparar dos periodos con configuraciones analíticas distintas es comparar dos cosas distintas |
| **EV-8** | `ReportRun.gitSha` distinto del run comparado | Primer run tras un cambio de motor (SPEC-FIABILIDAD, sello) |
| **EV-9** | Cualquier invariante I1–I10 o I-E6-x en FAIL | Sello `REQUIERE_REVISIÓN` con el ID del invariante como `sealReason` |
| **EV-10** | Cambio de `epigraph` de una cuenta con líneas en el periodo comparado (`AuditLog`) | La partida cambió de sitio: la variación del epígrafe es artefacto |

---

## 6. Veredicto

### 6.1 `docs/MODELO-DATOS.md` §`ReportRun` / `ReportType` / `Seal` — **CONFORME CON OBSERVACIONES**

Lo que está bien y no debe tocarse: `ReportRun` cubre P3 y P7 (periodo, `params`, `ledgerHash`, `gitSha`, `result`, `provenance`, `validation`, `durationMs`); `ledgerHash` **excluye** las cuatro columnas analíticas (E4-D2/ADR-0010), que es lo único que permite que un balance sellado sobreviva a una reimputación; `Seal` de dos valores es suficiente —un tercer valor intermedio invitaría a emitir con dudas—; los 10 `ReportType` cubren los informes de la skill `estados-financieros`.

| # | Observación | Severidad | Propuesta |
|---|---|---|---|
| **O-5** | `ReportType` **no distingue las cuatro fotos del balance** (§1.1). Dos `BALANCE` del mismo periodo y el mismo `ledgerHash` con distinto `kind` excluido dan **el mismo hash** y son informes distintos: la clave de reutilización `(organizationId, type, ledgerHash)` devolvería el cacheado equivocado | **ALTA** | No añadir tipos. `params` **debe** llevar `{ snapshot: PRE_REGULARIZACION \| POST_REGULARIZACION \| POST_CIERRE, variant: NORMAL \| PYMES }` y `params` **debe entrar en la clave de reutilización**: `(organizationId, type, ledgerHash, paramsHash, analyticsHash)`. Hoy la clave documentada no incluye `params` y eso es un bug de caché que devuelve cifras correctas del informe equivocado |
| **O-6** | `ReportRun` no guarda el **periodo comparativo** ni el `ReportRun.id` con el que se comparó | MEDIA | Añadir `comparativeRunId String?` + `comparativeBasis String?`. Sin ello, EV-1…EV-10 no son auditables: no se puede reconstruir contra qué se midió la variación que disparó el sello |
| **O-7** | `sealReason` es `String?` libre | BAJA | Que sea un array de `{code, invariantId?, kpi?, deltaBps?}` en JSON. La Auditoría necesita filtrar por motivo, no hacer `LIKE` |
| **O-8** | No hay campo de **moneda ni de unidad** en `result` | BAJA | `params.currency` explícito. Todo es EUR y céntimos hoy, pero un informe sellado sin unidad es un número sin significado dentro de cinco años |

### 6.2 Columnas de `LedgerAccount` para informes — **CONFORME CON OBSERVACIONES**

`statement` + `epigraph` + `epigraphPymes` + `isContra` + `bidirectional` son **suficientes y necesarias** para construir el balance y la PyG de los dos modelos con las reglas R-B1…R-B6 y R-P1, sin ninguna otra tabla y sin lógica por código de cuenta hardcodeada. Guardar **las dos** cadenas de epígrafe (en vez de derivar PYMES de NORMAL) está bien resuelto: §1.3 muestra que la correspondencia no es una regla, es una tabla. `isContra` como flag de presentación y no de cálculo es la decisión correcta y hay que dejarla escrita en el código para que nadie la "arregle".

| # | Observación | Severidad | Propuesta |
|---|---|---|---|
| **O-9** | ~~`cashflowCategory` no se siembra~~ → **RESUELTA**. `seeds/build_npgc.py` gana la tabla `CASHFLOW_BUCKET` y `seeds/npgc.csv` la 14.ª columna `cashflow_bucket` (§3.2); `--check` reproduce el CSV byte a byte | ~~ALTA~~ **cerrada** | Hecho. 834 de 906 filas con bucket; las 72 sin él son 57x, los contenedores `4`/`5` y los grupos 8/9. `validate_cashflow()` garantiza la exhaustividad en el propio generador |
| **O-10** | ~~`CashflowCategory` de 3 valores es demasiado grueso~~ → **RESUELTA**. Enum de sistema `CashflowBucket` con **7 valores**; la categoría de 3 se **deriva** | ~~ALTA~~ **cerrada** | `LedgerAccount.cashflowBucket CashflowBucket?` = `COBROS_CLIENTES · PAGOS_PROVEEDORES · PAGOS_PERSONAL · PAGOS_IMPUESTOS · OTROS_EXPLOTACION · INVERSION · FINANCIACION`. `cashflowCategory` pasa a ser **función pura** del bucket, no columna. La línea 8.d del EFE se deriva por `AccountKey`, no por código (R-CF-8) |
| **O-11** | No existe columna para el **bloque del cashflow indirecto** (§3.4) | MEDIA | `indirectBlock` como **función pura sobre `statement` + prefijo**, no columna: la partición de R-CF-5 debe ser **exhaustiva por construcción** y una columna nullable permite huecos que romperían I6 en silencio. Que viva en `lib/reports/cashflow.ts` con un test de exhaustividad sobre las 906 cuentas del seed |
| **O-12** | R-18 de E2 («`cashflowCategory` solo en 57x y contrapartidas») queda **invertida** por §3.2 | MEDIA | Sustituir R-18 por: «`cashflowBucket` obligatorio en toda cuenta postable **salvo** 57x, que es la propia tesorería». Hoy el aviso salta justo cuando el dato está bien puesto |
| **O-13** | Falta `AccountKey.PROVEEDORES_INMOVILIZADO → 523` (§3.6, O-4) | MEDIA | Añadir la clave. Sin ella no hay forma de que una factura de inmovilizado a crédito salga del circulante comercial. **E8** |
| **O-14** | `epigraph` es texto libre con la jerarquía codificada en la cadena (`" / "` como separador) | BAJA | Funciona y es legible en el CSV, pero el orden de presentación se reconstruye parseando romanos y letras (`seg_key` del generador). Si en algún momento hay que ordenar en SQL, hará falta `epigraphSortKey`. **No bloquea**: hoy el orden se calcula en el renderizador |

### 6.3 Veredicto global de E6

**CONFORME CON OBSERVACIONES.** El balance (dos modelos, cuatro fotos), la PyG (dos modelos, subtotales oficiales) y el cashflow (directo mensual y anual, indirecto) del fixture están calculados, sellados y con **I2 = 0, I3 = 1 497 322, BAI = 1 996 430, I6 = 0** y **47 checks en PASS**. **Los dos bloqueantes (O-9 y O-10) están cerrados** con la columna `cashflow_bucket` del seed y el enum de 7 valores. No queda ninguna observación de severidad ALTA sobre `LedgerAccount`; la única que resta en `ReportRun` es **O-5** (`paramsHash` en la clave de caché), ya decidida por el coordinador. **El modelo de datos soporta los tres informes.**

---

## 7. Decisiones del coordinador sobre las dudas planteadas

| # | Duda | Decisión | Dónde queda |
|---|---|---|---|
| 1 | O-5: `paramsHash` vs desdoblar `ReportType` | **`paramsHash` en la clave de caché**, no desdoblar el enum | §6.1 O-5. La variante y la foto son **parámetros**, no informes distintos |
| 2 | O-10: enum Prisma vs tabla configurable | **Enum Prisma `CashflowBucket` de 7 valores**, de sistema; categoría de 3 derivada. Configurable por organización **en E9** si hace falta | §3.2 y `seeds/build_npgc.py` |
| 3 | `476` en PERSONAL | **Fijo por defecto**; override por organización vía mapa de buckets **en E9** | §3.2 |
| 4 | 473 vs 4752 | **No compensar** (art. 37 CdC). El informe lleva **nota al pie obligatoria** «Sin compensación de saldos: los créditos frente a la Hacienda Pública (retenciones y pagos a cuenta soportados) se presentan en el activo y la deuda por impuesto corriente en el pasivo, sin netear (art. 37 CdC y NRV 9ª)» | §1.5, fila `473` |

---

## 8. Respuestas al arquitecto (`docs/design/E6-informes.md` §10)

### 8.1 — Fixture `estados-esperados.json`: **entregado**

`docs/design/fixtures/estados-esperados.json`, generado por `build_estados_esperados.py` (Python puro, `--check` reproduce byte a byte, 46 checks en PASS). Cubre **más** de lo pedido: **cuatro** fotos en vez de dos (§1.1 — se añaden `POST_CIERRE` y `APERTURA_2027`, que son los casos límite donde fallan los motores), las **dos** variantes, cashflow **directo mensual y anual** e **indirecto**, `lineDetail` por línea para el drill-down, y `bidirectionalScenarios` para la regla que el fixture no ejercita. Desbloquea T2, T6, T7 y T8.

### 8.2 — Epígrafes espejo de las 7 bidireccionales

**§1.4** de este documento, tabla completa en los dos modelos; cadenas verbatim del seed en `bidirectionalMirror` del JSON, y casos de prueba (+/−/0) en `bidirectionalScenarios`. **Se levanta el WARN de R2**: la regla ya no se supone. Resumen: `551` y `5525` → *Otros pasivos financieros* (C.III.5 / PYMES C.II.5) · `552`, `5523`, `5524` → *Deudas con empresas del grupo y asociadas a c/p* (C.IV / PYMES C.III) · `554` y `555` → *Acreedores varios* (C.V.3 / PYMES C.IV.3). Tres precisiones que el diseño debe recoger: la reclasificación es **por cuenta postable y por su saldo neto a la fecha del balance** (nunca por línea ni por movimiento); con subcuentas (`5510` deudor, `5511` acreedor) se aplica **a cada una por separado**, porque compensarlas sería compensar un crédito y una deuda frente a personas distintas (art. 37 CdC); y `555` con saldo ≠ 0 al cierre es, además, **WARN de Auditoría** (cuenta puente).

### 8.3 — Clasificación de cashflow: **tabla confirmada con cuatro matices**

La tabla de §3.4 del diseño se confirma en lo sustancial y queda **sustituida por §3.2 de este documento**, que ahora vive en el seed. Respuestas a las tres preguntas concretas:

| Pregunta | Respuesta | Norma |
|---|---|---|
| **¿66x en explotación o en financiación?** | **Explotación.** El EFE del PGC sitúa «Pagos de intereses» en el epígrafe **8.c** y «Cobros de intereses y dividendos» en el **8.b**, ambos dentro de *«Otros flujos de efectivo de las actividades de explotación»*. En financiación van los **principales** (`17x`, `52x`), no el coste financiero | RD 1514/2007, modelo de EFE, epígrafe 8 |
| **¿el IVA (472/477/475) es explotación siempre?** | **Sí, siempre.** El IVA es un flujo de explotación con independencia de qué operación lo genere: el IVA soportado de una **compra de inmovilizado** es explotación, y solo el importe **sin IVA** del activo va a inversión. Es exactamente lo que hace R-009 en el fixture (§3.5). Además, R-CF-7: si el IVA se devenga en el **mismo asiento** que el cobro o el pago (anticipos), sigue al bloque comercial, porque el EFE mide flujos **brutos** | Modelo de EFE + NRV 12ª |
| **¿57x ↔ 57x se excluyen?** | **Sí, confirmado (R-CF-4).** Un traspaso banco↔caja no es un flujo: es un cambio de sitio dentro del mismo agregado «efectivo y otros activos líquidos equivalentes». Incluirlo inflaría los dos lados del informe con un importe que nunca entró ni salió. El fixture tiene `TR-001` (30 000 de `572` a `570`) y el JSON lo lista en `internalTransfers`. **Ojo**: la exclusión es porque las dos cuentas son 57x, **no** porque la variación neta sea 0; la regla se aplica antes de mirar el importe | Concepto de efectivo, NRV 9ª y modelo de EFE |

Cuarto matiz, no preguntado pero necesario: **`4752` (IS) no es un bucket** (R-CF-8). El EFE sí tiene línea propia (8.d) y se **deriva** dentro de `PAGOS_IMPUESTOS` por `HP_ACREEDORA_IS`/`HP_DEUDORA_IS`, nunca por código literal.

### 8.4 — Estructura oficial del EFE y exigibilidad en PYMES

**El EFE NO es obligatorio para quien formula balance y memoria abreviados ni en el PGC PYMES** (art. 257.3 LSC y RD 1515/2007: los modelos de PYMES **no incluyen** estado de flujos de efectivo). Nuestro cliente objetivo está, casi siempre, en ese supuesto. Consecuencia de producto: el cashflow es un **informe de gestión**, no una cuenta anual, y hay que decirlo en la cabecera («Informe de gestión. No forma parte de las cuentas anuales abreviadas»). Eso **libera** de reproducir la numeración oficial y permite el desglose mensual, que es lo que el usuario quiere y que el modelo oficial no contempla.

Dicho eso, la estructura que **sí** debemos ofrecer como vista alternativa —para quien formule modelo normal, y porque es el lenguaje del asesor— es la del modelo oficial, con nuestros buckets mapeados:

| Bloque oficial | Contenido | Nuestros buckets |
|---|---|---|
| **A) Flujos de efectivo de las actividades de explotación** | 1. Resultado antes de impuestos · 2. Ajustes del resultado · 3. Cambios en el capital corriente · 4. Otros flujos de explotación · **5. Flujos de explotación (1+2+3+4)** | Método **indirecto**: bloques `RESULTADO`, `AJUSTES_NO_MONETARIOS`, `VAR_CIRCULANTE_*`. Método **directo**: `COBROS_CLIENTES`, `PAGOS_PROVEEDORES`, `PAGOS_PERSONAL`, `PAGOS_IMPUESTOS`, `OTROS_EXPLOTACION` |
| **B) Flujos de las actividades de inversión** | 6. Pagos por inversiones · 7. Cobros por desinversiones · **8. Flujos de inversión (7−6)** | `INVERSION` |
| **C) Flujos de las actividades de financiación** | 9. Cobros y pagos por instrumentos de patrimonio · 10. Cobros y pagos por instrumentos de pasivo financiero · 11. Pagos por dividendos · **12. Flujos de financiación** | `FINANCIACION` |
| **D) Efecto de las variaciones de los tipos de cambio** | | **0 en nuestro caso**: el ERP trabaja en moneda base y las diferencias de cambio son de transacción (`668`/`768`), que van a explotación. Se imprime como 0 y se documenta. Con `ExchangeRate` y saldos 57x en divisa (v2) dejará de ser 0 |
| **E) Aumento/disminución neta del efectivo** | A+B+C+D · Efectivo al inicio · Efectivo al final | `deltaCashCents`, `openingCashCents`, `closingCashCents` — **es I6** |

Numeración del EFE **una sola** (el modelo abreviado de EFE no existe: o se presenta el normal o no se presenta). Recomendación de producto: **directo mensual como vista por defecto** (es lo que un gerente entiende y lo que ningún programa de contabilidad le da) y el indirecto en la estructura A/B/C/D/E como segunda pestaña, para el asesor.

### 8.5 — Definición de EBITDA del panel

**La misma que E4, sin variante propia del panel.** La tabla canónica de márgenes vive en `.claude/skills/contabilidad-analitica` y E4 la fijó; duplicarla aquí con otra fórmula es cómo nacen los dos EBITDA que no cuadran.

```
EBITDA = A.1) Resultado de explotación
       − epígrafe 8 (Amortización del inmovilizado)          [681/682/680 → aporte negativo, se resta ⇒ suma]
       − epígrafe 11 (Deterioro y rdo. por enajenaciones del inmovilizado)
```
Es decir: **A.1 con los epígrafes 8 y 11 revertidos**, y **nada más**.

Respuesta a las dos preguntas concretas: **el epígrafe 13/12 «Otros resultados» SÍ entra en el EBITDA**, y esto no es opinable. El PGC 2007 **suprimió el resultado extraordinario**: `678`/`778` están **dentro del resultado de explotación**. Excluirlos daría un EBITDA distinto del que se deduce de las cuentas depositadas y es la vía clásica de maquillaje («mi EBITDA recurrente excluye lo excepcional»), que E4 §8.3 ya rechazó para el `AnalyticType` y que no vamos a reintroducir por la puerta del panel. **Los deterioros de circulante (`694`/`794`, epígrafe 7 y 5) también entran**: son gasto operativo recurrente en una empresa de proyectos, no un ajuste de inmovilizado; solo se revierte el **11**, que es el de inmovilizado. En el fixture: **EBITDA = 1 995 430 + 395 000 = 2 390 430**.

### 8.6 — Resultado en el balance con el ejercicio regularizado y no cerrado

**R-B5, que es exactamente la pregunta.** La regla es **exclusiva y se decide por el saldo de 129, no por un flag de estado**:

```
si saldo(129) = 0  →  PN A-1) VII = I3   (calculado)
si saldo(129) ≠ 0  →  PN A-1) VII = −saldo(129)   (leído)
```

Nunca las dos cosas. Sumarlas —o inyectar I3 «por si acaso»— duplica el resultado y produce `I2 = 1 497 322` **el día del cierre y solo ese día**, que es el fallo más caro de detectar porque el informe cuadra los 364 días anteriores. Que la regla dependa del **saldo** y no del estado del ejercicio es deliberado: `FiscalYear.status` puede seguir `OPEN` con la regularización ya posteada, y al revés no ocurre.

**Segunda parte de la pregunta — 129 con saldo *y además* líneas 6/7 posteriores a la regularización.** Es un estado **inconsistente**, no un caso a soportar: el balance sería correcto (lee 129) pero **incompleto**, porque el resultado de esas líneas nuevas no está en ningún sitio. Tratamiento en tres capas:

1. **Prevención (E3/E8)**: postear en 6/7 con `entryDate` posterior a la `REGULARIZATION` del ejercicio debe **bloquearse** salvo `ADMIN` con motivo, exactamente como el mes bloqueado. El camino correcto es **anular la regularización con contra-asiento, postear, y volver a regularizar**.
2. **Detección (E6)**: invariante nuevo **I-E6-13** — `saldo(129, {CLOSING}) ≠ 0 ⇒ I3 = −saldo(129)`. Si hay líneas 6/7 posteriores, la igualdad **falla** y es un **FAIL**, no un WARN: es I3 quien lo caza, no I2.
3. **Presentación**: mientras I-E6-13 esté en FAIL, el balance se emite con sello **`REQUIERE_REVISIÓN`** y motivo `REGULARIZACION_DESFASADA`, mostrando **las dos cifras** (129 y I3) y su diferencia. Nunca se elige una en silencio.

### 8.7 — Comparativo: **mismo periodo del ejercicio anterior**, con el acumulado anual como segunda columna

**Base por defecto `SAME_PERIOD_PREVIOUS_YEAR`** (§5). Motivo: en una empresa de proyectos y servicios la estacionalidad es fortísima (agosto, cierres de hito, liquidaciones trimestrales) y comparar un trimestre contra el ejercicio anterior **completo** compara cuatro meses con doce. Reglas por tipo de informe:

| Informe | Columna 1 | Columna 2 (comparativo) | Columna 3 (opcional) |
|---|---|---|---|
| **PyG / cashflow de un periodo** (mes, trimestre) | Periodo | **Mismo periodo del ejercicio anterior** | Acumulado del ejercicio (YTD) vs YTD anterior |
| **PyG / cashflow del ejercicio completo** | Ejercicio | Ejercicio anterior completo | — |
| **Balance** (es un stock, no un flujo) | Fecha de cierre | **Misma fecha del ejercicio anterior** y, además, **cierre del ejercicio anterior** — que es lo que exige el modelo oficial de cuentas anuales (columnas N y N−1) | — |

Dos precisiones: el balance **siempre** lleva la columna del **cierre anterior** aunque el informe sea a 30 de junio, porque es la que el asesor y el modelo oficial esperan. Y si el ejercicio anterior **no existe** o no tiene asiento de apertura, la columna se imprime **vacía con la leyenda «sin comparativo»**, nunca a cero: un cero es una cifra y afirmaría algo falso.

### 8.8 — Aging de 430/400: **desde el vencimiento**, tramos 0–30 / 31–60 / 61–90 / >90

| Cuestión | Respuesta | Por qué |
|---|---|---|
| **Base del tramo** | **Días desde `dueDate`** (vencimiento), no desde la fecha de factura | El aging mide **mora**, no antigüedad. Una factura a 90 días emitida hace 80 no está vencida y no debe aparecer en «61–90»; mezclar las dos bases hace que una empresa con plazos largos parezca morosa. La antigüedad desde factura es otra métrica (**DSO**) y va en otra columna |
| **Tramos** | `NO_VENCIDO` · `1–30` · `31–60` · `61–90` · `>90` | Cinco tramos, no cuatro: **el no vencido es imprescindible** y no cabe en «0–30». Coinciden con la Ley 3/2004 de morosidad (60 días máximo entre empresas) y con lo que pide un banco. El corte de **90 días** es además el umbral fiscal del art. 13.1.a LIS para la deducibilidad del deterioro de créditos: hay que poder señalarlo |
| **Referencia temporal** | `refDate` del informe, **no** `Date.now()` | `lib/ledger/` y `lib/analytics/` tienen prohibido `Date.now()` (CLAUDE.md). Dos ejecuciones del mismo informe con el mismo `ledgerHash` deben dar el mismo aging: `refDate` entra en `params` y por tanto en `paramsHash` |
| **Líneas sin `dueDate`** | **Tramo propio `SIN_VENCIMIENTO`, visible, primero de la tabla, y check de calidad de datos en Auditoría** | Confirmo la propuesta del arquitecto. Las tres alternativas son peores: tratarlas como vencidas inventa una mora; tratarlas como no vencidas esconde deuda real; excluirlas descuadra el total contra el saldo de la cuenta. Con tramo propio, **Σ tramos = saldo de la cuenta** siempre (invariante **I-E6-14**), que es lo único innegociable |
| **Signo y parciales** | El aging se calcula sobre el **saldo vivo por línea** (`dueDate` de la línea 43x/40x, E3), no por factura. Una línea con saldo de signo contrario (cobro sin aplicar, abono) va a un tramo `A_APLICAR` y **no se compensa** con las vencidas | Compensar un anticipo contra una factura vencida hace desaparecer la mora del informe |
| **Agrupación** | Por **cuenta** y vencimiento hasta E8; por **contraparte** cuando exista `Counterparty` | Es el R6 del arquitecto y estoy de acuerdo con declararlo en pantalla. Con `4300` como cuenta única, el aging agregado es correcto pero el detalle por cliente no existe: el drill-down a líneas es el sustituto honesto |

Invariantes propuestos: **I-E6-14** `Σ tramos del aging = saldo de la cuenta a refDate` (tolerancia 0) y **I-E6-15** `ninguna línea en dos tramos`.
