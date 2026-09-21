# Fiabilidad de MICRO ERP SAAS — qué garantiza y cómo comprobarlo

> **Versión final, cerrada en E12 · T23** (2026-09-21). El borrador es de E7 · T22
> y no se tiró: se completó con lo que E12 demuestra —los tests de aceptación
> C1–C7 de extremo a extremo, el auditor automatizado, «memoria borrada» y la
> reconstrucción desde copia—. La spec que prevalece sobre todo lo demás es
> `docs/spec/SPEC-FIABILIDAD.md` (v1.0, inmutable); las enmiendas propuestas a
> partir de lo aprendido en E0–E12 están en
> `docs/spec/SPEC-FIABILIDAD-v1.1-propuesta.md`, **sin aprobar**; y la traducción
> operativa —la **definición única** de los invariantes y de los motivos de
> sello— vive en `.claude/skills/fiabilidad/SKILL.md`.
>
> **Si sólo va a leer una sección, lea la §4**: es el guion cronometrado para
> comprobarlo usted mismo en diez minutos, sin conocer el código.

Un ERP contable no vale por lo que calcula, sino por lo que puede **demostrar**.
Este documento dice, sin adornos, qué afirma el sistema, con qué fuerza lo
afirma, y cómo comprobarlo uno mismo.

---

## 1. Las cinco promesas

1. **El código calcula; el modelo sólo lee y redacta.** Ninguna cifra contable
   sale de un LLM. Un documento produce una *propuesta* (`ExtractionRun`), la
   propuesta pasa por una validación determinista (`reconcile()`, RC-01…RC-25) y
   sólo entonces el motor construye el asiento. Si la propuesta no reconcilia, no
   hay asiento: no hay «aproximadamente».
2. **Partida doble en la base, no en la aplicación.** Σdebe = Σhaber con
   tolerancia 0, comprobado por un *constraint trigger* diferido al COMMIT. Un
   asiento descuadrado **no se puede persistir** aunque alguien escriba por SQL.
3. **Los informes son vistas del diario.** Balance, PyG, PyG analítica, cashflow
   y las cuatro cifras del sello se derivan del libro diario en el momento de
   emitirse. No hay cifras «de informe» almacenadas que puedan divergir del
   diario que las sostiene.
4. **Nada se borra.** Un asiento se anula con contra-asiento; un extracto
   importado, un `ExtractionRun`, un `InvariantRun` y un `AuditLog` son
   *append-only* **en la base** (`REVOKE UPDATE, DELETE` + políticas
   `RESTRICTIVE`), no por convención.
5. **Toda cifra dice cuánto se ha comprobado.** Ninguna pantalla enseña un número
   sin su nivel de confianza. Y el nivel se **deriva en lectura**: nunca se
   almacena, porque un dato que llega mañana tiene que poder retirar un sello
   concedido ayer.

---

## 2. Los invariantes, por familia

Un invariante es una igualdad que el sistema comprueba sobre **datos reales**, no
sobre un fixture. Todos comparten un contrato: **nunca un PASS que no se haya
comprobado**. Lo que no se puede evaluar con los datos disponibles sale `INFO`
diciendo qué falta — jamás en verde.

