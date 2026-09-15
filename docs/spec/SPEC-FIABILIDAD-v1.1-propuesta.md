# SPEC-FIABILIDAD v1.1 — **propuesta de enmiendas** a la v1.0

> **Qué es esto y qué no es.** Es una **propuesta** de diez enmiendas a
> `docs/spec/SPEC-FIABILIDAD.md`, dirigida a Pablo. **La v1.0 no se toca**: es
> inmutable por su propia cabecera y un job de CI comprueba que su `git diff`
> está vacío. Nada de lo que sigue está aprobado, y el cierre de E12 no depende
> de que se apruebe.
>
> **Y no es una lista de errores de la spec.** Es lo contrario: son las diez
> cosas que la v1.0, aplicada durante doce épicas a un ERP contable real,
> **provocó que aprendiéramos**. Nueve de las diez ya están implementadas de
> facto en el producto; lo que falta es que estén escritas donde mandan.

| | |
|---|---|
| Origen | Épicas E0–E11 de MICRO ERP SAAS, 2026-09-04 → 2026-09-15 |
| Base | `docs/spec/SPEC-FIABILIDAD.md` v1.0 (Pablo, CFOnomic) |
| Entregado en | E12 · T23 (`docs/design/E12-fiabilidad-dod.md` §7.4) |
| Estado | **PROPUESTA** — sin firma |

---

## Cómo leer la tabla

Cada enmienda trae: **qué dice**, **dónde va** en la v1.0, **la cicatriz** que la
produjo (con la épica y el hallazgo concreto), **el coste** de adoptarla y **el
beneficio**. El coste está casi siempre en «ya está hecho, sólo hay que
escribirlo», porque el producto aprendió estas diez a golpes.

---

## E-1 · Un invariante nace con su llamante y su test de inyección

**Qué dice.** Añadir a §C4, Capa 1:

> Un invariante **no cuenta como implementado** hasta que (a) su bloque de
> entrada se compone y se pasa al barrido, (b) tiene familia asignada, y (c)
> existe un test que **inyecta el error que ese invariante vigila** y comprueba
> que devuelve FAIL. Un invariante que nadie ejecuta es código muerto que además
> da falsa seguridad, que es peor que no tenerlo.

**La cicatriz.** Tres épicas seguidas entregaron invariantes muertos, y las tres
veces lo encontró el auditor, no el productor ni el revisor:

| Épica | Hallazgo |
|---|---|
| **E9** | H-1: los **27** `I-E9-*` no corrían nunca. El motor los sabía calcular; `readClosingInvariantInput` no rellenaba su bloque, la familia salía `SIN_EVALUAR` y ningún FAIL llegaba al sello |
| **E10** | H-1: los **18** `I-E10-*`, exactamente igual |
| **E11** | H-1: los **13** `I-E11-*` no existían siquiera; la familia `PLATAFORMA` no estaba en `CheckFamily`, y el barrido devolvía **43 checks y ninguno** |

Cincuenta y ocho invariantes escritos, cero ejecutados, tres veces el mismo
fallo. Y el propio diseño de E11 lo citaba de memoria antes de repetirlo.

**Coste.** Nulo en el producto (E12 lo convierte en `I-E12-4` y en la regla 1 de
«cómo se extiende sin romper la capa»). En la spec: un párrafo.
**Beneficio.** Elimina la clase de defecto más cara que ha tenido este proyecto.

---

## E-2 · Nunca un PASS que no se haya comprobado — elevar a principio **P8**

**Qué dice.** Añadir a §1, como octavo principio no negociable:

> **P8 — Lo no evaluable sale marcado, jamás en verde.** Si un check no puede
> evaluarse con los datos disponibles, su resultado es `SIN_EVALUAR` / `INFO`
> **diciendo qué falta**, nunca PASS y nunca silencio. Una familia entera sin
> componer sale `SIN_EVALUAR`.

**La cicatriz.** Es la regla que ha salvado E7, E9, E10 y E11, y **no está en la
v1.0**. La v1.0 define PASS/FAIL (§C4) y deja el tercer estado sin nombre; el
resultado natural de eso es que lo no comprobado se cuenta como bueno. En el ERP
la regla se escribió a mano en `fiabilidad/SKILL.md` y hay que repetirla en cada
bloque de invariantes nuevo.

**Coste.** Cero: ya gobierna el producto entero. **Beneficio.** Cualquier
implementación futura de la spec la hereda sin que nadie tenga que descubrirla.

