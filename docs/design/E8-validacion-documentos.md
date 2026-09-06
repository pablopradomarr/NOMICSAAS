# E8 — Validación contable de «Documentos → asientos»: mapeo `docKind` → plantilla, IVA, retenciones, fechas, FX, estados e invariantes

> Rol: `experto-contable`. Valida `docs/design/E8-documentos-asientos.md` (Ronda 1, PROPUESTO) y `docs/adr/0014-estados-transaccion-fx-y-tolerancia-reconcile.md` (PROPUESTO).
> Fuentes: `docs/adr/0005-llm-solo-propone.md` (APROBADO), `docs/design/E3-asientos-tipo.md` (28 plantillas, C-1…C-13, R-IVA-1…8, §2.2 fechas), `docs/design/E6-validacion-estados.md` (formato y O-4/O-13), `lib/ledger/tax.ts`, `lib/ledger/templates/`, `prisma/schema.prisma` (`enum AccountKey`, 57 claves), `seeds/npgc.csv`, skills `pgc-npgc`, `fiabilidad`, `contabilidad-analitica`.
> Norma: **RD 1514/2007** (PGC 2007, consolidado RD 1159/2010, RD 602/2016, RD 1/2021) — **NRV 2ª, 9ª, 10ª, 11ª, 14ª, 22ª** · **Ley 37/1992 (LIVA)** arts. 4, 13, 20, 69, 70, 75, 78, 79, 84, 88, 90, 92–99, 103–110 · **RD 1624/1992 (RIVA)** arts. 63–64 · **RD 1619/2012** (facturación) arts. 4, 6, 7, 11, 15 · **Ley 35/2006 (LIRPF)** arts. 99, 107 y **RD 439/2007 (RIRPF)** arts. 75–76, 100–101 · **Código de Comercio** arts. 25–35, 37.
> **Todas las cifras son ilustrativas, en céntimos enteros, y van marcadas `(ejemplo)`.** Ninguna procede de datos reales.
> **Nota de nomenclatura:** ADR-0014 y la tarea T8 de §12.2 llaman a este entregable `docs/design/E8-validacion-extraccion.md`. El documento se ha escrito en la ruta encargada, `docs/design/E8-validacion-documentos.md` (O-22).

---

## 0. Veredicto

### **NO CONFORME**

La **arquitectura de fiabilidad es correcta y no debe tocarse**: el `ExtractionRun` inmutable, `reconcile()` puro y determinista, la revisión humana como run nuevo (D5), la puerta `FAIL ⇒ no hay asiento`, la tasa a fecha de operación con fuente única (D2) y la prohibición de que el modelo fije la deducibilidad (D4) son exactamente lo que P1, P4, P6 y P7 exigen, y resuelven G-01…G-04 sin atajos. **El defecto no está en la capa de extracción: está en la capa de mapeo contable**, que es precisamente lo que T8 debía cerrar antes de T9.

Seis defectos son **bloqueantes** porque producen asientos, libros registro o declaraciones incorrectos —no imprecisos: incorrectos— y un auditor o un inspector los rechazaría:

| # | Defecto bloqueante | Norma vulnerada |
|---|---|---|
| **O-1** | `TICKET → FACTURA_RECIBIDA` con deducibilidad por defecto `FULL`: deduce IVA de facturas simplificadas que no dan derecho a deducción, y no sabe derivar la base de un total con IVA incluido | art. 97.Uno LIVA; art. 7.2 RD 1619/2012 |
| **O-2** | El residuo de cuota se lleva a **669/769** y la cuota contabilizada es la **recalculada**, no la del documento: el libro registro de facturas recibidas deja de coincidir con la factura y el 303 se declara con una cuota que no existe en ningún documento | arts. 97, 99 LIVA; art. 64 RIVA; epígrafe 15 PyG |
| **O-3** | `PROVEEDORES_INMOVILIZADO → 523` con criterio de vencimiento **a fecha de factura** y aplicado al **total** del documento aunque tenga líneas de gasto | art. 35.1 CCom; NRV 9ª; 3ª parte PGC (523/173) |
| **O-4** | `FACTURA_RECIBIDA_ISP` como destino de todo documento extranjero sin cuota: autorrepercute IVA en importaciones y en operaciones sin inversión del sujeto pasivo | arts. 13, 18, 84.Uno.2º LIVA; casillas 10-11/12-13/32-33 del 303 |
| **O-5** | Las rectificativas no son representables: `ExtractionProposal` no lleva documento rectificado, causa ni modo (diferencias / sustitución), y `postFromProposal` no puede construir T-02/T-05 | art. 15 RD 1619/2012; C-12 de E3 |
| **O-6** | No existe **fecha de recepción**: el IVA soportado se deduce en el periodo del asiento, no en el de recepción del documento | art. 99.Tres LIVA; art. 64.1 y 64.4 RIVA |

Ninguno se corrige tocando `reconcile()`: los seis son decisiones de mapeo y dos son campos que faltan en el esquema. Aplicadas las correcciones O-1…O-12, el diseño pasa a **CONFORME CON OBSERVACIONES**. **No se escribe T9 (`postFromProposal`) hasta entonces**, tal como el propio plan de tareas establece.

**Lo que está bien y no debe reabrirse:** la puerta de `FAIL`; `IMPORTED` que carga el formulario pero nunca contabiliza; la tasa del `documentDate` con `rateDate` efectiva visible; `exchange_rates` global y append-only; el forzado que sólo existe para duplicado y `convertedTotal`, nunca para una cifra aritmética; el `sha256` como eslabón de la cadena de evidencia; y la decisión de **no** detectar automáticamente los gastos no deducibles por naturaleza.

---

## 1. Mapeo `docKind` → plantilla — respuesta a la cuestión (a) del arquitecto

### 1.1 Tabla corregida

`TEMPLATE_FOR_DOC` tal como está en §3.4 tiene tres entradas incorrectas (`TICKET`, `ANTICIPO_CLIENTE`, `ANTICIPO_PROVEEDOR`), una ambigua (`FACTURA_RECIBIDA_ISP`) y le faltan cinco `docKind`. Tabla que debe sustituirla:

| `docKind` | Plantilla | Contrapartida / matices | Origen del `docKind` |
|---|---|---|---|
| `FACTURA_RECIBIDA` | `FACTURA_RECIBIDA` (T-03) | `payableKey` por naturaleza de las líneas (§1.2). Reparto si el documento es mixto (O-3) | LLM, confirmable |
| `FACTURA_RECIBIDA_ISP` | `FACTURA_RECIBIDA_ISP` (T-04) | **Sólo** con las cuatro precondiciones de §4.2. Nunca inferido del silencio del documento | usuario / contraparte |
| `FACTURA_RECIBIDA_EXTRACOM` | `FACTURA_RECIBIDA` (T-03) con tipo `IVA_NO_SUJETO` | Bien de tercer país: base sin IVA contra 400/523. El IVA lo liquida el DUA, **no** esta plantilla | usuario / contraparte |
| `DUA_IMPORTACION` | **sin plantilla en E8** → `null` | Asiento manual T-20 documentado, o plantilla propia en **E9**. Aranceles = mayor coste (NRV 10ª/2ª); cuota del DUA a 472 contra 4750 o contra el agente de aduanas (410) | usuario |
| `ABONO_RECIBIDO` | `ABONO_RECIBIDO` (T-05) | Exige documento rectificado, causa y modo (O-5) | LLM, confirmable |
| `TICKET` | `FACTURA_RECIBIDA` (T-03) | **`payableKey` = tesorería (`BANCO_DEFAULT`/`CAJA`), no `ACREEDORES`**; `deductibility` por defecto **`NONE`** salvo ticket cualificado (O-1) | LLM, confirmable |
| `FACTURA_EMITIDA` | `FACTURA_EMITIDA_SERVICIOS` (T-01) | `VENTAS_DEFAULT` debe mapear a **705** en el segmento objetivo; 700 disponible por línea | formulario (`apps/invoices`) |
| `ABONO_EMITIDO` | `ABONO_EMITIDO` (T-02) | **Serie rectificativa propia** (O-18) | formulario |
| `FACTURA_ANTICIPO_CLIENTE` | `FACTURA_EMITIDA_SERVICIOS` (T-01) con `438` como contrapartida del ingreso | **No** T-06: T-06 mueve tesorería. La factura de anticipo no cobra (O-7) | formulario |
| `FACTURA_ANTICIPO_PROVEEDOR` | `FACTURA_RECIBIDA` (T-03) con `407` como contrapartida | Ídem, **no** T-07 | LLM, confirmable |
| `NOTA_GASTO_EMPLEADO` | `FACTURA_RECIBIDA` (T-03) con `payableKey` = `REMUNERACIONES_PENDIENTES`/tesorería | Nunca 400/410: contamina el aging de proveedores y el PMP (O-13) | usuario |
| `NOMINA`, `RECIBO_SS`, `EXTRACTO_BANCARIO` | **`null` explícito** | Cifras `computed` de terceros (P1). Un documento de nómina jamás debe caer en `TICKET`/`DESCONOCIDO` y de ahí en una plantilla de compra (O-13) | LLM (sólo para clasificar y bloquear) |
| `DESCONOCIDO` | `null` | Correcto tal como está | — |

