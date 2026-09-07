# ADR-0016 — Cierre, reapertura y distribución del resultado; amortización, periodificación y valoración deterministas; prorrata definitiva y modelo 303; reclasificación por vencimiento; diferencias de cambio al cierre; RECC y REDEME

**Estado:** **APROBADO por Pablo el 2026-09-07** (permiso general delegado de 2026-09-04) · **Nivel:** 2 · **Fecha:** 2026-09-07 · **Épica:** E9 · **Decisiones:** **D1–D12** · **Diseño:** `docs/design/E9-cierre-recurrentes.md` (ronda 1) · **Validación contable:** `docs/design/E9-validacion-cierre.md` — **CONFORME CON OBSERVACIONES** tras la re-validación (en la ronda 0, **NO CONFORME** en D4–D8 y en el alcance, con **22 bloqueantes** O-1…O-22 y **ocho** O-23…O-30); **las treinta están incorporadas**, más los tres retoques de cierre **R2-1**, **R2-2** y **R2-3** · **Precisa:** ADR-0003, ADR-0005, ADR-0006, ADR-0009, ADR-0012, ADR-0014, ADR-0015 · **Enmienda:** la **decisión 4 de `docs/design/E3-libro-diario.md` §9.2** («ejercicio cerrado: sin reapertura») y las **reglas de numeración N-1 / N-5** de E3 §2.1 — ver **D1**

> **Ronda 1.** La validación contable declaró **NO CONFORME** cinco de las ocho
> decisiones y el alcance de la épica. **D4, D5, D6, D7 y D8 se reescriben**;
> D1, D2 y D3 se precisan; y se añaden **D9** (orden de los asientos de cierre),
> **D10** (distribución del resultado), **D11** (atribución de la amortización por
> activo) y **D12** (subcuentas de retenciones por modelo). Diez de los defectos
> producían **un balance mal clasificado, una PyG con el resultado en el ejercicio
> equivocado o una autoliquidación incorrecta** — no imprecisa: incorrecta.
>
> **Re-validación (R2), incorporada:** **R2-1** — 23 pares de reclasificación
> (176↔**5595**, 177↔**500**, partes vinculadas en cuatro pares **sin 514**, y
> `527`/`528` fuera); **R2-2** — el **capital social se deriva del saldo de `100`**,
> no se teclea, y el campo queda sólo como contingencia con WARN; **R2-3** — el
> atributo es **`LedgerAccount.isMonetary`**, no `Account.isMonetary`.
>
> **APROBADO el 2026-09-07.** Las tareas de Nivel 2 quedan desbloqueadas y la
> épica puede pasar a `/sprint E9`.

---

## Contexto

E9 cierra el ciclo contable: lo que se repite, lo que se liquida por periodo, lo
que se ajusta al cierre y lo que se distribuye después. Doce de sus decisiones
son de **Nivel 2** porque tocan el motor contable, el esquema de asientos, cifras
**declarables ante la AEAT**, la presentación del balance, el patrimonio neto o
decisiones ya cerradas por el experto en épicas anteriores.

E9 hereda además deuda fechada por E7 y E8 en `docs/ESTADO.md` —523→173, valor
actual del aplazamiento, RECC/REDEME, DUA, 668/768— que existe precisamente
porque estas decisiones no estaban tomadas.

La ronda 0 de este ADR acertó en la arquitectura y falló en el mapeo contable y
fiscal. El experto lo dice así: *«ninguno de los defectos está en la
arquitectura, que es sólida; todos están en el mapeo contable y fiscal»*.

**Lo que la validación confirma y no se reabre:** el cierre como acto sellado con
lista bloqueante evaluada **también en servidor**; el cuadro de amortización como
función pura **no almacenada** (ADR-0003); la idempotencia por índice único y no
por `if`; **`Δ = D×r − S`** sin restar lo ya reconocido —la lección N-1 de E7, que
además de operativamente correcta es **contablemente** correcta—; el rechazo
explícito de los métodos degresivos frente a un enum inerte; la prorrata como
porcentaje **entero redondeado al alza** con CHECK de múltiplo de 100; el
**régimen de IVA fechado** en vez de una columna —sin él se reagruparían periodos
ya presentados, y eso sólo se descubre en una inspección—; la reversión periodo a
periodo de la periodificación; la negativa a adivinar un vencimiento ausente; y
la aritmética entera en `pct`/`bps`.

**Tolerancia 0** en todo lo que compara importes: es correcta y **alcanzable**,
porque las tres reglas de reparto de E9 (D2.2, D3.2 y D8.3) llevan el residuo a
una fila determinada y **no hay reparto por mayor resto en ningún punto**. No se
relaja en ningún caso.

---

## D1 — Cierre como acto sellado y reapertura controlada *(precisada: O-20, O-21, Q-1)*

**Decisión.**

1. El cierre es un **acto sellado**: `ClosingRun` con una lista de comprobación
   de **41 pasos en nueve bloques** (D9), **nueve de ellos bloqueantes**,
   evaluados también **en servidor** al cerrar y no sólo al pintar el botón.
2. **La reapertura existe** y es **anulación por contra-asiento** (T-21), con
   motivo ≥ 30 caracteres, rol **ADMIN**, confirmación escribiendo el código del
   ejercicio y `AuditLog`, en una sola transacción.
3. **Sólo con `accountsApprovalStatus = BORRADOR`.** Con `FORMULADAS` o posterior
   es **reformulación** (arts. 253, 272 y 279 LSC) y se rechaza. **Pero el mensaje
   no dice «imposible»**: dice *«requiere acuerdo de reformulación (NRV 23ª);
   regístrelo y vuelva a marcar el ejercicio como BORRADOR»*. Es la precisión 1 de
   Q-1: **si el producto no ofrece salida, el usuario la fabricará por SQL**.
4. **(Q-1.2)** `FiscalYear.taxFilingStatus`. Si el modelo 200 ya se presentó,
   reabrir obliga a autoliquidación complementaria o rectificativa (art. 122 LGT):
   aviso obligatorio, recogido en `AuditLog` y como motivo de sello
   `MODELO_200_PRESENTADO`.