---

## E-3 · Un test que tapa un hallazgo es un defecto de severidad ALTA

**Qué dice.** Añadir a §5 (anti-patrones) tres entradas:

- Un test escrito **a la medida del código que prueba** (las cifras esperadas se
  obtienen ejecutando el propio motor).
- Un test que **pasa por vacuidad** (el conjunto que examina está vacío y nadie
  lo comprueba).
- Un test cuyo **fixture contradice al motor**, y que se «arregla» tocando el
  motor para que el fixture pase.

Y una consecuencia: un test así **no es deuda menor, es severidad ALTA**, porque
produce exactamente el efecto que la spec quiere evitar —un error no detectado
que además viene con un sello verde.

**La cicatriz.**

| Épica | Hallazgo |
|---|---|
| **E7** | Dos tests **pasaban con datos que el sistema no puede producir** |
| **E9** | R-2: los 22 pares de reclasificación sólo existían por el backfill, e **I-E9-16 pasaba por vacuidad** |
| **E10** | El bloque de absorción del fixture **contradecía al motor**; la provenance por celda devolvía **0 filas** en los niveles acumulados y los tests no lo veían |
| **E11** | Las **seis comprobaciones** de la restauración daban PASS y `verified = true` mientras `currencies` —177 filas por organización— se perdía entera |

**Coste.** En la spec, un párrafo. En la práctica, obliga a congelar cifras
esperadas en fixtures o reconstruirlas por otro camino, que es lo que el ERP ya
hace.
**Beneficio.** Nombra la patología. Hoy un revisor no tiene dónde apoyarse para
bloquear un test que pasa.

---

## E-4 · Todo inventario es derivado

**Qué dice.** Añadir a §C1 y §C7:

> Ninguna lista de tablas, entidades, sellos, familias de checks o rutas que el
> sistema deba recorrer se mantiene **a mano**. Se **deriva** del esquema o del
> código, y existe un invariante que comprueba la derivación. Una lista escrita a
> mano se desactualiza en la primera épica siguiente y falla **en silencio**.

**La cicatriz.** Cuatro veces el mismo bug, y cada vez se declaró cerrado:

| Bug | Qué pasó |
|---|---|
| **BUG-E7-1** | `--reset-org` no limpiaba las tablas de E7 y rompía la suite e2e |
| **BUG-E9-5** | ídem con las de E9 |
| **BUG-E10-1** | ídem con presupuesto y horas |
| **BUG-E11-2** | ídem con las de E11 — y esta vez se cerró **derivando** la lista de `TENANT_MODELS` |
| **H-2 de E11** | El inventario del backup se derivaba de `TENANT_MODELS`, pero `currencies` **no estaba en `TENANT_MODELS`**: 177 filas por organización perdidas en cada restauración, con las seis comprobaciones en verde |

El último es el más instructivo: derivar de una lista **que también se mantiene a
mano** no es derivar. La derivación tiene que llegar hasta el esquema.

**Coste.** Medio: obliga a que cada tabla nueva de negocio pase por
`app.enforce_tenant_rls` + `TENANT_MODELS`, y a un invariante que compare
`TENANT_MODELS` contra las tablas con `organization_id` **en la base**.
**Beneficio.** Cierra una clase entera de fallo silencioso.

---

## E-5 · La forma canónica no admite campos mutables

**Qué dice.** Añadir a §C1:

> Un hash de contenido se computa sobre **claves naturales y valores
> inmutables**: nunca sobre ids de fila, timestamps, contadores, ni secretos. Un
> hash que cambia sin que cambie el hecho que describe no es un sello: es ruido
> que castiga hacer lo correcto.

**La cicatriz.**

- **E10, H-2 del auditor**: el `budgetHash` era **irreproducible en cuanto se
  relevaba una versión** de presupuesto, porque la forma canónica incluía algo
  que la relevación movía.
- **E11, ronda de integración**: `invitations.token_hash` es `UNIQUE` global y un
  **secreto**; al restaurar hay que **reemitirlo**, no copiarlo (copiarlo daría
  acceso a dos organizaciones con el mismo enlace). Estaba dentro de
  `derivedSealColumns()`, y compararlo **castigaba** hacer lo correcto. Salió.

**Coste.** Bajo: es una regla de diseño de hashes. **Beneficio.** Evita sellos
que dan FAIL por motivos que no son un cambio del hecho sellado — que es la
manera más rápida de que la gente deje de mirar los sellos.