`ANTICIPO_CLIENTE` y `ANTICIPO_PROVEEDOR` **desaparecen como `docKind` documental**: T-06/T-07 se disparan desde el movimiento bancario (E7), no desde un PDF.

### 1.2 `payableKey`: la regla es la naturaleza de la **línea**, no la del documento

| Grupo de la cuenta de la línea | Clave | Cuenta | Fundamento |
|---|---|---|---|
| 60x (600 mercaderías, 601/602, **607** trabajos realizados por otras empresas) | `PROVEEDORES` | 400 | Definición de 400 en la 3ª parte del PGC: suministradores de bienes del grupo 3 y de servicios que se incorporan al ciclo |
| 62x, 63x, 64x, 66x, 69x | `ACREEDORES` | 410 | Definición de 410: acreedores por prestaciones de servicios no incorporadas al ciclo comercial |
| **Grupo 2** (inmovilizado) | `PROVEEDORES_INMOVILIZADO` | 523 (→ 173 al cierre, O-3) | 3ª parte del PGC; la deuda por inmovilizado **no** es acreedor comercial |
| Empleado (nota de gasto) | `REMUNERACIONES_PENDIENTES` / tesorería | 465 / 57x | No es un proveedor |

**Documento mixto ⇒ se reparte el pasivo, no se etiqueta entero** (O-3).

### 1.3 `607` vs `600` / `621` / `623` — la decisión es analítica y **no es del documento**

| Naturaleza real | Cuenta | `analyticType` | Señal determinista disponible |
|---|---|---|---|
| Servicio subcontratado que se **incorpora al entregable** vendido al cliente | **607** | `COSTE_DIRECTO_MC1` | La línea lleva `projectId` y la categoría está marcada como subcontratación |
| Bien adquirido para revender / consumir en el entregable | **600** | `COSTE_DIRECTO_MC1` | Categoría de mercaderías; la organización tiene existencias |
| Servicio profesional independiente para la **estructura** (asesoría, auditoría, gestoría) | **623** | `INDIRECTO_CECO` | Línea con `costCenterId` |
| Arrendamiento y cánones | **621** | `INDIRECTO_CECO` | Contraparte con régimen de arrendador (retención 115) |
| Suministros / otros servicios de estructura | **628 / 629** | `INDIRECTO_CECO` | Categoría |

**Ninguna de estas cinco filas es deducible del texto del PDF.** Una misma factura de un freelance es 607 si su trabajo se factura al cliente y 623 si mantiene la web corporativa; la diferencia no está en el documento, está en el destino, y mueve **MC1 y MC2**. Consecuencia normativa para el diseño (O-10): `ProposalLine.accountCode` **debe salir del esquema que se pide al modelo**, igual que `deductibility` (D4). Su origen legítimo es `catalogo` (`Category.defaultAccountCode`) o `usuario`; su confianza nunca puede ser `calculado`.

---

## 2. Observaciones numeradas

### O-1 · Tickets y facturas simplificadas — **BLOQUEANTE**

**Problema.** `TICKET → FACTURA_RECIBIDA` con `payableKey = ACREEDORES` y el default `deductibility = FULL` de D4. Dos errores en un mismo camino, y es el camino más transitado de todo el producto.

1. **Deducción improcedente.** El art. 97.Uno LIVA condiciona el derecho a deducir a estar en posesión de **factura completa**. Una factura simplificada sólo permite deducir si es *cualificada* (art. 7.2 RD 1619/2012): consigna NIF y domicilio del destinatario y **la cuota repercutida de forma separada**. Un ticket de restaurante, gasolinera o parking corriente no lo hace. Con `FULL` por defecto, el ERP deduce sistemáticamente cuotas no deducibles y sobrevalora el 472 y el resultado.
2. **Contrapartida falsa.** El ticket se paga en el acto: llevarlo a 410 crea una deuda con un acreedor que nunca se pagará, ensucia el aging de 400/410 y el informe de periodo medio de pago (Ley 15/2010, Res. ICAC 29/01/2016).
3. **Base no derivable.** Un ticket casi siempre da el total con IVA incluido. RC-01 (`Σ bases = base declarada`, tolerancia 0) hace **FAIL** en todos ellos porque no hay base declarada.

**Corrección.**
- `TICKET` ⇒ `payableKey` de tesorería (`BANCO_DEFAULT`/`CAJA` según el medio de pago, campo del formulario, origen `usuario`).
- `TICKET` ⇒ `deductibility` por defecto **`NONE`**. Sólo pasa a `FULL` si el usuario marca «factura simplificada cualificada», y ese acto queda en `AuditLog`. La cuota no deducible engorda la línea de gasto (art. 103 LIVA, NRV 2ª/10ª), que es lo que `lib/ledger/tax.ts:deducible()` ya hace.
- Nuevo check **RC-17 (documento con IVA incluido)**: si `docKind = TICKET` y no hay bases declaradas, el código deriva
  `base = round_half_up(total × 10000 / (10000 + rateBps))`, `cuota = total − base`.
  La cuota es **residual por construcción**, de modo que `base + cuota = total` con **tolerancia 0** y **jamás** hay línea de redondeo. Confianza: `base` y `cuota` = `calculado`; `total` = `interpretacion_ia`.

> **Ejemplo (ejemplo).** Ticket de 12,34 € al 10 %, no cualificado, pagado con tarjeta.
> `base = round(1234 × 10000 / 11000) = 1122`; `cuota = 1234 − 1122 = 112`; deducibilidad `NONE` ⇒ `ND = 112`.
>
> | Cuenta | Debe | Haber |
> |---|---:|---:|
> | 629 Otros servicios (CECO) | **1 234** | |
> | 572 Bancos | | **1 234** |
>
> Y el mismo ticket **cualificado** (lleva NIF y cuota desglosada), deducibilidad `FULL`:
>
> | Cuenta | Debe | Haber |
> |---|---:|---:|
> | 629 Otros servicios (CECO) | **1 122** | |
> | 472 IVA soportado | **112** | |
> | 572 Bancos | | **1 234** |
>
> Lo que el diseño produce hoy: `629` 1 122 · `472` 112 · **`410` 1 234** — con deducción improcedente y una deuda inexistente.

---

### O-2 · El residuo de cuota no va a 669/769, y la cuota contabilizada es la del documento — **BLOQUEANTE**

Es la observación central sobre **ADR-0014 D3** y responde a la cuestión (b) del arquitecto.

**Lo que D3 acierta.** Que «tolerancia 0» literal es inaplicable y que un residuo **no se ignora** es correcto y hay que mantenerlo. Que la tolerancia sea **por tipo impositivo** y no por documento, también: es lo mismo que C-7 de E3 (`|Σ cuotas − Σ applyBps| ≤ 1 × nº de tipos`).

**Lo que D3 equivoca — tres cosas distintas.**

**(i) La cuota que se contabiliza en una factura recibida es la del documento, no la recalculada.** El IVA deducible es la cuota **repercutida por el proveedor** y consignada en la factura (arts. 92.Uno y 97.Uno LIVA); el libro registro de facturas recibidas (art. 64 RIVA) y las casillas 28-39 del 303 se nutren de la factura, no de nuestro recálculo. Si el proveedor redondeó a 210,01 € y nosotros anotamos 210,00 €, el libro registro **no coincide con la factura**: es una discrepancia formal que un requerimiento detecta de inmediato, y en el SII sería un error de cuadre. El recálculo de `lib/ledger/tax.ts:cuota()` es un **control de verosimilitud** que fija la confianza del campo; no es la fuente del importe.

**(ii) 669/769 es la cuenta equivocada.** 669 «Otros gastos financieros» es epígrafe **15. Gastos financieros** de la PyG. Una diferencia de cuota de IVA no tiene naturaleza financiera. Si alguna vez procede reconocer un ajuste de esta naturaleza, el PGC tiene sus cuentas: **634 «Ajustes negativos en la imposición indirecta»** y **639 «Ajustes positivos en la imposición indirecta»**, epígrafe **7.b) Tributos** — que son, además, las que E3 §6.3 ya reserva para la regularización de prorrata. Llevar sistemáticamente céntimos de IVA a 669 desplaza gasto de explotación a resultado financiero y ensucia el EBITDA del panel (E6 §8.5).

**(iii) Con la cuota del documento contabilizada, el residuo simplemente no existe.** El asiento cuadra por construcción y no hace falta ninguna línea de ajuste.

**Regla corregida (sustituye a D3, tabla «Residuo de redondeo»).**

| Comprobación | Tolerancia | Qué se contabiliza | Efecto |
|---|---|---|---|
| `Σ lines[].baseCents = base` | **0** | — | FAIL |
| **Identidad interna del documento**: `base + Σ cuotas + Σ recargos − retención − anticipo = total` | **0** | — | **FAIL**. Un documento cuyo total no cuadra con sus propias partidas incumple el art. 6 RD 1619/2012: no es rectificable con un céntimo, hay que pedir la factura corregida |
| `cuota_documento_t` vs `cuota(bases_t, rateBps, mode)` | `1` c **por tipo**, no configurable (O-16) | **la cuota del documento** | WARN informativo; el campo `taxes[t].quotaCents` queda `interpretacion_ia`, nunca `calculado` |
| Ídem, por encima de la tolerancia | — | nada | **FAIL**. Tipo mal leído o factura defectuosa |
| Residuo de **conversión** a moneda base | — | ver O-8 | Se elimina por construcción, no se contabiliza |
| Residuo de **tesorería** (cobro/pago que no salda al céntimo) | `Organization.redondeoToleranciaCents` | **669/769** vía `ajusteRedondeo()` | Es el uso legítimo y **ya existe** en T-08/T-09 de E3. Se mantiene intacto |

