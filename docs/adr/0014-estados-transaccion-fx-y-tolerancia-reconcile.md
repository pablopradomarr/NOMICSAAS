# ADR-0014 — Mapeo contable de la propuesta documental: estados de `Transaction`, tipo de cambio y divisa en la línea, cuota del documento, IVA no deducible y la propuesta revisada como run nuevo

**Estado:** **APROBADO por Pablo (permiso delegado 2026-09-04) el 2026-09-06** · **Nivel:** 2 · **Fecha:** 2026-09-06 · **Ronda 2** (validación contable incorporada, más los tres residuos O-23…O-25 de la re-validación) · **Épica:** E8 · **Complementa:** ADR-0005 (el LLM solo propone; **no lo enmienda ni lo sustituye**) · **Precisa:** ADR-0003 (diario como fuente única), ADR-0006 (céntimos y `ExchangeRate`), ADR-0010/0011 (hashes y forma canónica), ADR-0012 (códigos de motivo del sello) · **Diseño:** `docs/design/E8-documentos-asientos.md` · **Validación contable:** `docs/design/E8-validacion-documentos.md` — ronda 1 **NO CONFORME** (22 observaciones, seis bloqueantes); re-validación **CONFORME CON OBSERVACIONES** (§R2.3), con tres residuos menores **O-23…O-25** ya incorporados como D13 y D14 y como matiz de D12

> **Ronda 2, aprobada.** La re-validación del `experto-contable` da **CONFORME CON OBSERVACIONES** y deja **desbloqueada** la implementación de `postFromProposal`. Los tres residuos menores que señala se incorporan aquí sin necesidad de una tercera ronda: **O-23** → **D13** (el IVA del anticipo de cliente devenga al cobro), **O-24** → **D14** (el puente al 303 se parte en tres invariantes) y **O-25** → tres ramas por país en RC-11 (**D11**). Condición de cierre de la épica: `docs/design/fixtures/extraccion-esperada.json` sellado con **quince** casos, los trece comprometidos más los dos que prueban O-23 y O-25.
>
> La ronda 1 de este ADR contenía **tres decisiones contablemente incorrectas** —D3 (residuo de cuota a 669/769 y cuota recalculada), D6 (523/173 por vencimiento a fecha de factura) y el `CHECK` mal formado de D1— además de dos silencios graves (fecha de recepción, divisa en la línea). Se reescriben D1, D2, D3 y D6, se añaden D8…D12 y se corrige la referencia al entregable de validación (O-22). Ninguna de las decisiones que el experto declaró correctas se toca: D4 (el LLM no fija la deducibilidad), D5 (la revisión es un run nuevo), D7 (`exchange_rates` global y append-only) y la puerta `FAIL ⇒ no hay asiento`.

## Contexto

ADR-0005 fijó la arquitectura de la extracción y sigue vigente sin un cambio: `ExtractionRun` inmutable, `reconcile()` determinista, confirmación humana con rol EDITOR, `File.cachedParseResult` eliminado, conversión de moneda en servidor con `ExchangeRate` persistido y prompts base en git con overrides versionados. El veredicto del experto lo confirma: *«el defecto no está en la capa de extracción: está en la capa de mapeo contable»*.

Lo que ADR-0005 no decide, y este ADR resuelve, es **qué asiento produce cada documento**: qué cuota se contabiliza, contra qué cuenta, con qué fecha fiscal, con qué retención y en qué estado queda la operación. Doce decisiones, todas de Nivel 2 porque cambian el esquema, la definición de un invariante o el importe de una cifra contable.

---

## D1 — `Transaction.status`: semántica cerrada, `CHECK` correcto y salida de `VOID`

*(Corrige el `CHECK` mal formado y el callejón sin salida detectados en O-9.)*

| Estado | Significado | Restricción |
|---|---|---|
| `DRAFT` | Operación/documento registrado, sin propuesta confirmada | `journal_entry_id IS NULL` |
| `PROPOSED` | Hay al menos un `ExtractionRun` con `reconcileStatus ∈ {PASS, WARN}` y una previsualización. **No es un estado contable**: no genera, reserva ni numera nada. Es indicativo de bandeja y así se declara en pantalla (O-9.iv) | `journal_entry_id IS NULL` |
| `POSTED` | Contabilizada | `journal_entry_id IS NOT NULL` |
| `VOID` | Su asiento fue anulado por contra-asiento | `journal_entry_id IS NULL` **y** `voided_entry_id IS NOT NULL` |

**`CHECK` correcto** (el de la ronda 1 dejaba pasar `VOID` con `journal_entry_id NULL` por precedencia de operadores):