| Familia | Invariantes | Qué garantizan |
|---|---|---|
| **Partida doble y estados** | `I1`–`I3`, `I6`, `I-E7-17` | Σdebe = Σhaber por asiento **y mes a mes** (art. 28.1 CCom); `Activo = Pasivo + PN`; la PyG del periodo tiene una sola definición y coincide con el saldo de 129 si el ejercicio está regularizado; el cashflow cuadra con Δ57x |
| **Analítica y liquidación** | `I4`, `I5`, `I-E7-9`, `I-E7-10` | La matriz analítica suma exactamente la PyG contable, por nivel de margen; el reparto de CECOs es Hamilton con tolerancia 0 y desempate determinista; una `allocation_lines` alterada bajo un informe vigente **se delata** |
| **Camino documental** | `I-E8-1`…`I-E8-20` | El asiento se apoya en un run que lo sostiene; los bytes del documento son los que vio la extracción **y los de hoy**; el libro registro de IVA cuadra con el diario por los **tres puentes al 303**; la divisa se convierte con residuo cero; las series de facturación no tienen huecos |
| **Conciliación bancaria** | `I-E7-1`…`I-E7-6b`, `I-E7-11`…`I-E7-13` | `E − B = Ue − Ub` con los pendientes enumerados y tipados; el grupo N-a-M cuadra en la **moneda de la cuenta**; la cadena de extractos cubre el periodo sin huecos; los ignorados están acotados y son visibles |
| **Cierre de ejercicio** | `I-E7-14`…`I-E7-16`, `I-E9-12`…`I-E9-15`, `I-E9-20`, `I-E9-21`, `I-E9-23` | La apertura de N cuadra cuenta a cuenta con el cierre de N−1 (art. 25 CCom) y **línea a línea** con el asiento de cierre; tras la regularización, todas las cuentas de los grupos 6 y 7 —la `6300` incluida— quedan a 0 y `129` lleva exactamente el resultado; un ejercicio no se marca cerrado **sin sus asientos de cierre**; el `ClosingRun` es reproducible y hay uno solo sellado; no hay saldos contrarios a su naturaleza sin explicación; las cuentas puente (`555`, `551`, `4749`) están a cero al cierre |
| **Recurrentes, inmovilizado y periodificaciones** | `I-E9-1a`…`I-E9-7`, `I-E9-25` | Una ocurrencia por regla y periodo, y ninguna `GENERADA` sin asiento; el cuadro de amortización es determinista y su sello se recomputa, con la amortización acumulada cuadrada **por activo**; toda periodificación vencida está agotada; todo cuadro de deuda tiene desglose y no se puede alterar sin que se note |
| **IVA periódico** | `I-E9-8a′`…`I-E9-11`, `I-E9-22`, `I-E9-26`, `I-E8-15a′/15c′` | La liquidación se reproduce línea a línea desde el libro registro; el libro, el diario y la liquidación sellada cuadran **también bajo RECC** (con 4728/4778); la prorrata definitiva se deriva del libro y nunca se inventa un porcentaje; ningún asiento con IVA entra en un periodo ya liquidado |
| **Ajustes de cierre** | `I-E9-16`…`I-E9-19`, `I-E9-24` | La reclasificación largo↔corto no mueve el total y **ninguna deuda que venza dentro del año queda a largo**; las diferencias de cambio se reconocen sólo sobre partidas **monetarias** y a la tasa sellada; el valor actual devenga exactamente su descuento hasta el nominal |
| **Presupuesto y horas** | `I-E10-1`…`I-E10-18` | La matriz del presupuesto suma sus líneas nivel a nivel y mes a mes; la desviación es `real − presupuesto` al céntimo y el % **no mueve el importe**; una versión sellada no cambia —el `budgetHash` recomputado lo delata, con sus líneas de horas dentro—; un parte APROBADO es inmutable y se corrige por contra-apunte; la base de los drivers `HOURS`/`HEADCOUNT` es reproducible y el `timeHash` de **todo** run de actividad se recomputa sobre la ventana que el run persiste; y presupuesto y real sólo se comparan **en el mismo estado de imputación** |
| **Plataforma y copias** | `I-E11-1`…`I-E11-13` | El uso que se factura es el **recontado ahora**, no una cifra guardada: una caché alterada sin tocar su `sourceHash` es FAIL, no «caducada»; **ningún límite de plan puede impedir registrar un hecho contable ya ocurrido** —la cuota de asientos sólo avisa, y el tipo lo sostiene—; la copia de seguridad cubre **todas** las tablas del cliente, con el inventario derivado del esquema y las exclusiones declaradas con motivo; la restauración reproduce el original y **se demuestra**; los bytes del almacén son los que la fila promete; el reloj no fecha nada por el instante en que se ejecutó; y nuestra propia serie de facturación se audita con el mismo rigor que la del cliente |
| **Escrituras de operador** (familia `PLATAFORMA`) | `I-E12-5` | Toda escritura de `/admin` lleva motivo ≥ 20 caracteres, actor y confirmación por nombre; está entre las **cuatro** de ADR-0020 y no hay una quinta; **ninguna** alcanza el diario ni las tablas *append-only*; y ninguna excepción de operador dura más de 24 h ni existe sin su línea en el registro |
| **Integridad del propio control** | `I-E7-7`, `I-E7-8`, `I7`–`I10` | El barrido no se puede editar sin que se note (`checksHash` recomputado); todo fichero del almacén tiene veredicto; no hay duplicados, ni fechas fuera de ejercicio abierto, ni una sola fila que cruce de organización |