> **Ejemplo un tipo (ejemplo).** Base 100 000 c, IVA 21 %. Recálculo `PER_TIPO` = 21 000. La factura dice 21 001 y total 121 001.
>
> | | 62x | 472 | 669 | 400 |
> |---|---:|---:|---:|---:|
> | **Diseño actual** | 100 000 D | 21 000 D | **1 D** | 121 001 H |
> | **Corregido** | 100 000 D | **21 001 D** | — | 121 001 H |
>
> El asiento corregido cuadra igual, el libro registro coincide con la factura al céntimo y no hay un céntimo perdido en gastos financieros. Si la factura dijera 21 005 (> 1 c), **FAIL** en los dos esquemas: eso es correcto y se conserva.

> **Ejemplo varios tipos, emisor que redondeó sobre el total (ejemplo)** — la cuestión (b) literal. Bases 100 000 @ 21 % y 50 000 @ 10 %; recálculo 21 000 y 5 000; la factura dice **21 001** y **4 999**, total 176 000.
> Identidad interna: 150 000 + 21 001 + 4 999 = 176 000 ✔ con tolerancia 0 ⇒ el documento es coherente consigo mismo.
> Asiento: `62x` 150 000 D · `472` **21 001** D (`taxRateId` del 21 %) · `472` **4 999** D (`taxRateId` del 10 %) · `400` 176 000 H. Dos WARN de RC-02, ninguna línea de ajuste.
> Lo que el diseño actual haría: 21 000 y 5 000 —cuya suma coincide, así que **ni siquiera generaría el WARN**— y las casillas 28/29 y 30/31 del 303 quedarían mal desglosadas sin que nada avise. La desagregación por tipo es exactamente lo que el 303 pide, y por eso la comparación tiene que ser **por tipo** y el importe **el del documento**.

**Techo duro.** `redondeoToleranciaCents` es hoy configurable sin límite (R1 lo reconoce). Un auditor no acepta que la política de tolerancia sea un número que un ADMIN puede subir a 50. Debe existir un **máximo en código**: ≤ 2 céntimos por tipo impositivo y ≤ 5 por documento; superarlo exige ADR, no una pantalla de ajustes.

---

### O-3 · `523` vs `173` y documentos mixtos — **BLOQUEANTE** (responde a la cuestión (c))

**(i) El criterio de vencimiento está mal anclado.** ADR-0014 D6 dice «523, con 173 como largo plazo cuando el vencimiento excede el año». La clasificación corriente / no corriente se mide **desde la fecha de cierre del ejercicio**, no desde la fecha de la factura (art. 35.1 CCom; NRV 9ª y normas de elaboración de las cuentas anuales, 3ª parte del PGC).

> **Contraejemplo (ejemplo).** Factura de equipo de 2026-11-15, vencimiento 2027-11-30. Desde la factura: 12,5 meses ⇒ el diseño la lleva a **173** (pasivo no corriente). Desde el cierre de 2026: 11 meses ⇒ **corriente, 523**. El balance formulado presentaría 1 210 000 c en el pasivo no corriente que pertenecen al corriente, y el fondo de maniobra saldría inflado.

**Corrección.** En el alta se contabiliza **siempre a 523**, que es la cuenta operativa. La separación corto / largo plazo es un **asiento de reclasificación al cierre** (`523 → 173` por la parte con vencimiento > 12 meses desde la fecha de cierre, y `173 → 523` por la que se hace corriente), que pertenece a **E9** junto con el resto del cierre. Así el posteo es determinista, no depende de una fecha futura y el balance es correcto en las cuatro fotos de E6 §1.1. Con vencimientos fraccionados se reclasifica **por plazos**, no el documento entero.

**(ii) El pasivo se reparte, no se etiqueta.** §3.4 paso 3 dice «grupo 2 en alguna línea → `PROVEEDORES_INMOVILIZADO`», aplicado al total. Una factura mixta mandaría a 523 también la parte de servicios.

> **Ejemplo (ejemplo).** Equipo 1 000 000 c + mantenimiento 200 000 c, IVA 21 % = 252 000, total 1 452 000.
>
> | Cuenta | Debe | Haber |
> |---|---:|---:|
> | 217 Equipos para procesos de información | 1 000 000 | |
> | 629 Otros servicios (CECO) | 200 000 | |
> | 472 IVA soportado | 252 000 | |
> | **523** Proveedores de inmovilizado c/p | | **1 210 000** |
> | **410** Acreedores por prestaciones de servicios | | **242 000** |
>
> Reparto: base de cada bloque más **su** cuota. El diseño actual pone 1 452 000 en 523 y descoloca el cashflow entre explotación e inversión — la misma distorsión de 1 815 000 que E6 O-4/O-13 identificó, sólo que en el otro sentido. Si el reparto dejara un céntimo huérfano por prorrata, se asigna al bloque de mayor importe (criterio Hamilton de I5).

**(iii) Pendiente para E9, anotar en `ESTADO.md`:** una compra de inmovilizado con pago aplazado a más de un año sin interés explícito se registra por su **valor actual** y la diferencia es gasto financiero de los ejercicios (NRV 2ª.1 y 9ª). Umbral parametrizable; hoy no se contempla en ninguna épica.

---

### O-4 · ISP, intracomunitario e importaciones — **BLOQUEANTE** (responde a la cuestión (d))

**Problema.** `FACTURA_RECIBIDA_ISP → T-04` es hoy el destino natural de cualquier factura extranjera sin cuota repercutida. Son tres operaciones jurídicamente distintas con tres asientos distintos:

| Operación | Tratamiento correcto | ¿T-04? |
|---|---|---|
| **Adquisición intracomunitaria de bienes** (arts. 13 y 15 LIVA) con la organización en el ROI y NIF-IVA válido del proveedor | Autorrepercusión: 472 y 477 por el mismo importe, deuda al proveedor sólo por la base. Casillas 10-11 y 36-37 del 303, declaración 349 | **Sí** |
| **Servicios localizados en el TAI** prestados por un no establecido (arts. 69.Uno.1º y 84.Uno.2º.a) — incluidos proveedores de **terceros países** | Ídem | **Sí** |
| **ISP interior** (art. 84.Uno.2º.b–g: ejecuciones de obra inmobiliaria, entregas de inmuebles, chatarra, móviles y portátiles a revendedores…) | Ídem | **Sí** |
| **Importación de bienes** de tercer país (arts. 17-18 LIVA) | La factura del proveedor **no lleva IVA y no se autorrepercute**: base contra 400/523. El IVA lo liquida el **DUA** en la Aduana (472 contra 4750 o contra el agente de aduanas), y los **aranceles son mayor coste** de la mercancía o del inmovilizado (NRV 10ª y 2ª). Con diferimiento (casilla 77), 472 contra 477 | **No** |

Autorrepercutir sobre una importación **inventa** una cuota devengada (477) que no existe y una deducible (472) sin soporte, y descuadra los libros registro y el 349.

**Corrección — el `docKind` de ISP no lo decide el modelo.** Simetría estricta con D4: **si la deducibilidad no la puede fijar el LLM porque decide una cifra contable, la calificación de ISP tampoco, porque decide dos**. `FACTURA_RECIBIDA_ISP` sólo se propone automáticamente cuando concurren las **cuatro** condiciones, todas verificables por código:

1. la contraparte tiene país ≠ ES y, si es UE, **NIF-IVA validado en VIES** (guardando fecha y resultado de la consulta);
2. el documento **no** consigna cuota repercutida;
3. el documento contiene la mención legal obligatoria (art. 6.1.m RD 1619/2012: «inversión del sujeto pasivo» / *reverse charge*), leída como texto y marcada `interpretacion_ia`;
4. `Organization.roiRegistered = true` para AIB y servicios intracomunitarios.

Falta cualquiera ⇒ `docKind = DESCONOCIDO`, WARN, y el usuario elige. Y en todo caso: **el tipo de la autorrepercusión es el español que corresponda al bien o servicio**, elegido por el usuario, no el del país del emisor. Si el documento no permite determinarlo, el campo queda `no_verificado` y bloquea el lote.

**Ventas con ISP y exentas.** No hay `docKind` ni marca para la factura **emitida** con inversión del sujeto pasivo (art. 84.Uno.2º) ni para la entrega intracomunitaria exenta (art. 25 LIVA): ambas se emiten sin 477 y tienen casilla propia en el 303 (59-61, 122) y obligación de 349. El catálogo de `TaxRate` de E2 tiene los códigos exentos, pero el libro registro de facturas emitidas necesita la **clave de operación**. Añadir `ProposalTax.operationKey` (enum cerrado). Severidad **MEDIA** dentro de esta observación.

---

### O-5 · Facturas rectificativas — **BLOQUEANTE**

