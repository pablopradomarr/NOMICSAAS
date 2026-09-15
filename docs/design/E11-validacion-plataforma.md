# E11 — Validación contable de la plataforma SaaS (`experto-contable`)

**Documentos validados:** `docs/design/E11-plataforma-saas.md` ·
`docs/adr/0019-plataforma-saas.md` (PROPUESTO, D1–D6) ·
**Fecha:** 2026-09-15 · **Épica:** E11 ·
**Marco:** PGC 2007 (RD 1514/2007), CCom, LIVA (L 37/1992), RIVA (RD 1624/1992),
Reglamento de Facturación (RD 1619/2012), LGT, LIS ·
**Skills aplicadas:** `fiabilidad` (P1–P7, I1–I10, I-E5/E7/E8/E9/E10-*), `pgc-npgc`.

> **Este documento no modifica el diseño ni el ADR.** Responde C-1 … C-7 y emite
> observaciones numeradas con corrección concreta. Las correcciones las incorpora
> quien firme el ADR, no este documento.

---

## Veredicto

> ## **OBSERVACIONES**
>
> El **fondo contable del ADR-0019 es correcto y en dos puntos es ejemplar**:
> **I-E11-8** (la plataforma no toca el diario del cliente), **D6** (el impago
> nunca retira la lectura ni la exportación), el **uso derivado y nunca
> almacenado** (D1.5) y la **retirada de `aiBalance`** como saldo que se
> decrementa. Los cuatro son aplicación literal de P2, P4 y del deber de custodia
> de documentación mercantil ajena, y deben conservarse **con su redacción
> actual**.
>
> No es CONFORME todavía por **cinco defectos bloqueantes**: (1) un límite de plan
> impide hoy registrar un hecho contable ya ocurrido (O-3); (2) el plan FREE en
> mora no puede ejercer la portabilidad que D6 le promete (O-4); (3) los tres
> hashes no bastan como criterio P7 de restauración (O-1); (4) `PlatformInvoice`
> no puede demostrar una serie de facturación correlativa ni conserva la copia
> (O-9, O-10); (5) la siembra del asistente deja organizaciones que incumplen
> I-E11-10 por construcción (O-7).
>
> **D2, D5 y los invariantes I-E11-1 / -3 / -5 / -7 / -9 / -11 / -12 son
> CONFORMES** en lo que a esta validación compete. **D1, D6 y I-E11-2, I-E11-4,
> I-E11-8 e I-E11-10 requieren las correcciones marcadas BLOQUEANTE** antes de la
> firma. Ninguna observación exige tocar el motor contable (`lib/ledger`,
> `lib/analytics`, `lib/closing`): **confirmado que §18 no cambia el motor**.

---

## 1. Respuestas a C-1 … C-7 (facturación de la PLATAFORMA)

Ámbito: la factura que **CFOnomic emite al cliente**. Nada de lo que sigue entra
en el diario del cliente (I-E11-8). Todo lo marcado *parametrizable* depende de
circunstancias y no se decide aquí.

### C-1 · IVA de la suscripción SaaS B2B

Servicio prestado por vía electrónica. Regla de localización **B2B:
art. 69.Uno.1º LIVA** — se localiza donde está establecido el destinatario
empresario o profesional.

| Destinatario | Localización | Tratamiento en la factura | Norma |
|---|---|---|---|
| Empresario establecido en **TAI** (península + Baleares) | TAI | **Sujeto, no exento, 21 %** | arts. 69.Uno.1º, 90.Uno |
| Empresario en **Canarias, Ceuta o Melilla** | Fuera del TAI | **No sujeto a IVA**. Canarias: IGIC, con ISP en el destinatario por no estar establecidos allí. Mención obligatoria | art. 3.Dos LIVA; L 20/1991 |
| Empresario **UE con NIF-IVA válido en VIES** | Estado del destinatario | **No sujeto en TAI** · factura **sin IVA** · mención obligatoria «inversión del sujeto pasivo / *reverse charge*» | arts. 69.Uno.1º LIVA; 6.1.m RD 1619/2012 |
| **UE sin NIF-IVA válido** | No cabe presumir empresario | Se trata como **consumidor final** → **OSS** con el tipo del Estado de consumo | arts. 70.Uno.4º, 163 *unvicies* y ss. |
| Empresario de **tercer país** | Fuera de la Comunidad | **No sujeto**, sin IVA | art. 69.Uno.1º |
| **Particular** de tercer país | Fuera de la Comunidad | **No sujeto** | art. 69.Dos.m) |

**Precisión terminológica que el diseño debe adoptar.** Para nosotros la
operación con un empresario UE **no es «una ISP»: es una no sujeción por regla de
localización**. La inversión del sujeto pasivo la aplica el destinatario en su
Estado. Llamarla ISP en el código y en la UI lleva a buscar una cuota que no
existe. Nombre correcto del tratamiento: `NO_SUJETO_LOCALIZACION_UE`.

**¿Vendemos a particulares?** **Recomendación: no.** Cerrar la venta a **B2B con
NIF-IVA obligatorio y validado**. Admitir B2C UE obliga a alta en OSS
(modelos 035 y 369, declaración trimestral, tipo de cada Estado de consumo) por
un segmento que en un ERP de contabilidad para PYMEs es residual. El umbral de
10.000 € del art. 73 LIVA existe, pero construir el producto sobre un umbral que
se supera es deuda fiscal con fecha.

**¿`automatic_tax` de Stripe como determinador?** **Sí como motor de cálculo, no
como prueba y nunca como responsable.** El sujeto pasivo es CFOnomic
(art. 164 LIVA) y la carga de la prueba de la condición de empresario del
destinatario es nuestra.

| Requisito | Regla |
|---|---|
| Quién valida el NIF-IVA | Stripe Tax consulta VIES, pero la **prueba se conserva en nuestro lado**: resultado, fecha-hora y nº de consulta VIES, sellados en el momento del **devengo**, no del alta |
| Revalidación | En **cada devengo** (cada renovación), no una sola vez: un NIF-IVA se da de baja |
| VIES caído o NIF no válido | **No se aplica la no sujeción**: se repercute 21 % o se suspende el alta. Nunca se presume válido |
| Campos que faltan en el modelo | `customerCountry`, `vatNumber`, `vatValidatedAt`, `vatValidationSource`, `vatValidationRef`, `taxTreatment` (`REPERCUTIDO_ES` \| `NO_SUJETO_LOCALIZACION_UE` \| `NO_SUJETO_TERCER_PAIS` \| `NO_SUJETO_CANARIAS_CEUTA_MELILLA` \| `OSS_<país>`) → **O-9** |