```sql
CHECK (
  (status = 'DRAFT'    AND journal_entry_id IS NULL     AND voided_entry_id IS NULL) OR
  (status = 'PROPOSED' AND journal_entry_id IS NULL)                                 OR
  (status = 'POSTED'   AND journal_entry_id IS NOT NULL)                             OR
  (status = 'VOID'     AND journal_entry_id IS NULL     AND voided_entry_id IS NOT NULL)
)
```

**Anular y rehacer.** Al anular, `journal_entry_id` se **traslada** a la columna nueva `voided_entry_id` (nada se pierde: el asiento anulado y su contra-asiento siguen en el diario) y el estado pasa a `VOID`. La transición **`VOID → PROPOSED → POSTED`** queda **permitida**: es el flujo de corrección normal de un despacho, y sin ella la única salida sería volver a subir el fichero, que además chocaría con la detección de duplicados. `voided_entry_id` conserva el histórico completo cuando hay varias vueltas (`voided_entry_ids uuid[]`, append-only por trigger). Siguen **prohibidas** por trigger `POSTED → DRAFT` y `POSTED → PROPOSED`.

**Split.** `splitProposalAction` crea **N `Transaction`**, una por asiento, todas apuntando al mismo `File` y al mismo `sha256`, enlazadas por `split_parent_transaction_id`. `POSTED ⟺ journal_entry_id IS NOT NULL` sigue siendo defendible porque cada operación tiene exactamente un asiento, y la detección de duplicados no las cuenta entre sí (O-9.iii).

`status` **no entra en ningún informe** (ADR-0003). Su único uso es la bandeja y el check de calidad «documentos sin asiento».

---

## D2 — Tasa del `documentDate`, fuente única, **y divisa en la línea del diario**

*(Se mantiene la ronda 1 y se añade lo que O-8 exige.)*

- **Fecha de la tasa = `documentDate`** (NRV 11ª: tipo de contado de la fecha de la transacción), no la del guardado ni la del `entryDate`. Confirmar hoy o dentro de un mes da el mismo asiento.
- **Fuente única: Frankfurter (referencia diaria del BCE)**. Se retiran `xe.com` y `currency-api`. Otra fuente exige ADR.
- Si el BCE no publicó ese día, se usa **la última publicada anterior**, y `rateDate` ≠ `documentDate` queda **persistida y visible**.
- La tasa se **copia** al `Transaction` (`exchangeRateMicro`, `rateDate`, `rateSource`): un cambio retroactivo en la tabla no puede mover una cifra contabilizada.
- `convertedTotal` **no editable**: forzarlo exige motivo ≥ 10 caracteres, deja el campo en `no verificado`, escribe `AuditLog` y sella `TASA_FORZADA`.

**Novedad de la ronda 2 (O-8, opción (a)).** `JournalLine` gana **`originalCurrency`, `originalAmountCents` y `exchangeRateId`**, poblados en toda línea monetaria en divisa (43x, 40x, 41x, 523, 57x). Sin ellos, la valoración de las partidas monetarias al tipo de cierre que exige la **NRV 11ª.2.1** no sería computable desde el diario, y habría que reconstruirla desde el documento —exactamente lo que ADR-0003 prohíbe—. El motor que las consume (diferencias de cambio 668/768) es de **E9**; las columnas entran en **E8**, que es la épica que crea la deuda en divisa. La alternativa era prohibir la moneda extranjera en E8, que rompería la paridad funcional con TaxHacker.

Estas tres columnas **no son mutables** (sin `GRANT UPDATE`) y entran en una forma canónica **`hashVersion = 3`** de `entryHash`: `canonicalEntryFormV3 = v2 + originalCurrency + originalAmountCents + exchangeRateId`. Convivencia estricta, que es lo que `lib/ledger/hash.ts` prescribe: las filas existentes conservan `hashVersion = 2` y se verifican con v2; **los fixtures de E3–E6 no se tocan**. El `ledgerHash` **financiero** no cambia: el hecho económico en moneda base es el mismo, y así las cachés de `ReportRun` de E6 no se invalidan.

**Residuo de conversión: se elimina por construcción, no se contabiliza.** En el reconocimiento inicial no hay diferencia de cambio (NRV 11ª). El reparto es:

```
payable_EUR = convert(total_divisa)                   // lo que se debe, al céntimo
base_i_EUR  = convert(base_i_divisa)
cuota_t_EUR = payable_EUR − Σ base_i_EUR   repartido entre tipos por mayor resto (Hamilton, criterio de I5)
```