**Problema.** `ExtractionProposal` (§3.1) no tiene ningún campo para el documento rectificado. T-02 y T-05 de E3 exigen `rectifiesEntryId` y `reason ∈ {DEVOLUCION, DESCUENTO_POSTERIOR, RAPPEL, ERROR}` —de los que depende la **cuenta**: 708 / 706 / 709 / la propia cuenta de ingreso— y C-12 exige comparar signo a signo con las líneas del documento rectificado. `postFromProposal` §3.4 paso 4 no los mapea. **Las dos plantillas de abono son inconstruibles tal como está escrito el contrato.**

**Corrección.** Añadir a la propuesta:

```ts
rectifies?: {
  documentNumber: string          // obligatorio, art. 15.2 RD 1619/2012
  entryId?: string                // resuelto por el código contra el diario, origen `calculado`
  reason: "DEVOLUCION" | "DESCUENTO_POSTERIOR" | "RAPPEL" | "ERROR"   // origen `usuario`
  mode: "DIFERENCIAS" | "SUSTITUCION"                                  // origen `usuario`
}
```

**`mode` no es un detalle de forma: cambia el importe del asiento.** El art. 15.3 RD 1619/2012 admite las dos modalidades. En *diferencias*, el documento muestra la rectificación y se contabiliza tal cual. En *sustitución*, el documento muestra **los importes nuevos completos** y lo que hay que contabilizar es la **diferencia** contra el documento rectificado. Contabilizar los importes que se leen en una rectificativa por sustitución **duplica la operación**.

> **Ejemplo (ejemplo).** Factura original 100 000 c + 21 000. Rectificativa por sustitución que fija el nuevo importe en 80 000 + 16 800.
> Correcto (abono por la diferencia): `708` 20 000 D · `477` 4 200 D · `430` 24 200 H.
> Lo que haría el diseño actual: `708` 80 000 D · `477` 16 800 D · `430` 96 800 H — es decir, deja el ingreso en 20 000 c cuando debería quedar en 80 000.

**Dos matices más:**
- **Abonos con total negativo.** RC-13 exige `totalCents > 0` y hace FAIL a cualquier abono que llegue con signo negativo, que es como los emite la mayoría de los programas. La normalización correcta es: total negativo + `docKind = FACTURA_*` ⇒ reclasificar a `ABONO_*` con valores absolutos, marcando `docKind` como `interpretacion_ia`. La regla de fondo de RC-13 —en el diario no hay importes negativos, se invierte la columna— es correcta y se conserva.
- **Rectificativa de un ejercicio cerrado** ⇒ **T-22** (113 si es material, 678/778 si no), nunca T-05. Debe estar en la tabla de `TEMPLATE_FOR_DOC` como desvío por fecha, no como excepción implícita.

---

### O-6 · Falta la **fecha de recepción**: el IVA soportado se deduce en el periodo equivocado — **BLOQUEANTE**

**Problema.** E3 §2.2 define tres fechas —`documentDate`, `accrualDate`, `entryDate`— y E8 las hereda. Falta la cuarta, que es precisamente la que gobierna el IVA soportado. El art. 99.Tres LIVA permite deducir en la declaración del periodo en que se hayan **soportado** las cuotas —esto es, en que se está en posesión de la factura— o en los sucesivos dentro de cuatro años; el art. 64 RIVA obliga a anotar las facturas recibidas **en el periodo en que se practique la deducción** y a consignar la fecha de recepción cuando difiere.

**Consecuencia hoy.** Una factura de 2026-03-28 recibida el 2026-05-04 se registra con `accrualDate` en marzo (correcto para el gasto, NRV 14ª) y el asiento cae en marzo. El 472 entra en el saldo del **1T**, y la liquidación T-23 de E9, que lee «el saldo deudor de 472 del periodo», deduce en un trimestre en el que la organización aún no tenía la factura. Es una deducción prematura, con sus recargos.

**Corrección.**
- `ExtractionProposal.receptionDate` (origen `usuario`, default = fecha de subida del `File`, nunca del LLM) y columna `receptionDate` en `JournalEntry` junto a las que E3 O-1 ya pide.
- **El periodo de IVA de un asiento no es su `entryDate`**: es `max(receptionDate, documentDate)` normalizado a periodo de liquidación. Debe quedar escrito aquí y consumirlo T-23 en E9. Añadirlo después de tener asientos posteados obliga a reprocesar el libro registro entero.
- Nuevo check **RC-18**: `documentDate` anterior en más de cuatro años a la fecha de deducción ⇒ IVA **caducado** (art. 99.Cinco), deducibilidad forzada a `NONE` y la cuota como mayor coste; además, si el ejercicio del documento está cerrado, desvío a T-22.
- Añadir `operationDate` (fecha de operación / devengo del IVA, art. 75 LIVA) opcional, default `documentDate`: es lo que el 303 y el SII piden cuando difiere de la expedición.

---

### O-7 · Anticipos: el `docKind` documental dispara una plantilla de tesorería — **ALTA**

`ANTICIPO_CLIENTE → T-06` y `ANTICIPO_PROVEEDOR → T-07`. T-06 **carga banco** por `A + IVA` y T-07 **abona banco**: son asientos de cobro y de pago. Una *factura de anticipo* (que existe y es obligatoria, porque el anticipo devenga IVA por el art. 75.Dos LIVA) no mueve tesorería por sí misma. Con el mapeo actual, recibir una factura de anticipo genera una salida de banco que no ha ocurrido: el saldo de 572 del ERP deja de coincidir con el extracto y rompe I6 (cashflow = Δ57x) contra la realidad.

**Corrección.** Los dos `docKind` documentales desaparecen (§1.1): la factura de anticipo es una factura normal cuya contrapartida del ingreso o del gasto es **438** / **407** en lugar de 705 / 62x, y el movimiento de dinero llega por T-08/T-09 desde el banco (E7).

**Además, falta un campo.** `ExtractionProposal.appliedAdvanceCents` existe, pero T-01 necesita **también** `appliedAdvanceTaxCents` (el IVA que se repercutió con el anticipo y que hay que revertir) y la referencia al asiento del anticipo para la comprobación específica de E3 («`Aiva` = exactamente el importe repercutido en el asiento del anticipo, verificable por `sourceId`»). Sin los dos, la aplicación de un anticipo en una factura posterior deja 477 descuadrado.

---

### O-8 · Divisa: sin importe original en la línea no hay valoración al cierre — **ALTA**

**Problema de secuencia.** ADR-0014 D2 y el diseño §2.2 persisten `exchangeRateMicro`, `rateDate` y `rateSource` en `Transaction`, y difieren explícitamente a E9 tanto las diferencias de cambio (668/768) como la divisa en `journal_lines` (O-6 de E3). Pero **E8 es la épica que crea deudas y créditos en divisa**. La NRV 11ª.2.1 obliga a valorar las partidas monetarias en moneda extranjera al **tipo de cierre** y a llevar la diferencia a 668/768 del ejercicio. Si la línea de 400/430 no guarda ni la moneda ni el importe original, esa valoración **no es computable desde el diario**, que es la fuente única (ADR-0003): habría que reconstruirla desde `Transaction`, es decir, desde el documento — exactamente lo que ADR-0003 prohíbe.

> **Ejemplo (ejemplo).** Factura de 10 000,00 USD a 2026-11-20, tasa 1,08 ⇒ 400 por 925 926 c. A 31-12-2026, tasa 1,05 ⇒ 952 381 c. Diferencia negativa **26 455 c** a 668 contra 400. Con el diseño actual no hay ninguna consulta sobre `journal_lines` que la produzca.

**Corrección — una de las dos, no un término medio:**
- **(a)** Adelantar a E8 las tres columnas de E3 O-6 (`originalCurrency`, `originalAmountCents`, `exchangeRateId`) en `JournalLine`, aunque el motor que las consume sea de E9. Es lo barato ahora y lo caro después de tener asientos.
- **(b)** Si no, **E8 no debe admitir documentos en moneda distinta de la base**, y la conversión se activa en E9 con su motor.

Enviar la conversión sin la trazabilidad en la línea es la «deuda con forma de esquema» que el propio §13 dice evitar, sólo que en sentido inverso.

**Residuo de conversión.** §3.5 convierte línea a línea, vuelve a pasar por `reconcile` y manda el residuo a 669/769. En el reconocimiento inicial **no hay diferencia de cambio** (NRV 11ª: se registra al tipo de contado de la fecha de la operación): lo que hay es un residuo de reparto, y se elimina por construcción, no se contabiliza:

```
payable_EUR   = convert(total_divisa)                       // lo que se debe, al céntimo
base_i_EUR    = convert(base_i_divisa)
cuota_t_EUR   = payable_EUR − Σ base_i_EUR  repartido entre tipos por mayor resto (Hamilton, I5)
```

Cero residuo, cero línea de 669, y el drill-down sigue mostrando bases que corresponden a líneas del documento. Si aun así se quisiera reconocer un residuo de conversión, su cuenta sería **668/768**, nunca 669/769.

**Matiz fiscal a declarar, no a unificar.** La base imponible en euros de una AIB o de una importación se determina con el tipo de cambio del art. 79.Once LIVA (último publicado por el BCE a la fecha de devengo), que puede diferir en céntimos del contable. Dejarlo como WARN informativo y documentado; intentar unificar ambos criterios sería peor.

---