### Los invariantes del propio control (E12) — `I-E12-1`…`I-E12-8`

E12 no añade contabilidad: añade los invariantes que vigilan **la capa que
vigila**. Los ocho corren en integración continua, no una vez por épica.

| Id | Qué exige |
|---|---|
| **`I-E12-1`** | **Determinismo de extremo a extremo.** Purgados todos los derivados y regenerados —en los tres órdenes posibles—, las 12 cifras y los cinco sellos salen **idénticos byte a byte** |
| **`I-E12-2`** | **Reconstrucción independiente.** Un segundo motor, `scripts/audit-reconstruct.ts`, rehace las 12 cifras por SQL crudo con Δ = 0, y un test sobre el AST prueba que **no importa una sola línea** de `lib/`, `models/` ni `ai/` (`scripts/audit-reconstruct.imports.test.ts`: corre en `npm run test` y en el job 6 de CI) |
| **`I-E12-3`** | **Provenance ejecutable.** Toda celda trae una consulta parametrizada que, **ejecutada**, devuelve su propio valor. Cero celdas sin consulta y cero consultas que devuelvan 0 filas para un valor ≠ 0 |
| **`I-E12-4`** | **Cobertura de la spec.** Cada componente C1–C7 tiene al menos un test de aceptación que lo ejerce y **está en CI**. Un componente sin test es FAIL, no INFO |
| **`I-E12-5`** | **Escrituras de operador acotadas** (arriba) |
| **`I-E12-6`** | **Detección demostrada.** Las **diez** alteraciones de la matriz de inyección son cazadas, cada una, por al menos un check **nombrado**. Una que no se detecte es FAIL |
| **`I-E12-7`** | **Registro de runs completo.** `runs/registro.jsonl` valida contra su esquema, sin `run_id` duplicado, y todo entregable sellado es localizable por el suyo |
| **`I-E12-8`** | **Ningún derivado es fuente.** Ninguna cifra se sirve de una columna de caché sin recomputar su hash de origen en la misma petición |

La lista completa, con su tolerancia y su redacción exacta, está en
`.claude/skills/fiabilidad/SKILL.md`. **Se define ahí una sola vez**: el código
la implementa, no la reinventa.

### La copia de seguridad es el criterio de reproducibilidad (P7)

Que las cifras cuadren hoy no prueba que el sistema sea reproducible. Lo que lo
prueba es **poder reconstruirlo y demostrar que el resultado es el mismo**, y eso
es lo que hace la copia de seguridad desde E11:

1. El ZIP lleva **todas** las tablas del cliente —el inventario se deriva del
   esquema, no de una lista que alguien mantenga—, con los tipos **explícitos**
   (nada de adivinar que la cuenta `0400` es el número 400), las tasas de cambio
   referenciadas y los ficheros por su `sha256`.
2. El manifest se sella en forma canónica y se **firma** (HMAC con un `keyId`
   rotable). Se verifica **antes de descomprimir un byte**: firma inválida o
   formato distinto, rechazo con motivo y la organización de destino queda vacía.