Cero residuo, cero línea de ajuste, y el drill-down sigue mostrando bases que corresponden a líneas del documento. Si alguna vez procediera reconocer un residuo de conversión, su cuenta sería **668/768**, jamás 669/769. La divergencia entre el tipo contable y el del **art. 79.Once LIVA** para la base imponible de una AIB o de una importación se declara como WARN informativo y **no se unifica**.

---

## D3 — La cuota que se contabiliza es **la del documento**; el recálculo sólo fija la confianza

*(Reescribe por completo la D3 de la ronda 1, que era incorrecta: O-2, bloqueante.)*

**Lo que la ronda 1 acertaba y se conserva:** que «tolerancia 0» literal es inaplicable, que un residuo no se ignora, y que la comparación es **por tipo impositivo** y no por documento (misma disciplina que C-7 de E3).

**Lo que se corrige, y son tres cosas distintas:**

**(i) El importe contabilizado es la cuota de la factura.** El IVA deducible es la cuota repercutida por el proveedor y consignada en la factura (arts. 92.Uno y 97.Uno LIVA); el libro registro de facturas recibidas (art. 64 RIVA) y las casillas del 303 se nutren del documento, no de nuestro recálculo. Anotar 210,00 € donde la factura dice 210,01 € produce un libro registro que **no coincide con la factura**. `cuota()` de `lib/ledger/tax.ts` pasa a ser **control de verosimilitud**, no fuente del importe.

**(ii) 669/769 es la cuenta equivocada.** 669 es epígrafe 15, *gastos financieros*: una diferencia de cuota de IVA no tiene naturaleza financiera y desplazaría gasto de explotación al resultado financiero, ensuciando el EBITDA del panel de E6. Si alguna vez procede reconocer un ajuste de imposición indirecta, las cuentas son **634 «Ajustes negativos en la imposición indirecta»** y **639 «Ajustes positivos»**, epígrafe 7.b) Tributos — las mismas que E3 reserva para la regularización de prorrata. **669/769 queda reservado en exclusiva al redondeo de tesorería** de T-08/T-09, que ya existe y no se toca; **668/768**, a las diferencias de cambio.

**(iii) Con la cuota del documento, el residuo no existe.** El asiento cuadra por construcción y no hace falta línea de ajuste alguna.

**Tabla de tolerancias que sustituye a la de la ronda 1:**

| Comprobación | Tolerancia | Qué se contabiliza | Efecto |
|---|---|---|---|
| `Σ lines[].baseCents = base` (suplidos y no sujetos excluidos, D10) | **0** | — | FAIL |
| **Identidad interna del documento**: `Σ bases + Σ cuotas + Σ recargos + Σ suplidos y no sujetos − retención − anticipo aplicado = total` | **0** | — | **FAIL**. Un documento que no cuadra consigo mismo incumple el art. 6 RD 1619/2012: se pide factura corregida, no se ajusta con un céntimo |
| `cuota_documento_t` vs `cuota(bases_t, rateBps, mode)`, **por tipo** | **1 céntimo, constante del motor, NO configurable** | **la cuota del documento** | WARN informativo; el campo queda `verificado` si coincide y `interpretacion_ia` si difiere dentro de tolerancia |
| Ídem, por encima de tolerancia | — | nada | **FAIL**: tipo mal leído o factura defectuosa |
| Residuo de conversión a moneda base | — | — | Eliminado por construcción (D2) |
| Residuo de **tesorería** (cobro/pago que no salda al céntimo) | `Organization.redondeoToleranciaCents`, default 1, **techo duro de 5 c en código** | **669/769** vía `ajusteRedondeo()` | Uso legítimo y preexistente en T-08/T-09. Intacto |

**Dos tolerancias separadas** (O-16), porque son dos riesgos distintos con dos destinatarios distintos: `TOLERANCIA_CUOTA_IVA_CENTS = 1` es una **constante del motor** —cambiarla exige un ADR nuevo, no una pantalla de ajustes— y `Organization.redondeoToleranciaCents` sigue siendo configurable pero con **techo duro de 5 céntimos** y `AuditLog`. La ronda 1 admitía que un ADMIN la subiera a 50, que es tanto como no tener tolerancia.

**Consecuencia sobre el motor de E3, y es Nivel 2:** las plantillas del bloque A (T-01…T-05) aceptan un `taxOverrides?: {taxRateCode, quotaCents}[]`. Con override presente, la plantilla **usa la cuota del documento** y `checkDraft` comprueba `|override − recalculada| ≤ 1 c` por tipo; sin override, el comportamiento es idéntico al de hoy, de modo que **los fixtures de E3 no cambian ni un byte**.