Regla de **uso efectivo** (art. 70.Dos): tras la L 31/2022 no alcanza, con
carácter general, a los servicios electrónicos B2B a tercer país. *Parametrizable*
si en el futuro se venden servicios de las categorías que sí cubre.

### C-2 · Devengo (tracto sucesivo con cobro anticipado)

| Supuesto | Devengo | Norma |
|---|---|---|
| Suscripción mensual/anual, precio **exigible** al inicio del periodo | El día en que **resulta exigible** el precio de ese periodo, según contrato | art. 75.Uno.7º LIVA |
| Cobro **anticipado** a la exigibilidad | El **cobro** anticipa el devengo por el importe cobrado | art. 75.Dos LIVA |
| Stripe **cobra el día 3** una renovación exigible el **día 1** | **Devengo el día 1.** El cobro del día 3 es un hecho de tesorería, no mueve el devengo ni el periodo de declaración | art. 75.Uno.7º |
| Contrato **sin precio pactado** o con exigibilidad **superior al año natural** | Devengo a **31/12** de cada año por la parte proporcional | art. 75.Uno.7º, párr. 2º |
| Anual pagado por adelantado | **Devengo íntegro** al inicio: el IVA del año entero en el primer periodo. La periodificación (485/438) es **nuestra** contabilidad, no un diferimiento del IVA | arts. 75.Uno.7º / 75.Dos |

**Consecuencia de producto: `issuedAt` no es la fecha de devengo.** El plazo de
expedición para destinatario empresario llega hasta el **día 16 del mes siguiente**
al devengo (art. 11 RD 1619/2012), y cuando la fecha de operación difiere de la de
expedición **ambas deben constar** (art. 6.1.f RD 1619/2012). `PlatformInvoice`
necesita `operationDate` además de `issuedAt` → **O-9**.

### C-3 · Notas de crédito y prorrateos

| Hecho de Stripe | Qué es | Documento |
|---|---|---|
| *Refund* total o parcial | Modificación de la base ya repercutida | **Factura rectificativa** |
| Prorrateo **negativo** (downgrade, baja a mitad de periodo) | Ídem | **Factura rectificativa** |
| Prorrateo **positivo** (upgrade con cargo adicional) | Operación **nueva**, no rectifica nada | Factura ordinaria (o línea de la del periodo) |
| Error de importe o de datos fiscales | Rectificación | **Factura rectificativa** |
| Descuento/cupón aplicado **en la propia factura** | Menor base desde el origen | Factura ordinaria, sin rectificativa |

**Requisitos de la rectificativa** (art. 15 RD 1619/2012): **serie específica y
diferenciada**, referencia inequívoca a la factura rectificada (o al periodo, si
son varias), la causa, y si se rectifica **por diferencias** o consignando el
importe rectificado. La minoración se declara en el periodo en que se expide la
rectificativa (art. 89 LIVA).

**Quién numera.** La numeración correlativa dentro de serie la asigna **el
expedidor** (arts. 6.1.a y 7 RD 1619/2012), que somos nosotros. Stripe sólo puede
numerar materialmente bajo **expedición por tercero** (art. 5 RD 1619/2012), lo
que exige autorización previa, responsabilidad nuestra y **serie exclusiva del
tercero**. Y hay un problema técnico real: Stripe deja **huecos** (borradores
anulados, `void`, `draft` no finalizadas) y, según configuración, numera por
cliente.

> **Recomendación:** numeración **nuestra**, `PLT-AAAA-NNNN` (ordinaria) y
> `PLT-R-AAAA-NNNN` (rectificativa), asignada al finalizar la factura en Stripe y
> persistida en `PlatformInvoice`; Stripe queda como pasarela de cobro y
> generador del PDF. Si se prefiere que numere Stripe, es admisible sólo con
> serie exclusiva y **un control de huecos ejecutado** — que es exactamente lo
> que **I-E8-20** hace con las series del cliente y que aquí hoy no hace nadie
> (**O-10**).

`PlatformInvoice` necesita `series`, `number NOT NULL`, `@@unique([series,
number])` y `rectifiesInvoiceId` → **O-9**.

### C-4 · Moneda

| Cuestión | Respuesta |
|---|---|
| ¿Puede la factura ir en USD? | Sí, el importe puede expresarse en cualquier moneda (art. 6.1.j RD 1619/2012) |
| ¿Hay que poner el contravalor? | **La cuota tributaria repercutida debe expresarse en euros, siempre.** El resto de importes pueden ir en la moneda de la operación |
| ¿Con qué tasa? | La del **momento del devengo** (art. 79.Once LIVA: tipo de cambio vendedor del Banco de España). La práctica admitida —y la del SII— acepta el **tipo del BCE del día del devengo** |
| ¿Sirve nuestra `ExchangeRate`? | **Sí, y es la respuesta recomendada**: misma fuente BCE/Frankfurter, misma fecha de referencia = **fecha de devengo** (C-2), nunca la de cobro ni la de hoy. Coherente con P2/P7 y con ADR-0014 |
| Día sin publicación (festivo, fin de semana) | La regla del ERP **RC-14** («sin tasa no se convierte») **no sirve aquí**: la factura hay que emitirla igual. Regla a fijar y escribir: **última tasa publicada anterior a la fecha de devengo**, con la fecha de esa tasa impresa en la factura |
| Monedas de 0 o 3 decimales | `totalCents Int` presupone 2 decimales. Restringir `currency ∈ {EUR, USD}` por CHECK o guardar `minorUnitScale` → **O-12** |

La conversión se hace **una sola vez, al devengo, y se sella** en la factura: no
se recalcula al mirarla.

### C-5 · Conservación de las facturas emitidas por la plataforma

Tres plazos concurrentes; manda **el más largo aplicable**.

| Norma | Plazo | Objeto |
|---|---|---|
| Art. 30 CCom | **6 años** desde el último asiento | Libros, correspondencia, documentación y **justificantes** |
| Arts. 66–67 LGT | 4 años de prescripción, con interrupciones | Obligaciones tributarias |
| Art. 26.5 LIS | **10 años** | Si hay BIN o deducciones pendientes de aplicar |
| Art. 165.Uno LIVA + arts. 19–23 RD 1619/2012 | Durante el plazo de prescripción | **Copias de las facturas expedidas**, garantizando **autenticidad de origen, integridad del contenido y legibilidad** |

> **No basta con que vivan en Stripe.** Stripe es un tercero con su propia
> política de retención, sin compromiso contractual de 6/10 años y sin garantía de
> acceso si se cierra la cuenta. Además, conservar por medios electrónicos **fuera
> de España** exige acceso completo en línea —descarga y utilización remota— y su
> comunicación (art. 23 RD 1619/2012). Un `hostedInvoiceUrl` **no es una copia
> conservada**: es un enlace a la copia de otro.