3. Restaurar es **siempre a una organización nueva**. La de origen no se toca,
   nunca. Una sola fila rechazada aborta el trabajo entero, con tabla, número de
   línea y motivo.
4. Y entonces se **comprueban seis cosas**, no tres: los recuentos tabla a tabla
   con igualdad exacta; la numeración por ejercicio **sin huecos ni duplicados**
   y las series de facturación; **todos** los sellos derivados recomputados sobre
   una lista que sale del código; el recuento y la huella del registro de
   auditoría; los tres sellos de contenido y el estado del cierre; y el barrido
   completo de las nueve familias de invariantes **enfrentado al del origen**.

Esa última palabra importa: fidelidad es **destino ≡ origen**, no «destino
perfecto». Una copia fiel de una organización que ya tenía un invariante en rojo
se verifica; lo que no se verifica es una copia que cambia algo. Sólo con las
seis en verde el trabajo queda en `DONE`; si falta una, `DONE_UNVERIFIED`, la
organización se **conserva** como evidencia y `I-E11-2` lo lee como el fallo que
es. Nadie que filtre por «lista» puede leer como buena una copia sin verificar.

---

## 3. Los sellos: qué significa cada palabra

### El sello del periodo

| Sello | Cuándo |
|---|---|
| `VALIDADO AUTOMÁTICAMENTE` | Todos los invariantes en PASS, sin revisión forzada, sin avisos por encima del umbral y **sin ningún motivo de sello** |
| `REQUIERE REVISIÓN` | Cualquier FAIL, el primer barrido tras cambiar el motor, avisos por encima del umbral, revisión forzada por un ADMIN, o cualquiera de los motivos de abajo |

Un motivo de sello es un **código cerrado**, no una frase: se filtra, se cuenta y
se compara entre periodos. E8 aporta seis (documento alterado, tasa forzada,
retención no practicada…), E7 cuatro: `CONCILIACION_PENDIENTE`,
`PARTIDA_EN_TRANSITO_ANTIGUA`, `DIFERENCIA_DE_CAMBIO_SIN_RECONOCER` y
`ALMACEN_NO_BARRIDO`; y E9 cinco más, que viajan en el `ClosingRun`:
`IVA_NO_LIQUIDADO`, `IMPUESTO_DIFERIDO_NO_RECONOCIDO`, `RESULTADO_SIN_DISTRIBUIR`,
`MODELO_200_PRESENTADO` y `CIERRE_REABIERTO`; y E10 cinco de la familia
`PRESUPUESTO`, con sus umbrales `EV-11`…`EV-13` y `EV-15`…`EV-17`:
`DESVIACION_PRESUPUESTO` (la medida cambió, o uno de los cuatro KPI se disparó
—incluida **la mayor desviación por dimensión**, que el total compañía compensa—),
`PRESUPUESTO_AUSENTE`, `HORAS_SIN_APROBAR` (**también con base aprobada 0**),
`PLANTILLA_AUSENTE` y `TARIFA_AUSENTE`.

Y E12 aporta **uno**: `EXCEPCION_DE_OPERADOR_VIGENTE` (familia `PLATAFORMA`,
naturaleza `ENTORNO`). Dice que hay una excepción de operador viva sobre una
guardia de esta organización. Mientras dure, el periodo **no puede** firmarse
como `VALIDADO AUTOMÁTICAMENTE`; caduca sola en 24 h como máximo —lo impone un
CHECK en la base, no la aplicación— y entonces el sello vuelve sin que nadie
haga nada. **Una excepción de operador no es una excepción a un invariante**: el
invariante se sigue evaluando y se sigue publicando; lo que la excepción levanta
es una guardia operativa, y el precio de levantarla es este motivo.

> **Todos mueven el sello.** Un aviso que no lo mueve es decorativo: firmar
> «validado automáticamente» un periodo con la conciliación abierta es
> exactamente lo que el sello existe para impedir. Lo que estos cuatro **no**
> hacen es cambiar una cifra: por eso su naturaleza es `AVISO`/`ENTORNO` y no
> `INVARIANTE`.