### O-9 · `Transaction.status`: sin salida de `VOID` y con el documento partido — **ALTA**

**(i) Callejón sin salida.** D1 prohíbe `VOID → cualquier cosa` por trigger. El flujo más común de corrección en un despacho es *anular y rehacer*: se anula el asiento con contra-asiento y se vuelve a contabilizar el documento corregido. Con la regla actual, la operación queda muerta en `VOID` y la única salida es volver a subir el fichero — lo que además choca con RC-12, que detectará el `sha256` duplicado y exigirá un forzado con motivo. **Debe existir la transición `VOID → PROPOSED → POSTED`** con un nuevo `journalEntryId` (conservando el anterior en un `voidedEntryId`), o bien la regla explícita «la re-contabilización crea una `Transaction` nueva enlazada por `supersedesTransactionId`». Cualquiera de las dos sirve; el silencio no.

**(ii) El `CHECK` de D1 está mal formado.** El texto del ADR dice `CHECK ((status = 'POSTED') = (journal_entry_id IS NOT NULL) OR status = 'VOID')`: por precedencia de operadores, cualquier fila con `status = 'VOID'` satisface el predicado, incluida una con `journal_entry_id IS NULL`, que es justo lo que D1 quiere impedir. El `CHECK` escrito en el diseño §2.3 paso 4 sí es correcto y completo. **Corregir el texto del ADR** para que ambos digan lo mismo; una divergencia entre ADR y migración es el origen clásico de un invariante que nadie implementa.

**(iii) `journalEntryId` singular contra el split.** §4.3 ofrece `splitProposalAction`: N propuestas sobre el mismo `fileId`. Si esas N propuestas cuelgan de una sola `Transaction`, `POSTED ⟺ journal_entry_id IS NOT NULL` es indefendible (¿cuál de los N?) y I-E8-4 fallaría o mentiría. Debe quedar escrito que **el split crea N `Transaction`**, una por asiento, todas apuntando al mismo `File` y al mismo `sha256`, y que RC-12 no las cuenta como duplicados entre sí.

**(iv) `PROPOSED` puede mentir.** Se define como «existe al menos un run con `reconcileStatus ∈ {PASS, WARN}`» pero sólo lo escribe la aplicación y nada lo revalida si un run posterior sale FAIL. O se le da invariante propio, o se documenta como estado meramente indicativo de bandeja. Severidad BAJA dentro de la observación.

**Lo que sí está bien:** conservar `journal_entry_id` en `VOID`, prohibir `POSTED → DRAFT|PROPOSED`, y que `status` no entre en ningún informe. Es coherente con el principio 6 y con ADR-0003.

---

### O-10 · La cuenta contable y el destino analítico los propone el modelo — **ALTA**

`ProposalLine.accountCode`, `projectId` y `costCenterId` están en el esquema que el modelo rellena. D4 sacó la deducibilidad del esquema con el argumento correcto —«una cifra contable nacería de un modelo»—; el argumento se aplica igual o más aquí: **la cuenta decide el epígrafe de la PyG y el `analyticType`, y con él MC1, MC2 y MC3** (§1.3). Que un modelo elija entre 607 y 623 es que un modelo decide el margen de contribución de un proyecto.

**Corrección.** Sacar `accountCode`, `projectId` y `costCenterId` de `ai/schemas/extraction.v1.json`. Sus orígenes legítimos son `catalogo` (`Category.defaultAccountCode`, ya previsto) y `usuario`. Confianza máxima `interpretacion_ia` cuando vienen de catálogo por coincidencia de proveedor; nunca `calculado`. Lo que el modelo sí puede aportar es la **descripción** y el nombre del proveedor, que es lo que alimenta la sugerencia de categoría por reglas deterministas del catálogo.

---

### O-11 · Retención de IRPF: la fija el régimen de la contraparte, no el documento — **ALTA**

`ExtractionProposal.withholding` viene del modelo, leído del PDF. La retención no es una característica del documento: es una **obligación del pagador** (arts. 99 y 101 LIRPF, art. 76 RIRPF). Si un profesional emite su factura sin consignar la retención, la sociedad sigue obligada a retener e ingresar, y responde de la deuda aunque no la haya practicado (art. 107 LIRPF).

**Corrección.**
- El tipo aplicable sale de `Counterparty` (`withholdingRateCode` según régimen: profesional 15 % / 7 % de inicio de actividad, arrendador 19 %, actividades agrícolas, módulos 1 %), y la clave de cuenta se deriva del `TaxKind`/subtipo del `TaxRate`: **4751 vía `IRPF_PROFESIONALES_A_PAGAR`** (modelo 111) o **`IRPF_ALQUILERES_A_PAGAR`** (modelo 115). Nunca de una lectura del PDF.
- Lo leído por el modelo se usa **sólo para contrastar**. Nuevo check **RC-19**: leído ≠ configurado, o configurado y ausente en el documento ⇒ **WARN bloqueante para el lote**, y el asiento se construye con el **configurado**. En el mensaje: «esta factura debería llevar retención del 15 %; solicite factura rectificada».
- Simétricamente, en facturas **emitidas** la retención soportada (473) depende de nuestro propio régimen y del carácter empresarial del cliente, y viene del formulario, no de un documento. Ya es así por construcción (`provider = "formulario"`), pero conviene dejarlo escrito.

> **Ejemplo (ejemplo).** Factura de abogado: base 100 000 c, IVA 21 000, sin mención de retención; contraparte configurada como profesional al 15 %.
> Diseño actual: `623` 100 000 D · `472` 21 000 D · `410` 121 000 H → la sociedad no retiene, no declara en el 111 y asume la deuda.
> Correcto: `623` 100 000 D · `472` 21 000 D · `410` **106 000** H · `4751` **15 000** H, con WARN.

---

### O-12 · Suplidos y líneas no sujetas — **ALTA**

`ProposalLine` obliga a `taxRateCode` y a `baseCents ≥ 1`: **todo importe del documento es base imponible**. Los suplidos (art. 78.Tres.3º LIVA: sumas pagadas en nombre y por cuenta del cliente, con mandato expreso y justificante a nombre de éste) **no forman parte de la base imponible** y no llevan IVA; tampoco pueden entrar en la base de cálculo de la retención de IRPF. Hoy no hay forma de representarlos: si se meten al 21 % descuadra el total, y si se meten como exentos inflan base y retención.

**Corrección.** `ProposalLine.kind: "OPERACION" | "SUPLIDO" | "NO_SUJETO"`, excluido de `Σ bases` en RC-01, de la base de RC-02 y de la base de la retención, e **incluido** en el total de RC-03.

> **Ejemplo (ejemplo).** Factura de abogado: honorarios 100 000 c, IVA 21 000, suplido (tasa judicial) 30 000 c, retención 15 % **sobre 100 000** = 15 000. Total factura 136 000.
>
> | Cuenta | Debe | Haber |
> |---|---:|---:|
> | 623 Servicios de profesionales independientes | 100 000 | |
> | 631 Otros tributos (tasa judicial, suplido) | 30 000 | |
> | 472 IVA soportado | 21 000 | |
> | 410 Acreedores | | 136 000 |
> | 4751 HP acreedora por retenciones | | 15 000 |
>
> Con el esquema actual, la retención se calcularía sobre 130 000 (= 19 500) y el total no cuadraría: **RC-03 FAIL** en una factura perfectamente correcta.

---

### O-13 · Gastos de personal, notas de gasto y nóminas — **MEDIA**

- Una **nota de gasto de un empleado** no es una factura de proveedor. Enrutarla a 400/410 contamina el aging comercial y el periodo medio de pago, cuyo cálculo (Res. ICAC 29/01/2016) sólo comprende operaciones comerciales con proveedores. Contrapartida: 465 si se reembolsa con la nómina, tesorería si se reembolsa directamente. Y el IVA sólo es deducible si la factura está **a nombre de la sociedad**: por defecto `NONE`, con el mismo criterio de O-1.
- Un **autónomo dependiente** sigue siendo 623/607 con retención, nunca 640: 640 es relación laboral.
- Una **nómina** o un **RLC/RNT** nunca deben llegar a una plantilla de compra. `TEMPLATE_FOR_DOC` debe devolver `null` explícito para esos `docKind` (§1.1) y el esquema del modelo debe rechazar `accountCode` del subgrupo 64: sus importes son `computed` del proveedor de nóminas y sólo entran por T-10 (P1, y así lo dice E3).

---

### O-14 · El tipo impositivo se selecciona por fecha de **devengo**, no de expedición — **MEDIA**

RC-06 (y C-10 de E3) seleccionan el `TaxRate` vigente a `documentDate`. El art. 90.Dos LIVA es explícito: el tipo aplicable es el **vigente en el momento del devengo**. Coinciden casi siempre, pero no en una factura expedida en el plazo del art. 11 RD 1619/2012 (hasta el día 16 del mes siguiente) que cruce un cambio de tipo — algo que ha ocurrido tres veces desde 2022 con la energía y los alimentos.

**Corrección.** `selectRate(..., operationDate ?? accrualDate ?? documentDate, side)`. Afecta también a C-10 de E3, así que **es una observación de coherencia entre épicas**: no se cambia unilateralmente en E8, se anota para que E3 y E8 lo apliquen a la vez y los fixtures de E3 —que son inmutables— no se vean afectados (en ellos las tres fechas coinciden, luego el resultado no cambia).