---

## D4 — La deducibilidad del IVA la fija la organización o el usuario; nunca el LLM

*(Se mantiene, con el matiz que O-17 exige.)*

- El schema de extracción **no tiene** campo de deducibilidad. El modelo no lo propone ni lo puede proponer.
- La cuota no deducible incrementa el precio de adquisición (art. 103 LIVA, NRV 2ª y 10ª), como ya hace el motor de E3.
- **Tercer valor de configuración por cuenta o categoría** (O-17): `deducibilidadPorDefecto ∈ {FULL, NONE, REQUIERE_DECISION}`. El default global sigue siendo `FULL`; `PRORRATA` cuando la organización la tenga configurada; y **`REQUIERE_DECISION`** se siembra en las categorías del art. 96 LIVA y del art. 95.Tres.2ª (hostelería, restauración, atenciones a clientes, espectáculos, combustible de turismos), donde el campo nace `no verificado` y **bloquea la confirmación por lote**. Sin esto, el camino silencioso —confirmar en lote sin mirar— deduce por defecto.
- Los gastos no deducibles por naturaleza **no se detectan automáticamente**: es criterio del usuario y así se declara en pantalla.
- **Tickets y facturas simplificadas: default `NONE`** (D9).

---

## D5 — La propuesta revisada por un humano es un `ExtractionRun` **nuevo**

*(Se mantiene íntegra; el experto la declara correcta.)*

Al editar y confirmar se inserta un `ExtractionRun` con `kind = MANUAL`, `parentRunId` = el run del LLM, `provider = "humano"`, la propuesta final, el `reconcile` recalculado y `fieldOrigins` campo a campo. `JournalEntry.extractionRunId` apunta a ese run. Ningún run se modifica jamás.

**Refuerzo de la ronda 2 (O-20.3):** **ningún asiento puede referenciar un run `partial` de `kind = LLM`**. Si el modelo vio 4 de 9 páginas, la propuesta no es incompleta: es potencialmente falsa, porque el total puede estar en la página 9. Para contabilizar un documento parcial, un humano teclea las cifras y la confirmación crea el run `MANUAL` con esos campos de origen `usuario`. Es comprobable en SQL.

---

## D6 — Inmovilizado: **siempre 523 en el alta**; la separación corriente/no corriente es un asiento de cierre

*(Reescribe la D6 de la ronda 1, que anclaba el criterio en la fecha de factura: O-3, bloqueante.)*

- `AccountKey.PROVEEDORES_INMOVILIZADO` → **523**, y **523 siempre en el alta**. La clasificación corriente / no corriente se mide **desde la fecha de cierre del ejercicio** (art. 35.1 CCom, NRV 9ª y normas de elaboración de las cuentas anuales), no desde la fecha del documento: una factura de noviembre de 2026 con vencimiento en noviembre de 2027 es **corriente** al cierre de 2026, y la ronda 1 la habría llevado a 173.
- La separación es un **asiento de reclasificación al cierre** (`523 → 173` por la parte con vencimiento > 12 meses desde el cierre, y `173 → 523` por la que se hace corriente), **por plazos** cuando el vencimiento está fraccionado. Pertenece a **E9** y queda anotada en `docs/ESTADO.md` con esa épica de cierre.
- **Documento mixto: el pasivo se reparte, no se etiqueta entero.** Cada bloque de líneas (inmovilizado / compras / servicios / empleado) genera su propia línea de pasivo por **su base más su cuota**. El céntimo huérfano del reparto se asigna al bloque de mayor importe (criterio Hamilton de I5).
- **Anotado para E9, sin épica hoy:** la compra de inmovilizado con pago aplazado a más de un año sin interés explícito se registra por su **valor actual**, con la diferencia como gasto financiero (NRV 2ª.1 y 9ª). Umbral parametrizable.

---

## D7 — `exchange_rates` es tabla de referencia **global** y los tres motivos de sello

*(Se mantiene.)* Sin `organizationId`, fuera de `TENANT_MODELS`, en un conjunto nuevo `GLOBAL_REFERENCE_MODELS`, con `ENABLE` + `FORCE`, `SELECT USING (true)`, `INSERT WITH CHECK (true)` y `RESTRICTIVE … USING (false)` en `UPDATE`/`DELETE`. Motivos de sello nuevos, códigos cerrados que se suman a los de ADR-0012: `PROPUESTA_NO_RECONCILIADA`, `DOCUMENTO_ALTERADO`, `TASA_FORZADA`, y —nuevos en la ronda 2— `RETENCION_NO_PRACTICADA`, `IVA_PERIODO_DESPLAZADO`, `REGIMEN_NO_SOPORTADO`.