> **Y alguien tiene que ejecutarlos.** Los veintisiete de E9 y los dieciocho de
> E10 nacieron como **código muerto**: el motor los sabía calcular y el montaje
> del barrido no rellenaba su bloque, así que su familia salía siempre
> `SIN_EVALUAR` y ningún FAIL llegaba nunca al sello. Lo cazó el auditor las dos
> veces. Que el bloque se componga —`readClosingInvariantInput`,
> `readBudgetInvariantInput`— es parte del invariante, y el corolario está
> escrito arriba: **una familia sin evaluar sale `SIN_EVALUAR`, jamás en verde**.

### El nivel de confianza de una cifra

| Nivel | Qué afirma |
|---|---|
| `calculado` | Se deriva del diario. Nadie ha comprobado nada más |
| `✓ comprobado automáticamente` | Los invariantes que la sostienen están en PASS |
| `✓ validado contra fuente` | Además, **cuadra contra una fuente externa**: el extracto del banco |

`✓ validado contra fuente` se concede **por composición**, y esto tiene
consecuencias que no se negocian:

- El epígrafe *Tesorería* agrega todas las 57x, **caja incluida**, y la caja no
  tiene extracto ni puede tenerlo: una organización con caja **no verá nunca**
  ese badge en la tesorería total del balance. Lo verá en el detalle por cuenta
  bancaria. Un arqueo firmado no es fuente equivalente.
- **Enumerar un pendiente no lo explica.** Un pendiente está explicado si lo
  recoge una conciliación posterior ya hecha, o si está **tipado** por una
  persona y aún no ha superado el plazo declarado de la cuenta. Cualquier otro
  retira el badge.
- Una cuenta **en divisa** con diferencia de cambio sin reconocer tampoco lo
  lleva: está validada en su divisa, pero el balance enseña su contravalor en
  euros, y ése no lo está.

### Qué sello sobrevive a una COPIA, y cuál no

Esto importa el día que hay que demostrar que una restauración es fiel, y estaba
implícito hasta que E12 lo enfrentó (nota de alcance de **ADR-0011**, 2026-09-21).
Restaurar crea filas nuevas: **todos los identificadores internos cambian**. Por
tanto:

| Sello | ¿Idéntico en la copia restaurada? | Por qué |
|---|---|---|
| `ledgerHash` | **Sí**, byte a byte | Se compone sólo de contenido contable: fecha, número de asiento, línea, cuenta, debe, haber y tipo de asiento. Ni un identificador |
| `planHash`, `accountMapHash`, `configHash` | **Sí** | Se componen de códigos de cuenta y valores de configuración |
| `analyticsKey` **del manifest de la copia** | **Sí** | Se compone sobre **claves naturales**: código de proyecto, de centro de coste y de línea de negocio. Es el que la verificación de la restauración compara |
| `analyticsKey` **del barrido** (`InvariantRun`) | **No**, y es correcto | Lleva identificadores porque su oficio es otro: decir, **dentro de una base**, si la analítica se ha movido desde el barrido anterior. Es una clave de caché, no un certificado que viaje |
| `entryHash` (por asiento) | **No**, y es correcto | Es un sello de fila: detecta cualquier cambio de **ese** asiento en **esa** base |

Dicho en una frase: **lo que la copia demuestra que es idéntico es el contenido
contable y su analítica por claves naturales.** Lo que no se compara se dice
—aquí y en el propio test—, en vez de omitirlo y dejar que parezca que todo
cuadra.

### Provenance por celda

Cada cifra de informe viaja con su origen: métrica, `run_id`, `ledgerHash`,
módulo y git-sha que la calculó, y **la consulta que la reproduce**. El
drill-down de la interfaz es ejecutar esa consulta. De una celda al documento que
la origina hay tres clics.

---

## 4. Cómo auditarlo en diez minutos