---

### O-15 · Descuentos y bases negativas — **MEDIA**

`ProposalLine.baseCents` se declara «entero, ≥ 1». Una factura con línea de descuento comercial (`−50,00 €`) es corriente y R-IVA-8 de E3 ya dice que el descuento **en factura minora la base** y no genera abono a 706/709. Con la restricción actual, esas facturas fallan RC-01 o se contabilizan con la base bruta.

**Corrección.** O bien `discountCents` por línea (que el código resta antes de agrupar por tipo), o permitir `baseCents` negativo **en la propuesta** —nunca en la línea del asiento, donde C-2 lo sigue prohibiendo— y normalizarlo en `reconcile`. La primera es más limpia y conserva el drill-down al concepto del documento.

---

### O-16 · Una tolerancia para dos riesgos distintos — **MEDIA**

`Organization.redondeoToleranciaCents` gobierna hoy el ajuste de tesorería de T-08/T-09 (donde 669/769 es correcto) y, según D3, también el residuo de cuota de IVA (donde no lo es, O-2). Son riesgos distintos con destinatarios distintos. Separar:

| Parámetro | Ámbito | Valor | Configurable |
|---|---|---|---|
| `toleranciaCuotaIvaCents` | RC-02, **por tipo impositivo** | 1 | **No** (constante del motor; cambiarla exige ADR) |
| `redondeoToleranciaCents` | T-08/T-09, ajuste de tesorería a 669/769 | 1 por defecto | Sí, con techo duro de 5 c y `AuditLog` |

---

### O-17 · Deducibilidad por defecto `FULL` — **MEDIA**

D4 fija `FULL` salvo prorrata configurada, y deja los gastos del art. 96 LIVA (atenciones a clientes, joyas, espectáculos, alimentación y hostelería no deducibles en IRPF/IS) al criterio humano. La decisión de **no automatizarlo es correcta**, pero el default `FULL` significa que el camino silencioso —confirmar por lote sin mirar— deduce. Añadir un tercer valor de configuración por cuenta o categoría: `deducibilidadPorDefecto: FULL | NONE | REQUIERE_DECISION`. Con `REQUIERE_DECISION` (restauración, hostelería, atenciones, combustible de turismos —donde además opera la presunción del 50 % del art. 95.Tres.2ª—), el campo nace `no_verificado` y **bloquea el lote**, que es exactamente el efecto que RC-15 ya sabe producir para la prorrata. Coste: una columna y una fila en el seed de categorías.

---

### O-18 · Series de facturación emitida — **MEDIA**

`InvoiceSeries` resuelve la numeración correlativa con `FOR UPDATE`, que es lo correcto (art. 6.1.a y 11 RD 1619/2012). Faltan tres cosas que la norma exige:

1. **`kind: ORDINARIA | RECTIFICATIVA | SIMPLIFICADA`**. El art. 15.4 obliga a que las rectificativas lleven **serie especial** y numeración propia. Hoy `ABONO_EMITIDO` tomaría número de la serie ordinaria.
2. **Regla de no huecos y de fecha no decreciente** dentro de la serie, con su invariante y su listado en Auditoría. Un hueco en la numeración de facturas emitidas es una anomalía que un inspector pregunta.
3. **Una factura emitida no se borra ni se renumera**: se rectifica. Debe estar escrito junto a la serie, no sólo en la regla general de asientos.

---

### O-19 · Invariantes I-E8-* — **ALTA en I-E8-7, MEDIA en el resto**

**Los que están bien:** I-E8-1 (nunca un asiento sobre un run FAIL o IMPORTED), I-E8-2 (integridad del binario), I-E8-3 (inmutabilidad), I-E8-6 (reproducibilidad byte a byte), I-E8-8 (reconstrucción del asiento línea a línea), I-E8-9, I-E8-12 y I-E8-14. Son correctos, computables y con tolerancia 0. I-E8-8 es, además, el mejor invariante de toda la épica: es el que hace la extracción auditable.

**Los que hay que corregir:**

| ID | Problema | Corrección |
|---|---|---|
| **I-E8-7** | Enuncia el residuo «contabilizado en 669/769» y su tolerancia depende de un parámetro configurable: **no es un invariante de tolerancia 0**, es una política disfrazada | Reformular en dos: **I-E8-7a** identidad `Σ bases + Σ cuotas + recargos − retención − anticipo = total`, **tolerancia 0** sobre las cifras contabilizadas (se cumple por construcción con la corrección de O-2); **I-E8-7b** métrica de calidad, no invariante: número de documentos con discrepancia de recálculo, con su WARN de Auditoría |
| **I-E8-13** | Sólo cubre el duplicado por `sha256`. El duplicado peligroso es el **mismo número de factura del mismo proveedor** llegado por dos vías (email y subida manual), con bytes distintos | Extender a `(counterparty.taxId, documentNumber, ejercicio)` para `docKind` de compra. Es el vector clásico de doble pago y de doble deducción |
| **I-E8-4** | No contempla la salida de `VOID` (O-9) ni el split N-a-1 | Reformular tras resolver O-9 |
| **I-E8-5** | Correcto, pero irrelevante si la línea no guarda la divisa (O-8) | Depende de O-8 |

**Los que faltan y un auditor pedirá:**

| ID nuevo | Enunciado | Tolerancia |
|---|---|---|
| **I-E8-15** | Puente al 303: `Σ 472` de los asientos cuyo periodo de IVA (O-6) cae en el trimestre = `Σ` cuotas soportadas del libro registro del trimestre; ídem `477` con el de emitidas | 0 |
| **I-E8-16** | Ningún asiento con línea de 472 cuya fecha de deducción diste más de 4 años de `documentDate` (art. 99.Cinco LIVA) | 0 |
| **I-E8-17** | Puente al 111/115: `Σ` retenciones practicadas del trimestre = `Σ` abonos a 4751 por `taxRateId`, agrupado por modelo | 0 |
| **I-E8-18** | Toda factura recibida con `docKind` ISP tiene **exactamente dos** líneas de IVA del mismo `taxRateId` y el devengado es íntegro (la prorrata sólo minora el deducible) | 0 |
| **I-E8-19** | Toda `Transaction` en moneda ≠ base tiene sus tres columnas de tasa **y** sus líneas de 400/430 llevan `originalCurrency`/`originalAmountCents` (condicionado a O-8) | 0 |

---

### O-20 · Confianza por campo (P6) — **MEDIA**

La tabla de asignación de §3.3 es determinista y correcta en su estructura. Tres correcciones:

1. **Falta el nivel «verificado».** La skill `fiabilidad` distingue `calculado` de `✓ comprobado automáticamente`; el diseño colapsa los dos en `calculado`. Con la corrección de O-2, la cuota **se lee** del documento y **se comprueba** contra el recálculo: no es `calculado` (no la produjo el código) ni merece el mismo trato que un número sin contrastar. Añadir **`verificado`** = «leído del documento y coincidente con el recálculo determinista». Es la distinción que un auditor busca primero.
2. **NIF/CIF.** RC-11 deja la contraparte en `no_verificado` si no hay coincidencia en el maestro. Pero el **dígito de control** de un NIF (módulo 23) y la letra de un CIF son verificaciones deterministas: un NIF con letra correcta y coincidencia en el maestro es `verificado`; con letra correcta sin coincidencia, `interpretacion_ia`; con letra incorrecta, **FAIL**, no WARN — una factura con NIF inválido no es deducible (art. 6.1.c RD 1619/2012).
3. **Extracción parcial.** RC-09 impide que un campo sea `calculado` pero permite confirmar el documento individualmente. Si el modelo vio 4 de 9 páginas, el total puede estar en la 9ª: la propuesta no es incompleta, es **potencialmente falsa**. Endurecer: **ningún asiento puede referenciar un run `partial` de `kind = LLM`**. Para contabilizarlo, un humano teclea el total y la confirmación crea el run `MANUAL` de D5 con `totalCents` de origen `usuario`. Es comprobable en SQL y refuerza I-E8-10.

---

### O-21 · Regímenes especiales no declarados — **BAJA**

Ni el diseño ni el ADR dicen qué pasa con una organización en **criterio de caja (RECC**, arts. 163 decies y ss. LIVA), donde devengo y deducción siguen al cobro y al pago, ni con el **REDEME**, ni con el recargo de equivalencia **como destinatario**. Con RECC, todo el circuito de E8 —472/477 a la fecha de la factura— es incorrecto. No hay que implementarlo: hay que **declararlo**. Propuesta: `Organization.ivaRegime: GENERAL | RECC | …`; con cualquier valor distinto de `GENERAL`, la contabilización automática se **bloquea** con mensaje explícito y remisión a E9. Un producto que no dice qué no soporta es peor que uno que no lo soporta.

*(El recargo de equivalencia como emisor sí está resuelto: `surchargeRateCode` en la línea y línea propia de 477 con el `taxRateId` del recargo, tal como T-01 lo especifica. Sólo falta que el recargo se aplique en función del **régimen del cliente** registrado en `Counterparty`, no de lo que diga el documento.)*

---

### O-22 · Nombre del entregable — **BAJA**