---

## D8 — La **fecha de recepción** gobierna el periodo de IVA soportado

*(Nueva. O-6, bloqueante.)*

E3 define tres fechas; falta la cuarta. El art. 99.Tres LIVA permite deducir en el periodo en que se **soportan** las cuotas —esto es, en que se está en posesión de la factura— y el art. 64 RIVA obliga a anotar la factura recibida en el periodo en que se practica la deducción, consignando la fecha de recepción cuando difiere. Una factura de marzo recibida en mayo, deducida en el 1T, es una deducción prematura con sus recargos.

- `ExtractionProposal.receptionDate` y `JournalEntry.receptionDate`, origen **`usuario`** con default la fecha de subida del `File`. **Nunca del LLM.**
- **El periodo de IVA de un asiento no es su `entryDate`**: es `max(receptionDate, documentDate)` normalizado a periodo de liquidación. Lo consume T-23 en E9, y queda escrito aquí porque añadirlo después de tener asientos obligaría a reprocesar el libro registro entero.
- `operationDate` (fecha de devengo del IVA, art. 75 LIVA), opcional, default `documentDate`: es lo que el 303 y el SII piden cuando difiere de la expedición.
- **El tipo impositivo se selecciona por devengo, no por expedición** (art. 90.Dos LIVA, O-14): `selectRate(..., operationDate ?? accrualDate ?? documentDate, side)`. Afecta también a C-10 de E3, así que **no se cambia unilateralmente**: se aplica en la misma tarea a E3 y E8, y los fixtures no se ven afectados porque en ellos las tres fechas coinciden.
- Check **RC-18**: `documentDate` a más de cuatro años de la fecha de deducción ⇒ IVA **caducado** (art. 99.Cinco), deducibilidad forzada a `NONE` y la cuota como mayor coste; si además el ejercicio del documento está cerrado, desvío a T-22.

---

## D9 — Tickets y facturas simplificadas: contrapartida de tesorería, deducibilidad `NONE`, base derivada del total

*(Nueva. O-1, bloqueante — y es el camino más transitado del producto.)*

- **Contrapartida de tesorería** (`BANCO_DEFAULT`/`CAJA` según el medio de pago, campo del formulario, origen `usuario`), nunca `ACREEDORES`: el ticket se paga en el acto, y llevarlo a 410 crea una deuda que nunca se pagará, ensucia el aging comercial y falsea el periodo medio de pago (Ley 15/2010, Res. ICAC 29/01/2016).
- **Deducibilidad por defecto `NONE`** (art. 97.Uno LIVA): sólo la factura simplificada *cualificada* del art. 7.2 RD 1619/2012 —con NIF y domicilio del destinatario y cuota repercutida por separado— da derecho a deducir. El paso a `FULL` es un acto explícito del usuario que queda en `AuditLog`.
- Check **RC-17 (documento con IVA incluido)**: sin bases declaradas, el código deriva
  `base = round_half_up(total × 10000 / (10000 + rateBps))` y `cuota = total − base`.
  La cuota es **residual por construcción**, de modo que `base + cuota = total` con **tolerancia 0** y jamás hay línea de redondeo. Confianza: `base` y `cuota` = `calculado`; `total` = `interpretacion_ia`.

---

## D10 — Lo que el documento contiene y no es base imponible: suplidos, no sujetos y descuentos

*(Nueva. O-12 y O-15.)*

- `ProposalLine.kind ∈ {OPERACION, SUPLIDO, NO_SUJETO}`. Los suplidos (art. 78.Tres.3º LIVA: sumas pagadas en nombre y por cuenta del cliente, con mandato expreso y justificante a su nombre) **quedan fuera** de `Σ bases`, de la base de la cuota y de la base de la retención, y **dentro** del total. Sin esto, una factura de abogado con tasa judicial calcula la retención sobre una base inflada y falla la identidad interna siendo perfectamente correcta.
- `ProposalLine.discountCents`: el descuento en factura **minora la base** y no genera abono a 706/709 (R-IVA-8 de E3). El código lo resta antes de agrupar por tipo. `baseCents` sigue siendo `≥ 1` **en la línea del asiento** (C-2 lo exige), y el descuento vive en la propuesta, donde conserva el drill-down al concepto del documento.

---

## D11 — La calificación fiscal la decide la organización, no el documento