5. **(O-21) La reversión incluye T-25.** Orden inverso: **T-28 → T-27 → T-26 →
   T-25**. Sin T-25, al recerrar el impuesto se posteaba otra vez y `6300` quedaba
   al doble con `4752` duplicado y una base imponible que ya no coincidía con
   nada. Los ajustes 5-7 (valor actual, diferencias de cambio, reclasificación)
   **no se revierten** —son idempotentes por construcción— y quedan marcados
   **`PENDIENTE_RECOMPUTO`** para que el asistente los reevalúe y **sólo postee
   delta si lo hay**.
6. **(O-20) Numeración por asiento vivo.** E3 §2.1 exigía `OPENING` = nº 1 y
   `CLOSING` = último **por posición absoluta**; tras una reapertura el nuevo T-28
   recibía `entryNumber = 4` y **el cierre nuevo se bloqueaba a sí mismo**. Se
   reformula:
   - **N-1′**: el `OPENING` **no anulado** es el de menor `entryDate` del ejercicio
     y tiene fecha del primer día. Deja de exigirse `entryNumber = 1`.
   - **N-5′**: el `CLOSING` **no anulado** es el de mayor `entryDate` y tiene fecha
     del último día.
   - La numeración sigue siendo correlativa y sin huecos (art. 29.1 CCom), y un
     contra-asiento **consume su número** (N-4, sin cambios).
7. Reabrir N con **N+1 ya cerrado** es **bloqueante**: hay que reabrir antes N+1.
   El asistente lista además los asientos de N+1 posteriores a la apertura y exige
   una segunda confirmación.
8. **(Q-1.3) I-E9-21 ampliado**: tras la reapertura, el saldo de **cada cuenta de
   los grupos 1 a 7** vuelve al previo al cierre, y **`129 = 0` y `6300 = 0`**. El
   enunciado anterior sólo miraba las cuentas de balance y dejaba pasar una
   reversión defectuosa de T-26 con la PyG partida.

**Enmienda.** La decisión 4 de E3 §9.2 decía «no existe reapertura» sin condición.
Se **matiza**: no existe reapertura de cuentas **formuladas**. Reabrir un
ejercicio `CLOSED` con las cuentas en `BORRADOR` no toca ninguna cuenta rendida y
respeta el art. 29.1 CCom —**nada se borra**— y el art. 30 CCom. El experto lo
confirma: *«la frontera propuesta es la correcta»*.

---

## D2 — Amortización *(precisada: O-19, O-22, O-23, O-24, O-28, O-30)*

**Decisión.**

1. **Sólo `LINEAL`.** Los otros tres valores del enum se declaran y el motor los
   **rechaza** (mismo criterio que ADR-0013 D4 con `HOURS`). El PGC no impone
   método: exige uno **sistemático y racional** (NRV 2ª.2.1), y el lineal es el
   único que la práctica de este segmento documenta.
2. **(O-28)** Base amortizable = `coste + Σ mejoras capitalizadas − valor residual
   vigente`. Cuota = `trunc(base / n)`; el residuo **a la ÚLTIMA cuota**. **No se
   usa `hamilton()`**: con pesos iguales reparte por menor código —a los primeros
   meses— y el activo alcanzaría su valor residual **antes** de agotar su vida
   útil, que es una amortización acelerada no justificada. Confirmado por el
   experto como «la única opción defendible».
3. **(O-22)** Una fila del cuadro con **cuota 0 no genera asiento** —violaría C-1
   y el refuerzo de I1 de E3 §6.5—: la ocurrencia queda `OMITIDA` con motivo
   **`CUOTA_CERO`** y el importe se acumula a la siguiente fila con cuota > 0, de
   modo que el cuadro sigue sumando la base y la omisión es **visible**.
4. **Convención de mes entero** desde `inServiceDate` (puesta en condiciones de
   funcionamiento, NRV 2ª.1 y 3ª), no desde la factura. **(O-30)** Un activo en
   servicio el 31/01 y dado de baja el 01/02 amortiza dos meses: es inmaterial y
   aceptable, pero **queda escrito en la norma de valoración de la memoria**, es
   uniforme (art. 38.d CCom) y **no se cambia a mitad de vida de un activo**.
5. **Revisión prospectiva** (NRV 22ª) sobre el valor neto contable y la vida
   residual; el pasado no se toca y no hay asiento de ajuste. El **cuadro no se
   almacena**: se sella `scheduleHash` e I-E9-3 demuestra que el cuadro de hoy
   explica los asientos de ayer.
6. **(O-24) Baja y venta se automatizan** (T-33 y T-34). Dejarlas como asiento
   manual era el error que rompía I-E9-5: es donde el usuario olvida cancelar
   `281x` o se equivoca de signo. Se dota la amortización **hasta el mes de la
   baja inclusive**; el VNC va a `671`/`771`; y **la contrapartida de la venta es
   `543` —o `253` a más de un año—, nunca `430`**, porque `430` recoge créditos de
   la actividad ordinaria y meter ahí la venta de una furgoneta contamina el
   *aging*, el DSO y el PMC. **Aviso obligatorio** del art. 110 LIVA
   (regularización única de bienes de inversión vendidos dentro del periodo) y del
   art. 20.Uno.22º con la renuncia del art. 84.Uno.2º.e para edificaciones: no se
   automatiza, se dice.
7. **(O-23) La amortización del diario es la CONTABLE.** Los coeficientes del
   art. 12.1 LIS son una **sugerencia** de la UI (tabla estática, jamás LLM); la
   libertad de amortización y la acelerada (arts. 12.3 y 102 LIS) **no se
   contabilizan** y generan diferencias temporarias imponibles (`479` contra
   `6301`), que son **E10**. Si el motor las admitiera en el diario, el resultado
   contable dejaría de ser el punto de partida del art. 10.3 LIS.

---