ADR-0014 (cabecera) y T8 de §12.2 apuntan a `docs/design/E8-validacion-extraccion.md`; el encargo y este documento usan `docs/design/E8-validacion-documentos.md`. Unificar en la ronda 2 —preferiblemente al nombre de este fichero, que describe el alcance real (documentos → asientos, no sólo la extracción)— y actualizar las dos referencias.

---

## 3. Resumen de severidades

| Severidad | Observaciones | Efecto si no se corrigen |
|---|---|---|
| **BLOQUEANTE** | O-1, O-2, O-3, O-4, O-5, O-6 | Deducciones improcedentes, libro registro que no coincide con las facturas, balance mal clasificado, autorrepercusiones inventadas, rectificativas inconstruibles o duplicadas, IVA deducido en el trimestre equivocado |
| **ALTA** | O-7, O-8, O-9, O-10, O-11, O-12, O-19 (I-E8-7) | Tesorería ficticia, imposibilidad de valorar al cierre desde el diario, flujo de corrección sin salida, márgenes decididos por el modelo, retenciones no practicadas, bases infladas por suplidos, un invariante que no lo es |
| **MEDIA** | O-13, O-14, O-15, O-16, O-17, O-18, O-19 (resto), O-20 | Aging y PMP contaminados, tipo erróneo en cambios de tipo, facturas normales rechazadas, tolerancia sin techo, deducción silenciosa, series no conformes, invariantes insuficientes, confianza imprecisa |
| **BAJA** | O-21, O-22 | Regímenes especiales sin declarar; referencia cruzada divergente |

---

## 4. Respuestas directas a las cuatro cuestiones de §11

| # | Cuestión | Respuesta |
|---|---|---|
| **(a)** | `docKind → plantilla`; 607 vs 600/621 | Tabla corregida en **§1.1**; `payableKey` por naturaleza de la línea en **§1.2**; tabla de decisión 607/600/621/623/628 en **§1.3**. **607 vs 623 no es una lectura del documento**: es el destino (proyecto vs estructura) y por eso `accountCode` debe salir del esquema del LLM (**O-10**) y venir de `Category.defaultAccountCode` o del usuario |
| **(b)** | Residuo con varios tipos y emisor que redondeó sobre el total | **O-2**. Se contabiliza **la cuota del documento**; el recálculo fija la confianza, no el importe. Tolerancia 1 c **por tipo**, no configurable, con techo duro. La identidad interna del documento se comprueba con **tolerancia 0**: si no cuadra, el documento es defectuoso y se rechaza, no se ajusta. Si alguna vez procede reconocer el ajuste, es **634/639**, nunca 669/769. 669/769 se reserva al redondeo de **tesorería** (T-08/T-09), 668/768 a las diferencias de cambio |
| **(c)** | 523 vs 173 | **O-3**. Siempre **523** en el alta; la separación corriente / no corriente se mide **desde la fecha de cierre** (art. 35.1 CCom) y se resuelve con un **asiento de reclasificación al cierre** en E9. Además, en documentos mixtos el pasivo se **reparte** entre 523 y 400/410 por bloques, cada uno con su cuota |
| **(d)** | Terceros países e intracomunitario cuando el documento no lo declara | **O-4**. **Nunca se infiere.** ISP sólo con las cuatro precondiciones verificables (país / VIES, ausencia de cuota, mención legal del art. 6.1.m, ROI). **Importación ≠ ISP**: la factura del proveedor va sin IVA y la cuota la liquida el DUA, con los aranceles como mayor coste. Si falta cualquier condición ⇒ `DESCONOCIDO` + WARN y decide el usuario. El tipo de la autorrepercusión es el **español** del bien o servicio, elegido por el usuario |

---

## 5. Qué hay que hacer antes de escribir T9

1. Corregir `TEMPLATE_FOR_DOC` con la tabla de §1.1 y la regla de `payableKey` de §1.2.
2. Reescribir **ADR-0014 D3** con la regla de O-2 (cuota del documento; 634/639 si acaso; 669/769 sólo tesorería; tolerancia no configurable con techo).
3. Reescribir **ADR-0014 D6** con el criterio de 523/173 de O-3 (reclasificación al cierre, reparto en mixtos).
4. Añadir a `ExtractionProposal`: `receptionDate`, `operationDate?`, `rectifies{documentNumber, reason, mode}`, `line.kind` (suplido / no sujeto), `appliedAdvanceTaxCents`, `discountCents`; y **quitar** `accountCode`, `projectId`, `costCenterId` del esquema que se pide al modelo.
5. Decidir O-8: o las tres columnas de divisa en `JournalLine` entran en E8, o E8 no admite moneda extranjera.
6. Resolver la salida de `VOID` y corregir el `CHECK` del texto del ADR (O-9).
7. Reformular I-E8-7 y añadir I-E8-15…19.
8. Sellar `docs/design/fixtures/extraccion-esperada.json` con **al menos** estos casos, además de los seis previstos: ticket no cualificado con IVA incluido · factura con dos tipos y cuota del emisor desviada 1 c en cada uno · factura mixta inmovilizado + servicio · rectificativa por sustitución · factura de profesional sin mención de retención · factura con suplido · factura de importación de tercer país.

Los ocho puntos son de mapeo y de esquema; ninguno toca la arquitectura de `reconcile()`, que es la parte que este documento **confirma como conforme**.

---

# Ronda 2 — Re-validación

> Fecha: 2026-09-06 · Revisado: `docs/design/E8-documentos-asientos.md` (ronda 2, 880 líneas) y `docs/adr/0014-estados-transaccion-fx-y-tolerancia-reconcile.md` (ronda 2, D1…D12).
> Método: observación por observación, contrastando el texto nuevo contra la norma citada en la ronda 1, no contra el resumen del arquitecto.

## R2.1 · Estado de las 22 observaciones

| # | Severidad R1 | Corrección aplicada | Estado |
|---|---|---|---|
| **O-1** | BLOQUEANTE | D9 + RC-17: tesorería por `paymentKey`, `deductibility = NONE` salvo cualificada con `AuditLog`, base derivada `round_half_up(total × 10000/(10000+bps))` y cuota **residual** ⇒ `base + cuota = total` con tolerancia 0 | **CERRADA** |
| **O-2** | BLOQUEANTE | D3 + RC-02 + paso 4 de `postFromProposal`: se contabiliza la cuota del documento vía `taxOverrides[]`, `checkDraft` verifica `≤ 1 c` por tipo, desaparece la línea de 669/769 por IVA, 634/639 declarado como cuenta correcta de un eventual ajuste de imposición indirecta, 669/769 reservado a tesorería y 668/768 a cambio | **CERRADA** |
| **O-3** | BLOQUEANTE | D6: 523 siempre en el alta, criterio corriente/no corriente **desde el cierre** (art. 35.1 CCom), reclasificación 523↔173 por plazos en E9 anotada en `ESTADO.md`, y `payableBlocks[]` repartiendo base + su cuota con el céntimo huérfano al bloque mayor. Añadido además el valor actual del aplazamiento largo (NRV 2ª.1/9ª) para E9 | **CERRADA** |
| **O-4** | BLOQUEANTE | D11 + RC-22: cuatro precondiciones verificables con VIES persistido, `FACTURA_RECIBIDA_EXTRACOM` y `DUA_IMPORTACION` como `docKind` propios, tipo de autorrepercusión español elegido por el usuario, `ProposalTax.operationKey` para el libro registro y el 349 | **CERRADA** |
| **O-5** | BLOQUEANTE | D12 + RC-21 + paso 6: `rectifies{documentNumber, entryId?, reason, mode}`, **`SUSTITUCION` contabiliza la diferencia** contra `ctx.rectifiedEntry`, abonos con total negativo normalizados, rectificativa de ejercicio cerrado desviada a T-22 en la propia tabla de plantillas | **CERRADA** |
| **O-6** | BLOQUEANTE | D8 + RC-18: `receptionDate` en propuesta y en `JournalEntry` con origen `usuario`, **periodo de IVA = `max(receptionDate, documentDate)`** consumido por T-23 en E9, `operationDate` opcional y caducidad de cuatro años | **CERRADA** |
| **O-7** | ALTA | Los `docKind` de anticipo documental desaparecen; factura de anticipo contra 438/407; `appliedAdvanceTaxCents` + `advanceEntryId` + RC-23 | **CERRADA con residuo** → R2.2 **O-23** |
| **O-8** | ALTA | Opción (a): `originalCurrency`, `originalAmountCents`, `exchangeRateId` en `JournalLine`, inmutables y fuera del `GRANT UPDATE` de ADR-0010; `hashVersion = 3` con convivencia y `ledgerHash` financiero inalterado; residuo de conversión eliminado por Hamilton | **CERRADA** |
| **O-9** | ALTA | D1: `CHECK` reescrito, `VOID ⟺ journal_entry_id IS NULL AND voided_entry_id IS NOT NULL` con `voidedEntryIds[]` append-only, transición `VOID → PROPOSED → POSTED`, split con N `Transaction` y `splitParentTransactionId`; I-E8-4 reformulado en consecuencia | **CERRADA** |
| **O-10** | ALTA | D11 + §3.1: `accountCode`, `projectId` y `costCenterId` fuera del schema del modelo; origen `catalogo`/`usuario`; confianza máxima `interpretacion_ia` | **CERRADA** |
| **O-11** | ALTA | D11 + RC-19 + paso 5: `Counterparty.withholdingRegime`/`withholdingRateCode`, clave de cuenta por `TaxKind` (111 vs 115), base sin suplidos, WARN bloqueante y sello `RETENCION_NO_PRACTICADA` | **CERRADA** |
| **O-12** | ALTA | D10 + `ProposalLine.kind` + RC-20: suplidos y no sujetos fuera de `Σ bases`, de la base de la cuota y **de la base de la retención**, dentro del total | **CERRADA** |
| **O-13** | MEDIA | `NOMINA`/`RECIBO_SS`/`EXTRACTO_BANCARIO` → `null` explícito; `NOTA_GASTO_EMPLEADO` contra 465/tesorería; RC-07 rechaza el subgrupo 64 y `Category.defaultAccountCode` lleva `CHECK` que lo impide | **CERRADA** |
| **O-14** | MEDIA | RC-06 y `selectRate` por `operationDate ?? accrualDate ?? documentDate`, aplicado **en la misma tarea** a C-10 de E3; fixtures intactos porque en ellos las tres fechas coinciden | **CERRADA** |
| **O-15** | MEDIA | `discountCents` por línea, minorando la base antes de agrupar por tipo, sin generar abono a 706/709 (R-IVA-8) | **CERRADA** |
| **O-16** | MEDIA | `TOLERANCIA_CUOTA_IVA_CENTS = 1` constante del motor con test que falla si aparece en `Setting`; `redondeoToleranciaCents` con `CHECK BETWEEN 0 AND 5` | **CERRADA** |
| **O-17** | MEDIA | `Category.defaultDeductibility ∈ {FULL, NONE, REQUIERE_DECISION}` sembrado en las categorías del art. 96 LIVA y del art. 95.Tres.2ª; RC-15 lo hace WARN bloqueante | **CERRADA** |
| **O-18** | MEDIA | `InvoiceSeries.kind` con serie rectificativa propia (art. 15.4), I-E8-20 de numeración sin huecos y fecha no decreciente, y la prohibición de borrar o renumerar escrita junto a la serie | **CERRADA** |
| **O-19** | ALTA/MEDIA | I-E8-7 partido en **7a** (tolerancia 0, se cumple por construcción) y **7b** (métrica de calidad); I-E8-13 extendido a `(taxId, nº, ejercicio)`; I-E8-4 reformulado; I-E8-15…20 nuevos; `ReconcileCheck.blocksBatch` explícito | **CERRADA con residuo** → R2.2 **O-24** |
| **O-20** | MEDIA | Cuarto nivel `verificado`; NIF con dígito de control; ningún asiento sobre run `partial` de `kind = LLM` (RC-09 FAIL + I-E8-1 + I-E8-10 + puerta 1 de `postFromProposal`) | **CERRADA con residuo** → R2.2 **O-25** |
| **O-21** | BAJA | `Organization.ivaRegime` + RC-24 bloqueante + sello `REGIMEN_NO_SOPORTADO` + remisión a E9; recargo de equivalencia por régimen del cliente | **CERRADA** |
| **O-22** | BAJA | Referencias unificadas en `docs/design/E8-validacion-documentos.md` | **CERRADA** |