Cronometrado, sin conocimiento previo del código y sobre un entorno cualquiera
—el preview, una copia restaurada, su propia instalación—. Si alguno de los
siete pasos tarda más de lo que dice o le obliga a preguntarle a alguien, **el
paso está mal diseñado**: es un defecto nuestro, no una carencia suya.

| min | Paso | Qué tiene que ver |
|---|---|---|
| **0–1** | `/audit` → **Ejecutar barrido** | El sello con sus motivos, los **cinco hashes** y las **cuatro cifras firmadas**: activo, PN + pasivo, resultado y tesorería |
| **1–3** | Abra una familia → un check → sus registros de origen → el asiento → el documento | **Tres clics** hasta el asiento y uno más hasta el PDF. Si un asiento no nace de un documento, lo dice; no se queda en blanco |
| **3–4** | **Prueba de detección**, desde la propia pantalla | Se altera un céntimo **en una copia en memoria**, se ve qué invariantes lo cazan, y el `ledgerHash` **no se ha movido**: el diario no se ha tocado. La ejecución queda registrada |
| **4–6** | `npx tsx scripts/audit-reconstruct.ts --org <id> --ref-date <AAAA-MM-DD>` | Doce filas, **Δ = 0** en las doce y veredicto `CONFORME`. Lo calcula un **segundo motor** que no comparte una línea de código con el primero |
| **6–8** | Compare los dos últimos barridos | El diff dice `DATOS`, `MOTOR` o `CONFIGURACION`, según qué hash se movió. Nunca «no se sabe» |
| **8–9** | Abra cualquier celda de un informe → «cómo se calcula» | La consulta parametrizada, sus parámetros, el git-sha y el `run_id`. Ejecútela: devuelve su propia cifra |
| **9–10** | `runs/registro.jsonl`, busque ese `run_id` | Quién, cuándo, con qué versión, con qué tests y con qué sello |

### El paso 4, en detalle: el auditor automatizado

```bash
npx tsx scripts/audit-reconstruct.ts --org <uuid> --ref-date 2026-12-31 --out audit.json
echo $?   # 0 sólo si el veredicto es CONFORME
```

Es la prueba más fuerte que hay en el sistema, y lo es por cómo está hecho:

- **No importa una sola línea del producto.** Ni `lib/`, ni `models/`, ni `ai/`,
  ni `app/`. Habla con la base por SQL crudo y hace la aritmética con enteros
  grandes. Un total que sale de la misma función que lo produjo no prueba nada;
  un hash que se compara consigo mismo, tampoco. Lo impone un test sobre el
  árbol sintáctico, no una promesa en un comentario.
- **Sus reglas salen de documentos normativos**, no del motor: la forma canónica
  de los sellos de ADR-0011, las definiciones de I1–I6 de la skill, y las reglas
  de balance y analítica de `docs/MODELO-DATOS.md`.
- **`NO_VERIFICABLE` no es un aprobado.** Si no hay nada sellado contra lo que
  contrastar, el veredicto no es CONFORME: es `NO_VERIFICABLE`, y en integración
  continua **falla igual que una discrepancia**.
- **Dice lo que NO puede detectar.** La cabecera del propio script enumera diez
  cosas, empezando por la más incómoda: un diario coherente pero **falso** —una
  factura que nunca se contabilizó— cuadra por los dos caminos. Eso lo cazan la
  conciliación bancaria y el camino documental, no la aritmética.

### Y en cada `push`, sin que nadie lo pida

Los diez minutos de arriba los repite una máquina en cada integración
(`.github/workflows/fiabilidad.yml`, nueve trabajos): unitarios, integración,
RLS con el rol sin privilegios, **los siete tests de aceptación C1–C7** más
«memoria borrada» y «reconstrucción desde copia», el **auditor automatizado**
sobre el fixture con sus informes emitidos antes, los **fixtures sellados** que
se regeneran byte a byte, los **e2e uno por fichero** y el build. Cada PR recibe
una tabla con el sello, los cinco hashes, las doce cifras con su Δ y el recuento
por familia. Que se lea sin abrir un artefacto es la diferencia entre un control
y un adorno.