## D3 — Periodificación *(precisada: O-22, O-25)*

**Decisión.** Cuatro cuentas: **480**, **485**, **567** (contra 662) y **568**
(contra 762). `438` y `407` **no** son periodificaciones: son anticipos con IVA
devengado (E3 §3.3).

1. Devengo lineal por **meses** (pesos iguales) o por **días**: **ACT/ACT**, días
   naturales, **ambos extremos incluidos**. No hay norma contable que imponga
   30/360 —es un convenio financiero— y el devengo se mide por el tiempo real de
   prestación.
2. Reparto entero con **residuo a la última fila** y la regla de **cuota cero** de
   D2.3: la cuenta de periodificación queda en **0 exacto**.
3. **Reversión periodo a periodo.** Un asiento único de reversión partiría el
   gasto en el ejercicio equivocado justo cuando la periodificación cruza el
   cierre, que es su caso de uso.
4. Cancelar antes de tiempo devenga el pendiente **en el periodo de la
   cancelación**, con motivo. Nunca se borra.
5. 480/485 son comerciales; **567/568 son financieras**, `analyticType =
   FINANCIERO`, nivel BAI (R-A5/R-A6 de E4). Confundirlas mueve el EBITDA.
6. **(O-25)** Los intereses se devengan por **tipo de interés efectivo** sobre el
   coste amortizado (NRV 9ª.2.2 y 9ª.3.1). Con principal **constante** y horizonte
   ≤ 12 meses, el lineal por días es admisible por inmaterialidad. Con principal
   **decreciente**, el devengo lo aporta el **cuadro del préstamo**
   (`DebtSchedule`, `basis = TIPO_EFECTIVO`); mientras tanto, `basis = DIAS` sobre
   567/568 emite **WARN** con la desviación estimada.

---

## D4 — Prorrata definitiva y modelo 303 *(**REESCRITA**: O-9, O-10, O-11, O-12, O-13)*

**Decisión.**

1. La **provisional** rige el año y es la definitiva del anterior (art. 105.Dos);
   `deducible()` de E3 **no cambia**.
2. La **definitiva** se calcula en la **última liquidación del año natural**:
   `pct = ceil(numerador × 100 / denominador)` en aritmética **entera**,
   `bps = pct × 100` (art. 104.Dos.2ª: porcentaje **entero redondeado al alza**).
   Denominador 0 ⇒ `INFO`, nunca 0 %.
3. **(O-10) Derivación del numerador y el denominador**, desde el libro de
   **emitidas** del año natural (art. 104.Dos.1ª), en importes **sin IVA**:
   numerador = operaciones **con** derecho a deducción (sujetas y no exentas,
   exportaciones y asimiladas, entregas intracomunitarias exentas del art. 25,
   exenciones plenas del art. 94.Uno); denominador = numerador **+** operaciones
   **sin** derecho a deducción (exenciones limitadas del art. 20); **excluido de
   ambos** (art. 104.Tres): entregas de bienes de inversión utilizados,
   operaciones inmobiliarias o financieras **no habituales**, autoconsumos del
   art. 9.1º.c) y d), operaciones realizadas fuera del TAI desde establecimientos
   no situados en él, y el propio IVA. **Toda exclusión es una clave de operación
   marcada en el documento, jamás deducida por el motor**; con documentos sin
   clasificar, el resultado es **`INFO` con su lista** y **nunca un porcentaje**.
4. **(O-9) Base del ajuste — corregida.**
   `ajuste = trunc(cuotaProrrateable × definitivaBps / 10000) − trunc(cuotaProrrateable × provisionalBps / 10000)`,
   sobre la **cuota soportada del año sometida a prorrata** —excluidas las 100 %
   deducibles por afectación exclusiva, las no deducibles por naturaleza
   (art. 96) y las de bienes de inversión (art. 107)—. **No es «lo ya deducido»**:
   con esa lectura, sobre 100 000 con provisional 80 % y definitiva 87 % el ajuste
   salía 5 600 en vez de **7 000**.
5. **Contrapartida `472`, y no es una elección**: la 3ª parte del PGC dice
   literalmente que la 634 *se cargará … con abono a la cuenta 472* y la 639 *se
   abonará … con cargo a la cuenta 472*. Signo: definitiva **mayor** ⇒
   `472 (D) / 639 (H)`, casilla 44 positiva; definitiva **menor** ⇒
   `634 (D) / 472 (H)`, casilla 44 negativa.
6. **(O-11) Momento y periodo.** `closeProrrataYearAction` sólo se admite **antes**
   de `settleVatAction` del último periodo, y liquidar el último periodo **exige**
   la prorrata cerrada (paso bloqueante). La línea de `472` lleva `ivaPeriod` =
   último periodo del año (art. 105.Uno). Y la **provisional de N+1 = definitiva
   de N** (art. 105.Dos), fijada por la misma acción; un porcentaje distinto
   autorizado por la Administración se **declara como dato**. Lo verifica
   **I-E9-10b**.
7. **(O-12) Guardia bloqueante de bienes de inversión.** Dejar el art. 107 para
   E10 es defendible **sólo si el producto se niega a cerrar en silencio**: una
   casilla en blanco con una nota es honesta frente al usuario, no frente a la
   AEAT. Si existe un año en la ventana con prorrata ≠ 100 %, un alta de grupo 2
   ≥ 3 005,06 € (art. 108) en ella y una desviación **> diez puntos**
   (art. 107.Uno), el paso `PRORRATA_DEFINITIVA` sale **FAIL bloqueante**, con
   motivo `REGULARIZACION_BIENES_INVERSION_PENDIENTE`, y **la liquidación del
   último periodo no se postea**. Ventana de **cuatro** años; **nueve** para
   terrenos y edificaciones (art. 107.Tres).