*(Nueva. Extiende a cuatro campos el mismo argumento con el que D4 sacó la deducibilidad del schema: O-4, O-10, O-11 y O-21.)*

| Campo | Quién lo decide | Por qué no el LLM |
|---|---|---|
| `accountCode`, `projectId`, `costCenterId` | `Category.defaultAccountCode` (origen `catalogo`) o el usuario | La cuenta decide el epígrafe de la PyG y el `analyticType`, y con él **MC1, MC2 y MC3**. Una misma factura de un freelance es **607** si su trabajo se factura al cliente y **623** si mantiene la web corporativa: la diferencia no está en el documento, está en el destino |
| Calificación **ISP / intracomunitaria / importación** | Precondiciones verificables (abajo) o el usuario | Autorrepercutir sobre una importación **inventa** una cuota devengada y una deducible sin soporte, y descuadra los libros y el 349 |
| **Retención de IRPF** | `Counterparty` (régimen: profesional 15 % / 7 %, arrendador 19 %, módulos 1 %) y la clave de cuenta derivada del `TaxRate` (4751 vía `IRPF_PROFESIONALES_A_PAGAR`, modelo 111, o `IRPF_ALQUILERES_A_PAGAR`, modelo 115) | La retención es **obligación del pagador** (arts. 99 y 101 LIRPF, art. 76 RIRPF): si el profesional no la consigna, la sociedad sigue obligada y responde de la deuda (art. 107 LIRPF) |
| **Régimen de IVA de la organización** | `Organization.ivaRegime ∈ {GENERAL, RECC, REDEME, OTRO}` | Con criterio de caja el devengo y la deducción siguen al cobro y al pago: todo el circuito de E8 sería incorrecto |

El modelo **sí** aporta la descripción, el nombre del proveedor y el texto de las menciones legales, con confianza `interpretacion_ia`; eso es lo que alimenta la sugerencia por reglas deterministas del catálogo.

**ISP sólo con las cuatro precondiciones**, todas verificables por código, y **nunca** inferido del silencio del documento: (1) contraparte con país ≠ ES y, si es UE, **NIF-IVA validado en VIES** con fecha y resultado persistidos; (2) el documento no consigna cuota repercutida; (3) el documento contiene la mención legal del art. 6.1.m RD 1619/2012, leída como texto y marcada `interpretacion_ia`; (4) `Organization.roiRegistered = true` para AIB y servicios intracomunitarios. Falta cualquiera ⇒ `DESCONOCIDO`, WARN y decide el usuario. **El tipo de la autorrepercusión es el español** que corresponda al bien o servicio, elegido por el usuario. **Importación ≠ ISP**: la factura del proveedor va sin IVA contra 400/523, la cuota la liquida el DUA y los aranceles son mayor coste (NRV 10ª y 2ª).

**Identificación fiscal por ramas: RC-11 (O-25).** El dígito de control no es universal, y una regla única habría bloqueado precisamente las importaciones que D11 acaba de introducir:

| Contraparte | Comprobación | Fallo |
|---|---|---|
| `countryCode = 'ES'` o sin país | Módulo 23 / letra de CIF | **FAIL** (art. 6.1.c RD 1619/2012: sin NIF válido no es deducible) |
| UE (`countryCode ≠ ES`) | Formato de NIF-IVA del país + **VIES** | Formato inválido ⇒ FAIL; VIES negativo ⇒ WARN bloqueante, que además bloquea RC-22 |
| Tercer país | Identificador **libre**, sin checksum | **Nunca FAIL**; confianza `interpretacion_ia`; WARN sólo si está vacío |

**Retención: RC-19.** Lo leído por el modelo se usa **sólo para contrastar**. Leído ≠ configurado, o configurado y ausente en el documento ⇒ **WARN bloqueante para el lote**, el asiento se construye con el **configurado**, y el mensaje dice «esta factura debería llevar retención del 15 %; solicite factura rectificada». El sello del periodo lleva `RETENCION_NO_PRACTICADA`.

**Régimen no soportado: RC-24.** Con `ivaRegime ≠ GENERAL`, la contabilización automática se **bloquea** con mensaje explícito y remisión a E9. Un producto que no dice qué no soporta es peor que uno que no lo soporta. El recargo de equivalencia como emisor ya está resuelto por `surchargeRateCode`, pero se aplica según el **régimen del cliente registrado en `Counterparty`**, no según lo que diga el documento.

---

## D12 — Rectificativas: documento rectificado, causa y **modo**