---

## 5. Qué NO garantiza el sistema

Decirlo importa tanto como lo anterior:

- **No sustituye a un auditor ni a un asesor fiscal.** Comprueba coherencia
  interna y cuadre contra fuente; no opina sobre la calificación de un hecho
  económico.
- **No adivina lo que no está.** Sin extracto no hay conciliación; sin tasa
  publicada no hay conversión (no se aproxima: se aborta); sin anclaje de una
  cuenta bancaria el cuadre sale `INFO`, no PASS.
- **No puntea solo.** Las sugerencias de conciliación son deterministas, se
  recomputan en cada carga y **una persona las acepta**. No hay `AUTO`.
- **No decide la deducibilidad del IVA**: la deja pendiente y lo dice con su
  motivo de sello (art. 96 LIVA).
- **No regulariza los bienes de inversión** (arts. 107-110 LIVA): el cierre no
  avanza en silencio —la guardia es determinista y lo avisa—, pero el ajuste es
  de una épica posterior.
- **No admite el arqueo de caja como fuente externa**, y esto se decidió en E12
  en vez de aplazarlo otra vez. Un arqueo lo firma la misma parte que lleva la
  caja: admitirlo degradaría la etiqueta más fuerte del sistema para ganar un
  badge en un epígrafe. La consecuencia se queda escrita: **una organización con
  caja no verá nunca `✓ validado contra fuente` en la tesorería total**; lo verá
  en el detalle de cada cuenta bancaria.
- **No es un back-office de plataforma.** `/admin` tiene **cuatro** escrituras de
  operador y ni una más (ADR-0020), cada una con motivo, confirmación por nombre
  y su línea en el registro. Todo lo demás sigue siendo SQL de runbook, a
  propósito.
- **No exporta los modelos 303/349** ni cubre el ciclo comercial (factura emitida
  con PDF, envío, cobro, *aging*): están fechados en E14.
- **No regulariza los bienes de inversión** (arts. 107-110 LIVA). La guardia es
  determinista y lo avisa con su motivo de sello; el ajuste es de una épica
  posterior.
- **No cierra un ejercicio por su cuenta.** El cierre es un **checklist de 43
  pasos** con nueve bloqueantes: sin PASS en los nueve no se cierra, y los pasos
  declarados sin responder son WARN, nunca PASS. Reabrir exige motivo, el código
  del ejercicio y deja el `ClosingRun` en `REQUIERE REVISIÓN` para siempre.

---

## 6. Cómo se extiende sin romper la capa

Siete reglas. No son estilo: cada una tiene detrás una épica que la pagó.

1. **Un invariante nace con su llamante y con su test de inyección.** Escribir la
   función no es entregar el invariante: hay que componer su bloque de entrada,
   enchufarlo al barrido, darle familia y **demostrar con una alteración real
   que da FAIL**. Tres épicas seguidas (E9, E10, E11) entregaron 27, 18 y 13
   invariantes que el motor sabía calcular y **nadie llamaba**. Los tres los
   encontró el auditor, no los tests.
2. **Una familia sin evaluar sale `SIN_EVALUAR`, jamás en verde.** Nunca un PASS
   que no se haya comprobado. Un check que pasa por vacuidad es peor que no
   tenerlo: afirma algo que nadie ha mirado.
3. **Una tabla nueva de negocio** se protege con `app.enforce_tenant_rls`, entra
   en `TENANT_MODELS` y con eso entra sola en la copia de seguridad, en el
   vaciado de organización y en la purga de derivados. **Nunca se mantiene una
   lista a mano**: la lista a mano ha fallado cuatro veces, y la última costó
   perder 177 filas por organización en cada restauración **con las seis
   comprobaciones en PASS**.