8. **(O-13) Mapa del 303 completo**, en tabla **versionada con vigencia** y nunca
   en un `switch`. El mapa de la ronda 0 saltaba de la casilla 46 a la 71 y **no
   permitía rellenar el modelo**. Se ofrecen: `01`–`15`, `27`, `28`–`41`, `43`
   (vacía bajo la guardia), `44`, `45`, `46`, `59`–`61`, `62`/`63` y `74`/`75`
   (RECC), `64`, `65`, `66`, `67`, `69`, `70`, `71` y `77` (diferimiento de
   importación). **No se ofrecen y la pantalla lo dice**: `16`–`26` (recargo de
   equivalencia), `42` (REAGP), `47`–`58` (simplificado) y `68`
   (art. 80.Cinco.5ª). El **390** queda fuera.
9. **Prorrata especial** (art. 103.Dos) y **sectores diferenciados** (art. 101) se
   **bloquean**, no se aproximan.

---

## D5 — Reclasificación corriente / no corriente *(**REESCRITA**: O-6, O-7, O-8)*

**Decisión.**

1. La frontera se mide **desde la fecha de cierre**: «largo» si
   `dueDate > cierre + thresholdMonths` (12 por defecto, norma 6ª de elaboración
   de las cuentas anuales). El mismo saldo viaja 523 → 173 un año y 173 → 523 al
   siguiente.
2. **(O-7, R2-1) Veintitrés pares sembrados**, no seis: a los del PGC ya
   previstos (170↔520, 171↔521, **173↔523**, 174↔524, 252↔542, 253↔543) se añaden
   las partes vinculadas en **cuatro** pares (**160↔510**, **161↔511**,
   **162↔512**, **163↔513**), **172↔522**, **175↔525**, **176↔5595**,
   **177↔500**, **180↔560**, **185↔561**, **250↔540**, **251↔541**, **254↔544**,
   **258↔548**, **260↔565** y **265↔566**. **R2-1 corrige tres errores de la
   ronda 1**: `176` va a **`5595`** «Otras partidas pendientes de aplicación» y no
   a `526`, que es **dividendo activo a pagar** y no tiene nada que ver; `177`
   (obligaciones y bonos) va a **`500`** y faltaba; y **`514` no forma par** —no
   tiene largo plazo simétrico en 16x—, igual que **`527` y `528`**, intereses a
   corto plazo de deudas ya reclasificadas, que **no se reclasifican por sí
   mismos**: hacerlo duplicaría el pasivo corriente por su importe. Sin estos
   pares no hay error visible: hay un **balance mal clasificado en silencio**.
   Siembra sólo donde ambas cuentas existan y sean postables; WARN de Auditoría en
   el resto.
3. **(O-6) El desglose de vencimientos de la deuda es obligatorio.** Un préstamo
   entra por **T-37 `ALTA_PRESTAMO`**, que emite **una línea de `170`/`520` por
   vencimiento de principal** desde su `DebtSchedule` —el patrón de la decisión 6
   de E3 §6.6 para facturas a plazos—. Para las deudas ya registradas sin
   desglose, una posición viva de `17x`/`52x` sin vencimientos deja
   `RECLASIFICACION_VENCIMIENTOS` en **FAIL bloqueante**, no en una lista
   informativa: presentar **cero** en «Deudas con entidades de crédito a corto
   plazo» teniendo préstamos vivos es la reclasificación que un auditor comprueba
   primero y la que más veces está mal en una PYME. **I-E9-25.**
4. **FIFO declarado, con los matices del experto.** No hay norma contable que diga
   qué vencimiento cancela un pago; el Código Civil (arts. 1172–1174) da la regla
   civil —elige el deudor; en su defecto, la **más onerosa**—, que sólo coincide
   con FIFO cuando todos los vencimientos son igualmente onerosos, que es el caso
   de una cartera comercial sin intereses. Condiciones: se aplica por
   **`(cuenta, contraparte, divisa)`** y jamás entre contrapartes; orden por
   `dueDate` ascendente con **desempate por `entryNumber`**; **no se compensan**
   saldos deudores y acreedores de la misma contraparte en cuentas distintas
   (art. 35.6 CCom) —un proveedor con `407` y `400` presenta **las dos**
   partidas—; y con vencimientos de **onerosidad distinta**, WARN. La imputación
   explícita (`SettlementAllocation`) es **E10**.
5. Una posición **sin `dueDate`** en cuentas comerciales no se reclasifica: se
   lista y decide una persona. Adivinar el vencimiento es inventar fondo de
   maniobra.
6. **(O-8) Orden y numeración.** T-27 y T-28 llevan **los saldos ya
   reclasificados** —el balance a 31/12 es el que se formula— y el contra-asiento
   de T-32 es el asiento **nº 2 de N+1**, después de T-28. Posteado antes, el
   `OPENING` dejaba de ser el primero e **I-E9-14** fallaba porque la apertura
   reproducía el cierre *desreclasificado*. La reclasificación es un ajuste de
   **presentación**, no un hecho económico: si se dejara «pegada», los pagos del
   año siguiente cancelarían `173` en vez de `523` y la base del FIFO quedaría
   contaminada.

---

## D6 — Diferencias de cambio al cierre *(**REESCRITA**: O-4, O-5)*

**Decisión.**

1. **`Δ = convertWithRateMicro(D, r) − S`, y nada más**, con `S` el saldo en
   moneda base y `D` el saldo en divisa, ambos con signo. Lo ya reconocido en
   668/768 **está dentro de `S`**: restarlo otra vez fue **N-1** de E7. El experto
   confirma que además de operativamente correcta es **contablemente** correcta.
2. **(O-4) Sólo partidas monetarias** (NRV 11ª.2.2). El universo es
   **`LedgerAccount.isMonetary`** `= true` (**R2-3**: el modelo Prisma es
   `LedgerAccount`, tabla física `accounts`; `Account` es el de better-auth),
   atributo del plan sembrado desde
   `seeds/npgc.csv` y editable con `AuditLog`, **no una lista en el motor**.
   `original_currency IS NOT NULL` a secas arrastraba `407` y `438` —anticipos: no
   dan derecho a recibir ni obligan a entregar un importe fijo de efectivo, sino
   un bien o un servicio— e **inventaba resultado**. Monetarias: 17x, 40x, 41x,
   43x, 44x, 46x, 52x, 53x, 54x, 55x, 57x y las fianzas de 18x/26x. No monetarias:
   20x, 21x, 3xx, `407`, `438`, `480`, `485`. **I-E9-24.**