*(Nueva. O-5, bloqueante: hoy T-02 y T-05 son inconstruibles desde una propuesta.)*

```ts
rectifies?: {
  documentNumber: string   // obligatorio, art. 15.2 RD 1619/2012 — origen `llm`, confirmable
  entryId?: string         // resuelto por el código contra el diario — origen `calculado`
  reason: "DEVOLUCION" | "DESCUENTO_POSTERIOR" | "RAPPEL" | "ERROR"   // origen `usuario`
  mode:   "DIFERENCIAS" | "SUSTITUCION"                               // origen `usuario`
}
```

`reason` decide la **cuenta** (708 / 706 / 709 / la propia cuenta de ingreso). **`mode` decide el importe**: el art. 15.3 RD 1619/2012 admite las dos modalidades, y en *sustitución* el documento muestra los importes **nuevos completos**, de modo que lo que se contabiliza es la **diferencia** contra el documento rectificado. Contabilizar lo que se lee en una rectificativa por sustitución **duplica la operación**: sobre una factura de 100 000 rectificada a 80 000, el diseño de la ronda 1 dejaba el ingreso en 20 000 en lugar de en 80 000.

Dos reglas más: (a) un abono que llega con **total negativo** —como lo emite la mayoría de los programas— se normaliza a `ABONO_*` con valores absolutos, marcando `docKind` como `interpretacion_ia`; la regla de fondo de que en el diario no hay importes negativos se conserva; (b) la rectificativa de un **ejercicio cerrado** va a **T-22** (113 si es material, 678/778 si no), nunca a T-05, y figura en la tabla de plantillas como desvío por fecha, no como excepción implícita.

**Series (O-18).** `InvoiceSeries.kind ∈ {ORDINARIA, RECTIFICATIVA, SIMPLIFICADA}`: el art. 15.4 obliga a serie especial y numeración propia para las rectificativas. Numeración **sin huecos** y fecha no decreciente dentro de la serie, con invariante y listado en Auditoría. Una factura emitida **no se borra ni se renumera**: se rectifica.

---

## D13 — El IVA del anticipo de cliente devenga **al cobro**

*(Nueva. O-23, residuo de O-7.)*

D11 y la tabla de plantillas llevan `FACTURA_ANTICIPO_CLIENTE` a T-01 con **438** como contrapartida del ingreso, lo cual es correcto. Lo que faltaba es la fecha del devengo del impuesto: el art. 75.Dos LIVA es literal —en los pagos anticipados el IVA se devenga *«en el momento del cobro total o parcial del precio por los importes efectivamente percibidos»*—. Una factura de anticipo **expedida antes de cobrar no devenga IVA**, y emitir la línea de 477 con la fecha de la factura anticipa el ingreso a Hacienda y descuadra las casillas 01-03 del 303 del trimestre.

**Check RC-25.** `docKind = FACTURA_ANTICIPO_CLIENTE` exige `advanceEntryId` —el cobro ya registrado— o un `dueSchedule` con cobro efectivo. **Sin cobro ⇒ WARN bloqueante** y el asiento se construye `430` contra `438` **sin línea de 477**; el devengo llega con **T-08** al cobrar. Con cobro registrado, el asiento no cambia. En el caso normal —la factura de anticipo se expide *porque* se ha cobrado— no cambia nada, que es la señal de que la regla está bien puesta.

## D14 — El puente al 303 se parte en tres, porque la cuota no deducible no pasa por 472

*(Nueva. O-24, residuo de O-19.)*

El invariante único `Σ 472 = Σ cuotas soportadas del libro registro` con tolerancia 0 **falla sobre datos correctos** en cuanto hay IVA no deducible: esa cuota no pasa por 472, engorda la línea de gasto o de inmovilizado (art. 103 LIVA, NRV 2ª y 10ª), que es lo que `deducible()` ya hace. Con prorrata, con `deductibility = NONE` o con un solo ticket no cualificado —que tras **D9** es el **caso por defecto**—, el check sellaría `REQUIERE REVISIÓN` cada trimestre. Un invariante que falla siempre acaba desactivado, y con él se pierde el puente al 303.

```
I-E8-15a:  Σ 472 del periodo de IVA          = Σ cuota DEDUCIBLE del libro registro de recibidas   (tolerancia 0)
I-E8-15b:  Σ cuota TOTAL del libro registro  = Σ 472 + Σ IVA no deducible incorporado al coste      (tolerancia 0)
I-E8-15c:  Σ 477 del periodo de IVA          = Σ cuota repercutida del libro registro de emitidas   (tolerancia 0)
```