4. **Un derivado nuevo declara su hash de fuente** y su entrada en las columnas
   selladas. Si no se puede recomputar, no es un derivado: es una fuente, y
   entonces necesita su propia decisión escrita.
5. **Una cifra nueva en pantalla trae su provenance**, con consulta **ejecutable**
   y etiqueta de confianza. No basta con que la consulta viaje: en E12 se
   encontró una que, ejecutada, daba error de parámetros. Una consulta que no se
   puede ejecutar no es trazabilidad, es una cita.
6. **Un cambio en el motor exige ciclo en paralelo** viejo/nuevo sobre el mismo
   snapshot, con diff cero o diff explicado, y es un cambio de Nivel 2: ADR y
   aprobación humana antes de integrar.
7. **Un test que se escribe mirando el código que prueba no prueba nada.** Las
   cifras esperadas se congelan en un fixture reproducible (`--check` byte a
   byte) o se reconstruyen por otro camino. Y un test que **tapa** un hallazgo
   —el que pasa por vacuidad, el que se ajusta al código, el que tiene un fixture
   que contradice al motor— es un defecto de severidad ALTA, no una molestia.

### Cómo comprobarlo uno mismo, desde la línea de órdenes

Sin pasar por la aplicación:

```bash
DATABASE_URL_MAINTENANCE=… npx tsx scripts/run-invariants.ts --org <id>   # → validacion.json
npm run test              # motor puro: invariantes y fixtures congelados
npm run test:integration  # contra Postgres de verdad, con RLS activa
npm run test:integration:rls
npm run test:acceptance   # los siete C1–C7, «memoria borrada» y la copia restaurada
npx tsx scripts/audit-reconstruct.ts --org <id> --ref-date <AAAA-MM-DD>   # el paso 4 de la §4
python3 docs/design/fixtures/build_ejercicio_completo_v2.py --check       # byte a byte
```

**Reconstruyendo por fuera.** Es lo que hace el agente `auditor-fiabilidad` en
contexto limpio —y, desde E12, también una máquina en cada integración—:
recalcular las cifras con SQL crudo y aritmética independiente, **sin usar el
motor**, y comparar. Los fixtures (`tests/fixtures/ejercicio-completo.json`)
traen sus cifras esperadas y el `ledgerHash` congelado; si el motor cambiara una
coma, el hash lo diría. Y el generador del fixture se vuelve a ejecutar con
`--check`: un fixture que ya no se puede regenerar deja de ser un contrato.

---

## 7. Segregación de funciones y registro de runs

Quien implementa ≠ quien revisa ≠ quien audita. El `auditor-fiabilidad` se lanza
**en contexto limpio**, reconstruye por camino independiente y emite CONFORME o
DISCREPANCIA. No es ceremonia: en E7 encontró siete hallazgos —tres de severidad
ALTA— que las pruebas propias del código no vieron, entre ellos dos tests que
*pasaban* con datos que el sistema no puede producir. Un test que se escribe a la
medida del código que prueba no prueba nada, y ésa es la razón de ser de la
tercera firma.

**Y desde E12 la tercera firma también es automática.** La auditoría adversarial
dejó de correr una vez por épica: `scripts/audit-reconstruct.ts` corre en cada
integración con la **misma prohibición** de compartir código con el productor, y
un test sobre el árbol sintáctico la impone. Las dos capas se necesitan: la
humana encuentra lo que nadie pensó en comprobar; la automática impide que lo
encontrado vuelva. Cuatro informes de auditoría (E7, E9, E10, E11) encontraron
cada uno lo que los tests no veían, y las tres primeras veces el mismo fallo:
invariantes escritos y jamás llamados.

Todo run —implementación, revisión, auditoría— queda en `runs/registro.jsonl` con
su git-sha, sus tests, su deuda y su sello, y `I-E12-7` comprueba que el registro
valida contra su esquema, que no hay `run_id` duplicados y que **todo entregable
sellado es localizable por el suyo**. Un registro que nadie valida es un diario
de a bordo escrito a lápiz.