3. El signo se resuelve solo: `Δ > 0` ⇒ `cuenta (D) / 768 (H)`; `Δ < 0` ⇒
   `668 (D) / cuenta (H)`. **Nunca 669/769**, que es residuo de tesorería.
4. La línea que mueve la partida lleva `originalAmountCents = 0`: en la moneda de
   la cuenta no se mueve nada, y E7 (ronda 2) ya decidió que un apunte así **no es
   una partida en tránsito**. **I-E9-18.**
5. **(O-5) Tasa de cierre = la de mayor `rateDate ≤ corte`** para el par, dentro de
   una **ventana declarada** (7 días naturales por defecto), con la `rateDate`
   efectiva **sellada en el asiento y visible en pantalla**; FAIL sólo si no
   existe ninguna en la ventana. El BCE publica los días hábiles TARGET, y exigir
   `rateDate = corte` dejaba el producto **sin poder cerrar los ejercicios cuyo 31
   de diciembre cae en fin de semana** (2028, 2033…), que es el único día en que
   se usa. «Tipo de cambio de cierre» significa el **vigente**, y el vigente un
   domingo es el último publicado — el mismo criterio que ADR-0014 D2 aplica a la
   tasa del documento: no se inventa, se usa la publicada y **se dice cuál**.
6. 668/768 son `FINANCIERO`, nivel BAI, CECO `CC-FIN`.

Tras T-30, **I-E7-12 pasa de WARN a PASS** y el motivo
`DIFERENCIA_DE_CAMBIO_SIN_RECONOCER` desaparece: cierra el círculo que E7 dejó
abierto a propósito.

---

## D7 — Valor actual del aplazamiento *(**REESCRITA**: O-1, O-2, O-3)*

**El defecto más caro de la ronda 0.** El descuento **no es un ajuste de cierre**:
es **valoración inicial**. La NRV 2ª.1 dice que el precio de adquisición del
inmovilizado, *si el aplazamiento supera el año*, **es el valor actual**, y la
NRV 9ª.3.1 lo replica para el débito. Reconocerlo meses después contra resultados
convierte un criterio de valoración obligatorio en un ajuste de periodo — y, si el
activo lleva diez meses amortizándose sobre el coste bruto, deja `28x` por encima
de la base amortizable y **I-E9-5 en FAIL**.

**Decisión.**

1. El descuento se reconoce **en el alta** (T-03 de E8, con el aplazamiento ya
   conocido). Para lo que no se hizo, **tres vías**:

   | Caso | Tratamiento |
   |---|---|
   | **A.** Alta del **ejercicio en curso**, cuentas no formuladas | Corrección dentro del ejercicio: reducir el coste (`523/173 (D) / 21x (H)`), **recalcular el cuadro desde `inServiceDate`** y revertir la amortización dotada en exceso (`281x (D) / 681x (H)`) |
   | **B.** Alta de un **ejercicio cerrado** | **Error** de ejercicios anteriores (NRV 22ª): contra reservas por **T-22** (`523/173 (D) / 113 (H)`) en el ejercicio abierto, con reexpresión del comparativo y desglose en la memoria |
   | **C.** Origen **no inmovilizado** | Al gasto o ingreso original si es del mismo ejercicio; a `113` si es de un ejercicio cerrado |

2. **`AssetRevision` NO sirve para esto.** Una revisión es un **cambio de
   estimación** y es prospectiva (NRV 22ª); reconocer tarde un criterio de
   valoración obligatorio es la **corrección de un error**, que es retroactiva.
3. **(O-2) El tipo de descuento se declara MENSUAL**
   (`Organization.discountRateMonthlyMicroBps`), derivado una sola vez por una
   persona del que le da su entidad y mostrado con su equivalente anual.
   `i_m = i_a / 12` sólo vale si `i_a` es un **nominal** (TIN); con el
   efectivo/TAE —que es lo que el usuario tiene a mano— el motor descontaba de
   más: sobre 10 000 000 a 24 meses al 6 %, **28 051 céntimos**, que con
   tolerancia 0 no son un redondeo. Declararlo mensual elimina la ambigüedad **y**
   la raíz duodécima, y deja el cálculo como una cadena de multiplicaciones
   enteras.
4. **Umbral de materialidad no arbitrario.** Sólo con aplazamiento > 12 meses y
   `|nominal − valor actual| ≥ pvMaterialityCents`, cuyo **valor por defecto se
   deriva** de la materialidad de las cuentas (marco conceptual, relevancia): el
   menor entre el **0,5 % del total del activo** del ejercicio anterior y un tope
   declarado; versionado en `AuditLog` y **no editable sin motivo**. Un umbral
   libre es una puerta para no descontar nada.
5. Aritmética **entera en punto fijo base 10⁹**, orden de operaciones fijo, sin
   `Math.pow`; fixture Python con `decimal` comparado byte a byte.
6. **(O-3)** El interés implícito se devenga **periodo a periodo** a **`662`** del
   lado pasivo y a **`762` Ingresos de créditos** del lado activo —un crédito por
   enajenación de inmovilizado a más de doce meses (`253`) también se descuenta y
   su interés es **ingreso**—, los dos `FINANCIERO`, nivel BAI.
7. **I-E9-19 reformulado**: `descuento inicial = Σ intereses implícitos de toda la
   vida del pasivo`, y a vencimiento el pasivo vale su **nominal**.

---

## D8 — RECC y REDEME *(**REESCRITA**: O-14, O-15, O-16)*

**Decisión.**

1. **El régimen es un dato fechado** (`VatRegimePeriod`, vigencias sin solape por
   `EXCLUDE USING gist`). Con una columna, entrar en REDEME en 2027 habría
   reagrupado los periodos de 2026 **ya presentados**.