**Corrección:** `PlatformInvoice` guarda, además de las URL, el **PDF copiado a
nuestro almacén** con su `sha256`, como `StoredObject` de `kind` nuevo
`PLATFORM_INVOICE`, indexado por `(series, number)`, **excluido de la retención de
30/90 días** de los ZIP y de la cuota de almacenamiento del cliente
(no es suyo) → **O-9**, **O-11**.

### C-6 · Modelos 303 y 349

| Operación | 303 | 349 | 390 |
|---|---|---|---|
| Suscripción a empresario **español** | Casillas de repercutido al 21 % | No | Sí |
| Suscripción a empresario **UE** (no sujeta por localización) | **Casilla 59** («operaciones no sujetas o con ISP») | **Sí — clave `S`**, prestaciones de servicios intracomunitarias | Sí |
| Suscripción a empresario de **tercer país** | **Casilla 59** | **No** | Sí |
| Canarias / Ceuta / Melilla | Casilla 59 | No | Sí |

Sí: **el 349 es obligatorio** para las prestaciones a empresarios UE con
inversión del sujeto pasivo (arts. 79–81 RIVA). Periodicidad **trimestral** con
carácter general; **mensual** si el importe de entregas y prestaciones
intracomunitarias supera **50.000 €** en el trimestre en curso o en alguno de los
cuatro anteriores.

**Consecuencia de producto:** `/admin` debe poder exportar, por periodo, una
línea por operación con: `taxTreatment`, país, NIF-IVA, base en euros, cuota,
fecha de **devengo** y clave 349. Eso exige los campos de C-1 y C-2 → **O-9**.
No cambia el motor contable.

### C-7 · Plan FREE

| Pregunta | Respuesta |
|---|---|
| ¿Operación sujeta? | **No.** El IVA grava entregas y servicios **a título oneroso** (art. 4.Uno LIVA). Sin contraprestación no hay operación sujeta |
| ¿Obligación de factura? | **No.** La obligación alcanza a operaciones sujetas (art. 2 RD 1619/2012). **No se emite factura a cero**: ensucia la serie y no documenta nada |
| ¿Autoconsumo de servicios (art. 12.3º)? | **No**, si el plan gratuito tiene **finalidad comercial** (captación, *freemium*, prueba del producto): es un gasto de promoción **dentro** de la actividad |
| ¿Cuándo sí habría autoconsumo? | Si el FREE se concede a **vinculados** (socios, administradores, empresas del grupo) o para fines ajenos a la actividad: entonces base = valor de mercado (art. 79.Cinco). *Parametrizable*: dependerá de a quién se conceda |
| ¿Limita la deducción del IVA soportado? | **No**, por lo anterior: el coste del FREE comercial es coste de la actividad sujeta |
| Justificante para el cliente | Si se quiere, un documento **marcado «sin valor fiscal»**, nunca una factura con número de serie |

---

## 2. Observaciones, con corrección concreta

Severidad: **BLOQUEANTE** (impide firmar el ADR o poner precios) ·
**IMPORTANTE** (debe resolverse dentro de E11) · **MENOR** (anotar y cerrar).

---

### O-1 · BLOQUEANTE — Los tres hashes **no son** criterio P7 suficiente de restauración (D2.6, I-E11-2)

`ledgerHash`, `analyticsKey` y `budgetHash` cubren **importes y dimensiones**. No
cubren nada de lo que un auditor comprueba primero al recibir unos libros
restaurados. Lo que se escapa:

| Qué no verifican los tres hashes | Invariante que queda sin sostén |
|---|---|
| **`entryNumber`**: numeración correlativa por ejercicio, sin huecos ni duplicados. Si la forma canónica ordena por fecha/cuenta/importe, **dos asientos con los números intercambiados dan el mismo hash** | I7, `post.ts` §6, art. 28.2 CCom |
| **Series de facturación** (`InvoiceSeries`) y su último número emitido | I-E8-20 |
| **Sellos derivados**: `proposal_sha`/`schema_sha`/`prompt_sha`, `linesHash`, `checksHash`, `scheduleHash`, `inputHash`, `timeHash`, `ReportRun.validation` | I-E8-11, I-E7-7/9/10, I-E9-1b/3/25, I-E10-6/17 |
| **`AuditLog`**: quién forzó qué y con qué motivo (`FORCE_DUPLICATE`, campos `no_verificado`, forzado de tasa) | P6, I-E8-13, §motivos de sello |
| **`fieldOrigins`**: los cuatro niveles de confianza del camino documental | P6 |
| **`exchange_rates`**: es tabla **global**, no de tenant, luego **no está en `TENANT_MODELS` ni en el backup**. Sin ella, `convertedTotal` no se reproduce en el destino | I-E8-5, I-E8-14 |
| **Estado del cierre**: `FiscalYear.status` y `closedAt`, `ClosingRun` | I-E9-15, I-E9-20/21 |
| **Correspondencia fichero ↔ objeto**: que **todo** `File` restaurado tenga sus bytes | I-E8-2, I-E11-6 |

**Corrección.** Ampliar el enunciado de **I-E11-2** y el contenido de
`RestoreJob` a un `restoreVerification.json` que exija, además de los tres sellos:

1. **Igualdad exacta de recuentos** tabla a tabla contra el manifest (`=`, no `⊇`).
2. **Numeración**: `max(entry_number)`, ausencia de huecos y de duplicados por
   `(ejercicio, serie)`, y último número de cada `InvoiceSeries`.
3. **Recomputo de *todos* los hashes derivados sellados** de la organización,
   sobre una lista **derivada del código** —el mismo patrón que I-E11-7 aplica al
   inventario—, no escrita a mano. Ésta es la parte que más fácil se olvida en la
   épica 68.
4. **`AuditLog`**: recuento y sha256 de su forma canónica, enfrentados.
5. **`exchange_rates`**: el backup incluye, en una sección aparte y declarada como
   **global**, las tasas efectivamente **referenciadas** por las líneas volcadas; el
   restore las inserta si faltan (append-only, única por `(fecha, par, fuente)`) y
   **falla si una existe con otro valor**.
6. **Barrido completo de las nueve familias** (no sólo I1–I10) sobre el destino,
   con su `checksHash`. §11.1 ya lo promete en prosa; el **contrato de I-E11-2 no
   lo dice**, y lo que no está en el enunciado no se ejecuta (H-1 de E9 y H-1 de
   E10, dos veces).

---