---

## E-6 · Una caché alterada es FAIL, no «caducada»

**Qué dice.** Añadir a §C1:

> Toda caché de resultados lleva el **hash de sus fuentes**. Si al leerla el hash
> recomputado no coincide, eso **no** es una caché caducada que se recalcula en
> silencio: es un **fallo de integridad**, y se reporta como tal antes de
> recalcular nada.

**La cicatriz.** `I-E11-1`: el uso que se factura es el **recontado ahora**, y un
`UsageRun` alterado por SQL con su `sourceHash` intacto es **FAIL nombrando la
métrica y las dos cifras** — no una invalidación. La diferencia importa: «se
recalcula solo» esconde a quien tocó la fila.

**Coste.** Bajo. Es una línea en cada lector de caché. **Beneficio.** Distingue
«el dato cambió» de «alguien cambió el derivado», que son dos sucesos
completamente distintos y hoy la spec los confunde.

---

## E-7 · Ningún control puede impedir registrar un hecho ya ocurrido

**Qué dice.** Añadir a §1, como corolario de P2:

> Los límites, cuotas, bloqueos y estados del sistema acotan **recursos**, nunca
> la fuente de verdad. Un hecho económico que ya ha ocurrido **se registra**,
> aunque la cuota esté agotada, aunque haya mora, aunque el plan haya caducado.
> Lo que puede hacer el control es **avisar** y dejar constancia.

**La cicatriz.** **O-3** de la validación contable de E11, uno de los cinco
bloqueantes: un límite de plan impedía registrar un hecho contable ya ocurrido.
La corrección fue ADR-0019 **D7**: cuotas **duras** de recurso frente a cuota
**blanda** sobre el registro contable, con excepción automática y registrada.
Hay un test estático sobre el AST que comprueba que **ninguna acción de posteo
invoca al guardián de cuotas** (I-E11-4c).

**Coste.** Conceptualmente cero; de implementación, ya hecho.
**Beneficio.** Es una regla de contabilidad antes que de software (art. 28 CCom:
los hechos se anotan por orden de fechas), y una spec de fiabilidad que no la
diga invita a violarla.

---

## E-8 · El auditor adversarial tiene que ser **ejecutable**, no sólo humano

**Qué dice.** Reescribir §C4, Capa 2:

> La Capa 2 tiene **dos** formas y hacen falta las dos:
>
> - **Auditor en contexto limpio** (agente o persona): recibe sólo el snapshot,
>   el entregable y el provenance; su encargo es demostrar que los números están
>   mal. Veredicto `CONFORME` / `DISCREPANCIA` / `NO_VERIFICABLE`.
> - **Reconstrucción automatizada**, que corre **en cada integración**:
>   un segundo motor que recalcula un conjunto declarado de cifras canónicas por
>   un camino independiente y exige Δ = 0. **Con la misma prohibición**: no
>   comparte ni una línea de código con el productor, y eso se comprueba
>   estáticamente, no se promete en un comentario.

**La cicatriz.** El auditor en contexto limpio ha encontrado, en cuatro épicas,
lo que ni los tests ni el revisor veían: E7 (siete hallazgos, tres ALTA,
incluidos dos tests que pasaban con datos imposibles), E9 (H-1…H-6, tres
bloqueantes), E10 (H-1…H-7, dos graves), E11 (tres bloqueantes). **Funciona.**
Pero corre **una vez por épica**: entre medias, un `push` puede romper una cifra
y nadie se entera hasta la siguiente auditoría, semanas después.

**Coste.** Alto y explícito: en E12 son **40 h** (`scripts/audit-reconstruct.ts`)
más el coste permanente de mantener dos implementaciones de las mismas doce
cifras. Es deliberado — una segunda implementación que se mantiene sola sería la
misma implementación.
**Beneficio.** Es el único control que ha demostrado encontrar lo que los demás
no ven, y pasa de anual a continuo.

---

## E-9 · `NO_VERIFICABLE` no es un aprobado

**Qué dice.** Añadir a §C4, Capa 2:

> En integración continua, un veredicto `NO_VERIFICABLE` **falla igual que
> `DISCREPANCIA`**. «No he podido comprobarlo» y «está mal» se tratan distinto
> por una persona, pero nunca por una puerta automática.