2. **`Counterparty.ivaRegime`**: el destinatario en régimen general de un
   proveedor acogido a RECC **también difiere su deducción** (art. 163
   *terdecies*), **sin excepción**. Es la dirección que se olvida y la que la
   Inspección comprueba.
3. Mecanismo: al facturar, **4778** en vez de 477; al cobrar, `4778 → 477`. Al
   recibir, **4728**; al pagar, `4728 → 472`. **(O-15) El devengo es proporcional
   al importe cobrado**: `cuotaDevengada = trunc(cobro × cuotaTotal /
   totalFactura)` con **residuo al último cobro**, y CHECK de que `Σ devengadas =
   cuota total` al saldar o al 31/12 del año siguiente.
4. **El 31 de diciembre del año inmediato posterior es un asiento de cierre
   automático (T-36), no un aviso**: el art. 163 *terdecies* fija el devengo en el
   cobro y, **en todo caso**, en esa fecha. Se postea **antes** de la última
   liquidación de ese periodo.
5. **4728 y 4778 no son oficiales** (convención de software, como 4750/4700, que
   el seed tampoco crea). Se crean **como hijas de 472 y 477** —prefijo,
   `parentCode` derivado— y **heredan `statement` y `epigraph` del padre**, para
   que el saldo siga presentándose en *Otros créditos / Otras deudas con las
   Administraciones Públicas* sin remapear el balance. **Sin las cuentas mapeadas
   no se puede activar el régimen**, y se dice en pantalla.
6. **(O-14) Los puentes al 303 se reformulan.** El libro de emitidas anota la
   factura **en su expedición** por la cuota íntegra (arts. 63 y 61 *decies*
   RIVA), mientras que `477` sólo recoge lo cobrado: I-E8-15c e I-E9-8a **fallaban
   por diseño** en toda organización acogida y en la de su cliente, y un
   invariante que falla por hacer lo correcto es peor que no tenerlo:
   - **I-E8-15a′** — `Σ 472 + Σ 4728 = Σ` cuota deducible del libro de recibidas.
   - **I-E8-15c′** — `Σ 477 + Σ 4778 = Σ` cuota repercutida de emitidas **+**
     devengada por ISP/AIB de recibidas.
   - **I-E9-8a′** — tras T-23, `472` y `477` del periodo en **0**, pero
     **`4728`/`4778` conservan saldo y no se barren**.
7. El libro registro incorpora **fechas e importes de cobro y pago y el medio
   empleado** (arts. 61 *decies* del acogido y 61 *undecies* del destinatario no
   acogido), o **el libro no cumple**.
8. **(O-16) REDEME y el diferimiento del IVA a la importación.**
   `VatRegimePeriod.importDeferral` (opción anual, sólo con periodo MENSUAL). Sin
   diferimiento, el DUA **no genera 477** —la cuota se ingresa en la Aduana—; con
   diferimiento (art. 167.Dos LIVA, art. 74.1 RIVA), **sí** la genera, se incluye
   en el 303 como cuota devengada (**casilla 77**) y se deduce simultáneamente en
   32-33. Contabilizar el DUA sin devengo en una organización con diferimiento
   produce una autoliquidación con **menos cuota devengada de la debida**. La base
   sigue siendo la del DUA (valor en aduana + aranceles + gastos hasta el primer
   lugar de destino, art. 83.Uno), **no** la de la factura, y los aranceles son
   mayor coste (NRV 10ª.1 y 2ª.1).
9. **REDEME** en lo demás: `periodKind = MENSUAL`. El SII queda fuera del producto
   v1 y **se declara en pantalla** al activar el régimen.
10. Mientras este ADR no esté firmado, **el bloqueo de RC-24 se mantiene**: es
    preferible a contabilizar con el calendario equivocado.

---

## D9 ✚ — Orden de los asientos de cierre y pasos que faltaban *(O-17, O-26, O-29)*

**Decisión.**

1. **Orden corregido.** El de la ronda 0 reclasificaba **antes** de reconocer el
   valor actual y las diferencias de cambio: `Σ largo + Σ corto` seguía cuadrando,
   pero **el importe clasificado como corriente o no corriente era erróneo por el
   importe del ajuste**, que es justo lo que la reclasificación existe para
   evitar.

   | # | Paso | Asiento |
   |---|---|---|
   | 1 | Recurrentes al día | T-14, T-16, T-18, `IMPORTE_FIJO` |
   | 2 | Devengo RECC del 31-12 de N−1 | **T-36** |
   | 3 | Regularización de prorrata definitiva | `472/639` o `634/472` |
   | 4 | Liquidación del último periodo de IVA | **T-23** |
   | 5 | Valor actual del aplazamiento | **T-31** (antes de convertir) |
   | 6 | Diferencias de cambio | **T-30** |
   | 7 | **Reclasificación por vencimiento** | **T-32** — *última* de las de balance |
   | 8 | Impuesto sobre beneficios | **T-25** — tras **todo** movimiento de 6/7 (art. 10.3 LIS) |
   | 9 | Regularización del resultado | **T-26** — barre 6/7, **`6300` incluida** |
   | 10 | Cierre | **T-27**, con los saldos ya reclasificados |
   | 11 | Apertura | **T-28**, nº 1 de N+1 |
   | 12 | Contra-asiento de la reclasificación | T-21 de T-32, nº 2 de N+1 |

2. **(O-26) T-25 se corrige**: la cuenta es **`6300` Impuesto corriente**, no el
   padre `630`; y **debe cancelar el saldo de `473`** por retenciones soportadas y
   pagos fraccionados. Sin ello, activo y pasivo quedan **simultáneamente
   sobrevalorados por el mismo importe**, con compensación aparente en el
   resultado. El checklist **pregunta explícitamente** por diferencias
   temporarias, BIN y deducciones, con motivo de sello
   `IMPUESTO_DIFERIDO_NO_RECONOCIDO` si la respuesta es afirmativa: la NRV 13ª
   obliga a reconocer `4740`/`4745`/`479` contra `6301`, y no reconocerlos es una
   **omisión**, no un aplazamiento.