### O-2 · IMPORTANTE — `RestoreJob` con `verified = false` no puede llamarse `DONE`

`DONE` con `verified = false` es un estado que un operador que filtre por `DONE`
leerá como bueno. El propio ADR dice que es **FAIL**, no un aviso.

**Corrección.** Añadir `DONE_UNVERIFIED` al enum `RestoreStatus` (o reservar
`DONE` para `verified = true` y usar `FAILED_VERIFICATION`). La organización
destino se conserva y se marca, como el ADR dice — sólo cambia el nombre del
estado, que es lo que se consulta.

---

### O-3 · BLOQUEANTE — Un límite de plan **impide hoy registrar un hecho contable ya ocurrido** (D1.6, D6, §3.5, criterios 5 y 11)

Éste es el defecto contable de fondo de la épica.

El diseño declara el principio correcto —«el de asientos es holgado a propósito
para que nadie deje de contabilizar por miedo a la factura, que sería exactamente
el incentivo equivocado en un producto de contabilidad» (§19)— y a continuación
lo implementa como **bloqueo duro**: `maxEntriesMonth` pasa por
`assertWithinLimit` y el asiento 2.001 se rechaza; y en `READ_ONLY`,
`postEntryAction` devuelve error (criterio 5).

La obligación de llevanza no es nuestra, pero **el impedimento sí lo creamos
nosotros**: art. 28.2 CCom (los asientos se practican dentro de los **tres meses**
siguientes), art. 164 LIVA y los plazos del SII y de las autoliquidaciones no
admiten «mi proveedor de software me agotó la cuota». Un auditor que vea un
diario con un salto de tres semanas y un ticket de soporte que diga «límite de
plan» rechaza el sistema, no al cliente.

**Corrección.** Escribir en el ADR la regla, y partir las cuotas en dos clases:

| Clase | Claves | Régimen |
|---|---|---|
| **Cuota de recurso** (consumo real nuestro) | `maxOcrDocsMonth`, `maxStorageBytes`, `maxExportsMonth`, `maxBackupsMonth`, `maxMembers`, `maxOrganizations` | **Bloqueo legítimo.** Son recursos de la plataforma, no hechos contables. El diseño actual es correcto |
| **Cuota sobre el registro contable** | `maxEntriesMonth` | **Límite blando.** Nunca rechaza un `postEntry` |

Regla propuesta, textual: **«Ningún límite de plan puede impedir el registro de
un hecho contable ya ocurrido, ni en cuota agotada ni en mora.»** Implementación
del límite blando: aviso al 80 % y al 100 %, motivo de plataforma
`CUOTA_DE_ASIENTOS_SUPERADA` visible en cabecera y en `/settings/subscription`,
bloqueo de funciones **accesorias** (demo, importaciones masivas, nuevas
organizaciones) y facturación del exceso o propuesta de cambio de plan **el mes
siguiente**. Si se quiere conservar un tope, que sea una **franquicia de
continuidad** explícita (p. ej. 3× el límite o 30 días) y automática.

**Y hay un callejón sin salida operativo que hay que cerrar:** I-E11-4 admite
superar un límite «si existe un `AuditLog` de excepción con motivo», pero en E11
**`/admin` es de sólo lectura** y **nadie puede conceder esa excepción**. La
excepción tiene que ser **automática y registrada** (la del límite blando), no
una intervención de operador que no existe hasta E12.

**Lo mismo en `READ_ONLY`.** D6 es acertado y debe conservarse; el problema es qué
cae dentro de «escritura». Como mínimo deben seguir permitidos, con marca de
mora:

- los **contra-asientos de anulación** (única forma de corregir: ADR-0003);
- los asientos **del sistema** que cierran obligaciones ya devengadas:
  recurrentes vencidos, devengo RECC (T-36), liquidación de IVA del periodo,
  los cuatro del cierre si el ejercicio vence durante la mora;
- el registro de documentos **ya recibidos** (la obligación de anotación en el
  libro registro no se suspende).

Y el mensaje de `READ_ONLY` debe decir, en español y sin eufemismo, que el
cliente puede exportar y llevarse sus libros y que la llevanza sigue siendo suya.

---

### O-4 · BLOQUEANTE — El plan FREE en mora **no puede ejercer la portabilidad que D6 le promete**

Contradicción directa entre la tabla de planes de §19 y D6:

- FREE: `maxBackupsMonth = 1`, `graceDays = 0`, retención de backups **7 días**.
- D6: en `READ_ONLY` se puede «pedir y descargar un backup completo».

Si el cliente ya gastó su único backup del mes, **no puede pedir otro**: el
guardián `assertWithinLimit` lo rechaza. Y si lo pidió, el ZIP caduca a los
7 días. La portabilidad que D6 declara innegociable queda desactivada por un
número de la tabla de precios — que es exactamente la clase de «optimización»
contra la que D6 se escribió.

**Corrección.** Tres reglas, en el ADR y no en la UI:

1. El **backup de salida** (`BackupTrigger.EXIT`, o cualquier backup solicitado
   por una organización en `READ_ONLY`, `CANCELED` o `PAUSED`) **no consume
   `maxBackupsMonth`**: `checkLimit` devuelve `ok` sin mirar el uso.
2. Tras `CANCELED`, ventana mínima de descarga **de 90 días**, por encima de la
   retención del plan, y aviso por correo al inicio y a falta de 15 días.
3. `maxBackupsMonth` **nunca** se aplica cuando `accessLevelOf ≠ FULL`.

---

### O-5 · IMPORTANTE — El recuento de `entries` castiga la corrección contable (§3.4)

`entries` cuenta «los anulados y sus contra-asientos». El argumento («el trabajo
se hizo») es razonable en costes, pero el efecto es que **corregir un error
consume el doble de cuota que dejarlo**. En un producto de contabilidad, donde la
anulación por contra-asiento es el **único** camino admitido (ADR-0003) y por
tanto una conducta obligatoria, el incentivo está exactamente al revés.

**Corrección.** Excluir del recuento:

- los asientos con `reversesEntryId IS NOT NULL` (contra-asientos);
- los asientos de sistema: `kind ∈ {REGULARIZATION, CLOSING, OPENING}` y las
  ocurrencias del bloque de cierre T-25…T-28, que los genera el motor, no el
  usuario;
- los asientos de la **demo** (ver O-6).

Y declararlo en la UI, junto a `computedAt` y `gitSha`, como el resto de cifras
derivadas (P6).

---

### O-6 · IMPORTANTE — La demo no es separable, y hace fallar I-E11-1 (§6.3)

Tres problemas encadenados:

1. §6.3 dice que los asientos de demo **no cuentan** contra `maxEntriesMonth`,
   pero **no hay marca por fila** que permita excluirlos: `OnboardingRun.demoLoaded`
   es un flag de organización. Si la exclusión no está en `computeUsage` **y** en
   `usageSourceHash`, **I-E11-1 («uso derivado = Σ real») fallará en toda
   organización con demo**, que es el caso por defecto del alta.
2. Los documentos y objetos de la demo **sí consumen** `storageBytes` y
   `ocrDocs`, y eso no se declara en ningún sitio.
3. El vaciado «por el camino de producción» (`--reset-org`) **borra asientos
   posteados**. Eso contradice el append-only del diario (ADR-0003) y, si el
   usuario ya mezcló datos reales, el art. 30 CCom. Un botón que borra asientos no
   puede existir en este producto.

**Corrección.** La demo va a una **organización propia** (`Demo — <nombre>`),
creada en el paso 6 y marcada como tal (`Organization.isDemo`, inmutable),
**nunca** dentro de la organización real del cliente. Entonces:

- «vaciar la demo» es **borrar la organización de demo entera**, no borrar
  asientos: el append-only se respeta sin excepción;
- la exclusión del uso es trivial y vive **una sola vez** (`isDemo` entra en
  `computeUsage` y en `usageSourceHash`);
- la demo no cuenta contra `maxOrganizations`;
- se conserva íntegro el valor que §6.3 busca: sigue siendo un **test de humo de
  producción** posteado por el motor.

Si se decide mantenerla en la organización real, entonces: marca por fila
obligatoria, exclusión en las **tres** métricas, y el botón de vaciado
**deshabilitado en cuanto exista un asiento no-demo**, sin excepción.

---

### O-7 · BLOQUEANTE — La siembra deja organizaciones que incumplen I-E11-10 por construcción (§6.1, §6.2)

Tres defectos, y el tercero es el que repite un fallo ya cometido.

**(a) Series creadas en el paso 4, exigidas en toda organización activa.** Una
organización que abandona el asistente en el paso 3 es «activa» y **fallará
I-E11-10** — un invariante que falla con datos limpios no distingue una
manipulación, que es la lección de E10.
*Corrección:* sembrar `ORDINARIA` y `RECTIFICATIVA` con prefijo por defecto en el
**paso 1**, dentro de la transacción de `seedOrganization`, y que el paso 4 sólo
**renombre el prefijo mientras `lastNumber = 0`**. Es además la única ventana en
que renombrar es legal: con números ya emitidos, la serie no se toca
(art. 6.1.a RD 1619/2012). Esto hace real la mitigación de I-E8-20 que §11.1
promete.

**(b) Dos puntos de creación del ejercicio.** §6.1 mete `FiscalYear` en la
siembra atómica del paso 1 y §6.2 lo crea en el paso 3. O hay dos ejercicios
solapados, o el paso 3 no hace nada.
*Corrección:* el paso 1 siembra un ejercicio **provisional** por año natural; el
paso 3 lo **edita mientras no tenga asientos**, con CHECK de no solape por
organización. Escribir cuál de las dos, y que el invariante exija exactamente
una.

**(c) I-E11-10 no comprueba `TaxRate`.** La siembra los crea
(`createOrganizationDefaults`), pero el invariante enumera siete piezas y **los
tipos impositivos no están**. Es literalmente R-2 de E9 otra vez: la pieza que se
siembra pero que nadie verifica es la que desaparece en la épica siguiente. Sin
`TaxRate` vigente, `postFromProposal` no puede construir una línea de IVA y el
camino documental completo de E8 queda muerto.
*Corrección:* I-E11-10 pasa a exigir **nueve** piezas: las siete actuales +
`TaxRate` vigente para IVA e IRPF + `baseCurrency` con `Currency` sembrada (y, si
`baseCurrency ≠ EUR`, al menos una `ExchangeRate` accesible: RC-14 dejaría la
organización sin poder convertir nada).

---

### O-8 · IMPORTANTE — I-E11-8 es correcto, y le faltan dos cierres

El enunciado —«ningún `JournalEntry` referencia una `PlatformInvoice`, una
`Subscription` ni un `BackupJob`»— **debe conservarse tal cual**. Es la decisión
contable más importante del ADR: nuestro ingreso no es su gasto, y su gasto entra
por el camino documental de E8 como cualquier factura de proveedor, con su 472,
su 62x/629 y su cuadre. Le faltan dos puertas:

1. **El camino indirecto.** Nada impide hoy que `PlatformInvoice` alimente un
   `Transaction` o un documento en `/unsorted` de la propia organización. Es
   tentador («te pre-cargamos tu factura de CFOnomic») y es exactamente por donde
   se cuela. *Corrección:* extender I-E11-8 a que **ningún `Transaction`,
   `ExtractionRun` ni `File` tenga por origen una `PlatformInvoice`**. Si algún
   día se ofrece, tiene que entrar como **documento subido**, con sus bytes, su
   `sha256` y su `ExtractionRun` — nunca una propuesta fabricada sin documento,
   que I-E8-9 e I-E8-1 rechazarían con razón.
2. **La contabilidad de CFOnomic.** Escribir que nuestros propios ingresos de
   suscripción **no se llevan en una «organización plataforma» con privilegios**.
   Si CFOnomic quiere usar su propio producto, es una organización cliente más,
   con las mismas reglas, el mismo RLS y los mismos invariantes.

---

### O-9 · BLOQUEANTE — `PlatformInvoice` no puede sostener una obligación de facturación

Consolida lo que exigen C-1 … C-6. El modelo actual guarda `stripeInvoiceId`,
`number` **opcional**, importes y dos URL. Con eso no se puede acreditar ni la
serie, ni el devengo, ni el tratamiento fiscal, ni la conservación.

| Campo que falta | Por qué | Norma |
|---|---|---|
| `series` + `number NOT NULL` + `@@unique([series, number])` | Correlatividad demostrable de la serie emitida | arts. 6.1.a, 7 RD 1619/2012 |
| `rectifiesInvoiceId` + `rectificationCause` + `rectificationMode` (diferencias \| sustitución) | Factura rectificativa | art. 15 RD 1619/2012 |
| `operationDate` (fecha de **devengo**), distinta de `issuedAt` | El plazo de expedición llega al día 16 del mes siguiente; si difieren, **ambas constan** | arts. 6.1.f, 11 RD 1619/2012; 75 LIVA |
| `taxTreatment`, `customerCountry`, `vatNumber`, `vatValidatedAt`, `vatValidationSource`, `vatValidationRef` | Determinación y **prueba** del régimen; alimenta el 303 y el 349 | arts. 69, 164 LIVA; 79–81 RIVA |
| `reverseChargeMention` (texto impreso) | Mención obligatoria en la no sujeción UE | art. 6.1.m RD 1619/2012 |
| `taxCentsEur` + `fxRate` + `fxRateDate` + `fxSource` | La **cuota** siempre en euros, a la tasa del devengo | arts. 79.Once, 6.1.j |
| `storedObjectId` (PDF copiado, `kind = PLATFORM_INVOICE`) | Conservación de la copia con integridad y legibilidad | art. 165.Uno LIVA; arts. 19–23 RD 1619/2012 |
| `ivaPeriod` (`AAAA-Qn`, derivado de `operationDate`) | Periodo de declaración, con la **misma clave canónica** que el ERP (ADR-0014 D8) | — |