**La cicatriz.** Es el corolario operativo de P8 (E-2) aplicado a la Capa 2. La
v1.0 define los tres veredictos (§C4) y §C4 Capa 3 escala al humano si hay
`DISCREPANCIA` **o** `NO_VERIFICABLE` — correcto —, pero no dice qué hace una
tubería automática, y lo natural es dejar pasar lo que no es un fallo explícito.

**Coste.** Una línea en el workflow. **Beneficio.** Impide que la Capa 2 se
degrade a decorativa el día que algo deje de ser reconstruible.

---

## E-10 · Un identificador de gap es inmutable

**Qué dice.** Añadir a §2.3 (informe de gaps):

> Los identificadores `G-nn` del informe de Fase 1 significan **exactamente** lo
> que ese informe dice, para siempre. Ningún documento posterior puede reusarlos
> para otra cosa, renumerarlos ni «aprovechar» un hueco. Si un documento
> posterior necesita un identificador, usa un espacio de nombres propio.

**La cicatriz.** Tres erratas de doble numeración en doce épicas, y cada una costó
tiempo de una épica en descubrirse:

| Id | Qué dice la auditoría | Qué acabó diciendo el seguimiento |
|---|---|---|
| **G-14** | *Roles no separados: un solo prompt extrae y redacta; el único auditor es el humano* | `ESTADO.md` lo rotula «G-14 · conciliación bancaria» y lo fecha en E12. La conciliación la entregó **E7** entera |
| **G-15** | *Backups omiten campos y el restore silencia errores* | `ESTADO.md` lo usaba además para «facturación emitida completa», que no tiene gap asignado y acabó siendo la épica **E14** |
| **G-20** | *Sin tests de `models/stats.ts`, `lib/stats.ts`, `ai/*`* | Se usó también para «restaurar un ZIP ajeno desde la interfaz». E12 lo renombra a `G-15b` **en el documento que lo inventó**, no en la auditoría |

**Coste.** Cero. **Beneficio.** Evita el cuarto.

---

## Resumen de coste / beneficio

| Enmienda | Coste de adoptar | ¿Ya implementado en el ERP? | Beneficio |
|---|---|---|---|
| **E-1** invariante con llamante y test | Un párrafo | Sí (E12: `I-E12-4`) | Elimina la clase de defecto más cara del proyecto |
| **E-2** P8 «nunca un PASS sin comprobar» | Un párrafo | Sí, de facto | Se hereda en vez de redescubrirse |
| **E-3** tests que tapan hallazgos | Un párrafo | Parcial | Da base para bloquear un test que pasa |
| **E-4** inventarios derivados | Medio (un invariante más) | Sí, tras cuatro intentos | Cierra una clase de fallo silencioso |
| **E-5** forma canónica sin mutables | Bajo | Sí | Sellos que sólo fallan cuando el hecho cambia |
| **E-6** caché alterada = FAIL | Bajo | Sí (`I-E11-1`) | Separa «el dato cambió» de «alguien lo tocó» |
| **E-7** ningún control frena un hecho ocurrido | Cero | Sí (ADR-0019 D7) | Regla contable antes que técnica |
| **E-8** auditor automatizado | **Alto: 40 h + mantenimiento doble** | **No — es el núcleo de E12** | El control más eficaz pasa de anual a continuo |
| **E-9** `NO_VERIFICABLE` falla | Una línea | No | Impide que la Capa 2 se degrade |
| **E-10** ids de gap inmutables | Cero | No | Evita la cuarta errata |

**Nueve de las diez cuestan un párrafo y ya están vivas.** La única que cuesta de
verdad es **E-8**, y es la que responde a la pregunta que la v1.0 plantea en su
§0: *que dos ejecuciones que se contradigan sean explicables por diff de datos,
nunca un misterio*. Para que eso sea cierto entre épicas y no sólo dentro de
ellas, alguien tiene que estar recalculando las cifras por otro camino **todos
los días**, y ese alguien no puede ser una persona.

---

## Lo que esta propuesta **no** pide cambiar

- Los **siete principios** P1–P7: se mantienen tal cual. E-2 añade un octavo, no
  retoca ninguno.
- El **protocolo de nueve pasos** de §4: ha resistido doce épicas sin una grieta.
- La **gobernanza de dos niveles** de §7: es la que ha hecho que los cambios de
  motor lleven ADR firmado, y ha funcionado.
- La **definición de las cinco etiquetas de confianza** (§C5): el ERP las ha
  ampliado a cuatro niveles por campo en el camino documental sin necesidad de
  tocar la spec, que es señal de que la spec estaba bien planteada.