3. **(O-29) El checklist pasa de 16 a 41 pasos** en nueve bloques, con **nueve
   bloqueantes** (§4.8 del diseño). Se añaden, entre otros: sumas y saldos mes a
   mes, cuentas puente a cero, saldos contrarios a su naturaleza, arqueo de caja,
   confirmaciones bancarias, facturas pendientes de recibir, ingresos devengados
   no facturados, **existencias y obra en curso** —que para una empresa de
   proyectos **no es opcional**—, subvenciones imputadas, deterioro de créditos y
   de inmovilizado, provisiones, no compensación (art. 35.6 CCom), **periodo medio
   de pago** (art. 262 LSC, Ley 15/2010), prorrata definitiva, bienes de
   inversión, RECC devengado, pagos fraccionados conciliados, declaraciones
   informativas, legalización de libros, formulación, junta, **distribución** y
   depósito.

---

## D10 ✚ — Distribución del resultado *(O-18)*

**Decisión.** E9 llevaba el resultado a `129` y lo arrastraba por el cierre y la
apertura, y **nada lo distribuía**: el ejercicio N+1 abría con `129` poblado, el
balance mostraba indefinidamente «Resultado del ejercicio» de un año pasado, la
reserva legal nunca se dotaba y el dividendo nunca se registraba. **El patrimonio
neto es incorrecto desde el segundo ejercicio.** Es una omisión de ciclo.

1. Plantilla **T-35 `DISTRIBUCION_RESULTADO`**, disparada por
   `setAccountsApprovalAction` al marcar **`APROBADAS`**, con la **fecha de la
   junta general** (art. 164 LSC), rol ADMIN y `AuditLog`. Se postea en el
   **ejercicio abierto**.
2. Destinos: **`112`** reserva legal · **`113`** reservas voluntarias · **`120`**
   remanente · **`526`** dividendo activo a pagar · **`121`** en pérdidas
   (`121 (D) / 129 (H)`).
3. **La reserva legal la calcula el motor y no es editable a la baja**:
   `min(trunc(0,10 × beneficio), 0,20 × capital social − saldo actual de 112)`
   (art. 274 LSC). Es **obligatoria y calculada**, no propuesta.
   **(R2-2) El capital social se DERIVA del saldo acreedor de la cuenta `100`** a
   la fecha de la junta, no se teclea: un capital almacenado en `Organization`
   diverge del diario en la primera ampliación, y almacenarlo sería guardar una
   **cifra de balance** (ADR-0003). `capitalStockOverrideCents` queda **sólo como
   contingencia** —plan sin `100` postable, o capital repartido en subcuentas no
   derivables— y su uso deja el paso `DISTRIBUCION_RESULTADO` en **WARN** con
   motivo `CAPITAL_SOCIAL_DECLARADO`, enseñando las dos cifras.
4. El **dividendo** sólo con beneficio distribuible (art. 273 LSC: reservas
   indisponibles y gastos de I+D cubiertos). Al pagarlo, retención del 19 %
   (art. 101 LIRPF) contra la subcuenta del **modelo 123** (D12).
5. El **dividendo a cuenta** ya satisfecho durante el ejercicio vive en **`557`**
   —cuenta deudora que minora el PN— y **se cancela en esta misma distribución**
   contra el resultado.
6. **I-E9-23**: ningún ejercicio `APROBADAS` conserva saldo en `129` del anterior;
   `Σ destinos = resultado regularizado`; `112 ≥ min(10 % acumulado, 20 % del
   capital)`.

---

## D11 ✚ — Atribución de la amortización por activo *(O-19)*

**Decisión.** `JournalLine.fixedAssetId` (FK compuesta por tenant, `NULL` salvo en
líneas de `68x`/`28x`/`671`/`771`, con CHECK e índice).

`2811` es **una cuenta compartida por todos los activos de su clase**: nada en la
línea decía a qué activo pertenecía una dotación, así que **I-E9-5 no era
computable** y se habría evaluado por agregado, dejando pasar exactamente lo que
busca —un activo sobreamortizado compensado por otro infraamortizado—. Y el
criterio de error inyectado, que exige «nombrar el activo», era irrealizable.

Se elige frente a la alternativa de una **subcuenta de `28x` por activo**, que
funciona pero infla el plan de cuentas y complica el balance por epígrafe. La
columna es aditiva, indexable y habilita el drill-down «cuota del cuadro →
asiento» que la ficha del activo promete. En el histórico queda `NULL` e I-E9-5
sale **`INFO` nombrando los activos sin atribución**, nunca PASS por vacuidad.

Sin esta decisión, la amortización acumulada **no se puede desglosar por activo**:
el experto lo sitúa como el tercer motivo de rechazo de un auditor, porque sin ese
desglose no hay prueba de detalle posible sobre el inmovilizado, que es el área
con más horas de auditoría en este segmento.

---

## D12 ✚ — Subcuentas de retenciones por modelo *(O-27)*

**Decisión.** `4751` se parte en subcuentas por modelo, mapeadas por `AccountKey`
—`IRPF_A_PAGAR_111`, `IRPF_A_PAGAR_115`, `IRPF_A_PAGAR_123`— y **nunca por
códigos escritos**.

Hoy `4751` recibe a la vez las retenciones del **111** (rendimientos del trabajo y
de actividades económicas), las del **115** (arrendamientos de inmuebles urbanos,
art. 100 RIRPF) y, con D10, las del **123** (dividendos). Con una sola cuenta, el
puente **I-E8-17** no puede repartir el saldo entre modelos y el paso
`RETENCIONES_LIQUIDADAS` **no es verificable**. El histórico no se migra: se
crean, se mapean y el paso sale `INFO` para los periodos anteriores.

---

## Alternativas descartadas