Ninguno de estos campos toca el motor contable ni el diario del cliente: son
columnas de una tabla de plataforma. **Pero sin ellos no se pueden poner precios
en producción**, que es justamente la condición que el ADR pone a esta firma.

---

### O-10 · BLOQUEANTE — La serie de facturación de la plataforma no la vigila nadie

I-E8-20 exige, para las series **del cliente**, numeración sin huecos y fecha no
decreciente (art. 6.1.a RD 1619/2012). Nuestra propia serie emitida está sujeta a
**la misma norma** y no tiene invariante. Es el defecto más difícil de defender
ante un auditor: aplicamos al cliente un rigor que no nos aplicamos.

**Corrección.** Añadir a la familia `PLATAFORMA`:

> **I-E11-13 · Serie de plataforma.** Para cada `series` de `PlatformInvoice`:
> numeración correlativa **sin huecos**, sin duplicados, `operationDate` **no
> decreciente** respecto del número, y toda factura con `rectifiesInvoiceId`
> pertenece a una serie de `kind = RECTIFICATIVA` y referencia una factura
> existente de la misma organización. Tolerancia 0. Espejo exacto de I-E8-20.

Y ejecutarlo en el barrido, no sólo definirlo (verificación 1 del ADR).

---

### O-11 · IMPORTANTE — La retención de 30/90 días roza documentación que sí hay que conservar

D2.8 y §5.5 aciertan al distinguir los **ZIP de exportación** (retención propia)
de los **libros y justificantes** (art. 30 CCom, seis años; diez con BIN,
art. 26.5 LIS), y al decirlo así en la UI. Falta cerrar dos bordes:

1. **Las copias de nuestras facturas emitidas** (C-5) van al mismo almacén y
   **no pueden** caer bajo la retención de 30/90 días. Excluir `kind =
   PLATFORM_INVOICE` del `retention` job, explícitamente y con test.
2. **Borrado de organización.** `onDelete: Cascade` cuelga de `Organization` en
   casi todas las tablas nuevas. Si alguna vez existe un camino que borre una
   organización, se lleva por delante libros dentro de plazo de conservación.
   Escribir que **no existe borrado de organización con asientos**: sólo
   desactivación (`BLOCKED` por su propio ADMIN, que ya es el supuesto de D6), y
   que el `Cascade` es una salvaguarda de integridad referencial, no un camino de
   producto.

---

### O-12 · MENOR — Tres cifras sin contrato

| # | Qué | Corrección |
|---|---|---|
| a | `PlatformInvoice.totalCents Int` presupone **2 decimales**; JPY tiene 0 y BHD tiene 3 | CHECK `currency IN ('EUR','USD')`, o `minorUnitScale` |
| b | `usageSourceHash` entra el «`ledgerHash` **del mes**»; `ledgerHash` está definido por `(organizationId, periodo)` — **declarar el periodo exacto** o dos meses colisionan | Fijar `periodMonth` como periodo del hash, y escribirlo |
| c | `UsageRun.storageBytes` excluye los backups, pero los ZIP viven en el mismo bucket con prefijo de organización | I-E11-6 y el cálculo deben filtrar por `kind`, no por prefijo |

---

### O-13 · IMPORTANTE — El cron puede meter el reloj dentro de una cifra contable (§7.1, D4)

`recurring-due` corre «diaria 06:00 Europe/Madrid». El diseño **no dice** con qué
fecha se postea la ocurrencia. Si hereda el instante de ejecución, un reloj entra
en un `entryDate`, que es justo lo que `.claude/hooks/guard.sh` prohíbe dentro de
`lib/ledger`, y una ejecución con retraso produciría **otro** asiento.

**Corrección.** Escribir que el job pasa `refDate` **explícito** y que la
ocurrencia se fecha por **su periodo de devengo**, nunca por la ejecución; test de
que lanzar el job con dos días de retraso, o dos veces, produce **el mismo
asiento y el mismo `inputHash`** (I-E9-1b ya lo puede verificar).

**Y decidir qué hace el cron en `READ_ONLY`** (hoy no está escrito). Recomendación
coherente con O-3: `invariant-sweep` **sí corre** (es lectura);
`recurring-due` **no genera** y deja la ocurrencia en `OMITIDA` con motivo
`SUSCRIPCION_EN_MORA` —I-E9-1a exige motivo, así el invariante no falla por
nuestro impago— **salvo** las ocurrencias de obligación devengada de O-3, que sí
se generan.

---

### O-14 · IMPORTANTE — La retirada de `aiBalance` es correcta, y tiene una cara de pasivo (D1.5, P-4)

Retirar un saldo almacenado que se decrementa es P2/P4 aplicado al pie de la
letra, y además nunca funcionó (G-12). Sin objeción al **qué**. El **cómo** tiene
un lado contable que P-4 formula como decisión de producto y no lo es del todo:
un saldo prepagado y no consumido es, para CFOnomic, un **anticipo de clientes /
ingreso diferido (438 / 485)**, no un ingreso realizado. Convertirlo en «un
`maxOcrDocsMonth` elevado durante N meses» es una **novación del contrato**: si el
cliente no la acepta, el pasivo sigue vivo.

**Corrección**, antes de la migración M4:

1. Inventariar el saldo por organización y **cuantificarlo en euros** al precio al
   que se vendió (no en créditos).
2. Ofrecer por escrito **canje o devolución**; la baja del pasivo sólo con
   aceptación o prescripción.
3. El `PlatformAuditLog` de migración guarda **el importe en euros**, no sólo el
   número de créditos: sin él, el dato «no se pierde» sólo a medias.

Si hoy no hay ningún cliente con saldo —probable, siendo preview—, el punto decae
en el acto; **pero se escribe y se comprueba**, no se supone.

---

### O-15 · MENOR — Dos precisiones de redacción que evitan un error caro