El art. 64 RIVA ya obliga a anotar base, cuota y **cuota deducible** por separado, así que las tres columnas existen y no hay dato nuevo que capturar. **15b** es, además, el único control que detecta que una cuota no deducible se ha «perdido» en lugar de haber engordado el coste.

## Alternativas descartadas

- **Contabilizar la cuota recalculada** (ronda 1). Produce un libro registro que no coincide con la factura: discrepancia formal que un requerimiento detecta y que en el SII sería un error de cuadre.
- **Llevar el residuo de cuota a 669/769.** Desplaza gasto de explotación a resultado financiero y ensucia el EBITDA. Si acaso, 634/639.
- **Tolerancia de cuota configurable.** Un auditor no acepta que la política de tolerancia sea un número que un ADMIN sube a 50. Constante del motor, y techo duro en la de tesorería.
- **Tolerancia por documento en lugar de por tipo.** Con tres tipos, N céntimos por documento tapan un tipo entero mal leído, y el 303 se desglosa **por tipo**.
- **523/173 por vencimiento a fecha de factura.** Mide desde la fecha equivocada; la norma mide desde el cierre. Y clasificar en el alta obliga a decidir hoy algo que depende de una fecha futura.
- **Etiquetar el documento mixto entero con una sola clave de pasivo.** Manda a 523 la parte de servicios y descoloca el cashflow entre explotación e inversión, que es la misma distorsión que E6 identificó en sentido contrario.
- **Inferir ISP del silencio del documento.** Es la vía directa a autorrepercutir importaciones.
- **Que el modelo proponga cuenta, proyecto o CECO.** Un modelo decidiendo entre 607 y 623 es un modelo decidiendo el margen de contribución de un proyecto.
- **Que el modelo proponga la retención.** La retención no es una característica del documento, es una obligación del pagador.
- **Diferir la divisa en la línea a E9.** E8 es la épica que crea la deuda en divisa; sin las columnas, la valoración al cierre no es computable desde el diario.
- **Prohibir la moneda extranjera en E8** (la otra opción de O-8). Rompería la paridad funcional con TaxHacker, que ya la soporta.
- **`VOID` como estado terminal.** Deja el flujo de corrección más común de un despacho sin salida.
- **Editar el `ExtractionRun` con la corrección del usuario.** Convierte la evidencia en un borrador mutable: exactamente lo que `cachedParseResult` era.
- **`PROPOSED` con asiento reservado o numerado.** La numeración sin huecos de E3 se apoya en que un número sólo se consume al insertar.
- **Repercutir el IVA al expedir la factura de anticipo.** Anticipa el ingreso a Hacienda y descuadra el 303 del trimestre (D13).
- **Un único puente al 303.** Falla sobre datos correctos en cuanto hay un ticket no cualificado, y un invariante que falla siempre se desactiva (D14).
- **Aplicar el dígito de control a toda contraparte.** Bloquearía toda factura de tercer país, que es exactamente el flujo que D11 acaba de habilitar.

## Consecuencias

- El libro registro de facturas recibidas coincide con las facturas al céntimo, y las casillas del 303 se desglosan por tipo tal como el modelo pide.
- Un documento en moneda extranjera produce siempre el mismo asiento, y su deuda es valorable al cierre **desde el diario**.
- Aparece una cuarta fecha (`receptionDate`) y una quinta opcional (`operationDate`): hay que explicarlas en la interfaz, porque cuatro fechas en un formulario son tres de más si no se dice para qué sirve cada una.
- El motor de E3 recibe tres cambios acotados —`taxOverrides`, `payableBlocks`, claves de tesorería y de empleado en `payableKey`— todos retrocompatibles y con los fixtures intactos.
- `entryHash` estrena `hashVersion = 3` con convivencia; `ledgerHash` no cambia y las cachés de informes de E6 no se invalidan.
- El default `NONE` en tickets hará que muchos usuarios vean «IVA no deducible» donde antes deducían. Es lo correcto, y hay que decirlo en pantalla con el porqué y el enlace al acto de marcar la factura como cualificada.
- El fixture de la épica pasa de trece a **quince** casos: la factura de anticipo sin cobro y la de proveedor de tercer país sin checksum son las que prueban D13 y la rama de RC-11.
- Deuda anotada en `docs/ESTADO.md` con épica de cierre: reclasificación 523→173 (**E9**), valor actual del aplazamiento largo (**E9**), RECC/REDEME (**E9**), diferencias de cambio 668/768 (**E9**), `selectRate` por devengo coordinado con C-10 de E3 (**E8/E3, misma tarea**).