**22 de 22 cerradas en lo sustancial.** Las tres correcciones que peor podían salir —la cuota del documento, el reparto del pasivo en documentos mixtos y el modo de las rectificativas— están resueltas con el detalle exacto y con su ejemplo en céntimos en los criterios de aceptación. La decisión de aplicar O-14 **a la vez** en E3 y en E8, en lugar de parchear sólo E8, es la correcta: evita que C-10 y RC-06 seleccionen tipos distintos para el mismo documento.

## R2.2 · Tres residuos menores, con su corrección exacta

### O-23 · El IVA del anticipo de cliente devenga **al cobro**, no al expedir la factura — MEDIA

`FACTURA_ANTICIPO_CLIENTE → T-01` con 438 como contrapartida del ingreso emite la línea de 477 con la fecha de la factura. El art. 75.Dos LIVA es literal: en los pagos anticipados el impuesto se devenga *«en el momento del cobro total o parcial del precio por los importes efectivamente percibidos»*. Una factura de anticipo expedida antes de cobrar **no devenga IVA**, y emitir 477 en ese momento anticipa el ingreso a Hacienda y descuadra la casilla 01-03 del 303 del trimestre.

**Corrección (una línea de check).** Nuevo **RC-25**: `docKind = FACTURA_ANTICIPO_CLIENTE` exige `advanceEntryId` —el cobro ya registrado— o un `dueSchedule` con cobro efectivo. Sin cobro ⇒ **WARN bloqueante**: se contabiliza `430` contra `438` **sin línea de 477**, y el devengo del IVA se produce con T-08 al cobrar. Con cobro ⇒ el asiento actual es correcto. En el caso normal —la factura de anticipo se expide *porque* se ha cobrado— no cambia nada.

### O-24 · I-E8-15 fallaría en cuanto hay IVA no deducible — MEDIA

`Σ 472 del trimestre = Σ cuotas soportadas del libro registro`, con **tolerancia 0**. La cuota no deducible **no pasa por 472**: engorda la línea de gasto o de inmovilizado (art. 103 LIVA, NRV 2ª/10ª), que es lo que `deducible()` ya hace. Con prorrata, con `deductibility = NONE` o con un solo ticket no cualificado —que tras D9 es **el caso por defecto**—, el invariante daría FAIL sobre datos correctos y sellaría `REQUIERE REVISIÓN` cada trimestre. Un invariante que falla siempre se acaba desactivando, y con él se pierde el puente al 303.

**Corrección (reformulación, sin código nuevo).**

```
I-E8-15a:  Σ 472 del periodo de IVA  =  Σ cuota DEDUCIBLE del libro registro de recibidas     (tolerancia 0)
I-E8-15b:  Σ cuota TOTAL del libro registro  =  Σ 472  +  Σ IVA no deducible incorporado al coste  (tolerancia 0)
I-E8-15c:  Σ 477 del periodo de IVA  =  Σ cuota repercutida del libro registro de emitidas     (tolerancia 0)
```

El art. 64 RIVA ya obliga a anotar base, cuota y **cuota deducible** por separado, así que las tres columnas existen. 15b es, además, el único control que detecta que una cuota no deducible se ha «perdido» en vez de haber engordado el coste.

### O-25 · RC-11 haría FAIL a toda factura de tercer país — MEDIA

RC-11 aplica el dígito de control (módulo 23 / letra de CIF) y hace **FAIL** si es inválido. Correcto para un NIF español. Un proveedor estadounidense, suizo o británico no tiene NIF español ni NIF-IVA comunitario: su identificador fiscal no tiene dígito de control verificable y el check lo rechazaría, bloqueando precisamente los documentos de `FACTURA_RECIBIDA_EXTRACOM` y `DUA_IMPORTACION` que la ronda 2 acaba de introducir.

**Corrección (tres ramas explícitas en RC-11).**

| Contraparte | Comprobación | Fallo |
|---|---|---|
| `countryCode = 'ES'` o sin país | Módulo 23 / letra de CIF | **FAIL** (art. 6.1.c RD 1619/2012) |
| UE (`countryCode ≠ ES`) | Formato de NIF-IVA del país + **VIES** | Formato inválido ⇒ FAIL; VIES negativo ⇒ WARN bloqueante (y bloquea RC-22, que ya lo exige) |
| Tercer país | Identificador **libre**, sin checksum | Nunca FAIL; confianza `interpretacion_ia`; WARN sólo si está vacío |

## R2.3 · Veredicto final

### **CONFORME CON OBSERVACIONES**

Las **seis observaciones bloqueantes y las siete de severidad ALTA de la ronda 1 están cerradas**, con la norma correctamente citada y aplicada: la cuota que se contabiliza es la de la factura, el libro registro vuelve a coincidir con el documento, el inmovilizado se clasifica desde el cierre y se reparte por bloques, la importación deja de autorrepercutirse, las rectificativas distinguen diferencias de sustitución, el IVA soportado se deduce en el periodo de recepción, la divisa original vive en la línea del diario y la calificación fiscal —cuenta, dimensiones, ISP, retención y régimen— sale del alcance del modelo de lenguaje. El diseño puede implementarse: **T9 (`postFromProposal`) queda desbloqueado**.

Quedan **tres observaciones menores** —**O-23** (devengo del IVA del anticipo al cobro), **O-24** (I-E8-15 reformulado en 15a/15b/15c) y **O-25** (RC-11 con tres ramas por país)— cuya corrección está escrita arriba al detalle y **no requiere una tercera ronda de validación**: son un check nuevo, una reformulación de invariante y una tabla de tres filas. Se implementan dentro de T7 y T14 y las verifica el `qa-tester` contra el fixture, sin volver a pasar por `experto-contable`.

**Condición de cierre de la épica:** que `docs/design/fixtures/extraccion-esperada.json` selle los trece casos comprometidos en §5.3 del diseño **más dos**, que son los que prueban O-23 y O-25: factura de anticipo de cliente **sin cobro registrado** (asiento sin 477) y factura de proveedor de tercer país con identificador fiscal sin checksum. Con esos quince casos reproducidos byte a byte, la épica es auditable de extremo a extremo.