- **Mantener la prohibición absoluta de reapertura** (E3 §9.2-4): obliga a
  corregir un cierre propio, aún no formulado, con T-22 contra reservas.
- **Reapertura por `UPDATE fiscal_years SET status = 'OPEN'`**: deja los asientos
  de cierre puestos y la 129 saldada.
- **Reabrir sin revertir T-25**: duplica el impuesto al recerrar (O-21).
- **Mantener `OPENING` = nº 1 por posición absoluta**: el cierre nuevo se bloquea
  a sí mismo tras una reapertura (O-20).
- **Almacenar el cuadro de amortización o las casillas del 303** (ADR-0003).
- **`hamilton()` para la amortización**: el activo llegaría a su valor residual
  antes de agotar su vida útil.
- **Generar un asiento de importe cero** cuando `base < n` (O-22).
- **Dejar la baja y la venta como asiento manual**: es donde se rompe I-E9-5.
- **Usar `430` como contrapartida de la venta de inmovilizado**: contamina aging,
  DSO y PMC.
- **Meter la libertad de amortización en el diario**: el resultado contable
  dejaría de ser el punto de partida del art. 10.3 LIS.
- **Un asiento único de reversión de la periodificación**: parte el devengo en el
  ejercicio equivocado.
- **Calcular el ajuste de prorrata sobre lo ya deducido**: error de 1 400 c en el
  ejemplo del experto, sobre una cifra que se declara.
- **Un numerador y un denominador tecleados**: el invariante sería tautológico.
- **Deducir por el motor las exclusiones del art. 104.Tres**: se marcan en el
  documento o el resultado es `INFO`.
- **Casilla 43 vacía con el cierre en verde**: honesto frente al usuario, no
  frente a la AEAT.
- **Un mapa del 303 que salte de la casilla 46 a la 71**: no permite rellenar el
  modelo.
- **Dejar en una lista informativa los préstamos sin desglose**: es firmar un
  balance mal clasificado.
- **Seis (o dieciocho) pares de reclasificación**: el resto de saldos se queda
  donde está, sin error visible. Y **`176↔526`**, que la ronda 1 propuso: `526` es
  dividendo activo a pagar.
- **Reclasificar `527`/`528`**: duplica el pasivo corriente por el importe de unos
  intereses cuya deuda ya se reclasificó.
- **Almacenar el capital social en `Organization`**: diverge del diario en la
  primera ampliación y es una cifra de balance guardada (ADR-0003).
- **Postear el contra-asiento de la reclasificación antes de T-28**: rompe la
  numeración y la apertura reproduce un cierre desreclasificado.
- **Reclasificar antes de los ajustes de valoración**: cuadra la suma y clasifica
  mal el importe.
- **Barrer todas las líneas con `original_currency`**: inventa resultado sobre
  anticipos, que son partidas **no monetarias**.
- **Exigir `rateDate = corte`**: deja el producto sin poder cerrar uno de cada
  siete ejercicios.
- **Reconocer el valor actual como ajuste de cierre**: convierte un criterio de
  valoración obligatorio en un ajuste de periodo y rompe I-E9-5.
- **Usar `AssetRevision` para el reconocimiento tardío del descuento**: confunde
  cambio de estimación (prospectivo) con corrección de error (retroactiva).
- **`i_m = i_a / 12` con el tipo que el usuario tenga a mano**: sólo vale para un
  TIN.
- **Un umbral de materialidad libre**: una puerta para no descontar nada.
- **Puentes al 303 sin `4728`/`4778`**: fallan por hacer lo correcto (N-1 de E7,
  por segunda vez).
- **Devengar la cuota íntegra de RECC en un cobro parcial** (O-15).
- **Contabilizar el DUA sin devengo teniendo diferimiento**: declara menos cuota
  devengada de la debida.
- **Contabilizar RECC como régimen general** «hasta tener soporte»: declarar mal,
  en silencio.
- **T-25 sin cancelar `473`**: sobrevalora activo y pasivo por el mismo importe.
- **`4751` como cuenta única**: el paso de retenciones no es verificable.
- **Dejar `129` sin distribuir**: el patrimonio neto es incorrecto desde el
  segundo ejercicio.
- **Una subcuenta de `28x` por activo** en vez de `fixedAssetId`: funciona, pero
  infla el plan y complica el balance por epígrafe.
- **Evaluar I-E9-5 por agregado**: deja pasar justo lo que busca.
- **Partir `exchange_rates` por organización** (deuda de E8, H-8): se **confirma
  ADR-0014 D7**; la deuda se cierra decidiendo que no se cambia.
- **Calcular la base imponible del IS en E9**: ajustes extracontables, BIN y
  diferencias temporarias son **E10**.
- **Usar el LLM para proponer una vida útil, un ajuste extracontable, una
  clasificación de vencimiento o una exclusión del art. 104.Tres**: P1 y
  ADR-0005, sin excepciones.

---

## Qué queda fechado para E10

Regularización de **bienes de inversión** (art. 107 LIVA, casilla 43, bajo la
guardia bloqueante de D4.7) · **ajustes extracontables, BIN, deducciones y
diferencias temporarias** del IS (NRV 13ª) · **`SettlementAllocation`** (imputación
explícita de vencimientos, D5.4) · **prorrata especial y sectores diferenciados**
(hoy bloqueados) · métodos de amortización **degresivos** (hoy rechazados) ·
`TargetKind.MIXED` y `AllocationRunStatus.DRAFT` (deuda viva de E5).

---

## Cómo se verifica que esto se ha cumplido

`docs/design/E9-cierre-recurrentes.md` §6 (**I-E9-1…26**, con **I-E9-10b** y los
cuatro nuevos), §12 (los **40** criterios de aceptación) y §13 · **T25**
(auditoría en contexto limpio: reconstruir por SQL/Python el cuadro de tres
activos, dos liquidaciones, la prorrata definitiva **con la base de O-9**, las
diferencias de cambio de dos divisas **excluyendo un anticipo**, la distribución
del resultado y el balance de apertura línea a línea, más el error inyectado).