1. **«Inversión del sujeto pasivo» aplicada a nuestras ventas UE** es impropia
   (C-1): para nosotros es **no sujeción por localización**. Renombrar el
   tratamiento en el modelo y en la UI; en la **factura** sí va la mención
   «inversión del sujeto pasivo», que es lo que la norma exige imprimir.
2. **§18 dice «las siete cuestiones fiscales … ninguna cambia el motor
   contable»**: confirmado, ninguna lo cambia. Pero **C-3, C-4 y C-5 sí cambian el
   esquema** (`PlatformInvoice`, `StoredObjectKind`) y **C-1 y C-6 sí cambian
   `/admin`**. «No cambian el motor» no es «no cambian nada»: las tareas de O-9
   hay que planificarlas.

---

## 3. Lo que un auditor rechazaría, en una línea cada uno

| # | Hallazgo | Obs. |
|---|---|---|
| 1 | Un diario con un salto porque el plan agotó la cuota de asientos | O-3 |
| 2 | Un cliente en mora al que se le impide asentar un hecho ocurrido | O-3 |
| 3 | Un cliente que no puede descargar sus libros porque gastó su único backup | O-4 |
| 4 | Un `RestoreJob` `DONE` que no reprodujo los sellos | O-2 |
| 5 | Una restauración «verificada» que no comprueba la numeración de asientos | O-1 |
| 6 | Una restauración sin las tasas de cambio que sus líneas referencian | O-1 |
| 7 | Una restauración que no recompone el `AuditLog`: se pierde quién forzó qué | O-1 |
| 8 | Facturas emitidas conservadas **por enlace** a un tercero | C-5, O-9 |
| 9 | Una serie de facturación propia sin control de huecos, exigiéndoselo al cliente | O-10 |
| 10 | Una factura sin fecha de operación cuando difiere de la de expedición | C-2, O-9 |
| 11 | Una factura en USD sin la cuota en euros y sin la tasa aplicada | C-4, O-9 |
| 12 | Aplicar no sujeción a un NIF-IVA que nadie validó en la fecha de devengo | C-1 |
| 13 | ISP a clientes UE sin presentar el 349 | C-6 |
| 14 | Un botón que borra asientos posteados («vaciar la demo») | O-6 |
| 15 | Un invariante de siembra que pasa por vacuidad porque no mira `TaxRate` | O-7c |
| 16 | Un asiento cuya fecha la puso el reloj del cron | O-13 |
| 17 | Una excepción de límite que exige un operador que en E11 no existe | O-3 |
| 18 | Saldo prepagado convertido en otra cosa sin ofrecer canje ni devolución | O-14 |

---

## 4. Qué se aprueba sin reservas

Para que no se lea como una enmienda a la totalidad, y porque estas cuatro
decisiones son las que hay que **defender** si alguien las discute más adelante:

| Decisión | Por qué es correcta |
|---|---|
| **I-E11-8** — la plataforma no toca el diario del cliente | Nuestro ingreso no es su gasto contabilizado. Su factura de proveedor entra por E8 con su 472, su 62x y su cuadre, como cualquier otra. Un asiento fabricado sin documento violaría I-E8-1 e I-E8-9 |
| **D6** — el impago retira la escritura, nunca la lectura ni la exportación | Custodiamos libros y justificantes obligatorios **de un tercero**. Retenerlos por una deuda comercial no es una palanca de cobro: es un riesgo legal y una ruina reputacional. Conservar el párrafo palabra por palabra |
| **D1.5** — el uso se **deriva**, no se almacena; `aiBalance` se retira | Un contador que se incrementa al escribir es una cifra almacenada que puede divergir y que no baja al anular: P2 y P4 exactos. La caché por `sourceHash` es auditable; un contador no |
| **D2.4 + D2.5** — restaurar siempre a organización nueva, y abortar a la primera fila rechazada | «Vaciar y volver a meter» contradice el append-only del diario. Y un restore que informa de éxito sobre filas que no existen (G-15) es peor que uno que falla |

---

## 5. Condición de cierre

| Firma | Condición |
|---|---|
| **D2, D3, D4, D5** | **CONFORMES** desde la óptica contable, con **O-1** y **O-2** incorporadas a D2 |
| **D1** | Firmable con **O-3**, **O-5**, **O-9** y **O-14** incorporadas |
| **D6** | Firmable con **O-3** (qué sigue siendo posible en `READ_ONLY`) y **O-4** (portabilidad real) incorporadas |
| **Precios en producción** | Bloqueado hasta **O-9**, **O-10** y **C-5** (copia conservada del PDF), y hasta decidir **B2B-only** (C-1) |
| **Arranque del sprint** | **No bloqueado**: ninguna observación toca `lib/ledger`, `lib/analytics` ni `lib/closing` |

---

*Validado por `experto-contable`. Cifras citadas del fixture `ejercicio-completo`
sólo como referencia de verificación; este documento no calcula informes.*

---

# Ronda 2 — Re-validación (2026-09-15)

Verificada **contra el texto real** del diseño reescrito (1 737 líneas) y de
ADR-0019 D1–D8 (462 líneas), no contra el resumen del coordinador.

## 6. Estado de las quince observaciones

| # | Estado | Dónde se cierra (verificado) |
|---|---|---|
| **O-1** · Los tres hashes no bastan como P7 | **CERRADA** | D2.6 con las **seis** comprobaciones y `restoreVerification.json`; `derivedSealColumns()` derivado del código; `global/exchange_rates.jsonl` con las tasas **referenciadas** (§5.2 l.928, §5.4 paso 5) y fallo si una existe con otro valor; **I-E11-2 reescrito** (l.1301) con el barrido de las nueve familias **en el enunciado**; criterio 28 (dos `entryNumber` intercambiados) |
| **O-2** · `DONE` con `verified = false` | **CERRADA** | D2.7: `DONE` reservado a `verified = true`, `DONE_UNVERIFIED` es FAIL y la organización se conserva marcada |
| **O-3** · Un límite impedía registrar un hecho ocurrido | **CERRADA** | **D7** nuevo, con la regla textual; `softMaxEntriesMonth` así nombrada en el esquema (l.186) para que nadie la cablee al guardián; siete acciones de cuota dura; **excepción automática y registrada** (ya no exige un operador inexistente); matriz de §8.2: `postEntryAction` ordinario y `postFromProposal` **permitidos en `READ_ONLY`** |
| **O-4** · El FREE en mora no podía llevarse sus datos | **CERRADA** | **D5** nuevo: `BackupTrigger.EXIT` sin cuota (l.474, l.807), `maxBackupsMonth` inaplicable fuera de `FULL`, `exportWindowUntil` 90 días tras `CANCELED`; `backups` no cuenta los `EXIT` (l.750) |
| **O-5** · `entries` castigaba el contra-asiento | **CERRADA** | §3.4 l.746: excluye `reversesEntryId`, asientos de sistema y T-25…T-28 e `isDemo`; I-E11-1 exige las mismas exclusiones |
| **O-6** · Demo no separable | **CERRADA** | Organización propia `isDemo` **inmutable por trigger** (l.633, criterio 47); desaparece el botón que borraba asientos posteados; `isDemo` entra en `computeUsage` **y** en `usageSourceHash`; no cuenta contra `maxOrganizations` |
| **O-7** · Siembra que incumplía I-E11-10 | **CERRADA** | Series y ejercicio provisional **en el paso 1** (l.1037-1040); el asistente sólo renombra el prefijo mientras `lastNumber = 0`; **I-E11-10 con nueve piezas**, `TaxRate` y `Currency`/`ExchangeRate` incluidas (l.1309); criterio 41: abandono en el paso 3 ⇒ **PASS** |
| **O-8** · I-E11-8 sin la puerta indirecta | **CERRADA** | I-E11-8 conservado palabra por palabra + prohibido el origen `PlatformInvoice` en `Transaction`/`ExtractionRun`/`File`, + prohibida la «organización plataforma» con privilegios; test estático de AST en T20 |
| **O-9** · `PlatformInvoice` insostenible | **CERRADA** | 14 campos nuevos verificados uno a uno: `seriesId`/`number`/`fullNumber`, `rectifies*`, `operationDate` ≠ `issuedAt`, `ivaPeriod` `AAAA-Qn`, `taxTreatment` con los cuatro valores, prueba VIES, `reverseChargeMention`, `taxCentsEur` + `fxRate*`, `storedObjectId` |
| **O-10** · Nuestra serie sin vigilancia | **CERRADA** | **D8** nuevo, `PlatformInvoiceSeries`, numeramos nosotros, **I-E11-13** espejo exacto de I-E8-20 **y ejecutado en el barrido** (verificación 1 del ADR) |
| **O-11** · Retención rozando documentación conservable | **CERRADA** | `kind = PLATFORM_INVOICE` excluido de la retención y de la cuota; I-E11-11 lo comprueba; escrito que **no existe borrado de organización con asientos** |
| **O-12** · Tres cifras sin contrato | **CERRADA** | (a) `CHECK (currency IN ('EUR','USD'))`; (b) `usageSourceHash` declara `periodMonth` como periodo del `ledgerHash` (l.737); (c) I-E11-6 y `storageBytes` filtran **por `kind`** |
| **O-13** · El reloj dentro de una cifra contable | **CERRADA** | D4.5: `refDate` explícito persistido en `CronRun`, ocurrencia fechada por su periodo de devengo, criterio 49 (dos días de retraso ⇒ mismo `inputHash`), y **qué hace cada job en mora** |
| **O-14** · `aiBalance` prepagado como pasivo | **CERRADA** | M4 **aborta** si `aiBalance > 0` e imprime el importe en euros; verificado sobre el preview (1 organización, saldo 0) |
| **O-15** · «ISP» impropia y alcance de §18 | **CERRADA** | `NO_SUJETO_LOCALIZACION_UE` en el enum; la mención sí se imprime (art. 6.1.m); C-1…C-5 movidas al esquema en D8 y T18 |

**Quince de quince cerradas.** C-1 … C-7 recogidas sin desviación: B2B-only,
VIES sellado **en el devengo**, devengo por exigibilidad, rectificativas con serie
propia, cuota siempre en euros a la tasa del devengo con regla para el día sin
publicación, copia del PDF conservada, FREE no sujeto.

## 7. Abierto tras la ronda 2 — dos observaciones menores

| # | Obs. | Corrección exacta |
|---|---|---|
| **O-16** · MENOR | **§3.2.3 permite «el registro de documentos ya recibidos» en mora, pero la matriz de §8.2 no marca `uploadFileAction` como `allowInReadOnly`.** Sin poder subir el justificante no se puede ejercer el punto 3: la anotación en el libro registro queda tan impedida como antes, sólo que un renglón más abajo | Añadir a la matriz de §8.2 dos filas: **`uploadFileAction` → permitida** en `READ_ONLY` (el justificante es del cliente y su conservación es su obligación, art. 30 CCom / 165 LIVA), con `maxStorageBytes` aplicado como **blando** mientras `accessLevelOf ≠ FULL`; y **`analyzeFileAction` → denegada**, que es correcto y no crea incumplimiento: el OCR es coste variable nuestro y el asiento se puede teclear |
| **O-17** · MENOR | **El export 303/349 se aplaza a E14 (§0.3), pero la obligación del 349 nace con la primera factura a un empresario UE**, no con la pantalla. Entre T18 y E14 el operador no tiene de dónde sacarlo | Dejar en el runbook de despliegue una **consulta SQL documentada** sobre `platform_invoices` (periodo, `taxTreatment`, país, `vatNumber`, base, `taxCentsEur`, clave `S`) — los campos ya existen por O-9, sólo falta la consulta— y anotar la deuda en `docs/ESTADO.md` **con épica de cierre E14** |

Ninguna de las dos toca `lib/ledger`, `lib/analytics` ni `lib/closing`, ni exige
migración: O-16 es una marca en dos server actions, O-17 es una consulta en un
runbook.

## 8. Veredicto final

> ## **CONFORME CON OBSERVACIONES**
>
> **D1 … D8 se validan contablemente.** Las quince observaciones de la ronda 1
> están cerradas **en el texto**, no en la intención: comprobadas una a una contra
> el diseño y el ADR reescritos, incluidos los cinco bloqueantes. D7 y D8 —las dos
> decisiones nuevas— son exactamente las que faltaban: **el producto ya no puede
> crearle a su cliente un incumplimiento contable**, y nos aplicamos el rigor de
> numeración y conservación que le exigimos a él.
>
> Quedan **O-16** y **O-17**, menores, con corrección exacta escrita arriba y
> **sin tercera ronda**: se incorporan al implementar T14 (matriz de `READ_ONLY`)
> y T18 (facturación de plataforma), y el `revisor-codigo` las verifica en el PR.
>
> **Levantada la condición sobre los precios en producción:** O-9, O-10, C-5 y
> B2B-only quedan cubiertos por D8 y T18. **Firma contable: dada.**

*Re-validado por `experto-contable`, ronda 2. La retirada de `BudgetCapexLine` del
alcance (antigua D5) no tiene objeción contable: aplaza una forma canónica, no la
cambia a medias, y el fixture v1.3 queda congelado como debe.*
